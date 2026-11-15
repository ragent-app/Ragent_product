import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createHash, randomBytes, sign } from 'node:crypto';
import { buildChildEnvironment } from '../scripts/launch-test-instance.mjs';
const hostLocalAppData = process.env.LOCALAPPDATA;
const hostUserProfile = process.env.USERPROFILE;

test('restricted host binds original temporary Run, result and stop acknowledgement', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ragent-restricted-host-'));
  const instance = { instanceDir: root, configDir: join(root, 'config'), memoryDir: join(root, 'memory'),
    spoolDir: join(root, 'spool'), providerHomesDir: join(root, 'providers'), workRootDir: join(root, 'work'),
    port: 48172, id: 'restricted-host-test', ttlSeconds: 60 };
  const env = buildChildEnvironment(instance);
  for (const key of Object.keys(process.env)) if (/^(RAGENT_|CHAT_|FCM_|FIREBASE_|OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_)/.test(key)) delete process.env[key];
  Object.assign(process.env, env);
  await Promise.all([instance.configDir, instance.workRootDir, instance.spoolDir].map(p => mkdir(p, { recursive: true })));
  const frozenSourceFiles = await Promise.all(['chat/restricted-run-host.mjs','chat/run-api-store.mjs',
    'native/windows-restricted-provider-candidate.cs','scripts/qa-windows-restricted-provider.mjs','tests/test-restricted-run-host.mjs',
    'chat/restricted-run-ipc.mjs','native/windows-run-pipe-candidate.cs','tests/helpers/windows-run-pipe-fixture.mjs',
    'chat/restricted-control-run-broker.mjs','lib/provider-runtime/registry.mjs','lib/provider-runtime/secret-store.mjs',
    'chat/fs-utils.mjs','lib/windows-file-replace.mjs'].map(async path => ({
    path, sha256: createHash('sha256').update(await readFile(new URL('../'+path, import.meta.url))).digest('hex'),
  })));
  const { fixture } = await import('./helpers/temporary-turn-fixture.mjs');
  const f = await fixture(t, { initialTime: Date.now() });
  const { temporaryDeviceJwk } = await import('../lib/temporary-device-access.mjs');
  const { TemporarySessionService } = await import('../chat/temporary-session-service.mjs');
  const { TemporaryMessageService } = await import('../chat/temporary-message-service.mjs');
  const { TemporaryResultService } = await import('../chat/temporary-result-service.mjs');
  const { RestrictedRunHost } = await import('../chat/restricted-run-host.mjs');
  const runs = await import('../chat/runs.mjs');
  const history = await import('../chat/history.mjs');
  const meta = await import('../chat/session-meta-store.mjs');
  const sessions = new TemporarySessionService({ host: f.host, workRoot: instance.workRootDir,
    availableTools: async () => [{ id: 'claude', name: 'Claude Code' }],
    runtimeCatalog: async tools => tools.map(x => ({ ...x, ready: true, status: 'ready' })) });
  const messages = new TemporaryMessageService({ host: f.host, schedule: () => {} });
  const results = new TemporaryResultService({ host: f.host });
  let count = 0;
  async function seed({ text = 'Produce a synthetic result.', provider } = {}) {
    const phone = await f.enroll(); const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const uri = 'https://candidate.example.test/messages';
    const data = `${enc({ typ: 'dpop+jwt', alg: 'ES256', jwk: temporaryDeviceJwk(phone.claim.devicePublicKey).jwk })}.${enc({
      htm: 'POST', htu: uri, iat: Math.floor(f.clock() / 1000), jti: randomBytes(24).toString('base64url'),
      ath: createHash('sha256').update(phone.accessCredential.access_token).digest('base64url') })}`;
    const proof = data + '.' + sign('sha256', Buffer.from(data), { key: phone.device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const principal = await f.host.authenticateRequest({ credential: phone.accessCredential, proof, method: 'POST', targetUri: uri });
    const created = await sessions.create(principal, { tool: 'claude', idempotencyKey: `session-${++count}` });
    const scope = { version: 1, sessionId: created.session.sessionId, expectedScopeRevision: created.session.scopeRevision,
      expectedProjectId: created.session.projectId };
    if (provider) await meta.mutateSessionMeta(scope.sessionId, session => {
      session.providerProfile = provider.id; session.model = provider.modelPolicy.defaultModel; return true;
    });
    const request = { version: 1, requestId: `restricted-${count}`, text,
      attachments: [], runOptions: {}, expiresAt: new Date(Math.min(Date.now() + 60000, principal.expiry)).toISOString() };
    const preparation = await messages.prepare(principal, scope, request);
    const commit = { version: 1, preparationId: preparation.preparationId };
    const accepted = await messages.commit(principal, scope, request.requestId, commit);
    return { phone, principal, scope, request, commit, runId: accepted.runId };
  }
  const outcome = (lease, patch = {}) => ({ leaseId: lease.leaseId, authorityHash: lease.authorityHash,
    runId: lease.runId, requestId: lease.requestId, grantId: lease.grantId, stopped: true, completed: true,
    text: 'SCOPED_RESULT_42', ...patch });
  const failures=new Map();
  const host = execute => new RestrictedRunHost({ host: f.host, pollMs: 25, worker: { tool: 'claude', preflight: async () => {}, execute },
    onFailure:async({runId,phase,error})=>{
      const localPath=value=>typeof value==='string'&&value.toLowerCase().startsWith(root.toLowerCase())?value.slice(root.length):undefined;
      const diagnostic={runId,phase,code:error.code||error.name,syscall:error.syscall,path:localPath(error.path),dest:localPath(error.dest)};
      failures.set(runId,diagnostic);
      const evidencePath=new URL('../artifacts/showcase/T2-current-20261017/control-broker/',import.meta.url);
      const {writeFile}=await import('node:fs/promises');await mkdir(evidencePath,{recursive:true});
      await writeFile(new URL(`failure-${runId}-${randomBytes(4).toString('hex')}.json`,evidencePath),JSON.stringify(diagnostic,null,2));
    } });
  const waitStarted = async (runId, ready = () => true) => {
    // Token probes are individually bounded at 10s; concurrent real Windows
    // probes cannot be measured with a 2s callback-fixture startup deadline.
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const current = await runs.getRunAcceptanceEvidence(runId);
      if (current.runnerStartedAt && ready()) return;
      if (runs.isTerminalRunState(current.state)) throw new Error(`Host terminalized before dispatch: ${current.messageFailureCode || current.state}; ${JSON.stringify(failures.get(runId))}`);
      await new Promise(done => setTimeout(done, 10)); }
    throw new Error('Host did not dispatch');
  };
  try {
    await t.test('missing backend and Owner-shaped inputs never execute', async () => {
      const v = await seed();
      await assert.rejects(new RestrictedRunHost({ host: f.host }).start(v.runId), { code: 'RESTRICTED_EXECUTION_UNAVAILABLE' });
      assert.equal((await runs.getRunAcceptanceEvidence(v.runId)).state, 'queued');
      await runs.createRun({ status: { id: 'run_restricted_owner_123', sessionId: v.scope.sessionId }, manifest: {} });
      await assert.rejects(host(() => { throw new Error('must not execute'); }).start('run_restricted_owner_123'));
    });
    await t.test('one real durable Run publishes a result readable only by its original device', async () => {
      const v = await seed(); let calls = 0;
      const coordinator = host(async ({ lease }) => { calls++; return outcome(lease); });
      await Promise.all([coordinator.start(v.runId), coordinator.start(v.runId)]);
      assert.equal(calls, 1);
      const run = await runs.getRunAcceptanceEvidence(v.runId);
      assert.equal(run.state, 'completed'); assert.equal(run.restrictedExecution.state, 'completed');
      assert.ok((await runs.getRunResult(v.runId)).restrictedReceipt);
      const preview = await results.preview(v.principal, v.scope, v.runId);
      assert.equal(preview.state, 'ready'); assert.equal(preview.text, 'SCOPED_RESULT_42');
      const replay = await messages.commit(v.principal, v.scope, v.request.requestId, v.commit);
      assert.equal(replay.runId, v.runId); assert.equal(replay.duplicate, true);
      await host(() => { calls++; throw new Error('cold host must not execute'); }).start(v.runId);
      assert.equal(calls, 1);
      const other = await seed(); await assert.rejects(results.preview(other.principal, v.scope, v.runId));
      assert.equal((await meta.findSessionMeta(v.scope.sessionId)).activeRunId ?? null, null);
    });
    await t.test('control broker uses original Run authority, private registry and durable one-use claim', async () => {
      const {createRestrictedControlRunBroker,createControlRunClaims}=await import('../chat/restricted-control-run-broker.mjs');
      const {createNativeProviderRegistry}=await import('../lib/provider-runtime/registry.mjs');
      const {createSecretStore}=await import('../lib/provider-runtime/secret-store.mjs');
      const {readdir}=await import('node:fs/promises');
      const config=join(root,'broker-private-config'),claimsDir=join(root,'broker-private-claims');await mkdir(claimsDir);
      const registry=createNativeProviderRegistry({configDir:config}),store=createSecretStore({configDir:config});
      const secret='SYNTHETIC-'+randomBytes(32).toString('hex'),unselected='UNSELECTED-'+randomBytes(32).toString('hex');
      await store.writeSecret('selected-key',{authType:'api-key',apiKey:secret});await store.writeSecret('unselected-key',{authType:'api-key',apiKey:unselected});
      assert.equal((await registry.upsertAuthProfile({id:'broker-auth',agentType:'claude',authType:'api-key',storageType:'secret-store',storageRef:'selected-key'})).ok,true);
      const saved=await registry.upsertProviderProfile({id:'broker-profile',agentType:'claude',protocol:'anthropic-messages',baseUrl:'https://broker.example.test/',authProfileId:'broker-auth',modelPolicy:{defaultModel:'synthetic-model'}});
      assert.equal(saved.ok,true);
      const v=await seed({provider:saved.profile,text:'Original broker task'});let calls=0,reads=0,broker,dispatchedLease;
      const peerSid='S-1-5-80-1-2-3-4-5';
      // Private peer facts and task execution are fixtures here. This subtest
      // proves the original durable authority/registry chain, not OS separation.
      const coordinator=host(async context=>{dispatchedLease=context.lease;return broker.execute(context);});
      const options={instanceId:instance.id,executorSid:peerSid,authority:coordinator,registry,
        secretStore:{resolveSecret:async ref=>{reads++;assert.equal(ref,'selected-key');return store.resolveSecret(ref);}},
        claims:createControlRunClaims({root:claimsDir}),authorizeEndpoint:async url=>({allowed:url==='https://broker.example.test/',revision:'local-policy-1'}),
        transport:{open:async()=>({peer:{sid:peerSid,sessionId:0,pid:1234,createdTicks:'134368500000000000',integrityRid:8192,elevated:false,enabledAdministrators:false,queryOnlyAuthorityVerified:true},
          send:async payload=>{calls++;assert.equal(payload.credential.apiKey,secret);assert.equal(payload.frame.payload.text,v.request.text);
            assert.equal(payload.snapshot.model,'synthetic-model');assert.ok(!JSON.stringify(payload).includes(unselected));
            const receiver=(await import('../chat/restricted-run-ipc.mjs')).createRestrictedRunIpcReceiver(payload.policy);
            const result=await receiver.accept(payload.frame,async fields=>({...fields,stopped:true,completed:true,text:'CONTROL_BROKER_RESULT'}));
            await assert.rejects(receiver.accept(payload.frame,()=>assert.fail()),{code:'RESTRICTED_IPC_ALREADY_USED'});
            return {snapshotHash:payload.snapshotHash,outcome:result};},close:async()=>{}})}};
      broker=createRestrictedControlRunBroker(options);await coordinator.start(v.runId);
      const evidence=await runs.getRunAcceptanceEvidence(v.runId);assert.equal(evidence.state,'completed');assert.equal(calls,1);assert.equal(reads,2);
      assert.equal((await results.preview(v.principal,v.scope,v.runId)).text,'CONTROL_BROKER_RESULT');
      const other=await seed();await assert.rejects(results.preview(other.principal,v.scope,v.runId));
      await coordinator.start(v.runId);await host(()=>assert.fail('cold host rerun')).start(v.runId);assert.equal(calls,1);
      const persisted=await readFile(join(claimsDir,(await readdir(claimsDir))[0]),'utf8');
      assert.ok(!persisted.includes(secret)&&!persisted.includes(unselected)&&!persisted.includes('Original broker task'));
      // A cold broker cannot use a stale final lease, even with an existing
      // private claim; original terminal authority is checked before lookup.
      await assert.rejects(createRestrictedControlRunBroker(options).execute({lease:dispatchedLease}));assert.equal(calls,1);assert.equal(reads,2);
      const manifest=await readFile(runs.runManifestPath(v.runId),'utf8');
      assert.ok(!manifest.includes(secret)&&!manifest.includes(unselected));
      const evidencePath=new URL('../artifacts/showcase/T2-current-20261017/control-broker/',import.meta.url);
      const {writeFile}=await import('node:fs/promises');await mkdir(evidencePath,{recursive:true});
      await writeFile(new URL(`case-${v.runId}.json`,evidencePath),JSON.stringify({pass:true,
        level:'original durable Run/registry/secret-store, synthetic peer and task callback; same ordinary process',
        actualControlService:false,productionChanged:false,providerUsed:false,phoneTouched:false,turnUsed:false,
        runId:v.runId,lease:dispatchedLease,receipt:evidence.result.restrictedReceipt,
        selectedCredentialReads:reads,dispatches:calls,unselectedCredentialRead:false,claimSecretFree:true,
        originalDeviceResult:true,otherDeviceDenied:true,coldReplayRefused:true,sourceFiles:frozenSourceFiles},null,2));
    });
    await t.test('cancellation records intent and waits for exact worker cleanup', async () => {
      const v = await seed(); let release, entered = false;
      const coordinator = host(({ lease, signal }) => new Promise(done => {
        entered = true;
        signal.addEventListener('abort', () => { release = () => done(outcome(lease, { completed: false })); }, { once: true });
      }));
      const running = coordinator.start(v.runId); await waitStarted(v.runId, () => entered);
      const request = await results.cancel(v.principal, v.scope, v.runId,
        { version: 1, expiresAt: new Date(Date.now() + 10000).toISOString() });
      assert.equal(request.disposition, 'cancellation_requested'); assert.equal(request.run.state, 'running');
      for (let i = 0; i < 200 && !release; i++) await new Promise(done => setTimeout(done, 10));
      assert.ok(release); assert.equal((await runs.getRunAcceptanceEvidence(v.runId)).state, 'running');
      release(); await running;
      assert.equal((await runs.getRunAcceptanceEvidence(v.runId)).state, 'cancelled');
      assert.equal((await history.readEventsAfter(v.scope.sessionId, 0)).length, 0);
    });
    await t.test('revocation before dispatch prevents worker and after dispatch prevents result publication', async () => {
      const a = await seed(); let calls = 0; await f.host.revoke(a.phone.claim.invitationId);
      await assert.rejects(host(() => { calls++; }).start(a.runId)); assert.equal(calls, 0);
      const b = await seed(); let entered = false;
      const running = host(({ lease, signal }) => new Promise(done => { entered = true; signal.addEventListener('abort',
        () => done(outcome(lease)), { once: true }); })).start(b.runId);
      await waitStarted(b.runId, () => entered); await f.host.revoke(b.phone.claim.invitationId); await running;
      assert.equal((await runs.getRunAcceptanceEvidence(b.runId)).state, 'failed');
      assert.equal((await history.readEventsAfter(b.scope.sessionId, 0)).length, 0);
    });
    await t.test('mismatched receipt leaves stop unconfirmed and cold host does not retry', async () => {
      const v = await seed(); let calls = 0;
      await host(async ({ lease }) => { calls++; return outcome(lease, { grantId: 'another-grant' }); }).start(v.runId);
      const run = await runs.getRunAcceptanceEvidence(v.runId);
      assert.equal(run.state, 'running'); assert.equal(run.restrictedExecution.state, 'stop-unconfirmed');
      await host(() => { calls++; }).start(v.runId); assert.equal(calls, 1);
      assert.equal((await history.readEventsAfter(v.scope.sessionId, 0)).length, 0);
      assert.equal((await meta.findSessionMeta(v.scope.sessionId)).activeRunId, v.runId);
    });
    await t.test('failed or nonresponsive private diagnostics do not change stop-unconfirmed settlement', async () => {
      for(const observe of [()=>{throw new Error('private observer failure');},()=>new Promise(()=>{}),event=>{event.error.code='OBSERVER_CHANGED';}]){
        const v=await seed();const coordinator=host(async({lease})=>outcome(lease,{stopped:false}));coordinator.onFailure=observe;
        await coordinator.start(v.runId);const current=await runs.getRunAcceptanceEvidence(v.runId);
        assert.equal(current.restrictedExecution.failureCode,'RESTRICTED_WORKER_STOP_UNCONFIRMED');
        assert.equal(current.restrictedExecution.state,'stop-unconfirmed');assert.equal(current.state,'running');
      }
    });
    await t.test('revocation immediately before return denies publication even before the next poll', async () => {
      const v = await seed();
      await host(async ({ lease }) => { await f.host.revoke(v.phone.claim.invitationId); return outcome(lease); }).start(v.runId);
      const run = await runs.getRunAcceptanceEvidence(v.runId);
      assert.equal(run.state, 'failed'); assert.equal(run.restrictedExecution.state, 'stopped');
      assert.equal((await history.readEventsAfter(v.scope.sessionId, 0)).length, 0);
    });
    await t.test('Session scope change and a replaced execution fence cannot publish a stale result', async () => {
      const a = await seed();
      await host(async ({ lease }) => {
        await meta.mutateSessionMeta(a.scope.sessionId, session => { session.folder = join(root, 'different-work'); return true; });
        return outcome(lease);
      }).start(a.runId);
      assert.equal((await runs.getRunAcceptanceEvidence(a.runId)).state, 'failed');
      assert.equal((await history.readEventsAfter(a.scope.sessionId, 0)).length, 0);
      const b = await seed();
      await host(async ({ lease }) => {
        await runs.updateRun(b.runId, run => ({ ...run, restrictedExecution: { ...run.restrictedExecution, leaseId: 'another-claim' } }));
        return outcome(lease);
      }).start(b.runId);
      const fenced = await runs.getRunAcceptanceEvidence(b.runId);
      assert.equal(fenced.restrictedExecution.leaseId, 'another-claim');
      assert.equal(fenced.state, 'running');
      assert.equal((await history.readEventsAfter(b.scope.sessionId, 0)).length, 0);
    });
    await t.test('revocation at final publication leaves no exit-zero result mirror', async () => {
      const v = await seed(); const original = f.host.authorizeStoredMessage;
      let historyCheckpoints = 0, revoked = false;
      f.host.authorizeStoredMessage = async function (...args) {
        if (args[0].grantId === v.principal.grantId && (await history.readEventsAfter(v.scope.sessionId, 0)).length) {
          if (++historyCheckpoints === 2) { revoked = true; await f.host.revoke(v.phone.claim.invitationId); }
        }
        return original.apply(this, args);
      };
      try { await host(async ({ lease }) => outcome(lease)).start(v.runId); }
      finally { f.host.authorizeStoredMessage = original; }
      assert.equal(revoked, true);
      assert.equal((await runs.getRunAcceptanceEvidence(v.runId)).state, 'failed');
      assert.equal(await runs.getRunResult(v.runId), null);
    });
    if (process.argv.includes('--native-ipc')) await t.test('native pinned IPC result publishes only through original Run authority', async () => {
      assert.equal(process.platform, 'win32');
      const { assertOrdinaryWindowsExecutionIdentity } = await import('../lib/windows-execution-identity.mjs');
      const { compileRunPipe, exchangeRunPipe } = await import('./helpers/windows-run-pipe-fixture.mjs');
      const { promisify } = await import('node:util');
      const { execFile } = await import('node:child_process');
      const { writeFile } = await import('node:fs/promises');
      const identity = await assertOrdinaryWindowsExecutionIdentity();
      const { stdout } = await promisify(execFile)('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Diagnostics.Process]::GetCurrentProcess().SessionId'],
        { windowsHide: true, timeout: 10000 });
      const sessionId = Number(stdout.trim()); assert.ok(Number.isInteger(sessionId));
      const exe = await compileRunPipe(root);
      const passes = [];
      for (const fault of ['', 'peer-disconnect', 'cancel-in-flight']) {
        const v = await seed({ text: 'Synthetic IPC result, no Provider' }); let calls = 0, native, entered = false, release;
        const coordinator = host(async ({ lease, record, signal }) => {
          native = await exchangeRunPipe({ exe, identity, sessionId, instanceId: instance.id, lease, fault, signal,
            text: record.request.text, execute: async binding => {
              calls++; entered = true;
              if (fault === 'cancel-in-flight') await new Promise(done => { release = done; });
              return outcome(binding, { text: 'IPC_RESULT_42' });
            } });
          return native.outcome;
        });
        const running = coordinator.start(v.runId);
        if (fault === 'cancel-in-flight') {
          await waitStarted(v.runId, () => entered);
          const cancellation = await results.cancel(v.principal, v.scope, v.runId,
            { version: 1, expiresAt: new Date(Date.now() + 10000).toISOString() });
          assert.equal(cancellation.disposition, 'cancellation_requested');
          assert.equal(cancellation.run.state, 'running');
        }
        await running;
        const current = await runs.getRunAcceptanceEvidence(v.runId);
        if (!fault) {
          assert.equal(current.state, 'completed');
          const preview = await results.preview(v.principal, v.scope, v.runId);
          assert.equal(preview.text, 'IPC_RESULT_42');
          const other = await seed(); await assert.rejects(results.preview(other.principal, v.scope, v.runId));
          await host(() => { calls++; throw new Error('No cold retry'); }).start(v.runId);
          assert.equal(calls, 1);
          passes.push({ fault: null, runId: v.runId, state: current.state, native, calls });
        } else {
          const expectedCalls = fault === 'cancel-in-flight' ? 1 : 0;
          assert.equal(calls, expectedCalls); assert.equal(current.state, 'running');
          assert.equal(current.restrictedExecution.state, 'stop-unconfirmed');
          assert.equal((await meta.findSessionMeta(v.scope.sessionId)).activeRunId, v.runId);
          assert.equal(await runs.getRunResult(v.runId), null);
          await host(() => { calls++; throw new Error('No cold retry'); }).start(v.runId);
          assert.equal(calls, expectedCalls);
          release?.(); // A late callback must not revive the abandoned pipe or publish a result.
          await new Promise(done => setTimeout(done, 25));
          assert.equal(await runs.getRunResult(v.runId), null);
          passes.push({ fault, runId: v.runId, state: current.state, restrictedExecution: current.restrictedExecution, calls });
        }
      }
      const evidencePath = new URL('../artifacts/showcase/T2-current-20261017/restricted-ipc/', import.meta.url);
      for (const frozen of frozenSourceFiles) assert.equal(createHash('sha256').update(
        await readFile(new URL('../'+frozen.path, import.meta.url))).digest('hex'), frozen.sha256, 'Source changed during native IPC test');
      await mkdir(evidencePath, { recursive: true });
      await writeFile(new URL(`host-${randomBytes(16).toString('hex')}.json`, evidencePath), JSON.stringify({
        pass: true, providerUsed: false, productionChanged: false, phoneTouched: false,
        sourceFiles: frozenSourceFiles, sourceUnchangedDuringRun: true,
        level: 'actual native transport, durable Run/result API; same ordinary SID/session and local Accounts/DPoP fixture', passes,
      }, null, 2));
    });
    if (process.argv.includes('--live-provider')) await t.test('real native Claude worker completes original authenticated temporary Run', async () => {
      assert.equal(process.platform, 'win32');
      const { createNativeProviderRegistry } = await import('../lib/provider-runtime/registry.mjs');
      const { assertOrdinaryWindowsExecutionIdentity } = await import('../lib/windows-execution-identity.mjs');
      const { runRestrictedProviderCandidate } = await import('../scripts/qa-windows-restricted-provider.mjs');
      const configDir = 'C:/ProgramData/Ragent/instances/owner/config';
      const registry = createNativeProviderRegistry({ configDir });
      const provider = (await registry.listProviderProfiles()).find(p => p.agentType === 'claude' && p.enabled !== false && p.status === 'ready');
      assert.ok(provider, 'Ready internal static Claude profile is required');
      const values = [...randomBytes(4)].map(n => n + 1);
      const inputCSV = `name,amount\nalpha,${values[0]}\nbeta,${values[1]}\nalpha,${values[2]}\nbeta,${values[3]}\n`;
      const expected = { alpha: values[0] + values[2], beta: values[1] + values[3] };
      const text = 'Read input.csv and use a tool to write output.json with numeric sums of amount grouped by name. Preserve input.csv. '
        + 'The task input CSV is also frozen here:\n' + inputCSV;
      const v = await seed({ text, provider }); let report, calls = 0;
      const coordinator = new RestrictedRunHost({ host: f.host, worker: {
        tool: 'claude',
        preflight: () => assertOrdinaryWindowsExecutionIdentity(),
        execute: async ({ lease, record, binding, signal }) => {
          calls++; assert.equal(record.request.text, text);
          assert.equal(binding.configuration.providerProfile, provider.id);
          report = await runRestrictedProviderCandidate({ harness: 'claude', quiet: true, signal,
            runInput: { ...lease, inputCSV, expected, prompt: record.request.text,
              configDir, providerProfileId: binding.configuration.providerProfile,
              model: binding.configuration.model, hostLocalAppData, hostUserProfile } });
          const stopped = report.native?.profileDeleted === true && report.native.cases.every(c => c.remainingOwnedProcesses === 0);
          if (report.pass) assert.equal(report.resultReceipt.authorityHash, lease.authorityHash);
          return outcome(lease, { stopped, completed: report.pass, text: JSON.stringify(report.output) });
        },
      } });
      await coordinator.start(v.runId);
      const current = await runs.getRunAcceptanceEvidence(v.runId);
      const preview = await results.preview(v.principal, v.scope, v.runId);
      assert.equal(current.state, 'completed', JSON.stringify({ phase: report?.error, state: current.state, code: current.messageFailureCode, native: report?.native?.error }));
      assert.equal(preview.state, 'ready'); assert.deepEqual(JSON.parse(preview.text), expected);
      assert.equal(report.native.runId, v.runId); assert.equal(report.native.grantId, v.principal.grantId);
      assert.equal(report.native.requestId, v.request.requestId);
      const replay = await messages.commit(v.principal, v.scope, v.request.requestId, v.commit);
      assert.equal(replay.runId, v.runId); assert.equal(replay.dispatched, true);
      await coordinator.start(v.runId); assert.equal(calls, 1);
      for (const frozen of frozenSourceFiles) assert.equal(createHash('sha256').update(
        await readFile(new URL('../'+frozen.path, import.meta.url))).digest('hex'), frozen.sha256, 'Source changed during live execution');
      const evidencePath = new URL('../artifacts/showcase/T2-current-20261017/restricted-host/', import.meta.url);
      await mkdir(evidencePath, { recursive: true });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(new URL(`case-${report.caseId}.json`, evidencePath), JSON.stringify({
        pass: true, level: 'real native Provider + durable product Run/result API; local Accounts/DPoP fixture, no phone/TURN',
        runId: v.runId, requestId: v.request.requestId, grantId: v.principal.grantId, providerCase: report.caseId,
        frozenBindingHash: (await (await import('../chat/message-commit-store.mjs')).readMessageRun(v.runId)).binding.bindingHash,
        restrictedExecution: current.restrictedExecution, receipt: current.result.restrictedReceipt,
        preview: { state: preview.state, text: preview.text }, expected, calls,
        native: report.native, sourceFiles: frozenSourceFiles, sourceUnchangedDuringRun: true,
      }, null, 2));
    });
  } finally {
    try {for(const frozen of frozenSourceFiles)assert.equal(createHash('sha256').update(
      await readFile(new URL('../'+frozen.path,import.meta.url))).digest('hex'),frozen.sha256,'Source changed during host test');
    } finally {
    const actual = await realpath(root); assert.equal(dirname(actual).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(actual).startsWith('ragent-restricted-host-'));
    await rm(actual, { recursive: true, force: true });
    }
  }
});
