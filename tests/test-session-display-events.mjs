#!/usr/bin/env node
import assert from 'assert/strict';
import {
  buildEventBlockEvents,
  buildSessionDisplayEvents,
  filterSessionDisplayPushEvents,
} from '../chat/session-display-events.mjs';
import { createClaudeFinalizedAssistantReplayFingerprint } from '../chat/provider-event-dedup.mjs';

const history = [
  { seq: 1, type: 'message', role: 'user', requestId: 'req-1', content: 'Inspect the timeline' },
  { seq: 2, type: 'reasoning', role: 'assistant', content: 'Reading the renderer. ' },
  { seq: 3, type: 'reasoning', role: 'assistant', content: 'Checking event identity.' },
  { seq: 4, type: 'message', role: 'assistant', runId: 'run-1', content: 'I found the first issue.' },
  { seq: 5, type: 'tool_use', role: 'assistant', runId: 'run-1', providerToolUseId: 'tool-1', toolName: 'bash', toolInput: 'rg timeline' },
  { seq: 6, type: 'tool_result', role: 'system', runId: 'run-1', providerToolUseId: 'tool-1', output: 'matches', exitCode: 0 },
  { seq: 7, type: 'message', role: 'assistant', runId: 'run-1', content: 'The operation stays between these two messages.' },
  { seq: 8, type: 'message', role: 'user', requestId: 'req-2', content: 'Continue' },
  { seq: 9, type: 'message', role: 'assistant', runId: 'run-2', content: 'Second turn.' },
];

const display = buildSessionDisplayEvents(history, { sessionRunning: false });
assert.deepEqual(
  display.map((event) => event.type),
  ['message', 'thinking_block', 'message', 'operation', 'message', 'message', 'message'],
  'the display projection must retain every visible chronological segment',
);
assert.deepEqual(
  display.map((event) => event.seq),
  [1, 2, 4, 5, 7, 8, 9],
  'layout sequence is sourced solely from durable history order',
);
assert.equal(display[1].blockEndSeq, 3, 'contiguous reasoning becomes one stable thinking entity');
assert.equal(display[3].startSeq, 5, 'an operation keeps its original tool-use position');
assert.equal(display[3].endSeq, 6, 'a result revises the operation instead of creating another row');
assert.equal(display[3].state, 'completed');
assert.equal(display[4].content, 'The operation stays between these two messages.');
assert.notEqual(
  display[2].timelineEntityId,
  display[4].timelineEntityId,
  'two assistant messages from one run are independent transcript entities',
);

const revisionHistory = [
  { seq: 1, type: 'message', role: 'assistant', streamItemId: 'provider-message-1', content: 'partial' },
  { seq: 2, type: 'message', role: 'assistant', streamItemId: 'provider-message-1', content: 'complete' },
];
const revisions = buildSessionDisplayEvents(revisionHistory);
assert.equal(revisions.length, 1, 'an explicit provider identity updates one display row');
assert.equal(revisions[0].content, 'complete');

const providerAliasHistory = [
  {
    seq: 10,
    type: 'message',
    role: 'assistant',
    runId: 'run-alias', canonicalMessageId: 'explicit-alias',
    providerItemId: 'live-item',
    content: 'The answer is',
  },
  {
    seq: 11,
    type: 'message',
    role: 'assistant',
    runId: 'run-alias', canonicalMessageId: 'explicit-alias',
    providerMessageId: 'final-message',
    content: 'The answer is ready.',
  },
];
const providerAliases = buildSessionDisplayEvents(providerAliasHistory);
assert.equal(providerAliases.length, 1, 'provider item and final message aliases must render as one durable row');
assert.equal(providerAliases[0].seq, 10, 'the first snapshot keeps the message position');
assert.equal(providerAliases[0].content, 'The answer is ready.', 'the final snapshot keeps the complete content');

const finalReplyWithPublishedAssets = buildSessionDisplayEvents([
  {
    seq: 20,
    type: 'message',
    role: 'assistant',
    runId: 'run-assets', canonicalMessageId: 'asset-answer',
    requestId: 'request-assets',
    responseId: 'response-assets',
    providerMessageId: 'final-message-assets',
    content: '正式结论：仿真验证已完成，问题定位为回调线程饥饿。',
  },
  {
    seq: 21,
    type: 'message',
    role: 'assistant',
    source: 'result_file_assets', canonicalMessageId: 'asset-answer', textMode: 'metadata',
    resultRunId: 'run-assets',
    requestId: 'request-assets',
    responseId: 'response-assets',
    content: '',
    attachments: [{ assetId: 'report-assets', originalName: 'report.md' }],
  },
]);
assert.equal(finalReplyWithPublishedAssets.length, 1, 'asset publication metadata should revise the final reply row');
assert.equal(
  finalReplyWithPublishedAssets[0].content,
  '正式结论：仿真验证已完成，问题定位为回调线程饥饿。',
  'an empty result_file_assets body must not erase the final assistant conclusion',
);
assert.equal(finalReplyWithPublishedAssets[0].attachments[0].assetId, 'report-assets');

const replayFingerprint = createClaudeFinalizedAssistantReplayFingerprint('claude-replay-session', '恢复辅助实例。');
const replayedSnapshots = buildSessionDisplayEvents([
  {
    seq: 30,
    type: 'message',
    role: 'assistant',
    runId: 'run-replay',
    provider: 'claude',
    runtimeFamily: 'claude-stream-json',
    providerSessionId: 'claude-replay-session',
    providerSnapshotKind: 'finalized-assistant',
    providerReplayFingerprint: replayFingerprint,
    content: '恢复辅助实例。',
  },
  { seq: 31, type: 'tool_use', role: 'assistant', runId: 'run-replay', providerToolUseId: 'tool-replay', toolName: 'Bash', toolInput: 'true' },
  { seq: 32, type: 'tool_result', role: 'system', runId: 'run-replay', providerToolUseId: 'tool-replay', output: 'ok', exitCode: 0 },
  {
    seq: 33,
    type: 'message',
    role: 'assistant',
    runId: 'run-replay',
    provider: 'claude',
    runtimeFamily: 'claude-stream-json',
    providerSessionId: 'claude-replay-session',
    providerSnapshotKind: 'finalized-assistant',
    providerReplayFingerprint: replayFingerprint,
    content: '恢复辅助实例。',
  },
]);
assert.equal(
  replayedSnapshots.filter((event) => event.type === 'message').length,
  1,
  'a persisted Claude replay fingerprint merges duplicate snapshots even when an operation separates them',
);
assert.equal(
  replayedSnapshots.filter((event) => event.type === 'operation').length,
  1,
  'cross-boundary replay merging keeps the original operation visible',
);

const legacyReplayedSnapshots = buildSessionDisplayEvents([
  {
    seq: 34,
    type: 'message',
    role: 'assistant',
    runId: 'run-legacy-replay',
    provider: 'claude',
    runtimeFamily: 'claude-stream-json',
    providerSessionId: 'claude-legacy-session',
    content: '旧记录也应去重。',
  },
  { seq: 35, type: 'tool_use', role: 'assistant', runId: 'run-legacy-replay', providerToolUseId: 'tool-legacy', toolName: 'Bash', toolInput: 'true' },
  { seq: 36, type: 'tool_result', role: 'system', runId: 'run-legacy-replay', providerToolUseId: 'tool-legacy', output: 'ok', exitCode: 0 },
  {
    seq: 37,
    type: 'message',
    role: 'assistant',
    runId: 'run-legacy-replay',
    provider: 'claude',
    runtimeFamily: 'claude-stream-json',
    providerSessionId: 'claude-legacy-session',
    content: '旧记录也应去重。',
  },
]);
assert.equal(
  legacyReplayedSnapshots.filter((event) => event.type === 'message').length,
  2,
  'legacy content alone cannot prove that two separate events are the same message',
);

const distinctSameText = buildSessionDisplayEvents([
  { seq: 40, type: 'message', role: 'assistant', runId: 'run-distinct', provider: 'claude', providerSessionId: 'claude-distinct', providerMessageId: 'message-a', content: '同样的正文。' },
  { seq: 41, type: 'message', role: 'assistant', runId: 'run-distinct', provider: 'claude', providerSessionId: 'claude-distinct', providerMessageId: 'message-b', content: '同样的正文。' },
]);
assert.equal(distinctSameText.length, 2, 'same text with distinct provider identities must remain visible as two messages');

// Claude finalized-assistant snapshots carry an explicit providerSnapshotKind
// marker. Relays re-emit such snapshots under a fresh message/frame id, so
// within one unbroken assistant segment of one run the marker unlocks
// bounded revision collapse (identical / contained / shifted-overlap bodies)
// without ever applying global text dedup to unmarked rows.
const claudeSnapshot = (seq, runId, messageId, content, extra = {}) => ({
  seq,
  type: 'message',
  role: 'assistant',
  runId,
  provider: 'claude',
  runtimeFamily: 'claude-stream-json',
  providerMessageId: messageId,
  providerSnapshotKind: 'finalized-assistant',
  providerSnapshot: true,
  providerSnapshotComplete: true,
  content,
  ...extra,
});

const markedIdenticalTwins = buildSessionDisplayEvents([
  claudeSnapshot(50, 'run-twins', 'msg-a', '同样的快照重发。'),
  claudeSnapshot(51, 'run-twins', 'msg-b', '同样的快照重发。'),
]);
assert.equal(markedIdenticalTwins.length, 2, 'distinct upstream ids remain distinct even with identical snapshot bodies');
assert.equal(markedIdenticalTwins[0].seq, 50, 'the first snapshot keeps the timeline position');
assert.equal(markedIdenticalTwins[0].content, '同样的快照重发。');

const shiftedReemission = buildSessionDisplayEvents([
  claudeSnapshot(52, 'run-shift', 'msg-c', 'Smoke replay 现在可以顺利通过了：状态 completed，任务 #1 已完成。'),
  claudeSnapshot(53, 'run-shift', 'msg-d', '可以顺利通过了：状态 completed，任务 #1 已完成。现在继续预处理确定性检查，并定位障碍物张量的代码路径。'),
]);
assert.equal(shiftedReemission.length, 2, 'overlapping text cannot establish a revision identity');
assert.equal(
  shiftedReemission[1].content,
  '可以顺利通过了：状态 completed，任务 #1 已完成。现在继续预处理确定性检查，并定位障碍物张量的代码路径。',
  'the longer revision body survives the collapse',
);

const unrelatedMarkedPair = buildSessionDisplayEvents([
  claudeSnapshot(54, 'run-unrel', 'msg-e', '第一条独立结论。'),
  claudeSnapshot(55, 'run-unrel', 'msg-f', '第二条不同方向的结论。'),
]);
assert.equal(unrelatedMarkedPair.length, 2, 'unrelated consecutive snapshots stay separate');

const userBoundarySeparates = buildSessionDisplayEvents([
  claudeSnapshot(56, 'run-bound', 'msg-g', '边界前的一段结论。'),
  { seq: 57, type: 'message', role: 'user', content: '继续' },
  claudeSnapshot(58, 'run-bound', 'msg-h', '边界前的一段结论。'),
]);
assert.equal(userBoundarySeparates.length, 3, 'a user message seals the snapshot chain even for identical bodies');

const thinkingBetween = buildSessionDisplayEvents([
  claudeSnapshot(59, 'run-think', 'msg-i', '推理后的同一段结论。'),
  { seq: 60, type: 'thinking_block', role: 'assistant', state: 'completed', content: '思考内容', blockStartSeq: 60, blockEndSeq: 60 },
  claudeSnapshot(61, 'run-think', 'msg-j', '推理后的同一段结论。'),
]);
assert.equal(
  thinkingBetween.filter((event) => event.type === 'message').length,
  2,
  'thinking does not make distinct upstream message ids aliases',
);

const markedSameIdRevision = buildSessionDisplayEvents([
  claudeSnapshot(62, 'run-grow', 'msg-k', 'Part one.'),
  claudeSnapshot(63, 'run-grow', 'msg-k', 'Part one. Part two.'),
]);
assert.equal(markedSameIdRevision.length, 1, 'same-id accumulating snapshots keep merging through the scope path');
assert.equal(markedSameIdRevision[0].content, 'Part one. Part two.');

const attachmentHistory = [
  { seq: 1, type: 'message', role: 'assistant', content: 'The file is ready.', attachments: [{ assetId: 'file-1', originalName: 'report.csv' }] },
];
const attachmentDisplay = buildSessionDisplayEvents(attachmentHistory);
assert.equal(attachmentDisplay.length, 1, 'attachments remain at their message position instead of moving to the end of a turn');
assert.equal(attachmentDisplay[0].attachments[0].assetId, 'file-1');

const hiddenPrompt = { seq: 2, type: 'message', role: 'system', systemPromptKey: 'agent.perMessageSystemPrompt', content: 'internal' };
const visible = buildSessionDisplayEvents([
  { seq: 1, type: 'message', role: 'user', content: 'hello' },
  hiddenPrompt,
  { seq: 3, type: 'status', role: 'system', content: 'thinking' },
  { seq: 4, type: 'status', role: 'system', content: 'Preparing environment' },
]);
assert.deepEqual(visible.map((event) => event.seq), [1, 4], 'internal prompts and transport-only status records stay outside the timeline');

const compacted = buildSessionDisplayEvents([
  { seq: 1, type: 'message', role: 'user', content: 'hello' },
  { seq: 2, type: 'context_barrier', role: 'system', content: 'Internal context marker' },
  { seq: 3, type: 'message', role: 'assistant', source: 'context_compaction_handoff', content: 'Internal handoff' },
  { seq: 4, type: 'message', role: 'assistant', content: 'Visible answer' },
]);
assert.deepEqual(compacted.map((event) => event.seq), [1, 4], 'compaction internals must not appear as conversation messages');

const plan = '<ragent-collaboration-plan>{"schemaVersion":1}</ragent-collaboration-plan>';
const pushed = [
  ...filterSessionDisplayPushEvents([{ type: 'text_delta', role: 'assistant', runId: 'run-live', text: `Visible ${plan.slice(0, 18)}` }]),
  ...filterSessionDisplayPushEvents([{ type: 'text_delta', role: 'assistant', runId: 'run-live', text: `${plan.slice(18)} tail` }]),
];
assert.deepEqual(pushed.map((event) => event.text), ['Visible ', ' tail'], 'live protocol control blocks remain hidden across delta boundaries');

const [approved] = filterSessionDisplayPushEvents([{
  type: 'approved_action_batch_request',
  batchId: 'batch-1',
  actions: [{ actionId: 'act-1', operation: 'agent.create', agentPayload: { systemPrompt: 'private' }, semanticProjection: { proof: 'private' } }],
}]);
assert.equal(approved.actions[0].agentPayload, undefined, 'executor payload is removed from client projection');
assert.equal(approved.actions[0].semanticProjection, undefined, 'semantic proof is removed from client projection');

const block = buildEventBlockEvents(history, 2, 6);
assert.deepEqual(block.map((event) => event.type), ['reasoning', 'reasoning', 'message', 'tool_use', 'tool_result']);

console.log('test-session-display-events: ok');
