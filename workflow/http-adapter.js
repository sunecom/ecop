(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ECOPWorkflowHttpAdapter = factory();
})(globalThis, function () {
  "use strict";

  function createHttpAdapter(options) {
    const config = options || {};
    const baseUrl = config.baseUrl || config.origin || "";
    const basePath = String(config.basePath || "").replace(/\/+$/, "");
    const mode = config.mode || "auth_required";
    let actorId = config.actorId || "demo-customer";

    async function request(path, method = "GET", body) {
      const headers = { Accept: "application/json" };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        const requestOrigin = config.origin || (typeof location === "undefined" ? undefined : location.origin);
        if (requestOrigin) headers.Origin = requestOrigin;
        if (config.csrfToken) headers["X-Demo-Token"] = config.csrfToken;
      }
      if (mode === "test_only" || mode === "demo_proxy") headers["X-Workflow-Test-Actor"] = actorId;
      let response;
      try { response = await fetch(`${baseUrl}${basePath}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }); } catch { return {ok:false,error:{code:'NETWORK_ERROR',message:'网络请求未完成。请刷新核对服务端状态后再操作。'}}; }
      let value;try { value = await response.json(); } catch { return {ok:false,error:{code:'INVALID_RESPONSE',message:'服务响应格式不正确，请重试。'}}; }
      if(response.status===401||response.status===403)return {ok:false,error:{code:'FORBIDDEN',message:response.status===401?'登录已失效，请重新登录。':'当前账号没有权限。'}};
      if(!value || typeof value.ok!=='boolean' || (value.ok===false&&!value.error?.message))return {ok:false,error:{code:'INVALID_RESPONSE',message:'服务响应不完整，请重试。'}};
      if (!response.ok && value.ok !== false) return {ok:false,error:{code:'HTTP_ERROR',message:`请求失败（${response.status}）。`}};
      return value;
    }

    return Object.freeze({
      mode,
      setActor(nextActorId) { actorId = nextActorId; return { ok: true, actor_id: actorId }; },
      listProjects() { return request("/api/workflow/projects"); },
      listMembers(projectId) { return request(`/api/workflow/projects/${encodeURIComponent(projectId)}/members`); },
      addMember(projectId, member) {
        return request(`/api/workflow/projects/${encodeURIComponent(projectId)}/members`, "POST", member);
      },
      createProject(projectName, sourceTemplateId = null) {
        return request("/api/workflow/projects", "POST", {
          project_name: projectName,
          ...(sourceTemplateId ? { source_template_id: sourceTemplateId } : {}),
        });
      },
      load(projectId) { return request(`/api/workflow/projects/${encodeURIComponent(projectId)}`); },
      action(action) {
        const { actor_id, ...serverAction } = action;
        return request(`/api/workflow/projects/${encodeURIComponent(action.project_id)}/actions`, "POST", serverAction);
      },
      recordCalculationFailure(action) {
        const { actor_id, ...serverAction } = action;
        return request(`/api/workflow/projects/${encodeURIComponent(action.project_id)}/calculation-failure`, "POST", serverAction);
      },
      async runMockCalculation(projectId, expectedRevision) {
        const started = await request(`/api/workflow/projects/${encodeURIComponent(projectId)}/calculations`, "POST", { expected_revision: expectedRevision });
        if (!started.ok) return started;
        return request(`/api/workflow/projects/${encodeURIComponent(projectId)}/calculations/${encodeURIComponent(started.job.id)}/complete`, "POST", {});
      },
      freeze(actor, expectedRevision, projectId) {
        return request(`/api/workflow/projects/${encodeURIComponent(projectId)}/freeze`, "POST", { expected_revision: expectedRevision });
      },
      getExportVersion(projectId) { return request(`/api/workflow/projects/${encodeURIComponent(projectId)}/export`); },
      getReportBundle(projectId) { return request(`/api/workflow/projects/${encodeURIComponent(projectId)}/reports`); },
      getDeliveryReview(projectId) { return request(`/api/workflow/projects/${encodeURIComponent(projectId)}/delivery-review`); },
    });
  }

  return Object.freeze({ createHttpAdapter });
});
