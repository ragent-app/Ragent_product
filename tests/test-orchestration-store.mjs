#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-orchestration-store-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const store = await import('../chat/orchestration-store.mjs');

try {
  const execution = await store.ensureExecution({
    scopeKind: 'collaboration',
    scopeId: 'collab-ledger-1',
    rootSessionId: 'root-ledger-1',
    kind: 'collaboration',
    state: 'ready',
    specRevision: 1,
    specDigest: 'sha256:test',
    spec: { title: 'durable work' },
  });
  const replay = await store.ensureExecution({
    scopeKind: 'collaboration',
    scopeId: 'collab-ledger-1',
    rootSessionId: 'root-ledger-1',
    kind: 'collaboration',
    state: 'ready',
  });
  assert.equal(replay.id, execution.id, 'scope identity must be idempotent');

  const synchronized = await store.syncExecutionSpec(execution.id, {
    specRevision: 2,
    specDigest: 'sha256:test-v2',
    spec: { title: 'durable work v2' },
  });
  assert.equal(synchronized.specRevision, 2);
  assert.equal(synchronized.spec.title, 'durable work v2');
  await assert.rejects(
    () => store.syncExecutionSpec(execution.id, {
      specRevision: 2,
      specDigest: 'sha256:conflicting-v2',
      spec: { title: 'ambiguous rewrite' },
    }),
    (error) => error?.code === 'ORCHESTRATION_CONFLICT',
    'same-revision spec rewrites must not silently replace an authoritative plan',
  );
  const legacy = await store.ensureExecution({
    scopeKind: 'legacy',
    scopeId: 'legacy-empty-digest',
    rootSessionId: 'root-ledger-1',
    kind: 'legacy',
    specRevision: 1,
    spec: { title: 'legacy row' },
  });
  const filledLegacy = await store.syncExecutionSpec(legacy.id, {
    specRevision: 1,
    specDigest: 'sha256:legacy-filled',
    spec: { title: 'legacy row' },
  });
  assert.equal(filledLegacy.specDigest, 'sha256:legacy-filled', 'old rows without a digest must be upgradeable in place');

  const validation = await store.createValidation({
    rootSessionId: 'root-ledger-1',
    kind: 'collaboration_plan',
    payload: { rootSessionId: 'root-ledger-1', title: 'validated', plan: { tasks: [] } },
  });
  assert.match(validation.payloadDigest, /^sha256:/);
  const validationClaim = await store.claimValidationForDispatch(validation.validationId, {
    rootSessionId: 'root-ledger-1', kind: 'collaboration_plan',
  });
  assert.equal(validationClaim.payload.title, 'validated');
  assert.equal(await store.claimValidationForDispatch(validation.validationId, {
    rootSessionId: 'other-root', kind: 'collaboration_plan',
  }), null, 'validation may not be replayed by another root Session');

  const checkpointed = await store.checkpointExecution(execution.id, {
    state: 'running', checkpoint: { stage: 'dispatch', taskId: 'task-1' }, heartbeat: true,
  });
  assert.equal(checkpointed.state, 'running');
  assert.equal(checkpointed.checkpoint.stage, 'dispatch');
  const unchangedCheckpoint = await store.checkpointExecution(execution.id, {
    state: 'running', checkpoint: { stage: 'dispatch', taskId: 'task-1' },
  });
  assert.equal(unchangedCheckpoint.version, checkpointed.version, 'an unchanged observation must not create a write/event storm');
  await assert.rejects(
    () => store.checkpointExecution(execution.id, { expectedVersion: 1, checkpoint: { stale: true } }),
    (error) => error?.code === 'ORCHESTRATION_CONFLICT',
    'checkpoint writes must be version fenced',
  );

  const step = await store.ensureStep({
    executionId: execution.id,
    stableKey: 'task:task-1:attempt:1',
    kind: 'harness.dispatch',
    input: { requestId: 'request-1' },
  });
  assert.equal((await store.ensureStep({
    executionId: execution.id,
    stableKey: 'task:task-1:attempt:1',
    kind: 'harness.dispatch',
  })).id, step.id, 'step keys must be idempotent');

  const command = await store.enqueueCommand({
    executionId: execution.id,
    stepId: step.id,
    kind: 'harness.dispatch',
    idempotencyKey: 'collaboration:task-1:attempt:1',
    payload: { sessionId: 'child-1' },
  });
  assert.equal((await store.enqueueCommand({
    executionId: execution.id,
    stepId: step.id,
    kind: 'harness.dispatch',
    idempotencyKey: 'collaboration:task-1:attempt:1',
  })).id, command.id, 'command keys must be idempotent');
  const observedCommand = await store.enqueueCommand({
    executionId: execution.id,
    stepId: step.id,
    kind: 'harness.dispatch',
    idempotencyKey: 'collaboration:task-1:attempt:observed',
    payload: { sessionId: 'child-observed' },
  });
  assert.equal((await store.observeCommandState(observedCommand.id, {
    state: 'completed',
    externalEffectId: 'run-observed',
  })).state, 'completed', 'domain-owned completion may be projected without a generic claim');
  const [claimed] = await store.claimDueCommands();
  assert.equal(claimed.id, command.id);
  assert.ok(claimed.claimToken, 'claimed command has a fence token');
  assert.equal(await store.deferCommand(command.id, { claimToken: 'stale-token' }), null, 'stale delivery cannot defer a command');
  assert.equal((await store.deferCommand(command.id, {
    claimToken: claimed.claimToken,
    failureKind: 'admission_unavailable',
    failureReason: 'temporary outage',
    retryDelayMs: 1,
  })).state, 'deferred');
  const [reclaimed] = await store.claimDueCommands({ now: new Date(Date.now() + 1000) });
  assert.equal(reclaimed.id, command.id, 'deferred command replays as the same command');
  assert.equal((await store.acknowledgeCommand(command.id, {
    claimToken: reclaimed.claimToken,
    externalEffectId: 'run-1',
  })).state, 'acknowledged');
  assert.equal((await store.completeCommand(command.id, {
    claimToken: reclaimed.claimToken,
    externalEffectId: 'run-1',
  })).state, 'completed', 'acknowledged external effects retain their fence until completion');
  const crashCommand = await store.enqueueCommand({
    executionId: execution.id,
    stepId: step.id,
    kind: 'harness.dispatch',
    idempotencyKey: 'collaboration:task-1:attempt:crash-recovery',
  });
  const [crashClaim] = await store.claimDueCommands({ leaseMs: 1 });
  assert.equal(crashClaim.id, crashCommand.id);
  const [recoveredClaim] = await store.claimDueCommands({
    now: new Date(Date.now() + 2_000),
    leaseMs: 1,
  });
  assert.equal(recoveredClaim.id, crashCommand.id, 'an abandoned lease must become claimable after a control-plane crash');
  assert.notEqual(recoveredClaim.claimToken, crashClaim.claimToken);
  await store.deadLetterCommand(crashCommand.id, { claimToken: recoveredClaim.claimToken, failureReason: 'test cleanup' });

  const interrupt = await store.openInterrupt({
    executionId: execution.id,
    stableKey: 'approval:batch-1',
    kind: 'approval',
    payload: { summary: 'Approve deploy?' },
  });
  assert.equal((await store.getExecution(execution.id)).state, 'waiting_input');
  assert.equal((await store.openInterrupt({
    executionId: execution.id,
    stableKey: 'approval:batch-1',
    kind: 'approval',
  })).id, interrupt.id, 'open interrupt is idempotent until resolved');
  assert.equal(await store.resolveInterrupt(interrupt.id, { generation: 99, response: { approved: true } }), null);
  assert.equal((await store.resolveInterrupt(interrupt.id, {
    generation: interrupt.generation,
    response: { approved: true },
  })).state, 'resolved');
  assert.equal((await store.getExecution(execution.id)).state, 'running', 'last resolved interrupt resumes the execution');

  const timedOut = await store.openInterrupt({
    executionId: execution.id,
    stableKey: 'approval:expired-batch',
    kind: 'approval',
    payload: { summary: 'Timed approval' },
    deadlineAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const expired = await store.expireDueInterrupts();
  assert.deepEqual(expired.map((entry) => entry.id), [timedOut.id]);
  assert.equal((await store.getExecution(execution.id)).state, 'blocked', 'expired input must block rather than silently resume execution');
  assert.equal((await store.resolveInterrupt(timedOut.id, {
    generation: timedOut.generation,
    response: { approved: true },
  })), null, 'an expired approval may not be accepted late');
  assert.equal((await store.expireDueInterrupts()).length, 0, 'interrupt expiry is idempotent');

  const detailed = await store.getExecution(execution.id, { includeDetails: true });
  assert.equal(detailed.steps.length, 1);
  assert.equal(detailed.commands.length, 3);
  assert.equal(detailed.interrupts.length, 2);
  assert.ok(detailed.events.some((event) => event.type === 'interrupt_resolved'));
  assert.ok(detailed.events.some((event) => event.type === 'interrupt_expired'));
  console.log('test-orchestration-store: ok');
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
