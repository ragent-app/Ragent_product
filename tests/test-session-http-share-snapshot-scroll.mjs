#!/usr/bin/env node

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sessionHttpSource = [
  'static/chat/session-http-helpers.js',
  'static/chat/session-http-list-state.js',
  'static/chat/session-http.js',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

function makeElement() {
  return {
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    remove() {
      const index = this.parentNode?.children?.indexOf(this) ?? -1;
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    scrollIntoView() {},
  };
}

function createContext({ shareSnapshotMode = false, entryMode = 'resume' } = {}) {
  const metrics = { scrollToBottom: 0, scrollNodeToTop: 0 };
  const messagesInner = makeElement();
  const emptyState = makeElement();
  const messagesEl = Object.assign(makeElement(), {
    scrollHeight: 1200,
    scrollTop: 680,
    clientHeight: 400,
    getBoundingClientRect() { return { top: 0, bottom: this.clientHeight, height: this.clientHeight }; },
  });
  const context = {
    console,
    URL,
    URLSearchParams,
    Headers,
    Map,
    Set,
    Math,
    Date,
    JSON,
    TextEncoder,
    AbortController,
    Promise,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    navigator: {},
    Notification: function Notification() {},
    atob(value) { return Buffer.from(String(value), 'base64').toString('binary'); },
    window: {
      location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/', pathname: '/' },
      setTimeout,
      clearTimeout,
      addEventListener() {},
      focus() {},
      crypto: { randomUUID: () => 'req-test' },
    },
    document: {
      visibilityState: 'visible',
      getElementById() { return null; },
      createElement: makeElement,
      addEventListener() {},
    },
    pendingNavigationState: null,
    activeTab: 'sessions',
    visitorMode: false,
    visitorSessionId: null,
    currentSessionId: shareSnapshotMode ? 'share_snapshot:snap_test' : 'session_regular',
    hasAttachedSession: true,
    hasLoadedSessions: true,
    archivedSessionCount: 0,
    sessions: shareSnapshotMode ? [] : [{ id: 'session_regular', name: 'Regular', entryMode }],
    renderedEventState: {
      sessionId: null,
      earliestSeq: 0,
      nextBeforeSeq: null,
      latestSeq: 0,
      timelineItemCount: 0,
      runState: 'idle',
      runningBlockExpanded: false,
      hasMoreBefore: false,
      loadingOlder: false,
    },
    emptyState,
    messagesInner,
    messagesEl,
    shareSnapshotMode,
    shareSnapshotPayload: shareSnapshotMode ? {
      id: 'snap_test',
      session: { name: 'Shared session', tool: 'codex' },
      view: {},
      displayEvents: [
        { id: 'share-1', seq: 1, type: 'message', role: 'user', content: 'first' },
        { id: 'share-2', seq: 2, type: 'message', role: 'assistant', content: 'second' },
      ],
    } : null,
    contextTokens: makeElement(),
    compactBtn: makeElement(),
    dropToolsBtn: makeElement(),
    resumeBtn: makeElement(),
    headerTitle: makeElement(),
    inlineToolSelect: makeElement(),
    toolsList: [],
    selectedTool: '',
    loadModelsForCurrentTool() {},
    restoreDraft() {},
    updateStatus() {},
    renderQueuedMessagePanel() {},
    updateResumeButton() {},
    syncBrowserState() {},
    syncForkButton() {},
    syncShareButton() {},
    finishedUnread: new Set(),
    getSessionDisplayName(session) { return session?.name || ''; },
    getEffectiveSessionSourceId(session) { return session?.sourceId || 'chat'; },
    normalizeSessionStatus(status) { return status || 'idle'; },
    sortSessionsInPlace() {},
    refreshAppCatalog() {},
    renderSessionList() {},
    clearMessages() { messagesInner.children = []; },
    showEmpty() {},
    scrollToBottom() { metrics.scrollToBottom += 1; },
    applyFinishedTurnCollapseState() { return { id: 'latest-turn' }; },
    shouldFocusLatestTurnStart() { return true; },
    scrollNodeToTop() { metrics.scrollNodeToTop += 1; },
    checkPendingMessage() {},
    getPendingMessage() { return null; },
    clearPendingMessage() {},
    attachSession() {},
    persistActiveSessionId() {},
    resolveRestoreTargetSession() { return null; },
    switchTab() {},
    applyNavigationState() {},
  };
  context.globalThis = context;
  context.self = context;
  vm.runInNewContext(sessionHttpSource, context, { filename: 'static/chat/session-http.js' });

  let snapshot = {
    sessionId: context.currentSessionId,
    items: [],
    latestSeq: 0,
    earliestSeq: 0,
    nextBeforeSeq: null,
    hasMoreBefore: false,
    gapExpectedSeq: null,
  };
  const runtime = {
    getSnapshot() { return snapshot; },
    renderBatch(events, options = {}) {
      const pagination = options.pagination || {};
      snapshot = {
        ...snapshot,
        sessionId: options.sessionId,
        items: events.map((event) => ({ id: event.id || `seq:${event.seq}`, event })),
        latestSeq: Number.isInteger(options.latestSeq) ? options.latestSeq : Math.max(0, ...events.map((event) => event.seq || 0)),
        earliestSeq: pagination.oldestSeq || events[0]?.seq || 0,
        nextBeforeSeq: pagination.nextBeforeSeq ?? pagination.oldestSeq ?? null,
        hasMoreBefore: pagination.hasMoreBefore === true,
      };
      return snapshot;
    },
    renderIncremental(events, options = {}) {
      snapshot = { ...snapshot, sessionId: options.sessionId };
      return snapshot;
    },
  };
  context.window.RagentTimelineRuntime = runtime;
  context.__metrics = metrics;
  return context;
}

function installPageResponse(context) {
  context.fetchJsonOrRedirect = async () => ({
    events: [
      { id: 'page-1', seq: 1, type: 'message', role: 'user', content: 'first' },
      { id: 'page-2', seq: 2, type: 'message', role: 'assistant', content: 'second' },
    ],
    latestSeq: 2,
  });
}

{
  const context = createContext({ shareSnapshotMode: true });
  await context.fetchSessionEvents(context.currentSessionId, { runState: 'idle' });
  assert.equal(context.messagesEl.scrollTop, 0, 'share snapshots should open from the top');
  assert.equal(context.__metrics.scrollNodeToTop, 0, 'share snapshots should not focus a latest turn');
  assert.equal(context.__metrics.scrollToBottom, 0, 'share snapshots should not stick to the bottom');
}

{
  const context = createContext();
  installPageResponse(context);
  await context.fetchSessionEvents(context.currentSessionId, {
    runState: 'idle',
    viewportIntent: 'session_entry',
  });
  assert.equal(context.__metrics.scrollNodeToTop, 1, 'resume sessions should focus the latest turn once on entry');
  assert.equal(context.messagesEl.scrollTop, 680, 'resume entry should preserve the focused turn position');

  context.messagesEl.scrollTop = 412;
  await context.fetchSessionEvents(context.currentSessionId, { runState: 'idle' });
  assert.equal(context.messagesEl.scrollTop, 412, 'background refreshes should preserve the reading position');
}

{
  const context = createContext({ entryMode: 'read' });
  installPageResponse(context);
  await context.fetchSessionEvents(context.currentSessionId, {
    runState: 'idle',
    viewportIntent: 'session_entry',
  });
  assert.equal(context.messagesEl.scrollTop, 0, 'read sessions should enter at the top');
  assert.equal(context.__metrics.scrollNodeToTop, 0, 'read sessions should not focus a latest turn');
}

{
  const context = createContext();
  const existingNode = makeElement();
  context.messagesInner.appendChild(existingNode);
  context.messagesEl.scrollTop = 800;
  let release;
  const responseReady = new Promise((resolve) => { release = resolve; });
  context.fetchJsonOrRedirect = async () => {
    await responseReady;
    return {
      events: [{ id: 'delayed-1', seq: 1, type: 'message', role: 'assistant', content: 'late' }],
      latestSeq: 1,
    };
  };
  const refresh = context.fetchSessionEvents(context.currentSessionId, { runState: 'idle' });
  await new Promise((resolve) => setImmediate(resolve));
  context.messagesEl.scrollTop = 520;
  release();
  await refresh;
  assert.equal(context.__metrics.scrollToBottom, 0, 'a user scroll during a request must cancel bottom pinning');
  assert.equal(context.messagesEl.scrollTop, 520, 'a delayed response must preserve the new user position');
}

assert.doesNotMatch(sessionHttpSource, /skipDelta|setSessionEventSnapshot|restoreSessionEventSnapshot/);
assert.doesNotMatch(sessionHttpSource, /previousScrollHeight|viewportLocked|lockMessageViewportAnchor/);

console.log('test-session-http-share-snapshot-scroll: ok');
