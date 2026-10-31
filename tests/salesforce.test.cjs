'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SalesforceClient, salesforceOrigin, API, SESSION_KEY } = require('../src/salesforce.cjs');
const ORG = '00D000000000001AAA', USER = '005000000000001AAA';
const loginUrl = 'https://test.salesforce.com';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const secrets = () => { const map = new Map(); return { get: async k => map.get(k), store: async (k,v) => map.set(k,v), delete: async k => map.delete(k) }; };
const session = () => ({ authMode: 'cli', username: 'test.user@example.com', expectedOrgId: ORG, instanceUrl: 'https://example.my.salesforce.com', accessToken: 'old-access' });
const cli = { session: async () => session() };
function identityResponse(url, production = false) {
  if (url.endsWith('/userinfo')) return json({ organization_id: ORG, user_id: USER, name: 'Test User', preferred_username: 'test.user@example.com' });
  return json({ records: [{ Id: ORG, Name: 'Test Org', IsSandbox: !production, OrganizationType: production ? 'Enterprise Edition' : 'Sandbox' }] });
}
test('Salesforce origin validation prevents arbitrary hosts and embedded URL credentials', () => {
  assert.equal(salesforceOrigin(loginUrl), loginUrl);
  for (const url of ['http://test.salesforce.com', 'https://salesforce.com.evil.test', 'https://example.my.salesforce.com.evil.test', 'https://user:pass@test.salesforce.com', 'https://test.salesforce.com/path', 'https://test.salesforce.com:444', 'https://localhost', 'https://test.salesforce.com#token']) assert.throws(() => salesforceOrigin(url));
});
test('Legacy direct OAuth sessions are removed without any network request', async () => {
  const store = secrets(); let requests = 0;
  await store.store(SESSION_KEY, JSON.stringify({ instanceUrl: 'https://example.my.salesforce.com', accessToken: 'legacy-access', refreshToken: 'legacy-refresh', identity: { orgId: ORG, userId: USER } }));
  const client = new SalesforceClient(store, { cli, fetchFn: async () => { requests++; throw Error('Unexpected request'); } });
  await assert.rejects(client.restore(), error => error.code === 'cli-required' && /Connect with Salesforce CLI/.test(error.message));
  assert.equal(requests, 0); assert.equal(client.session, null); assert.equal(await store.get(SESSION_KEY), undefined);
});

test('Direct OAuth sessions cannot be accepted or persisted', async () => {
  const store = secrets(); let requests = 0;
  const client = new SalesforceClient(store, { cli, fetchFn: async () => { requests++; throw Error('Unexpected request'); } });
  const legacy = { instanceUrl: 'https://example.my.salesforce.com', accessToken: 'legacy-access', refreshToken: 'legacy-refresh' };
  await assert.rejects(client.accept(legacy), error => error.code === 'cli-required');
  assert.equal(client.session, null);
  client.session = legacy;
  await assert.rejects(client.persist(), error => error.code === 'cli-required');
  await assert.rejects(client.request(API + '/limits'), /Connect with Salesforce CLI/);
  assert.equal(requests, 0); assert.equal(await store.get(SESSION_KEY), undefined);
});

test('Production organizations are rejected without retaining credentials', async () => {
  const store = secrets();
  const client = new SalesforceClient(store, { cli, fetchFn: async url => identityResponse(url, true) });
  await assert.rejects(client.accept(session()), /Production orgs are blocked/);
  assert.equal(client.publicIdentity(), null); assert.equal(await store.get(SESSION_KEY), undefined);
});

test('restricted Organization access explains the failed identity check without bypassing it', async () => {
  for (const code of ['INVALID_TYPE','INSUFFICIENT_ACCESS','INSUFFICIENT_ACCESS_OR_READONLY']) {
    const store=secrets();let confirmations=0;
    const client=new SalesforceClient(store, { cli,confirmProduction:async()=>{confirmations++;return true;},fetchFn:async url=>url.endsWith('/userinfo')?identityResponse(url):json([{errorCode:code,message:'private server details'}],400)});
    await assert.rejects(client.accept(session()), error=>error.code==='org-info-access-required'&&error.message.includes('View Setup and Configuration')&&!error.message.includes('private server details'));
    assert.equal(confirmations,0);assert.equal(client.publicIdentity(),null);assert.equal(await store.get(SESSION_KEY),undefined);
  }
});

test('reopening a saved connection retains the actionable permission error', async () => {
  const store=secrets();
  await new SalesforceClient(store, { cli,fetchFn:async url=>identityResponse(url)}).accept(session());
  const client=new SalesforceClient(store, { cli,fetchFn:async url=>url.endsWith('/userinfo')?identityResponse(url):json([{errorCode:'INVALID_TYPE'}],400)});
  await assert.rejects(client.restore(),error=>error.code==='org-info-access-required'&&error.message.includes('API Enabled')&&error.message.includes('View Setup and Configuration')&&error.message.includes('System Administrator profile is not required'));
  assert.equal(client.publicIdentity(),null);
  assert.equal(await store.get(SESSION_KEY),undefined);
});

test('disabled API access explains the org and user requirements without leaking the response',async()=>{
  const client=new SalesforceClient(secrets(),{fetchFn:async()=>json([{errorCode:'API_DISABLED_FOR_ORG',message:'private response'}],403)});
  await assert.rejects(client.accept(session()),error=>error.code==='API_DISABLED_FOR_ORG'&&error.message.includes('API Enabled')&&!error.message.includes('private response'));
});

test('Production requires explicit identity-specific confirmation, including after restart', async () => {
  const store=secrets();let prompts=0;
  const options={cli,fetchFn:async url=>identityResponse(url,true),confirmProduction:async who=>{prompts++;assert.equal(who.orgType,'production');assert.equal(who.orgId,ORG);return true;}};
  const client=new SalesforceClient(store,options);await client.accept(session());assert.equal(prompts,1);assert.equal(client.publicIdentity().orgType,'production');assert.equal(client.publicIdentity().username,'test.user@example.com');
  await client.verifyIdentity(client.publicIdentity());assert.equal(prompts,1);
  const restored=new SalesforceClient(store,options);await restored.restore();assert.equal(prompts,2);
  await restored.disconnect();
  const denied=new SalesforceClient(store, { cli,...options,confirmProduction:async()=>false});await assert.rejects(denied.accept(session()),/explicitly confirm/);assert.equal(denied.publicIdentity(),null);
});
test('Failed CLI renewal forces reconnect without a direct token request', async () => {
  const store = secrets(); let renewals = 0;
  const client = new SalesforceClient(store, { cli: { session: async () => { renewals++; throw Error('CLI unavailable'); } }, fetchFn: async url => {
    assert.equal(url.endsWith('/token'), false);
    if (url.endsWith('/limits')) return json([], 401);
    return identityResponse(url);
  } });
  await client.accept(session());
  await assert.rejects(client.request(API + '/limits'), /could not be renewed/);
  await assert.rejects(client.request(API + '/limits'), /Connect with Salesforce CLI/);
  assert.equal(renewals, 1); assert.equal(await store.get(SESSION_KEY), undefined);
});

test('Redirects are not followed and changed identity cannot restore a saved session', async () => {
  const store=secrets();
  const client=new SalesforceClient(store, { cli,fetchFn:async (url,options)=>{assert.equal(options.redirect,'error');return identityResponse(url);}});
  await client.accept(session());
  const another=new SalesforceClient(store, { cli,fetchFn:async()=>json({organization_id:ORG,user_id:'005000000000002AAA'})});
  await assert.rejects(another.restore(),/could not be verified/);
});
module.exports = { secrets, session, ORG, USER, json };
