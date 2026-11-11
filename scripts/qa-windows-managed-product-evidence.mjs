// Replay actual guest observations and every allowlisted source blob. Never
// equate unsigned native CLI degradation or a manually staged payload with MSI.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const [root,runId,commit]=process.argv.slice(2),exec=promisify(execFile),hash=x=>createHash('sha256').update(x).digest('hex');
assert.ok(root&&/^\d+$/.test(runId)&&/^[a-f0-9]{40}$/.test(commit));
const reportBytes=await readFile(join(root,'report.json')),r=JSON.parse(reportBytes);
const admin=r.administrativeInstallTrust===true;
const flags=process.argv.slice(5),active=r.activeRemovalAcceptance===true;
assert.ok(flags.length<=2&&new Set(flags).size===flags.length&&flags.every(x=>['--administrative-install-trust','--active-removal'].includes(x)));
if(flags.includes('--administrative-install-trust'))assert.equal(admin,true,'Administrative installation acceptance cannot downgrade to degraded legacy mode');
if(flags.includes('--active-removal'))assert.equal(active,true,'Active removal acceptance is required');
if(active)assert.equal(admin,true);
assert.equal(r.pass,true);assert.equal(r.runId,runId);assert.equal(r.sourceCommit,commit);assert.equal(r.actualProductApi,true);assert.equal(r.syntheticEntryScripts,false);
for(const field of ['providerRun','ownerNativeTrustSubstituted','installationPerformed','productionChanged','releaseReady','migrationReady'])assert.equal(r[field],false,field);
for(const field of ['cleanupConfirmed','defaultProgramDataAclUnchanged','outboundBlockedForProductNode','firewallProfilesRestored','sqliteHeaderValid','durableIdentityPreserved','secretPreserved','oldLocalwebCookieAccepted'])assert.equal(r[field],true,field);
assert.equal(r.firewallProfilesActive.length,3);for(const p of r.firewallProfilesActive)assert.equal(p.Enabled,1);assert.deepEqual(new Set(r.firewallProfilesActive.map(p=>p.Name)),new Set(['Domain','Private','Public']));
assert.equal(r.stops.length,2);for(const [index,stop] of r.stops.entries()){assert.equal(stop.phase,index===0?'fresh':'restart');for(const field of ['ownedProcessesGone','instanceOwnershipReleased','serviceStopLogObserved'])assert.equal(stop[field],true);assert.equal(stop.forcedDeadlineObserved,false);}
assert.deepEqual(r.checks,[...admin?['actual-unsigned-administrative-prepare-initialize-policy-activate-with-integrity-and-acl-refusals']:[],'actual-product-localweb-and-session-api-under-separated-medium-tokens','actual-product-restart-preserves-private-identity-secret-and-sqlite-cookie',...active?['actual-running-service-removal-with-locked-identity-and-receipt-privilege-refusals']:[],'actual-product-graceful-stop']);
assert.equal(r.preparation.exitCode,0);assert.equal(r.preparation.result.servicesPrepared,true);assert.equal(r.preparation.result.servicesActivated,false);
if(!admin){assert.equal(r.dataPreparation.exitCode,0);assert.equal(r.dataPreparation.result.dataPrepared,true);assert.equal(r.dataPreparation.result.servicesActivated,false);}
else{
 assert.equal(r.helperSignatureStatus,'NotSigned');assert.equal(r.privateIdentityExclusivelyLockedDuringRefusals,true);
 assert.deepEqual(Object.keys(r.release).sort(),['version','protocolVersion','helperFile','helperSha256','trustMode'].sort());assert.equal(r.release.version,2);assert.equal(r.release.protocolVersion,2);assert.equal(r.release.helperFile,'AgentoC.OwnerBootstrap.exe');assert.equal(r.release.trustMode,'admin-installed-sha256');assert.match(r.release.helperSha256,/^[a-f0-9]{64}$/);
 for(const [name,key]of [['prepare','managedPreparation'],['initialize','identityInitialization'],['policy','policyPreparation'],['activation-check','activationPreflight'],['activate','activation'],['changed-helper-refused','changedHelperRefusal'],['writable-helper-refused','writableHelperRefusal']])assert.deepEqual(JSON.parse(await readFile(join(root,name+'.json'))),r[key]);
 for(const value of [r.managedPreparation,r.identityInitialization,r.policyPreparation,r.activationPreflight,r.activation]){assert.equal(value.ok,true);assert.equal(value.authorityIssued,false);}
 assert.equal(r.managedPreparation.preparedOnly,true);assert.equal(r.identityInitialization.identityInitialized,true);assert.equal(r.identityInitialization.servicesActivated,false);assert.equal(r.policyPreparation.policyPrepared,true);assert.equal(r.policyPreparation.identityRead,true);assert.equal(r.policyPreparation.servicesActivated,false);assert.equal(r.activationPreflight.preflightPassed,true);assert.equal(r.activationPreflight.readOnly,true);assert.equal(r.activationPreflight.mutationPerformed,false);
 for(const key of ['activationImplemented','configurationCommitted','servicesActivated','productHealthPassed','privateIdentityRead','mutationPerformed'])assert.equal(r.activation[key],true,key);
 for(const [key,code]of [['changedHelperRefusal','OPP_HELPER_HASH_MISMATCH'],['writableHelperRefusal','OBD_OBJECT_WRITABLE_BY_FOREIGN_IDENTITY']]){const v=r[key];assert.equal(v.ok,false);assert.equal(v.code,code);assert.equal(v.stage,'signature');assert.equal(v.identityRead,false);assert.equal(v.quarantined,false);assert.equal(v.policyPrepared,false);assert.equal(v.servicesActivated,false);assert.equal(v.authorityIssued,false);}
}
assert.equal(r.phases.length,2);const seen=new Set();
const sids={'AgentoC-ControlPlane':'S-1-5-80-555966672-1219555316-1140255090-1259223577-3837636007','AgentoC-RunnerSupervisor':'S-1-5-80-2610452377-2515812077-2882137345-1331524236-1359986107'};
for(const [index,phase] of r.phases.entries()){
 assert.equal(phase.phase,index===0?'fresh':'restart');assert.equal(phase.healthStatus,admin?200:503);assert.equal(phase.healthOk,admin);assert.equal(phase.cliTransport,admin?'ready':'degraded');assert.equal(phase.htmlStatus,200);assert.equal(phase.sessionApiStatus,200);if(index===0)assert.equal(phase.automaticOwner,true);
 assert.equal(phase.services.length,2);const roles=new Set();
 for(const service of phase.services){const sid=sids[service.name];assert.ok(sid);roles.add(service.name);assert.equal(service.facts.length,2);assert.deepEqual(service.facts.map(x=>x.pid),[service.hostPid,service.nodePid]);
  for(const f of service.facts){assert.equal(f.sid,sid);assert.equal(f.integrityRid,8192);assert.equal(f.sessionId,0);assert.equal(f.elevated,false);assert.equal(f.enabledAdministrators,false);assert.deepEqual(f.privileges,['SeChangeNotifyPrivilege']);assert.ok(Number.isInteger(f.pid)&&f.pid>0&&!seen.has(f.pid));seen.add(f.pid);}
 }
 assert.equal(roles.size,2);
}
assert.deepEqual(r.observed,r.phases.flatMap(x=>x.services));assert.ok(Date.parse(r.completedAt)>=Date.parse(r.startedAt));
if(active){
 for(const [name,key] of [['active-receipt-refused','activeReceiptRefusal'],['active-privileges-refused','activePrivilegesRefusal'],['active-remove-check','activeRemovalPreflight'],['active-remove','activeRemoval']])assert.deepEqual(JSON.parse(await readFile(join(root,name+'.json'))),r[key]);
 for(const [key,code] of [['activeReceiptRefusal','ORP_ACTIVE_RECEIPT_INVALID'],['activePrivilegesRefusal','OAT_PRIVILEGES_CHANGED']]){const v=r[key];assert.equal(v.ok,false);assert.equal(v.code,code);for(const field of ['quarantined','dataRemoved','privateIdentityRead','authorityIssued'])assert.equal(v[field],false);}
 for(const [key,stage] of [['activeRemovalPreflight','ActiveCheck'],['activeRemoval','ActiveRemove']]){const v=r[key],remove=stage==='ActiveRemove';assert.equal(v.ok,true);assert.equal(v.stage,stage);assert.equal(v.activeInstallation,true);assert.equal(v.readOnly,!remove);assert.equal(v.servicesRemoved,remove);assert.equal(v.processesGoneObserved,remove);assert.equal(v.receiptsPreserved,true);for(const field of ['dataRemoved','privateIdentityRead','authorityIssued'])assert.equal(v[field],false);}
 assert.equal(r.privateIdentityLockedDuringActiveRemoval,true);
 const o=r.activeRemovalObserved;for(const field of ['servicesAbsent','ownedProcessesGone','listenerAbsent','preservedFileHashesUnchanged','sqliteStillPresent','quarantineMarkerRetained','refusalStatesUnchanged'])assert.equal(o[field],true);assert.equal(o.preservedPrivateAndPublicFileCount,6);
}
const manifestBytes=await readFile(join(root,'source-manifest.json')),manifest=JSON.parse(manifestBytes);assert.equal(manifest.schemaVersion,1);assert.equal(manifest.profile,'desktop');assert.equal(manifest.sourceRevision,commit);
const git=async(...args)=>(await exec('git',args,{windowsHide:true,encoding:'buffer',maxBuffer:32*1024*1024,timeout:30000})).stdout;
const specBytes=await git('show',commit+':packaging/runtime-payload.json'),spec=JSON.parse(specBytes),profile=spec.profiles.desktop;
assert.ok(profile.prefixes.includes('shared/'),'Desktop runtime payload must include shared data used by runtime imports');
assert.ok(profile.exclude.includes('shared/whisper-languages.json'),'Retired Whisper language catalog must be excluded from the Windows runtime');
const npmPackage=JSON.parse(await git('show',commit+':package.json'));
assert.ok(npmPackage.files.includes('shared/'),'Published npm package must carry shared runtime data');
assert.ok([hash(specBytes),hash(Buffer.from(specBytes.toString().replace(/\r?\n/g,'\r\n')))].includes(manifest.allowlistSha256));
const tree=new Map((await git('ls-tree','-r','-z',commit)).toString().split('\0').filter(Boolean).map(line=>{const i=line.indexOf('\t'),[mode,type,oid]=line.slice(0,i).split(' ');return [line.slice(i+1),{mode,type,oid}];}));
const selected=[...tree.keys()].filter(p=>(profile.files.includes(p)||profile.prefixes.some(x=>p.startsWith(x)))&&!profile.exclude.some(x=>p===x||x.endsWith('/')&&p.startsWith(x)));
assert.ok(!selected.includes('shared/whisper-languages.json'),'Frozen source staging must exclude the retired Whisper language catalog');
assert.equal(manifest.files.length,selected.length);assert.equal(new Set(manifest.files.map(x=>x.path)).size,selected.length);
const sourceByTarget=new Map(selected.map(p=>[profile.rename[p]||p,p])),oids=[...new Set(selected.map(p=>tree.get(p).oid))];
const blobs=await new Promise((resolve,reject)=>{
 const child=spawn('git',['cat-file','--batch'],{windowsHide:true,stdio:['pipe','pipe','pipe']}),chunks=[];let bytes=0,error='';
 child.stdout.on('data',b=>{bytes+=b.length;if(bytes>256*1024*1024){child.kill();reject(Error('Source batch exceeds bound'));}else chunks.push(b);});child.stderr.on('data',b=>error+=b.toString());child.on('error',reject);child.stdin.on('error',reject);
 child.on('close',code=>{if(code!==0){reject(Error('Git source batch failed: '+error.slice(0,1024)));return;}const all=Buffer.concat(chunks),map=new Map();let offset=0;try{for(const oid of oids){const end=all.indexOf(10,offset);assert.ok(end>=offset);const [actual,type,length]=all.subarray(offset,end).toString().split(' ');assert.equal(actual,oid);assert.equal(type,'blob');const n=Number(length);assert.ok(Number.isSafeInteger(n)&&n>=0&&end+1+n<all.length);map.set(oid,all.subarray(end+1,end+1+n));assert.equal(all[end+1+n],10);offset=end+2+n;}assert.equal(offset,all.length);resolve(map);}catch(e){reject(e);}});
 child.stdin.end(oids.join('\n')+'\n');
});
for(const file of manifest.files){const source=sourceByTarget.get(file.path);assert.ok(source,'Unexpected runtime source: '+file.path);const object=tree.get(source);assert.equal(object.type,'blob');assert.ok(['100644','100755'].includes(object.mode));const b=blobs.get(object.oid),variants=[b];if(!b.includes(0))variants.push(Buffer.from(b.toString().replace(/\r?\n/g,'\r\n')));assert.ok(variants.some(x=>hash(x)===file.sha256&&x.length===file.bytes),'Frozen source mismatch: '+source);}
assert.equal(r.runtimeFiles.length,admin?5:4);for(const file of r.runtimeFiles){assert.match(file.sha256,/^[a-f0-9]{64}$/);assert.ok(file.bytes>0);if(file.path==='payload\\node.exe'){assert.equal(file.sha256,'2ffe3acc0458fdde999f50d11809bbe7c9b7ef204dcf17094e325d26ace101d8');}else if(file.path==='payload\\AgentoC.OwnerBootstrap.exe'){assert.equal(file.sha256,r.release.helperSha256);}else if(file.path.startsWith('payload\\')){assert.equal(file.sha256,manifest.files.find(x=>x.path===file.path.slice(8).replaceAll('\\','/')).sha256);}}
if(admin){const expected=['tests/windows-managed-product.ps1','lib/windows-owner-release-trust.mjs','lib/windows-owner-discovery.mjs','lib/windows-owner-activation-trust.mjs','lib/windows-owner-service-trust.mjs','lib/windows-owner-discovery-publication.mjs','native/windows-owner-bootstrap.cs','packaging/windows/stage-owner-bootstrap.ps1','packaging/windows/read-owner-bootstrap-discovery.ps1','packaging/windows/read-owner-service-trust.ps1','packaging/windows/prepare-owner-install-policy.ps1','packaging/windows/prepare-owner-msi-policy.ps1','packaging/windows/check-owner-msi-activation.ps1','packaging/windows/managed-owner-msi.ps1','packaging/windows/managed-owner-msi-bridge.cs','packaging/windows/owner-msi-relocation-journal.cs','packaging/windows/initialize-owner-service-identity.ps1','packaging/windows/build-managed-owner-msi-bridge.ps1','packaging/windows/AgentoC.ServiceHost.cs',...active?['packaging/windows/remove-owner-msi-policy.ps1','packaging/windows/owner-service-activation-trial.cs','packaging/windows/owner-service-activation-transaction.cs']:[]];assert.deepEqual(r.sourceFiles.map(s=>s.path),expected);for(const s of r.sourceFiles){const b=await git('show',commit+':'+s.path);assert.ok([hash(b),hash(Buffer.from(b.toString().replace(/\r?\n/g,'\r\n')))].includes(s.sha256),'Additional frozen source mismatch '+s.path);}}
const verified={verificationPass:true,slicePass:true,sourceCommit:commit,runId,reportSha256:hash(reportBytes),sourceManifestSha256:hash(manifestBytes),sourceFilesVerified:manifest.files.length,actualProductApi:true,actualProcessObservations:seen.size,syntheticEntryScripts:false,releaseNode24BytesVerified:true,localwebAndSqliteRestartAccepted:true,nativeCliReady:admin,nativeActivationListenerReady:admin,healthStatus503Preserved:!admin,administrativeInstallTrust:admin,authenticodeRequiredForV2:false,interactiveOwnerGrantTested:false,providerRun:false,installationPerformed:false,defaultProgramDataAclUnchanged:true,productNodeOutboundBlocked:true,cleanupConfirmed:true,releaseReady:false,migrationReady:false};
verified.activeServiceRemovalAccepted=active;verified.activeMsiUninstallTested=false;
await writeFile(join(root,'verified.json'),JSON.stringify(verified,null,2)+'\n');console.log(JSON.stringify(verified));
