"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("runtime backend modules and both taskbook templates are packaged explicitly", () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, "Dockerfile"), "utf8");
  const ignore = new Set(fs.readFileSync(path.join(__dirname, ".dockerignore"), "utf8").split(/\r?\n/));
  const required = [
    "advisories.cjs", "business-status.cjs", "calculation-delivery.cjs", "manual-review.cjs", "review-drafts.cjs",
    "taskbook-template.xlsx", "taskbook-template-v1.xlsx", "workflow-server.cjs", "workflow-service.cjs",
  ];
  for (const name of required) {
    assert.equal(fs.statSync(path.join(__dirname, name)).isFile(), true, name);
    assert.equal(dockerfile.split(/\r?\n/).some(line => line.startsWith("COPY ") && line.split(/\s+/).includes(name)), true, name);
    assert.equal(ignore.has(`!${name}`), true, name);
  }
  assert.equal(dockerfile.split(/\r?\n/).some(line => /^COPY\s+\.\s/.test(line)), false);
  assert.equal([...ignore].some(rule => rule.startsWith("!") && /private|sqlite|token|secret|\.env/.test(rule)), false);
});
