const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function preview(overrides = {}) {
  const window = { ORGLOOM_DESKTOP_LIVE: true };
  const context = { window, Set, Map, Date, isFinite };
  for (const file of ['webview/platform.js', 'vendor/upstream/packages/canvas/src/public/js/preflight.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  const records = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, objectName: 'Consultant__c' }));
  const links = records.map(r => ({ fromId: r.id, toId: r.id % 2 ? r.id + 1 : r.id - 1, fieldName: 'Manager__c' }));
  const before = JSON.stringify(links);
  const api = window.OrgLoom.preflight.mount({
    canvasState: { bulkRecords: records, bulkAssociations: links, selectedObjects: [], describeCache: {
      Consultant__c: { fields: [{ name: 'Manager__c', type: 'reference', nillable: true, updateable: true, referenceTo: ['Consultant__c'], ...overrides }] },
    } },
    isRecordModified: () => true, recordOrdinal: r => r.id,
  });
  const result = api.computeUploadOrder();
  assert.equal(JSON.stringify(links), before, 'Preview must preserve the relationships for upload');
  return result;
}

test('extension preview accepts all 20 optional reference cycles without losing records or links', () => {
  const result = preview();
  assert.equal(result.cycleIds.size, 0);
  assert.equal(result.creates.reduce((total, group) => total + group.upload, 0), 40);
});

test('extension preview still blocks cycles that cannot be completed after insertion', () => {
  for (const metadata of [{ nillable: false }, { updateable: false }, { referenceTo: ['Account'] }]) {
    assert.equal(preview(metadata).cycleIds.size, 40);
  }
});
