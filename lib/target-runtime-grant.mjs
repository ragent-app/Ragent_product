// Accounts-signed, target-bound grants for the Web -> Runtime gateway.
// Grants are bearer credentials, so every claim that affects routing is
// verified against the request before the runtime's ordinary auth dispatch.
import { createPublicKey, verify } from 'node:crypto';
import { classifyTargetRuntimeRequest, normalizeTargetRuntimePath } from './target-runtime-policy.mjs';

export const TARGET_RUNTIME_GRANT_AUDIENCE = 'ragent-target-runtime';
export const TARGET_RUNTIME_GRANT_TTL_MS = 60 * 1000;

function text(value, max = 2048) {
  return (typeof value === 'string' ? value.trim() : '').slice(0, max);
}

function invalid(code, message, statusCode = 401) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function integer(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalid('TARGET_GRANT_INVALID', `${field} is invalid`);
  return parsed;
}

function decode(value) {
  return Buffer.from(text(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text(value).length / 4) * 4, '='), 'base64');
}

function parseJwt(token) {
  const parts = text(token, 16 * 1024).split('.');
  if (parts.length !== 3) throw invalid('TARGET_GRANT_INVALID', 'Target runtime grant is not a JWT.');
  try {
    return { parts, header: JSON.parse(decode(parts[0]).toString('utf8')), claims: JSON.parse(decode(parts[1]).toString('utf8')) };
  } catch {
    throw invalid('TARGET_GRANT_INVALID', 'Target runtime grant is malformed.');
  }
}

export function createTargetRuntimeGrantClaims({
  issuer,
  accountId,
  sourceInstanceId,
  targetInstanceId,
  requestId,
  idempotencyKey,
  method,
  path,
  operation,
  resourceId,
  expectedRevision,
  expiresAt = '',
  nowMs = Date.now(),
  ttlMs = TARGET_RUNTIME_GRANT_TTL_MS,
  jti,
} = {}) {
  const policy = classifyTargetRuntimeRequest(method, path);
  if (!policy || policy.operation !== operation) throw invalid('TARGET_GRANT_ROUTE_INVALID', 'Target runtime route is not allowed.', 400);
  const normalizedPath = normalizeTargetRuntimePath(path);
  const nowSeconds = Math.floor(nowMs / 1000);
  const requestedExpiryMs = Date.parse(text(expiresAt));
  const exp = Number.isFinite(requestedExpiryMs)
    ? Math.floor(requestedExpiryMs / 1000)
    : nowSeconds + Math.max(1, Math.floor(Number(ttlMs) / 1000));
  if (exp <= nowSeconds || exp - nowSeconds > 5 * 60) {
    throw invalid('TARGET_GRANT_LIFETIME_INVALID', 'Target runtime grant lifetime is invalid.', 400);
  }
  return {
    iss: text(issuer, 512),
    aud: TARGET_RUNTIME_GRANT_AUDIENCE,
    sub: text(sourceInstanceId, 160),
    accountId: text(accountId, 160),
    sourceInstanceId: text(sourceInstanceId, 160),
    targetInstanceId: text(targetInstanceId, 160),
    requestId: text(requestId, 160),
    idempotencyKey: text(idempotencyKey, 160),
    method: policy.method,
    path: normalizedPath,
    operation: policy.operation,
    resourceId: text(resourceId, 160),
    expectedRevision: integer(expectedRevision, 'expectedRevision'),
    expiresAt: new Date(exp * 1000).toISOString(),
    iat: nowSeconds,
    exp,
    jti: text(jti, 160),
  };
}

export function verifyTargetRuntimeGrant({
  token,
  jwks,
  issuer,
  targetInstanceId,
  method,
  path,
  nowMs = Date.now(),
} = {}) {
  const parsed = parseJwt(token);
  if (parsed.header?.alg !== 'EdDSA' || !text(parsed.header?.kid, 160)) {
    throw invalid('TARGET_GRANT_INVALID', 'Target runtime grant uses an unsupported signing algorithm.');
  }
  const key = (Array.isArray(jwks?.keys) ? jwks.keys : []).find((item) => text(item?.kid, 160) === parsed.header.kid);
  if (!key) throw invalid('TARGET_GRANT_KEY_UNKNOWN', 'Target runtime grant signing key is unknown.');
  let signatureValid = false;
  try {
    signatureValid = verify(null, Buffer.from(`${parsed.parts[0]}.${parsed.parts[1]}`, 'utf8'), createPublicKey({ key, format: 'jwk' }), decode(parsed.parts[2]));
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw invalid('TARGET_GRANT_SIGNATURE_INVALID', 'Target runtime grant signature is invalid.');
  const claims = parsed.claims || {};
  const nowSeconds = Math.floor(nowMs / 1000);
  if (text(claims.iss, 512) !== text(issuer, 512)
      || claims.aud !== TARGET_RUNTIME_GRANT_AUDIENCE
      || text(claims.sub, 160) !== text(claims.sourceInstanceId, 160)
      || text(claims.targetInstanceId, 160) !== text(targetInstanceId, 160)
      || !Number.isSafeInteger(Number(claims.iat))
      || !Number.isSafeInteger(Number(claims.exp))
      || Number(claims.exp) <= nowSeconds
      || Number(claims.iat) > nowSeconds + 30
      || Number(claims.exp) - Number(claims.iat) > 5 * 60) {
    throw invalid('TARGET_GRANT_BINDING_INVALID', 'Target runtime grant identity or lifetime is invalid.');
  }
  if (text(claims.expiresAt, 64) !== new Date(Number(claims.exp) * 1000).toISOString()) {
    throw invalid('TARGET_GRANT_BINDING_INVALID', 'Target runtime grant expiry is invalid.');
  }
  const policy = classifyTargetRuntimeRequest(method, path);
  if (!policy || policy.method !== text(claims.method, 16).toUpperCase()
      || policy.path !== normalizeTargetRuntimePath(claims.path)
      || policy.operation !== text(claims.operation, 96)) {
    throw invalid('TARGET_GRANT_ROUTE_MISMATCH', 'Target runtime grant is not bound to this request.', 403);
  }
  if (!text(claims.accountId, 160) || !text(claims.sourceInstanceId, 160)
      || !text(claims.requestId, 160) || !text(claims.idempotencyKey, 160)
      || !text(claims.resourceId, 160)) {
    throw invalid('TARGET_GRANT_BINDING_INVALID', 'Target runtime grant is missing a command binding.');
  }
  integer(claims.expectedRevision, 'expectedRevision');
  return Object.freeze({ ...claims, method: policy.method, path: policy.path, operation: policy.operation });
}
