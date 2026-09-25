"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const schema = require("./requirements-schema.js");

function field(payload, id) {
  return payload.fields.find(item => item.target_field === id);
}

test("requirements form safely handles every field definition including definitions without units", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.ok(schema.FIELD_DEFINITIONS.some(definition => !Object.hasOwn(definition, "units")));
  assert.match(appSource, /const options = Array\.isArray\(definition && definition\.units\) \? definition\.units : \[\];/);
  assert.match(appSource, /if \(options\.length \|\| field\.unit \|\| field\.source_snapshot_unit\)/);
  assert.doesNotMatch(appSource, /definition\.units\.length/);
  for (const definition of schema.FIELD_DEFINITIONS) {
    const options = Array.isArray(definition && definition.units) ? definition.units : [];
    assert.doesNotThrow(() => options.length, definition.id);
  }
});

test("blank business requirements remain explicit and do not invent numeric defaults", () => {
  const payload = schema.createRequirementsPayload("麦芽糖醇项目");
  assert.equal(payload.data_source_kind, "customer_entered");
  for (const id of ["requirements.feed_rate", "requirements.feed_concentration", "requirements.product_concentration", "requirements.atmospheric_pressure"]) {
    assert.equal(field(payload, id).value, null);
  }
  assert.ok(payload.missing_for_review.includes("requirements.feed_concentration"));
  assert.equal(schema.validateForReview(payload).ok, false);
});

test("source values and provenance remain immutable while current values are versioned", () => {
  const source = {
    data_source_kind: "customer_source",
    field_status_summary: { total: 1, source_reported: 1, assumed: 0, missing: 0 },
    fields: [{ target_field: "requirements.feed_rate", status: "source_reported", value: "原始流量文本", original_unit: "kg/h", source: { position: "Sheet1!B2" } }],
  };
  const payload = schema.createRequirementsPayload("麦芽糖醇项目工作副本", source);
  const normalized = schema.normalizeRequirementsPayload({
    ...payload,
    fields: payload.fields.map(item => item.target_field === "requirements.feed_rate" ? { ...item, value: 125, unit: "kg/h" } : item),
  }, payload);
  assert.equal(normalized.ok, true);
  const flow = field(normalized.payload, "requirements.feed_rate");
  assert.equal(flow.value, 125);
  assert.equal(flow.source_snapshot_value, "原始流量文本");
  assert.equal(flow.source_snapshot_unit, "kg/h");
  assert.equal(flow.source_status, "source_reported");
  assert.equal(flow.revision_status, "modified");
  assert.deepEqual(flow.source_reference, { position: "Sheet1!B2" });
  assert.equal(normalized.payload.data_source_kind, "customer_source");
  assert.deepEqual(normalized.payload.source_field_status_summary, source.field_status_summary);
});

test("concentration basis and physical units are explicit; invalid edits are rejected", () => {
  const payload = schema.createRequirementsPayload("麦芽糖醇项目");
  const submitted = {
    ...payload,
    fields: payload.fields.map(item => item.target_field === "requirements.feed_concentration"
      ? { ...item, value: 60, unit: "wt%", value_basis: "mass_percent" }
      : item),
  };
  assert.equal(schema.normalizeRequirementsPayload(submitted, payload).ok, true);
  const missingBasis = structuredClone(submitted);
  missingBasis.fields.find(item => item.target_field === "requirements.feed_concentration").value_basis = "";
  const normalizedMissingBasis = schema.normalizeRequirementsPayload(missingBasis, payload);
  assert.equal(normalizedMissingBasis.ok, true);
  assert.ok(normalizedMissingBasis.payload.missing_for_review.includes("requirements.feed_concentration:basis"));
  const invalidUnit = structuredClone(submitted);
  invalidUnit.fields.find(item => item.target_field === "requirements.feed_rate").unit = "kg/hr";
  invalidUnit.fields.find(item => item.target_field === "requirements.feed_rate").value = 10;
  assert.ok(schema.normalizeRequirementsPayload(invalidUnit, payload).errors.some(error => error.code === "INVALID_UNIT"));
  const invalidNumber = structuredClone(submitted);
  invalidNumber.fields.find(item => item.target_field === "requirements.feed_rate").value = "ten";
  assert.ok(schema.normalizeRequirementsPayload(invalidNumber, payload).errors.some(error => error.code === "INVALID_NUMBER"));
});

test("confirmation accepts unitless methods but rejects impossible flow, pressure, concentration, and basis combinations", () => {
  const payload = schema.createRequirementsPayload("麦芽糖醇项目");
  const withChanges = changes => ({
    ...payload,
    fields: payload.fields.map(item => ({ ...item, ...(changes[item.target_field] || {}) })),
  });
  const unitlessMethod = withChanges({
    "requirements.design_concentration_basis": { value: "质量百分数，烘箱法", confirmed: true },
  });
  assert.equal(schema.normalizeRequirementsPayload(unitlessMethod, payload).ok, true);
  const confirmedComponent = withChanges({
    "requirements.concentration_component": { value: "other", confirmed: true },
  });
  assert.equal(schema.normalizeRequirementsPayload(confirmedComponent, payload).ok, true);
  confirmedComponent.fields.find(f => f.target_field === "requirements.concentration_component").unit = "kg/h";
  assert.ok(schema.normalizeRequirementsPayload(confirmedComponent, payload).errors.some(e => e.code === "INVALID_UNIT"));

  for (const [id, value] of [["requirements.feed_temperature", 40], ["requirements.electricity_price", 0.5]]) {
    const unitlessQuantity = withChanges({ [id]: { value, confirmed: true } });
    assert.ok(schema.normalizeRequirementsPayload(unitlessQuantity, payload).errors.some(error => error.code === "INCOMPLETE_CONFIRMATION"), id);
  }
  const unbasedConcentration = withChanges({
    "requirements.feed_concentration": { value: 50, unit: "wt%", confirmed: true },
  });
  assert.ok(schema.normalizeRequirementsPayload(unbasedConcentration, payload).errors.some(error => error.code === "INCOMPLETE_CONFIRMATION"));

  for (const [id, change] of [
    ["requirements.feed_rate", { value: 0, unit: "kg/h" }],
    ["requirements.atmospheric_pressure", { value: -1, unit: "kPa(a)" }],
    ["requirements.feed_concentration", { value: 150, unit: "wt%", value_basis: "mass_percent", confirmed: true }],
    ["requirements.product_concentration", { value: 1.2, unit: "kg/kg", value_basis: "mass_fraction", confirmed: true }],
    ["requirements.feed_concentration", { value: 50, unit: "wt%", value_basis: "refractometer_brix", confirmed: true }],
  ]) {
    const result = schema.normalizeRequirementsPayload(withChanges({ [id]: change }), payload);
    assert.equal(result.ok, false, id);
    assert.ok(result.errors.some(error => ["INVALID_PHYSICAL_VALUE", "INCOMPATIBLE_BASIS_UNIT"].includes(error.code)), id);
  }

  const sourceText = schema.createRequirementsPayload("麦芽糖醇项目", {
    fields: [{ target_field: "requirements.feed_rate", status: "source_reported", value: "约100", original_unit: "kg/h" }],
  });
  const falselyConfirmed = structuredClone(sourceText);
  falselyConfirmed.fields.find(item => item.target_field === "requirements.feed_rate").confirmed = true;
  assert.ok(schema.normalizeRequirementsPayload(falselyConfirmed, sourceText).errors.some(error => error.code === "CONFIRMED_NUMBER_REQUIRED"));
  assert.ok(schema.validateForReview(sourceText).errors.some(error => error.code === "REVIEW_NUMBER_REQUIRED"));
});
