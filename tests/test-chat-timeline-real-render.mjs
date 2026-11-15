#!/usr/bin/env node

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (path) => readFileSync(join(repoRoot, path), 'utf8');
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
  const frontendErrors = [];
  page.on('pageerror', (error) => frontendErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') frontendErrors.push(`console.error: ${message.text()}`);
  });
  await page.setContent(`<!doctype html><html><head><style>${source('static/chat/chat-base.css')}${source('static/chat/chat-messages.css')}</style></head><body><main id="messages"><div class="messages-inner" id="messagesInner"><div class="empty-state" id="emptyState"><h2>Empty</h2></div><section class="home-workspace" id="homeWorkspace" hidden></section></div></main><div id="inputArea"></div></body></html>`);
  await page.evaluate(() => {
    window.marked = { parse: (value) => `<p>${String(value ?? '')}</p>` };
    window.ragentT = (key) => key;
    window.RagentIcons = { render: () => '' };
    window.RagentMotion = { subscribeReducedMotion: () => {} };
    window.RagentRunActivity = { applyEvent: () => {}, noteFormalOutput: () => {} };
    window.RagentDecisions = { reset: () => {} };
    window.visitorMode = false;
    window.shareSnapshotMode = false;
    window.currentSessionId = 'real-render';
    window.sessionStatus = 'running';
    window.inThinkingBlock = false;
    window.hasAttachedSession = true;
    window.messagesInner = document.getElementById('messagesInner');
    window.messagesEl = document.getElementById('messages');
    window.emptyState = document.getElementById('emptyState');
    window.inputArea = document.getElementById('inputArea');
    window.syncForkButton = () => {};
    window.syncShareButton = () => {};
    window.syncSessionTemplateControls = () => {};
    window.renderQueuedMessagePanel = () => {};
    window.resetRenderedEventState = () => {};
    window.renderedEventState = {
      sessionId: 'real-render', latestSeq: 0, earliestSeq: 0, nextBeforeSeq: null,
      hasMoreBefore: false, loadingOlder: false, runState: 'idle', timelineItemCount: 0,
      operationNodesById: new Map(), operationSnapshotsById: new Map(), expandedOperationIds: new Set(),
    };
    window.formatDecodedDisplayText = (value) => String(value ?? '');
    window.createMessageAttachmentNode = () => null;
    window.queueHydrateLazyNodes = () => {};
  });
  await page.addScriptTag({ content: source('static/chat/ui.js') });
  await page.addScriptTag({ content: source('static/chat/realtime-render.js') });
  await page.addScriptTag({ content: source('static/chat/core/timeline-projector.js') });
  await page.addScriptTag({ content: source('static/chat/timeline-runtime.js') });

  const result = await page.evaluate(async () => {
    // Re-entering a session can briefly render an empty durable page. The
    // mounted session must show the empty state instead of the hidden home
    // workspace, otherwise the message area becomes blank.
    const homeWorkspace = document.getElementById('homeWorkspace');
    messagesInner.appendChild(document.createElement('article'));
    window.showEmpty();
    const attachedEmptyState = {
      emptyStateMounted: emptyState.parentNode === messagesInner,
      emptyStateVisible: emptyState.hidden === false,
      homeWorkspaceMounted: homeWorkspace.parentNode === messagesInner,
      homeWorkspaceVisible: homeWorkspace.hidden === false,
    };
    window.currentSessionId = null;
    window.hasAttachedSession = false;
    window.showEmpty();
    const detachedEmptyState = {
      emptyStateMounted: emptyState.parentNode === messagesInner,
      emptyStateVisible: emptyState.hidden === false,
      homeWorkspaceMounted: homeWorkspace.parentNode === messagesInner,
      homeWorkspaceVisible: homeWorkspace.hidden === false,
    };
    window.currentSessionId = 'real-render';
    window.hasAttachedSession = true;
    window.showEmpty();
    window.insertComposerLocalEcho({
      requestId: 'request-user',
      text: 'Inspect the renderer',
      sessionId: 'real-render',
      scroll: false,
    });
    const localEcho = messagesInner.querySelector('.msg-user-local-echo');
    localEcho.dataset.sendAwaitingCommit = 'true';
    window.clearMessages();
    const runtime = window.RagentTimelineRuntime;
    runtime.renderBatch([
      { id: 'user', seq: 1, type: 'message', role: 'user', requestId: 'request-user', timelineEntityId: 'message:user:request', content: 'Inspect the renderer' },
      { id: 'agent-before', seq: 2, type: 'message', role: 'assistant', runId: 'run-render', timelineEntityId: 'message:assistant:before', content: 'I am checking it.' },
      { id: 'operation', seq: 3, type: 'operation', operationId: 'op-render', timelineEntityId: 'operation:op-render', state: 'completed', detail: 'Renderer inspected' },
    ], { sessionId: 'real-render', runState: 'running', pagination: { latestSeq: 3, hasMoreBefore: false } });
    runtime.renderIncremental([{ id: 'stream-1', type: 'text_delta', role: 'assistant', runId: 'run-render', text: 'The issue is ' }], {
      sessionId: 'real-render', runState: 'running', source: 'ws',
    });
    runtime.renderIncremental([{ id: 'stream-2', type: 'text_delta', role: 'assistant', runId: 'run-render', text: 'fixed.' }], {
      sessionId: 'real-render', runState: 'running', source: 'ws',
    });
    const liveRoot = [...messagesInner.children].at(-1);
    const liveStreaming = liveRoot.classList.contains('streaming');
    const liveCaret = Boolean(liveRoot.querySelector('.streaming-caret'));
    runtime.renderBatch([{ id: 'agent-final', seq: 4, type: 'message', role: 'assistant', runId: 'run-render', content: 'The issue is fixed.' }], {
      sessionId: 'real-render', runState: 'idle', pagination: { latestSeq: 4, hasMoreBefore: false },
    });
    const finalRoot = [...messagesInner.children].at(-1);
    runtime.renderIncremental([{
      id: 'alias-delta', type: 'text_delta', role: 'assistant', runId: 'run-alias',
      providerItemId: 'live-alias-item', text: 'Alias output',
    }], { sessionId: 'real-render', runState: 'running', source: 'ws' });
    runtime.renderIncremental([{
      id: 'alias-complete', type: 'message', role: 'assistant', runId: 'run-alias',
      providerMessageId: 'final-alias-message', content: 'Alias output',
    }], { sessionId: 'real-render', runState: 'running', source: 'ws' });
    const aliasRoots = [...messagesInner.children].filter((node) => node.textContent.includes('Alias output'));
    runtime.renderIncremental([{
      id: 'overlap-live-1', type: 'text_delta', role: 'assistant', runId: 'run-overlap',
      providerEventId: 'provider-overlap-1', text: 'The answer is ready to ship',
    }], { sessionId: 'real-render', runState: 'running', source: 'ws' });
    runtime.renderIncremental([{
      id: 'overlap-live-2', type: 'text_delta', role: 'assistant', runId: 'run-overlap',
      providerEventId: 'provider-overlap-2', text: 'ready to ship today.',
    }], { sessionId: 'real-render', runState: 'running', source: 'ws' });
    runtime.renderIncremental([{
      id: 'overlap-replay', type: 'text_delta', role: 'assistant', runId: 'run-overlap',
      providerEventId: 'provider-overlap-1', text: 'The answer is ready to ship',
    }], { sessionId: 'real-render', runState: 'running', source: 'ws' });
    // Revisions of the already-mounted root are intentionally coalesced into
    // one browser frame. The first delta was painted synchronously above;
    // await the frame before checking the collapsed tail text.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const overlapRoots = [...messagesInner.children].filter((node) => node.dataset.runId === 'run-overlap');
    const overlapText = overlapRoots[0]?.textContent || '';
    const oneShotContent = 'A complete assistant response arrived in one real-time event.';
    runtime.renderIncremental([{
      id: 'one-shot-live', type: 'message', role: 'assistant', runId: 'run-one-shot', content: oneShotContent,
    }], {
      sessionId: 'real-render', runState: 'running', source: 'ws',
    });
    const oneShotRoot = [...messagesInner.children].at(-1);
    const oneShotInitialStreaming = oneShotRoot.classList.contains('streaming');
    const oneShotInitialText = oneShotRoot.querySelector('.msg-assistant-body')?.textContent || '';
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const oneShotCaret = Boolean(oneShotRoot.querySelector('.streaming-caret'));
    // A duplicate invalidation while the queue is running must not replace the
    // keyed streaming root with a second final message.
    runtime.renderIncremental([{
      id: 'one-shot-live', type: 'message', role: 'assistant', runId: 'run-one-shot', content: oneShotContent,
    }], {
      sessionId: 'real-render', runState: 'running', source: 'ws',
    });
    window.RagentStreamingPresentation.finishSyntheticAssistantMessage();
    const oneShotFinalRoot = [...messagesInner.children].at(-1);
    const unknownHost = document.createElement('div');
    const unknownResult = window.renderUnknownEventInto(unknownHost, {
      type: 'provider_runtime_capabilities_v2',
      permissionModes: ['danger-full-access'],
      supportsTextDelta: true,
    });
    return {
      ids: [...messagesInner.children].map((node) => node.dataset.timelineId),
      text: [...messagesInner.children].map((node) => node.textContent),
      liveSame: liveRoot === finalRoot,
      finalCount: [...messagesInner.children].filter((node) => node.textContent.includes('The issue is fixed.')).length,
      liveStreaming,
      liveCaret,
      aliasCount: aliasRoots.length,
      overlapCount: overlapRoots.length,
      overlapText,
      oneShotInitialStreaming,
      oneShotInitialText,
      oneShotCaret,
      oneShotSame: oneShotRoot === oneShotFinalRoot,
      oneShotFinalText: oneShotFinalRoot.textContent,
      oneShotCount: [...messagesInner.children].filter((node) => node.textContent.includes(oneShotContent)).length,
      operationCount: [...messagesInner.children].filter((node) => node.classList.contains('live-operation-row')).length,
      userCount: [...messagesInner.children].filter((node) => node.classList.contains('msg-user')).length,
      userLocalEchoCount: [...messagesInner.children].filter((node) => node.classList.contains('msg-user-local-echo')).length,
      unknownResult,
      unknownChildren: unknownHost.children.length,
      attachedEmptyState,
      detachedEmptyState,
    };
  });

  assert.deepEqual(result.ids, [
    'message:user:request', 'message:assistant:before', 'message:assistant:live:run-render:segment:0',
    'message:assistant:live-alias-item',
    'message:assistant:live:run-overlap:segment:0',
    'message:assistant:live:run-one-shot:segment:0',
  ]);
  assert.equal(result.text.some((text) => text.includes('The issue is fixed.')), true);
  assert.equal(result.liveSame, true, 'the actual message renderer must retain the streaming root on durable completion');
  assert.equal(result.finalCount, 1, 'completion must not duplicate a streamed paragraph');
  assert.equal(result.liveStreaming, true, 'a timeline delta must use the visible streaming treatment');
  assert.equal(result.liveCaret, true, 'a timeline delta must show the streaming caret at the text frontier');
  assert.equal(result.aliasCount, 1, 'different provider ids in one live run must converge to one row');
  assert.equal(result.overlapCount, 1, 'overlapping live windows must keep one rendered message root');
  assert.equal(result.overlapText, 'The answer is ready to ship today.', 'the rendered message must contain each overlapped phrase once');
  assert.equal(result.oneShotInitialStreaming, true, 'a complete WS assistant message should enter the keyed streaming shell');
  assert.equal(result.oneShotInitialText, '', 'the one-shot message should not paint before its first token frame');
  assert.equal(result.oneShotCaret, true, 'the one-shot message should show the streaming caret at its frontier');
  assert.equal(result.oneShotSame, true, 'one-shot completion must settle the same timeline root');
  assert.equal(result.oneShotFinalText.includes('A complete assistant response'), true);
  assert.equal(result.oneShotCount, 1, 'duplicate real-time delivery must not create a second message');
  assert.equal(result.operationCount, 0, 'desktop timeline rendering should hide execution rows');
  assert.equal(result.userCount, 1, 'the canonical user event must replace its optimistic echo');
  assert.equal(result.userLocalEchoCount, 0, 'the committed user message must not retain the local-echo marker');
  assert.equal(result.unknownResult, null, 'unknown event payloads must not produce a transcript node');
  assert.equal(result.unknownChildren, 0, 'unknown event payloads must not be serialized into the DOM');
  assert.deepEqual(result.attachedEmptyState, {
    emptyStateMounted: true,
    emptyStateVisible: true,
    homeWorkspaceMounted: false,
    homeWorkspaceVisible: false,
  }, 'an attached session with an empty history page must not be covered by the home workspace');
  assert.deepEqual(result.detachedEmptyState, {
    emptyStateMounted: false,
    emptyStateVisible: false,
    homeWorkspaceMounted: true,
    homeWorkspaceVisible: true,
  }, 'the home workspace must remain the empty surface when no session is attached');
  assert.deepEqual(frontendErrors, [], 'timeline rendering must not emit frontend errors');

  const refreshRace = await page.evaluate(() => {
    window.currentSessionId = 'real-render';
    window.hasAttachedSession = true;
    window.insertComposerLocalEcho({
      requestId: 'request-refresh-order',
      text: 'A new question',
      sessionId: 'real-render',
      baselineEventSeq: 10,
      scroll: false,
    });
    const echo = messagesInner.querySelector('.msg-user-local-echo[data-request-id="request-refresh-order"]');
    echo.dataset.sendAwaitingCommit = 'true';
    window.clearMessages();
    window.RagentTimelineRuntime.renderBatch([
      { id: 'before-refresh', seq: 10, type: 'message', role: 'assistant', content: 'Earlier answer' },
      { id: 'after-refresh', seq: 11, type: 'message', role: 'assistant', content: 'First answer token' },
    ], {
      sessionId: 'real-render',
      runState: 'running',
      pagination: { latestSeq: 11, hasMoreBefore: false },
    });
    window.restorePreservedComposerEchoesAfterRender();
    return [...messagesInner.children].map((node) => ({
      requestId: node.dataset.requestId || '',
      timelineSeq: node.dataset.timelineStartSeq || '',
      localEcho: node.classList.contains('msg-user-local-echo'),
      text: node.textContent,
    }));
  });
  assert.deepEqual(
    refreshRace.map((node) => node.text),
    ['Earlier answer', 'A new question', 'First answer token'],
    'an uncommitted user echo must stay between the prior history and the first post-send assistant event during refresh',
  );
  assert.equal(refreshRace[1].localEcho, true);

  const sessionTransition = await page.evaluate(async () => {
    window.currentSessionId = 'real-render-next';
    window.hasAttachedSession = true;
    const previousText = [...messagesInner.children]
      .map((node) => node.textContent || '')
      .find((text) => text.includes('Earlier answer')) || '';
    window.clearMessages({ preserveContent: true });
    const retainedDuringLoad = [...messagesInner.children]
      .some((node) => (node.textContent || '').includes('Earlier answer'));
    const transitionDuringLoad = messagesInner.classList.contains('is-session-transitioning')
      && messagesInner.getAttribute('aria-busy') === 'true';

    window.RagentTimelineRuntime.renderBatch([
      { id: 'next-user', seq: 1, type: 'message', role: 'user', content: 'Next session' },
      { id: 'next-assistant', seq: 2, type: 'message', role: 'assistant', content: 'Loaded without a blank frame.' },
    ], {
      sessionId: 'real-render-next',
      runState: 'idle',
      pagination: { latestSeq: 2, hasMoreBefore: false },
    });
    // The replacement is committed synchronously, but the parent opacity
    // crossfade releases on the next two frames so the browser never paints
    // a half-restored transcript.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      previousText,
      retainedDuringLoad,
      transitionDuringLoad,
      finalTexts: [...messagesInner.children].map((node) => node.textContent || ''),
      transitionAfterRender: messagesInner.classList.contains('is-session-transitioning'),
      ariaBusyAfterRender: messagesInner.getAttribute('aria-busy'),
    };
  });
  assert.equal(sessionTransition.previousText, 'Earlier answer', 'the transition fixture should start with the previous session content');
  assert.equal(sessionTransition.retainedDuringLoad, true, 'session navigation should retain the previous transcript while the replacement loads');
  assert.equal(sessionTransition.transitionDuringLoad, true, 'retained session content should expose a bounded loading state');
  assert.deepEqual(sessionTransition.finalTexts, ['Next session', 'Loaded without a blank frame.'], 'the replacement transcript should commit as one session transition');
  assert.equal(sessionTransition.transitionAfterRender, false, 'a successful replacement render should end the transition state');
  assert.equal(sessionTransition.ariaBusyAfterRender, null, 'a successful replacement render should clear aria-busy');

  const mobilePage = await browser.newPage({ viewport: { width: 390, height: 720 } });
  const mobileFrontendErrors = [];
  mobilePage.on('pageerror', (error) => mobileFrontendErrors.push(`pageerror: ${error.message}`));
  mobilePage.on('console', (message) => {
    if (message.type() === 'error') mobileFrontendErrors.push(`console.error: ${message.text()}`);
  });
  await mobilePage.setContent(`<!doctype html><html><head><style>${source('static/chat/chat-base.css')}${source('static/chat/chat-messages.css')}</style></head><body><main id="messages"><div class="messages-inner" id="messagesInner"></div></main></body></html>`);
  await mobilePage.evaluate(() => {
    window.marked = { parse: (value) => `<p>${String(value ?? '')}</p>` };
    window.ragentT = (key) => key;
    window.RagentIcons = { render: () => '' };
    window.RagentMotion = { subscribeReducedMotion: () => {} };
    window.RagentRunActivity = { applyEvent: () => {}, noteFormalOutput: () => {} };
    window.RagentDecisions = { reset: () => {} };
    window.visitorMode = false;
    window.shareSnapshotMode = false;
    window.currentSessionId = 'mobile-render';
    window.sessionStatus = 'running';
    window.inThinkingBlock = false;
    window.hasAttachedSession = true;
    window.messagesInner = document.getElementById('messagesInner');
    window.messagesEl = document.getElementById('messages');
    window.emptyState = document.createElement('div');
    window.renderedEventState = {
      sessionId: 'mobile-render', latestSeq: 0, earliestSeq: 0, nextBeforeSeq: null,
      hasMoreBefore: false, loadingOlder: false, runState: 'idle', timelineItemCount: 0,
      operationNodesById: new Map(), operationSnapshotsById: new Map(), expandedOperationIds: new Set(),
    };
    window.formatDecodedDisplayText = (value) => String(value ?? '');
    window.createMessageAttachmentNode = () => null;
    window.queueHydrateLazyNodes = () => {};
  });
  await mobilePage.addScriptTag({ content: source('static/chat/ui.js') });
  await mobilePage.addScriptTag({ content: source('static/chat/realtime-render.js') });
  await mobilePage.addScriptTag({ content: source('static/chat/core/timeline-projector.js') });
  await mobilePage.addScriptTag({ content: source('static/chat/timeline-runtime.js') });
  const mobileResult = await mobilePage.evaluate(() => {
    window.RagentTimelineRuntime.renderBatch([
      { id: 'mobile-user', seq: 1, type: 'message', role: 'user', content: 'Keep this message' },
      { id: 'mobile-thinking', seq: 2, type: 'thinking_block', state: 'completed', label: 'Thought' },
      { id: 'mobile-operation', seq: 3, type: 'operation', operationId: 'mobile-op', state: 'completed', detail: 'Ran a command' },
      { id: 'mobile-inventory', seq: 4, type: 'status', content: 'MCP inventory 2 servers · 139 tools', codexMcpStatus: 'inventory' },
    ], { sessionId: 'mobile-render', runState: 'idle', pagination: { latestSeq: 4 } });
    return {
      userCount: document.querySelectorAll('#messagesInner > .msg-user').length,
      thinkingCount: document.querySelectorAll('#messagesInner > .thinking-block').length,
      operationCount: document.querySelectorAll('#messagesInner > .live-operation-row').length,
      inventoryCount: [...document.querySelectorAll('#messagesInner > *')]
        .filter((node) => node.textContent.includes('MCP inventory')).length,
    };
  });
  assert.deepEqual(mobileResult, {
    userCount: 1,
    thinkingCount: 0,
    operationCount: 0,
    inventoryCount: 0,
  }, 'mobile timeline rendering should keep messages while hiding thinking, execution rows, and MCP metadata');
  assert.deepEqual(mobileFrontendErrors, [], 'mobile timeline rendering must not emit frontend errors');
  await mobilePage.close();
} finally {
  await browser.close();
}

console.log('test-chat-timeline-real-render: ok');
