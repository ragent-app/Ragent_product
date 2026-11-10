#!/usr/bin/env node
// Behavior test for the stale-approval sweeps (2026-08-08, 7e919f5):
// pending approval_request events whose run is already terminal must receive
// a cancelled approval_response via the session sweep / boot backfill, so
// cards cannot re-pop after the run is gone. Running runs must be untouched.
// Regression for the pre-fix leak: f43b83d8 accumulated 154 pending approvals
// with no response because finalize never looked at session history.
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'agentoc-approval-sweep-'));
const instanceRoot = join(home, 'instance');
const previousEnv = {
  HOME: process.env.HOME,
  AGENTOC_INSTANCE_ROOT: process.env.AGENTOC_INSTANCE_ROOT,
  AGENTOC_CONFIG_DIR: process.env.AGENTOC_CONFIG_DIR,
  AGENTOC_WORK_ROOT_DIR: process.env.AGENTOC_WORK_ROOT_DIR,
};

process.env.HOME = home;
process.env.AGENTOC_INSTANCE_ROOT = instanceRoot;
process.env.AGENTOC_CONFIG_DIR = join(instanceRoot, 'config');
process.env.AGENTOC_WORK_ROOT_DIR = join(instanceRoot, 'workspace');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

try {
  const {
    sweepStaleApprovalsAcrossSessions,
    createSession,
  } = await import('../chat/session-manager.mjs');
  const { loadHistory, appendEvent } = await import('../chat/history.mjs');
  const { createRun, updateRun } = await import('../chat/runs.mjs');

  // Two runs: one terminal (leak source), one still running (must survive).
  const terminalRun = await createRun({
    status: {
      sessionId: 'session_sweep_terminal',
      requestId: 'req-sweep-terminal',
      state: 'accepted',
      tool: 'claude-bidi',
    },
    manifest: {
      sessionId: 'session_sweep_terminal',
      requestId: 'req-sweep-terminal',
      folder: '~',
      tool: 'claude-bidi',
      runtimeFamily: 'claude-stream-json-bidi',
      prompt: 'hi',
      options: { runtimeFamily: 'claude-stream-json-bidi' },
    },
  });
  const runningRun = await createRun({
    status: {
      sessionId: 'session_sweep_running',
      requestId: 'req-sweep-running',
      state: 'accepted',
      tool: 'claude-bidi',
    },
    manifest: {
      sessionId: 'session_sweep_running',
      requestId: 'req-sweep-running',
      folder: '~',
      tool: 'claude-bidi',
      runtimeFamily: 'claude-stream-json-bidi',
      prompt: 'hi',
      options: { runtimeFamily: 'claude-stream-json-bidi' },
    },
  });

  // Session A: one leaked provider approval plus partially answered privileged
  // and approved-action batches from a run that later becomes terminal.
  const sessionA = (await createSession(home, 'claude-bidi', 'sweep-a')).id;
  await appendEvent(sessionA, {
    type: 'approval_request',
    approvalId: 'claude:sweep-leak-1',
    runId: terminalRun.id,
    status: 'pending',
    ts: new Date().toISOString(),
  });
  await appendEvent(sessionA, {
    type: 'approval_response',
    approvalId: 'claude:sweep-leak-1',
    decision: 'approved',
    runId: terminalRun.id,
    ts: new Date().toISOString(),
  });
  await appendEvent(sessionA, {
    type: 'approval_request',
    approvalId: 'claude:sweep-leak-2',
    runId: terminalRun.id,
    status: 'pending',
    ts: new Date().toISOString(),
  });
  await appendEvent(sessionA, {
    type: 'privileged_batch_request',
    batchId: 'batch-terminal-partial',
    runId: terminalRun.id,
    other: [{ opId: 'other-op' }],
    delete: [{ opId: 'delete-op' }],
  });
  await appendEvent(sessionA, {
    type: 'privileged_batch_response',
    batchId: 'batch-terminal-partial',
    category: 'other',
    decisions: { 'other-op': 'approved' },
    runId: terminalRun.id,
  });
  await appendEvent(sessionA, {
    type: 'approved_action_batch_request',
    channel: 'approved_action',
    batchId: 'actions-terminal-partial',
    runId: terminalRun.id,
    actions: [
      { actionId: 'action-already-approved', state: 'waiting_user' },
      { actionId: 'action-still-waiting', state: 'waiting_user' },
    ],
  });
  await appendEvent(sessionA, {
    type: 'approved_action_batch_response',
    channel: 'approved_action',
    batchId: 'actions-terminal-partial',
    runId: terminalRun.id,
    decisions: { 'action-already-approved': 'approved' },
  });

  // These requests were accepted while the run was live. Finalization/boot
  // repair must still close the unanswered one after the run ends.
  await updateRun(terminalRun.id, (current) => ({ ...current, state: 'completed' }));

  // A delayed adapter frame arriving after terminal state must be converted
  // into a cancellation at the history append boundary, never published as a
  // fresh pending card or attention push.
  const lateSession = (await createSession(home, 'claude-bidi', 'sweep-late')).id;
  const lateStored = await appendEvent(lateSession, {
    type: 'approval_request',
    approvalId: 'claude:late-after-terminal',
    runId: terminalRun.id,
    status: 'pending',
    ts: new Date().toISOString(),
  });
  assert.equal(lateStored?.type, 'approval_response');
  assert.equal(lateStored?.decision, 'cancelled');
  assert.equal(lateStored?.source, 'terminal-run-admission');
  const lateHistory = await loadHistory(lateSession, { includeBodies: false });
  assert.equal(lateHistory.some((event) => event.type === 'approval_request' && event.approvalId === 'claude:late-after-terminal'), false);
  assert.equal(lateHistory.filter((event) => event.type === 'approval_response' && event.approvalId === 'claude:late-after-terminal').length, 1);

  const lateBatchSession = (await createSession(home, 'claude-bidi', 'sweep-late-batch')).id;
  const lateBatchStored = await appendEvent(lateBatchSession, {
    type: 'privileged_batch_request',
    batchId: 'late-privileged-batch',
    runId: terminalRun.id,
    other: [{ opId: 'late-other' }],
    delete: [{ opId: 'late-delete' }],
  });
  assert.equal(lateBatchStored?.type, 'privileged_batch_response');
  const lateBatchHistory = await loadHistory(lateBatchSession, { includeBodies: false });
  assert.equal(lateBatchHistory.some((event) => event.type === 'privileged_batch_request'), false);
  assert.equal(lateBatchHistory.filter((event) => event.type === 'privileged_batch_response'
    && event.batchId === 'late-privileged-batch').length, 2);

  const lateActionSession = (await createSession(home, 'claude-bidi', 'sweep-late-action-batch')).id;
  const lateActionStored = await appendEvent(lateActionSession, {
    type: 'approved_action_batch_request',
    batchId: 'late-action-batch',
    runId: terminalRun.id,
    actions: [{ actionId: 'late-action-1' }, { actionId: 'late-action-2' }],
  });
  assert.equal(lateActionStored?.type, 'approved_action_batch_response');
  assert.deepEqual(lateActionStored?.decisions, {
    'late-action-1': 'cancelled',
    'late-action-2': 'cancelled',
  });
  const lateActionHistory = await loadHistory(lateActionSession, { includeBodies: false });
  assert.equal(lateActionHistory.some((event) => event.type === 'approved_action_batch_request'), false);
  // Session B: pending approval from the STILL-RUNNING run — must survive.
  const sessionB = (await createSession(home, 'claude-bidi', 'sweep-b')).id;
  await appendEvent(sessionB, {
    type: 'approval_request',
    approvalId: 'claude:sweep-live-1',
    runId: runningRun.id,
    status: 'pending',
    ts: new Date().toISOString(),
  });
  await appendEvent(sessionB, {
    type: 'privileged_batch_request',
    batchId: 'batch-still-running',
    runId: runningRun.id,
    other: [{ opId: 'live-op' }],
  });
  await appendEvent(sessionB, {
    type: 'approved_action_batch_request',
    channel: 'approved_action',
    batchId: 'actions-still-running',
    runId: runningRun.id,
    actions: [{ actionId: 'live-action', state: 'waiting_user' }],
  });

  const cancelled = await sweepStaleApprovalsAcrossSessions();

  const historyA = await loadHistory(sessionA, { includeBodies: false });
  const cancelledInA = historyA.filter(
    (e) => e.type === 'approval_response' && e.decision === 'cancelled',
  );
  assert.equal(cancelledInA.length, 1, 'exactly the leaked pending approval must be cancelled');
  assert.equal(cancelledInA[0].approvalId, 'claude:sweep-leak-2');
  assert.equal(cancelledInA[0].source, 'boot-backfill');
  assert.equal(cancelledInA[0].runId, terminalRun.id, 'cancellation must carry the owning run id');
  const batchResponses = historyA.filter((event) => event.type === 'privileged_batch_response'
    && event.batchId === 'batch-terminal-partial');
  assert.equal(batchResponses.length, 2, 'only the unanswered privileged batch group must be closed');
  assert.deepEqual(batchResponses.map((event) => event.category), ['other', 'delete']);
  assert.equal(batchResponses[1].source, 'boot-backfill');
  const actionResponses = historyA.filter((event) => event.type === 'approved_action_batch_response'
    && event.batchId === 'actions-terminal-partial');
  assert.equal(actionResponses.length, 2, 'an unanswered action batch must be closed after its run ends');
  assert.deepEqual(actionResponses[1].decisions, { 'action-still-waiting': 'cancelled' });

  const historyB = await loadHistory(sessionB, { includeBodies: false });
  assert.equal(
    historyB.filter((e) => e.type === 'approval_response' && e.decision === 'cancelled').length,
    0,
    'pending approvals of a still-running run must never be cancelled',
  );
  assert.equal(historyB.some((event) => event.type === 'privileged_batch_response'
    && event.batchId === 'batch-still-running'), false, 'live privileged batches must remain actionable');
  assert.equal(historyB.some((event) => event.type === 'approved_action_batch_response'
    && event.batchId === 'actions-still-running'), false, 'live approved-action batches must remain actionable');
  assert.equal(cancelled >= 1, true, 'sweep must report the number of cancellations');

  console.log('test-approval-sweep-behavior: ok');
} catch (error) {
  console.error('test-approval-sweep-behavior: FAILED');
  console.error(error);
  process.exitCode = 1;
} finally {
  restoreEnv();
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}
