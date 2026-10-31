'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const {renderHtml}=require('../src/html.cjs');
const {fixture}=require('./upload-fixture.cjs');
const {SalesforceError}=require('../src/salesforce.cjs');
const root=path.resolve(__dirname,'..');
const marker='OL_SECURITY_EXECUTED';
const payloads=[
  `console.log('${marker}')`,
  `<img src=x onerror="console.log('${marker}');window.__dataExecuted=true">`,
  `<svg onload="console.log('${marker}');window.__dataExecuted=true"></svg>`,
  `</textarea><img src=x onerror="console.log('${marker}')">`,
  `</script><script>console.log('${marker}');window.__dataExecuted=true</script>`,
  `" autofocus onfocus="console.log('${marker}')" data-attack="`,
  `javascript:console.log('${marker}')`,
  `&#60;img src=x onerror=console.log('${marker}')&#62;`,
  `${'${'}console.log('${marker}')}`,
];

test('hostile record values stay data in the actual connected canvas and record editor',async()=>{
  const f=fixture(),messages=[],logs=[],errors=[],network=[];
  let selectedFile;
  f.api.files={run:async(action)=>{assert.equal(action,'open');return {files:[selectedFile]};}};
  f.fields.push({name:'Description',type:'textarea',createable:true,updateable:true},{name:'Website',type:'url',createable:true,updateable:true});
  const identity={...f.client.publicIdentity(),username:'security@example.invalid',displayName:payloads[4],timeZone:'UTC',orgType:'sandbox',accessToken:'OL_SECRET_CANARY',refreshToken:'OL_SECRET_CANARY'};
  const request=f.client.request;
  f.client.request=async(url,options)=>{
    if(options?.method)throw Error('Unexpected Salesforce write during rendering');
    if(url.includes('/ui-api/'))throw new SalesforceError('Unsupported','NOT_FOUND',404);
    return request(url,options);
  };
  const rows=payloads.map((value,i)=>{
    const record=f.seed('Account',{Name:value,Description:value,Website:value});
    return {id:i+1,objectName:'Account',label:'Account',fromSelectionId:1,loadedFromId:record.Id,values:record,loadedValues:{...record},x:(i%3)*350,y:Math.floor(i/3)*240};
  });
  const keyIdentity=`desktop:${identity.orgId}:${identity.userId}`,key=`orgloom:canvas-draft:v1|${keyIdentity}:new`;
  const recovery={version:1,local:{},session:{[key]:JSON.stringify({v:1,identity:keyIdentity,scope:keyIdentity+':new',ts:Date.now(),state:{selectedObjects:[{id:1,name:'Account',label:'Account'}],selectedIdSeq:2,activeIndex:0,bulkRecords:rows,bulkIdSeq:rows.length+1,bulkAssociations:[],hiddenObjects:[],graphView:'bulk',currentCanvas:null,bulkZoom:1}}),['orgloom:canvas-draft-active:v1|'+keyIdentity]:key}};
  let origin;
  const server=http.createServer((req,res)=>{
    if(req.url==='/') {res.setHeader('Content-Type','text/html');res.end(renderHtml({root,cspSource:origin,resource:p=>origin+p,identity,recovery,preferences:{dismissed:true,completed:true}}));return;}
    const file=path.resolve(root,'media','.'+new URL(req.url,origin).pathname);
    if(!file.startsWith(path.join(root,'media')+path.sep)||!fs.existsSync(file)){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  let browser;
  try {
    browser=await chromium.launch({headless:true,...(process.env.SECURITY_BROWSER_EXECUTABLE?{executablePath:process.env.SECURITY_BROWSER_EXECUTABLE}:{})});
    const page=await browser.newPage({viewport:{width:1500,height:1000}});
    await page.route('**/*',route=>{if(!route.request().url().startsWith(origin+'/')){network.push(route.request().url());return route.abort();}return route.continue();});
    page.on('console',m=>logs.push(m.text()));page.on('pageerror',e=>errors.push(e.message));
    await page.exposeFunction('securityBridge',async message=>{
      messages.push(message);
      if(message.type==='live-api') {const reply=await f.api.handle(message);await page.evaluate(reply=>window.dispatchEvent(new MessageEvent('message',{data:reply})),{type:'live-api-result',id:message.id,...reply});}
    });
    await page.addInitScript(()=>{window.acquireVsCodeApi=()=>({postMessage:m=>window.securityBridge(m),setState(){}});});
    await page.goto(origin);
    await page.waitForSelector('.record-card[data-rec-id="1"]',{timeout:15000});
    for (let i=0;i<payloads.length;i++) {
      await page.locator(`.record-card[data-rec-id="${i+1}"] .record-title`).dblclick();
      const editor=page.locator('.modal.is-inline').last();
      await editor.locator('.field[data-field="Name"] input').waitFor({timeout:7000});
      assert.equal(await editor.locator('.field[data-field="Name"] input').inputValue(),payloads[i]);
      assert.equal(await editor.locator('.field[data-field="Description"] textarea').inputValue(),payloads[i]);
      assert.equal(await page.locator('img[onerror],svg[onload],[data-attack]').count(),0,'Editor must escape values as well as cards');
      await editor.locator('.modal-close[data-close]').click();
    }
    fs.mkdirSync(path.join(root,'test-results/security'),{recursive:true});
    fs.writeFileSync(path.join(root,'test-results/security/browser-initial.json'),JSON.stringify({text:await page.locator('body').innerText(),errors,requests:messages.filter(m=>m.type==='live-api').map(m=>m.path)},null,2));
    await page.screenshot({path:path.join(root,'test-results/security/hostile-records.png')});
    const text=await page.locator('body').innerText();
    assert.ok(text.includes(marker),'Hostile values must actually render for the test to exercise the canvas');
    const filePayload={_meta:{app:'Org Loom',version:1,exportedFrom:identity.orgId},schema:{objects:[]},records:payloads.map((value,i)=>({id:i+1,objectName:'Account',label:payloads[1],values:{Name:value,Description:value},x:(i%3)*350,y:Math.floor(i/3)*240})),associations:[]};
    selectedFile={name:'hostile.json',type:'application/json',base64:Buffer.from(JSON.stringify(filePayload)).toString('base64')};
    await page.getByRole('button',{name:'+ Add records',exact:true}).click();
    await page.locator('[data-add-menu="fixture"]').click();
    await page.locator('#ici-dropzone').click();
    await page.locator('[data-rom="replace"]').click();
    await page.waitForFunction(()=>document.body.innerText.includes('9 draft'));
    assert.equal(await page.locator('.record-card').count(),9);
    assert.equal(await page.locator('img[onerror],svg[onload],[data-attack]').count(),0,'JSON record labels and values must not create HTML');
    // Render migration decisions and missing-field values using the same imported data.
    await page.evaluate(payload=>{
      for (const record of payload.records) record.values.Missing__c=record.values.Description;
      window.__migrationReview=window.OrgLoomDesktopMigration.start(payload,{},async()=>{});
    },filePayload);
    await page.waitForSelector('.mm-decision-card');
    await page.locator('[data-mm-primary]').click();
    assert.ok((await page.locator('.mm-differences').innerText()).includes(marker));
    assert.equal(await page.locator('img[onerror],svg[onload],[data-attack]').count(),0,'Migration differences must escape hostile values');
    await page.locator('[data-mm-close]').click();
    // Deliberately malformed JSON exercises the error-display path.
    selectedFile={name:'malformed.json',type:'application/json',base64:Buffer.from('{"Name":'+payloads[1]).toString('base64')};
    await page.getByRole('button',{name:'+ Add records',exact:true}).click();
    await page.locator('[data-add-menu="fixture"]').click();await page.locator('#ici-dropzone').click();
    await page.getByText(/Could not load file:/).waitFor();
    await page.locator('.import-canvas-modal .modal-close').click();
    const cell=value=>'"'+value.replaceAll('"','""')+'"';
    selectedFile={name:'Account.csv',type:'text/csv',base64:Buffer.from('Name,Description\r\n'+payloads.map(value=>cell(value)+','+cell(value)).join('\r\n')).toString('base64')};
    await page.getByRole('button',{name:'+ Add records',exact:true}).click();await page.locator('[data-add-menu="csv"]').click();
    await page.locator('#lcsv-dropzone').click();
    await page.locator('#linked-csv-confirm').click();
    await page.waitForFunction(()=>document.querySelectorAll('.record-card').length===18);
    assert.equal(await page.locator('img[onerror],svg[onload],[data-attack]').count(),0,'Values must not create HTML elements or event handlers');
    assert.equal(await page.evaluate(()=>window.__dataExecuted),undefined);
    assert.ok(!logs.some(log=>log===marker),'No payload ran console.log');
    assert.deepEqual(network,[],'No data-triggered external request');
    assert.ok(messages.filter(m=>m.type==='live-api').every(m=>!/^\/api\/upload/.test(m.path)),'Rendering must not submit an upload');
    assert.deepEqual(errors,[],'No unhandled rendering exceptions');
    assert.ok(!(await page.content()).includes('OL_SECRET_CANARY'));
    // Positive controls: prove console monitoring works and browser CSP blocks
    // an executable element even if a future rendering bug inserts one.
    await page.evaluate(()=>{
      console.log('OL_SECURITY_MONITOR_CONTROL');
      const script=document.createElement('script');script.textContent='window.__cspExecuted=true';document.body.appendChild(script);
      const img=document.createElement('img');img.setAttribute('onerror','window.__cspExecuted=true');document.body.appendChild(img);img.dispatchEvent(new Event('error'));
    });
    assert.ok(logs.includes('OL_SECURITY_MONITOR_CONTROL'));
    assert.equal(await page.evaluate(()=>window.__cspExecuted),undefined);
    fs.writeFileSync(path.join(root,'test-results/security/browser-final.json'),JSON.stringify({payloads:payloads.length,surfaces:['record cards','record editors','JSON imports','CSV imports','migration decisions','migration field differences','malformed JSON errors','identity bootstrap'],executedPayloads:0,unexpectedNetwork:network,unhandledErrors:errors},null,2));
  } finally {await browser?.close();await new Promise(r=>server.close(r));f.api.dispose();}
});

module.exports={payloads,marker};
