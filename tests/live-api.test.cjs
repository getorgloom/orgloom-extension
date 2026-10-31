'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LiveApi } = require('../src/live-api.cjs');
const { SalesforceError, API } = require('../src/salesforce.cjs');
const ORG='00D000000000001AAA', USER='005000000000001AAA', ID='001000000000001AAA';
function fixture() {
  const calls=[], map=new Map();
  const record={Id:ID,Name:'Before',Phone:'555-0100',LastModifiedDate:'2026-10-21T12:00:00.000+0000'};
  const fields=[{name:'Id',type:'id',updateable:false},{name:'Name',label:'Account Name',type:'string',nameField:true,updateable:true,sortable:true},{name:'Phone',type:'phone',updateable:true},{name:'LastModifiedDate',type:'datetime',updateable:false}];
  const secret={get:async k=>map.get(k),store:async(k,v)=>map.set(k,v),delete:async k=>map.delete(k)};
  const client={publicIdentity:()=>({orgId:ORG,userId:USER,orgName:'Test Org',instanceUrl:'https://test.my.salesforce.com'}),request:async(route,options={})=>{
    calls.push({route,...options});
    if(route.endsWith('/sobjects/'))return {sobjects:[{name:'Account',queryable:true}]};
    if(route.includes('/ui-api/'))throw new SalesforceError('Unsupported UI API','unsupported',404);
    if(route.endsWith('/describe'))return {name:'Account',label:'Account',updateable:true,fields,recordTypeInfos:[]};
    if(route.includes('/query?')) { const q=new URLSearchParams(route.split('?')[1]).get('q'); if(q.includes('UserRecordAccess'))return {records:[{RecordId:ID,HasReadAccess:true,HasEditAccess:true,HasDeleteAccess:false}]}; return {records:[{...record,attributes:{type:'Account'}}],totalSize:1,done:true}; }
    if(options.method==='PATCH'){Object.assign(record,options.body);return null;}
    return {...record};
  }};
  const api=new LiveApi(client,{secrets:secret,confirmUpload:async()=>true});
  const body=()=>({attemptId:'unit-test-attempt',expectedSfOrgId:ORG,records:[{tempId:1,objectName:'Account',loadedFromId:ID,loadedValues:{...record},values:{Id:ID,Name:'After',Phone:'555-0100'}}],deletes:[],associations:[],skipTempIds:[]});
  return {api,client,calls,record,fields,secret,body};
}
const message=(path,body,method='POST')=>({type:'live-api',id:1,path,body,method});
test('Unsupported URLs, writes, objects and nested queries fail closed',async()=>{
  const f=fixture();
  for(const msg of [message('https://evil.test'),message('/api/../token'),message('/api/upload/bulk',{}),message('/api/query',{soql:'SELECT Id FROM User'}),message('/api/query',{soql:'SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)'})]) assert.ok((await f.api.handle(msg)).status>=400);
  assert.ok(f.calls.every(c=>c.route.endsWith('/sobjects/') || c.route.endsWith('/describe')));
});
test('Simple SOQL preserves LIMIT 1 and records a host-owned baseline',async()=>{
  const f=fixture();const response=await f.api.handle(message('/api/query',{soql:'SELECT Name FROM Account LIMIT 1'}));
  assert.equal(response.status,200);assert.equal(response.data.records[0].values.Name,'Before');
  assert.match(decodeURIComponent(f.calls.find(c=>c.route.includes('/query?')).route),/LIMIT 1$/);assert.equal(f.api.baselines.size,1);
});
test('Live upload checks permissions, native confirmation, baseline and patches only changed fields',async()=>{
  const f=fixture();await f.api.retrieve('Account',ID);
  let reviewed;f.api.confirmUpload=async plan=>{reviewed=plan;return true;};
  const out=await f.api.handle(message('/api/upload/graph',f.body()));
  assert.equal(out.status,200);assert.equal(out.data.results[0].success,true);assert.equal(reviewed.recordId,ID);
  const writes=f.calls.filter(c=>c.method==='PATCH');assert.equal(writes.length,1);assert.deepEqual(writes[0].body,{Name:'After'});assert.ok(writes[0].headers['If-Unmodified-Since']);
  assert.equal(await f.secret.get(f.api.pendingKey),undefined);
});
test('Read-only fields, stale records, cancellation, wrong org and create/delete requests cannot write',async()=>{
  for(const change of ['readonly','stale','cancel','org','create','delete','multi']){
    const f=fixture();await f.api.retrieve('Account',ID);const b=f.body();
    if(change==='readonly'){f.fields.find(f=>f.name==='Phone').updateable=false;b.records[0].values.Phone='Changed without field permission';}
    if(change==='stale')Object.assign(f.record,{Name:'Changed by someone else',LastModifiedDate:'2026-10-21T13:00:00.000+0000'});
    if(change==='cancel')f.api.confirmUpload=async()=>false;
    if(change==='org')b.expectedSfOrgId='wrong';
    if(change==='create')b.records[0].loadedFromId=null;
    if(change==='delete')b.deletes=[{sfId:ID}];
    if(change==='multi')b.records.push({...b.records[0],tempId:2});
    assert.ok((await f.api.handle(message('/api/upload/graph',b))).status>=400,change);
    assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0,change);
  }
});
test('Uncertain write outcome stays blocked without storing or comparing submitted values',async()=>{
  const f=fixture();await f.api.retrieve('Account',ID);
  const original=f.client.request;
  f.client.request=async(route,options)=>{if(options?.method==='PATCH'){await original(route,options);throw new Error('response lost');}return original(route,options);};
  assert.equal((await f.api.handle(message('/api/upload',f.body()))).data.error,'upload-outcome-unknown');
  const next=new LiveApi(f.client,{secrets:f.secret,confirmUpload:async()=>true});
  assert.equal((await next.handle(message('/api/upload',f.body()))).status,409);
  const readsBefore=f.calls.length;
  assert.match(await next.checkPending(),/remains blocked/);
  assert.equal(f.calls.length,readsBefore,'Unknown outcomes are not inferred by comparing Salesforce values');
  const pending=JSON.parse(await f.secret.get(f.api.pendingKey));
  assert.deepEqual(Object.keys(pending.operations[0]).sort(),['mode','objectName','recordId','tempId']);
  assert.equal(JSON.stringify(pending).includes('After'),false);
  assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
});
test('Permission denial and conditional-update conflict never report success',async()=>{
  for(const mode of ['permission','conflict']){
    const f=fixture();await f.api.retrieve('Account',ID);const original=f.client.request;
    f.client.request=async(route,options)=>{if(mode==='permission'&&route.includes('UserRecordAccess'))return {records:[]};if(options?.method==='PATCH')throw new SalesforceError('Changed','conflict',412);return original(route,options);};
    const out=await f.api.handle(message('/api/upload',f.body()));
    if(mode==='permission')assert.ok(out.status>=400);else assert.equal(out.data.results[0].success,false);
    assert.equal(await f.secret.get(f.api.pendingKey),undefined);
  }
});
module.exports={fixture,ID,ORG,USER};
