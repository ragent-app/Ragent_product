#!/usr/bin/env node
// Execution-Scope slice 3: durable WorkspaceLease store.
//
// Covers the admission matrix (write/write, read/read, read vs write, shared
// realpath across projects), conditional heartbeat by generation, TTL recovery
// (renew/reclaim/quarantine), cross-process admission on the same SQLite
// lockKey, legacy synthetic leases, activation, and store cleanup.
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const configDir = mkdtempSync(join(tmpdir(), 'ragent-workspace-leases-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const {
  acquireWorkspaceLease,
  activateLease,
  renewLease,
  markRuntimeTerminal,
  releaseLease,
  reclaimLease,
  quarantineLease,
  listActiveLeases,
  listExpiredLeases,
  recoverLeases,
  recoverMutationLeases,
  findLeaseByRunId,
  closeWorkspaceLeaseStore,
} = await import('../chat/workspace-leases.mjs');
const { ensureLegacySyntheticLeases } = await import('../chat/run-admission.mjs');
const { ensureWorkspaceForRoot } = await import('../chat/workspaces.mjs');
const { createProject } = await import('../chat/projects.mjs');

const createdDirs = [];
function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

// ── assertion accounting ───────────────────────────────────────────────────
let totalAssertions = 0;
let currentSection = null;
function beginSection(name) {
  currentSection = { name, count: 0 };
}
function countAssertions(n = 1) {
  totalAssertions += n;
  if (currentSection) currentSection.count += n;
}
function eq(actual, expected, message) { countAssertions(); assert.equal(actual, expected, message); }
function ok(value, message) { countAssertions(); assert.ok(value, message); }
function notOk(value, message) { countAssertions(); assert.ok(!value, message); }
function deepEq(actual, expected, message) { countAssertions(); assert.deepEqual(actual, expected, message); }
function rejects(promiseFactory, predicate, message) {
  countAssertions();
  return assert.rejects(promiseFactory, predicate, message);
}

function leaseEvents() {
  const db = new DatabaseSync(join(configDir, 'runtime-coordination.db'));
  try {
    return db.prepare('SELECT type, lock_key, lease_id FROM workspace_lease_events ORDER BY id').all();
  } finally {
    db.close();
  }
}

function eventCount(events, type) {
  return events.filter((event) => event.type === type).length;
}

const sections = [];
function finishSection() {
  if (currentSection) sections.push(currentSection);
  currentSection = null;
}

try {
  // ── admission matrix ──────────────────────────────────────────────────────
  beginSection('admission-matrix');

  // no holder -> write allowed
  const keyWrite = 'sha256:matrix-write';
  const writeA = await acquireWorkspaceLease({
    lockKey: keyWrite,
    mode: 'write',
    workspaceId: 'ws_matrix_a',
    projectId: 'prj_matrix_a',
    sessionId: 'sess_matrix',
    runId: 'run_matrix_a',
    runtimeId: 'runner_test',
  });
  ok(writeA.leaseId.startsWith('wsl_'), 'write admission returns a wsl_ lease id');
  eq(writeA.lockKey, keyWrite, 'lease carries the lockKey');
  eq(writeA.generation, 1, 'first generation is 1');
  eq(writeA.mode, 'write', 'lease mode is write');
  eq(writeA.state, 'preparing', 'admission inserts a preparing lease');
  eq(writeA.runId, 'run_matrix_a', 'lease carries the run id');

  // write x write: enforce throws 409 WORKSPACE_LEASE_CONFLICT
  await rejects(
    () => acquireWorkspaceLease({
      lockKey: keyWrite,
      mode: 'write',
      workspaceId: 'ws_matrix_a',
      projectId: 'prj_matrix_b',
      runId: 'run_matrix_b',
    }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT'
      && error.statusCode === 409
      && error.mode === 'write'
      && error.projectId === 'prj_matrix_b'
      && error.runId === 'run_matrix_b'
      && error.lockKey === undefined,
    'a second writer must be rejected with WORKSPACE_LEASE_CONFLICT (409) without host details',
  );

  // write x write: shadow mode does not throw and records a conflict event
  const shadowConflict = await acquireWorkspaceLease({
    lockKey: keyWrite,
    mode: 'write',
    workspaceId: 'ws_matrix_a',
    projectId: 'prj_matrix_c',
    runId: 'run_matrix_c',
    shadow: true,
  });
  eq(shadowConflict.conflict, true, 'shadow mode reports conflict');
  eq(shadowConflict.mode, 'shadow', 'shadow conflict returns mode shadow');
  eq(shadowConflict.reason, 'writer-conflict', 'shadow conflict carries the reason');
  eq(shadowConflict.leaseId, undefined, 'shadow conflict carries no lease');

  // read x read allowed on a fresh key
  const keyRead = 'sha256:matrix-read';
  const read1 = await acquireWorkspaceLease({
    lockKey: keyRead,
    mode: 'read',
    workspaceId: 'ws_matrix_r',
    runId: 'run_read_1',
  });
  const read2 = await acquireWorkspaceLease({
    lockKey: keyRead,
    mode: 'read',
    workspaceId: 'ws_matrix_r',
    runId: 'run_read_2',
  });
  ok(read1.leaseId && read2.leaseId, 'two readers on the same lockKey are both admitted');
  eq(read2.generation, read1.generation + 1, 'each reader bumps the resource generation');

  // read meeting an existing write -> conflict
  await rejects(
    () => acquireWorkspaceLease({
      lockKey: keyWrite,
      mode: 'read',
      runId: 'run_read_vs_write',
    }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT' && error.reason === 'reader-writer-conflict',
    'a reader must be rejected while a writer holds the lockKey',
  );

  // preparing counts as occupying: no activation needed for the conflict above
  const activeNow = await listActiveLeases();
  ok(activeNow.some((lease) => lease.leaseId === writeA.leaseId), 'preparing lease shows up as active for recovery');
  ok(activeNow.some((lease) => lease.leaseId === read1.leaseId), 'read lease shows up as active');
  ok(activeNow.some((lease) => lease.leaseId === read2.leaseId), 'second read lease shows up as active');

  // same realpath, different workspaceId/projectId -> same lockKey conflict
  const sharedRoot = makeDir('ragent-lease-shared-root-');
  const project1 = await createProject({ name: 'Lease P1', rootPath: sharedRoot });
  const project2 = await createProject({ name: 'Lease P2', rootPath: sharedRoot });
  const sharedWorkspace = await ensureWorkspaceForRoot(sharedRoot);
  const keyShared = sharedWorkspace.physicalKey;
  const sharedA = await acquireWorkspaceLease({
    lockKey: keyShared,
    mode: 'write',
    workspaceId: sharedWorkspace.id,
    projectId: project1.id,
    runId: 'run_shared_1',
  });
  await rejects(
    () => acquireWorkspaceLease({
      lockKey: keyShared,
      mode: 'write',
      workspaceId: sharedWorkspace.id,
      projectId: project2.id,
      runId: 'run_shared_2',
    }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT' && error.projectId === project2.id,
    'two projects sharing one realpath must collide on the same lockKey',
  );
  // workspaceId-only resolution yields the same physicalKey
  const resolvedByWorkspace = await acquireWorkspaceLease({
    workspaceId: sharedWorkspace.id,
    mode: 'read',
    projectId: project2.id,
    runId: 'run_shared_3',
    shadow: true,
  });
  eq(resolvedByWorkspace.conflict, true, 'workspaceId-only resolution hits the same lockKey conflict');

  finishSection();

  // ── heartbeat conditional update ──────────────────────────────────────────
  beginSection('heartbeat');

  const keyHb = 'sha256:heartbeat';
  const hb = await acquireWorkspaceLease({
    lockKey: keyHb,
    mode: 'write',
    runId: 'run_hb',
  });
  const before = hb.expiresAt;
  const renewed = await renewLease(hb.leaseId, hb.generation, { ttlMs: 45000 });
  ok(renewed, 'renew with the current generation succeeds');
  ok(Date.parse(renewed.expiresAt) > Date.parse(before), 'renew advances expires_at');
  eq(renewed.leaseId, hb.leaseId, 'renew returns the same lease');

  const staleRenew = await renewLease(hb.leaseId, hb.generation + 1, { ttlMs: 45000 });
  eq(staleRenew, null, 'renew with a stale generation returns null');
  const afterStale = await findLeaseByRunId('run_hb');
  eq(afterStale.expiresAt, renewed.expiresAt, 'stale-generation renew does not overwrite the holder');

  await rejects(
    () => renewLease(hb.leaseId, hb.generation, { ttlMs: 10000, heartbeatMs: 10000 }),
    (error) => error.code === 'EINVAL' && error.statusCode === 400,
    'ttlMs below 3 * heartbeatMs must be rejected with EINVAL (400)',
  );

  finishSection();

  // ── TTL recovery matrix ───────────────────────────────────────────────────
  beginSection('recovery-ttl');

  const past = new Date(Date.now() - 60_000);
  const now = new Date();

  // expired + runtime alive -> renew, never reclaim
  const expAlive = await acquireWorkspaceLease({
    lockKey: 'sha256:recover-expired-alive',
    mode: 'write',
    runId: 'run_rec_alive',
    now: past,
  });
  ok(expAlive, 'expired lease seeded with a past acquisition time');
  const expiredList = await listExpiredLeases(now);
  ok(expiredList.some((lease) => lease.leaseId === expAlive.leaseId), 'expired lease appears in listExpiredLeases');
  const auditsAlive = await recoverLeases({ isRuntimeAlive: async () => 'alive', now });
  ok(auditsAlive.some((audit) => audit.leaseId === expAlive.leaseId && audit.action === 'renewed'),
    'expired + alive is renewed, not reclaimed');
  const afterAlive = await findLeaseByRunId('run_rec_alive');
  ok(['preparing', 'active'].includes(afterAlive.state), 'renewed lease stays occupying');
  ok(Date.parse(afterAlive.expiresAt) > Date.parse(expAlive.expiresAt), 'recovered lease gets a fresh expiry');

  // expired + runtime dead -> reclaim
  const expDead = await acquireWorkspaceLease({
    lockKey: 'sha256:recover-expired-dead',
    mode: 'write',
    runId: 'run_rec_dead',
    now: past,
  });
  const auditsDead = await recoverLeases({ isRuntimeAlive: async () => 'dead', now });
  ok(auditsDead.some((audit) => audit.leaseId === expDead.leaseId && audit.action === 'reclaimed'),
    'expired + dead is reclaimed');
  eq((await findLeaseByRunId('run_rec_dead')).state, 'reclaimed', 'reclaimed lease no longer occupies');

  // liveness unknown -> quarantine, which still blocks conflicting writers
  const expUnknown = await acquireWorkspaceLease({
    lockKey: 'sha256:recover-unknown',
    mode: 'write',
    runId: 'run_rec_unknown',
    now: past,
  });
  const auditsUnknown = await recoverLeases({ isRuntimeAlive: async () => 'unknown', now });
  ok(auditsUnknown.some((audit) => audit.leaseId === expUnknown.leaseId && audit.action === 'quarantined'),
    'unknown liveness quarantines the lease');
  eq((await findLeaseByRunId('run_rec_unknown')).state, 'quarantined', 'quarantine persists the state');
  await rejects(
    () => acquireWorkspaceLease({ lockKey: 'sha256:recover-unknown', mode: 'write', runId: 'run_rec_blocked' }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT',
    'a quarantined lease blocks a conflicting writer',
  );

  // not expired + alive -> reattach (renew + recovered event)
  const freshAlive = await acquireWorkspaceLease({
    lockKey: 'sha256:recover-fresh-alive',
    mode: 'write',
    runId: 'run_rec_fresh',
  });
  const auditsFresh = await recoverLeases({ isRuntimeAlive: async () => 'alive', now });
  ok(auditsFresh.some((audit) => audit.leaseId === freshAlive.leaseId && audit.action === 'reattached'),
    'live lease is reattached on recovery');
  ok(['preparing', 'active'].includes((await findLeaseByRunId('run_rec_fresh')).state),
    'reattached lease stays occupying');

  // not expired + dead -> reclaim
  const freshDead = await acquireWorkspaceLease({
    lockKey: 'sha256:recover-fresh-dead',
    mode: 'write',
    runId: 'run_rec_fresh_dead',
  });
  const auditsFreshDead = await recoverLeases({ isRuntimeAlive: async () => 'dead', now });
  ok(auditsFreshDead.some((audit) => audit.leaseId === freshDead.leaseId && audit.action === 'reclaimed'),
    'a live-lease with a dead runtime is reclaimed');

  // An admission crash before createRun leaves no runId. It must never be
  // quarantined indefinitely, even when liveness probing is unavailable.
  const untracked = await acquireWorkspaceLease({
    lockKey: 'sha256:recover-untracked',
    mode: 'write',
  });
  await activateLease(untracked.leaseId, untracked.generation, { now: past });
  const auditsUntracked = await recoverLeases({ isRuntimeAlive: async () => 'unknown', now });
  ok(auditsUntracked.some((audit) => audit.leaseId === untracked.leaseId && audit.action === 'reclaimed'),
    'an untracked pre-run lease is reclaimed instead of quarantined');
  const replacement = await acquireWorkspaceLease({
    lockKey: 'sha256:recover-untracked',
    mode: 'write',
    runId: 'run_rec_untracked_replacement',
  });
  ok(replacement.leaseId, 'reclaimed untracked lease frees the workspace for the next run');

  const eventTypes = new Set(leaseEvents().map((event) => event.type));
  for (const type of ['workspace_lease_acquired', 'workspace_lease_conflict', 'workspace_lease_recovered',
    'workspace_lease_reclaimed', 'workspace_lease_quarantined']) {
    ok(eventTypes.has(type), `audit event ${type} was recorded`);
  }

  finishSection();

  // ── activation ────────────────────────────────────────────────────────────
  beginSection('activation');

  const keyAct = 'sha256:activation';
  const act = await acquireWorkspaceLease({
    lockKey: keyAct,
    mode: 'write',
    runId: 'run_activation',
  });
  eq(act.state, 'preparing', 'lease starts preparing');
  await rejects(
    () => acquireWorkspaceLease({ lockKey: keyAct, mode: 'write', runId: 'run_activation_blocked' }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT',
    'preparing leases count as occupying for admission',
  );
  const activated = await activateLease(act.leaseId, act.generation, { executionScopeDigest: 'sha256:digest-1' });
  eq(activated.state, 'active', 'activation switches the lease to active');
  eq(activated.executionScopeDigest, 'sha256:digest-1', 'activation writes back the executionScopeDigest');
  ok(Date.parse(activated.expiresAt) > Date.parse(activated.heartbeatAt),
    'activation refreshes the lease expiry instead of expiring it immediately');
  const wrongGenActivate = await activateLease(act.leaseId, act.generation + 1, { executionScopeDigest: 'x' });
  eq(wrongGenActivate, null, 'activation with a stale generation returns null');
  await rejects(
    () => acquireWorkspaceLease({ lockKey: keyAct, mode: 'write', runId: 'run_activation_blocked_2' }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT',
    'active leases still count as occupying for admission',
  );
  ok(eventCount(leaseEvents(), 'workspace_lease_active') >= 1, 'workspace_lease_active event recorded');

  finishSection();

  // ── release / runtime-terminal ────────────────────────────────────────────
  beginSection('release-terminal');

  const keyRel = 'sha256:release';
  const rel = await acquireWorkspaceLease({ lockKey: keyRel, mode: 'write', runId: 'run_release' });
  await activateLease(rel.leaseId, rel.generation, { executionScopeDigest: 'sha256:digest-release' });
  const terminal = await markRuntimeTerminal(rel.leaseId, rel.generation);
  ok(terminal.runtimeTerminalAt, 'markRuntimeTerminal records runtime_terminal_at');
  eq(terminal.state, 'active', 'runtime terminal keeps the lease active until release');
  const staleRelease = await releaseLease(rel.leaseId, rel.generation + 1, { reason: 'run-terminal' });
  eq(staleRelease, null, 'a stale generation cannot release the lease');
  const released = await releaseLease(rel.leaseId, rel.generation, { reason: 'run-terminal' });
  eq(released.state, 'released', 'release moves the lease to released');
  ok(released.releasedAt, 'release records released_at');
  const afterRelease = await acquireWorkspaceLease({ lockKey: keyRel, mode: 'write', runId: 'run_release_next' });
  ok(afterRelease.leaseId, 'a released lease frees the lockKey for the next writer');
  eq(afterRelease.generation, rel.generation + 1, 'the next writer bumps the generation');
  ok(eventCount(leaseEvents(), 'workspace_lease_released') >= 1, 'workspace_lease_released event recorded');

  const keyRec = 'sha256:reclaim';
  const rec = await acquireWorkspaceLease({ lockKey: keyRec, mode: 'write', runId: 'run_reclaim' });
  const reclaimed = await reclaimLease(rec.leaseId, rec.generation, { reason: 'runtime-dead' });
  eq(reclaimed.state, 'reclaimed', 'reclaim moves the lease to reclaimed');
  ok(eventCount(leaseEvents(), 'workspace_lease_reclaimed') >= 1, 'workspace_lease_reclaimed event recorded');

  const keyQuar = 'sha256:quarantine';
  const quar = await acquireWorkspaceLease({ lockKey: keyQuar, mode: 'write', runId: 'run_quarantine' });
  const quarantined = await quarantineLease(quar.leaseId, { reason: 'liveness-unknown' });
  eq(quarantined.state, 'quarantined', 'quarantine moves the lease to quarantined');
  ok(eventCount(leaseEvents(), 'workspace_lease_quarantined') >= 1, 'workspace_lease_quarantined event recorded');

  finishSection();

  // ── cross-process admission on the same lockKey ───────────────────────────
  beginSection('cross-process-race');

  const moduleUrl = pathToFileURL(join(repoRoot, 'chat/workspace-leases.mjs')).href;
  const childScript = `
    (async () => {
      const mod = await import(${JSON.stringify(moduleUrl)});
      try {
        const lease = await mod.acquireWorkspaceLease({
          lockKey: process.env.RAGENT_TEST_LOCK_KEY,
          mode: 'write',
          workspaceId: 'ws_race',
          projectId: 'prj_race',
          runId: process.env.RAGENT_TEST_RUN_ID,
        });
        if (lease && lease.leaseId) { console.log('OK'); process.exit(0); }
        console.log('UNEXPECTED_RESULT'); process.exit(3);
      } catch (error) {
        if (error && error.code === 'WORKSPACE_LEASE_CONFLICT') { console.log('CONFLICT'); process.exit(1); }
        console.error(error && error.stack ? error.stack : String(error));
        process.exit(2);
      }
    })();
  `;
  function spawnRacer(runId) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
        cwd: repoRoot,
        env: {
          ...process.env,
          RAGENT_CONFIG_DIR: configDir,
          RAGENT_TEST_LOCK_KEY: 'sha256:cross-process-race',
          RAGENT_TEST_RUN_ID: runId,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('close', (code) => resolve({ runId, code, stdout, stderr }));
    });
  }
  const raceResults = await Promise.all([spawnRacer('run_race_a'), spawnRacer('run_race_b')]);
  const winners = raceResults.filter((result) => result.code === 0 && result.stdout.includes('OK'));
  const losers = raceResults.filter((result) => result.code === 1 && result.stdout.includes('CONFLICT'));
  eq(raceResults.length, 2, 'two racer processes finished');
  eq(winners.length, 1, 'exactly one process wins the write admission');
  eq(losers.length, 1, 'exactly one process sees WORKSPACE_LEASE_CONFLICT');
  ok(raceResults.every((result) => result.code === 0 || result.code === 1), 'no racer crashed unexpectedly');

  finishSection();

  // ── legacy synthetic leases ───────────────────────────────────────────────
  beginSection('legacy-synthetic');

  const legacyRoot = makeDir('ragent-lease-legacy-root-');
  const activeRunId = 'run_legacy_active';
  const terminalRunId = 'run_legacy_terminal';
  const activeDir = join(configDir, 'chat-runs', activeRunId);
  const terminalDir = join(configDir, 'chat-runs', terminalRunId);
  mkdirSync(activeDir, { recursive: true });
  mkdirSync(terminalDir, { recursive: true });
  writeFileSync(join(activeDir, 'status.json'), JSON.stringify({
    id: activeRunId,
    sessionId: 'sess_legacy',
    state: 'accepted',
    runnerId: 'runner_legacy_test',
  }));
  writeFileSync(join(activeDir, 'manifest.json'), JSON.stringify({
    id: activeRunId,
    folder: legacyRoot,
    prompt: 'legacy run without executionScope',
  }));
  writeFileSync(join(terminalDir, 'status.json'), JSON.stringify({
    id: terminalRunId,
    sessionId: 'sess_legacy',
    state: 'completed',
    runnerId: 'runner_legacy_test',
  }));
  writeFileSync(join(terminalDir, 'manifest.json'), JSON.stringify({
    id: terminalRunId,
    folder: legacyRoot,
    prompt: 'terminal legacy run',
  }));

  // After the mutation-scoped lease redesign, legacy runs no longer hold a
  // write lease for their whole lifetime: ensureLegacySyntheticLeases is a
  // no-op and no synthetic lease exists for any legacy run (active or
  // terminal), even when the manifest has no executionScope.
  const synthetic = await ensureLegacySyntheticLeases();
  eq(synthetic.created.length, 0, 'no synthetic write lease is created for legacy runs');
  eq(synthetic.skipped.length, 0, 'no legacy runs are skipped (no-op)');
  eq(await findLeaseByRunId(activeRunId), null, 'an active legacy run holds no synthetic lease');
  eq(await findLeaseByRunId(terminalRunId), null, 'a terminal legacy run holds no synthetic lease');
  const again = await ensureLegacySyntheticLeases();
  eq(again.created.length, 0, 're-running the no-op still creates nothing');

  finishSection();

  // ── hard TTL (mutation-scoped leases) ─────────────────────────────────────
  beginSection('hard-ttl');

  const keyHard = 'sha256:hard-ttl';
  const hardLease = await acquireWorkspaceLease({
    lockKey: keyHard,
    mode: 'write',
    runId: 'run_hard_ttl',
    ttlMs: 5000,
    hardTtlMs: 10000,
    heartbeatMs: null,
  });
  ok(hardLease.hardExpiresAt, 'mutation lease records a hard expiry');
  const hardAt = Date.parse(hardLease.hardExpiresAt);
  const initialSoftAt = Date.parse(hardLease.expiresAt);
  ok(hardAt > initialSoftAt, 'hard expiry is later than the initial soft expiry');

  // renew slides the soft expiry forward but never past the hard cap
  const within = new Date(Date.parse(hardLease.heartbeatAt) + 4000);
  const renewedHard = await renewLease(hardLease.leaseId, hardLease.generation, { ttlMs: 5000, heartbeatMs: 1000, now: within });
  ok(renewedHard, 'renew succeeds within the hard window');
  ok(Date.parse(renewedHard.expiresAt) > initialSoftAt, 'renew advances the soft expiry');
  ok(Date.parse(renewedHard.expiresAt) <= hardAt, 'renew is capped by the hard expiry');

  // renewing past the hard cap clamps expires_at to the hard expiry
  const afterHard = new Date(hardAt + 1000);
  const clamped = await renewLease(hardLease.leaseId, hardLease.generation, { ttlMs: 5000, heartbeatMs: 1000, now: afterHard });
  ok(clamped && Date.parse(clamped.expiresAt) <= hardAt, 'renew never extends past the hard cap');

  // once expired, a new writer reclaims the abandoned mutation lease
  const expiredNow = new Date(hardAt + 2000);
  const replacementHard = await acquireWorkspaceLease({
    lockKey: keyHard,
    mode: 'write',
    runId: 'run_hard_ttl_replacement',
    ttlMs: 5000,
    hardTtlMs: 10000,
    heartbeatMs: null,
    now: expiredNow,
  });
  ok(replacementHard.leaseId, 'an expired hard-TTL lease is reclaimed for the next writer');

  // startup recovery reclaims every expired occupying lease
  const keyRecMut = 'sha256:recover-mutation';
  const recMut = await acquireWorkspaceLease({
    lockKey: keyRecMut,
    mode: 'write',
    runId: 'run_rec_mut',
    ttlMs: 5000,
    hardTtlMs: 10000,
    heartbeatMs: null,
    now: new Date(Date.now() - 60_000),
  });
  ok(recMut.leaseId, 'expired mutation lease seeded');
  const mutAudits = await recoverMutationLeases({ now: new Date() });
  ok(mutAudits.some((audit) => audit.leaseId === recMut.leaseId && audit.action === 'reclaimed'),
    'recoverMutationLeases reclaims the expired mutation lease');
  eq((await findLeaseByRunId('run_rec_mut')).state, 'reclaimed', 'reclaimed mutation lease no longer occupies');

  finishSection();

  // ── cleanup ───────────────────────────────────────────────────────────────
  await closeWorkspaceLeaseStore();

  console.log('test-workspace-leases: ok');
  console.log(`  total assertions: ${totalAssertions}`);
  for (const section of sections) {
    console.log(`  ${section.name}: ${section.count} assertions`);
  }
} finally {
  await closeWorkspaceLeaseStore().catch(() => {});
  rmSync(configDir, { recursive: true, force: true });
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
}
