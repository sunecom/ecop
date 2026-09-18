"""Authenticated WSGI adapter for the single-engine ECOP pilot deployment."""
import base64
import hmac
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
from urllib.parse import parse_qs, urlsplit

import project_store
import server

ORIGIN = os.environ['ECOP_PUBLIC_ORIGIN'].rstrip('/')
USER = os.environ.get('ECOP_USER', 'ecop')
PASSWORD = Path(os.environ['ECOP_PASSWORD_FILE']).read_text().strip()
PARSED_ORIGIN = urlsplit(ORIGIN)
LOOPBACK_CANDIDATE = (PARSED_ORIGIN.scheme == 'http' and
                      PARSED_ORIGIN.hostname in {'127.0.0.1', 'localhost', '::1'})
if (not PASSWORD or len(PASSWORD) < 16 or not PARSED_ORIGIN.netloc or
        (PARSED_ORIGIN.scheme != 'https' and not LOOPBACK_CANDIDATE)):
    raise RuntimeError('Configure HTTPS public origin or an HTTP loopback candidate origin and a password of at least 16 characters')

PROJECT_ROOT = Path(os.environ.get('ECOP_PROJECTS_DIR', '/projects')).resolve()
PROJECT_STORE = project_store.ProjectStore(PROJECT_ROOT / 'projects.sqlite3', PROJECT_ROOT)
OWNER_ID = project_store.authenticated_owner_id('basic', USER)
MIGRATION = PROJECT_STORE.migrate_legacy_runs(OWNER_ID, server.RUNS)


def read_json_body(environ, maximum=32768):
    length = int(environ.get('CONTENT_LENGTH', '0'))
    if not 0 < length <= maximum:
        raise ValueError('请求大小不正确')
    data = json.loads(environ['wsgi.input'].read(length))
    if not isinstance(data, dict):
        raise ValueError('请求必须为 JSON 对象')
    return data


def write_authorized(environ):
    return (environ.get('HTTP_ORIGIN') == ORIGIN and
            hmac.compare_digest(environ.get('HTTP_X_DEMO_TOKEN', '').encode(),
                                server.NONCE.encode()))


def application(environ, start_response):
    def respond(status, data, content_type='application/json; charset=utf-8', extra=()):
        body = data if isinstance(data, bytes) else server.strict_json_bytes(data)
        start_response(status, [('Content-Type', content_type), ('Content-Length', str(len(body))),
                                ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                                ('X-Frame-Options', 'DENY'), ('Referrer-Policy', 'no-referrer'), *extra])
        return [body]

    method, path = environ['REQUEST_METHOD'], environ.get('PATH_INFO', '/')
    if method == 'GET' and path == '/healthz':
        return respond('200 OK', {'ok': True})
    try:
        scheme, encoded = environ.get('HTTP_AUTHORIZATION', '').split(' ', 1)
        supplied = base64.b64decode(encoded, validate=True).decode()
        authenticated = scheme.lower() == 'basic' and hmac.compare_digest(
            supplied.encode(), (USER + ':' + PASSWORD).encode())
    except (ValueError, UnicodeError):
        authenticated = False
    if not authenticated:
        return respond('401 Unauthorized', {'error': '需要登录'}, extra=[
            ('WWW-Authenticate', 'Basic realm="ECOP pilot", charset="UTF-8"')])
    if environ.get('HTTP_HOST', '') != urlsplit(ORIGIN).netloc:
        return respond('400 Bad Request', {'error': '无效的站点地址'})
    if method == 'POST' and path.startswith('/api/') and not write_authorized(environ):
        return respond('403 Forbidden', {'error': '请从本站刷新页面后重试'})
    if method == 'GET' and path == '/':
        return respond('200 OK', (server.BASE / 'index.html').read_text(encoding='utf-8')
                       .replace('__NONCE__', server.NONCE).replace('本地技术验证', '云端受控验证')
                       .replace('本机 DWSIM', '服务端 DWSIM').encode(), 'text/html; charset=utf-8')
    if method == 'GET' and path == '/logo.png':
        return respond('200 OK', (server.BASE / 'logo.png').read_bytes(), 'image/png')
    if method == 'GET' and path == '/ecop-logo.jpg':
        return respond('200 OK', (server.BASE / 'ecop-logo.jpg').read_bytes(), 'image/jpeg')
    if method == 'GET' and path == '/project_ui.js':
        return respond('200 OK', (server.BASE / 'project_ui.js').read_bytes(),
                       'application/javascript; charset=utf-8')
    if method == 'GET' and path == '/api/status':
        try:
            tools = server.rpc('tools/list')['tools']
            return respond('200 OK', {'ok': True, 'tools': len(tools),
                                     'engine': 'DWSIM 10.2.8', 'commit': server.SHA})
        except Exception:
            logging.exception('DWSIM status failed')
            return respond('503 Service Unavailable', {'ok': False, 'error': '计算引擎暂不可用'})
    if method == 'GET' and path == '/api/catalog':
        try:
            return respond('200 OK', server.get_catalog())
        except ValueError as exc:
            return respond('409 Conflict', {'ok': False, 'error': str(exc)})
        except Exception:
            logging.exception('DWSIM catalog failed')
            return respond('503 Service Unavailable', {'ok': False, 'error': '模块目录暂不可用'})
    if method == 'GET' and path == '/api/compounds':
        try:
            query = parse_qs(environ.get('QUERY_STRING', '')).get('q', [''])[0]
            return respond('200 OK', server.search_compounds(query))
        except ValueError as exc:
            return respond('400 Bad Request', {'ok': False, 'error': str(exc)})
        except Exception:
            logging.exception('DWSIM compound search failed')
            return respond('503 Service Unavailable', {'ok': False, 'error': '组分目录暂不可用'})
    if method == 'GET' and path == '/api/projects':
        return respond('200 OK', {'ok': True, 'projects': PROJECT_STORE.list_projects(OWNER_ID),
                                  'migration': MIGRATION})
    project_match = re.fullmatch(r'/api/projects/(prj_[0-9a-f]{32})', path)
    if method == 'GET' and project_match:
        try:
            project = PROJECT_STORE.get_project(OWNER_ID, project_match.group(1))
            return respond('200 OK', {'ok': True, 'project': project})
        except project_store.NotFoundError as exc:
            return respond('404 Not Found', {'error': str(exc)})
    export_match = re.fullmatch(r'/api/exports/(exp_[0-9a-f]{32})', path)
    if method == 'GET' and export_match:
        try:
            export = PROJECT_STORE.get_export(OWNER_ID, export_match.group(1))
            return respond('200 OK', export['path'].read_bytes(), 'application/xml', extra=[
                ('Content-Disposition', f'attachment; filename="ECOP-{export["run_id"]}.dwxml"'),
                ('X-Content-SHA256', export['sha256'])])
        except project_store.NotFoundError as exc:
            return respond('404 Not Found', {'error': str(exc)})
        except project_store.ConflictError as exc:
            return respond('409 Conflict', {'error': str(exc)})
    if method == 'GET' and path == '/api/compare':
        try:
            query = parse_qs(environ.get('QUERY_STRING', ''))
            comparison = PROJECT_STORE.compare_records(
                OWNER_ID, query.get('run_a', [''])[0], query.get('run_b', [''])[0])
            return respond('200 OK', {'ok': True, 'comparison': comparison})
        except project_store.InvalidIdError as exc:
            return respond('400 Bad Request', {'error': str(exc)})
        except project_store.NotFoundError as exc:
            return respond('404 Not Found', {'error': str(exc)})
        except project_store.ConflictError as exc:
            return respond('409 Conflict', {'error': str(exc)})
    if method == 'POST' and path == '/api/projects':
        try:
            payload = read_json_body(environ)
            if set(payload) != {'name'}:
                raise ValueError('项目请求字段不正确')
            project = PROJECT_STORE.create_project(OWNER_ID, payload['name'])
            return respond('201 Created', {'ok': True, 'project': project})
        except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
            return respond('400 Bad Request', {'error': str(exc)})
    case_match = re.fullmatch(r'/api/projects/(prj_[0-9a-f]{32})/cases', path)
    if method == 'POST' and case_match:
        try:
            payload = read_json_body(environ)
            if set(payload) != {'name', 'inputs'}:
                raise ValueError('工况请求字段不正确')
            inputs = server.project_inputs(payload['inputs'])
            case = PROJECT_STORE.create_case(
                OWNER_ID, case_match.group(1), payload['name'], inputs)
            return respond('201 Created', {'ok': True, 'case': case})
        except (ValueError, UnicodeError, json.JSONDecodeError,
                project_store.InvalidIdError) as exc:
            return respond('400 Bad Request', {'error': str(exc)})
        except project_store.NotFoundError as exc:
            return respond('404 Not Found', {'error': str(exc)})
    version_match = re.fullmatch(r'/api/cases/(case_[0-9a-f]{32})/versions', path)
    if method == 'POST' and version_match:
        try:
            payload = read_json_body(environ)
            if not {'inputs'} <= set(payload) or set(payload) - {'inputs', 'parent_version_id'}:
                raise ValueError('版本请求字段不正确')
            inputs = server.project_inputs(payload['inputs'])
            version = PROJECT_STORE.create_version(
                OWNER_ID, version_match.group(1), inputs,
                parent_version_id=payload.get('parent_version_id'))
            return respond('201 Created', {'ok': True, 'version': version})
        except (ValueError, UnicodeError, json.JSONDecodeError,
                project_store.InvalidIdError) as exc:
            return respond('400 Bad Request', {'error': str(exc)})
        except project_store.NotFoundError as exc:
            return respond('404 Not Found', {'error': str(exc)})
        except project_store.ConflictError as exc:
            return respond('409 Conflict', {'error': str(exc)})
    copy_match = re.fullmatch(r'/api/case-versions/(cv_[0-9a-f]{32})/copy', path)
    if method == 'POST' and copy_match:
        try:
            payload = read_json_body(environ)
            if set(payload) != {'project_id', 'name'}:
                raise ValueError('复制请求字段不正确')
            case = PROJECT_STORE.copy_version(
                OWNER_ID, copy_match.group(1), payload['project_id'], payload['name'])
            return respond('201 Created', {'ok': True, 'case': case})
        except (ValueError, UnicodeError, json.JSONDecodeError,
                project_store.InvalidIdError) as exc:
            return respond('400 Bad Request', {'error': str(exc)})
        except project_store.NotFoundError as exc:
            return respond('404 Not Found', {'error': str(exc)})
    calculate_match = re.fullmatch(r'/api/case-versions/(cv_[0-9a-f]{32})/calculate', path)
    if method == 'POST' and calculate_match:
        export = None
        try:
            payload = read_json_body(environ)
            if payload:
                raise ValueError('项目计算不接受临时参数，请先创建新版本')
            version = PROJECT_STORE.get_version(OWNER_ID, calculate_match.group(1))
            export = PROJECT_STORE.prepare_export(OWNER_ID, version['project_id'])
            result = server.calculate(version['inputs'], export_path=export['path'])
            record = PROJECT_STORE.record_calculation(
                OWNER_ID, version['id'], result, export)
            return respond('200 OK', {'ok': True, 'record': record})
        except (ValueError, UnicodeError, json.JSONDecodeError,
                project_store.InvalidIdError) as exc:
            if export and export['path'].is_file():
                export['path'].unlink()
            return respond('400 Bad Request', {'error': str(exc)})
        except project_store.NotFoundError as exc:
            if export and export['path'].is_file():
                export['path'].unlink()
            return respond('404 Not Found', {'error': str(exc)})
        except (project_store.ConflictError, sqlite3.IntegrityError) as exc:
            if export and export['path'].is_file():
                export['path'].unlink()
            return respond('409 Conflict', {'error': str(exc)})
        except Exception:
            if export and export['path'].is_file():
                export['path'].unlink()
            logging.exception('Project calculation or export failed')
            return respond('502 Bad Gateway', {'error': '项目计算或流程导出未成功，请联系管理员查看服务日志'})
    if method == 'POST' and path == '/api/calculate':
        try:
            payload = read_json_body(environ, 4095)
            result = server.calculate(payload)
            return respond('200 OK', result)
        except (ValueError, UnicodeError) as exc:
            return respond('400 Bad Request', {'error': str(exc)})
        except Exception:
            logging.exception('DWSIM calculation failed')
            return respond('502 Bad Gateway', {'error': '计算未成功，请联系管理员查看服务日志'})
    return respond('404 Not Found', {'error': 'Not found'})
