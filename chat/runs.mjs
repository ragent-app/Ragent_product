import { applyWorkbenchRunPolicy } from '../lib/workbench-execution-policy.mjs';
import { createHash, randomBytes } from 'crypto';
import { appendFile, chmod, open, readFile, readdir } from 'fs/promises';
import { dirname, join } from 'path';
import { StringDecoder } from 'string_decoder';
import { isDeepStrictEqual } from 'node:util';
import { createGunzip, createZstdDecompress } from 'zlib';
import { archiveMetaPath, resolveCodec } from './run-spool-archive.mjs';
import { isEnvToggleEnabled } from '../lib/env-toggle.mjs';
import { BoundedLruMap } from './cache-utils.mjs';
import { registerLruOrMap } from './memory-registry.mjs';
import { cacheBudget } from '../lib/cache-budget.mjs';
import { CHAT_RUNS_DIR } from '../lib/config.mjs';
import { grantRunnerFileAccess, resolveRunFilePeerUid } from '../lib/linux-runner-file-access.mjs';
import {
  createKeyedTaskQueue,
  ensureDir,
  readJson,
  removePath,
  statOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './fs-utils.mjs';
import {
  buildProviderContractFields,
  resolveProviderPermissionPolicy,
} from './provider-contract.mjs';
import {
  mergeRunAuthRecoveryState,
  normalizeRunAuthRecovery,
} from '../lib/provider-runtime/run-auth-recovery.mjs';
import { createRunAuthRecoveryCapability } from './run-auth-recovery-capability.mjs';
import { currentMessageExecution } from './message-execution-context.mjs';
import { withCurrentMessageScope } from './session-meta-store.mjs';
import { sessionApiError } from './session-api-mutation-contract.mjs';
import { assertMessageRunBinding, retainMessageRunBinding } from './message-run-contract.mjs';
import { createRunPublication, bindRunPublication, assertRunPublication,
  retainRunPublication, runPublicationError } from './run-publication-contract.mjs';
import {
  createRunSessionControlCapability,
  createRunSessionControlRenewalCapability,
  hashSessionControlToken,
  SESSION_CONTROL_CAPABILITY_TOKEN_FILE,
  SESSION_CONTROL_MAX_RUN_LIFETIME_MS,
  SESSION_CONTROL_RENEWAL_TOKEN_FILE,
} from './session-control-capability.mjs';
import {
  createRunBrowserCapability,
  BROWSER_CAPABILITY_TOKEN_FILE,
} from './browser-capability.mjs';

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const SPOOL_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_SPOOL_RECORD_CHARS = 2 * 1024 * 1024;
const MAX_SPOOL_INLINE_CHARS = 16 * 1024;
const MAX_SPOOL_PREVIEW_CHARS = 4096;
// Bounds on in-memory artifact state. Each artifact text is capped on read/cache
// (prevents a single pathological tool output from blowing the V8 heap via a
// giant string), and the cache is evicted oldest-first so cross-run rehydration
// can never grow it without limit. DS-08: the cache is additionally bounded by
// total bytes (maxBytes) and TTL (ttlMs) — bytes keep the aggregate resident
// footprint flat even when every entry sits near the per-entry cap, and the TTL
// bounds staleness when an artifact file is updated externally (within the TTL
// the cached text is served; after it the next read re-reads the file).
const MAX_RUN_ARTIFACT_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_RUN_ARTIFACT_CACHE_ENTRIES = 256;
const MAX_RUN_ARTIFACT_CACHE_BYTES = readEnvPositiveInt('AGENTOC_RUN_ARTIFACT_CACHE_BYTES', cacheBudget('runs.artifact', 0.5));
const MAX_RUN_ARTIFACT_CACHE_TTL_MS = readEnvPositiveInt('AGENTOC_RUN_ARTIFACT_CACHE_TTL_MS', 10 * 60 * 1000);
// Maximum width of one UTF-8 sequence; a bounded artifact read over-reads this
// many bytes past the char cap so the decoded string can be sliced cleanly.
const MAX_UTF8_SEQUENCE_BYTES = 4;
const ARTIFACT_TRUNCATION_SUFFIX = `\n[... artifact truncated at ${MAX_RUN_ARTIFACT_TEXT_CHARS} chars ...]`;
// Hard cap on how many spool records a single read materializes into JS objects.
// Without this, a large spool of many small records grows `records[]` without
// bound and starves the event loop / heap (the OOM vector). Once the cap is
// reached the cursor stops immediately after the last returned record so the
// caller can resume without dropping the unread tail.
const MAX_SPOOL_DELTA_RECORDS = 4000;
// Durable consumer checkpoints. `normalized` is the provider -> history
// projection cursor; `historyPersisted` is an explicit alias for operators
// and future consumers that need to distinguish spool consumption from other
// Run counters. Keep the cursor shape small and monotonic so a stale writer
// cannot move another process backwards.
const MAX_SPOOL_CURSOR_LINE_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_APPROVAL_SUPPRESSION_IDS = 2048;
const MAX_APPROVAL_SUPPRESSION_ID_CHARS = 256;

function normalizeSpoolCursor(value, fallback = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const byteOffset = Number.isSafeInteger(source.byteOffset) && source.byteOffset >= 0
    ? source.byteOffset
    : (Number.isSafeInteger(fallback.byteOffset) && fallback.byteOffset >= 0 ? fallback.byteOffset : 0);
  const lineCount = Number.isSafeInteger(source.lineCount) && source.lineCount >= 0
    ? Math.min(source.lineCount, MAX_SPOOL_CURSOR_LINE_COUNT)
    : (Number.isSafeInteger(fallback.lineCount) && fallback.lineCount >= 0 ? fallback.lineCount : 0);
  return { byteOffset, lineCount };
}

export function getRunSpoolCursor(run, consumer = 'normalized') {
  const name = typeof consumer === 'string' && consumer.trim() ? consumer.trim() : 'normalized';
  const legacy = {
    byteOffset: Number.isSafeInteger(run?.normalizedByteOffset) ? run.normalizedByteOffset : 0,
    lineCount: Number.isSafeInteger(run?.normalizedLineCount) ? run.normalizedLineCount : 0,
  };
  return normalizeSpoolCursor(run?.spoolCursors?.[name], name === 'normalized' || name === 'historyPersisted' ? legacy : {});
}

function normalizeApprovalSuppressionIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => typeof entry === 'string' ? entry.trim().slice(0, MAX_APPROVAL_SUPPRESSION_ID_CHARS) : '')
    .filter(Boolean))]
    .slice(-MAX_APPROVAL_SUPPRESSION_IDS);
}

// Perf (AGENTOC_PERF_CACHES=off restores unbounded Maps + JSON clone): the run
// read caches previously retained every run ever touched for the life of the
// process (2,909 runs, status up to 348KB each). BoundedLruMap caps them; a
// miss re-reads the file, so eviction is always safe. runArtifactCache keeps
// its own inline entry cap below.
const AGENTOC_PERF_CACHES_ENV = 'AGENTOC_PERF_CACHES';
const PERF_CACHES_ENABLED = isEnvToggleEnabled(process.env[AGENTOC_PERF_CACHES_ENV], { defaultValue: true });
// Perf (AGENTOC_PERF_COMPACT_JSON=off): status.json (up to 348KB), manifest,
// and result are machine-only files — every reader uses JSON.parse — so they
// serialize compact instead of pretty (2-3x smaller writes). The files become
// single-line; jq still works.
const AGENTOC_PERF_COMPACT_JSON_ENV = 'AGENTOC_PERF_COMPACT_JSON';
const PERF_COMPACT_JSON_ENABLED = isEnvToggleEnabled(process.env[AGENTOC_PERF_COMPACT_JSON_ENV], { defaultValue: true });
const COMPACT_JSON_OPTIONS = PERF_COMPACT_JSON_ENABLED ? { spaces: 0 } : {};

function makeLruOrMap(options) {
  return PERF_CACHES_ENABLED ? new BoundedLruMap(options) : new Map();
}

function readEnvPositiveInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function artifactTextBytes(text) {
  return typeof text === 'string' ? text.length : 0;
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

const RUN_STATUS_CACHE_CAPS = { maxEntries: 300, maxBytes: cacheBudget('runs.status', 1) };
const RUN_MANIFEST_CACHE_CAPS = { maxEntries: 300, maxBytes: cacheBudget('runs.manifest', 0.5) };
const RUN_RESULT_CACHE_CAPS = { maxEntries: 300, maxBytes: cacheBudget('runs.result', 0.5) };

// mtime/size metadata for the read-through caches above: lets getRunUnlocked /
// getRunResultUnlocked skip the JSON.parse of a large status.json (up to
// ~350KB) when the file on disk has not changed since it was cached. Updated
// after every in-process write; a sidecar or test writing the file directly
// changes mtime/size and forces the next read to re-parse, so no bypass
// writer can be served stale data.
//
// DS-08: the meta maps are themselves BoundedLruMap capped at the same entry
// count as their main cache AND linked to it — when the main cache evicts an
// entry (entry/byte overflow), onEvict drops the matching meta key, so no
// orphan metadata outlives its cached value. Explicit delete() call sites
// already clean their own meta keys (onEvict only fires on eviction paths).
const runStatusCacheMeta = new BoundedLruMap({ maxEntries: RUN_STATUS_CACHE_CAPS.maxEntries });
const runResultCacheMeta = new BoundedLruMap({ maxEntries: RUN_RESULT_CACHE_CAPS.maxEntries });

const runStatusCache = makeLruOrMap({
  ...RUN_STATUS_CACHE_CAPS,
  bytesOf: approximateJsonBytes,
  onEvict: (runId) => runStatusCacheMeta.delete(runId),
});
const runManifestCache = makeLruOrMap({ ...RUN_MANIFEST_CACHE_CAPS, bytesOf: approximateJsonBytes });
const runResultCache = makeLruOrMap({
  ...RUN_RESULT_CACHE_CAPS,
  bytesOf: approximateJsonBytes,
  onEvict: (runId) => runResultCacheMeta.delete(runId),
});
// Artifact text cache (DS-08): bounded by entries, total bytes AND TTL. Each
// cached value is already capped at MAX_RUN_ARTIFACT_TEXT_CHARS on read; the
// byte cap keeps aggregate resident text flat even when every entry sits near
// that cap. Perf toggle AGENTOC_PERF_CACHES=off still swaps in an unbounded
// Map (escape hatch, matching the other read caches).
const runArtifactCache = makeLruOrMap({
  maxEntries: MAX_RUN_ARTIFACT_CACHE_ENTRIES,
  maxBytes: MAX_RUN_ARTIFACT_CACHE_BYTES,
  bytesOf: artifactTextBytes,
  ttlMs: MAX_RUN_ARTIFACT_CACHE_TTL_MS,
});

// Memory registry (DS-06): expose run read-through caches and the artifact
// cache to /healthz + owner-only diagnostics.
registerLruOrMap('runs.status', runStatusCache);
registerLruOrMap('runs.manifest', runManifestCache);
registerLruOrMap('runs.result', runResultCache);
registerLruOrMap('runs.artifact', runArtifactCache, { kind: 'artifact', bytesOf: artifactTextBytes });

// Exposed for tests (DS-08) so they can assert eviction coupling between the
// value caches and their mtime meta maps. Read-only; production code paths
// must keep using the named local bindings above.
export const runReadCachesForTests = {
  statusCache: runStatusCache,
  resultCache: runResultCache,
  artifactCache: runArtifactCache,
  statusCacheMeta: runStatusCacheMeta,
  resultCacheMeta: runResultCacheMeta,
};

const rawRunMutationQueue = createKeyedTaskQueue();
function runMutationQueue(runId, task) {
  const execution = currentMessageExecution();
  if (!execution) return rawRunMutationQueue(runId, task);
  if (runId !== execution.runId)
    throw sessionApiError('MESSAGE_RUN_BINDING_INVALID', 503, 'Message continuation cannot write another Run');
  // Scope before Run lock. Never wait for the metadata actor from a Run lock.
  return withCurrentMessageScope(() => rawRunMutationQueue(runId, task));
}
const RUN_MUTATION_LOCK_TIMEOUT_MS = 15_000;
const RUN_MUTATION_LOCK_STALE_MS = 120_000;

function runMutationLockPath(runId) {
  return join(runDir(runId), '.mutation.lock');
}

function sleepBriefly(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this service cannot signal it. Treat
    // it as alive; ESRCH/ENOENT and other lookup failures mean the lock owner
    // is gone and the lock can be recovered.
    return error?.code === 'EPERM';
  }
}

async function isRunMutationLockStale(lockPath, stats) {
  if (stats && (Date.now() - stats.mtimeMs) > RUN_MUTATION_LOCK_STALE_MS) return true;
  try {
    const raw = await readFile(lockPath, 'utf8');
    const ownerPid = Number.parseInt(String(raw).trim().split(/\s+/, 1)[0], 10);
    return Number.isInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid);
  } catch {
    // A lock disappearing between stat/read is harmless; let the next open
    // attempt decide ownership. Malformed contents retain the age-based guard.
    return false;
  }
}

// The in-process keyed queue does not protect status.json when the chat
// service, runner supervisor, and lifecycle broker update the same Run from
// separate processes. A tiny per-Run lock closes that lost-update window while
// keeping the durable file format unchanged. Stale locks are recoverable after
// a host/process crash and are only removed after a conservative timeout.
async function withRunMutationLock(runId, task) {
  const lockPath = runMutationLockPath(runId);
  const deadline = Date.now() + RUN_MUTATION_LOCK_TIMEOUT_MS;
  let handle = null;
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o660);
      await handle.writeFile(`${process.pid} ${Date.now()}\n`, 'utf8').catch(() => {});
      await handle.close().catch(() => {});
      handle = null;
      break;
    } catch (error) {
      await handle?.close().catch(() => {});
      handle = null;
      if (error?.code !== 'EEXIST') throw error;
      const stats = await statOrNull(lockPath);
      if (await isRunMutationLockStale(lockPath, stats)) {
        await removePath(lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring Run mutation lock: ${runId}`);
      }
      await sleepBriefly(25);
    }
  }
  try {
    return await task();
  } finally {
    await removePath(lockPath);
  }
}

// Request-id lookup used to scan every run directory before accepting a new
// message. Keep a small durable append-only index instead: the in-process Map
// makes the normal path O(1), while the log survives service restarts without
// rewriting the whole index for every new run.
const REQUEST_INDEX_VERSION = 1;
const REQUEST_INDEX_PATH = join(CHAT_RUNS_DIR, 'request-index.jsonl');
const REQUEST_INDEX_REPAIR_SCAN_LIMIT = readEnvPositiveInt(
  'AGENTOC_REQUEST_INDEX_REPAIR_SCAN_LIMIT',
  128,
);
const REQUEST_INDEX_PENDING_RETRY_LIMIT = 3;
const REQUEST_INDEX_PENDING_RETRY_DELAY_MS = 10;
const requestIndexMutationQueue = createKeyedTaskQueue();
const runRequestIndex = new Map();
let requestIndexReadyPromise = null;

// Durable Run directory index.  A number of recovery, project and cleanup
// paths only need the Run ids (and occasionally a small status summary), but
// used to scan CHAT_RUNS_DIR on every call.  Keep the append-only index as the
// hot path and retain a directory scan only for boot-time rebuild/repair.  The
// index is deliberately a separate file from request-index.jsonl: request
// de-duplication and Run enumeration have different update frequencies and
// failure semantics.
const RUN_INDEX_VERSION = 1;
const RUN_INDEX_PATH = join(CHAT_RUNS_DIR, 'run-index.jsonl');
const RUN_INDEX_LOCK_PATH = join(CHAT_RUNS_DIR, 'run-index.lock');
const RUN_INDEX_COMPACT_BYTES = readEnvPositiveInt(
  'AGENTOC_RUN_INDEX_COMPACT_BYTES',
  8 * 1024 * 1024,
);
const RUN_INDEX_COMPACT_RECORDS = readEnvPositiveInt(
  'AGENTOC_RUN_INDEX_COMPACT_RECORDS',
  5_000,
);
const RUN_INDEX_SIZE_CHECK_EVERY = 128;
const RUN_INDEX_LOCK_TIMEOUT_MS = 15_000;
const RUN_INDEX_LOCK_STALE_MS = 120_000;
const runIndexMutationQueue = createKeyedTaskQueue();
const runIndexById = new Map();
let runIndexReadyPromise = null;
let runIndexAppendCount = 0;

function normalizeRunIndexValue(value, maxLength = 512) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function runIndexSummary(run) {
  const id = normalizeRunIndexValue(run?.id, 128);
  if (!id) return null;
  const agyQueueProviderId = normalizeRunIndexValue(
    run?.agyQueue?.providerId || run?.agyProviderProfileId || run?.providerProfile,
    256,
  );
  return {
    id,
    sessionId: normalizeRunIndexValue(run?.sessionId),
    requestId: normalizeRunIndexValue(run?.requestId),
    state: normalizeRunIndexValue(run?.state, 64) || 'accepted',
    tool: normalizeRunIndexValue(run?.tool, 128),
    provider: normalizeRunIndexValue(run?.provider, 128),
    runtimeFamily: normalizeRunIndexValue(run?.runtimeFamily, 128),
    createdAt: normalizeRunIndexValue(run?.createdAt, 64),
    updatedAt: normalizeRunIndexValue(run?.updatedAt, 64),
    completedAt: normalizeRunIndexValue(run?.completedAt, 64),
    cancelRequested: run?.cancelRequested === true,
    ...(run?.appApiMessageVersion === 1 ? { appApiMessageVersion: 1,
      appApiMessageQueue: run.appApiMessageQueue === true } : {}),
    runnerProcessId: Number.isInteger(run?.runnerProcessId) ? run.runnerProcessId : null,
    toolProcessId: Number.isInteger(run?.toolProcessId) ? run.toolProcessId : null,
    runnerUnitName: normalizeRunIndexValue(run?.runnerUnitName, 256),
    runnerLaunchMode: normalizeRunIndexValue(run?.runnerLaunchMode, 64),
    agyQueueProviderId,
    adaptiveQueue: run?.adaptiveQueue && typeof run.adaptiveQueue === 'object'
      ? {
        priority: normalizeRunIndexValue(run.adaptiveQueue.priority, 32),
        queuedAt: normalizeRunIndexValue(run.adaptiveQueue.queuedAt, 64),
      }
      : null,
  };
}

function serializeRunIndex(entries) {
  const lines = [JSON.stringify({ kind: 'header', version: RUN_INDEX_VERSION })];
  for (const [runId, summary] of entries) {
    if (!runId || !summary || summary.id !== runId) continue;
    lines.push(JSON.stringify({ kind: 'entry', op: 'put', ...summary }));
  }
  return `${lines.join('\n')}\n`;
}

function parseRunIndexText(raw) {
  const entries = new Map();
  let headerSeen = false;
  let invalidRecordSeen = false;
  for (const line of String(raw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      invalidRecordSeen = true;
      continue;
    }
    if (record?.kind === 'header') {
      if (record.version !== RUN_INDEX_VERSION || headerSeen) invalidRecordSeen = true;
      headerSeen = true;
      continue;
    }
    if (record?.kind !== 'entry') {
      invalidRecordSeen = true;
      continue;
    }
    const runId = normalizeRunIndexValue(record.id, 128);
    if (!runId || !['put', 'delete'].includes(record.op)) {
      invalidRecordSeen = true;
      continue;
    }
    if (record.op === 'delete') {
      entries.delete(runId);
      continue;
    }
    const summary = runIndexSummary(record);
    if (!summary) {
      invalidRecordSeen = true;
      continue;
    }
    entries.set(runId, summary);
  }
  return { entries, headerSeen, invalidRecordSeen };
}

async function withRunIndexFileLock(task) {
  const deadline = Date.now() + RUN_INDEX_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(RUN_INDEX_LOCK_PATH, 'wx', 0o660);
      try {
        await handle.writeFile(`${process.pid} ${Date.now()}\n`, 'utf8').catch(() => {});
      } finally {
        await handle.close().catch(() => {});
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stats = await statOrNull(RUN_INDEX_LOCK_PATH);
      if (stats && Date.now() - stats.mtimeMs > RUN_INDEX_LOCK_STALE_MS) {
        await removePath(RUN_INDEX_LOCK_PATH);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out acquiring Run index mutation lock');
      }
      await sleepBriefly(25);
    }
  }
  try {
    return await task();
  } finally {
    await removePath(RUN_INDEX_LOCK_PATH);
  }
}

async function compactRunIndexUnlocked() {
  let raw;
  try {
    raw = await readFile(RUN_INDEX_PATH, 'utf8');
  } catch {
    return false;
  }
  const parsed = parseRunIndexText(raw);
  if (!parsed.headerSeen || parsed.invalidRecordSeen) {
    await rebuildRunIndex();
    runIndexAppendCount = 0;
    return true;
  }
  if (Buffer.byteLength(raw, 'utf8') < RUN_INDEX_COMPACT_BYTES) return false;
  await writeTextAtomic(RUN_INDEX_PATH, serializeRunIndex(parsed.entries));
  runIndexById.clear();
  for (const [runId, summary] of parsed.entries) runIndexById.set(runId, summary);
  runIndexAppendCount = 0;
  return true;
}

async function scanRunDirectoryIds() {
  await ensureRunsDir();
  try {
    return (await readdir(CHAT_RUNS_DIR, { withFileTypes: true }))
      // `browser-profiles` is a sibling storage root under CHAT_RUNS_DIR, not
      // a Run.  Keep it out of the index so recovery/project scans never try
      // to hydrate it as a status record.
      .filter((entry) => entry.isDirectory() && entry.name !== 'browser-profiles')
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function rebuildRunIndex() {
  const rebuilt = new Map();
  for (const runId of await scanRunDirectoryIds()) {
    const run = await readJson(runStatusPath(runId), null);
    const summary = runIndexSummary(run || { id: runId });
    if (summary) rebuilt.set(runId, summary);
  }
  await writeTextAtomic(RUN_INDEX_PATH, serializeRunIndex(rebuilt));
  runIndexById.clear();
  for (const [runId, summary] of rebuilt) runIndexById.set(runId, summary);
}

async function loadRunIndex() {
  await ensureRunsDir();
  let raw;
  try {
    raw = await readFile(RUN_INDEX_PATH, 'utf8');
  } catch {
    await rebuildRunIndex();
    return;
  }

  const { entries, headerSeen, invalidRecordSeen } = parseRunIndexText(raw);

  if (!headerSeen || invalidRecordSeen) {
    await rebuildRunIndex();
    return;
  }

  // A version upgrade can leave old run directories beside a valid but empty
  // index.  Check this once at boot (not on every hot-path enumeration) and
  // rebuild only when the directory set proves the index is incomplete.
  const directoryIds = await scanRunDirectoryIds();
  if (directoryIds.some((runId) => !entries.has(runId))) {
    await rebuildRunIndex();
    return;
  }
  runIndexById.clear();
  for (const [runId, summary] of entries) runIndexById.set(runId, summary);
}

function ensureRunIndex() {
  if (!runIndexReadyPromise) {
    const pending = loadRunIndex();
    runIndexReadyPromise = pending.catch((error) => {
      runIndexReadyPromise = null;
      throw error;
    });
  }
  return runIndexReadyPromise;
}

function runIndexSummaryChanged(current, next) {
  // `updatedAt` changes on every status write, including provider heartbeat
  // and diagnostic ticks.  It is useful metadata when the index is refreshed
  // for a real state transition, but treating it as a trigger would recreate
  // the very write amplification this index is meant to remove.
  const comparable = (value) => {
    if (!value || typeof value !== 'object') return value || null;
    const copy = { ...value };
    delete copy.updatedAt;
    return copy;
  };
  return JSON.stringify(comparable(current)) !== JSON.stringify(comparable(next));
}

async function appendRunIndexRecord(run, op = 'put') {
  const summary = runIndexSummary(run);
  const runId = normalizeRunIndexValue(run?.id, 128);
  if (!runId) return;
  await ensureRunIndex();
  await runIndexMutationQueue('run-index', async () => {
    if (op === 'put' && !summary) return;
    await withRunIndexFileLock(async () => {
      const record = op === 'delete'
        ? { kind: 'entry', op: 'delete', id: runId }
        : { kind: 'entry', op: 'put', ...summary };
      await appendFile(RUN_INDEX_PATH, `${JSON.stringify(record)}\n`, 'utf8');
      if (op === 'delete') runIndexById.delete(runId);
      else runIndexById.set(runId, summary);
      runIndexAppendCount += 1;
      if (runIndexAppendCount >= RUN_INDEX_COMPACT_RECORDS) {
        await compactRunIndexUnlocked();
      } else if (runIndexAppendCount % RUN_INDEX_SIZE_CHECK_EVERY === 0) {
        const stats = await statOrNull(RUN_INDEX_PATH);
        if (stats && stats.size >= RUN_INDEX_COMPACT_BYTES) {
          await compactRunIndexUnlocked();
        }
      }
    });
  });
}

export function runIndexPath() {
  return RUN_INDEX_PATH;
}

export function getRunIndexSnapshotForTests() {
  return [...runIndexById.values()].map((entry) => ({ ...entry }));
}

// Return the small, durable Run summaries needed by queue/recovery paths. The
// caller can filter before hydrating status.json/manifest.json, avoiding a
// full Run-directory walk whenever a provider slot becomes available.
export async function listRunIndexEntries({
  state = '',
  states = null,
  sessionId = '',
  providerId = '',
  limit = 0,
  reverse = false,
} = {}) {
  await ensureRunIndex();
  const normalizedState = normalizeRunIndexValue(state, 64);
  const stateSet = new Set(
    (Array.isArray(states) ? states : [])
      .map((value) => normalizeRunIndexValue(value, 64))
      .filter(Boolean),
  );
  if (normalizedState) stateSet.add(normalizedState);
  const normalizedSessionId = normalizeRunIndexValue(sessionId);
  const normalizedProviderId = normalizeRunIndexValue(providerId, 256);
  const maxEntries = Number.isInteger(limit) && limit > 0 ? limit : 0;
  // Queue drains and provider filters are forward scans; iterating the Map
  // directly avoids allocating a copy of every Run summary once per tick.
  // Reverse callers explicitly pay for the ordered snapshot they request.
  const source = reverse
    ? [...runIndexById.values()].reverse()
    : runIndexById.values();
  const result = [];
  for (const summary of source) {
    if (stateSet.size > 0 && !stateSet.has(summary.state)) continue;
    if (normalizedSessionId && summary.sessionId !== normalizedSessionId) continue;
    if (normalizedProviderId && summary.agyQueueProviderId
      && summary.agyQueueProviderId !== normalizedProviderId) continue;
    result.push({ ...summary, adaptiveQueue: summary.adaptiveQueue ? { ...summary.adaptiveQueue } : null });
    if (maxEntries > 0 && result.length >= maxEntries) break;
  }
  return result;
}

function requestIndexKey(sessionId, requestId) {
  return JSON.stringify([sessionId, requestId]);
}

function normalizeRequestIndexValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requestIndexRecord(run, op = 'put') {
  const sessionId = normalizeRequestIndexValue(run?.sessionId);
  const requestId = normalizeRequestIndexValue(run?.requestId);
  const runId = normalizeRequestIndexValue(run?.id);
  if (!sessionId || !requestId || !runId) return null;
  return { kind: 'entry', op, sessionId, requestId, runId };
}

function serializeRequestIndex(entries) {
  const lines = [JSON.stringify({ kind: 'header', version: REQUEST_INDEX_VERSION })];
  for (const [key, runId] of entries) {
    let parts;
    try {
      parts = JSON.parse(key);
    } catch {
      parts = null;
    }
    if (!Array.isArray(parts) || parts.length !== 2 || !parts[0] || !parts[1] || !runId) continue;
    lines.push(JSON.stringify({
      kind: 'entry',
      op: 'put',
      sessionId: parts[0],
      requestId: parts[1],
      runId,
    }));
  }
  return `${lines.join('\n')}\n`;
}

async function rebuildRequestIndex() {
  const rebuilt = new Map();
  // Run index summaries already contain the immutable request binding. Reuse
  // them during repair instead of reopening every status.json a second time
  // after the Run index has been loaded/rebuilt.
  for (const indexed of await listRunIndexEntries()) {
    const record = requestIndexRecord(indexed);
    if (record) {
      rebuilt.set(requestIndexKey(record.sessionId, record.requestId), record.runId);
    }
  }
  await writeTextAtomic(REQUEST_INDEX_PATH, serializeRequestIndex(rebuilt));
  runRequestIndex.clear();
  for (const [key, runId] of rebuilt) runRequestIndex.set(key, runId);
}

async function loadRequestIndex() {
  await ensureRunsDir();
  let raw;
  try {
    raw = await readFile(REQUEST_INDEX_PATH, 'utf8');
  } catch {
    await rebuildRequestIndex();
    return;
  }

  const entries = new Map();
  let headerSeen = false;
  let invalidRecordSeen = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      invalidRecordSeen = true;
      continue;
    }
    if (record?.kind === 'header') {
      if (record.version !== REQUEST_INDEX_VERSION || headerSeen) invalidRecordSeen = true;
      headerSeen = true;
      continue;
    }
    if (record?.kind !== 'entry') {
      invalidRecordSeen = true;
      continue;
    }
    const sessionId = normalizeRequestIndexValue(record.sessionId);
    const requestId = normalizeRequestIndexValue(record.requestId);
    const runId = normalizeRequestIndexValue(record.runId);
    if (!sessionId || !requestId || !runId || !['put', 'delete'].includes(record.op)) {
      invalidRecordSeen = true;
      continue;
    }
    const key = requestIndexKey(sessionId, requestId);
    if (record.op === 'delete') {
      if (entries.get(key) === runId) entries.delete(key);
    } else {
      entries.set(key, runId);
    }
  }

  if (!headerSeen || invalidRecordSeen) {
    await rebuildRequestIndex();
    return;
  }
  runRequestIndex.clear();
  for (const [key, runId] of entries) runRequestIndex.set(key, runId);
}

function ensureRequestIndex() {
  if (!requestIndexReadyPromise) {
    const pending = loadRequestIndex();
    requestIndexReadyPromise = pending.catch((error) => {
      requestIndexReadyPromise = null;
      throw error;
    });
  }
  return requestIndexReadyPromise;
}

async function appendRequestIndexRecord(run, op = 'put') {
  const record = requestIndexRecord(run, op);
  if (!record) return;
  await ensureRequestIndex();
  await requestIndexMutationQueue('request-index', async () => {
    await appendFile(REQUEST_INDEX_PATH, `${JSON.stringify(record)}\n`, 'utf8');
    const key = requestIndexKey(record.sessionId, record.requestId);
    if (op === 'delete') {
      if (runRequestIndex.get(key) === record.runId) runRequestIndex.delete(key);
    } else {
      runRequestIndex.set(key, record.runId);
    }
  });
}

// Provider stdout/stderr can arrive at line-rate (especially for JSONL
// protocols). Keep the durable spool append-only, but coalesce short bursts
// into one write so every provider frame does not pay a filesystem round trip.
// The terminal path explicitly flushes this buffer before publishing a final
// result/status, so the bounded delay is only for live observers.
const SPOOL_BUFFER_MAX_RECORDS = readEnvPositiveInt('AGENTOC_SPOOL_BUFFER_MAX_RECORDS', 32);
const SPOOL_BUFFER_MAX_BYTES = readEnvPositiveInt(
  'AGENTOC_SPOOL_BUFFER_MAX_BYTES',
  16 * 1024 * 1024,
);
const SPOOL_BUFFER_DELAY_MS = readEnvPositiveInt('AGENTOC_SPOOL_BUFFER_DELAY_MS', 25);
// `fs.promises.appendFile` has no AbortSignal support.  A wedged network or
// FUSE filesystem must not leave a sidecar's ordered stdout chain waiting
// forever, because that prevents a terminal result from ever being published.
// After a timeout the underlying write might still complete, so that run is
// permanently fenced from further spool appends in this process; issuing a
// second append would otherwise risk reordering evidence behind the detached
// first write.
const SPOOL_WRITE_TIMEOUT_MS = readEnvPositiveInt('AGENTOC_SPOOL_WRITE_TIMEOUT_MS', 20_000);
const spoolBufferByRunId = new Map();
const spoolBufferTimers = new Map();
const spoolWriteFailureByRunId = new Map();

function spoolWriteTimeoutError(runId) {
  const error = new Error(`Run spool write timed out after ${SPOOL_WRITE_TIMEOUT_MS}ms`);
  error.code = 'RUN_SPOOL_WRITE_TIMEOUT';
  error.runId = runId;
  return error;
}

async function runSpoolWriteWithDeadline(runId, task) {
  const priorFailure = spoolWriteFailureByRunId.get(runId);
  if (priorFailure) throw priorFailure;
  let timer = null;
  const write = Promise.resolve().then(task);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(spoolWriteTimeoutError(runId)), SPOOL_WRITE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([write, timeout]);
  } catch (error) {
    if (error?.code === 'RUN_SPOOL_WRITE_TIMEOUT') {
      spoolWriteFailureByRunId.set(runId, error);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function appendRunSpoolPayload(runId, payload) {
  return runSpoolWriteWithDeadline(runId, async () => {
    await ensureRunDirectory(runId);
    await appendFile(runSpoolPath(runId), payload, 'utf8');
  });
}

function spoolRecordBytes(record) {
  try {
    return Buffer.byteLength(JSON.stringify(record), 'utf8') + 1;
  } catch {
    return 0;
  }
}

function spoolBufferBytes(records) {
  return (Array.isArray(records) ? records : []).reduce(
    (total, record) => total + spoolRecordBytes(record),
    0,
  );
}

function scheduleRunSpoolFlush(runId) {
  if (spoolBufferTimers.has(runId)) return;
  const timer = setTimeout(() => {
    spoolBufferTimers.delete(runId);
    void flushRunSpool(runId).catch((error) => {
      // A later append or terminal flush gets another chance; this diagnostic
      // must not reject the provider stream callback.
      console.error(`[runs] Failed to flush buffered spool for ${runId}: ${error?.message || error}`);
    });
  }, SPOOL_BUFFER_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  spoolBufferTimers.set(runId, timer);
}

async function flushRunSpoolUnlocked(runId) {
  const timer = spoolBufferTimers.get(runId);
  if (timer) clearTimeout(timer);
  spoolBufferTimers.delete(runId);
  const buffered = spoolBufferByRunId.get(runId);
  if (!buffered || buffered.length === 0) {
    spoolBufferByRunId.delete(runId);
    return;
  }
  spoolBufferByRunId.delete(runId);
  try {
    const priorFailure = spoolWriteFailureByRunId.get(runId);
    if (priorFailure) throw priorFailure;
    const payload = buffered.map((record) => JSON.stringify(record)).join('\n') + '\n';
    await appendRunSpoolPayload(runId, payload);
  } catch (error) {
    // Put records back in order so a subsequent explicit flush can retry
    // without silently losing provider evidence. The append path refuses to
    // add new records while this failed batch is already at its hard bound;
    // that keeps a persistent disk/permission failure from turning provider
    // output into an unbounded in-memory queue.
    const pending = spoolBufferByRunId.get(runId) || [];
    spoolBufferByRunId.set(runId, [...buffered, ...pending]);
    throw error;
  }
  if (spoolBufferByRunId.has(runId)) scheduleRunSpoolFlush(runId);
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

// `getRunUnlocked()` returns a defensive clone, so nested fields (for
// example `replyPublication` and `spoolCursors`) do not retain object
// identity across the two reads performed by updateRun(). Comparing only with
// Object.is therefore made an object-form no-op look like a mutation on every
// observer tick. Keep the fast identity path for the common scalar case and
// use Node's bounded structural comparator only when both values are objects.
function runFieldEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  return isDeepStrictEqual(left, right);
}

function clipMiddle(text, maxChars = MAX_SPOOL_PREVIEW_CHARS) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const head = Math.max(1, Math.floor(maxChars * 0.6));
  const tail = Math.max(1, maxChars - head);
  return `${text.slice(0, head).trimEnd()}\n[... truncated by Ragent ...]\n${text.slice(-tail).trimStart()}`;
}

export async function ensureRunsDir() {
  await ensureDir(CHAT_RUNS_DIR);
}

export function createRunId() {
  return `run_${randomBytes(12).toString('hex')}`;
}

export function runDir(runId) {
  return join(CHAT_RUNS_DIR, runId);
}

async function runFileWriteOptions(runId, options, { writable = false } = {}) {
  const uid = await resolveRunFilePeerUid(runDir(runId));
  return uid === null ? options : { ...options, prepareHandle: handle => grantRunnerFileAccess(handle, uid, { writable }) };
}

export function runRequestIndexPath() {
  return REQUEST_INDEX_PATH;
}

export function runStatusPath(runId) {
  return join(runDir(runId), 'status.json');
}

export function runManifestPath(runId) {
  return join(runDir(runId), 'manifest.json');
}

// Keep the bearer capability outside manifest.json. Manifests are consumed by
// projections and diagnostics; only the detached runner needs this secret.
export function runAuthRecoveryCapabilityPath(runId) {
  return join(runDir(runId), 'auth-recovery.cap');
}

export function runSessionControlCapabilityPath(runId) {
  return join(runDir(runId), SESSION_CONTROL_CAPABILITY_TOKEN_FILE);
}

export function runSessionControlRenewalCapabilityPath(runId) {
  return join(runDir(runId), SESSION_CONTROL_RENEWAL_TOKEN_FILE);
}

// Keep the browser bearer outside manifest.json/status.json. The browser MCP
// is a Run child, so its credential must have the same filesystem boundary as
// the detached runner and must never enter projections or diagnostics.
export function runBrowserCapabilityPath(runId) {
  return join(runDir(runId), BROWSER_CAPABILITY_TOKEN_FILE);
}

export function sessionBrowserProfileDir(sessionId) {
  const key = createHash('sha256').update(String(sessionId || ''), 'utf8').digest('hex');
  return join(CHAT_RUNS_DIR, 'browser-profiles', key);
}

// Compatibility name for callers written during the initial Run-scoped
// browser prototype. The argument is now deliberately a Session id so a
// resumed Run can reuse the authenticated browser profile.
export function runBrowserProfileDir(sessionId) {
  return sessionBrowserProfileDir(sessionId);
}

export function runBrowserArtifactDir(runId) {
  return join(runDir(runId), 'browser', 'artifacts');
}

export async function readRunBrowserToken(runId) {
  return (await readFile(runBrowserCapabilityPath(runId), 'utf8').catch(() => '')).trim();
}

export function runSpoolPath(runId) {
  return join(runDir(runId), 'spool.jsonl');
}

// Cold-archive variant of the spool. `scripts/archive-run-spools.mjs` gzips
// terminal-run spools (gzip default, zstd opt-in) and deletes the plain file;
// readers transparently fall back to the archive form so history stays readable
// while disk usage drops by ~86% on terminal runs.
export function runSpoolGzPath(runId) {
  return join(runDir(runId), 'spool.jsonl.gz');
}

export function runSpoolZstPath(runId) {
  return join(runDir(runId), 'spool.jsonl.zst');
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// Determine the codec of an archived spool: the meta sidecar written by
// chat/run-spool-archive.mjs wins, then magic-byte sniffing, then gzip (legacy
// archives predate both sidecar and zstd).
async function sniffArchiveCodec(archivePath) {
  try {
    const meta = JSON.parse(await readFile(archiveMetaPath(archivePath), 'utf8'));
    if (meta?.codec === 'gzip' || meta?.codec === 'zstd') return meta.codec;
  } catch {
    // no sidecar — fall through to magic bytes
  }
  try {
    const fd = await open(archivePath, 'r');
    try {
      const head = Buffer.alloc(4);
      const { bytesRead } = await fd.read(head, 0, 4, 0);
      if (bytesRead >= 2 && head.subarray(0, 2).equals(GZIP_MAGIC)) return 'gzip';
      if (bytesRead >= 4 && head.subarray(0, 4).equals(ZSTD_MAGIC)) return 'zstd';
    } finally {
      await fd.close();
    }
  } catch {
    // unreadable archive — caller handles it as missing
  }
  return 'gzip';
}

// Resolve the readable spool file, preferring the plain (still appendable)
// form and falling back to the archived gzip/zstd form. Returns null when
// neither exists.
async function resolveReadableSpool(runId) {
  const plain = runSpoolPath(runId);
  const plainStats = await statOrNull(plain);
  if (plainStats) return { path: plain, gzipped: false, size: plainStats.size };
  for (const archivePath of [runSpoolGzPath(runId), runSpoolZstPath(runId)]) {
    const stats = await statOrNull(archivePath);
    if (stats) {
      return {
        path: archivePath,
        gzipped: true,
        size: stats.size,
        codec: resolveCodec(await sniffArchiveCodec(archivePath)),
      };
    }
  }
  return null;
}

export function runResultPath(runId) {
  return join(runDir(runId), 'result.json');
}

export function runArtifactsDir(runId) {
  return join(runDir(runId), 'artifacts');
}

function runArtifactPath(runId, ref) {
  return join(runArtifactsDir(runId), `${ref}.txt`);
}

function cacheArtifactText(cacheKey, text) {
  const source = typeof text === 'string' ? text : '';
  const value = source.length > MAX_RUN_ARTIFACT_TEXT_CHARS
    ? `${source.slice(0, MAX_RUN_ARTIFACT_TEXT_CHARS)}${ARTIFACT_TRUNCATION_SUFFIX}`
    : source;
  runArtifactCache.set(cacheKey, value);
  return value;
}

async function writeRunArtifactText(runId, prefix, text) {
  const ref = `${prefix}_${randomBytes(6).toString('hex')}`;
  const path = runArtifactPath(runId, ref);
  await runSpoolWriteWithDeadline(runId, async () => {
    await ensureRunDirectory(runId);
    await writeTextAtomic(path, text || '');
  });
  cacheArtifactText(`${runId}:${ref}`, text);
  return ref;
}

async function readRunArtifactText(runId, ref) {
  const cacheKey = `${runId}:${ref}`;
  // get() handles hit/miss counting and TTL expiry (a stale entry counts as a
  // miss and is re-read).
  const cached = runArtifactCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const path = runArtifactPath(runId, ref);
    const stats = await statOrNull(path);
    if (!stats) return '';
    // DS-08: never materialize an oversized artifact whole into the heap.
    // Beyond the char cap (plus room for a partial trailing UTF-8 sequence)
    // only the prefix the truncated cache entry needs is read; the file on
    // disk is untouched and stays intact for later full reads.
    let text;
    if (stats.size > MAX_RUN_ARTIFACT_TEXT_CHARS + MAX_UTF8_SEQUENCE_BYTES) {
      const fd = await open(path, 'r');
      try {
        const buffer = Buffer.allocUnsafe(MAX_RUN_ARTIFACT_TEXT_CHARS + MAX_UTF8_SEQUENCE_BYTES);
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await fd.close();
      }
    } else {
      text = await readFile(path, 'utf8');
    }
    const value = cacheArtifactText(cacheKey, text);
    // `?? value`: a byte cap smaller than this entry alone would evict it
    // immediately — still return what was read (bounded), it just won't stay
    // resident.
    return runArtifactCache.get(cacheKey) ?? value;
  } catch {
    return '';
  }
}

export async function ensureRunDirectory(runId) {
  // Run directories are shared by the control plane and detached runner.
  // Keep the group-writable contract explicit for upgraded and dev installs.
  await ensureDir(runDir(runId));
  try {
    await chmod(runDir(runId), 0o2770);
  } catch {}
  await ensureDir(runArtifactsDir(runId));
}

export function isTerminalRunState(state) {
  return TERMINAL_STATES.has(state);
}

function pickRunState(currentState, nextState, proposed = {}) {
  const currentCompletedSuccessfully = currentState === 'completed'
    && Number(proposed?.result?.exitCode) === 0
    && proposed?.result?.cancelled !== true
    && !proposed?.result?.error;
  if (currentCompletedSuccessfully
      && nextState === 'failed'
      && proposed?.__overrideSuccessfulTerminal !== true) {
    return 'completed';
  }
  if (isTerminalRunState(nextState)) return nextState;
  if (isTerminalRunState(currentState)) return currentState;
  // A managed approved-action proposal is a durable user pause. The provider
  // process may have already emitted its final result by the time the MCP
  // request is persisted, so do not let the normal "running wins" rule turn
  // this pause into a terminal-looking run before the owner can resolve it.
  if (proposed?.actionPause?.kind === 'approved_action'
    && proposed?.actionPause?.state === 'waiting_user') {
    return 'waiting_user';
  }
  // A provider may have already returned the asynchronous shim acknowledgement
  // and exited. Keep its run addressable while the specific batch still needs
  // an owner decision, rather than allowing an older running state to win.
  if (nextState === 'waiting_user' && proposed?.cancelRequested !== true
      && proposed?.privilegedShimPending?.batchId
      && proposed?.privilegedShimResult?.batchId !== proposed.privilegedShimPending.batchId) {
    return 'waiting_user';
  }
  if (nextState === 'running' || currentState === 'running') return 'running';
  return nextState || currentState || 'accepted';
}

function pickDefined(preferred, fallback, defaultValue = null) {
  if (preferred !== undefined && preferred !== null) return preferred;
  if (fallback !== undefined && fallback !== null) return fallback;
  return defaultValue;
}

function pickMaxInt(currentValue, nextValue, defaultValue = 0) {
  const current = Number.isInteger(currentValue) ? currentValue : null;
  const next = Number.isInteger(nextValue) ? nextValue : null;
  if (current === null && next === null) return defaultValue;
  if (current === null) return next;
  if (next === null) return current;
  return Math.max(current, next);
}

function inferRunReasoningEnabled(input = {}) {
  const effort = typeof input?.effort === 'string' ? input.effort.trim().toLowerCase() : '';
  return effort ? effort !== 'none' : input?.thinking === true;
}

function normalizeRunReasoningVisibility(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['hidden', 'collapsed', 'expanded'].includes(normalized) ? normalized : 'collapsed';
}

function mergeAppServerSteerQueue(currentQueue, proposedQueue) {
  if (!Array.isArray(currentQueue) && !Array.isArray(proposedQueue)) return undefined;
  const mergedByKey = new Map();
  const order = [];

  const mergeEntry = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const key = typeof entry.id === 'string' && entry.id
      ? `id:${entry.id}`
      : typeof entry.requestId === 'string' && entry.requestId
        ? `request:${entry.requestId}`
        : '';
    if (!key) return;
    const existing = mergedByKey.get(key);
    if (!existing) {
      mergedByKey.set(key, { ...entry });
      order.push(key);
      return;
    }
    const wasSent = existing.state === 'sent' || !!existing.sentAt;
    const isSent = entry.state === 'sent' || !!entry.sentAt;
    mergedByKey.set(key, {
      ...existing,
      ...entry,
      ...(wasSent || isSent
        ? {
          state: 'sent',
          sentAt: existing.sentAt || entry.sentAt || null,
        }
        : {}),
    });
  };

  for (const entry of Array.isArray(currentQueue) ? currentQueue : []) mergeEntry(entry);
  for (const entry of Array.isArray(proposedQueue) ? proposedQueue : []) mergeEntry(entry);
  return order.map((key) => mergedByKey.get(key)).filter(Boolean);
}

function normalizeRunProviderContractFields(input = {}) {
  return buildProviderContractFields(input?.runtimeFamily, {
    provider: input?.provider,
    runtimeFamily: input?.runtimeFamily,
    providerCapabilities: input?.providerCapabilities,
  });
}

function normalizeRunPermissionMode(input = {}) {
  const policy = resolveProviderPermissionPolicy({
    runtimeFamily: input?.runtimeFamily,
    providerCapabilities: input?.providerCapabilities,
  }, {
    permissionMode: input?.permissionMode,
    interactionMode: input?.interactionMode,
  });
  return policy?.id || input?.permissionMode || null;
}

function mergeRunRecords(current, proposed) {
  const merged = {
    ...current,
    ...proposed,
  };
  const providerContract = normalizeRunProviderContractFields(merged);
  const recovering = proposed?.authRecovery?.authRetryState === 'auth_retrying';
  const canReopenFailedRun = current?.state === 'failed'
    && !current?.finalizedAt
    && recovering
    && !proposed?.finalizedAt;

  merged.state = canReopenFailedRun
    ? (isTerminalRunState(proposed?.state) ? 'accepted' : (proposed?.state || 'accepted'))
    : pickRunState(current?.state, proposed?.state, proposed);
  merged.ackAt = pickDefined(proposed?.ackAt, current?.ackAt);
  merged.startedAt = pickDefined(proposed?.startedAt, current?.startedAt);
  merged.promptReadyAt = pickDefined(proposed?.promptReadyAt, current?.promptReadyAt);
  merged.runnerStartedAt = pickDefined(proposed?.runnerStartedAt, current?.runnerStartedAt);
  merged.firstTextDeltaAt = pickDefined(proposed?.firstTextDeltaAt, current?.firstTextDeltaAt);
  merged.firstVisibleActivityAt = pickDefined(proposed?.firstVisibleActivityAt, current?.firstVisibleActivityAt);
  merged.firstProviderSemanticEventAt = pickDefined(proposed?.firstProviderSemanticEventAt, current?.firstProviderSemanticEventAt);
  merged.firstProviderReasoningAt = pickDefined(proposed?.firstProviderReasoningAt, current?.firstProviderReasoningAt);
  merged.providerLastByteAt = pickDefined(proposed?.providerLastByteAt, current?.providerLastByteAt);
  merged.providerLastSemanticEventAt = pickDefined(proposed?.providerLastSemanticEventAt, current?.providerLastSemanticEventAt);
  merged.providerLastReasoningAt = pickDefined(proposed?.providerLastReasoningAt, current?.providerLastReasoningAt);
  merged.lastVisibleActivityAt = pickDefined(proposed?.lastVisibleActivityAt, current?.lastVisibleActivityAt);
  merged.completedAt = pickDefined(proposed?.completedAt, current?.completedAt);
  merged.finalizedAt = pickDefined(proposed?.finalizedAt, current?.finalizedAt);
  merged.cancelRequested = current?.cancelRequested === true || proposed?.cancelRequested === true;
  merged.cancelRequestedAt = pickDefined(proposed?.cancelRequestedAt, current?.cancelRequestedAt);
  merged.runnerHeartbeatAt = pickDefined(proposed?.runnerHeartbeatAt, current?.runnerHeartbeatAt);
  merged.runnerHeartbeatCount = pickMaxInt(current?.runnerHeartbeatCount, proposed?.runnerHeartbeatCount, 0);
  merged.stalledAt = pickDefined(proposed?.stalledAt, current?.stalledAt);
  merged.stalledReason = pickDefined(proposed?.stalledReason, current?.stalledReason);
  merged.result = pickDefined(proposed?.result, current?.result);
  merged.failureReason = pickDefined(proposed?.failureReason, current?.failureReason);
  merged.providerResumeId = pickDefined(proposed?.providerResumeId, current?.providerResumeId);
  merged.provider = pickDefined(providerContract.provider, pickDefined(proposed?.provider, current?.provider));
  merged.runtimeFamily = pickDefined(providerContract.runtimeFamily, pickDefined(proposed?.runtimeFamily, current?.runtimeFamily));
  merged.providerCapabilities = pickDefined(
    providerContract.providerCapabilities,
    pickDefined(proposed?.providerCapabilities, current?.providerCapabilities),
  );
  merged.permissionMode = pickDefined(
    normalizeRunPermissionMode(merged),
    pickDefined(proposed?.permissionMode, current?.permissionMode),
  );
  merged.claudeSessionId = pickDefined(proposed?.claudeSessionId, current?.claudeSessionId);
  merged.codexThreadId = pickDefined(proposed?.codexThreadId, current?.codexThreadId);
  merged.reasoningEnabled = typeof proposed?.reasoningEnabled === 'boolean'
    ? proposed.reasoningEnabled
    : (typeof current?.reasoningEnabled === 'boolean'
      ? current.reasoningEnabled
      : inferRunReasoningEnabled(merged));
  merged.reasoningVisibility = normalizeRunReasoningVisibility(
    pickDefined(proposed?.reasoningVisibility, current?.reasoningVisibility, 'collapsed'),
  );
  if (proposed?.__clearTerminalData === true && canReopenFailedRun) {
    merged.completedAt = null;
    merged.finalizedAt = null;
    merged.result = null;
    merged.failureReason = null;
  }
  delete merged.__clearTerminalData;
  delete merged.__overrideSuccessfulTerminal;
  // Auth recovery block merges field-by-field: retry counters only move
  // forward, and the state marker never regresses from a terminal value.
  const currentAuthRecovery = normalizeRunAuthRecovery(current?.authRecovery);
  const proposedAuthRecovery = normalizeRunAuthRecovery(proposed?.authRecovery);
  if (proposed?.authRecovery) {
    merged.authRecovery = mergeRunAuthRecoveryState(currentAuthRecovery, proposedAuthRecovery);
  }
  merged.runnerProcessId = pickDefined(proposed?.runnerProcessId, current?.runnerProcessId);
  merged.runnerUnitName = pickDefined(proposed?.runnerUnitName, current?.runnerUnitName);
  merged.runnerUnitScope = pickDefined(proposed?.runnerUnitScope, current?.runnerUnitScope);
  merged.runnerLaunchMode = pickDefined(proposed?.runnerLaunchMode, current?.runnerLaunchMode);
  merged.runnerSupervisorSocket = pickDefined(proposed?.runnerSupervisorSocket, current?.runnerSupervisorSocket);
  merged.toolProcessId = pickDefined(proposed?.toolProcessId, current?.toolProcessId);
  merged.runnerLaunchAttempt = pickMaxInt(current?.runnerLaunchAttempt, proposed?.runnerLaunchAttempt, 0);
  if (proposed?.__clearRunnerBinding === true) {
    merged.runnerProcessId = null;
    merged.runnerUnitName = null;
    merged.runnerUnitScope = null;
    merged.runnerLaunchMode = null;
    merged.runnerSupervisorSocket = null;
    merged.toolProcessId = null;
    // These timestamps describe one concrete lifecycle submission. Retaining
    // them across an auth-recovery generation makes the replacement runner
    // look as if it reused the predecessor's broker handshake and corrupts
    // queue/launch latency diagnostics.
    merged.runnerLaunchQueuedAt = null;
    merged.runnerLifecycleSubmittedAt = null;
    merged.runnerLifecycleAcceptedAt = null;
  }
  delete merged.__clearRunnerBinding;
  merged.normalizedLineCount = pickMaxInt(current?.normalizedLineCount, proposed?.normalizedLineCount, 0);
  merged.normalizedByteOffset = pickMaxInt(current?.normalizedByteOffset, proposed?.normalizedByteOffset, 0);
  merged.normalizedEventCount = pickMaxInt(current?.normalizedEventCount, proposed?.normalizedEventCount, 0);
  const legacyNormalizedCursor = {
    byteOffset: merged.normalizedByteOffset,
    lineCount: merged.normalizedLineCount,
  };
  const currentNormalizedCursor = getRunSpoolCursor(current, 'normalized');
  const proposedNormalizedCursor = getRunSpoolCursor(proposed, 'normalized');
  const normalizedCursor = {
    byteOffset: Math.max(legacyNormalizedCursor.byteOffset, currentNormalizedCursor.byteOffset, proposedNormalizedCursor.byteOffset),
    lineCount: Math.max(legacyNormalizedCursor.lineCount, currentNormalizedCursor.lineCount, proposedNormalizedCursor.lineCount),
  };
  merged.normalizedByteOffset = normalizedCursor.byteOffset;
  merged.normalizedLineCount = normalizedCursor.lineCount;
  const currentCursors = current?.spoolCursors && typeof current.spoolCursors === 'object'
    ? current.spoolCursors
    : {};
  const proposedCursors = proposed?.spoolCursors && typeof proposed.spoolCursors === 'object'
    ? proposed.spoolCursors
    : {};
  const historyPersistedCursor = normalizeSpoolCursor(
    proposedCursors.historyPersisted,
    normalizeSpoolCursor(currentCursors.historyPersisted, normalizedCursor),
  );
  merged.spoolCursors = {
    ...currentCursors,
    ...proposedCursors,
    normalized: normalizedCursor,
    historyPersisted: {
      byteOffset: Math.max(historyPersistedCursor.byteOffset, normalizedCursor.byteOffset),
      lineCount: Math.max(historyPersistedCursor.lineCount, normalizedCursor.lineCount),
    },
  };
  const suppressionIds = normalizeApprovalSuppressionIds([
    ...(Array.isArray(current?.approvalSuppressionIds) ? current.approvalSuppressionIds : []),
    ...(Array.isArray(proposed?.approvalSuppressionIds) ? proposed.approvalSuppressionIds : []),
  ]);
  if (suppressionIds.length > 0 || current?.approvalSuppressionSeeded === true || proposed?.approvalSuppressionSeeded === true) {
    merged.approvalSuppressionIds = suppressionIds;
    merged.approvalSuppressionSeeded = current?.approvalSuppressionSeeded === true
      || proposed?.approvalSuppressionSeeded === true;
  }
  merged.contextInputTokens = pickMaxInt(current?.contextInputTokens, proposed?.contextInputTokens, null);
  merged.contextWindowTokens = pickMaxInt(current?.contextWindowTokens, proposed?.contextWindowTokens, null);
  const appServerSteerQueue = mergeAppServerSteerQueue(current?.appServerSteerQueue, proposed?.appServerSteerQueue);
  if (appServerSteerQueue) {
    merged.appServerSteerQueue = appServerSteerQueue;
  }

  // A successful provider result is the canonical Run outcome. A launch or
  // recovery error from an older attempt may arrive while terminalization is
  // still draining; never retain that transient failure on the completed Run
  // or leave its reply publication in the contradictory failed state.
  const successfulCompletion = merged.state === 'completed'
    && Number(merged.result?.exitCode) === 0
    && merged.result?.cancelled !== true
    && !merged.result?.error;
  if (successfulCompletion) {
    merged.failureReason = null;
    merged.stalledReason = null;
    if (merged.authRecovery?.authRetryState === 'auth_retrying'
        || merged.authRecovery?.authRetryState === 'reauth_required') {
      merged.authRecovery = {
        ...merged.authRecovery,
        authRetryState: merged.authRecovery.authRetryCount > 0 ? 'auth_recovered' : 'none',
      };
    }
    if (merged.replyPublication
        && String(merged.replyPublication.state || '').trim().toLowerCase() === 'failed') {
      merged.replyPublication = {
        ...merged.replyPublication,
        state: 'ready',
        resolution: String(merged.replyPublication.resolution || '').trim() || 'accepted_as_is',
        readyAt: merged.replyPublication.readyAt || merged.completedAt || new Date().toISOString(),
        failedAt: null,
        lastError: null,
      };
    }
  }

  return merged;
}

export function createRunRecord(input = {}) {
  const id = input.id || createRunId();
  const now = new Date().toISOString();
  const providerContract = normalizeRunProviderContractFields(input);
  return {
    id,
    sessionId: input.sessionId,
    ...(input.appApiMessageVersion !== undefined ? {
      appApiMessageVersion: input.appApiMessageVersion, appApiMessageQueue: input.appApiMessageQueue === true } : {}),
    requestId: input.requestId,
    responseId: input.responseId || null,
    state: input.state || 'accepted',
    tool: input.tool || null,
    model: input.model || null,
    effort: input.effort || null,
    serviceTier: input.serviceTier || 'standard',
    thinking: input.thinking === true,
    createdAt: input.createdAt || now,
    ackAt: input.ackAt || null,
    startedAt: input.startedAt || null,
    promptReadyAt: input.promptReadyAt || null,
    runnerStartedAt: input.runnerStartedAt || null,
    firstTextDeltaAt: input.firstTextDeltaAt || null,
    firstVisibleActivityAt: input.firstVisibleActivityAt || null,
    firstProviderSemanticEventAt: input.firstProviderSemanticEventAt || null,
    firstProviderReasoningAt: input.firstProviderReasoningAt || null,
    providerLastByteAt: input.providerLastByteAt || null,
    providerLastSemanticEventAt: input.providerLastSemanticEventAt || null,
    providerLastReasoningAt: input.providerLastReasoningAt || null,
    lastVisibleActivityAt: input.lastVisibleActivityAt || null,
    updatedAt: input.updatedAt || now,
    completedAt: input.completedAt || null,
    providerResumeId: input.providerResumeId || null,
    provider: providerContract.provider || input.provider || null,
    runtimeFamily: providerContract.runtimeFamily || input.runtimeFamily || null,
    providerCapabilities: providerContract.providerCapabilities || input.providerCapabilities || null,
    permissionMode: normalizeRunPermissionMode({
      ...input,
      runtimeFamily: providerContract.runtimeFamily || input.runtimeFamily,
      providerCapabilities: providerContract.providerCapabilities || input.providerCapabilities,
    }),
    runnerId: input.runnerId || 'runner_local_detached',
    cancelRequested: input.cancelRequested === true,
    cancelRequestedAt: input.cancelRequestedAt || null,
    runnerHeartbeatAt: input.runnerHeartbeatAt || null,
    runnerHeartbeatCount: Number.isInteger(input.runnerHeartbeatCount)
      ? input.runnerHeartbeatCount
      : 0,
    stalledAt: input.stalledAt || null,
    stalledReason: input.stalledReason || null,
    result: input.result || null,
    claudeSessionId: input.claudeSessionId || null,
    codexThreadId: input.codexThreadId || null,
    runnerProcessId: input.runnerProcessId || null,
    runnerUnitName: input.runnerUnitName || null,
    runnerUnitScope: input.runnerUnitScope || null,
    runnerLaunchMode: input.runnerLaunchMode || null,
    runnerSupervisorSocket: input.runnerSupervisorSocket || null,
    toolProcessId: input.toolProcessId || null,
    runnerLaunchAttempt: Number.isSafeInteger(input.runnerLaunchAttempt) && input.runnerLaunchAttempt >= 0
      ? input.runnerLaunchAttempt
      : 0,
    normalizedLineCount: Number.isInteger(input.normalizedLineCount)
      ? input.normalizedLineCount
      : 0,
    normalizedByteOffset: Number.isInteger(input.normalizedByteOffset)
      ? input.normalizedByteOffset
      : 0,
    normalizedEventCount: Number.isInteger(input.normalizedEventCount)
      ? input.normalizedEventCount
      : 0,
    spoolCursors: {
      normalized: getRunSpoolCursor(input, 'normalized'),
      historyPersisted: getRunSpoolCursor(input, 'historyPersisted'),
    },
    ...(Array.isArray(input.approvalSuppressionIds)
      || input.approvalSuppressionSeeded === true
      ? {
        approvalSuppressionIds: normalizeApprovalSuppressionIds(input.approvalSuppressionIds),
        approvalSuppressionSeeded: input.approvalSuppressionSeeded === true,
      }
      : {}),
    finalizedAt: input.finalizedAt || null,
    lastNormalizedAt: input.lastNormalizedAt || null,
    failureReason: input.failureReason || null,
    contextInputTokens: Number.isInteger(input.contextInputTokens) ? input.contextInputTokens : null,
    contextWindowTokens: Number.isInteger(input.contextWindowTokens) ? input.contextWindowTokens : null,
    reasoningEnabled: typeof input.reasoningEnabled === 'boolean'
      ? input.reasoningEnabled
      : inferRunReasoningEnabled(input),
    reasoningVisibility: normalizeRunReasoningVisibility(input.reasoningVisibility),
    replyPublicationRootRunId: input.replyPublicationRootRunId || null,
    replyPublication: input.replyPublication || null,
    ...(input.authRecovery ? { authRecovery: normalizeRunAuthRecovery(input.authRecovery) } : {}),
  };
}

function normalizeSessionControlManifest(manifest, previousManifest = null) {
  const sourceOptions = manifest?.options && typeof manifest.options === 'object'
    ? manifest.options
    : {};
  const rawChannel = sourceOptions.sessionControlChannel;
  if (!rawChannel || typeof rawChannel !== 'object' || Array.isArray(rawChannel)) {
    return { manifest, capabilityToken: '', renewalToken: '', hasChannel: false };
  }

  const capabilityToken = typeof rawChannel.token === 'string' ? rawChannel.token.trim() : '';
  const renewalToken = typeof rawChannel.renewalToken === 'string' ? rawChannel.renewalToken.trim() : '';
  const previousChannel = previousManifest?.options?.sessionControlChannel;
  const currentHash = capabilityToken
    ? (rawChannel.tokenHash || hashSessionControlToken(capabilityToken))
    : rawChannel.tokenHash;
  const previousHashes = [
    ...(Array.isArray(rawChannel.tokenHashes) ? rawChannel.tokenHashes : []),
    previousChannel?.tokenHash,
    ...(Array.isArray(previousChannel?.tokenHashes) ? previousChannel.tokenHashes : []),
  ].filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
  const tokenHashes = [...new Set([currentHash, ...previousHashes].filter(Boolean))].slice(0, 2);
  const persistedChannel = {
    ...rawChannel,
    ...(currentHash ? { tokenHash: currentHash } : {}),
    ...(tokenHashes.length > 1 ? { tokenHashes } : {}),
    ...(capabilityToken ? { tokenFile: rawChannel.tokenFile || SESSION_CONTROL_CAPABILITY_TOKEN_FILE } : {}),
  };
  if (renewalToken) {
    persistedChannel.renewalTokenHash = rawChannel.renewalTokenHash || hashSessionControlToken(renewalToken);
    persistedChannel.renewalTokenFile = rawChannel.renewalTokenFile || SESSION_CONTROL_RENEWAL_TOKEN_FILE;
  }
  delete persistedChannel.token;
  delete persistedChannel.renewalToken;
  return {
    manifest: {
      ...manifest,
      options: {
        ...sourceOptions,
        sessionControlChannel: persistedChannel,
      },
    },
    capabilityToken,
    renewalToken,
    hasChannel: true,
  };
}

async function writeSessionControlSecrets(runId, {
  capabilityToken = '',
  renewalToken = '',
} = {}) {
  if (capabilityToken) {
    await writeTextAtomic(
      runSessionControlCapabilityPath(runId),
      `${capabilityToken}\n`,
      await runFileWriteOptions(runId, { mode: 0o600, durable: true }),
    );
  }
  if (renewalToken) {
    await writeTextAtomic(
      runSessionControlRenewalCapabilityPath(runId),
      `${renewalToken}\n`,
      await runFileWriteOptions(runId, { mode: 0o600, durable: true }),
    );
  }
}

async function getRunUnlocked(runId) {
  const stats = await statOrNull(runStatusPath(runId));
  const cachedMeta = runStatusCacheMeta.get(runId);
  if (stats && cachedMeta
    && stats.mtimeMs === cachedMeta.mtimeMs
    && stats.size === cachedMeta.size
    && runStatusCache.has(runId)) {
    return clone(runStatusCache.get(runId));
  }
  const run = await readJson(runStatusPath(runId), null);
  if (run) {
    runStatusCache.set(runId, run);
    if (stats) runStatusCacheMeta.set(runId, { mtimeMs: stats.mtimeMs, size: stats.size });
    else runStatusCacheMeta.delete(runId);
  } else {
    runStatusCache.delete(runId);
    runStatusCacheMeta.delete(runId);
  }
  return clone(run);
}

async function getRunManifestUnlocked(runId) {
  if (runManifestCache.has(runId)) return clone(runManifestCache.get(runId));
  const manifest = await readJson(runManifestPath(runId), null);
  if (manifest) runManifestCache.set(runId, manifest);
  return clone(manifest);
}

async function getRunResultUnlocked(runId) {
  const stats = await statOrNull(runResultPath(runId));
  const cachedMeta = runResultCacheMeta.get(runId);
  if (stats && cachedMeta
    && stats.mtimeMs === cachedMeta.mtimeMs
    && stats.size === cachedMeta.size
    && runResultCache.has(runId)) {
    return clone(runResultCache.get(runId));
  }
  const result = await readJson(runResultPath(runId), null);
  if (result) {
    runResultCache.set(runId, result);
    if (stats) runResultCacheMeta.set(runId, { mtimeMs: stats.mtimeMs, size: stats.size });
    else runResultCacheMeta.delete(runId);
  } else {
    runResultCache.delete(runId);
    runResultCacheMeta.delete(runId);
  }
  return clone(result);
}

export async function createRun({ status, manifest }, { authorizePublication } = {}) {
  manifest = applyWorkbenchRunPolicy(manifest);
  const run = createRunRecord(status);
  run.runPublication = createRunPublication();
  const baseManifest = bindRunPublication(run, manifest || {});
  assertMessageRunBinding(run, baseManifest);
  const preparedSessionControl = normalizeSessionControlManifest(baseManifest);
  const sanitizedBaseManifest = preparedSessionControl.manifest;
  const turnId = typeof baseManifest.requestId === 'string' && baseManifest.requestId.trim()
    ? baseManifest.requestId.trim()
    : (typeof run.requestId === 'string' ? run.requestId.trim() : '');
  const recoveryCapability = createRunAuthRecoveryCapability({
    runId: run.id,
    sessionId: run.sessionId,
    turnId,
  });
  const browserMcpEnabled = sanitizedBaseManifest?.options?.browserMcpEnabled === true
    || sanitizedBaseManifest?.browserMcpEnabled === true;
  const browserCapability = browserMcpEnabled
    ? createRunBrowserCapability({
      runId: run.id,
      sessionId: run.sessionId,
      turnId,
    })
    : null;
  const manifestOptions = { ...(sanitizedBaseManifest.options || {}) };
  if (!browserMcpEnabled) delete manifestOptions.browserChannel;
  const persistedManifest = (recoveryCapability || browserCapability || preparedSessionControl.hasChannel)
    ? {
      ...sanitizedBaseManifest,
      options: {
        ...manifestOptions,
        ...(recoveryCapability ? {
          runAuthRecoveryChannel: {
            version: recoveryCapability.version,
            endpoint: recoveryCapability.endpoint,
            runId: recoveryCapability.runId,
            sessionId: recoveryCapability.sessionId,
            turnId: recoveryCapability.turnId,
            tokenHash: recoveryCapability.tokenHash,
            tokenFile: 'auth-recovery.cap',
            expiresAt: recoveryCapability.expiresAt,
          },
        } : {}),
        ...(browserCapability ? {
          browserChannel: {
            enabled: true,
            version: browserCapability.version,
            endpoint: browserCapability.endpoint,
            runId: browserCapability.runId,
            sessionId: browserCapability.sessionId,
            turnId: browserCapability.turnId,
            tokenHash: browserCapability.tokenHash,
            tokenFile: browserCapability.tokenFile,
            profileDir: browserCapability.profileDir,
            artifactDir: browserCapability.artifactDir,
            artifactChannel: browserCapability.artifactChannel,
            issuedAt: browserCapability.issuedAt,
            expiresAt: browserCapability.expiresAt,
          },
        } : {}),
      },
    }
    : sanitizedBaseManifest;
  await runMutationQueue(run.id, async () => {
    // Load the directory index before creating the new directory.  Otherwise
    // a boot-time rebuild would see the empty directory and append a temporary
    // placeholder record before the real status is published.
    await ensureRunIndex();
    await ensureRunDirectory(run.id);
    await withRunMutationLock(run.id, async () => {
      // A retry may finish an unpublished orphan, but cannot recreate a published
      // Run or replace its execution identity/credentials, even in another process.
      if (await statOrNull(runStatusPath(run.id))) throw runPublicationError('RUN_ALREADY_EXISTS', 409);
      await authorizePublication?.();
      await writeSessionControlSecrets(run.id, preparedSessionControl);
      if (recoveryCapability) {
        await writeTextAtomic(
          runAuthRecoveryCapabilityPath(run.id),
          `${recoveryCapability.token}\n`,
          await runFileWriteOptions(run.id, { mode: 0o600, durable: true }),
        );
      }
      if (browserCapability) {
        await writeTextAtomic(
          runBrowserCapabilityPath(run.id),
          `${browserCapability.token}\n`,
          await runFileWriteOptions(run.id, { mode: 0o600, durable: true }),
        );
      }
      // Publish the request key before the status file. If the process stops
      // between these two writes, recovery sees a harmless dangling index entry
      // and repairs it; the reverse order could create a false-negative lookup.
      await appendRequestIndexRecord(run);
      // Publish the Run id before status.json for the same crash-window reason.
      // A dangling id is harmless (getRun() returns null) and is repaired on the
      // next boot; publishing after status would make a newly-created Run
      // invisible to recovery if the process stops between the two writes.
      await appendRunIndexRecord(run);
      // status.json is the acceptance commit point. A manifest-only directory is
      // an unpublished orphan, not a Run. All execution inputs precede that point.
      await writeJsonAtomic(runManifestPath(run.id), persistedManifest,
        await runFileWriteOptions(run.id, { ...COMPACT_JSON_OPTIONS, durable: true }));
      await authorizePublication?.();
      await writeJsonAtomic(runStatusPath(run.id), run,
        await runFileWriteOptions(run.id, { ...COMPACT_JSON_OPTIONS, durable: true }));
      runStatusCache.set(run.id, run);
      runManifestCache.set(run.id, persistedManifest);
      await recordCacheMeta(run.id, runStatusPath(run.id), runStatusCacheMeta);
    });
  });
  return clone(run);
}

export async function getRun(runId) {
  return getRunUnlocked(runId);
}

/** Fresh disk evidence for message acceptance; never trust a cached manifest. */
export async function getRunAcceptanceEvidence(runId) {
  const readPublicationFile = async path => {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw runPublicationError();
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw runPublicationError();
    }
  };
  const run = await readPublicationFile(runStatusPath(runId));
  if (!run) return null;
  if (run.id !== runId) throw runPublicationError();
  const manifest = await readPublicationFile(runManifestPath(runId));
  assertRunPublication(run, manifest);
  assertMessageRunBinding(run, manifest);
  return clone(run);
}

// After any in-process write of a run file, record its stat so the mtime-gated
// read caches in getRunUnlocked/getRunResultUnlocked can serve the cached
// value on the next read instead of re-parsing a multi-hundred-KB file.
async function recordCacheMeta(runId, path, metaMap) {
  const stats = await statOrNull(path);
  if (stats) metaMap.set(runId, { mtimeMs: stats.mtimeMs, size: stats.size });
  else metaMap.delete(runId);
}

export async function updateRun(runId, updater, { beforeWrite = null, beforeCommit = null, authorizeWrite = null, preserveOwner = false } = {}) {
  return runMutationQueue(runId, () => withRunMutationLock(runId, async () => {
    const current = await getRunUnlocked(runId);
    if (!current) return null;
    const draft = { ...current };
    const proposed = typeof updater === 'function'
      ? (updater(draft) || draft)
      : { ...draft, ...updater };
    const latest = await getRunUnlocked(runId) || current;
    // Async private authorization runs after lock acquisition, including no-op replay.
    if (authorizeWrite) await authorizeWrite(latest);
    // Perf: an updater that returns the draft object itself signals "nothing
    // to change" — skip the atomic rewrite of status.json entirely. This is
    // what breaks the observer's watch→sync→write→watch feedback loop on idle
    // runs (the observer's own no-op ticks no longer touch the watched file).
    // Object-form callers and spread-style updater callbacks produce fresh
    // objects, so compare their shallow fields too before touching disk.
    const hasChanged = Object.keys(proposed || {}).some((key) => !runFieldEqual(proposed[key], latest[key]));
    if (proposed === draft || !hasChanged) {
      return clone(latest);
    }
    const next = retainRunPublication(latest, mergeRunRecords(latest, proposed));
    if (Object.hasOwn(latest, 'appApiMessageVersion')) {
      if (next.appApiMessageVersion !== latest.appApiMessageVersion)
        throw sessionApiError('MESSAGE_IDEMPOTENCY_CONFLICT', 409, 'Message Run protocol cannot change');
      next.appApiMessageVersion = latest.appApiMessageVersion;
    }
    next.updatedAt = new Date().toISOString();
    // Admission predicates run inside the exact Run mutation queue, after
    // all suspendable reads and immediately before durable publication.
    if (beforeWrite) beforeWrite(next);
    await writeJsonAtomic(runStatusPath(runId), next, await runFileWriteOptions(runId, {
      ...COMPACT_JSON_OPTIONS,
      durable: Boolean(next.runPublication),
      beforeReplace: beforeCommit,
      preserveOwner,
    }));
    runStatusCache.set(runId, next);
    await recordCacheMeta(runId, runStatusPath(runId), runStatusCacheMeta);
    // Heartbeats and observer ticks update status.json frequently.  The index
    // is only appended when an indexed field changed, so liveness writes do
    // not turn into an unbounded second event log.
    const previousIndex = runIndexById.get(runId);
    const nextIndex = runIndexSummary(next);
    if (runIndexSummaryChanged(previousIndex, nextIndex)) {
      await appendRunIndexRecord(next);
    }
    return clone(next);
  }));
}

export async function updateRunManifest(runId, updater) {
  return runMutationQueue(runId, () => withRunMutationLock(runId, async () => {
    const current = await getRunManifestUnlocked(runId);
    if (!current) return null;
    const publicationBaseline = clone(current);
    const draft = { ...current };
    const proposed = typeof updater === 'function'
      ? (updater(draft) || draft)
      : { ...draft, ...updater };
    if (proposed === draft) return clone(current);
    const retained = retainMessageRunBinding(publicationBaseline, retainRunPublication(publicationBaseline, proposed));
    const prepared = normalizeSessionControlManifest({ ...retained, id: runId }, current);
    const next = prepared.manifest;
    await writeSessionControlSecrets(runId, prepared);
    await writeJsonAtomic(runManifestPath(runId), next,
      await runFileWriteOptions(runId, { ...COMPACT_JSON_OPTIONS, durable: Boolean(next.runPublication) }));
    runManifestCache.set(runId, next);
    return clone(next);
  }));
}

export async function getRunManifest(runId) {
  return getRunManifestUnlocked(runId);
}

export async function readRunAuthRecoveryToken(runId) {
  try {
    return (await readFile(runAuthRecoveryCapabilityPath(runId), 'utf8')).trim();
  } catch {
    return '';
  }
}

export async function readRunSessionControlToken(runId) {
  try {
    return (await readFile(runSessionControlCapabilityPath(runId), 'utf8')).trim();
  } catch {
    return '';
  }
}

export async function readRunSessionControlRenewalToken(runId) {
  try {
    return (await readFile(runSessionControlRenewalCapabilityPath(runId), 'utf8')).trim();
  } catch {
    return '';
  }
}

export async function renewRunSessionControlCapability({
  runId,
  sessionId,
  turnId,
  now = Date.now(),
} = {}) {
  const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const normalizedTurnId = typeof turnId === 'string' ? turnId.trim() : '';
  return runMutationQueue(normalizedRunId, () => withRunMutationLock(normalizedRunId, async () => {
    const run = await getRunUnlocked(normalizedRunId);
    const manifest = await getRunManifestUnlocked(normalizedRunId);
    if (!run || !manifest
        || normalizedSessionId !== String(run.sessionId || '').trim()
        || normalizedTurnId !== String(run.requestId || manifest.requestId || '').trim()
        || TERMINAL_STATES.has(String(run.state || '').trim())) {
      const error = new Error('Session-control renewal is revoked');
      error.code = 'SESSION_CONTROL_CAPABILITY_REVOKED';
      throw error;
    }
    const createdAtMs = Date.parse(run.createdAt || '');
    const currentMs = typeof now === 'number' ? now : Date.parse(now);
    const maxExpiresAtMs = (Number.isFinite(createdAtMs) ? createdAtMs : currentMs)
      + SESSION_CONTROL_MAX_RUN_LIFETIME_MS;
    const capability = createRunSessionControlCapability({
      runId: normalizedRunId,
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
      now: currentMs,
      maxExpiresAtMs,
    });
    if (!capability) {
      const error = new Error('Session-control renewal absolute lifetime has expired');
      error.code = 'SESSION_CONTROL_RENEWAL_EXPIRED';
      throw error;
    }

    const currentChannel = manifest.options?.sessionControlChannel;
    const oldRenewalToken = await readRunSessionControlRenewalToken(normalizedRunId);
    const renewal = oldRenewalToken && currentChannel?.renewalTokenHash
      ? {
        token: oldRenewalToken,
        tokenHash: currentChannel.renewalTokenHash,
        version: currentChannel.renewalVersion || 'session-control-renewal/v1',
        endpoint: '/api/internal/session-control/renew',
        runId: normalizedRunId,
        sessionId: normalizedSessionId,
        turnId: normalizedTurnId,
        expiresAt: currentChannel.renewalExpiresAt,
      }
      : createRunSessionControlRenewalCapability({
        runId: normalizedRunId,
        sessionId: normalizedSessionId,
        turnId: normalizedTurnId,
        now: currentMs,
        runCreatedAt: Number.isFinite(createdAtMs) ? createdAtMs : currentMs,
      });
    if (!renewal) {
      const error = new Error('Session-control renewal absolute lifetime has expired');
      error.code = 'SESSION_CONTROL_RENEWAL_EXPIRED';
      throw error;
    }

    const prepared = normalizeSessionControlManifest({
      ...manifest,
      id: normalizedRunId,
      options: {
        ...(manifest.options || {}),
        sessionControlChannel: {
          ...(currentChannel || {}),
          version: capability.version,
          endpoint: capability.endpoint,
          runId: capability.runId,
          sessionId: capability.sessionId,
          turnId: capability.turnId,
          token: capability.token,
          tokenHash: capability.tokenHash,
          tokenHashes: [capability.tokenHash, currentChannel?.tokenHash, ...(currentChannel?.tokenHashes || [])]
            .filter(Boolean)
            .filter((value, index, values) => values.indexOf(value) === index)
            .slice(0, 2),
          issuedAt: capability.issuedAt,
          expiresAt: capability.expiresAt,
          renewalVersion: renewal.version,
          renewalEndpoint: renewal.endpoint,
          renewalToken: renewal.token,
          renewalTokenHash: renewal.tokenHash,
          renewalTokenFile: SESSION_CONTROL_RENEWAL_TOKEN_FILE,
          renewalExpiresAt: renewal.expiresAt,
        },
      },
    }, manifest);
    await writeSessionControlSecrets(normalizedRunId, prepared);
    await writeJsonAtomic(runManifestPath(normalizedRunId), prepared.manifest,
      await runFileWriteOptions(normalizedRunId, { ...COMPACT_JSON_OPTIONS, durable: Boolean(prepared.manifest.runPublication) }));
    runManifestCache.set(normalizedRunId, prepared.manifest);
    return { capability, renewal, manifest: clone(prepared.manifest) };
  }));
}

export async function getRunResult(runId) {
  return getRunResultUnlocked(runId);
}

export async function writeRunResult(runId, result) {
  await runMutationQueue(runId, () => withRunMutationLock(runId, async () => {
    await ensureRunDirectory(runId);
    await writeJsonAtomic(runResultPath(runId), result || {}, COMPACT_JSON_OPTIONS);
    runResultCache.set(runId, result || {});
    await recordCacheMeta(runId, runResultPath(runId), runResultCacheMeta);
  }));
  return getRunResultUnlocked(runId);
}

export async function clearRunResult(runId) {
  await runMutationQueue(runId, () => withRunMutationLock(runId, async () => {
    await removePath(runResultPath(runId));
    runResultCache.delete(runId);
    runResultCacheMeta.delete(runId);
  }));
  return null;
}

async function externalizeStringField(runId, container, field, prefix) {
  if (!container || typeof container[field] !== 'string') return false;
  const value = container[field];
  if (!value || value.length <= MAX_SPOOL_INLINE_CHARS) return false;
  container[field] = clipMiddle(value);
  container[`${field}Artifact`] = await writeRunArtifactText(runId, prefix, value);
  container[`${field}Bytes`] = Buffer.byteLength(value, 'utf8');
  return true;
}

async function sanitizeStructuredRecord(runId, value) {
  const next = clone(value);
  if (!next || typeof next !== 'object') return next;

  if (next.item && typeof next.item === 'object') {
    await externalizeStringField(runId, next.item, 'aggregated_output', 'aggregated_output');
    await externalizeStringField(runId, next.item, 'text', 'item_text');
    await externalizeStringField(runId, next.item, 'command', 'item_command');
  }

  if (next.message && typeof next.message === 'object' && Array.isArray(next.message.content)) {
    for (const block of next.message.content) {
      if (!block || typeof block !== 'object') continue;
      await externalizeStringField(runId, block, 'text', 'message_text');
      await externalizeStringField(runId, block, 'thinking', 'message_thinking');
      await externalizeStringField(runId, block, 'input', 'message_input');
      await externalizeStringField(runId, block, 'content', 'message_content');
    }
  }

  if (next.event && typeof next.event === 'object' && next.event.delta && typeof next.event.delta === 'object') {
    await externalizeStringField(runId, next.event.delta, 'thinking', 'event_thinking');
    await externalizeStringField(runId, next.event.delta, 'text', 'event_text');
  }

  return next;
}

async function hydrateStructuredRecord(runId, value) {
  const next = clone(value);
  if (!next || typeof next !== 'object') return next;

  const restoreField = async (container, field) => {
    const artifactKey = `${field}Artifact`;
    if (!container?.[artifactKey]) return;
    container[field] = await readRunArtifactText(runId, container[artifactKey]);
  };

  if (next.item && typeof next.item === 'object') {
    await restoreField(next.item, 'aggregated_output');
    await restoreField(next.item, 'text');
    await restoreField(next.item, 'command');
  }

  if (next.message && typeof next.message === 'object' && Array.isArray(next.message.content)) {
    for (const block of next.message.content) {
      if (!block || typeof block !== 'object') continue;
      await restoreField(block, 'text');
      await restoreField(block, 'thinking');
      await restoreField(block, 'input');
      await restoreField(block, 'content');
    }
  }

  if (next.event && typeof next.event === 'object' && next.event.delta && typeof next.event.delta === 'object') {
    await restoreField(next.event.delta, 'thinking');
    await restoreField(next.event.delta, 'text');
  }

  return next;
}

async function normalizeSpoolRecord(runId, record) {
  const normalized = { ...(record || {}) };
  // A spool record may be projected more than once after an observer/server
  // restart. Persist a writer-assigned identity with the record itself so the
  // projection can distinguish replaying this exact record from a new,
  // textually-similar provider frame. Callers may retain an existing id when
  // retrying their own write; all ordinary writes get a fresh opaque id.
  const suppliedRecordId = typeof normalized.recordId === 'string'
    ? normalized.recordId.trim()
    : '';
  normalized.recordId = suppliedRecordId || `spool_${randomBytes(12).toString('hex')}`;
  if (normalized.json && typeof normalized.json === 'object') {
    // DS-14: writers historically passed `line = JSON.stringify(json)` next to
    // `json`. Both readers (materializeRunSpoolLine below and run-projection
    // clipPreview) prefer `json` and derive the text string from it; `line` is
    // only the fallback for raw/unstructured records that carry no `json`.
    // Storing both roughly doubled every structured spool (~82-87%, measured
    // from the historical double-write format during DS-14 design). Drop the
    // line field when
    // it is exactly the serialization of the *raw* json — a pure duplicate.
    // (Compared before sanitize: externalized fields change the serialization.)
    // Raw records keep `line`; a line that differs from JSON.stringify(json)
    // (e.g. human-readable error text beside a structured payload) is not a
    // duplicate and is preserved.
    if (typeof normalized.line === 'string' && normalized.line === JSON.stringify(normalized.json)) {
      delete normalized.line;
    }
    normalized.json = await sanitizeStructuredRecord(runId, normalized.json);
  }
  if (typeof normalized.line === 'string' && normalized.line.length > MAX_SPOOL_INLINE_CHARS) {
    const ref = await writeRunArtifactText(runId, 'line', normalized.line);
    normalized.lineArtifact = ref;
    normalized.lineBytes = Buffer.byteLength(normalized.line, 'utf8');
    normalized.line = clipMiddle(normalized.line);
  }
  return normalized;
}

export async function flushRunSpool(runId) {
  return runMutationQueue(runId, () => flushRunSpoolUnlocked(runId));
}

export async function appendRunSpoolRecord(runId, record, options = {}) {
  return runMutationQueue(runId, async () => {
    const normalized = await normalizeSpoolRecord(runId, record);
    if (options?.buffered === true) {
      const buffered = spoolBufferByRunId.get(runId) || [];
      const recordBytes = spoolRecordBytes(normalized);
      const bufferedBytes = spoolBufferBytes(buffered);
      // Flush before adding the next frame once either bound is reached. If
      // the flush fails, the existing bounded batch stays intact and this
      // frame is rejected instead of growing the queue on every retry.
      if (
        buffered.length >= SPOOL_BUFFER_MAX_RECORDS
        || (buffered.length > 0 && bufferedBytes + recordBytes > SPOOL_BUFFER_MAX_BYTES)
      ) {
        await flushRunSpoolUnlocked(runId);
      }
      const nextBuffered = spoolBufferByRunId.get(runId) || [];
      nextBuffered.push(normalized);
      spoolBufferByRunId.set(runId, nextBuffered);
      if (
        nextBuffered.length >= SPOOL_BUFFER_MAX_RECORDS
        || spoolBufferBytes(nextBuffered) >= SPOOL_BUFFER_MAX_BYTES
      ) {
        await flushRunSpoolUnlocked(runId);
      } else {
        scheduleRunSpoolFlush(runId);
      }
      return normalized;
    }
    // Immediate control/terminal records must follow any buffered provider
    // frames in the same run, otherwise the spool order would be ambiguous.
    await flushRunSpoolUnlocked(runId);
    await appendRunSpoolPayload(runId, `${JSON.stringify(normalized)}\n`);
    return normalized;
  });
}

export async function readRunSpoolRecords(runId) {
  try {
    await flushRunSpool(runId);
    const resolved = await resolveReadableSpool(runId);
    if (!resolved) return [];
    if (resolved.gzipped) {
      const ring = new Array(MAX_SPOOL_DELTA_RECORDS);
      let count = 0;
      for await (const record of readArchivedSpoolRecords(resolved.path, resolved.codec)) {
        ring[count % MAX_SPOOL_DELTA_RECORDS] = record;
        count += 1;
      }
      return collectTailBounded(ring, count, MAX_SPOOL_DELTA_RECORDS);
    }
    const ring = new Array(MAX_SPOOL_DELTA_RECORDS);
    let count = 0;
    for await (const record of readPlainSpoolRecords(resolved.path)) {
      ring[count % MAX_SPOOL_DELTA_RECORDS] = record;
      count += 1;
    }
    return collectTailBounded(ring, count, MAX_SPOOL_DELTA_RECORDS);
  } catch {
    return [];
  }
}

// Stream every parseable spool record without retaining a tail.  The normal
// observer deliberately reads only the last MAX_SPOOL_DELTA_RECORDS records,
// but terminal replay must still be able to account for and persist events
// that were produced before that bounded live window.  Keeping this as an
// async generator lets projection consume a multi-million-line run with
// constant memory.
export async function* streamRunSpoolRecords(runId) {
  try {
    await flushRunSpool(runId);
    const resolved = await resolveReadableSpool(runId);
    if (!resolved) return;
    const source = resolved.gzipped
      ? readArchivedSpoolRecords(resolved.path, resolved.codec)
      : readPlainSpoolRecords(resolved.path);
    for await (const record of source) yield record;
  } catch {
    // Spool readers are recovery helpers; a missing/corrupt spool is handled
    // by the normal run reconciliation path.  Match readRunSpoolRecords' safe
    // empty behavior instead of surfacing a secondary terminalization error.
  }
}

// Invoke a callback for every parseable spool record without retaining the
// spool tail. Projection startup uses this when it only needs to seed adapter
// state from historical control frames (for example auto-approval echoes).
export async function scanRunSpoolRecords(runId, visitor) {
  if (typeof visitor !== 'function') throw new TypeError('scanRunSpoolRecords requires a visitor');
  try {
    await flushRunSpool(runId);
    const resolved = await resolveReadableSpool(runId);
    if (!resolved) return;
    const source = resolved.gzipped
      ? readArchivedSpoolRecords(resolved.path, resolved.codec)
      : readPlainSpoolRecords(resolved.path);
    for await (const record of source) {
      if (await visitor(record) === false) return;
    }
  } catch {
    // Spool readers are recovery helpers; a missing/corrupt spool is handled
    // by the normal run reconciliation path.
  }
}

function collectTailBounded(ring, count, cap) {
  const total = Math.min(count, cap);
  const records = new Array(total);
  const start = count > cap ? count % cap : 0;
  for (let index = 0; index < total; index += 1) {
    records[index] = ring[(start + index) % cap];
  }
  return records;
}

// Yield text chunks of an archived spool file (gzip or zstd), each chunk ending
// on a newline (or EOF). Chunk boundaries are adjusted so multi-byte UTF-8
// sequences are never split; a trailing partial line is carried to the next
// chunk.
async function* openReadableSpoolStream(path, codec = 'gzip') {
  const decompressor = codec === 'zstd' ? createZstdDecompress() : createGunzip();
  const source = await open(path, 'r');
  let remainder = '';
  const decoder = new StringDecoder('utf8');
  try {
    const pipeline = source.createReadStream().pipe(decompressor);
    for await (const chunk of pipeline) {
      remainder += decoder.write(chunk);
      const lastNewline = remainder.lastIndexOf('\n');
      if (lastNewline === -1) continue;
      yield remainder.slice(0, lastNewline + 1);
      remainder = remainder.slice(lastNewline + 1);
    }
    const tail = remainder + decoder.end();
    if (tail) yield tail;
  } finally {
    source.close().catch(() => {});
  }
}

// Stream an archived spool file line by line, emitting only parseable records.
// Used for archived (terminal) spools that are no longer appended to. The
// caller is responsible for stopping early (records are bounded per call).
async function* readArchivedSpoolRecords(path, codec = 'gzip') {
  for await (const chunk of openReadableSpoolStream(path, codec)) {
    let idx;
    let start = 0;
    while ((idx = chunk.indexOf('\n', start)) !== -1) {
      const raw = chunk.slice(start, idx);
      start = idx + 1;
      const line = raw.trim();
      if (!line) continue;
      if (line.length > MAX_SPOOL_RECORD_CHARS) continue;
      const record = maybeParseSpoolRecord(line);
      if (record) yield record;
    }
  }
}

// Plain spools are append-only JSONL files. Read them in bounded chunks and
// yield one parsed record at a time; never use readFile().split() here because
// terminal recovery can touch multi-hundred-megabyte spools.
async function* readPlainSpoolRecords(path) {
  const fd = await open(path, 'r');
  const buffer = Buffer.allocUnsafe(SPOOL_READ_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let position = 0;
  let remainder = '';
  let discardingOversizeLine = false;
  try {
    while (true) {
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      let chunk = remainder + decoder.write(buffer.subarray(0, bytesRead));
      remainder = '';
      let start = 0;

      if (discardingOversizeLine) {
        const newline = chunk.indexOf('\n');
        if (newline === -1) continue;
        start = newline + 1;
        discardingOversizeLine = false;
      }

      while (start < chunk.length) {
        const newline = chunk.indexOf('\n', start);
        if (newline === -1) break;
        const line = chunk.slice(start, newline).trim();
        start = newline + 1;
        if (!line || line.length > MAX_SPOOL_RECORD_CHARS) continue;
        const record = maybeParseSpoolRecord(line);
        if (record) yield record;
      }

      remainder = chunk.slice(start);
      if (remainder.length > MAX_SPOOL_RECORD_CHARS) {
        remainder = '';
        discardingOversizeLine = true;
      }
    }

    const tail = remainder + decoder.end();
    if (!discardingOversizeLine && tail.trim().length <= MAX_SPOOL_RECORD_CHARS) {
      const record = maybeParseSpoolRecord(tail);
      if (record) yield record;
    }
  } finally {
    await fd.close().catch(() => {});
  }
}

function maybeParseSpoolRecord(line) {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function findOffsetAfterLines(fd, fileSize, lineCount) {
  if (!lineCount || lineCount <= 0) {
    return { offset: 0, skippedLineCount: 0 };
  }

  const buffer = Buffer.allocUnsafe(SPOOL_READ_CHUNK_BYTES);
  let position = 0;
  let skippedLineCount = 0;
  while (position < fileSize) {
    const bytesToRead = Math.min(buffer.length, fileSize - position);
    const { bytesRead } = await fd.read(buffer, 0, bytesToRead, position);
    if (bytesRead <= 0) break;

    let searchStart = 0;
    while (searchStart < bytesRead) {
      const index = buffer.indexOf(0x0A, searchStart);
      if (index === -1 || index >= bytesRead) break;
      skippedLineCount += 1;
      if (skippedLineCount >= lineCount) {
        return {
          offset: position + index + 1,
          skippedLineCount,
        };
      }
      searchStart = index + 1;
    }

    position += bytesRead;
  }

  return { offset: position, skippedLineCount };
}

export async function readRunSpoolDelta(runId, options = {}) {
  try {
    await flushRunSpool(runId);
    const resolved = await resolveReadableSpool(runId);
    if (!resolved) {
      return {
        records: [],
        nextOffset: 0,
        processedLineCount: 0,
      };
    }
    const path = resolved.path;
    const stats = await statOrNull(path);

    // Archived (gzipped) spools are immutable and cannot be seeked by offset.
    // Read the whole decompressed stream once, honoring skipLines/maxRecords
    // for a bounded read; nextOffset stays 0 because there is no resume
    // position that stays valid across a re-read.
    if (resolved.gzipped) {
      const records = [];
      let processedLineCount = 0;
      let skippedLineCount = 0;
      let truncated = false;
      const maxRecords = Number.isInteger(options.maxRecords) && options.maxRecords >= 0
        ? options.maxRecords
        : MAX_SPOOL_DELTA_RECORDS;
      for await (const chunk of openReadableSpoolStream(path, resolved.codec)) {
        let idx;
        let start = 0;
        while ((idx = chunk.indexOf('\n', start)) !== -1) {
          const raw = chunk.slice(start, idx);
          start = idx + 1;
          const line = raw.trim();
          if (!line) continue;
          processedLineCount++;
          if (skippedLineCount < Math.max(0, Number.isInteger(options.skipLines) ? options.skipLines : 0)) {
            skippedLineCount++;
            continue;
          }
          if (line.length > MAX_SPOOL_RECORD_CHARS) {
            truncated = true;
            continue;
          }
          const record = maybeParseSpoolRecord(line);
          if (record) {
            records.push(record);
            if (records.length >= maxRecords) {
              truncated = true;
              break;
            }
          }
        }
        if (truncated) break;
      }
      return { records, nextOffset: 0, processedLineCount, skippedLineCount, truncated };
    }

    if (!stats) {
      return {
        records: [],
        nextOffset: 0,
        processedLineCount: 0,
      };
    }

    const requestedOffset = Number.isInteger(options.startOffset) ? options.startOffset : 0;
    const canResumeFromOffset = requestedOffset > 0 && requestedOffset <= stats.size;
    let startOffset = canResumeFromOffset ? requestedOffset : 0;
    const records = [];
    const maxRecords = Number.isInteger(options.maxRecords) && options.maxRecords >= 0
      ? options.maxRecords
      : MAX_SPOOL_DELTA_RECORDS;
    let truncated = false;
    let processedLineCount = 0;
    let skippedLineCount = 0;
    let remainder = Buffer.alloc(0);
    let remainderOffset = startOffset;
    let discardingOversizeLine = false;
    let position = startOffset;
    const buffer = Buffer.allocUnsafe(SPOOL_READ_CHUNK_BYTES);
    const fd = await open(path, 'r');
    let nextOffset = startOffset;

    try {
      if (!canResumeFromOffset) {
        const recovery = await findOffsetAfterLines(
          fd,
          stats.size,
          Math.max(0, Number.isInteger(options.skipLines) ? options.skipLines : 0),
        );
        startOffset = recovery.offset;
        skippedLineCount = recovery.skippedLineCount;
        position = startOffset;
      }

      while (position < stats.size) {
        const bytesToRead = Math.min(buffer.length, stats.size - position);
        const { bytesRead } = await fd.read(buffer, 0, bytesToRead, position);
        if (bytesRead <= 0) break;
        position += bytesRead;

        const chunkStartOffset = position - bytesRead;
        let chunk = buffer.subarray(0, bytesRead);
        if (discardingOversizeLine) {
          const newlineIndex = chunk.indexOf(0x0A);
          if (newlineIndex === -1) {
            continue;
          }
          processedLineCount += 1;
          nextOffset = chunkStartOffset + newlineIndex + 1;
          discardingOversizeLine = false;
          chunk = chunk.subarray(newlineIndex + 1);
          remainderOffset = nextOffset;
        }

        const dataStartOffset = remainder.length > 0 ? remainderOffset : (chunkStartOffset + (bytesRead - chunk.length));
        if (remainder.length > 0) chunk = Buffer.concat([remainder, chunk]);
        let lineStart = 0;
        while (true) {
          const newlineIndex = chunk.indexOf(0x0A, lineStart);
          if (newlineIndex === -1) break;

          const line = chunk.subarray(lineStart, newlineIndex).toString('utf8');
          const lineEndOffset = dataStartOffset + newlineIndex + 1;
          processedLineCount += 1;
          nextOffset = lineEndOffset;
          if (!line || line.length > MAX_SPOOL_RECORD_CHARS) {
            lineStart = newlineIndex + 1;
            continue;
          }
          const record = maybeParseSpoolRecord(line);
          if (record) {
            records.push(record);
            if (maxRecords > 0 && records.length >= maxRecords) {
              // Resume immediately after the last returned record. The old
              // implementation scanned to EOF here, advanced the cursor to
              // EOF, and silently discarded every remaining record.
              truncated = lineEndOffset < stats.size;
              lineStart = newlineIndex + 1;
              break;
            }
          }
          lineStart = newlineIndex + 1;
        }
        if (truncated) break;
        remainder = chunk.subarray(lineStart);
        remainderOffset = dataStartOffset + lineStart;
        if (remainder.length > MAX_SPOOL_RECORD_CHARS) {
          remainder = Buffer.alloc(0);
          discardingOversizeLine = true;
        }
      }

      if (discardingOversizeLine) {
        // The final unterminated oversized line is still one consumed line.
        processedLineCount += 1;
        nextOffset = stats.size;
      } else if (remainder.length > 0) {
        processedLineCount += 1;
        nextOffset = stats.size;
        if (!truncated && remainder.length <= MAX_SPOOL_RECORD_CHARS) {
          const record = maybeParseSpoolRecord(remainder.toString('utf8'));
          if (record) records.push(record);
        }
      }
      if (!truncated) nextOffset = stats.size;
    } finally {
      await fd.close();
    }

    return {
      records,
      nextOffset,
      processedLineCount,
      skippedLineCount,
      truncated,
    };
  } catch {
    return {
      records: [],
      nextOffset: 0,
      processedLineCount: 0,
      skippedLineCount: 0,
      truncated: false,
    };
  }
}

export async function materializeRunSpoolLine(runId, record) {
  if (record?.json && typeof record.json === 'object') {
    return JSON.stringify(await hydrateStructuredRecord(runId, record.json));
  }
  if (record?.lineArtifact) {
    return readRunArtifactText(runId, record.lineArtifact);
  }
  return typeof record?.line === 'string' ? record.line : '';
}

export async function requestRunCancel(runId, { beforeWrite = null, authorizeWrite = null } = {}) {
  return updateRun(runId, (run) => ({
    ...run,
    cancelRequested: true,
    cancelRequestedAt: new Date().toISOString(),
  }), { beforeWrite, authorizeWrite });
}

export async function listRunIds() {
  await ensureRunIndex();
  return [...runIndexById.keys()].sort();
}

// Run storage is keyed by run id rather than session id. Remove terminal run
// records with their session so permanent session deletion cannot leave
// orphaned prompts, spool output, or artifacts behind.
export async function removeRunsForSession(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return [];
  const removedRunIds = [];
  // The durable index already carries the immutable session binding. Avoid a
  // full Run-directory walk and status.json read for every unrelated session
  // when deleting one session in a large installation. Keep getRun() as the
  // authority before removal so a stale/legacy index entry cannot delete a Run
  // that was rebound by an external repair.
  const indexedCandidates = await listRunIndexEntries({ sessionId: normalizedSessionId });
  for (const indexed of indexedCandidates) {
    const runId = indexed?.id;
    if (!runId) continue;
    const run = await getRun(runId);
    if (run?.sessionId !== normalizedSessionId) continue;
    await runMutationQueue(runId, async () => {
      await removePath(runDir(runId));
      await appendRequestIndexRecord(run, 'delete');
      await appendRunIndexRecord(run, 'delete');
      runStatusCache.delete(runId);
      runStatusCacheMeta.delete(runId);
      runManifestCache.delete(runId);
      runResultCache.delete(runId);
      runResultCacheMeta.delete(runId);
      runArtifactCache.delete(runId);
    });
    removedRunIds.push(runId);
  }
  return removedRunIds;
}

async function scanRunByRequest(sessionId, requestId, limit = REQUEST_INDEX_REPAIR_SCAN_LIMIT) {
  const boundedLimit = Math.max(0, Number.isInteger(limit) ? limit : REQUEST_INDEX_REPAIR_SCAN_LIMIT);
  if (boundedLimit === 0) return null;
  const runIds = (await listRunIds()).reverse().slice(0, boundedLimit);
  for (const runId of runIds) {
    const run = await getRun(runId);
    if (!run) continue;
    if (normalizeRequestIndexValue(run.sessionId) === sessionId
      && normalizeRequestIndexValue(run.requestId) === requestId) {
      return getRunAcceptanceEvidence(runId);
    }
  }
  return null;
}

export async function findRunByRequest(sessionId, requestId) {
  const normalizedSessionId = normalizeRequestIndexValue(sessionId);
  const normalizedRequestId = normalizeRequestIndexValue(requestId);
  if (!normalizedSessionId || !normalizedRequestId) return null;

  await ensureRequestIndex();
  const key = requestIndexKey(normalizedSessionId, normalizedRequestId);
  const indexedRunId = runRequestIndex.get(key);
  if (!indexedRunId) return null;

  // createRun publishes the index before status.json so a crash cannot leave a
  // durable Run that is invisible to retries. A concurrent lookup can observe
  // that small gap; retry while the Run directory still exists before taking
  // the bounded repair path.
  let indexedRun = null;
  let indexedRunDirectoryExists = false;
  for (let attempt = 0; attempt < REQUEST_INDEX_PENDING_RETRY_LIMIT; attempt += 1) {
    indexedRun = await getRunAcceptanceEvidence(indexedRunId);
    if (indexedRun) break;
    indexedRunDirectoryExists = Boolean(await statOrNull(runDir(indexedRunId)));
    if (!indexedRunDirectoryExists || attempt + 1 >= REQUEST_INDEX_PENDING_RETRY_LIMIT) break;
    await sleepBriefly(REQUEST_INDEX_PENDING_RETRY_DELAY_MS);
  }
  if (indexedRun
    && normalizeRequestIndexValue(indexedRun.sessionId) === normalizedSessionId
    && normalizeRequestIndexValue(indexedRun.requestId) === normalizedRequestId) {
    return indexedRun;
  }

  // A crash can leave a dangling entry, or an operator may have removed a run
  // directory outside the normal deletion path. Repair only this key. The
  // bounded scan is deliberately unreachable on the normal indexed hit/miss
  // path, so an unknown request never walks the full Run pool.
  const recoveredRun = await scanRunByRequest(normalizedSessionId, normalizedRequestId);
  if (recoveredRun) {
    await appendRequestIndexRecord(recoveredRun);
  } else if (!indexedRunDirectoryExists || indexedRun) {
    // Do not delete an entry while createRun may still be writing status.json:
    // the directory-exists check is the race guard for that publication gap.
    await appendRequestIndexRecord({
      id: indexedRunId,
      sessionId: normalizedSessionId,
      requestId: normalizedRequestId,
    }, 'delete');
  }
  return recoveredRun;
}
