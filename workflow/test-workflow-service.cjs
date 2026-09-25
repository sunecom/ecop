"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const {
  WORKFLOW_REQUEST_MAX_BYTES,
  WorkflowStore,
  createHttpServer,
  createTestAuthProvider,
  createTrustedProxyAuthProvider,
  createDenyAllAuthProvider,
} = require("./workflow-service.cjs");
const { createHttpAdapter } = require("./http-adapter.js");
const { createController } = require("./workflow-controller.js");

const actors = {
  customer: "demo-customer",
  engineer: "demo-engineer",
  reviewer: "demo-reviewer",
  lead: "demo-lead",
};
const members = Object.entries(actors).map(([role, user_id]) => ({ user_id, role }));

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ecop-wf3-"));
  const databasePath = path.join(directory, "workflow.sqlite");
  const store = new WorkflowStore(databasePath);
  store.createProject("project-one", "Synthetic workflow", members);
  return { directory, databasePath, store };
}

function privateDraftFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ecop-private-case-"));
  const databasePath = path.join(directory, "private-case.sqlite");
  const store = new WorkflowStore(databasePath);
  store.createPrivateSourceDraft("source-case", "Private source draft", members, {
    dataProvenance: { kind: "customer_source", storage: "private_workspace" },
    executionContext: { status: "not_run", engine: null },
    requirementsPayload: {
      record_status: "draft",
      data_source_kind: "customer_source",
      fields: [{ target_field: "feed_rate", status: "source_reported", source: { position: "Sheet1!B2" } }],
      field_status_summary: { total: 1, source_reported: 1, assumed: 0, missing: 0, computed_from: "customer_field_mappings" },
      missing_fields: [],
    },
    pfdPayload: { draft_status: "draft", nodes: [{ id: "inlet", kind: "process_inlet", label: "Feed" }], connections: [] },
  });
  store.close();
  return { directory, databasePath };
}

function businessSourceFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ecop-business-source-"));
  const databasePath = path.join(directory, "source-case.sqlite");
  const sourceStore = new WorkflowStore(databasePath);
  sourceStore.createPrivateSourceDraft("source-case", "麦芽糖醇来源资料", members, {
    dataProvenance: { kind: "customer_source", storage: "private_workspace", source_document_sha256: "a".repeat(64) },
    executionContext: { status: "not_run", engine: null },
    requirementsPayload: {
      record_status: "draft",
      data_source_kind: "customer_source",
      field_status_summary: { total: 2, source_reported: 1, assumed: 0, missing: 1 },
      missing_fields: [{ target_field: "requirements.feed_concentration", source_position: "Sheet1!C2", original_unit: "wt%" }],
      fields: [
        { target_field: "requirements.feed_rate", status: "source_reported", value: "100", original_unit: "kg/h", source: { position: "Sheet1!B2" } },
        { target_field: "requirements.feed_concentration", status: "missing", value: null, original_unit: "wt%", source: { position: "Sheet1!C2" } },
      ],
    },
    pfdPayload: { draft_status: "draft", nodes: [{ id: "feed", kind: "process_inlet", label: "进料边界" }], connections: [] },
  });
  sourceStore.close();
  return { directory, databasePath };
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function closeFixture(value) {
  value.store.close();
  fs.rmSync(value.directory, { recursive: true, force: true });
}

function startServer(store, authProvider = createTestAuthProvider(), options = {}) {
  const server = createHttpServer({ store, authProvider, ...options });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve({ server, origin: `http://127.0.0.1:${address.port}` });
  }));
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function api(origin, actor, method, route, body) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(body === undefined ? {} : { Origin: origin }),
      ...(actor ? { "X-Workflow-Test-Actor": actor } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

function rawRequest(origin, requestPath, headers = {}, method = "GET", body) {
  const base = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: base.hostname,
      port: base.port,
      method,
      path: requestPath,
      headers,
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let value;
        try { value = JSON.parse(text); } catch { value = text; }
        resolve({ status: response.statusCode, body: value });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

function action(store, actor, projectId, stage, type, payload = {}, actionId = `act-${crypto.randomUUID()}`) {
  const project = store.loadProject(projectId, actor).project;
  return store.action(actor, {
    action_id: actionId,
    project_id: projectId,
    expected_revision: project.revision,
    stage_id: stage,
    type,
    payload,
  });
}

function confirmStage(store, stage, editor = actors.engineer, payload = { sample: stage }) {
  assert.equal(action(store, editor, "project-one", stage, "edit", payload).ok, true);
  assert.equal(action(store, editor, "project-one", stage, "submit").ok, true);
  assert.equal(action(store, actors.reviewer, "project-one", stage, "confirm").ok, true);
}

function confirmThroughPfd(store) {
  confirmStage(store, "requirements", actors.customer, { objective: "synthetic process" });
  confirmStage(store, "selection");
  confirmStage(store, "pfd");
}

function runWorker(databasePath, actionId) {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { WorkflowStore } = require(workerData.servicePath);
    const store = new WorkflowStore(workerData.databasePath);
    parentPort.postMessage({ ready: true });
    parentPort.once('message', () => {
      try {
        const result = store.action('demo-engineer', {
          action_id: workerData.actionId,
          project_id: 'project-one',
          expected_revision: workerData.expectedRevision,
          stage_id: 'requirements',
          type: 'comment',
          payload: { text: workerData.actionId }
        });
        parentPort.postMessage({ result });
      } catch (error) { parentPort.postMessage({ error: error.message, code: error.code }); }
      finally { store.close(); }
    });`;
  return new Worker(source, {
    eval: true,
    workerData: {
      servicePath: path.resolve(__dirname, "workflow-service.cjs"),
      databasePath,
      actionId,
      expectedRevision: 1,
    },
  });
}

function onceMessage(worker) {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

test("service defaults to deny-all and rejects body-supplied actor/role", async () => {
  const value = fixture();
  let activeServer;
  const deniedServer = await startServer(value.store, createDenyAllAuthProvider());
  activeServer = deniedServer.server;
  try {
    const page = await fetch(`${deniedServer.origin}/`);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /http-adapter\.js/);
    assert.match(pageHtml, /data-report-id="technical-proposal"/);
    assert.match(pageHtml, /data-report-id="calculation-book"/);
    assert.match(pageHtml, /data-report-id="equipment-selection-parameters"/);
    assert.match(pageHtml, /data-report-id="manifest"/);
    const localScripts = [...pageHtml.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    assert.ok(localScripts.includes("business-ui-copy.js"));
    for (const script of localScripts) {
      const scriptResponse = await fetch(`${deniedServer.origin}/${script}`);
      assert.equal(scriptResponse.status, 200, `${script} must be served by the HTTP service`);
      assert.equal(scriptResponse.headers.get("content-type"), "text/javascript; charset=utf-8", script);
      const source = await scriptResponse.text();
      assert.ok(source.length > 0, `${script} must have JavaScript content`);
      if (script === "business-ui-copy.js") assert.match(source, /ECOPBusinessUiCopy/);
    }
    const authConfig = await fetch(`${deniedServer.origin}/workflow-config.js`);
    assert.match(await authConfig.text(), /auth_required/);
    const denied = await fetch(`${deniedServer.origin}/api/workflow/projects/project-one`);
    assert.equal(denied.status, 401);
    const authenticated = await startServer(value.store, createTestAuthProvider());
    await stopServer(activeServer);
    activeServer = authenticated.server;
    const unfrozenReports = await api(authenticated.origin, actors.lead, "GET", "/api/workflow/projects/project-one/reports");
    assert.equal(unfrozenReports.status, 409);
    assert.equal(unfrozenReports.body.error.code, "NOT_FROZEN");
    const testConfig = await fetch(`${authenticated.origin}/workflow-config.js`);
    assert.match(await testConfig.text(), /test_only/);
    const spoofed = await api(authenticated.origin, actors.engineer, "POST", "/api/workflow/projects/project-one/actions", {
      action_id: "spoof", project_id: "project-one", expected_revision: 1,
      stage_id: "requirements", type: "edit", payload: {}, actor_id: actors.lead, role: "lead",
    });
    assert.equal(spoofed.status, 400);
    assert.equal(spoofed.body.error.code, "INVALID_INPUT");
  } finally {
    if (activeServer && activeServer.listening) await stopServer(activeServer);
    closeFixture(value);
  }
});

test("raw malformed path is a 400 and loopback Host/Origin are pinned to the actual authority", async () => {
  const value = fixture();
  const { server, origin } = await startServer(value.store);
  const authority = new URL(origin).host;
  try {
    const malformed = await rawRequest(origin, "/api/workflow/projects/%ZZ", {
      Host: authority,
      "X-Workflow-Test-Actor": actors.customer,
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "INVALID_REQUEST");

    const badHost = await rawRequest(origin, "/api/workflow/projects/project-one", {
      Host: "attacker.example",
      Origin: "http://attacker.example",
      "X-Workflow-Test-Actor": actors.customer,
    });
    assert.equal(badHost.status, 400);
    assert.equal(badHost.body.error.code, "INVALID_HOST");

    const spoofedOrigin = await rawRequest(origin, "/api/workflow/projects/project-one/actions", {
      Host: authority,
      Origin: "http://attacker.example",
      "X-Workflow-Test-Actor": actors.customer,
      "Content-Type": "application/json",
    }, "POST", "{}");
    assert.equal(spoofedOrigin.status, 403);
    assert.equal(spoofedOrigin.body.error.code, "ORIGIN_REQUIRED");

    const healthy = await api(origin, actors.customer, "GET", "/api/workflow/projects/project-one");
    assert.equal(healthy.status, 200);
    assert.equal(server.listening, true);
  } finally {
    await stopServer(server);
    closeFixture(value);
  }
});

test("Node request body limit is 512 KiB and accepts a 70 KiB JSON body", async () => {
  const value = fixture();
  const { server, origin } = await startServer(value.store);
  try {
    assert.equal(WORKFLOW_REQUEST_MAX_BYTES, 512 * 1024);
    const accepted = await api(origin, actors.engineer, "POST", "/api/workflow/projects/project-one/actions", {
      padding: "x".repeat(70 * 1024),
    });
    assert.equal(accepted.status, 400);
    assert.equal(accepted.body.error.code, "INVALID_INPUT");
  } finally {
    await stopServer(server);
    closeFixture(value);
  }
});

test("HTTP adapter completes six stages, mock calculation, and frozen export across restart", async () => {
  const value = fixture();
  let { server, origin } = await startServer(value.store);
  const stagePayloads = {
    requirements: { objective: "synthetic process" },
    selection: { alternatives: ["route-a"], selected_route: "route-a", rationale: "synthetic" },
    pfd: { streams: ["feed", "product"], equipment: ["V-101"], connections: [], revision_basis: "selection r1" },
    equipment: { items: [{ tag: "V-101", basis: "synthetic" }] },
    documents: { deliverables: [{ name: "synthetic-pfd" }], notes: "mock only" },
  };
  try {
    for (const stage of ["requirements", "selection", "pfd"]) {
      const editor = stage === "requirements" ? actors.customer : actors.engineer;
      for (const [type, payload, actor] of [["edit", stagePayloads[stage], editor], ["submit", {}, editor], ["confirm", {}, actors.reviewer]]) {
        const result = await api(origin, actor, "POST", "/api/workflow/projects/project-one/actions", {
          action_id: `${stage}-${type}`, project_id: "project-one",
          expected_revision: value.store.loadProject("project-one", actor).project.revision,
          stage_id: stage, type, payload,
        });
        assert.equal(result.body.ok, true, `${stage}:${type}: ${JSON.stringify(result.body)}`);
      }
    }
    const begun = await api(origin, actors.engineer, "POST", "/api/workflow/projects/project-one/calculations", {
      expected_revision: value.store.loadProject("project-one", actors.engineer).project.revision,
    });
    assert.equal(begun.status, 202);
    assert.equal(begun.body.job.execution_mode, "synthetic_mock");
    const completed = await api(origin, actors.engineer, "POST", `/api/workflow/projects/project-one/calculations/${begun.body.job.id}/complete`, {});
    assert.equal(completed.body.ok, true);
    assert.equal(completed.body.project.stages.calculation.payload.execution_mode, "synthetic_mock");

    for (const stage of ["calculation", "equipment", "documents"]) {
      const payload = stagePayloads[stage] || {};
      if (stage !== "calculation") {
        const edited = await api(origin, actors.engineer, "POST", "/api/workflow/projects/project-one/actions", {
          action_id: `${stage}-edit`, project_id: "project-one",
          expected_revision: value.store.loadProject("project-one", actors.engineer).project.revision,
          stage_id: stage, type: "edit", payload,
        });
        assert.equal(edited.body.ok, true, `${stage}:edit: ${JSON.stringify(edited.body)}`);
      }
      for (const [type, actor] of [["submit", actors.engineer], ["confirm", actors.reviewer]]) {
        const result = await api(origin, actor, "POST", "/api/workflow/projects/project-one/actions", {
          action_id: `${stage}-${type}`, project_id: "project-one",
          expected_revision: value.store.loadProject("project-one", actor).project.revision,
          stage_id: stage, type, payload: type === "submit" ? payload : {},
        });
        assert.equal(result.body.ok, true, `${stage}:${type}`);
      }
    }
    const ready = value.store.loadProject("project-one", actors.lead).project;
    assert.ok(Object.values(ready.stages).every(stage => stage.status === "confirmed"));
    const frozen = await api(origin, actors.lead, "POST", "/api/workflow/projects/project-one/freeze", { expected_revision: ready.revision });
    assert.equal(frozen.body.ok, true);
    assert.equal(frozen.body.exportVersion.frozen, true);
    const snapshot = JSON.stringify(frozen.body.exportVersion);
    const reportsBefore = await api(origin, actors.lead, "GET", "/api/workflow/projects/project-one/reports");
    assert.equal(reportsBefore.status, 200, JSON.stringify(reportsBefore.body));
    assert.equal(reportsBefore.body.documents.length, 3);
    assert.ok(reportsBefore.body.documents.every(item => item.project_revision === frozen.body.exportVersion.project_revision));
    assert.equal(new Set(reportsBefore.body.documents.map(item => item.snapshot_sha256)).size, 1);
    assert.equal(reportsBefore.body.manifest.frozen_snapshot_sha256, reportsBefore.body.documents[0].snapshot_sha256);
    const frozenRevision = frozen.body.project.revision;
    await stopServer(server);
    value.store.close();

    value.store = new WorkflowStore(value.databasePath);
    ({ server, origin } = await startServer(value.store));
    const reloaded = await api(origin, actors.lead, "GET", "/api/workflow/projects/project-one");
    assert.equal(reloaded.body.project.revision, frozenRevision);
    assert.equal(reloaded.body.project.frozen, true);
    const exported = await api(origin, actors.lead, "GET", "/api/workflow/projects/project-one/export");
    assert.equal(JSON.stringify(exported.body.exportVersion), snapshot);
    const reportsAfter = await api(origin, actors.lead, "GET", "/api/workflow/projects/project-one/reports");
    assert.equal(reportsAfter.status, 200);
    assert.deepEqual(reportsAfter.body.documents, reportsBefore.body.documents);
    assert.equal(reportsAfter.body.manifest.frozen_snapshot_sha256, reportsBefore.body.manifest.frozen_snapshot_sha256);
    const forbidden = await api(origin, actors.lead, "POST", "/api/workflow/projects/project-one/actions", {
      action_id: "after-freeze", project_id: "project-one", expected_revision: frozenRevision,
      stage_id: "requirements", type: "edit", payload: { changed: true },
    });
    assert.equal(forbidden.body.error.code, "FORBIDDEN");
    const unchanged = await api(origin, actors.lead, "GET", "/api/workflow/projects/project-one/export");
    assert.equal(JSON.stringify(unchanged.body.exportVersion), snapshot);
  } finally {
    await stopServer(server);
    if (value.store) value.store.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("business user creates and edits an isolated, persistent source working copy without changing the source snapshot", async () => {
  const value = fixture();
  const source = businessSourceFixture();
  value.store.close();
  value.store = new WorkflowStore(value.databasePath, { privateCaseDatabasePath: source.databasePath });
  const sourceHash = sha256File(source.databasePath);
  const proxyToken = "synthetic-proxy-token-for-business-tests-0123456789";
  const authProvider = createTrustedProxyAuthProvider({ token: proxyToken });
  const trustedProxy = { token: proxyToken, hostAuthority: "workflow:18922", origin: "http://workflow:18922" };
  const server = createHttpServer({ store: value.store, authProvider, trustedProxy });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function businessRequest(route, method = "GET", body, principal = "basic:authorized-user") {
    const response = await rawRequest(origin, route, {
      Host: "workflow:18922",
      "X-Workflow-Proxy-Token": proxyToken,
      ...(principal.startsWith("basic:") ? { "X-Workflow-Principal": principal } : { "X-Workflow-Test-Actor": principal }),
      ...(principal.startsWith("basic:") ? { "X-Workflow-Source-Principals": "basic:authorized-user" } : {}),
      ...(body === undefined ? {} : { Origin: "http://workflow:18922", "Content-Type": "application/json" }),
    }, method, body === undefined ? undefined : JSON.stringify(body));
    return { status: response.statusCode || response.status, body: response.body };
  }
  try {
    const home = await businessRequest("/api/workflow/projects");
    assert.equal(home.status, 200);
    assert.deepEqual(home.body.projects, []);
    assert.equal(home.body.source_templates.length, 1);
    assert.equal(home.body.source_templates[0].data_source_kind, "customer_source");

    const created = await businessRequest("/api/workflow/projects", "POST", {
      project_name: "麦芽糖醇工作项目",
      source_template_id: "workflow-private-customer-draft",
    });
    assert.equal(created.status, 201);
    const projectId = created.body.project.project_id;
    assert.notEqual(projectId, "workflow-private-customer-draft");
    assert.equal(created.body.project.data_provenance.source_snapshot_sha256, "a".repeat(64));
    assert.equal(created.body.project.stages.requirements.payload.fields.find(item => item.target_field === "requirements.feed_rate").source_snapshot_value, "100");

    const incompleteSubmit = await businessRequest(`/api/workflow/projects/${projectId}/actions`, "POST", {
      action_id: "business-submit-incomplete",
      project_id: projectId,
      expected_revision: 1,
      stage_id: "requirements",
      type: "submit",
      payload: {},
    });
    assert.equal(incompleteSubmit.status, 409);
    assert.equal(incompleteSubmit.body.error.code, "REQUIREMENTS_INCOMPLETE");

    const sourceReadOnly = await businessRequest("/api/workflow/projects/workflow-private-customer-draft");
    assert.equal(sourceReadOnly.status, 200);
    const editable = created.body.project.stages.requirements.payload;
    const changedPayload = {
      ...editable,
      fields: editable.fields.map(item => item.target_field === "requirements.feed_rate"
        ? { ...item, value: 125, unit: "kg/h" }
        : item),
    };
    const saved = await businessRequest(`/api/workflow/projects/${projectId}/actions`, "POST", {
      action_id: "business-save-v1",
      project_id: projectId,
      expected_revision: 1,
      stage_id: "requirements",
      type: "edit",
      payload: changedPayload,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.project.revision, 2);
    const feedRate = saved.body.project.stages.requirements.payload.fields.find(item => item.target_field === "requirements.feed_rate");
    assert.equal(feedRate.value, 125);
    assert.equal(feedRate.source_snapshot_value, "100");
    assert.equal(feedRate.revision_status, "modified");
    assert.equal(saved.body.project.stages.requirements.history.length, 1);
    assert.equal(saved.body.project.stages.requirements.history[0].payload.fields.find(item => item.target_field === "requirements.feed_rate").value, "100");

    const stale = await businessRequest(`/api/workflow/projects/${projectId}/actions`, "POST", {
      action_id: "business-save-stale",
      project_id: projectId,
      expected_revision: 1,
      stage_id: "requirements",
      type: "edit",
      payload: changedPayload,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "REVISION_CONFLICT");

    const mockCalculation = await businessRequest(`/api/workflow/projects/${projectId}/calculations`, "POST", { expected_revision: 2 });
    assert.equal(mockCalculation.status, 409);
    assert.equal(mockCalculation.body.error.code, "CUSTOMER_SOURCE_NOT_CALCULABLE");
    const report = await businessRequest(`/api/workflow/projects/${projectId}/reports`);
    assert.equal(report.status, 409);
    assert.equal(report.body.error.code, "CUSTOMER_SOURCE_REPORT_DISABLED");

    const demoHome = await businessRequest("/api/workflow/projects", "GET", undefined, "demo-customer");
    assert.deepEqual(demoHome.body.source_templates, []);
    const demoCreate = await businessRequest("/api/workflow/projects", "POST", { project_name: "不应创建" }, "demo-customer");
    assert.equal(demoCreate.status, 403);
    const demoSourceLoad = await businessRequest("/api/workflow/projects/workflow-private-customer-draft", "GET", undefined, "demo-customer");
    assert.equal(demoSourceLoad.status, 404);
    value.store.close();
    value.store = new WorkflowStore(value.databasePath, { privateCaseDatabasePath: source.databasePath });
    const reopened = value.store.loadProject(projectId, "basic:authorized-user").project;
    assert.equal(reopened.revision, 2);
    assert.equal(reopened.stages.requirements.history.length, 1);
    assert.equal(reopened.stages.requirements.payload.fields.find(item => item.target_field === "requirements.feed_rate").value, 125);
    assert.equal(sha256File(source.databasePath), sourceHash);
  } finally {
    await stopServer(server);
    closeFixture(value);
    fs.rmSync(source.directory, { recursive: true, force: true });
  }
});

test("source snapshot access is separately allowlisted from active accounts and project membership", async () => {
  const value = fixture();
  const source = businessSourceFixture();
  value.store.close();
  value.store = new WorkflowStore(value.databasePath, { privateCaseDatabasePath: source.databasePath });
  const sourceHash = sha256File(source.databasePath);
  const proxyToken = "synthetic-proxy-token-for-source-acl-0123456789";
  const authProvider = createTrustedProxyAuthProvider({ token: proxyToken });
  const trustedProxy = { token: proxyToken, hostAuthority: "workflow:18922", origin: "http://workflow:18922" };
  const server = createHttpServer({ store: value.store, authProvider, trustedProxy });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(principal, route, method = "GET", body) {
    const result = await rawRequest(origin, route, {
      Host: "workflow:18922",
      "X-Workflow-Proxy-Token": proxyToken,
      "X-Workflow-Principal": principal,
      "X-Workflow-Authorized-Principals": "basic:case-owner,basic:reviewer-one",
      "X-Workflow-Source-Principals": "basic:case-owner",
      ...(body === undefined ? {} : { Origin: "http://workflow:18922", "Content-Type": "application/json" }),
    }, method, body === undefined ? undefined : JSON.stringify(body));
    return { status: result.status, body: result.body };
  }
  try {
    const ownerHome = await request("basic:case-owner", "/api/workflow/projects");
    assert.equal(ownerHome.body.source_templates.length, 1);
    const reviewerHome = await request("basic:reviewer-one", "/api/workflow/projects");
    assert.deepEqual(reviewerHome.body.source_templates, []);
    assert.equal((await request("basic:reviewer-one", "/api/workflow/projects/workflow-private-customer-draft")).status, 404);
    const deniedCopy = await request("basic:reviewer-one", "/api/workflow/projects", "POST", {
      project_name: "reviewer cannot copy source",
      source_template_id: "workflow-private-customer-draft",
    });
    assert.equal(deniedCopy.status, 404);
    const copied = await request("basic:case-owner", "/api/workflow/projects", "POST", {
      project_name: "source owner working copy",
      source_template_id: "workflow-private-customer-draft",
    });
    assert.equal(copied.status, 201);
    const projectId = copied.body.project.project_id;
    const memberAdded = await request("basic:case-owner", `/api/workflow/projects/${projectId}/members`, "POST", {
      user_id: "basic:reviewer-one", role: "reviewer", expected_revision: 1,
    });
    assert.equal(memberAdded.status, 200);
    const memberRead = await request("basic:reviewer-one", `/api/workflow/projects/${projectId}`);
    assert.equal(memberRead.status, 200);
    assert.equal(memberRead.body.project.project_id, projectId);
    assert.equal(sha256File(source.databasePath), sourceHash);
  } finally {
    await stopServer(server);
    closeFixture(value);
    fs.rmSync(source.directory, { recursive: true, force: true });
  }
});

test("independent business identities complete requirements review, route selection, and PFD approval", async () => {
  const value = fixture();
  const proxyToken = "synthetic-proxy-token-for-review-tests-0123456789";
  const authProvider = createTrustedProxyAuthProvider({ token: proxyToken });
  const trustedProxy = { token: proxyToken, hostAuthority: "workflow:18922", origin: "http://workflow:18922" };
  const server = createHttpServer({ store: value.store, authProvider, trustedProxy });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const eligible = ["basic:customer-one", "basic:engineer-one", "basic:reviewer-one"];
  async function request(principal, route, method = "GET", body) {
    const result = await rawRequest(origin, route, {
      Host: "workflow:18922",
      "X-Workflow-Proxy-Token": proxyToken,
      "X-Workflow-Principal": principal,
      "X-Workflow-Authorized-Principals": eligible.join(","),
      ...(body === undefined ? {} : { Origin: "http://workflow:18922", "Content-Type": "application/json" }),
    }, method, body === undefined ? undefined : JSON.stringify(body));
    return { status: result.status, body: result.body };
  }
  async function action(principal, projectId, expectedRevision, stage, type, payload = {}) {
    return request(principal, `/api/workflow/projects/${projectId}/actions`, "POST", {
      action_id: `review-flow-${crypto.randomUUID()}`,
      project_id: projectId,
      expected_revision: expectedRevision,
      stage_id: stage,
      type,
      payload,
    });
  }
  try {
    const created = await request("basic:customer-one", "/api/workflow/projects", "POST", { project_name: "授权边界测试项目" });
    assert.equal(created.status, 201);
    const projectId = created.body.project.project_id;
    const addedReviewer = await request("basic:customer-one", `/api/workflow/projects/${projectId}/members`, "POST", {
      user_id: "basic:reviewer-one", role: "reviewer", expected_revision: 1,
    });
    assert.equal(addedReviewer.status, 200);
    const addedEngineer = await request("basic:customer-one", `/api/workflow/projects/${projectId}/members`, "POST", {
      user_id: "basic:engineer-one", role: "engineer", expected_revision: 2,
    });
    assert.equal(addedEngineer.status, 200);
    const selfReviewMember = await request("basic:customer-one", `/api/workflow/projects/${projectId}/members`, "POST", {
      user_id: "basic:customer-one", role: "reviewer", expected_revision: 3,
    });
    assert.equal(selfReviewMember.status, 403);
    const deniedMember = await request("basic:customer-one", `/api/workflow/projects/${projectId}/members`, "POST", {
      user_id: "basic:not-configured", role: "reviewer", expected_revision: 3,
    });
    assert.equal(deniedMember.status, 403);
    const reviewerProject = await request("basic:reviewer-one", `/api/workflow/projects/${projectId}`);
    assert.equal(reviewerProject.status, 200);
    assert.equal(reviewerProject.body.project.members.find(member => member.user_id === "basic:reviewer-one").role, "reviewer");
    const ownerMembers = await request("basic:customer-one", `/api/workflow/projects/${projectId}/members`);
    assert.ok(ownerMembers.body.eligible_collaborators.includes("basic:reviewer-one"));
    const reviewerMembers = await request("basic:reviewer-one", `/api/workflow/projects/${projectId}/members`);
    assert.deepEqual(reviewerMembers.body.eligible_collaborators, []);
    const unauthorizedProject = await request("basic:not-configured", `/api/workflow/projects/${projectId}`);
    assert.equal(unauthorizedProject.status, 404);

    const initial = addedEngineer.body.project.stages.requirements.payload;
    const filled = {
      ...initial,
      fields: initial.fields.map(item => ({
        ...item,
        ...(item.target_field === "requirements.feed_rate" ? { value: 100, unit: "kg/h" } : {}),
        ...(item.target_field === "requirements.feed_concentration" ? { value: 20, unit: "wt%", value_basis: "mass_percent" } : {}),
        ...(item.target_field === "requirements.product_concentration" ? { value: 65, unit: "wt%", value_basis: "mass_percent" } : {}),
        ...(item.target_field === "requirements.concentration_component" ? { value: "total_solids" } : {}),
        ...(item.target_field === "requirements.design_concentration_basis" ? { value: "质量百分数，按取样后离线检测值记录" } : {}),
        ...(item.target_field === "requirements.atmospheric_pressure" ? { value: 101.3, unit: "kPa(a)" } : {}),
      })),
    };
    const savedRequirements = await action("basic:customer-one", projectId, 3, "requirements", "edit", filled);
    assert.equal(savedRequirements.status, 200);
    const submitted = await action("basic:customer-one", projectId, 4, "requirements", "submit");
    assert.equal(submitted.status, 200);
    const returned = await action("basic:reviewer-one", projectId, 5, "requirements", "return", { reason: "请确认浓度检测方法对应的取样时间和温度。" });
    assert.equal(returned.status, 200);
    assert.match(returned.body.project.stages.requirements.last_return_reason, /取样时间/);
    const revised = structuredClone(returned.body.project.stages.requirements.payload);
    revised.fields.find(item => item.target_field === "requirements.feed_rate").value = 110;
    const savedRevision = await action("basic:customer-one", projectId, 6, "requirements", "edit", revised);
    assert.equal(savedRevision.status, 200);
    const resubmitted = await action("basic:customer-one", projectId, 7, "requirements", "submit");
    assert.equal(resubmitted.status, 200);
    const confirmedRequirements = await action("basic:reviewer-one", projectId, 8, "requirements", "confirm");
    assert.equal(confirmedRequirements.status, 200);

    const selectedRoute = await action("basic:engineer-one", projectId, 9, "selection", "edit", {
      alternatives: [{ route: "MVR", status: "selected", rationale: "reviewed project route" }], selected_route: "MVR", rationale: "selected after review", evidence_refs: [],
    });
    assert.equal(selectedRoute.status, 200);
    const submittedRoute = await action("basic:engineer-one", projectId, 10, "selection", "submit");
    assert.equal(submittedRoute.status, 200);
    const confirmedRoute = await action("basic:reviewer-one", projectId, 11, "selection", "confirm");
    assert.equal(confirmedRoute.status, 200);
    const editedPfd = await action("basic:engineer-one", projectId, 12, "pfd", "edit", {
      draft_status: "draft", process_basis: { route: "MVR", review_status: "submitted_for_review" },
      fluid_reference: { classification_status: "unverified" },
      nodes: [{ id: "feed", kind: "process_inlet", label: "项目进料", review_status: "draft" }], connections: [], questions: [],
    });
    assert.equal(editedPfd.status, 200);
    assert.equal((await action("basic:engineer-one", projectId, 13, "pfd", "submit")).status, 200);
    const confirmedPfd = await action("basic:reviewer-one", projectId, 14, "pfd", "confirm");
    assert.equal(confirmedPfd.status, 200);
    assert.equal(confirmedPfd.body.project.stages.requirements.status, "confirmed");
    assert.equal(confirmedPfd.body.project.stages.selection.payload.selected_route, "MVR");
    assert.equal(confirmedPfd.body.project.stages.pfd.status, "confirmed");
    assert.equal(confirmedPfd.body.project.audit.some(item => item.action === "return" && item.reason), true);
  } finally {
    await stopServer(server);
    closeFixture(value);
  }
});

test("demo roles cannot discover or read the private customer-source snapshot", async () => {
  const value = fixture();
  const privateCase = privateDraftFixture();
  const store = new WorkflowStore(value.databasePath, { privateCaseDatabasePath: privateCase.databasePath });
  const { server, origin } = await startServer(store);
  const beforeHash = sha256File(privateCase.databasePath);
  try {
    for (const actor of Object.values(actors)) {
      const listed = await api(origin, actor, "GET", "/api/workflow/projects");
      assert.equal(listed.status, 200);
      const privateItem = listed.body.projects.find(project => project.project_id === "workflow-private-customer-draft");
      assert.equal(privateItem, undefined);

      const loaded = await api(origin, actor, "GET", "/api/workflow/projects/workflow-private-customer-draft");
      assert.equal(loaded.status, 404);
    }

    const postCases = [
      ["/api/workflow/projects/workflow-private-customer-draft/actions", { action_id: "private-action", project_id: "workflow-private-customer-draft", expected_revision: 1, stage_id: "requirements", type: "comment", payload: { text: "no write" } }],
      ["/api/workflow/projects/workflow-private-customer-draft/calculation-failure", { action_id: "private-failure", project_id: "workflow-private-customer-draft", expected_revision: 1, failure_code: "TEST", message: "no write" }],
      ["/api/workflow/projects/workflow-private-customer-draft/calculations", { expected_revision: 1 }],
      ["/api/workflow/projects/workflow-private-customer-draft/calculations/not-a-job/complete", {}],
      ["/api/workflow/projects/workflow-private-customer-draft/freeze", { expected_revision: 1 }],
    ];
    for (const [route, body] of postCases) {
      const rejected = await api(origin, actors.engineer, "POST", route, body);
      assert.equal(rejected.status, 409, route);
      assert.equal(rejected.body.error.code, "PRIVATE_PROJECT_READ_ONLY", route);
    }

    const reports = await api(origin, actors.customer, "GET", "/api/workflow/projects/workflow-private-customer-draft/reports");
    assert.equal(reports.status, 404);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM workflow_actions").get().count, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM mock_calculation_jobs").get().count, 0);
    assert.equal(sha256File(privateCase.databasePath), beforeHash);
  } finally {
    await stopServer(server);
    store.close();
    closeFixture(value);
    fs.rmSync(privateCase.directory, { recursive: true, force: true });
  }
});

test("idempotency replay survives restart without advancing the project revision", () => {
  const value = fixture();
  const initial = value.store.loadProject("project-one", actors.customer).project;
  const command = {
    action_id: "stable-action-id", project_id: "project-one", expected_revision: initial.revision,
    stage_id: "requirements", type: "edit", payload: { objective: "stable" },
  };
  const first = value.store.action(actors.customer, command);
  value.store.close();
  value.store = new WorkflowStore(value.databasePath);
  const replay = value.store.action(actors.customer, command);
  assert.deepEqual(replay, first);
  assert.equal(value.store.loadProject("project-one", actors.customer).project.revision, first.project.revision);
  closeFixture(value);
});

test("replaceable HTTP adapter and controller use server-derived test identity", async () => {
  const value = fixture();
  const { server, origin } = await startServer(value.store);
  try {
    const adapter = createHttpAdapter({ mode: "test_only", origin });
    const controller = createController({ adapter, projectId: "project-one", actorId: actors.customer });
    assert.equal((await controller.load()).ok, true);
    const saved = await controller.saveStage("requirements", { objective: "adapter path" });
    assert.equal(saved.ok, true);
    assert.equal(saved.project.stages.requirements.payload.objective, "adapter path");
    await controller.setActor(actors.reviewer);
    const forbidden = await controller.confirm("requirements");
    assert.equal(forbidden.error.code, "FORBIDDEN");
    assert.equal(value.store.loadProject("project-one", actors.customer).project.revision, 2);
  } finally {
    await stopServer(server);
    closeFixture(value);
  }
});

test("protected DEMO adapter applies the workflow base path, same-origin, nonce, and role header", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  try {
    const adapter = createHttpAdapter({
      mode: "demo_proxy", basePath: "/workflow", origin: "https://demo.example",
      csrfToken: "synthetic-csrf-nonce", actorId: actors.engineer,
    });
    await adapter.load("project-one");
    await adapter.action({ action_id: "synthetic", project_id: "project-one", expected_revision: 1, stage_id: "requirements", type: "edit", payload: { safe: true } });
    assert.equal(requests[0].url, "https://demo.example/workflow/api/workflow/projects/project-one");
    assert.equal(requests[1].url, "https://demo.example/workflow/api/workflow/projects/project-one/actions");
    assert.equal(requests[1].options.headers.Origin, "https://demo.example");
    assert.equal(requests[1].options.headers["X-Demo-Token"], "synthetic-csrf-nonce");
    assert.equal(requests[1].options.headers["X-Workflow-Test-Actor"], actors.engineer);
    assert.equal(requests[1].options.credentials, "same-origin");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("two independent SQLite connections serialize concurrent writes at one expected revision", async () => {
  const value = fixture();
  const workerA = runWorker(value.databasePath, "parallel-a");
  const workerB = runWorker(value.databasePath, "parallel-b");
  try {
    await Promise.all([onceMessage(workerA), onceMessage(workerB)]);
    const resultsPromise = Promise.all([onceMessage(workerA), onceMessage(workerB)]);
    workerA.postMessage("go");
    workerB.postMessage("go");
    const messages = await resultsPromise;
    const outcomes = messages.map(message => message.result);
    assert.equal(outcomes.filter(outcome => outcome && outcome.ok).length, 1);
    assert.equal(outcomes.filter(outcome => outcome && outcome.error && outcome.error.code === "REVISION_CONFLICT").length, 1);
    assert.equal(value.store.loadProject("project-one", actors.customer).project.revision, 2);
  } finally {
    await Promise.all([workerA.terminate(), workerB.terminate()]);
    closeFixture(value);
  }
});

test("cross-project reads are hidden and late mock results are rejected as stale", async () => {
  const value = fixture();
  value.store.createProject("project-two", "Other synthetic project", [{ user_id: "outsider", role: "lead" }]);
  assert.throws(() => value.store.loadProject("project-two", actors.lead), error => error.code === "NOT_FOUND");
  const { server, origin } = await startServer(value.store);
  try {
    const listed = await api(origin, actors.lead, "GET", "/api/workflow/projects");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.projects.map(project => project.project_id), ["project-one"]);
    const noAuthList = await api(origin, null, "GET", "/api/workflow/projects");
    assert.equal(noAuthList.status, 401);
    const hiddenExport = await api(origin, actors.lead, "GET", "/api/workflow/projects/project-two/export");
    assert.equal(hiddenExport.status, 404);
  } finally {
    await stopServer(server);
  }
  confirmThroughPfd(value.store);
  const current = value.store.loadProject("project-one", actors.engineer).project;
  const job = value.store.beginMockCalculation(actors.engineer, "project-one", current.revision);
  assert.equal(job.ok, true);
  assert.equal(action(value.store, actors.customer, "project-one", "requirements", "edit", { objective: "revised while job runs" }).ok, true);
  const stale = value.store.completeMockCalculation(actors.engineer, "project-one", job.job.id);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "CALCULATION_STALE");
  const after = value.store.loadProject("project-one", actors.engineer).project;
  assert.notEqual(after.stages.calculation.payload && after.stages.calculation.payload.execution_mode, "synthetic_mock");
  closeFixture(value);
});

test("customer-source draft persists across restart and rejects every mock success path", async () => {
  const value = fixture();
  const projectId = "customer-source-fixture";
  value.store.createPrivateSourceDraft(projectId, "Synthetic source-protection fixture", members, {
    dataProvenance: {
      kind: "customer_source", storage: "private_local", import_status: "draft_imported",
      source_document_sha256: "a".repeat(64), mapping_sha256: "b".repeat(64),
      field_status_summary: { total: 2, source_reported: 1, assumed: 0, missing: 1 },
    },
    executionContext: { status: "not_run", mode: "no_engine_connected", engine: null, result_available: false },
    requirementsPayload: {
      record_status: "draft", data_source_kind: "customer_source",
      fields: [{ target_field: "requirements.sample", status: "source_reported", source: { position: "synthetic fixture" }, original_unit: "synthetic unit", value: "synthetic fixture only" },
        { target_field: "requirements.missing", status: "missing", source: { position: "synthetic fixture" }, original_unit: "unspecified", value: null }],
      missing_fields: [{ target_field: "requirements.missing", source_position: "synthetic fixture", original_unit: "unspecified" }],
    },
    pfdPayload: { draft_status: "draft", nodes: [], connections: [], assumptions: [], questions: [], execution_context: { status: "not_run" } },
  });
  let server;
  let origin;
  try {
    ({ server, origin } = await startServer(value.store, createTestAuthProvider(), { projectId }));
    const config = await (await fetch(`${origin}/workflow-config.js`)).text();
    assert.match(config, /test_only/);
    assert.match(config, new RegExp(projectId));
    const page = await (await fetch(`${origin}/`)).text();
    assert.match(page, /case-provenance/);
    assert.match(page, /customer-calculation-guard/);
    const before = await api(origin, actors.customer, "GET", `/api/workflow/projects/${projectId}`);
    assert.equal(before.status, 200);
    const projectBefore = before.body.project;
    assert.equal(projectBefore.data_provenance.kind, "customer_source");
    assert.equal(projectBefore.execution_context.status, "not_run");
    assert.equal(projectBefore.stages.requirements.status, "draft");
    assert.equal(projectBefore.stages.pfd.status, "draft");
    assert.equal(projectBefore.stages.calculation.payload, null);
    assert.equal(projectBefore.stages.requirements.payload.missing_fields.length, 1);

    const mockStart = await api(origin, actors.engineer, "POST", `/api/workflow/projects/${projectId}/calculations`, { expected_revision: projectBefore.revision });
    assert.equal(mockStart.status, 409);
    assert.equal(mockStart.body.error.code, "CUSTOMER_SOURCE_NOT_CALCULABLE");
    const forgedCalculation = await api(origin, actors.engineer, "POST", `/api/workflow/projects/${projectId}/actions`, {
      action_id: "synthetic-forged-success", project_id: projectId, expected_revision: projectBefore.revision,
      stage_id: "calculation", type: "edit", payload: { status: "success", execution_mode: "synthetic_mock" },
    });
    assert.equal(forgedCalculation.status, 409);
    assert.equal(forgedCalculation.body.error.code, "CUSTOMER_SOURCE_NOT_CALCULABLE");
    const freeze = await api(origin, actors.lead, "POST", `/api/workflow/projects/${projectId}/freeze`, { expected_revision: projectBefore.revision });
    assert.equal(freeze.status, 409);
    assert.equal(freeze.body.error.code, "CUSTOMER_SOURCE_EXPORT_DISABLED");
    const report = await api(origin, actors.lead, "GET", `/api/workflow/projects/${projectId}/reports`);
    assert.equal(report.status, 409);
    assert.equal(report.body.error.code, "CUSTOMER_SOURCE_REPORT_DISABLED");
    await stopServer(server);
    server = null;
    value.store.close();
    value.store = new WorkflowStore(value.databasePath);
    ({ server, origin } = await startServer(value.store, createTestAuthProvider(), { projectId }));
    const after = await api(origin, actors.customer, "GET", `/api/workflow/projects/${projectId}`);
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.project, projectBefore);
    assert.equal(after.body.project.stages.calculation.payload, null);
    assert.equal(after.body.project.data_provenance.kind, "customer_source");
    assert.equal(after.body.project.execution_context.status, "not_run");
  } finally {
    if (server && server.listening) await stopServer(server);
    closeFixture(value);
  }
});

test("trusted proxy requires a private token and pins internal Host/Origin before DEMO role simulation", async () => {
  const value = fixture();
  const proxyToken = "synthetic-proxy-token-for-tests-only-0123456789";
  const authProvider = createTrustedProxyAuthProvider({ token: proxyToken });
  const trustedProxy = { token: proxyToken, hostAuthority: "workflow:18922", origin: "http://workflow:18922" };
  const server = createHttpServer({ store: value.store, authProvider, trustedProxy, projectId: "project-one", basePath: "/workflow" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(route, headers = {}, method = "GET", body) {
    const response = await rawRequest(origin, route, { Host: "workflow:18922", ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, method, body === undefined ? undefined : JSON.stringify(body));
    return { status: response.status, text: async () => typeof response.body === "string" ? response.body : JSON.stringify(response.body), json: async () => response.body };
  }
  try {
    assert.equal((await request("/workflow-config.js")).status, 403);
    assert.equal((await request("/workflow-config.js", { "X-Workflow-Proxy-Token": "incorrect" })).status, 403);
    const badHost = await request("/workflow-config.js", { Host: "attacker.example", "X-Workflow-Proxy-Token": proxyToken });
    assert.equal(badHost.status, 400);
    const config = await request("/workflow-config.js", { "X-Workflow-Proxy-Token": proxyToken });
    assert.equal(config.status, 200);
    assert.match(await config.text(), /mode:"demo_proxy"/);
    const deniedActor = await request("/api/workflow/projects/project-one", { "X-Workflow-Proxy-Token": proxyToken });
    assert.equal(deniedActor.status, 401);
    const loaded = await request("/api/workflow/projects/project-one", {
      "X-Workflow-Proxy-Token": proxyToken,
      "X-Workflow-Test-Actor": actors.customer,
    });
    assert.equal(loaded.status, 200);
    const csrfRejected = await request("/api/workflow/projects/project-one/actions", {
      "X-Workflow-Proxy-Token": proxyToken,
      "X-Workflow-Test-Actor": actors.customer,
      Origin: "https://attacker.example",
    }, "POST", { action_id: "proxy-bad-origin", project_id: "project-one", expected_revision: 1, stage_id: "requirements", type: "edit", payload: { sample: "synthetic" } });
    assert.equal(csrfRejected.status, 403);
    const edited = await request("/api/workflow/projects/project-one/actions", {
      "X-Workflow-Proxy-Token": proxyToken,
      "X-Workflow-Test-Actor": actors.customer,
      Origin: "http://workflow:18922",
    }, "POST", { action_id: "proxy-good-origin", project_id: "project-one", expected_revision: 1, stage_id: "requirements", type: "edit", payload: { sample: "synthetic" } });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).project.revision, 2);
  } finally {
    await stopServer(server);
    closeFixture(value);
  }
});
