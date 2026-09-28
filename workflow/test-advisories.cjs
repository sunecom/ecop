"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkflowStore, createHttpServer, createTestAuthProvider } = require("./workflow-service.cjs");
const advisories = require("./advisories.cjs");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ecop-advisory-"));
  const store = new WorkflowStore(path.join(directory, "workflow.sqlite"));
  store.createProject("project-one", "Advisory test", [
    { user_id: "demo-customer", role: "customer" },
    { user_id: "demo-engineer", role: "engineer" },
  ]);
  return { directory, store };
}

function input(revision) {
  return {
    actor_id: "demo-engineer",
    advisory_key: "continue-current-route",
    source_revision: revision,
    stage_id: "pfd",
    summary: "继续当前已确认路线",
    body_markdown: "保留当前已确认条件，后续补充适用性证据；本建议不构成审核批准。",
  };
}

test("advisory publish is idempotent, revision-bound, and does not mutate project state", () => {
  const value = fixture();
  try {
    const before = value.store.readProject("project-one", "demo-engineer").project;
    const first = advisories.publish(value.store, "project-one", input(before.revision));
    const second = advisories.publish(value.store, "project-one", { ...input(before.revision), summary: "更新后的同键建议" });
    const after = value.store.readProject("project-one", "demo-engineer").project;
    assert.equal(first.ok, true);
    assert.equal(second.advisory.summary, "更新后的同键建议");
    assert.equal(value.store.database.prepare("SELECT COUNT(*) AS count FROM project_advisories").get().count, 1);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(Object.fromEntries(Object.entries(after.stages).map(([id, stage]) => [id, stage.status])),
      Object.fromEntries(Object.entries(before.stages).map(([id, stage]) => [id, stage.status])));
    assert.throws(() => advisories.publish(value.store, "project-one", { ...input(before.revision), body_markdown: "contains a password marker" }), /内部引用/);
  } finally {
    value.store.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("advisory HTTP route is member-only and read-only", async () => {
  const value = fixture();
  const project = value.store.readProject("project-one", "demo-engineer").project;
  advisories.publish(value.store, "project-one", input(project.revision));
  const server = createHttpServer({ store: value.store, authProvider: createTestAuthProvider() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (actor, method = "GET") => fetch(`${origin}/api/workflow/projects/project-one/advisories`, {
    method,
    headers: { "X-Workflow-Test-Actor": actor, ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}) },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  try {
    const member = await request("demo-customer");
    assert.equal(member.status, 200);
    assert.equal((await member.json()).advisories.length, 1);
    assert.equal((await request("demo-reviewer")).status, 404);
    assert.equal((await request("demo-engineer", "POST")).status, 405);
  } finally {
    await new Promise(resolve => server.close(resolve));
    value.store.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});
