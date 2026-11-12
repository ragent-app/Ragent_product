// Listener recovery never renews session authority. Only authenticated Owner
// requests can do that through lifecycle.activate and its original deadline.
import {inspectInstalledOwnerActivationService} from './windows-owner-service-trust.mjs';
import {serveOwnerActivationOnce} from './windows-owner-bootstrap.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const peerFailures=new Set(['OBC_PEER_DISCONNECTED','OBC_DELIVERY_UNCONFIRMED','OBC_ACTIVATION_FRAME_INVALID',
  'OBC_OPERATION_DENIED','OBC_BINDING_MISMATCH','OBC_EXPIRED','OBC_LAUNCH_NONCE_INVALID','OBC_LAUNCH_NONCE_MISMATCH',
  // An activation may expire while its receipt is being committed. Recovery
  // still requires endpoint closure, rollback and the lifecycle safety barrier.
  'OSV_STOPPED']);
export const OWNER_ACTIVATION_RECOVERY=Object.freeze({windowMs:60000,delays:Object.freeze([250,1000,3000])});
const pause=(ms,signal)=>new Promise((resolve,reject)=>{
  if(signal.aborted){reject(Object.assign(Error('OBC_ABORTED'),{code:'OBC_ABORTED'}));return;}
  const onAbort=()=>{clearTimeout(timer);reject(Object.assign(Error('OBC_ABORTED'),{code:'OBC_ABORTED'}));};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},ms);timer.unref?.();
  signal.addEventListener('abort',onAbort,{once:true});
});
export function createOwnerActivationService({lifecycle,inspect=inspectInstalledOwnerActivationService,serve=serveOwnerActivationOnce,clock=Date.now,wait=pause}={}){
  if(![lifecycle?.activate,lifecycle?.assertRecoverySafe,inspect,serve,clock,wait].every(f=>typeof f==='function'))fail('OSV_CONFIGURATION_REQUIRED');
  let state='idle',code=null,abort=null,endpoint=null,task=null,stopping=false,installation=null;
  const recoveries=[];
  async function backoff(){
    for(;;){
      while(recoveries.length&&recoveries[0]<=clock()-OWNER_ACTIVATION_RECOVERY.windowMs)recoveries.shift();
      if(recoveries.length<OWNER_ACTIVATION_RECOVERY.delays.length){
        const ms=OWNER_ACTIVATION_RECOVERY.delays[recoveries.length];recoveries.push(clock());state='backoff';await wait(ms,abort.signal);return;
      }
      state='cooldown';await wait(Math.max(1,Math.min(OWNER_ACTIVATION_RECOVERY.windowMs,recoveries[0]+OWNER_ACTIVATION_RECOVERY.windowMs-clock())),abort.signal);
      if(stopping)return;
    }
  }
  async function run(context){
    while(!stopping){
      state='inspecting';
      const trusted=await inspect(context,{signal:abort.signal});
      if(stopping)return;
      const generation=JSON.stringify([trusted.binding,trusted.releaseJson,trusted.executablePath]);
      if(installation!==null&&generation!==installation)fail('OSV_RECOVERY_BINDING_CHANGED');
      installation=generation;
      endpoint=await serve({policy:trusted.binding,
        executablePath:trusted.executablePath,executableSha256:JSON.parse(trusted.releaseJson).helperSha256,signal:abort.signal,
        activate:(request,policy)=>lifecycle.activate(context,{kind:'request',...request},{...policy,ownerSessionId:request.facts.sessionId})});
      if(stopping){await endpoint.close();endpoint=null;return;}
      state='listening';code=null;let error=null;
      try{await endpoint.completion;}catch(cause){error=cause;}
      state='draining';await endpoint.close();endpoint=null;
      if(stopping)return;
      if(!error||error.code==='OBC_ACTIVATION_IDLE')continue;
      if(!peerFailures.has(error.code))throw error;
      // Completion includes receipt rollback. Confirm both endpoint closure and
      // all issue/revoke work before reopening ANY listener. No grant is opened.
      await lifecycle.assertRecoverySafe();if(stopping)return;
      code=error.code;await backoff();
    }
  }
  return Object.freeze({snapshot:()=>Object.freeze({state,code,ready:state==='listening'&&!stopping}),
    start(context){if(task||stopping)fail('OSV_ALREADY_ACTIVE');state='starting';abort=new AbortController();
      task=run(context).catch(error=>{state='failed';code=/^(OBC|OBD|OSV|OBP|OBS)_[A-Z_]+$/.test(error?.code||'')?error.code:'OSV_UNAVAILABLE';throw error;});task.catch(()=>{});return task;},
    async stop(){stopping=true;state='stopping';abort?.abort();await task?.catch(()=>{});
      try{if(endpoint){await endpoint.close();endpoint=null;}state='stopped';}
      catch(error){state='cleanup-required';code=error.code||'OSV_UNAVAILABLE';throw error;}
    },
  });
}
