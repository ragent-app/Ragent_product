#!/usr/bin/env node
import assert from 'assert/strict';

import { buildRunActivityProjection } from '../chat/run-activity-projection.mjs';

assert.equal(buildRunActivityProjection([], { sessionRunning: false }).state, 'idle');

const serviceRun = { id: 'run', windowsServiceRequests: {
  request: { requestId: 'request', status: 'awaiting_device', startedMs: 1000, expiresMs: 5000 },
} };
const serviceWaiting = buildRunActivityProjection([], { sessionRunning: true, run: serviceRun, nowMs: 2000 });
assert.equal(serviceWaiting.state, 'waiting_user');
assert.equal(serviceWaiting.actionRequired, true);
assert.equal(serviceWaiting.operationId, 'request');
const serviceExecuting = buildRunActivityProjection([], { sessionRunning: true,
  run: { ...serviceRun, windowsServiceRequests: { request: { ...serviceRun.windowsServiceRequests.request, status: 'executing' } } }, nowMs: 2000 });
assert.equal(serviceExecuting.state, 'working');
assert.equal(serviceExecuting.actionRequired, false);
assert.notEqual(buildRunActivityProjection([], { sessionRunning: true, run: serviceRun, nowMs: 5000 }).state, 'waiting_user');
assert.notEqual(buildRunActivityProjection([], { sessionRunning: true, run: { ...serviceRun, cancelRequested: true }, nowMs: 2000 }).state, 'waiting_user');

const agyProviderSlotActivity = buildRunActivityProjection([], {
  sessionRunning: true,
  run: {
    createdAt: '2026-03-14T12:00:00.000Z',
    agyQueue: {
      reason: 'agy-account-busy',
      queuedAt: '2026-03-14T12:01:00.000Z',
    },
  },
});
assert.equal(agyProviderSlotActivity.state, 'queued');
assert.equal(agyProviderSlotActivity.kind, 'provider_slot');
assert.equal(agyProviderSlotActivity.label, 'Waiting for AgY account slot');

const adaptiveCapacityActivity = buildRunActivityProjection([], {
  sessionRunning: true,
  run: {
    createdAt: '2026-03-14T12:00:00.000Z',
    runnerLaunchState: 'adaptive_capacity',
    adaptiveQueue: {
      reason: 'adaptive_capacity',
      queuedAt: '2026-03-14T12:01:00.000Z',
    },
  },
});
assert.equal(adaptiveCapacityActivity.state, 'queued');
assert.equal(adaptiveCapacityActivity.kind, 'adaptive_capacity');
assert.equal(adaptiveCapacityActivity.adaptiveCapacityWait, true);
assert.equal(adaptiveCapacityActivity.label, 'Waiting for system capacity');

const commandActivity = buildRunActivityProjection([
  {
    type: 'operation',
    operationId: 'operation:run:cmd',
    kind: 'command',
    state: 'running',
    title: 'Running command',
    detail: 'npm test',
    command: 'npm test',
    startSeq: 2,
    endSeq: 4,
    startedAt: 1000,
    updatedAt: 1800,
    canInterrupt: true,
  },
], { sessionRunning: true });
assert.equal(commandActivity.state, 'working');
assert.equal(commandActivity.kind, 'execute');
assert.equal(commandActivity.labelKind, 'execute');
assert.equal(commandActivity.subject, 'npm test');
assert.equal(commandActivity.operationId, 'operation:run:cmd');
assert.equal(commandActivity.elapsedMs, 800);
assert.equal(commandActivity.sourceSeq, 4);
assert.equal(commandActivity.outputBoundarySeq, 0);
assert.equal(commandActivity.inlineEligible, true);

const agyWaitingActivity = buildRunActivityProjection([
  {
    type: 'operation',
    operationId: 'operation:run:agy-command',
    kind: 'command',
    state: 'running',
    title: 'Running command',
    detail: 'long-command',
    startSeq: 2,
    endSeq: 4,
  },
], {
  sessionRunning: true,
  run: {
    runtimeFamily: 'agy-stream-json',
    providerLiveness: {
      schemaVersion: 1,
      state: 'alive',
      phase: 'awaiting_provider_output',
      heartbeatAt: '2026-08-22T10:00:00.000Z',
      lastOutputAt: '2026-08-22T09:57:00.000Z',
      outputIdleMs: 180000,
      heartbeatCount: 12,
    },
  },
});
assert.equal(agyWaitingActivity.providerLiveness.phase, 'awaiting_provider_output');
assert.equal('summary' in commandActivity, false, 'activity projection must not carry generated summaries');

const approvalActivity = buildRunActivityProjection([
  { type: 'operation', operationId: 'operation:run:cmd', kind: 'command', state: 'waiting_approval', command: 'npm test', endSeq: 3 },
  { type: 'approval_request', seq: 4, timestamp: 2000, status: 'pending', command: 'npm test' },
], { sessionRunning: true });
assert.equal(approvalActivity.state, 'waiting_user');
assert.equal(approvalActivity.kind, 'approval');
assert.equal(approvalActivity.labelKind, 'approval');
assert.equal(approvalActivity.subject, '');
assert.equal(approvalActivity.actionRequired, true);

const redactedApprovalRequestActivity = buildRunActivityProjection([
  { type: 'approval_request', seq: 4, timestamp: 2000, status: 'pending', command: 'curl -H "Authorization: Bearer approval-token" https://example.test' },
], { sessionRunning: true });
assert.match(redactedApprovalRequestActivity.detail, /\[redacted\]/);
assert.doesNotMatch(redactedApprovalRequestActivity.detail, /approval-token/);

const redactedApprovalActivity = buildRunActivityProjection([
  {
    type: 'operation',
    operationId: 'operation:run:approval-secret',
    kind: 'command',
    state: 'waiting_approval',
    command: 'curl -H "Authorization: Bearer live-token" https://example.test',
    endSeq: 5,
  },
], { sessionRunning: true });
assert.equal(redactedApprovalActivity.kind, 'approval');
assert.equal(redactedApprovalActivity.labelKind, 'approval');
assert.match(redactedApprovalActivity.subject, /\[redacted\]/);
assert.doesNotMatch(redactedApprovalActivity.subject, /live-token/);

const privilegedApprovalActivity = buildRunActivityProjection([
  {
    type: 'privileged_batch_request',
    seq: 4,
    timestamp: 2100,
    batchId: 'pbatch-1',
    other: [{ opId: 'pop-1', description: 'Restart nginx', command: 'systemctl restart nginx' }],
    delete: [],
  },
], { sessionRunning: true });
assert.equal(privilegedApprovalActivity.state, 'waiting_user');
assert.equal(privilegedApprovalActivity.kind, 'approval');
assert.equal(privilegedApprovalActivity.detail, 'Restart nginx');
assert.equal(privilegedApprovalActivity.actionRequired, true);

const managedAgentApprovalActivity = buildRunActivityProjection([
  {
    type: 'approved_action_batch_request',
    seq: 9,
    createdAt: 2200,
    batchId: 'agent-batch-1',
    actions: [{
      actionId: 'agent-action-1',
      operation: 'agent.create',
      description: 'Create Agent "Exact Agent"',
      state: 'waiting_user',
    }],
  },
], { sessionRunning: true });
assert.equal(managedAgentApprovalActivity.state, 'waiting_user');
assert.equal(managedAgentApprovalActivity.kind, 'approval');
assert.equal(managedAgentApprovalActivity.labelKind, 'approval');
assert.equal(managedAgentApprovalActivity.detail, 'Create Agent "Exact Agent"');
assert.equal(managedAgentApprovalActivity.actionRequired, true);

const fileEditActivity = buildRunActivityProjection([
  {
    type: 'operation',
    operationId: 'operation:run:edit',
    kind: 'file_edit',
    state: 'running',
    title: 'Editing file',
    detail: '/srv/ragent/static/chat/ui.js',
    startSeq: 7,
    endSeq: 8,
  },
], { sessionRunning: true });
assert.equal(fileEditActivity.kind, 'edit');
assert.equal(fileEditActivity.labelKind, 'edit');
assert.equal(fileEditActivity.subject, 'ui.js');

const compositeActivity = buildRunActivityProjection([
  {
    type: 'operation',
    operationId: 'operation:run:composite',
    kind: 'command',
    state: 'running',
    command: 'npm test && npm run lint',
    detail: 'npm test && npm run lint',
    startSeq: 9,
    endSeq: 10,
  },
], { sessionRunning: true });
assert.equal(compositeActivity.kind, 'execute');
assert.equal(compositeActivity.labelKind, 'execute_composite');
assert.equal(compositeActivity.subject, '');

const activeAfterOutputActivity = buildRunActivityProjection([
  {
    type: 'operation',
    operationId: 'operation:run:after-output',
    kind: 'command',
    state: 'running',
    title: 'Running command',
    detail: 'npm test',
    endSeq: 12,
  },
  {
    type: 'message',
    seq: 18,
    role: 'assistant',
    content: 'A streamed response is already visible.',
  },
], { sessionRunning: true });
assert.equal(activeAfterOutputActivity.outputBoundarySeq, 18);
assert.equal(
  activeAfterOutputActivity.inlineEligible,
  true,
  'an active run keeps its live activity row after formal output has appeared',
);

const respondingActivity = buildRunActivityProjection([
  { type: 'message', seq: 4, role: 'assistant', content: 'First visible paragraph' },
], { sessionRunning: true });
assert.equal(respondingActivity.kind, 'responding');
assert.equal(respondingActivity.outputBoundarySeq, 4);
assert.equal(respondingActivity.inlineEligible, true, 'an active run keeps the live activity row visible while responding');

console.log('test-run-activity-projection: ok');
