// Short-lived capability used only between Accounts and the independent TURN
// broker. It is intentionally separate from owner/account assertions.
import { createPublicKey, randomBytes, sign, verify } from 'node:crypto';

export const TURN_BROKER_CAPABILITY_AUDIENCE = 'ragent-turn-broker';
export const TURN_BROKER_CAPABILITY_SCOPE = 'turn:mint';
export const TEMPORARY_TURN_BROKER_SCOPE = 'turn:mint:temporary';
export const TURN_BROKER_CAPABILITY_DEFAULT_TTL_MS = 60 * 1000;
export const TURN_BROKER_CAPABILITY_MAX_TTL_MS = 60 * 1000;
export const TURN_BROKER_CAPABILITY_CLOCK_SKEW_MS = 30 * 1000;
export const TURN_BROKER_AUTH_MODES = Object.freeze([
  'accounts-capability',
  'static',
  'dual',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  const raw = text(value).replace(/-/g, '+').replace(/_/g, '/');
  if (!raw) return Buffer.alloc(0);
  return Buffer.from(raw.padEnd(Math.ceil(raw.length / 4) * 4, '='), 'base64');
}

function json(value) {
  return JSON.stringify(value);
}

function capabilityError(code, message, statusCode = 403) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function requiredIdentity({ accountId, instanceId, deviceId, connectionId } = {}) {
  const identity = {
    accountId: text(accountId),
    instanceId: text(instanceId),
    deviceId: text(deviceId),
    connectionId: text(connectionId),
  };
  if (Object.values(identity).some((value) => !value)) {
    throw capabilityError('turn_broker_capability_identity_invalid', 'TURN capability identity is incomplete.', 400);
  }
  return identity;
}

export function normalizeTurnBrokerAuthMode(value, fallback = 'accounts-capability') {
  const normalized = text(value).toLowerCase();
  if (TURN_BROKER_AUTH_MODES.includes(normalized)) return normalized;
  const normalizedFallback = text(fallback).toLowerCase();
  return TURN_BROKER_AUTH_MODES.includes(normalizedFallback)
    ? normalizedFallback
    : 'accounts-capability';
}

function normalizeTtl(ttlMs) {
  const value = Number(ttlMs);
  if (!Number.isFinite(value) || value <= 0) return TURN_BROKER_CAPABILITY_DEFAULT_TTL_MS;
  return Math.min(TURN_BROKER_CAPABILITY_MAX_TTL_MS, Math.max(1000, Math.floor(value)));
}

export function createTurnBrokerCapabilityClaims({
  issuer,
  accountId,
  instanceId,
  deviceId,
  connectionId,
  nowMs = Date.now(),
  ttlMs = TURN_BROKER_CAPABILITY_DEFAULT_TTL_MS,
  jti = `tbc_${randomBytes(18).toString('base64url')}`,
  temporaryGrant,
} = {}) {
  const normalizedIssuer = text(issuer);
  if (!normalizedIssuer) throw capabilityError('turn_broker_capability_issuer_invalid', 'TURN capability issuer is not configured.', 500);
  const identity = requiredIdentity({ accountId, instanceId, deviceId, connectionId });
  const issuedAt = Math.floor(Number(nowMs) / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw capabilityError('turn_broker_capability_time_invalid', 'TURN capability issue time is invalid.', 500);
  }
  const effectiveTtlMs = normalizeTtl(ttlMs);
  const claims = {
    iss: normalizedIssuer,
    aud: TURN_BROKER_CAPABILITY_AUDIENCE,
    sub: identity.instanceId,
    ...identity,
    scope: TURN_BROKER_CAPABILITY_SCOPE,
    jti: text(jti),
    iat: issuedAt,
    exp: issuedAt + Math.ceil(effectiveTtlMs / 1000),
  };
  if (temporaryGrant !== undefined) {
    const deadline = Math.floor(temporaryGrant?.accessExpiresAt / 1000);
    if (!/^rtg_[A-Za-z0-9_-]{24,64}$/.test(temporaryGrant?.grantId || '')
      || !/^rti_[A-Za-z0-9_-]{24,64}$/.test(temporaryGrant?.invitationId || '')
      || !Number.isSafeInteger(temporaryGrant?.accessExpiresAt) || deadline * 1000 <= nowMs
      || deadline > issuedAt + 600) {
      throw capabilityError('turn_broker_temporary_grant_invalid', 'Temporary TURN grant is invalid.', 403);
    }
    Object.assign(claims, { scope: TEMPORARY_TURN_BROKER_SCOPE, temporaryGrantId: temporaryGrant.grantId,
      temporaryInvitationId: temporaryGrant.invitationId, credentialExpiresAt: deadline, exp: Math.min(claims.exp, deadline) });
  }
  return claims;
}

export async function issueTurnBrokerCapability({ signCapability, ...options } = {}) {
  if (typeof signCapability !== 'function') {
    throw capabilityError('turn_broker_capability_unavailable', 'TURN capability signer is not configured.', 503);
  }
  const claims = createTurnBrokerCapabilityClaims(options);
  if (!claims.jti) throw capabilityError('turn_broker_capability_jti_invalid', 'TURN capability id is invalid.', 500);
  const token = text(await signCapability(claims));
  if (!token) throw capabilityError('turn_broker_capability_unavailable', 'TURN capability signer returned no token.', 503);
  return {
    token,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    scope: claims.scope,
    ...(claims.scope === TEMPORARY_TURN_BROKER_SCOPE ? { credentialExpiresAt: new Date(claims.credentialExpiresAt * 1000).toISOString() } : {}),
    connectionId: claims.connectionId,
    // The broker idempotency key is scoped to this one capability. Reusing
    // connectionId here would conflict with a later capability for the same
    // connection while the broker still retains the previous response.
    idempotencyKey: claims.jti,
  };
}

function parseToken(token) {
  const parts = text(token).split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw capabilityError('turn_broker_capability_invalid', 'TURN capability is invalid.', 401);
  }
  let header;
  let claims;
  try {
    header = JSON.parse(decodeBase64Url(parts[0]).toString('utf8'));
    claims = JSON.parse(decodeBase64Url(parts[1]).toString('utf8'));
  } catch {
    throw capabilityError('turn_broker_capability_invalid', 'TURN capability is invalid.', 401);
  }
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') {
    throw capabilityError('turn_broker_capability_invalid', 'TURN capability is invalid.', 401);
  }
  const signature = decodeBase64Url(parts[2]);
  if (!signature.length) throw capabilityError('turn_broker_capability_invalid', 'TURN capability is invalid.', 401);
  return { header, claims, signature, signingInput: `${parts[0]}.${parts[1]}` };
}

function assertTimeClaims(claims, { nowMs, clockSkewMs, maxTtlMs }) {
  const issuedAt = Number(claims.iat);
  const expiresAt = Number(claims.exp);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
    throw capabilityError('turn_broker_capability_time_invalid', 'TURN capability time claims are invalid.', 401);
  }
  if (expiresAt - issuedAt > Math.ceil(maxTtlMs / 1000)) {
    throw capabilityError('turn_broker_capability_ttl_invalid', 'TURN capability lifetime is too long.', 401);
  }
  if (issuedAt * 1000 > nowMs + clockSkewMs) {
    throw capabilityError('turn_broker_capability_not_yet_valid', 'TURN capability is not yet valid.', 401);
  }
  if (expiresAt * 1000 <= nowMs - clockSkewMs) {
    throw capabilityError('turn_broker_capability_expired', 'TURN capability is expired.', 401);
  }
}

function keyForKid(jwks, kid) {
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  return keys.find((key) => key && text(key.kid) === kid && key.kty === 'OKP' && key.crv === 'Ed25519' && text(key.x));
}

export function verifyTurnBrokerCapability({
  token,
  jwks,
  issuer,
  accountId,
  instanceId,
  deviceId,
  connectionId,
  nowMs = Date.now(),
  clockSkewMs = TURN_BROKER_CAPABILITY_CLOCK_SKEW_MS,
  maxTtlMs = TURN_BROKER_CAPABILITY_MAX_TTL_MS,
} = {}) {
  const parsed = parseToken(token);
  const { header, claims } = parsed;
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || !text(header.kid)) {
    throw capabilityError('turn_broker_capability_header_invalid', 'TURN capability header is invalid.', 401);
  }
  const key = keyForKid(jwks, header.kid);
  if (!key) throw capabilityError('turn_broker_capability_key_unknown', 'TURN capability signing key is unknown.', 401);
  let validSignature = false;
  try {
    validSignature = verify(
      null,
      Buffer.from(parsed.signingInput, 'utf8'),
      createPublicKey({ key, format: 'jwk' }),
      parsed.signature,
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) throw capabilityError('turn_broker_capability_signature_invalid', 'TURN capability signature is invalid.', 401);

  const identity = requiredIdentity({ accountId, instanceId, deviceId, connectionId });
  if (text(claims.iss) !== text(issuer)
    || claims.aud !== TURN_BROKER_CAPABILITY_AUDIENCE
    || claims.sub !== identity.instanceId
    || ![TURN_BROKER_CAPABILITY_SCOPE, TEMPORARY_TURN_BROKER_SCOPE].includes(claims.scope)
    || claims.accountId !== identity.accountId
    || claims.instanceId !== identity.instanceId
    || claims.deviceId !== identity.deviceId
    || claims.connectionId !== identity.connectionId
    || !text(claims.jti)) {
    throw capabilityError('turn_broker_capability_binding_invalid', 'TURN capability is not bound to this request.', 403);
  }
  assertTimeClaims(claims, { nowMs, clockSkewMs, maxTtlMs });
  if (claims.scope === TEMPORARY_TURN_BROKER_SCOPE) {
    if (!/^rtg_[A-Za-z0-9_-]{24,64}$/.test(claims.temporaryGrantId || '')
      || !/^rti_[A-Za-z0-9_-]{24,64}$/.test(claims.temporaryInvitationId || '')
      || !Number.isSafeInteger(claims.credentialExpiresAt) || claims.credentialExpiresAt <= claims.iat
      || claims.credentialExpiresAt > claims.iat + 600 || claims.exp > claims.credentialExpiresAt
      || claims.exp * 1000 <= nowMs || claims.credentialExpiresAt * 1000 <= nowMs) {
      throw capabilityError('turn_broker_temporary_grant_invalid', 'Temporary TURN grant is invalid or expired.', 403);
    }
  } else if (['temporaryGrantId', 'temporaryInvitationId', 'credentialExpiresAt'].some((key) => Object.hasOwn(claims, key))) {
    throw capabilityError('turn_broker_temporary_grant_invalid', 'Temporary TURN claims require the temporary scope.', 403);
  }
  return claims;
}

export function turnBrokerJwksFromKeyRing(ring, { clock = Date.now, graceMs } = {}) {
  const now = clock();
  const keys = Object.values(ring?.keys || {}).filter((key) => {
    if (!key?.publicJwk || !text(key.kid)) return false;
    if (!key.retiredAt || graceMs == null) return true;
    return now - Date.parse(key.retiredAt) < graceMs;
  });
  return {
    keys: keys.map((key) => ({
      ...key.publicJwk,
      kid: key.kid,
      alg: 'EdDSA',
      use: 'sig',
    })),
  };
}
