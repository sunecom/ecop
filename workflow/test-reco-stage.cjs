'use strict';
// ECOP-WB-L1-FULLPROCESS-20260926 定向核验：
// deliver()：缺省 workflow_stage 时按工艺推荐默认写入 selection；非法阶段被拒绝。
// 浏览器 workflow-view 的呈现兜底由前端负责人分支单独覆盖。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MVP = __dirname;
const { WorkflowStore } = require(path.join(MVP, 'workflow-service.cjs'));
const { deliver, setup } = require(path.join(MVP, 'manual-review.cjs'));

function seed(store, actor = 'basic:test-owner') {
  const project = store.createBusinessProject(actor, '分类修复测试项目');
  const report = { fields: [{ target_field: 'requirements.feed_rate', value: 6.73, unit: 't/h' }], issues: [], blocking_count: 0 };
  const taskbookId = crypto.randomUUID();
  const now = new Date().toISOString();
  setup(store);
  store.database.prepare('INSERT INTO taskbooks VALUES(?,?,?,?,?,?,?,?,?)')
    .run(taskbookId, project.project_id, actor, 't.xlsx', 'sha-t', Buffer.from('x'), JSON.stringify(report), project.revision, now);
  const data = { kind: 'taskbook', id: taskbookId, sha256: 'sha-t', filename: 't.xlsx', report };
  const json = JSON.stringify({ project_revision: project.revision, data });
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  const reviewId = crypto.randomUUID();
  store.database.prepare('INSERT INTO manual_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(reviewId, project.project_id, json, hash, 'queued', '请发起工艺推荐', null, null, actor, now, now);
  return { project, reviewId };
}

test('deliver()：未标注阶段 → 默认归入 selection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecop-reco-stage-'));
  const store = new WorkflowStore(path.join(dir, 'w.sqlite3'));
  const { reviewId } = seed(store);
  deliver(store, reviewId, {
    summary: '测试摘要',
    options: [{ id: 'r1', name: '路线一', reason: '理由', boundary: '边界' }],
  });
  const row = store.database.prepare('SELECT status,response_json FROM manual_reviews WHERE id=?').get(reviewId);
  assert.equal(row.status, 'awaiting_choice');
  const resp = JSON.parse(row.response_json);
  assert.equal(resp.workflow_stage, 'selection');
  store.database.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deliver()：非法阶段被拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecop-reco-stage-'));
  const store = new WorkflowStore(path.join(dir, 'w.sqlite3'));
  const { reviewId } = seed(store);
  assert.throws(() => deliver(store, reviewId, {
    summary: '测试摘要', workflow_stage: 'bogus',
    options: [{ id: 'r1', name: '路线一', reason: '理由', boundary: '边界' }],
  }), /流程阶段无效/);
  const row = store.database.prepare('SELECT status FROM manual_reviews WHERE id=?').get(reviewId);
  assert.equal(row.status, 'queued');
  store.database.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deliver()：显式阶段原样保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecop-reco-stage-'));
  const store = new WorkflowStore(path.join(dir, 'w.sqlite3'));
  const { reviewId } = seed(store);
  deliver(store, reviewId, {
    summary: '测试摘要', workflow_stage: 'pfd',
    options: [{ id: 'r1', name: '路线一', reason: '理由', boundary: '边界' }],
  });
  const resp = JSON.parse(store.database.prepare('SELECT response_json FROM manual_reviews WHERE id=?').get(reviewId).response_json);
  assert.equal(resp.workflow_stage, 'pfd');
  store.database.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
