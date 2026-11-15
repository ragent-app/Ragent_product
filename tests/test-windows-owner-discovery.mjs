import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {validateOwnerDiscoveryEvidence,OWNER_BOOTSTRAP_INSTALLED_PATHS} from '../lib/windows-owner-discovery.mjs';
import {runDoctorCommand} from '../lib/doctor-command.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
  const now=100000,ownerSid='S-1-5-21-1-2-3-1001',controlSid='S-1-5-80-1-2-3-4-5',instanceId=randomUUID();
  const release={version:1,protocolVersion:1,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:'a'.repeat(64),publisherSha256:'b'.repeat(64)};
  const installation={version:1,instanceId,controlSid,executorSid:'S-1-5-80-6-7-8-9-10',ownerSid,port:7690};
  const live={version:1,policy:{pipeName:'ragent-owner-bootstrap-'+'c'.repeat(32),instanceId,requestId:'d'.repeat(32),expiresAtUnixMs:now+20000,controlSid,ownerSid,ownerSessionId:1},
    peer:{pid:1234,createdTicks:'134368500000000000',sid:controlSid,sessionId:0,integrityRid:8192,elevated:false,enabledAdministrators:false}};
  const observed={version:1,aclVerified:true,signatureStatus:'Valid',helperSha256:release.helperSha256,publisherSha256:release.publisherSha256,ownerSid,ownerSessionId:1};
  const evidence=()=>({...observed,releaseJson:JSON.stringify(release),installationJson:JSON.stringify(installation),liveJson:JSON.stringify({...live,releaseSha256:hash(JSON.stringify(release)),installationSha256:hash(JSON.stringify(installation))})});
  return {release,installation,live,observed,evidence,options:{clock:()=>now}};
}
test('trusted private inspector result fixes owned helper and origin; endpoint remains unverified until native IPC',()=>{
  const f=fixture(),v=validateOwnerDiscoveryEvidence(f.evidence(),f.options);assert.equal(v.executablePath,OWNER_BOOTSTRAP_INSTALLED_PATHS.helper);assert.equal(v.baseUrl,'http://127.0.0.1:7690');
  assert.equal(v.policy.peer.pid,1234);assert.ok(Object.isFrozen(v.policy)&&Object.isFrozen(v.policy.peer));assert.equal(v.sessionToken,undefined);
});
test('untrusted ACL, missing signature/publisher and unsigned helper cannot enter discovery',()=>{
  for(const patch of [{aclVerified:false},{signatureStatus:'NotSigned'},{signatureStatus:'UnknownError'},{publisherSha256:''},{helperSha256:'invalid'},{extra:true}]){
    const f=fixture();assert.throws(()=>validateOwnerDiscoveryEvidence({...f.evidence(),...patch},f.options),{code:'OBD_INSTALL_TRUST_FAILED'});
  }
});
test('helper substitution, changed publisher, arbitrary executable and unknown metadata fields fail closed',()=>{
  for(const patch of [{helperFile:'cmd.exe'},{helperSha256:'e'.repeat(64)},{publisherSha256:'f'.repeat(64)},{command:'shell'},{protocolVersion:2}]){
    const f=fixture();Object.assign(f.release,patch);assert.throws(()=>validateOwnerDiscoveryEvidence(f.evidence(),f.options),{code:'OBD_RELEASE_MISMATCH'});
  }
});
test('live descriptor cannot survive release or installation generation changes',()=>{
  for(const key of ['releaseSha256','installationSha256']){const f=fixture(),e=f.evidence(),live=JSON.parse(e.liveJson);live[key]='0'.repeat(64);e.liveJson=JSON.stringify(live);
    assert.throws(()=>validateOwnerDiscoveryEvidence(e,f.options),{code:'OBD_GENERATION_MISMATCH'});}
});
test('wrong owner/session/control/instance, remote pipe, changed port, expiry and extension are refused',()=>{
  for(const patch of [{ownerSid:'S-1-5-21-9-8-7-1002'},{ownerSessionId:2},{controlSid:'S-1-5-80-7-7-7-7-7'},{instanceId:randomUUID()},
    {pipeName:'\\\\remote\\pipe\\x'},{expiresAtUnixMs:1},{expiresAtUnixMs:999999}]){const f=fixture();Object.assign(f.live.policy,patch);assert.throws(()=>validateOwnerDiscoveryEvidence(f.evidence(),f.options));}
  for(const patch of [{port:7691},{executorSid:'S-1-5-80-1-2-3-4-5'},{path:'override'}]){const f=fixture();Object.assign(f.installation,patch);assert.throws(()=>validateOwnerDiscoveryEvidence(f.evidence(),f.options),{code:'OBD_INSTALL_POLICY_INVALID'});}
});
test('unsafe peer metadata and malformed/oversized records are not authenticated',()=>{
  for(const patch of [{sid:'S-1-5-18'},{sessionId:1},{integrityRid:12288},{elevated:true},{enabledAdministrators:true},{pid:0},{createdTicks:134368500000000000},{extra:true}]){
    const f=fixture();Object.assign(f.live.peer,patch);assert.throws(()=>validateOwnerDiscoveryEvidence(f.evidence(),f.options),{code:'OBD_PEER_PIN_INVALID'});}
  for(const value of ['{','x'.repeat(8193)]){const f=fixture();assert.throws(()=>validateOwnerDiscoveryEvidence({...f.evidence(),releaseJson:value},f.options),{code:'OBD_METADATA_INVALID'});}
});
test('doctor selects read-only Owner diagnostics without forwarding environment path overrides or using runtime diagnostics',async()=>{
  let output='',calls=0;
  const code=await runDoctorCommand(['--owner-bootstrap','--json'],{platform:'win32',env:{RAGENT_OWNER_HELPER:'untrusted'},
    diagnosticsImpl:async()=>{throw new Error('Wrong path');},ownerBootstrapDiagnosticsImpl:async options=>{calls++;assert.deepEqual(options,{platform:'win32'});return {platform:'win32',status:'failed',scope:'owner-bootstrap',readOnly:true,ownerIpcConnected:false,sessionIssued:false};},writer:value=>output+=value});
  assert.equal(code,2);assert.equal(calls,1);assert.equal(JSON.parse(output).sessionIssued,false);
});
