"""Exercise the real workflow proxy function with a controlled fake upstream."""

from __future__ import annotations

import argparse
import ast
from io import BytesIO
import json
from pathlib import Path
import types
from urllib.parse import quote, urlsplit


SAFE_HASH = "a" * 64


class FakeResponse:
    def __init__(self, headers: dict[str, str], payload: bytes = b"draft-bytes") -> None:
        self.status = 200
        self.reason = "OK"
        self.headers = {name.lower(): value for name, value in headers.items()}
        self.payload = payload

    def read(self, limit: int) -> bytes:
        assert limit > len(self.payload)
        return self.payload

    def getheader(self, name: str) -> str | None:
        return self.headers.get(name.lower())


class FakeConnection:
    response: FakeResponse
    requests: list[dict[str, object]] = []

    def __init__(self, host: str, port: int, timeout: int) -> None:
        assert host == "localhost"
        assert port == 18922
        assert timeout == 20

    def request(self, method: str, route: str, body=None, headers=None) -> None:
        self.requests.append({"method": method, "route": route, "body": body, "headers": headers})

    def getresponse(self) -> FakeResponse:
        return self.response

    def close(self) -> None:
        return None


def load_proxy_function(path: Path):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    matches = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "workflow_proxy_request"]
    if len(matches) != 1:
        raise RuntimeError("candidate must contain exactly one workflow_proxy_request function")
    namespace = {
        "http": types.SimpleNamespace(client=types.SimpleNamespace(HTTPConnection=FakeConnection)),
        "quote": quote,
        "WORKFLOW_PROXY_REQUEST_MAX_BYTES": 512 * 1024,
        "WORKFLOW_PROXY_RESPONSE_MAX_BYTES": 4 * 1024 * 1024,
        "WORKFLOW_BACKEND": urlsplit("http://localhost:18922"),
        "WORKFLOW_PROXY_TOKEN": "t" * 32,
        "AUTHENTICATED_USERNAMES": ("ecop",),
        "WORKFLOW_SOURCE_USERNAMES": ("ecop",),
    }
    module = ast.Module(body=matches, type_ignores=[])
    ast.fix_missing_locations(module)
    exec(compile(module, str(path), "exec"), namespace)
    return namespace["workflow_proxy_request"]


def exercise(proxy_function, upstream_headers: dict[str, str]) -> dict[str, str]:
    FakeConnection.response = FakeResponse(upstream_headers)
    FakeConnection.requests = []
    captured: dict[str, object] = {}

    def start_response(status, headers):
        captured["status"] = status
        captured["headers"] = headers

    environ = {
        "REQUEST_METHOD": "GET",
        "PATH_INFO": "/workflow/api/workflow/projects/p/review-drafts/draft-1",
        "QUERY_STRING": "",
        "CONTENT_LENGTH": "0",
        "HTTP_ACCEPT": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "ecop_authenticated_username": "ecop",
        "wsgi.input": BytesIO(),
    }
    payload = b"".join(proxy_function(environ, start_response))
    assert payload == b"draft-bytes"
    assert captured["status"] == "200 OK"
    request = FakeConnection.requests[-1]
    assert request["route"] == "/api/workflow/projects/p/review-drafts/draft-1"
    return {name.lower(): value for name, value in captured["headers"]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, required=True)
    args = parser.parse_args()
    proxy_function = load_proxy_function(args.candidate.resolve())

    forwarded = exercise(
        proxy_function,
        {
            "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Disposition": "attachment; filename=draft.docx",
            "X-Review-Draft-Sha256": SAFE_HASH,
            "X-Review-Draft-Engineering-Release": "false",
            "Set-Cookie": "private=secret",
            "Authorization": "Bearer secret",
            "X-Internal-Trace": "private",
        },
    )
    assert forwarded["x-review-draft-sha256"] == SAFE_HASH
    assert forwarded["x-review-draft-engineering-release"] == "false"
    assert "set-cookie" not in forwarded
    assert "authorization" not in forwarded
    assert "x-internal-trace" not in forwarded

    absent = exercise(
        proxy_function,
        {
            "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Disposition": "attachment; filename=draft.docx",
        },
    )
    assert "x-review-draft-sha256" not in absent
    assert "x-review-draft-engineering-release" not in absent

    print(
        json.dumps(
            {
                "ok": True,
                "real_proxy_function": "workflow_proxy_request",
                "correct_headers_forwarded": True,
                "missing_headers_remain_missing": True,
                "sensitive_unlisted_headers_blocked": ["Set-Cookie", "Authorization", "X-Internal-Trace"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
