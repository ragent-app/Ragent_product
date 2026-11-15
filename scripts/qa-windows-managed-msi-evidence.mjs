// Replay the diagnostic MSI transaction, frozen sources and raw installer logs.
// Guest-recorded binary digests are identities, not independently downloaded binaries.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const [root,runId,commit]=process.argv.slice(2),exec=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
assert.ok(root&&/^\d+$/.test(runId)&&/^[a-f0-9]{40}$/.test(commit));
const bytes=await readFile(join(root,'report.json')),r=JSON.parse(bytes);
assert.equal(r.runId,runId);assert.equal(r.sourceCommit,commit);
for(const k of ['pass','actualMsi','syntheticEntryInputs','cleanupConfirmed','defaultProgramDataAclUnchanged'])assert.equal(r[k],true,k);
for(const k of ['servicesActivated','authorityIssued','productApiStarted','productionChanged','releaseReady','migrationReady'])assert.equal(r[k],false,k);
assert.ok(Number.isFinite(Date.parse(r.startedAt))&&Date.parse(r.completedAt)>=Date.parse(r.startedAt));
const operations=[['invalid-owner',1603],['fresh',0],['repair-refused',1603],['changed-service-refused',1603],['uninstall',0],['retained-data-refused',1603],['injected-rollback',1603]];
assert.deepEqual(r.operations,operations.map(([name,exitCode])=>({name,exitCode})));
assert.deepEqual(r.checks,['invalid-owner-refused-before-files-and-services','actual-msi-creates-only-disabled-virtual-services-and-private-data','compiled-host-layout-refuses-prepared-receipt-before-business-io','maintenance-refused-with-data-preserved','changed-service-uninstall-refused-before-file-removal','verified-handle-uninstall-removes-services-preserves-all-data-and-receipt','new-fresh-install-refuses-retained-state','actual-msi-rollback-removes-new-services-retains-quarantined-data']);
assert.equal(r.services.length,2);const names=new Set();
for(const s of r.services){assert.ok(['Ragent-RunnerSupervisor','Ragent-ControlPlane'].includes(s.name));assert.ok(!names.has(s.name));names.add(s.name);assert.equal(s.account,'NT SERVICE\\'+s.name);assert.equal(s.mode,'Disabled');assert.equal(s.state,'Stopped');assert.equal(s.pid,0);
 const supervisor=s.name==='Ragent-RunnerSupervisor';
 const expected='"C:\\Program Files\\Ragent\\Ragent.ServiceHost.exe" --role '+(supervisor?'supervisor':'control')+' --node "C:\\Program Files\\Ragent\\payload\\node.exe" --script "C:\\Program Files\\Ragent\\payload\\'+(supervisor?'chat\\runner-supervisor-daemon.mjs':'chat-server.mjs')+'" --working-directory "C:\\Program Files\\Ragent\\payload" --config-dir "C:\\ProgramData\\Ragent\\instances\\owner\\'+(supervisor?'executor\\':'')+'config" --instance-root "C:\\ProgramData\\Ragent\\instances\\owner"';
 assert.equal(s.command,expected);
}
const sources=['Ragent.ManagedOwner.wxs','managed-owner-msi-bridge.cs','owner-msi-relocation-journal.cs','managed-owner-msi.ps1','build-managed-owner-msi-bridge.ps1','build-msi.ps1','Ragent.ServiceHost.cs','prepare-owner-service-data.ps1','prepare-owner-services.ps1','read-owner-bootstrap-discovery.ps1'].map(p=>'packaging/windows/'+p).concat(['tests/windows-managed-msi.ps1','tests/fixtures/windows-managed-msi-host.cs']);
assert.deepEqual(r.sourceFiles.map(f=>f.path),sources);
for(const f of r.sourceFiles){assert.match(f.sha256,/^[a-f0-9]{64}$/);const b=(await exec('git',['show',commit+':'+f.path],{windowsHide:true,encoding:'buffer',maxBuffer:1024*1024,timeout:30000})).stdout;assert.ok([hash(b),hash(Buffer.from(b.toString().replace(/\r?\n/g,'\r\n')))].includes(f.sha256),'Frozen source mismatch: '+f.path);}
for(const k of ['msi','bridge']){assert.match(r[k].sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(r[k].bytes)&&r[k].bytes>0);}
const logs={};const logHashes={};
for(const [name,code] of operations){const b=await readFile(join(root,name+'.msi.log'));logHashes[name]=hash(b);const log=b[0]===255&&b[1]===254?b.subarray(2).toString('utf16le'):b.toString('utf8').replace(/^\uFEFF/,'');logs[name]=log;assert.ok(log.includes('MainEngineThread is returning '+code),'Missing actual MSI result: '+name);}
const prepare='CustomActionSchedule(Action=ManagedPrepare,ActionType=3074,Source=BinaryData,Target=prepare "S-1-5-21-';
assert.ok(logs.fresh.includes(prepare));assert.ok(logs.uninstall.includes('CustomActionSchedule(Action=ManagedRemove,ActionType=3074,Source=BinaryData,Target=remove,'));
const fault='CustomActionSchedule(Action=QaFailure,ActionType=3074,Source=BinaryData,Target=prepare S-1-5-18,';
assert.ok(logs['injected-rollback'].indexOf(prepare)>=0);assert.ok(logs['injected-rollback'].indexOf(fault)>logs['injected-rollback'].indexOf(prepare));
const verified={verificationPass:true,preparedMsiAccepted:true,sourceCommit:commit,runId,reportSha256:hash(bytes),sourceFilesVerified:sources.length,operationCount:operations.length,checkCount:r.checks.length,logHashes,msiRecorded:r.msi,bridgeRecorded:r.bridge,binaryDigestsIndependentlyRehashed:false,syntheticEntryInputs:true,startupGateLayoutProbe:true,actualServiceActivation:false,actualProductApi:false,defaultProgramDataAclUnchanged:true,cleanupConfirmed:true,releaseReady:false,migrationReady:false};
await writeFile(join(root,'verified.json'),JSON.stringify(verified,null,2)+'\n');console.log(JSON.stringify(verified));
