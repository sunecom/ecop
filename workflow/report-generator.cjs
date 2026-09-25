"use strict";

const { createHash } = require("node:crypto");

const REPORT_GENERATOR_VERSION = "ecop-workflow-reports-1.0.0";
const STAGES = ["requirements", "selection", "pfd", "calculation", "equipment", "documents"];
const STAGE_FIELDS = {
  requirements: ["objective", "boundary", "known_inputs", "assumptions", "missing"],
  selection: ["alternatives", "selected_route", "rationale", "evidence_refs", "assumptions", "missing"],
  pfd: ["streams", "equipment", "connections", "revision_basis", "assumptions", "missing"],
  calculation: ["method", "model_version", "software_version", "property_method", "checks", "assumptions", "missing", "evidence_refs"],
  equipment: ["items", "sizing_basis", "calculation_revision", "assumptions", "missing"],
  documents: ["deliverables", "source_revision", "notes", "assumptions", "missing"],
};
const REPORTS = [
  { id: "technical-proposal", file_name: "technical-proposal.html", title: "技术方案草稿", stages: ["requirements", "selection", "pfd"] },
  { id: "calculation-book", file_name: "calculation-book.html", title: "计算书草稿", stages: ["requirements", "pfd", "calculation"] },
  { id: "equipment-selection-parameters", file_name: "equipment-selection-parameters.html", title: "设备选型参数清单草稿", stages: ["pfd", "calculation", "equipment", "documents"] },
];

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fail(message, code = "REPORT_SNAPSHOT_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("冻结快照结构无效。");
  if (snapshot.frozen !== true) fail("报告仅能从已冻结快照生成。", "NOT_FROZEN");
  if (typeof snapshot.project_id !== "string" || !snapshot.project_id || !Number.isInteger(snapshot.project_revision) || snapshot.project_revision < 1) fail("项目版本身份无效。");
  if (!snapshot.stages || typeof snapshot.stages !== "object") fail("快照缺少阶段数据。");
  for (let index = 0; index < STAGES.length; index += 1) {
    const id = STAGES[index];
    const stage = snapshot.stages[id];
    if (!stage || stage.status !== "confirmed" || !Number.isInteger(stage.revision) || stage.revision < 1) fail(`阶段 ${id} 未处于有效确认状态。`);
    if (!Array.isArray(stage.depends_on)) fail(`阶段 ${id} 的依赖数据无效。`);
    for (const dependency of stage.depends_on) {
      const upstream = snapshot.stages[dependency.stage_id];
      if (!upstream || upstream.status !== "confirmed" || dependency.revision !== upstream.revision) fail(`阶段 ${id} 的依赖版本不一致。`);
    }
    if (index > 0 && !stage.depends_on.some(item => item.stage_id === STAGES[index - 1] && item.revision === snapshot.stages[STAGES[index - 1]].revision)) fail(`阶段 ${id} 未绑定前序阶段当前版本。`);
    if (!stage.payload || typeof stage.payload !== "object" || Array.isArray(stage.payload)) fail(`阶段 ${id} 缺少有效载荷。`);
  }
  const calculation = snapshot.stages.calculation.payload;
  if (calculation.status !== "success") fail("计算阶段不是成功状态。", "CALCULATION_FAILED");
  if (calculation.input_revision !== snapshot.stages.requirements.revision || calculation.pfd_revision !== snapshot.stages.pfd.revision) fail("计算输入版本与冻结阶段版本不一致。", "CALCULATION_REVISION_MISMATCH");
  return snapshot;
}

function valueText(value) {
  if (value === undefined || value === null || value === "") return "未提供";
  if (typeof value === "string") return value;
  if (["number", "boolean"].includes(typeof value)) return String(value);
  return JSON.stringify(value, null, 2);
}

function stageHtml(snapshot, stageId) {
  const stage = snapshot.stages[stageId];
  const sourceText = `stages.${stageId}.payload · 阶段版本 r${stage.revision}`;
  const assumptions = stage.payload.assumptions;
  const missing = stage.payload.missing;
  const keys = [...new Set([...STAGE_FIELDS[stageId], ...Object.keys(stage.payload).sort()])];
  const facts = keys.map(key => `<li><strong>${escapeHtml(key)}</strong><pre>${escapeHtml(valueText(stage.payload[key]))}</pre><small>来源：${escapeHtml(sourceText)}.${escapeHtml(key)}</small></li>`).join("");
  return `<section><h2>${escapeHtml(stageId)} · r${stage.revision}</h2><p>来源：${escapeHtml(sourceText)}</p><ul>${facts || "<li>未提供</li>"}</ul><h3>假设</h3><pre>${escapeHtml(valueText(assumptions))}</pre><h3>缺项</h3><pre>${escapeHtml(valueText(missing))}</pre></section>`;
}

function renderDocument(snapshot, report, snapshotHash) {
  const stages = report.stages.map(id => stageHtml(snapshot, id)).join("");
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#17212b}header{border-bottom:2px solid #182d3d;padding-bottom:1rem}.warning{background:#fff2cc;border:2px solid #a65e00;padding:1rem;font-weight:700}code,pre{white-space:pre-wrap;overflow-wrap:anywhere}section{border-top:1px solid #bbc5cc;margin-top:1.5rem;padding-top:1rem}small{color:#52616b}</style></head><body><header><div class="warning">TEST ONLY · MOCK — 合成数据测试草稿 / 非工程签发，不得用于工程设计、采购、施工或运行决策。</div><h1>${escapeHtml(report.title)}</h1><p>项目：${escapeHtml(snapshot.project_id)} · 项目版本：v${snapshot.project_revision}</p><p>冻结快照 SHA-256：<code>${snapshotHash}</code></p><p>生成器版本：<code>${REPORT_GENERATOR_VERSION}</code></p></header><main>${stages}</main><footer><p>本文件仅呈现冻结快照中已有信息；未提供字段以“未提供”标识，不补造型号、参数或工程结论。</p></footer></body></html>`;
  return body;
}

function generateReportBundle(snapshot, options = {}) {
  validateSnapshot(snapshot);
  const snapshotHash = sha256(stableStringify(snapshot));
  const identity = {
    project_id: snapshot.project_id,
    project_revision: snapshot.project_revision,
    snapshot_sha256: snapshotHash,
    generator_version: REPORT_GENERATOR_VERSION,
  };
  const documents = REPORTS.map(report => {
    const content = renderDocument(snapshot, report, snapshotHash);
    return {
      ...identity,
      id: report.id,
      file_name: report.file_name,
      content_type: "text/html; charset=utf-8",
      content: Buffer.from(content, "utf8").toString("utf8"),
      sha256: sha256(content),
    };
  });
  const generatedAt = options.generatedAt || new Date().toISOString();
  return {
    ok: true,
    documents,
    manifest: {
      generated_at: generatedAt,
      project_id: identity.project_id,
      project_revision: identity.project_revision,
      frozen_snapshot_sha256: snapshotHash,
      generator_version: REPORT_GENERATOR_VERSION,
      documents: documents.map(({ content, ...metadata }) => metadata),
    },
  };
}

module.exports = { REPORT_GENERATOR_VERSION, generateReportBundle, escapeHtml, stableStringify };
