#!/usr/bin/env node

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const context = { console, Map, Set, JSON, Number, String, Math, Object, Array };
context.globalThis = context;
vm.runInNewContext(
  readFileSync(join(repoRoot, 'static/chat/core/timeline-projector.js'), 'utf8'),
  context,
  { filename: 'timeline-projector.js' },
);

const { TimelineProjector } = context.RagentTimelineProjector;
const projector = new TimelineProjector({ sessionId: 'timeline-a' });

let snapshot = projector.replace([
  { id: 'u1', seq: 1, type: 'message', role: 'user', timelineEntityId: 'message:user:req-1', content: 'Inspect this' },
  { id: 'a1', seq: 2, type: 'message', role: 'assistant', runId: 'run-1', timelineEntityId: 'message:assistant:segment-1', content: 'I will inspect it.' },
  { id: 'op-start', seq: 3, type: 'operation', operationId: 'op-1', timelineEntityId: 'operation:op-1', state: 'running', detail: 'Reading files' },
  { id: 'a2', seq: 4, type: 'message', role: 'assistant', runId: 'run-1', timelineEntityId: 'message:assistant:segment-2', content: 'The entry point is here.' },
  { id: 'op-done', seq: 5, type: 'operation', operationId: 'op-1', timelineEntityId: 'operation:op-1', state: 'completed', detail: 'Read complete' },
], { latestSeq: 5, pagination: { hasMoreBefore: true, nextBeforeSeq: 1 } });

assert.deepEqual(
  JSON.parse(JSON.stringify(snapshot.items.map((item) => item.id))),
  ['message:user:req-1', 'message:assistant:segment-1', 'operation:op-1', 'message:assistant:segment-2'],
  'durable pages preserve user, assistant, and operation chronology without run-level merging',
);
assert.equal(snapshot.items[2].event.state, 'completed', 'a revision updates its operation entity instead of appending a second row');

snapshot = projector.replaceDurable([
  { id: 'usage-6', seq: 6, type: 'usage', contextTokens: 128 },
], { latestSeq: 6 });
assert.equal(snapshot.items.some((item) => item.event.type === 'usage'), false, 'usage is timeline metadata, not a transcript row');
assert.equal(snapshot.latestSeq, 6, 'metadata still advances the durable cursor');

snapshot = projector.replaceDurable([
  {
    id: 'batch-request-7',
    seq: 7,
    type: 'privileged_batch_request',
    batchId: 'batch-7',
    providerCapabilities: { supportsTextDelta: true, permissionModes: ['danger-full-access'] },
  },
  {
    id: 'unknown-8',
    seq: 8,
    type: 'provider_runtime_capabilities_v2',
    permissionModes: ['danger-full-access'],
  },
], { latestSeq: 8 });
assert.equal(snapshot.items.some((item) => item.event.type === 'privileged_batch_request'), false, 'approval protocol events are not transcript rows');
assert.equal(snapshot.items.some((item) => item.event.type === 'provider_runtime_capabilities_v2'), false, 'unknown protocol events are not transcript rows');
assert.equal(snapshot.latestSeq, 8, 'control and unknown events still advance the durable cursor');

snapshot = projector.ingest([
  { id: 'delta-1', type: 'text_delta', role: 'assistant', runId: 'run-2', text: 'Streaming ' },
  { id: 'delta-2', type: 'text_delta', role: 'assistant', runId: 'run-2', text: 'reply' },
]);
assert.equal(snapshot.items.at(-1).id, 'message:assistant:live:run-2:segment:0');
assert.equal(snapshot.items.at(-1).event.content, 'Streaming reply');

const replaySafe = new TimelineProjector({ sessionId: 'timeline-replay' });
const stableDelta = {
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-replay',
  providerItemId: 'message-replay',
  providerEventId: 'agent-message:message-replay:1',
  text: '修复路径已经能通过现有用例。',
};
replaySafe.ingest([stableDelta]);
let replaySnapshot = replaySafe.ingest([stableDelta]);
assert.equal(replaySnapshot.items.length, 1, 'a replayed immutable delta must not append a duplicate paragraph');
assert.equal(replaySnapshot.items[0].event.content, stableDelta.text);
replaySnapshot = replaySafe.ingest([{
  ...stableDelta,
  providerEventId: 'agent-message:message-replay:2',
  text: '。',
}]);
assert.equal(replaySnapshot.items[0].event.content, `${stableDelta.text}。`, 'a new delta may repeat a character without being dropped');

const overlapSafe = new TimelineProjector({ sessionId: 'timeline-overlap' });
const firstOverlap = {
  id: 'local-delta-1',
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-overlap',
  providerEventId: 'provider-overlap-1',
  text: 'The answer is ready to ship',
};
overlapSafe.ingest([firstOverlap]);
let overlapSnapshot = overlapSafe.ingest([{
  id: 'local-delta-2',
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-overlap',
  providerEventId: 'provider-overlap-2',
  text: 'ready to ship today.',
}]);
assert.equal(
  overlapSnapshot.items[0].event.content,
  'The answer is ready to ship today.',
  'overlapping provider windows must append only their unseen suffix',
);
overlapSnapshot = overlapSafe.ingest([{
  id: 'local-replay-1',
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-overlap',
  providerEventId: firstOverlap.providerEventId,
  text: firstOverlap.text,
}]);
assert.equal(overlapSnapshot.changeSet.acceptedEvents.length, 0, 'provider event replay must be ignored even when its local id changes');
assert.equal(overlapSnapshot.items[0].event.content, 'The answer is ready to ship today.');
overlapSnapshot = overlapSafe.ingest([{
  id: 'local-stale-1',
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-overlap',
  providerEventId: 'provider-overlap-stale',
  text: 'The answer is ready to ship',
}]);
assert.equal(overlapSnapshot.items[0].event.content, 'The answer is ready to ship today.', 'a stale cumulative prefix must not be appended again');

const shortDelta = new TimelineProjector({ sessionId: 'timeline-short-delta' });
shortDelta.ingest([{
  id: 'short-delta-1',
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-short-delta',
  text: 'a useful answer',
}]);
const shortDeltaSnapshot = shortDelta.ingest([{
  id: 'short-delta-2',
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-short-delta',
  text: 'a',
}]);
assert.equal(shortDeltaSnapshot.items[0].event.content, 'a useful answera', 'short real deltas must not be mistaken for stale prefixes');

// Large replay windows used to be compared by creating one suffix slice per
// possible character.  Verify that the linear overlap path keeps the exact
// 96 KiB boundary rather than duplicating it or trimming real output.
const largeOverlap = new TimelineProjector({ sessionId: 'timeline-large-overlap' });
const largeSharedTail = 'x'.repeat(96 * 1024);
largeOverlap.ingest([{
  id: 'large-overlap-first', type: 'text_delta', role: 'assistant', runId: 'run-large-overlap',
  text: `opening:${largeSharedTail}`,
}]);
const largeOverlapSnapshot = largeOverlap.ingest([{
  id: 'large-overlap-second', type: 'text_delta', role: 'assistant', runId: 'run-large-overlap',
  text: `${largeSharedTail}:closed`,
}]);
assert.equal(
  largeOverlapSnapshot.items[0].event.content,
  `opening:${largeSharedTail}:closed`,
  'large overlapping windows must settle exactly without a quadratic suffix scan',
);

// Tool payloads can be much larger than the visible delta.  Identity should
// remain bounded while a new provider event is still accepted and rendered.
const nestedPayload = new TimelineProjector({ sessionId: 'timeline-nested-payload' });
const deepPayload = { value: 'payload' };
for (let index = 0; index < 12; index += 1) deepPayload.next = { index, blob: 'y'.repeat(8192), child: deepPayload.value };
nestedPayload.ingest([{
  id: 'nested-payload-1', providerEventId: 'nested-payload-1', type: 'text_delta', role: 'assistant',
  runId: 'run-nested-payload', text: 'first', toolInput: deepPayload,
}]);
const nestedPayloadSnapshot = nestedPayload.ingest([{
  id: 'nested-payload-2', providerEventId: 'nested-payload-2', type: 'text_delta', role: 'assistant',
  runId: 'run-nested-payload', text: ' second', toolInput: deepPayload,
}]);
assert.equal(nestedPayloadSnapshot.items[0].event.content, 'first second');

const completeOverlap = new TimelineProjector({ sessionId: 'timeline-complete-overlap' });
completeOverlap.ingest([{
  id: 'complete-live-delta',
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-complete-overlap',
  text: 'The answer is ready to ship',
}]);
const completeOverlapSnapshot = completeOverlap.ingest([{
  id: 'complete-live-message',
  type: 'message',
  role: 'assistant',
  runId: 'run-complete-overlap',
  providerMessageId: 'provider-complete-overlap',
  content: 'ready to ship today.',
}]);
assert.equal(completeOverlapSnapshot.items.length, 1, 'a completion with an overlapped window must reuse the live row');
assert.equal(completeOverlapSnapshot.items[0].event.content, 'The answer is ready to ship today.');

const providerAlias = new TimelineProjector({ sessionId: 'timeline-provider-alias' });
providerAlias.ingest([{
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-provider-alias',
  providerItemId: 'provider-live-item',
  requestId: 'request-provider-alias',
  text: 'Codex output',
}]);
let providerAliasSnapshot = providerAlias.replaceDurable([{
  id: 'durable-provider-message',
  seq: 1,
  type: 'message',
  role: 'assistant',
  runId: 'run-provider-alias',
  providerMessageId: 'provider-live-item',
  requestId: 'request-provider-alias',
  content: 'Codex output',
}], { latestSeq: 1 });
assert.equal(providerAliasSnapshot.items.length, 1, 'provider item/message aliases must settle into one row');

const liveCompleteAlias = new TimelineProjector({ sessionId: 'timeline-live-complete-alias' });
liveCompleteAlias.ingest([{
  id: 'delta-ssh',
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-ssh',
  providerItemId: 'stream-item-ssh',
  text: 'SSH 引号转义出了问题，改用脚本文件方式查询：',
}]);
const liveCompleteAliasSnapshot = liveCompleteAlias.ingest([{
  id: 'complete-ssh',
  type: 'message',
  role: 'assistant',
  runId: 'run-ssh',
  providerMessageId: 'final-message-ssh',
  content: 'SSH 引号转义出了问题，改用脚本文件方式查询：',
}]);
assert.equal(liveCompleteAliasSnapshot.items.length, 1, 'delta and complete events from one run must share one live row');
assert.equal(liveCompleteAliasSnapshot.items[0].event.content, 'SSH 引号转义出了问题，改用脚本文件方式查询：');

const emptyCompletionGuard = new TimelineProjector({ sessionId: 'timeline-empty-completion' });
emptyCompletionGuard.ingest([{
  id: 'empty-completion-delta',
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-empty-completion',
  providerItemId: 'stream-empty-completion',
  text: 'This streamed answer must remain visible.',
}]);
const emptyCompletionSnapshot = emptyCompletionGuard.replaceDurable([{
  id: 'empty-completion-final',
  seq: 1,
  type: 'message',
  role: 'assistant',
  runId: 'run-empty-completion',
  providerMessageId: 'stream-empty-completion',
  content: '',
}], { latestSeq: 1 });
assert.equal(emptyCompletionSnapshot.items.length, 1, 'an empty durable completion must settle into the live row');
assert.equal(emptyCompletionSnapshot.items[0].event.content, 'This streamed answer must remain visible.');

// Result-file publication follows the final assistant message with an empty
// assistant event that only carries attachments/rewrite metadata.  It shares
// the run scope, so it must enrich the settled row without replacing its text.
const resultAssetGuard = new TimelineProjector({ sessionId: 'timeline-result-assets' });
const resultAssetSnapshot = resultAssetGuard.replaceDurable([
  {
    id: 'result-final',
    seq: 10,
    type: 'message',
    role: 'assistant',
    runId: 'run-result-assets',
    responseId: 'response-result-assets',
    requestId: 'request-result-assets',
    content: '正式总结：文件已经生成并完成校验。',
  },
  {
    id: 'result-assets',
    seq: 11,
    type: 'message',
    role: 'assistant',
    source: 'result_file_assets',
    resultRunId: 'run-result-assets',
    responseId: 'response-result-assets',
    requestId: 'request-result-assets',
    content: '',
    attachments: [{ assetId: 'asset-1' }],
  },
], { latestSeq: 11 });
assert.equal(resultAssetSnapshot.items.length, 1, 'result asset metadata must not add a blank assistant row');
assert.equal(resultAssetSnapshot.items[0].event.content, '正式总结：文件已经生成并完成校验。');
assert.deepEqual(resultAssetSnapshot.items[0].event.attachments, [{ assetId: 'asset-1' }]);

const liveDifferentRun = new TimelineProjector({ sessionId: 'timeline-live-different-run' });
liveDifferentRun.ingest([{
  id: 'live-a', type: 'text_delta', role: 'assistant', runId: 'run-a', text: 'Same text',
}]);
const liveDifferentRunSnapshot = liveDifferentRun.ingest([{
  id: 'live-b', type: 'message', role: 'assistant', runId: 'run-b', content: 'Same text',
}]);
assert.equal(liveDifferentRunSnapshot.items.length, 2, 'identical text from different live runs must remain separate');

const runAlias = new TimelineProjector({ sessionId: 'timeline-run-alias' });
runAlias.ingest([{
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-shared',
  providerItemId: 'provider-live',
  text: 'Shared run output',
}]);
providerAliasSnapshot = runAlias.replaceDurable([{
  id: 'durable-run-message',
  seq: 1,
  type: 'message',
  role: 'assistant',
  runId: 'run-shared',
  providerMessageId: 'provider-durable',
  content: 'Shared run output',
}], { latestSeq: 1 });
assert.equal(providerAliasSnapshot.items.length, 1, 'different provider ids may reconcile inside one run');

const differentRun = new TimelineProjector({ sessionId: 'timeline-different-run' });
differentRun.ingest([{
  type: 'text_delta', role: 'assistant', runId: 'run-live', text: 'Same text',
}]);
const differentRunSnapshot = differentRun.replaceDurable([{
  id: 'durable-other-run', seq: 1, type: 'message', role: 'assistant', runId: 'run-durable', content: 'Same text',
}], { latestSeq: 1 });
assert.equal(differentRunSnapshot.items.length, 2, 'different runs must never reconcile by text alone');

const sendRace = new TimelineProjector({ sessionId: 'timeline-send-race' });
sendRace.replace([
  { id: 'before-send', seq: 10, type: 'message', role: 'assistant', content: 'Earlier output' },
], { latestSeq: 10 });
sendRace.ingest([{
  id: 'first-live-token',
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-send-race',
  text: 'Answer starts before the HTTP user event arrives.',
}]);
const sendRaceSnapshot = sendRace.replaceDurable([{
  id: 'sent-user',
  seq: 11,
  type: 'message',
  role: 'user',
  requestId: 'request-send-race',
  content: 'New question',
}], { latestSeq: 11 });
assert.deepEqual(
  JSON.parse(JSON.stringify(sendRaceSnapshot.items.map((item) => item.kind))),
  ['message', 'message', 'message'],
  'the send race should still contain the prior message, user message, and live assistant row',
);
assert.equal(sendRaceSnapshot.items[1].event.role, 'user',
  'a durable user event must precede a same-sequence live assistant overlay');
assert.equal(sendRaceSnapshot.items[2].source, 'live');

const liveId = snapshot.items.at(-1).id;
snapshot = projector.replaceDurable([
  { id: 'a3', seq: 6, type: 'message', role: 'assistant', runId: 'run-2', content: 'Streaming reply', revision: 1 },
], { latestSeq: 6 });
assert.equal(snapshot.items.at(-1).id, liveId, 'durable completion adopts the streaming entity instead of duplicating text');
assert.equal(snapshot.items.filter((item) => item.id === liveId).length, 1);
assert.equal(snapshot.items.at(-1).event.content, 'Streaming reply');

const segmented = new TimelineProjector({ sessionId: 'timeline-segments' });
segmented.replace([
  { id: 'segment-user', seq: 1, type: 'message', role: 'user', content: 'Inspect' },
], { latestSeq: 1 });
segmented.ingest([{ id: 'segment-delta-1', type: 'text_delta', role: 'assistant', runId: 'run-segment', text: 'Before the command.' }]);
segmented.replaceDurable([
  { id: 'segment-op', seq: 2, type: 'operation', operationId: 'op-segment', runId: 'run-segment', state: 'completed', detail: 'Command completed' },
], { latestSeq: 2 });
snapshot = segmented.ingest([{ id: 'segment-delta-2', type: 'text_delta', role: 'assistant', runId: 'run-segment', text: 'After the command.' }]);
assert.deepEqual(
  JSON.parse(JSON.stringify(snapshot.items.map((item) => item.kind))),
  ['message', 'message', 'operation', 'message'],
  'a durable operation seals the current live message segment before later stream text arrives',
);
assert.equal(snapshot.items[1].event.content, 'Before the command.');
assert.equal(snapshot.items[3].event.content, 'After the command.');
assert.notEqual(snapshot.items[1].id, snapshot.items[3].id, 'stream text on opposite sides of an operation must never share a render entity');

snapshot = projector.replaceDurable([
  { id: 'older', seq: 0, startSeq: 0, endSeq: 0, type: 'message', role: 'user', timelineEntityId: 'message:user:older', content: 'ignored' },
  { id: 'older-real', seq: 1, type: 'message', role: 'user', timelineEntityId: 'message:user:older-real', content: 'Earlier request' },
], { pagination: { hasMoreBefore: false, nextBeforeSeq: null }, paginationMode: 'before' });
assert.equal(snapshot.items[0].id, 'message:user:older-real', 'older durable pages prepend by sequence without moving later entities');
assert.equal(snapshot.hasMoreBefore, false);

projector.replace([{ id: 'fresh-user', seq: 1, type: 'message', role: 'user', timelineEntityId: 'message:user:fresh', content: 'Fresh session' }], {
  sessionId: 'timeline-b',
  latestSeq: 1,
});
snapshot = projector.ingest([{ id: 'fresh-delta', type: 'text_delta', role: 'assistant', runId: 'run-fresh', text: 'Hello' }]);
assert.deepEqual(
  JSON.parse(JSON.stringify(snapshot.items.map((item) => item.id))),
  ['message:user:fresh', 'message:assistant:live:run-fresh:segment:0'],
  'session replacement clears every prior durable and live entity',
);

// A long final summary streams over WS while the following page fetch already
// carries durable tool activity (and a mid-run user message). The streamed
// row borrows a provisional sequence; when the authoritative message lands it
// must settle at its real sequence — below the activity of its own run — and
// every provisional fragment of the stream must be retired, never duplicated.
const streamed = new TimelineProjector({ sessionId: 'timeline-stream' });
streamed.replace([
  { seq: 100, type: 'message', role: 'user', content: '帮我修一下这个 bug' },
  { seq: 101, type: 'message', role: 'assistant', runId: 'run-a', content: '修好了。' },
], { latestSeq: 101 });
streamed.ingest([{ type: 'text_delta', role: 'assistant', runId: 'run-b', text: '这是一条很长的收' }]);
const streamedRefresh = streamed.replaceDurable([
  { seq: 103, type: 'operation', operationId: 'op-1', runId: 'run-b', state: 'completed', title: 'Bash: npm test' },
  { seq: 105, type: 'operation', operationId: 'op-2', runId: 'run-b', state: 'completed', title: 'Read src/a.js' },
  { seq: 107, type: 'message', role: 'user', content: 'run 中间插入的新问题' },
  { seq: 109, type: 'operation', operationId: 'op-3', runId: 'run-b', state: 'completed', title: 'Bash: git commit' },
], { latestSeq: 109 });
assert.deepEqual(
  JSON.parse(JSON.stringify(streamedRefresh.items.map((item) => item.event.role ?? item.event.type))),
  ['user', 'assistant', 'assistant', 'operation', 'operation', 'user', 'operation'],
  'a mid-run user message keeps its authoritative place between the run activity',
);
streamed.ingest([{ type: 'text_delta', role: 'assistant', runId: 'run-b', text: '结：全部完成。' }]);
const streamedSettled = streamed.replaceDurable([
  { seq: 120, type: 'message', role: 'assistant', runId: 'run-b', content: '这是一条很长的收结：全部完成。' },
], { latestSeq: 120 });
assert.equal(streamedSettled.items.length, 7, 'the settled message retires every provisional stream fragment');
assert.deepEqual(
  JSON.parse(JSON.stringify(streamedSettled.items.map((item) => item.startSeq))),
  [100, 101, 103, 105, 107, 109, 120],
  'the streamed answer settles at its durable sequence, below its own run activity',
);
assert.equal(streamedSettled.items.at(-1).event.content, '这是一条很长的收结：全部完成。');
assert.equal(
  streamedSettled.items.filter((item) => String(item.event?.content || '').includes('全部完成')).length,
  1,
  'streamed text must not survive as a duplicate fragment next to the settled row',
);

// Live rows borrow sequences above everything seen; a fresh stream must never
// re-hand-out a sequence a durable event already realized.
const allocation = new TimelineProjector({ sessionId: 'timeline-alloc' });
allocation.replace([{ seq: 10, type: 'message', role: 'user', content: 'Q' }], { latestSeq: 10 });
allocation.ingest([{ type: 'text_delta', role: 'assistant', runId: 'run-alloc', text: 'part one' }]);
const afterOps = allocation.replaceDurable([
  { seq: 11, type: 'operation', operationId: 'op-alloc', runId: 'run-alloc', state: 'completed', title: 'Bash' },
], { latestSeq: 11 });
allocation.ingest([{ type: 'text_delta', role: 'assistant', runId: 'run-alloc', text: 'part two' }]);
const seqs = afterOps.items.map((item) => item.startSeq);
const tailSeq = allocation.snapshot().items.at(-1).startSeq;
assert.ok(tailSeq > Math.max(...seqs), 'new live rows allocate above every sequence already rendered');

// Sequence-free provider overlays must remain bounded even when a reconnect
// replays many distinct stream items. Large text identities are also clipped
// before dedupe bookkeeping so they cannot monopolize the browser heap.
const boundedLive = new TimelineProjector({ sessionId: 'timeline-live-budget' });
const hugeDelta = 'x'.repeat(700 * 1024);
boundedLive.ingest([{ type: 'text_delta', role: 'assistant', runId: 'run-huge', providerEventId: 'huge-0', text: hugeDelta }]);
for (let index = 1; index < 2200; index += 1) {
  boundedLive.ingest([{
    type: 'text_delta',
    role: 'assistant',
    runId: 'run-many',
    providerEventId: `many-${index}`,
    text: 'delta',
  }]);
}
const boundedLiveSnapshot = boundedLive.snapshot();
assert.ok(boundedLiveSnapshot.items.length <= 2048, 'live overlay entities must stay bounded');
assert.ok(
  boundedLiveSnapshot.items.some((item) => String(item.event?.content || '').includes('live output trimmed')),
  'a giant live response must be clipped before it can grow without bound',
);

await (async () => {
  const { default: assertMod } = await import('node:assert/strict');
  await import('../static/chat/core/timeline-projector.js');
  const { TimelineProjector } = globalThis.RagentTimelineProjector;
  const projector = new TimelineProjector({ sessionId: 'async-proj-sess' });

  projector.ingest([{ type: 'text_delta', role: 'assistant', runId: 'run-a1', itemId: 'prose-1', text: 'Inspecting workspace...' }]);
  const first = projector.replaceDurable([
    { seq: 1, type: 'message', role: 'assistant', runId: 'run-a1', itemId: 'followup-1', content: 'Async note', delivery: 'async' },
    {
      seq: 2,
      type: 'message',
      role: 'assistant',
      runId: 'run-a1',
      itemId: 'ask-1',
      content: '',
      messageDelivery: 'async',
      asyncQuestions: [{ id: 'q-async-1', index: 0, question: 'Target branch?', status: 'pending' }],
    },
    {
      seq: 3,
      type: 'message',
      role: 'user',
      content: '<send_user_message_question_reply>[{"questionItemId":"q-async-1","question":"Target branch?","answer":"main"}]</send_user_message_question_reply>',
      answeredQuestionItemIds: ['q-async-1'],
      asyncQuestionReplies: [{ questionItemId: 'q-async-1', question: 'Target branch?', answer: 'main' }],
    },
  ]);

  assertMod.equal(first.items.length, 4, 'live prose, followup async note, async question card, and user reply remain distinct items');
  const askItem = first.items.find((i) => i.event?.itemId === 'ask-1');
  assertMod.equal(askItem.event.messageDelivery, 'async');
  assertMod.equal(askItem.event.asyncQuestions[0].status, 'pending');
  const userItem = first.items.find((i) => i.event?.role === 'user');
  assertMod.deepEqual(userItem.event.answeredQuestionItemIds, ['q-async-1']);
  assertMod.equal(userItem.event.asyncQuestionReplies[0].answer, 'main');

  // Re-applying durable snapshot with answered status updates askItem cleanly
  const second = projector.replaceDurable([
    {
      seq: 2,
      type: 'message',
      role: 'assistant',
      runId: 'run-a1',
      itemId: 'ask-1',
      content: '',
      messageDelivery: 'async',
      asyncQuestions: [{ id: 'q-async-1', index: 0, question: 'Target branch?', status: 'answered', answeredText: 'main' }],
    },
  ]);
  const updatedAsk = second.items.find((i) => i.event?.itemId === 'ask-1');
  assertMod.equal(updatedAsk.event.asyncQuestions[0].status, 'answered');
  assertMod.equal(updatedAsk.event.asyncQuestions[0].answeredText, 'main');
})();

console.log('test-chat-timeline-projector: ok');
