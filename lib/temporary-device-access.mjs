// Device-bound credentials for temporary enrollment. Verification does not grant a route or Session permission.
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { checkedTemporaryId, temporaryPairingError, temporaryPublicKey,
  normalizeTemporaryInvitation, verifyTemporaryInvitation } from './temporary-pairing-protocol.mjs';

export const TEMPORARY_ACCESS_AUDIENCE = 'ragent-temporary-device-access';
export const TEMPORARY_DPOP_WINDOW_MS = 30_000;
const fail = (suffix) => { throw temporaryPairingError(`temporary_access_${suffix}`, 401); };
const hash = (value) => createHash('sha256').update(value).digest('base64url');
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail('encoding_invalid');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail('encoding_invalid');
  return bytes;
}

function jwt(value) {
  if (typeof value !== 'string' || value.length > 8192) fail('token_invalid');
  const parts = value.split('.'); if (parts.length !== 3) fail('token_invalid');
  try {
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(parts[0])));
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(parts[1])));
    return { header, payload, signature: decode(parts[2]), input: Buffer.from(`${parts[0]}.${parts[1]}`) };
  } catch { fail('token_invalid'); }
}

/** RFC 7638 public JWK thumbprint (EC P-256 or OKP Ed25519); not the SPKI fingerprint. */
export function temporaryDeviceJwk(publicKey) {
  const key = temporaryPublicKey(publicKey).key;
  const j = key.export({ format: 'jwk' });
  const jwk = j.kty === 'EC' ? { crv: j.crv, kty: j.kty, x: j.x, y: j.y } : { crv: j.crv, kty: j.kty, x: j.x };
  return { jwk, thumbprint: hash(JSON.stringify(jwk)) };
}

function accessClaims(invitation, grant) {
  const i = normalizeTemporaryInvitation(invitation);
  const device = temporaryPublicKey(grant?.devicePublicKey);
  checkedTemporaryId(grant?.grantId, 'rtg'); checkedTemporaryId(grant?.deviceId, 'rdev'); checkedTemporaryId(grant?.requestId, 'rtr');
  if (grant.deviceKeyFingerprint !== device.fingerprint || !Number.isSafeInteger(grant.grantedAt)
    || grant.grantedAt < i.createdAt || grant.grantedAt >= i.claimExpiresAt) fail('binding_invalid');
  return { iss: i.instanceId, aud: TEMPORARY_ACCESS_AUDIENCE, sub: grant.deviceId, jti: grant.grantId,
    invitationId: i.invitationId, requestId: grant.requestId, deviceKeyFingerprint: device.fingerprint,
    scope: i.capabilities.join(' '), sessionScope: i.sessionScope,
    iat: Math.floor(grant.grantedAt / 1000), exp: Math.floor(i.accessExpiresAt / 1000),
    cnf: { jkt: temporaryDeviceJwk(device.publicKey).thumbprint } };
}

/** Deterministic reissue keeps the original grant identity and absolute deadline. No refresh credential. */
export function issueTemporaryAccessCredential({ identity, envelope, grant }) {
  const invitation = verifyTemporaryInvitation(envelope, identity);
  const claims = accessClaims(invitation, grant);
  const input = `${encode({ typ: 'ragent-temporary-access+jwt', alg: 'EdDSA', kid: identity.keyFingerprint })}.${encode(claims)}`;
  const token = `${input}.${sign(null, Buffer.from(input), identity.privateKey).toString('base64url')}`;
  return { token_type: 'DPoP', access_token: token, expires_at: claims.exp * 1000 };
}

/** Untrusted lookup hint only. Always verify against the pinned PC and current local grant afterwards. */
export function temporaryAccessGrantHint(token) { return checkedTemporaryId(jwt(token).payload?.jti, 'rtg'); }

/** Untrusted transport framing only; verifyTemporaryAccessCredential checks the signed value. */
export function temporaryAccessExpiryHint(token) {
  const exp = jwt(token).payload?.exp;
  if (!Number.isSafeInteger(exp) || exp <= 0 || exp > Number.MAX_SAFE_INTEGER / 1000) fail('token_invalid');
  return exp * 1000;
}

export function verifyTemporaryAccessCredential(credential, { envelope, grant, expectedInstance, now }) {
  if (!exactKeys(credential, ['token_type', 'access_token', 'expires_at']) || credential.token_type !== 'DPoP') fail('credential_invalid');
  const invitation = verifyTemporaryInvitation(envelope, expectedInstance);
  const expected = accessClaims(invitation, grant);
  const { header, payload, signature, input } = jwt(credential.access_token);
  if (!exactKeys(header, ['typ', 'alg', 'kid']) || header.typ !== 'ragent-temporary-access+jwt'
    || header.alg !== 'EdDSA' || header.kid !== invitation.instanceKeyFingerprint
    || signature.length !== 64 || !verify(null, input, temporaryPublicKey(envelope.publicKey, true).key, signature)) fail('signature_invalid');
  // Expected claims come from original signed invitation and accepted device, not from the token itself.
  if (!exactKeys(payload, Object.keys(expected))
    || Object.keys(expected).some((k) => k === 'cnf'
      ? !exactKeys(payload.cnf, ['jkt']) || payload.cnf.jkt !== expected.cnf.jkt
      : payload[k] !== expected[k])
    || credential.expires_at !== expected.exp * 1000
    || !Number.isSafeInteger(now) || now < grant.grantedAt || now >= credential.expires_at) fail('binding_invalid');
  return structuredClone(expected);
}

/** RFC 9449 resource proof checks. The adapter supplies the trusted original HTTPS target URI. */
export function verifyTemporaryDpopProof(proof, { accessToken, devicePublicKey, method, targetUri, now }) {
  const { header, payload, signature, input } = jwt(proof);
  const expected = temporaryDeviceJwk(devicePublicKey);
  const device = temporaryPublicKey(devicePublicKey);
  const alg = device.algorithm === 'ed25519' ? 'EdDSA' : 'ES256';
  if (!exactKeys(header, ['typ', 'alg', 'jwk']) || header.typ !== 'dpop+jwt' || header.alg !== alg
    || !exactKeys(header.jwk, Object.keys(expected.jwk))
    || Object.keys(expected.jwk).some((k) => header.jwk[k] !== expected.jwk[k]) || signature.length !== 64) fail('proof_invalid');
  let uri;
  try {
    uri = new URL(targetUri);
    if (uri.protocol !== 'https:' || uri.username || uri.password || uri.hash) fail('target_invalid');
    uri.search = '';
  } catch { fail('target_invalid'); }
  if (!payload || !/^[A-Z]{3,12}$/.test(method) || payload.htm !== method || payload.htu !== uri.toString()
    || typeof payload.jti !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(payload.jti)
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(now)
    || Math.abs(now - payload.iat * 1000) >= TEMPORARY_DPOP_WINDOW_MS
    || payload.ath !== hash(accessToken)
    || !verify(alg === 'EdDSA' ? null : 'sha256', input, { key: createPublicKey({ key: header.jwk, format: 'jwk' }),
      ...(alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' } : {}) }, signature)) fail('proof_invalid');
  // Key-scoped jti replay protection is persisted by the PC registry, including across reissued tokens.
  return { proofHash: hash(JSON.stringify([expected.thumbprint, payload.jti])),
    expiresAt: payload.iat * 1000 + TEMPORARY_DPOP_WINDOW_MS };
}
