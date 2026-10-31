const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
(async () => {
  const root = path.resolve(__dirname, '..');
  if (!fs.existsSync(path.join(root, 'media/scripts.json'))) throw new Error('Run npm run build first.');
  const executable = await downloadAndUnzipVSCode('1.140.0');
  const profile = path.join(root, '.vscode-test', 'preview-profile');
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'orgloom.prototype.openOnStartup': true,
    'workbench.startupEditor': 'none', 'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
    'extensions.ignoreRecommendations': true,
  }, null, 2));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ['--new-window', '--user-data-dir=' + profile, '--extensions-dir=' + path.join(profile, 'extensions'), '--extensionDevelopmentPath=' + root, '--skip-welcome', '--skip-release-notes'], { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.unref();
  console.log('Opened the isolated Org Loom preview. Your regular VS Code profile is unchanged.');
})().catch(error => { console.error(error); process.exitCode = 1; });
