// Ported from the native UI; all data operations use the local desktop adapter.
(function(){
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isMigration=(payload,currentOrg=typeof window==='undefined'?null:window.SF_ORG_ID)=>!!(payload?._meta?.forMigration||payload?._meta?.migration||payload?._meta?.purpose==='migration'||(Array.isArray(payload?.records)&&currentOrg&&[payload._meta?.exportedFrom,payload._meta?.savedFrom].filter(Boolean).some(org=>String(org).slice(0,15)!==String(currentOrg).slice(0,15))));
  function stage(payload,describes){
    if(!Array.isArray(payload.records)||!Array.isArray(payload.associations))throw Error('Export a normal JSON canvas file with the migration checkbox selected.');
    // Completed requests remain ordinary records in a migration. Only empty
    // request placeholders are omitted; assignments are removed below.
    const emptyRequest=r=>r.slot&&(r.slot.kind||'whole-record')==='whole-record'&&!r.loadedFromId&&!Object.values(r.values||{}).some(v=>v!=null&&v!=='');
    const eligible=payload.records.filter(r=>!r.isTypeNode&&!r.isPending);
    const omittedRequests=eligible.filter(emptyRequest).length;
    const records=clone(eligible.filter(r=>!emptyRequest(r)));
    const ids=new Set(records.map(r=>r.id));
    const links=clone(payload.associations).filter(a=>ids.has(a.fromId)&&ids.has(a.toId));
    let cleared=0;
    for(const record of records){
      const source=payload._meta?.nativeMigrationObjects?.[record.objectName]||{};
      const target=describes[record.objectName]||{fields:[]};
      const references=new Set([...(source.references||[]),...target.fields.filter(f=>f.type==='reference').map(f=>f.name)].map(n=>n.toLowerCase()));
      record._sourceRecordTypeDeveloperName=(source.recordTypes||[]).find(rt=>rt.id===record.values?.RecordTypeId)?.developerName;
      // No source IDs, authorization state, request assignments, or upload receipts
      // survive into the destination plan. Links are rebuilt from canvas edges.
      const values=record.values||{};
      for(const key of Object.keys(values))if(key.startsWith('_')||key==='attributes'||key.toLowerCase()==='id'||references.has(key.toLowerCase())||['ownerid','recordtypeid','createdbyid','lastmodifiedbyid'].includes(key.toLowerCase())){
        if(values[key]!=null)cleared++;delete values[key];
      }
      record.values=values;
      for(const key of Object.keys(record))if(key.startsWith('_')&&key!=='_sourceRecordTypeDeveloperName')delete record[key];
      delete record.loadedFromId;delete record.loadedValues;delete record.originalValues;delete record.slot;delete record.canvasRecordId;
      if(record.pendingDelete){record._migrateMatchIntent='update';record._migrateMatchAmbiguous=true;record._migrateMatchSearched=true;}
    }
    return {bulkRecords:records,bulkAssociations:links,describeCache:describes,cleared,omittedRequests};
  }
  function destinationPayload(state,orgId){
    const records=state.bulkRecords.map(r=>{
      const describe=state.describeCache[r.objectName],fields=new Map((describe?.fields||[]).map(f=>[f.name,f]));
      const values={};
      for(const [name,value] of Object.entries(r.values||{})){
        const field=fields.get(name);
        if(field&&(r.loadedFromId?field.updateable:field.createable)&&!field.calculated&&!field.autoNumber)values[name]=value;
      }
      const result={id:r.id,objectName:r.objectName,label:r.label,x:r.x,y:r.y,values};
      if(r.pendingDelete)result.pendingDelete=true;
      if(r.loadedFromId){
        // Upload's concurrency check needs the destination timestamp, including
        // for deletions. Keep it as read-only snapshot metadata through import;
        // writable-field filtering above deliberately omits all source timestamps.
        if(r.loadedValues?.LastModifiedDate)values.LastModifiedDate=r.loadedValues.LastModifiedDate;
        result.loadedFromId=r.loadedFromId;result.originalValues={};
        // Draft-parent links have no literal destination ID in values. Preserve
        // their original lookup too, so import does not turn the baseline blank.
        const names=new Set([...Object.keys(values),...state.bulkAssociations.filter(a=>a.fromId===r.id).map(a=>a.fieldName)]);
        for(const name of names)if(JSON.stringify(values[name])!==JSON.stringify(r.loadedValues?.[name]))result.originalValues[name]=r.loadedValues?.[name]??null;
      }
      return result;
    });
    return {_meta:{app:'Org Loom',version:1,exportedFrom:orgId,recordData:'snapshot-with-changes',preservesLoadedLinks:true},schema:{objects:[]},records,associations:clone(state.bulkAssociations)};
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={isMigration,stage,destinationPayload};
  if(typeof window==='undefined')return;
  async function json(url,body){
    const response=await window.fetch(url,body?{method:'POST',body:JSON.stringify(body)}:{});
    const data=await response.json();if(!response.ok)throw Error(data.message||data.error||'Salesforce request failed.');return data;
  }
  async function chooseExport(defaultMigration=false){
    return new Promise(resolve=>{
      const overlay=document.createElement('div');overlay.className='modal';
      overlay.innerHTML='<div class="modal-overlay" data-cancel></div><div class="modal-body" style="max-width:480px"><div class="modal-header"><h3>Export canvas</h3></div><div class="modal-content"><label><input type="checkbox" data-migration> Prepare this file for migration to another org</label><p>The destination opens a migration review before applying records to its canvas. The JSON file contains record data; store it securely.</p></div><div class="modal-footer"><button class="button secondary" data-cancel>Cancel</button><button class="button" data-export>Export JSON</button></div></div>';
      const finish=value=>{document.removeEventListener('keydown',escape);overlay.remove();resolve(value);};
      const escape=e=>{if(e.key==='Escape')finish(null);};document.addEventListener('keydown',escape);
      overlay.querySelectorAll('[data-cancel]').forEach(el=>el.onclick=()=>finish(null));
      overlay.querySelector('[data-export]').onclick=()=>finish(overlay.querySelector('[data-migration]').checked);
      overlay.querySelector('[data-migration]').checked=defaultMigration;
      document.body.append(overlay);overlay.querySelector('[data-migration]').focus();
    });
  }
  async function start(payload,options,apply,beginImportLoad){
    const finishLoading=beginImportLoad?.('Preparing migration review…');
    let state;
    const describes={};
    async function ensureDescribe(name){
      const describe=await json('/api/objects/'+encodeURIComponent(name)+'/describe');
      // Populate authoritative record-type picklists, using Salesforce UI API directly.
      for(const rt of describe.recordTypes||[]){
        const layout=await json('/api/objects/'+encodeURIComponent(name)+'/layout?recordTypeId='+encodeURIComponent(rt.id));
        if(layout.picklistUnavailable)throw Error('Salesforce could not provide picklist values for '+name+'. Retry before migrating.');
        for(const field of describe.fields||[]){const pick=layout.picklistValues?.[field.name];if(pick){(field.picklistValuesByRecordType||={})[rt.id]=pick.values;(field.controllerValuesByRecordType||={})[rt.id]=pick.controllerValues||{};}}
      }
      describes[name]=describe;return describe;
    }
    try {
    await json('/api/capabilities/bulk-edit-records/check',{});
    if(options?.merge)throw Error('Migration replaces the current canvas after review. Choose Open instead of Merge.');
    // UI metadata only; source record IDs are never queried in the destination.
    for(const name of new Set((payload.records||[]).map(r=>r.objectName)))try{await ensureDescribe(name);}catch(error){describes[name]={name,fields:[],_unavailable:true};}
    state=stage(payload,describes);if(!state.bulkRecords.length)throw Error('This file has no completed records to migrate.');
    } finally {
      finishLoading?.();
    }
    const engine=window.Orgloom.migrateAnnotate;
    let applied=false;
    return new Promise(resolve=>{
      const dialog=window.OrgLoom.migrateMatch.mount({canvasState:state,csrfFetch:window.fetch,escapeHtml,ensureDescribe,renderBulkView:()=>{},onApplied:()=>{},
        onCommitPlan:async()=>{
          await json('/api/capabilities/bulk-edit-records/check',{});
          for(const record of state.bulkRecords)if(!record._migrateExcluded&&(!describes[record.objectName]||describes[record.objectName]._unavailable))throw Error('Exclude unavailable objects before applying.');
          const matched=state.bulkRecords.filter(r=>!r._migrateExcluded&&r._migrateMatchedId),baselines={};
          for(let i=0;i<matched.length;i+=100){
            const data=await json('/api/records/refresh',{records:matched.slice(i,i+100).map(r=>({objectName:r.objectName,sfId:r._migrateMatchedId}))});
            for(const result of data.results||[]){if(!result.ok)throw Error('A destination record is unavailable. Refresh the match.');baselines[result.objectName+'::'+result.sfId]=result.values;}
          }
          const annotations=engine.annotateRecords(state.bulkRecords,describes),byId=Object.fromEntries(state.bulkRecords.map((r,i)=>[r.id,annotations[i]]));
          // Compile on a copy: a failed import may be retried without losing the plan.
          const planned=clone(state);planned.describeCache=describes;
          engine.applyMigrationPlan(planned.bulkRecords,planned.bulkAssociations,byId,baselines,describes);
          const ready=destinationPayload(planned,window.SF_ORG_ID);
          await apply(ready,{...options,merge:false});applied=true;
        }});
      dialog.open({onClose:()=>resolve(applied)});
      const intro=document.querySelector('.migrate-match-modal .mm-decision-intro');
      if(intro&&state.omittedRequests){const note=document.createElement('p');note.textContent=state.omittedRequests+' empty record request(s) omitted; completed requested records are included.';intro.append(note);}
    });
  }
  window.OrgLoomDesktopMigration={isMigration,start,chooseExport};
  const mount=window.OrgLoom.templates.mount;
  window.OrgLoom.templates.mount=function(deps){
    const api=mount(deps),download=api.downloadTemplate;
    api.downloadTemplate=async function(name,schemaOnly,forMigration=false){
      try {
      if(schemaOnly)return download(name,schemaOnly);
      const migration=await chooseExport(forMigration);if(migration===null)return;
      if(!migration)return download(name,schemaOnly);
      await json('/api/capabilities/export-canvas/check',{});
      const payload=api.buildTemplate({schemaOnly:false});payload._meta.forMigration=true;
      payload._meta.nativeMigrationObjects=Object.fromEntries(Object.entries(deps.canvasState.describeCache).map(([name,d])=>[name,{references:(d.fields||[]).filter(f=>f.type==='reference').map(f=>f.name),recordTypes:d.recordTypes||[]}]));
      const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download=String(name||'canvas').replace(/[^a-zA-Z0-9 _.-]/g,'_')+'.migration.orgloom.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      } catch(error) { deps.showBulkToast(error.message||'Canvas export failed.','error'); }
    };
    return api;
  };
})();
