#!/usr/bin/env node
// Live-render contract for Claude finalized-assistant snapshot revisions.
// Relays re-emit a finalized snapshot under a fresh provider id with an
// identical, truncated, or extended body. The live run-merge bubble must
// treat such an event as a revision (replace with the longer body) instead
// of appending a duplicate-looking second segment. Unrelated messages in the
// same run keep the existing multi-part append behavior.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const uiSource = readFileSync(new URL('../static/chat/ui.js', import.meta.url), 'utf8');

const SNAPSHOT_FIELDS = {
  type: 'message',
  role: 'assistant',
  runId: 'run-live-revision',
  provider: 'claude',
  runtimeFamily: 'claude-stream-json',
  providerSnapshotKind: 'finalized-assistant',
  providerSnapshot: true,
  providerSnapshotComplete: true,
};

const shiftedHead = 'Smoke replay 现在任务 #1 的冒烟回放已经顺利完成。';
const shiftedBody = '现在任务 #1 的冒烟回放已经顺利完成。现在开始任务 #2 的预处理确定性检查。';
const unrelatedPart = '这是另一段独立的新内容。';

async function createPage(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 720 } });
  const page = await context.newPage();
  await page.setContent('<!doctype html><html><body><div id="messages"><div id="messagesInner"></div></div></body></html>');
  await page.evaluate(() => {
    window.marked = { parse: (value) => `<p>${String(value ?? '')}</p>` };
    window.ragentT = (key) => key;
    window.RagentIcons = { render: () => '' };
    window.RagentMotion = { subscribeReducedMotion: () => {} };
    window.RagentRunActivity = { applyEvent: () => {}, noteFormalOutput: () => {} };
    window.RagentDecisions = { reset: () => {} };
    window.visitorMode = false;
    window.shareSnapshotMode = false;
    window.currentSessionId = 'snapshot-revision-session';
    window.sessionStatus = 'idle';
    window.inThinkingBlock = false;
    window.hasAttachedSession = true;
    window.messagesInner = document.getElementById('messagesInner');
    window.messagesEl = document.getElementById('messages');
    window.emptyState = null;
    window.formatDecodedDisplayText = (value) => String(value ?? '');
    window.createMessageAttachmentNode = () => null;
    window.enhanceCodeBlocks = () => {};
    window.enhanceTables = () => {};
    window.enhanceRenderedContentLinks = () => {};
    window.syncRegenerateActions = () => {};
  });
  await page.addScriptTag({ content: uiSource });
  return { context, page };
}

const browser = await chromium.launch();
try {
  const { page } = await createPage(browser);

  const render = (evt) => page.evaluate((event) => {
    renderMessageInto(window.messagesInner, event, { finalizeActiveThinkingBlock: false });
  }, evt);

  // 1. First snapshot opens the run bubble.
  await render({ seq: 1, ...SNAPSHOT_FIELDS, providerMessageId: 'msg-a', content: shiftedHead });

  // 2. Head-trimmed, tail-extended re-emission under a fresh provider id:
  //    must REPLACE the accumulated body, not append a second segment.
  await render({ seq: 2, ...SNAPSHOT_FIELDS, providerMessageId: 'msg-b', content: shiftedBody });

  let state = await page.evaluate(() => {
    const bubbles = Array.from(window.messagesInner.querySelectorAll('.msg-assistant'));
    return {
      bubbleCount: bubbles.length,
      bodyCount: bubbles[0]?.querySelectorAll('.msg-assistant-body').length,
      mergedContent: bubbles[0]?.dataset?.assistantRunMergedContent || '',
      text: bubbles[0]?.textContent || '',
    };
  });
  assert.equal(state.bubbleCount, 1, 'revision events stay inside the one run-merged bubble');
  assert.equal(state.bodyCount, 1, 'a snapshot revision replaces the rendered body instead of appending a segment');
  assert.equal(state.mergedContent, shiftedBody, 'the longer revision body becomes the bubble content');
  assert.ok(state.text.includes('预处理确定性检查'), 'the extended tail is visible');
  assert.ok(!state.mergedContent.includes('\n\n'), 'no duplicate concatenation marker');

  // 3. Identical twin re-emission: no duplicate segment, content unchanged.
  await render({ seq: 3, ...SNAPSHOT_FIELDS, providerMessageId: 'msg-c', content: shiftedBody });
  state = await page.evaluate(() => {
    const bubbles = Array.from(window.messagesInner.querySelectorAll('.msg-assistant'));
    return {
      bodyCount: bubbles[0]?.querySelectorAll('.msg-assistant-body').length,
      mergedContent: bubbles[0]?.dataset?.assistantRunMergedContent || '',
    };
  });
  assert.equal(state.bodyCount, 1, 'an identical twin re-emission adds nothing');
  assert.equal(state.mergedContent, shiftedBody, 'identical twin keeps the content stable');

  // 4. Unrelated message in the same run: existing multi-part append holds.
  await render({ seq: 4, ...SNAPSHOT_FIELDS, providerMessageId: 'msg-d', content: unrelatedPart });
  state = await page.evaluate(() => {
    const bubbles = Array.from(window.messagesInner.querySelectorAll('.msg-assistant'));
    return {
      bodyCount: bubbles[0]?.querySelectorAll('.msg-assistant-body').length,
      mergedContent: bubbles[0]?.dataset?.assistantRunMergedContent || '',
    };
  });
  assert.equal(state.bodyCount, 2, 'an unrelated same-run message still appends its own segment');
  assert.equal(state.mergedContent, `${shiftedBody}\n\n${unrelatedPart}`, 'multi-part append content is unchanged');

  console.log('test-chat-assistant-snapshot-revision-live: ok');
} finally {
  await browser.close();
}
