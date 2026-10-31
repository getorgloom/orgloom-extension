'use strict';
const vscode=require('vscode'),path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const {fixture}=require('./upload-fixture.cjs');
exports.run=async({workbench,until,output})=>{
 const root=vscode.extensions.getExtension('orgloom.orgloom-vscode').extensionPath;
 const {LiveApi}=require(path.join(root,'src/live-api.cjs'));
 const {SalesforceError}=require(path.join(root,'src/salesforce.cjs'));
 const {renderHtml}=require(path.join(root,'src/html.cjs'));
 const f=fixture(LiveApi,SalesforceError),existing=f.seed('Account',{Name:'Before',External_Key__c:'C123'}),reviewed=[],messages=[];
 f.api.confirmUpload=async plan=>{reviewed.push(plan);return true;};
 f.api.files={run:async()=>({files:[{name:'Account.csv',type:'text/csv',base64:Buffer.from('Name,External_Key__c\nUpdated customer,C123\nDuplicate alert,C456').toString('base64')}]})};
 await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
 const panel=vscode.window.createWebviewPanel('orgloom.upsertTest','Org Loom · Upsert Test',vscode.ViewColumn.One,{enableScripts:true,localResourceRoots:[vscode.Uri.file(path.join(root,'media'))]});
 panel.webview.onDidReceiveMessage(async msg=>{if(msg?.type==='live-api'){const response=await f.api.handle(msg);messages.push({request:msg,response});await panel.webview.postMessage({type:'live-api-result',id:msg.id,...response});}});
 panel.webview.html=renderHtml({root,identity:f.client.publicIdentity(),resource:p=>panel.webview.asWebviewUri(vscode.Uri.file(path.join(root,'media',p))).toString(),cspSource:panel.webview.cspSource});
 try {
  const canvas=await until(async()=>{for(const frame of workbench.frames())if(await frame.locator('#prototype-disconnect').count().catch(()=>0))return frame;},'upsert canvas');
  await canvas.locator('[data-bulk-add-menu]').click();await canvas.locator('[data-add-menu="csv"]').click();await canvas.locator('#lcsv-dropzone').click();
  await canvas.locator('[data-lcsv-obj]').first().selectOption('Account');
  await canvas.locator('[data-lcsv-op]').first().selectOption('upsert');
  await canvas.locator('[data-lcsv-op-key]').first().selectOption('External_Key__c');
  await canvas.locator('#linked-csv-confirm').click();
  await until(async()=>(await canvas.locator('[data-rec-id]').allTextContents()).some(t=>t.includes('Updated customer')),'upsert CSV records');
  await canvas.locator('[data-bulk-upload]').click();await canvas.getByRole('button',{name:/^Upload \d|^Upload$|^Confirm upload$/}).last().click();
  await canvas.locator('#upload-allow-dups').waitFor({state:'visible'});
  assert.equal(f.db.get(existing.Id).record.Name,'Updated customer');assert.equal(f.db.size,1);
  await canvas.locator('#upload-allow-dups').click();
  await canvas.locator('#upload-confirm').click();
  await until(()=>f.db.size===2,'duplicate-alert retry creates the remaining upsert');
  await until(async()=>(await canvas.locator('body').innerText()).includes('uploaded to Salesforce'),'upsert completion UI');
  assert.equal(reviewed.at(-1).allowDuplicates,true);
  assert.ok(messages.some(m=>m.request.path==='/api/upload/bulk'&&m.response.status===200));
  assert.equal(f.calls.filter(c=>c.method==='POST').length,2);
  await workbench.screenshot({path:path.join(output,'10-upsert-duplicate-results.png')});
  fs.writeFileSync(path.join(output,'upsert-ui-report.json'),JSON.stringify({mode:'Controlled Salesforce transport',passed:['CSV upsert selection and External ID mapping','Existing record updated through the real upload UI','Duplicate alert rendered with Upload anyway','Explicit retry flag reaches native confirmation','Remaining record inserted without duplicating successful work'],realSalesforceWrites:0},null,2));
 } catch(error) {fs.writeFileSync(path.join(output,'upsert-ui-failure.json'),JSON.stringify({error:error.stack,messages},null,2));await workbench.screenshot({path:path.join(output,'upsert-ui-failure.png')});throw error;}
 finally {f.api.dispose();panel.dispose();}
};
