#!/usr/bin/env node
// tests/test-chat-ws-push-suppress-core.mjs
//
// Stage 2: ws-push-suppress core (static/chat/transport/ws-push-suppress.js)
// is a DOM-free port of session-http.js's markWsEventPushApplied /
// isWsEventPushCaughtUp (plus the WS_EVENT_PUSH_SUPPRESS_MS window). Every
// scenario runs against BOTH implementations with an identical controllable
// clock (Date.now is mocked through a shared timeline) and identical injected
// rendered-event state, comparing primitive-level outputs — so the port
// cannot drift from the legacy suppression decision, including the
// expiry-by-time branch that a plain real-clock test could never reach.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const RENDERED_SHAPE = `
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
  const emptyState = { parentNode: null };
  const messagesInner = {};
  emptyState.parentNode = messagesInner;
  const messagesEl = { addEventListener() {} };
  __setRendered = (patch) => Object.assign(renderedEventState, patch);
`;

// Shared controllable clock: both vm realms observe the same timeline, so the
// suppression window can be advanced deterministically for both sides.
function makeTimeline() {
  const timeline = { current: Date.now() };
  function MockDate() {}
  MockDate.now = () => timeline.current;
  return { timeline, MockDate };
}

function loadLegacy({ timeline, MockDate }) {
  const context = {
    console,
    Promise,
    Map,
    Set,
    Date: MockDate,
    Error,
    URL,
    URLSearchParams,
    encodeURIComponent,
    AbortController,
    navigator: {},
    window: {},
    localStorage: { getItem: () => null },
  };
  vm.runInNewContext(RENDERED_SHAPE, context);
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8'),
    context,
    { filename: 'session-http-helpers.js' },
  );
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8'),
    context,
    { filename: 'session-http.js' },
  );
  return {
    api: {
      mark: (sessionId, events) => context.markWsEventPushApplied(sessionId, events),
      is: (sessionId) => context.isWsEventPushCaughtUp(sessionId),
    },
    setRendered: (patch) => context.__setRendered(patch),
    label: 'legacy',
  };
}

function loadCore({ timeline, MockDate }) {
  const context = {
    console,
    Promise,
    Map,
    Set,
    Date: MockDate,
    Error,
    URL,
    URLSearchParams,
    encodeURIComponent,
    AbortController,
  };
  vm.runInNewContext(RENDERED_SHAPE, context);
  const env = { renderedEventState: null };
  context.RagentWsPushSuppressEnvironment = env;
  vm.runInNewContext(
    'RagentWsPushSuppressEnvironment.renderedEventState = renderedEventState;',
    context,
  );
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/ws-push-suppress.js'), 'utf8'),
    context,
    { filename: 'transport/ws-push-suppress.js' },
  );
  const core = context.RagentWsPushSuppressCore;
  return {
    api: {
      mark: (sessionId, events) => core.markWsEventPushApplied(sessionId, events),
      is: (sessionId) => core.isWsEventPushCaughtUp(sessionId),
    },
    setRendered: (patch) => context.__setRendered(patch),
    label: 'transport',
  };
}

function event(seq, overrides = {}) {
  return { type: 'user_message', seq, ...overrides };
}

async function runScenario(impl, timeline) {
  const out = {};
  const T0 = timeline.current;

  // 1. Never-marked → nothing is caught up (any session, any rendered state).
  impl.setRendered({ sessionId: 's1', latestSeq: 5 });
  out.unmarked = [impl.api.is('s1'), impl.api.is(''), impl.api.is('other')];

  // 2. Empty / invalid mark payloads leave the state untouched.
  impl.api.mark('s1', []);
  out.emptyEvents = impl.api.is('s1');
  impl.api.mark('', [event(5)]);
  out.emptySession = impl.api.is('s1');
  impl.api.mark('s1', 'not-an-array');
  out.nonArray = impl.api.is('s1');

  // 3. Marked with events covering the rendered seq → caught up.
  impl.api.mark('s1', [event(4), event(5)]);
  impl.setRendered({ sessionId: 's1', latestSeq: 5 });
  out.caughtUp = [impl.api.is('s1'), impl.api.is('s2')];

  // 4. Push behind the rendered seq → not caught up.
  impl.setRendered({ sessionId: 's1', latestSeq: 20 });
  out.behind = impl.api.is('s1');

  // 5. Boundary seqs (block events) drive the latest push seq.
  impl.api.mark('s1', [{ type: 'collapsed_block', seq: 1, blockEndSeq: 7 }]);
  impl.setRendered({ sessionId: 's1', latestSeq: 7 });
  out.boundary = impl.api.is('s1');
  impl.setRendered({ sessionId: 's1', latestSeq: 8 });
  out.boundaryBehind = impl.api.is('s1');

  // 6. Suppression window expiry: advance the shared clock past 600ms.
  timeline.current = T0 + 700;
  out.expired = impl.api.is('s1');
  timeline.current = T0 + 600;
  out.atEdge = impl.api.is('s1');
  timeline.current = T0;

  // 7. Session switch invalidates the previous push state.
  impl.api.mark('s2', [event(3)]);
  out.switched = [impl.api.is('s1'), impl.api.is('s2')];

  // 8. Non-integer seqs collapse to 0 (legacy quirk: getLatestEventSeq returns
  //    0 which IS an integer, so the latest push seq is replaced by 0).
  impl.api.mark('s1', [{ type: 'user_message', seq: 'x' }]);
  out.nonInteger = impl.api.is('s1');
  impl.setRendered({ sessionId: 's1', latestSeq: 0 });
  out.nonIntegerZeroRendered = impl.api.is('s1');

  return out;
}

async function main() {
  const { timeline, MockDate } = makeTimeline();
  const [legacy, core] = [loadLegacy({ timeline, MockDate }), loadCore({ timeline, MockDate })];
  const [a, b] = await Promise.all([runScenario(legacy, timeline), runScenario(core, timeline)]);
  const [ra, rb] = [JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))];
  assert.deepEqual(rb, ra, `ws-push-suppress drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-ws-push-suppress-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
