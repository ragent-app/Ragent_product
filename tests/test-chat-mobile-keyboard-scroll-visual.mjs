#!/usr/bin/env node
// Synthetic mobile keyboard fixture for the message viewport contract. It
// models the browser clamping a nested scroll container during the keyboard
// transaction, then verifies that the pre-layout bottom intent restores the
// latest message above the shortened visual viewport.
import assert from 'assert/strict';
import { mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const outputDir = String(
  process.env.RAGENT_VISUAL_OUTPUT_DIR
  || '/var/lib/ragent/workspace/visual-ui-reviews/2026-08-08-keyboard-message-follow-after',
).trim();
mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-input.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-responsive.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
const layoutSource = readFileSync(join(repoRoot, 'static/chat/layout-tooling.js'), 'utf8');

function fixtureHtml() {
  const events = Array.from({ length: 14 }, (_, index) => `
    <article class="fixture-message ${index % 2 ? 'fixture-message--assistant' : 'fixture-message--user'}">
      <div class="fixture-message-label">${index % 2 ? 'Assistant' : 'You'}</div>
      <div>${index % 2 ? 'A visible operational update that remains readable while the composer follows the keyboard.' : 'A message in the conversation history.'}</div>
    </article>
  `).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${styles}</style>
<style>
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  body { background: var(--chat-area-bg, #fff); color: var(--text); }
  .header { pointer-events: none; }
  .fixture-message { min-height: 72px; padding: 14px 16px; border-radius: 18px; font: 15px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; }
  .fixture-message--user { margin-left: 22%; background: var(--surface-raised, #f2f2f7); }
  .fixture-message--assistant { margin-right: 10%; background: var(--surface-soft, #f7f7f8); }
  .fixture-message-label { margin-bottom: 5px; color: var(--text-secondary); font-size: 11px; }
  #keyboardSimulation { position: fixed; inset: auto 0 0; height: 384px; display: none; z-index: 100; background: #25262b; color: #d8d9de; padding: 14px; font: 12px/1.4 ui-monospace, monospace; }
  body.keyboard-open #keyboardSimulation { display: block; }
</style></head>
<body>
  <div class="app-shell">
    <div class="header"></div>
    <div class="app-container">
      <main class="chat-area">
        <div class="messages" id="messages"><div class="messages-inner" id="messagesInner">${events}</div></div>
        <div class="input-area" id="inputArea">
          <div class="input-stack">
            <div id="liveBarSlot" class="live-bar-slot"><div id="liveBar" class="live-bar" hidden></div></div>
            <div class="queued-panel" id="queuedPanel"></div>
            <div class="input-wrapper"><div class="input-row"><textarea id="msgInput" aria-label="Message">Type a message</textarea></div><div class="input-actions-row"><button class="send-btn" type="button" aria-label="Send"></button></div></div>
          </div>
        </div>
      </main>
    </div>
  </div>
  <div id="keyboardSimulation">Synthetic software keyboard region</div>
</body></html>`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
try {
  await page.setContent(fixtureHtml(), { waitUntil: 'load' });
  await page.addScriptTag({
    content: `
      window.isDesktop = false;
      window.sidebarOverlay = document.createElement('div');
      window.msgInput = document.getElementById('msgInput');
      window.inputArea = document.getElementById('inputArea');
      window.queuedPanel = document.getElementById('queuedPanel');
      window.__visualHeight = window.innerHeight;
      window.__snapshotSticky = false;
      window.__scrollToBottomCalls = 0;
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: {
          get height() { return window.__visualHeight; },
          offsetTop: 0,
          addEventListener() {},
        },
      });
      window.getMessageViewportStabilitySnapshot = () => ({ stickyBottom: window.__snapshotSticky });
      // This intentionally represents the transient post-clamp measurement.
      // The layout pass must consume the stable snapshot instead of replacing
      // it with this false result.
      window.syncMessageViewportStabilitySnapshot = () => ({ stickyBottom: false });
      window.scrollToBottom = () => {
        window.__scrollToBottomCalls += 1;
        window.messagesEl.scrollTop = window.messagesEl.scrollHeight;
      };
      window.messagesEl = document.getElementById('messages');
      window.messagesInner = document.getElementById('messagesInner');
      window.setSyntheticVisualHeight = (height) => { window.__visualHeight = height; };
    `,
  });
  await page.addScriptTag({ content: layoutSource });
  await page.evaluate(() => {
    window.RagentLayout.syncNow('initial');
    window.messagesEl.scrollTop = window.messagesEl.scrollHeight;
    window.__scrollToBottomCalls = 0;
    window.__snapshotSticky = true;
  });
  await page.screenshot({ path: join(outputDir, 'keyboard-closed-bottom-pinned.png') });

  await page.evaluate(() => {
    // Simulate the browser's transient clamp before the layout pass observes
    // the shortened visual viewport.
    window.messagesEl.scrollTop = 0;
    window.setSyntheticVisualHeight(460);
    window.RagentLayout.syncNow('visual-viewport-resize');
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(outputDir, 'keyboard-open-message-follow.png') });

  const metrics = await page.evaluate(() => {
    const messages = document.getElementById('messages');
    const lastMessage = document.querySelector('.fixture-message:last-of-type');
    const composer = document.getElementById('inputArea');
    const appShell = document.querySelector('.app-shell');
    return {
      appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
      keyboardOpen: document.body.classList.contains('keyboard-open'),
      appBottom: appShell.getBoundingClientRect().bottom,
      composerTop: composer.getBoundingClientRect().top,
      messagesBottom: messages.getBoundingClientRect().bottom,
      lastMessageBottom: lastMessage.getBoundingClientRect().bottom,
      bottomDistance: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
      scrollToBottomCalls: window.__scrollToBottomCalls,
    };
  });
  assert.equal(metrics.appHeight, '460px', 'app shell should follow the visual viewport above the keyboard');
  assert.equal(metrics.keyboardOpen, true, 'keyboard mode should be active');
  assert.ok(Math.abs(metrics.appBottom - 460) <= 1, 'app shell should end at the visual viewport edge');
  assert.ok(Math.abs(metrics.appBottom - metrics.messagesBottom) <= 1, 'message viewport should share the shortened app bottom edge');
  assert.ok(metrics.lastMessageBottom <= metrics.composerTop + 1, 'latest message should stay above the composer surface');
  assert.ok(metrics.bottomDistance <= 1, `latest message should remain visible above the keyboard (bottom distance ${metrics.bottomDistance})`);
  assert.ok(metrics.scrollToBottomCalls >= 1, 'keyboard transaction should restore the bottom-pinned transcript');
} finally {
  await page.close();
  await browser.close();
}

console.log(`test-chat-mobile-keyboard-scroll-visual: ok (output: ${outputDir})`);
