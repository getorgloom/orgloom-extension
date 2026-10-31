'use strict';
const vscode=require('vscode'),path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
const {fixture}=require('./upload-fixture.cjs');
exports.run=async({workbench,until,output})=>{
  const root=vscode.extensions.getExtension('orgloom.orgloom-vscode').extensionPath;
  const {LiveApi}=require(path.join(root,'src/live-api.cjs')),{SalesforceError}=require(path.join(root,'src/salesforce.cjs'));
  const {RecoveryStore}=require(path.join(root,'src/recovery.cjs')),{authorizeRecovery}=require(path.join(root,'src/recovery-access.cjs'));
  const {RecoverySession}=require(path.join(root,'src/recovery-session.cjs')),{renderHtml}=require(path.join(root,'src/html.cjs'));
  const f=fixture(LiveApi,SalesforceError),identity=f.client.publicIdentity();
  const one=f.seed('Account',{Name:'Recovery existing',Private__c:'Must disappear'}),two=f.seed('Account',{Name:'Access later removed'});
  await f.api.retrieve('Account',one.Id);await f.api.retrieve('Account',two.Id);
  const original=f.client.request;let revoked=false;
  f.client.request=async(route,options)=>{
    if(revoked&&route.endsWith(two.Id))throw new SalesforceError('Unavailable','NOT_FOUND',404);
    const r=await original(route,options);
    if(route.endsWith('/describe'))r.fields=revoked?r.fields.filter(v=>v.name!=='Private__c'):[...r.fields,{name:'Private__c',type:'string',label:'Private',createable:true,updateable:true}];
    if(revoked&&route.endsWith(one.Id))delete r.Private__c;
    return r;
  };
  const identityKey=`desktop:${identity.orgId}:${identity.userId}`,draftKey=`orgloom:canvas-draft:v1|${identityKey}:new`,pointer=`orgloom:canvas-draft-active:v1|${identityKey}`;
  const store=new RecoveryStore(path.join(output,'recovery-ui'),f.secrets,identity);
  const state={version:1,local:{},session:{[pointer]:draftKey,[draftKey]:JSON.stringify({v:1,ts:Date.now(),identity:identityKey,scope:identityKey+':new',state:{bulkIdSeq:3,bulkRecords:[{id:1,objectName:'Account',loadedFromId:one.Id,values:{...one},loadedValues:{...one},x:100,y:100},{id:2,objectName:'Account',loadedFromId:two.Id,values:{...two},loadedValues:{...two},x:100,y:350},{id:3,objectName:'Account',values:{Name:'Recovery draft'},x:400,y:100}],selectedObjects:[],bulkAssociations:[],graphView:'bulk'}})}};
  await store.save(state,f.api.baselines);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.hideToasts');
  const panel=vscode.window.createWebviewPanel('orgloom.recoveryTest','Org Loom · Recovery Test',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.file(path.join(root,'media'))]});
  let restores=0,error=null;
  const gate=new RecoverySession({restore:async()=>{const result=await authorizeRecovery(f.api,await store.load());f.api.baselines=new Map(result.baselines);await store.save(result.state,f.api.baselines);restores++;return {state:result.state,notice:result.notice};},save:(state,baselines)=>store.save(state,new Map(baselines))});
  const listener=panel.webview.onDidReceiveMessage(async message=>{
    try{
      if(message.type==='recovery-ready'){await panel.webview.postMessage(await gate.begin(message.documentId));return;}
      if(!gate.accepts(message))return;
      if(message.type==='save-recovery'){await gate.checkpoint({...message,baselines:[...f.api.baselines]});await panel.webview.postMessage({type:'recovery-status'});}
      if(message.type==='live-api')await panel.webview.postMessage({type:'live-api-result',id:message.id,...await f.api.handle(message)});
    }catch(e){error=e;await panel.webview.postMessage({type:'recovery-ready-result',documentId:message.documentId,error:e.message});}
  });
  panel.webview.html=renderHtml({root,identity,managedRecovery:true,resource:p=>panel.webview.asWebviewUri(vscode.Uri.file(path.join(root,'media',p))).toString(),cspSource:panel.webview.cspSource});
  const find=async()=>{for(const frame of workbench.frames())if(await frame.locator('[data-rec-id]').count().catch(()=>0))return frame;};
  try{
    let canvas=await until(find,'gated recovery canvas');await until(async()=>(await canvas.locator('[data-rec-id]').count())===3,'three recovered records');
    await canvas.locator('#prototype-fit').click();
    const box=await canvas.locator('[data-rec-id="1"]').boundingBox();await workbench.mouse.dblclick(box.x+box.width/2,box.y+22);await canvas.locator('[id$="f_Name"]').fill('Latest checkpoint survives reload');await canvas.locator('[data-editor-element="modal-submit"]').click();
    await until(async()=>JSON.stringify((await store.load()).state).includes('Latest checkpoint survives reload'),'latest durable checkpoint');
    revoked=true;
    const reloadCommand=(await vscode.commands.getCommands(true)).find(command=>/reloadWebview/i.test(command));
    assert.ok(reloadCommand,'VS Code exposes its webview reload command');
    await vscode.commands.executeCommand(reloadCommand);
    await until(()=>restores===2,'reload handshake');
    canvas=await until(find,'reloaded canvas');
    await until(async()=>{const text=await canvas.locator('[data-rec-id]').allTextContents();return text.length===2&&text.some(t=>t.includes('Latest checkpoint survives reload'))&&text.some(t=>t.includes('Recovery draft'));},'latest draft with inaccessible record omitted');
    const recovered=await store.load();assert.ok(!JSON.stringify(recovered).includes('Must disappear'));assert.ok(!JSON.stringify(recovered).includes('Access later removed'));
    assert.equal(f.api.baselines.get('Account:'+one.Id).Name,'Recovery existing');assert.equal(error,null);
    await canvas.locator('#desktop-recovery-notice').waitFor({state:'visible'});
    await workbench.screenshot({path:path.join(output,'12-recovery-reload.png')});
    await fs.writeFile(path.join(output,'recovery-report.json'),JSON.stringify({passed:['Actual webview reload reads latest encrypted checkpoint','Permission checks run before scripts/rendering','Revoked record and field values removed from UI and disk','Allowed draft and edits preserved','Original upload baseline preserved'],writes:f.calls.filter(c=>c.method&&c.method!=='GET').length},null,2));
  }catch(error){await workbench.screenshot({path:path.join(output,'recovery-failure.png')});await fs.writeFile(path.join(output,'recovery-failure.txt'),(await Promise.all(workbench.frames().map(f=>f.locator('body').innerText().catch(()=>'')))).join('\n'));throw error;}
  finally{await gate.close();listener.dispose();f.api.dispose();panel.dispose();await store.clear();}
};
