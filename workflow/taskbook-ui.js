(function(){
 'use strict';
 const panel=()=>document.getElementById('taskbook-panel');let context=null,key='',records=[],selected=null,busy=false,requestSerial=0,messageText='';
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 function url(op){return `${context.config.basePath||''}/api/workflow/projects/${encodeURIComponent(context.project.project_id)}/${op}`;}
 async function request(op,body,c=context){
 const headers={Accept:'application/json'};if(body){headers['Content-Type']='application/json';if(c.config.csrfToken)headers['X-Demo-Token']=c.config.csrfToken;}
 const endpoint=`${c.config.basePath||''}/api/workflow/projects/${encodeURIComponent(c.project.project_id)}/${op}`;
 const r=await fetch(endpoint,{method:body?'POST':'GET',headers,credentials:'same-origin',...(body?{body:JSON.stringify(body)}:{})});
 let data;try{data=await r.json();}catch{throw Error('任务书响应格式不正确，请重试。');}
 if(!r.ok||!data||data.ok!==true){const e=Error(r.status===401?'登录已失效。':r.status===403?'当前账号没有权限。':data?.error?.message||'请求失败。');e.status=r.status;throw e;}return data;
 }
 function button(text,fn,disabled=false){const b=el('button',text,'button button-secondary');b.type='button';b.disabled=disabled;b.onclick=fn;return b;}
 function validTaskbook(r){return r&&typeof r.id==='string'&&typeof r.filename==='string'&&r.report&&Array.isArray(r.report.fields)&&Array.isArray(r.report.issues)&&Number.isInteger(r.report.blocking_count);}
 function feedback(text){messageText=text;const p=document.getElementById('taskbook-message');if(p)p.textContent=text;}
 function downloadReport(){const rows=[['级别','位置','字段','问题','影响步骤'],...selected.report.issues.map(i=>[i.severity==='error'?'需修订':'待补充',`${i.sheet}!${i.cell}`,i.field,i.message,i.impact])];const csv='\uFEFF'+rows.map(row=>row.map(x=>'"'+String(x).replace(/^[=+@-]/,"'").replaceAll('"','""')+'"').join(',')).join('\r\n');const a=el('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download='任务书校对问题.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
 function draw(){
 if(!context?.active)return;const p=panel();p.replaceChildren();
 p.append(el('h2','提交蒸发系统设计任务书'),el('p','下载 Excel 模板填写并上传。系统保留原件、提取内容与每次修订记录；请修改 Excel 后重新提交。'));
 const toolbar=el('div',undefined,'taskbook-toolbar');const a=el('a','下载空白任务书','button button-secondary');a.href=`${context.config.basePath||''}/taskbook-template.xlsx`;a.download='ECOP蒸发系统任务书模板.xlsx';toolbar.append(a);
 const file=el('input');file.type='file';file.accept='.xlsx';file.id='taskbook-file';file.setAttribute('aria-label','选择 Excel 任务书');file.disabled=!context.editable||busy;toolbar.append(file);
 toolbar.append(button(busy?'正在提取…':'上传并校对',async()=>{
  const f=file.files[0];if(!f)return feedback('请选择 .xlsx 文件。');if(f.size>300*1024)return feedback('文件上限 300 KiB，请去除图片与嵌入附件。');
  if(busy)return;busy=true;const startKey=key,c=context,serial=requestSerial;const revision=c.project.revision;draw();feedback('正在上传并进行服务端校对…');
  try{const bytes=new Uint8Array(await f.arrayBuffer());let s='';for(let i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);if(key!==startKey||serial!==requestSerial)return;const r=await request('taskbooks',{filename:f.name,content:btoa(s),expected_revision:revision},c);if(key!==startKey||serial!==requestSerial)return;if(!validTaskbook(r.taskbook))throw Error('任务书提取响应不完整，请刷新核对。');records.unshift(r.taskbook);selected=r.taskbook;c.onChanged?.();draw();feedback('提取完成。请查看下方问题并修订原任务书。');}catch(e){if(serial===requestSerial)feedback(e.message);}finally{if(serial===requestSerial){busy=false;draw();}}
 },!context.editable||busy));p.append(toolbar);
 p.append(el('p','仅支持标准 .xlsx，最大 300 KiB；不接受宏、公式、外部链接。附件在任务书中登记索引。','taskbook-hint'));
 const message=el('p',messageText,'taskbook-message');message.id='taskbook-message';message.setAttribute('role','status');p.append(message);
 const current=context.project.stages.requirements.payload?.taskbook;
 p.append(el('p',current?`当前采用：${current.filename}；需求阶段 r${context.project.stages.requirements.revision}`:'尚未采用任务书。上传和校对不会自动修改当前需求版本。','taskbook-current'));
 if(records.length){const label=el('label','任务书上传记录 ');const select=el('select');select.id='taskbook-history';for(const r of records){const o=el('option',`${new Date(r.created_at).toLocaleString('zh-CN')} · ${r.filename}`);o.value=r.id;select.append(o);}select.value=selected?.id||records[0].id;select.onchange=()=>{selected=records.find(r=>r.id===select.value);draw();};label.append(select);p.append(label);}

 if(!selected)return;
 const r=selected.report;p.append(el('h3',`校对结果：${r.blocking_count} 项需修订，${r.issues.length-r.blocking_count} 项待补充/专项复核`));
 const actions=el('div',undefined,'taskbook-toolbar');actions.append(button('下载问题清单',downloadReport));const original=el('a','下载本次原件','button button-secondary');original.href=url('taskbooks/file/'+selected.id);actions.append(original);
 actions.append(button('确认采用此任务书',async()=>{if(busy)return;busy=true;const id=selected.id,c=context,serial=requestSerial;draw();try{await request('taskbooks-apply',{id,expected_revision:c.project.revision},c);if(serial!==requestSerial)return;key='';await c.controller.load();c.onChanged?.();}catch(e){if(serial===requestSerial)feedback(e.message);}finally{if(serial===requestSerial){busy=false;draw();}}},!context.editable||r.blocking_count>0||busy||selected.base_revision!==context.project.revision));p.append(actions);
 if(selected.base_revision!==context.project.revision && current?.id!==selected.id)p.append(el('p','此上传记录基于较早项目版本；如需修订，请以当前版本重新上传。'));
 const issues=el('ul',undefined,'taskbook-issues');for(const i of r.issues){const li=el('li',`${i.severity==='error'?'需修订':'待补充'} · ${i.sheet}!${i.cell} · ${i.message}（影响：${i.impact}）`);li.className=i.severity;issues.append(li);}p.append(issues);
 const details=el('details');details.open=true;details.append(el('summary',`提取内容（${r.fields.length} 项） · 相对上一份上传有 ${r.changes?.length||0} 项变化`));
 const wrap=el('div',undefined,'taskbook-table-wrap');const table=el('table');const head=el('tr');for(const h of ['项目','原始值','单位','状态','位置'])head.append(el('th',h));table.append(head);for(const f of r.fields){const tr=el('tr');for(const v of [f.label,f.raw_value||'待补充',f.unit||'—',f.data_status,`${f.source_reference.sheet}!${f.source_reference.cell}`])tr.append(el('td',v));table.append(tr);}wrap.append(table);details.append(wrap);p.append(details);
 if(r.changes?.length){const d=el('details');d.append(el('summary','查看逐项修订差异'));for(const c of r.changes)d.append(el('p',`${c.label}：${c.before?`${c.before.raw_value||'空'} ${c.before.unit} / ${c.before.data_status}`:'首次提交'} → ${c.after.raw_value||'空'} ${c.after.unit} / ${c.after.data_status}`));p.append(d);}
 if(r.experiments?.length){const d=el('details');d.append(el('summary',`实验原始记录（${r.experiments.length} 行）`));for(const e of r.experiments)d.append(el('p',`${e.sheet}!${e.row}：${e.values.join(' | ')}`));p.append(d);}
 p.append(el('p','系统校对用于检查输入完整性和口径，不替代工程师对物性、实验和计算适用性的审核。','taskbook-hint'));
 }
 function reset(){context=null;key='';records=[];selected=null;busy=false;messageText='';requestSerial++;panel().hidden=true;panel().replaceChildren();}
 async function render(c){
  const next=c.project.project_id+':'+c.project.revision;
  if(next!==key){requestSerial++;records=[];selected=null;busy=false;messageText='';}
  context=c;panel().hidden=!c.active;if(!c.active){if(next!==key)key='';return;}
  if(next===key){draw();return;}key=next;draw();const serial=++requestSerial;
  try{const data=await request('taskbooks',undefined,c);if(serial!==requestSerial||key!==next)return;
   if(!Array.isArray(data.taskbooks)||!data.taskbooks.every(validTaskbook))throw Error('任务书记录格式不正确。');
   records=data.taskbooks;selected=records[0]||null;draw();
  }catch(e){if(serial===requestSerial){records=[];selected=null;feedback(e.message);draw();}}
 }
 window.ECOPTaskbookUI={render,reset};
})();
