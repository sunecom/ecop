"""Real-Chrome acceptance for the isolated P2 material candidate."""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', required=True)
    parser.add_argument('--user', default='ecop')
    parser.add_argument('--password-env', required=True)
    parser.add_argument('--chrome', required=True)
    parser.add_argument('--output-dir', required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    parsed = urlsplit(args.base)
    if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}:
        raise ValueError('Browser QA refuses non-loopback or non-HTTP candidate endpoints')
    if parsed.port != 18768:
        raise ValueError('Browser QA requires the isolated P2 candidate on port 18768')
    password = os.environ.get(args.password_env, '')
    if len(password) < 16:
        raise RuntimeError('Candidate password is missing or too short')
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    console_errors = []
    page_errors = []
    browser_runs = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=args.chrome,
            headless=True,
            args=['--disable-gpu', '--no-first-run', '--no-default-browser-check'],
        )
        context = browser.new_context(
            viewport={'width': 1440, 'height': 1000},
            http_credentials={'username': args.user, 'password': password},
            accept_downloads=True,
        )
        page = context.new_page()
        page.on('console', lambda message: console_errors.append(message.text)
                if message.type == 'error' else None)
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        response = page.goto(args.base, wait_until='networkidle')
        if response is None or response.status != 200:
            raise AssertionError(f'Candidate page status: {None if response is None else response.status}')
        page.wait_for_function("document.getElementById('countLive').textContent === '10'")
        if page.locator('.workbench-tab').count() != 10 or page.locator('.calc-form').count() != 10:
            raise AssertionError('Expected ten workbench tabs and forms')
        desktop_overflow = page.evaluate(
            'document.documentElement.scrollWidth - document.documentElement.clientWidth')
        if desktop_overflow > 1:
            raise AssertionError(f'Desktop horizontal overflow: {desktop_overflow}px')
        page.screenshot(path=str(output_dir / 'p2-desktop-1440.png'), full_page=True)

        page.locator('.workbench-tab[data-module="material_flash"]').click()
        form = page.locator('.calc-form[data-module="material_flash"]')

        def run_material(property_code):
            form.locator('#materialSystem').select_option('3')
            form.locator('#materialPackage').select_option(property_code)
            form.locator('[data-key="ethanol_mass_percent"]').fill('50')
            form.locator('[data-key="vapor_molar_percent"]').fill('50')
            form.locator('button[type="submit"]').click()
            page.locator('#message.success').wait_for(timeout=180000)
            record = json.loads(page.locator('#raw').text_content())
            if record['module']['id'] != 'material_flash':
                raise AssertionError('UI returned the wrong module')
            if record['material_system']['phase_fraction_basis'] != 'molar':
                raise AssertionError('UI record omitted molar phase basis')
            browser_runs.append({
                'run_id': record['run_id'],
                'inputs': record['inputs'],
                'results': record['results'],
                'property_package': record['property_package'],
            })
            return record

        nrtl = run_material('1')
        raoult = run_material('2')
        if nrtl['run_id'] == raoult['run_id']:
            raise AssertionError('History did not preserve distinct material runs')
        if abs(nrtl['results']['outlet_temperature_C'] -
               raoult['results']['outlet_temperature_C']) < 1:
            raise AssertionError('Property-package selection did not affect the result')
        result_text = page.locator('#resultTable').text_content()
        required_text = ('汽相规格 / 结果', 'mol%', '不等同物性准确性', 'L2 引擎一致性')
        if any(text not in result_text for text in required_text):
            raise AssertionError(f'Material result disclosure is incomplete: {result_text}')
        page.locator('#compareButton').click()
        comparison_text = page.locator('#compareOutput').text_content()
        if 'B−A' not in comparison_text or '请选择' in comparison_text:
            raise AssertionError(f'Comparison did not complete: {comparison_text}')
        with page.expect_download() as download_info:
            page.locator('#downloadLatest').click()
        download_path = output_dir / download_info.value.suggested_filename
        download_info.value.save_as(str(download_path))
        downloaded = json.loads(download_path.read_text(encoding='utf-8'))
        if downloaded['run_id'] != raoult['run_id']:
            raise AssertionError('Downloaded record is not the latest material result')
        page.screenshot(path=str(output_dir / 'p2-material-result-1440.png'), full_page=True)

        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('#workbench').scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        mobile_overflow = page.evaluate(
            'document.documentElement.scrollWidth - document.documentElement.clientWidth')
        if mobile_overflow > 1:
            raise AssertionError(f'Mobile horizontal overflow: {mobile_overflow}px')
        if not form.is_visible():
            raise AssertionError('Material form is not visible at 390px')
        page.screenshot(path=str(output_dir / 'p2-mobile-390.png'), full_page=True)
        if console_errors or page_errors:
            raise AssertionError({'console_errors': console_errors, 'page_errors': page_errors})
        context.close()
        browser.close()

    evidence = {
        'schema_version': '1.0',
        'stage': 'P2-browser-candidate',
        'captured_at_epoch': int(time.time()),
        'base': args.base,
        'browser': 'Google Chrome',
        'desktop': {'width': 1440, 'horizontal_overflow_px': desktop_overflow},
        'mobile': {'width': 390, 'horizontal_overflow_px': mobile_overflow},
        'tabs': 10,
        'forms': 10,
        'runs': browser_runs,
        'comparison_text': comparison_text,
        'downloaded_record': str(download_path),
        'console_errors': console_errors,
        'page_errors': page_errors,
    }
    output = output_dir / 'p2-browser-evidence.json'
    encoded = json.dumps(evidence, ensure_ascii=False, indent=2).encode()
    output.write_bytes(encoded)
    print(json.dumps({
        'passed': True,
        'output': str(output),
        'sha256': hashlib.sha256(encoded).hexdigest(),
        'run_ids': [item['run_id'] for item in browser_runs],
        'desktop_overflow_px': desktop_overflow,
        'mobile_overflow_px': mobile_overflow,
        'console_errors': len(console_errors),
        'page_errors': len(page_errors),
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
