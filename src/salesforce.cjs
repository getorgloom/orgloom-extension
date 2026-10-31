'use strict';

const SESSION_KEY = 'salesforce.desktop.session.v1';
const API = '/services/data/v65.0';
class SalesforceError extends Error {
  constructor(message, code = 'salesforce-error', status = 400) { super(message); this.code = code; this.status = status; }
}
function salesforceOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.pathname !== '/' || u.search || u.hash ||
      !(u.hostname === 'login.salesforce.com' || u.hostname === 'test.salesforce.com' || /^[a-z0-9][a-z0-9.-]*\.my\.salesforce\.com$/i.test(u.hostname))) {
    throw new SalesforceError('Use a Salesforce login or My Domain HTTPS origin.');
  }
  return u.origin;
}
async function readJson(response) {
  const text = await response.text();
  if (text.length > 12 * 1024 * 1024) throw new SalesforceError('Salesforce response exceeded the prototype size limit.', 'invalid-response', 502);
  try { return text ? JSON.parse(text) : null; } catch { throw new SalesforceError('Salesforce returned an unreadable response.', 'invalid-response', 502); }
}
function responseError(body, status) {
  // Do not expose raw OAuth responses, request URLs, tokens, or arbitrary HTML.
  const candidate = Array.isArray(body) ? body[0]?.errorCode : body?.error;
  const code = typeof candidate === 'string' && /^[A-Z0-9_-]{1,80}$/i.test(candidate) ? candidate : 'salesforce-error';
  if (code === 'API_DISABLED_FOR_ORG') return new SalesforceError('Org Loom requires Salesforce API access. Ask your Salesforce administrator to enable API access for your org and grant your user the API Enabled permission.', code, status);
  return new SalesforceError(`Salesforce rejected the request (${code}).`, code, status);
}
class SalesforceClient {
  constructor(secrets, { fetchFn = fetch, cli, confirmProduction } = {}) { this.secrets = secrets; this.fetch = fetchFn; this.cli = cli; this.confirmProduction = confirmProduction; this.productionApprovals = new Set(); this.session = null; this.refreshing = null; this.generation = 0; this.storageQueue = Promise.resolve(); }
  async restore() {
    const generation = this.generation;
    const raw = await this.secrets.get(SESSION_KEY);
    if (!raw) return false;
    try {
      if (generation !== this.generation) throw new Error();
      const saved = JSON.parse(raw);
      if (saved.authMode !== 'cli') throw new SalesforceError('Direct OAuth connections are no longer supported. Run Org Loom: Connect with Salesforce CLI to reconnect.', 'cli-required', 401);
      if (!this.cli || !saved.identity?.orgId || !saved.identity?.userId) throw new Error();
      const session = await this.cli.session(saved.username, saved.identity.orgId);
      if (generation !== this.generation) throw new Error();
      this.session = session;
      await this.verifyIdentity(saved.identity);
      return true;
    } catch (error) { if (generation === this.generation) await this.disconnect(); if (error.code === 'cli-required' || error.code === 'org-info-access-required' || error.code === 'API_DISABLED_FOR_ORG') throw error; throw new SalesforceError('The saved connection could not be verified. Reconnect the Salesforce org.', 'reauth-required', 401); }
  }
  publicIdentity() { return this.session?.identity ? { ...this.session.identity, instanceUrl: this.session.instanceUrl } : null; }
  async accept(session) {
    if (session?.authMode !== 'cli') throw new SalesforceError('Run Org Loom: Connect with Salesforce CLI to connect.', 'cli-required', 401);
    const generation = ++this.generation;
    this.session = session;
    try { await this.verifyIdentity({ orgId: session.expectedOrgId }); await this.persist(); } catch (error) { if (generation === this.generation) await this.disconnect(); throw error; }
  }
  async persist() {
    const session = this.session, generation = this.generation;
    // CLI owns its credentials. Only remember which verified user/org was
    // selected; reacquire access on reopen, never duplicate CLI refresh tokens.
    if (session?.authMode !== 'cli') throw new SalesforceError('Connect with Salesforce CLI first.', 'cli-required', 401);
    const serialized = JSON.stringify({ authMode: 'cli', username: session.username, identity: session.identity });
    this.storageQueue = this.storageQueue.catch(() => {}).then(async () => {
      if (session && this.session === session && this.generation === generation) await this.secrets.store(SESSION_KEY, serialized);
    });
    return this.storageQueue;
  }
  async disconnect() {
    this.generation++; this.session = null; this.productionApprovals.clear();
    this.storageQueue = this.storageQueue.catch(() => {}).then(() => this.secrets.delete(SESSION_KEY));
    await this.storageQueue;
  }
  async readIdentity(request, expected) {
    const user = await request('/services/oauth2/userinfo');
    if (!/^[a-zA-Z0-9]{15,18}$/.test(user?.organization_id) || !/^[a-zA-Z0-9]{15,18}$/.test(user?.user_id)) throw new SalesforceError('Salesforce identity could not be verified.');
    if (expected && (expected.orgId?.slice(0,15) !== user.organization_id.slice(0,15) || (expected.userId && expected.userId.slice(0,15) !== user.user_id.slice(0,15)))) throw new SalesforceError('Salesforce identity changed. Reconnect before continuing.');
    let org;
    try {
      org = (await request(API + '/query?q=' + encodeURIComponent('SELECT Id, Name, IsSandbox, OrganizationType FROM Organization LIMIT 1')))?.records?.[0];
    } catch (error) {
      if (['INVALID_TYPE', 'INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY'].includes(error.code)) {
        throw new SalesforceError('Salesforce signed you in, but Org Loom cannot read your org information. To connect, your user needs API Enabled and View Setup and Configuration access. Ask your Salesforce administrator to grant these permissions, then reconnect. A full System Administrator profile is not required.', 'org-info-access-required', 403);
      }
      throw error;
    }
    if (!org || typeof org.Id !== 'string' || org.Id.slice(0,15) !== user.organization_id.slice(0,15)) throw new SalesforceError('Salesforce org identity could not be verified.', 'invalid-identity', 403);
    const identity = { orgId: user.organization_id, userId: user.user_id, username: user.preferred_username || this.session?.username || '', displayName: user.name || user.preferred_username || 'Salesforce user', orgName: org.Name, orgType: org.IsSandbox ? 'sandbox' : org.OrganizationType === 'Developer Edition' ? 'developer' : 'production', timeZone: user.zoneinfo || 'UTC' };
    if (identity.orgType === 'production') {
      const key = identity.orgId + ':' + identity.userId, generation = this.generation;
      if (!this.productionApprovals.has(key)) {
        if (!this.confirmProduction || !await this.confirmProduction(identity)) throw new SalesforceError('Production orgs are blocked until you explicitly confirm the production connection.', 'production-confirmation-required', 403);
        if (generation !== this.generation) throw new SalesforceError('Connection changed during production confirmation.');
        this.productionApprovals.add(key);
      }
    }
    return identity;
  }
  async verifyIdentity(expected) {
    const session = this.session, generation = this.generation;
    const identity = await this.readIdentity(route => this.request(route), expected);
    if (this.session !== session || this.generation !== generation) throw new SalesforceError('Connection changed during verification.');
    session.identity = identity;
  }
  async refresh(staleAccess) {
    if (this.session?.accessToken !== staleAccess) return;
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    this.refreshing = (async () => {
      const session = this.session;
      try {
        if (session.authMode !== 'cli' || !this.cli || !session.identity) throw new Error();
        const candidate = await this.cli.session(session.username, session.identity.orgId);
        if (candidate.instanceUrl !== session.instanceUrl) throw new Error();
        const identity = await this.readIdentity(async route => {
          const { response, data } = await this.requestOnce(candidate, route);
          if (!response.ok) throw responseError(data, response.status);
          return data;
        }, session.identity);
        if (generation !== this.generation || session !== this.session) throw new Error();
        session.accessToken = candidate.accessToken;
        session.identity = identity;
      } catch {
        if (generation === this.generation) await this.disconnect();
        throw new SalesforceError('The Salesforce CLI connection could not be renewed. Sign in with sf org login web, then reconnect through Org Loom: Connect with Salesforce CLI.', 'reauth-required', 401);
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async request(route, { method = 'GET', body, headers = {}, retry = true } = {}) {
    if (this.session?.authMode !== 'cli') throw new SalesforceError('Connect a Salesforce org with Org Loom: Connect with Salesforce CLI first.', 'reauth-required', 401);
    const session = this.session;
    const generation = this.generation;
    const access = session.accessToken;
    const { response, data } = await this.requestOnce(session, route, { method, body, headers });
    if (generation !== this.generation || this.session !== session) throw new SalesforceError('Connection changed while the request was in progress.', 'reauth-required', 401);
    if (response.status === 401 && retry) { await this.refresh(access); return this.request(route, { method, body, headers, retry: false }); }
    if (!response.ok) throw responseError(data, response.status);
    return data;
  }
  async requestOnce(session, route, { method = 'GET', body, headers = {} } = {}) {
    if (!route.startsWith(API + '/') && route !== '/services/oauth2/userinfo') throw new SalesforceError('Unsupported Salesforce resource.');
    if (route.includes('\\') || route.includes('#') || route.includes('..')) throw new SalesforceError('Invalid Salesforce resource.');
    const response = await this.fetch(session.instanceUrl + route, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { ...headers, Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { response, data: await readJson(response) };
  }
}
module.exports = { SalesforceClient, SalesforceError, salesforceOrigin, API, SESSION_KEY };
