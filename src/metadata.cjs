'use strict';
const { API, SalesforceError } = require('./salesforce.cjs');
const validId = value => /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/.test(value || '');
const apiName = value => /^[A-Za-z][A-Za-z0-9_]*$/.test(value || '');

// One instance per canvas connection. Nothing here is written to disk.
class OrgMetadata {
  constructor(client) { this.client = client; this.directory = null; }
  clear() { this.directory = null; }
  async objects() {
    if (!this.directory) {
      this.directory = this.client.request(API + '/sobjects/').then(data => {
        if (!Array.isArray(data.sobjects)) throw new SalesforceError('Salesforce did not return an object directory.');
        return data.sobjects.filter(o => apiName(o.name) && o.queryable && !o.deprecatedAndHidden);
      }).catch(error => { this.directory = null; throw error; });
    }
    return this.directory;
  }
  async name(value) {
    if (!apiName(value)) throw new SalesforceError('Invalid object API name.', 'unsupported-object');
    const found = (await this.objects()).find(o => o.name.toLowerCase() === value.toLowerCase());
    if (!found) throw new SalesforceError('This object is not available for queries in the connected org.', 'unsupported-object', 403);
    return found.name;
  }
  async optional(path) {
    try { return await this.client.request(API + path); }
    catch (error) {
      // Unsupported UI API resources can use REST describe. Do not disguise
      // expired authentication, rate limits or transport failures as metadata.
      if (error instanceof SalesforceError && [400, 403, 404].includes(error.status)) return null;
      throw error;
    }
  }
  async picklists(name, recordTypeId) {
    if (!validId(recordTypeId)) return null;
    const data = await this.optional(`/ui-api/object-info/${name}/picklist-values/${recordTypeId}`);
    return data?.picklistFieldValues || null;
  }
  async validationRules(value) {
    const name = await this.name(value);
    const query = soql => this.client.request(API + '/tooling/query?q=' + encodeURIComponent(soql));
    try {
      const index = await query(`SELECT Id FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${name}' LIMIT 201`);
      if (!Array.isArray(index.records) || index.records.length > 200 || index.done === false) {
        return { unavailable: true, reason: 'Validation-rule metadata exceeds the desktop limit of 200 rules. Salesforce still validates uploads.' };
      }
      const ids = [...new Set(index.records.map(r => r.Id))];
      if (ids.some(id => !validId(id))) throw new SalesforceError('Invalid validation-rule metadata.');
      const rules = []; let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (next < ids.length) {
          const id = ids[next++];
          // Tooling permits Metadata only when the query identifies one row.
          const detail = await query(`SELECT Id, FullName, Metadata FROM ValidationRule WHERE Id = '${id}' LIMIT 1`);
          const row = detail.records?.[0], m = row?.Metadata;
          if (row?.Id !== id || !m) throw new SalesforceError('Incomplete validation-rule metadata.');
          if (m.active === true) rules.push({ id, name: m.name || row.FullName?.split('.').slice(1).join('.'), active: true, description: m.description, errorMessage: m.errorMessage, errorDisplayField: m.errorDisplayField, formula: m.errorConditionFormula });
        }
      }));
      return rules.sort((a,b) => (a.name || '').localeCompare(b.name || ''));
    } catch (error) {
      if (error instanceof SalesforceError && [400,403,404].includes(error.status)) return { unavailable:true, reason:'Salesforce does not provide validation-rule metadata to this connection. Salesforce still validates uploads.' };
      throw error;
    }
  }
  async describe(value, { permissionsOnly = false } = {}) {
    const name = await this.name(value);
    const raw = await this.client.request(API + `/sobjects/${name}/describe`);
    const info = permissionsOnly ? null : await this.optional(`/ui-api/object-info/${name}`);
    const recordTypes = Object.values(info?.recordTypeInfos || raw.recordTypeInfos || {}).filter(r => r.available).map(r => ({
      id: r.recordTypeId, name: r.name, label: r.name, available: true,
      developerName: r.developerName || raw.recordTypeInfos?.find(v => v.recordTypeId === r.recordTypeId)?.developerName,
      isDefault: r.defaultRecordTypeMapping === true || r.recordTypeId === info?.defaultRecordTypeId,
    }));
    const fields = (raw.fields || []).filter(f => !info?.fields || info.fields[f.name]).map(f => ({
      ...f,
      createable: f.createable === true && info?.fields?.[f.name]?.createable !== false,
      updateable: f.updateable === true && info?.fields?.[f.name]?.updateable !== false,
      required: f.createable === true && !f.nillable && !f.defaultedOnCreate && !f.calculated && !f.autoNumber,
      controllerName: info?.fields?.[f.name]?.controllingFields?.[0] || f.controllerName || null,
      picklistValues: (f.picklistValues || []).filter(v => v.active !== false),
    }));
    // Bound concurrency even for orgs with many record types.
    if (info && fields.some(f => /^(multi)?picklist$/.test(f.type))) {
      for (let i = 0; i < recordTypes.length; i += 3) {
        await Promise.all(recordTypes.slice(i, i + 3).map(async rt => {
          const values = await this.picklists(name, rt.id);
          if (!values) return;
          for (const field of fields) {
            const entry = values[field.name];
            if (!entry) continue;
            (field.picklistValuesByRecordType ||= {})[rt.id] = (entry.values || []).map(v => ({ ...v, active: true, defaultValue: v.value === entry.defaultValue?.value }));
            (field.controllerValuesByRecordType ||= {})[rt.id] = entry.controllerValues || {};
          }
        }));
      }
    }
    return { ...raw, fields, recordTypes, defaultRecordTypeId: info?.defaultRecordTypeId || recordTypes.find(r => r.isDefault)?.id || null };
  }
  async layout(name, params, desc) {
    const recordId = params.get('recordId'), requestedType = params.get('recordTypeId');
    if ((recordId && !validId(recordId)) || (requestedType && !validId(requestedType))) throw new SalesforceError('Invalid layout record or record type ID.');
    let data;
    if (recordId) {
      data = await this.optional(`/ui-api/record-ui/${recordId}?layoutTypes=Full&modes=Edit`);
      if (!data) data = await this.optional(`/ui-api/record-ui/${recordId}?layoutTypes=Full&modes=View`);
    } else {
      const mode = params.get('mode') === 'view' ? 'View' : 'Create';
      data = await this.optional(`/ui-api/layout/${name}?layoutType=Full&mode=${mode}${requestedType ? '&recordTypeId=' + requestedType : ''}`);
    }
    if (!data) return { available: false, sections: [], reason: 'Salesforce UI API does not provide a layout for this object and user. Showing accessible fields from describe.' };
    const record = data.records?.[recordId] || Object.values(data.records || {})[0] || data.record;
    if (record?.apiName && record.apiName !== name) throw new SalesforceError('The layout record belongs to another object.');
    const recordTypeId = requestedType || record?.recordTypeId || record?.fields?.RecordTypeId?.value || data.recordTypeId || desc.defaultRecordTypeId;
    const layouts = data.layouts?.[name];
    const full = (layouts?.[recordTypeId] || Object.values(layouts || {})[0])?.Full;
    let layout = full?.Edit || full?.View || data.layout || data;
    if (recordId && requestedType && requestedType !== record?.recordTypeId) {
      layout = await this.optional(`/ui-api/layout/${name}?layoutType=Full&mode=Edit&recordTypeId=${requestedType}`);
      if (!layout) return { available: false, sections: [], reason: 'Salesforce did not provide the selected record type layout.' };
    }
    if (!Array.isArray(layout.sections)) return { available: false, sections: [], reason: 'Salesforce returned no usable field layout.' };
    const byName = new Map(desc.fields.map(f => [f.name, f]));
    const sections = layout.sections.map(s => ({ heading: s.heading, columns: s.columns || 2, collapsible: s.collapsible, rows: (s.layoutRows || []).map(row => (row.layoutItems || []).map(item => {
      const names = (item.layoutComponents || []).filter(c => c.componentType === 'Field' && byName.has(c.apiName)).map(c => c.apiName);
      if (!names.length) return null;
      const f = byName.get(names[0]);
      return { apiName: names[0], ...(names.length > 1 ? { apiNames: names } : {}), label: item.label || f.label, required: !!item.required || f.required, editableForNew: item.editableForNew !== false && f.createable, editableForUpdate: item.editableForUpdate !== false && f.updateable };
    }).filter(Boolean)).filter(row => row.length) })).filter(s => s.rows.length);
    const info = data.objectInfos?.[name] || data.objectInfo;
    const fieldPerms = Object.fromEntries(desc.fields.map(f => [f.name, { createable: f.createable && info?.fields?.[f.name]?.createable !== false, updateable: f.updateable && info?.fields?.[f.name]?.updateable !== false }]));
    const rawPicklists = await this.picklists(name, recordTypeId);
    const picklistValues = Object.fromEntries(Object.entries(rawPicklists || {}).filter(([key]) => byName.has(key)).map(([key, entry]) => [key, { ...entry, defaultValue: entry.defaultValue?.value ?? null }]));
    return { available: sections.length > 0, sections, columns: layout.columns || 2, recordTypeId, fieldPerms, picklistValues, picklistValuesRecordTypeId: recordTypeId, defaults: {} };
  }
  async graph(name, desc) {
    const objects = new Map((await this.objects()).map(o => [o.name, o]));
    return { name, label: desc.label,
      parents: desc.fields.filter(f => f.type === 'reference').flatMap(f => (f.referenceTo || []).filter(o => objects.has(o)).map(o => ({ object: o, label: objects.get(o).label, field: f.name, fieldLabel: f.label, required: f.required, createable: f.createable, updateable: f.updateable }))),
      children: (desc.childRelationships || []).filter(r => objects.has(r.childSObject) && r.field).map(r => ({ object: r.childSObject, label: objects.get(r.childSObject).label, field: r.field, relationshipName: r.relationshipName })),
    };
  }
}
module.exports = { OrgMetadata };
