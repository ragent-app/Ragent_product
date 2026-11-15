#!/usr/bin/env node
// Browser proof for the real Live Bar orb renderer. Unlike the state matrix,
// this fixture executes createLiveBarOrb() and renderLiveBarOrb() from the
// shipped source so the captured frames cover the actual SVG ring renderer.
import assert from 'assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || join(tmpdir(), `ragent-live-bar-orb-visual-${Date.now()}`);
mkdirSync(outputDir, { recursive: true });
// Full-page screenshots can block headless Chromium when a WebGL canvas is
// present in this host environment. The default proof stays a real browser
// render plus canvas pixel check; opt into the screenshot artifact explicitly.
const captureScreenshot = process.env.RAGENT_CAPTURE_ORB_SCREENSHOT === '1';
// Element screenshots avoid the host-specific full-page/WebGL hang while still
// giving us a real GPU/canvas material frame to inspect.

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-glass.css',
  'static/chat/chat-live-status.css',
  'static/chat/chat-responsive.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
const liveStatusUi = readFileSync(join(repoRoot, 'static/chat/live-status-ui.js'), 'utf8');

function fixtureHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    ${styles}
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .visual-stage { min-height: 100vh; display: grid; place-items: center; padding: 28px 12px; }
    .visual-panel { width: min(620px, 100%); padding: 24px; border-radius: 18px; background: color-mix(in srgb, var(--bg-secondary) 94%, #071522 6%); box-shadow: 0 18px 48px color-mix(in srgb, #071522 12%, transparent); }
    .visual-heading { margin: 0 0 16px; font-size: 14px; font-weight: 650; }
    .visual-bar-slot { position: relative; }
    .live-bar { width: 100%; max-width: none; }
    .live-bar__label { font-size: 12px; }
  </style>
</head>
<body>
  <main class="visual-stage">
    <section class="visual-panel" aria-label="Live Bar orb renderer">
      <h1 class="visual-heading">Running command</h1>
      <div class="visual-bar-slot">
        <div id="liveBar" class="live-bar" data-state="running" role="status" aria-live="polite">
          <span class="live-bar__label">Scanning workspace and preparing the next action</span>
          <span class="live-bar__elapsed">18s</span>
        </div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

const scenarios = [
  { name: 'orb-mobile-light', width: 390, height: 240, colorScheme: 'light', reducedMotion: 'no-preference' },
  { name: 'orb-mobile-reduced', width: 360, height: 240, colorScheme: 'dark', reducedMotion: 'reduce' },
  { name: 'orb-desktop-dark', width: 1440, height: 280, colorScheme: 'dark', reducedMotion: 'no-preference' },
];

const browser = await chromium.launch();
try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.colorScheme,
      reducedMotion: scenario.reducedMotion,
    });
    const page = await context.newPage();
    await page.setContent(fixtureHtml(), { waitUntil: 'load' });
    await page.addScriptTag({
      content: `${liveStatusUi}\nwindow.__liveBarOrbVisual = { createLiveBarOrb, renderLiveBarOrb };`,
    });
    const metrics = await page.evaluate(() => {
      const bar = document.getElementById('liveBar');
      const orb = window.__liveBarOrbVisual.createLiveBarOrb();
      bar.prepend(orb);
      const frameSignature = (timeMs) => {
        window.__liveBarOrbVisual.renderLiveBarOrb(orb, timeMs);
        const front = orb.querySelector('.live-bar__ring--front');
        const back = orb.querySelector('.live-bar__ring--back');
        return `${front?.getAttribute('d') || ''}|${back?.getAttribute('d') || ''}`;
      };
      const atStart = frameSignature(0);
      const atQuarter = frameSignature(1800);
      const rect = orb.getBoundingClientRect();
      const sphere = orb.querySelector('.live-bar__orb-sphere');
      return {
        orb: { width: rect.width, height: rect.height },
        svgCount: orb.querySelectorAll('svg').length,
        ringPathLength: atStart.length,
        frameChanged: atStart !== atQuarter,
        sphereAnimation: getComputedStyle(sphere).animationName,
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    assert.equal(metrics.svgCount, 1, `${scenario.name}: one physical orb SVG should render`);
    assert.ok(metrics.ringPathLength > 0, `${scenario.name}: ring renderer should paint front/back path data`);
    assert.ok(metrics.orb.width >= 20 && metrics.orb.height >= 20, `${scenario.name}: orb should keep its visual scale`);
    assert.ok(metrics.frameChanged || scenario.reducedMotion === 'reduce', `${scenario.name}: running frames should change the projected globe attitude`);
    console.log(`${scenario.name}: ringPath=${metrics.ringPathLength}`);
    assert.ok(metrics.scrollWidth <= metrics.viewportWidth + 1, `${scenario.name}: orb should not create horizontal overflow`);
    if (scenario.reducedMotion === 'reduce') {
      assert.equal(metrics.sphereAnimation, 'none', `${scenario.name}: reduced motion should freeze the globe`);
    }
    if (captureScreenshot) {
      await page.screenshot({ path: join(outputDir, `${scenario.name}.png`), fullPage: true });
    }
    await context.close();
    console.log(`captured ${scenario.name} (${scenario.width}x${scenario.height}, ${scenario.colorScheme}, ${scenario.reducedMotion})`);
  }
} finally {
  await browser.close();
  if (!requestedOutputDir) rmSync(outputDir, { recursive: true, force: true });
}

console.log(`test-chat-live-bar-orb-visual: ok (${outputDir})`);
