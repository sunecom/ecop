(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ECOPWorkflowController = factory();
})(globalThis, function () {
  "use strict";

  const STAGE_IDS = ["requirements", "selection", "pfd", "calculation", "equipment", "documents"];
  let controllerSequence = 0;

  function createController(options) {
    const config = options || {};
    if (!config.adapter || typeof config.adapter.load !== "function" || typeof config.adapter.action !== "function") {
      throw new TypeError("A workflow adapter with load() and action() is required");
    }
    let sequence = 0, generation = 0, pendingAction = null;
    const randomInstanceId = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const instanceId = config.instanceId || `ui-${++controllerSequence}-${randomInstanceId}`;
    const state = {
      projectId: config.projectId ?? (config.adapter.mode === "business_proxy" ? null : "workflow-synthetic-001"),
      project: null,
      actorId: config.actorId || "demo-customer",
      selectedStageId: "requirements",
      notice: null,
      exportVersion: null,
    };
    const render = typeof config.render === "function" ? config.render : () => {};

    function settle(value, onValue) {
      const own = generation;
      const apply = result => own === generation ? onValue(result) : {ok:false,error:{code:'SUPERSEDED',message:'已切换项目或更新版本，旧响应已忽略。'}};
      return value && typeof value.then === "function" ? value.then(apply) : apply(value);
    }

    function refreshExportVersion() {
      if (!state.project || !state.project.frozen || typeof config.adapter.getExportVersion !== "function") {
        state.exportVersion = null;
        return null;
      }
      return settle(config.adapter.getExportVersion(state.projectId), result => {
        state.exportVersion = result && result.exportVersion ? result.exportVersion : result;
        return state.exportVersion;
      });
    }

    function publish() {
      render(state);
      return state;
    }

    function reload(message) {
      generation++;
      pendingAction = null;
      const loaded = config.adapter.load(state.projectId);
      return settle(loaded, result => {
        if (!result.ok) {
          state.project = null;
          state.exportVersion = null;
          state.notice = result.error;
          return result;
        }
        state.project = result.project;
        const exportResult = refreshExportVersion();
        const complete = () => {
          if (message) state.notice = message;
          return { ok: true, project: state.project };
        };
        return exportResult && typeof exportResult.then === "function" ? exportResult.then(complete) : complete();
      });
    }

    function load() {
      const message = config.adapter.mode === "test_only"
        ? "项目状态已从本机 SQLite 服务读取；身份仅为测试用途。"
        : config.adapter.mode === "demo_proxy"
          ? "项目状态已通过站点登录从私有演示服务读取；角色仅作 DEMO 模拟。"
        : config.adapter.mode === "auth_required"
          ? "本机服务已启动；API 需要配置认证后才能读取项目。"
          : config.adapter.mode === "business_proxy" ? "项目状态已从业务服务读取。" : "演示数据已从本地合成 adapter 读取。";
      const result = reload(message);
      return settle(result, outcome => { publish(); return outcome; });
    }

    function selectProject(projectId) {
      if (typeof projectId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(projectId)) {
        return { ok: false, error: { code: "INVALID_INPUT", message: "项目标识格式无效。" } };
      }
      if (projectId === state.projectId && state.project) return { ok: true, project: state.project };
      state.projectId = projectId;
      state.selectedStageId = "requirements";
      state.project = null;
      state.exportVersion = null;
      state.notice = null;
      publish();
      const result = reload();
      return settle(result, outcome => {
        if (!outcome.ok) state.notice = outcome.error;
        publish();
        return outcome;
      });
    }

    function createProject(projectName, sourceTemplateId = null) {
      if (typeof config.adapter.createProject !== "function") {
        return { ok: false, error: { code: "NOT_SUPPORTED", message: "当前连接不支持创建业务项目。" } };
      }
      const result = config.adapter.createProject(projectName, sourceTemplateId);
      return settle(result, outcome => {
        if (!outcome.ok) {
          state.notice = outcome.error;
          publish();
          return outcome;
        }
        generation++;
        pendingAction = null;
        state.projectId = outcome.project.project_id;
        state.project = outcome.project;
        state.selectedStageId = "requirements";
        state.exportVersion = null;
        state.notice = { code: "PROJECT_CREATED", message: "业务项目已创建并保存到服务端。" };
        publish();
        return outcome;
      });
    }

    function addMember(userId, role) {
      if (!state.project || typeof config.adapter.addMember !== "function") {
        return { ok: false, error: { code: "NOT_SUPPORTED", message: "当前连接不支持管理项目成员。" } };
      }
      const result = config.adapter.addMember(state.projectId, {
        user_id: userId,
        role,
        expected_revision: state.project.revision,
      });
      return settle(result, outcome => {
        if (!outcome.ok) {
          state.notice = outcome.error;
          if (outcome.error.code === "REVISION_CONFLICT") return settle(reload(), () => { publish(); return outcome; });
        } else {
          state.project = outcome.project;
          state.notice = { code: "MEMBER_ADDED", message: "成员已加入项目，权限由其独立登录身份校验。" };
        }
        publish();
        return outcome;
      });
    }

    function returnToHome() {
      generation++;
      pendingAction = null;
      state.projectId = null;
      state.project = null;
      state.exportVersion = null;
      state.selectedStageId = "requirements";
      state.notice = null;
      publish();
      return { ok: true };
    }

    function perform(type, stageId, payload) {
      if(pendingAction) return {ok:false,error:{code:'REQUEST_PENDING',message:'上一项操作正在保存，请勿重复提交。'}};
      const token={};pendingAction=token;
      const done=()=>{if(pendingAction===token)pendingAction=null;};
      try { const result=performCore(type,stageId,payload);if(result&&typeof result.then==='function')return result.finally(done);done();return result; }
      catch(e){done();throw e;}
    }

    function performCore(type, stageId, payload) {
      if (!state.project) return { ok: false, error: { code: "NOT_FOUND", message: "请先打开项目。" } };
      const result = config.adapter.action({
        action_id: `wf-${instanceId}-${++sequence}`,
        actor_id: state.actorId,
        project_id: state.projectId,
        expected_revision: state.project.revision,
        stage_id: stageId,
        type,
        payload,
      });
      return settle(result, outcome => {
        if (!outcome.ok) {
          state.notice = outcome.error;
          if (outcome.error.code === "REVISION_CONFLICT") {
            return settle(reload(), () => {
              state.notice = { ...outcome.error, message: `${outcome.error.message} 已刷新到最新项目版本。` };
              publish();
              return outcome;
            });
          }
          publish();
          return outcome;
        }
        state.project = outcome.project;
        state.notice = { code: "SAVED", message: `已保存；项目版本 v${state.project.revision}。` };
        state.exportVersion = null;
        publish();
        return outcome;
      });
    }

    function selectStage(stageId) {
      if (!STAGE_IDS.includes(stageId)) return { ok: false, error: { code: "INVALID_INPUT", message: "未知流程步骤。" } };
      state.selectedStageId = stageId;
      state.notice = null;
      publish();
      return { ok: true, stage_id: stageId };
    }

    function setActor(actorId) {
      const exists = state.project && state.project.members.some(member => member.user_id === actorId);
      if (!exists) return { ok: false, error: { code: "FORBIDDEN", message: "该演示角色不在项目成员中。" } };
      const changed = typeof config.adapter.setActor === "function" ? config.adapter.setActor(actorId) : { ok: true };
      return settle(changed, result => {
        if (!result.ok) return result;
        state.actorId = actorId;
        state.notice = {
          code: config.adapter.mode === "test_only" ? "TEST_ONLY_IDENTITY" : "SIMULATED_IDENTITY",
          message: config.adapter.mode === "test_only" ? "测试专用身份仅由本机测试鉴权适配器识别。" : config.adapter.mode === "demo_proxy" ? "站点已完成登录保护；当前角色仅用于合成 DEMO，不代表真实多人鉴权。" : "身份仅在本机演示中模拟，不代表服务端鉴权。",
        };
        publish();
        return { ok: true, actor_id: actorId };
      });
    }

    function saveStage(stageId, payload) { return perform("edit", stageId, payload); }
    function submit(stageId) { return perform("submit", stageId, {}); }
    function returnStage(stageId, reason = "") { return perform("return", stageId, { reason }); }
    function confirm(stageId) { return perform("confirm", stageId, {}); }
    function comment(stageId, text) { return perform("comment", stageId, { text }); }

    function recordCalculationFailure(message) {
      if (!state.project || typeof config.adapter.recordCalculationFailure !== "function") {
        return { ok: false, error: { code: "INVALID_INPUT", message: "当前 adapter 不支持合成计算失败路径。" } };
      }
      const result = config.adapter.recordCalculationFailure({
        action_id: `wf-${instanceId}-${++sequence}`,
        actor_id: state.actorId,
        project_id: state.projectId,
        expected_revision: state.project.revision,
        failure_code: "SYNTHETIC_TEST_FAILURE",
        message: message || "合成计算失败；旧成功结果已移入版本历史。",
      });
      return settle(result, outcome => {
        if (!outcome.ok) state.notice = outcome.error;
        else {
          state.project = outcome.project;
          state.notice = { code: "CALCULATION_FAILED", message: "合成计算失败；当前成功结果已清除，历史版本保留。" };
          state.exportVersion = null;
        }
        publish();
        return outcome;
      });
    }

    function runMockCalculation() {
      if (!state.project || typeof config.adapter.runMockCalculation !== "function") {
        return { ok: false, error: { code: "INVALID_INPUT", message: "当前 adapter 不支持显式模拟计算。" } };
      }
      return settle(config.adapter.runMockCalculation(state.projectId, state.project.revision), outcome => {
        if (!outcome.ok) state.notice = outcome.error;
        else {
          state.project = outcome.project;
          state.notice = { code: "MOCK_CALCULATION", message: "模拟计算已完成；这是合成输出，不是工程引擎结果。" };
          state.exportVersion = null;
        }
        publish();
        return outcome;
      });
    }

    function freezeAndExport() {
      if (!state.project || !config.adapter.getExportVersion || !config.adapter.freeze) {
        return { ok: false, error: { code: "INVALID_INPUT", message: "当前 adapter 不支持冻结导出。" } };
      }
      const result = config.adapter.freeze(state.actorId, state.project.revision, state.projectId);
      return settle(result, outcome => {
        if (!outcome.ok) {
          state.notice = outcome.error;
          if (outcome.error.code === "REVISION_CONFLICT") {
            return settle(reload(), () => {
              state.notice = { ...outcome.error, message: `${outcome.error.message} 已刷新项目，请重新确认版本。` };
              publish();
              return outcome;
            });
          }
          publish();
          return outcome;
        }
        state.project = outcome.project;
        const exportResult = outcome.exportVersion || config.adapter.getExportVersion(state.projectId);
        return settle(exportResult, exported => {
          state.exportVersion = exported && exported.exportVersion ? exported.exportVersion : exported;
          state.notice = { code: "EXPORT_FROZEN", message: `已冻结统一导出版本 v${state.exportVersion.project_revision}。` };
          publish();
          return { ok: true, project: state.project, exportVersion: state.exportVersion };
        });
      });
    }

    return Object.freeze({
      state,
      load,
      selectProject,
      createProject,
      addMember,
      returnToHome,
      reload: () => settle(reload(), result=>{publish();return result;}),
      selectStage,
      setActor,
      saveStage,
      submit,
      returnStage,
      confirm,
      comment,
      recordCalculationFailure,
      runMockCalculation,
      freezeAndExport,
      stageIds: STAGE_IDS,
    });
  }

  return Object.freeze({ createController, STAGE_IDS });
});
