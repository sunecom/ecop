"""Exercise P2 material workflows and all nine existing workflows on loopback."""
import argparse
import base64
import hashlib
import json
import os
import re
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--user', default='ecop')
    credentials = parser.add_mutually_exclusive_group(required=True)
    credentials.add_argument('--password-file')
    credentials.add_argument('--password-env')
    parser.add_argument('--cases', default=str(
        Path(__file__).parent / 'qa_cases' / 'material_systems.json'))
    parser.add_argument('--output', required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    parsed = urlsplit(args.base)
    if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}:
        raise ValueError('P2 QA refuses non-loopback or non-HTTP candidate endpoints')
    if parsed.port != 18768 or args.origin.rstrip('/') != args.base.rstrip('/'):
        raise ValueError('P2 QA requires the isolated loopback candidate on port 18768')
    spec_path = Path(args.cases)
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    password = (Path(args.password_file).read_text(encoding='utf-8').strip()
                if args.password_file else os.environ.get(args.password_env, '').strip())
    if len(password) < 16:
        raise RuntimeError('Password is missing or too short')
    authorization = 'Basic ' + base64.b64encode(f'{args.user}:{password}'.encode()).decode()
    base = args.base.rstrip('/')

    def fetch(path, authenticated=True, payload=None, origin=None, nonce=None):
        body = None if payload is None else json.dumps(payload, allow_nan=False).encode()
        headers = {'Authorization': authorization} if authenticated else {}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if origin is not None:
            headers['Origin'] = origin
        if nonce is not None:
            headers['X-Demo-Token'] = nonce
        request = Request(base + path, data=body, headers=headers,
                          method='POST' if body is not None else 'GET')
        try:
            with urlopen(request, timeout=180) as response:
                return response.status, response.read()
        except HTTPError as exc:
            return exc.code, exc.read()

    status, page = fetch('/')
    if status != 200:
        raise AssertionError(f'Candidate page returned {status}')
    nonce_match = re.search(rb"const NONCE=['\"]([^'\"]+)", page)
    if not nonce_match:
        raise AssertionError('Candidate nonce not found')
    nonce = nonce_match.group(1).decode()
    status, body = fetch('/api/catalog')
    if status != 200:
        raise AssertionError(f'Catalog returned {status}')
    catalog = json.loads(body)
    live_types = sorted(module['type'] for group in catalog['unit_groups']
                        for module in group['modules'] if module['state'] == 'live')
    expected_live = sorted(['Heater', 'Cooler', 'Pump', 'Mixer', 'Splitter', 'Valve',
                            'HeatExchanger', 'Compressor', 'Vessel'])
    if live_types != expected_live or catalog['counts']['live_workflows'] != 10:
        raise AssertionError({'live_types': live_types, 'counts': catalog['counts']})

    evidence = {
        'schema_version': '1.0',
        'stage': 'P2-isolated-candidate',
        'captured_at_epoch': int(time.time()),
        'base': base,
        'spec_sha256': hashlib.sha256(spec_path.read_bytes()).hexdigest(),
        'inventory': {'counts': catalog['counts'], 'live_types': live_types},
        'material_runs': [],
        'nine_workflow_regression': [],
        'negative': [],
        'security': {},
    }

    def calculate(case):
        status, body = fetch('/api/calculate', payload=case['payload'],
                             origin=args.origin, nonce=nonce)
        if status != 200:
            raise AssertionError(f"{case['id']} returned {status}: {body[:500]!r}")
        data = json.loads(body)
        if not data['raw']['check']['ready'] or not data['raw']['solve']['ok']:
            raise AssertionError(f"{case['id']} solver did not report success")
        return data

    tolerance = spec['tolerances']
    temperatures = {}
    for case in spec['material_cases']:
        data = calculate(case)
        results = data['results']
        material = data['material_system']
        requested = case['payload']['vapor_molar_percent'] / 100
        if abs(results['mass_residual_kg_h']) > tolerance['overall_mass_residual_abs_kg_h']:
            raise AssertionError(f"{case['id']} total mass balance failed")
        if results['max_phase_component_mass_relative_residual'] > \
                tolerance['phase_balance_relative']:
            raise AssertionError(f"{case['id']} phase component mass balance failed")
        if results['max_phase_component_molar_relative_residual'] > \
                tolerance['phase_balance_relative']:
            raise AssertionError(f"{case['id']} phase component molar balance failed")
        if abs(results['outlet_pressure_kPa'] - case['payload']['pressure_kPa']) > \
                tolerance['target_pressure_abs_kPa']:
            raise AssertionError(f"{case['id']} pressure target missed")
        if abs(results['outlet_vapor_molar_fraction'] - requested) > \
                tolerance['target_vapor_molar_fraction_abs']:
            raise AssertionError(f"{case['id']} vapor molar target missed")
        if material['phase_fraction_basis'] != 'molar':
            raise AssertionError(f"{case['id']} phase basis missing")
        if data['raw']['property_package_applied']['property_package'] != data['property_package']:
            raise AssertionError(f"{case['id']} property package readback mismatch")
        if set(data['raw']['compounds_applied']['added']) != set(data['inputs']['compounds']):
            raise AssertionError(f"{case['id']} compound readback mismatch")
        if data['raw']['controlled_template']['flash_settings'] != {
                'PTFlash_External_Loop_Tolerance': '1E-08',
                'PTFlash_Internal_Loop_Tolerance': '1E-08'}:
            raise AssertionError(f"{case['id']} controlled flash settings mismatch")
        temperatures[case['id']] = results['outlet_temperature_C']
        evidence['material_runs'].append({
            'id': case['id'], 'run_id': data['run_id'], 'inputs': data['inputs'],
            'results': results, 'property_package': data['property_package'],
            'material_system': material, 'solver_check': data['raw']['check'],
            'solver_ok': data['raw']['solve']['ok'],
        })
    model_effect_delta = temperatures['BINARY-RAOULT'] - temperatures['BINARY-NRTL']
    if abs(model_effect_delta) < 1:
        raise AssertionError('NRTL and Raoult selections did not materially change the result')
    evidence['model_selection_effect_C'] = model_effect_delta
    evidence['model_selection_effect_interpretation'] = (
        'Selection changes the model result; this is not an accuracy validation.')

    seen_modules = set()
    for case in spec['regression_cases']:
        data = calculate(case)
        seen_modules.add(data['module']['id'])
        evidence['nine_workflow_regression'].append({
            'id': case['id'], 'run_id': data['run_id'], 'module': data['module'],
            'inputs': data['inputs'], 'results': data['results'],
            'comparison': data['comparison'],
        })
    expected_modules = {'evaporation', 'temperature', 'pump', 'mixer', 'splitter',
                        'valve', 'heat_exchanger', 'compressor', 'vessel'}
    if seen_modules != expected_modules:
        raise AssertionError({'missing_regression_modules': sorted(expected_modules - seen_modules)})

    for case in spec['negative_cases']:
        status, body = fetch('/api/calculate', payload=case['payload'],
                             origin=args.origin, nonce=nonce)
        if status != case['expected_status']:
            raise AssertionError(f"{case['id']} returned {status}: {body[:300]!r}")
        parsed_body = json.loads(body)
        evidence['negative'].append({
            'id': case['id'], 'status': status, 'error': parsed_body.get('error')})

    valid_payload = spec['material_cases'][0]['payload']
    for case_id, origin, case_nonce in [
            ('WRONG-ORIGIN', args.origin + '.invalid', nonce),
            ('WRONG-NONCE', args.origin, nonce + '-invalid')]:
        status, body = fetch('/api/calculate', payload=valid_payload,
                             origin=origin, nonce=case_nonce)
        if status != 403:
            raise AssertionError(f'{case_id} returned {status}')
        evidence['security'][case_id] = {'status': status, 'body': json.loads(body)}
    status, body = fetch('/api/status', authenticated=False)
    if status != 401:
        raise AssertionError(f'Unauthenticated status returned {status}')
    evidence['security']['UNAUTHENTICATED'] = {'status': status, 'body': json.loads(body)}

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(evidence, ensure_ascii=False, indent=2).encode()
    output.write_bytes(encoded)
    print(json.dumps({
        'passed': True,
        'output': str(output),
        'sha256': hashlib.sha256(encoded).hexdigest(),
        'model_selection_effect_C': model_effect_delta,
        'material_run_ids': {run['id']: run['run_id'] for run in evidence['material_runs']},
        'regression_run_ids': {run['id']: run['run_id']
                               for run in evidence['nine_workflow_regression']},
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
