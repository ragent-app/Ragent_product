import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'crypto';

import { canonicalJson } from './connection-bootstrap-contract.mjs';

export { canonicalJson };

export const BROWSER_CONNECTION_GRANT_VERSION = 1;
export const BROWSER_CONNECTION_GRANT_DOMAIN = 'ragent-browser-connection-grant-v1';
export const SIGNAL_JOIN_TOKEN_VERSION = 1;
export const SIGNAL_JOIN_TOKEN_DOMAIN = 'ragent-signal-join-v1';
export const BROWSER_AUTH_VERSION = 1;
export const BROWSER_CONNECTION_GRANT_PERMISSION = 'remote.read.health';
export const BROWSER_AUTH_PERMISSION = BROWSER_CONNECTION_GRANT_PERMISSION;
export const BROWSER_GRANT_DEFAULT_TTL_MS = 60_000;
export const SIGNAL_JOIN_DEFAULT_TTL_MS = 60_000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('invalid base64url segment');
  }
  return Buffer.from(value, 'base64url');
}

function signatureInput(domain, payloadSegment) {
  return Buffer.from(`${domain}\n${payloadSegment}`, 'utf8');
}

function signBytes(payload, privateKey, domain) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const algorithm = key.asymmetricKeyType === 'ed25519' ? null : 'sha256';
  return cryptoSign(algorithm, payload, key).toString('base64url');
}

function verifyBytes(payload, signature, publicKey, domain) {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  const algorithm = key.asymmetricKeyType === 'ed25519' ? null : 'sha256';
  try {
    return cryptoVerify(algorithm, payload, key, decodeBase64Url(signature));
  } catch {
    return false;
  }
}

function normalizeKeySet(trustedKeys) {
  if (trustedKeys instanceof Map) return trustedKeys;
  const result = new Map();
  for (const [kid, key] of Object.entries(trustedKeys || {})) result.set(kid, key);
  return result;
}

function issueToken(payload, { privateKey, domain, prefix }) {
  const payloadSegment = encodeBase64Url(canonicalJson(payload));
  const signature = signBytes(signatureInput(domain, payloadSegment), privateKey, domain);
  return `${prefix}.${payloadSegment}.${signature}`;
}

function parseToken(token, { prefix, domain }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== prefix) throw new Error('malformed signed token');
  const payloadBytes = decodeBase64Url(parts[1]);
  const payloadText = payloadBytes.toString('utf8');
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new Error('token payload is not JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('token payload must be an object');
  }
  if (canonicalJson(payload) !== payloadText) throw new Error('token payload is not canonical');
  return { payload, payloadSegment: parts[1], signature: parts[2], domain };
}

function validTimeWindow(payload, nowMs) {
  return Number.isSafeInteger(payload.nbf)
    && Number.isSafeInteger(payload.exp)
    && payload.nbf <= payload.exp
    && nowMs >= payload.nbf
    && nowMs < payload.exp;
}

function validEphemeralPublicKey(value) {
  return value && typeof value === 'object'
    && value.alg === 'P-256'
    && value.kty === 'EC'
    && value.crv === 'P-256'
    && /^[A-Za-z0-9_-]+$/.test(String(value.x || ''))
    && /^[A-Za-z0-9_-]+$/.test(String(value.y || ''));
}

function validateCommonClaims(payload, {
  nowMs,
  expectedIssuer,
  expectedAudience,
  expectedInstanceId,
  expectedConnectionId,
  expectedClientId,
  requiredPermission,
} = {}) {
  if (payload.version !== BROWSER_CONNECTION_GRANT_VERSION) return 'unsupported grant version';
  if (!trimString(payload.iss) || (expectedIssuer && payload.iss !== expectedIssuer)) return 'invalid issuer';
  if (!trimString(payload.aud) || (expectedAudience && payload.aud !== expectedAudience)) return 'invalid audience';
  if (expectedInstanceId && payload.instanceId !== expectedInstanceId) return 'wrong instance';
  if (expectedConnectionId && payload.connectionId !== expectedConnectionId) return 'wrong connection';
  if (expectedClientId && payload.clientId !== expectedClientId) return 'wrong client';
  if (!trimString(payload.accountId) || !trimString(payload.instanceId)
    || !trimString(payload.clientId) || !trimString(payload.connectionId)
    || !trimString(payload.jti)) return 'missing grant binding';
  if (!validEphemeralPublicKey(payload.ephemeralPublicKey)) return 'invalid ephemeral public key';
  if (!Array.isArray(payload.permissions) || payload.permissions.some((entry) => typeof entry !== 'string')) {
    return 'invalid permissions';
  }
  if (requiredPermission && !payload.permissions.includes(requiredPermission)) return 'permission denied';
  if (!validTimeWindow(payload, nowMs)) return nowMs < payload.nbf ? 'grant not yet valid' : 'grant expired';
  return '';
}

export function createReplayStore({ maxEntries = 4096, now = () => Date.now() } = {}) {
  const entries = new Map();
  const sweep = (nowMs = now()) => {
    for (const [jti, expiresAt] of entries) {
      if (expiresAt <= nowMs) entries.delete(jti);
    }
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };
  return {
    consume(jti, expiresAt, nowMs = now()) {
      sweep(nowMs);
      const normalized = trimString(jti);
      if (!normalized || !Number.isSafeInteger(expiresAt) || expiresAt <= nowMs || entries.has(normalized)) return false;
      entries.set(normalized, expiresAt);
      return true;
    },
    has(jti, nowMs = now()) {
      sweep(nowMs);
      return entries.has(trimString(jti));
    },
    size() {
      sweep();
      return entries.size;
    },
    sweep,
  };
}

export function issueBrowserConnectionGrant({
  privateKey,
  issuer,
  instanceId,
  accountId,
  clientId,
  connectionId,
  ephemeralPublicKey,
  permissions = [BROWSER_CONNECTION_GRANT_PERMISSION],
  nowMs = Date.now(),
  ttlMs = BROWSER_GRANT_DEFAULT_TTL_MS,
  kid,
} = {}) {
  const payload = {
    version: BROWSER_CONNECTION_GRANT_VERSION,
    iss: trimString(issuer),
    kid: trimString(kid),
    aud: `instance:${trimString(instanceId)}`,
    sub: `account:${trimString(accountId)}`,
    accountId: trimString(accountId),
    instanceId: trimString(instanceId),
    clientId: trimString(clientId),
    connectionId: trimString(connectionId),
    ephemeralPublicKey,
    permissions: [...permissions],
    jti: `bcg_${randomBytes(18).toString('base64url')}`,
    nbf: nowMs,
    exp: nowMs + ttlMs,
  };
  const error = validateCommonClaims(payload, { nowMs, expectedIssuer: payload.iss });
  if (error || !payload.kid) throw new Error(error || 'grant kid is required');
  return { token: issueToken(payload, { privateKey, domain: BROWSER_CONNECTION_GRANT_DOMAIN, prefix: 'bca1' }), payload };
}

export function verifyBrowserConnectionGrant(token, options = {}) {
  const nowMs = Number.isSafeInteger(options.nowMs) ? options.nowMs : Date.now();
  try {
    const parsed = parseToken(token, { prefix: 'bca1', domain: BROWSER_CONNECTION_GRANT_DOMAIN });
    const keys = normalizeKeySet(options.trustedKeys);
    const publicKey = keys.get(parsed.payload.kid);
    if (!publicKey || !verifyBytes(
      signatureInput(BROWSER_CONNECTION_GRANT_DOMAIN, parsed.payloadSegment),
      parsed.signature,
      publicKey,
      BROWSER_CONNECTION_GRANT_DOMAIN,
    )) return { valid: false, reason: 'signature invalid' };
    const reason = validateCommonClaims(parsed.payload, { ...options, nowMs });
    if (reason) return { valid: false, reason };
    if (options.consume && !options.replayStore?.consume(parsed.payload.jti, parsed.payload.exp, nowMs)) {
      return { valid: false, reason: 'grant replayed' };
    }
    return { valid: true, grant: parsed.payload };
  } catch (error) {
    return { valid: false, reason: error.message || 'malformed grant' };
  }
}

export function issueSignalJoinToken({
  privateKey,
  issuer,
  roomId,
  instanceId,
  clientId,
  connectionId,
  nowMs = Date.now(),
  ttlMs = SIGNAL_JOIN_DEFAULT_TTL_MS,
  kid,
} = {}) {
  const normalizedRoomId = trimString(roomId);
  const payload = {
    version: SIGNAL_JOIN_TOKEN_VERSION,
    iss: trimString(issuer),
    kid: trimString(kid),
    aud: `signal:${normalizedRoomId}`,
    roomId: normalizedRoomId,
    instanceId: trimString(instanceId),
    clientId: trimString(clientId),
    connectionId: trimString(connectionId),
    jti: `sjt_${randomBytes(18).toString('base64url')}`,
    nbf: nowMs,
    exp: nowMs + ttlMs,
  };
  if (!payload.iss || !payload.kid || !payload.roomId || !payload.instanceId || !payload.clientId || !payload.connectionId) {
    throw new Error('signal join binding is incomplete');
  }
  return { token: issueToken(payload, { privateKey, domain: SIGNAL_JOIN_TOKEN_DOMAIN, prefix: 'sjt1' }), payload };
}

export function verifySignalJoinToken(token, {
  trustedKeys,
  replayStore,
  nowMs = Date.now(),
  expectedIssuer,
  expectedRoomId,
  expectedInstanceId,
  expectedClientId,
  expectedConnectionId,
} = {}) {
  try {
    const parsed = parseToken(token, { prefix: 'sjt1', domain: SIGNAL_JOIN_TOKEN_DOMAIN });
    const key = normalizeKeySet(trustedKeys).get(parsed.payload.kid);
    if (!key || !verifyBytes(
      signatureInput(SIGNAL_JOIN_TOKEN_DOMAIN, parsed.payloadSegment),
      parsed.signature,
      key,
      SIGNAL_JOIN_TOKEN_DOMAIN,
    )) return { valid: false, reason: 'signature invalid' };
    const p = parsed.payload;
    if (p.version !== SIGNAL_JOIN_TOKEN_VERSION || !p.iss || (expectedIssuer && p.iss !== expectedIssuer)) return { valid: false, reason: 'invalid issuer/version' };
    if (expectedRoomId && (p.roomId !== expectedRoomId || p.aud !== `signal:${expectedRoomId}`)) return { valid: false, reason: 'wrong room' };
    if (expectedInstanceId && p.instanceId !== expectedInstanceId) return { valid: false, reason: 'wrong instance' };
    if (expectedClientId && p.clientId !== expectedClientId) return { valid: false, reason: 'wrong client' };
    if (expectedConnectionId && p.connectionId !== expectedConnectionId) return { valid: false, reason: 'wrong connection' };
    if (!validTimeWindow(p, nowMs)) return { valid: false, reason: nowMs < p.nbf ? 'token not yet valid' : 'token expired' };
    if (!replayStore?.consume(p.jti, p.exp, nowMs)) return { valid: false, reason: 'signal token replayed' };
    return { valid: true, token: p };
  } catch (error) {
    return { valid: false, reason: error.message || 'malformed signal token' };
  }
}

export function browserAuthChallenge({ connectionId, instanceId, grantJti, serverNonce }) {
  return [
    'ragent-browser-auth-v1',
    trimString(connectionId),
    trimString(instanceId),
    trimString(grantJti),
    trimString(serverNonce),
  ].join('\n');
}

export function hashJti(jti) {
  return createHash('sha256').update(String(jti || '')).digest('hex').slice(0, 12);
}
