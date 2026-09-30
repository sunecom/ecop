(function(root) {
  'use strict';
  const V=root.ECOPWorkflowView, byId=id=>document.getElementById(id);
  let context=null,key='',serial=0,activeView='overview',reviews=[],delivery=null,reviewDrafts=null,reviewDraftsError='',advisories=[],advisoriesError='';
  let states={reviews:'idle',delivery:'idle'},errors={},busy=false,message='',abort=null,operation=0;let deliveryHistoryNote='';
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;};
  function button(text,fn,disabled=false,secondary=false){const b=node('button',text,secondary?'button button-secondary':'button button-primary');b.type='button';b.disabled=disabled;b.addEventListener('click',fn);return b;}
  const canWrite=()=>context && !context.project.frozen && !context.project.read_only && ['customer','engineer'].includes(context.role);
  const endpoint=(c,op)=>`${c.config.basePath||''}/api/workflow/projects/${encodeURIComponent(c.project.project_id)}/${op}`;
  async function request(c,op,body,signal){
    const headers={Accept:'application/json'};
    if(body!==undefined){headers['Content-Type']='application/json';if(c.config.csrfToken)headers['X-Demo-Token']=c.config.csrfToken;}
    const response=await fetch(endpoint(c,op),{method:body===undefined?'GET':'POST',credentials:'same-origin',headers,signal,...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(response.status===401||response.status===403){const e=Error(response.status===401?'登录已失效，请重新登录。':'当前账号没有操作权限。');e.status=response.status;throw e;}
    let data;try{data=await response.json();}catch{throw Error('服务返回格式不正确，请刷新重试。');}
    if(!response.ok || !data || data.ok!==true){const e=Error(response.status===401?'登录已失效，请重新登录。':response.status===403?'当前账号没有操作权限。':data?.error?.message||'请求失败，请重试。');e.status=response.status;throw e;}
    return data;
  }
  function snapshot(){return V.deriveWorkflowView({project:context.project,manualReviews:reviews,deliveryReview:delivery,requestStates:states});}
  function navigate(view){activeView=view==='overview'||V.STAGES.includes(view)?view:'overview';if(context)draw();}
  async function load(force=false){
    if(!context)return;
    const c=context,expected=`${c.project.project_id}:${c.project.revision}:${c.role}:${c.config.actorId||''}`;
    if(!force && expected===key)return;
    key=expected;const own=++serial;abort?.abort();abort=new AbortController();
    reviews=[];delivery=null;reviewDrafts=null;reviewDraftsError='';deliveryHistoryNote='';advisories=[];advisoriesError='';errors={};states={reviews:'loading',delivery:c.project.delivery_review_available?'loading':'missing'};draw();
    const tasks=[request(c,'manual-review',undefined,abort.signal).then(data=>{if(!Array.isArray(data.reviews))throw Error('交互记录格式不正确。');return data.reviews;})];
    tasks.push(c.project.delivery_review_available&&c.adapter.getDeliveryReview?c.adapter.getDeliveryReview(c.project.project_id):Promise.resolve(null));
    tasks.push(c.adapter.listReviewDrafts?c.adapter.listReviewDrafts(c.project.project_id):Promise.resolve(null));
    // 仅展示工程建议：读取失败不阻塞主加载（与评审草稿同一非致命风格）。
    tasks.push(request(c,'advisories',undefined,abort.signal).then(data=>{if(!Array.isArray(data.advisories))throw Error('工程建议格式不正确。');return data.advisories;}));
    const [a,b,d,adv]=await Promise.allSettled(tasks);
    if(own!==serial || key!==expected)return;
    if((a.status==='rejected'&&[401,403].includes(a.reason.status))||(b.status==='fulfilled'&&b.value?.error?.code==='FORBIDDEN')){
      reviews=[];delivery=null;states={reviews:'error',delivery:'error'};errors={auth:'项目访问权限已失效，请重新登录或核对权限。'};draw();return;
    }
    if(a.status==='fulfilled'){reviews=a.value;states.reviews='loaded';}else{states.reviews='error';errors.reviews=a.reason.message||'交互记录读取失败。';}
    if(b.status==='rejected'){states.delivery='error';errors.delivery=b.reason.message||'评审依据读取失败。';}
    else if(b.value===null)states.delivery='missing';
    else try {
      if(!b.value?.ok || !b.value.review || !Array.isArray(b.value.review.nodes))throw Error(b.value?.error?.message||'评审依据格式不正确。');
      if(b.value.review.project_id!==c.project.project_id || b.value.review.project_revision!==c.project.revision)throw Error('评审依据版本已变化。');
      if(b.value.review.status==='local_review_snapshot')V.validateBundle(b.value,c.project);
      delivery=b.value;states.delivery='loaded';
    }catch(e){states.delivery='error';errors.delivery=e.message;}
    // 处理 reviewDrafts 结果
    if(d.status==='fulfilled' && d.value!==null){
      const data=d.value;
      if(!data.ok){
        const code=data.error?.code||'';
        if(code==='DELIVERY_PROJECT_CHANGED'){reviewDrafts=null;reviewDraftsError='项目版本已更新，评审草稿清单待重新登记。';}
        else if(code==='REVIEW_DRAFTS_NOT_FOUND'){reviewDrafts=null;reviewDraftsError='暂无可用评审草稿。';}
        else{reviewDrafts=null;reviewDraftsError=data.error?.message||'评审草稿读取失败。';}
      } else if(!data.review_drafts || !Array.isArray(data.review_drafts.documents)){
        reviewDrafts=null;reviewDraftsError='评审草稿格式不正确。';
      } else if(data.review_drafts.project_id!==c.project.project_id){
        reviewDrafts=null;reviewDraftsError='评审草稿项目不匹配。';
      } else if(data.review_drafts.project_revision!==c.project.revision){
        reviewDrafts=null;reviewDraftsError='项目版本已更新，评审草稿清单待重新登记。';
      } else {
        reviewDrafts=data.review_drafts.documents;reviewDraftsError='';
      }
    }     else if(d.status==='rejected'){
      const err=d.reason;
      if(err.status===401||err.status===403){reviewDrafts=null;reviewDraftsError='登录已失效或无权限。';}
      else if(err.status===409){reviewDrafts=null;reviewDraftsError='项目版本已更新，评审草稿清单待重新登记。';}
      else{reviewDrafts=null;reviewDraftsError=err.message||'评审草稿读取失败。';}
    }
    // Only classify an explicitly stale legacy record after the CURRENT catalog
    // has passed project, revision and response validation above.
    if(b.status==='fulfilled' && b.value?.error?.code==='DELIVERY_PROJECT_CHANGED'
        && Array.isArray(reviewDrafts) && reviewDrafts.length>0 && !reviewDraftsError){
      states.delivery='stale';
      delete errors.delivery;
      deliveryHistoryNote='历史评审记录已过期；当前版本文件请使用上方下载入口。';
    }
    // 工程建议结果（own!==serial || key!==expected 已在上方统一隔离迟到响应）
    if(adv.status==='fulfilled'){advisories=adv.value;advisoriesError='';}
    else{advisories=[];advisoriesError=adv.reason?.message||'工程建议读取失败。';}
    draw();
  }
  async function mutate(op,body){
    if(busy||!canWrite())return;
    const c=context,own=serial,opId=++operation;busy=true;message='正在保存…';draw();
    try{
      await request(c,op,{...body,expected_revision:c.project.revision});
      if(own!==serial)return;
      message=op==='manual-review-choice'?'选择已保存；柯大侠将根据选择推进。':'任务已提交给柯大侠；收到请求不代表计算已运行。';
      await load(true);
    }catch(e){if(own!==serial)return;message=e.message;if([401,403,409].includes(e.status)){reviews=[];delivery=null;states={reviews:'error',delivery:'error'};errors.reviews=e.status===409?'项目版本有变化；请刷新项目后再提交。':e.message;}}
    finally{if(opId===operation){busy=false;draw();}}
  }
  function reviewCard(r,unclassified=false){
    const article=node('article',undefined,'work-card review-card');
    const labels={queued:'已提交 · 待柯大侠处理',processing:'柯大侠处理中',awaiting_choice:'待你选择',selected:'选择已保存'};
    article.append(node('p',r.stale?'依据已变化 · 历史记录':labels[r.status]||'交互记录','work-state'));
    if(unclassified)article.append(node('p','步骤待整理：保留原交互记录，可查看及处理当前有效提议。','muted'));
    article.append(node('h3',r.response?.summary||r.request_note||'已提交工程任务'));
    for(const option of Array.isArray(r.response?.options)?r.response.options:[]){
      const card=node('section',undefined,'proposal-option');
      card.append(node('h4',option.name),node('p',option.reason),node('p',`适用边界：${option.boundary||'待说明'}`,'muted'));
      card.append(button(r.choice===option.id?'已选择此方案':'采用此方案',()=>mutate('manual-review-choice',{id:r.id,choice:option.id}),!canWrite()||busy||r.stale||r.status!=='awaiting_choice'));
      article.append(card);
    }
    if(Array.isArray(r.response?.equipment)){
      const wrap=node('div',undefined,'work-table-wrap'),table=node('table');
      const head=node('tr');for(const s of ['位号','设备','参数与依据','待核对'])head.append(node('th',s));table.append(head);
      for(const row of r.response.equipment){const tr=node('tr');for(const k of ['tag','name','known','missing'])tr.append(node('td',row[k]||'—'));table.append(tr);}wrap.append(table);article.append(wrap);
    }
    if(typeof r.response?.report_markdown==='string'){
      const detail=node('details'),summary=node('summary','查看成果与依据'),text=node('pre',r.response.report_markdown,'work-report');detail.append(summary,text);article.append(detail);
      article.append(button('下载此记录的成果草稿',()=>downloadText(r.response.report_markdown,'ECOP-成果草稿.md','text/markdown;charset=utf-8'),Boolean(r.stale),true));
    }
    const trail=node('details');trail.append(node('summary','查看记录版本'),node('p',`记录时间：${r.updated_at||r.created_at||'未记录'}；状态：${r.stale?'历史依据':labels[r.status]||r.status}`,'muted'));article.append(trail);
    return article;
  }
  function downloadText(content,filename,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=node('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  // 仅展示工程建议卡：无采用/确认/下载等任何按钮；与 awaiting_choice 选择流完全分离。
  function advisoryCard(a){
    const article=node('article',undefined,'work-card advisory-card');
    article.append(node('p',a.stale?'工程建议 · 依据已变化 · 历史参考':'工程建议 · 条件性 · 待核','work-state'));
    article.append(node('h3',a.summary));
    article.append(node('pre',a.body_markdown,'work-report'));
    article.append(node('p',`来源版本：revision ${a.source_revision}${a.stale?'；项目版本已前进，此建议仅作历史参考，不代替当前依据':'；与当前项目版本一致'}。本卡仅展示，不包含采用或确认操作，不改变已确认阶段。`,'muted'));
    return article;
  }
  async function download(id){
    if(busy || !context?.adapter.getDeliveryReview)return;
    const c=context,own=serial,opId=++operation;busy=true;message='正在核对三份文件版本…';draw();
    try{
      const bundle=V.validateBundle(await c.adapter.getDeliveryReview(c.project.project_id),c.project);
      if(own!==serial || context?.project.revision!==c.project.revision)return;
      for(const d of bundle.documents){
        const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(d.content));
        const hash=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
        if(hash!==d.sha256)throw Error('文件内容校验失败，未下载。');
      }
      if(own!==serial)return;
      const d=bundle.documents.find(x=>x.id===id);if(!d)throw Error('当前文件不存在。');
      downloadText(d.content,d.file_name,d.content_type);message='已下载同版评审草稿；文件内保留适用边界及待核项。';
    }catch(e){if(own!==serial)return;delivery=null;states.delivery='error';errors.delivery=e.message;message=e.message;}
    finally{if(opId===operation){busy=false;draw();}}
  }
  function evidenceCard(n){
    const article=node('article',undefined,'work-card');article.append(node('h3',n.label||'计算依据'),node('p',n.scope||'适用范围待核对','muted'));
    const labels={recorded_scope_only:'依据与范围已记录',unvalidated:'模型假设待验证',numerical_evidence_only:'数值复核证据',pending:'设备适配待核',draft_not_issued:'草稿，未签发'};
    article.append(node('p',labels[n.review_state]||'待工程复核','work-state'));
    if(Array.isArray(n.values)&&n.values.length){const wrap=node('div',undefined,'work-table-wrap'),table=node('table');const h=node('tr');for(const t of ['项目','结果 / 内容','单位'])h.append(node('th',t));table.append(h);for(const v of n.values){const tr=node('tr');const value=Array.isArray(v.value)?v.value.map(x=>Array.isArray(x)?x.join(' → '):String(x)).join('；'):typeof v.value==='object'? '详细内容见评审稿':String(v.value??'未提供');tr.append(node('td',v.label||'项目'),node('td',value),node('td',v.unit||'—'));table.append(tr);}wrap.append(table);article.append(wrap);}
    return article;
  }
  // ECOP-WB-L1-CALCREVIEW-20260927: 04 阶段真实计算交付卡片（只读呈现阶段载荷）。
  // 交付来自服务侧通道（calculation-delivery.cjs），核验为真实引擎结果后才会渲染；
  // 卡片只读，确认放行仍由审核人在阶段动作行完成。
  const RESULT_LABELS={configuration:'方案配置',feed:'进料',product:'浓缩产品',evaporation_total_kg_h:'总蒸发量',effect_split_kg_h:'分效蒸发量',effect_regime:'各效温位',mvr:'MVR 压缩机',heat_load_kw:'换热负荷',convergence:'收敛情况',streams_snapshot:'全流股数据'};
  const RESULT_UNITS=[['_kg_h','kg/h'],['_wt','wt 分数'],['_kpa','kPa'],['_kw','kW'],['_pct','%'],['_bar','bar'],['_c','°C']];
  const EVIDENCE_LABELS={
    'calculation_model':'计算模型',
    'calculation_input':'计算输入',flowsheet_model:'流程模型文件',results_record:'结果记录',flowsheet_screenshot:'流程截图'};
  function unitOf(key){for(const [suffix,unit] of RESULT_UNITS)if(String(key).endsWith(suffix))return unit;return '';}
  function resultRows(results){
    const rows=[];
    const walk=(value,label)=>{
      if(value===null||value===undefined)return;
      if(Array.isArray(value)){for(const item of value)walk(item,label);return;}
      if(typeof value==='object'){for(const [k,v] of Object.entries(value))walk(v,`${label} · ${k}`);return;}
      const key=String(label).split(' · ').pop();
      rows.push({label,value:String(value),unit:typeof value==='number'?unitOf(key):''});
    };
    for(const [k,v] of Object.entries(results||{}))walk(v,RESULT_LABELS[k]||k);
    return rows;
  }
  function tableOf(headers,rows){
    const wrap=node('div',undefined,'work-table-wrap'),table=node('table'),head=node('tr');
    for(const h of headers)head.append(node('th',h));
    table.append(head);
    for(const cells of rows){const tr=node('tr');for(const c of cells)tr.append(node('td',c));table.append(tr);}
    wrap.append(table);return wrap;
  }
  // ECOP-WB-L1-DOCCARD-20260927: 06 阶段交付物目录只读卡片。
  // 交付目录来自工程师提交的阶段载荷（documents.payload.deliverables），
  // 卡片只读；逐项核对引用版本与哈希后，确认放行仍在阶段动作行完成。
function documentsDeliveryCard(payload,stageStatus){
    const items=V.documentDeliverables(payload);
    const article=node('article',undefined,'work-card documents-delivery-card');
    const eyebrowMap={
      'draft':'交付物草稿 · 待提交',
      'submitted':'已提交的阶段交付物 · 六步一致',
      'confirmed':'已审核的交付物目录',
      'stale':'历史交付物 · 依据已变化',
      'returned':'历史交付物 · 已退回'
    };
    const eyebrow=eyebrowMap[stageStatus]||'阶段交付物';
    const noteMap={
      'draft':'本卡片只读；交付物草稿待提交审核。',
      'submitted':'本卡片只读；逐项核对引用版本与内容哈希后，在阶段动作行确认放行。',
      'confirmed':'本卡片只读；交付物已审核，引用版本以所列为准。',
      'stale':'当前依据已变化，待重新提交。本卡片保留供历史对照。',
      'returned':'交付物已退回，待重新提交。本卡片保留供历史对照。'
    };
    const note=noteMap[stageStatus]||'本卡片只读。';
    article.append(node('p',eyebrow,'work-eyebrow'),
      node('h2',`交付物目录（${items.length}）`),
      node('p',`引用来源版本 ${payload.source_revision||'未标注'} · 各交付物以所列阶段确认版本为准`,'muted'),
      node('p',note,'muted'));
    article.append(tableOf(['#','交付物','依据 / 引用版本'],
      items.map((d,i)=>[String(i+1),d.name,d.note||'—'])));
    if(typeof payload.notes==='string'&&payload.notes.trim())article.append(node('p',`交付说明与适用边界：${payload.notes}`,'work-state'));
    return article;
  }
  function calculationDeliveryCard(payload,execution,stageStatus,realCalculationDelivered){
    if(['submitted','confirmed'].includes(stageStatus)&&!realCalculationDelivered){
      stageStatus='stale';
    }
    const article=node('article',undefined,'work-card calculation-delivery-card');
    const method = payload.calculation_method || 'native_flowsheet';
    const eyebrowMap={
      'draft':'计算草稿 · 待提交',
      'submitted': method === 'engine_properties_explicit_balances' ? '方案计算待审核' : '已归类的 Agent 交付 · 真实引擎',
      'confirmed':'已审核的真实计算结果',
      'stale':'历史计算结果 · 依据已变化',
      'returned':'历史计算结果 · 已退回'
    };
    const eyebrow=eyebrowMap[stageStatus]||'计算结果';
    let note;
    if(stageStatus==='submitted'){
      if(realCalculationDelivered){
        note='本卡片只读；核验结果、校核项与适用边界后，在阶段动作行确认放行。';
      } else {
        note='当前依据已变化，待重新计算。本卡片保留供历史对照。';
      }
    } else if(stageStatus==='stale'||stageStatus==='returned'){
      note='当前依据已变化，待重新计算。本卡片保留供历史对照。';
    } else if(stageStatus==='confirmed'){
      if(method === 'engine_properties_explicit_balances'){
        note='方案计算已审核 · 未工程签发，边界见适用说明。';
      } else {
        note='本卡片只读；计算结果已审核，边界见适用说明。';
      }
    } else if(stageStatus==='draft'){
      note='本卡片只读；计算草稿待提交审核。';
    } else {
      note='本卡片只读。';
    }
    const methodLabel = method === 'engine_properties_explicit_balances' ? '真实软件物性调用 + 显式衡算' : '原生流程模拟';
    const validationScope = payload.validation_scope || '';
    const validationLabel = validationScope === 'scheme_review' ? '方案评审' : '';
    const engineeringRelease = payload.engineering_release;
    const releaseLabel = engineeringRelease === false ? '未工程签发' : '';
    let title = payload.engine.name + ' ' + payload.engine.version + ' 真实计算结果';
    if(method === 'engine_properties_explicit_balances'){
      title = payload.engine.name + ' ' + payload.engine.version + ' ' + methodLabel;
    }
    const subtitleParts = ['执行模式：真实引擎', '计算方法：' + methodLabel];
    if(validationLabel) subtitleParts.push(validationLabel);
    if(releaseLabel) subtitleParts.push(releaseLabel);
    subtitleParts.push('模型 ' + (payload.model_version||'未标注'));
    subtitleParts.push('物性方法 ' + (payload.property_method||'未标注'));
    if(execution && execution.delivered_action_id){
      subtitleParts.push('交付记账 ' + execution.delivered_action_id);
    }
    article.append(node('p',eyebrow,'work-eyebrow'),
      node('h2',title),
      node('p',subtitleParts.join(' · '),'muted'),
      node('p',note,'muted'));
    const rows=resultRows(payload.results);
    if(rows.length)article.append(tableOf(['项目','结果 / 内容','单位'],rows.map(r=>[r.label,r.value,r.unit||'—'])));
    const findings = payload.source_findings || {};
    // 执行检查（顶层 checks）
    if(payload.checks && typeof payload.checks === 'object'){
      const entries = Object.entries(payload.checks);
      if(entries.length){
        const details = node('details');
        details.open = true;
        details.append(node('summary','执行检查（' + entries.length + '）'),
          tableOf(['检查项','结论'],entries.map(function(e){
            var k=e[0],v=e[1];
            var display = v === false ? '未通过' : (v === true ? '通过' : String(v));
            return [k, display];
          })));
        article.append(details);
      }
    }
    // 原始工况检查（source_findings.checks）
    if(findings.checks && typeof findings.checks === 'object'){
      const entries = Object.entries(findings.checks);
      if(entries.length){
        const details = node('details');
        details.open = true;
        details.append(node('summary','原始工况检查（' + entries.length + '）'),
          tableOf(['检查项','结论'],entries.map(function(e){
            var k=e[0],v=e[1];
            var display = v === false ? '未通过' : (v === true ? '通过' : String(v));
            return [k, display];
          })));
        article.append(details);
      }
    }
    if(Array.isArray(findings.warnings) && findings.warnings.length){
      var list = node('ul');
      for(var wi=0;wi<findings.warnings.length;wi++){
        list.append(node('li', String(findings.warnings[wi])));
      }
      var details = node('details');
      details.open = true;
      details.append(node('summary','警告（' + findings.warnings.length + '）'), list);
      article.append(details);
    }
    if(Array.isArray(findings.unmet_conditions) && findings.unmet_conditions.length){
      var list = node('ul');
      for(var ci=0;ci<findings.unmet_conditions.length;ci++){
        list.append(node('li', String(findings.unmet_conditions[ci])));
      }
      var details = node('details');
      details.open = true;
      details.append(node('summary','未满足条件（' + findings.unmet_conditions.length + '）'), list);
      article.append(details);
    }
    const claimLimits = Array.isArray(payload.claim_limits) ? payload.claim_limits : (Array.isArray(findings.claim_limits) ? findings.claim_limits : []);
    if(claimLimits.length){
      var list = node('ul');
      for(var li=0;li<claimLimits.length;li++){
        list.append(node('li', String(claimLimits[li])));
      }
      var details = node('details');
      details.open = true;
      details.append(node('summary','声明限制（' + claimLimits.length + '）'), list);
      article.append(details);
    }
    if(Array.isArray(payload.evidence)&&payload.evidence.length){
      var details=node('details');details.open=true;
      details.append(node('summary','溯源证据（' + payload.evidence.length + '）'),
        tableOf(['证据','文件','字节','SHA-256'],
          payload.evidence.map(function(e){return [EVIDENCE_LABELS[e.kind]||e.kind,e.label||'—',String(e.bytes||'—'),String(e.sha256||'—').slice(0,16)+'…'];})));
      article.append(details);
    }
    if(Array.isArray(payload.assumptions)&&payload.assumptions.length){
      var list=node('ul');for(var ai=0;ai<payload.assumptions.length;ai++)list.append(node('li',payload.assumptions[ai]));
      var details=node('details');details.append(node('summary','假设与口径（' + payload.assumptions.length + '）'),list);article.append(details);
    }
    if(typeof payload.boundary==='string'&&payload.boundary.trim())article.append(node('p','适用边界：' + payload.boundary,'work-state'));
    return article;
  }
  function draw(){
    if(!context || !context.business)return;
    const model=snapshot(),overview=activeView==='overview',main=byId('workspace-business-content'),home=byId('workspace-overview');
    main.replaceChildren();home.replaceChildren();home.hidden=!overview;main.hidden=overview;
    byId('project-overview-button').setAttribute('aria-current',overview?'page':'false');
    byId('project-overview-button').onclick=()=>navigate('overview');
    for(const s of model.stages){const b=byId('stage-nav').querySelector(`[data-stage-id="${s.id}"]`);if(b){b.setAttribute('aria-current',!overview&&s.id===activeView?'step':'false');b.querySelector('.step-sub').textContent=context.project.stages[s.id]?.status==='confirmed'?'审核已通过':s.label;}}
    byId('workspace-stage-heading').hidden=overview;
    const activeStage=context.project.stages[activeView];
    byId('stage-return-reason').hidden=overview||activeStage?.status!=='returned'||!activeStage.last_return_reason;
    const returnHistory=byId('stage-return-history');
    if(returnHistory)returnHistory.hidden=overview||activeStage?.status==='returned'||!activeStage?.last_return_reason;
    byId('taskbook-panel').hidden=overview||activeView!=='requirements';
    byId('workspace-advanced').hidden=overview;
    byId('workspace-comments').hidden=overview;
    byId('case-pfd-preview').hidden=overview||activeView!=='pfd'||!context.project.stages.pfd.payload;
    byId('breadcrumb-stage').textContent=overview?'项目总览':V.TITLES[activeView];
    const area=overview?home:main;
    if(context.role==='customer')area.append(node('p','以下六步为审核人的项目审核状态，不代表业主已接受方案。请进入“方案与文件”审阅三份成果，并在该页“阶段评论”填写修改意见、点击发送。','work-message owner-review-guidance'));
    if(overview){
      home.append(node('p','工程方案工作台','work-eyebrow'),node('h1',context.project.title));
      const grid=node('div',undefined,'overview-grid');
    // 消费 executionSummary（由 workflow-view.js 提供）
    if (model.executionSummary) {
      const summaryCard = node('section', undefined, 'work-card execution-summary');
      summaryCard.append(node('p', '执行摘要', 'work-eyebrow'));
      summaryCard.append(node('h2', model.executionSummary));
      home.append(summaryCard);
    }
      for(const [label,value,detail] of [['当前方案',model.currentProposal,model.currentProposalNote||'仅展示已有项目记录'],['待我处理',model.decisionSummary,'提议需要明确选择；评论不代替确认'],['下一步',model.nextSummary,`负责人：${model.nextOwner}`]]){const card=node('section',undefined,'work-card');card.append(node('p',label,'work-eyebrow'),node('h2',value),node('p',detail,'muted'));grid.append(card);}home.append(grid);
      const actions=node('div',undefined,'work-toolbar');actions.append(button('进入需求与任务书',()=>context.onStage('requirements')),button('查看方案与文件',()=>context.onStage('documents'),false,true));home.append(actions);
    }
    const toolbar=node('div',undefined,'work-toolbar');toolbar.append(button('刷新处理结果',()=>{message='';load(true);},busy||states.reviews==='loading',true));
    if(states.reviews==='loading')toolbar.append(node('span','正在读取项目交互…','muted'));
    area.append(toolbar);
    if(message)area.append(node('p',message,'work-message'));
    for(const text of Object.values(errors))area.append(node('p',text,'work-error'));
    if(!overview&&activeView==='requirements'){
      const card=node('section',undefined,'work-card');card.append(node('h2','基于现有资料发起工艺推荐'),node('p','已有任务书即可启动推荐，无需先补齐所有后续参数。物性、设备和运行条件随所选路线逐项补充。'));
      const label=node('label','补充说明（可选）'),input=node('textarea');input.id='work-request-note';input.maxLength=2000;input.value=draftNote;input.addEventListener('input',()=>{draftNote=input.value;});label.append(input);card.append(label,button('提交给柯大侠',()=>mutate('manual-review',{note:draftNote}),!canWrite()||busy));main.append(card);
    }
    const unclassifiedActive=model.unclassified.filter(r=>!r.stale&&['queued','processing','awaiting_choice'].includes(r.status));
    const records=overview?unclassifiedActive:model.stages.find(s=>s.id===activeView)?.reviews||[];
    const actionable=overview?model.needsChoice.filter(r=>V.reviewStage(r)):[];
    if(actionable.length){home.append(node('h2','待你处理'));for(const r of actionable)home.append(reviewCard(r));}
    if(records.length){area.append(node('h2',overview?'尚待归类的项目记录':'本步骤交互与成果'));for(const r of records)area.append(reviewCard(r,overview));}
    // 工程建议（仅展示）：当前有效卡按绑定阶段/总览呈现；历史卡只在总览折叠保留。
    if(advisoriesError)area.append(node('p',advisoriesError,'work-error'));
    const currentAdvisories=advisories.filter(a=>!a.stale&&a.stage_id&&(overview||a.stage_id===activeView));
    if(currentAdvisories.length){area.append(node('h2','工程建议（仅展示 · 待核/条件性）'));for(const a of currentAdvisories)area.append(advisoryCard(a));}
    if(overview){const staleAdvisories=advisories.filter(a=>a.stale);
      if(staleAdvisories.length){const advHistory=node('details',undefined,'work-card');advHistory.append(node('summary',`历史工程建议（${staleAdvisories.length}）`));for(const a of staleAdvisories)advHistory.append(advisoryCard(a));home.append(advHistory);}}
    const calculationPayload=!overview&&activeView==='calculation'&&V.isRealEngineCalculation(context.project.stages.calculation?.payload)?context.project.stages.calculation.payload:null;
    const stageRecordPresent=!overview&&activeView!=='requirements'&&activeView!=='documents'&&V.stageRecordPresent(context.project.stages[activeView]?.payload);
    if(!records.length&&!calculationPayload&&!overview&&activeView!=='requirements'&&activeView!=='documents')area.append(node('p',stageRecordPresent?'本步骤以工程师提交的结构化阶段记录为准，内容见下方「阶段版本与高级编辑」；此处无 Agent 交付卡。':'本步骤暂没有已归类的 Agent 交付。旧记录可在总览查看；需要工程依据时由柯大侠接续。','work-empty'));
    if(calculationPayload)main.append(calculationDeliveryCard(calculationPayload,context.project.execution_context,context.project.stages.calculation?.status,model.realCalculationDelivered));
    if(!overview){for(const n of model.stages.find(s=>s.id===activeView)?.evidence||[])main.append(evidenceCard(n));}
    if(overview){
      const history=model.unclassified.filter(r=>!unclassifiedActive.includes(r));
      if(history.length){const details=node('details',undefined,'work-card');details.append(node('summary',`历史与待归类记录（${history.length}）`));for(const r of history)details.append(reviewCard(r,true));home.append(details);}
      const summaries=model.stages.filter(s=>s.evidence.length).map(s=>`${s.title}：${s.evidence.length} 项依据`);
      home.append(node('h2','当前计算与设备依据'),node('p',summaries.join('；')||'暂无已关联的当前版本评审依据。','work-empty'));
    }
    const documentsPayload=activeView==='documents'&&!overview&&V.documentDeliverables(context.project.stages.documents?.payload).length?context.project.stages.documents.payload:null;
    if(activeView==='documents'){
      if(documentsPayload)main.append(documentsDeliveryCard(documentsPayload,context.project.stages.documents?.status));
      const hasCurrentDrafts=Array.isArray(reviewDrafts)&&reviewDrafts.length>0&&!reviewDraftsError;
      const legacySection=node(hasCurrentDrafts?'details':'section',undefined,'work-card legacy-review-section');
      legacySection.append(node(hasCurrentDrafts?'summary':'h2','历史评审记录与草稿'));
      legacySection.append(node('p',deliveryHistoryNote||model.deliveryMessage,'muted'));
      for(const [id,title] of [['technical-proposal','技术方案评审稿'],['calculation-book','计算依据与结果'],['equipment-parameters','设备参数核对稿']])legacySection.append(button(`下载${title}`,()=>download(id),!model.currentDelivery||busy,true));
      legacySection.append(node('p','历史记录保留追溯；过期文件不可作为当前交付下载。','muted'));
      
      // 评审草稿（受控）下载区
      const draftSection=node('section',undefined,'work-card review-drafts-section');
      draftSection.append(node('h3','评审草稿（受控）'));
      draftSection.append(node('p','评审草稿 · 非正式签发 · engineering_release=false','draft-banner'));
      if(reviewDraftsError){
        const errorRow=node('div',undefined,'draft-error-row');
        errorRow.append(node('p',reviewDraftsError,'draft-error'));
        errorRow.append(button('重试',()=>load(true),busy,true));
        draftSection.append(errorRow);
      } else if(reviewDrafts && reviewDrafts.length){
        for(const draft of reviewDrafts){
          const draftCard=node('div',undefined,'draft-card');
          draftCard.append(node('h4',draft.label));
          draftCard.append(node('p',`SHA256: ${draft.sha256.substring(0,16)}...`,'draft-meta'));
          draftCard.append(node('p',`字节数: ${draft.bytes.toLocaleString()}`,'draft-meta'));
          const downloadBtn=button('下载',async()=>{
            const ownSerial=serial;
            const originalContext=context;
            const originalProjectId=originalContext?.project?.project_id;
            const originalRevision=originalContext?.project?.revision;
            try{
              downloadBtn.disabled=true;
              downloadBtn.textContent='下载中...';
              const response=await fetch(endpoint(originalContext,'review-drafts/'+draft.id),{credentials:'same-origin'});
              if(ownSerial!==serial)return;
              if(!response.ok){
                const msg=response.status===409?'项目版本已更新，评审草稿清单待重新登记。':response.status===401?'登录已失效。':response.status===403?'无权限。':'下载失败，请重试。';
                throw Error(msg);
              }
              const headerSha=response.headers.get('X-Review-Draft-Sha256');
              const blob=await response.blob();
              if(ownSerial!==serial)return;
              const actualSha=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()).then(buf=>Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join(''));
              if(ownSerial!==serial)return;
              if(context!==originalContext||context?.project?.project_id!==originalProjectId||context?.project?.revision!==originalRevision){return;}
              if(actualSha!==draft.sha256){throw Error('下载内容哈希与清单不符，已拒绝。');}
              if(!headerSha||!/^[a-f0-9]{64}$/.test(headerSha)||headerSha!==draft.sha256){throw Error('响应头哈希缺失、格式错误或与清单不符，已拒绝。');}
              const url=URL.createObjectURL(blob);
              const a=document.createElement('a');a.href=url;a.download=draft.name;a.click();
              URL.revokeObjectURL(url);
            }catch(e){if(ownSerial===serial&&context===originalContext){alert(e.message);}}
            finally{if(ownSerial===serial){downloadBtn.disabled=false;downloadBtn.textContent='下载';}}
          },busy);
          draftCard.append(downloadBtn);
          draftSection.append(draftCard);
        }
      } else {
        draftSection.append(node('p','暂无可用评审草稿。','muted'));
      }
      main.append(draftSection,legacySection);
    }
    byId('execution-pill').textContent=model.realCalculationDelivered?'已交付真实计算结果':model.currentDelivery?'已关联实际计算证据':'执行状态见本步骤记录';
    if(model.currentDelivery)byId('case-execution-label').textContent='已关联真实计算证据 · 本次未重跑';
  }
  let draftNote='';
  function reset(){context=null;key='';serial++;operation++;abort?.abort();reviews=[];delivery=null;reviewDrafts=null;reviewDraftsError='';deliveryHistoryNote='';advisories=[];advisoriesError='';busy=false;errors={};message='';states={reviews:'idle',delivery:'idle'};activeView='overview';draftNote='';}
  function render(c){
    byId('project-overview-button').hidden=!c.business;
    if(!c.business){reset();byId('workspace-overview').hidden=true;byId('workspace-business-content').hidden=true;byId('workspace-stage-heading').hidden=false;byId('workspace-advanced').hidden=false;byId('workspace-comments').hidden=false;return;}
    if(context?.project.project_id!==c.project.project_id || context?.role!==c.role || context?.config.actorId!==c.config.actorId){reset();activeView='overview';}
    context=c;draw();load();
  }
  root.ECOPWorkspaceUI={render,reset,navigate,refresh:()=>load(true)};
})(globalThis);
