/**
 * Run-scoped capability for local authentication recovery.
 *
 * A detached sidecar cannot use the owner session cookie or CLI socket.  It
 * may ask the control plane to recover only its own Run, and only before that
 * Run has been finalized.  The capability is HMAC signed, short-lived, and
 * bound to the Run/session/turn tuple carried in the request headers.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const RUN_AUTH_RECOVERY_CAPABILITY_VERSION = 'run-auth-recovery/v1';
export const RUN_AUTH_RECOVERY_OPERATION = 'run.auth.recover';
export const RUN_AUTH_RECOVERY_ENDPOINT = '/api/internal/run-auth-recovery';
export const RUN_AUTH_RECOVERY_TOKEN_HEADER = 'x-ragent-run-auth-recovery-token';
export const RUN_AUTH_RECOVERY_RUN_ID_HEADER = 'x-ragent-run-auth-recovery-run-id';
export const RUN_AUTH_RECOVERY_SESSION_ID_HEADER = 'x-ragent-run-auth-recovery-session-id';
export const RUN_AUTH_RECOVERY_TURN_ID_HEADER = 'x-ragent-run-auth-recovery-turn-id';

const DEFAULT_TTL_MS = 15 * 60 * 1000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(value) {
  try {
    const payload = JSON.parse(Buffer.from(trimString(value), 'base64url').toString('utf8'));
    return isObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

function hashToken(value) {
  return createHash('sha256').update(trimString(value), 'utf8').digest('hex');
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(trimString(left), 'utf8');
  const b = Buffer.from(trimString(right), 'utf8');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function parseTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function signPayload(payload, secret) {
  const encoded = encodePayload(payload);
  const signature = createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
  return `rar1.${encoded}.${signature}`;
}

function parseToken(token, secret) {
  const parts = trimString(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'rar1' || !trimString(secret)) return null;
  const supplied = Buffer.from(parts[2], 'utf8');
  const expected = Buffer.from(
    createHmac('sha256', secret).update(parts[1], 'utf8').digest('base64url'),
    'utf8',
  );
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const payload = decodePayload(parts[1]);
  return payload?.version === RUN_AUTH_RECOVERY_CAPABILITY_VERSION
    && payload?.operation === RUN_AUTH_RECOVERY_OPERATION
    ? payload
    : null;
}

export function isStrictLoopbackRequest(req) {
  const remoteAddress = trimString(req?.socket?.remoteAddress || req?.connection?.remoteAddress);
  return remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
}

export function createRunAuthRecoveryCapability({
  runId,
  sessionId,
  turnId,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  secret = process.env.RAGENT_AUTH_SESSION_SECRET || '',
} = {}) {
  const normalizedRunId = trimString(runId);
  const normalizedSessionId = trimString(sessionId);
  const normalizedTurnId = trimString(turnId);
  const issuedAtMs = typeof now === 'number' ? now : Date.parse(now);
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, DEFAULT_TTL_MS) : DEFAULT_TTL_MS;
  if (!normalizedRunId || !normalizedSessionId || !normalizedTurnId
      || !Number.isFinite(issuedAtMs) || !trimString(secret)) return null;

  const payload = {
    version: RUN_AUTH_RECOVERY_CAPABILITY_VERSION,
    operation: RUN_AUTH_RECOVERY_OPERATION,
    selection: {
      runId: normalizedRunId,
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
    },
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + ttl).toISOString(),
    nonce: randomBytes(24).toString('base64url'),
  };
  const token = signPayload(payload, secret);
  return Object.freeze({
    endpoint: RUN_AUTH_RECOVERY_ENDPOINT,
    version: RUN_AUTH_RECOVERY_CAPABILITY_VERSION,
    token,
    tokenHash: hashToken(token),
    runId: normalizedRunId,
    sessionId: normalizedSessionId,
    turnId: normalizedTurnId,
    expiresAt: payload.expiresAt,
  });
}

export function createRunAuthRecoveryAuthenticator({
  secret = process.env.RAGENT_AUTH_SESSION_SECRET || '',
  getRunImpl = async () => null,
  getRunManifestImpl = async () => null,
  now = () => Date.now(),
} = {}) {
  return async function authenticate(req, {
    pathname = req?.url || '',
    method = req?.method || 'GET',
  } = {}) {
    if (pathname !== RUN_AUTH_RECOVERY_ENDPOINT || String(method).toUpperCase() !== 'POST') return null;
    if (!isStrictLoopbackRequest(req)) return null;

    const token = trimString(req?.headers?.[RUN_AUTH_RECOVERY_TOKEN_HEADER]);
    const payload = parseToken(token, secret);
    if (!payload) return null;
    const issuedAt = parseTime(payload.issuedAt);
    const expiresAt = parseTime(payload.expiresAt);
    const nowValue = now();
    const current = typeof nowValue === 'number' ? nowValue : Date.parse(nowValue);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(current)
        || issuedAt > current || current >= expiresAt) return null;

    const runId = trimString(req?.headers?.[RUN_AUTH_RECOVERY_RUN_ID_HEADER]);
    const sessionId = trimString(req?.headers?.[RUN_AUTH_RECOVERY_SESSION_ID_HEADER]);
    const turnId = trimString(req?.headers?.[RUN_AUTH_RECOVERY_TURN_ID_HEADER]);
    const selection = payload.selection || {};
    if (!runId || !sessionId || !turnId
        || runId !== trimString(selection.runId)
        || sessionId !== trimString(selection.sessionId)
        || turnId !== trimString(selection.turnId)) return null;

    const run = await getRunImpl(runId).catch(() => null);
    if (!run || trimString(run.id) !== runId || trimString(run.sessionId) !== sessionId
        || ['completed', 'cancelled'].includes(trimString(run.state))
        || trimString(run.finalizedAt)) return null;
    const manifest = await getRunManifestImpl(runId).catch(() => null);
    const channel = manifest?.options?.runAuthRecoveryChannel;
    if (!manifest || trimString(manifest.sessionId) !== sessionId
        || trimString(manifest.requestId) !== turnId
        || trimString(channel?.runId) !== runId
        || trimString(channel?.sessionId) !== sessionId
        || trimString(channel?.turnId) !== turnId
        || !constantTimeEqual(channel?.tokenHash, hashToken(token))) return null;

    return Object.freeze({
      role: 'runner',
      principalKind: 'run_auth_recovery',
      surfaceMode: 'run_auth_recovery',
      runId,
      sessionId,
      turnId,
      capabilityOperation: RUN_AUTH_RECOVERY_OPERATION,
      capabilityVersion: RUN_AUTH_RECOVERY_CAPABILITY_VERSION,
    });
  };
}

export const authenticateRunAuthRecoveryCapability = createRunAuthRecoveryAuthenticator();

export function hashRunAuthRecoveryToken(value) {
  return hashToken(value);
}
