#!/usr/bin/env node
// DS-11 history read-path micro-benchmark.
//
// Fabricates sessions purely on disk (meta.json + one event file per seq +
// externalized body files, same layout appendEvents writes) so the event/body
// caches stay cold, then times the history read paths and verifies read
// invariants (seq order, page reads bounded to one batch, hot reads hit the
// cache, index vs includeBodies semantics). Run it on the base commit and on
// the DS-11 branch to compare before/after; the stats columns are blank when
// getHistoryReadStats() is not present (base code).
//
// Usage:
//   node scripts/benchmarks/history-read.mjs [--sizes 50,200,2000,20000]
//     [--out-dir artifacts/benchmarks] [--keep]
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';

const repoRoot = new URL('../..', import.meta.url).pathname;

function usage() {
  console.log(`Usage: node scripts/benchmarks/history-read.mjs [options]
  --sizes <n,n,n>  event counts to benchmark (default: 50,200,2000,20000)
  --out-dir <path> JSON report directory (default: artifacts/benchmarks)
  --keep           keep temp homes for debugging
  --help           show this help`);
}

function parseArgs(argv) {
  const options = {
    sizes: [50, 200, 2000, 20000],
    outDir: join(repoRoot, 'artifacts', 'benchmarks'),
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    switch (arg) {
      case '--sizes': options.sizes = next().split(',').map(Number); break;
      case '--out-dir': options.outDir = next(); break;
      case '--keep': options.keep = true; break;
      case '--help':
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

const home = mkdtempSync(join(tmpdir(), 'ragent-history-read-bench-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
delete process.env.RAGENT_INSTANCE_ROOT;

const history = await import('../../chat/history.mjs');
const getStats = history.getHistoryReadStats ? () => history.getHistoryReadStats() : () => null;
const resetStats = history.__resetHistoryReadStatsForTest ? () => history.__resetHistoryReadStatsForTest() : () => null;
const { CHAT_HISTORY_DIR } = await import('../../lib/config.mjs');

const EVENT_FILE_WIDTH = 9;
const PREVIEW_LIMIT = 1200;

function clipMiddle(text, limit) {
  if (text.length <= limit) return text;
  const keep = Math.max(0, limit - 30);
  const half = Math.floor(keep / 2);
  return `${text.slice(0, half)}...[truncated ${text.length - keep} bytes]...${text.slice(-half)}`;
}

// Write a stored event file plus (for externalized bodies) its body file —
// the exact on-disk layout appendEvents produces, without warming any cache.
async function fabricateSessionOnDisk(sessionId, size) {
  const sessionDir = join(CHAT_HISTORY_DIR, sessionId);
  const eventsDir = join(sessionDir, 'events');
  const bodiesDir = join(sessionDir, 'bodies');
  await Promise.all([
    (async () => {
      await import('../../chat/fs-utils.mjs').then(({ ensureDir }) => ensureDir(eventsDir));
    })(),
    (async () => {
      await import('../../chat/fs-utils.mjs').then(({ ensureDir }) => ensureDir(bodiesDir));
    })(),
  ]);
  const baseTs = Date.now();
  const meta = {
    latestSeq: size,
    lastEventAt: new Date(baseTs + size).toISOString(),
    lastAssistantMessageAt: null,
    size,
    counts: { message_user: Math.floor(size / 5), message_assistant: Math.floor(size / 5) },
  };
  const writes = [];
  for (let index = 0; index < size; index += 1) {
    const seq = index + 1;
    const timestamp = baseTs + index;
    let stored;
    const kind = index % 5;
    if (kind === 0) {
      const big = index % 10 === 0;
      const raw = big ? `big user message ${index} ` + 'u'.repeat(70 * 1024) : `user message ${index}`;
      const ref = `evt_${String(seq).padStart(EVENT_FILE_WIDTH, '0')}_content`;
      stored = big
        ? { seq, type: 'message', role: 'user', timestamp, content: clipMiddle(raw, PREVIEW_LIMIT), bodyAvailable: true, bodyLoaded: false, bodyField: 'content', bodyRef: ref, bodyBytes: Buffer.byteLength(raw, 'utf8') }
        : { seq, type: 'message', role: 'user', timestamp, content: raw, bodyAvailable: true, bodyLoaded: true };
      if (big) writes.push(writeFile(join(bodiesDir, `${ref}.txt`), raw, 'utf8'));
    } else if (kind === 1) {
      stored = { seq, type: 'message', role: 'assistant', timestamp, content: `assistant message ${index}`, bodyAvailable: true, bodyLoaded: true };
    } else if (kind === 2) {
      const raw = `thinking ${index} ` + 'r'.repeat(6000);
      const ref = `evt_${String(seq).padStart(EVENT_FILE_WIDTH, '0')}_content`;
      stored = { seq, type: 'reasoning', timestamp, content: clipMiddle(raw, PREVIEW_LIMIT), bodyAvailable: true, bodyLoaded: false, bodyField: 'content', bodyRef: ref, bodyBytes: raw.length };
      writes.push(writeFile(join(bodiesDir, `${ref}.txt`), raw, 'utf8'));
    } else if (kind === 3) {
      stored = { seq, type: 'tool_use', id: `tool-${index}`, toolName: 'shell', toolInput: `echo ${index}`, timestamp, bodyAvailable: true, bodyLoaded: true };
    } else {
      const big = index % 4 === 0;
      const raw = big ? `big result ${index} ` + 'y'.repeat(20 * 1024) : `result ${index}`;
      const ref = `evt_${String(seq).padStart(EVENT_FILE_WIDTH, '0')}_output`;
      stored = big
        ? { seq, type: 'tool_result', output: clipMiddle(raw, PREVIEW_LIMIT), bodyAvailable: true, bodyLoaded: false, bodyField: 'output', bodyRef: ref, bodyBytes: raw.length, exitCode: 0, timestamp }
        : { seq, type: 'tool_result', output: raw, bodyAvailable: true, bodyLoaded: true, exitCode: 0, timestamp };
      if (big) writes.push(writeFile(join(bodiesDir, `${ref}.txt`), raw, 'utf8'));
    }
    writes.push(writeFile(join(eventsDir, `${String(seq).padStart(EVENT_FILE_WIDTH, '0')}.json`), JSON.stringify(stored), 'utf8'));
  }
  await Promise.all(writes);
  await writeFile(join(sessionDir, 'meta.json'), JSON.stringify(meta), 'utf8');
}

async function timeIt(fn) {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
}

async function measureSize(size) {
  const sessionId = `bench-${process.pid}-${size}`;
  await fabricateSessionOnDisk(sessionId, size);

  const problems = [];

  resetStats?.();
  const coldPage = await timeIt(() => history.readEventsPage(sessionId, { limit: 200 }));
  const coldStats = getStats?.() || {};

  resetStats?.();
  const hotPage = await timeIt(() => history.readEventsPage(sessionId, { limit: 200 }));
  const hotStats = getStats?.() || {};

  const backPage = await timeIt(() => history.readEventsPage(sessionId, { beforeSeq: size, limit: 200 }));
  const fullRead = await timeIt(() => history.readEventsAfter(sessionId, 0));

  // Force the countMessageEventsAfter scan (activeFromSeq > 0).
  await history.setContextHead(sessionId, { mode: 'history', activeFromSeq: 1 });
  const snapshot = await timeIt(() => history.getHistorySnapshot(sessionId));

  const loadIndex = await timeIt(() => history.loadHistory(sessionId, { includeBodies: false }));
  resetStats?.();
  const loadFull = await timeIt(() => history.loadHistory(sessionId));
  const loadFullStats = getStats?.() || {};

  // --- invariants ---
  const page = coldPage.result;
  const expectedPage = Math.min(200, size);
  if (page.events.length !== expectedPage) {
    problems.push(`page length ${page.events.length} != ${expectedPage}`);
  }
  let previous = 0;
  for (const event of page.events) {
    if (event.seq <= previous) problems.push(`page seq order broken at ${event.seq}`);
    previous = event.seq;
  }
  if (Number.isInteger(coldStats.eventFileReads) && coldStats.eventFileReads > 256) {
    problems.push(`cold page read ${coldStats.eventFileReads} files (exceeds one batch)`);
  }
  if (Number.isInteger(hotStats.eventFileReads) && hotStats.eventFileReads !== 0) {
    problems.push(`hot page read ${hotStats.eventFileReads} files (cache miss)`);
  }
  if (fullRead.result.length !== size) {
    problems.push(`full read length ${fullRead.result.length} != ${size}`);
  }
  // Index read: raw stored events carry the clipped preview + bodyRef, body
  // not loaded; the full 70KB body must never be in memory on this path.
  const firstIndexEvent = loadIndex.result[0];
  if (size > 0 && (firstIndexEvent.bodyLoaded !== false || !firstIndexEvent.bodyRef || firstIndexEvent.content.length >= 70 * 1024)) {
    problems.push('loadHistory(includeBodies:false) should keep index-only events (preview + bodyRef, body not loaded)');
  }
  // includeBodies: the externalized body must be hydrated back in full.
  const firstFullEvent = loadFull.result[0];
  if (size > 0 && !firstFullEvent.content.startsWith('big user message 0')) {
    problems.push('loadHistory() default should hydrate externalized bodies');
  }

  return {
    size,
    coldPageMs: Math.round(coldPage.ms * 10) / 10,
    coldPageEventsPerMs: coldPage.ms > 0 ? Math.round(page.events.length / coldPage.ms * 10) / 10 : null,
    hotPageMs: Math.round(hotPage.ms * 10) / 10,
    backPageMs: Math.round(backPage.ms * 10) / 10,
    fullReadMs: Math.round(fullRead.ms * 10) / 10,
    fullReadEventsPerMs: fullRead.ms > 0 ? Math.round(size / fullRead.ms * 10) / 10 : null,
    snapshotMs: Math.round(snapshot.ms * 10) / 10,
    loadIndexMs: Math.round(loadIndex.ms * 10) / 10,
    loadFullMs: Math.round(loadFull.ms * 10) / 10,
    coldEventFileReads: coldStats.eventFileReads ?? null,
    coldEventCacheHits: coldStats.eventCacheHits ?? null,
    hotEventFileReads: hotStats.eventFileReads ?? null,
    hotEventCacheHits: hotStats.eventCacheHits ?? null,
    loadFullEventFileReads: loadFullStats.eventFileReads ?? null,
    loadFullBodyFileReads: loadFullStats.bodyFileReads ?? null,
    problems,
  };
}

let failed = false;
const results = [];
for (const size of options.sizes) {
  process.stdout.write(`benchmarking size ${size} ... `);
  const result = await measureSize(size);
  results.push(result);
  console.log(result.problems.length === 0 ? 'ok' : `PROBLEMS: ${result.problems.join('; ')}`);
  if (result.problems.length > 0) failed = true;
}

console.log();
console.log('| size | cold page ms (ev/ms) | hot page ms | backward ms | full read ms (ev/ms) | snapshot ms | loadIndex ms | loadFull ms | cold reads | hot reads | body reads |');
console.log('|------|----------------------|-------------|-------------|----------------------|-------------|--------------|-------------|------------|-----------|------------|');
for (const result of results) {
  console.log(
    `| ${result.size} | ${result.coldPageMs} (${result.coldPageEventsPerMs ?? '-'}) | ${result.hotPageMs} | ${result.backPageMs} | ${result.fullReadMs} (${result.fullReadEventsPerMs ?? '-'}) | ${result.snapshotMs} | ${result.loadIndexMs} | ${result.loadFullMs} | ${result.coldEventFileReads ?? '-'} | ${result.hotEventFileReads ?? '-'} | ${result.loadFullBodyFileReads ?? '-'} |`,
  );
}

mkdirSync(options.outDir, { recursive: true });
const reportPath = join(options.outDir, 'history-read.json');
writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), results, failed }, null, 2));
console.log(`\nreport: ${reportPath}`);

if (!options.keep) rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
