/**
 * Run-scoped control capabilities for detached providers.
 *
 * The operation capability is deliberately short-lived. A separate renewal
 * capability can only mint a replacement operation capability; it never
 * authenticates a business route by itself.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { getRun, getRunManifest } from './runs.mjs';

export const SESSION_CONTROL_CAPABILITY_VERSION = 'session-control-capability/v2';
export const LEGACY_SESSION_CONTROL_CAPABILITY_VERSION = 'session-control-capability/v1';
export const SESSION_CONTROL_CAPABILITY_ENDPOINT = '/api/internal/session-control';
export const SESSION_CONTROL_RENEWAL_ENDPOINT = '/api/internal/session-control/renew';
export const SESSION_CONTROL_RENEWAL_VERSION = 'session-control-renewal/v1';
export const SESSION_CONTROL_RENEWAL_OPERATION = 'session-control.renew';
export const SESSION_CONTROL_CAPABILITY_HEADER = 'x-ragent-session-control-token';
export const SESSION_CONTROL_RENEWAL_TOKEN_HEADER = 'x-ragent-session-control-renewal-token';
export const SESSION_CONTROL_RUN_ID_HEADER = 'x-ragent-session-control-run-id';
export const SESSION_CONTROL_SESSION_ID_HEADER = 'x-ragent-session-control-session-id';
export const SESSION_CONTROL_TURN_ID_HEADER = 'x-ragent-session-control-turn-id';
export const SESSION_CONTROL_CAPABILITY_TOKEN_FILE = 'session-control.cap';
export const SESSION_CONTROL_RENEWAL_TOKEN_FILE = 'session-control-renewal.cap';
export const SESSION_CONTROL_CAPABILITY_TTL_MS = 15 * 60 * 1000;
export const SESSION_CONTROL_RENEWAL_COMPAT_WINDOW_MS = 5 * 60 * 1000;
export const SESSION_CONTROL_MAX_RUN_LIFETIME_MS = 24 * 60 * 60 * 1000;

const OPERATIONS = Object.freeze([
  'session.auth.read',
  'session.delegate',
  'session.run.read',
  'session.events.read',
  'session.trigger.read',
  'session.trigger.create',
  'session.trigger.update',
  'session.trigger.delete',
  'session.process.read',
  'session.process.create',
  'session.process.cancel',
  'session.consultation.manage',
  'session.asset.publish',
  'session.assistant_message.publish',
]);
const NODE_MESSAGE_OPERATIONS = Object.freeze(['organization.message.ack', 'organization.message.reply']);
const REVIEW_OPERATION = 'factory.review.submit';
const BLOCKER_OPERATION = 'factory.blocker.propose';
const NODE_OPERATIONS = Object.freeze([...NODE_MESSAGE_OPERATIONS, REVIEW_OPERATION, BLOCKER_OPERATION]);
const OPERATION_SET = new Set([...OPERATIONS, ...NODE_OPERATIONS]);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

export const SESSION_CONTROL_ERROR_CODES = Object.freeze({
  EXPIRED: 'SESSION_CONTROL_CAPABILITY_EXPIRED',
  INVALID: 'SESSION_CONTROL_CAPABILITY_INVALID',
  REVOKED: 'SESSION_CONTROL_CAPABILITY_REVOKED',
  RENEWAL_EXPIRED: 'SESSION_CONTROL_RENEWAL_EXPIRED',
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function validMessageScope(scope) {
  if (!scope || scope.kind !== 'organization_message' || !text(scope.organizationId) || !text(scope.nodeId) || !Number.isInteger(scope.bindingGeneration) || scope.bindingGeneration < 1 || !Number.isInteger(scope.organizationRevision) || scope.organizationRevision < 0) return false;
  if (scope.reviewOpinionAllowed === true && (!text(scope.workItemId) || !text(scope.reviewCandidate?.workItemId) || !/^[a-f0-9]{64}$/.test(scope.reviewCandidate?.digest || '') || !Number.isInteger(scope.reviewCandidate?.contractRevision) || scope.reviewCandidate.contractRevision < 1 || !Number.isInteger(scope.reviewCandidate?.executionEpoch) || scope.reviewCandidate.executionEpoch < 1)) return false;
  if (scope.workItemId || scope.managedSessionId || scope.attemptId || scope.executionEpoch !== undefined) {
    return !!text(scope.workItemId) && !!text(scope.managedSessionId) && !!text(scope.attemptId) && Number.isInteger(scope.executionEpoch) && scope.executionEpoch > 0;
  }
  return true;
}

// Paired owner devices submit turns as trusted_device, rather than owner.
// Temporary control and delegated/internal sessions must not inherit this grant.
export function canIssueSessionControl({ principalKind, session, temporaryControlAuthority, internalOperation } = {}) {
  return ['owner', 'trusted_device'].includes(text(principalKind))
    && !temporaryControlAuthority
    && text(session?.sessionClass) === 'ROOT_LEADERSHIP'
    && text(session?.sessionPlane || 'user') === 'user'
    && !text(session?.delegatedFromSessionId)
    && !internalOperation;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(value) {
  try {
    const parsed = JSON.parse(Buffer.from(text(value), 'base64url').toString('utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function signPayload(payload, secret, prefix) {
  const encoded = base64urlJson(payload);
  const signature = createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
  return `${prefix}.${encoded}.${signature}`;
}

function parseSignedToken(token, secret, prefixes = []) {
  const parts = text(token).split('.');
  if (parts.length !== 3 || !prefixes.includes(parts[0]) || !text(secret)) {
    return { payload: null, signatureValid: false };
  }
  const supplied = Buffer.from(parts[2], 'utf8');
  const expected = Buffer.from(createHmac('sha256', secret).update(parts[1], 'utf8').digest('base64url'), 'utf8');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { payload: null, signatureValid: false };
  }
  return { payload: decodeJson(parts[1]), signatureValid: true, prefix: parts[0] };
}

function nowMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function hashToken(value) {
  return createHash('sha256').update(text(value), 'utf8').digest('hex');
}

function constantTimeHexEqual(left, right) {
  const a = Buffer.from(text(left), 'utf8');
  const b = Buffer.from(text(right), 'utf8');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function tokenHashMatches(channel, token) {
  const hash = hashToken(token);
  const accepted = [
    channel?.tokenHash,
    ...(Array.isArray(channel?.tokenHashes) ? channel.tokenHashes : []),
  ].filter(Boolean);
  return accepted.some((candidate) => constantTimeHexEqual(candidate, hash));
}

function hasFullKnownOperationSet(payload) {
  return Array.isArray(payload?.operations)
    && payload.operations.length === OPERATIONS.length
    && payload.operations.every((entry) => OPERATION_SET.has(text(entry)))
    && OPERATIONS.every((operation) => payload.operations.includes(operation));
}

function capabilityPayload({ runId, sessionId, turnId, issuedAtMs, expiresAtMs, scope }) {
  return {
    version: SESSION_CONTROL_CAPABILITY_VERSION,
    operations: scope ? [...NODE_MESSAGE_OPERATIONS, ...(scope.reviewOpinionAllowed === true && scope.workItemId ? [REVIEW_OPERATION] : []), ...(scope.blockerProposalAllowed === true && scope.workItemId ? [BLOCKER_OPERATION] : [])] : [...OPERATIONS],
    ...(scope ? { organizationMessageScope: scope } : {}),
    resource: { type: 'session_tree', id: sessionId },
    selection: { runId, turnId },
    runnerSessionId: sessionId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    nonce: randomBytes(24).toString('base64url'),
  };
}

function renewalPayload({ runId, sessionId, turnId, issuedAtMs, expiresAtMs, scope }) {
  return {
    version: SESSION_CONTROL_RENEWAL_VERSION,
    operation: SESSION_CONTROL_RENEWAL_OPERATION,
    selection: { runId, sessionId, turnId },
    ...(scope ? { organizationMessageScope: scope } : {}),
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    nonce: randomBytes(24).toString('base64url'),
  };
}

export function sessionControlOperation(pathname, method) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  const normalizedMethod = text(method).toUpperCase();
  if (parts.length === 5 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'factory' && parts[4] === 'blocker-proposal' && normalizedMethod === 'POST') return BLOCKER_OPERATION;
  if (parts.length === 5 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'factory' && parts[4] === 'review-opinion' && normalizedMethod === 'POST') return REVIEW_OPERATION;
  if (parts.length === 7 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'organization' && parts[4] === 'messages' && normalizedMethod === 'POST') {
    if (parts[6] === 'ack') return 'organization.message.ack';
    if (parts[6] === 'reply') return 'organization.message.reply';
  }
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'me'
      && normalizedMethod === 'GET') return 'session.auth.read';
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'triggers' && normalizedMethod === 'GET') return 'session.trigger.read';
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'triggers' && normalizedMethod === 'POST') return 'session.trigger.create';
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'triggers' && normalizedMethod === 'GET') return 'session.trigger.read';
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'triggers' && normalizedMethod === 'PATCH') return 'session.trigger.update';
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'triggers' && normalizedMethod === 'DELETE') return 'session.trigger.delete';
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'managed-processes' && normalizedMethod === 'GET') return 'session.process.read';
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'managed-processes' && normalizedMethod === 'GET') return 'session.process.read';
  if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'managed-processes'
      && parts[3] === 'cancel' && normalizedMethod === 'POST') return 'session.process.cancel';
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'managed-processes' && normalizedMethod === 'DELETE') return 'session.process.cancel';
  if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions'
      && parts[3] === 'managed-processes' && normalizedMethod === 'POST') return 'session.process.create';
  if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions'
      && parts[3] === 'delegate' && normalizedMethod === 'POST') return 'session.delegate';
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'runs'
      && normalizedMethod === 'GET') return 'session.run.read';
  if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions'
      && parts[3] === 'events' && normalizedMethod === 'GET') return 'session.events.read';
  if (parts.length === 6 && parts[0] === 'api' && parts[1] === 'sessions'
      && parts[3] === 'events' && parts[5] === 'body' && normalizedMethod === 'GET') return 'session.events.read';
  if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions'
      && parts[3] === 'assets' && normalizedMethod === 'POST') return 'session.asset.publish';
  if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions'
      && parts[3] === 'assistant-messages' && normalizedMethod === 'POST') {
    return 'session.assistant_message.publish';
  }
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'consultations'
      && normalizedMethod === 'POST') return 'session.consultation.manage';
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'consultations'
      && normalizedMethod === 'GET') return 'session.consultation.manage';
  if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'consultations'
      && ['dispatch', 'decide', 'cancel'].includes(parts[3])
      && normalizedMethod === 'POST') return 'session.consultation.manage';
  if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'consultations'
      && parts[3] === 'decisions' && normalizedMethod === 'GET') {
    return 'session.consultation.manage';
  }
  return '';
}

export function createRunSessionControlCapability({
  runId,
  sessionId,
  turnId,
  now = Date.now(),
  ttlMs = SESSION_CONTROL_CAPABILITY_TTL_MS,
  maxExpiresAtMs = Infinity,
  secret = process.env.RAGENT_AUTH_SESSION_SECRET || '',
  scope = null,
} = {}) {
  const normalizedRunId = text(runId);
  const normalizedSessionId = text(sessionId);
  const normalizedTurnId = text(turnId);
  const issuedAtMs = nowMs(now);
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : SESSION_CONTROL_CAPABILITY_TTL_MS;
  const absoluteExpiry = Number.isFinite(maxExpiresAtMs) ? maxExpiresAtMs : Infinity;
  const expiresAtMs = Math.min(issuedAtMs + ttl, absoluteExpiry);
  if (scope && !validMessageScope(scope)) return null;
  if (!normalizedRunId || !normalizedSessionId || !normalizedTurnId
      || !Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)
      || expiresAtMs <= issuedAtMs || !text(secret)) return null;
  const token = signPayload(capabilityPayload({
    runId: normalizedRunId,
    sessionId: normalizedSessionId,
    turnId: normalizedTurnId,
    issuedAtMs,
    expiresAtMs,
    scope,
  }), secret, 'sc2');
  return Object.freeze({
    endpoint: SESSION_CONTROL_CAPABILITY_ENDPOINT,
    version: SESSION_CONTROL_CAPABILITY_VERSION,
    token,
    tokenHash: hashToken(token),
    turnId: normalizedTurnId,
    runId: normalizedRunId,
    sessionId: normalizedSessionId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    ...(scope ? { scope } : {}),
  });
}

export function createRunSessionControlRenewalCapability({
  runId,
  sessionId,
  turnId,
  now = Date.now(),
  runCreatedAt = now,
  maxLifetimeMs = SESSION_CONTROL_MAX_RUN_LIFETIME_MS,
  secret = process.env.RAGENT_AUTH_SESSION_SECRET || '',
  scope = null,
} = {}) {
  const normalizedRunId = text(runId);
  const normalizedSessionId = text(sessionId);
  const normalizedTurnId = text(turnId);
  const issuedAtMs = nowMs(now);
  const createdAtMs = nowMs(runCreatedAt);
  const lifetime = Number.isFinite(maxLifetimeMs) && maxLifetimeMs > 0
    ? maxLifetimeMs : SESSION_CONTROL_MAX_RUN_LIFETIME_MS;
  const expiresAtMs = createdAtMs + lifetime;
  if (scope && !validMessageScope(scope)) return null;
  if (!normalizedRunId || !normalizedSessionId || !normalizedTurnId
      || !Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)
      || expiresAtMs <= issuedAtMs || !text(secret)) return null;
  const token = signPayload(renewalPayload({
    runId: normalizedRunId,
    sessionId: normalizedSessionId,
    turnId: normalizedTurnId,
    issuedAtMs,
    expiresAtMs,
    scope,
  }), secret, 'scr1');
  return Object.freeze({
    endpoint: SESSION_CONTROL_RENEWAL_ENDPOINT,
    version: SESSION_CONTROL_RENEWAL_VERSION,
    operation: SESSION_CONTROL_RENEWAL_OPERATION,
    token,
    tokenHash: hashToken(token),
    turnId: normalizedTurnId,
    runId: normalizedRunId,
    sessionId: normalizedSessionId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
}

async function isSessionInRoot(sessionId, rootSessionId, getSessionImpl) {
  const target = text(sessionId);
  const root = text(rootSessionId);
  if (!target || !root || typeof getSessionImpl !== 'function') return false;
  let current = await getSessionImpl(target).catch(() => null);
  const visited = new Set();
  for (let depth = 0; current && depth <= 32; depth += 1) {
    const currentId = text(current.id);
    if (!currentId || visited.has(currentId)) return false;
    if (currentId === root) return true;
    visited.add(currentId);
    current = await getSessionImpl(text(current.delegatedFromSessionId || current.parentSessionId)).catch(() => null);
  }
  return false;
}

function invalidResult(code = SESSION_CONTROL_ERROR_CODES.INVALID, message = 'Session-control capability is invalid') {
  return { principal: null, errorCode: code, error: message, attempted: true };
}

async function authenticateSessionControlDetailed(req, {
  pathname = req?.url || '',
  method = req?.method || 'GET',
  secret = process.env.RAGENT_AUTH_SESSION_SECRET || '',
  getRunImpl = getRun,
  getRunManifestImpl = getRunManifest,
  getSessionImpl,
  now = () => Date.now(),
} = {}) {
  const operation = sessionControlOperation(pathname, method);
  if (!operation) return { principal: null, errorCode: '', attempted: false };
  const token = text(req?.headers?.[SESSION_CONTROL_CAPABILITY_HEADER]);
  if (!token) return { principal: null, errorCode: '', attempted: false };
  const { payload, signatureValid } = parseSignedToken(token, secret, ['sc1', 'sc2']);
  if (!signatureValid || !payload
      || ![LEGACY_SESSION_CONTROL_CAPABILITY_VERSION, SESSION_CONTROL_CAPABILITY_VERSION].includes(payload.version)
      || !Array.isArray(payload.operations) || !payload.operations.includes(operation)
      || payload.operations.some((entry) => !OPERATION_SET.has(text(entry)))) {
    return invalidResult();
  }
  const issuedAt = nowMs(payload.issuedAt);
  const expiresAt = nowMs(payload.expiresAt);
  const current = nowMs(now());
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(current)
      || issuedAt > current) return invalidResult();

  const runId = text(req?.headers?.[SESSION_CONTROL_RUN_ID_HEADER]);
  const rootSessionId = text(req?.headers?.[SESSION_CONTROL_SESSION_ID_HEADER]);
  const turnId = text(req?.headers?.[SESSION_CONTROL_TURN_ID_HEADER]);
  if (!runId || !rootSessionId || !turnId
      || runId !== text(payload.selection?.runId)
      || rootSessionId !== text(payload.runnerSessionId)
      || turnId !== text(payload.selection?.turnId)) return invalidResult();

  const run = await getRunImpl(runId).catch(() => null);
  if (!run || text(run.sessionId) !== rootSessionId) return invalidResult();
  if (TERMINAL_STATES.has(text(run.state))) {
    return invalidResult(SESSION_CONTROL_ERROR_CODES.REVOKED, 'Session-control capability is revoked');
  }
  if (current >= expiresAt) {
    return invalidResult(SESSION_CONTROL_ERROR_CODES.EXPIRED, 'Session-control capability has expired');
  }

  const manifest = await getRunManifestImpl(runId).catch(() => null);
  const channel = manifest?.options?.sessionControlChannel;
  if (!manifest || text(manifest.sessionId) !== rootSessionId
      || (channel?.runId && text(channel.runId) !== runId)
      || (channel?.sessionId && text(channel.sessionId) !== rootSessionId)
      || text(channel?.turnId) !== turnId
      || !tokenHashMatches(channel, token)) {
    return invalidResult(SESSION_CONTROL_ERROR_CODES.REVOKED, 'Session-control capability is revoked');
  }
  if (payload.version === SESSION_CONTROL_CAPABILITY_VERSION
      && channel.version && channel.version !== SESSION_CONTROL_CAPABILITY_VERSION) {
    return invalidResult(SESSION_CONTROL_ERROR_CODES.REVOKED, 'Session-control capability is revoked');
  }

  const parts = String(pathname || '').split('/').filter(Boolean);
  let targetSessionId = rootSessionId;
  if (NODE_OPERATIONS.includes(operation)) {
    if (decodeURIComponent(parts[2] || '') !== rootSessionId || !validMessageScope(payload.organizationMessageScope)
        || JSON.stringify(channel.scope) !== JSON.stringify(payload.organizationMessageScope)
        || (operation === REVIEW_OPERATION && payload.organizationMessageScope.reviewOpinionAllowed !== true)
        || (operation === BLOCKER_OPERATION && payload.organizationMessageScope.blockerProposalAllowed !== true)) return invalidResult();
  } else if (operation === 'session.delegate' || operation === 'session.process.create') {
    if (decodeURIComponent(parts[2] || '') !== rootSessionId) return invalidResult();
  } else if ([
    'session.auth.read',
    'session.trigger.read',
    'session.trigger.create',
    'session.trigger.update',
    'session.trigger.delete',
    'session.process.read',
    'session.process.cancel',
    'session.consultation.manage',
  ].includes(operation)) {
    targetSessionId = rootSessionId;
  } else if (operation === 'session.run.read') {
    const targetRun = await getRunImpl(decodeURIComponent(parts[2] || '')).catch(() => null);
    if (!targetRun || !await isSessionInRoot(targetRun.sessionId, rootSessionId, getSessionImpl)) return invalidResult();
    targetSessionId = text(targetRun.sessionId);
  } else if (operation === 'session.asset.publish'
      || operation === 'session.assistant_message.publish') {
    targetSessionId = decodeURIComponent(parts[2] || '');
    if (targetSessionId !== rootSessionId) return invalidResult();
  } else {
    targetSessionId = decodeURIComponent(parts[2] || '');
    if (!await isSessionInRoot(targetSessionId, rootSessionId, getSessionImpl)) return invalidResult();
  }
  return {
    principal: Object.freeze({
      role: 'runner',
      principalKind: 'run_capability',
      surfaceMode: 'session_control',
      sessionId: targetSessionId,
      rootSessionId,
      runId,
      turnId,
      capabilityOperation: operation,
      resourceType: 'session_tree',
      capabilityVersion: payload.version,
      ...(NODE_OPERATIONS.includes(operation) ? { organizationMessageScope: payload.organizationMessageScope } : {}),
    }),
    errorCode: '',
    attempted: true,
  };
}

export function createSessionControlAuthenticator(options = {}) {
  return async function authenticate(req, requestOptions = {}) {
    const result = await authenticateSessionControlDetailed(req, { ...options, ...requestOptions });
    return result.principal || null;
  };
}

export function createSessionControlDetailedAuthenticator(options = {}) {
  return async function authenticateDetailed(req, requestOptions = {}) {
    return authenticateSessionControlDetailed(req, { ...options, ...requestOptions });
  };
}

export function isStrictLoopbackRequest(req) {
  const remoteAddress = text(req?.socket?.remoteAddress || req?.connection?.remoteAddress);
  return remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
}

export function createSessionControlRenewalAuthenticator({
  secret = process.env.RAGENT_AUTH_SESSION_SECRET || '',
  getRunImpl = getRun,
  getRunManifestImpl = getRunManifest,
  now = () => Date.now(),
} = {}) {
  return async function authenticate(req, {
    pathname = req?.url || '',
    method = req?.method || 'GET',
  } = {}) {
    if (pathname !== SESSION_CONTROL_RENEWAL_ENDPOINT || String(method).toUpperCase() !== 'POST') {
      return { principal: null, errorCode: '', attempted: false };
    }
    if (!isStrictLoopbackRequest(req)) {
      return invalidResult(SESSION_CONTROL_ERROR_CODES.INVALID, 'Session-control renewal is local-only');
    }
    const token = text(req?.headers?.[SESSION_CONTROL_RENEWAL_TOKEN_HEADER]);
    if (!token) return { principal: null, errorCode: SESSION_CONTROL_ERROR_CODES.INVALID, attempted: true };
    const parsed = parseSignedToken(token, secret, ['scr1', 'sc1', 'sc2']);
    if (!parsed.signatureValid || !parsed.payload) return invalidResult();
    const payload = parsed.payload;
    const runId = text(req?.headers?.[SESSION_CONTROL_RUN_ID_HEADER]);
    const sessionId = text(req?.headers?.[SESSION_CONTROL_SESSION_ID_HEADER]);
    const turnId = text(req?.headers?.[SESSION_CONTROL_TURN_ID_HEADER]);
    const selection = payload.selection || {};
    const selectedSessionId = payload.version === LEGACY_SESSION_CONTROL_CAPABILITY_VERSION
      ? payload.runnerSessionId
      : selection.sessionId;
    if (!runId || !sessionId || !turnId
        || runId !== text(selection.runId)
        || sessionId !== text(selectedSessionId)
        || turnId !== text(selection.turnId)) return invalidResult();

    const issuedAt = nowMs(payload.issuedAt);
    const expiresAt = nowMs(payload.expiresAt);
    const current = nowMs(now());
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(current)
        || issuedAt > current) return invalidResult();
    const run = await getRunImpl(runId).catch(() => null);
    if (!run || text(run.id) !== runId || text(run.sessionId) !== sessionId) return invalidResult();
    if (TERMINAL_STATES.has(text(run.state))) {
      return invalidResult(SESSION_CONTROL_ERROR_CODES.REVOKED, 'Session-control renewal is revoked');
    }
    const manifest = await getRunManifestImpl(runId).catch(() => null);
    const channel = manifest?.options?.sessionControlChannel;
    if (!manifest || text(manifest.sessionId) !== sessionId
        || (channel?.runId && text(channel.runId) !== runId)
        || (channel?.sessionId && text(channel.sessionId) !== sessionId)
        || text(channel?.turnId) !== turnId) {
      return invalidResult(SESSION_CONTROL_ERROR_CODES.REVOKED, 'Session-control renewal is revoked');
    }

    if (parsed.prefix === 'scr1'
        && payload.version === SESSION_CONTROL_RENEWAL_VERSION
        && payload.operation === SESSION_CONTROL_RENEWAL_OPERATION) {
      if (!Number.isFinite(expiresAt) || current >= expiresAt) {
        return invalidResult(SESSION_CONTROL_ERROR_CODES.RENEWAL_EXPIRED, 'Session-control renewal has expired');
      }
      if (!channel.renewalTokenHash || !constantTimeHexEqual(channel.renewalTokenHash, hashToken(token))) {
        return invalidResult(SESSION_CONTROL_ERROR_CODES.REVOKED, 'Session-control renewal is revoked');
      }
      if (JSON.stringify(payload.organizationMessageScope || null) !== JSON.stringify(channel.scope || null)) return invalidResult();
      return {
        principal: Object.freeze({
          role: 'runner',
          principalKind: 'session_control_renewal',
          surfaceMode: 'session_control_renewal',
          runId,
          sessionId,
          turnId,
          capabilityOperation: SESSION_CONTROL_RENEWAL_OPERATION,
          capabilityVersion: SESSION_CONTROL_RENEWAL_VERSION,
        }),
        errorCode: '',
        attempted: true,
      };
    }

    // Upgrade window for Runs created before v2. The old operation capability
    // is accepted only after expiry, only for this one renewal route, and only
    // while the manifest has no renewal credential of its own.
    if (payload.version !== LEGACY_SESSION_CONTROL_CAPABILITY_VERSION
        || parsed.prefix !== 'sc1' || channel.renewalTokenHash
        || !hasFullKnownOperationSet(payload)
        || !tokenHashMatches(channel, token)) return invalidResult();
    if (current < expiresAt) return invalidResult();
    if (current >= expiresAt + SESSION_CONTROL_RENEWAL_COMPAT_WINDOW_MS) {
      return invalidResult(SESSION_CONTROL_ERROR_CODES.RENEWAL_EXPIRED, 'Session-control renewal compatibility window has expired');
    }
    return {
      principal: Object.freeze({
        role: 'runner',
        principalKind: 'session_control_legacy_renewal',
        surfaceMode: 'session_control_renewal',
        runId,
        sessionId,
        turnId,
        capabilityOperation: SESSION_CONTROL_RENEWAL_OPERATION,
        capabilityVersion: LEGACY_SESSION_CONTROL_CAPABILITY_VERSION,
        legacy: true,
      }),
      errorCode: '',
      attempted: true,
    };
  };
}

export const authenticateSessionControlCapability = createSessionControlAuthenticator();

export function hashSessionControlToken(value) {
  return hashToken(value);
}

// Kept private to the capability protocol, but exported for deterministic
// tests and for manifest canonicalization callers.
export function canonicalSessionControlJson(value) {
  return canonicalJson(value);
}
