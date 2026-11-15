// Separate from account-claim v3 and provisional Google handoff credentials.
// No runtime paths or broker dependency: Android and Accounts share this wire contract.
import { createHash, createPublicKey, verify } from 'node:crypto';

export const TEMPORARY_PAIRING_VERSION = 1;
export const TEMPORARY_ACCESS_MAX_MS = 10 * 60 * 1000;
export const TEMPORARY_CLAIM_MAX_MS = 2 * 60 * 1000;
export const TEMPORARY_PAIRING_CAPABILITIES = Object.freeze([
  'task.create', 'task.submit', 'task.read', 'task.cancel', 'file.upload', 'file.download',
]);

export function temporaryPairingError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

export function checkedTemporaryId(value, prefix) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9_-]{24,64}$`).test(value)) {
    throw temporaryPairingError('temporary_pairing_invalid_id');
  }
  return value;
}

export function temporaryHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashField(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw temporaryPairingError('temporary_pairing_invalid_hash');
  }
  return value;
}

export function temporaryPublicKey(value, instance = false) {
  if (typeof value !== 'string' || value.length > 4096) {
    throw temporaryPairingError('temporary_pairing_invalid_key');
  }
  try {
    // Android Keystore exports base64 SPKI; PC identity uses PEM.
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
    const algorithm = key.asymmetricKeyType;
    if (algorithm !== 'ed25519' && (instance || algorithm !== 'ec'
      || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')) throw new Error('key type');
    return {
      key, algorithm,
      publicKey: key.export({ type: 'spki', format: 'pem' }).toString(),
      fingerprint: temporaryHash(key.export({ type: 'spki', format: 'der' })),
    };
  } catch {
    throw temporaryPairingError('temporary_pairing_invalid_key');
  }
}

function milliseconds(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw temporaryPairingError('temporary_pairing_invalid_time');
  return value;
}

/** Strict projection prevents unknown permission fields from entering a signed v1 invitation. */
export function normalizeTemporaryInvitation(value) {
  const keys = ['version', 'invitationId', 'instanceId', 'instanceKeyFingerprint', 'secretHash',
    'createdAt', 'claimExpiresAt', 'accessExpiresAt', 'capabilities', 'sessionScope'];
  if (!value || typeof value !== 'object' || Object.keys(value).some((key) => !keys.includes(key))
    || value.version !== TEMPORARY_PAIRING_VERSION || value.sessionScope !== 'created-sessions') {
    throw temporaryPairingError('temporary_pairing_invalid_invitation');
  }
  const createdAt = milliseconds(value.createdAt);
  const claimExpiresAt = milliseconds(value.claimExpiresAt);
  const accessExpiresAt = milliseconds(value.accessExpiresAt);
  if (claimExpiresAt <= createdAt || claimExpiresAt - createdAt > TEMPORARY_CLAIM_MAX_MS
    || accessExpiresAt < claimExpiresAt || accessExpiresAt - createdAt > TEMPORARY_ACCESS_MAX_MS) {
    throw temporaryPairingError('temporary_pairing_invalid_deadline');
  }
  const capabilities = value.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.length
    || capabilities.length > TEMPORARY_PAIRING_CAPABILITIES.length
    || new Set(capabilities).size !== capabilities.length
    || capabilities.some((capability) => !TEMPORARY_PAIRING_CAPABILITIES.includes(capability))) {
    throw temporaryPairingError('temporary_pairing_invalid_capabilities');
  }
  return {
    version: TEMPORARY_PAIRING_VERSION,
    invitationId: checkedTemporaryId(value.invitationId, 'rti'),
    instanceId: checkedTemporaryId(value.instanceId, 'inst'),
    instanceKeyFingerprint: hashField(value.instanceKeyFingerprint),
    secretHash: hashField(value.secretHash), createdAt, claimExpiresAt, accessExpiresAt,
    capabilities: [...capabilities].sort(), sessionScope: 'created-sessions',
  };
}

// A fixed JSON array has unambiguous UTF-8 bytes independent of object key order.
export function buildTemporaryInvitationMessage(value) {
  const i = normalizeTemporaryInvitation(value);
  return JSON.stringify(['ragent-temporary-invitation-v1', i.invitationId, i.instanceId,
    i.instanceKeyFingerprint, i.secretHash, i.createdAt, i.claimExpiresAt, i.accessExpiresAt,
    i.capabilities, i.sessionScope]);
}

export function temporaryInvitationDigest(value) {
  return temporaryHash(buildTemporaryInvitationMessage(value));
}

function signatureBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{80,128}$/.test(value)) {
    throw temporaryPairingError('temporary_pairing_invalid_signature', 401);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw temporaryPairingError('temporary_pairing_invalid_signature', 401);
  return bytes;
}

/** Expected identity comes from the scanned ticket/pinned computer, never broker substitution. */
export function verifyTemporaryInvitation(envelope, expected) {
  const invitation = normalizeTemporaryInvitation(envelope?.invitation);
  const identity = temporaryPublicKey(envelope?.publicKey, true);
  if (!expected || invitation.instanceId !== expected.instanceId
    || identity.fingerprint !== expected.keyFingerprint
    || invitation.instanceKeyFingerprint !== identity.fingerprint
    || !verify(null, Buffer.from(buildTemporaryInvitationMessage(invitation)), identity.key,
      signatureBytes(envelope?.signature))) {
    throw temporaryPairingError('temporary_pairing_identity_mismatch', 401);
  }
  return invitation;
}

export function buildTemporaryClaimMessage({ instanceId, invitationId, invitationDigest, requestId, devicePublicKey }) {
  return JSON.stringify(['ragent-temporary-claim-v1', checkedTemporaryId(instanceId, 'inst'),
    checkedTemporaryId(invitationId, 'rti'), hashField(invitationDigest),
    checkedTemporaryId(requestId, 'rtr'), temporaryPublicKey(devicePublicKey).fingerprint]);
}

export function verifyTemporaryClaim(claim) {
  const device = temporaryPublicKey(claim?.devicePublicKey);
  if (!verify(device.algorithm === 'ed25519' ? null : 'sha256',
    Buffer.from(buildTemporaryClaimMessage(claim)), device.key, signatureBytes(claim?.signature))) {
    throw temporaryPairingError('temporary_pairing_proof_invalid', 401);
  }
  return device;
}
