#!/usr/bin/env node
// Verify the cold-archive scheduler + retention gate in chat/run-spool-archive.mjs:
//   1. minAgeMs retention gate: an old terminal run is archived; a run that just
//      finished is skipped (skippedByAge) and its plain spool stays intact.
//   2. Only terminal runs are touched; running runs keep their plain spool.
//   3. Idempotent: a second pass archives nothing.
//   4. Scheduler due-check:
//        - disabled env  -> { ran:false, reason:'disabled' }
//        - no state file  -> runs and writes the durable state file
//        - recent state   -> { ran:false, reason:'not-due' }
//        - due tick archives an old run end-to-end
import assert from 'assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-run-spool-archive-sched-'));
const previousEnv = {
  HOME: process.env.HOME,
  RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR,
  RAGENT_WORK_ROOT_DIR: process.env.RAGENT_WORK_ROOT_DIR,
};

process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_WORK_ROOT_DIR = join(home, '.ragent', 'workspace');

const iso = (ms) => new Date(ms).toISOString();

try {
  const {
    appendRunSpoolRecord,
    createRun,
    createRunRecord,
    runSpoolPath,
  } = await import('../chat/runs.mjs');
  const {
    archiveTerminalSpools,
    processRunArchiveDueNow,
    __resetRunArchiveSchedulerForTest,
  } = await import('../chat/run-spool-archive.mjs');

  const now = Date.now();
  const HOUR = 3600 * 1000;
  const configDir = process.env.RAGENT_CONFIG_DIR;
  const stateFile = join(configDir, 'run-spool-archive-state.json');

  const mkRun = async ({ state, completedAt, lines = 8 }) => {
    const record = createRunRecord({
      sessionId: `session_${state}_${Math.random().toString(36).slice(2, 8)}`,
      requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
    });
    const run = await createRun({ status: { ...record, state, completedAt: completedAt || null } });
    for (let i = 0; i < lines; i++) {
      await appendRunSpoolRecord(run.id, { ts: iso(now), stream: 'stdout', line: `${state} line ${i}` });
    }
    return run;
  };

  // 1. Retention gate (minAgeMs = 1h): old run archived, fresh run skipped.
  const oldRun = await mkRun({ state: 'completed', completedAt: iso(now - 2 * HOUR) });
  const freshRun = await mkRun({ state: 'completed', completedAt: iso(now) });

  const gated = await archiveTerminalSpools({ apply: true, minAgeMs: HOUR, minBytes: 0, throttleMs: 0 });
  assert.equal(gated.archived >= 1, true, `old run should be archived (archived=${gated.archived})`);
  assert.equal(gated.skippedByAge >= 1, true, `fresh run should be counted as skippedByAge (got ${gated.skippedByAge})`);
  assert.equal(existsSync(`${runSpoolPath(oldRun.id)}.gz`), true, 'old run spool archived to .gz');
  assert.equal(existsSync(runSpoolPath(oldRun.id)), false, 'old run plain spool removed');
  assert.equal(existsSync(runSpoolPath(freshRun.id)), true, 'fresh run plain spool kept (within retention gate)');
  assert.equal(existsSync(`${runSpoolPath(freshRun.id)}.gz`), false, 'fresh run not archived');

  // 2. Running runs are never touched (no gate this time). The leftover freshRun
  //    from step 1 is now an eligible candidate (terminal, gate off), so the
  //    pass archives it — what matters is that the running run's spool survives.
  const runningRun = await mkRun({ state: 'running', completedAt: null, lines: 3 });
  const touchRunning = await archiveTerminalSpools({ apply: true, minAgeMs: 0, minBytes: 0, throttleMs: 0 });
  assert.equal(existsSync(runSpoolPath(runningRun.id)), true, 'running run plain spool untouched');
  assert.equal(existsSync(`${runSpoolPath(runningRun.id)}.gz`), false, 'running run never archived to .gz');
  assert.equal(touchRunning.archived >= 1, true, 'leftover terminal candidate was archived (sanity)');

  // 3. Idempotent: a second pass archives nothing that is already archived.
  //    Add a fresh terminal run to also confirm the gate still holds.
  const freshRun2 = await mkRun({ state: 'completed', completedAt: iso(now) });
  const again = await archiveTerminalSpools({ apply: true, minAgeMs: HOUR, minBytes: 0, throttleMs: 0 });
  assert.equal(again.archived, 0, 'second pass must be a no-op for already-archived runs');
  assert.equal(again.skippedByAge >= 1, true, 'fresh run still held back by the retention gate');
  assert.equal(existsSync(runSpoolPath(freshRun2.id)), true, 'fresh run plain spool kept');

  // 4. Scheduler due-check. Drive processRunArchiveDueNow directly (no real timer).
  __resetRunArchiveSchedulerForTest();

  // 4a. disabled switch short-circuits.
  process.env.RAGENT_RUN_SPOOL_ARCHIVE_ENABLED = '0';
  let r = await processRunArchiveDueNow();
  assert.equal(r.ran, false, 'disabled scheduler must not run');
  assert.equal(r.reason, 'disabled', 'disabled reason');
  delete process.env.RAGENT_RUN_SPOOL_ARCHIVE_ENABLED;

  // 4b. no state file -> due -> runs + writes durable state.
  assert.equal(existsSync(stateFile), false, 'no state file before first tick');
  process.env.RAGENT_RUN_SPOOL_ARCHIVE_MIN_AGE_MS = '0'; // age gate off so the fresh run is also a candidate
  process.env.RAGENT_RUN_SPOOL_ARCHIVE_MIN_BYTES = '0';
  r = await processRunArchiveDueNow();
  assert.equal(r.ran, true, 'first tick (no state) must run');
  assert.equal(existsSync(stateFile), true, 'durable state file written');
  const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(typeof persisted.lastRunAt, 'string', 'state has lastRunAt');
  assert.equal(persisted.lastSummary.archived >= 1, true, 'state captured archived count');

  // 4c. recent state -> not-due (default 6h interval).
  r = await processRunArchiveDueNow();
  assert.equal(r.ran, false, 'tick right after a run must be not-due');
  assert.equal(r.reason, 'not-due', 'not-due reason');

  // 4d. backdate state past the interval -> due again.
  persisted.lastRunAt = iso(now - 7 * HOUR);
  const { writeFile } = await import('fs/promises');
  await writeFile(stateFile, JSON.stringify(persisted, null, 2));
  r = await processRunArchiveDueNow();
  assert.equal(r.ran, true, 'backdated state past interval must be due');

  console.log('test-run-spool-archive-scheduler: PASS');
} finally {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}
