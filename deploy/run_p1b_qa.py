"""Exercise P1B only against the isolated loopback candidate web service."""
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
        Path(__file__).parent / 'qa_cases' / 'advanced_units.json'))
    parser.add_argument('--output', required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    parsed = urlsplit(args.base)
    if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}:
        raise ValueError('P1B QA refuses non-loopback or non-HTTP candidate endpoints')
    if parsed.port != 18767 or args.origin.rstrip('/') != args.base.rstrip('/'):
        raise ValueError('P1B QA requires the isolated loopback candidate on port 18767')
    spec_path = Path(args.cases)
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    password = (Path(args.password_file).read_text(encoding='utf-8').strip()
                if args.password_file else os.environ.get(args.password_env, '').strip())
    if not password:
        raise RuntimeError('Password is empty')
    authorization = 'Basic ' + base64.b64encode(f'{args.user}:{password}'.encode()).decode()
    base = args.base.rstrip('/')

    def fetch(path, authenticated=True, payload=None, origin=None, nonce=None):
        body = None if payload is None else json.dumps(payload, allow_nan=False).encode()
        headers = {}
        if authenticated:
            headers['Authorization'] = authorization
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

    evidence = {
        'schema_version': '1.0',
        'stage': 'P1B-isolated-candidate',
        'captured_at_epoch': int(time.time()),
        'base': base,
        'spec_sha256': hashlib.sha256(spec_path.read_bytes()).hexdigest(),
        'inventory': {},
        'runs': [],
        'negative': [],
        'security': {},
    }
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
    expected_live = sorted([
        'Heater', 'Cooler', 'Pump', 'Mixer', 'Splitter', 'Valve',
        'HeatExchanger', 'Compressor', 'Vessel'])
    if live_types != expected_live or catalog['counts']['live_workflows'] != 9:
        raise AssertionError({'live_types': live_types, 'counts': catalog['counts']})
    evidence['inventory'] = {'counts': catalog['counts'], 'live_types': live_types}

    tolerances = spec['tolerances']
    for case in spec['cases']:
        status, body = fetch('/api/calculate', payload=case['payload'],
                             origin=args.origin, nonce=nonce)
        if status != 200:
            raise AssertionError(f"{case['id']} returned {status}: {body[:300]!r}")
        data = json.loads(body)
        results = data['results']
        if data['comparison']['metric'] != case['comparison_metric']:
            raise AssertionError(f"{case['id']} comparison metric mismatch")
        if not data['raw']['check']['ready'] or not data['raw']['solve']['ok']:
            raise AssertionError(f"{case['id']} solver did not report success")
        module = data['module']['id']
        if module == 'heat_exchanger':
            if max(abs(results['hot_mass_residual_kg_h']),
                   abs(results['cold_mass_residual_kg_h'])) > tolerances['mass_residual_abs_kg_h']:
                raise AssertionError(f"{case['id']} heat-exchanger mass balance failed")
            if results['heat_balance_relative'] > tolerances['energy_residual_relative']:
                raise AssertionError(f"{case['id']} heat-exchanger energy balance failed")
            if abs(results['hot_outlet_temperature_C'] -
                   case['payload']['hot_outlet_temperature_C']) > tolerances['target_temperature_abs_C']:
                raise AssertionError(f"{case['id']} hot-side target missed")
            if (abs(results['hot_outlet_pressure_kPa'] - case['payload']['hot_pressure_kPa']) >
                    tolerances['target_pressure_abs_kPa'] or
                    abs(results['cold_outlet_pressure_kPa'] - case['payload']['cold_pressure_kPa']) >
                    tolerances['target_pressure_abs_kPa'] or
                    max(abs(results['hot_pressure_drop_kPa']),
                        abs(results['cold_pressure_drop_kPa'])) >
                    tolerances['target_pressure_abs_kPa']):
                raise AssertionError(f"{case['id']} heat-exchanger pressure target missed")
        elif module == 'compressor':
            if abs(results['mass_residual_kg_h']) > tolerances['mass_residual_abs_kg_h']:
                raise AssertionError(f"{case['id']} compressor mass balance failed")
            if results['power_residual_relative'] > tolerances['energy_residual_relative']:
                raise AssertionError(f"{case['id']} compressor power balance failed")
            if abs(results['outlet_pressure_kPa'] -
                   case['payload']['outlet_pressure_kPa']) > tolerances['target_pressure_abs_kPa']:
                raise AssertionError(f"{case['id']} compressor pressure target missed")
            if results['outlet_vapor_fraction'] < 1 - tolerances['phase_fraction_abs']:
                raise AssertionError(f"{case['id']} compressor outlet is not vapor")
        elif module == 'vessel':
            residuals = ('mass_residual_kg_h', 'vapor_split_residual_kg_h',
                         'liquid_split_residual_kg_h')
            if max(abs(results[key]) for key in residuals) > tolerances['mass_residual_abs_kg_h']:
                raise AssertionError(f"{case['id']} vessel split balance failed")
            if results['enthalpy_residual_relative'] > tolerances['energy_residual_relative']:
                raise AssertionError(f"{case['id']} vessel enthalpy balance failed")
            expected_fraction = case['payload']['feed_vapor_percent'] / 100
            if abs(results['feed_vapor_fraction'] - expected_fraction) > tolerances['phase_fraction_abs']:
                raise AssertionError(f"{case['id']} vessel feed phase target missed")
            if (results['vapor_product_vapor_fraction'] < 1 - tolerances['phase_fraction_abs'] or
                    results['liquid_product_vapor_fraction'] > tolerances['phase_fraction_abs']):
                raise AssertionError(f"{case['id']} vessel products are not phase-pure")
            if (abs(results['separation_pressure_kPa'] - case['payload']['pressure_kPa']) >
                    tolerances['target_pressure_abs_kPa'] or
                    results['max_pressure_residual_kPa'] > tolerances['target_pressure_abs_kPa']):
                raise AssertionError(f"{case['id']} vessel pressure target missed")
        else:
            raise AssertionError(f"Unexpected module: {module}")
        evidence['runs'].append({
            'id': case['id'],
            'run_id': data['run_id'],
            'time': data['time'],
            'module': data['module'],
            'inputs': data['inputs'],
            'results': results,
            'comparison': data['comparison'],
            'property_package': data['property_package'],
            'engine': data['engine'],
            'engine_reference': data['commit'],
            'solver_check': data['raw']['check'],
            'solver_ok': data['raw']['solve']['ok'],
        })

    for case in spec['negative_cases']:
        status, body = fetch('/api/calculate', payload=case['payload'],
                             origin=args.origin, nonce=nonce)
        if status != case['expected_status']:
            raise AssertionError(f"{case['id']} returned {status}: {body[:300]!r}")
        parsed_body = json.loads(body)
        if 'error' not in parsed_body:
            raise AssertionError(f"{case['id']} error body missing")
        evidence['negative'].append({
            'id': case['id'], 'status': status, 'error': parsed_body['error']})

    valid_payload = spec['cases'][0]['payload']
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
        'bytes': len(encoded),
        'sha256': hashlib.sha256(encoded).hexdigest(),
        'run_ids': {run['id']: run['run_id'] for run in evidence['runs']},
        'negative_statuses': {item['id']: item['status'] for item in evidence['negative']},
        'security_statuses': {key: item['status'] for key, item in evidence['security'].items()},
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
