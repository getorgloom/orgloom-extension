'use strict';
const { SalesforceError } = require('./salesforce.cjs');
const { formatSoqlFieldLiteral, normalizeSoqlFieldValue } = require('./sf-soql.cjs');
const fail = message => { throw new SalesforceError(message, 'invalid-upsert'); };
function externalKey(desc, record) {
  const field = desc.fields.find(f => f.name === record._csvExternalIdField);
  if (!field?.externalId || !field.filterable || !field.createable || !field.updateable || field.calculated || field.encrypted) fail('Choose an accessible, writable External ID field for ' + desc.name + '.');
  const raw = record.values?.[field.name];
  if (!['string','number'].includes(typeof raw) || String(raw).trim()==='' || String(raw).length>1000) fail('Every upsert needs a nonempty External ID value.');
  let value;
  try { value=normalizeSoqlFieldValue(raw,field.type); } catch { fail('Invalid External ID value for ' + field.name + '.'); }
  if (value==='.' || value==='..' || /[\x00-\x1f]/.test(value)) fail('Unsupported External ID value.');
  return { field:field.name, value, type:field.type, caseSensitive:field.caseSensitive===true };
}
async function matchUpsert(api, objectName, external) {
  const data=await api.query('SELECT Id FROM '+objectName+' WHERE '+external.field+' = '+formatSoqlFieldLiteral(external.value,external.type)+' LIMIT 2');
  if(!Array.isArray(data.records) || data.done===false || data.records.length>1) fail('The External ID matches multiple records. Resolve the duplicates before uploading.');
  const id=data.records[0]?.Id;
  if(id && !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(id)) fail('Salesforce returned an invalid upsert match.');
  return id || null;
}
module.exports={externalKey,matchUpsert};
