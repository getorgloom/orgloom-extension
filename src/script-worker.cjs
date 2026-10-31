'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { parse, interpret, helpers } = require('./script-interpreter.cjs');
try {
  const logs = [], records = workerData.records;
  const before = records.map(r=>JSON.stringify({id:r.id,objectName:r.objectName,loadedFromId:r.loadedFromId}));
  interpret(parse(workerData.source), { records, ...helpers(), log: (...args)=>{ if(logs.length>=100)throw new Error('Log limit exceeded.'); logs.push(args.map(x=>String(x).slice(0,1000)).join(' ')); }, abort: message=>{throw new Error(message||'Script aborted');}, toStr:String,toNum:Number,max:Math.max,min:Math.min,round:Math.round,floor:Math.floor,ceil:Math.ceil,abs:Math.abs });
  records.forEach((r,i)=>{
    if(JSON.stringify({id:r.id,objectName:r.objectName,loadedFromId:r.loadedFromId})!==before[i] || !r.values || Array.isArray(r.values))throw new Error('Record identities cannot be changed.');
    for(const [field,value] of Object.entries(r.values))if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(field) || (value!==null && !['string','number','boolean'].includes(typeof value)) || (typeof value==='number' && !Number.isFinite(value)))throw new Error('Fields must contain scalar values.');
  });
  if(JSON.stringify(records).length>2*1024*1024)throw new Error('Result exceeds 2 MB.');
  parentPort.postMessage({ records, logs });
} catch(error) { parentPort.postMessage({error:String(error.message).slice(0,1000)}); }
