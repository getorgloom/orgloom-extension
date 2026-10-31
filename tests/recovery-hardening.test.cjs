'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {RecoveryStore,cleanupRecovery,TTL}=require('../src/recovery.cjs');
const {RecoverySession}=require('../src/recovery-session.cjs');
const {authorizeRecovery}=require('../src/recovery-access.cjs');
const {SalesforceError}=require('../src/salesforce.cjs');
const id='001000000000001AAA', missing='001000000000002AAA';
const key='orgloom:canvas-draft:v1|scope', pointer='orgloom:canvas-draft-active:v1|identity';
function snapshot(){return {time:Date.now(),state:{version:1,local:{'orgloom:secret':'old data'},session:{[pointer]:key,[key]:JSON.stringify({v:1,ts:Date.now(),identity:'identity',scope:'scope',state:{bulkRecords:[
  {id:1,objectName:'Account',loadedFromId:id,label:'Cached secret',values:{Name:'Edited',Secret:'hidden'},loadedValues:{Name:'Before',Secret:'hidden'},_recordAccess:{hasReadAccess:true},x:1,y:2},
  {id:2,objectName:'Account',loadedFromId:missing,values:{Name:'Deleted'}},
  {id:3,objectName:'Account',values:{Name:'New draft',Secret:'hidden'}},
],bulkAssociations:[{fromId:1,toId:2,fieldName:'ParentId'}],diffSuppressions:{secret:'hidden'},selectedObjects:[{id:1,name:'Account',data:{secret:'hidden'},worldPos:{x:40,y:50}}]}})}},baselines:[['Account:'+id,{Id:id,Name:'Before',Secret:'hidden',LastModifiedDate:'old'}]]};}
function api(){return {assertActive(){},metadata:{clear(){},graph:async()=>({name:'Account',parents:[],children:[]})},reads:{name:async n=>n},describe:async()=>({name:'Account',fields:[{name:'Id'},{name:'Name'},{name:'LastModifiedDate'}]}),retrieve:async(n,i)=>{if(i===missing)throw new SalesforceError('Missing','NOT_FOUND',404);return {Id:id,Name:'Current',LastModifiedDate:'new'};}};}
test('Recovery drops revoked records/fields, cached labels and side channels but preserves allowed edits and original baseline',async()=>{
  const original=snapshot(),result=await authorizeRecovery(api(),original),state=JSON.parse(result.state.session[key]).state;
  assert.equal(state.bulkRecords.length,2);assert.equal(state.bulkRecords[0].values.Name,'Edited');assert.equal(state.bulkRecords[1].values.Name,'New draft');
  assert.equal(state.bulkRecords[0].label,undefined);assert.equal(state.bulkAssociations.length,0);assert.ok(result.notice);
  assert.deepEqual(state.selectedObjects[0].data,{name:'Account',parents:[],children:[]});assert.deepEqual(state.selectedObjects[0].worldPos,{x:40,y:50});
  assert.equal(result.baselines[0][1].LastModifiedDate,'old');assert.equal(result.baselines[0][1].Name,'Before');
  assert.ok(!JSON.stringify(result).includes('hidden'));assert.ok(!JSON.stringify(result).includes('Cached secret'));
  assert.ok(JSON.stringify(original).includes('hidden'));
});
test('Recovery fails closed on auth/network/rate errors without returning cached data',async()=>{
  for(const error of [new Error('offline'),new SalesforceError('auth','INVALID_SESSION_ID',401),new SalesforceError('quota','REQUEST_LIMIT_EXCEEDED',403)]){
    const a=api();a.retrieve=async()=>{throw error;};await assert.rejects(authorizeRecovery(a,snapshot()),error);
  }
});

test('Recovery notice ignores metadata, derived compounds, empty fields and baseline-only cleanup',async()=>{
  const original=snapshot(),payload=JSON.parse(original.state.session[key]);
  payload.state.bulkRecords=[{id:1,objectName:'Account',loadedFromId:id,
    values:{Name:'Edited',attributes:{type:'Account'},_internal:{cached:true},Unused__c:null,BillingAddress:{city:'Phoenix'}},
    loadedValues:{Name:'Before',OldField__c:'baseline only',attributes:{type:'Account'}}}];
  payload.state.bulkAssociations=[];original.state.session[key]=JSON.stringify(payload);
  const a=api(),describe=a.describe;a.describe=async()=>({...await describe(),fields:[...(await describe()).fields,{name:'BillingAddress',type:'address',createable:false,updateable:false}]});
  const result=await authorizeRecovery(a,original);
  assert.equal(result.notice,null);
  assert.deepEqual(JSON.parse(result.state.session[key]).state.bulkRecords[0].values,{Name:'Edited'});
});

test('Recovery notice identifies affected records and fields once without exposing cached values',async()=>{
  const original=snapshot(),payload=JSON.parse(original.state.session[key]);
  payload.state.bulkRecords[0].values.Secret=null; // Losing an intentional clear is meaningful.
  payload.state.bulkRecords[0].values.Flag__c=false;
  payload.state.bulkRecords[0].values.Count__c=0;
  const result=await authorizeRecovery(api(),{...original,state:{...original.state,session:{...original.state.session,[key]:JSON.stringify(payload)}}});
  assert.match(result.notice,/Account · canvas record #1: could not restore Count__c, Flag__c, ParentId, Secret\./);
  assert.match(result.notice,/Account · canvas record #2: record is unavailable or you no longer have access\./);
  assert.match(result.notice,/Account · canvas record #3: could not restore Secret\./);
  assert.doesNotMatch(result.notice,/hidden|Cached secret|Deleted|New draft/);
  assert.equal(result.notice.split('canvas record #1:').length,2);
});

test('Recovery warns about unsupported meaningful field values rather than silently discarding them',async()=>{
  const original=snapshot(),payload=JSON.parse(original.state.session[key]);
  payload.state.bulkRecords=[{id:3,objectName:'Account',values:{Name:['Unexpected','value']}}];
  payload.state.bulkAssociations=[];original.state.session[key]=JSON.stringify(payload);
  const result=await authorizeRecovery(api(),original);
  assert.match(result.notice,/canvas record #3: could not restore Name/);
  assert.doesNotMatch(result.notice,/Unexpected/);
});
test('Reload waits for accepted writes, rejects stale documents/sequences, and never writes after close',async()=>{
  let stored=0,release;const blocked=new Promise(r=>release=r);
  const session=new RecoverySession({restore:async()=>({state:stored}),save:async state=>{await blocked;stored=state;}});
  const a=await session.begin('a'.repeat(32));
  const write=session.checkpoint({sessionToken:a.sessionToken,sequence:1,state:2});
  const next=session.begin('b'.repeat(32));
  await assert.rejects(session.checkpoint({sessionToken:a.sessionToken,sequence:2,state:1}),/Stale/);
  release();await write;const b=await next;assert.equal(b.state,2);
  await session.checkpoint({sessionToken:b.sessionToken,sequence:2,state:3});
  await assert.rejects(session.checkpoint({sessionToken:b.sessionToken,sequence:1,state:1}),/Stale/);
  await session.close();await assert.rejects(session.checkpoint({sessionToken:b.sessionToken,sequence:3,state:1}));assert.equal(stored,3);
});
test('Cleanup deletes expired unopened identities and keys but preserves fresh and unrelated files',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ol-cleanup-'));const data=new Map();const secrets={get:async k=>data.get(k),store:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k)};
  try{
    const a=new RecoveryStore(root,secrets,{orgId:'old',userId:'one'}),b=new RecoveryStore(root,secrets,{orgId:'fresh',userId:'two'});
    const state={version:1,local:{},session:{}};await a.save(state,new Map());await b.save(state,new Map());
    const old=new Date(Date.now()-TTL-10000);await fs.utimes(a.file,old,old);
    const other=path.join(root,'recovery','do-not-delete.txt');await fs.writeFile(other,'keep');await fs.utimes(other,old,old);
    assert.equal(await cleanupRecovery(root,secrets),1);await assert.rejects(fs.stat(a.file),{code:'ENOENT'});assert.ok(!data.has(a.secret));assert.ok(data.has(b.secret));assert.ok(await b.load());assert.equal(await fs.readFile(other,'utf8'),'keep');
    assert.equal(await cleanupRecovery(root,secrets),0);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
