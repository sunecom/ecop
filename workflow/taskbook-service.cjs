'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const schema=require('./requirements-schema.js');
function setup(store){store.database.exec(`CREATE TABLE IF NOT EXISTS taskbooks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES workflow_projects(project_id),actor_id TEXT NOT NULL,filename TEXT NOT NULL,sha256 TEXT NOT NULL,original BLOB NOT NULL,report_json TEXT NOT NULL,base_revision INTEGER NOT NULL,created_at TEXT NOT NULL)`);}
function fail(message,status=400){const e=new Error(message);e.taskbookStatus=status;throw e;}
function access(store,projectId,actorId,write=false){
 const p=store.readProject(projectId,actorId).project;
 const m=p.members.find(x=>x.user_id===actorId);
 if(write&&(p.frozen||!['customer','engineer'].includes(m?.role)))fail('当前身份或项目状态不允许上传/采用任务书。',403);
 if(write&&!['customer_entered','customer_source'].includes(p.data_provenance?.kind))fail('请选择真实业务项目。',403);
 if(store.isReadOnlyPrivateProject(projectId)&&write)fail('来源资料项目只读，请创建业务工作副本。',403);
 return p;
}
async function parse(buffer){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.env.ECOP_TASKBOOK_PYTHON||'python3',['-X','utf8',path.join(__dirname,'taskbook-parser.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let output='',finished=false;const timer=setTimeout(()=>{child.kill();reject(new Error('任务书解析超时。'));},12000);
  child.on('error',e=>{clearTimeout(timer);reject(new Error('任务书解析器不可用。'));});
  child.stdout.on('data',b=>{output+=b;if(output.length>600000){child.kill();reject(new Error('提取内容超限。'));}});
  child.stderr.resume();child.stdin.on('error',()=>{});
  child.on('close',()=>{clearTimeout(timer);try{const r=JSON.parse(output);if(!r.ok)reject(new Error(r.error));else resolve(r.report);}catch(e){reject(new Error('任务书无法解析，请检查文件格式。'));}});
  child.stdin.end(buffer);
 });
}
function summarize(row){return {id:row.id,filename:row.filename,sha256:row.sha256,actor_id:row.actor_id,base_revision:row.base_revision,created_at:row.created_at,report:JSON.parse(row.report_json)};}
function get(store,projectId,id){const row=store.database.prepare('SELECT * FROM taskbooks WHERE id=? AND project_id=?').get(id,projectId);if(!row)fail('任务书不存在。',404);return row;}
function payload(row,project){
 const report=JSON.parse(row.report_json), by=new Map(report.fields.map(x=>[x.target_field,x]));
 const name=by.get('project_name')?.value;
 if(typeof name!=='string'||!name.trim()||name.length>120)fail('请填写不超过120字的项目名称。');
 const result=schema.createRequirementsPayload(name);
 result.fields=report.fields.filter(f=>f.target_field.startsWith('requirements.')).map(f=>({
  target_field:f.target_field,label:f.label,value:f.value,unit:f.unit,value_basis:f.value_basis,confirmed:false,
  source_status:'source_reported',source_snapshot_value:f.value,source_snapshot_unit:f.unit,source_reference:{...f.source_reference,taskbook_id:row.id,sha256:row.sha256},
 }));
 result.taskbook={id:row.id,sha256:row.sha256,filename:row.filename,blocking_count:report.blocking_count};
 return result;
}
async function handle({store,actorId,projectId,method,operation,body}){
 setup(store);const p=access(store,projectId,actorId,method==='POST');
 if(method==='GET'&&operation.startsWith('taskbooks/analyze/')){
  const row=get(store,projectId,operation.split('/')[2]);
  return {ok:true,context:require('./agent-context.cjs').buildContext(p,row)};
 }
 if(method==='GET'&&operation==='taskbooks')return {ok:true,taskbooks:store.database.prepare('SELECT id,filename,sha256,actor_id,base_revision,created_at,report_json FROM taskbooks WHERE project_id=? ORDER BY created_at DESC LIMIT 30').all(projectId).map(summarize),current_id:p.stages.requirements.payload?.taskbook?.id||null};
 if(method==='GET'&&operation.startsWith('taskbooks/file/'))return {file:get(store,projectId,operation.split('/')[2])};
 if(method==='POST'&&operation==='taskbooks'){
  if(body.expected_revision!==p.revision)fail('项目版本已变化，请刷新后重新上传。',409);
  if(typeof body.filename!=='string'||!body.filename.toLowerCase().endsWith('.xlsx')||body.filename.length>160)fail('只支持 .xlsx 任务书。');
  if(typeof body.content!=='string'||!body.content.length||body.content.length>410000||! /^[A-Za-z0-9+/]*={0,2}$/.test(body.content))fail('文件编码或大小无效。');
  const buffer=Buffer.from(body.content,'base64');if(buffer.toString('base64')!==body.content)fail('文件编码无效。');
  let report;try{report=await parse(buffer);}catch(e){fail(e.message);}
  if(access(store,projectId,actorId,true).revision!==p.revision)fail('解析期间项目发生变更，请重新上传。',409);
  const prev=store.database.prepare('SELECT report_json FROM taskbooks WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(projectId);
  const old=new Map((prev?JSON.parse(prev.report_json).fields:[]).map(f=>[f.target_field,f]));
  report.changes=report.fields.filter(f=>{const v=old.get(f.target_field);return !v||['value','unit','value_basis','data_status'].some(k=>JSON.stringify(v[k])!==JSON.stringify(f[k]));}).map(f=>({field:f.target_field,label:f.label,before:old.get(f.target_field)||null,after:f}));
  const id=randomUUID(),sha=createHash('sha256').update(buffer).digest('hex');
  store.database.prepare('INSERT INTO taskbooks VALUES(?,?,?,?,?,?,?,?,?)').run(id,projectId,actorId,body.filename,sha,buffer,JSON.stringify(report),p.revision,new Date().toISOString());
  return {ok:true,taskbook:summarize(get(store,projectId,id))};
 }
 if(method==='POST'&&operation==='taskbooks-apply'){
  const row=get(store,projectId,body.id);
  if(row.base_revision!==p.revision||body.expected_revision!==p.revision)fail('项目版本已变化，请重新上传任务书，避免覆盖他人修改。',409);
  const report=JSON.parse(row.report_json);
  if(report.blocking_count)fail('请先修订任务书并关闭阻断问题，再确认采用。',409);
  const input=payload(row,p);
  return store.action(actorId,{project_id:projectId,action_id:'taskbook-'+row.id,expected_revision:p.revision,stage_id:'requirements',type:'edit',payload:input},input.taskbook);
 }
 fail('任务书接口不存在。',404);
}
module.exports={handle,setup,parse,payload};
