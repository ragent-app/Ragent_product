/**
 * chat/memory-registry.mjs — unified memory/performance registry (DS-06).
 *
 * Every bounded in-memory structure of the chat server (LRU caches, dedup
 * key sets, observed-run watchers, background AI queue, static asset cache)
 * registers a JSON-safe snapshot here. /healthz and the owner-only
 * /api/diagnostics/memory route render aggregates; a periodic sampler keeps a
 * ring of snapshots so trends are visible after the fact.
 *
 * Contract:
 *   - Snapshots contain ONLY counts, byte estimates and monotonic counters —
 *     never cached values, keys, paths, session bodies, tokens or cookies.
 *   - Registration names are static strings chosen by the registering module.
 *   - snapshot(now) must be synchronous and O(cached entries); the sampler
 *     runs on the event loop and must stay cheap.
 *   - The module imports nothing from the rest of the codebase so it can be
 *     unit-tested standalone.
 */

const cacheEntries = new Map(); // name -> { kind, snapshot(now) }
const KNOWN_METRIC_KEYS = new Set([
  'name', 'entries', 'bytes', 'hits', 'misses', 'evictions', 'hitRate',
  'oldestEntryAgeMs', 'maxEntries', 'maxBytes', 'error',
]);

function finiteNumberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function finiteNumberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

/** Registry entry with every metric field normalized to a JSON-safe value. */
function normalizeMetrics(name, entry, now) {
  let metrics = {};
  let caughtError = null;
  try {
    metrics = entry.snapshot(now) || {};
  } catch (error) {
    caughtError = error;
  }
  const out = {
    name,
    kind: entry.kind || 'cache',
    // Every gauge has stable numeric cardinality/byte fields. Counter-only
    // registrations (for example approval suppression) need not invent an
    // entry count, so expose zero instead of null to keep consumers simple.
    entries: finiteNumberOrZero(metrics.entries),
    bytes: finiteNumberOrZero(metrics.bytes),
    hits: finiteNumberOrNull(metrics.hits),
    misses: finiteNumberOrNull(metrics.misses),
    evictions: finiteNumberOrNull(metrics.evictions),
    hitRate: finiteNumberOrNull(metrics.hitRate),
    oldestEntryAgeMs: finiteNumberOrNull(metrics.oldestEntryAgeMs),
    maxEntries: finiteNumberOrNull(metrics.maxEntries),
    maxBytes: finiteNumberOrNull(metrics.maxBytes),
  };
  if (caughtError) {
    out.error = String(caughtError?.message || caughtError || 'snapshot failed');
    return out;
  }
  // Pass through extra scalar fields the registering module chooses to expose
  // (e.g. queue depth split by state). Never keys or values.
  for (const [key, value] of Object.entries(metrics)) {
    if (KNOWN_METRIC_KEYS.has(key)) continue;
    if (value === undefined) continue;
    if (typeof value === 'object' || typeof value === 'function') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Register a snapshot provider. Idempotent per name: re-registration replaces
 * the snapshot (module re-imports / test rebuilds keep working).
 */
export function registerCache(name, descriptor = {}) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new TypeError('registerCache requires a non-empty static name');
  }
  if (typeof descriptor.snapshot !== 'function') {
    throw new TypeError(`registerCache(${name}): snapshot() function required`);
  }
  cacheEntries.set(name, {
    kind: typeof descriptor.kind === 'string' ? descriptor.kind : 'cache',
    snapshot: descriptor.snapshot,
  });
}

export function unregisterCache(name) {
  cacheEntries.delete(name);
}

/** Test hook: clear every registration (standalone tests start clean). */
export function unregisterAllCaches() {
  cacheEntries.clear();
}

/**
 * Register a Map-like cache. BoundedLruMap instances expose snapshotMetrics()
 * (hits/misses/evictions/age); plain Maps fall back to size + optional byte
 * estimate with zeroed counters, which also covers the RAGENT_PERF_CACHES=off
 * path where makeLruOrMap() substitutes plain Maps.
 */
export function registerLruOrMap(name, cache, { kind = 'lru', bytesOf = null } = {}) {
  registerCache(name, {
    kind,
    snapshot: (now) => (
      typeof cache?.snapshotMetrics === 'function'
        ? cache.snapshotMetrics(now)
        : mapMetrics(cache, { now, bytesOf })
    ),
  });
}

/** Metrics for a plain Map/Set: size, optional byte estimate, zeroed counters. */
export function mapMetrics(map, { now = Date.now(), bytesOf = null } = {}) {
  let bytes = 0;
  for (const [key, value] of map) {
    if (bytesOf) bytes += estimateEntryBytes(bytesOf, value, key);
  }
  return {
    entries: map?.size || 0,
    bytes,
    hits: 0,
    misses: 0,
    evictions: 0,
    hitRate: null,
    oldestEntryAgeMs: null,
    maxEntries: null,
    maxBytes: null,
  };
}

function estimateEntryBytes(bytesOf, value, key) {
  try {
    const count = bytesOf(value, key);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

/** All registered cache gauges as a JSON-safe array. */
export function collectCacheMetrics({ now = Date.now() } = {}) {
  const out = [];
  for (const [name, entry] of cacheEntries) {
    out.push(normalizeMetrics(name, entry, now));
  }
  return out;
}

export function getRegisteredCacheNames() {
  return [...cacheEntries.keys()];
}

// --- periodic sampler -------------------------------------------------------

const samplerState = {
  running: false,
  timer: null,
  intervalMs: 60_000,
  maxSamples: 60,
  collect: null,
  onSample: null,
  now: () => Date.now(),
  samples: [],
  samplesCollected: 0,
  lastSampleAtMs: null,
  expectedSampleAtMs: null,
  startedAtMs: null,
  tickErrors: 0,
};

/**
 * Configure the global sampler. `collect` returns one full snapshot object
 * (chat-server composes process memory + event loop + cache gauges); when
 * omitted, a snapshot of just the cache gauges is collected. A sample is
 * pushed into a bounded ring so memory stays flat.
 */
export function configureSampler({
  collect = null,
  onSample = null,
  intervalMs = 60_000,
  maxSamples = 60,
  now = () => Date.now(),
} = {}) {
  samplerState.collect = typeof collect === 'function' ? collect : null;
  samplerState.onSample = typeof onSample === 'function' ? onSample : null;
  samplerState.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60_000;
  samplerState.maxSamples = Number.isFinite(maxSamples) && maxSamples > 0 ? Math.floor(maxSamples) : 60;
  samplerState.now = typeof now === 'function' ? now : () => Date.now();
}

export function startSampler() {
  if (samplerState.running) return;
  samplerState.running = true;
  samplerState.startedAtMs = samplerState.now();
  tickSampler(); // collect one sample immediately so state is never empty
  samplerState.timer = setInterval(tickSampler, samplerState.intervalMs);
  if (typeof samplerState.timer.unref === 'function') {
    samplerState.timer.unref();
  }
}

export function stopSampler() {
  if (!samplerState.running) return;
  samplerState.running = false;
  if (samplerState.timer) {
    clearInterval(samplerState.timer);
    samplerState.timer = null;
  }
}

function tickSampler() {
  if (!samplerState.running) return;
  const now = samplerState.now();
  const expectedAtMs = samplerState.expectedSampleAtMs;
  const samplingDelayMs = Number.isFinite(expectedAtMs) ? Math.max(0, now - expectedAtMs) : 0;
  samplerState.expectedSampleAtMs = now + samplerState.intervalMs;
  let sample;
  try {
    sample = samplerState.collect ? samplerState.collect() : { caches: collectCacheMetrics({ now }) };
  } catch (error) {
    samplerState.tickErrors += 1;
    sample = { error: String(error?.message || error) };
  }
  // The scheduler lag is part of the evidence when the event loop recovers
  // after a long stall. It is metadata only and never changes the collector's
  // original payload shape.
  if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
    sample = { ...sample, sampler: { sampledAtMs: now, samplingDelayMs } };
  }
  try {
    // Persistence/telemetry is strictly best effort. It must not delay the
    // sampler ring or make a diagnostics write failure affect health.
    const result = samplerState.onSample?.(sample);
    if (result && typeof result.then === 'function') result.catch(() => {});
  } catch {}
  samplerState.samples.push(sample);
  if (samplerState.samples.length > samplerState.maxSamples) {
    samplerState.samples.splice(0, samplerState.samples.length - samplerState.maxSamples);
  }
  samplerState.samplesCollected += 1;
  samplerState.lastSampleAtMs = now;
}

/** JSON-safe sampler state for diagnostics/healthz (samples included). */
export function getSamplerState() {
  return {
    running: samplerState.running,
    intervalMs: samplerState.intervalMs,
    maxSamples: samplerState.maxSamples,
    samplesCollected: samplerState.samplesCollected,
    lastSampleAtMs: samplerState.lastSampleAtMs,
    startedAtMs: samplerState.startedAtMs,
    tickErrors: samplerState.tickErrors,
    expectedSampleAtMs: samplerState.expectedSampleAtMs,
    samples: [...samplerState.samples],
  };
}
