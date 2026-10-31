'use strict';
const { SalesforceError } = require('./salesforce.cjs');
const { compileFilter } = require('./record-reads.cjs');
const fail = message => { throw new SalesforceError(message, 'invalid-migration'); };

// Destination-only reads. Source IDs never identify destination records and
// migration itself never writes. The normal upload boundary owns all writes.
async function matchRecords(api, body) {
  const name = await api.reads.name(body.objectName);
  const desc = await api.describe(name, { permissionsOnly: true });
  const field = desc.fields.find(f => f.name === body.keyField && f.filterable);
  if (!field || !['string','email','phone','url','textarea','int','double','currency','percent'].includes(field.type)) fail('Choose an accessible text or number match field. Source IDs cannot identify destination records.');
  const values = body.values;
  if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(v => !['string','number'].includes(typeof v) || String(v).length > 255)) fail('Match between 1 and 100 text or number values, at most 255 characters each.');
  const title = desc.fields.find(f => f.nameField)?.name || 'Id';
  const predicates = [...new Set(values)].map(value => compileFilter(desc, { field: field.name, op: 'equals', value }));
  const query = `SELECT ${[...new Set(['Id', field.name, title])].join(', ')} FROM ${name} WHERE (${predicates.join(' OR ')}) LIMIT 501`;
  const { records, done } = await api.reads.collect(query, 501);
  if (!done || records.length > 500) fail('Too many destination matches. Choose a more specific match field.');
  const candidatesByValue = Object.create(null);
  for (const row of records) {
    const key = String(row[field.name]);
    (candidatesByValue[key] ||= []).push({ id: row.Id, label: row[title] || row.Id, details: [] });
  }
  api.assertActive();
  return { candidatesByValue };
}
module.exports = { matchRecords };
