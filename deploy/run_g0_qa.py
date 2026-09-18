"""Re-run the immutable ECOP G0 production baseline without printing credentials."""
import argparse
import base64
import hashlib
import json
import os
import re
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default='https://ecop.aitomoney.online')
    parser.add_argument('--origin', default='https://ecop.aitomoney.online')
    parser.add_argument('--user', default='ecop')
    credentials = parser.add_mutually_exclusive_group(required=True)
    credentials.add_argument('--password-file')
    credentials.add_argument('--password-env')
    parser.add_argument('--cases', default=str(Path(__file__).parent / 'qa_cases' / 'baseline.json'))
    parser.add_argument('--output', required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    spec = json.loads(Path(args.cases).read_text(encoding='utf-8'))
    password = (Path(args.password_file).read_text(encoding='utf-8').strip()
                if args.password_file else os.environ.get(args.password_env, '').strip())
    if not password:
        raise RuntimeError('Password is empty')
    authorization = 'Basic ' + base64.b64encode(f'{args.user}:{password}'.encode()).decode()
    base = args.base.rstrip('/')

    def fetch(path, authenticated=True, payload=None, origin=None, nonce=None,
              authorization_override=None, method=None):
        body = None if payload is None else json.dumps(payload, allow_nan=False).encode()
        headers = {}
        if authenticated:
            headers['Authorization'] = authorization_override or authorization
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if origin is not None:
            headers['Origin'] = origin
        if nonce is not None:
            headers['X-Demo-Token'] = nonce
        request = Request(base + path, data=body, headers=headers,
                          method=method or ('POST' if body is not None else 'GET'))
        try:
            with urlopen(request, timeout=180) as response:
                return response.status, dict(response.headers), response.read()
        except HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    evidence = {
        'schema_version': '1.0',
        'stage': 'G0',
        'captured_at_epoch': int(time.time()),
        'base': base,
        'spec_sha256': hashlib.sha256(Path(args.cases).read_bytes()).hexdigest(),
        'unauthenticated': {},
        'inventory': {},
        'runs': [],
        'negative': [],
        'security': {},
    }

    for path in ['/', '/ecop-logo.jpg', '/api/status', '/api/catalog',
                 '/api/compounds?q=Water', '/api/calculate']:
        status, headers, body = fetch(path, authenticated=False)
        if status != 401:
            raise AssertionError(f'{path} unauthenticated status {status}, expected 401')
        evidence['unauthenticated'][path] = {
            'status': status,
            'body_sha256': hashlib.sha256(body).hexdigest(),
        }

    status, _, page = fetch('/')
    if status != 200:
        raise AssertionError(f'Authenticated page status {status}')
    nonce_match = re.search(rb"const NONCE=['\"]([^'\"]+)", page)
    if not nonce_match:
        raise AssertionError('Page nonce not found')
    nonce = nonce_match.group(1).decode()

    status, _, body = fetch('/api/status')
    if status != 200:
        raise AssertionError(f'Status endpoint returned {status}')
    evidence['inventory']['status'] = json.loads(body)
    status, _, body = fetch('/api/catalog')
    if status != 200:
        raise AssertionError(f'Catalog endpoint returned {status}')
    catalog = json.loads(body)
    evidence['inventory']['catalog_counts'] = catalog['counts']
    evidence['inventory']['tool_groups'] = catalog['tool_groups']
    evidence['inventory']['live_unit_types'] = [
        module['type'] for group in catalog['unit_groups'] for module in group['modules']
        if module['state'] == 'live'
    ]
    evidence['inventory']['unit_types'] = [
        module['type'] for group in catalog['unit_groups'] for module in group['modules']
    ]
    evidence['inventory']['property_packages'] = catalog['property_packages']

    tolerances = spec['tolerances']
    for case in spec['cases']:
        status, _, body = fetch('/api/calculate', payload=case['payload'],
                                origin=args.origin, nonce=nonce)
        if status != 200:
            raise AssertionError(f"{case['id']} returned {status}: {body[:300]!r}")
        data = json.loads(body)
        results = data['results']
        if abs(results['mass_residual_kg_h']) > tolerances['mass_residual_abs_kg_h']:
            raise AssertionError(f"{case['id']} mass residual {results['mass_residual_kg_h']}")
        if data['comparison']['metric'] != case['comparison_metric']:
            raise AssertionError(f"{case['id']} comparison metric mismatch")
        for key, expected in case['expected'].items():
            actual = results[key]
            if key == 'outlet_temperature_C':
                ok = abs(actual - expected) <= tolerances['target_temperature_abs_C']
            elif key == 'outlet_pressure_kPa':
                ok = abs(actual - expected) <= tolerances['target_pressure_abs_kPa']
            elif key == 'outlet_vapor_fraction':
                ok = abs(actual - expected) <= tolerances['target_vapor_fraction_abs']
            else:
                scale = max(abs(expected), 1.0)
                ok = abs(actual - expected) <= tolerances['reference_metric_rel'] * scale
            if not ok:
                raise AssertionError(f"{case['id']} {key}: {actual} != {expected}")
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
        status, _, body = fetch('/api/calculate', payload=case['payload'],
                                origin=args.origin, nonce=nonce)
        if status != case['expected_status']:
            raise AssertionError(f"{case['id']} status {status}, expected {case['expected_status']}")
        parsed = json.loads(body)
        if 'error' not in parsed:
            raise AssertionError(f"{case['id']} error body missing")
        evidence['negative'].append({'id': case['id'], 'status': status, 'error': parsed['error']})

    valid_payload = spec['cases'][0]['payload']
    security_cases = [
        ('WRONG-ORIGIN', args.origin + '.invalid', nonce, 403),
        ('WRONG-NONCE', args.origin, nonce + '-invalid', 403),
    ]
    for case_id, origin, case_nonce, expected_status in security_cases:
        status, _, body = fetch('/api/calculate', payload=valid_payload,
                                origin=origin, nonce=case_nonce)
        if status != expected_status:
            raise AssertionError(f'{case_id} status {status}')
        evidence['security'][case_id] = {'status': status, 'body': json.loads(body)}
    status, _, body = fetch('/api/calculate', method='GET')
    if status != 404:
        raise AssertionError(f'Authenticated GET calculate status {status}')
    evidence['security']['GET-CALCULATE'] = {'status': status, 'body': json.loads(body)}
    wrong_auth = 'Basic ' + base64.b64encode(f'{args.user}:definitely-wrong'.encode()).decode()
    status, _, body = fetch('/', authorization_override=wrong_auth)
    if status != 401:
        raise AssertionError(f'Wrong password status {status}')
    evidence['security']['WRONG-PASSWORD'] = {'status': status, 'body': json.loads(body)}

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
    summary = {
        'passed': True,
        'output': str(output),
        'run_ids': {run['id']: run['run_id'] for run in evidence['runs']},
        'negative_statuses': {item['id']: item['status'] for item in evidence['negative']},
        'security_statuses': {key: item['status'] for key, item in evidence['security'].items()},
        'counts': evidence['inventory']['catalog_counts'],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
