"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { projectBusinessStatus } = require("./business-status.cjs");

function result(inputRevision = 2, pfdRevision = 7) {
  return {
    input_revision: inputRevision,
    pfd_revision: pfdRevision,
    model_version: "synthetic-test-model",
    software_version: "DWSIM 10.2.8",
    property_method: "NRTL",
    status: "success",
    execution_mode: "real_engine",
    engine: { name: "DWSIM", version: "10.2.8" },
    evidence: [
      { kind: "flowsheet_model", sha256: "a".repeat(64), bytes: 10 },
      { kind: "results_record", sha256: "b".repeat(64), bytes: 20 },
    ],
    evidence_refs: ["flowsheet_model", "results_record"],
    checks: { mass_balance: "pass" },
    results: { product_flow_kg_h: 100 },
    assumptions: ["synthetic test assumption"],
    missing: [],
    boundary: "Synthetic test boundary; not an engineering release.",
  };
}

function project(calculationOverrides = {}, downstreamStatus = "stale") {
  const stage = (status, revision, payload = null, dependsOn = []) => ({ status, revision, payload, depends_on: dependsOn });
  return {
    project_id: "project-one",
    revision: 65,
    stages: {
      requirements: stage("confirmed", 2),
      selection: stage("confirmed", 1),
      pfd: stage("confirmed", 7, { nodes: [{ id: "pfd-r7" }] }, [{ stage_id: "selection", revision: 1 }]),
      calculation: {
        ...stage("submitted", 5, result(), [{ stage_id: "pfd", revision: 7 }]),
        ...calculationOverrides,
      },
      equipment: stage(downstreamStatus, 10, { items: [] }, [{ stage_id: "calculation", revision: 4 }]),
      documents: stage(downstreamStatus, 10, { deliverables: [] }, [{ stage_id: "equipment", revision: 10 }]),
    },
  };
}

function store(rows = []) {
  return {
    database: {
      prepare(sql) {
        if (sql.includes("sqlite_master")) return { get: () => ({ name: "manual_reviews" }) };
        return { all: () => rows };
      },
    },
  };
}

function selectedReview() {
  return {
    id: "review-selection-old",
    status: "selected",
    choice: "old-choice",
    response_json: JSON.stringify({ workflow_stage: "selection" }),
    created_at: "2026-09-27T00:00:00Z",
    updated_at: "2026-09-27T00:00:00Z",
  };
}

test("current submitted real calculation is reviewable", () => {
  const value = projectBusinessStatus(store(), "project-one", { project: project() });
  const calculation = value.stages.find(item => item.id === "calculation");
  assert.equal(calculation.display, "delivered_review");
  assert.deepEqual(value.calculation_review, {
    delivered: true,
    current: true,
    historical: false,
    reviewable: true,
    confirmed: false,
  });
  assert.equal(value.next_action.key, "calculation_review");
});

test("stale real payload is historical and old selected review cannot override recalculation", () => {
  const stale = project({ status: "stale", revision: 4, payload: result(2, 2), depends_on: [{ stage_id: "pfd", revision: 2 }] });
  const value = projectBusinessStatus(store([selectedReview()]), "project-one", { project: stale });
  const calculation = value.stages.find(item => item.id === "calculation");
  assert.equal(calculation.display, "stale");
  assert.equal(calculation.label, "需更新");
  assert.equal(value.calculation_review.delivered, false);
  assert.equal(value.calculation_review.historical, true);
  assert.equal(value.calculation_review.reviewable, false);
  assert.equal(value.next_action.key, "recalculate");
  assert.equal(value.next_action.owner, "柯大侠");
});

test("submitted real payload with mismatched dependency revision is not current", () => {
  const mismatch = project({ depends_on: [{ stage_id: "pfd", revision: 6 }] });
  const value = projectBusinessStatus(store(), "project-one", { project: mismatch });
  assert.equal(value.calculation_review.delivered, false);
  assert.equal(value.calculation_review.historical, true);
  assert.equal(value.calculation_review.reviewable, false);
  assert.equal(value.next_action.key, "recalculate");
});

test("current confirmed calculation advances to equipment update", () => {
  const confirmed = project({ status: "confirmed" });
  const value = projectBusinessStatus(store(), "project-one", { project: confirmed });
  assert.equal(value.calculation_review.current, true);
  assert.equal(value.calculation_review.confirmed, true);
  assert.equal(value.calculation_review.reviewable, false);
  assert.equal(value.next_action.key, "equipment_update");
});

test("draft and returned real payloads remain historical rather than delivered", () => {
  for (const status of ["draft", "returned"]) {
    const value = projectBusinessStatus(store(), "project-one", { project: project({ status }) });
    assert.equal(value.calculation_review.delivered, false, status);
    assert.equal(value.calculation_review.historical, true, status);
    assert.equal(value.calculation_review.reviewable, false, status);
    assert.equal(value.next_action.key, "recalculate", status);
  }
});
