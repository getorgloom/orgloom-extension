'use strict';
const { API, SalesforceError } = require('./salesforce.cjs');
const { OrgMetadata } = require('./metadata.cjs');
const { RelatedRecords } = require('./related.cjs');
const { Uploads } = require('./uploads.cjs');
const { DesktopScripts } = require('./scripts.cjs');
const { RecordReads } = require('./record-reads.cjs');
const { matchRecords } = require('./migration.cjs');
const { buildRecordSearch } = require('./sf-soql.cjs');
const CAPABILITIES = Object.freeze({ 'browse-records': true, 'soql-import': true, 'upload-records': true, 'bulk-edit-records': true, 'save-canvas': false, 'open-saved-canvas': false, 'share-canvas': false, 'create-slot-canvas': false, 'run-script': true, 'auto-fill-records': true, 'generate-records-with-ai': false, 'ai-edit-on-canvas': false, 'recall-upload': false, 'export-canvas': true, 'export-records': true });
const id = value => typeof value === 'string' && /^(?:[a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})$/.test(value);
const literal = value => "'" + String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
function validateMessage(message) {
  if (!message || message.type !== 'live-api' || !Number.isSafeInteger(message.id) || message.id < 1 || typeof message.path !== 'string' || message.path.length > 12000 || !['GET', 'POST'].includes(message.method)) throw new SalesforceError('Invalid canvas request.');
  if (!message.path.startsWith('/api/') || message.path.includes('\\') || message.path.includes('#') || message.path.includes('..')) throw new SalesforceError('Unsupported canvas resource.');
  if (JSON.stringify(message).length > (message.path.startsWith('/api/desktop/files/') ? 20 : 2) * 1024 * 1024) throw new SalesforceError('Canvas request is too large.');
  const url = new URL(message.path, 'https://extension.invalid');
  if (url.origin !== 'https://extension.invalid') throw new SalesforceError('External URLs are not accepted.');
  return url;
}
class LiveApi {
  constructor(client, { confirmUpload, secrets, files }) {
    this.scripts = new DesktopScripts(); this.files = files; this.client = client; this.metadata = new OrgMetadata(client); this.confirmUpload = confirmUpload; this.secrets = secrets;
    this.baselines = new Map(); this.uploading = false; this.active = true;
    this.related = new RelatedRecords(this);
    this.reads = new RecordReads(this);
    this.uploader = new Uploads(this);
    const identity = client.publicIdentity();
    this.orgId = identity.orgId; this.userId = identity.userId;
    this.pendingKey = `salesforce.desktop.pending.${this.orgId}.${this.userId}`;
  }
  dispose() { this.active = false; this.scripts.dispose(); this.baselines.clear(); this.metadata.clear(); }
  assertActive() {
    const who = this.client.publicIdentity();
    if (!this.active || who?.orgId !== this.orgId || who?.userId !== this.userId) throw new SalesforceError('Canvas connection changed. Reopen the Salesforce canvas.', 'active-org-changed', 403);
  }
  query(soql) { return this.client.request(API + '/query?q=' + encodeURIComponent(soql)); }
  describe(name, options) { return this.metadata.describe(name, options); }
  async retrieve(name, recordId, remember = true) {
    name = await this.metadata.name(name); if (!id(recordId)) throw new SalesforceError('Invalid record ID.');
    const record = await this.client.request(API + '/sobjects/' + name + '/' + recordId);
    if (!record || !id(record.Id)) throw new SalesforceError('Salesforce did not return a record.');
    if (remember) this.baselines.set(name + ':' + recordId, structuredClone(record));
    return record;
  }
  importQuery(body) { return this.reads.importQuery(body); }
  async access(records) {
    if (!Array.isArray(records) || records.length > 200 || records.some(r => !id(r.sfId))) throw new SalesforceError('Invalid access-check records.');
    if (!records.length) return { results: [] };
    const data = await this.query(`SELECT RecordId, HasReadAccess, HasEditAccess, HasDeleteAccess FROM UserRecordAccess WHERE UserId = ${literal(this.userId)} AND RecordId IN (${records.map(r => literal(r.sfId)).join(',')})`);
    return { results: records.map(r => { const access = data.records?.find(a => a.RecordId.slice(0,15) === r.sfId.slice(0,15)); return { tempId: r.tempId, sfId: r.sfId, access: { checked: true, hasReadAccess: access?.HasReadAccess === true, hasEditAccess: access?.HasEditAccess === true, hasDeleteAccess: access?.HasDeleteAccess === true } }; }) };
  }
  upload(body) { return this.uploader.upload(body); }
  checkPending() { return this.uploader.checkPending(); }
  async route(message) {
    const url = validateMessage(message); this.assertActive();
    const p = url.pathname, body = message.body || {}, identity = this.client.publicIdentity();
    if (message.method === 'GET') {
      if (p === '/api/me') return { account: { id: 'desktop', displayName: identity.displayName }, connection: { id: 'desktop-test', sfOrgId: identity.orgId, sfUserId: identity.userId, instanceUrl: identity.instanceUrl, orgType: identity.orgType || 'sandbox' }, capabilities: CAPABILITIES, orgType: identity.orgType || 'sandbox' };
      if (p === '/api/me/capabilities') return { capabilities: CAPABILITIES };
      if (p === '/api/objects') return this.metadata.objects();
      if (p === '/api/ai/status') return { enabled: false, available: false };
      if (p === '/api/limits') return this.client.request(API + '/limits');
      if (p === '/api/workspaces') return { workspaces: [] };
      if (p === '/api/upload-batches') return { batches: [] };
      const attemptMatch = /^\/api\/upload-attempts\/([A-Za-z0-9_-]+)$/.exec(p);
      if (attemptMatch) return this.uploader.status(attemptMatch[1]);
      const related = /^\/api\/objects\/(\w+)\/(related-count|by-ref|by-ref-search)$/.exec(p);
      if (related) return this.related.schedule(() => related[2] === 'related-count'
        ? this.related.count(related[1], url.searchParams.get('field'), url.searchParams.get('id'))
        : this.related.records(related[1], url.searchParams, related[2] === 'by-ref-search'));
      const match = /^\/api\/objects\/(\w+)\/(describe|graph|layout|validation-rules|records\/([A-Za-z0-9]+)|search|lookup)$/.exec(p);
      if (match) {
        const name = await this.metadata.name(match[1]), action = match[2];
        if (match[3]) return this.retrieve(name, match[3]);
        if (action === 'validation-rules') return this.metadata.validationRules(name);
        const desc = await this.describe(name);
        if (action === 'layout') return this.metadata.layout(name, url.searchParams, desc);
        if (action === 'describe') return desc;
        if (action === 'graph') return this.metadata.graph(name, desc);
        let target = name, targetDesc = desc;
        if (action === 'lookup') {
          const field = desc.fields.find(f => f.name === url.searchParams.get('fieldName') && f.type === 'reference');
          target = url.searchParams.get('targetApiName') || field?.referenceTo?.[0];
          if (!field?.referenceTo?.includes(target)) throw new SalesforceError('Invalid lookup target.');
          target = await this.metadata.name(target);
          targetDesc = await this.describe(target, { permissionsOnly: true });
        }
        let search;
        try { search = buildRecordSearch(targetDesc, target, url.searchParams.get('q')); }
        catch (error) { throw new SalesforceError(error.message, error.code || 'invalid-search'); }
        const nameField = search.nameField || 'Id';
        const clauses = search.clause ? ['(' + search.clause + ')'] : [];
        const sourceId = action === 'lookup' && url.searchParams.get('sourceRecordId');
        if (sourceId && !id(sourceId)) throw new SalesforceError('Invalid source record ID.');
        if (sourceId) clauses.push('Id != ' + literal(sourceId));
        const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
        const rows = (await this.reads.collect('SELECT ' + [...new Set(['Id',nameField,...search.searchFields])].join(', ') + ' FROM ' + target + where + ' LIMIT 20', 20)).records;
        return { nameField, searchFields: search.searchFields, records: rows.map(r => ({ id: r.Id, name: String(r[nameField] || r.Id), title: String(r.Subject || r[nameField] || r.Id), apiName: target })) };
      }
    }
    if (message.method === 'POST') {
      if (p === '/api/migrate/match') return matchRecords(this, body);
      if (p === '/api/desktop/record-link') {
        if (!id(body.recordId)) throw new SalesforceError('Invalid record ID.');
        const objects = (await this.metadata.objects()).filter(o => o.keyPrefix === body.recordId.slice(0, 3));
        if (objects.length !== 1) throw new SalesforceError('This record type is unavailable.');
        return this.importQuery({ soql: 'SELECT Id FROM ' + objects[0].name + ' WHERE Id = ' + literal(body.recordId), fullFields: true });
      }
      const feature = /^\/api\/capabilities\/(bulk-edit-records|run-script|auto-fill-records)\/check$/.exec(p);
      if (feature) return { allowed: true };
      if(p === '/api/desktop/script/cancel') return this.scripts.cancel(body.id);
      if(p === '/api/desktop/script/run') {
        try { return await this.scripts.run(body); } catch(error) { throw new SalesforceError(error.message,'script-failed'); }
      }
      const fileAction = /^\/api\/desktop\/files\/(open|save)$/.exec(p);
      if (fileAction && this.files) return this.files.run(fileAction[1], body);
      if (p === '/api/capabilities/export-records/check' || p === '/api/capabilities/export-canvas/check') return { allowed: true };
      if (p === '/api/related-counts') return this.related.counts(body.probes);
      if (p === '/api/query') return this.importQuery(body);
      if (p === '/api/records/access') return this.access(body.records);
      if (p === '/api/records/refresh') {
        if (!Array.isArray(body.records) || body.records.length > 200 || body.records.some(r => !r || !id(r.sfId) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(r.objectName))) throw new SalesforceError('Invalid refresh list.');
        const results = [];
        const staged = new Map();
        for (const row of body.records) {
          this.assertActive();
          const identity = { objectName: row.objectName, sfId: row.sfId, tempId: row.tempId };
          try {
            const values = await this.retrieve(row.objectName, row.sfId, false);
            staged.set(row.objectName + ':' + row.sfId, values);
            results.push({ ...identity, ok: true, values });
          } catch (error) {
            // Permission/missing-record failures are local to a row. Authentication,
            // throttling and transport errors abort without advancing any baselines.
            if (!(error instanceof SalesforceError) || ![403,404].includes(error.status) || ['REQUEST_LIMIT_EXCEEDED','active-org-changed','reauth-required'].includes(error.code)) throw error;
            staged.set(row.objectName + ':' + row.sfId, null);
            results.push({ ...identity, ok: false, values: null, error: 'Record unavailable' });
          }
        }
        this.assertActive();
        for (const [key, value] of staged) value ? this.baselines.set(key, value) : this.baselines.delete(key);
        return { results };
      }
      if (p === '/api/upload/access-check') return { ok: true };
      if (p === '/api/upload' || p === '/api/upload/graph' || p === '/api/upload/bulk') return this.upload(body);
      if (p === '/api/audit-event') return { ok: true, persisted: false };
      if (p === '/api/browse') return this.reads.browse(body);
    }
    throw new SalesforceError('This operation is not implemented in the connected desktop prototype.', 'not-implemented', 501);
  }
  async handle(message) {
    try { const data = await this.route(message); this.assertActive(); return { status: 200, data }; }
    catch (error) { return { status: error instanceof SalesforceError ? error.status : 502, data: { error: error instanceof SalesforceError ? error.code : 'salesforce-request-failed', message: error instanceof SalesforceError ? error.message : 'The Salesforce request failed. No automatic retry was sent.', ...(error instanceof SalesforceError && error.code === 'salesforce-records-changed' && Array.isArray(error.conflicts) ? {conflicts:error.conflicts} : {}) } }; }
  }
}
module.exports = { LiveApi, validateMessage, CAPABILITIES };
