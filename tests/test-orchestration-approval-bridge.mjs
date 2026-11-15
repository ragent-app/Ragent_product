#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-orchestration-approval-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const bridge = await import('../chat/orchestration-approval-bridge.mjs');
const store = await import('../chat/orchestration-store.mjs');

try {
  const sessionId = 'session-approval-bridge';
  await bridge.mirrorApprovalEventsToOrchestration({
    sessionId,
    events: [{
      type: 'approval_request',
      approvalId: 'approval-1',
      runId: 'run-1',
      providerMethod: 'shell.exec',
      command: 'echo secret must not enter the ledger',
      title: 'Run a command',
      reason: 'The task needs a local check',
      risk: 'caution',
    }],
  });
  const approvalExecution = await store.getExecutionByScope(
    'approval', `${sessionId}:approval-1`, { includeDetails: true },
  );
  assert.equal(approvalExecution.state, 'waiting_input');
  assert.equal(approvalExecution.interrupts.length, 1);
  assert.equal(approvalExecution.interrupts[0].state, 'open');
  assert.equal(approvalExecution.spec.title, 'Run a command');
  assert.equal('command' in approvalExecution.spec, false, 'raw command must not be copied into the generic ledger');

  // Replaying the same request is idempotent and does not create a second
  // generation while the original wait remains open.
  await bridge.mirrorApprovalEventsToOrchestration({
    sessionId,
    events: [{ type: 'approval_request', approvalId: 'approval-1', runId: 'run-1' }],
  });
  const replayed = await store.getExecution(approvalExecution.id, { includeDetails: true });
  assert.equal(replayed.interrupts.length, 1);
  assert.equal(replayed.interrupts[0].generation, 1);

  await bridge.mirrorApprovalEventsToOrchestration({
    sessionId,
    events: [{ type: 'approval_response', approvalId: 'approval-1', status: 'approved', decision: 'approved' }],
  });
  const resolved = await store.getExecution(approvalExecution.id, { includeDetails: true });
  assert.equal(resolved.state, 'running');
  assert.equal(resolved.interrupts[0].state, 'resolved');

  await bridge.mirrorApprovalEventsToOrchestration({
    sessionId,
    events: [{
      type: 'privileged_batch_request',
      batchId: 'batch-1',
      runId: 'run-2',
      risk: 'danger',
      other: [{ opId: 'op-1' }],
      delete: [{ opId: 'op-2' }],
      installAuto: [],
    }],
  });
  const batchExecution = await store.getExecutionByScope(
    'privileged_approval', `${sessionId}:batch-1`, { includeDetails: true },
  );
  assert.equal(batchExecution.state, 'waiting_input');
  assert.deepEqual(
    batchExecution.interrupts.map((entry) => entry.stableKey),
    ['batch:batch-1:other', 'batch:batch-1:delete'],
  );

  await bridge.mirrorApprovalEventsToOrchestration({
    sessionId,
    events: [{ type: 'privileged_batch_response', batchId: 'batch-1', category: 'other', decisions: { 'op-1': 'approved' } }],
  });
  const afterOneCategory = await store.getExecution(batchExecution.id, { includeDetails: true });
  assert.equal(afterOneCategory.state, 'waiting_input', 'remaining category must keep the execution waiting');
  assert.equal(afterOneCategory.interrupts.find((entry) => entry.stableKey.endsWith(':other')).state, 'resolved');

  await bridge.mirrorApprovalEventsToOrchestration({
    sessionId,
    events: [{ type: 'privileged_batch_response', batchId: 'batch-1', category: 'delete', decisions: { 'op-2': 'denied' } }],
  });
  const batchResolved = await store.getExecution(batchExecution.id, { includeDetails: true });
  assert.equal(batchResolved.state, 'running');
  assert.ok(batchResolved.interrupts.every((entry) => entry.state === 'resolved'));

  // Responses for an event emitted before the projection existed are safe
  // no-ops; the canonical approval channel remains unaffected.
  const orphan = await bridge.mirrorApprovalEventsToOrchestration({
    sessionId,
    events: [{ type: 'approval_response', approvalId: 'missing', status: 'approved' }],
  });
  assert.deepEqual(orphan, []);
  console.log('test-orchestration-approval-bridge: ok');
} finally {
  rmSync(configDir, { recursive: true, force: true });
}

