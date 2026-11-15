#!/usr/bin/env node
// Regression coverage for approval replay storms. A durable refresh may emit
// the same privileged batch more than once; the sheet must keep its existing
// detail subtree instead of restarting the entry animation on every replay.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(repoRoot, 'static/chat/decision-sheet.js'), 'utf8');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>
    <div id="inputArea"><div id="liveBar"></div></div>
  </body></html>`, { waitUntil: 'load' });
  await page.evaluate(() => {
    window.ragentT = (key) => key;
    window.RagentLayout = { requestPass() {}, syncChatBottomOverlaySpacing() {}, observeOverlay() {} };
    window.RagentBackHandler = { push() {}, pop() {} };
    window.RagentMotion = { prefersReducedMotion: () => true };
    let batchSubscriber = null;
    let batchState = null;
    window.__emitBatch = (evt, resolved = []) => {
      batchState = { evt, resolved: [...resolved] };
      batchSubscriber?.({ pending: true, evt, resolved: new Set(resolved) });
    };
    window.RagentDecisions = {
      subscribe(callback) { callback({ pending: false, evt: null }); return () => {}; },
      subscribeBatch(callback) {
        batchSubscriber = callback;
        callback({ pending: false, evt: null, resolved: new Set() });
        return () => {};
      },
      subscribeAction(callback) { callback({ pending: false, evt: null }); return () => {}; },
      getBatchState() {
        return batchState
          ? { evt: batchState.evt, resolved: new Set(batchState.resolved) }
          : null;
      },
      getPendingBatch() { return batchState?.evt || null; },
    };
  });
  await page.addScriptTag({ content: source });

  await page.evaluate(() => {
    window.__batch = {
      batchId: 'jitter-batch',
      runId: 'run-1',
      passkeyRequired: false,
      other: [{ opId: 'op-1', command: 'echo stable' }],
      delete: [],
      defaultSelected: { other: ['op-1'], delete: [] },
    };
    window.__emitBatch(window.__batch);
  });
  await page.locator('#decisionSheet').waitFor({ state: 'visible' });
  await page.evaluate(() => {
    window.__detailsBeforeReplay = document.querySelector('#decisionSheet .decision-sheet__details');
  });

  // Same event + same resolved set: no DOM replacement, animation restart, or
  // layout churn should occur.
  await page.evaluate(() => window.__emitBatch(window.__batch));
  assert.equal(
    await page.evaluate(() => document.querySelector('#decisionSheet .decision-sheet__details') === window.__detailsBeforeReplay),
    true,
    'identical batch replay preserves the existing detail subtree',
  );

  // A real state change still refreshes the surface so the resolved group can
  // collapse (the guard must not suppress meaningful updates).
  await page.evaluate(() => window.__emitBatch(window.__batch, ['other']));
  assert.equal(
    await page.evaluate(() => document.querySelector('#decisionSheet .decision-sheet__details') === window.__detailsBeforeReplay),
    false,
    'changed batch resolution refreshes the detail subtree',
  );
  await page.close();
} finally {
  await browser.close();
}

console.log('test-chat-decision-sheet-dedupe: ok');
