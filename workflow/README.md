# ECOP Workflow

This directory contains the public application source for the ECOP workflow service and browser workspace. It does not include customer documents, private calculation evidence, production databases, credentials, or deployment secrets.

## Collaboration

- `codex/workflow-controller` carries the workflow state machine, HTTP service, adapters, tests, and integration baseline.
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
```

The included synthetic test tokens are fixed test fixtures and are not production credentials.

## Deployment boundary

Production authentication is supplied by the existing trusted application proxy. Runtime tokens are read from mounted secret files and must never be committed. Customer project databases and private evidence mounts remain outside this repository.

The production Compose and reverse-proxy files remain environment-specific and are intentionally not copied into this public application directory. They are validated separately before each release.
