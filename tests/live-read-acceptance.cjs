'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { SalesforceCli } = require('../src/salesforce-cli.cjs');
const { SalesforceClient, API } = require('../src/salesforce.cjs');
const { LiveApi } = require('../src/live-api.cjs');
async function main() {
  const alias = process.env.ORGLOOM_READ_TEST_ALIAS;
  if (!alias) throw new Error('Set ORGLOOM_READ_TEST_ALIAS to an authorized test org.');
  const cli = new SalesforceCli(), org = (await cli.list()).find(o => o.alias.split(',').includes(alias));
  assert.ok(org, 'Authorized test org required');
  const memory = new Map(), secrets = { get:async k=>memory.get(k), store:async(k,v)=>memory.set(k,v), delete:async k=>memory.delete(k) };
  const client = new SalesforceClient(secrets, { cli });
  await client.accept(await cli.session(org.username, org.orgId));
  const native = client.request.bind(client); let requests = 0;
  client.request = async (resource, options={}) => {
    assert.ok(!options.method || options.method === 'GET', 'All writes prohibited');
    assert.ok(resource.startsWith(API + '/')); assert.doesNotMatch(resource, /apexrest|orgloom__/i);
    requests++; return native(resource, options);
  };
  const api = new LiveApi(client, { secrets, confirmUpload:async()=>false });
  const first = await api.reads.browse({objectName:'Account',limit:1,filters:[{field:'Name',op:'isNotNull'}]});
  assert.ok(first.count > 1, 'Existing Accounts needed for pagination');
  const second = await api.reads.browse({objectName:'Account',limit:1,offset:1,filters:[{field:'Name',op:'isNotNull'}]});
  assert.notEqual(first.records[0].Id, second.records[0].Id);
  const exact = await api.reads.browse({objectName:'Account',search:first.records[0].Id,onCanvasIds:[first.records[0].Id]});
  assert.equal(exact.count,1);assert.equal(exact.loadableCount,0);
  const selected = await api.importQuery({soql:`SELECT Id, Name FROM Account WHERE Id IN ('${first.records[0].Id}', '${second.records[0].Id}') ORDER BY Name LIMIT 2`});
  assert.equal(selected.returned,2);
  const nested = await api.importQuery({soql:'SELECT Id, Name, (SELECT Id, LastName, AccountId FROM Contacts LIMIT 2) FROM Account ORDER BY Name LIMIT 5'});
  assert.ok(nested.records.some(r=>r.objectName==='Contact'), 'Populated existing Account/Contact relationship required');
  assert.ok(nested.associations.length);
  const custom = await api.importQuery({soql:'SELECT Id, Name FROM OLQA_Project__c LIMIT 1'});
  assert.equal(custom.returned,1);
  const report={passed:['Live Browse filter, count and distinct pages','Exact ID search and on-canvas overlap','Selected IDs SOQL import','Nested Contact query and relationship edges','Custom object import'],requests,writes:0,accountMatches:first.count,nestedRecords:nested.returned,nestedEdges:nested.associations.length};
  fs.writeFileSync('test-results/live-read-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  api.dispose();
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
