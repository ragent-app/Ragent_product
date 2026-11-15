#!/usr/bin/env node
// tests/test-chat-ws-events-core.mjs
//
// Stage 2: ws-events core (static/chat/transport/ws-events.js) is a DOM-free
// port of realtime.js's incoming-event pipeline (dedup + text-stream state
// machine + status scrubbing + approval-error classification). Every scenario
// runs against BOTH implementations with identical event sequences and
// compares primitive-level outputs, so the port cannot drift from the legacy
// normalization semantics.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function loadLegacy(withVisitorMode) {
  const context = {
    console,
    Map,
    Set,
    Date,
    Promise,
    Error,
    window: { addEventListener() {} },
  };
  if (withVisitorMode) {
    context.withVisitorModeUrl = (path) => `/visitor${path}`;
  }
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8'),
    context,
    { filename: 'realtime.js' },
  );
  return {
    api: {
      resolveWsUrl: (path) => context.resolveWsUrl(path),
      filterRealtimeSessionEvents: (events, sessionId) => context.filterRealtimeSessionEvents(events, sessionId),
      filterRealtimePersistentEvents: (events) => context.filterRealtimePersistentEvents(events),
      isApprovalAlreadyEndedError: (error) => context.isApprovalAlreadyEndedError(error),
    },
    label: 'legacy',
  };
}

function loadCore(withVisitorMode) {
  const context = {
    console,
    Map,
    Set,
    Date,
    Promise,
    Error,
    RagentWsEventsEnvironment: withVisitorMode
      ? { withVisitorModeUrl: (path) => `/visitor${path}` }
      : {},
  };
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/ws-events.js'), 'utf8'),
    context,
    { filename: 'transport/ws-events.js' },
  );
  const core = context.RagentWsEventsCore;
  return {
    api: {
      resolveWsUrl: (path) => core.resolveWsUrl(path),
      filterRealtimeSessionEvents: (events, sessionId) => core.filterRealtimeSessionEvents(events, sessionId),
      filterRealtimePersistentEvents: (events) => core.filterRealtimePersistentEvents(events),
      isApprovalAlreadyEndedError: (error) => core.isApprovalAlreadyEndedError(error),
    },
    label: 'transport',
  };
}

function textDelta(overrides = {}) {
  return {
    type: 'text_delta',
    runtimeFamily: 'claude-stream-json',
    runId: 'run-1',
    responseId: 'resp-1',
    blockIndex: 0,
    text: '',
    providerEventId: 'prov-1',
    ...overrides,
  };
}

function assistantMessage(overrides = {}) {
  return {
    type: 'message',
    role: 'assistant',
    runId: 'run-1',
    responseId: 'resp-1',
    blockIndex: 0,
    ...overrides,
  };
}

async function runScenario(api, withVisitorMode) {
  const out = {};

  // 1. Channel URL resolution.
  out.wsUrl = {
    plain: api.resolveWsUrl('/ws'),
    empty: api.resolveWsUrl(''),
    visitor: api.resolveWsUrl('/ws/events'),
  };

  // 2. Text-stream accumulation: consecutive deltas for the same stream are
  //    merged into suffix emission.
  out.stream = api.filterRealtimeSessionEvents([
    textDelta({ text: 'Hel', providerEventId: 'p1' }),
    textDelta({ text: 'lo, ', providerEventId: 'p2' }),
    textDelta({ text: 'world', providerEventId: 'p3' }),
    { type: 'status', content: 'Session started (claude-3-5-sonnet)' },
  ], 's1');

  // 3. Replay overlap: a chunk that overlaps already-streamed text emits only
  //    the minimal suffix.
  out.overlap = api.filterRealtimeSessionEvents([
    textDelta({ text: 'lo, world again', providerEventId: 'p4', blockIndex: 1 }),
  ], 's1');

  // 4. Batch-signature dedup: the identical group replayed emits nothing.
  out.replay = api.filterRealtimeSessionEvents([
    textDelta({ text: 'Hel', providerEventId: 'p5', blockIndex: 2 }),
    textDelta({ text: 'lo, ', providerEventId: 'p6', blockIndex: 2 }),
  ], 's1');
  out.replaySecond = api.filterRealtimeSessionEvents([
    textDelta({ text: 'Hel', providerEventId: 'p7', blockIndex: 2 }),
    textDelta({ text: 'lo, ', providerEventId: 'p8', blockIndex: 2 }),
  ], 's1');

  // 5. Finalized streams: an assistant message closes the stream; later
  //    deltas for it are rejected.
  out.finalize = api.filterRealtimeSessionEvents([
    assistantMessage({ content: 'done' }),
    textDelta({ text: 'ignored', providerEventId: 'p9', blockIndex: 3 }),
  ], 's1');

  // 6. providerEventId dedup: the same id replayed is dropped.
  out.dedup = api.filterRealtimeSessionEvents([
    textDelta({ text: 'x', providerEventId: 'dup-1', blockIndex: 4 }),
    textDelta({ text: 'x', providerEventId: 'dup-1', blockIndex: 4 }),
  ], 's1');

  // 7. Session switch resets all streams and seen ids.
  out.switch = api.filterRealtimeSessionEvents([
    textDelta({ text: 'fresh', providerEventId: 'p10', blockIndex: 0 }),
  ], 's2');

  // 8. Status scrubbing: session-started markers are dropped, other status
  //    events and non-status events pass through.
  out.scrub = api.filterRealtimeSessionEvents([
    { type: 'status', content: 'Session started (claude-3-5-sonnet)' },
    { type: 'status', content: 'Session started (custom)' },
    { type: 'status', providerLifecycle: 'session_started', content: 'x' },
    { type: 'status', content: 'Working on it' },
    { type: 'user_message', content: 'hi' },
  ], 's3');

  // 9. Persistent filter strips text_delta but keeps the rest.
  out.persistent = api.filterRealtimePersistentEvents([
    textDelta({ text: 'a', providerEventId: 'p11' }),
    { type: 'status', content: 'Working' },
    { type: 'user_message', content: 'hi' },
  ]);

  // 10. Approval-already-ended classification.
  out.approvalEnded = [
    api.isApprovalAlreadyEndedError({ code: 'APPROVAL_NOT_FOUND' }),
    api.isApprovalAlreadyEndedError({ code: 'run_terminal' }),
    api.isApprovalAlreadyEndedError({ code: 'RUN_NOT_FOUND' }),
    api.isApprovalAlreadyEndedError({ status: 404 }),
    api.isApprovalAlreadyEndedError({ status: 409 }),
    api.isApprovalAlreadyEndedError({ status: 410 }),
    api.isApprovalAlreadyEndedError({ code: 'RANDOM' }),
    api.isApprovalAlreadyEndedError({ status: 500 }),
    api.isApprovalAlreadyEndedError(null),
  ];

  return out;
}

async function main() {
  for (const withVisitorMode of [false, true]) {
    const [legacy, core] = [loadLegacy(withVisitorMode), loadCore(withVisitorMode)];
    const [a, b] = await Promise.all([runScenario(legacy.api, withVisitorMode), runScenario(core.api, withVisitorMode)]);
    const [ra, rb] = [JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))];
    assert.deepEqual(
      rb,
      ra,
      `ws-events drift withVisitorMode=${withVisitorMode}: ${legacy.label} vs ${core.label}`,
    );
  }
  console.log('test-chat-ws-events-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
