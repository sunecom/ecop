"""Exercise the isolated P3 project, immutable history, and DWSIM export candidate."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


BASELINE = {
    'module': 'evaporation', 'flow_kg_h': 1000, 'temperature_C': 25,
    'pressure_kPa': 101.325, 'vapor_percent': 30,
}
PERTURBED = {**BASELINE, 'vapor_percent': 45}
PUMP = {
    'module': 'pump', 'flow_kg_h': 850, 'inlet_temperature_C': 28,
    'inlet_pressure_kPa': 150, 'outlet_pressure_kPa': 650,
    'efficiency_percent': 72,
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--user', default='ecop')
    credentials = parser.add_mutually_exclusive_group(required=True)
    credentials.add_argument('--password-file')
    credentials.add_argument('--password-env')
    parser.add_argument('--output', required=True)
    parser.add_argument('--verify-existing')
    return parser.parse_args()


def main():
    args = parse_args()
    parsed = urlsplit(args.base)
    if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}:
        raise ValueError('P3 QA refuses non-loopback or non-HTTP candidate endpoints')
    if parsed.port != 18769 or args.origin.rstrip('/') != args.base.rstrip('/'):
        raise ValueError('P3 QA requires the isolated loopback candidate on port 18769')
    password = (Path(args.password_file).read_text(encoding='utf-8').strip()
                if args.password_file else os.environ.get(args.password_env, '').strip())
    if len(password) < 16:
        raise RuntimeError('Password is missing or too short')
    authorization = 'Basic ' + base64.b64encode(f'{args.user}:{password}'.encode()).decode()
    base = args.base.rstrip('/')

    def fetch(path, authenticated=True, payload=None, origin=None, nonce=None, method=None):
        body = None if payload is None else json.dumps(payload, allow_nan=False).encode()
        headers = {'Authorization': authorization} if authenticated else {}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if origin is not None:
            headers['Origin'] = origin
        if nonce is not None:
            headers['X-Demo-Token'] = nonce
        request = Request(base + path, data=body, headers=headers,
                          method=method or ('POST' if body is not None else 'GET'))
        try:
            with urlopen(request, timeout=240) as response:
                return response.status, response.read(), dict(response.headers)
        except HTTPError as exc:
            return exc.code, exc.read(), dict(exc.headers)

    status, page, _ = fetch('/')
    if status != 200:
        raise AssertionError(f'Candidate page returned {status}')
    nonce_match = re.search(rb"const NONCE=['\"]([^'\"]+)", page)
    if not nonce_match:
        raise AssertionError('Candidate nonce not found')
    nonce = nonce_match.group(1).decode()

    def write(path, payload):
        status, body, headers = fetch(path, payload=payload, origin=args.origin, nonce=nonce)
        parsed_body = json.loads(body)
        if status not in {200, 201}:
            raise AssertionError(f'{path} returned {status}: {parsed_body}')
        return parsed_body, headers

    def read_json(path):
        status, body, headers = fetch(path)
        if status != 200:
            raise AssertionError(f'{path} returned {status}: {body[:400]!r}')
        return json.loads(body), headers

    if args.verify_existing:
        previous = json.loads(Path(args.verify_existing).read_text(encoding='utf-8'))
        project_id = previous['project']['id']
        opened, _ = read_json('/api/projects/' + project_id)
        expected_runs = set(previous['run_ids'])
        actual_runs = {
            record['run_id'] for case in opened['project']['cases']
            for version in case['versions'] for record in version['records']
        }
        if not expected_runs <= actual_runs:
            raise AssertionError({'missing_runs': sorted(expected_runs - actual_runs)})
        verified_exports = []
        for export in previous['exports']:
            status, body, headers = fetch('/api/exports/' + export['id'])
            digest = hashlib.sha256(body).hexdigest()
            if status != 200 or digest != export['sha256'] or headers.get('X-Content-Sha256') != digest:
                raise AssertionError({'export': export, 'status': status, 'digest': digest,
                                      'header': headers.get('X-Content-Sha256')})
            verified_exports.append({'id': export['id'], 'sha256': digest, 'bytes': len(body)})
        evidence = {
            'schema_version': '1.0', 'stage': 'P3-persistence-after-recreate',
            'captured_at_epoch': int(time.time()), 'base': base,
            'project_id': project_id, 'run_ids': sorted(actual_runs),
            'exports': verified_exports,
        }
    else:
        project_data, _ = write('/api/projects', {'name': 'P3 隔离验收项目'})
        project = project_data['project']
        case_data, _ = write(
            f"/api/projects/{project['id']}/cases",
            {'name': '蒸发基准与扰动', 'inputs': BASELINE})
        case = case_data['case']
        first_version = case['versions'][0]
        first_record = write(
            f"/api/case-versions/{first_version['id']}/calculate", {})[0]['record']
        second_version = write(
            f"/api/cases/{case['id']}/versions",
            {'inputs': PERTURBED, 'parent_version_id': first_version['id']})[0]['version']
        second_record = write(
            f"/api/case-versions/{second_version['id']}/calculate", {})[0]['record']

        pump_case = write(
            f"/api/projects/{project['id']}/cases",
            {'name': '泵不可比对照', 'inputs': PUMP})[0]['case']
        pump_record = write(
            f"/api/case-versions/{pump_case['versions'][0]['id']}/calculate", {})[0]['record']

        compare_path = '/api/compare?' + urlencode({
            'run_a': first_record['run_id'], 'run_b': second_record['run_id']})
        comparison = read_json(compare_path)[0]['comparison']
        expected_delta = (second_record['result']['comparison']['value'] -
                          first_record['result']['comparison']['value'])
        if abs(comparison['delta'] - expected_delta) > 1e-9:
            raise AssertionError('Stored comparison delta does not match immutable results')

        incompatible_path = '/api/compare?' + urlencode({
            'run_a': first_record['run_id'], 'run_b': pump_record['run_id']})
        incompatible_status, incompatible_body, _ = fetch(incompatible_path)
        if incompatible_status != 409:
            raise AssertionError(f'Incompatible compare returned {incompatible_status}')

        opened = read_json('/api/projects/' + project['id'])[0]['project']
        evaporation_case = next(item for item in opened['cases'] if item['id'] == case['id'])
        if [version['version'] for version in evaporation_case['versions']] != [1, 2]:
            raise AssertionError('Expected two immutable versions')
        if evaporation_case['versions'][0]['inputs']['vapor_percent'] != 30.0:
            raise AssertionError('Version 1 was overwritten')
        if evaporation_case['versions'][1]['inputs']['vapor_percent'] != 45.0:
            raise AssertionError('Version 2 did not preserve changed input')

        exports = []
        for record in (first_record, second_record, pump_record):
            export = record['export']
            status, body, headers = fetch('/api/exports/' + export['id'])
            digest = hashlib.sha256(body).hexdigest()
            if status != 200 or digest != export['sha256']:
                raise AssertionError({'export': export, 'status': status, 'digest': digest})
            if headers.get('X-Content-Sha256') != digest:
                raise AssertionError('Download checksum header mismatch')
            ET.fromstring(body)
            exports.append({'id': export['id'], 'run_id': record['run_id'],
                            'sha256': digest, 'bytes': len(body)})

        negative = []
        for case_id, path in (
                ('INVALID-ID', '/api/exports/not-an-id'),
                ('TRAVERSAL', '/api/exports/%2e%2e%2fsecret')):
            status, body, _ = fetch(path)
            if status not in {400, 404}:
                raise AssertionError(f'{case_id} returned {status}')
            negative.append({'id': case_id, 'status': status, 'body': json.loads(body)})
        status, body, _ = fetch(
            '/api/projects', payload={'name': 'blocked'}, origin=args.origin + '.invalid', nonce=nonce)
        if status != 403:
            raise AssertionError(f'Wrong origin returned {status}')
        negative.append({'id': 'WRONG-ORIGIN', 'status': status, 'body': json.loads(body)})
        status, body, _ = fetch(
            '/api/projects', payload={'name': 'blocked'}, origin=args.origin, nonce=nonce + '-bad')
        if status != 403:
            raise AssertionError(f'Wrong nonce returned {status}')
        negative.append({'id': 'WRONG-NONCE', 'status': status, 'body': json.loads(body)})
        status, body, _ = fetch('/api/projects', authenticated=False)
        if status != 401:
            raise AssertionError(f'Unauthenticated project list returned {status}')
        negative.append({'id': 'UNAUTHENTICATED', 'status': status, 'body': json.loads(body)})

        evidence = {
            'schema_version': '1.0', 'stage': 'P3-isolated-candidate',
            'captured_at_epoch': int(time.time()), 'base': base,
            'project': project, 'case_id': case['id'],
            'versions': [first_version, second_version],
            'run_ids': [first_record['run_id'], second_record['run_id'], pump_record['run_id']],
            'results': [first_record['result'], second_record['result'], pump_record['result']],
            'exports': exports, 'comparison': comparison,
            'incompatible_compare': {'status': incompatible_status,
                                     'body': json.loads(incompatible_body)},
            'negative': negative,
        }

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(evidence, ensure_ascii=False, indent=2).encode()
    output.write_bytes(encoded)
    print(json.dumps({'passed': True, 'output': str(output),
                      'sha256': hashlib.sha256(encoded).hexdigest(),
                      'stage': evidence['stage'],
                      'project_id': evidence['project_id'] if 'project_id' in evidence else evidence['project']['id'],
                      'run_ids': evidence['run_ids']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

