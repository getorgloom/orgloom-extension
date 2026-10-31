'use strict';
const vscode = require('vscode');
const { SalesforceClient } = require('./salesforce.cjs');
const { LiveApi } = require('./live-api.cjs');
const { acquireConnectionLock } = require('./connection-lock.cjs');
const { renderHtml } = require('./html.cjs');
const { RecoveryStore, cleanupRecovery } = require('./recovery.cjs');
const { authorizeRecovery } = require('./recovery-access.cjs');
const { RecoverySession } = require('./recovery-session.cjs');
const { RecoveryPreference, SETTING: RECOVERY_SETTING } = require('./recovery-preference.cjs');
const { createDesktopFiles } = require('./files.cjs');
const { SalesforceCli } = require('./salesforce-cli.cjs');
const { externalLink } = require('./external-links.cjs');

function activateLive(context) {
  const cli = new SalesforceCli();
  const client = new SalesforceClient(context.secrets, { cli, confirmProduction: async identity => await vscode.window.showWarningMessage('Connect to PRODUCTION: ' + identity.orgName + '?', { modal: true, detail: 'User: ' + identity.displayName + '\nOrg: ' + identity.orgId + '\nThis is live production data. Changes remain on the canvas until you explicitly confirm an upload.' }, 'Connect to production') === 'Connect to production' });
  let releaseLock, panel, api, recoveryStore, recoverySession, connecting = false, opening = false, maintenance=Promise.resolve();
  const recoveryPreference = new RecoveryPreference(vscode, context, async () => {
    let unlock;
    try {
      if (!releaseLock) unlock = acquireConnectionLock(context.globalStorageUri.fsPath);
      await cleanupRecovery(context.globalStorageUri.fsPath, context.secrets, Date.now(), true);
    } finally { unlock?.(); }
  });
  const lease = async () => { await maintenance; releaseLock ||= acquireConnectionLock(context.globalStorageUri.fsPath); };
  const guard = fn => async () => { try { await fn(); } catch (error) { await vscode.window.showErrorMessage(error.message); } };
  async function connectCli() {
    if (connecting) return;
    if (client.desktopUploadInProgress) throw new Error('Wait for the current upload to finish before reconnecting.');
    if (panel) { await vscode.window.showInformationMessage('Disconnect the current canvas before starting a new connection.'); return; }
    connecting = true;
    try {
      const orgs = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading Salesforce CLI orgs' }, () => cli.list());
      const selected = await vscode.window.showQuickPick([
        ...orgs.map(org => ({ label: org.alias || org.username, description: org.alias ? org.username : org.instanceUrl, detail: `${org.instanceUrl} · Identity and org type verified after selection`, org })),
        { label: '$(sign-in) Sign in to another org…', description: 'Salesforce CLI opens your browser', login: true },
      ], { title: 'Connect with Salesforce CLI', placeHolder: orgs.length ? 'Select a Salesforce org' : 'No saved CLI orgs. Sign in to get started.', matchOnDescription: true });
      if (!selected) return;
      let org = selected.org;
      if (selected.login) {
        const origin = await vscode.window.showInputBox({ title: 'Sign in through Salesforce CLI', prompt: 'Salesforce My Domain HTTPS URL', value: 'https://test.salesforce.com', ignoreFocusOut: true });
        if (origin === undefined) return;
        org = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Complete Salesforce CLI sign-in in your browser', cancellable: true }, async (_progress, token) => {
          const controller = new AbortController();
          const listener = token.onCancellationRequested(() => controller.abort());
          try { return await cli.login(origin, controller.signal); } finally { listener.dispose(); }
        });
      }
      await lease();
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Verifying Salesforce CLI connection' }, async () => {
        await client.accept(await cli.session(org.username, org.orgId));
      });
      await open();
    } catch (error) { if (!client.publicIdentity()) { releaseLock?.(); releaseLock = undefined; } throw error; }
    finally { connecting = false; }
  }
  async function open(restoredPanel, serializedIdentity) {
    if (panel) { if(restoredPanel && restoredPanel!==panel)restoredPanel.dispose(); panel.reveal(); return; }
    if (opening) { restoredPanel?.dispose(); return; }
    opening=true;
    try {
      await lease();
      if (!client.publicIdentity() && !await client.restore()) throw new Error('Run Org Loom: Connect with Salesforce CLI.');
      if(serializedIdentity && (serializedIdentity.orgId!==client.publicIdentity().orgId || serializedIdentity.userId!==client.publicIdentity().userId))throw Error('The restored panel belongs to a different Salesforce connection. Open a new Salesforce canvas.');
      await recoveryPreference.choose();
      await recoveryPreference.queue;
      await cleanupRecovery(context.globalStorageUri.fsPath, context.secrets);
      recoveryStore = new RecoveryStore(context.globalStorageUri.fsPath, context.secrets, client.publicIdentity());
      // Upload is confirmed in the canvas review. Keep host permission and
      // concurrency checks without a second operating-system dialog.
      api = new LiveApi(client, { secrets: context.secrets, files: createDesktopFiles(vscode), confirmUpload: async () => true });
      await api.uploader.readPending();
      const title = client.publicIdentity().orgType === 'production' ? 'Org Loom · PRODUCTION' : 'Org Loom';
      const target = restoredPanel || vscode.window.createWebviewPanel('orgloom.testCanvas', title, vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
      target.title = title;
      target.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'media')]};
      panel = target;
      const ownApi = api, ownRecovery = recoveryStore;
      let running = 0;
      const session = recoverySession = new RecoverySession({
        save:(state,baselines)=>recoveryPreference.run(()=>ownRecovery.save(state,new Map(baselines))),
        restore:()=>recoveryPreference.run(async active=>{
          if(running || ownApi.uploading)throw Error('A Salesforce operation is still finishing. Wait before reopening.');
          let recovered;
          try{recovered=await ownRecovery.load();}
          catch(error){
            const choice=await vscode.window.showWarningMessage('Local canvas recovery could not be opened.',{modal:true,detail:error.message},'Discard recovery');
            if(choice!=='Discard recovery')throw error;
            await ownRecovery.clear();recovered=null;
          }
          if(recovered){
            const choice=await vscode.window.showInformationMessage('Restore the local canvas for '+client.publicIdentity().orgName+'?',{modal:true,detail:'Recovery from '+new Date(recovered.time).toLocaleString()+'. Salesforce access will be checked before any records are displayed.'},'Restore','Discard');
            if(!choice)throw Error('Restore cancelled. Your checkpoint has been kept.');
            if(choice==='Discard'){await ownRecovery.clear();recovered=null;}
          }
          recovered=await authorizeRecovery(ownApi,recovered);
          if(panel!==target)throw Error('Canvas closed.');
          if(!active())return {state:null};
          ownApi.baselines=new Map(recovered?.baselines || []);
          // Remove inaccessible values from the durable copy, not only the UI.
          if(recovered)await ownRecovery.save(recovered.state,ownApi.baselines);
          return {state:recovered?.state || null,notice:recovered?.notice};
        }, {state:null}),
      });
      const messages = target.webview.onDidReceiveMessage(async message => {
        if(message?.type==='recovery-ready'){
          try{await target.webview.postMessage(await session.begin(message.documentId));}
          catch(error){await target.webview.postMessage({type:'recovery-ready-result',documentId:message.documentId,error:error.message});}
          return;
        }
        if(!session.accepts(message))return;
        if (message?.type === 'onboarding-preference') {
          if (panel === target && ['dismissed','completed'].includes(message.flag)) {
            const key = 'onboarding.' + ownApi.orgId + '.' + ownApi.userId;
            await context.globalState.update(key, { ...context.globalState.get(key, {}), [message.flag]: true });
          }
          return;
        }
        if (message?.type === 'open-external') {
          await guard(async () => {
            if (panel !== target) return;
            ownApi.assertActive();
            await vscode.env.openExternal(vscode.Uri.parse(externalLink(message.url, client.publicIdentity())));
          })();
          return;
        }
        if (message?.type === 'save-recovery') {
          try { await session.checkpoint({...message,baselines:[...ownApi.baselines]}); if(session.accepts(message))await target.webview.postMessage({type:'recovery-status'}); }
          catch(error) { await target.webview.postMessage({type:'recovery-status',error:error.message}); }
          return;
        }
        if (message?.type === 'disconnect-test-org') { await guard(disconnect)(); return; }
        if (message?.type !== 'live-api' || running >= 64) return;
        running++;
        try { const reply = await ownApi.handle(message); if (panel === target && session.accepts(message)) await target.webview.postMessage({ type: 'live-api-result', id: message.id, ...reply }); }
        finally { running--; }
      });
      target.onDidDispose(() => { void session.close(); ownApi.dispose(); messages.dispose(); if (panel === target) { panel = undefined; api = undefined; } });
      target.webview.html = renderHtml({ root: context.extensionPath, cspSource: target.webview.cspSource, resource: p => target.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', p.replace(/^\//, ''))).toString(), identity: client.publicIdentity(), managedRecovery:true, preferences: context.globalState.get('onboarding.' + ownApi.orgId + '.' + ownApi.userId, {}) });
    } catch (error) { restoredPanel?.dispose(); releaseLock?.(); releaseLock = undefined; throw error; }
    finally { opening=false; }
  }
  async function disconnect() {
    if (connecting || client.desktopUploadInProgress) throw new Error('Wait for the current sign-in or upload to finish.');
    if (panel && await vscode.window.showWarningMessage('Disconnect and discard local canvas recovery and unsaved edits?', { modal: true }, 'Disconnect') !== 'Disconnect') return;
    await maintenance;
    await recoverySession?.close();
    panel?.dispose();
    await recoveryStore?.clear();
    await client.disconnect();
    releaseLock?.(); releaseLock = undefined;
    await vscode.window.showInformationMessage('Org Loom disconnected. Your Salesforce CLI login is unchanged. Use sf org logout if you also want to sign out of the CLI.');
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration(RECOVERY_SETTING)) return;
      maintenance = recoveryPreference.refresh();
      void maintenance.then(() => panel?.webview.postMessage({type:'recovery-status'})).catch(error => vscode.window.showErrorMessage('Local recovery could not be updated: ' + error.message));
    }),
    vscode.window.registerWebviewPanelSerializer('orgloom.testCanvas',{async deserializeWebviewPanel(target,state){try{await open(target,state);}catch(error){await vscode.window.showErrorMessage(error.message);}}}),
    vscode.commands.registerCommand('orgloom.connectCliOrg', guard(connectCli)),
    vscode.commands.registerCommand('orgloom.openTestCanvas', guard(open)),
    vscode.commands.registerCommand('orgloom.disconnectTestOrg', guard(disconnect)),
    { dispose() { panel?.dispose(); releaseLock?.(); releaseLock = undefined; } },
  );
  // No OS service is installed. Sweep on activation and daily while VS Code is
  // running, including identities that are never reopened. Missed runs catch up
  // on next activation. A different window's connection lock prevents races.
  const cleanup=async()=>{
    let unlock;
    try{if(!releaseLock)unlock=acquireConnectionLock(context.globalStorageUri.fsPath);await cleanupRecovery(context.globalStorageUri.fsPath,context.secrets,Date.now(),!recoveryPreference.enabled);}
    catch(error){if(!/Another VS Code window/.test(error.message))await vscode.window.showWarningMessage('Org Loom recovery cleanup failed: '+error.message);}
    finally{unlock?.();}
  };
  maintenance=recoveryPreference.refresh();
  void maintenance.catch(error => vscode.window.showWarningMessage('Org Loom recovery cleanup failed: ' + error.message));
  const cleanupTimer=setInterval(()=>{maintenance=maintenance.then(cleanup);},24*60*60*1000);cleanupTimer.unref?.();
  context.subscriptions.push({dispose(){clearInterval(cleanupTimer);}});
}
module.exports = { activateLive };
