// Prototype only: a signed publication is not proof of a live Run or owner
// approval. The verifier must independently pin the service public key and
// keep the verified result in root-controlled state before launching a Run.
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { assertRunPublication } from './run-publication-contract.mjs';
import { computeExecutionScopeDigest } from './execution-scope.mjs';

export const LINUX_RUN_SCOPE_GRANT_MAX_TTL_MS = 15 * 60 * 1000;
const FIELDS = ['version', 'purpose', 'keyId', 'runId', 'sessionId', 'requestId', 'turnId', 'publicationId', 'scopeDigest', 'issuedAt', 'expiresAt', 'signature'];
const PURPOSE = 'linux-run-scope-grant/v1';

function invalid() { throw Object.assign(new Error('Invalid Linux Run scope grant'), { code: 'LINUX_RUN_SCOPE_GRANT_INVALID' }); }
function identity(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 256 ||
      /[\x00-\x1f\x7f]/.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) invalid();
  return value;
}
function keyId(key) {
  if (key?.type !== 'public' || key.asymmetricKeyType !== 'ed25519') invalid();
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}
function subject(run, manifest) {
  if (!assertRunPublication(run, manifest)) invalid();
  const scope = manifest.executionScope;
  const digest = manifest.executionScopeDigest;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
      typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest) ||
      computeExecutionScopeDigest(scope) !== digest) invalid();
  const runId = identity(run.id), sessionId = identity(run.sessionId), requestId = identity(run.requestId);
  const turnId = identity(manifest.options?.approvedActionChannel?.turnId);
  if (scope.sessionId !== sessionId || turnId !== requestId) invalid();
  return { runId, sessionId, requestId, turnId, publicationId: run.runPublication.publicationId, scopeDigest: digest };
}
function payload(value) {
  const result = {};
  for (const field of FIELDS.slice(0, -1)) result[field] = value[field];
  return JSON.stringify(result);
}
export function signLinuxRunScopeGrant({ run, manifest, privateKey, now = Date.now(), ttlMs = LINUX_RUN_SCOPE_GRANT_MAX_TTL_MS } = {}) {
  if (privateKey?.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519' ||
      !Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > LINUX_RUN_SCOPE_GRANT_MAX_TTL_MS) invalid();
  let issuedAt, expiresAt;
  try { issuedAt = new Date(now).toISOString(); expiresAt = new Date(now + ttlMs).toISOString(); } catch { invalid(); }
  const value = { version: 1, purpose: PURPOSE, keyId: keyId(createPublicKey(privateKey)),
    ...subject(run, manifest), issuedAt, expiresAt };
  return { ...value, signature: sign(null, Buffer.from(payload(value)), privateKey).toString('base64url') };
}
export function verifyLinuxRunScopeGrant(grant, { run, manifest, publicKey, now = Date.now() } = {}) {
  try {
    if (!grant || typeof grant !== 'object' || Array.isArray(grant) || Object.keys(grant).length !== FIELDS.length ||
        !FIELDS.every((field) => Object.hasOwn(grant, field)) || grant.version !== 1 || grant.purpose !== PURPOSE ||
        grant.keyId !== keyId(publicKey) || !Number.isSafeInteger(now)) invalid();
    const expected = subject(run, manifest);
    if (Object.keys(expected).some((field) => grant[field] !== expected[field])) invalid();
    const issued = Date.parse(grant.issuedAt), expires = Date.parse(grant.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || new Date(issued).toISOString() !== grant.issuedAt ||
        new Date(expires).toISOString() !== grant.expiresAt || issued > now || expires <= now || expires <= issued ||
        expires - issued > LINUX_RUN_SCOPE_GRANT_MAX_TTL_MS ||
        typeof grant.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(grant.signature)) invalid();
    const signature = Buffer.from(grant.signature, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== grant.signature ||
        !verify(null, Buffer.from(payload(grant)), publicKey, signature)) invalid();
    return { ok: true, subject: expected };
  } catch { return { ok: false, code: 'LINUX_RUN_SCOPE_GRANT_INVALID' }; }
}
