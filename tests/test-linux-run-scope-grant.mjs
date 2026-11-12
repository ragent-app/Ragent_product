import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createRunPublication, bindRunPublication } from '../chat/run-publication-contract.mjs';
import { computeExecutionScopeDigest } from '../chat/execution-scope.mjs';
import { signLinuxRunScopeGrant, verifyLinuxRunScopeGrant } from '../chat/linux-run-scope-grant.mjs';

function fixture() {
  const run = { id: 'run_example', sessionId: 'session_example', requestId: 'turn_example', runPublication: createRunPublication() };
  const executionScope = { schemaVersion: 1, sessionId: run.sessionId, accessMode: 'write', cwd: { realPath: '/srv/work' }, riskContext: { protectedRoots: ['/etc'] } };
  const manifest = bindRunPublication(run, { executionScope, executionScopeDigest: computeExecutionScopeDigest(executionScope), options: { approvedActionChannel: { turnId: run.requestId } } });
  const keys = generateKeyPairSync('ed25519');
  const now = 1700000000000;
  const grant = signLinuxRunScopeGrant({ run, manifest, privateKey: keys.privateKey, now });
  return { run, manifest, keys, now, grant };
}
test('signed Run scope binds publication, session, turn, and full scope digest', () => {
  const { run, manifest, keys, now, grant } = fixture();
  const check = (g = grant, r = run, m = manifest, key = keys.publicKey, time = now) => verifyLinuxRunScopeGrant(g, { run: r, manifest: m, publicKey: key, now: time }).ok;
  assert.equal(check(), true);
  assert.equal(check({ ...grant, runId: 'run_other' }), false);
  assert.equal(check({ ...grant, extra: true }), false);
  assert.equal(check(grant, run, manifest, generateKeyPairSync('ed25519').publicKey), false);
  assert.equal(check(grant, run, manifest, keys.publicKey, now - 1), false);
  assert.equal(check(grant, run, manifest, keys.publicKey, now + 15 * 60 * 1000), false);
  const altered = structuredClone(manifest);
  altered.executionScope.cwd.realPath = '/etc';
  altered.executionScopeDigest = computeExecutionScopeDigest(altered.executionScope);
  assert.equal(check(grant, run, altered), false);
  altered.executionScopeDigest = manifest.executionScopeDigest;
  assert.equal(check(grant, run, altered), false);
  const otherRun = { ...run, runPublication: createRunPublication() };
  const otherManifest = { ...manifest, runPublication: otherRun.runPublication };
  assert.equal(check(grant, otherRun, otherManifest), false);
  assert.equal(check(grant, run, { ...manifest, options: { approvedActionChannel: { turnId: 'other' } } }), false);
});
test('legacy and inconsistent publications cannot be signed', () => {
  const { run, manifest, keys, now } = fixture();
  assert.throws(() => signLinuxRunScopeGrant({ run: { ...run, runPublication: undefined }, manifest, privateKey: keys.privateKey, now }));
  assert.throws(() => signLinuxRunScopeGrant({ run, manifest: { ...manifest, executionScopeDigest: 'sha256:' + '0'.repeat(64) }, privateKey: keys.privateKey, now }));
  assert.throws(() => signLinuxRunScopeGrant({ run, manifest, privateKey: keys.privateKey, now, ttlMs: 900001 }));
});
