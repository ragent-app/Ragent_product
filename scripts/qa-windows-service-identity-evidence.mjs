// Independently check retained canary evidence; no elevation or mutation of SCM.
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {verifyOwnerPurpose} from './qa-windows-owner-purpose-evidence.mjs';
import {verifyOwnerActivation} from './qa-windows-owner-activation-evidence.mjs';
import {verifyOwnerSet} from './qa-windows-owner-set-evidence.mjs';
const exec = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = join(source, 'artifacts/showcase/T2-current-20261017/service-identities');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const prepared = JSON.parse(await readFile(join(evidence, 'prepared.json'), 'utf8'));
const bytes = await readFile(join(prepared.bundle, 'manifest.json'));
assert.equal(hash(bytes), prepared.manifestSha256);
const manifest = JSON.parse(bytes), id = manifest.caseId;
assert.match(id, /^[a-f0-9]{32}$/);
assert.equal(resolve(prepared.bundle), join(evidence, 'bundle-' + id));
for (const item of manifest.sourceFiles) assert.equal(hash(await readFile(join(source, item.path))), item.sha256, item.path);
const runtimeFiles = ['IdentityCanary.exe', 'node.exe', 'probe.mjs', ...(manifest.crossServiceIpc ? ['RunPipeCandidate.exe','chat/restricted-run-ipc.mjs','tests/helpers/windows-run-pipe-fixture.mjs','tests/fixtures/windows-service-run-ipc-probe.mjs'] : []),...(manifest.crossServiceProvider?['RestrictedProviderCandidate.exe','claude.exe','tests/fixtures/windows-service-provider-worker.mjs','tests/fixtures/windows-service-provider-probe.mjs']:[])];
let ownerRows=[];
if(manifest.crossServiceOwnerBootstrap||manifest.crossServiceCredentialChannel){
  const raw=await readFile(join(prepared.bundle,'owner-files.json'));assert.equal(hash(raw),manifest['owner-files.json']);
  const index=JSON.parse(raw);assert.equal(index.version,1);ownerRows=index.files;assert.ok(ownerRows.length>0&&ownerRows.length<=(manifest.crossServiceCredentialChannel?768:200));
  assert.equal(new Set(ownerRows.map(x=>x.path.toLowerCase())).size,ownerRows.length);
  for(const row of ownerRows){assert.match(row.path,/^(?:package\.json|tests\/fixtures\/(?:windows-service-owner-bootstrap-probe|windows-service-owner-purpose-probe|windows-service-owner-set-probe|windows-service-owner-activation-probe|windows-service-credential-channel-probe|windows-service-provider-provision|local-control-authority)\.mjs|chat\/prompt-assets\/(?:runtime|system|turn)\/[a-zA-Z0-9_-]+\.(?:md|txt)|(?:lib|chat)\/[a-zA-Z0-9_./-]+\.mjs|node_modules\/[a-zA-Z0-9_@./-]+\.(?:js|mjs|cjs|json))$/);assert.ok(!row.path.includes('..'));
    assert.equal(hash(await readFile(join(source,row.path))),row.sha256);assert.equal(hash(await readFile(join(prepared.bundle,row.path))),row.sha256);}
  if(manifest.ownerActivation)runtimeFiles.push('OwnerActivationRaw.exe');
  runtimeFiles.push(...(manifest.crossServiceCredentialChannel?['RunCredentialChannel.exe','owner-files.json']:['OwnerBootstrap.exe','OwnerBootstrapRaw.exe','owner-files.json']));
}
for (const file of [...runtimeFiles, 'bootstrap.ps1']) assert.equal(hash(await readFile(join(prepared.bundle, file))), manifest[file], file);
runtimeFiles.push(...ownerRows.map(x=>x.path).filter(path=>!runtimeFiles.includes(path)));
const summaryBytes = await readFile(join(prepared.bundle, 'summary.json'));
const protectedRoot = join(process.env.ProgramData, 'RagentIdentityQA', 'case-' + id);
assert.equal(hash(summaryBytes), hash(await readFile(join(protectedRoot, 'export/summary.json'))));
const summary = JSON.parse(summaryBytes);
if(process.argv.includes('--verify-provider-preflight-failure')){
  assert.equal(manifest.crossServiceProvider,true);assert.equal(summary.pass,false);assert.equal(summary.caseId,id);assert.equal(summary.root,protectedRoot);
  for(const key of ['productionChanged','phoneTouched','credentialsUsed'])assert.equal(summary[key],false);
  const original=JSON.parse(await readFile(join(prepared.bundle,'original-run-provider.json'),'utf8'));
  assert.equal(original.pass,false);assert.equal(original.providerCredentialResolved,false);assert.deepEqual(original.cases,[]);
  const names=['Control','Executor'].map(role=>'Ragent-IdentityQA-'+role+'-'+id),owned=[];const exports=[];
  assert.deepEqual(summary.cleanup.map(x=>x.name).sort(),[...names].sort());
  for(const item of summary.cleanup){assert.equal(item.stopped,true);assert.equal(item.deleted,true);}
  assert.deepEqual(summary.runtimeRemoved.map(x=>x.file).sort(),[...runtimeFiles].sort());
  for(const item of summary.runtimeRemoved){assert.equal(item.removed,true);await assert.rejects(lstat(join(protectedRoot,'runtime',item.file)),{code:'ENOENT'});}
  assert.equal(summary.handoffRemoved,true);assert.equal(summary.providerHandoffRemoved,true);
  let preflight;
  for(const role of ['control','executor'])for(const type of ['service','node']){
    const file=role+'-'+type+'-report.json',raw=await readFile(join(prepared.bundle,file));
    assert.equal(hash(raw),hash(await readFile(join(protectedRoot,'export',file))));const value=JSON.parse(raw);
    exports.push({file,sha256:hash(raw)});if(value.pid)owned.push(value.pid);
    if(type==='node'){assert.equal(value.provider.providerUsed,false);if(role==='executor')preflight=value.provider.preflight;}
  }
  assert.equal(preflight.pass,false);assert.equal(preflight.boundaryOnly,true);assert.equal(preflight.modelInvocations,0);
  assert.equal(preflight.credentialsRemoved,true);assert.equal(preflight.runtimeRemoved,true);assert.equal(preflight.retainedSecretScan.remainingMatches,0);
  assert.equal(preflight.native.pass,false);assert.equal(preflight.native.profileDeleted,true);
  for(const child of preflight.native.cases||[]){assert.equal(child.label,'boundary');assert.equal(child.remainingOwnedProcesses,0);if(child.pid)owned.push(child.pid);}
  for(const round of [1,2])for(const suffix of ['.json','.json.tmp'])await assert.rejects(lstat(join(protectedRoot,'control/inbox',`r${round}-provider-request${suffix}`)),{code:'ENOENT'});
  for(const pid of owned)assert.ok(Number.isSafeInteger(pid)&&pid>0);
  const filter=owned.length?owned.map(pid=>'ProcessId='+pid).join(' OR '):'ProcessId=0';
  const ps=`$ErrorActionPreference='Stop';[pscustomobject]@{nodes=@(Get-CimInstance Win32_Process -Filter '${filter}'|Select-Object ProcessId,Name);services=@(Get-CimInstance Win32_Service -Filter "Name='${names[0]}' OR Name='${names[1]}'"|Select-Object Name,State)}|ConvertTo-Json -Compress -Depth 4`;
  const {stdout}=await exec('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{windowsHide:true,timeout:15000});
  const observed=JSON.parse(stdout.trim());assert.deepEqual(observed.nodes,[]);assert.deepEqual(observed.services,[]);
  const verified={caseId:id,verificationPass:true,acceptancePass:false,verifiedAt:new Date().toISOString(),providerCredentialResolved:false,modelInvocations:0,
    nativeFailure:{type:preflight.native.errorType,message:preflight.native.error,code:preflight.native.errorCode},sourceFiles:manifest.sourceFiles,
    manifestSha256:prepared.manifestSha256,summarySha256:hash(summaryBytes),exportedReports:exports,observed,ownedPids:owned,
    runtimeAndHandoffRemoved:true,productionChanged:false,phoneTouched:false,verifierSha256:hash(await readFile(fileURLToPath(import.meta.url)))};
  await writeFile(join(prepared.bundle,'verified-failure-evidence.json'),JSON.stringify(verified,null,2)+'\n');
  console.log(JSON.stringify({caseId:id,verificationPass:true,acceptancePass:false,nativeFailure:verified.nativeFailure,noRemainingOwnedNodesOrServices:true}));process.exit(0);
}
assert.equal(summary.pass, true);
assert.equal(summary.caseId, id);
assert.equal(summary.root, protectedRoot);
for (const key of ['productionChanged', 'phoneTouched']) assert.equal(summary[key], false);
assert.equal(summary.credentialsUsed,!!manifest.crossServiceProvider);
const names = ['Control', 'Executor',...(manifest.crossServiceProvider?['Preparer']:[])].map(role => 'Ragent-IdentityQA-' + role + '-' + id);
assert.equal(summary.registrations.length, 2);
assert.equal(summary.services.length, 2);
assert.equal(summary.rounds.length, 2);
assert.equal(summary.cleanup.length, names.length);
for(const item of summary.cleanup){assert.ok(names.includes(item.name));assert.equal(item.stopped,true);assert.equal(item.deleted,true);}
const sids = {}, pids = new Set();
let productionObservation;
const controlChecks = ['noControlEnvironment', 'csvTask', 'extraAuthorizedWrite', 'binaryWriteDenied', 'nodeWriteDenied', 'controlRead', 'ownerPipePositive'];
const executorChecks = ['noControlEnvironment', 'csvTask', 'extraAuthorizedWrite', 'binaryWriteDenied', 'nodeWriteDenied', 'controlReadDenied', 'controlWriteDenied', 'controlStateDenied', 'ownerPipeDenied', 'noBinaryWriteAuthority', 'publicTlsHead'];
function token(facts, sid, integrity) {
  assert.equal(facts.sid, sid);
  assert.equal(facts.sessionId, 0);
  assert.equal(facts.integrityRid, integrity);
  assert.equal(facts.elevated, false);
  assert.equal(facts.enabledAdministrators, false);
  assert.deepEqual(facts.privileges, ['SeChangeNotifyPrivilege']);
}
for (let i = 0; i < 2; i++) {
  const registration = summary.registrations[i], service = summary.services[i], cleanup = summary.cleanup[i];
  assert.equal(registration.name, names[i]);
  assert.equal(registration.account, 'NT SERVICE\\' + names[i]);
  assert.equal(registration.pass, true);
  assert.equal(registration.passwordNull, true);
  assert.equal(registration.startType, 'Manual');
  assert.equal(service.Name, names[i]);
  assert.equal(service.StartName, registration.account);
  assert.equal(service.State, 'Stopped');
  assert.equal(service.ProcessId, 0);
  assert.equal(cleanup.name, names[i]);
  assert.equal(cleanup.stopped, true);
  assert.equal(cleanup.deleted, true);
}
for (const [i, round] of summary.rounds.entries()) {
  assert.equal(round.round, i + 1);
  for (const role of ['control', 'executor']) {
    const report = round[role], node = round[role + 'Node'];
    assert.equal(report.role, role); assert.equal(report.pass, true);
    const sid = report.initialToken.sid;
    assert.match(sid, /^S-1-5-80-(\d+-){4}\d+$/);
    sids[role] ??= sid; assert.equal(sid, sids[role]);
    token(report.initialToken, sid, 12288);
    token(report.ordinaryToken, sid, 8192);
    token(report.node.childToken, sid, 8192);
    assert.equal(report.serviceConfigWriteDenied, true);
    assert.equal(report.node.pass, true);
    assert.equal(report.node.exitCode, 0);
    assert.equal(report.node.remainingProcesses, 0);
    assert.equal(node.role, role); assert.equal(node.pass, true);
    assert.equal(node.pid, report.node.pid);
    assert.ok(Number.isSafeInteger(node.pid) && node.pid > 0);
    assert.ok(!pids.has(node.pid)); pids.add(node.pid);
    const expected = [...(role === 'control' ? controlChecks : executorChecks), ...(manifest.crossServiceIpc ? ['crossServiceRunIpc'] : []),...(manifest.crossServiceProvider?['crossServiceProvider']:[]),...(manifest.crossServiceOwnerBootstrap?['ownerBootstrap']:[]),...(manifest.crossServiceCredentialChannel?['credentialChannel']:[])];
    assert.deepEqual(Object.keys(node.checks).sort(), [...expected].sort());
    for (const key of expected) assert.equal(node.checks[key], true, role + ':' + key);
    if(manifest.crossServiceProvider&&!manifest.crossServiceCredentialProvider){
      const value=node.provider;
      assert.equal(value.pass,true);assert.equal(value.role,role);assert.equal(value.round,i+1);
      assert.equal(value.transportVerified,true);assert.equal(value.providerUsed,true);
      assert.equal(value.peer.queryOnlyAuthorityVerified,true);
      assert.equal(value.peer.sid,summary.rounds[i][role==='control'?'executor':'control'].ordinaryToken.sid);
      assert.equal(value.peer.sessionId,0);assert.equal(value.peer.integrityRid,8192);assert.equal(value.peer.elevated,false);assert.equal(value.peer.enabledAdministrators,false);
      assert.ok(!pids.has(value.peer.pid));pids.add(value.peer.pid);
      if(role==='control')assert.equal(value.secretHandoffRemoved,true);
      else{
        assert.equal(value.calls,1);assert.equal(value.replayRefused,true);assert.equal(value.coldReplayRefused,true);
        for(const worker of [value.preflight,value.worker]){
          assert.equal(worker.pass,true);assert.equal(worker.stopped,true);assert.equal(worker.credentialsRemoved,true);assert.equal(worker.runtimeRemoved,true);
          assert.equal(worker.native.pass,true);assert.equal(worker.native.profileDeleted,true);
          assert.equal(worker.native.runtimeVerification,'protected-admin-qa-manifest');
          assert.equal(worker.native.serviceDesktop.privateDesktop,true);assert.equal(worker.native.serviceDesktop.nonInteractiveSession0,true);
          assert.equal(worker.native.serviceDesktop.fixedPreparedStation,true);assert.equal(worker.native.serviceDesktop.cleanupComplete,true);
          assert.equal(worker.native.serviceDesktop.stationDaclRestored,true);
          assert.equal(worker.native.serviceDesktop.managementHandlesInherited,false);
          assert.equal(worker.native.serviceDesktop.stationPackageMask,0x20123);assert.equal(worker.native.serviceDesktop.desktopPackageMask,0x200c3);
          assert.equal(worker.native.serviceDesktop.exactPackageSid,worker.native.packageSid);
          assert.equal(worker.native.hostToken.sessionId,0);assert.equal(worker.native.hostToken.userSidHash,hash(Buffer.from(sid)));
          assert.equal(worker.boundary.pass,true);assert.ok(Object.values(worker.boundary.checks).every(x=>x===true));
          assert.equal(worker.retainedSecretScan.remainingMatches,0);
          for(const child of worker.native.cases){
            assert.equal(child.pass,true);assert.equal(child.remainingOwnedProcesses,0);assert.equal(child.token.sessionId,0);
            assert.equal(child.token.isAppContainer,true);assert.equal(child.token.isElevated,false);assert.equal(child.token.integrityRid,4096);
            assert.equal(child.token.packageSid,worker.native.packageSid);assert.equal(child.token.userSidHash,hash(Buffer.from(sid)));assert.deepEqual(child.token.capabilitySids,['S-1-15-3-1']);
            assert.ok(!pids.has(child.pid));pids.add(child.pid);
          }
        }
        assert.equal(value.preflight.modelInvocations,0);assert.equal(value.worker.modelInvocations,1);
        assert.equal(value.worker.turnCompleted,true);assert.ok(value.worker.toolNames.includes('Read')&&value.worker.toolNames.includes('Write'));
        assert.equal(value.worker.native.providerSnapshotHash,value.providerSnapshotHash);
      }
    }else if(manifest.crossServiceIpc&&!manifest.crossServiceCredentialChannel){
      assert.equal(node.ipc.pass,true);assert.equal(node.ipc.round,i+1);assert.equal(node.ipc.role,role);assert.equal(node.ipc.providerUsed,false);
      assert.deepEqual(node.ipc.cases.map(item=>item.scenario),['success','capability','cross-run','server-pin','client-pin']);
      for(const item of node.ipc.cases){
        assert.equal(item.pass,true);
        if(item.scenario==='success'){
          assert.equal(item.peer.queryOnlyAuthorityVerified,true);
          assert.equal(item.peer.sid,summary.rounds[i][role==='control'?'executor':'control'].ordinaryToken.sid);
          assert.equal(item.peer.sessionId,0);assert.equal(item.peer.integrityRid,8192);
          assert.equal(item.peer.elevated,false);assert.equal(item.peer.enabledAdministrators,false);
          assert.match(item.peer.createdTicks,/^\d+$/);
          assert.ok(!pids.has(item.peer.pid));pids.add(item.peer.pid);
          if(role==='executor'){
            assert.equal(item.dispatched,1);assert.equal(item.replayRefused,true);
            assert.ok(item.dacl.includes('0x12019b;;;'+summary.rounds[i].control.ordinaryToken.sid));
            assert.ok(!/;;;(?:WD|AU|BU)\)/.test(item.dacl));
          }
        }else{
          const exact=role==='executor'?{capability:'IPC_CAPABILITY_DENIED','cross-run':'IPC_BINDING_MISMATCH','client-pin':'IPC_PEER_PIN_MISMATCH'}:{'server-pin':'IPC_PEER_PIN_MISMATCH'};
          if(exact[item.scenario])assert.equal(item.code,exact[item.scenario]);
          else assert.ok(['IPC_PEER_DISCONNECTED','IPC_TRANSPORT_FAILED','IPC_PROCESS_UNAVAILABLE','IPC_TOKEN_UNAVAILABLE'].includes(item.code));
          assert.equal(item.dispatched,0);
        }
      }
    }
  }
}
assert.notEqual(sids.control, sids.executor);
if(manifest.crossServiceCredentialChannel){
  const client=JSON.parse(await readFile(join(prepared.bundle,'credential-client.json'),'utf8'));assert.equal(client.pass,true);assert.equal(client.cases.length,10);assert.equal(client.exitCode,0);assert.equal(client.productionObservationUnchanged,true);
  const before=JSON.parse(await readFile(join(prepared.bundle,'production-before.json'),'utf8')),after=JSON.parse(await readFile(join(prepared.bundle,'production-after.json'),'utf8'));assert.deepEqual(after,before);productionObservation={before,after,unchangedAtObservationPoints:true};
  assert.equal(summary.credentialHandoffRemoved,true);assert.equal(summary.credentialKeysRemoved,true);
  const identities=new Set(),scenarios=['success','server-pin','snapshot','cross-run','owner-operation'];
  function providerWorker(worker,modelCount){
    assert.equal(worker.pass,true);assert.equal(worker.stopped,true);assert.equal(worker.credentialsRemoved,true);assert.equal(worker.runtimeRemoved,true);
    assert.equal(worker.modelInvocations,modelCount);assert.equal(worker.retainedSecretScan.remainingMatches,0);
    assert.equal(worker.boundary.pass,true);assert.ok(Object.values(worker.boundary.checks).every(x=>x===true));
    const native=worker.native;assert.equal(native.pass,true);assert.equal(native.profileDeleted,true);assert.equal(native.runtimeVerification,'protected-admin-qa-manifest');
    assert.equal(native.hostToken.userSidHash,hash(Buffer.from(sids.executor)));assert.equal(native.hostToken.sessionId,0);assert.equal(native.hostToken.isElevated,false);
    for(const key of ['privateDesktop','nonInteractiveSession0','fixedPreparedStation','cleanupComplete','stationDaclRestored'])assert.equal(native.serviceDesktop[key],true,key);
    assert.equal(native.serviceDesktop.managementHandlesInherited,false);assert.equal(native.serviceDesktop.exactPackageSid,native.packageSid);
    assert.equal(native.serviceDesktop.stationPackageMask,0x20123);assert.equal(native.serviceDesktop.desktopPackageMask,0x200c3);
    for(const child of native.cases){assert.equal(child.pass,true);assert.equal(child.remainingOwnedProcesses,0);assert.equal(child.token.sessionId,0);
      assert.equal(child.token.isAppContainer,true);assert.equal(child.token.isElevated,false);assert.equal(child.token.integrityRid,4096);
      assert.equal(child.token.packageSid,native.packageSid);assert.equal(child.token.userSidHash,hash(Buffer.from(sids.executor)));assert.deepEqual(child.token.capabilitySids,['S-1-15-3-1']);pids.add(child.pid);}
    if(modelCount){assert.equal(worker.turnCompleted,true);assert.ok(worker.toolNames.includes('Read')&&worker.toolNames.includes('Write'));assert.deepEqual(worker.output,{'甲':42,'乙':11});}
  }
  function endpoint(value,sid,query=true){assert.equal(value.sid,sid);assert.equal(value.sessionId,0);assert.equal(value.integrityRid,8192);assert.equal(value.elevated,false);assert.equal(value.enabledAdministrators,false);
    if(query)assert.equal(value.queryOnlyAuthorityVerified,true);assert.ok(Number.isSafeInteger(value.pid)&&value.pid>0);assert.match(value.createdTicks,/^\d{10,20}$/);
    const key=value.pid+'/'+value.createdTicks;if(!identities.has(key)){identities.add(key);pids.add(value.pid);}}
  for(const round of summary.rounds){const control=round.controlNode.credentialChannel,executor=round.executorNode.credentialChannel;
    for(const [role,value] of [['control',control],['executor',executor]]){assert.equal(value.pass,true);assert.equal(value.role,role);assert.equal(value.round,round.round);
      assert.equal(value.productionCredentialsRead,false);assert.equal(value.providerUsed,!!manifest.crossServiceCredentialProvider);assert.deepEqual(value.cases.map(x=>x.scenario),scenarios);}
    assert.equal(control.controlKeysRemoved,true);assert.equal(control.noCredentialFileHandoff,true);
    if(manifest.crossServiceCredentialProvider){
      assert.equal(summary.credentialsProvisioned,true);assert.equal(summary.provisionCredentialsRemoved,true);assert.equal(control.adminProvisionedStaticKey,true);
      providerWorker(executor.preflight,0);
      for(const relative of [`state/control/provider-provision-r${round.round}.json`,`handoff/control/r${round.round}-provider-vault-ready.json`,`handoff/executor/r${round.round}-provider-preflight.json`])await assert.rejects(lstat(join(protectedRoot,relative)),{code:'ENOENT'});
    }
    for(const [i,scenario] of scenarios.entries()){
      const c=control.cases[i],e=executor.cases[i],owner=client.cases.find(x=>x.round===round.round&&x.scenario===scenario),positive=scenario==='success';
      assert.equal(c.pass,true);assert.equal(e.pass,true);assert.equal(owner.ownerDenied,true);assert.equal(c.ownerDenied,true);assert.equal(e.calls,positive?1:0);
      assert.equal(c.reads,scenario==='server-pin'?0:2);assert.equal(c.authenticated,scenario!=='server-pin');assert.deepEqual(c.executor,e);
      endpoint(e.server,sids.executor,false);assert.equal(e.server.pid,owner.server.pid);assert.equal(e.server.createdTicks,owner.server.createdTicks);
      assert.equal(e.denials.length,5);assert.ok(e.denials.every(x=>x.denied===true));
      if(scenario==='server-pin'){assert.equal(c.controlNativeError,'RCC_PEER_PIN_MISMATCH');assert.equal(c.state,'failed');}
      else{endpoint(c.peer,sids.executor);endpoint(e.peer,sids.control);assert.equal(c.peer.pid,e.server.pid);assert.equal(c.peer.createdTicks,e.server.createdTicks);
        if(positive){assert.equal(c.state,'completed');assert.equal(c.originalDeviceResult,true);assert.equal(c.otherDeviceDenied,true);assert.equal(c.replayRefused,true);
          if(manifest.crossServiceCredentialProvider){providerWorker(e.worker,1);assert.equal(e.worker.native.providerSnapshotHash,c.dispatchSnapshotHash);
            for(const key of ['runId','requestId','grantId','authorityHash'])assert.equal(e.worker.native[key],c.restrictedExecution[key]);}
          assert.equal(e.warmReplayRefused,true);assert.equal(e.coldReplayRefused,true);assert.equal(c.receipt.authorityHash,c.restrictedExecution.authorityHash);}
        else{assert.equal(c.state,'running');assert.equal(c.restrictedExecution.state,'stop-unconfirmed');assert.equal(e.code,scenario==='snapshot'?'CD_SNAPSHOT_INVALID':scenario==='cross-run'?'RESTRICTED_IPC_SCOPE_INVALID':'CD_ENVELOPE_INVALID');}}
      for(const [location,kinds] of [['handoff/control',['offer','settled']],['handoff/executor',['ready','done']],['control/inbox',['owner-denied']]])
        for(const kind of kinds)for(const suffix of ['.json','.json.tmp'])await assert.rejects(lstat(join(protectedRoot,location,`r${round.round}-credential-${scenario}-${kind}${suffix}`)),{code:'ENOENT'});
    }
  }
}
if(manifest.ownerActivation)productionObservation=await verifyOwnerActivation({manifest,summary,bundle:prepared.bundle,protectedRoot,sids,pids});
else if(manifest.ownerDiscoverySet)productionObservation=await verifyOwnerSet({manifest,summary,bundle:prepared.bundle,protectedRoot,sids,pids});
else if(manifest.ownerPurposeV2)productionObservation=await verifyOwnerPurpose({manifest,summary,bundle:prepared.bundle,protectedRoot,sids,pids});
if(manifest.crossServiceOwnerBootstrap&&!manifest.ownerPurposeV2&&!manifest.ownerActivation){
  const before=JSON.parse((await readFile(join(prepared.bundle,'production-before.json'),'utf8')).replace(/^\uFEFF/,''));
  const after=JSON.parse((await readFile(join(prepared.bundle,'production-after.json'),'utf8')).replace(/^\uFEFF/,''));
  assert.deepEqual(after,before);productionObservation={before,after,unchangedAtObservationPoints:true};
  const client=JSON.parse(await readFile(join(prepared.bundle,'owner-bootstrap-client.json'),'utf8'));
  assert.equal(client.caseId,id);assert.equal(client.pass,true);assert.equal(client.launchExitCode,0);assert.equal(client.cases.length,20);
  for(const key of ['productionChanged','phoneTouched','providerUsed','actualPhoneOrTurn'])assert.equal(client[key],false);
  const scenarios=['success','replay','instance','request','nonce','operation','claimed-sid','extend','server-pin','disconnect'];
  const endpointIdentities=new Set();
  function rememberEndpoint(facts){
    assert.ok(Number.isSafeInteger(facts.pid)&&facts.pid>0);assert.match(facts.createdTicks,/^\d{10,20}$/);
    const key=facts.pid+'/'+facts.createdTicks;assert.ok(!endpointIdentities.has(key));endpointIdentities.add(key);pids.add(facts.pid);
  }
  const errors={instance:'OBC_BINDING_MISMATCH',request:'OBC_BINDING_MISMATCH',extend:'OBC_BINDING_MISMATCH',nonce:'OBC_CHALLENGE_DENIED',operation:'OBC_OPERATION_DENIED','claimed-sid':'OBC_FRAME_INVALID','server-pin':'OBC_PEER_DISCONNECTED',disconnect:'OBC_PEER_DISCONNECTED'};
  for(const round of summary.rounds){
    const control=round.controlNode.ownerBootstrap,executor=round.executorNode.ownerBootstrap;
    for(const [role,value] of [['control',control],['executor',executor]]){
      assert.equal(value.pass,true);assert.equal(value.role,role);assert.equal(value.round,round.round);assert.equal(value.productionCredentialsRead,false);
      assert.deepEqual(value.cases.map(x=>x.scenario),scenarios);
    }
    for(const key of ['signingKeyNeverInEndpointEnvironment','syntheticOwnerSessionsRevoked','signingFileRemoved'])assert.equal(control[key],true);
    for(const [i,scenario] of scenarios.entries()){
      const proof=client.cases.find(x=>x.round===round.round&&x.scenario===scenario),issued=['success','replay'].includes(scenario)?1:0;
      assert.equal(proof.pass,true);assert.equal(proof.issued,issued);assert.equal(control.cases[i].issued,issued);
      for(const value of [proof,control.cases[i]]){assert.equal(value.publicationVerified,true);assert.equal(value.publicationWithdrawn,true);}
      if(scenario==='success'){assert.equal(proof.retiredRefused,true);assert.equal(control.cases[i].refreshVerified,true);rememberEndpoint(control.cases[i].retiredEndpoint);}
      assert.equal(control.cases[i].pass,true);assert.equal(control.cases[i].executorDenied,true);assert.equal(executor.cases[i].executorDenied,true);
      assert.equal(proof.anonymousHttpDenied,true);assert.equal(proof.authenticatedHttpAccepted,!!issued);assert.equal(proof.revokedHttpDenied,!!issued);
      const server=proof.server;assert.equal(server.sid,sids.control);assert.equal(server.sessionId,0);assert.equal(server.integrityRid,8192);assert.equal(server.elevated,false);assert.equal(server.enabledAdministrators,false);
      rememberEndpoint(server);
      if(issued){
        const peer=control.cases[i].peer;assert.deepEqual(proof.owner,peer);assert.equal(peer.sid,manifest.requestorSid);assert.equal(peer.sessionId,manifest.ownerSessionId);
        assert.equal(peer.integrityRid,8192);assert.equal(peer.elevated,false);assert.equal(peer.enabledAdministrators,false);assert.equal(peer.queryOnlyAuthorityVerified,true);
        assert.equal(control.cases[i].replayRefused,true);rememberEndpoint(peer);
      }else{assert.equal(control.cases[i].nativeError,errors[scenario]);assert.equal(proof.nativeError,errors[scenario]);}
      for(const [location,kinds] of [['handoff/control',['ready','done']],['handoff/executor',['denied']],['control/inbox',['ack','finish']]])
        for(const kind of kinds)for(const suffix of ['.json','.json.tmp'])await assert.rejects(lstat(join(protectedRoot,location,`r${round.round}-owner-${scenario}-${kind}${suffix}`)),{code:'ENOENT'});
    }
    const discovery=join(protectedRoot,'state/control',`owner-auth-r${round.round}/config/owner-bootstrap-live.json`);
    for(const file of [discovery,discovery+'.publisher-lock'])await assert.rejects(lstat(file),{code:'ENOENT'});
  }
  assert.equal(summary.ownerHandoffRemoved,true);
  assert.equal(summary.ownerPublicationRemoved,true);assert.equal(client.productionObservationUnchanged,true);
}
assert.deepEqual(summary.runtimeRemoved.map(x => x.file).sort(), runtimeFiles.sort());
if(manifest.crossServiceIpc)assert.equal(summary.handoffRemoved,true);
if(manifest.crossServiceProvider){
  assert.equal(summary.providerHandoffRemoved,true);
  assert.equal(summary.desktopPreparerRegistration.account,'LocalSystem');
  for(const round of summary.rounds){assert.equal(round.desktopPreparer.pass,true);assert.equal(round.desktopPreparer.stationClosed,true);
    assert.equal(round.desktopPreparer.tasksAccepted,0);assert.equal(round.desktopPreparer.processesLaunched,0);assert.equal(round.desktopPreparer.executorMask,0x6002b);
    assert.equal(round.desktopPreparer.stationName,'Ragent-QA-'+id+'-r'+round.round);assert.equal(round.desktopPreparer.executorSid,sids.executor);}
  const desktopBytes=await readFile(join(prepared.bundle,'desktop-preparer-report.json'));
  assert.equal(hash(desktopBytes),hash(await readFile(join(protectedRoot,'export/desktop-preparer-report.json'))));
  if(!manifest.crossServiceCredentialProvider){
  const original=JSON.parse(await readFile(join(prepared.bundle,'original-run-provider.json'),'utf8'));
  assert.equal(original.pass,true);assert.equal(original.sourceUnchangedDuringRun,true);assert.equal(original.cases.length,2);
  assert.equal(original.provider.oauthCopied,false);assert.equal(original.actualPhoneOrTurn,false);
  for(const [i,item] of original.cases.entries()){
    const provider=summary.rounds[i].executorNode.provider;
    assert.equal(item.round,i+1);assert.equal(item.calls,1);assert.equal(item.coldReplayRefused,true);
    assert.equal(item.runId,provider.worker.native.runId);assert.equal(item.grantId,provider.worker.native.grantId);assert.equal(item.requestId,provider.worker.native.requestId);
    assert.equal(item.lease.authorityHash,provider.worker.native.authorityHash);assert.equal(item.resultReceipt.authorityHash,item.lease.authorityHash);
    assert.equal(item.providerSnapshotHash,provider.providerSnapshotHash);assert.equal(item.providerSnapshotHash,original.provider.snapshotHash);
    assert.equal(item.preview.state,'ready');assert.deepEqual(JSON.parse(item.preview.text),item.expected);assert.deepEqual(provider.worker.output,item.expected);
  }
}
}
for (const item of summary.runtimeRemoved) assert.equal(item.removed, true);
const files = [];
for (const role of ['control', 'executor']) for (const type of ['service', 'node']) {
  const file = role + '-' + type + '-report.json', raw = await readFile(join(prepared.bundle, file));
  assert.equal(hash(raw), hash(await readFile(join(protectedRoot, 'export', file))));
  assert.deepEqual(JSON.parse(raw), summary[role + (type === 'node' ? 'Node' : '')]);
  files.push({ file, sha256: hash(raw) });
}
const filter = [...pids].map(pid => 'ProcessId=' + pid).join(' OR ');
// A later verifier run can observe an unrelated process reusing an exited PID.
// Only a proven creation time strictly after this completed batch excludes it;
// missing/older creation times still fail. Never kill by a retained PID alone.
assert.ok(Number.isFinite(Date.parse(summary.completedAt)));
const ps = `$ErrorActionPreference='Stop';$qaCompleted=[DateTimeOffset]::Parse('${new Date(summary.completedAt).toISOString()}').UtcDateTime;$qaProcesses=@(Get-CimInstance Win32_Process -Filter '${filter}');[pscustomobject]@{nodes=@($qaProcesses|Where-Object {-not $_.CreationDate -or $_.CreationDate.ToUniversalTime() -le $qaCompleted}|Select-Object ProcessId,Name,CreationDate);reusedPids=@($qaProcesses|Where-Object {$_.CreationDate -and $_.CreationDate.ToUniversalTime() -gt $qaCompleted}|Select-Object ProcessId,Name,CreationDate);services=@(Get-CimInstance Win32_Service -Filter "${names.map(name=>`Name='${name}'`).join(' OR ')}"|Select-Object Name,State)}|ConvertTo-Json -Compress -Depth 4`;
const { stdout } = await exec('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });
const observed = JSON.parse(stdout.trim());
assert.deepEqual(observed.nodes, []); assert.deepEqual(observed.services, []);
const verified = { caseId: id, pass: true, verifiedAt: new Date().toISOString(), level: 'actual Windows virtual services, session 0, two start/stop rounds', crossServiceRunIpcVerified:!!manifest.crossServiceIpc, crossServiceOwnerBootstrapVerified:!!manifest.crossServiceOwnerBootstrap, crossServiceCredentialChannelVerified:!!manifest.crossServiceCredentialChannel, crossServiceCredentialProviderVerified:!!manifest.crossServiceCredentialProvider, crossServiceProviderAndOriginalRunVerified:!!manifest.crossServiceProvider, ownerActivationVerified:!!manifest.ownerActivation,ownerPurposeV2Verified:!!manifest.ownerPurposeV2, ownerDiscoverySetVerified:!!manifest.ownerDiscoverySet, scenariosPerRound:manifest.ownerActivation?5:manifest.ownerDiscoverySet?6:manifest.ownerPurposeV2?14:manifest.crossServiceCredentialChannel?5:manifest.crossServiceOwnerBootstrap?10:(manifest.crossServiceProvider?1:(manifest.crossServiceIpc?5:0)), rounds: 2, sids, pids: [...pids], sourceBaseCommit: manifest.sourceBaseCommit, sourceFiles: manifest.sourceFiles, ownerSources:ownerRows, manifestSha256: prepared.manifestSha256, summarySha256: hash(summaryBytes), exportedReports: files, observed, productionObservation, productionChanged: false, phoneTouched: false, credentialsUsed:!!manifest.crossServiceProvider, verifierSha256: hash(await readFile(fileURLToPath(import.meta.url))) };
await writeFile(join(prepared.bundle, 'verified-evidence.json'), JSON.stringify(verified, null, 2) + '\n');
console.log(JSON.stringify({ pass: true, caseId: id, rounds: 2, nodePids: [...pids], noRemainingOwnedNodesOrServices: true }));
