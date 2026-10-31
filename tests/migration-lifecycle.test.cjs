const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function migrationHarness(commit){
  const applied=[],requests=[];
  const window={SF_ORG_ID:'destination',__ORGLOOM_NATIVE_IDENTITY__:{orgName:'Destination test org'},OrgLoom:{templates:{mount:()=>({})}},Orgloom:{}};
  const context={window,Response,URL,Blob,document:{querySelector:()=>null},setTimeout};
  vm.runInNewContext(fs.readFileSync('vendor/upstream/packages/canvas/src/public/js/migrate-annotate.js','utf8'),context);
  window.fetch=async(url)=>{
    requests.push(url);
    return new Response(JSON.stringify(url.includes('/describe')?{name:'Account',fields:[{name:'Name',type:'string',createable:true,updateable:true}],recordTypes:[]}:{}));
  };
  window.OrgLoom.migrateMatch={mount:deps=>({open:({onClose})=>{
    Promise.resolve().then(async()=>{if(commit)await deps.onCommitPlan();onClose();}).catch(error=>{throw error;});
  }})};
  vm.runInNewContext(fs.readFileSync('webview/migration.js','utf8'),context);
  return {window,applied,requests,apply:async p=>applied.push(p)};
}
test('cancelled migration never invokes the canvas replacement seam',async()=>{
  const h=migrationHarness(false),file={_meta:{forMigration:true,exportedFrom:'source'},records:[{id:1,objectName:'Account',values:{Name:'Migrating',Id:'source-id'}}],associations:[]};
  const original=JSON.stringify(file);
  assert.equal(await h.window.OrgLoomDesktopMigration.start(file,{},h.apply),false);
  assert.equal(h.applied.length,0);assert.equal(JSON.stringify(file),original);
});
test('migration applies destination data only after explicit commit and fresh capability check',async()=>{
  const h=migrationHarness(true),file={_meta:{forMigration:true,exportedFrom:'source'},records:[{id:1,objectName:'Account',values:{Name:'Migrating',Id:'source-id'}}],associations:[]};
  assert.equal(await h.window.OrgLoomDesktopMigration.start(file,{},h.apply),true);
  assert.equal(h.applied.length,1);assert.equal(h.applied[0]._meta.exportedFrom,'destination');assert.equal(h.applied[0].records[0].values.Id,undefined);
  assert.equal(h.requests.filter(url=>url==='/api/capabilities/bulk-edit-records/check').length,2);
});

test('migration shows loading throughout metadata requests, then removes it before review',async()=>{
  const h=migrationHarness(false);
  let release,busy=false,opened=false;
  const describe=new Promise(resolve=>{release=resolve;});
  const fetch=h.window.fetch;
  h.window.fetch=async url=>{if(url.includes('/describe'))await describe;return fetch(url);};
  h.window.OrgLoom.migrateMatch.mount=()=>({open:({onClose})=>{
    assert.equal(busy,false,'loading mask must not block the review');opened=true;onClose();
  }});
  const importing=h.window.OrgLoomDesktopMigration.start({records:[{id:1,objectName:'Account',values:{Name:'Test'}}],associations:[]},{},h.apply,message=>{
    assert.equal(message,'Preparing migration review…');busy=true;return()=>{busy=false;};
  });
  assert.equal(busy,true);assert.equal(opened,false);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(busy,true);release();await importing;
  assert.equal(opened,true);assert.equal(busy,false);assert.equal(h.applied.length,0);
});

test('failed migration preparation clears loading without replacing the canvas',async()=>{
  const h=migrationHarness(false);let busy=false;
  h.window.fetch=async()=>{throw Error('Access unavailable');};
  await assert.rejects(h.window.OrgLoomDesktopMigration.start({records:[],associations:[]},{},h.apply,()=>{
    busy=true;return()=>{busy=false;};
  }),/Access unavailable/);
  assert.equal(busy,false);assert.equal(h.applied.length,0);
});
