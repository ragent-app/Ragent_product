#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-responsive.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
const icons = readFileSync(join(repoRoot, 'static/chat/icons.js'), 'utf8');
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR || '';
if (outputDir) mkdirSync(outputDir, { recursive: true });

const fixture = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${styles}</style></head>
<body><div class="app-shell"><div class="header">
  <button class="header-btn header-btn--sessions" id="menuBtn" type="button" aria-label="Sessions"><span class="header-btn-icon" data-icon="menu"></span></button>
  <button class="header-btn header-btn--home" id="homeBtn" type="button" aria-label="Home"><span class="header-btn-icon" data-icon="home"></span></button>
  <div class="header-title-block"><h1>Ragent Chat</h1></div>
</div></div><script>${icons}\nwindow.RagentIcons.hydrate(document);</script></body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of [
    { width: 360, theme: 'light' },
    { width: 390, theme: 'light' },
    { width: 430, theme: 'light' },
    { width: 390, theme: 'dark' },
    { width: 1024, theme: 'light' },
  ]) {
    const { width } = scenario;
    const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme: scenario.theme });
    await page.setContent(fixture, { waitUntil: 'load' });
    const metrics = await page.evaluate(() => {
      const read = (selector) => {
        const node = document.querySelector(selector);
        const rect = node?.getBoundingClientRect();
        const style = node ? getComputedStyle(node) : null;
        return {
          display: style?.display || '',
          width: rect?.width || 0,
          height: rect?.height || 0,
          left: rect?.left || 0,
          right: rect?.right || 0,
          ariaLabel: node?.getAttribute('aria-label') || '',
          hasIcon: Boolean(node?.querySelector('svg')),
        };
      };
      return {
        width: window.innerWidth,
        menu: read('#menuBtn'),
        home: read('#homeBtn'),
        title: read('.header-title-block'),
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    if (outputDir) {
      const suffix = scenario.theme === 'dark' ? '-dark' : '';
      await page.screenshot({ path: join(outputDir, `header-${width}${suffix}.png`), fullPage: true });
    }
    if (width < 768) {
      assert.notEqual(metrics.home.display, 'none', `${width}px: home button should be visible on mobile`);
      assert.equal(metrics.home.width, 40, `${width}px: home button should be 40px wide`);
      assert.equal(metrics.home.height, 40, `${width}px: home button should be 40px tall`);
      assert.equal(metrics.home.ariaLabel, 'Home', `${width}px: home button should have an accessible name`);
      assert.equal(metrics.home.hasIcon, true, `${width}px: home button should render the shared icon`);
      assert.ok(metrics.home.right <= metrics.title.left, `${width}px: home button should not overlap the title`);
      assert.ok(metrics.scrollWidth <= width, `${width}px: header should not create horizontal overflow`);
    } else {
      assert.equal(metrics.home.display, 'none', `${width}px: home button should stay mobile-first on desktop`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

console.log('test-chat-mobile-home-navigation-visual: ok');
