/**
 * Signed, short-lived Linux target observation. The signing key must be held
 * by a separately protected privileged executor; this module does not create,
 * store, discover, or trust a key. A verified observation is not authority to
 * delete: owner approval, policy, replay protection and revalidation remain
 * mandatory and are not implemented by this module.
 */
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { createLinuxTargetBinding, hashLinuxTargetBinding } from './linux-target-binding.mjs';

export const LINUX_TARGET_ATTESTATION_TTL_MAX_MS = 5 * 60 * 1000;
const PURPOSE = 'linux-target-inspect/v1';
const CONTEXT_FIELDS = Object.freeze(['sessionId', 'runId', 'turnId', 'requestId']);
const ATTESTATION_FIELDS = Object.freeze(['version', 'purpose', 'keyId', 'context', 'binding', 'bindingHash', 'issuedAt', 'expiresAt', 'signature']);

function invalid(message) {
  const error = new Error(message);
  error.code = 'LINUX_TARGET_ATTESTATION_INVALID';
  throw error;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalContext(context) {
  if (!exactKeys(context, CONTEXT_FIELDS)) invalid('invalid target observation context');
  const result = {};
  for (const field of CONTEXT_FIELDS) {
    const value = context[field];
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 256 ||
        /[\x00-\x1f\x7f]/.test(value) ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
      invalid('invalid target observation context');
    }
    result[field] = value;
  }
  return result;
}

function canonicalBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || !Object.hasOwn(binding, 'path')) invalid('invalid target binding');
  const { path, ...snapshot } = binding;
  return createLinuxTargetBinding(path, snapshot);
}

function publicKeyId(publicKey) {
  if (!publicKey || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') invalid('an Ed25519 public key is required');
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

function canonicalPayload(value) {
  return JSON.stringify({
    version: value.version, purpose: value.purpose, keyId: value.keyId,
    context: value.context, binding: value.binding, bindingHash: value.bindingHash,
    issuedAt: value.issuedAt, expiresAt: value.expiresAt,
  });
}

export function signLinuxTargetAttestation({ privateKey, context, path, snapshot, now = Date.now(), ttlMs = LINUX_TARGET_ATTESTATION_TTL_MAX_MS } = {}) {
  if (!privateKey || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') invalid('an Ed25519 private key is required');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > LINUX_TARGET_ATTESTATION_TTL_MAX_MS) invalid('invalid observation lifetime');
  let issuedAt, expiresAt;
  try { issuedAt = new Date(now).toISOString(); expiresAt = new Date(now + ttlMs).toISOString(); }
  catch { invalid('invalid observation lifetime'); }
  const binding = createLinuxTargetBinding(path, snapshot);
  const value = {
    version: 1, purpose: PURPOSE, keyId: publicKeyId(createPublicKey(privateKey)),
    context: canonicalContext(context), binding,
    bindingHash: hashLinuxTargetBinding(path, snapshot), issuedAt, expiresAt,
  };
  return { ...value, signature: sign(null, Buffer.from(canonicalPayload(value)), privateKey).toString('base64url') };
}

export function verifyLinuxTargetAttestation(attestation, { publicKey, expectedContext, expectedPath, now = Date.now() } = {}) {
  try {
    if (!exactKeys(attestation, ATTESTATION_FIELDS) || attestation.version !== 1 || attestation.purpose !== PURPOSE ||
        !Number.isSafeInteger(now) || attestation.keyId !== publicKeyId(publicKey)) invalid('invalid target observation');
    const context = canonicalContext(attestation.context);
    const expected = canonicalContext(expectedContext);
    if (CONTEXT_FIELDS.some((field) => context[field] !== expected[field])) invalid('target observation context mismatch');
    const binding = canonicalBinding(attestation.binding);
    if (binding.path !== expectedPath) invalid('target observation path mismatch');
    const { path, ...snapshot } = binding;
    if (hashLinuxTargetBinding(path, snapshot) !== attestation.bindingHash) invalid('target observation identity mismatch');
    const issued = Date.parse(attestation.issuedAt), expires = Date.parse(attestation.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || new Date(issued).toISOString() !== attestation.issuedAt ||
        new Date(expires).toISOString() !== attestation.expiresAt || issued > now || expires <= now ||
        expires <= issued || expires - issued > LINUX_TARGET_ATTESTATION_TTL_MAX_MS) invalid('target observation expired or invalid');
    if (typeof attestation.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(attestation.signature)) invalid('invalid target observation signature');
    const signature = Buffer.from(attestation.signature, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== attestation.signature ||
        !verify(null, Buffer.from(canonicalPayload({ ...attestation, context, binding })), publicKey, signature)) invalid('invalid target observation signature');
    return { ok: true, binding };
  } catch {
    return { ok: false, code: 'LINUX_TARGET_ATTESTATION_INVALID' };
  }
}
