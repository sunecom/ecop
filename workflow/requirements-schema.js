(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ECOPRequirementsSchema = factory();
})(globalThis, function () {
  "use strict";

  const FIELD_DEFINITIONS = Object.freeze([
    Object.freeze({ id: "requirements.feed_rate", label: "进料流量", group: "物料条件", type: "number", units: Object.freeze(["kg/h", "t/h", "kg/s"]), requiresUnit: true, requiredForReview: true }),
    Object.freeze({ id: "requirements.feed_concentration", label: "进料浓度", group: "物料条件", type: "number", units: Object.freeze(["wt%", "kg/kg", "g/L", "°Brix"]), requiresUnit: true, basis: true, requiredForReview: true }),
    Object.freeze({ id: "requirements.product_concentration", label: "目标浓度", group: "物料条件", type: "number", units: Object.freeze(["wt%", "kg/kg", "g/L", "°Brix"]), requiresUnit: true, basis: true, requiredForReview: true }),
    Object.freeze({ id: "requirements.concentration_component", label: "浓度对应的组分口径", group: "物料条件", type: "text", options: Object.freeze(["total_solids", "maltitol_only", "other"]), requiredForReview: true }),
    Object.freeze({ id: "requirements.design_concentration_basis", label: "浓度定义与测量方法", group: "物料条件", type: "text", units: Object.freeze([]), requiredForReview: true }),
    Object.freeze({ id: "requirements.feed_temperature", label: "进料温度", group: "运行条件", type: "number", units: Object.freeze(["°C", "K"]) }),
    Object.freeze({ id: "requirements.atmospheric_pressure", label: "现场大气压力", group: "运行条件", type: "number", units: Object.freeze(["kPa(a)", "bar(a)", "mmHg(a)" ]), requiresUnit: true, requiredForReview: true }),
    Object.freeze({ id: "requirements.vacuum_pressure_profile", label: "真空压力范围/分布", group: "运行条件", type: "text", units: Object.freeze([]) }),
    Object.freeze({ id: "requirements.electricity_price", label: "电价", group: "公用工程", type: "number", units: Object.freeze(["CNY/kWh", "CNY/MWh"]) }),
    Object.freeze({ id: "requirements.steam_price", label: "蒸汽价格", group: "公用工程", type: "number", units: Object.freeze(["CNY/t", "CNY/GJ"]) }),
    Object.freeze({ id: "requirements.cooling_water_price", label: "冷却水价格", group: "公用工程", type: "number", units: Object.freeze(["CNY/t", "CNY/m³"]) }),
    Object.freeze({ id: "requirements.utility_usage", label: "公用工程供应与计量说明", group: "公用工程", type: "text", units: Object.freeze([]) }),
  ]);
  const DEFINITION_BY_ID = new Map(FIELD_DEFINITIONS.map(definition => [definition.id, definition]));
  const SOURCE_STATES = new Set(["source_reported", "assumed", "missing", "user_entered"]);
  const BASIS_VALUES = new Set(["", "mass_fraction", "mass_percent", "mass_per_volume", "refractometer_brix", "other"]);

  function copy(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function sourceState(field) {
    if (!field) return "missing";
    if (SOURCE_STATES.has(field.source_status)) return field.source_status;
    if (SOURCE_STATES.has(field.status)) return field.status;
    return field.value === null || field.value === undefined ? "missing" : "source_reported";
  }

  function createField(definition, sourceField) {
    const hasSource = Boolean(sourceField);
    const sourceValue = hasSource ? (sourceField.source_snapshot_value !== undefined ? sourceField.source_snapshot_value : sourceField.value ?? null) : null;
    const sourceUnit = hasSource ? (sourceField.source_snapshot_unit !== undefined ? sourceField.source_snapshot_unit : sourceField.original_unit || sourceField.unit || "") : "";
    const initialValue = hasSource ? (sourceField.current_value !== undefined ? sourceField.current_value : sourceField.value ?? null) : null;
    return {
      target_field: definition.id,
      label: definition.label,
      group: definition.group,
      value_type: definition.type,
      value: copy(initialValue),
      unit: hasSource ? (sourceField.unit || sourceUnit) : "",
      value_basis: hasSource && typeof sourceField.value_basis === "string" ? sourceField.value_basis : "",
      source_snapshot_value_basis: hasSource && typeof sourceField.source_snapshot_value_basis === "string" ? sourceField.source_snapshot_value_basis : hasSource && typeof sourceField.value_basis === "string" ? sourceField.value_basis : "",
      source_status: sourceState(sourceField),
      source_snapshot_value: copy(sourceValue),
      source_snapshot_unit: sourceUnit,
      source_reference: hasSource ? copy(sourceField.source_reference || sourceField.source || null) : null,
      confirmed: hasSource && sourceField.confirmed === true,
      revision_status: hasSource && sourceField.revision_status === "modified" ? "modified" : "unchanged",
    };
  }

  function createRequirementsPayload(projectName, sourcePayload) {
    const sourceFields = sourcePayload && Array.isArray(sourcePayload.fields) ? sourcePayload.fields : [];
    const byId = new Map(sourceFields.filter(field => field && typeof field.target_field === "string").map(field => [field.target_field, field]));
    const fields = FIELD_DEFINITIONS.map(definition => createField(definition, byId.get(definition.id)));
    const represented = new Set(FIELD_DEFINITIONS.map(definition => definition.id));
    for (const sourceField of sourceFields) {
      if (!sourceField || typeof sourceField.target_field !== "string" || represented.has(sourceField.target_field)) continue;
      fields.push(createField({ id: sourceField.target_field, label: sourceField.label || sourceField.target_field, group: "来源资料其他字段", type: "text" }, sourceField));
    }
    return {
      schema_version: "ecop-requirements-1",
      project_name: projectName,
      record_status: "draft",
      data_source_kind: sourcePayload && sourcePayload.data_source_kind === "customer_source" ? "customer_source" : "customer_entered",
      source_field_status_summary: sourcePayload && sourcePayload.field_status_summary ? copy(sourcePayload.field_status_summary) : null,
      fields,
      missing_for_review: missingForReview(fields),
    };
  }

  function missingForReview(fields) {
    return FIELD_DEFINITIONS.filter(definition => definition.requiredForReview).flatMap(definition => {
      const field = fields.find(item => item.target_field === definition.id);
      if (!field || field.value === null || field.value === "") return [definition.id];
      if (definition.options && !definition.options.includes(field.value)) return [definition.id];
      if (definition.basis && !field.value_basis) return [`${definition.id}:basis`];
      if (definition.requiresUnit && !field.unit) return [`${definition.id}:unit`];
      return [];
    });
  }

  function normalizeRequirementsPayload(submitted, previous) {
    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
      return { ok: false, errors: [{ code: "INVALID_INPUT", message: "需求内容必须是 JSON 对象。" }] };
    }
    const errors = [];
    const name = typeof submitted.project_name === "string" ? submitted.project_name.trim() : "";
    if (!name || name.length > 120) errors.push({ field: "project_name", code: "INVALID_PROJECT_NAME", message: "项目名称不能为空且最多 120 个字符。" });
    if (submitted.schema_version !== "ecop-requirements-1" || !Array.isArray(submitted.fields) || submitted.fields.length > 200) {
      errors.push({ code: "INVALID_REQUIREMENTS_SCHEMA", message: "需求字段结构无效。" });
    }
    if (errors.length) return { ok: false, errors };

    const previousFields = new Map((previous && Array.isArray(previous.fields) ? previous.fields : []).map(field => [field.target_field, field]));
    const submittedFields = new Map(submitted.fields.map(field => field && typeof field.target_field === "string" ? [field.target_field, field] : []).filter(entry => entry.length));
    const concentrationMethod = submittedFields.get("requirements.design_concentration_basis");
    const concentrationMethodValue = concentrationMethod && concentrationMethod.value;
    const seen = new Set();
    const fields = [];
    for (const submittedField of submitted.fields) {
      if (!submittedField || typeof submittedField.target_field !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(submittedField.target_field) || seen.has(submittedField.target_field)) {
        errors.push({ code: "INVALID_FIELD_ID", message: "需求字段标识无效或重复。" });
        continue;
      }
      seen.add(submittedField.target_field);
      const id = submittedField.target_field;
      const definition = DEFINITION_BY_ID.get(id);
      const prior = previousFields.get(id);
      const value = submittedField.value;
      if (!(value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) || (typeof value === "string" && value.length > 4096)) {
        errors.push({ field: id, code: "INVALID_FIELD_VALUE", message: "字段值格式无效。" });
        continue;
      }
      const unit = typeof submittedField.unit === "string" ? submittedField.unit.trim() : "";
      if (unit.length > 40) errors.push({ field: id, code: "INVALID_UNIT", message: "单位长度超出限制。" });
      if (definition && unit && !(definition.units || []).includes(unit) && unit !== (prior && prior.source_snapshot_unit)) {
        errors.push({ field: id, code: "INVALID_UNIT", message: "单位不在此字段允许的选项中。" });
      }
      const basis = typeof submittedField.value_basis === "string" ? submittedField.value_basis : "";
      if (!BASIS_VALUES.has(basis)) errors.push({ field: id, code: "INVALID_BASIS", message: "浓度基准选项无效。" });
      if (definition && definition.options && value !== null && !definition.options.includes(value) &&
        !(prior && prior.source_status !== "user_entered" && value === prior.value)) {
        errors.push({ field: id, code: "INVALID_OPTION", message: "字段值必须选择已支持的选项；未映射来源文本可保留但不能提交审核。" });
      }
      const confirmed = submittedField.confirmed === true;
      if (submittedField.confirmed !== undefined && typeof submittedField.confirmed !== "boolean") {
        errors.push({ field: id, code: "INVALID_CONFIRMATION", message: "字段确认状态无效。" });
      }
      if (definition && definition.type === "number" && value !== null && typeof value !== "number" && !(typeof value === "string" && prior && prior.source_status !== "user_entered" && value === prior.value)) {
        errors.push({ field: id, code: "INVALID_NUMBER", message: "新录入的字段必须是有限数值；原始来源文本可保留但不能用于计算。" });
      }
      if (definition && definition.type === "number" && typeof value === "number" && !Number.isFinite(value)) {
        errors.push({ field: id, code: "INVALID_NUMBER", message: "此字段必须是有限数值。" });
      }
      if (definition && typeof value === "number") {
        if (["requirements.feed_rate", "requirements.atmospheric_pressure"].includes(id) && value <= 0) {
          errors.push({ field: id, code: "INVALID_PHYSICAL_VALUE", message: "流量和绝对压力必须大于零。" });
        }
        if (definition.basis && value <= 0) errors.push({ field: id, code: "INVALID_PHYSICAL_VALUE", message: "浓度必须大于零。" });
        if (definition.basis && basis === "mass_fraction" && value > 1) errors.push({ field: id, code: "INVALID_PHYSICAL_VALUE", message: "质量分数必须在 0 到 1 之间。" });
        if (definition.basis && basis === "mass_percent" && value > 100) errors.push({ field: id, code: "INVALID_PHYSICAL_VALUE", message: "质量百分数不能超过 100%。" });
        if (definition.basis && basis === "refractometer_brix" && value > 100) errors.push({ field: id, code: "INVALID_PHYSICAL_VALUE", message: "折光仪读数不能超过 100 °Brix。" });
      }
      if (definition && definition.basis && basis) {
        const compatibleUnit = { mass_fraction: "kg/kg", mass_percent: "wt%", mass_per_volume: "g/L", refractometer_brix: "°Brix" }[basis];
        if (compatibleUnit && unit && unit !== compatibleUnit) errors.push({ field: id, code: "INCOMPATIBLE_BASIS_UNIT", message: "浓度基准与单位不匹配。" });
        if (basis === "other" && !(typeof concentrationMethodValue === "string" && concentrationMethodValue.trim())) {
          errors.push({ field: id, code: "CONCENTRATION_METHOD_REQUIRED", message: "选择其他浓度基准时，请填写定义与测量方法。" });
        }
      }
      if (confirmed && (value === null || value === "" || (definition && (definition.units || []).length > 0 && !unit) || (definition && definition.basis && !basis))) {
        errors.push({ field: id, code: "INCOMPLETE_CONFIRMATION", message: "字段有值、单位和必要基准后才能标记为已核实。" });
      }
      if (confirmed && definition && definition.type === "number" && typeof value !== "number") {
        errors.push({ field: id, code: "CONFIRMED_NUMBER_REQUIRED", message: "数值字段完成核实前，必须先录入有限数值。" });
      }
      const sourceStatus = prior ? prior.source_status : (value === null ? "missing" : "user_entered");
      const sourceValue = prior ? prior.source_snapshot_value : null;
      const sourceUnit = prior ? prior.source_snapshot_unit : "";
      const sourceBasis = prior ? prior.source_snapshot_value_basis || "" : "";
      const sourceReference = prior ? copy(prior.source_reference) : null;
      const revisionStatus = prior && (JSON.stringify(value) !== JSON.stringify(sourceValue) || unit !== sourceUnit || basis !== sourceBasis) ? "modified" : prior ? "unchanged" : (value !== null || unit || basis) ? "modified" : "unchanged";
      fields.push({
        target_field: id,
        label: definition ? definition.label : (prior && prior.label) || String(submittedField.label || id).slice(0, 160),
        group: definition ? definition.group : (prior && prior.group) || "用户补充字段",
        value_type: definition ? definition.type : (prior && prior.value_type) || "text",
        value: copy(value),
        unit,
        value_basis: basis,
        source_status: sourceStatus,
        source_snapshot_value: copy(sourceValue),
        source_snapshot_unit: sourceUnit,
        source_snapshot_value_basis: sourceBasis,
        source_reference: sourceReference,
        confirmed,
        revision_status: revisionStatus,
      });
    }
    if (errors.length) return { ok: false, errors };
    const missingFields = missingForReview(fields);
    return {
      ok: true,
      payload: {
        schema_version: "ecop-requirements-1",
        project_name: name,
        record_status: "draft",
        data_source_kind: previous && previous.data_source_kind || submitted.data_source_kind || "customer_entered",
        source_field_status_summary: previous && previous.source_field_status_summary || null,
        fields,
        missing_for_review: missingFields,
      },
      projectName: name,
    };
  }

  function validateForReview(payload) {
    const normalized = normalizeRequirementsPayload(payload, payload);
    if (!normalized.ok) return normalized;
    const fields = normalized.payload.fields;
    const missing = missingForReview(fields);
    const errors = missing.map(field => ({ field, code: "REQUIRED_FIELD_MISSING", message: "关键字段、单位或浓度基准尚未补齐。" }));
    for (const definition of FIELD_DEFINITIONS.filter(item => item.requiredForReview && item.type === "number")) {
      const field = fields.find(item => item.target_field === definition.id);
      if (field && typeof field.value !== "number") errors.push({ field: definition.id, code: "REVIEW_NUMBER_REQUIRED", message: "提交审核前，关键数值字段必须录入可校核的有限数值。" });
    }
    for (const definition of FIELD_DEFINITIONS.filter(item => item.requiredForReview && item.options)) {
      const field = fields.find(item => item.target_field === definition.id);
      if (!field || !definition.options.includes(field.value)) errors.push({ field: definition.id, code: "REVIEW_CHOICE_REQUIRED", message: "请选择明确、受支持的组分口径。" });
    }
    return errors.length ? { ok: false, errors } : { ok: true, payload: normalized.payload };
  }

  return Object.freeze({ FIELD_DEFINITIONS, createRequirementsPayload, missingForReview, normalizeRequirementsPayload, validateForReview });
});
