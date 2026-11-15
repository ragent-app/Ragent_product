#!/usr/bin/env node
// Synthetic visual fixture for the Live Bar waiting-subtype states (DESIGN.md
// Visual Review Matrix): every pill state (ready / plan_pending /
// danger_pending / approval_pending / awaiting_answer / running / failed) is
// rendered in its real layout — the bar slot floating above the composer —
// at mobile and desktop widths, light and dark themes. Only synthetic labels
// are used; no session content is captured.
//
// Screenshots go to $RAGENT_VISUAL_OUTPUT_DIR (or a temp dir) and the script
// also asserts that the Live Bar shell stays neutral while its Orb remains
// distinct by workflow state, so the fixture doubles as a geometry/visual
// contract check.
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || mkdtempSync(join(tmpdir(), 'ragent-live-bar-states-visual-'));
if (requestedOutputDir) mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-live-status.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-m3-components.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

// Static faithful approximation of createLiveBarOrb(): a high-resolution
// canvas carrying one faceted Foundation-inspired vault and a recessed
// diamond light well. The matrix fills the canvas deterministically below so this
// fixture stays independent of GPU availability while matching the real
// renderer's DOM contract.
function orbHtml(id, stateKey) {
  return `
    <span class="live-bar__orb" aria-hidden="true">
      <canvas class="live-bar__orb-canvas" width="144" height="144" data-state="${stateKey}" data-orb-id="${id}" aria-hidden="true"></canvas>
    </span>`;
}

const MOBILE_STATES = [
  { key: 'ready', label: '就绪' },
  { key: 'plan_pending', label: '方案待批准' },
  { key: 'danger_pending', label: '危险行为待批准' },
  { key: 'approval_pending', label: '待审批' },
  { key: 'awaiting_answer', label: '待回答' },
  { key: 'running', label: '正在分析你的需求…', elapsed: '2m 14s' },
  { key: 'failed', label: '失败' },
];

// English long labels stress i18n wrapping (DESIGN.md Content Stress).
const EN_LABELS = [
  { key: 'plan_pending', label: 'Plan awaiting approval' },
  { key: 'danger_pending', label: 'Dangerous action awaiting approval' },
  { key: 'approval_pending', label: 'Approval needed' },
  { key: 'awaiting_answer', label: 'Awaiting your reply' },
];

function barHtml(state, index) {
  const elapsed = state.elapsed
    ? `<span class="live-bar__elapsed" aria-hidden="true">${state.elapsed}</span>`
    : '<span class="live-bar__elapsed" aria-hidden="true" hidden></span>';
  return `
    <div class="live-bar-slot">
      <div id="liveBar" class="live-bar" role="status" aria-live="polite"
           data-state="${state.key}" data-state-key="${state.key}">
        ${orbHtml(index, state.key)}
        <span class="live-bar__label">${state.label}</span>
        ${elapsed}
      </div>
    </div>`;
}

function stripHtml(state, index) {
  return `
    <section class="visual-chat" aria-label="Live bar state ${state.key}">
      <div class="visual-spacer"></div>
      <div class="visual-composer-wrap">
        ${barHtml(state, index)}
        <div class="visual-composer"></div>
      </div>
    </section>`;
}

function fixtureHtml(layout) {
  const columns = layout === 'desktop' ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)';
  const states = [...MOBILE_STATES, ...EN_LABELS.map((s, i) => ({ ...s, index: i + 100 }))];
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${styles}</style>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .visual-matrix { width: 100%; max-width: ${layout === 'desktop' ? '1024px' : '390px'}; margin: 0 auto; padding: 14px; display: grid; gap: 14px; grid-template-columns: ${columns}; align-content: start; }
    .visual-chat { position: relative; min-height: 210px; display: flex; flex-direction: column; justify-content: space-between; border-radius: var(--mx-r-row, 12px); background: var(--bg); overflow: hidden; }
    .visual-spacer { flex: 1 1 auto; }
    /* The live-bar-slot positions the pill above its parent (the composer),
       so the slot must live inside the composer wrapper, mirroring chat.html. */
    .visual-composer-wrap { position: relative; flex: 0 0 auto; }
    .visual-composer { height: 54px; border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent); background: color-mix(in srgb, var(--bg) 96%, transparent); }
    .visual-state-tag { position: absolute; top: 8px; left: 10px; font-size: 11px; color: var(--text-muted); }
  </style>
</head>
<body>
  <main class="visual-matrix">
    ${states.map((s, i) => `
      <div style="position:relative; min-width:0;">
        <div class="visual-state-tag">${s.key}${s.elapsed ? ' (running w/ elapsed)' : ''}</div>
        ${stripHtml(s, i)}
      </div>`).join('\n')}
  </main>
</body>
</html>`;
}

const scenarios = [
  { name: 'live-bar-mobile-light', viewport: { width: 390, height: 844 }, colorScheme: 'light', layout: 'mobile' },
  { name: 'live-bar-mobile-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark', layout: 'mobile' },
  { name: 'live-bar-desktop-light', viewport: { width: 1440, height: 900 }, colorScheme: 'light', layout: 'desktop' },
  { name: 'live-bar-desktop-dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark', layout: 'desktop' },
];

const browser = await chromium.launch();
const pages = [];
try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      viewport: scenario.viewport,
      colorScheme: scenario.colorScheme,
    });
    const page = await context.newPage();
    await page.setContent(fixtureHtml(scenario.layout), { waitUntil: 'load' });
    const canvasMetrics = await page.evaluate(() => {
      const stateColors = {
        ready: '#b8b6a5', plan_pending: '#b9c8c4', danger_pending: '#c36d5b',
        approval_pending: '#c69b64', awaiting_answer: '#b6a477', running: '#b9c8c4', failed: '#c36d5b',
      };
      for (const canvas of document.querySelectorAll('.live-bar__orb-canvas')) {
        const ctx = canvas.getContext('2d');
        const state = canvas.dataset.state || 'ready';
        const color = stateColors[state] || stateColors.ready;
        const center = 72;
        ctx.clearRect(0, 0, 144, 144);
        const points = [
          { x: center, y: 18, z: 0 },
          { x: 116, y: 65, z: 0.2 },
          { x: center, y: 50, z: 1 },
          { x: 28, y: 78, z: -0.2 },
          { x: center, y: 96, z: -1 },
          { x: center, y: 126, z: 0 },
        ];
        const faces = [
          [0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1],
          [5, 2, 1], [5, 3, 2], [5, 4, 3], [5, 1, 4],
        ].map((indices) => ({
          indices,
          depth: indices.reduce((sum, index) => sum + points[index].z, 0) / 3,
        })).sort((a, b) => a.depth - b.depth);
        for (const face of faces) {
          const [a, b, c] = face.indices.map((index) => points[index]);
          const light = Math.max(0.42, Math.min(1, 0.74 + face.depth * 0.18));
          const base = [48, 57, 62].map((channel) => Math.round(channel * light));
          const gradient = ctx.createLinearGradient(a.x, a.y, c.x, c.y);
          gradient.addColorStop(0, `rgb(${Math.min(105, base[0] + 24)}, ${Math.min(112, base[1] + 24)}, ${Math.min(116, base[2] + 24)})`);
          gradient.addColorStop(1, `rgb(${base[0]}, ${base[1]}, ${base[2]})`);
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.lineTo(c.x, c.y);
          ctx.closePath();
          ctx.fill();
        }
        const windowOuter = 22;
        const windowInner = 9;
        ctx.fillStyle = 'rgba(10, 14, 16, .92)';
        ctx.beginPath();
        ctx.moveTo(center, center - windowOuter);
        ctx.lineTo(center + windowOuter, center);
        ctx.lineTo(center, center + windowOuter);
        ctx.lineTo(center - windowOuter, center);
        ctx.closePath();
        ctx.fill();
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.fillStyle = '#eee4c9';
        ctx.beginPath();
        ctx.moveTo(center, center - windowInner);
        ctx.lineTo(center + windowInner, center);
        ctx.lineTo(center, center + windowInner);
        ctx.lineTo(center - windowInner, center);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      return [...document.querySelectorAll('.live-bar__orb-canvas')].map((canvas) => ({
        width: canvas.width,
        height: canvas.height,
        pixels: canvas.toDataURL().length,
      }));
    });
    assert.ok(canvasMetrics.length >= 11, 'all state orbs should have a physical canvas');
    assert.ok(canvasMetrics.every(({ width, height, pixels }) => width === 144 && height === 144 && pixels > 100), 'canvas fixtures should be rendered at high resolution');
    await page.waitForTimeout(80);
    await page.screenshot({ path: join(outputDir, `${scenario.name}.png`), fullPage: true });

    // Visual contract: Live Bar is one quiet, neutral status surface. State
    // meaning stays in the labeled, state-specific Orb—not in a page-wide
    // collection of alert-color banners.
    const surfaces = await page.evaluate(() => {
      const bars = [...document.querySelectorAll('.live-bar')];
      return Object.fromEntries(bars.map((bar) => {
        const style = getComputedStyle(bar);
        return [bar.dataset.stateKey, {
          background: style.backgroundColor,
          color: style.color,
        }];
      }));
    });
    const stateKeys = ['ready', 'plan_pending', 'danger_pending', 'approval_pending', 'awaiting_answer', 'running', 'failed'];
    assert.ok(stateKeys.every((key) => surfaces[key]?.background), 'every Live Bar state should have a visible neutral surface');
    assert.equal(
      new Set(stateKeys.map((key) => surfaces[key].background)).size,
      1,
      `every Live Bar state should share one neutral background (got ${stateKeys.map((key) => surfaces[key].background).join(' | ')})`,
    );
    assert.equal(
      new Set(stateKeys.map((key) => surfaces[key].color)).size,
      1,
      'state changes should not recolor Live Bar text',
    );
    const orbSignatures = await page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll('.live-bar__orb-canvas')].map((canvas) => [
        canvas.dataset.state,
        canvas.toDataURL(),
      ]),
    ));
    assert.ok(
      new Set(Object.values(orbSignatures)).size >= 5,
      'the Orb should retain distinct workflow-state rendering after the Live Bar shell becomes neutral',
    );
    const orbTokens = await page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll('.live-bar')].map((bar) => [
        bar.dataset.stateKey,
        getComputedStyle(bar).getPropertyValue('--live-bar-orb-color').trim(),
      ]),
    ));
    assert.notEqual(orbTokens.running, orbTokens.failed, 'running and failed Orbs should retain distinct semantic colors');
    assert.notEqual(orbTokens.approval_pending, orbTokens.danger_pending, 'approval and danger Orbs should retain distinct semantic colors');
    const workflowColors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        running: root.getPropertyValue('--status-running').trim(),
        waiting: root.getPropertyValue('--status-waiting').trim(),
      };
    });
    assert.equal(
      workflowColors.running,
      scenario.colorScheme === 'dark' ? '#60a5fa' : '#2563eb',
      `${scenario.colorScheme} Live Bar should retain the dedicated running blue`,
    );
    assert.equal(
      workflowColors.waiting,
      scenario.colorScheme === 'dark' ? '#fbbf24' : '#d97706',
      `${scenario.colorScheme} Live Bar should retain the dedicated waiting amber`,
    );
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.live-bar__label')].map((el) => el.textContent));
    assert.ok(labels.length >= 11, `all state labels should render (got ${labels.length})`);
    assert.ok(labels.some((t) => t === 'Dangerous action awaiting approval'), 'English long label should render unwrapped');
    pages.push({ page, context, scenario, surfaces });
    console.log(`captured ${scenario.name} (${scenario.viewport.width}x${scenario.viewport.height}, ${scenario.colorScheme})`);
  }
} finally {
  for (const { context } of pages) await context.close();
  await browser.close();
}

console.log(`screenshots: ${outputDir}`);
console.log('test-chat-live-bar-states-visual: ok');
