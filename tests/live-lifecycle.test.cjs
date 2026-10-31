'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {fixture}=require('./upload-fixture.cjs');
const {RecoveryStore}=require('../src/recovery.cjs');
for (const choice of ['Not now', 'Enable recovery']) {
  test(`First connected canvas works with recovery choice: ${choice}`, async () => {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ol-consent-')),root=path.resolve(__dirname,'..'),f=fixture();
    const commands=new Map(),state=new Map(),errors=[],prompts=[];
    let setting,onConfiguration,onMessage,onDispose;
    const sent=[],disposable=()=>({dispose(){}});
    const target={webview:{cspSource:'local:',asWebviewUri:uri=>uri.fsPath,postMessage:async message=>{sent.push(message);},onDidReceiveMessage:fn=>{onMessage=fn;return disposable();}},reveal(){},onDidDispose:fn=>{onDispose=fn;},dispose(){onDispose?.();}};
    const vscode={
      ViewColumn:{One:1},ConfigurationTarget:{Global:1},
      Uri:{joinPath:(uri,...parts)=>({fsPath:path.join(uri.fsPath,...parts)})},
      workspace:{getConfiguration:()=>({inspect:()=>({globalValue:setting}),update:async(_key,value)=>{setting=value;onConfiguration({affectsConfiguration:()=>true});}}),onDidChangeConfiguration:fn=>{onConfiguration=fn;return disposable();}},
      window:{createWebviewPanel:()=>target,registerWebviewPanelSerializer:disposable,showInformationMessage:async text=>{prompts.push(text);return choice;},showWarningMessage:async text=>errors.push(text),showErrorMessage:async text=>errors.push(text)},
      commands:{registerCommand:(key,fn)=>{commands.set(key,fn);return disposable();}},
    };
    const context={extensionPath:root,extensionUri:{fsPath:root},globalStorageUri:{fsPath:directory},secrets:f.secrets,subscriptions:[],globalState:{get:(key,fallback)=>state.get(key)??fallback,update:async(key,value)=>state.set(key,value)}};
    const file=path.join(root,'src/live-extension.cjs'),requireFrom=createRequire(file),module={exports:{}};
    const fakeRequire=name=>name==='vscode'?vscode:name==='./salesforce.cjs'?{...requireFrom(name),SalesforceClient:class{constructor(){return f.client;}}}:requireFrom(name);
    const store=new RecoveryStore(directory,f.secrets,f.client.publicIdentity());
    try {
      // Existing automatic recovery from an older build must not restore without consent.
      await store.save({version:1,local:{},session:{}},new Map());
      vm.runInNewContext(await fs.readFile(file,'utf8'),{require:fakeRequire,module,exports:module.exports,setInterval,clearInterval,console});
      module.exports.activateLive(context);
      await commands.get('orgloom.openTestCanvas')();
      assert.deepEqual(errors,[]);
      assert.deepEqual(prompts,['Enable local canvas recovery?']);
      await onMessage({type:'recovery-ready',documentId:'c'.repeat(32)});
      const reply=sent.find(r=>r.type==='recovery-ready-result');
      assert.ok(reply.sessionToken,'Canvas handshake still succeeds with recovery off');
      assert.equal(reply.state,null,'Old automatic recovery is removed');
      await onMessage({type:'save-recovery',sessionToken:reply.sessionToken,sequence:1,state:{version:1,local:{},session:{}}});
      assert.equal(!!await store.load(),choice==='Enable recovery');
      await onMessage({type:'live-api',sessionToken:reply.sessionToken,id:1,path:'/api/upload/graph',method:'POST',body:f.body([f.draft(1,'Account',{Name:'Allowed without recovery'})])});
      assert.equal(sent.find(r=>r.id===1)?.status,200,'Recovery preference does not block authorized uploads');
      target.dispose();
      await commands.get('orgloom.openTestCanvas')();
      assert.equal(prompts.length,1,'Reopening does not repeat the choice');
    } finally {
      for(const sub of context.subscriptions)sub.dispose();
      await fs.rm(directory,{recursive:true,force:true});
    }
  });
}
test('Connected panel serializer uses latest encrypted recovery and rejects a different user before rendering',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ol-lifecycle-')),root=path.resolve(__dirname,'..'),f=fixture();
  const commands=new Map(),serializers=new Map(),errors=[],panels=[],warnings=[];
  const disposable=()=>({dispose(){}});
  function panel(){
    let onMessage,onDispose;const sent=[];
    const p={webview:{cspSource:'local:',options:{},html:'',asWebviewUri:uri=>String(uri.fsPath),postMessage:async message=>{sent.push(message);return true;},onDidReceiveMessage:fn=>{onMessage=fn;return disposable();}},reveal(){},onDidDispose:fn=>{onDispose=fn;return disposable();},dispose(){onDispose?.();},send:message=>onMessage(message),sent};
    panels.push(p);return p;
  }
  let recoveryEnabled=true,onConfiguration;
  const vscode={
    ViewColumn:{One:1},ProgressLocation:{Notification:1},
    workspace:{fs:{},getConfiguration:()=>({inspect:()=>({globalValue:recoveryEnabled})}),onDidChangeConfiguration:fn=>{onConfiguration=fn;return disposable();}},
    Uri:{joinPath:(uri,...parts)=>({fsPath:path.join(uri.fsPath,...parts)}),parse:value=>value},
    window:{createWebviewPanel:panel,registerWebviewPanelSerializer:(key,value)=>{serializers.set(key,value);return disposable();},showInformationMessage:async()=> 'Restore',showWarningMessage:async text=>{warnings.push(text);return undefined;},showErrorMessage:async text=>errors.push(text)},
    commands:{registerCommand:(key,fn)=>{commands.set(key,fn);return disposable();}},
  };
  const context={extensionPath:root,extensionUri:{fsPath:root},globalStorageUri:{fsPath:directory},secrets:f.secrets,subscriptions:[],globalState:{get:()=>({}),update:async()=>{}}};
  const file=path.join(root,'src/live-extension.cjs'),requireFrom=createRequire(file),module={exports:{}};
  const source=await fs.readFile(file,'utf8');
  const fakeRequire=name=>name==='vscode'?vscode:name==='./salesforce.cjs'?{...requireFrom(name),SalesforceClient:class{constructor(){return f.client;}}}:requireFrom(name);
  const identity=f.client.publicIdentity(),identityKey=`desktop:${identity.orgId}:${identity.userId}`,key='orgloom:canvas-draft:v1|'+identityKey+':new',pointer='orgloom:canvas-draft-active:v1|'+identityKey;
  const state=name=>({version:1,local:{},session:{[pointer]:key,[key]:JSON.stringify({v:1,ts:Date.now(),identity:identityKey,scope:identityKey+':new',state:{bulkRecords:[{id:1,objectName:'Account',values:{Name:name}}],bulkAssociations:[],selectedObjects:[]}})}});
  const store=new RecoveryStore(directory,f.secrets,identity);
  try{
    await store.save(state('First draft'),new Map());
    vm.runInNewContext(source,{require:fakeRequire,module,exports:module.exports,setInterval,clearInterval,console});module.exports.activateLive(context);
    const expectedCommands=['orgloom.connectCliOrg','orgloom.disconnectTestOrg','orgloom.openTestCanvas'];
    assert.deepEqual([...commands.keys()].sort(),expectedCommands,'Only CLI connect, reopen and disconnect are registered');
    const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
    assert.deepEqual(manifest.contributes.commands.map(command=>command.command).sort(),expectedCommands);
    assert.deepEqual(Object.keys(manifest.contributes.configuration.properties),['orgloom.localRecovery.enabled'],'Only local recovery is configurable; no direct OAuth settings');
    assert.equal(manifest.contributes.configuration.properties['orgloom.localRecovery.enabled'].default,false);
    assert.equal(manifest.contributes.configuration.properties['orgloom.localRecovery.enabled'].scope,'application');
    await commands.get('orgloom.openTestCanvas')();assert.deepEqual(errors,[]);const first=panels[0];
    assert.ok(first.webview.html.includes('recovery-bootstrap'));assert.ok(!first.webview.html.includes('First draft'));
    await first.send({type:'recovery-ready',documentId:'a'.repeat(32)});
    const reply=first.sent.find(r=>r.type==='recovery-ready-result');assert.ok(JSON.stringify(reply.state).includes('First draft'));
    const upload={type:'live-api',id:10,path:'/api/upload/graph',method:'POST',body:f.body([f.draft(1,'Account',{Name:'Canvas-approved upload'})])};
    await first.send(upload);
    assert.equal(f.calls.filter(c=>c.method).length,0,'A request without the current panel session must not upload');
    await first.send({...upload,sessionToken:reply.sessionToken});
    assert.equal(first.sent.find(r=>r.id===10)?.status,200,'Canvas-approved upload proceeds without a second dialog');
    assert.deepEqual(warnings,[]);
    const writes=f.calls.filter(c=>c.method).length;
    f.fields.find(field=>field.name==='Name').createable=false;
    await first.send({...upload,id:11,sessionToken:reply.sessionToken,body:f.body([f.draft(2,'Account',{Name:'Permission denied'})])});
    assert.equal(first.sent.find(r=>r.id===11)?.data.error,'unsupported-field');
    assert.equal(f.calls.filter(c=>c.method).length,writes,'Host permissions remain enforced');
    await first.send({type:'save-recovery',sessionToken:reply.sessionToken,sequence:1,state:state('Latest draft')});first.dispose();
    const next=panel();await serializers.get('orgloom.testCanvas').deserializeWebviewPanel(next,{orgId:identity.orgId,userId:identity.userId});
    await next.send({type:'recovery-ready',documentId:'b'.repeat(32)});
    assert.ok(JSON.stringify(next.sent).includes('Latest draft'));assert.ok(!next.webview.html.includes('Latest draft'));
    recoveryEnabled=false;onConfiguration({affectsConfiguration:()=>true});
    const nextReply=next.sent.find(r=>r.type==='recovery-ready-result');
    await next.send({type:'save-recovery',sessionToken:nextReply.sessionToken,sequence:1,state:state('Must not persist')});
    assert.equal(await store.load(),null,'Disabling clears the checkpoint and blocks subsequent saves');
    assert.equal(await f.secrets.get(store.secret),undefined,'Disabling deletes the encryption key');
    next.dispose();
    const wrong=panel();await serializers.get('orgloom.testCanvas').deserializeWebviewPanel(wrong,{orgId:identity.orgId,userId:'005000000000999AAA'});
    assert.equal(wrong.webview.html,'');assert.match(errors.at(-1),/different Salesforce connection/);
  }finally{
    for(const sub of context.subscriptions)sub.dispose();
    await fs.rm(directory,{recursive:true,force:true});
  }
});
