(function(root) {
  'use strict';
  const V=root.ECOPWorkflowView, byId=id=>document.getElementById(id);
  let context=null,key='',serial=0,activeView='overview',reviews=[],delivery=null;
  let states={reviews:'idle',delivery:'idle'},errors={},busy=false,message='',abort=null,operation=0;
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
    const c=context,expected=`${c.project.project_id}:${c.project.revision}`;
    if(!force && expected===key)return;
    key=expected;const own=++serial;abort?.abort();abort=new AbortController();
    reviews=[];delivery=null;errors={};states={reviews:'loading',delivery:c.project.delivery_review_available?'loading':'missing'};draw();
    const tasks=[request(c,'manual-review',undefined,abort.signal).then(data=>{if(!Array.isArray(data.reviews))throw Error('交互记录格式不正确。');return data.reviews;})];
    tasks.push(c.project.delivery_review_available&&c.adapter.getDeliveryReview?c.adapter.getDeliveryReview(c.project.project_id):Promise.resolve(null));
    const [a,b]=await Promise.allSettled(tasks);
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
  function draw(){
    if(!context || !context.business)return;
    const model=snapshot(),overview=activeView==='overview',main=byId('workspace-business-content'),home=byId('workspace-overview');
    main.replaceChildren();home.replaceChildren();home.hidden=!overview;main.hidden=overview;
    byId('project-overview-button').setAttribute('aria-current',overview?'page':'false');
    byId('project-overview-button').onclick=()=>navigate('overview');
    for(const s of model.stages){const b=byId('stage-nav').querySelector(`[data-stage-id="${s.id}"]`);if(b){b.setAttribute('aria-current',!overview&&s.id===activeView?'step':'false');b.querySelector('.step-sub').textContent=s.label;}}
    byId('workspace-stage-heading').hidden=overview;
    byId('stage-return-reason').hidden=overview||!context.project.stages[activeView]?.last_return_reason;
    byId('taskbook-panel').hidden=overview||activeView!=='requirements';
    byId('workspace-advanced').hidden=overview;
    byId('workspace-comments').hidden=overview;
    byId('case-pfd-preview').hidden=overview||activeView!=='pfd'||!context.project.stages.pfd.payload;
    byId('breadcrumb-stage').textContent=overview?'项目总览':V.TITLES[activeView];
    const area=overview?home:main;
    if(overview){
      home.append(node('p','工程方案工作台','work-eyebrow'),node('h1',context.project.title));
      const grid=node('div',undefined,'overview-grid');
      for(const [label,value,detail] of [['当前方案',model.currentProposal,'仅展示已有项目记录'],['待我处理',model.decisionSummary,'提议需要明确选择；评论不代替确认'],['下一步',model.nextSummary,`负责人：${model.nextOwner}`]]){const card=node('section',undefined,'work-card');card.append(node('p',label,'work-eyebrow'),node('h2',value),node('p',detail,'muted'));grid.append(card);}home.append(grid);
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
    else if(!overview&&activeView!=='requirements'&&activeView!=='documents')area.append(node('p','本步骤暂没有已归类的 Agent 交付。旧记录可在总览查看；需要工程依据时由柯大侠接续。','work-empty'));
    if(!overview){for(const n of model.stages.find(s=>s.id===activeView)?.evidence||[])main.append(evidenceCard(n));}
    if(overview){
      const history=model.unclassified.filter(r=>!unclassifiedActive.includes(r));
      if(history.length){const details=node('details',undefined,'work-card');details.append(node('summary',`历史与待归类记录（${history.length}）`));for(const r of history)details.append(reviewCard(r,true));home.append(details);}
      const summaries=model.stages.filter(s=>s.evidence.length).map(s=>`${s.title}：${s.evidence.length} 项依据`);
      home.append(node('h2','当前计算与设备依据'),node('p',summaries.join('；')||'暂无已关联的当前版本评审依据。','work-empty'));
    }
    if(activeView==='documents'){
      main.append(node('h2','同版评审文件'),node('p',model.deliveryMessage,'work-message'));
      for(const [id,title] of [['technical-proposal','技术方案评审稿'],['calculation-book','计算依据与结果'],['equipment-parameters','设备参数核对稿']])main.append(button(`下载${title}`,()=>download(id),!model.currentDelivery||busy,true));
      main.append(node('p','每次下载重新核对项目版本、证据快照与三份内容哈希；评审草稿不等于正式工程签发。','muted'));
    }
    byId('execution-pill').textContent=model.currentDelivery?'已关联实际计算证据':'执行状态见本步骤记录';
    if(model.currentDelivery)byId('case-execution-label').textContent='已关联真实计算证据 · 本次未重跑';
  }
  let draftNote='';
  function reset(){context=null;key='';serial++;operation++;abort?.abort();reviews=[];delivery=null;busy=false;errors={};message='';states={reviews:'idle',delivery:'idle'};activeView='overview';draftNote='';}
  function render(c){
    byId('project-overview-button').hidden=!c.business;
    if(!c.business){reset();byId('workspace-overview').hidden=true;byId('workspace-business-content').hidden=true;byId('workspace-stage-heading').hidden=false;byId('workspace-advanced').hidden=false;byId('workspace-comments').hidden=false;return;}
    if(context?.project.project_id!==c.project.project_id){reset();activeView='overview';}
    context=c;draw();load();
  }
  root.ECOPWorkspaceUI={render,reset,navigate,refresh:()=>load(true)};
})(globalThis);
