(() => {
  'use strict';

  const bridge = window.ECOPWorkbench;
  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
  const state = {projects: [], active: null, selectedVersion: null, records: []};

  function status(message, error = false) {
    const node = byId('projectStatus');
    node.textContent = message;
    node.classList.toggle('error', error);
  }

  async function api(path, options = {}) {
    const init = {...options, headers: {...(options.headers || {})}};
    if (init.method === 'POST') {
      init.headers['Content-Type'] = 'application/json';
      init.headers['X-Demo-Token'] = bridge.nonce;
      init.body = JSON.stringify(options.body || {});
    }
    const response = await fetch(path, init);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '项目请求失败');
    return data;
  }

  function inputSummary(inputs) {
    const fields = Object.entries(inputs).filter(([key]) => !['module'].includes(key)).slice(0, 7);
    return fields.map(([key, value]) => `${key}=${typeof value === 'number' ? Number(value).toLocaleString('zh-CN') : value}`).join(' · ');
  }

  function recordLabel(record) {
    const result = record.result;
    return `${result.module.name} · ${record.run_id.slice(0, 8)} · ${Number(result.comparison.value).toLocaleString('zh-CN', {maximumFractionDigits: 4})} ${result.comparison.unit}`;
  }

  function collectRecords(project) {
    return project.cases.flatMap(item => item.versions.flatMap(version =>
      version.records.map(record => ({...record, caseName: item.name, version: version.version}))));
  }

  function renderProject() {
    const project = state.active;
    const empty = byId('projectEmpty');
    const tree = byId('projectTree');
    if (!project) {
      empty.hidden = false;
      tree.innerHTML = '';
      state.records = [];
      renderCompareOptions();
      return;
    }
    const cases = project.cases || [];
    empty.hidden = cases.length > 0;
    empty.textContent = '当前项目还没有工况。请先在计算工作台确认输入，再保存为工况。';
    tree.innerHTML = cases.map(item => `
      <article class="project-case">
        <h3>${escapeHtml(item.name)} <span class="type-name">${escapeHtml(item.id.slice(0, 13))}</span></h3>
        ${item.versions.map(version => `
          <section class="project-version">
            <div class="project-version-head">
              <div><strong>版本 ${version.version}</strong><div class="type-name">${escapeHtml(version.id.slice(0, 13))} · ${escapeHtml(version.created_at)}</div></div>
              <div class="project-version-actions">
                <button data-open-version="${version.id}">打开参数</button>
                <button data-copy-version="${version.id}">复制工况</button>
                <button class="primary-action" data-calculate-version="${version.id}">计算并导出</button>
              </div>
            </div>
            <div class="project-inputs">${escapeHtml(inputSummary(version.inputs))}</div>
            ${version.records.length ? version.records.map(record => `
              <div class="project-record">
                <div><b>${escapeHtml(recordLabel(record))}</b><div class="type-name">不可变计算记录 · ${escapeHtml(record.created_at)}</div></div>
                <div class="project-record-actions">
                  <button data-show-run="${record.run_id}">查看结果</button>
                  ${record.export ? `<a href="/api/exports/${record.export.id}" download>下载 DWSIM 流程文件</a>` : '<span class="type-name">旧记录无流程文件</span>'}
                </div>
              </div>`).join('') : '<div class="project-inputs">尚未计算；计算成功后生成不可变记录和 DWSIM 流程文件。</div>'}
          </section>`).join('')}
      </article>`).join('');
    state.records = collectRecords(project);
    bindTreeActions();
    renderCompareOptions();
  }

  function findVersion(versionId) {
    for (const item of state.active?.cases || []) {
      const version = item.versions.find(candidate => candidate.id === versionId);
      if (version) return {item, version};
    }
    return null;
  }

  function findRecord(runId) {
    return state.records.find(record => record.run_id === runId);
  }

  function selectVersion(versionId, openWorkbench = false) {
    const found = findVersion(versionId);
    if (!found) return;
    state.selectedVersion = found.version;
    byId('versionCreate').disabled = false;
    byId('caseName').value = found.item.name;
    if (openWorkbench) bridge.loadInputs(found.version.inputs);
    status(`已选择 ${found.item.name} / 版本 ${found.version.version}；改参后可保存为新版本。`);
  }

  function bindTreeActions() {
    document.querySelectorAll('[data-open-version]').forEach(button => button.addEventListener('click', () =>
      selectVersion(button.dataset.openVersion, true)));
    document.querySelectorAll('[data-copy-version]').forEach(button => button.addEventListener('click', async () => {
      try {
        const found = findVersion(button.dataset.copyVersion);
        const name = byId('caseName').value.trim() || `${found.item.name} 复制`;
        status('正在复制不可变工况版本…');
        await api(`/api/case-versions/${found.version.id}/copy`, {
          method: 'POST', body: {project_id: state.active.id, name}
        });
        await loadProject(state.active.id);
        status('工况已复制为新的稳定 ID。');
      } catch (error) {
        status(error.message, true);
      }
    }));
    document.querySelectorAll('[data-calculate-version]').forEach(button => button.addEventListener('click', async () => {
      try {
        selectVersion(button.dataset.calculateVersion);
        button.disabled = true;
        status('DWSIM 正在计算并保存桌面流程文件…');
        const data = await api(`/api/case-versions/${button.dataset.calculateVersion}/calculate`, {
          method: 'POST', body: {}
        });
        bridge.showResult(data.record.result);
        bridge.addSessionRecord(data.record.result);
        await loadProject(state.active.id);
        status(`计算 ${data.record.run_id.slice(0, 8)} 已保存；可下载 DWSIM 流程文件。`);
      } catch (error) {
        status(error.message, true);
      } finally {
        button.disabled = false;
      }
    }));
    document.querySelectorAll('[data-show-run]').forEach(button => button.addEventListener('click', () => {
      const record = findRecord(button.dataset.showRun);
      if (!record) return;
      bridge.showResult(record.result);
      location.hash = 'workbench';
      status(`已打开不可变记录 ${record.run_id.slice(0, 8)}。`);
    }));
  }

  function renderCompareOptions() {
    const options = '<option value="">请选择</option>' + state.records.map(record =>
      `<option value="${record.run_id}">${escapeHtml(record.caseName)} v${record.version} · ${escapeHtml(recordLabel(record))}</option>`).join('');
    byId('projectCompareA').innerHTML = options;
    byId('projectCompareB').innerHTML = options;
    if (state.records.length >= 2) {
      byId('projectCompareA').value = state.records[state.records.length - 2].run_id;
      byId('projectCompareB').value = state.records[state.records.length - 1].run_id;
    }
  }

  async function loadProject(projectId) {
    if (!projectId) {
      state.active = null;
      state.selectedVersion = null;
      byId('versionCreate').disabled = true;
      renderProject();
      return;
    }
    const data = await api(`/api/projects/${projectId}`);
    state.active = data.project;
    if (state.selectedVersion && !findVersion(state.selectedVersion.id)) {
      state.selectedVersion = null;
      byId('versionCreate').disabled = true;
    }
    renderProject();
  }

  async function loadProjects(preferredId = null) {
    try {
      status('正在读取服务端项目与历史…');
      const data = await api('/api/projects');
      state.projects = data.projects;
      byId('projectCount').textContent = data.projects.length;
      byId('projectSelect').innerHTML = '<option value="">请选择项目</option>' + data.projects.map(project =>
        `<option value="${project.id}">${escapeHtml(project.name)} · ${project.case_count} 工况 / ${project.record_count} 记录</option>`).join('');
      const selected = preferredId || state.active?.id || data.projects[0]?.id || '';
      byId('projectSelect').value = selected;
      await loadProject(selected);
      const migration = data.migration || {};
      status(`项目已恢复；旧记录迁移 ${migration.imported || 0}，跳过 ${migration.skipped || 0}，无效 ${migration.invalid || 0}。`);
    } catch (error) {
      status(error.message, true);
    }
  }

  byId('projectCreate').addEventListener('click', async () => {
    try {
      const name = byId('projectName').value.trim();
      status('正在创建项目…');
      const data = await api('/api/projects', {method: 'POST', body: {name}});
      byId('projectName').value = '';
      await loadProjects(data.project.id);
      status(`项目“${data.project.name}”已创建。`);
    } catch (error) {
      status(error.message, true);
    }
  });

  byId('projectSelect').addEventListener('change', async event => {
    try {
      state.selectedVersion = null;
      byId('versionCreate').disabled = true;
      await loadProject(event.target.value);
      status(state.active ? `已打开项目“${state.active.name}”。` : '请选择项目。');
    } catch (error) {
      status(error.message, true);
    }
  });

  byId('projectRefresh').addEventListener('click', () => loadProjects());

  byId('caseCreate').addEventListener('click', async () => {
    try {
      if (!state.active) throw new Error('请先创建或选择项目');
      const name = byId('caseName').value.trim();
      const inputs = bridge.getInputs();
      status('正在保存当前输入为不可变工况版本…');
      const data = await api(`/api/projects/${state.active.id}/cases`, {
        method: 'POST', body: {name, inputs}
      });
      await loadProject(state.active.id);
      selectVersion(data.case.versions[0].id);
      status(`工况“${data.case.name}”版本 1 已保存。`);
    } catch (error) {
      status(error.message, true);
    }
  });

  byId('versionCreate').addEventListener('click', async () => {
    try {
      if (!state.selectedVersion) throw new Error('请先打开一个工况版本');
      const inputs = bridge.getInputs();
      status('正在保存修改后的新版本…');
      const data = await api(`/api/cases/${state.selectedVersion.case_id}/versions`, {
        method: 'POST', body: {inputs, parent_version_id: state.selectedVersion.id}
      });
      const projectId = state.active.id;
      await loadProject(projectId);
      selectVersion(data.version.id);
      status(`新版本 ${data.version.version} 已保存，原版本保持不变。`);
    } catch (error) {
      status(error.message, true);
    }
  });

  byId('projectCompare').addEventListener('click', async () => {
    try {
      const runA = byId('projectCompareA').value;
      const runB = byId('projectCompareB').value;
      const data = await api(`/api/compare?run_a=${encodeURIComponent(runA)}&run_b=${encodeURIComponent(runB)}`);
      const item = data.comparison;
      const relative = item.relative_percent === null ? '' : `（${Number(item.relative_percent).toLocaleString('zh-CN', {maximumFractionDigits: 4})}%）`;
      byId('projectCompareOutput').textContent = `${item.label}: A ${item.value_a} ${item.unit} → B ${item.value_b} ${item.unit}；B−A = ${item.delta} ${item.unit}${relative}`;
      status('兼容性检查通过，已完成历史比较。');
    } catch (error) {
      byId('projectCompareOutput').textContent = error.message;
      status(error.message, true);
    }
  });

  document.addEventListener('ecop:result', event => {
    if (event.detail?.run_id) byId('caseName').placeholder = `${event.detail.module.name} ${event.detail.run_id.slice(0, 8)}`;
  });

  loadProjects();
})();
