'use strict';
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {LiveApi}=require('../src/live-api.cjs');
const {API,SalesforceError}=require('../src/salesforce.cjs');
const ORG = '00D000000000001AAA';
function fixture(ApiClass = LiveApi, ErrorClass = SalesforceError) {
  const db = new Map(), stored = new Map(), calls = [];
  let seq = 0;
  const fields = [
    { name: 'Id', type: 'id' }, { name: 'Name', type: 'string', nameField: true, createable: true, updateable: true },
    { name: 'Phone', type: 'phone', createable: true, updateable: true }, { name: 'LastModifiedDate', type: 'datetime' },
    { name:'External_Key__c',type:'string',externalId:true,filterable:true,createable:true,updateable:true,unique:true },
    { name: 'AccountId', type: 'reference', createable: true, updateable: true, referenceTo: ['Account'], filterable: true },
    { name: 'ParentId', type: 'reference', createable: true, updateable: true, referenceTo: ['Account'], filterable: true },
  ];
  const desc = name => ({ name, keyPrefix: name === 'Account' ? '001' : name === 'Contact' ? '003' : 'a00', label: name, labelPlural: name + 's', fields: fields.map(f => ({ label: f.name, nillable: f.name !== 'Name', ...f })), createable: true, updateable: true, deletable: true, queryable: true });
  const makeId = name => (name === 'Account' ? '001' : name === 'Contact' ? '003' : 'a00') + String(++seq).padStart(12, '0') + 'AAA';
  const seed = (name, values) => { const record = { Id: makeId(name), ...values, LastModifiedDate: '2026-10-22T12:00:00.000+0000' }; db.set(record.Id, { name, record }); return record; };
  const secrets = { get: async k => stored.get(k), store: async (k, v) => stored.set(k, v), delete: async k => stored.delete(k) };
  const client = { publicIdentity: () => ({ orgId: ORG, userId: '005000000000001AAA', orgName: 'Test Org', instanceUrl: 'https://test.my.salesforce.com' }), request: async (route, options = {}) => {
    assert.ok(route.startsWith(API + '/'));
    assert.doesNotMatch(route, /apex|ContentVersion|ContentDocument|orgloom__/i);
    calls.push({ route, ...options });
    if (route.endsWith('/sobjects/')) return { sobjects: ['Account', 'Contact', 'Case', 'Project__c'].map(desc) };
    if (route.endsWith('/limits')) return {};
    if (route.endsWith('/describe')) return desc(route.split('/').at(-2));
    if (route.includes('/query?')) {
      const q = decodeURIComponent(route.split('?q=')[1]);
      if (q.includes('UserRecordAccess')) return { records: [...db.keys()].map(RecordId => ({ RecordId, HasReadAccess: true, HasEditAccess: true, HasDeleteAccess: true })) };
      const external=/FROM (\w+) WHERE External_Key__c = '((?:\\.|[^'])*)' LIMIT 2$/.exec(q);
      if(external){const value=external[2].replace(/\\(.)/g,'$1').toLowerCase();return {done:true,records:[...db.values()].filter(v=>v.name===external[1]&&String(v.record.External_Key__c).toLowerCase()===value).slice(0,2).map(v=>({Id:v.record.Id}))};}
      const names=q.match(/^SELECT (.+?) FROM /)?.[1].split(',').map(v=>v.trim())||[];
      return { records: [...db.values()].map(v => ({...Object.fromEntries(names.map(n=>[n,null])), ...v.record })), done: true };
    }
    if (route === API + '/composite/graph' || route === API + '/composite') {
      assert.equal(options.retry, false);
      const composite=route===API+'/composite';
      if(composite){assert.equal(options.body.allOrNone,true);assert.ok(options.body.compositeRequest.length<=25);}
      else {
        const requests = options.body.graphs.flatMap(g => g.compositeRequest);
        assert.ok(options.body.graphs.length <= 75);
        assert.ok(requests.length <= 500);
        assert.ok(new Set(requests.map(r => r.method + ':' + r.url.split('/').slice(0,6).join('/').toLowerCase())).size <= 15, 'Graph operation-type limit applies across the entire payload');
      }
      const graphs=[];
      for(const graph of composite?[{graphId:'canvas',compositeRequest:options.body.compositeRequest}]:options.body.graphs) {
      const staged = structuredClone(db), refs = new Map(), rows = [];
      let failed = false;
      const requests = graph.compositeRequest;
      for (const sub of requests) {
        if (sub.method === 'DELETE') assert.equal(sub.httpHeaders, undefined, 'Conditional DELETE headers are unsupported');
        const parts = sub.url.split('/'), name = parts[5]; let id = parts[6];
        if (id && /^@\{r\d+\.id\}$/.test(id)) id = refs.get(id.slice(2,-4));
        const values = Object.fromEntries(Object.entries(sub.body || {}).map(([k, v]) => [k, typeof v === 'string' && /^@\{r\d+\.id\}$/.test(v) ? refs.get(v.slice(2, -4)) : v]));
        if(values.Name==='Duplicate block'||(values.Name==='Duplicate alert'&&!(composite&&sub.httpHeaders?.['Sforce-Duplicate-Rule-Header']?.includes('allowSave=true')))){failed=true;rows.push({referenceId:sub.referenceId,httpStatusCode:400,body:[{errorCode:'DUPLICATES_DETECTED',message:'Duplicate found.'}]});continue;}
        if (Number(values.Amount__c) > 999) { failed = true; rows.push({referenceId:sub.referenceId,httpStatusCode:400,body:[{errorCode:'NUMBER_OUTSIDE_VALID_RANGE',message:'Amount outside valid range.',fields:['Amount__c']}]}); continue; }
        if (failed || values.Name === 'Reject') { failed = true; rows.push({ referenceId: sub.referenceId, httpStatusCode: 400, body: [{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Fixture validation failed.' }] }); continue; }
        if(parts[6]==='External_Key__c') {
          const key=decodeURIComponent(parts[7].split('?')[0]);
          const matched=[...staged.values()].filter(v=>v.name===name&&String(v.record.External_Key__c).toLowerCase()===key.toLowerCase());
          assert.ok(matched.length<=1);
          const created=!matched.length;id=created?makeId(name):matched[0].record.Id;
          if(created&&sub.url.includes('updateOnly=true')){failed=true;rows.push({referenceId:sub.referenceId,httpStatusCode:404,body:[{errorCode:'NOT_FOUND',message:'Missing'}]});continue;}
          if(created)staged.set(id,{name,record:{Id:id,External_Key__c:key,LastModifiedDate:'2026-10-22T13:00:00.000+0000'}});
          Object.assign(staged.get(id).record,values);refs.set(sub.referenceId,id);
          rows.push({referenceId:sub.referenceId,httpStatusCode:created?201:200,body:{id,success:true,created}});continue;
        }
        if (sub.method === 'POST') {
          const newId = makeId(name); staged.set(newId, { name, record: { Id: newId, ...values, LastModifiedDate: '2026-10-22T13:00:00.000+0000' } }); refs.set(sub.referenceId, newId);
          rows.push({ referenceId: sub.referenceId, httpStatusCode: 201, body: { id: newId, success: true } });
        } else {
          assert.ok(staged.has(id), 'Existing target must exist');
          if (sub.method === 'DELETE') staged.delete(id); else Object.assign(staged.get(id).record, values);
          rows.push({ referenceId: sub.referenceId, httpStatusCode: 204, body: null });
        }
      }
      if (!failed) { db.clear(); staged.forEach((v, k) => db.set(k, v)); }
      graphs.push({graphId:graph.graphId,isSuccessful:!failed,graphResponse:{compositeResponse:rows}});
      }
      return composite?graphs[0].graphResponse:{graphs};
    }
    const id = route.split('/').at(-1);
    if (!db.has(id)) throw new ErrorClass('Not found', 'NOT_FOUND', 404);
    if (options.method === 'DELETE') { assert.equal(options.headers,undefined);assert.equal(options.retry,false);db.delete(id);return null;}
    if (options.method === 'PATCH') { Object.assign(db.get(id).record, options.body); return null; }
    return { ...db.get(id).record };
  } };
  const api = new ApiClass(client, { secrets, confirmUpload: async () => true });
  const body = (records, associations = [], deletes = []) => ({ attemptId: randomUUID(), expectedSfOrgId: ORG, records, associations, deletes });
  const draft = (tempId, objectName, values) => ({ tempId, objectName, values });
  const loaded = async (tempId, objectName, record, changes = {}) => { const baseline = await api.retrieve(objectName, record.Id); return { tempId, objectName, loadedFromId: record.Id, loadedValues: baseline, values: { ...baseline, ...changes } }; };
  return { api, client, secrets, stored, calls, db, fields, seed, body, draft, loaded };
}

module.exports={fixture};
