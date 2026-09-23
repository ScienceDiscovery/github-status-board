import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
from gsb.github import GitHubError
from publish import export_site, publish, deployment_for, ROOT


class DeploymentTests(unittest.TestCase):
    def test_cli_separates_source_and_destination_credentials(self):
        import publish as publisher
        from types import SimpleNamespace
        source, destination = SimpleNamespace(token='read-token'), SimpleNamespace(token='write-token')
        with patch('sys.argv',['publish.py','--repo','example/source','--publish-repo','example/board']), \
             patch.dict('os.environ',{'GSB_PUBLISH_TOKEN':'write-token'}), \
             patch.object(publisher,'discover_token',return_value=('read-token','env')), \
             patch.object(publisher,'GitHub',side_effect=[source,destination]), \
             patch.object(publisher,'build_project',return_value={'generated_at':'now'}) as build, \
             patch.object(publisher,'export_site'), \
             patch.object(publisher,'publish',return_value='a'*40) as commit, patch('builtins.print'):
            self.assertEqual(publisher.main(),0)
        self.assertIs(build.call_args.args[0],source)
        self.assertIs(commit.call_args.args[0],destination)
        self.assertEqual(commit.call_args.kwargs['source_token'],'read-token')

    def test_production_and_test_cannot_be_published_to_each_others_site(self):
        settings = {'deployments': {
            'openJiuwen-ai/sciencediscovery': {'label': '正式', 'repository': 'ScienceDiscovery/github-status-board'},
            'ScienceDiscovery/sciencediscovery': {'label': '测试', 'repository': 'ScienceDiscovery/github-status-board-test'},
        }}
        production = deployment_for('OPENJIUWEN-AI/sciencediscovery', settings, 'ScienceDiscovery/github-status-board')
        experiment = deployment_for('ScienceDiscovery/sciencediscovery', settings, 'ScienceDiscovery/github-status-board-test')
        self.assertEqual(production['label'], '正式')
        self.assertEqual(experiment['label'], '测试')
        for source, wrong in [('openJiuwen-ai/sciencediscovery', experiment), ('ScienceDiscovery/sciencediscovery', production)]:
            with self.assertRaises(ValueError):
                deployment_for(source, settings, wrong['repository'])

ROOT=Path(__file__).resolve().parents[1]
class PublishingTests(unittest.TestCase):
    def setUp(self):
        (ROOT/'.tmp').mkdir(exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=ROOT/'.tmp')
        self.addCleanup(self.temp.cleanup)
        self.site=Path(self.temp.name)
        export_site(self.site,{'schema_version':1,'generated_at':'2026-01-01'})
    def test_frontend_assets_share_one_cache_version(self):
        html=(self.site/'index.html').read_text(encoding='utf-8')
        versions=re.findall(r'(?:style\.css|(?:board-local|app|board)\.js)\?v=([^"\']+)',html)
        self.assertEqual(len(versions),4)
        self.assertEqual(len(set(versions)),1)
    def test_only_public_files_are_committed_atomically(self):
        calls=[]
        class GH:
            token='test-secret-for-publishing'
            def get(self,path):
                if '/git/commits/' in path: return {'tree':{'sha':'existing-source-tree'}}
                return {'object':{'sha':'old'}} if '/git/' in path else {'private':False}
            def _url(self,path,_): return path
            def _request(self,method,path,body):
                calls.append((method,path,body))
                return ({'sha':'new-tree' if path.endswith('/trees') else 'new-commit'},None,200)
        (self.site/'.env').write_text('private local file')
        self.assertEqual(publish(GH(),self.site,'example/board'),'new-commit')
        files=calls[0][2]['tree']
        self.assertEqual({f['path'] for f in files},{'site/'+p for p in ('index.html','app.js','style.css','board.js','board-local.js','data/snapshot.json','.nojekyll')})
        self.assertEqual(calls[0][2]['base_tree'],'existing-source-tree')
        self.assertTrue(calls[2][1].endswith('/git/refs/heads/main'))
        self.assertEqual(calls[1][2]['parents'],['old'])
        self.assertEqual(calls[2][2],{'sha':'new-commit','force':False})
    def test_credential_in_content_prevents_remote_write(self):
        class GH:
            token='test-secret-for-publishing'
            def get(self,path):
                if '/git/commits/' in path: return {'tree':{'sha':'existing-source-tree'}}
                return {'object':{'sha':'old'}} if '/git/' in path else {'private':False}
            def _request(self,*a,**k): raise AssertionError('must not write')
        (self.site/'data/snapshot.json').write_text(json.dumps({'title':GH.token}))
        with self.assertRaises(ValueError): publish(GH(),self.site,'example/board')
        (self.site/'data/snapshot.json').write_text(json.dumps({'title':'source-read-token'}))
        with self.assertRaises(ValueError): publish(GH(),self.site,'example/board',source_token='source-read-token')
    def test_conflict_is_not_force_updated_or_retried_on_another_branch(self):
        writes=[]
        class GH:
            token=''
            def get(self,path):
                if '/git/commits/' in path: return {'tree':{'sha':'base'}}
                return {'object':{'sha':'old'}} if '/git/' in path else {'private':False}
            def _url(self,path,_): return path
            def _request(self,method,path,body):
                writes.append((method,path,body))
                if method=='PATCH': raise GitHubError('conflict', status=422)
                return {'sha':'new'},None,200
        with self.assertRaises(GitHubError): publish(GH(),self.site,'example/board')
        self.assertEqual(len(writes),3)
        self.assertFalse(writes[-1][2]['force'])
    def test_private_target_refused(self):
        class GH:
            token=''
            def get(self,path): return {'private':True}
        with self.assertRaises(ValueError): publish(GH(),self.site,'example/private')
