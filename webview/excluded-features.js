// Compatibility interfaces for the pinned canvas bootstrap. AI/MCP/live-sync implementations
// are not shipped. These adapters create no UI, storage, connections, requests or timers.
(() => {
  const ns=window.OrgLoom=window.OrgLoom||{}, noop=()=>{}, local=async()=>({ok:true,localOnly:true});
  ns.aiGenerate={mount:()=>({openModal:noop,checkStatus:async()=>false,isEnabled:()=>false,getAccessState:()=>({allowed:false,visible:false})})};
  ns.aiProposals={mount:()=>({getPollCanvasId:()=>null,openProposalsReview:noop,refreshProposals:noop,watchProposalsForCurrentCanvas:noop})};
  ns.presence={mount:()=>({
    beginCanvasLoad:()=>noop,subscribeToCanvas:noop,unsubscribe:noop,pushFocus:noop,publishLayout:noop,publishChanges:noop,
    noteLocalSave:noop,fieldLockFor:()=>null,acquireFieldLock:local,
    commitRecordFields:async(record,fields,options)=>{options?.beforeCommit?.();return {ok:true,localOnly:true};},
    releaseFieldLock:noop,releaseRecordFieldLocks:noop,acknowledgedContributionIds:()=>[],markContributionIdsSaved:noop
  })};
})();
