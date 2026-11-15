#!/usr/bin/env node
/**
 * DS-08: run cache artifact byte caps, TTL and metadata LRU sharing.
 *
 * Proves, without touching the shipped limits at full scale:
 *   1. BoundedLruMap TTL + onEvict unit semantics (stale get = miss/evict,
 *      overflow eviction hook, explicit delete does NOT fire the hook,
 *      interval-gated expiry sweep, ttlMs in the snapshot).
 *   2. runArtifactCache is bounded by entries AND bytes (env-shrunk caps):
 *      resident bytes stay under maxBytes while a 4x overflow is inserted;
 *      the registry gauge exposes bytes/entries/maxBytes/ttlMs.
 *   3. Cache hits: hydration is served from the cache (survives the artifact
 *      file being deleted from disk).
 *   4. TTL + external update: within the TTL an externally rewritten artifact
 *      file is served stale; after expiry (simulated by back-dating the
 *      insertion timestamp) the next read re-reads the file.
 *   5. Oversized artifact: a 5MB artifact hydrates as the truncated cache
 *      value (~2MB) instead of being read whole; the file on disk is
 *      untouched; heap/RSS samples around the read are printed.
 *   6. Bulk heap/RSS probe (child process with --expose-gc): loading 40MB of
 *      artifact text with a 1MB byte cap leaves post-GC heapUsed delta far
 *      below the load (unbounded retention would exceed it) — a memory
 *      comparison, not just a Map.size assert.
 *   7. Meta LRU coupling: after >1000 distinct runs (status + result caches
 *      evict at the 1000-entry cap), runStatusCacheMeta/runResultCacheMeta
 *      stay at or under the cap and contain NO key missing from the main
 *      cache (no orphan metadata). mtime-gated re-parse on external status
 *      file updates still works.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BoundedLruMap } from '../chat/cache-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

// ---- 1. BoundedLruMap TTL + onEvict unit semantics -------------------------

{
  const evicted = [];
  const lru = new BoundedLruMap({ maxEntries: 10, ttlMs: 60000, onEvict: (key) => evicted.push(key) });
  lru.set('a', 'va');
  lru.set('b', 'vb');
  lru.entryCreatedMs.set('a', Date.now() - 120000); // back-date past TTL
  assert.equal(lru.get('a'), undefined, 'stale get returns undefined');
  assert.equal(lru.get('b'), 'vb', 'fresh get still hits');
  assert.equal(lru.evictions, 1, 'stale get counted as an eviction');
  assert.equal(lru.misses, 1, 'stale get counted as a miss');
  assert.deepEqual(evicted, ['a'], 'onEvict fires for TTL expiry');
  assert.equal(lru.size, 1, 'stale entry removed');

  evicted.length = 0;
  const small = new BoundedLruMap({ maxEntries: 2, onEvict: (key) => evicted.push(key) });
  small.set('x', 1);
  small.set('y', 2);
  small.set('z', 3); // overflow evicts 'x'
  assert.deepEqual(evicted, ['x'], 'overflow eviction fires onEvict');
  assert.equal(small.evictions, 1, 'overflow eviction counted');

  evicted.length = 0;
  small.delete('y');
  assert.deepEqual(evicted, [], 'explicit delete does NOT fire onEvict');

  const swept = new BoundedLruMap({ maxEntries: 2, ttlMs: 60000, onEvict: (key) => evicted.push(key) });
  swept.set('p', 1);
  swept.entryCreatedMs.set('p', Date.now() - 120000);
  swept._nextExpiryCheckMs = 1; // force the interval-gated sweep on next set
  swept.set('q', 2);
  assert.equal(swept.size, 1, 'expired entries swept before cap enforcement');
  assert.ok(evicted.includes('p'), 'sweep fires onEvict');

  assert.equal(lru.snapshotMetrics().ttlMs, 60000, 'ttlMs exposed in snapshot');
  assert.equal(small.snapshotMetrics().ttlMs, null, 'no TTL -> ttlMs null');
  console.log('test-runs-cache-bounds: BoundedLruMap TTL + onEvict ok');
}

// ---- integration: runs.mjs caches -----------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'ragent-runs-cache-bounds-'));
// Small byte cap (1MB) + long TTL (1min): byte/entry caps bind during the
// test, TTL expiry is simulated by back-dating entryCreatedMs (no sleeps).
process.env.RAGENT_CONFIG_DIR = tmp;
process.env.RAGENT_RUN_ARTIFACT_CACHE_BYTES = String(1024 * 1024);
process.env.RAGENT_RUN_ARTIFACT_CACHE_TTL_MS = String(60 * 1000);
const {
  createRun,
  getRun,
  writeRunResult,
  appendRunSpoolRecord,
  readRunSpoolRecords,
  materializeRunSpoolLine,
  runStatusPath,
  runArtifactsDir,
  runReadCachesForTests,
} = await import('../chat/runs.mjs');
const { collectCacheMetrics } = await import('../chat/memory-registry.mjs');

function artifactMetric() {
  return collectCacheMetrics().find((entry) => entry.name === 'runs.artifact');
}

try {
  // ---- 2. artifact cache bounded by entries AND bytes ----------------------
  {
    const RUN = 'run_byte_cap';
    const LINE = 'x'.repeat(40 * 1024); // >16KB inline cap -> externalized artifact
    for (let i = 0; i < 100; i += 1) {
      await appendRunSpoolRecord(RUN, { line: LINE, seq: i });
    }
    const metric = artifactMetric();
    assert.ok(metric.evictions > 0, 'overflow evicted artifacts');
    assert.ok(metric.bytes <= metric.maxBytes, `resident bytes ${metric.bytes} <= byte cap ${metric.maxBytes}`);
    assert.ok(metric.entries >= 20, `byte cap keeps a bounded window (${metric.entries} entries)`);
    assert.ok(metric.entries <= metric.maxEntries, 'entry cap never exceeded');
    assert.equal(metric.maxEntries, 256, 'entry cap configured');
    assert.equal(metric.maxBytes, 1024 * 1024, 'byte cap configured');
    assert.equal(metric.ttlMs, 60 * 1000, 'ttl exposed in registry gauge');

    // ---- 3. cache hits survive the artifact file vanishing -----------------
    const keys = [...runReadCachesForTests.artifactCache.keys()];
    assert.ok(keys.length > 0, 'artifact cache has resident entries');
    const newestKey = keys[keys.length - 1]; // inserted last -> fresh (< TTL)
    const colon = newestKey.indexOf(':');
    const ref = newestKey.slice(colon + 1);
    const expected = runReadCachesForTests.artifactCache.get(newestKey);
    const hydrated = await materializeRunSpoolLine(newestKey.slice(0, colon), { lineArtifact: ref });
    assert.equal(hydrated, expected, 'hydration served from cache');
    rmSync(join(runArtifactsDir(newestKey.slice(0, colon)), `${ref}.txt`));
    const again = await materializeRunSpoolLine(newestKey.slice(0, colon), { lineArtifact: ref });
    assert.equal(again, expected, 'cache hit survives the file being deleted');
    assert.ok(artifactMetric().hits >= 2, 'hits counted on the artifact gauge');
    console.log('test-runs-cache-bounds: entry+byte caps and cache hits ok');
  }

  // ---- 4. TTL + external artifact file update ------------------------------
  {
    const RUN = 'run_ttl';
    await appendRunSpoolRecord(RUN, { line: `B-content-${'y'.repeat(20 * 1024)}` });
    const records = await readRunSpoolRecords(RUN);
    const record = records[records.length - 1];
    assert.ok(record.lineArtifact, 'large line externalized to an artifact');
    const first = await materializeRunSpoolLine(RUN, record);
    assert.ok(first.startsWith('B-content-'), 'initial read returns written text');

    const artifactPath = join(runArtifactsDir(RUN), `${record.lineArtifact}.txt`);
    writeFileSync(artifactPath, `UPDATED-${'z'.repeat(20 * 1024)}`); // external writer
    const second = await materializeRunSpoolLine(RUN, record);
    assert.ok(second.startsWith('B-content-'), 'within TTL the cached text is served (update not yet visible)');

    runReadCachesForTests.artifactCache.entryCreatedMs
      .set(`${RUN}:${record.lineArtifact}`, Date.now() - 120000); // expire the entry
    const third = await materializeRunSpoolLine(RUN, record);
    assert.ok(third.startsWith('UPDATED-'), 'after TTL expiry the external update is visible');
    console.log('test-runs-cache-bounds: TTL expiry + external update ok');
  }

  // ---- 5. oversized artifact: bounded read, truncated cache value ----------
  {
    const RUN = 'run_oversized';
    const BIG = 'Q'.repeat(5 * 1024 * 1024); // 5MB > 2MB per-entry char cap
    const bigRef = 'big_oversized';
    const bigPath = join(runArtifactsDir(RUN), `${bigRef}.txt`);
    mkdirSync(dirname(bigPath), { recursive: true });
    writeFileSync(bigPath, BIG);
    const before = process.memoryUsage();
    const hydrated = await materializeRunSpoolLine(RUN, { lineArtifact: bigRef });
    const after = process.memoryUsage();
    assert.ok(hydrated.length < BIG.length, 'oversized artifact hydrates truncated, not read whole');
    assert.ok(hydrated.length < 3 * 1024 * 1024, 'hydration bounded well below the file size');
    assert.ok(hydrated.startsWith('QQQ'), 'truncated value keeps the head');
    assert.ok(hydrated.includes('artifact truncated'), 'truncation marker present');
    assert.equal(statSync(bigPath).size, BIG.length, 'file on disk untouched');
    console.log(`test-runs-cache-bounds: oversized bounded read ok `
      + `(heapUsed delta ${after.heapUsed - before.heapUsed} B, rss delta ${after.rss - before.rss} B, `
      + `hydrated ${hydrated.length} B)`);
  }

  // ---- 6. bulk heap/RSS probe in a --expose-gc child ------------------------
  {
    const probe = `
      import { mkdtempSync, rmSync } from 'fs';
      import { tmpdir } from 'os';
      import { join } from 'path';
      const probeTmp = mkdtempSync(join(tmpdir(), 'ragent-heap-probe-'));
      process.env.RAGENT_CONFIG_DIR = probeTmp;
      const base = new URL('file://' + process.cwd() + '/');
      const runs = await import(new URL('chat/runs.mjs', base).href);
      const registry = await import(new URL('chat/memory-registry.mjs', base).href);
      const RUN = 'run_heap_probe';
      const line = 'm'.repeat(200 * 1024);
      const before = process.memoryUsage();
      for (let i = 0; i < 200; i += 1) {
        await runs.appendRunSpoolRecord(RUN, { line, seq: i });
      }
      if (global.gc) global.gc();
      const after = process.memoryUsage();
      const metric = registry.collectCacheMetrics().find((e) => e.name === 'runs.artifact');
      const heapDelta = after.heapUsed - before.heapUsed;
      const ok = heapDelta < 24 * 1024 * 1024
        && metric.bytes <= metric.maxBytes
        && metric.entries <= metric.maxEntries;
      console.log(JSON.stringify({
        ok,
        heapDelta,
        rssDelta: after.rss - before.rss,
        entries: metric.entries,
        bytes: metric.bytes,
        maxBytes: metric.maxBytes,
      }));
      rmSync(probeTmp, { recursive: true, force: true });
      process.exit(ok ? 0 : 1);
    `;
    const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', probe], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(child.status, 0, `heap probe child failed: ${child.stderr?.slice(0, 800) || child.stdout?.slice(0, 800)}`);
    const sample = JSON.parse(child.stdout.trim().split('\n').pop());
    assert.ok(sample.ok, `heap probe assertion failed: ${JSON.stringify(sample)}`);
    console.log(`test-runs-cache-bounds: bulk heap probe ok — 40MB loaded, 1MB cap → `
      + `heapUsed delta ${sample.heapDelta} B, rss delta ${sample.rssDelta} B, resident ${sample.entries} entries/${sample.bytes} B`);
  }

  // ---- 7. meta maps share the eviction lifecycle (no orphans) ---------------
  {
    const N = 1050; // > 1000-entry cap of both read caches
    for (let i = 0; i < N; i += 1) {
      const run = await createRun({ status: { sessionId: 's-meta', state: 'completed' } });
      await writeRunResult(run.id, { ok: true, step: i });
    }
    const caches = runReadCachesForTests;
    assert.ok(caches.statusCache.size <= 1000, 'status cache entry cap holds');
    assert.ok(caches.statusCacheMeta.size <= 1000, 'status meta map capped');
    assert.ok(caches.resultCache.size <= 1000, 'result cache entry cap holds');
    assert.ok(caches.resultCacheMeta.size <= 1000, 'result meta map capped');
    for (const key of caches.statusCacheMeta.keys()) {
      assert.ok(caches.statusCache.has(key), `no orphan status meta for ${key}`);
    }
    for (const key of caches.resultCacheMeta.keys()) {
      assert.ok(caches.resultCache.has(key), `no orphan result meta for ${key}`);
    }
    const statusMetric = collectCacheMetrics().find((entry) => entry.name === 'runs.status');
    assert.ok(statusMetric.evictions > 0, 'status cache actually evicted');
    console.log('test-runs-cache-bounds: meta LRU coupling (no orphans) ok');
  }

  // ---- 8. external status.json update still forces mtime-gated re-parse -----
  {
    const run = await createRun({ status: { state: 'accepted' } });
    assert.equal((await getRun(run.id)).state, 'accepted', 'initial read');
    // External writer: pretty JSON differs in size from the compact cache-era
    // file, so the mtime/size gate can never serve it stale.
    writeFileSync(runStatusPath(run.id), JSON.stringify({ ...(await getRun(run.id)), state: 'failed' }, null, 2));
    assert.equal((await getRun(run.id)).state, 'failed', 'external status update visible (mtime gate)');
    assert.equal((await getRun(run.id)).state, 'failed', 're-parsed value now cached');
    console.log('test-runs-cache-bounds: external status update mtime gate ok');
  }

  console.log('test-runs-cache-bounds: ok');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
