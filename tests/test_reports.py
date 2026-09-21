import io
import json
import unittest
import zipfile
from gsb.reports import playwright, junit, parse_report_zip, artifact_layer
from gsb.project import channel, run_details, slim_run, build_project
from gsb.config import Config


def archive(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, value in files.items(): z.writestr(name, value)
    return buf.getvalue()


class ReportsTests(unittest.TestCase):
    def test_playwright_retries_are_not_extra_cases(self):
        doc = {'suites': [{'specs': [{'title': 'journey', 'tests': [
            {'status': 'flaky', 'results': [{'status': 'failed'}, {'status': 'passed'}]},
            {'status': 'expected', 'results': [{'status': 'failed'}]},
            {'status': 'skipped'}, {'status': 'unexpected'}]}]}]}
        parsed = playwright(doc)
        self.assertEqual([parsed[k] for k in ('tests','passed','failed','skipped','flaky')], [4,1,1,1,1])

    def test_nested_junit_only_counts_leaves(self):
        result = junit('<testsuites tests="5"><testsuite tests="5"><testsuite tests="3" failures="1"/><testsuite tests="2" skipped="1"/></testsuite></testsuites>')
        self.assertEqual([result[k] for k in ('tests','passed','failed','skipped')], [5,3,1,1])

    def test_testcases_take_precedence_over_aggregate(self):
        result = junit('<testsuite tests="100"><testcase name="a"/><testcase name="b"><failure/></testcase></testsuite>')
        self.assertEqual(result['tests'], 2)
        self.assertEqual(result['failed'], 1)

    def test_report_formats_not_double_counted(self):
        parsed = parse_report_zip(archive({'report.xml':'<testsuite tests="9"/>', 'test-results/results.json':json.dumps({'suites': [], 'stats': {'expected':3,'unexpected':1,'skipped':1,'flaky':1}})}))
        self.assertEqual((parsed['tests'], parsed['format']), (6,'playwright'))

    def test_invalid_counts_are_missing(self):
        self.assertIsNone(parse_report_zip(archive({'dashboard-summary.json':json.dumps({'tests':3,'passed':4,'failed':0,'skipped':0,'flaky':0})})))
        self.assertIsNone(parse_report_zip(archive({'trace.zip':'not a test summary'})))

    def test_archive_limit(self):
        with self.assertRaises(ValueError): parse_report_zip(archive({f'{i}.txt':'x' for i in range(3001)}))

    def test_layer_and_channel(self):
        self.assertEqual([artifact_layer(n) for n in ('e2e-results','st-results','ut-results','other')], ['e2e','st','unit','other'])
        self.assertEqual(channel({'name':'CI','event':'schedule'}, {'gate':['CI']}), 'daily')
        self.assertEqual(channel({'name':'CI','event':'release'}, {'gate':['CI']}), 'release')

    def test_previous_attempt_and_different_sha_are_excluded(self):
        class GH:
            def paginate(self, path, **kw):
                if path.endswith('/jobs'): return []
                return [dict(id=i, name='e2e-results', created_at=date, workflow_run={'head_sha':sha}) for i,date,sha in ((1,'2026-01-01','abc'),(2,'2026-01-03','old'),(3,'2026-01-03','abc'))]
            def download_artifact(self, repo, ident, **kw):
                assert ident == 3
                return archive({'report.xml':'<testsuite tests="2"/>'})
        run = slim_run({'id':1,'run_attempt':2,'run_started_at':'2026-01-02','head_sha':'abc','html_url':'https://github.com/example/repo/actions/runs/1'}, {})
        run_details(GH(), Config(repo='example/repo'), run)
        self.assertEqual([t['artifact_id'] for t in run['tests']], [3])
        self.assertEqual(run['tests'][0]['counts']['tests'], 2)

    def test_corrupt_report_does_not_break_snapshot(self):
        class GH:
            def paginate(self,path,**kw):
                return [] if path.endswith('/jobs') else [{'id':1,'name':'e2e-results'}]
            def download_artifact(self,*args,**kw): return b'broken zip'
        run = slim_run({'id':1,'html_url':'https://github.com/example/repo/actions/runs/1'}, {})
        run_details(GH(), Config(repo='example/repo'), run)
        self.assertEqual(run['reports_status'], 'partial')
        self.assertIsNone(run['tests'][0]['counts'])

    def test_private_source_cannot_be_published(self):
        class GH:
            def get(self,*a): return {'private':True}
        with self.assertRaises(ValueError): build_project(GH(), 'example/private')
