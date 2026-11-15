import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessWindowsIdentityMigration as assess } from '../lib/windows-identity-migration.mjs';
const control='S-1-5-80-1-2-3-4-5',executor='S-1-5-80-6-7-8-9-10';
function snapshot(){
  const services=['Ragent-ControlPlane','Ragent-RunnerSupervisor'].map((name,i)=>({name,present:true,
    configuredAccount:'NT SERVICE\\'+name,serviceSid:i?executor:control,commandUsesOwnedHost:true,tokenDirectlyVerified:false,pid:100+i,state:'Running'}));
  return {schemaVersion:1,readOnly:true,credentialContentsRead:false,ownerIpcConnected:false,services,
    serviceObservationAfter:structuredClone(services),paths:['control-config','control-auth-key','instance-runtime','run-spool','provider-homes','harness-root','installed-host'].map(label=>({label,
      present:true,aclRead:true,protected:true,reparse:false,ownerSid:'S-1-5-18',rules:[{sid:control,type:'Allow',mask:0x1f01ff,propagation:'None'}]}))};
}
const has=(value,code)=>value.blockers.some(item=>item.code===code);
test('even ideal ACL/configuration inventory cannot certify migration or Owner IPC',()=>{
  const facts=snapshot();for(const row of facts.services)row.tokenDirectlyVerified=true;
  facts.serviceObservationAfter=structuredClone(facts.services);const result=assess(facts);
  assert.equal(result.migrationReady,false);assert.equal(result.mutationPerformed,false);assert.equal(result.effectiveAccessProven,false);
  assert.equal(result.metadataComplete,true);assert.ok(has(result,'PRODUCTION_OWNER_IPC_NOT_VALIDATED'));
  assert.ok(has(result,'PRODUCTION_CREDENTIAL_BROKER_NOT_INTEGRATED'));
});
test('shared SYSTEM registration and same service SID are blockers, not successful separation',()=>{
  const facts=snapshot();for(const row of facts.services){row.configuredAccount='LocalSystem';row.serviceSid=control;}
  facts.serviceObservationAfter=structuredClone(facts.services);const result=assess(facts);
  assert.equal(result.blockers.filter(x=>x.code==='SERVICE_IDENTITY_NOT_SEPARATED').length,2);
  assert.ok(has(result,'SERVICE_SIDS_NOT_DISTINCT'));assert.ok(has(result,'INSTALLED_TOKEN_NOT_VERIFIED'));
});
test('read/mutation allows to noncontrol identities remain risks even alongside deny ACEs',()=>{
  for(const mask of [1,2,0x10000,0x40000,0x80000]){
    const facts=snapshot();facts.paths[0].rules.push({sid:executor,type:'Deny',mask:0x1f01ff,propagation:'None'},
      {sid:executor,type:'Allow',mask,propagation:'None'});
    assert.ok(has(assess(facts),'CONTROL_ACL_HAS_NONCONTROL_ALLOW'));
  }
  const facts=snapshot();facts.paths[0].rules.push({sid:executor,type:'Allow',mask:0x1f01ff,propagation:'NoPropagateInherit, InheritOnly'});
  assert.equal(has(assess(facts),'CONTROL_ACL_HAS_NONCONTROL_ALLOW'),false);
});
test('missing/denied/reparse ACL and inherited control roots cannot be treated as effective denial',()=>{
  for(const patch of [{present:false},{aclRead:false},{reparse:true}]){
    const facts=snapshot();Object.assign(facts.paths[0],patch);const result=assess(facts);
    assert.ok(has(result,'CONTROL_ACL_NOT_OBSERVED'));assert.equal(result.metadataComplete,false);
  }
  const facts=snapshot();facts.paths[0].protected=false;assert.ok(has(assess(facts),'CONTROL_ACL_INHERITANCE_ENABLED'));
  const duplicate=snapshot();duplicate.paths[6]={...duplicate.paths[5]};assert.equal(assess(duplicate).metadataComplete,false);
});
test('service missing/duplicate/change observations cannot certify a stable cutover',()=>{
  const missing=snapshot();missing.services.pop();assert.ok(has(assess(missing),'SERVICE_NOT_OBSERVED'));
  const duplicate=snapshot();duplicate.services.push({...duplicate.services[0]});assert.ok(has(assess(duplicate),'SERVICE_NOT_OBSERVED'));
  const changed=snapshot();changed.serviceObservationAfter[0].pid++;assert.ok(has(assess(changed),'SERVICE_STATE_CHANGED_DURING_AUDIT'));
});
test('malformed or credential-reading inventory is rejected without echoing its data',()=>{
  for(const patch of [{schemaVersion:2},{readOnly:false},{services:null},{credentialContentsRead:true},{ownerIpcConnected:true}]){
    assert.throws(()=>assess({...snapshot(),...patch,privateValue:'SYNTHETIC-MUST-NOT-PRINT'}),
      error=>error.code==='WINDOWS_MIGRATION_INVENTORY_INVALID'&&!error.message.includes('SYNTHETIC'));
  }
});
