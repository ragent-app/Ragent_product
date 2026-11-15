// Signed, one-use enrollment contract for a short-lived full workbench control
// grant.  It is intentionally separate from temporary-pairing-protocol.mjs:
// a v1 sharing QR can never be interpreted as a control QR.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { TEMPORARY_CONTROL_CAPABILITIES, TEMPORARY_CONTROL_SESSION_SCOPE,
  isTemporaryControlCapabilitySet } from './temporary-control-policy.mjs';

export const TEMPORARY_CONTROL_INVITATION_VERSION = 1;
export const TEMPORARY_CONTROL_CLAIM_MAX_MS = 2 * 60 * 1000;
export const TEMPORARY_CONTROL_ACCESS_MS = 10 * 60 * 1000;

const fail = (code = 'temporary_control_invalid_invitation', statusCode = 400) => {
  throw Object.assign(new Error(code), { code, statusCode });
};
const id = (value, prefix) => {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9_-]{24,64}$`).test(value)) fail('temporary_control_invalid_id');
  return value;
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const hashField = (value) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('temporary_control_invalid_hash');
  return value;
};
const milliseconds = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) fail('temporary_control_invalid_time');
  return value;
};

function controlPublicKey(value, instance = false) {
  if (typeof value !== 'string' || value.length > 4096) fail('temporary_control_invalid_key');
  try {
    let encoded = value;
    if (value.startsWith('-----BEGIN PUBLIC KEY-----')) {
      if (!value.trimEnd().endsWith('-----END PUBLIC KEY-----')) throw new Error('PEM framing');
      encoded = value.slice('-----BEGIN PUBLIC KEY-----'.length).trimEnd()
        .slice(0, -'-----END PUBLIC KEY-----'.length).replace(/\s/g, '');
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('base64');
    const der = Buffer.from(encoded, 'base64');
    if (der.toString('base64') !== encoded) throw new Error('noncanonical base64');
    const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
    if (!key.export({ type: 'spki', format: 'der' }).equals(der)) throw new Error('noncanonical SPKI');
    if (instance && key.asymmetricKeyType !== 'ed25519') throw new Error('instance key type');
    if (!instance && key.asymmetricKeyType !== 'ec' && key.asymmetricKeyType !== 'ed25519') throw new Error('device key type');
    if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('device curve');
    return { key, algorithm: key.asymmetricKeyType,
      publicKey: key.export({ type: 'spki', format: 'pem' }).toString(),
      fingerprint: hash(key.export({ type: 'spki', format: 'der' })) };
  } catch { fail('temporary_control_invalid_key'); }
}

export function normalizeTemporaryControlInvitation(value) {
  const keys = ['version', 'invitationId', 'instanceId', 'instanceKeyFingerprint', 'secretHash',
    'createdAt', 'claimExpiresAt', 'accessDurationMs', 'capabilities', 'sessionScope'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))
    || value.version !== TEMPORARY_CONTROL_INVITATION_VERSION
    || value.sessionScope !== TEMPORARY_CONTROL_SESSION_SCOPE) fail();
  const createdAt = milliseconds(value.createdAt);
  const claimExpiresAt = milliseconds(value.claimExpiresAt);
  if (claimExpiresAt <= createdAt || claimExpiresAt - createdAt > TEMPORARY_CONTROL_CLAIM_MAX_MS) fail('temporary_control_invalid_deadline');
  if (value.accessDurationMs !== TEMPORARY_CONTROL_ACCESS_MS || !isTemporaryControlCapabilitySet(value.capabilities)) {
    fail('temporary_control_invalid_capabilities');
  }
  return Object.freeze({ version: TEMPORARY_CONTROL_INVITATION_VERSION,
    invitationId: id(value.invitationId, 'rti'), instanceId: id(value.instanceId, 'inst'),
    instanceKeyFingerprint: hashField(value.instanceKeyFingerprint), secretHash: hashField(value.secretHash),
    createdAt, claimExpiresAt, accessDurationMs: TEMPORARY_CONTROL_ACCESS_MS,
    capabilities: [...TEMPORARY_CONTROL_CAPABILITIES], sessionScope: TEMPORARY_CONTROL_SESSION_SCOPE });
}

export function buildTemporaryControlInvitationMessage(value) {
  const i = normalizeTemporaryControlInvitation(value);
  return JSON.stringify(['ragent-temporary-control-invitation-v1', i.invitationId, i.instanceId,
    i.instanceKeyFingerprint, i.secretHash, i.createdAt, i.claimExpiresAt, i.accessDurationMs,
    i.capabilities, i.sessionScope]);
}

export function temporaryControlInvitationDigest(value) {
  return hash(buildTemporaryControlInvitationMessage(value));
}

function signature(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{80,128}$/.test(value)) fail('temporary_control_invalid_signature', 401);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail('temporary_control_invalid_signature', 401);
  return bytes;
}

export function verifyTemporaryControlInvitation(envelope, expected) {
  const invitation = normalizeTemporaryControlInvitation(envelope?.invitation);
  const identity = controlPublicKey(envelope?.publicKey, true);
  if (!expected || invitation.instanceId !== expected.instanceId
    || invitation.instanceKeyFingerprint !== expected.keyFingerprint
    || identity.fingerprint !== expected.keyFingerprint
    || !verify(null, Buffer.from(buildTemporaryControlInvitationMessage(invitation)), identity.key,
      signature(envelope?.signature))) fail('temporary_control_identity_mismatch', 401);
  return invitation;
}

export function buildTemporaryControlClaimMessage({ instanceId, invitationId, invitationDigest, requestId, devicePublicKey }) {
  return JSON.stringify(['ragent-temporary-control-claim-v1', id(instanceId, 'inst'), id(invitationId, 'rti'),
    hashField(invitationDigest), id(requestId, 'rtr'), controlPublicKey(devicePublicKey).fingerprint]);
}

export function verifyTemporaryControlClaim(claim) {
  const device = controlPublicKey(claim?.devicePublicKey);
  if (!verify(device.algorithm === 'ed25519' ? null : 'sha256',
    Buffer.from(buildTemporaryControlClaimMessage(claim)), device.key, signature(claim?.signature))) {
    fail('temporary_control_proof_invalid', 401);
  }
  return device;
}
