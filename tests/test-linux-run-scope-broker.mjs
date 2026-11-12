import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createRunnerLifecycleServer, isLinuxRunScopeRegistrationEligible } from '../scripts/runner-lifecycle-broker.mjs';
import { launchDetachedRunnerViaLifecycleBroker } from '../chat/run-launcher.mjs';
import { revokeLinuxRunScope } from '../chat/linux-run-scope-lifecycle.mjs';

async function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    socket.on('error', reject);
  });
}
test('privileged registration requires different numeric users and no forwarded desktop endpoints', () => {
  const base = { runnerUid: 1001, controlUid: 1000, distinctIdentity: true, guiEnvironment: {} };
  assert.equal(isLinuxRunScopeRegistrationEligible(base), true);
  assert.equal(isLinuxRunScopeRegistrationEligible({ ...base, runnerUid: 1000 }), false);
  assert.equal(isLinuxRunScopeRegistrationEligible({ ...base, controlUid: undefined }), false);
  assert.equal(isLinuxRunScopeRegistrationEligible({ ...base, distinctIdentity: false }), false);
  assert.equal(isLinuxRunScopeRegistrationEligible({ ...base, guiEnvironment: { DISPLAY: ':0' } }), false);
  assert.equal(isLinuxRunScopeRegistrationEligible({ ...base, guiEnvironment: { XDG_RUNTIME_DIR: '/run/user/1000' } }), false);
});
test('broker only accepts its own root-configured store paths', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentoc-scope-broker-'));
  const calls = [], revocations = [], configuration = { directory: '/root/trusted-context', pinDirectory: '/root/trusted-pin' };
  const base = { serviceUser: userInfo().username, serviceGroup: userInfo().username, controlUser: userInfo().username,
    chownImpl: async () => {}, launchRunner: async (runId, options) => { calls.push({ runId, options }); return { pid: 10, privilegedContextRegistered: true }; } };
  const enabled = await createRunnerLifecycleServer({ ...base, socketPath: join(root, 'enabled.sock'), runScopeRegistration: configuration,
    revokeRunContextImpl: async (options) => { revocations.push(options); } });
  const disabled = await createRunnerLifecycleServer({ ...base, socketPath: join(root, 'disabled.sock') });
  try {
    const grant = { version: 1, signature: 'untrusted-wire-data' };
    assert.equal((await request(enabled.socketPath, { type: 'launch', runId: 'run_12345678', launchAttempt: 2,
      scopeGrant: grant, runScopeRegistration: { directory: '/tmp/attacker', pinDirectory: '/tmp/attacker' } })).ok, true);
    assert.deepEqual(calls[0].options.runScopeRegistration, configuration);
    assert.deepEqual(calls[0].options.scopeGrant, grant);
    assert.equal((await request(disabled.socketPath, { type: 'launch', runId: 'run_12345678', scopeGrant: grant })).ok, true);
    assert.equal(Object.hasOwn(calls[1].options, 'scopeGrant'), false);
    assert.deepEqual(await revokeLinuxRunScope({ id: 'run_12345678', runnerLaunchAttempt: 2 },
      { enabled: true, socketPath: enabled.socketPath }), { state: 'revoked' });
    assert.deepEqual(revocations, [{ directory: configuration.directory, runId: 'run_12345678', launchAttempt: 2 }]);
    assert.deepEqual(await revokeLinuxRunScope({ id: 'run_12345678', runnerLaunchAttempt: 2 },
      { enabled: true, socketPath: disabled.socketPath }), { state: 'unavailable' });
    assert.deepEqual(await revokeLinuxRunScope({ id: 'bad', runnerLaunchAttempt: 2 },
      { enabled: true, socketPath: enabled.socketPath }), { state: 'unavailable' });
    const previous = process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS;
    try {
      process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS = '1';
      const result = await launchDetachedRunnerViaLifecycleBroker('run_12345678', { socketPath: enabled.socketPath,
        launchAttempt: 2, issueScopeGrant: async (id, attempt) => { assert.equal(id, 'run_12345678'); assert.equal(attempt, 2); return grant; } });
      assert.equal(result.privilegedContextRegistered, true);
      assert.deepEqual(calls[2].options.scopeGrant, grant);
      const ordinary = await launchDetachedRunnerViaLifecycleBroker('run_12345678', { socketPath: enabled.socketPath,
        issueScopeGrant: async () => { throw new Error('signing unavailable'); } });
      assert.equal(ordinary.pid, 10);
      assert.equal(Object.hasOwn(calls[3].options, 'scopeGrant'), false);
    } finally {
      if (previous === undefined) delete process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS;
      else process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS = previous;
    }
  } finally { await enabled.close(); await disabled.close(); await rm(root, { recursive: true, force: true }); }
});
test('root broker durably creates the revocation marker', { skip: process.platform !== 'linux' || process.geteuid?.() !== 0 }, async () => {
  const root = await mkdtemp('/srv/agentoc-revoke-broker-');
  const directory = `${root}/contexts`;
  await mkdir(directory, { mode: 0o700 });
  const server = await createRunnerLifecycleServer({ socketPath: `${root}/broker.sock`, serviceUser: 'root', serviceGroup: 'root',
    controlUser: 'root', controlGroup: 'root', chownImpl: async () => {},
    runScopeRegistration: { directory, pinDirectory: `${root}/unused` } });
  try {
    const runId = 'run_12345678';
    assert.deepEqual(await revokeLinuxRunScope({ id: runId, runnerLaunchAttempt: 2 }, { enabled: true, socketPath: server.socketPath }), { state: 'revoked' });
    const name = `${createHash('sha256').update(runId).digest('hex')}-2.revoked`;
    const stat = await lstat(`${directory}/${name}`);
    assert.equal(stat.uid, 0);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
