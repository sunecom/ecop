'use strict';
// ECOP-WB-L1-CALCDELIVERY-20260927: 服务侧（operator-only）真实计算结果交付通道。
//
// 产品契约（ECOP-Agent核心方案 / L1 阶段1）：
//  - 业务项目 04 计算阶段不开放 HTTP 编辑/提交（CUSTOMER_SOURCE_NOT_CALCULABLE 门禁保留），
//    结果只能经本通道由计算服务侧写入，且必须携带完整溯源。
//  - 交付结果写入后置为 submitted；评审（reviewer）可经 HTTP confirm（此时门禁放行，
//    判定用本模块 isRealEngineCalculation，见 workflow-service.cjs action()）。
//  - 本模块刻意不挂任何 HTTP 路由：operator 在服务主机上以容器内 node 调用，
//    与 manual-review.cjs deliver() 先例同构。
//
// 溯源硬校验（缺一即拒绝交付）：
//   execution_mode === 'real_engine'
//   engine: {name, version} 均非空
//   calculation_method 未提供或为 native_flowsheet 时，evidence 必含 flowsheet_model 与 results_record；
//   calculation_method 为 engine_properties_explicit_balances 时，必须显式声明
//             validation_scope=scheme_review、engineering_release=false，且 evidence 必含
//             calculation_model、calculation_input 与 results_record，不能用 flowsheet_model 冒充。
//   evidence 每项 {kind, sha256(64位hex), bytes(正整数)}；允许额外保留流程截图。
//   boundary: 非空（真实计算必须声明边界）
//   assumptions: 非空数组；results: 非空对象
//   其余字段（input_revision/pfd_revision/checks 全 pass/missing 空等）由 workflow-engine
//   validateCalculationPayload 在 edit 动作中强制。

const { randomUUID } = require('node:crypto');

const CALCULATION_METHODS = new Set(['native_flowsheet', 'engine_properties_explicit_balances']);
const ENGINE_EVIDENCE_KINDS = new Set([
  'flowsheet_model',
  'calculation_model',
  'calculation_input',
  'results_record',
  'flowsheet_screenshot',
]);
const REQUIRED_EVIDENCE_BY_METHOD = Object.freeze({
  native_flowsheet: ['flowsheet_model', 'results_record'],
  engine_properties_explicit_balances: ['calculation_model', 'calculation_input', 'results_record'],
});
const SHA256_RE = /^[a-f0-9]{64}$/;

function provenanceError(message) {
  return { ok: false, error: { code: 'CALC_DELIVERY_PROVENANCE_INVALID', message } };
}

function calculationMethod(payload) {
  if (!payload || payload.calculation_method === undefined) return 'native_flowsheet';
  return CALCULATION_METHODS.has(payload.calculation_method) ? payload.calculation_method : null;
}

// 结构化判定：载荷是否为携带完整溯源的真实引擎计算结果。
// 用途：①deliverCalculation 交付前校验；②workflow-service.cjs 门禁放行 reviewer confirm。
function isRealEngineCalculation(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.execution_mode !== 'real_engine') return false;
  const engine = payload.engine;
  if (!engine || typeof engine !== 'object' || Array.isArray(engine)) return false;
  if (typeof engine.name !== 'string' || !engine.name.trim()) return false;
  if (typeof engine.version !== 'string' || !engine.version.trim()) return false;
  const method = calculationMethod(payload);
  if (!method) return false;
  if (payload.engineering_release !== undefined && payload.engineering_release !== false) return false;
  if (method === 'engine_properties_explicit_balances') {
    if (payload.validation_scope !== 'scheme_review' || payload.engineering_release !== false) return false;
  } else if (payload.validation_scope !== undefined && payload.validation_scope !== 'scheme_review') {
    return false;
  }
  if (!Array.isArray(payload.evidence) || payload.evidence.length === 0) return false;
  const kinds = new Set();
  for (const item of payload.evidence) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (typeof item.kind !== 'string' || !ENGINE_EVIDENCE_KINDS.has(item.kind)) return false;
    if (typeof item.sha256 !== 'string' || !SHA256_RE.test(item.sha256)) return false;
    if (!Number.isInteger(item.bytes) || item.bytes <= 0) return false;
    kinds.add(item.kind);
  }
  if (!REQUIRED_EVIDENCE_BY_METHOD[method].every(kind => kinds.has(kind))) return false;
  if (typeof payload.boundary !== 'string' || !payload.boundary.trim()) return false;
  if (!Array.isArray(payload.assumptions) || payload.assumptions.length === 0) return false;
  if (!payload.results || typeof payload.results !== 'object' || Array.isArray(payload.results)) return false;
  return true;
}

// 交付：以工程成员身份把真实引擎结果写入 calculation 阶段并提交审核。
// delivery: {engineer_id, result}；operator 在容器内调用（同 manual-review deliver()）。
function deliverCalculation(store, projectId, delivery) {
  if (!store || typeof store.transaction !== 'function' || typeof store.readProject !== 'function') {
    throw new TypeError('WorkflowStore is required');
  }
  if (typeof projectId !== 'string' || !projectId) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'projectId 必填。' } };
  }
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'delivery 必填。' } };
  }
  const engineerId = delivery.engineer_id;
  const result = delivery.result;
  if (typeof engineerId !== 'string' || !engineerId) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'engineer_id 必填（交付以工程成员身份记账）。' } };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'result 必填（真实计算结果载荷）。' } };
  }
  if (result.execution_mode === 'synthetic_mock' || result.status === 'failed' || result.status === 'error') {
    return provenanceError('mock/失败结果不能作为真实计算交付；业务项目计算必须来自真实引擎。');
  }
  if (!isRealEngineCalculation(result)) {
    return provenanceError('计算结果溯源不完整：须含 execution_mode=real_engine、engine.name/version、'
      + '受支持的 calculation_method；原生流程须含 flowsheet_model+results_record，'
      + '引擎物性调用+显式衡算须声明 scheme_review/engineering_release=false 并含 '
      + 'calculation_model+calculation_input+results_record（每项含 sha256(64hex)/bytes）、'
      + '非空 boundary、非空 assumptions、非空 results。');
  }
  return store.transaction(database => {
    const { project, member } = store.readProject(projectId, engineerId);
    if (project.frozen) return { ok: false, error: { code: 'FORBIDDEN', message: '项目已冻结。' } };
    const sourceKind = project.data_provenance && project.data_provenance.kind;
    if (sourceKind === 'synthetic_demo') {
      return { ok: false, error: { code: 'FORBIDDEN', message: '合成演示项目走 mock 计算通道，不接受真实引擎交付。' } };
    }
    if (member.role !== 'engineer') {
      return { ok: false, error: { code: 'FORBIDDEN', message: '只有工程成员（engineer）可以交付计算结果。' } };
    }
    const requirements = project.stages.requirements;
    const pfd = project.stages.pfd;
    if (requirements.status !== 'confirmed' || pfd.status !== 'confirmed') {
      return { ok: false, error: { code: 'DEPENDENCY_NOT_CONFIRMED', message: '交付前需求与流程阶段须为已确认。' } };
    }
    if (result.input_revision !== requirements.revision || result.pfd_revision !== pfd.revision) {
      return { ok: false, error: { code: 'REVISION_CONFLICT', message: `结果绑定 revision 不符（当前 requirements r${requirements.revision} / pfd r${pfd.revision}）。` } };
    }
    const engine = require('./workflow-engine.js');
    const editId = `calcdeliver-${randomUUID().replaceAll('-', '')}`;
    const submitId = `calcdeliver-sub-${randomUUID().replaceAll('-', '')}`;
    const editResult = engine.processAction(project, {
      action_id: editId, actor_id: engineerId, project_id: projectId,
      expected_revision: project.revision, stage_id: 'calculation', type: 'edit', payload: result,
    });
    if (!editResult.ok) return editResult;
    const submitResult = engine.processAction(project, {
      action_id: submitId, actor_id: engineerId, project_id: projectId,
      expected_revision: project.revision, stage_id: 'calculation', type: 'submit', payload: {},
    });
    if (!submitResult.ok) return submitResult;
    // 记录执行上下文：真实引擎已运行且结果可用（区别于 awaiting_engine_gate）。
    project.execution_context = {
      status: 'completed',
      mode: 'real_engine',
      engine: `${result.engine.name} ${result.engine.version}`,
      calculation_method: calculationMethod(result),
      validation_scope: result.validation_scope || null,
      engineering_release: false,
      result_available: true,
      delivered_action_id: editId,
    };
    project.audit.push({
      ts: Date.now(), actor_id: engineerId, action: 'calc_delivery',
      stage_id: 'calculation', engine: `${result.engine.name} ${result.engine.version}`,
      calculation_method: calculationMethod(result), validation_scope: result.validation_scope || null,
      engineering_release: false, evidence_count: result.evidence.length, revision: project.revision,
    });
    store.persistNewAction(database, project, editId);
    store.persistNewAction(database, project, submitId);
    store.writeProject(database, project, null);
    const stage = project.stages.calculation;
    return {
      ok: true,
      project: JSON.parse(JSON.stringify((() => { const { actionLog, ...rest } = project; return rest; })())),
      calculation: {
        status: stage.status,
        revision: stage.revision,
        execution_mode: 'real_engine',
        engine: `${result.engine.name} ${result.engine.version}`,
        calculation_method: calculationMethod(result),
        validation_scope: result.validation_scope || null,
        engineering_release: false,
        delivered_by: engineerId,
        action_ids: [editId, submitId],
      },
    };
  });
}

module.exports = { deliverCalculation, isRealEngineCalculation, calculationMethod, ENGINE_EVIDENCE_KINDS, CALCULATION_METHODS };
