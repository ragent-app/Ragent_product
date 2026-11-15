// Fixed installed entry. Pure validation below interprets PRIVATE OS evidence.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {OWNER_BOOTSTRAP_INSTALLED_PATHS,OWNER_BOOTSTRAP_INSTALLED_ROOT_WINDOWS,OWNER_INSPECTION_TIMEOUT_MS} from './windows-owner-discovery.mjs';
import {prepareOwnerInstallPolicy} from './windows-owner-install-policy.mjs';
import {activationExact as exact,validateOwnerActivationPolicy} from './windows-owner-activation-protocol.mjs';
import {ownerTrustFields,validOwnerTrustFacts,validOwnerReleaseBinding} from './windows-owner-release-trust.mjs';
import {ownerWindowsOsPaths} from './windows-owner-os-paths.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function validateOwnerActivationEvidence(observed){
  const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  if(!exact(observed,['version','aclVerified','helperSha256',...ownerTrustFields(observed),'ownerSid','ownerSessionId','releaseJson','installationJson'])
    ||!validOwnerTrustFacts(observed))fail('OBD_INSTALL_TRUST_FAILED');
  let release,install;
  try{for(const k of ['releaseJson','installationJson'])if(typeof observed[k]!=='string'||Buffer.byteLength(observed[k])>8192)fail('OBD_METADATA_INVALID');
    release=JSON.parse(observed.releaseJson);install=JSON.parse(observed.installationJson);
  }catch{fail('OBD_METADATA_INVALID');}
  if(!validOwnerReleaseBinding(release,observed))fail('OBD_RELEASE_MISMATCH');
  if(!exact(install,['version','instanceId','ownerSid','controlSid','executorSid','port'])||install.version!==1||install.port!==7690)fail('OBD_INSTALL_POLICY_INVALID');
  try{prepareOwnerInstallPolicy({instanceId:install.instanceId,ownerSid:install.ownerSid,controlSid:install.controlSid,executorSid:install.executorSid});}
  catch{fail('OBD_INSTALL_POLICY_INVALID');}
  if(install.ownerSid!==observed.ownerSid||!Number.isSafeInteger(observed.ownerSessionId)||observed.ownerSessionId<=0)fail('OBD_OWNER_MISMATCH');
  const policy=validateOwnerActivationPolicy({domain:'owner.activation.v1',instanceId:install.instanceId,controlSid:install.controlSid,ownerSid:install.ownerSid,ownerSessionId:observed.ownerSessionId});
  return Object.freeze({policy,executablePath:OWNER_BOOTSTRAP_INSTALLED_PATHS.helper,executableSha256:release.helperSha256});
}
export async function inspectInstalledOwnerActivation(){
  if(process.platform!=='win32')fail('OBD_PLATFORM_UNSUPPORTED');
  try{
    const paths=ownerWindowsOsPaths();if(!paths||!OWNER_BOOTSTRAP_INSTALLED_ROOT_WINDOWS)fail('OBD_OS_PATHS_UNAVAILABLE');
    const {stdout}=await promisify(execFile)(paths.powershell,
      ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../packaging/windows/read-owner-bootstrap-discovery.ps1',import.meta.url)),'-Purpose','activation'],
      {windowsHide:true,timeout:OWNER_INSPECTION_TIMEOUT_MS,maxBuffer:65536,env:{SystemRoot:paths.windows,WINDIR:paths.windows,SystemDrive:paths.windows.slice(0,2),RAGENT_INSTALL_ROOT:OWNER_BOOTSTRAP_INSTALLED_ROOT_WINDOWS}});
    const observed=JSON.parse(stdout.replace(/^\uFEFF/,''));if(observed?.ok===false&&/^OBD_[A-Z_]+$/.test(observed.code))fail(observed.code);
    return validateOwnerActivationEvidence(observed);
  }catch(error){if(/^(OBD|OBC)_[A-Z_]+$/.test(error?.code||''))throw error;fail(error?.killed===true?'OBD_INSPECTION_TIMEOUT':'OBD_INSPECTION_FAILED');}
}
