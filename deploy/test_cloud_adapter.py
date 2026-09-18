"""Run locally without Docker; uses mocks except the optional real-engine test."""
import base64
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '本地演示'))
TEMP = tempfile.TemporaryDirectory()
password_file = Path(TEMP.name) / 'test-password.txt'
password_file.write_text('test-only-password-not-for-deployment')
os.environ.update(ECOP_PUBLIC_ORIGIN='https://ecop.aitomoney.online',
                  ECOP_PASSWORD_FILE=str(password_file))
# Dummy MCP credential for mocked tests; real test below is explicitly opt-in.
token_file = Path(TEMP.name) / 'test-mcp.txt'
token_file.write_text('unit-test-only')
if '--real-engine' not in sys.argv:
    os.environ['DWSIM_TOKEN_FILE'] = str(token_file)
REAL = '--real-engine' in sys.argv
if REAL:
    sys.argv.remove('--real-engine')
os.environ['ECOP_RUNS_DIR'] = str(Path(TEMP.name) / 'runs')
import cloud_app

SAMPLE = {'flow_kg_h': 1000, 'temperature_C': 25, 'pressure_kPa': 101.325, 'vapor_percent': 30}


def request(path='/', method='GET', authenticated=True, origin=None, nonce=None, payload=None, host=None):
    body = json.dumps(payload).encode() if payload is not None else b''
    env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'CONTENT_LENGTH': str(len(body)),
           'wsgi.input': io.BytesIO(body), 'HTTP_HOST': host or 'ecop.aitomoney.online'}
    if authenticated:
        env['HTTP_AUTHORIZATION'] = 'Basic ' + base64.b64encode(
            ('ecop:' + password_file.read_text()).encode()).decode()
    if origin: env['HTTP_ORIGIN'] = origin
    if nonce: env['HTTP_X_DEMO_TOKEN'] = nonce
    state = {}
    def start(status, headers): state.update(status=status, headers=dict(headers))
    result = b''.join(cloud_app.application(env, start))
    return state['status'], result


class CloudTests(unittest.TestCase):
    def test_auth_all_business_routes(self):
        for path in ['/', '/logo.png', '/api/status', '/api/calculate']:
            self.assertTrue(request(path, authenticated=False)[0].startswith('401'))

    def test_health_and_page(self):
        self.assertTrue(request('/healthz', authenticated=False)[0].startswith('200'))
        status, body = request()
        self.assertTrue(status.startswith('200'))
        self.assertIn('云端受控验证'.encode(), body)
        self.assertNotIn(b'__NONCE__', body)
        self.assertTrue(request(host='evil.example')[0].startswith('400'))

    def test_cross_site_blocked(self):
        self.assertTrue(request('/api/calculate', 'POST', origin='https://evil.example',
                                nonce=cloud_app.server.NONCE, payload=SAMPLE)[0].startswith('403'))

    def test_invalid_payload(self):
        for payload in [[], {}, dict(SAMPLE, flow_kg_h=True), dict(SAMPLE, pressure_kPa=0)]:
            self.assertTrue(request('/api/calculate', 'POST', origin=cloud_app.ORIGIN,
                                    nonce=cloud_app.server.NONCE, payload=payload)[0].startswith('400'))

    def test_error_is_not_disclosed(self):
        with patch.object(cloud_app.server, 'calculate', side_effect=RuntimeError('PRIVATE_ENGINE_DETAIL')):
            status, body = request('/api/calculate', 'POST', origin=cloud_app.ORIGIN,
                                   nonce=cloud_app.server.NONCE, payload=SAMPLE)
        self.assertTrue(status.startswith('502'))
        self.assertNotIn(b'PRIVATE_ENGINE_DETAIL', body)

    @unittest.skipUnless(REAL, 'Pass --real-engine to use existing local DWSIM')
    def test_real_engine(self):
        status, body = request('/api/calculate', 'POST', origin=cloud_app.ORIGIN,
                               nonce=cloud_app.server.NONCE, payload=SAMPLE)
        self.assertTrue(status.startswith('200'), body)
        result = json.loads(body)['results']
        self.assertAlmostEqual(result['vapor_kg_h'], 300, places=5)
        self.assertAlmostEqual(result['heat_duty_kW'], 275.28435, places=3)


if __name__ == '__main__':
    unittest.main()
