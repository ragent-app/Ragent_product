#!/usr/bin/env node
// Scroll-to-latest FAB visual fixture: renders the floating "back to latest"
// button in a real-DOM chat skeleton (real CSS tokens + the real button
// markup + the real realtime-render.js), screenshots every state and asserts
// the placement/visibility contract numerically:
//   - 44x44 circular control, right: 12px, floating 12px above the composer
//     when no floating status is present
//   - clears the complete Live Bar / queued-panel stack when those statuses
//     are rendered
//   - hidden at the bottom of the transcript, visible when scrolled away
//   - tapping it returns the transcript to the latest content
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || mkdtempSync(join(tmpdir(), 'ragent-scroll-fab-visual-'));
if (requestedOutputDir) mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-input.css',
  'static/chat/chat-live-status.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-responsive.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
const renderSource = readFileSync(join(repoRoot, 'static/chat/realtime-render.js'), 'utf8');

function fixtureHtml({ liveBar = false, liveBarCapsule = false, queued = false } = {}) {
  const liveBarMarkup = liveBar
    ? `<div id="liveBar" class="live-bar" data-state="running"${liveBarCapsule ? ' data-collapsed="capsule"' : ''}><span class="live-bar__orb" aria-hidden="true"><span class="visual-live-orb"></span></span><span class="live-bar__label">正在执行当前任务</span></div>`
    : '<div id="liveBar" class="live-bar" hidden></div>';
  const queuedPanelMarkup = queued
    ? `<div class="queued-panel visible" id="queuedPanel"><div class="queued-steer-row"><div class="queued-steer-content"><span class="queued-steer-leading-icon" aria-hidden="true"></span><div class="queued-steer-text">排队中的后续要求</div></div></div></div>`
    : '<div class="queued-panel" id="queuedPanel"></div>';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${styles}</style>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    /* Block layout, not grid: an implicit auto grid column collapses to the
       max-content width of empty fixture cards (a ~47px centered strip). */
    body { margin: 0; display: flex; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    /* Sidebar-bounded chat column, mirroring the app's desktop layout (the
       FAB is anchored to the input-area, so it must sit inside the chat
       column — never in a centered margin gutter). A definite height (not
       min-height) is required: with an auto-height grid container the 1fr
       row degrades to content size, the transcript never overflows, and the
       scroll-away signal never fires. */
    .visual-sidebar { width: 320px; flex-shrink: 0; border-right: 1px solid var(--border); background: var(--bg); }
    .visual-chat { display: grid; grid-template-rows: minmax(0, 1fr) auto; height: 100%; flex: 1; min-width: 0; }
    #messages { overflow-y: auto; }
    #messagesInner { padding: 16px 12px; display: grid; gap: 10px; }
    .visual-event { height: 420px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-secondary); }
    /* No margin: the product centers .input-stack via margin: auto, and the
       fixture must not override that (a 12px left margin breaks alignment
       with the message column on desktop). */
    .input-stack { height: 64px; border-top: 1px solid var(--border); background: var(--bg-secondary); border-radius: 14px 14px 0 0; }
    .visual-live-orb { display: block; width: 12px; height: 12px; border-radius: 50%; background: var(--status-running); box-shadow: 0 0 7px color-mix(in srgb, var(--status-running) 42%, transparent); }
    @media (max-width: 720px) {
      .visual-sidebar { display: none; }
    }
  </style>
</head>
<body>
  <aside class="visual-sidebar" aria-label="Sessions"></aside>
  <div class="visual-chat">
    <div class="messages" id="messages">
      <div class="messages-inner" id="messagesInner">
        <div class="empty-state" id="emptyState">
          <h2>Ragent Chat</h2>
          <p>Select or create a session from the sidebar.</p>
        </div>
      </div>
    </div>
    <div class="input-area" id="inputArea">
      <div class="input-stack" id="inputStack">
        <button type="button" class="scroll-to-bottom-fab" id="scrollToBottomFab" aria-label="Scroll to latest message" data-i18n-aria-label="messages.scrollToLatest"><svg class="rl-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
        <div id="liveBarSlot" class="live-bar-slot">${liveBarMarkup}</div>
        ${queuedPanelMarkup}
        <div class="input-wrapper" aria-hidden="true"></div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

const scenarios = [
  { name: 'mobile-dark-visible', width: 390, height: 844, colorScheme: 'dark', reducedMotion: 'no-preference', scrollAway: true },
  { name: 'mobile-light-visible', width: 390, height: 844, colorScheme: 'light', reducedMotion: 'no-preference', scrollAway: true },
  { name: 'desktop-dark-visible', width: 1440, height: 900, colorScheme: 'dark', reducedMotion: 'no-preference', scrollAway: true },
  { name: 'desktop-light-visible', width: 1440, height: 900, colorScheme: 'light', reducedMotion: 'no-preference', scrollAway: true },
  { name: 'mobile-dark-at-bottom', width: 390, height: 844, colorScheme: 'dark', reducedMotion: 'reduce', scrollAway: false },
  { name: 'desktop-light-at-bottom', width: 1440, height: 900, colorScheme: 'light', reducedMotion: 'no-preference', scrollAway: false },
];

async function loadFixture(page, status = {}) {
  await page.setContent(fixtureHtml(status), { waitUntil: 'load' });
  // Globals must be exposed on window (bare-identifier resolution) for the
  // classic script below — a page.evaluate scope would hide them.
  await page.addScriptTag({
    content: `
      window.messagesEl = document.getElementById("messages");
      window.messagesInner = document.getElementById("messagesInner");
      window.emptyState = document.getElementById("emptyState");
      window.currentSessionId = "session_visual";
      // The app removes the empty-state placeholder once messages exist.
      if (window.emptyState && window.emptyState.parentNode) window.emptyState.remove();
      for (let i = 0; i < 8; i += 1) {
        const event = document.createElement("div");
        event.className = "visual-event";
        window.messagesInner.appendChild(event);
      }
      window.__fixture = { messagesEl: window.messagesEl, messagesInner: window.messagesInner };
    `,
  });
  // Mirror the layout-tooling publication that the real app performs after
  // measuring the floating surfaces. The fixture owns the measured values so
  // this test remains a browser-only geometry contract rather than depending
  // on the full application bootstrap graph.
  await page.evaluate(() => {
    const root = document.documentElement;
    const gap = parseFloat(getComputedStyle(root).getPropertyValue('--chat-floating-status-gap')) || 8;
    const queue = document.getElementById('queuedPanel');
    const liveBarSlot = document.getElementById('liveBarSlot');
    const queueHeight = queue?.getBoundingClientRect().height || 0;
    const queueStackHeight = queueHeight > 0 ? queueHeight + gap : 0;
    const liveBarHeight = liveBarSlot?.getBoundingClientRect().height || 0;
    const floatingStatusHeight = liveBarHeight + queueStackHeight;
    const floatingOffset = floatingStatusHeight > 0 ? gap : 0;
    const floatingStatusFabOffset = floatingStatusHeight > 0
      ? floatingStatusHeight + floatingOffset
      : 0;
    root.style.setProperty('--chat-queued-panel-stack-height', `${Math.ceil(queueStackHeight)}px`);
    root.style.setProperty('--chat-floating-status-height', `${Math.ceil(floatingStatusHeight)}px`);
    root.style.setProperty('--chat-floating-status-fab-offset', `${Math.ceil(floatingStatusFabOffset)}px`);
  });
  await page.addScriptTag({ content: renderSource });
  // Give the rAF-scrolled rAF loop a beat to settle before measuring.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of scenarios) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.colorScheme,
      reducedMotion: scenario.reducedMotion,
    });
    await loadFixture(page);

    // Place the viewport away from the bottom (or at the bottom).
    await page.evaluate(({ scrollAway }) => {
      const { messagesEl } = window.__fixture;
      messagesEl.scrollTop = scrollAway ? 0 : messagesEl.scrollHeight;
      messagesEl.dispatchEvent(new Event('scroll'));
    }, scenario);
    // Settle the entrance transition (0.16s) before measuring/screenshotting.
    await page.waitForTimeout(220);
    await page.screenshot({ path: join(outputDir, `${scenario.name}.png`) });

    const metrics = await page.evaluate(() => {
      const { messagesEl } = window.__fixture;
      const fab = document.getElementById('scrollToBottomFab');
      const input = document.getElementById('inputStack');
      const fabRect = fab.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      const style = getComputedStyle(fab);
      return {
        width: fabRect.width,
        height: fabRect.height,
        left: fabRect.left,
        right: fabRect.right,
        rightGap: inputRect.right - fabRect.right,
        aboveGap: inputRect.top - fabRect.bottom,
        opacity: style.opacity,
        visibility: style.visibility,
        transition: style.transition,
        transform: style.transform,
        borderRadius: style.borderRadius,
        scrollTop: messagesEl.scrollTop,
        scrollHeight: messagesEl.scrollHeight,
      };
    });

    const expectedVisible = scenario.scrollAway;
    if (expectedVisible) {
      // Hidden state intentionally keeps the entrance transform (scale 0.92 +
      // translateY 6px), so the settled placement contract only holds while
      // the button is shown.
      assert.ok(Math.abs(metrics.width - 44) <= 1, `${scenario.name}: FAB width should be ~44px (got ${metrics.width})`);
      assert.ok(Math.abs(metrics.height - 44) <= 1, `${scenario.name}: FAB height should be ~44px (got ${metrics.height})`);
      assert.ok(Math.abs(metrics.rightGap - 12) <= 1, `${scenario.name}: FAB should sit 12px from the input-area right edge (got ${metrics.rightGap})`);
      assert.ok(Math.abs(metrics.aboveGap - 12) <= 1, `${scenario.name}: FAB should float 12px above the composer (got ${metrics.aboveGap})`);
      assert.ok(metrics.borderRadius.includes('50%'), `${scenario.name}: FAB should be a circle`);
      // Absolute placement inside the viewport (relative checks alone cannot
      // catch a collapsed/centered layout column).
      assert.ok(metrics.left >= 0, `${scenario.name}: FAB left edge must be in view (got ${metrics.left})`);
      assert.ok(metrics.right <= scenario.width, `${scenario.name}: FAB right edge must be in view (got ${metrics.right})`);
      assert.ok(metrics.left > scenario.width * 0.5, `${scenario.name}: FAB must sit in the right half of the viewport (got left ${metrics.left} of ${scenario.width})`);
    }
    assert.equal(metrics.opacity, expectedVisible ? '1' : '0', `${scenario.name}: opacity should track visibility`);
    assert.equal(metrics.visibility, expectedVisible ? 'visible' : 'hidden', `${scenario.name}: visibility should track scrolled-away state`);
    if (scenario.reducedMotion === 'reduce') {
      assert.equal(metrics.transform, 'none', `${scenario.name}: reduced motion should skip the entrance transform`);
    }

    // Reduced-motion contract: no transform drift on show.
    if (scenario.reducedMotion === 'reduce') {
      assert.equal(metrics.transform, 'none', 'reduced motion should skip the entrance transform');
    }

    await page.close();
  }

  // The status surfaces share the composer zone and both open upward. Verify
  // the FAB clears each topology at every representative responsive tier:
  // Live Bar only, queue only, and the complete stacked state.
  const statusScenarios = [
    { name: 'mobile-live-only', width: 360, height: 800, colorScheme: 'dark', liveBar: true, queued: false },
    { name: 'mobile-capsule-only', width: 390, height: 844, colorScheme: 'light', liveBar: true, liveBarCapsule: true, queued: false },
    { name: 'mobile-capsule-reduced', width: 390, height: 844, colorScheme: 'dark', reducedMotion: 'reduce', liveBar: true, liveBarCapsule: true, queued: false },
    { name: 'mobile-queue-only', width: 390, height: 844, colorScheme: 'light', liveBar: false, queued: true },
    { name: 'mobile-status-stack', width: 430, height: 932, colorScheme: 'dark', liveBar: true, queued: true },
    { name: 'mobile-capsule-stack', width: 430, height: 932, colorScheme: 'dark', liveBar: true, liveBarCapsule: true, queued: true },
    { name: 'tablet-status-stack', width: 1024, height: 768, colorScheme: 'light', liveBar: true, queued: true },
    { name: 'desktop-status-stack', width: 1440, height: 900, colorScheme: 'dark', liveBar: true, queued: true },
  ];
  for (const scenario of statusScenarios) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.colorScheme,
      reducedMotion: scenario.reducedMotion || 'no-preference',
    });
    await loadFixture(page, scenario);
    await page.evaluate(() => {
      const { messagesEl } = window.__fixture;
      messagesEl.scrollTop = 0;
      messagesEl.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(220);
    await page.screenshot({ path: join(outputDir, `${scenario.name}.png`) });
    const metrics = await page.evaluate(() => {
      const rect = (element) => {
        const value = element?.getBoundingClientRect();
        return value ? {
          left: value.left,
          top: value.top,
          right: value.right,
          bottom: value.bottom,
          width: value.width,
          height: value.height,
        } : null;
      };
      const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const fab = rect(document.getElementById('scrollToBottomFab'));
      const liveBar = rect(document.getElementById('liveBar'));
      const queuedPanel = rect(document.getElementById('queuedPanel'));
      const statuses = [liveBar, queuedPanel].filter((value) => value && value.height > 0);
      return {
        fab,
        liveBar,
        queuedPanel,
        statusTop: statuses.length ? Math.min(...statuses.map((value) => value.top)) : null,
        fabLiveOverlap: liveBar ? area(fab, liveBar) : 0,
        fabQueueOverlap: queuedPanel ? area(fab, queuedPanel) : 0,
        transition: getComputedStyle(document.getElementById('scrollToBottomFab')).transition,
        computedFabOffset: getComputedStyle(document.documentElement).getPropertyValue('--chat-floating-status-fab-offset').trim(),
      };
    });
    assert.ok(metrics.fab && metrics.statusTop !== null, `${scenario.name}: FAB and status surfaces must render`);
    assert.equal(metrics.fabLiveOverlap, 0, `${scenario.name}: FAB must not overlap the Live Bar`);
    assert.equal(metrics.fabQueueOverlap, 0, `${scenario.name}: FAB must not overlap the queued panel`);
    if (scenario.liveBarCapsule) {
      const centerDelta = Math.abs((metrics.fab.top + metrics.fab.height / 2) - (metrics.liveBar.top + metrics.liveBar.height / 2));
      assert.ok(centerDelta <= 1, `${scenario.name}: FAB should align with the capsule center (delta ${centerDelta}px)`);
      if (scenario.reducedMotion === 'reduce') {
        assert.doesNotMatch(metrics.transition, /(?:640|568|480)ms/, `${scenario.name}: reduced motion should disable capsule FAB movement`);
      }
    } else {
      assert.ok(metrics.fab.bottom <= metrics.statusTop - 11, `${scenario.name}: FAB should keep ~12px above the status stack (got ${metrics.statusTop - metrics.fab.bottom}px)`);
    }
    assert.notEqual(metrics.computedFabOffset, '0px', `${scenario.name}: layout tooling must publish a non-zero stack offset`);
    await page.close();
  }

  // Capsule fold/expand is a shared-element transition: the Live Bar shell and
  // FAB use the same easing, but the FAB must still remain geometrically clear
  // of the widening/shrinking bar at every sampled frame, not only at rest.
  async function assertCapsuleMotion({ name, width, height, colorScheme, queued = false }) {
    const page = await browser.newPage({
      viewport: { width, height },
      colorScheme,
      reducedMotion: 'no-preference',
    });
    await loadFixture(page, { liveBar: true, queued });
    await page.evaluate(() => {
      const { messagesEl } = window.__fixture;
      messagesEl.scrollTop = 0;
      messagesEl.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(220);

    const sampleMotion = async (direction) => {
      await page.evaluate((motion) => {
        const liveBar = document.getElementById('liveBar');
        liveBar.dataset.capsuleMotion = motion;
        if (motion === 'collapsing') liveBar.dataset.collapsed = 'capsule';
        else delete liveBar.dataset.collapsed;
      }, direction);
      return page.evaluate(async () => {
        const samples = [];
        const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
          * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const read = () => {
          const fab = document.getElementById('scrollToBottomFab').getBoundingClientRect();
          const liveBar = document.getElementById('liveBar').getBoundingClientRect();
          samples.push({
            fab: { left: fab.left, top: fab.top, right: fab.right, bottom: fab.bottom },
            liveBar: { left: liveBar.left, top: liveBar.top, right: liveBar.right, bottom: liveBar.bottom },
            fabTransform: getComputedStyle(document.getElementById('scrollToBottomFab')).transform,
            overlap: area(fab, liveBar),
          });
        };
        read();
        await new Promise((resolve) => {
          const started = performance.now();
          const tick = (now) => {
            read();
            if (now - started >= 720) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        return samples;
      });
    };

    for (const direction of ['collapsing', 'expanding']) {
      const samples = await sampleMotion(direction);
      const overlap = samples.find((sample) => sample.overlap > 0.1);
      assert.equal(overlap, undefined, `${name}: ${direction} motion must not overlap FAB and Live Bar (area ${overlap?.overlap})`);
    }
    await page.close();
  }

  await assertCapsuleMotion({ name: 'mobile-capsule-motion', width: 390, height: 844, colorScheme: 'light' });
  await assertCapsuleMotion({ name: 'mobile-capsule-stack-motion', width: 430, height: 932, colorScheme: 'dark', queued: true });

  // Tap behavior on one scenario: clicking the FAB returns to the latest
  // content (and the button hides again).
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  });
  await loadFixture(page);
  await page.evaluate(() => {
    const { messagesEl } = window.__fixture;
    messagesEl.scrollTop = 0;
    messagesEl.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(220);
  assert.equal(
    await page.evaluate(() => document.getElementById('scrollToBottomFab').classList.contains('visible')),
    true,
    'tap scenario: FAB should be visible when scrolled away',
  );
  await page.click('#scrollToBottomFab');
  await page.waitForTimeout(70);
  await page.screenshot({ path: join(outputDir, 'tap-mid-return.png') });
  const midTap = await page.evaluate(() => {
    const { messagesEl } = window.__fixture;
    return {
      scrollTop: messagesEl.scrollTop,
      targetTop: Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight),
    };
  });
  assert.ok(midTap.scrollTop > 0, 'tap scenario: return animation should leave the starting position');
  assert.ok(midTap.scrollTop < midTap.targetTop - 1, 'tap scenario: return animation should still be observable before settling');
  await page.waitForTimeout(380);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const afterTap = await page.evaluate(() => {
    const { messagesEl } = window.__fixture;
    const fab = document.getElementById('scrollToBottomFab');
    return {
      atBottom: Math.abs(messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 2,
      stillVisible: fab.classList.contains('visible'),
    };
  });
  assert.equal(afterTap.atBottom, true, 'tapping the FAB should land at the latest content');
  assert.equal(afterTap.stillVisible, false, 'tapping the FAB should hide it');
  await page.screenshot({ path: join(outputDir, 'tap-settled.png') });
  await page.close();
} finally {
  if (!requestedOutputDir) rmSync(outputDir, { recursive: true, force: true });
  await browser.close();
}

console.log(`ok — scroll-to-latest FAB visual fixtures (${scenarios.length} states + tap)`);
if (requestedOutputDir) console.log(`output: ${outputDir}`);
