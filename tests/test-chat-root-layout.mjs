#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const cssFiles = [
  'chat-base.css',
  'chat-sidebar.css',
  'chat-messages.css',
  'chat-workbench.css',
  'right-sidebar.css',
  'workspace-file-reader.css',
  'chat-input.css',
  'chat-run-sheet.css',
  'chat-responsive.css',
  'custom-select.css',
  'chat-glass.css',
];

const css = (await Promise.all(
  cssFiles.map((file) => readFile(join(repoRoot, 'static', 'chat', file), 'utf8')),
)).join('\n\n');

function rootMarkup() {
  return `<!doctype html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <style>${css}</style>
      </head>
      <body class="workbench-inspector-collapsed">
        <div class="app-shell">
          <div class="header">
            <button class="header-btn header-btn--sessions" type="button"></button>
            <div class="header-title-block"><h1>Ragent Chat</h1></div>
            <button class="header-more-btn" type="button"></button>
          </div>
          <div class="app-container">
            <div class="sidebar-overlay"><aside class="sidebar"></aside></div>
            <main class="chat-area">
              <div class="messages" id="messages">
                <div class="messages-inner" id="messagesInner">
                  <div class="msg msg-assistant">A short assistant message.</div>
                </div>
              </div>
              <div class="input-area" id="inputArea">
                <div class="input-stack">
                  <div id="liveBarSlot" class="live-bar-slot"></div>
                  <div class="queued-panel" id="queuedPanel"></div>
                  <div class="input-wrapper">
                    <div class="input-row"><textarea id="msgInput"></textarea></div>
                    <div class="input-actions-row">
                      <button class="composer-action-btn" type="button"></button>
                      <button class="send-btn" type="button"></button>
                    </div>
                  </div>
                </div>
              </div>
            </main>
          </div>
        </div>
      </body>
    </html>`;
}

const browser = await chromium.launch({ headless: true });

try {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    await page.setContent(rootMarkup());
    const metrics = await page.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        const bounds = node.getBoundingClientRect();
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          height: bounds.height,
        };
      };
      return {
        shell: rect('.app-shell'),
        container: rect('.app-container'),
        chat: rect('.chat-area'),
        input: rect('#inputArea'),
      };
    });

    for (const [name, rect] of Object.entries({
      shell: metrics.shell,
      container: metrics.container,
      chat: metrics.chat,
    })) {
      assert.ok(
        Math.abs(rect.height - viewport.height) <= 1,
        `${name} should fill the ${viewport.width}x${viewport.height} viewport; got ${rect.height}`,
      );
    }

    assert.ok(
      Math.abs(metrics.input.bottom - viewport.height) <= 1,
      `composer should sit at the bottom of the ${viewport.width}x${viewport.height} viewport; got ${metrics.input.bottom}`,
    );

    await page.close();
  }

  console.log('test-chat-root-layout: ok');
} finally {
  await browser.close();
}
