#!/usr/bin/env node
// Desktop regression for the message-action hover bridge. The action row is
// visually below the message, but the pointer must be able to travel through
// its breathing room without the row disappearing.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = '/tmp/ragent-message-actions-hover-visual';
mkdirSync(outputDir, { recursive: true });
const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-m3-components.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>${styles}
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body { background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .fixture { width: 720px; margin: 140px auto; }
  .msg-assistant { white-space: normal; }
  .msg-assistant-body { max-width: 620px; }
</style></head>
<body><main class="fixture">
  <div class="msg-assistant" id="assistant">
    <div class="msg-assistant-body" id="messageBody">这是一条桌面端回复，用来验证鼠标可以从正文连续移动到操作按钮。</div>
    <div class="msg-meta" id="messageMeta">
      <div class="msg-actions"><button class="msg-action-btn" id="copyAction" type="button" aria-label="Copy">Copy</button><button class="msg-action-btn" type="button" aria-label="Fork">Fork</button></div>
    </div>
  </div>
</main><script>document.getElementById('copyAction').addEventListener('click', () => { document.body.dataset.clicked = 'true'; });</script></body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  const initial = await page.evaluate(() => {
    const meta = document.getElementById('messageMeta');
    const body = document.getElementById('messageBody');
    const assistant = document.getElementById('assistant');
    return {
      opacity: getComputedStyle(meta).opacity,
      visibility: getComputedStyle(meta).visibility,
      assistantBottom: assistant.getBoundingClientRect().bottom,
      metaTop: meta.getBoundingClientRect().top,
    };
  });
  assert.equal(initial.opacity, '0', 'desktop message actions should start hidden');
  assert.equal(initial.visibility, 'hidden', 'desktop message actions should start inaccessible until hover');
  // The initial hidden state is translated upward by 3px; compensate for
  // that entrance transform when checking the untransformed hit-area origin.
  assert.ok(Math.abs((initial.metaTop + 3) - initial.assistantBottom) <= 1, 'metadata hit area should begin at the message edge');

  const bodyRect = await page.locator('#messageBody').boundingBox();
  assert.ok(bodyRect, 'message body should have a measurable desktop hit area');
  await page.mouse.move(bodyRect.x + 40, bodyRect.y + bodyRect.height - 1);
  await page.waitForTimeout(190);

  const visible = await page.evaluate(() => {
    const meta = document.getElementById('messageMeta');
    const button = document.getElementById('copyAction');
    const metaRect = meta.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      opacity: getComputedStyle(meta).opacity,
      visibility: getComputedStyle(meta).visibility,
      pointerEvents: getComputedStyle(meta).pointerEvents,
      bridgeY: metaRect.top + 2,
      buttonX: buttonRect.left + buttonRect.width / 2,
      buttonY: buttonRect.top + buttonRect.height / 2,
    };
  });
  assert.equal(visible.opacity, '1', 'message actions should reveal on desktop hover');
  assert.equal(visible.visibility, 'visible', 'revealed actions should be visible before pointer travel');
  assert.equal(visible.pointerEvents, 'auto', 'revealed actions should accept pointer input');

  // Move through the internal 4px breathing room first. This is the exact
  // transition that used to leave the message and hide the buttons.
  await page.mouse.move(visible.buttonX, visible.bridgeY);
  await page.waitForTimeout(40);
  assert.equal(await page.locator('#messageMeta').evaluate((node) => getComputedStyle(node).opacity), '1', 'metadata must stay visible across its hover bridge');
  await page.mouse.move(visible.buttonX, visible.buttonY);
  await page.mouse.click(visible.buttonX, visible.buttonY);
  assert.equal(await page.locator('body').getAttribute('data-clicked'), 'true', 'desktop action must remain clickable after leaving the message body');
  await page.screenshot({ path: join(outputDir, 'desktop-hover-bridge.png') });
  await page.close();
} finally {
  await browser.close();
}

console.log(`message action hover bridge visual: ok (${outputDir})`);
