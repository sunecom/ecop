# P3 Project History and Desktop Interop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add authenticated persistent projects, immutable case versions and calculation records, controlled DWSIM export, legacy history migration, and verified desktop interoperability without touching production.

**Architecture:** Store project metadata and immutable JSON snapshots in SQLite on a dedicated Docker volume. Generate export IDs and paths only on the server, save the active DWSIM flowsheet before cleanup into a shared project volume, and expose downloads only through owner-checked ID mappings.

**Tech Stack:** Python 3.12 standard-library WSGI, `sqlite3`, DWSIM MCP 10.2.8, Docker Compose, `unittest`, Playwright/Chrome QA.

---

### Task 1: Freeze contracts and archive R03

**Files:**
- Create: `docs/plans/2026-09-19-p3-project-history-desktop-design.md`
- Create: `docs/releases/R03-2026-09-19-P2/README.md`
- Create: `docs/releases/R03-2026-09-19-P2/R03-production.md`
- Create: `docs/releases/R03-2026-09-19-P2/models-manifest.json`
- Create: `docs/releases/R03-2026-09-19-P2/backup-SHA256SUMS.txt`
- Create: `docs/releases/R03-2026-09-19-P2/ROLLBACK.md`

**Steps:**
1. Copy the released record and exact template manifest into the immutable directory.
2. Record the server backup checksum table and its own SHA-256.
3. Write concrete Web-only, full application, and data-disaster rollback commands with verification gates.
4. Compute a release-directory `SHA256SUMS` and verify every entry.
5. Commit with `docs: archive P2 R03 release`.

### Task 2: Implement immutable project storage

**Files:**
- Create: `本地演示/project_store.py`
- Create: `deploy/test_projects.py`

**Steps:**
1. Write failing tests for schema creation, stable ID validation, owner isolation, project/case/version creation, immutable history, and incompatible comparison rejection.
2. Run `python -m unittest deploy.test_projects -v`; expect failures because `project_store` does not exist.
3. Implement SQLite schema, transactions, JSON validation, stable ID helpers, project detail queries, comparison signatures, and owner-scoped lookups.
4. Add legacy JSON migration, online SQLite backup, and restore verification helpers.
5. Run `python -m unittest deploy.test_projects -v`; expect all storage tests to pass.
6. Commit with `feat: add immutable project store`.

### Task 3: Add controlled calculate-and-export APIs

**Files:**
- Modify: `本地演示/server.py`
- Modify: `本地演示/cloud_app.py`
- Modify: `本地演示/project_store.py`
- Modify: `deploy/test_projects.py`
- Modify: `deploy/test_cloud_adapter.py`

**Steps:**
1. Add failing tests for authentication, Origin/nonce, payload limits, owner mapping, invalid IDs, traversal strings, cross-owner access, failed save cleanup, and successful record/export mapping.
2. Extend `calculate` with a trusted server-only export path and call `dwsim_flowsheet_save` after validation but before `dwsim_flowsheet_close`.
3. Add owner-scoped project routes, version calculate/copy routes, record comparison, and DWSIM download with safe content headers.
4. Ensure API bodies never contain absolute filesystem paths or raw Basic Auth values.
5. Run the focused project and cloud adapter tests; expect all to pass.
6. Commit with `feat: add project APIs and DWSIM export`.

### Task 4: Add persistent project UI and container volume

**Files:**
- Create: `本地演示/project_ui.js`
- Modify: `本地演示/index.html`
- Modify: `本地演示/server.py`
- Modify: `本地演示/cloud_app.py`
- Modify: `deploy/Dockerfile`
- Modify: `deploy/compose.yaml`
- Modify: `deploy/README.md`
- Modify: `deploy/test_projects.py`

**Steps:**
1. Write a browser-contract test for the project panel, DWSIM wording, and no arbitrary path/file upload control.
2. Add a project panel supporting create, select/open, save current inputs, copy, create changed version, calculate, compare, and DWSIM download.
3. Expose a narrow bridge from the existing calculation UI to load inputs and render project results.
4. Add a dedicated `projects` volume mounted read-write at `/projects` in Web and DWSIM; keep the application filesystem read-only.
5. Copy and serve `project_ui.js`; document backup and restore expectations.
6. Run focused tests and `docker compose config`; expect valid configuration.
7. Commit with `feat: add persistent project workspace`.

### Task 5: Build and verify an isolated candidate

**Files:**
- Create: `deploy/run_p3_qa.py`
- Create: `deploy/browser_p3_qa.py`
- Create: `docs/qa/P3-schema.md`
- Create: `docs/qa/P3-candidate.md`

**Steps:**
1. Build an isolated Web image from the committed tree and start isolated Web/DWSIM containers, network, runs volume, and projects volume on loopback-only ports.
2. Run all unit tests, then real-engine project tests with a baseline, perturbation, rejection, legacy migration, persistence-after-recreate, and backup/restore case.
3. Confirm each successful project calculation creates a distinct `.dwxml`, stored SHA-256 matches download, and traversal/cross-owner attempts fail.
4. Run real Chrome at 1440 and 390 through create→save→calculate→refresh→restore→compare→download; capture screenshots and console/page errors.
5. Record candidate image/container IDs, start times, Git commit, volume names, run IDs, tolerances, and evidence hashes.

### Task 6: Verify DWSIM desktop interoperability

**Files:**
- Create: local ignored desktop driver/evidence under `.local/qa/P3/`
- Modify: `docs/qa/P3-candidate.md`

**Steps:**
1. Copy one candidate-exported `.dwxml` to the Windows QA directory without changing bytes and record SHA-256.
2. Open with the installed DWSIM 10.2.8 desktop/Automation path, explicitly recalculate, and save a new file.
3. Compare key saved XML results against the server record using predeclared tolerances; also perturb one target and prove recalculation changes the result.
4. Record executable/runtime identity, driver provenance, commands, outputs, and evidence hashes without claiming experimental accuracy.
5. Commit QA documents, push normally to `origin/main`, and report the complete candidate to total control. Stop before production deployment.

