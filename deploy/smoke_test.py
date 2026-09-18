"""Run on the target host after startup. Never prints passwords or auth headers."""
import argparse
import base64
import json
import re
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='http://127.0.0.1:18765')
parser.add_argument('--origin', default='https://ecop.aitomoney.online')
args = parser.parse_args()
base = args.base.rstrip('/')
origin = args.origin.rstrip('/')
password = (Path(__file__).parent / 'secrets/ecop_password.txt').read_text().strip()
auth = 'Basic ' + base64.b64encode(('ecop:' + password).encode()).decode()


def fetch(path, authenticated=True, body=None, extra=None):
    headers = {'Host': 'ecop.aitomoney.online'}
    if authenticated: headers['Authorization'] = auth
    if body is not None: headers['Content-Type'] = 'application/json'
    headers.update(extra or {})
    try:
        with urlopen(Request(base + path, data=None if body is None else json.dumps(body).encode(),
                             headers=headers), timeout=180) as r:
            return r.status, r.read()
    except HTTPError as exc:
        return exc.code, exc.read()


for path in ['/', '/api/status', '/api/calculate']:
    assert fetch(path, authenticated=False)[0] == 401
status, page = fetch('/')
assert status == 200
nonce = re.search(r"const NONCE=['\"]([^'\"]+)", page.decode())
if nonce is None:
    nonce = re.search(r"['\"]X-Demo-Token['\"]\s*:\s*['\"]([^'\"]+)", page.decode())
assert nonce, 'Missing page nonce'
headers = {'Origin': origin, 'X-Demo-Token': nonce.group(1)}
status, engine = fetch('/api/status')
assert status == 200, engine
records = []
for flow in [1000, 2000]:
    inputs = dict(flow_kg_h=flow, temperature_C=25, pressure_kPa=101.325, vapor_percent=30)
    status, result = fetch('/api/calculate', body=inputs, extra=headers)
    assert status == 200, result
    data = json.loads(result)
    r = data['results']
    assert abs(r['vapor_kg_h'] - flow * 0.3) < 1e-5
    assert abs(r['heat_duty_kW'] - 275.2843465647 * flow / 1000) < 0.01
    assert abs(r['outlet_temperature_C'] - 99.9743) < 0.01
    assert abs(r['mass_residual_kg_h']) < 1e-5
    records.append({k: data[k] for k in ['run_id', 'time', 'engine', 'commit', 'inputs', 'results']})
assert fetch('/api/calculate', body={}, extra=headers)[0] == 400
assert fetch('/api/calculate', body=inputs, extra=dict(headers, Origin='https://evil.example'))[0] == 403
print(json.dumps({'passed': True, 'checks': ['auth', 'page', 'engine', 'two_real_calculations',
                                          'invalid_input', 'cross_origin'], 'runs': records}, indent=2))
