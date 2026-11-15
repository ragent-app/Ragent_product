#!/usr/bin/env node
// DS-14: spool dedupe at write time + offline scanner + validated migration.
//
// Asserts that appendRunSpoolRecord no longer stores `line` next to an equal
// `json`; that the offline scanner (chat/run-spool-reclaim.mjs) counts old
// double-write records, bad/oversized lines, UTF-8 boundary content and
// missing lineArtifact refs, and estimates reclaimable bytes; and that
// migration only writes a deduplicated copy for terminal plain spools and
// only when the written copy verifies (hash + count + trailing record).
// All state lives in a throwaway HOME (same convention as
// test-run-spool-delta.mjs).
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { gzipSync } from 'zlib';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-spool-reclaim-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
delete process.env.RAGENT_INSTANCE_ROOT;

const {
  appendRunSpoolRecord,
  createRun,
  readRunSpoolDelta,
} = await import('../chat/runs.mjs');
const { CHAT_RUNS_DIR } = await import('../lib/config.mjs');
const {
  dedupeRecord,
  isDuplicateLineRecord,
  migrateRunSpool,
  scanAllRunSpools,
  scanRunSpool,
} = await import('../chat/run-spool-reclaim.mjs');

function writeJsonSync(path, value) {
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

const now = Date.now();

// Fabricate a run directory with the historical double-write spool format.
function fabricateRun(runId, { state = 'completed', completedAt, spoolLines, gzip = false } = {}) {
  const dir = join(CHAT_RUNS_DIR, runId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeJsonSync(join(dir, 'status.json'), {
    state,
    completedAt: completedAt || new Date(now - 3600_000).toISOString(),
    updatedAt: new Date(now - 3600_000).toISOString(),
  });
  const content = `${spoolLines.join('\n')}\n`;
  const spoolPath = join(dir, gzip ? 'spool.jsonl.gz' : 'spool.jsonl');
  if (gzip) {
    writeFileSync(spoolPath, gzipSync(content));
  } else {
    writeFileSync(spoolPath, content, 'utf8');
  }
  return dir;
}

function duplicateBytesOf(record) {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
    - Buffer.byteLength(JSON.stringify(dedupeRecord(record)), 'utf8');
}

let runCounter = 0;
function nextRunId(prefix = 'run_reclaim') {
  runCounter += 1;
  return `${prefix}_${process.pid}_${runCounter}`;
}

// Serialized sizes of the duplicate `line` fields fabricated across sections;
// the aggregate scan (section 6) must account for every one of them.
const dupSizes = [];

try {
  // --- 1. normalizeSpoolRecord drops the duplicate line at write time ---
  {
    const run = await createRun({
      status: { sessionId: 's_reclaim_1', requestId: 'r_reclaim_1', state: 'accepted', tool: 'fake' },
      manifest: { sessionId: 's_reclaim_1', requestId: 'r_reclaim_1', folder: '~', tool: 'fake', prompt: 'hi', options: {} },
    });
    const event = { type: 'status', content: 'hello world' };
    await appendRunSpoolRecord(run.id, { ts: '2026-08-08T00:00:00.000Z', stream: 'stdout', line: JSON.stringify(event), json: event });
    await appendRunSpoolRecord(run.id, { ts: '2026-08-08T00:00:01.000Z', stream: 'stderr', line: 'raw stderr text' });
    await appendRunSpoolRecord(run.id, { ts: '2026-08-08T00:00:02.000Z', stream: 'stdout', line: 'human readable', json: { type: 'status', content: 'x' } });

    const delta = await readRunSpoolDelta(run.id, {});
    const [duplicate, rawOnly, mixed] = delta.records;
    assert.equal('line' in duplicate, false, 'exact line=JSON.stringify(json) duplicate should be dropped');
    assert.deepEqual(duplicate.json, event, 'structured record should survive intact');
    assert.equal(rawOnly.line, 'raw stderr text', 'raw-only record keeps its line');
    assert.equal('json' in rawOnly, false, 'raw-only record has no json');
    assert.equal(mixed.line, 'human readable', 'non-duplicate line next to json is preserved');
    assert.equal(mixed.json.content, 'x');
  }

  // --- 2. scanner counts old-format duplicates, bad/oversized lines, refs ---
  {
    const runId = nextRunId();
    const r1 = { ts: '2026-08-08T00:00:00.000Z', stream: 'stdout', line: JSON.stringify({ type: 'status', content: 'a' }), json: { type: 'status', content: 'a' } };
    const r2 = { ts: '2026-08-08T00:00:01.000Z', stream: 'stderr', line: 'raw line' };
    const r3 = { ts: '2026-08-08T00:00:02.000Z', stream: 'stdout', json: { type: 'status', content: 'b' } };
    const r4dup = { ts: '2026-08-08T00:00:03.000Z', stream: 'stdout', line: JSON.stringify({ type: 'status', content: 'c' }), json: { type: 'status', content: 'c' }, lineArtifact: 'line_abc123' };
    const badLine = 'this is not json at all {';
    const oversized = 'x'.repeat(2 * 1024 * 1024 + 16);
    fabricateRun(runId, { spoolLines: [JSON.stringify(r1), JSON.stringify(r2), JSON.stringify(r3), JSON.stringify(r4dup), badLine, oversized] });

    const scan = await scanRunSpool(join(CHAT_RUNS_DIR, runId));
    assert.equal(scan.form, 'plain');
    assert.equal(scan.terminal, true);
    assert.ok(scan.terminalAgeMs > 0, 'terminal age should be positive');
    assert.equal(scan.totalRecords, 6, 'bad and oversized lines still count as lines');
    assert.equal(scan.parseableRecords, 4);
    assert.equal(scan.badLines, 1);
    assert.equal(scan.oversizedLines, 1);
    assert.equal(scan.structuredRecords, 3);
    assert.equal(scan.rawOnlyRecords, 1);
    assert.equal(scan.duplicateRecords, 2, 'r1 and r4dup are exact duplicates');
    assert.equal(scan.duplicateBytes, duplicateBytesOf(r1) + duplicateBytesOf(r4dup), 'reclaim estimate should equal serialized line field sizes');
    assert.equal(scan.lineArtifactRefs, 1);
    assert.equal(scan.missingArtifactRefs, 1, 'line_abc123.txt was never written');
    assert.deepEqual(scan.lastRecord, r4dup, 'last parsed record is the trailing one');
    dupSizes.push(duplicateBytesOf(r1), duplicateBytesOf(r4dup));
  }

  // --- 3. UTF-8 boundary: multi-byte records survive tiny scan chunks ---
  {
    const runId = nextRunId();
    const multiByte = '消息·测试🎯'.repeat(200);
    const records = [
      { ts: '2026-08-08T00:00:00.000Z', stream: 'stdout', line: JSON.stringify({ type: 'status', content: multiByte }), json: { type: 'status', content: multiByte } },
      { ts: '2026-08-08T00:00:01.000Z', stream: 'stderr', line: multiByte },
    ];
    fabricateRun(runId, { spoolLines: records.map((r) => JSON.stringify(r)) });

    const scan = await scanRunSpool(join(CHAT_RUNS_DIR, runId), { highWaterMark: 8 });
    assert.equal(scan.totalRecords, 2, 'both multi-byte records parse');
    assert.equal(scan.badLines, 0, 'no corruption from chunk straddling');
    assert.equal(scan.parseableRecords, 2);
    assert.equal(scan.lastRecord.line, multiByte, 'multi-byte content must be byte-exact');
    assert.equal(isDuplicateLineRecord(records[0]), true);
    dupSizes.push(duplicateBytesOf(records[0]));
  }

  // --- 4. migration: terminal-only, verified, lossless; refusals ---
  {
    const runId = nextRunId();
    const r1 = { ts: '2026-08-08T00:00:00.000Z', stream: 'stdout', line: JSON.stringify({ type: 'status', content: 'dup' }), json: { type: 'status', content: 'dup' } };
    const r2 = { ts: '2026-08-08T00:00:01.000Z', stream: 'stderr', line: 'raw' };
    const badLine = 'not json {';
    const r3 = { ts: '2026-08-08T00:00:02.000Z', stream: 'stdout', json: { type: 'status', content: 'tail' } };
    fabricateRun(runId, { spoolLines: [JSON.stringify(r1), JSON.stringify(r2), badLine, JSON.stringify(r3)] });

    const outDir = join(home, 'migrated');
    const result = await migrateRunSpool(join(CHAT_RUNS_DIR, runId), { outDir });
    assert.equal(result.ok, true, `migration should succeed: ${result.reasons.join(' ')}`);
    assert.equal(result.validation.hashOk, true);
    assert.equal(result.validation.countOk, true);
    assert.equal(result.validation.trailingOk, true);

    const { readFile } = await import('fs/promises');
    const written = String(await readFile(result.writtenPath, 'utf8')).trim().split('\n');
    assert.equal(written.length, 4, 'record count preserved (bad line copied verbatim)');
    assert.equal(written[0], JSON.stringify(dedupeRecord(r1)), 'duplicate record written without line');
    assert.equal(written[1], JSON.stringify(r2), 'raw record unchanged');
    assert.equal(written[2], badLine, 'bad line copied verbatim');
    assert.equal(written[3], JSON.stringify(r3), 'trailing record byte-identical');
    assert.equal('line' in JSON.parse(written[0]), false);

    // original untouched
    const original = String(await readFile(join(CHAT_RUNS_DIR, runId, 'spool.jsonl'), 'utf8'));
    assert.ok(original.includes('"line"'), 'original spool must not be modified');
    dupSizes.push(duplicateBytesOf(r1));
  }

  // --- 5. migration refusals: non-terminal, archived ---
  {
    const runningId = nextRunId();
    const liveDup = { stream: 'stdout', line: JSON.stringify({ type: 'status', content: 'live' }), json: { type: 'status', content: 'live' } };
    fabricateRun(runningId, {
      state: 'running',
      spoolLines: [JSON.stringify(liveDup)],
    });
    dupSizes.push(duplicateBytesOf(liveDup));
    const refused = await migrateRunSpool(join(CHAT_RUNS_DIR, runningId), { outDir: join(home, 'migrated') });
    assert.equal(refused.ok, false, 'live runs must never be migrated');
    assert.ok(refused.reasons.join(' ').includes('not terminal'));

    const archivedId = nextRunId();
    fabricateRun(archivedId, {
      spoolLines: [JSON.stringify({ stream: 'stdout', line: 'already compressed' })],
      gzip: true,
    });
    const archivedRefusal = await migrateRunSpool(join(CHAT_RUNS_DIR, archivedId), { outDir: join(home, 'migrated') });
    assert.equal(archivedRefusal.ok, false, 'archived spools are not migrated');
    assert.ok(archivedRefusal.reasons.join(' ').includes('plain spool missing'));
  }

  // --- 6. scanAllRunSpools aggregates across plain + archived ---
  {
    const plainId = nextRunId();
    const dup = { stream: 'stdout', line: JSON.stringify({ type: 'status', content: 'a' }), json: { type: 'status', content: 'a' } };
    fabricateRun(plainId, { spoolLines: [JSON.stringify(dup)] });
    const gzId = nextRunId();
    fabricateRun(gzId, { spoolLines: [JSON.stringify({ stream: 'stdout', line: 'compressed raw' })], gzip: true });

    const { totals, runs } = await scanAllRunSpools({ root: join(home, '.config', 'ragent') });
    assert.equal(totals.runsScanned, 8, 'all sections contribute their runs');
    const plainRun = runs.find((r) => r.runId === plainId);
    const gzRun = runs.find((r) => r.runId === gzId);
    assert.ok(plainRun, 'plain run should be scanned');
    assert.equal(plainRun.form, 'plain');
    assert.equal(plainRun.duplicateRecords, 1);
    assert.equal(gzRun.form, 'gz', 'archived spool detected via gzip stream');
    assert.equal(gzRun.parseableRecords, 1);
    assert.equal(gzRun.scanError, undefined, 'gz scan must not error');
    dupSizes.push(duplicateBytesOf(dup));
    // Aggregate counts cover every run fabricated earlier in this test:
    // section-1 createRun + sections 2/3/4 + section-5 runningId + section-6
    // plain are plain form (6), section-5 archivedId + section-6 gzId are gz
    // (2), and every duplicate pushed into dupSizes must be counted with its
    // exact size.
    assert.equal(totals.plain, 6);
    assert.equal(totals.gz, 2);
    assert.equal(totals.duplicateRecords, dupSizes.length);
    assert.equal(totals.duplicateBytes, dupSizes.reduce((a, b) => a + b, 0));
  }

  console.log('spool reclaim: all sections passed');
} finally {
  rmSync(home, { recursive: true, force: true });
}
