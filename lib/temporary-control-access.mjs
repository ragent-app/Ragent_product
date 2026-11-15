// Device-bound DPoP credential for a confirmed v2 full-control grant. This
// has a different audience and claim set from the v1 temporary-share token.
import { createHash, sign, verify } from 'node:crypto';
import { temporaryPairingError, temporaryPublicKey } from './temporary-pairing-protocol.mjs';
import { normalizeTemporaryControlInvitation, verifyTemporaryControlInvitation } from './temporary-control-protocol.mjs';
import { temporaryDeviceJwk, verifyTemporaryDpopProof } from './temporary-device-access.mjs';

export const TEMPORARY_CONTROL_ACCESS_AUDIENCE = 'ragent-temporary-control-access';

const fail = (code = 'temporary_control_credential_invalid', statusCode = 401) => {
  throw temporaryPairingError(code, statusCode);
};
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail();
  return bytes;
}
function parse(token) {
  if (typeof token !== 'string' || token.length > 8192) fail();
  const parts = token.split('.');
  if (parts.length !== 3) fail();
  try {
    return { header: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(parts[0]))),
      payload: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(parts[1]))),
      signature: decode(parts[2]), input: Buffer.from(`${parts[0]}.${parts[1]}`) };
  } catch { fail(); }
}
function id(value, prefix) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9_-]{24,64}$`).test(value)) fail();
  return value;
}
function claims(envelope, material) {
  const invitation = normalizeTemporaryControlInvitation(envelope?.invitation);
  const device = temporaryPublicKey(material?.claim?.devicePublicKey);
  const grant = material?.grant;
  if (material?.claim?.deviceKeyFingerprint !== device.fingerprint
    || !grant || !Number.isSafeInteger(grant.grantedAt)
    || !Number.isSafeInteger(material?.accessExpiresAt)
    || material.accessExpiresAt !== grant.grantedAt + invitation.accessDurationMs) fail('temporary_control_credential_binding_invalid');
  return { iss: invitation.instanceId, aud: TEMPORARY_CONTROL_ACCESS_AUDIENCE,
    sub: id(grant.deviceId, 'rdev'), jti: id(grant.grantId, 'rtg'), invitationId: invitation.invitationId,
    deviceKeyFingerprint: device.fingerprint, scope: invitation.capabilities.join(' '),
    sessionScope: invitation.sessionScope, iat: Math.floor(grant.grantedAt / 1000),
    exp: Math.floor(material.accessExpiresAt / 1000), cnf: { jkt: temporaryDeviceJwk(device.publicKey).thumbprint } };
}

export function issueTemporaryControlAccessCredential({ identity, envelope, material }) {
  const invitation = verifyTemporaryControlInvitation(envelope, identity);
  const payload = claims(envelope, material);
  if (payload.iss !== invitation.instanceId) fail('temporary_control_credential_binding_invalid');
  const input = `${encode({ typ: 'ragent-temporary-control-access+jwt', alg: 'EdDSA', kid: identity.keyFingerprint })}.${encode(payload)}`;
  return Object.freeze({ token_type: 'DPoP', access_token: `${input}.${sign(null, Buffer.from(input), identity.privateKey).toString('base64url')}`,
    expires_at: payload.exp * 1000 });
}

/** Untrusted lookup hint only; verification still binds it to the live registry record. */
export function temporaryControlGrantHint(token) { return id(parse(token).payload?.jti, 'rtg'); }

/** Transport framing hint only; signature and live-grant checks happen later. */
export function temporaryControlAccessExpiryHint(token) {
  const exp = parse(token).payload?.exp;
  if (!Number.isSafeInteger(exp) || exp <= 0 || exp > Number.MAX_SAFE_INTEGER / 1000) fail();
  return exp * 1000;
}

export function verifyTemporaryControlAccessCredential(credential, { envelope, material, expectedInstance, now }) {
  if (!exact(credential, ['token_type', 'access_token', 'expires_at']) || credential.token_type !== 'DPoP') fail();
  const invitation = verifyTemporaryControlInvitation(envelope, expectedInstance);
  const expected = claims(envelope, material);
  const parsed = parse(credential.access_token);
  if (!exact(parsed.header, ['typ', 'alg', 'kid']) || parsed.header.typ !== 'ragent-temporary-control-access+jwt'
    || parsed.header.alg !== 'EdDSA' || parsed.header.kid !== invitation.instanceKeyFingerprint
    || parsed.signature.length !== 64 || !verify(null, parsed.input, temporaryPublicKey(envelope.publicKey, true).key, parsed.signature)
    || !exact(parsed.payload, Object.keys(expected))
    || Object.keys(expected).some((key) => key === 'cnf'
      ? !exact(parsed.payload.cnf, ['jkt']) || parsed.payload.cnf.jkt !== expected.cnf.jkt
      : parsed.payload[key] !== expected[key])
    || credential.expires_at !== expected.exp * 1000 || !Number.isSafeInteger(now)
    || now < material.grant.grantedAt || now >= credential.expires_at) fail('temporary_control_credential_binding_invalid');
  return structuredClone(expected);
}

export function verifyTemporaryControlDpopProof(proof, { credential, material, method, targetUri, now }) {
  const result = verifyTemporaryDpopProof(proof, { accessToken: credential.access_token,
    devicePublicKey: material.claim.devicePublicKey, method, targetUri, now });
  // verifyTemporaryDpopProof binds the actual public JWK; repeat the durable
  // record check so a swapped device key cannot consume a proof.
  if (temporaryPublicKey(material.claim.devicePublicKey).fingerprint !== material.claim.deviceKeyFingerprint) fail('temporary_control_credential_binding_invalid');
  return result;
}
