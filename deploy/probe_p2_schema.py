"""Probe P2 contracts directly against the dedicated loopback MCP engine."""
import argparse
import hashlib
import json
import math
import os
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '本地演示'))

import material_systems  # noqa: E402


PROBED_TOOLS = (
    'dwsim_thermo_list_compounds',
    'dwsim_thermo_add_compounds',
    'dwsim_thermo_list_property_packages',
    'dwsim_thermo_set_property_package',
    'dwsim_stream_add_material',
    'dwsim_stream_set_conditions',
    'dwsim_stream_get_results',
    'dwsim_unitop_set',
    'dwsim_solve_run',
)
CASES = [
    {'module': 'material_flash', 'system': 'water', 'property_package': 'steam_tables',
     'flow_kg_h': 1000, 'inlet_temperature_C': 25, 'pressure_kPa': 101.325,
     'vapor_molar_percent': 50},
    {'module': 'material_flash', 'system': 'ethanol', 'property_package': 'nrtl',
     'flow_kg_h': 1000, 'inlet_temperature_C': 25, 'pressure_kPa': 101.325,
     'vapor_molar_percent': 50},
    {'module': 'material_flash', 'system': 'ethanol', 'property_package': 'raoult',
     'flow_kg_h': 1000, 'inlet_temperature_C': 25, 'pressure_kPa': 101.325,
     'vapor_molar_percent': 50},
    {'module': 'material_flash', 'system': 'acetone', 'property_package': 'nrtl',
     'flow_kg_h': 1000, 'inlet_temperature_C': 25, 'pressure_kPa': 101.325,
     'vapor_molar_percent': 50},
    {'module': 'material_flash', 'system': 'acetone', 'property_package': 'raoult',
     'flow_kg_h': 1000, 'inlet_temperature_C': 25, 'pressure_kPa': 101.325,
     'vapor_molar_percent': 50},
    {'module': 'material_flash', 'system': 'water_ethanol', 'property_package': 'nrtl',
     'flow_kg_h': 1000, 'inlet_temperature_C': 25, 'pressure_kPa': 101.325,
     'vapor_molar_percent': 50, 'ethanol_mass_percent': 50},
    {'module': 'material_flash', 'system': 'water_ethanol', 'property_package': 'raoult',
     'flow_kg_h': 1000, 'inlet_temperature_C': 25, 'pressure_kPa': 101.325,
     'vapor_molar_percent': 50, 'ethanol_mass_percent': 50},
]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    token = parser.add_mutually_exclusive_group(required=True)
    token.add_argument('--token-file')
    token.add_argument('--token-env')
    parser.add_argument('--output', required=True)
    return parser.parse_args()


class MCPClient:
    def __init__(self, url, token):
        parsed = urlsplit(url)
        if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}:
            raise ValueError('P2 probe refuses non-loopback or non-HTTP MCP endpoints')
        if parsed.port != 15904 or parsed.path.rstrip('/') != '/mcp':
            raise ValueError('P2 probe requires the isolated loopback endpoint on port 15904')
        self.url = url
        self.token = token

    def rpc(self, method, params=None):
        payload = json.dumps({'jsonrpc': '2.0', 'id': uuid.uuid4().hex,
                              'method': method, 'params': params or {}}).encode()
        request = Request(self.url, payload, {
            'Content-Type': 'application/json', 'X-MCP-Token': self.token})
        with urlopen(request, timeout=180) as response:
            body = json.load(response)
        if 'error' in body:
            raise RuntimeError(body['error'])
        return body['result']

    def call(self, tool_name, **arguments):
        result = self.rpc('tools/call', {'name': tool_name, 'arguments': arguments})
        text = next(item['text'] for item in result.get('content', [])
                    if item['type'] == 'text')
        parsed = json.loads(text)
        if result.get('isError'):
            raise RuntimeError(parsed)
        return parsed


def number(data, name, label, low, high):
    value = data.get(name)
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise ValueError(f'{label}必须为有效数字')
    if not low <= value <= high:
        raise ValueError(f'{label}必须在 {low} 至 {high} 之间')
    return float(value)


def run_case(client, payload):
    values = material_systems.validate(payload, number)
    flowsheet_id = client.call('dwsim_flowsheet_create', name='P2 direct schema probe')[
        'flowsheet_id']
    try:
        def tool(tool_name, **arguments):
            return client.call(tool_name, flowsheet_id=flowsheet_id, **arguments)

        workflow = material_systems.run(values, tool)
        return {'flowsheet_id': flowsheet_id, 'inputs': values, **workflow}
    finally:
        closed = client.call('dwsim_flowsheet_close', flowsheet_id=flowsheet_id)
        if not closed.get('closed'):
            raise AssertionError('P2 probe flowsheet was not closed')


def main():
    args = parse_args()
    token = (Path(args.token_file).read_text(encoding='utf-8').strip()
             if args.token_file else os.environ.get(args.token_env, '').strip())
    if not token:
        raise RuntimeError('MCP token is empty')
    client = MCPClient(args.url, token)
    listed_tools = client.rpc('tools/list')['tools']
    schemas = {tool['name']: {
        'description': tool.get('description', ''),
        'inputSchema': tool.get('inputSchema', {}),
    } for tool in listed_tools if tool['name'] in PROBED_TOOLS}
    inventory_id = client.call('dwsim_flowsheet_create', name='P2 inventory probe')['flowsheet_id']
    try:
        packages = client.call(
            'dwsim_thermo_list_property_packages', flowsheet_id=inventory_id)[
                'property_packages']
        compounds = client.call('dwsim_thermo_list_compounds', flowsheet_id=inventory_id)
    finally:
        client.call('dwsim_flowsheet_close', flowsheet_id=inventory_id)
    expected_compounds = {'Water', 'Ethanol', 'Acetone'}
    if not expected_compounds.issubset(compounds['compounds']):
        raise AssertionError('Controlled compounds missing from engine inventory')
    expected_packages = {'Steam Tables (IAPWS-IF97)', 'NRTL', "Raoult's Law"}
    if not expected_packages.issubset(packages):
        raise AssertionError('Controlled property packages missing from engine inventory')
    runs = [run_case(client, payload) for payload in CASES]
    evidence = {
        'schema_version': '1.0',
        'stage': 'P2-isolated-schema-probe',
        'captured_at_epoch': int(time.time()),
        'endpoint': args.url,
        'tools_count': len(listed_tools),
        'tool_schemas': schemas,
        'inventory': {
            'compound_count': compounds.get('count', len(compounds['compounds'])),
            'controlled_compounds': sorted(expected_compounds),
            'property_package_count': len(packages),
            'controlled_property_packages': sorted(expected_packages),
        },
        'phase_fraction_basis': {
            'value': 'molar',
            'evidence': ('DWSIM phase Properties.molarfraction is returned as phase fraction; '
                         'component mass flows are independently reconstructed from molar flow, '
                         'phase mole fractions, and derived molecular weights.'),
            'source': ('https://github.com/DanWBR/dwsim/blob/windows/'
                       'DWSIM.Thermodynamics/PropertyPackages/GraysonStreed.vb'),
        },
        'runs': runs,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(evidence, ensure_ascii=False, indent=2).encode()
    output.write_bytes(encoded)
    print(json.dumps({
        'passed': True,
        'output': str(output),
        'sha256': hashlib.sha256(encoded).hexdigest(),
        'temperatures_C': [run['results']['outlet_temperature_C'] for run in runs],
        'flowsheet_ids': [run['flowsheet_id'] for run in runs],
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
