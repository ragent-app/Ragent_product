// Test-only local signed invitation/DPoP authority, no Accounts network service.
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,generateKeyPairSync,sign,createHash} from 'node:crypto';
export async function localControlAuthority(root){
  const config=join(root,'config');await mkdir(config,{recursive:true});
  Object.assign(process.env,{RAGENT_INSTANCE_ROOT:root,RAGENT_CONFIG_DIR:config,RAGENT_MEMORY_DIR:join(root,'memory'),
    RAGENT_RUN_SPOOL_DIR:join(root,'spool'),RAGENT_WORK_ROOT_DIR:join(root,'work'),RAGENT_PROVIDER_HOMES_DIR:join(root,'providers'),
    RAGENT_HARNESS_ROOT:join(root,'harnesses'),RAGENT_LOCAL_WEB_AUTH:'0',RAGENT_WINDOWS_SERVICE_MODE:'1',ProgramData:'C:/ProgramData'});
  const {loadOrCreateInstanceIdentity}=await import('../../lib/instance-identity.mjs');
  const {TemporaryPairingRegistry}=await import('../../chat/temporary-pairing-registry.mjs');
  const {TemporaryPairingHost}=await import('../../chat/temporary-pairing-host.mjs');
  const {buildTemporaryClaimMessage,temporaryInvitationDigest}=await import('../../lib/temporary-pairing-protocol.mjs');
  const {issueTemporaryAccessCredential,temporaryDeviceJwk}=await import('../../lib/temporary-device-access.mjs');
  const {TemporarySessionService}=await import('../../chat/temporary-session-service.mjs');
  const {TemporaryMessageService}=await import('../../chat/temporary-message-service.mjs');
  const {TemporaryResultService}=await import('../../chat/temporary-result-service.mjs');
  const meta=await import('../../chat/session-meta-store.mjs'),runs=await import('../../chat/runs.mjs');
  const identity=await loadOrCreateInstanceIdentity({filePath:join(config,'authority-identity.json')});
  const registry=new TemporaryPairingRegistry({filePath:join(config,'temporary-registry.json'),identity,clock:Date.now});
  const host=new TemporaryPairingHost({registry,client:{baseUrl:'https://isolated-authority.example.test'},binding:async()=>({accountId:'isolated-control-owner',boundAt:'2026-10-19T00:00:00.000Z'})});
  const sessions=new TemporarySessionService({host,workRoot:join(root,'work'),availableTools:async()=>[{id:'claude',name:'Claude'}],runtimeCatalog:async tools=>tools.map(x=>({...x,ready:true,status:'ready'}))});
  const messages=new TemporaryMessageService({host,schedule:()=>{}}),results=new TemporaryResultService({host});
  let count=0;
  async function enroll(){
    const device=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),ticket=await host.create();
    const claim={instanceId:identity.instanceId,invitationId:ticket.envelope.invitation.invitationId,invitationDigest:temporaryInvitationDigest(ticket.envelope.invitation),
      requestId:'rtr_'+randomBytes(24).toString('base64url'),token:ticket.token,devicePublicKey:device.publicKey.export({type:'spki',format:'pem'}).toString()};
    claim.signature=sign('sha256',Buffer.from(buildTemporaryClaimMessage(claim)),device.privateKey).toString('base64url');await registry.claim(claim);
    const row=(await registry.deliverySnapshot((await host.context()).bindingStamp)).records.find(x=>x.envelope.invitation.invitationId===claim.invitationId);
    await registry.recordDelivery(claim.invitationId,{completedGrantId:row.grant.grantId});
    const credential=issueTemporaryAccessCredential({identity,envelope:row.envelope,grant:row.grant});
    const enc=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),uri='https://isolated-control.example.test/messages';
    const input=enc({typ:'dpop+jwt',alg:'ES256',jwk:temporaryDeviceJwk(claim.devicePublicKey).jwk})+'.'+enc({htm:'POST',htu:uri,iat:Math.floor(Date.now()/1000),jti:randomBytes(24).toString('base64url'),ath:createHash('sha256').update(credential.access_token).digest('base64url')});
    const proof=input+'.'+sign('sha256',Buffer.from(input),{key:device.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
    return {principal:await host.authenticateRequest({credential,proof,method:'POST',targetUri:uri}),invitationId:claim.invitationId};
  }
  async function seed(profile,text){const phone=await enroll(),created=await sessions.create(phone.principal,{tool:'claude',idempotencyKey:'local-session-'+(++count)});
    const scope={version:1,sessionId:created.session.sessionId,expectedScopeRevision:created.session.scopeRevision,expectedProjectId:created.session.projectId};
    await meta.mutateSessionMeta(scope.sessionId,value=>{value.providerProfile=profile.id;value.model=profile.modelPolicy.defaultModel;return true;});
    const request={version:1,requestId:'credential-request-'+count,text,attachments:[],runOptions:{},expiresAt:new Date(Math.min(Date.now()+60000,phone.principal.expiry)).toISOString()};
    const prep=await messages.prepare(phone.principal,scope,request),commit={version:1,preparationId:prep.preparationId};
    const accepted=await messages.commit(phone.principal,scope,request.requestId,commit);return {...phone,scope,request,commit,runId:accepted.runId};
  }
  return {identity,host,registry,seed,enroll,results,messages,runs,config};
}
