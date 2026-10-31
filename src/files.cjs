'use strict';
const path = require('node:path');
const { SalesforceError } = require('./salesforce.cjs');
const MAX = 10 * 1024 * 1024;
const bad = message => { throw new SalesforceError(message, 'invalid-file'); };
// No filesystem path is accepted from the webview. Native pickers grant access
// to individual files; the webview receives only names and bounded contents.
class DesktopFiles {
  constructor(dialogs, fs) { this.dialogs = dialogs; this.fs = fs; this.queue = Promise.resolve(); }
  run(action, body) {
    const job = this.queue.then(() => this.perform(action, body));
    this.queue = job.catch(() => {}); return job;
  }
  async perform(action, body) {
    if (action === 'open') {
      const extension = body.kind === 'csv' ? 'csv' : body.kind === 'json' ? 'json' : null;
      if (!extension) bad('Choose CSV or JSON files.');
      const selected = await this.dialogs.open(extension, body.multiple === true);
      if (!selected?.length) return { cancelled: true, files: [] };
      if (selected.length > 20 || (!body.multiple && selected.length > 1)) bad('Select at most 20 files.');
      const files = []; let size = 0;
      for (const file of selected) {
        if (file.scheme !== 'file' || path.extname(file.fsPath).toLowerCase() !== '.' + extension) bad('Select local .' + extension + ' files.');
        const stat = await this.fs.stat(file); size += stat.size;
        if (!Number.isSafeInteger(stat.size) || stat.size < 0 || size > MAX || stat.type !== 1) bad('Select regular files totaling at most 10 MB.');
        const content = await this.fs.readFile(file);
        if (content.length !== stat.size) bad('The file changed while being read. Try again.');
        files.push({ name: path.basename(file.fsPath), base64: Buffer.from(content).toString('base64'), type: extension === 'csv' ? 'text/csv' : 'application/json' });
      }
      return { files };
    }
    if (action === 'save') {
      const name = body.name;
      if (typeof name !== 'string' || name.length > 180 || !/^[^<>:"/\\|?*\x00-\x1f]+\.(?:csv|json)$/i.test(name) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(name)) bad('Provide a CSV or JSON filename without a path.');
      if (typeof body.base64 !== 'string' || body.base64.length > Math.ceil(MAX / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.base64)) bad('Invalid or oversized file contents.');
      const bytes = Buffer.from(body.base64, 'base64');
      if (bytes.length > MAX) bad('Exports are limited to 10 MB.');
      const selected = await this.dialogs.save(name);
      if (!selected) return { cancelled: true };
      if (selected.scheme !== 'file') bad('Choose a local file.');
      // The native Save dialog owns overwrite confirmation and path selection.
      await this.fs.writeFile(selected, bytes);
      return { saved: true, name: path.basename(selected.fsPath) };
    }
    bad('Unsupported file action.');
  }
}
function createDesktopFiles(vscode) {
  return new DesktopFiles({
    open: (extension, multiple) => vscode.window.showOpenDialog({ title: 'Import into Org Loom', canSelectMany: multiple, canSelectFolders: false, filters: { [extension.toUpperCase()]: [extension] } }),
    save: name => vscode.window.showSaveDialog({ title: 'Export Org Loom data', defaultUri: vscode.Uri.file(path.join(require('node:os').homedir(), name)), filters: { 'Data files': [path.extname(name).slice(1)] } }),
  }, vscode.workspace.fs);
}
module.exports = { DesktopFiles, createDesktopFiles, MAX };
