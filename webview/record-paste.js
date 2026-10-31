// Ported from the native UI; all data operations use the local desktop adapter.
(function () {
  'use strict';

  function parseRecordLink(value, origins) {
    if (typeof value !== 'string' || value.length > 16384) return null;
    const text = value.trim();
    if (!/^(https?:\/\/|\/)/i.test(text) || /\s/.test(text)) return null;
    let url;
    try { url = new URL(text, origins[0]); } catch { return null; }
    if (!origins.includes(url.origin) || url.username || url.password) {
      return { error: 'Use a record link from the Salesforce org connected to this canvas.' };
    }
    const match = /^\/lightning\/r\/(?:[A-Za-z][A-Za-z0-9_]*\/)?([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)\/(?:view|edit)\/?$/.exec(url.pathname)
      || /^\/([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)\/?$/.exec(url.pathname);
    return match ? { recordId: match[1] } : { error: 'Copy a link to an individual Salesforce record.' };
  }

  function mount(deps) {
    const identity = window.ORGLOOM_DESKTOP_IDENTITY;
    const origins = [identity.lightningOrigin, new URL(identity.instanceUrl).origin];
    let busy = false;
    let copiedCardsToken = null;
    const permitted = () => deps.canEdit() && !deps.loading();
    const sameId = (a, b) => !!a && !!b && String(a).slice(0, 15) === String(b).slice(0, 15);
    function canvasTarget(event) {
      return deps.canvasState.graphView === 'bulk'
        && !event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),.modal,[role="dialog"]')
        && !document.querySelector('.modal:not(.hidden)');
    }
    function select(record) {
      deps.canvasState.bulkSelectedIds = new Set([record.id]);
      deps.canvasState.bulkSelectedEdgeId = null;
      deps.render();
    }
    async function add(recordId) {
      if (busy) { deps.toast('Wait for the current record to finish loading.', 'info'); return; }
      if (!permitted()) { deps.toast('Only the canvas owner or an editor can add records here.', 'error'); return; }
      const records = deps.canvasState.bulkRecords;
      const canvas = deps.canvas();
      const current = () => permitted() && deps.canvas() === canvas && deps.canvasState.bulkRecords === records;
      busy = true;
      try {
        const response = await window.fetch('/api/desktop/record-link', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordId }),
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.message || result.error || 'Record unavailable.');
        if (!current()) throw Error('The canvas changed while loading. Paste the record link again.');
        const loaded = result.records?.[0];
        if (!loaded) throw Error('Record unavailable.');
        const existing = records.find(r => !r.isTypeNode && sameId(r.loadedFromId, loaded.loadedFromId));
        if (existing) { select(existing); deps.toast('This record is already on the canvas. Your edits were kept.'); return; }
        const summary = await deps.commit(result, { focusImported: true, canCommit: current });
        if (summary.blocked) throw Error('The canvas record limit has been reached.');
        deps.toast('Record added from Salesforce. Unsaved edits in its Salesforce tab are not included.');
      } catch (error) {
        deps.toast(error.message || 'Unable to add this record.', 'error');
      } finally { busy = false; }
    }
    // Use the browser's user-initiated clipboard events; no clipboard-read permission
    // or background clipboard access. The marker contains no Salesforce data.
    document.addEventListener('copy', event => {
      if (!canvasTarget(event) || !event.clipboardData || !deps.canvasState.bulkSelectedIds?.size) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString()) return;
      if (!deps.copyCards() || !deps.canvasState.bulkClipboard?.records?.length) return;
      copiedCardsToken = 'orgloom-canvas-selection:' + window.crypto.randomUUID();
      event.clipboardData.setData('text/plain', copiedCardsToken);
      event.preventDefault();
    });
    document.addEventListener('paste', async event => {
      if (!canvasTarget(event) || !event.clipboardData || event.clipboardData.files?.length) return;
      const text = event.clipboardData.getData('text/plain').trim();
      if (copiedCardsToken && text === copiedCardsToken) {
        event.preventDefault();
        if (permitted()) await deps.pasteCards();
        else deps.toast('Only the canvas owner or an editor can add records here.', 'error');
        return;
      }
      const link = parseRecordLink(text, origins);
      if (!link) return;
      event.preventDefault();
      if (link.error) { deps.toast(link.error, 'error'); return; }
      await add(link.recordId);
    });
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseRecordLink, mount };
  if (typeof window !== 'undefined') window.OrgLoomDesktopPaste = { mount };
})();
