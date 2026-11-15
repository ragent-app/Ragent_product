// Real coordinator death at two private transaction API boundaries. This does
// not certify public signed admission, full product health or physical power loss.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const [root,runId,commit]=process.argv.slice(2),exec=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
assert.ok(root&&/^\d+$/.test(runId)&&/^[a-f0-9]{40}$/.test(commit));
const raw=await readFile(join(root,'activation-interruption-report.json')),a=JSON.parse(raw),t=JSON.parse(await readFile(join(root,'activation-trial-report.json'))),r=JSON.parse(await readFile(join(root,'report.json'))),x=JSON.parse(await readFile(join(root,'activation-transaction-report.json')));
assert.deepEqual(r.activationTrial,t);assert.deepEqual(t.interruption,a);assert.equal(a.runId,runId);assert.equal(a.sourceCommit,commit);
for(const k of ['pass','adapterSubstituted','syntheticPolicyReceipt','testOnlyQuarantineCleanup'])assert.equal(a[k],true,k);
for(const k of ['publicPositiveSignedAcceptance','productHealthTested','businessActivated','authorityIssued','servicesStarted','powerLossTested'])assert.equal(a[k],false,k);
assert.deepEqual(a.cases.map(c=>c.phase),['prepared','committed']);
const names=['owner-msi.prepared.json','owner-msi.policy.json','owner-msi.activated.json','owner-msi.activation-health.json','owner-msi.prepared.activated.json','owner-msi.policy.activated.json','owner-activation.prepare-lock','owner-activation.committed-lock'];
const roles=['supervisor','control'],services=['Ragent-RunnerSupervisor','Ragent-ControlPlane'];
for(const c of a.cases){
 const committed=c.phase==='committed';assert.ok(Number.isSafeInteger(c.pid)&&c.pid>0);assert.ok(Number.isFinite(Date.parse(c.startedAt)));
 const ready=JSON.parse(await readFile(join(root,'interruption-'+c.phase+'-ready.json')));assert.deepEqual(c.ready,ready);assert.deepEqual(ready,{phase:c.phase,pid:c.pid,begun:true,configurationCommitted:committed,servicesStarted:false});
 assert.equal(c.exitCode,2628);assert.equal(c.terminatedThroughRetainedHandle,true);assert.equal(c.healthReceiptExists,false);assert.equal(c.automaticRollbackObserved,false);assert.equal(c.stderrEmpty,true);assert.equal(c.qaCleanupConfirmed,true);assert.equal((await readFile(join(root,'interruption-'+c.phase+'-stderr.txt'))).length,0);
 assert.deepEqual(c.after,c.before);assert.deepEqual(c.stable,c.after);assert.deepEqual(c.before.map(f=>f.name),names);
 const present=committed?[false,false,true,false,true,true,false,true]:[true,true,false,false,false,false,true,false];
 for(const [i,f] of c.before.entries()){assert.deepEqual(Object.keys(f).sort(),['name','exists','sha256'].sort());assert.equal(f.exists,present[i]);if(f.exists)assert.match(f.sha256,/^[a-f0-9]{64}$/);else assert.equal(f.sha256,'');}
 assert.equal(c.before[committed?4:0].sha256,x.committedMetadata[2].sha256);assert.equal(c.before[committed?5:1].sha256,x.committedMetadata[3].sha256);assert.equal(c.before[committed?7:6].sha256,x.precommitMetadata[4].sha256);
 assert.deepEqual(c.afterServices,c.beforeServices);assert.equal(c.beforeServices.length,2);
 for(const [i,s] of c.beforeServices.entries())assert.deepEqual(s,{role:roles[i],command:'"C:\\Program Files\\Ragent\\ActivationTrialProbe.exe" '+roles[i],account:'NT SERVICE\\'+services[i],mode:'Auto',state:'Stopped',pid:0});
 if(!committed){assert.equal(c.nativeGateCode,'OBD_INSTALL_INCOMPLETE');assert.equal(c.hostGateCode,'SHT_INSTALLATION_INCOMPLETE');assert.equal(c.activeReceipt,undefined);}
 else{
  assert.equal(c.nativeGateCode,undefined);assert.equal(c.hostGateCode,undefined);const b=await readFile(join(root,'interruption-committed-active.json')),active=JSON.parse(b);assert.equal(hash(b),c.before[2].sha256);assert.deepEqual(c.activeReceipt,active);
  assert.deepEqual(Object.keys(active).sort(),['version','purpose','phase','instanceId','preparedSha256','policyReceiptSha256','committedAt','healthConfirmed'].sort());assert.equal(active.version,1);assert.equal(active.purpose,'owner-service-activation');assert.equal(active.phase,'configuration-committed');assert.equal(active.instanceId,'inst_'+('d'.repeat(32)));assert.equal(active.healthConfirmed,false);assert.ok(Number.isFinite(Date.parse(active.committedAt)));assert.equal(active.preparedSha256,c.before[4].sha256);assert.equal(active.policyReceiptSha256,c.before[5].sha256);
 }
}
const expected=['tests/windows-activation-interruption.ps1','tests/fixtures/windows-activation-coordinator-interruption.ps1'];assert.deepEqual(a.sourceFiles.map(s=>s.path),expected);
const sources=new Map();for(const s of [...r.sourceFiles,...t.sourceFiles,...x.sourceFiles,...a.sourceFiles]){assert.match(s.sha256,/^[a-f0-9]{64}$/);if(sources.has(s.path))assert.equal(sources.get(s.path),s.sha256);sources.set(s.path,s.sha256);}assert.equal(sources.size,23);
for(const [path,digest]of sources){const bytes=(await exec('git',['show',commit+':'+path],{windowsHide:true,encoding:'buffer',timeout:30000,maxBuffer:1048576})).stdout;assert.ok([hash(bytes),hash(Buffer.from(bytes.toString().replace(/\r?\n/g,'\r\n')))].includes(digest),'Frozen source mismatch: '+path);}
await exec(process.execPath,[resolve('scripts/qa-windows-activation-transaction-evidence.mjs'),root,runId,commit],{windowsHide:true,timeout:90000,maxBuffer:1048576});
const base=await readFile(join(root,'activation-transaction-verified.json'));
const verified={verificationPass:true,slicePass:true,runId,sourceCommit:commit,interruptionReportSha256:hash(raw),transactionVerifiedSha256:hash(base),sourceFilesVerified:sources.size,actualCoordinatorTerminations:2,retainedProcessHandleTermination:true,preparedCrashKeepsQuarantine:true,committedCrashRetainsApprovedConfiguration:true,servicesRemainAutomaticStopped:true,healthyStartupInferred:false,automaticCrashRollback:false,postDeathObservationWindowMs:1000,adapterSubstituted:true,syntheticPolicyReceipt:true,testOnlyQuarantineCleanup:true,publicPositiveSignedAcceptance:false,postSignatureCoordinatorTested:false,productHealthTested:false,servicesStartedByInterruptionCases:false,businessActivated:false,authorityIssued:false,powerLossTested:false,rebootTested:false,midArchiveInterruptionTested:false,releaseReady:false,migrationReady:false};
await writeFile(join(root,'activation-interruption-verified.json'),JSON.stringify(verified,null,2)+'\n');console.log(JSON.stringify(verified));
