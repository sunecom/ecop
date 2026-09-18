"""Run locally without Docker; uses mocks except the optional real-engine test."""
import base64
import io
import json
import os
from pathlib import Path
import sqlite3
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
os.environ['ECOP_PROJECTS_DIR'] = str(Path(TEMP.name) / 'projects')
import cloud_app

SAMPLE = {'module': 'evaporation', 'flow_kg_h': 1000, 'temperature_C': 25,
          'pressure_kPa': 101.325, 'vapor_percent': 30}
TEMPERATURE_SAMPLE = {'module': 'temperature', 'flow_kg_h': 1000,
                      'inlet_temperature_C': 25, 'pressure_kPa': 101.325,
                      'outlet_temperature_C': 60}
PUMP_SAMPLE = {'module': 'pump', 'flow_kg_h': 1000, 'inlet_temperature_C': 25,
               'inlet_pressure_kPa': 101.325, 'outlet_pressure_kPa': 500,
               'efficiency_percent': 75}
VESSEL_SAMPLE = {'module': 'vessel', 'flow_kg_h': 1000, 'inlet_temperature_C': 25,
                 'pressure_kPa': 280, 'feed_vapor_percent': 30}
MIXER_SAMPLE = {'module': 'mixer', 'feed1_flow_kg_h': 400,
                'feed1_temperature_C': 25, 'feed1_pressure_kPa': 200,
                'feed2_flow_kg_h': 600, 'feed2_temperature_C': 55,
                'feed2_pressure_kPa': 200}


def request(path='/', method='GET', authenticated=True, origin=None, nonce=None, payload=None, host=None,
            query='', with_headers=False):
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
    response = (state['status'], result)
    return (*response, state['headers']) if with_headers else response


class CloudTests(unittest.TestCase):
    def test_auth_all_business_routes(self):
        for path in ['/', '/logo.png', '/ecop-logo.jpg', '/api/status', '/api/catalog', '/api/compounds',
                     '/project_ui.js', '/api/calculate', '/api/projects']:
            self.assertTrue(request(path, authenticated=False)[0].startswith('401'))

    def test_health_and_page(self):
        self.assertTrue(request('/healthz', authenticated=False)[0].startswith('200'))
        status, body = request()
        self.assertTrue(status.startswith('200'))
        self.assertIn('云端受控验证'.encode(), body)
        self.assertIn(b'/ecop-logo.jpg', body)
        for module in [b'mixer', b'splitter', b'valve', b'heat_exchanger', b'compressor', b'vessel']:
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

    def test_advanced_pressure_failure_is_controlled_not_saved_and_cleaned_up(self):
        engine_calls = []

        def fake_call(tool_name, **kwargs):
            engine_calls.append((tool_name, kwargs))
            if tool_name == 'dwsim_flowsheet_create':
                return {'flowsheet_id': 'pressure-fault-flow'}
            if tool_name == 'dwsim_thermo_list_property_packages':
                return {'property_packages': ['Steam Tables (IAPWS-IF97)']}
            if tool_name == 'dwsim_flowsheet_close':
                return {'closed': True}
            return {}

        with tempfile.TemporaryDirectory() as run_dir, \
                patch.object(cloud_app.server, 'RUNS', Path(run_dir)), \
                patch.object(cloud_app.server, 'call', side_effect=fake_call), \
                patch.object(cloud_app.server.advanced_units, 'run',
                             side_effect=RuntimeError('Vessel 压力错配')):
            status, body = request('/api/calculate', 'POST', origin=cloud_app.ORIGIN,
                                   nonce=cloud_app.server.NONCE, payload=VESSEL_SAMPLE)
            self.assertEqual(list(Path(run_dir).glob('*.json')), [])
        self.assertTrue(status.startswith('502'))
        self.assertEqual(json.loads(body), {'error': '计算未成功，请联系管理员查看服务日志'})
        self.assertIn(('dwsim_flowsheet_close', {'flowsheet_id': 'pressure-fault-flow'}),
                      engine_calls)

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

    def test_project_lifecycle_persists_and_downloads_mapped_dwsim(self):
        write_headers = {'origin': cloud_app.ORIGIN, 'nonce': cloud_app.server.NONCE}
        status, body = request(
            '/api/projects', 'POST', payload={'name': 'P3 API 项目'}, **write_headers)
        self.assertTrue(status.startswith('201'), body)
        project = json.loads(body)['project']
        status, body = request(
            f"/api/projects/{project['id']}/cases", 'POST',
            payload={'name': '基准工况', 'inputs': SAMPLE}, **write_headers)
        self.assertTrue(status.startswith('201'), body)
        case = json.loads(body)['case']
        version = case['versions'][0]

        def fake_calculate(inputs, export_path=None, persist_result=True):
            self.assertEqual(inputs, SAMPLE)
            self.assertIsNotNone(export_path)
            self.assertFalse(persist_result)
            Path(export_path).write_text('<DWSIM project="p3" />', encoding='utf-8')
            return {
                'run_id': '1' * 32, 'time': '2026-09-19 03:00:00',
                'module': {'id': 'evaporation', 'name': '目标汽化计算',
                           'unit_operation': 'Heater'},
                'inputs': SAMPLE, 'engine': 'DWSIM 10.2.8', 'commit': 'test-build',
                'property_package': 'Steam Tables (IAPWS-IF97)',
                'results': {'heat_duty_kW': 200.0},
                'comparison': {'metric': 'heat_duty_kW', 'label': '热负荷',
                               'unit': 'kW', 'value': 200.0},
                'raw': {'solve': {'ok': True}},
            }

        with patch.object(cloud_app.server, 'calculate', side_effect=fake_calculate):
            status, body = request(
                f"/api/case-versions/{version['id']}/calculate", 'POST',
                payload={}, **write_headers)
        self.assertTrue(status.startswith('200'), body)
        record = json.loads(body)['record']
        self.assertNotIn(str(Path(TEMP.name)), body.decode())
        self.assertRegex(record['export']['id'], r'^exp_[0-9a-f]{32}$')

        status, body = request(f"/api/projects/{project['id']}")
        self.assertTrue(status.startswith('200'), body)
        opened = json.loads(body)['project']
        self.assertEqual(opened['cases'][0]['versions'][0]['records'][0]['run_id'], '1' * 32)

        status, body, headers = request(
            f"/api/exports/{record['export']['id']}", with_headers=True)
        self.assertTrue(status.startswith('200'), body)
        self.assertEqual(body, b'<DWSIM project="p3" />')
        self.assertEqual(headers['Content-Type'], 'application/xml')
        self.assertIn('.dwxml', headers['Content-Disposition'])

    def test_project_writes_require_origin_and_nonce(self):
        for origin, nonce in ((None, None), ('https://evil.example', cloud_app.server.NONCE),
                              (cloud_app.ORIGIN, 'wrong')):
            with self.subTest(origin=origin, nonce=nonce):
                status, _ = request('/api/projects', 'POST', origin=origin, nonce=nonce,
                                    payload={'name': 'blocked'})
                self.assertTrue(status.startswith('403'))

    def test_invalid_project_and_export_ids_are_rejected_without_path_access(self):
        for path in ('/api/projects/../secret', '/api/exports/../secret',
                     '/api/exports/%2e%2e%2fsecret', '/api/exports/not-an-id'):
            with self.subTest(path=path):
                status, body = request(path)
                self.assertIn(status.split()[0], {'400', '404'})
                self.assertNotIn(str(Path(TEMP.name)).encode(), body)

    def test_failed_project_calculation_removes_partial_export(self):
        write_headers = {'origin': cloud_app.ORIGIN, 'nonce': cloud_app.server.NONCE}
        project = json.loads(request(
            '/api/projects', 'POST', payload={'name': '失败清理项目'},
            **write_headers)[1])['project']
        case = json.loads(request(
            f"/api/projects/{project['id']}/cases", 'POST',
            payload={'name': '失败工况', 'inputs': SAMPLE}, **write_headers)[1])['case']

        def fail_after_partial(inputs, export_path=None, persist_result=True):
            self.assertFalse(persist_result)
            Path(export_path).write_text('<partial>', encoding='utf-8')
            raise RuntimeError('PRIVATE_EXPORT_PATH')

        with patch.object(cloud_app.server, 'calculate', side_effect=fail_after_partial):
            status, body = request(
                f"/api/case-versions/{case['versions'][0]['id']}/calculate", 'POST',
                payload={}, **write_headers)
        self.assertTrue(status.startswith('502'))
        self.assertNotIn(b'PRIVATE_EXPORT_PATH', body)
        export_files = list(Path(os.environ['ECOP_PROJECTS_DIR']).rglob('*.dwxml'))
        self.assertEqual([path for path in export_files if path.read_text() == '<partial>'], [])

    def test_project_database_failure_leaves_no_legacy_run_or_export(self):
        write_headers = {'origin': cloud_app.ORIGIN, 'nonce': cloud_app.server.NONCE}
        project = json.loads(request(
            '/api/projects', 'POST', payload={'name': '数据库故障项目'},
            **write_headers)[1])['project']
        case = json.loads(request(
            f"/api/projects/{project['id']}/cases", 'POST',
            payload={'name': '数据库故障工况', 'inputs': SAMPLE}, **write_headers)[1])['case']
        run_id = '2' * 32
        exports_before = set(Path(os.environ['ECOP_PROJECTS_DIR']).rglob('*.dwxml'))

        def calculated_but_not_persisted(inputs, export_path=None, persist_result=True):
            self.assertEqual(inputs, SAMPLE)
            self.assertFalse(persist_result)
            Path(export_path).write_text('<DWSIM calculated="true" />', encoding='utf-8')
            return {
                'run_id': run_id, 'time': '2026-09-19 04:00:00',
                'module': {'id': 'evaporation', 'name': '目标汽化计算',
                           'unit_operation': 'Heater'},
                'inputs': SAMPLE, 'engine': 'DWSIM 10.2.8', 'commit': 'test-build',
                'property_package': 'Steam Tables (IAPWS-IF97)',
                'results': {'heat_duty_kW': 200.0},
                'comparison': {'metric': 'heat_duty_kW', 'label': '热负荷',
                               'unit': 'kW', 'value': 200.0},
                'raw': {'solve': {'ok': True}},
            }

        with patch.object(cloud_app.server, 'calculate', side_effect=calculated_but_not_persisted), \
                patch.object(cloud_app.PROJECT_STORE, 'record_calculation',
                             side_effect=sqlite3.OperationalError('injected database fault')):
            status, body = request(
                f"/api/case-versions/{case['versions'][0]['id']}/calculate", 'POST',
                payload={}, **write_headers)

        self.assertTrue(status.startswith('502'), body)
        self.assertFalse((cloud_app.server.RUNS / f'{run_id}.json').exists())
        self.assertEqual(set(Path(os.environ['ECOP_PROJECTS_DIR']).rglob('*.dwxml')),
                         exports_before)
        opened = json.loads(request(f"/api/projects/{project['id']}")[1])['project']
        self.assertEqual(opened['cases'][0]['versions'][0]['records'], [])

    def test_server_saves_dwsim_export_before_flowsheet_close(self):
        calls = []
        workflow = {
            'results': {'outlet_flow_kg_h': 1000.0},
            'comparison': {'metric': 'outlet_flow_kg_h', 'label': '出口流量',
                           'unit': 'kg/h', 'value': 1000.0},
            'raw': {'solve': {'ok': True}},
        }
        with tempfile.TemporaryDirectory() as directory:
            export_path = Path(directory) / 'controlled.dwxml'

            def fake_call(tool_name, **kwargs):
                calls.append(tool_name)
                if tool_name == 'dwsim_flowsheet_create':
                    return {'flowsheet_id': 'export-flow'}
                if tool_name == 'dwsim_thermo_list_property_packages':
                    return {'property_packages': ['Steam Tables (IAPWS-IF97)']}
                if tool_name == 'dwsim_flowsheet_save':
                    Path(kwargs['filepath']).write_text('<DWSIM saved="true" />', encoding='utf-8')
                    return {'saved': kwargs['filepath']}
                if tool_name == 'dwsim_flowsheet_close':
                    return {'closed': True}
                return {}

            with patch.object(cloud_app.server, 'call', side_effect=fake_call), \
                    patch.object(cloud_app.server.basic_units, 'run', return_value=workflow), \
                    patch.object(cloud_app.server, 'RUNS', Path(directory) / 'runs'):
                result = cloud_app.server.calculate(MIXER_SAMPLE, export_path=export_path)
            self.assertEqual(result['comparison']['value'], 1000.0)
            self.assertEqual(export_path.read_text(encoding='utf-8'), '<DWSIM saved="true" />')
            self.assertLess(calls.index('dwsim_flowsheet_save'),
                            calls.index('dwsim_flowsheet_close'))
            self.assertTrue((Path(directory) / 'runs' / f"{result['run_id']}.json").is_file())

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
