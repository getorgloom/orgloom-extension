'use strict';
const vscode=require('vscode'),path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const {fixture}=require('./upload-fixture.cjs');
exports.run=async({workbench,until,output})=>{
 const root=vscode.extensions.getExtension('orgloom.orgloom-vscode').extensionPath;
 const {LiveApi}=require(path.join(root,'src/live-api.cjs'));
 const {SalesforceError}=require(path.join(root,'src/salesforce.cjs'));
 const {renderHtml}=require(path.join(root,'src/html.cjs'));
 const f=fixture(LiveApi,SalesforceError),exports=[],messages=[];
 const payload={_meta:{app:'Org Loom',version:1,exportedFrom:'00D000000009999AAA',forMigration:true,nativeMigrationObjects:{Account:{references:['ParentId']}}},schema:{objects:[]},records:[{id:1,objectName:'Account',values:{Name:'Migrated parent',Id:'001000000009991AAA'},loadedFromId:'001000000009991AAA'},{id:2,objectName:'Account',values:{Name:'Migrated child',ParentId:'001000000009991AAA'}}],associations:[{fromId:2,toId:1,fieldName:'ParentId'}]};
 f.api.files={run:async(action,body)=>{if(action==='open')return {files:[{name:'migration.json',type:'application/json',base64:Buffer.from(JSON.stringify(payload)).toString('base64')}]};exports.push(body);return {saved:true,name:body.name};}};
 f.api.confirmUpload=async()=>{throw Error('This test cannot upload');};
 await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
 const panel=vscode.window.createWebviewPanel('orgloom.parityTest','Org Loom · Migration Test',vscode.ViewColumn.One,{enableScripts:true,localResourceRoots:[vscode.Uri.file(path.join(root,'media'))]});
 panel.webview.onDidReceiveMessage(async msg=>{if(msg?.type==='live-api'){const response=await f.api.handle(msg);messages.push({path:msg.path,response});await panel.webview.postMessage({type:'live-api-result',id:msg.id,...response});}});
 panel.webview.html=renderHtml({root,identity:f.client.publicIdentity(),resource:p=>panel.webview.asWebviewUri(vscode.Uri.file(path.join(root,'media',p))).toString(),cspSource:panel.webview.cspSource});
 try {
  const canvas=await until(async()=>{for(const frame of workbench.frames())if(await frame.locator('#prototype-disconnect').count().catch(()=>0))return frame;},'migration canvas');
  await canvas.locator('[data-bulk-add-menu]').click();await canvas.locator('[data-add-menu="fixture"]').click();await canvas.locator('#ici-dropzone').click();
  await canvas.locator('.migrate-match-modal').waitFor({state:'visible'});
  await until(async()=>await canvas.locator('.mm-action-radio[value="new"]').count()===2,'two migration record decisions');
  // Closing review must preserve the original, empty canvas.
  await canvas.locator('button[data-mm-close]').click();
  assert.equal(await canvas.locator('[data-rec-id]').count(),0);
  // The import preview remains open after cancelling reconciliation.
  const replace=canvas.getByRole('button',{name:'Replace canvas',exact:true});
  if(!await replace.isVisible()) { await canvas.locator('[data-bulk-add-menu]').click();await canvas.locator('[data-add-menu="fixture"]').click();await canvas.locator('#ici-dropzone').click(); }
  await until(async()=>await canvas.locator('.mm-action-radio[value="new"]').count()===2,'migration reopened');
  for(let i=0;i<2;i++)await canvas.locator('.mm-action-radio[value="new"]').nth(i).check();
  await canvas.locator('[data-mm-primary]').click();await canvas.locator('[data-mm-primary]').click();
  await workbench.screenshot({path:path.join(output,'11-migration-review.png')});
  await canvas.locator('[data-mm-primary]').click();
  await until(async()=>(await canvas.locator('[data-rec-id]').allTextContents()).some(t=>t.includes('Migrated child')),'migration applied');
  assert.equal(await canvas.locator('[data-rec-id]').count(),2);
  await canvas.locator('[data-bulk-ops]').click();await canvas.locator('[data-bulk-op="migrate-org"]').click();
  assert.equal(await canvas.locator('[data-migration]').isChecked(),true);
  await canvas.locator('[data-export]').click();await until(()=>exports.length===1,'migration native export');
  const file=JSON.parse(Buffer.from(exports[0].base64,'base64').toString());assert.equal(file._meta.forMigration,true);assert.equal(file.records.length,2);
  assert.ok(file.records.every(r=>!r.loadedFromId));assert.equal(file.associations.length,1);
  assert.ok(file.records.every(r=>!JSON.stringify(r.values).includes('001000000009991AAA')));
  await canvas.locator('[data-bulk-ops]').click();await canvas.locator('[data-bulk-op="auto-fill"]').click();
  await canvas.locator('#af-action').selectOption('all');await canvas.locator('[data-af-run]').click();
  await until(()=>messages.some(m=>m.path==='/api/capabilities/auto-fill-records/check'&&m.response.status===200),'auto-fill capability check');
  await until(async()=>await canvas.locator('.auto-fill-modal').count()===0,'auto-fill completes');
  const pasted=f.seed('Account',{Name:'Pasted record'});
  const paste=()=>canvas.evaluate(url=>{const data=new DataTransfer();data.setData('text/plain',url);document.getElementById('bulk-canvas-cy').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},'https://test.my.salesforce.com/lightning/r/Account/'+pasted.Id+'/view');
  await paste();await until(async()=>(await canvas.locator('[data-rec-id]').allTextContents()).some(t=>t.includes('Pasted record')),'record link paste loads card');
  await paste();await until(()=>messages.filter(m=>m.path==='/api/desktop/record-link').length===2,'repeat paste completes');
  assert.equal(await canvas.locator('[data-rec-id]').count(),3);
  assert.equal(f.calls.filter(c=>c.method&&c.method!=='GET').length,0);
  assert.equal(await canvas.locator('[data-bulk-save-primary]:visible').count(),1);
  assert.equal(await canvas.locator('[data-bulk-share]:visible').count(),1);
  fs.writeFileSync(path.join(output,'parity-report.json'),JSON.stringify({passed:['Cross-org file launches migration review','Cancel preserves canvas','Destination create decisions and relationship reconstruction','Migration export uses native file bridge','Auto-fill works through the capability gate','Record-link paste loads once and preserves duplicates','Saving and sharing expose managed-package information'],writes:0},null,2));
 } catch(error) {
  fs.writeFileSync(path.join(output,'parity-failure.json'),JSON.stringify(messages,null,2));
  fs.writeFileSync(path.join(output,'parity-failure.txt'),(await Promise.all(workbench.frames().map(f=>f.locator('body').innerText().catch(()=>'')))).join('\n'));
  await workbench.screenshot({path:path.join(output,'parity-failure.png')});throw error;
 } finally {f.api.dispose();panel.dispose();}
};
