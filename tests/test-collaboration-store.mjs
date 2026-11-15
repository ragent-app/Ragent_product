#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Redirect the SQLite store into a throwaway temp dir before importing config.
const configDir = mkdtempSync(join(tmpdir(), 'ragent-collab-store-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const store = await import('../chat/collaboration-store.mjs');
const { compileCollaborationPlan } = await import('../chat/collaboration-plan.mjs');
const { normalizeCollaborationPolicy } = await import('../chat/collaboration-policy.mjs');

function makePolicy(overrides = {}) {
  return normalizeCollaborationPolicy({ role: 'manager', canDelegate: true, ...overrides });
}

function makePlan(taskDefs, policy = makePolicy(), title = 'test plan') {
  return compileCollaborationPlan({ title, tasks: taskDefs }, policy);
}

async function createCollab({ rootSessionId, taskDefs, idempotencyKey = '', policy = makePolicy(), title = 'test plan' }) {
  const plan = makePlan(taskDefs, policy, title);
  return store.createCollaborationRecord({ rootSessionId, title, policy, plan, idempotencyKey });
}

async function testIdempotentCreate() {
  const taskDefs = [{ id: 'idem-a', objective: 'A', agentId: 'agent-1' }];
  const first = await createCollab({ rootSessionId: 'root-1', taskDefs, idempotencyKey: 'idem-1' });
  assert.ok(first.id, 'first create should return a record');

  const second = await createCollab({ rootSessionId: 'root-1', taskDefs, idempotencyKey: 'idem-1' });
  assert.equal(second.id, first.id, 'same root + same key must return the same record');
  assert.equal(second.tasks.length, 1, 'idempotent hit must not duplicate tasks');

  // Task ids are globally unique across the store, so a new collaboration
  // reusing the same plan must carry fresh task ids.
  const third = await createCollab({
    rootSessionId: 'root-2',
    taskDefs: [{ id: 'idem-a2', objective: 'A', agentId: 'agent-1' }],
    idempotencyKey: 'idem-1',
  });
  assert.notEqual(third.id, first.id, 'same key under a different root must be a new record');

  // Concurrent same-key creation must collapse to one record and never throw.
  const concTaskDefs = [{ id: 'idem-a3', objective: 'A', agentId: 'agent-1' }];
  const [c1, c2] = await Promise.all([
    createCollab({ rootSessionId: 'root-3', taskDefs: concTaskDefs, idempotencyKey: 'idem-conc' }),
    createCollab({ rootSessionId: 'root-3', taskDefs: concTaskDefs, idempotencyKey: 'idem-conc' }),
  ]);
  assert.equal(c1.id, c2.id, 'concurrent idempotent creates must resolve to the same record');
  const all = await store.listCollaborationRecords();
  assert.equal(all.filter((c) => c.rootSessionId === 'root-3').length, 1, 'concurrent idempotent creates must not double-insert');
  assert.equal((await store.listCollaborationRecords({ limit: 1 })).length, 1, 'bounded scans must not materialize the full collaboration table');
}

async function testConcurrentClaim() {
  const collab = await createCollab({ rootSessionId: 'root-claim', taskDefs: [{ id: 'claim-a', objective: 'A', agentId: 'agent-1' }] });
  await store.markReadyTasks(collab.id);

  const [c1, c2] = await Promise.all([
    store.claimTaskAttempt('claim-a', { sessionId: 's1', runId: 'run-1' }),
    store.claimTaskAttempt('claim-a', { sessionId: 's2', runId: 'run-2' }),
  ]);
  const winners = [c1, c2].filter(Boolean);
  assert.equal(winners.length, 1, 'exactly one concurrent claim must win');
  const winner = winners[0];
  assert.equal(winner.taskId, 'claim-a');
  assert.equal(winner.attemptNumber, 1);
  assert.equal(winner.state, 'running');
  assert.ok(winner.leaseUntil, 'winning attempt must carry a lease');

  const again = await store.claimTaskAttempt('claim-a', { sessionId: 's3', runId: 'run-3' });
  assert.equal(again, null, 'a running task must not be re-claimable');

  const after = await store.getCollaboration(collab.id);
  assert.equal(after.state, 'running', 'collaboration should transition to running on claim');
}

async function testDurableDispatchOutbox() {
  const collab = await createCollab({
    rootSessionId: 'root-outbox',
    taskDefs: [{ id: 'outbox-a', objective: 'deliver exactly once', agentId: 'agent-1' }],
  });
  await store.markReadyTasks(collab.id);
  const attempt = await store.claimTaskAttempt('outbox-a', { sessionId: 'session-outbox' });
  assert.ok(attempt, 'dispatching attempt should be claimed before child delivery');
  assert.equal(attempt.lifecyclePhase, 'dispatching');

  const first = await store.enqueueAttemptDispatch({
    collaborationId: collab.id,
    taskId: 'outbox-a',
    attemptId: attempt.id,
    sessionId: 'session-outbox',
    requestId: 'collaboration:outbox-a:attempt:1',
    prompt: 'do the work',
    options: { tool: 'codex' },
  });
  const duplicate = await store.enqueueAttemptDispatch({
    collaborationId: collab.id,
    taskId: 'outbox-a',
    attemptId: attempt.id,
    sessionId: 'session-outbox',
    requestId: 'different-request-must-not-replace-persisted-command',
    prompt: 'must not replace',
  });
  assert.equal(duplicate.id, first.id, 'outbox enqueue is idempotent per Attempt');
  assert.equal(duplicate.requestId, first.requestId, 'original delivery idempotency key remains immutable');

  const [claimed] = await store.claimPendingDispatchCommands({ collaborationId: collab.id });
  assert.ok(claimed?.claimToken, 'pending delivery must receive a fenced claim token');
  assert.ok(await store.deferAttemptDispatch(claimed.id, {
    claimToken: claimed.claimToken,
    reason: 'temporary control-plane failure',
    delayMs: 1,
  }), 'a failed delivery returns to the durable outbox instead of failing the task');
  const [reclaimed] = await store.claimPendingDispatchCommands({
    collaborationId: collab.id,
    now: new Date(Date.now() + 1000),
  });
  assert.equal(reclaimed.id, claimed.id, 'recovery retries the same durable command');
  assert.equal(reclaimed.requestId, first.requestId, 'recovery retains the exact child request id');
  const rejected = await store.completeAttemptDispatch(claimed.id, {
    claimToken: 'stale-claim', runId: 'run-outbox',
  });
  assert.equal(rejected, null, 'a stale dispatcher cannot bind a Run');
  const bound = await store.completeAttemptDispatch(reclaimed.id, {
    claimToken: reclaimed.claimToken, runId: 'run-outbox',
  });
  assert.equal(bound.runId, 'run-outbox', 'delivery acknowledgement atomically binds the Run');
  assert.equal(bound.lifecyclePhase, 'queued', 'bound Run starts in capacity queue phase');
  const persisted = await store.getCollaboration(collab.id, { includeEvents: true });
  assert.equal(persisted.tasks.find((task) => task.id === 'outbox-a').runId, 'run-outbox');
  assert.ok(persisted.events.some((event) => event.type === 'attempt_dispatch_enqueued'));
  assert.ok(persisted.events.some((event) => event.type === 'attempt_queued'));
}

async function testSingleAggregationClaim() {
  const collab = await createCollab({
    rootSessionId: 'root-agg',
    taskDefs: [
      { id: 'agg-a', objective: 'A', agentId: 'agent-1' },
      { id: 'agg-b', objective: 'B', agentId: 'agent-2' },
      { id: 'agg-c', objective: 'C', agentId: 'agent-3' },
    ],
  });
  await store.markReadyTasks(collab.id);

  for (let i = 0; i < collab.tasks.length; i += 1) {
    const task = collab.tasks[i];
    const attempt = await store.claimTaskAttempt(task.id, { sessionId: `s-${i}`, runId: `run-agg-${i}` });
    assert.ok(attempt, `task ${task.id} should be claimable`);
    const done = await store.completeAttempt(attempt.id, { state: 'succeeded' });
    assert.ok(done, `task ${task.id} completion should be recorded`);
    // Simulate an orchestrator refreshing the barrier after every completion.
    await store.refreshBarrier(collab.id);
  }

  // Barrier already crossed: extra refreshes must not bump the generation again.
  await store.refreshBarrier(collab.id);
  await store.refreshBarrier(collab.id);

  const firstClaim = await store.claimAggregation(collab.id);
  assert.equal(firstClaim, 1, 'aggregation generation should be exactly 1');
  const secondClaim = await store.claimAggregation(collab.id);
  assert.equal(secondClaim, null, 'a second aggregation claim must be rejected');

  const withEvents = await store.getCollaboration(collab.id, { includeEvents: true });
  assert.equal(withEvents.events.filter((e) => e.type === 'aggregation_claimed').length, 1, 'exactly one aggregation_claimed audit event');
  assert.equal(withEvents.aggregationGeneration, 1);
  assert.equal(withEvents.aggregationClaimedGeneration, 1);
  assert.equal(withEvents.state, 'aggregating');
}

async function testRetryLeaseCancel() {
  const collab = await createCollab({
    rootSessionId: 'root-rlc',
    taskDefs: [{
      id: 'rlc-r',
      objective: 'R',
      agentId: 'agent-1',
      retry: { maxAttempts: 3, retryOn: ['transient'] },
    }],
  });
  await store.markReadyTasks(collab.id);

  // Attempt 1 fails transiently → task goes to retrying.
  const a1 = await store.claimTaskAttempt('rlc-r', { sessionId: 's1', runId: 'run-r1' });
  assert.ok(a1, 'first claim should succeed');
  assert.equal(a1.attemptNumber, 1);
  const done1 = await store.completeAttempt(a1.id, { state: 'failed', failureKind: 'transient', retry: true });
  assert.ok(done1, 'transient failure completion should be accepted');
  assert.equal((await store.getCollaboration(collab.id)).tasks.find((t) => t.id === 'rlc-r').state, 'retrying');

  // Retry claim → attempt 2 with a fresh lease.
  const a2 = await store.claimTaskAttempt('rlc-r', { sessionId: 's2', runId: 'run-r2' });
  assert.ok(a2, 'retrying task should be claimable');
  assert.equal(a2.attemptNumber, 2);
  assert.equal(a2.runId, 'run-r2');

  // Queue time and execution time are distinct.  A provider-neutral queued
  // Run must not consume the task execution deadline until the lifecycle
  // reports an actual runner start.
  const queued = await store.observeAttemptRun(a2.id, { runState: 'queued' });
  assert.equal(queued.lifecyclePhase, 'queued');
  assert.equal(queued.executionDeadline, '', 'a queued Run has no execution deadline yet');
  const runnerStartedAt = new Date().toISOString();
  const running = await store.observeAttemptRun(a2.id, { runState: 'accepted', runnerStartedAt });
  assert.equal(running.lifecyclePhase, 'running');
  assert.equal(running.runnerStartedAt, runnerStartedAt);
  assert.ok(running.executionDeadline, 'execution deadline starts only after runner startup');

  // Lease is not yet expired.
  const soon = new Date(Date.now() + 500);
  assert.equal(
    (await store.listExpiredAttempts(soon)).some((x) => x.id === a2.id),
    false,
    'an unexpired attempt must not be listed as expired',
  );

  // Heartbeat shortens the lease, so a slightly-future probe sees it expired.
  assert.ok(await store.heartbeatAttempt(a2.id, 500), 'heartbeat should succeed while running');
  const past = new Date(Date.now() + 2000);
  const expired = await store.listExpiredAttempts(past);
  assert.ok(expired.some((x) => x.id === a2.id), 'an expired attempt must be listed');
  assert.equal(expired.find((x) => x.id === a2.id).collaborationId, collab.id, 'expired attempt should expose its collaboration id');

  // An expired unknown outcome is not retryable under a transient-only policy.
  const expiredResult = await store.requeueExpiredAttempt(a2.id, {
    now: new Date(Date.now() + 2000),
    failureKind: 'unknown_outcome',
  });
  assert.equal(expiredResult.state, 'failed', 'expired attempts must become terminal failures');
  assert.equal(
    await store.completeAttempt(a2.id, { state: 'succeeded' }),
    null,
    'an expired attempt cannot be changed by an unverified completion',
  );
  const recovered = await store.completeAttempt(a2.id, { state: 'succeeded', allowRecovery: true });
  assert.ok(recovered, 'a verified late successful Run may repair its own expired generation');
  await store.refreshBarrier(collab.id);
  assert.equal((await store.getCollaboration(collab.id)).state, 'waiting_aggregation');
}

async function testManualRetryGate() {
  const collab = await createCollab({
    rootSessionId: 'root-manual-retry',
    taskDefs: [{
      id: 'manual-retry',
      objective: 'retry manually',
      agentId: 'agent-1',
      retry: { maxAttempts: 2, retryOn: ['transient'] },
    }],
  });
  await store.markReadyTasks(collab.id);
  const attempt = await store.claimTaskAttempt('manual-retry', { sessionId: 's1', runId: 'run-manual-1' });
  assert.ok(attempt);
  assert.ok(await store.completeAttempt(attempt.id, {
    state: 'failed',
    failureKind: 'transient',
    retry: false,
  }));
  await store.refreshBarrier(collab.id);
  assert.equal((await store.getCollaboration(collab.id)).state, 'failed');

  const retried = await store.retryFailedAttempt(attempt.id, { reason: 'owner requested retry' });
  assert.ok(retried, 'an allowed failed attempt should be manually retryable');
  assert.equal((await store.getCollaboration(collab.id)).state, 'ready');
  assert.equal((await store.getCollaboration(collab.id)).tasks[0].state, 'retrying');
  assert.equal(await store.retryFailedAttempt(attempt.id), null, 'the same failed attempt must not be retried twice');

  await store.markReadyTasks(collab.id);
  const next = await store.claimTaskAttempt('manual-retry', { sessionId: 's2', runId: 'run-manual-2' });
  assert.equal(next.attemptNumber, 2);
  assert.equal(await store.retryFailedAttempt(attempt.id), null, 'an old attempt must remain idempotently closed');

  const unknownCollab = await createCollab({
    rootSessionId: 'root-manual-unknown',
    taskDefs: [{
      id: 'manual-unknown',
      objective: 'do not retry unknown outcome',
      agentId: 'agent-1',
      retry: { maxAttempts: 2, retryOn: ['transient'] },
    }],
  });
  await store.markReadyTasks(unknownCollab.id);
  const unknownAttempt = await store.claimTaskAttempt('manual-unknown', { sessionId: 's1', runId: 'run-unknown-1' });
  await store.completeAttempt(unknownAttempt.id, { state: 'failed', failureKind: 'unknown_outcome', retry: false });
  assert.equal(await store.retryFailedAttempt(unknownAttempt.id), null, 'unknown outcome must follow the frozen retry policy');

  // Cancellation transitions a separate running collaboration exactly once.
  const cancelCollab = await createCollab({
    rootSessionId: 'root-cancel',
    taskDefs: [{ id: 'cancel-r', objective: 'cancel', agentId: 'agent-1' }],
  });
  await store.markReadyTasks(cancelCollab.id);
  const cancelAttempt = await store.claimTaskAttempt('cancel-r', { sessionId: 's1', runId: 'run-cancel' });
  assert.ok(cancelAttempt);
  assert.equal(await store.cancelCollaboration(cancelCollab.id), true, 'first cancel should apply');
  assert.equal(await store.cancelCollaboration(cancelCollab.id), false, 'second cancel should be a no-op');
  const cancelled = await store.getCollaboration(cancelCollab.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.tasks[0].state, 'cancelled');
  assert.equal(cancelled.attempts[0].state, 'cancelled');
}

async function testMultiTaskFailureRecovery() {
  const collab = await createCollab({
    rootSessionId: 'root-multi-recovery',
    taskDefs: [
      {
        id: 'multi-failed',
        objective: 'failed task',
        agentId: 'agent-1',
        retry: { maxAttempts: 2, retryOn: ['transient'] },
      },
      { id: 'multi-running', objective: 'independent task', agentId: 'agent-2' },
    ],
  });
  await store.markReadyTasks(collab.id);
  const failedAttempt = await store.claimTaskAttempt('multi-failed', { sessionId: 's1', runId: 'run-multi-failed-1' });
  const runningAttempt = await store.claimTaskAttempt('multi-running', { sessionId: 's2', runId: 'run-multi-running' });
  await store.completeAttempt(failedAttempt.id, { state: 'failed', failureKind: 'transient', retry: false });
  await store.refreshBarrier(collab.id);
  assert.equal((await store.getCollaboration(collab.id)).state, 'running', 'a sibling run keeps a failed collaboration active for reconciliation');
  await store.completeAttempt(runningAttempt.id, { state: 'succeeded' });
  await store.refreshBarrier(collab.id);
  assert.equal((await store.getCollaboration(collab.id)).state, 'failed');

  assert.ok(await store.retryFailedAttempt(failedAttempt.id));
  await store.markReadyTasks(collab.id);
  const retryAttempt = await store.claimTaskAttempt('multi-failed', { sessionId: 's3', runId: 'run-multi-failed-2' });
  await store.completeAttempt(retryAttempt.id, { state: 'succeeded' });
  await store.refreshBarrier(collab.id);
  const recovered = await store.getCollaboration(collab.id);
  assert.equal(recovered.state, 'waiting_aggregation', 'a successful manual retry should reopen the aggregation barrier');
  assert.equal(recovered.aggregationGeneration, 1);
}

async function testProjectIdBinding() {
  // New-style tasks carry a project binding; the binding is persisted on the
  // task row and inherited by attempts.
  const collab = await createCollab({
    rootSessionId: 'root-project',
    taskDefs: [{ id: 'project-bound', objective: 'bound', agentId: 'agent-1', projectId: 'prj_bound' }],
  });
  assert.equal(collab.tasks[0].projectId, 'prj_bound', 'task row exposes the project binding');
  await store.markReadyTasks(collab.id);
  const attempt = await store.claimTaskAttempt('project-bound', { sessionId: 's-p', runId: 'run-project-bound' });
  assert.ok(attempt, 'bound task is claimable');
  assert.equal(attempt.projectId, 'prj_bound', 'attempt inherits the project binding from its task');

  const done = await store.completeAttempt(attempt.id, {
    state: 'succeeded',
    resultPacketId: 'rsp_project_result',
    envelope: { resultPacketId: 'rsp_project_result' },
  });
  assert.ok(done, 'bound task completion is recorded');
  const after = await store.getCollaboration(collab.id);
  assert.equal(after.attempts[0].resultPacketId, 'rsp_project_result', 'attempt stores the ResultPacket reference');
  assert.equal(after.attempts[0].envelope.resultPacketId, 'rsp_project_result', 'envelope carries the ResultPacket reference');
}

async function testLegacyProjectIdCompat() {
  // Legacy tasks without a projectId keep working: rows expose '' and no
  // project binding is fabricated.
  const collab = await createCollab({
    rootSessionId: 'root-legacy-project',
    taskDefs: [{ id: 'legacy-task', objective: 'legacy', agentId: 'agent-1' }],
  });
  assert.equal(collab.tasks[0].projectId, '', 'legacy task keeps an empty projectId');
  await store.markReadyTasks(collab.id);
  const attempt = await store.claimTaskAttempt('legacy-task', { sessionId: 's-l', runId: 'run-legacy' });
  assert.ok(attempt);
  assert.equal(attempt.projectId, '', 'legacy attempt keeps an empty projectId');
  const legacyDone = await store.completeAttempt(attempt.id, { state: 'succeeded' });
  assert.ok(legacyDone?.attempt && legacyDone.attempt.state === 'succeeded', 'legacy completion works');
}

async function testProjectIdMigrationIdempotent() {
  // The additive schema migration is idempotent: repeated init keeps the
  // project_id columns and backfills legacy attempts from their tasks.
  const firstInit = await store.initializeCollaborationStore();
  const secondInit = await store.initializeCollaborationStore();
  assert.ok(firstInit && secondInit && firstInit === secondInit, 'store re-initializes idempotently');
  // Legacy attempt rows were backfilled from their tasks (none exist here, so
  // the update is a harmless no-op — the point is it never throws).
  const migrated = await createCollab({
    rootSessionId: 'root-migrated',
    taskDefs: [{ id: 'migrated-task', objective: 'migrated', agentId: 'agent-1', projectId: 'prj_migrated' }],
  });
  await store.markReadyTasks(migrated.id);
  const attempt = await store.claimTaskAttempt('migrated-task', { sessionId: 's-m', runId: 'run-migrated' });
  assert.equal(attempt.projectId, 'prj_migrated', 'post-migration claims still inherit the task binding');
}

async function testDependencyReady() {
  const collab = await createCollab({
    rootSessionId: 'root-dep',
    taskDefs: [
      { id: 'dep-a', objective: 'A', agentId: 'agent-1' },
      { id: 'dep-b', objective: 'B', agentId: 'agent-2', dependsOn: ['dep-a'] },
      { id: 'dep-c', objective: 'C', agentId: 'agent-3', dependsOn: ['dep-a', 'dep-b'] },
    ],
  });

  const stateOf = async (id) => (await store.getCollaboration(collab.id)).tasks.find((t) => t.id === id).state;

  // A planned-but-not-ready task must not be claimable.
  assert.equal(await store.claimTaskAttempt('dep-b', { sessionId: 's', runId: 'run-x' }), null, 'planned task must not be claimable before ready');

  const ready1 = await store.markReadyTasks(collab.id);
  assert.deepEqual(ready1, ['dep-a'], 'only dependency-free task becomes ready first');
  assert.equal(await stateOf('dep-a'), 'ready');
  assert.equal(await stateOf('dep-b'), 'planned');

  // Complete dep-a → dep-b becomes ready.
  const attemptA = await store.claimTaskAttempt('dep-a', { sessionId: 's', runId: 'run-a' });
  assert.ok(attemptA);
  assert.ok(await store.completeAttempt(attemptA.id, { state: 'succeeded' }));
  const ready2 = await store.markReadyTasks(collab.id);
  assert.deepEqual(ready2, ['dep-b'], 'dep-b becomes ready once dep-a succeeds');
  assert.equal(await stateOf('dep-c'), 'planned');

  // Complete dep-b → dep-c becomes ready.
  const attemptB = await store.claimTaskAttempt('dep-b', { sessionId: 's', runId: 'run-b' });
  assert.ok(attemptB);
  assert.ok(await store.completeAttempt(attemptB.id, { state: 'succeeded' }));
  const ready3 = await store.markReadyTasks(collab.id);
  assert.deepEqual(ready3, ['dep-c'], 'dep-c becomes ready once both deps succeed');
}

async function testCollaborationEventTailIsBounded() {
  const collab = await createCollab({
    rootSessionId: 'root-event-tail',
    taskDefs: [{ id: 'event-tail-task', objective: 'tail', agentId: 'agent-1' }],
  });
  const db = store.openDatabase();
  const insert = db.prepare(`INSERT INTO collaboration_events
    (collaboration_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)`);
  for (let index = 0; index < 400; index += 1) {
    insert.run(collab.id, `synthetic_${index}`, JSON.stringify({ index }), new Date().toISOString());
  }
  db.close();
  const projected = await store.getCollaboration(collab.id, { includeEvents: true });
  assert.equal(projected.events.length, 256, 'collaboration details retain a bounded event tail');
  assert.equal(projected.events[0].type, 'synthetic_144', 'bounded tail starts at the newest event window');
  assert.equal(projected.events.at(-1).type, 'synthetic_399', 'bounded tail retains the newest event');
}

try {
  await store.initializeCollaborationStore();
await testIdempotentCreate();
await testConcurrentClaim();
await testDurableDispatchOutbox();
await testSingleAggregationClaim();
  await testRetryLeaseCancel();
  await testManualRetryGate();
  await testMultiTaskFailureRecovery();
  await testDependencyReady();
  await testProjectIdBinding();
  await testLegacyProjectIdCompat();
  await testProjectIdMigrationIdempotent();
  await testCollaborationEventTailIsBounded();
  console.log('test-collaboration-store: ok');
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
