import { createHash, createPublicKey, verify } from 'crypto';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createPublicKeyFromRaw(raw) {
  // Try as a PEM string first (existing behaviour).
  try {
    return createPublicKey(raw);
  } catch {
    // Fallback: raw may be base64-encoded SPKI DER.
    try {
      return createPublicKey(Buffer.from(raw, 'base64'));
    } catch {
      return null;
    }
  }
}

export function normalizeDevicePublicKey(value) {
  const raw = trimString(value);
  if (!raw) return null;
  const key = createPublicKeyFromRaw(raw);
  if (!key) return null;
  const keyType = trimString(key.asymmetricKeyType).toLowerCase();
  if (!['ed25519', 'ec'].includes(keyType)) return null;
  if (keyType === 'ec' && trimString(key.asymmetricKeyDetails?.namedCurve) !== 'prime256v1') return null;
  const algorithm = keyType === 'ed25519' ? 'ed25519' : 'p256';
  const publicKey = key.export({ type: 'spki', format: 'pem' }).toString();
  return {
    algorithm,
    keyId: `dkey_${createHash('sha256').update(publicKey).digest('hex').slice(0, 24)}`,
    publicKey,
  };
}

export function createDevicePublicKeyFingerprint(value) {
  const key = createPublicKeyFromRaw(value);
  if (!key) return '';
  try {
    return createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex');
  } catch {
    return '';
  }
}

export function buildDeviceAuthMessage({ instanceId, deviceId, challengeId, nonce, issuedAt, audience = 'ragent-device-access' }) {
  return [
    'ragent-device-auth-v1',
    trimString(instanceId),
    trimString(deviceId),
    trimString(challengeId),
    trimString(nonce),
    trimString(issuedAt),
    trimString(audience) || 'ragent-device-access',
  ].join('\n');
}

export function buildDeviceAuthMessageV3({ instanceId, deviceId, challengeId, nonce, issuedAt, audience = 'ragent-device-access' }) {
  return [
    'ragent-device-auth-v3',
    trimString(instanceId),
    trimString(deviceId),
    trimString(challengeId),
    trimString(nonce),
    trimString(issuedAt),
    trimString(audience) || 'ragent-device-access',
  ].join('\n');
}

export function buildAccountJoinIntentMessage({
  instanceId,
  intentId,
  deviceId,
  devicePublicKeyFingerprint,
  nonce,
  issuedAt,
  audience = 'ragent-account-join',
}) {
  return [
    'ragent-account-join-intent-v1',
    trimString(instanceId),
    trimString(intentId),
    trimString(deviceId),
    trimString(devicePublicKeyFingerprint),
    trimString(nonce),
    trimString(issuedAt),
    trimString(audience) || 'ragent-account-join',
  ].join('\n');
}

// Account-scoped Android sessions deliberately use a separate signing
// protocol from the target-instance rda_ challenge.  The device public key is
// registered only at Accounts and its normalized fingerprint is what enters
// the signed text, so PEM formatting cannot create a second identity.
export function buildDesktopAccountSessionAuthorization({ instanceId, accountId, transactionId, requestId,
  deviceId, publicKeyFingerprint, nonce, issuedAt }) {
  return JSON.stringify(['ragent-desktop-account-session-authorization-v1',
    trimString(instanceId), trimString(accountId), trimString(transactionId), trimString(requestId),
    trimString(deviceId), trimString(publicKeyFingerprint), trimString(nonce), trimString(issuedAt)]);
}

export function buildAccountSessionMessage({
  transactionId,
  requestId,
  deviceId,
  publicKeyFingerprint,
  nonce,
}) {
  return [
    'ragent-owner-auth-account-session-v1',
    trimString(transactionId),
    trimString(requestId),
    trimString(deviceId),
    trimString(publicKeyFingerprint),
    trimString(nonce),
  ].join('\n');
}

export function buildAccountCredentialRefreshMessage({
  credentialId,
  deviceId,
  requestId,
  issuedAt,
  nonce,
}) {
  return [
    'ragent-owner-auth-account-refresh-v1',
    trimString(credentialId),
    trimString(deviceId),
    trimString(requestId),
    trimString(issuedAt),
    trimString(nonce),
  ].join('\n');
}

export function verifyDeviceAuthSignature({ publicKey, algorithm, message, signature }) {
  const normalizedSignature = trimString(signature);
  if (!normalizedSignature) return false;
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(normalizedSignature, 'base64');
  } catch {
    return false;
  }
  if (signatureBytes.length === 0) return false;
  try {
    return verify(
      trimString(algorithm) === 'ed25519' ? null : 'sha256',
      Buffer.from(String(message || ''), 'utf8'),
      createPublicKey(publicKey),
      signatureBytes,
    );
  } catch {
    return false;
  }
}
