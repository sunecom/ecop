"""Contract and validation tests for the P1A basic-unit workflows."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from copy import deepcopy
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '本地演示'))
TEMP = tempfile.TemporaryDirectory()
token_file = Path(TEMP.name) / 'test-mcp.txt'
token_file.write_text('unit-test-only', encoding='utf-8')
os.environ['DWSIM_TOKEN_FILE'] = str(token_file)
os.environ['ECOP_RUNS_DIR'] = str(Path(TEMP.name) / 'runs')

import server
import catalog


MIXER = {
    'module': 'mixer',
    'feed1_flow_kg_h': 400,
    'feed1_temperature_C': 25,
    'feed1_pressure_kPa': 200,
    'feed2_flow_kg_h': 600,
    'feed2_temperature_C': 55,
    'feed2_pressure_kPa': 200,
}
SPLITTER = {
    'module': 'splitter',
    'flow_kg_h': 1000,
    'temperature_C': 35,
    'pressure_kPa': 250,
    'outlet1_percent': 30,
}
VALVE = {
    'module': 'valve',
    'flow_kg_h': 1000,
    'inlet_temperature_C': 25,
    'inlet_pressure_kPa': 500,
    'outlet_pressure_kPa': 200,
}


def stream(flow_kg_h, temperature_C, pressure_kPa, enthalpy_kJ_kg, vapor=0.0):
    return {
        'mass_flow_kg_s': flow_kg_h / 3600,
        'temperature_K': temperature_C + 273.15,
        'pressure_Pa': pressure_kPa * 1000,
        'phases': [
            {'name': 'Mixture', 'fraction': 1.0,
             'enthalpy_kJ_kg': enthalpy_kJ_kg, 'density_kg_m3': 997.0},
            {'name': 'Vapor', 'fraction': vapor, 'enthalpy_kJ_kg': enthalpy_kJ_kg},
        ],
    }


class ReplayTool:
    def __init__(self, streams, unit_name):
        self.streams = streams
        self.unit_name = unit_name

    def __call__(self, tool_name, **kwargs):
        if tool_name == 'dwsim_stream_get_results':
            return self.streams[kwargs['name']]
        if tool_name == 'dwsim_flowsheet_check':
            return {'ready': True}
        if tool_name == 'dwsim_solve_run':
            return {'ok': True, 'objects': [
                {'name': name, 'calculated': True}
                for name in [*self.streams, self.unit_name]
            ]}
        if tool_name == 'dwsim_unitop_get_results':
            return {'name': self.unit_name, 'calculated': True}
        if tool_name == 'dwsim_unitop_set':
            return {'applied': kwargs.get('properties', {})}
        return {}


class BasicUnitContractTests(unittest.TestCase):
    def test_valid_contracts_are_normalized(self):
        for payload in (MIXER, SPLITTER, VALVE):
            values = server.validate(payload)
            self.assertEqual(values['module'], payload['module'])
            self.assertTrue(all(not isinstance(value, bool) for value in values.values()))

    def test_mixer_rejects_missing_bool_nonfinite_and_pressure_mismatch(self):
        invalid = [
            {'module': 'mixer'},
            dict(MIXER, feed1_flow_kg_h=True),
            dict(MIXER, feed1_flow_kg_h=float('nan')),
            dict(MIXER, feed2_pressure_kPa=200.101),
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                server.validate(payload)

    def test_splitter_rejects_invalid_ratio(self):
        for ratio in (0, 100, -1, 101, float('inf')):
            with self.subTest(ratio=ratio), self.assertRaises(ValueError):
                server.validate(dict(SPLITTER, outlet1_percent=ratio))

    def test_valve_requires_real_pressure_drop(self):
        for outlet in (500, 600, 495):
            with self.subTest(outlet=outlet), self.assertRaises(ValueError):
                server.validate(dict(VALVE, outlet_pressure_kPa=outlet))

    def test_unknown_module_stays_rejected(self):
        with self.assertRaises(ValueError):
            server.validate({'module': 'arbitrary-unit-operation'})

    def test_catalog_exposes_exactly_six_live_unit_types(self):
        groups = catalog.build_unit_groups([
            'Mixer', 'Splitter', 'Heater', 'Cooler', 'Pump', 'Valve', 'Pipe'])
        live = {module['type'] for group in groups for module in group['modules']
                if module['state'] == 'live'}
        self.assertEqual(live, {'Mixer', 'Splitter', 'Heater', 'Cooler', 'Pump', 'Valve'})

    def test_engine_nonfinite_values_are_rejected_by_all_new_workflows(self):
        mixer_streams = {
            'FEED-1': stream(400, 25, 200, 100),
            'FEED-2': stream(600, 55, 200, 200),
            'PRODUCT': stream(1000, 43, 200, 160),
        }
        splitter_streams = {
            'FEED': stream(1000, 35, 250, 120),
            'PRODUCT-1': stream(300, 35, 250, 120),
            'PRODUCT-2': stream(700, 35, 250, 120),
        }
        valve_streams = {
            'FEED': stream(1000, 25, 500, 105),
            'PRODUCT': stream(1000, 25.1, 200, 105),
        }
        cases = [
            ('mixer', server.basic_units.run_mixer, MIXER, mixer_streams, 'MIX-01',
             lambda streams, value: streams['PRODUCT']['phases'][0].update(
                 enthalpy_kJ_kg=value)),
            ('splitter', server.basic_units.run_splitter, SPLITTER, splitter_streams, 'SPL-01',
             lambda streams, value: streams['PRODUCT-1'].update(mass_flow_kg_s=value)),
            ('valve', server.basic_units.run_valve, VALVE, valve_streams, 'VLV-01',
             lambda streams, value: streams['PRODUCT']['phases'][0].update(
                 enthalpy_kJ_kg=value)),
        ]
        for label, runner, values, valid_streams, unit_name, inject in cases:
            for value in (float('nan'), float('inf'), float('-inf')):
                with self.subTest(module=label, value=value):
                    streams = deepcopy(valid_streams)
                    inject(streams, value)
                    with self.assertRaisesRegex(RuntimeError, '无效数值'):
                        runner(values, ReplayTool(streams, unit_name))

    def test_nonfinite_result_is_not_saved_and_resources_are_released(self):
        for value in (float('nan'), float('inf'), float('-inf')):
            calls = []

            def fake_call(tool_name, **kwargs):
                calls.append((tool_name, kwargs))
                if tool_name == 'dwsim_flowsheet_create':
                    return {'flowsheet_id': 'fault-test'}
                if tool_name == 'dwsim_thermo_list_property_packages':
                    return {'property_packages': ['Steam Tables']}
                return {}

            workflow = {
                'results': {'outlet_flow_kg_h': value},
                'comparison': {'metric': 'outlet_flow_kg_h', 'label': '流量',
                               'unit': 'kg/h', 'value': value},
                'raw': {'injected': value},
            }
            before = set(server.RUNS.glob('*.json')) if server.RUNS.exists() else set()
            with self.subTest(value=value), patch.object(server, 'call', side_effect=fake_call), \
                    patch.object(server.basic_units, 'run', return_value=workflow):
                with self.assertRaisesRegex(RuntimeError, '非有限数值'):
                    server.calculate(MIXER)
            after = set(server.RUNS.glob('*.json')) if server.RUNS.exists() else set()
            self.assertEqual(after, before)
            self.assertTrue(any(name == 'dwsim_flowsheet_close' for name, _ in calls))
            self.assertTrue(server.LOCK.acquire(blocking=False))
            server.LOCK.release()


if __name__ == '__main__':
    unittest.main()
