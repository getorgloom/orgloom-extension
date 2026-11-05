'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {LiveApi}=require('../src/live-api.cjs');
const {SalesforceError}=require('../src/salesforce.cjs');
const {fixture}=require('./upload-fixture.cjs');
test('Refresh retains per-record identity and returns partial failures, clearing unavailable baselines',async()=>{
  const f=fixture(),a=f.seed('Account',{Name:'Available'}),b=f.seed('Account',{Name:'Removed'});
  await f.api.retrieve('Account',a.Id);await f.api.retrieve('Account',b.Id);f.db.delete(b.Id);
  const result=await f.api.route({type:'live-api',id:1,method:'POST',path:'/api/records/refresh',body:{records:[{tempId:1,objectName:'Account',sfId:a.Id},{tempId:2,objectName:'Account',sfId:b.Id}]}});
  assert.equal(result.results[0].ok,true);assert.equal(result.results[0].tempId,1);assert.equal(result.results[1].ok,false);assert.equal(result.results[1].tempId,2);assert.equal(result.results[1].values,null);
  assert.ok(!f.api.baselines.has('Account:'+b.Id));
});
test('Refresh authentication/throttling failures do not advance any baselines',async()=>{
  for(const error of [new SalesforceError('Expired','INVALID_SESSION_ID',401),new SalesforceError('Limit','REQUEST_LIMIT_EXCEEDED',403),new Error('offline')]){
    const f=fixture(),a=f.seed('Account',{Name:'Before'}),b=f.seed('Account',{Name:'B'});await f.api.retrieve('Account',a.Id);
    f.db.get(a.Id).record.Name='After';const original=f.client.request;f.client.request=async(route,opts)=>{if(route.endsWith(b.Id))throw error;return original(route,opts);};
    await assert.rejects(f.api.route({type:'live-api',id:1,method:'POST',path:'/api/records/refresh',body:{records:[{objectName:'Account',sfId:a.Id},{objectName:'Account',sfId:b.Id}]}}));
    assert.equal(f.api.baselines.get('Account:'+a.Id).Name,'Before');
  }
});
test('desktop cannot author record or field requests even if legacy capabilities enable them', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const window = { ORGLOOM_DESKTOP_LIVE: true, OrgLoom: {} };
  const context = { window };
  vm.runInNewContext(fs.readFileSync('webview/platform.js', 'utf8'), context);
  vm.runInNewContext(fs.readFileSync('vendor/upstream/packages/canvas/src/public/js/canvas-cap.js', 'utf8'), context);
  const cap = window.OrgLoom.canvasCap.mount({ canvasState: { bulkRecords: [] }, isRecordModified: () => false, getShareCountByCanvasId: () => new Map(), renderBulkToolbar() {} });
  cap.setCaps({ 'create-slot-canvas': true });
  assert.equal(cap._canAuthorSlots(), false);
  assert.equal(require('../src/live-api.cjs').CAPABILITIES['create-slot-canvas'], false);
  const source = fs.readFileSync('vendor/upstream/packages/canvas/src/public/js/app.js', 'utf8');
  const snippets = [
    ['async function convertRecordToFieldSlot', 'async function createStandaloneRecordRequest'],
    ['async function createStandaloneRecordRequest', 'function openStandaloneRecordRequestPicker'],
    ['function openStandaloneRecordRequestPicker', 'function _slotRecordDisplayName'],
    ['async function configureExistingSlot', 'async function convertSlotBackToRecord']
  ].map(([start, end]) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))));
  const messages = [], ctx = vm.createContext({ _canAuthorSlots: cap._canAuthorSlots, showBulkToast: message => messages.push(message) });
  vm.runInContext(snippets.join('\n'), ctx);
  const record = { objectName: 'Account', values: {}, slot: { slotId: 1 } }, before = JSON.stringify(record);
  await ctx.convertRecordToFieldSlot(record);
  assert.equal(await ctx.createStandaloneRecordRequest('Account'), false);
  assert.equal(ctx.openStandaloneRecordRequestPicker({}), false);
  await ctx.configureExistingSlot(record);
  assert.equal(JSON.stringify(record), before);
  assert.equal(messages.length, 4);
  for (const message of messages) assert.doesNotMatch(message, /Pro|pricing/);
});

test('desktop add and canvas context menus omit request creation at render time', () => {
  const fs = require('node:fs'), { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><button id="add">Add</button>', { runScripts: 'outside-only' });
  try {
    const w = dom.window;
    w.ORGLOOM_DESKTOP_LIVE = true;
    w.eval(fs.readFileSync('webview/platform.js', 'utf8'));
    w.eval(fs.readFileSync('vendor/upstream/packages/canvas/src/public/js/bulk-ops-menu.js', 'utf8'));
    const noop = () => {}, deps = new Proxy({ canvasState: { bulkRecords: [], bulkSelectedIds: new Set() }, canEditCanvasStructure: () => true, _hasCap: () => true }, { get: (target, key) => target[key] || noop });
    const api = w.OrgLoom.bulkOpsMenu.mount(deps);
    api.showAddRecordsMenu(w.document.getElementById('add'));
    api._showCanvasContextMenu(10, 10, { x: 10, y: 10 });
    assert.equal(w.document.querySelector('[data-add-menu="request"]'), null);
    assert.equal(w.document.querySelector('[data-ccm-action="request"]'), null);
    assert.ok(w.document.querySelector('[data-add-menu="blank"]'));
    assert.ok(w.document.querySelector('[data-ccm-action="spawn"]'));
  } finally { dom.window.close(); }
});
