"""Build empty DWSIM templates for the controlled P2 material systems."""
import argparse
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import uuid
import xml.etree.ElementTree as ET


CONFIGURATIONS = (
    ('water', 'steam_tables', ('Water',), 'Steam Tables (IAPWS-IF97)'),
    ('ethanol', 'nrtl', ('Ethanol',), 'NRTL'),
    ('ethanol', 'raoult', ('Ethanol',), "Raoult's Law"),
    ('acetone', 'nrtl', ('Acetone',), 'NRTL'),
    ('acetone', 'raoult', ('Acetone',), "Raoult's Law"),
    ('water_ethanol', 'nrtl', ('Water', 'Ethanol'), 'NRTL'),
    ('water_ethanol', 'raoult', ('Water', 'Ethanol'), "Raoult's Law"),
)
FLASH_TOLERANCE = '1E-08'


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--token-file', required=True)
    parser.add_argument('--output-dir', default=str(Path(__file__).parent / 'models'))
    return parser.parse_args()


class MCPClient:
    def __init__(self, url, token):
        parsed = urlsplit(url)
        if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}:
            raise ValueError('Template builder only accepts a loopback MCP endpoint')
        if parsed.path.rstrip('/') != '/mcp':
            raise ValueError('MCP endpoint path must be /mcp')
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


def tighten_flash_settings(xml_text):
    root = ET.fromstring(xml_text)
    expected = {
        'PTFlash_External_Loop_Tolerance',
        'PTFlash_Internal_Loop_Tolerance',
    }
    found = set()
    for setting in root.findall('.//Setting'):
        name = setting.get('Name')
        if name in expected:
            setting.set('Value', FLASH_TOLERANCE)
            found.add(name)
    if found != expected:
        raise RuntimeError(f'Missing flash settings: {sorted(expected - found)}')
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def build_template(client, output_dir, system_id, package_id, compounds, package):
    flowsheet_id = client.call(
        'dwsim_flowsheet_create', name=f'ECOP P2 template {system_id} {package_id}')[
            'flowsheet_id']
    try:
        applied_compounds = client.call(
            'dwsim_thermo_add_compounds', flowsheet_id=flowsheet_id,
            names=list(compounds))
        applied_package = client.call(
            'dwsim_thermo_set_property_package', flowsheet_id=flowsheet_id,
            name=package)
        exported = client.call('dwsim_flowsheet_get_xml', flowsheet_id=flowsheet_id)
    finally:
        client.call('dwsim_flowsheet_close', flowsheet_id=flowsheet_id)
    if set(applied_compounds.get('added', [])) != set(compounds):
        raise RuntimeError(f'{system_id}/{package_id} compound readback mismatch')
    if applied_package.get('property_package') != package:
        raise RuntimeError(f'{system_id}/{package_id} property-package readback mismatch')
    encoded = tighten_flash_settings(exported['xml'])
    filename = f'material_{system_id}_{package_id}.dwxml'
    path = output_dir / filename
    path.write_bytes(encoded)
    return {
        'system': system_id,
        'property_package_id': package_id,
        'property_package': package,
        'compounds': list(compounds),
        'file': filename,
        'sha256': hashlib.sha256(encoded).hexdigest(),
        'bytes': len(encoded),
        'engine_configuration_readback': {
            'compounds': applied_compounds,
            'property_package': applied_package,
        },
    }


def main():
    args = parse_args()
    token = Path(args.token_file).read_text(encoding='utf-8').strip()
    if not token:
        raise RuntimeError('MCP token is empty')
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    client = MCPClient(args.url, token)
    templates = [build_template(client, output_dir, *configuration)
                 for configuration in CONFIGURATIONS]
    manifest = {
        'schema_version': '1.0',
        'engine': 'DWSIM 10.2.8',
        'generated_at_epoch': int(time.time()),
        'flash_settings': {
            'PTFlash_External_Loop_Tolerance': FLASH_TOLERANCE,
            'PTFlash_Internal_Loop_Tolerance': FLASH_TOLERANCE,
        },
        'templates': templates,
    }
    manifest_path = output_dir / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n',
                             encoding='utf-8')
    print(json.dumps({
        'templates': len(templates),
        'manifest': str(manifest_path),
        'manifest_sha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
