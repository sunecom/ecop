"""Discriminating contract and replay tests for the P4 serial flowsheet."""
import os
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '本地演示'))
TEMP = tempfile.TemporaryDirectory()
token_file = Path(TEMP.name) / 'test-mcp.txt'
token_file.write_text('unit-test-only', encoding='utf-8')
os.environ['DWSIM_TOKEN_FILE'] = str(token_file)
os.environ['ECOP_RUNS_DIR'] = str(Path(TEMP.name) / 'runs')

import p4_serial
import server


SAMPLE = {
    'module': 'preheat_evap_separator',
    'flow_kg_h': 1000,
    'feed_temperature_C': 25,
    'pressure_kPa': 101.325,
    'preheat_temperature_C': 70,
    'vapor_percent': 30,
}


def stream(flow_kg_h, temperature_C, pressure_kPa, enthalpy, vapor):
    return {
        'mass_flow_kg_s': flow_kg_h / 3600,
        'temperature_K': temperature_C + 273.15,
        'pressure_Pa': pressure_kPa * 1000,
        'phases': [
            {'name': 'Mixture', 'fraction': 1.0, 'enthalpy_kJ_kg': enthalpy},
            {'name': 'Vapor', 'fraction': vapor, 'enthalpy_kJ_kg': enthalpy},
        ],
    }


class ReplayTool:
    def __init__(self):
        self.streams = {
            'FEED': stream(1000, 25, 101.325, 104.92, 0),
            'PREHEATED': stream(1000, 70, 101.325, 293.066, 0),
            'TWO-PHASE': stream(1000, 99.974, 101.325, 1095.943, 0.3),
            'VAPOR': stream(300, 99.974, 101.325, 2675.57, 1),
            'LIQUID': stream(700, 99.974, 101.325, 418.96, 0),
        }
        self.units = {name: {'calculated': True} for name in ('H-01', 'EV-01', 'V-01')}
        self.calls = []
        self.solve_ok = True
        self.preheat_guard = False
        self.guard_vapor_fraction = 0

    def __call__(self, tool_name, **kwargs):
        self.calls.append((tool_name, kwargs))
        if tool_name == 'dwsim_stream_get_results':
            if kwargs['name'] == 'PREHEATED' and self.preheat_guard:
                return stream(1000, 72, 101.325, 301.43, self.guard_vapor_fraction)
            return self.streams[kwargs['name']]
        if tool_name == 'dwsim_flowsheet_check':
            return {'ready': True}
        if tool_name == 'dwsim_solve_run':
            return {'ok': self.solve_ok, 'objects': [
                *[{'name': name, 'calculated': True} for name in self.streams],
                *[{'name': name, 'calculated': True} for name in self.units],
            ]}
        if tool_name == 'dwsim_unitop_get_results':
            return self.units[kwargs['name']]
        if tool_name == 'dwsim_unitop_set':
            if kwargs['name'] == 'H-01':
                self.preheat_guard = kwargs['properties']['OutletTemperature'] > 343.15
            return {'applied': kwargs['properties']}
        return {}


class P4SerialTests(unittest.TestCase):
    def test_contract_normalizes_and_rejects_invalid_bounds(self):
        self.assertEqual(server.validate(SAMPLE)['module'], SAMPLE['module'])
        invalid = [
            dict(SAMPLE, preheat_temperature_C=26),
            dict(SAMPLE, vapor_percent=81),
            dict(SAMPLE, pressure_kPa=50),
            dict(SAMPLE, flow_kg_h=float('nan')),
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                server.validate(payload)

    def test_serial_topology_uses_guard_and_final_solve_with_closure_evidence(self):
        tool = ReplayTool()
        result = p4_serial.run(server.validate(SAMPLE), tool)
        connections = [kwargs for name, kwargs in tool.calls if name == 'dwsim_unitop_connect']
        self.assertEqual(sum(name == 'dwsim_solve_run' for name, _ in tool.calls), 2)
        self.assertEqual([item['unitop'] for item in connections], ['H-01', 'EV-01', 'V-01', 'V-01'])
        self.assertAlmostEqual(result['results']['preheat_heat_duty_kW'], 52.26277777777778)
        self.assertAlmostEqual(result['results']['vapor_product_kg_h'], 300)
        self.assertLess(result['results']['vessel_energy_residual_relative'], 1e-4)
        self.assertEqual(result['raw']['topology'],
                         'FEED -> H-01 -> PREHEATED -> EV-01 -> TWO-PHASE -> V-01 -> VAPOR + LIQUID')
        self.assertEqual(set(result['raw']['streams']),
                         {'FEED', 'PREHEATED', 'TWO-PHASE', 'VAPOR', 'LIQUID'})

    def test_rejects_preheat_that_enters_vapor_region(self):
        tool = ReplayTool()
        tool.guard_vapor_fraction = 0.001
        with self.assertRaisesRegex(RuntimeError, '泡点至少 2 °C 裕量'):
            p4_serial.run(server.validate(SAMPLE), tool)

    def test_rejects_failed_solve_or_nonfinite_result(self):
        tool = ReplayTool()
        tool.solve_ok = False
        with self.assertRaisesRegex(RuntimeError, '引擎求解失败'):
            p4_serial.run(server.validate(SAMPLE), tool)
        tool = ReplayTool()
        tool.streams['TWO-PHASE']['phases'][0]['enthalpy_kJ_kg'] = float('nan')
        with self.assertRaisesRegex(RuntimeError, '无效数值'):
            p4_serial.run(server.validate(SAMPLE), tool)


if __name__ == '__main__':
    unittest.main()
