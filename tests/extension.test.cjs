const vscode = require('vscode');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`);
}

exports.run = async () => {
  const output = process.env.ORGLOOM_TEST_RESULTS;
  const report = { steps: [], browserErrors: [], console: [], requests: [] };
  let browser;
  let workbench;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.ORGLOOM_TEST_CDP_PORT);
    const pages = browser.contexts().flatMap(context => context.pages());
    workbench = pages.find(page => page.url().includes('workbench')) || pages[0];
    workbench.setDefaultTimeout(30000);
    workbench.on('pageerror', error => report.browserErrors.push(error.stack));
    workbench.on('console', message => { if (['error', 'warning'].includes(message.type())) report.console.push(message.text()); });
    workbench.on('request', req => report.requests.push(req.url()));
    if (process.env.ORGLOOM_TEST_MANAGED_ONLY) { await require('./managed-features-webview.cjs').run({workbench,until,output}); return; }
    if (process.env.ORGLOOM_TEST_EDGES_ONLY) { await require('./edge-label-webview.cjs').run({workbench,until,output}); return; }
    if (process.env.ORGLOOM_TEST_RECOVERY_ONLY) { await require('./recovery-webview.cjs').run({workbench,until,output}); return; }
    if (process.env.ORGLOOM_TEST_PARITY_ONLY) { await require('./parity-webview.cjs').run({workbench,until,output}); return; }
    if (process.env.ORGLOOM_TEST_UPSERT_ONLY) { await require('./upsert-webview.cjs').run({workbench,until,output}); return; }
    if (process.env.ORGLOOM_TEST_DESKTOP_ONLY) { await require('./desktop-webview.cjs').run({workbench,until,output}); return; }
    if (process.env.ORGLOOM_TEST_UPLOAD_ONLY) {
      await require('./upload-webview.cjs').run({ workbench, until, output });
      return;
    }
    await vscode.commands.executeCommand('orgloom.openCanvas');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('notifications.clearAll');
    const getCanvas = () => workbench.frames().find(frame => frame.url().includes('vscode-webview') && !frame.url().includes('fake'));
    // The visible content is in a nested iframe; locate it by the app marker.
    const findCanvas = async () => {
      for (const frame of workbench.frames()) if (await frame.locator('#prototype-reset').count().catch(() => 0)) return frame;
      return null;
    };
    let canvas = await until(findCanvas, 'canvas webview');
    await until(async () => (await canvas.locator('[data-rec-id]').count()) >= 5, 'five sample records');
    await vscode.commands.executeCommand('notifications.hideToasts');
    await canvas.locator('#prototype-fit').click();
    await new Promise(resolve => setTimeout(resolve, 300));
    report.steps.push('Real canvas loads five connected sample records inside VS Code');
    await workbench.screenshot({ path: path.join(output, '01-canvas.png') });
    const network = await canvas.evaluate(async () => {
      let blocked = false;
      try { await fetch('https://orgloom.com/api/should-never-leave-prototype'); } catch (_) { blocked = true; }
      const query = await fetch('/api/query', { method: 'POST', body: JSON.stringify({ query: 'SELECT Id, Name FROM Account LIMIT 2' }), headers: { 'Content-Type': 'application/json' } });
      return { blocked, queryOk: query.ok, mock: window.ORGLOOM_MOCK };
    });
    assert.equal(network.blocked, true);
    assert.equal(network.queryOk, true);
    assert.equal(network.mock, true);
    report.steps.push('Outbound fetch is blocked; local mock SOQL responds');
    const first = canvas.locator('[data-rec-id]').first();
    const recordId = await first.getAttribute('data-rec-id');
    const beforeDrag = await first.boundingBox();
    await workbench.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + 22);
    await workbench.mouse.down();
    await workbench.mouse.move(beforeDrag.x + beforeDrag.width / 2 + 60, beforeDrag.y + 42, { steps: 12 });
    await workbench.mouse.up();
    await until(async () => Math.abs((await first.boundingBox()).x - beforeDrag.x) > 30, 'record drag');
    report.steps.push('Drag a real canvas record while preserving its relationships');
    const box = await until(() => canvas.locator(`[data-rec-id="${recordId}"]`).boundingBox(), 'dragged card geometry');
    await workbench.mouse.dblclick(box.x + box.width / 2, box.y + 22);
    await canvas.locator('[data-editor-element="insert-form"]').waitFor({ state: 'visible' });
    const name = canvas.locator('[id$="f_Name"]');
    await name.fill('VS Code local edit');
    await workbench.screenshot({ path: path.join(output, '03-record-editor.png') });
    await vscode.commands.executeCommand('notifications.hideToasts');
    await canvas.locator('[data-editor-element="modal-submit"]').click();
    await until(async () => (await canvas.locator(`[data-rec-id="${recordId}"]`).innerText()).includes('VS Code local edit'), 'edited card label');
    report.steps.push('Open real record editor and save a local field edit');
    // Wait for the canvas autosave and extension persistence bridge, then recreate
    // the webview entirely to exercise more than retainContextWhenHidden.
    await new Promise(resolve => setTimeout(resolve, 1800));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('orgloom.openCanvas');
    canvas = await until(findCanvas, 'recreated canvas');
    await until(async () => (await canvas.locator('[data-rec-id]').allTextContents()).some(text => text.includes('VS Code local edit')), 'edit survives tab disposal');
    await canvas.locator('#prototype-fit').click();
    await new Promise(resolve => setTimeout(resolve, 300));
    report.steps.push('Unsaved edit survives closing and reopening the canvas tab');
    await workbench.screenshot({ path: path.join(output, '02-restored.png') });
    assert.equal(report.requests.some(url => /^https?:\/\/(?:[^/]*\.)?(?:orgloom\.com|salesforce\.com|posthog\.com|sentry\.io)(?:\/|$)/i.test(url)), false);
    report.steps.push('No Org Loom, Salesforce, or analytics requests observed from workbench');
    fs.writeFileSync(path.join(output, 'extension-report.json'), JSON.stringify(report, null, 2));
    console.log('Org Loom extension smoke tests passed:', report.steps.join('; '));
    await require('./live-webview.cjs').run({ workbench, until, output });
    console.log('Connected desktop adapter smoke test passed with controlled Salesforce transport.');
    await require('./desktop-webview.cjs').run({workbench,until,output});
    await require('./upload-webview.cjs').run({ workbench, until, output });
    console.log('Desktop multi-record create/delete upload UI passed.');
    await require('./upsert-webview.cjs').run({workbench,until,output});
    await require('./parity-webview.cjs').run({workbench,until,output});
    await require('./recovery-webview.cjs').run({workbench,until,output});
    await require('./managed-features-webview.cjs').run({workbench,until,output});
    if (process.env.ORGLOOM_TEST_CLI_ALIAS) await require('./cli-webview.cjs').run({ workbench, until, output });
  } catch (error) {
    report.error = error.stack;
    if (workbench) {
      await workbench.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      report.frames = await Promise.all(workbench.frames().map(async frame => ({ url: frame.url(), text: (await frame.locator('body').innerText().catch(() => '')).slice(0, 5000), debug: await frame.evaluate(() => ({ origin: location.origin, href: location.href, ready: document.readyState, mock: window.ORGLOOM_MOCK, fixture: !!window.OrgLoomMock, storage: Object.keys(sessionStorage), state: window.Orgloom?.canvasState?.snapshot(), scripts: Array.from(document.scripts).map(s => ({src:s.src, text:s.src ? null : s.textContent.slice(0,1000)})) })).catch(() => null) })));
    }
    fs.writeFileSync(path.join(output, 'extension-report.json'), JSON.stringify(report, null, 2));
    throw error;
  } finally {
    await browser?.close();
  }
};
