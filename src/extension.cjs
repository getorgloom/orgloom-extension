const vscode = require('vscode');
const { renderHtml } = require('./html.cjs');
const { validateState } = require('./state.cjs');
let panel;
const STATE_KEY = 'prototype.sample.v1';
function activate(context) {
  require('./live-extension.cjs').activateLive(context);
  // Fictional samples are available only to the isolated development/test host.
  if (context.extensionMode === vscode.ExtensionMode.Production) return;
  function createHtml(webview, state) {
    return renderHtml({
      root: context.extensionPath,
      resource: p => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', p.replace(/^\//, ''))).toString(),
      cspSource: webview.cspSource,
      state,
    });
  }
  function attach(target) {
    panel = target;
    const session = { disposed: false };
    target.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
    const messages = target.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'save-sample') {
        const state = validateState(message.state);
        if (state && !session.disposed) await context.globalState.update(STATE_KEY, state);
      } else if (message.type === 'reset-sample') {
        await reset();
      }
    });
    target.onDidDispose(() => { session.disposed = true; messages.dispose(); if (panel === target) panel = undefined; });
    target.webview.html = createHtml(target.webview, validateState(context.globalState.get(STATE_KEY)));
    return target;
  }
  function open() {
    if (panel) { panel.reveal(); return; }
    attach(vscode.window.createWebviewPanel('orgloom.canvas', 'Org Loom · Sample Canvas', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true }));
  }
  async function reset() {
    const answer = await vscode.window.showWarningMessage('Reset the fictional sample canvas and discard its local edits?', { modal: true }, 'Reset sample');
    if (answer !== 'Reset sample') return;
    panel?.dispose();
    await context.globalState.update(STATE_KEY, undefined);
    open();
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('orgloom.openCanvas', open),
    vscode.commands.registerCommand('orgloom.resetSample', reset),
    vscode.window.registerWebviewPanelSerializer('orgloom.canvas', { async deserializeWebviewPanel(target) { attach(target); } }),
    { dispose() { panel?.dispose(); } },
  );
  if (vscode.workspace.getConfiguration('orgloom.prototype').get('openOnStartup', false)) open();
}
module.exports = { activate };
