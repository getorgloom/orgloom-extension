'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./upload-fixture.cjs');
const {DesktopScripts}=require('../src/scripts.cjs');
const {DesktopFiles}=require('../src/files.cjs');
const {SalesforceClient,API,salesforceOrigin}=require('../src/salesforce.cjs');
const {externalLink}=require('../src/external-links.cjs');
const {createCliRunner}=require('../src/salesforce-cli.cjs');
const msg=(path,body={},method='POST')=>({type:'live-api',id:1,path,body,method});

test('forged routes, query injection, record identities and changed connections cannot make unauthorized writes',async()=>{
  const f=fixture(),record=f.seed('Account',{Name:'Original'});
  const loaded=await f.loaded(1,'Account',record,{Name:'Changed'});
  const attacks=[
    msg('https://attacker.invalid/api/upload'),msg('//attacker.invalid/api/upload'),
    msg('/api/%2e%2e/services/data/v65.0/sobjects/Account'),msg('/api/desktop/../../secret'),
    msg('/api/desktop/files/open',{path:'C:/credentials.json',kind:'json'}),
    msg('/api/query',{soql:'SELECT Id FROM Account; DELETE FROM Account'}),
    msg('/api/query',{soql:'SELECT Id FROM User'}),
    msg('/api/query',{soql:'SELECT Id FROM Account FOR UPDATE'}),
    msg('/api/objects/Account/search?q='+encodeURIComponent("x' OR Name != null OR Name='"),{},'DELETE'),
    msg('/api/upload/graph',{...f.body([loaded]),expectedSfOrgId:'00D000000000999AAA'}),
    msg('/api/upload/graph',f.body([{...loaded,loadedFromId:"001000000000001AAA' OR Name != null"}])),
    msg('/api/upload/graph',f.body([{...loaded,values:{...loaded.values,OwnerId:'005000000000999AAA'}}])),
  ];
  for(const attack of attacks){const result=await f.api.handle(attack);assert.ok(result.status>=400,JSON.stringify(attack));}
  f.fields.find(x=>x.name==='Name').updateable=false;
  assert.ok((await f.api.handle(msg('/api/upload/graph',f.body([loaded])))).status>=400);
  const who=f.client.publicIdentity();f.client.publicIdentity=()=>({...who,userId:'005000000000999AAA'});
  assert.equal((await f.api.handle(msg('/api/upload/graph',f.body([loaded])))).status,403);
  assert.equal(f.calls.filter(c=>c.method).length,0);
  assert.equal(f.db.get(record.Id).record.Name,'Original');f.api.dispose();
});

test('script interpreter rejects execution escapes and treats code-looking record values as strings',async()=>{
  const scripts=new DesktopScripts(),records=[{id:1,objectName:'Account',values:{Name:'console.log("OL_SECURITY_EXECUTED")'}}];
  const attacks=[
    'console.log("OL_SECURITY_EXECUTED");','eval(records[0].values.Name);',
    'Function("return process")();','require("node:fs").readFileSync(".env");',
    'process.env;','globalThis.process;','fetch("https://attacker.invalid");',
    'records.constructor.constructor("return process")();',
    'records["con" + "structor"]["constructor"]("return process")();',
    'toStr.bind(null).constructor("return process")();',
    'records[0].values.__proto__.polluted = true;',
    'records[0].values["__pro" + "to__"].polluted = true;',
    'records[0].values.__lookupGetter__("constructor");',
    'records[0].loadedFromId = "001000000000999AAA";',
    'for (let i = 0; i < 1000000000; i += 1) { records[0].values.Name = "x"; }',
  ];
  try {
    for(let i=0;i<attacks.length;i++)await assert.rejects(scripts.run({id:'attack'+i,source:attacks[i],records}),undefined,attacks[i]);
    const result=await scripts.run({id:'safe',source:'records[0].values.Description = records[0].values.Name;',records});
    assert.equal(result.records[0].values.Description,records[0].values.Name);
    assert.equal({}.polluted,undefined);
  }finally{scripts.dispose();}
});

test('webview paths cannot override native file selection or write without a selected destination',async()=>{
  const reads=[],writes=[],selected={scheme:'file',fsPath:'C:/security-fixture/selected.json'};
  const bytes=Buffer.from('{"Name":"console.log(1)"}');
  const files=new DesktopFiles({open:async()=>[selected],save:async()=>undefined},{stat:async uri=>{assert.equal(uri,selected);return {size:bytes.length,type:1};},readFile:async uri=>{reads.push(uri);return bytes;},writeFile:async(...args)=>writes.push(args)});
  const result=await files.run('open',{kind:'json',path:'C:/credentials.json',fsPath:'C:/secrets.json',uri:'file:///etc/passwd'});
  assert.deepEqual(reads,[selected]);assert.equal(result.files[0].name,'selected.json');assert.doesNotMatch(JSON.stringify(result),/credentials|secrets|security-fixture/);
  for(const name of ['../secret.json','..\\secret.csv','C:\\secret.json','\\\\server\\share\\secret.csv','x.json:secret','NUL.json','x\u0000.csv'])await assert.rejects(files.run('save',{name,base64:'e30='}));
  assert.equal((await files.run('save',{name:'records.json',base64:'e30=',path:'C:/secret.json'})).cancelled,true);
  assert.deepEqual(writes,[]);
});

test('credential transport is pinned to Salesforce and sanitized error responses do not expose canary secrets',async()=>{
  const canary='OL_SECRET_CANARY_NEVER_DISPLAY',calls=[];
  const client=new SalesforceClient({},{fetchFn:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify([{errorCode:'INVALID_SESSION_ID',message:canary}]),{status:401});}});
  client.session={authMode:'cli',instanceUrl:'https://fixture.my.salesforce.com',accessToken:canary,identity:{orgId:'00D000000000001AAA',userId:'005000000000001AAA'}};
  for(const route of ['https://attacker.invalid/','//attacker.invalid/',API+'/../oauth/token',API+'/sobjects/Account#secret'])await assert.rejects(client.request(route));
  assert.equal(calls.length,0);
  await assert.rejects(client.request(API+'/sobjects/Account',{retry:false}),e=>!e.message.includes(canary)&&e.code==='INVALID_SESSION_ID');
  assert.equal(calls[0].url,'https://fixture.my.salesforce.com'+API+'/sobjects/Account');
  assert.equal(calls[0].options.redirect,'error');
  for(const value of ['http://fixture.my.salesforce.com','https://fixture.my.salesforce.com.attacker.invalid','https://fixture.my.salesforce.com@attacker.invalid','https://attacker.invalid','https://fixture.my.salesforce.com/path'])assert.throws(()=>salesforceOrigin(value));
  const run=createCliRunner({resolve:()=>({file:'fixture-cli',prefix:[],cwd:'C:/security-fixture'}),execute:(_f,_a,_o,callback)=>callback(Error(canary),'not-json '+canary,canary)});
  await assert.rejects(run(['org','list']),e=>!e.message.includes(canary));
});

test('external navigation cannot turn field URLs into commands, arbitrary files or credential-bearing requests',()=>{
  const identity={instanceUrl:'https://fixture.my.salesforce.com'};
  for(const url of ['javascript:console.log(1)','command:workbench.action.terminal.new','file:///C:/secret.json','data:text/html,<script>console.log(1)</script>','https://attacker.invalid/?data=secret','https://fixture.my.salesforce.com/secur/frontdoor.jsp?sid=secret','https://fixture.my.salesforce.com/001000000000001AAA?data=secret','https://orgloom.com/docs?data=secret'])assert.throws(()=>externalLink(url,identity));
});
