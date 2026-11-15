#!/usr/bin/env node
/**
 * DS-07: sessionRuntimeState / timelineInvalidationGeneration lifecycle.
 *
 * Proves:
 *   1. Idle runtime state + generation entries are released (idle TTL +
 *      explicit releaseSessionRuntimeState).
 *   2. Release is blocked while there is an active run, a pending send
 *      (queued follow-up, planning queue, in-flight flush promise) or a
 *      pending approval — and unblocked once the run is terminal.
 *   3. Direct deletion forcibly releases runtime state, including stale
 *      pending queues that would otherwise block normal idle release.
 *   4. Restart recovery: nothing durable lives in runtime state — released
 *      sessions re-create it lazily, and pending queues survive release.
 *   5. No duplicate release: concurrent releases serialize via the in-flight
 *      set; exactly one call cleans up.
 *   6. The unref'd periodic sweep enforces the TTL end-to-end and also
 *      retires generation-only entries.
 *   7. Registry gauges (session.runtime, timeline.generation) stay
 *      JSON-serializable and mirror the maps.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ragent-session-runtime-'));
process.env.HOME = tempHome;
process.env.RAGENT_PUBLIC_BASE_URL = '';
process.env.RAGENT_SESSION_RUNTIME_TTL_MS = '';
process.env.RAGENT_SESSION_RUNTIME_SWEEP_MS = '';

await fs.mkdir(path.join(tempHome, '.config', 'ragent'), { recursive: true });
await fs.writeFile(
  path.join(tempHome, '.config', 'ragent', 'tools.json'),
  `${JSON.stringify([
    {
      id: 'codex',
      name: 'Codex',
      command: 'codex',
      runtimeFamily: 'codex-json',
      promptMode: 'bare-user',
      flattenPrompt: true,
      models: [{ id: 'gpt-5.4', label: 'gpt-5.4' }],
      reasoning: { kind: 'none', label: 'Thinking' },
    },
  ], null, 2)}\n`,
  'utf8',
);

const {
  ensureSessionRuntimeState,
  releaseSessionRuntimeState,
  startSessionRuntimeStateSweep,
  stopSessionRuntimeStateSweep,
  createSession,
  deleteSession,
  renameSession,
  __getSessionRuntimeSnapshot,
  __getSessionRuntimeState,
} = await import('../chat/session-manager.mjs');
const { mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
const { createRun, updateRun, createRunId } = await import('../chat/runs.mjs');
const { getRegisteredCacheNames, collectCacheMetrics } = await import('../chat/memory-registry.mjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 8000, intervalMs = 25) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

async function createTestSession() {
  const session = await createSession('', 'codex', `runtime-test-${createRunId()}`);
  assert.ok(session?.id, 'createSession returns a session with id');
  return session.id;
}

async function makeIdleRuntimeState(sessionId) {
  ensureSessionRuntimeState(sessionId);
  const state = __getSessionRuntimeState(sessionId);
  assert.ok(state, 'runtime state exists after ensure');
  state.lastActivityAt = 0; // force the entry past any TTL
  return state;
}

// --- 1. idle release -------------------------------------------------------
{
  const sessionId = await createTestSession();
  await makeIdleRuntimeState(sessionId);
  await renameSession(sessionId, 'renamed'); // broadcast -> generation entry
  assert.equal(__getSessionRuntimeSnapshot().generationEntries, 1, 'generation entry written by invalidation');

  const result = await releaseSessionRuntimeState(sessionId);
  assert.deepEqual(result, { released: true, reason: 'idle' }, 'idle session releases');
  const snapshot = __getSessionRuntimeSnapshot();
  assert.ok(!snapshot.sessionIds.includes(sessionId), 'runtime entry removed');
  assert.equal(snapshot.generationEntries, 0, 'generation entry removed with the runtime state');
  assert.equal(__getSessionRuntimeState(sessionId), null, 'state gone');
  console.log('test-session-runtime-release: idle release ok');
}

// --- 2. active run protection + terminal run release -----------------------
{
  const sessionId = await createTestSession();
  await makeIdleRuntimeState(sessionId);
  const run = await createRun({
    status: { sessionId, requestId: 'run-1', responseId: 'resp-1', state: 'running' },
  });
  await mutateSessionMeta(sessionId, (draft) => {
    draft.activeRunId = run.id;
    return true;
  });

  const blocked = await releaseSessionRuntimeState(sessionId);
  assert.equal(blocked.released, false, 'active run blocks release');
  assert.equal(blocked.reason, 'active-run', 'reason is active-run');

  await updateRun(run.id, (draft) => ({ ...draft, state: 'completed' }));
  const after = await releaseSessionRuntimeState(sessionId);
  assert.deepEqual(after, { released: true, reason: 'idle' }, 'terminal run no longer blocks release');
  assert.equal(__getSessionRuntimeState(sessionId), null, 'released after terminal run');
  console.log('test-session-runtime-release: active-run / terminal-run guard ok');
}

// --- 3. pending approval protection ----------------------------------------
{
  const sessionId = await createTestSession();
  await makeIdleRuntimeState(sessionId);
  const run = await createRun({
    status: { sessionId, requestId: 'run-2', responseId: 'resp-2', state: 'running' },
  });
  // appServerPendingApprovals is a sidecar-written field (not part of
  // createRunRecord); mergeRunRecords passes unknown fields through.
  await updateRun(run.id, { appServerPendingApprovals: [{ approvalId: 'approval-1', kind: 'tool' }] });
  await mutateSessionMeta(sessionId, (draft) => {
    draft.activeRunId = run.id;
    return true;
  });
  const blocked = await releaseSessionRuntimeState(sessionId);
  assert.equal(blocked.released, false, 'pending approval blocks release');
  assert.equal(blocked.reason, 'pending-approval', 'reason is pending-approval');
  await updateRun(run.id, (draft) => ({ ...draft, state: 'completed' }));
  const released = await releaseSessionRuntimeState(sessionId);
  assert.deepEqual(released, { released: true, reason: 'idle' }, 'stale approvals cannot keep a completed run active');
  console.log('test-session-runtime-release: pending-approval guard ok');
}

{
  const sessionId = await createTestSession();
  await makeIdleRuntimeState(sessionId);
  const run = await createRun({ status: { sessionId, requestId: 'responded', state: 'running' } });
  await updateRun(run.id, { appServerPendingApprovals: [{ approvalId: 'done', state: 'responded' }] });
  await mutateSessionMeta(sessionId, draft => { draft.activeRunId = run.id; return true; });
  const blocked = await releaseSessionRuntimeState(sessionId);
  assert.equal(blocked.reason, 'active-run', 'responded approval is not a pending approval');
}

// --- 4. pending send protection (queues, timers, in-flight promises) -------
{
  const queueSession = await createTestSession();
  await makeIdleRuntimeState(queueSession);
  await mutateSessionMeta(queueSession, (draft) => {
    draft.followUpQueue = [{ requestId: 'q-1', text: 'hello' }];
    return true;
  });
  const queueBlocked = await releaseSessionRuntimeState(queueSession);
  assert.equal(queueBlocked.reason, 'pending-send', 'queued follow-up blocks release');

  const planSession = await createTestSession();
  await makeIdleRuntimeState(planSession);
  await mutateSessionMeta(planSession, (draft) => {
    draft.pendingPlanningQueue = [{ requestId: 'p-1', text: 'plan it' }];
    return true;
  });
  const planBlocked = await releaseSessionRuntimeState(planSession);
  assert.equal(planBlocked.reason, 'pending-send', 'planning queue blocks release');

  const promiseSession = await createTestSession();
  const promiseState = await makeIdleRuntimeState(promiseSession);
  promiseState.followUpFlushPromise = Promise.resolve();
  const promiseBlocked = await releaseSessionRuntimeState(promiseSession);
  assert.equal(promiseBlocked.reason, 'pending-send', 'in-flight flush promise blocks release');
  delete promiseState.followUpFlushPromise;
  const promiseAfter = await releaseSessionRuntimeState(promiseSession);
  assert.equal(promiseAfter.released, true, 'released once the flush promise settled');

  const timerSession = await createTestSession();
  const timerState = await makeIdleRuntimeState(timerSession);
  timerState.followUpFlushTimer = setTimeout(() => {}, 60_000);
  const timerBlocked = await releaseSessionRuntimeState(timerSession);
  assert.equal(timerBlocked.reason, 'pending-send', 'pending flush timer blocks release');
  clearTimeout(timerState.followUpFlushTimer);
  delete timerState.followUpFlushTimer;
  console.log('test-session-runtime-release: pending-send guards ok');
}

// --- 5. pending compact protection ------------------------------------------
{
  const sessionId = await createTestSession();
  const state = await makeIdleRuntimeState(sessionId);
  state.pendingCompact = true;
  const blocked = await releaseSessionRuntimeState(sessionId);
  assert.equal(blocked.released, false, 'pending compaction blocks release');
  assert.equal(blocked.reason, 'pending-compact', 'reason is pending-compact');
  delete state.pendingCompact;
  const after = await releaseSessionRuntimeState(sessionId);
  assert.equal(after.released, true, 'released after compaction completes');
  console.log('test-session-runtime-release: pending-compact guard ok');
}

// --- 6. direct deletion releases runtime state -------------------------------
{
  const deleted = await createTestSession();
  await makeIdleRuntimeState(deleted);
  await deleteSession(deleted);
  assert.equal(__getSessionRuntimeState(deleted), null, 'direct deletion releases an idle session state');

  // Deletion is intentionally stronger than normal idle release: a stale
  // queue must not keep deleted session runtime state resident forever.
  const deletedQueued = await createTestSession();
  await makeIdleRuntimeState(deletedQueued);
  await mutateSessionMeta(deletedQueued, (draft) => {
    draft.followUpQueue = [{ requestId: 'q-stale', text: 'never flushes' }];
    return true;
  });
  await deleteSession(deletedQueued);
  assert.equal(__getSessionRuntimeState(deletedQueued), null, 'direct deletion releases a queued session state');

  // Deleted / never-persisted sessions release too (meta read yields null).
  const ghost = 'ghost-session-no-meta';
  await makeIdleRuntimeState(ghost);
  const ghostResult = await releaseSessionRuntimeState(ghost);
  assert.equal(ghostResult.released, true, 'session without meta releases');
  console.log('test-session-runtime-release: direct deletion release ok');
}

// --- 7. restart recovery: durable queues survive, state re-creates lazily --
{
  const sessionId = await createTestSession();
  await makeIdleRuntimeState(sessionId);
  await mutateSessionMeta(sessionId, (draft) => {
    draft.followUpQueue = [{ requestId: 'q-recovery', text: 'pending after restart' }];
    return true;
  });
  const blocked = await releaseSessionRuntimeState(sessionId);
  assert.equal(blocked.reason, 'pending-send', 'pending send survives a restart-style release attempt');

  // Simulate restart: the process forgets runtime state entirely; boot
  // observers re-create flush schedules from durable meta. At the module
  // level this is the lazy re-creation of ensureSessionRuntimeState.
  await mutateSessionMeta(sessionId, (draft) => {
    draft.followUpQueue = [];
    return true;
  });
  const released = await releaseSessionRuntimeState(sessionId);
  assert.equal(released.released, true, 'queue drained -> release allowed');

  const fresh = ensureSessionRuntimeState(sessionId);
  assert.ok(fresh, 'runtime state re-created lazily');
  assert.ok(fresh.lastActivityAt > 0, 're-created state is fresh');
  console.log('test-session-runtime-release: restart recovery ok');
}

// --- 8. no duplicate release ------------------------------------------------
{
  const sessionId = await createTestSession();
  await makeIdleRuntimeState(sessionId);
  const [a, b] = await Promise.all([
    releaseSessionRuntimeState(sessionId),
    releaseSessionRuntimeState(sessionId),
  ]);
  const releasedCount = [a, b].filter((r) => r.released === true).length;
  assert.equal(releasedCount, 1, 'exactly one of the concurrent releases wins');
  assert.equal(__getSessionRuntimeState(sessionId), null, 'entry deleted once');
  const again = await releaseSessionRuntimeState(sessionId);
  assert.equal(again.reason, 'absent', 'later release is a no-op');
  console.log('test-session-runtime-release: duplicate-release race ok');
}

// --- 9. force release -------------------------------------------------------
{
  const sessionId = await createTestSession();
  const state = ensureSessionRuntimeState(sessionId);
  state.followUpFlushPromise = Promise.resolve(); // would block a normal release
  const forced = await releaseSessionRuntimeState(sessionId, { force: true });
  assert.deepEqual(forced, { released: true, reason: 'force' }, 'force skips every guard');
  assert.equal(__getSessionRuntimeState(sessionId), null, 'forced entry gone');
  console.log('test-session-runtime-release: force release ok');
}

// --- 10. idle TTL sweep (end-to-end, unref'd interval) ----------------------
{
  process.env.RAGENT_SESSION_RUNTIME_TTL_MS = '200';
  process.env.RAGENT_SESSION_RUNTIME_SWEEP_MS = '40';

  const freshSession = await createTestSession();
  ensureSessionRuntimeState(freshSession);
  const staleSession = await createTestSession();
  await makeIdleRuntimeState(staleSession); // backdated to 0 -> stale at once

  const timer = startSessionRuntimeStateSweep();
  assert.ok(timer, 'sweep timer started');

  // Generation-only entry: rename broadcasts an invalidation but never
  // creates runtime state, so only the generation map gets an entry.
  const genOnlySession = await createTestSession();
  await renameSession(genOnlySession, 'gen-only');
  assert.equal(__getSessionRuntimeSnapshot().generationEntries, 1, 'generation-only entry present');

  // Stamp freshness only now: the async setup above (two more sessions +
  // rename) takes variable time, so a stamp made before it could already be
  // past the TTL when the observation window opens.
  ensureSessionRuntimeState(freshSession).lastActivityAt = Date.now();

  await sleep(60); // one or two sweep ticks, still inside the TTL
  assert.ok(__getSessionRuntimeState(freshSession), 'entry younger than TTL survives a tick');
  // The first tick can be delayed by in-flight async work, so wait for it.
  await waitFor(() => __getSessionRuntimeState(staleSession) === null, 'stale entry swept on the first ticks', 2000);

  await waitFor(() => __getSessionRuntimeState(freshSession) === null, 'fresh entry swept after TTL elapses', 4000);
  await waitFor(() => __getSessionRuntimeSnapshot().generationEntries === 0, 'generation-only entry swept', 4000);
  assert.equal(stopSessionRuntimeStateSweep(), true, 'sweep stops cleanly');

  process.env.RAGENT_SESSION_RUNTIME_TTL_MS = '';
  process.env.RAGENT_SESSION_RUNTIME_SWEEP_MS = '';
  console.log('test-session-runtime-release: idle TTL sweep ok');
}

// --- 11. registry gauges -----------------------------------------------------
{
  const names = getRegisteredCacheNames();
  assert.ok(names.includes('session.runtime'), 'session.runtime registered');
  assert.ok(names.includes('timeline.generation'), 'timeline.generation registered');

  const sessionId = await createTestSession();
  ensureSessionRuntimeState(sessionId);
  const metrics = collectCacheMetrics();
  const runtime = metrics.find((entry) => entry.name === 'session.runtime');
  const generation = metrics.find((entry) => entry.name === 'timeline.generation');
  assert.ok(runtime && runtime.entries >= 1, 'session.runtime reflects live entries');
  assert.ok(typeof runtime.stale === 'number', 'session.runtime exposes stale count');
  assert.equal(typeof JSON.stringify(metrics), 'string', 'registry snapshot is JSON-serializable');
  assert.ok(!JSON.stringify(metrics).includes(sessionId), 'registry never leaks session ids');
  assert.ok(generation && typeof generation.entries === 'number', 'timeline.generation registered and countable');
  console.log('test-session-runtime-release: registry gauges ok');
}

console.log('test-session-runtime-release: ok');
