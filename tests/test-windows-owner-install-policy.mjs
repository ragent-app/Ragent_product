import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareOwnerInstallPolicy} from '../lib/windows-owner-install-policy.mjs';
import {validateOwnerServiceEvidence} from '../lib/windows-owner-service-trust.mjs';
const input={instanceId:'inst_'+'a'.repeat(32),ownerSid:'S-1-5-21-1-2-3-1001',controlSid:'S-1-5-80-1-2-3-4-5',executorSid:'S-1-5-80-6-7-8-9-10'};
test('prepared policy uses only the fixed owned paths and existing ID, activates nothing',()=>{
  const plan=prepareOwnerInstallPolicy(input);assert.ok(Object.isFrozen(plan)&&Object.isFrozen(plan.policy));assert.equal(plan.policy.instanceId,input.instanceId);assert.equal(plan.policy.port,7690);
  assert.equal(plan.installationPath,'C:/ProgramData/Ragent/instances/owner/security/owner-bootstrap-install.json');assert.equal(plan.runtimeDirectory,'C:/ProgramData/Ragent/instances/owner/runtime');
  assert.equal(plan.mutationPerformed,false);assert.equal(plan.migrationReady,false);assert.equal(plan.servicesActivated,false);assert.deepEqual(Object.keys(plan.policy),['version','instanceId','controlSid','executorSid','ownerSid','port']);
  assert.equal(prepareOwnerInstallPolicy({...input,instanceId:'00000000-0000-4000-8000-000000000000'}).policy.instanceId,'00000000-0000-4000-8000-000000000000');
});
test('caller paths, private credentials, port/extra identity fields are rejected',()=>{
  for(const extra of [{path:'C:/override'},{port:8888},{privateKey:'secret'},{password:'secret'},{purpose:'activate'},{version:1},{username:'owner'}])assert.throws(()=>prepareOwnerInstallPolicy({...input,...extra}),{code:'OIP_POLICY_INVALID'});
});
test('SYSTEM, other service kinds, cross-role identity and malformed IDs refuse',()=>{
  for(const change of [{ownerSid:'S-1-5-18'},{ownerSid:input.controlSid},{ownerSid:input.ownerSid+'\n'},{controlSid:input.executorSid},{controlSid:'S-1-5-21-1-2-3-1002'},{executorSid:input.executorSid+'\r\n'},{instanceId:'new'},{instanceId:input.instanceId+'\n'}])assert.throws(()=>prepareOwnerInstallPolicy({...input,...change}),{code:'OIP_POLICY_INVALID'});
  for(const value of [null,undefined,[],{...input,executorSid:undefined}])assert.throws(()=>prepareOwnerInstallPolicy(value),{code:'OIP_POLICY_INVALID'});
});
test('prepared public JSON satisfies original installed service validation without new fields',()=>{
  const plan=prepareOwnerInstallPolicy(input),now=Date.now();
  const observed={version:1,aclVerified:true,helperSha256:'a'.repeat(64),signatureStatus:'Valid',publisherSha256:'b'.repeat(64),
    releaseJson:JSON.stringify({version:1,protocolVersion:2,helperFile:'Ragent.OwnerBootstrap.exe',helperSha256:'a'.repeat(64),publisherSha256:'b'.repeat(64)}),installationJson:JSON.stringify(plan.policy),
    serviceFacts:{pid:100,createdTicks:'134368500000000000',sid:input.controlSid,sessionId:0,integrityRid:8192,elevated:false,enabledAdministrators:false},ownerSessionId:1,observedAtUnixMs:now};
  const trusted=validateOwnerServiceEvidence(observed,{instanceRoot:'C:/ProgramData/Ragent/instances/owner',instanceId:input.instanceId,port:7690,host:'127.0.0.1'},{clock:()=>now});assert.equal(trusted.authority.instanceId,input.instanceId);assert.equal(trusted.authority.ownerSid,input.ownerSid);
});
