#!/usr/bin/env node
import assert from 'assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const messageCss = readFileSync(join(repoRoot, 'static/chat/chat-messages.css'), 'utf8');
const realtimeRenderSource = readFileSync(join(repoRoot, 'static/chat/realtime-render.js'), 'utf8');
const uiSource = readFileSync(join(repoRoot, 'static/chat/ui.js'), 'utf8');

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('console', (msg) => console.log('[PAGE]', msg.text()));
  await page.setContent(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { width: 100%; height: 100%; overflow: hidden; font-family: sans-serif; }
        #app { display: flex; flex-direction: column; height: 100%; }
        #messages { flex: 1; overflow-y: auto; position: relative; padding: 16px 20px; }
        #messagesInner { display: flex; flex-direction: column; width: 100%; max-width: 800px; margin: 0 auto; min-height: 100%; }
        #inputArea { height: 72px; background: #222; border-top: 1px solid #333; display: flex; align-items: center; padding: 0 16px; }
        #composerEditor { width: 100%; height: 40px; background: #333; color: #fff; border-radius: 8px; border: none; padding: 8px; }
        .msg { margin-bottom: 16px; }
        .msg-user { align-self: flex-end; max-width: 70%; }
        .msg-user-bubble { background: #2563eb; color: #fff; padding: 12px 16px; border-radius: 16px; }
        .msg-assistant { align-self: flex-start; max-width: 85%; }
        .msg-assistant-body { background: #2d3748; color: #f7fafc; padding: 14px 18px; border-radius: 16px; line-height: 1.6; }
        ${messageCss}
      </style>
    </head>
    <body>
      <div id="app">
        <div id="messages">
          <div id="messagesInner"></div>
        </div>
        <div id="inputArea">
          <textarea id="composerEditor" placeholder="Type a message..."></textarea>
        </div>
      </div>
      <div id="emptyState" style="display:none;"></div>
      <button id="scrollToBottomFab" style="display:none;"></button>
    </body>
    </html>
  `);

  await page.addScriptTag({
    content: `
      const messagesEl = document.getElementById("messages");
      const messagesInner = document.getElementById("messagesInner");
      const emptyState = document.getElementById("emptyState");
      let currentSessionId = "session_dock_test";
      let sessionStatus = "idle";
      let inThinkingBlock = false;
      function t(k) { return k; }
      function renderRealtimeIcon() { return ""; }
      function getComposerPendingSendSnapshot() { return null; }
      function getComposerRetainedSendsState() { return []; }
      function getProtectedComposerEchoRequestIds() { return new Set(); }
      function clearComposerRetainedSendState() {}
      function syncEditableMessageActions() {}
      function prefersReducedScrollMotion() { return true; }
      function markMessageViewportProgrammaticScroll() {}
      function syncMessageViewportStabilitySnapshot() {}
      ${realtimeRenderSource}
      ${uiSource}
    `,
  });

  const testResult = await page.evaluate(async () => {
    // 1. Populate some historical messages so offsetTop is substantial
    for (let i = 1; i <= 8; i++) {
      const histUser = document.createElement("div");
      histUser.className = "msg msg-user";
      histUser.innerHTML = `<div class="msg-user-bubble">Historical prompt #${i}</div>`;
      messagesInner.appendChild(histUser);

      const histAssistant = document.createElement("div");
      histAssistant.className = "msg msg-assistant";
      histAssistant.innerHTML = `<div class="msg-assistant-body">Historical answer #${i} with some descriptive explanation.</div>`;
      messagesInner.appendChild(histAssistant);
    }

    // Scroll to bottom before sending new message
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // 2. User sends a new message
    const requestId = "req-test-dock-1";
    insertComposerLocalEcho({
      requestId,
      text: "How does the docking and auto-scroll threshold work in Ragent?",
      sessionId: "session_dock_test",
      scroll: true,
    });

    // Wait for the 380ms launch animation to complete so bubble lands at docked position
    await new Promise((r) => setTimeout(r, 450));

    const userNode = (typeof findLocalEchoUserMessageNode === "function" ? findLocalEchoUserMessageNode(requestId) : null)
      || messagesInner.querySelector(".msg-user-local-echo")
      || messagesInner.querySelector(`[data-request-id="${requestId}"]`);
    const userRectAfterSend = userNode.getBoundingClientRect();
    const containerRect = messagesEl.getBoundingClientRect();
    const topMarginAfterSend = userRectAfterSend.top - containerRect.top;

    // 3. Send succeeds (POST returns 200, turn feedback syncs)
    userNode.dataset.sendAwaitingCommit = "true";
    syncComposerPendingTurnFeedback();

    const topMarginAfterAck = userNode.getBoundingClientRect().top - containerRect.top;
    const spacerEl = document.getElementById("turnViewportSpacer");
    const spacerHeightAfterAck = spacerEl ? parseInt(spacerEl.style.height, 10) : 0;

    // 4. Short assistant streaming: 2 short paragraphs
    getOrCreateStreamingMessage();
    enqueueAssistantText("First line of response.\\n\\nSecond short line of explanation.");
    // Force a pump frame
    if (typeof pumpStreamingAnimation === "function") {
      pumpStreamingAnimation();
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const topMarginAfterShortStream = userNode.getBoundingClientRect().top - containerRect.top;
    const spacerHeightAfterShortStream = spacerEl ? parseInt(spacerEl.style.height, 10) : 0;

    // 5. Long assistant streaming: exceeds viewport height
    let longText = "";
    for (let j = 1; j <= 50; j++) {
      longText += `\\nParagraph ${j}: Deep detailed technical explanation of distributed state and event loops across machines.`;
    }
    enqueueAssistantText(longText);
    while (streamingPendingTokens && streamingPendingTokens.length > 0) {
      if (typeof pumpStreamingAnimation === "function") {
        pumpStreamingAnimation();
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const topMarginAfterLongStream = userNode.getBoundingClientRect().top - containerRect.top;
    const spacerHeightAfterLongStream = spacerEl ? parseInt(spacerEl.style.height, 10) : 0;
    const bottomDistanceAfterLong = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;

    return {
      topMarginAfterSend,
      topMarginAfterAck,
      spacerHeightAfterAck,
      topMarginAfterShortStream,
      spacerHeightAfterShortStream,
      topMarginAfterLongStream,
      spacerHeightAfterLongStream,
      bottomDistanceAfterLong,
    };
  });

  console.log('Test results:', testResult);

  // Assertions:
  // 1. After sending, user bubble is docked near top (around 24px)
  assert.ok(
    testResult.topMarginAfterSend >= 18 && testResult.topMarginAfterSend <= 32,
    `User message should dock near 24px top margin after send (got ${testResult.topMarginAfterSend})`
  );

  // 2. After send ACK / commit, user bubble REMAINS docked at top (never drops to bottom!)
  assert.ok(
    testResult.topMarginAfterAck >= 18 && testResult.topMarginAfterAck <= 32,
    `User message must remain docked near top after ACK (got ${testResult.topMarginAfterAck})`
  );
  assert.ok(testResult.spacerHeightAfterAck > 0, 'Spacer must remain positive after ACK to preserve dock position');

  // 3. During short response, user bubble STILL remains docked near top
  assert.ok(
    testResult.topMarginAfterShortStream >= 18 && testResult.topMarginAfterShortStream <= 32,
    `User message must stay docked near top during short output (got ${testResult.topMarginAfterShortStream})`
  );
  assert.ok(testResult.spacerHeightAfterShortStream > 0, 'Spacer should hold remaining height during short output');

  // 4. Once output fills screen height (long stream), spacer collapses to 0, auto-scroll follows bottom, user bubble is pushed UP into history
  assert.equal(testResult.spacerHeightAfterLongStream, 0, 'Spacer should be 0px once content exceeds viewport height');
  assert.ok(
    testResult.topMarginAfterLongStream < 0,
    `User message should be pushed up out of viewport once content exceeds screen height (got ${testResult.topMarginAfterLongStream})`
  );
  assert.ok(
    testResult.bottomDistanceAfterLong <= 2,
    `Bottom distance should stay near 0 to keep newest streaming tokens visible (got ${testResult.bottomDistanceAfterLong})`
  );

  console.log('test-chat-dock-and-push: ALL ASSERTIONS PASSED!');
} finally {
  await browser.close();
}
