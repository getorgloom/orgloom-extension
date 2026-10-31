'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {LiveApi}=require('../src/live-api.cjs');
const {SalesforceError}=require('../src/salesforce.cjs');
const {fixture}=require('./upload-fixture.cjs');

const confirmations = reply => reply.data.conflicts.map(r=>({sfId:r.sfId,fields:r.fields.map(f=>({fieldName:f.fieldName,expectedCurrent:f.current}))}));
const send = (f,body) => f.api.handle({type:'live-api',id:1,path:'/api/upload/graph',method:'POST',body});

test('Pending journals and completed receipts omit submitted values while preserving replay protection',async()=>{
  const f=fixture(),existing=f.seed('Account',{Name:'PRIVATE ORIGINAL VALUE'});
  const body=f.body([await f.loaded(1,'Account',existing,{Name:'PRIVATE UPDATE VALUE'}),f.draft(2,'Account',{Name:'PRIVATE CREATE VALUE'})]);
  const writes=[],store=f.secrets.store;
  f.secrets.store=async(key,value)=>{writes.push({key,value});return store(key,value);};
  const result=await f.api.upload(body);
  assert.equal(result.results.filter(r=>r.success).length,2);
  assert.ok(writes.some(r=>r.key===f.api.pendingKey));
  assert.ok(writes.some(r=>r.key.includes('.receipt.')));
  for(const {value} of writes) {
    assert.doesNotMatch(value,/PRIVATE (ORIGINAL|UPDATE|CREATE) VALUE/);
    const entry=JSON.parse(value);
    for(const op of entry.operations||[])assert.deepEqual(Object.keys(op).sort(),['mode','objectName','recordId','tempId']);
  }
  const writeCount=f.calls.filter(c=>c.method).length;
  assert.equal((await f.api.upload(body)).idempotentReplay,true);
  assert.equal(f.calls.filter(c=>c.method).length,writeCount);
});

test('Old pending field payloads are removed without clearing unknown outcomes or comparing record values',async()=>{
  for(const version of [undefined,2,3]) {
    const f=fixture();
    const op={tempId:1,objectName:'Account',recordId:'001000000000001AAA',mode:'update',changes:{Name:'PRIVATE OLD VALUE'},baseline:{Name:'PRIVATE BASELINE VALUE'}};
    const pending=version?{version,attemptId:'old-attempt-123',fingerprint:'hash',single:true,state:'dispatched',operations:[op],completed:[],inFlight:[1]}:{...op};
    await f.secrets.store(f.api.pendingKey,JSON.stringify(pending));
    const calls=f.calls.length;
    assert.match(await f.api.checkPending(),/remains blocked/);
    assert.equal(f.calls.length,calls);
    const cleaned=await f.secrets.get(f.api.pendingKey);
    assert.ok(cleaned,'Unknown outcome guard remains');
    assert.doesNotMatch(cleaned,/PRIVATE|"changes"|"baseline"/);
    await assert.rejects(f.api.upload(f.body([f.draft(2,'Account',{Name:'New attempt'})])),/unconfirmed outcome/);
  }
});

test('Export, reconnect and snapshot import recovers comparison data without discarding edits or overwriting untouched fields',async()=>{
  const f=fixture(),account=f.seed('Account',{Name:'Original name',Phone:'111'});
  const row=await f.loaded(1,'Account',account,{Phone:'222'});
  const exported=JSON.parse(JSON.stringify({values:row.values,originalValues:{Phone:'111'},loadedFromId:account.Id}));
  // Same reconstruction as templates.js for snapshot-with-changes files.
  const imported={tempId:1,objectName:'Account',values:exported.values,loadedValues:{...exported.values,...exported.originalValues},loadedFromId:exported.loadedFromId};
  f.api=new LiveApi(f.client,{secrets:f.secrets,confirmUpload:async()=>true});
  Object.assign(f.db.get(account.Id).record,{Name:'Changed outside canvas',LastModifiedDate:'2026-10-28T00:00:00.000Z'});
  const body=f.body([imported]),snapshot=JSON.stringify(imported),first=await send(f,body);
  assert.equal(first.status,200,JSON.stringify(first));
  assert.equal(JSON.stringify(imported),snapshot);
  assert.equal(f.db.get(account.Id).record.Name,'Changed outside canvas');
  assert.equal(f.db.get(account.Id).record.Phone,'222');
  assert.deepEqual(f.calls.find(c=>c.method==='PATCH').body,{Phone:'222'});
});

test('Reimported edits show current field conflicts and stale confirmation cannot bypass them',async()=>{
  const f=fixture(),a=f.seed('Account',{Name:'Original'}),row=await f.loaded(1,'Account',a,{Name:'Wanted'});
  f.api.baselines.clear();
  Object.assign(f.db.get(a.Id).record,{Name:'Concurrent',LastModifiedDate:'2026-10-28T00:00:00.000Z'});
  const body=f.body([row]),first=await send(f,body);
  assert.equal(first.status,409);
  assert.equal(first.data.conflicts[0].fields.find(f=>f.fieldName==='Name').current,'Concurrent');
  body.baselineConfirmations=confirmations(first);
  Object.assign(f.db.get(a.Id).record,{Name:'Newer',LastModifiedDate:'2026-10-28T01:00:00.000Z'});
  const second=await send(f,body);assert.equal(second.status,409);
  assert.equal(second.data.conflicts[0].fields.find(f=>f.fieldName==='Name').current,'Newer');
  assert.equal(f.calls.filter(c=>c.method).length,0);
  body.baselineConfirmations=confirmations(second);
  assert.equal((await send(f,body)).status,200);
});

test('Reimported deletions require native confirmation and still enforce record access',async()=>{
  const f=fixture(),a=f.seed('Account',{Name:'Delete after review'});
  const body=f.body([],[],[{tempId:1,objectName:'Account',sfId:a.Id}]);
  let reviewed=false;
  f.api.confirmUpload=async plan=>{reviewed=true;assert.equal(plan.operations[0].mode,'delete');assert.equal(plan.operations[0].baseline.Name,'Delete after review');return true;};
  const access=f.api.access;f.api.access=async()=>({results:[]});
  assert.equal((await send(f,body)).status,403);assert.equal(f.calls.filter(c=>c.method).length,0);assert.equal(reviewed,false);
  f.api.access=access;
  assert.equal((await send(f,body)).status,200);assert.equal(f.db.has(a.Id),false);assert.equal(reviewed,true);
});

test('Unavailable imported records and missing original values fail clearly without writes',async()=>{
  const f=fixture(),a=f.seed('Account',{Name:'Original'}),row=await f.loaded(1,'Account',a,{Name:'Wanted'});
  f.api.baselines.clear();
  const request=f.client.request;
  f.client.request=async(path,options)=>path.endsWith('/'+a.Id)?Promise.reject(new SalesforceError('Not found','NOT_FOUND',404)):request(path,options);
  let reply=await send(f,f.body([row]));assert.equal(reply.status,403);assert.ok(reply.data.message.includes(a.Id));
  f.client.request=request;delete row.loadedValues;
  reply=await send(f,f.body([row]));assert.equal(reply.status,400);assert.match(reply.data.message,/original values/);
  assert.equal(f.calls.filter(c=>c.method).length,0);
});

test('Migration value representations do not report false changes; text remains literal', async()=>{
  const f=fixture();
  f.fields.push({name:'Amount__c',type:'currency',createable:true,updateable:true},{name:'Active__c',type:'boolean',createable:true,updateable:true});
  const account=f.seed('Account',{Name:'Before',Phone:null,Amount__c:100,Active__c:false});
  const row=await f.loaded(1,'Account',account,{Name:'After',Phone:'',Amount__c:'100.00',Active__c:'false'});
  row.loadedValues={...row.loadedValues,Phone:'',Amount__c:'100',Active__c:'FALSE'};
  assert.deepEqual((await f.api.uploader.plan(f.body([row])))[0].changes,{Name:'After'});
  row.values.Amount__c=125;row.values.Active__c=true;
  assert.deepEqual((await f.api.uploader.plan(f.body([row])))[0].changes,{Name:'After',Amount__c:125,Active__c:true});
  row.loadedValues.Name='Different';
  const reply=await send(f,f.body([row]));
  assert.equal(reply.status,409);assert.equal(reply.data.conflicts[0].fields[0].fieldName,'Name');
});

test('A baseline conflict returns field details and Upload anyway accepts only the displayed value',async()=>{
  const f=fixture(),account=f.seed('Account',{Name:'Current'});
  const row=await f.loaded(1,'Account',account,{Name:'Wanted'});row.loadedValues.Name='Original';
  const body=f.body([row]),first=await send(f,body);
  assert.equal(first.status,409);
  assert.deepEqual(first.data.conflicts,[{tempId:1,objectName:'Account',sfId:account.Id,fields:[{fieldName:'Name',loaded:'Original',current:'Current',canvas:'Wanted'}]}]);
  assert.equal(f.calls.filter(c=>c.method).length,0);
  body.baselineConfirmations=confirmations(first);
  assert.equal((await send(f,body)).status,200);
  assert.equal(f.db.get(account.Id).record.Name,'Wanted');
});

test('Multiple changed records and baseline mismatches are confirmed together without retry loops',async()=>{
  const f=fixture(),a=f.seed('Account',{Name:'A'}),b=f.seed('Account',{Name:'B'});
  const rows=[await f.loaded(1,'Account',a,{Name:'Wanted A'}),await f.loaded(2,'Account',b,{Name:'Wanted B'})];
  rows[0].loadedValues.Name='Older A';
  for(const record of [a,b])Object.assign(f.db.get(record.Id).record,{Name:'Concurrent '+record.Name,LastModifiedDate:'2026-10-22T14:00:00.000Z'});
  const body=f.body(rows),reply=await send(f,body);
  assert.equal(reply.status,409);assert.equal(reply.data.conflicts.length,2);
  assert.ok(reply.data.conflicts.every(r=>r.fields.length===1&&r.fields[0].fieldName==='Name'));
  body.baselineConfirmations=confirmations(reply);
  const result=await send(f,body);assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.db.get(a.Id).record.Name,'Wanted A');assert.equal(f.db.get(b.Id).record.Name,'Wanted B');
});

test('A second Salesforce change invalidates an earlier Upload anyway confirmation',async()=>{
  const f=fixture(),a=f.seed('Account',{Name:'Original'}),row=await f.loaded(1,'Account',a,{Name:'Wanted'});
  Object.assign(f.db.get(a.Id).record,{Name:'Concurrent',LastModifiedDate:'2026-10-22T14:00:00.000Z'});
  const body=f.body([row]),first=await send(f,body);body.baselineConfirmations=confirmations(first);
  Object.assign(f.db.get(a.Id).record,{Name:'Newer',LastModifiedDate:'2026-10-22T15:00:00.000Z'});
  const second=await send(f,body);assert.equal(second.status,409);assert.equal(second.data.conflicts[0].fields.find(f=>f.fieldName==='Name').current,'Newer');
  assert.equal(f.calls.filter(c=>c.method).length,0);
  body.baselineConfirmations=confirmations(second);
  f.api.confirmUpload=async()=>{Object.assign(f.db.get(a.Id).record,{Name:'Changed during review',LastModifiedDate:'2026-10-22T16:00:00.000Z'});return true;};
  assert.equal((await send(f,body)).status,409);assert.equal(f.calls.filter(c=>c.method).length,0);
});

test('Migrated datetime formats do not cause false baseline conflicts or redundant writes',async()=>{
  const f=fixture();f.fields.push({name:'Start__c',type:'datetime',createable:true,updateable:true});
  const account=f.seed('Account',{Name:'Before',Start__c:'2026-11-01T00:00:00.123+0000'});
  const row=await f.loaded(1,'Account',account,{Name:'Migrated',Start__c:'2026-10-31T17:00:00.123-07:00'});
  row.loadedValues={...row.loadedValues,Start__c:'2026-11-01T00:00:00.123Z'};
  row.values.LastModifiedDate='2026-10-22T12:00:00.000Z';
  const ops=await f.api.uploader.plan(f.body([row]));
  assert.deepEqual(ops[0].changes,{Name:'Migrated'});
  row.values.Start__c='2026-11-01T00:00:00.124Z';
  const changed=await f.api.uploader.plan(f.body([row]));
  assert.equal(changed[0].changes.Start__c,row.values.Start__c,'A real millisecond edit must be uploaded.');
  row.loadedValues.Start__c='2026-11-01T00:00:00.122Z';
  await assert.rejects(f.api.uploader.plan(f.body([row])),/baseline changed/);
});

test('Upload concurrency accepts timestamp-only changes but blocks invalid timestamps',async()=>{
  for(const [time,allowed]of [['2026-10-22T05:00:00.000-07:00',true],['2026-10-22T12:00:00.001Z',true],['invalid',false],[null,false]]){
    const f=fixture(),account=f.seed('Account',{Name:'Before'}),row=await f.loaded(1,'Account',account,{Name:'After'});
    f.api.confirmUpload=async()=>{f.db.get(account.Id).record.LastModifiedDate=time;return true;};
    if(allowed){const result=await f.api.upload(f.body([row]));assert.equal(result.results[0].success,true);}
    else{await assert.rejects(f.api.upload(f.body([row])),e=>e.code===(time==='invalid'||time===null?'missing-baseline':'salesforce-records-changed'));assert.equal(f.db.get(account.Id).record.Name,'Before');assert.equal(f.calls.filter(c=>c.method).length,0);}
  }
});

test('Timestamp-looking text fields retain literal comparisons',async()=>{
  const f=fixture(),account=f.seed('Account',{Name:'2026-11-01T00:00:00.000Z'});
  const row=await f.loaded(1,'Account',account,{Name:'2026-11-01T00:00:00.000+0000'});
  assert.equal((await f.api.uploader.plan(f.body([row])))[0].changes.Name,row.values.Name);
});

test('Unrelated changes during confirmation are preserved and the conditional PATCH uses the latest timestamp',async()=>{
  const f=fixture(),a=f.seed('Account',{Name:'Original',Phone:'111'}),row=await f.loaded(1,'Account',a,{Name:'Wanted'});
  row.values.LastModifiedDate='2000-01-01T00:00:00.000Z';
  const latest='2026-10-28T15:31:04.000Z';
  f.api.confirmUpload=async()=>{Object.assign(f.db.get(a.Id).record,{Phone:'222',LastModifiedDate:latest});return true;};
  assert.equal((await send(f,f.body([row]))).status,200);
  const patch=f.calls.find(c=>c.method==='PATCH');
  assert.deepEqual(patch.body,{Name:'Wanted'});
  assert.equal(patch.headers['If-Unmodified-Since'],new Date(latest).toUTCString());
  assert.equal(f.db.get(a.Id).record.Phone,'222');
});

test('Graph creates and updates never submit Salesforce audit fields from imported snapshots',async()=>{
  const f=fixture(),a=f.seed('Account',{Name:'Original'}),row=await f.loaded(1,'Account',a,{Name:'Wanted'});
  const audit={LastModifiedDate:'2000-01-01T00:00:00.000Z',LastModifiedById:'005000000000001AAA',SystemModstamp:'2000-01-01T00:00:00.000Z'};
  Object.assign(row.values,audit);
  const body=f.body([row,f.draft(2,'Contact',{Name:'Child',...audit})],[{fromId:2,toId:1,fieldName:'AccountId'}]);
  assert.equal((await send(f,body)).status,200);
  const graphs=f.calls.find(c=>c.route.endsWith('/composite/graph')).body.graphs;
  for(const sub of graphs.flatMap(g=>g.compositeRequest))for(const key of Object.keys(audit))assert.equal(Object.hasOwn(sub.body,key),false);
});

test('Imported Case creation omits IsClosedOnCreate but retains writable status fields',async()=>{
  for(const value of [false,true]){
    const f=fixture();
    f.fields.push({name:'IsClosedOnCreate',type:'boolean',createable:false,updateable:true},{name:'Status',type:'picklist',createable:true,updateable:true});
    const row=f.draft(1,'Case',{Name:'Imported case',Status:'New',IsClosedOnCreate:value});
    const reply=await send(f,f.body([row]));assert.equal(reply.status,200,JSON.stringify(reply));
    const sub=f.calls.find(c=>c.route.endsWith('/composite/graph')).body.graphs[0].compositeRequest[0];
    assert.deepEqual(sub.body,{Name:'Imported case',Status:'New'});
    assert.equal(row.values.IsClosedOnCreate,value,'Keep the imported snapshot intact');
  }
});

test('Existing Case updates still enforce IsClosedOnCreate field permissions',async()=>{
  for(const updateable of [true,false]){
    const f=fixture();f.fields.push({name:'IsClosedOnCreate',type:'boolean',createable:false,updateable});
    const a=f.seed('Case',{Name:'Existing case',IsClosedOnCreate:false});
    const row=await f.loaded(1,'Case',a,{IsClosedOnCreate:true});
    const reply=await send(f,f.body([row]));
    if(updateable){assert.equal(reply.status,200);assert.deepEqual(f.calls.find(c=>c.method==='PATCH').body,{IsClosedOnCreate:true});}
    else{assert.equal(reply.data.error,'unsupported-field');assert.equal(f.calls.filter(c=>c.method).length,0);}
  }
});

test('Older unlinked records omit unchanged read-only snapshot fields but still reject edits to them',async()=>{
  for(const edited of [false,true]){
    const f=fixture();f.fields.push({name:'ReturnedOnly__c',type:'string',createable:false,updateable:false});
    const a=f.seed('Case',{Name:'Original',ReturnedOnly__c:'Read only value'});
    const row=await f.loaded(1,'Case',a,{Name:'New case'});row.loadedFromId=null;
    if(edited)row.values.ReturnedOnly__c='Unauthorized change';
    const reply=await send(f,f.body([row]));
    if(edited){assert.equal(reply.data.error,'unsupported-field');assert.equal(f.calls.filter(c=>c.method).length,0);}
    else{assert.equal(reply.status,200);assert.deepEqual(f.calls.find(c=>c.route.endsWith('/composite/graph')).body.graphs[0].compositeRequest[0].body,{Name:'New case'});}
  }
});

test('Changed deletion targets are blocked after native confirmation',async()=>{
  const f=fixture(),a=f.seed('Account',{Name:'Delete me'});
  f.api.confirmUpload=async()=>{Object.assign(f.db.get(a.Id).record,{Name:'Updated by colleague',LastModifiedDate:'2026-10-28T15:31:04.000Z'});return true;};
  const reply=await send(f,f.body([],[],[{tempId:1,objectName:'Account',sfId:a.Id}]));
  assert.equal(reply.status,409);assert.equal(reply.data.error,'delete-record-changed');assert.match(reply.data.message,/review the deletion/);
  assert.equal(f.calls.filter(c=>c.method).length,0);assert.equal(f.db.has(a.Id),true);
});

test('An imported comparison read does not change the saved original values when upload is cancelled',async()=>{
  const f=fixture(),a=f.seed('Account',{Name:'Original'}),row=await f.loaded(1,'Account',a,{Name:'Wanted'});
  f.api.baselines.clear();f.api.confirmUpload=async()=>false;
  const reply=await send(f,f.body([row]));
  assert.equal(reply.data.error,'upload-cancelled');assert.equal(f.api.baselines.size,0);
  assert.equal(row.loadedValues.Name,'Original');assert.equal(row.values.Name,'Wanted');
  assert.equal(f.calls.filter(c=>c.method).length,0);
});
test('Creates linked parent/child records directly, then replays the durable receipt without another write', async () => {
  const f = fixture(), body = f.body([f.draft(2, 'Contact', { Name: 'Child' }), f.draft(1, 'Account', { Name: 'Parent' })], [{ fromId: 2, toId: 1, fieldName: 'AccountId' }]);
  const result = await f.api.upload(body);
  assert.equal(result.atomicSuccess, true); assert.equal(result.results.length, 2);
  const parent = result.results.find(r => r.tempId === 1).id, child = result.results.find(r => r.tempId === 2).id;
  assert.equal(f.db.get(child).record.AccountId, parent);
  const recreated = new LiveApi(f.client, { secrets: f.secrets, confirmUpload: async () => { throw Error('Must not confirm replay'); } });
  assert.equal((await recreated.upload(body)).idempotentReplay, true);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal((await recreated.uploader.status(body.attemptId)).results.length, 2);
  await assert.rejects(recreated.upload({ ...body, records: [f.draft(3, 'Account', { Name: 'Different' })] }), /different changes/);
  const receipt = [...f.stored.entries()].find(([k]) => k.includes('.receipt.'))[1];
  assert.ok(!receipt.includes('Parent')); assert.ok(!receipt.includes('Child'));
});
test('Updates multiple/custom objects, changes/clears lookups and deletes child before parent with separate native requests', async () => {
  const f = fixture(), account = f.seed('Account', { Name: 'Existing' }), contact = f.seed('Contact', { Name: 'Person', AccountId: account.Id }), custom = f.seed('Project__c', { Name: 'Project' });
  const a = await f.loaded(1, 'Account', account, { Phone: '555-0100' }), c = await f.loaded(2, 'Contact', contact, { AccountId: null }), p = await f.loaded(3, 'Project__c', custom, { Name: 'Updated' });
  assert.equal((await f.api.upload(f.body([a, c, p]))).results.filter(r => r.success).length, 3);
  assert.equal(f.db.get(contact.Id).record.AccountId, null);
  const linked = await f.loaded(2, 'Contact', f.db.get(contact.Id).record);
  const untouched = await f.loaded(1, 'Account', f.db.get(account.Id).record);
  const body = f.body([linked, untouched], [{ fromId: 2, toId: 1, fieldName: 'AccountId' }]); body.skipTempIds = [1];
  await f.api.upload(body); assert.equal(f.db.get(contact.Id).record.AccountId, account.Id);
  await f.api.retrieve('Contact', contact.Id); await f.api.retrieve('Account', account.Id);
  const result = await f.api.upload(f.body([], [], [{ tempId: 1, objectName: 'Account', sfId: account.Id }, { tempId: 2, objectName: 'Contact', sfId: contact.Id }]));
  assert.equal(result.deletes.length, 2); assert.ok(result.deletes.every(r => r.success));
  const deletes=f.calls.filter(c=>c.method==='DELETE');
  assert.deepEqual(deletes.map(c=>c.route.split('/').at(-1)),[contact.Id,account.Id]);
  assert.ok(!f.calls.some(c=>c.route.endsWith('/composite')));
});
test('76 independent creates split across Graph requests; a linked group rolls back together', async () => {
  const f = fixture();
  const result = await f.api.upload(f.body(Array.from({ length: 76 }, (_, i) => f.draft(i + 1, 'Account', { Name: 'Test ' + i }))));
  assert.equal(result.results.length, 76); assert.equal(f.db.size, 76);
  const failure = await f.api.upload(f.body([f.draft(1, 'Account', { Name: 'Will roll back' }), f.draft(2, 'Contact', { Name: 'Reject' })],[{fromId:2,toId:1,fieldName:'AccountId'}]));
  assert.equal(failure.atomicSuccess, false); assert.ok(failure.results.every(r => !r.success)); assert.equal(f.db.size, 76);
  assert.equal(await f.secrets.get(f.api.pendingKey), undefined);
});
test('Permissions, stale data after confirmation, malformed relationships, cycles and excessive uploads fail before writes', async () => {
  for (const kind of ['field', 'permission', 'stale', 'cycle', 'target', 'oversize', 'expression', 'draftSkip', 'duplicate']) {
    const f = fixture(), a = f.seed('Account', { Name: 'Old' });
    let body = f.body([await f.loaded(1, 'Account', a, { Name: 'New' })]);
    if (kind === 'field') body.records[0].values.Readonly = 'x';
    if (kind === 'permission') { const original = f.client.request; f.client.request = async (r, o) => r.includes('UserRecordAccess') ? { records: [] } : original(r, o); }
    if (kind === 'stale') f.api.confirmUpload = async () => { f.db.get(a.Id).record.LastModifiedDate = 'later'; return true; };
    if (kind === 'cycle') { f.fields.find(f=>f.name==='ParentId').nillable=false; body = f.body([f.draft(1, 'Account', { Name: 'A' }), f.draft(2, 'Account', { Name: 'B' })], [{ fromId: 1, toId: 2, fieldName: 'ParentId' }, { fromId: 2, toId: 1, fieldName: 'ParentId' }]); }
    if (kind === 'target') body.associations = [{ fromId: 1, toId: 99, fieldName: 'ParentId' }];
    if (kind === 'oversize') body = f.body(Array.from({ length: 501 }, (_, i) => f.draft(i + 1, 'Account', { Name: 'Too many' })));
    if (kind === 'expression') body.records[0].values.Name = '@{r1.id}';
    if (kind === 'draftSkip') { body = f.body([f.draft(1, 'Account', { Name: 'Draft' })]); body.skipTempIds = [1]; }
    if (kind === 'duplicate') body.records.push({ ...body.records[0], tempId: 2 });
    await assert.rejects(f.api.upload(body), undefined, kind);
    assert.equal(f.calls.filter(c => c.method).length, 0, kind);
  }
});
test('A lost create response remains blocked across restart and cannot be retried automatically', async () => {
  const f = fixture(), original = f.client.request;
  f.client.request = async (r, o) => { const result = await original(r, o); if (o?.method === 'POST') throw Error('Lost response'); return result; };
  const body = f.body([f.draft(1, 'Account', { Name: 'One only' })]);
  await assert.rejects(f.api.upload(body), /outcome is unknown/);
  assert.equal(f.db.size, 1);
  const next = new LiveApi(f.client, { secrets: f.secrets, confirmUpload: async () => true });
  await assert.rejects(next.upload(body), /unconfirmed/);
  assert.match(await next.checkPending(), /remains blocked/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('Unreadable/missing graph results remain unknown; failed local intent prevents any Salesforce write', async () => {
  for (const kind of ['missing', 'malformed', 'journal']) {
    const f = fixture(), original = f.client.request;
    if (kind === 'journal') f.secrets.store = async () => { throw Error('Keychain unavailable'); };
    else f.client.request = async (r, o) => { if (o?.method === 'POST') { if (kind === 'malformed') throw new SalesforceError('Unreadable', 'invalid-response', 502); return { graphs: [] }; } return original(r, o); };
    await assert.rejects(f.api.upload(f.body([f.draft(1, 'Account', { Name: 'Uncertain' })])));
    if (kind === 'journal') assert.equal(f.calls.filter(c => c.method).length, 0);
    else assert.ok(await f.secrets.get(f.api.pendingKey));
  }
});
test('A confirmed local checkpoint can recover a receipt-storage failure without resubmitting', async () => {
  const f = fixture(), original = f.secrets.store;
  f.secrets.store = async (key, value) => { if (key.includes('.receipt.')) throw Error('Receipt failure'); return original(key, value); };
  const body = f.body([f.draft(1, 'Account', { Name: 'Committed' })]);
  await assert.rejects(f.api.upload(body), /Receipt failure/);
  assert.equal(f.db.size, 1);
  f.secrets.store = original;
  assert.match(await f.api.checkPending(), /recovered locally/);
  assert.equal((await f.api.upload(body)).idempotentReplay, true);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('Deletes support more than 25 operations and create dependencies retain the Graph depth limit', async () => {
  const f = fixture(), deletes = [];
  for (let i = 1; i <= 26; i++) {
    const record = f.seed('Account', { Name: 'Delete fixture ' + i });
    await f.api.retrieve('Account', record.Id);
    deletes.push({ tempId: i, objectName: 'Account', sfId: record.Id });
  }
  const deleted = await f.api.upload(f.body([], [], deletes));
  assert.equal(deleted.deletes.filter(r => r.success).length, 26);
  assert.equal(f.db.size, 0);
  assert.equal(f.calls.filter(c=>c.method==='DELETE').length,26);
  const g = fixture(), drafts = Array.from({ length: 16 }, (_, i) => g.draft(i + 1, 'Account', { Name: 'Depth ' + i }));
  const links = drafts.slice(1).map(r => ({ fromId: r.tempId, toId: r.tempId - 1, fieldName: 'ParentId' }));
  await assert.rejects(g.api.upload(g.body(drafts, links)), /15-level/);
  assert.equal(g.calls.filter(c => c.method).length, 0);
});
module.exports = { fixture };

test('mixed object creates and updates split at the payload operation-type limit and preserve all outcomes', async () => {
  const f = fixture(), records = [];
  f.api.metadata.name = async name => name;
  for (let i = 0; i < 8; i++) {
    const name = 'Object' + i + '__c', existing = f.seed(name, {Name:'Before'});
    records.push(f.draft(i * 2 + 1, name, {Name:'Created'}));
    records.push(await f.loaded(i * 2 + 2, name, existing, {Name:'Updated'}));
  }
  const body = f.body(records), result = await f.api.upload(body);
  assert.equal(result.results.length,16);
  assert.ok(result.results.every(r=>r.success));
  assert.equal(f.db.size,16);
  const requests = f.calls.filter(c=>c.route.endsWith('/composite/graph'));
  assert.equal(requests.length,2);
  assert.equal(requests.flatMap(c=>c.body.graphs).length,16);
  await f.api.upload(body);
  assert.equal(f.calls.filter(c=>c.route.endsWith('/composite/graph')).length,2, 'Replaying a confirmed attempt must not create duplicates');
});

test('Graph batching counts deferred PATCHes, upsert HTTP methods and total nodes without splitting connected groups', () => {
  const {Uploads} = require('../src/uploads.cjs'), uploader = new Uploads({});
  let id = 0;
  const op = (objectName, extra = {}) => ({tempId:++id,objectName,mode:'create',changes:{Name:'Draft'},refs:new Map(),...extra});
  const first = Array.from({length:14},(_,i)=>op('Object'+i+'__c'));
  const cycle = [op('Consultant__c',{deferredRefs:new Map([['Manager__c',id+2]])}),op('Consultant__c')];
  const batches = uploader.graphBatches([first,cycle]);
  assert.deepEqual(batches,[[first],[cycle]], 'Deferred PATCH introduces a second operation type');
  const upserts = [op('Account',{external:{field:'Key__c',value:'a'}}),op('Account',{mode:'update',recordId:'001000000000001AAA'})];
  assert.equal(uploader.graphBatches([...Array.from({length:14},(_,i)=>[op('Other'+i+'__c')]),upserts]).length,1, 'Create upsert and update both use PATCH');
  const large = Array.from({length:499},()=>op('Account'));
  assert.deepEqual(uploader.graphBatches([large,cycle]),[[large],[cycle]]);
  assert.throws(()=>uploader.graphBatches([Array.from({length:16},(_,i)=>op('Type'+i+'__c'))]),/connected group/);
});

test('Graph failures roll back only their connected group; successful unrelated groups still commit', async()=>{
  const f=fixture();
  const out=await f.api.upload(f.body([f.draft(1,'Account',{Name:'Keep'}),f.draft(2,'Account',{Name:'Reject'})]));
  assert.equal(out.results.find(r=>r.tempId===1).success,true);
  assert.equal(out.results.find(r=>r.tempId===2).success,false);
  assert.equal(out.graphCount,2);assert.equal(out.atomicSuccess,false);assert.equal(f.db.size,1);
  assert.ok(f.calls.filter(c=>c.method==='POST').every(c=>c.route.endsWith('/composite/graph')));
});

test('Failed child deletion blocks ancestors, while independent deletes and committed creates survive',async()=>{
  const f=fixture(),parent=f.seed('Account',{Name:'Parent'}),child=f.seed('Contact',{Name:'Child',AccountId:parent.Id}),other=f.seed('Account',{Name:'Other'});
  for(const [name,record] of [['Account',parent],['Contact',child],['Account',other]])await f.api.retrieve(name,record.Id);
  const original=f.client.request,attempted=[];
  f.client.request=async(route,options)=>{
    if(options?.method==='DELETE'){attempted.push(route.split('/').at(-1));if(route.endsWith(child.Id))throw new SalesforceError('Deletion blocked','DELETE_FAILED',400);}
    return original(route,options);
  };
  const body=f.body([f.draft(4,'Account',{Name:'New success'})],[],[{tempId:1,objectName:'Account',sfId:parent.Id},{tempId:2,objectName:'Contact',sfId:child.Id},{tempId:3,objectName:'Account',sfId:other.Id}]);
  const out=await f.api.upload(body);
  assert.equal(out.results[0].success,true);assert.deepEqual(attempted,[child.Id,other.Id]);
  assert.equal(out.deletes.find(r=>r.tempId===1).errorCode,'DELETE_DEPENDENCY_FAILED');
  assert.equal(out.deletes.find(r=>r.tempId===3).success,true);assert.ok(f.db.has(parent.Id));
  const before=f.calls.length;assert.equal((await f.api.upload(body)).idempotentReplay,true);assert.ok(f.calls.slice(before).every(c=>!c.method));
});

test('All Graph failures skip deletes; delete dependency cycles leave unrelated records deletable',async()=>{
  const f=fixture(),a=f.seed('Account',{Name:'Keep'});await f.api.retrieve('Account',a.Id);
  const out=await f.api.upload(f.body([f.draft(2,'Account',{Name:'Reject'})],[],[{tempId:1,objectName:'Account',sfId:a.Id}]));
  assert.equal(out.deletes[0].errorCode,'DELETE_SKIPPED_GRAPH_FAILED');assert.ok(f.db.has(a.Id));
  const b=f.seed('Account',{Name:'B',ParentId:a.Id}),c=f.seed('Account',{Name:'Independent'});f.db.get(a.Id).record.ParentId=b.Id;
  for(const record of [a,b,c])await f.api.retrieve('Account',record.Id);
  const deleted=await f.api.upload(f.body([],[],[a,b,c].map((r,i)=>({tempId:i+1,objectName:'Account',sfId:r.Id}))));
  assert.equal(deleted.deletes.filter(r=>r.errorCode==='DELETE_DEPENDENCY_CYCLE').length,2);
  assert.equal(deleted.deletes.find(r=>r.tempId===3).success,true);
});

test('Lost delete response retains earlier Graph outcomes, stops before parents, and blocks replay',async()=>{
  const f=fixture(),parent=f.seed('Account',{Name:'Parent'}),child=f.seed('Contact',{Name:'Child',AccountId:parent.Id});
  await f.api.retrieve('Account',parent.Id);await f.api.retrieve('Contact',child.Id);
  const original=f.client.request;
  f.client.request=async(route,options)=>{const result=await original(route,options);if(options?.method==='DELETE')throw Error('Lost delete response');return result;};
  const body=f.body([f.draft(3,'Account',{Name:'Committed'})],[],[{tempId:1,objectName:'Account',sfId:parent.Id},{tempId:2,objectName:'Contact',sfId:child.Id}]);
  await assert.rejects(f.api.upload(body),/outcome is unknown/);
  assert.ok(f.db.has(parent.Id));assert.ok(!f.db.has(child.Id));
  const status=await f.api.uploader.status(body.attemptId);assert.equal(status.results[0].success,true);assert.deepEqual(status.unknownTempIds,[2]);assert.deepEqual(status.retryableTempIds,[]);
  const next=new LiveApi(f.client,{secrets:f.secrets,confirmUpload:async()=>true});
  await assert.rejects(next.upload(body),/unconfirmed/);assert.match(await next.checkPending(),/1 earlier successes/);
});

test('Journal failure stops before the next delete; recovery never resubmits confirmed work',async()=>{
  const f=fixture(),records=[f.seed('Account',{Name:'A'}),f.seed('Account',{Name:'B'})];
  for(const record of records)await f.api.retrieve('Account',record.Id);
  const store=f.secrets.store;
  f.secrets.store=async(key,value)=>{const data=JSON.parse(value);if(key===f.api.pendingKey&&data.completed?.length===1&&data.inFlight?.length===0)throw Error('Disk failure');return store(key,value);};
  const body=f.body([],[],records.map((r,i)=>({tempId:i+1,objectName:'Account',sfId:r.Id})));
  await assert.rejects(f.api.upload(body),/Disk failure/);assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);assert.equal(f.db.size,1);
  f.secrets.store=store;await assert.rejects(f.api.upload(body),/unconfirmed/);
});

test('Nullable reference cycles are resolved within one atomic Graph and replay does not duplicate writes', async()=>{
 const f=fixture(),body=f.body([f.draft(1,'Account',{Name:'A'}),f.draft(2,'Account',{Name:'B'})],[{fromId:1,toId:2,fieldName:'ParentId'},{fromId:2,toId:1,fieldName:'ParentId'}]);
 const result=await f.api.upload(body);assert.equal(result.results.every(r=>r.success),true);
 const [a,b]=result.results;assert.equal(f.db.get(a.id).record.ParentId,b.id);assert.equal(f.db.get(b.id).record.ParentId,a.id);
 const calls=f.calls.filter(c=>c.route.endsWith('/composite/graph'));assert.equal(calls.length,1);assert.equal(calls[0].body.graphs.length,1);assert.equal(calls[0].body.graphs[0].compositeRequest.length,3);
 await f.api.upload(body);assert.equal(f.calls.filter(c=>c.route.endsWith('/composite/graph')).length,1);
});
test('A failed cyclic graph rolls back both creates and the deferred relationship update', async()=>{
 const f=fixture(),body=f.body([f.draft(1,'Account',{Name:'A'}),f.draft(2,'Account',{Name:'Reject'})],[{fromId:1,toId:2,fieldName:'ParentId'},{fromId:2,toId:1,fieldName:'ParentId'}]);
 const result=await f.api.upload(body);assert.equal(result.results.every(r=>!r.success),true);assert.equal(f.db.size,0);
});
