"""Restore the detailed dashboard sections without exporting private account data."""
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
import json
import re

from .board import BoardStore
from .collectors import collect_ci, _coverage_probe, _tree_paths, OPS_BLOCKS
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
    try:
        paginate = getattr(ctx.gh, 'paginate', None)
        raw_artifacts = paginate(
            f'/repos/{ctx.repo}/actions/artifacts', {'per_page': 100}, max_pages=5, key='artifacts'
        ) if paginate else []
    except GitHubError:
        raw_artifacts = []
        notes.append({'key': 'coverage-artifacts'})
    coverage_artifacts = [{
        'id': artifact['id'],
        'name': artifact['name'],
        'size': artifact.get('size_in_bytes'),
        'expired': artifact.get('expired'),
        'created_at': artifact.get('created_at'),
        'expires_at': artifact.get('expires_at'),
        'url': artifact.get('url'),
        'run_id': (artifact.get('workflow_run') or {}).get('id'),
        'branch': (artifact.get('workflow_run') or {}).get('head_branch'),
        'sha': (artifact.get('workflow_run') or {}).get('head_sha'),
    } for artifact in raw_artifacts]
    coverage = _coverage_probe(ctx, coverage_artifacts, paths, {}, notes) if hasattr(ctx.gh, 'get') else {
        'source': None,
        'value': None,
        'attempts': [{'step': 'Actions 覆盖率摘要', 'ok': False, 'detail': '测试替身未提供 GitHub 数据接口。'}],
    }
    # Preserve the generic run-level fallback for repositories that expose
    # coverage through an existing test artifact rather than our summary
    # manifests. ScienceDiscovery normally takes the manifest path above.
    if not coverage.get('source'):
        for run in runs:
            values = run.get('coverage') or []
            if not values:
                continue
            coverage_source = f"Actions run {run['id']} / attempt {run['attempt']} · {run['sha'][:12]}"
            coverage.update(source=coverage_source, value=values[0])
            coverage.setdefault('attempts', []).insert(0, {
                'step': 'Actions 测试产物', 'ok': True, 'detail': coverage_source,
            })
            break
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
