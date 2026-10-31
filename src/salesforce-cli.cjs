'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { SalesforceError, salesforceOrigin } = require('./salesforce.cjs');

const cliError = message => new SalesforceError(message, 'cli-auth-error');
const username = value => {
  if (typeof value !== 'string' || value.length > 254 || !/^[a-zA-Z0-9][a-zA-Z0-9._+@'-]*$/.test(value)) throw cliError('Salesforce CLI returned an invalid username.');
  return value;
};
const orgId = value => {
  if (typeof value !== 'string' || !/^00D[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(value)) throw cliError('Salesforce CLI returned an invalid org ID.');
  return value;
};
const sameOrg = (a, b) => orgId(a).slice(0, 15) === orgId(b).slice(0, 15);
const isToken = value => typeof value === 'string' && value.length >= 20 && value.length <= 8192 && /^[a-zA-Z0-9!._~-]+$/.test(value);

// Launch the installed CLI with argv, never a shell. In Windows, bypass the
// .cmd shim using the standard Salesforce installer/npm Node entry point.
function resolveCli({ env = process.env, platform = process.platform, exists = fs.existsSync, home = os.homedir() } = {}) {
  const folders = (env.PATH || env.Path || '').split(path.delimiter).map(p => p.replace(/^"|"$/g, '')).filter(p => path.isAbsolute(p));
  const names = platform === 'win32' ? ['sf.exe', 'sf.cmd'] : ['sf'];
  for (const folder of folders) {
    for (const name of names) {
      const file = path.join(folder, name);
      if (!exists(file)) continue;
      if (platform !== 'win32' || name.endsWith('.exe')) return { file, prefix: [], cwd: home };
      const roots = [
        ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'sf/client/bin')] : []),
        path.resolve(folder, '../client/bin'),
        folder,
      ];
      for (const root of roots) {
        if (exists(path.join(root, 'node.exe')) && exists(path.join(root, 'run'))) return { file: path.join(root, 'node.exe'), prefix: [path.join(root, 'run')], cwd: home };
      }
      const entry = path.join(folder, 'node_modules/@salesforce/cli/bin/run.js');
      if (exists(entry)) {
        const node = [path.join(folder, 'node.exe'), ...folders.map(p => path.join(p, 'node.exe'))].find(exists);
        if (node) return { file: node, prefix: [entry], cwd: home };
      }
    }
  }
  throw cliError('Salesforce CLI (sf) was not found. Install Salesforce CLI, then fully restart VS Code so it picks up your PATH.');
}

function createCliRunner({ resolve = resolveCli, execute = execFile, env = process.env } = {}) {
  return async (args, { signal, timeout = 60000 } = {}) => {
    const command = resolve();
    return new Promise((resolve, reject) => {
      try { execute(command.file, [...command.prefix, ...args, '--json'], {
        cwd: command.cwd, shell: false, windowsHide: true, encoding: 'utf8',
        timeout, signal, maxBuffer: 4 * 1024 * 1024,
        env: { ...env, SF_AUTOUPDATE_DISABLE: 'true', SF_DISABLE_TELEMETRY: 'true', SFDX_DISABLE_TELEMETRY: 'true', NO_COLOR: '1' },
      }, (error, stdout) => {
        // CLI stdout/stderr and child_process errors can contain credentials.
        // Parse privately and never include any of them in user-facing errors.
        if (signal?.aborted) { reject(cliError('Salesforce CLI sign-in cancelled.')); return; }
        let payload;
        try { payload = JSON.parse(stdout); } catch { /* Sanitized below. */ }
        if (error || payload?.status !== 0 || payload.result == null) {
          reject(cliError('Salesforce CLI could not complete the request. Check that the org is authorized with sf org login web, then retry. If needed, update Salesforce CLI.'));
          return;
        }
        resolve(payload.result);
      }); } catch { reject(cliError('Salesforce CLI could not be started. Check your installation and restart VS Code.')); }
    });
  };
}

class SalesforceCli {
  constructor({ run = createCliRunner() } = {}) { this.run = run; this.pending = Promise.resolve(); }
  // Serialize our CLI commands so multiple refreshes cannot race each other.
  // Other tools also using sf remain subject to the CLI's own auth behavior.
  exclusive(fn) {
    const next = this.pending.catch(() => {}).then(fn);
    this.pending = next.catch(() => {});
    return next;
  }
  async list() {
    const rows = await this.exclusive(() => this.run(['org', 'list', 'auth']));
    if (!Array.isArray(rows)) throw cliError('Salesforce CLI returned an unreadable org list. Update Salesforce CLI and retry.');
    const seen = new Set();
    return rows.flatMap(row => {
      try {
        const item = { username: username(row.username), orgId: orgId(row.orgId), instanceUrl: salesforceOrigin(row.instanceUrl) };
        if (seen.has(item.username)) return [];
        seen.add(item.username);
        item.alias = typeof row.alias === 'string' ? row.alias.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 150) : '';
        return [item];
      } catch { return []; }
    });
  }
  async login(origin, signal) {
    const result = await this.exclusive(() => this.run(['org', 'login', 'web', '--instance-url', salesforceOrigin(origin)], { signal, timeout: 180000 }));
    return { username: username(result.username), orgId: orgId(result.orgId || result.id) };
  }
  async session(selectedUsername, expectedOrgId) {
    username(selectedUsername); orgId(expectedOrgId);
    return this.exclusive(async () => {
      // display refreshes auth using the CLI's own credential store. Older CLI
      // versions include accessToken; newer ones require the explicit command.
      const info = await this.run(['org', 'display', '--target-org', selectedUsername]);
      if (info.username !== selectedUsername || !sameOrg(info.id, expectedOrgId)) throw cliError('The CLI org identity changed. Select the org again.');
      const instanceUrl = salesforceOrigin(info.instanceUrl);
      let accessToken = info.accessToken;
      if (!isToken(accessToken)) accessToken = (await this.run(['org', 'auth', 'show-access-token', '--target-org', selectedUsername])).accessToken;
      if (!isToken(accessToken)) throw cliError('Salesforce CLI did not provide a usable access token. Sign in with sf org login web and retry.');
      // Deliberately discard client secrets, refresh tokens and SFDX auth URLs.
      return { authMode: 'cli', username: selectedUsername, expectedOrgId, instanceUrl, accessToken };
    });
  }
}
module.exports = { SalesforceCli, resolveCli, createCliRunner, sameOrg };
