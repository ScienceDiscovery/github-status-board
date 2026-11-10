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

    def test_generic_summary_table_preserves_declared_order_and_final_strings(self):
        table = {'title': 'case execution', 'columns': [{'key': 'result', 'label': 'Outcome'}, {'key': 'task', 'label': 'Task'}],
                 'rows': [{'task': 'item-b', 'result': '34.2K', 'answer': 'PRIVATE'}, {'task': 'item-a', 'result': 'n/a'}], 'trace': 'PRIVATE'}
        doc = dict(tests=2, passed=1, failed=1, skipped=0, flaky=0, table=table, error='PRIVATE')
        parsed = parse_report_zip(archive({'nested/dashboard-summary.json': json.dumps(doc), 'junit.xml': '<testsuite tests="99"/>'}))
        self.assertEqual((parsed['tests'], parsed['format']), (2, 'summary'))
        self.assertEqual(parsed['table']['columns'], table['columns'])
        self.assertEqual(parsed['table']['rows'], [{'result': '34.2K', 'task': 'item-b'}, {'result': 'n/a', 'task': 'item-a'}])
        self.assertNotIn('PRIVATE', json.dumps(parsed))

    def test_missing_or_malformed_optional_table_keeps_legacy_summary_counts(self):
        counts = dict(tests=1, passed=1, failed=0, skipped=0, flaky=0)
        for table in [None, {}, {'title': 'bad', 'columns': [], 'rows': []},
                      {'title': 'bad', 'columns': [{'key': 'x', 'label': 'X'}], 'rows': [{'x': {'answer': 'PRIVATE'}}]},
                      {'title': 'bad', 'columns': [{'key': 'x', 'label': 'X'}, {'key': 'x', 'label': 'Again'}], 'rows': []}]:
            with self.subTest(table=table):
                parsed = parse_report_zip(archive({'dashboard-summary.json': json.dumps(dict(counts, table=table))}))
                self.assertEqual({key: parsed[key] for key in counts}, counts)
                self.assertNotIn('table', parsed)
                self.assertEqual(parsed['cases'], [])

    def test_summary_table_group_is_optional_public_producer_metadata(self):
        table = dict(title='Probes', columns=[dict(key='probe', label='Probe')], rows=[dict(probe='a')],
                     group=dict(key='smoke', label='L3 · smoke', secret='PRIVATE'))
        counts = dict(tests=1, passed=1, failed=0, skipped=0, flaky=0)
        parsed = parse_report_zip(archive({'dashboard-summary.json': json.dumps(dict(counts, table=table))}))
        self.assertEqual(parsed['table']['group'], dict(key='smoke', label='L3 · smoke'))
        self.assertNotIn('PRIVATE', json.dumps(parsed))
        for group in [None, [], {}, dict(key='', label=''), dict(key='x', label={'answer': 'PRIVATE'})]:
            with self.subTest(group=group):
                table['group'] = group
                parsed = parse_report_zip(archive({'dashboard-summary.json': json.dumps(dict(counts, table=table))}))
                self.assertEqual(parsed['tests'], 1)
                self.assertEqual(parsed['table']['rows'], [dict(probe='a')])
                self.assertNotIn('group', parsed['table'])

    def test_table_groups_survive_newer_same_name_counts_only_reports_and_reruns(self):
        from gsb.reports import summary_tables
        from gsb.public_sections import public_tests
        from gsb.collectors import Context
        from datetime import datetime, timezone
        from unittest.mock import patch
        def run(ident, group=None, count=1, attempt=1):
            report = dict(name='service-test-results', artifact_id=ident * 10 + attempt, layer='e2e', status='available',
                          url=f'https://example.com/runs/{ident}/artifacts/{attempt}', cases=[],
                          counts=dict(tests=count, passed=count - 1, failed=1, skipped=0, flaky=0))
            if group is not None:
                report['table'] = dict(title='Probes', group=dict(key=group, label=group),
                    columns=[dict(key='probe', label='Probe')], rows=[dict(probe=f'{group}-{i}') for i in range(count)])
            return dict(id=ident, attempt=attempt, sha=str(ident)*20, branch='main', updated_at=f'2026-01-01T00:{ident:02}:00Z', tests=[report])
        runs = [run(6), run(5, 'smoke', 2), run(4, 'full', 4), run(3, 'regression', 3), run(2, 'smoke', 1)]
        tables = summary_tables(runs)
        self.assertEqual([(r['table']['group']['key'], r['totals']['tests'], r['run_id']) for r in tables],
                         [('smoke', 2, 5), ('full', 4, 4), ('regression', 3, 3)])
        self.assertEqual(tables[0]['sha'], runs[1]['sha'])
        self.assertEqual(tables[0]['attempt'], 1)
        # An older attempt of the SAME run must never stand in for its latest attempt.
        self.assertEqual(summary_tables([run(7, attempt=2), run(7, 'obsolete', attempt=1)]), [])
        # The full collector has the same selection contract as the incremental projection.
        class GH:
            def paginate(self, *a, **kw): return []
            def get_text_file(self, *a): return '{}'
        ctx = Context(GH(), Config(repo='acme/weather-service'), datetime.now(timezone.utc), {'default_branch':'main'})
        with patch('gsb.public_sections._tree_paths', return_value=([], 'test')):
            full = public_tests(ctx, runs)
        self.assertEqual(full['summary_tables'], tables)
        self.assertNotIn('table', full['executed'][0])

    def test_non_science_repository_table_survives_collection_and_both_snapshot_paths(self):
        from datetime import datetime, timezone
        from unittest.mock import patch
        from gsb.collectors import Context
        from gsb.public_sections import public_tests
        from gsb.incremental_project import _executed
        table = {'title': 'service checks', 'columns': [{'key': 'name', 'label': 'Check'}, {'key': 'value', 'label': 'Recorded value'}],
                 'rows': [{'name': 'probe-b', 'value': 'n/a'}, {'name': 'probe-a', 'value': '14.5M'}]}
        doc = dict(tests=2, passed=1, failed=1, skipped=0, flaky=0, table=table)
        class GH:
            def paginate(self, path, *args, **kw):
                return [] if path.endswith('/jobs') or path.endswith('/actions/artifacts') else [dict(id=10, name='service-test-results')]
            def download_artifact(self, repo, ident, **kw):
                assert repo == 'acme/weather-service'
                return archive({'dashboard-summary.json': json.dumps(doc)})
            def get_text_file(self, *args): return '{}'
        cfg = Config(repo='acme/weather-service')
        run = slim_run(dict(id=7, name='Service checks', head_branch='main', head_sha='a'*40,
                            html_url=cfg.repo_url+'/actions/runs/7', updated_at='2026-01-01T00:00:00Z'), {})
        run_details(GH(), cfg, run)
        self.assertEqual(run['tests'][0]['table'], table)
        ctx = Context(GH(), cfg, datetime.now(timezone.utc), {'default_branch': 'main'})
        with patch('gsb.public_sections._tree_paths', return_value=([], 'test')):
            full = public_tests(ctx, [run])
        self.assertEqual(full['executed'][0]['table'], table)
        self.assertEqual(_executed([run])[0]['table'], table)

    def test_real_e2e_scores_keep_four_native_shapes_without_private_payloads(self):
        files = {
            'results.json': json.dumps({'suites': [], 'stats': {'expected': 4, 'unexpected': 0, 'skipped': 0, 'flaky': 0}}),
            'drb/benchmark-metrics.json': json.dumps({'case_id': 59, 'integration_status': 'passed', 'prompt': 'PRIVATE', 'evaluation': {'status': 'passed', 'race': {'status': 'completed', 'overall_score': .54}, 'fact': {'status': 'completed', 'citation_accuracy': 80, 'verification_coverage': 90, 'effective_citations': 3}}}),
            'biomni/benchmark-metrics.json': json.dumps({'case_id': 'da-13-3', 'integration_status': 'passed', 'evaluation': {'status': 'scored', 'score': 87}, 'raw_response': 'PRIVATE'}),
            'team/team-metrics.json': json.dumps({'case': 'TC-E2E-01', 'integration': 'passed', 'generation_duration_ms': 1234, 'evaluation': {'status': 'scored', 'total_score': 86.25}, 'artifacts': {'PRIVATE': True}}),
            'puct/evolve-metrics.json': json.dumps({'case': 'PUCT-COMPRESS', 'integration_status': 'passed', 'started_at': '2026-09-20T10:00:00Z', 'finished_at': '2026-09-20T10:01:00Z', 'evaluation': {'status': 'scored', 'score': .69, 'baseline_gate_score': .5, 'best_gate_score': .7}, 'llm_evaluation': {'status': 'error', 'total_score': None, 'error': 'PRIVATE'}}),
        }
        parsed = parse_report_zip(archive(files))
        self.assertEqual(len(parsed['scores']), 4)
        self.assertEqual({row['family'] for row in parsed['scores']}, {'deepresearchbench', 'biomnibench', 'research-team', 'evolve-compression'})
        self.assertEqual(next(row for row in parsed['scores'] if row['case'] == 'PUCT-COMPRESS')['duration_ms'], 60000)
        drb = next(row for row in parsed['scores'] if row['case'] == 'DRB-59')
        self.assertEqual(drb['journey']['source'], 'source-definition')
        self.assertIn('DRB-59', drb['journey']['goal'])
        self.assertEqual(drb['journey']['metadata']['type'], 'real')
        self.assertNotIn('PRIVATE', json.dumps(parsed))

    def test_real_e2e_journey_report_attaches_public_fields_to_matching_score(self):
        report = '''<h1>旅程报告 · DRB-58 Swarm research integration</h1>
        <table><tr><th>用例</th><td>DRB-58 Swarm research integration</td></tr></table>
        <h2>场景目标</h2><p>Research DRB-58 and evaluate delivery.</p>
        <h2>前置条件</h2><ul><li>live generator</li><li>isolated Swarm stack</li></ul>
        <h2>步骤总览</h2><p>本次运行未记录用户步骤。</p>
        <h2>运行元数据（来自 E2E-META）</h2><table>
        <tr><th>类型</th><td>real</td></tr><tr><th>模型</th><td>Live generator</td></tr>
        <tr><th>凭据</th><td>E2E_API_TOKEN</td></tr></table>
        <h2>关键日志</h2><pre>PRIVATE LOG</pre>'''
        parsed = parse_report_zip(archive({
            'e2e-real/test-results/DRB-58/benchmark-metrics.json': json.dumps({
                'case_id': 58, 'integration_status': 'passed', 'generator_model': 'example-model',
                'evaluation': {'status': 'scored', 'race': {'overall_score': .7}}, 'prompt': 'PRIVATE PROMPT'}),
            'e2e-real/journey-reports/deepresearchbench-swarm/DRB-58/report.html': report,
            'e2e-real/journey-reports/deepresearchbench-swarm/DRB-59/report.html':
                report.replace('DRB-58', 'DRB-59'),
        }))
        score = parsed['scores'][0]
        self.assertEqual(score['case'], 'DRB-58')
        self.assertEqual(score['model'], 'example-model')
        self.assertEqual(score['journey']['goal'], 'Research DRB-58 and evaluate delivery.')
        self.assertEqual(score['journey']['preconditions'], ['live generator', 'isolated Swarm stack'])
        self.assertEqual(score['journey']['metadata']['credentials'], 'E2E_API_TOKEN')
        self.assertNotIn('PRIVATE', json.dumps(parsed))

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
