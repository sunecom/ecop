'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

const uiPath = process.argv[2];
if (!uiPath) throw new Error('usage: node test_workspace_download_callback.cjs <workspace-ui.js>');
const uiSource = fs.readFileSync(uiPath, 'utf8');
const goodBody = Buffer.from('validated review draft');
const goodSha = crypto.createHash('sha256').update(goodBody).digest('hex');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = {};
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.attributes = {};
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector() { return null; }
}

function response({ body = goodBody, sha = goodSha, includeSha = true }) {
  const headers = new Map();
  if (includeSha) headers.set('x-review-draft-sha256', sha);
  return {
    ok: true,
    status: 200,
    headers: { get: name => headers.get(String(name).toLowerCase()) || null },
    blob: async () => new Blob([body]),
  };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

async function runScenario(downloadResponse) {
  const elements = [];
  const ids = new Map();
  let anchorClicks = 0;
  const alerts = [];
  const document = {
    createElement(tag) {
      const element = new FakeElement(tag);
      if (tag === 'a') element.click = () => { anchorClicks += 1; };
      elements.push(element);
      return element;
    },
    getElementById(id) {
      if (!ids.has(id)) ids.set(id, new FakeElement('div'));
      return ids.get(id);
    },
  };
  const stages = ['requirements', 'selection', 'pfd', 'calculation', 'equipment', 'documents'];
  const workflowView = {
    STAGES: stages,
    TITLES: Object.fromEntries(stages.map(stage => [stage, stage])),
    deriveWorkflowView() {
      return {
        stages: stages.map(id => ({ id, label: 'confirmed', reviews: [], evidence: [] })),
        unclassified: [], needsChoice: [], currentProposal: 'proposal', decisionSummary: 'none',
        nextSummary: 'owner review', nextOwner: 'owner', deliveryMessage: 'ready',
        currentDelivery: false, realCalculationDelivered: false,
      };
    },
    reviewStage: () => null,
    isRealEngineCalculation: () => false,
    stageRecordPresent: () => false,
    documentDeliverables: () => [],
  };
  const sandbox = {
    console,
    document,
    ECOPWorkflowView: workflowView,
    AbortController,
    Blob,
    crypto: crypto.webcrypto,
    alert: message => alerts.push(message),
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    setTimeout,
    clearTimeout,
    fetch: async url => {
      const value = String(url);
      if (value.endsWith('/manual-review')) return { ok: true, status: 200, json: async () => ({ ok: true, reviews: [] }) };
      if (value.endsWith('/advisories')) return { ok: true, status: 200, json: async () => ({ ok: true, advisories: [] }) };
      if (value.endsWith('/review-drafts/draft-1')) return downloadResponse;
      throw new Error(`unexpected fetch ${value}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(uiSource, sandbox, { filename: uiPath });
  const project = {
    project_id: 'project-1', revision: 74, title: 'L1', frozen: false, read_only: false,
    delivery_review_available: false,
    stages: Object.fromEntries(stages.map(stage => [stage, { status: 'confirmed', payload: null }])),
  };
  sandbox.ECOPWorkspaceUI.render({
    business: true, role: 'customer', project, config: { basePath: '/workflow' }, onStage: () => {},
    adapter: {
      listReviewDrafts: async () => ({
        ok: true,
        review_drafts: {
          project_id: 'project-1', project_revision: 74,
          documents: [{ id: 'draft-1', label: '方案评审稿', name: 'draft.docx', sha256: goodSha, bytes: goodBody.length }],
        },
      }),
    },
  });
  await settle();
  sandbox.ECOPWorkspaceUI.navigate('documents');
  const button = elements.find(element => element.tagName === 'button' && element.textContent === '下载' && element.listeners.click);
  if (!button) throw new Error('actual controlled-download button was not rendered');
  await button.listeners.click();
  return { anchorClicks, alerts };
}

(async () => {
  const correct = await runScenario(response({}));
  if (correct.anchorClicks !== 1 || correct.alerts.length !== 0) throw new Error(`correct response failed: ${JSON.stringify(correct)}`);

  const missing = await runScenario(response({ includeSha: false }));
  if (missing.anchorClicks !== 0 || !missing.alerts.some(text => text.includes('响应头哈希缺失'))) throw new Error(`missing header was not rejected: ${JSON.stringify(missing)}`);

  const wrongHeader = await runScenario(response({ sha: '0'.repeat(64) }));
  if (wrongHeader.anchorClicks !== 0 || !wrongHeader.alerts.some(text => text.includes('响应头哈希缺失'))) throw new Error(`wrong header was not rejected: ${JSON.stringify(wrongHeader)}`);

  const wrongContent = await runScenario(response({ body: Buffer.from('tampered review draft') }));
  if (wrongContent.anchorClicks !== 0 || !wrongContent.alerts.some(text => text.includes('下载内容哈希'))) throw new Error(`wrong content was not rejected: ${JSON.stringify(wrongContent)}`);

  process.stdout.write(JSON.stringify({
    ok: true,
    actual_workspace_ui: uiPath,
    correct_response_created_download: true,
    missing_header_rejected: true,
    wrong_header_rejected: true,
    wrong_content_rejected: true,
  }) + '\n');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
