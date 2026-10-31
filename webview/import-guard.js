// Ported from the native UI; all data operations use the local desktop adapter.
(function () {
  'use strict';

  function assertImportSource(payload, currentOrg) {
    if (!payload || typeof payload !== 'object') throw Error('Invalid canvas file.');
    const meta = payload._meta || {};
    if (meta.migration || meta.forMigration || meta.purpose === 'migration') {
      throw Error('Use a normal exported JSON canvas file for destination migration reconciliation. Your canvas has not changed.');
    }
    const origins = [meta.savedFrom, meta.exportedFrom].filter(Boolean);
    if (origins.some(origin => typeof origin !== 'string' || origin.slice(0, 15) !== String(currentOrg).slice(0, 15))) {
      throw Error('This file belongs to another Salesforce org. Export a normal JSON canvas file from the source org to start destination reconciliation. Your canvas has not changed.');
    }
    const records = [...(payload.records || []), ...(payload.loadedRecords || []), ...(payload.drafts || [])];
    if (records.length && !origins.length) {
      throw Error('This file does not identify its source org. Export it again from the original org before importing. Your canvas has not changed.');
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { assertImportSource };
  if (typeof window === 'undefined') return;

  async function requireImport() {
    const response = await window.fetch('/api/capabilities/bulk-edit-records/check', { method: 'POST' });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw Error(error.message || 'Your administrator must enable bulk editing to import files.');
    }
  }

  // Wrap public module seams, leaving the pinned serializers, parsers, mapping
  // dialogs and undo logic unchanged. Validate before they replace canvas state.
  const originalTemplates = window.OrgLoom.templates.mount;
  window.OrgLoom.templates.mount = function (deps) {
    const api = originalTemplates(deps);
    for (const name of ['validateTemplate', 'validateCanvasPayload']) {
      const original = api[name];
      api[name] = function (payload, ...args) {
        if(window.OrgLoomDesktopMigration?.isMigration(payload)&&name==='validateTemplate')return original.call(this,payload,...args);
        assertImportSource(payload, window.SF_ORG_ID);
        return original.call(this, payload, ...args);
      };
    }
    for (const name of ['applyTemplate', 'applyCanvasPayload']) {
      const original = api[name];
      api[name] = async function (payload, options, ...args) {
        if(window.OrgLoomDesktopMigration?.isMigration(payload)&&name==='applyTemplate')return window.OrgLoomDesktopMigration.start(payload,options,(ready,opts)=>original.call(this,ready,opts,...args),deps.beginImportLoad);
        assertImportSource(payload, window.SF_ORG_ID);
        if (options?.importFileName) await requireImport();
        return original.call(this, payload, options, ...args);
      };
    }
    return api;
  };

  const originalCsv = window.OrgLoom.linkedCsv.mount;
  window.OrgLoom.linkedCsv.mount = function (deps) {
    const api = originalCsv(deps), open = api.openModal;
    api.openModal = async function (...args) {
      try { await requireImport(); return open.apply(this, args); }
      catch (error) { deps.showBulkToast(error.message, 'error'); }
    };
    return api;
  };
})();
