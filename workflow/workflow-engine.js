"use strict";

/**
 * ECOP Workflow MVP - Synthetic State Machine
 * Task: ECOP-WF2-XIAOYAO-01
 * 
 * Pure synthetic workflow engine with no external dependencies.
 * Provides state machine, validation, and action processing for 6-stage workflow.
 */

const STAGES = ["requirements", "selection", "pfd", "calculation", "equipment", "documents"];
const STAGE_ORDER = { requirements: 0, selection: 1, pfd: 2, calculation: 3, equipment: 4, documents: 5 };
const VALID_STATUSES = new Set(["draft", "submitted", "returned", "confirmed", "stale"]);
const VALID_ACTION_TYPES = new Set(["edit", "submit", "return", "confirm", "comment"]);
const VALID_ROLES = new Set(["customer", "engineer", "reviewer", "lead"]);

const ERROR_CODES = {
  FORBIDDEN: "FORBIDDEN",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  INVALID_INPUT: "INVALID_INPUT",
  DEPENDENCY_NOT_CONFIRMED: "DEPENDENCY_NOT_CONFIRMED",
  NOT_FOUND: "NOT_FOUND",
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function createInitialStage(id) {
  return {
    id,
    status: "draft",
    revision: 1,
    depends_on: [],
    payload: null,
    history: [],
    comments: [],
    last_editor_id: null,
  };
}

function createProject(projectId, title, members) {
  if (!projectId || typeof projectId !== "string") {
    throw new Error("project_id must be non-empty string");
  }
  if (!title || typeof title !== "string") {
    throw new Error("title must be non-empty string");
  }
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error("members must be non-empty array");
  }
  for (const m of members) {
    if (!m.user_id || !VALID_ROLES.has(m.role)) {
      throw new Error(`Invalid member: ${JSON.stringify(m)}`);
    }
  }
  
  const stages = {};
  for (const id of STAGES) {
    const stage = createInitialStage(id);
    // Set dependencies based on stage order
    const idx = STAGE_ORDER[id];
    if (idx > 0) {
      stage.depends_on = [{ stage_id: STAGES[idx - 1], revision: 1 }];
    }
    stages[id] = stage;
  }
  
  return {
    project_id: projectId,
    revision: 1,
    title,
    members: deepClone(members),
    stages,
    audit: [],
    frozen: false,
    actionLog: new Map(), // action_id -> { action, result }
  };
}

function getMemberRole(project, userId) {
  const member = project.members.find(m => m.user_id === userId);
  return member ? member.role : null;
}

function canEditStage(role, stageId, stage) {
  if (!["draft", "returned", "confirmed", "stale"].includes(stage.status)) return false;
  if (role === "customer") return stageId === "requirements";
  if (role === "engineer") return true;
  return false;
}

function canSubmitStage(role, stageId, stage) {
  if (stage.status !== "draft" && stage.status !== "returned") return false;
  if (role === "customer") return stageId === "requirements";
  if (role === "engineer") return true;
  return false;
}

function canReturnStage(role, stage) {
  if (stage.status !== "submitted") return false;
  return role === "engineer" || role === "reviewer";
}

function canConfirmStage(role, stage) {
  if (stage.status !== "submitted") return false;
  return role === "reviewer";
}

function isSelfReview(stage, actorId) {
  return stage.last_editor_id === actorId;
}

function checkDependenciesConfirmed(project, stageId) {
  const stage = project.stages[stageId];
  for (const dep of stage.depends_on) {
    const depStage = project.stages[dep.stage_id];
    if (!depStage || depStage.status !== "confirmed") {
      return { ok: false, missing: dep.stage_id };
    }
    if (depStage.revision !== dep.revision) {
      return { ok: false, mismatch: dep.stage_id };
    }
  }
  return { ok: true };
}

function validateCalculationPayload(project, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "Calculation payload must be a non-empty object";
  if (payload.status === "failed" || payload.status === "error") return "Calculation failed; cannot save as success";
  const required = ["input_revision", "pfd_revision", "model_version", "software_version", "property_method", "status", "checks", "assumptions", "missing", "evidence_refs"];
  for (const field of required) {
    if (!(field in payload)) return `Calculation payload missing ${field}`;
  }
  if (payload.status !== "success") return "Calculation payload must have success status";
  if (!Number.isInteger(payload.input_revision) || payload.input_revision < 1 ||
    !Number.isInteger(payload.pfd_revision) || payload.pfd_revision < 1) return "Calculation input and PFD revisions must be positive integers";
  if (payload.input_revision !== project.stages.requirements.revision) return "Calculation input revision does not match current requirements";
  if (payload.pfd_revision !== project.stages.pfd.revision) return "Calculation PFD revision does not match current PFD";
  if (project.stages.requirements.status !== "confirmed" || project.stages.pfd.status !== "confirmed") return "Calculation inputs must be confirmed";
  if (!checkDependenciesConfirmed(project, "pfd").ok) return "Calculation PFD dependencies are not current and confirmed";
  if (typeof payload.model_version !== "string" || !payload.model_version.trim() ||
    typeof payload.software_version !== "string" || !payload.software_version.trim() ||
    typeof payload.property_method !== "string" || !payload.property_method.trim()) return "Calculation version and method fields must be non-empty strings";
  if (!payload.checks || typeof payload.checks !== "object" || Array.isArray(payload.checks) ||
    Object.keys(payload.checks).length === 0 || Object.values(payload.checks).some(value => value !== "pass" && value !== true)) return "Calculation checks must be non-empty and all pass";
  if (!Array.isArray(payload.assumptions) || !Array.isArray(payload.missing) || !Array.isArray(payload.evidence_refs)) return "Calculation assumptions, missing, and evidence_refs must be arrays";
  if (payload.missing.length > 0) return "Calculation cannot succeed while required inputs are missing";
  return null;
}

function markDependentsStale(project, stageId) {
  const invalidated = new Set([stageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, stage] of Object.entries(project.stages)) {
      if (invalidated.has(id) || !stage.depends_on.some(dep => invalidated.has(dep.stage_id))) continue;
      invalidated.add(id);
      stage.status = "stale";
      changed = true;
    }
  }
}

function refreshDependencies(project, stage) {
  stage.depends_on = stage.depends_on.map(dep => ({
    stage_id: dep.stage_id,
    revision: project.stages[dep.stage_id] ? project.stages[dep.stage_id].revision : dep.revision,
  }));
}

function processAction(project, action) {
  // Validate action structure
  if (!action || typeof action !== "object") {
    return { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: "Action must be object" } };
  }
  const { action_id, actor_id, project_id, expected_revision, stage_id, type, payload } = action;
  
  if (!action_id || typeof action_id !== "string") {
    return { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: "action_id required" } };
  }
  if (!actor_id || typeof actor_id !== "string") {
    return { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: "actor_id required" } };
  }
  if (project_id !== project.project_id) {
    return { ok: false, error: { code: ERROR_CODES.NOT_FOUND, message: "Project mismatch" } };
  }
  if (!Number.isInteger(expected_revision) || expected_revision < 1) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: "expected_revision must be positive integer" } };
  }
  if (!stage_id || !STAGES.includes(stage_id)) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: `Invalid stage_id: ${stage_id}` } };
  }
  if (!type || !VALID_ACTION_TYPES.has(type)) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: `Invalid action type: ${type}` } };
  }
  
  // Check idempotency: replay same action_id
  if (project.actionLog.has(action_id)) {
    const logged = project.actionLog.get(action_id);
    // Same action_id with different content = conflict
    const currentSig = JSON.stringify({ actor_id, project_id, expected_revision, stage_id, type, payload });
    if (logged.signature !== currentSig) {
      return { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: "action_id reuse with different content" } };
    }
    // Replay: return original result
    return deepClone(logged.result);
  }
  
  // Check membership
  const role = getMemberRole(project, actor_id);
  if (!role) {
    return { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: "Not a project member" } };
  }
  
  // Check revision
  if (expected_revision !== project.revision) {
    return { ok: false, error: { code: ERROR_CODES.REVISION_CONFLICT, message: `Expected ${expected_revision}, current ${project.revision}` } };
  }
  
  // Check frozen
  if (project.frozen) {
    return { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: "Project is frozen" } };
  }
  
  const stage = project.stages[stage_id];
  let result;
  
  switch (type) {
    case "edit": {
      if (!canEditStage(role, stage_id, stage)) {
        result = { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: `Cannot edit ${stage_id} in status ${stage.status}` } };
        break;
      }
      if (stage_id === "calculation") {
        const validationError = validateCalculationPayload(project, payload);
        if (validationError) {
          result = { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: validationError } };
          break;
        }
      }
      if (stage.payload !== null) {
        stage.history.push({ revision: stage.revision, status: stage.status, payload: deepClone(stage.payload), last_editor_id: stage.last_editor_id });
        stage.revision += 1;
      }
      stage.payload = payload !== undefined ? deepClone(payload) : stage.payload;
      stage.last_editor_id = actor_id;
      stage.status = "draft";
      refreshDependencies(project, stage);
      markDependentsStale(project, stage_id);
      project.audit.push({ ts: Date.now(), actor_id, action: "edit", stage_id, revision: project.revision });
      result = { ok: true, project: deepClone(project) };
      break;
    }
    
    case "submit": {
      if (!canSubmitStage(role, stage_id, stage)) {
        result = { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: `Cannot submit ${stage_id}` } };
        break;
      }
      if (stage_id === "calculation") {
        const validationError = validateCalculationPayload(project, stage.payload);
        if (validationError) {
          result = { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: validationError } };
          break;
        }
      }
      // Check dependencies confirmed
      const depCheck = checkDependenciesConfirmed(project, stage_id);
      if (!depCheck.ok) {
        result = { ok: false, error: { code: ERROR_CODES.DEPENDENCY_NOT_CONFIRMED, message: `Dependency ${depCheck.missing || depCheck.mismatch} not confirmed` } };
        break;
      }
      stage.status = "submitted";
      project.audit.push({ ts: Date.now(), actor_id, action: "submit", stage_id, revision: project.revision });
      result = { ok: true, project: deepClone(project) };
      break;
    }
    
    case "return": {
      if (!canReturnStage(role, stage)) {
        result = { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: `Cannot return ${stage_id}` } };
        break;
      }
      stage.status = "returned";
      stage.revision += 1;
      stage.last_return_reason = payload && typeof payload.reason === "string" ? payload.reason.trim().slice(0, 500) : "";
      markDependentsStale(project, stage_id);
      project.audit.push({ ts: Date.now(), actor_id, action: "return", stage_id, reason: stage.last_return_reason, revision: project.revision });
      result = { ok: true, project: deepClone(project) };
      break;
    }
    
    case "confirm": {
      if (!canConfirmStage(role, stage)) {
        result = { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: `Cannot confirm ${stage_id}` } };
        break;
      }
      if (stage_id === "calculation") {
        const validationError = validateCalculationPayload(project, stage.payload);
        if (validationError) {
          result = { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: validationError } };
          break;
        }
      }
      // Self-review check
      if (isSelfReview(stage, actor_id)) {
        result = { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: "Cannot confirm own edited stage" } };
        break;
      }
      // Check dependencies confirmed
      const depCheck2 = checkDependenciesConfirmed(project, stage_id);
      if (!depCheck2.ok) {
        result = { ok: false, error: { code: ERROR_CODES.DEPENDENCY_NOT_CONFIRMED, message: `Dependency not confirmed` } };
        break;
      }
      stage.status = "confirmed";
      project.audit.push({ ts: Date.now(), actor_id, action: "confirm", stage_id, revision: project.revision });
      result = { ok: true, project: deepClone(project) };
      break;
    }
    
    case "comment": {
      if (!["customer", "engineer", "reviewer"].includes(role)) {
        result = { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: "This role cannot comment" } };
        break;
      }
      if (!payload || typeof payload.text !== "string") {
        result = { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: "Comment requires text" } };
        break;
      }
      stage.comments.push({ actor_id, text: payload.text, ts: Date.now() });
      project.audit.push({ ts: Date.now(), actor_id, action: "comment", stage_id, revision: project.revision });
      result = { ok: true, project: deepClone(project) };
      break;
    }
    
    default:
      result = { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: `Unknown action type: ${type}` } };
  }

  if (result && result.ok) {
    project.revision += 1;
    const lastAudit = project.audit[project.audit.length - 1];
    if (lastAudit) lastAudit.revision = project.revision;
    result.project = deepClone(project);
  }
  
  // Log action for idempotency
  const signature = JSON.stringify({ actor_id, project_id, expected_revision, stage_id, type, payload });
  project.actionLog.set(action_id, { signature, result: deepClone(result) });
  
  return result;
}

function recordCalculationFailure(project, action) {
  if (!action || typeof action !== "object" || typeof action.action_id !== "string" || !action.action_id ||
    typeof action.actor_id !== "string" || !action.actor_id || action.project_id !== project.project_id ||
    !Number.isInteger(action.expected_revision) || action.expected_revision < 1) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: "Calculation failure requires action_id, actor_id, project_id, and expected_revision" } };
  }
  const signature = JSON.stringify({ ...action, type: "calculation_failure" });
  if (project.actionLog.has(action.action_id)) {
    const logged = project.actionLog.get(action.action_id);
    return logged.signature === signature
      ? deepClone(logged.result)
      : { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: "action_id reuse with different content" } };
  }
  const role = getMemberRole(project, action.actor_id);
  if (role !== "engineer") return { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: "Only an engineer can record a calculation failure" } };
  if (action.expected_revision !== project.revision) {
    return { ok: false, error: { code: ERROR_CODES.REVISION_CONFLICT, message: `Expected ${action.expected_revision}, current ${project.revision}` } };
  }
  if (project.frozen) return { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: "Project is frozen" } };

  const stage = project.stages.calculation;
  if (!["draft", "returned", "confirmed", "stale"].includes(stage.status)) {
    return { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: `Cannot calculate in status ${stage.status}` } };
  }
  if (stage.payload !== null) {
    stage.history.push({ revision: stage.revision, status: stage.status, payload: deepClone(stage.payload), last_editor_id: stage.last_editor_id });
    stage.revision += 1;
  }
  stage.status = "draft";
  stage.payload = {
    status: "failed",
    failure_code: typeof action.failure_code === "string" ? action.failure_code : "SYNTHETIC_CALCULATION_FAILURE",
    message: typeof action.message === "string" ? action.message : "Synthetic calculation failed; no successful result is current.",
    attempt_id: action.action_id,
  };
  stage.last_editor_id = action.actor_id;
  refreshDependencies(project, stage);
  markDependentsStale(project, "calculation");
  project.revision += 1;
  project.audit.push({ ts: Date.now(), actor_id: action.actor_id, action: "calculation_failure", stage_id: "calculation", revision: project.revision });
  const result = { ok: true, project: deepClone(project), calculation: { status: "failed", attempt_id: action.action_id } };
  project.actionLog.set(action.action_id, { signature, result: deepClone(result) });
  return result;
}

function freezeProject(project, actorId, expectedRevision = project.revision) {
  if (expectedRevision !== project.revision) {
    return { ok: false, error: { code: ERROR_CODES.REVISION_CONFLICT, message: `Expected ${expectedRevision}, current ${project.revision}` } };
  }
  const role = getMemberRole(project, actorId);
  if (role !== "lead") {
    return { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: "Only lead can freeze" } };
  }
  if (project.frozen) return { ok: true, project: deepClone(project) };
  // Check all stages confirmed
  for (const [id, stage] of Object.entries(project.stages)) {
    if (stage.status !== "confirmed") {
      return { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: `Stage ${id} not confirmed` } };
    }
  }
  const calculationError = validateCalculationPayload(project, project.stages.calculation.payload);
  if (calculationError) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: calculationError } };
  }
  project.frozen = true;
  project.revision += 1;
  project.audit.push({ ts: Date.now(), actor_id: actorId, action: "freeze", revision: project.revision });
  return { ok: true, project: deepClone(project) };
}

function addMember(project, actorId, newMember, expectedRevision = project.revision) {
  if (expectedRevision !== project.revision) {
    return { ok: false, error: { code: ERROR_CODES.REVISION_CONFLICT, message: `Expected ${expectedRevision}, current ${project.revision}` } };
  }
  const role = getMemberRole(project, actorId);
  if (role !== "lead") {
    return { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: "Only lead can add members" } };
  }
  if (project.frozen) {
    return { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: "Project is frozen" } };
  }
  if (!newMember.user_id || !VALID_ROLES.has(newMember.role)) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: "Invalid member" } };
  }
  if (project.members.some(m => m.user_id === newMember.user_id)) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: "Member already exists" } };
  }
  project.members.push(deepClone(newMember));
  project.revision += 1;
  project.audit.push({ ts: Date.now(), actor_id: actorId, action: "add_member", member: newMember.user_id, revision: project.revision });
  return { ok: true, project: deepClone(project) };
}

function getExportVersion(project) {
  const stageVersions = {};
  for (const [id, stage] of Object.entries(project.stages)) {
    stageVersions[id] = {
      revision: stage.revision,
      status: stage.status,
      depends_on: deepClone(stage.depends_on),
      payload: deepClone(stage.payload),
      comments: deepClone(stage.comments),
      history: deepClone(stage.history),
    };
  }
  return {
    project_id: project.project_id,
    project_revision: project.revision,
    frozen: project.frozen,
    stages: stageVersions,
    exported_at: Date.now(),
  };
}

function createAdapter(project) {
  return Object.freeze({
    load: (projectId) => {
      if (projectId !== project.project_id) {
        return { ok: false, error: { code: ERROR_CODES.NOT_FOUND, message: "Project not found" } };
      }
      return { ok: true, project: deepClone(project) };
    },
    action: (action) => processAction(project, action),
    recordCalculationFailure: (action) => recordCalculationFailure(project, action),
    freeze: (actorId, expectedRevision) => freezeProject(project, actorId, expectedRevision),
    addMember: (actorId, member, expectedRevision) => addMember(project, actorId, member, expectedRevision),
    getExportVersion: () => getExportVersion(project),
  });
}

const workflowEngineExports = {
  STAGES,
  STAGE_ORDER,
  ERROR_CODES,
  createProject,
  processAction,
  recordCalculationFailure,
  freezeProject,
  addMember,
  getExportVersion,
  createAdapter,
};

if (typeof module === "object" && module.exports) module.exports = workflowEngineExports;
else globalThis.ECOPWorkflowEngine = Object.freeze(workflowEngineExports);
