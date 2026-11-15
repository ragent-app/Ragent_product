// Broker proofs for the v2 full-control enrollment exchange.  They use a
// separate domain string from temporary sharing so a valid v1 request cannot
// be replayed against this endpoint.
import { verify } from 'node:crypto';
import { temporaryCanonicalJson } from './temporary-pairing-broker-protocol.mjs';
import { checkedTemporaryId, temporaryHash, temporaryPairingError, temporaryPublicKey } from './temporary-pairing-protocol.mjs';

export const TEMPORARY_CONTROL_BROKER_PROOF_WINDOW_MS = 30_000;
const instanceActions = new Set(['register', 'inbox', 'complete', 'revoke', 'turn-reserve', 'connection-publish']);
const deviceActions = new Set(['result', 'connect', 'connection-result']);

// Relay quota namespace only. This creates no Accounts identity, binding,
// login session or durable trusted device.
export function temporaryControlRelayPrincipal(instanceId, fingerprint) {
  checkedTemporaryId(instanceId, 'inst');
  if (!/^[a-f0-9]{64}$/.test(fingerprint || '')) fail();
  return `temporary_${temporaryHash(JSON.stringify([instanceId, fingerprint]))}`;
}

function fail(code = 'temporary_control_broker_proof_invalid', statusCode = 401) {
  throw temporaryPairingError(code, statusCode);
}

export function buildTemporaryControlBrokerMessage(action, { instanceId, invitationId, requestId, issuedAt, nonce, payload = {} }) {
  if (!instanceActions.has(action) && !deviceActions.has(action)) fail();
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) fail();
  return JSON.stringify(['ragent-temporary-control-broker-v1', action,
    checkedTemporaryId(instanceId, 'inst'), checkedTemporaryId(invitationId, 'rti'),
    checkedTemporaryId(requestId, 'rtr'), issuedAt, checkedTemporaryId(nonce, 'rtn'),
    temporaryHash(temporaryCanonicalJson(payload))]);
}

function verifyProof(action, input, publicKey, now, instance) {
  const key = temporaryPublicKey(publicKey, instance);
  const message = buildTemporaryControlBrokerMessage(action, input);
  if (!Number.isSafeInteger(now) || Math.abs(now - input?.issuedAt) >= TEMPORARY_CONTROL_BROKER_PROOF_WINDOW_MS
    || typeof input?.signature !== 'string' || !/^[A-Za-z0-9_-]{80,128}$/.test(input.signature)) fail();
  const signature = Buffer.from(input.signature, 'base64url');
  if (signature.toString('base64url') !== input.signature
    || !verify(key.algorithm === 'ed25519' ? null : 'sha256', Buffer.from(message), key.key, signature)) fail();
  return { nonceHash: temporaryHash(input.nonce), expiresAt: input.issuedAt + TEMPORARY_CONTROL_BROKER_PROOF_WINDOW_MS };
}

export function verifyTemporaryControlBrokerInstanceProof(action, input, publicKey, now) {
  if (!instanceActions.has(action)) fail();
  return verifyProof(action, input, publicKey, now, true);
}

export function verifyTemporaryControlBrokerDeviceProof(action, input, publicKey, now) {
  if (!deviceActions.has(action)) fail();
  return verifyProof(action, input, publicKey, now, false);
}
