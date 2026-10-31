'use strict';
// Opt-in live read-only smoke test. Uses an existing CLI authorization and the
// real command/QuickPick; never creates, modifies, or deletes Salesforce records.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

exports.run = async ({ workbench, until, output }) => {
  const alias = process.env.ORGLOOM_TEST_CLI_ALIAS;
  const root = vscode.extensions.getExtension('orgloom.orgloom-vscode').extensionPath;
  const { SalesforceCli } = require(path.join(root, 'src/salesforce-cli.cjs'));
  const org = (await new SalesforceCli().list()).find(row => row.alias.split(',').includes(alias));
  assert.ok(org, 'Authorized CLI test alias must exist');
  const disconnect = async () => {
    const command = vscode.commands.executeCommand('orgloom.disconnectTestOrg');
    await until(async () => (await workbench.locator('body').innerText()).includes('Your Salesforce CLI login is unchanged'), 'disconnect confirmation');
    await vscode.commands.executeCommand('notifications.clearAll');
    await command;
  };
  let connected = false;
  try {
    const command = vscode.commands.executeCommand('orgloom.connectCliOrg');
    const input = workbench.locator('.quick-input-widget input');
    await input.waitFor({ state: 'visible', timeout: 60000 });
    await input.fill(org.username);
    const option = workbench.locator('.quick-input-list .monaco-list-row').filter({ hasText: org.username }).first();
    await option.waitFor({ state: 'visible' });
    await option.click();
    await command;
    const canvas = await until(async () => {
      for (const frame of workbench.frames()) if (await frame.locator('#prototype-disconnect').count().catch(() => 0)) return frame;
    }, 'CLI-authenticated canvas', 60000);
    connected = true;
    await canvas.locator('[data-bulk-add-menu]').waitFor({ state: 'visible' });
    const result = await canvas.evaluate(async () => {
      const response = await fetch('/api/objects');
      const objects = await response.json();
      const name = objects.find(o => o.name === 'OLQA_Project__c')?.name || objects.find(o => o.custom && /__c$/.test(o.name))?.name;
      if (!name) throw new Error('Live metadata test requires a custom object.');
      const get = async path => { const r = await fetch(path); if (!r.ok) throw new Error('Metadata request failed: ' + path); return r.json(); };
      const describe = await get('/api/objects/' + name + '/describe');
      const layout = await get('/api/objects/' + name + '/layout');
      const graph = await get('/api/objects/' + name + '/graph');
      return { status: response.status, mock: window.ORGLOOM_MOCK, name, objectCount: objects.length, fieldCount: describe.fields.length, customFields: describe.fields.filter(f => /__c$/.test(f.name)).length, recordTypeCount: describe.recordTypes.length, layout: layout.available, sections: layout.sections.map(s => s.heading), picklistCount: Object.keys(layout.picklistValues || {}).length, relationships: graph.parents.length + graph.children.length };
    });
    assert.equal(result.mock, false);
    assert.equal(result.status, 200);
    assert.ok(result.objectCount > 4);
    assert.ok(result.customFields > 0);
    assert.equal(result.layout, true);
    assert.ok(result.relationships > 0);
    // Exercise the actual custom-object editor, not only its API responses.
    await canvas.locator('[data-bulk-add-menu]').click();
    await canvas.locator('[data-add-menu="soql"]').click();
    await canvas.locator('#soql-query').fill('SELECT Id, Name FROM ' + result.name + ' LIMIT 1');
    await canvas.locator('#soql-commit-btn').click();
    const card = canvas.locator('[data-rec-id]').first();
    await card.waitFor({ state: 'visible', timeout: 60000 });
    await canvas.locator('#prototype-fit').click();
    await new Promise(r => setTimeout(r, 300));
    const box = await card.boundingBox();
    await workbench.mouse.dblclick(box.x + box.width / 2, box.y + 24);
    await canvas.locator('[data-editor-element="insert-form"]').waitFor({ state: 'visible', timeout: 60000 });
    await canvas.locator('[id$="f_Name"]').waitFor({ state: 'visible', timeout: 60000 });
    await vscode.commands.executeCommand('notifications.hideToasts');
    await workbench.screenshot({ path: path.join(output, '05-cli-connected.png') });
    await canvas.getByRole('button', { name: 'Cancel', exact: true }).click();
    const related = await canvas.evaluate(async name => {
      const post = async (path, body) => { const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error('Related test request failed'); return r.json(); };
      const imported = await post('/api/query', { soql: 'SELECT Id, Name FROM ' + name + ' LIMIT 1' });
      const id = imported.records[0].loadedFromId;
      const graph = await (await fetch('/api/objects/' + name + '/graph')).json();
      const probes = graph.children.filter(c => c.object.startsWith('OLQA_')).map(c => ({ name: c.object, field: c.field, id }));
      const { counts } = await post('/api/related-counts', { probes });
      const selected = counts.find(c => !c.skipped && c.count > 0 && c.count <= 50);
      if (!selected) throw new Error('Live relationship test needs a populated OLQA child relationship (1–50 records).');
      // Exercise the search contract too without logging record contents.
      const search = await fetch('/api/objects/' + selected.name + '/by-ref-search?' + new URLSearchParams({ field: selected.field, id }));
      if (!search.ok || !(await search.json()).records.length) throw new Error('Related search did not return the known children.');
      return { objectName: selected.name, field: selected.field, count: selected.count };
    }, result.name);
    await card.locator('[data-related-pick]').click();
    await canvas.locator(`[data-rel-object="${related.objectName}"][data-rel-field="${related.field}"]`).click();
    await until(async () => await canvas.locator('[data-rec-id]').count() >= related.count + 1, 'live custom related records on canvas', 60000);
    await canvas.locator('#prototype-fit').click();
    await new Promise(r => setTimeout(r, 300));
    await workbench.screenshot({ path: path.join(output, '06-cli-related.png') });
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await disconnect();
    connected = false;
    assert.ok((await new SalesforceCli().list()).some(row => row.username === org.username), 'Extension disconnect must preserve CLI authorization');
    fs.writeFileSync(path.join(output, 'cli-connection-report.json'), JSON.stringify({ mode: 'Live Salesforce CLI / read-only', metadata: result, related, passed: ['Real CLI org picker', 'Salesforce identity and test-org verification', 'Live custom-object directory, fields, layout, record types, picklists and schema', 'Custom record imported and opened in actual editor', 'Live related counts, search and custom child loading through Find related', 'Disconnect preserves CLI login'], salesforceWrites: 0 }, null, 2));
    console.log('Live CLI command, connected canvas metadata, and disconnect passed; no Salesforce writes.');
  } finally {
    if (connected) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await disconnect();
    }
  }
};
