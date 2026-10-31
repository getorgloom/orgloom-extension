(() => {
  'use strict';
  const host = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, setState() {} };
  const saved = window.__ORGLOOM_INITIAL_STATE__;
  delete window.__ORGLOOM_INITIAL_STATE__;
  window.__ORGLOOM_RESTORED_SAMPLE__ = !!saved;
  // This prototype owns a dedicated webview origin. Only fictional demo storage
  // is restored, never the user's hosted-app profile, tokens, cookies, or files.
  for (const [kind, storage] of [['local', localStorage], ['session', sessionStorage]]) {
    storage.clear();
    for (const [key, value] of Object.entries(saved?.[kind] || {})) storage.setItem(key, value);
  }
  Object.assign(window, {
    SF_ORG_ID: '00DDEMO00000000AAA', SF_USER_ID: '005DEMO00000000AAA',
    SF_USER_NAME: 'Demo User', SF_USER_TIME_ZONE: 'America/Phoenix',
    SF_INSTANCE_URL: null, ORGLOOM_ACCOUNT_ID: 'playground',
    ORGLOOM_SF_CONNECTED: true, ORGLOOM_HAS_DOCS: false,
    ORGLOOM_CANVAS_PATH: '/', ORGLOOM_MOCK: true,
    ORGLOOM_MCP_ACTIVE: false, ORGLOOM_SENTRY_DSN: null, ORGLOOM_ENV: 'prototype',
  });
  // mock-sf captures this fail-closed fetch. Unhandled requests cannot escape to
  // the network; CSP independently blocks fetch, sockets, frames and workers.
  window.fetch = async () => { throw new Error('Network access is disabled in the local prototype.'); };
  const forbidStream = function () { throw new Error('Live connections are disabled in the local prototype.'); };
  window.WebSocket = forbidStream;
  window.EventSource = forbidStream;
  navigator.sendBeacon = () => false;
  window.open = () => null;
  let previous = '';
  function save() {
    const state = { version: 1, local: {}, session: {} };
    for (const [kind, storage] of [['local', localStorage], ['session', sessionStorage]]) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith('orgloom') || key?.startsWith('org-loom')) state[kind][key] = storage.getItem(key);
      }
    }
    const json = JSON.stringify(state);
    if (json !== previous && json.length <= 2 * 1024 * 1024) {
      previous = json;
      host.setState({ version: 1 });
      host.postMessage({ type: 'save-sample', state });
    }
  }
  setInterval(save, 750);
  addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', save);
  document.addEventListener('click', event => {
    const target = event.target.closest?.('a,button,input');
    if (target?.id === 'prototype-reset') host.postMessage({ type: 'reset-sample' });
    if (target?.matches('a[href], input[type=file]')) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('drop', event => {
    if (event.dataTransfer?.files?.length) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
})();
