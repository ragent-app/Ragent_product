#!/usr/bin/env node
// DS-20 storage inventory + dry-run GC tests:
//   1. dry-run: every category classifies candidates with reason/age/size/
//      reference/recoverability; nothing is deleted
//   2. protected objects survive --apply: today's api log, current release
//      version, handoff-referenced deb, referenced artifacts, active-run
//      artifacts, fresh backups
//   3. --apply deletes/compresses only positively-checked candidates; api-log
//      gzip is integrity-verified before the plain file is removed
//   4. capped reference scan downgrades history-scan candidates to alert-only
//   5. state persistence + per-category daily growth + disk threshold alerts
//   6. CLI entry point (dry-run output, exit codes)
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-storage-gc-'));
const configDir = join(home, '.config', 'ragent');
const workspaceDir = join(home, '.ragent', 'workspace');
const stateFile = join(home, 'storage-gc-state.json');
const previousEnv = {
  HOME: process.env.HOME,
  RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR,
  RAGENT_WORK_ROOT_DIR: process.env.RAGENT_WORK_ROOT_DIR,
  RAGENT_STORAGE_GC_STATE_FILE: process.env.RAGENT_STORAGE_GC_STATE_FILE,
  RAGENT_STORAGE_GC_INSTALLED_VERSION: process.env.RAGENT_STORAGE_GC_INSTALLED_VERSION,
};

process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_WORK_ROOT_DIR = workspaceDir;
process.env.RAGENT_STORAGE_GC_STATE_FILE = stateFile;
process.env.RAGENT_STORAGE_GC_INSTALLED_VERSION = '0.3.3';

const NOW = new Date('2026-08-07T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const repoRoot = resolve(new URL('..', import.meta.url).pathname);

function write(path, content = 'x') {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function age(path, days) {
  const when = new Date(NOW.getTime() - days * DAY);
  utimesSync(path, when, when);
  return path;
}

function buildFixture() {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  // ---- api-logs
  age(write(join(configDir, 'api-logs', '2026-08-07.jsonl'), 'today'), 0);          // today: protected
  age(write(join(configDir, 'api-logs', '2026-07-30.jsonl'), 'old plain'), 8);      // compress candidate
  age(write(join(configDir, 'api-logs', '2026-07-30.jsonl.gz'), 'gz'), 8);          // under retention: keep
  age(write(join(configDir, 'api-logs', '2026-01-01.jsonl'), 'old'), 218);          // compress candidate
  age(write(join(configDir, 'api-logs', '2026-01-01.jsonl.gz'), 'old gz'), 218);    // delete candidate
  age(write(join(configDir, 'api-logs', '2026-09-01.jsonl'), 'future'), -25);       // future: alert

  // ---- history corpus (reference index)
  write(join(configDir, 'chat-history', 's1', 'events', '1.json'),
    JSON.stringify({ id: 'e1', refs: ['old-ref.png', 'ref-cache.bin'] }));
  write(join(configDir, 'chat-history', 's1', 'bodies', '1.txt'), 'body mentions old-ref.png');

  // ---- images / file-assets / file-assets-cache
  age(write(join(configDir, 'images', 'old-unref.png'), 'img'), 95);     // delete
  age(write(join(configDir, 'images', 'old-ref.png'), 'img'), 95);       // referenced: alert
  age(write(join(configDir, 'images', 'fresh.png'), 'img'), 1);          // young: keep
  age(write(join(configDir, 'file-assets', 'old-unref.bin'), 'bin'), 95);   // delete
  age(write(join(configDir, 'file-assets-cache', 'cache-old.bin'), 'bin'), 95); // delete

  // ---- chat-runs artifacts
  age(write(join(configDir, 'chat-runs', 'r1', 'artifacts', 'artifact-unref.bin'), 'a'), 100); // delete
  write(join(configDir, 'chat-runs', 'r1', 'status.json'), JSON.stringify({ state: 'completed' }));
  write(join(configDir, 'chat-runs', 'r1', 'result.json'), JSON.stringify({ ok: true }));
  age(write(join(configDir, 'chat-runs', 'r2', 'artifacts', 'artifact-ref.bin'), 'a'), 100);    // referenced: alert
  write(join(configDir, 'chat-runs', 'r2', 'status.json'), JSON.stringify({ state: 'completed' }));
  write(join(configDir, 'chat-runs', 'r2', 'result.json'), JSON.stringify({ files: ['artifact-ref.bin'] }));
  age(write(join(configDir, 'chat-runs', 'r3', 'artifacts', 'artifact-active.bin'), 'a'), 100); // running: alert
  write(join(configDir, 'chat-runs', 'r3', 'status.json'), JSON.stringify({ state: 'running' }));

  // ---- backups (keep newest 3; fresh snapshot never deleted)
  for (const [name, days] of [
    ['snap-2026-07-01', 37], ['snap-2026-07-10', 28], ['snap-2026-07-20', 18], ['snap-2026-08-01', 6], ['snap-fresh', 0.005],
  ]) {
    const dir = join(configDir, 'backups', name);
    write(join(dir, 'data'), 'b');
    age(dir, days); // age the directory itself, not the file inside
  }

  // ---- temp diagnostics
  age(write(join(configDir, 'tmp', 'stale.tmp'), 't'), 2);
  age(write(join(configDir, 'tmp', 'fresh.tmp'), 't'), 0.04);
  age(write(join(configDir, 'config-root.tmp'), 't'), 2);
  age(write(join(configDir, 'core.123456'), 'core'), 8);
  age(write(join(workspaceDir, 'tmp', 'ws-tmp.part'), 't'), 2);
  age(write(join(workspaceDir, 'root-level.tmp'), 't'), 2);

  // ---- workspace cache / builds / releases
  age(write(join(workspaceDir, 'cache', 'stale-cache.bin'), 'c'), 40);   // delete
  age(write(join(workspaceDir, 'cache', 'ref-cache.bin'), 'c'), 40);      // referenced: alert
  age(write(join(workspaceDir, 'cache', 'young.bin'), 'c'), 1);           // keep
  for (let i = 1; i <= 6; i++) {
    const dir = join(workspaceDir, 'builds', `build-${i}`);
    write(join(dir, 'out'), 'b');
    age(dir, 96 - i); // age the directory itself; keep newest 5, delete oldest build-1
  }
  age(write(join(workspaceDir, 'releases', 'ragent_0.3.3_amd64.deb'), 'deb'), 500); // installed version: protected
  age(write(join(workspaceDir, 'releases', 'ragent_0.2.0_amd64.deb'), 'deb'), 370);
  age(write(join(workspaceDir, 'releases', 'ragent_0.1.9_amd64.deb'), 'deb'), 380);
  age(write(join(workspaceDir, 'releases', 'ragent_0.1.8_amd64.deb'), 'deb'), 390);
  age(write(join(workspaceDir, 'releases', 'ragent_0.1.7_amd64.deb'), 'deb'), 400); // delete candidate
  age(write(join(workspaceDir, 'releases', 'ragent_0.1.6_amd64.deb'), 'deb'), 410); // handoff-referenced: protected
  write(join(configDir, 'install-handoffs.json'),
    JSON.stringify({ handoffs: [{ debPath: join(workspaceDir, 'releases', 'ragent_0.1.6_amd64.deb') }] }));

  // user workspace safety: an arbitrary project dir must never be touched
  age(write(join(workspaceDir, 'my-project', 'notes.md'), 'user data'), 400);
}

const { runStorageGc, buildReferenceIndex, summarizeReport, exitCodeForReport, exitCodeForScheduledReport, formatReport } =
  await import('../scripts/storage-inventory-gc.mjs');

function pathsByAction(report, category = null) {
  const result = { delete: [], compress: [], alert: [] };
  for (const candidate of report.candidates) {
    if (category && candidate.category !== category) continue;
    result[candidate.action].push(candidate.path);
  }
  return result;
}

// ------------------------------------------------------------- 1. dry-run
{
  buildFixture();
  const report = await runStorageGc({
    configDir,
    workspaceDir,
    now: NOW,
    apply: false,
    previousState: null,
    env: { ...process.env },
  });

  assert.equal(report.dryRun, true);
  const byAction = pathsByAction(report);

  // nothing deleted in dry-run
  assert.ok(existsSync(join(workspaceDir, 'cache', 'stale-cache.bin')));
  assert.ok(existsSync(join(configDir, 'api-logs', '2026-01-01.jsonl.gz')));
  assert.ok(existsSync(join(workspaceDir, 'builds', 'build-1', 'out')));

  // api-logs: compress old plain logs, delete retention-expired .gz, protect today
  assert.deepEqual(byAction.compress.sort(),
    [join(configDir, 'api-logs', '2026-01-01.jsonl'), join(configDir, 'api-logs', '2026-07-30.jsonl')].sort());
  assert.deepEqual(byAction.delete.filter((p) => p.includes('api-logs')),
    [join(configDir, 'api-logs', '2026-01-01.jsonl.gz')]);
  assert.ok(report.alerts.some((a) => a.message.includes('future')));

  // workspace-cache: delete unreferenced, alert referenced
  assert.deepEqual(byAction.delete.filter((p) => p.includes('cache') && p.includes('stale-cache')),
    [join(workspaceDir, 'cache', 'stale-cache.bin')]);
  assert.ok(byAction.alert.includes(join(workspaceDir, 'cache', 'ref-cache.bin')));
  const refCandidate = report.candidates.find((c) => c.path.endsWith('ref-cache.bin'));
  assert.equal(refCandidate.reference.status, 'referenced');
  assert.equal(refCandidate.recoverability, 'regenerable');

  // builds: keep newest 5, delete oldest
  assert.deepEqual(byAction.delete.filter((p) => p.includes('builds')),
    [join(workspaceDir, 'builds', 'build-1')]);

  // releases: only 0.1.7 is a candidate; 0.3.3 (installed) and 0.1.6 (handoff) protected
  assert.deepEqual(byAction.delete.filter((p) => p.includes('releases')),
    [join(workspaceDir, 'releases', 'ragent_0.1.7_amd64.deb')]);
  assert.ok(byAction.alert.includes(join(workspaceDir, 'releases', 'ragent_0.3.3_amd64.deb')));
  assert.ok(byAction.alert.includes(join(workspaceDir, 'releases', 'ragent_0.1.6_amd64.deb')));
  const protectedDeb = report.candidates.find((c) => c.path.endsWith('ragent_0.3.3_amd64.deb'));
  assert.ok(protectedDeb.reference.detail.includes('installed version'));

  // backups: keep-newest-3 (incl. the fresh snapshot) => two oldest candidates; fresh protected
  assert.deepEqual(byAction.delete.filter((p) => p.includes('backups')).sort(),
    [join(configDir, 'backups', 'snap-2026-07-01'), join(configDir, 'backups', 'snap-2026-07-10')].sort());
  assert.ok(!report.candidates.some((c) => c.path.includes('snap-fresh')));

  // temp-diagnostics
  const tempDeleted = byAction.delete.filter((p) => p.includes('tmp') || p.includes('core') || p.includes('.part'));
  for (const expected of [
    join(configDir, 'tmp', 'stale.tmp'),
    join(configDir, 'config-root.tmp'),
    join(configDir, 'core.123456'),
    join(workspaceDir, 'tmp', 'ws-tmp.part'),
    join(workspaceDir, 'root-level.tmp'),
  ]) {
    assert.ok(tempDeleted.includes(expected), `expected temp candidate ${expected}`);
  }
  assert.ok(!report.candidates.some((c) => c.path.endsWith('fresh.tmp')));

  // unreferenced-artifacts
  const artifactDeleted = byAction.delete.filter((p) => p.includes('images') || p.includes('file-assets') || p.includes('artifacts'));
  for (const expected of [
    join(configDir, 'images', 'old-unref.png'),
    join(configDir, 'file-assets', 'old-unref.bin'),
    join(configDir, 'file-assets-cache', 'cache-old.bin'),
    join(configDir, 'chat-runs', 'r1', 'artifacts', 'artifact-unref.bin'),
  ]) {
    assert.ok(artifactDeleted.includes(expected), `expected artifact delete ${expected}`);
  }
  assert.ok(byAction.alert.includes(join(configDir, 'images', 'old-ref.png')));
  assert.ok(byAction.alert.includes(join(configDir, 'chat-runs', 'r2', 'artifacts', 'artifact-ref.bin')));
  assert.ok(byAction.alert.includes(join(configDir, 'chat-runs', 'r3', 'artifacts', 'artifact-active.bin')));
  const runningCandidate = report.candidates.find((c) => c.path.endsWith('artifact-active.bin'));
  assert.ok(runningCandidate.reference.status === 'failed' || runningCandidate.reference.detail.includes('run state'));

  // user workspace never touched
  assert.ok(!report.candidates.some((c) => c.path.includes('my-project')));
  assert.ok(existsSync(join(workspaceDir, 'my-project', 'notes.md')));

  // every candidate carries the required fields
  for (const candidate of report.candidates) {
    assert.ok(typeof candidate.reason === 'string' && candidate.reason.length > 0, candidate.path);
    assert.ok(Number.isFinite(candidate.ageMs), candidate.path);
    assert.ok(Number.isFinite(candidate.sizeBytes), candidate.path);
    assert.ok(candidate.reference && typeof candidate.reference.status === 'string', candidate.path);
    assert.ok(candidate.recoverability, candidate.path);
  }

  // per-category dry-run stats present
  for (const category of ['api-logs', 'workspace-cache', 'workspace-builds', 'workspace-releases', 'backups', 'temp-diagnostics', 'unreferenced-artifacts']) {
    assert.ok(report.categories[category], category);
    assert.ok(Number.isInteger(report.categories[category].scanned), category);
    assert.ok(Number.isInteger(report.categories[category].candidates), category);
    assert.ok(report.categories[category].owner, category);
  }

  console.log('ok 1 - dry-run classification + protected objects');
}

// ------------------------------------------------------------- 2. apply
{
  buildFixture();
  const report = await runStorageGc({
    configDir,
    workspaceDir,
    now: NOW,
    apply: true,
    previousState: null,
    env: { ...process.env },
  });
  assert.equal(report.dryRun, false);
  assert.deepEqual(report.errors, []);

  // deleted
  assert.ok(!existsSync(join(workspaceDir, 'cache', 'stale-cache.bin')));
  assert.ok(!existsSync(join(configDir, 'images', 'old-unref.png')));
  assert.ok(!existsSync(join(configDir, 'file-assets', 'old-unref.bin')));
  assert.ok(!existsSync(join(configDir, 'file-assets-cache', 'cache-old.bin')));
  assert.ok(!existsSync(join(workspaceDir, 'builds', 'build-1')));
  assert.ok(!existsSync(join(workspaceDir, 'releases', 'ragent_0.1.7_amd64.deb')));
  assert.ok(!existsSync(join(configDir, 'backups', 'snap-2026-07-01')));
  assert.ok(!existsSync(join(configDir, 'backups', 'snap-2026-07-10')));
  assert.ok(!existsSync(join(configDir, 'tmp', 'stale.tmp')));
  assert.ok(!existsSync(join(configDir, 'config-root.tmp')));
  assert.ok(!existsSync(join(configDir, 'core.123456')));
  assert.ok(!existsSync(join(workspaceDir, 'tmp', 'ws-tmp.part')));
  assert.ok(!existsSync(join(workspaceDir, 'root-level.tmp')));
  assert.ok(!existsSync(join(configDir, 'chat-runs', 'r1', 'artifacts', 'artifact-unref.bin')));

  // api-logs compressed: plain logs removed, .gz exists, content survives
  assert.ok(!existsSync(join(configDir, 'api-logs', '2026-07-30.jsonl')));
  assert.ok(existsSync(join(configDir, 'api-logs', '2026-07-30.jsonl.gz')));
  // the 218d plain log was compressed and replaced its stale sibling .gz
  // (freshly created gz is never deleted by a sibling delete candidate)
  assert.ok(!existsSync(join(configDir, 'api-logs', '2026-01-01.jsonl')));
  assert.ok(existsSync(join(configDir, 'api-logs', '2026-01-01.jsonl.gz')));

  // protected
  assert.ok(existsSync(join(configDir, 'api-logs', '2026-08-07.jsonl')));
  assert.ok(existsSync(join(workspaceDir, 'releases', 'ragent_0.3.3_amd64.deb')));
  assert.ok(existsSync(join(workspaceDir, 'releases', 'ragent_0.1.6_amd64.deb')));
  assert.ok(existsSync(join(configDir, 'images', 'old-ref.png')));
  assert.ok(existsSync(join(workspaceDir, 'cache', 'ref-cache.bin')));
  assert.ok(existsSync(join(configDir, 'chat-runs', 'r2', 'artifacts', 'artifact-ref.bin')));
  assert.ok(existsSync(join(configDir, 'chat-runs', 'r3', 'artifacts', 'artifact-active.bin')));
  assert.ok(existsSync(join(configDir, 'backups', 'snap-fresh', 'data')));
  assert.ok(existsSync(join(workspaceDir, 'my-project', 'notes.md')));

  // state persisted
  assert.ok(existsSync(stateFile));
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.version, 1);
  assert.ok(state.categories['api-logs']);
  assert.ok(state.categories['workspace-releases']);
  assert.ok(state.volume);

  console.log('ok 2 - apply deletes + compresses only positively-checked candidates');
}

// ------------------------------------------------------------- 3. growth + thresholds
{
  buildFixture();
  const baseEnv = { ...process.env, RAGENT_STORAGE_GC_DISK_WARN_PCT: '100', RAGENT_STORAGE_GC_DISK_CRITICAL_PCT: '100' };
  const first = await runStorageGc({ configDir, workspaceDir, now: NOW, apply: false, previousState: null, env: baseEnv });
  assert.equal(first.growth, null); // no previous state

  // 10 days later, cache category grew by 3000 bytes
  age(write(join(workspaceDir, 'cache', 'growth.bin'), 'x'.repeat(3000)), 9); // young: counted in totals, not a candidate
  const later = new Date(NOW.getTime() + 10 * DAY);
  const second = await runStorageGc({
    configDir,
    workspaceDir,
    now: later,
    apply: false,
    previousState: await import('../scripts/storage-inventory-gc.mjs').then((m) => m.loadState(stateFile)),
    env: { ...baseEnv, RAGENT_STORAGE_GC_STATE_FILE: stateFile },
  });
  assert.ok(second.growth, 'growth computed');
  const cacheGrowth = second.growth.categories['workspace-cache'];
  assert.ok(cacheGrowth, 'cache growth tracked');
  assert.ok(Math.abs(cacheGrowth.bytesPerDay - 300) < 1, `cache growth ~300 B/day, got ${cacheGrowth.bytesPerDay}`);
  assert.ok(second.categories['workspace-cache'].bytes >= 3000);

  // disk threshold alerts: warn threshold 0 triggers warn; critical 0 triggers critical
  const warnReport = await runStorageGc({
    configDir, workspaceDir, now: NOW, apply: false, previousState: null,
    env: { ...process.env, RAGENT_STORAGE_GC_DISK_WARN_PCT: '0', RAGENT_STORAGE_GC_DISK_CRITICAL_PCT: '100' },
  });
  assert.ok(warnReport.alerts.some((a) => a.severity === 'warn' && a.message.startsWith('disk usage')));
  assert.equal(exitCodeForReport(warnReport), 1);

  const criticalReport = await runStorageGc({
    configDir, workspaceDir, now: NOW, apply: false, previousState: null,
    env: { ...process.env, RAGENT_STORAGE_GC_DISK_WARN_PCT: '0', RAGENT_STORAGE_GC_DISK_CRITICAL_PCT: '0' },
  });
  assert.ok(criticalReport.alerts.some((a) => a.severity === 'critical'));
  assert.equal(exitCodeForReport(criticalReport), 2);
  assert.equal(exitCodeForScheduledReport(criticalReport), 0, 'scheduled alerts must not mark the timer failed');
  assert.equal(exitCodeForScheduledReport({ alerts: [], errors: [{ message: 'scan failed' }] }), 1);

  console.log('ok 3 - growth tracking + disk threshold alerts');
}

// ------------------------------------------------------------- 4. capped scan => alert-only
{
  buildFixture();
  // corpus larger than the 1MB cap forces the reference scan to truncate
  write(join(configDir, 'chat-history', 's1', 'events', 'big.json'), 'x'.repeat(2 * 1024 * 1024));

  const index = await buildReferenceIndex({ configDir, candidateNames: ['old-unref.png'], capBytes: 1 });
  assert.equal(index.capped, true);

  const cappedReport = await runStorageGc({
    configDir,
    workspaceDir,
    now: NOW,
    apply: true, // even apply must not delete under an incomplete scan
    previousState: null,
    env: { ...process.env, RAGENT_STORAGE_GC_REF_SCAN_MAX_MB: '1' },
  });
  const imageCandidate = cappedReport.candidates.find((c) => c.path.endsWith('old-unref.png'));
  assert.ok(imageCandidate, 'candidate still listed');
  assert.equal(imageCandidate.action, 'alert', 'capped scan must downgrade to alert-only');
  assert.equal(imageCandidate.reference.status, 'incomplete');
  assert.ok(existsSync(join(configDir, 'images', 'old-unref.png')), 'nothing deleted under incomplete scan');

  console.log('ok 4 - capped reference scan => alert-only, nothing deleted');
}

// ------------------------------------------------------------- 5. report formatting
{
  buildFixture();
  const report = await runStorageGc({ configDir, workspaceDir, now: NOW, apply: false, previousState: null, env: { ...process.env } });
  const text = formatReport(report);
  assert.ok(text.includes('dry-run'));
  assert.ok(text.includes('Categories:'));
  assert.ok(text.includes('[delete'));
  assert.ok(text.includes('ref=referenced'));
  const summary = summarizeReport(report);
  assert.ok(summary.deleteCount >= 15, `expected >= 15 deletions, got ${summary.deleteCount}`);
  assert.equal(summary.compressCount, 2);
  console.log('ok 5 - report formatting');
}

// ------------------------------------------------------------- 6. CLI
{
  buildFixture();
  const result = spawnSync(process.execPath, ['scripts/storage-inventory-gc.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      // The CLI fixture should not inherit the host's disk-pressure state.
      RAGENT_STORAGE_GC_DISK_WARN_PCT: '100',
      RAGENT_STORAGE_GC_DISK_CRITICAL_PCT: '100',
    },
    encoding: 'utf8',
  });
  // fixture contains a future-dated api log => warn severity => exit 1;
  // never a critical failure (2) on a clean fixture
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  assert.ok(result.stdout.includes('dry-run'));
  assert.ok(result.stdout.includes('Categories:'));

  const help = spawnSync(process.execPath, ['scripts/storage-inventory-gc.mjs', '--help'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);

  console.log('ok 6 - CLI dry-run + --help');
}

rmSync(home, { recursive: true, force: true });
for (const [key, value] of Object.entries(previousEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
console.log('storage-inventory-gc: all tests passed');
