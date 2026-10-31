'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { SalesforceCli, resolveCli, createCliRunner } = require('../src/salesforce-cli.cjs');
const { SalesforceClient, SESSION_KEY, API } = require('../src/salesforce.cjs');
const ORG = '00D000000000001AAA', USER = '005000000000001AAA';
const account = { username: 'user@example.test', orgId: ORG, instanceUrl: 'https://fixture.my.salesforce.com', alias: 'Test' };
const accessToken = 'old-access-token-in-memory-only';
const cliSession = () => ({ authMode: 'cli', username: account.username, expectedOrgId: ORG, instanceUrl: account.instanceUrl, accessToken });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const secrets = () => { const data = new Map(); return { get: async k => data.get(k), store: async (k, v) => data.set(k, v), delete: async k => data.delete(k) }; };
const identity = (url, { userId = USER, production = false } = {}) => url.endsWith('/userinfo')
  ? json({ organization_id: ORG, user_id: userId, name: 'CLI User' })
  : json({ records: [{ Id: ORG, Name: 'CLI Test Org', IsSandbox: !production, OrganizationType: production ? 'Enterprise Edition' : 'Sandbox' }] });

test('CLI list exposes only safe selection fields, filters invalid entries and deduplicates', async () => {
  const cli = new SalesforceCli({ run: async args => {
    assert.deepEqual(args, ['org', 'list', 'auth']);
    return [{ ...account, accessToken, refreshToken: 'never-expose', sfdxAuthUrl: 'never-expose' }, account,
      { ...account, username: '--target-org=other' }, { ...account, instanceUrl: 'https://evil.test' }];
  } });
  assert.deepEqual(await cli.list(), [account]);
});

test('CLI login passes only validated origin and cancellation, never changes default org', async () => {
  let calls = 0;
  const controller = new AbortController();
  const cli = new SalesforceCli({ run: async (args, opts) => {
    calls++; assert.deepEqual(args, ['org', 'login', 'web', '--instance-url', 'https://test.salesforce.com']);
    assert.equal(opts.signal, controller.signal);
    return { username: account.username, orgId: ORG, accessToken };
  } });
  assert.deepEqual(await cli.login('https://test.salesforce.com', controller.signal), { username: account.username, orgId: ORG });
  await assert.rejects(cli.login('https://evil.test'), /Salesforce/);
  assert.equal(calls, 1);
});

test('Older sf display tokens work without copying refresh tokens or secrets', async () => {
  const cli = new SalesforceCli({ run: async args => {
    assert.deepEqual(args, ['org', 'display', '--target-org', account.username]);
    return { ...account, id: ORG, accessToken, refreshToken: 'never-copy', clientSecret: 'never-copy' };
  } });
  assert.deepEqual(await cli.session(account.username, ORG), cliSession());
});

test('Modern sf redaction uses explicit access-token command', async () => {
  const calls = [];
  const cli = new SalesforceCli({ run: async args => {
    calls.push(args);
    return args[1] === 'display' ? { ...account, id: ORG, accessToken: '[REDACTED] Use org auth show-access-token' } : { accessToken };
  } });
  assert.deepEqual(await cli.session(account.username, ORG), cliSession());
  assert.deepEqual(calls[1], ['org', 'auth', 'show-access-token', '--target-org', account.username]);
});

test('CLI refuses changed orgs, changed usernames, malicious origins, and invalid tokens', async () => {
  for (const fields of [{ id: '00D000000000002AAA' }, { username: 'other@example.test' }, { instanceUrl: 'https://evil.test' }, { accessToken: 'bad\r\nAuthorization: evil' }]) {
    const cli = new SalesforceCli({ run: async () => ({ ...account, id: ORG, accessToken, ...fields }) });
    await assert.rejects(cli.session(account.username, ORG));
  }
  let called = false;
  const cli = new SalesforceCli({ run: async () => { called = true; } });
  await assert.rejects(cli.session('user & echo token', ORG));
  assert.equal(called, false);
});

test('CLI runner uses argv without shell and never forwards raw credential-bearing errors', async () => {
  const run = createCliRunner({ resolve: () => ({ file: '/trusted/node', prefix: ['/trusted/sf/run'], cwd: '/home/test' }), execute: (file, args, opts, done) => {
    assert.equal(file, '/trusted/node'); assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true);
    assert.deepEqual(args, ['/trusted/sf/run', 'org', 'list', 'auth', '--json']);
    done(new Error('token-secret'), '{"status":1,"message":"token-secret"}', 'token-secret');
  } });
  await assert.rejects(run(['org', 'list', 'auth']), error => !error.message.includes('token-secret') && !error.cause && error.code === 'cli-auth-error');
});

test('Windows resolution bypasses cmd shim with bundled Node; missing sf fails clearly', () => {
  const folder = path.resolve('fake-sf/bin');
  const bin = path.resolve(folder, '../client/bin');
  const available = new Set([path.join(folder, 'sf.cmd'), path.join(bin, 'node.exe'), path.join(bin, 'run')]);
  const resolved = resolveCli({ platform: 'win32', env: { PATH: folder }, exists: f => available.has(f), home: '/safe-home' });
  assert.equal(resolved.file, path.join(bin, 'node.exe')); assert.deepEqual(resolved.prefix, [path.join(bin, 'run')]);
  assert.throws(() => resolveCli({ env: { PATH: '.' }, exists: () => false }), /not found/);
});

test('CLI authentication persists only selection, restores it and disconnect leaves CLI untouched', async () => {
  const store = secrets(); let sessions = 0;
  const cli = { session: async (name, org) => { sessions++; assert.equal(name, account.username); assert.equal(org, ORG); return cliSession(); } };
  const client = new SalesforceClient(store, { cli, fetchFn: async url => identity(url) });
  await client.accept(cliSession());
  const saved = JSON.parse(await store.get(SESSION_KEY));
  assert.deepEqual(Object.keys(saved).sort(), ['authMode', 'identity', 'username']);
  assert.equal(JSON.stringify(client.publicIdentity()).includes(accessToken), false);
  const restored = new SalesforceClient(store, { cli, fetchFn: async url => identity(url) });
  assert.equal(await restored.restore(), true); assert.equal(sessions, 1);
  await restored.disconnect(); assert.equal(await store.get(SESSION_KEY), undefined); assert.equal(sessions, 1);
});

test('CLI connection still rejects production and selected-org mismatch', async () => {
  for (const opts of [{ production: true }, {}]) {
    const store = secrets();
    const client = new SalesforceClient(store, { fetchFn: async url => identity(url, opts) });
    await assert.rejects(client.accept({ ...cliSession(), ...(opts.production ? {} : { expectedOrgId: '00D000000000002AAA' }) }));
    assert.equal(client.session, null); assert.equal(await store.get(SESSION_KEY), undefined);
  }
});

test('Concurrent CLI refresh uses one CLI session and verifies identity before retrying', async () => {
  let renewals = 0, writes = 0;
  const store = secrets();
  const cli = { session: async () => { renewals++; await new Promise(r => setTimeout(r, 20)); return { ...cliSession(), accessToken: 'new-access-token-in-memory-only' }; } };
  const client = new SalesforceClient(store, { cli, fetchFn: async (url, opts) => {
    assert.equal(url.endsWith('/token'), false);
    if (url.endsWith('/limits')) {
      if (opts.headers.Authorization === 'Bearer ' + accessToken) return json([], 401);
      writes++; return json({ ok: true });
    }
    return identity(url);
  } });
  await client.accept(cliSession());
  await Promise.all([client.request(API + '/limits'), client.request(API + '/limits')]);
  assert.equal(renewals, 1); assert.equal(writes, 2);
  assert.equal((await store.get(SESSION_KEY)).includes('access-token'), false);
});

test('CLI refresh cannot retry a write with a different user or host', async () => {
  for (const change of ['user', 'host']) {
    let renewed = false, retried = false;
    const store = secrets();
    const cli = { session: async () => { renewed = true; return { ...cliSession(), accessToken: 'new-token-in-memory-only', ...(change === 'host' ? { instanceUrl: 'https://other.my.salesforce.com' } : {}) }; } };
    const client = new SalesforceClient(store, { cli, fetchFn: async (url, opts) => {
      if (opts.method === 'PATCH') { if (renewed) retried = true; return json([], 401); }
      return identity(url, { userId: renewed ? '005000000000002AAA' : USER });
    } });
    await client.accept(cliSession());
    await assert.rejects(client.request(API + '/sobjects/Account/001000000000001AAA', { method: 'PATCH', body: { Name: 'test' } }), /could not be renewed/);
    assert.equal(retried, false); assert.equal(await store.get(SESSION_KEY), undefined);
  }
});

test('CLI refresh after disconnect cannot resurrect the session', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const store = secrets();
  const client = new SalesforceClient(store, { cli: { session: async () => { await gate; return cliSession(); } }, fetchFn: async url => identity(url) });
  await client.accept(cliSession());
  const refreshing = client.refresh(accessToken);
  await client.disconnect(); release();
  await assert.rejects(refreshing, /could not be renewed/);
  assert.equal(client.session, null); assert.equal(await store.get(SESSION_KEY), undefined);
});

test('Disconnect during CLI restore cannot resurrect the saved connection', async () => {
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  const store = secrets();
  const client = new SalesforceClient(store, { cli: { session: async () => { entered(); await gate; return cliSession(); } }, fetchFn: async url => identity(url) });
  await client.accept(cliSession());
  client.session = null;
  const restoring = client.restore();
  await started;
  await client.disconnect(); release();
  await assert.rejects(restoring, /could not be verified/);
  assert.equal(client.session, null); assert.equal(await store.get(SESSION_KEY), undefined);
});
