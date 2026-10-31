'use strict';
const { randomBytes } = require('node:crypto');
// Each webview document must finish a fresh restore handshake before it can
// send API calls/checkpoints. A reload immediately retires the previous writer.
class RecoverySession {
  constructor({ restore, save }) { this.restore=restore; this.save=save; this.token=null; this.sequence=0; this.epoch=0; this.queue=Promise.resolve(); this.closed=false; }
  accepts(message) { return !this.closed && !!this.token && message?.sessionToken===this.token; }
  async begin(documentId) {
    if(this.closed || typeof documentId!=='string' || !/^[a-f0-9]{32}$/.test(documentId))throw Error('Invalid recovery session.');
    const epoch=++this.epoch; this.token=null;
    const job=this.queue.then(async()=>{
      if(this.closed || epoch!==this.epoch)throw Error('A newer canvas has opened.');
      const restored=await this.restore();
      if(this.closed || epoch!==this.epoch)throw Error('A newer canvas has opened.');
      this.token=randomBytes(24).toString('hex'); this.sequence=0;
      return {type:'recovery-ready-result',documentId,sessionToken:this.token,...restored};
    });
    this.queue=job.catch(()=>{});return job;
  }
  checkpoint(message) {
    if(!this.accepts(message) || !Number.isSafeInteger(message.sequence) || message.sequence<=this.sequence) return Promise.reject(Error('Stale recovery checkpoint rejected.'));
    this.sequence=message.sequence;
    // Freeze at receipt, before the next message can alter host baselines.
    const state=structuredClone(message.state);
    const baselines=structuredClone(message.baselines);
    const result=this.queue.then(()=>this.save(state,baselines));
    this.queue=result.catch(()=>{}); return result;
  }
  async close() { this.closed=true; this.token=null; ++this.epoch; await this.queue; }
}
module.exports={RecoverySession};
