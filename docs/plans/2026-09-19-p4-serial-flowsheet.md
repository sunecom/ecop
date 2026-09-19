# P4 Serial Flowsheet Implementation Plan
> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver the isolated P4 pure-water preheat, evaporation, and vapor-liquid separation template as one real DWSIM flowsheet, with auditable closure checks and P3 project interoperability.

**Architecture:** Add a dedicated P4 workflow module called by the existing calculation service. It creates `FEED → H-01 → PREHEATED → EV-01 → TWO-PHASE → V-01 → VAPOR + LIQUID` in one flowsheet and returns only finite, relevant stream/unit evidence. Reuse the existing project versioning and controlled DWXML export path after workflow validation succeeds.

**Tech Stack:** Python standard library HTTP service, DWSIM MCP, existing browser JavaScript, unittest.

---

### Task 1: Implement the fixed serial workflow

**Files:**
- Create: `本地演示/p4_serial.py`
- Modify: `本地演示/server.py`

1. Add the fixed input contract and explicit SI conversion.
2. Create all three unit operations and five material streams in one MCP flowsheet, then run one solve.
3. Read only mixture/vapor state fields, reject non-finite values and invalid preheat/two-phase/product states.
4. Calculate per-section mass and enthalpy-flow balances from stream results; save/export only after all checks pass.

### Task 2: Add discriminating workflow tests

**Files:**
- Create: `deploy/test_p4_serial.py`

1. Replay a closed serial topology and verify configuration, unit ordering, flow split, heat duties, and closure metrics.
2. Reject preheat vaporization, missing calculated objects, invalid stream numbers, and failed solves.
3. Verify the normalized request contract rejects out-of-range and non-finite inputs.

### Task 3: Expose the controlled template

**Files:**
- Modify: `本地演示/catalog.py`
- Modify: `本地演示/index.html`

1. Add a dedicated live catalog card and workbench form with only the frozen inputs.
2. Render intermediate stream and unit closure information without displaying raw phase-composition payloads.
3. Preserve existing project load, immutable version, comparison, JSON export, and DWXML handoff paths.

### Task 4: Validate in the isolated candidate

**Files:**
- Create: `.local/qa/P4/*` (ignored evidence only)

1. Run focused unit tests and existing regression tests.
2. Deploy only the `ecop-p4` candidate and collect baseline, perturbation, and rejection evidence from real DWSIM.
3. Validate project version/comparison/export and Chrome at 1440×390 before assembling the formal candidate package.
