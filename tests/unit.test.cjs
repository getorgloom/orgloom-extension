const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { renderHtml } = require('../src/html.cjs');
const { validateState, MAX_BYTES } = require('../src/state.cjs');

test('webview denies network and host execution while loading only bundled assets', () => {
  const html = renderHtml({ root: path.resolve(__dirname, '..'), cspSource: 'https://local.vscode-cdn.net', resource: p => `https://local.vscode-cdn.net${p}`, state: null });
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /worker-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.doesNotMatch(html, /unsafe-eval/);
  assert.doesNotMatch(html, /sentry-cdn|posthog|mcp-relay-client|playground-bridge/);
  assert.match(html, /\/js\/app.js/);
  assert.match(html, /\/js\/mock-sf.js/);
  assert.ok(html.indexOf('/extension/bootstrap.js') < html.indexOf('/js/mock-sf.js'));
  assert.ok(html.indexOf('/js/mock-sf.js') < html.indexOf('/js/app.js'));
});

test('persisted sample content cannot escape the bootstrap script', () => {
  const html = renderHtml({ root: path.resolve(__dirname, '..'), cspSource: 'local:', resource: p => p, state: { version: 1, local: { 'orgloom.test': '</script><script>attack()</script>' }, session: {} } });
  assert.doesNotMatch(html, /<script>attack/);
  assert.match(html, /\\u003c\/script>/);
});

test('storage bridge accepts only bounded namespaced string data', () => {
  assert.deepEqual(validateState({ version: 1, local: { 'orgloom.sample': '{}' }, session: {} }), { version: 1, local: { 'orgloom.sample': '{}' }, session: {} });
  for (const input of [null, [], { version: 2 }, { version: 1, local: { unrelated: 'secret' }, session: {} }, { version: 1, local: { 'orgloom.sample': {} }, session: {} }, { version: 1, local: { 'orgloom.large': 'x'.repeat(MAX_BYTES) }, session: {} }]) assert.equal(validateState(input), null);
});

test('connected shell excludes mock scripts and never serializes tokens or sample recovery', () => {
  const html = renderHtml({ root: path.resolve(__dirname, '..'), cspSource: 'local:', resource: p => p,
    identity: { orgId: 'test', userId: 'user', username: '<test>@example.com', orgName: 'Test Org', accessToken: 'DO-NOT-INCLUDE', refreshToken: 'DO-NOT-INCLUDE' },
    state: { local: { 'orgloom.sample': 'DO-NOT-INCLUDE' } } });
  assert.match(html, /live-bootstrap.js/);
  assert.doesNotMatch(html, /mock-sf.js|mock-data.js|extension\/seed.js|DO-NOT-INCLUDE/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /<summary class="batch-btn" title="&lt;test&gt;@example.com"><span class="desktop-org-name">&lt;test&gt;@example.com<\/span>/);
});
