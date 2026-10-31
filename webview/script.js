(() => {
  if(!window.ORGLOOM_DESKTOP_LIVE)return;
  // Loaded after the pinned module and before app.js mounts it.
  window.OrgLoom.bulkScript.mount = deps => ({ openModal() {
    const modal=document.createElement('div');modal.className='modal';
    modal.innerHTML='<div class="modal-overlay"></div><div class="modal-body" style="max-width:780px"><div class="modal-header"><h3>Run script locally</h3></div><div class="modal-content"><p>Modify r.values in records. Preview changes or apply directly to the canvas. Salesforce changes only when you upload.</p><textarea id="desktop-script-source" rows="12" style="width:100%" spellcheck="false"></textarea><pre role="status" style="white-space:pre-wrap"></pre></div><div class="modal-footer"><button class="button secondary" data-close>Close</button><button class="button secondary" data-run>Preview changes</button><button class="button" data-apply>Apply to canvas</button></div></div>';
    document.body.appendChild(modal);
    const source=modal.querySelector('textarea'), status=modal.querySelector('pre'), run=modal.querySelector('[data-run]'), apply=modal.querySelector('[data-apply]');
    source.value="// Example: bump every Opportunity Amount by 10%\nfor (const r of records) {\n  if (r.objectName === 'Opportunity' && r.values.Amount) {\n    r.values.Amount = toNum(r.values.Amount) * 1.1;\n  }\n}";
    let job, preview, snapshot, originals;
    const post=async(action,body)=>{const r=await deps.csrfFetch('/api/desktop/script/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.message||'Script failed');return data;};
    const stop=()=>{if(job)void post('cancel',{id:job}).catch(error=>{status.textContent=error.message;});};
    modal.querySelector('[data-close]').onclick=()=>{stop();modal.remove();};
    const evaluate=async()=>{
      if(job)return;
      const rows=deps.canvasState.bulkRecords.filter(r=>!r.isTypeNode&&!r.isPending&&!r.canvasArtifact&&!r._inaccessible);
      originals=rows; snapshot=JSON.stringify(rows.map(r=>({id:r.id,objectName:r.objectName,loadedFromId:r.loadedFromId,values:r.values})));
      job=crypto.randomUUID();run.disabled=true;source.disabled=true;apply.disabled=true;preview=null;status.textContent='Running locally…';
      try{
        preview=await post('run',{id:job,source:source.value,records:JSON.parse(snapshot)});
        const before=JSON.parse(snapshot), details=[];
        const count=preview.records.filter((r,i)=>JSON.stringify(r.values)!==JSON.stringify(before[i].values)).length;
        preview.records.forEach((r,i)=>{
          for(const field of new Set([...Object.keys(before[i].values),...Object.keys(r.values)])) {
            if(JSON.stringify(before[i].values[field])!==JSON.stringify(r.values[field])) details.push(r.objectName+' #'+r.id+' · '+field+': '+JSON.stringify(before[i].values[field])+' → '+JSON.stringify(r.values[field]));
          }
        });
        status.textContent=count+' records would change.\n'+details.slice(0,200).join('\n')+(details.length>200?'\nShowing the first 200 changed fields.':'')+'\n'+preview.logs.join('\n');
        apply.disabled=!count;
      }
      catch(error){preview=null;apply.disabled=false;status.textContent=error.message+' No changes applied.';}
      finally{job=null;run.disabled=false;source.disabled=false;}
    };
    run.onclick=evaluate;
    source.oninput=()=>{preview=null;apply.disabled=!!job;};
    apply.onclick=async()=>{
      if(job)return;
      if(!preview)await evaluate();
      if(!preview||apply.disabled||!modal.isConnected)return;
      const current=deps.canvasState.bulkRecords.filter(r=>!r.isTypeNode&&!r.isPending&&!r.canvasArtifact&&!r._inaccessible);
      if(JSON.stringify(current.map(r=>({id:r.id,objectName:r.objectName,loadedFromId:r.loadedFromId,values:r.values})))!==snapshot){status.textContent='The canvas changed. Preview or apply again to use the current records.';preview=null;return;}
      const changed=new Map();preview.records.forEach((row,i)=>{if(JSON.stringify(row.values)!==JSON.stringify(originals[i].values))changed.set(row.id,{before:originals[i].values,after:row.values});});
      const oldLinks=structuredClone(deps.canvasState.bulkAssociations);
      for(const row of originals)if(changed.has(row.id))row.values=changed.get(row.id).after;
      deps.canvasState.bulkAssociations=deps.canvasState.bulkAssociations.filter(link=>{const r=changed.get(link.fromId);return !r||JSON.stringify(r.before[link.fieldName])===JSON.stringify(r.after[link.fieldName]);});
      deps.renderBulkView();apply.disabled=true;
      const afterLinks=JSON.stringify(deps.canvasState.bulkAssociations);
      const undo=()=>{
        if(JSON.stringify(deps.canvasState.bulkAssociations)!==afterLinks || originals.some(row=>changed.has(row.id)&&(!deps.canvasState.bulkRecords.includes(row)||JSON.stringify(row.values)!==JSON.stringify(changed.get(row.id).after)))) { deps.showBulkToast('Canvas changed since the script. Undo was not applied.','error');return; }
        for(const row of originals)if(changed.has(row.id))row.values=changed.get(row.id).before;
        deps.canvasState.bulkAssociations=oldLinks;deps.renderBulkView();
      };
      // Offer immediate undo; close the preview so it cannot be applied twice.
      modal.remove();
      if(deps.showBulkToastWithAction)deps.showBulkToastWithAction('Script applied to canvas.','Undo',undo);else deps.showBulkToast('Script applied to canvas.');
    };
  } });
})();
