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
doc={'schema_version':1,'generated_at':time,'repository':{'name':repo,'url':base,'description':'浏览器验收数据','default_branch':'main'},'issues':{'open_count':1,'unassigned_count':1,'stale_count':0,'counts':{'opened_30d':4,'closed_30d':3},'items':[item]},'prs':{'open_count':1,'waiting_review_count':1,'draft_count':0,'merged_30d':2,'median_time_to_merge_h':3,'items':[pr]},'quality':{'runs':runs,'required_checks':['E2E'],'branch_protected':True},'releases':[{'tag':'v1.0','url':base+'/releases/tag/v1.0','sha':'a'*40,'published_at':time,'prerelease':False,'validation_run_ids':[12]},{'tag':'v0.9','url':base+'/releases/tag/v0.9','sha':'b'*40,'published_at':time,'prerelease':False,'validation_run_ids':[]}],'notices':[]}
export_site(root/'.e2e/site/github-status-board',doc)
empty=json.loads(json.dumps(doc));empty['quality']['runs']=[];empty['releases']=[];empty['issues']=None;empty['prs']=None;empty['notices']=[{'message':'GitHub 数据不可读取，结果未知。'}]
export_site(root/'.e2e/site/empty',empty)
