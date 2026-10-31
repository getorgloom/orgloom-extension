'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
class DesktopScripts {
  constructor(){this.jobs=new Map();}
  cancel(id){const job=this.jobs.get(id);if(job)job.stop(new Error('Script cancelled. No changes applied.'));return {cancelled:!!job};}
  dispose(){for(const id of this.jobs.keys())this.cancel(id);}
  run(body){
    if(typeof body.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(body.id)||typeof body.source!=='string'||body.source.length>20000||!Array.isArray(body.records)||body.records.length>500||JSON.stringify(body.records).length>2*1024*1024)return Promise.reject(new Error('Use at most 500 records, 2 MB of data and 20,000 script characters.'));
    if(this.jobs.size)return Promise.reject(new Error('Wait for the current script or cancel it.'));
    return new Promise((resolve,reject)=>{
      const worker=new Worker(path.join(__dirname,'script-worker.cjs'),{workerData:body,resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:2}});
      let finished=false;
      const finish=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);this.jobs.delete(body.id);void worker.terminate();error?reject(error):resolve(result);};
      const timer=setTimeout(()=>finish(new Error('Script exceeded two seconds. No changes applied.')),2000);
      this.jobs.set(body.id,{stop:error=>finish(error)});
      worker.once('message',value=>finish(value.error?new Error(value.error):null,value));
      worker.once('error',()=>finish(new Error('Script exceeded its resource limits or failed. No changes applied.')));
      worker.once('exit',()=>{if(!finished)finish(new Error('Script stopped. No changes applied.'));});
    });
  }
}
module.exports={DesktopScripts};
