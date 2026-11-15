import { verify } from 'node:crypto';
import { verifyTemporaryAccessCredential } from './temporary-device-access.mjs';
import { checkedTemporaryId, temporaryHash, temporaryPublicKey, temporaryPairingError,
  verifyTemporaryInvitation, verifyTemporaryClaim, temporaryInvitationDigest } from './temporary-pairing-protocol.mjs';

export const TEMPORARY_BROKER_PROOF_WINDOW_MS = 30_000;
export function temporaryCanonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(temporaryCanonicalJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${temporaryCanonicalJson(value[key])}`).join(',')}}`;
  }
  throw temporaryPairingError('temporary_broker_payload_invalid');
}

/** Each HTTP adapter supplies its fixed action; a proof cannot choose a different endpoint. */
export function buildTemporaryBrokerMessage(action, { instanceId, invitationId, requestId, issuedAt, nonce, payload = {} }) {
  if (!['register', 'inbox', 'complete', 'revoke', 'result', 'turn-reserve', 'turn-release',
    'connect', 'connection-publish', 'connection-result'].includes(action)
    || !Number.isSafeInteger(issuedAt) || issuedAt < 0) throw temporaryPairingError('temporary_broker_proof_invalid', 401);
  return JSON.stringify(['ragent-temporary-broker-v1', action, checkedTemporaryId(instanceId, 'inst'),
    checkedTemporaryId(invitationId, 'rti'), checkedTemporaryId(requestId, 'rtr'), issuedAt,
    checkedTemporaryId(nonce, 'rtn'), temporaryHash(temporaryCanonicalJson(payload))]);
}

export function verifyTemporaryBrokerProof(action, input, publicKey, now) {
  const key = temporaryPublicKey(publicKey, !['result', 'connect', 'connection-result'].includes(action));
  const message = buildTemporaryBrokerMessage(action, input);
  if (Math.abs(now - input.issuedAt) >= TEMPORARY_BROKER_PROOF_WINDOW_MS
    || typeof input.signature !== 'string' || !/^[A-Za-z0-9_-]{80,128}$/.test(input.signature)) {
    throw temporaryPairingError('temporary_broker_proof_invalid', 401);
  }
  const signature = Buffer.from(input.signature, 'base64url');
  if (signature.toString('base64url') !== input.signature
    || !verify(key.algorithm === 'ed25519' ? null : 'sha256', Buffer.from(message), key.key, signature)) {
    throw temporaryPairingError('temporary_broker_proof_invalid', 401);
  }
  return { nonceHash: temporaryHash(input.nonce), expiresAt: input.issuedAt + TEMPORARY_BROKER_PROOF_WINDOW_MS };
}

/** A saved completion is a signed receipt, not a new HTTP request. Its signature outlives the 30s request window. */
export function verifyTemporaryCompletion(completion, { envelope, claim, expectedInstance, now }) {
  const i = verifyTemporaryInvitation(envelope, expectedInstance);
  const device = verifyTemporaryClaim(claim);
  const r = completion?.payload?.result;
  if (!completion || !Number.isSafeInteger(now) || now < i.createdAt || now >= i.accessExpiresAt
    || completion.instanceId !== i.instanceId || completion.invitationId !== i.invitationId
    || claim.instanceId !== i.instanceId || claim.invitationId !== i.invitationId
    || claim.invitationDigest !== temporaryInvitationDigest(i)
    || !r || Object.keys(completion.payload).some((k) => !['result', 'accessCredential'].includes(k))
    || Object.keys(r).sort().join(',') !== 'accessExpiresAt,deviceId,deviceKeyFingerprint,grantId,grantedAt,requestId'
    || r.deviceKeyFingerprint !== device.fingerprint || r.requestId !== claim.requestId
    || r.accessExpiresAt !== i.accessExpiresAt || !Number.isSafeInteger(r.grantedAt)
    || r.grantedAt < i.createdAt || r.grantedAt >= i.claimExpiresAt
    || completion.issuedAt < r.grantedAt || completion.issuedAt > now || completion.issuedAt >= i.accessExpiresAt) {
    throw temporaryPairingError('temporary_broker_receipt_invalid', 401);
  }
  checkedTemporaryId(r.grantId, 'rtg'); checkedTemporaryId(r.deviceId, 'rdev');
  verifyTemporaryBrokerProof('complete', completion, envelope.publicKey, completion.issuedAt);
  if (Object.hasOwn(completion.payload, 'accessCredential')) {
    verifyTemporaryAccessCredential(completion.payload.accessCredential, { envelope,
      grant: { ...r, devicePublicKey: claim.devicePublicKey }, expectedInstance, now });
  }
  return structuredClone(r);
}
