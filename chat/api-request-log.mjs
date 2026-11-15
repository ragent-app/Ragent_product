import { createWriteStream } from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'path';
import { parse as parseUrl } from 'url';
import { API_REQUEST_LOGS_DIR, CHAT_PORT } from '../lib/config.mjs';
import { parseSessionGetRoute } from './session-route-utils.mjs';
import { ensureDir } from './fs-utils.mjs';

let currentDateKey = '';
let currentStream = null;
let loggingDisabled = false;
let nextRequestSeq = 0;
const requestContext = new AsyncLocalStorage();

// Keep a small in-process timing aggregate alongside the durable JSONL log.
// The log is the detailed forensic source; this bounded view is cheap enough
// for health/diagnostics and lets us spot event-loop stalls without reading a
// potentially multi-million-line log on every probe.
const API_METRIC_PHASE_LIMIT = 64;
const API_METRIC_SAMPLE_LIMIT = 512;
const apiRequestMetrics = {
  requests: 0,
  completed: 0,
  aborted: 0,
  errors: 0,
  status5xx: 0,
  totalDurationMs: 0,
  maxDurationMs: 0,
  totalRequestBytes: 0,
  totalResponseBytes: 0,
  lastDurationMs: null,
  lastStatusCode: null,
  phases: new Map(),
};

function formatDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function safeHeaderValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function bytesForChunk(chunk, encoding) {
  if (chunk == null) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined);
  return Buffer.byteLength(String(chunk));
}

function truncate(value, maxLength = 512) {
  const text = typeof value === 'string' ? value : String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function disableLogging(error) {
  if (loggingDisabled) return;
  loggingDisabled = true;
  currentDateKey = '';
  if (currentStream) {
    currentStream.destroy();
    currentStream = null;
  }
  console.error(`[api-log] Disabled API request logging: ${error?.message || error}`);
}

function ensureStream(now = new Date()) {
  if (loggingDisabled) return null;
  const dateKey = formatDateKey(now);
  if (currentStream && currentDateKey === dateKey) {
    return currentStream;
  }
  try {
    const nextPath = join(API_REQUEST_LOGS_DIR, `${dateKey}.jsonl`);
    const nextStream = createWriteStream(nextPath, { flags: 'a', encoding: 'utf8' });
    nextStream.on('error', disableLogging);
    if (currentStream) {
      currentStream.end();
    }
    currentStream = nextStream;
    currentDateKey = dateKey;
    return currentStream;
  } catch (error) {
    disableLogging(error);
    return null;
  }
}

export async function initApiRequestLog() {
  try {
    await ensureDir(API_REQUEST_LOGS_DIR);
  } catch (error) {
    disableLogging(error);
  }
}

function writeRecord(record, timestamp = new Date()) {
  const stream = ensureStream(timestamp);
  if (!stream) return;
  stream.write(`${JSON.stringify(record)}\n`);
}

function classifyApiRoute(method, pathname) {
  const sessionGetRoute = method === 'GET' ? parseSessionGetRoute(pathname) : null;
  if (sessionGetRoute) {
    if (sessionGetRoute.kind === 'list') return 'GET /api/sessions';
    if (sessionGetRoute.kind === 'detail') return 'GET /api/sessions/:sessionId';
    if (sessionGetRoute.kind === 'events') return 'GET /api/sessions/:sessionId/events';
    if (sessionGetRoute.kind === 'event-wait') return 'GET /api/sessions/:sessionId/events/wait';
    if (sessionGetRoute.kind === 'event-delta') return 'GET /api/sessions/:sessionId/events/delta';
    if (sessionGetRoute.kind === 'response') return 'GET /api/sessions/:sessionId/responses/:responseId';
    if (sessionGetRoute.kind === 'event-block') return 'GET /api/sessions/:sessionId/events/blocks/:startSeq-:endSeq';
    if (sessionGetRoute.kind === 'event-body') return 'GET /api/sessions/:sessionId/events/:seq/body';
  }

  if (pathname === '/api/auth/me' && method === 'GET') return 'GET /api/auth/me';
  if (pathname === '/api/models' && method === 'GET') return 'GET /api/models';
  if (pathname === '/api/tools' && method === 'GET') return 'GET /api/tools';
  if (pathname === '/api/tools' && method === 'POST') return 'POST /api/tools';
  if (pathname === '/api/autocomplete' && method === 'GET') return 'GET /api/autocomplete';
  if (pathname === '/api/browse' && method === 'GET') return 'GET /api/browse';
  if (pathname === '/api/push/vapid-public-key' && method === 'GET') return 'GET /api/push/vapid-public-key';
  if (pathname === '/api/push/subscribe' && method === 'POST') return 'POST /api/push/subscribe';
  if (pathname === '/api/runtime-selection' && method === 'POST') return 'POST /api/runtime-selection';
  if (pathname.startsWith('/api/images/') && method === 'GET') return 'GET /api/images/:imageName';
  if (pathname.startsWith('/api/media/') && method === 'GET') return 'GET /api/media/:mediaName';
  if (pathname === '/api/sessions' && method === 'POST') return 'POST /api/sessions';

  if (pathname.startsWith('/api/sessions/')) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] === 'api' && parts[1] === 'sessions') {
      if (parts.length === 3 && method === 'PATCH') return 'PATCH /api/sessions/:sessionId';
      if (parts.length === 4 && method === 'POST') {
        if (parts[3] === 'messages') return 'POST /api/sessions/:sessionId/messages';
        if (parts[3] === 'cancel') return 'POST /api/sessions/:sessionId/cancel';
        if (parts[3] === 'compact') return 'POST /api/sessions/:sessionId/compact';
        if (parts[3] === 'drop-tools') return 'POST /api/sessions/:sessionId/drop-tools';
        if (parts[3] === 'fork') return 'POST /api/sessions/:sessionId/fork';
        if (parts[3] === 'fork-at') return 'POST /api/sessions/:sessionId/fork-at';
        if (parts[3] === 'delegate') return 'POST /api/sessions/:sessionId/delegate';
        if (parts[3] === 'share') return 'POST /api/sessions/:sessionId/share';
      }
    }
  }

  if (pathname.startsWith('/api/runs/')) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'runs' && method === 'GET') {
      return 'GET /api/runs/:runId';
    }
    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'cancel' && method === 'POST') {
      return 'POST /api/runs/:runId/cancel';
    }
  }

  return `${method} ${pathname}`;
}

function isApiRequest(req) {
  const pathname = parseUrl(req.url || '').pathname || '';
  return pathname.startsWith('/api/');
}

function requestBytes(req) {
  const header = req.headers['content-length'];
  const parsed = Number.parseInt(Array.isArray(header) ? header[0] : header || '', 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    message: truncate(error.message || String(error), 300),
    code: error.code || null,
  };
}

function sanitizeCorrelationValue(value) {
  if (typeof value !== 'string') return '';
  return truncate(value.trim(), 160);
}

function sanitizePhaseDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) continue;
    if (typeof value === 'string') {
      result[key] = truncate(value, 160);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = value;
    } else if (typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return result;
}

function appendPhase(context, name, startedHr, details = {}) {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (!normalizedName) return;
  const phase = {
    ...sanitizePhaseDetails(details),
    name: normalizedName,
    durationMs: roundMs(Number(process.hrtime.bigint() - startedHr) / 1e6),
  };
  context.phases.push(phase);
}

function metricPhaseName(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return '';
  // Phase names are source-defined. Keep diagnostics safe even if a future
  // caller accidentally includes a session/run identifier in one.
  return normalized.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 96);
}

function addPhaseSample(bucket, value) {
  if (!bucket || !Number.isFinite(value) || value < 0) return;
  bucket.samples.push(value);
  if (bucket.samples.length > API_METRIC_SAMPLE_LIMIT) {
    bucket.samples.splice(0, bucket.samples.length - API_METRIC_SAMPLE_LIMIT);
  }
}

function percentile(samples, quantile) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * quantile) - 1),
  );
  return roundMs(ordered[index]);
}

function recordApiPhaseMetric(name, durationMs) {
  const normalizedName = metricPhaseName(name);
  const value = Number(durationMs);
  if (!normalizedName || !Number.isFinite(value) || value < 0) return;
  let bucket = apiRequestMetrics.phases.get(normalizedName);
  if (!bucket) {
    if (apiRequestMetrics.phases.size >= API_METRIC_PHASE_LIMIT) return;
    bucket = { count: 0, totalMs: 0, maxMs: 0, samples: [] };
    apiRequestMetrics.phases.set(normalizedName, bucket);
  }
  bucket.count += 1;
  bucket.totalMs += value;
  bucket.maxMs = Math.max(bucket.maxMs, value);
  addPhaseSample(bucket, value);
}

function recordApiRequestMetric(record) {
  const durationMs = Number(record?.durationMs);
  const responseBytes = Number(record?.responseBytes);
  const requestBytes = Number(record?.requestBytes);
  const statusCode = Number(record?.statusCode);
  apiRequestMetrics.requests += 1;
  if (record?.aborted === true) apiRequestMetrics.aborted += 1;
  else apiRequestMetrics.completed += 1;
  if (record?.error) apiRequestMetrics.errors += 1;
  if (Number.isFinite(statusCode) && statusCode >= 500) apiRequestMetrics.status5xx += 1;
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    apiRequestMetrics.totalDurationMs += durationMs;
    apiRequestMetrics.maxDurationMs = Math.max(apiRequestMetrics.maxDurationMs, durationMs);
    apiRequestMetrics.lastDurationMs = durationMs;
  }
  if (Number.isFinite(statusCode)) apiRequestMetrics.lastStatusCode = statusCode;
  if (Number.isFinite(requestBytes) && requestBytes >= 0) apiRequestMetrics.totalRequestBytes += requestBytes;
  if (Number.isFinite(responseBytes) && responseBytes >= 0) apiRequestMetrics.totalResponseBytes += responseBytes;
  for (const phase of Array.isArray(record?.phases) ? record.phases : []) {
    const name = metricPhaseName(phase?.name);
    const phaseMs = Number(phase?.durationMs);
    if (!name || !Number.isFinite(phaseMs) || phaseMs < 0) continue;
    recordApiPhaseMetric(name, phaseMs);
  }
}

/** Bounded, JSON-safe aggregate for /healthz and owner diagnostics. */
export function getApiRequestMetrics({ includePhases = true } = {}) {
  const phases = includePhases
    ? [...apiRequestMetrics.phases.entries()].map(([name, bucket]) => ({
      name,
      count: bucket.count,
      totalMs: roundMs(bucket.totalMs),
      maxMs: roundMs(bucket.maxMs),
      avgMs: bucket.count > 0 ? roundMs(bucket.totalMs / bucket.count) : 0,
      p50Ms: percentile(bucket.samples, 0.5),
      p95Ms: percentile(bucket.samples, 0.95),
      p99Ms: percentile(bucket.samples, 0.99),
    }))
    : undefined;
  return {
    requests: apiRequestMetrics.requests,
    completed: apiRequestMetrics.completed,
    aborted: apiRequestMetrics.aborted,
    errors: apiRequestMetrics.errors,
    status5xx: apiRequestMetrics.status5xx,
    totalDurationMs: roundMs(apiRequestMetrics.totalDurationMs),
    maxDurationMs: roundMs(apiRequestMetrics.maxDurationMs),
    avgDurationMs: apiRequestMetrics.requests > 0
      ? roundMs(apiRequestMetrics.totalDurationMs / apiRequestMetrics.requests)
      : 0,
    totalRequestBytes: apiRequestMetrics.totalRequestBytes,
    totalResponseBytes: apiRequestMetrics.totalResponseBytes,
    lastDurationMs: apiRequestMetrics.lastDurationMs,
    lastStatusCode: apiRequestMetrics.lastStatusCode,
    ...(includePhases ? { phases } : {}),
  };
}

export function __resetApiRequestMetricsForTest() {
  for (const key of [
    'requests', 'completed', 'aborted', 'errors', 'status5xx',
    'totalDurationMs', 'maxDurationMs', 'totalRequestBytes', 'totalResponseBytes',
  ]) apiRequestMetrics[key] = 0;
  apiRequestMetrics.lastDurationMs = null;
  apiRequestMetrics.lastStatusCode = null;
  apiRequestMetrics.phases.clear();
  return getApiRequestMetrics();
}

// Detached preparation and runner phases happen after the HTTP request has
// already finished, so AsyncLocalStorage cannot attach them to the request
// record. Keep them durable and feed the same bounded in-process aggregates.
export function recordApiRequestPhase(name, durationMs, details = {}) {
  const normalizedName = metricPhaseName(name);
  const value = Number(durationMs);
  if (!normalizedName || !Number.isFinite(value) || value < 0) return false;
  const phase = {
    ...sanitizePhaseDetails(details),
    name: normalizedName,
    durationMs: roundMs(value),
  };
  recordApiPhaseMetric(normalizedName, value);
  const correlation = {};
  for (const key of ['requestId', 'sessionId', 'runId']) {
    const safe = sanitizeCorrelationValue(details?.[key]);
    if (safe) correlation[key] = safe;
  }
  writeRecord({
    type: 'api_request_phase',
    pid: process.pid,
    port: CHAT_PORT,
    ts: new Date().toISOString(),
    ...correlation,
    phase,
  });
  return true;
}

export function setApiRequestCorrelation(values = {}) {
  const context = requestContext.getStore();
  if (!context || !values || typeof values !== 'object') return;
  for (const key of ['requestId', 'sessionId', 'runId']) {
    const value = sanitizeCorrelationValue(values[key]);
    if (value) context.correlation[key] = value;
  }
}

// Error handlers run inside the same AsyncLocalStorage scope as the request.
// Expose the generated correlation id so structured error responses can carry
// it even when the caller did not provide X-Ragent-Request-Id.
export function getApiRequestCorrelation() {
  const context = requestContext.getStore();
  return context?.correlation && typeof context.correlation === 'object'
    ? { ...context.correlation }
    : {};
}

export function beginApiRequestPhase(name, details = {}) {
  const context = requestContext.getStore();
  if (!context) return () => {};
  const startedHr = process.hrtime.bigint();
  let finished = false;
  return (completionDetails = {}) => {
    if (finished) return;
    finished = true;
    appendPhase(context, name, startedHr, { ...details, ...completionDetails });
  };
}

export async function measureApiRequestPhase(name, operation, details = {}) {
  const finish = beginApiRequestPhase(name, details);
  try {
    return await operation();
  } finally {
    finish();
  }
}

export function startApiRequestLog(req, res) {
  if (!isApiRequest(req)) {
    return { markError() {}, run(callback) { return callback(); } };
  }

  const requestSeq = ++nextRequestSeq;
  const parsedUrl = parseUrl(req.url || '', true);
  const pathname = parsedUrl.pathname || '';
  const search = parsedUrl.search || '';
  const startedAt = new Date();
  const startedHr = process.hrtime.bigint();
  const bodyBytes = requestBytes(req);
  const suppliedRequestId = sanitizeCorrelationValue(req.headers?.['x-ragent-request-id']);
  const requestId = suppliedRequestId || `http-${process.pid}-${requestSeq}`;

  let responseBytes = 0;
  let responseStartedHr = null;
  let error = null;
  let finished = false;
  const context = {
    correlation: { requestId },
    phases: [],
  };

  // Echo the correlation id so a failed session load can be located directly
  // in the API log without exposing request payloads or cookies.
  if (!res.headersSent) res.setHeader('X-Ragent-Request-Id', requestId);

  const originalWriteHead = res.writeHead.bind(res);
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  function markResponseStart() {
    if (responseStartedHr === null) {
      responseStartedHr = process.hrtime.bigint();
    }
  }

  res.writeHead = function patchedWriteHead(...args) {
    markResponseStart();
    return originalWriteHead(...args);
  };

  res.write = function patchedWrite(chunk, encoding, callback) {
    markResponseStart();
    responseBytes += bytesForChunk(chunk, encoding);
    return originalWrite(chunk, encoding, callback);
  };

  res.end = function patchedEnd(chunk, encoding, callback) {
    markResponseStart();
    responseBytes += bytesForChunk(chunk, encoding);
    return originalEnd(chunk, encoding, callback);
  };

  function flush(aborted) {
    if (finished) return;
    finished = true;
    const finishedHr = process.hrtime.bigint();
    const durationMs = roundMs(Number(finishedHr - startedHr) / 1e6);
    const responseStartMs = responseStartedHr === null ? null : roundMs(Number(responseStartedHr - startedHr) / 1e6);
    const record = {
      type: 'api_request',
      seq: requestSeq,
      pid: process.pid,
      port: CHAT_PORT,
      ts: startedAt.toISOString(),
      method: req.method || 'GET',
      pathname,
      route: classifyApiRoute(req.method || 'GET', pathname),
      search: search ? truncate(search, 512) : '',
      queryKeys: Object.keys(parsedUrl.query || {}).sort(),
      requestBytes: bodyBytes,
      responseBytes,
      statusCode: res.statusCode,
      responseStartMs,
      durationMs,
      cacheHit: res.statusCode === 304,
      contentType: truncate(safeHeaderValue(res.getHeader('Content-Type')), 120),
      cacheControl: truncate(safeHeaderValue(res.getHeader('Cache-Control')), 120),
      aborted,
      error: serializeError(error),
      ...(Object.keys(context.correlation).length > 0 ? context.correlation : {}),
      ...(context.phases.length > 0 ? { phases: context.phases } : {}),
    };
    recordApiRequestMetric(record);
    writeRecord(record, startedAt);
  }

  res.once('finish', () => flush(false));
  res.once('close', () => {
    if (!res.writableFinished) {
      flush(true);
    }
  });

  return {
    run(callback) {
      return requestContext.run(context, callback);
    },
    markError(value) {
      error = value;
    },
  };
}

export function closeApiRequestLog() {
  if (!currentStream) return Promise.resolve();
  const stream = currentStream;
  currentStream = null;
  currentDateKey = '';
  return new Promise((resolve) => {
    stream.end(resolve);
  });
}
