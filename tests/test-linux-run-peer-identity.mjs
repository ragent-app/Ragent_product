import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isLinuxRunPeerLive, matchesLinuxRunPeerCgroup } from '../scripts/linux-run-peer-identity.mjs';
import { captureLinuxRunUnitIdentity } from '../scripts/linux-run-unit-liveness.mjs';
import { createRunPublication, bindRunPublication } from '../chat/run-publication-contract.mjs';
import { computeExecutionScopeDigest } from '../chat/execution-scope.mjs';
import { signLinuxRunScopeGrant } from '../chat/linux-run-scope-grant.mjs';
import { enrollLinuxServiceKeyPin } from '../scripts/linux-service-key-pin.mjs';
import { registerLinuxRunContext, revokeLinuxRunContext, withLinuxRunPeerContext } from '../scripts/linux-run-context-store.mjs';
import { stageLinuxRunPeerResult, readRevokedLinuxRunPeerResult } from '../scripts/linux-run-peer-result-store.mjs';
import { createLinuxRunPeerResultServer } from '../scripts/linux-run-peer-result-server.mjs';
import { readProtectedLinuxRunResult } from '../chat/linux-run-peer-result-client.mjs';

const execAsync = promisify(execFile);

const expected = { runId: 'run_peerfixture1', launchAttempt: 2 };
const path = '/agentoc.slice/agentoc-runners.slice/agentoc-runner-run_peerfixture1-a2.service';
test('peer cgroup must match one exact launch unit', () => {
  assert.equal(matchesLinuxRunPeerCgroup(`0::${path}\n`, expected), true);
  assert.equal(matchesLinuxRunPeerCgroup(`0::${path}/child\n`, expected), false);
  assert.equal(matchesLinuxRunPeerCgroup(`0::${path}\n0::${path}\n`, expected), false);
  assert.equal(matchesLinuxRunPeerCgroup(`0::${path}\n`, { ...expected, launchAttempt: 3 }), false);
});

test('SO_PEERCRED distinguishes same-UID clients in separate systemd units',
  { skip: process.platform !== 'linux' || process.geteuid?.() !== 0 || process.env.AGENTOC_TEST_SYSTEMD_PEER !== '1', timeout: 30000 }, async () => {
    const root = await mkdtemp('/srv/agentoc-peer-test-');
    const unit = 'agentoc-runner-run_peerfixture1-a2.service';
    const otherUnit = 'agentoc-runner-run_peerfixture2-a2.service';
    const zombieUnit = 'agentoc-runner-run_peerfixture3-a2.service';
    const sockets = [], started = [];
    let server, inbox;
    const stop = name => {
      try { execFileSync('/usr/bin/systemctl', ['stop', name], { stdio: 'ignore', timeout: 10000 }); return true; }
      catch { return false; }
    };
    try {
      await chmod(root, 0o711);
      for (const name of [unit, otherUnit, zombieUnit]) {
        assert.equal(execFileSync('/usr/bin/systemctl', ['show', '--property=LoadState', '--value', name], { encoding: 'utf8' }).trim(), 'not-found');
      }
      const account = execFileSync('/usr/bin/getent', ['passwd', 'agentoc-runner'], { encoding: 'utf8' }).trim().split(':');
      const uid = Number(account[2]);
      assert.ok(Number.isSafeInteger(uid) && uid > 0);
      const helper = `${root}/peercred`;
      execFileSync('/usr/bin/gcc', ['-Wall', '-Wextra', '-Werror', '-O2', fileURLToPath(new URL('../native/privileged-peercred.c', import.meta.url)), '-o', helper]);
      const pending = [], waiting = [];
      server = createServer(socket => { socket.on('error', () => {}); sockets.push(socket); const ready = waiting.shift(); if (ready) ready(socket); else pending.push(socket); });
      const socketPath = `${root}/control.sock`;
      const inboxPath = `${root}/inbox.sock`;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      await chmod(socketPath, 0o666);
      const nextSocket = () => pending.length ? Promise.resolve(pending.shift()) : new Promise((resolve, reject) => {
        const timer = setTimeout(() => { const index = waiting.indexOf(ready); if (index >= 0) waiting.splice(index, 1); reject(new Error('peer connection timeout')); }, 5000);
        const ready = socket => { clearTimeout(timer); resolve(socket); };
        waiting.push(ready);
      });
      const launch = (name, zombie = false) => {
        const clientCode = 'const m=await import(process.argv[3]);try {let value;if(process.argv[4]==="w") value=await m.stageProtectedLinuxRunResult({socketPath:process.argv[1],peerHelper:process.argv[2],runId:"run_peerfixture1",launchAttempt:2,result:{exitCode:0,message:"fixture"}});else {await m.waitForProtectedLinuxRunReady({socketPath:process.argv[1],peerHelper:process.argv[2],runId:"run_peerfixture1",launchAttempt:2,maxWaitMs:process.argv[4]==="n"?400:3000});value={ready:true};}console.log(JSON.stringify({ok:true,value}));} catch {console.log(JSON.stringify({ok:false}));}';
        const code = zombie
          ? 'import array,os,socket,sys,time\na,b=socket.socketpair()\nif os.fork() == 0:\n s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); b.sendmsg([b"x"],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array("i",[s.fileno()]))]); os._exit(0)\nelse:\n a.recvmsg(1,socket.CMSG_SPACE(4)); time.sleep(120)'
          : 'import os,socket,subprocess,sys\nif os.fork() == 0:\n s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])\n while True:\n  signal=s.recv(1)\n  if signal not in (b"r",b"w",b"n"): break\n  p=subprocess.run(["/usr/bin/node","--input-type=module","-e",sys.argv[5],sys.argv[2],sys.argv[3],sys.argv[4],signal.decode()],capture_output=True,timeout=5); s.sendall(p.stdout or b\'{"ok":false}\\n\')\n os._exit(0)\nelse:\n os.wait()';
        execFileSync('/usr/bin/systemd-run', ['--quiet', '--collect', '--service-type=exec', `--unit=${name}`,
          '--slice=agentoc-runners.slice', '--property=User=agentoc-runner', '--property=NoNewPrivileges=yes',
          '/usr/bin/python3', '-c', code, socketPath, inboxPath, helper,
          new URL('../chat/linux-run-peer-result-client.mjs', import.meta.url).href, clientCode], { timeout: 10000 });
        started.push(name);
      };
      const credentials = async socket => {
        const child = spawn(helper, [], { stdio: ['ignore', 'pipe', 'pipe', socket._handle.fd] });
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += data; });
        child.stderr.on('data', data => { stderr += data; });
        const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        assert.equal(status, 0, stderr);
        return JSON.parse(stdout);
      };
      launch(unit);
      const a = await nextSocket();
      const peerA = await credentials(a);
      const binding = await captureLinuxRunUnitIdentity({ ...expected, runnerUid: uid });
      assert.ok(binding);
      assert.notEqual(peerA.pid, binding.mainPid, 'a child process in the unit can be identified');
      assert.equal(await isLinuxRunPeerLive(binding, peerA), true);
      const directory = `${root}/contexts`, pinDirectory = `${root}/pin`, resultDirectory = `${root}/results`;
      await mkdir(directory, { mode: 0o700 }); await mkdir(pinDirectory, { mode: 0o700 }); await mkdir(resultDirectory, { mode: 0o700 });
      const keys = generateKeyPairSync('ed25519');
      const keyId = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
      await enrollLinuxServiceKeyPin({ directory: pinDirectory, publicKey: keys.publicKey, expectedKeyId: keyId });
      const run = { id: expected.runId, sessionId: 's1', requestId: 't1', runPublication: createRunPublication() };
      const scope = { sessionId: 's1', cwd: { realPath: '/srv/work' }, scopeRoot: { realPath: '/srv/work' },
        riskContext: { platform: 'linux', cwd: '/srv/work', trustedWorkspaceRoot: '/srv/work' } };
      const manifest = bindRunPublication(run, { executionScope: scope, executionScopeDigest: computeExecutionScopeDigest(scope),
        options: { approvedActionChannel: { turnId: 't1', token: 'test-only' } } });
      const grant = signLinuxRunScopeGrant({ run, manifest, launchAttempt: 2, privateKey: keys.privateKey, ttlMs: 60000 });
      const controlAccount = execFileSync('/usr/bin/getent', ['passwd', 'nobody'], { encoding: 'utf8' }).trim().split(':');
      const controlUid = Number(controlAccount[2]), controlGid = Number(controlAccount[3]);
      assert.ok(controlUid > 0 && controlUid !== uid);
      const options = { socketPath: inboxPath, directory, pinDirectory, resultDirectory, controlUid, peerHelper: helper };
      inbox = await createLinuxRunPeerResultServer(options);
      await assert.rejects(createLinuxRunPeerResultServer(options));
      const peerRequest = (socket, action = 'w') => new Promise((resolve, reject) => {
        let response = '';
        const timer = setTimeout(() => { cleanup(); reject(new Error('result response timeout')); }, 5000);
        const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); };
        const onError = error => { cleanup(); reject(error); };
        const onData = data => { response += data.toString('utf8'); if (response.endsWith('\n')) { cleanup(); resolve(JSON.parse(response)); } };
        socket.on('data', onData); socket.on('error', onError); socket.write(action);
      });
      let readyFinished = false;
      const ready = peerRequest(a, 'r').then(value => { readyFinished = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(readyFinished, false, 'task waits until root registers its unit');
      await registerLinuxRunContext({ directory, pinDirectory, run, manifest, grant, launchAttempt: 2, runnerUid: uid });
      assert.deepEqual(await ready, { ok: true, value: { ready: true } });
      const peerContext = { directory, pinDirectory, ...expected, peer: peerA };
      assert.equal(await withLinuxRunPeerContext(peerContext, async ctx => ctx.sessionId), 's1');
      const staged = { ...peerContext, resultDirectory, result: { exitCode: 0, message: 'fixture' } };
      assert.deepEqual(await stageLinuxRunPeerResult(staged), { staged: true, duplicate: false });
      const filename = `${resultDirectory}/${createHash('sha256').update(run.id).digest('hex')}-2.peer-result.json`;
      const staleTemporary = `${filename}.${'a'.repeat(32)}.tmp`;
      await writeFile(staleTemporary, 'partial secret', { mode: 0o600 });
      assert.deepEqual(await stageLinuxRunPeerResult(staged), { staged: true, duplicate: true });
      await assert.rejects(stat(staleTemporary), { code: 'ENOENT' });
      const fileInfo = await stat(filename);
      assert.equal(fileInfo.uid, 0); assert.equal(fileInfo.gid, 0); assert.equal(fileInfo.mode & 0o777, 0o600);
      assert.throws(() => execFileSync('/usr/bin/setpriv', ['--reuid', String(peerA.uid), '--regid', String(peerA.gid),
        '--clear-groups', '/usr/bin/cat', filename], { stdio: 'ignore' }));
      await assert.rejects(stageLinuxRunPeerResult({ ...staged, result: { exitCode: 1 } }), { code: 'LINUX_RUN_RESULT_CONFLICT' });
      await assert.rejects(readRevokedLinuxRunPeerResult(staged), { code: 'ENOENT' });
      launch(otherUnit);
      const b = await nextSocket();
      const peerB = await credentials(b);
      assert.equal(peerB.uid, peerA.uid);
      assert.equal(await isLinuxRunPeerLive(binding, peerB), false);
      await assert.rejects(withLinuxRunPeerContext({ ...peerContext, peer: peerB }, async () => 'unexpected'), { code: 'LINUX_RUN_CONTEXT_UNAVAILABLE' });
      await assert.rejects(stageLinuxRunPeerResult({ ...staged, peer: peerB }), { code: 'LINUX_RUN_CONTEXT_UNAVAILABLE' });
      assert.deepEqual(await peerRequest(a), { ok: true, value: { staged: true, duplicate: true } });
      assert.deepEqual(await peerRequest(b, 'n'), { ok: false });
      assert.deepEqual(await peerRequest(b), { ok: false });
      const requestAs = async (user, group, request) => {
        const code = 'import socket,sys\ns=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.sendall((sys.argv[2]+"\\n").encode()); data=b""\nwhile not data.endswith(b"\\n"):\n part=s.recv(65536)\n if not part: raise RuntimeError("connection closed")\n data+=part\nprint(data.decode(),end="")';
        const { stdout } = await execAsync('/usr/bin/setpriv', ['--reuid', String(user), '--regid', String(group), '--clear-groups',
          '/usr/bin/python3', '-c', code, inboxPath, JSON.stringify(request)], { timeout: 5000 });
        return JSON.parse(stdout);
      };
      const readRequest = { type: 'read', ...expected };
      const discardRequest = { type: 'discard', ...expected };
      assert.deepEqual(await requestAs(controlUid, controlGid, readRequest), { ok: false });
      assert.deepEqual(await requestAs(controlUid, controlGid, discardRequest), { ok: false });
      assert.deepEqual(await requestAs(controlUid, controlGid, { ...readRequest, peer: peerA }), { ok: false });
      assert.equal(await isLinuxRunPeerLive({ ...binding, invocationId: 'b'.repeat(32) }, peerA), false);
      assert.equal(await isLinuxRunPeerLive(binding, { ...peerA, gid: 0 }), false);
      launch(zombieUnit, true);
      const zombieSocket = await nextSocket();
      const zombiePeer = await credentials(zombieSocket);
      for (let i = 0; i < 100; i++) {
        if (/^State:\s*Z/m.test(await readFile(`/proc/${zombiePeer.pid}/status`, 'utf8'))) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.match(await readFile(`/proc/${zombiePeer.pid}/status`, 'utf8'), /^State:\s*Z/m);
      const zombieBinding = await captureLinuxRunUnitIdentity({ runId: 'run_peerfixture3', launchAttempt: 2, runnerUid: uid });
      assert.ok(zombieBinding, 'the unit and the process retaining the fd are still alive');
      assert.equal(await isLinuxRunPeerLive(zombieBinding, zombiePeer), false);
      let releaseAction, signalStarted;
      const admitted = new Promise(resolve => { signalStarted = resolve; });
      const gate = new Promise(resolve => { releaseAction = resolve; });
      const operation = withLinuxRunPeerContext(peerContext, async () => { signalStarted(); await gate; return 'finished'; });
      await admitted;
      let revoked = false;
      const revoke = revokeLinuxRunContext({ directory, ...expected }).then(() => { revoked = true; });
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(revoked, false, 'revocation waits for an admitted operation');
      } finally { releaseAction(); }
      assert.equal(await operation, 'finished');
      await revoke;
      assert.deepEqual(await peerRequest(a, 'n'), { ok: false });
      await assert.rejects(withLinuxRunPeerContext(peerContext, async () => 'unexpected'), { code: 'LINUX_RUN_CONTEXT_UNAVAILABLE' });
      await assert.rejects(stageLinuxRunPeerResult(staged), { code: 'LINUX_RUN_CONTEXT_UNAVAILABLE' });
      const result = await readRevokedLinuxRunPeerResult(staged);
      assert.equal(result.sessionId, 's1');
      assert.equal(result.invocationId, binding.invocationId);
      assert.deepEqual(result.result, staged.result);
      assert.deepEqual(await requestAs(uid, peerA.gid, readRequest), { ok: false });
      assert.deepEqual(await requestAs(controlUid, controlGid, readRequest), { ok: true, value: result });
      const readClient = 'const m=await import(process.argv[3]);const value=await m.readProtectedLinuxRunResult({socketPath:process.argv[1],peerHelper:process.argv[2],runId:"run_peerfixture1",launchAttempt:2});console.log(JSON.stringify(value));';
      const clientResult = await execAsync('/usr/bin/setpriv', ['--reuid', String(controlUid), '--regid', String(controlGid), '--clear-groups',
        '/usr/bin/node', '--input-type=module', '-e', readClient, inboxPath, helper,
        new URL('../chat/linux-run-peer-result-client.mjs', import.meta.url).href], { timeout: 5000 });
      assert.deepEqual(JSON.parse(clientResult.stdout), result);
      const activatedPath = `${root}/activated.sock`;
      const activationCode = 'const {startProtectedResultBroker}=await import(process.argv[1]);const {createLinuxRunPeerResultServer}=await import(process.argv[2]);const server=await startProtectedResultBroker({readUser:async()=>"nobody",createServer:opts=>createLinuxRunPeerResultServer({...opts,socketPath:process.argv[3],resultDirectory:process.argv[4],peerHelper:process.argv[5]})});process.on("SIGTERM",async()=>{await server.close();process.exit(0)});';
      const activation = spawn('/usr/bin/systemd-socket-activate', [`--listen=${activatedPath}`, '--fdname=agentoc-peer-result',
        `--setenv=AGENTOC_LINUX_RUN_CONTEXT_DIR=${directory}`, `--setenv=AGENTOC_LINUX_SERVICE_PIN_DIR=${pinDirectory}`,
        '/usr/bin/node', '--input-type=module', '-e', activationCode,
        new URL('../scripts/linux-run-peer-result-broker.mjs', import.meta.url).href,
        new URL('../scripts/linux-run-peer-result-server.mjs', import.meta.url).href,
        activatedPath, resultDirectory, helper], { stdio: ['ignore', 'ignore', 'pipe'] });
      let activationErrors = '';
      activation.stderr.on('data', chunk => { activationErrors += chunk.toString(); });
      try {
        for (let i = 0; i < 100; i++) {
          try { if ((await stat(activatedPath)).isSocket()) break; } catch {}
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok((await stat(activatedPath)).isSocket(), activationErrors);
        await chmod(activatedPath, 0o666);
        const activated = await execAsync('/usr/bin/setpriv', ['--reuid', String(controlUid), '--regid', String(controlGid), '--clear-groups',
          '/usr/bin/node', '--input-type=module', '-e', readClient, activatedPath, helper,
          new URL('../chat/linux-run-peer-result-client.mjs', import.meta.url).href], { timeout: 5000 });
        assert.deepEqual(JSON.parse(activated.stdout), result);
      } finally {
        activation.kill('SIGTERM');
        if (activation.exitCode === null && activation.signalCode === null) await new Promise(resolve => activation.once('exit', resolve));
      }
      assert.ok((await stat(activatedPath)).isSocket(), 'the activated socket belongs to the socket manager');
      // A root-owned socket pathname alone does not authenticate its listener:
      // bind as root, then drop identity before listening and sending a forged reply.
      const fakePath = `${root}/fake.sock`;
      const fakeCode = 'import os,socket,sys,time\ns=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); os.chmod(sys.argv[1],0o666); os.setgroups([]); os.setgid(int(sys.argv[3])); os.setuid(int(sys.argv[2])); s.listen(); print("ready",flush=True); c,_=s.accept(); c.sendall(b\'{"ok":true,"value":null}\\n\'); time.sleep(3)';
      const fake = spawn('/usr/bin/python3', ['-c', fakeCode, fakePath, String(controlUid), String(controlGid)], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        await new Promise((resolve, reject) => { fake.stdout.once('data', resolve); fake.once('error', reject); fake.once('exit', () => reject(new Error('fake server exited'))); });
        await assert.rejects(readProtectedLinuxRunResult({ ...expected, socketPath: fakePath, peerHelper: helper }),
          { code: 'LINUX_RUN_RESULT_CHANNEL_UNAVAILABLE' });
      } finally {
        fake.kill('SIGKILL');
        if (fake.exitCode === null && fake.signalCode === null) await new Promise(resolve => fake.once('exit', resolve));
      }
      assert.deepEqual(await requestAs(uid, peerA.gid, discardRequest), { ok: false });
      const discardClient = 'const m=await import(process.argv[3]);const value=await m.discardProtectedLinuxRunResult({socketPath:process.argv[1],peerHelper:process.argv[2],runId:"run_peerfixture1",launchAttempt:2});console.log(JSON.stringify(value));';
      const discarded = await execAsync('/usr/bin/setpriv', ['--reuid', String(controlUid), '--regid', String(controlGid), '--clear-groups',
        '/usr/bin/node', '--input-type=module', '-e', discardClient, inboxPath, helper,
        new URL('../chat/linux-run-peer-result-client.mjs', import.meta.url).href], { timeout: 5000 });
      assert.deepEqual(JSON.parse(discarded.stdout), { discarded: true });
      await assert.rejects(stat(filename), { code: 'ENOENT' });
      assert.deepEqual(await requestAs(controlUid, controlGid, readRequest), { ok: true, value: null });
      // Simulate old result data left behind after the durable tombstone was
      // committed. A read must not resurrect it; retry must remove it.
      await writeFile(filename, `${JSON.stringify(result)}\n`, { mode: 0o600 });
      assert.deepEqual(await requestAs(controlUid, controlGid, readRequest), { ok: true, value: null });
      assert.deepEqual(await requestAs(controlUid, controlGid, discardRequest), { ok: true, value: { discarded: true } });
      await assert.rejects(stat(filename), { code: 'ENOENT' });
      assert.equal(stop(unit), true);
      started.splice(started.indexOf(unit), 1);
      assert.equal(await isLinuxRunPeerLive(binding, peerA), false);
    } finally {
      let stopped = true;
      for (const name of started.reverse()) if (!stop(name)) stopped = false;
      if (inbox) await inbox.close();
      for (const socket of sockets) socket.destroy();
      if (server) await new Promise(resolve => server.close(resolve));
      if (stopped) await rm(root, { recursive: true, force: true });
      else console.error(`Retaining ${root}: a fixture unit did not stop`);
    }
  });
