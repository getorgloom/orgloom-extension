'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LiveApi } = require('../src/live-api.cjs');
const { compileFilter } = require('../src/record-reads.cjs');
const { API } = require('../src/salesforce.cjs');
const ID = '001000000000001AAA', CHILD = '003000000000001AAA';
const fields = [
  { name:'Id',type:'id',filterable:true,sortable:true },
  { name:'Name',type:'string',nameField:true,filterable:true,sortable:true },
  { name:'Subject',type:'string',filterable:true },
  { name:'Revenue',type:'currency',filterable:true },
  { name:'Status',type:'picklist',filterable:true },
  { name:'Active',type:'boolean',filterable:true },
  { name:'Date',type:'date',filterable:true },
  { name:'Updated',type:'datetime',filterable:true },
  { name:'Secret',type:'string',filterable:false },
];
function fixture() {
  const calls=[], desc={name:'Account',fields,childRelationships:[{relationshipName:'Contacts',childSObject:'Contact',field:'AccountId'}]};
  const f={desc,row:{Id:ID,Name:'Account',Revenue:42,LastModifiedDate:'2026-10-21T00:00:00Z'},result:null};
  const client={ publicIdentity:()=>({orgId:'00D000000000001AAA',userId:'005000000000001AAA'}), request:async(route,options={})=>{
    calls.push(route); assert.ok(!options.method || options.method==='GET');
    if(route.endsWith('/sobjects/'))return {sobjects:['Account','Contact','Case','Profile'].map(name=>({name,queryable:true}))};
    if(route.endsWith('/describe'))return route.includes('/Contact/')?{name:'Contact',fields:[...fields,{name:'AccountId',type:'reference',filterable:true}],childRelationships:[]}:desc;
    if(route.includes('/query?')) {
      const q=new URLSearchParams(route.split('?')[1]).get('q');
      if(q.includes('COUNT()'))return {totalSize:q.includes('Id IN')?1:57,records:[]};
      return f.result || {records:[{Id:ID,Name:'Account'}],totalSize:1,done:true};
    }
    if(route.startsWith(API+'/query/'))return f.next;
    if(route.includes('/Contact/'))return {Id:CHILD,Name:'Contact',AccountId:ID};
    if(route.includes('/sobjects/Account/')) {if(f.failRetrieve)throw new Error('read failed');return {...f.row};}
    throw new Error('Unexpected resource');
  }};
  f.api=new LiveApi(client,{secrets:{get:async()=>null},confirmUpload:async()=>false});f.calls=calls;return f;
}
test('Browse counts all matches, pages, sorts, reports overlap and includes filtered columns',async()=>{
  const f=fixture();const r=await f.api.reads.browse({objectName:'Account',limit:25,offset:25,search:"O'Brien_",filters:[{field:'Revenue',op:'gte',value:'1e3'}],sort:{field:'Name',direction:'desc'},onCanvasIds:[ID]});
  assert.equal(r.count,57);assert.equal(r.loadableCount,56);assert.equal(r.hasMore,true);
  assert.deepEqual(r.previewFields,['Id','Name','Revenue']);
  assert.match(r.previewSoql,/Revenue >= 1000/);assert.match(r.previewSoql,/ORDER BY Name DESC NULLS LAST, Id ASC LIMIT 25 OFFSET 25$/);
  assert.ok(r.previewSoql.includes("O\\'Brien\\_"));assert.doesNotMatch(r.loadSoql,/LIMIT|OFFSET/);
});
test('All supported filter types format values safely; malformed fields, values and operators fail closed',()=>{
  const desc={fields};
  for(const [field,op,value,expected] of [['Status','in',['New',"O'Brien"],"Status IN ('New', 'O\\'Brien')"],['Active','equals',false,'Active = false'],['Date','after','2026-10-01','Date > 2026-10-01'],['Updated','before','2026-10-01T10:00:00-07:00','Updated < 2026-10-01T17:00:00.000Z'],['Name','isNull',null,'Name = null'],['Id','equals',ID,`Id = '${ID}'`]]) assert.equal(compileFilter(desc,{field,op,value}),expected);
  for(const filter of [{field:'Name FROM User',op:'equals',value:'x'},{field:'Secret',op:'equals',value:'x'},{field:'Revenue',op:'gt',value:'0 OR Id != null'},{field:'Date',op:'equals',value:'2026-02-30'},{field:'Active',op:'equals',value:'garbage'},{field:'Name',op:'DROP',value:'x'},{field:'Id',op:'equals',value:'bad'}])assert.throws(()=>compileFilter(desc,filter));
});
test('Browse validates sort, pagination, filter bounds, and on-canvas IDs',async()=>{
  for(const body of [{sort:{field:'Name DESC LIMIT 1'}},{offset:-1},{offset:2001},{limit:201},{filters:Array(13).fill({field:'Name',op:'isNull'})},{onCanvasIds:["' OR Id != null"]}]) await assert.rejects(fixture().api.reads.browse({objectName:'Account',...body}));
});
test('Case search includes subject and numeric case name; exact IDs use equality',async()=>{
  const f=fixture();f.desc.name='Case';f.desc.fields=fields.map(v=>v.name==='Name'?{...v,name:'CaseNumber'}:v);
  const r=await f.api.reads.browse({objectName:'Case',search:'outage'});
  assert.match(r.previewSoql,/CaseNumber LIKE/);assert.match(r.previewSoql,/Subject LIKE/);
  assert.match((await f.api.reads.browse({objectName:'Case',search:ID})).previewSoql,/WHERE Id = /);
});
test('SOQL supports nested children, relationship associations, and complete host baselines',async()=>{
  const f=fixture();f.result={records:[{Id:ID,Name:'Account',Contacts:{records:[{Id:CHILD,Name:'Contact',AccountId:ID}],totalSize:1,done:true}}],totalSize:1,done:true};
  const r=await f.api.importQuery({soql:'SELECT Id, Name, (SELECT Id, Name FROM Contacts LIMIT 2) FROM Account LIMIT 1'});
  assert.equal(r.records.length,2);assert.equal(r.records[1].objectName,'Contact');assert.deepEqual(r.associations,[{fromTempId:2,toTempId:1,fieldName:'AccountId'}]);assert.equal(f.api.baselines.size,2);
  assert.equal(r.records[0].values.Revenue,42);
  f.row.Name='Changed externally';f.result=null;await f.api.importQuery({soql:'SELECT Id FROM Account LIMIT 1'});
  assert.equal(f.api.baselines.get('Account:'+ID).Name,'Account');
});
test('SOQL follows safe continuations and imposes outer cap without changing child limits',async()=>{
  const f=fixture();f.result={records:[{Id:ID}],totalSize:2,done:false,nextRecordsUrl:API+'/query/cursor-1'};f.next={records:[{Id:'001000000000002AAA'}],done:true};
  const r=await f.api.importQuery({soql:'SELECT Name FROM Account OFFSET 1',fullFields:false});
  assert.equal(r.returned,2);assert.ok(f.calls.some(v=>decodeURIComponent(v).includes('SELECT Id, Name FROM Account LIMIT 501 OFFSET 1')));assert.equal(r.records[0].values.Revenue,undefined);assert.equal(f.api.baselines.size,2);
  for(const next of ['https://evil.invalid',API+'/sobjects/Account',API+'/query/../token']) {const x=fixture();x.result={...f.result,nextRecordsUrl:next};await assert.rejects(x.api.importQuery({soql:'SELECT Id FROM Account'}),/continuation/);assert.ok(!x.calls.includes(next));}
});
test('SOQL rejects aggregate, locking, comments, malformed and unsupported queries without querying',async()=>{
  for(const soql of ['DELETE FROM Account','SELECT COUNT() FROM Account','SELECT Id FROM Account FOR UPDATE','SELECT Id FROM Account; SELECT Id FROM Contact','SELECT Id FROM Account -- comment',"SELECT Id FROM Account WHERE Name = 'unclosed",'SELECT Id FROM Profile','SELECT Id, (SELECT Id FROM Unknown) FROM Account','SELECT Id FROM Account WHERE Id IN (SELECT Id FROM Profile)']) {
    const f=fixture();await assert.rejects(f.api.importQuery({soql}),undefined,soql);assert.ok(!f.calls.some(v=>v.includes('/query?')),soql);
  }
});
test('Partial child pages and results over the total cap explicitly report truncation',async()=>{
  const f=fixture();f.result={records:[{Id:ID,Contacts:{records:[{Id:CHILD}],done:false,totalSize:2}}],totalSize:1,done:true};
  assert.equal((await f.api.importQuery({soql:'SELECT Id, (SELECT Id FROM Contacts) FROM Account'})).capped,true);
  f.result.records[0].Contacts={records:Array.from({length:500},(_,i)=>({Id:'003'+String(i).padStart(12,'0')+'AAA'})),done:true,totalSize:500};
  const result=await f.api.importQuery({soql:'SELECT Id, (SELECT Id FROM Contacts) FROM Account'});assert.equal(result.records.length,500);assert.equal(result.capped,true);
});

test('Semi/anti-joins filter results without becoming child cards and query length matches native',async()=>{
  const f=fixture();
  const q="SELECT Id, (SELECT Id FROM Contacts WHERE AccountId IN (SELECT Id FROM Account WHERE Name = 'child')) FROM Account WHERE Id NOT IN (SELECT AccountId FROM Contact WHERE Name = 'other') LIMIT 5";
  const result=await f.api.importQuery({soql:q});assert.equal(result.records.length,1);
  assert.ok(f.calls.some(route=>decodeURIComponent(route).includes(q)));
  await f.api.importQuery({soql:'SELECT Id FROM Account WHERE Name = '+"'"+'a'.repeat(12000)+"'"});
  await assert.rejects(f.api.importQuery({soql:'SELECT Id FROM Account '+ ' '.repeat(20001)+'LIMIT 1'}),/20,000/);
  for(const query of ['SELECT Id FROM Account WITH SECURITY_ENFORCED','SELECT Id FROM Account WHERE Id IN (SELECT Id FROM Profile)','SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact FOR UPDATE)'])await assert.rejects(f.api.importQuery({soql:query}));
});
test('Failed full-field retrieval leaves no partial upload baseline; unchanged connection is required',async()=>{
  const f=fixture();f.failRetrieve=true;await assert.rejects(f.api.importQuery({soql:'SELECT Id FROM Account'}));assert.equal(f.api.baselines.size,0);
  f.api.dispose();await assert.rejects(f.api.importQuery({soql:'SELECT Id FROM Account'}),/connection changed/);
});
