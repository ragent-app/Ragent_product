#!/usr/bin/env node
// Reconnect indicator visual fixture (P2-8): renders the real chat-live-status
// CSS in the same composer-zone structure the app ships (#liveBarSlot above the
// input stack) and asserts geometry/touch/motion numeric invariants at the
// review widths, plus emits screenshots for the Gemini visual gate.
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || mkdtempSync(join(tmpdir(), 'ragent-reconnect-visual-'));
if (requestedOutputDir) mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-live-status.css',
  'static/chat/chat-input.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

function fixtureHtml({ pillClass, variant, label, showLiveBar }) {
  const liveBar = showLiveBar
    ? '<div id="liveBar" class="live-bar" data-state="running" role="status" aria-live="polite"><span class="live-bar__label">正在运行测试</span></div>'
    : '';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${styles}</style>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { margin: 0; min-width: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    /* Mirror the shipped .app-shell grid so .input-area gets the full column
       width (its align-self:end is vertical there, not a shrink-to-fit). */
    .fixture-shell { min-height: 100%; display: grid; grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) auto; }
    .fixture-messages { grid-row: 1; display: flex; flex-direction: column; justify-content: flex-end; gap: 8px; padding: 0 var(--chat-gutter) calc(12px + var(--chat-bottom-overlay-height, 0px)); }
    .input-area { grid-row: 2; }
    .fixture-bubble { align-self: flex-end; max-width: 74%; padding: 10px 12px; border-radius: 18px 18px 6px 18px; background: var(--user-bubble, var(--bg-secondary)); font-size: 13px; line-height: 1.5; box-shadow: var(--shadow-soft); }
    .fixture-bubble--assistant { align-self: flex-start; background: var(--bg-secondary); border-radius: 18px 18px 18px 6px; color: var(--text-secondary); }
  </style>
</head>
<body>
  <div class="fixture-shell">
    <main class="fixture-messages" aria-label="Messages">
      <div class="fixture-bubble fixture-bubble--assistant">已找到断线重连的问题根因，正在执行修复脚本…</div>
      <div class="fixture-bubble fixture-bubble--assistant">修复完成，测试通过。</div>
      <div class="fixture-bubble">太好了，继续下一个任务。</div>
    </main>
    <div class="input-area">
      <div class="input-stack">
        <div id="liveBarSlot" class="live-bar-slot">
          ${liveBar}
          <div id="reconnectIndicator" class="reconnect-indicator ${pillClass}" data-variant="${variant}" role="status" aria-live="polite">
            <span class="reconnect-indicator__dot" aria-hidden="true"></span>
            <span class="reconnect-indicator__label">${label}</span>
          </div>
        </div>
        <div class="input-wrapper" style="min-height:74px; background:var(--bg-secondary); border-radius:18px; box-shadow:var(--shadow-soft); display:flex; align-items:center; justify-content:flex-end; gap:8px; padding:10px 12px;">
          <div style="flex:1; color:var(--text-muted); font-size:13px;">输入消息…</div>
          <div style="width:36px; height:36px; border-radius:50%; background:var(--notice); color:#fff; display:grid; place-items:center; font-size:18px;">↑</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

const browser = await chromium.launch({ headless: true });
// Mirror layout-tooling's bottom-overlay sync: reserve the live status slot
// height (pill included) plus the 8px gap as message-area bottom padding, so
// the floating pill never overlaps the last message in the resting state.
async function syncOverlayReservation(page) {
  await page.evaluate(() => {
    const slot = document.getElementById('liveBarSlot');
    const height = Math.ceil(slot.getBoundingClientRect().height);
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-floating-status-gap')) || 8;
    document.documentElement.style.setProperty('--chat-bottom-overlay-height', `${height + gap}px`);
  });
}

try {
  // --- Scenario 1: reconnecting pill, light, 390 (primary mobile review width) ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
    await page.setContent(fixtureHtml({ pillClass: 'is-visible', variant: 'reconnecting', label: '重连中…', showLiveBar: false }), { waitUntil: 'load' });
    await syncOverlayReservation(page);
    await page.screenshot({ path: join(outputDir, 'reconnect-pill-light-390.png'), fullPage: false });

    const m = await page.evaluate(() => {
      const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const pill = document.querySelector('.reconnect-indicator');
      const dot = document.querySelector('.reconnect-indicator__dot');
      const pillRect = pill ? pill.getBoundingClientRect() : null;
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        pill: rect('.reconnect-indicator'),
        input: rect('.input-wrapper'),
        lastBubble: rect('.fixture-messages .fixture-bubble:last-child'),
        pillHeight: pillRect ? pillRect.height : 0,
        pillCenterOffset: pillRect ? Math.abs(pillRect.left + pillRect.width / 2 - document.documentElement.clientWidth / 2) : 999,
        pillOpacity: pill ? getComputedStyle(pill).opacity : '',
        pillTransform: pill ? getComputedStyle(pill).transform : '',
        dotAnimation: dot ? getComputedStyle(dot).animationName : '',
        dotColor: dot ? getComputedStyle(dot).backgroundColor : '',
        pointerEvents: pill ? getComputedStyle(pill).pointerEvents : '',
      };
    });
    assert.ok(m.pill, '1: pill should render');
    assert.equal(m.scrollWidth <= m.viewportWidth + 1, true, '1: no horizontal scroll');
    assert.ok(m.pillHeight >= 44, `1: pill should be a 44px touch-tier row (got ${m.pillHeight})`);
    assert.ok(m.pillCenterOffset <= 1, `1: pill should be centered on the composer (offset ${m.pillCenterOffset.toFixed(2)}px)`);
    assert.equal(m.pillOpacity, '1', '1: is-visible pill should be fully opaque');
    assert.ok(m.pill.bottom <= m.input.top + 1, '1: pill should float above the composer without overlap');
    assert.ok(m.pill.top >= m.lastBubble.bottom - 1, '1: reserved overlay spacing should keep the pill clear of the last message');
    assert.ok(m.pill.left >= 0 && m.pill.right <= m.viewportWidth + 1, '1: pill should stay inside the viewport');
    assert.equal(m.dotAnimation, 'none', '1: reconnecting dot should stay static so a slow send does not feel jittery');
    assert.equal(m.pointerEvents, 'none', '1: informational pill should never block message interactions');
    await page.close();
  }

  // --- Scenario 2: reconnecting pill, dark, 430 ---
  {
    const page = await browser.newPage({ viewport: { width: 430, height: 932 }, colorScheme: 'dark' });
    await page.setContent(fixtureHtml({ pillClass: 'is-visible', variant: 'reconnecting', label: 'Reconnecting…', showLiveBar: false }), { waitUntil: 'load' });
    await syncOverlayReservation(page);
    await page.screenshot({ path: join(outputDir, 'reconnect-pill-dark-430.png') });

    const m = await page.evaluate(() => {
      const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const pill = document.querySelector('.reconnect-indicator');
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        pill: rect('.reconnect-indicator'),
        pillHeight: pill ? pill.getBoundingClientRect().height : 0,
        pillOpacity: pill ? getComputedStyle(pill).opacity : '',
        dotAnimation: document.querySelector('.reconnect-indicator__dot') ? getComputedStyle(document.querySelector('.reconnect-indicator__dot')).animationName : '',
      };
    });
    assert.ok(m.pill, '2: pill should render');
    assert.equal(m.scrollWidth <= m.viewportWidth + 1, true, '2: no horizontal scroll');
    assert.ok(m.pillHeight >= 44, `2: pill should be a 44px touch-tier row (got ${m.pillHeight})`);
    assert.equal(m.pillOpacity, '1', '2: is-visible pill should be fully opaque');
    assert.equal(m.dotAnimation, 'none', '2: dark theme keeps the reconnect dot static');
    await page.close();
  }

  // --- Scenario 3: offline variant, light, 430 ---
  {
    const page = await browser.newPage({ viewport: { width: 430, height: 932 }, colorScheme: 'light' });
    await page.setContent(fixtureHtml({ pillClass: 'is-visible', variant: 'offline', label: '网络已断开', showLiveBar: false }), { waitUntil: 'load' });
    await syncOverlayReservation(page);
    await page.screenshot({ path: join(outputDir, 'reconnect-pill-offline-430.png') });

    const m = await page.evaluate(() => {
      // Normalize a #rrggbb token to the same "rgb(r, g, b)" form getComputedStyle returns.
      const hexToRgb = (hex) => {
        const value = parseInt(hex.replace('#', ''), 16);
        return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
      };
      const dot = document.querySelector('.reconnect-indicator__dot');
      const failed = getComputedStyle(document.documentElement).getPropertyValue('--status-failed').trim();
      const warning = getComputedStyle(document.documentElement).getPropertyValue('--status-waiting').trim();
      return {
        pill: document.querySelector('.reconnect-indicator'),
        dotColor: dot ? getComputedStyle(dot).backgroundColor : '',
        expectedFailed: hexToRgb(failed),
        expectedWarning: hexToRgb(warning),
      };
    });
    assert.ok(m.pill, '3: offline pill should render');
    assert.equal(m.dotColor !== m.expectedWarning, true, '3: offline dot should not use the waiting amber');
    assert.equal(m.dotColor, m.expectedFailed, '3: offline dot should use the failed/error semantic color');
    await page.close();
  }

  // --- Scenario 4: stacked above a visible Live Bar keeps the 8px status gap ---
  {
    const page = await browser.newPage({ viewport: { width: 430, height: 932 }, colorScheme: 'dark' });
    await page.setContent(fixtureHtml({ pillClass: 'is-visible', variant: 'reconnecting', label: '重连中…', showLiveBar: true }), { waitUntil: 'load' });
    await syncOverlayReservation(page);
    await page.screenshot({ path: join(outputDir, 'reconnect-pill-stacked-430.png') });

    const m = await page.evaluate(() => {
      const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      return {
        liveBar: rect('.live-bar'),
        pill: rect('.reconnect-indicator'),
      };
    });
    assert.ok(m.liveBar && m.pill, '4: both status pills should render');
    assert.ok(Math.abs(m.pill.top - m.liveBar.bottom - 8) <= 1.5, `4: stacked pills should keep the 8px status gap (got ${(m.pill.top - m.liveBar.bottom).toFixed(2)})`);
    await page.close();
  }

  // --- Scenario 5: recovery fade is an active restrained transition (opacity strictly between 0 and 1) ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
    await page.setContent(fixtureHtml({ pillClass: 'is-visible', variant: 'reconnecting', label: '重连中…', showLiveBar: false }), { waitUntil: 'load' });
    await syncOverlayReservation(page);
    await page.evaluate(() => document.querySelector('.reconnect-indicator').classList.remove('is-visible'));
    await page.waitForTimeout(110); // ~half of the 220ms fade
    await page.screenshot({ path: join(outputDir, 'reconnect-pill-fade-390.png') });

    const m = await page.evaluate(() => {
      const pill = document.querySelector('.reconnect-indicator');
      const style = getComputedStyle(pill);
      return {
        opacity: parseFloat(style.opacity),
        transition: style.transitionProperty,
        transitionDuration: style.transitionDuration,
      };
    });
    assert.ok(m.opacity > 0 && m.opacity < 1, `5: mid-fade opacity should be strictly between 0 and 1 (got ${m.opacity})`);
    assert.ok(m.transition.includes('opacity'), '5: fade should run on opacity');
    assert.ok(m.transitionDuration.includes('0.22s'), `5: fade should use the 220ms token (got ${m.transitionDuration})`);
    await page.close();
  }

  // --- Scenario 6: reduced motion keeps the static dot and disables the transition ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light', reducedMotion: 'reduce' });
    await page.setContent(fixtureHtml({ pillClass: 'is-visible', variant: 'reconnecting', label: '重连中…', showLiveBar: false }), { waitUntil: 'load' });
    await syncOverlayReservation(page);
    const m = await page.evaluate(() => {
      const pill = document.querySelector('.reconnect-indicator');
      const dot = document.querySelector('.reconnect-indicator__dot');
      return {
        dotAnimation: dot ? getComputedStyle(dot).animationName : '',
        pillTransition: pill ? getComputedStyle(pill).transitionDuration : '',
      };
    });
    assert.equal(m.dotAnimation, 'none', '6: reduced motion should keep the dot static');
    assert.ok(parseFloat(m.pillTransition) < 0.001, `6: reduced motion should disable the pill transition (got ${m.pillTransition})`);
    await page.close();
  }

  console.log(`test-chat-reconnect-indicator-visual: ok (${outputDir})`);
} finally {
  await browser.close();
  if (!requestedOutputDir) rmSync(outputDir, { recursive: true, force: true });
}
