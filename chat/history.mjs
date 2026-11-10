import { readFile, readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { withMessageTimelineIdentity } from './message-timeline.mjs';
import { promisify } from 'util';
import {
  gzip as gzipCallback,
  gunzip as gunzipCallback,
  zstdCompress as zstdCompressCallback,
  zstdDecompress as zstdDecompressCallback,
} from 'zlib';

const gzipAsync = promisify(gzipCallback);
const gunzipAsync = promisify(gunzipCallback);
const zstdCompressAsync = promisify(zstdCompressCallback);
const zstdDecompressAsync = promisify(zstdDecompressCallback);
import { isEnvToggleEnabled } from '../lib/env-toggle.mjs';
import { BoundedLruMap } from './cache-utils.mjs';
import { registerCache, registerLruOrMap } from './memory-registry.mjs';
import { getAdaptiveConcurrencyBudget } from './adaptive-concurrency-registry.mjs';
import { cacheBudget } from '../lib/cache-budget.mjs';
import { CHAT_HISTORY_DIR } from '../lib/config.mjs';
import { approvalResponseEvent, normalizeFileChangeType } from './normalizer.mjs';
import { stripEventAttachmentSavedPaths } from './attachment-utils.mjs';
import { stripAssistantControlBlocks } from './assistant-control-blocks.mjs';
import {
  annotateAttachmentsWithArtifactIds,
  ensureSessionAuditProjection,
  updateSessionAuditProjectionForEvents,
} from './session-audit-projection.mjs';
import { maybeNotifyApprovalPending } from './attention-push.mjs';
import { notifySessionEvents } from './session-event-waiter.mjs';
import { mirrorApprovalEventsToOrchestration } from './orchestration-approval-bridge.mjs';
import {
  clearHistoryBaseCache,
  historyBasePath,
  readHistoryBase,
  resolveHistoryEventSource,
  validateHistoryBaseChain,
  writeHistoryBase,
} from './history-base.mjs';
import {
  applyForkHistoryStats,
  buildForkHistoryIndex,
  completeForkHistoryPrefixSnapshot,
  createForkHistoryStats,
  getForkHistoryCheckpoint,
  removeForkHistoryIndex,
  readForkHistoryIndex,
  writeForkHistoryIndex,
} from './fork-history-index.mjs';
import { defaultContinuityStore } from './continuity-store.mjs';
import { getRun, isTerminalRunState } from './runs.mjs';
import { privilegedBatchResponseEvent } from './privileged-ops.mjs';
import {
  createKeyedTaskQueue,
  ensureDir,
  readJson,
  readJsonStrict,
  removePath,
  writeJsonAtomic,
  writeTextAtomic,
} from './fs-utils.mjs';

function historyReadError(code, message, details = {}) {
  return Object.assign(new Error(message), {
    code,
    stage: 'history',
    retryable: false,
    ...details,
  });
}

const EVENT_FILE_WIDTH = 9;
const BODY_FIELD_BY_TYPE = {
  message: 'content',
  reasoning: 'content',
  template_context: 'content',
  tool_use: 'toolInput',
  tool_result: 'output',
};
const ALWAYS_EXTERNALIZE_TYPES = new Set(['reasoning']);
const DEFERRED_INDEX_BODY_TYPES = new Set(['message', 'reasoning', 'template_context', 'tool_use', 'tool_result']);
const INLINE_BODY_LIMITS = {
  message: 64 * 1024,
  reasoning: 0,
  template_context: 4096,
  tool_use: 2048,
  tool_result: 4096,
  status: 4096,
};
const PREVIEW_LIMITS = {
  message: 1600,
  reasoning: 1600,
  template_context: 1600,
  tool_use: 800,
  tool_result: 1200,
  status: 800,
};

// Hard safety bounds for compatibility readers.  The normal timeline path is
// already paginated, but event-block/body endpoints are also callable
// directly and must not be able to materialize an entire session or a giant
// decompression result in the chat process.
export const MAX_EVENT_RANGE_SPAN = Math.max(
  100,
  Number.parseInt(process.env.AGENTOC_MAX_EVENT_RANGE_SPAN || '5000', 10) || 5000,
);
const MAX_EVENT_RANGE_RESPONSE_BYTES = Math.max(
  4 * 1024 * 1024,
  Number.parseInt(process.env.AGENTOC_MAX_EVENT_RANGE_BYTES || String(32 * 1024 * 1024), 10)
    || 32 * 1024 * 1024,
);
const MAX_EVENT_RANGE_BODY_BYTES = Math.max(
  256 * 1024,
  Number.parseInt(process.env.AGENTOC_MAX_EVENT_RANGE_BODY_BYTES || String(4 * 1024 * 1024), 10)
    || 4 * 1024 * 1024,
);
const MAX_BODY_READ_BYTES = Math.max(
  1024 * 1024,
  Number.parseInt(process.env.AGENTOC_MAX_EVENT_BODY_READ_BYTES || String(64 * 1024 * 1024), 10)
    || 64 * 1024 * 1024,
);
const MAX_BODY_CACHE_BYTES = Math.max(
  16 * 1024,
  Number.parseInt(process.env.AGENTOC_MAX_EVENT_BODY_CACHE_BYTES || String(256 * 1024), 10)
    || 256 * 1024,
);

// DS-16: cold-body compression. Bodies at or above COLD_BODY_COMPRESS_MIN_BYTES
// are stored compressed (bodies/<ref>.txt.gz or .txt.zst per AGENTOC_BODY_CODEC)
// with a sidecar <ref>.txt.meta.json carrying codec, original byte length and
// sha256 of the original content. readBody decompresses transparently and
// verifies the hash when meta exists. The HTTP layer is untouched — the body
// endpoint serves the decompressed value, so ETag/validation/caching are
// codec-independent ("compression never affects range/checks").
const BODY_CODEC_ENV = 'AGENTOC_BODY_CODEC';
const BODY_CODEC = (process.env[BODY_CODEC_ENV] || 'gzip').toLowerCase();
const BODY_COMPRESS_MIN_BYTES_ENV = 'AGENTOC_BODY_COMPRESS_MIN_BYTES';
const COLD_BODY_COMPRESS_MIN_BYTES = Number(process.env[BODY_COMPRESS_MIN_BYTES_ENV]) || 4096;
const BODY_META_SUFFIX = '.meta.json';
const BODY_CODEC_SUFFIX = { gzip: '.gz', zstd: '.zst' };

// Perf (AGENTOC_PERF_CACHES=off restores unbounded Maps + JSON clone): these
// read-through caches previously retained every event/body/meta ever touched
// for the life of the process (a 110K-event session alone can hold hundreds of
// MB of inline bodies), which was the bulk of a ~737MB RSS. BoundedLruMap caps
// each by entry count and approximate bytes; eviction is always safe because
// every miss re-reads the file on disk.
const AGENTOC_PERF_CACHES_ENV = 'AGENTOC_PERF_CACHES';
const PERF_CACHES_ENABLED = isEnvToggleEnabled(process.env[AGENTOC_PERF_CACHES_ENV], { defaultValue: true });

function makeLruOrMap(options) {
  return PERF_CACHES_ENABLED ? new BoundedLruMap(options) : new Map();
}

function approximateEventBytes(event) {
  if (!event || typeof event !== 'object') return 0;
  let total = 512;
  for (const field of ['content', 'toolInput', 'output', 'text', 'bodyPreview', 'preview', 'toolName', 'filePath', 'changeType', 'role', 'summary']) {
    const value = event[field];
    if (typeof value === 'string') total += value.length;
  }
  return total;
}

function approximateJsonBytes(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

const metaCache = makeLruOrMap({ maxEntries: 1000, maxBytes: cacheBudget('history.meta', 0.5), bytesOf: approximateJsonBytes });
const contextCache = makeLruOrMap({ maxEntries: 500, maxBytes: cacheBudget('history.context', 1), bytesOf: approximateJsonBytes });
const forkContextCache = makeLruOrMap({ maxEntries: 500, maxBytes: cacheBudget('history.forkContext', 0.5), bytesOf: approximateJsonBytes });
const eventCache = makeLruOrMap({ maxEntries: 50_000, maxBytes: cacheBudget('history.events', 1.5), bytesOf: approximateEventBytes });
const bodyCache = makeLruOrMap({ maxEntries: 30_000, maxBytes: cacheBudget('history.bodies', 1.5), bytesOf: approximateJsonBytes });
const runSessionMutation = createKeyedTaskQueue();
const forkHistoryIndexTasks = new Map();
const cancelledForkHistoryIndexTasks = new Set();
const FORK_HISTORY_INDEX_DEBOUNCE_MS = Math.max(
  0,
  Number.parseInt(process.env.AGENTOC_FORK_INDEX_DEBOUNCE_MS || '100', 10) || 100,
);

// Memory registry (DS-06): expose every read-through cache to /healthz and the
// owner-only diagnostics route. The adapter falls back to plain-Map metrics
// when AGENTOC_PERF_CACHES=off substitutes unbounded Maps.
registerLruOrMap('history.meta', metaCache);
registerLruOrMap('history.context', contextCache);
registerLruOrMap('history.forkContext', forkContextCache);
registerLruOrMap('history.events', eventCache, { kind: 'history-events' });
registerLruOrMap('history.bodies', bodyCache, { kind: 'history-bodies' });

// DS-11: read paths used to walk one file per event with a strictly sequential
// await chain — a 20K-event session serialized 20K round-trips through the fs
// threadpool, and a single page read blocked on every earlier event first.
// Reads now fetch events/bodies through a fixed worker pool in contiguous
// batches (bounded concurrency, never thousands of in-flight readFile), stop
// as soon as the page limit is satisfied, and only read as far as the request
// requires. Cache-hit counters are exposed via getHistoryReadStats().
const historyReadBudget = getAdaptiveConcurrencyBudget('historyIO');
const historyBackgroundReadBudget = getAdaptiveConcurrencyBudget('historyBackgroundIO');
const HISTORY_BACKGROUND_ACQUIRE_DEADLINE_MS = Math.max(
  250,
  Number.parseInt(process.env.AGENTOC_HISTORY_BACKGROUND_DEADLINE_MS || '2000', 10) || 2000,
);
// The foreground lane remains bounded and adaptive. The background lane has
// its own slots and queue, so maintenance/recovery cannot consume all
// admission capacity needed by an interactive session refresh.
const HISTORY_READ_CONCURRENCY = historyReadBudget.effectiveLimit;
const HISTORY_BACKGROUND_READ_CONCURRENCY = historyBackgroundReadBudget.effectiveLimit;
const HISTORY_READ_BATCH_SIZE = 256;
const HISTORY_INTERACTIVE_ACQUIRE_DEADLINE_MS = (() => {
  const parsed = Number.parseInt(String(process.env.AGENTOC_HISTORY_INTERACTIVE_DEADLINE_MS || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 30_000) : 8_000;
})();
// Descending scans (last turn, latest assistant message) expect a small
// result; reading a full 256-batch to find one event over-reads by up to 255.
// A smaller tail-scan batch keeps that over-read bounded while the loop still
// continues chunk-by-chunk for unusually long turns.
const HISTORY_DESC_SCAN_BATCH = 64;

const historyReadStats = {
  eventCacheHits: 0,
  eventFileReads: 0,
  bodyCacheHits: 0,
  bodyFileReads: 0,
  // DS-16: compressed bodies that failed to decompress or whose sha256 did
  // not match the sidecar meta. A corrupted body reads as '' (same contract
  // as a missing body) and is counted here for diagnostics.
  bodyCorruptions: 0,
  readOperations: 0,
  pageReads: 0,
  rangeReads: 0,
  afterReads: 0,
  eventsReturned: 0,
  totalReadDurationMs: 0,
  maxReadDurationMs: 0,
  lastReadDurationMs: null,
  lastReadKind: null,
  lastRequestedLimit: null,
};

function monotonicMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function recordHistoryRead(kind, startedAt, eventCount, requestedLimit = null) {
  const durationMs = Math.max(0, monotonicMs() - startedAt);
  historyReadStats.readOperations += 1;
  if (kind === 'page') historyReadStats.pageReads += 1;
  if (kind === 'range') historyReadStats.rangeReads += 1;
  if (kind === 'after') historyReadStats.afterReads += 1;
  historyReadStats.eventsReturned += Number.isInteger(eventCount) && eventCount > 0 ? eventCount : 0;
  historyReadStats.totalReadDurationMs += durationMs;
  historyReadStats.maxReadDurationMs = Math.max(historyReadStats.maxReadDurationMs, durationMs);
  historyReadStats.lastReadDurationMs = durationMs;
  historyReadStats.lastReadKind = kind;
  historyReadStats.lastRequestedLimit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : null;
}

// DS-11/16: expose read amplification and cold/hot latency without retaining
// event values. The registry normalizes this to scalar, JSON-safe fields.
registerCache('history.reads', {
  kind: 'timing',
  snapshot: () => ({
    ...historyReadStats,
    avgReadDurationMs: historyReadStats.readOperations > 0
      ? historyReadStats.totalReadDurationMs / historyReadStats.readOperations
      : 0,
  }),
});

// Map items through fn with at most `concurrency` in flight, preserving input
// order in the result. Exported as a test hook (precedent: __setCacheLimitsForTest).
export async function __mapWithBoundedConcurrency(items, concurrency, fn) {
  if (items.length <= concurrency) {
    // Fewer items than the bound: one all-at-once pass stays within the
    // concurrency limit and skips worker bootstrap on tiny batches.
    return Promise.all(items.map((item, index) => fn(item, index)));
  }
  const results = new Array(items.length);
  let cursor = 0;
  const workers = [];
  const workerCount = Math.min(concurrency, items.length);
  for (let index = 0; index < workerCount; index += 1) {
    workers.push((async () => {
      while (cursor < items.length) {
        const itemIndex = cursor;
        cursor += 1;
        results[itemIndex] = await fn(items[itemIndex], itemIndex);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

async function mapWithAdaptiveConcurrency(items, fn, { priority = 'normal' } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const normalizedPriority = priority === 'interactive' ? 'interactive' : 'background';
  const budget = normalizedPriority === 'interactive'
    ? historyReadBudget
    : historyBackgroundReadBudget;
  const fallbackConcurrency = normalizedPriority === 'interactive'
    ? HISTORY_READ_CONCURRENCY
    : HISTORY_BACKGROUND_READ_CONCURRENCY;
  const workerCount = Math.max(1, Math.min(
    budget.effectiveLimit || fallbackConcurrency,
    items.length,
  ));
  return __mapWithBoundedConcurrency(items, workerCount, async (item, index) => {
    const lease = await budget.acquire({
      priority: normalizedPriority,
      wait: true,
      // Background work is best-effort and must yield quickly when the disk
      // lane is busy. The error is intentionally propagated so callers can
      // retry/skip the maintenance pass instead of silently returning partial
      // history.
      deadlineMs: normalizedPriority === 'interactive'
        ? HISTORY_INTERACTIVE_ACQUIRE_DEADLINE_MS
        : HISTORY_BACKGROUND_ACQUIRE_DEADLINE_MS,
    });
    if (!lease) {
      throw Object.assign(new Error(`${budget.name} adaptive budget unavailable`), {
        code: 'ADAPTIVE_CONCURRENCY_UNAVAILABLE',
      });
    }
    const startedAt = monotonicMs();
    try {
      const result = await fn(item, index);
      lease.release({ durationMs: monotonicMs() - startedAt, outcome: 'success' });
      return result;
    } catch (error) {
      lease.release({ durationMs: monotonicMs() - startedAt, outcome: 'error' });
      throw error;
    }
  });
}

// Keep logical-event reads on the same adaptive worker pool as raw event/body
// reads. A number of compatibility and recovery paths need to resolve shared
// history prefixes before loading an event; issuing those reads with a bare
// Promise.all silently bypassed the process-wide budget and could create
// hundreds of fs-threadpool requests for one large session page.
async function readLogicalEventsBatched(sessionId, seqs, readContext, {
  uncached = false,
  priority = 'normal',
} = {}) {
  return mapWithAdaptiveConcurrency(
    seqs,
    (seq) => loadLogicalStoredEvent(
      sessionId,
      seq,
      logicalEventOptions(readContext, { uncached }),
    ),
    { priority },
  );
}

// Batch variant of hydrateEvent: bodies for the given stored events are read
// through the same bounded pool, then re-attached in input order. Events with
// no bodyRef stay untouched (inline bodies are already present).
async function hydrateEvents(sessionId, storedEvents) {
  const present = [];
  for (const event of storedEvents) {
    if (event?.bodyRef && event?.bodyField) present.push(event);
  }
  const bodies = await mapWithAdaptiveConcurrency(
    present,
    (event) => readBody(sessionId, event.bodyRef),
  );
  const bodiesByRef = new Map();
  for (let index = 0; index < present.length; index += 1) {
    bodiesByRef.set(present[index].bodyRef, bodies[index]);
  }
  return storedEvents.map((event) => {
    if (!event?.bodyRef || !event?.bodyField) return event;
    const hydrated = { ...event };
    hydrated[hydrated.bodyField] = bodiesByRef.get(hydrated.bodyRef) ?? '';
    hydrated.bodyLoaded = true;
    return hydrated;
  });
}

function seqRangeChunks(from, to, batchSize) {
  // Ascending contiguous [from..to] split into batchSize-wide chunks.
  const chunks = [];
  for (let start = from; start <= to; start += batchSize) {
    const end = Math.min(to, start + batchSize - 1);
    const seqs = [];
    for (let seq = start; seq <= end; seq += 1) seqs.push(seq);
    chunks.push(seqs);
  }
  return chunks;
}

function descSeqRangeChunks(from, to, batchSize) {
  // Descending contiguous [from..to] split into batchSize-wide chunks.
  const chunks = [];
  for (let start = from; start >= to; start -= batchSize) {
    const end = Math.max(to, start - batchSize + 1);
    const seqs = [];
    for (let seq = start; seq >= end; seq -= 1) seqs.push(seq);
    chunks.push(seqs);
  }
  return chunks;
}

function clone(value) {
  if (value === null || value === undefined) return value;
  if (!PERF_CACHES_ENABLED) return JSON.parse(JSON.stringify(value));
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

// Test-only hook (precedent: this suite exposes __-prefixed surfaces): shrink
// the cache caps so eviction behavior can be exercised without GBs of data.
export function __setCacheLimitsForTest({ eventCache: eventLimits = null, bodyCache: bodyLimits = null } = {}) {
  if (eventLimits) {
    eventCache.maxEntries = eventLimits.maxEntries;
    if (Number.isFinite(eventLimits.maxBytes)) eventCache.maxBytes = eventLimits.maxBytes;
  }
  if (bodyLimits) {
    bodyCache.maxEntries = bodyLimits.maxEntries;
    if (Number.isFinite(bodyLimits.maxBytes)) bodyCache.maxBytes = bodyLimits.maxBytes;
  }
  return { eventCacheSize: eventCache.size, bodyCacheSize: bodyCache.size };
}

function clipMiddle(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const head = Math.max(1, Math.floor(maxChars * 0.6));
  const tail = Math.max(1, maxChars - head);
  return `${text.slice(0, head).trimEnd()}\n[... truncated by AgentoC ...]\n${text.slice(-tail).trimStart()}`;
}

function eventCacheKey(sessionId, seq) {
  return `${sessionId}:${seq}`;
}

function bodyCacheKey(sessionId, ref) {
  return `${sessionId}:${ref}`;
}

function sessionDir(sessionId) {
  return join(CHAT_HISTORY_DIR, sessionId);
}

function sessionMetaPath(sessionId) {
  return join(sessionDir(sessionId), 'meta.json');
}

function sessionContextPath(sessionId) {
  return join(sessionDir(sessionId), 'context.json');
}

function sessionForkContextPath(sessionId) {
  return join(sessionDir(sessionId), 'fork-context.json');
}

function sessionEventsDir(sessionId) {
  return join(sessionDir(sessionId), 'events');
}

function sessionBodiesDir(sessionId) {
  return join(sessionDir(sessionId), 'bodies');
}

// Targeted control-plane lookups. Approval and recovery paths used to load
// the complete transcript (including external bodies) just to find one batch
// or approval request. Keep a small, append-maintained index beside the event
// files so those paths remain O(relevant control events), not O(transcript).
// The index is rebuildable: after a crash the first lookup catches it up from
// the authoritative event files without hydrating any bodies.
const EVENT_LOOKUP_INDEX_SCHEMA_VERSION = 2;
const EVENT_LOOKUP_INDEX_FILE = 'event-lookup-index.json';
const EVENT_LOOKUP_KEY_PREFIXES = Object.freeze({
  privilegedBatch: 'privileged-batch:',
  approval: 'approval:',
  approvedAction: 'approved-action:',
  approvedActionContinuation: 'approved-action-continuation:',
  plan: 'plan:',
});
const EVENT_LOOKUP_INDEX_CACHE_MAX = 128;
const EVENT_LOOKUP_INDEX_WRITE_DEBOUNCE_MS = 50;
const eventLookupIndexCache = makeLruOrMap({
  maxEntries: EVENT_LOOKUP_INDEX_CACHE_MAX,
  maxBytes: cacheBudget('history.lookupIndex', 0.5),
  bytesOf: approximateJsonBytes,
});
const eventLookupIndexBuilds = new Map();
const eventLookupIndexWrites = new Map();

function eventLookupIndexPath(sessionId) {
  return join(sessionDir(sessionId), EVENT_LOOKUP_INDEX_FILE);
}

function emptyEventLookupIndex() {
  return {
    schemaVersion: EVENT_LOOKUP_INDEX_SCHEMA_VERSION,
    builtThroughSeq: 0,
    complete: false,
    entries: {},
  };
}

function normalizeEventLookupIndex(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const entries = input.entries && typeof input.entries === 'object' && !Array.isArray(input.entries)
    ? input.entries
    : {};
  const schemaCompatible = input.schemaVersion === EVENT_LOOKUP_INDEX_SCHEMA_VERSION;
  return {
    schemaVersion: EVENT_LOOKUP_INDEX_SCHEMA_VERSION,
    builtThroughSeq: Number.isInteger(input.builtThroughSeq) && input.builtThroughSeq >= 0
      ? input.builtThroughSeq
      : 0,
    // A schema bump must force one lazy rebuild. Otherwise an old complete
    // index would remain trusted forever and miss newly-indexed key shapes.
    complete: schemaCompatible && input.complete === true,
    entries,
  };
}

function eventLookupKey(event) {
  const type = String(event?.type || '').trim();
  if (type === 'privileged_batch_request'
    || type === 'privileged_batch_response'
    || type === 'privileged_exec_result') {
    const batchId = String(event?.batchId || '').trim();
    return batchId ? `${EVENT_LOOKUP_KEY_PREFIXES.privilegedBatch}${batchId}` : '';
  }
  if (type === 'approval_request' || type === 'approval_response') {
    const runId = String(event?.runId || '').trim();
    const approvalId = String(event?.approvalId || '').trim();
    if (!approvalId) return '';
    // Ordinary session confirmations may not belong to an active Run. Keep
    // those events searchable as well, using a stable sentinel in the key so
    // the control paths stay index-backed without scanning the transcript.
    return `${EVENT_LOOKUP_KEY_PREFIXES.approval}${runId || '_'}:${approvalId}`;
  }
  if (type === 'approved_action_batch_request'
    || type === 'approved_action_batch_response'
    || type === 'approved_action_state'
    || type === 'approved_action_audit') {
    const batchId = String(event?.batchId || '').trim();
    return batchId ? `${EVENT_LOOKUP_KEY_PREFIXES.approvedAction}${batchId}` : '';
  }
  if (type === 'message' && event?.source === 'approved_action') {
    const batchId = String(event?.batchId || '').trim();
    return batchId
      ? `${EVENT_LOOKUP_KEY_PREFIXES.approvedActionContinuation}${batchId}`
      : '';
  }
  if (type === 'plan') {
    const planId = String(event?.planId || event?.artifactId || event?.id || '').trim();
    return planId ? `${EVENT_LOOKUP_KEY_PREFIXES.plan}${planId}` : '';
  }
  return '';
}

function compactLookupEvent(event) {
  const compact = serializeEventForIndex(event, { includeBodies: false });
  try {
    if (Buffer.byteLength(JSON.stringify(compact), 'utf8') <= 512 * 1024) return compact;
  } catch {
    return null;
  }
  // Keep only fields needed by the approval state machine when a malformed or
  // oversized provider request would otherwise bloat the lookup index.
  return {
    type: compact?.type,
    seq: compact?.seq,
    timestamp: compact?.timestamp,
    runId: compact?.runId,
    batchId: compact?.batchId,
    approvalId: compact?.approvalId,
    providerRequestId: compact?.providerRequestId,
    providerRequestIdString: compact?.providerRequestIdString,
    providerMethod: compact?.providerMethod,
    kind: compact?.kind,
    category: compact?.category,
  };
}

function updateEventLookupIndexValue(index, event) {
  const key = eventLookupKey(event);
  if (!key || !Number.isInteger(event?.seq) || event.seq <= 0) return index;
  const compact = compactLookupEvent(event);
  if (!compact) return index;
  const current = Array.isArray(index.entries[key]) ? index.entries[key] : [];
  if (current.some((entry) => entry?.seq === event.seq)) return index;
  const nextEntries = [...current, { seq: event.seq, event: compact }];
  // Control state is bounded per key; old terminal audit details remain in
  // event files and can be recovered for forensic reads.
  const capped = nextEntries.length > 1024
    ? [nextEntries[0], ...nextEntries.slice(-1023)]
    : nextEntries;
  return {
    ...index,
    entries: { ...index.entries, [key]: capped },
  };
}

async function readEventLookupIndex(sessionId) {
  const cached = eventLookupIndexCache.get(sessionId);
  if (cached) {
    return clone(cached);
  }
  const loaded = normalizeEventLookupIndex(await readJson(eventLookupIndexPath(sessionId), emptyEventLookupIndex()));
  eventLookupIndexCache.set(sessionId, loaded);
  return clone(loaded);
}

async function writeEventLookupIndex(sessionId, index) {
  const normalized = normalizeEventLookupIndex(index);
  await ensureSessionDir(sessionId);
  await writeJsonAtomic(eventLookupIndexPath(sessionId), normalized);
  eventLookupIndexCache.set(sessionId, normalized);
  return clone(normalized);
}

function cancelPendingEventLookupIndexWrite(sessionId) {
  const pending = eventLookupIndexWrites.get(sessionId);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  eventLookupIndexWrites.delete(sessionId);
}

function scheduleEventLookupIndexWrite(sessionId, index) {
  const pending = eventLookupIndexWrites.get(sessionId) || { index, timer: null };
  pending.index = index;
  if (!pending.timer) {
    pending.timer = setTimeout(() => {
      const current = eventLookupIndexWrites.get(sessionId);
      if (!current) return;
      eventLookupIndexWrites.delete(sessionId);
      void writeEventLookupIndex(sessionId, current.index).catch((error) => {
        // The index is an optimization only. A failed coalesced write is
        // repaired by the next ensureEventLookupIndex scan from event files.
        console.warn('[history] deferred event lookup index write failed', {
          sessionId,
          error: error?.message || String(error),
        });
      });
    }, EVENT_LOOKUP_INDEX_WRITE_DEBOUNCE_MS);
    if (typeof pending.timer.unref === 'function') pending.timer.unref();
  }
  eventLookupIndexWrites.set(sessionId, pending);
}

async function appendEventLookupIndex(sessionId, events, latestSeq) {
  const pending = eventLookupIndexWrites.get(sessionId);
  const existing = pending?.index || await readEventLookupIndex(sessionId);
  let next = existing;
  for (const event of Array.isArray(events) ? events : []) {
    next = updateEventLookupIndexValue(next, event);
  }
  next = {
    ...next,
    builtThroughSeq: Math.max(next.builtThroughSeq || 0, Number.isInteger(latestSeq) ? latestSeq : 0),
    // A newly-created index on an old session is incomplete until the lazy
    // catch-up scan runs; new sessions become complete on their first append.
    complete: next.complete === true || (next.builtThroughSeq === latestSeq && latestSeq <= 1),
  };
  // Keep reads immediately consistent while coalescing the expensive atomic
  // JSON rewrite. The event files remain the source of truth if the process
  // exits before the short debounce window expires.
  eventLookupIndexCache.set(sessionId, next);
  scheduleEventLookupIndexWrite(sessionId, next);
}

async function ensureEventLookupIndex(sessionId) {
  const pending = eventLookupIndexBuilds.get(sessionId);
  if (pending) return pending;
  const task = (async () => {
    const meta = await loadMeta(sessionId);
    const latestSeq = Number.isInteger(meta?.latestSeq) ? meta.latestSeq : 0;
    let index = await readEventLookupIndex(sessionId);
    if (index.complete === true && index.builtThroughSeq >= latestSeq) return index;

    const rebuilt = index.complete === true
      ? index
      : { ...emptyEventLookupIndex(), ...index, entries: { ...(index.entries || {}) } };
    const fromSeq = rebuilt.complete === true
      ? Math.max(1, (rebuilt.builtThroughSeq || 0) + 1)
      : 1;
    await forEachStoredEvent(sessionId, (event) => {
      const updated = updateEventLookupIndexValue(rebuilt, event);
      rebuilt.entries = updated.entries;
    }, { fromSeq, toSeq: latestSeq });
    index = { ...rebuilt, builtThroughSeq: latestSeq, complete: true };
    cancelPendingEventLookupIndexWrite(sessionId);
    await writeEventLookupIndex(sessionId, index);
    return index;
  })();
  eventLookupIndexBuilds.set(sessionId, task);
  try {
    return await task;
  } finally {
    eventLookupIndexBuilds.delete(sessionId);
  }
}

function eventsForLookupKey(index, key) {
  return (Array.isArray(index?.entries?.[key]) ? index.entries[key] : [])
    .map((entry) => entry?.event)
    .filter(Boolean)
    .sort((left, right) => (left.seq || 0) - (right.seq || 0));
}

export async function readPrivilegedBatchEvents(sessionId, batchId) {
  const normalizedBatchId = String(batchId || '').trim();
  if (!normalizedBatchId) return [];
  const index = await ensureEventLookupIndex(sessionId);
  return eventsForLookupKey(index, `${EVENT_LOOKUP_KEY_PREFIXES.privilegedBatch}${normalizedBatchId}`);
}

export async function findPrivilegedBatchRequestEvent(sessionId, batchId, runId = '') {
  const events = await readPrivilegedBatchEvents(sessionId, batchId);
  const normalizedRunId = String(runId || '').trim();
  return events.find((event) => event?.type === 'privileged_batch_request'
    && (!normalizedRunId || String(event.runId || '').trim() === normalizedRunId)) || null;
}

export async function findRuntimeApprovalRequest(sessionId, runId, approvalId) {
  const normalizedRunId = String(runId || '').trim();
  const normalizedApprovalId = String(approvalId || '').trim();
  if (!normalizedRunId || !normalizedApprovalId) return null;
  const index = await ensureEventLookupIndex(sessionId);
  const events = eventsForLookupKey(
    index,
    `${EVENT_LOOKUP_KEY_PREFIXES.approval}${normalizedRunId}:${normalizedApprovalId}`,
  );
  const request = events.filter((event) => event?.type === 'approval_request').at(-1) || null;
  if (!request) return null;
  const requestSeq = Number(request.seq || 0);
  const responded = events.some((event) => event?.type === 'approval_response'
    && Number(event.seq || 0) >= requestSeq);
  return responded ? null : request;
}

// Return only the approval records for one Run/approval pair. Browser and
// other local confirmation channels poll this state repeatedly; they must not
// rebuild the complete Session transcript just to discover whether a response
// was appended.
export async function readRuntimeApprovalEvents(sessionId, runId, approvalId) {
  const normalizedRunId = String(runId || '').trim();
  const normalizedApprovalId = String(approvalId || '').trim();
  if (!normalizedRunId || !normalizedApprovalId) return [];
  const index = await ensureEventLookupIndex(sessionId);
  return eventsForLookupKey(
    index,
    `${EVENT_LOOKUP_KEY_PREFIXES.approval}${normalizedRunId}:${normalizedApprovalId}`,
  );
}

export async function readRuntimeApprovalEventsForRun(sessionId, runId) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) return [];
  const index = await ensureEventLookupIndex(sessionId);
  const prefix = `${EVENT_LOOKUP_KEY_PREFIXES.approval}${normalizedRunId}:`;
  const events = [];
  for (const [key, entries] of Object.entries(index.entries || {})) {
    if (!key.startsWith(prefix)) continue;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.event) events.push(entry.event);
    }
  }
  return events.sort((left, right) => (left.seq || 0) - (right.seq || 0));
}

export async function readAllRuntimeApprovalEvents(sessionId) {
  const index = await ensureEventLookupIndex(sessionId);
  const events = [];
  for (const [key, entries] of Object.entries(index.entries || {})) {
    if (![
      EVENT_LOOKUP_KEY_PREFIXES.approval,
      EVENT_LOOKUP_KEY_PREFIXES.privilegedBatch,
      EVENT_LOOKUP_KEY_PREFIXES.approvedAction,
    ].some((prefix) => key.startsWith(prefix))) continue;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.event) events.push(entry.event);
    }
  }
  return events.sort((left, right) => (left.seq || 0) - (right.seq || 0));
}

export async function readApprovedActionBatchEvents(sessionId, batchId) {
  const normalizedBatchId = String(batchId || '').trim();
  if (!normalizedBatchId) return [];
  const index = await ensureEventLookupIndex(sessionId);
  return eventsForLookupKey(index, `${EVENT_LOOKUP_KEY_PREFIXES.approvedAction}${normalizedBatchId}`);
}

export async function readApprovedActionContinuationEvents(sessionId, batchId) {
  const normalizedBatchId = String(batchId || '').trim();
  if (!normalizedBatchId) return [];
  const index = await ensureEventLookupIndex(sessionId);
  return eventsForLookupKey(
    index,
    `${EVENT_LOOKUP_KEY_PREFIXES.approvedActionContinuation}${normalizedBatchId}`,
  );
}

export async function readPlanEvents(sessionId, planId = '') {
  const normalizedPlanId = String(planId || '').trim();
  const index = await ensureEventLookupIndex(sessionId);
  if (normalizedPlanId) {
    return eventsForLookupKey(index, `${EVENT_LOOKUP_KEY_PREFIXES.plan}${normalizedPlanId}`);
  }
  const events = [];
  for (const [key, entries] of Object.entries(index.entries || {})) {
    if (!key.startsWith(EVENT_LOOKUP_KEY_PREFIXES.plan)) continue;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.event) events.push(entry.event);
    }
  }
  return events.sort((left, right) => (left.seq || 0) - (right.seq || 0));
}

export async function readApprovedActionEvents(sessionId) {
  const index = await ensureEventLookupIndex(sessionId);
  const events = [];
  for (const [key, entries] of Object.entries(index.entries || {})) {
    if (!key.startsWith(EVENT_LOOKUP_KEY_PREFIXES.approvedAction)) continue;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.event) events.push(entry.event);
    }
  }
  return events.sort((left, right) => (left.seq || 0) - (right.seq || 0));
}

export async function readApprovedActionBatchRequestEvents(sessionId) {
  const index = await ensureEventLookupIndex(sessionId);
  const requests = [];
  for (const [key, entries] of Object.entries(index.entries || {})) {
    if (!key.startsWith(EVENT_LOOKUP_KEY_PREFIXES.approvedAction)) continue;
    const event = (Array.isArray(entries) ? entries : [])
      .map((entry) => entry?.event)
      .find((candidate) => candidate?.type === 'approved_action_batch_request');
    if (event) requests.push(event);
  }
  return requests.sort((left, right) => (left.seq || 0) - (right.seq || 0));
}

function eventPath(sessionId, seq) {
  return join(sessionEventsDir(sessionId), `${String(seq).padStart(EVENT_FILE_WIDTH, '0')}.json`);
}

function bodyPath(sessionId, ref) {
  return join(sessionBodiesDir(sessionId), `${ref}.txt`);
}

async function ensureSessionDir(sessionId) {
  await ensureDir(sessionDir(sessionId));
  await ensureDir(sessionEventsDir(sessionId));
  await ensureDir(sessionBodiesDir(sessionId));
}

function emptyMeta() {
  return {
    historyRevision: 0,
    latestSeq: 0,
    lastEventAt: null,
    lastActivityAt: null,
    lastAssistantMessageAt: null,
    size: 0,
    counts: {},
  };
}

// Some server-housekeeping events are deliberately appended to history so the
// audit trail and replay state become correct. They are not new conversation
// activity, though: in particular the boot backfill can append hundreds of
// cancelled approval responses while it repairs old sessions. Keep those
// events in `lastEventAt` for the audit projection, but do not let them move a
// session in the user-facing list or change its displayed activity time.
function isSessionActivityEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.type !== 'approval_response') return true;
  const source = typeof event.source === 'string' ? event.source.trim() : '';
  return source !== 'boot-backfill' && source !== 'run-finalize';
}

function eventTimestamp(event) {
  if (Number.isFinite(event?.timestamp)) return event.timestamp;
  const parsed = Date.parse(event?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function latestTimestamp(left, right) {
  const leftTime = Number.isFinite(left) ? left : Date.parse(left || '');
  const rightTime = Number.isFinite(right) ? right : Date.parse(right || '');
  if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? rightTime : null;
  if (!Number.isFinite(rightTime)) return leftTime;
  return Math.max(leftTime, rightTime);
}

async function findLatestSessionActivityAt(sessionId, meta, options = {}) {
  if (Object.prototype.hasOwnProperty.call(meta || {}, 'lastActivityAt')) {
    return meta.lastActivityAt || null;
  }
  const readContext = await createHistoryReadContext(sessionId, meta, {
    strict: options?.strict === true,
  });
  const latestSeq = Number.isInteger(meta?.latestSeq) ? meta.latestSeq : 0;
  for (const seqs of descSeqRangeChunks(latestSeq, 1, HISTORY_DESC_SCAN_BATCH)) {
    const logicalEvents = await readLogicalEventsBatched(sessionId, seqs, readContext, {
      priority: options?.priority === 'interactive' ? 'interactive' : 'normal',
    });
    for (const logical of logicalEvents) {
      const event = logical?.event;
      if (!event || !isSessionActivityEvent(event)) continue;
      return eventTimestamp(event);
    }
  }
  return null;
}

async function persistMissingSessionActivityAt(sessionId, value) {
  await runSessionMutation(sessionId, async () => {
    const current = await loadMeta(sessionId);
    if (Object.prototype.hasOwnProperty.call(current || {}, 'lastActivityAt')) return;
    await saveMetaUnlocked(sessionId, {
      ...current,
      lastActivityAt: value || null,
    });
  });
}

function normalizeStoredEvent(event, fallbackSeq) {
  const seq = Number.isInteger(event?.seq) ? event.seq : fallbackSeq;
  const timestamp = eventTimestamp(event);
  const normalized = {
    ...(event || {}),
    seq,
    timestamp: timestamp ?? Date.now(),
  };
  if (normalized.type === 'file_change') {
    normalized.filePath = typeof normalized.filePath === 'string'
      ? normalized.filePath
      : String(normalized.filePath ?? '').trim();
    normalized.changeType = normalizeFileChangeType(normalized.changeType);
  }
  return normalized;
}

function eventBodyField(event) {
  return BODY_FIELD_BY_TYPE[event?.type] || null;
}

function previewLimitFor(event) {
  return PREVIEW_LIMITS[event?.type] || 800;
}

function inlineLimitFor(event) {
  return INLINE_BODY_LIMITS[event?.type] ?? 4096;
}

function shouldDeferEventBodyInIndex(event, options = {}) {
  if (options.includeBodies === true) return false;
  if (event?.type === 'message' && options.includeMessageBodies === true) return false;
  if (event?.type === 'reasoning' && options.includeReasoningBodies === true) return false;
  return DEFERRED_INDEX_BODY_TYPES.has(event?.type);
}

function serializeEventForIndex(event, options = {}) {
  const next = clone(event);
  if (!shouldDeferEventBodyInIndex(next, options)) {
    return next;
  }
  const bodyField = eventBodyField(next);
  if (!bodyField) {
    return next;
  }
  const inlineBody = typeof next[bodyField] === 'string' ? next[bodyField] : '';
  const hasBody = !!inlineBody || next.bodyAvailable === true || !!next.bodyRef;
  const preview = next.type === 'message'
    ? ''
    : (inlineBody ? clipMiddle(inlineBody, previewLimitFor(next)) : '');
  next[bodyField] = '';
  next.bodyField = bodyField;
  next.bodyAvailable = hasBody;
  next.bodyLoaded = false;
  if (preview) {
    next.bodyPreview = preview;
  } else {
    delete next.bodyPreview;
  }
  if (hasBody && !Number.isInteger(next.bodyBytes) && inlineBody) {
    next.bodyBytes = Buffer.byteLength(inlineBody, 'utf8');
  }
  return next;
}

export async function loadMeta(sessionId, { strict = false, recover = true } = {}) {
  // Strict reads deliberately bypass the permissive cache. A previous
  // maintenance read may have cached a fallback object after a transient
  // filesystem/JSON failure; serving that value to a session-load request
  // would turn corruption into an apparently empty conversation.
  if (!strict && recover && metaCache.has(sessionId)) {
    return clone(metaCache.get(sessionId));
  }
  let meta;
  if (strict) {
    try {
      meta = await readJsonStrict(sessionMetaPath(sessionId));
    } catch (error) {
      // A newly-created empty session legitimately has no history directory
      // yet; there is nothing to recover and it should render as an empty
      // transcript. Once the directory exists, however, a missing meta file
      // is recoverable only when there are no event files or when the event
      // files form an orphan tail that recoverOrphanEventTail can commit.
      if (error?.code === 'JSON_NOT_FOUND') {
        try {
          await stat(sessionDir(sessionId));
        } catch (directoryError) {
          if (directoryError?.code === 'ENOENT') {
            return clone(emptyMeta());
          }
          throw historyReadError('SESSION_HISTORY_CORRUPT', directoryError?.message || `History directory could not be read for ${sessionId}`, {
            sessionId,
            path: sessionDir(sessionId),
            cause: directoryError,
            });
        }
        if (!recover) throw historyReadError('SESSION_HISTORY_CORRUPT', 'History metadata requires recovery', { sessionId });
        let firstEventSeq = null;
        try {
          const entries = await readdir(sessionEventsDir(sessionId));
          for (const entry of entries) {
            const match = /^(\d+)\.json$/.exec(String(entry || ''));
            if (!match) continue;
            const seq = Number(match[1]);
            if (Number.isInteger(seq) && seq > 0 && (firstEventSeq === null || seq < firstEventSeq)) {
              firstEventSeq = seq;
            }
          }
        } catch (eventsError) {
          if (eventsError?.code !== 'ENOENT') {
            throw historyReadError('SESSION_HISTORY_CORRUPT', eventsError?.message || `History events could not be read for ${sessionId}`, {
              sessionId,
              path: sessionEventsDir(sessionId),
              cause: eventsError,
            });
          }
        }
        if (firstEventSeq !== null && firstEventSeq > 1) {
          throw historyReadError('SESSION_HISTORY_GAP', `History event ${firstEventSeq} is orphaned for ${sessionId}`, {
            sessionId,
            seq: firstEventSeq,
            path: eventPath(sessionId, firstEventSeq),
          });
        }
        // Continue with an empty metadata seed. The recovery pass below reads
        // contiguous event files (if any) and atomically recreates meta.json;
        // a malformed/non-contiguous layout still fails closed there.
        meta = emptyMeta();
      } else {
        throw historyReadError(
          'SESSION_HISTORY_CORRUPT',
          error?.message || `Unable to read history metadata for ${sessionId}`,
          { sessionId, path: error?.path || sessionMetaPath(sessionId), cause: error },
        );
      }
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      throw historyReadError('SESSION_HISTORY_CORRUPT', `History metadata is not an object for ${sessionId}`, {
        sessionId,
        path: sessionMetaPath(sessionId),
      });
    }
    if (meta.latestSeq != null && (!Number.isInteger(meta.latestSeq) || meta.latestSeq < 0)) {
      throw historyReadError('SESSION_HISTORY_CORRUPT', `History latestSeq is invalid for ${sessionId}`, {
        sessionId,
        path: sessionMetaPath(sessionId),
        latestSeq: meta.latestSeq,
      });
    }
  } else {
    meta = await readJson(sessionMetaPath(sessionId), emptyMeta());
  }
  // Public readonly Run queries observe the committed boundary. Recovery is
  // an explicit writer responsibility, never a side effect of polling.
  if (!recover) {
    if (!strict) throw new TypeError('Readonly history metadata requires a strict read');
    if (!Number.isSafeInteger(meta.latestSeq) || meta.latestSeq < 0)
      throw historyReadError('SESSION_HISTORY_CORRUPT', 'Invalid committed history boundary', { sessionId });
    if (meta.historyRevision != null && (!Number.isSafeInteger(meta.historyRevision) || meta.historyRevision < 0))
      throw historyReadError('SESSION_HISTORY_CORRUPT', 'Invalid history revision', { sessionId });
    return clone({ ...emptyMeta(), ...meta });
  }
  const recovered = await recoverOrphanEventTail(sessionId, meta, { strict });
  if (!strict) metaCache.set(sessionId, recovered);
  return clone(recovered);
}

// I-CTX-006: an event file is durable before meta.json advances. If the
// process dies in that interval, recover only a contiguous orphan tail before
// allocating the next seq. A non-contiguous tail is left visible as a gap so
// continuity checkpointing can reject it instead of silently inventing state.
async function recoverOrphanEventTail(sessionId, meta, { strict = false } = {}) {
  const latestSeq = Number.isInteger(meta?.latestSeq) && meta.latestSeq >= 0 ? meta.latestSeq : 0;
  // Event files are named by sequence. The only recoverable state is a
  // contiguous tail immediately after meta.latestSeq; probing that next path
  // avoids readdir+sort over every file in a large session on every cold
  // meta-cache miss. A non-contiguous orphan (e.g. seq N+2 without N+1) is
  // deliberately left untouched, exactly as the former directory scan did.
  let recovered = { ...emptyMeta(), ...(meta || {}), counts: { ...(meta?.counts || {}) } };
  let nextSeq = latestSeq + 1;
  while (true) {
    let event;
    if (strict) {
      try {
        event = await readJsonStrict(eventPath(sessionId, nextSeq));
      } catch (error) {
        if (error?.code === 'JSON_NOT_FOUND') break;
        throw historyReadError('SESSION_HISTORY_CORRUPT', error?.message || `History event ${nextSeq} is malformed`, {
          sessionId,
          seq: nextSeq,
          path: error?.path || eventPath(sessionId, nextSeq),
          cause: error,
        });
      }
    } else {
      event = await readJson(eventPath(sessionId, nextSeq), null);
    }
    if (!event) break;
    const normalized = normalizeStoredEvent(event, nextSeq);
    recovered.latestSeq = nextSeq;
    recovered.size += 1;
    recovered.lastEventAt = normalized.timestamp || recovered.lastEventAt;
    recovered.lastActivityAt = isSessionActivityEvent(normalized)
      ? latestTimestamp(recovered.lastActivityAt, eventTimestamp(normalized))
      : recovered.lastActivityAt;
    recovered.lastAssistantMessageAt = getAssistantMessageTimestamp(recovered.lastAssistantMessageAt, normalized);
    recovered.counts = incrementCounts(recovered.counts, normalized);
    nextSeq += 1;
  }
  if (recovered.latestSeq === latestSeq) return recovered;
  recovered.historyRevision = Math.max(
    Number.isInteger(meta?.historyRevision) ? meta.historyRevision : 0,
    0,
  ) + 1;
  await writeJsonAtomic(sessionMetaPath(sessionId), recovered);
  return recovered;
}

async function saveMetaUnlocked(sessionId, meta) {
  const normalized = {
    ...emptyMeta(),
    ...(meta || {}),
    counts: { ...(meta?.counts || {}) },
  };
  normalized.historyRevision = Math.max(
    Number.isInteger(meta?.historyRevision) ? meta.historyRevision : 0,
    0,
  ) + 1;
  await ensureSessionDir(sessionId);
  await writeJsonAtomic(sessionMetaPath(sessionId), normalized);
  metaCache.set(sessionId, normalized);
  return clone(normalized);
}

async function loadContext(sessionId, { strict = false } = {}) {
  // The normal listing path may use the cached optional context. A strict
  // session snapshot must not let that cache hide an externally truncated or
  // malformed context file; a missing context is still valid for legacy
  // sessions and remains represented as null.
  if (!strict && contextCache.has(sessionId)) return clone(contextCache.get(sessionId));
  let context;
  if (strict) {
    try {
      context = await readJsonStrict(sessionContextPath(sessionId));
    } catch (error) {
      if (error?.code === 'JSON_NOT_FOUND') {
        context = null;
      } else {
        throw historyReadError('SESSION_HISTORY_CONTEXT_CORRUPT', error?.message || `Unable to read context for ${sessionId}`, {
          sessionId,
          path: error?.path || sessionContextPath(sessionId),
          cause: error,
        });
      }
    }
  } else {
    context = await readJson(sessionContextPath(sessionId), null);
  }
  contextCache.set(sessionId, context);
  return clone(context);
}

async function loadForkContext(sessionId) {
  if (forkContextCache.has(sessionId)) return clone(forkContextCache.get(sessionId));
  const context = await readJson(sessionForkContextPath(sessionId), null);
  forkContextCache.set(sessionId, context);
  return clone(context);
}

function normalizeForkContext(context = {}) {
  return {
    mode: context.mode === 'summary' ? 'summary' : 'history',
    summary: typeof context.summary === 'string' ? context.summary.trim() : '',
    continuationBody: typeof context.continuationBody === 'string' ? context.continuationBody.trim() : '',
    activeFromSeq: Number.isInteger(context.activeFromSeq) ? context.activeFromSeq : 0,
    preparedThroughSeq: Number.isInteger(context.preparedThroughSeq) ? context.preparedThroughSeq : 0,
    contextUpdatedAt: typeof context.contextUpdatedAt === 'string' && context.contextUpdatedAt.trim()
      ? context.contextUpdatedAt.trim()
      : null,
    updatedAt: typeof context.updatedAt === 'string' && context.updatedAt.trim()
      ? context.updatedAt.trim()
      : new Date().toISOString(),
    source: typeof context.source === 'string' && context.source.trim()
      ? context.source.trim()
      : 'history',
  };
}

async function saveContextUnlocked(sessionId, context) {
  await ensureSessionDir(sessionId);
  await writeJsonAtomic(sessionContextPath(sessionId), context || null);
  contextCache.set(sessionId, context || null);
  return clone(context || null);
}

async function saveForkContextUnlocked(sessionId, context) {
  const normalized = context ? normalizeForkContext(context) : null;
  await ensureSessionDir(sessionId);
  await writeJsonAtomic(sessionForkContextPath(sessionId), normalized);
  forkContextCache.set(sessionId, normalized);
  return clone(normalized);
}

async function clearContextUnlocked(sessionId) {
  await ensureSessionDir(sessionId);
  await writeJsonAtomic(sessionContextPath(sessionId), null);
  contextCache.set(sessionId, null);
}

async function clearForkContextUnlocked(sessionId) {
  await ensureSessionDir(sessionId);
  await writeJsonAtomic(sessionForkContextPath(sessionId), null);
  forkContextCache.set(sessionId, null);
}

async function compressBody(raw) {
  const input = Buffer.from(raw, 'utf8');
  if (BODY_CODEC === 'zstd') {
    return { buffer: await zstdCompressAsync(input), suffix: BODY_CODEC_SUFFIX.zstd };
  }
  return { buffer: await gzipAsync(input), suffix: BODY_CODEC_SUFFIX.gzip };
}

async function writeBody(sessionId, seq, field, value) {
  await ensureSessionDir(sessionId);
  const ref = `evt_${String(seq).padStart(EVENT_FILE_WIDTH, '0')}_${field}`;
  const raw = value || '';
  const base = bodyPath(sessionId, ref); // bodies/<ref>.txt
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (BODY_CODEC !== 'none' && bytes >= COLD_BODY_COMPRESS_MIN_BYTES) {
    // Cold body: store compressed with a sidecar meta (codec, original byte
    // length, sha256 of the original bytes). The plain file is removed so a
    // session has exactly one body representation per ref.
    const { buffer, suffix } = await compressBody(raw);
    await writeTextAtomic(`${base}${suffix}`, buffer);
    await writeJsonAtomic(`${base}${BODY_META_SUFFIX}`, {
      codec: BODY_CODEC,
      originalBytes: bytes,
      compressedBytes: buffer.length,
      sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    });
    await rm(base, { force: true });
  } else {
    await writeTextAtomic(base, raw);
  }
  // Do not retain a giant body merely because it was just written.  Large
  // bodies remain available on disk and are safely re-read on demand.
  if (bytes <= MAX_BODY_CACHE_BYTES) {
    bodyCache.set(bodyCacheKey(sessionId, ref), raw);
  }
  return ref;
}

// Resolution order is extension-based, never content-sniffed: a plain body
// whose bytes happen to start with the gzip magic reads as text. Compressed
// bodies are verified against the sidecar sha256 when present; a failed
// decode or hash counts a corruption and reads as '' for permissive callers
// (strict session reads surface a typed corruption error instead).
async function readBody(sessionId, ref, { maxBytes = MAX_BODY_READ_BYTES, strict = false } = {}) {
  if (!ref) return '';
  const safeMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, MAX_BODY_READ_BYTES)
    : MAX_BODY_READ_BYTES;
  const key = bodyCacheKey(sessionId, ref);
  // Strict session reads must validate the durable body on disk. A cached
  // value can have been populated before an external writer truncated or
  // replaced the body, so serving it would hide corruption from the
  // consistency gate just like a stale event cache would.
  if (!strict && bodyCache.has(key)) {
    historyReadStats.bodyCacheHits += 1;
    return bodyCache.get(key);
  }
  const base = bodyPath(sessionId, ref);
  const candidates = [
    { suffix: '', decompress: null },
    { suffix: BODY_CODEC_SUFFIX.gzip, decompress: gunzipAsync },
    { suffix: BODY_CODEC_SUFFIX.zstd, decompress: zstdDecompressAsync },
  ];
  for (const { suffix, decompress } of candidates) {
    let fileStat = null;
    try {
      fileStat = await stat(`${base}${suffix}`);
    } catch (error) {
      if (strict && error?.code !== 'ENOENT') {
        throw historyReadError('SESSION_HISTORY_BODY_CORRUPT', `History body could not be read for ${sessionId}`, {
          sessionId,
          bodyRef: ref,
          path: `${base}${suffix}`,
          cause: error,
        });
      }
      continue;
    }
    // A compressed file can be much smaller than its inflated result.  The
    // sidecar check below handles the common case; this file-size guard keeps
    // malformed/missing-sidecar inputs from allocating an unbounded buffer.
    if (fileStat.size > MAX_BODY_READ_BYTES * 2) continue;
    let buffer;
    try {
      buffer = await readFile(`${base}${suffix}`);
    } catch (error) {
      if (strict) {
        throw historyReadError('SESSION_HISTORY_BODY_CORRUPT', `History body could not be read for ${sessionId}`, {
          sessionId,
          bodyRef: ref,
          path: `${base}${suffix}`,
          cause: error,
        });
      }
      continue;
    }
    historyReadStats.bodyFileReads += 1;
    if (!decompress) {
      if (buffer.byteLength > safeMaxBytes) {
        return `${buffer.subarray(0, Math.floor(safeMaxBytes / 2)).toString('utf8')}\n\n[… body truncated at ${safeMaxBytes} bytes …]\n\n${buffer.subarray(Math.max(0, buffer.byteLength - Math.floor(safeMaxBytes / 2))).toString('utf8')}`;
      }
      const value = buffer.toString('utf8');
      if (buffer.byteLength <= MAX_BODY_CACHE_BYTES) bodyCache.set(key, value);
      return value;
    }
    try {
      let meta;
      if (strict) {
        try {
          meta = await readJsonStrict(`${base}${BODY_META_SUFFIX}`);
        } catch (error) {
          throw historyReadError('SESSION_HISTORY_BODY_CORRUPT', error?.message || `History body metadata is malformed for ${sessionId}`, {
            sessionId,
            bodyRef: ref,
            path: error?.path || `${base}${BODY_META_SUFFIX}`,
            cause: error,
          });
        }
      } else {
        meta = await readJson(`${base}${BODY_META_SUFFIX}`, null);
      }
      if (Number.isFinite(meta?.originalBytes) && meta.originalBytes > safeMaxBytes) {
        return `[body truncated: ${meta.originalBytes} bytes exceeds the ${safeMaxBytes}-byte read limit]`;
      }
      const inflated = await decompress(buffer, { maxOutputLength: safeMaxBytes });
      if (inflated.byteLength > safeMaxBytes) {
        return `${inflated.subarray(0, Math.floor(safeMaxBytes / 2)).toString('utf8')}\n\n[… body truncated at ${safeMaxBytes} bytes …]\n\n${inflated.subarray(Math.max(0, inflated.byteLength - Math.floor(safeMaxBytes / 2))).toString('utf8')}`;
      }
      if (meta?.sha256) {
        const hash = createHash('sha256').update(inflated).digest('hex');
        if (hash !== meta.sha256) {
          if (strict) {
            throw historyReadError('SESSION_HISTORY_BODY_CORRUPT', `History body checksum mismatch for ${sessionId}`, {
              sessionId,
              bodyRef: ref,
              path: `${base}${suffix}`,
            });
          }
          continue;
        }
      }
      const value = inflated.toString('utf8');
      if (inflated.byteLength <= MAX_BODY_CACHE_BYTES) bodyCache.set(key, value);
      return value;
    } catch (error) {
      historyReadStats.bodyCorruptions += 1;
      if (strict) {
        if (error?.code?.startsWith?.('SESSION_HISTORY_')) throw error;
        throw historyReadError('SESSION_HISTORY_BODY_CORRUPT', error?.message || `History body could not be decoded for ${sessionId}`, {
          sessionId,
          bodyRef: ref,
          path: `${base}${suffix}`,
          cause: error,
        });
      }
    }
  }
  if (strict) {
    throw historyReadError('SESSION_HISTORY_BODY_MISSING', `History body ${ref} is unavailable for ${sessionId}`, {
      sessionId,
      bodyRef: ref,
      path: base,
    });
  }
  return '';
}

async function storeEvent(sessionId, event) {
  const normalized = normalizeStoredEvent(event, 0);
  const stored = { ...normalized };
  const bodyField = eventBodyField(stored);
  if (bodyField && typeof stored[bodyField] === 'string') {
    const raw = stored[bodyField];
    const shouldExternalize = ALWAYS_EXTERNALIZE_TYPES.has(stored.type) || raw.length > inlineLimitFor(stored);
    if (shouldExternalize && raw) {
      stored[bodyField] = clipMiddle(raw, previewLimitFor(stored));
      stored.bodyAvailable = true;
      stored.bodyLoaded = false;
      stored.bodyField = bodyField;
      stored.bodyRef = await writeBody(sessionId, stored.seq, bodyField, raw);
      stored.bodyBytes = Buffer.byteLength(raw, 'utf8');
    } else {
      stored.bodyAvailable = !!raw;
      stored.bodyLoaded = true;
    }
  }
  await ensureSessionDir(sessionId);
  await writeJsonAtomic(eventPath(sessionId, stored.seq), stored);
  eventCache.set(eventCacheKey(sessionId, stored.seq), stored);
  return clone(stored);
}

async function loadStoredEvent(sessionId, seq, { strict = false } = {}) {
  const key = eventCacheKey(sessionId, seq);
  if (!strict && eventCache.has(key)) {
    historyReadStats.eventCacheHits += 1;
    const cached = normalizeStoredEvent(eventCache.get(key), seq);
    eventCache.set(key, cached);
    return clone(cached);
  }
  historyReadStats.eventFileReads += 1;
  let stored;
  if (strict) {
    try {
      stored = await readJsonStrict(eventPath(sessionId, seq));
    } catch (error) {
      throw historyReadError(
        error?.code === 'JSON_NOT_FOUND' ? 'SESSION_HISTORY_GAP' : 'SESSION_HISTORY_CORRUPT',
        error?.code === 'JSON_NOT_FOUND'
          ? `History event ${seq} is missing for ${sessionId}`
          : (error?.message || `History event ${seq} is malformed for ${sessionId}`),
        { sessionId, seq, path: error?.path || eventPath(sessionId, seq), cause: error },
      );
    }
  } else {
    stored = await readJson(eventPath(sessionId, seq), null);
    if (!stored) return null;
  }
  const normalized = normalizeStoredEvent(stored, seq);
  if (strict && (!normalized || typeof normalized !== 'object' || normalized.seq !== seq)) {
    throw historyReadError('SESSION_HISTORY_CORRUPT', `History event ${seq} is invalid for ${sessionId}`, {
      sessionId,
      seq,
      path: eventPath(sessionId, seq),
    });
  }
  eventCache.set(key, normalized);
  return clone(normalized);
}

async function loadStoredEventUncached(sessionId, seq, { strict = false } = {}) {
  let stored;
  if (strict) {
    try {
      stored = await readJsonStrict(eventPath(sessionId, seq));
    } catch (error) {
      throw historyReadError(
        error?.code === 'JSON_NOT_FOUND' ? 'SESSION_HISTORY_GAP' : 'SESSION_HISTORY_CORRUPT',
        error?.code === 'JSON_NOT_FOUND'
          ? `History event ${seq} is missing for ${sessionId}`
          : (error?.message || `History event ${seq} is malformed for ${sessionId}`),
        { sessionId, seq, path: error?.path || eventPath(sessionId, seq), cause: error },
      );
    }
  } else {
    stored = await readJson(eventPath(sessionId, seq), null);
    if (!stored) return null;
  }
  const normalized = normalizeStoredEvent(stored, seq);
  if (strict && (!normalized || typeof normalized !== 'object' || normalized.seq !== seq)) {
    throw historyReadError('SESSION_HISTORY_CORRUPT', `History event ${seq} is invalid for ${sessionId}`, {
      sessionId,
      seq,
      path: eventPath(sessionId, seq),
    });
  }
  return normalized;
}

async function loadLogicalStoredEvent(sessionId, seq, {
  uncached = false,
  metaOverride = null,
  historyBaseOverride = undefined,
  strict = false,
} = {}) {
  const meta = metaOverride || await loadMeta(sessionId, { strict });
  const usesSharedPrefix = meta.historyStorage === 'shared-prefix-v1';
  const historyBase = usesSharedPrefix
    ? (historyBaseOverride !== undefined
      ? historyBaseOverride
      : await getHistoryBase(sessionId, { required: true }))
    : null;
  // A materialization clears the marker before removing the old base file so
  // a crash in that small window still reads the newly copied local events.
  // Do not let a stale base file redirect a session that is already marked as
  // local storage back to a source that may have been deleted.
  const source = usesSharedPrefix
    ? await resolveHistoryEventSource(sessionId, seq, { initialBase: historyBase })
    : { sessionId, seq };
  if (!source) return null;
  const stored = uncached
    ? await loadStoredEventUncached(source.sessionId, source.seq, { strict })
    : await loadStoredEvent(source.sessionId, source.seq, { strict });
  if (strict && !stored) {
    throw historyReadError('SESSION_HISTORY_GAP', `History event ${seq} is unavailable for ${sessionId}`, {
      sessionId,
      seq,
    });
  }
  if (!stored) return null;
  return {
    event: stored,
    sourceSessionId: source.sessionId,
    sourceSeq: source.seq,
    shared: source.sessionId !== sessionId || source.seq !== seq,
  };
}

// A single read request commonly hydrates dozens or hundreds of events. Keep
// its validated metadata/base in a tiny immutable context so each event does
// not clone meta.json and re-enter the shared-prefix resolver independently.
async function createHistoryReadContext(sessionId, metaOverride = null, { strict = false } = {}) {
  const meta = metaOverride || await loadMeta(sessionId, { strict });
  await assertHistoryReadable(sessionId, meta);
  const historyBase = meta.historyStorage === 'shared-prefix-v1'
    ? await getHistoryBase(sessionId, { required: true })
    : null;
  return { meta, historyBase, strict };
}

function logicalEventOptions(readContext, extra = {}) {
  return {
    ...extra,
    metaOverride: readContext.meta,
    historyBaseOverride: readContext.historyBase,
    strict: readContext.strict === true,
  };
}

function sanitizeSharedHistoryEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const next = clone(event);
  delete next.runId;
  delete next.requestId;
  delete next.responseId;
  delete next.bodyRef;
  return stripEventAttachmentSavedPaths(next);
}

async function hydrateLogicalEvent(sessionId, logical, includeBodies, {
  maxBodyBytes = MAX_EVENT_RANGE_BODY_BYTES,
  strict = false,
} = {}) {
  if (!logical?.event) return null;
  let event = clone(logical.event);
  if (includeBodies && event.bodyRef && event.bodyField) {
    if (Number.isFinite(event.bodyBytes) && event.bodyBytes > maxBodyBytes) {
      // Externalized events retain a bounded inline preview in the event
      // record itself. Prefer that preview over a generic truncation marker so
      // callers never render an apparent error merely because a safety budget
      // was reached; the dedicated body endpoint remains available for the
      // full value when a user explicitly asks for it.
      const inlinePreview = typeof event[event.bodyField] === 'string'
        ? event[event.bodyField]
        : '';
      event[event.bodyField] = typeof event.bodyPreview === 'string' && event.bodyPreview
        ? event.bodyPreview
        : inlinePreview
          ? clipMiddle(inlinePreview, Math.min(inlinePreview.length, 1600))
        : `[body truncated: ${event.bodyBytes} bytes exceeds the ${maxBodyBytes}-byte range limit]`;
      event.bodyTruncated = true;
      event.bodyLoaded = true;
    } else {
      event[event.bodyField] = await readBody(logical.sourceSessionId, event.bodyRef, {
        maxBytes: maxBodyBytes,
        strict,
      });
      event.bodyLoaded = true;
    }
  }
  // Legacy records may still keep their body inline without a bodyRef. Apply
  // the same per-event guard so an old large event cannot bypass the range
  // budget merely because it predates body externalization.
  if (includeBodies && event.bodyField) {
    const inlineBody = typeof event[event.bodyField] === 'string' ? event[event.bodyField] : '';
    if (inlineBody && Buffer.byteLength(inlineBody, 'utf8') > maxBodyBytes) {
      event[event.bodyField] = clipMiddle(inlineBody, Math.max(256, Math.floor(maxBodyBytes / 2)));
      event.bodyTruncated = true;
      event.bodyLoaded = true;
    }
  }
  if (logical.shared) {
    event = sanitizeSharedHistoryEvent(event);
    if (event) event.seq = logical.event.seq;
  }
  return event;
}

// Body hydration can be just as expensive as loading the event index itself:
// long assistant/tool bodies are separate files and decompression allocates a
// temporary buffer. Keep multi-event hydration on the same bounded pool so a
// large page cannot turn a safe event-read batch into an unbounded body burst.
async function hydrateLogicalEventsBatched(sessionId, logicalEvents, includeBodies, {
  maxBodyBytes = MAX_EVENT_RANGE_BODY_BYTES,
  priority = 'normal',
  strict = false,
} = {}) {
  if (!Array.isArray(logicalEvents) || logicalEvents.length === 0) return [];
  const includeFor = typeof includeBodies === 'function'
    ? includeBodies
    : () => includeBodies === true;
  return mapWithAdaptiveConcurrency(
    logicalEvents,
    (logical) => hydrateLogicalEvent(sessionId, logical, includeFor(logical), { maxBodyBytes, strict }),
    { priority },
  );
}

// Select bodies against the response budget before starting hydration. The
// previous implementation hydrated an entire 256/1000-event batch and only
// then discovered that the serialized page was over budget, which made the
// aggregate cap ineffective as an RSS guard for large message bodies.
function estimateLogicalEventBytes(logical, includeBody, maxBodyBytes) {
  const event = logical?.event;
  if (!event || typeof event !== 'object') return 0;
  const compact = serializeEventForIndex(event, {
    includeBodies: false,
    includeMessageBodies: false,
  });
  let total = approximateEventBytes(compact);
  if (!includeBody) return total;
  const bodyField = event.bodyField || eventBodyField(event);
  if (!bodyField) return total;
  const declaredBytes = Number(event.bodyBytes);
  if (Number.isFinite(declaredBytes) && declaredBytes > 0) {
    return total + Math.min(declaredBytes, maxBodyBytes);
  }
  const inlineBody = typeof event[bodyField] === 'string' ? event[bodyField] : '';
  return total + Math.min(Buffer.byteLength(inlineBody, 'utf8'), maxBodyBytes);
}

function selectLogicalEventsWithinResponseBudget(logicalEvents, includeFor, {
  currentBytes = 0,
  maxResponseBytes = Number.POSITIVE_INFINITY,
  maxBodyBytes = MAX_EVENT_RANGE_BODY_BYTES,
  throwOnLimit = false,
} = {}) {
  const selected = [];
  let estimatedBytes = Math.max(0, Number(currentBytes) || 0);
  let truncatedByBytes = false;
  for (const logical of Array.isArray(logicalEvents) ? logicalEvents : []) {
    const includeBody = includeFor(logical);
    const estimate = estimateLogicalEventBytes(logical, includeBody, maxBodyBytes);
    if (
      Number.isFinite(maxResponseBytes)
      && selected.length > 0
      && estimatedBytes + estimate > maxResponseBytes
    ) {
      truncatedByBytes = true;
      if (throwOnLimit) {
        throw Object.assign(new Error(`Event range exceeds the ${maxResponseBytes}-byte response limit`), {
          code: 'EVENT_RANGE_TOO_LARGE',
          maxBytes: maxResponseBytes,
        });
      }
      break;
    }
    // Always select the first logical event so a tiny caller budget still
    // makes pagination progress. The hydration body limit is reduced to the
    // response budget below, so this cannot allocate the original giant body.
    selected.push(logical);
    estimatedBytes += estimate;
  }
  return { selected, truncatedByBytes };
}

function serializedEventBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return approximateEventBytes(value);
  }
}

function fitEventToResponseBudget(event, maxBytes) {
  if (!event || !Number.isFinite(maxBytes) || maxBytes <= 0) return event;
  if (serializedEventBytes(event) <= maxBytes) return event;
  const bodyField = event.bodyField || eventBodyField(event);
  const body = bodyField && typeof event[bodyField] === 'string' ? event[bodyField] : '';
  if (body) {
    const base = { ...event, [bodyField]: '' };
    const available = Math.max(0, maxBytes - serializedEventBytes(base));
    if (available > 128) {
      let fitted = {
        ...event,
        [bodyField]: clipMiddle(body, Math.max(64, Math.floor(available * 0.45))),
        bodyTruncated: true,
        bodyLoaded: true,
      };
      while (serializedEventBytes(fitted) > maxBytes && fitted[bodyField].length > 64) {
        fitted = {
          ...fitted,
          [bodyField]: clipMiddle(fitted[bodyField], Math.max(64, Math.floor(fitted[bodyField].length * 0.7))),
        };
      }
      if (serializedEventBytes(fitted) <= maxBytes) return fitted;
    }
  }
  const fallback = {
    seq: event.seq,
    type: event.type,
    ...(typeof event.role === 'string' ? { role: event.role } : {}),
    ...(typeof event.id === 'string' ? { id: event.id } : {}),
    ...(bodyField ? {
      bodyField,
      [bodyField]: typeof event.bodyPreview === 'string' && event.bodyPreview
        ? event.bodyPreview
        : '[body truncated]',
      bodyAvailable: true,
      bodyLoaded: true,
      bodyTruncated: true,
    } : {}),
  };
  return serializedEventBytes(fallback) <= maxBytes ? fallback : {
    seq: event.seq,
    type: event.type,
  };
}

async function assertHistoryReadable(sessionId, meta) {
  if (meta?.historyStorage !== 'shared-prefix-v1') return;
  await getHistoryBase(sessionId, { required: true, validate: true });
}

// Memo of countMessageEventsAfter results: the scan is O(latestSeq) with a
// per-event clone, and getHistorySnapshot calls it for every compacted session
// on every sidebar/detail render (enrichSessionMeta). The memo is keyed on the
// exact inputs, so it is only ever a pure speedup; cleared with the session.
const messageCountAfterCache = makeLruOrMap({ maxEntries: 500 });

async function countMessageEventsAfter(sessionId, afterSeq = 0, options = {}) {
  const strict = options?.strict === true;
  const meta = await loadMeta(sessionId, { strict });
  const cached = strict ? null : messageCountAfterCache.get(sessionId);
  const latestSeq = Number.isInteger(meta.latestSeq) ? meta.latestSeq : 0;
  let count = 0;
  let startSeq = Math.max(1, afterSeq + 1);
  // During a long streaming Run latestSeq advances on every persisted event.
  // Reuse the exact same activeFromSeq prefix and scan only the newly appended
  // suffix. If a compaction/fork ever moves the sequence backwards, the
  // monotonicity check below naturally falls back to a fresh scan.
  if (cached?.forActiveFromSeq === afterSeq
    && Number.isInteger(cached.forLatestSeq)
    && latestSeq >= cached.forLatestSeq) {
    count = Number.isInteger(cached.count) ? cached.count : 0;
    startSeq = Math.max(startSeq, cached.forLatestSeq + 1);
    if (startSeq > latestSeq) return count;
  }
  const readContext = await createHistoryReadContext(sessionId, meta, { strict });
  for (const seqs of seqRangeChunks(startSeq, latestSeq, HISTORY_READ_BATCH_SIZE)) {
    const logicalEvents = await readLogicalEventsBatched(sessionId, seqs, readContext, {
      priority: options?.priority === 'interactive' ? 'interactive' : 'normal',
    });
    for (const logical of logicalEvents) {
      if (logical?.event?.type === 'message') {
        count += 1;
      }
    }
  }
  messageCountAfterCache.set(sessionId, { forLatestSeq: latestSeq, forActiveFromSeq: afterSeq, count });
  return count;
}

async function hydrateEvent(sessionId, event) {
  if (!event?.bodyRef || !event?.bodyField) return event;
  const hydrated = { ...event };
  hydrated[hydrated.bodyField] = await readBody(sessionId, hydrated.bodyRef);
  hydrated.bodyLoaded = true;
  return hydrated;
}

// Bounded page reads keep tool/reasoning bodies deferred, but a message body
// left behind IS user-visible transcript text: storeEvent externalizes long
// assistant summaries (>inlineLimitFor) as content: '' + bodyRef, and the
// display projection then strips the lazy markers, so an unhydrated page
// shows those turns as empty bubbles. Callers that ask for message bodies
// get them inlined, matching scanStoredEvents' includeMessageBodies
// contract; everything else stays deferred.
function shouldHydrateLogicalEventBody(event, options = {}) {
  if (options.includeBodies === true) return true;
  return (event?.type === 'message' && options.includeMessageBodies === true)
    || (event?.type === 'reasoning' && options.includeReasoningBodies === true);
}

function incrementCounts(counts, event) {
  const next = { ...(counts || {}) };
  next[event.type] = (next[event.type] || 0) + 1;
  if (event.type === 'message' && event.role === 'user') {
    next.message_user = (next.message_user || 0) + 1;
  }
  if (event.type === 'message' && event.role === 'assistant') {
    next.message_assistant = (next.message_assistant || 0) + 1;
  }
  return next;
}

function getAssistantMessageTimestamp(currentStamp, event) {
  if (event?.type !== 'message' || event.role !== 'assistant') {
    return currentStamp || null;
  }
  return event.timestamp || currentStamp || Date.now();
}

const RUN_BOUND_APPROVAL_REQUEST_TYPES = new Set([
  'approval_request',
  'privileged_batch_request',
  'approved_action_batch_request',
]);

async function terminalRunApprovalReplacements(sessionId, event, runCache) {
  if (!RUN_BOUND_APPROVAL_REQUEST_TYPES.has(String(event?.type || ''))) return null;
  const runId = String(event?.runId || '').trim();
  if (!runId) return null;
  let run;
  if (runCache.has(runId)) {
    run = runCache.get(runId);
  } else {
    try {
      run = await getRun(runId);
      runCache.set(runId, run || null);
    } catch {
      // A transient run-store read failure must not discard a possibly-live
      // approval. The bounded run-finalize/boot sweeps remain the fallback.
      return null;
    }
  }
  // A missing run cannot accept an approval either. Treat it as closed so an
  // orphaned replay never creates a card with an action that can only 404.
  if (run && !isTerminalRunState(run.state)) return null;

  const requestId = String(event?.requestId || event?.turnId || '').trim();
  const common = {
    runId,
    ...(requestId ? { requestId } : {}),
    source: 'terminal-run-admission',
    timestamp: new Date().toISOString(),
  };
  if (event.type === 'approval_request') {
    const response = approvalResponseEvent({
      approvalId: String(event?.approvalId || '').trim(),
      decision: 'cancelled',
      status: 'cancelled',
      source: common.source,
      providerRequestId: String(event?.providerRequestId || '').trim(),
      providerMethod: String(event?.providerMethod || '').trim(),
    });
    return response ? [{ ...response, ...common }] : [];
  }
  if (event.type === 'privileged_batch_request') {
    const batchId = String(event?.batchId || '').trim();
    if (!batchId) return [];
    const responses = ['other', 'delete', 'installAuto']
      .filter((category) => Array.isArray(event?.[category]) && event[category].length > 0)
      .map((category) => privilegedBatchResponseEvent({
        batchId,
        category,
        decisions: {},
        source: common.source,
      }))
      .filter(Boolean)
      .map((response) => ({ ...response, ...common }));
    return responses.length > 0
      ? responses
      : [{ type: 'approval_response', role: 'system', approvalId: batchId, decision: 'cancelled', status: 'cancelled', ...common }];
  }

  const batchId = String(event?.batchId || '').trim();
  const actions = Array.isArray(event?.actions) ? event.actions : [];
  if (!batchId || actions.length === 0) return [];
  const decisions = {};
  for (const action of actions) {
    const actionId = String(action?.actionId || '').trim();
    if (actionId) decisions[actionId] = 'cancelled';
  }
  if (Object.keys(decisions).length === 0) return [];
  return [{
    type: 'approved_action_batch_response',
    role: 'system',
    channel: event.channel || 'approved_action',
    schemaVersion: event.schemaVersion,
    batchId,
    ...(event.sessionId ? { sessionId: event.sessionId } : { sessionId }),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    decisions,
    ...common,
  }];
}

async function appendEventUnlocked(sessionId, event, options = {}) {
  if (options.skipTerminalApprovalGuard !== true) {
    const replacements = await terminalRunApprovalReplacements(sessionId, event, new Map());
    if (replacements !== null) {
      if (replacements.length === 0) return null;
      const stored = await appendEventsUnlocked(sessionId, replacements, { skipTerminalApprovalGuard: true });
      return stored.at(-1) || null;
    }
  }
  await ensureSessionDir(sessionId);
  const meta = await loadMeta(sessionId);
  const seq = meta.latestSeq + 1;
  const normalized = await prepareStoredMessageIdentity(sessionId, normalizeStoredEvent({ ...event, seq }, seq));
  normalized.seq = seq;
  const stored = await storeEvent(sessionId, annotateAttachmentsWithArtifactIds(normalized, sessionId));
  await commitStoredMessagePosition(sessionId, stored);
  const lastActivityAt = isSessionActivityEvent(stored)
    ? latestTimestamp(meta.lastActivityAt, eventTimestamp(stored))
    : (meta.lastActivityAt || null);
  await saveMetaUnlocked(sessionId, {
    ...meta,
    latestSeq: seq,
    lastEventAt: stored.timestamp || Date.now(),
    lastActivityAt,
    lastAssistantMessageAt: getAssistantMessageTimestamp(meta.lastAssistantMessageAt, stored),
    size: meta.size + 1,
    counts: incrementCounts(meta.counts, stored),
    ...(meta.historyStorage === 'shared-prefix-v1' ? { historyIndexState: 'pending' } : {}),
  });
  if (meta.historyStorage === 'shared-prefix-v1') scheduleForkHistoryIndexBuild(sessionId);
  try {
    await updateSessionAuditProjectionForEvents(sessionId, [stored], { latestSeq: seq });
  } catch (error) {
    console.warn('[chat] session audit projection update failed', {
      sessionId,
      seq,
      error: error?.message || String(error),
    });
  }
  try {
    if (eventLookupKey(stored)) await appendEventLookupIndex(sessionId, [stored], seq);
  } catch (error) {
    // The lookup index is an optimization only; event files remain the
    // source of truth and ensureEventLookupIndex will rebuild after a failure.
    console.warn('[history] event lookup index update failed', {
      sessionId,
      seq,
      error: error?.message || String(error),
    });
  }
  if (stored?.type === 'approval_request' || stored?.type === 'privileged_batch_request'
    || stored?.type === 'approved_action_batch_request') {
    // Fire a one-shot "needs your attention" push for live approval requests —
    // danger-tier privileged batches included (Phase 5: their top-level risk
    // maps to the same 'danger' waiting label). Fire-and-forget: never block
    // the append path on a push attempt.
    maybeNotifyApprovalPending(sessionId, stored).catch(() => {});
  }

  if (stored?.type === 'approval_request'
    || stored?.type === 'approval_response'
    || stored?.type === 'privileged_batch_request'
    || stored?.type === 'privileged_batch_response') {
    // The history event is authoritative.  The generic orchestration ledger
    // is only an observational Interrupt projection and must never make an
    // otherwise successful append fail or wait on SQLite.
    void mirrorApprovalEventsToOrchestration({ sessionId, events: [stored] }).catch((error) => {
      console.warn('[orchestration] approval projection failed', {
        sessionId,
        seq,
        type: stored.type,
        error: error?.message || String(error),
      });
    });
  }
  notifySessionEvents(sessionId, seq);
  return stored;
}

async function appendEventsUnlocked(sessionId, events, options = {}) {
  if (options.skipTerminalApprovalGuard !== true) {
    const runCache = new Map();
    const guarded = [];
    for (const event of events || []) {
      const replacements = await terminalRunApprovalReplacements(sessionId, event, runCache);
      if (replacements === null) guarded.push(event);
      else guarded.push(...replacements);
    }
    events = guarded;
  }
  if (!Array.isArray(events) || events.length === 0) return [];
  await ensureSessionDir(sessionId);
  const meta = await loadMeta(sessionId);
  let latestSeq = meta.latestSeq;
  let lastEventAt = meta.lastEventAt;
  let lastActivityAt = meta.lastActivityAt || null;
  let lastAssistantMessageAt = meta.lastAssistantMessageAt;
  let size = meta.size;
  let counts = meta.counts;
  const appended = [];
  for (const event of events || []) {
    latestSeq += 1;
    const normalized = await prepareStoredMessageIdentity(sessionId, normalizeStoredEvent({ ...event, seq: latestSeq }, latestSeq));
    normalized.seq = latestSeq;
    const stored = await storeEvent(sessionId, annotateAttachmentsWithArtifactIds(normalized, sessionId));
    await commitStoredMessagePosition(sessionId, stored);
    appended.push(stored);
    lastEventAt = stored.timestamp || lastEventAt;
    if (isSessionActivityEvent(stored)) {
      lastActivityAt = latestTimestamp(lastActivityAt, eventTimestamp(stored));
    }
    lastAssistantMessageAt = getAssistantMessageTimestamp(lastAssistantMessageAt, stored);
    size += 1;
    counts = incrementCounts(counts, stored);
  }
  await saveMetaUnlocked(sessionId, {
    ...meta,
    latestSeq,
    lastEventAt,
    lastActivityAt,
    lastAssistantMessageAt,
    size,
    counts,
    ...(meta.historyStorage === 'shared-prefix-v1' ? { historyIndexState: 'pending' } : {}),
  });
  if (meta.historyStorage === 'shared-prefix-v1' && appended.length > 0) scheduleForkHistoryIndexBuild(sessionId);
  if (appended.length > 0) {
    try {
      await updateSessionAuditProjectionForEvents(sessionId, appended, { latestSeq });
    } catch (error) {
      console.warn('[chat] session audit projection batch update failed', {
        sessionId,
        latestSeq,
        count: appended.length,
        error: error?.message || String(error),
      });
    }
    try {
      const indexedEvents = appended.filter((event) => eventLookupKey(event));
      if (indexedEvents.length > 0) await appendEventLookupIndex(sessionId, indexedEvents, latestSeq);
    } catch (error) {
      console.warn('[history] event lookup index batch update failed', {
        sessionId,
        latestSeq,
        count: appended.length,
        error: error?.message || String(error),
      });
    }
    const approvalEvents = appended.filter((event) => event?.type === 'approval_request'
      || event?.type === 'approval_response'
      || event?.type === 'confirmation_response'
      || event?.type === 'privileged_batch_request'
      || event?.type === 'privileged_batch_response'
      || event?.type === 'approved_action_batch_request'
      || event?.type === 'approved_action_batch_response'
      || event?.type === 'approved_action_state');
    if (approvalEvents.length > 0) {
      // Preserve event order for request→response batches while keeping the
      // canonical append path independent from projection availability.
      void mirrorApprovalEventsToOrchestration({ sessionId, events: approvalEvents }).catch((error) => {
        console.warn('[orchestration] approval batch projection failed', {
          sessionId,
          latestSeq,
          count: approvalEvents.length,
          error: error?.message || String(error),
        });
      });
      for (const event of approvalEvents) {
        if (RUN_BOUND_APPROVAL_REQUEST_TYPES.has(String(event?.type || ''))) {
          maybeNotifyApprovalPending(sessionId, event).catch(() => {});
        }
      }
    }
    notifySessionEvents(sessionId, latestSeq);
  }
  return appended;
}

async function findLatestAssistantMessageAt(sessionId, latestSeq = 0, options = {}) {
  const readContext = await createHistoryReadContext(sessionId, null, {
    strict: options?.strict === true,
  });
  for (const seqs of descSeqRangeChunks(Math.max(1, latestSeq), 1, HISTORY_DESC_SCAN_BATCH)) {
    const logicalEvents = await readLogicalEventsBatched(sessionId, seqs, readContext, {
      priority: options?.priority === 'interactive' ? 'interactive' : 'normal',
    });
    for (const logical of logicalEvents) {
      const stored = logical?.event;
      if (stored?.type === 'message' && stored.role === 'assistant') {
        return stored.timestamp || null;
      }
    }
  }
  return null;
}

function clearSessionCaches(sessionId) {
  metaCache.delete(sessionId);
  contextCache.delete(sessionId);
  forkContextCache.delete(sessionId);
  messageCountAfterCache.delete(sessionId);
  for (const key of [...eventCache.keys()]) {
    if (key.startsWith(`${sessionId}:`)) eventCache.delete(key);
  }
  for (const key of [...bodyCache.keys()]) {
    if (key.startsWith(`${sessionId}:`)) bodyCache.delete(key);
  }
  eventLookupIndexCache.delete(sessionId);
  cancelPendingEventLookupIndexWrite(sessionId);
}

async function clearHistoryUnlocked(sessionId) {
  await removePath(sessionDir(sessionId));
  clearSessionCaches(sessionId);
  clearHistoryBaseCache(sessionId);
}

export async function removeSessionHistory(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return false;
  if (forkHistoryIndexTasks.has(normalizedSessionId)) {
    cancelledForkHistoryIndexTasks.add(normalizedSessionId);
  } else {
    cancelledForkHistoryIndexTasks.delete(normalizedSessionId);
  }
  await runSessionMutation(normalizedSessionId, async () => {
    await clearHistoryUnlocked(normalizedSessionId);
  });
  return true;
}

async function readForkPrefixSnapshot(sourceSessionId, throughSeq, sourceMeta) {
  if (throughSeq <= 0) {
    return { stats: createForkHistoryStats(), continuity: null, throughSeq: 0 };
  }
  const sourceStatsAreExact = sourceMeta?.historyStatsState !== 'pending'
    && throughSeq === (sourceMeta?.latestSeq || 0);
  if (sourceStatsAreExact) {
    const continuity = await defaultContinuityStore.read(sourceSessionId).catch(() => null);
    return {
      stats: {
        latestSeq: throughSeq,
        size: sourceMeta.size || throughSeq,
        lastEventAt: sourceMeta.lastEventAt || null,
        lastActivityAt: sourceMeta.lastActivityAt || null,
        lastAssistantMessageAt: sourceMeta.lastAssistantMessageAt || null,
        counts: { ...(sourceMeta.counts || {}) },
      },
      continuity: continuity && continuity.coverage?.coveredThroughSeq >= throughSeq
        && continuity.coverage?.omittedRanges?.length === 0
        ? continuity
        : null,
      throughSeq,
    };
  }
  const index = await readForkHistoryIndex(sourceSessionId);
  return completeForkHistoryPrefixSnapshot({
    index,
    throughSeq,
    sessionId: sourceSessionId,
    forEachEvent: (visitor, options) => forEachStoredEvent(sourceSessionId, visitor, options),
  });
}

async function updateMetaFromForkIndex(sessionId, index) {
  const checkpoint = index?.checkpoints?.at(-1);
  if (!checkpoint?.stats) return false;
  return runSessionMutation(sessionId, async () => {
    if (cancelledForkHistoryIndexTasks.has(sessionId)) return false;
    const current = await loadMeta(sessionId);
    // Appends share this keyed queue. The compare and write must be inside it,
    // otherwise an append between the two could be overwritten by stale index
    // metadata and make the next sequence number move backwards.
    if (current.latestSeq !== index.builtThroughSeq) return false;
    await saveMetaUnlocked(sessionId, {
      ...current,
      ...checkpoint.stats,
      counts: { ...(checkpoint.stats.counts || {}) },
      historyStatsState: 'ready',
      historyIndexState: 'ready',
      hasVisibleHistory: current.hasVisibleHistory === true || current.latestSeq > 0,
    });
    if (checkpoint.continuity) {
      const state = { ...checkpoint.continuity, sessionId };
      const previous = await defaultContinuityStore.read(sessionId).catch(() => null);
      await defaultContinuityStore.write(sessionId, state, {
        expectedRevision: previous?.revision || 0,
      }).catch(() => {});
    }
    return true;
  });
}

export function scheduleForkHistoryIndexBuild(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId || forkHistoryIndexTasks.has(normalizedSessionId)) return false;
  cancelledForkHistoryIndexTasks.delete(normalizedSessionId);
  const task = new Promise((resolve) => {
    const timer = setTimeout(() => {
      void (async () => {
        let reschedule = false;
        try {
          if (cancelledForkHistoryIndexTasks.has(normalizedSessionId)) return;
          const meta = await loadMeta(normalizedSessionId);
          const index = await buildForkHistoryIndex({
            sessionId: normalizedSessionId,
            latestSeq: meta.latestSeq || 0,
            forEachEvent: (visitor, options) => forEachStoredEvent(normalizedSessionId, visitor, options),
          });
          if (cancelledForkHistoryIndexTasks.has(normalizedSessionId)) return;
          await writeForkHistoryIndex(normalizedSessionId, index);
          const updated = await updateMetaFromForkIndex(normalizedSessionId, index);
          if (updated) {
            await ensureSessionAuditProjection(normalizedSessionId, {
              latestSeq: index.builtThroughSeq,
              loadEvents: () => streamStoredEvents(normalizedSessionId),
            }).catch((error) => {
              console.warn('[history] fork audit projection rebuild failed', {
                sessionId: normalizedSessionId,
                error: error?.message || String(error),
              });
            });
          }
          if (!updated) {
            await runSessionMutation(normalizedSessionId, async () => {
              const current = await loadMeta(normalizedSessionId);
              if (current.historyStatsState === 'pending') {
                await saveMetaUnlocked(normalizedSessionId, { ...current, historyIndexState: 'pending' });
              }
            });
            reschedule = true;
          }
        } catch (error) {
          console.warn('[history] fork history index build failed', {
            sessionId: normalizedSessionId,
            code: error?.code,
            error: error?.message || String(error),
          });
        } finally {
          forkHistoryIndexTasks.delete(normalizedSessionId);
          if (cancelledForkHistoryIndexTasks.has(normalizedSessionId)) {
            cancelledForkHistoryIndexTasks.delete(normalizedSessionId);
          }
          if (reschedule) scheduleForkHistoryIndexBuild(normalizedSessionId);
          resolve();
        }
      })();
    }, FORK_HISTORY_INDEX_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
  forkHistoryIndexTasks.set(normalizedSessionId, task);
  return true;
}

export async function waitForForkHistoryIndexBuild(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return null;
  if (!forkHistoryIndexTasks.has(normalizedSessionId)) scheduleForkHistoryIndexBuild(normalizedSessionId);
  const task = forkHistoryIndexTasks.get(normalizedSessionId) || null;
  if (!task) return null;
  // An unref'ed background timer is correct for normal server shutdown, but a
  // caller explicitly waiting for the build (run finalization/tests) must keep
  // the process alive until its promise settles.
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    return await task;
  } finally {
    clearInterval(keepAlive);
  }
}

export async function initializeForkHistory(sessionId, {
  sourceSessionId,
  throughSeq = 0,
  sourceLatestSeqAtFork = 0,
} = {}) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const normalizedSourceSessionId = typeof sourceSessionId === 'string' ? sourceSessionId.trim() : '';
  if (!normalizedSessionId || !normalizedSourceSessionId) throw new Error('fork history source and child are required');
  const normalizedThroughSeq = Number.isInteger(throughSeq) && throughSeq >= 0 ? throughSeq : 0;
  return runSessionMutation(normalizedSessionId, async () => {
    const sourceMeta = await loadMeta(normalizedSourceSessionId);
    if (sourceMeta.historyStorage === 'shared-prefix-v1') {
      await getHistoryBase(normalizedSourceSessionId, { required: true, validate: true });
    }
    const prefix = await readForkPrefixSnapshot(normalizedSourceSessionId, normalizedThroughSeq, sourceMeta);
    const base = await writeHistoryBase(normalizedSessionId, {
      childSessionId: normalizedSessionId,
      sourceSessionId: normalizedSourceSessionId,
      throughSeq: normalizedThroughSeq,
      sourceThroughSeq: normalizedThroughSeq,
      sourceLatestSeqAtFork: sourceLatestSeqAtFork || sourceMeta.latestSeq || normalizedThroughSeq,
      createdAt: new Date().toISOString(),
      immutable: true,
    });
    const stats = prefix?.stats || {
      latestSeq: normalizedThroughSeq,
      size: normalizedThroughSeq,
      lastEventAt: null,
      lastActivityAt: null,
      lastAssistantMessageAt: null,
      counts: {},
    };
    const ready = !!prefix;
    await saveMetaUnlocked(normalizedSessionId, {
      ...emptyMeta(),
      ...stats,
      latestSeq: normalizedThroughSeq,
      size: stats.size || normalizedThroughSeq,
      counts: { ...(stats.counts || {}) },
      hasVisibleHistory: normalizedThroughSeq > 0,
      historyStorage: 'shared-prefix-v1',
      historyStatsState: ready ? 'ready' : 'pending',
      historyIndexState: ready ? 'ready' : 'pending',
    });
    if (prefix) {
      const sourceIndex = await readForkHistoryIndex(normalizedSourceSessionId);
      const inheritedCheckpoints = sourceIndex?.complete === true
        ? sourceIndex.checkpoints.filter((checkpoint) => checkpoint.throughSeq < normalizedThroughSeq)
        : [];
      await writeForkHistoryIndex(normalizedSessionId, {
        schemaVersion: 1,
        sessionId: normalizedSessionId,
        interval: 512,
        builtThroughSeq: normalizedThroughSeq,
        sourceLatestSeq: normalizedThroughSeq,
        complete: true,
        checkpoints: [
          ...inheritedCheckpoints,
          {
            throughSeq: normalizedThroughSeq,
            stats: prefix.stats,
            continuity: prefix.continuity,
          },
        ],
      });
      if (prefix.continuity) {
        await defaultContinuityStore.write(normalizedSessionId, {
          ...prefix.continuity,
          sessionId: normalizedSessionId,
        }, { expectedRevision: 0 }).catch(() => {});
      }
    } else {
      scheduleForkHistoryIndexBuild(normalizedSessionId);
    }
    return { base, stats, indexed: ready };
  });
}

export async function markSharedForkHistoryPending(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) throw new Error('fork history child session id is required');
  return runSessionMutation(normalizedSessionId, async () => {
    const current = await loadMeta(normalizedSessionId);
    if (current.historyStorage === 'shared-prefix-v1' && current.hasVisibleHistory === false) {
      return current;
    }
    return saveMetaUnlocked(normalizedSessionId, {
      ...current,
      historyStorage: 'shared-prefix-v1',
      historyStatsState: 'pending',
      historyIndexState: 'pending',
      hasVisibleHistory: false,
    });
  });
}

export async function getHistoryBase(sessionId, { required = false, validate = false } = {}) {
  const base = await readHistoryBase(sessionId);
  if (!base && required) {
    const error = new Error(`history base is unavailable for ${sessionId}`);
    error.code = 'HISTORY_BASE_UNAVAILABLE';
    error.statusCode = 409;
    throw error;
  }
  if (base && validate) await validateHistoryBaseChain(sessionId);
  return base;
}

/**
 * Convert a shared-prefix fork back into an ordinary local history store.
 *
 * This is used before deleting a source session that still has live fork
 * children. The child keeps its logical transcript and local tail, while the
 * shared prefix is copied with the same sanitization used by normal shared
 * reads (no parent run/request identity and no source body references).
 */
export async function materializeSharedHistory(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return { materialized: false, sessionId: normalizedSessionId };
  return runSessionMutation(normalizedSessionId, async () => {
    const meta = await loadMeta(normalizedSessionId);
    const base = await readHistoryBase(normalizedSessionId);
    if (!base) return { materialized: false, sessionId: normalizedSessionId };
    if (base.throughSeq > (meta.latestSeq || 0)) {
      const error = new Error(`history base extends beyond the child history for ${normalizedSessionId}`);
      error.code = 'HISTORY_BASE_UNAVAILABLE';
      error.statusCode = 409;
      throw error;
    }

    await validateHistoryBaseChain(normalizedSessionId);
    if (forkHistoryIndexTasks.has(normalizedSessionId)) {
      // Prevent an already queued index build from restoring shared-prefix
      // metadata after this operation has switched the child to local storage.
      cancelledForkHistoryIndexTasks.add(normalizedSessionId);
    }

    let stats = createForkHistoryStats();
    const readContext = { meta, historyBase: base };
    for (let seq = 1; seq <= (meta.latestSeq || 0); seq += 1) {
      const logical = await loadLogicalStoredEvent(
        normalizedSessionId,
        seq,
        logicalEventOptions(readContext),
      );
      if (!logical?.event) {
        const error = new Error(`history event ${seq} is unavailable for ${normalizedSessionId}`);
        error.code = 'HISTORY_BASE_UNAVAILABLE';
        error.statusCode = 409;
        throw error;
      }
      let event = logical.event;
      if (seq <= base.throughSeq) {
        event = await hydrateLogicalEvent(normalizedSessionId, logical, true);
        if (!event) {
          const error = new Error(`history event ${seq} cannot be materialized for ${normalizedSessionId}`);
          error.code = 'HISTORY_BASE_UNAVAILABLE';
          error.statusCode = 409;
          throw error;
        }
        await storeEvent(normalizedSessionId, stripPersistedProviderCapabilities(event));
      }
      stats = applyForkHistoryStats(stats, event);
    }

    // Persist the local marker before removing the base file. loadLogicalStoredEvent
    // intentionally honors this order so a crash here remains readable from the
    // copied local prefix. The following removal is idempotent on retry.
    const localMeta = { ...meta, ...stats };
    delete localMeta.historyStorage;
    delete localMeta.historyStatsState;
    delete localMeta.historyIndexState;
    localMeta.hasVisibleHistory = meta.hasVisibleHistory === true || stats.latestSeq > 0;
    await saveMetaUnlocked(normalizedSessionId, localMeta);
    await removePath(historyBasePath(normalizedSessionId));
    await removeForkHistoryIndex(normalizedSessionId);
    clearHistoryBaseCache(normalizedSessionId);
    return {
      materialized: true,
      sessionId: normalizedSessionId,
      throughSeq: base.throughSeq,
      latestSeq: stats.latestSeq,
    };
  });
}

export async function loadHistory(sessionId, options = {}) {
  const readContext = await createHistoryReadContext(sessionId, null, { strict: options.strict === true });
  const { meta } = readContext;
  const includeBodies = options.includeBodies !== false;
  const fromSeq = Number.isInteger(options.fromSeq) && options.fromSeq > 0 ? options.fromSeq : 1;
  const toSeq = Number.isInteger(options.toSeq) && options.toSeq > 0
    ? Math.min(options.toSeq, meta.latestSeq)
    : meta.latestSeq;
  const events = [];
  const priority = options.priority === 'interactive' ? 'interactive' : 'normal';
  for (const seqs of seqRangeChunks(fromSeq, toSeq, HISTORY_READ_BATCH_SIZE)) {
    const logicalEvents = await readLogicalEventsBatched(sessionId, seqs, readContext, { priority });
    const hydrated = await hydrateLogicalEventsBatched(sessionId, logicalEvents, includeBodies, {
      priority,
      strict: options.strict === true,
    });
    for (const event of hydrated.filter(Boolean)) {
      events.push(event);
    }
  }
  return events;
}

// Scan the durable event index without building a transcript and without
// touching the read-through event/body caches. Housekeeping/recovery jobs
// often need to inspect a few event fields across every session; using
// loadHistory() for that work temporarily retained a full transcript for each
// session and could push the chat server into multi-GB RSS during boot.
// The callback may return false to stop the scan early.
export async function* streamStoredEvents(sessionId, options = {}) {
  const readContext = await createHistoryReadContext(sessionId, null, { strict: options.strict === true });
  const { meta } = readContext;
  const fromSeq = Number.isInteger(options.fromSeq) && options.fromSeq > 0 ? options.fromSeq : 1;
  const toSeq = Number.isInteger(options.toSeq) && options.toSeq > 0
    ? Math.min(options.toSeq, meta.latestSeq)
    : meta.latestSeq;
  if (toSeq < fromSeq) return;

  for (const seqs of seqRangeChunks(fromSeq, toSeq, HISTORY_READ_BATCH_SIZE)) {
    const logicalEvents = await readLogicalEventsBatched(sessionId, seqs, readContext, {
      uncached: true,
      priority: 'background',
    });
    for (let index = 0; index < logicalEvents.length; index += 1) {
      const logical = logicalEvents[index];
      const event = await hydrateLogicalEvent(sessionId, logical, false);
      if (!event) continue;
      yield event;
    }
  }
}

export async function forEachStoredEvent(sessionId, visitor, options = {}) {
  if (typeof visitor !== 'function') throw new TypeError('forEachStoredEvent requires a visitor');
  for await (const event of streamStoredEvents(sessionId, options)) {
    if (await visitor(event, event.seq) === false) return;
  }
}

export async function readLastEvent(sessionId, options = {}) {
  const readContext = await createHistoryReadContext(sessionId, null, { strict: options.strict === true });
  const { meta } = readContext;
  if (!(Number.isInteger(meta?.latestSeq) && meta.latestSeq > 0)) return null;
  const logical = await loadLogicalStoredEvent(sessionId, meta.latestSeq, logicalEventOptions(readContext));
  return hydrateLogicalEvent(sessionId, logical, options.includeBodies !== false, {
    strict: options.strict === true,
  });
}

export async function readLastTurnEvents(sessionId, options = {}) {
  const readContext = await createHistoryReadContext(sessionId, null, { strict: options.strict === true });
  const { meta } = readContext;
  const includeBodies = options.includeBodies !== false;
  const events = [];
  let done = false;
  for (const seqs of descSeqRangeChunks(meta.latestSeq, 1, HISTORY_DESC_SCAN_BATCH)) {
    if (done) break;
    const logicalEvents = await readLogicalEventsBatched(sessionId, seqs, readContext);
    const hydrated = await hydrateLogicalEventsBatched(sessionId, logicalEvents, includeBodies, {
      strict: options.strict === true,
    });
    for (const event of hydrated.filter(Boolean)) {
      events.unshift(event);
      if (event.type === 'message' && event.role === 'user') {
        done = true;
        break;
      }
    }
  }
  return events;
}

export async function findLatestAssistantMessage(sessionId, options = {}) {
  const strict = options?.strict === true;
  const readContext = await createHistoryReadContext(sessionId, null, { strict });
  const { meta } = readContext;
  const includeBodies = options.includeBodies !== false;
  const match = typeof options.match === 'function' ? options.match : null;
  for (const seqs of descSeqRangeChunks(meta.latestSeq, 1, HISTORY_DESC_SCAN_BATCH)) {
    const logicalEvents = await readLogicalEventsBatched(sessionId, seqs, readContext);
    for (const logical of logicalEvents) {
      const stored = await hydrateLogicalEvent(sessionId, logical, false, { strict });
      if (!stored) continue;
      if (stored.type === 'message' && stored.role === 'assistant' && (!match || match(stored))) {
        return includeBodies ? hydrateLogicalEvent(sessionId, logical, true, { strict }) : stored;
      }
    }
  }
  return null;
}

export async function getHistorySnapshot(sessionId, options = {}) {
  const summaryOnly = options?.summaryOnly === true;
  const strict = options?.strict === true;
  const [meta, context] = await Promise.all([
    loadMeta(sessionId, { strict }),
    loadContext(sessionId, { strict }),
  ]);
  const baseline = options?.baseline && typeof options.baseline === 'object'
    ? options.baseline
    : null;
  const requestedBeforeSeq = Number.isInteger(options?.beforeSeq) && options.beforeSeq >= 0
    ? options.beforeSeq
    : null;
  const hasBaseline = Boolean(baseline
    && requestedBeforeSeq !== null
    && Number(baseline.latestSeq) === requestedBeforeSeq);
  const effectiveLatestSeq = hasBaseline
    ? requestedBeforeSeq
    : (meta.latestSeq || 0);
  const statsPending = hasBaseline
    ? baseline.historyStatsState === 'pending'
    : meta.historyStatsState === 'pending' || meta.historyIndexState === 'pending';
  if (!summaryOnly && meta.historyStorage === 'shared-prefix-v1' && meta.hasVisibleHistory !== false) {
    await assertHistoryReadable(sessionId, meta);
  }
  const hasStoredActivityAt = hasBaseline
    ? true
    : Object.prototype.hasOwnProperty.call(meta || {}, 'lastActivityAt');
  const lastActivityAt = hasBaseline
    ? (baseline.lastActivityAt || null)
    : (summaryOnly
      ? ((meta.lastActivityAt || meta.lastEventAt || meta.updatedAt) || null)
      : (statsPending
        ? ((baseline?.lastActivityAt ?? meta.lastActivityAt) || null)
        : await findLatestSessionActivityAt(sessionId, meta, options)));
  if (!strict && !summaryOnly && !hasStoredActivityAt && !statsPending) {
    // Older installations have no activity index. Persist the derived value
    // once so subsequent list refreshes do not rescan the session history.
    await persistMissingSessionActivityAt(sessionId, lastActivityAt);
  }
  const activeFromSeq = Number.isInteger(context?.activeFromSeq) ? context.activeFromSeq : 0;
  const counts = hasBaseline ? { ...(baseline.counts || {}) } : { ...(meta.counts || {}) };
  const messageCount = statsPending
    ? null
    : (counts.message_user || 0) + (counts.message_assistant || 0);
  const activeMessageCount = summaryOnly
    ? (hasBaseline ? (baseline.activeMessageCount ?? messageCount) : (meta.activeMessageCount ?? messageCount))
    : (statsPending
      ? null
      : (hasBaseline
        ? (baseline.activeMessageCount ?? messageCount)
        : (activeFromSeq > 0
          ? await countMessageEventsAfter(sessionId, activeFromSeq, { priority: options.priority })
          : messageCount)));
  const lastAssistantMessageAt = hasBaseline
    ? (baseline.lastAssistantMessageAt || null)
    : (summaryOnly
      ? (meta.lastAssistantMessageAt || null)
      : ((meta.lastAssistantMessageAt || null)
        || (!statsPending && (
          (counts.message_assistant || 0) > 0
            ? await findLatestAssistantMessageAt(sessionId, effectiveLatestSeq, options)
            : null
        ))));
  return {
    latestSeq: effectiveLatestSeq,
    lastEventAt: (hasBaseline ? baseline.lastEventAt : meta.lastEventAt) || null,
    lastActivityAt,
    lastAssistantMessageAt,
    size: hasBaseline ? (baseline.size || effectiveLatestSeq) : (meta.size || 0),
    counts,
    messageCount,
    activeMessageCount,
    userMessageCount: statsPending ? null : (counts.message_user || 0),
    historyStatsState: statsPending ? 'pending' : 'ready',
    hasVisibleHistory: hasBaseline
      ? (baseline.hasVisibleHistory === true || effectiveLatestSeq > 0)
      : (meta.hasVisibleHistory === true || (meta.latestSeq || 0) > 0),
    contextMode: context?.mode || 'history',
    activeFromSeq,
    compactedThroughSeq: Number.isInteger(context?.compactedThroughSeq)
      ? context.compactedThroughSeq
      : (baseline?.compactedThroughSeq || 0),
    contextTokenEstimate: Number.isInteger(context?.inputTokens) ? context.inputTokens : null,
    contextUpdatedAt: context?.updatedAt || null,
  };
}

// Provider capabilities are run-level metadata whose authority lives on the run
// record, not per-event content. Persisting the ~1KB object on every event
// bloats history; read paths enrich it back from the run record
// (enrichRunCapabilities in session-manager.mjs). Strip at the persist
// boundary so in-memory/streaming events keep their fields untouched.
function stripPersistedProviderCapabilities(event) {
  if (!event || event.providerCapabilities === undefined) return event;
  const { providerCapabilities, ...rest } = event;
  return rest;
}

export async function appendEvent(sessionId, event) {
  return runSessionMutation(sessionId, async () => appendEventUnlocked(sessionId, stripPersistedProviderCapabilities(event)));
}

/** One retained user event per scoped Run, including recovery after append. */
export async function appendRetainedMessageEvent(sessionId, event) {
  if (!event?.id?.startsWith('message-run:') || !event.runId || !event.requestId)
    throw new TypeError('A deterministic message Run event is required');
  return runSessionMutation(sessionId, async () => {
    const meta = await loadMeta(sessionId, { strict: true });
    const context = await createHistoryReadContext(sessionId, meta, { strict: true });
    for (const seqs of seqRangeChunks(1, meta.latestSeq, HISTORY_READ_BATCH_SIZE)) {
      const logical = await readLogicalEventsBatched(sessionId, seqs, context, { uncached: true });
      const found = logical.find(item => item?.event?.id === event.id)?.event;
      if (found) {
        if (found.runId !== event.runId || found.requestId !== event.requestId || found.role !== 'user')
          throw new Error('Retained message event identity changed');
        return found;
      }
    }
    return appendEventUnlocked(sessionId, stripPersistedProviderCapabilities(event));
  });
}

function messagePositionPath(sessionId, id) {
  return join(sessionDir(sessionId), 'message-positions-v2', `${createHash('sha256').update(id).digest('hex')}.json`);
}

async function readMessagePosition(sessionId, id) {
  const record = await readJson(messagePositionPath(sessionId, id), null);
  if (record?.id !== id || !Number.isSafeInteger(record.firstSeq) || record.firstSeq < 1) return null;
  const first = await readJson(eventPath(sessionId, record.firstSeq), null);
  return first?.canonicalMessageId === id ? record : null;
}

async function prepareStoredMessageIdentity(sessionId, source) {
  const event = withMessageTimelineIdentity(source);
  if (!event.canonicalMessageId) return event;
  const previous = await readMessagePosition(sessionId, event.canonicalMessageId);
  event.firstSeq = previous?.firstSeq || event.firstSeq || event.seq;
  // The reservation and event are published under the existing session actor.
  // A dangling reservation is never trusted unless its event also exists.
  const path = messagePositionPath(sessionId, event.canonicalMessageId);
  await ensureDir(join(sessionDir(sessionId), 'message-positions-v2'));
  if (!previous) await writeJsonAtomic(path, { id: event.canonicalMessageId, firstSeq: event.firstSeq });
  return event;
}

async function commitStoredMessagePosition(sessionId, event) {
  if (!event.canonicalMessageId) return;
  const previous = await readMessagePosition(sessionId, event.canonicalMessageId);
  const path = messagePositionPath(sessionId, event.canonicalMessageId);
  await writeJsonAtomic(path, {
    id: event.canonicalMessageId, firstSeq: event.firstSeq, latestSeq: event.seq,
    snapshotSeq: event.textMode === 'metadata' ? (previous?.snapshotSeq || previous?.firstSeq || event.seq) : event.seq,
  });
}

/** A backward visible page can contain a start whose completion is on a later raw page. */
export async function hydrateTimelineMessageSnapshots(sessionId, sources, maxSeq = Number.MAX_SAFE_INTEGER) {
  const output = [];
  for (const source of sources) {
    if (!source.canonicalMessageId || source.type !== 'message_start') { output.push(source); continue; }
    const position = await readMessagePosition(sessionId, source.canonicalMessageId);
    if (!position?.snapshotSeq || position.snapshotSeq <= source.seq || position.snapshotSeq > maxSeq) {
      output.push(source); continue;
    }
    const [snapshot] = await readEventsRange(sessionId, position.snapshotSeq, position.snapshotSeq, { includeBodies: true });
    if (snapshot?.canonicalMessageId !== source.canonicalMessageId) { output.push(source); continue; }
    output.push({ ...snapshot, seq: source.firstSeq || source.seq, firstSeq: source.firstSeq || source.seq,
      lastEventSeq: snapshot.lastEventSeq || position.snapshotSeq });
  }
  return output;
}

/** Persist one start anchor per streamed message, not one event per token. */
export async function prepareLiveMessageTimeline(sessionId, sources) {
  return runSessionMutation(sessionId, async () => {
    const events = [];
    const starts = [];
    const positions = new Map();
    const bindings = new Map();
    for (const source of sources) {
      let event = withMessageTimelineIdentity(source);
      let anonymousBindingPath = null;
      const hasNativeId = source.canonicalMessageId || source.messageId || source.providerMessageId
        || source.providerItemId || source.streamItemId || source.entityId;
      if (event.canonicalMessageId && !hasNativeId && source.runId) {
        const scope = JSON.stringify([source.runId, source.responseId || '', source.messageBlockIndex ?? source.blockIndex ?? 0]);
        anonymousBindingPath = join(sessionDir(sessionId), 'message-positions-v2', `stream-${createHash('sha256').update(scope).digest('hex')}.json`);
        const binding = bindings.has(scope) ? bindings.get(scope) : await readJson(anonymousBindingPath, null);
        if (binding?.open && binding.scope === scope) {
          event = { ...event, canonicalMessageId: binding.id, timelineEntityId: binding.id };
        } else if (event.textMode === 'delta') {
          const meta = await loadMeta(sessionId);
          const id = `m2:${JSON.stringify([source.runId, source.role || 'assistant', `anonymous:${meta.latestSeq + 1}`, source.blockIndex ?? 0])}`;
          event = { ...event, canonicalMessageId: id, timelineEntityId: id };
        }
        const nextBinding = { scope, id: event.canonicalMessageId, open: event.messageState === 'streaming' };
        if (binding?.id !== nextBinding.id || binding?.open !== nextBinding.open) {
          await ensureDir(join(sessionDir(sessionId), 'message-positions-v2'));
          await writeJsonAtomic(anonymousBindingPath, nextBinding);
        }
        bindings.set(scope, nextBinding);
      }
      if (event.canonicalMessageId && event.textMode === 'delta') {
        let position = positions.get(event.canonicalMessageId) || await readMessagePosition(sessionId, event.canonicalMessageId);
        if (!position) {
          const start = await appendEventUnlocked(sessionId, {
            ...event, type: 'message_start', text: '', content: '', textMode: 'snapshot',
            messageState: 'streaming', id: `message-start:${event.canonicalMessageId}`,
            providerEventId: undefined, eventId: undefined, seq: undefined,
          });
          starts.push(start);
          position = { firstSeq: start.seq };
        }
        event = { ...event, firstSeq: position.firstSeq };
        positions.set(event.canonicalMessageId, position);
      }
      events.push(event);
    }
    return { events, starts };
  });
}

export async function appendEvents(sessionId, events) {
  const stripped = (events || []).map(stripPersistedProviderCapabilities);
  return runSessionMutation(sessionId, async () => appendEventsUnlocked(sessionId, stripped));
}

// Creation has at most a template-context event and a welcome message. Reserve
// deterministic IDs, inspect authoritative event files under the append queue,
// and recover orphan writes before deciding which effects are still missing.
// This is deliberately separate from general message/content deduplication.
export async function appendInitializationEvents(sessionId, events) {
  return runSessionMutation(sessionId, async () => {
    const meta = await loadMeta(sessionId, { strict: true });
    metaCache.set(sessionId, meta);
    const readContext = await createHistoryReadContext(sessionId, meta, { strict: true });
    const existing = new Set();
    for (const seqs of seqRangeChunks(1, meta.latestSeq, HISTORY_READ_BATCH_SIZE)) {
      const logical = await readLogicalEventsBatched(sessionId, seqs, readContext, { uncached: true });
      for (const item of logical) if (item?.event?.id) existing.add(item.event.id);
    }
    const pending = (events || []).map((event, index) => ({
      ...stripPersistedProviderCapabilities(event), id: `creation:${sessionId}:${index}`,
    })).filter((event) => !existing.has(event.id));
    return pending.length ? appendEventsUnlocked(sessionId, pending) : [];
  });
}

export async function readEventsAfter(sessionId, afterSeq = 0, options = {}) {
  const startedAt = monotonicMs();
  const priority = options.priority === 'interactive' ? 'interactive' : 'background';
  const readContext = await createHistoryReadContext(sessionId, options.metaOverride || null, {
    strict: options.strict === true,
  });
  const { meta } = readContext;
  const includeBodies = options.includeBodies === true;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 0;
  const events = [];
  const startSeq = Math.max(1, afterSeq + 1);
  for (const seqs of seqRangeChunks(startSeq, meta.latestSeq, HISTORY_READ_BATCH_SIZE)) {
    if (limit > 0 && events.length >= limit) break;
    const logicalEvents = await readLogicalEventsBatched(sessionId, seqs, readContext, {
      priority,
    });
    const hydrated = await hydrateLogicalEventsBatched(
      sessionId,
      logicalEvents,
      (logical) => shouldHydrateLogicalEventBody(logical?.event, options),
      { priority, strict: options.strict === true },
    );
    for (const event of hydrated.filter(Boolean)) {
      events.push(includeBodies ? event : serializeEventForIndex(event, options));
      if (limit > 0 && events.length >= limit) break;
    }
  }
  recordHistoryRead('after', startedAt, events.length, limit || null);
  return events;
}

// Read an exact inclusive sequence range without scanning the rest of a
// session. Compatibility endpoints (event-blocks, diagnostics) only need a
// handful of adjacent events but historically went through loadHistory() and
// materialized the entire transcript first.
export async function readEventsRange(sessionId, fromSeq, toSeq, options = {}) {
  const startedAt = monotonicMs();
  const priority = options.priority === 'interactive' ? 'interactive' : 'background';
  const readContext = await createHistoryReadContext(sessionId, options.metaOverride || null, {
    strict: options.strict === true,
  });
  const { meta } = readContext;
  const startSeq = Number.isInteger(fromSeq) && fromSeq > 0 ? fromSeq : 1;
  const endSeq = Number.isInteger(toSeq) && toSeq > 0
    ? Math.min(toSeq, meta.latestSeq)
    : meta.latestSeq;
  if (endSeq < startSeq) return [];
  if (endSeq - startSeq + 1 > MAX_EVENT_RANGE_SPAN) {
    throw Object.assign(new Error(`Event range exceeds the ${MAX_EVENT_RANGE_SPAN}-event limit`), {
      code: 'EVENT_RANGE_TOO_LARGE',
      maxSpan: MAX_EVENT_RANGE_SPAN,
      startSeq,
      endSeq,
    });
  }
  const includeBodies = options.includeBodies === true;
  const events = [];
  let responseBytes = 0;
  for (const seqs of seqRangeChunks(startSeq, endSeq, HISTORY_READ_BATCH_SIZE)) {
    const logicalEvents = await readLogicalEventsBatched(sessionId, seqs, readContext, {
      priority,
    });
    const selection = selectLogicalEventsWithinResponseBudget(
      logicalEvents,
      () => includeBodies,
      {
        currentBytes: responseBytes,
        maxResponseBytes: MAX_EVENT_RANGE_RESPONSE_BYTES,
        maxBodyBytes: MAX_EVENT_RANGE_BODY_BYTES,
        throwOnLimit: true,
      },
    );
    const hydrated = await hydrateLogicalEventsBatched(
      sessionId,
      selection.selected,
      includeBodies,
      {
        maxBodyBytes: Math.min(MAX_EVENT_RANGE_BODY_BYTES, MAX_EVENT_RANGE_RESPONSE_BYTES),
        priority,
        strict: options.strict === true,
      },
    );
    for (const event of hydrated.filter(Boolean)) {
      responseBytes += serializedEventBytes(event);
      if (responseBytes > MAX_EVENT_RANGE_RESPONSE_BYTES) {
        throw Object.assign(new Error(`Event range exceeds the ${MAX_EVENT_RANGE_RESPONSE_BYTES}-byte response limit`), {
          code: 'EVENT_RANGE_TOO_LARGE',
          maxBytes: MAX_EVENT_RANGE_RESPONSE_BYTES,
        });
      }
      events.push(event);
    }
  }
  recordHistoryRead('range', startedAt, events.length, endSeq - startSeq + 1);
  return events;
}

export async function readEventsPage(sessionId, options = {}) {
  const startedAt = monotonicMs();
  // Low-level page reads default to background because internal compaction,
  // recovery, and dedup scans call this function directly. Public session
  // wrappers opt into `interactive` explicitly below.
  const priority = options.priority === 'interactive' ? 'interactive' : 'background';
  // Callers that already loaded the authoritative history metadata for the
  // same request may pass it through. This keeps a timeline request from
  // re-reading meta.json once for the route existence check and again for the
  // page itself. The metadata is still validated by createHistoryReadContext
  // (including shared-prefix readability checks).
  const readContext = await createHistoryReadContext(sessionId, options.metaOverride || null, {
    strict: options.strict === true,
  });
  const { meta } = readContext;
  const includeBodies = options.includeBodies === true;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 200;
  const afterSeq = Number.isInteger(options.afterSeq) && options.afterSeq > 0 ? options.afterSeq : 0;
  const beforeSeq = Number.isInteger(options.beforeSeq) && options.beforeSeq > 0 ? options.beforeSeq : 0;
  const direction = String(options.direction || '').trim().toLowerCase();
  const maxBodyBytes = Number.isFinite(options.maxBodyBytes) && options.maxBodyBytes > 0
    ? Math.min(options.maxBodyBytes, MAX_EVENT_RANGE_BODY_BYTES)
    : MAX_EVENT_RANGE_BODY_BYTES;
  const maxResponseBytes = Number.isFinite(options.maxResponseBytes) && options.maxResponseBytes > 0
    ? Math.max(256 * 1024, options.maxResponseBytes)
    : Number.POSITIVE_INFINITY;
  const hydrationBodyBytes = Number.isFinite(maxResponseBytes)
    ? Math.min(maxBodyBytes, maxResponseBytes)
    : maxBodyBytes;
  // Page reads must never load more events than the page needs: a fixed 256
  // batch would over-read by up to 255 events for small pages. Batch by the
  // requested limit instead (still capped at the full-read batch size).
  const pageBatchSize = Math.min(HISTORY_READ_BATCH_SIZE, limit);
  const events = [];
  let responseBytes = 0;
  let truncatedByBytes = false;

  const serializePageEvent = (event) => {
    let projected = includeBodies ? event : serializeEventForIndex(event, options);
    const remaining = Number.isFinite(maxResponseBytes)
      ? Math.max(0, maxResponseBytes - responseBytes)
      : Number.POSITIVE_INFINITY;
    let eventBytes = serializedEventBytes(projected);
    // Keep one event even when its body alone is larger than the page budget,
    // but fit/truncate it first. Subsequent events stop at the boundary and
    // are recovered through the normal pagination cursor.
    if (Number.isFinite(maxResponseBytes) && eventBytes > remaining) {
      if (responseBytes > 0) {
        truncatedByBytes = true;
        return null;
      }
      projected = fitEventToResponseBudget(projected, remaining);
      eventBytes = serializedEventBytes(projected);
    }
    if (Number.isFinite(maxResponseBytes) && eventBytes > remaining) {
      truncatedByBytes = true;
      return null;
    }
    responseBytes += eventBytes;
    return projected;
  };

  if (direction === 'latest' || beforeSeq > 0) {
    const startSeq = beforeSeq > 0 ? Math.min(beforeSeq - 1, meta.latestSeq) : meta.latestSeq;
    for (const seqs of descSeqRangeChunks(startSeq, 1, pageBatchSize)) {
      if (events.length >= limit) break;
      if (afterSeq > 0 && seqs[0] <= afterSeq) break;
      const logicalEvents = await readLogicalEventsBatched(sessionId, seqs, readContext, {
        priority,
      });
      const selection = selectLogicalEventsWithinResponseBudget(
        logicalEvents,
        (logical) => shouldHydrateLogicalEventBody(logical?.event, options),
        {
          currentBytes: responseBytes,
          maxResponseBytes,
          maxBodyBytes: hydrationBodyBytes,
        },
      );
      if (selection.truncatedByBytes) truncatedByBytes = true;
      const hydrated = await hydrateLogicalEventsBatched(
        sessionId,
        selection.selected,
        (logical) => shouldHydrateLogicalEventBody(logical?.event, options),
        { maxBodyBytes: hydrationBodyBytes, priority, strict: options.strict === true },
      );
      const accepted = [];
      for (const event of hydrated.filter(Boolean)) {
        if (afterSeq > 0 && event.seq <= afterSeq) break;
        const projected = serializePageEvent(event);
        if (!projected) break;
        accepted.push(projected);
        if (events.length + accepted.length >= limit) break;
      }
      // `hydrated` is newest-first. Prepending one reversed batch preserves
      // chronological order while avoiding O(pageSize²) repeated unshifts.
      events.unshift(...accepted.reverse());
      if (truncatedByBytes && Number.isFinite(maxResponseBytes)) break;
    }
  } else {
    for (const seqs of seqRangeChunks(Math.max(1, afterSeq + 1), meta.latestSeq, pageBatchSize)) {
      if (events.length >= limit) break;
      const logicalEvents = await readLogicalEventsBatched(sessionId, seqs, readContext, {
        priority,
      });
      const selection = selectLogicalEventsWithinResponseBudget(
        logicalEvents,
        (logical) => shouldHydrateLogicalEventBody(logical?.event, options),
        {
          currentBytes: responseBytes,
          maxResponseBytes,
          maxBodyBytes: hydrationBodyBytes,
        },
      );
      if (selection.truncatedByBytes) truncatedByBytes = true;
      const hydrated = await hydrateLogicalEventsBatched(
        sessionId,
        selection.selected,
        (logical) => shouldHydrateLogicalEventBody(logical?.event, options),
        { maxBodyBytes: hydrationBodyBytes, priority, strict: options.strict === true },
      );
      for (const event of hydrated.filter(Boolean)) {
        const projected = serializePageEvent(event);
        if (!projected) break;
        events.push(projected);
        if (events.length >= limit) break;
      }
      if (truncatedByBytes && Number.isFinite(maxResponseBytes)) break;
    }
  }

  const oldestSeq = events[0]?.seq || null;
  const latestSeq = events.at(-1)?.seq || null;
  const result = {
    events,
    pagination: {
      limit,
      direction: direction || (beforeSeq > 0 ? 'before' : (afterSeq > 0 ? 'after' : 'forward')),
      beforeSeq: beforeSeq || null,
      afterSeq: afterSeq || null,
      oldestSeq,
      latestSeq,
      nextBeforeSeq: Number.isInteger(oldestSeq) && oldestSeq > 1 ? oldestSeq : null,
      hasMoreBefore: Number.isInteger(oldestSeq) && oldestSeq > 1,
      hasMoreAfter: Number.isInteger(latestSeq) && latestSeq < meta.latestSeq,
      totalLatestSeq: meta.latestSeq || 0,
      ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
    },
  };
  recordHistoryRead('page', startedAt, events.length, limit);
  return result;
}

export async function readEventBody(sessionId, seq, options = {}) {
  const readContext = await createHistoryReadContext(sessionId, options.metaOverride || null, {
    strict: options.strict === true,
  });
  // A sequence beyond the recorded history is absent, not a corrupt gap.
  // Missing events inside the committed range remain strict-read errors.
  if (!Number.isInteger(seq) || seq < 1 || seq > readContext.meta.latestSeq) return null;
  const logical = await loadLogicalStoredEvent(sessionId, seq, logicalEventOptions(readContext));
  const stored = logical?.event;
  const bodyField = stored?.bodyField || eventBodyField(stored);
  if (!stored || !bodyField) return null;
  const requestedMaxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.min(options.maxBytes, MAX_BODY_READ_BYTES)
    : MAX_BODY_READ_BYTES;
  const storedBytes = Number.isFinite(stored.bodyBytes) && stored.bodyBytes >= 0
    ? stored.bodyBytes
    : null;
  if (storedBytes !== null && storedBytes > requestedMaxBytes) {
    const preview = typeof stored.bodyPreview === 'string' && stored.bodyPreview
      ? stored.bodyPreview
      : `[body truncated: ${storedBytes} bytes exceeds the ${requestedMaxBytes}-byte read limit]`;
    return {
      seq,
      field: bodyField,
      value: preview,
      bytes: storedBytes,
      truncated: true,
    };
  }
  let body = '';
  if (stored.bodyRef) {
    body = await readBody(logical.sourceSessionId, stored.bodyRef, {
      maxBytes: requestedMaxBytes,
      strict: options.strict === true,
    });
  } else if (typeof stored[bodyField] === 'string') {
    body = stored[bodyField];
  }
  if (!body) {
    if (options.strict === true && stored.bodyAvailable === true) {
      throw historyReadError('SESSION_HISTORY_BODY_MISSING', `History body ${stored.bodyRef || seq} is empty for ${sessionId}`, {
        sessionId,
        seq,
        bodyRef: stored.bodyRef || null,
      });
    }
    return null;
  }
  const publicBody = stored.type === 'message' && stored.role === 'assistant'
    && options.includeAssistantControlBlocks !== true
    ? stripAssistantControlBlocks(body)
    : body;
  const publicBytes = Buffer.byteLength(publicBody, 'utf8');
  if (publicBytes > requestedMaxBytes) {
    return {
      seq,
      field: bodyField,
      value: clipMiddle(publicBody, Math.max(256, Math.floor(requestedMaxBytes / 2))),
      bytes: storedBytes ?? publicBytes,
      truncated: true,
    };
  }
  return {
    seq,
    field: bodyField,
    value: publicBody,
    bytes: publicBytes,
    truncated: false,
  };
}

export async function getContextHead(sessionId) {
  return loadContext(sessionId);
}

export async function setContextHead(sessionId, context = {}) {
  return runSessionMutation(sessionId, async () => saveContextUnlocked(sessionId, {
    mode: context.mode || 'summary',
    summary: typeof context.summary === 'string' ? context.summary.trim() : '',
    activeFromSeq: Number.isInteger(context.activeFromSeq) ? context.activeFromSeq : 0,
    compactedThroughSeq: Number.isInteger(context.compactedThroughSeq) ? context.compactedThroughSeq : 0,
    inputTokens: Number.isInteger(context.inputTokens) ? context.inputTokens : null,
    updatedAt: context.updatedAt || new Date().toISOString(),
    source: context.source || 'manual',
    ...(typeof context.toolIndex === 'string' ? { toolIndex: context.toolIndex.trim() } : {}),
    ...(Number.isInteger(context.barrierSeq) ? { barrierSeq: context.barrierSeq } : {}),
    ...(Number.isInteger(context.handoffSeq) ? { handoffSeq: context.handoffSeq } : {}),
    ...(typeof context.compactionSessionId === 'string' && context.compactionSessionId.trim()
      ? { compactionSessionId: context.compactionSessionId.trim() }
      : {}),
    // P1 (2026-07-31): monotonic count of completed compactions on this session.
    // Drives the incremental-merge vs periodic-rewrite decision in the compactor.
    ...(Number.isInteger(context.compactionCount) && context.compactionCount > 0
      ? { compactionCount: context.compactionCount }
      : {}),
  }));
}

export async function clearContextHead(sessionId) {
  return runSessionMutation(sessionId, async () => {
    await clearContextUnlocked(sessionId);
    return null;
  });
}

export async function getForkContext(sessionId) {
  return loadForkContext(sessionId);
}

export async function setForkContext(sessionId, context = {}) {
  return runSessionMutation(sessionId, async () => saveForkContextUnlocked(sessionId, context));
}

export async function clearForkContext(sessionId) {
  return runSessionMutation(sessionId, async () => {
    await clearForkContextUnlocked(sessionId);
    return null;
  });
}

// DS-11: read-path counters for benchmarks and diagnostics. A page read that
// hits only the cache shows eventCacheHits > 0 with no eventFileReads; a cold
// full-history read shows one eventFileReads per existing event file.
export function getHistoryReadStats() {
  return { ...historyReadStats };
}

// Test hooks (precedent: __setCacheLimitsForTest): expose the unified body
// limit tables so tests can pin them (DS-16 "统一 limits" audit).
export function __bodyInlineLimitsForTest() {
  return { ...INLINE_BODY_LIMITS };
}

export function __bodyPreviewLimitsForTest() {
  return { ...PREVIEW_LIMITS };
}

export function __bodyAlwaysExternalForTest() {
  return new Set(ALWAYS_EXTERNALIZE_TYPES);
}

export function __resetHistoryReadStatsForTest() {
  for (const key of Object.keys(historyReadStats)) {
    historyReadStats[key] = key.startsWith('last') ? null : 0;
  }
  return getHistoryReadStats();
}
