import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createRunnerLifecycleServer } from '../scripts/runner-lifecycle-broker.mjs';

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
test('broker only accepts its own root-configured store paths', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentoc-scope-broker-'));
  const calls = [], configuration = { directory: '/root/trusted-context', pinDirectory: '/root/trusted-pin' };
  const base = { serviceUser: userInfo().username, serviceGroup: userInfo().username, controlUser: userInfo().username,
    chownImpl: async () => {}, launchRunner: async (runId, options) => { calls.push({ runId, options }); return { pid: 10 }; } };
  const enabled = await createRunnerLifecycleServer({ ...base, socketPath: join(root, 'enabled.sock'), runScopeRegistration: configuration });
  const disabled = await createRunnerLifecycleServer({ ...base, socketPath: join(root, 'disabled.sock') });
  try {
    const grant = { version: 1, signature: 'untrusted-wire-data' };
    assert.equal((await request(enabled.socketPath, { type: 'launch', runId: 'run_12345678', launchAttempt: 2,
      scopeGrant: grant, runScopeRegistration: { directory: '/tmp/attacker', pinDirectory: '/tmp/attacker' } })).ok, true);
    assert.deepEqual(calls[0].options.runScopeRegistration, configuration);
    assert.deepEqual(calls[0].options.scopeGrant, grant);
    assert.equal((await request(disabled.socketPath, { type: 'launch', runId: 'run_12345678', scopeGrant: grant })).ok, true);
    assert.equal(Object.hasOwn(calls[1].options, 'scopeGrant'), false);
  } finally { await enabled.close(); await disabled.close(); await rm(root, { recursive: true, force: true }); }
});
