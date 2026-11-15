#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const css = await Promise.all([
  'static/chat/chat-base.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-input.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
].map((path) => readFile(join(repoRoot, path), 'utf8')));

const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR
  || '/var/lib/ragent/workspace/visual-ui-reviews/2026-08-08T-delivery-image-preview';
await mkdir(outputDir, { recursive: true });

const imageA = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#5b7cfa"/><stop offset="1" stop-color="#b56df2"/></linearGradient></defs><rect width="360" height="240" fill="url(#g)"/><circle cx="270" cy="70" r="48" fill="#fff" fill-opacity=".28"/></svg>').toString('base64')}`;
const imageB = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240"><rect width="360" height="240" fill="#f39b6d"/><path d="M0 180 90 90l72 58 54-72 144 104v60H0z" fill="#fff" fill-opacity=".3"/></svg>').toString('base64')}`;
const portraitImage = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 360"><rect width="180" height="360" fill="#4c67a9"/><circle cx="90" cy="112" r="48" fill="#fff" fill-opacity=".42"/><path d="M22 312 78 210l42 34 38-66v134H22z" fill="#fff" fill-opacity=".24"/></svg>').toString('base64')}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>${css.join('\n')}</style></head><body>
    <main class="messages" style="padding:24px 16px">
      <div class="msg-assistant md-content msg-delivery">
        <section class="delivery-card artifact-group">
          <div class="delivery-card-files artifact-group-list"><div class="attachment-card artifact-row"><div class="attachment-file"><div class="attachment-file-icon"></div><div class="attachment-file-meta"><div class="attachment-file-name">summary.csv</div><div class="attachment-file-type">CSV · 2 KB</div></div></div><a class="attachment-download-btn attachment-download-btn--icon" aria-label="Download summary.csv">↓</a></div></div>
          <div class="delivery-card-images" aria-label="Image attachments">
            <div class="delivery-image-preview"><img src="${imageA}" alt="shot-a.png"><a class="attachment-download-btn attachment-download-btn--icon delivery-image-download" aria-label="Download shot-a.png">↓</a></div>
            <div class="delivery-image-preview"><img src="${imageB}" alt="shot-b.png"><a class="attachment-download-btn attachment-download-btn--icon delivery-image-download" aria-label="Download shot-b.png">↓</a></div>
            <div class="delivery-image-preview"><img src="${portraitImage}" alt="portrait.png"><a class="attachment-download-btn attachment-download-btn--icon delivery-image-download" aria-label="Download portrait.png">↓</a></div>
          </div>
        </section>
      </div>
    </main>
    <div class="message-image-viewer" role="dialog" aria-modal="true">
      <div class="message-image-viewer__toolbar"><a class="composer-action-btn message-image-viewer__action" aria-label="Download">↓</a><button class="composer-action-btn message-image-viewer__action" aria-label="Close">×</button></div>
      <div class="message-image-viewer__stage"><img class="message-image-viewer__image" src="${imageA}" alt="shot-a.png"></div>
    </div>
  </body></html>`);
  const metrics = await page.evaluate(() => {
    const gallery = document.querySelector('.delivery-card-images');
    const viewer = document.querySelector('.message-image-viewer');
    return {
      galleryHeight: getComputedStyle(gallery).height,
      galleryDirection: getComputedStyle(gallery).flexDirection,
      thumbCount: gallery.children.length,
      thumbObjectFit: getComputedStyle(gallery.querySelector('img')).objectFit,
      thumbObjectPosition: getComputedStyle(gallery.querySelector('img')).objectPosition,
      thumbHeight: getComputedStyle(gallery.querySelector('img')).height,
      thumbButtonRadius: getComputedStyle(gallery.querySelector('.delivery-image-download')).borderTopLeftRadius,
      viewerBackground: getComputedStyle(viewer).backgroundColor,
      viewerActionBackground: getComputedStyle(viewer.querySelector('.message-image-viewer__action')).backgroundColor,
      viewerActionDisplay: getComputedStyle(viewer.querySelector('.message-image-viewer__action')).display,
      viewerButtonCount: viewer.querySelectorAll('.message-image-viewer__action').length,
    };
  });
  assert.equal(metrics.galleryHeight, '104px');
  assert.equal(metrics.thumbCount, 3);
  assert.equal(metrics.thumbObjectFit, 'contain');
  assert.equal(metrics.thumbObjectPosition, '50% 50%');
  assert.equal(metrics.thumbHeight, '104px');
  assert.equal(metrics.thumbButtonRadius, '50%');
  assert.equal(metrics.viewerButtonCount, 2);
  assert.match(metrics.viewerBackground, /rgba?\(/);
  assert.notEqual(metrics.viewerActionBackground, 'rgba(0, 0, 0, 0)');
  await page.locator('.message-image-viewer').evaluate((node) => { node.style.display = 'none'; });
  await page.screenshot({ path: join(outputDir, 'delivery-image-gallery.png'), fullPage: true });
  await page.locator('.message-image-viewer').evaluate((node) => { node.style.display = 'flex'; });
  await page.screenshot({ path: join(outputDir, 'delivery-image-viewer.png'), fullPage: true });
  console.log(`test-chat-delivery-image-visual: ok (${outputDir})`);
} finally {
  await browser.close();
}
