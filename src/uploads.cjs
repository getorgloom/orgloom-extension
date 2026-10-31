'use strict';
const { createHash } = require('node:crypto');
const { API, SalesforceError } = require('./salesforce.cjs');
const { executeUploadDeletes } = require('./upload-deletes.cjs');
const { externalKey, matchUpsert } = require('./upserts.cjs');
const validId = v => typeof v === 'string' && /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/.test(v);
const sameInstant = (a, b) => {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/;
  if (typeof a !== 'string' || typeof b !== 'string' || !iso.test(a) || !iso.test(b)) return false;
  const left = Date.parse(a), right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
};
const equal = (a, b, type) => {
  if ((a == null || a === '') && (b == null || b === '')) return true;
  if (a === b) return true;
  if (type === 'datetime') return sameInstant(a, b);
  if (['int','double','currency','percent','long'].includes(type)) {
    const numeric = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
    return numeric(a) && numeric(b) && Number(a) === Number(b);
  }
  if (type === 'boolean') return /^(true|false)$/i.test(String(a)) && String(a).toLowerCase() === String(b).toLowerCase();
  if (['id','reference'].includes(type) && validId(a) && validId(b)) return a.slice(0,15) === b.slice(0,15);
  return JSON.stringify(a) === JSON.stringify(b);
};
const plain = v => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const tempId = v => Number.isSafeInteger(v) && v > 0;
const fail = (message, code = 'invalid-upload', status = 400) => { throw new SalesforceError(message, code, status); };
const attempt = v => { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(v)) fail('Reopen Upload to start a new upload attempt.'); return v; };
const specialized = name => /__(e|mdt|b|x|kav)$/i.test(name) || /^KnowledgeArticleVersion/i.test(name) || (name !== 'Event' && /Event(?:Stream)?$/i.test(name));
const rowResult = (op, extra) => ({ tempId: op.tempId, objectName: op.objectName, mode: op.mode, ...(op.recordId ? { id: op.recordId, sfId: op.recordId } : {}), ...extra });
const confirmed = (body, recordId, field, current, type) => (body.baselineConfirmations || []).some(r => r.sfId.slice(0,15) === recordId.slice(0,15) && r.fields.some(f => f.fieldName === field && equal(f.expectedCurrent, current, type)));
const conflict = (rec, fields) => ({ tempId: rec.tempId, objectName: rec.objectName, sfId: rec.recordId, fields });
const rejectConflicts = conflicts => {
  const error = new SalesforceError('The canvas baseline changed or a record changed in Salesforce. Review the current values before uploading.', 'salesforce-records-changed', 409);
  const grouped = new Map();
  for (const row of conflicts) {
    const key = row.objectName+':'+row.sfId;
    if (!grouped.has(key)) grouped.set(key,{...row,fields:[]});
    grouped.get(key).fields.push(...row.fields);
  }
  error.conflicts = [...grouped.values()]; throw error;
};

// No package objects, Apex, ContentVersion, hosted key service, or hosted ledger.
// Salesforce owns the transaction; VS Code SecretStorage owns intent/receipts.
class Uploads {
  constructor(api) { this.api = api; }
  receiptKey(id) { return this.api.pendingKey + '.receipt.' + attempt(id); }
  async readPending() {
    const raw = await this.api.secrets.get(this.api.pendingKey);
    if (!raw) return null;
    const pending = JSON.parse(raw);
    // Remove field payloads from older journals without losing the unknown-outcome guard.
    delete pending.changes;
    delete pending.baseline;
    if (Array.isArray(pending.operations)) pending.operations = pending.operations.map(op => ({
      tempId: op.tempId, objectName: op.objectName, recordId: op.recordId, mode: op.mode,
    }));
    const minimized = JSON.stringify(pending);
    if (minimized !== raw) await this.api.secrets.store(this.api.pendingKey, minimized);
    return pending;
  }
  async plan(body, { deferConflicts = false, unchanged = [] } = {}) {
    const api = this.api;
    if (body.expectedSfOrgId !== api.orgId) fail('The active Salesforce org changed. Reopen Upload.', 'active-org-changed', 409);
    if (!Array.isArray(body.records) || !Array.isArray(body.deletes || []) || !Array.isArray(body.associations || []) || !Array.isArray(body.skipTempIds || [])) fail('Invalid upload lists.');
    if (body.records.length + (body.deletes || []).length > 500) fail('Select at most 500 canvas records per upload.');
    if ((body.associations || []).length > 5000) fail('Too many upload relationships.');
    if (body.allowDuplicates !== undefined && typeof body.allowDuplicates !== 'boolean') fail('Invalid duplicate-alert setting.');
    if (body.baselineConfirmations !== undefined && (!Array.isArray(body.baselineConfirmations) || body.baselineConfirmations.length > 500 || body.baselineConfirmations.some(r => !plain(r) || !validId(r.sfId) || !Array.isArray(r.fields) || r.fields.length > 1000 || r.fields.some(f => !plain(f) || typeof f.fieldName !== 'string' || !Object.hasOwn(f,'expectedCurrent') || (f.expectedCurrent !== null && !['string','number','boolean'].includes(typeof f.expectedCurrent)))))) fail('Invalid conflict confirmation.');
    const records = new Map(), seenIds = new Set(), seenKeys = new Set(), descriptions = new Map(), ops = [];
    const conflicts = [];
    const describe = async name => {
      name = await api.metadata.name(name);
      if (specialized(name)) fail('This specialized object needs a dedicated Salesforce API: ' + name);
      if (!descriptions.has(name)) descriptions.set(name, await api.describe(name, { permissionsOnly: true }));
      return { name, desc: descriptions.get(name) };
    };
    for (const raw of [...body.records, ...(body.deletes || []).map(r => ({ ...r, deleting: true }))]) {
      if (!plain(raw) || !tempId(raw.tempId) || records.has(raw.tempId) || raw.isTypeNode || raw.isPending || raw.canvasArtifact || raw._inaccessible || (raw._csvOperation && !['insert','update','upsert'].includes(raw._csvOperation))) fail('Invalid, duplicate, or unsupported canvas record.');
      let recordId = raw.deleting ? raw.sfId : raw.loadedFromId;
      const { name, desc } = await describe(raw.objectName);
      let external;
      if(raw._csvOperation==='upsert' && !raw.deleting) {
        external=externalKey(desc,raw);
        const key=JSON.stringify([name,external.field,external.caseSensitive?external.value:external.value.toLowerCase()]);
        if(seenKeys.has(key))fail('The same External ID occurs more than once in this upload.');seenKeys.add(key);
        const found=await matchUpsert(api,name,external);
        if(recordId && (!found || recordId.slice(0,15)!==found.slice(0,15)))fail('The upsert key no longer identifies the loaded record.');
        recordId=found;
        if(found)await api.retrieve(name,found);
      }
      if(raw._csvOperation==='update' && !recordId)fail('CSV updates require a loaded Salesforce record ID.');
      if (recordId != null && !validId(recordId)) fail('Invalid Salesforce record ID.');
      if (raw.deleting && !recordId) fail('A deletion requires a loaded Salesforce record.');
      if (recordId) {
        const key = recordId.slice(0, 15);
        if (seenIds.has(key)) fail('The same Salesforce record appears more than once.');
        seenIds.add(key);
      }
      records.set(raw.tempId, { ...raw, objectName: name, recordId, desc, external });
    }
    const skip = new Set(body.skipTempIds || []);
    if ([...skip].some(n => !records.has(n) || !records.get(n).recordId || records.get(n).deleting)) fail('Only loaded, non-deleted records can be skipped.');
    const links = new Map();
    for (const link of body.associations || []) {
      if (!plain(link) || !records.has(link.fromId) || !records.has(link.toId) || typeof link.fieldName !== 'string') fail('A relationship refers to a record outside the upload.');
      const source = records.get(link.fromId), target = records.get(link.toId);
      if (source.deleting || target.deleting) fail('A submitted relationship points to a record being deleted.');
      const field = source.desc.fields.find(f => f.name === link.fieldName);
      if (field?.type !== 'reference' || !field.referenceTo?.includes(target.objectName)) fail('Invalid relationship field or target: ' + link.fieldName);
      const key = link.fromId + ':' + field.name;
      if (links.has(key)) fail('A lookup field has multiple submitted targets.');
      links.set(key, target);
    }
    for (const rec of records.values()) {
      if (skip.has(rec.tempId)) continue;
      const mode = rec.deleting ? 'delete' : rec.external ? 'upsert' : rec.recordId ? 'update' : 'create';
      const permission = mode === 'delete' ? 'deletable' : rec.recordId ? 'updateable' : 'createable';
      if (!rec.desc[permission]) fail('Salesforce does not allow ' + mode + ' on ' + rec.objectName + '.', 'object-access-denied', 403);
      if(rec.external && !rec.recordId && !rec.desc.updateable)fail('Upsert can update a matching record and requires update permission.','object-access-denied',403);
      let baseline = rec.recordId ? api.baselines.get(rec.objectName + ':' + rec.recordId) : null;
      // Snapshot imports can retain edits without a host-owned baseline. Read
      // the destination afresh and compare the fields the user actually edited.
      // Do not cache this read: keep the imported original values for retries.
      if (rec.recordId && (!baseline || !sameInstant(baseline.LastModifiedDate,baseline.LastModifiedDate))) {
        try { baseline = await api.retrieve(rec.objectName,rec.recordId,false); }
        catch (error) {
          if (error instanceof SalesforceError && ['NOT_FOUND','INSUFFICIENT_ACCESS','INSUFFICIENT_ACCESS_OR_READONLY'].includes(error.code)) fail(rec.objectName+' '+rec.recordId+' is unavailable. Check your record access or choose a different destination record.', 'record-access-denied',403);
          throw error;
        }
        if (!sameInstant(baseline.LastModifiedDate,baseline.LastModifiedDate)) fail('Cannot verify the Salesforce modification time for '+rec.objectName+' '+rec.recordId+'. Reload that record before uploading.', 'missing-baseline');
      }
      if (mode === 'update' && !plain(rec.loadedValues)) fail('The record is missing its original values. Reload it before uploading.');
      const changes = {}, refs = new Map(), dependencies = new Set();
      if (mode !== 'delete') {
        if (!plain(rec.values)) fail('Invalid record field values.');
        const values = { ...rec.values };
        for (const field of rec.desc.fields.filter(f => f.type === 'reference')) {
          const target = links.get(rec.tempId + ':' + field.name);
          if (!target) continue;
          if (target.recordId && (!target.external || skip.has(target.tempId))) values[field.name] = target.recordId;
          else { refs.set(field.name, target.tempId); values[field.name] = null; dependencies.add(target.tempId); }
        }
        for (const [name, value] of Object.entries(values)) {
          // Salesforce owns record IDs and modification times. They are never writes.
          if (['attributes','Id','LastModifiedDate','LastModifiedById','CreatedDate','CreatedById','SystemModstamp'].includes(name)) continue;
          const field = rec.desc.fields.find(f => f.name === name);
          // Case snapshots contain this status-at-creation flag. Salesforce
          // derives it on insert, even though some users may update it later.
          if (rec.objectName === 'Case' && name === 'IsClosedOnCreate' && !rec.recordId && field?.createable === false) continue;
          // Older unlinked canvases may retain their read-only source snapshot.
          // Ignore unchanged carryover, but still reject attempted edits without FLS.
          if (!rec.recordId && field?.createable === false && !refs.has(name) && plain(rec.loadedValues) && Object.hasOwn(rec.loadedValues,name) && equal(value,rec.loadedValues[name],field.type)) continue;
          if (mode === 'update' && !refs.has(name) && equal(value,rec.loadedValues[name],field?.type)) continue;
          if ((mode === 'update' || (rec.external && baseline)) && !refs.has(name) && equal(value, baseline[name], field?.type)) continue;
          if (mode === 'create' && (value == null || value === '') && !refs.has(name)) continue;
          if (!field?.[permission] || field.calculated || field.autoNumber || field.encrypted || ['address', 'location'].includes(field.type)) fail('This upload cannot write field ' + name + '.', 'unsupported-field');
          if (mode === 'update' && !equal(rec.loadedValues[name], baseline[name], field.type) && !confirmed(body,rec.recordId,name,baseline[name],field.type)) {
            conflicts.push(conflict(rec,[{fieldName:name,loaded:rec.loadedValues[name]??null,current:baseline[name]??null,canvas:refs.has(name)?'New canvas record #'+refs.get(name):value}]));
          }
          if(rec.external && !rec.recordId && !field.updateable)fail('Upsert may update an existing record; field '+name+' is not updateable.','unsupported-field');
          if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) fail('Only scalar field values are supported: ' + name);
          if (typeof value === 'number' && !Number.isFinite(value)) fail('Invalid numeric value: ' + name);
          if (typeof value === 'string' && value.includes('@{')) fail('Field values cannot contain Composite reference expressions.');
          if (field.type === 'reference' && value != null && !validId(value)) fail('Invalid lookup ID: ' + name);
          changes[name] = value;
        }
        if (mode === 'update' && !Object.keys(changes).length) {
          unchanged.push(rowResult(rec, {success:true,mode:'unchanged'}));
          continue;
        }
      }
      ops.push({ tempId: rec.tempId, objectName: rec.objectName, recordId: rec.recordId || null, mode, external:rec.external, changes, refs, dependencies, baseline: baseline && structuredClone(baseline), desc: rec.desc, baselineConflicts: conflicts.filter(c=>c.tempId===rec.tempId).flatMap(c=>c.fields) });
    }
    if (conflicts.length && !deferConflicts) rejectConflicts(conflicts);
    if (!ops.length && !unchanged.length) fail('No changed writable fields or records were supplied.');
    const byTemp = new Map(ops.map(o => [o.tempId, o])), deleting = new Map(ops.filter(o => o.mode === 'delete').map(o => [o.recordId.slice(0, 15), o]));
    for (const op of ops) {
      // Deletions use persisted relationships, never staged canvas links.
      for (const f of op.desc.fields.filter(f => f.type === 'reference')) {
        const value = op.mode === 'delete' ? op.baseline[f.name] : op.changes[f.name] === undefined ? op.baseline?.[f.name] : op.changes[f.name];
        const parent = validId(value) && deleting.get(value.slice(0, 15));
        if (!parent || !f.referenceTo?.includes(parent.objectName)) continue;
        if (op.mode !== 'delete') fail('A record being uploaded still references a record selected for deletion. Clear that lookup first.');
        // Deletion dependencies are reread and scheduled separately after Graph.
      }
      for (const dep of op.dependencies) if (!byTemp.has(dep)) fail('A required draft parent is not included in the upload.');
    }
    const ordered = [], remaining = new Set(ops.filter(o => o.mode !== 'delete')), depths = new Map();
    while (remaining.size) {
      let ready = [...remaining].filter(o => [...o.dependencies].every(d => depths.has(d)));
      if (!ready.length) {
        // Match the native planner: break only nullable, subsequently writable
        // references. The follow-up PATCH stays inside the same atomic Graph.
        const candidate = [...remaining].find(o => [...o.refs].filter(([, target]) => !depths.has(target)).every(([field]) => {
          const meta = o.desc.fields.find(f => f.name === field);
          return meta?.nillable === true && meta.updateable === true;
        }));
        if (!candidate) fail('Break the cycle between required or non-updateable references before uploading.');
        candidate.deferredRefs = new Map([...candidate.refs].filter(([, target]) => !depths.has(target)));
        ready = [candidate];
      }
      for (const op of ready) {
        const depth = 1 + Math.max(0, ...[...op.refs].filter(([field]) => !op.deferredRefs?.has(field)).map(([, d]) => depths.get(d)));
        if (depth > 15) fail('This upload exceeds Salesforce’s 15-level graph limit.');
        depths.set(op.tempId, depth); remaining.delete(op); ordered.push(op);
      }
    }
    for (const op of ordered.filter(o => o.deferredRefs?.size)) {
      if (1 + Math.max(depths.get(op.tempId), ...[...op.deferredRefs.values()].map(t => depths.get(t))) > 15) fail('This upload exceeds Salesforce’s 15-level graph limit.');
    }
    if (ordered.length + ordered.filter(o => o.deferredRefs?.size).length > 500) fail('This upload needs more than 500 Graph operations including circular relationship updates. Select fewer records.');
    ordered.push(...ops.filter(o => o.mode === 'delete'));
    const existing = ops.filter(o => o.recordId);
    for (let offset = 0; offset < existing.length; offset += 200) {
      const access = await api.access(existing.slice(offset, offset + 200).map(o => ({ tempId: o.tempId, sfId: o.recordId })));
      for (const op of existing.slice(offset, offset + 200)) {
        const rights = access.results.find(r => r.tempId === op.tempId)?.access;
        if (!(op.mode === 'delete' ? rights?.hasDeleteAccess : rights?.hasEditAccess)) fail('Salesforce does not allow ' + op.mode + ' on this record.', 'record-access-denied', 403);
      }
    }
    return ordered;
  }
  async checkVersions(ops, body = {}) {
    const conflicts = [];
    for(const op of ops.filter(o=>o.external)) {
      const current=await matchUpsert(this.api,op.objectName,op.external);
      if(current?.slice(0,15)!==op.recordId?.slice(0,15))fail('The External ID match changed. Reopen Upload to review its destination.','upsert-match-changed');
    }
    const groups = new Map();
    for (const op of ops.filter(o => o.recordId)) {
      if (!groups.has(op.objectName)) groups.set(op.objectName, []);
      groups.get(op.objectName).push(op);
    }
    for (const [name, group] of groups) {
      for (let offset = 0; offset < group.length; offset += 200) {
        this.api.assertActive();
        const chunk = group.slice(offset, offset + 200);
        const data = await this.api.query(`SELECT Id, LastModifiedDate FROM ${name} WHERE Id IN (${chunk.map(o => "'" + o.recordId + "'").join(',')})`);
        for (const op of chunk) {
          const current = data.records?.find(r => r.Id?.slice(0, 15) === op.recordId.slice(0, 15));
          if (!current?.LastModifiedDate || !sameInstant(current.LastModifiedDate,current.LastModifiedDate)) fail('This record is unavailable or its modification time could not be verified. Reload it before uploading.', 'missing-baseline');
          let fields = op.baselineConflicts || [];
          if (!sameInstant(current.LastModifiedDate, op.baseline.LastModifiedDate)) {
            // Deleting removes the whole record; any intervening change needs review.
            if (op.mode === 'delete') fail(op.objectName+' '+op.recordId+' changed after it was reviewed for deletion. Reload that record and review the deletion again.', 'delete-record-changed',409);
            // A timestamp change only tells us to reread. Warn solely when a field
            // being overwritten changed; unrelated Salesforce edits are preserved.
            const fresh = await this.api.retrieve(op.objectName,op.recordId,false);
            const originals = new Map(fields.map(f=>[f.fieldName,f]));
            fields = [];
            for (const name of Object.keys(op.changes)) {
              const field = op.desc.fields.find(f=>f.name===name);
              const loaded = originals.has(name) ? originals.get(name).loaded : op.baseline[name];
              if (!equal(loaded,fresh[name],field?.type) && (op.refs.has(name) || !equal(op.changes[name],fresh[name],field?.type))) fields.push({fieldName:name,loaded:loaded??null,current:fresh[name]??null,canvas:op.refs.has(name)?'New canvas record #'+op.refs.get(name):op.changes[name]});
            }
            if (!sameInstant(fresh.LastModifiedDate,fresh.LastModifiedDate)) fail('Reload this record before uploading.', 'missing-baseline');
            op.baseline = structuredClone(fresh);
          }
          if (!fields.every(f=>confirmed(body,op.recordId,f.fieldName,f.current,op.desc.fields.find(d=>d.name===f.fieldName)?.type))) conflicts.push(conflict(op,fields));
          op.baselineConflicts = [];
        }
      }
    }
    if (conflicts.length) rejectConflicts(conflicts);
  }
  graph(ops) {
    const compositeRequest = ops.map(op => {
      const body = { ...op.changes };
      for (const [field, target] of op.refs) {
        if (op.deferredRefs?.has(field)) delete body[field];
        else body[field] = '@{r' + target + '.id}';
      }
      if(op.external) {
        delete body[op.external.field];
        const url=API+'/sobjects/'+op.objectName+'/'+op.external.field+'/'+encodeURIComponent(op.external.value).replaceAll('.', '%2E')+(op.recordId?'?updateOnly=true':'');
        return {method:'PATCH',url,referenceId:'r'+op.tempId,body};
      }
      return { method: op.mode === 'create' ? 'POST' : op.mode === 'update' ? 'PATCH' : 'DELETE', url: API + '/sobjects/' + op.objectName + (op.recordId ? '/' + op.recordId : ''), referenceId: 'r' + op.tempId, ...(op.mode === 'delete' ? {} : { body }) };
    });
    for (const op of ops.filter(o => o.deferredRefs?.size)) {
      compositeRequest.push({ method: 'PATCH', url: API + '/sobjects/' + op.objectName + '/' + (op.recordId || '@{r' + op.tempId + '.id}'), referenceId: 'r' + op.tempId + '_links', body: Object.fromEntries([...op.deferredRefs].map(([field, target]) => [field, '@{r' + target + '.id}'])) });
    }
    return { graphs: [{ graphId: 'canvas', compositeRequest }] };
  }
  groups(ops) {
    const parent = new Map(ops.map(o => [o.tempId,o.tempId]));
    const root = id => { while(parent.get(id)!==id) id=parent.get(id); return id; };
    const join = (a,b) => { if(parent.has(a)&&parent.has(b))parent.set(root(a),root(b)); };
    const byId = new Map(ops.filter(o=>o.recordId).map(o=>[o.recordId.slice(0,15),o]));
    for(const op of ops) {
      for(const dep of op.dependencies) join(op.tempId,dep);
      for(const field of op.desc.fields.filter(f=>f.type==='reference')) {
        const value = Object.hasOwn(op.changes,field.name)?op.changes[field.name]:op.baseline?.[field.name];
        const target = validId(value)&&byId.get(value.slice(0,15));
        if(target&&field.referenceTo?.includes(target.objectName))join(op.tempId,target.tempId);
      }
    }
    const groups=new Map();
    for(const op of ops){const key=root(op.tempId);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(op);}
    return [...groups.values()];
  }
  graphBatches(groups) {
    const batches = [];
    for (const group of groups) {
      const requests = this.graph(group).graphs[0].compositeRequest;
      // Salesforce counts API version + HTTP method + object across the whole
      // payload, including deferred relationship PATCHes and external-ID upserts.
      const groupTypes = requests.map(r => r.method + ':' + r.url.split('/').slice(0, 6).join('/').toLowerCase());
      if (new Set(groupTypes).size > 15 || requests.length > 500) fail('A connected group exceeds Salesforce’s Graph request limits. Split the selection.');
      // Groups are independent. Reuse an earlier compatible payload instead of
      // creating one request per group when operation types alternate.
      let batch = batches.find(b => b.groups.length < 75 && b.nodes + requests.length <= 500 && new Set([...b.types, ...groupTypes]).size <= 15);
      if (!batch) { batch = {groups:[],types:new Set(),nodes:0}; batches.push(batch); }
      batch.groups.push(group); batch.nodes += requests.length;
      for (const type of groupTypes) batch.types.add(type);
    }
    return batches.map(b => b.groups);
  }
  parse(ops, response) {
    const replies = response?.graphs;
    if (!Array.isArray(replies) || replies.length !== 1 || replies[0].graphId !== 'canvas' || typeof replies[0].isSuccessful !== 'boolean') fail('Salesforce returned an incomplete transaction response.', 'upload-outcome-unknown', 409);
    const graph = replies[0], rows = graph.graphResponse?.compositeResponse || [];
    const expected = ops.flatMap(o => ['r' + o.tempId, ...(o.deferredRefs?.size ? ['r' + o.tempId + '_links'] : [])]);
    if (graph.isSuccessful && (rows.length !== expected.length || expected.some(ref => rows.filter(r => r.referenceId === ref && r.httpStatusCode >= 200 && r.httpStatusCode < 300).length !== 1))) fail('Salesforce returned incomplete record results.', 'upload-outcome-unknown', 409);
    return ops.map(op => {
      const row = rows.find(r => r.referenceId === 'r' + op.tempId);
      if (graph.isSuccessful) {
        const id = op.external ? row?.body?.id : op.recordId || row?.body?.id;
        if (!(row?.httpStatusCode >= 200 && row.httpStatusCode < 300) || !validId(id)) fail('Salesforce returned an ambiguous record result.', 'upload-outcome-unknown', 409);
        if(op.external && (typeof row.body.created!=='boolean' || (op.recordId && op.recordId.slice(0,15)!==id.slice(0,15)))) fail('Salesforce returned an unexpected upsert destination.','upload-outcome-unknown',409);
        return rowResult(op, { success: true, id, ...(op.external?{mode:row.body.created?'create':'update'}:{}), ...(op.mode === 'delete' ? { sfId: id } : {}) });
      }
      const errors = Array.isArray(row?.body) ? row.body : graph.graphResponse?.errors || [];
      return rowResult(op, { success: false, errorCode: errors[0]?.errorCode || 'GRAPH_ROLLED_BACK', error: errors.map(e => e.message).filter(Boolean).join('; ').slice(0, 1000) || 'Salesforce rolled back the entire selected upload.', fields: errors.flatMap(e => Array.isArray(e.fields) ? e.fields : []) });
    });
  }
  response(rows, graphCount = 0) {
    return { results: rows.filter(r => r.mode !== 'delete'), deletes: rows.filter(r => r.mode === 'delete'), canonicalValues: {}, atomicSuccess: rows.every(r => r.success), graphCount, mode: 'desktop', instanceUrl: this.api.client.publicIdentity().instanceUrl };
  }
  async canonical(response) {
    // A verified no-op still needs a fresh comparison snapshot in the canvas.
    // Otherwise stale imported baselines keep those records marked modified.
    const rows = response.results.filter(r => r.success);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (next < rows.length) {
        const row = rows[next++];
        try { response.canonicalValues[row.tempId] = await this.api.retrieve(row.objectName, row.id); }
        catch { this.api.baselines.delete(row.objectName + ':' + row.id); }
      }
    }));
    for (const row of response.deletes.filter(r => r.success)) this.api.baselines.delete(row.objectName + ':' + row.id);
    return response;
  }
  async upload(body) {
    const api = this.api; api.assertActive();
    if (api.uploading || api.client.desktopUploadInProgress) fail('An upload is already in progress.');
    api.uploading = true; api.client.desktopUploadInProgress = true;
    try {
      const attemptId = attempt(body.attemptId), key = this.receiptKey(attemptId);
      const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const prior = await api.secrets.get(key);
      if (prior) {
        const receipt = JSON.parse(prior);
        if(receipt.retired)fail('This interrupted attempt was retired after review. It cannot be replayed. Start from freshly loaded Salesforce records.', 'upload-retired',409);
        if (receipt.fingerprint !== fingerprint) fail('This attempt was already used for different changes. Reopen Upload.');
        return { ...await this.canonical(receipt.response), idempotentReplay: true };
      }
      if (await this.readPending()) fail('An earlier upload has an unconfirmed outcome. Check Salesforce before uploading these records again.', 'upload-outcome-unknown', 409);
      // Every tracked record needs a result, including updates eliminated by
      // typed comparison. Otherwise the canvas mistakes those omissions for lost writes.
      const unchanged = [];
      const ops = await this.plan(body, {deferConflicts:true,unchanged});
      const groups = this.groups(ops.filter(o => o.mode !== 'delete'));
      const graphBatches = body.allowDuplicates === true ? [] : this.graphBatches(groups);
      // Graph ignores duplicate-rule headers. Keep each connected group atomic
      // using Composite, which supports the header on individual subrequests.
      if (body.allowDuplicates === true && groups.some(group => this.graph(group).graphs[0].compositeRequest.length > 25)) fail('Duplicate override supports up to 25 operations in a connected group. Resolve the duplicate or reduce the connected upload selection.', 'duplicate-override-group-too-large');
      await this.checkVersions(ops, body);
      const single = ops.length === 1 && ops[0].mode === 'update';
      const first = ops[0];
      const approved = !ops.length || await api.confirmUpload({ allowDuplicates: body.allowDuplicates === true, orgName: api.client.publicIdentity().orgName, operations: ops.map(o => ({ tempId: o.tempId, objectName: o.objectName, recordId: o.recordId, mode: o.mode, ...(o.external ? {external: o.external} : {}), changes: { ...o.changes, ...Object.fromEntries([...o.refs].map(([f, t]) => [f, 'New canvas record #' + t])) }, baseline: o.baseline })), ...(single ? { objectName: first.objectName, recordId: first.recordId, changes: first.changes, baseline: first.baseline } : {}) });
      if (!approved) fail('Upload cancelled.', 'upload-cancelled');
      api.assertActive();
      // Recheck after the user finishes reviewing. Composite Graph has no
      // conditional subrequest headers: this remains optimistic concurrency.
      await this.checkVersions(ops);
      const duplicateHeaders = body.allowDuplicates === true ? { 'Sforce-Duplicate-Rule-Header':'allowSave=true' } : {};
      const pending = { version: 3, attemptId, fingerprint, time: Date.now(), state: 'ready', operations: ops.map(o => ({ tempId: o.tempId, objectName: o.objectName, recordId: o.recordId, mode: o.mode })), single, completed: unchanged, inFlight: [], graphCount: single ? 0 : groups.length };
      const save = () => api.secrets.store(api.pendingKey, JSON.stringify(pending));
      const before = async selected => {
        api.assertActive(); pending.state = 'dispatched'; pending.inFlight = selected.map(o => o.tempId); await save(); api.assertActive();
      };
      const remember = async results => {
        const known = new Map(pending.completed.map(r => [r.tempId,r]));
        for(const result of results) known.set(result.tempId,result);
        pending.completed = [...known.values()]; pending.inFlight = pending.inFlight.filter(id=>!known.has(id));
        pending.state = pending.inFlight.length ? 'dispatched' : 'ready'; await save();
      };
      const rejected = (selected,error) => selected.map(op=>rowResult(op,{success:false,errorCode:error.code,error:error.message}));
      const definitive = error => error instanceof SalesforceError && error.status >= 400 && error.status < 500 && ![408,409].includes(error.status);
      const send = async (selected, request, parse) => {
        await before(selected);
        let response;
        try { response = await request(); }
        catch(error) {
          if(definitive(error)){await remember(rejected(selected,error));return;}
          fail('Upload outcome is unknown. Confirmed earlier results are retained. No automatic retry was sent. Check Salesforce before uploading these records again.', 'upload-outcome-unknown',409);
        }
        // Parsing and journal errors must never be treated as a Salesforce rejection.
        await parse(response);
      };
      if(single) {
        await send(ops,()=>api.client.request(API+'/sobjects/'+first.objectName+'/'+first.recordId,{method:'PATCH',body:first.changes,headers:{...duplicateHeaders,'If-Unmodified-Since':new Date(first.baseline.LastModifiedDate).toUTCString()},retry:false}),()=>remember([rowResult(first,{success:true})]));
      } else if (body.allowDuplicates === true) {
        for (const group of groups) {
          const compositeRequest = this.graph(group).graphs[0].compositeRequest.map(sub => ({...sub,httpHeaders:duplicateHeaders}));
          await send(group,()=>api.client.request(API+'/composite',{method:'POST',body:{allOrNone:true,compositeRequest},retry:false}),async response=>{
            const rows=response?.compositeResponse;
            if(!Array.isArray(rows)||rows.length!==compositeRequest.length||compositeRequest.some(sub=>rows.filter(row=>row.referenceId===sub.referenceId&&Number.isInteger(row.httpStatusCode)).length!==1))fail('Salesforce returned incomplete duplicate-override results.','upload-outcome-unknown',409);
            await remember(this.parse(group,{graphs:[{graphId:'canvas',isSuccessful:rows.every(row=>row.httpStatusCode>=200&&row.httpStatusCode<300),graphResponse:{compositeResponse:rows}}]}));
          });
        }
      } else {
        let offset = 0;
        for(const batch of graphBatches) {
          const graphs=batch.map((group,i)=>({...this.graph(group).graphs[0],graphId:'g'+(offset+i)}));
          await send(batch.flat(),()=>api.client.request(API+'/composite/graph',{method:'POST',body:{graphs},headers:duplicateHeaders,retry:false}),async response=>{
            if(!Array.isArray(response?.graphs))fail('Salesforce returned an incomplete transaction response.','upload-outcome-unknown',409);
            let incomplete=response.graphs.length!==graphs.length;
            for(let i=0;i<graphs.length;i++) {
              const matches=response.graphs.filter(g=>g.graphId===graphs[i].graphId);
              if(matches.length!==1){incomplete=true;continue;}
              try { await remember(this.parse(batch[i],{graphs:[{...matches[0],graphId:'canvas'}]})); }
              catch(error) { if(error.code==='upload-outcome-unknown'){incomplete=true;continue;} throw error; }
            }
            if(incomplete)fail('Some Graph results are unknown. Confirmed results were retained; further writes stopped. Check Salesforce before uploading these records again.','upload-outcome-unknown',409);
          });
          offset += batch.length;
        }
      }
      const deletions=ops.filter(o=>o.mode==='delete');
      if(deletions.length) {
        // Match the hosted Graph route: do not delete when all preceding writes rolled back.
        if(groups.length && !pending.completed.some(r=>!['delete','unchanged'].includes(r.mode)&&r.success)) {
          await remember(deletions.map(op=>rowResult(op,{success:false,errorCode:'DELETE_SKIPPED_GRAPH_FAILED',error:'Skipped because no create/update group committed.'})));
        } else {
          const byTemp=new Map(deletions.map(op=>[op.tempId,op]));
          const results=await executeUploadDeletes({
            records:deletions.map(op=>({...op,sfId:op.recordId})),
            getDescribe:name=>api.describe(name,{permissionsOnly:true}),
            conn:{sobject:name=>({retrieve:async(ids,{fields})=>{
              const data=await api.query('SELECT '+fields.join(',')+' FROM '+name+' WHERE Id IN ('+ids.map(id=>"'"+id+"'").join(',')+')');
              if(data.done===false)throw new Error('Incomplete deletion relationship metadata.');
              return data.records;
            }})},
            deleteRecord:async record=>{
              const op=byTemp.get(record.tempId);
              // Recheck after earlier Graph/deletion automation, immediately before each DELETE.
              try { api.assertActive(); await this.checkVersions([op]); }
              catch(error) { const row=rowResult(op,{success:false,errorCode:error.code||'DELETE_PREFLIGHT_FAILED',error:error.message}); await remember([row]); return row; }
              await send([op],()=>api.client.request(API+'/sobjects/'+op.objectName+'/'+op.recordId,{method:'DELETE',retry:false}),()=>remember([rowResult(op,{success:true})]));
              return pending.completed.find(r=>r.tempId===op.tempId);
            }
          });
          await remember(results.map(row=>({...row,mode:'delete'})));
        }
      }
      const rows=pending.completed;
      const response = this.response(rows, pending.graphCount), receipt = { fingerprint, response };
      // Store confirmed outcomes before the next read or clearing the guard.
      pending.state = 'confirmed'; pending.receipt = receipt;
      await api.secrets.store(api.pendingKey, JSON.stringify(pending));
      await api.secrets.store(key, JSON.stringify(receipt));
      await api.secrets.delete(api.pendingKey);
      return this.canonical(response);
    } finally { api.uploading = false; api.client.desktopUploadInProgress = false; }
  }
  async status(id) {
    const api = this.api; api.assertActive(); attempt(id);
    const raw = await api.secrets.get(this.receiptKey(id));
    if (raw) {
      const receipt=JSON.parse(raw), response = receipt.response;
      if(receipt.retired)return {...response,status:'retired',retryableTempIds:[],unknownTempIds:receipt.unknownTempIds || []};
      // Completed receipts (including older versions) cover every dispatched
      // operation. Missing rows were skipped by planning, never sent to Salesforce.
      return { ...response, unreportedRecordsNotSubmitted:true, retryableTempIds: [...response.results, ...response.deletes].filter(r => !r.success).map(r => r.tempId) };
    }
    const pending = await this.readPending();
    if(pending) {
      if(pending.version===3 && pending.attemptId===id) return { ...this.response(pending.completed||[],pending.graphCount), atomicSuccess:false, retryableTempIds:[], status:'unconfirmed', unknownTempIds:pending.inFlight||[] };
    }
    return { results: [], retryableTempIds: [], status: 'unconfirmed' };
  }
  async checkPending() {
    const api = this.api; api.assertActive();
    if (api.uploading) fail('Wait for the upload to finish.');
    const pending = await this.readPending();
    if (!pending) return 'There is no unconfirmed upload.';
    if ([2,3].includes(pending.version) && pending.state === 'confirmed') {
      await api.secrets.store(this.receiptKey(pending.attemptId), JSON.stringify(pending.receipt));
      await api.secrets.delete(api.pendingKey);
      return 'The confirmed upload result was recovered locally. Reopen Upload to reconcile the canvas.';
    }
    if(pending.version===3 && pending.state==='ready' && !pending.inFlight.length) {
      const known=new Map(pending.completed.map(row=>[row.tempId,row]));
      const rows=pending.operations.map(op=>known.get(op.tempId)||rowResult(op,{success:false,errorCode:'UPLOAD_NOT_ATTEMPTED',error:'Not submitted: the upload stopped before this operation.'}));
      const receipt={fingerprint:pending.fingerprint,response:this.response(rows,pending.graphCount)};
      await api.secrets.store(this.receiptKey(pending.attemptId),JSON.stringify(receipt));
      await api.secrets.delete(api.pendingKey);
      return 'Confirmed partial results were recovered. Remaining operations were not submitted. Reopen Upload to reconcile the canvas.';
    }
    return 'This upload remains blocked because its outcome is unknown. ' + (pending.version===3 ? (pending.completed||[]).filter(r=>r.success).length+' earlier successes are recorded locally. ' : '') + 'Inspect the selected records in Salesforce before recovery. No retry was sent; new-record IDs cannot safely be inferred from matching names.';
  }
}
module.exports = { Uploads };
