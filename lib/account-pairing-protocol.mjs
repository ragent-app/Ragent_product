import { createHash } from 'node:crypto';
import { temporaryCanonicalJson } from './temporary-pairing-broker-protocol.mjs';

export function accountPairingHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function buildAccountPairingProof(action, { instanceId, invitationId, issuedAt, nonce, payload = {} }) {
  if (!['register', 'inbox', 'approve', 'revoke', 'claim', 'result'].includes(action)
    || ![instanceId, invitationId, nonce].every((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{16,160}$/.test(x))
    || !Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error('Invalid account pairing proof');
  return JSON.stringify(['ragent-account-pairing-v1', action, instanceId, invitationId, issuedAt, nonce,
    accountPairingHash(temporaryCanonicalJson(payload))]);
}
