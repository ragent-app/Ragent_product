// Candidate native adapter. No HTTP listener or installer enablement here.
// executablePath/sha256 and policies are private control/installation inputs,
// not caller-supplied Run settings. Defaults use the owned shipped binary only.
import {spawn} from 'node:child_process';
import {readFile,lstat} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {createOwnerBootstrapIssuer,validateOwnerBootstrapPolicy,ownerBootstrapVersion} from './windows-owner-bootstrap-protocol.mjs';
import {validateOwnerActivationPolicy,validateOwnerActivationRequest} from './windows-owner-activation-protocol.mjs';
import {ownerWindowsOsPaths} from './windows-owner-os-paths.mjs';
import {OWNER_BOOTSTRAP_INSTALLED_ROOT} from './windows-owner-discovery.mjs';
const typed=code=>Object.assign(new Error(code),{code});
function endpointError(value,expected,mode){
  const code=/^OBC_[A-Z_]+$/.test(value?.code||'')?value.code:'OBC_ENDPOINT_EXIT';
  const error=typed(code), details=[];
  const stages=['bootstrap','private-policy','pipe-create','connect','challenge','issue','receipt','result'];
  const types=['Win32Exception','IOException','EndOfStreamException','InvalidOperationException','ObjectDisposedException','TimeoutException'];
  if(stages.includes(value?.stage)){error.nativeStage=value.stage;details.push(`nativeStage=${value.stage}`);}
  if(types.includes(value?.type)){error.nativeType=value.type;details.push(`nativeType=${value.type}`);}
  if(Number.isInteger(value?.win32)&&value.win32>=0&&value.win32<=65535){error.nativeWin32=value.win32;details.push(`nativeWin32=${value.win32}`);}
  if(value?.kind==='exit'&&Number.isInteger(value.code)&&value.code>=0&&value.code<=255){error.nativeExitCode=value.code;details.push(`nativeExitCode=${value.code}`);}
  if(['identity','ready','request','receipt','result'].includes(expected)){error.expectedStage=expected;details.push(`expectedStage=${expected}`);}
  if(mode==='client'&&expected==='result'&&code==='OBC_TRANSPORT_FAILED'&&error.nativeStage==='connect'&&error.nativeType==='Win32Exception'&&[2,231].includes(error.nativeWin32))error.bootstrapConnectUnsent=true;
  if(details.length)error.message+=` (${details.join(', ')})`;
  return error;
}
const osPaths=ownerWindowsOsPaths();
const installedRoot=OWNER_BOOTSTRAP_INSTALLED_ROOT;
const installedHelper=installedRoot?`${installedRoot}/payload/Ragent.OwnerBootstrap.exe`:'';
async function openEndpoint({mode,policy,executablePath=installedHelper,executableSha256,signal},activation){
  if(process.platform!=='win32'||!(activation?['activation-server','activation-client']:['server','client']).includes(mode))throw typed('OBC_PLATFORM_OR_MODE_INVALID');
  if(activation)validateOwnerActivationPolicy(policy);else validateOwnerBootstrapPolicy(policy,{server:mode==='server'});
  const file=await lstat(executablePath);
  if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||! /^[a-f0-9]{64}$/.test(executableSha256||'')
    ||createHash('sha256').update(await readFile(executablePath)).digest('hex')!==executableSha256)throw typed('OBC_HELPER_INVALID');
  if(signal?.aborted)throw typed('OBC_ABORTED');
  if(!osPaths)throw typed('OBC_OS_PATHS_UNAVAILABLE');
  const child=spawn(executablePath,[mode],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:osPaths.windows,WINDIR:osPaths.windows,SystemDrive:osPaths.windows.slice(0,2)}});
  const queue=[],waiting=[];let buffer='',closed=false;const deliver=item=>waiting.length?waiting.shift()(item):queue.push(item);
  const exit=new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);});
  child.stdin.on('error',()=>{});child.stderr.resume();
  child.stdout.on('data',bytes=>{
    buffer+=bytes.toString('utf8');if(Buffer.byteLength(buffer)>32768){child.kill();deliver({kind:'error',code:'OBC_NATIVE_OUTPUT_INVALID'});return;}
    for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
      try{deliver(JSON.parse(line));}catch{deliver({kind:'error',code:'OBC_NATIVE_OUTPUT_INVALID'});}}
  });
  const abort=()=>{child.kill();deliver({kind:'error',code:'OBC_ABORTED'});};signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{child.kill();deliver({kind:'error',code:'OBC_ENDPOINT_DEADLINE'});},activation?66000:Math.max(1,policy.expiresAtUnixMs-Date.now()+1000));
  exit.then(code=>{closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);deliver({kind:'exit',code});});
  const endpoint={exit,pid:child.pid,send:value=>child.stdin.write(JSON.stringify(value)+'\n'),
    async next(){return queue.length?queue.shift():closed?{kind:'exit'}:new Promise(done=>waiting.push(done));},
    async expect(kind){const value=await this.next();if(value.kind!==kind)throw endpointError(value,kind,mode);return value;},
    async close(){child.stdin.end();if(!closed)child.kill();await exit;},
  };
  endpoint.send(policy);return endpoint;
}
export const openOwnerBootstrapEndpoint=options=>openEndpoint(options,false);
export async function serveOwnerActivationOnce({activate,...options}){
  if(typeof activate!=='function')throw typed('OBC_ACTIVATOR_REQUIRED');
  const endpoint=await openEndpoint({...options,mode:'activation-server'},true);
  try{
    const self=await endpoint.expect('identity');await endpoint.expect('ready');
    const completion=(async()=>{let lease;
      try{
        const request=validateOwnerActivationRequest(await endpoint.expect('request'),options.policy);
        lease=await activate(request,options.policy);
        endpoint.send({...request.frame,operation:'owner.activation.ready'});
        await endpoint.expect('receipt');
        await lease.commit();
        endpoint.send({...request.frame,operation:'owner.activation.committed'});
        if(await endpoint.exit!==0)throw typed('OBC_DELIVERY_UNCONFIRMED');
        await lease.complete();
      }catch(error){if(lease)await lease.rollback();throw error;}
      finally{await endpoint.close();}
    })();completion.catch(()=>{});
    return {self,completion,async close(){await endpoint.close();await completion.catch(()=>{});}};
  }catch(error){await endpoint.close();throw error;}
}
export async function requestInstalledOwnerActivation({signal}={}){
  const {inspectInstalledOwnerActivation}=await import('./windows-owner-activation-trust.mjs');
  const trusted=await inspectInstalledOwnerActivation();
  return requestOwnerActivation({...trusted,signal});
}
// Private adapter, like requestOwnerBootstrap below. Installation owns these
// inputs; the installed caller above never forwards caller-selected policies.
export async function requestOwnerActivation(options){
  const endpoint=await openEndpoint({...options,mode:'activation-client'},true);
  try{await endpoint.expect('identity');const result=await endpoint.expect('result');if(await endpoint.exit!==0)throw typed('OBC_DELIVERY_UNCONFIRMED');return Object.freeze({server:Object.freeze({...result.facts})});}
  finally{await endpoint.close();}
}
async function serveBootstrap({issueOwnerSession,revokeOwnerSession,issueBrowserTicket,revokeBrowserTicket,confirmBrowserTicket,...options}){
  const browser=ownerBootstrapVersion(options.policy)===2&&options.policy.purpose==='browser',revoke=browser?revokeBrowserTicket:revokeOwnerSession;
  if(typeof(browser?issueBrowserTicket:issueOwnerSession)!=='function')throw typed('OBC_ISSUER_REQUIRED');
  if(typeof revoke!=='function')throw typed('OBC_REVOKER_REQUIRED');
  if(browser&&typeof confirmBrowserTicket!=='function')throw typed('OBC_CONFIRMER_REQUIRED');
  let minted='';
  const issuer=createOwnerBootstrapIssuer({policy:options.policy,
    ...browser?{issueBrowserTicket:async(facts,binding)=>{minted=await issueBrowserTicket(facts,binding);return minted;}}:
      {issueOwnerSession:async(facts,binding)=>{minted=await issueOwnerSession(facts,binding);return minted;}}});
  const endpoint=await openOwnerBootstrapEndpoint({...options,mode:'server'});
  try{
    const self=await endpoint.expect('identity'),ready=await endpoint.expect('ready');
    const completion=(async()=>{
      try{const event=await endpoint.expect('request');const result=await issuer.accept(event);endpoint.send(result);
        if(await endpoint.exit!==0)throw typed('OBC_DELIVERY_UNCONFIRMED');
        if(browser)await confirmBrowserTicket(minted);
        return {facts:event.facts,issued:true,requestId:options.policy.requestId};
      }catch(error){if(minted){await revoke(minted);minted='';}throw error;}
    })();completion.catch(()=>{});
    return {ready,self,completion,endpoint,issuer,async close(){await endpoint.close();await completion.catch(()=>{});}};
  }catch(error){await endpoint.close();throw error;}
}
export async function serveOwnerBootstrapOnce(options){
  if(ownerBootstrapVersion(options?.policy)===2&&options.policy.purpose==='browser')throw typed('OBC_PURPOSE_DENIED');
  return serveBootstrap(options);
}
export async function serveOwnerBrowserBootstrapOnce(options){
  if(ownerBootstrapVersion(options?.policy)!==2||options.policy.purpose!=='browser')throw typed('OBC_PURPOSE_DENIED');
  return serveBootstrap(options);
}
export async function requestOwnerBootstrap(options){
  if(ownerBootstrapVersion(options?.policy)===2&&options.policy.purpose==='browser')throw typed('OBC_PURPOSE_DENIED');
  const endpoint=await openOwnerBootstrapEndpoint({...options,mode:'client'});
  try{await endpoint.expect('identity');const result=await endpoint.expect('result');if(await endpoint.exit!==0)throw typed('OBC_DELIVERY_UNCONFIRMED');
    return {sessionToken:result.outcome.sessionToken,server:result.facts};
  }finally{await endpoint.close();}
}
export async function requestOwnerBrowserBootstrap(options){
  if(ownerBootstrapVersion(options?.policy)!==2||options.policy.purpose!=='browser')throw typed('OBC_PURPOSE_DENIED');
  const endpoint=await openOwnerBootstrapEndpoint({...options,mode:'client'});
  try{await endpoint.expect('identity');const result=await endpoint.expect('result');if(await endpoint.exit!==0)throw typed('OBC_DELIVERY_UNCONFIRMED');
    return {bootstrapTicket:result.outcome.bootstrapTicket,launchNonce:result.outcome.launchNonce,
      instanceId:options.policy.instanceId,expiresAtUnixMs:options.policy.expiresAtUnixMs,server:result.facts};
  }finally{await endpoint.close();}
}

// Installed caller entry: paths, publisher/hash and peer pins come only from
// protected discovery. Do not accept a Run/HTTP body or environment override.
export async function requestInstalledOwnerBootstrap({signal}={}){
  const {inspectInstalledOwnerBootstrap}=await import('./windows-owner-discovery.mjs');
  const trusted=await inspectInstalledOwnerBootstrap({purpose:'cli'});
  const result=await requestOwnerBootstrap({policy:{...trusted.policy,launchNonce:randomBytes(32).toString('hex')},executablePath:trusted.executablePath,
    executableSha256:trusted.executableSha256,signal});
  return Object.freeze({...result,baseUrl:trusted.baseUrl,instanceId:trusted.instanceId});
}

// The launcher supplies only its fresh nonce, never path/purpose/peer/origin pins.
export async function requestInstalledOwnerBrowserBootstrap({launchNonce,signal}={}){
  const {inspectInstalledOwnerBootstrap}=await import('./windows-owner-discovery.mjs');
  const trusted=await inspectInstalledOwnerBootstrap({purpose:'browser'});
  const result=await requestOwnerBrowserBootstrap({policy:{...trusted.policy,launchNonce},executablePath:trusted.executablePath,
    executableSha256:trusted.executableSha256,signal});
  return Object.freeze({url:trusted.baseUrl+'/local-bootstrap#'+new URLSearchParams({ticket:result.bootstrapTicket,nonce:result.launchNonce,instance:result.instanceId}),expiresAtUnixMs:result.expiresAtUnixMs});
}
