const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { DesktopScripts } = require('../src/scripts.cjs');

function editor(t) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://example.test' });
  const w = dom.window, scripts = new DesktopScripts();
  t.after(() => { scripts.dispose(); w.close(); });
  w.ORGLOOM_DESKTOP_LIVE = true;
  w.OrgLoom = { bulkScript: {} };
  w.structuredClone = structuredClone;
  const state = { bulkRecords: [
    { id: 1, objectName: 'Opportunity', values: { Amount: 100 } },
    { id: 2, objectName: 'Account', values: { Amount: 100 } }
  ], bulkAssociations: [] };
  let runs = 0, undo;
  w.eval(fs.readFileSync(path.join(__dirname, '../webview/script.js'), 'utf8'));
  w.OrgLoom.bulkScript.mount({
    canvasState: state,
    csrfFetch: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/cancel')) return { ok: true, json: async () => scripts.cancel(body.id) };
      runs++;
      const result = await scripts.run(body);
      return { ok: true, json: async () => result };
    },
    renderBulkView() {}, showBulkToast() {},
    showBulkToastWithAction(message, label, action) { undo = action; }
  }).openModal();
  const q = selector => w.document.querySelector(selector);
  return { state, q, runs: () => runs, undo: () => undo(), edit(source) {
    q('textarea').value = source;
    q('textarea').dispatchEvent(new w.Event('input'));
  } };
}

test('Apply runs directly, affects only Opportunities, and supports undo', async t => {
  const e = editor(t), apply = e.q('[data-apply]');
  assert.equal(apply.disabled, false);
  const pending = apply.onclick();
  assert.equal(apply.disabled, true);
  await apply.onclick(); // A second click must not start another worker.
  await pending;
  assert.equal(e.runs(), 1);
  assert.ok(Math.abs(e.state.bulkRecords[0].values.Amount - 110) < 1e-9);
  assert.equal(e.state.bulkRecords[1].values.Amount, 100);
  assert.equal(e.q('.modal'), null);
  e.undo();
  assert.equal(e.state.bulkRecords[0].values.Amount, 100);
});

test('Preview is optional and Apply reuses it without running twice', async t => {
  const e = editor(t);
  await e.q('[data-run]').onclick();
  assert.equal(e.state.bulkRecords[0].values.Amount, 100);
  await e.q('[data-apply]').onclick();
  assert.equal(e.runs(), 1);
  assert.ok(Math.abs(e.state.bulkRecords[0].values.Amount - 110) < 1e-9);
});

test('Script errors leave records unchanged and edited scripts can apply directly', async t => {
  const e = editor(t);
  e.edit('for (const r of records) { r.values.Amount = 999; } abort("Stop");');
  await e.q('[data-apply]').onclick();
  assert.match(e.q('pre').textContent, /No changes applied/);
  assert.equal(e.state.bulkRecords[0].values.Amount, 100);
  e.edit('for (const r of records) { r.values.Amount = 200; }');
  assert.equal(e.q('[data-apply]').disabled, false);
  await e.q('[data-apply]').onclick();
  assert.equal(e.state.bulkRecords[0].values.Amount, 200);
});

test('Stale previews cannot overwrite newer canvas values', async t => {
  const e = editor(t);
  await e.q('[data-run]').onclick();
  e.state.bulkRecords[0].values.Amount = 200;
  await e.q('[data-apply]').onclick();
  assert.equal(e.state.bulkRecords[0].values.Amount, 200);
  assert.match(e.q('pre').textContent, /canvas changed/);
  await e.q('[data-apply]').onclick();
  assert.ok(Math.abs(e.state.bulkRecords[0].values.Amount - 220) < 1e-9);
});

test('Closing during direct Apply prevents any changes', async t => {
  const e = editor(t);
  const pending = e.q('[data-apply]').onclick();
  e.q('[data-close]').onclick();
  await pending;
  assert.equal(e.state.bulkRecords[0].values.Amount, 100);
  assert.equal(e.q('.modal'), null);
});
