#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
function loadCore(name, globalName) {
  const context = { console };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(repoRoot, 'static/chat/core', name), 'utf8'), context, { filename: name });
  assert.ok(context[globalName], `${name} should attach its pure API`);
  return context[globalName];
}

const core = loadCore('session-status.js', 'RagentSessionStatusCore');

assert.equal(core.normalizeSessionWorkflowState('needs-input'), 'waiting_user');
assert.equal(core.normalizeSessionWorkflowPriority('P1'), 'high');
assert.deepEqual(JSON.parse(JSON.stringify(core.getWorkflowPriorityInfo('high'))), {
  key: 'high', rank: 3, labelKey: 'workflow.priority.high', labelRaw: 'High',
  titleKey: 'workflow.priority.highTitle', titleRaw: 'Needs user attention soon.',
});

const session = {
  id: 'status-core',
  workflowState: 'waiting_user',
  workflowStateChangedAt: '2026-03-14T12:00:00.000Z',
  lastAssistantMessageAt: '2026-03-14T12:00:00.000Z',
  lastReviewedAt: '2026-03-14T11:00:00.000Z',
  activity: {
    run: { state: 'idle' },
    queue: { state: 'idle', count: 0 },
    planning: { state: 'idle', count: 0 },
    compact: { state: 'idle' },
  },
};
assert.equal(core.hasSessionUnreadUpdate(session), true);
assert.equal(core.hasSessionNeedsAction(session), true);
assert.equal(core.getSessionAttentionBand(session), 0);
assert.equal(core.getSessionTaskFlowStage(session).key, 'waiting_user');
assert.equal(core.getSessionTaskFlowStage(session).labelKey, 'taskFlow.waitingUser');
assert.equal(core.getSessionTaskFlowStage(session).labelRaw, 'Waiting for your input');

const queued = core.getSessionStatusSummary({
  activity: { queue: { state: 'queued', count: 2 } },
});
assert.equal(queued.primary.key, 'queued');
assert.equal(queued.primary.labelKey, 'workflow.status.queued');
assert.equal(queued.primary.vars.count, 2);
assert.equal(queued.primary.titleRaw, '2 follow-ups queued');

assert.equal(core.resolveApprovalWaitingStatus({ kind: 'plan' }).key, 'plan_pending');
assert.equal(core.resolveApprovalWaitingStatus({ kind: 'question' }).key, 'awaiting_answer');
assert.equal(core.resolveApprovalWaitingStatus({ risk: 'danger' }).key, 'danger_pending');
assert.equal(core.resolveApprovalWaitingStatus({ kind: 'command' }).key, 'approval_pending');

assert.deepEqual(JSON.parse(JSON.stringify(core.getSessionReviewStatusInfo({
  id: 'unread',
  lastAssistantMessageAt: '2026-03-14T13:00:00.000Z',
  lastReviewedAt: '2026-03-14T12:00:00.000Z',
}))), {
  key: 'unread',
  labelKey: 'workflow.status.unread',
  labelRaw: 'new',
  titleKey: 'workflow.status.unreadTitle',
  titleRaw: 'Updated since you last reviewed this session',
  vars: {},
});
assert.equal(core.getSessionReviewStatusInfo({
  id: 'reviewed',
  lastAssistantMessageAt: '2026-03-14T12:00:00.000Z',
  lastReviewedAt: '2026-03-14T13:00:00.000Z',
}), null);

const sorted = [
  { id: 'unread-done', workflowState: 'done', lastEventAt: '2026-03-14T13:00:00.000Z', lastAssistantMessageAt: '2026-03-14T13:00:00.000Z', lastReviewedAt: '2026-03-14T12:00:00.000Z' },
  { id: 'running', lastEventAt: '2026-03-14T13:30:00.000Z', activity: { run: { state: 'running', startedAt: '2026-03-14T11:00:00.000Z' } } },
].sort(core.compareSessionListSessions);
assert.equal(sorted[0].id, 'unread-done');

console.log('test-chat-session-status-core: ok');
