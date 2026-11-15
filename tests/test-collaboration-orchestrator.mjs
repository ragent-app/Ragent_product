import assert from 'assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = await mkdtemp(join(tmpdir(), 'ragent-collaboration-orchestrator-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');
const store = await import('../chat/collaboration-store.mjs');

const root = {
  id: 'root-session',
  folder: configDir,
  tool: 'codex',
  templateId: 'manager-agent',
  name: 'Manager',
  delegationDepth: 0,
};
const apps = new Map([
  ['manager-agent', {
    id: 'manager-agent',
    name: 'Manager',
    tool: 'codex',
    collaborationPolicy: {
      role: 'manager',
      canDelegate: true,
      allowedAgentIds: ['specialist-agent'],
      maxChildren: 4,
      maxConcurrent: 2,
      maxDepth: 2,
      workspacePolicy: 'shared-exclusive',
      revision: 'manager-r1',
    },
  }],
  ['specialist-agent', {
    id: 'specialist-agent',
    name: 'Specialist',
    tool: 'codex',
    collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'specialist-r1' },
  }],
]);
const sessions = new Map([[root.id, root]]);
const runs = new Map();
const prompts = [];
const dispatches = [];
let childCounter = 0;
let runCounter = 0;
let deferManagerAggregation = false;
let automaticWakeCreates = 0;

const orchestrator = createCollaborationOrchestrator({
  pollMs: 100000,
  dependencies: {
    getSession: async (id) => sessions.get(id) || null,
    getApp: async (id) => apps.get(id) || null,
    createSession: async (_folder, tool, name, extra) => {
      const session = {
        id: `child-${++childCounter}`,
        folder: configDir,
        tool,
        name,
        ...extra,
      };
      sessions.set(session.id, session);
      return session;
    },
    sendMessage: async (sessionId, text, _images, options) => {
      prompts.push(text);
      dispatches.push({ sessionId, text, options: { ...options } });
      if (options.internalOperation === 'collaboration_resume' && deferManagerAggregation) {
        return { session: sessions.get(sessionId), run: null, prompt: text, deferred: true };
      }
      const run = {
        id: `run-${++runCounter}`,
        sessionId,
        state: 'running',
        requestId: options.requestId,
        result: null,
      };
      runs.set(run.id, run);
      return { session: sessions.get(sessionId), run, prompt: text };
    },
    getRunState: async (id) => runs.get(id) || null,
    getRun: async (id) => runs.get(id) || null,
    getRunResult: async (id) => runs.get(id)?.result || null,
    getRunManifest: async () => ({ folder: configDir }),
    listRunIds: async () => [...runs.keys()],
    requestRunCancel: async (id) => {
      const run = runs.get(id);
      if (run) run.state = 'cancelled';
      return run || null;
    },
    loadHistory: async (sessionId) => [{
      type: 'message',
      role: 'assistant',
      content: `report from ${sessionId}`,
    }],
    createTrigger: async () => {
      automaticWakeCreates += 1;
      return null;
    },
  },
});

// A git-worktree collaboration with a stubbed createGitWorktree lets us assert
// that a retried attempt is scoped to its own worktree path instead of
// colliding with the previous attempt's path.
const worktreeCalls = [];
const worktreeRoot = {
  id: 'worktree-root',
  folder: configDir,
  tool: 'codex',
  templateId: 'worktree-manager',
  name: 'WT Manager',
  delegationDepth: 0,
};
const worktreeApps = new Map([
  ['worktree-manager', {
    id: 'worktree-manager',
    name: 'WT Manager',
    tool: 'codex',
    collaborationPolicy: {
      role: 'manager',
      canDelegate: true,
      allowedAgentIds: ['specialist-agent'],
      maxChildren: 4,
      maxConcurrent: 1,
      maxDepth: 2,
      workspacePolicy: 'git-worktree',
      revision: 'worktree-manager-r1',
    },
  }],
  ['specialist-agent', apps.get('specialist-agent')],
]);
const worktreeSessions = new Map([[worktreeRoot.id, worktreeRoot]]);
const worktreeRuns = new Map();
let worktreeChildCounter = 0;
let worktreeRunCounter = 0;
const worktreeOrchestrator = createCollaborationOrchestrator({
  pollMs: 100000,
  dependencies: {
    getSession: async (id) => worktreeSessions.get(id) || null,
    getApp: async (id) => worktreeApps.get(id) || null,
    createSession: async (folder, tool, name, extra) => {
      const session = {
        id: `wt-child-${++worktreeChildCounter}`,
        folder,
        tool,
        name,
        ...extra,
      };
      worktreeSessions.set(session.id, session);
      return session;
    },
    sendMessage: async (sessionId, text, _images, options) => {
      const run = {
        id: `wt-run-${++worktreeRunCounter}`,
        sessionId,
        state: 'running',
        requestId: options.requestId,
        result: null,
      };
      worktreeRuns.set(run.id, run);
      return { session: worktreeSessions.get(sessionId), run, prompt: text };
    },
    getRunState: async (id) => worktreeRuns.get(id) || null,
    getRun: async (id) => worktreeRuns.get(id) || null,
    getRunResult: async (id) => worktreeRuns.get(id)?.result || null,
    getRunManifest: async () => ({ folder: configDir }),
    listRunIds: async () => [...worktreeRuns.keys()],
    requestRunCancel: async (id) => {
      const run = worktreeRuns.get(id);
      if (run) run.state = 'cancelled';
      return run || null;
    },
    loadHistory: async (sessionId) => [{
      type: 'message',
      role: 'assistant',
      content: `report from ${sessionId}`,
    }],
    createGitWorktree: async ({ taskId }) => {
      worktreeCalls.push(taskId);
      return `/tmp/ragent-collaboration-worktrees/test/${taskId}`;
    },
  },
});

try {
  const plan = {
    title: 'orchestrator contract test',
    tasks: [
      { id: 'contract', agentId: 'specialist-agent', objective: 'Implement contract', acceptance: ['unit test'] },
      { id: 'review', agentId: 'specialist-agent', objective: 'Review contract', dependsOn: ['contract'], acceptance: ['review notes'] },
    ],
  };
  const beforeValidation = (await orchestrator.list()).length;
  const validation = await orchestrator.validate({ rootSessionId: root.id, plan });
  assert.equal(validation.valid, true, 'a structured plan can be validated without dispatching it');
  assert.equal(validation.plan.tasks.length, 2);
  assert.equal((await orchestrator.list()).length, beforeValidation, 'validation must not persist a collaboration record');
  const first = await orchestrator.dispatch({
    rootSessionId: root.id,
    plan,
    idempotencyKey: 'orchestrator-test',
  });
  assert.equal(first.tasks.find((task) => task.id === 'contract').state, 'running');
  assert.equal(first.tasks.find((task) => task.id === 'review').state, 'planned');
  assert.equal(automaticWakeCreates, 0, 'collaboration dispatch must not create a parent-session completion trigger');
  assert.equal(first.policy.agentContracts.contract.agentRevision, 'specialist-r1');
  assert.equal(first.policy.agentContracts.contract.policyRevision, 'manager-r1:specialist-r1');
  assert.match(prompts[0], /ragent-result-packet/, 'collaboration workers receive the bounded result contract');
  assert.match(prompts[0], /Allowed state values are: completed \| failed \| blocked \| waiting/);
  assert.equal(dispatches[0].options.recordUserMessage, false, 'worker dispatch must not create a synthetic user message');
  assert.equal(dispatches[0].options.skipSessionContinuation, true, 'worker dispatch must bypass user-session continuation routing');
  assert.deepEqual(dispatches[0].options.sourceContext, {
    kind: 'collaboration_dispatch',
    collaborationId: first.id,
    taskId: 'contract',
    rootSessionId: root.id,
  }, 'worker dispatch must retain collaboration provenance outside the user transcript');

  const firstRun = first.tasks.find((task) => task.id === 'contract').runId;
  runs.get(firstRun).state = 'completed';
  runs.get(firstRun).result = { exitCode: 0, completedAt: new Date().toISOString(), synthesized: true };
  assert.equal(await orchestrator.completeRun(firstRun), true);

  let current = await orchestrator.get(first.id);
  assert.equal(current.tasks.find((task) => task.id === 'contract').state, 'succeeded');
  assert.equal(current.tasks.find((task) => task.id === 'review').state, 'running');
  assert.ok(current.attempts.find((attempt) => attempt.taskId === 'contract').envelope);

  const secondRun = current.tasks.find((task) => task.id === 'review').runId;
  runs.get(secondRun).state = 'completed';
  runs.get(secondRun).result = { exitCode: 0, completedAt: new Date().toISOString() };
  deferManagerAggregation = true;
  assert.equal(await orchestrator.completeRun(secondRun), true);
  current = await orchestrator.get(first.id);
  assert.equal(current.state, 'waiting_aggregation', 'a busy root must retain aggregation in the collaboration control plane');
  assert.equal(current.aggregationRunId, '', 'a deferred aggregation must not invent a manager Run');
  const deferredAggregation = dispatches.at(-1);
  assert.equal(deferredAggregation.options.internalOperation, 'collaboration_resume');
  assert.equal(deferredAggregation.options.recordUserMessage, false);
  assert.equal(deferredAggregation.options.queueIfBusy, false);
  assert.equal(deferredAggregation.options.deferIfBusy, true);
  assert.equal(deferredAggregation.options.skipSessionContinuation, true);
  assert.deepEqual(deferredAggregation.options.sourceContext, {
    kind: 'collaboration_aggregation',
    collaborationId: first.id,
    aggregationGeneration: 1,
  });

  deferManagerAggregation = false;
  assert.ok(await orchestrator.maybeAggregate(first.id), 'the same aggregation generation should be claimable once the root is idle');
  current = await orchestrator.get(first.id);
  assert.equal(current.state, 'aggregating');
  assert.ok(current.aggregationRunId);

  runs.get(current.aggregationRunId).state = 'completed';
  runs.get(current.aggregationRunId).result = { exitCode: 0, completedAt: new Date().toISOString() };
  assert.equal(await orchestrator.completeAggregation(current.aggregationRunId), true);
  assert.equal((await orchestrator.get(first.id)).state, 'completed');

  assert.equal(await orchestrator.completeRun(secondRun), false, 'duplicate completion must be ignored');

  const recovery = await orchestrator.dispatch({
    rootSessionId: root.id,
    plan: {
      title: 'lease recovery',
      tasks: [{
        id: 'lease-recovery',
        agentId: 'specialist-agent',
        objective: 'recover an expired lease',
        retry: { maxAttempts: 2, retryOn: ['unknown_outcome'] },
      }],
    },
    idempotencyKey: 'orchestrator-recovery-test',
  });
  const recoveryFirstRun = recovery.tasks[0].runId;
  const recoveryFirstAttempt = recovery.attempts[0];
  assert.ok(await store.heartbeatAttempt(recoveryFirstAttempt.id, 1));
  // The dispatch record disappeared before a runner ever reported started;
  // this is the only safe automatic retry case.  A live queued/running Run is
  // observed and receives its phase-specific deadline instead.
  runs.delete(recoveryFirstRun);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await orchestrator.reconcile();
  const recovered = await orchestrator.get(recovery.id);
  assert.equal(recovered.attempts.length, 2, 'expired lease should create exactly one retry attempt');
  assert.equal(recovered.attempts[0].failureKind, 'unknown_outcome');
  assert.equal(recovered.tasks[0].state, 'running');
  assert.notEqual(recovered.tasks[0].runId, recoveryFirstRun);

  const manual = await orchestrator.dispatch({
    rootSessionId: root.id,
    plan: {
      title: 'manual retry',
      tasks: [{
        id: 'manual-orchestrator-retry',
        agentId: 'specialist-agent',
        objective: 'retry after a deterministic failure',
        retry: { maxAttempts: 2, retryOn: ['deterministic_failure'] },
      }],
    },
    idempotencyKey: 'orchestrator-manual-retry-test',
  });
  const manualRun = runs.get(manual.tasks[0].runId);
  manualRun.state = 'failed';
  manualRun.failureReason = 'invalid fixture';
  manualRun.result = { error: 'invalid fixture', completedAt: new Date().toISOString() };
  assert.equal(await orchestrator.completeRun(manualRun.id), true);
  assert.equal((await orchestrator.get(manual.id)).state, 'failed');
  const retryResult = await orchestrator.retry(manual.id, 'owner retry test');
  assert.equal(retryResult.retried, 1);
  assert.equal(retryResult.collaboration.state, 'running');
  assert.equal(retryResult.collaboration.attempts.length, 2);
  assert.equal(retryResult.collaboration.tasks[0].state, 'running');
  assert.equal(retryResult.retryable.length, 1, 'retry must report the evaluated attempt');
  assert.equal(retryResult.retryable[0].retryable, true);
  assert.equal(await orchestrator.retry(manual.id, 'repeat retry').then((r) => r.retried), 0, 'repeat retry must be idempotent');

  // A terminal (completed) collaboration rejects retry with a typed error.
  await assert.rejects(
    orchestrator.retry(first.id, 'retry completed'),
    (error) => error?.code === 'COLLABORATION_NOT_RETRYABLE',
    'retrying a completed collaboration must throw COLLABORATION_NOT_RETRYABLE',
  );

  // An expired lease whose frozen policy excludes unknown_outcome must NOT be
  // re-run; reconcile marks the task/collaboration failed instead.
  const noRetry = await orchestrator.dispatch({
    rootSessionId: root.id,
    plan: {
      title: 'no retry on unknown outcome',
      tasks: [{
        id: 'no-retry-expired',
        agentId: 'specialist-agent',
        objective: 'expire without a retryable outcome',
        retry: { maxAttempts: 2, retryOn: ['transient'] },
      }],
    },
    idempotencyKey: 'orchestrator-no-retry-expired-test',
  });
  const noRetryAttempt = noRetry.attempts[0];
  assert.ok(await store.heartbeatAttempt(noRetryAttempt.id, 1));
  runs.delete(noRetry.tasks[0].runId);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await orchestrator.reconcile();
  const afterNoRetry = await orchestrator.get(noRetry.id);
  assert.equal(afterNoRetry.attempts.length, 1, 'unknown_outcome must not spawn a retry attempt');
  assert.equal(afterNoRetry.attempts[0].failureKind, 'unknown_outcome');
  assert.equal(afterNoRetry.tasks[0].state, 'failed');
  assert.equal(afterNoRetry.state, 'failed');

  // Regression for the production failure mode: a timeout sweep may have
  // already closed a collaboration when its child Run writes a successful
  // terminal result.  The exact Attempt generation is recovered; no second
  // child is dispatched and the late result becomes visible to aggregation.
  const lateSuccess = await orchestrator.dispatch({
    rootSessionId: root.id,
    plan: {
      title: 'late successful result recovery',
      tasks: [{
        id: 'late-success-recovery',
        agentId: 'specialist-agent',
        objective: 'recover the successful child result',
        retry: { maxAttempts: 1, retryOn: ['transient'] },
      }],
    },
    idempotencyKey: 'orchestrator-late-success-recovery',
  });
  const lateRunId = lateSuccess.tasks[0].runId;
  const lateRun = runs.get(lateRunId);
  const lateAttempt = lateSuccess.attempts[0];
  assert.ok(await store.heartbeatAttempt(lateAttempt.id, 1));
  runs.delete(lateRunId);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await orchestrator.reconcile();
  assert.equal((await orchestrator.get(lateSuccess.id)).state, 'failed', 'the fixture first reproduces the old expiry');
  runs.set(lateRunId, {
    ...lateRun,
    state: 'completed',
    result: { exitCode: 0, completedAt: new Date().toISOString(), synthesized: true },
  });
  await orchestrator.reconcile();
  const recoveredLateSuccess = await orchestrator.get(lateSuccess.id);
  assert.equal(recoveredLateSuccess.tasks[0].state, 'succeeded', 'late verified success repairs its original task');
  assert.equal(recoveredLateSuccess.attempts[0].state, 'succeeded');
  assert.ok(recoveredLateSuccess.events.some((event) => event.type === 'attempt_recovered'));

  // Cancel is terminal for reconcile: a cancelled collaboration must stay
  // cancelled and its running attempts stay cancelled.
  const cancelled = await orchestrator.dispatch({
    rootSessionId: root.id,
    plan: {
      title: 'cancel idempotent',
      tasks: [{ id: 'cancel-orch', agentId: 'specialist-agent', objective: 'cancel me' }],
    },
    idempotencyKey: 'orchestrator-cancel-test',
  });
  assert.equal(await orchestrator.cancel(cancelled.id, 'stop'), true);
  assert.equal(await orchestrator.cancel(cancelled.id, 'again'), false, 'second cancel is a no-op');
  await orchestrator.reconcile();
  assert.equal((await orchestrator.get(cancelled.id)).state, 'cancelled');
  assert.equal((await orchestrator.get(cancelled.id)).attempts[0].state, 'cancelled');

  // git-worktree: a retried attempt must be scoped to its own worktree path
  // instead of colliding with the previous attempt's path.
  const wt = await worktreeOrchestrator.dispatch({
    rootSessionId: worktreeRoot.id,
    plan: {
      title: 'git-worktree retry isolation',
      tasks: [{
        id: 'wt-task',
        agentId: 'specialist-agent',
        objective: 'worktree task',
        retry: { maxAttempts: 2, retryOn: ['transient', 'deterministic_failure'] },
      }],
    },
    idempotencyKey: 'orchestrator-git-worktree-retry-test',
  });
  assert.equal(worktreeCalls[0], 'wt-task:attempt:1', 'first attempt worktree must be attempt-scoped');
  const wtRun = worktreeRuns.get(wt.tasks[0].runId);
  wtRun.state = 'failed';
  wtRun.failureReason = 'invalid fixture';
  wtRun.result = { error: 'invalid fixture', completedAt: new Date().toISOString() };
  assert.equal(await worktreeOrchestrator.completeRun(wtRun.id), true);
  assert.equal((await worktreeOrchestrator.get(wt.id)).state, 'failed');
  const wtRetry = await worktreeOrchestrator.retry(wt.id, 'retry worktree');
  assert.equal(wtRetry.retried, 1);
  assert.equal(worktreeCalls.length, 2, 'retry must request a distinct worktree');
  assert.equal(worktreeCalls[1], 'wt-task:attempt:2', 'retry worktree must be attempt-scoped');
  const wtAfter = await worktreeOrchestrator.get(wt.id);
  const wtTask = wtAfter.tasks.find((t) => t.id === 'wt-task');
  const wtSession2 = worktreeSessions.get(wtTask.sessionId);
  assert.equal(wtSession2.folder, '/tmp/ragent-collaboration-worktrees/test/wt-task:attempt:2');
  assert.equal(wtSession2.sourceContext.worktreeRef, '/tmp/ragent-collaboration-worktrees/test/wt-task:attempt:2');
  assert.equal(wtSession2.sourceContext.taskId, 'wt-task', 'sourceContext must carry the logical task id');
  console.log('test-collaboration-orchestrator: ok');
} finally {
  orchestrator.stop();
  worktreeOrchestrator.stop();
  await rm(configDir, { recursive: true, force: true });
}
