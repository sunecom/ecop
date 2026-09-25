"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { WorkflowStore, createHttpServer, createTestAuthProvider, createTrustedProxyAuthProvider, createDenyAllAuthProvider } = require("./workflow-service.cjs");

function argumentValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function startLocalWorkflowServer(args = process.argv.slice(2)) {
  const databasePath = argumentValue(args, "--db", null);
  if (!databasePath) throw new Error("Pass a dedicated local SQLite file with --db <path>.");
  const port = Number(argumentValue(args, "--port", "18922"));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be 0..65535.");
  const testOnly = args.includes("--test-only-auth");
  const trustedProxyMode = args.includes("--trusted-proxy-auth");
  if (testOnly && trustedProxyMode) throw new Error("Choose either local test auth or trusted-proxy DEMO auth, never both.");
  const projectId = argumentValue(args, "--project-id", null);
  if (projectId && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(projectId)) throw new Error("--project-id must be a safe identifier.");
  const host = argumentValue(args, "--host", "127.0.0.1");
  if (!trustedProxyMode && host !== "127.0.0.1" && host !== "::1") throw new Error("Non-loopback binding requires trusted-proxy auth.");
  let proxyToken = null;
  let trustedProxy = null;
  if (trustedProxyMode) {
    const tokenFile = argumentValue(args, "--proxy-token-file", null);
    if (!tokenFile || !path.isAbsolute(tokenFile) || !fs.existsSync(tokenFile)) throw new Error("Trusted-proxy mode requires an explicit absolute proxy-token file.");
    const tokenStat = fs.lstatSync(tokenFile);
    if (!tokenStat.isFile() || tokenStat.isSymbolicLink()) throw new Error("The trusted-proxy token must be a regular file.");
    proxyToken = fs.readFileSync(tokenFile, "utf8").trim();
    if (Buffer.byteLength(proxyToken) < 32) throw new Error("The trusted-proxy token file must contain at least 32 bytes.");
    const hostAuthority = argumentValue(args, "--proxy-authority", "workflow:18922");
    const origin = argumentValue(args, "--proxy-origin", `http://${hostAuthority}`);
    trustedProxy = { token: proxyToken, hostAuthority, origin };
  }
  const privateCaseDatabasePath = argumentValue(args, "--private-case-db", process.env.ECOP_PRIVATE_CASE_DB_PATH || null);
  const store = new WorkflowStore(databasePath, { privateCaseDatabasePath });
  if ((testOnly && !projectId) || (trustedProxyMode && projectId === "workflow-synthetic-001")) store.ensureDemoProject();
  const authProvider = trustedProxyMode ? createTrustedProxyAuthProvider({ token: proxyToken }) : testOnly ? createTestAuthProvider() : createDenyAllAuthProvider();
  const reviewRegistry = argumentValue(args,"--review-registry",null);
  let deliveryReviews;
  if(reviewRegistry){
    if(!path.isAbsolute(reviewRegistry))throw new Error("Review registry must be an operator-configured absolute file.");
    const registry=JSON.parse(fs.readFileSync(reviewRegistry,"utf8").replace(/^\uFEFF/,""));
    deliveryReviews=new (require("./delivery-review.cjs").DeliveryReviewCatalog)(registry);
  }
  const server = createHttpServer({ store, authProvider, trustedProxy, deliveryReviews, basePath: trustedProxyMode ? "/workflow" : "", projectId: projectId || undefined });
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`Workflow service listening on ${host}:${address.port}`);
    console.log(`Authentication mode: ${trustedProxyMode ? "PROTECTED APPLICATION PROXY · DEMO ROLE SIMULATION" : testOnly ? "TEST ONLY (local synthetic identities)" : "AUTH REQUIRED (API denies all requests)"}`);
    if (!trustedProxyMode) console.log(`SQLite database: ${store.databasePath}`);
    if (testOnly || trustedProxyMode) console.log("Synthetic mock calculation only. No DWSIM, Aspen, or Aspen EDR calls.");
    if (deliveryReviews) console.log("Read-only delivery registry enabled: existing evidence only; no new engine execution or engineering approval.");
  });
  const shutdown = () => server.close(() => {
    store.close();
    process.exit(0);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { server, store };
}

if (require.main === module) {
  try {
    startLocalWorkflowServer();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { startLocalWorkflowServer };
