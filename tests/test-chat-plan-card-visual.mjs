#!/usr/bin/env node
// Visual + geometry fixture for plan cards in the conversation stream.
// Renders the plan proposal card (codex), plan approval card (Claude
// ExitPlanMode), legacy plan card, and progress card with the REAL css stack
// and a hand-built DOM mirroring ui.js render functions. Produces PNGs (for
// Gemini review) AND asserts geometry the author can read as text.
//
// Run standalone:  node tests/test-chat-plan-card-visual.mjs
// (PNGs + manifest land in /var/lib/ragent/workspace/plan-card-visual/<stamp>)
import assert from 'assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const cssFiles = [
  'static/chat/chat-base.css',
  'static/chat/chat-glass.css',
  'static/chat/chat-input.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-live-status.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-decision-sheet.css',
];
const styles = cssFiles.map((p) => readFileSync(join(repoRoot, p), 'utf8')).join('\n');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR
  || join('/var/lib/ragent/workspace/plan-card-visual', stamp);
mkdirSync(outputDir, { recursive: true });

const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

// ---- DOM fragments mirroring ui.js render functions -----------------------
function codexPlanCard({ state = 'awaiting_decision', collapsed = false, items = [] }) {
  const itemRows = items.map((it) => `
    <li class="codex-plan-card__item codex-plan-card__item--${it.status}">
      <span class="codex-plan-card__marker" aria-hidden="true"></span>
      <span class="codex-plan-card__item-text">${it.text}</span>
    </li>`).join('');
  // Kind label is the headline; the count stays glanceable, but the bare status
  // word is dropped until the plan has steps (mirrors createPlanEventCard).
  const completed = items.filter((it) => it.status === 'completed').length;
  const summary = items.length === 0
    ? ''
    : state === 'drafting'
      ? 'drafting'
      : `${completed}/${items.length} complete · ${state}`;
  const actions = state === 'awaiting_decision'
    ? `<div class="plan-card__actions">
        <button type="button" class="plan-card__action" data-plan-action="copy">Copy</button>
        <button type="button" class="plan-card__action" data-plan-action="revise">Revise</button>
        <button type="button" class="plan-card__action" data-plan-action="execute">Execute</button>
      </div>`
    : '';
  return `<section class="plan-card codex-plan-card${collapsed ? ' collapsed' : ''}" data-state="${state}">
    <button type="button" aria-expanded="${collapsed ? 'false' : 'true'}" class="plan-card__header codex-plan-card__header">
      <div class="plan-card__title-block">
        <div class="plan-card__label">Plan</div>
        ${summary ? `<div class="codex-plan-card__summary">${summary}</div>` : ''}
      </div>
      <span class="codex-plan-card__chevron">${CHEVRON}</span>
    </button>
    <button type="button" class="plan-card__copy" aria-label="Copy"><span>⧉</span></button>
    <div class="plan-card__body codex-plan-card__body"${collapsed ? ' hidden' : ''}>
      <ol class="codex-plan-card__list">${itemRows}</ol>
    </div>
    ${actions}
  </section>`;
}

function progressCard() {
  return `<section class="codex-plan-progress" data-state="executing">
    <div class="plan-card__header codex-plan-card__header">
      <div class="plan-card__title-block codex-plan-progress__line">
        <div class="plan-card__title">Progress</div>
        <div class="codex-plan-card__summary">2/4 · Installing dependencies</div>
      </div>
      <span class="codex-plan-card__chevron">${CHEVRON}</span>
    </div>
    <div class="plan-card__body codex-plan-card__body">
      <ol class="codex-plan-card__list">
        <li class="codex-plan-card__item codex-plan-card__item--completed"><span class="codex-plan-card__marker" aria-hidden="true"></span><span class="codex-plan-card__item-text">Read current cache layer</span></li>
        <li class="codex-plan-card__item codex-plan-card__item--completed"><span class="codex-plan-card__marker" aria-hidden="true"></span><span class="codex-plan-card__item-text">Map write hot-paths</span></li>
        <li class="codex-plan-card__item codex-plan-card__item--in_progress"><span class="codex-plan-card__marker" aria-hidden="true"></span><span class="codex-plan-card__item-text">Install dependencies</span></li>
        <li class="codex-plan-card__item"><span class="codex-plan-card__marker" aria-hidden="true"></span><span class="codex-plan-card__item-text">Migrate call sites</span></li>
      </ol>
    </div>
  </section>`;
}

function approvalCard({ approved = false } = {}) {
  const status = approved
    ? '<div class="plan-card__status">Approved</div>'
    : `<div class="plan-card__actions">
        <button type="button" class="plan-card__action" data-approval-decision="approve">Execute</button>
        <button type="button" class="plan-card__action" data-plan-action="revise">Modify</button>
        <button type="button" class="plan-card__action" data-approval-decision="deny">Deny</button>
      </div>`;
  return `<section class="plan-card codex-plan-card plan-approval-card" data-state="${approved ? 'approved' : 'pending'}">
    <div class="plan-card__header">
      <div class="plan-card__title-block">
        <div class="plan-card__label">Plan</div>
        <div class="plan-card__title">Apply the proposed migration plan</div>
      </div>
    </div>
    <button type="button" class="plan-card__copy" aria-label="Copy"><span>⧉</span></button>
    <div class="plan-card__body md-content">
      <ul><li>Update the build script</li><li>Add a cache guard</li><li>Run the full test suite</li></ul>
    </div>
    ${status}
  </section>`;
}

function legacyCard() {
  return `<section class="plan-card">
    <div class="plan-card__header">
      <div class="plan-card__title-block">
        <div class="plan-card__label">Plan</div>
        <div class="plan-card__title">Generate a weekly report</div>
      </div>
    </div>
    <div class="plan-card__body md-content">
      <ul><li>Collect sales data</li><li>Summarize top movers</li><li>Email the digest</li></ul>
    </div>
  </section>`;
}

// ---- fixture HTML ----------------------------------------------------------
function fixtureHtml({ cards }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${styles}</style>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; }
    body { background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; display: flex; flex-direction: column; }
    .messages { flex: 1 1 auto; overflow-y: auto; padding: 16px 14px 40px; display: flex; flex-direction: column; gap: 6px; }
    .assistant { max-width: 88%; align-self: flex-start; padding: 10px 14px; border-radius: 18px; background: var(--bg-secondary); font-size: 14px; line-height: 1.45; }
    .user { max-width: 80%; align-self: flex-end; padding: 10px 14px; border-radius: 18px; background: var(--user-bubble, var(--bg-secondary)); font-size: 14px; line-height: 1.45; }
  </style>
</head>
<body>
  <main class="messages" aria-label="Conversation">
    <div class="assistant">Here&rsquo;s the plan I&rsquo;m proposing. Review it and make a decision when ready.</div>
    ${cards}
  </main>
</body>
</html>`;
}

const scenarios = [
  // Codex proposal cards across widths + themes
  { name: 'plan-proposal-awaiting-360-light', width: 360, height: 800, colorScheme: 'light', cards: () => codexPlanCard({ state: 'awaiting_decision', items: [
    { text: 'Map the current cache layer', status: 'completed' },
    { text: 'Refactor hot write-paths to the new store', status: 'completed' },
    { text: 'Wire up metrics and alerting', status: 'completed' },
    { text: 'Run the full build + test suite', status: 'pending' },
  ] }) },
  { name: 'plan-proposal-awaiting-390-light', width: 390, height: 844, colorScheme: 'light', cards: () => codexPlanCard({ state: 'awaiting_decision', items: [
    { text: 'Map the current cache layer', status: 'completed' },
    { text: 'Refactor hot write-paths to the new store', status: 'completed' },
    { text: 'Wire up metrics and alerting', status: 'completed' },
    { text: 'Run the full build + test suite', status: 'pending' },
  ] }) },
  { name: 'plan-proposal-awaiting-390-dark', width: 390, height: 844, colorScheme: 'dark', cards: () => codexPlanCard({ state: 'awaiting_decision', items: [
    { text: 'Map the current cache layer', status: 'completed' },
    { text: 'Refactor hot write-paths to the new store', status: 'completed' },
    { text: 'Wire up metrics and alerting', status: 'completed' },
    { text: 'Run the full build + test suite', status: 'pending' },
  ] }) },
  { name: 'plan-proposal-awaiting-430-light', width: 430, height: 932, colorScheme: 'light', cards: () => codexPlanCard({ state: 'awaiting_decision', items: [
    { text: 'Map the current cache layer', status: 'completed' },
    { text: 'Refactor hot write-paths to the new store', status: 'completed' },
    { text: 'Wire up metrics and alerting', status: 'completed' },
    { text: 'Run the full build + test suite', status: 'pending' },
  ] }) },
  { name: 'plan-proposal-awaiting-1024-light', width: 1024, height: 768, colorScheme: 'light', cards: () => codexPlanCard({ state: 'awaiting_decision', items: [
    { text: 'Map the current cache layer', status: 'completed' },
    { text: 'Refactor hot write-paths to the new store', status: 'completed' },
    { text: 'Wire up metrics and alerting', status: 'completed' },
    { text: 'Run the full build + test suite', status: 'pending' },
  ] }) },
  { name: 'plan-proposal-awaiting-1440-dark', width: 1440, height: 900, colorScheme: 'dark', cards: () => codexPlanCard({ state: 'awaiting_decision', items: [
    { text: 'Map the current cache layer', status: 'completed' },
    { text: 'Refactor hot write-paths to the new store', status: 'completed' },
    { text: 'Wire up metrics and alerting', status: 'completed' },
    { text: 'Run the full build + test suite', status: 'pending' },
  ] }) },
  // Approximation card (Claude ExitPlanMode)
  { name: 'plan-approval-pending-390-light', width: 390, height: 844, colorScheme: 'light', cards: () => approvalCard() },
  { name: 'plan-approval-pending-390-dark', width: 390, height: 844, colorScheme: 'dark', cards: () => approvalCard() },
  { name: 'plan-approval-approved-390-light', width: 390, height: 844, colorScheme: 'light', cards: () => approvalCard({ approved: true }) },
  { name: 'plan-approval-approved-1440-dark', width: 1440, height: 900, colorScheme: 'dark', cards: () => approvalCard({ approved: true }) },
  // Progress card — hidden on mobile (run sheet owns mobile progress), so
  // render at desktop where the inline progress card is the real surface.
  { name: 'plan-progress-1024-light', width: 1024, height: 768, colorScheme: 'light', cards: () => progressCard() },
  { name: 'plan-progress-1440-dark', width: 1440, height: 900, colorScheme: 'dark', cards: () => progressCard() },
  // Legacy / collapsed / long-title / chinese stress
  { name: 'plan-legacy-390-light', width: 390, height: 844, colorScheme: 'light', cards: () => legacyCard() },
  { name: 'plan-proposal-collapsed-390-light', width: 390, height: 844, colorScheme: 'light', cards: () => codexPlanCard({ state: 'awaiting_decision', collapsed: true, items: [
    { text: 'Map the current cache layer', status: 'completed' },
    { text: 'Refactor hot write-paths to the new store', status: 'completed' },
    { text: 'Wire up metrics and alerting', status: 'completed' },
    { text: 'Run the full build + test suite', status: 'pending' },
  ] }) },
  // No steps yet: header is just the kind label (bare status word dropped)
  { name: 'plan-proposal-empty-390-light', width: 390, height: 844, colorScheme: 'light', cards: () => codexPlanCard({ state: 'awaiting_decision', items: [] }) },
  { name: 'plan-longtitle-zh-390-light', width: 390, height: 844, colorScheme: 'light', cards: () => `
    <section class="plan-card codex-plan-card" data-state="awaiting_decision">
      <button type="button" aria-expanded="true" class="plan-card__header codex-plan-card__header">
        <div class="plan-card__title-block">
          <div class="plan-card__label">Plan</div>
          <div class="codex-plan-card__summary">1/2 complete · awaiting_decision</div>
        </div>
        <span class="codex-plan-card__chevron">${CHEVRON}</span>
      </button>
      <div class="plan-card__body codex-plan-card__body">
        <ol class="codex-plan-card__list">
          <li class="codex-plan-card__item codex-plan-card__item--completed"><span class="codex-plan-card__marker" aria-hidden="true"></span><span class="codex-plan-card__item-text">重构缓存层并把可观测指标全部接入实时监控与告警链路（同时确保迁移过程不中断）</span></li>
          <li class="codex-plan-card__item codex-plan-card__item--in_progress"><span class="codex-plan-card__marker" aria-hidden="true"></span><span class="codex-plan-card__item-text">重构写路径到新的存储后端并校验一致性</span></li>
        </ol>
      </div>
    </section>`,
  },
];

const metricsByName = {};
const browser = await chromium.launch();
try {
  for (const scenario of scenarios) {
    const html = fixtureHtml({ cards: scenario.cards() });
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.colorScheme,
    });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const path = join(outputDir, `${scenario.name}.png`);
    await page.screenshot({ path, fullPage: false });

    const m = await page.evaluate(() => {
      const rect = (sel) => {
        const v = document.querySelector(sel)?.getBoundingClientRect();
        return v ? { top: v.top, right: v.right, bottom: v.bottom, left: v.left, width: v.width, height: v.height } : null;
      };
      const card = document.querySelector('.plan-card, .codex-plan-progress');
      const executed = document.querySelector('.plan-card__action[data-plan-action="execute"]');
      const approve = document.querySelector('.plan-card__action[data-approval-decision="approve"]');
      const items = [...document.querySelectorAll('.codex-plan-card__item')].map((el) => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent.trim().slice(0, 30), width: r.width, height: r.height };
      });
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        card: rect('.plan-card, .codex-plan-progress'),
        execute: executed ? rect('.plan-card__action[data-plan-action="execute"]') : null,
        approve: approve ? rect('.plan-card__action[data-approval-decision="approve"]') : null,
        itemCount: items.length,
        items,
      };
    });
    metricsByName[scenario.name] = m;

    assert.ok(m.scrollWidth <= m.viewportWidth + 1, `${scenario.name}: no horizontal scroll (got scrollWidth=${m.scrollWidth} viewport=${m.viewportWidth})`);
    assert.ok(m.card && m.card.width > 0, `${scenario.name}: plan card must render`);
    assert.ok(m.card.left >= 0 && m.card.right <= m.viewportWidth + 1, `${scenario.name}: plan card within viewport horizontally`);
    const isMobile = scenario.width < 768;
    if (m.execute) {
      const min = isMobile ? 44 : 32;
      assert.ok(m.execute.height >= min, `${scenario.name}: execute action must be >=${min}px (got ${m.execute.height})`);
    }
    if (m.approve) {
      const min = isMobile ? 44 : 32;
      assert.ok(m.approve.height >= min, `${scenario.name}: approve action must be >=${min}px (got ${m.approve.height})`);
    }
    for (const item of m.items) assert.ok(item.width <= m.viewportWidth, `${scenario.name}: item text must not overflow (width ${item.width} <= ${m.viewportWidth})`);
    await page.close();
  }
  console.log(`test-chat-plan-card-visual: ok (${outputDir})`);
} finally {
  await browser.close();
}

const manifest = {
  createdAt: new Date().toISOString(),
  repoRoot,
  scenarios: scenarios.length,
  outputDir,
  screenshots: scenarios.map((s) => `${s.name}.png`),
};
writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(outputDir, 'geometry-metrics.json'), `${JSON.stringify(metricsByName, null, 2)}\n`);
console.log(`screenshots: ${scenarios.length}`);
