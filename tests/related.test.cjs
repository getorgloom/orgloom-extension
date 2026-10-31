'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LiveApi } = require('../src/live-api.cjs');
const { API, SalesforceError } = require('../src/salesforce.cjs');
const ACCOUNT = '001000000000001AAA', RECORD = 'a00000000000001AAA';
function fixture() {
  const calls = [], fields = [
    { name: 'Id', type: 'id' }, { name: 'Name', type: 'string', nameField: true, filterable: true },
    { name: 'Account__c', type: 'reference', filterable: true, referenceTo: ['Account'] },
    { name: 'Blocked__c', type: 'reference', filterable: false },
    { name: 'Address__c', type: 'address' }, { name: 'LastModifiedDate', type: 'datetime' },
  ];
  const row = { Id: RECORD, Name: 'Related project', Account__c: ACCOUNT, LastModifiedDate: '2026-10-22T12:00:00.000Z' };
  const client = { publicIdentity: () => ({ orgId: '00D000000000001AAA', userId: '005000000000001AAA' }), request: async (route, options) => {
    calls.push({ route, options });
    if (route.endsWith('/sobjects/')) return { sobjects: [{ name: 'Project__c', queryable: true }] };
    if (route.endsWith('/describe')) return { fields, childRelationships: [] };
    if (route.includes('/query?')) return { totalSize: 1, done: true, records: decodeURIComponent(route).includes('COUNT()') ? [] : [{ ...row }] };
    throw new Error('Unexpected fixture request');
  } };
  const api = new LiveApi(client, { secrets: { get: async () => null }, confirmUpload: async () => false });
  const get = (action, params = {}) => api.handle({ type: 'live-api', id: 1, method: 'GET', path: '/api/objects/Project__c/' + action + '?' + new URLSearchParams({ field: 'Account__c', id: ACCOUNT, ...params }) });
  return { api, client, fields, row, calls, get };
}
test('Related reads preserve lookup/read-only values and remember safe upload baselines', async () => {
  const f = fixture();
  const response = await f.get('by-ref');
  assert.equal(response.status, 200);
  assert.equal(response.data.records[0].Account__c, ACCOUNT);
  assert.ok(f.api.baselines.get('Project__c:' + RECORD).LastModifiedDate);
  const query = decodeURIComponent(f.calls.find(c => c.route.includes('/query?')).route);
  assert.match(query, /WHERE Account__c = '001000000000001AAA' LIMIT 50/);
  assert.doesNotMatch(query, /Address__c/);
  f.row.Name = 'Changed externally'; await f.get('by-ref');
  assert.equal(f.api.baselines.get('Project__c:' + RECORD).Name, 'Related project');
  assert.ok(f.calls.every(c => !c.options?.method));
});
test('Related endpoints reject inaccessible/nonreference/filter-disabled fields and malformed inputs before querying', async () => {
  const f = fixture();
  for (const params of [{ field: 'Name' }, { field: 'Hidden__c' }, { field: 'Blocked__c' }, { field: 'Account__c OR Id != null' }, { id: "' OR Name != ''" }, { limit: '-1' }, { limit: 'NaN' }]) {
    assert.equal((await f.get('by-ref', params)).status, 400);
  }
  assert.equal(f.calls.filter(c => c.route.includes('/query?')).length, 0);
  assert.equal((await f.get('by-ref', { limit: '9999' })).data.limit, 200);
});
test('Related search retains the reference predicate, escapes user text, and does not create baselines', async () => {
  const f = fixture(), response = await f.get('by-ref-search', { q: "O'Brien_100%" });
  assert.deepEqual(response.data.records, [{ id: RECORD, name: 'Related project' }]);
  const query = decodeURIComponent(f.calls.find(c => c.route.includes('/query?')).route);
  assert.ok(query.includes("WHERE Account__c = '" + ACCOUNT + "' AND (Name LIKE "));
  assert.ok(query.includes("O\\'Brien\\\\_100\\\\%"));
  assert.match(query, /LIMIT 20$/);
  assert.equal(f.api.baselines.size, 0);
});
test('Count batches deduplicate probes, reuse descriptions, skip unsupported fields and preserve failures', async () => {
  const f = fixture(), p = { name: 'Project__c', field: 'Account__c', id: ACCOUNT };
  const result = await f.api.related.counts([p, p, { ...p, field: 'Hidden__c' }]);
  assert.deepEqual(result.counts.slice(0, 2).map(c => c.count), [1, 1]);
  assert.equal(result.counts[2].skipped, true);
  assert.equal(f.calls.filter(c => c.route.endsWith('/describe')).length, 1);
  assert.equal(f.calls.filter(c => c.route.includes('/query?')).length, 1);
  await assert.rejects(f.api.related.counts(Array(201).fill(p)), /200/);
  const original = f.client.request;
  f.client.request = async route => { if (route.includes('/query?')) throw new SalesforceError('Rate limited', 'limit', 429); return original(route); };
  await assert.rejects(f.api.related.counts([p]), /Rate limited/);
});
test('Related full-field query follows Salesforce cursors but rejects external/repeated continuations', async () => {
  const f = fixture(), original = f.client.request, next = API + '/query/01g000000000001-1';
  f.client.request = async route => {
    if (route.includes('/query?')) return { records: [{ ...f.row }], done: false, nextRecordsUrl: next };
    if (route === next) return { records: [{ ...f.row, Id: 'a00000000000002AAA' }], done: true };
    return original(route);
  };
  assert.equal((await f.get('by-ref')).data.records.length, 2);
  for (const continuation of ['https://attacker.invalid/query', API + '/sobjects/Account', next]) {
    f.client.request = async route => route.includes('/query') ? { records: [{ ...f.row }], done: false, nextRecordsUrl: continuation } : original(route);
    assert.equal((await f.get('by-ref')).status, 502);
  }
});
test('Related reads are bounded across simultaneous batches and stop after disconnect', async () => {
  const f = fixture(), original = f.client.request;
  let running = 0, peak = 0;
  f.client.request = async route => {
    if (route.includes('/query?')) {
      running++; peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 5)); running--;
    }
    return original(route);
  };
  await Promise.all(Array.from({ length: 12 }, (_, i) => f.api.related.counts([{ name: 'Project__c', field: 'Account__c', id: '001' + String(i).padStart(12, '0') }])));
  assert.ok(peak <= 4); assert.ok(peak > 1);
  f.api.dispose();
  const before = f.calls.length;
  assert.equal((await f.get('by-ref')).status, 403);
  assert.equal(f.calls.length, before);
});
