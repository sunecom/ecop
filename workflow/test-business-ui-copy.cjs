"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const copy = require("./business-ui-copy.js");

test("hidden permission controls and business regions cannot be shown by component display rules", () => {
  const styles = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  const hiddenRule = styles.indexOf("[hidden] { display: none !important; }");
  const buttonRule = styles.indexOf(".button {");
  assert.ok(hiddenRule >= 0 && hiddenRule < buttonRule, "the universal hidden rule must precede component display rules");
  for (const id of ["create-source-project", "source-template-note", "workflow", "business-members", "business-requirements-form"]) {
    assert.match(page, new RegExp(`id="${id}"[^>]*\\shidden(?:\\s|>)`), `${id} must start hidden`);
  }
  assert.match(app, /refs\.createSourceProject\.hidden = sourceTemplates\.length === 0;/);
  assert.match(app, /refs\.sourceTemplateNote\.hidden = sourceTemplates\.length === 0;/);
});

test("single-account business copy does not imply independent reviewers", () => {
  assert.match(copy.accountBoundary(false), /仅配置一个独立登录账号/);
  assert.doesNotMatch(copy.accountBoundary(false), /源资料读取仍使用单独 ACL/);
  assert.match(copy.sourceAccessBoundary(false), /仅配置一个独立登录账号/);
  assert.match(copy.roleModeBoundary(false), /真实多人审核尚不可用/);
  assert.doesNotMatch(copy.roleModeBoundary(false), /共享 Basic Auth/);
});

test("multi-account business copy states identity and source ACL boundaries", () => {
  assert.match(copy.accountBoundary(true), /独立站点认证账号与项目成员授权/);
  assert.match(copy.accountBoundary(true), /源资料读取仍使用单独 ACL/);
  assert.match(copy.sourceAccessBoundary(true), /逐请求校验/);
  assert.match(copy.sourceAccessBoundary(true), /显式源 ACL/);
  assert.doesNotMatch(copy.sourceAccessBoundary(true), /共享账号/);
  assert.match(copy.roleModeBoundary(true), /逐请求校验/);
  assert.doesNotMatch(copy.roleModeBoundary(true), /共享/);
});

test("desktop layout prioritizes a wide main workspace and moves support cards below the left rail", () => {
  const styles = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");
  assert.match(styles, /\/\* Full-screen engineering workspace · 2026-09-24 \*\//);
  assert.match(styles, /grid-template-columns:\s*minmax\(290px, 320px\) minmax\(0, 1fr\)/);
  assert.match(styles, /\.stage-column \{ grid-column: 2; grid-row: 1 \/ span 2;/);
  assert.match(styles, /\.insight-column \{ grid-column: 1; grid-row: 2; grid-template-columns: 1fr;/);
  assert.match(styles, /body \{ font-size: 16px; \}/);
  assert.match(styles, /#business-project-name \{ width: 100%; min-height: 42px;/);
  assert.match(styles, /\.requirement-field input:not\(\[type="checkbox"\]\), \.requirement-field select \{ height: 42px; font-size: 13px; \}/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.insight-column \{ order: 2; grid-template-columns: 1fr; \}/);
});

