const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function renderHtml({ root, resource, cspSource, state, identity, recovery, preferences, managedRecovery=false }) {
  const nonce = crypto.randomBytes(24).toString('base64');
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'media/scripts.json'), 'utf8')).filter(p => !identity || !['/js/mock-data.js', '/js/mock-sf.js', '/extension/seed.js'].includes(p));
  const script = p => `<script nonce="${nonce}" src="${escape(resource(p))}" defer></script>`;
  const serialized = JSON.stringify(state || null).replaceAll('<', '\\u003c');
  const safeIdentity = identity && Object.fromEntries(['orgId','userId','username','displayName','timeZone','instanceUrl','orgName','orgType'].map(key => [key, identity[key]]));
  const connectionLabel = identity ? identity.username || 'Salesforce user' : 'Sample canvas';
  const bootScripts=[identity ? '/extension/live-bootstrap.js' : '/extension/bootstrap.js', ...scripts.flatMap(p => identity && p==='/js/app.js' ? [...['script.js','managed-features.js','excluded-features.js','files.js','import-guard.js','migration.js','record-paste.js','platform.js'].map(n=>'/extension/'+n),p] : [p]), '/extension/ready.js'];
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${escape(cspSource)}; style-src ${escape(cspSource)} 'unsafe-inline'; img-src ${escape(cspSource)} data: blob:; font-src ${escape(cspSource)}; connect-src 'none'; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none';">
<link rel="stylesheet" href="${escape(resource('/css/app.css'))}">
<link rel="stylesheet" href="${escape(resource('/extension/prototype.css'))}">
<script nonce="${nonce}">${identity ? 'window.__ORGLOOM_LIVE_IDENTITY__=' + JSON.stringify(safeIdentity).replaceAll('<', '\\u003c') : 'window.__ORGLOOM_INITIAL_STATE__=' + serialized};</script>
${identity ? `<script nonce="${nonce}">window.__ORGLOOM_RECOVERY__=${JSON.stringify(managedRecovery ? null : recovery || null).replaceAll('<', '\\u003c')};window.ORGLOOM_DESKTOP_PREFERENCES=${JSON.stringify({ dismissed: preferences?.dismissed === true, completed: preferences?.completed === true })};</script>` : ''}
${managedRecovery ? `<script nonce="${nonce}">window.__ORGLOOM_BOOT_SCRIPTS__=${JSON.stringify(bootScripts.map(resource)).replaceAll('<','\\u003c')};</script>` + script('/extension/recovery-bootstrap.js') : bootScripts.map(script).join('\n')}
</head><body class="canvas-page">
<div id="desktop-toolbar-staging" hidden>
<button id="prototype-fit" class="batch-btn" type="button" title="Fit all records into view">Fit canvas</button>
<span class="desktop-org-controls">${identity ? '<details class="desktop-account-menu"><summary class="batch-btn" title="' + escape(connectionLabel) + '"><span class="desktop-org-name' + (identity.orgType === 'production' ? ' desktop-org-name--production' : '') + '">' + (identity.orgType === 'production' ? 'PRODUCTION: ' : '') + escape(connectionLabel) + '</span><span aria-hidden="true">▾</span></summary><div class="desktop-account-options"><button id="prototype-disconnect" class="batch-btn" type="button">Disconnect</button></div></details>' : '<span class="desktop-org-name">Sample canvas</span><button id="prototype-reset" class="batch-btn" type="button">Reset sample</button>'}</span>
</div>
${identity ? '<span id="desktop-recovery-status" role="status" hidden></span>' : ''}
<main class="app-main"><div id="app-root"></div></main>
<div id="prototype-status" role="status">Opening canvas…</div>
</body></html>`;
}
module.exports = { renderHtml };
