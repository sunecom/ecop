# Workflow review draft response headers

The deployed Web proxy drops the SHA-256 and engineering-release headers emitted by the workflow service. The browser correctly rejects downloads whose required hash header is missing even when the body matches the catalog.

This patch only forwards `X-Review-Draft-Sha256` and `X-Review-Draft-Engineering-Release` through the existing response allowlist. Authentication, project state and browser integrity checks stay intact. The full deployed application is intentionally not included here.

Run `apply_cloud_app_proxy_headers.py --source <saved-cloud_app.py> --output <candidate.py>` against the exact SHA-256-guarded source. Then run `test_proxy_headers.py --candidate <candidate.py>` and `node test_workspace_download_callback.cjs <workspace-ui.js>`. These tests use synthetic upstream responses and DOM events, not a real browser.

Release only the reviewed candidate using the existing Web container configuration. Independently check public login, all three file bodies AND their response headers, anonymous denial and unchanged project revision. Do not use an internal API or HTTP 200 alone as download acceptance.
