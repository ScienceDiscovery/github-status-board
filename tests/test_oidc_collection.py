from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import collect_with_oidc as client


class OIDCCollectionTests(unittest.TestCase):
    def setUp(self):
        source, deployment = next(iter(json.loads((client.ROOT / 'board-config.json').read_text())['deployments'].items()))
        self.source, self.target = source, deployment['repository']
        self.env = {'GITHUB_REPOSITORY': self.target, 'SDBOT_TOKEN_BROKER_URL': 'https://broker.example/actions/token',
                    'SDBOT_TOKEN_AUDIENCE': 'test-audience', 'ACTIONS_ID_TOKEN_REQUEST_URL': 'https://issuer.example/oidc?x=1',
                    'ACTIONS_ID_TOKEN_REQUEST_TOKEN': 'runner-auth', 'SDBOT_GITHUB_APP_PRIVATE_KEY': 'must-not-inherit'}
        self.calls = []

    def request(self, url, bearer, body=None, method='GET'):
        self.calls.append((url, bearer, body, method))
        if url.startswith('https://issuer.example/'):
            self.assertIn('audience=test-audience', url)
            self.assertEqual(bearer, 'runner-auth')
            return {'value': 'oidc-identity'}
        if method == 'DELETE':
            return None
        self.assertEqual(bearer, 'oidc-identity')
        purpose = body['purpose']
        return {'token': purpose + '-token', 'repository': self.source if purpose == 'source' else self.target,
                'purpose': purpose, 'expires_at': (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}

    def test_scoped_tokens_only_reach_collector_and_are_revoked_on_exit(self):
        with patch.dict(os.environ, self.env, clear=True), patch.object(client, 'request_json', side_effect=self.request), \
             patch.object(client, 'mask') as mask, patch.object(client.subprocess, 'run', return_value=SimpleNamespace(returncode=7)) as run:
            self.assertEqual(client.main(), 7)
        env = run.call_args.kwargs['env']
        self.assertEqual(env['GITHUB_TOKEN'], 'source-token')
        self.assertEqual(env['GSB_PUBLISH_TOKEN'], 'target-token')
        self.assertNotIn('ACTIONS_ID_TOKEN_REQUEST_TOKEN', env)
        self.assertNotIn('ACTIONS_ID_TOKEN_REQUEST_URL', env)
        self.assertNotIn('SDBOT_GITHUB_APP_PRIVATE_KEY', env)
        self.assertEqual([c[1] for c in self.calls if c[3] == 'DELETE'], ['source-token', 'target-token'])
        self.assertEqual(mask.call_count, 3)

    def test_partial_exchange_failure_revokes_source_and_never_collects(self):
        def request(url, bearer, body=None, method='GET'):
            if body == {'purpose': 'target'}:
                raise client.CredentialError('sensitive response must not appear')
            return self.request(url, bearer, body, method)
        output = io.StringIO()
        with patch.dict(os.environ, self.env, clear=True), patch.object(client, 'request_json', side_effect=request), \
             patch.object(client, 'mask'), patch.object(client.subprocess, 'run') as run, patch('sys.stdout', output):
            self.assertEqual(client.main(), 1)
        run.assert_not_called()
        self.assertEqual([c[1] for c in self.calls if c[3] == 'DELETE'], ['source-token'])
        self.assertNotIn('sensitive response', output.getvalue())

    def test_invalid_broker_and_cross_source_fail_before_credentials(self):
        for override in [{'SDBOT_TOKEN_BROKER_URL': 'http://broker.example/actions/token'},
                         {'SDBOT_TOKEN_BROKER_URL': 'https://broker.example/actions/token?token=bad'},
                         {'SOURCE_REPOSITORY': 'other/source'}]:
            with self.subTest(override=override), patch.dict(os.environ, {**self.env, **override}, clear=True), \
                 patch.object(client, 'request_json') as request, patch('sys.stdout', io.StringIO()):
                self.assertEqual(client.main(), 1)
                request.assert_not_called()

    def test_token_scope_mismatch_is_revoked(self):
        def request(url, bearer, body=None, method='GET'):
            result = self.request(url, bearer, body, method)
            if body:
                result['repository'] = 'other/source'
            return result
        with patch.dict(os.environ, self.env, clear=True), patch.object(client, 'request_json', side_effect=request), \
             patch.object(client, 'mask'), patch.object(client.subprocess, 'run') as run, patch('sys.stdout', io.StringIO()):
            self.assertEqual(client.main(), 1)
            run.assert_not_called()
        self.assertEqual(self.calls[-1][3], 'DELETE')

    def test_redirects_are_never_followed_and_mask_commands_are_escaped(self):
        self.assertIsNone(client.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.example'))
        out = io.StringIO()
        with patch('sys.stdout', out): client.mask('a%\nb\r')
        self.assertEqual(out.getvalue(), '::add-mask::a%25%0Ab%0D\n')
