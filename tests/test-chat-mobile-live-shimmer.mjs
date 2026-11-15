#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requestedOutputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || '').trim();
const outputDir = requestedOutputDir || join(tmpdir(), `ragent-mobile-live-shimmer-${Date.now()}`);
mkdirSync(outputDir, { recursive: true });
const messagesCss = [
  'static/chat/chat-base.css',
  'static/chat/chat-messages.css',
].map((relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8')).join('\n');

const fixture = `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  ${messagesCss}
  * { box-sizing: border-box; }
  body { margin: 0; width: 390px; background: var(--bg); color: var(--text); }
</style>
<div class="mobile-live-activity-line" aria-live="polite">
  <span class="mobile-live-activity-line__dots" aria-hidden="true">
    <span class="mobile-live-activity-line__dot"></span>
    <span class="mobile-live-activity-line__dot"></span>
    <span class="mobile-live-activity-line__dot"></span>
  </span>
  <span class="mobile-live-activity-line__label">正在执行命令</span>
</div>`;

const browser = await chromium.launch({ headless: true });
try {
  for (const reducedMotion of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 240 },
      colorScheme: reducedMotion ? 'light' : 'dark',
      reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    });
    await page.setContent(fixture, { waitUntil: 'load' });
    const before = await page.locator('.mobile-live-activity-line__label').evaluate((label) => {
      const style = getComputedStyle(label, '::after');
      const dots = label.parentElement.querySelector('.mobile-live-activity-line__dots');
      const dot = label.parentElement.querySelector('.mobile-live-activity-line__dot');
      return {
        lineColor: getComputedStyle(label.parentElement).color,
        labelColor: getComputedStyle(label).color,
        labelWidth: getComputedStyle(label).width,
        shimmerAnimationName: style.animationName,
        shimmerContent: style.content,
        dotsAnimationName: getComputedStyle(dots).animationName,
        dotAnimationName: getComputedStyle(dot).animationName,
        dotTransform: getComputedStyle(dot).transform,
      };
    });
    await page.waitForTimeout(140);
    const afterTransform = await page.locator('.mobile-live-activity-line__dot').first().evaluate((dot) => getComputedStyle(dot).transform);

    if (reducedMotion) {
      assert.equal(before.dotsAnimationName, 'none', 'reduced motion should disable the dot-group animation');
      assert.equal(before.dotAnimationName, 'none', 'reduced motion should disable each dot animation');
      assert.equal(before.shimmerAnimationName, 'none', 'reduced motion should keep text still');
      assert.equal(before.shimmerContent, 'none', 'reduced motion should have no decorative text layer');
    } else {
      assert.notEqual(before.lineColor, 'rgb(0, 0, 0)', 'dark activity line should use the theme text color');
      assert.notEqual(before.labelColor, 'rgb(0, 0, 0)', 'dark activity label should remain readable');
      assert.equal(before.shimmerAnimationName, 'none', 'active mobile activity should keep text still');
      assert.equal(before.shimmerContent, 'none', 'active mobile activity should have no decorative text layer');
      assert.equal(before.dotsAnimationName, 'mobile-live-dots-rotate', 'active mobile activity should rotate the dot group');
      assert.equal(before.dotAnimationName, 'mobile-live-dot-sequence-a', 'active mobile activity should stage the first dot');
      assert.notEqual(afterTransform, before.dotTransform, 'the first dot should move along its staged path');
    }

    if (!reducedMotion) {
      await page.locator('.mobile-live-activity-line__dots').evaluate((dots) => {
        dots.style.animationDelay = '-0.4s';
      });
      await page.waitForTimeout(700);
    }
    await page.screenshot({ path: join(outputDir, reducedMotion ? 'mobile-reduced.png' : 'mobile-active.png'), fullPage: true });
    await page.close();
  }
  console.log(`test-chat-mobile-live-shimmer: ok (${outputDir})`);
} finally {
  await browser.close();
  if (!requestedOutputDir) rmSync(outputDir, { recursive: true, force: true });
}
