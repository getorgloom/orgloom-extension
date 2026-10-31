const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { runTests } = require('@vscode/test-electron');
const root = path.resolve(__dirname, '..');
(async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const runId = String(Date.now());
  const profile = path.join(root, '.vscode-test', runId);
  const results = path.join(root, 'test-results');
  fs.mkdirSync(results, { recursive: true });
  const installed = process.env.VSCODE_EXECUTABLE;
  await runTests({
    ...(installed && fs.existsSync(installed) ? { vscodeExecutablePath: installed } : { version: '1.140.0' }),
    extensionDevelopmentPath: process.env.ORGLOOM_TEST_EXTENSION_ROOT || root,
    extensionTestsPath: path.join(__dirname, 'extension.test.cjs'),
    extensionTestsEnv: { ORGLOOM_TEST_CDP_PORT: String(port), ORGLOOM_TEST_RESULTS: results },
    launchArgs: ['--user-data-dir=' + profile, '--extensions-dir=' + path.join(profile, 'extensions'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1'],
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
