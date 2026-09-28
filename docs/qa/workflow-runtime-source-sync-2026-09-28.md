# Workflow Runtime Source Sync — 2026-09-28

## Scope

This candidate aligns the repository's workflow backend with the source files observed in the running `ecop-workflow-1` container. It does not deploy, modify production data, execute an engineering engine, or perform a reviewer action. The interrupted B3 controlled-calculation work from the older detached worktree is archived separately and is not included.

Baseline repository commit: `eba4535b44b6b76a134df0cd4ca8b26e8e21a0d2`.

Observed runtime image: `sha256:d4b6a7c42555b76b56e4ddd6bd8f2862302113fb5d64413ff88d0aca26ac56ed`.

The current online L1 state observed by the controller is project revision 62: PFD r6 is confirmed, calculation is stale, and equipment/documents remain draft. The older revision-61 review-draft registry correctly returns HTTP 409 under its pinned-version contract; this candidate does not rewrite that registry or production project state.

Compared GitHub refs:

- `origin/codex/workflow-controller@eba4535`
- `origin/codex/workflow-gates-rev5@135f98d`
- `origin/gates/workflow-ui-rev5.1@741beab`
- `origin/main@b8bcec5`

## Backend Source Alignment

The following files match the running container byte-for-byte:

| File | SHA-256 |
|---|---|
| `workflow/advisories.cjs` | `6dba26c6fe083cc7e5f327ea7c6951cec59dce10edf28ff132b183e2d0af54e8` |
| `workflow/calculation-delivery.cjs` | `2cce1e6dd1622cec6a70ed9344ba9615b3953e571567cbcb555dd8ee5d710987` |
| `workflow/manual-review.cjs` | `262fdd4b6d8a96b3baf2cb0d6d47094bcbab27e0df38c173faff06e60dcbf808` |
| `workflow/review-drafts.cjs` | `a3d30528d3406c4ed60e897e45774732236a0401acc7b82c6796bf3367468515` |
| `workflow/requirements-schema.js` | `7cabe7a6ed8ba8545cab7bb8f7a970e927639cc4eb362f02fadc648b5ee90465` |
| `workflow/taskbook-parser.py` | `ea3901a46cb0008376c51b05f13e18dc80f5e49b193e591ec293ebd3d2bcd7b4` |
| `workflow/taskbook-service.cjs` | `153ef4b2e36c88aae9dfc70d05554d9c5ff26741333941c7f8d709118df2444b` |
| `workflow/taskbook-template.xlsx` | `c5e7cfc06408dfb7ef58c49c7b6817024d76a2f1ab02e7dfc94303245f72cea1` |
| `workflow/taskbook-template-v1.xlsx` | `da5fb9621dc79a9e1fa933bca1bb8da7919720f6c045fc9e1aedd757407a1b90` |
| `workflow/workflow-server.cjs` | `be8142ff5e97a44621ae0fdcf40e1958edcce506e47c0a3510a0d5fb88b32266` |
| `workflow/workflow-service.cjs` | `2b7013cf8bd388710354f337094b7d8656b502b1ee6ed8bbb2a6196dbfbbf6e2` |

`workflow/business-status.cjs` intentionally differs by one dependency import: the repository candidate uses the backend `calculation-delivery.cjs` validator instead of importing the front-end-owned `workflow-view.js`. This preserves the runtime validation rule without modifying Gates-owned presentation files.

`workflow/Dockerfile` and `workflow/.dockerignore` explicitly include all backend modules and both taskbook templates. The context remains deny-by-default and does not copy a whole directory.

## Frontend Integration Contract

The program-controller branch intentionally does not modify the following Gates-owned files. Their observed runtime SHA-256 values are the integration target (or must be superseded by a separately reviewed Gates commit):

| File | Runtime SHA-256 | This branch SHA-256 |
|---|---|---|
| `workflow/app.js` | `f175344254a55e2b762c95add442d90e0944d48c25a15591364a2a479532006f` | `5b25893879001b4f79317e859e85f1bf4dfe054fb592c1ed54f8531b8ec7fbef` |
| `workflow/http-adapter.js` | `e713b0fe2f5a1043feffc24e00d6ae951528e77c45ff7f9f7db4b145cbb10e8d` | `48b3df25e6db2c564445a580aede61cff31cf4adf6105178a1486bd3aa8be8b7` |
| `workflow/index.html` | `a598169f9793b4f3b3811e2ed4cb29b10d5c132a3780d8be1fe80dabf40686b1` | `9e4f69f2dacab92c5756558da6629bf29229bba99b0b788d7fc4595608164601` |
| `workflow/taskbook-ui.js` | `af5c064cc5a851d91c6f5b05f5af3284440457196dc94a28263c217c709de8a3` | `d2bcc040dbf3ba2e9f5c661a61f0e8b1ca4c0d049d453dbba26944373002aada` |
| `workflow/workflow-view.js` | `eb19d334296b52bdcf71001b98b73aa7e7a60265dbb8e637e13cd9a2615f48d9` | `b82982de2f19095c4715648f9194207928905c3a322cc0e14a375e9730c5aec4` |
| `workflow/workspace-layout.css` | `510a1b636e5ce736dbbac67381ce0c89c1f98aaa7ddce60584d71ca65eb0bfff` | `90c74597bd51a78995f4d47809b9bfd756f484dd71e1392ce2ada6e8bd390145` |
| `workflow/workspace-ui.js` | `1a34215b560180977eaeac3fb60817298f57167dbcb049c5793cc4fb89825e11` | `72f8835e484249997612bd905528fb469064222e5beda7792f789d5e48bad41d` |

`workflow/styles.css` already matches the runtime at `7ed41b6e9abb1ee134468e09f727ba07b6ba5b17783a7cea8a0289ae0f7f943f`.

The front end may consume these backend contracts without any client-controlled file path, identity, calculation result, or reviewer decision:

- member-only read-only advisories;
- revision/hash-bound review-draft list and download;
- taskbook v2 upload/apply with v1 compatibility;
- read-only `business_status` on project reads;
- reviewer confirmation only after an operator-delivered, provenance-complete real-engine result.

## Verification

- Node syntax checks for all changed runtime modules and tests.
- Python bytecode compilation for `taskbook-parser.py`.
- Full Node suite: 78 tests passed.
- Blank template parser checks: v2 reports `ECOP-TASKBOOK-2`; legacy template reports `ECOP-TASKBOOK-1`.
- Isolated Docker build succeeded as `sha256:b4b16ef199ba70807b2ecdb5ced34c627cbba70510d7761a6c387897ae3e66ef`.
- An ephemeral candidate container used a tmpfs-only SQLite database. Project GET, empty advisory GET, and both taskbook downloads returned HTTP 200; no production volume was mounted.
- Production Workflow remained on `sha256:d4b6a7c42555b76b56e4ddd6bd8f2862302113fb5d64413ff88d0aca26ac56ed` with unchanged start time. Production DWSIM also retained its prior image and start time.

No browser acceptance or production deployment is claimed by this source-sync candidate.
