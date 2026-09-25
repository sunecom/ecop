"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createSyntheticAdapter } = require("./synthetic-adapter.js");
const { createController } = require("./workflow-controller.js");

function makeController(adapter = createSyntheticAdapter()) {
  const snapshots = [];
  const controller = createController({ adapter, render: state => snapshots.push({ revision: state.project && state.project.revision, actorId: state.actorId }) });
  controller.load();
  return { controller, adapter, snapshots };
}

function confirmCurrent(controller, stageId) {
  assert.equal(controller.submit(stageId).ok, true);
  assert.equal(controller.setActor("demo-reviewer").ok, true);
  assert.equal(controller.confirm(stageId).ok, true);
}

test("controller loads six stages, simulates roles, comments, submit/return/confirm", () => {
  const { controller } = makeController();
  assert.equal(controller.state.project.members.length, 4);
  assert.deepEqual(controller.stageIds, ["requirements", "selection", "pfd", "calculation", "equipment", "documents"]);
  assert.equal(controller.saveStage("requirements", { specification: "synthetic demo" }).ok, true);
  assert.equal(controller.comment("requirements", "请补来源定位").ok, true);
  assert.equal(controller.state.project.stages.requirements.comments[0].text, "请补来源定位");
  assert.equal(controller.submit("requirements").ok, true);
  assert.equal(controller.state.project.stages.requirements.status, "submitted");
  assert.equal(controller.returnStage("requirements").error.code, "FORBIDDEN");
  assert.equal(controller.setActor("demo-reviewer").ok, true);
  assert.equal(controller.returnStage("requirements").ok, true);
  assert.equal(controller.state.project.stages.requirements.status, "returned");
  assert.equal(controller.setActor("demo-customer").ok, true);
  assert.equal(controller.saveStage("requirements", { specification: "revised synthetic" }).ok, true);
  confirmCurrent(controller, "requirements");
  assert.equal(controller.state.project.stages.requirements.status, "confirmed");
});

test("stale controller writes report revision conflict and reload latest state", () => {
  const adapter = createSyntheticAdapter();
  const first = makeController(adapter).controller;
  const stale = makeController(adapter).controller;
  assert.equal(first.comment("requirements", "version one").ok, true);
  const rejected = stale.saveStage("requirements", { specification: "stale write" });
  assert.equal(rejected.error.code, "REVISION_CONFLICT");
  assert.equal(stale.state.project.revision, first.state.project.revision);
  assert.equal(stale.state.notice.code, "REVISION_CONFLICT");
});

test("independent page bundles use separate idempotency IDs and surface revision conflicts", () => {
  const source = fs.readFileSync(require.resolve("./workflow-controller.js"), "utf8");
  const loadIsolatedController = instanceId => {
    const sandbox = { crypto: { randomUUID: () => instanceId } };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(source, sandbox);
    return sandbox.ECOPWorkflowController.createController;
  };
  const adapter = createSyntheticAdapter();
  const createFirst = loadIsolatedController("tab-instance-one");
  const createSecond = loadIsolatedController("tab-instance-two");
  const first = createFirst({ adapter });
  const second = createSecond({ adapter });
  first.load();
  second.load();
  assert.equal(first.saveStage("requirements", { source: "first tab" }).ok, true);
  const conflict = second.saveStage("requirements", { source: "stale tab" });
  assert.equal(conflict.error.code, "REVISION_CONFLICT");
});

test("confirmed export freezes one revision containing all stage payload snapshots", () => {
  const { controller } = makeController();
  controller.saveStage("requirements", { spec: "synthetic requirements" });
  confirmCurrent(controller, "requirements");
  for (const stageId of ["selection", "pfd", "calculation", "equipment", "documents"]) {
    controller.setActor("demo-engineer");
    const payload = stageId === "calculation" ? {
      input_revision: controller.state.project.stages.requirements.revision,
      pfd_revision: controller.state.project.stages.pfd.revision,
      model_version: "0.1-synthetic",
      software_version: "browser-demo", property_method: "synthetic", status: "success",
      checks: { balance: "pass" }, assumptions: [], missing: [], evidence_refs: [],
    } : { sample: stageId };
    assert.equal(controller.saveStage(stageId, payload).ok, true);
    confirmCurrent(controller, stageId);
  }
  controller.setActor("demo-lead");
  const frozen = controller.freezeAndExport();
  assert.equal(frozen.ok, true);
  assert.equal(frozen.exportVersion.project_revision, frozen.project.revision);
  assert.equal(frozen.exportVersion.frozen, true);
  for (const stageId of controller.stageIds) {
    assert.equal(frozen.exportVersion.stages[stageId].status, "confirmed");
    assert.ok(frozen.exportVersion.stages[stageId].payload);
  }
  assert.equal(controller.saveStage("requirements", { spec: "blocked" }).error.code, "FORBIDDEN");
});

test("controller uses an injected adapter and exposes only local simulated identity", () => {
  const calls = [];
  const project = { project_id: "injected", revision: 4, title: "fixture", members: [{ user_id: "reviewer", role: "reviewer" }], stages: {}, audit: [] };
  const adapter = {
    mode: "synthetic_local",
    load: projectId => ({ ok: projectId === "injected", project: structuredClone(project) }),
    action: action => { calls.push(action); return { ok: false, error: { code: "REVISION_CONFLICT", message: "Conflict" } }; },
  };
  const controller = createController({ adapter, projectId: "injected", actorId: "reviewer" });
  controller.load();
  const result = controller.comment("requirements", "test");
  assert.equal(result.error.code, "REVISION_CONFLICT");
  assert.equal(calls[0].expected_revision, 4);
  assert.equal(calls[0].actor_id, "reviewer");
});

test("controller selects and resumes only a safe project identifier", () => {
  const adapter = {
    mode: "demo_proxy",
    load: projectId => ({ ok: true, project: {
      project_id: projectId, revision: 3, title: `synthetic ${projectId}`,
      members: [{ user_id: "demo-customer", role: "customer" }], stages: {}, audit: [], frozen: false,
    } }),
    action: () => ({ ok: false }),
  };
  const controller = createController({ adapter, projectId: "synthetic-one" });
  controller.load();
  const resumed = controller.selectProject("synthetic-two");
  assert.equal(resumed.ok, true);
  assert.equal(controller.state.projectId, "synthetic-two");
  assert.equal(controller.state.project.project_id, "synthetic-two");
  assert.equal(controller.state.selectedStageId, "requirements");
  assert.equal(controller.selectProject("../outside").error.code, "INVALID_INPUT");
});
