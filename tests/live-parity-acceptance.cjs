'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const {SalesforceCli}=require('../src/salesforce-cli.cjs');
const {SalesforceClient,API}=require('../src/salesforce.cjs');
const {LiveApi}=require('../src/live-api.cjs');
(async()=>{
 const alias=process.env.ORGLOOM_READ_TEST_ALIAS;
 if(!alias)throw Error('Set ORGLOOM_READ_TEST_ALIAS to an authorized test org.');
 const cli=new SalesforceCli(), org=(await cli.list()).find(o=>o.alias.split(',').includes(alias));
 assert.ok(org,'Authorized test org required');
 const map=new Map(),secrets={get:async k=>map.get(k),store:async(k,v)=>map.set(k,v),delete:async k=>map.delete(k)};
 const client=new SalesforceClient(secrets,{cli});await client.accept(await cli.session(org.username,org.orgId));
 const native=client.request.bind(client);let requests=0;
 client.request=async(p,o={})=>{assert.equal(o.method||'GET','GET');assert.ok(p.startsWith(API+'/'));assert.doesNotMatch(p,/apexrest|ContentVersion|ContentDocument|loom__/i);requests++;return native(p,o);};
 const api=new LiveApi(client,{secrets,confirmUpload:async()=>false});
 const msg=(path,body,method='POST')=>api.handle({type:'live-api',id:1,path,body,method});
 try{
  const browse=await api.reads.browse({objectName:'Account',limit:1,filters:[{field:'Name',op:'isNotNull'}]});
  assert.ok(browse.records.length,'At least one existing Account required');
  const account=browse.records[0];
  const matched=await msg('/api/migrate/match',{objectName:'Account',keyField:'Name',values:[account.Name]});
  assert.equal(matched.status,200);assert.ok(matched.data.candidatesByValue[account.Name].some(r=>r.id===account.Id));
  const pasted=await msg('/api/desktop/record-link',{recordId:account.Id});
  assert.equal(pasted.status,200);assert.equal(pasted.data.records[0].loadedFromId,account.Id);
  const lookup=await msg('/api/objects/Account/lookup?fieldName=ParentId&targetApiName=Account&sourceRecordId='+account.Id,null,'GET');
  assert.equal(lookup.status,200);assert.ok(lookup.data.records.every(r=>r.id!==account.Id));
  const rules=await msg('/api/objects/Account/validation-rules',null,'GET');assert.equal(rules.status,200);
  const joined=await api.importQuery({soql:'SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE AccountId != null) LIMIT 2'});assert.ok(joined.records.length<=2);
  const refreshed=await msg('/api/records/refresh',{records:[{tempId:1,objectName:'Account',sfId:account.Id},{tempId:2,objectName:'Account',sfId:'001000000000000'}]});assert.equal(refreshed.status,200);assert.equal(refreshed.data.results[0].ok,true);assert.equal(refreshed.data.results[1].ok,false);
  const {authorizeRecovery}=require('../src/recovery-access.cjs');
  const record=await api.retrieve('Account',account.Id),identityKey=`desktop:${api.orgId}:${api.userId}`,draftKey='orgloom:canvas-draft:v1|'+identityKey+':new';
  const recovery={time:Date.now(),state:{version:1,local:{},session:{[draftKey]:JSON.stringify({v:1,ts:Date.now(),identity:identityKey,scope:identityKey+':new',state:{bulkRecords:[{id:1,objectName:'Account',loadedFromId:record.Id,values:record,loadedValues:record}],bulkAssociations:[],selectedObjects:[]}})}},baselines:[...api.baselines]};
  const checked=await authorizeRecovery(api,recovery);assert.equal(JSON.parse(checked.state.session[draftKey]).state.bulkRecords.length,1);
  const report={orgAlias:alias,passed:['Destination migration matching by name','Record link resolves object and loads host baseline','Self record excluded from lookup suggestions','Validation rules return supported or explicitly unavailable result','Live semi-join import','Live partial refresh with missing record','Recovery revalidates current object, field and record access'],validationRulesAvailable:Array.isArray(rules.data),requests,writes:0,packageEndpoints:0};
  fs.writeFileSync('test-results/live-parity-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{api.dispose();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
