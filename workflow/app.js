(function () {
  "use strict";

  const stageMeta = [
    { id: "requirements", title: "需求与任务书", subtitle: "边界与目标", audience: "CUSTOMER INPUT", description: "下载任务书 → 填写上传 → 校对修订 → 确认采用 → 提交审核。" },
    { id: "selection", title: "工艺选择", subtitle: "技术路线", audience: "ENGINEERING", description: "整理可选路线、筛选依据与待验证事项，并绑定已确认的需求版本。" },
    { id: "pfd", title: "流程与参数", subtitle: "流程与物流", audience: "PROCESS DESIGN", description: "记录流程结构、关键物流和设备连接关系。由已选工艺逐步细化，并核对各项依据。" },
    { id: "calculation", title: "工程计算", subtitle: "方法与校核", audience: "CALCULATION BOUNDARY", description: "绑定输入与 PFD 版本；执行模式单独显示，未连接的工程引擎不会产生计算结果。" },
    { id: "equipment", title: "设备与运行", subtitle: "规格与边界", audience: "ENGINEERING", description: "维护设备位号、规格边界及与当前计算版本的依赖关系。" },
    { id: "documents", title: "方案与文件", subtitle: "版本化输出", audience: "PROJECT RECORD", description: "整理交付物目录和引用版本；冻结导出会包含六步一致快照。" },
  ];
  const roleNames = { customer: "客户", engineer: "工程师", reviewer: "审核人", lead: "负责人" };
  const userNames = { "demo-customer": "客户演示账号", "demo-engineer": "工程师演示账号", "demo-reviewer": "审核人演示账号", "demo-lead": "负责人演示账号" };
  const statusNames = { draft: "草稿", submitted: "待审核", returned: "已退回", confirmed: "已确认", stale: "需更新" };
  const statusSubtitles = { draft: "准备中", submitted: "等待审核", returned: "修改后重新提交", confirmed: "版本已确认", stale: "上游已变化" };
  const defaultPayloads = {
    requirements: { objective: "示例目标：完成单元流程方案", boundary: "合成演示范围", known_inputs: [], missing: ["待补充字段"], assumptions: [] },
    selection: { alternatives: [], selected_route: null, rationale: "", evidence_refs: [] },
    pfd: { streams: [], equipment: [], connections: [], revision_basis: "" },
    calculation: { input_revision: 1, pfd_revision: 1, model_version: "0.1-synthetic", software_version: "browser-demo", property_method: "synthetic", status: "success", checks: { balance: "pass" }, assumptions: [], missing: [], evidence_refs: [] },
    equipment: { items: [], sizing_basis: "", calculation_revision: "" },
    documents: { deliverables: [], source_revision: "", notes: "" },
  };

  const byId = id => document.getElementById(id);
  byId('workspace-menu-toggle').addEventListener('click',()=>{
    const expanded=byId('workspace-menu-toggle').getAttribute('aria-expanded')==='true';
    byId('workspace-menu-toggle').setAttribute('aria-expanded',String(!expanded));
    byId('workspace-navigation').classList.toggle('is-open',!expanded);
  });
  const refs = {
    home: byId("project-home"), workspace: byId("workflow"), homeNotice: byId("home-notice"),
    accountNote: byId("business-account-note"), projectHomeButton: byId("project-home-button"),
    newProjectName: byId("new-project-name"), createEmptyProject: byId("create-empty-project"),
    createSourceProject: byId("create-source-project"), sourceTemplateNote: byId("source-template-note"),
    businessProjectList: byId("business-project-list"), projectListCount: byId("project-list-count"),
    syntheticDemoLink: byId("synthetic-demo-link"), businessRequirementsForm: byId("business-requirements-form"),
    businessProjectName: byId("business-project-name"), requirementsFields: byId("requirements-fields"),
    requirementsSaveState: byId("requirements-save-state"), discardRequirementsDraft: byId("discard-requirements-draft"), requirementsMissing: byId("requirements-missing"),
    roleSelectContainer: byId("role-select-container"),
    businessMembers: byId("business-members"), businessMemberCount: byId("business-member-count"),
    businessMemberList: byId("business-member-list"), businessMemberManager: byId("business-member-manager"),
    businessMemberUser: byId("business-member-user"), businessMemberRole: byId("business-member-role"),
    businessMemberAdd: byId("business-member-add"), businessMemberNote: byId("business-member-note"),
    stageNav: byId("stage-nav"), title: byId("stage-title"), desc: byId("stage-description"),
    audience: byId("stage-audience"), number: byId("stage-number"), breadcrumb: byId("breadcrumb-stage"),
    status: byId("stage-status"), stageRevision: byId("stage-revision"), projectRevision: byId("project-revision"),
    returnReasonDisplay: byId("stage-return-reason"),
    payload: byId("payload-editor"), payloadHelp: byId("payload-help"), payloadFormat: byId("payload-format"), permission: byId("edit-permission"), notice: byId("notice"),
    save: byId("save-button"), submit: byId("submit-button"), confirm: byId("confirm-button"),
    return: byId("return-button"), commentForm: byId("comment-form"), commentInput: byId("comment-input"), commentButton: byId("comment-button"),
    returnReasonWrap: byId("return-reason-wrap"), returnReason: byId("return-reason"),
    comments: byId("comments-list"), commentCount: byId("comment-count"), dependencies: byId("dependencies-list"),
    history: byId("stage-history"), audit: byId("audit-list"), role: byId("role-select"), roleInitial: byId("role-initial"),
    calcTools: byId("calculation-tools"), calcFail: byId("calc-fail"), calcRun: byId("calc-run"), exportButton: byId("export-button"),
    downloadExport: byId("download-export"), exportCopy: byId("export-copy"), exportMeta: byId("export-meta"),
    reportDownloads: byId("report-downloads"), reportButtons: [...document.querySelectorAll("[data-report-id]")],
    dataSourcePill: byId("data-source-pill"), executionPill: byId("execution-pill"),
    caseProvenance: byId("case-provenance"), caseProvenanceTitle: byId("case-provenance-title"), caseSource: byId("case-source-label"),
    caseExecution: byId("case-execution-label"), caseAuth: byId("case-auth-label"),
    caseSourceSummary: byId("case-source-summary"), caseSourceLimit: byId("case-source-limit"),
    caseMissingSummary: byId("case-missing-summary"), caseMissingFields: byId("case-missing-fields"),
    casePfdPreview: byId("case-pfd-preview"), casePfdSvg: byId("case-pfd-svg"), casePfdNote: byId("case-pfd-note"),
    customerCalculationGuard: byId("customer-calculation-guard"), footerContext: byId("footer-context"),
    modePill: byId("mode-pill"),
    workflowContext: byId("workflow-context"),
    projectSelect: byId("project-select"), projectTitle: byId("project-title"),
    roleModeLabel: byId("role-mode-label"), roleModeNote: byId("role-mode-note"),
  };

  const workflowConfig = window.ECOPWorkflowConfig || { mode: "auth_required", basePath: "" };
  const adapter = workflowConfig.mode === "synthetic_local"
    ? ECOPWorkflowSyntheticAdapter.createSyntheticAdapter()
    : ECOPWorkflowHttpAdapter.createHttpAdapter({ mode: workflowConfig.mode, basePath: workflowConfig.basePath, csrfToken: workflowConfig.csrfToken });
  const controller = ECOPWorkflowController.createController({ adapter, projectId: workflowConfig.projectId, actorId: workflowConfig.actorId, render });
  let availableProjects = [];
  let sourceTemplates = [];
  let businessTeam = null;
  let businessTeamRequestKey = null;
  const businessMode = adapter.mode === "business_proxy";
  const businessFormStorageKey = projectId => `ecop-workflow-requirements-draft:${projectId}`;

  function setHomeNotice(text, isError) {
    refs.homeNotice.hidden = !text;
    refs.homeNotice.classList.toggle("is-error", !!isError);
    refs.homeNotice.textContent = text || "";
  }

  function loadUnsavedRequirements(project) {
    if (!businessMode || !project || !window.sessionStorage) return null;
    try {
      const raw = window.sessionStorage.getItem(businessFormStorageKey(project.project_id));
      if (!raw) return null;
      const draft = JSON.parse(raw);
      return draft && draft.payload && typeof draft.base_revision === "number" ? draft : null;
    } catch {
      return null;
    }
  }

  function storeUnsavedRequirements(project, payload, baseRevision) {
    if (!project || !window.sessionStorage) return false;
    try {
      window.sessionStorage.setItem(businessFormStorageKey(project.project_id), JSON.stringify({ base_revision: baseRevision, payload }));
      return true;
    } catch {
      return false;
    }
  }

  function clearUnsavedRequirements(projectId) {
    try { if (projectId && window.sessionStorage) window.sessionStorage.removeItem(businessFormStorageKey(projectId)); }
    catch { return; }
  }

  function requirementsFieldValue(field) {
    if (field.value === null || field.value === undefined || field.value === "") return null;
    if (field.value_type === "number") {
      if (typeof field.value === "number") return field.value;
      const text = String(field.value).trim();
      if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return Number(text);
    }
    return field.value;
  }

  function collectRequirementsForm(project) {
    const stored = loadUnsavedRequirements(project);
    const base = stored ? stored.payload : project.stages.requirements.payload;
    const payload = JSON.parse(JSON.stringify(base || ECOPRequirementsSchema.createRequirementsPayload(project.title)));
    payload.project_name = refs.businessProjectName.value.trim();
    for (const row of refs.requirementsFields.querySelectorAll("[data-field-id]")) {
      const field = payload.fields.find(item => item.target_field === row.dataset.fieldId);
      if (!field) continue;
      const valueControl = row.querySelector("[data-value-control]");
      field.value = valueControl.value.trim() === "" ? null : requirementsFieldValue({ ...field, value: valueControl.value });
      const unitControl = row.querySelector("[data-unit-control]");
      const basisControl = row.querySelector("[data-basis-control]");
      const confirmationControl = row.querySelector("[data-confirm-control]");
      if (unitControl) field.unit = unitControl.value;
      if (basisControl) field.value_basis = basisControl.value;
      if (confirmationControl) field.confirmed = confirmationControl.checked;
    }
    return payload;
  }

  function fieldStatusLabel(status) {
    return ({ source_reported: "来源报告", assumed: "来源解释/假设", missing: "缺项", user_entered: "用户录入" })[status] || "待核对";
  }

  function renderRequirementsForm(project) {
    const basePayload = project.stages.requirements.payload || ECOPRequirementsSchema.createRequirementsPayload(project.title);
    const unsaved = loadUnsavedRequirements(project);
    const payload = unsaved ? unsaved.payload : basePayload;
    refs.businessProjectName.value = payload.project_name || project.title;
    refs.requirementsFields.replaceChildren();
    const fieldsById = new Map((payload.fields || []).map(field => [field.target_field, field]));
    const definitions = ECOPRequirementsSchema.FIELD_DEFINITIONS;
    const orderedFields = [
      ...definitions.map(definition => fieldsById.get(definition.id) || {
        target_field: definition.id, label: definition.label, group: definition.group,
        value_type: definition.type, value: null, unit: "", value_basis: "", source_status: "missing",
        source_snapshot_value: null, source_snapshot_unit: "", source_reference: null, confirmed: false,
      }),
      ...(payload.fields || []).filter(field => !definitions.some(definition => definition.id === field.target_field)),
    ];
    const groups = new Map();
    for (const field of orderedFields) {
      const groupName = field.group || "用户补充字段";
      if (!groups.has(groupName)) {
        const group = document.createElement("fieldset");
        group.className = "requirements-group";
        const legend = makeNode("legend", "", groupName);
        group.append(legend);
        groups.set(groupName, group);
        refs.requirementsFields.append(group);
      }
      const definition = definitions.find(item => item.id === field.target_field);
      const row = document.createElement("div");
      row.className = "requirement-field";
      row.dataset.fieldId = field.target_field;
      const label = makeNode("label", "requirement-label", field.label || (definition && definition.label) || field.target_field);
      const rawValue = field.value === null || field.value === undefined ? "" : String(field.value);
      const value = definition && definition.options ? document.createElement("select") : document.createElement("input");
      const valueType = field.value_type || (definition && definition.type) || "text";
      value.dataset.valueControl = "true";
      value.setAttribute("aria-label", `${field.label || field.target_field}当前值`);
      if (definition && definition.options) {
        const placeholder = makeNode("option", "", "请选择明确的组分口径");
        placeholder.value = "";
        value.append(placeholder);
        for (const option of definition.options) {
          const element = makeNode("option", "", ({ total_solids: "总固形物", maltitol_only: "仅麦芽糖醇", other: "其他（暂不支持计算）" })[option] || option);
          element.value = option;
          value.append(element);
        }
        if (rawValue && !definition.options.includes(rawValue)) {
          const element = makeNode("option", "", `来源值未映射 · ${rawValue}`);
          element.value = rawValue;
          value.append(element);
        }
        value.value = rawValue;
      } else {
        value.type = valueType === "number" && (rawValue === "" || typeof field.value === "number") ? "number" : "text";
        value.inputMode = valueType === "number" ? "decimal" : "text";
        if (value.type === "number") value.step = "any";
        value.value = rawValue;
      }
      label.append(value);
      row.append(label);

      const options = Array.isArray(definition && definition.units) ? definition.units : [];
      if (options.length || field.unit || field.source_snapshot_unit) {
        const unitLabel = makeNode("label", "requirement-unit-label", "单位");
        const unit = document.createElement("select");
        unit.dataset.unitControl = "true";
        const placeholder = makeNode("option", "", "选择单位");
        placeholder.value = "";
        unit.append(placeholder);
        for (const option of options) {
          const element = makeNode("option", "", option);
          element.value = option;
          unit.append(element);
        }
        const preservedUnit = field.unit || field.source_snapshot_unit || "";
        if (preservedUnit && !options.includes(preservedUnit)) {
          const element = makeNode("option", "", `来源单位 · ${preservedUnit}`);
          element.value = preservedUnit;
          unit.append(element);
        }
        unit.value = preservedUnit;
        unitLabel.append(unit);
        row.append(unitLabel);
      }
      if (definition && definition.basis) {
        const basisLabel = makeNode("label", "requirement-basis-label", "数值基准");
        const basis = document.createElement("select");
        basis.dataset.basisControl = "true";
        const basisOptions = [["", "请选择基准"], ["mass_fraction", "质量分数 kg/kg"], ["mass_percent", "质量百分数 wt%"], ["mass_per_volume", "质量/体积浓度"], ["refractometer_brix", "折光仪 °Brix"], ["other", "其他（请在说明中注明）"]];
        for (const [id, text] of basisOptions) {
          const element = makeNode("option", "", text);
          element.value = id;
          basis.append(element);
        }
        basis.value = field.value_basis || "";
        basisLabel.append(basis);
        row.append(basisLabel);
      }
      const metadata = document.createElement("div");
      metadata.className = "requirement-field-meta";
      metadata.append(makeNode("span", "field-source-status", fieldStatusLabel(field.source_status)));
      const confirmationLabel = makeNode("label", "field-confirmation", "我已核对");
      const confirmation = document.createElement("input");
      confirmation.type = "checkbox";
      confirmation.checked = field.confirmed === true;
      confirmation.dataset.confirmControl = "true";
      confirmationLabel.prepend(confirmation);
      metadata.append(confirmationLabel);
      row.append(metadata);
      const originalValue = field.source_snapshot_value;
      const reference = field.source_reference && (field.source_reference.position || field.source_reference.cell || field.source_reference.document);
      if (originalValue !== null && originalValue !== undefined || reference) {
        const details = document.createElement("details");
        details.className = "field-source-details";
        details.append(makeNode("summary", "", "查看来源原值"));
        const text = originalValue === null || originalValue === undefined ? "来源原值未提供" : `原值：${String(originalValue)}${field.source_snapshot_unit ? ` ${field.source_snapshot_unit}` : ""}${field.source_snapshot_value_basis ? ` · 原始基准 ${field.source_snapshot_value_basis}` : ""}`;
        details.append(makeNode("span", "", reference ? `${text} · 来源位置 ${String(reference)}` : text));
        row.append(details);
      }
      groups.get(groupName).append(row);
    }
    const missingIds = ECOPRequirementsSchema.missingForReview(payload.fields || []);
    const missing = missingIds.map(id => {
      const definition = definitions.find(item => item.id === id || `${item.id}:basis` === id || `${item.id}:unit` === id);
      return definition ? `${definition.label}${id.endsWith(":basis") ? "（基准）" : id.endsWith(":unit") ? "（单位）" : ""}` : id;
    });
    refs.requirementsMissing.textContent = missing.length ? `待补充后提交审核：${missing.join("、")}` : "关键条件已填写；提交审核仍需工程师复核来源与适用性。";
    const hasUnsaved = Boolean(unsaved);
    const conflict = hasUnsaved && unsaved.base_revision !== project.revision;
    refs.requirementsSaveState.textContent = conflict ? `有未保存修改（基于 v${unsaved.base_revision}；服务器现为 v${project.revision}）` : hasUnsaved ? "有未保存修改 · 刷新可恢复" : `已加载服务端版本 v${project.revision}`;
    refs.requirementsSaveState.classList.toggle("is-unsaved", hasUnsaved);
    refs.requirementsSaveState.classList.toggle("is-conflict", conflict);
    refs.discardRequirementsDraft.hidden = !hasUnsaved;
    refs.discardRequirementsDraft.disabled = !hasUnsaved;
    refs.businessProjectName.disabled = project.frozen;
    for (const control of refs.requirementsFields.querySelectorAll("input,select")) control.disabled = project.frozen;
  }

  function renderProjectHome() {
    refs.home.hidden = false;
    refs.workspace.hidden = true;
    refs.projectTitle.textContent = "请选择项目";
    refs.projectHomeButton.hidden = true;
    refs.projectListCount.textContent = String(availableProjects.length);
    refs.accountNote.textContent = ECOPBusinessUiCopy.accountBoundary(workflowConfig.multiUser === true);
    refs.businessProjectList.replaceChildren();
    if (!availableProjects.length) {
      refs.businessProjectList.append(makeNode("p", "project-list-empty", "还没有已保存项目。可从空白项目开始录入，或从当前麦芽糖醇资料建立独立工作副本。"));
    }
    for (const item of availableProjects) {
      const card = makeNode("article", "business-project-card");
      const copy = makeNode("div", "business-project-copy");
      copy.append(makeNode("strong", "", item.title), makeNode("span", "", `${item.data_source_kind === "customer_source" ? "客户资料工作副本" : "用户录入项目"} · v${item.revision} · ${item.updated_at ? formatTime(item.updated_at) : "刚创建"}`));
      const open = makeNode("button", "button button-secondary", "继续项目 →");
      open.type = "button";
      open.addEventListener("click", async () => {
        setHomeNotice("正在从服务端加载已保存项目…", false);
        const result = await controller.selectProject(item.project_id);
        if (result.ok) setHomeNotice("", false);
        else setHomeNotice(result.error && result.error.message || "项目读取失败。", true);
      });
      card.append(copy, open);
      refs.businessProjectList.append(card);
    }
  }

  function renderBusinessMembers(project) {
    if (!businessMode || !project) {
      refs.businessMembers.hidden = true;
      return;
    }
    refs.businessMembers.hidden = false;
    refs.businessMemberManager.hidden = project.owner_id !== controller.state.actorId;
    const members = businessTeam && businessTeam.project_id === project.project_id && businessTeam.revision === project.revision
      ? businessTeam.members : project.members;
    refs.businessMemberCount.textContent = String(members.length);
    refs.businessMemberList.replaceChildren();
    for (const member of members) {
      const role = ({ customer: "项目提交者", engineer: "工程师", reviewer: "审核人", lead: "负责人" })[member.role] || member.role;
      refs.businessMemberList.append(makeNode("li", "", `${member.user_id} · ${role}`));
    }
    const eligible = businessTeam && businessTeam.project_id === project.project_id && businessTeam.revision === project.revision
      ? businessTeam.eligible_collaborators : [];
    refs.businessMemberUser.replaceChildren();
    const available = eligible.filter(userId => !members.some(member => member.user_id === userId));
    if (!available.length) {
      const option = makeNode("option", "", "暂无其他已配置账号");
      option.value = "";
      refs.businessMemberUser.append(option);
      refs.businessMemberUser.disabled = true;
      refs.businessMemberAdd.disabled = true;
      refs.businessMemberNote.textContent = workflowConfig.multiUser
        ? "当前没有可添加的未加入项目账号。"
        : "当前只有一个独立登录账号；需先配置另一位工作流账号，才能进行真实双人审核。";
    } else {
      for (const userId of available) {
        const option = makeNode("option", "", userId);
        option.value = userId;
        refs.businessMemberUser.append(option);
      }
      refs.businessMemberUser.disabled = false;
      refs.businessMemberAdd.disabled = false;
      refs.businessMemberNote.textContent = "只可选择独立认证的站点账号；不能通过页面角色切换冒充审核人。";
    }
  }

  function refreshBusinessMembers(project) {
    if (!businessMode || !project) return;
    const key = `${project.project_id}:${project.revision}`;
    if (businessTeam && businessTeam.project_id === project.project_id && businessTeam.revision === project.revision) {
      renderBusinessMembers(project);
      return;
    }
    renderBusinessMembers(project);
    if (businessTeamRequestKey === key) return;
    businessTeamRequestKey = key;
    adapter.listMembers(project.project_id).then(result => {
      if (!result.ok || controller.state.projectId !== project.project_id || controller.state.project.revision !== project.revision) return;
      businessTeam = { project_id: project.project_id, revision: project.revision, members: result.members || [], eligible_collaborators: result.eligible_collaborators || [] };
      renderBusinessMembers(controller.state.project);
    }).catch(() => {
      if (controller.state.projectId === project.project_id) refs.businessMemberNote.textContent = "成员权限列表读取失败，请刷新后重试。";
    }).finally(() => {
      if (businessTeamRequestKey === key) businessTeamRequestKey = null;
    });
  }

  function getRole(project, actorId) {
    const member = project.members.find(item => item.user_id === actorId);
    return member ? member.role : null;
  }

  function isEditable(role, stage) {
    if (!stage || !["draft", "returned", "confirmed", "stale"].includes(stage.status)) return false;
    return role === "engineer" || (role === "customer" && stage.id === "requirements");
  }

  function canSubmit(role, stage) {
    const roleAllowed = role === "engineer" || (role === "customer" && stage.id === "requirements");
    return roleAllowed && ["draft", "returned"].includes(stage.status);
  }

  function dependencyStatus(project, stage) {
    return stage.depends_on.map(dependency => {
      const upstream = project.stages[dependency.stage_id];
      return { ...dependency, stage: upstream, valid: !!upstream && upstream.status === "confirmed" && upstream.revision === dependency.revision };
    });
  }

  function dependenciesReady(project, stage) {
    return dependencyStatus(project, stage).every(dependency => dependency.valid);
  }

  function formatTime(timestamp) {
    if (!timestamp) return "刚刚";
    return new Date(timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function safeJson(value) {
    return JSON.stringify(value, null, 2);
  }

  function notice(text, isError) {
    refs.notice.hidden = !text;
    refs.notice.classList.toggle("is-error", !!isError);
    refs.notice.textContent = text || "";
  }

  function makeNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function renderStageNav(project, selectedStageId) {
    refs.stageNav.replaceChildren();
    stageMeta.forEach((meta, index) => {
      const stage = project.stages[meta.id];
      const button = makeNode("button", "stage-nav-button");
      button.type = "button";
      button.dataset.stageId = meta.id;
      button.setAttribute("aria-current", meta.id === selectedStageId ? "step" : "false");
      const step = makeNode("span", "step-index", String(index + 1).padStart(2, "0"));
      const copy = makeNode("span", "step-copy");
      copy.append(makeNode("span", "step-name", meta.title), makeNode("span", "step-sub", statusSubtitles[stage.status] || stage.status));
      const dot = makeNode("span", `step-state status-${stage.status}`);
      button.append(step, copy, dot);
      button.addEventListener("click", () => { window.ECOPWorkspaceUI.navigate(meta.id); controller.selectStage(meta.id); });
      refs.stageNav.append(button);
    });
  }

  function renderDependencies(project, stage) {
    refs.dependencies.replaceChildren();
    const dependencies = dependencyStatus(project, stage);
    if (!dependencies.length) {
      refs.dependencies.append(makeNode("div", "dependency-none", "首个阶段没有上游依赖。"));
      return;
    }
    dependencies.forEach(dependency => {
      const upstream = dependency.stage;
      const item = makeNode("div", "dependency-item");
      const name = makeNode("span", "dependency-name", stageMeta.find(meta => meta.id === dependency.stage_id).title);
      const detail = makeNode("span", "dependency-version", upstream ? `r${upstream.revision} · ${dependency.valid ? "已确认" : "版本不匹配"}` : "缺失");
      item.append(name, detail);
      refs.dependencies.append(item);
    });
  }

  function renderHistory(stage) {
    refs.history.replaceChildren();
    const past = stage.history || [];
    if (!past.length) {
      refs.history.append(makeNode("div", "history-empty", "暂无已归档阶段版本。确认版本被重新编辑或计算失败时，旧快照会保留在这里。"));
      return;
    }
    [...past].reverse().forEach(entry => {
      const row = makeNode("div", "history-item");
      const label = makeNode("div");
      label.append(makeNode("div", "history-title", `阶段 r${entry.revision} · ${statusNames[entry.status] || entry.status}`));
      label.append(makeNode("div", "history-detail", `编制人 ${userNames[entry.last_editor_id] || entry.last_editor_id || "—"}`));
      row.append(label, makeNode("span", "step-state status-confirmed"));
      const body = makeNode("pre", "history-payload", safeJson(entry.payload));
      row.append(body);
      refs.history.append(row);
    });
  }

  function renderComments(stage) {
    const comments = stage.comments || [];
    refs.commentCount.textContent = String(comments.length);
    refs.comments.replaceChildren();
    if (!comments.length) {
      refs.comments.append(makeNode("div", "empty-comment", "还没有评论。评审意见会随项目版本记录。"));
      return;
    }
    [...comments].reverse().forEach(comment => {
      const item = makeNode("div", "comment-item");
      const meta = makeNode("div", "comment-meta");
      meta.append(makeNode("span", "", userNames[comment.actor_id] || comment.actor_id));
      meta.append(makeNode("time", "", formatTime(comment.ts)));
      item.append(meta, makeNode("div", "comment-text", comment.text));
      refs.comments.append(item);
    });
  }

  function renderAudit(project) {
    refs.audit.replaceChildren();
    const events = [...project.audit].reverse().slice(0, 5);
    if (!events.length) {
      refs.audit.append(makeNode("li", "audit-empty", "操作记录将在首个变更后出现。"));
      return;
    }
    events.forEach(event => {
      const item = makeNode("li", "audit-item");
      const stageName = stageMeta.find(meta => meta.id === event.stage_id);
      const actionName = { edit: "保存草稿", submit: "提交审核", confirm: "确认阶段", return: "退回修改", comment: "添加评论", calculation_failure: "合成计算失败", freeze: "冻结导出" }[event.action] || event.action;
      item.append(makeNode("span", "", `${userNames[event.actor_id] || event.actor_id} · ${actionName}${stageName ? ` · ${stageName.title}` : ""}`));
      item.append(makeNode("time", "audit-meta", `项目 v${event.revision || project.revision} · ${formatTime(event.ts)}`));
      refs.audit.append(item);
    });
  }

  function renderPrivatePfd(payload) {
    const svg = refs.casePfdSvg;
    svg.replaceChildren();
    const nodes = Array.isArray(payload && payload.nodes) ? payload.nodes.slice(0, 48) : [];
    const connections = Array.isArray(payload && payload.connections) ? payload.connections.slice(0, 96) : [];
    const columns = window.matchMedia("(max-width: 600px)").matches ? 1 : Math.min(3, Math.max(1, nodes.length));
    const rows = Math.max(1, Math.ceil(nodes.length / columns));
    const cellWidth = 260;
    const cellHeight = 116;
    const width = columns * cellWidth + 40;
    const height = rows * cellHeight + 28;
    const positions = new Map();
    const namespace = "http://www.w3.org/2000/svg";
    const element = (tag, attributes, label) => {
      const item = document.createElementNS(namespace, tag);
      for (const [name, value] of Object.entries(attributes || {})) item.setAttribute(name, String(value));
      if (label !== undefined) item.textContent = String(label);
      return item;
    };
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
    svg.setAttribute("aria-label", `只读 PFD 草稿，${nodes.length} 个节点、${connections.length} 条连接`);
    const defs = element("defs");
    const marker = element("marker", { id: "case-pfd-arrow", viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
    marker.append(element("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#527a68" }));
    defs.append(marker);
    svg.append(defs);
    nodes.forEach((node, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      positions.set(String(node.id), { x: 20 + column * cellWidth, y: 14 + row * cellHeight });
    });
    connections.forEach(connection => {
      const from = positions.get(String(connection.from));
      const to = positions.get(String(connection.to));
      if (!from || !to) return;
      const vertical = to.y >= from.y + cellHeight;
      const startX = vertical ? from.x + 98 : from.x + 196;
      const startY = vertical ? from.y + 78 : from.y + 39;
      const endX = vertical ? to.x + 98 : to.x;
      const endY = vertical ? to.y : to.y + 39;
      const middle = vertical ? (startY + endY) / 2 : (startX + endX) / 2;
      const path = vertical
        ? `M ${startX} ${startY} C ${startX} ${middle}, ${endX} ${middle}, ${endX} ${endY}`
        : `M ${startX} ${startY} C ${middle} ${startY}, ${middle} ${endY}, ${endX} ${endY}`;
      svg.append(element("path", { d: path, fill: "none", stroke: "#789989", "stroke-width": 2, "marker-end": "url(#case-pfd-arrow)" }));
    });
    nodes.forEach((node, index) => {
      const position = positions.get(String(node.id));
      const group = element("g", { transform: `translate(${position.x} ${position.y})` });
      group.append(element("rect", { width: 196, height: 78, rx: 12, fill: "#fffefa", stroke: "#9fb8aa", "stroke-width": 1.5 }));
      group.append(element("text", { x: 14, y: 25, fill: "#718178", "font-size": 11 }, String(node.kind || "PFD 节点").slice(0, 28)));
      group.append(element("text", { x: 14, y: 51, fill: "#253d32", "font-size": 14, "font-weight": 600 }, String(node.label || node.id || `节点 ${index + 1}`).slice(0, 30)));
      svg.append(group);
    });
    refs.casePfdNote.textContent = `${nodes.length} 个节点 · ${connections.length} 条连接 · 来源 PFD 草案；未校核、未计算，图中连线仅按已导入连接字段呈现。`;
  }

  function render(state) {
    if(!state.project)document.getElementById("delivery-review-tools").hidden=true;
    if (!state.project) document.getElementById("taskbook-panel").hidden=true;
    if (!state.project) {
      window.ECOPWorkspaceUI.reset();
      window.ECOPTaskbookUI.reset();
      renderProjectHome();
      return;
    }
    refs.home.hidden = true;
    refs.workspace.hidden = false;
    const project = state.project;
    const customerSource = Boolean(project.data_provenance && project.data_provenance.kind === "customer_source");
    const syntheticProject = Boolean(project.data_provenance && project.data_provenance.kind === "synthetic_demo");
    const businessProject = businessMode && !syntheticProject;
    refreshBusinessMembers(project);
    if (businessMode) refs.accountNote.textContent = workflowConfig.multiUser
      ? "独立登录账号决定项目身份；客户、工程师和审核人必须使用各自账号。"
      : "当前站点只有一个登录账号；多人审核需先配置独立工作流账号，不能靠页面切角色。";
    const privateReadOnly = project.read_only === true;
    const meta = stageMeta.find(item => item.id === state.selectedStageId) || stageMeta[0];
    const stage = project.stages[meta.id];
    const role = getRole(project, state.actorId);
    const editable = !privateReadOnly && isEditable(role, stage) && !project.frozen;
    const submitting = !privateReadOnly && canSubmit(role, stage) && !project.frozen;
    const confirmer = !privateReadOnly && role === "reviewer" && stage.status === "submitted" && stage.last_editor_id !== state.actorId && !project.frozen;
    const returner = !privateReadOnly && ["engineer", "reviewer"].includes(role) && stage.status === "submitted" && !project.frozen;
    const commentAllowed = !privateReadOnly && ["customer", "engineer", "reviewer"].includes(role) && !project.frozen;
    const allConfirmed = stageMeta.every(item => project.stages[item.id].status === "confirmed");
    const selectedIndex = stageMeta.findIndex(item => item.id === meta.id);
    const roleInitial = { customer: "客", engineer: "工", reviewer: "审", lead: "负" }[role] || "?";
    let displayedPayload = stage.payload;
    if (displayedPayload === null || displayedPayload === undefined) {
      displayedPayload = defaultPayloads[meta.id];
      if (meta.id === "calculation") displayedPayload = { ...displayedPayload, input_revision: project.stages.requirements.revision, pfd_revision: project.stages.pfd.revision };
    }
    if ((businessProject || customerSource) && meta.id === "calculation" && stage.payload == null) {
      displayedPayload = { status: "not_run", execution_mode: "not_run", engine: null, result: null };
    }
    if (businessProject && meta.id === "requirements" && stage.payload == null) displayedPayload = {fields:[],taskbook:null};

    refs.title.textContent = meta.title;
    refs.desc.textContent = meta.description;
    refs.audience.textContent = meta.audience;
    refs.number.textContent = `STEP ${String(selectedIndex + 1).padStart(2, "0")}`;
    refs.breadcrumb.textContent = meta.title;
    refs.projectRevision.textContent = `v${project.revision}`;
    refs.projectTitle.textContent = project.title;
    refs.projectHomeButton.hidden = !businessMode;
    refs.projectSelect.hidden = availableProjects.length < 2;
    if (availableProjects.some(item => item.project_id === project.project_id)) refs.projectSelect.value = project.project_id;
    refs.status.textContent = statusNames[stage.status] || stage.status;
    refs.status.className = `status-badge status-${stage.status}`;
    refs.returnReasonDisplay.hidden = !(businessMode && stage.last_return_reason);
    refs.returnReasonDisplay.textContent = stage.last_return_reason ? `最近一次退回理由：${stage.last_return_reason}` : "";
    refs.stageRevision.textContent = `阶段 r${stage.revision}`;
    refs.payload.value = safeJson(displayedPayload);
    const businessRequirementsActive = businessProject && meta.id === "requirements";
    const customerCalculationLocked = businessProject && meta.id === "calculation";
    refs.businessRequirementsForm.hidden = true;
    window.ECOPTaskbookUI.render({active:businessRequirementsActive,project,editable,controller,config:workflowConfig,onChanged:()=>window.ECOPWorkspaceUI.refresh()});
    refs.save.hidden = businessRequirementsActive;
    refs.payload.hidden = businessRequirementsActive;
    // Taskbook preview replaces the independent manual form.
    refs.payload.disabled = !editable || customerCalculationLocked || businessRequirementsActive;
    refs.payloadHelp.textContent = businessRequirementsActive ? "请先在上方上传并确认采用任务书，再提交本需求版本审核。" : "保存将写入项目版本，并保留先前阶段快照。";
    refs.payloadFormat.textContent = businessRequirementsActive ? "结构化字段" : "JSON · UTF-8";
    byId("payload-heading").textContent = businessRequirementsActive ? "需求版本审核" : "阶段资料";
    refs.permission.textContent = editable ? `${roleNames[role]}可编辑` : "只读 / 无权限";
    refs.permission.classList.toggle("is-readonly", !editable);
    refs.save.disabled = !editable || customerCalculationLocked;
    const requirementDraft = businessRequirementsActive && loadUnsavedRequirements(project);
    const requirementPayload = requirementDraft ? requirementDraft.payload : project.stages.requirements.payload;
    const requirementsIncomplete = businessRequirementsActive && ECOPRequirementsSchema.missingForReview(requirementPayload?.fields || []).length > 0;
    refs.submit.disabled = !submitting || customerCalculationLocked || requirementsIncomplete || (businessRequirementsActive && !project.stages.requirements.payload?.taskbook);
    if (businessRequirementsActive) {
      refs.submit.disabled = refs.submit.disabled || ECOPRequirementsSchema.missingForReview(project.stages.requirements.payload?.fields || []).length > 0;
    }
    refs.confirm.disabled = !confirmer || customerCalculationLocked;
    refs.return.disabled = !returner;
    refs.returnReasonWrap.hidden = !businessMode || !returner;
    refs.returnReason.required = businessMode && returner;
    refs.calcTools.hidden = meta.id !== "calculation" || !syntheticProject;
    refs.customerCalculationGuard.hidden = !customerCalculationLocked;
    refs.calcFail.disabled = !editable || role !== "engineer";
    refs.calcFail.hidden = !syntheticProject;
    refs.calcRun.hidden = !syntheticProject;
    refs.calcRun.disabled = !editable || role !== "engineer";
    refs.commentInput.disabled = !commentAllowed;
    refs.commentButton.disabled = !commentAllowed;
    refs.role.value = state.actorId;
    refs.roleSelectContainer.hidden = businessMode;
    refs.role.disabled = adapter.mode === "auth_required" || privateReadOnly || businessMode;
    refs.modePill.textContent = businessMode ? "业务项目" : adapter.mode === "demo_proxy" ? "LOGIN PROTECTED · DEMO ROLE SIMULATION" : adapter.mode === "test_only" ? "TEST ONLY · TEST IDENTITY" : adapter.mode === "auth_required" ? "AUTH REQUIRED" : "LOCAL PREVIEW";
    refs.modePill.classList.toggle("demo-pill-protected", adapter.mode === "demo_proxy");
    refs.modePill.title = adapter.mode === "demo_proxy" ? "站点登录保护；角色切换仅用于合成 DEMO，不是真实多人鉴权。" : "";
    if (adapter.mode === "demo_proxy" && window.matchMedia("(max-width: 760px)").matches) refs.modePill.textContent = "AUTH · DEMO SIM";
    refs.workflowContext.textContent = businessMode ? "真实业务项目 · 服务端版本保存" : adapter.mode === "demo_proxy" ? "隔离的合成测试 · 角色仅作 DEMO 模拟" : adapter.mode === "test_only" ? "本机 TEST ONLY 服务" : "本机合成测试";
    refs.roleModeLabel.textContent = businessMode ? "站点认证账号" : adapter.mode === "demo_proxy" ? "合成测试角色" : "本机测试身份";
    refs.roleModeNote.textContent = businessMode
      ? ECOPBusinessUiCopy.roleModeBoundary(workflowConfig.multiUser === true)
      : adapter.mode === "demo_proxy" ? "此入口只访问隔离的合成项目；角色切换不代表真实用户或客户权限。" : "测试模式仅用于隔离验证；不代表真实业务执行。";
    refs.dataSourcePill.hidden = false;
    refs.executionPill.hidden = false;
    const sourceKind = project.data_provenance && project.data_provenance.kind;
    refs.dataSourcePill.textContent = customerSource ? "DATA SOURCE · CUSTOMER SOURCE + WORKING COPY" : sourceKind === "customer_entered" ? "DATA SOURCE · CUSTOMER INPUT" : sourceKind === "synthetic_demo" ? "DATA SOURCE · ISOLATED SYNTHETIC" : "DATA SOURCE · UNDECLARED";
    const execution = project.execution_context || null;
    refs.executionPill.textContent = businessProject || customerSource ? "执行状态见步骤记录" : execution && execution.status === "not_run" ? "EXECUTION · NOT RUN" : sourceKind === "synthetic_demo" ? "EXECUTION · SYNTHETIC ONLY" : "EXECUTION · UNDECLARED";
    refs.caseProvenance.hidden = !customerSource;
    if (customerSource) {
      refs.caseProvenanceTitle.textContent = "客户来源数据 · 可编辑工作副本";
      refs.caseSource.textContent = businessMode ? "只读源快照 + 独立可编辑副本" : privateReadOnly ? "客户来源输入 · 只读源快照" : "客户来源输入 · 可编辑工作副本";
      refs.caseExecution.textContent = "计算执行与证据在工程计算步骤核对";
      refs.caseAuth.textContent = businessMode ? ECOPBusinessUiCopy.sourceAccessBoundary(workflowConfig.multiUser === true) : privateReadOnly ? "受保护只读源快照" : "本机服务端项目权限";
      const requirementsPayload = project.stages.requirements.payload || {};
      const fieldSummary = requirementsPayload.source_field_status_summary || requirementsPayload.field_status_summary || {};
      const missingFields = project.stages.requirements.payload && Array.isArray(project.stages.requirements.payload.missing_fields)
        ? project.stages.requirements.payload.missing_fields : [];
      refs.caseSourceSummary.textContent = `来源报告 ${Number(fieldSummary.source_reported) || 0} 项 · 解释/假设 ${Number(fieldSummary.assumed) || 0} 项 · 原始缺项 ${Number(fieldSummary.missing) || 0} 项。需求表单按字段保留来源原值与当前修改值。`;
      refs.caseSourceLimit.textContent = `源快照 SHA256 ${project.data_provenance.source_snapshot_sha256 || project.data_provenance.source_document_sha256 || "—"}；源文件未被编辑，副本单独版本化。`;
      refs.caseMissingSummary.textContent = missingFields.length ? `来源标记缺项 ${missingFields.length} 项；可在结构化表单补录，但需填写单位/基准并人工核实。` : "来源未标记缺项；仍需工程师核验原始来源与单位。";
      refs.caseMissingFields.replaceChildren();
      missingFields.forEach(field => {
        const item = document.createElement("li");
        item.textContent = typeof field === "string" ? field : String(field.target_field || "未命名字段");
        refs.caseMissingFields.append(item);
      });
      refs.footerContext.textContent = businessMode ? "客户源快照保持只读 · 当前为可编辑工作副本 · 执行未运行" : privateReadOnly ? "客户源快照只读 · 执行未运行" : "客户来源工作副本 · 执行未运行";
    } else {
      refs.caseMissingFields.replaceChildren();
      refs.footerContext.textContent = businessProject ? "真实业务草稿 · 已版本化保存 · 尚无计算结果" : "隔离合成测试 · 不写入客户项目";
    }
    refs.casePfdPreview.hidden = !(privateReadOnly || businessProject) || meta.id !== "pfd" || !project.stages.pfd.payload;
    if (!refs.casePfdPreview.hidden) renderPrivatePfd(project.stages.pfd.payload);
    refs.roleInitial.textContent = roleInitial;
    refs.roleInitial.className = `avatar avatar-${role || "customer"}`;
    refs.exportButton.disabled = role !== "lead" || !allConfirmed || project.frozen || businessProject;
    refs.exportButton.hidden = project.frozen || businessProject;
    const exportVersion = state.exportVersion || null;
    refs.downloadExport.hidden = !exportVersion || businessProject;
    refs.exportMeta.hidden = !exportVersion || businessProject;
    refs.reportDownloads.hidden = businessProject || !["test_only", "demo_proxy"].includes(adapter.mode) || !exportVersion;
    const deliveryAvailable=Boolean(project.delivery_review_available && adapter.getDeliveryReview);
    document.getElementById("delivery-review-tools").hidden=true;
    refs.exportCopy.textContent = businessProject
      ? "业务文件必须绑定已审核的真实计算结果；当前先完成输入保存，计算和客户报告尚未接入。"
      : exportVersion
      ? "六步资料已锁定在同一项目版本；后续变更需要新的受控工作流版本。"
      : allConfirmed ? "所有阶段均已确认。负责人可以冻结此版本并导出完整快照。" : "六个阶段全部确认后，负责人可冻结同一项目版本快照。";
    if (exportVersion) refs.exportMeta.textContent = `项目 ${exportVersion.project_id} · 版本 v${exportVersion.project_revision} · 六步快照`;
    if(deliveryAvailable)refs.exportCopy.textContent="已关联真实计算评审草稿，设备待核项保留。每次下载会重新检查项目版本与来源，未作工程签发。";
    if(deliveryAvailable)refs.footerContext.textContent="已关联实际计算证据 · 本次未重新运行引擎 · 设备适配待核";

    const failure = meta.id === "calculation" && stage.payload && stage.payload.status === "failed";
    notice(state.notice && state.notice.message, state.notice && ["FORBIDDEN", "REVISION_CONFLICT", "INVALID_INPUT", "DEPENDENCY_NOT_CONFIRMED", "CALCULATION_FAILED"].includes(state.notice.code));
    if (failure && !state.notice) notice(stage.payload.message || "合成计算失败；当前版本没有有效结果。", true);
    renderStageNav(project, meta.id);
    renderDependencies(project, stage);
    renderHistory(stage);
    renderComments(stage);
    renderAudit(project);
    document.body.classList.toggle('business-workspace',businessProject);
    refs.footerContext.textContent=businessProject?'每一步保留输入、决定和计算依据；工程签发另行审核。':refs.footerContext.textContent;
    window.ECOPWorkspaceUI.render({project,controller,config:workflowConfig,adapter,business:businessProject,role,
      onStage(id){window.ECOPWorkspaceUI.navigate(id);controller.selectStage(id);}});
  }

  function readPayload() {
    try { return { ok: true, payload: JSON.parse(refs.payload.value) }; }
    catch (error) { return { ok: false, error: error.message }; }
  }

  function showActionResult(result) {
    const show = outcome => {
      if (!outcome || outcome.ok) return;
      notice(outcome.error && outcome.error.message || "操作未完成。", true);
    };
    if (result && typeof result.then === "function") result.then(show).catch(error => notice(error.message || "请求失败。", true));
    else show(result);
  }

  refs.save.addEventListener("click", () => {
    if (businessMode && controller.state.project && controller.state.selectedStageId === "requirements") {
      const project = controller.state.project;
      const payload = collectRequirementsForm(project);
      const previousDraft = loadUnsavedRequirements(project);
      const baseRevision = previousDraft ? previousDraft.base_revision : project.revision;
      if (baseRevision !== project.revision) {
        refs.requirementsSaveState.textContent = `版本冲突；输入基于 v${baseRevision}，服务器现为 v${project.revision}。先放弃本页修改或复制到最新版本后再保存。`;
        refs.requirementsSaveState.classList.add("is-unsaved", "is-conflict");
        return;
      }
      storeUnsavedRequirements(project, payload, baseRevision);
      refs.requirementsSaveState.textContent = "正在保存…";
      refs.requirementsSaveState.classList.add("is-unsaved");
      const result = controller.saveStage("requirements", payload);
      Promise.resolve(result).then(async outcome => {
        if (outcome && outcome.ok) {
          clearUnsavedRequirements(project.project_id);
          refs.requirementsSaveState.textContent = "已保存到服务端；版本正在刷新…";
          await controller.reload();
          refs.requirementsSaveState.textContent = `已保存服务端版本 v${controller.state.project.revision}`;
          return;
        }
        refs.requirementsSaveState.textContent = outcome && outcome.error && outcome.error.code === "REVISION_CONFLICT"
          ? `版本冲突；输入已保留。服务器 v${controller.state.project.revision}`
          : "保存失败；输入已保留，可检查后重试。";
      }).catch(error => {
        refs.requirementsSaveState.textContent = "网络或服务错误；输入已保留，可重试。";
        notice(error.message || "保存失败。", true);
      });
      return;
    }
    const parsed = readPayload();
    if (!parsed.ok) return notice(`JSON 格式有误：${parsed.error}`, true);
    showActionResult(controller.saveStage(controller.state.selectedStageId, parsed.payload));
  });
  refs.submit.addEventListener("click", () => showActionResult(controller.submit(controller.state.selectedStageId)));
  refs.confirm.addEventListener("click", () => showActionResult(controller.confirm(controller.state.selectedStageId)));
  refs.return.addEventListener("click", () => {
    const reason = businessMode ? refs.returnReason.value.trim() : "";
    if (businessMode && reason.length < 3) {
      refs.returnReason.focus();
      return notice("请填写具体退回理由（至少 3 个字符）。", true);
    }
    showActionResult(controller.returnStage(controller.state.selectedStageId, reason));
    refs.returnReason.value = "";
  });
  refs.role.addEventListener("change", event => controller.setActor(event.target.value));
  refs.projectSelect.addEventListener("change", event => showActionResult(controller.selectProject(event.target.value)));
  refs.projectHomeButton.addEventListener("click", async () => {
    controller.returnToHome();
    if (businessMode) {
      try {
        const result = await adapter.listProjects();
        availableProjects = result.projects || [];
        sourceTemplates = result.source_templates || [];
        renderProjectHome();
        setHomeNotice("项目已返回列表。", false);
      } catch (error) {
        renderProjectHome();
        setHomeNotice(error.message || "项目列表刷新失败。", true);
      }
    }
  });
  const createBusinessProject = async sourceTemplateId => {
    const title = refs.newProjectName.value.trim();
    if (!title) {
      setHomeNotice("请先填写项目名称。", true);
      refs.newProjectName.focus();
      return;
    }
    refs.createEmptyProject.disabled = true;
    refs.createSourceProject.disabled = true;
    setHomeNotice("正在通过服务端创建项目…", false);
    try {
      const result = await controller.createProject(title, sourceTemplateId);
      if (!result.ok) {
        setHomeNotice(result.error && result.error.message || "项目创建失败。", true);
        return;
      }
      availableProjects.unshift({
        project_id: result.project.project_id,
        title: result.project.title,
        revision: result.project.revision,
        updated_at: new Date().toISOString(),
        data_source_kind: result.project.data_provenance && result.project.data_provenance.kind,
      });
      refs.newProjectName.value = "";
    } catch (error) {
      setHomeNotice(error.message || "项目创建失败。", true);
    } finally {
      refs.createEmptyProject.disabled = false;
      refs.createSourceProject.disabled = false;
    }
  };
  refs.createEmptyProject.addEventListener("click", () => createBusinessProject(null));
  refs.createSourceProject.addEventListener("click", () => {
    const template = sourceTemplates[0];
    if (!template) return setHomeNotice("当前账号没有可用的只读源快照。", true);
    createBusinessProject(template.source_template_id);
  });
  refs.businessMemberAdd.addEventListener("click", async () => {
    const project = controller.state.project;
    const userId = refs.businessMemberUser.value;
    if (!project || !userId) return;
    refs.businessMemberAdd.disabled = true;
    refs.businessMemberNote.textContent = "正在验证账号并写入成员权限…";
    try {
      const result = await controller.addMember(userId, refs.businessMemberRole.value);
      if (!result.ok) {
        refs.businessMemberNote.textContent = result.error && result.error.message || "添加成员失败。";
        return;
      }
      businessTeam = null;
      refs.businessMemberNote.textContent = "成员权限已保存；该成员需使用自己的独立账号登录。";
    } catch (error) {
      refs.businessMemberNote.textContent = error.message || "添加成员失败。";
    } finally {
      refs.businessMemberAdd.disabled = false;
    }
  });
  const updateUnsavedRequirements = () => {
    const project = controller.state.project;
    if (!businessMode || !project || controller.state.selectedStageId !== "requirements") return;
    const payload = collectRequirementsForm(project);
    const previousDraft = loadUnsavedRequirements(project);
    const saved = storeUnsavedRequirements(project, payload, previousDraft ? previousDraft.base_revision : project.revision);
    refs.requirementsSaveState.textContent = saved ? "未保存修改 · 当前页面刷新可恢复" : "未保存修改 · 浏览器无法保存会话草稿";
    refs.requirementsSaveState.classList.add("is-unsaved");
    refs.submit.disabled = project.frozen || ECOPRequirementsSchema.missingForReview(payload.fields || []).length > 0;
  };
  refs.businessRequirementsForm.addEventListener("input", updateUnsavedRequirements);
  refs.businessRequirementsForm.addEventListener("change", updateUnsavedRequirements);
  refs.discardRequirementsDraft.addEventListener("click", () => {
    const project = controller.state.project;
    if (!project) return;
    clearUnsavedRequirements(project.project_id);
    render(controller.state);
    notice("已放弃本页未保存输入，显示服务器当前版本。", false);
  });
  if (!businessMode) {
    refs.syntheticDemoLink.href = "/workflow/";
    refs.syntheticDemoLink.textContent = "返回当前隔离的合成测试入口";
  }
  refs.commentForm.addEventListener("submit", event => {
    event.preventDefault();
    const text = refs.commentInput.value.trim();
    if (!text) return notice("评论内容不能为空。", true);
    const result = controller.comment(controller.state.selectedStageId, text);
    if (result && typeof result.then === "function") result.then(outcome => { if (outcome.ok) refs.commentInput.value = ""; else showActionResult(outcome); }).catch(error => notice(error.message || "请求失败。", true));
    else if (result.ok) refs.commentInput.value = "";
    else showActionResult(result);
  });
  refs.calcFail.addEventListener("click", () => showActionResult(controller.recordCalculationFailure()));
  refs.calcRun.addEventListener("click", () => showActionResult(controller.runMockCalculation()));
  refs.exportButton.addEventListener("click", () => showActionResult(controller.freezeAndExport()));
  refs.downloadExport.addEventListener("click", () => {
    const version = controller.state.exportVersion;
    if (!version) return notice("冻结快照尚未加载。", true);
    const blob = new Blob([JSON.stringify(version, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${version.project_id}-v${version.project_revision}-workflow-snapshot.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  refs.reportButtons.forEach(button => button.addEventListener("click", async () => {
    try {
      const project = controller.state.project;
      if (!project || !project.frozen || !["test_only", "demo_proxy"].includes(adapter.mode)) return notice("合成演示报告仅能从已冻结合成快照下载。", true);
      const bundle = await adapter.getReportBundle(project.project_id);
      if (!bundle.ok) return notice(bundle.error && bundle.error.message || "报告生成失败。", true);
      const reportId = button.dataset.reportId;
      const selected = reportId === "manifest" ? null : bundle.documents.find(document => document.id === reportId);
      const content = selected ? selected.content : JSON.stringify(bundle.manifest, null, 2);
      const filename = selected ? selected.file_name : "report-manifest.json";
      const blob = new Blob([content], { type: selected ? selected.content_type : "application/json; charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notice(`已生成 ${filename} · DEMO ONLY · MOCK`, false);
    } catch (error) {
      notice(error.message || "报告下载失败。", true);
    }
  }));

  document.querySelectorAll("[data-delivery-id]").forEach(button=>button.addEventListener("click",async()=>{
    const id=controller.state.project?.project_id,revision=controller.state.project?.revision;
    if(!id||!adapter.getDeliveryReview)return;
    button.disabled=true;
    try{
      const bundle=await adapter.getDeliveryReview(id);
      if(controller.state.project?.project_id!==id||controller.state.project?.revision!==revision)return;
      if(!bundle.ok)return notice(bundle.error?.message||"评审草稿读取失败。",true);
      if(bundle.review.status!=="local_review_snapshot")return notice("项目来源或计算证据已变化，旧草稿停止下载；请先复核更新。",true);
      if(bundle.review.project_revision!==revision)return notice("项目版本已更新，请刷新后重新下载。",true);
      const doc=bundle.documents.find(d=>d.id===button.dataset.deliveryId);
      if(!doc)throw Error("评审文件尚未齐备。");
      const url=URL.createObjectURL(new Blob([doc.content],{type:doc.content_type}));
      const a=document.createElement("a");a.href=url;a.download=doc.file_name;a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);notice("已下载评审草稿；设备待核项仍保留。",false);
    }catch(e){notice(e.message||"评审文件下载失败。",true);}finally{button.disabled=false;}
  }));

  function initializeWorkflow() {
    if (typeof adapter.listProjects !== "function") return controller.load();
    adapter.listProjects().then(result => {
      if (!result.ok || !Array.isArray(result.projects)) {
        if (businessMode) setHomeNotice(result.error && result.error.message || "当前账号的项目读取失败。", true);
        else notice(result.error && result.error.message || "当前登录没有可访问的工作流项目。", true);
        return;
      }
      availableProjects = result.projects;
      sourceTemplates = Array.isArray(result.source_templates) ? result.source_templates : [];
      if (businessMode) {
        refs.createSourceProject.hidden = sourceTemplates.length === 0;
        refs.sourceTemplateNote.hidden = sourceTemplates.length === 0;
        refs.syntheticDemoLink.href = "/workflow/synthetic/";
        renderProjectHome();
        setHomeNotice("可新建业务项目，或继续保存中的项目。", false);
        return;
      }
      if (availableProjects.length === 0) {
        notice("当前测试入口没有可访问的合成项目。", true);
        return;
      }
      refs.projectSelect.replaceChildren();
      for (const project of availableProjects) {
        const option = document.createElement("option");
        option.value = project.project_id;
        const sourceLabel = project.data_source_kind === "customer_source" ? "客户来源草稿" : project.data_source_kind === "synthetic_demo" ? "合成演示" : "来源待确认";
        option.textContent = `${project.title} · ${sourceLabel}`;
        refs.projectSelect.append(option);
      }
      refs.projectSelect.hidden = availableProjects.length < 2;
      const selected = availableProjects.find(project => project.project_id === controller.state.projectId) || availableProjects[0];
      if (selected.project_id !== controller.state.projectId) controller.selectProject(selected.project_id);
      else controller.load();
    }).catch(error => notice(error.message || "项目列表读取失败。", true));
  }

  initializeWorkflow();
})();
