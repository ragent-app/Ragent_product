#!/usr/bin/env node
// Standalone pages share the L1/L2 borderless surface and interaction
// contract. Keep this small browser check close to the page-level stylesheet.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const css = await readFile(join(repoRoot, 'static/m3-pages.css'), 'utf8');
const markup = `<!doctype html><html><head><style>${css}</style></head><body>
  <main class="shell">
    <section class="card"><h1>Ragent</h1><button class="btn">Continue</button></section>
    <section class="panel page-panel"><label>Search<input class="search-field" /></label><button class="btn-subtle">Filter</button></section>
  </main>
</body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: theme });
    await page.setContent(markup, { waitUntil: 'load' });
    const metrics = await page.evaluate(() => {
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      return {
        shell: style('.shell'),
        card: style('.card'),
        panel: style('.page-panel'),
        button: style('.btn'),
        subtle: style('.btn-subtle'),
        input: style('.search-field'),
      };
    });
    assert.equal(metrics.shell.borderWidth, '0px', `${theme}: shell should not draw an outline`);
    assert.equal(metrics.shell.boxShadow, 'none', `${theme}: shell should stay flat`);
    assert.equal(metrics.card.borderWidth, '0px', `${theme}: card should not draw an outline`);
    assert.equal(metrics.panel.borderWidth, '0px', `${theme}: page panel should not draw an outline`);
    assert.equal(metrics.button.borderWidth, '0px', `${theme}: primary button should stay borderless`);
    assert.equal(metrics.subtle.borderWidth, '0px', `${theme}: secondary button should stay borderless`);
    assert.equal(metrics.input.borderWidth, '0px', `${theme}: filled input should not draw an outer frame`);
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const node = document.activeElement;
      const computed = getComputedStyle(node);
      return { tag: node?.tagName, outlineStyle: computed.outlineStyle, outlineWidth: computed.outlineWidth };
    });
    assert.equal(focused.tag, 'BUTTON', `${theme}: keyboard focus should land on the first action`);
    assert.notEqual(focused.outlineStyle, 'none', `${theme}: focus ring should remain visible`);
    assert.notEqual(focused.outlineWidth, '0px', `${theme}: focus ring should retain a measurable width`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log('test-md3-pages-reference-alignment: ok');
