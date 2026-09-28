(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ECOPWorkflowView = factory();
})(globalThis, function() {
  'use strict';
  const STAGES = ['requirements', 'selection', 'pfd', 'calculation', 'equipment', 'documents'];
  const TITLES = {requirements:'需求与任务书',selection:'工艺选择',pfd:'流程与参数',calculation:'工程计算',equipment:'设备与运行',documents:'方案与文件'};
  const NODE_STAGE = {basis:'requirements',temperature:'pfd',assumptions:'pfd',network:'calculation','numerical-audit':'calculation',supplier:'equipment',equipment:'equipment',documents:'documents'};
  function reviewStage(review) {
    if (STAGES.includes(review?.response?.workflow_stage)) return review.response.workflow_stage;
    // ECOP-WB-L1-FULLPROCESS-20260926: 工艺推荐（交付含候选路线 options）默认归入
    // 「工艺选择」阶段，避免因交付方未标注 workflow_stage 而落入「尚待归类」。
    const options = review?.response?.options;
    if (Array.isArray(options) && options.length) return 'selection';
    return null;
  }
  function nodeStage(id) {return NODE_STAGE[id] || (/^native-/.test(id || '') ? 'calculation' : null);}
  // ECOP-WB-L1-CALCREVIEW-20260927: 真实引擎计算交付判定（前端只读判定，与后端
  // calculation-delivery.cjs isRealEngineCalculation 同规则）。仅服务侧交付通道写入的
  // 载荷视为工程依据；合成/手工载荷一律不算，因此不能解锁审核确认。
  const ENGINE_EVIDENCE_KINDS = ['flowsheet_model','results_record','flowsheet_screenshot'];
  const REQUIRED_EVIDENCE_KINDS = ['flowsheet_model','results_record'];
  function isRealEngineCalculation(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (payload.execution_mode !== 'real_engine') return false;
    const engine = payload.engine;
    if (!engine || typeof engine !== 'object' || Array.isArray(engine)) return false;
    if (typeof engine.name !== 'string' || !engine.name.trim()) return false;
    if (typeof engine.version !== 'string' || !engine.version.trim()) return false;
    if (!Array.isArray(payload.evidence) || !payload.evidence.length) return false;
    const kinds = new Set();
    for (const item of payload.evidence) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      if (typeof item.kind !== 'string' || !ENGINE_EVIDENCE_KINDS.includes(item.kind)) return false;
      if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) return false;
      if (!Number.isInteger(item.bytes) || item.bytes <= 0) return false;
      kinds.add(item.kind);
    }
    if (!REQUIRED_EVIDENCE_KINDS.every(kind => kinds.has(kind))) return false;
    if (typeof payload.boundary !== 'string' || !payload.boundary.trim()) return false;
    if (!Array.isArray(payload.assumptions) || !payload.assumptions.length) return false;
    if (!payload.results || typeof payload.results !== 'object' || Array.isArray(payload.results)) return false;
    return true;
  }
  // ECOP-WB-L1-STAGE-NOTE-20260927: 工程师提交的结构化阶段记录（pfd/equipment 等）
  // 不是 manual_reviews 里的 Agent 交付卡，但同样代表本步骤已有内容；据其是否非空
  // 决定空态提示措辞，避免审核人误以为本步骤什么都没有。
  function stageRecordPresent(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const collections = ['items', 'nodes', 'streams'].filter(key => Array.isArray(payload[key]));
    if (collections.length) return collections.some(key => payload[key].length > 0);
    return Object.keys(payload).length > 0;
  }
  // ECOP-WB-L1-DOCCARD-20260927: 06 阶段交付物目录（payload.deliverables）的只读规范化。
  // 只收有名称的条目；缺 deliverables/空数组/非对象一律返回空，界面维持原样。
  function documentDeliverables(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
    if (!Array.isArray(payload.deliverables)) return [];
    return payload.deliverables.filter(item => item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.name === 'string' && item.name.trim());
  }
  // ECOP-WB-L1-WEB-EXECUTE-20260926: when the backend supplies an authoritative
  // read-only business_status projection (schema 1), the view defers to it for
  // stage labels, classification and next action; review cards and delivery
  // documents are still rendered from the loaded review/delivery data below.
  function backendView(status, {manualReviews=[], deliveryReview=null, requestStates={}}={}) {
    const reviews = requestStates.reviews === 'error' ? [] : manualReviews.filter(r=>r && typeof r.id==='string');
    const delivery = requestStates.delivery === 'error' ? null : deliveryReview;
    const currentDelivery = Boolean(delivery?.ok && delivery.review?.status==='local_review_snapshot' && delivery.review.project_id===status.project_id && delivery.review.project_revision===status.project_revision);
    const realCalculationDelivered = status.calculation_review ? status.calculation_review.delivered === true : false;
    const valid = reviews.filter(r=>!r.stale);
    const known = valid.filter(r=>reviewStage(r));
    const needsChoice = valid.filter(r=>r.status==='awaiting_choice');
    const processing = valid.filter(r=>['queued','processing'].includes(r.status));
    const nodes = currentDelivery && Array.isArray(delivery.review.nodes) ? delivery.review.nodes : [];
    const stages = status.stages.map(s=>{
      const evidence=nodes.filter(n=>nodeStage(n.id)===s.id);
      return {id:s.id,title:s.title,label:s.label,approvalStatus:s.stage_status,reviews:reviews.filter(r=>reviewStage(r)===s.id),evidence};
    });
    const selectedChoice = Array.isArray(status.selected_choices) ? status.selected_choices.find(c=>c.stage==='selection') : null;
    const selectedReview = selectedChoice ? reviews.find(r=>r.id===selectedChoice.review_id) : null;
    const selectedOption = selectedReview?.response?.options?.find(o=>o.id===selectedChoice.choice);
    const unclassified=reviews.filter(r=>!reviewStage(r));
    const focus=needsChoice[0] ? reviewStage(needsChoice[0])||'overview' : processing[0] ? reviewStage(processing[0])||'overview' : known[0] ? reviewStage(known[0]) : 'overview';
    const nextAction = status.next_action || {text:'暂无待办。',owner:'—'};
    return {
      stages, focus, unclassified, needsChoice, processing, currentDelivery, realCalculationDelivered,
      currentProposal: selectedOption?.name || (selectedReview?.response?.summary) || (currentDelivery ? '已有同版方案评审稿' : '尚无已归类的工艺选择'),
      decisionSummary: needsChoice.length ? `${needsChoice.length} 项提议待你选择` : '暂无待选择提议',
      nextSummary: nextAction.text,
      nextOwner: nextAction.owner,
      deliveryMessage: currentDelivery ? '三份评审稿引用同一数据快照；设备待核项保留。' : delivery?.ok ? '依据已变化，当前旧稿停止下载。' : '尚无可下载的同版评审稿。',
      source: 'backend_business_status'
    };
  }
  function deriveWorkflowView({project, manualReviews=[], deliveryReview=null, requestStates={}}={}) {
    const businessStatus = project?.business_status;
    if (businessStatus && businessStatus.schema === 1 && !requestStates.business_status_error) {
      return backendView(businessStatus, {manualReviews, deliveryReview, requestStates});
    }
    const reviews = requestStates.reviews === 'error' ? [] : manualReviews.filter(r=>r && typeof r.id==='string');
    const delivery = requestStates.delivery === 'error' ? null : deliveryReview;
    const currentDelivery = Boolean(delivery?.ok && delivery.review?.status==='local_review_snapshot' && delivery.review.project_id===project?.project_id && delivery.review.project_revision===project?.revision);
    const realCalculationDelivered = isRealEngineCalculation(project?.stages?.calculation?.payload);
    const valid = reviews.filter(r=>!r.stale);
    const known = valid.filter(r=>reviewStage(r));
    const latest = stage=>known.find(r=>reviewStage(r)===stage);
    const needsChoice = valid.filter(r=>r.status==='awaiting_choice');
    const processing = valid.filter(r=>['queued','processing'].includes(r.status));
    const nodes = currentDelivery && Array.isArray(delivery.review.nodes) ? delivery.review.nodes : [];
    const stages = STAGES.map(id=>{
      const review=latest(id), state=project?.stages?.[id]?.status;
      const evidence=nodes.filter(n=>nodeStage(n.id)===id);
      let label='待推进';
      if(state==='stale')label='需更新';
      else if(review?.status==='awaiting_choice')label='待选择';
      else if(review?.status==='selected')label='已选择 · 可接续';
      else if(['queued','processing'].includes(review?.status))label='柯大侠处理中';
      else if(review?.response || evidence.length)label='已有依据 · 待审阅';
      else if(id==='calculation' && realCalculationDelivered && state==='submitted')label='真实计算结果已交付 · 待审核';
      else if(id==='requirements')label=project?.stages?.requirements?.payload?.taskbook?'任务书已采用':'可提交任务书';
      else if(state==='confirmed')label='阶段记录已确认';
      else if(state==='returned')label='需修订';
      return {id,title:TITLES[id],label,approvalStatus:state||'draft',reviews:reviews.filter(r=>reviewStage(r)===id),evidence};
    });
    const selected=known.find(r=>reviewStage(r)==='selection' && r.status==='selected');
    const selectedOption=selected?.response?.options?.find(o=>o.id===selected.choice);
    const unclassified=reviews.filter(r=>!reviewStage(r));
    const focus=needsChoice[0] ? reviewStage(needsChoice[0])||'overview' : processing[0] ? reviewStage(processing[0])||'overview' : known[0] ? reviewStage(known[0]) : 'overview';
    return {
      stages, focus, unclassified, needsChoice, processing, currentDelivery, realCalculationDelivered,
      currentProposal: selectedOption?.name || (selected?.response?.summary) || (currentDelivery ? '已有同版方案评审稿' : '尚无已归类的工艺选择'),
      decisionSummary: needsChoice.length ? `${needsChoice.length} 项提议待你选择` : '暂无待选择提议',
      nextSummary: needsChoice.length ? '审阅建议并选择，决定将保存到项目。' : processing.length ? '柯大侠处理已提交的任务，完成后回写到这里。' : currentDelivery ? '审阅同版方案、计算依据和设备待核项，柯大侠接续工程核对。' : selected ? '柯大侠根据所选工艺细化流程与计算依据。' : '提交现有任务书或需求，发起工艺推荐。',
      nextOwner: needsChoice.length ? '客户 / 工程负责人' : currentDelivery ? '工程负责人 / 柯大侠' : processing.length || selected ? '柯大侠' : '资料录入者',
      deliveryMessage: currentDelivery ? '三份评审稿引用同一数据快照；设备待核项保留。' : delivery?.ok ? '依据已变化，当前旧稿停止下载。' : '尚无可下载的同版评审稿。',
    };
  }
  function validateBundle(bundle, project) {
    const ids=['technical-proposal','calculation-book','equipment-parameters'];
    if(!bundle?.ok || !bundle.review || !Array.isArray(bundle.documents))throw Error('评审文件响应不完整。');
    if(bundle.review.project_id!==project.project_id || bundle.review.project_revision!==project.revision)throw Error('项目版本已变化，请刷新后重新下载。');
    if(bundle.review.status!=='local_review_snapshot')throw Error('依据已变化，旧稿停止下载。');
    if(!/^[a-f0-9]{64}$/i.test(bundle.review.snapshot_sha256||''))throw Error('评审快照标识无效。');
    if(bundle.documents.length!==3 || ids.some(id=>bundle.documents.filter(d=>d.id===id).length!==1))throw Error('三份评审稿尚未齐备。');
    for(const d of bundle.documents)if(d.snapshot_sha256!==bundle.review.snapshot_sha256 || typeof d.content!=='string' || !d.content || !/^[a-f0-9]{64}$/i.test(d.sha256||''))throw Error('三份文件版本或内容校验信息不一致。');
    return bundle;
  }
  return Object.freeze({STAGES,TITLES,reviewStage,nodeStage,isRealEngineCalculation,stageRecordPresent,documentDeliverables,deriveWorkflowView,validateBundle});
});
