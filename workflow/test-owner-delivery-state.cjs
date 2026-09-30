'use strict';
// Executes the actual candidate load function with synthetic responses.
// No browser, production request, project mutation or engineering data.
const fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
const candidate=process.argv[2]||__dirname;
if(!candidate)throw Error('candidate directory required');
const code=fs.readFileSync(path.join(candidate,'workspace-ui.js'),'utf8');
const marker='root.ECOPWorkspaceUI={';
if(!code.includes(marker))throw Error('Missing explicit instrumentation marker');
const instrumented=code.replace(marker,`draw=()=>{};
root.__qa={load:async c=>{context=c;await load(true);},state:()=>({errors,states,reviewDrafts,reviewDraftsError,history:typeof deliveryHistoryNote==='undefined'?'':deliveryHistoryNote}),reset};
${marker}`);
const stale=()=>({ok:false,error:{code:'DELIVERY_PROJECT_CHANGED',message:'项目依据已变化，请复核后生成新版本草稿。'}});
const current=(id='synthetic-A',revision=74)=>({ok:true,review_drafts:{project_id:id,project_revision:revision,documents:[{id:'scheme'}]}});
const sandbox=()=>{
 const s={AbortController,ECOPWorkflowView:{validateBundle(){}},fetch:async u=>({ok:true,status:200,json:async()=>String(u).endsWith('manual-review')?{ok:true,reviews:[]}:{ok:true,advisories:[]}})};
 vm.runInNewContext(instrumented,s,{timeout:1000});return s.__qa;
};
const context=(old,now,id='synthetic-A',revision=74)=>({project:{project_id:id,revision,delivery_review_available:true},role:'customer',config:{},adapter:{getDeliveryReview:async()=>old,listReviewDrafts:async()=>now}});
const checks=[];
async function run(name,old,now,expected){const q=sandbox();await q.load(context(old,now));const actual=q.state();checks.push({name,pass:Boolean(expected(actual)),actual});}
(async()=>{
 await run('legacy_409_current_200_is_historical_not_global',stale(),current(),s=>!s.errors.delivery&&s.history.includes('历史')&&s.states.delivery!=='loaded'&&s.reviewDrafts?.length===1&&!s.reviewDraftsError);
 await run('current_409_remains_current_failure',null,stale(),s=>Boolean(s.reviewDraftsError)&&s.reviewDrafts===null);
 await run('current_wrong_project_not_accepted',null,current('synthetic-other'),s=>Boolean(s.reviewDraftsError)&&s.reviewDrafts===null);
 await run('current_wrong_revision_not_accepted',null,current('synthetic-A',73),s=>Boolean(s.reviewDraftsError)&&s.reviewDrafts===null);
 await run('current_forbidden_remains_failure',null,{ok:false,error:{code:'FORBIDDEN',message:'当前账号没有权限。'}},s=>Boolean(s.reviewDraftsError||s.errors.auth)&&s.reviewDrafts===null);
 await run('current_network_error_remains_failure',null,{ok:false,error:{code:'NETWORK_ERROR',message:'网络请求未完成。'}},s=>Boolean(s.reviewDraftsError)&&s.reviewDrafts===null);
 for(const [name,value] of [['wrong_project',current('synthetic-other')],['wrong_revision',current('synthetic-A',73)],['invalid_shape',{ok:true}],['forbidden',{ok:false,error:{code:'FORBIDDEN',message:'当前账号没有权限。'}}]]){
  await run('legacy_409_current_'+name+'_cannot_claim_available',stale(),value,s=>!s.history&&Boolean(s.errors.delivery||s.errors.auth)&&Boolean(s.reviewDraftsError||s.errors.auth)&&s.reviewDrafts===null);
 }
 await run('legacy_forbidden_not_silenced', {ok:false,error:{code:'FORBIDDEN',message:'当前账号没有权限。'}},current(),s=>Boolean(s.errors.auth)&&s.reviewDrafts===null);
 const q=sandbox();let resolveOld;const pending=new Promise(r=>resolveOld=r);
 const earlier=q.load(context(pending,current()));
 await q.load(context(null,current('synthetic-B',1),'synthetic-B',1));resolveOld(stale());await earlier;
 const final=q.state();checks.push({name:'late_earlier_project_ignored',pass:!final.errors.delivery&&!final.history&&final.reviewDrafts?.length===1&&!final.reviewDraftsError,actual:final});
 const result={type:'NODE_ACTUAL_LOAD_SYNTHETIC_CONTRACT_NOT_BROWSER',candidate,checks,failed:checks.filter(x=>!x.pass).map(x=>x.name)};
 console.log(JSON.stringify(result,null,2));if(result.failed.length)process.exitCode=1;
})();
