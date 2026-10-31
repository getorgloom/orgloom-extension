const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');

test('migration requires an explicit checkbox choice for a source picklist value and retains the choice',async()=>{
  const dom=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only',url:'https://native.example/'});
  const w=dom.window,applied=[];
  try{
    w.SF_ORG_ID='destination';w.OrgLoom={templates:{mount:()=>({})}};
    w.fetch=async()=>new Response(JSON.stringify({name:'Account',recordTypes:[],fields:[
      {name:'Name',type:'string',createable:true,updateable:true},
      {name:'Active__c',label:'Active',type:'boolean',createable:true,updateable:true}
    ]}));
    for(const file of ['vendor/upstream/packages/canvas/src/public/js/migrate-annotate.js','vendor/upstream/packages/canvas/src/public/js/migrate-match.js','webview/migration.js'])w.eval(fs.readFileSync(file,'utf8'));
    const original={records:[{id:1,objectName:'Account',values:{Name:'Checkbox migration',Active__c:'Yes'}}],associations:[]};
    const finished=w.OrgLoomDesktopMigration.start(original,{},async p=>applied.push(p));
    for(let i=0;i<50&&!w.document.querySelector('.mm-decision-card');i++)await new Promise(r=>setImmediate(r));
    const primary=w.document.querySelector('[data-mm-primary]');primary.click();
    assert.equal(primary.disabled,true);
    assert.match(w.document.querySelector('.mm-differences').textContent,/checkbox in the destination/);
    const choice=()=>w.document.querySelector('[data-mm-boolean-field="Active__c"]');
    const select=value=>{choice().value=value;choice().dispatchEvent(new w.Event('change',{bubbles:true}));};
    select('true');assert.equal(primary.disabled,false);assert.equal(choice().value,'true');
    select('');assert.equal(primary.disabled,true);
    select('false');assert.equal(primary.disabled,false);assert.equal(choice().value,'false');
    assert.equal(w.document.querySelectorAll('[data-mm-boolean-field]').length,1);
    primary.click();primary.click();assert.equal(await finished,true);
    assert.equal(applied[0].records[0].values.Active__c,false);
    assert.equal(original.records[0].values.Active__c,'Yes');
  }finally{dom.window.close();}
});

test('migration blocks a changed lookup target and supports reversible destination lookup mapping',async()=>{
  const dom=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only',url:'https://native.example/'});
  const w=dom.window,applied=[];
  try{
    w.SF_ORG_ID='destination';w.OrgLoom={templates:{mount:()=>({})}};
    w.fetch=async url=>new Response(JSON.stringify({name:url.includes('Project')?'Project__c':'Contact',recordTypes:[],fields:[
      {name:'Name',type:'string',createable:true,updateable:true},
      ...(url.includes('Project')?[
        {name:'Primary_Contact__c',label:'Primary Contact',type:'reference',referenceTo:['Account'],createable:true,updateable:true,nillable:true},
        {name:'Destination_Contact__c',label:'Destination Contact',type:'reference',referenceTo:['Contact'],createable:true,updateable:true,nillable:true}
      ]:[])
    ]}));
    for(const file of ['vendor/upstream/packages/canvas/src/public/js/migrate-annotate.js','vendor/upstream/packages/canvas/src/public/js/migrate-match.js','webview/migration.js'])w.eval(fs.readFileSync(file,'utf8'));
    const original={records:[{id:1,objectName:'Project__c',values:{Name:'Project'}},{id:2,objectName:'Contact',values:{Name:'Morgan'}}],associations:[{fromId:1,toId:2,fieldName:'Primary_Contact__c'}]};
    const before=JSON.stringify(original);
    const finished=w.OrgLoomDesktopMigration.start(original,{},async p=>applied.push(p));
    for(let i=0;i<50&&!w.document.querySelector('.mm-decision-card');i++)await new Promise(r=>setImmediate(r));
    const primary=w.document.querySelector('[data-mm-primary]');primary.click();
    assert.equal(primary.disabled,true);
    assert.match(w.document.querySelector('.mm-differences').textContent,/accepts Account.*points to Contact/);
    const choice=()=>w.document.querySelector('[data-mm-relationship-field="Primary_Contact__c"]');
    assert.ok(choice().querySelector('option[value="Destination_Contact__c"]'));
    assert.equal(choice().querySelector('option[value="Primary_Contact__c"]'),null);
    const select=value=>{choice().value=value;choice().dispatchEvent(new w.Event('change',{bubbles:true}));};
    select('');assert.equal(primary.disabled,false);
    select('__original__');assert.equal(primary.disabled,true);
    select('Destination_Contact__c');assert.equal(primary.disabled,false);
    assert.equal(choice().value,'Destination_Contact__c');
    primary.click();primary.click();assert.equal(await finished,true);
    assert.equal(applied[0].associations[0].fieldName,'Destination_Contact__c');
    assert.equal(applied[0].records[0].values.Primary_Contact__c,undefined);
    assert.equal(JSON.stringify(original),before);
  }finally{dom.window.close();}
});

test('resolved migration value choices stay visible and can be changed before Apply',async()=>{
  const dom=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only',url:'https://native.example/'});
  const w=dom.window,applied=[];
  try{
    w.SF_ORG_ID='destination';w.OrgLoom={templates:{mount:()=>({})}};
    w.fetch=async()=>new Response(JSON.stringify({name:'Account',recordTypes:[{id:'012DEST',developerName:'Destination',label:'Destination'}],fields:[
      {name:'Name',type:'string',createable:true,updateable:true},
      {name:'DestinationNotes__c',type:'string',createable:true,updateable:true},
      {name:'SLA__c',label:'SLA',type:'picklist',restrictedPicklist:true,createable:true,updateable:true,picklistValues:[{value:'Gold',active:true},{value:'Silver',active:true}]},
      {name:'Tags__c',type:'multipicklist',restrictedPicklist:true,createable:true,updateable:true,picklistValues:[{value:'A',active:true},{value:'B',active:true}]}
    ]}));
    for(const file of ['vendor/upstream/packages/canvas/src/public/js/migrate-annotate.js','vendor/upstream/packages/canvas/src/public/js/migrate-match.js','webview/migration.js'])w.eval(fs.readFileSync(file,'utf8'));
    const finished=w.OrgLoomDesktopMigration.start({_meta:{nativeMigrationObjects:{Account:{recordTypes:[{id:'012SOURCE',developerName:'SourceOnly'}]}}},records:[{id:1,objectName:'Account',values:{Name:'Mapping test',RecordTypeId:'012SOURCE',MissingOne__c:'First',MissingTwo__c:'Second',SLA__c:'Platinum',Tags__c:'Old;Legacy'}}],associations:[]},{},async p=>applied.push(p));
    for(let i=0;i<50&&!w.document.querySelector('.mm-decision-card');i++)await new Promise(r=>setImmediate(r));
    const primary=w.document.querySelector('[data-mm-primary]');primary.click();
    const rowOrder=()=>Array.from(w.document.querySelectorAll('.mm-field-table tbody tr')).filter(row=>row.querySelector('td')).map(row=>row.querySelector('th').textContent + ':' + (row.querySelector('[data-mm-picklist-source]')?.getAttribute('data-mm-picklist-source') || ''));
    const originalOrder=rowOrder();
    const mapField=(field,value)=>{
      const select=w.document.querySelector('[data-mm-missing-field="'+field+'"] select[data-mm-field-resolution]');
      assert.ok(select);select.value=value;select.dispatchEvent(new w.Event('change',{bubbles:true}));
      assert.deepEqual(rowOrder(),originalOrder,'resolved fields must keep their original position');
    };
    mapField('MissingOne__c','__omit__');
    mapField('MissingTwo__c','DestinationNotes__c');
    mapField('MissingOne__c','');mapField('MissingOne__c','__omit__');
    const recordType=()=>w.document.querySelector('[data-mm-recordtype-record]');
    assert.ok(recordType());recordType().value='012DEST';recordType().dispatchEvent(new w.Event('change',{bubbles:true}));
    assert.equal(recordType().value,'012DEST');
    recordType().value='__clear__';recordType().dispatchEvent(new w.Event('change',{bubbles:true}));
    assert.equal(recordType().value,'__clear__');
    const control=source=>w.document.querySelector('[data-mm-picklist-source="'+source+'"]');
    const choose=(source,value)=>{const select=control(source);assert.ok(select);select.value=value;select.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(control(source).value,value);};
    choose('Platinum','Gold');choose('Old','A');
    assert.ok(control('Legacy'),'unresolved multipicklist member remains editable');
    choose('Legacy','__drop__');
    assert.equal(w.document.querySelectorAll('[data-mm-picklist-source]').length,3);
    assert.match(w.document.querySelector('.mm-field-record-status').textContent,/Reviewed/);
    choose('Platinum','__unresolved__');
    assert.match(w.document.querySelector('.mm-field-record-status').textContent,/to review/);
    choose('Platinum','Silver');choose('Legacy','B');
    assert.deepEqual(rowOrder(),originalOrder,'picklist and record type choices must not reorder rows');
    primary.click();w.document.querySelector('[data-mm-back]').click();
    assert.equal(control('Platinum').value,'Silver');
    primary.click();primary.click();assert.equal(await finished,true);
    assert.equal(applied[0].records[0].values.SLA__c,'Silver');
    assert.equal(applied[0].records[0].values.Tags__c,'A;B');
    assert.equal(applied[0].records[0].values.DestinationNotes__c,'Second');
  }finally{dom.window.close();}
});

test('native adapter renders the real shared migration dialog and retains fulfilled requests through Apply',async()=>{
  const dom=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only',url:'https://native.example/'});
  const w=dom.window,applied=[];
  try {
    w.SF_ORG_ID='destination';w.__ORGLOOM_NATIVE_IDENTITY__={orgName:'Test org'};
    w.OrgLoom={templates:{mount:()=>({})}};
    w.fetch=async url=>new Response(JSON.stringify(url.includes('/describe')?{
      name:'Account',label:'Account',labelPlural:'Accounts',recordTypes:[],
      fields:[{name:'Name',label:'Name',type:'string',createable:true,updateable:true,filterable:true,required:true}]
    }:{}));
    for(const file of ['vendor/upstream/packages/canvas/src/public/js/migrate-annotate.js','vendor/upstream/packages/canvas/src/public/js/migrate-match.js','webview/migration.js'])w.eval(fs.readFileSync(file,'utf8'));
    const file={_meta:{forMigration:true},records:[
      {id:1,objectName:'Account',values:{Name:'Requested <customer> & "team"'},slot:{kind:'whole-record',slotId:1}},
      {id:2,objectName:'Account',values:{},slot:{kind:'whole-record',slotId:2}}
    ],associations:[]};
    const finished=w.OrgLoomDesktopMigration.start(file,{},async p=>applied.push(p));
    async function until(predicate){for(let i=0;i<50;i++){if(predicate())return;await new Promise(r=>setImmediate(r));}assert.fail('UI did not settle');}
    await until(()=>w.document.querySelector('.mm-decision-card'));
    assert.equal(w.document.querySelectorAll('.mm-decision-card').length,1);
    assert.match(w.document.querySelector('.mm-record-decisions').textContent,/Requested <customer> & "team"/);
    assert.equal(w.document.querySelector('.mm-record-decisions customer'),null);
    assert.match(w.document.querySelector('.mm-decision-intro').textContent,/1 empty record request/);
    w.document.querySelector('.migrate-match-modal .modal-overlay').click();
    w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    assert.ok(w.document.querySelector('.migrate-match-modal'),'outside clicks and Escape must not dismiss migration');
    const primary=w.document.querySelector('[data-mm-primary]');
    assert.equal(primary.disabled,false);
    primary.click();assert.match(primary.textContent,/View summary/);
    primary.click();assert.match(primary.textContent,/Apply migration/);
    primary.click();
    assert.equal(await finished,true);
    assert.equal(applied.length,1);assert.equal(applied[0].records.length,1);
    assert.equal(applied[0].records[0].values.Name,'Requested <customer> & "team"');
    assert.equal(applied[0].records[0].slot,undefined);
  } finally {dom.window.close();}
});

for(const required of [false,true])test('record-step exclusion is reversible and respects '+(required?'required':'optional')+' relationships',async()=>{
  const dom=new JSDOM('<!doctype html><body></body>',{runScripts:'outside-only',url:'https://native.example/'});
  const w=dom.window,applied=[];
  try{
    w.SF_ORG_ID='destination';w.OrgLoom={templates:{mount:()=>({})}};
    w.fetch=async url=>new Response(JSON.stringify(url.includes('/describe')?{
      name:url.includes('/Account/')?'Account':'Contact',recordTypes:[],fields:[
        {name:'Name',type:'string',createable:true,updateable:true},
        ...(url.includes('/Contact/')?[{name:'AccountId',type:'reference',referenceTo:['Account'],createable:true,updateable:true,required,nillable:!required}]:[])
      ]
    }:{}));
    for(const file of ['vendor/upstream/packages/canvas/src/public/js/migrate-annotate.js','vendor/upstream/packages/canvas/src/public/js/migrate-match.js','webview/migration.js'])w.eval(fs.readFileSync(file,'utf8'));
    const finished=w.OrgLoomDesktopMigration.start({records:[{id:1,objectName:'Account',values:{Name:'Parent'}},{id:2,objectName:'Contact',values:{Name:'Child'}}],associations:[{fromId:2,toId:1,fieldName:'AccountId'}]},{},async p=>applied.push(p));
    for(let i=0;i<50&&!w.document.querySelector('.mm-decision-card');i++)await new Promise(r=>setImmediate(r));
    const choose=value=>{
      const input=w.document.querySelector('[data-mm-record-index="0"] input[value="'+value+'"]');
      assert.ok(input);input.checked=true;input.dispatchEvent(new w.Event('change',{bubbles:true}));
    };
    choose('exclude');assert.match(w.document.querySelector('[data-mm-record-index="0"]').textContent,/Not included/);
    choose('new');assert.equal(w.document.querySelector('[data-mm-record-index="0"] input[value="new"]').checked,true);
    choose('exclude');
    const primary=w.document.querySelector('[data-mm-primary]');primary.click();
    if(required){
      assert.match(w.document.querySelector('.mm-differences').textContent,/required relationship.*excluded record/i);
      assert.equal(primary.disabled,true);
      w.document.querySelector('button[data-mm-close]').click();
      assert.equal(await finished,false);assert.equal(applied.length,0);
    }else{
      primary.click();primary.click();assert.equal(await finished,true);
      assert.equal(applied[0].records.length,1);assert.equal(applied[0].records[0].objectName,'Contact');
      assert.equal(applied[0].associations.length,0);
    }
  }finally{dom.window.close();}
});
