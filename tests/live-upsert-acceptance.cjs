'use strict';
// Opt-in writes to disposable fixtures only. Requires the existing QA schema.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { SalesforceCli } = require('../src/salesforce-cli.cjs');
const { SalesforceClient, API } = require('../src/salesforce.cjs');
const { LiveApi } = require('../src/live-api.cjs');
async function main() {
  const alias = process.env.ORGLOOM_WRITE_TEST_ALIAS;
  if (!alias) throw Error('Set ORGLOOM_WRITE_TEST_ALIAS to authorize disposable test writes.');
  const cli = new SalesforceCli(), org = (await cli.list()).find(o => o.alias.split(',').includes(alias));
  assert.ok(org, 'Authorized test org');
  const memory = new Map(), secrets = {get:async k=>memory.get(k),store:async(k,v)=>memory.set(k,v),delete:async k=>memory.delete(k)};
  const client = new SalesforceClient(secrets,{cli});
  await client.accept(await cli.session(org.username,org.orgId));
  assert.ok(['sandbox','developer'].includes(client.publicIdentity().orgType), 'Test org only');
  const request = client.request.bind(client), calls=[];
  client.request=async(route,options={})=>{
    assert.ok(route.startsWith(API+'/'));
    assert.doesNotMatch(route,/apex|ContentVersion|ContentDocument|orgloom__/i);
    for(const graph of options.body?.graphs||[]) for(const sub of graph.compositeRequest) {
      assert.ok(sub.url.startsWith(API+'/sobjects/OLQA_Project__c/'));
      assert.ok(sub.url.includes('/Seed_Key__c/'+prefix));
    }
    calls.push({method:options.method||'GET',resource:route.split('?')[0],duplicateOverride:!!options.headers?.['Sforce-Duplicate-Rule-Header']});
    return request(route,options);
  };
  const prefix='OLVS'+randomUUID().replaceAll('-',''), keys=[prefix+'A',prefix+'B'];
  let account,api,cleaned=false;
  try {
    const desc=await client.request(API+'/sobjects/OLQA_Project__c/describe');
    assert.ok(desc.fields.some(f=>f.name==='Seed_Key__c'&&f.externalId&&f.updateable&&f.createable));
    account=(await client.request(API+'/sobjects/Account',{method:'POST',body:{Name:prefix},retry:false})).id;
    assert.ok(account);
    const existing=(await client.request(API+'/sobjects/OLQA_Project__c',{method:'POST',body:{Name:prefix+' old',Seed_Key__c:keys[0],Customer__c:account},retry:false})).id;
    api=new LiveApi(client,{secrets,confirmUpload:async plan=>{
      assert.equal(plan.operations.length,2);
      for(const op of plan.operations) {assert.equal(op.mode,'upsert');assert.ok(keys.includes(op.external.value));assert.equal(op.changes.Customer__c||op.baseline?.Customer__c,account);}
      return true;
    }});
    const records=keys.map((key,i)=>({tempId:i+1,objectName:'OLQA_Project__c',_csvOperation:'upsert',_csvExternalIdField:'Seed_Key__c',values:{Name:prefix+' new '+i,Seed_Key__c:key,Customer__c:account}}));
    const body={attemptId:randomUUID(),expectedSfOrgId:api.orgId,records,deletes:[],associations:[],allowDuplicates:true};
    const result=await api.upload(body);
    assert.deepEqual(result.results.map(r=>[r.success,r.mode]),[[true,'update'],[true,'create']]);
    assert.equal(result.results[0].id,existing);
    for(const row of result.results) assert.equal((await api.retrieve('OLQA_Project__c',row.id)).Name,prefix+' new '+(row.tempId-1));
    const before=calls.filter(c=>c.method==='POST').length;
    assert.equal((await api.upload(body)).idempotentReplay,true);
    assert.equal(calls.filter(c=>c.method==='POST').length,before);
    console.log('Live External ID Graph insert/update and receipt replay passed.');
  } finally {
    api?.dispose();
    if(account) {
      // A response can be lost, so locate only this run's unique keys for cleanup.
      const q="SELECT Id FROM OLQA_Project__c WHERE Seed_Key__c IN ('"+keys.join("','")+"')";
      const rows=await client.request(API+'/query?q='+encodeURIComponent(q));
      for(const row of rows.records) await client.request(API+'/sobjects/OLQA_Project__c/'+row.Id,{method:'DELETE',retry:false});
      await client.request(API+'/sobjects/Account/'+account,{method:'DELETE',retry:false});
      cleaned=true;
    }
  }
  fs.writeFileSync('test-results/live-upsert-acceptance.json',JSON.stringify({date:new Date().toISOString(),version:require('../package.json').version,passed:['Native Graph External ID update and insert','Actual created flag and IDs','Duplicate-rule header accepted by Graph (no duplicate rule triggered)','Receipt replay avoids another write'],cleaned,packageEndpoints:0},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
