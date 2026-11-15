// Private native-parent protocol; never accept these facts from HTTP/Run JSON.
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const ownerBootstrapVersion=policy=>policy?.protocolVersion??1;
export const isOwnerBootstrapInstanceId=value=>typeof value==='string'&&(
  (value.length===36&&/^[a-f0-9-]{36}$/.test(value))||(value.length===37&&/^inst_[a-f0-9]{32}$/.test(value)));
export const ownerBootstrapOperation=(policy,phase)=>ownerBootstrapVersion(policy)===1
  ?'owner.bootstrap'+(phase==='request'?'':'.'+phase)
  :'owner.'+policy.purpose+(phase==='request'?'':'.'+phase);
export function validateOwnerBootstrapPolicy(policy,{server=true,clock=Date.now}={}){
  const v2=ownerBootstrapVersion(policy)===2;
  if(!exact(policy,['pipeName','instanceId','requestId','expiresAtUnixMs','controlSid','ownerSid','ownerSessionId',...v2?['protocolVersion','purpose']:[],...(!server?['peer',...v2?['launchNonce']:[]]:[])])
    ||(v2&&!['browser','cli'].includes(policy.purpose))
    ||(v2&&!server&&!/^[a-f0-9]{64}$/.test(policy.launchNonce||''))
    ||!/^ragent-owner-bootstrap-[a-f0-9]{32}$/.test(policy.pipeName)
    ||!isOwnerBootstrapInstanceId(policy.instanceId)||! /^[a-f0-9]{32}$/.test(policy.requestId)
    ||! /^S-1-5-80-(?:\d+-){4}\d+$/.test(policy.controlSid)||! /^S-1-5-21-(?:\d+-){3}\d+$/.test(policy.ownerSid)
    ||!Number.isSafeInteger(policy.ownerSessionId)||policy.ownerSessionId<=0||policy.ownerSessionId>65535
    ||!Number.isSafeInteger(policy.expiresAtUnixMs)||policy.expiresAtUnixMs<=clock()||policy.expiresAtUnixMs>clock()+30000)fail('OBC_POLICY_INVALID');
  return Object.freeze(structuredClone(policy));
}
export function createOwnerBootstrapIssuer({policy,issueOwnerSession,issueBrowserTicket,clock=Date.now}){
  const fixed=validateOwnerBootstrapPolicy(policy,{clock});let used=false;
  const v2=ownerBootstrapVersion(fixed)===2,browser=v2&&fixed.purpose==='browser',issue=browser?issueBrowserTicket:issueOwnerSession;
  if(typeof issue!=='function')fail('OBC_ISSUER_REQUIRED');
  return Object.freeze({async accept(event){
    if(used)fail('OBC_ALREADY_USED');
    const facts=event?.facts,frame=event?.frame;
    if(event?.kind!=='request'||!facts||facts.sid!==fixed.ownerSid||facts.sessionId!==fixed.ownerSessionId
      ||!Number.isSafeInteger(facts.pid)||facts.pid<=0||! /^\d{10,20}$/.test(facts.createdTicks)
      ||facts.integrityRid!==8192||facts.elevated!==false||facts.enabledAdministrators!==false||facts.queryOnlyAuthorityVerified!==true)fail('OBC_PEER_IDENTITY_DENIED');
    if(!exact(frame,['version','operation','instanceId','requestId','expiresAtUnixMs','challenge',...v2?['launchNonce']:[]])
      ||frame.version!==ownerBootstrapVersion(fixed)||frame.operation!==ownerBootstrapOperation(fixed,'request'))fail('OBC_FRAME_INVALID');
    if(frame.instanceId!==fixed.instanceId||frame.requestId!==fixed.requestId||frame.expiresAtUnixMs!==fixed.expiresAtUnixMs)fail('OBC_BINDING_MISMATCH');
    if(clock()>=fixed.expiresAtUnixMs)fail('OBC_EXPIRED');
    if(! /^[A-Za-z0-9_-]{43}$/.test(frame.challenge))fail('OBC_CHALLENGE_DENIED');
    if(v2&&!/^[a-f0-9]{64}$/.test(frame.launchNonce||''))fail('OBC_LAUNCH_NONCE_INVALID');
    used=true; // An issuer failure or lost transport cannot replay this event.
    const value=await issue(Object.freeze({...facts}),Object.freeze({instanceId:fixed.instanceId,requestId:fixed.requestId,
      expiresAtUnixMs:fixed.expiresAtUnixMs,...v2?{purpose:fixed.purpose,launchNonce:frame.launchNonce}:{}}));
    if(clock()>=fixed.expiresAtUnixMs)fail('OBC_EXPIRED');
    if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value))fail('OBC_RESULT_INVALID');
    return {...frame,operation:ownerBootstrapOperation(fixed,'result'),[browser?'bootstrapTicket':'sessionToken']:value};
  }});
}
