"""Restore the detailed dashboard sections without exporting private account data."""
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
import json
import re
import urllib.request

from .board import BoardStore
from .collectors import collect_ci, _tree_paths, OPS_BLOCKS
from .github import GitHubError
from .testparse import summarize_tree, package_of


def envelope(fn):
    try:
        result = fn()
        notes = result.pop('notes', [])
        safe_notes = [{'what': n.get('what') or n.get('key') or '数据源', 'message': '此项数据不完整或暂不可读取。'} for n in notes]
        return {'status': 'partial' if notes else 'ok', 'data': result, 'notes': safe_notes, 'error': None}
    except Exception:
        return {'status': 'error', 'data': None, 'notes': [], 'error': {'kind': 'error', 'message': '该区块暂不可读取，请稍后查看新快照。'}}


def public_ops(ctx):
    notes = []
    out = {'notes': notes, 'security': None, 'traffic': None}
    # These are explicitly public repository maintenance views. Never call the private collectors.
    keys = ('releases', 'branches', 'community', 'contributors', 'activity', 'commits', 'stale_automation')
    with ThreadPoolExecutor(max_workers=4) as pool:
        tasks = {k: pool.submit(OPS_BLOCKS[k][0], ctx, notes) for k in keys}
        for key, future in tasks.items():
            try:
                value = future.result()
            except Exception:
                notes.append({'key': key})
                value = None
            if key == 'commits':
                out['recent_commits'], out['commits_7d'] = value or ([], None)
            elif key == 'stale_automation':
                out[key] = value or {'workflow': None}
            else:
                out[key] = value
    if out.get('branches'):
        protection = out['branches']['protection']
        for key in ('reason', 'hint', 'kind'):
            protection.pop(key, None)
    out['public_advisories'] = None
    try:
        advisories = ctx.gh.get(f'/repos/{ctx.repo}/security-advisories', {'per_page': 30})
        out['public_advisories'] = [{'id': a.get('ghsa_id'), 'summary': a.get('summary'), 'severity': a.get('severity'),
                                    'url': a.get('html_url'), 'published_at': a.get('published_at')}
                                   for a in advisories if a.get('state') == 'published']
    except GitHubError:
        pass
    return out


def public_tests(ctx, runs):
    notes = []
    paths, source = _tree_paths(ctx, notes)
    tree = summarize_tree(paths) if paths else None
    scripts = {}
    try:
        pkg = ctx.gh.get_text_file(ctx.repo, 'package.json', ctx.default_branch)
        scripts = {k: v for k, v in json.loads(pkg or '{}').get('scripts', {}).items() if re.search('test|e2e|check|smoke', k)}
    except (GitHubError, ValueError):
        notes.append({'key': 'package.json'})
    executed, seen, artifacts = [], set(), []
    package_counts = {}
    # Keep run / SHA / attempt association from the strict report collector.
    for run in runs:
        for report in run.get('tests', []):
            artifacts.append({'id': report['artifact_id'], 'name': report['name'], 'run_id': run['id'], 'url': report['url'], 'created_at': report.get('created_at')})
            if report['name'] in seen:
                continue
            seen.add(report['name'])
            counts = report.get('counts')
            if report['layer'] == 'unit' and counts:
                for package in report.get('packages', []):
                    package_counts.setdefault(package['package'], {'tests': 0, 'failed': 0})
                    for key in ('tests', 'failed'):
                        package_counts[package['package']][key] += package[key]
                cases = report.get('cases', [])
                # Truncated or non-file-based reports cannot establish a package total.
                if not report.get('packages') and len(cases) == counts['tests'] and all(c.get('file') in paths for c in cases):
                    for case in cases:
                        entry = package_counts.setdefault(package_of(case['file']), {'tests': 0, 'failed': 0})
                        entry['tests'] += 1
                        entry['failed'] += case['status'] == 'failed'
            by_file = defaultdict(lambda: {'specs': 0, 'passed': 0, 'failed': 0, 'skipped': 0, 'flaky': 0, 'timedOut': 0, 'duration_ms': None})
            for case in report.get('cases', []):
                row = by_file[case.get('file') or '(未提供文件)']
                row['specs'] += 1
                row[case['status']] += 1
            executed.append({'artifact': report['name'], 'layer': 'ut' if report['layer'] == 'unit' else report['layer'],
                             'status': 'incomplete' if counts is None else 'failed' if counts['failed'] else 'unstable' if counts['flaky'] or counts['skipped'] else 'passed',
                             'run_id': run['id'], 'sha': run['sha'], 'attempt': run['attempt'], 'branch': run['branch'],
                             'created_at': run['updated_at'], 'duration_ms': None, 'totals': counts,
                             'detail': {'files': [{'file': k, **v} for k, v in by_file.items()],
                                        'failures': [{'file': c.get('file'), 'title': c['name'], 'status': c['status']} for c in report.get('cases', []) if c['status'] == 'failed'],
                                        'stats': {'expected': (counts or {}).get('passed'), 'unexpected': (counts or {}).get('failed'), 'flaky': (counts or {}).get('flaky')},
                                        'projects': sorted({c['project'] for c in report.get('cases', []) if c.get('project')}),
                                        **{k: report[k] for k in ('commands', 'packages') if k in report}},
                             'note': None if counts else '此运行没有可核验的用例数量。'})
    coverage = {'source': None, 'value': None, 'attempts': []}
    for run in runs:
        values = run.get('coverage', [])
        if values:
            value = values[0]
            coverage.update(source=f"Actions run {run['id']} / attempt {run['attempt']} · {run['sha'][:12]}", value=value)
            break
    coverage['attempts'].append({'step': 'Actions 覆盖率产物 / 测试产物内嵌报告', 'ok': bool(coverage['value']), 'detail': '仅使用当前 run / SHA / attempt 的 lcov、Istanbul 或 Cobertura 报告。'})
    if not coverage['value']:
        try:
            request = urllib.request.Request(f'https://api.codecov.io/api/v2/github/{ctx.cfg.owner}/repos/{ctx.cfg.name}/', headers={'User-Agent': 'github-status-board'})
            with urllib.request.urlopen(request, timeout=10) as response:
                doc = json.load(response)
            value = (doc.get('totals') or {}).get('coverage')
            if isinstance(value, (int, float)) and 0 <= value <= 100:
                coverage.update(source='Codecov 公共汇总（未关联本次构建）', value={'format': 'codecov', 'lines_pct': value})
            coverage['attempts'].append({'step': 'Codecov 公共 API', 'ok': bool(coverage['value']), 'detail': '独立的仓库汇总，不作为本次构建的门禁依据。'})
        except Exception:
            coverage['attempts'].append({'step': 'Codecov 公共 API', 'ok': False, 'detail': '未获得可读取的公共覆盖率汇总。'})
    configs = [p for p in paths if re.search(r'(^|/)(\.nycrc|\.c8rc|codecov\.ya?ml|\.codecov\.ya?ml)|coverage-summary|lcov\.info', p, re.I)]
    coverage['attempts'].append({'step': '仓库覆盖率配置', 'ok': bool(configs), 'detail': ', '.join(configs[:10]) or '文件树中未发现独立覆盖率配置；配置存在也不代表已测得覆盖率。'})
    return {'notes': notes, 'tree_source': source, 'tree': {k: v for k, v in tree.items() if k != 'inventory'} if tree else None,
            'inventory': [{**row, 'ci_cases': package_counts.get(row['package'], {}).get('tests'), 'ci_failed': package_counts.get(row['package'], {}).get('failed')} for row in (tree or {}).get('inventory', [])],
            'test_scripts': scripts, 'artifacts_recent': artifacts[:30], 'executed': executed, 'coverage': coverage}


def extend_project(doc, ctx):
    meta = ctx.repo_meta
    repo = {key: meta.get(key) for key in ('description', 'default_branch', 'language', 'pushed_at')}
    repo.update(stars=meta.get('stargazers_count'), forks=meta.get('forks_count'), license=(meta.get('license') or {}).get('spdx_id'))
    wrap = lambda value: {'status': 'ok' if value is not None else 'error', 'data': value, 'notes': [], 'error': None if value is not None else {'kind': 'error', 'message': '数据暂不可读取'}}
    sections = {'repo': wrap(repo), 'issues': wrap(doc['issues']), 'prs': wrap(doc['prs'])}
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {'ci': pool.submit(envelope, lambda: collect_ci(ctx)),
                'tests': pool.submit(envelope, lambda: public_tests(ctx, doc['quality']['runs'])),
                'ops': pool.submit(envelope, lambda: public_ops(ctx))}
        sections.update({k: future.result() for k, future in jobs.items()})
    doc.update(repo=ctx.repo, repo_url=meta['html_url'], sections=sections,
               config={'artifact_names': ctx.cfg.artifact_names, 'stale_days': ctx.cfg.stale_days,
                       'review_sla_days': ctx.cfg.review_sla_days, 'pr_idle_days': ctx.cfg.pr_idle_days})
    # Build only GitHub-derived defaults; never load .data/board.json into a public export.
    board = BoardStore(ctx.cfg, persist=False)
    doc['board'] = board.payload(doc)
    doc['details'] = {}
    for kind, section, keys in (('issue', doc['issues'] or {}, ('items', 'closed_recent')),
                                ('pr', doc['prs'] or {}, ('items', 'recent_merged', 'recent_closed_unmerged'))):
        for key in keys:
            for item in section.get(key, []):
                doc['details'][f"{kind}:{item['number']}"] = {'body': item.get('body', ''), 'cross_references': []}
