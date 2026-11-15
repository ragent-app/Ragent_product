#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
function loadFixture(name) {
  return JSON.parse(readFileSync(join(repoRoot, 'tests/fixtures/session-events', name), 'utf8'));
}
const context = { console };
context.globalThis = context;
vm.runInNewContext(readFileSync(join(repoRoot, 'static/chat/core/event-sync.js'), 'utf8'), context, { filename: 'event-sync.js' });
const core = context.RagentEventSyncCore;
assert.ok(core, 'event sync core should attach its pure API');

const complete = loadFixture('01-streaming-run-complete.json');
assert.equal(core.getLatestEventSeq(complete.events), complete.expected.nextRenderedLatestSeq);
assert.deepEqual(complete.events.map(core.getEventRenderKey), complete.expected.renderKeys);
assert.equal(
  core.getEventRenderKey({ seq: 8, type: 'thinking_block', state: 'running', blockEndSeq: 11 }, { runningBlockExpanded: true }),
  '8:thinking_block:running:11',
);
assert.deepEqual(
  core.filterUnrenderedPersistentEvents(complete.events, complete.initialRenderedLatestSeq, 0).events,
  complete.events,
);

const merged = loadFixture('02-merged-assistant-run-reset.json');
assert.equal(
  core.displayProjectionSupersedesRenderedEvent(
    [merged.serverStateAfterMerge.mergedMessage],
    merged.clientDeltaRequest.afterSeq,
  ),
  merged.expectedDeltaResponse.resetRequired,
);

const realtime = loadFixture('03-ws-push-then-http-delta.json');
const first = core.deduplicateRealtimeEvents(realtime.wsPush.events);
const replay = core.deduplicateRealtimeEvents(realtime.wsPush.events, first.seenProviderEventIds);
assert.deepEqual(JSON.parse(JSON.stringify(first.events.map((event) => event.providerEventId))), ['td_0001', 'td_0002']);
assert.equal(replay.events.length, 0);
assert.deepEqual(
  core.filterUnrenderedPersistentEvents([], realtime.afterWsRender.nextRenderedLatestSeq, realtime.afterWsRender.nextRenderedLatestSeq).events,
  realtime.httpDeltaAfterWs.response.events,
);

console.log('test-chat-event-sync-core: ok');
