#!/usr/bin/env node
// Browser-level contract for user-message rendering. This uses the real DOM
// implementation so a duplicate canonical delivery cannot be hidden by a
// lightweight test-double querySelector implementation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const uiSource = readFileSync(new URL('../static/chat/ui.js', import.meta.url), 'utf8');
const markedSource = readFileSync(new URL('../static/marked.min.js', import.meta.url), 'utf8');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><div id="messages"></div></body></html>');
  await page.addScriptTag({ content: markedSource });
  await page.addScriptTag({
    content: `
      window.t = () => '';
      window.visitorMode = false;
      window.currentSessionId = 'session-a';
      window.messagesInner = document.getElementById('messages');
      window.emptyState = document.createElement('div');
      window.messagesInner.appendChild(window.emptyState);
      window.messagesEl = {};
      window.renderedEventState = {};
      window.sessionStateModel = {};
      window.RagentSessionStateModel = {};
      window.formatDecodedDisplayText = (value) => String(value ?? '');
      window.createMessageAttachmentNode = () => null;
      window.enhanceCodeBlocks = () => {};
      window.enhanceTables = () => {};
      window.enhanceRenderedContentLinks = () => {};
    `,
  });
  await page.addScriptTag({ content: uiSource });

  const result = await page.evaluate(() => {
    const localEchoInserted = insertComposerLocalEcho({
      requestId: 'request-1',
      text: '**same message** ~~old~~ [docs](https://example.com) `healthz`',
      sessionId: 'session-a',
      scroll: false,
    });
    const committed = renderMessageInto(messagesInner, {
      type: 'message',
      role: 'user',
      requestId: 'request-1',
      content: '**same message** ~~old~~ [docs](https://example.com) `healthz`',
    });
    const duplicate = renderMessageInto(messagesInner, {
      type: 'message',
      role: 'user',
      requestId: 'request-1',
      content: '**same message** ~~old~~ [docs](https://example.com) `healthz`',
    });

    window.currentSessionId = 'session-b';
    const sameRequestIdInOtherSession = renderMessageInto(messagesInner, {
      type: 'message',
      role: 'user',
      requestId: 'request-1',
      content: 'other session',
    });

    const nodes = [...messagesInner.querySelectorAll('.msg-user')];
    return {
      localEchoInserted,
      duplicateReusedNode: duplicate === committed,
      count: nodes.length,
      classes: nodes.map((node) => node.className),
      sessionIds: nodes.map((node) => node.dataset.sessionId),
      text: nodes.map((node) => node.textContent),
      formatting: {
        strong: committed.querySelectorAll('.msg-user-bubble strong').length,
        strike: committed.querySelectorAll('.msg-user-bubble del, .msg-user-bubble s').length,
        link: committed.querySelectorAll('.msg-user-bubble a[href="https://example.com"]').length,
        code: committed.querySelectorAll('.msg-user-bubble code').length,
        rawMarkdown: committed.innerHTML.includes('**same message**'),
      },
    };
  });

  assert.equal(result.localEchoInserted, true);
  assert.equal(result.duplicateReusedNode, true,
    'duplicate canonical delivery should reuse the existing committed node');
  assert.equal(result.count, 2,
    'one committed node per session should remain after replay and cross-session delivery');
  assert.deepEqual(result.sessionIds, ['session-a', 'session-b']);
  assert.equal(result.classes[0].includes('msg-user-local-echo'), false,
    'the canonical node should replace the optimistic local echo');
  assert.deepEqual(result.text, ['same message old docs healthz\n', 'other session\n']);
  assert.deepEqual(result.formatting, {
    strong: 1,
    strike: 1,
    link: 1,
    code: 1,
    rawMarkdown: false,
  }, 'user bubbles must use the shared marked renderer instead of plain text');

  console.log('test-chat-user-message-dedup-dom: ok');
} finally {
  await browser.close();
}
