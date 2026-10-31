(() => {
  'use strict';
  const host = window.__ORGLOOM_HOST__ || acquireVsCodeApi();
  const identity = window.__ORGLOOM_LIVE_IDENTITY__;
  delete window.__ORGLOOM_LIVE_IDENTITY__;
  const origin = new URL(identity.instanceUrl);
  window.ORGLOOM_DESKTOP_IDENTITY = { ...identity, lightningOrigin: origin.origin.replace(/\.my\.salesforce\.com$/, '.lightning.force.com') };
  window.OrgLoomDesktopPreference = flag => {
    if (!['dismissed', 'completed'].includes(flag)) return;
    (window.ORGLOOM_DESKTOP_PREFERENCES ||= {})[flag] = true;
    host.postMessage({ type: 'onboarding-preference', flag });
  };
  // Live record values never go into the prototype's plaintext recovery store.
  // Existing canvas storage APIs use memory maps, checkpointed to encrypted host storage.
  const recovered = window.__ORGLOOM_RECOVERY__;
  delete window.__ORGLOOM_RECOVERY__;
  const storageMaps = {}, recoveryKeys = key => /^(orgloom:canvas-draft|orgloom:migration|orgloom:org-switch)/.test(key);
  function checkpoint() {
      const state = { version:1, local:{}, session:{} };
      for (const kind of ['local','session']) for (const [key,value] of storageMaps[kind] || []) if (recoveryKeys(key)) state[kind][key]=value;
      host.postMessage({ type:'save-recovery', state });
  }
  function memoryStorage(kind) {
    const map = new Map(Object.entries(recovered?.[kind] || {})); storageMaps[kind] = map;
    return { get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
      getItem: key => map.get(String(key)) ?? null, setItem: (key, value) => { map.set(String(key), String(value)); if(recoveryKeys(String(key)))checkpoint(); },
      removeItem: key => { map.delete(String(key)); if(recoveryKeys(String(key)))checkpoint(); }, clear: () => { map.clear(); checkpoint(); } };
  }
  Object.defineProperty(window, 'localStorage', { value: memoryStorage('local'), configurable: false });
  Object.defineProperty(window, 'sessionStorage', { value: memoryStorage('session'), configurable: false });
  // The desktop host enforces recovery age; the browser runtime's two-hour
  // session-storage policy must not prematurely discard an encrypted checkpoint.
  window.OrgLoom = window.OrgLoom || {};
  window.OrgLoom.recoveryStorage = { getItem:key=>sessionStorage.getItem(key), setItem:(key,value)=>sessionStorage.setItem(key,value), removeItem:key=>sessionStorage.removeItem(key), clear:()=>sessionStorage.clear(), prune:()=>{} };
  Object.assign(window, { SF_ORG_ID: identity.orgId, SF_USER_ID: identity.userId, SF_USER_NAME: identity.displayName,
    SF_USER_TIME_ZONE: identity.timeZone, ORGLOOM_DESKTOP_ORG_TYPE: identity.orgType, SF_INSTANCE_URL: identity.instanceUrl, ORGLOOM_ACCOUNT_ID: 'desktop',
    ORGLOOM_SF_CONNECTED: true, ORGLOOM_HAS_DOCS: false, ORGLOOM_CANVAS_PATH: '/', ORGLOOM_MOCK: false,
    ORGLOOM_MCP_ACTIVE: false, ORGLOOM_SENTRY_DSN: null, ORGLOOM_ENV: 'desktop-test', ORGLOOM_DESKTOP_LIVE: true });
  let sequence = 0;
  const pending = new Map();
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input?.url;
    if (typeof raw !== 'string' || !raw.startsWith('/api/') || raw.startsWith('//')) throw new Error('Only supported canvas operations can reach the local Salesforce adapter.');
    const method = (init.method || input?.method || 'GET').toUpperCase();
    let body;
    if (init.body !== undefined) {
      if (typeof init.body !== 'string' || init.body.length > (raw.startsWith('/api/desktop/files/') ? 20 : 2) * 1024 * 1024) throw new Error('Unsupported request body.');
      body = JSON.parse(init.body);
    }
    const id = ++sequence;
    const reply = await new Promise((resolve, reject) => {
      if (pending.size >= 64) { reject(new Error('Too many pending requests.')); return; }
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Request timed out. For uploads, check the last upload before retrying.')); }, /^\/api\/upload(?:\/(?:graph|bulk))?$/.test(raw) ? 900000 : 180000);
      pending.set(id, { resolve, timeout });
      host.postMessage({ type: 'live-api', id, path: raw, method, body });
    });
    // The pinned upsert UI expects SSE; execution still uses the bounded local Graph adapter.
    if (raw === '/api/upload/bulk' && reply.status === 200) return new Response('event: complete\ndata: '+JSON.stringify(reply.data)+'\n\n', {status:200,headers:{'Content-Type':'text/event-stream'}});
    return new Response(JSON.stringify(reply.data), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  };
  addEventListener('message', event => {
    const reply = event.data;
    if (reply?.type === 'recovery-status') {
      const label = document.getElementById('desktop-recovery-status');
      if(label) { label.hidden = !reply.error; label.textContent = reply.error ? 'Recovery failed: ' + reply.error : ''; label.title = reply.error || ''; }
      return;
    }
    if (reply?.type !== 'live-api-result') return;
    const entry = pending.get(reply.id);
    if (!entry) return;
    clearTimeout(entry.timeout); pending.delete(reply.id); entry.resolve(reply);
  });
  window.WebSocket = window.EventSource = function () { throw new Error('Live collaboration is not enabled.'); };
  navigator.sendBeacon = () => false;
  window.open = url => { if (navigator.userActivation?.isActive) host.postMessage({ type:'open-external', url:String(url) }); return null; };
  document.addEventListener('click', event => {
    const target = event.target.closest?.('a,button,input');
    if (target?.id === 'prototype-disconnect') host.postMessage({ type: 'disconnect-test-org' });
    if (target?.matches('a[href]')) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.isTrusted && /^https:\/\//.test(target.href)) host.postMessage({ type:'open-external', url:target.href });
    }
  }, true);
  document.addEventListener('drop', event => { if (event.dataTransfer?.files?.length) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
})();
