"use strict";

/*
 * Review-drafts catalog（评审草稿受控阅读/下载）。
 *
 * 设计约束（codex-l1-pfd-download-close-20260927）：
 * - 清单为运维配置的私有文件：客户端不可传入任意路径/身份参数；
 * - 服务器内部文件路径绝不出现在任何响应中；
 * - 复用既有项目成员 ACL（路由层 loadProject 先行校验）与同版防过期校验
 *   （清单钉扎 project_revision，项目版本变动即拒绝）；
 * - 下载前按登记 sha256/bytes 逐字节核验，不符即拒绝；
 * - 本通道只提供已登记的评审草稿阅读/下载，不改变工程确认权限，
 *   草稿下载不等于正式签发（engineering_release 保持 false）。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class ReviewDraftsError extends Error {
  constructor(code, message, deliveryStatus) {
    super(message);
    this.code = code;
    this.deliveryStatus = deliveryStatus;
  }
}

function invalid(message) {
  return new ReviewDraftsError("REVIEW_DRAFTS_INVALID", message, 500);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw invalid("评审草稿清单无效。");
  for (const key of ["delivery_id", "project_id", "project_revision", "documents"]) {
    if (!(key in manifest)) throw invalid(`评审草稿清单缺少字段 ${key}。`);
  }
  if (typeof manifest.delivery_id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(manifest.delivery_id)) {
    throw invalid("delivery_id 必须为安全标识符。");
  }
  if (typeof manifest.project_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.project_id)) {
    throw invalid("project_id 必须为安全标识符。");
  }
  if (!Number.isInteger(manifest.project_revision) || manifest.project_revision < 0) {
    throw invalid("project_revision 必须为非负整数。");
  }
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw invalid("documents 必须为非空数组。");
  }
  const seen = new Set();
  for (const doc of manifest.documents) {
    if (!doc || typeof doc !== "object") throw invalid("documents 条目无效。");
    for (const key of ["id", "name", "path", "sha256", "bytes", "content_type"]) {
      if (!(key in doc)) throw invalid(`documents 条目缺少字段 ${key}。`);
    }
    if (typeof doc.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(doc.id) || seen.has(doc.id)) {
      throw invalid("documents 条目 id 必须唯一且为安全标识符。");
    }
    if (typeof doc.name !== "string" || doc.name.length === 0 || doc.name.length > 200) {
      throw invalid("documents 条目 name 无效。");
    }
    if (typeof doc.path !== "string" || !path.isAbsolute(doc.path)) {
      throw invalid("documents 条目 path 必须为服务器内部绝对路径。");
    }
    if (!/^[a-f0-9]{64}$/.test(doc.sha256)) throw invalid("documents 条目 sha256 必须为 64 位十六进制。");
    if (!Number.isInteger(doc.bytes) || doc.bytes <= 0) throw invalid("documents 条目 bytes 必须为正整数。");
    if (typeof doc.content_type !== "string" || doc.content_type.length === 0) throw invalid("documents 条目 content_type 无效。");
    seen.add(doc.id);
  }
}

class ReviewDraftsCatalog {
  constructor(manifest) {
    validateManifest(manifest);
    this.manifest = manifest;
  }

  has(projectId) {
    return typeof projectId === "string" && this.manifest.project_id === projectId;
  }

  _binding(project) {
    if (!project || project.project_id !== this.manifest.project_id) {
      throw new ReviewDraftsError("REVIEW_DRAFTS_NOT_FOUND", "当前项目尚无登记的评审草稿。", 404);
    }
    const current = Number(project.revision);
    if (!Number.isInteger(current) || current !== this.manifest.project_revision) {
      throw new ReviewDraftsError(
        "DELIVERY_PROJECT_CHANGED",
        `项目版本已更新（登记 ${this.manifest.project_revision}，当前 ${Number.isInteger(current) ? current : "?"}），评审草稿清单过期；需按当前版本重新登记。`,
        409,
      );
    }
  }

  list(project) {
    this._binding(project);
    return {
      ok: true,
      review_drafts: {
        delivery_id: this.manifest.delivery_id,
        project_id: this.manifest.project_id,
        project_revision: this.manifest.project_revision,
        generated_at: this.manifest.generated_at || null,
        stage_snapshot: this.manifest.stage_snapshot || null,
        note: this.manifest.note || "",
        engineering_release: false,
        documents: this.manifest.documents.map((d) => ({
          id: d.id,
          name: d.name,
          label: d.label || "",
          sha256: d.sha256,
          bytes: d.bytes,
          content_type: d.content_type,
        })),
      },
    };
  }

  open(project, docId) {
    this._binding(project);
    if (typeof docId !== "string") {
      throw new ReviewDraftsError("REVIEW_DRAFTS_NOT_FOUND", "未找到该评审草稿。", 404);
    }
    const doc = this.manifest.documents.find((d) => d.id === docId);
    if (!doc) throw new ReviewDraftsError("REVIEW_DRAFTS_NOT_FOUND", "未找到该评审草稿。", 404);
    let body;
    try {
      body = fs.readFileSync(doc.path);
    } catch {
      throw new ReviewDraftsError("REVIEW_DRAFTS_FILE_UNAVAILABLE", "评审草稿文件暂不可用，请联系运维核对登记。", 503);
    }
    if (!Buffer.isBuffer(body) || body.length !== doc.bytes) {
      throw new ReviewDraftsError("REVIEW_DRAFTS_HASH_MISMATCH", "评审草稿文件与登记清单不一致，已拒绝下载。", 500);
    }
    const actual = crypto.createHash("sha256").update(body).digest("hex");
    if (actual !== doc.sha256) {
      throw new ReviewDraftsError("REVIEW_DRAFTS_HASH_MISMATCH", "评审草稿文件与登记清单不一致，已拒绝下载。", 500);
    }
    return {
      buffer: body,
      document: { id: doc.id, name: doc.name, content_type: doc.content_type, sha256: actual, bytes: body.length },
    };
  }
}

module.exports = { ReviewDraftsCatalog, ReviewDraftsError };
