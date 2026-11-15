import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChildEnvironment } from '../scripts/launch-test-instance.mjs';

test('durable Run admission never routes temporary work to the generic runner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-boundary-'));
  const instance = { instanceDir: root, configDir: join(root, 'config'),
    memoryDir: join(root, 'memory'), spoolDir: join(root, 'spool'),
    providerHomesDir: join(root, 'provider-homes'), workRootDir: join(root, 'work'),
    port: 48731, id: 'boundary-test', ttlSeconds: 60 };
  const env = buildChildEnvironment(instance);
  for (const key of Object.keys(process.env)) {
    if (/^(RAGENT_|CHAT_|FCM_|FIREBASE_|OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, env);
  const runs = await import('../chat/runs.mjs');
  const { createMessageRunBinding, messageRunId } = await import('../chat/message-run-contract.mjs');
  const { assertRunExecutionBoundary, assertRunLaunchBoundary, authorizeTemporaryControlRun } = await import('../chat/run-execution-boundary.mjs');
  const { createDetachedRunnerSpawner, launchDetachedRunnerViaSupervisor, prepareDetachedRunnerProvider } = await import('../chat/run-launcher.mjs');
  const { createRunnerSupervisorServer, spawnSupervisedRunner } = await import('../chat/runner-supervisor-daemon.mjs');
  await Promise.all([instance.configDir, instance.spoolDir, instance.providerHomesDir,
    instance.memoryDir, instance.workRootDir].map(path => mkdir(path, { recursive: true })));
  async function bound(kind) {
    const record = { sessionId: `session-${randomUUID()}`, preparationId: `mprep_${randomUUID()}`,
      requestId: `request-${randomUUID()}`, fingerprint: 'a'.repeat(64) };
    record.scope = { version: 1, sessionId: record.sessionId, expectedScopeRevision: randomUUID(), expectedProjectId: null };
    const temporaryAuthority = { version: 1, instanceId: 'synthetic-instance',
      grantId: 'rtg_' + 'g'.repeat(24), deviceId: 'rdev_' + 'd'.repeat(24), invitationId: 'rti_' + 'i'.repeat(24),
      deviceKeyFingerprint: 'b'.repeat(64), bindingStamp: 'c'.repeat(64), expiresAt: Math.floor(Date.now() / 1000) * 1000 + 60000 };
    const binding = createMessageRunBinding(record, { folder: instance.workRootDir, riskMode: 'safe',
      privilegedMode: false, canDelegate: false, privilegeRoutingEnabled: false }, kind, { temporaryAuthority });
    const run = await runs.createRun({ status: { id: messageRunId(record), sessionId: record.sessionId,
      requestId: record.requestId, state: 'accepted', appApiMessageVersion: 1 },
      manifest: { appApiMessage: binding, folder: instance.workRootDir, prompt: 'synthetic input',
        // Neither a caller option nor environment flag is an isolation receipt.
        options: { isolationValidated: true, executionProfile: 'appcontainer', riskMode: 'safe' } } });
    return { run, manifest: await runs.getRunManifest(run.id) };
  }
  try {
    const temporary = await bound('temporary_device');
    await t.test('Owner, trusted-device and legacy ordinary publications remain admissible', async () => {
      for (const kind of ['owner', 'trusted_device']) {
        const { run } = await bound(kind);
        assert.equal((await assertRunLaunchBoundary(run.id)).run.id, run.id);
      }
      const ordinary = await runs.createRun({ status: { id: 'run_boundary_ordinary_123', state: 'accepted' }, manifest: {} });
      assert.equal((await assertRunLaunchBoundary(ordinary.id)).run.id, ordinary.id);
      assert.doesNotThrow(() => assertRunExecutionBoundary({ id: 'legacy' }, { folder: instance.workRootDir }));
    });
    await t.test('safe mode and caller isolation claims cannot enable temporary execution', async () => {
      assert.throws(() => assertRunExecutionBoundary(temporary.run, temporary.manifest), { code: 'RESTRICTED_EXECUTION_UNAVAILABLE' });
      await assert.rejects(assertRunLaunchBoundary(temporary.run.id), { code: 'RESTRICTED_EXECUTION_UNAVAILABLE' });
    });
    await t.test('confirmed full control is revalidated at launch and cannot use a stale or mismatched grant', async () => {
      const authority = { version: 1, grantId: 'rtg_' + 'g'.repeat(24), instanceId: 'inst_' + 'i'.repeat(24),
        deviceId: 'rdev_' + 'd'.repeat(24), deviceKeyFingerprint: 'a'.repeat(64), expiresAt: Date.now() + 600000 };
      const run = await runs.createRun({ status: { id: 'run_control_boundary_123', state: 'accepted' },
        manifest: { options: { authenticatedPrincipalKind: 'temporary_device', temporaryControlAuthority: authority } } });
      const manifest = await runs.getRunManifest(run.id);
      let active = true;
      const registry = { accessMaterial: async grantId => {
        if (!active || grantId !== authority.grantId) throw new Error('inactive');
        return { envelope: { invitation: { instanceId: authority.instanceId } },
          claim: { deviceKeyFingerprint: authority.deviceKeyFingerprint }, grant: { deviceId: authority.deviceId },
          accessExpiresAt: authority.expiresAt };
      } };
      const checkControl = (id, publication) => authorizeTemporaryControlRun(id, publication, registry);
      assert.equal((await assertRunLaunchBoundary(run.id, { checkControl })).run.id, run.id);
      const originalNow = Date.now;
      let simulatedNow = originalNow();
      Date.now = () => simulatedNow;
      try {
        await assert.rejects(assertRunLaunchBoundary(run.id, {
          checkControl: async (id, publication) => {
            await checkControl(id, publication);
            simulatedNow = authority.expiresAt;
          },
        }), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
      } finally { Date.now = originalNow; }
      await assert.rejects(authorizeTemporaryControlRun(run.id, randomUUID(), registry), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
      active = false;
      await assert.rejects(assertRunLaunchBoundary(run.id, { checkControl }), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
      assert.throws(() => assertRunExecutionBoundary(run, { ...manifest,
        options: { ...manifest.options, temporaryControlAuthority: { ...authority, deviceId: 'forged' } } }),
      { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
    });
    await t.test('common entry rejects before lifecycle, supervisor, systemd or process fallback', async () => {
      let transports = 0;
      process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET = 'synthetic-lifecycle';
      process.env.RAGENT_RUNNER_SUPERVISOR_SOCKET = 'synthetic-supervisor';
      const spawner = createDetachedRunnerSpawner({ platform: 'linux', getScopeImpl() { transports++; return 'system'; },
        connectImpl() { transports++; throw new Error('must not contact a broker'); },
        execFileImpl() { transports++; throw new Error('must not start systemd'); },
        spawnImpl() { transports++; throw new Error('must not spawn'); } });
      try {
        await assert.rejects(spawner(temporary.run.id), { code: 'RESTRICTED_EXECUTION_UNAVAILABLE' });
        await assert.rejects(spawner('run_missing_boundary_123'), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
        assert.equal(transports, 0);
      } finally {
        delete process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET;
        delete process.env.RAGENT_RUNNER_SUPERVISOR_SOCKET;
      }
    });
    await t.test('direct Provider preparation rejects before compatibility, home creation or credential resolution', async () => {
      let prepared = 0;
      await assert.rejects(prepareDetachedRunnerProvider(temporary.run.id, {
        readManifestImpl: async () => ({ ...temporary.manifest, tool: 'codex', options: { runtimeFamily: 'codex-json' } }),
        prepareNativeImpl: async () => { prepared++; throw new Error('must not read credentials'); },
      }), { code: 'RESTRICTED_EXECUTION_UNAVAILABLE' });
      assert.equal(prepared, 0);
    });
    await t.test('missing or corrupt persisted binding cannot be masked by the manifest cache', async () => {
      const path = runs.runManifestPath(temporary.run.id);
      const original = await readFile(path, 'utf8');
      try {
        for (const text of [JSON.stringify({ ...temporary.manifest, appApiMessage: undefined }), '{invalid JSON']) {
          await writeFile(path, text);
          await assert.rejects(assertRunLaunchBoundary(temporary.run.id), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
        }
      } finally { await writeFile(path, original); }
    });
    await t.test('real supervisor IPC rejects a bypass of the common entry', async () => {
      const socketPath = process.platform === 'win32'
        ? '\\\\.\\pipe\\ragent-boundary-' + randomBytes(12).toString('hex') : join(root, 'supervisor.sock');
      let spawned = 0;
      const server = await createRunnerSupervisorServer({ socketPath, spawnRunner: (id, options) =>
        spawnSupervisedRunner(id, { ...options, spawnImpl() { spawned++; throw new Error('must never spawn'); } }) });
      try {
        await assert.rejects(launchDetachedRunnerViaSupervisor(temporary.run.id, {
          socketPath, prepareProviderImpl: async () => ({}), timeoutMs: 10000 }), { code: 'RESTRICTED_EXECUTION_UNAVAILABLE' });
        assert.equal((await runs.getRun(temporary.run.id)).runnerProcessId ?? null, null);
        assert.equal(spawned, 0);
      } finally { await server.close(); }
    });
    await t.test('a real directly started sidecar rejects before running state or Provider startup', async () => {
      const sidecar = fileURLToPath(new URL('../chat/runner-sidecar.mjs', import.meta.url));
      const child = spawn(process.execPath, [sidecar, temporary.run.id], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '', timer;
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { tail = (tail + chunk).slice(-8000); });
      const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
      try {
        const code = await Promise.race([closed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Sidecar deadline exceeded')), 20000);
        })]);
        assert.equal(code, 1, tail);
        const fresh = await runs.getRunAcceptanceEvidence(temporary.run.id);
        assert.equal(fresh.state, 'failed');
        assert.equal(fresh.messageFailureCode, 'RESTRICTED_EXECUTION_UNAVAILABLE', tail);
        assert.equal(fresh.startedAt ?? null, null);
        assert.equal(fresh.runnerProcessId ?? null, null);
        assert.match(fresh.failureReason, /isolated runner/);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) { child.kill(); await closed; }
      }
    });
  } finally {
    const actual = await realpath(root);
    assert.equal(dirname(actual).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(actual).startsWith('ragent-boundary-'));
    await rm(actual, { recursive: true, force: true });
  }
});
