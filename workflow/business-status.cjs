'use strict';
// Read-only business status projection — ECOP-WB-L1-WEB-EXECUTE-20260926.
// Backend-authoritative mapping for web presentation. This module NEVER writes
// to projects, stages or reviews, and NEVER upgrades a stage to 'confirmed'.
// Semantics (per correction card ECOP-CODEX-WB-CORRECTION-20260926):
//  - manual_reviews.completed means review-processing finished, NOT engineering pass;
//  - selected means a saved choice only, bound to its project/revision at save time;
//  - stage 'confirmed' is only ever read from the project record itself.
// Reviews are classified by the agent-provided response.workflow_stage; when it is
// absent the review counts as unclassified and no stage is guessed.

const STAGES = ['requirements', 'selection', 'pfd', 'calculation', 'equipment', 'documents'];
const TITLES = { requirements: '需求与任务书', selection: '工艺选择', pfd: '流程与参数', calculation: '工程计算', equipment: '设备与运行', documents: '方案与文件' };
// ECOP-WB-L1-CALCREVIEW-20260927: 04 计算阶段的真实引擎交付不是 manual_reviews 记录，
// 而是阶段载荷本身（服务侧 deliverCalculation 写入，带完整溯源）。这里只读投影其状态，
// 供步骤标签与下一步提示使用；不改变任何阶段状态，也不自动确认。
const { isRealEngineCalculation } = require('./calculation-delivery.cjs');
const STATUS_KEYS = ['queued', 'processing', 'awaiting_choice', 'selected', 'completed'];
const REVIEW_LABELS = {
  queued: '已提交 · 待柯大侠处理',
  processing: '柯大侠处理中',
  awaiting_choice: '待选择',
  selected: '已选择 · 待细化',
  completed: '评审已处理 · 工程另行核对',
};

function responseOf(row) {
  if (!row || !row.response_json) return null;
  try { return JSON.parse(row.response_json); } catch { return null; }
}
function stageOf(row) {
  const response = responseOf(row);
  const stage = response && response.workflow_stage;
  return STAGES.includes(stage) ? stage : null;
}

function nextAction(counts, latestRow, deliveryAvailable, hasRequirements, calculationReviewable) {
  const latest = latestRow || null;
  if (counts.awaiting_choice > 0) return { key: 'choose', text: '审阅待选提议并保存选择；选择保存后由柯大侠接续。', owner: '客户' };
  if (counts.queued + counts.processing > 0) return { key: 'await_agent', text: '柯大侠处理已提交的任务，完成后回写。', owner: '柯大侠' };
  if (calculationReviewable) return { key: 'calculation_review', text: '审阅真实计算结果的溯源、校核项与适用边界，确认后放行下一步。', owner: '审核人 / 工程负责人' };
  if (latest && latest.status === 'selected') return { key: 'refine', text: '柯大侠按所选工艺细化流程与计算依据。', owner: '柯大侠' };
  if (latest && latest.status === 'completed') return { key: 'engineering_check', text: '评审已处理；工程放行、设备定型与待核项另行核对。', owner: '工程负责人 / 柯大侠' };
  if (deliveryAvailable) return { key: 'review_drafts', text: '审阅三份同版评审稿；设备待核项保留。', owner: '客户 / 柯大侠' };
  if (hasRequirements) return { key: 'request_review', text: '可基于现有资料发起工艺推荐。', owner: '资料录入者' };
  return { key: 'start', text: '提交任务书或需求，发起工艺推荐。', owner: '资料录入者' };
}

function projectBusinessStatus(store, projectId, options = {}) {
  const project = options.project || null;
  const deliveryAvailable = Boolean(options.deliveryAvailable);
  // manual_reviews is created lazily by manual-review setup(); a fresh store may not
  // have it yet. Treat a missing table as zero reviews — never fail the project GET.
  const hasTable = store.database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='manual_reviews'"
  ).get();
  const rows = hasTable ? store.database.prepare(
    'SELECT id,status,choice,response_json,created_at,updated_at FROM manual_reviews WHERE project_id=? ORDER BY created_at DESC,rowid DESC'
  ).all(projectId) : [];
  const counts = { total: rows.length, queued: 0, processing: 0, awaiting_choice: 0, selected: 0, completed: 0, unclassified: 0 };
  const stageStats = Object.fromEntries(STAGES.map(id => [id, { review_count: 0, latest_review_status: null, latest_choice: null, has_response: false }]));
  const selectedChoices = [];
  for (const row of rows) {
    if (STATUS_KEYS.includes(row.status)) counts[row.status]++;
    const stage = stageOf(row);
    if (!stage) { counts.unclassified++; continue; }
    const s = stageStats[stage];
    s.review_count++;
    if (!s.latest_review_status) {
      s.latest_review_status = row.status;
      s.has_response = Boolean(responseOf(row));
      if (row.status === 'selected') s.latest_choice = row.choice || null;
    }
    if (row.status === 'selected') selectedChoices.push({ review_id: row.id, stage, choice: row.choice || null, updated_at: row.updated_at || null });
  }
  const calculationStage = project && project.stages ? project.stages.calculation : null;
  const calculationDelivered = Boolean(calculationStage && isRealEngineCalculation(calculationStage.payload));
  const calculationReviewable = calculationDelivered && calculationStage.status === 'submitted';
  const stages = STAGES.map(id => {
    const s = stageStats[id];
    const stageStatus = project && project.stages && project.stages[id] ? (project.stages[id].status || 'draft') : 'draft';
    let display = 'unconfirmed', label = '阶段未确认';
    if (s.latest_review_status) {
      display = s.latest_review_status;
      label = REVIEW_LABELS[s.latest_review_status] || '评审状态待核对';
    } else if (id === 'calculation' && calculationReviewable) { display = 'delivered_review'; label = '真实计算结果已交付 · 待审核'; }
    else if (stageStatus === 'confirmed') { display = 'confirmed'; label = '阶段记录已确认'; }
    else if (stageStatus === 'returned') { display = 'returned'; label = '需修订'; }
    else if (stageStatus === 'stale') { display = 'stale'; label = '需更新'; }
    else if (id === 'requirements' && project && project.stages && project.stages.requirements && project.stages.requirements.payload && project.stages.requirements.payload.taskbook) { display = 'has_material'; label = '任务书已采用'; }
    return { id, title: TITLES[id], stage_status: stageStatus, review_count: s.review_count, latest_review_status: s.latest_review_status, latest_choice: s.latest_choice, has_response: s.has_response, display, label };
  });
  const hasRequirements = Boolean(project && project.stages && project.stages.requirements && project.stages.requirements.payload && project.stages.requirements.payload.taskbook);
  return {
    schema: 1,
    project_id: project ? project.project_id : projectId,
    project_revision: project ? project.revision : null,
    read_only: true,
    review_counts: counts,
    stages,
    selected_choices: selectedChoices,
    latest_review: rows.length ? { id: rows[0].id, status: rows[0].status } : null,
    next_action: nextAction(counts, rows[0] || null, deliveryAvailable, hasRequirements, calculationReviewable),
    calculation_review: { delivered: calculationDelivered, reviewable: calculationReviewable },
    delivery_review_available: deliveryAvailable,
    boundaries: [
      'completed 仅代表评审处理完成，不等于工程通过或设备定型。',
      'selected 仅代表已保存的选择；依据变化后需重新确认，不自动套用到新条件。',
      '阶段 confirmed 只来自项目记录本身，本映射不自动确认任何阶段。',
      '无 workflow_stage 的评审计为未归类，不猜测其步骤归属。',
      'delivered_review 表示 04 阶段载荷已含真实引擎交付（含溯源证据），仅提示待审核；阶段 confirmed 仍需审核人确认。'
    ]
  };
}

module.exports = { projectBusinessStatus, STAGES, TITLES };
