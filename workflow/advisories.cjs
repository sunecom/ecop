'use strict';
/*
 * 仅展示工程建议（advisory）受控通道。
 *
 * 设计约束（ECOP-CODEX2WB-L1-advisory-path-decision-20260928，总控裁决 C）：
 * - 与工艺推荐 awaiting_choice 流程完全分离：requires_choice 恒为 false，无选择语义，
 *   不重开已确认初选/PFD 审核状态；
 * - 记录存为独立附属表 project_advisories，不写入 workflow_projects，
 *   不改变 project revision / 阶段状态，不使 review-drafts 清单 409；
 * - HTTP 仅 GET（沿用既有项目成员 ACL，loadProject 先行校验；存在性隐藏 404）；
 *   发布（publish）为 operator 专用通道，不经 HTTP 暴露；
 * - 每条记录钉扎 source_revision；项目版本前进后标记 stale 保留为历史参考，不删除；
 * - 幂等：同 (project_id, advisory_key) 重复发布按键更新，不新增行；
 * - 内容守卫：拒绝包含内部路径/凭据字样的建议文本。
 */
const { randomUUID } = require('node:crypto');
const STAGES = ['requirements', 'selection', 'pfd', 'calculation', 'equipment', 'documents'];
const FORBIDDEN_CONTENT = /\.local|\/opt\/|\/app\/|secret|token|password/i;

function fail(message, status = 400) {
  const e = new Error(message);
  e.advisoryStatus = status;
  throw e;
}

function setup(store) {
  store.database.exec(`CREATE TABLE IF NOT EXISTS project_advisories(
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES workflow_projects(project_id),
    advisory_key TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    stage_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    body_markdown TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, advisory_key)
  )`);
}

function view(row, currentRevision) {
  return {
    id: row.id,
    project_id: row.project_id,
    advisory_key: row.advisory_key,
    stage_id: row.stage_id,
    requires_choice: false,
    stale: row.source_revision !== currentRevision,
    source_revision: row.source_revision,
    summary: row.summary,
    body_markdown: row.body_markdown,
    actor_id: row.actor_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// HTTP GET：项目成员可读；调用前路由层已用 loadProject 完成 ACL（非成员 404）。
function list(store, actorId, projectId) {
  setup(store);
  const p = store.readProject(projectId, actorId).project;
  const rows = store.database
    .prepare('SELECT * FROM project_advisories WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 20')
    .all(projectId);
  return { ok: true, advisories: rows.map(r => view(r, p.revision)) };
}

// Operator 专用发布通道（与 manual-review deliver 同风格，不经 HTTP 暴露）。
function publish(store, projectId, input) {
  setup(store);
  const actorId = input && input.actor_id;
  const p = store.readProject(projectId, actorId).project;
  const member = (p.members || []).find(m => m.user_id === actorId);
  if (!['customer', 'engineer'].includes(member && member.role)) fail('当前身份不允许发布工程建议。', 403);
  if (p.frozen) fail('项目已冻结，不接受工程建议发布。', 409);
  if (!Number.isInteger(input.source_revision) || input.source_revision !== p.revision) {
    fail(`来源版本与当前项目不一致（当前 ${p.revision}），禁止盲写旧版本。`, 409);
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(input.advisory_key || ''))) fail('advisory_key 必须为安全标识符。');
  if (!STAGES.includes(input.stage_id)) fail('stage_id 无效。');
  if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 200) fail('summary 必须为 1-200 字符。');
  if (typeof input.body_markdown !== 'string' || !input.body_markdown.trim() || input.body_markdown.length > 8000) fail('body_markdown 必须为 1-8000 字符。');
  if (FORBIDDEN_CONTENT.test(input.summary) || FORBIDDEN_CONTENT.test(input.body_markdown)) fail('工程建议内容包含不允许的内部引用。');
  const now = new Date().toISOString();
  store.database.prepare(`INSERT INTO project_advisories(id,project_id,advisory_key,source_revision,stage_id,summary,body_markdown,actor_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id, advisory_key) DO UPDATE SET
      source_revision=excluded.source_revision, stage_id=excluded.stage_id,
      summary=excluded.summary, body_markdown=excluded.body_markdown,
      actor_id=excluded.actor_id, updated_at=excluded.updated_at`)
    .run(randomUUID(), projectId, input.advisory_key, input.source_revision, input.stage_id,
      input.summary, input.body_markdown, actorId, now, now);
  const row = store.database
    .prepare('SELECT * FROM project_advisories WHERE project_id=? AND advisory_key=?')
    .get(projectId, input.advisory_key);
  return { ok: true, advisory: view(row, p.revision) };
}

module.exports = { setup, list, publish };
