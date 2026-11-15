// Explicit live isolated QA: original Run authority in an ordinary coordinator,
// distinct service transport, executor-owned AppContainer and static key only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rename, unlink, lstat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomBytes, createHash, sign } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { buildChildEnvironment } from './launch-test-instance.mjs';
import { createRestrictedRunIpcGrant } from '../chat/restricted-run-ipc.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = join(source, 'artifacts/showcase/T2-current-20261017/service-identities');
if (!process.argv.includes('--live-provider')) throw new Error('Explicit --live-provider required');
test('two original temporary Runs complete through separate services and restricted Provider', { timeout: 460000 }, async t => {
  const prepared = JSON.parse(await readFile(join(evidence, 'prepared.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(prepared.bundle, 'manifest.json'), 'utf8'));
  assert.equal(manifest.crossServiceProvider, true);
  const qaRoot = join(process.env.ProgramData, 'RagentIdentityQA', 'case-' + manifest.caseId);
  const report = { caseId: manifest.caseId, pass: false, authority: 'local signed Accounts/DPoP fixture; original durable product Run',
    productionChanged: false, phoneTouched: false, actualPhoneOrTurn: false, providerCredentialResolved: false, cases: [], sourceFiles: manifest.sourceFiles };
  let liveStatus, liveOutput = '', liveError = '', key = '', controlFiles = [];
  const child = spawn('C:/Program Files/Ragent/payload/node.exe', [join(source, 'scripts/qa-windows-service-identities.mjs'), '--live'],
    { windowsHide: true, cwd: source, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { liveOutput = (liveOutput + bytes).slice(-65536); });
  child.stderr.on('data', bytes => { liveError = (liveError + bytes).slice(-65536); });
  const finished = new Promise(done => { child.once('error', () => { liveStatus = -1; done(-1); }); child.once('close', code => { liveStatus = code; done(code); }); });
  async function waitJson(path, milliseconds = 115000) {
    const until = Date.now() + milliseconds;
    while (Date.now() < until) {
      if (liveStatus !== undefined && liveStatus !== 0) throw Object.assign(new Error('Service launch failed'), { code: 'SERVICE_LAUNCH_FAILED' });
      try {
        const facts = await lstat(path);
        assert.ok(facts.isFile() && !facts.isSymbolicLink() && facts.nlink === 1 && facts.size <= 131072);
        return JSON.parse(await readFile(path, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(done => setTimeout(done, 50));
    }
    throw Object.assign(new Error('Service reply deadline'), { code: 'SERVICE_REPLY_DEADLINE' });
  }
  const hostRoot = await mkdtemp(join(tmpdir(), 'ragent-service-provider-host-'));
  await writeFile(join(hostRoot, '.ragent-service-provider-host'), manifest.caseId);
  try {
    const first = await waitJson(join(qaRoot, 'control/outbox/r1-provider-ready.json'), 180000);
    assert.equal(first.pass, true); // No production credential resolution before actual service boundary preflight.
    const instance = { instanceDir: hostRoot, configDir: join(hostRoot, 'config'), memoryDir: join(hostRoot, 'memory'),
      spoolDir: join(hostRoot, 'spool'), providerHomesDir: join(hostRoot, 'providers'), workRootDir: join(hostRoot, 'work'),
      port: 48172, id: 'service-provider-' + manifest.caseId, ttlSeconds: 180 };
    const env = buildChildEnvironment(instance);
    for (const name of Object.keys(process.env)) if (/^(RAGENT_|CHAT_|FCM_|FIREBASE_|OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_)/.test(name)) delete process.env[name];
    Object.assign(process.env, env);
    await Promise.all([instance.configDir, instance.workRootDir, instance.spoolDir].map(path => mkdir(path, { recursive: true })));
    const { fixture } = await import('../tests/helpers/temporary-turn-fixture.mjs');
    const f = await fixture(t, { initialTime: Date.now() });
    const { temporaryDeviceJwk } = await import('../lib/temporary-device-access.mjs');
    const { TemporarySessionService } = await import('../chat/temporary-session-service.mjs');
    const { TemporaryMessageService } = await import('../chat/temporary-message-service.mjs');
    const { TemporaryResultService } = await import('../chat/temporary-result-service.mjs');
    const { RestrictedRunHost } = await import('../chat/restricted-run-host.mjs');
    const runs = await import('../chat/runs.mjs'), meta = await import('../chat/session-meta-store.mjs');
    const { createNativeProviderRegistry } = await import('../lib/provider-runtime/registry.mjs');
    const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
    const configDir = 'C:/ProgramData/Ragent/instances/owner/config', registry = createNativeProviderRegistry({ configDir });
    const selected = (await registry.listProviderProfiles()).find(row => row.agentType === 'claude' && row.enabled !== false && row.status === 'ready' && row.protocol === 'anthropic-messages');
    assert.ok(selected);
    const auth = await registry.getAuthProfile(selected.authProfileId); assert.equal(auth?.authType, 'api-key');
    const url = new URL(selected.baseUrl); assert.equal(url.protocol, 'https:'); assert.ok(!url.username && !url.password && !url.search && !url.hash);
    const addresses = await lookup(url.hostname, { all: true });
    assert.ok(addresses.length && addresses.every(({ address }) => !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1$|::ffff:|f[cd]|fe80:)/i.test(address)));
    const provider = { profileIdHash: hash(selected.id), authIdHash: hash(auth.id), profileRevision: selected.revision,
      authRevision: auth.revision, protocol: selected.protocol, model: selected.modelPolicy.defaultModel, baseUrl: selected.baseUrl };
    const providerSnapshotHash = hash(JSON.stringify(provider));
    report.provider = { model: provider.model, profileRevision: provider.profileRevision, authRevision: provider.authRevision,
      endpointHash: hash(provider.baseUrl), snapshotHash: providerSnapshotHash, oauthCopied: false };
    const sessions = new TemporarySessionService({ host: f.host, workRoot: instance.workRootDir,
      availableTools: async () => [{ id: 'claude', name: 'Claude Code' }], runtimeCatalog: async tools => tools.map(tool => ({ ...tool, ready: true, status: 'ready' })) });
    const messages = new TemporaryMessageService({ host: f.host, schedule: () => {} }), results = new TemporaryResultService({ host: f.host });
    async function authenticate(phone){
      const enc=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),uri='https://service-candidate.example.test/messages';
      const input=enc({typ:'dpop+jwt',alg:'ES256',jwk:temporaryDeviceJwk(phone.claim.devicePublicKey).jwk})+'.'+enc({htm:'POST',htu:uri,
        iat:Math.floor(f.clock()/1000),jti:randomBytes(24).toString('base64url'),ath:createHash('sha256').update(phone.accessCredential.access_token).digest('base64url')});
      const proof=input+'.'+sign('sha256',Buffer.from(input),{key:phone.device.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
      return f.host.authenticateRequest({credential:phone.accessCredential,proof,method:'POST',targetUri:uri});
    }
    for (const round of [1, 2]) {
      if (round === 2) assert.equal((await waitJson(join(qaRoot, 'control/outbox/r2-provider-ready.json'), 45000)).pass, true);
      const phone = await f.enroll(),principal=await authenticate(phone);
      const created = await sessions.create(principal, { tool: 'claude', idempotencyKey: 'service-session-' + round });
      const scope = { version: 1, sessionId: created.session.sessionId, expectedScopeRevision: created.session.scopeRevision, expectedProjectId: created.session.projectId };
      await meta.mutateSessionMeta(scope.sessionId, session => { session.providerProfile = selected.id; session.model = provider.model; return true; });
      const values = [...randomBytes(4)].map(value => value + 1);
      const csv = `name,amount\nalpha,${values[0]}\nbeta,${values[1]}\nalpha,${values[2]}\nbeta,${values[3]}\n`;
      const expected = { alpha: values[0] + values[2], beta: values[1] + values[3] };
      const text = 'Read input.csv and use tools to write output.json containing numeric sums of amount grouped by name. Preserve input.csv. Task input CSV:\n' + csv;
      const request = { version: 1, requestId: 'service-request-' + round, text, attachments: [], runOptions: {}, expiresAt: new Date(Math.min(Date.now() + 100000, principal.expiry)).toISOString() };
      const preparation = await messages.prepare(principal, scope, request);
      const commit = { version: 1, preparationId: preparation.preparationId };
      const accepted = await messages.commit(principal, scope, request.requestId, commit);
      let calls = 0, response;
      const coordinator = new RestrictedRunHost({ host: f.host, worker: { tool: 'claude', preflight: async () => {},
        execute: async ({ lease, record, binding }) => {
          calls++; assert.equal(binding.configuration.providerProfile, selected.id); assert.equal(binding.configuration.model, provider.model);
          const current = await registry.getProviderProfile(selected.id), currentAuth = await registry.getAuthProfile(auth.id);
          assert.equal(current.revision, selected.revision); assert.equal(currentAuth.revision, auth.revision);
          const credential = await createSecretStore({ configDir }).resolveSecret(auth.storageRef);
          assert.equal(credential.ok, true); assert.ok(credential.apiKey); key = credential.apiKey; report.providerCredentialResolved = true;
          assert.equal((await registry.getAuthProfile(auth.id)).revision, auth.revision);
          const grant = createRestrictedRunIpcGrant({ instanceId: instance.id, lease }), frame = grant.frame(record.request.text);
          const policy = grant.receiverPolicy();
          const path = join(qaRoot, 'control/inbox', `r${round}-provider-request.json`); controlFiles.push(path, path + '.tmp');
          await writeFile(path + '.tmp', JSON.stringify({ policy, frame, provider, providerSnapshotHash, inputCSV: csv, apiKey: key }), { flag: 'wx' });
          await rename(path + '.tmp', path);
          response = await waitJson(join(qaRoot, 'control/outbox', `r${round}-provider-result.json`));
          assert.equal(response.providerSnapshotHash, providerSnapshotHash); assert.equal(response.worker.native.providerSnapshotHash, providerSnapshotHash);
          assert.equal(response.worker.native.runId, lease.runId); assert.equal(response.worker.native.authorityHash, lease.authorityHash);
          assert.equal(response.worker.credentialsRemoved, true); assert.equal(response.worker.runtimeRemoved, true); assert.equal(response.worker.retainedSecretScan.remainingMatches, 0);
          return response.outcome;
        } } });
      await coordinator.start(accepted.runId);
      const current = await runs.getRunAcceptanceEvidence(accepted.runId);
      assert.equal(current.state, 'completed');
      const preview = await results.preview(principal, scope, accepted.runId);
      assert.equal(preview.state, 'ready'); assert.deepEqual(JSON.parse(preview.text), expected);
      const replay = await messages.commit(principal, scope, request.requestId, commit); assert.equal(replay.runId, accepted.runId);
      await coordinator.start(accepted.runId);
      const cold = new RestrictedRunHost({ host: f.host, worker: { tool: 'claude', preflight: async () => {}, execute: async () => { calls++; throw new Error('Forbidden cold retry'); } } });
      await cold.start(accepted.runId); assert.equal(calls, 1);
      const other = await f.enroll();
      await assert.rejects(results.preview(await authenticate(other), scope, accepted.runId));
      report.cases.push({ round, runId: accepted.runId, requestId: request.requestId, grantId: principal.grantId, expected,
        preview: { state: preview.state, text: preview.text }, calls, coldReplayRefused: true, resultReceipt: current.result.restrictedReceipt,
        lease: current.restrictedExecution, workerCaseId: response.worker.workerCaseId, providerSnapshotHash });
    }
    assert.equal(await finished, 0);
    const summary = JSON.parse(await readFile(join(prepared.bundle, 'summary.json'), 'utf8')); assert.equal(summary.pass, true);
    for (const item of manifest.sourceFiles) assert.equal(hash(await readFile(join(source, item.path))), item.sha256, item.path);
    report.sourceUnchangedDuringRun = true; report.pass = true;
  } catch (error) { report.error = error.code || error.name; throw error; }
  finally {
    // The fixed admin batch and its independent service watchdog own service cleanup.
    await finished;
    for (const path of controlFiles) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await writeFile(join(prepared.bundle, 'provider-launch.log'), liveOutput.split(key || '\0NO_KEY').join('[REDACTED]') + liveError.split(key || '\0NO_KEY').join('[REDACTED]'));
    await writeFile(join(prepared.bundle, 'original-run-provider.json'), JSON.stringify(report, null, 2) + '\n');
    const actual = await realpath(hostRoot); assert.equal(dirname(actual).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(actual).startsWith('ragent-service-provider-host-'));
    assert.equal(await readFile(join(actual, '.ragent-service-provider-host'), 'utf8'), manifest.caseId);
    await rm(actual, { recursive: true, force: true });
    console.log(JSON.stringify({ pass: report.pass, caseId: manifest.caseId, completedOriginalRuns: report.cases.length, error: report.error || null }));
  }
});
