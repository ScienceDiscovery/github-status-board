"""Deterministic acceptance data. Never publish these synthetic runs to Pages."""
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from publish import export_site

root=Path(__file__).resolve().parents[1]
time='2026-09-20T12:00:00Z'
repo='ScienceDiscovery/sciencediscovery'
base='https://github.com/'+repo
item=dict(number=1,title='处理超时问题 <script>alert(1)</script>',url=base+'/issues/1',author='maintainer',labels=[{'name':'bug'}],assignees=[],age_days=4,updated_at=time,milestone='v1.0')
pr=dict(item,number=3,title='修复工作流',url=base+'/pull/3',draft=False,review_decision='CHANGES_REQUESTED',head_sha='a'*40,ci={'state':'failure','checks':[{'name':'E2E','conclusion':'failure','url':base+'/actions/runs/10'}]})
runs=[]
for idx,kind in enumerate(('gate','daily','release')):
    counts={'tests':10,'passed':7,'failed':1,'skipped':1,'flaky':1}
    if kind=='release': counts={'tests':10,'passed':10,'failed':0,'skipped':0,'flaky':0}
    runs.append(dict(id=10+idx,workflow_id=idx,name={'gate':'CI','daily':'Daily','release':'Release'}[kind],channel=kind,event={'gate':'pull_request','daily':'schedule','release':'release'}[kind],status='completed',conclusion='failure' if kind!='release' else 'success',branch='main',sha='a'*40,attempt=2,updated_at=time,url=base+'/actions/runs/'+str(10+idx),reports_status='available',jobs=[{'name':'E2E','status':'completed','conclusion':'failure','url':base+'/actions/runs/10','failed_steps':['Run browser journeys']}],tests=[{'name':'e2e-results','layer':'e2e','status':'available','counts':counts,'cases':[{'name':'创建项目','file':'test/create.spec.ts','project':'chromium','status':'passed'},{'name':'恢复会话','file':'test/session.spec.ts','project':'chromium','status':'flaky'}]}]))
doc={'schema_version':1,'generated_at':time,'repository':{'name':repo,'url':base,'description':'浏览器验收数据','default_branch':'main'},'issues':{'open_count':1,'unassigned_count':1,'stale_count':0,'counts':{'opened_30d':4,'closed_30d':3},'items':[item]},'prs':{'open_count':1,'waiting_review_count':1,'draft_count':0,'merged_30d':2,'median_time_to_merge_h':3,'items':[pr]},'quality':{'runs':runs,'required_checks':['E2E'],'branch_protected':True},'releases':[{'tag':'v1.0','url':base+'/releases/tag/v1.0','sha':'a'*40,'published_at':time,'prerelease':False,'validation_run_ids':[12]},{'tag':'v0.9','url':base+'/releases/tag/v0.9','sha':'b'*40,'published_at':time,'prerelease':False,'validation_run_ids':[]}],'notices':[{'message':'部分补充信息不可读取，请以 GitHub 原页面为准。'}]}

# Keep all ten pages exercised without contacting GitHub during acceptance tests.
from datetime import datetime, timezone
from unittest.mock import patch
from gsb.board import BoardStore
from gsb.config import Config
from gsb.collectors import Context
from gsb.public_sections import public_tests

item.update(state='open',created_at=time,comments=0,idle_days=4,body='## Reproduction\nDetails for #1. <script>alert(2)</script>')
pr.update(state='open',created_at=time,comments=1,idle_days=4,body='Fixes #1',head='fix-timeout',base='feat/jiuwenswarm',requested_reviewers=['reviewer'],reviews=[],waiting_review=True,mergeable='CONFLICTING',linked_issues=[1])
issues=doc['issues']; issues.update(unlabeled_count=0,no_response_count=1,median_age_days=4,oldest_age_days=4,stale_days_threshold=30,labels=[dict(name='bug',color='aa3333',count=1)],unused_labels=[],aging=[dict(bucket='0–7 天',count=1)],assignee_load=[],milestones=[dict(name='v1.0',count=1)],recent=[item],stale=[],oldest=[item],closed_recent=[])
issues['counts'].update(closed_total=3,opened_7d=1,closed_7d=0)
prs=doc['prs'];prs.update(review_sla_days=3,ci_states={'failure':1},review_decisions={'CHANGES_REQUESTED':1},closed_unmerged_30d=0,p90_time_to_merge_h=5,median_time_to_merge_h_human=3,merged_human_count=2,reviewer_load=[dict(login='reviewer',count=1)],authors=[dict(login='maintainer',count=1)],recent_merged=[],recent_closed_unmerged=[])
for r in runs:
    r.update(title=r['name'],created_at=time,duration_s=120,actor='maintainer')
    r['jobs'][0].update(duration_s=120)
    r['tests'][0].update(artifact_id=r['id']+100,url=r['url']+'/artifacts/100',created_at=time)
class GH:
    def get_text_file(self,*args): return '{"scripts":{"test":"node --test"}}'
    def paginate(self,*args,**kwargs): return []
cfg=Config(repo=repo)
ctx=Context(GH(),cfg,datetime.now(timezone.utc),{'default_branch':'main'})
with patch('gsb.public_sections._tree_paths',return_value=(['services/core/src/index.ts','services/core/tests/test_main.py','test/session.spec.ts','services/empty/index.ts'],'github:git-tree')):
    tests=public_tests(ctx,runs)
node_totals=dict(lines=dict(covered=48878,total=58864,percentage=83.04),branches=dict(covered=13987,total=17548,percentage=79.71),functions=dict(covered=3928,total=4701,percentage=83.56))
python_totals=dict(lines=dict(covered=5845,total=8932,percentage=65.44),branches=dict(covered=1507,total=3086,percentage=48.83))
def coverage_language(name,totals,group):
    baseline=dict(artifact=f'{name}-coverage-summary-main-incremental-mainsha',created_at=time,kind='main full',sha='a'*40,totals=totals,groups=[dict(name=group,files=4,totals=totals)])
    current=dict(kind='authoritative',totals=totals,groups=[dict(name=group,files=4,totals=totals,source_sha='a'*40,updated_at=time,update_kind='full baseline')],increments=[])
    percentages=[totals['lines']['percentage']-2.8,totals['lines']['percentage']-2.4,totals['lines']['percentage']-2.0,totals['lines']['percentage']-1.8,totals['lines']['percentage']-1.2,totals['lines']['percentage']-0.4,totals['lines']['percentage']]
    history=[]
    for day,percentage in zip((11,12,17,18,19,20,21),percentages):
        historical_totals=json.loads(json.dumps(totals))
        historical_totals['lines']['percentage']=round(percentage,2)
        historical_totals['lines']['covered']=round(historical_totals['lines']['total']*percentage/100)
        history.append(dict(day=f'2026-09-{day:02d}',artifact=f'{name}-coverage-summary-nightly-{day}',run_id=day,created_at=f'2026-09-{day:02d}T12:00:00Z',sha='a'*40,kind='nightly',totals=historical_totals))
    return dict(language=name,source='artifact:'+baseline['artifact'],scope='fixture coverage scope',baseline=baseline,current=current,history=history,pull_requests=[dict(number=3,branch='fix-timeout',created_at=time,sha='a'*40,groups=current['groups'],totals=totals)])
combined=dict(lines=dict(covered=54723,total=67796,percentage=80.72),branches=dict(covered=15494,total=20634,percentage=75.09),functions=node_totals['functions'])
tests['coverage']=dict(source='Actions coverage summaries',value=dict(format='sciencediscovery-summary',lines_pct=80.72,branches_pct=75.09,functions_pct=83.56),current=dict(kind='authoritative',totals=combined),languages=dict(node=coverage_language('node',node_totals,'packages/core'),python=coverage_language('python',python_totals,'services/evolve')),attempts=[dict(step='Actions 覆盖率摘要',ok=True,detail='Node.js + Python')])
runs[0]['jobs'].append(dict(name='Coverage',status='completed',conclusion='success',url=runs[0]['url']+'/job/coverage',failed_steps=[],duration_s=385))
rate=dict(success_rate=50,total=2,success=1,failure=1,cancelled=0,median_duration_s=120)
ci=dict(default_branch='main',main=rate,pull_request=rate,red_streak_main=1,failures_7d=2,runs_sampled=3,job_history_runs=2,main_timeline=runs,latest_main=dict(run=runs[0],jobs=runs[0]['jobs']),workflows=[dict(name='CI',url=runs[0]['url'],path='.github/workflows/ci.yml',state='active',all=rate,main=rate,pull_request=rate,failures_7d=2,last_run=runs[0])],job_health=[dict(name='E2E',success_rate=50,runs=2,success=1,failure=1,cancelled=0,median_duration_s=120,last=runs[0],top_failed_steps=[dict(step='Run browser journeys',count=1)]),dict(name='Coverage',success_rate=100,runs=1,success=1,failure=0,cancelled=0,median_duration_s=385,last=runs[0],top_failed_steps=[])],recent_runs=runs)
# CI lanes: 13 PR runs on the newest day (more than one column shows), manual and push
# runs on main, one nightly per evening, a Nightly-called CI child and no release.
from gsb.ci_lanes import build_lanes
def lane_run(ident,name,event,created,branch,conclusion='success',pull_requests=()):
    return dict(id=ident,attempt=1,name=name,workflow_id={'CI':1,'Nightly':2}[name],event=event,status='in_progress' if conclusion is None else 'completed',conclusion=conclusion,branch=branch,sha=f'{ident:040x}',created_at=created,url=f'{base}/actions/runs/{ident}',pull_requests=list(pull_requests),title=f'{name} run {ident}')
outcomes=['success','failure','cancelled','timed_out',None,'success','failure','success','action_required','success','failure','success','success']
lane_runs=[lane_run(500+i,'CI','pull_request',f'2026-09-19T{16+i//4:02d}:{(i%4)*15+10:02d}:00Z','fix-timeout',c,pull_requests=[3] if i%2 else []) for i,c in enumerate(outcomes)]
lane_runs+=[lane_run(480,'CI','pull_request','2026-09-17T03:00:00Z','fix-timeout','failure'),lane_run(481,'CI','pull_request','2026-09-17T05:30:00Z','fix-timeout')]
lane_runs+=[lane_run(470,'CI','push','2026-09-18T02:00:00Z','main'),lane_run(471,'CI','workflow_dispatch','2026-09-20T01:00:00Z','main','failure')]
lane_runs+=[lane_run(400+d,'Nightly','schedule',f'2026-09-{d:02d}T18:00:00Z','main','failure' if d==16 else 'success') for d in range(12,20)]
lane_runs.append(lane_run(399,'CI','workflow_call','2026-09-19T18:00:05Z','main'))
lanes=build_lanes(lane_runs,default_branch='main',now=datetime(2026,9,20,12,tzinfo=timezone.utc),rules=json.loads((root/'board-config.json').read_text())['workflows'],prs=[pr])
ci['lanes']=lanes
ops=dict(releases=dict(latest=None,count=0,items=[],tags=[],total_downloads=0,cadence_days=None,unreleased=None),branches=dict(default='main',protection=dict(enabled=True,required_reviews=1,required_checks=['E2E']),rulesets=[],items=[],count=1,stale=[]),public_advisories=[],community=dict(health_percentage=75,missing=['contributing'],files=dict(readme=True,contributing=False)),contributors=dict(count=2,total_commits=10,bus_factor_50=1,top=[dict(login='maintainer',contributions=8,share=80)]),activity=dict(weeks=[dict(week=1789819200,total=10)],commits_4w=10,commits_52w=10),recent_commits=[],commits_7d=3,stale_automation=dict(workflow=None))
wrap=lambda value:dict(status='ok',data=value,notes=[],error=None)
doc.update(repo=repo,repo_url=base,config=dict(artifact_names=['ut-results','e2e-results'],pr_idle_days=14),sections={k:wrap(v) for k,v in dict(repo=dict(description='浏览器验收数据',stars=10,forks=2,language='Python',license='MIT',default_branch='main',pushed_at=time),issues=issues,prs=prs,ci=ci,tests=tests,ops=ops).items()})
doc['board']=BoardStore(cfg,persist=False).payload(doc)
doc['details']={'issue:1':dict(body=item['body'],cross_references=[]),'pr:3':dict(body=pr['body'],cross_references=[])}
export_site(root/'.e2e/site/github-status-board',doc)
empty=json.loads(json.dumps(doc));empty['quality']['runs']=[];empty['releases']=[];empty['issues']=None;empty['prs']=None;empty['notices']=[{'message':'GitHub 数据不可读取，结果未知。'}]
empty['sections']={k:dict(status='error',data=None,notes=[],error=dict(kind='error',message='结果未知')) for k in empty['sections']}
empty['board']['items']=[];empty['details']={}
export_site(root/'.e2e/site/empty',empty)

# Complete-history fixture exceeds both the old Issue cap and one browser page.
from gsb.history import History, encode
history_root=root/'.e2e/history-fixture'
history=History(history_root)
for number in range(1, 626):
    row={**item,'number':number,'title':f'历史 Issue {number}','url':base+f'/issues/{number}', 'body':'历史正文 <script>unsafe()</script>'}
    history.put('issues',row)
for r in runs:
    r=json.loads(json.dumps(r))
    for t in r['tests']:t.pop('cases',None)
    history.put('runs',r)
history.files()
path=root/'.e2e/site/github-status-board/data/snapshot.json'
full=json.loads(path.read_text());full['history']={'manifest':'./data/history/manifest.json'}
full['sync']={'complete':False,'totals':history.manifest['totals'],'pending':3,'failed':1}
path.write_text(encode(full))
for name,content in history.files().items():
    if not name.startswith('site/'):continue
    target=root/'.e2e/site/github-status-board'/name.removeprefix('site/')
    target.parent.mkdir(parents=True,exist_ok=True);target.write_text(content)
