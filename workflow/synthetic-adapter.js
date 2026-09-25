(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./workflow-engine.js"));
  else root.ECOPWorkflowSyntheticAdapter = factory(root.ECOPWorkflowEngine);
})(globalThis, function (engine) {
  "use strict";

  if (!engine) throw new Error("Load workflow-engine.js before synthetic-adapter.js");

  const DEMO_MEMBERS = Object.freeze([
    Object.freeze({ user_id: "demo-customer", role: "customer" }),
    Object.freeze({ user_id: "demo-engineer", role: "engineer" }),
    Object.freeze({ user_id: "demo-reviewer", role: "reviewer" }),
    Object.freeze({ user_id: "demo-lead", role: "lead" }),
  ]);

  function createSyntheticAdapter(options) {
    const config = options || {};
    const project = config.project || engine.createProject(
      config.projectId || "workflow-synthetic-001",
      config.title || "六步工程协作演示",
      DEMO_MEMBERS,
    );
    const adapter = engine.createAdapter(project);
    return Object.freeze({
      mode: "synthetic_local",
      load: projectId => adapter.load(projectId),
      action: action => adapter.action(action),
      recordCalculationFailure: action => adapter.recordCalculationFailure(action),
      freeze: (actorId, expectedRevision) => adapter.freeze(actorId, expectedRevision),
      getExportVersion: () => adapter.getExportVersion(),
      members: () => DEMO_MEMBERS.map(member => ({ ...member })),
    });
  }

  return Object.freeze({ createSyntheticAdapter, DEMO_MEMBERS });
});
