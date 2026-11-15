// Independently recheck downloaded guest facts; no guest execution or SCM IO.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const [root,runId,sourceCommit,sourceSha256]=process.argv.slice(2);
assert.ok(root&&/^\d+$/.test(runId)&&/^[a-f0-9]{40}$/.test(sourceCommit)&&/^[a-f0-9]{64}$/.test(sourceSha256));
const bytes=await readFile(join(root,'report.json')),r=JSON.parse(bytes);
assert.equal(r.pass,true);assert.equal(r.runId,runId);assert.equal(r.sourceCommit,sourceCommit);assert.equal(r.sourceSha256,sourceSha256);
for(const name of ['productionHostTouched','installationPerformed','servicesStarted','authorityIssued'])assert.equal(r[name],false,name);
assert.equal(r.syntheticInputs,true);assert.equal(r.cleanupConfirmed,true);assert.ok(Date.parse(r.completedAt)>=Date.parse(r.startedAt));
assert.equal(r.plan.exitCode,0);assert.equal(r.plan.result.readOnly,true);assert.equal(r.plan.result.servicesPrepared,false);
assert.equal(r.prepared.exitCode,0);assert.equal(r.prepared.result.servicesPrepared,true);assert.equal(r.prepared.result.servicesActivated,false);assert.equal(r.prepared.result.migrationReady,false);
assert.equal(r.daclRestore.permissionsPreserved,true);assert.deepEqual(r.daclRestore.actual,r.daclRestore.expected);assert.equal(r.daclRestore.actual.protected,true);
assert.deepEqual(r.checks,['default-plan-no-services','existing-data-refused-preserved','retained-lock-refused-preserved','multiply-linked-input-refused','foreign-writable-input-refused','actual-created-handle-rollback','actual-disabled-distinct-virtual-services','existing-installation-refused-unchanged','input-hashes-preserved-no-data-or-credentials']);
assert.deepEqual(r.refusals.map(row=>[row.case,row.observation.exitCode,row.observation.result.code,row.observation.result.lockRetained]),[
  ['existing-data',1,'OSP_EXISTING_DATA_REFUSED',false],['retained-lock',1,'OSP_PREPARATION_INCOMPLETE',false],['hardlink',1,'OBD_FILE_IDENTITY_INVALID',false],['foreign-write',1,'OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY',false],['existing-services',1,'OSP_EXISTING_SERVICE_REFUSED',false],
]);
assert.equal(r.observed.length,2);const sids=new Set();
for(const [index,name]of ['Ragent-ControlPlane','Ragent-RunnerSupervisor'].entries()){
  const s=r.observed[index];assert.equal(s.name,name);assert.equal(s.account,'NT SERVICE\\'+name);assert.equal(s.state,'Stopped');assert.equal(s.startMode,'Disabled');assert.equal(s.pid,0);assert.match(s.sid,/^S-1-5-80-(?:\d+-){4}\d+$/);sids.add(s.sid);assert.deepEqual(s.privileges,['SeChangeNotifyPrivilege']);assert.equal(s.sidType,'UNRESTRICTED');
  const planned=r.prepared.result.plan.find(p=>p.name===name);assert.equal(planned.command,s.command);assert.equal(planned.startMode,'Disabled');assert.equal(planned.account,s.account);
  assert.ok(s.command.startsWith('"C:\\Program Files\\Ragent\\Ragent.ServiceHost.exe" --role '));
}
assert.equal(sids.size,2);
const verified={verificationPass:true,preparationPass:true,runId,sourceCommit,sourceSha256,reportSha256:createHash('sha256').update(bytes).digest('hex'),actualScmRegistration:true,actualDisabledServiceAccounts:true,actualRunningTokenVerified:false,syntheticInputs:true,installedProductReady:false,authorityIssued:false,cleanupConfirmed:true};
await writeFile(join(root,'verified.json'),JSON.stringify(verified,null,2)+'\n');console.log(JSON.stringify(verified));
