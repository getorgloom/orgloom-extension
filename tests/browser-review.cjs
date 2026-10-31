'use strict';
// Manual review harness only; excluded from the VSIX. The UI and LiveApi are
// identical to the extension, with a loopback bridge replacing VS Code messaging.
// This initial checkpoint is read-only at the Salesforce transport boundary.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { SalesforceCli } = require('../src/salesforce-cli.cjs');
const { SalesforceClient, SalesforceError } = require('../src/salesforce.cjs');
const { LiveApi } = require('../src/live-api.cjs');
const { renderHtml } = require('../src/html.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), media = path.join(root, 'media');
  const alias = process.env.ORGLOOM_REVIEW_ALIAS || 'orgloom-uat';
  const cli = new SalesforceCli();
  const org = (await cli.list()).find(o => o.alias.split(',').includes(alias));
  if (!org) throw new Error('Authorized review test org not found.');
  const memory = new Map();
  const secrets = { get: async k => memory.get(k), store: async (k, v) => memory.set(k, v), delete: async k => memory.delete(k) };
  const client = new SalesforceClient(secrets, { cli });
  await client.accept(await cli.session(org.username, org.orgId));
  const request = client.request.bind(client);
  client.request = (resource, options = {}) => {
    if (options.method && options.method !== 'GET') throw new SalesforceError('This review checkpoint does not write to Salesforce.', 'review-read-only', 403);
    return request(resource, options);
  };
  const api = new LiveApi(client, { secrets, confirmUpload: async () => false });
  const token = randomBytes(24).toString('hex');
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, origin);
    const authorized = (req.headers.cookie || '').split('; ').includes('review=' + token);
    try {
      if (req.method === 'GET' && url.pathname === '/review/' + token) {
        res.setHeader('Set-Cookie', `review=${token}; HttpOnly; SameSite=Strict; Path=/`);
        let html = renderHtml({ root, identity: client.publicIdentity(), resource: p => '/assets' + p, cspSource: "'self'" });
        const nonce = /<script nonce="([^"]+)"/.exec(html)[1];
        const bridge = `<script nonce="${nonce}">(() => {
          const localFetch = window.fetch.bind(window);
          window.acquireVsCodeApi = () => ({ postMessage: message => {
            if (message.type !== 'live-api') return;
            localFetch('/bridge', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(message)})
              .then(r => r.json()).then(reply => window.dispatchEvent(new MessageEvent('message', {data:{type:'live-api-result', id:message.id, ...reply}})));
          }});
        })();</script>`;
        html = html.replace('<script nonce=', bridge + '<script nonce=')
          .replace("connect-src 'none'", "connect-src 'self'")
          .replace('for VS Code</span>', 'browser review</span>')
          .replace(' · live data · edits lost when tab closes', ' · live metadata · Salesforce writes blocked · keep this tab open');
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return;
      }
      if (!authorized) { res.writeHead(403).end(); return; }
      if (req.method === 'POST' && url.pathname === '/bridge') {
        if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') { res.writeHead(403).end(); return; }
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
        const msg = JSON.parse(Buffer.concat(chunks).toString());
        const response = /^\/api\/upload(?:\/graph)?$/.test(msg.path)
          ? { status: 403, data: { error: 'review-read-only', message: 'Paused for visual review. Salesforce uploads are disabled at this checkpoint.' } }
          : await api.handle(msg);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response)); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const file = path.resolve(media, '.' + decodeURIComponent(url.pathname.slice(7)));
        if (!file.startsWith(media + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
        const mime = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json' }[path.extname(file)];
        if (!mime) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', mime); fs.createReadStream(file).pipe(res); return;
      }
      res.writeHead(404).end();
    } catch { res.writeHead(500).end('Review request failed.'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  const details = { url: origin + '/review/' + token, org: client.publicIdentity().orgName, writes: 'blocked' };
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test-results/browser-review.json'), JSON.stringify(details, null, 2));
  console.log(JSON.stringify(details));
}
main().catch(() => { console.error('Could not start review. Check the test-org CLI authorization.'); process.exitCode = 1; });
