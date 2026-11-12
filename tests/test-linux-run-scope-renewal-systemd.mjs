import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';

test('sweep renews a real live root registration and does not renew cancellation',
  { skip: process.platform !== 'linux' || process.geteuid?.() !== 0 || !process.env.AGENTOC_TEST_SYSTEMD_INVOCATION }, async () => {
    const root = await mkdtemp('/srv/agentoc-renew-sweep-');
    let server;
    try {
      await mkdir(`${root}/home`, { mode: 0o700 });
      await mkdir(`${root}/contexts`, { mode: 0o700 });
      await mkdir(`${root}/pin`, { mode: 0o700 });
      process.env.HOME = `${root}/home`;
      process.env.AGENTOC_CONFIG_DIR = `${root}/config`;
      process.env.AGENTOC_RUN_SPOOL_DIR = `${root}/spool`;
      process.env.AGENTOC_MEMORY_DIR = `${root}/memory`;
      process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS = '1';
      process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = `${root}/broker.sock`;
      const { createRun, updateRun } = await import('../chat/runs.mjs');
      const { computeExecutionScopeDigest } = await import('../chat/execution-scope.mjs');
      const { issueLinuxRunScopeGrant } = await import('../chat/linux-run-scope-issuance.mjs');
      const { signLinuxRunScopeGrant } = await import('../chat/linux-run-scope-grant.mjs');
      const { getActivePrivilegedSigningKey } = await import('../chat/privileged-signing-keys.mjs');
      const { assertRunLaunchBoundary } = await import('../chat/run-execution-boundary.mjs');
      const { createLinuxRunScopeRenewalSweep } = await import('../chat/linux-run-scope-renewal.mjs');
      const { enrollLinuxServiceKeyPin } = await import('../scripts/linux-service-key-pin.mjs');
      const { registerLinuxRunContext } = await import('../scripts/linux-run-context-store.mjs');
      const { createRunnerLifecycleServer } = await import('../scripts/runner-lifecycle-broker.mjs');
      const runId = 'run_test12345678', sessionId = 's1', requestId = 't1', attempt = 2;
      const token = Buffer.alloc(32, 9).toString('base64url'), tokenHash = createHash('sha256').update(token).digest('hex');
      const scope = { sessionId, cwd: { realPath: '/srv/work' }, scopeRoot: { realPath: '/srv/work' },
        riskContext: { platform: 'linux', cwd: '/srv/work', trustedWorkspaceRoot: '/srv/work' } };
      await createRun({ status: { id: runId, sessionId, requestId, state: 'running',
        runnerLaunchMode: 'runner-lifecycle', runnerLaunchAttempt: attempt },
      manifest: { sessionId, requestId, executionScope: scope, executionScopeDigest: computeExecutionScopeDigest(scope),
        options: { approvedActionChannel: { turnId: requestId, token, tokenHash } } } });
      await issueLinuxRunScopeGrant(runId, attempt);
      const key = getActivePrivilegedSigningKey();
      const keyId = createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
      await enrollLinuxServiceKeyPin({ directory: `${root}/pin`, publicKey: key.publicKey, expectedKeyId: keyId });
      const { run, manifest } = await assertRunLaunchBoundary(runId);
      const grant = signLinuxRunScopeGrant({ run, manifest, launchAttempt: attempt, privateKey: key.privateKey, ttlMs: 60000 });
      await registerLinuxRunContext({ directory: `${root}/contexts`, pinDirectory: `${root}/pin`, run, manifest, grant, launchAttempt: attempt });
      const options = { socketPath: `${root}/broker.sock`, serviceUser: 'root', serviceGroup: 'root', controlUser: 'root',
        controlGroup: 'root', chownImpl: async () => {}, runScopeRegistration: { directory: `${root}/contexts`, pinDirectory: `${root}/pin` } };
      const sweep = createLinuxRunScopeRenewalSweep();
      assert.deepEqual(await sweep({ scanAll: true }), { attempted: 1, renewed: 0 });
      server = await createRunnerLifecycleServer(options);
      assert.deepEqual(await sweep(), { attempted: 1, renewed: 1 });
      const name = `${createHash('sha256').update(runId).digest('hex')}-${attempt}.json`;
      const record = JSON.parse(await readFile(`${root}/contexts/${name}`, 'utf8'));
      assert.ok(Date.parse(record.grant.expiresAt) > Date.parse(grant.expiresAt));
      assert.deepEqual(await sweep(), { attempted: 0, renewed: 0 });
      await updateRun(runId, { cancelRequested: true });
      assert.deepEqual(await createLinuxRunScopeRenewalSweep()({ scanAll: true }), { attempted: 0, renewed: 0 });
    } finally { if (server) await server.close(); await rm(root, { recursive: true, force: true }); }
  });
