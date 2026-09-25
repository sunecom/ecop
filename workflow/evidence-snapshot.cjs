'use strict';
// Local read-only projection. Source hashes detect change, not reviewer identity.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const KINDS = new Set(['basis','assumption','calculation','equipment_review','document']);
const REVIEW = {basis:'recorded_scope_only',assumption:'unvalidated',calculation:'numerical_evidence_only',equipment_review:'pending',document:'draft_not_issued'};
function fail(code) { throw new Error(code); }
function inside(base, target) {
  const rel = path.relative(base, target);
  return rel !== '..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel);
}
function pointer(data, p) {
  if (p === '') return data;
  if (typeof p !== 'string' || !p.startsWith('/')) fail('INVALID_POINTER');
  for (const raw of p.slice(1).split('/')) {
    if (/~(?![01])/u.test(raw)) fail('INVALID_POINTER');
    const key = raw.replace(/~1/g,'/').replace(/~0/g,'~');
    if (!data || typeof data !== 'object' || !Object.hasOwn(data,key)) fail('MISSING_POINTER');
    data = data[key];
  }
  return data;
}
function evaluate(spec, root) {
  if (spec?.schema_version !== 1 || !spec.project_id || !spec.snapshot_id || !Array.isArray(spec.sources) || !Array.isArray(spec.nodes)) fail('INVALID_SPEC');
  const base = fs.realpathSync(root), sources = new Map(), nodes = new Map(), outputs = new Map(), visiting = new Set();
  const all = new Set();
  for (const item of [...spec.sources,...spec.nodes]) {
    if (!item?.id || all.has(item.id)) fail('DUPLICATE_ID');
    all.add(item.id);
  }
  for (const s of spec.sources) {
    if (!s.path || path.isAbsolute(s.path) || !/^[a-f0-9]{64}$/i.test(s.sha256 || '')) fail('INVALID_SOURCE');
    const target = path.resolve(base,s.path);
    if (!inside(base,target)) fail('OUTSIDE_ROOT');
    let status = 'missing', actual = null, bytes = null;
    if (fs.existsSync(target)) {
      const real = fs.realpathSync(target);
      if (!inside(base,real)) fail('OUTSIDE_ROOT');
      if (!fs.statSync(real).isFile()) fail('NOT_FILE');
      bytes = fs.readFileSync(real); actual = sha(bytes);
      status = actual === s.sha256.toLowerCase() ? 'current' : 'changed';
    }
    sources.set(s.id,{...s,status,actual_sha256:actual,bytes:status==='current'?bytes:null});
  }
  for (const n of spec.nodes) {
    if (!KINDS.has(n.kind) || !Array.isArray(n.depends_on) || !n.depends_on.length || !Array.isArray(n.values) || !Array.isArray(n.guards)) fail('INVALID_NODE');
    if (n.depends_on.some(id=>!all.has(id))) fail('UNKNOWN_DEPENDENCY');
    for (const ref of [...n.values,...n.guards]) {
      if (!sources.has(ref.source_id) || !n.depends_on.includes(ref.source_id) || typeof ref.pointer !== 'string') fail('UNBOUND_REFERENCE');
    }
    nodes.set(n.id,n);
  }
  function read(ref) {
    const s = sources.get(ref.source_id);
    if (!s.bytes) fail('SOURCE_NOT_CURRENT');
    s.json ??= JSON.parse(s.bytes.toString('utf8').replace(/^\uFEFF/,''));
    return pointer(s.json,ref.pointer);
  }
  function visit(id) {
    if (sources.has(id)) return {status:sources.get(id).status};
    if (outputs.has(id)) return outputs.get(id);
    if (visiting.has(id)) fail('DEPENDENCY_CYCLE');
    visiting.add(id);
    const n = nodes.get(id);
    const upstream = n.depends_on.map(ref=>({id:ref,status:visit(ref).status}));
    const reasons = upstream.filter(x=>x.status!=='current').map(x=>({code:'UPSTREAM_NOT_CURRENT',...x}));
    let values = [];
    if (!reasons.length) {
      try {
        for (const g of n.guards) if (JSON.stringify(read(g)) !== JSON.stringify(g.equals)) reasons.push({code:'EVIDENCE_CONDITION_FAILED',source_id:g.source_id,pointer:g.pointer});
        if (!reasons.length) values = n.values.map(v=>{
          const value = read(v);
          if (v.type && (v.type==='array' ? !Array.isArray(value) : typeof value!==v.type)) fail('VALUE_TYPE_MISMATCH');
          if (typeof value==='number' && (!Number.isFinite(value)||!v.unit)) fail('INVALID_NUMBER_OR_UNIT');
          return {label:v.label,value,unit:v.unit??null,source_id:v.source_id,pointer:v.pointer};
        });
      } catch (error) { reasons.push({code:'INVALID_EVIDENCE',detail:error.message}); values=[]; }
    }
    const out = {id:n.id,label:n.label,kind:n.kind,status:reasons.length?'stale_or_invalid':'current',review_state:REVIEW[n.kind],scope:n.scope,values,reasons,depends_on:n.depends_on};
    outputs.set(id,out); visiting.delete(id); return out;
  }
  for (const n of spec.nodes) visit(n.id);
  const result = {schema_version:1,project_id:spec.project_id,snapshot_id:spec.snapshot_id,
    status:[...outputs.values()].every(n=>n.status==='current')?'local_review_snapshot':'refresh_required',
    engineering_release:false,customer_review_ready:false,deployed:false,
    limit:'Hash and evidence consistency only; no reviewer authentication, industrial-property certification or equipment release.',
    spec_sha256:sha(JSON.stringify(spec)),sources:[...sources.values()].map(({bytes,json,...s})=>s),nodes:spec.nodes.map(n=>outputs.get(n.id))};
  return result;
}
function markdown(snapshot) {
  const cell = v => String(v).replace(/[|]/g,'／').replace(/[\r\n]+/g,' ');
  const lines = ['# 阿拉伯糖L1：同版数据与设备核对','',`快照：${snapshot.snapshot_id}。状态：${snapshot.status}。本机评审草稿，未上线、未工程签发。`,
    '', '已确认依据、条件假设、计算结果和设备核对分别列示。current只表示引用版本及所列证据条件一致。'];
  for (const n of snapshot.nodes) {
    lines.push('',`## ${cell(n.label)}`,'',`${n.status}；${n.review_state}。${n.scope||''}`,'');
    if (n.reasons.length) lines.push('上游已变化、缺失或证据条件未满足；本节不沿用旧数值。',JSON.stringify(n.reasons));
    else if (n.values.length) {
      lines.push('| 参数 | 值 | 单位 | 来源定位 |','|---|---|---|---|');
      for (const v of n.values) lines.push(`| ${cell(v.label)} | ${cell(typeof v.value==='object'?JSON.stringify(v.value):v.value)} | ${cell(v.unit||'—')} | ${cell(v.source_id+v.pointer)} |`);
    }
  }
  return lines.join('\n')+'\n';
}
module.exports = {evaluate,markdown,pointer};
if (require.main===module) {
  const [input,root,jsonOut,mdOut] = process.argv.slice(2);
  if (!mdOut) fail('USAGE: spec root jsonOut mdOut');
  const result = evaluate(JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,'')),root);
  fs.writeFileSync(jsonOut,JSON.stringify(result,null,2)); fs.writeFileSync(mdOut,markdown(result));
  console.log(JSON.stringify({status:result.status,nodes:result.nodes.length,engineering_release:false}));
}
