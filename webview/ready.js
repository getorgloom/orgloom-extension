(() => {
  // Files enter the extension through the native file picker only. Do not let
  // shared browser drop handlers advertise or accept unsupported file drops.
  for (const type of ['dragenter', 'dragover', 'drop']) {
    document.addEventListener(type, event => {
      const transfer = event.dataTransfer;
      if (!transfer || (!Array.from(transfer.types || []).includes('Files') && !transfer.files?.length)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      transfer.dropEffect = 'none';
    }, true);
  }
  const filePickerCopy = [
    ['Drop a saved-canvas JSON file here', 'Choose a saved-canvas JSON file'],
    ['Drop CSV files here', 'Choose CSV files'],
    ['or click to select', 'Click to browse'],
    ['Drop CSVs above or click to choose.', 'Choose CSV files above.'],
    ['drop a .csv file with a header row.', 'choose a .csv file with a header row.'],
  ];
  if(window.__ORGLOOM_RECOVERY_NOTICE__){
    const notice=document.createElement('div');notice.id='desktop-recovery-notice';notice.setAttribute('role','status');notice.textContent=window.__ORGLOOM_RECOVERY_NOTICE__;notice.style.cssText='position:fixed;bottom:42px;right:20px;z-index:10000;max-width:480px;max-height:32vh;overflow:auto;white-space:pre-line;padding:10px 14px;border-radius:5px;background:#44391f;color:#fff';document.body.append(notice);delete window.__ORGLOOM_RECOVERY_NOTICE__;
  }
  const status = document.getElementById('prototype-status');
  // Keep these nodes (and their listeners) across shared toolbar rerenders.
  const fitButton = document.getElementById('prototype-fit');
  const orgControls = document.querySelector('.desktop-org-controls');
  const accountMenu = orgControls?.querySelector('.desktop-account-menu');
  document.addEventListener('click', event => {
    if (accountMenu && (!accountMenu.contains(event.target) || event.target.closest?.('#prototype-disconnect'))) accountMenu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && accountMenu?.open) {
      accountMenu.open = false;
      accountMenu.querySelector('summary').focus();
    }
  });
  const adapt = () => {
    document.querySelectorAll('#ici-dropzone strong, #ici-dropzone > .tag, #lcsv-dropzone strong, #lcsv-dropzone > .tag, #linked-csv-content p.tag.center, #linked-csv-content .lcsv-notices .banner').forEach(container => {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        let text = node.data;
        for (const [before, after] of filePickerCopy) text = text.replace(before, after);
        if (text !== node.data) node.data = text;
      }
    });
    const jsonPicker = document.getElementById('ici-dropzone');
    if (jsonPicker && jsonPicker.getAttribute('role') !== 'button') jsonPicker.setAttribute('role', 'button');
    const live = window.ORGLOOM_DESKTOP_LIVE === true;
    const toolbar = document.getElementById('subbar-records');
    const spacer = toolbar?.querySelector('.bulk-hint-spacer');
    if (toolbar && spacer) {
      if (fitButton && fitButton.parentNode !== toolbar) toolbar.insertBefore(fitButton, spacer);
      if (orgControls && orgControls.parentNode !== toolbar) toolbar.append(orgControls);
    }
    // Keep the selection count and scope while shortening the full-canvas label.
    if (live) document.querySelectorAll('[data-bulk-upload]').forEach(el => {
      if (el.textContent === 'Upload to Salesforce') el.textContent = 'Upload';
    });
    if (!live) document.querySelectorAll('[data-bulk-upload]').forEach(el => {
      if (el.textContent !== 'Simulate upload') el.textContent = 'Simulate upload';
      el.title = 'Updates fictional demo records only. No Salesforce connection.';
    });
    document.querySelectorAll('[data-bulk-save-primary]').forEach(el => {
      const label = live ? 'Save canvas' : 'Save sample';
      if (el.textContent !== label) el.textContent = label;
      el.disabled = false;
      el.hidden = live;
      if (live) { el.removeAttribute('aria-disabled'); el.removeAttribute('aria-busy'); el.classList.remove('canvas-save-primary--locked'); }
      el.title = live ? 'Salesforce canvas saving is exclusive to the managed-package version. Export a local JSON file from the menu.' : 'Saves fictional records in this extension only.';
    });
    document.querySelectorAll('[data-bulk-op="generate-ai"]').forEach(el => {
      el.disabled = true;
      el.hidden = live;
      el.title = 'Not available in this extension.';
    });
    if (live) {
      document.querySelectorAll('[data-bulk-share]').forEach(el => {
        el.disabled = false; el.hidden = false;
        el.removeAttribute('aria-disabled'); el.removeAttribute('aria-busy');
        el.classList.remove('canvas-share-btn--locked', 'batch-btn-accent');
        if (el.textContent !== 'Share') el.textContent = 'Share';
        el.title = 'Share canvases with the Org Loom managed package';
      });
      document.querySelectorAll('[data-app-history]').forEach(el => {
        el.title = 'Upload Recall (managed package only)';
        el.setAttribute('aria-label', 'Upload Recall (managed package only)');
      });
    }
    document.querySelectorAll('[data-bulk-op="migrate-org"]').forEach(el => { el.disabled = !live; });
    if (live) {
      document.querySelectorAll('[data-bec-action="request"],.bec-doclink').forEach(el => { el.hidden = true; });
      const steps = document.querySelectorAll('.bec-steps > .bec-step');
      if (steps[1] && !steps[1].dataset.desktopCopy) {
        steps[1].dataset.desktopCopy = 'true';
        steps[1].querySelector('.bec-step-title').textContent = 'Edit and review';
        steps[1].querySelector('.bec-step-hint').textContent = 'Prepare changes locally. Encrypted recovery protects checkpoints; export a JSON file to keep a portable copy.';
      }
      document.querySelectorAll('[data-bulk-save]').forEach(el => {
        if (el.textContent !== 'Save / Export ▾') el.textContent = 'Save / Export ▾';
        el.classList.remove('batch-btn-split-arrow');
        el.parentElement?.classList.remove('batch-btn-split', 'canvas-save-control');
        el.title = 'Save canvas or export CSV / JSON';
        el.setAttribute('aria-label', 'Save canvas or export CSV / JSON');
      });
      document.querySelectorAll('.templates-popup [data-tpl-action^="save-"]').forEach(el => {
        el.disabled = false;
        el.removeAttribute('aria-disabled');
        el.title = 'Save canvases with the Org Loom managed package';
        if (!el.dataset.desktopManagedSave) {
          el.dataset.desktopManagedSave = 'true';
          el.innerHTML = 'Save canvas<span class="tpl-action-sub">Available in the managed package</span>';
        }
      });
      // The upstream editor collapses the entire fallback field list when UI
      // API has no layout. Expand it once so unsupported objects stay usable.
      document.querySelectorAll('[data-editor-element="insert-form"]').forEach(form => {
        const sections = form.querySelectorAll('.field-section');
        const section = sections.length === 1 ? sections[0] : null;
        if (section?.dataset.section === 'optional' && !section.dataset.desktopExpanded) {
          section.dataset.desktopExpanded = 'true';
          if (section.classList.contains('collapsed')) section.querySelector('[data-toggle]')?.click();
        }
      });
      document.querySelectorAll('[data-add-menu="request"]').forEach(el => { el.disabled = true; el.hidden = true; });
      const help = document.querySelector('.soql-query-help');
      if (help && !help.dataset.desktopHelp) { help.dataset.desktopHelp = 'true'; help.innerHTML = '<summary>Query help</summary><p>Import up to 500 records from accessible standard or custom objects. Use WHERE, ORDER BY, LIMIT, semi-joins and child relationship subqueries (include Id in each child SELECT). Queries can contain up to 20,000 characters. The cap includes child records; capped results are reported. Aggregates and locking clauses are not supported. Reads go directly to Salesforce.</p>'; }
    }
    if (window.Orgloom?.canvasState && status) status.hidden = true;
  };
  new MutationObserver(adapt).observe(document.body, { childList: true, subtree: true });
  adapt();
})();
