"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateReportBundle, REPORT_GENERATOR_VERSION } = require("./report-generator.cjs");

function snapshot() {
  const ids = ["requirements", "selection", "pfd", "calculation", "equipment", "documents"];
  const stages = Object.fromEntries(ids.map((id, index) => [id, {
    id,
    status: "confirmed",
    revision: index + 1,
    depends_on: index ? [{ stage_id: ids[index - 1], revision: index }] : [],
    payload: { source: `synthetic-${id}` },
  }]));
  stages.requirements.revision = 1;
  stages.selection.depends_on[0].revision = 1;
  stages.pfd.depends_on[0].revision = 2;
  stages.calculation.depends_on[0].revision = 3;
  stages.calculation.payload = { status: "success", input_revision: 1, pfd_revision: 3, method: "synthetic", assumptions: ["recorded assumption"], missing: [] };
  stages.equipment.depends_on[0].revision = 4;
  stages.documents.depends_on[0].revision = 5;
  return { project_id: "test-project", project_revision: 17, frozen: true, stages };
}

test("three drafts share snapshot identity and have deterministic, separate manifest time", () => {
  const source = snapshot();
  const first = generateReportBundle(source, { generatedAt: "2026-01-01T00:00:00.000Z" });
  const second = generateReportBundle(source, { generatedAt: "2026-01-02T00:00:00.000Z" });
  assert.equal(first.documents.length, 3);
  assert.equal(first.manifest.project_revision, 17);
  assert.equal(first.manifest.generator_version, REPORT_GENERATOR_VERSION);
  assert.notEqual(first.manifest.generated_at, second.manifest.generated_at);
  assert.deepEqual(first.documents.map(item => item.content), second.documents.map(item => item.content));
  assert.ok(first.documents.every(item => item.project_revision === 17 && item.snapshot_sha256 === first.manifest.frozen_snapshot_sha256 && item.generator_version === REPORT_GENERATOR_VERSION));
  assert.ok(first.documents.every(item => item.content.includes("TEST ONLY · MOCK") && item.content.includes("非工程签发")));
  assert.ok(first.documents.every(item => item.content.includes("来源：") && item.content.includes("假设") && item.content.includes("缺项")));
  assert.deepEqual(first.manifest.documents.map(item => item.sha256), first.documents.map(item => item.sha256));
});

test("missing and malicious values are rendered as placeholders and escaped text", () => {
  const source = snapshot();
  source.stages.requirements.payload = { objective: "<script>alert('x')</script>", boundary: null };
  const bundle = generateReportBundle(source);
  const html = bundle.documents.find(item => item.id === "technical-proposal").content;
  assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /未提供/);
});

test("unfrozen, incomplete, failed and revision-mismatched snapshots are refused", () => {
  const unfrozen = snapshot();
  unfrozen.frozen = false;
  assert.throws(() => generateReportBundle(unfrozen), error => error.code === "NOT_FROZEN");
  const incomplete = snapshot();
  incomplete.stages.documents.status = "stale";
  assert.throws(() => generateReportBundle(incomplete));
  const failed = snapshot();
  failed.stages.calculation.payload.status = "failed";
  assert.throws(() => generateReportBundle(failed), error => error.code === "CALCULATION_FAILED");
  const mismatch = snapshot();
  mismatch.stages.calculation.payload.input_revision = 2;
  assert.throws(() => generateReportBundle(mismatch), error => error.code === "CALCULATION_REVISION_MISMATCH");
  const dependencyMismatch = snapshot();
  dependencyMismatch.stages.pfd.depends_on[0].revision = 99;
  assert.throws(() => generateReportBundle(dependencyMismatch));
});
