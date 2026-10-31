const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DesktopFiles, MAX } = require('../src/files.cjs');
// VS Code's fsPath uses the host OS's separators, including on Linux CI.
const uri = name => ({ scheme:'file',fsPath:path.resolve('chosen', name) });
function fixture() {
  const f={selected:[uri('test.csv')],bytes:Buffer.from('Name\nExample'),written:[],opened:0};
  f.files=new DesktopFiles({open:async()=>{f.opened++;return f.selected;},save:async()=>f.selected[0]}, {stat:async()=>({size:f.bytes.length,type:1}),readFile:async()=>f.bytes,writeFile:async(...v)=>f.written.push(v)});return f;
}
test('Native file selection grants only bounded CSV/JSON reads and returns no paths',async()=>{
  const f=fixture(),r=await f.files.run('open',{kind:'csv'});
  assert.equal(r.files[0].name,'test.csv');assert.equal(Buffer.from(r.files[0].base64,'base64').toString(),'Name\nExample');assert.doesNotMatch(JSON.stringify(r),/chosen/);
  f.selected=[];assert.equal((await f.files.run('open',{kind:'csv'})).cancelled,true);
  f.selected=[uri('secret.env')];await assert.rejects(f.files.run('open',{kind:'csv'}));
  f.selected=[uri('a.csv')];f.bytes=Buffer.alloc(MAX+1);await assert.rejects(f.files.run('open',{kind:'csv'}));
});
test('Exports require native destination selection; path injection and oversized payloads cannot write',async()=>{
  const f=fixture();await f.files.run('save',{name:'records.csv',base64:Buffer.from('Name\nExample').toString('base64')});assert.equal(f.written.length,1);
  for(const name of ['../x.csv','C:\\x.json','CON.csv','x.exe','a\n.csv'])await assert.rejects(f.files.run('save',{name,base64:'WA=='}));
  await assert.rejects(f.files.run('save',{name:'x.csv',base64:'bad'}));
  assert.equal(f.written.length,1);f.selected=[];assert.equal((await f.files.run('save',{name:'x.csv',base64:''})).cancelled,true);
});
