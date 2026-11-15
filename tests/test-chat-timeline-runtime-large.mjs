#!/usr/bin/env node

// Large-session acceptance for the DOM window and renderer isolation. This is
// intentionally a browser test: a pure projector test cannot catch a DOM
// explosion or an exception that aborts the visible transcript.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

try {
  await page.setContent('<!doctype html><div id="messagesInner"></div>');
  await page.evaluate(() => {
    window.currentSessionId = 'timeline-large';
    window.messagesInner = document.getElementById('messagesInner');
    window.emptyState = document.createElement('div');
    window.renderedEventState = {
      sessionId: 'timeline-large', latestSeq: 0, earliestSeq: 0,
      nextBeforeSeq: null, hasMoreBefore: false, loadingOlder: false,
      runState: 'idle', timelineItemCount: 0,
    };
    window.normalizeRenderedRunState = (state) => state;
    window.syncLiveMessageMetadataForRunState = () => {};
    window.syncEditableMessageActions = () => {};
    window.reconcileComposerPendingSendWithEvent = () => {};
    window.renderMessageInto = (container, event) => {
      const node = document.createElement('article');
      node.className = 'assistant-message';
      node.textContent = event.content || '';
      container.appendChild(node);
      return node;
    };
  });
  await page.addScriptTag({ content: readFileSync(join(repoRoot, 'static/chat/core/timeline-projector.js'), 'utf8') });
  await page.addScriptTag({ content: readFileSync(join(repoRoot, 'static/chat/timeline-runtime.js'), 'utf8') });

  const result = await page.evaluate(() => {
    const events = Array.from({ length: 1200 }, (_, index) => ({
      id: `event-${index + 1}`,
      seq: index + 1,
      type: 'message',
      role: 'assistant',
      content: `message ${index + 1}`,
    }));
    window.RagentTimelineRuntime.renderBatch(events, {
      sessionId: 'timeline-large',
      runState: 'idle',
      latestSeq: 1200,
    });
    const metrics = window.ragentGetTimelineRuntimeMetrics();
    return {
      domCount: messagesInner.children.length,
      firstText: messagesInner.firstElementChild?.textContent || '',
      lastText: messagesInner.lastElementChild?.textContent || '',
      snapshotCount: window.RagentTimelineRuntime.getSnapshot()?.items?.length || 0,
      metrics,
    };
  });

  assert.ok(result.domCount <= result.metrics.maxRenderedItems, `DOM window must stay bounded (${result.domCount})`);
  assert.equal(result.lastText, 'message 1200', 'window must keep the newest durable output visible');
  assert.equal(result.snapshotCount, 1200, 'projector keeps the complete durable model for pagination');
  assert.equal(result.metrics.projectorItemsMax, 1200);
  assert.ok(result.metrics.visibleItemsMax <= result.metrics.maxRenderedItems);
  assert.equal(result.metrics.renderErrors, 0, 'large-session render must not report errors');

  const isolated = await page.evaluate(() => {
    window.renderMessageInto = () => { throw new Error('synthetic malformed renderer frame'); };
    window.RagentTimelineRuntime.renderIncremental([{
      id: 'bad-frame', type: 'message', role: 'assistant', content: 'bad',
    }], { sessionId: 'timeline-large', runState: 'running', source: 'ws' });
    return window.ragentGetTimelineRuntimeMetrics();
  });
  assert.equal(isolated.renderErrors, 1, 'one malformed frame is isolated and counted');
  assert.equal(pageErrors.length, 0, `frontend page errors: ${pageErrors.join(' | ')}`);
  assert.equal(consoleErrors.length, 0, `frontend console errors: ${consoleErrors.join(' | ')}`);
} finally {
  await browser.close();
}

console.log('test-chat-timeline-runtime-large: ok');
