(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ECOPWorkflowView = factory();
})(globalThis, function() {
  'use strict';
  const STAGES = ['requirements', 'selection', 'pfd', 'calculation', 'equipment', 'documents'];
  const TITLES = {requirements:'需求与任务书',selection:'工艺选择',pfd:'流程与参数',calculation:'工程计算',equipment:'设备与运行',documents:'方案与文件'};
  const NODE_STAGE = {basis:'requirements',temperature:'pfd',assumptions:'pfd',network:'calculation','numerical-audit':'calculation',supplier:'equipment',equipment:'equipment',documents:'documents'};
  function reviewStage(review) {
    return STAGES.includes(review?.response?.workflow_stage) ? review.response.workflow_stage : null;
  }
  function nodeStage(id) {return NODE_STAGE[id] || (/^native-/.test(id || '') ? 'calculation' : null);}
  function deriveWorkflowView({project, manualReviews=[], deliveryReview=null, requestStates={}}={}) {
    const reviews = requestStates.reviews === 'error' ? [] : manualReviews.filter(r=>r && typeof r.id==='string');
    const delivery = requestStates.delivery === 'error' ? null : deliveryReview;
    const currentDelivery = Boolean(delivery?.ok && delivery.review?.status==='local_review_snapshot' && delivery.review.project_id===project?.project_id && delivery.review.project_revision===project?.revision);
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
      stages, focus, unclassified, needsChoice, processing, currentDelivery,
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
  return Object.freeze({STAGES,TITLES,reviewStage,nodeStage,deriveWorkflowView,validateBundle});
});
