'use strict';
const { API, SalesforceError } = require('./salesforce.cjs');
const { buildRecordSearch, validateSoqlFilterField, formatSoqlFieldLiteral } = require('./sf-soql.cjs');
const { parseSoqlImportQuery, flattenSoqlImportResults } = require('./soql-import-results.cjs');
const { mask, denied } = require('./soql-policy.cjs');
const CAP = 500;
const validId = value => typeof value === 'string' && /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/.test(value);
const literal = value => "'" + String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
const fail = message => { throw new SalesforceError(message, 'invalid-query'); };

function compileFilter(desc, filter) {
  const check = validateSoqlFilterField(desc, filter?.field);
  if (!check.ok) fail(check.message);
  const field = check.field, op = filter.op, value = filter.value;
  if (op === 'isNull' || op === 'isNotNull') return `${field.name} ${op === 'isNull' ? '=' : '!='} null`;
  let formatted, operators = ['equals', 'notEquals'];
  if (['int', 'long', 'double', 'currency', 'percent'].includes(field.type)) {
    try { formatted = formatSoqlFieldLiteral(value, field.type); } catch { fail('Enter a valid number for ' + field.name + '.'); }
    operators.push('gt', 'gte', 'lt', 'lte');
  } else if (field.type === 'date' || field.type === 'datetime') {
    const text = String(value || '');
    if (field.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail('Enter a valid date.');
      formatted = text;
    } else {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) fail('Enter a valid date and time.');
      formatted = new Date(text).toISOString();
    }
    operators.push('before', 'after');
  } else if (field.type === 'boolean') {
    if (![true, false, 'true', 'false', 0, 1, '0', '1'].includes(value)) fail('Enter a valid boolean.');
    formatted = [true, 'true', 1, '1'].includes(value) ? 'true' : 'false'; operators = ['equals'];
  } else if (field.type === 'id' || field.type === 'reference') {
    if (!validId(value)) fail('Enter a valid Salesforce record ID.');
    formatted = literal(value);
  } else if (['picklist', 'combobox'].includes(field.type) && op === 'in') {
    if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(v => typeof v !== 'string' || v.length > 1000)) fail('Select between 1 and 100 picklist values.');
    return `${field.name} IN (${value.map(literal).join(', ')})`;
  } else if (['string', 'textarea', 'phone', 'url', 'email', 'encryptedstring', 'picklist', 'combobox'].includes(field.type)) {
    if (typeof value !== 'string' || value.length > 1000) fail('Enter text of at most 1,000 characters.');
    if (['contains', 'startsWith'].includes(op) && !['picklist', 'combobox'].includes(field.type)) {
      const text = value.replaceAll('%', '\\%').replaceAll('_', '\\_');
      return `${field.name} LIKE ${literal((op === 'contains' ? '%' : '') + text + '%')}`;
    }
    formatted = literal(value);
  }
  if (!formatted || !operators.includes(op)) fail('Unsupported filter operator for ' + field.name + '.');
  const symbol = { equals: '=', notEquals: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', before: '<', after: '>' }[op];
  return `${field.name} ${symbol} ${formatted}`;
}

class RecordReads {
  constructor(api) { this.api = api; }
  async name(value) {
    if (denied.has(String(value).toLowerCase()) || /__(?:b|e|x)$/i.test(value)) fail('Import supports business records, not setup, event, external, or big objects.');
    return this.api.metadata.name(value);
  }
  // Follow only native query locators, never arbitrary URLs returned in a response.
  async collect(soql, limit) {
    let page = await this.api.query(soql);
    const totalSize = page.totalSize, records = [], seen = new Set();
    while (true) {
      this.api.assertActive();
      if (!Array.isArray(page.records) || page.records.some(row => !validId(row?.Id))) fail('Salesforce did not return record IDs.');
      records.push(...page.records.slice(0, limit - records.length));
      if (page.done !== false || records.length >= limit) return { records, totalSize, done: page.done !== false };
      const next = page.nextRecordsUrl, prefix = API + '/query/';
      if (typeof next !== 'string' || !next.startsWith(prefix) || !/^[A-Za-z0-9-]+$/.test(next.slice(prefix.length)) || seen.has(next) || !page.records.length) fail('Invalid Salesforce query continuation.');
      seen.add(next); page = await this.api.client.request(next);
    }
  }
  async count(soql) {
    const result = await this.api.query(soql);
    if (!Number.isSafeInteger(result.totalSize) || result.totalSize < 0) fail('Salesforce returned an invalid record count.');
    return result.totalSize;
  }
  async browse(body) {
    const name = await this.name(body.objectName), desc = await this.api.describe(name, { permissionsOnly: true });
    const filters = body.filters ?? [];
    if (!Array.isArray(filters) || filters.length > 12) fail('Use at most 12 filters.');
    const limit = body.limit ?? 25, offset = body.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 2000) fail('Browse supports pages of 1–200 records through offset 2,000. Narrow your search or use SOQL for later records.');
    let search;
    try { search = !body.search && !desc.fields.some(f => f.nameField) ? { nameField: 'Id', searchFields: ['Id'], clause: '' } : buildRecordSearch(desc, name, body.search); } catch (error) { fail(error.message); }
    const clauses = filters.map(f => compileFilter(desc, f));
    if (search.clause) clauses.push(search.clause);
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const fields = [...new Set(['Id', search.nameField, ...search.searchFields, ...filters.map(f => f.field)])].filter(Boolean);
    const sort = body.sort?.field || search.nameField || 'Id';
    if (!desc.fields.some(f => f.name === sort && f.sortable) || (body.sort?.direction && !['asc', 'desc'].includes(body.sort.direction))) fail('Choose a sortable field.');
    const order = ` ORDER BY ${sort} ${body.sort?.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST` + (sort === 'Id' ? '' : ', Id ASC');
    const count = await this.count(`SELECT COUNT() FROM ${name}${where}`);
    const onCanvas = body.onCanvasIds ?? [];
    if (!Array.isArray(onCanvas) || onCanvas.length > 1000 || onCanvas.some(v => !validId(v))) fail('Invalid on-canvas record IDs.');
    let loadableCount = count;
    if (count && onCanvas.length) loadableCount = Math.max(0, count - await this.count(`SELECT COUNT() FROM ${name}${where}${where ? ' AND' : ' WHERE'} Id IN (${onCanvas.map(literal).join(',')})`));
    const previewSoql = `SELECT ${fields.join(', ')} FROM ${name}${where}${order} LIMIT ${limit} OFFSET ${offset}`;
    const records = count > offset ? (await this.collect(previewSoql, limit)).records : [];
    return { count, loadableCount, records, hasMore: count > offset + records.length, previewFields: fields, previewSoql, loadSoql: `SELECT Id FROM ${name}${where}${order}`, limit, offset };
  }
  async importQuery(body) {
    let soql = typeof body.soql === 'string' ? body.soql.trim() : '';
    if (!/^SELECT\b/i.test(soql) || soql.length > 20000) fail('Provide a SELECT query of at most 20,000 characters.');
    const unquoted = soql.replace(/'(?:\\.|[^'\\])*'/g, text => ' '.repeat(text.length));
    if (/;|\/\*|\*\/|--|\b(?:FOR|ALL\s+ROWS|WITH|GROUP\s+BY|HAVING|TYPEOF)\b/i.test(unquoted)) fail('Use a read-only record query without comments, aggregates, or locking clauses.');
    let plan;
    try { plan = parseSoqlImportQuery(soql); } catch (error) { fail(error.message); }
    const describes = new Map();
    const describe = async name => {
      name = await this.name(name);
      if (!describes.has(name)) describes.set(name, await this.api.describe(name, { permissionsOnly: true }));
      return describes.get(name);
    };
    const resolve = async (node, desc) => {
      const skeleton = mask(node.soql), from = /\bFROM\s+(\w+)/i.exec(skeleton);
      if (!from || /\b(?:COUNT|SUM|AVG|MIN|MAX|COUNT_DISTINCT)\b/i.test(skeleton.slice(0, from.index))) fail('Return record rows, including Id, instead of aggregates.');
      node.objectName = desc.name; node.fieldNames = new Set(desc.fields.map(f => f.name));
      for (const filter of node.filters || []) {
        const filterFrom = /\bFROM\s+(\w+)/i.exec(mask(filter.soql));
        if (!filterFrom) fail('The semi-join needs a FROM object.');
        await resolve(filter, await describe(filterFrom[1]));
      }
      for (const child of node.children) {
        const childFrom = /\bFROM\s+(\w+)/i.exec(mask(child.soql));
        const rel = desc.childRelationships?.find(r => r.relationshipName?.toLowerCase() === childFrom?.[1]?.toLowerCase());
        if (!rel) fail('Use a described child relationship in SELECT subqueries.');
        child.relationship = rel;
        await resolve(child, await describe(rel.childSObject));
      }
    };
    const skeleton = mask(soql), from = /\bFROM\s+(\w+)/i.exec(skeleton);
    if (!from) fail('The query needs a FROM object.');
    const desc = await describe(from[1]); await resolve(plan, desc);
    const outerLimit = /\bLIMIT\s+(\d+)\b/i.exec(skeleton);
    if (outerLimit) soql = soql.slice(0, outerLimit.index) + 'LIMIT ' + Math.min(CAP + 1, Number(outerLimit[1])) + soql.slice(outerLimit.index + outerLimit[0].length);
    else {
      const offset = /\bOFFSET\b/i.exec(skeleton);
      soql = offset ? soql.slice(0, offset.index) + `LIMIT ${CAP + 1} ` + soql.slice(offset.index) : soql + ` LIMIT ${CAP + 1}`;
    }
    // Retain the desktop convenience of supplying the root Id automatically.
    if (!/(?:^|,)\s*Id\s*(?:,|$)/i.test(skeleton.slice(6, from.index))) soql = soql.replace(/^SELECT\s+/i, 'SELECT Id, ');
    const data = await this.collect(soql, CAP + 1);
    let flattened;
    try { flattened = flattenSoqlImportResults(data.records, plan, CAP); } catch (error) { fail(error.message); }
    const { records, associations } = flattened;
    // Preserve the numeric temporary-ID contract of the desktop adapter.
    for (const record of records) record.tempId = Number(record.tempId.slice(1));
    for (const edge of associations) { edge.fromTempId = Number(edge.fromTempId.slice(1)); edge.toTempId = Number(edge.toTempId.slice(1)); }
    // Four reads at a time. Stage baselines until every record has loaded, and
    // never replace a baseline belonging to a record already on the canvas.
    const staged = new Map();
    for (let i = 0; i < records.length; i += 4) {
      await Promise.all(records.slice(i, i + 4).map(async record => {
        this.api.assertActive();
        const full = await this.api.retrieve(record.objectName, record.loadedFromId, false);
        staged.set(record.objectName + ':' + record.loadedFromId, full);
        if (body.fullFields !== false) { record.values = { ...full }; delete record.values.attributes; }
      }));
    }
    this.api.assertActive();
    for (const [key, record] of staged) if (!this.api.baselines.has(key)) this.api.baselines.set(key, structuredClone(record));
    return { objectName: desc.name, records, associations, totalSize: data.totalSize, returned: records.length, capped: flattened.capped || !data.done, cap: CAP, truncated: flattened.capped || !data.done, fullFields: body.fullFields !== false };
  }
}
module.exports = { RecordReads, compileFilter };
