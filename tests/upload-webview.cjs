'use strict';
const vscode = require('vscode');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { fixture } = require('./upload-fixture.cjs');
exports.run = async ({ workbench, until, output }) => {
  const root = vscode.extensions.getExtension('orgloom.orgloom-vscode').extensionPath;
  const { LiveApi } = require(path.join(root, 'src/live-api.cjs'));
  const { renderHtml } = require(path.join(root, 'src/html.cjs'));
  const { SalesforceError } = require(path.join(root, 'src/salesforce.cjs'));
  const f = fixture(LiveApi, SalesforceError), confirmations = [];
  f.api.confirmUpload = async plan => { confirmations.push(plan.operations.map(o => o.mode)); return true; };
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  const panel = vscode.window.createWebviewPanel('orgloom.uploadFixture', 'Org Loom · Upload Test', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(path.join(root, 'media'))] });
  const messages = [];
  panel.webview.onDidReceiveMessage(async msg => { if (msg?.type === 'live-api') { const response = await f.api.handle(msg); messages.push({ request: msg, response }); await panel.webview.postMessage({ type: 'live-api-result', id: msg.id, ...response }); } });
  panel.webview.html = renderHtml({ root, identity: f.client.publicIdentity(), resource: p => panel.webview.asWebviewUri(vscode.Uri.file(path.join(root, 'media', p))).toString(), cspSource: panel.webview.cspSource });
  try {
    const canvas = await until(async () => { for (const frame of workbench.frames()) if (await frame.locator('#prototype-disconnect').count().catch(() => 0)) return frame; }, 'upload test canvas');
    await canvas.locator('[data-bulk-add-menu]').waitFor({ state: 'visible' });
    for (const name of ['Desktop created account one', 'Desktop created account two']) {
      await canvas.locator('[data-bulk-add-menu]').click();
      await canvas.locator('[data-add-menu="blank"]').click();
      await canvas.locator('#prototype-fit').click();
      await canvas.locator('[data-pending-pick-blank]').click();
      await canvas.locator('[data-fop-pick="Account"]').click();
      await until(async () => await canvas.locator('[data-pending-pick-blank]').count() === 0, 'draft object selected');
      const card = canvas.locator('[data-rec-id]').filter({ hasText: '(no name yet)' }).last();
      const box = await until(() => card.boundingBox(), 'new draft card geometry');
      await workbench.mouse.dblclick(box.x + box.width / 2, box.y + 24);
      await canvas.locator('[id$="f_Name"]').fill(name);
      await canvas.locator('[data-editor-element="modal-submit"]').click();
      await until(async () => (await canvas.locator('[data-rec-id]').allTextContents()).some(t => t.includes(name)), 'draft fields saved');
    }
    await canvas.locator('#bulk-canvas-cy').click({ position: { x: 24, y: 300 } });
    await canvas.locator('[data-bulk-upload]').click();
    await canvas.getByRole('button', { name: /^Upload \d|^Upload$|^Confirm upload$|^Delete \d/ }).last().click();
    await until(() => f.db.size === 2, 'two draft records created');
    await until(async () => (await canvas.locator('body').innerText()).includes('2 records uploaded'), 'upload success summary');
    assert.deepEqual(confirmations[0], ['create', 'create']);
    await workbench.screenshot({ path: path.join(output, '07-desktop-upload-results.png') });
    await canvas.getByRole('button', { name: 'Close', exact: true }).last().click();
    const toolbarLayout = await canvas.evaluate(() => {
      const bar = document.getElementById('graph-subbar');
      const fit = document.getElementById('prototype-fit');
      const disconnect = document.getElementById('prototype-disconnect');
      return { top: bar.getBoundingClientRect().top, fit: bar.contains(fit), disconnect: bar.contains(disconnect), fitTop: fit.getBoundingClientRect().top, disconnectTop: disconnect.getBoundingClientRect().top };
    });
    assert.equal(toolbarLayout.top, 0, 'No space remains for the removed desktop header');
    assert.ok(toolbarLayout.fit && toolbarLayout.disconnect, 'Controls survive toolbar rerenders');
    assert.ok(Math.abs(toolbarLayout.fitTop - toolbarLayout.disconnectTop) < 4, 'Controls share one toolbar row');
    await workbench.screenshot({ path: path.join(output, '13-desktop-toolbar.png') });
    const firstCard = canvas.locator('[data-rec-id]').filter({ hasText: 'Desktop created account two' });
    await firstCard.locator('[data-card-more]').click();
    await canvas.locator('[data-card-action="mark-delete"]').click();
    await canvas.locator('[data-bulk-upload]').click();
    await canvas.getByRole('button', { name: /^Upload \d|^Upload$|^Confirm upload$|^Delete \d/ }).last().click();
    await until(() => f.db.size === 1, 'marked record deleted through upload');
    assert.ok(confirmations.at(-1).includes('delete'));
    fs.writeFileSync(path.join(output, 'desktop-upload-report.json'), JSON.stringify({ mode: 'Controlled Salesforce transport / real VS Code webview', passed: ['Add blank record is enabled', 'Choose object and create drafts in actual editor', 'Multi-record upload reconciles created IDs', 'Upload results show two successes', 'Mark an existing record for deletion and upload'], confirmations, salesforceWrites: 0 }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'upload-ui-messages.json'), JSON.stringify(messages, null, 2));
    for (const frame of workbench.frames()) {
      const state = await frame.evaluate(() => window.Orgloom?.canvasState?.snapshot()).catch(() => null);
      if (state) fs.writeFileSync(path.join(output, 'upload-ui-state.json'), JSON.stringify(state, null, 2));
    }
    fs.writeFileSync(path.join(output, 'upload-ui-calls.json'), JSON.stringify(f.calls, null, 2));
    await workbench.screenshot({ path: path.join(output, 'upload-ui-failure.png') });
    fs.writeFileSync(path.join(output, 'upload-ui-failure.txt'), (await Promise.all(workbench.frames().map(frame => frame.locator('body').innerText().catch(() => '')))).join('\n'));
    throw error;
  } finally { f.api.dispose(); panel.dispose(); }
};
