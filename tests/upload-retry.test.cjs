'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {fixture}=require('./upload-fixture.cjs');
const source=fs.readFileSync(path.join(__dirname,'../vendor/upstream/packages/canvas/src/public/js/upload-modal.js'),'utf8');
const context={window:{OrgLoom:{}}};
vm.runInNewContext(source,context);
const modal=context.window.OrgLoom.uploadModal;
function journal() {
  const storage=new Map();let seq=0;
  return modal.createUploadRecoveryJournal({getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},'org','user',()=>String(++seq));
}
function recoveryState(f,records,recoveryJournal) {
  const state={recoveryJournal,_uploadAttemptId:null,flushAutosave(){},renderAttemptIncomplete(){throw Error('Known outcomes must not show an interrupted-upload message');},
    csrfFetch:async url=>({ok:true,json:()=>f.api.uploader.status(url.split('/').at(-1))})};
  vm.runInNewContext(source.slice(source.indexOf('async function recoverPendingUploads('),source.indexOf('let _allowDuplicates = false;')),state);
  return state;
}
test('Duplicate and range failures can be corrected and retried with three normalized unchanged records',async()=>{
  const f=fixture();f.fields.push({name:'Amount__c',type:'currency',createable:true,updateable:true});
  const rows=[];
  for(let id=1;id<=3;id++) {
    const a=f.seed('Account',{Name:'Existing '+id,Amount__c:100});
    rows.push(await f.loaded(id,'Account',a,{Amount__c:'100.00'}));
  }
  rows.push(f.draft(4,'Account',{Name:'Duplicate alert'}),f.draft(5,'Contact',{Name:'Child'}),f.draft(6,'Account',{Name:'Range',Amount__c:1000}));
  const links=[{fromId:5,toId:4,fieldName:'AccountId'}];
  const body=f.body(rows,links),records=rows.map(r=>({...r,id:r.tempId})),j=journal();j.track(records,body.attemptId);
  const first=await f.api.upload(body);
  assert.ok(first.results.some(r=>r.errorCode==='DUPLICATES_DETECTED'));
  assert.ok(first.results.some(r=>r.errorCode==='NUMBER_OUTSIDE_VALID_RANGE'));
  assert.equal(first.results.filter(r=>r.mode==='unchanged').length,3);
  assert.equal(first.results.length,6);
  // The real result renderer clears markers only for returned record IDs.
  const start=source.indexOf('const completedIds = new Set(results.map('),end=source.indexOf('// Only successful rows',start);
  vm.runInNewContext(source.slice(start,end),{results:first.results,recoveryJournal:j,canvasState:{bulkRecords:records}});
  assert.equal(j.entries(records).length,0);
  assert.equal(await recoveryState(f,records,j).recoverPendingUploads(records),false);
  rows[3].values.Name='Corrected duplicate';rows[5].values.Amount__c=500;
  const second=await f.api.upload(f.body(rows,links));
  assert.equal(second.atomicSuccess,true);assert.equal(f.db.size,6);
  assert.equal(second.results.filter(r=>r.mode==='create').length,3);
  assert.equal(await f.secrets.get(f.api.pendingKey),undefined);
});
test('All normalized unchanged rows return complete results without Salesforce writes',async()=>{
  const f=fixture();f.fields.push({name:'Amount__c',type:'currency',createable:true,updateable:true});
  const a=f.seed('Account',{Name:'Existing',Amount__c:100});
  const body=f.body([await f.loaded(1,'Account',a,{Amount__c:'100.00'})]);
  const result=await f.api.upload(body);
  assert.equal(result.results[0].mode,'unchanged');assert.equal(result.results[0].success,true);
  assert.equal(result.canonicalValues[1].Amount__c,100);
  assert.equal(result.canonicalValues[1].Id,a.Id);
  assert.equal(f.calls.filter(c=>c.method).length,0);
});

test('stale lookup baselines get canonical no-op snapshots; failed reads never invent one',async()=>{
  for(const readFails of [false,true]) {
    const f=fixture(),parent=f.seed('Account',{Name:'Parent'}),child=f.seed('Contact',{Name:'Child',AccountId:parent.Id});
    const row=await f.loaded(1,'Contact',child);row.loadedValues.AccountId=null;
    const originalRetrieve=f.api.retrieve.bind(f.api);let reads=0;
    f.api.retrieve=async(...args)=>{reads++;if(readFails)throw Error('Read failed');return originalRetrieve(...args);};
    const result=await f.api.upload(f.body([row]));
    assert.equal(result.results[0].mode,'unchanged');assert.ok(reads>0);
    assert.equal(result.canonicalValues[1]?.AccountId,readFails?undefined:parent.Id);
    assert.equal(f.calls.filter(c=>c.method).length,0);
  }
});

test('duplicate approval uses atomic Composite subrequest headers and can be replayed safely',async()=>{
  const f=fixture(),rows=[f.draft(1,'Account',{Name:'Duplicate alert'}),f.draft(2,'Contact',{Name:'Child'})],links=[{fromId:2,toId:1,fieldName:'AccountId'}];
  assert.equal((await f.api.upload(f.body(rows,links))).atomicSuccess,false);
  assert.equal(f.db.size,0);
  const body={...f.body(rows,links),allowDuplicates:true};
  const result=await f.api.upload(body);
  assert.equal(result.atomicSuccess,true);assert.equal(f.db.size,2);
  const request=f.calls.find(c=>c.path?.endsWith('/composite')||c.route?.endsWith('/composite'));
  assert.ok(request);
  assert.equal(request.body.allOrNone,true);
  assert.ok(request.body.compositeRequest.every(s=>s.httpHeaders['Sforce-Duplicate-Rule-Header']==='allowSave=true'));
  await f.api.upload(body);assert.equal(f.db.size,2);
});

test('duplicate override cannot split an oversized connected transaction',async()=>{
  const f=fixture(),rows=Array.from({length:26},(_,i)=>f.draft(i+1,'Account',{Name:'Row '+i})),links=rows.slice(1).map(r=>({fromId:r.tempId,toId:1,fieldName:'ParentId'}));
  await assert.rejects(f.api.upload({...f.body(rows,links),allowDuplicates:true}),/25 operations/);
  assert.equal(f.calls.filter(c=>c.method).length,0);assert.equal(f.db.size,0);
});
test('Older completed receipts release omitted records automatically, but missing receipts stay blocked',async()=>{
  const f=fixture(),body=f.body([f.draft(4,'Account',{Name:'Duplicate alert'})]);
  await f.api.upload(body);
  const records=[{id:1,objectName:'Account',loadedFromId:'001000000000001AAA',values:{Name:'Keep my edit'}}],j=journal();
  j.track(records,body.attemptId);
  const state=recoveryState(f,records,j);
  assert.equal(await state.recoverPendingUploads(records),false);
  assert.equal(j.entries(records).length,0);assert.equal(records[0].values.Name,'Keep my edit');
  j.track(records,'missing-attempt');let blocked=false;
  state.renderAttemptIncomplete=body=>{blocked=true;assert.equal(body.recoveryComplete,false);};
  assert.equal(await state.recoverPendingUploads(records),true);assert.equal(blocked,true);assert.equal(j.entries(records).length,1);
});
