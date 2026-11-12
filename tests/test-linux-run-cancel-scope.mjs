import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';

test('persisted Run cancellation notifies the root lifecycle broker',
  { skip: process.platform !== 'linux' || process.geteuid?.() !== 0 }, async () => {
    const root = await mkdtemp('/srv/agentoc-cancel-scope-');
    const contextDirectory = `${root}/contexts`;
    try {
      await mkdir(contextDirectory, { mode: 0o700 });
      await mkdir(`${root}/home`, { mode: 0o700 });
      process.env.HOME = `${root}/home`;
      process.env.AGENTOC_CONFIG_DIR = `${root}/config`;
      process.env.AGENTOC_RUN_SPOOL_DIR = `${root}/spool`;
      process.env.AGENTOC_MEMORY_DIR = `${root}/memory`;
      process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS = '1';
      process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = `${root}/broker.sock`;
      const { createRunnerLifecycleServer } = await import('../scripts/runner-lifecycle-broker.mjs');
      const { createRun, requestRunCancel } = await import('../chat/runs.mjs');
      const broker = await createRunnerLifecycleServer({ socketPath: process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET,
        serviceUser: 'root', serviceGroup: 'root', controlUser: 'root', controlGroup: 'root', chownImpl: async () => {},
        runScopeRegistration: { directory: contextDirectory, pinDirectory: `${root}/unused` } });
      try {
        const id = 'run_cancelfixture1';
        await createRun({ status: { id, sessionId: 's1', requestId: 't1', state: 'running', runnerLaunchAttempt: 2 },
          manifest: { sessionId: 's1', requestId: 't1' } });
        const cancelled = await requestRunCancel(id);
        assert.equal(cancelled.cancelRequested, true);
        const name = `${createHash('sha256').update(id).digest('hex')}-2.revoked`;
        assert.equal((await lstat(`${contextDirectory}/${name}`)).mode & 0o777, 0o600);
        const deniedId = 'run_deniedfixture1';
        await createRun({ status: { id: deniedId, sessionId: 's1', requestId: 't2', state: 'running' },
          manifest: { sessionId: 's1', requestId: 't2' } });
        await assert.rejects(requestRunCancel(deniedId, { beforeWrite: () => { throw new Error('cancel denied'); } }));
        const deniedName = `${createHash('sha256').update(deniedId).digest('hex')}-0.revoked`;
        await assert.rejects(lstat(`${contextDirectory}/${deniedName}`), { code: 'ENOENT' });
      } finally { await broker.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
