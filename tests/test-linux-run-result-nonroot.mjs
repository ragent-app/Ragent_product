import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createRunnerLifecycleServer } from '../scripts/runner-lifecycle-broker.mjs';

test('non-root control recovers a distinct runner result after root broker returns',
  { skip: process.platform !== 'linux' || process.geteuid?.() !== 0, timeout: 30000 }, async () => {
    const account = (name) => {
      const fields = execFileSync('/usr/bin/getent', ['passwd', name], { encoding: 'utf8' }).trim().split(':');
      return { uid: Number(fields[2]), gid: Number(fields[3]) };
    };
    const owner = account(process.env.AGENTOC_TEST_OWNER_USER || 'pinggu'), runner = account('agentoc-runner');
    assert.ok(owner.uid > 0 && runner.uid > 0 && owner.uid !== runner.uid);
    const root = await mkdtemp('/srv/agentoc-nonroot-result-');
    let broker, control;
    const deadline = setTimeout(() => control?.kill('SIGKILL'), 25000);
    deadline.unref?.();
    try {
      await chmod(root, 0o711);
      for (const name of ['home', 'config', 'spool', 'memory']) {
        await mkdir(`${root}/${name}`, { mode: 0o700 });
        await chown(`${root}/${name}`, owner.uid, owner.gid);
      }
      await mkdir(`${root}/runner-home`, { mode: 0o700 });
      await chown(`${root}/runner-home`, runner.uid, runner.gid);
      await mkdir(`${root}/contexts`, { mode: 0o700 });
      const socketPath = `${root}/broker.sock`;
      const common = { ...process.env, AGENTOC_TEST_ROOT: root, AGENTOC_TEST_RUNNER_UID: String(runner.uid),
        AGENTOC_RUN_SPOOL_DIR: `${root}/spool`, AGENTOC_RUNNER_LIFECYCLE_SOCKET: socketPath };
      const fixture = fileURLToPath(new URL('./fixtures/linux-scope-nonroot-control.mjs', import.meta.url));
      let controlError = '', lines;
      const startControl = (recover = false) => {
        control = spawn('/usr/bin/setpriv', ['--reuid', String(owner.uid), '--regid', String(owner.gid), '--clear-groups', '--',
          process.execPath, fixture], { env: { ...common, HOME: `${root}/home`, AGENTOC_CONFIG_DIR: `${root}/config`,
            AGENTOC_MEMORY_DIR: `${root}/memory`, AGENTOC_RUNNER_SAME_USER: '0', AGENTOC_RUNNER_USER: 'agentoc-runner',
            AGENTOC_LINUX_RUN_SCOPE_GRANTS: recover ? '0' : '1', AGENTOC_TEST_RECOVER: recover ? '1' : '0' },
        stdio: ['pipe', 'pipe', 'pipe'] });
        control.stderr.on('data', (chunk) => { controlError += chunk; });
        lines = createInterface({ input: control.stdout })[Symbol.asyncIterator]();
      };
      startControl();
      const next = async () => {
        for (;;) {
          const item = await lines.next();
          if (item.done) throw new Error(`control exited: ${controlError}`);
          if (item.value.startsWith('QA:')) return JSON.parse(item.value.slice(3));
        }
      };
      const ready = await next();
      assert.equal(ready.uid, owner.uid);
      const moduleUrl = new URL('../chat/runs.mjs', import.meta.url).href;
      const outcome = { completedAt: '2026-11-12T00:00:00.000Z', exitCode: 0, signal: null };
      const sidecar = spawn('/usr/bin/setpriv', ['--reuid', String(runner.uid), '--regid', String(runner.gid), '--clear-groups', '--',
        process.execPath, '--input-type=module', '-e',
        `import {writeRunResult} from ${JSON.stringify(moduleUrl)}; try { await writeRunResult(${JSON.stringify(ready.runId)}, ${JSON.stringify(outcome)}); process.exit(1); } catch (e) { process.exit(e.code === 'LINUX_RUN_SCOPE_FINALIZATION_UNAVAILABLE' ? 23 : 2); }`],
      { env: { ...common, HOME: `${root}/runner-home`, AGENTOC_CONFIG_DIR: `${root}/runner-home`,
        AGENTOC_MEMORY_DIR: `${root}/runner-home/memory`, AGENTOC_LINUX_RUN_SCOPE_GRANTS: '0',
        AGENTOC_RUNNER_DISTINCT_IDENTITY: '1', AGENTOC_LINUX_SCOPE_FINISH_ENABLED: '1',
        AGENTOC_CHAT_BASE_URL: `http://127.0.0.1:${ready.port}` }, stdio: ['ignore', 'ignore', 'pipe'] });
      let runnerError = ''; sidecar.stderr.on('data', (chunk) => { runnerError += chunk; });
      const code = await new Promise((resolve, reject) => { sidecar.once('error', reject); sidecar.once('close', resolve); });
      assert.equal(code, 23, runnerError);
      const pending = `${root}/spool/${ready.runId}/result.pending.json`;
      assert.equal((await lstat(pending)).uid, runner.uid);
      control.stdin.write('read\n');
      assert.equal((await next()).error, 'LINUX_RUN_RESULT_UNAVAILABLE');
      let closed = new Promise((resolve) => control.once('close', resolve));
      control.stdin.end('exit\n');
      assert.equal(await closed, 0, controlError);
      control = null;
      broker = await createRunnerLifecycleServer({ socketPath, serviceUser: 'agentoc-runner',
        serviceGroup: 'root', controlUser: process.env.AGENTOC_TEST_OWNER_USER || 'pinggu', controlGroup: 'root',
        runScopeRegistration: { directory: `${root}/contexts`, pinDirectory: `${root}/unused` } });
      startControl(true);
      assert.equal((await next()).uid, owner.uid);
      control.stdin.write('read\n');
      assert.deepEqual((await next()).result, outcome);
      await assert.rejects(lstat(pending), { code: 'ENOENT' });
      const marker = `${root}/contexts/${createHash('sha256').update(ready.runId).digest('hex')}-0.revoked`;
      assert.equal(JSON.parse(await readFile(marker, 'utf8')).version, 1);
      const snapshot = `${root}/config/linux-run-cancel-intents/${createHash('sha256').update(ready.runId).digest('hex')}-0.result.json`;
      const snapshotStat = await lstat(snapshot);
      assert.equal(snapshotStat.uid, owner.uid);
      assert.equal(snapshotStat.mode & 0o777, 0o600);
      assert.throws(() => execFileSync('/usr/bin/setpriv', ['--reuid', String(runner.uid), '--regid', String(runner.gid),
        '--clear-groups', '--', '/usr/bin/cat', snapshot], { stdio: 'ignore' }));
      const sharedResult = `${root}/spool/${ready.runId}/result.json`;
      execFileSync('/usr/bin/setpriv', ['--reuid', String(runner.uid), '--regid', String(runner.gid), '--clear-groups', '--',
        process.execPath, '--input-type=module', '-e',
        `import {writeFileSync,renameSync} from 'node:fs'; writeFileSync(process.argv[1]+'.replacement',process.argv[2]); renameSync(process.argv[1]+'.replacement',process.argv[1]);`,
        sharedResult, JSON.stringify({ ...outcome, error: 'tampered-by-runner' })]);
      control.stdin.write('read\n');
      assert.deepEqual((await next()).result, outcome);
      execFileSync('/usr/bin/setpriv', ['--reuid', String(runner.uid), '--regid', String(runner.gid), '--clear-groups', '--',
        '/usr/bin/rm', '--', sharedResult]);
      control.stdin.write('read\n');
      assert.deepEqual((await next()).result, outcome);
      closed = new Promise((resolve) => control.once('close', resolve));
      control.stdin.end('exit\n');
      const exit = await closed;
      assert.equal(exit, 0, controlError);
      control = null;
    } finally {
      clearTimeout(deadline);
      control?.kill('SIGKILL');
      if (broker) await broker.close();
      await rm(root, { recursive: true, force: true });
    }
  });
