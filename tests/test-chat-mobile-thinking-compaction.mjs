#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static/chat/ui.js'), 'utf8');
const runActivitySource = readFileSync(join(repoRoot, 'static/chat/run-activity-ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}(`;
  const functionStart = source.indexOf(marker);
  assert.notEqual(functionStart, -1, `${functionName} should exist`);
  const paramsStart = functionStart + marker.length - 1;
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(functionStart, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const functionNames = [
  'createDeferredThinkingBlock',
  'parseEventBlockSeq',
  'isRunningThinkingBlockEvent',
  'shouldOpenThinkingBlocksFromPreference',
  'getThinkingBlockLabel',
  'shouldCompactMobileThinking',
  'removeMobileLiveActivityLine',
  'getMobileLiveRunState',
  'isMobileLiveRunState',
  'getMobileLiveActivityFallbackText',
  'buildMobileLiveActivityLineRow',
  'syncMobileLiveActivityLine',
  'hasActiveMobileRunActivity',
  'isMobileCommandOperationNode',
  'isMobileThinkingBlockNode',
  'isMobileThinkingGroupNode',
  'isMobileThinkingCompactionNode',
  'compactMobileThinkingTimeline',
  'renderThinkingBlockEvent',
  'renderOperation',
];
const extractedSource = functionNames.map((name) => extractFunctionSource(uiSource, name)).join('\n\n');

async function createPage(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.on('pageerror', (error) => console.error('pageerror:', error.message));
  await page.setContent('<main id="messages"></main>');
  await page.addScriptTag({ content: runActivitySource });
  await page.addScriptTag({
    content: `
      window.ragentT = (key) => ({
        'activity.label.approval': 'Approval required',
        'activity.label.command': 'Running command',
        'activity.label.read': 'Reading file',
        'activity.label.search': 'Searching',
        'activity.label.file_edit': 'Editing file',
        'activity.label.web': 'Accessing web',
        'activity.label.mcp': 'Using tool',
        'activity.label.subagent': 'Running subtask',
        'activity.label.planning': 'Drafting plan',
        'activity.label.responding': 'Writing response',
        'activity.label.thinking': 'Analyzing',
        'activity.label.waiting': 'Waiting',
        'activity.label.working': 'Working',
      }[key] || key);
      const messagesInner = document.getElementById('messages');
      const emptyState = document.createElement('div');
      let inThinkingBlock = false;
      let currentSessionId = 'session-mobile-thinking';
      let hasAttachedSession = true;
      let sessionStatus = 'idle';
      let renderedEventState = {
        sessionId: currentSessionId,
        runState: 'idle',
        runningBlockExpanded: false,
      };
      let mobileLiveActivityLine = null;
      function t(key) {
        return ({
          'activity.label.working': 'Working',
          'thinking.active': 'Thinking…',
          'thinking.done': 'Thought',
        }[key] || key);
      }
      function esc(value) { return String(value || ''); }
      function renderUiIcon() { return '<span class="icon"></span>'; }
      function finalizeThinkingBlock() { inThinkingBlock = false; }
      function setRunningEventBlockExpanded() {}
      function refreshCurrentSession() { return Promise.resolve(); }
      function ensureEventBlockLoaded() { return Promise.resolve(); }
      function renderOperationInto(container, evt) {
        const node = document.createElement('div');
        node.className = 'live-operation-row';
        node.dataset.operationId = evt.operationId || '';
        container.appendChild(node);
      }
      ${extractedSource}
      window.RagentRunActivity.subscribe(syncMobileLiveActivityLine);
      window.mobileThinkingTest = {
        compactMobileThinkingTimeline,
        syncMobileLiveActivityLine,
        renderThinkingBlockEvent,
        renderOperation,
        setRunState(nextState) {
          sessionStatus = nextState;
          renderedEventState.runState = nextState;
          syncMobileLiveActivityLine();
        },
      };
    `,
  });
  return page;
}

const browser = await chromium.launch({ headless: true });
try {
  const mobilePage = await createPage(browser, 390);
  await mobilePage.evaluate(() => {
    window.mobileThinkingTest.setRunState('running');
    window.RagentRunActivity.reset();
  });
  assert.equal(
    await mobilePage.locator('#messages > .mobile-live-activity-line').count(),
    1,
    'an active run must keep a fallback activity row when currentActivity is missing',
  );
  assert.equal(
    await mobilePage.locator('.mobile-live-activity-line__label').textContent(),
    'Working…',
    'the missing activity fallback should use the generic working label',
  );

  await mobilePage.evaluate(() => {
    window.RagentRunActivity.setActivity({
      state: 'working', kind: 'thinking', sourceSeq: 0, outputBoundarySeq: 0, inlineEligible: true,
    });
    window.mobileThinkingTest.renderThinkingBlockEvent({
      type: 'thinking_block', seq: 2, state: 'running', blockStartSeq: 2, blockEndSeq: 3,
    });
    window.mobileThinkingTest.renderOperation({
      type: 'operation', seq: 4, endSeq: 4, kind: 'command', state: 'running', operationId: 'op-1',
    });
  });

  assert.equal(await mobilePage.locator('#messages > .mobile-live-activity-line').count(), 1);
  assert.equal(await mobilePage.locator('#messages > .thinking-block').count(), 0);
  assert.equal(await mobilePage.locator('#messages > .live-operation-row').count(), 0);
  assert.equal(
    await mobilePage.locator('.mobile-live-activity-line__label').textContent(),
    'Running command…',
  );

  await mobilePage.evaluate(() => {
    window.RagentRunActivity.noteFormalOutput({ type: 'text_delta', seq: 5 });
  });
  assert.equal(
    await mobilePage.locator('#messages > .mobile-live-activity-line').count(),
    1,
    'formal output must not remove the live activity while the run is active',
  );

  await mobilePage.evaluate(() => {
    const message = document.createElement('div');
    message.className = 'msg-assistant';
    message.textContent = 'First visible paragraph';
    document.getElementById('messages').appendChild(message);
    window.mobileThinkingTest.renderOperation({
      type: 'operation', seq: 6, endSeq: 6, kind: 'search', state: 'running', detail: 'thinking row',
    });
  });
  assert.equal(await mobilePage.locator('#messages > .mobile-live-activity-line').count(), 1);
  assert.equal(
    await mobilePage.locator('#messages').evaluate((messages) => messages.lastElementChild.className),
    'mobile-live-activity-line',
    'work resumed after visible output should append the one-line summary after that output',
  );
  assert.equal(await mobilePage.locator('.mobile-live-activity-line__label').textContent(), 'Searching thinking row…');

  await mobilePage.evaluate(() => {
    window.RagentRunActivity.noteFormalOutput({ type: 'text_delta' });
  });
  assert.equal(await mobilePage.locator('#messages > .mobile-live-activity-line').count(), 1);

  await mobilePage.evaluate(() => {
    const messages = document.getElementById('messages');
    const thinking = document.createElement('div');
    thinking.className = 'thinking-block collapsed';
    const operation = document.createElement('div');
    operation.className = 'live-operation-row state-completed kind-command';
    messages.append(thinking, operation);
    window.mobileThinkingTest.compactMobileThinkingTimeline();
  });
  assert.equal(await mobilePage.locator('#messages > .thinking-block').count(), 0);
  assert.equal(await mobilePage.locator('#messages > .live-operation-row').count(), 0);

  await mobilePage.evaluate(() => {
    window.mobileThinkingTest.setRunState('idle');
  });
  assert.equal(
    await mobilePage.locator('#messages > .mobile-live-activity-line').count(),
    0,
    'the fallback activity row must disappear after the run reaches a terminal state',
  );
  await mobilePage.close();

  const desktopPage = await createPage(browser, 1024);
  await desktopPage.evaluate(() => {
    window.mobileThinkingTest.setRunState('running');
    window.RagentRunActivity.setActivity({
      state: 'working', kind: 'thinking', sourceSeq: 2, outputBoundarySeq: 0, inlineEligible: true,
    });
    window.mobileThinkingTest.renderThinkingBlockEvent({
      type: 'thinking_block', seq: 2, state: 'running', blockStartSeq: 2, blockEndSeq: 3,
    });
    window.mobileThinkingTest.renderOperation({
      type: 'operation', seq: 4, kind: 'command', state: 'running', operationId: 'op-desktop',
    });
    window.mobileThinkingTest.renderOperation({
      type: 'operation', seq: 5, kind: 'command', state: 'completed', operationId: 'op-desktop',
    });
  });
  assert.equal(await desktopPage.locator('#messages > .thinking-block').count(), 0);
  assert.equal(await desktopPage.locator('#messages > .live-operation-row').count(), 0);
  assert.equal(
    await desktopPage.locator('#messages > .mobile-live-activity-line').count(),
    1,
    'desktop should use the same compact run-activity presentation as mobile',
  );
  await desktopPage.close();

  console.log('test-chat-mobile-thinking-compaction: ok');
} finally {
  await browser.close();
}
