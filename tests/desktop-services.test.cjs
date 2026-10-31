const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {RecoveryStore}=require('../src/recovery.cjs');
const {DesktopScripts}=require('../src/scripts.cjs');
const {externalLink}=require('../src/external-links.cjs');
test('External links are restricted to exact connected-org records, homepage and documentation',()=>{
 const identity={instanceUrl:'https://sample.my.salesforce.com'};
 assert.equal(externalLink('https://orgloom.com/',identity),'https://orgloom.com/');
 assert.equal(externalLink(identity.instanceUrl+'/001000000000001AAA',identity),identity.instanceUrl+'/001000000000001AAA');
 assert.equal(externalLink('https://orgloom.com/docs/security-and-data#storage',identity),'https://orgloom.com/docs/security-and-data#storage');
 for(const url of ['command:workbench.action.closeWindow','file:///tmp/data','https://sample.my.salesforce.com.evil.com/001000000000001AAA',identity.instanceUrl+'/secur/frontdoor.jsp?sid=secret','https://orgloom.com/?next=evil','https://orgloom.com.evil.com/','https://orgloom.com/admin','https://orgloom.com/#unexpected','https://other.my.salesforce.com/001000000000001AAA']) assert.throws(()=>externalLink(url,identity));
});
test('Recovery is encrypted, authenticated, identity-scoped, serialized and removable',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orgloom-recovery-'));
 const values=new Map(),secrets={get:async k=>values.get(k),store:async(k,v)=>values.set(k,v),delete:async k=>values.delete(k)};
 const identity={orgId:'00D000000000001AAA',userId:'005000000000001AAA'};
 const store=new RecoveryStore(root,secrets,identity),state={version:1,local:{},session:{'orgloom:canvas-draft:v1|scope':'sensitive example'}};
 try{
   await store.save(state,new Map([['Account:001000000000001AAA',{Name:'Secret account',LastModifiedDate:'today'}]]));
   const bytes=await fs.readFile(store.file);assert.ok(!bytes.includes(Buffer.from('Secret account')));assert.ok(!bytes.includes(Buffer.from('sensitive example')));
   assert.deepEqual((await store.load()).state,state);
   assert.equal(await new RecoveryStore(root,secrets,{...identity,userId:'005000000000002AAA'}).load(),null);
   bytes[bytes.length-1]^=1;await fs.writeFile(store.file,bytes);await assert.rejects(store.load());
   await store.clear();assert.equal(await store.load(),null);assert.equal(values.size,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('Script workers return local changes while blocking host access and identity mutation',async()=>{
 const scripts=new DesktopScripts(),records=[{id:1,objectName:'Account',loadedFromId:'001000000000001AAA',values:{Name:'Before'}}];
 const r=await scripts.run({id:'good',source:'for (const r of records) { r.values.Name = "After"; }',records});
 assert.equal(r.records[0].values.Name,'After');assert.equal(records[0].values.Name,'Before');
 for(const source of ['records[0].id = 3;','records[0].values.Name = process.env;','records[0].values.Name = records.constructor;','fetch("https://example.com");'])await assert.rejects(scripts.run({id:'bad',source,records}));
 const pending=scripts.run({id:'cancel',source:'for (const r of records) { r.values.Name = "After"; }',records});scripts.cancel('cancel');await assert.rejects(pending,/cancelled/);scripts.dispose();
});
