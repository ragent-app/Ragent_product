#!/usr/bin/env node
// tests/test-chat-event-render-plan-core.mjs
//
// Stage 2: event-render-plan core (static/chat/transport/event-render-plan.js)
// is a DOM-free port of session-http.js's getEventRenderPlan plus the
// render-key primitives shared with session-http-helpers.js. Every scenario
// runs against BOTH implementations with identical injected rendered state
// and compares primitive-level outputs, so the port cannot drift from the
// legacy plan semantics (reset / noop / append / refresh_running_block).

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
  __getRendered = () => JSON.parse(JSON.stringify(renderedEventState));
`;

function loadLegacy() {
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
    navigator: {},
    window: {},
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
      getNormalizedEventRenderType: (e) => context.getNormalizedEventRenderType(e),
      isRunningThinkingBlockEvent: (e) => context.isRunningThinkingBlockEvent(e),
      getAttachmentDeliveryRenderKey: (e) => context.getAttachmentDeliveryRenderKey(e),
      getEventRenderBaseKey: (e) => context.getEventRenderBaseKey(e),
      getEventRenderKey: (e) => context.getEventRenderKey(e),
      eventKeyArraysEqual: (a, b) => context.eventKeyArraysEqual(a, b),
      eventKeyPrefixMatches: (a, b) => context.eventKeyPrefixMatches(a, b),
      getEventRenderPlan: (id, events) => context.getEventRenderPlan(id, events),
    },
    setRendered: (patch) => context.__setRendered(patch),
    label: 'legacy',
  };
}

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
  vm.runInNewContext(RENDERED_SHAPE, context);
  context.RagentEventRenderPlanEnvironment = {
    renderedEventState: null,
    hasRenderedEmptyState: true,
  };
  vm.runInNewContext(
    'RagentEventRenderPlanEnvironment.renderedEventState = renderedEventState;',
    context,
  );
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/event-render-plan.js'), 'utf8'),
    context,
    { filename: 'transport/event-render-plan.js' },
  );
  const core = context.RagentEventRenderPlanCore;
  return {
    api: {
      getNormalizedEventRenderType: (e) => core.getNormalizedEventRenderType(e),
      isRunningThinkingBlockEvent: (e) => core.isRunningThinkingBlockEvent(e),
      getAttachmentDeliveryRenderKey: (e) => core.getAttachmentDeliveryRenderKey(e),
      getEventRenderBaseKey: (e) => core.getEventRenderBaseKey(e),
      getEventRenderKey: (e) => core.getEventRenderKey(e),
      eventKeyArraysEqual: (a, b) => core.eventKeyArraysEqual(a, b),
      eventKeyPrefixMatches: (a, b) => core.eventKeyPrefixMatches(a, b),
      getEventRenderPlan: (id, events) => core.getEventRenderPlan(id, events),
    },
    setRendered: (patch) => context.__setRendered(patch),
    label: 'transport',
  };
}

function event(seq, overrides = {}) {
  return { type: 'user_message', seq, ...overrides };
}

async function runScenario(impl) {
  const out = {};

  // 1. Render-key primitives across event shapes.
  const thinkingRunning = { type: 'collapsed_block', seq: 3, state: 'running', blockEndSeq: 9 };
  const thinkingDone = { type: 'thinking_block', seq: 4, state: 'done' };
  const attachmentAsset = {
    type: 'attachment_delivery', seq: 5,
    attachments: [{ assetId: 'asset-1' }, { filename: 'f.png' }, { downloadUrl: '/d' }, { originalName: 'o', mimeType: 'image/png' }],
  };
  const attachmentExplicit = { type: 'attachment_delivery', seq: 6, deliveryKey: 'delivery-1' };
  const operation = { type: 'operation', seq: 7, operationId: 'op-1' };
  out.keys = [
    impl.api.getNormalizedEventRenderType({ type: 'collapsed_block' }),
    impl.api.getNormalizedEventRenderType({ type: 'user_message' }),
    impl.api.isRunningThinkingBlockEvent(thinkingRunning),
    impl.api.isRunningThinkingBlockEvent(thinkingDone),
    impl.api.getEventRenderBaseKey(thinkingRunning),
    impl.api.getEventRenderBaseKey(thinkingDone),
    impl.api.getAttachmentDeliveryRenderKey(attachmentAsset),
    impl.api.getAttachmentDeliveryRenderKey(attachmentExplicit),
    impl.api.getEventRenderBaseKey(attachmentAsset),
    impl.api.getEventRenderBaseKey(attachmentExplicit),
    impl.api.getEventRenderBaseKey(operation),
    impl.api.getEventRenderBaseKey(event(1)),
    impl.api.eventKeyArraysEqual(['a', 'b'], ['a', 'b']),
    impl.api.eventKeyArraysEqual(['a', 'b'], ['a']),
    impl.api.eventKeyArraysEqual(['a'], ['a', 'b']),
    impl.api.eventKeyPrefixMatches(['a'], ['a', 'b']),
    impl.api.eventKeyPrefixMatches(['a', 'b'], ['a']),
  ];

  // 2. No rendered snapshot (or different session) → reset with full events.
  impl.setRendered({ sessionId: null, eventCount: 0 });
  out.resetNoSnapshot = impl.api.getEventRenderPlan('s1', [event(1), event(2)]);
  impl.setRendered({ sessionId: 's2', eventCount: 2, latestSeq: 5, eventKeys: ['1:user_message', '2:user_message'] });
  out.resetOtherSession = impl.api.getEventRenderPlan('s1', [event(1), event(2)]);

  // 3. Identical keys → noop with no events.
  impl.setRendered({
    sessionId: 's1', eventCount: 2, latestSeq: 2,
    eventKeys: ['1:user_message', '2:user_message'],
    eventBaseKeys: ['1:user_message', '2:user_message'],
  });
  out.noopIdentical = impl.api.getEventRenderPlan('s1', [event(1), event(2)]);

  // 4. Prefix match → append with the extra events.
  out.append = impl.api.getEventRenderPlan('s1', [event(1), event(2), event(3)]);

  // 5. Page is a suffix of the rendered page → preserve-loaded-older-page noop.
  out.preserveOlder = impl.api.getEventRenderPlan('s1', [event(2), event(3)]);

  // 6. Latest seq regressed / fewer events than rendered → reset.
  impl.setRendered({
    sessionId: 's1', eventCount: 5, latestSeq: 10,
    eventKeys: ['1:user_message', '2:user_message', '3:user_message', '4:user_message', '5:user_message'],
  });
  out.resetRegression = impl.api.getEventRenderPlan('s1', [event(1), event(2)]);
  impl.setRendered({
    sessionId: 's1', eventCount: 5, latestSeq: 2,
    eventKeys: ['1:user_message', '2:user_message'],
  });
  out.resetOlder = impl.api.getEventRenderPlan('s1', [event(1), event(2), event(3)]);

  // 7. Running block expanded + same base keys + final running thinking event
  //    with a newer boundary → refresh_running_block with just that event.
  impl.setRendered({
    sessionId: 's1', eventCount: 3, latestSeq: 5,
    runningBlockExpanded: true,
    eventKeys: ['1:user_message', '2:user_message', '3:thinking_block:running'],
    eventBaseKeys: ['1:user_message', '2:user_message', '3:thinking_block:running'],
  });
  out.refreshRunningBlock = impl.api.getEventRenderPlan('s1', [
    event(1), event(2), thinkingRunning,
  ]);
  // Same shape but the block did not advance past the rendered boundary.
  const notAdvanced = { ...thinkingRunning, blockEndSeq: 5 };
  out.refreshRunningBlockNotAdvanced = impl.api.getEventRenderPlan('s1', [
    event(1), event(2), notAdvanced,
  ]);
  // Base keys differ (state flipped) → plain reset.
  out.refreshRunningBlockStateFlip = impl.api.getEventRenderPlan('s1', [
    event(1), event(2), thinkingDone,
  ]);

  // 8. Key shapes with the expanded block flag: dynamic boundary on the
  //    running thinking event only.
  impl.setRendered({ sessionId: 's1', runningBlockExpanded: true });
  out.dynamicKeys = [
    impl.api.getEventRenderKey(thinkingRunning),
    impl.api.getEventRenderKey(thinkingDone),
    impl.api.getEventRenderKey(event(1)),
  ];
  impl.setRendered({ sessionId: 's1', runningBlockExpanded: false });
  out.flatKeys = impl.api.getEventRenderKey(thinkingRunning);

  impl.setRendered({ sessionId: null, eventCount: 0 });
  return out;
}

async function main() {
  const [legacy, core] = [loadLegacy(), loadCore()];
  const [a, b] = await Promise.all([runScenario(legacy), runScenario(core)]);
  const [ra, rb] = [JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))];
  assert.deepEqual(rb, ra, `event-render-plan drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-event-render-plan-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
