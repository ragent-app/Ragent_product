#!/usr/bin/env node
// History-pagination motion fixture. It uses the shipped message CSS with a
// synthetic older-page load so the user can see the active loading cue, the
// short staggered entrance, the settled transcript, and the reduced-motion
// fallback without touching private session content.
import assert from 'assert/strict';
import { mkdirSync, readFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || mkdtempSync(join(tmpdir(), 'ragent-history-pagination-visual-'));
if (requestedOutputDir) mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-responsive.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

function fixtureHtml() {
  const nodes = Array.from({ length: 18 }, (_, index) => {
    const delay = Math.min(180, index * 18);
    const type = index % 2 === 0 ? 'msg-assistant' : 'msg-user';
    const body = index % 2 === 0
      ? `<div class="msg-assistant-body">Earlier result ${index + 1}: the history is arriving in a quiet, readable sequence.</div>`
      : `<div class="msg-user-bubble"><span>Earlier request ${index + 1}</span></div>`;
    return `<div class="${type} history-entry-node" style="--history-entry-delay:${delay}ms">${body}</div>`;
  }).join('');
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-ui); }
  #messages { height: 100%; max-height: 100%; }
  #messagesInner { display: grid; gap: 6px; padding-bottom: 48px; }
  .msg-assistant-body { max-width: 62ch; }
  .fixture-caption { margin: 12px auto 8px; color: var(--text-muted); font-size: 11px; text-align: center; }
</style></head>
<body>
  <main class="messages" id="messages">
    <div class="messages-history-loader is-visible" id="historyLoader" role="status" aria-live="polite">
      <div class="messages-history-loader__pill">
        <span class="messages-history-loader__dot" aria-hidden="true"></span>
        <span class="messages-history-loader__label">正在加载更早的消息…</span>
      </div>
    </div>
    <div class="messages-inner" id="messagesInner">
      <div class="fixture-caption">向上滚动时，较早的消息会从这里继续接上。</div>
      ${nodes}
    </div>
  </main>
</body></html>`;
}

const scenarios = [
  { name: 'mobile-light', width: 390, height: 844, colorScheme: 'light', reducedMotion: false },
  { name: 'mobile-dark', width: 390, height: 844, colorScheme: 'dark', reducedMotion: false },
  { name: 'desktop-light', width: 1440, height: 900, colorScheme: 'light', reducedMotion: false },
  { name: 'desktop-dark', width: 1440, height: 900, colorScheme: 'dark', reducedMotion: false },
  { name: 'mobile-reduced', width: 390, height: 844, colorScheme: 'light', reducedMotion: true },
];

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.colorScheme,
      reducedMotion: scenario.reducedMotion ? 'reduce' : 'no-preference',
    });
    const page = await context.newPage();
    await page.setContent(fixtureHtml(), { waitUntil: 'load' });
    await page.waitForTimeout(scenario.reducedMotion ? 80 : 90);
    await page.screenshot({ path: join(outputDir, `history-loading-${scenario.name}.png`) });

    const activeMetrics = await page.evaluate(() => {
      const loader = document.getElementById('historyLoader');
      const dot = loader?.querySelector('.messages-history-loader__dot');
      const entries = [...document.querySelectorAll('.history-entry-node')];
      const messages = document.getElementById('messages');
      return {
        loaderOpacity: getComputedStyle(loader).opacity,
        loaderHeight: loader.getBoundingClientRect().height,
        loaderAnimation: getComputedStyle(dot, '::after').animationName,
        entryAnimation: getComputedStyle(entries[0]).animationName,
        entryDelays: entries.slice(0, 4).map((node) => getComputedStyle(node).animationDelay),
        hOverflow: document.documentElement.scrollWidth > window.innerWidth,
        messageScrollHeight: messages.scrollHeight,
        messageClientHeight: messages.clientHeight,
      };
    });

    assert.equal(activeMetrics.hOverflow, false, `${scenario.name}: history loading must not overflow horizontally`);
    assert.equal(activeMetrics.loaderHeight, 0, `${scenario.name}: loading cue must not change transcript layout height`);
    assert.equal(activeMetrics.messageScrollHeight > activeMetrics.messageClientHeight, true, `${scenario.name}: fixture should exercise a scrollable transcript`);
    if (scenario.reducedMotion) {
      assert.equal(activeMetrics.loaderAnimation, 'none', `${scenario.name}: spinner must stop for reduced motion`);
      assert.equal(activeMetrics.entryAnimation, 'none', `${scenario.name}: entry animation must stop for reduced motion`);
    } else {
      assert.equal(activeMetrics.loaderOpacity, '1', `${scenario.name}: loading cue should be visible`);
      assert.equal(activeMetrics.loaderAnimation, 'history-loader-spin', `${scenario.name}: active load should have a purposeful spinner`);
      assert.equal(activeMetrics.entryAnimation, 'history-entry-in', `${scenario.name}: history entries should animate in`);
      assert.notEqual(activeMetrics.entryDelays[0], activeMetrics.entryDelays[3], `${scenario.name}: entries should not arrive as one simultaneous burst`);
    }

    await page.waitForTimeout(scenario.reducedMotion ? 40 : 520);
    await page.evaluate(() => {
      const loader = document.getElementById('historyLoader');
      loader.classList.remove('is-visible');
      loader.classList.add('is-leaving');
    });
    await page.waitForTimeout(scenario.reducedMotion ? 20 : 180);
    await page.screenshot({ path: join(outputDir, `history-settled-${scenario.name}.png`) });

    const settledMetrics = await page.evaluate(() => {
      const loader = document.getElementById('historyLoader');
      const entries = [...document.querySelectorAll('.history-entry-node')];
      return {
        loaderOpacity: getComputedStyle(loader).opacity,
        entryOpacities: entries.map((node) => getComputedStyle(node).opacity),
        hOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    assert.equal(settledMetrics.hOverflow, false, `${scenario.name}: settled transcript must not overflow horizontally`);
    assert.equal(settledMetrics.entryOpacities.every((value) => Number(value) >= 0.99), true, `${scenario.name}: settled history entries must be fully readable`);
    await context.close();
    console.log(`captured history pagination ${scenario.name}`);
  }
} finally {
  await browser.close();
}

console.log(`screenshots: ${outputDir}`);
console.log('test-chat-history-pagination-motion: ok');
