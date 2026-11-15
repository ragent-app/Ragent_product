#!/usr/bin/env node
// Theme surface fixture: verifies the shipped token chain, not an isolated
// palette snippet. Light presets share a pure-white canvas and faint neutral
// containers; each preset keeps its Material seed action color; user bubbles
// stay quiet across every light/dark preset without changing geometry.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const repoRoot = new URL('..', import.meta.url).pathname;
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || mkdtempSync(join(tmpdir(), 'ragent-theme-surfaces-visual-'));
if (requestedOutputDir) mkdirSync(outputDir, { recursive: true });

const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-m3-components.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

const lightThemes = ['light', 'blue', 'amber', 'purple', 'green', 'rose', 'teal', 'monet'];
const darkThemes = ['dark', 'blue', 'purple', 'green', 'rose', 'teal', 'monet'];
const scenarios = [
  ...lightThemes.map((theme) => ({ theme, colorScheme: 'light' })),
  ...darkThemes.map((theme) => ({ theme, colorScheme: 'dark' })),
];

function fixtureHtml() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style>
<style>
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body { margin: 0; padding: 32px; background: var(--sys-surface); color: var(--sys-on-surface); font-family: var(--font-ui); }
  .theme-demo { max-width: 720px; margin: 0 auto; padding: 24px; border-radius: 24px; background: var(--sys-surface-container); }
  .demo-action { min-height: 52px; padding: 0 22px; border: 0; border-radius: 999px; background: var(--color-action); color: var(--color-action-on); font-weight: 700; }
  .copy-state { position: relative; height: 44px; margin: 12px 0; }
  .copy-state .code-copy-btn { animation: none; }
</style></head>
<body>
  <main class="theme-demo">
    <div class="msg-assistant"><div class="msg-assistant-body">助手消息保持纯文本，不改变排版。</div></div>
    <div class="msg-user"><div class="msg-user-bubble"><span>用户消息气泡应该是安静的中性材质。</span></div></div>
    <div class="copy-state"><button class="code-copy-btn copied" type="button" aria-label="已复制"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg></button></div>
    <button class="demo-action" type="button">开始工作</button>
  </main>
</body>
</html>`;
}

const browser = await chromium.launch();
try {
  for (const scenario of scenarios) {
    const page = await browser.newPage({
      viewport: { width: 720, height: 520 },
      colorScheme: scenario.colorScheme,
    });
    await page.setContent(fixtureHtml(), { waitUntil: 'load' });
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, scenario.theme);
    await page.waitForTimeout(40);
    await page.screenshot({ path: join(outputDir, `${scenario.colorScheme}-${scenario.theme}.png`) });

    const metrics = await page.evaluate(() => {
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      const root = getComputedStyle(document.documentElement);
      return {
        canvas: style('body').backgroundColor,
        container: style('.theme-demo').backgroundColor,
        bubble: style('.msg-user-bubble').backgroundColor,
        bubbleText: style('.msg-user-bubble').color,
        copied: style('.code-copy-btn').backgroundColor,
        copiedText: style('.code-copy-btn').color,
        action: style('.demo-action').backgroundColor,
        actionText: style('.demo-action').color,
        primaryContainer: root.getPropertyValue('--m3-primary-container').trim(),
      };
    });

    if (scenario.colorScheme === 'light') {
      assert.equal(metrics.canvas, 'rgb(255, 255, 255)', `${scenario.theme}: light canvas should be pure white`);
      assert.equal(metrics.container, 'rgb(245, 246, 248)', `${scenario.theme}: light container should stay faint and neutral`);
      assert.equal(metrics.bubble, 'rgb(229, 232, 237)', `${scenario.theme}: light message bubble should use the quieter neutral fill`);
      assert.equal(metrics.bubbleText, 'rgb(31, 35, 42)', `${scenario.theme}: light message bubble text should stay readable`);
      assert.notEqual(metrics.bubble, metrics.primaryContainer, `${scenario.theme}: message bubble must not reuse bright primary-container`);
      assert.equal(metrics.copied, 'rgb(201, 225, 205)', `${scenario.theme}: copied feedback should use the quiet MD3 success container`);
      assert.equal(metrics.copiedText, 'rgb(20, 54, 26)', `${scenario.theme}: copied feedback should use the MD3 on-success-container role`);
    } else {
      assert.notEqual(metrics.canvas, 'rgba(0, 0, 0, 0)', `${scenario.theme}: dark canvas should be painted`);
      assert.equal(metrics.bubble, 'rgb(43, 46, 53)', `${scenario.theme}: dark message bubble should use the quieter neutral fill`);
      assert.equal(metrics.bubbleText, 'rgb(238, 241, 245)', `${scenario.theme}: dark message bubble text should stay readable`);
      assert.equal(metrics.copied, 'rgb(27, 65, 37)', `${scenario.theme}: dark copied feedback should use the dark MD3 success container`);
      assert.equal(metrics.copiedText, 'rgb(200, 233, 203)', `${scenario.theme}: dark copied feedback should use the dark MD3 on-success-container role`);
    }

    if (scenario.colorScheme === 'light') {
      const expectedActions = {
        light: 'rgb(0, 0, 0)',
        blue: 'rgb(63, 95, 144)',
        amber: 'rgb(79, 102, 47)',
        purple: 'rgb(103, 80, 164)',
        monet: 'rgb(103, 80, 164)',
        green: 'rgb(56, 106, 32)',
        rose: 'rgb(142, 73, 93)',
        teal: 'rgb(0, 106, 106)',
      };
      assert.equal(metrics.action, expectedActions[scenario.theme], `${scenario.theme}: light primary action should use its Material seed color`);
      assert.equal(metrics.actionText, 'rgb(255, 255, 255)', `${scenario.theme}: light primary action text should be white`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`test-chat-theme-surfaces-visual: ok (${outputDir})`);
