#!/usr/bin/env node
// Verify cold-archive of terminal-run spools:
//   1. plain spool.jsonl reads (baseline records)
//   2. after gzip -> spool.jsonl.gz + unlink, reads transparently return the
//      same records via readRunSpoolRecords / readRunSpoolDelta
//   3. skipLines / maxRecords bounded reads on the gzip form
//   4. active runs (running) are not archived by scripts/archive-run-spools.mjs
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-run-spool-archive-'));
const previousEnv = {
  HOME: process.env.HOME,
  RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR,
  RAGENT_WORK_ROOT_DIR: process.env.RAGENT_WORK_ROOT_DIR,
};

process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_WORK_ROOT_DIR = join(home, '.ragent', 'workspace');

const { spawnSync } = await import('child_process');

try {
  const {
    appendRunSpoolRecord,
    createRun,
    createRunRecord,
    readRunSpoolDelta,
    readRunSpoolRecords,
    runDir,
    runSpoolPath,
  } = await import('../chat/runs.mjs');

  const record = createRunRecord({
    sessionId: 'session_spool_archive',
    requestId: 'req_spool_archive',
    tool: 'codex',
    runtimeFamily: 'codex-app-server-json',
  });
  const run = await createRun({ status: { ...record, state: 'completed' } });
  const dir = runDir(run.id);
  const spoolPath = runSpoolPath(run.id);

  const lines = [];
  for (let i = 0; i < 25; i++) {
    const entry = {
      ts: new Date().toISOString(),
      stream: i % 3 === 0 ? 'stderr' : 'stdout',
      line: `archive-test line ${i}`,
      json: i === 1 ? { kind: 'structured', index: i } : undefined,
    };
    lines.push(entry);
    await appendRunSpoolRecord(run.id, entry);
  }

  // 1. Baseline: plain spool reads
  const baselineRecords = await readRunSpoolRecords(run.id);
  assert.equal(baselineRecords.length, lines.length, 'baseline records count');
  const baselineDelta = await readRunSpoolDelta(run.id, {});
  assert.equal(baselineDelta.records.length, lines.length, 'baseline delta count');

  // 2. Archive: gzip + unlink via the archive script (dry-run must not touch)
  const script = join(import.meta.dirname, '..', 'scripts', 'archive-run-spools.mjs');
  execFileSync(process.execPath, [script, '--root', process.env.RAGENT_CONFIG_DIR, '--dry-run', '--json-out', join(home, 'dry.json')]);
  assert.equal(readFileSync(spoolPath, 'utf8').length > 0, true, 'dry-run must not remove plain spool');

  execFileSync(process.execPath, [script, '--root', process.env.RAGENT_CONFIG_DIR, '--apply', '--json-out', join(home, 'apply.json')]);
  const applyReport = JSON.parse(readFileSync(join(home, 'apply.json'), 'utf8'));
  assert.equal(applyReport.archived >= 1, true, `archived at least one spool (${applyReport.archived})`);
  assert.equal(readFileSync(`${spoolPath}.gz`, 'utf8').length > 0, true, 'gz exists');
  assert.equal(existsSync(spoolPath), false, 'plain spool removed');

  // 3. Transparent reads after archive
  const archivedRecords = await readRunSpoolRecords(run.id);
  assert.equal(archivedRecords.length, lines.length, 'archived records count matches baseline');
  assert.deepEqual(archivedRecords, baselineRecords, 'archived records equal baseline');

  const archivedDelta = await readRunSpoolDelta(run.id, {});
  assert.equal(archivedDelta.records.length, lines.length, 'archived delta count matches baseline');
  assert.deepEqual(archivedDelta.records, baselineRecords, 'archived delta records equal baseline');

  // 4. Bounded reads on gzip form
  const skipped = await readRunSpoolDelta(run.id, { skipLines: 5 });
  assert.equal(skipped.records.length, lines.length - 5, 'skipLines honored on gz');
  const capped = await readRunSpoolDelta(run.id, { maxRecords: 7 });
  assert.equal(capped.records.length, 7, 'maxRecords honored on gz');

  // 5. Active runs untouched by archive script
  const activeRecord = createRunRecord({
    sessionId: 'session_spool_active',
    requestId: 'req_spool_active',
    tool: 'codex',
    runtimeFamily: 'codex-app-server-json',
  });
  const activeRun = await createRun({ status: { ...activeRecord, state: 'running' } });
  await appendRunSpoolRecord(activeRun.id, { ts: new Date().toISOString(), stream: 'stdout', line: 'active line' });
  execFileSync(process.execPath, [script, '--root', process.env.RAGENT_CONFIG_DIR, '--apply']);
  assert.equal(readFileSync(runSpoolPath(activeRun.id), 'utf8').length > 0, true, 'active run spool untouched');

  console.log('test-run-spool-archive: PASS');
} finally {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}
