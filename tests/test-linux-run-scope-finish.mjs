import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

test('runner terminal write invalidates only its protected control binding',
  { skip: process.platform !== 'linux' || process.geteuid?.() !== 0 }, async () => {
    const root = await mkdtemp('/srv/agentoc-finish-scope-');
    try {
      await mkdir(`${root}/home`, { mode: 0o700 });
      process.env.HOME = `${root}/home`;
      process.env.AGENTOC_CONFIG_DIR = `${root}/config`;
      process.env.AGENTOC_RUN_SPOOL_DIR = `${root}/spool`;
      process.env.AGENTOC_MEMORY_DIR = `${root}/memory`;
      process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS = '1';
      process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = `${root}/broker.sock`;
      const { createRun, runStatusPath } = await import('../chat/runs.mjs');
      const { computeExecutionScopeDigest } = await import('../chat/execution-scope.mjs');
      const { issueLinuxRunScopeGrant } = await import('../chat/linux-run-scope-issuance.mjs');
      const { notifyLinuxRunScopeFinished } = await import('../chat/linux-run-scope-finish-client.mjs');
      const { hasLinuxRunCancelIntent } = await import('../chat/linux-run-cancel-intent.mjs');
      const { handleTemporaryControlRunCheck } = await import('../chat/router-temporary-control-run-check.mjs');
      const { createRunnerLifecycleServer } = await import('../scripts/runner-lifecycle-broker.mjs');
      const { withLinuxRunOperationLock } = await import('../scripts/linux-run-operation-lock.mjs');
      await mkdir(`${root}/contexts`, { mode: 0o700 });
      const broker = await createRunnerLifecycleServer({ socketPath: `${root}/broker.sock`, serviceUser: 'root', serviceGroup: 'root',
        controlUser: 'root', controlGroup: 'root', chownImpl: async () => {},
        runScopeRegistration: { directory: `${root}/contexts`, pinDirectory: `${root}/unused` } });
      const token = Buffer.alloc(32, 7).toString('base64url'), tokenHash = createHash('sha256').update(token).digest('hex');
      const runId = 'run_finishfixture1';
      const scope = { sessionId: 's1', cwd: { realPath: '/srv/work' }, scopeRoot: { realPath: '/srv/work' },
        riskContext: { platform: 'linux', cwd: '/srv/work', trustedWorkspaceRoot: '/srv/work' } };
      const manifest = { sessionId: 's1', requestId: 't1', executionScope: scope,
        executionScopeDigest: computeExecutionScopeDigest(scope), options: { approvedActionChannel: { turnId: 't1', token, tokenHash } } };
      const run = await createRun({ status: { id: runId, sessionId: 's1', requestId: 't1', state: 'running', runnerLaunchAttempt: 0 }, manifest });
      await issueLinuxRunScopeGrant(runId, 0);
      const bindingFile = `${root}/config/linux-run-cancel-intents/${createHash('sha256').update(runId).digest('hex')}-0.binding.json`;
      assert.equal((await readFile(bindingFile, 'utf8')).includes(token), false);
      // Recreate the installed separate-user spool boundary using two real
      // unprivileged UIDs. The control-only binding stays root-owned here.
      const account = (name) => {
        const fields = execFileSync('/usr/bin/getent', ['passwd', name], { encoding: 'utf8' }).trim().split(':');
        return { uid: Number(fields[2]), gid: Number(fields[3]) };
      };
      const owner = account(process.env.AGENTOC_TEST_OWNER_USER || 'pinggu'), runner = account('agentoc-runner');
      assert.ok(owner.uid > 0 && runner.uid > 0 && owner.uid !== runner.uid);
      execFileSync('/usr/bin/chmod', ['0711', root]);
      execFileSync('/usr/bin/chown', ['-R', `${owner.uid}:${runner.gid}`, `${root}/spool`]);
      execFileSync('/usr/bin/setfacl', ['-m', `u:${runner.uid}:rwx,d:u:${runner.uid}:rwx`, `${root}/spool`]);
      execFileSync('/usr/bin/setfacl', ['-m', `u:${runner.uid}:rwx`, `${root}/spool/${runId}`]);
      for (const filename of ['status.json', 'manifest.json'])
        execFileSync('/usr/bin/setfacl', ['-m', `u:${runner.uid}:r`, `${root}/spool/${runId}/${filename}`]);
      for (const filename of ['run-index.jsonl', 'request-index.jsonl'])
        execFileSync('/usr/bin/setfacl', ['-m', `u:${runner.uid}:rw`, `${root}/spool/${filename}`]);
      await mkdir(`${root}/runner-config`, { mode: 0o700 });
      execFileSync('/usr/bin/chown', [`${runner.uid}:${runner.gid}`, `${root}/runner-config`]);
      const server = createServer((req, res) => {
        void handleTemporaryControlRunCheck({ req, res, pathname: new URL(req.url, 'http://127.0.0.1').pathname,
          writeJson: (response, status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)) });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const wrong = { ...manifest, options: { approvedActionChannel: { token: Buffer.alloc(32, 8).toString('base64url') } } };
        assert.equal(await notifyLinuxRunScopeFinished(run, wrong, { base }), false);
        assert.equal(await notifyLinuxRunScopeFinished({ ...run, sessionId: 'other' }, manifest, { base }), false);
        assert.equal(await notifyLinuxRunScopeFinished({ ...run, runnerLaunchAttempt: 1 }, manifest, { base }), false);
        assert.equal(await hasLinuxRunCancelIntent(runId, 0), false);
        const moduleUrl = new URL('../chat/runs.mjs', import.meta.url).href;
        let release, locked;
        const acquired = new Promise((resolve) => { locked = resolve; });
        const held = new Promise((resolve) => { release = resolve; });
        // A still-draining earlier or later generation shares the Run lock.
        const operation = withLinuxRunOperationLock({ directory: `${root}/contexts`, runId, launchAttempt: 1 }, async () => {
          locked(); await held;
        });
        await acquired;
        const child = spawn('/usr/bin/setpriv', ['--reuid', String(runner.uid), '--regid', String(runner.gid), '--clear-groups', '--',
          process.execPath, '--input-type=module', '-e',
          `import {updateRun} from ${JSON.stringify(moduleUrl)}; await updateRun(${JSON.stringify(runId)}, {state:'completed'});`],
        { env: { ...process.env, HOME: `${root}/runner-config`, AGENTOC_CONFIG_DIR: `${root}/runner-config`,
          AGENTOC_MEMORY_DIR: `${root}/runner-config/memory`, AGENTOC_WORK_ROOT_DIR: `${root}/runner-config/workspace`,
          AGENTOC_LINUX_RUN_SCOPE_GRANTS: '0', AGENTOC_RUNNER_DISTINCT_IDENTITY: '1',
          AGENTOC_LINUX_SCOPE_FINISH_ENABLED: '1', AGENTOC_CHAT_BASE_URL: base }, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
        const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        try {
          for (let i = 0; i < 100 && !await hasLinuxRunCancelIntent(runId, 0); i++)
            await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(await hasLinuxRunCancelIntent(runId, 0), true);
          const pending = JSON.parse(await readFile(runStatusPath(runId), 'utf8'));
          assert.equal(pending.state, 'running');
          assert.equal(child.exitCode, null);
        } finally { release(); await operation; }
        const code = await completion;
        assert.equal(code, 0, stderr);
        assert.equal(await hasLinuxRunCancelIntent(runId, 0), true);
        const rootMarker = `${root}/contexts/${createHash('sha256').update(runId).digest('hex')}-0.revoked`;
        assert.equal(JSON.parse(await readFile(rootMarker, 'utf8')).version, 1);
        const saved = JSON.parse(await readFile(runStatusPath(runId), 'utf8'));
        assert.equal(saved.state, 'completed');
        // Invalidation survives a later forged status replacement.
        saved.state = 'running'; await writeFile(runStatusPath(runId), JSON.stringify(saved));
        assert.equal(await hasLinuxRunCancelIntent(runId, 0), true);
        const offlineId = 'run_finishoffline1';
        const offlineRun = await createRun({ status: { id: offlineId, sessionId: 's1', requestId: 't1',
          state: 'running', runnerLaunchAttempt: 0 }, manifest });
        await issueLinuxRunScopeGrant(offlineId, 0);
        process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET = `${root}/missing.sock`;
        assert.equal(await notifyLinuxRunScopeFinished(offlineRun, manifest, { base }), false);
        assert.equal(await hasLinuxRunCancelIntent(offlineId, 0), true);
      } finally { await new Promise((resolve) => server.close(resolve)); await broker.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
