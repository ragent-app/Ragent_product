// Private control-service lifecycle; no HTTP/Run/environment authority input.
// Each explicit start/recover re-inspects OS/installation trust. Completion can
// replenish endpoints only within the same immutable, bounded authority window.
import {createOwnerDiscoverySetController} from './windows-owner-discovery-set.mjs';
import {inspectInstalledOwnerService} from './windows-owner-service-trust.mjs';
import {validateOwnerActivationRequest} from './windows-owner-activation-protocol.mjs';
import {serveOwnerBootstrapOnce} from './windows-owner-bootstrap.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const codeOf=error=>/^(?:OBS|OBP|OBD|OBC|OSV)_[A-Z_]+$/.test(error?.code||'')?error.code:'OSV_UNAVAILABLE';

export function createOwnerServiceLifecycle({inspect=inspectInstalledOwnerService,createSet=createOwnerDiscoverySetController,
  issueOwnerSession,revokeOwnerSession,clock=Date.now,schedule=setTimeout,cancel=clearTimeout}={}){
  if(![inspect,createSet,issueOwnerSession,revokeOwnerSession].every(f=>typeof f==='function'))fail('OSV_CONFIGURATION_REQUIRED');
  let state='idle',code=null,controller=null,authority=null,timer=null,epoch=0,stopRevision=0,abort=null,activationAbort=null,tokens=new Set(),admitted=true,stopping=false,queue=Promise.resolve();
  const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
  const activations=new Map();
  let pendingIssues=0,pendingRevocations=0,revocationUnconfirmed=false;
  async function revokeTracked(token){
    pendingRevocations++;
    try{return await revokeOwnerSession(token);}
    catch(error){revocationUnconfirmed=true;throw error;}
    finally{pendingRevocations--;}
  }
  const snapshot=()=>Object.freeze({state,code,ready:state==='ready'&&admitted&&!stopping&&clock()<authority.expiresAtUnixMs,expiresAtUnixMs:authority?.expiresAtUnixMs??null});
  async function drain(){stopping=true;abort?.abort();if(timer!==null){cancel(timer);timer=null;}if(controller){await controller.close();controller=null;}}
  function watch(endpoint,generation){
    endpoint.completion.then(()=>serial(async()=>{
      if(stopping||generation!==epoch||!controller)return;
      if(clock()>=authority.expiresAtUnixMs){stopping=true;state='expired';await drain();return;}
      state='refreshing';
      try{const next=await controller.refresh('cli');if(stopping||generation!==epoch)return;state='ready';watch(next,generation);}
      catch(error){if(!stopping&&generation===epoch){state='failed';code=codeOf(error);await drain();}}
    }),error=>serial(async()=>{
      if(stopping||generation!==epoch)return;
      stopping=true;state=clock()>=authority.expiresAtUnixMs?'expired':'failed';code=state==='expired'?null:codeOf(error);await drain();
    })).catch(error=>{if(generation===epoch){state='cleanup-required';code=codeOf(error);}});
  }
  async function startNow(context,expectedStop,trustedInput,ceiling=Infinity,pending=false){
      if(expectedStop!==stopRevision)fail('OSV_STOPPED');
      if(revocationUnconfirmed)fail('OSV_REVOCATION_UNCONFIRMED');
      if(controller||['starting','ready','refreshing','stopping','cleanup-required'].includes(state))fail('OSV_ALREADY_ACTIVE');
      const generation=++epoch;stopping=false;admitted=!pending;state='starting';code=null;authority=null;tokens=new Set();abort=new AbortController();
      try{
        const trusted=trustedInput??await inspect(context,{signal:abort.signal});
        if(stopping||generation!==epoch)fail('OSV_STOPPED');
        authority=Object.freeze({...trusted.authority,expiresAtUnixMs:Math.min(trusted.authority.expiresAtUnixMs,ceiling)});
        if(!Number.isSafeInteger(authority.expiresAtUnixMs)||authority.expiresAtUnixMs<=clock()||authority.expiresAtUnixMs>clock()+30000)fail('OSV_AUTHORITY_INVALID');
        controller=await createSet({releaseJson:trusted.releaseJson,installationJson:trusted.installationJson,
          executablePath:trusted.executablePath,enabledPurposes:['cli'],serveEndpoint:options=>serveOwnerBootstrapOnce({...options,signal:abort.signal}),
          issueOwnerSession:async(...args)=>{
            pendingIssues++;
            try{
            if(!admitted||stopping||generation!==epoch||clock()>=authority.expiresAtUnixMs)fail('OSV_STOPPED');
            const token=await issueOwnerSession(...args);
            if(stopping||generation!==epoch||clock()>=authority.expiresAtUnixMs){if(token)await revokeTracked(token);fail('OSV_STOPPED');}tokens.add(token);return token;
            }finally{pendingIssues--;}
          },revokeOwnerSession:revokeTracked,clock});
        if(stopping||generation!==epoch)fail('OSV_STOPPED');
        const endpoints=await controller.start(authority);
        if(stopping||generation!==epoch)fail('OSV_STOPPED');
        state='ready';watch(endpoints.cli,generation);
        timer=schedule(()=>{void serial(async()=>{if(stopping||generation!==epoch)return;stopping=true;state='expired';try{await drain();}catch(error){state='cleanup-required';code=codeOf(error);}});},Math.max(1,authority.expiresAtUnixMs-clock()));
        timer?.unref?.();return snapshot();
      }catch(error){stopping=true;state='failed';code=codeOf(error);try{await drain();}catch(cleanup){state='cleanup-required';code=codeOf(cleanup);}throw error;}
    }
  return Object.freeze({snapshot,
    start(context){const expectedStop=stopRevision;return serial(()=>startNow(context,expectedStop));},
    // Read-only queue barrier. Listener recovery never clears locks, retries a
    // revocation, inspects a new authority window or creates an endpoint here.
    assertRecoverySafe(){const expectedStop=stopRevision;return serial(async()=>{
      const refuse=reason=>{throw Object.assign(new Error('OSV_RECOVERY_REFUSED'),{code:'OSV_RECOVERY_REFUSED',recoveryReason:reason,recoveryState:state,recoveryCode:code});};
      if(expectedStop!==stopRevision)refuse('revision-changed');
      if(['stopping','stopped','cleanup-required','starting'].includes(state))refuse('state-blocked');
      if(revocationUnconfirmed)fail('OSV_REVOCATION_UNCONFIRMED');
      if(pendingIssues||pendingRevocations)fail('OSV_RECOVERY_PENDING');
      if(controller&&!['ready','refreshing'].includes(state))refuse('controller-state-mismatch');
      return true;
    });},
    activate(context,event,policy){const expectedStop=stopRevision;return serial(async()=>{
      if(expectedStop!==stopRevision||['stopping','stopped','cleanup-required'].includes(state))fail('OSV_STOPPED');
      if(revocationUnconfirmed)fail('OSV_REVOCATION_UNCONFIRMED');
      const request=validateOwnerActivationRequest(event,policy,{clock});
      for(const [id,deadline]of activations)if(deadline<=clock())activations.delete(id);
      if(activations.has(request.frame.requestId))fail('OSV_ACTIVATION_REPLAY');
      if(activations.size>=64)fail('OSV_ACTIVATION_CAPACITY');
      activations.set(request.frame.requestId,request.frame.expiresAtUnixMs);
      activationAbort=new AbortController();
      const trusted=await inspect(context,{signal:activationAbort.signal,ownerPeer:request.facts});
      if(expectedStop!==stopRevision)fail('OSV_STOPPED');
      if(!['instanceId','controlSid','ownerSid','ownerSessionId'].every(k=>trusted.authority[k]===policy[k]))fail('OSV_ACTIVATION_BINDING_MISMATCH');
      validateOwnerActivationRequest(event,policy,{clock});
      // A current window is reused, including its ORIGINAL deadline. An Owner
      // request cannot renew it, tear it down or roll it back through a new lease.
      if(snapshot().ready)return Object.freeze({commit:async()=>{},complete:async()=>{},rollback:async()=>{}});
      if(state==='ready'&&!admitted&&clock()<authority.expiresAtUnixMs)fail('OSV_ACTIVATION_PENDING');
      if(controller){stopping=true;++epoch;try{await drain();state=clock()>=authority.expiresAtUnixMs?'expired':'failed';}catch(error){state='cleanup-required';code=codeOf(error);throw error;}}
      await startNow(context,expectedStop,trusted,request.frame.expiresAtUnixMs,true);
      const generation=epoch,issued=tokens;let settled=false;
      return Object.freeze({commit:async()=>{if(settled||stopping||generation!==epoch||clock()>=authority.expiresAtUnixMs)fail('OSV_STOPPED');admitted=true;},complete:async()=>{settled=true;},rollback:()=>serial(async()=>{
        if(settled)return;settled=true;
        try{if(generation===epoch){stopping=true;++epoch;state='failed';code='OBC_DELIVERY_UNCONFIRMED';try{await drain();}catch(error){state='cleanup-required';code=codeOf(error);throw error;}}}
        // Revoke every token minted in the unconfirmed generation, including
        // one raced by another CLI before the activation receipt was lost.
        finally{
          const revoked=await Promise.allSettled([...issued].map(token=>revokeTracked(token)));
          const failed=revoked.find(result=>result.status==='rejected');
          if(failed){state='cleanup-required';code=codeOf(failed.reason);throw failed.reason;}
        }
      })});
    });},
    stop(){activationAbort?.abort();stopping=true;++epoch;++stopRevision;abort?.abort();state='stopping';return serial(async()=>{try{await drain();if(revocationUnconfirmed)fail('OSV_REVOCATION_UNCONFIRMED');state='stopped';code=null;}catch(error){state='cleanup-required';code=codeOf(error);throw error;}});},
  });
}
