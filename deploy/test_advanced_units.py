"""Contract and replay tests for P1B advanced unit workflows."""
from copy import deepcopy
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

import advanced_units
import server


HEAT_EXCHANGER = {
    'module': 'heat_exchanger',
    'hot_flow_kg_h': 1000,
    'hot_inlet_temperature_C': 80,
    'hot_pressure_kPa': 300,
    'cold_flow_kg_h': 1200,
    'cold_inlet_temperature_C': 20,
    'cold_pressure_kPa': 300,
    'hot_outlet_temperature_C': 50,
}
COMPRESSOR = {
    'module': 'compressor',
    'flow_kg_h': 1000,
    'inlet_temperature_C': 200,
    'inlet_pressure_kPa': 200,
    'outlet_pressure_kPa': 500,
    'efficiency_percent': 75,
}
VESSEL = {
    'module': 'vessel',
    'flow_kg_h': 1000,
    'inlet_temperature_C': 25,
    'pressure_kPa': 200,
    'feed_vapor_percent': 30,
}


def stream(flow_kg_h, temperature_C, pressure_kPa, enthalpy, vapor):
    return {
        'mass_flow_kg_s': flow_kg_h / 3600,
        'temperature_K': temperature_C + 273.15,
        'pressure_Pa': pressure_kPa * 1000,
        'phases': [
            {'name': 'Mixture', 'fraction': 1.0, 'enthalpy_kJ_kg': enthalpy,
             'density_kg_m3': 997.0},
            {'name': 'Vapor', 'fraction': vapor, 'enthalpy_kJ_kg': enthalpy},
        ],
    }


class ReplayTool:
    def __init__(self, streams, units):
        self.streams = streams
        self.units = units
        self.calls = []

    def __call__(self, tool_name, **kwargs):
        self.calls.append((tool_name, kwargs))
        if tool_name == 'dwsim_stream_get_results':
            return self.streams[kwargs['name']]
        if tool_name == 'dwsim_flowsheet_check':
            return {'ready': True}
        if tool_name == 'dwsim_solve_run':
            return {'ok': True, 'objects': [
                *[{'name': name, 'calculated': True} for name in self.streams],
                *[{'name': name, 'calculated': True} for name in self.units],
            ]}
        if tool_name == 'dwsim_unitop_get_results':
            return self.units[kwargs['name']]
        if tool_name == 'dwsim_unitop_set':
            return {'applied': kwargs['properties']}
        return {}


def heat_exchanger_replay():
    streams = {
        'HOT-IN': stream(1000, 80, 300, 335.149713184984, 0),
        'HOT-OUT': stream(1000, 50, 300, 209.584291471760, 0),
        'COLD-IN': stream(1200, 20, 300, 84.2000179331161, 0),
        'COLD-OUT': stream(1200, 45.0351385585894, 300, 188.837869318250, 0),
    }
    return ReplayTool(streams, {'HX-02': {'calculated': True, 'properties': {}}})


def compressor_replay(vapor=1.0):
    streams = {
        'FEED': stream(1000, 200, 200, 2870.77928378952, vapor),
        'PRODUCT': stream(1000, 348.66287177293, 500, 3165.28658678793, 1),
    }
    unit = {'calculated': True, 'properties': {
        'Power Required': {'value': '81.80758433727483', 'units': 'kW'}}}
    return ReplayTool(streams, {'C-01': unit})


def vessel_replay():
    streams = {
        'RAW-FEED': stream(1000, 25, 200, 105.020677377917, 0),
        'TWO-PHASE': stream(1000, 120.211545936489, 200, 1165.15109428276, 0.3),
        'VAPOR': stream(300, 120.211545936489, 200, 2706.24134137426, 1),
        'LIQUID': stream(700, 120.211545936489, 200, 504.68384552926, 0),
    }
    return ReplayTool(streams, {
        'FLASH-01': {'calculated': True, 'properties': {}},
        'V-01': {'calculated': True, 'properties': {}},
    })


class AdvancedUnitTests(unittest.TestCase):
    def test_valid_contracts_are_normalized(self):
        for payload in (HEAT_EXCHANGER, COMPRESSOR, VESSEL):
            values = server.validate(payload)
            self.assertEqual(values['module'], payload['module'])

    def test_heat_exchanger_rejects_crossed_or_unbounded_specification(self):
        invalid = [
            dict(HEAT_EXCHANGER, cold_inlet_temperature_C=78),
            dict(HEAT_EXCHANGER, hot_outlet_temperature_C=79),
            dict(HEAT_EXCHANGER, hot_outlet_temperature_C=21),
            dict(HEAT_EXCHANGER, hot_flow_kg_h=float('nan')),
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                server.validate(payload)

    def test_compressor_and_vessel_contract_boundaries(self):
        invalid = [
            dict(COMPRESSOR, outlet_pressure_kPa=210),
            dict(COMPRESSOR, efficiency_percent=100),
            dict(VESSEL, feed_vapor_percent=0),
            dict(VESSEL, feed_vapor_percent=float('inf')),
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                server.validate(payload)

    def test_replayed_real_results_pass_all_closure_checks(self):
        hx = advanced_units.run_heat_exchanger(HEAT_EXCHANGER, heat_exchanger_replay())
        compressor = advanced_units.run_compressor(COMPRESSOR, compressor_replay())
        vessel = advanced_units.run_vessel(VESSEL, vessel_replay())
        self.assertLess(hx['results']['heat_balance_relative'], 1e-4)
        self.assertLess(compressor['results']['power_residual_relative'], 1e-4)
        self.assertAlmostEqual(vessel['results']['vapor_product_kg_h'], 300, places=6)

    def test_compressor_rejects_liquid_result(self):
        tool = compressor_replay(vapor=0)
        with self.assertRaisesRegex(ValueError, '仅接受纯水蒸汽'):
            advanced_units.run_compressor(COMPRESSOR, tool)

    def test_each_workflow_rejects_nonfinite_engine_results(self):
        cases = [
            (advanced_units.run_heat_exchanger, HEAT_EXCHANGER, heat_exchanger_replay,
             lambda tool, value: tool.streams['HOT-OUT']['phases'][0].update(
                 enthalpy_kJ_kg=value)),
            (advanced_units.run_compressor, COMPRESSOR, compressor_replay,
             lambda tool, value: tool.streams['PRODUCT'].update(temperature_K=value)),
            (advanced_units.run_vessel, VESSEL, vessel_replay,
             lambda tool, value: tool.streams['VAPOR'].update(mass_flow_kg_s=value)),
        ]
        for runner, values, replay, inject in cases:
            for value in (float('nan'), float('inf'), float('-inf')):
                tool = replay()
                inject(tool, value)
                with self.subTest(runner=runner.__name__, value=value), \
                        self.assertRaisesRegex(RuntimeError, '无效数值'):
                    runner(values, tool)


if __name__ == '__main__':
    unittest.main()
