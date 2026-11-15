#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || mkdtempSync(join(tmpdir(), 'ragent-live-activity-visual-'));
if (requestedOutputDir) mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-input.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-run-sheet.css',
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
    body { margin: 0; min-width: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .visual-fixture { width: min(900px, 100%); min-height: 100vh; margin: 0 auto; padding: 32px 24px; display: grid; align-content: start; gap: 18px; }
    .visual-heading { margin: 0; font-size: 16px; letter-spacing: 0; }
    .visual-timeline { min-width: 0; }
    .visual-approval { display: flex; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--warning) 38%, var(--border)); border-radius: 6px; background: color-mix(in srgb, var(--warning) 7%, var(--bg-secondary)); font-size: 12px; }
    .visual-approval code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .visual-composer { min-width: 0; padding: 10px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 96%, transparent); }
    .visual-queued { min-width: 0; margin-bottom: 8px; padding: 8px 10px; border-left: 2px solid var(--notice); background: color-mix(in srgb, var(--notice) 5%, var(--bg-secondary)); color: var(--text-secondary); font-size: 11px; }
    .visual-input { min-height: 74px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary); }
    @media (max-width: 720px) {
      .visual-fixture { padding: 18px 10px; gap: 12px; }
      .visual-composer { padding: 8px 0 0; }
    }
  </style>
</head>
<body>
  <main class="visual-fixture">
    <h1 class="visual-heading">Live execution</h1>
    <section class="visual-timeline" aria-label="Timeline">
      <div class="live-operation-row state-running kind-command" data-operation-id="operation:visual:command">
        <button class="live-operation-row__summary" type="button" aria-expanded="true">
          <span class="live-operation-row__mark" aria-hidden="true"></span>
          <span class="live-operation-row__copy">
            <span class="live-operation-row__summary-text">Running npm test</span>
            <span class="live-operation-row__label">In progress</span>
          </span>
          <span class="live-operation-row__meta"><span class="live-operation-row__elapsed">18s</span></span>
          <span class="live-operation-row__chevron">›</span>
        </button>
        <div class="live-operation-row__body">
          <code class="live-operation-row__detail-body">npm test -- --runInBand --workspace packages/a-very-long-workspace-name-without-overflow</code>
          <pre class="live-operation-row__output">test-session-display-events: ok\ntest-operation-projection: ok\nwaiting for remaining checks...</pre>
        </div>
      </div>
      <div class="live-operation-row state-completed kind-file_edit" data-operation-id="operation:visual:file-edit">
        <button class="live-operation-row__summary" type="button" aria-expanded="false">
          <span class="live-operation-row__mark" aria-hidden="true"></span>
          <span class="live-operation-row__copy">
            <span class="live-operation-row__summary-text">Edited ui.js</span>
            <span class="live-operation-row__label">Completed</span>
          </span>
          <span class="live-operation-row__meta"><span class="live-operation-row__elapsed">2.4s</span></span>
          <span class="live-operation-row__chevron">›</span>
        </button>
        <div class="live-operation-row__body" hidden>
          <code class="live-operation-row__detail-body">/srv/ragent-promoted/static/chat/ui.js</code>
        </div>
      </div>
      <div class="visual-approval runtime-approval-card" data-status="pending">
        <strong>Approval required</strong>
        <code>Allow npm test -- --runInBand</code>
      </div>
    </section>
    <section class="visual-composer" aria-label="Composer">
      <div class="visual-queued">Queued follow-up: summarize the result after verification.</div>
      <div class="input-stack">
        <div class="run-activity-strip" data-state="working" data-kind="command">
          <button class="run-activity-strip__main" type="button">
            <span class="run-activity-strip__dot" aria-hidden="true"></span>
            <span class="run-activity-strip__status" role="status" aria-live="polite">
              <span class="run-activity-strip__label">Running npm test</span>
              <span class="run-activity-strip__detail">npm test -- --runInBand --workspace packages/a-very-long-workspace-name-without-overflow</span>
            </span>
            <span class="run-activity-strip__elapsed">18s</span>
          </button>
          <button class="run-activity-strip__stop" type="button" aria-label="Stop"><span aria-hidden="true">■</span></button>
        </div>
        <div class="visual-input input-wrapper"></div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const scenarios = [
  { name: 'desktop-light', width: 1440, height: 900, colorScheme: 'light', reducedMotion: 'no-preference' },
  { name: 'desktop-dark', width: 1024, height: 768, colorScheme: 'dark', reducedMotion: 'no-preference' },
  { name: 'mobile-light', width: 390, height: 844, colorScheme: 'light', reducedMotion: 'no-preference' },
  { name: 'mobile-reduced', width: 360, height: 740, colorScheme: 'dark', reducedMotion: 'reduce' },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of scenarios) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.colorScheme,
      reducedMotion: scenario.reducedMotion,
    });
    await page.setContent(fixtureHtml(), { waitUntil: 'load' });
    await page.screenshot({ path: join(outputDir, `${scenario.name}.png`), fullPage: true });

    const metrics = await page.evaluate(() => {
      const rect = (selector) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value ? { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height } : null;
      };
      const label = document.querySelector('.run-activity-strip__label');
      const spinner = document.querySelector('.live-operation-row.state-running .live-operation-row__mark');
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        queued: rect('.visual-queued'),
        strip: rect('.run-activity-strip'),
        activityStatus: rect('.run-activity-strip__status'),
        stop: rect('.run-activity-strip__stop'),
        input: rect('.visual-input'),
        operation: rect('.live-operation-row.state-running'),
        operationSummary: rect('.live-operation-row.state-running .live-operation-row__summary'),
        output: rect('.live-operation-row__output'),
        labelAnimation: label ? getComputedStyle(label).animationName : '',
        spinnerAnimation: spinner ? getComputedStyle(spinner, '::after').animationName : '',
      };
    });

    assert.ok(metrics.strip && metrics.input && metrics.stop && metrics.operation, `${scenario.name}: required components should render`);
    assert.ok(metrics.scrollWidth <= metrics.viewportWidth + 1, `${scenario.name}: page should not scroll horizontally`);
    assert.ok(metrics.queued.bottom <= metrics.strip.top + 1, `${scenario.name}: queued follow-up should not overlap ActivityStrip`);
    assert.ok(metrics.strip.bottom <= metrics.input.top + 1, `${scenario.name}: ActivityStrip should not overlap composer input`);
    assert.ok(!overlaps(metrics.activityStatus, metrics.stop), `${scenario.name}: status text should not overlap the stop button`);
    assert.ok(metrics.stop.right <= metrics.strip.right + 1, `${scenario.name}: stop button should remain inside ActivityStrip`);
    assert.ok(metrics.operationSummary.right <= metrics.operation.right + 1, `${scenario.name}: long operation text should stay inside its row`);
    assert.ok(metrics.output.height <= 153, `${scenario.name}: output preview should remain viewport-bounded`);
    if (scenario.reducedMotion === 'reduce') {
      assert.equal(metrics.labelAnimation, 'none', `${scenario.name}: shimmer should be disabled`);
      assert.equal(metrics.spinnerAnimation, 'none', `${scenario.name}: operation spinner should be disabled`);
    } else {
      assert.ok(
        metrics.labelAnimation === 'none' || metrics.labelAnimation === 'run-activity-shimmer',
        `${scenario.name}: active label should remain static or expose one restrained shimmer`,
      );
    }
    await page.close();
  }
  console.log(`test-chat-live-activity-visual: ok (${outputDir})`);
} finally {
  await browser.close();
  if (!requestedOutputDir) rmSync(outputDir, { recursive: true, force: true });
}
