import { createPublicKey, verify } from 'node:crypto';

export const BINDING_AUTHORITY_AUDIENCE = 'ragent-binding-authority';
export const BINDING_AUTHORITY_TTL_MS = 30_000;

function invalid() {
  return Object.assign(new Error('Invalid or expired signed binding authority'), {
    code: 'owner_auth_authority_assertion_invalid', statusCode: 502,
  });
}

export function verifyBindingAuthorityAssertion(assertion, jwks, {
  issuer, instanceId, keyFingerprint, accountId, requestId, nonce, startedAt, clock = Date.now,
}) {
  if (typeof assertion !== 'string' || assertion.length > 16 * 1024) throw invalid();
  const parts = assertion.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
  let header, claims, valid = false;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    const key = jwks?.keys?.find(key => key.kid === header.kid && key.kty === 'OKP' && key.crv === 'Ed25519');
    valid = header.alg === 'EdDSA' && typeof header.kid === 'string' && Boolean(header.kid) && Boolean(key)
      && verify(null, Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  } catch {}
  const now = clock(), revision = claims?.bindingAuthorityRevision, state = claims?.bindingAuthorityState;
  if (!valid || ![issuer, instanceId, keyFingerprint, accountId, requestId, nonce].every(value => typeof value === 'string' && value)
    || claims.iss !== issuer || claims.aud !== instanceId || claims.sub !== accountId
    || claims.tx !== requestId || claims.nonce !== nonce || claims.instanceKeyFingerprint !== keyFingerprint
    || claims.purpose !== 'binding_authority' || claims.authorityProtocol !== 1
    || !['active', 'revoked', 'missing', 'mismatch'].includes(state)
    || typeof revision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(revision)
    || BigInt(revision) > 9223372036854775807n || (revision === '0' && state !== 'missing')
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp - claims.iat !== 30
    || claims.iat * 1000 > now + 5000 || claims.exp * 1000 <= now
    || !Number.isSafeInteger(startedAt) || startedAt > now || startedAt + BINDING_AUTHORITY_TTL_MS <= now) throw invalid();
  return Object.freeze({ instanceId, keyFingerprint, accountId, requestId, nonce, revision, state,
    checkedAt: startedAt, expiresAt: Math.min(claims.exp * 1000, startedAt + BINDING_AUTHORITY_TTL_MS),
    signedExpiresAt: claims.exp * 1000, authorityProtocol: 1 });
}
