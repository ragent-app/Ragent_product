#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR?.trim();
if (outputDir) await mkdir(outputDir, { recursive: true });

const styles = await Promise.all([
  'static/chat/chat-base.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-workbench.css',
  'static/chat/chat-run-sheet.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
].map((path) => readFile(join(repoRoot, path), 'utf8')));

const row = (name, meta, action = 'download') => `
  <div class="attachment-card attachment-card-row artifact-row delivery-card-file">
    <div class="attachment-file">
      <span class="attachment-file-icon">▧</span>
      <span class="attachment-file-meta">
        <span class="attachment-file-name">${name}</span>
        <span class="attachment-file-type">${meta}</span>
      </span>
    </div>
    <a class="attachment-download-btn attachment-download-btn--icon artifact-action" href="#" aria-label="${action}">${action === 'download' ? '↓' : '↗'}</a>
  </div>`;

function fixtureHtml(dark = false) {
  return `<!doctype html><html class="${dark ? 'dark' : ''}"><head><style>${styles.join('\n')}</style>
  <style>
    html, body { margin: 0; min-height: 100%; }
    body { padding: 18px; background: var(--chat-area-bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
    .fixture { display: grid; gap: 18px; max-width: 680px; margin: 0 auto; }
    .fixture h2 { margin: 0; font-size: 14px; }
    .fixture-section { min-width: 0; padding: 14px; border-radius: 18px; background: var(--surface-raised); }
    .fixture-label { margin-bottom: 8px; color: var(--text-muted); font-size: 11px; font-weight: 700; }
    .fixture .msg-delivery { max-width: none; }
    .fixture .attachment-card { max-width: none; }
    .fixture .attachment-file-icon { color: var(--notice); }
    .fixture .workbench-artifact-list { max-width: none; }
    .fixture .tool-card { margin: 0; }
  </style></head><body>
    <main class="fixture">
      <h2>Artifact surfaces</h2>
      <section class="fixture-section">
        <div class="fixture-label">Generated files</div>
        <div class="msg-delivery">
          <section class="delivery-card artifact-group" aria-label="Generated files">
            <div class="delivery-card-files artifact-group-list">
              ${row('quarterly-report-with-a-very-long-filename.csv', 'CSV · 2 KB')}
              ${row('summary.pdf', 'PDF · 48 KB', 'open')}
            </div>
          </section>
        </div>
      </section>
      <section class="fixture-section workbench-outcome-card">
        <div class="fixture-label">Workbench artifacts</div>
        <div class="workbench-outcome-metrics">
          <div class="workbench-outcome-metric"><strong>2</strong><span>outputs</span></div>
          <div class="workbench-outcome-metric"><strong>2</strong><span>files</span></div>
        </div>
        <div class="workbench-artifact-list">
          <a class="workbench-artifact-item workbench-artifact-item--markdown" href="#"><div class="workbench-artifact-title-row"><span>report.md</span><span class="workbench-artifact-badge">MD</span></div><div class="workbench-artifact-meta">Markdown · 6 KB</div></a>
          <a class="workbench-artifact-item" href="#"><div class="workbench-artifact-title-row"><span>summary.pdf</span><span class="workbench-artifact-badge">PDF</span></div><div class="workbench-artifact-meta">PDF · 48 KB</div></a>
        </div>
      </section>
      <section class="fixture-section">
        <div class="fixture-label">Tool changes</div>
        <div class="tool-card">
          <div class="file-card"><span class="change-type edit">EDIT</span><span class="file-path">src/components/a-very-long-file-name.mjs</span></div>
          <div class="diff-card"><div class="diff-header"><span>src/components/a-very-long-file-name.mjs</span></div><pre class="diff-body">+ const result = await run();</pre></div>
        </div>
      </section>
    </main>
  </body></html>`;
}

const browser = await chromium.launch({ headless: true });
try {
  for (const dark of [false, true]) {
    for (const width of [320, 360, 390, 430]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: dark ? 'dark' : 'light' });
      await page.setContent(fixtureHtml(dark), { waitUntil: 'load' });
      const metrics = await page.evaluate(() => {
        const read = (selector) => {
          const node = document.querySelector(selector);
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return {
            width: rect.width,
            right: rect.right,
            radius: style.borderTopLeftRadius,
            shadow: style.boxShadow,
            overflow: node.scrollWidth > node.clientWidth,
          };
        };
        return {
          group: read('.delivery-card-files'),
          fileRow: read('.delivery-card-file'),
          download: read('.attachment-download-btn'),
          workbenchRow: read('.workbench-artifact-item'),
          toolFile: read('.file-card'),
          diff: read('.diff-card'),
          bodyWidth: document.body.scrollWidth,
        };
      });
      assert.equal(metrics.bodyWidth, width, `${dark ? 'dark' : 'light'} ${width}px fixture should not overflow horizontally`);
      assert.notEqual(metrics.group.radius, '0px', 'multiple attachments should have one visible group surface');
      assert.equal(metrics.fileRow.radius, '0px', 'attachment rows should not add a nested rounded card');
      assert.equal(metrics.fileRow.shadow, 'none', 'attachment rows should not add a nested shadow');
      assert.equal(metrics.workbenchRow.shadow, 'none', 'Workbench artifact rows should not add a nested shadow');
      assert.equal(metrics.toolFile.shadow, 'none', 'tool file rows should not add a nested shadow');
      assert.equal(metrics.diff.shadow, 'none', 'diff rows should not add a nested shadow');
      assert.ok(metrics.download.width >= 44, 'attachment actions should retain a 44px touch target');
      assert.equal(metrics.fileRow.overflow, false, 'long attachment names should stay inside the row');
      assert.equal(metrics.workbenchRow.overflow, false, 'long artifact names should stay inside the row');
      if (outputDir) await page.screenshot({ path: join(outputDir, `${dark ? 'dark' : 'light'}-${width}.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log(`test-chat-artifact-surfaces-visual: ok${outputDir ? ` (${outputDir})` : ''}`);
