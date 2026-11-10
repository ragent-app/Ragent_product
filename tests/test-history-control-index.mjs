#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agentoc-control-index-'));
const instanceRoot = join(home, 'instance');
process.env.HOME = home;
process.env.AGENTOC_INSTANCE_ROOT = instanceRoot;
process.env.AGENTOC_CONFIG_DIR = join(instanceRoot, 'config');
process.env.AGENTOC_MEMORY_DIR = join(instanceRoot, 'memory');
process.env.AGENTOC_WORK_ROOT_DIR = join(instanceRoot, 'workspace');

const history = await import('../chat/history.mjs');
const { createRun } = await import('../chat/runs.mjs');
const sessionId = `control-index-${process.pid}-${Date.now()}`;
const batchId = 'batch-control-index';
const approvalId = 'approval-control-index';
const sessionApprovalId = 'session-confirmation-control-index';
const planId = 'plan-control-index';

try {
  const run = await createRun({
    status: {
      sessionId,
      requestId: `req-${sessionId}`,
      state: 'accepted',
      tool: 'claude-bidi',
    },
    manifest: {
      sessionId,
      requestId: `req-${sessionId}`,
      folder: home,
      tool: 'claude-bidi',
      runtimeFamily: 'claude-stream-json-bidi',
      prompt: 'index test',
      options: { runtimeFamily: 'claude-stream-json-bidi' },
    },
  });
  const runId = run.id;
  await history.appendEvents(sessionId, [
    ...Array.from({ length: 1200 }, (_, index) => ({
      type: 'status', content: `provider progress ${index}`,
    })),
    {
      type: 'privileged_batch_request', runId, batchId,
      other: [{ opId: 'op-1', command: 'echo ok' }], delete: [],
    },
    {
      type: 'approval_request', runId, approvalId,
      providerRequestId: 'provider-1', providerMethod: 'tool/approval',
      kind: 'command', params: { command: 'echo ok' },
    },
    {
      type: 'approval_request', source: 'agentoc-confirmation', approvalId: sessionApprovalId,
      kind: 'confirmation', title: 'Indexed session confirmation', status: 'pending',
    },
    {
      type: 'plan', planId, runId, state: 'awaiting_decision',
      title: 'Indexed plan', bodyMarkdown: '1. Run the check', items: [],
    },
    {
      type: 'message', role: 'assistant', source: 'approved_action', batchId,
      content: 'Approved action continuation',
    },
  ]);

  const batchEvents = await history.readPrivilegedBatchEvents(sessionId, batchId);
  assert.equal(batchEvents.length, 1);
  assert.equal(batchEvents[0].batchId, batchId);
  const pending = await history.findRuntimeApprovalRequest(sessionId, runId, approvalId);
  assert.equal(pending?.approvalId, approvalId);
  assert.equal((await history.readRuntimeApprovalEventsForRun(sessionId, runId)).length, 1);
  const indexedApprovals = await history.readAllRuntimeApprovalEvents(sessionId);
  assert.ok(indexedApprovals.some((event) => event?.approvalId === sessionApprovalId), 'run-less session confirmations should be indexed');
  assert.equal((await history.readPlanEvents(sessionId, planId)).length, 1);
  assert.equal((await history.readApprovedActionContinuationEvents(sessionId, batchId)).length, 1);

  await history.appendEvent(sessionId, {
    type: 'approval_response', runId, approvalId, decision: 'approve', status: 'approved',
  });
  assert.equal(await history.findRuntimeApprovalRequest(sessionId, runId, approvalId), null);

  const indexPath = join(process.env.AGENTOC_CONFIG_DIR, 'chat-history', sessionId, 'event-lookup-index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  assert.equal(index.complete, true);
  assert.ok(Object.keys(index.entries).some((key) => key.startsWith('privileged-batch:')));
  assert.ok(Object.keys(index.entries).some((key) => key.startsWith('approval:')));
  assert.ok(Object.keys(index.entries).some((key) => key.startsWith('plan:')));
  assert.ok(Object.keys(index.entries).some((key) => key.startsWith('approved-action-continuation:')));

  console.log('history-control-index: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
