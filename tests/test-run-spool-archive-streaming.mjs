#!/usr/bin/env node
// Verify the streaming cold-archive path (DS-13):
//   1. 64 MB spool: archived without readFile-style buffering (RSS stays flat),
//      meta sidecar retains original sha256/size, verifyArchivedSpool passes.
//   2. 500 MB spool: same guarantees at scale; read path returns the tail.
//   3. Corrupted archive: verifyArchivedSpool reports invalid; readers return
//      [] instead of throwing.
//   4. Failure injection: an unreadable plain spool (directory) fails the file,
//      leaves no temp/archive behind, and keeps the plain path intact.
//   5. Concurrent append: appending mid-compression never loses the lines that
//      existed when compression started (plain kept, or gz complete).
//   6. Active runs are never archived; terminal runs are (with minAgeMs 0).
//   7. zstd codec: archives to spool.jsonl.zst, readers detect the codec, verify
//      passes.
//   8. Per-tick budgets: perTickLimit and perTickBytes stop the tick early and
//      report remainingCandidates; the scheduler tick honors them.
//   9. scripts/archive-run-spools.mjs --verify reports clean archives as valid
//      and exits 1 on a corrupted one.
import assert from 'assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import {
  closeSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGunzip } from 'zlib';

const home = mkdtempSync(join(tmpdir(), 'ragent-spool-stream-'));
const previousEnv = {
  HOME: process.env.HOME,
  RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR,
  RAGENT_WORK_ROOT_DIR: process.env.RAGENT_WORK_ROOT_DIR,
};

process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_WORK_ROOT_DIR = join(home, '.ragent', 'workspace');

const iso = (ms) => new Date(ms).toISOString();
const OLD = iso(Date.now() - 48 * 3600 * 1000);
const LINE_BYTES = 200;

// A single spool line (must match writeSpoolFile exactly) + trailing newline.
function spoolLineLength() {
  return JSON.stringify({ ts: '2026-08-05T00:00:00.000Z', stream: 'stdout', line: 'l'.repeat(LINE_BYTES) + '-0' }).length + 1;
}

function lineCountFor(targetBytes) {
  return Math.max(1, Math.floor(targetBytes / spoolLineLength()));
}

function writeSpoolFile(spoolPath, lineCount) {
  const fd = openSync(spoolPath, 'w');
  const base = 'l'.repeat(LINE_BYTES);
  const batch = [];
  try {
    for (let i = 0; i < lineCount; i++) {
      batch.push(`{"ts":"2026-08-05T00:00:00.000Z","stream":"stdout","line":"${base}-${i}"}`);
      if (batch.length >= 20000) {
        writeSync(fd, batch.join('\n') + '\n');
        batch.length = 0;
      }
    }
    if (batch.length) writeSync(fd, batch.join('\n') + '\n');
  } finally {
    closeSync(fd);
  }
}

// Count newline bytes in a gzip archive by streaming it through gunzip.
function countArchiveLines(path) {
  const gunzip = createGunzip();
  const read = createReadStream(path);
  const counts = { lines: 0 };
  return new Promise((resolve, reject) => {
    read.pipe(gunzip);
    gunzip.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) counts.lines += 1;
    });
    gunzip.on('end', () => resolve(counts));
    gunzip.on('error', reject);
    read.on('error', reject);
  });
}

try {
  const { appendRunSpoolRecord, readRunSpoolDelta, readRunSpoolRecords } = await import('../chat/runs.mjs');
  const {
    archiveTerminalSpools,
    processRunArchiveDueNow,
    verifyArchivedSpool,
    __resetRunArchiveSchedulerForTest,
  } = await import('../chat/run-spool-archive.mjs');

  const runsRoot = join(process.env.RAGENT_CONFIG_DIR, 'chat-runs');

  const wipeRunsRoot = () => {
    rmSync(runsRoot, { recursive: true, force: true });
    mkdirSync(runsRoot, { recursive: true });
  };

  const mkTerminalRun = (name, { state = 'completed', completedAt = OLD } = {}) => {
    const dir = join(runsRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ state, completedAt }));
    return dir;
  };

  const archiveAll = (options = {}) =>
    archiveTerminalSpools({ apply: true, minBytes: 0, throttleMs: 0, minAgeMs: 0, codec: 'gzip', ...options });

  // --- 1. 64 MB spool: streaming, hash sidecar, verify ----------------------
  wipeRunsRoot();
  const run64 = `run_${'a'.repeat(24)}`;
  const dir64 = mkTerminalRun(run64);
  const spool64 = join(dir64, 'spool.jsonl');
  const LINES_64 = lineCountFor(64 * 1024 * 1024);
  writeSpoolFile(spool64, LINES_64);
  const spool64Size = statSync(spool64).size;

  const rssBefore = process.memoryUsage().rss;
  const s64 = await archiveAll();
  const rssAfter = process.memoryUsage().rss;
  assert.equal(s64.archived >= 1, true, `64MB spool archived (${s64.archived})`);
  assert.equal(exists(spool64), false, '64MB plain spool removed');
  assert.equal(exists(`${spool64}.gz`), true, '64MB gz exists');
  assert.ok(rssAfter - rssBefore < 256 * 1024 * 1024, `streaming kept RSS flat (delta ${Math.round((rssAfter - rssBefore) / 1048576)}MB)`);

  const meta64 = JSON.parse(readFileSync(`${spool64}.gz.meta.json`, 'utf8'));
  assert.equal(meta64.codec, 'gzip');
  assert.equal(meta64.originalBytes, spool64Size, 'meta originalBytes == plain size');
  assert.match(meta64.originalSha256, /^[0-9a-f]{64}$/, 'original sha256 recorded');
  assert.equal(meta64.archivedBytes, readFileSync(`${spool64}.gz`).length, 'meta archivedBytes == gz size');

  const verify64 = await verifyArchivedSpool(`${spool64}.gz`);
  assert.equal(verify64.valid, true, '64MB archive verifies');
  assert.equal(verify64.hashCheckable, true, '64MB archive hash-checkable');
  assert.equal(verify64.actualBytes, meta64.originalBytes, 'verified byte count == original');
  assert.equal(verify64.actualSha256, meta64.originalSha256, 'verified sha256 == original');

  const tail64 = await readRunSpoolRecords(run64);
  assert.ok(tail64.length > 0, '64MB tail readable');
  assert.equal(tail64[tail64.length - 1].line.endsWith(`-${LINES_64 - 1}`), true, 'tail ends with the last written line');

  // --- 2. 500 MB spool -------------------------------------------------------
  wipeRunsRoot();
  const run500 = `run_${'b'.repeat(24)}`;
  const dir500 = mkTerminalRun(run500);
  const spool500 = join(dir500, 'spool.jsonl');
  const LINES_500 = lineCountFor(500 * 1024 * 1024);
  writeSpoolFile(spool500, LINES_500);
  const spool500Size = statSync(spool500).size;

  const rssBefore500 = process.memoryUsage().rss;
  const s500 = await archiveAll();
  const rssAfter500 = process.memoryUsage().rss;
  assert.equal(s500.archived >= 1, true, '500MB spool archived');
  assert.equal(exists(spool500), false, '500MB plain spool removed');
  assert.ok(rssAfter500 - rssBefore500 < 384 * 1024 * 1024, `500MB streaming kept RSS flat (delta ${Math.round((rssAfter500 - rssBefore500) / 1048576)}MB)`);

  const verify500 = await verifyArchivedSpool(`${spool500}.gz`);
  assert.equal(verify500.valid, true, '500MB archive verifies');
  assert.equal(verify500.actualBytes, spool500Size, '500MB verified byte count == plain size');
  const delta500 = await readRunSpoolDelta(run500, { maxRecords: 100 });
  assert.equal(delta500.records.length, 100, '500MB delta bounded read');
  assert.equal(delta500.records[0].line.endsWith('-0'), true, '500MB delta head is the first line');
  const tail500 = await readRunSpoolRecords(run500);
  assert.ok(tail500.length > 0, '500MB tail readable');
  assert.equal(tail500[tail500.length - 1].line.endsWith(`-${LINES_500 - 1}`), true, '500MB tail is the last line');

  // --- 3. Corrupted archive ---------------------------------------------------
  wipeRunsRoot();
  const runCorrupt = `run_${'c'.repeat(24)}`;
  const dirCorrupt = mkTerminalRun(runCorrupt);
  const spoolCorrupt = join(dirCorrupt, 'spool.jsonl');
  writeSpoolFile(spoolCorrupt, 40);
  await archiveAll();
  const gzCorrupt = `${spoolCorrupt}.gz`;
  const corruptBytes = readFileSync(gzCorrupt);
  const flipAt = Math.floor(corruptBytes.length / 2);
  corruptBytes[flipAt] ^= 0x5a; // corrupt the middle of the archive
  writeFileSync(gzCorrupt, corruptBytes);

  const verifyCorrupt = await verifyArchivedSpool(gzCorrupt);
  assert.equal(verifyCorrupt.valid, false, 'corrupted archive detected as invalid');
  assert.ok(verifyCorrupt.reason, 'corruption reason present');
  const recordsCorrupt = await readRunSpoolRecords(runCorrupt);
  assert.deepEqual(recordsCorrupt, [], 'corrupted archive reads return []');
  const deltaCorrupt = await readRunSpoolDelta(runCorrupt, {});
  assert.deepEqual(deltaCorrupt.records, [], 'corrupted archive delta returns []');

  // --- 4. Failure injection: plain spool is a directory ------------------------
  const runBad = `run_${'d'.repeat(24)}`;
  const dirBad = mkTerminalRun(runBad);
  mkdirSync(join(dirBad, 'spool.jsonl'), { recursive: true });
  const sBad = await archiveAll();
  assert.ok(sBad.failures.some((f) => f.runId === runBad), `failure recorded for ${runBad}`);
  assert.equal(exists(join(dirBad, 'spool.jsonl.gz')), false, 'no gz left behind');
  assert.equal(exists(join(dirBad, 'spool.jsonl.gz.tmp-')), false, 'no temp file left behind');
  assert.equal(statSync(join(dirBad, 'spool.jsonl')).isDirectory(), true, 'plain path untouched');

  // --- 5. Concurrent append during compression ---------------------------------
  wipeRunsRoot();
  const runRace = `run_${'e'.repeat(24)}`;
  const dirRace = mkTerminalRun(runRace);
  const spoolRace = join(dirRace, 'spool.jsonl');
  const LINES_RACE = lineCountFor(64 * 1024 * 1024);
  writeSpoolFile(spoolRace, LINES_RACE);
  const racePromise = archiveAll();
  await new Promise((r) => setTimeout(r, 120)); // land the append mid-compression
  await appendRunSpoolRecord(runRace, { ts: iso(Date.now()), stream: 'stdout', line: 'concurrent-append-line' });
  await racePromise;

  if (exists(spoolRace)) {
    // Guard aborted: plain kept with ALL lines (original + appended).
    const plainCount = readFileSync(spoolRace, 'utf8').split('\n').filter(Boolean).length;
    assert.equal(plainCount, LINES_RACE + 1, `concurrent append: plain kept with all ${LINES_RACE + 1} lines`);
    assert.equal(exists(`${spoolRace}.gz`), false, 'no partial archive when plain was kept');
  } else {
    // Archive won the race: the gz must contain every pre-append line.
    assert.equal(exists(`${spoolRace}.gz`), true, 'archive exists');
    const counts = await countArchiveLines(`${spoolRace}.gz`);
    assert.equal(counts.lines, LINES_RACE, `gz complete with ${LINES_RACE} lines, never fewer`);
  }

  // --- 6. Active runs never archived -------------------------------------------
  wipeRunsRoot();
  const runActive = `run_${'f'.repeat(24)}`;
  const dirActive = mkTerminalRun(runActive, { state: 'running', completedAt: null });
  writeSpoolFile(join(dirActive, 'spool.jsonl'), 10);
  const runTerm = `run_${'z'.repeat(24)}`;
  const dirTerm = mkTerminalRun(runTerm);
  writeSpoolFile(join(dirTerm, 'spool.jsonl'), 10);
  const sActive = await archiveAll();
  assert.equal(exists(join(dirActive, 'spool.jsonl')), true, 'active run plain spool untouched');
  assert.equal(exists(join(dirActive, 'spool.jsonl.gz')), false, 'active run never archived (gzip)');
  assert.equal(exists(join(dirActive, 'spool.jsonl.zst')), false, 'active run never archived (zstd)');
  assert.equal(exists(join(dirTerm, 'spool.jsonl.gz')), true, 'terminal run archived alongside');

  // --- 7. zstd codec ------------------------------------------------------------
  wipeRunsRoot();
  const runZst = `run_${'g'.repeat(24)}`;
  const dirZst = mkTerminalRun(runZst);
  const spoolZst = join(dirZst, 'spool.jsonl');
  writeSpoolFile(spoolZst, 30);
  const sZst = await archiveTerminalSpools({ apply: true, minBytes: 0, throttleMs: 0, minAgeMs: 0, codec: 'zstd' });
  assert.equal(sZst.archived >= 1, true, 'zstd archive applied');
  assert.equal(exists(spoolZst), false, 'zstd: plain spool removed');
  assert.equal(exists(`${spoolZst}.zst`), true, 'zstd archive exists');
  const metaZst = JSON.parse(readFileSync(`${spoolZst}.zst.meta.json`, 'utf8'));
  assert.equal(metaZst.codec, 'zstd');
  const verifyZst = await verifyArchivedSpool(`${spoolZst}.zst`);
  assert.equal(verifyZst.valid, true, 'zstd archive verifies');
  assert.equal(verifyZst.hashCheckable, true, 'zstd hash checkable');
  const recordsZst = await readRunSpoolRecords(runZst);
  assert.equal(recordsZst.length, 30, 'zstd archive readable via runs.mjs');
  const deltaZst = await readRunSpoolDelta(runZst, { skipLines: 5 });
  assert.equal(deltaZst.records.length, 25, 'zstd delta honors skipLines');

  // --- 8. Per-tick budgets ------------------------------------------------------
  wipeRunsRoot();
  const runBig = `run_${'h'.repeat(24)}`;
  const runMed = `run_${'i'.repeat(24)}`;
  const runSmall = `run_${'m'.repeat(24)}`;
  const dirBig = mkTerminalRun(runBig);
  const dirMed = mkTerminalRun(runMed);
  const dirSmall = mkTerminalRun(runSmall);
  writeSpoolFile(join(dirBig, 'spool.jsonl'), lineCountFor(3 * 1024 * 1024));
  writeSpoolFile(join(dirMed, 'spool.jsonl'), lineCountFor(1.5 * 1024 * 1024));
  writeSpoolFile(join(dirSmall, 'spool.jsonl'), lineCountFor(512 * 1024));
  const bigSize = statSync(join(dirBig, 'spool.jsonl')).size;

  const sBytes = await archiveTerminalSpools({
    apply: true,
    minBytes: 0,
    throttleMs: 0,
    minAgeMs: 0,
    codec: 'gzip',
    perTickBytes: bigSize + 1, // big fits alone; big + med would exceed
  });
  assert.equal(sBytes.tickStopped, 'per-tick-bytes', 'byte budget stops the tick');
  assert.equal(sBytes.archived, 1, 'byte budget archives the largest file only');
  assert.equal(sBytes.remainingCandidates, 2, 'byte budget reports remaining candidates');
  assert.equal(exists(join(dirBig, 'spool.jsonl.gz')), true, 'big file archived under byte budget');
  assert.equal(exists(join(dirMed, 'spool.jsonl')), true, 'medium file left for the next tick');
  assert.equal(exists(join(dirSmall, 'spool.jsonl')), true, 'small file left for the next tick');

  const sLimit = await archiveTerminalSpools({
    apply: true,
    minBytes: 0,
    throttleMs: 0,
    minAgeMs: 0,
    codec: 'gzip',
    perTickLimit: 1,
  });
  assert.equal(sLimit.tickStopped, 'per-tick-limit', 'count budget stops the tick');
  assert.equal(sLimit.archived, 1, 'count budget archives one file per tick');
  assert.equal(sLimit.remainingCandidates, 1, 'count budget reports remaining candidates');

  // Scheduler tick honors per-tick limit env and records resumable state.
  __resetRunArchiveSchedulerForTest();
  wipeRunsRoot();
  const tickA = mkTerminalRun(`run_${'j'.repeat(24)}`);
  const tickB = mkTerminalRun(`run_${'k'.repeat(24)}`);
  writeSpoolFile(join(tickA, 'spool.jsonl'), lineCountFor(2 * 1024 * 1024));
  writeSpoolFile(join(tickB, 'spool.jsonl'), lineCountFor(256 * 1024));
  process.env.RAGENT_RUN_SPOOL_ARCHIVE_ENABLED = '1';
  process.env.RAGENT_RUN_SPOOL_ARCHIVE_MIN_AGE_MS = '0';
  process.env.RAGENT_RUN_SPOOL_ARCHIVE_MIN_BYTES = '0';
  process.env.RAGENT_RUN_SPOOL_ARCHIVE_PER_TICK_LIMIT = '1';
  const stateFile = join(process.env.RAGENT_CONFIG_DIR, 'run-spool-archive-state.json');
  const { writeFile } = await import('fs/promises');
  await writeFile(stateFile, JSON.stringify({ lastRunAt: iso(Date.now() - 48 * 3600 * 1000), lastSummary: null }, null, 2));
  const tick = await processRunArchiveDueNow();
  assert.equal(tick.ran, true, 'tick runs when due');
  assert.equal(tick.summary.tickStopped, 'per-tick-limit', 'tick stopped by per-tick-limit');
  assert.equal(tick.summary.archived, 1, 'tick archived exactly one file');
  assert.equal(tick.summary.remainingCandidates, 1, 'tick left one candidate for the next tick (resumable)');
  const stateAfter = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(stateAfter.lastTick.archived, 1, 'state records last tick archived count');
  assert.equal(stateAfter.lastTick.tickStopped, 'per-tick-limit', 'state records stop reason');
  delete process.env.RAGENT_RUN_SPOOL_ARCHIVE_PER_TICK_LIMIT;
  delete process.env.RAGENT_RUN_SPOOL_ARCHIVE_MIN_AGE_MS;
  delete process.env.RAGENT_RUN_SPOOL_ARCHIVE_MIN_BYTES;
  delete process.env.RAGENT_RUN_SPOOL_ARCHIVE_ENABLED;

  // --- 9. CLI --verify -----------------------------------------------------------
  wipeRunsRoot();
  const runCli = `run_${'l'.repeat(24)}`;
  const dirCli = mkTerminalRun(runCli);
  writeSpoolFile(join(dirCli, 'spool.jsonl'), 10);
  await archiveAll();
  const script = join(import.meta.dirname, '..', 'scripts', 'archive-run-spools.mjs');
  const cleanOut = join(home, 'verify-clean.json');
  execFileSync(process.execPath, [script, '--root', process.env.RAGENT_CONFIG_DIR, '--verify', '--json-out', cleanOut]);
  const cleanReport = JSON.parse(readFileSync(cleanOut, 'utf8'));
  assert.equal(cleanReport.checked, 1, 'verify scanned the archive');
  assert.equal(cleanReport.invalid.length, 0, 'clean verify report has no invalid archives');

  // Corrupt the archive, then --verify must fail with exit 1.
  const gzCli = join(dirCli, 'spool.jsonl.gz');
  const corruptBytes2 = readFileSync(gzCli);
  corruptBytes2[Math.floor(corruptBytes2.length / 3)] ^= 0x3c;
  writeFileSync(gzCli, corruptBytes2);
  const badOut = join(home, 'verify-bad.json');
  const bad = spawnSync(process.execPath, [script, '--root', process.env.RAGENT_CONFIG_DIR, '--verify', '--json-out', badOut]);
  assert.equal(bad.status, 1, 'verify exits 1 on corrupted archive');
  const badReport = JSON.parse(readFileSync(badOut, 'utf8'));
  assert.ok(badReport.invalid.length >= 1, 'corrupted archive reported invalid');

  console.log('test-run-spool-archive-streaming: PASS');
} finally {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}

// --- helpers (defined after use via hoisting-safe patterns) ------------------

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
