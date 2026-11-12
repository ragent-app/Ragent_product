// Short-lived signed response to a root-generated challenge. This proves only
// the control plane's observation of a Run; it is not owner authorization.
import { sign, verify } from 'node:crypto';

export const LINUX_RUN_ACTIVE_PROOF_TTL_MS = 5000;
export const LINUX_RUN_ACTIVE_CHECK_PATH = '/api/internal/linux-run-active-check';
const CONTEXT = ['runId', 'sessionId', 'turnId', 'launchAttempt', 'invocationId', 'challenge'];
const FIELDS = ['version', 'purpose', ...CONTEXT, 'issuedAt', 'expiresAt', 'signature'];
function fail() { throw new Error('Invalid Linux Run active proof'); }
function canonicalContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== CONTEXT.length ||
      !CONTEXT.every((field) => Object.hasOwn(value, field)) || !/^run_[A-Za-z0-9_-]{8,128}$/.test(value.runId || '') ||
      !Number.isSafeInteger(value.launchAttempt) || value.launchAttempt < 0 || value.launchAttempt > 10000 ||
      !/^[a-f0-9]{32}$/.test(value.invocationId || '') || /^0+$/.test(value.invocationId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.challenge || '')) fail();
  const challenge = Buffer.from(value.challenge, 'base64url');
  if (challenge.length !== 32 || challenge.toString('base64url') !== value.challenge) fail();
  for (const field of ['sessionId', 'turnId']) {
    if (typeof value[field] !== 'string' || !value[field] || value[field] !== value[field].trim() || value[field].length > 256 ||
        /[\x00-\x1f\x7f]/.test(value[field]) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value[field])) fail();
  }
  return Object.fromEntries(CONTEXT.map((field) => [field, value[field]]));
}
function payload(value) { return JSON.stringify(Object.fromEntries(FIELDS.slice(0, -1).map((field) => [field, value[field]]))); }
export function signLinuxRunActiveProof({ context, privateKey, now = Date.now() } = {}) {
  if (privateKey?.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519' || !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(now + LINUX_RUN_ACTIVE_PROOF_TTL_MS)) fail();
  const proof = { version: 1, purpose: 'linux-run-active/v1', ...canonicalContext(context), issuedAt: now, expiresAt: now + LINUX_RUN_ACTIVE_PROOF_TTL_MS };
  return { ...proof, signature: sign(null, Buffer.from(payload(proof)), privateKey).toString('base64url') };
}
export function verifyLinuxRunActiveProof(proof, { expectedContext, publicKey, now = Date.now() } = {}) {
  try {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || Object.keys(proof).length !== FIELDS.length ||
        !FIELDS.every((field) => Object.hasOwn(proof, field)) || proof.version !== 1 || proof.purpose !== 'linux-run-active/v1' ||
        publicKey?.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519' || !Number.isSafeInteger(now)) fail();
    const context = canonicalContext(Object.fromEntries(CONTEXT.map((field) => [field, proof[field]])));
    const expected = canonicalContext(expectedContext);
    if (CONTEXT.some((field) => context[field] !== expected[field]) || !Number.isSafeInteger(proof.issuedAt) ||
        !Number.isSafeInteger(proof.expiresAt) || proof.issuedAt > now || proof.expiresAt <= now ||
        proof.expiresAt - proof.issuedAt !== LINUX_RUN_ACTIVE_PROOF_TTL_MS ||
        typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) fail();
    const signature = Buffer.from(proof.signature, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== proof.signature ||
        !verify(null, Buffer.from(payload(proof)), publicKey, signature)) fail();
    return true;
  } catch { return false; }
}
