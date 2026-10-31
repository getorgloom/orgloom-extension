'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Hold a cross-process lease for the connected lifetime. Two VS Code windows
// must not race to renew the connection or update the same recovery checkpoint.
function acquireConnectionLock(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'salesforce-connection.lock');
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid));
    let released = false;
    return () => { if (!released) { released = true; fs.closeSync(fd); fs.unlinkSync(file); } };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('The connection lock needs manual review: ' + file);
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') { fs.unlinkSync(file); return acquireConnectionLock(directory); }
    }
    throw new Error('Another VS Code window owns the Salesforce connection. Disconnect there or close that window first.');
  }
}
module.exports = { acquireConnectionLock };
