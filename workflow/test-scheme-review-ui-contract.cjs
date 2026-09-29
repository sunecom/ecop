'use strict';
// Pure Node contract / text-rendering regression; not browser or visual evidence.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const dir=process.argv[2]||__dirname;
const backend=require(path.join(dir,'calculation-delivery.cjs'));
const front=require(path.join(dir,'workflow-view.js'));
const valid={execution_mode:'real_engine',engine:{name:'Synthetic property engine',version:'test'},
 calculation_method:'engine_properties_explicit_balances',validation_scope:'scheme_review',engineering_release:false,
 evidence:[{kind:'calculation_model',sha256:'a'.repeat(64),bytes:10},{kind:'calculation_input',sha256:'b'.repeat(64),bytes:10},{kind:'results_record',sha256:'c'.repeat(64),bytes:10}],
 source_result_sha256:'c'.repeat(64),
 source_findings:{checks:{raw_limit:false},warnings:['warning-marker <img src=x onerror=bad()>'],unmet_conditions:['raw_limit']},
 claim_limits:['CLAIM_LIMIT_MUST_BE_VISIBLE <b>literal</b>'],checks:{execution:'pass'},
 assumptions:['synthetic'],boundary:'Synthetic scheme review only',results:{test_value:1}};
const clone=x=>JSON.parse(JSON.stringify(x));
const cases=[['valid',clone(valid)]];
for(const [name,key] of [['missing_scope','validation_scope'],['missing_findings','source_findings'],['missing_limits','claim_limits']]){const p=clone(valid);delete p[key];cases.push([name,p]);}
for(const [name,change] of [
 ['release_true',p=>p.engineering_release=true],
 ['wrong_source_hash',p=>p.source_result_sha256='d'.repeat(64)],
 ['undisclosed_false',p=>p.source_findings.unmet_conditions=[]],
 ['unknown_method',p=>{p.calculation_method='not_supported';p.evidence=[{kind:'flowsheet_model',sha256:'a'.repeat(64),bytes:10},{kind:'results_record',sha256:'c'.repeat(64),bytes:10}];}],
]){const p=clone(valid);change(p);cases.push([name,p]);}
const checks=cases.map(([name,p])=>({name,backend:backend.isRealEngineCalculation(p),frontend:front.isRealEngineCalculation(p),pass:backend.isRealEngineCalculation(p)===front.isRealEngineCalculation(p)}));
class TextNode{
 constructor(tag){this.tag=tag;this.children=[];this._text='';this.open=false;}
 set textContent(x){this._text=String(x);this.children=[];}
 get textContent(){return this._text+this.children.map(x=>x.textContent||String(x)).join('');}
 set innerHTML(_){throw Error('Dynamic HTML prohibited in this check');}
 append(...children){this.children.push(...children);}
 addEventListener(){}
}
const sandbox={ECOPWorkflowView:front,document:{createElement:tag=>new TextNode(tag)}};
let code=fs.readFileSync(path.join(dir,'workspace-ui.js'),'utf8');
if(!code.includes('root.ECOPWorkspaceUI={'))throw Error('Expected UI export marker changed; adapt harness explicitly');
code=code.replace('root.ECOPWorkspaceUI={','root.__reviewCard=calculationDeliveryCard;root.ECOPWorkspaceUI={');
vm.runInNewContext(code,sandbox,{timeout:1000});
const card=sandbox.__reviewCard(valid,{},'confirmed',true);
checks.push({name:'top_level_claim_limits_visible',pass:card.textContent.includes('CLAIM_LIMIT_MUST_BE_VISIBLE')});
checks.push({name:'scheme_confirmed_label',pass:card.textContent.includes('方案计算已审核')});
checks.push({name:'warnings_literal_text',pass:card.textContent.includes('<img src=x onerror=bad()>')});

const native=clone(valid);
delete native.calculation_method;delete native.validation_scope;delete native.engineering_release;
delete native.source_findings;delete native.source_result_sha256;delete native.claim_limits;
native.evidence=[{kind:'flowsheet_model',sha256:'a'.repeat(64),bytes:10},{kind:'results_record',sha256:'c'.repeat(64),bytes:10}];
checks.push({name:'legacy_native_contract',pass:front.isRealEngineCalculation(native)&&backend.isRealEngineCalculation(native)});
for(const [method,payload] of [['scheme',valid],['native',native]]){
 for(const state of ['submitted','confirmed','stale']){
  const node=sandbox.__reviewCard(payload,{},state,state!=='stale');
  const text=node.textContent;
  const expected=state==='stale'?'历史计算结果':(method==='scheme'?(state==='confirmed'?'方案计算已审核':'方案计算待审核'):(state==='confirmed'?'已审核的真实计算结果':'已归类的 Agent 交付'));
  checks.push({name:method+'_'+state+'_state_text',pass:text.includes(expected)&&(method!=='scheme'||text.includes('未工程签发'))});
 }
}
checks.push({name:'execution_and_source_checks_both_visible',pass:card.textContent.includes('执行检查')&&card.textContent.includes('原始工况检查')&&card.textContent.includes('未通过')});
const disclosureNodes=card.children.filter(n=>n.tag==='details'&&n.children[0]?.textContent.startsWith('声明限制'));
checks.push({name:'claim_limits_open_by_default',pass:disclosureNodes.length===1&&disclosureNodes[0].open===true});

const result={evidence_type:'NODE_CONTRACT_AND_TEXT_RENDER_NOT_BROWSER',checks,failed:checks.filter(x=>!x.pass).map(x=>x.name)};
console.log(JSON.stringify(result,null,2));
if(result.failed.length)process.exitCode=1;
