'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OrgMetadata } = require('../src/metadata.cjs');
const { LiveApi } = require('../src/live-api.cjs');
const { SalesforceError } = require('../src/salesforce.cjs');
const RT1 = '012000000000001AAA', RT2 = '012000000000002AAA', RECORD = 'a00000000000001AAA';
test('Validation rules use bounded Tooling reads and distinguish unavailable metadata from an empty list', async()=>{
 const f=fixture(), original=f.client.request, calls=[];
 f.client.request=async p=>{
  if(!p.includes('/tooling/query?'))return original(p);
  const q=new URL('https://example.com'+p).searchParams.get('q');calls.push(q);
  if(q.startsWith('SELECT Id FROM'))return {done:true,records:[{Id:'03d000000000001AAA'},{Id:'03d000000000002AAA'}]};
  const id=q.includes('03d000000000001AAA')?'03d000000000001AAA':'03d000000000002AAA';
  return {records:[{Id:id,FullName:'Project__c.Check_Name',Metadata:{active:id.endsWith('001AAA'),errorMessage:'Name is required',errorConditionFormula:'ISBLANK(Name)'}}]};
 };
 const rows=await f.metadata.validationRules('Project__c');assert.equal(rows.length,1);assert.equal(rows[0].name,'Check_Name');assert.equal(rows[0].formula,'ISBLANK(Name)');
 assert.equal(calls.length,3);assert.ok(calls.slice(1).every(q=>/WHERE Id = '03d\w+' LIMIT 1$/.test(q)));
 f.client.request=async p=>{if(p.includes('/tooling/'))throw new SalesforceError('No access','denied',403);return original(p);};
 assert.equal((await f.metadata.validationRules('Project__c')).unavailable,true);
 f.client.request=async p=>{if(p.includes('/tooling/'))throw new SalesforceError('Limit','limit',429);return original(p);};
 await assert.rejects(f.metadata.validationRules('Project__c'),/Limit/);
});
function fixture() {
  const calls = [];
  const fields = [
    { name: 'Id', type: 'id', updateable: false },
    { name: 'Name', label: 'Project name', type: 'string', nameField: true, filterable: true, sortable: true, createable: true, updateable: true },
    { name: 'Region__c', type: 'picklist', createable: true, updateable: true, picklistValues: [{ value: 'East', active: true }, { value: 'Gone', active: false }] },
    { name: 'Status__c', type: 'picklist', createable: true, updateable: true },
    { name: 'Account__c', label: 'Customer', type: 'reference', referenceTo: ['Account', 'Hidden__c'], updateable: true },
    { name: 'Secret__c', type: 'string', updateable: true },
  ];
  const info = { defaultRecordTypeId: RT1, recordTypeInfos: Object.fromEntries([RT1, RT2].map((id, i) => [id, { recordTypeId: id, name: 'Type ' + i, available: true }])), fields: Object.fromEntries(fields.filter(f => f.name !== 'Secret__c').map(f => [f.name, { ...f, ...(f.name === 'Status__c' ? { controllingFields: ['Region__c'], updateable: false } : {}) }])) };
  const section = { heading: 'Project details', columns: 2, layoutRows: [{ layoutItems: ['Name', 'Status__c', 'Secret__c'].map(apiName => ({ label: apiName, editableForUpdate: true, layoutComponents: [{ componentType: 'Field', apiName }] })) }] };
  const client = { publicIdentity: () => ({ orgId: '00D000000000001AAA', userId: '005000000000001AAA' }), request: async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/sobjects/')) return { sobjects: [{ name: 'Project__c', queryable: true, custom: true }, { name: 'Account', queryable: true }, { name: 'Hidden__c', queryable: false }] };
    if (path.endsWith('/describe')) return { name: 'Project__c', fields: structuredClone(fields), childRelationships: [{ childSObject: 'Project__c', field: 'Parent__c' }, { childSObject: 'Hidden__c', field: 'Parent__c' }] };
    if (path.includes('/picklist-values/')) return { picklistFieldValues: { Status__c: { controllerValues: { East: 0, West: 1 }, defaultValue: { value: 'Open' }, values: [{ label: 'Open', value: path.endsWith(RT1) ? 'Open' : 'Review', validFor: [0] }] } } };
    if (path.includes('/object-info/')) return info;
    if (path.includes('/record-ui/')) return { records: { [RECORD]: { apiName: 'Project__c', recordTypeId: RT1 } }, layouts: { Project__c: { [RT1]: { Full: { Edit: { sections: [section] } } } } } };
    if (path.includes('/layout/')) return { recordTypeId: RT2, sections: [{ ...section, heading: 'Type 2 layout' }] };
    if (path.includes('/query?')) return { records: [{ Id: RECORD, Name: 'Test project' }], done: true, totalSize: 1 };
    if (path.includes('/sobjects/Project__c/')) return { Id: RECORD, Name: 'Test project' };
    throw new Error('Unexpected route');
  } };
  return { client, calls, fields, info, metadata: new OrgMetadata(client) };
}
test('Org discovery includes custom objects, validates names, and caches only within the connection', async () => {
  const f = fixture();
  assert.equal(await f.metadata.name('project__c'), 'Project__c');
  await f.metadata.objects();
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.metadata.name('Hidden__c'), /not available/);
  await assert.rejects(f.metadata.name('Project__c/other'), /Invalid/);
  f.metadata.clear(); await f.metadata.objects(); assert.equal(f.calls.length, 2);
});
test('Describe maps record types, dependent picklists and field permissions without exposing omitted fields', async () => {
  const f = fixture(), d = await f.metadata.describe('Project__c');
  assert.equal(d.recordTypes.length, 2); assert.equal(d.defaultRecordTypeId, RT1);
  assert.ok(!d.fields.some(v => v.name === 'Secret__c'));
  const field = d.fields.find(v => v.name === 'Status__c');
  assert.equal(field.updateable, false); assert.equal(field.controllerName, 'Region__c');
  assert.equal(field.picklistValuesByRecordType[RT1][0].value, 'Open');
  assert.equal(field.picklistValuesByRecordType[RT2][0].value, 'Review');
  assert.deepEqual(field.picklistValuesByRecordType[RT1][0].validFor, [0]);
  assert.deepEqual(field.controllerValuesByRecordType[RT2], { East: 0, West: 1 });
  f.fields[1].updateable = false;
  assert.equal((await f.metadata.describe('Project__c', { permissionsOnly: true })).fields[1].updateable, false);
});
test('Actual record layout is projected to accessible fields and switches with the record type', async () => {
  const f = fixture(), d = await f.metadata.describe('Project__c');
  const l = await f.metadata.layout('Project__c', new URLSearchParams({ recordId: RECORD }), d);
  assert.equal(l.sections[0].heading, 'Project details');
  assert.deepEqual(l.sections[0].rows[0].map(i => i.apiName), ['Name', 'Status__c']);
  assert.equal(l.sections[0].rows[0][1].editableForUpdate, false);
  assert.equal(l.picklistValues.Status__c.defaultValue, 'Open');
  const switched = await f.metadata.layout('Project__c', new URLSearchParams({ recordId: RECORD, recordTypeId: RT2 }), d);
  assert.equal(switched.sections[0].heading, 'Type 2 layout');
  assert.equal(switched.picklistValues.Status__c.values[0].value, 'Review');
  await assert.rejects(f.metadata.layout('Project__c', new URLSearchParams({ recordId: '../bad' }), d), /Invalid/);
});
test('UI API unsupported objects fall back explicitly; transport failures are not silently swallowed', async () => {
  const f = fixture(), original = f.client.request;
  f.client.request = async p => { if (p.includes('/ui-api/')) throw new SalesforceError('Unsupported', 'unsupported', 404); return original(p); };
  const d = await f.metadata.describe('Project__c'); assert.equal(d.fields.length, 6);
  assert.equal((await f.metadata.layout('Project__c', new URLSearchParams(), d)).available, false);
  f.client.request = async p => { if (p.includes('/ui-api/')) throw new SalesforceError('Rate limit', 'limit', 429); return original(p); };
  await assert.rejects(f.metadata.describe('Project__c'), /Rate limit/);
});
test('Schema excludes inaccessible relationships, custom objects can load, upload scope stays restricted', async () => {
  const f = fixture(), d = await f.metadata.describe('Project__c');
  const graph = await f.metadata.graph('Project__c', d);
  assert.deepEqual(graph.parents.map(p => p.object), ['Account']);
  assert.deepEqual(graph.children.map(p => p.object), ['Project__c']);
  const api = new LiveApi(f.client, { secrets: { get: async () => null }, confirmUpload: async () => { throw new Error('Must not reach confirmation'); } });
  const imported = await api.importQuery({ soql: 'SELECT Id, Name FROM Project__c LIMIT 1' });
  assert.equal(imported.records[0].objectName, 'Project__c');
  await assert.rejects(api.upload({ attemptId: 'custom-no-permission', expectedSfOrgId: api.orgId, records: imported.records }), /does not allow/);
  assert.ok(f.calls.every(c => !c.options?.method));
});
test('Search and lookup return the frontend contract and cannot query an unrelated target', async () => {
  const f = fixture();
  const api = new LiveApi(f.client, { secrets: {}, confirmUpload: async () => false });
  const request = path => api.handle({ type: 'live-api', id: 1, method: 'GET', path });
  const search = await request('/api/objects/Project__c/search?q=Test');
  assert.equal(search.status, 200);
  assert.equal(search.data.records[0].name, 'Test project');
  const lookup = await request('/api/objects/Project__c/lookup?fieldName=Account__c&targetApiName=Account&q=Test');
  assert.equal(lookup.status, 200);
  assert.equal(lookup.data.records[0].title, 'Test project');
  assert.equal(lookup.data.records[0].apiName, 'Account');
  const before = f.calls.filter(c => c.path.includes('/query?')).length;
  assert.equal((await request('/api/objects/Project__c/lookup?fieldName=Account__c&targetApiName=Project__c')).status, 400);
  assert.equal(f.calls.filter(c => c.path.includes('/query?')).length, before);
});
