(() => {
  'use strict';
  if (!window.ORGLOOM_DESKTOP_LIVE) return;
  const features = {
    save: { title: 'Save canvases', description: 'Saving canvases in Salesforce is available only in the Org Loom managed package version. Install Org Loom in your Salesforce org to save and reopen canvases directly in Org Loom.' },
    share: { title: 'Share canvases', description: 'Sharing canvases with teammates is available only in the Org Loom managed package version. Install Org Loom in your Salesforce org to share canvases with other Salesforce users.' },
    recall: { title: 'Upload Recall', description: 'Upload Recall is available only in the Org Loom managed package version. Install Org Loom in your Salesforce org to review and reverse eligible changes uploaded through Org Loom.' },
  };
  function showFeature(feature, trigger) {
    if (document.getElementById('desktop-managed-feature')) return;
    const copy = features[feature], dialog = document.createElement('dialog');
    dialog.id = 'desktop-managed-feature';
    dialog.className = 'desktop-managed-feature';
    dialog.setAttribute('aria-labelledby', 'desktop-managed-title');
    dialog.setAttribute('aria-describedby', 'desktop-managed-description');
    dialog.innerHTML = '<div class="modal-header"><h3 id="desktop-managed-title"></h3></div><div class="modal-content"><p id="desktop-managed-description"></p></div><div class="modal-footer"><button class="button secondary" type="button" data-managed-close>Close</button><a class="button" href="https://orgloom.com/" target="_blank" rel="noopener noreferrer">Visit orgloom.com</a></div>';
    dialog.querySelector('h3').textContent = copy.title;
    dialog.querySelector('p').textContent = copy.description;
    dialog.querySelector('[data-managed-close]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
    document.body.append(dialog);
    dialog.showModal();
  }
  // Intercept before the shared handlers; these capabilities stay disabled in the host.
  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('[data-bulk-save-primary], [data-desktop-managed-save], [data-bulk-share], [data-app-history]');
    if (!trigger) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const menuSave = trigger.hasAttribute('data-desktop-managed-save');
    if (menuSave) document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
    showFeature(trigger.matches('[data-bulk-share]') ? 'share' : trigger.matches('[data-app-history]') ? 'recall' : 'save', menuSave ? document.querySelector('[data-bulk-save]') : trigger);
  }, true);
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
    if (event.target.closest?.('input,textarea,[contenteditable="true"]') || document.querySelector('[data-editor-element="insert-form"]')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    showFeature('save', document.querySelector('[data-bulk-save]'));
  }, true);
})();
