#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import vm from 'vm';
import { createCodexAdapter } from '../chat/adapters/codex.mjs';
import { createCopilotAdapter } from '../chat/adapters/copilot.mjs';

const chatMessagesCss = readFileSync(new URL('../static/chat/chat-messages.css', import.meta.url), 'utf8');

function createNode() {
  return {
    className: '',
    children: [],
    parentNode: null,
    dataset: {},
    textContent: '',
    innerHTML: '',
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      const siblings = this.parentNode.children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parentNode = null;
    },
    querySelector(selector) {
      if (selector !== '.msg-assistant-body') return null;
      return this.children.find((child) => child.className === 'msg-assistant-body') || null;
    },
  };
}

function createStreamingRenderHarness() {
  const source = readFileSync(new URL('../static/chat/realtime-render.js', import.meta.url), 'utf8');
  const rafQueue = [];
  const renders = [];
  const fragmentRenders = [];
  const renderedMessages = [];
  const runActivityCalls = [];
  const operationCalls = [];
  let treeWalkerCalls = 0;
  let clockMs = 1_000_000;
  const messagesInner = createNode();
  const emptyState = createNode();
  messagesInner.appendChild(emptyState);

  // Scroll-to-latest FAB is enhancement-only chrome; a no-op stub keeps the
  // harness from crashing while exercising the realtime-render script.
  const fab = {
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
      toggle() {},
    },
    addEventListener() {},
  };

  const context = {
    console,
    window: {},
    performance: {
      now: () => clockMs,
    },
    document: {
      createElement: () => createNode(),
      getElementById: (id) => (id === 'scrollToBottomFab' ? fab : null),
      // The streaming frontier must be caret-driven: any per-frame tree walk
      // (the old latest-glyph restyling) is a regression.
      createTreeWalker() {
        treeWalkerCalls += 1;
        return { nextNode: () => null };
      },
    },
    messagesInner,
    emptyState,
    currentSessionId: 'session-test',
    messagesEl: {
      scrollHeight: 300,
      scrollTop: 0,
      clientHeight: 100,
      addEventListener() {},
    },
    requestAnimationFrame(callback) {
      rafQueue.push(callback);
      return rafQueue.length;
    },
    cancelAnimationFrame() {},
    renderMarkdownIntoNode(node, text) {
      renders.push(text);
      node.textContent = text;
    },
    renderMarkdownFragmentIntoNode(node, text) {
      fragmentRenders.push(text);
      node.textContent = text;
      return true;
    },
    inThinkingBlock: false,
    currentThinkingBlock: null,
    syncComposerPendingTurnFeedback() {},
    syncSessionTemplateControls() {},
    syncForkButton() {},
    syncShareButton() {},
    renderQueuedMessagePanel() {},
    resetRenderedEventState() {},
    renderedEventState: {},
    shouldAutoScrollMessages() {
      return false;
    },
    shouldCompactMobileThinking() {
      return context.mobileCompact === true;
    },
    renderMessageInto(container, evt, options = {}) {
      const node = createNode();
      node.className = `message-${evt.role || 'assistant'}`;
      node.event = evt;
      node.options = options;
      container.appendChild(node);
      renderedMessages.push({ evt, options, node });
      return node;
    },
    renderMessageIntoStreamingNode(streamingNode, evt) {
      streamingNode.className = 'msg-assistant md-content';
      streamingNode.event = evt;
      streamingNode.dataset.syntheticFinalized = 'true';
      return streamingNode;
    },
    findAssistantRunMergeNode() {
      return null;
    },
    getAssistantRunMergeKeyForRender() {
      return '';
    },
    annotateRenderedEventViewportNodes() {},
    movePlanProgressCardToEnd() {},
    renderOperation(evt) {
      operationCalls.push(evt);
      const node = createNode();
      node.className = 'live-operation-row';
      node.event = evt;
      messagesInner.appendChild(node);
    },
  };
  context.window = context;
  context.window.RagentRunActivity = {
    noteFormalOutput(evt) {
      runActivityCalls.push({ method: 'noteFormalOutput', evt });
    },
    applyEvent(evt) {
      runActivityCalls.push({ method: 'applyEvent', evt });
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__streamingApi = { appendTextDelta, finalizeStreamingMessage, renderEvent, computeStreamingBlockSplit, canUseStreamingBlockRender };`, context);
  return {
    renders,
    fragmentRenders,
    renderedMessages,
    runActivityCalls,
    operationCalls,
    messagesInner,
    messagesEl: context.messagesEl,
    setMobileCompact(value) {
      context.mobileCompact = value === true;
    },
    setReducedMotion(value) {
      context.matchMedia = (query) => ({
        matches: value === true && String(query).includes('prefers-reduced-motion'),
      });
    },
    treeWalkerCalls() {
      return treeWalkerCalls;
    },
    advanceMs(ms) {
      clockMs += ms;
    },
    appendTextDelta: context.__streamingApi.appendTextDelta,
    computeStreamingBlockSplit: context.__streamingApi.computeStreamingBlockSplit,
    canUseStreamingBlockRender: context.__streamingApi.canUseStreamingBlockRender,
    finalizeStreamingMessage: context.__streamingApi.finalizeStreamingMessage,
    renderEvent: context.__streamingApi.renderEvent,
    runNextFrame() {
      const callback = rafQueue.shift();
      assert.equal(typeof callback, 'function', 'expected a queued animation frame');
      callback();
    },
    pendingFrameCount() {
      return rafQueue.length;
    },
  };
}

assert.match(
  chatMessagesCss,
  /\.streaming-text-frontier\s*\{[\s\S]*animation:\s*streaming-text-frontier-in/,
  'streaming text should have a dedicated frontier arrival cue',
);
assert.match(
  chatMessagesCss,
  /@keyframes\s+streaming-text-frontier-in[\s\S]*opacity:\s*0\.58[\s\S]*opacity:\s*1/,
  'frontier motion should be opacity-only',
);

{
  const harness = createStreamingRenderHarness();
  harness.appendTextDelta('收到');
  harness.appendTextDelta('，');
  assert.deepEqual(harness.renders, [], 'text deltas should wait for animation frames');

  harness.runNextFrame();
  assert.deepEqual(harness.renders, ['收'], 'first frame should reveal exactly one display grapheme');

  harness.appendTextDelta('前端');
  let finalized = false;
  harness.finalizeStreamingMessage(() => {
    finalized = true;
  });
  assert.equal(finalized, false, 'final message replacement should wait for queued tokens');

  harness.runNextFrame();
  assert.equal(finalized, false, 'the next display token should preserve the typewriter cadence');
  harness.runNextFrame();
  assert.equal(finalized, false, 'the typewriter should keep draining one grapheme at a time');
  harness.runNextFrame();
  assert.equal(finalized, false, 'the typewriter should keep draining one grapheme at a time');
  harness.runNextFrame();
  assert.equal(finalized, true, 'final message replacement should run after queued tokens drain');
  assert.equal(
    harness.messagesInner.children.some((child) => child.className.includes('streaming')),
    false,
    'streaming placeholder should be removed after finalization',
  );
  assert.deepEqual(
    harness.renders,
    ['收', '收到', '收到，', '收到，前', '收到，前端'],
    'every queued display grapheme should render before replacement',
  );
}

{
  const harness = createStreamingRenderHarness();
  const longToken = '这是一个超过单帧显示 token 预算的长段落，用于验证分帧打字节奏。';
  harness.appendTextDelta(longToken);
  harness.runNextFrame();
  assert.ok(
    harness.renders[0].length < longToken.length,
    'a single large provider chunk should reveal its first display token instead of popping in whole',
  );
  assert.equal(harness.pendingFrameCount(), 1, 'remaining chars should keep the typewriter scheduled');
  let frameCount = 1;
  while (harness.pendingFrameCount() > 0) {
    harness.runNextFrame();
    frameCount += 1;
    assert.ok(frameCount < 100, 'typewriter drain should terminate');
  }
  assert.equal(
    harness.renders[harness.renders.length - 1],
    longToken,
    'the final rendered text should equal the full chunk',
  );
}

{
  const harness = createStreamingRenderHarness();
  const hugeChunk = 'x'.repeat(700_000);
  harness.appendTextDelta(hugeChunk);
  harness.runNextFrame();
  assert.ok(
    harness.renders[0].length < 520_000,
    'live preview must cap visible text instead of rendering a pathological provider flush in full',
  );
  harness.finalizeStreamingMessage();
}

{
  const harness = createStreamingRenderHarness();
  harness.renderEvent({
    type: 'message',
    role: 'assistant',
    content: '短消息也必须经过统一的实时文本关口。',
  }, false, { syntheticStream: true });
  const streamingNode = harness.messagesInner.children.find((child) => child.className.includes('streaming'));
  assert.ok(streamingNode, 'a complete live assistant message should enter the streaming shell');
  assert.equal(
    streamingNode.querySelector('.msg-assistant-body').textContent,
    '',
    'the complete message should not be painted before the presentation frame',
  );
  let frameCount = 0;
  while (harness.pendingFrameCount() > 0) {
    harness.runNextFrame();
    frameCount += 1;
    assert.ok(frameCount < 100, 'short synthetic stream should drain');
  }
  assert.equal(
    streamingNode.className.includes('streaming'),
    false,
    'the live message should settle after the queued text drains',
  );
  assert.equal(streamingNode.dataset.syntheticFinalized, 'true');
  assert.ok(harness.renders.length > 1, 'the complete message should reveal across multiple presentation frames');
  assert.equal(
    harness.renders[harness.renders.length - 1],
    '短消息也必须经过统一的实时文本关口。',
  );
}

{
  const harness = createStreamingRenderHarness();
  const markdownToken = '**加粗**';
  harness.appendTextDelta(markdownToken);
  harness.runNextFrame();
  assert.ok(harness.renders[0].length < markdownToken.length);
  let frameCount = 1;
  while (harness.pendingFrameCount() > 0) {
    harness.runNextFrame();
    frameCount += 1;
    assert.ok(frameCount < 100, 'markdown typewriter drain should terminate');
  }
  assert.equal(
    [...harness.renders, ...harness.fragmentRenders][
      harness.renders.length + harness.fragmentRenders.length - 1
    ],
    markdownToken,
    'the final markdown render should never be skipped',
  );
}

{
  const harness = createStreamingRenderHarness();
  harness.appendTextDelta('平滑收敛');
  harness.runNextFrame();
  const streamingNode = harness.messagesInner.children.find((child) => child.className.includes('streaming'));
  let finalizedNode = null;
  harness.finalizeStreamingMessage((node) => {
    finalizedNode = node;
  }, { preserveNode: true });
  assert.equal(finalizedNode, null, 'settlement should wait for the remaining display tokens');
  while (harness.pendingFrameCount() > 0) harness.runNextFrame();
  assert.equal(finalizedNode, streamingNode, 'smooth finalization should hand the existing streaming node to the final renderer');
  assert.equal(streamingNode.parentNode, harness.messagesInner, 'smooth finalization should keep the streaming node attached for in-place settlement');
}

{
  const harness = createStreamingRenderHarness();
  harness.appendTextDelta('仍在流式输出');
  harness.renderEvent({
    type: 'message',
    role: 'assistant',
    runId: 'run-history-prepend',
    content: '更早的历史输出',
  }, false, { historyPrepend: true });
  assert.equal(
    harness.pendingFrameCount(),
    1,
    'history prepend rendering should not drain or finalize the active streaming frame',
  );
  assert.equal(
    harness.renderedMessages.length,
    1,
    'history prepend assistant messages should render synchronously instead of waiting for streaming finalization',
  );
  assert.equal(
    harness.renderedMessages[0].options.mergeAssistantRunMessages,
    false,
    'history prepend assistant messages should disable same-run assistant merging',
  );
  assert.equal(
    harness.messagesInner.children[harness.messagesInner.children.length - 1],
    harness.renderedMessages[0].node,
    'history prepend render should append a standalone node for the prepend loader to move above the anchor',
  );
}

{
  const harness = createStreamingRenderHarness();
  harness.setMobileCompact(true);
  harness.renderEvent({
    type: 'operation',
    seq: 12,
    kind: 'command',
    state: 'running',
    operationId: 'op-history-prepend',
  }, false, { historyPrepend: true });
  assert.equal(
    harness.runActivityCalls.length,
    0,
    'mobile history prepend operation events should not update the current live activity state',
  );
  assert.equal(
    harness.operationCalls.length,
    0,
    'mobile history prepend operation events should not render the inline live activity row at the bottom',
  );
  assert.equal(
    harness.messagesInner.children.some((node) => node.className === 'live-operation-row'),
    false,
    'mobile history prepend operation events should not append bottom operation nodes',
  );
}

{
  const harness = createStreamingRenderHarness();
  harness.messagesEl.scrollHeight = 300;
  harness.messagesEl.clientHeight = 100;
  harness.messagesEl.scrollTop = 200;

  harness.appendTextDelta('贴底输出');
  harness.runNextFrame();
  assert.ok(
    harness.renders[0].length > 0 && harness.renders[0].length < '贴底输出'.length,
    'near-bottom streaming should render its first display token',
  );
  assert.equal(harness.pendingFrameCount(), 1, 'remaining tokens should keep the single rAF stream chain scheduled');
  assert.equal(harness.messagesEl.scrollTop, 300, 'near-bottom streaming should have pinned the viewport synchronously');

  harness.messagesEl.scrollTop = 120;
  assert.equal(
    harness.messagesEl.scrollTop,
    120,
    'no deferred scroll frame should remain to pull the viewport down after the user scrolls up',
  );
}

for (const [name, adapter] of [
  ['Codex', createCodexAdapter()],
  ['Copilot', createCopilotAdapter()],
]) {
  const directDeltaEvents = adapter.parseLine(JSON.stringify({
    type: 'agent_message_content_delta',
    item_id: 'item_stream',
    content_index: 2,
    delta: '真',
  }));
  assert.equal(directDeltaEvents.length, 1, `${name} should emit direct content delta events`);
  assert.equal(directDeltaEvents[0].type, 'text_delta');
  assert.equal(directDeltaEvents[0].text, '真');
  assert.equal(directDeltaEvents[0].blockIndex, 2);

  const itemDeltaEvents = adapter.parseLine(JSON.stringify({
    type: 'item.updated',
    item: {
      id: 'item_stream',
      type: 'agent_message',
      content_delta: ' token',
    },
  }));
  assert.equal(itemDeltaEvents.length, 1, `${name} should emit explicit item content deltas`);
  assert.equal(itemDeltaEvents[0].type, 'text_delta');
  assert.equal(itemDeltaEvents[0].text, ' token');

  const accumulatedTextEvents = adapter.parseLine(JSON.stringify({
    type: 'item.updated',
    item: {
      id: 'item_stream',
      type: 'agent_message',
      text: 'already accumulated text',
    },
  }));
  assert.deepEqual(
    accumulatedTextEvents,
    [],
    `${name} should not treat accumulated item text as a replay-safe delta`,
  );
}


{
  // computeStreamingBlockSplit: blank-line boundaries outside fences
  const harness = createStreamingRenderHarness();
  const split = harness.computeStreamingBlockSplit;
  assert.equal(split('hello world'), 0, 'single paragraph has no stable prefix');
  assert.equal(split('a\n\nb'), 3, 'two paragraphs split at the blank line');
  assert.equal(split('text\n\n```js\ncode\nmore'), 6, 'open code fence keeps the whole fenced region in the suffix');
  assert.equal(
    split('text\n\n```js\ncode\n```\n\nmore'),
    22,
    'a closed code fence becomes stable after its trailing blank line',
  );
  assert.equal(split('- a\n- b\n\nnext'), 9, 'a completed list becomes stable after the blank line');
  assert.equal(split('| a |\n| b |\n\nmore'), 13, 'a completed table becomes stable after the blank line');
  assert.equal(split(''), 0, 'empty text splits at zero');
}

{
  // canUseStreamingBlockRender: math and plan tags fall back to full renders
  const harness = createStreamingRenderHarness();
  const canBlock = harness.canUseStreamingBlockRender;
  assert.equal(canBlock('普通段落\n\n- 列表'), true, 'plain markdown may use block rendering');
  assert.equal(canBlock('价格是 $50 元'), false, 'dollar math markers fall back to full rendering');
  assert.equal(canBlock('<proposed_plan>\n内容'), false, 'plan tags fall back to full rendering');
  assert.equal(canBlock(''), false, 'empty text never block-renders');
}

{
  // Adaptive catch-up: a provider flush (one large backlog) must accelerate
  // along a bounded ramp instead of typing one grapheme per frame forever.
  const harness = createStreamingRenderHarness();
  const flush = '这次服务端一次性刷新了整段内容，'.repeat(12);
  harness.appendTextDelta(flush);
  let frames = 0;
  harness.runNextFrame();
  frames += 1;
  while (harness.pendingFrameCount() > 0) {
    harness.advanceMs(16.7);
    harness.runNextFrame();
    frames += 1;
    assert.ok(frames < 500, 'the accelerated drain should terminate');
  }
  assert.equal(
    harness.renders.at(-1) || harness.fragmentRenders.at(-1),
    flush,
    'the accelerated drain must still render the complete text',
  );
  assert.ok(
    frames < flush.length,
    `a ${flush.length}-grapheme backlog should drain in fewer than ${flush.length} frames (got ${frames})`,
  );
  assert.ok(
    harness.renders[0].length === 1,
    'the ramp must still start from a single grapheme instead of popping a block of text',
  );
  for (let index = 1; index < harness.renders.length; index += 1) {
    assert.ok(
      harness.renders[index].length >= harness.renders[index - 1].length,
      'revealed text must advance monotonically',
    );
  }
}

{
  // Markdown relayout is time-gated (~30fps) while reveal keeps screen cadence.
  const harness = createStreamingRenderHarness();
  const markdown = '# 标题\n\n第二段 **加粗** 与 `代码` 示例。';
  harness.appendTextDelta(markdown);
  let frames = 0;
  harness.runNextFrame();
  frames += 1;
  while (harness.pendingFrameCount() > 0) {
    harness.advanceMs(16.7);
    harness.runNextFrame();
    frames += 1;
    assert.ok(frames < 500, 'the markdown stream should terminate');
  }
  assert.ok(
    harness.fragmentRenders.length >= 2,
    'markdown should render an initial and a final frame',
  );
  assert.ok(
    harness.fragmentRenders.length < frames,
    `markdown relayouts (${harness.fragmentRenders.length}) should be throttled below the frame count (${frames})`,
  );
  assert.ok(
    markdown.endsWith(harness.fragmentRenders.at(-1)),
    'the final markdown frame must cover the tail of the streamed text',
  );
  assert.ok(
    harness.fragmentRenders.includes('# 标题\n\n'),
    'a stabilized block renders once into the prefix instead of re-parsing per frame',
  );
  assert.equal(
    harness.treeWalkerCalls(),
    0,
    'streaming must not re-style the frontier with per-frame tree walks',
  );
}

{
  // Reduced motion: no synthetic typewriter at all — the full text renders in
  // one frame and finalization is immediate.
  const harness = createStreamingRenderHarness();
  harness.setReducedMotion(true);
  harness.appendTextDelta('减少动效时全文立即可见。');
  harness.runNextFrame();
  assert.deepEqual(
    harness.renders,
    ['减少动效时全文立即可见。'],
    'reduced-motion streaming should reveal the whole backlog on the first frame',
  );
  assert.equal(harness.pendingFrameCount(), 0, 'reduced-motion streaming should not schedule more frames');
}

{
  // A long idle gap between chunks must not replay the whole backlog: the
  // frame delta is clamped so the reveal stays gentle after a stall.
  const harness = createStreamingRenderHarness();
  harness.appendTextDelta('一二三四五');
  harness.runNextFrame();
  harness.advanceMs(5000);
  harness.appendTextDelta('六七八九十');
  harness.advanceMs(16.7);
  harness.runNextFrame();
  const revealed = harness.renders.at(-1).length - harness.renders[0].length;
  assert.ok(
    revealed > 0 && revealed <= 3,
    `an idle-gap chunk should reveal gently (revealed ${revealed} graphemes)`,
  );
}

console.log('test-streaming-typewriter: ok');
