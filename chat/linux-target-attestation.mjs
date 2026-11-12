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
const CONTEXT_FIELDS = Object.freeze(['sessionId', 'runId', 'turnId', 'requestId']);
const INSTANCE_CONTEXT_FIELDS = Object.freeze([...CONTEXT_FIELDS, 'launchAttempt', 'invocationId']);
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

export function canonicalLinuxTargetContext(context) {
  const hasInstance = exactKeys(context, INSTANCE_CONTEXT_FIELDS);
  if (!hasInstance && !exactKeys(context, CONTEXT_FIELDS)) invalid('invalid target observation context');
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
  if (hasInstance) {
    if (!Number.isSafeInteger(context.launchAttempt) || context.launchAttempt < 0 || context.launchAttempt > 10000 ||
        typeof context.invocationId !== 'string' || !/^[a-f0-9]{32}$/.test(context.invocationId) || /^0+$/.test(context.invocationId)) {
      invalid('invalid target observation run instance');
    }
    result.launchAttempt = context.launchAttempt;
    result.invocationId = context.invocationId;
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
  const normalizedContext = canonicalLinuxTargetContext(context);
  const version = Object.hasOwn(normalizedContext, 'invocationId') ? 2 : 1;
  const value = {
    version, purpose: `linux-target-inspect/v${version}`, keyId: publicKeyId(createPublicKey(privateKey)),
    context: normalizedContext, binding,
    bindingHash: hashLinuxTargetBinding(path, snapshot), issuedAt, expiresAt,
  };
  return { ...value, signature: sign(null, Buffer.from(canonicalPayload(value)), privateKey).toString('base64url') };
}

export function verifyLinuxTargetAttestation(attestation, { publicKey, expectedContext, expectedPath, now = Date.now() } = {}) {
  try {
    if (!exactKeys(attestation, ATTESTATION_FIELDS) || ![1, 2].includes(attestation.version) ||
        attestation.purpose !== `linux-target-inspect/v${attestation.version}` ||
        !Number.isSafeInteger(now) || attestation.keyId !== publicKeyId(publicKey)) invalid('invalid target observation');
    const context = canonicalLinuxTargetContext(attestation.context);
    const expected = canonicalLinuxTargetContext(expectedContext);
    if ((attestation.version === 2) !== Object.hasOwn(context, 'invocationId') ||
        Object.keys(context).length !== Object.keys(expected).length ||
        Object.keys(context).some((field) => context[field] !== expected[field])) invalid('target observation context mismatch');
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
