"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveWorkflowView } = require("./workflow-view.js");

function result(inputRevision = 2, pfdRevision = 7) {
  return {
    input_revision: inputRevision,
    pfd_revision: pfdRevision,
    execution_mode: "real_engine",
    engine: { name: "DWSIM", version: "10.2.8" },
    evidence: [
      { kind: "flowsheet_model", sha256: "a".repeat(64), bytes: 10 },
      { kind: "results_record", sha256: "b".repeat(64), bytes: 20 },
    ],
    assumptions: ["synthetic assumption"],
    boundary: "Synthetic boundary",
    results: { duty_kw: 10 },
  };
}

function project(calculationOverrides = {}) {
  const stage = (status, revision, payload = null, dependsOn = []) => ({ status, revision, payload, depends_on: dependsOn });
  return {
    project_id: "project-one",
    revision: 65,
    stages: {
      requirements: stage("confirmed", 2, { taskbook: {} }),
      selection: stage("confirmed", 1),
      pfd: stage("confirmed", 7),
      calculation: {
        ...stage("submitted", 5, result(), [{ stage_id: "pfd", revision: 7 }]),
        ...calculationOverrides,
      },
      equipment: stage("stale", 10),
      documents: stage("stale", 10),
    },
  };
}

function selectedReview() {
  return {
    id: "selection-review",
    status: "selected",
    choice: "old-choice",
    response: {
      workflow_stage: "selection",
      options: [{ id: "old-choice", name: "旧名称（已验证）" }],
    },
  };
}

test("backend projection keeps historical proposal name but warns and directs stale calculation to rerun", () => {
  const view = deriveWorkflowView({
    project: {
      project_id: "project-one",
      revision: 65,
      business_status: {
        schema: 1,
        project_id: "project-one",
        project_revision: 65,
        stages: [
          { id: "requirements", title: "需求与任务书", label: "阶段记录已确认", stage_status: "confirmed" },
          { id: "selection", title: "工艺选择", label: "阶段记录已确认", stage_status: "confirmed" },
          { id: "pfd", title: "流程与参数", label: "阶段记录已确认", stage_status: "confirmed" },
          { id: "calculation", title: "工程计算", label: "需更新", stage_status: "stale" },
          { id: "equipment", title: "设备与运行", label: "需更新", stage_status: "stale" },
          { id: "documents", title: "方案与文件", label: "需更新", stage_status: "stale" },
        ],
        selected_choices: [{ review_id: "selection-review", stage: "selection", choice: "old-choice" }],
        calculation_review: { delivered: false, current: false, historical: true, reviewable: false, confirmed: false },
        next_action: { key: "recalculate", text: "按当前已确认流程重新执行真实工程计算并交付可追溯结果。", owner: "柯大侠" },
      },
    },
    manualReviews: [selectedReview()],
  });
  assert.equal(view.realCalculationDelivered, false);
  assert.equal(view.currentProposal, "旧名称（已验证）");
  assert.match(view.currentProposalNote, /历史已保存/);
  assert.match(view.currentProposalNote, /不代表当前工程通过/);
  assert.match(view.executionSummary, /历史真实计算记录/);
  assert.match(view.nextSummary, /重新执行真实工程计算/);
  assert.equal(view.nextOwner, "柯大侠");
});

test("fallback rejects dependency mismatch and does not let old selected review control next action", () => {
  const mismatched = project({ depends_on: [{ stage_id: "pfd", revision: 6 }] });
  const view = deriveWorkflowView({ project: mismatched, manualReviews: [{ ...selectedReview(), stale: true }] });
  assert.equal(view.realCalculationDelivered, false);
  assert.equal(view.currentProposal, "旧名称（已验证）");
  assert.match(view.executionSummary, /历史真实计算记录/);
  assert.match(view.nextSummary, /重新执行真实工程计算/);
  assert.match(view.currentProposalNote, /不代表当前工程通过/);
});

test("fallback exposes valid submitted result as current and reviewable", () => {
  const view = deriveWorkflowView({ project: project() });
  assert.equal(view.realCalculationDelivered, true);
  assert.match(view.executionSummary, /待审核确认/);
  assert.match(view.nextSummary, /审阅当前流程真实计算结果/);
  assert.equal(view.stages.find(item => item.id === "calculation").label, "当前流程真实计算结果已交付 · 待审核");
});

test("fallback exposes current confirmed result and advances equipment", () => {
  const view = deriveWorkflowView({ project: project({ status: "confirmed" }) });
  assert.equal(view.realCalculationDelivered, true);
  assert.match(view.executionSummary, /已确认/);
  assert.match(view.nextSummary, /刷新设备适配/);
  assert.equal(view.nextOwner, "柯大侠");
});
