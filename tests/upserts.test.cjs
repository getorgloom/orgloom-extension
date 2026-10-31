'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('./upload-fixture.cjs');
const {LiveApi}=require('../src/live-api.cjs');
const upsert=(f,id,key,values={})=>({...f.draft(id,'Account',{External_Key__c:key,...values}),_csvOperation:'upsert',_csvExternalIdField:'External_Key__c'});
test('A child retry can link to an already-successful, skipped upsert parent',async()=>{
 const f=fixture(),existing=f.seed('Account',{Name:'Parent',External_Key__c:'KEY'});
 const parent={...upsert(f,1,'KEY',{Name:'Parent'}),loadedFromId:existing.Id};
 const body={...f.body([parent,f.draft(2,'Contact',{Name:'Child'})],[{fromId:2,toId:1,fieldName:'AccountId'}]),skipTempIds:[1]};
 const result=await f.api.upload(body);
 assert.equal(result.results.length,1);assert.equal(f.db.get(result.results[0].id).record.AccountId,existing.Id);
});
test('Numeric external keys normalize safely and string keys are escaped as SOQL literals',async()=>{
 const {externalKey,matchUpsert}=require('../src/upserts.cjs');
 const desc={name:'Account',fields:[{name:'Key__c',type:'double',externalId:true,filterable:true,createable:true,updateable:true}]};
 const external=externalKey(desc,{_csvExternalIdField:'Key__c',values:{Key__c:'0012.500'}});
 assert.equal(external.value,'12.5');
 let query;const api={query:async q=>{query=q;return {records:[],done:true};}};
 await matchUpsert(api,'Account',external);assert.match(query,/= 12\.5 LIMIT 2$/);
 assert.throws(()=>externalKey(desc,{_csvExternalIdField:'Key__c',values:{Key__c:'0 OR Id != null'}}));
 await matchUpsert(api,'Account',{field:'Key__c',value:"x' OR Name = 'y",type:'string'});
 assert.equal(query,"SELECT Id FROM Account WHERE Key__c = 'x\\' OR Name = \\'y' LIMIT 2");
});
test('External ID Graph upserts insert and update, return actual IDs, link children, and replay safely',async()=>{
 const f=fixture(),existing=f.seed('Account',{Name:'Old',External_Key__c:'C123',Phone:'unchanged'});
 const body=f.body([upsert(f,1,'C123',{Name:'New'}),upsert(f,2,"C/456's",{Name:'Created'}),f.draft(3,'Contact',{Name:'Child'})],[{fromId:3,toId:2,fieldName:'AccountId'}]);
 const result=await f.api.upload(body);
 assert.equal(result.results.find(r=>r.tempId===1).mode,'update');assert.equal(f.db.get(existing.Id).record.Name,'New');assert.equal(f.db.get(existing.Id).record.Phone,'unchanged');
 const parent=result.results.find(r=>r.tempId===2),child=result.results.find(r=>r.tempId===3);assert.equal(parent.mode,'create');assert.equal(f.db.get(child.id).record.AccountId,parent.id);
 const requests=f.calls.filter(c=>c.route.endsWith('/composite/graph')).flatMap(c=>c.body.graphs.flatMap(g=>g.compositeRequest));
 assert.ok(requests.some(r=>r.url.includes('C123?updateOnly=true')));assert.ok(requests.some(r=>r.url.includes('C%2F456')));assert.ok(requests.every(r=>!Object.hasOwn(r.body,'External_Key__c')));
 const before=f.calls.filter(c=>c.method).length;assert.equal((await f.api.upload(body)).idempotentReplay,true);assert.equal(f.calls.filter(c=>c.method).length,before);
});
test('Upsert rejects ambiguous/repeated keys, inaccessible fields, wrong identities and changed matches before writes',async()=>{
 for(const kind of ['ambiguous','repeat','field','empty','write','changed','wrongId']) {
  const f=fixture();let records=[upsert(f,1,'KEY',{Name:'N'})];
  if(kind==='ambiguous'){f.seed('Account',{External_Key__c:'KEY'});f.seed('Account',{External_Key__c:'KEY'});}
  if(kind==='repeat')records.push(upsert(f,2,'key',{Name:'N2'}));
  if(kind==='field')records[0]._csvExternalIdField='Name';
  if(kind==='empty')records[0].values.External_Key__c='';
  if(kind==='write')f.fields.find(v=>v.name==='Name').updateable=false;
  if(kind==='changed')f.api.confirmUpload=async()=>{f.seed('Account',{External_Key__c:'KEY'});return true;};
  if(kind==='wrongId')records[0].loadedFromId='001000000000999AAA';
  await assert.rejects(f.api.upload(f.body(records)),undefined,kind);assert.equal(f.calls.filter(c=>c.method).length,0,kind);
 }
});
test('Lost upsert response blocks resubmission rather than treating the external key as a retry guarantee',async()=>{
 const f=fixture(),request=f.client.request;
 f.client.request=async(route,options)=>{const result=await request(route,options);if(options?.method==='POST')throw Error('Lost');return result;};
 const body=f.body([upsert(f,1,'KEY',{Name:'N'})]);await assert.rejects(f.api.upload(body),/outcome is unknown/);assert.equal(f.db.size,1);
 const api=new LiveApi(f.client,{secrets:f.secrets,confirmUpload:async()=>true});await assert.rejects(api.upload(body),/unconfirmed/);
});
test('Duplicate alerts need an explicit confirmed retry; blocking rules still fail and cancelled retries cannot write',async()=>{
 for(const kind of ['alert','block','cancel']) {
  const f=fixture();const body=f.body([f.draft(1,'Account',{Name:kind==='block'?'Duplicate block':'Duplicate alert'})]);
  const failed=await f.api.upload(body);assert.equal(failed.results[0].errorCode,'DUPLICATES_DETECTED');assert.equal(f.db.size,0);
  let reviewed;f.api.confirmUpload=async plan=>{reviewed=plan;return kind!=='cancel';};
  const retry={...body,attemptId:randomUUID(),allowDuplicates:true};
  if(kind==='cancel')await assert.rejects(f.api.upload(retry),/cancelled/);
  else {const result=await f.api.upload(retry);assert.equal(result.results[0].success,kind==='alert');}
  assert.equal(reviewed.allowDuplicates,true);assert.equal(f.db.size,kind==='alert'?1:0);
 }
});
