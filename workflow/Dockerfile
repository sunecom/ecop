FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254 AS parser_runtime
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV NODE_ENV=production
WORKDIR /app
COPY --from=parser_runtime /usr/local/ /usr/local/
RUN ldconfig && python3 -c "import zipfile, xml.etree.ElementTree, json"
RUN mkdir -p /app/workflow_mvp /var/lib/workflow && chown -R node:node /var/lib/workflow
COPY --chown=node:node manual-review.cjs agent-context.cjs taskbook-service.cjs taskbook-parser.py taskbook-fields.json taskbook-ui.js taskbook-template.xlsx workflow-server.cjs workflow-service.cjs workflow-engine.js report-generator.cjs requirements-schema.js business-ui-copy.js index.html styles.css app.js workflow-config.js http-adapter.js synthetic-adapter.js workflow-controller.js ./workflow_mvp/
COPY --chown=node:node delivery-review.cjs evidence-snapshot.cjs ./workflow_mvp/
USER node
EXPOSE 18922
CMD ["node", "workflow_mvp/workflow-server.cjs", "--db", "/var/lib/workflow/workflow.sqlite3", "--port", "18922", "--host", "0.0.0.0", "--trusted-proxy-auth", "--proxy-token-file", "/run/secrets/workflow_proxy_token", "--proxy-authority", "workflow:18922", "--proxy-origin", "http://workflow:18922", "--project-id", "workflow-synthetic-001"]

COPY --chown=node:node workspace-ui.js workflow-view.js workspace-layout.css /app/workflow_mvp/
