// Temporary enrollment has its own signed contract; account bootstrap v2 stays unchanged.
import { sign, verify } from 'node:crypto';
import { temporaryCanonicalJson } from './temporary-pairing-broker-protocol.mjs';
import { temporaryHash, temporaryPairingError, temporaryPublicKey } from './temporary-pairing-protocol.mjs';
import { verifyTemporaryAccessCredential } from './temporary-device-access.mjs';
import { createP2PRoomId } from './p2p-signal-protocol.mjs';
import { publicTurnAuthorization } from './turn-authorization.mjs';

export const TEMPORARY_BOOTSTRAP_VERSION = 3;
export const TEMPORARY_BOOTSTRAP_DOMAIN = 'ragent-temporary-connection-bootstrap-v3';
const fail = () => { throw temporaryPairingError('temporary_connection_contract_invalid', 401); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const same = (a, b) => temporaryCanonicalJson(a) === temporaryCanonicalJson(b);
const iso = (value) => {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) fail();
  return parsed;
};
export function temporarySignalingEndpoint(value) {
  try {
    const u = new URL(value);
    if (!['https:', 'wss:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) fail();
    return u.toString();
  } catch { fail(); }
}
export function temporaryContractSigningPayload(contract) {
  const { signature, ...body } = contract;
  return `${TEMPORARY_BOOTSTRAP_DOMAIN}\n${temporaryHash(temporaryCanonicalJson(body))}`;
}

function unsigned({ envelope, grant, credential, expectedInstance, turn, authorization, p2p, issuedAtMs }) {
  const claims = verifyTemporaryAccessCredential(credential, { envelope, grant, expectedInstance, now: issuedAtMs });
  const accessExpiresAt = credential.expires_at;
  if (!turn || turn.provider !== 'cloudflare-realtime' || turn.transport !== 'turn' || turn.appTrafficOnly !== true
    || turn.credentialScope !== 'temporary-device-access' || turn.temporaryGrantId !== grant.grantId
    || turn.temporaryInvitationId !== envelope.invitation.invitationId
    || iso(turn.accessExpiresAt) !== accessExpiresAt || iso(turn.expiresAt) > accessExpiresAt
    || iso(turn.expiresAt) <= issuedAtMs || !/^[A-Za-z0-9_-]{10,160}$/.test(turn.connectionId || '')
    || !Array.isArray(turn.iceServers) || turn.iceServers.length < 1 || turn.iceServers.length > 8) fail();
  const iceServers = turn.iceServers.map((s) => {
    if (!exact(s, ['urls', 'username', 'password'])
      || !/^turns?:[A-Za-z0-9.:[\]-]+(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/.test(s.urls)
      || typeof s.username !== 'string' || !s.username || s.username.length > 1024
      || typeof s.password !== 'string' || !s.password || s.password.length > 2048) fail();
    return { ...s };
  });
  if (authorization?.policyVersion !== 'turn-account-quota-v1' || authorization.authorized !== true
    || authorization.status !== 'authorized' || authorization.deviceKind !== 'phone'
    || authorization.connectionId !== turn.connectionId || !same(authorization, publicTurnAuthorization(authorization))) fail();
  if (!/^[a-f0-9]{40}$/.test(p2p?.roomId || '')) fail();
  const signalingEndpoint = temporarySignalingEndpoint(p2p.signalingEndpoint);
  const expiresAt = turn.expiresAt;
  const turnCandidate = { id: `cand_${temporaryHash(`${grant.grantId}\nturn\n${turn.connectionId}`).slice(0, 24)}`,
    kind: 'turn', provider: 'cloudflare-realtime', endpoint: iceServers[0].urls, priority: 120,
    expiresAt, requiresUserConsent: false,
    metadata: { appTrafficOnly: true, carrier: 'cloudflare-realtime-turn', connectionId: turn.connectionId, iceServers } };
  return {
    contractVersion: TEMPORARY_BOOTSTRAP_VERSION, enrollmentKind: 'temporary-device',
    instanceId: envelope.invitation.instanceId, deviceId: grant.deviceId, connectionMode: 'turn-first',
    issuedAt: new Date(issuedAtMs).toISOString(), expiresAt,
    temporaryAccess: { grantId: grant.grantId, invitationId: envelope.invitation.invitationId,
      requestId: grant.requestId, deviceKeyFingerprint: grant.deviceKeyFingerprint, deviceJwkThumbprint: claims.cnf.jkt,
      capabilities: [...envelope.invitation.capabilities], sessionScope: envelope.invitation.sessionScope,
      expiresAt: new Date(accessExpiresAt).toISOString() },
    candidates: [turnCandidate, { id: `cand_${temporaryHash(`${grant.grantId}\nwebrtc\n${p2p.roomId}`).slice(0, 24)}`,
      kind: 'webrtc', provider: 'core_p2p', endpoint: signalingEndpoint, priority: 60, expiresAt,
      requiresUserConsent: false, metadata: { roomId: p2p.roomId, turnAllowed: true } }],
    turn: { provider: 'cloudflare-realtime', transport: 'turn', appTrafficOnly: true,
      credentialScope: 'temporary-device-access', temporaryGrantId: grant.grantId,
      temporaryInvitationId: envelope.invitation.invitationId, accessExpiresAt: new Date(accessExpiresAt).toISOString(),
      expiresAt, connectionId: turn.connectionId, iceServers },
    turnAuthorization: structuredClone(authorization),
    initialCarrier: { candidateId: turnCandidate.id, kind: 'turn', provider: turnCandidate.provider, endpoint: turnCandidate.endpoint },
    upgrade: { strategy: 'probe-after-bootstrap', targets: ['webrtc'], retainCurrentWhenNoP2PPath: true }, fallback: null,
  };
}

export function buildTemporaryConnectionContract({ identity, ...options }) {
  const contract = unsigned({ ...options, expectedInstance: identity });
  return { ...contract, signature: { algorithm: 'ed25519', keyId: identity.keyFingerprint,
    signedAt: contract.issuedAt, value: sign(null, Buffer.from(temporaryContractSigningPayload(contract)), identity.privateKey).toString('base64url') } };
}

/** Verify against the original enrollment facts, never a public key delivered by the broker alone. */
export function verifyTemporaryConnectionContract(contract, { envelope, grant, credential, expectedInstance, now }) {
  try {
    if (!contract || !Number.isSafeInteger(now)) fail();
    const issuedAtMs = iso(contract.issuedAt);
    if (issuedAtMs > now || iso(contract.expiresAt) <= now) fail();
    const rtc = contract.candidates?.find((c) => c.kind === 'webrtc');
    const expected = unsigned({ envelope, grant, credential, expectedInstance, issuedAtMs,
      turn: contract.turn, authorization: contract.turnAuthorization,
      p2p: { signalingEndpoint: rtc?.endpoint, roomId: rtc?.metadata?.roomId } });
    const { signature, ...body } = contract;
    if (!same(body, expected) || !exact(signature, ['algorithm', 'keyId', 'signedAt', 'value'])
      || signature.algorithm !== 'ed25519' || signature.keyId !== envelope.invitation.instanceKeyFingerprint
      || signature.signedAt !== contract.issuedAt || !/^[A-Za-z0-9_-]{86}$/.test(signature.value || '')) fail();
    const bytes = Buffer.from(signature.value, 'base64url');
    if (bytes.length !== 64 || bytes.toString('base64url') !== signature.value
      || !verify(null, Buffer.from(temporaryContractSigningPayload(contract)), temporaryPublicKey(envelope.publicKey, true).key, bytes)) fail();
    return structuredClone(contract);
  } catch { fail(); }
}

export function verifyTemporaryP2PAccess(contract, p2p) {
  const rtc = contract?.candidates?.find((c) => c.kind === 'webrtc');
  if (!exact(p2p, ['roomId', 'secret', 'signalingEndpoint']) || !/^[a-f0-9]{64}$/.test(p2p.secret)
    || p2p.roomId !== createP2PRoomId(p2p.secret) || rtc?.metadata?.roomId !== p2p.roomId
    || rtc?.endpoint !== p2p.signalingEndpoint) fail();
  return structuredClone(p2p);
}
