(() => {
  'use strict';
  if (!window.ORGLOOM_DESKTOP_LIVE) return;
  const blobs = new Map(), create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => { const url = create(blob); blobs.set(url, blob); return url; };
  URL.revokeObjectURL = url => { blobs.delete(url); revoke(url); };
  function notice(message) {
    let node = document.getElementById('desktop-file-status');
    if (!node) { node = document.createElement('div'); node.id = 'desktop-file-status'; node.setAttribute('role', 'status'); node.style.cssText = 'position:fixed;bottom:40px;left:20px;z-index:100000;background:#202428;color:#fff;padding:12px;max-width:480px;border:1px solid #777'; document.body.appendChild(node); }
    node.textContent = message;
    clearTimeout(notice.timer); notice.timer = setTimeout(() => node.remove(), 10000);
  }
  async function request(action, body) {
    const result = await fetch('/api/desktop/files/' + action, { method: 'POST', body: JSON.stringify(body) });
    const data = await result.json(); if (!result.ok) throw new Error(data.message || 'File operation failed.'); return data;
  }
  async function choose(input) {
    if (input.dataset.desktopChoosing) return;
    input.dataset.desktopChoosing = 'true';
    try {
      const result = await request('open', { kind: input.accept.includes('json') ? 'json' : 'csv', multiple: input.multiple });
      if (result.cancelled || !input.isConnected) return;
      const transfer = new DataTransfer();
      for (const file of result.files) transfer.items.add(new File([Uint8Array.from(atob(file.base64), c => c.charCodeAt(0))], file.name, { type: file.type }));
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) { notice(error.message); }
    finally { delete input.dataset.desktopChoosing; }
  }
  const inputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type === 'file') { void choose(this); return; } return inputClick.call(this); };
  document.addEventListener('click', event => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'file') { event.preventDefault(); event.stopImmediatePropagation(); void choose(event.target); }
  }, true);
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const blob = blobs.get(this.href), name = this.download;
    if (!blob || !name) return anchorClick.call(this);
    if (blob.size > 10 * 1024 * 1024) { notice('Exports are limited to 10 MB.'); return; }
    // Hold the Blob before the inherited exporter revokes its temporary URL.
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        notice('Choose where to export the file…');
        const result = await request('save', { name, base64: String(reader.result).split(',')[1] });
        notice(result.saved ? 'Exported ' + result.name : 'Export cancelled.');
      } catch (error) { notice(error.message); }
    };
    reader.onerror = () => notice('Could not prepare the export.'); reader.readAsDataURL(blob);
  };
})();
