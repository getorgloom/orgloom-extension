'use strict';
const { SalesforceError } = require('./salesforce.cjs');
const validId = value => typeof value === 'string' && /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/.test(value);
const scalar = value => value === null || ['string','number','boolean'].includes(typeof value);
const apiName = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
const metadataFields = new Set(['attributes','Id','CreatedDate','CreatedById','LastModifiedDate','LastModifiedById','SystemModstamp']);
const denied = error => error instanceof SalesforceError && [403,404].includes(error.status) && !['REQUEST_LIMIT_EXCEEDED','active-org-changed','reauth-required'].includes(error.code);

// Rebuild only the recognized draft format. Never return cached labels, metadata,
// errors, undo stacks, migration source data or arbitrary record properties.
async function authorizeRecovery(api, recovery) {
  if (!recovery) return null;
  api.assertActive(); api.metadata.clear();
  const descriptions = new Map(), current = new Map(), baselines = new Map(recovery.baselines);
  const omissions = [];
  const describe = async name => {
    if (!descriptions.has(name)) {
      try { await api.reads.name(name); descriptions.set(name, await api.describe(name)); }
      catch (error) { if (!denied(error)) throw error; descriptions.set(name, null); }
    }
    return descriptions.get(name);
  };
  const existing = async (name, id) => {
    const key = name + ':' + id;
    if (!current.has(key)) {
      try { current.set(key, await api.retrieve(name, id, false)); }
      catch (error) { if (!denied(error)) throw error; current.set(key, null); }
    }
    return current.get(key);
  };
  const result = { ...recovery, state: { version:1, local:{}, session:{} }, baselines:[] };
  const filteredBaselines = new Map();
  for (const [key, text] of Object.entries(recovery.state.session)) {
    if (!key.startsWith('orgloom:canvas-draft:v1|')) continue;
    const payload = JSON.parse(text), state = payload?.state;
    if (payload.v !== 1 || !state || !Array.isArray(state.bulkRecords)) throw new Error('Unsupported recovery format. No saved work was overwritten.');
    const records = [], allowed = new Map();
    for (const record of state.bulkRecords) {
      if (!record || !Number.isSafeInteger(record.id) || typeof record.objectName !== 'string') throw new Error('Invalid recovery record.');
      const desc = await describe(record.objectName);
      // Use identifiers, not cached record names or values whose access may be revoked.
      const identity = `${apiName(record.objectName) ? record.objectName : 'Record'} · canvas record #${record.id}`;
      if (!desc || (record.loadedFromId && !validId(record.loadedFromId))) { omissions.push(`${identity}: record could not be restored.`); continue; }
      const live = record.loadedFromId ? await existing(desc.name, record.loadedFromId) : null;
      if (record.loadedFromId && !live) { omissions.push(`${identity}: record is unavailable or you no longer have access.`); continue; }
      // REST retrieval proves field visibility for existing records. Fresh describe
      // (enriched with UI API when available) controls draft-field visibility.
      const fields = new Set(desc.fields.filter(f => !f.encrypted && f.type!=='encryptedstring' && (!live || Object.hasOwn(live, f.name))).map(f => f.name));
      const removed = new Set();
      const filter = (values, report = false) => Object.fromEntries(Object.entries(values || {}).filter(([name,value]) => {
        const keep = fields.has(name) && scalar(value);
        const field = desc.fields.find(f => f.name === name);
        const derivedCompound = field && ['address','location'].includes(field.type) && !field.createable && !field.updateable;
        const hasValue = v => v != null && v !== '';
        // Ignore bookkeeping, baseline-only cleanup and derived compound views.
        // An explicit clear of a previously populated field is still a user edit.
        if (!keep && report && !name.startsWith('_') && !metadataFields.has(name) && !derivedCompound &&
            (hasValue(value) || hasValue(record.loadedValues?.[name]))) removed.add(apiName(name) ? name : 'Unrecognized field');
        return keep;
      }));
      const copy = { id: record.id, objectName: desc.name, values: filter(record.values, true) };
      for (const name of ['x','y','fromSelectionId']) if (Number.isFinite(record[name])) copy[name] = record[name];
      for (const name of ['isTypeNode','isPending','pendingDelete']) if (record[name] === true) copy[name] = true;
      if (record.loadedFromId) {
        copy.loadedFromId = record.loadedFromId;
        copy.loadedValues = filter(record.loadedValues);
        const old = baselines.get(desc.name + ':' + record.loadedFromId);
        // Retain the original modification timestamp, never silently make stale
        // changes appear current just because permissions were revalidated.
        if (old) filteredBaselines.set(desc.name + ':' + record.loadedFromId, filter(old));
      }
      if (['insert','update','upsert'].includes(record._csvOperation)) copy._csvOperation = record._csvOperation;
      if (fields.has(record._csvExternalIdField)) copy._csvExternalIdField = record._csvExternalIdField;
      for (const link of state.bulkAssociations || []) {
        if (link.fromId === record.id && !fields.has(link.fieldName)) removed.add(apiName(link.fieldName) ? link.fieldName : 'Unrecognized relationship');
      }
      if (removed.size) omissions.push(`${identity}: could not restore ${[...removed].sort().join(', ')}.`);
      allowed.set(copy.id, { fields, record:copy }); records.push(copy);
    }
    const associations = (state.bulkAssociations || []).filter(a => allowed.has(a.fromId) && allowed.has(a.toId) && allowed.get(a.fromId).fields.has(a.fieldName)).map(a => ({ fromId:a.fromId, toId:a.toId, fieldName:a.fieldName }));
    const selected = [];
    for (const item of state.selectedObjects || []) {
      const name = item?.objectName || item?.name || item?.apiName;
      if (!name) continue;
      const desc = await describe(name); if (!desc) continue;
      const data=await api.metadata.graph(desc.name,desc);
      selected.push({ id:item.id, name:desc.name, label:desc.label || desc.name, data,
        worldPos:Number.isFinite(item.worldPos?.x)&&Number.isFinite(item.worldPos?.y)?{x:item.worldPos.x,y:item.worldPos.y}:{x:0,y:0},
      });
    }
    result.state.session[key] = JSON.stringify({ v:1, ts:payload.ts, identity:payload.identity, scope:payload.scope, state: {
      bulkRecords:records, bulkAssociations:associations, selectedObjects:selected,
      bulkIdSeq:Math.max(Number(state.bulkIdSeq)||0,...records.map(r=>r.id),0),
      selectedIdSeq:Number(state.selectedIdSeq)||0, activeIndex:-1,
      graphView:['bulk','schema'].includes(state.graphView)?state.graphView:'bulk',
      bulkZoom:Number.isFinite(state.bulkZoom)?state.bulkZoom:1,
      _draftCanvasId:typeof state._draftCanvasId==='string'?state._draftCanvasId:undefined,
    }});
  }
  for (const [key,text] of Object.entries(recovery.state.session)) {
    if (key.startsWith('orgloom:canvas-draft-active:v1|') && Object.hasOwn(result.state.session,text)) result.state.session[key]=text;
  }
  result.baselines = [...filteredBaselines];
  result.notice = omissions.length ? 'Some canvas data could not be restored. Review these items before uploading:\n' + omissions.join('\n') : null;
  api.assertActive(); return result;
}
module.exports = { authorizeRecovery };
