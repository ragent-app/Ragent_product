/**
 * Run-scoped collaboration control capability.
 *
 * A runner must be able to ask the control plane to create or inspect a
 * bounded collaboration, but it must never receive owner credentials.  This
 * module keeps that boundary explicit:
 *
 *   capability -> exact operation + root session resource + run/turn binding
 *              + policy version + TTL + grant nonce
 *   request    -> server re-reads the Run/manifest and consumes a per-use
 *                 nonce through the durable capability CAS before routing
 *
 * The raw bearer is carried only in the detached Run manifest long enough for
 * the runner to pass it to its provider child.  It is never copied to session
 * history or client projections.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { CONFIG_DIR } from '../lib/config.mjs';
import { resolveSessionCollaborationPolicy } from './collaboration-policy.mjs';
import { getRun, getRunManifest } from './runs.mjs';

export const COLLABORATION_CAPABILITY_VERSION = 'collaboration-capability/v1';
export const COLLABORATION_POLICY_VERSION = 'collaboration-policy/v1';
export const COLLABORATION_CAPABILITY_ENV = 'RAGENT_COLLABORATION_CAPABILITIES';
export const COLLABORATION_CAPABILITY_HEADER = 'authorization';
export const COLLABORATION_CAPABILITY_USE_NONCE_HEADER = 'x-ragent-capability-use-nonce';

const CAPABILITY_TTL_MS = 15 * 60 * 1000;
const READ_USAGE_MAX = 128;
const OPERATIONS = Object.freeze([
  'collaboration.read',
  'collaboration.create',
  'collaboration.dispatch',
  'collaboration.retry',
  'collaboration.cancel',
]);
const ACTION_TO_OPERATION = Object.freeze({
  dispatch: 'collaboration.dispatch',
  retry: 'collaboration.retry',
  cancel: 'collaboration.cancel',
});
const OPERATION_SET = new Set(OPERATIONS);
const COLLABORATION_USAGE_DIR = join(CONFIG_DIR, 'collaboration-capability-usage');
const COLLABORATION_USAGE_SCHEMA = 'collaboration-capability-usage/v1';
const MAX_USE_NONCE_LENGTH = 256;
const USAGE_MAX = 128;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
let usageWriteSequence = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validGrantId(value) {
  return /^cap_collab_[a-f0-9]{36}$/.test(text(value));
}

function usageStatePath(dir, grantId) {
  return join(dir, `${grantId}.json`);
}

function usageLockPath(dir, grantId) {
  return join(dir, `${grantId}.lock`);
}

async function readUsageState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed?.schema !== COLLABORATION_USAGE_SCHEMA
        || !Number.isInteger(parsed.consumed) || parsed.consumed < 0
        || !Array.isArray(parsed.useNonces)
        || parsed.useNonces.length !== parsed.consumed
        || new Set(parsed.useNonces).size !== parsed.useNonces.length
        || parsed.useNonces.some((nonce) => typeof nonce !== 'string')) {
      return null;
    }
    return { consumed: parsed.consumed, useNonces: [...parsed.useNonces] };
  } catch (error) {
    return error?.code === 'ENOENT' ? { consumed: 0, useNonces: [] } : null;
  }
}

async function writeUsageState(path, state) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${usageWriteSequence++}`;
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(join(path, '..'), { recursive: true });
  let handle = null;
  try {
    handle = await open(temporary, 'w', 0o600);
    await handle.writeFile(JSON.stringify({
      schema: COLLABORATION_USAGE_SCHEMA,
      consumed: state.consumed,
      useNonces: state.useNonces,
    }), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function acquireUsageLock(dir, grantId) {
  const lockPath = usageLockPath(dir, grantId);
  const started = Date.now();
  await mkdir(dir, { recursive: true });
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    let handle = null;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
      await handle.close();
      return async () => { await rm(lockPath, { force: true }); };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error?.code !== 'EEXIST') throw error;
      try {
        const lock = JSON.parse(await readFile(lockPath, 'utf8'));
        const stale = Date.now() - Number(lock.createdAt) > LOCK_STALE_MS;
        let live = false;
        if (Number.isInteger(lock.pid) && lock.pid > 0) {
          try { process.kill(lock.pid, 0); live = true; } catch (probeError) { live = probeError?.code === 'EPERM'; }
        }
        if (stale && !live) await rm(lockPath, { force: true });
      } catch {}
      await sleep(10);
    }
  }
  throw new Error('collaboration capability usage lock timed out');
}

function createCollaborationCapabilityUsageStore({ dir = COLLABORATION_USAGE_DIR } = {}) {
  const queueByGrant = new Map();
  let closed = false;
  const runSerialized = async (grantId, task) => {
    const previous = queueByGrant.get(grantId) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    queueByGrant.set(grantId, next);
    try { return await next; } finally {
      if (queueByGrant.get(grantId) === next) queueByGrant.delete(grantId);
    }
  };
  return {
    async inspectGrant({ grantId, usageMax } = {}) {
      const id = text(grantId);
      if (closed || !validGrantId(id) || !Number.isInteger(usageMax) || usageMax < 1 || usageMax > USAGE_MAX) return { ok: false };
      return runSerialized(id, async () => {
        let release;
        try {
          release = await acquireUsageLock(dir, id);
          const state = await readUsageState(usageStatePath(dir, id));
          return { ok: !!state && state.consumed < usageMax };
        } catch { return { ok: false }; }
        finally { if (release) await release().catch(() => {}); }
      });
    },
    async claimGrant({ grantId, useNonce, usageMax, expiresAt, now = Date.now() } = {}) {
      const id = text(grantId);
      const nonce = text(useNonce);
      const max = Number(usageMax);
      const expiry = nowMs(expiresAt);
      const current = nowMs(now);
      if (closed || !validGrantId(id) || !nonce || nonce.length > MAX_USE_NONCE_LENGTH
          || !Number.isInteger(max) || max < 1 || max > USAGE_MAX
          || !Number.isFinite(expiry) || !Number.isFinite(current)) return { ok: false, code: 'CAPABILITY_INVALID' };
      return runSerialized(id, async () => {
        let release;
        try {
          release = await acquireUsageLock(dir, id);
          if (current >= expiry) return { ok: false, code: 'CAPABILITY_EXPIRED' };
          const path = usageStatePath(dir, id);
          const state = await readUsageState(path);
          if (!state) return { ok: false, code: 'CAPABILITY_INVALID' };
          if (state.useNonces.includes(nonce)) return { ok: false, code: 'CAPABILITY_USE_NONCE_REPLAY' };
          if (state.consumed >= max) return { ok: false, code: 'CAPABILITY_USAGE_EXHAUSTED' };
          state.useNonces.push(nonce);
          state.consumed += 1;
          await writeUsageState(path, state);
          return { ok: true, consumed: state.consumed };
        } catch {
          return { ok: false, code: 'CAPABILITY_INVALID' };
        } finally {
          if (release) await release().catch(() => {});
        }
      });
    },
    close() { closed = true; },
  };
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
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
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function signPayload(payload, secret) {
  const encoded = base64urlJson(payload);
  const signature = createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
  return `ac1.${encoded}.${signature}`;
}

function parseToken(token, secret) {
  const parts = text(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'ac1' || !text(secret)) return null;
  const encoded = parts[1];
  const supplied = parts[2];
  const expected = createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (suppliedBytes.length !== expectedBytes.length
      || !timingSafeEqual(suppliedBytes, expectedBytes)) return null;
  const payload = decodeJson(encoded);
  if (!payload || payload.version !== COLLABORATION_CAPABILITY_VERSION) return null;
  return payload;
}

function nowMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function makeGrantId() {
  return `cap_collab_${randomBytes(18).toString('hex')}`;
}

function makeGrantNonce() {
  return randomBytes(24).toString('base64url');
}

function makeUseNonce() {
  return randomBytes(24).toString('base64url');
}

function normalizeOperations(value) {
  const requested = Array.isArray(value) ? value : OPERATIONS;
  return [...new Set(requested.map(text).filter((operation) => OPERATION_SET.has(operation)))];
}

/**
 * Resolve issuance from server-side run context. A role in a prompt or HTTP
 * body never grants this capability.
 */
export function collaborationCapabilityOperationsForRun({ internalOperation = '', policy = null } = {}) {
  if (internalOperation === 'organization_plan_repair') return [];
  if (internalOperation === 'collaboration_task') {
    // Specialist workers can inspect their exact collaboration, but cannot
    // create or mutate collaborations of their own.
    return ['collaboration.read'];
  }
  if (policy?.role === 'manager' && policy?.canDelegate === true) {
    return [...OPERATIONS];
  }
  return [];
}

async function isSessionBoundToRoot(session, rootSessionId, getSessionImpl) {
  const target = text(rootSessionId);
  if (!target || typeof getSessionImpl !== 'function') return false;
  let current = session;
  const visited = new Set();
  for (let depth = 0; current && depth <= 32; depth += 1) {
    const currentId = text(current.id);
    if (!currentId || visited.has(currentId)) return false;
    visited.add(currentId);
    if (currentId === target) return true;
    const parentId = text(current.delegatedFromSessionId || current.parentSessionId);
    if (!parentId) return false;
    current = await getSessionImpl(parentId).catch(() => null);
  }
  return false;
}

/**
 * Build a Run capability from canonical Session/Agent state. This is the
 * narrow integration seam used by session-manager; callers cannot widen the
 * resource or operation set through prompt/request data.
 */
export async function createSessionRunCollaborationCapabilities({
  runId,
  sessionId,
  turnId,
  session,
  internalOperation = '',
  collaborationCapability = null,
  getAppImpl,
  getSessionImpl,
  now = Date.now(),
  secret = process.env.RAGENT_AUTH_SESSION_SECRET || '',
} = {}) {
  const app = text(session?.templateId) && typeof getAppImpl === 'function'
    ? await getAppImpl(session.templateId).catch(() => null)
    : null;
  const policy = resolveSessionCollaborationPolicy(session, app);
  const operations = collaborationCapabilityOperationsForRun({ internalOperation, policy });
  if (operations.length === 0) return null;

  const taskCapability = internalOperation === 'collaboration_task';
  if (taskCapability) {
    if (text(collaborationCapability?.resourceType) !== 'collaboration'
        || !text(collaborationCapability?.resourceId)
        || !await isSessionBoundToRoot(session, collaborationCapability?.rootSessionId, getSessionImpl)) {
      return null;
    }
    return createRunCollaborationCapabilities({
      runId,
      sessionId,
      turnId,
      operations,
      resourceType: 'collaboration',
      resourceId: collaborationCapability.resourceId,
      rootSessionId: collaborationCapability.rootSessionId,
      now,
      secret,
    });
  }

  return createRunCollaborationCapabilities({
    runId,
    sessionId,
    turnId,
    operations,
    resourceType: 'session',
    resourceId: sessionId,
    rootSessionId: sessionId,
    now,
    secret,
  });
}

function capabilityPayload({ operation, runId, sessionId, turnId, resourceType, resourceId, rootSessionId, issuedAtMs, expiresAtMs, grantId, nonce, usageMax }) {
  return {
    version: COLLABORATION_CAPABILITY_VERSION,
    operation,
    resource: {
      type: resourceType || 'session',
      id: resourceId || sessionId,
      ...(rootSessionId ? { rootSessionId } : {}),
    },
    selection: { runId, turnId },
    runnerSessionId: sessionId,
    policyVersion: COLLABORATION_POLICY_VERSION,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    grantId,
    nonce,
    usageMax,
  };
}

function validatePayload(payload, { operation = '', now = Date.now() } = {}) {
  if (!isObject(payload) || payload.version !== COLLABORATION_CAPABILITY_VERSION) return false;
  if (!OPERATION_SET.has(text(payload.operation)) || (operation && payload.operation !== operation)) return false;
  if (payload.policyVersion !== COLLABORATION_POLICY_VERSION) return false;
  if (!isObject(payload.resource)
      || !['session', 'collaboration'].includes(text(payload.resource.type))
      || !text(payload.resource.id)) return false;
  if (!isObject(payload.selection) || !text(payload.selection.runId) || !text(payload.selection.turnId)) return false;
  if (!text(payload.runnerSessionId)) return false;
  if (!/^cap_collab_[a-f0-9]{36}$/.test(text(payload.grantId))) return false;
  if (!text(payload.nonce) || !text(payload.issuedAt) || !text(payload.expiresAt)) return false;
  if (!Number.isInteger(payload.usageMax) || payload.usageMax < 1) return false;
  const issuedAt = nowMs(payload.issuedAt);
  const expiresAt = nowMs(payload.expiresAt);
  const current = nowMs(now);
  return Number.isFinite(issuedAt) && Number.isFinite(expiresAt) && Number.isFinite(current)
    && issuedAt <= current && current < expiresAt;
}

/** Create the manifest-only capability records for a newly allocated Run. */
export function createRunCollaborationCapabilities({
  runId,
  sessionId,
  turnId,
  resourceType = 'session',
  resourceId = '',
  rootSessionId = '',
  now = Date.now(),
  ttlMs = CAPABILITY_TTL_MS,
  secret = process.env.RAGENT_AUTH_SESSION_SECRET || '',
  operations = OPERATIONS,
} = {}) {
  const normalizedRunId = text(runId);
  const normalizedSessionId = text(sessionId);
  const normalizedTurnId = text(turnId);
  const issuedAtMs = nowMs(now);
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : CAPABILITY_TTL_MS;
  if (!normalizedRunId || !normalizedSessionId || !normalizedTurnId || !Number.isFinite(issuedAtMs) || !text(secret)) {
    return null;
  }
  const selectedOperations = normalizeOperations(operations);
  if (selectedOperations.length === 0) return null;
  const expiresAtMs = issuedAtMs + ttl;
  const records = selectedOperations.map((operation) => {
    const payload = capabilityPayload({
      operation,
      runId: normalizedRunId,
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
      resourceType,
      resourceId: text(resourceId) || normalizedSessionId,
      rootSessionId: text(rootSessionId),
      issuedAtMs,
      expiresAtMs,
      grantId: makeGrantId(),
      nonce: makeGrantNonce(),
      usageMax: operation === 'collaboration.read' ? READ_USAGE_MAX : 1,
    });
    const token = signPayload(payload, secret);
    return Object.freeze({
      ...payload,
      token,
      tokenHash: hashToken(token),
    });
  });
  return Object.freeze({
    version: COLLABORATION_CAPABILITY_VERSION,
    capabilities: Object.freeze(records),
    encodedEnvironment: Buffer.from(JSON.stringify(records.map(({ operation, grantId, token }) => ({ operation, grantId, token }))), 'utf8').toString('base64url'),
  });
}

/** Map only the collaboration routes to their server-derived operation. */
export function collaborationCapabilityOperation(pathname, method) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  const normalizedMethod = text(method).toUpperCase();
  if (parts[0] !== 'api' || parts[1] !== 'collaborations') return '';
  if (parts.length === 2 && normalizedMethod === 'GET') return 'collaboration.read';
  if (parts.length === 2 && normalizedMethod === 'POST') return 'collaboration.create';
  if (parts.length === 3 && normalizedMethod === 'GET') return 'collaboration.read';
  if (parts.length === 4 && normalizedMethod === 'POST') return ACTION_TO_OPERATION[parts[3]] || '';
  return '';
}

export function collaborationCapabilityResource(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'collaborations') return '';
  if (parts.length < 3) return '';
  try { return decodeURIComponent(parts[2]); } catch { return ''; }
}

function bearerToken(req) {
  const value = text(req?.headers?.authorization);
  return value.toLowerCase().startsWith('bearer ') ? text(value.slice(7)) : '';
}

function constantTimeHexEqual(left, right) {
  const a = Buffer.from(text(left), 'utf8');
  const b = Buffer.from(text(right), 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function decodeEnvironment(value) {
  try {
    const parsed = JSON.parse(Buffer.from(text(value), 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Build an authenticator. Injected dependencies make the security contract
 * independently testable without starting chat-server.
 */
export function createCollaborationCapabilityAuthenticator({
  secret = process.env.RAGENT_AUTH_SESSION_SECRET || '',
  store = createCollaborationCapabilityUsageStore(),
  getRunImpl = getRun,
  getRunManifestImpl = getRunManifest,
  now = () => Date.now(),
} = {}) {
  return async function authenticate(req, { pathname = req?.url || '', method = req?.method || 'GET' } = {}) {
    const operation = collaborationCapabilityOperation(pathname, method);
    const token = bearerToken(req);
    if (!operation || !token) return null;
    const payload = parseToken(token, secret);
    if (!validatePayload(payload, { operation, now: now() })) return null;

    const runId = text(payload.selection.runId);
    const sessionId = text(payload.runnerSessionId);
    const run = await getRunImpl(runId).catch(() => null);
    if (!run || text(run.sessionId) !== sessionId || ['completed', 'failed', 'cancelled'].includes(text(run.state))) return null;
    const manifest = await getRunManifestImpl(runId).catch(() => null);
    const currentTurnId = text(manifest?.requestId);
    if (!manifest || currentTurnId !== text(payload.selection.turnId)
        || text(payload.runnerSessionId) !== text(run.sessionId)) return null;
    const requestedResourceId = collaborationCapabilityResource(pathname);
    if (requestedResourceId && text(payload.resource.type) === 'collaboration'
        && text(payload.resource.id) !== requestedResourceId) return null;
    const manifestCapabilities = Array.isArray(manifest?.options?.collaborationCapabilities)
      ? manifest.options.collaborationCapabilities : [];
    const bound = manifestCapabilities.find((entry) => (
      entry?.operation === operation
      && entry?.grantId === payload.grantId
      && constantTimeHexEqual(entry?.tokenHash, hashToken(token))
    ));
    if (!bound) return null;

    const useNonce = text(req?.headers?.[COLLABORATION_CAPABILITY_USE_NONCE_HEADER]);
    if (!useNonce || useNonce.length > 256) return null;
    const claim = await store.claimGrant({
      grantId: payload.grantId,
      useNonce,
      usageMax: payload.usageMax,
      expiresAt: payload.expiresAt,
      now: now(),
    });
    if (!claim?.ok) return null;
    return Object.freeze({
      role: 'runner',
      principalKind: 'run_capability',
      surfaceMode: 'run_capability',
      sessionId,
      runId,
      capabilityOperation: operation,
      resourceType: text(payload.resource.type),
      resourceId: text(payload.resource.id),
      rootSessionId: text(payload.resource.rootSessionId),
      capabilityVersion: payload.version,
      capabilityNonce: payload.nonce,
      policyVersion: payload.policyVersion,
    });
  };
}

export const authenticateCollaborationCapability = createCollaborationCapabilityAuthenticator();

const organizationGrantUsage = createCollaborationCapabilityUsageStore();

// Server-side renewal remains bound to the original signed grant and usage
// ledger. It does not mint a second bearer or reset the one-use allowance.
export async function authorizeRootOrganizationCreate({ session, runId, turnId, consume = false, marker = false, dispatch = false } = {}) {
  const { withLockedRunAuthorization } = await import('./runs.mjs');
  const { getApp } = await import('./apps.mjs');
  const { getSession } = await import('./session-manager.mjs');
  const deny = () => Object.assign(new Error('Organization planning is not authorized for this Run'), { code: 'ORG_PLAN_FORBIDDEN', statusCode: 403 });
  return withLockedRunAuthorization(runId, async (run, manifest) => {
    const now = Date.now();
    const terminal = ['completed', 'failed', 'cancelled'].includes(text(run?.state));
    if (!run || !manifest || manifest.internalOperation === 'organization_plan_repair' || run.sessionId !== session?.id || manifest.sessionId !== session.id ||
        text(manifest.requestId) !== text(turnId) || (terminal && !(marker && run.state === 'completed'))) throw deny();
    const channel = manifest.options?.sessionControlChannel;
    if (!terminal && (!channel || text(channel.runId) !== runId || text(channel.sessionId) !== session.id ||
        text(channel.turnId) !== text(turnId) || !text(channel.tokenHash) || now >= nowMs(channel.expiresAt))) throw deny();
    const currentSession = await getSession(session.id);
    if (!currentSession || currentSession.sessionClass !== 'ROOT_LEADERSHIP' || (currentSession.sessionPlane || 'user') !== 'user' ||
        currentSession.userAddressable === false || currentSession.parentSessionId || currentSession.delegatedFromSessionId) throw deny();
    const app = currentSession.templateId ? await getApp(currentSession.templateId) : null;
    const policy = resolveSessionCollaborationPolicy(currentSession, app);
    if (!collaborationCapabilityOperationsForRun({ policy }).includes('collaboration.create') ||
        Number(currentSession.delegationDepth || 0) > Number(policy.maxDepth)) throw deny();
    const operation = dispatch ? 'collaboration.dispatch' : 'collaboration.create';
    const record = (manifest.options?.collaborationCapabilities || []).find((cap) => cap.operation === operation);
    const signed = record && parseToken(record.token, process.env.RAGENT_AUTH_SESSION_SECRET || '');
    const issued = nowMs(signed?.issuedAt);
    if (!signed || !validatePayload(signed, { operation, now: issued }) ||
        !constantTimeHexEqual(record.tokenHash, hashToken(record.token)) || signed.grantId !== record.grantId ||
        signed.runnerSessionId !== session.id || signed.resource?.type !== 'session' || signed.resource.id !== session.id || signed.resource.rootSessionId !== session.id ||
        signed.selection?.runId !== runId || signed.selection?.turnId !== turnId || signed.usageMax !== 1) throw deny();
    // A completed marker may use only its original unexpired authorization.
    const expiry = terminal ? nowMs(signed.expiresAt) : nowMs(channel.expiresAt);
    if (!Number.isFinite(expiry) || now >= expiry) throw deny();
    // Dispatch is repeatable across distinct frozen phases; the Run-bound signed
    // grant proves authority while the phase dispatcher owns idempotency.
    if (dispatch) return { grantId: signed.grantId };
    const result = consume
      ? await organizationGrantUsage.claimGrant({ grantId: signed.grantId, useNonce: makeUseNonce(), usageMax: signed.usageMax, expiresAt: expiry, now })
      : await organizationGrantUsage.inspectGrant({ grantId: signed.grantId, usageMax: signed.usageMax });
    if (!result.ok) throw deny();
    return { grantId: signed.grantId };
  });
}

export function buildCapabilityUseNonce() {
  return makeUseNonce();
}

export function parseCapabilityEnvironment(value) {
  return decodeEnvironment(value);
}

export function verifyCollaborationCapabilityToken(token, { secret, operation = '', now = Date.now() } = {}) {
  const payload = parseToken(token, secret);
  return validatePayload(payload, { operation, now }) ? payload : null;
}
