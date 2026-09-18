"""Probe P1B contracts against the dedicated loopback MCP candidate engine."""
import argparse
import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '本地演示'))

import advanced_units  # noqa: E402


PROPERTY_PACKAGE = 'Steam Tables (IAPWS-IF97)'
PROBED_TOOLS = (
    'dwsim_stream_add_material',
    'dwsim_stream_get_results',
    'dwsim_stream_set_conditions',
    'dwsim_unitop_add',
    'dwsim_unitop_connect',
    'dwsim_unitop_set',
    'dwsim_unitop_get_results',
    'dwsim_flowsheet_check',
    'dwsim_solve_run',
)
CASES = {
    'HeatExchanger': {
        'module': 'heat_exchanger',
        'hot_flow_kg_h': 1000,
        'hot_inlet_temperature_C': 80,
        'hot_pressure_kPa': 300,
        'cold_flow_kg_h': 1200,
        'cold_inlet_temperature_C': 20,
        'cold_pressure_kPa': 300,
        'hot_outlet_temperature_C': 50,
    },
    'Compressor': {
        'module': 'compressor',
        'flow_kg_h': 1000,
        'inlet_temperature_C': 200,
        'inlet_pressure_kPa': 200,
        'outlet_pressure_kPa': 500,
        'efficiency_percent': 75,
    },
    'Vessel': {
        'module': 'vessel',
        'flow_kg_h': 1000,
        'inlet_temperature_C': 25,
        'pressure_kPa': 200,
        'feed_vapor_percent': 30,
    },
}


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
            raise ValueError('P1B probe refuses non-loopback or non-HTTP MCP endpoints')
        if parsed.port != 15903 or parsed.path.rstrip('/') != '/mcp':
            raise ValueError('P1B probe requires the isolated loopback endpoint on port 15903')
        self.url = url
        self.token = token

    def rpc(self, method, params=None):
        payload = json.dumps({
            'jsonrpc': '2.0',
            'id': uuid.uuid4().hex,
            'method': method,
            'params': params or {},
        }).encode()
        request = Request(self.url, payload, {
            'Content-Type': 'application/json',
            'X-MCP-Token': self.token,
        })
        with urlopen(request, timeout=180) as response:
            body = json.load(response)
        if 'error' in body:
            raise RuntimeError(body['error'])
        return body['result']

    def call(self, tool_name, **arguments):
        result = self.rpc('tools/call', {'name': tool_name, 'arguments': arguments})
        text = next(item['text'] for item in result.get('content', []) if item['type'] == 'text')
        parsed = json.loads(text)
        if result.get('isError'):
            raise RuntimeError(parsed)
        return parsed


def run_case(client, label, values):
    flowsheet_id = client.call('dwsim_flowsheet_create', name=f'P1B {label} schema probe')[
        'flowsheet_id']
    try:
        client.call('dwsim_thermo_add_compounds', flowsheet_id=flowsheet_id, names=['Water'])
        packages = client.call(
            'dwsim_thermo_list_property_packages', flowsheet_id=flowsheet_id)['property_packages']
        if PROPERTY_PACKAGE not in packages:
            raise AssertionError(f'Missing property package: {PROPERTY_PACKAGE}')
        client.call('dwsim_thermo_set_property_package', flowsheet_id=flowsheet_id,
                    name=PROPERTY_PACKAGE)

        def tool(tool_name, **arguments):
            return client.call(tool_name, flowsheet_id=flowsheet_id, **arguments)

        workflow = advanced_units.run(values, tool)
        if not workflow['raw']['check']['ready'] or not workflow['raw']['solve']['ok']:
            raise AssertionError(f'{label} did not solve cleanly')
        return {
            'inputs': values,
            'results': workflow['results'],
            'comparison': workflow['comparison'],
            'solver_check': workflow['raw']['check'],
            'solver_ok': workflow['raw']['solve']['ok'],
            'applied': workflow['raw'].get('applied', workflow['raw'].get('flash_applied')),
        }
    finally:
        if not client.call('dwsim_flowsheet_close', flowsheet_id=flowsheet_id).get('closed'):
            raise AssertionError(f'{label} flowsheet was not closed')


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
    if len(listed_tools) != 48 or len(schemas) != len(PROBED_TOOLS):
        raise AssertionError({'tools_count': len(listed_tools), 'probed_schemas': sorted(schemas)})
    evidence = {
        'schema_version': '1.0',
        'stage': 'P1B-isolated-schema-probe',
        'captured_at_epoch': int(time.time()),
        'endpoint': args.url,
        'tools_count': len(listed_tools),
        'property_package': PROPERTY_PACKAGE,
        'tool_schemas': schemas,
        'units': {label: run_case(client, label, values) for label, values in CASES.items()},
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(evidence, ensure_ascii=False, indent=2).encode()
    output.write_bytes(encoded)
    print(json.dumps({
        'passed': True,
        'output': str(output),
        'bytes': len(encoded),
        'sha256': hashlib.sha256(encoded).hexdigest(),
        'units': {label: item['results'] for label, item in evidence['units'].items()},
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
