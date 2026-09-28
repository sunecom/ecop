"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkflowStore, createHttpServer, createTestAuthProvider } = require("./workflow-service.cjs");
const { ReviewDraftsCatalog } = require("./review-drafts.cjs");

test("review drafts enforce membership, pinned revision, and registered file hash", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ecop-review-drafts-"));
  const filePath = path.join(directory, "draft.txt");
  const body = Buffer.from("synthetic review draft", "utf8");
  fs.writeFileSync(filePath, body);
  const store = new WorkflowStore(path.join(directory, "workflow.sqlite"));
  const project = store.createProject("project-one", "Review drafts test", [
    { user_id: "demo-customer", role: "customer" },
  ]);
  const catalog = new ReviewDraftsCatalog({
    delivery_id: "delivery-one",
    project_id: project.project_id,
    project_revision: project.revision,
    documents: [{
      id: "technical-proposal",
      name: "技术方案评审稿.txt",
      path: filePath,
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
      content_type: "text/plain; charset=utf-8",
    }],
  });
  const server = createHttpServer({ store, authProvider: createTestAuthProvider(), reviewDrafts: catalog });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (actor, suffix = "", method = "GET") => fetch(`${origin}/api/workflow/projects/project-one/review-drafts${suffix}`, {
    method,
    headers: { "X-Workflow-Test-Actor": actor, ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}) },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  try {
    const list = await request("demo-customer");
    const listed = await list.json();
    assert.equal(list.status, 200);
    assert.equal(listed.review_drafts.engineering_release, false);
    assert.equal(JSON.stringify(listed).includes(filePath), false);
    const downloaded = await request("demo-customer", "/technical-proposal");
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), body);
    assert.equal((await request("demo-engineer")).status, 404);
    assert.equal((await request("demo-customer", "", "POST")).status, 405);
    fs.writeFileSync(filePath, "tampered", "utf8");
    assert.equal((await request("demo-customer", "/technical-proposal")).status, 500);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
