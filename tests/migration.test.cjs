const {test}=require('node:test'),assert=require('node:assert/strict');
const {stage,destinationPayload,isMigration}=require('../webview/migration.js');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../vendor/upstream/packages/canvas/src/public/js/migrate-annotate.js'),'utf8'),context);
const engine=context.window.Orgloom.migrateAnnotate;

test('Apply independently rejects incompatible and unavailable lookups without mutating the plan',()=>{
  for(const field of [null,{name:'Primary__c',type:'string'},{name:'Primary__c',type:'reference',referenceTo:['Account'],createable:true}]){
    const records=[{id:1,objectName:'Project__c',values:{}},{id:2,objectName:'Contact',values:{Name:'Morgan'}}];
    const edges=[{fromId:1,toId:2,fieldName:'Primary__c'}],before=JSON.stringify({records,edges});
    assert.throws(()=>engine.applyMigrationPlan(records,edges,{}, {},{Project__c:{fields:field?[field]:[]}}),/lookup field|accepts Account/);
    assert.equal(JSON.stringify({records,edges}),before);
  }
});

test('omitting an incompatible optional lookup preserves the matched destination value',()=>{
  const records=[{id:1,objectName:'Project__c',_migrateMatchedId:'a00DEST',_migrateRelationshipRemap:{Primary__c:''},values:{Primary__c:'003SOURCE'}},{id:2,objectName:'Contact',values:{Name:'Morgan'}}];
  const edges=[{fromId:1,toId:2,fieldName:'Primary__c'}];
  engine.applyMigrationPlan(records,edges,{}, {'Project__c::a00DEST':{Id:'a00DEST',Primary__c:'001KEEP'}},{Project__c:{fields:[{name:'Primary__c',type:'reference',referenceTo:['Account'],updateable:true,nillable:true}]}});
  assert.equal(records[0].values.Primary__c,'001KEEP');assert.equal(edges.length,0);
  assert.equal(records[0]._migrateRelationshipRemap,undefined);
});

test('omitting a required lookup on a new record remains blocked',()=>{
  const records=[{id:1,objectName:'Project__c',_migrateRelationshipRemap:{Primary__c:''},values:{}},{id:2,objectName:'Contact',values:{}}];
  assert.throws(()=>engine.applyMigrationPlan(records,[{fromId:1,toId:2,fieldName:'Primary__c'}],{}, {},{Project__c:{fields:[{name:'Primary__c',type:'reference',referenceTo:['Account'],createable:true,nillable:false}]}}),/still requires Primary__c/);
});
const account={name:'Account',fields:[{name:'Name',type:'string',createable:true,updateable:true,required:true},{name:'ParentId',type:'reference',referenceTo:['Account'],createable:true,updateable:true},{name:'CreatedDate',type:'datetime',createable:false,updateable:false}]};
test('migration preserves the original lookup when an existing record is linked to a new draft',()=>{
  const state={describeCache:{Account:account},bulkRecords:[
    {id:1,objectName:'Account',loadedFromId:'001000000000001AAA',values:{Name:'Child'},loadedValues:{Name:'Child',ParentId:'001000000000002AAA'}},
    {id:2,objectName:'Account',values:{Name:'New parent'}}
  ],bulkAssociations:[{fromId:1,toId:2,fieldName:'ParentId'}]};
  const imported=destinationPayload(state,'destination').records[0];
  assert.equal(imported.values.ParentId,undefined);
  assert.equal({...imported.values,...imported.originalValues}.ParentId,'001000000000002AAA');
  assert.equal(state.bulkRecords[0].values.ParentId,undefined);
});
test('migration staging strips source identities and grants without mutating file or active canvas',()=>{
  const file={_meta:{forMigration:true},records:[{id:1,objectName:'Account',loadedFromId:'source',_uploadAttempt:{token:'stale'},values:{Id:'source',Name:'Source',ParentId:'source-parent',OwnerId:'source-user',CustomerId:'external-key'},slot:{kind:'fields',fields:['Name']}}],associations:[]};
  const original=JSON.stringify(file),state=stage(file,{Account:account});
  assert.equal(isMigration(file),true);assert.equal(JSON.stringify(file),original);
  assert.deepEqual(state.bulkRecords[0].values,{Name:'Source',CustomerId:'external-key'});assert.equal(state.bulkRecords[0].loadedFromId,undefined);
  assert.equal(state.bulkRecords[0].slot,undefined);assert.equal(state.bulkRecords[0]._uploadAttempt,undefined);
});
test('shared planner maps destination IDs and rebuilds child references from edges',()=>{
  const file={_meta:{forMigration:true},records:[{id:1,objectName:'Account',values:{Name:'Parent'}},{id:2,objectName:'Account',values:{Name:'Child',ParentId:'source'}}],associations:[{fromId:2,toId:1,fieldName:'ParentId'}]};
  const state=stage(file,{Account:account});state.bulkRecords[0]._migrateMatchedId='001000000000001AAA';state.bulkRecords[0].loadedFromId='001000000000001AAA';
  const annotations=engine.annotateRecords(state.bulkRecords,state.describeCache);
  engine.applyMigrationPlan(state.bulkRecords,state.bulkAssociations,Object.fromEntries(state.bulkRecords.map((r,i)=>[r.id,annotations[i]])),{'Account::001000000000001AAA':{Id:'001000000000001AAA',Name:'Old',CreatedDate:'2020-01-01'}},state.describeCache);
  const result=destinationPayload(state,'destination-org');
  assert.equal(result.records[1].values.ParentId,'001000000000001AAA');assert.equal(result.records[0].loadedFromId,'001000000000001AAA');
  assert.equal(result.records[0].values.CreatedDate,undefined);assert.equal(result.records[0].originalValues.Name,'Old');assert.equal(isMigration(result),false);
});
test('delete migration cannot apply until a destination match is selected',()=>{
  const state=stage({_meta:{forMigration:true},records:[{id:1,objectName:'Account',pendingDelete:true,loadedFromId:'source',values:{Name:'Delete me',Id:'source'}}],associations:[]},{Account:account});
  assert.throws(()=>engine.applyMigrationPlan(state.bulkRecords,[],{},{},state.describeCache),/destination record/);
});

for(const pendingDelete of [false,true])test('migration preserves destination concurrency baseline for '+(pendingDelete?'deletion':'update'),()=>{
  const timestamp='2026-10-27T12:34:56.000Z';
  const state=stage({records:[{id:1,objectName:'Account',pendingDelete,values:{Name:'Migrated edit',LastModifiedDate:'2020-01-01T00:00:00.000Z'}}],associations:[]},{Account:account});
  const record=state.bulkRecords[0];record._migrateMatchedId='001000000000001AAA';
  const annotations=engine.annotateRecords(state.bulkRecords,state.describeCache);
  engine.applyMigrationPlan(state.bulkRecords,[],{1:annotations[0]},{'Account::001000000000001AAA':{Id:'001000000000001AAA',Name:'Destination name',LastModifiedDate:timestamp}},state.describeCache);
  const imported=destinationPayload(state,'destination-org').records[0];
  assert.equal(imported.values.LastModifiedDate,timestamp);
  // The shared snapshot-with-changes importer reconstructs loadedValues this way.
  const loadedValues={...imported.values,...imported.originalValues};
  assert.equal(loadedValues.LastModifiedDate,timestamp);
  assert.equal(loadedValues.Name,'Destination name');
  assert.equal(imported.values.Name,pendingDelete?'Destination name':'Migrated edit');
  assert.equal(Boolean(imported.pendingDelete),pendingDelete);
});

test('new migration drafts never inherit a source concurrency timestamp',()=>{
  const state=stage({records:[{id:1,objectName:'Account',values:{Name:'New',LastModifiedDate:'2020-01-01T00:00:00.000Z'}}],associations:[]},{Account:account});
  assert.equal(destinationPayload(state,'destination-org').records[0].values.LastModifiedDate,undefined);
});

test('foreign normal exports trigger reconciliation even without the migration marker',()=>{
  assert.equal(isMigration({_meta:{exportedFrom:'source-org'},records:[]},'destination-org'),true);
  assert.equal(isMigration({_meta:{exportedFrom:'same-org'},records:[]},'same-org'),false);
});

test('completed whole-record requests and their links survive migration; empty requests are counted',()=>{
  const file={_meta:{forMigration:true},records:[
    {id:1,objectName:'Account',values:{Name:'Requested parent'},slot:{kind:'whole-record',origin:'standalone',slotId:1}},
    {id:2,objectName:'Account',values:{Name:'Child'},slot:{kind:'fields',fields:['Name']}},
    {id:3,objectName:'Account',values:{Name:''},slot:{kind:'whole-record',slotId:3}},
    {id:4,objectName:'Account',loadedFromId:'source',values:{},slot:{kind:'whole-record',slotId:4}},
    {id:5,objectName:'Account',values:{Active__c:false},slot:{slotId:5}},
    {id:6,objectName:'Account',isPending:true,values:{Name:'Pending'}},
  ],associations:[{fromId:2,toId:1,fieldName:'ParentId'},{fromId:2,toId:3,fieldName:'Other__c'}]};
  const original=JSON.stringify(file),state=stage(file,{Account:account});
  assert.deepEqual(state.bulkRecords.map(r=>r.id),[1,2,4,5]);
  assert.equal(state.omittedRequests,1);
  assert.deepEqual(state.bulkAssociations,[file.associations[0]]);
  assert.equal(state.bulkRecords[0].values.Name,'Requested parent');
  assert.ok(state.bulkRecords.every(r=>!r.slot&&!r.loadedFromId));
  assert.equal(JSON.stringify(file),original);
});
