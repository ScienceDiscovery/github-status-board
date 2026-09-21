import json
from pathlib import Path
import tempfile
import unittest
from gsb.github import GitHubError
from publish import export_site, publish

ROOT=Path(__file__).resolve().parents[1]
class PublishingTests(unittest.TestCase):
    def setUp(self):
        (ROOT/'.tmp').mkdir(exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=ROOT/'.tmp')
        self.addCleanup(self.temp.cleanup)
        self.site=Path(self.temp.name)
        export_site(self.site,{'schema_version':1,'generated_at':'2026-01-01'})
    def test_only_public_files_are_committed_atomically(self):
        calls=[]
        class GH:
            token='test-secret-for-publishing'
            def get(self,path): return {'object':{'sha':'old'}} if '/git/' in path else {'private':False}
            def _url(self,path,_): return path
            def _request(self,method,path,body):
                calls.append((method,path,body))
                return ({'sha':'new-tree' if path.endswith('/trees') else 'new-commit'},None,200)
        (self.site/'.env').write_text('private local file')
        self.assertEqual(publish(GH(),self.site,'example/board'),'new-commit')
        files=calls[0][2]['tree']
        self.assertEqual({f['path'] for f in files},{'index.html','app.js','style.css','report.js','board.js','board-local.js','data/snapshot.json','.nojekyll'})
        self.assertEqual(calls[1][2]['parents'],['old'])
        self.assertEqual(calls[2][2],{'sha':'new-commit','force':False})
    def test_credential_in_content_prevents_remote_write(self):
        class GH:
            token='test-secret-for-publishing'
            def get(self,path): return {'object':{'sha':'old'}} if '/git/' in path else {'private':False}
            def _request(self,*a,**k): raise AssertionError('must not write')
        (self.site/'data/snapshot.json').write_text(json.dumps({'title':GH.token}))
        with self.assertRaises(ValueError): publish(GH(),self.site,'example/board')
    def test_private_target_refused(self):
        class GH:
            token=''
            def get(self,path): return {'private':True}
        with self.assertRaises(ValueError): publish(GH(),self.site,'example/private')
