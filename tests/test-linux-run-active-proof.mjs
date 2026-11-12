import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { signLinuxRunActiveProof, verifyLinuxRunActiveProof } from '../chat/linux-run-active-proof.mjs';
import { issueLinuxRunActiveProof } from '../chat/linux-run-active-service.mjs';

const keys = generateKeyPairSync('ed25519');
const context = { runId: 'run_12345678', sessionId: 's1', turnId: 't1', launchAttempt: 2,
  invocationId: 'a'.repeat(32), challenge: randomBytes(32).toString('base64url') };
test('proof binds a fresh challenge and the exact systemd Run instance', () => {
  const now = Date.now();
  const proof = signLinuxRunActiveProof({ context, privateKey: keys.privateKey, now });
  assert.equal(verifyLinuxRunActiveProof(proof, { expectedContext: context, publicKey: keys.publicKey, now }), true);
  assert.equal(verifyLinuxRunActiveProof(proof, { expectedContext: { ...context, challenge: randomBytes(32).toString('base64url') }, publicKey: keys.publicKey, now }), false);
  assert.equal(verifyLinuxRunActiveProof(proof, { expectedContext: { ...context, invocationId: 'b'.repeat(32) }, publicKey: keys.publicKey, now }), false);
  assert.equal(verifyLinuxRunActiveProof(proof, { expectedContext: context, publicKey: keys.publicKey, now: now + 5000 }), false);
  assert.equal(verifyLinuxRunActiveProof(proof, { expectedContext: context, publicKey: generateKeyPairSync('ed25519').publicKey, now }), false);
});
test('the control service refuses cancellation, old generation and terminal states', async () => {
  const run = { id: context.runId, sessionId: context.sessionId, requestId: context.turnId,
    runnerLaunchMode: 'runner-lifecycle', runnerLaunchAttempt: 2, state: 'running' };
  const manifest = { options: { approvedActionChannel: { turnId: context.turnId } } };
  const options = { enabled: true, platform: 'linux', readBoundary: async () => ({ run, manifest }), getKey: () => keys, isCancelled: async () => false };
  const proof = await issueLinuxRunActiveProof(context, options);
  assert.equal(verifyLinuxRunActiveProof(proof, { expectedContext: context, publicKey: keys.publicKey }), true);
  run.cancelRequested = true;
  await assert.rejects(issueLinuxRunActiveProof(context, options));
  run.cancelRequested = false; run.runnerLaunchAttempt = 3;
  await assert.rejects(issueLinuxRunActiveProof(context, options));
  run.runnerLaunchAttempt = 2; run.state = 'completed';
  await assert.rejects(issueLinuxRunActiveProof(context, options));
});
