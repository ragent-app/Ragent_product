#!/usr/bin/env node
// Synthetic visual fixture for the session-row status indicators (DESIGN.md
// Visual Review Matrix): running (slow ring), needs-action (amber dot), unread
// (blue dot) and plain rows render in a sidebar-like list at mobile width,
// light and dark themes. Asserts the three indicators compute distinct colors
// so they stay distinguishable at a glance.
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || mkdtempSync(join(tmpdir(), 'ragent-session-list-indicators-visual-'));
if (requestedOutputDir) mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-sidebar.css',
  'static/chat/chat-m3-tokens.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

const ROWS = [
  { key: 'running', dot: 'session-item-status session-item-status--running', name: '运行中的会话', hint: 'slow ring' },
  { key: 'needs-action', dot: 'session-item-status session-item-status--needs-action', name: '等待你审批的会话', hint: 'amber dot' },
  { key: 'unread', dot: 'session-item-status session-item-status--unread', name: '有新动态的会话', hint: 'blue dot' },
  { key: 'plain', dot: '', name: '普通会话', hint: 'no dot' },
];

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
    .visual-sidebar { width: 340px; margin: 16px auto; border-radius: var(--mx-r-card, 16px); background: var(--bg-secondary); padding: 8px; display: grid; gap: 2px; }
    .visual-row-tag { font-size: 11px; color: var(--text-muted); padding: 6px 8px 0; }
    .session-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border: 0; background: transparent; color: var(--text); font-size: 13px; border-radius: var(--mx-r-row, 10px); cursor: pointer; min-width: 0; }
    .session-item-info { flex: 1 1 auto; min-width: 0; }
    .session-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body>
  <main class="visual-sidebar">
    ${ROWS.map((row) => `
      <div>
        <div class="visual-row-tag">${row.key} — ${row.hint}</div>
        <button class="session-item" type="button">
          <div class="session-item-info"><div class="session-item-name">${row.name}</div></div>
          ${row.dot ? `<span class="${row.dot}" aria-label="${row.key}" role="img"></span>` : ''}
        </button>
      </div>`).join('\n')}
  </main>
</body>
</html>`;
}

const scenarios = [
  { name: 'session-list-indicators-light', colorScheme: 'light', theme: 'light' },
  { name: 'session-list-indicators-light-purple', colorScheme: 'light', theme: 'purple' },
  { name: 'session-list-indicators-dark', colorScheme: 'dark', theme: 'dark' },
  { name: 'session-list-indicators-dark-teal', colorScheme: 'dark', theme: 'teal' },
];

const browser = await chromium.launch();
const pages = [];
try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: scenario.colorScheme,
    });
    const page = await context.newPage();
    await page.setContent(fixtureHtml(), { waitUntil: 'load' });
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, scenario.theme);
    await page.waitForTimeout(60);
    await page.screenshot({ path: join(outputDir, `${scenario.name}.png`), fullPage: true });

    // Contract: the three indicators compute distinct dot colors.
    const dots = await page.evaluate(() => {
      const read = (key) => {
        const el = document.querySelector(`.session-item-status[aria-label="${key}"]`);
        if (!el) return null;
        const style = getComputedStyle(el, '::before');
        return style.backgroundColor;
      };
      return { running: read('running'), needsAction: read('needs-action'), unread: read('unread') };
    });
    assert.ok(dots.needsAction && dots.needsAction !== 'rgba(0, 0, 0, 0)', 'needs-action dot should have a visible background');
    assert.ok(dots.unread && dots.unread !== 'rgba(0, 0, 0, 0)', 'unread dot should have a visible background');
    assert.notEqual(dots.needsAction, dots.unread, 'amber needs-action dot must differ from the blue unread dot');
    assert.equal(
      dots.unread,
      scenario.colorScheme === 'dark' ? 'rgb(96, 165, 250)' : 'rgb(37, 99, 235)',
      `${scenario.name} unread dot should keep its dedicated blue state color`,
    );
    assert.equal(
      dots.needsAction,
      scenario.colorScheme === 'dark' ? 'rgb(251, 191, 36)' : 'rgb(217, 119, 6)',
      `${scenario.name} needs-action dot should keep its dedicated amber state color`,
    );
    pages.push({ context, scenario, dots });
    console.log(`captured ${scenario.name} (${scenario.colorScheme})`);
  }
} finally {
  for (const { context } of pages) await context.close();
  await browser.close();
}

console.log(`screenshots: ${outputDir}`);
console.log('test-chat-session-list-indicators-visual: ok');
