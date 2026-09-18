"""Real-Chrome acceptance for the isolated P3 project workspace."""
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
    if parsed.port != 18769:
        raise ValueError('Browser QA requires the isolated P3 candidate on port 18769')
    password = os.environ.get(args.password_env, '')
    if len(password) < 16:
        raise RuntimeError('Candidate password is missing or too short')
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    console_errors, page_errors, responses = [], [], []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=args.chrome, headless=True,
            args=['--disable-gpu', '--no-first-run', '--no-default-browser-check'])
        context = browser.new_context(
            viewport={'width': 1440, 'height': 1000},
            http_credentials={'username': args.user, 'password': password},
            accept_downloads=True)
        page = context.new_page()
        page.on('console', lambda message: console_errors.append(message.text)
                if message.type == 'error' else None)
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        page.on('response', lambda response: responses.append(
            {'url': response.url, 'status': response.status})
            if '/api/' in response.url else None)
        response = page.goto(args.base, wait_until='networkidle')
        if response is None or response.status != 200:
            raise AssertionError('Candidate page did not load')
        page.wait_for_function("document.getElementById('projectCount').textContent !== '—'")
        desktop_overflow = page.evaluate(
            'document.documentElement.scrollWidth - document.documentElement.clientWidth')
        if desktop_overflow > 1:
            raise AssertionError(f'Desktop horizontal overflow: {desktop_overflow}px')

        previous_project_id = page.locator('#projectSelect').input_value()
        page.locator('#projectName').fill('P3 Chrome 持久化项目')
        page.locator('#projectCreate').click()
        page.wait_for_function(
            "previous => document.getElementById('projectSelect').value.startsWith('prj_') && document.getElementById('projectSelect').value !== previous",
            arg=previous_project_id)
        project_id = page.locator('#projectSelect').input_value()
        page.locator('#caseName').fill('Chrome 蒸发版本')
        page.locator('#caseCreate').click()
        page.wait_for_function("!document.getElementById('versionCreate').disabled")
        page.locator('[data-calculate-version]').first.click()
        page.wait_for_function("document.getElementById('projectStatus').textContent.includes('可下载 DWSIM')", timeout=240000)
        first_run = json.loads(page.locator('#raw').text_content())

        page.locator('[data-open-version]').first.click()
        page.locator('.calc-form.active [data-key="vapor_percent"]').fill('45')
        page.locator('#versionCreate').click()
        page.wait_for_function("document.querySelectorAll('[data-calculate-version]').length >= 2")
        page.locator('[data-calculate-version]').nth(1).click()
        page.wait_for_function(
            "document.getElementById('projectStatus').textContent.includes('可下载 DWSIM') && document.querySelectorAll('[data-show-run]').length >= 2",
            timeout=240000)
        second_run = json.loads(page.locator('#raw').text_content())
        if first_run['run_id'] == second_run['run_id']:
            raise AssertionError('Project versions reused the same run ID')
        if first_run['inputs']['vapor_percent'] != 30 or second_run['inputs']['vapor_percent'] != 45:
            raise AssertionError('Version inputs were not preserved')

        page.locator('#projectCompare').click()
        page.wait_for_function("document.getElementById('projectCompareOutput').textContent.includes('B−A')")
        comparison_text = page.locator('#projectCompareOutput').text_content()
        with page.expect_download(timeout=30000) as download_info:
            page.locator('.project-record a').last.click()
        download = download_info.value
        download_path = output_dir / download.suggested_filename
        download.save_as(str(download_path))
        if download_path.suffix.lower() != '.dwxml' or download_path.stat().st_size == 0:
            raise AssertionError('DWSIM download is missing or empty')
        download_sha256 = hashlib.sha256(download_path.read_bytes()).hexdigest()

        page.screenshot(path=str(output_dir / 'p3-project-desktop-1440.png'), full_page=True)
        page.reload(wait_until='networkidle')
        page.wait_for_function(
            f"document.getElementById('projectSelect').value === '{project_id}' || Array.from(document.getElementById('projectSelect').options).some(o => o.value === '{project_id}')")
        page.locator('#projectSelect').select_option(project_id)
        page.wait_for_function("document.querySelectorAll('[data-show-run]').length >= 2")
        persistence_count = page.locator('[data-show-run]').count()

        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('#projects').scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        mobile_overflow = page.evaluate(
            'document.documentElement.scrollWidth - document.documentElement.clientWidth')
        if mobile_overflow > 1:
            raise AssertionError(f'Mobile horizontal overflow: {mobile_overflow}px')
        if not page.locator('#projectCreate').is_visible() or not page.locator('#projectTree').is_visible():
            raise AssertionError('Project workspace is not usable at 390px')
        page.screenshot(path=str(output_dir / 'p3-project-mobile-390.png'), full_page=True)
        if console_errors or page_errors:
            raise AssertionError({'console_errors': console_errors, 'page_errors': page_errors})
        context.close()
        browser.close()

    evidence = {
        'schema_version': '1.0', 'stage': 'P3-browser-candidate',
        'captured_at_epoch': int(time.time()), 'base': args.base,
        'browser': 'Google Chrome', 'project_id': project_id,
        'run_ids': [first_run['run_id'], second_run['run_id']],
        'comparison_text': comparison_text,
        'download': {'path': str(download_path), 'sha256': download_sha256,
                     'bytes': download_path.stat().st_size},
        'persistence_record_count_after_reload': persistence_count,
        'desktop': {'width': 1440, 'horizontal_overflow_px': desktop_overflow},
        'mobile': {'width': 390, 'horizontal_overflow_px': mobile_overflow},
        'api_responses': responses,
        'console_errors': console_errors, 'page_errors': page_errors,
    }
    output = output_dir / 'p3-browser-evidence.json'
    encoded = json.dumps(evidence, ensure_ascii=False, indent=2).encode()
    output.write_bytes(encoded)
    print(json.dumps({'passed': True, 'output': str(output),
                      'sha256': hashlib.sha256(encoded).hexdigest(),
                      'project_id': project_id, 'run_ids': evidence['run_ids'],
                      'download_sha256': download_sha256,
                      'desktop_overflow_px': desktop_overflow,
                      'mobile_overflow_px': mobile_overflow,
                      'console_errors': len(console_errors),
                      'page_errors': len(page_errors)}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
