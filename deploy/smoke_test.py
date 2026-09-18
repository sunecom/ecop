"""Run on the target host after startup. Never prints passwords or auth headers."""
import argparse
import base64
import json
import re
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='http://127.0.0.1:18765')
parser.add_argument('--origin', default='https://ecop.aitomoney.online')
parser.add_argument('--password-file', default=str(Path(__file__).parent / 'secrets/ecop_password.txt'))
args = parser.parse_args()
base = args.base.rstrip('/')
origin = args.origin.rstrip('/')
password = Path(args.password_file).read_text().strip()
auth = 'Basic ' + base64.b64encode(('ecop:' + password).encode()).decode()


def fetch(path, authenticated=True, body=None, extra=None):
    headers = {'Host': urlsplit(origin).netloc}
    if authenticated: headers['Authorization'] = auth
    if body is not None: headers['Content-Type'] = 'application/json'
    headers.update(extra or {})
    try:
        with urlopen(Request(base + path, data=None if body is None else json.dumps(body).encode(),
                             headers=headers), timeout=180) as r:
            return r.status, r.read()
    except HTTPError as exc:
        return exc.code, exc.read()


for path in ['/', '/ecop-logo.jpg', '/api/status', '/api/catalog', '/api/compounds?q=Water',
             '/api/calculate']:
    assert fetch(path, authenticated=False)[0] == 401
status, page = fetch('/')
assert status == 200
assert b'/ecop-logo.jpg' in page
status, logo = fetch('/ecop-logo.jpg')
assert status == 200 and logo.startswith(b'\xff\xd8') and len(logo) > 30000
nonce = re.search(r"const NONCE=['\"]([^'\"]+)", page.decode())
if nonce is None:
    nonce = re.search(r"['\"]X-Demo-Token['\"]\s*:\s*['\"]([^'\"]+)", page.decode())
assert nonce, 'Missing page nonce'
headers = {'Origin': origin, 'X-Demo-Token': nonce.group(1)}
status, engine = fetch('/api/status')
assert status == 200, engine
status, catalog = fetch('/api/catalog')
assert status == 200, catalog
catalog = json.loads(catalog)
assert catalog['counts']['mcp_tools'] == 48
assert catalog['counts']['unit_operations'] == 44
assert catalog['counts']['property_packages'] == 28
assert catalog['counts']['compounds'] >= 1500
assert catalog['counts']['live_workflows'] == 10
assert sum(group['count'] for group in catalog['tool_groups']) == 48
assert set(module['type'] for group in catalog['unit_groups'] for module in group['modules']
           if module['state'] == 'live') == {
               'Heater', 'Cooler', 'Pump', 'Mixer', 'Splitter', 'Valve',
               'HeatExchanger', 'Compressor', 'Vessel'}
status, compounds = fetch('/api/compounds?q=Water')
assert status == 200, compounds
compounds = json.loads(compounds)
assert 'Water' in compounds['matches'] and compounds['limit'] == 20
records = []
cases = [
    # Legacy payload intentionally omits module; it must remain the evaporation workflow.
    dict(flow_kg_h=1000, temperature_C=25, pressure_kPa=101.325, vapor_percent=30),
    dict(module='evaporation', flow_kg_h=1000, temperature_C=25,
         pressure_kPa=101.325, vapor_percent=60),
    dict(module='temperature', flow_kg_h=1000, inlet_temperature_C=25,
         pressure_kPa=101.325, outlet_temperature_C=60),
    dict(module='temperature', flow_kg_h=1000, inlet_temperature_C=60,
         pressure_kPa=101.325, outlet_temperature_C=25),
    dict(module='pump', flow_kg_h=1000, inlet_temperature_C=25,
         inlet_pressure_kPa=101.325, outlet_pressure_kPa=500, efficiency_percent=75),
    dict(module='pump', flow_kg_h=1000, inlet_temperature_C=25,
         inlet_pressure_kPa=101.325, outlet_pressure_kPa=900, efficiency_percent=75),
    dict(module='heat_exchanger', hot_flow_kg_h=1000, hot_inlet_temperature_C=80,
         hot_pressure_kPa=300, cold_flow_kg_h=1200, cold_inlet_temperature_C=20,
         cold_pressure_kPa=300, hot_outlet_temperature_C=50),
    dict(module='compressor', flow_kg_h=1000, inlet_temperature_C=200,
         inlet_pressure_kPa=200, outlet_pressure_kPa=500, efficiency_percent=75),
    dict(module='vessel', flow_kg_h=1000, inlet_temperature_C=25,
         pressure_kPa=200, feed_vapor_percent=30),
]
for inputs in cases:
    status, result = fetch('/api/calculate', body=inputs, extra=headers)
    assert status == 200, result
    data = json.loads(result)
    r = data['results']
    if data['module']['id'] == 'heat_exchanger':
        assert max(abs(r['hot_mass_residual_kg_h']), abs(r['cold_mass_residual_kg_h'])) < 1e-5
    else:
        assert abs(r['mass_residual_kg_h']) < 1e-5
    records.append({k: data[k] for k in ['run_id', 'time', 'module', 'engine', 'commit',
                                         'inputs', 'results', 'comparison']})
assert abs(records[0]['results']['vapor_kg_h'] - 300) < 1e-5
assert records[0]['module']['id'] == 'evaporation'
assert abs(records[0]['results']['heat_duty_kW'] - 275.2843465647) < 0.01
assert abs(records[0]['results']['outlet_temperature_C'] - 99.9743) < 0.01
assert records[1]['comparison']['value'] > records[0]['comparison']['value']
assert records[2]['comparison']['value'] > 0
assert records[3]['comparison']['value'] < 0
assert abs(records[2]['results']['outlet_temperature_C'] - 60) < 0.02
assert abs(records[3]['results']['outlet_temperature_C'] - 25) < 0.02
assert abs(records[4]['results']['outlet_pressure_kPa'] - 500) < 0.02
assert records[5]['comparison']['value'] > records[4]['comparison']['value']
assert abs(records[6]['results']['hot_outlet_temperature_C'] - 50) < 0.02
assert max(abs(records[6]['results']['hot_pressure_drop_kPa']),
           abs(records[6]['results']['cold_pressure_drop_kPa'])) <= 0.02
assert records[6]['results']['heat_balance_relative'] < 1e-4
assert abs(records[7]['results']['outlet_pressure_kPa'] - 500) < 0.02
assert records[7]['results']['outlet_vapor_fraction'] > 0.999999
assert records[7]['results']['power_residual_relative'] < 1e-4
assert abs(records[8]['results']['vapor_product_kg_h'] - 300) < 1e-5
assert abs(records[8]['results']['liquid_product_kg_h'] - 700) < 1e-5
assert records[8]['results']['max_pressure_residual_kPa'] <= 0.02
assert fetch('/api/calculate', body={}, extra=headers)[0] == 400
assert fetch('/api/calculate', body=inputs, extra=dict(headers, Origin='https://evil.example'))[0] == 403
print(json.dumps({'passed': True, 'checks': ['auth', 'page', 'engine', 'catalog', 'compound_search',
                                          'nine_real_calculations', 'invalid_input', 'cross_origin'],
                  'runs': records}, indent=2))
