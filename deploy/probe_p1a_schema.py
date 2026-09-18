"""Probe P1A unit-operation contracts against an isolated loopback MCP engine."""
import argparse
import hashlib
import json
import math
import os
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


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


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True,
                        help='Explicit isolated MCP URL, for example http://127.0.0.1:15902/mcp')
    token = parser.add_mutually_exclusive_group(required=True)
    token.add_argument('--token-file')
    token.add_argument('--token-env')
    parser.add_argument('--output', required=True)
    return parser.parse_args()


class MCPClient:
    def __init__(self, url, token):
        parsed = urlsplit(url)
        if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}:
            raise ValueError('G0 probe refuses non-loopback or non-HTTP MCP endpoints')
        if parsed.port != 15902 or parsed.path.rstrip('/') != '/mcp':
            raise ValueError('G0 probe requires the isolated loopback endpoint on port 15902')
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
        with urlopen(request, timeout=120) as response:
            body = json.load(response)
        if 'error' in body:
            raise RuntimeError(body['error'])
        return body['result']

    def call_raw(self, tool_name, **arguments):
        return self.rpc('tools/call', {'name': tool_name, 'arguments': arguments})

    def call(self, tool_name, **arguments):
        result = self.call_raw(tool_name, **arguments)
        text = next(item['text'] for item in result.get('content', []) if item['type'] == 'text')
        parsed = json.loads(text)
        if result.get('isError'):
            raise RuntimeError(parsed)
        return parsed


def close_enough(actual, expected, absolute=1e-9, relative=1e-6):
    return math.isclose(actual, expected, abs_tol=absolute, rel_tol=relative)


def mixture_enthalpy(stream):
    return next(phase['enthalpy_kJ_kg'] for phase in stream['phases']
                if phase['name'] == 'Mixture')


def setup_flowsheet(client, name):
    flowsheet_id = client.call('dwsim_flowsheet_create', name=name)['flowsheet_id']
    client.call('dwsim_thermo_add_compounds', flowsheet_id=flowsheet_id, names=['Water'])
    packages = client.call('dwsim_thermo_list_property_packages',
                           flowsheet_id=flowsheet_id)['property_packages']
    if PROPERTY_PACKAGE not in packages:
        raise AssertionError(f'Missing property package: {PROPERTY_PACKAGE}')
    client.call('dwsim_thermo_set_property_package', flowsheet_id=flowsheet_id,
                name=PROPERTY_PACKAGE)
    return flowsheet_id


def add_stream(client, flowsheet_id, name, temperature_K=None, pressure_Pa=None,
               mass_flow_kg_s=None):
    arguments = {'flowsheet_id': flowsheet_id, 'name': name}
    if temperature_K is not None:
        arguments.update({
            'temperature_K': temperature_K,
            'pressure_Pa': pressure_Pa,
            'mass_flow_kg_s': mass_flow_kg_s,
            'composition': {'Water': 1.0},
        })
    client.call('dwsim_stream_add_material', **arguments)
    if mass_flow_kg_s is not None:
        client.call('dwsim_stream_set_conditions', flowsheet_id=flowsheet_id,
                    name=name, mass_flow_kg_s=mass_flow_kg_s)


def invalid_property_probe(client, flowsheet_id, unit_name):
    result = client.call_raw('dwsim_unitop_set', flowsheet_id=flowsheet_id, name=unit_name,
                             properties={'__G0_INVALID_PROPERTY__': 1})
    if not result.get('isError'):
        raise AssertionError(f'{unit_name} accepted an invalid property')
    return result


def solve_and_read(client, flowsheet_id, unit_name, stream_names):
    check = client.call('dwsim_flowsheet_check', flowsheet_id=flowsheet_id)
    if not check.get('ready'):
        raise AssertionError(f'{unit_name} flowsheet check failed: {check}')
    solve = client.call('dwsim_solve_run', flowsheet_id=flowsheet_id, timeout_s=60)
    if not solve.get('ok'):
        raise AssertionError(f'{unit_name} solve failed: {solve}')
    streams = {
        name: client.call('dwsim_stream_get_results', flowsheet_id=flowsheet_id, name=name)
        for name in stream_names
    }
    unit = client.call('dwsim_unitop_get_results', flowsheet_id=flowsheet_id, name=unit_name)
    if not unit.get('calculated'):
        raise AssertionError(f'{unit_name} did not report calculated=true')
    return check, solve, streams, unit


def probe_mixer(client):
    flowsheet_id = setup_flowsheet(client, 'G0 P1A Mixer probe')
    try:
        add_stream(client, flowsheet_id, 'F1', 300.0, 200000.0, 0.1)
        add_stream(client, flowsheet_id, 'F2', 330.0, 150000.0, 0.2)
        add_stream(client, flowsheet_id, 'OUT')
        client.call('dwsim_unitop_add', flowsheet_id=flowsheet_id, type='Mixer', name='MIX-01')
        before = client.call('dwsim_unitop_get_results', flowsheet_id=flowsheet_id, name='MIX-01')
        invalid = invalid_property_probe(client, flowsheet_id, 'MIX-01')
        client.call('dwsim_unitop_connect', flowsheet_id=flowsheet_id, unitop='MIX-01',
                    feed_stream='F1', feed_port=0, product_stream='OUT', product_port=0)
        client.call('dwsim_unitop_connect', flowsheet_id=flowsheet_id, unitop='MIX-01',
                    feed_stream='F2', feed_port=1)
        check, solve, streams, unit = solve_and_read(
            client, flowsheet_id, 'MIX-01', ('F1', 'F2', 'OUT'))
        mass_in = streams['F1']['mass_flow_kg_s'] + streams['F2']['mass_flow_kg_s']
        mass_out = streams['OUT']['mass_flow_kg_s']
        enthalpy_in = sum(streams[name]['mass_flow_kg_s'] * mixture_enthalpy(streams[name])
                          for name in ('F1', 'F2'))
        enthalpy_out = mass_out * mixture_enthalpy(streams['OUT'])
        assertions = {
            'mass_balance_abs_kg_s': abs(mass_in - mass_out),
            'enthalpy_balance_rel': abs(enthalpy_in - enthalpy_out) / abs(enthalpy_in),
            'outlet_pressure_Pa': streams['OUT']['pressure_Pa'],
            'expected_outlet_pressure_Pa': 150000.0,
        }
        if assertions['mass_balance_abs_kg_s'] > 1e-9:
            raise AssertionError(assertions)
        if assertions['enthalpy_balance_rel'] > 1e-6:
            raise AssertionError(assertions)
        if not close_enough(assertions['outlet_pressure_Pa'], 150000.0):
            raise AssertionError(assertions)
        return {'before': before, 'invalid_set': invalid, 'check': check, 'solve': solve,
                'streams': streams, 'unit': unit, 'assertions': assertions}
    finally:
        closed = client.call('dwsim_flowsheet_close', flowsheet_id=flowsheet_id).get('closed')
        if not closed:
            raise AssertionError('Mixer flowsheet was not closed')


def probe_splitter(client):
    flowsheet_id = setup_flowsheet(client, 'G0 P1A Splitter probe')
    try:
        add_stream(client, flowsheet_id, 'FEED', 310.0, 200000.0, 0.3)
        add_stream(client, flowsheet_id, 'OUT1')
        add_stream(client, flowsheet_id, 'OUT2')
        client.call('dwsim_unitop_add', flowsheet_id=flowsheet_id, type='Splitter', name='SPL-01')
        before = client.call('dwsim_unitop_get_results', flowsheet_id=flowsheet_id, name='SPL-01')
        invalid = invalid_property_probe(client, flowsheet_id, 'SPL-01')
        client.call('dwsim_unitop_connect', flowsheet_id=flowsheet_id, unitop='SPL-01',
                    feed_stream='FEED', product_stream='OUT1', product_port=0)
        client.call('dwsim_unitop_connect', flowsheet_id=flowsheet_id, unitop='SPL-01',
                    product_stream='OUT2', product_port=1)
        applied = client.call('dwsim_unitop_set', flowsheet_id=flowsheet_id, name='SPL-01',
                              properties={'OperationMode': 'SplitRatios', 'SR1': 0.3})
        check, solve, streams, unit = solve_and_read(
            client, flowsheet_id, 'SPL-01', ('FEED', 'OUT1', 'OUT2'))
        feed_flow = streams['FEED']['mass_flow_kg_s']
        output_flow = streams['OUT1']['mass_flow_kg_s'] + streams['OUT2']['mass_flow_kg_s']
        assertions = {
            'mass_balance_abs_kg_s': abs(feed_flow - output_flow),
            'out1_fraction': streams['OUT1']['mass_flow_kg_s'] / feed_flow,
            'out2_fraction': streams['OUT2']['mass_flow_kg_s'] / feed_flow,
        }
        if assertions['mass_balance_abs_kg_s'] > 1e-9:
            raise AssertionError(assertions)
        if not close_enough(assertions['out1_fraction'], 0.3):
            raise AssertionError(assertions)
        if not close_enough(assertions['out2_fraction'], 0.7):
            raise AssertionError(assertions)
        return {'before': before, 'invalid_set': invalid, 'applied': applied, 'check': check,
                'solve': solve, 'streams': streams, 'unit': unit, 'assertions': assertions}
    finally:
        closed = client.call('dwsim_flowsheet_close', flowsheet_id=flowsheet_id).get('closed')
        if not closed:
            raise AssertionError('Splitter flowsheet was not closed')


def probe_valve(client):
    flowsheet_id = setup_flowsheet(client, 'G0 P1A Valve probe')
    try:
        add_stream(client, flowsheet_id, 'FEED', 300.0, 500000.0, 0.25)
        add_stream(client, flowsheet_id, 'OUT')
        client.call('dwsim_unitop_add', flowsheet_id=flowsheet_id, type='Valve', name='VLV-01')
        before = client.call('dwsim_unitop_get_results', flowsheet_id=flowsheet_id, name='VLV-01')
        invalid = invalid_property_probe(client, flowsheet_id, 'VLV-01')
        client.call('dwsim_unitop_connect', flowsheet_id=flowsheet_id, unitop='VLV-01',
                    feed_stream='FEED', product_stream='OUT')
        applied = client.call('dwsim_unitop_set', flowsheet_id=flowsheet_id, name='VLV-01',
                              properties={'CalcMode': 'OutletPressure',
                                          'OutletPressure': 200000.0})
        check, solve, streams, unit = solve_and_read(
            client, flowsheet_id, 'VLV-01', ('FEED', 'OUT'))
        feed_enthalpy = mixture_enthalpy(streams['FEED'])
        outlet_enthalpy = mixture_enthalpy(streams['OUT'])
        assertions = {
            'mass_balance_abs_kg_s': abs(
                streams['FEED']['mass_flow_kg_s'] - streams['OUT']['mass_flow_kg_s']),
            'enthalpy_balance_rel': abs(feed_enthalpy - outlet_enthalpy) / abs(feed_enthalpy),
            'outlet_pressure_Pa': streams['OUT']['pressure_Pa'],
            'expected_outlet_pressure_Pa': 200000.0,
        }
        if assertions['mass_balance_abs_kg_s'] > 1e-9:
            raise AssertionError(assertions)
        if assertions['enthalpy_balance_rel'] > 1e-6:
            raise AssertionError(assertions)
        if not close_enough(assertions['outlet_pressure_Pa'], 200000.0):
            raise AssertionError(assertions)
        return {'before': before, 'invalid_set': invalid, 'applied': applied, 'check': check,
                'solve': solve, 'streams': streams, 'unit': unit, 'assertions': assertions}
    finally:
        closed = client.call('dwsim_flowsheet_close', flowsheet_id=flowsheet_id).get('closed')
        if not closed:
            raise AssertionError('Valve flowsheet was not closed')


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
        'stage': 'G0-P1A-isolated-probe',
        'captured_at_epoch': int(time.time()),
        'endpoint': args.url,
        'tools_count': len(listed_tools),
        'property_package': PROPERTY_PACKAGE,
        'tool_schemas': schemas,
        'units': {
            'Mixer': probe_mixer(client),
            'Splitter': probe_splitter(client),
            'Valve': probe_valve(client),
        },
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
        'units': {name: value['assertions'] for name, value in evidence['units'].items()},
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
