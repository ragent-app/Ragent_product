/**
 * Background AI operation ledger (DS-03).
 *
 * Structured, append-only, daily-rotated JSONL ledger for background LLM
 * calls (task-card / workflow-state / label / memory-writeback suggestions).
 * Every tracked call gets an operationId; lifecycle events (enqueue,
 * started, succeeded, failed, skipped, timeout, retry) are recorded with
 * provider, model, attempt, duration, result, classified error code and
 * optional usage.
 *
 * Safety rules (hard, structural):
 *   - The full prompt or real message bodies are NEVER written. Only
 *     promptLength / promptHash (sha256 prefix) / promptPreview (≤120 chars)
 *     are recorded.
 *   - Error payloads are reduced to a classified errorCode plus a truncated
 *     message (≤200 chars). No stacks, no env, no credentials.
 *
 * Error classification (DS-03/DS-04 contract): auth, timeout, transport,
 * input, provider_exit, unsupported, rate_limit, unknown.
 *
 * Storage: RAGENT_OPERATION_LEDGER_DIR override, default
 * <usage-ledger>/operations/YYYY-MM-DD.jsonl. The directory is created
 * lazily on first write, so the module works without an explicit init in
 * tests and small tools.
 */

import { createHash } from 'crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import readline from 'readline';

import { USAGE_LEDGER_DIR } from '../lib/config.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 1;
const MAX_PREVIEW_CHARS = 120;
const MAX_ERROR_MESSAGE_CHARS = 200;
const HASH_PREFIX_CHARS = 12;

export const OPERATION_EVENT_KINDS = Object.freeze([
  'enqueue',
  'started',
  'succeeded',
  'failed',
  'skipped',
  'timeout',
  'retry',
]);

export const OPERATION_ERROR_CODES = Object.freeze([
  'auth',
  'timeout',
  'transport',
  'input',
  'provider_exit',
  'unsupported',
  'rate_limit',
  'unknown',
]);

let currentDateKey = '';
let currentStream = null;
let loggingDisabled = false;
let operationSequence = 0;
let ledgerDirReady = false;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveOperationLedgerDir(value = '') {
  return trimString(value) || process.env.RAGENT_OPERATION_LEDGER_DIR || join(USAGE_LEDGER_DIR, 'operations');
}

function formatDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeTimestampMs(value) {
  const timestampMs = Date.parse(value || '');
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function pickNonNegativeInt(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function pickFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function disableLogging(error) {
  if (loggingDisabled) return;
  loggingDisabled = true;
  currentDateKey = '';
  if (currentStream) {
    currentStream.destroy();
    currentStream = null;
  }
  console.error(`[operation-ledger] Disabled operation ledger writes: ${error?.message || error}`);
}

// One-time synchronous mkdir on first write (same pragmatic trade as
// run-launcher.mjs / session-folder.mjs): avoids an async init-ordering race
// in tests and CLI tools while keeping the write path simple.
function ensureLedgerDir() {
  if (ledgerDirReady) return true;
  try {
    mkdirSync(resolveOperationLedgerDir(), { recursive: true });
    ledgerDirReady = true;
    return true;
  } catch (error) {
    disableLogging(error);
    return false;
  }
}

function ensureStream(now = new Date()) {
  if (loggingDisabled) return null;
  if (!ensureLedgerDir()) return null;
  const dateKey = formatDateKey(now);
  if (currentStream && currentDateKey === dateKey) {
    return currentStream;
  }
  try {
    const nextPath = join(resolveOperationLedgerDir(), `${dateKey}.jsonl`);
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

/**
 * Safe prompt metadata: length + hash + short preview. Never the full text.
 */
export function buildSafePromptMeta(text) {
  const prompt = typeof text === 'string' ? text : '';
  if (!prompt) {
    return { promptLength: 0, promptHash: '', promptPreview: '' };
  }
  const hash = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const preview = prompt.length <= MAX_PREVIEW_CHARS
    ? prompt
    : `${prompt.slice(0, MAX_PREVIEW_CHARS - 1).trimEnd()}…`;
  return {
    promptLength: prompt.length,
    promptHash: hash.slice(0, HASH_PREFIX_CHARS),
    promptPreview: preview,
  };
}

function matchesErrorText(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Classify an error (Error object, message string, or numeric exit code)
 * into one of the DS-03 error codes.
 *
 * @param {*} value Error / string / exit code.
 * @param {{ context?: 'spawn'|'call'|'http'|'file' }} options Context hint:
 *   'spawn' treats ENOENT as transport (tool binary missing); 'file' never
 *   classifies filesystem codes as transport.
 */
export function classifyProviderError(value, options = {}) {
  const context = options.context || 'call';
  if (Number.isInteger(value)) {
    return value !== 0 ? 'provider_exit' : 'unknown';
  }
  const error = value instanceof Error ? value : null;
  const message = trimString(error?.message || (typeof value === 'string' ? value : ''));
  const code = trimString(error?.code || (typeof value === 'object' && value !== null ? value.code : ''));
  const combined = `${message}\n${code}`.toLowerCase();

  if (matchesErrorText(combined, [
    /\b401\b/, /\b403\b/, /unauthor/i, /forbidden/, /invalid api key/, /invalid key/,
    /authentication/, /permission denied/, /credentials?/i, /auth_token/i,
  ])) {
    return 'auth';
  }
  if (matchesErrorText(combined, [
    /\b429\b/, /rate ?limit/i, /too many requests/i, /quota/i,
  ])) {
    return 'rate_limit';
  }
  if (matchesErrorText(combined, [
    /\b405\b/, /\b404\b/, /unsupported/i, /not implemented/i, /not supported/i,
    /unknown model/i, /model not found/i, /invalid model/i,
  ])) {
    return 'unsupported';
  }
  if (matchesErrorText(combined, [
    /timeout/i, /timed ?out/i, /deadline/i, /etimedout/i, /timeouterror/i,
  ])) {
    return 'timeout';
  }
  if (matchesErrorText(combined, [
    /null ?byte/i, /\beinval\b/, /\be2big\b/, /prompt too large/i, /too large/i,
    /invalid json/i, /unexpected model output/i, /structured summarizer prompt too large/i,
  ])) {
    return 'input';
  }
  if (matchesErrorText(combined, [
    /econnreset/i, /econnrefused/i, /econnaborted/i, /epipe/i, /enotfound/i,
    /eai_again/i, /network/i, /socket/i, /fetch failed/i,
  ])) {
    return 'transport';
  }
  if (context === 'spawn' && matchesErrorText(combined, [/\benoent\b/, /\beacces\b/])) {
    return 'transport';
  }
  if (matchesErrorText(combined, [/exited with code/i])) {
    return 'provider_exit';
  }
  if (context === 'spawn' && combined) {
    return 'transport';
  }
  return 'unknown';
}

export class OperationTimeoutError extends Error {
  constructor(message = 'Background AI operation timed out') {
    super(message);
    this.name = 'OperationTimeoutError';
    this.code = 'timeout';
  }
}

/**
 * Begin a background operation. Emits nothing; the returned descriptor
 * carries the operationId shared by the queue and the call site.
 */
export function beginOperation({
  operation = 'background_prompt',
  sessionId = '',
  provider = '',
  model = '',
  promptText = '',
  attempt = 1,
  operationId = '',
} = {}) {
  operationSequence += 1;
  const sanitizedOperation = sanitizeOperationKey(operation);
  const resolvedOperationId = trimString(operationId)
    || `op_${sanitizedOperation}_${Date.now()}_${operationSequence}`;
  return {
    operationId: resolvedOperationId,
    operation: trimString(operation) || 'background_prompt',
    sessionId: trimString(sessionId),
    provider: trimString(provider),
    model: trimString(model),
    attempt: pickNonNegativeInt(attempt) || 1,
    ...buildSafePromptMeta(promptText),
    startedAt: Date.now(),
  };
}

function sanitizeOperationKey(value) {
  return trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'background_prompt';
}

function sanitizeUsage(usage = null) {
  if (!usage || typeof usage !== 'object') return null;
  const output = {};
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'contextTokens']) {
    const value = pickNonNegativeInt(usage[key]);
    if (value !== null) output[key] = value;
  }
  for (const key of ['costUsd', 'estimatedCostUsd']) {
    const value = pickFiniteNumber(usage[key]);
    if (value !== null && value > 0) output[key] = value;
  }
  return Object.keys(output).length > 0 ? output : null;
}

function normalizeEventFields(event = {}) {
  const kind = OPERATION_EVENT_KINDS.includes(event.kind) ? event.kind : '';
  const operationId = trimString(event.operationId);
  if (!kind || !operationId) return null;

  const durationMs = pickNonNegativeInt(event.durationMs);
  const queueDepth = pickNonNegativeInt(event.queueDepth);
  const ts = trimString(event.ts);
  if (!ts) return null;

  const errorCode = OPERATION_ERROR_CODES.includes(event.errorCode) ? event.errorCode : '';
  const usage = sanitizeUsage(event.usage);
  const promptLength = pickNonNegativeInt(event.promptLength);
  return {
    kind,
    operationId,
    operation: trimString(event.operation) || 'background_prompt',
    sessionId: trimString(event.sessionId),
    provider: trimString(event.provider),
    model: trimString(event.model),
    attempt: pickNonNegativeInt(event.attempt) || 1,
    ts,
    ...(durationMs !== null ? { durationMs } : {}),
    ...(queueDepth !== null ? { queueDepth } : {}),
    ...(trimString(event.stage) ? { stage: trimString(event.stage).slice(0, 16) } : {}),
    ...(trimString(event.result) ? { result: trimString(event.result).slice(0, 64) } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(trimString(event.reason) ? { reason: trimString(event.reason).slice(0, 64) } : {}),
    ...(trimString(event.usageRunId) ? { usageRunId: trimString(event.usageRunId) } : {}),
    ...(usage ? { usage } : {}),
    ...(promptLength !== null ? { promptLength } : {}),
    ...(trimString(event.promptHash) ? { promptHash: trimString(event.promptHash) } : {}),
    ...(trimString(event.promptPreview) ? { promptPreview: trimString(event.promptPreview).slice(0, MAX_PREVIEW_CHARS) } : {}),
    ...(trimString(event.errorMessage) ? { errorMessage: trimString(event.errorMessage).slice(0, MAX_ERROR_MESSAGE_CHARS) } : {}),
  };
}

/**
 * Record one structured operation event. The event is sanitized field by
 * field, so callers cannot accidentally persist prompt text or bodies.
 *
 * @returns {boolean} true when the event was appended.
 */
export function recordOperationEvent(event) {
  const normalized = normalizeEventFields(event);
  if (!normalized) return false;
  const stream = ensureStream(new Date(normalized.ts));
  if (!stream) return false;
  stream.write(`${JSON.stringify(normalized)}\n`);
  return true;
}

/**
 * Run a background task with full lifecycle events.
 *
 * @param {object} params
 * @param {string} params.operation Operation key (e.g. 'task_card_suggestion').
 * @param {string} [params.sessionId]
 * @param {string} [params.provider] Tool/provider id.
 * @param {string} [params.model]
 * @param {string} [params.promptText] Used ONLY for length/hash/preview.
 * @param {number} [params.attempt]
 * @param {number} [params.timeoutMs] Hard deadline; task is not cancelled,
 *   callers must self-abort (e.g. kill the child process).
 * @param {Function} params.task Async task returning the result.
 * @returns {Promise<{operationId: string, result: *, errorCode: string,
 *   durationMs: number, timedOut: boolean}>}
 */
export async function trackBackgroundOperation({
  operation = 'background_prompt',
  sessionId = '',
  provider = '',
  model = '',
  promptText = '',
  attempt = 1,
  timeoutMs = 0,
  task,
}) {
  const op = beginOperation({ operation, sessionId, provider, model, promptText, attempt });
  const startedAt = Date.now();
  recordOperationEvent({
    kind: 'started',
    operationId: op.operationId,
    operation: op.operation,
    sessionId: op.sessionId,
    provider: op.provider,
    model: op.model,
    attempt: op.attempt,
    ts: new Date(startedAt).toISOString(),
    stage: 'call',
    promptLength: op.promptLength,
    promptHash: op.promptHash,
    promptPreview: op.promptPreview,
  });

  let timedOut = false;
  const work = Promise.resolve().then(() => task());
  // Swallow late settlement after a timeout fired so it cannot surface as an
  // unhandled rejection (the deadline already reported the terminal event).
  work.catch(() => {});
  let timeoutTimer = null;
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? new Promise((resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          reject(new OperationTimeoutError());
        }, timeoutMs);
      })
    : null;

  try {
    // The deadline only rejects the caller; the task keeps running unless it
    // self-aborts (summarizer kills its child process on timeout).
    const result = deadline ? await Promise.race([work, deadline]) : await work;
    const durationMs = Date.now() - startedAt;
    if (timedOut) {
      recordOperationEvent({
        kind: 'timeout',
        operationId: op.operationId,
        operation: op.operation,
        sessionId: op.sessionId,
        provider: op.provider,
        model: op.model,
        attempt: op.attempt,
        ts: new Date().toISOString(),
        durationMs,
        stage: 'call',
      });
      throw new OperationTimeoutError();
    }
    recordOperationEvent({
      kind: 'succeeded',
      operationId: op.operationId,
      operation: op.operation,
      sessionId: op.sessionId,
      provider: op.provider,
      model: op.model,
      attempt: op.attempt,
      ts: new Date().toISOString(),
      durationMs,
      result: 'ok',
      stage: 'call',
    });
    return { operationId: op.operationId, result, errorCode: '', durationMs, timedOut: false };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorCode = timedOut ? 'timeout' : classifyProviderError(error, { context: 'call' });
    if (timedOut) {
      recordOperationEvent({
        kind: 'timeout',
        operationId: op.operationId,
        operation: op.operation,
        sessionId: op.sessionId,
        provider: op.provider,
        model: op.model,
        attempt: op.attempt,
        ts: new Date().toISOString(),
        durationMs,
        errorCode,
        errorMessage: String(error?.message || '').slice(0, MAX_ERROR_MESSAGE_CHARS),
        stage: 'call',
      });
    } else {
      recordOperationEvent({
        kind: 'failed',
        operationId: op.operationId,
        operation: op.operation,
        sessionId: op.sessionId,
        provider: op.provider,
        model: op.model,
        attempt: op.attempt,
        ts: new Date().toISOString(),
        durationMs,
        errorCode,
        errorMessage: String(error?.message || '').slice(0, MAX_ERROR_MESSAGE_CHARS),
        stage: 'call',
      });
    }
    return { operationId: op.operationId, result: null, errorCode, durationMs, timedOut };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

function normalizeWindow(options = {}) {
  const endMs = Number.isFinite(options.endMs) ? options.endMs : Date.now();
  if (Number.isFinite(options.startMs)) {
    return {
      startMs: options.startMs,
      endMs,
      days: Math.max(1, Math.ceil((endMs - options.startMs) / DAY_MS)),
    };
  }
  const days = Number.isInteger(options.days) && options.days > 0 ? options.days : DEFAULT_DAYS;
  return { startMs: endMs - (days * DAY_MS), endMs, days };
}

function parsePositiveInteger(value, fallback) {
  if (Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

async function listLedgerFiles(startMs, endMs, ledgerDir) {
  let entries;
  try {
    entries = await readdir(ledgerDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const minKey = formatDateKey(new Date(startMs));
  const maxKey = formatDateKey(new Date(endMs));
  return entries
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => {
      const dayKey = name.slice(0, -'.jsonl'.length);
      return dayKey >= minKey && dayKey <= maxKey;
    })
    .sort((left, right) => left.localeCompare(right))
    .map((name) => join(ledgerDir, name));
}

function matchesEventFilters(event, filters = {}) {
  if (filters.kind && event.kind !== filters.kind) return false;
  if (filters.operation && event.operation !== filters.operation) return false;
  if (filters.errorCode && event.errorCode !== filters.errorCode) return false;
  if (filters.sessionId && event.sessionId !== filters.sessionId) return false;
  if (filters.provider && event.provider !== filters.provider) return false;
  return true;
}

function createTerminalStats() {
  return {
    count: 0,
    succeeded: 0,
    failed: 0,
    timeout: 0,
    skipped: 0,
    durationTotalMs: 0,
    durationSamples: [],
    maxDurationMs: 0,
  };
}

function appendTerminalStats(target, event) {
  target.count += 1;
  if (event.kind === 'succeeded') target.succeeded += 1;
  else if (event.kind === 'failed') target.failed += 1;
  else if (event.kind === 'timeout') target.timeout += 1;
  else if (event.kind === 'skipped') target.skipped += 1;
  if (Number.isInteger(event.durationMs)) {
    target.durationTotalMs += event.durationMs;
    target.durationSamples.push(event.durationMs);
    target.maxDurationMs = Math.max(target.maxDurationMs, event.durationMs);
  }
}

function roundAverage(value) {
  return Math.round(value * 100) / 100;
}

function percentile(sortedSamples, ratio) {
  if (sortedSamples.length === 0) return null;
  const index = Math.min(sortedSamples.length - 1, Math.max(0, Math.ceil(sortedSamples.length * ratio) - 1));
  return sortedSamples[index];
}

function finalizeTerminalStats(stats) {
  const samples = [...stats.durationSamples].sort((a, b) => a - b);
  return {
    count: stats.count,
    succeeded: stats.succeeded,
    failed: stats.failed,
    timeout: stats.timeout,
    skipped: stats.skipped,
    successRate: stats.count > 0 ? roundAverage(stats.succeeded / stats.count) : null,
    avgDurationMs: stats.durationSamples.length > 0
      ? roundAverage(stats.durationTotalMs / stats.durationSamples.length)
      : null,
    p95DurationMs: percentile(samples, 0.95),
    maxDurationMs: stats.durationSamples.length > 0 ? stats.maxDurationMs : null,
  };
}

/**
 * Summarize operation ledger events in the window.
 *
 * @param {object} options
 * @param {number} [options.days] Window length in days (default 1).
 * @param {number|string} [options.endMs]
 * @param {string} [options.ledgerDir] Override ledger directory.
 * @param {string} [options.operation] Filter by operation key.
 * @param {string} [options.errorCode] Filter by error code.
 * @param {string} [options.kind] Filter by event kind.
 */
export async function queryOperationLedger(options = {}) {
  const { startMs, endMs, days } = normalizeWindow(options);
  const ledgerDir = resolveOperationLedgerDir(options.ledgerDir);
  const filters = {
    kind: trimString(options.kind),
    operation: trimString(options.operation),
    errorCode: trimString(options.errorCode),
    sessionId: trimString(options.sessionId),
    provider: trimString(options.provider),
  };

  const events = [];
  const files = await listLedgerFiles(startMs, endMs, ledgerDir);
  for (const filePath of files) {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const rawLine of input) {
        const line = rawLine.trim();
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const event = normalizeEventFields(parsed);
        if (!event) continue;
        const eventMs = normalizeTimestampMs(event.ts);
        if (eventMs === null || eventMs < startMs || eventMs > endMs) continue;
        events.push(event);
      }
    } finally {
      input.close();
      stream.destroy();
    }
  }

  const filtered = events.filter((event) => matchesEventFilters(event, filters));
  const byOperation = new Map();
  const byKind = new Map();
  const byErrorCode = new Map();
  const byReason = new Map();
  const usageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    estimatedCostUsd: 0,
  };
  const terminalEvents = [];

  for (const event of filtered) {
    const operationKey = event.operation || 'background_prompt';
    if (!byOperation.has(operationKey)) {
      byOperation.set(operationKey, { key: operationKey, ...createTerminalStats() });
    }
    const kindKey = event.kind || 'unknown';
    if (!byKind.has(kindKey)) byKind.set(kindKey, 0);
    byKind.set(kindKey, byKind.get(kindKey) + 1);

    if (['succeeded', 'failed', 'timeout', 'skipped'].includes(event.kind)) {
      const bucket = byOperation.get(operationKey);
      appendTerminalStats(bucket, event);
      terminalEvents.push(event);
      if (event.kind === 'failed' || event.kind === 'timeout') {
        const errorKey = event.errorCode || 'unknown';
        if (!byErrorCode.has(errorKey)) byErrorCode.set(errorKey, 0);
        byErrorCode.set(errorKey, byErrorCode.get(errorKey) + 1);
      }
      if (event.kind === 'skipped' && event.reason) {
        if (!byReason.has(event.reason)) byReason.set(event.reason, 0);
        byReason.set(event.reason, byReason.get(event.reason) + 1);
      }
    }

    const usage = event.usage || {};
    usageTotals.inputTokens += usage.inputTokens || 0;
    usageTotals.outputTokens += usage.outputTokens || 0;
    usageTotals.cachedInputTokens += usage.cachedInputTokens || 0;
    usageTotals.reasoningTokens += usage.reasoningTokens || 0;
    usageTotals.costUsd += usage.costUsd || 0;
    usageTotals.estimatedCostUsd += usage.estimatedCostUsd || 0;
  }

  const operations = [...byOperation.values()]
    .map((bucket) => ({ key: bucket.key, ...finalizeTerminalStats(bucket) }))
    .sort((left, right) => (right.count || 0) - (left.count || 0) || String(left.key).localeCompare(String(right.key)));

  return {
    generatedAt: new Date().toISOString(),
    window: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      days,
    },
    filters,
    filesScanned: files.length,
    eventsScanned: events.length,
    events: filtered.length,
    operations,
    byKind: [...byKind.entries()].sort((a, b) => b[1] - a[1]),
    byErrorCode: [...byErrorCode.entries()].sort((a, b) => b[1] - a[1]),
    byReason: [...byReason.entries()].sort((a, b) => b[1] - a[1]),
    usageTotals,
    recentFailures: terminalEvents
      .filter((event) => event.kind === 'failed' || event.kind === 'timeout')
      .sort((left, right) => String(right.ts).localeCompare(String(left.ts)))
      .slice(0, 10)
      .map((event) => ({
        ts: event.ts,
        operationId: event.operationId,
        operation: event.operation,
        sessionId: event.sessionId,
        provider: event.provider,
        model: event.model,
        kind: event.kind,
        errorCode: event.errorCode || '',
        errorMessage: event.errorMessage || '',
      })),
  };
}

export function closeOperationLedger() {
  if (!currentStream) return Promise.resolve();
  const stream = currentStream;
  currentStream = null;
  currentDateKey = '';
  return new Promise((resolve) => {
    stream.end(resolve);
  });
}

export function initOperationLedger() {
  return ensureLedgerDir();
}
