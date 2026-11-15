// Service-side installed trust has no dependency on an existing live descriptor.
// Only the fixed OS inspector supplies these facts; no caller-provided evidence
// or user-selected helper/path is accepted by the installed entry.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {win32} from 'node:path';
import {OWNER_BOOTSTRAP_INSTALLED_PATHS,OWNER_BOOTSTRAP_INSTALLED_ROOT_WINDOWS,OWNER_INSPECTION_TIMEOUT_MS,OWNER_INSTANCE_ROOT} from './windows-owner-discovery.mjs';
import {ownerWindowsOsPaths} from './windows-owner-os-paths.mjs';
import {validateOwnerBootstrapPolicy,isOwnerBootstrapInstanceId} from './windows-owner-bootstrap-protocol.mjs';
import {validateOwnerActivationPolicy} from './windows-owner-activation-protocol.mjs';
import {ownerTrustFields,validOwnerTrustFacts,validOwnerReleaseBinding} from './windows-owner-release-trust.mjs';
const exec=promisify(execFile),fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const OWNER_SERVICE_ROOT=OWNER_INSTANCE_ROOT;
export function validateOwnerServiceContext(context){
  if(!OWNER_SERVICE_ROOT||!exact(context,['instanceRoot','instanceId','port','host'])||typeof context.instanceRoot!=='string'
    ||win32.normalize(context.instanceRoot).toLowerCase()!==win32.normalize(OWNER_SERVICE_ROOT).toLowerCase()
    ||context.port!==7690||context.host!=='127.0.0.1'||!isOwnerBootstrapInstanceId(context.instanceId))fail('OSV_CONTEXT_REFUSED');
}
// Pure PRIVATE inspector interpretation; this does not establish actual OS trust.
function validateEvidence(observed,context,{clock=Date.now,listener=false,ownerPeer}={}){
  validateOwnerServiceContext(context);
  if(!exact(observed,['version','aclVerified','helperSha256',...ownerTrustFields(observed),'releaseJson','installationJson','serviceFacts','ownerSessionId','observedAtUnixMs',...ownerPeer?['ownerPeer']:[]])
    ||!validOwnerTrustFacts(observed)
    ||!Number.isSafeInteger(observed.observedAtUnixMs)||observed.observedAtUnixMs>clock()||observed.observedAtUnixMs+30000<=clock())fail('OSV_INSTALL_TRUST_FAILED');
  let release,installation;
  try{for(const key of ['releaseJson','installationJson'])if(typeof observed[key]!=='string'||Buffer.byteLength(observed[key])>8192)fail('OSV_METADATA_INVALID');
    release=JSON.parse(observed.releaseJson);installation=JSON.parse(observed.installationJson);
  }catch{fail('OSV_METADATA_INVALID');}
  if(!validOwnerReleaseBinding(release,observed))fail('OSV_RELEASE_MISMATCH');
  if(!exact(installation,['version','instanceId','controlSid','executorSid','ownerSid','port'])||installation.version!==1||installation.instanceId!==context.instanceId
    ||installation.port!==7690||!/^S-1-5-80-(?:\d+-){4}\d+$/.test(installation.executorSid)||installation.executorSid===installation.controlSid)fail('OSV_INSTALL_POLICY_INVALID');
  const facts=observed.serviceFacts;
  if(!exact(facts,['pid','createdTicks','sid','sessionId','integrityRid','elevated','enabledAdministrators'])||!Number.isSafeInteger(facts.pid)||facts.pid<=0
    ||!/^\d{10,20}$/.test(facts.createdTicks||'')||facts.sid!==installation.controlSid||facts.sessionId!==0||facts.integrityRid!==8192||facts.elevated!==false||facts.enabledAdministrators!==false)fail('OSV_SERVICE_IDENTITY_DENIED');
  const authority=Object.freeze({instanceId:installation.instanceId,controlSid:installation.controlSid,ownerSid:installation.ownerSid,
    ownerSessionId:observed.ownerSessionId,expiresAtUnixMs:observed.observedAtUnixMs+30000});
  if(listener){
    if(observed.ownerSessionId!==0)fail('OSV_AUTHORITY_INVALID');
    const binding=validateOwnerActivationPolicy({domain:'owner.activation.v1',instanceId:installation.instanceId,controlSid:installation.controlSid,ownerSid:installation.ownerSid,ownerSessionId:0});
    return Object.freeze({releaseJson:observed.releaseJson,executablePath:OWNER_BOOTSTRAP_INSTALLED_PATHS.helper,binding});
  }
  if(ownerPeer){const actual=observed.ownerPeer;
    if(!exact(actual,['pid','createdTicks','sid','sessionId','integrityRid','elevated','enabledAdministrators','queryOnlyAuthorityVerified'])
      ||!['pid','createdTicks','sid','sessionId'].every(k=>actual[k]===ownerPeer[k])||actual.sid!==installation.ownerSid||actual.sessionId!==observed.ownerSessionId
      ||actual.integrityRid!==8192||actual.elevated!==false||actual.enabledAdministrators!==false||actual.queryOnlyAuthorityVerified!==true)fail('OSV_OWNER_PEER_DENIED');
  }
  try{validateOwnerBootstrapPolicy({...authority,protocolVersion:2,purpose:'cli',pipeName:'ragent-owner-bootstrap-'+'0'.repeat(32),requestId:'0'.repeat(32)},{clock});}
  catch{fail('OSV_AUTHORITY_INVALID');}
  return Object.freeze({releaseJson:observed.releaseJson,installationJson:observed.installationJson,executablePath:OWNER_BOOTSTRAP_INSTALLED_PATHS.helper,authority});
}
export const validateOwnerServiceEvidence=(observed,context,options)=>validateEvidence(observed,context,{clock:options?.clock,ownerPeer:options?.ownerPeer});
export const validateOwnerActivationServiceEvidence=(observed,context,options)=>validateEvidence(observed,context,{clock:options?.clock,listener:true});
async function inspect(context,{signal,listener=false,ownerPeer}={}){
  validateOwnerServiceContext(context);
  if(!listener&&(!ownerPeer||!Number.isSafeInteger(ownerPeer.pid)||ownerPeer.pid<=0||typeof ownerPeer.createdTicks!=='string'||!/^\d{10,20}$/.test(ownerPeer.createdTicks)
    ||!Number.isSafeInteger(ownerPeer.sessionId)||ownerPeer.sessionId<=0||ownerPeer.sessionId>65535||ownerPeer.queryOnlyAuthorityVerified!==true))fail('OSV_NATIVE_OWNER_REQUIRED');
  if(process.platform!=='win32')fail('OSV_PLATFORM_UNSUPPORTED');
  try{
    const paths=ownerWindowsOsPaths();if(!paths||!OWNER_BOOTSTRAP_INSTALLED_ROOT_WINDOWS)fail('OSV_OS_PATHS_UNAVAILABLE');
    const {stdout}=await exec(paths.powershell,
      ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../packaging/windows/read-owner-service-trust.ps1',import.meta.url)),...listener?['-ActivationListener']:['-OwnerPeerPid',String(ownerPeer.pid),'-OwnerPeerCreatedTicks',ownerPeer.createdTicks,'-OwnerPeerSessionId',String(ownerPeer.sessionId)]],
      {windowsHide:true,timeout:OWNER_INSPECTION_TIMEOUT_MS,maxBuffer:65536,signal,env:{SystemRoot:paths.windows,WINDIR:paths.windows,SystemDrive:paths.windows.slice(0,2),RAGENT_INSTALL_ROOT:OWNER_BOOTSTRAP_INSTALLED_ROOT_WINDOWS}});
    const observed=JSON.parse(stdout.replace(/^\uFEFF/,''));if(observed?.ok===false&&/^(?:OBD|OSV)_[A-Z_]+$/.test(observed.code))fail(observed.code);
    return validateEvidence(observed,context,{listener,ownerPeer});
  }catch(error){if(/^(?:OBD|OSV)_[A-Z_]+$/.test(error?.code||''))throw error;fail(signal?.aborted?'OSV_ABORTED':error?.killed===true?'OSV_INSPECTION_TIMEOUT':'OSV_INSPECTION_FAILED');}
}
export const inspectInstalledOwnerService=(context,{signal,ownerPeer}={})=>inspect(context,{signal,ownerPeer});
export const inspectInstalledOwnerActivationService=(context,{signal}={})=>inspect(context,{signal,listener:true});
