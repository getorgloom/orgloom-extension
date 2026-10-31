'use strict';
const vscode = require('vscode');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
exports.run = async ({ workbench, until, output }) => {
  const root = vscode.extensions.getExtension('orgloom.orgloom-vscode').extensionPath;
  const { LiveApi } = require(path.join(root,'src/live-api.cjs'));
  const { SalesforceError } = require(path.join(root,'src/salesforce.cjs'));
  const { renderHtml } = require(path.join(root,'src/html.cjs'));
  const identity = { orgId:'00D000000000001AAA',userId:'005000000000001AAA',orgName:'Controlled transport fixture',displayName:'Test User',timeZone:'UTC',instanceUrl:'https://fixture.my.salesforce.com' };
  const record={Id:'001000000000001AAA',Name:'Desktop test record',Phone:'555-0100',LastModifiedDate:'2026-10-21T12:00:00.000+0000'};
  const fields=[{name:'Id',label:'Record ID',type:'id',updateable:false,createable:false,nillable:false,filterable:true},{name:'Name',label:'Account Name',type:'string',nameField:true,updateable:true,createable:true,nillable:false,length:255,sortable:true,filterable:true},{name:'Phone',label:'Phone',type:'phone',updateable:true,createable:true,nillable:true,length:40},{name:'LastModifiedDate',label:'Last modified',type:'datetime',updateable:false,createable:false,nillable:false}];
  const metadata={name:'Account',label:'Account',labelPlural:'Accounts',keyPrefix:'001',queryable:true,updateable:true,createable:true,deletable:true,fields,recordTypeInfos:[],childRelationships:[{childSObject:'Contact',field:'AccountId',relationshipName:'Contacts'}]};
  const contact={Id:'003000000000001AAA',Name:'Related contact',AccountId:record.Id,LastModifiedDate:record.LastModifiedDate};
  const contactMetadata={...metadata,name:'Contact',label:'Contact',labelPlural:'Contacts',keyPrefix:'003',childRelationships:[],fields:[...fields,{name:'AccountId',label:'Account',type:'reference',filterable:true,referenceTo:['Account'],updateable:true}]};
  let latestRecovery; const exported=[]; const calls=[];let approvals=0;const map=new Map();
  const api=new LiveApi({publicIdentity:()=>identity,request:async(route,options={})=>{
    calls.push({route,method:options.method||'GET'});
    if(route.includes('/ui-api/'))throw new SalesforceError('Unsupported UI API','unsupported',404);
    if(route.endsWith('/sobjects/'))return {sobjects:[metadata,contactMetadata]};
    if(route.endsWith('/describe'))return route.includes('/Contact/')?contactMetadata:metadata;
    if(route.includes('UserRecordAccess'))return {records:[{RecordId:record.Id,HasReadAccess:true,HasEditAccess:true,HasDeleteAccess:false}]};
    if(route.includes('/query?'))return {records:decodeURIComponent(route).includes('COUNT()')?[]:[{...(decodeURIComponent(route).includes('FROM Contact')?contact:record)}],totalSize:1,done:true};
    if(options.method==='PATCH'){Object.assign(record,options.body);return null;}
    if(route.includes('/sobjects/Account/'))return {...record};
    if(route.includes('/sobjects/Contact/'))return {...contact};
    if(route.endsWith('/limits'))return {};
    throw new Error('Unexpected fixture route');
  }},{files:{run:async(action,body)=>{
    if(action==='open' && body.kind==='json')return {files:[{name:'saved.orgloom.json',type:'application/json',base64:exported[0].base64}]};
    if(action==='open')return {files:[{name:'Account.csv',type:'text/csv',base64:Buffer.from('Name,Phone\nImported draft,555-0111').toString('base64')}]};
    exported.push(body);return {saved:true,name:body.name};
  }},confirmUpload:async()=>{throw new Error('Writes are not permitted');},secrets:{get:async k=>map.get(k),store:async(k,v)=>map.set(k,v),delete:async k=>map.delete(k)}});
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  const panel=vscode.window.createWebviewPanel('orgloom.testFixture','Org Loom · Adapter Test',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.file(path.join(root,'media'))]});
  panel.webview.onDidReceiveMessage(async msg=>{if(msg?.type==='save-recovery')latestRecovery=msg.state; if(msg?.type==='live-api')await panel.webview.postMessage({type:'live-api-result',id:msg.id,...await api.handle(msg)});});
  panel.webview.html=renderHtml({root,identity,resource:p=>panel.webview.asWebviewUri(vscode.Uri.file(path.join(root,'media',p))).toString(),cspSource:panel.webview.cspSource});
  try {
    const canvas=await until(async()=>{for(const f of workbench.frames())if(await f.locator('#prototype-disconnect').count().catch(()=>0))return f;},'desktop services webview');
    await vscode.commands.executeCommand('notifications.hideToasts');
    await canvas.locator('[data-bulk-add-menu]').click();
    await canvas.locator('[data-add-menu="csv"]').click();
    await canvas.locator('#lcsv-dropzone').click();
    await canvas.locator('[data-lcsv-obj]').first().selectOption('Account');
    await canvas.locator('#linked-csv-confirm').click();
    await until(async()=>(await canvas.locator('[data-rec-id]').allTextContents()).some(t=>t.includes('Imported draft')),'CSV import draft');
    await canvas.locator('[data-bulk-ops]').click();
    await canvas.locator('[data-bulk-op="script"]').click();
    await canvas.locator('#desktop-script-source').fill('for (const r of records) { r.values.Name = "Scripted draft"; }');
    await canvas.locator('[data-run]').click();
    await until(async()=>(await canvas.locator('[data-apply]').isEnabled()),'isolated script preview');
    await canvas.locator('[data-apply]').click();
    await until(async()=>(await canvas.locator('[data-rec-id]').allTextContents()).some(t=>t.includes('Scripted draft')),'script apply');
    await until(()=>latestRecovery && Object.values(latestRecovery.session).some(v=>v.includes('Scripted draft')),'connected recovery checkpoint');
    panel.webview.html=renderHtml({root,identity,recovery:latestRecovery,resource:p=>panel.webview.asWebviewUri(vscode.Uri.file(path.join(root,'media',p))).toString(),cspSource:panel.webview.cspSource});
    await until(()=>canvas.isDetached(),'old webview disposed');
    const restored=await until(async()=>{for(const f of workbench.frames())if((await f.locator('[data-rec-id]').allTextContents().catch(()=>[])).some(t=>t.includes('Scripted draft')))return f;},'connected draft restores after webview reload');
    await restored.locator('[data-bulk-save]').click();
    await restored.locator('[data-tpl-action="export-file"]').click();
    await restored.locator('[data-export]').click();
    await until(()=>exported.length===1,'JSON canvas exporter');
    assert.equal(JSON.parse(Buffer.from(exported[0].base64,'base64').toString()).records[0].values.Name,'Scripted draft');
    await restored.locator('[data-bulk-add-menu]').click();
    await restored.locator('[data-add-menu="fixture"]').click();
    await restored.locator('#ici-dropzone').click();
    await restored.getByRole('button',{name:'Replace canvas',exact:true}).click();
    await until(async()=>(await restored.locator('[data-rec-id]').allTextContents()).filter(t=>t.includes('Scripted draft')).length===1,'JSON reimport');
    // Exercise the CSV download transport too.

    await restored.evaluate(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['Name\nExported'],{type:'text/csv'}));a.download='records.csv';a.click();URL.revokeObjectURL(a.href);});
    await until(()=>exported.length===2,'native export adapter');
    assert.equal(Buffer.from(exported[1].base64,'base64').toString(),'Name\nExported');
    assert.equal(calls.filter(c=>c.method!=='GET').length,0);
    await workbench.screenshot({path:path.join(output,'09-desktop-import-script.png')});
    fs.writeFileSync(path.join(output,'desktop-services-report.json'),JSON.stringify({passed:['Native picker bridge to real CSV mapping and canvas import','Isolated script preview and apply','Connected draft survives webview recreation','JSON canvas export/reimport round trip through native bridge','CSV Blob export through native save bridge'],writes:0},null,2));
  } finally { api.dispose();panel.dispose(); }
};
