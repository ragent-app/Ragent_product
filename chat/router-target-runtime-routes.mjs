// Web-side target-runtime gateway. The browser calls this local endpoint;
// only this server talks to Accounts and the selected remote instance.
import { readBody } from '../lib/utils.mjs';
import { randomUUID } from 'node:crypto';
import {
  authorizeOwnerAccountTargetRuntime,
  getOwnerAccountBinding,
  listOwnerAccountDevices,
} from '../lib/owner-account-auth.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import {
  createLocalTargetRuntimeContext,
  normalizeTargetCatalog,
} from '../lib/target-runtime-contract.mjs';
import {
  getTargetRuntimeRevision,
  getTargetRuntimeSummaryEvents,
} from '../lib/target-runtime-state.mjs';
import { classifyTargetRuntimeRequest, normalizeTargetRuntimePath } from '../lib/target-runtime-policy.mjs';
import { createTargetRuntimeSummary } from './target-runtime-summary.mjs';

const MAX_PROXY_BODY_BYTES = 8 * 1024 * 1024;
const REMOTE_REQUEST_TIMEOUT_MS = 15 * 1000;
const REMOTE_SUMMARY_REQUEST_TIMEOUT_MS = 3 * 1000;
const REMOTE_SUMMARY_FAILURE_COOLDOWN_MS = 30 * 1000;
const REMOTE_SUMMARY_MAX_COOLDOWN_MS = 300 * 1000;
const REMOTE_SUMMARY_COOLDOWN_STEPS_MS = Object.freeze([30 * 1000, 60 * 1000, 120 * 1000, REMOTE_SUMMARY_MAX_COOLDOWN_MS]);
const OFFLINE_SUMMARY_CODES = new Set([
  'TARGET_RUNTIME_UNAVAILABLE',
  'TARGET_RUNTIME_TIMEOUT',
  'TARGET_RUNTIME_SUMMARY_COOLDOWN',
]);
const remoteSummaryInflight = new Map();
const remoteSummaryStateByTarget = new Map();

export function __resetTargetRuntimeSummaryStateForTest() {
  remoteSummaryStateByTarget.clear();
  remoteSummaryInflight.clear();
}

function text(value, max = 2048) {
  return (typeof value === 'string' ? value.trim() : '').slice(0, max);
}

function json(value) {
  return JSON.stringify(value);
}

function gatewayError(code, message, statusCode = 503, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function requestIdentity(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function requireOwner(authSession, res, writeJson) {
  if (authSession?.role === 'owner' && authSession?.principalKind !== 'run_capability') return true;
  writeJson(res, 403, { error: 'Owner access required', code: 'OWNER_REQUIRED' });
  return false;
}

function safeEndpoint(value) {
  try {
    const parsed = new URL(text(value));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function localTarget(identity, snapshotVersion) {
  return createLocalTargetRuntimeContext(identity, { snapshotVersion }).target;
}

function accountDeviceTarget(device) {
  if (text(device?.deviceKind, 32) !== 'computer' || !text(device?.instanceId, 160)) return null;
  const endpoint = safeEndpoint(device.endpoint);
  return {
    schemaVersion: 1,
    targetId: text(device.instanceId, 160),
    instanceId: text(device.instanceId, 160),
    deviceKind: 'computer',
    label: text(device.alias, 128) || text(device.instanceId, 160),
    platform: text(device.platform, 32),
    status: endpoint ? 'paired' : 'offline',
    runtimeVersion: '',
    capabilities: ['sessions', 'runs', 'approvals', 'projects', 'files', 'triggers', 'usage'],
    snapshotVersion: 0,
    lastSeenAt: text(device.lastSeenAt, 64),
  };
}

function writeProxyResponse(res, response, body, revision) {
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': response.headers.get('cache-control') || 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    ...(response.headers.get('etag') ? { ETag: response.headers.get('etag') } : {}),
    ...(response.headers.get('retry-after') ? { 'Retry-After': response.headers.get('retry-after') } : {}),
    ...(revision !== undefined && revision !== null ? { 'X-Ragent-Target-Revision': String(revision) } : {}),
  };
  res.writeHead(response.status, headers);
  res.end(body);
}

async function readRemoteResponse(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_PROXY_BODY_BYTES) {
    throw gatewayError('TARGET_RUNTIME_RESPONSE_TOO_LARGE', 'Target runtime response is too large.', 502);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_PROXY_BODY_BYTES) {
    throw gatewayError('TARGET_RUNTIME_RESPONSE_TOO_LARGE', 'Target runtime response is too large.', 502);
  }
  return body;
}

export async function proxyToTarget({ targetId, requestId, idempotencyKey, method, path, operation, resourceId, expectedRevision, expiresAt, body, headers, timeoutMs = REMOTE_REQUEST_TIMEOUT_MS, fetchImpl = globalThis.fetch, authorizeImpl = authorizeOwnerAccountTargetRuntime }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  const boundedFetch = (url, options = {}) => fetchImpl(url, { ...options, signal: controller.signal });
  let response;
  try {
    const authorization = await authorizeImpl({
      targetInstanceId: targetId,
      requestId,
      idempotencyKey,
      method,
      path,
      operation,
      resourceId,
      expectedRevision,
      expiresAt,
      fetchImpl: boundedFetch,
    });
    const endpoint = safeEndpoint(authorization?.target?.endpoint);
    if (!endpoint || !text(authorization?.grant, 256)) {
      throw gatewayError('TARGET_RUNTIME_UNAVAILABLE', 'Target runtime has no safe endpoint.', 503);
    }
    const targetUrl = new URL(path, `${endpoint}/`);
    if (targetUrl.origin !== new URL(endpoint).origin) {
      throw gatewayError('TARGET_RUNTIME_ENDPOINT_INVALID', 'Target runtime endpoint is invalid.', 502);
    }
    response = await boundedFetch(targetUrl, {
      method,
      headers: {
        Accept: text(headers?.accept, 256) || 'application/json',
        ...(text(headers?.['content-type'], 256) ? { 'Content-Type': text(headers['content-type'], 256) } : {}),
        ...(text(headers?.['if-none-match'], 512) ? { 'If-None-Match': text(headers['if-none-match'], 512) } : {}),
        'X-Ragent-Target-Grant': authorization.grant,
        'X-Ragent-Target-Source': text(authorization?.claims?.sourceInstanceId, 160),
      },
      ...(body !== undefined && body !== null && method !== 'GET' ? { body } : {}),
    });
  } catch (error) {
    if (error?.statusCode) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw gatewayError('TARGET_RUNTIME_TIMEOUT', 'Target runtime request timed out.', 504);
    }
    throw gatewayError('TARGET_RUNTIME_UNAVAILABLE', 'Target runtime is unavailable.', 503);
  } finally {
    clearTimeout(timeout);
  }
  const responseBody = await readRemoteResponse(response);
  return { response, body: responseBody };
}

function summaryCooldownError(targetId, retryAfterMs) {
  return gatewayError(
    'TARGET_RUNTIME_SUMMARY_COOLDOWN',
    'Target runtime summary is temporarily suppressed after a transport failure.',
    503,
    { targetId, retryAfterMs },
  );
}

function getSummaryTargetState(summaryState, targetId) {
  let state = summaryState.get(targetId);
  if (!state) {
    state = {
      failureCount: 0,
      unavailableUntil: 0,
      lastCode: '',
      lastMessage: '',
      endpointless: false,
      cachedSummary: null,
      cachedCursor: null,
    };
    summaryState.set(targetId, state);
  }
  return state;
}

function nextSummaryCooldownMs(failureCount) {
  const index = Math.max(0, Math.min(REMOTE_SUMMARY_COOLDOWN_STEPS_MS.length - 1, failureCount - 1));
  return REMOTE_SUMMARY_COOLDOWN_STEPS_MS[index];
}

function recordSummaryFailure(state, now, {
  code = 'TARGET_RUNTIME_UNAVAILABLE',
  message = 'Target runtime is unavailable.',
  endpointless = false,
} = {}) {
  if (state.unavailableUntil <= now) {
    state.failureCount += 1;
    state.unavailableUntil = now + nextSummaryCooldownMs(state.failureCount);
  }
  state.lastCode = code;
  state.lastMessage = message;
  if (endpointless) state.endpointless = true;
  return Math.max(1, state.unavailableUntil - now);
}

function resetSummaryReachable(state) {
  state.failureCount = 0;
  state.unavailableUntil = 0;
  state.lastCode = '';
  state.lastMessage = '';
  state.endpointless = false;
}

function tryParseJsonBuffer(body) {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cacheSuccessfulSummaryResponse(state, targetId, kind, response, body, now) {
  if (response.status !== 304 && !response.ok) return;
  resetSummaryReachable(state);
  if (!response.ok) return;
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('json')) return;
  const parsed = tryParseJsonBuffer(body);
  if (!parsed) return;
  if (kind === 'summary') {
    state.cachedSummary = parsed;
    if (parsed.eventCursor !== undefined && parsed.eventCursor !== null) {
      state.cachedCursor = String(parsed.eventCursor);
    } else if (parsed.cursor !== undefined && parsed.cursor !== null) {
      state.cachedCursor = String(parsed.cursor);
    }
    return;
  }
  if (parsed.cursor !== undefined && parsed.cursor !== null) {
    state.cachedCursor = String(parsed.cursor);
  }
  if (Array.isArray(parsed.events)) {
    for (const event of parsed.events) {
      if (event?.summary && typeof event.summary === 'object' && !Array.isArray(event.summary)) {
        state.cachedSummary = {
          schemaVersion: 1,
          targetId,
          instanceId: text(event.instanceId, 160) || targetId,
          revision: Number.isSafeInteger(Number(event.revision))
            ? Number(event.revision)
            : (state.cachedSummary?.revision ?? 0),
          eventCursor: String(event.cursor ?? parsed.cursor ?? state.cachedCursor ?? '0'),
          generatedAt: event.emittedAt || new Date(now).toISOString(),
          ...event.summary,
        };
      }
    }
  }
}

function isOfflineSummaryError(error) {
  if (!error) return false;
  if (OFFLINE_SUMMARY_CODES.has(error.code)) return true;
  return error.statusCode === 503 || error.statusCode === 504;
}

function isEndpointlessCatalogTarget(target, providedCatalog) {
  if (!target) return false;
  if (target.hasEndpoint === false || target.endpoint === '') return true;
  return !providedCatalog && target.status === 'offline';
}

function buildDegradedSummaryResponse(target, state, { code, message, retryAfterMs }) {
  const cached = state.cachedSummary && typeof state.cachedSummary === 'object'
    ? state.cachedSummary
    : null;
  return {
    ...(cached || {}),
    schemaVersion: cached?.schemaVersion ?? 1,
    targetId: target.targetId,
    instanceId: cached?.instanceId || target.instanceId || target.targetId,
    revision: cached?.revision ?? (Number(target.snapshotVersion) || 0),
    eventCursor: cached?.eventCursor ?? state.cachedCursor ?? '0',
    reachable: false,
    degraded: true,
    state: 'offline',
    retryable: true,
    retryAfterMs,
    code,
    ...(state.endpointless ? { endpointless: true } : {}),
    error: message,
  };
}

function buildDegradedSummaryEventsResponse(target, state, { afterCursor, code, message, retryAfterMs }) {
  const cached = state.cachedSummary && typeof state.cachedSummary === 'object'
    ? state.cachedSummary
    : null;
  return {
    schemaVersion: 1,
    targetId: target.targetId,
    revision: cached?.revision ?? (Number(target.snapshotVersion) || 0),
    cursor: state.cachedCursor ?? String(afterCursor ?? '0'),
    nextCursor: null,
    hasMore: false,
    events: [],
    ...(cached ? { cachedSummary: cached } : {}),
    reachable: false,
    degraded: true,
    state: 'offline',
    retryable: true,
    retryAfterMs,
    code,
    ...(state.endpointless ? { endpointless: true } : {}),
    error: message,
  };
}

function handleSummaryRouteError({
  res,
  writeJson,
  error,
  target,
  targetId,
  summaryState,
  now,
  fallbackMessage,
  buildDegradedBody,
}) {
  if (target && isOfflineSummaryError(error)) {
    const state = getSummaryTargetState(summaryState, targetId);
    const retryAfterMs = Number(error?.details?.retryAfterMs)
      || (state.unavailableUntil > now ? Math.max(1, state.unavailableUntil - now) : REMOTE_SUMMARY_FAILURE_COOLDOWN_MS);
    writeJson(res, 200, buildDegradedBody(target, state, {
      code: error.code || 'TARGET_RUNTIME_UNAVAILABLE',
      message: error.message || fallbackMessage,
      retryAfterMs,
    }));
    return;
  }
  writeJson(res, error.statusCode || 503, {
    error: error.message || fallbackMessage,
    code: error.code || 'TARGET_RUNTIME_UNAVAILABLE',
    targetId,
    state: 'offline',
    retryable: true,
    ...(error.details && typeof error.details === 'object' ? { details: error.details } : {}),
  });
}

async function proxySummaryToTarget(options) {
  const targetId = text(options?.targetId, 160);
  const requestKey = text(options?.requestKey, 320) || 'summary';
  const kind = options?.summaryKind === 'events' ? 'events' : 'summary';
  const clock = typeof options?.clock === 'function' ? options.clock : Date.now;
  const summaryState = options?.summaryState instanceof Map ? options.summaryState : remoteSummaryStateByTarget;
  const state = getSummaryTargetState(summaryState, targetId);
  const key = `${targetId}:${requestKey}`;
  const now = clock();
  if (state.unavailableUntil > now) {
    throw summaryCooldownError(targetId, Math.max(1, state.unavailableUntil - now));
  }
  if (options?.endpointless) {
    const retryAfterMs = recordSummaryFailure(state, now, {
      code: 'TARGET_RUNTIME_UNAVAILABLE',
      message: 'Target runtime has no safe endpoint.',
      endpointless: true,
    });
    throw gatewayError('TARGET_RUNTIME_UNAVAILABLE', 'Target runtime has no safe endpoint.', 503, {
      targetId,
      retryAfterMs,
      endpointless: true,
    });
  }
  const existing = remoteSummaryInflight.get(key);
  if (existing) return existing;

  const request = (async () => {
    try {
      const result = await proxyToTarget({
        ...options,
        timeoutMs: REMOTE_SUMMARY_REQUEST_TIMEOUT_MS,
      });
      if ([502, 503, 504].includes(result.response.status)) {
        throw gatewayError(
          result.response.status === 504 ? 'TARGET_RUNTIME_TIMEOUT' : 'TARGET_RUNTIME_UNAVAILABLE',
          result.response.status === 504
            ? 'Target runtime request timed out.'
            : 'Target runtime is unavailable.',
          result.response.status === 504 ? 504 : 503,
        );
      }
      cacheSuccessfulSummaryResponse(state, targetId, kind, result.response, result.body, clock());
      return result;
    } catch (error) {
      if (isOfflineSummaryError(error) && error.code !== 'TARGET_RUNTIME_SUMMARY_COOLDOWN') {
        const retryAfterMs = recordSummaryFailure(state, clock(), {
          code: error.code || 'TARGET_RUNTIME_UNAVAILABLE',
          message: error.message || 'Target runtime is unavailable.',
          endpointless: /no safe endpoint/i.test(String(error.message || '')),
        });
        error.details = { ...(error.details || {}), targetId, retryAfterMs };
      }
      throw error;
    } finally {
      remoteSummaryInflight.delete(key);
    }
  })();
  remoteSummaryInflight.set(key, request);
  return request;
}

async function proxySummaryEventsToTarget(options) {
  const afterCursor = String(options?.afterCursor ?? '0');
  return proxySummaryToTarget({
    ...options,
    summaryKind: 'events',
    requestKey: `events:${afterCursor}`,
  });
}

async function readGatewayRequest(req) {
  const raw = await readBody(req, MAX_PROXY_BODY_BYTES);
  try { return raw ? JSON.parse(raw) : {}; } catch { throw gatewayError('TARGET_RUNTIME_REQUEST_INVALID', 'Target runtime request body is invalid.', 400); }
}

function decodeGatewayBody(payload) {
  if (typeof payload?.body === 'string') return payload.body;
  if (typeof payload?.bodyBase64 !== 'string' || !payload.bodyBase64) return null;
  const normalized = payload.bodyBase64.trim();
  if (!/^[A-Za-z0-9+/=_-]+$/.test(normalized)) {
    throw gatewayError('TARGET_RUNTIME_REQUEST_INVALID', 'Target runtime request body encoding is invalid.', 400);
  }
  const body = Buffer.from(normalized.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (body.length > MAX_PROXY_BODY_BYTES) throw gatewayError('TARGET_RUNTIME_REQUEST_TOO_LARGE', 'Target runtime request body is too large.', 413);
  return body;
}

async function buildCatalog({ identity: providedIdentity = null, listDevices = listOwnerAccountDevices, revisionReader = getTargetRuntimeRevision } = {}) {
  const identity = providedIdentity || await loadOrCreateInstanceIdentity();
  const revision = await revisionReader();
  const local = localTarget(identity, revision);
  let directory = null;
  try { directory = await listDevices(); } catch (error) {
    const catalog = normalizeTargetCatalog({ revision, targets: [local], activeTargetId: local.targetId });
    return { ...catalog, accounts: { status: 'unavailable', code: text(error?.code, 96) || 'ACCOUNTS_UNAVAILABLE' } };
  }
  const targets = [local, ...(Array.isArray(directory?.devices) ? directory.devices.map(accountDeviceTarget).filter(Boolean) : [])]
    .filter((target, index, all) => all.findIndex((entry) => entry.targetId === target.targetId) === index);
  return normalizeTargetCatalog({ revision, targets, activeTargetId: local.targetId });
}

export async function handleTargetRuntimeGatewayRoutes({
  req,
  res,
  pathname,
  parsedUrl,
  authSession,
  writeJson,
  fetchImpl = globalThis.fetch,
  authorizeImpl = authorizeOwnerAccountTargetRuntime,
  identity: providedIdentity = null,
  catalog: providedCatalog = null,
  clock = Date.now,
  summaryState = remoteSummaryStateByTarget,
} = {}) {
  if (!pathname?.startsWith('/api/target-runtime/')) return false;
  if (!requireOwner(authSession, res, writeJson)) return true;

  if (pathname === '/api/target-runtime/catalog' && req.method === 'GET') {
    try { writeJson(res, 200, await buildCatalog({ identity: providedIdentity })); } catch (error) {
      writeJson(res, error.statusCode || 503, { error: error.message, code: error.code || 'TARGET_CATALOG_UNAVAILABLE' });
    }
    return true;
  }

  if (pathname === '/api/target-runtime/summary' && req.method === 'GET') {
    const targetId = text(parsedUrl?.query?.targetId, 160);
    if (!targetId) { writeJson(res, 400, { error: 'targetId is required', code: 'TARGET_ID_REQUIRED' }); return true; }
    const identity = providedIdentity || await loadOrCreateInstanceIdentity();
    if (targetId === identity.instanceId) {
      try { writeJson(res, 200, await createTargetRuntimeSummary({ identity })); } catch (error) {
        writeJson(res, error.statusCode || 500, { error: error.message, code: error.code || 'TARGET_SUMMARY_FAILED' });
      }
      return true;
    }
    let target = null;
    try {
      target = (providedCatalog || await buildCatalog({ identity })).targets.find((entry) => entry.targetId === targetId);
      if (!target) throw gatewayError('TARGET_NOT_FOUND', 'Target runtime was not found.', 404);
      if (target.status === 'revoked') throw gatewayError('TARGET_REVOKED', 'Target runtime has been revoked.', 403);
      const expectedRevision = Number(target.snapshotVersion) || 0;
      const path = '/api/runtime/summary';
      const { response, body } = await proxySummaryToTarget({
        targetId,
        requestId: requestIdentity(`summary_${targetId}`),
        idempotencyKey: requestIdentity(`summary_${targetId}`),
        method: 'GET',
        path,
        operation: 'runtime.summary',
        resourceId: targetId,
        expectedRevision,
        expiresAt: new Date(clock() + 20_000).toISOString(),
        fetchImpl,
        authorizeImpl,
        clock,
        summaryState,
        endpointless: isEndpointlessCatalogTarget(target, providedCatalog),
      });
      writeProxyResponse(res, response, body, response.headers.get('x-ragent-target-revision'));
    } catch (error) {
      handleSummaryRouteError({
        res,
        writeJson,
        error,
        target,
        targetId,
        summaryState,
        now: clock(),
        fallbackMessage: 'Target runtime is unavailable.',
        buildDegradedBody: buildDegradedSummaryResponse,
      });
    }
    return true;
  }

  if (pathname === '/api/target-runtime/summary/events' && req.method === 'GET') {
    const targetId = text(parsedUrl?.query?.targetId, 160);
    if (!targetId) {
      writeJson(res, 400, { error: 'targetId is required', code: 'TARGET_ID_REQUIRED' });
      return true;
    }
    const identity = providedIdentity || await loadOrCreateInstanceIdentity();
    const afterCursor = parsedUrl?.query?.afterCursor ?? parsedUrl?.query?.cursor ?? '0';
    const limit = parsedUrl?.query?.limit ?? '100';
    if (targetId === identity.instanceId) {
      try {
        writeJson(res, 200, await getTargetRuntimeSummaryEvents({ afterCursor, limit }));
      } catch (error) {
        writeJson(res, error.statusCode || 400, { error: error.message, code: error.code || 'TARGET_SUMMARY_EVENTS_FAILED' });
      }
      return true;
    }
    let target = null;
    try {
      target = (providedCatalog || await buildCatalog({ identity })).targets.find((entry) => entry.targetId === targetId);
      if (!target) throw gatewayError('TARGET_NOT_FOUND', 'Target runtime was not found.', 404);
      if (target.status === 'revoked') throw gatewayError('TARGET_REVOKED', 'Target runtime has been revoked.', 403);
      const query = new URLSearchParams({ afterCursor: String(afterCursor), limit: String(limit) });
      const { response, body } = await proxySummaryEventsToTarget({
        targetId,
        afterCursor,
        requestId: `summary-events_${targetId}_${afterCursor}`,
        idempotencyKey: `summary-events_${targetId}_${afterCursor}`,
        method: 'GET',
        path: `/api/runtime/summary/events?${query.toString()}`,
        operation: 'runtime.summary',
        resourceId: targetId,
        expectedRevision: Number(target.snapshotVersion) || 0,
        expiresAt: new Date(clock() + 20_000).toISOString(),
        fetchImpl,
        authorizeImpl,
        clock,
        summaryState,
        endpointless: isEndpointlessCatalogTarget(target, providedCatalog),
      });
      writeProxyResponse(res, response, body, response.headers.get('x-ragent-target-revision'));
    } catch (error) {
      handleSummaryRouteError({
        res,
        writeJson,
        error,
        target,
        targetId,
        summaryState,
        now: clock(),
        fallbackMessage: 'Target runtime summary events are unavailable',
        buildDegradedBody: (t, s, info) => buildDegradedSummaryEventsResponse(t, s, { afterCursor, ...info }),
      });
    }
    return true;
  }

  if (pathname === '/api/target-runtime/request' && req.method === 'POST') {
    try {
      const payload = await readGatewayRequest(req);
      const targetId = text(payload.targetId, 160);
      const method = text(payload.method, 16).toUpperCase();
      const path = normalizeTargetRuntimePath(payload.path);
      const operation = text(payload.operation, 96);
      const policy = classifyTargetRuntimeRequest(method, path);
      const expectedRevision = Number(payload.expectedRevision);
      const resourceId = text(payload.resourceId, 160);
      if (!targetId || !policy || policy.method !== method || policy.operation !== operation
        || policy.path !== path || !resourceId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw gatewayError('TARGET_RUNTIME_REQUEST_INVALID', 'Target runtime command is invalid.', 400);
      }
      const identity = providedIdentity || await loadOrCreateInstanceIdentity();
      if (targetId === identity.instanceId) throw gatewayError('TARGET_RUNTIME_LOCAL_USE_DIRECT', 'Local target requests must use the local API.', 400);
      const catalog = providedCatalog || await buildCatalog({ identity });
      const target = catalog.targets.find((entry) => entry.targetId === targetId);
      if (!target) throw gatewayError('TARGET_NOT_FOUND', 'Target runtime was not found.', 404);
      if (target.status === 'revoked') throw gatewayError('TARGET_REVOKED', 'Target runtime has been revoked.', 403);
      const body = decodeGatewayBody(payload);
      const { response, body: responseBody } = await proxyToTarget({
        targetId,
        requestId: text(payload.requestId, 160),
        idempotencyKey: text(payload.idempotencyKey, 160),
        method,
        path,
        operation,
        resourceId,
        expectedRevision,
        expiresAt: text(payload.expiresAt, 64) || new Date(Date.now() + 50_000).toISOString(),
        body,
        headers: payload.headers && typeof payload.headers === 'object' ? payload.headers : {},
        fetchImpl,
        authorizeImpl,
      });
      writeProxyResponse(res, response, responseBody, response.headers.get('x-ragent-target-revision'));
    } catch (error) {
      writeJson(res, error.statusCode || 503, {
        error: error.message || 'Target runtime request failed.',
        code: error.code || 'TARGET_RUNTIME_REQUEST_FAILED',
        ...(error.details && typeof error.details === 'object' ? { details: error.details } : {}),
      });
    }
    return true;
  }

  writeJson(res, 404, { error: 'Target runtime route not found', code: 'TARGET_RUNTIME_ROUTE_NOT_FOUND' });
  return true;
}
