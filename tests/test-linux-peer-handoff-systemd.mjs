import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { chmod, chown, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createRunnerLifecycleServer } from '../scripts/runner-lifecycle-broker.mjs';
import { createLinuxRunPeerResultServer } from '../scripts/linux-run-peer-result-server.mjs';
import { enrollLinuxServiceKeyPin } from '../scripts/linux-service-key-pin.mjs';
import { registerLinuxRunContext } from '../scripts/linux-run-context-store.mjs';

test('systemd runner hands a result to real root broker and non-root control',
  { skip: process.platform !== 'linux' || process.geteuid?.() !== 0 || process.env.AGENTOC_TEST_SYSTEMD_PEER !== '1', timeout: 45000 }, async () => {
    const account = name => {
      const fields = execFileSync('/usr/bin/getent', ['passwd', name], { encoding: 'utf8' }).trim().split(':');
      return { uid: Number(fields[2]), gid: Number(fields[3]) };
    };
    const controlAccount = account('nobody'), runner = account('agentoc-runner');
    assert.ok(controlAccount.uid > 0 && runner.uid > 0 && controlAccount.uid !== runner.uid);
    const root = await mkdtemp('/srv/agentoc-peer-handoff-');
    const runId = 'run_peerhandofffixture1';
    const unit = `agentoc-runner-${runId}.service`;
    let lifecycle, inbox, control, started = false;
    try {
      assert.equal(execFileSync('/usr/bin/systemctl', ['show', '--property=LoadState', '--value', unit], { encoding: 'utf8' }).trim(), 'not-found');
      await chmod(root, 0o711);
      for (const name of ['home', 'config', 'spool', 'memory']) {
        await mkdir(`${root}/${name}`, { mode: 0o700 });
        await chown(`${root}/${name}`, controlAccount.uid, controlAccount.gid);
      }
      await mkdir(`${root}/runner-home`, { mode: 0o700 });
      await chown(`${root}/runner-home`, runner.uid, runner.gid);
      for (const name of ['contexts', 'pin', 'results']) await mkdir(`${root}/${name}`, { mode: 0o700 });
      const helper = `${root}/peercred`, endpoint = `${root}/result.sock`, lifecycleSocket = `${root}/lifecycle.sock`;
      execFileSync('/usr/bin/gcc', ['-Wall', '-Wextra', '-Werror', '-O2',
        fileURLToPath(new URL('../native/privileged-peercred.c', import.meta.url)), '-o', helper]);
      lifecycle = await createRunnerLifecycleServer({ socketPath: lifecycleSocket, serviceUser: 'agentoc-runner',
        serviceGroup: 'agentoc-runners', controlUser: 'nobody', controlGroup: 'nobody',
        runScopeRegistration: { directory: `${root}/contexts`, pinDirectory: `${root}/pin` } });
      const fixture = fileURLToPath(new URL('./fixtures/linux-peer-handoff-control.mjs', import.meta.url));
      let errorOutput = '';
      control = spawn('/usr/bin/setpriv', ['--reuid', String(controlAccount.uid), '--regid', String(controlAccount.gid), '--clear-groups', '--',
        process.execPath, fixture], { env: { ...process.env, HOME: `${root}/home`, AGENTOC_CONFIG_DIR: `${root}/config`,
          AGENTOC_MEMORY_DIR: `${root}/memory`, AGENTOC_RUN_SPOOL_DIR: `${root}/spool`, AGENTOC_TEST_ROOT: root,
          AGENTOC_TEST_RUNNER_UID: String(runner.uid), AGENTOC_LINUX_RUN_SCOPE_GRANTS: '1',
          AGENTOC_RUNNER_LIFECYCLE_SOCKET: lifecycleSocket, AGENTOC_LINUX_PEER_RESULT_SOCKET: endpoint,
          AGENTOC_LINUX_PEER_CREDENTIAL_HELPER: helper }, stdio: ['pipe', 'pipe', 'pipe'] });
      control.stderr.on('data', data => { errorOutput += data.toString(); });
      const lines = createInterface({ input: control.stdout })[Symbol.asyncIterator]();
      const next = async () => {
        for (;;) {
          const item = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('control response timeout')), 10000);
            lines.next().then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
          });
          if (item.done) throw new Error(`control exited: ${errorOutput}`);
          if (item.value.startsWith('QA:')) return JSON.parse(item.value.slice(3));
        }
      };
      const ready = await next();
      const publicKey = createPublicKey(ready.publicKey);
      const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
      await enrollLinuxServiceKeyPin({ directory: `${root}/pin`, publicKey, expectedKeyId: keyId });
      inbox = await createLinuxRunPeerResultServer({ socketPath: endpoint, directory: `${root}/contexts`,
        pinDirectory: `${root}/pin`, resultDirectory: `${root}/results`, controlUid: controlAccount.uid, peerHelper: helper });
      const task = fileURLToPath(new URL('./fixtures/linux-peer-handoff-task.mjs', import.meta.url));
      const env = { HOME: `${root}/runner-home`, AGENTOC_CONFIG_DIR: `${root}/runner-home`,
        AGENTOC_MEMORY_DIR: `${root}/runner-home/memory`, AGENTOC_RUN_SPOOL_DIR: `${root}/spool`,
        AGENTOC_LINUX_RUN_SCOPE_GRANTS: '0', AGENTOC_RUNNER_DISTINCT_IDENTITY: '1',
        AGENTOC_LINUX_SCOPE_FINISH_ENABLED: '1', AGENTOC_LINUX_PEER_RESULT_RUNNER: '1',
        AGENTOC_LINUX_PEER_RESULT_SOCKET: endpoint, AGENTOC_LINUX_PEER_CREDENTIAL_HELPER: helper,
        AGENTOC_CHAT_BASE_URL: `http://127.0.0.1:${ready.port}` };
      const args = ['--quiet', '--collect', '--service-type=exec', `--unit=${unit}`, '--slice=agentoc-runners.slice',
        '--property=User=agentoc-runner', '--property=NoNewPrivileges=yes', '--property=KillMode=control-group'];
      for (const [key, value] of Object.entries(env)) args.push(`--setenv=${key}=${value}`);
      started = true;
      execFileSync('/usr/bin/systemd-run', [...args, process.execPath, task], { timeout: 10000 });
      await registerLinuxRunContext({ directory: `${root}/contexts`, pinDirectory: `${root}/pin`,
        run: ready.run, manifest: ready.manifest, grant: ready.grant, launchAttempt: 0, runnerUid: runner.uid });
      let outcome;
      for (let i = 0; i < 60; i++) {
        control.stdin.write('read\n');
        outcome = await next();
        if (outcome.result) break;
        assert.equal(outcome.error, 'LINUX_RUN_RESULT_UNAVAILABLE');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const result = { completedAt: '2026-11-12T00:00:00.000Z', exitCode: 0, signal: null };
      assert.deepEqual(outcome?.result, result, errorOutput);
      assert.equal(JSON.parse(await readFile(`${root}/spool/${runId}/status.json`, 'utf8')).state, 'completed');
      control.stdin.write('clear\n');
      assert.deepEqual(await next(), { cleared: true });
      control.stdin.write('read\n');
      assert.deepEqual(await next(), { result: null });
      const target = `${root}/results/${createHash('sha256').update(runId).digest('hex')}-0.peer-result.json`;
      await assert.rejects(readFile(target, 'utf8'), { code: 'ENOENT' });
      const controlExit = new Promise(resolve => control.once('close', resolve));
      control.stdin.end('exit\n');
      assert.equal(await controlExit, 0, errorOutput);
      control = null;
    } finally {
      let stopped = true;
      if (started) {
        try { execFileSync('/usr/bin/systemctl', ['stop', unit], { timeout: 10000, stdio: 'ignore' }); }
        catch {
          try {
            const state = execFileSync('/usr/bin/systemctl', ['show', '--property=LoadState', '--value', unit], { encoding: 'utf8' }).trim();
            stopped = state === 'not-found';
          } catch { stopped = false; }
        }
      }
      if (control) {
        if (control.exitCode === null && control.signalCode === null) {
          control.kill('SIGKILL'); await new Promise(resolve => control.once('close', resolve));
        }
      }
      if (inbox) await inbox.close();
      if (lifecycle) await lifecycle.close();
      if (stopped) await rm(root, { recursive: true, force: true });
      else console.error(`Retaining ${root}: fixture unit did not stop`);
    }
  });
