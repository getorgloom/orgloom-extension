'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LiveApi } = require('../src/live-api.cjs');
const { API, SalesforceError } = require('../src/salesforce.cjs');
const { parseRecordLink } = require('../webview/record-paste.js');
const { assertImportSource } = require('../webview/import-guard.js');
const ORG = '00D000000000001AAA', ID = '001000000000001AAA';
function fixture() {
  const calls = [], values = new Map();
  const fields = [{name:'Id',type:'id',filterable:true}, {name:'Name',nameField:true,type:'string',filterable:true}, {name:'Amount__c',type:'double',filterable:true}, {name:'ParentId',type:'reference',referenceTo:['Account'],filterable:true}];
  const client = { publicIdentity: () => ({orgId:ORG,userId:'005000000000001AAA',instanceUrl:'https://example.my.salesforce.com'}), request: async (path, options={}) => {
    calls.push({path,options});
    assert.equal(options.method || 'GET', 'GET', 'parity reads cannot write');
    if(path.endsWith('/sobjects/')) return {sobjects:[{name:'Account',queryable:true,keyPrefix:'001'}]};
    if(path.endsWith('/describe')) return {name:'Account',fields,recordTypeInfos:[]};
    if(path.includes('/ui-api/')) throw new SalesforceError('Not supported','unsupported',404);
    return {records:[{Id:ID,Name:"O'Connor",Amount__c:5}],done:true,totalSize:1};
  }};
  const api = new LiveApi(client,{secrets:{get:async k=>values.get(k),store:async(k,v)=>values.set(k,v)},confirmUpload:async()=>false});
  const request = (path, body, method='POST') => api.handle({type:'live-api',id:1,path,method,body});
  return {api,client,calls,request};
}
test('migration matching uses destination-only typed queries and preserves ambiguous candidates', async()=>{
  const f=fixture();
  let result=await f.request('/api/migrate/match',{objectName:'Account',keyField:'Name',values:["O'Connor"]});
  assert.equal(result.status,200);assert.equal(result.data.candidatesByValue["O'Connor"][0].id,ID);
  assert.match(decodeURIComponent(f.calls.at(-1).path),/Name = 'O\\'Connor'/);
  result=await f.request('/api/migrate/match',{objectName:'Account',keyField:'Amount__c',values:['5']});
  assert.equal(result.status,200);assert.match(decodeURIComponent(f.calls.at(-1).path),/Amount__c = 5/);
  for(const body of [{keyField:'Id',values:[ID]},{keyField:'ParentId',values:[ID]},{keyField:'Name',values:[]},{keyField:'Name',values:Array(101).fill('x')},{keyField:'Amount__c',values:['0 OR Id != null']},{keyField:'Name FROM User',values:['x']}]) {
    const before=f.calls.filter(c=>c.path.includes('/query?')).length;
    assert.ok((await f.request('/api/migrate/match',{objectName:'Account',...body})).status>=400);
    assert.equal(f.calls.filter(c=>c.path.includes('/query?')).length,before);
  }
  const original=f.client.request;
  f.client.request=async(p,o)=>p.includes('/query?')?{records:[{Id:ID,Name:'same'},{Id:'001000000000002AAA',Name:'same'}],done:true}:original(p,o);
  result=await f.request('/api/migrate/match',{objectName:'Account',keyField:'Name',values:['same']});
  assert.equal(result.data.candidatesByValue.same.length,2);
  f.client.request=async(p,o)=>p.includes('/query?')?{records:Array(501).fill({Id:ID,Name:'same'}),done:true}:original(p,o);
  assert.equal((await f.request('/api/migrate/match',{objectName:'Account',keyField:'Name',values:['same']})).status,400);
});
test('lookup excludes edited record before limit and refuses malformed source IDs',async()=>{
  const f=fixture(), url='/api/objects/Account/lookup?fieldName=ParentId&targetApiName=Account&sourceRecordId=';
  assert.equal((await f.request(url+ID,null,'GET')).status,200);
  assert.match(decodeURIComponent(f.calls.at(-1).path),new RegExp("Id != '"+ID+"'.*LIMIT 20"));
  assert.equal((await f.request(url+'bad',null,'GET')).status,400);
});
test('record link paste accepts only the connected org and cannot load setup or unknown IDs',async()=>{
  const origins=['https://example.lightning.force.com','https://example.my.salesforce.com'];
  assert.equal(parseRecordLink(origins[0]+'/lightning/r/Account/'+ID+'/view',origins).recordId,ID);
  assert.ok(parseRecordLink('https://other.lightning.force.com/'+ID,origins).error);
  assert.ok(parseRecordLink('https://example.my.salesforce.com@evil.test/'+ID,origins).error);
  const f=fixture();let queried;
  f.api.importQuery=async b=>{queried=b;return {records:[]};};
  assert.equal((await f.request('/api/desktop/record-link',{recordId:ID})).status,200);
  assert.equal(queried.soql,"SELECT Id FROM Account WHERE Id = '"+ID+"'");
  assert.equal((await f.request('/api/desktop/record-link',{recordId:'005000000000001AAA'})).status,400);
});
test('native-only services remain unavailable and local editing gates work without a package',async()=>{
  const f=fixture();
  for(const feature of ['bulk-edit-records','run-script','auto-fill-records']) assert.equal((await f.request('/api/capabilities/'+feature+'/check',{})).data.allowed,true);
  for(const path of ['/api/canvases','/api/canvas-share','/api/capabilities/share-canvas/check','/api/capabilities/save-canvas/check']) assert.equal((await f.request(path,{})).status,501);
  assert.ok(f.calls.every(c=>!c.path.includes('/apexrest/')&&!c.path.includes('loom__')));
});
test('ordinary imports cannot bypass cross-org reconciliation',()=>{
  assert.throws(()=>assertImportSource({_meta:{exportedFrom:'00D000000000002AAA'},records:[{}]},ORG),/another Salesforce org/);
  assert.throws(()=>assertImportSource({records:[{}]},ORG),/source org/);
  assert.doesNotThrow(()=>assertImportSource({_meta:{exportedFrom:ORG},records:[{}]},ORG));
});
