"""Contract and validation tests for the P1A basic-unit workflows."""
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


if __name__ == '__main__':
    unittest.main()
