'use strict';
// ECOP-WB-L1-CALCDELIVERY-20260927 定向核验：
// 1) isRealEngineCalculation：完整溯源通过；缺 execution_mode/坏 sha256/缺必备 evidence/缺边界 均拒绝
// 2) deliverCalculation：业务项目真实结果 edit+submit 一体、execution_context 更新、审计留痕
// 3) HTTP 门禁：edit/submit 仍 CUSTOMER_SOURCE_NOT_CALCULABLE；交付前 confirm 拦截；
//    交付后 reviewer confirm 放行、工程师自审拦截；confirm 后 equipment 可编辑
// 4) 负路径：mock 结果、合成项目、非工程身份、依赖未确认、revision 不符 均拒绝
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MVP = __dirname;
const engine = require(path.join(MVP, 'workflow-engine.js'));
const { WorkflowStore } = require(path.join(MVP, 'workflow-service.cjs'));
const { deliverCalculation, isRealEngineCalculation } = require(path.join(MVP, 'calculation-delivery.cjs'));

const CUSTOMER = 'basic:test-owner';
const ENGINEER = 'basic:test-engineer';
const REVIEWER = 'basic:test-reviewer';

function realResult(requirementsRev, pfdRev) {
  return {
    input_revision: requirementsRev,
    pfd_revision: pfdRev,
    model_version: 'synthetic-three-effect-test-v1',
    software_version: 'DWSIM 10.2.8 (MCP dwsim:5901)',
    property_method: 'NRTL',
    status: 'success',
    execution_mode: 'real_engine',
    engine: { name: 'DWSIM', version: '10.2.8' },
    evidence: [
      { kind: 'flowsheet_model', sha256: 'a'.repeat(64), bytes: 1052561, label: 'model.dwxml' },
      { kind: 'results_record', sha256: 'b'.repeat(64), bytes: 5141, label: 'results.json' },
      { kind: 'flowsheet_screenshot', sha256: 'c'.repeat(64), bytes: 91040, label: 'flowsheet.png' },
    ],
    checks: { mass_balance: 'pass', concentration_target: 'pass' },
    results: { product: { flow_t_h: 1.72, concentration_wt: 70.27 }, mvr_power_kw: 168.1 },
    assumptions: ['合成测试假设，不代表客户物性'],
    missing: [],
    evidence_refs: ['synthetic-test-evidence'],
    boundary: 'NRTL 二元参数缺失，BPR 不可靠；C3 出 HX1 仍带 3.7% 汽相需排汽设施。',
  };
}

function schemeReviewResult(requirementsRev, pfdRev) {
  return {
    ...realResult(requirementsRev, pfdRev),
    model_version: 'synthetic-explicit-balance-test-v1',
    software_version: 'DWSIM 10.2.8 property library',
    property_method: 'IAPWS-IF97',
    calculation_method: 'engine_properties_explicit_balances',
    validation_scope: 'scheme_review',
    engineering_release: false,
    source_result_sha256: 'f'.repeat(64),
    source_findings: {
      checks: { arithmetic_closed: true, operating_limit_met: false },
      warnings: ['Synthetic unmet operating condition retained for review.'],
      unmet_conditions: ['operating_limit_met'],
    },
    claim_limits: ['A conditional arithmetic result is not an equipment-performance guarantee.'],
    evidence: [
      { kind: 'calculation_model', sha256: 'd'.repeat(64), bytes: 1200, label: 'explicit-model.cs' },
      { kind: 'calculation_input', sha256: 'e'.repeat(64), bytes: 600, label: 'input.json' },
      { kind: 'results_record', sha256: 'f'.repeat(64), bytes: 2400, label: 'result.json' },
    ],
    boundary: 'Synthetic scheme-review calculation using real property calls and explicit balances; not a native flowsheet or engineering release.',
  };
}

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecop-calc-delivery-'));
  const store = new WorkflowStore(path.join(dir, 'w.sqlite3'));
  return { store, dir };
}

function cleanup(store, dir) {
  store.database.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 走引擎直通（不经 store.action 门禁），用于铺前置阶段。
function act(store, actorId, action) {
  return store.transaction(database => {
    const { project } = store.readProject(action.project_id, actorId);
    const result = engine.processAction(project, { ...action, actor_id: actorId });
    store.persistNewAction(database, project, action.action_id);
    if (result.ok) store.writeProject(database, project, null);
    return result;
  });
}

function seedConfirmedUpstream(store) {
  const project = store.createBusinessProject(CUSTOMER, '交付通道测试项目', null, [CUSTOMER, ENGINEER, REVIEWER]);
  const pid = project.project_id;
  const add = (userId, role) => store.addBusinessMember(CUSTOMER, pid, { user_id: userId, role, expected_revision: store.readProject(pid, CUSTOMER).project.revision }, [CUSTOMER, ENGINEER, REVIEWER]);
  add(ENGINEER, 'engineer');
  add(REVIEWER, 'reviewer');
  const step = (actorId, stageId, type, payload) => {
    const rev = store.readProject(pid, actorId).project.revision;
    return act(store, actorId, { action_id: `seed-${stageId}-${type}-${Math.random().toString(36).slice(2)}`, project_id: pid, expected_revision: rev, stage_id: stageId, type, payload: payload === undefined ? {} : payload });
  };
  step(CUSTOMER, 'requirements', 'edit', { note: 'n' });
  step(CUSTOMER, 'requirements', 'submit');
  step(REVIEWER, 'requirements', 'confirm');
  step(ENGINEER, 'selection', 'edit', { route: 'r1' });
  step(ENGINEER, 'selection', 'submit');
  step(REVIEWER, 'selection', 'confirm');
  step(ENGINEER, 'pfd', 'edit', { nodes: [] });
  step(ENGINEER, 'pfd', 'submit');
  step(REVIEWER, 'pfd', 'confirm');
  return { pid, project: store.readProject(pid, ENGINEER).project };
}

test('isRealEngineCalculation：完整溯源通过', () => {
  assert.equal(isRealEngineCalculation(realResult(1, 1)), true);
});

test('isRealEngineCalculation：真实物性调用+显式衡算按方案评审范围通过', () => {
  const base = schemeReviewResult(1, 1);
  assert.equal(isRealEngineCalculation(base), true);
  assert.equal(isRealEngineCalculation({ ...base, validation_scope: undefined }), false);
  assert.equal(isRealEngineCalculation({ ...base, engineering_release: true }), false);
  assert.equal(isRealEngineCalculation({ ...base, calculation_method: 'unknown_method' }), false);
  assert.equal(isRealEngineCalculation({ ...base, source_result_sha256: '0'.repeat(64) }), false);
  assert.equal(isRealEngineCalculation({ ...base, claim_limits: [] }), false);
  assert.equal(isRealEngineCalculation({
    ...base,
    source_findings: { ...base.source_findings, unmet_conditions: [] },
  }), false);
  assert.equal(isRealEngineCalculation({ ...base, evidence: base.evidence.filter(item => item.kind !== 'calculation_input') }), false);
  assert.equal(isRealEngineCalculation({
    ...base,
    evidence: [
      { kind: 'flowsheet_model', sha256: 'a'.repeat(64), bytes: 100 },
      { kind: 'results_record', sha256: 'b'.repeat(64), bytes: 100 },
    ],
  }), false);
});

test('isRealEngineCalculation：缺项拒绝', () => {
  const base = realResult(1, 1);
  assert.equal(isRealEngineCalculation({ ...base, execution_mode: 'synthetic_mock' }), false);
  assert.equal(isRealEngineCalculation({ ...base, engine: { name: '', version: '1' } }), false);
  assert.equal(isRealEngineCalculation({ ...base, evidence: [{ kind: 'flowsheet_model', sha256: 'xyz', bytes: 1 }] }), false);
  assert.equal(isRealEngineCalculation({ ...base, evidence: base.evidence.filter(e => e.kind !== 'results_record') }), false);
  assert.equal(isRealEngineCalculation({ ...base, boundary: '' }), false);
  assert.equal(isRealEngineCalculation({ ...base, assumptions: [] }), false);
  assert.equal(isRealEngineCalculation(null), false);
});

test('deliverCalculation：交付+提交+上下文+审计', () => {
  const { store, dir } = newStore();
  try {
    const { pid } = seedConfirmedUpstream(store);
    const project = store.readProject(pid, ENGINEER).project;
    const delivery = deliverCalculation(store, pid, { engineer_id: ENGINEER, result: realResult(project.stages.requirements.revision, project.stages.pfd.revision) });
    assert.equal(delivery.ok, true);
    assert.equal(delivery.calculation.status, 'submitted');
    assert.equal(delivery.calculation.execution_mode, 'real_engine');
    const after = store.readProject(pid, ENGINEER).project;
    assert.equal(after.stages.calculation.status, 'submitted');
    assert.equal(after.execution_context.status, 'completed');
    assert.equal(after.execution_context.mode, 'real_engine');
    assert.equal(after.execution_context.engine, 'DWSIM 10.2.8');
    assert.ok(after.audit.some(a => a.action === 'calc_delivery'));
    assert.equal(isRealEngineCalculation(after.stages.calculation.payload), true);
  } finally {
    cleanup(store, dir);
  }
});

test('方案评审计算：工程师交付后仍由独立 reviewer 确认', () => {
  const { store, dir } = newStore();
  try {
    const { pid } = seedConfirmedUpstream(store);
    const project = store.readProject(pid, ENGINEER).project;
    const delivery = deliverCalculation(store, pid, {
      engineer_id: ENGINEER,
      result: schemeReviewResult(project.stages.requirements.revision, project.stages.pfd.revision),
    });
    assert.equal(delivery.ok, true);
    assert.equal(delivery.calculation.status, 'submitted');
    assert.equal(delivery.calculation.calculation_method, 'engine_properties_explicit_balances');
    assert.equal(delivery.calculation.validation_scope, 'scheme_review');
    assert.equal(delivery.calculation.engineering_release, false);
    const submitted = store.readProject(pid, REVIEWER).project;
    assert.equal(submitted.execution_context.calculation_method, 'engine_properties_explicit_balances');
    assert.equal(submitted.execution_context.engineering_release, false);
    const confirmed = store.action(REVIEWER, {
      action_id: 'scheme-review-confirm',
      project_id: pid,
      expected_revision: submitted.revision,
      stage_id: 'calculation',
      type: 'confirm',
      payload: {},
    });
    assert.equal(confirmed.ok, true);
    assert.equal(store.readProject(pid, REVIEWER).project.stages.calculation.status, 'confirmed');
  } finally {
    cleanup(store, dir);
  }
});

test('HTTP 门禁：edit/submit 拦截；交付前 confirm 拦截；交付后 reviewer confirm 放行、自审拦截', () => {
  const { store, dir } = newStore();
  try {
    const { pid } = seedConfirmedUpstream(store);
    const httpAction = (actorId, type, payload) => {
      const rev = store.readProject(pid, actorId).project.revision;
      return store.action(actorId, { action_id: `http-${type}-${Math.random().toString(36).slice(2)}`, project_id: pid, expected_revision: rev, stage_id: 'calculation', type, payload: payload === undefined ? {} : payload });
    };
    const editBlocked = httpAction(ENGINEER, 'edit', realResult(1, 1));
    assert.equal(editBlocked.ok, false);
    assert.equal(editBlocked.error.code, 'CUSTOMER_SOURCE_NOT_CALCULABLE');
    const submitBlocked = httpAction(ENGINEER, 'submit');
    assert.equal(submitBlocked.error.code, 'CUSTOMER_SOURCE_NOT_CALCULABLE');
    const confirmBlocked = httpAction(REVIEWER, 'confirm');
    assert.equal(confirmBlocked.error.code, 'CUSTOMER_SOURCE_NOT_CALCULABLE');

    const project = store.readProject(pid, ENGINEER).project;
    const delivery = deliverCalculation(store, pid, { engineer_id: ENGINEER, result: realResult(project.stages.requirements.revision, project.stages.pfd.revision) });
    assert.equal(delivery.ok, true);

    const selfConfirm = httpAction(ENGINEER, 'confirm');
    assert.equal(selfConfirm.ok, false);
    assert.equal(selfConfirm.error.code, 'FORBIDDEN');

    const reviewerConfirm = httpAction(REVIEWER, 'confirm');
    assert.equal(reviewerConfirm.ok, true);
    const confirmed = store.readProject(pid, REVIEWER).project;
    assert.equal(confirmed.stages.calculation.status, 'confirmed');

    // 确认后下游 equipment 恢复可编辑（不再被计算门禁牵连）。
    const eqRev = store.readProject(pid, ENGINEER).project.revision;
    const eqEdit = store.action(ENGINEER, { action_id: `eq-${Math.random().toString(36).slice(2)}`, project_id: pid, expected_revision: eqRev, stage_id: 'equipment', type: 'edit', payload: { items: [] } });
    assert.equal(eqEdit.ok, true);
  } finally {
    cleanup(store, dir);
  }
});

test('deliverCalculation 负路径', () => {
  const { store, dir } = newStore();
  try {
    const { pid } = seedConfirmedUpstream(store);
    const project = store.readProject(pid, ENGINEER).project;
    const reqRev = project.stages.requirements.revision;
    const pfdRev = project.stages.pfd.revision;

    const mock = deliverCalculation(store, pid, { engineer_id: ENGINEER, result: { ...realResult(reqRev, pfdRev), execution_mode: 'synthetic_mock' } });
    assert.equal(mock.ok, false);
    assert.equal(mock.error.code, 'CALC_DELIVERY_PROVENANCE_INVALID');

    const incomplete = deliverCalculation(store, pid, { engineer_id: ENGINEER, result: { ...realResult(reqRev, pfdRev), evidence: [] } });
    assert.equal(incomplete.error.code, 'CALC_DELIVERY_PROVENANCE_INVALID');

    const wrongRole = deliverCalculation(store, pid, { engineer_id: CUSTOMER, result: realResult(reqRev, pfdRev) });
    assert.equal(wrongRole.ok, false);
    assert.equal(wrongRole.error.code, 'FORBIDDEN');

    const staleRev = deliverCalculation(store, pid, { engineer_id: ENGINEER, result: realResult(reqRev + 99, pfdRev) });
    assert.equal(staleRev.ok, false);
    assert.equal(staleRev.error.code, 'REVISION_CONFLICT');

    // 依赖未确认：工程师编辑 pfd 使其脱回 draft（return 只作用于 submitted）。
    const editRev = store.readProject(pid, ENGINEER).project.revision;
    act(store, ENGINEER, { action_id: `pfdre-${Math.random().toString(36).slice(2)}`, project_id: pid, expected_revision: editRev, stage_id: 'pfd', type: 'edit', payload: { nodes: [] } });
    const depBlocked = deliverCalculation(store, pid, { engineer_id: ENGINEER, result: realResult(reqRev, pfdRev) });
    assert.equal(depBlocked.ok, false);

    // 合成项目拒绝交付。
    const synthetic = store.createProject('workflow-synthetic-001', '合成', [{ user_id: 'demo-engineer', role: 'engineer' }]);
    const syn = deliverCalculation(store, synthetic.project_id, { engineer_id: 'demo-engineer', result: realResult(1, 1) });
    assert.equal(syn.ok, false);
    assert.equal(syn.error.code, 'FORBIDDEN');
  } finally {
    cleanup(store, dir);
  }
});
