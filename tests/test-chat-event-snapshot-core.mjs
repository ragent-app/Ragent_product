#!/usr/bin/env node
// tests/test-chat-event-snapshot-core.mjs
//
// Stage 2: event-snapshot core (static/chat/transport/event-snapshot.js) is a
// DOM-free port of session-http.js's visible-event page URL building,
// rendered-event snapshot cache, operation-update merge and refresh decision
// helpers (seq/pagination primitives shared with the timeline runtime and
// event-sync transport). The scenarios below exercise the current transport
// contract directly; session-http.js no longer owns these helpers.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const RENDERED_EVENT_STATE_SHAPE = `
  const renderedEventState = {
    sessionId: null,
    earliestSeq: 0,
    latestSeq: 0,
    eventCount: 0,
    eventBaseKeys: [],
    eventKeys: [],
    runState: "idle",
    runActivity: null,
    operationNodesById: new Map(),
    operationSnapshotsById: new Map(),
    expandedOperationIds: new Set(),
    runningBlockExpanded: false,
    hasMoreBefore: false,
    loadingOlder: false,
  };
  let currentSessionId = "";
  const emptyState = { parentNode: null };
  const messagesInner = {};
  emptyState.parentNode = messagesInner;
  const messagesEl = { addEventListener() {} };
  __setRendered = (patch) => Object.assign(renderedEventState, patch);
  __getRendered = () => JSON.parse(JSON.stringify(renderedEventState));
  __setCurrent = (id) => { currentSessionId = id; };
  __getCurrent = () => currentSessionId;
`;

function loadCore() {
  const context = {
    console,
    Promise,
    Map,
    Set,
    Date,
    Error,
    URL,
    URLSearchParams,
    encodeURIComponent,
    AbortController,
  };
  vm.runInNewContext(RENDERED_EVENT_STATE_SHAPE, context);
  const renderedStateAccessor = context.__getRendered;
  context.RagentEventSnapshotEnvironment = {
    getCurrentSessionId: () => context.__getCurrent(),
    renderedEventState: null,
    hasRenderedEmptyState: true,
    isShareSnapshotReadOnlyMode: () => false,
    getExpandedOperationIds: null,
  };
  // The environment holds a live reference to the same state object the
  // setter script mutates, so every scenario observes current ambient state.
  vm.runInNewContext(
    'RagentEventSnapshotEnvironment.renderedEventState = renderedEventState;',
    context,
  );
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/event-snapshot.js'), 'utf8'),
    context,
    { filename: 'transport/event-snapshot.js' },
  );
  const core = context.RagentEventSnapshotCore;
  return {
    api: {
      buildSessionVisibleEventsPageUrl: (id, o) => core.buildSessionVisibleEventsPageUrl(id, o),
      mergeOperationUpdatesIntoEvents: (e, u) => core.mergeOperationUpdatesIntoEvents(e, u),
      getEventBoundarySeq: (e) => core.getEventBoundarySeq(e),
      getEventStartSeq: (e) => core.getEventStartSeq(e),
      getLatestEventSeq: (e) => core.getLatestEventSeq(e),
      getEarliestEventSeq: (e) => core.getEarliestEventSeq(e),
      normalizeRenderedPagination: (p, e) => core.normalizeRenderedPagination(p, e),
      getSessionEventSnapshot: (id) => core.getSessionEventSnapshot(id),
      setSessionEventSnapshot: (id, e, o) => core.setSessionEventSnapshot(id, e, o),
      appendSessionEventSnapshotDelta: (id, e, o) => core.appendSessionEventSnapshotDelta(id, e, o),
      prependSessionEventSnapshotPage: (id, e, o) => core.prependSessionEventSnapshotPage(id, e, o),
      updateSessionEventSnapshotOperations: (id, u, r) => core.updateSessionEventSnapshotOperations(id, u, r),
      hasRenderedEventSnapshot: (id) => core.hasRenderedEventSnapshot(id),
      getSessionRunState: (s) => core.getSessionRunState(s),
      shouldFetchSessionEventsForRefresh: (id, s) => core.shouldFetchSessionEventsForRefresh(id, s),
      shouldAttemptEventDeltaFetch: (id, o) => core.shouldAttemptEventDeltaFetch(id, o),
      filterUnrenderedPersistentEvents: (id, e, a) => core.filterUnrenderedPersistentEvents(id, e, a),
      getRenderedOlderPageEventRange: (e) => core.getRenderedOlderPageEventRange(e),
    },
    setRendered: (patch) => context.__setRendered(patch),
    getRendered: () => renderedStateAccessor(),
    setCurrent: (id) => context.__setCurrent(id),
    label: 'transport',
  };
}

function opEvent(operationId, type = 'operation') {
  return { type, operationId, content: `op-${operationId}` };
}

function visibleEvent(seq, type = 'user_message') {
  return { type, seq, content: `e-${seq}` };
}

async function runScenario(impl) {
  const out = {};

  // 1. Visible-events page URL building.
  out.urls = [
    impl.api.buildSessionVisibleEventsPageUrl('s1'),
    impl.api.buildSessionVisibleEventsPageUrl('s1', { direction: 'older', beforeSeq: 42, limit: 25 }),
    impl.api.buildSessionVisibleEventsPageUrl('s1', { afterSeq: 7 }),
    impl.api.buildSessionVisibleEventsPageUrl('s1', { limit: -1 }),
    impl.api.buildSessionVisibleEventsPageUrl('a b/c', { direction: 'latest', limit: 50 }),
  ];

  // 2. Operation-update merge.
  out.merge = [
    impl.api.mergeOperationUpdatesIntoEvents(
      [opEvent('o1'), opEvent('o2'), visibleEvent(1)],
      [opEvent('o1'), { type: 'not_operation', operationId: 'nope' }],
    ),
    impl.api.mergeOperationUpdatesIntoEvents([visibleEvent(1)], [opEvent('x')]),
    impl.api.mergeOperationUpdatesIntoEvents(null, null),
  ];

  // 3. Seq / pagination primitives.
  out.seq = [
    impl.api.getEventStartSeq({ startSeq: 3, seq: 9 }),
    impl.api.getEventStartSeq({ blockStartSeq: 4, seq: 9 }),
    impl.api.getEventStartSeq({ mergedStartSeq: 5, seq: 9 }),
    impl.api.getEventStartSeq({ seq: 9 }),
    impl.api.getEventStartSeq({}),
    impl.api.getEventBoundarySeq({ endSeq: 8, seq: 9 }),
    impl.api.getEventBoundarySeq({ blockEndSeq: 7, seq: 9 }),
    impl.api.getEventBoundarySeq({ mergedEndSeq: 6, seq: 9 }),
    impl.api.getEventBoundarySeq({ seq: 9 }),
    impl.api.getLatestEventSeq([visibleEvent(1), visibleEvent(5), { type: 'x', endSeq: 9 }]),
    impl.api.getEarliestEventSeq([visibleEvent(5), visibleEvent(1), { type: 'x', startSeq: 3 }]),
    impl.api.normalizeRenderedPagination({ oldestSeq: 10, latestSeq: 20, hasMoreBefore: true }, [visibleEvent(1)]),
    impl.api.normalizeRenderedPagination({}, [visibleEvent(1), visibleEvent(2)]),
  ];

  // 4. Snapshot lifecycle: set → get → append delta → prepend page →
  //    operation update, with pagination/runActivity propagation.
  impl.setRendered({ sessionId: 's1', runActivity: { state: 'running' }, expandedOperationIds: new Set(['e1']) });
  out.lifecycle = {};
  const setResult = impl.api.setSessionEventSnapshot('s1', [visibleEvent(1), visibleEvent(2)], {
    runState: 'running',
    pagination: { oldestSeq: 1, hasMoreBefore: true },
    scrollTop: 120,
  });
  out.lifecycle.set = {
    events: setResult.events,
    pagination: setResult.pagination,
    runState: setResult.runState,
    runActivity: setResult.runActivity,
    expandedOperationIds: setResult.expandedOperationIds,
    runningBlockExpanded: setResult.runningBlockExpanded,
    scrollTop: setResult.scrollTop,
  };
  const appended = impl.api.appendSessionEventSnapshotDelta('s1', [visibleEvent(3), visibleEvent(4)], {
    runState: 'idle',
    latestSeq: 8,
    operationUpdates: [opEvent('e1')],
  });
  out.lifecycle.append = {
    events: appended.events.map((event) => `${event.type}:${event.seq ?? event.operationId}`),
    pagination: appended.pagination,
    runState: appended.runState,
    runActivity: appended.runActivity,
    scrollTop: appended.scrollTop,
  };
  const prepended = impl.api.prependSessionEventSnapshotPage('s1', [visibleEvent(0)], {
    runState: 'running',
    pagination: { oldestSeq: 0, hasMoreBefore: true },
  });
  out.lifecycle.prepend = {
    events: prepended.events.map((event) => event.seq),
    pagination: prepended.pagination,
    runActivity: prepended.runActivity,
  };
  const updated = impl.api.updateSessionEventSnapshotOperations('s1', [opEvent('e1')], { state: 'done' });
  out.lifecycle.update = {
    events: updated.events.map((event) => `${event.type}:${event.seq ?? event.operationId}`),
    runActivity: updated.runActivity,
  };
  out.lifecycle.get = impl.api.getSessionEventSnapshot('s1');
  impl.setRendered({ sessionId: 's1', runActivity: null, expandedOperationIds: new Set() });

  // 5. Snapshot cache eviction: TTL expiry then capacity limit.
  impl.api.setSessionEventSnapshot('s1', [visibleEvent(1)], {});
  const expiring = impl.api.getSessionEventSnapshot('s1');
  expiring.updatedAt = Date.now() - 3 * 60 * 1000; // older than the 2-minute TTL
  out.evictTtl = impl.api.getSessionEventSnapshot('s1');
  for (let index = 0; index < 9; index += 1) {
    impl.api.setSessionEventSnapshot(`cap-${index}`, [visibleEvent(1)], {});
  }
  out.evictCapacity = [
    impl.api.getSessionEventSnapshot('cap-0'), // first inserted → evicted
    impl.api.getSessionEventSnapshot('cap-8'), // most recent → present
  ];

  // 6. Refresh decision helpers across rendered-state variants.
  impl.setRendered({ sessionId: 's1', eventCount: 0 });
  impl.setCurrent('s1');
  out.decisions = [];
  out.decisions.push(impl.api.shouldFetchSessionEventsForRefresh('s1', { activity: {} }));
  impl.setRendered({ sessionId: 's1', eventCount: 3, latestSeq: 5, runState: 'idle' });
  out.decisions.push(impl.api.shouldFetchSessionEventsForRefresh('s1', { activity: { run: { state: 'running' } } }));
  impl.setRendered({ sessionId: 's1', eventCount: 3, latestSeq: 5, runState: 'running' });
  out.decisions.push(impl.api.shouldFetchSessionEventsForRefresh('s1', { activity: { run: { state: 'running' } } }));
  impl.setRendered({ sessionId: 's2', eventCount: 3, latestSeq: 5, runState: 'running' });
  out.decisions.push(impl.api.shouldFetchSessionEventsForRefresh('s1', { activity: { run: { state: 'running' } } }));
  impl.setRendered({ sessionId: 's1', eventCount: 3, latestSeq: 5, runState: 'running', runningBlockExpanded: true });
  out.decisions.push(impl.api.shouldFetchSessionEventsForRefresh('s1', { activity: { run: { state: 'running' } } }));
  impl.setRendered({ sessionId: 's1', eventCount: 3, latestSeq: 5, runState: 'running' });
  out.decisions.push(impl.api.shouldFetchSessionEventsForRefresh('s1', { activity: { run: { state: 'running' }, latestSeq: 6 } }));
  out.decisions.push(impl.api.shouldFetchSessionEventsForRefresh('s1', { activity: { run: { state: 'running' }, latestSeq: 5 } }));
  impl.setRendered({ sessionId: 's1', eventCount: 3, latestSeq: 5, runState: 'running' });
  out.decisions.push(impl.api.shouldAttemptEventDeltaFetch('s1', { runState: 'running' }));
  out.decisions.push(impl.api.shouldAttemptEventDeltaFetch('s2', { runState: 'running' }));
  impl.setRendered({ sessionId: 's1', eventCount: 3, latestSeq: -1, runState: 'running' });
  out.decisions.push(impl.api.shouldAttemptEventDeltaFetch('s1', { runState: 'running' }));
  impl.setRendered({ sessionId: 's1', eventCount: 3, latestSeq: 5, runState: 'running' });
  impl.setCurrent('s9');
  out.decisions.push(impl.api.shouldAttemptEventDeltaFetch('s1', { runState: 'running' }));
  impl.setCurrent('s1');

  // 7. Rendered-snapshot and run-state probes.
  impl.setRendered({ sessionId: 's1', eventCount: 3 });
  out.probes = [
    impl.api.hasRenderedEventSnapshot('s1'),
    impl.api.hasRenderedEventSnapshot('s2'),
    impl.api.getSessionRunState({ activity: { run: { state: 'running' } } }),
    impl.api.getSessionRunState({}),
    impl.api.getSessionRunState(null),
  ];

  // 8. Unrendered persistent-event filtering (full-reload delta split).
  impl.setRendered({ sessionId: 's1', latestSeq: 5 });
  const ev = (seq, overrides = {}) => ({ type: 'user_message', seq, ...overrides });
  out.unrendered = [
    impl.api.filterUnrenderedPersistentEvents('s1', [ev(1), ev(2), ev(6)]),
    impl.api.filterUnrenderedPersistentEvents('s2', [ev(1), ev(2)]),
    impl.api.filterUnrenderedPersistentEvents('s1', []),
    impl.api.filterUnrenderedPersistentEvents('s1', 'not-an-array'),
    impl.api.filterUnrenderedPersistentEvents('s1', [ev(1), ev(2)], 10),
    impl.api.filterUnrenderedPersistentEvents('s1', [ev(1), ev(2)], -3),
    impl.api.filterUnrenderedPersistentEvents('s1', [{ type: 'collapsed_block', seq: 1, blockStartSeq: 1, blockEndSeq: 9 }]),
    impl.api.filterUnrenderedPersistentEvents('s1', [ev(6)], 5.5),
    // A persisted event that spans the applied-after boundary keeps
    // overlapsRenderedRange true even though its boundary seq is newer.
    impl.api.filterUnrenderedPersistentEvents('s1', [{ type: 'user_message', seq: 4, startSeq: 1, endSeq: 8 }]),
  ];

  // 9. Older-page event range (older-page append anchor): [minSeq, maxSeq]
  //    over the fetched page, from the same seq primitives.
  out.olderRange = [
    impl.api.getRenderedOlderPageEventRange([]),
    impl.api.getRenderedOlderPageEventRange(null),
    impl.api.getRenderedOlderPageEventRange([visibleEvent(5)]),
    impl.api.getRenderedOlderPageEventRange([
      visibleEvent(3),
      { type: 'x', startSeq: 1, endSeq: 9 },
      visibleEvent(8),
    ]),
    impl.api.getRenderedOlderPageEventRange([
      { type: 'collapsed_block', seq: 2, blockStartSeq: 1, blockEndSeq: 7 },
    ]),
    impl.api.getRenderedOlderPageEventRange([{ type: 'x', endSeq: 9 }]), // no start seq
    impl.api.getRenderedOlderPageEventRange([{ type: 'x', startSeq: 3 }]), // boundary falls back to seq
    impl.api.getRenderedOlderPageEventRange([{ type: 'x', mergedStartSeq: 4, mergedEndSeq: 6 }]),
  ];
  impl.setRendered({ sessionId: null, eventCount: 0 });
  impl.setCurrent('');

  return out;
}

async function main() {
  const result = JSON.parse(JSON.stringify(await runScenario(loadCore())));

  assert.deepEqual(result.urls, [
    '/api/sessions/s1/events?filter=visible&limit=50&direction=latest',
    '/api/sessions/s1/events?filter=visible&limit=25&direction=older&beforeSeq=42',
    '/api/sessions/s1/events?filter=visible&limit=50&direction=latest&afterSeq=7',
    '/api/sessions/s1/events?filter=visible&direction=latest',
    '/api/sessions/a%20b%2Fc/events?filter=visible&limit=50&direction=latest',
  ]);
  assert.deepEqual(result.merge[0].map((event) => event.content), ['op-o1', 'op-o2', 'e-1']);
  assert.deepEqual(result.merge[1].map((event) => event.content), ['e-1']);
  assert.deepEqual(result.merge[2], []);
  assert.deepEqual(result.seq, [3, 4, 5, 9, 0, 8, 7, 6, 9, 9, 1,
    { earliestSeq: 10, nextBeforeSeq: 10, latestSeq: 20, hasMoreBefore: true },
    { earliestSeq: 1, nextBeforeSeq: 1, latestSeq: 2, hasMoreBefore: false }]);
  assert.equal(result.lifecycle.set.runState, 'running');
  assert.equal(result.lifecycle.set.runActivity.state, 'running');
  assert.deepEqual(result.lifecycle.append.events, ['user_message:1', 'user_message:2', 'user_message:3', 'user_message:4']);
  assert.equal(result.lifecycle.append.runState, 'idle');
  assert.equal(result.lifecycle.append.scrollTop, 120);
  assert.deepEqual(result.lifecycle.prepend.events, [0, 1, 2, 3, 4]);
  assert.equal(result.lifecycle.update.events[0], 'user_message:0');
  assert.equal(result.lifecycle.update.runActivity.state, 'done');
  assert.equal(result.lifecycle.get.pagination.earliestSeq, 0);
  assert.equal(result.evictTtl, null);
  assert.ok(result.evictCapacity[0] === null);
  assert.ok(result.evictCapacity[1]);
  assert.deepEqual(result.decisions, [true, true, false, true, true, true, true, true, false, false, false]);
  assert.deepEqual(result.probes, [true, false, 'running', 'idle', 'idle']);
  assert.equal(result.unrendered[0].appliedAfterSeq, 5);
  assert.deepEqual(result.unrendered[0].events.map((event) => event.seq), [6]);
  assert.equal(result.unrendered[0].overlapsRenderedRange, false);
  assert.deepEqual(result.unrendered[8].events.map((event) => event.seq), [4]);
  assert.equal(result.unrendered[8].overlapsRenderedRange, true);
  assert.deepEqual(result.olderRange, [
    { minSeq: 0, maxSeq: 0 },
    { minSeq: 0, maxSeq: 0 },
    { minSeq: 5, maxSeq: 5 },
    { minSeq: 1, maxSeq: 9 },
    { minSeq: 1, maxSeq: 7 },
    { minSeq: 0, maxSeq: 9 },
    { minSeq: 3, maxSeq: 0 },
    { minSeq: 4, maxSeq: 6 },
  ]);
  console.log('test-chat-event-snapshot-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
