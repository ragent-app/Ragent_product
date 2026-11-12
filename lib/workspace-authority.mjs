import { createPublicKey, verify } from 'node:crypto';
import { BINDING_AUTHORITY_TTL_MS } from './binding-authority.mjs';

export const WORKSPACE_AUTHORITY_AUDIENCE = 'ragent-workspace-authority';
function invalid() {
  return Object.assign(new Error('Invalid or expired signed workspace authority'), {
    code: 'workspace_authority_assertion_invalid', statusCode: 502,
  });
}

export function verifyWorkspaceAuthorityAssertion(assertion, jwks, {
  issuer, instanceId, keyFingerprint, ownerAccountId, accountId, grantId, requestId, nonce, startedAt, clock = Date.now,
}) {
  if (typeof assertion !== 'string' || assertion.length > 16 * 1024) throw invalid();
  const parts = assertion.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
  let header, claims, valid = false;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    const key = jwks?.keys?.find(item => item.kid === header.kid && item.kty === 'OKP' && item.crv === 'Ed25519');
    valid = header.alg === 'EdDSA' && typeof header.kid === 'string' && Boolean(key)
      && verify(null, Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  } catch {}
  const now = clock(), revision = claims?.bindingAuthorityRevision, state = claims?.workspaceAuthorityState;
  if (!valid || ![issuer, instanceId, keyFingerprint, ownerAccountId, accountId, grantId, requestId, nonce]
    .every(value => typeof value === 'string' && value) || ownerAccountId === accountId
    || !claims || typeof claims !== 'object' || Array.isArray(claims)
    || ![instanceId, ownerAccountId, accountId].every(value => /^[A-Za-z0-9_-]{8,160}$/.test(value))
    || !/^[a-f0-9]{64}$/.test(keyFingerprint) || !/^iag_[A-Za-z0-9_-]{16,128}$/.test(grantId)
    || claims.iss !== issuer || claims.aud !== instanceId || claims.sub !== accountId
    || claims.ownerAccountId !== ownerAccountId || claims.workspaceGrantId !== grantId
    || claims.tx !== requestId || claims.nonce !== nonce || claims.instanceKeyFingerprint !== keyFingerprint
    || claims.purpose !== 'workspace_authority' || claims.authorityProtocol !== 1
    || !['active', 'inactive'].includes(state) || typeof revision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(revision)
    || BigInt(revision) > 9223372036854775807n || (revision === '0' && state === 'active')
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp - claims.iat !== 30
    || claims.iat * 1000 > now + 5000 || claims.exp * 1000 <= now
    || !Number.isSafeInteger(startedAt) || startedAt > now || startedAt + BINDING_AUTHORITY_TTL_MS <= now) throw invalid();
  return Object.freeze({ instanceId, keyFingerprint, ownerAccountId, accountId, grantId, requestId, nonce, revision, state,
    checkedAt: startedAt, expiresAt: Math.min(claims.exp * 1000, startedAt + BINDING_AUTHORITY_TTL_MS), authorityProtocol: 1 });
}
