'use strict';
// Explicit opt-in. Creates only uniquely named disposable fixtures in a verified
// test org, then cleans up those same IDs. Never edits pre-existing records.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { SalesforceCli } = require('../src/salesforce-cli.cjs');
const { SalesforceClient, API } = require('../src/salesforce.cjs');
const { LiveApi } = require('../src/live-api.cjs');
async function main() {
  const alias = process.env.ORGLOOM_WRITE_TEST_ALIAS;
  if (!alias) throw new Error('Set ORGLOOM_WRITE_TEST_ALIAS to authorize disposable test-record writes.');
  const cli = new SalesforceCli(), org = (await cli.list()).find(o => o.alias.split(',').includes(alias));
  if (!org) throw new Error('Authorized test alias not found.');
  const memory = new Map(), secrets = { get: async k => memory.get(k), store: async (k, v) => memory.set(k, v), delete: async k => memory.delete(k) };
  const client = new SalesforceClient(secrets, { cli });
  await client.accept(await cli.session(org.username, org.orgId));
  const request = client.request.bind(client), calls = [];
  client.request = async (route, options = {}) => {
    assert.ok(route.startsWith(API + '/'), 'Only native Salesforce REST resources');
    assert.doesNotMatch(route, /apex|ContentVersion|ContentDocument|orgloom__/i, 'No package, canvas-file or key endpoints');
    for (const graph of options.body?.graphs || []) for (const sub of graph.compositeRequest) {
      assert.ok(sub.url.startsWith(API + '/sobjects/'));
      assert.doesNotMatch(sub.url, /apex|ContentVersion|ContentDocument|orgloom__/i);
    }
    for (const sub of options.body?.compositeRequest || []) {
      assert.ok(sub.url.startsWith(API + '/sobjects/'));
      assert.doesNotMatch(sub.url, /apex|ContentVersion|ContentDocument|orgloom__/i);
    }
    calls.push({ resource: route.split('?')[0].replace(/[A-Za-z0-9]{18}$/, ':id'), method: options.method || 'GET' });
    return request(route, options);
  };
  const name = 'Org Loom desktop upload test ' + randomUUID(), created = [];
  let api;
  try {
    const seed = await client.request(API + '/sobjects/Account', { method: 'POST', body: { Name: name, Phone: '555-0100' }, retry: false });
    assert.ok(seed.id); created.push({ object: 'Account', id: seed.id });
    api = new LiveApi(client, { secrets, confirmUpload: async plan => {
      assert.equal(plan.recordId, seed.id);
      assert.equal(plan.baseline.Name, name);
      return true;
    } });
    const record = await api.retrieve('Account', seed.id);
    const result = await api.upload({ attemptId: randomUUID(), expectedSfOrgId: api.orgId, records: [{ tempId: 1, objectName: 'Account', loadedFromId: seed.id, loadedValues: record, values: { ...record, Phone: '555-0101' } }], associations: [], deletes: [] });
    assert.equal(result.results[0].success, true);
    assert.equal((await api.retrieve('Account', seed.id)).Phone, '555-0101');
    console.log('Live narrow upload passed; Salesforce field value verified.');
    api.confirmUpload = async plan => {
      for (const op of plan.operations) {
        if (op.mode === 'create') assert.ok(String(op.changes.Name || op.changes.LastName || op.changes.FirstName || '').startsWith(name));
        else assert.ok(created.some(r => r.id === op.recordId), 'Only fixtures owned by this run may change');
      }
      return true;
    };
    const makeBody = (records, associations = [], deletes = []) => ({ attemptId: randomUUID(), expectedSfOrgId: api.orgId, records, associations, deletes });
    const createBody = makeBody([
      { tempId: 2, objectName: 'Contact', values: { LastName: name + ' contact' } },
      { tempId: 1, objectName: 'Account', values: { Name: name + ' parent' } },
    ], [{ fromId: 2, toId: 1, fieldName: 'AccountId' }]);
    const made = await api.upload(createBody);
    assert.ok(made.atomicSuccess, JSON.stringify(made.results));
    for (const row of made.results) created.push({ object: row.objectName, id: row.id });
    const parent = made.results.find(r => r.tempId === 1).id, child = made.results.find(r => r.tempId === 2).id;
    assert.equal((await api.retrieve('Contact', child)).AccountId, parent);
    assert.equal((await api.upload(createBody)).idempotentReplay, true);
    const existing = async (tempId, objectName, id, changes = {}) => { const baseline = await api.retrieve(objectName, id); return { tempId, objectName, loadedFromId: id, loadedValues: baseline, values: { ...baseline, ...changes } }; };
    const update = makeBody([
      await existing(1, 'Account', parent, { Phone: '555-0102' }),
      await existing(2, 'Contact', child, { Phone: '555-0103' }),
      await existing(3, 'Account', seed.id),
    ], [{ fromId: 2, toId: 3, fieldName: 'AccountId' }]); update.skipTempIds = [3];
    assert.ok((await api.upload(update)).atomicSuccess);
    assert.equal((await api.retrieve('Contact', child)).AccountId, seed.id);
    assert.equal((await api.retrieve('Account', parent)).Phone, '555-0102');
    assert.ok((await api.upload(makeBody([await existing(2, 'Contact', child, { AccountId: null })]))).atomicSuccess);
    assert.equal((await api.retrieve('Contact', child)).AccountId, null);
    const relink = makeBody([await existing(2, 'Contact', child), await existing(1, 'Account', parent)], [{ fromId: 2, toId: 1, fieldName: 'AccountId' }]); relink.skipTempIds = [1];
    assert.ok((await api.upload(relink)).atomicSuccess);
    const rollbackName = name + ' rollback';
    const rollback = await api.upload(makeBody([{ tempId: 1, objectName: 'Account', values: { Name: rollbackName } }, { tempId: 2, objectName: 'Contact', values: { FirstName: name + ' invalid' } }], [{fromId:2,toId:1,fieldName:'AccountId'}]));
    assert.equal(rollback.atomicSuccess, false);
    assert.ok(rollback.results.every(r => !r.success));
    assert.equal((await api.query("SELECT Id FROM Account WHERE Name = '" + rollbackName + "'")).records.length, 0);
    const partial = await api.upload(makeBody([{tempId:1,objectName:'Account',values:{Name:name+' independent'}},{tempId:2,objectName:'Contact',values:{FirstName:name+' rejected'}}]));
    for(const row of partial.results.filter(r=>r.success))created.push({object:row.objectName,id:row.id});
    assert.equal(partial.results.find(r=>r.tempId===1).success,true);
    assert.equal(partial.results.find(r=>r.tempId===2).success,false);
    await api.retrieve('Contact', child); await api.retrieve('Account', parent);
    const deleted = await api.upload(makeBody([], [], [{ tempId: 1, objectName: 'Account', sfId: parent }, { tempId: 2, objectName: 'Contact', sfId: child }]));
    assert.ok(deleted.deletes.every(r => r.success), JSON.stringify(deleted.deletes));
    assert.equal((await api.query("SELECT Id FROM Account WHERE Id = '" + parent + "'")).records.length, 0);
    assert.equal((await api.query("SELECT Id FROM Contact WHERE Id = '" + child + "'")).records.length, 0);
    fs.writeFileSync('test-results/live-upload-acceptance.json', JSON.stringify({ version:'0.7.1', time:new Date().toISOString(), mode: 'Live disposable test-org records', passed: ['Conditional single-record update', 'Related Account/Contact creates', 'Completed-attempt replay without duplicate writes', 'Multi-record updates and reparenting', 'Lookup clearing', 'Validation error rolls back a connected group', 'Unrelated Graph group succeeds when another fails', 'Child-first native DELETE requests', 'Package/key/file endpoints forbidden'], nativeResources: [...new Set(calls.map(c => c.method + ' ' + c.resource))], cleanup: 'Pending finally block' }, null, 2));
    console.log('Live create, update, link, clear, rollback, replay and delete acceptance passed.');
  } finally {
    api?.dispose();
    for (const item of created.reverse()) {
      try { await client.request(API + '/sobjects/' + item.object + '/' + item.id, { method: 'DELETE', retry: false }); }
      catch (error) { if (![404, 410].includes(error.status)) throw error; }
    }
    const reportPath = 'test-results/live-upload-acceptance.json';
    if (fs.existsSync(reportPath)) { const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); report.cleanup = 'Disposable fixtures deleted'; fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); }
    console.log('Disposable fixture cleanup completed.');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
