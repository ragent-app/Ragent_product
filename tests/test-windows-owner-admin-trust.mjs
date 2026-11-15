import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {validateOwnerActivationEvidence} from '../lib/windows-owner-activation-trust.mjs';
import {validateOwnerActivationServiceEvidence} from '../lib/windows-owner-service-trust.mjs';
import {validateOwnerDiscoveryEvidence} from '../lib/windows-owner-discovery.mjs';
import {ownerDiscoveryDescriptor} from '../lib/windows-owner-discovery-publication.mjs';
const now=100000,hash=v=>createHash('sha256').update(v).digest('hex');
test('fixed Windows trust inspectors bypass local policy and use the installed root for their packaged scripts',async()=>{
 for(const path of ['../lib/windows-owner-service-trust.mjs','../lib/windows-owner-activation-trust.mjs','../lib/windows-owner-discovery.mjs']){
  const source=await readFile(new URL(path,import.meta.url),'utf8');assert.match(source,/'-ExecutionPolicy','Bypass','-File'/,path);assert.match(source,/RAGENT_INSTALL_ROOT:OWNER_BOOTSTRAP_INSTALLED_ROOT_WINDOWS/,path);
 }
});
function fixture(){
 const release={version:2,protocolVersion:2,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:'a'.repeat(64),trustMode:'admin-installed-sha256'};
 const installation={version:1,instanceId:'inst_'+('d'.repeat(32)),controlSid:'S-1-5-80-1-2-3-4-5',executorSid:'S-1-5-80-6-7-8-9-10',ownerSid:'S-1-5-21-1-2-3-1001',port:7690};
 const observed={version:2,aclVerified:true,helperSha256:release.helperSha256,trustMode:release.trustMode,ownerSid:installation.ownerSid,ownerSessionId:1,releaseJson:JSON.stringify(release),installationJson:JSON.stringify(installation)};
 const peer={pid:1234,createdTicks:'134368500000000000',sid:installation.controlSid,sessionId:0,integrityRid:8192,elevated:false,enabledAdministrators:false};
 const policy={protocolVersion:2,purpose:'cli',pipeName:'ragent-owner-bootstrap-'+'c'.repeat(32),instanceId:installation.instanceId,requestId:'e'.repeat(32),expiresAtUnixMs:now+20000,controlSid:installation.controlSid,ownerSid:installation.ownerSid,ownerSessionId:1};
 return {release,installation,observed,peer,policy};
}
test('administratively installed v2 activation admits exact helper without invented signature/publisher facts',()=>{
 const f=fixture(),r=validateOwnerActivationEvidence(f.observed);assert.equal(r.executableSha256,f.release.helperSha256);assert.equal(r.policy.ownerSid,f.installation.ownerSid);assert.equal(r.executablePath,'C:/Program Files/Ragent/payload/Ragent.OwnerBootstrap.exe');
});
test('v2 cannot bypass ACL, integrity, owner/session, version or exact schema checks',()=>{
 for(const patch of [{aclVerified:false},{helperSha256:'b'.repeat(64)},{ownerSessionId:0},{ownerSid:'S-1-5-21-1-2-3-9999'},{trustMode:'allow-unsigned'},{version:1},{signatureStatus:'Valid'},{publisherSha256:'b'.repeat(64)},{helperPath:'C:/temp/a.exe'}])assert.throws(()=>validateOwnerActivationEvidence({...fixture().observed,...patch}));
 for(const patch of [{version:1},{helperFile:'cmd.exe'},{trustMode:'allow-unsigned'},{protocolVersion:1},{publisherSha256:'b'.repeat(64)}]){const f=fixture();Object.assign(f.release,patch);f.observed.releaseJson=JSON.stringify(f.release);assert.throws(()=>validateOwnerActivationEvidence(f.observed));}
});
test('a legacy manifest cannot acquire administrative trust by relabeling inspector evidence',()=>{
 const f=fixture();delete f.release.trustMode;Object.assign(f.release,{version:1,publisherSha256:'b'.repeat(64)});f.observed.releaseJson=JSON.stringify(f.release);assert.throws(()=>validateOwnerActivationEvidence(f.observed),{code:'OBD_RELEASE_MISMATCH'});
});
test('service listener validates v2 while requiring separated reduced service token and current observation',()=>{
 const f=fixture(),{ownerSid,ownerSessionId,...base}=f.observed;const e={...base,ownerSessionId:0,serviceFacts:f.peer,observedAtUnixMs:now},context={instanceRoot:'C:/ProgramData/Ragent/instances/owner',instanceId:f.installation.instanceId,host:'127.0.0.1',port:7690};
 assert.equal(validateOwnerActivationServiceEvidence(e,context,{clock:()=>now}).binding.ownerSessionId,0);
 for(const patch of [{aclVerified:false},{observedAtUnixMs:now-30000},{serviceFacts:{...f.peer,sid:'S-1-5-18'}},{serviceFacts:{...f.peer,elevated:true}}])assert.throws(()=>validateOwnerActivationServiceEvidence({...e,...patch},context,{clock:()=>now}));
});
test('v2 descriptor publication/discovery binds actual generations, live owner/session and fixed helper',()=>{
 const f=fixture(),descriptor=ownerDiscoveryDescriptor({releaseJson:f.observed.releaseJson,installationJson:f.observed.installationJson,policy:f.policy,peer:f.peer},{clock:()=>now});
 const e={...f.observed,liveJson:JSON.stringify(descriptor)},trusted=validateOwnerDiscoveryEvidence(e,{clock:()=>now,purpose:'cli'});assert.equal(trusted.trustMode,'admin-installed-sha256');assert.equal(trusted.publisherSha256,undefined);
 for(const patch of [{releaseSha256:'0'.repeat(64)},{installationSha256:'0'.repeat(64)},{peer:{...f.peer,sid:'S-1-5-18'}}])assert.throws(()=>validateOwnerDiscoveryEvidence({...e,liveJson:JSON.stringify({...descriptor,...patch})},{clock:()=>now,purpose:'cli'}));
 assert.equal(descriptor.releaseSha256,hash(f.observed.releaseJson));
});
