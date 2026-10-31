'use strict';
const { API, SalesforceError } = require('./salesforce.cjs');
const validId = value => typeof value === 'string' && /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/.test(value);
const literal = value => "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";

// All relationship reads share a four-operation queue, including speculative
// canvas prefetch. Metadata is reused only within a single count batch.
class RelatedRecords {
  constructor(api) { this.api = api; this.running = 0; this.queue = []; }
  schedule(work) {
    return new Promise((resolve, reject) => {
      this.queue.push({ work, resolve, reject });
      this.drain();
    });
  }
  drain() {
    while (this.running < 4 && this.queue.length) {
      const job = this.queue.shift(); this.running++;
      Promise.resolve().then(() => { this.api.assertActive(); return job.work(); })
        .then(value => { this.api.assertActive(); job.resolve(value); }, job.reject)
        .catch(job.reject).finally(() => { this.running--; this.drain(); });
    }
  }
  async prepare(name, field, recordId, cache = new Map()) {
    if (!validId(recordId)) throw new SalesforceError('Invalid related record ID.');
    name = await this.api.metadata.name(name);
    if (!cache.has(name)) cache.set(name, this.api.describe(name, { permissionsOnly: true }));
    const desc = await cache.get(name);
    const ref = desc.fields.find(f => f.name === field);
    if (!ref || ref.type !== 'reference' || !ref.filterable || ref.deprecatedAndHidden) {
      throw new SalesforceError('This relationship is not available for filtering.', 'unsupported-relationship');
    }
    return { name, desc, where: `${ref.name} = ${literal(recordId)}` };
  }
  async count(name, field, recordId, cache) {
    const prepared = await this.prepare(name, field, recordId, cache);
    this.api.assertActive();
    const data = await this.api.query(`SELECT COUNT() FROM ${prepared.name} WHERE ${prepared.where}`);
    if (!Number.isSafeInteger(data.totalSize) || data.totalSize < 0) throw new SalesforceError('Salesforce returned an invalid related count.', 'invalid-response', 502);
    return { count: data.totalSize };
  }
  async counts(probes) {
    if (!Array.isArray(probes) || probes.length > 200 || probes.some(p => !p || typeof p.name !== 'string' || typeof p.field !== 'string' || !validId(p.id))) {
      throw new SalesforceError('Provide at most 200 valid relationship probes.');
    }
    const cache = new Map(), unique = new Map();
    const counts = await Promise.all(probes.map(p => {
      const key = JSON.stringify([p.name, p.field, p.id]);
      if (!unique.has(key)) unique.set(key, this.schedule(async () => {
        try { return { ...p, ...await this.count(p.name, p.field, p.id, cache) }; }
        catch (error) {
          // Some discoverable Salesforce child objects cannot be queried this
          // way. Skip those independently; authentication/transport errors fail.
          if (!(error instanceof SalesforceError) || ![400, 403, 404].includes(error.status) || ['active-org-changed', 'reauth-required'].includes(error.code)) throw error;
          return { name: p.name, field: p.field, id: p.id, count: 0, skipped: true, reason: error.code };
        }
      }));
      return unique.get(key);
    }));
    return { counts };
  }
  async records(name, params, search = false) {
    const prepared = await this.prepare(name, params.get('field'), params.get('id'));
    name = prepared.name;
    const fields = prepared.desc.fields;
    const nameField = fields.find(f => f.nameField)?.name || 'Id';
    const searchFields = fields.filter(f => (f.name === nameField || (name === 'Case' && f.name === 'Subject')) && f.filterable && ['string', 'textarea', 'email', 'phone', 'url'].includes(f.type));
    const q = (params.get('q') || '').trim();
    if (q.length > 150) throw new SalesforceError('Related search is limited to 150 characters.');
    let where = prepared.where;
    if (search && q) {
      if (!searchFields.length) throw new SalesforceError('This object has no searchable name field.', 'unsupported-relationship');
      const escaped = q.replaceAll('%', '\\%').replaceAll('_', '\\_');
      where += ' AND (' + searchFields.map(f => `${f.name} LIKE ${literal('%' + escaped + '%')}`).join(' OR ') + ')';
    }
    const requested = params.has('limit') ? Number(params.get('limit')) : search ? 20 : 50;
    if (!Number.isSafeInteger(requested) || requested < 1) throw new SalesforceError('Invalid related record limit.');
    const limit = Math.min(requested, search ? 50 : 200);
    const selected = [...new Set(['Id', ...(search ? [nameField, ...searchFields.map(f => f.name)] : fields.filter(f => !['address', 'location'].includes(f.type) && !f.deprecatedAndHidden).map(f => f.name))])];
    this.api.assertActive();
    let page = await this.api.query(`SELECT ${selected.join(', ')} FROM ${name} WHERE ${where} LIMIT ${limit}`);
    const records = [], seenPages = new Set();
    while (true) {
      this.api.assertActive();
      if (!Array.isArray(page.records) || page.records.some(r => !validId(r?.Id))) throw new SalesforceError('Salesforce returned invalid related records.', 'invalid-response', 502);
      records.push(...page.records.slice(0, limit - records.length));
      if (page.done !== false || records.length >= limit) break;
      const next = page.nextRecordsUrl;
      if (typeof next !== 'string' || !next.startsWith(API + '/query/') || !/^[A-Za-z0-9-]+$/.test(next.slice((API + '/query/').length)) || seenPages.has(next) || !page.records.length) throw new SalesforceError('Invalid Salesforce query continuation.', 'invalid-response', 502);
      seenPages.add(next);
      page = await this.api.client.request(next);
    }
    if (search) return { records: records.map(r => ({ id: r.Id, name: String(r.Subject || r[nameField] || r.Id) })), nameField };
    // Background prefetch must not replace an existing canvas upload baseline.
    for (const record of records) {
      const key = name + ':' + record.Id;
      if (!this.api.baselines.has(key)) this.api.baselines.set(key, structuredClone(record));
    }
    return { records, limit };
  }
}
module.exports = { RelatedRecords };
