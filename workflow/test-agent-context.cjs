'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {buildContext} = require('./agent-context.cjs');
test('incomplete taskbook remains available for reasoning without approving ambiguous data', () => {
  const project = {project_id:'p1',revision:7};
  const row = {id:'t1',filename:'input.xlsx',sha256:'abc',report_json:JSON.stringify({blocking_count:2,fields:[
    {target_field:'requirements.fluid_identity',value:'麦芽糖醇'},
    {target_field:'requirements.feed_concentration',value:28,value_basis:'unconfirmed'},
    {target_field:'requirements.feed_temperature',value:null},
    {target_field:'requirements.pressure_drop',value:0},
  ],issues:[{message:'浓度口径待确认'}]})};
  const before = JSON.stringify({project,row});
  const result=buildContext(project,row);
  assert.equal(result.status,'ready_for_analysis');
  assert.equal(result.conditions.length,3);
  assert.equal(result.conditions[1].value_basis,'unconfirmed');
  assert.equal(result.conditions[1].confirmation,'source_reported_not_approved');
  assert.equal(result.conditions[2].value,0);
  assert.equal(result.issues.length,1);
  assert.equal(result.source.taskbook_id,'t1');
  assert.equal(JSON.stringify({project,row}),before);
});
