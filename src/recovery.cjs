'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateState } = require('./state.cjs');
const TTL = 7 * 24 * 60 * 60 * 1000;
const queues = new Map();
function serial(file, work) {
  const result = (queues.get(file) || Promise.resolve()).then(work);
  const tail = result.catch(()=>{}); queues.set(file, tail);
  tail.then(()=>{if(queues.get(file)===tail)queues.delete(file);});
  return result;
}
class RecoveryStore {
  constructor(root, secrets, identity) {
    this.identity = identity.orgId + ':' + identity.userId;
    const hash = crypto.createHash('sha256').update(this.identity).digest('hex');
    this.file = path.join(root, 'recovery', hash + '.bin'); this.secret = 'desktop.recovery.key.' + hash;
    this.secrets = secrets; this.queue = Promise.resolve();
  }
  async key(create = false) {
    let encoded = await this.secrets.get(this.secret);
    if (!encoded && create) { encoded = crypto.randomBytes(32).toString('base64'); await this.secrets.store(this.secret, encoded); }
    if (!encoded) throw new Error('Recovery encryption key is unavailable.');
    const key = Buffer.from(encoded, 'base64'); if (key.length !== 32) throw new Error('Invalid recovery key.'); return key;
  }
  save(state, baselines) {
    const checked = validateState(state);
    if (!checked) return Promise.reject(new Error('Recovery snapshot is invalid or larger than 4 MB.'));
    const plain = Buffer.from(JSON.stringify({ version:1, identity:this.identity, time:Date.now(), state:checked, baselines:[...baselines] }));
    if (plain.length > 12 * 1024 * 1024) return Promise.reject(new Error('Recovery exceeds the 12 MB limit. Export your canvas to keep a copy.'));
    const job = serial(this.file, async () => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', await this.key(true), iv);
      cipher.setAAD(Buffer.from(this.identity)); const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      await fs.mkdir(path.dirname(this.file), { recursive:true });
      const temporary = this.file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
      try { await fs.writeFile(temporary, Buffer.concat([iv,cipher.getAuthTag(),ciphertext]), { mode:0o600, flag:'wx' }); await fs.rename(temporary, this.file); }
      finally { await fs.rm(temporary, { force:true }); }
    });
    this.queue = job.catch(()=>{}); return job;
  }
  async load() {
    await (queues.get(this.file) || this.queue);
    let bytes; try { const stat = await fs.stat(this.file); if (stat.size > 13 * 1024 * 1024) throw new Error('Invalid recovery size.'); bytes = await fs.readFile(this.file); } catch (error) { if(error.code==='ENOENT')return null; throw error; }
    const decipher = crypto.createDecipheriv('aes-256-gcm', await this.key(), bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(this.identity)); decipher.setAuthTag(bytes.subarray(12,28));
    const parsed = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());
    if (parsed.version!==1 || parsed.identity!==this.identity || !validateState(parsed.state) || !Array.isArray(parsed.baselines)) throw new Error('Recovery snapshot is invalid.');
    if (!Number.isFinite(parsed.time) || Date.now()-parsed.time > TTL) { await this.clear(); return null; }
    if (parsed.baselines.some(entry => !Array.isArray(entry) || entry.length!==2 || !/^[A-Za-z][A-Za-z0-9_]*:[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(entry[0]) || !entry[1] || typeof entry[1]!=='object')) throw new Error('Recovery baselines are invalid.');
    return parsed;
  }
  clear() {
    const job = serial(this.file, async()=>{ await fs.rm(this.file,{force:true}); await this.secrets.delete(this.secret); });
    this.queue = job.catch(()=>{}); return job;
  }
}
async function cleanupRecovery(root, secrets, now=Date.now(), clearAll=false) {
  const directory = path.join(root, 'recovery');
  let entries; try { entries = await fs.readdir(directory, {withFileTypes:true}); } catch(error) { if(error.code==='ENOENT')return 0; throw error; }
  let removed=0;
  for (const entry of entries) {
    const match=/^([a-f0-9]{64})\.bin(?:\.[a-f0-9]{16}\.tmp)?$/.exec(entry.name);
    if(!entry.isFile() || !match)continue;
    const file=path.join(directory, entry.name), main=path.join(directory, match[1]+'.bin');
    await serial(main, async()=>{
      let stat;try{stat=await fs.stat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
      if(!clearAll && now-stat.mtimeMs<TTL)return;
      await fs.rm(file,{force:true});
      if(clearAll || file===main)await secrets.delete('desktop.recovery.key.'+match[1]);
      removed++;
    });
  }
  return removed;
}
module.exports = { RecoveryStore, cleanupRecovery, TTL };
