#!/usr/bin/env node
/**
 * DS-06: unified memory/performance registry + sampler + /healthz exposure.
 *
 * Proves:
 *   1. BoundedLruMap observability counters (hits/misses/evictions/bytes/age).
 *   2. Registry snapshots are JSON-serializable and never leak cached values
 *      (secrets probe: a value containing a sentinel secret must not appear).
 *   3. The periodic sampler keeps a bounded ring, survives snapshot errors and
 *      stops cleanly.
 *   4. Sampling does not block the event loop (burst latency + independent
 *      timer liveness + perf_hooks event-loop delay during the burst).
 *   5. Source wiring: /healthz exposes cache gauges, queue, observed runs,
 *      event loop, heap/rss/external/arrayBuffers; owner-only diagnostics
 *      route in router-public-routes.mjs.
 *   6. Live server boot on a temp HOME + random port: /healthz returns the
 *      aggregates (and never echoes the seeded auth token); the diagnostics
 *      route is 403 without owner auth and 200 with it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { BoundedLruMap } from '../chat/cache-utils.mjs';
import {
  registerCache,
  registerLruOrMap,
  unregisterCache,
  unregisterAllCaches,
  collectCacheMetrics,
  getRegisteredCacheNames,
  mapMetrics,
  configureSampler,
  startSampler,
  stopSampler,
  getSamplerState,
} from '../chat/memory-registry.mjs';
import { createBackgroundAiQueue } from '../chat/background-ai-queue.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 20000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

// --- 1. BoundedLruMap observability ----------------------------------------

{
  const lru = new BoundedLruMap({ maxEntries: 3, bytesOf: (value) => value.length });
  lru.set('a', 'xxx');
  lru.set('b', 'yyy');
  lru.get('a'); // hit
  lru.get('z'); // miss
  lru.set('c', 'zzz');
  lru.set('d', 'ww'); // evicts 'b'
  const snap = lru.snapshotMetrics(Date.now() + 1000);
  assert.equal(snap.entries, 3, 'entry count');
  assert.equal(snap.bytes, 8, 'byte accounting (xxx+zzz+ww)');
  assert.equal(snap.hits, 1, 'get hit counted');
  assert.equal(snap.misses, 1, 'get miss counted');
  assert.equal(snap.evictions, 1, 'overflow eviction counted');
  assert.equal(snap.hitRate, 0.5, 'hit rate = hits/(hits+misses)');
  assert.equal(typeof snap.oldestEntryAgeMs, 'number', 'age derived from insertion timestamps');
  assert.equal(snap.maxEntries, 3, 'cap exposed');
  assert.equal(snap.maxBytes, null, 'no byte cap -> null');
  lru.delete('a');
  assert.equal(lru.snapshotMetrics().entries, 2, 'delete reflected');
  lru.clear();
  assert.equal(lru.snapshotMetrics().oldestEntryAgeMs, null, 'empty cache has no age');
  console.log('test-memory-registry: BoundedLruMap metrics ok');
}

// --- 2. Registry: JSON-serializable + secret non-exposure --------------------

{
  unregisterAllCaches();
  const lru = new BoundedLruMap({ maxEntries: 10 });
  const secret = 'SENTINEL_SECRET_9f3a2b_do_not_leak';
  lru.set('k1', { content: secret, body: 'session body text' });
  lru.set('k2', 'value-2');
  lru.get('k1'); // hit
  lru.get('missing'); // miss
  registerLruOrMap('probe.lru', lru);
  registerCache('probe.plain', {
    kind: 'map',
    snapshot: () => mapMetrics(new Map([['a', 'v']])),
  });
  registerCache('probe.extra', {
    kind: 'queue',
    snapshot: () => ({ entries: 1, bytes: 2, queued: 1, active: 0, runningKeys: 2 }),
  });
  registerCache('probe.throwing', {
    kind: 'broken',
    snapshot: () => { throw new Error('boom'); },
  });

  const metrics = collectCacheMetrics();
  const names = new Set(metrics.map((entry) => entry.name));
  assert.ok(names.has('probe.lru') && names.has('probe.plain'), 'all registered caches collected');

  const serialized = JSON.stringify(metrics);
  assert.doesNotThrow(() => JSON.parse(serialized), 'snapshot round-trips through JSON');
  assert.ok(!serialized.includes(secret), 'cached values never leak into the snapshot');
  assert.ok(!serialized.includes('session body text'), 'session bodies never leak');

  const lruEntry = metrics.find((entry) => entry.name === 'probe.lru');
  assert.equal(lruEntry.hitRate, 0.5, 'hit rate normalized');

  const extraEntry = metrics.find((entry) => entry.name === 'probe.extra');
  assert.equal(extraEntry.queued, 1, 'extra scalar fields pass through');
  assert.equal(extraEntry.runningKeys, 2, 'extra scalar fields pass through (counts only)');

  const brokenEntry = metrics.find((entry) => entry.name === 'probe.throwing');
  assert.match(brokenEntry.error, /boom/, 'snapshot failure recorded as JSON-safe error, not thrown');

  // Registering an unknown name shape is rejected.
  assert.throws(() => registerCache('', { snapshot: () => ({}) }), TypeError, 'empty name rejected');
  assert.throws(() => registerCache('x', {}), TypeError, 'snapshot function required');

  // Re-registration replaces the snapshot (idempotent).
  let value = 1;
  registerCache('probe.replaced', { snapshot: () => ({ entries: value }) });
  value = 2;
  assert.equal(collectCacheMetrics().find((e) => e.name === 'probe.replaced').entries, 2, 're-registration takes effect');
  unregisterCache('probe.replaced');
  assert.ok(!getRegisteredCacheNames().includes('probe.replaced'), 'unregister removes entry');
  console.log('test-memory-registry: registry JSON-safe + secret-free ok');
}

// --- 3. Sampler: bounded ring, error survival, clean stop --------------------

{
  let persistedDelayMs = null;
  configureSampler({
    intervalMs: 2,
    maxSamples: 4,
    now: () => 1000 + (Date.now() % 1_000_000),
    onSample: (sample) => { persistedDelayMs = sample?.sampler?.samplingDelayMs; },
  });
  stopSampler(); // ensure not running from a previous failed run
  startSampler();
  await sleep(60);
  const state = getSamplerState();
  assert.equal(state.running, true, 'sampler running');
  assert.ok(state.samplesCollected >= 5, `collected samples (${state.samplesCollected})`);
  assert.ok(state.samples.length <= 4, `ring bounded by maxSamples (${state.samples.length})`);
  assert.doesNotThrow(() => JSON.stringify(state), 'sampler state is JSON-safe');
  assert.equal(typeof state.lastSampleAtMs, 'number', 'last sample timestamp tracked');
  assert.equal(typeof state.expectedSampleAtMs, 'number', 'next expected sample time tracked for stall evidence');
  assert.ok(state.samples.every((sample) => Number.isFinite(sample?.sampler?.samplingDelayMs)), 'every sample carries scheduler delay evidence');
  assert.ok(Number.isFinite(persistedDelayMs), 'sample observer receives the scheduler-delay evidence');
  stopSampler();
  assert.equal(getSamplerState().running, false, 'sampler stops cleanly');
  console.log('test-memory-registry: sampler ring + stop ok');
}

// --- 4. Sampling does not block the event loop --------------------------------

{
  unregisterAllCaches();
  // Realistic-size LRU (history.events scale: ~30k entries).
  const big = new BoundedLruMap({ maxEntries: 30_000, maxBytes: 128 * 1024 * 1024, bytesOf: (value) => value.length });
  for (let i = 0; i < 30_000; i += 1) big.set(`k${i}`, 'x'.repeat(64));
  registerLruOrMap('burst.big', big);

  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const t0 = performance.now();
  for (let i = 0; i < 300; i += 1) collectCacheMetrics();
  const burstMs = performance.now() - t0;
  delay.disable();
  assert.ok(burstMs < 1000, `300 snapshot collections completed in ${burstMs.toFixed(1)}ms`);
  assert.ok(delay.max / 1e6 < 50, `event loop max delay during burst ${(delay.max / 1e6).toFixed(2)}ms < 50ms`);

  // Independent 1ms timer must keep firing while the sampler ticks every 2ms.
  configureSampler({ intervalMs: 2, maxSamples: 200, collect: () => collectCacheMetrics() });
  startSampler();
  let timerTicks = 0;
  const timer = setInterval(() => { timerTicks += 1; }, 1);
  await sleep(120);
  clearInterval(timer);
  stopSampler();
  assert.ok(timerTicks >= 10, `independent 1ms timer stayed alive (${timerTicks} ticks)`);
  unregisterAllCaches();
  console.log('test-memory-registry: sampling non-blocking ok');
}

// --- 5. Source wiring: healthz + owner-only diagnostics -----------------------

{
  const chatServer = readFileSync(join(repoRoot, 'chat-server.mjs'), 'utf8');
  const publicRoutes = readFileSync(join(repoRoot, 'chat', 'router-public-routes.mjs'), 'utf8');
  for (const needle of [
    "externalBytes: memory.externalBytes",
    "arrayBuffersBytes: memory.arrayBuffersBytes",
    "caches: snapshot.caches",
    "backgroundQueue: findCacheMetrics",
    "observedRuns: findCacheMetrics",
    "sampler: {",
    "requestMetrics: apiRequestLog.getApiRequestMetrics()",
    "memoryRegistry.startSampler()",
    "collectCacheMetrics()",
    "RAGENT_MEMORY_SAMPLER_INTERVAL_MS', 5_000",
    'onSample: persistForensicSnapshot',
  ]) {
    assert.ok(chatServer.includes(needle), `chat-server.mjs wires ${needle}`);
  }
  assert.ok(chatServer.includes("req.method === 'GET' && req.url === '/healthz'"), 'healthz route retained');
  assert.ok(publicRoutes.includes("pathname === '/api/diagnostics/memory'"), 'owner-only diagnostics route present');
  assert.ok(publicRoutes.includes("authSession?.role !== 'owner'"), 'diagnostics gated to owner');
  assert.ok(publicRoutes.includes('sampler: samplerState'), 'diagnostics includes sampler history');
  assert.ok(publicRoutes.includes('requestMetrics: getApiRequestMetrics()'), 'diagnostics includes request timing');
  console.log('test-memory-registry: source wiring ok');
}

// --- 6. Live server boot: /healthz aggregates + diagnostics auth --------------

{
  const home = mkdtempSync(join(tmpdir(), 'ragent-memory-registry-'));
  const configDir = join(home, '.config', 'ragent');
  mkdirSync(configDir, { recursive: true });
  const seededToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ token: seededToken }, null, 2), 'utf8');
  // Auth sessions are keyed by HMAC(token, secret) on disk; seed the owner
  // session for the cookie below so the diagnostics route can be exercised.
  const authSecret = 'test-secret-for-diagnostics';
  const { createHmac } = await import('node:crypto');
  const sessionKey = `s${createHmac('sha256', authSecret).update('test-session').digest('hex')}`;
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({ [sessionKey]: { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' } }, null, 2),
    'utf8',
  );
  const port = 45000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
      RAGENT_RUNNER_LIFECYCLE_SOCKET: '',
      RAGENT_RUNNER_LIFECYCLE_REQUIRED: '',
      RAGENT_AUTH_SESSION_SECRET: authSecret,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  function request(path, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text: data }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  try {
    await waitFor(async () => {
      try {
        return (await request('/login')).status === 200;
      } catch {
        return false;
      }
    }, 'server startup');

    const healthz = await request('/healthz');
    assert.equal(healthz.status, 200, '/healthz status');
    const payload = JSON.parse(healthz.text);
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.rssBytes, 'number', 'rss gauge');
    assert.equal(typeof payload.heapUsedBytes, 'number', 'heap used gauge');
    assert.equal(typeof payload.heapTotalBytes, 'number', 'heap total gauge');
    assert.equal(typeof payload.externalBytes, 'number', 'external gauge');
    assert.equal(typeof payload.arrayBuffersBytes, 'number', 'arrayBuffers gauge');
    assert.equal(typeof payload.eventLoopDelayMs.mean, 'number', 'event loop delay gauge');
    assert.ok(Array.isArray(payload.caches), 'caches array present');
    const cacheNames = payload.caches.map((entry) => entry.name);
    for (const expected of ['history.events', 'history.bodies', 'history.reads', 'run.projection', 'runs.status', 'runs.artifact', 'timeline.bundle', 'dedup.knownKeySets', 'observedRuns', 'backgroundQueue', 'router.staticAssets']) {
      assert.ok(cacheNames.includes(expected), `/healthz exposes ${expected}`);
    }
    for (const entry of payload.caches) {
      assert.equal(typeof entry.entries, 'number', `${entry.name} entries`);
      assert.equal(typeof entry.bytes, 'number', `${entry.name} bytes`);
    }
    assert.equal(payload.backgroundQueue.name, 'backgroundQueue', 'queue convenience field');
    assert.equal(payload.observedRuns.name, 'observedRuns', 'observed runs convenience field');
    assert.equal(typeof payload.requestMetrics.requests, 'number', 'request timing aggregate');
    assert.equal(payload.sampler.running, true, 'sampler running in live server');
    assert.ok(payload.sampler.samplesCollected >= 1, 'sampler collected on startup');
    assert.ok(!healthz.text.includes(seededToken), 'healthz never echoes the auth token');
    assert.ok(!healthz.text.includes('test-session'), 'healthz never echoes session identifiers');

    const denied = await request('/api/diagnostics/memory');
    assert.equal(denied.status, 403, 'diagnostics without owner auth is forbidden');

    const granted = await request('/api/diagnostics/memory', { Cookie: 'session_token=test-session' });
    assert.equal(granted.status, 200, 'diagnostics with owner auth is allowed');
    const diagnostics = JSON.parse(granted.text);
    assert.ok(Array.isArray(diagnostics.caches), 'diagnostics includes cache gauges');
    assert.equal(typeof diagnostics.requestMetrics.maxDurationMs, 'number', 'diagnostics includes request timing');
    assert.ok(Array.isArray(diagnostics.sampler.samples), 'diagnostics includes sampler history');
    assert.ok(diagnostics.sampler.samples.length >= 1, 'sampler history non-empty');
    assert.equal(typeof diagnostics.process.memory.externalBytes, 'number', 'diagnostics process memory');
    assert.ok(!granted.text.includes(seededToken), 'diagnostics never echoes the auth token');
    console.log('test-memory-registry: live /healthz + diagnostics ok');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    try { await waitFor(() => child.exitCode !== null, 'server shutdown', 10000); } catch { child.kill('SIGKILL'); }
    rmSync(home, { recursive: true, force: true });
  }
}

console.log('test-memory-registry: ok');
