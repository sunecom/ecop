# ECOP Workflow

This directory contains the public application source for the ECOP workflow service and browser workspace. It does not include customer documents, private calculation evidence, production databases, credentials, or deployment secrets.

## Collaboration

- `codex/` branches carry the workflow state machine, HTTP service, adapters, tests, and integration baseline.
- Gates may submit the visual and responsive frontend independently from a separate branch.
- The version running at `https://ecop.aitomoney.online/workflow/` must expose a release identifier that resolves to a Git commit SHA.
- Online acceptance is performed against `/workflow/`; localhost previews are development aids only.

## Local verification

Requires Node.js 24 or a compatible release with `node:sqlite`.

```powershell
node test-workflow-engine.cjs
node test-workflow-service.cjs
node test-workflow-controller.cjs
node test-workflow-report.cjs
node test-requirements-schema.cjs
node test-business-ui-copy.cjs
node test-agent-context.cjs
node --test test-advisories.cjs test-review-drafts.cjs test-business-status-backend.cjs test-calc-delivery.cjs test-reco-stage.cjs test-runtime-packaging.cjs
```

The included synthetic test tokens are fixed test fixtures and are not production credentials.

## Deployment boundary

Production authentication is supplied by the existing trusted application proxy. Runtime tokens are read from mounted secret files and must never be committed. Customer project databases and private evidence mounts remain outside this repository.

The production Compose and reverse-proxy files remain environment-specific and are intentionally not copied into this public application directory. They are validated separately before each release.

## Controlled service interfaces

- `GET /api/workflow/projects/:project_id/advisories` is member-only and read-only. Advisory publication is an operator-only library call and never changes project or stage revisions.
- `GET /api/workflow/projects/:project_id/review-drafts` and `GET .../review-drafts/:document_id` expose only registered metadata/files after membership, project-revision, byte-length, and SHA-256 checks. They never expose server paths and always report `engineering_release: false`.
- Taskbook v2 accepts the simplified worksheet while `taskbook-template-v1.xlsx` preserves the legacy four-sheet parser path. Taskbook application remains revision-bound.
- `calculation-delivery.cjs` is an operator-only delivery path for already-produced real-engine results with provenance. It does not run DWSIM, Aspen Plus, or Aspen EDR and does not expose a client result-write route.
- `business-status.cjs` is a read-only projection. A delivered calculation may be shown as awaiting review, but only an authenticated reviewer action can confirm the workflow stage.
