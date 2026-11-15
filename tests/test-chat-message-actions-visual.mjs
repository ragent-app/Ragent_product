#!/usr/bin/env node
// Message action visual fixture: the portaled mobile long-press menu and the
// compact assistant action rail. Keeps the two related surfaces in one visual
// contract so a future touch-target or surface change cannot silently split
// their geometry again.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || join(tmpdir(), `ragent-message-actions-${Date.now()}`);
mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-m3-components.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

const copyIcon = '<svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const refreshIcon = '<svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.3 5.6L21 8"/><path d="M21 3v5h-5"/></svg>';
const editIcon = '<svg class="rl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

function actionButton(action, label, icon, visibleLabel = false) {
  return `<button type="button" class="msg-action-btn msg-action-btn--${action}" aria-label="${label}" title="${label}">${icon}${visibleLabel ? `<span class="msg-action-btn__label">${label}</span>` : ''}</button>`;
}

function fixtureHtml(theme) {
  return `<!doctype html>
<html data-theme="${theme}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style>
<style>
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .fixture-canvas { min-height: 100vh; padding: 150px 12px 150px; }
  .fixture-messages { max-width: 560px; margin: 0 auto; }
  .fixture-messages-inner { display: grid; gap: 28px; }
  .msg-assistant { margin-bottom: 0; }
  .msg-user { margin-bottom: 0; }
  .fixture-menu { right: 12px; top: 430px; }
</style></head>
<body>
  <main class="fixture-canvas">
    <div class="fixture-messages messages">
      <div class="fixture-messages-inner messages-inner">
        <div class="msg-assistant md-content is-regenerable">
          <div class="msg-assistant-body">这是一条已完成的回复，底部操作应该轻、清楚，也要能被手指准确点中。</div>
          <div class="msg-meta"><div class="msg-actions">${actionButton('copy', '复制', copyIcon)}${actionButton('regenerate', '重新生成', refreshIcon)}</div></div>
        </div>
        <div class="msg-user">
          <div class="msg-user-bubble"><span>长按这条消息查看操作</span></div>
        </div>
      </div>
    </div>
  </main>
  <!-- Mirrors the production body-portal: the menu is deliberately not a child of the bubble. -->
  <div class="msg-touch-menu fixture-menu is-open" role="menu">
    ${actionButton('copy', '复制', copyIcon, true)}
    ${actionButton('edit', '编辑并重发', editIcon, true)}
  </div>
</body></html>`;
}

function collectMetrics() {
  const menu = document.querySelector('.msg-touch-menu');
  const bubble = document.querySelector('.msg-user-bubble');
  const menuButtons = [...document.querySelectorAll('.msg-touch-menu .msg-action-btn')];
  const metaButtons = [...document.querySelectorAll('.msg-assistant .msg-meta .msg-action-btn')];
  const rect = (node) => node?.getBoundingClientRect();
  const style = (node) => getComputedStyle(node);
  return {
    menuParentIsBody: menu?.parentElement === document.body,
    menuPosition: menu ? style(menu).position : null,
    menuWithinViewport: (() => {
      const r = rect(menu);
      return !!r && r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
    })(),
    menuRadius: menu ? style(menu).borderRadius : null,
    menuBackdrop: menu ? style(menu).backdropFilter : null,
    menuButtonHeights: menuButtons.map((node) => rect(node).height),
    menuButtonWidths: menuButtons.map((node) => rect(node).width),
    metaButtonHeights: metaButtons.map((node) => rect(node).height),
    metaButtonWidths: metaButtons.map((node) => rect(node).width),
    bubbleRight: rect(bubble)?.right ?? null,
    menuLeft: rect(menu)?.left ?? null,
  };
}

const scenarios = [
  { name: 'light-390', width: 390, height: 844, theme: 'light' },
  { name: 'dark-390', width: 390, height: 844, theme: 'dark' },
  { name: 'light-360', width: 360, height: 800, theme: 'light' },
  { name: 'light-430', width: 430, height: 932, theme: 'light' },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of scenarios) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.theme === 'dark' ? 'dark' : 'light',
      hasTouch: true,
    });
    await page.setContent(fixtureHtml(scenario.theme), { waitUntil: 'load' });
    await page.waitForTimeout(80);
    await page.screenshot({ path: join(outputDir, `${scenario.name}.png`) });
    const metrics = await page.evaluate(collectMetrics);

    assert.equal(metrics.menuParentIsBody, true, `${scenario.name}: context menu must be outside the message bubble DOM`);
    assert.equal(metrics.menuPosition, 'fixed', `${scenario.name}: context menu must be viewport-anchored`);
    assert.equal(metrics.menuWithinViewport, true, `${scenario.name}: context menu must stay inside the visual viewport`);
    assert.match(metrics.menuBackdrop, /blur\(24px\)/, `${scenario.name}: context menu should retain readable frosted depth`);
    assert.ok(metrics.menuButtonHeights.every((height) => height >= 34), `${scenario.name}: context menu rows must remain compact touch-friendly`);
    assert.ok(metrics.menuButtonWidths.every((width) => width >= 140), `${scenario.name}: context menu rows need a readable label measure`);
    assert.ok(metrics.metaButtonHeights.every((height) => height >= 30), `${scenario.name}: assistant action buttons should be compact and borderless`);
    assert.ok(metrics.metaButtonWidths.every((width) => width >= 30), `${scenario.name}: assistant action buttons should be compact and borderless`);
    await page.close();
  }
} finally {
  await browser.close();
  if (!requestedOutputDir) rmSync(outputDir, { recursive: true, force: true });
}

console.log(`ok — message action portal/touch-target visual fixtures (${scenarios.length} states)`);
if (requestedOutputDir) console.log(`output: ${outputDir}`);
