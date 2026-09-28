"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { projectBusinessStatus } = require("./business-status.cjs");

function result() {
  return {
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
    checks: { mass_balance: "pass" },
    results: { product_flow_kg_h: 100 },
    assumptions: ["synthetic test assumption"],
    boundary: "Synthetic test boundary; not an engineering release.",
  };
}

test("business status exposes real calculation as reviewable without confirming it", () => {
  const stage = status => ({ status, revision: 1, payload: null });
  const project = {
    project_id: "project-one",
    revision: 8,
    stages: {
      requirements: stage("confirmed"), selection: stage("confirmed"), pfd: stage("confirmed"),
      calculation: { ...stage("submitted"), payload: result() },
      equipment: stage("draft"), documents: stage("draft"),
    },
  };
  const store = { database: { prepare: () => ({ get: () => undefined, all: () => [] }) } };
  const status = projectBusinessStatus(store, project.project_id, { project });
  const calculation = status.stages.find(item => item.id === "calculation");
  assert.equal(calculation.display, "delivered_review");
  assert.equal(calculation.stage_status, "submitted");
  assert.equal(status.calculation_review.delivered, true);
  assert.equal(status.calculation_review.reviewable, true);
  assert.equal(status.next_action.key, "calculation_review");
});
