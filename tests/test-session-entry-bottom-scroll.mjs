#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sessionHttpSource = [
  'static/chat/session-http-helpers.js',
  'static/chat/session-http-list-state.js',
  'static/chat/session-http.js',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
const realtimeSource = readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8');
const sessionListSource = readFileSync(join(repoRoot, 'static/chat/session-list-ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const markerStart = source.indexOf(marker);
  assert.notEqual(markerStart, -1, `${functionName} should exist`);
  const start = source.slice(Math.max(0, markerStart - 6), markerStart) === 'async '
    ? markerStart - 6
    : markerStart;
  const parameterStart = source.indexOf('(', start);
  let parameterDepth = 0;
  let parameterEnd = -1;
  for (let index = parameterStart; index < source.length; index += 1) {
    if (source[index] === '(') parameterDepth += 1;
    if (source[index] === ')') {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        parameterEnd = index;
        break;
      }
    }
  }
  const braceStart = source.indexOf('{', parameterEnd);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

function makeElement() {
  return {
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    innerHTML: '',
    textContent: '',
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
    },
    remove() {
      if (this.parentNode?.children) {
        this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      }
      this.parentNode = null;
    },
    addEventListener() {},
    querySelector() {
      return null;
    },
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
  };
}

function makeResponse(events, payload = {}) {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: 'http://127.0.0.1/api/sessions/session_regular/events?filter=visible&limit=50&direction=latest',
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type'
          ? 'application/json; charset=utf-8'
          : null;
      },
    },
    async json() {
      return { events, ...payload };
    },
  };
}

function createHttpContext({ shareSnapshotMode = false, entryMode = 'resume', olderPage = false } = {}) {
  const metrics = {
    scrollToBottomCalls: 0,
    scrollNodeToTopCalls: 0,
  };
  const messagesInner = makeElement();
  const emptyState = makeElement();
  const messagesEl = {
    dataset: {},
    scrollHeight: 1600,
    scrollTop: 620,
    clientHeight: 400,
    addEventListener() {},
    getBoundingClientRect() {
      return { top: 0, bottom: this.clientHeight, height: this.clientHeight };
    },
  };

  function makeTimelineNode(event) {
    const node = makeElement();
    node.event = event;
    node.dataset.timelineStartSeq = String(event.seq);
    node.dataset.timelineEndSeq = String(event.seq);
    node.offsetTop = Math.max(0, (event.seq - 1) * 520);
    node.getBoundingClientRect = () => {
      const top = node.offsetTop - messagesEl.scrollTop;
      return { top, bottom: top + 500, height: 500 };
    };
    return node;
  }

  const events = [
    { seq: 2, type: 'message', role: 'user', content: 'first' },
    { seq: 3, type: 'message', role: 'assistant', content: 'second' },
    { seq: 4, type: 'message', role: 'assistant', content: 'third' },
  ];
  const olderEvents = [
    { seq: 1, type: 'message', role: 'user', content: 'older' },
  ];
  const context = {
    console,
    URL,
    URLSearchParams,
    Headers,
    AbortController,
    Map,
    Set,
    Math,
    Date,
    JSON,
    setTimeout,
    clearTimeout,
    navigator: {},
    Notification: function Notification() {},
    atob(value) {
      return Buffer.from(String(value), 'base64').toString('binary');
    },
    window: {
      location: {
        origin: 'http://127.0.0.1',
        href: 'http://127.0.0.1/',
        pathname: '/',
      },
      focus() {},
      crypto: {
        randomUUID() {
          return 'req_test';
        },
      },
    },
    document: {
      visibilityState: 'visible',
      getElementById() {
        return null;
      },
      createElement() {
        return makeElement();
      },
    },
    pendingNavigationState: null,
    activeTab: 'sessions',
    visitorMode: false,
    visitorSessionId: null,
    currentSessionId: shareSnapshotMode ? 'share_snapshot:snap_test' : 'session_regular',
    hasAttachedSession: true,
    hasLoadedSessions: true,
    archivedSessionCount: 0,
    sessions: shareSnapshotMode
      ? []
      : [{ id: 'session_regular', name: 'Regular session', entryMode }],
    jsonResponseCache: new Map(),
    renderedEventState: {
      sessionId: null,
      latestSeq: 0,
      eventCount: 0,
      eventBaseKeys: [],
      eventKeys: [],
      runState: 'idle',
      runningBlockExpanded: false,
    },
    emptyState,
    messagesInner,
    messagesEl,
    sidebarSessionRefreshPromises: new Map(),
    pendingSidebarSessionRefreshes: new Set(),
    pendingCurrentSessionRefresh: false,
    currentSessionRefreshPromise: null,
    contextTokens: makeElement(),
    compactBtn: makeElement(),
    dropToolsBtn: makeElement(),
    resumeBtn: makeElement(),
    headerTitle: makeElement(),
    inlineToolSelect: makeElement(),
    toolsList: [],
    selectedTool: '',
    sessionStatus: 'idle',
    inThinkingBlock: false,
    shareSnapshotMode,
    shareSnapshotPayload: shareSnapshotMode
      ? {
        id: 'snap_test',
        session: { name: 'Shared session', tool: 'codex' },
        view: {},
        displayEvents: events,
      }
      : null,
    loadModelsForCurrentTool() {},
    restoreDraft() {},
    updateStatus() {},
    renderQueuedMessagePanel() {},
    updateResumeButton() {},
    syncBrowserState() {},
    syncForkButton() {},
    syncShareButton() {},
    finishedUnread: new Set(),
    getSessionDisplayName(session) {
      return session?.name || '';
    },
    getEffectiveSessionSourceId(session) {
      return session?.sourceId || 'chat';
    },
    normalizeSessionStatus(status) {
      return status || 'idle';
    },
    sortSessionsInPlace() {},
    refreshAppCatalog() {},
    renderSessionList() {},
    clearMessages() {
      messagesInner.children = [];
    },
    showEmpty() {},
    scrollToBottom() {
      metrics.scrollToBottomCalls += 1;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },
    applyFinishedTurnCollapseState() {
      return { id: 'latest-user-turn' };
    },
    shouldFocusLatestTurnStart() {
      return true;
    },
    scrollNodeToTop() {
      metrics.scrollNodeToTopCalls += 1;
    },
    checkPendingMessage() {},
    getPendingMessage() {
      return null;
    },
    clearPendingMessage() {},
    attachSession() {},
    persistActiveSessionId() {},
    resolveRestoreTargetSession() {
      return null;
    },
    switchTab() {},
    applyNavigationState() {},
    fetch: async (url) => String(url).includes('direction=before')
      ? makeResponse(olderEvents, {
        pagination: { oldestSeq: 1, nextBeforeSeq: null, hasMoreBefore: false },
      })
      : makeResponse(events, olderPage
        ? { pagination: { oldestSeq: 2, nextBeforeSeq: 2, hasMoreBefore: true } }
        : {}),
    getEventBoundarySeq(event) {
      return Number.isInteger(event?.seq) ? event.seq : 0;
    },
    getEventRenderBaseKey(event) {
      return `${event?.seq || 0}:${event?.type || 'unknown'}`;
    },
    getEventRenderKey(event) {
      return `${event?.seq || 0}:${event?.type || 'unknown'}:${event?.content || ''}`;
    },
    isRunningThinkingBlockEvent() {
      return false;
    },
    renderEvent(event) {
      messagesInner.children.push(makeTimelineNode(event));
    },
    reconcileComposerPendingSendWithEvent() {},
  };
  let timelineSnapshot = {
    sessionId: context.currentSessionId,
    items: [],
    latestSeq: 0,
    earliestSeq: 0,
    nextBeforeSeq: null,
    hasMoreBefore: false,
    gapExpectedSeq: null,
  };
  context.window.RagentTimelineRuntime = {
    getSnapshot() {
      return timelineSnapshot;
    },
    renderBatch(batch, options = {}) {
      timelineSnapshot = {
        ...timelineSnapshot,
        sessionId: options.sessionId,
        items: batch.map((event) => ({ id: event.id || `seq:${event.seq}`, event })),
        latestSeq: Number.isInteger(options.latestSeq)
          ? options.latestSeq
          : Math.max(0, ...batch.map((event) => event.seq || 0)),
        earliestSeq: options.pagination?.oldestSeq || batch[0]?.seq || 0,
        nextBeforeSeq: options.pagination?.nextBeforeSeq ?? options.pagination?.oldestSeq ?? null,
        hasMoreBefore: options.pagination?.hasMoreBefore === true,
      };
      return timelineSnapshot;
    },
    renderIncremental(batch, options = {}) {
      timelineSnapshot = { ...timelineSnapshot, sessionId: options.sessionId };
      return timelineSnapshot;
    },
  };
  context.globalThis = context;
  context.self = context;
  context.__metrics = metrics;
  return context;
}

function createRealtimeContext({ restoredSnapshot = true, hasSessionRecord = true } = {}) {
  const calls = {
    fetchSessionEvents: [],
    refreshCurrentSession: [],
    restoredSnapshot: 0,
    restoreSnapshotOptions: [],
  };
  const context = {
    console,
    Map,
    Set,
    window: {
      ragentT: null,
      RagentIcons: null,
    },
    location: {
      protocol: 'http:',
      host: '127.0.0.1',
    },
    currentSessionId: '',
    hasAttachedSession: false,
    sessions: hasSessionRecord ? [{ id: 'session_cached', status: 'idle' }] : [],
    setChatCurrentSession(sessionId) {
      context.currentSessionId = sessionId;
      context.hasAttachedSession = true;
    },
    getChatStoreSession(sessionId) {
      return hasSessionRecord ? { id: sessionId, status: 'idle' } : null;
    },
    normalizeSessionViewportIntent(value) {
      return value === 'session_entry' ? 'session_entry' : 'session_entry_bottom';
    },
    restoreSessionEventSnapshot(sessionId, options) {
      calls.restoredSnapshot += 1;
      calls.restoreSnapshotOptions.push({ sessionId, options });
      return restoredSnapshot;
    },
    clearMessages() {},
    resolveCurrentSessionSnapshot() {
      return hasSessionRecord ? { id: 'session_cached', status: 'idle' } : null;
    },
    getSessionRunState() {
      return 'idle';
    },
    async fetchSessionEvents(sessionId, options) {
      calls.fetchSessionEvents.push({ sessionId, options });
      return [];
    },
    async refreshCurrentSession(options) {
      calls.refreshCurrentSession.push(options);
      await context.fetchSessionEvents(context.currentSessionId, options);
      return { id: context.currentSessionId };
    },
    fetchSessionsList() {},
    renderSessionList() {},
    upsertSession(session) {
      return session;
    },
    syncEmptyStateUi() {},
    inputArea: null,
    updateStatus() {},
    refreshRealtimeViews() {},
    notifyCompletion() {},
    showSystemToast() {},
    syncBrowserState() {},
    renderQueuedMessagePanel() {},
    fetchJsonOrRedirect() {
      throw new Error('not expected');
    },
  };
  context.globalThis = context;
  context.self = context;
  context.__calls = calls;
  return context;
}

const bottomContext = createHttpContext({ entryMode: 'read' });
vm.runInNewContext(sessionHttpSource, bottomContext, { filename: 'static/chat/session-http.js' });
await bottomContext.fetchSessionEvents(bottomContext.currentSessionId, {
  runState: 'idle',
  viewportIntent: 'session_entry_bottom',
});
assert.equal(bottomContext.__metrics.scrollToBottomCalls, 1, 'explicit session entry should land at the bottom');
assert.equal(bottomContext.__metrics.scrollNodeToTopCalls, 0, 'bottom entry should not focus the latest user turn');
assert.equal(bottomContext.messagesEl.scrollTop, bottomContext.messagesEl.scrollHeight);

const pagedBottomContext = createHttpContext({ olderPage: true });
vm.runInNewContext(sessionHttpSource, pagedBottomContext, { filename: 'static/chat/session-http.js' });
await pagedBottomContext.fetchSessionEvents(pagedBottomContext.currentSessionId, {
  runState: 'idle',
  viewportIntent: 'session_entry_bottom',
});
assert.equal(
  pagedBottomContext.__metrics.scrollToBottomCalls,
  2,
  'session entry should repin the viewport after older history is prepended',
);
assert.equal(pagedBottomContext.messagesEl.scrollTop, pagedBottomContext.messagesEl.scrollHeight);

const shareContext = createHttpContext({ shareSnapshotMode: true });
vm.runInNewContext(sessionHttpSource, shareContext, { filename: 'static/chat/session-http.js' });
await shareContext.fetchSessionEvents(shareContext.currentSessionId, {
  runState: 'idle',
  viewportIntent: 'session_entry_bottom',
});
assert.equal(shareContext.__metrics.scrollToBottomCalls, 0, 'share snapshots should not use bottom session entry');
assert.equal(shareContext.messagesEl.scrollTop, 0, 'share snapshots should continue opening from the top');

const preserveContext = createHttpContext();
vm.runInNewContext(sessionHttpSource, preserveContext, { filename: 'static/chat/session-http.js' });
preserveContext.renderedEventState.sessionId = preserveContext.currentSessionId;
preserveContext.renderedEventState.latestSeq = 3;
preserveContext.renderedEventState.eventCount = 3;
preserveContext.renderedEventState.eventBaseKeys = ['1:message', '2:message', '3:message'];
preserveContext.renderedEventState.eventKeys = [
  '1:message:first',
  '2:message:second',
  '3:message:third',
];
preserveContext.messagesInner.children = [makeElement()];
await preserveContext.fetchSessionEvents(preserveContext.currentSessionId, {
  runState: 'idle',
  viewportIntent: 'preserve',
});
assert.equal(preserveContext.__metrics.scrollToBottomCalls, 0, 'background preserve refresh should not jump to bottom');
assert.equal(preserveContext.__metrics.scrollNodeToTopCalls, 0, 'background preserve refresh should not refocus the turn start');

const reopenedPinCalls = [];
const reopenedContext = {
  currentSessionId: 'session_regular',
  hasAttachedSession: true,
  getChatStoreSession() {
    return { id: 'session_regular', name: 'Regular session' };
  },
  holdAttachedSessionSidebarState() {},
  applyAttachedSessionState() {},
  focusComposer() {},
  pinMessageViewportToBottomForSessionEntry(sessionId) {
    reopenedPinCalls.push(sessionId);
  },
};
reopenedContext.globalThis = reopenedContext;
vm.runInNewContext(
  extractFunctionSource(sessionListSource, 'attachSession'),
  reopenedContext,
  { filename: 'static/chat/session-list-ui.js' },
);
reopenedContext.attachSession('session_regular', { id: 'session_regular' });
assert.deepEqual(
  reopenedPinCalls,
  ['session_regular'],
  're-opening the already attached session must repin the existing transcript to the bottom',
);

const mergeContext = createHttpContext();
vm.runInNewContext(sessionHttpSource, mergeContext, { filename: 'static/chat/session-http.js' });
assert.equal(
  mergeContext.mergeSessionRefreshOptions(
    { viewportIntent: 'preserve' },
    { viewportIntent: 'session_entry_bottom' },
  ).viewportIntent,
  'session_entry_bottom',
  'pending refresh coalescing should preserve bottom-entry intent',
);

const cachedAttachContext = createRealtimeContext({ restoredSnapshot: true });
vm.runInNewContext(realtimeSource, cachedAttachContext, { filename: 'static/chat/realtime.js' });
await cachedAttachContext.dispatchAction({ action: 'attach', sessionId: 'session_cached' });
assert.equal(cachedAttachContext.__calls.restoredSnapshot, 0, 'attach should not replay the removed local event snapshot');
assert.equal(cachedAttachContext.__calls.fetchSessionEvents.length, 1);
assert.equal(
  cachedAttachContext.__calls.restoreSnapshotOptions.length,
  0,
  'attaching a cached session should not invoke snapshot restoration',
);
assert.equal(
  cachedAttachContext.__calls.fetchSessionEvents[0].options.viewportIntent,
  'session_entry_bottom',
  'attaching a cached session should still finish at the bottom',
);

const explicitTopAttachContext = createRealtimeContext({ restoredSnapshot: true });
vm.runInNewContext(realtimeSource, explicitTopAttachContext, { filename: 'static/chat/realtime.js' });
await explicitTopAttachContext.dispatchAction({
  action: 'attach',
  sessionId: 'session_cached',
  viewportIntent: 'session_entry',
});
assert.equal(
  explicitTopAttachContext.__calls.fetchSessionEvents[0].options.viewportIntent,
  'session_entry',
  'attach should preserve an explicitly requested entry viewport intent',
);

const missingRecordAttachContext = createRealtimeContext({
  restoredSnapshot: false,
  hasSessionRecord: false,
});
vm.runInNewContext(realtimeSource, missingRecordAttachContext, { filename: 'static/chat/realtime.js' });
await missingRecordAttachContext.dispatchAction({ action: 'attach', sessionId: 'session_cached' });
assert.equal(
  missingRecordAttachContext.__calls.refreshCurrentSession[0].viewportIntent,
  'session_entry_bottom',
  'attach fallback refresh should keep bottom-entry intent',
);

console.log('test-session-entry-bottom-scroll: ok');
