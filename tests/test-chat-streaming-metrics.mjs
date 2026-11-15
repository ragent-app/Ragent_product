#!/usr/bin/env node
// Streaming render timing metrics (kind: "streaming-render").
//
// Contracts under test:
// 1. pumpStreamingAnimation measures every frame that actually renders
//    (shouldRenderMarkdownFrame true): it wraps the renderStreamingBody call
//    with nowMs() (at most 2 performance.now calls per render frame; frames
//    that do not render cost zero extra work).
// 2. recordStreamingRenderMetric (session-http.js) records
//    kind/renderMs/mode/textLen into the shared __ragentEventRefreshMetrics
//    store, updates the streaming totals (streamingRenderFrames / TotalMs /
//    MaxMs / BlockCount / FullCount) and store.last, and shares the existing
//    samples array + EVENT_REFRESH_METRICS_SAMPLE_LIMIT cap.
// 3. ragentGetEventRefreshMetrics() deep-copies the store, so the new
//    streaming fields are exposed automatically.
// 4. The cross-file call is progressive enhancement: realtime-render.js may
//    evaluate before session-http.js; pumping before the recorder exists must
//    render without throwing and must record nothing.
// 5. Plain text streams re-render every frame through the full path (the block
//    path is gated on streamingMarkdownMode), so every plain-text frame
//    records a full-mode sample — matching actual renderer behavior.
import assert from 'assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const realtimeRenderSource = readFileSync(join(repoRoot, 'static/chat/realtime-render.js'), 'utf8');
const sessionHttpSource = readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');

// Minimal DOM fixture. Real static/chat scripts are injected via
// addScriptTag({ content }) — the same pattern as test-message-viewport-browser.mjs.
const FIXTURE_HTML = `
  <style>
    #messages { height: 400px; overflow-y: auto; }
  </style>
  <div id="messages"><div id="messagesInner"></div></div>
  <div id="emptyState"></div>
`;

// Stub set (mirrors .tmp-send-flush-probe.mjs / test-streaming-typewriter.mjs):
// the bare globals the real scripts expect plus markdown renderer stubs and a
// deterministic pump controller. pumpOnce cancels the rAF the pump schedules so
// every token-consuming frame runs synchronously and no stray frame fires later.
const PREAMBLE_SOURCE = `
  // Deterministic frame clock: the reveal pump paces on performance.now(), so
  // the synchronous pump loops below advance a fake clock per frame to model
  // a real 60fps cadence instead of zero-width frames.
  (() => {
    const realNow = performance.now.bind(performance);
    let fakeNow = realNow() + 10000;
    performance.now = () => fakeNow;
    window.__advanceStreamClock = (ms) => { fakeNow += ms; };
  })();
  const messagesEl = document.getElementById("messages");
  const messagesInner = document.getElementById("messagesInner");
  const emptyState = document.getElementById("emptyState");
  let currentSessionId = "session-streaming-metrics";
  let inThinkingBlock = false;
  let currentThinkingBlock = null;
  let visitorMode = false;
  function shouldSkipMobileHistoryPrependEvent() { return false; }
  function findAssistantRunMergeNode() { return null; }
  function getAssistantRunMergeKeyForRender() { return ""; }
  function annotateRenderedEventViewportNodes() {}
  function movePlanProgressCardToEnd() {}
  function syncComposerPendingTurnFeedback() {}
  function renderMessageInto(container, evt) {
    const node = document.createElement("div");
    node.className = "msg-assistant";
    node.textContent = String(evt?.content || "");
    container.appendChild(node);
    return node;
  }
  function renderMessage(evt) { return renderMessageInto(messagesInner, evt); }
  function renderMessageIntoStreamingNode(node, evt) {
    node.className = "msg-assistant";
    node.textContent = String(evt?.content || "");
    node.dataset.syntheticFinalized = "true";
    return node;
  }
  window.RagentRunActivity = { noteFormalOutput() {}, applyEvent() {} };
  window.renderMarkdownIntoNode = (node, text) => { node.textContent = String(text); };
  window.renderMarkdownFragmentIntoNode = (node, text) => { node.textContent = String(text); return true; };
  window.__streamingMetricsTest = {
    append(text) { appendTextDelta(text); },
    renderDirect(evt, options = {}) { return renderEvent(evt, false, options); },
    pumpOnce() {
      window.__advanceStreamClock(16.7);
      if (streamingAnimFrame) cancelAnimationFrame(streamingAnimFrame);
      streamingAnimFrame = null;
      pumpStreamingAnimation();
      if (streamingAnimFrame) cancelAnimationFrame(streamingAnimFrame);
      streamingAnimFrame = null;
      return streamingTextContent;
    },
    drain(text) {
      // Append + synchronous pump loop until the backlog empties — mirrors the
      // rAF chain the browser would run, one pump per ~16.7ms animation frame.
      appendTextDelta(text);
      let frames = 0;
      while (streamingPendingTokens.length > 0 && frames < 2000) {
        window.__advanceStreamClock(16.7);
        if (streamingAnimFrame) cancelAnimationFrame(streamingAnimFrame);
        streamingAnimFrame = null;
        pumpStreamingAnimation();
        if (streamingAnimFrame) cancelAnimationFrame(streamingAnimFrame);
        streamingAnimFrame = null;
        frames += 1;
      }
      return { frames, text: streamingTextContent };
    },
  };
`;

const ZEROED_STREAMING_TOTALS = {
  streamingRenderFrames: 0,
  streamingRenderTotalMs: 0,
  streamingRenderMaxMs: 0,
  streamingRenderBlockCount: 0,
  streamingRenderFullCount: 0,
};

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
try {
  // --- Case 1: realtime-render.js evaluates before session-http.js (guard path) ---
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setContent(FIXTURE_HTML);
    await page.addScriptTag({ content: PREAMBLE_SOURCE });
    await page.addScriptTag({ content: realtimeRenderSource });

    // Pump markdown before the recorder exists: must render without throwing
    // and must not create a metrics store.
    const guarded = await page.evaluate(() => __streamingMetricsTest.drain('# 标题\n\n第二段 **加粗**'));
    assert.ok(guarded.frames > 1, 'the markdown stream should drain over multiple token frames');
    assert.equal(guarded.text, '# 标题\n\n第二段 **加粗**', 'guarded pumping should still render the full text');
    assert.deepEqual(pageErrors, [], 'pumping before the recorder exists must not throw');
    assert.equal(
      await page.evaluate(() => typeof window.ragentGetEventRefreshMetrics),
      'undefined',
      'no metrics surface should exist before session-http.js loads',
    );

    // The recorder arrives (session-http.js is a late-loaded classic script).
    // The store and surface install lazily on the first recorded sample.
    await page.addScriptTag({ content: sessionHttpSource });
    const beforeBootstrap = await page.evaluate(() => ({
      hasSurface: typeof window.ragentGetEventRefreshMetrics === 'function',
      hasStore: typeof window.__ragentEventRefreshMetrics === 'object',
    }));
    assert.deepEqual(
      beforeBootstrap,
      { hasSurface: false, hasStore: false },
      'the metrics store and surface should install lazily on the first record',
    );

    // Bootstrap the store with an existing event-refresh sample, then verify
    // the streaming counters initialize to zero and stay untouched by the
    // other family (no refactor of recordEventRefreshMetric).
    const fresh = await page.evaluate(() => {
      recordEventRefreshMetric({ mode: 'full', outcome: 'applied', renderMode: 'append', renderMs: 3 });
      const store = window.__ragentEventRefreshMetrics;
      return {
        hasSurface: typeof window.ragentGetEventRefreshMetrics === 'function',
        totals: store.totals,
        fullFetches: store.totals.fullFetches,
        streamingRenderFrames: store.totals.streamingRenderFrames,
        lastMode: store.last?.mode,
        lastRenderMode: store.last?.renderMode,
      };
    });
    assert.equal(fresh.hasSurface, true, 'ragentGetEventRefreshMetrics should exist after the first record');
    assert.deepEqual(
      fresh.totals,
      {
        fullFetches: 1,
        deltaFetches: 0,
        deltaApplied: 0,
        deltaFallbacks: 0,
        renderedResets: 0,
        renderedAppends: 1,
        renderedNoops: 0,
        ...ZEROED_STREAMING_TOTALS,
      },
      'the store should initialize the streaming counters to zero',
    );
    assert.equal(fresh.streamingRenderFrames, 0, 'an event-refresh sample must not bump streaming counters');
    assert.equal(fresh.lastMode, 'full', 'an event-refresh sample keeps its normalized fetch mode in store.last');
    assert.equal(fresh.lastRenderMode, 'append', 'store.last should reflect the most recent sample of either family');

    // Settle the placeholder from the guarded markdown drain (the streaming
    // node survives a drain until the full message event finalizes it), so the
    // next stream starts from a fresh message with reset render state.
    await page.evaluate(() => finalizeStreamingMessage());

    // Now pumping records: plain text renders every frame through the full path.
    const recorded = await page.evaluate(() => {
      const drained = __streamingMetricsTest.drain('普通文本流内容');
      const store = window.__ragentEventRefreshMetrics;
      const streamingSamples = store.samples.filter((sample) => sample.kind === 'streaming-render');
      return {
        frames: drained.frames,
        text: drained.text,
        samples: streamingSamples.map((sample) => ({ renderMs: sample.renderMs, mode: sample.mode, textLen: sample.textLen })),
        lastKind: store.last?.kind,
      };
    });
    assert.ok(recorded.frames > 1, 'the plain text stream should drain over multiple display-token frames');
    assert.equal(recorded.text, '普通文本流内容');
    assert.deepEqual(
      recorded.samples.map((sample) => sample.mode),
      Array(recorded.frames).fill('full'),
      'plain text should record a full-mode sample per display-token frame',
    );
    assert.equal(recorded.samples.at(-1)?.textLen, '普通文本流内容'.length);
    assert.ok(
      recorded.samples.every((sample, index) => index === 0 || sample.textLen >= recorded.samples[index - 1].textLen),
      'plain-text render samples should advance monotonically',
    );
    assert.ok(
      recorded.samples.every((sample) => Number.isFinite(sample.renderMs) && sample.renderMs >= 0),
      'renderMs should be a non-negative number',
    );
    assert.equal(recorded.lastKind, 'streaming-render', 'store.last should update to the newest streaming sample');
    assert.deepEqual(pageErrors, [], 'the full flow should not raise page errors');
    await page.close();
  }

  // --- Case 2: markdown stream records block-mode samples + totals + deep copy ---
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setContent(FIXTURE_HTML);
    await page.addScriptTag({ content: PREAMBLE_SOURCE });
    await page.addScriptTag({ content: sessionHttpSource }); // production order: recorder first
    await page.addScriptTag({ content: realtimeRenderSource });

    const result = await page.evaluate(() => {
      const drained = __streamingMetricsTest.drain('# 标题\n\n第二段 **加粗**');
      const store = window.__ragentEventRefreshMetrics;
      const snapshot = window.ragentGetEventRefreshMetrics();
      const samples = store.samples.map((sample) => ({
        kind: sample.kind,
        renderMs: sample.renderMs,
        mode: sample.mode,
        textLen: sample.textLen,
      }));
      return {
        frames: drained.frames,
        text: drained.text,
        totals: store.totals,
        samples,
        last: { kind: store.last?.kind, mode: store.last?.mode },
        snapshotTotals: snapshot.totals,
        snapshotSamplesLength: snapshot.samples.length,
        snapshotIsDeepCopy: snapshot.samples !== store.samples && snapshot.totals !== store.totals,
      };
    });

    assert.ok(result.frames > 1, 'markdown should drain over multiple display-token frames');
    assert.equal(result.text, '# 标题\n\n第二段 **加粗**');
    assert.ok(result.samples.length >= 2, 'markdown cadence should render an initial and a final frame');
    for (const sample of result.samples) {
      assert.equal(sample.kind, 'streaming-render', 'streaming samples should carry the kind field');
      assert.ok(Number.isFinite(sample.renderMs) && sample.renderMs >= 0, 'renderMs should be a non-negative number');
    }
    assert.ok(result.samples.some((sample) => sample.mode === 'block'), 'settled markdown should use block rendering');
    assert.equal(
      result.samples.at(-1)?.textLen,
      '# 标题\n\n第二段 **加粗**'.length,
      'the final sample should cover the complete streamed markdown',
    );
    assert.equal(result.totals.streamingRenderFrames, result.samples.length, 'totals should count every measured render frame');
    assert.equal(
      result.totals.streamingRenderBlockCount,
      result.samples.filter((sample) => sample.mode === 'block').length,
      'block-mode frames should count toward block count',
    );
    assert.equal(
      result.totals.streamingRenderFullCount,
      result.samples.filter((sample) => sample.mode === 'full').length,
      'full-mode frames should count toward full count',
    );
    assert.equal(
      result.totals.streamingRenderTotalMs,
      result.samples.reduce((sum, sample) => sum + sample.renderMs, 0),
      'TotalMs should equal the sum of renderMs samples',
    );
    assert.equal(
      result.totals.streamingRenderMaxMs,
      Math.max(...result.samples.map((sample) => sample.renderMs)),
      'MaxMs should equal the largest renderMs sample',
    );
    assert.deepEqual(result.last, { kind: 'streaming-render', mode: 'block' }, 'store.last should settle to block rendering');
    assert.deepEqual(result.snapshotTotals, result.totals, 'ragentGetEventRefreshMetrics should expose the streaming totals');
    assert.equal(result.snapshotSamplesLength, result.samples.length, 'the snapshot should carry the streaming samples');
    assert.equal(result.snapshotIsDeepCopy, true, 'ragentGetEventRefreshMetrics should deep-copy the store');
    assert.deepEqual(pageErrors, [], 'the block-stream flow should not raise page errors');
    await page.close();
  }

  // --- Case 3: cadence-skipped frames do zero measurement work ---
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(FIXTURE_HTML);
    await page.addScriptTag({ content: PREAMBLE_SOURCE });
    await page.addScriptTag({ content: sessionHttpSource });
    await page.addScriptTag({ content: realtimeRenderSource });

    const result = await page.evaluate(() => {
      // The store installs lazily on the first recorded sample.
      const count = () => (window.__ragentEventRefreshMetrics?.samples || []).length;
      const before = count();
      __streamingMetricsTest.append('`markdown cadence test`');
      __streamingMetricsTest.pumpOnce(); // frame 1: markdown flips on -> render
      const afterFirst = count();
      __streamingMetricsTest.pumpOnce(); // frame 2: cadence skip -> no render
      const afterSecond = count();
      while (streamingPendingTokens.length > 0) __streamingMetricsTest.pumpOnce();
      const afterDrain = count();
      __streamingMetricsTest.pumpOnce(); // no tokens left -> early return
      const afterIdle = count();
      return { before, afterFirst, afterSecond, afterDrain, afterIdle };
    });

    assert.equal(result.afterFirst, result.before + 1, 'frame 1 (markdown flips on) should render and record');
    assert.equal(
      result.afterSecond,
      result.afterFirst,
      'a cadence-skipped frame should record nothing (zero measurement work)',
    );
    assert.ok(result.afterDrain > result.afterFirst, 'the remaining markdown tokens should eventually render and record');
    assert.equal(result.afterIdle, result.afterDrain, 'no tokens means no pump work at all');
    await page.close();
  }

  // --- Case 4: samples share the EVENT_REFRESH_METRICS_SAMPLE_LIMIT cap ---
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(FIXTURE_HTML);
    await page.addScriptTag({ content: PREAMBLE_SOURCE });
    await page.addScriptTag({ content: sessionHttpSource });
    await page.addScriptTag({ content: realtimeRenderSource });

    // A long unbroken token is split into bounded display tokens. The reveal
    // rate accelerates while the backlog is large (bounded drain window) and
    // decays back to the per-frame floor as the backlog empties.
    const result = await page.evaluate(() => {
      __streamingMetricsTest.append('x'.repeat(5000));
      let frames = 0;
      while (streamingPendingTokens.length > 0 && frames < 2000) {
        window.__advanceStreamClock(16.7);
        if (streamingAnimFrame) cancelAnimationFrame(streamingAnimFrame);
        streamingAnimFrame = null;
        pumpStreamingAnimation();
        if (streamingAnimFrame) cancelAnimationFrame(streamingAnimFrame);
        streamingAnimFrame = null;
        frames += 1;
      }
      const store = window.__ragentEventRefreshMetrics;
      return {
        frames,
        samplesLength: store.samples.length,
        renderFrameTotal: store.totals.streamingRenderFrames,
        newestTextLen: store.samples[store.samples.length - 1]?.textLen,
      };
    });

    assert.ok(result.frames > 80, 'a large token backlog should span enough token frames to exercise the cap');
    assert.ok(
      result.frames < 1000,
      'a large backlog must drain through accelerated reveal instead of one token per frame (bounded catch-up)',
    );
    assert.equal(result.renderFrameTotal, result.frames, 'every plain-text token frame should be counted');
    assert.equal(result.samplesLength, 80, 'samples should be capped at EVENT_REFRESH_METRICS_SAMPLE_LIMIT');
    assert.equal(result.newestTextLen, 5000, 'the newest sample should survive the cap trim');
    await page.close();
  }

  // --- Case 5: a complete long assistant message gets the same frontend
  // typewriter treatment as text_delta, while the final node remains in place.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(FIXTURE_HTML);
    await page.addScriptTag({ content: PREAMBLE_SOURCE });
    await page.addScriptTag({ content: realtimeRenderSource });

    const result = await page.evaluate(() => {
      const content = "这是一段由服务端一次性推送到前端的较长消息。".repeat(12);
      __streamingMetricsTest.renderDirect(
        { type: "message", role: "assistant", content },
        { syntheticStream: true },
      );
      const initialNode = messagesInner.querySelector(".msg-assistant");
      const initialStreaming = initialNode?.classList.contains("streaming") === true;
      const initialText = initialNode?.querySelector(".msg-assistant-body")?.textContent || "";
      let frames = 0;
      while (streamingPendingTokens.length > 0 && frames < 2000) {
        window.__advanceStreamClock(16.7);
        if (streamingAnimFrame) cancelAnimationFrame(streamingAnimFrame);
        streamingAnimFrame = null;
        pumpStreamingAnimation();
        if (streamingAnimFrame) cancelAnimationFrame(streamingAnimFrame);
        streamingAnimFrame = null;
        frames += 1;
      }
      const finalNode = messagesInner.querySelector(".msg-assistant");
      return {
        contentLength: content.length,
        initialStreaming,
        initialTextLength: initialText.length,
        frames,
        pending: streamingPendingTokens.length,
        finalStreaming: finalNode?.classList.contains("streaming") === true,
        finalText: finalNode?.textContent || "",
        finalizedInPlace: finalNode?.dataset.syntheticFinalized === "true",
      };
    });

    assert.ok(result.contentLength >= 96, 'the synthetic-stream fixture should be a long message');
    assert.equal(result.initialStreaming, true, 'a long one-shot message should enter the streaming shell first');
    assert.equal(result.initialTextLength, 0, 'the first frame should not pop the whole paragraph in');
    assert.ok(result.frames > 1, 'the synthetic stream should reveal the paragraph over multiple frames');
    assert.equal(result.pending, 0, 'the synthetic stream should drain completely');
    assert.equal(result.finalStreaming, false, 'the final render should settle the streaming shell');
    assert.equal(result.finalText.length, result.contentLength, 'the final node should contain the complete message');
    assert.equal(result.finalizedInPlace, true, 'the final content should settle in the existing node');
    await page.close();
  }
} finally {
  await browser.close();
}

console.log('test-chat-streaming-metrics: ok');
