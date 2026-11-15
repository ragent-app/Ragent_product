#!/usr/bin/env node
// Queue motion contract: a busy-session send gets one calm entrance, the
// server ACK settles the same row without replaying the entrance, and an empty
// queue keeps its measured surface during the short exit. The fixture uses the
// shipped queue CSS so motion is checked on the phone and desktop surfaces,
// including reduced-motion fallback.
import assert from 'assert/strict';
import { mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const outputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
if (outputDir) mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-input.css',
  'static/chat/chat-responsive.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

function fixtureHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${styles}</style>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .visual-chat { height: 100%; display: flex; flex-direction: column; }
    .visual-spacer { flex: 1 1 auto; }
    .input-area { position: relative; align-self: stretch; width: 100%; padding: 0 18px 18px; }
    .input-stack { position: relative; width: min(100%, 960px); margin: 0 auto; }
    .input-wrapper { min-height: 72px; border-radius: 18px; background: var(--surface-raised); }
  </style>
</head>
<body>
  <main class="visual-chat">
    <div class="visual-spacer"></div>
    <div class="input-area" id="inputArea">
      <div class="input-stack">
        <div class="queued-panel visible" id="queuedPanel" aria-live="polite">
          <button type="button" class="queued-summary" aria-expanded="false">
            <span class="queued-summary__icon" aria-hidden="true"></span>
            <span class="queued-summary__label">已排队 1 条后续消息</span>
            <span class="queued-summary__chevron" aria-hidden="true"></span>
          </button>
          <div id="queuedRow" class="queued-steer-row queued-steer-row--waiting queued-steer-row--optimistic is-entering" aria-busy="true">
            <div class="queued-steer-content">
              <span class="queued-steer-leading-icon" aria-hidden="true"></span>
              <div class="queued-steer-text">刚刚发送的后续要求</div>
            </div>
          </div>
        </div>
        <div class="input-wrapper"><div style="height:72px"></div></div>
      </div>
    </div>
  </main>
</body>
</html>`;
}

const scenarios = [
  { name: 'mobile-light', width: 390, height: 844, colorScheme: 'light' },
  { name: 'mobile-dark', width: 390, height: 844, colorScheme: 'dark' },
  { name: 'desktop-dark', width: 1440, height: 900, colorScheme: 'dark' },
  { name: 'mobile-reduced', width: 390, height: 844, colorScheme: 'light', reducedMotion: 'reduce' },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of scenarios) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.colorScheme,
    });
    await page.emulateMedia({ reducedMotion: scenario.reducedMotion || 'no-preference' });
    await page.setContent(fixtureHtml(), { waitUntil: 'load' });

    const motion = await page.evaluate(() => {
      const row = document.getElementById('queuedRow');
      const panel = document.getElementById('queuedPanel');
      const before = {
        panel: panel.getBoundingClientRect().toJSON(),
        row: row.getBoundingClientRect().toJSON(),
        animationName: getComputedStyle(row).animationName,
        animationIterationCount: getComputedStyle(row).animationIterationCount,
        transitionDuration: getComputedStyle(row).transitionDuration,
      };
      const stableNode = row;
      row.querySelector('.queued-steer-text').textContent = '已确认进入排队';
      row.classList.remove('queued-steer-row--optimistic', 'queued-steer-row--waiting', 'is-entering');
      row.classList.add('queued-steer-row--active', 'is-confirming');
      row.removeAttribute('aria-busy');
      const after = {
        sameNode: stableNode === document.getElementById('queuedRow'),
        panel: panel.getBoundingClientRect().toJSON(),
        row: row.getBoundingClientRect().toJSON(),
        active: row.classList.contains('queued-steer-row--active'),
        optimistic: row.classList.contains('queued-steer-row--optimistic'),
      };
      return { before, after };
    });
    const label = `${scenario.name}`;
    assert.equal(motion.after.sameNode, true, `${label}: ACK transition must keep the same row node`);
    assert.equal(motion.after.active, true, `${label}: ACK transition must settle the row as active`);
    assert.equal(motion.after.optimistic, false, `${label}: ACK transition must remove optimistic state`);
    assert.ok(Math.abs(motion.before.row.height - motion.after.row.height) <= 1, `${label}: ACK must not change row height`);
    assert.ok(Math.abs(motion.before.panel.height - motion.after.panel.height) <= 1, `${label}: ACK must not change panel height`);
    assert.notEqual(motion.before.animationIterationCount, 'infinite', `${label}: queue entrance must never loop`);
    if (scenario.reducedMotion === 'reduce') {
      assert.ok(parseFloat(motion.before.transitionDuration) <= 0.01, `${label}: reduced motion must collapse transitions`);
    }

    if (outputDir) {
      await page.screenshot({ path: join(outputDir, `${scenario.name}-confirmed.png`) });
    }

    // Establish the initial visible frame before toggling the exit state. This
    // keeps the fixture deterministic across Chromium viewport classes; the
    // shipped renderer performs the same transition after a painted frame.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
      const panel = document.getElementById('queuedPanel');
      panel.classList.remove('visible');
      panel.classList.add('is-exiting');
    });
    await page.waitForTimeout(scenario.reducedMotion === 'reduce' ? 10 : 60);
    const exitMetrics = await page.evaluate(() => {
      const panel = document.getElementById('queuedPanel');
      const mid = panel.getBoundingClientRect();
      const opacity = parseFloat(getComputedStyle(panel).opacity);
      return {
        height: mid.height,
        opacity,
        transitionDuration: getComputedStyle(panel).transitionDuration,
      };
    });
    assert.ok(exitMetrics.height > 0, `${label}: exiting queue should keep its measured surface briefly`);
    assert.ok(parseFloat(exitMetrics.transitionDuration) > 0, `${label}: exiting queue should provide a bounded fade`);
    assert.ok(exitMetrics.opacity <= 1, `${label}: exiting queue opacity should not overshoot`);
    await page.waitForTimeout(scenario.reducedMotion === 'reduce' ? 10 : 220);
    const settledOpacity = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('queuedPanel')).opacity));
    assert.ok(settledOpacity <= 0.02, `${label}: exiting queue should settle fully transparent`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`ok — queued panel motion fixtures (${scenarios.length} scenarios)`);
