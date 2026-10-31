const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

for (const mode of ['all', 'selected', 'ineligible', 'viewer']) {
  test(`Tools bulk deletion: ${mode}`, () => {
    const dom = new JSDOM('<button id="tools">Tools</button>', { runScripts: 'outside-only', url: 'https://example.com' });
    try {
      const w = dom.window;
      w.eval(fs.readFileSync(path.join(__dirname, '../vendor/upstream/packages/canvas/src/public/js/bulk-ops-menu.js'), 'utf8'));
      let calls = 0;
      const record = { id: 1, objectName: 'Account', loadedFromId: '001000000000001AAA', values: {} };
      const deps = new Proxy({
        canvasState: { bulkRecords: [record], bulkSelectedIds: new Set(mode === 'all' ? [] : [1]) },
        canEditCanvasStructure: () => mode !== 'viewer',
        _hasCap: () => true,
        isCapabilityReady: () => true,
        getAiGen: () => ({ isEnabled: () => false, getAccessState: () => ({ ready: true, allowed: false }) }),
        bulkDeleteCandidates: () => mode === 'ineligible' ? [] : [record],
        openBulkDeleteFlow: () => calls++,
      }, { get: (target, key) => key in target ? target[key] : () => {} });
      w.OrgLoom.bulkOpsMenu.mount(deps).showBulkOperationsMenu(w.document.querySelector('#tools'));
      const button = w.document.querySelector('[data-bulk-op="mark-delete"]');
      if (mode === 'viewer') {
        assert.equal(button, null);
      } else {
        assert.match(button.textContent, /Mark for deletion/);
        assert.equal(button.disabled, mode === 'ineligible');
        assert.match(button.textContent, mode === 'all' ? /1 loaded/ : mode === 'selected' ? /1 selected/ : /No eligible records in selection/);
        button.click();
        assert.equal(calls, mode === 'ineligible' ? 0 : 1);
      }
    } finally { dom.window.close(); }
  });
}
