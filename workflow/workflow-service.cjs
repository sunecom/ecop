"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { randomUUID, timingSafeEqual } = require("node:crypto");
const engine = require("./workflow-engine.js");
const { generateReportBundle } = require("./report-generator.cjs");
const requirementsSchema = require("./requirements-schema.js");

const TEST_ACTORS = Object.freeze({
  "demo-customer": Object.freeze({ user_id: "demo-customer", role: "customer" }),
  "demo-engineer": Object.freeze({ user_id: "demo-engineer", role: "engineer" }),
  "demo-reviewer": Object.freeze({ user_id: "demo-reviewer", role: "reviewer" }),
  "demo-lead": Object.freeze({ user_id: "demo-lead", role: "lead" }),
});
const PRIVATE_CASE_PROJECT_ID = "workflow-private-customer-draft";
const PRIVATE_CASE_PROJECT_TITLE = "客户来源方案草稿 · 私有只读";
const WORKFLOW_REQUEST_MAX_BYTES = 512 * 1024;

class WorkflowServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function serializableProject(project) {
  const { actionLog, ...state } = project;
  return JSON.stringify(state);
}

function copyJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function publicProject(project) {
  return JSON.parse(serializableProject(project));
}

function normalizeResult(result) {
  if (!result || typeof result !== "object") return result;
  const normalized = { ...result };
  if (normalized.project) normalized.project = publicProject(normalized.project);
  return normalized;
}

function signatureFor(entry) {
  return JSON.stringify(entry);
}

function isPositiveRevision(value) {
  return Number.isInteger(value) && value > 0;
}

function isCustomerSourceProject(project) {
  return Boolean(project && project.data_provenance && project.data_provenance.kind === "customer_source");
}

function isSyntheticProject(project) {
  return Boolean(project && project.data_provenance && project.data_provenance.kind === "synthetic_demo");
}

function isBusinessProject(project) {
  return Boolean(project && !isSyntheticProject(project));
}

function customerCalculationBlocked() {
  return { ok: false, error: { code: "CUSTOMER_SOURCE_NOT_CALCULABLE", message: "Customer-source drafts cannot be edited into or completed as a mock calculation; no engine is connected." } };
}

function privateProjectReadOnly() {
  return { ok: false, error: { code: "PRIVATE_PROJECT_READ_ONLY", message: "This customer-source project is a read-only private draft." } };
}

class PrivateCaseCatalog {
  constructor(databasePath) {
    if (typeof databasePath !== "string" || !path.isAbsolute(databasePath) || !fs.existsSync(databasePath)) {
      throw new TypeError("A mounted absolute private-case SQLite path is required.");
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
      const rows = database.prepare(
        "SELECT project_id, title, revision, state_json, frozen_snapshot_json, updated_at FROM workflow_projects",
      ).all();
      if (rows.length !== 1) throw new Error("Private-case SQLite must contain exactly one project.");
      const row = rows[0];
      const project = JSON.parse(row.state_json);
      const requirements = project.stages && project.stages.requirements && project.stages.requirements.payload;
      const pfd = project.stages && project.stages.pfd && project.stages.pfd.payload;
      const calculation = project.stages && project.stages.calculation;
      if (row.project_id !== project.project_id || row.revision !== project.revision || row.frozen_snapshot_json !== null || project.frozen !== false ||
        !isCustomerSourceProject(project) || !requirements || requirements.record_status !== "draft" || requirements.data_source_kind !== "customer_source" ||
        !pfd || pfd.draft_status !== "draft" || !project.execution_context || project.execution_context.status !== "not_run" ||
        project.execution_context.engine !== null || !calculation || calculation.payload !== null) {
        throw new Error("Private-case SQLite must contain one unfrozen customer-source draft with no calculation result.");
      }
      project.project_id = PRIVATE_CASE_PROJECT_ID;
      project.title = PRIVATE_CASE_PROJECT_TITLE;
      project.members = Object.values(TEST_ACTORS).map(actor => ({ ...actor }));
      project.read_only = true;
      project.access_scope = "shared_basic_auth_demo";
      project.actionLog = new Map();
      this.stateJson = serializableProject(project);
      this.revision = row.revision;
      this.updatedAt = row.updated_at;
    } finally {
      database.close();
    }
  }

  hasProject(projectId) {
    return projectId === PRIVATE_CASE_PROJECT_ID;
  }

  sourceTemplate() {
    const project = JSON.parse(this.stateJson);
    const requirements = project.stages.requirements.payload;
    return {
      source_template_id: PRIVATE_CASE_PROJECT_ID,
      title: "麦芽糖醇项目现有资料",
      revision: this.revision,
      data_source_kind: "customer_source",
      source_document_sha256: project.data_provenance.source_document_sha256,
      field_status_summary: copyJson(requirements.field_status_summary),
    };
  }

  getSourceProject() {
    const project = JSON.parse(this.stateJson);
    project.actionLog = new Map();
    return project;
  }

  listProjects(actorId) {
    if (!Object.hasOwn(TEST_ACTORS, actorId)) return [];
    const project = JSON.parse(this.stateJson);
    return [{
      project_id: PRIVATE_CASE_PROJECT_ID,
      title: PRIVATE_CASE_PROJECT_TITLE,
      revision: this.revision,
      frozen: false,
      read_only: true,
      access_scope: "shared_basic_auth_demo",
      updated_at: this.updatedAt,
      data_source_kind: "customer_source",
      execution_status: "not_run",
    }];
  }

  loadProject(projectId, actorId, sourceAllowed = false) {
    if (!this.hasProject(projectId) || !sourceAllowed || (!Object.hasOwn(TEST_ACTORS, actorId) && !/^basic:[A-Za-z0-9._-]{1,64}$/.test(actorId))) {
      throw new WorkflowServiceError("NOT_FOUND", "项目不存在。", 404);
    }
    const project = JSON.parse(this.stateJson);
    project.members = [{ user_id: actorId, role: "customer" }];
    project.actionLog = new Map();
    return publicProject(project);
  }
}

function checkConfirmedDependencies(project, stageId) {
  const stage = project.stages[stageId];
  return stage.depends_on.every(dependency => {
    const upstream = project.stages[dependency.stage_id];
    return upstream && upstream.status === "confirmed" && upstream.revision === dependency.revision;
  });
}

class WorkflowStore {
  constructor(databasePath, options = {}) {
    if (!databasePath) throw new TypeError("A dedicated SQLite database path is required");
    this.databasePath = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_projects (
        project_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        state_json TEXT NOT NULL,
        frozen_snapshot_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_project_sources (
        project_id TEXT PRIMARY KEY REFERENCES workflow_projects(project_id),
        source_project_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        source_sha256 TEXT NOT NULL,
        source_state_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_actions (
        project_id TEXT NOT NULL REFERENCES workflow_projects(project_id),
        action_id TEXT NOT NULL,
        signature TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, action_id)
      );
      CREATE TABLE IF NOT EXISTS mock_calculation_jobs (
        job_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES workflow_projects(project_id),
        actor_id TEXT NOT NULL,
        input_revision INTEGER NOT NULL,
        pfd_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.privateCases = options.privateCaseDatabasePath ? new PrivateCaseCatalog(options.privateCaseDatabasePath) : null;
    if (this.privateCases && this.database.prepare("SELECT 1 FROM workflow_projects WHERE project_id=?").get(PRIVATE_CASE_PROJECT_ID)) {
      this.database.close();
      throw new Error("Private-case project ID conflicts with the writable workflow database.");
    }
  }

  close() {
    this.database.close();
  }

  transaction(operation) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(this.database);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  readProject(projectId, actorId) {
    const row = this.database.prepare(
      "SELECT * FROM workflow_projects WHERE project_id=?",
    ).get(projectId);
    if (!row) throw new WorkflowServiceError("NOT_FOUND", "项目不存在。", 404);
    const project = JSON.parse(row.state_json);
    const member = project.members.find(item => item.user_id === actorId);
    if (!member) throw new WorkflowServiceError("NOT_FOUND", "项目不存在。", 404);
    project.actionLog = new Map();
    const actions = this.database.prepare(
      "SELECT action_id, signature, result_json FROM workflow_actions WHERE project_id=? ORDER BY created_at, action_id",
    ).all(projectId);
    for (const action of actions) {
      project.actionLog.set(action.action_id, {
        signature: action.signature,
        result: JSON.parse(action.result_json),
      });
    }
    return { project, member };
  }

  writeProject(database, project, frozenSnapshot) {
    const timestamp = new Date().toISOString();
    const update = database.prepare(`
      UPDATE workflow_projects
      SET title=?, revision=?, state_json=?, frozen_snapshot_json=COALESCE(?, frozen_snapshot_json), updated_at=?
      WHERE project_id=?
    `).run(project.title, project.revision, serializableProject(project), frozenSnapshot, timestamp, project.project_id);
    if (update.changes !== 1) throw new WorkflowServiceError("NOT_FOUND", "项目不存在。", 404);
  }

  persistNewAction(database, project, actionId) {
    const logEntry = project.actionLog.get(actionId);
    if (!logEntry) return false;
    const existing = database.prepare(
      "SELECT action_id FROM workflow_actions WHERE project_id=? AND action_id=?",
    ).get(project.project_id, actionId);
    if (existing) return false;
    database.prepare(`
      INSERT INTO workflow_actions(project_id, action_id, signature, result_json, created_at)
      VALUES(?,?,?,?,?)
    `).run(project.project_id, actionId, logEntry.signature,
      JSON.stringify(logEntry.result), new Date().toISOString());
    return true;
  }

  createProject(projectId, title, members) {
    const project = engine.createProject(projectId, title, members);
    project.data_provenance = { kind: "synthetic_demo", storage: "local_synthetic" };
    project.execution_context = { status: "not_run", mode: "synthetic_only", engine: null, result_available: false };
    const timestamp = new Date().toISOString();
    this.transaction(database => {
      database.prepare(`
        INSERT INTO workflow_projects(project_id,title,revision,state_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?)
      `).run(project.project_id, project.title, project.revision,
        serializableProject(project), timestamp, timestamp);
    });
    return publicProject(project);
  }

  listSourceTemplates(actorId, authorizedSourcePrincipals = []) {
    if (!this.privateCases || !authorizedSourcePrincipals.includes(actorId) || !/^basic:[A-Za-z0-9._-]{1,64}$/.test(actorId)) return [];
    return [this.privateCases.sourceTemplate()];
  }

  createBusinessProject(actorId, title, sourceTemplateId = null, authorizedSourcePrincipals = []) {
    if (!/^basic:[A-Za-z0-9._-]{1,64}$/.test(actorId)) {
      throw new WorkflowServiceError("FORBIDDEN", "只有站点认证用户可以创建业务项目。", 403);
    }
    if (typeof title !== "string" || !title.trim() || title.trim().length > 120) {
      throw new WorkflowServiceError("INVALID_INPUT", "项目名称不能为空且最多 120 个字符。", 400);
    }
    let source = null;
    if (sourceTemplateId !== null) {
      if (!this.privateCases || sourceTemplateId !== PRIVATE_CASE_PROJECT_ID || !authorizedSourcePrincipals.includes(actorId)) {
        throw new WorkflowServiceError("NOT_FOUND", "指定的只读源快照不存在。", 404);
      }
      source = this.privateCases.getSourceProject();
    }
    const projectId = `customer-${randomUUID().replaceAll("-", "")}`;
    const project = engine.createProject(projectId, title.trim(), [{ user_id: actorId, role: "customer" }]);
    project.data_provenance = source ? {
      ...copyJson(source.data_provenance),
      kind: "customer_source",
      storage: "workflow_database_editable_working_copy",
      source_snapshot_project_id: PRIVATE_CASE_PROJECT_ID,
      source_snapshot_revision: source.revision,
      source_snapshot_sha256: source.data_provenance.source_document_sha256,
    } : { kind: "customer_entered", storage: "workflow_database_editable_working_copy", source_snapshot_project_id: null };
    project.owner_id = actorId;
    project.execution_context = { status: "not_run", mode: "awaiting_engine_gate", engine: null, result_available: false };
    project.stages.requirements.payload = requirementsSchema.createRequirementsPayload(title.trim(), source && source.stages.requirements.payload);
    project.stages.pfd.payload = source ? copyJson(source.stages.pfd.payload) : {
      draft_status: "draft",
      process_basis: { route: null, review_status: "unconfirmed" },
      fluid_reference: { source_field: null, classification_status: "unverified" },
      nodes: [],
      connections: [],
      questions: [],
      execution_context: project.execution_context,
    };
    if (project.stages.pfd.payload) project.stages.pfd.payload.draft_status = "draft";
    project.stages.calculation.payload = null;
    const timestamp = new Date().toISOString();
    this.transaction(database => {
      database.prepare(`
        INSERT INTO workflow_projects(project_id,title,revision,state_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?)
      `).run(project.project_id, project.title, project.revision, serializableProject(project), timestamp, timestamp);
      if (source) {
        database.prepare(`
          INSERT INTO workflow_project_sources(project_id,source_project_id,source_revision,source_sha256,source_state_json,created_at)
          VALUES(?,?,?,?,?,?)
        `).run(project.project_id, PRIVATE_CASE_PROJECT_ID, source.revision,
          source.data_provenance.source_document_sha256, serializableProject(source), timestamp);
      }
    });
    return publicProject(project);
  }

  createPrivateSourceDraft(projectId, title, members, draft) {
    if (!draft || !draft.dataProvenance || draft.dataProvenance.kind !== "customer_source" ||
      !draft.executionContext || draft.executionContext.status !== "not_run" || draft.executionContext.engine !== null ||
      !draft.requirementsPayload || draft.requirementsPayload.record_status !== "draft" || draft.requirementsPayload.data_source_kind !== "customer_source" ||
      !draft.pfdPayload || draft.pfdPayload.draft_status !== "draft") {
      throw new WorkflowServiceError("INVALID_INPUT", "Private source projects must start as customer-source drafts with no calculation result.");
    }
    const project = engine.createProject(projectId, title, members);
    project.data_provenance = JSON.parse(JSON.stringify(draft.dataProvenance));
    project.execution_context = JSON.parse(JSON.stringify(draft.executionContext));
    project.stages.requirements.payload = JSON.parse(JSON.stringify(draft.requirementsPayload));
    project.stages.pfd.payload = JSON.parse(JSON.stringify(draft.pfdPayload));
    const timestamp = new Date().toISOString();
    this.transaction(database => {
      database.prepare(`
        INSERT INTO workflow_projects(project_id,title,revision,state_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?)
      `).run(project.project_id, project.title, project.revision, serializableProject(project), timestamp, timestamp);
    });
    return publicProject(project);
  }

  ensureDemoProject(projectId = "workflow-synthetic-001") {
    const existing = this.database.prepare(
      "SELECT project_id FROM workflow_projects WHERE project_id=?",
    ).get(projectId);
    if (existing) return false;
    this.createProject(projectId, "六步工程协作演示 · 持久化本机测试", Object.values(TEST_ACTORS));
    this.transaction(database => {
      const { project } = this.readProject(projectId, "demo-lead");
      project.data_provenance = { kind: "synthetic_demo", storage: "local_synthetic" };
      project.execution_context = { status: "not_run", mode: "synthetic_only", engine: null, result_available: false };
      this.writeProject(database, project, null);
    });
    return true;
  }

  loadProject(projectId, actorId, options = {}) {
    if (this.isReadOnlyPrivateProject(projectId)) {
      if (!/^basic:[A-Za-z0-9._-]{1,64}$/.test(actorId) || options.sourceAllowed !== true) throw new WorkflowServiceError("NOT_FOUND", "项目不存在。", 404);
      return { ok: true, project: this.privateCases.loadProject(projectId, actorId, true) };
    }
    return this.transaction(() => {
      const { project } = this.readProject(projectId, actorId);
      return { ok: true, project: publicProject(project) };
    });
  }

  listProjects(actorId) {
    const rows = this.database.prepare(
      "SELECT project_id, title, revision, state_json, frozen_snapshot_json, updated_at FROM workflow_projects ORDER BY updated_at DESC, project_id",
    ).all();
    const projects = rows.flatMap(row => {
      const project = JSON.parse(row.state_json);
      if (!Array.isArray(project.members) || !project.members.some(member => member.user_id === actorId)) return [];
      return [{
        project_id: row.project_id,
        title: row.title,
        revision: row.revision,
        frozen: Boolean(row.frozen_snapshot_json),
        updated_at: row.updated_at,
        data_source_kind: project.data_provenance && project.data_provenance.kind || "undeclared",
        execution_status: project.execution_context && project.execution_context.status || "undeclared",
      }];
    });
    return projects;
  }

  isReadOnlyPrivateProject(projectId) {
    return Boolean(this.privateCases && this.privateCases.hasProject(projectId));
  }

  action(actorId, action, trustedTaskbook = null) {
    if (this.isReadOnlyPrivateProject(action.project_id)) return privateProjectReadOnly();
    return this.transaction(database => {
      const { project } = this.readProject(action.project_id, actorId);
      if (isBusinessProject(project) && action.stage_id === "calculation" && ["edit", "submit", "confirm"].includes(action.type)) return customerCalculationBlocked();
      if (isBusinessProject(project) && action.stage_id === "requirements" && action.type === "submit") {
        const reviewCheck = requirementsSchema.validateForReview(project.stages.requirements.payload);
        if (!reviewCheck.ok) return { ok: false, error: {
          code: "REQUIREMENTS_INCOMPLETE",
          message: reviewCheck.errors[0].message,
          details: reviewCheck.errors.map(item => ({ field: item.field, code: item.code })),
        } };
      }
      if (isBusinessProject(project) && action.type === "return" &&
        (!action.payload || typeof action.payload.reason !== "string" || action.payload.reason.trim().length < 3 || action.payload.reason.length > 500)) {
        return { ok: false, error: { code: "RETURN_REASON_REQUIRED", message: "业务审核退回必须填写至少 3 个字符的原因。" } };
      }
      if (isBusinessProject(project) && action.stage_id === "requirements" && action.type === "edit") {
        const normalized = requirementsSchema.normalizeRequirementsPayload(action.payload, trustedTaskbook ? action.payload : project.stages.requirements.payload);
        if (!normalized.ok) {
          return { ok: false, error: { code: "INVALID_INPUT", message: normalized.errors[0].message, details: normalized.errors.map(item => ({ field: item.field, code: item.code })) } };
        }
        if (!trustedTaskbook && (project.stages.requirements.payload?.taskbook || action.payload?.taskbook)) {
          return {ok:false,error:{code:"INVALID_INPUT",message:"需求采用任务书管理，请修订 Excel 后重新上传。"}};
        }
        if (trustedTaskbook) normalized.payload.taskbook = trustedTaskbook;
        action = { ...action, payload: normalized.payload };
        action.project_name = normalized.projectName;
      }
      const existing = project.actionLog.has(action.action_id);
      const result = engine.processAction(project, { ...action, actor_id: actorId });
      if (result.ok && action.project_name) {
        project.title = action.project_name;
        result.project.title = action.project_name;
        const logEntry = project.actionLog.get(action.action_id);
        if (logEntry) logEntry.result.project.title = action.project_name;
      }
      if (!existing) this.persistNewAction(database, project, action.action_id);
      if (result.ok) this.writeProject(database, project, null);
      return normalizeResult(result);
    });
  }

  addBusinessMember(actorId, projectId, memberInput, authorizedPrincipals = []) {
    return this.transaction(database => {
      const { project } = this.readProject(projectId, actorId);
      if (!isBusinessProject(project) || project.owner_id !== actorId) {
        return { ok: false, error: { code: "FORBIDDEN", message: "Only the authenticated project owner can manage business-project members." } };
      }
      if (!memberInput || typeof memberInput.user_id !== "string" || !/^basic:[A-Za-z0-9._-]{1,64}$/.test(memberInput.user_id) ||
        !["engineer", "reviewer"].includes(memberInput.role) || !Number.isInteger(memberInput.expected_revision)) {
        return { ok: false, error: { code: "INVALID_INPUT", message: "Member identity, role, or expected revision is invalid." } };
      }
      if (memberInput.user_id === actorId) return { ok: false, error: { code: "FORBIDDEN", message: "The project owner cannot assign a second role to their own identity." } };
      if (!authorizedPrincipals.includes(memberInput.user_id)) {
        return { ok: false, error: { code: "USER_NOT_AUTHORIZED", message: "The selected person is not an independently authenticated account configured for this site." } };
      }
      if (memberInput.expected_revision !== project.revision) {
        return { ok: false, error: { code: "REVISION_CONFLICT", message: `Expected ${memberInput.expected_revision}, current ${project.revision}` } };
      }
      if (project.frozen) return { ok: false, error: { code: "FORBIDDEN", message: "Project is frozen." } };
      if (project.members.some(member => member.user_id === memberInput.user_id)) {
        return { ok: false, error: { code: "INVALID_INPUT", message: "This account is already a project member." } };
      }
      project.members.push({ user_id: memberInput.user_id, role: memberInput.role });
      project.revision += 1;
      project.audit.push({ ts: Date.now(), actor_id: actorId, action: "add_member", member: memberInput.user_id, role: memberInput.role, revision: project.revision });
      this.writeProject(database, project, null);
      return { ok: true, project: publicProject(project) };
    });
  }

  recordCalculationFailure(actorId, action) {
    if (this.isReadOnlyPrivateProject(action.project_id)) return privateProjectReadOnly();
    return this.transaction(database => {
      const { project } = this.readProject(action.project_id, actorId);
      if (isBusinessProject(project)) return customerCalculationBlocked();
      const existing = project.actionLog.has(action.action_id);
      const result = engine.recordCalculationFailure(project, { ...action, actor_id: actorId });
      if (!existing) this.persistNewAction(database, project, action.action_id);
      if (result.ok) this.writeProject(database, project, null);
      return normalizeResult(result);
    });
  }

  freeze(actorId, projectId, expectedRevision) {
    if (this.isReadOnlyPrivateProject(projectId)) return privateProjectReadOnly();
    return this.transaction(database => {
      const { project, member } = this.readProject(projectId, actorId);
      if (isBusinessProject(project)) {
        if (member.role !== "lead") return { ok: false, error: { code: "FORBIDDEN", message: "Only lead can freeze." } };
        return { ok: false, error: { code: "CUSTOMER_SOURCE_EXPORT_DISABLED", message: "Customer-source drafts cannot be frozen into synthetic reports." } };
      }
      const wasFrozen = project.frozen;
      const result = engine.freezeProject(project, actorId, expectedRevision);
      if (!result.ok) return result;
      let snapshot = database.prepare(
        "SELECT frozen_snapshot_json FROM workflow_projects WHERE project_id=?",
      ).get(projectId).frozen_snapshot_json;
      if (!wasFrozen) snapshot = JSON.stringify(engine.getExportVersion(project));
      if (!wasFrozen) this.writeProject(database, project, snapshot);
      return { ok: true, project: publicProject(project), exportVersion: JSON.parse(snapshot) };
    });
  }

  getExportVersion(actorId, projectId) {
    if (this.isReadOnlyPrivateProject(projectId)) {
      throw new WorkflowServiceError("CUSTOMER_SOURCE_EXPORT_DISABLED", "Customer-source drafts cannot be frozen into synthetic reports.", 409);
    }
    return this.transaction(database => {
      this.readProject(projectId, actorId);
      const row = database.prepare(
        "SELECT frozen_snapshot_json FROM workflow_projects WHERE project_id=?",
      ).get(projectId);
      if (!row.frozen_snapshot_json) {
        throw new WorkflowServiceError("NOT_FROZEN", "项目尚未冻结。", 409);
      }
      return { ok: true, exportVersion: JSON.parse(row.frozen_snapshot_json) };
    });
  }

  beginMockCalculation(actorId, projectId, expectedRevision) {
    if (this.isReadOnlyPrivateProject(projectId)) return privateProjectReadOnly();
    return this.transaction(database => {
      const { project, member } = this.readProject(projectId, actorId);
      if (isBusinessProject(project)) return customerCalculationBlocked();
      if (member.role !== "engineer") return { ok: false, error: { code: "FORBIDDEN", message: "Only an engineer can run the synthetic calculation." } };
      if (!isPositiveRevision(expectedRevision)) return { ok: false, error: { code: "INVALID_INPUT", message: "expected_revision must be a positive integer" } };
      if (expectedRevision !== project.revision) return { ok: false, error: { code: "REVISION_CONFLICT", message: `Expected ${expectedRevision}, current ${project.revision}` } };
      if (project.frozen) return { ok: false, error: { code: "FORBIDDEN", message: "Project is frozen" } };
      const requirements = project.stages.requirements;
      const pfd = project.stages.pfd;
      if (requirements.status !== "confirmed" || pfd.status !== "confirmed" || !checkConfirmedDependencies(project, "pfd")) {
        return { ok: false, error: { code: "DEPENDENCY_NOT_CONFIRMED", message: "Confirmed current requirements and PFD are required for the mock calculation." } };
      }
      const calculation = project.stages.calculation;
      if (!["draft", "returned", "confirmed", "stale"].includes(calculation.status)) {
        return { ok: false, error: { code: "FORBIDDEN", message: `Cannot calculate in status ${calculation.status}` } };
      }
      const jobId = `mock_${randomUUID().replaceAll("-", "")}`;
      const timestamp = new Date().toISOString();
      database.prepare(`
        INSERT INTO mock_calculation_jobs(job_id,project_id,actor_id,input_revision,pfd_revision,status,created_at,updated_at)
        VALUES(?,?,?,?,?,'running',?,?)
      `).run(jobId, projectId, actorId, requirements.revision, pfd.revision, timestamp, timestamp);
      return { ok: true, job: { id: jobId, status: "mock_pending", execution_mode: "synthetic_mock", input_revision: requirements.revision, pfd_revision: pfd.revision } };
    });
  }

  completeMockCalculation(actorId, projectId, jobId) {
    if (this.isReadOnlyPrivateProject(projectId)) return privateProjectReadOnly();
    return this.transaction(database => {
      const { project, member } = this.readProject(projectId, actorId);
      if (isBusinessProject(project)) return customerCalculationBlocked();
      if (member.role !== "engineer") return { ok: false, error: { code: "FORBIDDEN", message: "Only an engineer can complete the synthetic calculation." } };
      const job = database.prepare(
        "SELECT * FROM mock_calculation_jobs WHERE job_id=? AND project_id=?",
      ).get(jobId, projectId);
      if (!job || job.actor_id !== actorId) return { ok: false, error: { code: "NOT_FOUND", message: "Mock calculation job not found." } };
      if (job.status === "completed") return JSON.parse(job.result_json);
      if (job.status !== "running") return { ok: false, error: { code: "CALCULATION_STALE", message: "Mock calculation job is no longer current." } };
      const requirements = project.stages.requirements;
      const pfd = project.stages.pfd;
      if (requirements.revision !== job.input_revision || pfd.revision !== job.pfd_revision ||
        requirements.status !== "confirmed" || pfd.status !== "confirmed" || !checkConfirmedDependencies(project, "pfd")) {
        database.prepare(
          "UPDATE mock_calculation_jobs SET status='stale',updated_at=? WHERE job_id=?",
        ).run(new Date().toISOString(), jobId);
        return { ok: false, error: { code: "CALCULATION_STALE", message: "Requirements or PFD changed while the mock calculation was running; stale result was discarded." } };
      }
      const payload = {
        input_revision: job.input_revision,
        pfd_revision: job.pfd_revision,
        model_version: "synthetic-mock-1",
        software_version: "workflow-mock-runner",
        property_method: "synthetic_mock",
        status: "success",
        checks: { synthetic_mock: "pass" },
        assumptions: ["Mock output only; not an engineering calculation."],
        missing: [],
        evidence_refs: [],
        execution_mode: "synthetic_mock",
        mock_job_id: jobId,
      };
      const actionId = `mock-result-${jobId}`;
      const result = engine.processAction(project, {
        action_id: actionId,
        actor_id: actorId,
        project_id: projectId,
        expected_revision: project.revision,
        stage_id: "calculation",
        type: "edit",
        payload,
      });
      if (!result.ok) {
        database.prepare(
          "UPDATE mock_calculation_jobs SET status='failed',updated_at=? WHERE job_id=?",
        ).run(new Date().toISOString(), jobId);
        return normalizeResult(result);
      }
      this.persistNewAction(database, project, actionId);
      this.writeProject(database, project, null);
      const response = { ok: true, project: publicProject(project), calculation: { status: "success", execution_mode: "synthetic_mock", job_id: jobId } };
      database.prepare(
        "UPDATE mock_calculation_jobs SET status='completed',result_json=?,updated_at=? WHERE job_id=?",
      ).run(JSON.stringify(response), new Date().toISOString(), jobId);
      return response;
    });
  }
}

function createTestAuthProvider() {
  const allowedActors = new Set(Object.keys(TEST_ACTORS));
  return Object.freeze({
    mode: "test_only",
    authenticate(request) {
      const actorId = request.headers["x-workflow-test-actor"];
      return allowedActors.has(actorId) ? Object.freeze({ actorId, mode: "test_only" }) : null;
    },
  });
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

function createTrustedProxyAuthProvider(options) {
  const config = options || {};
  if (typeof config.token !== "string" || Buffer.byteLength(config.token) < 32) throw new TypeError("A trusted-proxy token of at least 32 bytes is required.");
  const allowedActors = new Set(Object.keys(TEST_ACTORS));
  return Object.freeze({
    mode: "demo_proxy",
    authenticate(request) {
      if (!tokenMatches(request.headers["x-workflow-proxy-token"], config.token)) return null;
      const principal = request.headers["x-workflow-principal"];
      if (typeof principal === "string" && /^basic:[A-Za-z0-9._-]{1,64}$/.test(principal)) {
        const eligible = typeof request.headers["x-workflow-authorized-principals"] === "string"
          ? [...new Set(request.headers["x-workflow-authorized-principals"].split(",").filter(value => /^basic:[A-Za-z0-9._-]{1,64}$/.test(value)))].slice(0, 64)
          : [];
        const sourcePrincipals = typeof request.headers["x-workflow-source-principals"] === "string"
          ? [...new Set(request.headers["x-workflow-source-principals"].split(",").filter(value => /^basic:[A-Za-z0-9._-]{1,64}$/.test(value)))].slice(0, 64)
          : [];
        return Object.freeze({ actorId: principal, mode: "business_proxy", authorizedPrincipals: Object.freeze(eligible), authorizedSourcePrincipals: Object.freeze(sourcePrincipals) });
      }
      const actorId = request.headers["x-workflow-test-actor"];
      return allowedActors.has(actorId) ? Object.freeze({ actorId, mode: "demo_proxy" }) : null;
    },
  });
}

function createDenyAllAuthProvider() {
  return Object.freeze({ mode: "auth_required", authenticate: () => null });
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function readJson(request, limit = WORKFLOW_REQUEST_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new WorkflowServiceError("INVALID_INPUT", "Request body is too large.", 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
        resolve(value);
      } catch {
        reject(new WorkflowServiceError("INVALID_INPUT", "Request body must be a JSON object."));
      }
    });
    request.on("error", reject);
  });
}

function loopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function requestAuthority(request, server, trustedAuthority = null) {
  const address = server.address();
  const header = request.headers.host;
  if (trustedAuthority) {
    let parsed;
    try { parsed = new URL(`http://${header}`); }
    catch { throw new WorkflowServiceError("INVALID_HOST", "A valid trusted-proxy Host authority is required.", 400); }
    if (typeof header !== "string" || header.toLowerCase() !== trustedAuthority.toLowerCase() || parsed.host.toLowerCase() !== trustedAuthority.toLowerCase() || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new WorkflowServiceError("INVALID_HOST", "Host must match the configured trusted-proxy authority.", 400);
    }
    return trustedAuthority;
  }
  if (!address || typeof address !== "object" || !loopbackAddress(address.address) || typeof header !== "string") {
    throw new WorkflowServiceError("INVALID_HOST", "A valid loopback Host authority is required.", 400);
  }
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const expected = `${host}${address.port === 80 ? "" : `:${address.port}`}`;
  let parsed;
  try {
    parsed = new URL(`http://${header}`);
  } catch {
    throw new WorkflowServiceError("INVALID_HOST", "A valid loopback Host authority is required.", 400);
  }
  if (header.toLowerCase() !== expected.toLowerCase() || parsed.host.toLowerCase() !== expected.toLowerCase() ||
    parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new WorkflowServiceError("INVALID_HOST", "Host must match the server's loopback authority.", 400);
  }
  return expected;
}

function errorStatus(error) {
  if (error instanceof WorkflowServiceError) return error.status;
  if (error && error.code === "FORBIDDEN") return 403;
  if (error && error.code === "NOT_FOUND") return 404;
  if (error && ["REVISION_CONFLICT", "DEPENDENCY_NOT_CONFIRMED", "CALCULATION_STALE", "NOT_FROZEN", "CUSTOMER_SOURCE_NOT_CALCULABLE", "CUSTOMER_SOURCE_EXPORT_DISABLED", "PRIVATE_PROJECT_READ_ONLY", "REQUIREMENTS_INCOMPLETE"].includes(error.code)) return 409;
  if (error && error.code === "INVALID_INPUT") return 400;
  if (error && error.code === "RETURN_REASON_REQUIRED") return 400;
  if (error && ["USER_NOT_AUTHORIZED", "FORBIDDEN"].includes(error.code)) return 403;
  return 500;
}

function createHttpServer(options) {
  const config = options || {};
  if (!config.store) throw new TypeError("WorkflowStore is required");
  const auth = config.authProvider || createDenyAllAuthProvider();
  const trustedProxy = config.trustedProxy || null;
  if (trustedProxy && (typeof trustedProxy.token !== "string" || Buffer.byteLength(trustedProxy.token) < 32 || typeof trustedProxy.hostAuthority !== "string" || !/^[A-Za-z0-9.-]+:\d{1,5}$/.test(trustedProxy.hostAuthority) || trustedProxy.origin !== `http://${trustedProxy.hostAuthority}` || auth.mode !== "demo_proxy")) {
    throw new TypeError("Trusted-proxy mode requires a private token, fixed internal authority/origin, and DEMO auth provider.");
  }
  const staticRoot = config.staticRoot || __dirname;
  const staticFiles = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/workspace-layout.css", ["workspace-layout.css", "text/css; charset=utf-8"]],
    ["/workflow-view.js", ["workflow-view.js", "text/javascript; charset=utf-8"]],
    ["/workspace-ui.js", ["workspace-ui.js", "text/javascript; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/workflow-engine.js", ["workflow-engine.js", "text/javascript; charset=utf-8"]],
    ["/synthetic-adapter.js", ["synthetic-adapter.js", "text/javascript; charset=utf-8"]],
    ["/workflow-controller.js", ["workflow-controller.js", "text/javascript; charset=utf-8"]],
    ["/http-adapter.js", ["http-adapter.js", "text/javascript; charset=utf-8"]],
    ["/requirements-schema.js", ["requirements-schema.js", "text/javascript; charset=utf-8"]],
    ["/taskbook-ui.js", ["taskbook-ui.js", "text/javascript; charset=utf-8"]],
    ["/taskbook-template.xlsx", ["taskbook-template.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]],
    ["/business-ui-copy.js", ["business-ui-copy.js", "text/javascript; charset=utf-8"]],
  ]);

  let server;
  server = http.createServer(async (request, response) => {
    try {
    const address = request.socket.remoteAddress;
    if (trustedProxy) {
      if (!tokenMatches(request.headers["x-workflow-proxy-token"], trustedProxy.token)) return sendJson(response, 403, { ok: false, error: { code: "TRUSTED_PROXY_REQUIRED", message: "A verified application proxy is required." } });
    } else if (!loopbackAddress(address)) return sendJson(response, 403, { ok: false, error: { code: "LOOPBACK_ONLY", message: "Loopback access only." } });
    const host = requestAuthority(request, server, trustedProxy && trustedProxy.hostAuthority);
    let requestUrl;
    try {
      requestUrl = new URL(request.url, `http://${host}`);
    } catch {
      throw new WorkflowServiceError("INVALID_REQUEST", "Malformed request URL.", 400);
    }
    if (request.method === "GET" && requestUrl.pathname === "/workflow-config.js") {
      const mode = auth.mode === "demo_proxy" ? "demo_proxy" : auth.mode === "test_only" ? "test_only" : "auth_required";
      const projectId = config.projectId || "workflow-synthetic-001";
      const basePath = typeof config.basePath === "string" ? config.basePath : "";
      const body = `window.ECOPWorkflowConfig = Object.freeze({mode:${JSON.stringify(mode)},projectId:${JSON.stringify(projectId)},basePath:${JSON.stringify(basePath)}});`;
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return response.end(body);
    }
    if (request.method === "GET" && staticFiles.has(requestUrl.pathname)) {
      const [filename, contentType] = staticFiles.get(requestUrl.pathname);
      const body = fs.readFileSync(path.join(staticRoot, filename));
      response.writeHead(200, { "Content-Type": contentType, "Content-Length": body.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return response.end(body);
    }

    if (!requestUrl.pathname.startsWith("/api/workflow/")) return sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found." } });
    const authContext = auth.authenticate(request);
    if (!authContext || typeof authContext.actorId !== "string") {
      return sendJson(response, 401, { ok: false, error: { code: "AUTH_REQUIRED", message: "Workflow API requires configured authentication." } });
    }
    if (request.method !== "GET" && request.headers.origin !== (trustedProxy ? trustedProxy.origin : `http://${host}`)) {
      return sendJson(response, 403, { ok: false, error: { code: "ORIGIN_REQUIRED", message: "Same-origin request required." } });
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/workflow/projects") {
      return sendJson(response, 200, {
        ok: true,
        projects: config.store.listProjects(authContext.actorId),
        source_templates: authContext.mode === "business_proxy" ? config.store.listSourceTemplates(authContext.actorId, authContext.authorizedSourcePrincipals || []) : [],
      });
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/workflow/projects") {
      if (authContext.mode !== "business_proxy") {
        throw new WorkflowServiceError("FORBIDDEN", "合成测试身份不能创建客户业务项目。", 403);
      }
      const body = await readJson(request);
      const allowed = new Set(["project_name", "source_template_id"]);
      if (Object.keys(body).some(key => !allowed.has(key)) ||
        (body.source_template_id !== undefined && typeof body.source_template_id !== "string")) {
        throw new WorkflowServiceError("INVALID_INPUT", "项目创建字段无效。", 400);
      }
      const project = config.store.createBusinessProject(authContext.actorId, body.project_name, body.source_template_id || null, authContext.authorizedSourcePrincipals || []);
      return sendJson(response, 201, { ok: true, project });
    }

    const deliveryRoute=requestUrl.pathname.match(/^\/api\/workflow\/projects\/([^/]+)\/delivery-review$/);
    if(deliveryRoute){
      if(request.method!=="GET")return sendJson(response,405,{ok:false,error:{code:"METHOD_NOT_ALLOWED",message:"评审草稿接口只读。"}});
      const projectId=decodeURIComponent(deliveryRoute[1]);
      // Existing project ACL is checked BEFORE opening any delivery evidence.
      const project=config.store.loadProject(projectId,authContext.actorId).project;
      if(requestUrl.search)return sendJson(response,400,{ok:false,error:{code:"INVALID_INPUT",message:"评审草稿接口不接受路径或身份参数。"}});
      if(!config.deliveryReviews)return sendJson(response,404,{ok:false,error:{code:"DELIVERY_NOT_FOUND",message:"当前项目尚无评审草稿。"}});
      try{return sendJson(response,200,config.deliveryReviews.load(project));}
      catch(e){if(e.deliveryStatus)return sendJson(response,e.deliveryStatus,{ok:false,error:{code:e.code,message:e.message}});throw e;}
    }
    const taskRoute=requestUrl.pathname.match(/^\/api\/workflow\/projects\/([^/]+)\/(taskbooks(?:\/(?:file|analyze)\/[a-f0-9-]+)?|taskbooks-apply|manual-review|manual-review-choice)$/);
    if(taskRoute){
      try {
        if(!["GET","POST"].includes(request.method))return sendJson(response,405,{ok:false,error:{message:"不支持此方法。"}});
        const result=await require(taskRoute[2].startsWith("manual-review")?"./manual-review.cjs":"./taskbook-service.cjs").handle({store:config.store,actorId:authContext.actorId,projectId:decodeURIComponent(taskRoute[1]),method:request.method,operation:taskRoute[2],body:request.method==="POST"?await readJson(request):null});
        if(result.file){const bytes=Buffer.from(result.file.original);response.writeHead(200,{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Length":bytes.length,"Cache-Control":"no-store","Content-Disposition":"attachment; filename=taskbook.xlsx"});return response.end(bytes);}
        return sendJson(response,result.ok?200:errorStatus(result.error),result);
      }catch(e){if(e.taskbookStatus)return sendJson(response,e.taskbookStatus,{ok:false,error:{code:"TASKBOOK_ERROR",message:e.message}});throw e;}
    }
    const route = requestUrl.pathname.match(/^\/api\/workflow\/projects\/([^/]+)(?:\/(actions|members|freeze|export|reports|calculation-failure|calculations|calculations\/([^/]+)\/complete))?$/);
    if (!route) return sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found." } });
    const projectId = decodeURIComponent(route[1]);
    const operation = route[2] || "project";
      if (request.method === "GET" && operation === "project") {
        const loaded=config.store.loadProject(projectId, authContext.actorId, {
          sourceAllowed: (authContext.authorizedSourcePrincipals || []).includes(authContext.actorId),
        });
        loaded.project.delivery_review_available=Boolean(config.deliveryReviews?.has(projectId));
        return sendJson(response, 200, loaded);
      }
      if (request.method === "GET" && operation === "export") {
        return sendJson(response, 200, config.store.getExportVersion(authContext.actorId, projectId));
      }
      if (request.method === "GET" && operation === "members") {
        const loaded = config.store.loadProject(projectId, authContext.actorId).project;
        return sendJson(response, 200, {
          ok: true,
          members: loaded.members,
          eligible_collaborators: authContext.mode === "business_proxy" && loaded.owner_id === authContext.actorId ? authContext.authorizedPrincipals : [],
          owner_id: loaded.owner_id || null,
        });
      }
      if (request.method === "GET" && operation === "reports") {
        const loaded = config.store.loadProject(projectId, authContext.actorId, {
          sourceAllowed: (authContext.authorizedSourcePrincipals || []).includes(authContext.actorId),
        }).project;
        if (isBusinessProject(loaded)) return sendJson(response, 409, { ok: false, error: { code: "CUSTOMER_SOURCE_REPORT_DISABLED", message: "业务项目报告必须由已审核的真实计算结果生成；当前尚不可导出。" } });
        const { exportVersion } = config.store.getExportVersion(authContext.actorId, projectId);
        try {
          return sendJson(response, 200, generateReportBundle(exportVersion));
        } catch (error) {
          return sendJson(response, 409, { ok: false, error: { code: error.code || "REPORT_SNAPSHOT_INVALID", message: error.message } });
        }
      }
      if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      const body = await readJson(request);
      if (Object.hasOwn(body, "actor_id") || (Object.hasOwn(body, "role") && operation !== "members")) {
        throw new WorkflowServiceError("INVALID_INPUT", "Actor and role must come from the server authentication context.");
      }
      if (operation === "actions") {
        const allowed = new Set(["action_id", "project_id", "expected_revision", "stage_id", "type", "payload"]);
        if (Object.keys(body).some(key => !allowed.has(key)) || body.project_id !== projectId) {
          throw new WorkflowServiceError("INVALID_INPUT", "Action fields or project scope are invalid.");
        }
        const result = config.store.action(authContext.actorId, body);
        return sendJson(response, result.ok ? 200 : errorStatus(result.error), result);
      }
      if (operation === "members") {
        if (authContext.mode !== "business_proxy") throw new WorkflowServiceError("FORBIDDEN", "Only authenticated business accounts can manage project membership.", 403);
        const allowed = new Set(["user_id", "role", "expected_revision"]);
        if (Object.keys(body).some(key => !allowed.has(key))) throw new WorkflowServiceError("INVALID_INPUT", "Member fields are invalid.", 400);
        const result = config.store.addBusinessMember(authContext.actorId, projectId, body, authContext.authorizedPrincipals || []);
        return sendJson(response, result.ok ? 200 : errorStatus(result.error), result);
      }
      if (operation === "calculation-failure") {
        const allowed = new Set(["action_id", "project_id", "expected_revision", "failure_code", "message"]);
        if (Object.keys(body).some(key => !allowed.has(key)) || body.project_id !== projectId) {
          throw new WorkflowServiceError("INVALID_INPUT", "Calculation failure fields or project scope are invalid.");
        }
        const result = config.store.recordCalculationFailure(authContext.actorId, body);
        return sendJson(response, result.ok ? 200 : errorStatus(result.error), result);
      }
      if (operation === "calculations") {
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "expected_revision")) {
          throw new WorkflowServiceError("INVALID_INPUT", "Only expected_revision is accepted.");
        }
        const result = config.store.beginMockCalculation(authContext.actorId, projectId, body.expected_revision);
        return sendJson(response, result.ok ? 202 : errorStatus(result.error), result);
      }
      if (operation.startsWith("calculations/")) {
        if (Object.keys(body).length !== 0) throw new WorkflowServiceError("INVALID_INPUT", "Mock completion takes no client-supplied result.");
        const jobId = route[3];
        const result = config.store.completeMockCalculation(authContext.actorId, projectId, jobId);
        return sendJson(response, result.ok ? 200 : errorStatus(result.error), result);
      }
      if (operation === "freeze") {
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "expected_revision")) {
          throw new WorkflowServiceError("INVALID_INPUT", "Only expected_revision is accepted.");
        }
        const result = config.store.freeze(authContext.actorId, projectId, body.expected_revision);
        return sendJson(response, result.ok ? 200 : errorStatus(result.error), result);
      }
      return sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found." } });
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof WorkflowServiceError) {
        return sendJson(response, error.status, { ok: false, error: { code: error.code, message: error.message } });
      }
      if (error instanceof URIError || (error && error.code === "ERR_INVALID_URL")) {
        return sendJson(response, 400, { ok: false, error: { code: "INVALID_REQUEST", message: "Malformed request path or URL." } });
      }
      console.error("Workflow local service error:", error && error.message ? error.message : String(error));
      return sendJson(response, 500, { ok: false, error: { code: "INTERNAL_ERROR", message: "Workflow service failed." } });
    }
  });
  return server;
}

module.exports = {
  TEST_ACTORS,
  WORKFLOW_REQUEST_MAX_BYTES,
  WorkflowServiceError,
  WorkflowStore,
  createTestAuthProvider,
  createTrustedProxyAuthProvider,
  createDenyAllAuthProvider,
  createHttpServer,
};
