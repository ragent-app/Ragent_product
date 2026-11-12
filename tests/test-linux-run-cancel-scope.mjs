import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';

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
      const { createRun, getRunAcceptanceEvidence, requestRunCancel, recoverLinuxRunScopeRevocations, runIndexPath, updateRun } = await import('../chat/runs.mjs');
      const { hasLinuxRunCancelIntent } = await import('../chat/linux-run-cancel-intent.mjs');
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
        assert.equal(await hasLinuxRunCancelIntent(deniedId, 0), false);
        const unsafeId = 'run_unsafeconfig1';
        await createRun({ status: { id: unsafeId, sessionId: 's1', requestId: 't5', state: 'running' },
          manifest: { sessionId: 's1', requestId: 't5' } });
        const configMode = (await lstat(process.env.AGENTOC_CONFIG_DIR)).mode & 0o777;
        await chmod(process.env.AGENTOC_CONFIG_DIR, 0o777);
        try {
          await assert.rejects(requestRunCancel(unsafeId), { code: 'LINUX_CANCEL_INTENT_UNAVAILABLE' });
          assert.equal((await getRunAcceptanceEvidence(unsafeId)).cancelRequested, false);
        } finally { await chmod(process.env.AGENTOC_CONFIG_DIR, configMode); }
        const delayedId = 'run_delayedfixture1';
        await createRun({ status: { id: delayedId, sessionId: 's1', requestId: 't3', state: 'running', runnerLaunchAttempt: 1 },
          manifest: { sessionId: 's1', requestId: 't3' } });
        process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = `${root}/offline.sock`;
        await requestRunCancel(delayedId);
        assert.equal((await getRunAcceptanceEvidence(delayedId)).linuxScopeRevocationPending, true);
        process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = broker.socketPath;
        assert.equal((await recoverLinuxRunScopeRevocations({ scanAll: true })).revoked, 1);
        assert.equal((await getRunAcceptanceEvidence(delayedId)).linuxScopeRevocationPending, false);
        await updateRun(delayedId, (run) => ({ ...run, runnerLaunchAttempt: 2 }));
        assert.equal((await getRunAcceptanceEvidence(delayedId)).linuxScopeRevocationPending, true);
        assert.equal((await recoverLinuxRunScopeRevocations()).revoked, 1);
        const delayedName = `${createHash('sha256').update(delayedId).digest('hex')}-2.revoked`;
        assert.equal((await lstat(`${contextDirectory}/${delayedName}`)).mode & 0o777, 0o600);
        const staleId = 'run_stalefixture1';
        await createRun({ status: { id: staleId, sessionId: 's1', requestId: 't4', state: 'running' },
          manifest: { sessionId: 's1', requestId: 't4' } });
        process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = `${root}/offline.sock`;
        await requestRunCancel(staleId);
        // Emulate a crash after status replacement but before the index append.
        await appendFile(runIndexPath(), `${JSON.stringify({ kind: 'entry', op: 'put', id: staleId,
          sessionId: 's1', requestId: 't4', state: 'running', cancelRequested: false })}\n`);
        process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = broker.socketPath;
        const moduleUrl = new URL('../chat/runs.mjs', import.meta.url).href;
        const child = spawn(process.execPath, ['--input-type=module', '-e',
          `import {recoverLinuxRunScopeRevocations} from ${JSON.stringify(moduleUrl)}; await recoverLinuxRunScopeRevocations({scanAll:true});`],
        { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        assert.equal(code, 0, stderr);
        assert.equal((await getRunAcceptanceEvidence(staleId)).linuxScopeRevocationPending, false);
        const staleName = `${createHash('sha256').update(staleId).digest('hex')}-0.revoked`;
        assert.equal((await lstat(`${contextDirectory}/${staleName}`)).mode & 0o777, 0o600);
      } finally { await broker.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
