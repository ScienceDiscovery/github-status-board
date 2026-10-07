import io
import json
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from gsb import e2e_records
from gsb.e2e_records import attach, playwright_cases, read_artifact, refresh, retention_days, window_runs
from gsb.github import GitHubError
from gsb.history import encode
from gsb.reports import playwright

NOW = datetime(2026, 9, 30, 12, tzinfo=timezone.utc)
REPO = 'openJiuwen-ai/sciencediscovery'
BOARD = 'ScienceDiscovery/github-status-board'


def stamp(delta):
    return (NOW + delta).isoformat().replace('+00:00', 'Z')


def archive(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, value in files.items():
            z.writestr(name, value)
    return buf.getvalue()


# A failed journey with nested steps, a retried pass, a skip and a plain pass.
REPORT = {'suites': [{'title': 'journey.spec.ts', 'file': 'journey.spec.ts', 'specs': [
    {'title': 'J1 creates a project', 'file': 'journey.spec.ts', 'line': 12, 'tests': [{'projectName': 'mocked', 'status': 'unexpected', 'results': [
        {'status': 'failed', 'duration': 5400, 'errors': [{'message': '\x1b[31mError: expect(locator).toBeVisible() failed\x1b[39m\n\nLocator: getByText(\'Saved\')\n    at /work/journey.spec.ts:30:5'}],
         'steps': [
             {'title': '1. open the console', 'duration': 1200, 'steps': [{'title': 'page.goto', 'duration': 900}, {'title': 'wait for the header', 'duration': 250}]},
             {'title': '2. save the project', 'duration': 4100, 'error': {'message': 'Error: expect(locator).toBeVisible() failed'},
              'steps': [{'title': 'click Save', 'duration': 60}, {'title': 'expect Saved', 'duration': 4000, 'error': {'message': 'Timed out 4000ms waiting for Saved'}}]},
         ]}]}]},
    {'title': 'J2 resumes a session', 'file': 'journey.spec.ts', 'line': 40, 'tests': [{'projectName': 'mocked', 'status': 'flaky', 'results': [
        {'status': 'failed', 'duration': 300, 'errors': [{'message': 'Error: socket hang up'}], 'steps': [{'title': 'reconnect', 'duration': 300}]},
        {'status': 'passed', 'duration': 250, 'steps': [{'title': 'reconnect', 'duration': 250}]}]}]},
    {'title': 'J3 exports', 'file': 'journey.spec.ts', 'line': 60, 'tests': [{'projectName': 'mocked', 'status': 'skipped', 'results': [{'status': 'skipped'}]}]},
    {'title': 'J4 settings', 'file': 'journey.spec.ts', 'line': 80, 'tests': [{'projectName': 'mocked', 'status': 'expected', 'results': [{'status': 'passed', 'duration': 90}]}]},
]}]}


def e2e_zip(report_bytes=b'<html>report</html>'):
    return archive({'mocked-standard/e2e/test-results/results.json': json.dumps(REPORT),
                    'mocked-standard/e2e/playwright-report/index.html': report_bytes,
                    'mocked-standard/e2e/playwright-report/data/shot.png': b'png',
                    'mocked-standard/e2e/playwright-report/../escape.html': b'no',
                    'e2e/tagged/playwright-mocked-standard-results.json': json.dumps({'results': [], 'errors': []})})


def snapshot(*run_ids):
    cells = [[{'id': run_id, 'branch': 'main', 'event': 'push', 'title': f'CI {run_id}', 'url': f'https://github.com/{REPO}/actions/runs/{run_id}'}] for run_id in run_ids]
    return {'sections': {'ci': {'data': {'lanes': {'lanes': [{'key': 'main', 'days': cells}]}}}}, 'line_sections': {}, 'quality': {'runs': []}}


def artifact(ident, run_id, *, expires=timedelta(days=10), expired=False, fork=False, created=None, size=1000):
    return {'id': ident, 'name': 'e2e-results', 'size_in_bytes': size, 'expired': expired, 'expires_at': stamp(expires),
            'created_at': created or stamp(timedelta(minutes=ident)),
            'workflow_run': {'id': run_id, 'repository_id': 7, 'head_repository_id': 8 if fork else 7, 'head_branch': 'main', 'head_sha': 'a' * 40}}


class Source:
    """Source repository: one artifact listing, counted downloads."""

    def __init__(self, artifacts, blobs=None, fail=None):
        self.artifacts, self.blobs, self.fail = artifacts, blobs or {}, fail
        self.gets, self.downloads = [], []

    def get(self, path, params=None):
        self.gets.append((path, dict(params or {})))
        if self.fail:
            raise self.fail
        return {'total_count': 500, 'artifacts': self.artifacts}

    def download_artifact(self, repo, ident, *, max_bytes):
        self.downloads.append(ident)
        blob = self.blobs.get(ident, e2e_zip())
        if isinstance(blob, Exception):
            raise blob
        return blob


def checkout(root, result):
    """Apply one collection's files the way the publisher commits them."""
    for path, content in result.files.items():
        target = Path(root) / path
        if content is None:
            target.unlink()
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)


class StepParsingTests(unittest.TestCase):
    def test_failed_case_keeps_ordered_nested_steps_and_error_summary(self):
        cases = {c['title']: c for c in playwright_cases(REPORT)}
        failed = cases['J1 creates a project']
        self.assertEqual((failed['status'], failed['file'], failed['line'], failed['project'], failed['duration_ms']), ('failed', 'journey.spec.ts', 12, 'mocked', 5400))
        # Colours and stack frames are dropped; the assertion and locator remain.
        self.assertEqual(failed['error'], "Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('Saved')")
        self.assertEqual([s['title'] for s in failed['steps']], ['1. open the console', '2. save the project'])
        self.assertEqual([s['title'] for s in failed['steps'][0]['steps']], ['page.goto', 'wait for the header'])
        self.assertEqual([s['status'] for s in failed['steps']], ['passed', 'failed'])
        inner = failed['steps'][1]['steps']
        self.assertEqual([(s['title'], s['status'], s['duration_ms']) for s in inner], [('click Save', 'passed', 60), ('expect Saved', 'failed', 4000)])
        self.assertEqual(inner[1]['error'], 'Timed out 4000ms waiting for Saved')

    def test_retried_pass_keeps_its_earlier_failure_and_counts_do_not_regress(self):
        cases = {c['title']: c for c in playwright_cases(REPORT)}
        flaky = cases['J2 resumes a session']
        self.assertEqual((flaky['status'], flaky['attempts'], flaky['error']), ('flaky', 2, 'Error: socket hang up'))
        self.assertEqual([s['title'] for s in flaky['steps']], ['reconnect'])  # the final attempt's steps
        self.assertNotIn('error', cases['J4 settings'])
        slices, _ = read_artifact(e2e_zip())
        counts = playwright(REPORT)
        self.assertEqual(slices[0]['totals'], {k: counts[k] for k in ('tests', 'passed', 'failed', 'skipped', 'flaky')})
        self.assertEqual(slices[0]['totals'], {'tests': 4, 'passed': 1, 'failed': 1, 'skipped': 1, 'flaky': 1})

    def test_report_files_stay_inside_their_slice_and_budget(self):
        slices, files = read_artifact(e2e_zip())
        self.assertEqual([s['slice'] for s in slices], ['mocked-standard'])  # the tagged copy is not a report
        self.assertEqual(sorted(files['mocked-standard']), ['data/shot.png', 'index.html'])
        _, untrusted = read_artifact(e2e_zip(), html=False)
        self.assertEqual(untrusted, {})
        with patch.object(e2e_records, 'REPORT_BYTES', 10):
            slices, files = read_artifact(e2e_zip())
        # Over the HTML budget, the steps are still there.
        self.assertEqual((files, slices[0]['report']['reason'], len(slices[0]['cases'])), ({}, 'over_budget', 4))


class ReplacementTests(unittest.TestCase):
    def test_old_ready_records_are_downloaded_again_newest_first_with_the_same_limit(self):
        with tempfile.TemporaryDirectory() as root:
            listing = [artifact(100 + i, 900 + i) for i in range(3)]
            with patch.object(e2e_records, 'VERSION', 1):
                previous = refresh(Source(listing), REPO, root, snapshot(900, 901, 902), NOW, bundle=41, downloads=3)
            checkout(root, previous)
            source = Source(listing)
            result = refresh(source, REPO, root, snapshot(900, 901, 902), NOW, bundle=42)
            self.assertEqual(source.gets, [(f'/repos/{REPO}/actions/artifacts', {'name': 'e2e-results', 'per_page': 100})])
            self.assertEqual(source.downloads, [102, 101])
            records = json.loads(result.files[e2e_records.INDEX])['records']
            self.assertEqual([(r['artifact_id'], r['status'], r['version'], r['bundle']) for r in records],
                             [(102, 'ready', 2, 42), (101, 'ready', 2, 42), (100, 'pending', 2, None)])
            checkout(root, result)
            source = Source(listing)
            refresh(source, REPO, root, snapshot(900, 901, 902), NOW, bundle=43)
            self.assertEqual(source.downloads, [100])  # updated ready records are reused

    def test_one_listing_without_cursor_and_bounded_downloads(self):
        with tempfile.TemporaryDirectory() as root:
            source = Source([artifact(100 + i, 900 + i) for i in range(5)] + [artifact(200, 999)])  # run 999 is not on the board
            first = refresh(source, REPO, root, snapshot(*range(900, 905)), NOW, bundle=42)
            # A single page of the newest artifacts; no page number, no stored position.
            self.assertEqual(source.gets, [(f'/repos/{REPO}/actions/artifacts', {'name': 'e2e-results', 'per_page': 100})])
            self.assertEqual(source.downloads, [104, 103])
            self.assertTrue(all(path.startswith('site/data/e2e/') for path in first.files))
            index = json.loads(first.files[e2e_records.INDEX])
            self.assertEqual([(r['artifact_id'], r['status']) for r in index['records']],
                             [(104, 'ready'), (103, 'ready'), (102, 'pending'), (101, 'pending'), (100, 'pending')])
            self.assertNotIn('cursor', json.dumps(index))
            ready = index['records'][0]
            self.assertEqual((ready['bundle'], ready['reports'][0]['html'], ready['totals']['failed']), (42, 'e2e/104/mocked-standard/index.html', 1))
            self.assertEqual(sorted(first.html), [(103, 'mocked-standard'), (104, 'mocked-standard')])
            checkout(root, first)
            # The next collection lists again and downloads only what is still missing.
            source = Source(source.artifacts)
            second = refresh(source, REPO, root, snapshot(*range(900, 905)), NOW, bundle=43)
            self.assertEqual((len(source.gets), source.downloads), (1, [102, 101]))
            bundles = {r['artifact_id']: r['bundle'] for r in json.loads(second.files[e2e_records.INDEX])['records']}
            self.assertEqual(bundles, {104: 42, 103: 42, 102: 43, 101: 43, 100: None})

    def test_expired_artifacts_leave_the_record_set_and_the_site(self):
        with tempfile.TemporaryDirectory() as root:
            listing = [artifact(101, 901), artifact(102, 902)]
            checkout(root, refresh(Source(listing), REPO, root, snapshot(901, 902), NOW, bundle=42))
            self.assertTrue((Path(root) / 'site/data/e2e/101.json').exists())
            # GitHub marks 101 expired: its steps file is deleted and its HTML no longer listed.
            later = refresh(Source([artifact(101, 901, expired=True, expires=timedelta(0)), listing[1]]), REPO, root, snapshot(901, 902), NOW)
            self.assertIsNone(later.files['site/data/e2e/101.json'])
            self.assertEqual([r['artifact_id'] for r in json.loads(later.files[e2e_records.INDEX])['records']], [102])
            checkout(root, later)
            self.assertEqual(sorted(p.name for p in (Path(root) / 'site/data/e2e').iterdir()), ['102.json', 'index.json'])

    def test_limits_and_failures_degrade_instead_of_failing(self):
        with tempfile.TemporaryDirectory() as root:
            listing = [artifact(101, 901), artifact(102, 902, fork=True), artifact(103, 903, size=10 ** 9), artifact(104, 904)]
            source = Source(listing, blobs={104: GitHubError('rate limited', kind='rate_limited', status=403)})
            result = refresh(source, REPO, root, snapshot(901, 902, 903, 904), NOW, downloads=3)
            records = {r['artifact_id']: r for r in json.loads(result.files[e2e_records.INDEX])['records']}
            self.assertEqual({k: r['status'] for k, r in records.items()}, {101: 'ready', 102: 'ready', 103: 'too_large', 104: 'pending'})
            # A fork's report shows its steps but links its HTML to GitHub.
            self.assertEqual((records[102]['reports'][0]['html'], records[102]['reports'][0]['reason'], records[102]['bundle']), (None, 'untrusted', None))
            self.assertEqual(records[103]['artifact_url'], f'https://github.com/{REPO}/actions/runs/903/artifacts/103')
            checkout(root, result)
            # Without a listing, stored expiry still retires records; nothing is downloaded.
            offline = Source([], fail=GitHubError('down', kind='network'))
            result = refresh(offline, REPO, root, snapshot(901, 902, 903, 904), NOW + timedelta(days=11))
            self.assertEqual((json.loads(result.files[e2e_records.INDEX])['records'], offline.downloads), ([], []))
            self.assertIsNone(result.files['site/data/e2e/101.json'])

    def test_board_window_comes_from_lanes_lines_and_recent_runs(self):
        doc = snapshot(1, 2)
        doc['line_sections'] = {'release': {'ci': snapshot(3)['sections']['ci']}}
        doc['quality']['runs'] = [{'id': 4, 'branch': 'main'}]
        self.assertEqual(sorted(window_runs(doc)), [1, 2, 3, 4])

    def test_bundle_lives_until_its_last_source_artifact_expires(self):
        with tempfile.TemporaryDirectory() as root:
            result = refresh(Source([artifact(101, 901, expires=timedelta(days=13, hours=4)), artifact(102, 902, expires=timedelta(days=2))]),
                             REPO, root, snapshot(901, 902), NOW, bundle=42)
            result.write_bundle(Path(root) / 'bundle')
            self.assertTrue((Path(root) / 'bundle/101/mocked-standard/index.html').exists())
            self.assertEqual(retention_days(Path(root) / 'bundle', NOW), 15)
            self.assertIsNone(retention_days(Path(root) / 'missing', NOW))


class Board:
    """Board repository seen by the Pages job."""

    def __init__(self, bundles, runs=None, uploads_after=0):
        self.bundles, self.runs, self.uploads_after = bundles, runs or {}, uploads_after
        self.polls = 0

    def get(self, path, params=None):
        run_id = int(path.split('/runs/')[1].split('/')[0])
        if path.endswith('/artifacts'):
            self.polls += 1
            ready = run_id in self.bundles and self.polls > self.uploads_after
            return {'artifacts': [{'id': run_id * 10, 'name': 'e2e-html', 'expired': False}] if ready else []}
        return {'path': '.github/workflows/collect.yml', 'head_branch': 'main', 'status': 'completed', **self.runs.get(run_id, {})}

    def download_artifact(self, repo, ident, *, max_bytes):
        return self.bundles[ident // 10]


class AttachTests(unittest.TestCase):
    def test_report_screenshots_keep_their_names_through_collection_and_pages(self):
        screenshots = ['01-跑一个后台任务并等它完成.png', '02-查看 任务(完成).png',
                       '03-查看结果（截图）.png', '.hidden.png', 'x' * 124 + '.png']
        journey = 'data/40072e79cd3d0cda7a79c6bad7501851b4babf54.html'
        html = ''.join(f'<img src="{name}">' for name in screenshots).encode('utf-8')
        safe = {'index.html': b'<a href="' + journey.encode() + b'">journey</a>', journey: html,
                **{'data/' + name: b'png' for name in screenshots}}
        unsafe = ['../secret.png', 'data/../secret.png', './dot.png', 'data//empty.png', '/absolute.png',
                  'data/back\\slash.png', 'data/tab\t.png', 'data/control\x1f.png', 'data/delete\x7f.png',
                  'data/c1\x85.png', 'data/nullXtail.png', 'data/' + 'x' * 125 + '.png']
        prefix = 'mocked-standard/e2e/playwright-report/'
        source_zip = archive({'mocked-standard/e2e/test-results/results.json': json.dumps(REPORT),
                              **{prefix + rel: data for rel, data in safe.items()},
                              **{prefix + rel: b'rejected' for rel in unsafe},
                              '/absolute/playwright-report/root.png': b'rejected',
                              'C:/absolute/playwright-report/drive.png': b'rejected',
                              '../playwright-report/outside.png': b'rejected'})
        # Patch both ZIP headers: writestr itself truncates a name containing NUL.
        source_zip = source_zip.replace(b'nullXtail.png', b'null\x00tail.png')
        with tempfile.TemporaryDirectory() as root:
            result = refresh(Source([artifact(101, 901)], blobs={101: source_zip}), REPO, root, snapshot(901), NOW, bundle=42)
            self.assertEqual(result.html, {(101, 'mocked-standard'): safe})
            bundle_dir = Path(root) / 'bundle'
            result.write_bundle(bundle_dir)
            bundle_files = {p.relative_to(bundle_dir).as_posix(): p.read_bytes() for p in bundle_dir.rglob('*') if p.is_file()}
            # A bundle must reject unsafe paths independently of source collection.
            bundle_files.update({'101/mocked-standard/' + rel: b'rejected' for rel in unsafe})
            checkout(root, result)
            site = Path(root) / 'site'
            bundle_zip = archive(bundle_files).replace(b'nullXtail.png', b'null\x00tail.png')
            attached = attach(Board({42: bundle_zip}), BOARD, site, NOW, sleep=lambda s: None)
            self.assertEqual((attached['attached'], attached['errors']), (1, []))
            published = {p.relative_to(site / 'e2e').as_posix(): p.read_bytes() for p in (site / 'e2e').rglob('*') if p.is_file()}
            self.assertEqual(published, {'101/mocked-standard/' + rel: data for rel, data in safe.items()})
            self.assertFalse((site / 'e2e/101/secret.png').exists())

    def site(self, root, records):
        site = Path(root) / 'site'
        (site / 'data/e2e').mkdir(parents=True)
        (site / 'data/e2e/index.json').write_text(encode({'version': 1, 'records': records}))
        for r in records:
            (site / r['steps']).write_text('{}')
        return site

    def record(self, ident, bundle, expires):
        return {'artifact_id': ident, 'bundle': bundle, 'expires_at': stamp(expires), 'steps': f'data/e2e/{ident}.json',
                'reports': [{'slice': 'mocked-standard', 'html': f'e2e/{ident}/mocked-standard/index.html'}]}

    def test_only_unexpired_reports_are_attached(self):
        with tempfile.TemporaryDirectory() as root:
            site = self.site(root, [self.record(101, 42, timedelta(days=3)), self.record(102, 42, timedelta(hours=-1))])
            bundle = archive({'101/mocked-standard/index.html': 'live', '101/mocked-standard/data/a.png': 'png',
                              '102/mocked-standard/index.html': 'expired', '101/other/index.html': 'not listed', 'bundle.json': '{}'})
            result = attach(Board({42: bundle}), BOARD, site, NOW, sleep=lambda s: None)
            self.assertEqual(result['attached'], 1)
            self.assertEqual((site / 'e2e/101/mocked-standard/index.html').read_text(), 'live')
            self.assertTrue((site / 'e2e/101/mocked-standard/data/a.png').exists())
            self.assertFalse((site / 'e2e/102').exists())
            self.assertFalse((site / 'e2e/101/other').exists())
            self.assertFalse((site / 'data/e2e/102.json').exists())
            deployed = json.loads((site / 'data/e2e/index.json').read_text())['records']
            self.assertEqual([(r['artifact_id'], r['reports'][0]['html']) for r in deployed], [(101, 'e2e/101/mocked-standard/index.html')])

    def test_missing_or_foreign_bundles_fall_back_to_github(self):
        with tempfile.TemporaryDirectory() as root:
            site = self.site(root, [self.record(101, 42, timedelta(days=3)), self.record(103, 44, timedelta(days=3))])
            board = Board({44: archive({'103/mocked-standard/index.html': 'x'})}, runs={44: {'path': '.github/workflows/checks.yml'}})
            result = attach(board, BOARD, site, NOW, sleep=lambda s: None)
            deployed = json.loads((site / 'data/e2e/index.json').read_text())['records']
            self.assertEqual([(r['reports'][0]['html'], r['reports'][0]['reason']) for r in deployed], [(None, 'unavailable')] * 2)
            self.assertEqual((result['attached'], result['errors']), (0, ['ValueError']))
            self.assertFalse((site / 'e2e').exists())

    def test_waits_while_the_collection_is_still_uploading(self):
        with tempfile.TemporaryDirectory() as root:
            site = self.site(root, [self.record(101, 42, timedelta(days=3))])
            board = Board({42: archive({'101/mocked-standard/index.html': 'late'})}, runs={42: {'status': 'in_progress'}}, uploads_after=2)
            naps = []
            attach(board, BOARD, site, NOW, sleep=naps.append)
            self.assertEqual((naps, (site / 'e2e/101/mocked-standard/index.html').read_text()), ([10, 10], 'late'))


class CollectionIsolationTests(unittest.TestCase):
    def test_a_broken_record_stage_does_not_fail_the_collection(self):
        import publish

        class Sync:
            gh, repo, now = Source([]), REPO, NOW
            cfg = type('Cfg', (), {'artifact_max_bytes': 1})()
        with patch.object(e2e_records, 'refresh', side_effect=RuntimeError('unexpected')), patch('sys.stderr', io.StringIO()) as err:
            self.assertIsNone(publish.e2e_run_records(Sync(), {}))
        self.assertIn('RuntimeError', err.getvalue())


class BudgetMemoTests(unittest.TestCase):
    def test_records_reuse_the_details_download(self):
        from gsb.sync import Budget

        class GH:
            token, calls = 't', 0

            def download_artifact(self, repo, ident, **kw):
                GH.calls += 1
                return b'zip'
        budget = Budget(GH())
        budget.download_artifact(REPO, 1, max_bytes=10)
        budget.download_artifact(REPO, 1, max_bytes=10)
        self.assertEqual((GH.calls, budget.left), (1, 179))


if __name__ == '__main__':
    unittest.main()
