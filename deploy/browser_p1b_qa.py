"""Browser acceptance for the isolated P1B candidate using a real Chromium binary."""
import argparse
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
    if parsed.port != 18767:
        raise ValueError('Browser QA requires the isolated loopback candidate on port 18767')
    password = os.environ.get(args.password_env, '')
    if len(password) < 16:
        raise RuntimeError('Candidate password is missing or too short')
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    console_errors = []
    page_errors = []
    browser_runs = []
    downloads = []

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
        page.wait_for_function("document.getElementById('countLive').textContent === '9'")
        if page.locator('.workbench-tab').count() != 9 or page.locator('.calc-form').count() != 9:
            raise AssertionError('Expected nine workbench tabs and forms')
        desktop_overflow = page.evaluate(
            'document.documentElement.scrollWidth - document.documentElement.clientWidth')
        if desktop_overflow > 1:
            raise AssertionError(f'Desktop horizontal overflow: {desktop_overflow}px')
        page.screenshot(path=str(output_dir / 'p1b-desktop-1440.png'), full_page=True)

        def run_module(module, overrides=None):
            page.locator(f'.workbench-tab[data-module="{module}"]').click()
            form = page.locator(f'.calc-form[data-module="{module}"]')
            for key, value in (overrides or {}).items():
                form.locator(f'[data-key="{key}"]').fill(str(value))
            form.locator('button[type="submit"]').click()
            page.locator('#message.success').wait_for(timeout=180000)
            record = json.loads(page.locator('#raw').text_content())
            if record['module']['id'] != module:
                raise AssertionError(f'UI returned {record["module"]["id"]} for {module}')
            browser_runs.append({
                'module': module,
                'run_id': record['run_id'],
                'inputs': record['inputs'],
                'results': record['results'],
                'comparison': record['comparison'],
            })
            return record

        heat_exchanger_base = run_module('heat_exchanger')
        run_module('compressor')
        vessel_base = run_module('vessel')
        heat_exchanger_disturb = run_module('heat_exchanger', {
            'hot_flow_kg_h': 1500,
            'hot_inlet_temperature_C': 90,
            'hot_pressure_kPa': 500,
            'cold_flow_kg_h': 900,
            'cold_inlet_temperature_C': 15,
            'cold_pressure_kPa': 400,
            'hot_outlet_temperature_C': 60,
        })
        if heat_exchanger_base['run_id'] == heat_exchanger_disturb['run_id']:
            raise AssertionError('HeatExchanger history did not preserve separate runs')
        page.locator('#compareButton').click()
        comparison_text = page.locator('#compareOutput').text_content()
        if 'B−A' not in comparison_text or '请选择' in comparison_text:
            raise AssertionError(f'Comparison did not complete: {comparison_text}')
        with page.expect_download() as download_info:
            page.locator('#downloadLatest').click()
        download = download_info.value
        download_path = output_dir / download.suggested_filename
        download.save_as(str(download_path))
        downloaded = json.loads(download_path.read_text(encoding='utf-8'))
        if downloaded['run_id'] != heat_exchanger_disturb['run_id']:
            raise AssertionError('Downloaded record is not the latest UI result')
        downloads.append(str(download_path))
        page.screenshot(path=str(output_dir / 'p1b-heat-exchanger-result-1440.png'), full_page=True)

        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('#workbench').scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        mobile_overflow = page.evaluate(
            'document.documentElement.scrollWidth - document.documentElement.clientWidth')
        if mobile_overflow > 1:
            raise AssertionError(f'Mobile horizontal overflow: {mobile_overflow}px')
        page.screenshot(path=str(output_dir / 'p1b-mobile-390.png'))
        if not page.locator('.calc-form[data-module="heat_exchanger"]').is_visible():
            raise AssertionError('HeatExchanger form is not visible at 390px')
        if console_errors or page_errors:
            raise AssertionError({'console_errors': console_errors, 'page_errors': page_errors})
        context.close()
        browser.close()

    evidence = {
        'schema_version': '1.0',
        'stage': 'P1B-browser-candidate',
        'captured_at_epoch': int(time.time()),
        'base': args.base,
        'browser': 'Google Chrome',
        'desktop': {'width': 1440, 'horizontal_overflow_px': desktop_overflow},
        'mobile': {'width': 390, 'horizontal_overflow_px': mobile_overflow},
        'tabs': 9,
        'forms': 9,
        'runs': browser_runs,
        'comparison_text': comparison_text,
        'downloaded_records': downloads,
        'console_errors': console_errors,
        'page_errors': page_errors,
        'vessel_run_id': vessel_base['run_id'],
    }
    output = output_dir / 'p1b-browser-evidence.json'
    output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({
        'passed': True,
        'output': str(output),
        'runs': {item['module']: item['run_id'] for item in browser_runs},
        'desktop_overflow_px': desktop_overflow,
        'mobile_overflow_px': mobile_overflow,
        'console_errors': len(console_errors),
        'page_errors': len(page_errors),
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
