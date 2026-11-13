// Read-only installed trust boundary. No PATH/env overrides, IPC or session minting.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {win32} from 'node:path';
import {createHash} from 'node:crypto';
import {validateOwnerBootstrapPolicy} from './windows-owner-bootstrap-protocol.mjs';
import {ownerTrustFields,validOwnerTrustFacts,validOwnerReleaseBinding} from './windows-owner-release-trust.mjs';
import {ownerWindowsOsPaths} from './windows-owner-os-paths.mjs';
const exec=promisify(execFile),fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const digest=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const osPaths=ownerWindowsOsPaths();
// Layout calculation is not a trust decision; production supplies only the
// OS-resolved directories and the installation root verified by the inspector.
export function ownerLayoutForOs(paths,installRoot=''){
  const instanceRoot=paths?`${paths.programData.replaceAll('\\','/').replace(/\/+$/,'')}/AgentoC/instances/owner`:'';
  const root=(installRoot||(paths?`${paths.programFiles}\\AgentoC`:'')).replaceAll('\\','/').replace(/\/+$/,'');
  return Object.freeze({instanceRoot,root});
}
// This only supplies a candidate path. The native inspector still pins and
// validates the installed files, ACLs, policy and service identities before a
// client can receive authority. Source checkouts are not installed payloads.
export function ownerInstallRootFromModule(modulePath){
  if(typeof modulePath!=='string'||! /^[A-Za-z]:[\\/]/.test(modulePath))return '';
  const file=win32.normalize(modulePath),lib=win32.dirname(file),payload=win32.dirname(lib),root=win32.dirname(payload);
  if(win32.basename(file).toLowerCase()!=='windows-owner-discovery.mjs'||win32.basename(lib).toLowerCase()!=='lib'
    ||win32.basename(payload).toLowerCase()!=='payload'||root===win32.parse(root).root)return '';
  return root;
}
const moduleRoot=process.platform==='win32'?ownerInstallRootFromModule(fileURLToPath(import.meta.url)):'';
const layout=ownerLayoutForOs(osPaths,process.env.AGENTOC_INSTALL_ROOT||moduleRoot);
export const OWNER_INSTANCE_ROOT=layout.instanceRoot;
export const OWNER_BOOTSTRAP_INSTALLED_ROOT=layout.root;
export const OWNER_BOOTSTRAP_INSTALLED_ROOT_WINDOWS=OWNER_BOOTSTRAP_INSTALLED_ROOT.replaceAll('/','\\');
export const OWNER_BOOTSTRAP_INSTALLED_PATHS=Object.freeze({
  helper:OWNER_BOOTSTRAP_INSTALLED_ROOT?`${OWNER_BOOTSTRAP_INSTALLED_ROOT}/payload/AgentoC.OwnerBootstrap.exe`:'',
  release:OWNER_BOOTSTRAP_INSTALLED_ROOT?`${OWNER_BOOTSTRAP_INSTALLED_ROOT}/payload/owner-bootstrap-release.json`:'',
  installation:OWNER_INSTANCE_ROOT?`${OWNER_INSTANCE_ROOT}/security/owner-bootstrap-install.json`:'',
  live:OWNER_INSTANCE_ROOT?`${OWNER_INSTANCE_ROOT}/runtime/owner-bootstrap-live.json`:'',
  cliLive:OWNER_INSTANCE_ROOT?`${OWNER_INSTANCE_ROOT}/runtime/owner-bootstrap-cli-live.json`:'',
  browserLive:OWNER_INSTANCE_ROOT?`${OWNER_INSTANCE_ROOT}/runtime/owner-bootstrap-browser-live.json`:'',
  publisher:OWNER_INSTANCE_ROOT?`${OWNER_INSTANCE_ROOT}/runtime/owner-bootstrap-publisher.json`:'',
});
export function ownerDiscoveryPurposePath(purpose){
  if(!['cli','browser'].includes(purpose))fail('OBD_PURPOSE_INVALID');
  if(!OWNER_INSTANCE_ROOT)fail('OBD_OS_PATHS_UNAVAILABLE');
  return purpose==='cli'?OWNER_BOOTSTRAP_INSTALLED_PATHS.cliLive:OWNER_BOOTSTRAP_INSTALLED_PATHS.browserLive;
}

// Pure interpretation of a PRIVATE OS inspector result, not a public request.
// aclVerified/signature facts must come from inspectInstalledOwnerBootstrap.
export function validateOwnerDiscoveryEvidence(observed,{clock=Date.now,purpose}={}){
  if(purpose!==undefined)ownerDiscoveryPurposePath(purpose);
  if(!exact(observed,['version','aclVerified','helperSha256',...ownerTrustFields(observed),'ownerSid','ownerSessionId','releaseJson','installationJson','liveJson'])
    ||!validOwnerTrustFacts(observed))fail('OBD_INSTALL_TRUST_FAILED');
  let release,installation,live;
  try{
    for(const key of ['releaseJson','installationJson','liveJson'])if(typeof observed[key]!=='string'||Buffer.byteLength(observed[key])>8192)fail('OBD_METADATA_INVALID');
    release=JSON.parse(observed.releaseJson);installation=JSON.parse(observed.installationJson);live=JSON.parse(observed.liveJson);
  }catch{fail('OBD_METADATA_INVALID');}
  if(!validOwnerReleaseBinding(release,observed,{protocols:[1,2]}))fail('OBD_RELEASE_MISMATCH');
  if(!exact(installation,['version','instanceId','controlSid','executorSid','ownerSid','port'])||installation.version!==1
    ||installation.port!==7690||!/^S-1-5-80-(?:\d+-){4}\d+$/.test(installation.executorSid)
    ||installation.executorSid===installation.controlSid)fail('OBD_INSTALL_POLICY_INVALID');
  if(!exact(live,['version','policy','peer','releaseSha256','installationSha256'])||live.version!==1
    ||live.releaseSha256!==digest(observed.releaseJson)||live.installationSha256!==digest(observed.installationJson))fail('OBD_GENERATION_MISMATCH');
  let policy,expired=false;try{policy=validateOwnerBootstrapPolicy(live.policy,{clock});}catch{
    // Classify expiry only after the same structural and identity checks below.
    // The synthetic clock validates shape, never grants or extends authority.
    const expiry=live.policy?.expiresAtUnixMs;
    if(!Number.isSafeInteger(expiry)||expiry>clock())fail('OBD_ENDPOINT_POLICY_INVALID');
    try{policy=validateOwnerBootstrapPolicy(live.policy,{clock:()=>expiry-1});expired=true;}
    catch{fail('OBD_ENDPOINT_POLICY_INVALID');}
  }
  if((policy.protocolVersion??1)!==release.protocolVersion)fail('OBD_RELEASE_MISMATCH');
  if(purpose!==undefined&&(policy.protocolVersion!==2||policy.purpose!==purpose))fail('OBD_PURPOSE_MISMATCH');
  if(!['instanceId','controlSid','ownerSid'].every(key=>policy[key]===installation[key])
    ||policy.ownerSid!==observed.ownerSid||policy.ownerSessionId!==observed.ownerSessionId)fail('OBD_OWNER_MISMATCH');
  const peer=live.peer;
  if(!exact(peer,['pid','createdTicks','sid','sessionId','integrityRid','elevated','enabledAdministrators'])
    ||!Number.isSafeInteger(peer.pid)||peer.pid<=0||typeof peer.createdTicks!=='string'||!/^\d{10,20}$/.test(peer.createdTicks)
    ||peer.sid!==policy.controlSid||peer.sessionId!==0||peer.integrityRid!==8192||peer.elevated!==false||peer.enabledAdministrators!==false)fail('OBD_PEER_PIN_INVALID');
  if(expired)fail('OBD_ENDPOINT_POLICY_EXPIRED');
  return Object.freeze({instanceId:policy.instanceId,expiresAtUnixMs:policy.expiresAtUnixMs,baseUrl:'http://127.0.0.1:7690',
    ...(observed.version===2?{trustMode:release.trustMode}:{publisherSha256:release.publisherSha256}),executablePath:OWNER_BOOTSTRAP_INSTALLED_PATHS.helper,
    executableSha256:release.helperSha256,policy:Object.freeze({...policy,peer:Object.freeze({...peer})})});
}

// Cold inbox PowerShell startup alone exceeded 22s on a real hosted Windows OS.
// This is an inspection IO ceiling, never a grant/discovery deadline extension.
export const OWNER_INSPECTION_TIMEOUT_MS=60000;
export async function inspectInstalledOwnerBootstrap({purpose='cli'}={}){
  ownerDiscoveryPurposePath(purpose);
  if(process.platform!=='win32')fail('OBD_PLATFORM_UNSUPPORTED');
  const script=fileURLToPath(new URL('../packaging/windows/read-owner-bootstrap-discovery.ps1',import.meta.url));
  try{
    if(!osPaths||!OWNER_BOOTSTRAP_INSTALLED_ROOT)fail('OBD_OS_PATHS_UNAVAILABLE');
    const {stdout}=await exec(osPaths.powershell,
      ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Purpose',purpose],{windowsHide:true,timeout:OWNER_INSPECTION_TIMEOUT_MS,maxBuffer:65536,
      env:{SystemRoot:osPaths.windows,WINDIR:osPaths.windows,SystemDrive:osPaths.windows.slice(0,2),AGENTOC_INSTALL_ROOT:OWNER_BOOTSTRAP_INSTALLED_ROOT_WINDOWS}});
    const observed=JSON.parse(stdout.replace(/^\uFEFF/,''));
    if(observed?.ok===false&&/^OBD_[A-Z_]+$/.test(observed.code))fail(observed.code);
    return validateOwnerDiscoveryEvidence(observed,{purpose});
  }catch(error){if(/^OBD_[A-Z_]+$/.test(error?.code||''))throw error;fail(error?.killed===true?'OBD_INSPECTION_TIMEOUT':'OBD_INSPECTION_FAILED');}
}

export async function collectOwnerBootstrapDiagnostics({platform=process.platform}={}){
  if(platform!=='win32')return {platform,supported:false,status:'unsupported',scope:'owner-bootstrap'};
  try{
    const trusted=await inspectInstalledOwnerBootstrap();
    return {platform,supported:true,status:'ready',scope:'owner-bootstrap',readOnly:true,ownerIpcConnected:false,sessionIssued:false,
      identity:{status:'discovered',instanceId:trusted.instanceId},expiresAtUnixMs:trusted.expiresAtUnixMs};
  }catch(error){return {platform,supported:true,status:'failed',scope:'owner-bootstrap',readOnly:true,ownerIpcConnected:false,sessionIssued:false,
    error:{code:/^OBD_[A-Z_]+$/.test(error?.code||'')?error.code:'OBD_INSPECTION_FAILED',message:'Owner bootstrap is unavailable; verify the administrative installation, file integrity and separated service identities.'}};}
}
