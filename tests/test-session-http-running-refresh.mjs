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
    style: {},
    dataset: {},
    disabled: false,
    textContent: '',
    innerHTML: '',
    children: [],
    parentNode: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(child) {
      if (!child) return child;
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      if (child) child.parentNode = null;
      return child;
    },
    remove() {
      this.parentNode?.removeChild?.(this);
      this.parentNode = null;
    },
    addEventListener() {},
    focus() {},
    scrollIntoView() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function createHarness({ sessionSnapshot = false } = {}) {
  let performanceNow = 0;
  const calls = {
    fetch: [],
    batch: [],
    incremental: [],
    scrollToBottom: 0,
    showEmpty: 0,
  };
  const emptyState = makeElement();
  const messagesInner = makeElement();
  const messagesEl = Object.assign(makeElement(), {
    scrollHeight: 100,
    scrollTop: 0,
    clientHeight: 100,
  });
  const renderedEventState = {
    sessionId: 'current-session',
    earliestSeq: 0,
    nextBeforeSeq: null,
    latestSeq: 0,
    timelineItemCount: 0,
    runState: 'idle',
    runActivity: null,
    operationNodesById: new Map(),
    operationSnapshotsById: new Map(),
    expandedOperationIds: new Set(),
    runningBlockExpanded: false,
    hasMoreBefore: false,
    loadingOlder: false,
  };

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
    performance: { now: () => performanceNow },
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
      ...(sessionSnapshot ? { __RAGENT_BOOTSTRAP__: { features: { sessionSnapshot: true } } } : {}),
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
    currentSessionId: 'current-session',
    hasAttachedSession: true,
    hasLoadedSessions: true,
    archivedSessionCount: 0,
    sessions: [{
      id: 'current-session',
      name: 'Current session',
      status: 'running',
      updatedAt: '2026-03-12T09:30:00.000Z',
      sourceId: 'chat',
      sourceName: 'Chat',
    }],
    renderedEventState,
    emptyState,
    messagesInner,
    messagesEl,
    inputArea: makeElement(),
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
    clearMessages() {},
    showEmpty() { calls.showEmpty += 1; },
    scrollToBottom() { calls.scrollToBottom += 1; },
    applyFinishedTurnCollapseState() { return null; },
    shouldFocusLatestTurnStart() { return false; },
    scrollNodeToTop() {},
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

  let timelineSnapshot = {
    sessionId: 'current-session',
    items: [],
    latestSeq: 0,
    earliestSeq: 0,
    nextBeforeSeq: null,
    hasMoreBefore: false,
    gapExpectedSeq: null,
  };
  const timelineRuntime = {
    getSnapshot() { return timelineSnapshot; },
    setSnapshot(snapshot) { timelineSnapshot = snapshot; },
    renderBatch(events, options = {}) {
      calls.batch.push({ events, options });
      performanceNow += 7;
      const pagination = options.pagination || {};
      timelineSnapshot = {
        ...timelineSnapshot,
        sessionId: options.sessionId,
        items: events.map((event, index) => ({
          id: event.id || `item-${index}`,
          event,
          startSeq: Number(event.seq) || 0,
          endSeq: Number(event.seq) || 0,
        })),
        latestSeq: Number.isInteger(options.latestSeq)
          ? options.latestSeq
          : Math.max(0, ...events.map((event) => Number(event.seq) || 0)),
        earliestSeq: Number.isInteger(pagination.oldestSeq) ? pagination.oldestSeq : 0,
        nextBeforeSeq: pagination.nextBeforeSeq ?? pagination.oldestSeq ?? null,
        hasMoreBefore: pagination.hasMoreBefore === true,
        gapExpectedSeq: null,
      };
      Object.assign(renderedEventState, {
        sessionId: options.sessionId,
        latestSeq: timelineSnapshot.latestSeq,
        earliestSeq: timelineSnapshot.earliestSeq,
        nextBeforeSeq: timelineSnapshot.nextBeforeSeq,
        hasMoreBefore: timelineSnapshot.hasMoreBefore,
        loadingOlder: false,
      });
      return timelineSnapshot;
    },
    renderIncremental(events, options = {}) {
      calls.incremental.push({ events, options });
      timelineSnapshot = {
        ...timelineSnapshot,
        sessionId: options.sessionId,
        latestSeq: Number.isInteger(options.latestSeq)
          ? Math.max(timelineSnapshot.latestSeq, options.latestSeq)
          : timelineSnapshot.latestSeq,
      };
      return timelineSnapshot;
    },
  };
  context.window.RagentTimelineRuntime = timelineRuntime;

  return { context, calls, emptyState, messagesInner, messagesEl, renderedEventState, timelineRuntime };
}

function setRenderedSnapshot(harness, patch = {}) {
  harness.timelineRuntime.setSnapshot({
    sessionId: 'current-session',
    items: [{ id: 'message:assistant:run-1' }],
    latestSeq: 42,
    earliestSeq: 1,
    nextBeforeSeq: null,
    hasMoreBefore: false,
    gapExpectedSeq: null,
    ...patch,
  });
}

const harness = createHarness();
const { context, calls, messagesInner, messagesEl, renderedEventState } = harness;

assert.equal(context.getSessionRunState({ activity: { run: { state: 'waiting_user' } } }), 'waiting_user');
assert.equal(context.isApprovalLiveRunState('waiting_user'), true);
assert.equal(context.normalizeRenderedRunState('waiting_user'), 'waiting_user');

{
  const pager = createHarness();
  setRenderedSnapshot(pager, {
    earliestSeq: 51,
    nextBeforeSeq: 51,
    hasMoreBefore: true,
  });
  pager.renderedEventState.hasMoreBefore = true;
  pager.renderedEventState.nextBeforeSeq = 51;
  pager.messagesEl.scrollTop = 0;
  pager.context.isMessageViewportProgrammaticScroll = () => true;
  assert.equal(
    pager.context.shouldLoadOlderSessionEventsFromScroll(),
    false,
    'a synthetic bottom-pin scroll must not request an older page',
  );
  pager.context.markMessagesOlderLoadUserIntent();
  assert.equal(
    pager.context.shouldLoadOlderSessionEventsFromScroll(),
    true,
    'a real upward gesture must win over the transient programmatic-scroll guard',
  );
}

setRenderedSnapshot(harness);
renderedEventState.runState = 'running';
renderedEventState.runningBlockExpanded = false;
assert.equal(
  context.shouldFetchSessionEventsForRefresh('current-session', {
    latestSeq: 42,
    activity: { run: { state: 'running' } },
  }),
  false,
  'an already projected running page should not refetch without a newer cursor',
);
assert.equal(
  context.shouldFetchSessionEventsForRefresh('current-session', {
    latestSeq: 43,
    activity: { run: { state: 'running' } },
  }),
  true,
  'a newer server cursor should request the next event batch',
);
setRenderedSnapshot(harness, { gapExpectedSeq: 43 });
assert.equal(
  context.shouldFetchSessionEventsForRefresh('current-session', {
    latestSeq: 42,
    activity: { run: { state: 'running' } },
  }),
  true,
  'a projector gap should request reconciliation even when the cursor is unchanged',
);
renderedEventState.runningBlockExpanded = true;
assert.equal(
  context.shouldFetchSessionEventsForRefresh('current-session', {
    latestSeq: 42,
    activity: { run: { state: 'running' } },
  }),
  true,
  'an expanded running block remains an explicit refresh request',
);
assert.equal(
  context.shouldFetchSessionEventsForRefresh('current-session', {
    activity: { run: { state: 'completed' } },
  }),
  true,
  'completed sessions must fetch the final durable projection',
);

{
  const full = createHarness();
  full.messagesEl.scrollHeight = 480;
  const urls = [];
  full.context.fetchJsonOrRedirect = async (url, options = {}) => {
    urls.push({ url, options });
    return {
      events: [{ id: 'message-1', seq: 1, type: 'message', role: 'user', content: 'hello' }],
      latestSeq: 1,
      pagination: { oldestSeq: 1, latestSeq: 1, hasMoreBefore: true },
      runActivity: { run: { state: 'idle' } },
    };
  };
  const events = await full.context.fetchSessionEvents('current-session', {
    runState: 'idle',
    forceFresh: true,
  });
  assert.deepEqual(events.map((event) => event.id), ['message-1']);
  assert.deepEqual(urls.map((entry) => entry.url), [
    '/api/sessions/current-session/events?filter=visible&limit=50&direction=latest',
  ], 'initial hydration should request one durable latest page');
  assert.equal(urls[0].options.cache, 'no-store');
  assert.equal(full.calls.batch.length, 1);
  assert.equal(full.calls.incremental.length, 0);
  assert.equal(full.calls.batch[0].options.paginationMode, 'latest');
  assert.equal(full.calls.batch[0].options.historyPrepend, undefined);
  const fullMetrics = full.context.window.ragentGetEventRefreshMetrics();
  assert.equal(fullMetrics.last.mode, 'full');
  assert.equal(fullMetrics.last.renderMs, 7, 'full refresh metrics should measure the durable DOM projection');
}

{
  const snapshot = createHarness({ sessionSnapshot: true });
  const urls = [];
  snapshot.context.fetchJsonOrRedirect = async (url) => {
    urls.push(url);
    return {
      session: {
        id: 'current-session',
        name: 'Current session',
        status: 'idle',
        latestSeq: 2,
        activity: { run: { state: 'idle' } },
      },
      events: [
        { id: 'snapshot-1', seq: 1, type: 'message', role: 'user', content: 'hello' },
        { id: 'snapshot-2', seq: 2, type: 'message', role: 'assistant', content: 'world' },
      ],
      latestSeq: 2,
      pagination: { oldestSeq: 1, latestSeq: 2, hasMoreBefore: false },
      runActivity: { run: { state: 'idle' } },
    };
  };
  await snapshot.context.runCurrentSessionRefresh('current-session', {
    viewportIntent: 'preserve',
  });
  assert.deepEqual(urls, ['/api/sessions/current-session/snapshot?limit=50'], 'enabled clients should use one combined session snapshot request');
  assert.equal(snapshot.calls.batch.length, 1, 'snapshot data should enter the durable timeline projector');
  assert.deepEqual(snapshot.calls.batch[0].events.map((event) => event.id), ['snapshot-1', 'snapshot-2']);
}

{
  const attached = createHarness();
  setRenderedSnapshot(attached, {
    latestSeq: 42,
    earliestSeq: 5,
    nextBeforeSeq: 5,
    hasMoreBefore: true,
  });
  attached.renderedEventState.runState = 'running';
  attached.renderedEventState.hasMoreBefore = true;
  attached.renderedEventState.nextBeforeSeq = 5;
  attached.messagesInner.appendChild(makeElement());
  const urls = [];
  attached.context.fetchSessionState = async () => ({
    id: 'current-session',
    latestSeq: 42,
    activity: { run: { state: 'running' } },
  });
  attached.context.fetchJsonOrRedirect = async (url) => {
    urls.push(url);
    return {
      events: [{ id: 'message-1', seq: 1, type: 'message', role: 'user', content: 'older' }],
      pagination: { oldestSeq: 1, nextBeforeSeq: null, hasMoreBefore: false },
    };
  };
  await attached.context.runCurrentSessionRefresh('current-session', {
    viewportIntent: 'preserve',
  });
  assert.deepEqual(urls, [
    '/api/sessions/current-session/events?filter=visible&limit=50&direction=before&beforeSeq=5',
  ], 'an attached short projection must autofill even when the state refresh skips event fetch');
}

{
  const delta = createHarness();
  const urls = [];
  setRenderedSnapshot(delta);
  delta.messagesInner.appendChild(makeElement());
  delta.context.fetchJsonOrRedirect = async (url) => {
    urls.push(url);
    return {
      events: [{ id: 'delta-2', seq: 2, type: 'text_delta', role: 'assistant', runId: 'run-1', text: 'world' }],
      operationUpdates: [{ id: 'op-2', seq: 3, type: 'operation', operationId: 'op-1', state: 'completed' }],
      latestSeq: 3,
      resetRequired: false,
    };
  };
  await delta.context.fetchSessionEvents('current-session', { runState: 'running' });
  assert.deepEqual(urls, ['/api/sessions/current-session/events/delta?filter=visible&afterSeq=42']);
  assert.equal(delta.calls.incremental.length, 0, 'HTTP data must never enter the live-overlay renderer');
  assert.equal(delta.calls.batch.length, 1, 'an incremental HTTP response updates the durable baseline');
  assert.deepEqual(
    delta.calls.batch[0].events.map((event) => event.id),
    ['delta-2', 'op-2'],
    'delta and operation updates must enter one durable projector call',
  );
  assert.equal(delta.calls.batch[0].options.source, 'http');
  const deltaMetrics = delta.context.window.ragentGetEventRefreshMetrics();
  assert.equal(deltaMetrics.last.mode, 'delta');
  assert.equal(deltaMetrics.last.renderMs, 7, 'delta refresh metrics should measure the durable DOM projection');
}

{
  const autofill = createHarness();
  autofill.messagesEl.scrollHeight = 100;
  autofill.messagesEl.clientHeight = 100;
  const urls = [];
  autofill.context.fetchJsonOrRedirect = async (url) => {
    urls.push(url);
    if (url.includes('direction=latest')) {
      return {
        events: [{ id: 'message-5', seq: 5, type: 'message', role: 'assistant', content: 'latest' }],
        latestSeq: 5,
        pagination: { oldestSeq: 5, nextBeforeSeq: 5, hasMoreBefore: true },
      };
    }
    if (url.includes('beforeSeq=5')) {
      return {
        events: [{ id: 'message-3', seq: 3, type: 'message', role: 'user', content: 'older one' }],
        pagination: { oldestSeq: 3, nextBeforeSeq: 3, hasMoreBefore: true },
      };
    }
    return {
      events: [{ id: 'message-1', seq: 1, type: 'message', role: 'user', content: 'oldest' }],
      pagination: { oldestSeq: 1, nextBeforeSeq: null, hasMoreBefore: false },
    };
  };
  await autofill.context.fetchSessionEvents('current-session', {
    runState: 'idle',
    viewportIntent: 'session_entry',
  });
  assert.deepEqual(urls, [
    '/api/sessions/current-session/events?filter=visible&limit=50&direction=latest',
    '/api/sessions/current-session/events?filter=visible&limit=50&direction=before&beforeSeq=5',
    '/api/sessions/current-session/events?filter=visible&limit=50&direction=before&beforeSeq=3',
  ], 'a short initial viewport should automatically request successive older pages');
  assert.equal(autofill.renderedEventState.hasMoreBefore, false);
}

{
  const sessionEntry = createHarness();
  sessionEntry.messagesEl.scrollHeight = 480;
  sessionEntry.messagesEl.clientHeight = 100;
  const urls = [];
  sessionEntry.context.fetchJsonOrRedirect = async (url) => {
    urls.push(url);
    if (url.includes('direction=latest')) {
      return {
        events: [{ id: 'message-100', seq: 100, type: 'message', role: 'assistant', content: 'latest' }],
        latestSeq: 100,
        pagination: { oldestSeq: 100, nextBeforeSeq: 100, hasMoreBefore: true },
      };
    }
    return {
      events: [{ id: 'message-50', seq: 50, type: 'message', role: 'user', content: 'previous page' }],
      pagination: { oldestSeq: 50, nextBeforeSeq: 50, hasMoreBefore: true },
    };
  };
  await sessionEntry.context.fetchSessionEvents('current-session', {
    runState: 'idle',
    viewportIntent: 'session_entry',
  });
  assert.deepEqual(urls, [
    '/api/sessions/current-session/events?filter=visible&limit=50&direction=latest',
    '/api/sessions/current-session/events?filter=visible&limit=50&direction=before&beforeSeq=100',
  ], 'session entry must load the newest two pages even when the first page fills the viewport');
}

{
  const reset = createHarness();
  const urls = [];
  setRenderedSnapshot(reset);
  reset.messagesInner.appendChild(makeElement());
  reset.context.fetchJsonOrRedirect = async (url) => {
    urls.push(url);
    if (url.includes('/events/delta?')) return { events: [], latestSeq: 44, resetRequired: true };
    return {
      events: [{ id: 'canonical-1', seq: 44, type: 'message', role: 'assistant', content: 'final' }],
      latestSeq: 44,
      pagination: { oldestSeq: 44, latestSeq: 44, hasMoreBefore: false },
    };
  };
  await reset.context.fetchSessionEvents('current-session', { runState: 'running' });
  assert.deepEqual(urls, [
    '/api/sessions/current-session/events/delta?filter=visible&afterSeq=42',
    '/api/sessions/current-session/events?filter=visible&limit=50&direction=latest',
  ], 'a projector reset signal must fall back to the canonical latest page');
  assert.equal(reset.calls.batch.length, 1);
  assert.equal(reset.calls.incremental.length, 0);
}

{
  const refresh = createHarness();
  setRenderedSnapshot(refresh, { latestSeq: 7 });
  refresh.renderedEventState.runState = 'running';
  let stateCalls = 0;
  let eventCalls = 0;
  refresh.context.fetchSessionState = async () => {
    stateCalls += 1;
    return { id: 'current-session', latestSeq: 7, activity: { run: { state: 'running' } } };
  };
  refresh.context.fetchSessionEvents = async () => {
    eventCalls += 1;
    return [];
  };
  await refresh.context.runCurrentSessionRefresh('current-session');
  assert.equal(stateCalls, 1);
  assert.equal(eventCalls, 0, 'current running projections should be reused when the server cursor is unchanged');

  refresh.context.fetchSessionState = async () => ({
    id: 'current-session',
    latestSeq: 8,
    activity: { run: { state: 'completed' } },
  });
  refresh.context.fetchSessionEvents = async (sessionId, options) => {
    eventCalls += 1;
    assert.equal(sessionId, 'current-session');
    assert.equal(options.runState, 'idle');
    return [];
  };
  await refresh.context.runCurrentSessionRefresh('current-session');
  assert.equal(eventCalls, 1, 'completion must re-enter the canonical event fetch path');
}

{
  const older = createHarness();
  setRenderedSnapshot(older, {
    latestSeq: 100,
    earliestSeq: 51,
    nextBeforeSeq: 51,
    hasMoreBefore: true,
  });
  older.renderedEventState.runState = 'idle';
  const urls = [];
  older.context.fetchJsonOrRedirect = async (url) => {
    urls.push(url);
    return {
      events: [
        { id: 'message-49', seq: 49, type: 'message', role: 'user', content: 'older' },
        { id: 'message-50', seq: 50, type: 'message', role: 'assistant', content: 'reply' },
      ],
      pagination: { oldestSeq: 49, latestSeq: 50, hasMoreBefore: true },
    };
  };
  const events = await older.context.loadOlderSessionEvents();
  assert.deepEqual(events.map((event) => event.id), ['message-49', 'message-50']);
  assert.deepEqual(urls, [
    '/api/sessions/current-session/events?filter=visible&limit=50&direction=before&beforeSeq=51',
  ]);
  assert.equal(older.calls.batch.length, 1);
  assert.equal(older.calls.batch[0].options.historyPrepend, true);
  assert.equal(older.calls.batch[0].options.paginationMode, 'before');
  assert.equal(older.calls.batch[0].options.pagination.nextBeforeSeq, 49);
  assert.equal(older.renderedEventState.loadingOlder, false);
  const olderMetrics = older.context.window.ragentGetEventRefreshMetrics();
  assert.equal(olderMetrics.last.outcome, 'older_applied');
  assert.equal(olderMetrics.last.renderMode, 'prepend');
  assert.equal(olderMetrics.last.renderMs, 7, 'history prepend metrics should measure the durable DOM projection');
}

{
  // A refresh failure with the durable latest page already rendered is a
  // soft failure: it must reject to the caller (so the attach retry owns it)
  // without flipping the working transcript to the unloadable error card.
  const softFail = createHarness();
  setRenderedSnapshot(softFail);
  softFail.messagesInner.appendChild(makeElement());
  let cardCalls = 0;
  const realShowSessionLoadError = softFail.context.showSessionLoadError;
  softFail.context.showSessionLoadError = (...args) => {
    cardCalls += 1;
    return realShowSessionLoadError?.(...args);
  };
  softFail.context.fetchJsonOrRedirect = async () => {
    const error = new Error('gateway unavailable');
    error.status = 503;
    throw error;
  };
  await assert.rejects(
    softFail.context.fetchSessionEvents('current-session', { runState: 'running' }),
    /gateway unavailable/,
    'a failed refresh must still reject so the attach retry path owns recovery',
  );
  assert.equal(cardCalls, 0, 'a refresh failure over a rendered transcript must not show the session-load card');
}

{
  // Without a rendered transcript the same failure stays a hard failure: the
  // error card is the only honest surface for an empty, unloadable session.
  const hardFail = createHarness();
  let cardCalls = 0;
  const realShowSessionLoadError = hardFail.context.showSessionLoadError;
  hardFail.context.showSessionLoadError = (...args) => {
    cardCalls += 1;
    return realShowSessionLoadError?.(...args);
  };
  hardFail.context.fetchJsonOrRedirect = async () => {
    const error = new Error('gateway unavailable');
    error.status = 503;
    throw error;
  };
  await assert.rejects(
    hardFail.context.fetchSessionEvents('current-session', { runState: 'running' }),
    /gateway unavailable/,
  );
  assert.equal(cardCalls, 1, 'an unloadable empty session must surface the retryable error card');
}

assert.doesNotMatch(sessionHttpSource, /getEventRenderPlan|setSessionEventSnapshot|restoreSessionEventSnapshot/);
assert.doesNotMatch(sessionHttpSource, /filterUnrenderedPersistentEvents|renderEvent\(/);
assert.doesNotMatch(sessionHttpSource, /skipDelta/);
assert.doesNotMatch(sessionHttpSource, /previousScrollHeight|viewportLocked|lockMessageViewportAnchor/);

console.log('test-session-http-running-refresh: ok');
