import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

test('root challenge checks fresh persisted Run state through the real local route',
  { skip: process.platform !== 'linux' || process.geteuid?.() !== 0 }, async () => {
    const root = await mkdtemp('/srv/agentoc-active-proof-');
    try {
      await mkdir(`${root}/home`, { mode: 0o700 });
      process.env.HOME = `${root}/home`;
      process.env.AGENTOC_CONFIG_DIR = `${root}/config`;
      process.env.AGENTOC_RUN_SPOOL_DIR = `${root}/spool`;
      process.env.AGENTOC_MEMORY_DIR = `${root}/memory`;
      process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS = '1';
      process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = `${root}/offline.sock`;
      const { createRun, requestRunCancel, runStatusPath, updateRun } = await import('../chat/runs.mjs');
      const { loadOrCreatePrivilegedSigningKeys, getActivePrivilegedSigningKey } = await import('../chat/privileged-signing-keys.mjs');
      const { handleTemporaryControlRunCheck } = await import('../chat/router-temporary-control-run-check.mjs');
      const { checkLinuxRunActive } = await import('../scripts/linux-run-active-client.mjs');
      const { ensureLinuxRunCancelIntentStore, hasLinuxRunCancelIntent } = await import('../chat/linux-run-cancel-intent.mjs');
      const { computeExecutionScopeDigest } = await import('../chat/execution-scope.mjs');
      const { issueLinuxRunScopeGrant } = await import('../chat/linux-run-scope-issuance.mjs');
      await loadOrCreatePrivilegedSigningKeys(`${root}/keys.json`);
      await ensureLinuxRunCancelIntentStore();
      const runId = 'run_activefixture1';
      const token = Buffer.alloc(32, 5).toString('base64url'), tokenHash = createHash('sha256').update(token).digest('hex');
      const scope = { sessionId: 's1', cwd: { realPath: '/srv/work' }, scopeRoot: { realPath: '/srv/work' },
        riskContext: { platform: 'linux', cwd: '/srv/work', trustedWorkspaceRoot: '/srv/work' } };
      const inputManifest = { sessionId: 's1', requestId: 't1', executionScope: scope,
        executionScopeDigest: computeExecutionScopeDigest(scope), options: { approvedActionChannel: { turnId: 't1', token, tokenHash } } };
      await createRun({ status: { id: runId, sessionId: 's1', requestId: 't1', state: 'running',
        runnerLaunchMode: 'runner-lifecycle', runnerLaunchAttempt: 2 },
      manifest: inputManifest });
      await issueLinuxRunScopeGrant(runId, 2);
      const server = createServer((req, res) => {
        void handleTemporaryControlRunCheck({ req, res, pathname: new URL(req.url, 'http://127.0.0.1').pathname,
          writeJson: (response, status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)) });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const state = { runId, sessionId: 's1', turnId: 't1', launchAttempt: 2, invocationId: 'a'.repeat(32) };
        const options = { base: `http://127.0.0.1:${server.address().port}`, publicKey: getActivePrivilegedSigningKey().publicKey };
        assert.equal(await checkLinuxRunActive(state, options), true);
        assert.equal(await checkLinuxRunActive(state, { ...options, publicKey: generateKeyPairSync('ed25519').publicKey }), false);
        assert.equal(await checkLinuxRunActive({ ...state, launchAttempt: 3 }, options), false);
        await requestRunCancel(runId);
        assert.equal(await hasLinuxRunCancelIntent(runId, 3), true);
        assert.equal(await checkLinuxRunActive(state, options), false);
        // A compromised runner can rewrite its shared status; the inaccessible
        // control-plane cancellation marker must still refuse the challenge.
        const statusPath = runStatusPath(runId), tampered = JSON.parse(await readFile(statusPath, 'utf8'));
        tampered.cancelRequested = false;
        await writeFile(statusPath, JSON.stringify(tampered));
        assert.equal(await checkLinuxRunActive(state, options), false);
        for (const [suffix, update] of [['direct', { cancelRequested: true }], ['terminal', { state: 'completed' }]]) {
          const id = `run_active${suffix}1`;
          await createRun({ status: { id, sessionId: 's1', requestId: 't1', state: 'running',
            runnerLaunchMode: 'runner-lifecycle', runnerLaunchAttempt: 2 },
          manifest: inputManifest });
          await issueLinuxRunScopeGrant(id, 2);
          await updateRun(id, update);
          assert.equal(await hasLinuxRunCancelIntent(id, 2), true);
          const file = runStatusPath(id), forged = JSON.parse(await readFile(file, 'utf8'));
          forged.state = 'running'; forged.cancelRequested = false;
          await writeFile(file, JSON.stringify(forged));
          assert.equal(await checkLinuxRunActive({ ...state, runId: id }, options), false);
        }
        assert.equal(await checkLinuxRunActive(state, { ...options, base: 'http://example.com/' }), false);
      } finally { await new Promise((resolve) => server.close(resolve)); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
