import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { LINUX_TARGET_ATTESTATION_TTL_MAX_MS, signLinuxTargetAttestation, verifyLinuxTargetAttestation } from '../chat/linux-target-attestation.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const now = Date.parse('2026-11-12T00:00:00.000Z');
const context = { sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1', requestId: 'request-1' };
const path = '/var/lib/example/file';
const snapshot = {
  version: 1, mountId: '29', parentDevice: '42', parentInode: '9007199254740993',
  device: '42', inode: '9007199254740995', size: '20', ctimeSeconds: '100',
  ctimeNanoseconds: '101', mtimeSeconds: '102', mtimeNanoseconds: '103',
};
const signed = signLinuxTargetAttestation({ privateKey, context, path, snapshot, now });
const options = { publicKey, expectedContext: context, expectedPath: path, now };
assert.equal(verifyLinuxTargetAttestation(signed, options).ok, true);
// An observation is evidence, not a one-shot authorization; replay prevention
// must be enforced by the later signed execution capability and durable ledger.
assert.equal(verifyLinuxTargetAttestation(signed, options).ok, true);
assert.equal(verifyLinuxTargetAttestation(signed, { ...options, publicKey: other.publicKey }).ok, false);
assert.equal(verifyLinuxTargetAttestation(signed, { ...options, now: now - 1 }).ok, false);
assert.equal(verifyLinuxTargetAttestation(signed, { ...options, now: now + LINUX_TARGET_ATTESTATION_TTL_MAX_MS }).ok, false);
assert.equal(verifyLinuxTargetAttestation(signed, { ...options, expectedPath: '/var/lib/example/other' }).ok, false);
for (const key of Object.keys(context)) {
  assert.equal(verifyLinuxTargetAttestation(signed, { ...options, expectedContext: { ...context, [key]: 'different' } }).ok, false, key);
  assert.equal(verifyLinuxTargetAttestation({ ...signed, context: { ...signed.context, [key]: 'different' } }, options).ok, false, key);
}
for (const [key, value] of [
  ['purpose', 'other'], ['keyId', '0'.repeat(64)], ['bindingHash', '0'.repeat(64)],
  ['issuedAt', '2026-11-11T23:59:59.000Z'], ['expiresAt', '2026-11-12T00:04:59.000Z'],
  ['signature', 'A'.repeat(86)], ['extra', true],
]) {
  assert.equal(verifyLinuxTargetAttestation({ ...signed, [key]: value }, options).ok, false, key);
}
assert.equal(verifyLinuxTargetAttestation({ ...signed, binding: { ...signed.binding, inode: '9007199254740996' } }, options).ok, false);
assert.equal(verifyLinuxTargetAttestation({ ...signed, binding: { ...signed.binding, path: '/var/lib/example/other' } }, options).ok, false);
assert.throws(() => signLinuxTargetAttestation({ privateKey, context, path, snapshot, now, ttlMs: LINUX_TARGET_ATTESTATION_TTL_MAX_MS + 1 }), { code: 'LINUX_TARGET_ATTESTATION_INVALID' });
assert.throws(() => signLinuxTargetAttestation({ privateKey, context: { ...context, runId: '' }, path, snapshot, now }), { code: 'LINUX_TARGET_ATTESTATION_INVALID' });
assert.throws(() => signLinuxTargetAttestation({ privateKey: publicKey, context, path, snapshot, now }), { code: 'LINUX_TARGET_ATTESTATION_INVALID' });
const instance = { ...context, launchAttempt: 2, invocationId: 'a'.repeat(32) };
const instanceSigned = signLinuxTargetAttestation({ privateKey, context: instance, path, snapshot, now });
assert.equal(instanceSigned.version, 2);
assert.equal(verifyLinuxTargetAttestation(instanceSigned, { ...options, expectedContext: instance }).ok, true);
assert.equal(verifyLinuxTargetAttestation(instanceSigned, { ...options, expectedContext: { ...instance, launchAttempt: 3 } }).ok, false);
assert.equal(verifyLinuxTargetAttestation(instanceSigned, { ...options, expectedContext: { ...instance, invocationId: 'b'.repeat(32) } }).ok, false);
assert.equal(verifyLinuxTargetAttestation(instanceSigned, options).ok, false);
assert.equal(verifyLinuxTargetAttestation(signed, { ...options, expectedContext: instance }).ok, false);
assert.equal(verifyLinuxTargetAttestation({ ...instanceSigned, version: 1, purpose: 'linux-target-inspect/v1' }, { ...options, expectedContext: instance }).ok, false);
assert.throws(() => signLinuxTargetAttestation({ privateKey, context: { ...instance, invocationId: '0'.repeat(32) }, path, snapshot, now }));
console.log('linux target attestation: signature and binding checks passed');
