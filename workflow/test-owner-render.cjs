'use strict';
// Synthetic text-node rendering only; this is not a browser/visual acceptance.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const candidate=process.argv[2]||__dirname,base=__dirname;
class Node {
 constructor(tag){this.tag=tag;this.children=[];this._text='';this.attributes={};this.hidden=false;this.disabled=false;this.open=false;this.queries=new Map();}
 set textContent(v){this._text=String(v);this.children=[];}
 get textContent(){return this._text+this.children.map(c=>typeof c==='string'?c:c.textContent).join('\n');}
 set innerHTML(v){throw Error('Unexpected dynamic HTML: '+v);}
 append(...c){this.children.push(...c);for(const n of c)if(typeof n==='object')n.parentNode=this;}
 appendChild(c){this.append(c);return c;}
 replaceChildren(...c){this._text='';this.children=[];this.append(...c);}
 setAttribute(k,v){this.attributes[k]=String(v);}
 removeAttribute(k){delete this.attributes[k];}
 addEventListener(){}
 querySelector(q){if(!this.queries.has(q))this.queries.set(q,new Node('query'));return this.queries.get(q);}
 insertBefore(n,b){const i=this.children.indexOf(b);if(i<0)this.append(n);else this.children.splice(i,0,n);n.parentNode=this;}
 remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);}
}
const nodes=new Map();const byId=id=>{if(!nodes.has(id))nodes.set(id,new Node('div'));return nodes.get(id);};
const front=require(fs.existsSync(path.join(candidate,'workflow-view.js'))?path.resolve(candidate,'workflow-view.js'):path.join(base,'workflow-view.js'));
const document={getElementById:byId,createElement:t=>new Node(t)};
const s={document,AbortController,ECOPWorkflowView:front,fetch:async u=>({ok:true,status:200,json:async()=>String(u).endsWith('manual-review')?{ok:true,reviews:[]}:{ok:true,advisories:[]}})};
let code=fs.readFileSync(path.join(candidate,'workspace-ui.js'),'utf8');
code=code.replace('root.ECOPWorkspaceUI={',`const qaDraw=draw;draw=()=>{};
root.__qaRender=async c=>{reset();context=c;activeView='documents';await load(true);qaDraw();};root.ECOPWorkspaceUI={`);
vm.runInNewContext(code,s,{timeout:1000});
const stages=Object.fromEntries(front.STAGES.map(id=>[id,{id,status:'confirmed',revision:1,payload:{},depends_on:[]} ]));
const p={project_id:'synthetic-owner-test',revision:74,title:'Synthetic review handoff',stages,delivery_review_available:true};
const catalog={ok:true,review_drafts:{project_id:p.project_id,project_revision:74,documents:['scheme','calculation','equipment'].map(id=>({id,label:id,name:id+'.docx',sha256:'a'.repeat(64),bytes:100}))}};
const c={project:p,role:'customer',business:true,config:{},onStage(){},adapter:{getDeliveryReview:async()=>({ok:false,error:{code:'DELIVERY_PROJECT_CHANGED',message:'项目依据已变化，请复核后生成新版本草稿。'}}),listReviewDrafts:async()=>catalog}};
const walk=n=>[n,...n.children.filter(x=>typeof x==='object').flatMap(walk)];
(async()=>{
 await s.__qaRender(c);
 const main=byId('workspace-business-content'),text=main.textContent;
 const nav=front.STAGES.map(id=>byId('stage-nav').querySelector(`[data-stage-id="${id}"]`).querySelector('.step-sub').textContent);
 const checks=[
  {name:'owner_next_action_explained',pass:/业主|客户/.test(text)&&/审阅/.test(text)&&/评论|修改意见/.test(text)},
  {name:'shared_approval_labels_identified',pass:nav.every(x=>/审核/.test(x)),labels:nav},
  {name:'three_current_download_buttons_enabled',pass:walk(main).filter(n=>n.tag==='button'&&n.textContent==='下载'&&!n.disabled).length===3},
  {name:'legacy_error_not_global',pass:!main.children.some(n=>n.className==='work-error'&&n.textContent.includes('项目依据已变化'))},
  {name:'no_owner_acceptance_claim',pass:!text.includes('业主已确认')&&!text.replace('不代表业主已接受方案','').includes('业主已接受')},
  {name:'stage_states_unchanged',pass:front.STAGES.every(id=>p.stages[id].status==='confirmed')},
 ];
 const legacy=walk(main).find(n=>n.className==='work-card legacy-review-section');
 checks.push({name:'old_download_group_collapsed_after_current_files',pass:legacy?.tag==='details'&&!legacy.open&&main.children.indexOf(legacy)>main.children.findIndex(n=>n.className==='work-card review-drafts-section')});
 const app=fs.readFileSync(path.join(candidate,'app.js'),'utf8');
 const start=app.indexOf('    const showReturnReason =');const end=app.indexOf('    refs.stageRevision.textContent',start);
 if(start<0||end<start){checks.push({name:'return_history_render_block_present',pass:false});}
 else {
  const parent=new Node('section'), reason=new Node('p');parent.append(reason);
  const doc={createElement:t=>new Node(t),getElementById:id=>parent.children.find(n=>n.id===id)||null};
  for(const state of ['confirmed','returned','draft']){
   vm.runInNewContext(app.slice(start,end),{refs:{returnReasonDisplay:reason},document:doc,byId:id=>doc.getElementById(id),stage:{status:state,last_return_reason:'literal <script>marker</script>'},businessMode:true});
   const h=doc.getElementById('stage-return-history');
   checks.push({name:'return_reason_'+state,pass:state==='returned'?(!reason.hidden&&reason.textContent.startsWith('待修改理由')&&h.hidden):(reason.hidden&&!h.hidden&&!h.open&&h.textContent.includes('literal <script>marker</script>')&&(state!=='confirmed'||h.textContent.includes('后续已重新审核')))});
  }
 }
 const result={type:'SYNTHETIC_TEXT_NODE_RENDER_NOT_BROWSER',candidate,checks,failed:checks.filter(x=>!x.pass).map(x=>x.name)};
 console.log(JSON.stringify(result,null,2));if(result.failed.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
