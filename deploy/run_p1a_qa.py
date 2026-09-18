"""Exercise P1A only against the isolated loopback candidate web service."""
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
    parser.add_argument('--cases', default=str(Path(__file__).parent / 'qa_cases' / 'basic_units.json'))
    parser.add_argument('--output', required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    parsed = urlsplit(args.base)
    if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}:
        raise ValueError('P1A QA refuses non-loopback or non-HTTP candidate endpoints')
    if parsed.port != 18766 or args.origin.rstrip('/') != args.base.rstrip('/'):
        raise ValueError('P1A QA requires the isolated loopback candidate on port 18766')
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
        'stage': 'P1A-isolated-candidate',
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
    expected_live = sorted(['Heater', 'Cooler', 'Pump', 'Mixer', 'Splitter', 'Valve'])
    if live_types != expected_live or catalog['counts']['live_workflows'] != 6:
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
        if abs(results['mass_residual_kg_h']) > tolerances['mass_residual_abs_kg_h']:
            raise AssertionError(f"{case['id']} mass residual {results['mass_residual_kg_h']}")
        if data['comparison']['metric'] != case['comparison_metric']:
            raise AssertionError(f"{case['id']} comparison metric mismatch")
        if not data['raw']['check']['ready'] or not data['raw']['solve']['ok']:
            raise AssertionError(f"{case['id']} solver did not report success")
        module = data['module']['id']
        if module == 'mixer':
            if results['enthalpy_flow_residual_relative'] > tolerances['energy_residual_relative']:
                raise AssertionError(f"{case['id']} mixer enthalpy balance failed")
            expected_flow = case['payload']['feed1_flow_kg_h'] + case['payload']['feed2_flow_kg_h']
            if abs(results['outlet_flow_kg_h'] - expected_flow) > tolerances['mass_residual_abs_kg_h']:
                raise AssertionError(f"{case['id']} mixer outlet flow mismatch")
        elif module == 'splitter':
            expected_fraction = case['payload']['outlet1_percent'] / 100
            if abs(results['outlet1_fraction'] - expected_fraction) > tolerances['split_fraction_abs']:
                raise AssertionError(f"{case['id']} splitter ratio mismatch")
        elif module == 'valve':
            if results['enthalpy_residual_relative'] > tolerances['energy_residual_relative']:
                raise AssertionError(f"{case['id']} valve isenthalpic check failed")
        for name, expected in case.get('expected', {}).items():
            tolerance = (tolerances['target_pressure_abs_kPa']
                         if 'pressure' in name else tolerances['mass_residual_abs_kg_h'])
            if abs(results[name] - expected) > tolerance:
                raise AssertionError(f"{case['id']} {name}: {results[name]} != {expected}")
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
            'applied': data['raw']['applied'],
        })

    for case in spec['negative_cases']:
        status, body = fetch('/api/calculate', payload=case['payload'],
                             origin=args.origin, nonce=nonce)
        if status != case['expected_status']:
            raise AssertionError(f"{case['id']} returned {status}")
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
