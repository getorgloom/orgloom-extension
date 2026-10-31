const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const upstream = path.join(root, 'vendor/upstream');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const hashes = Object.fromEntries(files(upstream).sort().map(file => [path.relative(upstream, file).replaceAll('\\', '/'), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const manifestPath = path.join(root, 'vendor/source-manifest.json');
if (!fs.existsSync(manifestPath)) {
  throw new Error('Missing pinned source manifest. Do not silently accept upstream changes.');
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (Object.keys(hashes).length !== Object.keys(manifest.files).length || Object.entries(hashes).some(([key, value]) => manifest.files[key] !== value)) throw new Error('Pinned upstream source differs from manifest. Review the update explicitly.');
const media = path.join(root, 'media');
fs.mkdirSync(media, { recursive: true });
fs.cpSync(path.join(upstream, 'packages/canvas/src/public'), media, { recursive: true });
for (const [name, file] of [['cytoscape', 'dist/cytoscape.umd.js'], ['cytoscape-node-html-label', 'dist/cytoscape-node-html-label.min.js']]) {
  const target = path.join(media, 'vendor', name, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, 'node_modules', name, file), target);
  fs.copyFileSync(path.join(root, 'node_modules', name, 'LICENSE'), path.join(media, 'vendor', name, 'LICENSE'));
}
fs.cpSync(path.join(root, 'webview'), path.join(media, 'extension'), { recursive: true });
// Derive loading order from the real shell, excluding hosted telemetry, marketing,
// MCP startup integration. Presence/proposal module APIs are required by app.js;
// their actual requests remain confined by the mock and the network boundary.
// The upstream files themselves stay unchanged.
const excluded = new Set(['sentry-init.js', 'canvas-capture.js', 'playground-bridge.js', 'mcp-relay-client.js', 'support.js']);
const template = fs.readFileSync(path.join(upstream, 'packages/canvas/src/views/index.ejs'), 'utf8');
const scripts = [...template.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)]
  .map(m => m[1].split('?')[0]).filter(p => p.startsWith('/') && !excluded.has(path.basename(p)));
scripts.splice(scripts.indexOf('/js/mock-sf.js') + 1, 0, '/extension/seed.js');
scripts.splice(scripts.indexOf('/js/app.js'), 0, '/extension/viewport.js');
fs.writeFileSync(path.join(media, 'scripts.json'), JSON.stringify(scripts, null, 2) + '\n');
console.log(`Built real canvas assets from ${manifest.commit.slice(0, 12)} (${scripts.length} scripts).`);
