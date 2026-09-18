# P1B Special Workflows Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Add isolated, validated HeatExchanger, Compressor, and Vessel workflows with real DWSIM calculations, web UI, QA, and browser evidence.

**Architecture:** Put P1B contracts and engine adapters in `本地演示/advanced_units.py`; keep `server.py` as the shared lifecycle, locking, persistence, and strict serialization boundary. Extend the existing curated catalog and single-page workbench without exposing generic engine properties.

**Tech Stack:** Python standard library, DWSIM MCP 10.2.8, Gunicorn WSGI, plain HTML/CSS/JavaScript, Docker, unittest, Playwright QA.

---

### Task 1: Freeze P1B schema evidence

**Files:**
- Create: `deploy/probe_p1b_schema.py`
- Create: `docs/qa/P1B-schema.md`

1. Encode loopback-only MCP access on port `15903`.
2. Probe tool schemas, initial unit results, invalid properties, port mappings, applied properties, and one real closure case per device.
3. Require every flowsheet to close in `finally` and serialize with `allow_nan=False`.
4. Run against `ecop-p1b-dwsim`; save JSON and SHA-256 under `.local/qa/P1B`.

### Task 2: Write failing contract and adapter tests

**Files:**
- Create: `deploy/test_advanced_units.py`

1. Add valid normalization tests for all three contracts.
2. Add bounds and cross-field rejection tests, including compressor liquid rejection.
3. Add replay tools for baseline results and inject `NaN`, `+Inf`, and `-Inf` into every workflow.
4. Assert rejection before success return; reuse server-level no-record, close, and lock guarantees.
5. Run `python -m unittest deploy.test_advanced_units`; expect failures before implementation.

### Task 3: Implement fixed P1B engine adapters

**Files:**
- Create: `本地演示/advanced_units.py`
- Modify: `本地演示/server.py`
- Modify: `deploy/Dockerfile`

1. Implement numeric validation and per-module cross-field constraints.
2. Implement HeatExchanger four-port construction and two-side heat balance.
3. Implement Compressor vapor-only boundary, pressure/efficiency settings, and power check.
4. Implement Heater-conditioned two-phase feed followed by Vessel separation and phase/energy closure.
5. Dispatch definitions from `server.calculate`, retain strict JSON persistence and cleanup.
6. Run advanced, basic, and cloud adapter tests.

### Task 4: Expose curated web workflows

**Files:**
- Modify: `本地演示/catalog.py`
- Modify: `本地演示/index.html`
- Modify: `deploy/test_cloud_adapter.py`

1. Mark exactly nine unit types live and set workspace modes.
2. Add three forms, module metrics, result rows, condition summaries, and flow labels.
3. Keep generic history, comparison, download, and input invalidation paths.
4. Keep mobile tabs visible without horizontal scrolling.
5. Run static JavaScript syntax and cloud page tests.

### Task 5: Add fixed real-engine QA

**Files:**
- Create: `deploy/qa_cases/advanced_units.json`
- Create: `deploy/run_p1b_qa.py`
- Create: `deploy/browser_p1b_qa.py`
- Modify: `deploy/smoke_test.py`

1. Predeclare two real cases and rejection cases per device plus tolerances.
2. Reject non-loopback candidate endpoints and strict-parse JSON.
3. Assert closure metrics, security statuses, and run IDs.
4. Extend browser QA for all three new modules, comparison, download, 1440/390 overflow, console, and page errors.
5. Preserve original six and P1A regression checks.

### Task 6: Build and verify isolated candidate

**Files:**
- Create: `docs/qa/P1B-candidate.md`
- Modify: `docs/qa/capability-matrix.csv`
- Modify: `README.md`
- Modify: `deploy/README.md`

1. Build a fixed `ecop:p1b-candidate` image from the working tree.
2. Run `ecop-p1b-web` against `ecop-p1b-dwsim` on an internal network and independent data volume.
3. Run unit, real-engine, regression, security, and Playwright suites.
4. Record image IDs, starts, raw run IDs, values, evidence hashes, limitations, and rollback.
5. Commit and push the candidate, report to total control, and HOLD production/P2.

