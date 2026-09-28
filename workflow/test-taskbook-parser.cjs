"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const python = process.env.ECOP_TASKBOOK_PYTHON || (process.platform === "win32" ? "python" : "python3");

function parse(buffer, expectedStatus = 0) {
  const result = spawnSync(python, ["-X", "utf8", path.join(__dirname, "taskbook-parser.py")], {
    input: buffer,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expectedStatus, result.stderr.toString("utf8"));
  return JSON.parse(result.stdout.toString("utf8"));
}

test("taskbook parser recognizes v2 and legacy v1 templates", () => {
  const v2 = parse(fs.readFileSync(path.join(__dirname, "taskbook-template.xlsx")));
  const v1 = parse(fs.readFileSync(path.join(__dirname, "taskbook-template-v1.xlsx")));
  assert.equal(v2.ok, true);
  assert.equal(v2.report.format_version, "ECOP-TASKBOOK-2");
  assert.equal(v1.ok, true);
  assert.equal(v1.report.format_version, "ECOP-TASKBOOK-1");
});

test("taskbook parser rejects corrupt and oversized input without executing it", () => {
  const corrupt = parse(Buffer.from("not an xlsx", "utf8"), 1);
  const oversized = parse(Buffer.alloc(300 * 1024 + 1), 1);
  assert.equal(corrupt.ok, false);
  assert.match(corrupt.error, /ZIP|任务书|文件/i);
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /300 KiB/);
});
