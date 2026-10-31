(() => {
  'use strict';
  const host=acquireVsCodeApi();
  const nonce=document.currentScript.nonce;
  const documentId=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  let started=false;
  window.addEventListener('message',async event=>{
    const reply=event.data;
    if(reply?.type!=='recovery-ready-result'||reply.documentId!==documentId||started)return;
    const status=document.getElementById('prototype-status');
    if(reply.error){if(status)status.textContent='Recovery could not be opened. '+reply.error+' Close and reopen the canvas to try again.';return;}
    started=true;
    window.__ORGLOOM_RECOVERY__=reply.state;
    let sequence=0;
    window.__ORGLOOM_HOST__={postMessage(message){return host.postMessage({...message,sessionToken:reply.sessionToken,...(message.type==='save-recovery'?{sequence:++sequence}:{})});}};
    // Only org/user identifiers enter VS Code's serialized panel state, never records.
    host.setState({orgId:window.__ORGLOOM_LIVE_IDENTITY__.orgId,userId:window.__ORGLOOM_LIVE_IDENTITY__.userId});
    if(reply.notice)window.__ORGLOOM_RECOVERY_NOTICE__=reply.notice;
    for(const src of window.__ORGLOOM_BOOT_SCRIPTS__){
      await new Promise((resolve,reject)=>{const script=document.createElement('script');script.nonce=nonce;script.src=src;script.onload=resolve;script.onerror=reject;document.head.append(script);});
    }
    delete window.__ORGLOOM_BOOT_SCRIPTS__;
  });
  host.postMessage({type:'recovery-ready',documentId});
})();
