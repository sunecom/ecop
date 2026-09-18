"""Contract and replay tests for the P2 controlled material workflow."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '本地演示'))
TEMP = tempfile.TemporaryDirectory()
token_file = Path(TEMP.name) / 'test-mcp.txt'
token_file.write_text('unit-test-only', encoding='utf-8')
os.environ['DWSIM_TOKEN_FILE'] = str(token_file)
os.environ['ECOP_RUNS_DIR'] = str(Path(TEMP.name) / 'runs')

import material_systems
import server


BINARY = {
    'module': 'material_flash',
    'system': 'water_ethanol',
    'property_package': 'nrtl',
    'flow_kg_h': 1000,
    'inlet_temperature_C': 25,
    'pressure_kPa': 101.325,
    'vapor_molar_percent': 50,
    'ethanol_mass_percent': 50,
}
BINARY_TEMPLATE_XML = (
    ROOT / 'deploy' / 'models' / 'material_water_ethanol_nrtl.dwxml'
).read_text(encoding='utf-8')


def stream(flow_kg_h=1000, temperature_C=86.1343113612, pressure_kPa=101.325,
           vapor=0.4999980493281177, overall=None, overall_mole=None,
           liquid=None, liquid_mole=None, vapor_composition=None,
           vapor_mole=None, enthalpy=-721.6696584779):
    overall = overall or {'Water': 0.5, 'Ethanol': 0.5}
    overall_mole = overall_mole or {
        'Water': 0.7188789914193495, 'Ethanol': 0.2811210085806504}
    liquid = liquid or {
        'Water': 0.7603154530567194, 'Ethanol': 0.23968454694328048}
    liquid_mole = liquid_mole or {
        'Water': 0.8902519839717437, 'Ethanol': 0.10974801602825637}
    vapor_composition = vapor_composition or {
        'Water': 0.321188714028371, 'Ethanol': 0.678811285971629}
    vapor_mole = vapor_mole or {
        'Water': 0.5475046616918269, 'Ethanol': 0.4524953383081731}

    def compounds(mass, mole):
        return {name: {'mass_fraction': mass[name], 'mole_fraction': mole[name]}
                for name in mass}

    return {
        'mass_flow_kg_s': flow_kg_h / 3600,
        'molar_flow_mol_s': 10.72434298639294 * flow_kg_h / 1000,
        'temperature_K': temperature_C + 273.15,
        'pressure_Pa': pressure_kPa * 1000,
        'phases': [
            {'name': 'Mixture', 'fraction': 0, 'enthalpy_kJ_kg': enthalpy,
             'density_kg_m3': 1.8, 'compounds': compounds(overall, overall_mole)},
            {'name': 'OverallLiquid', 'fraction': 1 - vapor,
             'enthalpy_kJ_kg': -1908, 'density_kg_m3': 896,
             'compounds': compounds(liquid, liquid_mole)},
            {'name': 'Vapor', 'fraction': vapor, 'enthalpy_kJ_kg': 93,
             'density_kg_m3': 1.0, 'compounds': compounds(
                 vapor_composition, vapor_mole)},
        ],
    }


class ReplayTool:
    def __init__(self, feed=None, product=None, package='NRTL', compounds=None):
        self.feed = feed or stream(temperature_C=25, vapor=0, enthalpy=-2000)
        self.product = product or stream()
        self.package = package
        self.compounds = compounds or ['Water', 'Ethanol']
        self.calls = []

    def __call__(self, tool_name, **kwargs):
        self.calls.append((tool_name, kwargs))
        if tool_name == 'dwsim_flowsheet_get_xml':
            xml = BINARY_TEMPLATE_XML.replace(
                '<ComponentName>NRTL</ComponentName>',
                f'<ComponentName>{self.package}</ComponentName>')
            return {'xml': xml}
        if tool_name == 'dwsim_thermo_add_compounds':
            return {'added': self.compounds}
        if tool_name == 'dwsim_thermo_set_property_package':
            return {'property_package': self.package}
        if tool_name == 'dwsim_stream_get_results':
            return self.feed if kwargs['name'] == 'FEED' else self.product
        if tool_name == 'dwsim_unitop_set':
            return {'applied': kwargs['properties']}
        if tool_name == 'dwsim_flowsheet_check':
            return {'ready': True}
        if tool_name == 'dwsim_solve_run':
            return {'ok': True, 'objects': [
                {'name': 'FEED', 'calculated': True},
                {'name': 'PRODUCT', 'calculated': True},
                {'name': 'FLASH-P2', 'calculated': True},
            ]}
        if tool_name == 'dwsim_unitop_get_results':
            return {'name': 'FLASH-P2', 'calculated': True, 'properties': {}}
        return {}


class MaterialSystemTests(unittest.TestCase):
    def test_browser_contract_names_molar_basis_and_accuracy_boundary(self):
        page = (ROOT / '本地演示' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('data-module="material_flash"', page)
        self.assertIn('data-key="vapor_molar_percent"', page)
        self.assertIn('Raoult\'s Law（理想溶液对照）', page)
        self.assertIn('守恒通过不等同物性准确', page)

    def test_binary_contract_normalizes_mass_basis(self):
        values = server.validate(BINARY)
        self.assertEqual(values['composition_basis'], 'mass_fraction')
        self.assertEqual(values['composition'], {'Water': 0.5, 'Ethanol': 0.5})
        self.assertAlmostEqual(sum(values['composition'].values()), 1)

    def test_project_snapshot_remains_replayable_without_derived_fields(self):
        snapshot = server.project_inputs(BINARY)
        self.assertEqual(snapshot['system'], 'water_ethanol')
        self.assertEqual(snapshot['property_package'], 'nrtl')
        self.assertNotIn('composition', snapshot)
        self.assertNotIn('compounds', snapshot)
        replayed = server.validate(snapshot)
        self.assertEqual(replayed['composition'], {'Water': 0.5, 'Ethanol': 0.5})
        self.assertEqual(replayed['property_package'], 'NRTL')

    def test_compatibility_matrix_rejects_unsupported_selection(self):
        invalid = [
            dict(BINARY, system='industrial_wastewater'),
            dict(BINARY, property_package='steam_tables'),
            dict(BINARY, ethanol_mass_percent=0),
            dict(BINARY, ethanol_mass_percent=100),
            dict(BINARY, flow_kg_h=float('nan')),
            dict(BINARY, system='water', property_package='nrtl'),
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                server.validate(payload)

    def test_replayed_binary_result_passes_composition_and_mass_closure(self):
        values = server.validate(BINARY)
        workflow = material_systems.run(values, ReplayTool())
        self.assertAlmostEqual(workflow['results']['mass_residual_kg_h'], 0)
        self.assertAlmostEqual(
            workflow['results']['max_overall_component_mass_residual_kg_h'], 0)
        self.assertLess(
            workflow['results']['max_phase_component_mass_relative_residual'], 1e-6)
        self.assertEqual(workflow['material_system']['phase_fraction_basis'], 'molar')
        self.assertEqual(workflow['raw']['property_package_applied']['property_package'], 'NRTL')
        self.assertEqual(workflow['material_system']['feed_mass_fractions'],
                         {'Water': 0.5, 'Ethanol': 0.5})

    def test_property_package_readback_mismatch_is_rejected(self):
        values = server.validate(BINARY)
        with self.assertRaisesRegex(RuntimeError, '物性包设置后回读不一致'):
            material_systems.run(values, ReplayTool(package="Raoult's Law"))

    def test_flash_tolerance_template_mismatch_is_rejected(self):
        values = server.validate(BINARY)
        tool = ReplayTool()
        original = tool.__call__

        def tampered(tool_name, **kwargs):
            result = original(tool_name, **kwargs)
            if tool_name == 'dwsim_flowsheet_get_xml':
                result['xml'] = result['xml'].replace(
                    'PTFlash_External_Loop_Tolerance" Value="1E-08',
                    'PTFlash_External_Loop_Tolerance" Value="0.0001')
            return result

        with self.assertRaisesRegex(RuntimeError, '闪蒸精度设置不一致'):
            material_systems.run(values, tampered)

    def test_composition_and_flow_readback_mismatch_are_rejected(self):
        values = server.validate(BINARY)
        wrong_composition = stream(temperature_C=25, vapor=0,
                                   overall={'Water': 0.6, 'Ethanol': 0.4})
        with self.assertRaisesRegex(RuntimeError, '质量分数与输入不一致'):
            material_systems.run(values, ReplayTool(feed=wrong_composition))
        wrong_flow = stream(flow_kg_h=900, temperature_C=25, vapor=0)
        with self.assertRaisesRegex(RuntimeError, '总质量流量回读不一致'):
            material_systems.run(values, ReplayTool(feed=wrong_flow))

    def test_output_pressure_and_nonfinite_values_are_rejected(self):
        values = server.validate(BINARY)
        with self.assertRaisesRegex(RuntimeError, '出口压力未达到目标'):
            material_systems.run(values, ReplayTool(product=stream(pressure_kPa=90)))
        nonfinite = stream()
        nonfinite['temperature_K'] = float('nan')
        with self.assertRaisesRegex(RuntimeError, '无效数值'):
            material_systems.run(values, ReplayTool(product=nonfinite))

    def test_phase_distribution_error_is_rejected_when_overall_is_unchanged(self):
        values = server.validate(BINARY)
        molecular_weights = {'Water': 18.01528, 'Ethanol': 46.06844}
        wrong_mole = {'Water': 0.7, 'Ethanol': 0.3}
        denominator = sum(wrong_mole[name] * molecular_weights[name]
                          for name in wrong_mole)
        wrong_mass = {name: wrong_mole[name] * molecular_weights[name] / denominator
                      for name in wrong_mole}
        wrong_product = stream(
            liquid=wrong_mass, liquid_mole=wrong_mole,
            vapor_composition=wrong_mass, vapor_mole=wrong_mole)
        with self.assertRaisesRegex(RuntimeError, '重组分组分'):
            material_systems.run(values, ReplayTool(product=wrong_product))

    def test_material_failure_is_not_saved_and_flowsheet_is_closed(self):
        calls = []

        def fake_call(tool_name, **kwargs):
            calls.append((tool_name, kwargs))
            if tool_name == 'dwsim_flowsheet_load':
                return {'flowsheet_id': 'p2-fault-flow'}
            if tool_name == 'dwsim_thermo_list_property_packages':
                return {'property_packages': ['NRTL']}
            if tool_name == 'dwsim_flowsheet_close':
                return {'closed': True}
            return {}

        with tempfile.TemporaryDirectory() as run_dir, \
                patch.object(server, 'RUNS', Path(run_dir)), \
                patch.object(server, 'call', side_effect=fake_call), \
                patch.object(material_systems, 'run',
                             side_effect=RuntimeError('phase allocation fault')):
            with self.assertRaisesRegex(RuntimeError, 'phase allocation fault'):
                server.calculate(BINARY)
            self.assertEqual(list(Path(run_dir).glob('*.json')), [])
        self.assertIn(('dwsim_flowsheet_close', {'flowsheet_id': 'p2-fault-flow'}), calls)
        self.assertTrue(server.LOCK.acquire(blocking=False))
        server.LOCK.release()


if __name__ == '__main__':
    unittest.main()
