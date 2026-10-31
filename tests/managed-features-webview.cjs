'use strict';
const vscode=require('vscode'),assert=require('node:assert/strict'),path=require('node:path');
exports.run=async({workbench,until,output})=>{
 const root=vscode.extensions.getExtension('orgloom.orgloom-vscode').extensionPath;
 const {renderHtml}=require(path.join(root,'src/html.cjs'));
 const {externalLink}=require(path.join(root,'src/external-links.cjs'));
 const {fixture}=require('./upload-fixture.cjs'),f=fixture(),opened=[],requests=[];
 await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
 const panel=vscode.window.createWebviewPanel('orgloom.managedFeatures','Org Loom · Managed features',vscode.ViewColumn.One,{enableScripts:true,localResourceRoots:[vscode.Uri.file(path.join(root,'media'))]});
 panel.webview.onDidReceiveMessage(async msg=>{
  if(msg.type==='open-external')opened.push(externalLink(msg.url,f.client.publicIdentity()));
  if(msg.type==='live-api'){requests.push(msg);await panel.webview.postMessage({type:'live-api-result',id:msg.id,...await f.api.handle(msg)});}
 });
 panel.webview.html=renderHtml({root,identity:f.client.publicIdentity(),resource:p=>panel.webview.asWebviewUri(vscode.Uri.file(path.join(root,'media',p))).toString(),cspSource:panel.webview.cspSource});
 try{
  const canvas=await until(async()=>{for(const frame of workbench.frames())if(await frame.locator('#prototype-disconnect').count().catch(()=>0))return frame;},'connected canvas');
  await canvas.locator('[data-bulk-save]').waitFor({state:'visible'});
  for(const [selector,title] of [['[data-desktop-managed-save]','Save canvases'],['[data-bulk-share]','Share canvases'],['[data-app-history]','Upload Recall']]){
   if(title==='Save canvases')await canvas.locator('[data-bulk-save]').click();
   await canvas.locator(selector).click();
   const dialog=canvas.locator('#desktop-managed-feature');
   await dialog.waitFor({state:'visible'});
   assert.equal(await dialog.locator('h3').innerText(),title);
   assert.match(await dialog.innerText(),/only in the Org Loom managed package version/);
   const count=opened.length;
   await dialog.getByRole('link',{name:'Visit orgloom.com'}).click();
   await until(()=>opened.length===count+1,'homepage handed to validated external opener');
   assert.equal(opened.at(-1),'https://orgloom.com/');
   if(title==='Upload Recall')await workbench.screenshot({path:path.join(output,'16-managed-feature-recall.png')});
   await dialog.getByRole('button',{name:'Close',exact:true}).click();
   assert.equal(await canvas.locator('#desktop-managed-feature').count(),0);
  }
  await canvas.locator('[data-bulk-save]').click();
  await canvas.locator('[data-tpl-action="export-file"]').waitFor({state:'visible'});
  assert.ok(!requests.some(r=>/save|share|upload-batches|recall/.test(r.path||r.url||'')),'Unavailable features do not request package APIs');
 }finally{f.api.dispose();panel.dispose();}
};
