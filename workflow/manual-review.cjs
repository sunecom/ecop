'use strict';
const {randomUUID,createHash}=require('node:crypto');
function fail(message,status=400){const e=new Error(message);e.taskbookStatus=status;throw e;}
function setup(store){require("./taskbook-service.cjs").setup(store);store.database.exec(`CREATE TABLE IF NOT EXISTS manual_reviews(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES workflow_projects(project_id), source_json TEXT NOT NULL, source_hash TEXT NOT NULL, status TEXT NOT NULL, request_note TEXT NOT NULL, response_json TEXT, choice TEXT, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);}
function source(store,p){
 const row=store.database.prepare('SELECT id,sha256,report_json,filename FROM taskbooks WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(p.project_id);
 const data=row?{kind:'taskbook',id:row.id,sha256:row.sha256,filename:row.filename,report:JSON.parse(row.report_json)}:{kind:'project_requirements',payload:p.stages.requirements.payload};
 const fields=data.report?.fields||data.payload?.fields||[];
 if(!fields.some(f=>f.value!==null&&f.value!==undefined&&f.value!==''))fail('请先上传任务书，或选择已有需求资料的项目。');
 const json=JSON.stringify({project_revision:p.revision,data});
 return {json,hash:createHash('sha256').update(json).digest('hex')};
}
function view(row,currentHash){return {...row,source_json:undefined,response_json:undefined,source:JSON.parse(row.source_json),response:row.response_json?JSON.parse(row.response_json):null,stale:currentHash!==row.source_hash};}
function handle({store,actorId,projectId,method,operation,body}){
 setup(store);const p=store.readProject(projectId,actorId).project;
 let current;try{current=source(store,p);}catch(e){if(method!=='GET')throw e;current={hash:null};}
 if(method==='GET')return {ok:true,reviews:store.database.prepare('SELECT * FROM manual_reviews WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(projectId).map(r=>view(r,current.hash))};
 const member=p.members.find(m=>m.user_id===actorId);
 if(p.frozen||store.isReadOnlyPrivateProject(projectId)||!['customer','engineer'].includes(member?.role))fail('当前身份或项目状态不允许提交。',403);
 if(body.expected_revision!==p.revision)fail('项目已变化，请刷新后再提交。',409);
 if(operation==='manual-review'){
  const note=body.note||'';if(typeof note!=='string'||note.length>2000)fail('说明请控制在2000字以内。');
  const existing=store.database.prepare("SELECT * FROM manual_reviews WHERE project_id=? AND source_hash=? AND status IN ('queued','processing','awaiting_choice') ORDER BY created_at DESC LIMIT 1").get(projectId,current.hash);
  if(existing)return {ok:true,review:view(existing,current.hash)};
  const id=randomUUID(),now=new Date().toISOString();
  store.database.prepare('INSERT INTO manual_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,current.json,current.hash,'queued',note,null,null,actorId,now,now);
  return {ok:true,review:view(store.database.prepare('SELECT * FROM manual_reviews WHERE id=?').get(id),current.hash)};
 }
 const row=store.database.prepare('SELECT * FROM manual_reviews WHERE id=? AND project_id=?').get(body.id,projectId);
 if(!row)fail('未找到该任务。',404);
 if(row.source_hash!==current.hash)fail('任务依据已变化，请重新发起工艺推荐。',409);
 if(operation==='manual-review-choice'){
  if(row.status==='selected'&&row.choice===body.choice)return {ok:true,review:view(row,current.hash)};
  if(row.status!=='awaiting_choice')fail('此任务尚无可确认方案。',409);
  if(!JSON.parse(row.response_json).options.some(o=>o.id===body.choice))fail('请选择本次推荐中的方案。');
  store.database.prepare("UPDATE manual_reviews SET status='selected',choice=?,actor_id=?,updated_at=? WHERE id=?").run(body.choice,actorId,new Date().toISOString(),row.id);
  return {ok:true,review:view(store.database.prepare('SELECT * FROM manual_reviews WHERE id=?').get(row.id),current.hash)};
 }
 fail('任务操作不存在。',404);
}
// Operator-only delivery path, intentionally not exposed as an HTTP action.
function deliver(store,id,response){
 setup(store);const row=store.database.prepare('SELECT * FROM manual_reviews WHERE id=?').get(id);if(!row)fail('未找到任务。',404);
 if(!['queued','processing'].includes(row.status))fail('该任务已交付，不允许覆盖。',409);
 const p=store.readProject(row.project_id,row.actor_id).project;
 if(p.frozen||source(store,p).hash!==row.source_hash)fail('依据已变化，不能交付旧任务。',409);
 if(typeof response.summary!=='string'||!response.summary.trim()||!Array.isArray(response.options)||!response.options.length||response.options.length>3)fail('交付缺少摘要或候选方案。');
 const ids=new Set();for(const o of response.options){if(['id','name','reason','boundary'].some(k=>typeof o[k]!=='string'||!o[k].trim())||ids.has(o.id))fail('候选方案不完整。');ids.add(o.id);}
 store.database.prepare("UPDATE manual_reviews SET response_json=?,status='awaiting_choice',updated_at=? WHERE id=?").run(JSON.stringify(response),new Date().toISOString(),id);
}
module.exports={handle,deliver,setup};
