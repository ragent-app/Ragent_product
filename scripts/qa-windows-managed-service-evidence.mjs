// Independent replay of downloaded facts and frozen Git source hashes.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const [root,runId,commit]=process.argv.slice(2),exec=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
assert.ok(root&&/^\d+$/.test(runId)&&/^[a-f0-9]{40}$/.test(commit));
const bytes=await readFile(join(root,'report.json')),r=JSON.parse(bytes);
assert.equal(r.pass,true);assert.equal(r.runId,runId);assert.equal(r.sourceCommit,commit);assert.equal(r.actualServiceHost,true);assert.equal(r.syntheticEntryScripts,true);
for(const flag of ['productionHostTouched','actualProductApi','authorityIssued','providerRun'])assert.equal(r[flag],false,flag);
assert.equal(r.cleanupConfirmed,true);assert.ok(Date.parse(r.completedAt)>=Date.parse(r.startedAt));
assert.deepEqual(r.checks,['actual-system-service-refused-before-data-io','fresh-protected-data-only-default-plan-and-reentry-refusal','actual-host-node-grandchild-medium-virtual-tokens','removed-privilege-and-integrity-cannot-be-raised','cross-role-secret-runtime-harness-and-binary-access-denied','shared-authorized-work-and-spool-access-succeeds','actual-service-graceful-stop-owned-processes-gone']);
assert.equal(r.preparation.exitCode,0);assert.equal(r.preparation.result.servicesPrepared,true);assert.equal(r.preparation.result.servicesActivated,false);
assert.equal(r.dataPreparation.exitCode,0);assert.equal(r.dataPreparation.result.dataPrepared,true);assert.equal(r.dataPreparation.result.directories,19);
for(const flag of ['servicesActivated','identityCreated','credentialsCreated','migrationReady'])assert.equal(r.dataPreparation.result[flag],false);
assert.equal(r.dataReentry.exitCode,1);assert.equal(r.dataReentry.result.code,'ODP_EXISTING_DATA_REFUSED');
const hardened=r.testAncestorBaseline?.explicitTestOnly===true,defaultBaseline=r.defaultAncestorBaseline;
if(defaultBaseline){assert.equal(hardened,false);assert.equal(defaultBaseline.aclAdjusted,false);assert.equal(defaultBaseline.unchanged,true);assert.deepEqual(defaultBaseline.before,defaultBaseline.after);assert.equal(defaultBaseline.before.owner,'S-1-5-18');assert.ok(defaultBaseline.before.rules.some(x=>x.sid==='S-1-5-32-545'&&x.mask===278&&x.inheritance===1&&x.propagation===0&&x.type===0));assert.equal(r.ancestorProbe.pass,true);assert.equal(r.ancestorProbe.cleanupConfirmed,true);assert.equal(r.ancestorProbe.otherMetadataWritersRefused,true);assert.equal(r.ancestorProbe.aclChecks,18);for(const impl of ['host','powershell']){assert.equal(r.ancestorProbe[impl].pass,true);assert.equal(r.ancestorProbe[impl].checks.length,9);}}
if(hardened){
 assert.equal(r.dataPlan.exitCode,1);assert.equal(r.dataPlan.result.code,'OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY');assert.equal(r.hardenedDataPlan.exitCode,0);assert.equal(r.hardenedDataPlan.result.readOnly,true);
 const a=r.testAncestorBaseline;assert.equal(a.defaultImageRefused,true);assert.equal(a.restored,true);assert.equal(a.descendantGrantPreserved,true);assert.deepEqual(a.before,a.after);assert.equal(a.before.owner,a.hardened.owner);assert.equal(a.before.protected,a.hardened.protected);
 const from=a.before.rules.find(x=>x.sid==='S-1-5-32-545'&&x.mask===278&&x.inheritance===1&&x.propagation===0);
 assert.ok(from);assert.equal(from.type,0);assert.equal(from.inherited,false);
 // FileSystemAccessRule adds SYNCHRONIZE to an Allow ACE constructed by .NET.
 // Account for that exact bit on the one baseline ACE; all others stay identical.
 const expected={...a.before,rules:a.before.rules.map(x=>x===from?{...x,mask:x.mask|0x100000,propagation:2}:x)};
 // Rules may reorder canonically after a DACL write; preserve every ACE fact.
 const sorted=x=>[...x].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 assert.deepEqual(sorted(expected.rules),sorted(a.hardened.rules));
}else{assert.equal(r.dataPlan.exitCode,0);assert.equal(r.dataPlan.result.readOnly,true);}
assert.equal(r.services.length,2);const pids=new Set(),sids=new Set(),nodes=new Set(),attackPids=new Set();
const expectedSids={'Ragent-ControlPlane':'S-1-5-80-555966672-1219555316-1140255090-1259223577-3837636007','Ragent-RunnerSupervisor':'S-1-5-80-2610452377-2515812077-2882137345-1331524236-1359986107'};
for(const row of r.services){
 const sid=expectedSids[row.name];assert.ok(sid);sids.add(sid);assert.equal(row.proof.pass,true);assert.equal(row.proof.parentPid,row.pid);assert.equal(row.parentFacts.pid,row.pid);assert.equal(row.nodeFacts.pid,row.proof.pid);assert.equal(row.proof.authorityIssued,false);assert.equal(row.proof.productApiStarted,false);nodes.add(row.proof.node);
 for(const facts of [row.parentFacts,row.nodeFacts,row.proof.token]){assert.equal(facts.sid,sid);assert.equal(facts.integrityRid,8192);assert.equal(facts.sessionId,0);assert.equal(facts.elevated,false);assert.equal(facts.enabledAdministrators,false);assert.deepEqual(facts.privileges,['SeChangeNotifyPrivilege']);assert.ok(Number.isInteger(facts.pid)&&facts.pid>0);pids.add(facts.pid);}
 assert.equal(row.proof.token.privilegeReenableDenied,true);assert.equal(row.proof.token.integrityRaiseDenied,true);assert.equal(row.proof.token.postIntegrityRid,8192);
 if(defaultBaseline){const attack=row.proof.ancestorGuard;assert.equal(attack.pass,true);assert.equal(attack.sid,sid);assert.equal(attack.checks.length,9);assert.equal(attack.metadataOnlyAccess,256);assert.equal(attack.ownedDirectoriesOnly,true);assert.ok(Number.isInteger(attack.pid)&&attack.pid>0&&!pids.has(attack.pid));attackPids.add(attack.pid);}
 for(const path of ['C:/Program Files/Ragent/payload/node.exe','C:/Program Files/Ragent/payload/immutable-probe.txt'])assert.ok(row.proof.denied.includes(path));
 if(row.name==='Ragent-RunnerSupervisor')for(const path of ['C:/ProgramData/Ragent/instances/owner/config/auth-session-secret','C:/ProgramData/Ragent/instances/owner/config/blocked-write','C:/ProgramData/Ragent/instances/owner/runtime/blocked-write','C:/ProgramData/Ragent/harnesses/blocked-write'])assert.ok(row.proof.denied.includes(path));
}
assert.equal(pids.size,6);assert.equal(sids.size,2);assert.equal(nodes.size,1);
if(defaultBaseline){assert.equal(attackPids.size,2);for(const pid of attackPids)assert.ok(!pids.has(pid));}
const sourceCount=defaultBaseline?9:7,runtimeCount=defaultBaseline?7:6;
assert.equal(r.sourceFiles.length,sourceCount);assert.equal(new Set(r.sourceFiles.map(x=>x.path)).size,sourceCount);
for(const source of r.sourceFiles){assert.match(source.path,/^(?:packaging\/windows\/[a-zA-Z0-9.-]+|tests\/(?:fixtures\/)?[a-zA-Z0-9.-]+)$/);const {stdout}=await exec('git',['show',commit+':'+source.path],{encoding:'buffer',windowsHide:true,timeout:10000,maxBuffer:262144});assert.ok([hash(stdout),hash(Buffer.from(stdout.toString().replace(/\r?\n/g,'\r\n')))].includes(source.sha256),'Frozen source mismatch: '+source.path);}
assert.equal(r.runtimeFiles.length,runtimeCount);assert.equal(new Set(r.runtimeFiles.map(x=>x.path)).size,runtimeCount);for(const file of r.runtimeFiles){assert.match(file.sha256,/^[a-f0-9]{64}$/);assert.ok(file.bytes>0);}
const verified={verificationPass:true,slicePass:true,runId,sourceCommit:commit,reportSha256:hash(bytes),actualProcesses:pids.size,actualAttackProcesses:attackPids.size,actualServiceHost:true,sourceFilesVerified:sourceCount,runtimeFileDigestsRecorded:runtimeCount,nodeVersions:[...nodes],protectedTestAncestorBaseline:hardened,ancestorRestored:!hardened||r.testAncestorBaseline.restored,defaultWindowsAncestorCompatibilityAccepted:!!defaultBaseline,syntheticEntryScripts:true,actualProductApi:false,providerRun:false,nativeOwnerAuthorityIssued:false,cleanupConfirmed:true,releaseReady:false,migrationReady:false};
await writeFile(join(root,'verified.json'),JSON.stringify(verified,null,2)+'\n');console.log(JSON.stringify(verified));
