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

SAMPLE = {'module': 'evaporation', 'flow_kg_h': 1000, 'temperature_C': 25,
          'pressure_kPa': 101.325, 'vapor_percent': 30}
TEMPERATURE_SAMPLE = {'module': 'temperature', 'flow_kg_h': 1000,
                      'inlet_temperature_C': 25, 'pressure_kPa': 101.325,
                      'outlet_temperature_C': 60}
PUMP_SAMPLE = {'module': 'pump', 'flow_kg_h': 1000, 'inlet_temperature_C': 25,
               'inlet_pressure_kPa': 101.325, 'outlet_pressure_kPa': 500,
               'efficiency_percent': 75}


def request(path='/', method='GET', authenticated=True, origin=None, nonce=None, payload=None, host=None,
            query=''):
    body = json.dumps(payload).encode() if payload is not None else b''
    env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': query,
           'CONTENT_LENGTH': str(len(body)),
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
        for path in ['/', '/logo.png', '/ecop-logo.jpg', '/api/status', '/api/catalog', '/api/compounds',
                     '/api/calculate']:
            self.assertTrue(request(path, authenticated=False)[0].startswith('401'))

    def test_health_and_page(self):
        self.assertTrue(request('/healthz', authenticated=False)[0].startswith('200'))
        status, body = request()
        self.assertTrue(status.startswith('200'))
        self.assertIn('云端受控验证'.encode(), body)
        self.assertIn(b'/ecop-logo.jpg', body)
        for module in [b'mixer', b'splitter', b'valve']:
            self.assertIn(b'data-module="' + module + b'"', body)
        self.assertNotIn(b'__NONCE__', body)
        logo_status, logo = request('/ecop-logo.jpg')
        self.assertTrue(logo_status.startswith('200'))
        self.assertTrue(logo.startswith(b'\xff\xd8'))
        self.assertTrue(request(host='evil.example')[0].startswith('400'))

    def test_cross_site_blocked(self):
        self.assertTrue(request('/api/calculate', 'POST', origin='https://evil.example',
                                nonce=cloud_app.server.NONCE, payload=SAMPLE)[0].startswith('403'))

    def test_invalid_payload(self):
        for payload in [[], {}, dict(SAMPLE, flow_kg_h=True), dict(SAMPLE, pressure_kPa=0)]:
            self.assertTrue(request('/api/calculate', 'POST', origin=cloud_app.ORIGIN,
                                    nonce=cloud_app.server.NONCE, payload=payload)[0].startswith('400'))
        invalid_modules = [
            dict(TEMPERATURE_SAMPLE, outlet_temperature_C=25),
            dict(PUMP_SAMPLE, outlet_pressure_kPa=100),
            dict(PUMP_SAMPLE, efficiency_percent=101),
            dict(SAMPLE, module='not-allowed'),
        ]
        for payload in invalid_modules:
            self.assertTrue(request('/api/calculate', 'POST', origin=cloud_app.ORIGIN,
                                    nonce=cloud_app.server.NONCE, payload=payload)[0].startswith('400'))

    def test_error_is_not_disclosed(self):
        with patch.object(cloud_app.server, 'calculate', side_effect=RuntimeError('PRIVATE_ENGINE_DETAIL')):
            status, body = request('/api/calculate', 'POST', origin=cloud_app.ORIGIN,
                                   nonce=cloud_app.server.NONCE, payload=SAMPLE)
        self.assertTrue(status.startswith('502'))
        self.assertNotIn(b'PRIVATE_ENGINE_DETAIL', body)

    def test_nonfinite_success_response_becomes_controlled_error(self):
        for value in (float('nan'), float('inf'), float('-inf')):
            with self.subTest(value=value), patch.object(
                    cloud_app.server, 'calculate', return_value={'result': value}):
                status, body = request('/api/calculate', 'POST', origin=cloud_app.ORIGIN,
                                       nonce=cloud_app.server.NONCE, payload=SAMPLE)
            self.assertTrue(status.startswith('502'))
            self.assertEqual(json.loads(body), {'error': '计算未成功，请联系管理员查看服务日志'})

    def test_catalog_is_read_only_curated_data(self):
        sample = {'ok': True, 'counts': {'mcp_tools': 48, 'unit_operations': 44}}
        with patch.object(cloud_app.server, 'get_catalog', return_value=sample):
            status, body = request('/api/catalog')
        self.assertTrue(status.startswith('200'))
        self.assertEqual(json.loads(body), sample)

    def test_compound_search_is_bounded(self):
        sample = {'ok': True, 'query': 'water', 'matches': ['Water'], 'match_count': 1, 'limit': 20}
        with patch.object(cloud_app.server, 'search_compounds', return_value=sample) as search:
            status, body = request('/api/compounds', query='q=water')
        self.assertTrue(status.startswith('200'))
        self.assertEqual(json.loads(body), sample)
        search.assert_called_once_with('water')

    @unittest.skipUnless(REAL, 'Pass --real-engine to use existing local DWSIM')
    def test_real_engine(self):
        cases = [
            (SAMPLE, 'heat_duty_kW'),
            (dict(SAMPLE, vapor_percent=60), 'heat_duty_kW'),
            (TEMPERATURE_SAMPLE, 'heat_duty_kW'),
            (dict(TEMPERATURE_SAMPLE, inlet_temperature_C=60, outlet_temperature_C=25), 'heat_duty_kW'),
            (PUMP_SAMPLE, 'shaft_power_kW'),
            (dict(PUMP_SAMPLE, outlet_pressure_kPa=900), 'shaft_power_kW'),
        ]
        values = []
        for payload, metric in cases:
            status, body = request('/api/calculate', 'POST', origin=cloud_app.ORIGIN,
                                   nonce=cloud_app.server.NONCE, payload=payload)
            self.assertTrue(status.startswith('200'), body)
            data = json.loads(body)
            self.assertEqual(data['comparison']['metric'], metric)
            self.assertAlmostEqual(data['results']['mass_residual_kg_h'], 0, places=6)
            values.append(data['comparison']['value'])
        self.assertAlmostEqual(json.loads(request('/api/calculate', 'POST', origin=cloud_app.ORIGIN,
                                                   nonce=cloud_app.server.NONCE,
                                                   payload=SAMPLE)[1])['results']['vapor_kg_h'], 300, places=5)
        self.assertGreater(values[1], values[0])
        self.assertGreater(values[2], 0)
        self.assertLess(values[3], 0)
        self.assertGreater(values[5], values[4])


if __name__ == '__main__':
    unittest.main()
