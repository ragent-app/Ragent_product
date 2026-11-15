#!/usr/bin/env node

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import {
  buildDetachedRunPushEvents,
  coalesceHarnessLiveReasoningEvents,
  isDurableChatHistoryEvent,
} from '../chat/session-manager.mjs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const realtimeSource = readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8');

assert.equal(isDurableChatHistoryEvent({ type: 'message' }), true);
assert.equal(isDurableChatHistoryEvent({ type: 'reasoning' }), false);
assert.equal(isDurableChatHistoryEvent({ type: 'text_delta' }), false);
assert.equal(isDurableChatHistoryEvent({
  type: 'tool_result', runId: 'run-delta', runtimeFamily: 'codex-app-server-json',
  operationLifecycle: 'delta', providerItemId: 'call-delta', output: 'partial',
}), false);

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    if (source[index] === '(') paramsDepth += 1;
    if (source[index] === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

function createContext() {
  const calls = { projected: [], durable: [], attention: [], goal: [], inspector: [], legacy: [] };
  const context = {
    console,
    Promise,
    Map,
    Set,
    Math,
    Number,
    String,
    JSON,
    messagesEl: { scrollHeight: 100, scrollTop: 0, clientHeight: 100 },
    currentSessionId: 'session-current',
    visitorMode: false,
    window: null,
    scrollToBottom() {},
    applyWorkbenchInspectorEventDelta(sessionId, events) {
      calls.inspector.push({ sessionId, events });
    },
    paintGoalChipLive(events) {
      calls.goal.push(events);
    },
    RagentTimelineRuntime: {
      renderDurableDelta(events, options) {
        calls.durable.push({ events, options });
        return { latestSeq: options?.latestSeq || 0 };
      },
      renderIncremental(events, options) {
        calls.projected.push({ events, options });
        return { latestSeq: 9 };
      },
    },
    RagentAttentionPopup: {
      onRealtimeEvents(sessionId, events) {
        calls.attention.push({ sessionId, events });
      },
    },
    renderEvent() { calls.legacy.push('renderEvent'); },
    filterUnrenderedPersistentEvents() { calls.legacy.push('filterUnrenderedPersistentEvents'); },
  };
  context.window = context;
  context.globalThis = context;
  context.__calls = calls;
  return context;
}

const handlerSource = extractFunctionSource(realtimeSource, 'handleWsMessage');

{
  const context = createContext();
  vm.runInNewContext(`${handlerSource}\nglobalThis.handleWsMessage = handleWsMessage;`, context, {
    filename: 'static/chat/realtime.js',
  });
  const events = [
    { id: 'delta-1', type: 'text_delta', role: 'assistant', runId: 'run-1', text: 'stream' },
    { id: 'message-2', type: 'message', role: 'assistant', seq: 9, content: 'final' },
    { id: 'message-3', type: 'message', role: 'assistant', runId: 'run-1', content: 'one-shot live' },
  ];
  context.handleWsMessage({ type: 'session_events', sessionId: 'session-current', events });
  assert.equal(context.__calls.projected.length, 1);
  assert.deepEqual(
    context.__calls.projected[0].events,
    [events[0], events[2]],
    'WS must pass only sequence-free live overlays, including complete assistant messages',
  );
  assert.deepEqual(
    context.__calls.durable[0].events,
    [events[1]],
    'durable WS events should enter the canonical timeline directly instead of waiting for a duplicate HTTP page fetch',
  );
  assert.equal(context.__calls.projected[0].options.sessionId, 'session-current');
  assert.equal(context.__calls.projected[0].options.source, 'ws');
  assert.equal(context.__calls.projected[0].options.runState, 'running');
  assert.deepEqual(context.__calls.attention[0], { sessionId: 'session-current', events });
  assert.deepEqual(context.__calls.goal, [events]);
  assert.deepEqual(context.__calls.inspector[0], { sessionId: 'session-current', events });
  assert.deepEqual(context.__calls.legacy, [], 'WS ingress must not call the removed render/filter bookkeeping');
}

{
  const context = createContext();
  vm.runInNewContext(`${handlerSource}\nglobalThis.handleWsMessage = handleWsMessage;`, context, {
    filename: 'static/chat/realtime.js',
  });
  const events = [{ id: 'background-1', type: 'message', seq: 12, content: 'background' }];
  context.handleWsMessage({ type: 'session_events', sessionId: 'session-background', events });
  assert.equal(context.__calls.projected.length, 0, 'background sessions must not mutate the active timeline');
  assert.deepEqual(context.__calls.attention[0], { sessionId: 'session-background', events });
}

{
  const context = createContext();
  vm.runInNewContext(`${handlerSource}\nglobalThis.handleWsMessage = handleWsMessage;`, context, {
    filename: 'static/chat/realtime.js',
  });
  context.handleWsMessage({ type: 'session_events', sessionId: 'session-current', events: [] });
  assert.equal(context.__calls.projected.length, 0, 'empty pushes should not enter the projector');
}

const textDelta = {
  type: 'text_delta',
  role: 'assistant',
  runId: 'run-order-regression',
  responseId: 'resp-order-regression',
  blockIndex: 1,
  runtimeFamily: 'claude-stream-json-bidi',
  text: '...是过时的...',
};
const durableMessage = {
  type: 'message',
  role: 'assistant',
  runId: 'run-order-regression',
  responseId: 'resp-order-regression',
  providerMessageId: 'msg-order-regression',
  content: '最终回复',
};
const toolResultDelta = {
  type: 'tool_result',
  role: 'tool',
  runId: 'run-order-regression',
  runtimeFamily: 'codex-app-server-json',
  operationLifecycle: 'delta',
  providerItemId: 'call-delta',
  output: 'partial',
};
const storedMessage = { ...durableMessage, seq: 1405, timestamp: '2026-07-29T23:01:46.316Z' };
const pushEvents = buildDetachedRunPushEvents(
  [textDelta, toolResultDelta, durableMessage],
  [durableMessage],
  [storedMessage],
);
assert.deepEqual(pushEvents.map((event) => event.type), ['text_delta', 'tool_result', 'message']);
assert.equal(pushEvents[1], toolResultDelta);
assert.equal(pushEvents[2].seq, 1405);

const reasoningBurst = Array.from({ length: 20_000 }, (_, index) => ({
  type: 'reasoning',
  role: 'assistant',
  runId: 'run-reasoning-burst',
  runtimeFamily: 'claude-stream-json-bidi',
  providerBlockId: 'thinking:0',
  blockIndex: 0,
  reasoningLifecycle: 'delta',
  state: 'running',
  content: String(index % 10),
}));
const coalescedReasoning = coalesceHarnessLiveReasoningEvents(reasoningBurst);
assert.equal(coalescedReasoning.length, 1, 'one observer tick should produce one reasoning render');
assert.equal(coalescedReasoning[0].reasoningDeltaCount, 20_000);
assert.equal(coalescedReasoning[0].coalesced, true);
assert.ok(coalescedReasoning[0].content.length <= 16 * 1024, 'live reasoning payload stays bounded');
assert.equal(
  buildDetachedRunPushEvents(reasoningBurst, [], []).length,
  1,
  'ephemeral reasoning coalescing must also apply on the detached-run WS path',
);

const orderedReasoning = coalesceHarnessLiveReasoningEvents([
  ...reasoningBurst.slice(0, 2),
  { type: 'tool_use', runId: 'run-reasoning-burst', toolName: 'Read' },
  ...reasoningBurst.slice(2, 4),
]);
assert.deepEqual(
  orderedReasoning.map((event) => event.type),
  ['reasoning', 'tool_use', 'reasoning'],
  'coalescing must preserve tool boundaries',
);

assert.match(realtimeSource, /RagentTimelineRuntime;[\s\S]*renderIncremental/);
assert.doesNotMatch(realtimeSource, /filterRealtimeSessionEvents|filterRealtimePersistentEvents/);
assert.doesNotMatch(realtimeSource, /filterUnrenderedPersistentEvents|markWsEventPushApplied|isWsEventPushCaughtUp/);
assert.doesNotMatch(realtimeSource, /renderEvent\(msg/);

console.log('test-session-event-ingress-dedup: ok');
