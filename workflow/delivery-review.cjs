'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {evaluate}=require('./evidence-snapshot.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function canonical(v){return Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);}
function bindingHash(project){return sha(canonical({project_id:project.project_id,revision:project.revision,requirements:project.stages.requirements,selection:project.stages.selection,pfd:project.stages.pfd}));}
function fail(code,message,status=409){const e=new Error(message);e.deliveryStatus=status;e.code=code;throw e;}
function escape(v){return String(v).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));}
const STATE={recorded_scope_only:'已记录依据及适用范围',unvalidated:'模型假设，待验证',numerical_evidence_only:'计算证据与数值复核',pending:'设备适配待核',draft_not_issued:'草稿，未签发'};
const TERMS={separator1:'一效分离汽',separator2:'二效分离汽',separator3:'三效分离汽',effect1_heating:'一效加热侧',effect2_heating:'二效加热侧',effect3_heating:'三效加热侧',compressor_suction:'压缩机吸口',compressor_discharge_after_injection:'压缩机后喷水出口',PASS_numerical_provenance_only:'数值与版本复核通过，未作设备放行'};
function display(v){if(typeof v==='number')return Number.isInteger(v)?String(v):v.toLocaleString('zh-CN',{maximumFractionDigits:4,useGrouping:false});if(typeof v==='boolean')return v?'是':'否';if(Array.isArray(v))return v.map(x=>Array.isArray(x)?x.map(display).join(' → '):display(x)).join('；');return TERMS[v]||String(v??'未提供');}
const REPORTS=[
 {id:'technical-proposal',title:'技术方案评审草稿',nodes:['basis','temperature','assumptions','network','equipment']},
 {id:'calculation-book',title:'计算依据与结果草稿',nodes:['basis','assumptions','numerical-audit','native-67','native-68','network']},
 {id:'equipment-parameters',title:'设备选型参数核对草稿',nodes:['supplier','native-68','network','equipment']},
];
function reportHtml(review,report){
 const nodes=report.nodes.map(id=>review.nodes.find(n=>n.id===id)).filter(Boolean);
 const sections=nodes.map(n=>`<section><h2>${escape(n.label)}</h2><p class="state">${escape(STATE[n.review_state]||'待核对')}</p><p>${escape(n.scope||'')}</p>${n.values.length?`<div class="table-wrap"><table><thead><tr><th>项目</th><th>数值或内容</th><th>单位</th></tr></thead><tbody>${n.values.map(v=>`<tr><td>${escape(v.label)}</td><td>${escape(display(v.value))}</td><td>${escape(v.unit||'—')}</td></tr>`).join('')}</tbody></table></div>`:''}</section>`).join('');
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(report.title)}</title><style>body{margin:0;background:#f5f6f2;color:#1c322d;font:18px/1.65 'Microsoft YaHei',sans-serif}main{max-width:1200px;margin:auto;padding:32px 5vw}h1{font-size:32px;margin:0 0 12px}h2{font-size:23px}section{background:white;border:1px solid #d3ddd4;border-radius:12px;margin:24px 0;padding:24px}.state,.notice{background:#fff1d8;color:#624414;padding:10px 14px;border-radius:6px}.meta{font-size:14px;color:#546961;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;text-align:left}td,th{border-bottom:1px solid #dde4df;padding:12px;vertical-align:top;overflow-wrap:anywhere}th{background:#edf2ec}.table-wrap{overflow:auto}@media(max-width:600px){main{padding:20px 12px}section{padding:15px}h1{font-size:26px}td,th{padding:8px;font-size:16px}}@media print{body{background:white}main{padding:0}section{break-inside:avoid;border:0;border-top:1px solid #ccd5cf}h2{break-after:avoid}}</style></head><body><main><h1>${escape(report.title)}</h1><p>${escape(review.title)}</p><p class="notice">条件计算与设备核对草稿 · 尚未工程签发。计算成功不代表设备已定型，暂不作稳定零补汽承诺。</p><p>本稿引用已有真实执行证据，本次查看不重新运行工程软件。客户料液物性与设备适配的待核边界保留在各节。</p><p class="meta">项目版本 ${review.project_revision} · 数据快照 ${escape(review.snapshot_id)}<br>同版校验 ${review.snapshot_sha256}</p>${sections}<section><h2>审阅后的接续</h2><p>逐项确认入口调质与液滴控制、后喷水可调范围、回热设备几何及水力。计算依据变化后先复算关联结果，再形成新版本。当前草稿不包含最终设备型号批准、价格或合同性能保证。</p></section></main></body></html>`;
}
function publicReview(snapshot,project){
 const review={project_id:project.project_id,project_revision:project.revision,title:project.title,evidence_project_id:snapshot.project_id,snapshot_id:snapshot.snapshot_id,
   status:snapshot.status,engineering_release:false,customer_review_ready:false,
   sources:snapshot.sources.map(s=>({id:s.id,status:s.status,sha256:s.sha256})),
   nodes:snapshot.nodes.map(n=>({...n,reasons:n.reasons.map(r=>({code:r.code,...(r.id?{id:r.id}:{})}))}))};
 review.snapshot_sha256=sha(canonical(review));return review;
}
class DeliveryReviewCatalog{
 constructor(bindings=[]){this.bindings=new Map();for(const b of bindings){if(!b.project_id||this.bindings.has(b.project_id)||!Number.isInteger(b.project_revision)||b.project_revision<1||!b.evidence_project_id||!b.spec_path||!b.source_root||!/^[a-f0-9]{64}$/i.test(b.spec_sha256||'')||!/^[a-f0-9]{64}$/i.test(b.project_input_sha256||''))throw Error('INVALID_DELIVERY_BINDING');this.bindings.set(b.project_id,Object.freeze({...b}));}}
 has(projectId){return this.bindings.has(projectId);}
 load(project){
  const b=this.bindings.get(project.project_id);if(!b)fail('DELIVERY_NOT_FOUND','当前项目尚无关联的评审草稿。',404);
  if(project.revision!==b.project_revision||bindingHash(project)!==b.project_input_sha256)fail('DELIVERY_PROJECT_CHANGED','项目依据已变化，请复核后生成新版本草稿。');
  let bytes;try{bytes=fs.readFileSync(b.spec_path);}catch{fail('DELIVERY_SOURCE_UNAVAILABLE','评审依据当前不可读取。');}
  if(sha(bytes)!==b.spec_sha256)fail('DELIVERY_SPEC_CHANGED','评审清单已变化，需要重新核对。');
  let spec;try{spec=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{fail('DELIVERY_SPEC_INVALID','评审清单格式无效。');}
  if(spec.project_id!==b.evidence_project_id)fail('DELIVERY_CASE_MISMATCH','项目与案例证据不匹配。');
  let snapshot;try{snapshot=evaluate(spec,b.source_root);}catch{fail('DELIVERY_EVIDENCE_INVALID','评审依据结构或路径无效。');}
  const review=publicReview(snapshot,project);
  if(snapshot.status!=='local_review_snapshot')return {ok:true,review,documents:[]};
  // Required business nodes protect against accidentally publishing an empty package.
  for(const id of new Set(REPORTS.flatMap(r=>r.nodes)))if(!review.nodes.some(n=>n.id===id))fail('DELIVERY_INCOMPLETE','评审草稿缺少必要章节。');
  const documents=REPORTS.map(r=>{const content=reportHtml(review,r);return {id:r.id,title:r.title,file_name:r.id+'-review.html',content_type:'text/html; charset=utf-8',snapshot_sha256:review.snapshot_sha256,sha256:sha(content),content};});
  return {ok:true,review,documents};
 }
}
module.exports={DeliveryReviewCatalog,bindingHash,reportHtml};
