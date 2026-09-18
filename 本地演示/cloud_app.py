"""Authenticated WSGI adapter for the single-engine ECOP pilot deployment."""
import base64
import hmac
import json
import logging
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

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


def application(environ, start_response):
    def respond(status, data, content_type='application/json; charset=utf-8', extra=()):
        body = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode()
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
    if method == 'GET' and path == '/':
        return respond('200 OK', (server.BASE / 'index.html').read_text(encoding='utf-8')
                       .replace('__NONCE__', server.NONCE).replace('本地技术验证', '云端受控验证')
                       .replace('本机 DWSIM', '服务端 DWSIM').encode(), 'text/html; charset=utf-8')
    if method == 'GET' and path == '/logo.png':
        return respond('200 OK', (server.BASE / 'logo.png').read_bytes(), 'image/png')
    if method == 'GET' and path == '/ecop-logo.jpg':
        return respond('200 OK', (server.BASE / 'ecop-logo.jpg').read_bytes(), 'image/jpeg')
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
    if method == 'POST' and path == '/api/calculate':
        if (environ.get('HTTP_ORIGIN') != ORIGIN or
                not hmac.compare_digest(environ.get('HTTP_X_DEMO_TOKEN', '').encode(), server.NONCE.encode())):
            return respond('403 Forbidden', {'error': '请从本站刷新页面后重试'})
        try:
            length = int(environ.get('CONTENT_LENGTH', '0'))
            if not 0 < length < 4096:
                raise ValueError('请求大小不正确')
            payload = json.loads(environ['wsgi.input'].read(length))
            result = server.calculate(payload)
            return respond('200 OK', result)
        except (ValueError, UnicodeError) as exc:
            return respond('400 Bad Request', {'error': str(exc)})
        except Exception:
            logging.exception('DWSIM calculation failed')
            return respond('502 Bad Gateway', {'error': '计算未成功，请联系管理员查看服务日志'})
    return respond('404 Not Found', {'error': 'Not found'})
