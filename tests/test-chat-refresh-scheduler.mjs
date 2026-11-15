#!/usr/bin/env node
// DS-21: unified HTTP refresh scheduler (static/chat/session-http-scheduler.js).
//
// Covers the acceptance matrix on top of the existing foreground throttle and
// delta/paging:
//   - single-flight per resource key (slow network: one in-flight fetch)
//   - rapid invalidation: stronger intent (forceFresh / viewportIntent /
//     supersedes the in-flight request with abort+restart
//   - hidden tab: non-essential refreshes are dropped, essential ones run
//   - session switch: abortSessionRefreshRequests cancels old-session fetches
//   - offline/reconnect: refresh fan-out coalesces onto the in-flight request
//   - abort: cancelled requests resolve null instead of rejecting
//   - stale response: a response landing after its request was superseded is
//     not applied and cannot clobber the successor's registry entry
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const schedulerSource = readFileSync(join(repoRoot, 'static/chat/session-http-scheduler.js'), 'utf8');
const fullSource = schedulerSource
  + '\n'
  + readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8')
  + '\n'
  + readFileSync(join(repoRoot, 'static/chat/session-http-list-state.js'), 'utf8')
  + '\n'
  + readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');

function makeElement() {
  return {
    style: {},
    disabled: false,
    textContent: '',
    innerHTML: '',
    children: [],
    className: '',
    value: '',
    parentNode: null,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
    },
    remove() {
      this.parentNode = null;
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    scrollIntoView() {},
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

function buildSession({ id, name, state = 'idle', status = 'idle', updatedAt, latestSeq = 0 }) {
  return {
    id,
    name,
    status,
    updatedAt,
    latestSeq,
    sourceId: 'chat',
    sourceName: 'Chat',
    activity: {
      run: { state },
      queue: { state: 'idle', count: 0 },
      compact: { state: 'idle' },
    },
  };
}

function makeAbortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

// --- Tier 1: registry unit tests (scheduler module alone) ---

function createSchedulerContext({ hidden = false } = {}) {
  const context = {
    console,
    Map,
    Set,
    JSON,
    Date,
    AbortController,
    AbortSignal,
    DOMException,
    document: {
      visibilityState: hidden ? 'hidden' : 'visible',
    },
  };
  context.window = context;
  context.globalThis = context;
  return context;
}

function schedulerMetrics(context) {
  return context.window.ragentGetRefreshSchedulerMetrics();
}

{
  const context = createSchedulerContext();
  vm.runInNewContext(schedulerSource, context, { filename: 'static/chat/session-http-scheduler.js' });

  // vm-realm objects have a different Object.prototype than host literals, so
  // compare serialized shapes (implementation emits a fixed key order).
  assert.equal(
    JSON.stringify(context.mergeRefreshIntents(
      { forceFresh: false, viewportIntent: 'preserve' },
      { forceFresh: true, viewportIntent: 'session_entry' },
    )),
    JSON.stringify({ forceFresh: true, viewportIntent: 'session_entry', wsPushCaughtUp: false }),
    'intent merge should OR forceFresh and keep the stronger viewport intent',
  );
  assert.equal(
    JSON.stringify(context.mergeRefreshIntents(
      { forceFresh: true, viewportIntent: 'session_entry' },
      { forceFresh: false, viewportIntent: 'session_entry_bottom' },
    )),
    JSON.stringify({ forceFresh: true, viewportIntent: 'session_entry_bottom', wsPushCaughtUp: false }),
    'intent merge should keep session_entry_bottom over session_entry',
  );
  assert.equal(
    JSON.stringify(context.mergeRefreshIntents(
      { forceFresh: false, viewportIntent: 'preserve' },
      { forceFresh: false, viewportIntent: 'preserve' },
    )),
    JSON.stringify({ forceFresh: false, viewportIntent: 'preserve', wsPushCaughtUp: false }),
    'equal transport-independent intents should merge without extra flags',
  );
  assert.equal(
    context.refreshIntentSupersedes(
      { forceFresh: false, viewportIntent: 'preserve', wsPushCaughtUp: true },
      { forceFresh: false, viewportIntent: 'preserve', wsPushCaughtUp: false },
    ),
    true,
    'a ws push catch-up must supersede the in-flight request',
  );
  assert.equal(
    context.refreshIntentSupersedes(
      { forceFresh: true, viewportIntent: 'preserve' },
      { forceFresh: false, viewportIntent: 'preserve' },
    ),
    true,
    'forceFresh should supersede a non-force-fresh in-flight request',
  );
  assert.equal(
    context.refreshIntentSupersedes(
      { forceFresh: false, viewportIntent: 'session_entry' },
      { forceFresh: false, viewportIntent: 'preserve' },
    ),
    true,
    'a stronger viewport intent should supersede a weaker one',
  );
  assert.equal(
    context.refreshIntentSupersedes(
      { forceFresh: false, viewportIntent: 'preserve' },
      { forceFresh: false, viewportIntent: 'preserve' },
    ),
    false,
    'equal-strength intents should coalesce instead of superseding',
  );
}

{
  // Single-flight coalescing: same key + equal intent returns the same promise.
  const context = createSchedulerContext();
  vm.runInNewContext(schedulerSource, context, { filename: 'static/chat/session-http-scheduler.js' });
  let releases = [];
  const run = () => new Promise((resolve) => releases.push(resolve));
  const first = context.scheduleRefreshRequest('session-list', { intent: {}, run });
  const second = context.scheduleRefreshRequest('session-list', { intent: {}, run });
  assert.equal(second, first, 'a same-strength second request should coalesce onto the in-flight promise');
  releases[0]('list-data');
  assert.equal(await first, 'list-data', 'the coalesced promise should resolve with the in-flight result');
  assert.equal(await second, 'list-data', 'both callers should observe the same result');
  const totals = schedulerMetrics(context).totals;
  assert.equal(totals.started, 1, 'metrics should count one started request');
  assert.equal(totals.coalesced, 1, 'metrics should count one coalesced request');
}

{
  // Rapid invalidation: stronger intent supersedes (abort + restart merged).
  const context = createSchedulerContext();
  vm.runInNewContext(schedulerSource, context, { filename: 'static/chat/session-http-scheduler.js' });
  let abortedController = null;
  let releases = [];
  const run = ({ signal }) => {
    if (signal) {
      signal.addEventListener('abort', () => {
        abortedController = signal;
        releases[0]?.();
      }, { once: true });
    }
    return new Promise((resolve, reject) => releases.push((value) => {
      if (signal?.aborted) reject(makeAbortError());
      else resolve(value);
    }));
  };
  const first = context.scheduleRefreshRequest('session-list', { intent: { forceFresh: false }, run });
  const second = context.scheduleRefreshRequest('session-list', {
    intent: { forceFresh: true, viewportIntent: 'session_entry' },
    run,
  });
  assert.notEqual(second, first, 'a stronger intent should supersede instead of coalescing');
  assert.equal(abortedController?.aborted, true, 'the superseded request should have its signal aborted');
  releases[1]('fresh-data');
  assert.equal(await first, null, 'a superseded request should resolve null for its callers');
  assert.equal(await second, 'fresh-data', 'the superseding request should resolve with fresh data');
  const totals = schedulerMetrics(context).totals;
  assert.equal(totals.superseded, 1, 'metrics should count the supersede');
  assert.equal(totals.aborted, 1, 'metrics should count the abort');
}

{
  // Hidden tab: non-essential refreshes dropped, essential ones still run.
  const context = createSchedulerContext({ hidden: true });
  vm.runInNewContext(schedulerSource, context, { filename: 'static/chat/session-http-scheduler.js' });
  let runCount = 0;
  const run = async () => { runCount += 1; return 'data'; };
  assert.equal(
    await context.scheduleRefreshRequest('session-list', { intent: {}, run }),
    null,
    'a hidden-tab non-essential refresh should be dropped',
  );
  assert.equal(runCount, 0, 'the dropped refresh should never start');
  assert.equal(
    await context.scheduleRefreshRequest('session-list', { intent: {}, essential: true, run }),
    'data',
    'a hidden-tab essential refresh should still run',
  );
  assert.equal(runCount, 1, 'only the essential refresh should run');
  const totals = schedulerMetrics(context).totals;
  assert.equal(totals.hiddenDropped, 1, 'metrics should count the hidden-tab drop');
}

{
  // Session switch: abortSessionRefreshRequests cancels in-flight work and
  // resolves it with null; the late successor entry survives.
  const context = createSchedulerContext();
  vm.runInNewContext(schedulerSource, context, { filename: 'static/chat/session-http-scheduler.js' });
  let releases = [];
  let aborts = [];
  const run = ({ signal }) => {
    if (signal) {
      signal.addEventListener('abort', () => aborts.push(signal), { once: true });
    }
    return new Promise((resolve, reject) => releases.push((value) => {
      if (signal?.aborted) reject(makeAbortError());
      else resolve(value);
    }));
  };
  const current = context.scheduleRefreshRequest('session:old-a:current', { intent: {}, run });
  const sidebar = context.scheduleRefreshRequest('session:old-a:sidebar', { intent: {}, run });
  const other = context.scheduleRefreshRequest('session:other-b:current', { intent: {}, run });
  assert.equal(context.abortSessionRefreshRequests('old-a'), 2, 'the switch should abort both old-session requests');
  assert.equal(aborts.length, 2, 'both old-session controllers should abort');
  assert.equal(aborts[0].aborted, true, 'the current-session controller should be aborted');
  releases[0]();
  releases[1]();
  assert.equal(await current, null, 'the aborted current-session request should resolve null');
  assert.equal(await sidebar, null, 'the aborted sidebar request should resolve null');
  releases[2]('other-data');
  assert.equal(await other, 'other-data', 'unrelated sessions should be unaffected');
  const totals = schedulerMetrics(context).totals;
  assert.equal(totals.switchAborted, 2, 'metrics should count the switch aborts');
}

{
  // Stale response: a superseded request finishing late must not remove its
  // successor's registry entry, and a freshly issued request must start a new
  // run instead of coalescing onto the lingering entry.
  const context = createSchedulerContext();
  vm.runInNewContext(schedulerSource, context, { filename: 'static/chat/session-http-scheduler.js' });
  let releases = [];
  const run = () => new Promise((resolve) => releases.push(resolve));
  const stale = context.scheduleRefreshRequest('session-list', { intent: {}, run });
  const fresh = context.scheduleRefreshRequest('session-list', { intent: { forceFresh: true }, run });
  releases[1]('fresh-data');
  assert.equal(await fresh, 'fresh-data', 'the superseding request should complete normally');
  releases[0]('stale-data');
  assert.equal(await stale, 'stale-data', 'a fetch that ignored the abort still resolves its own caller');
  const third = context.scheduleRefreshRequest('session-list', { intent: {}, run });
  assert.notEqual(third, stale, 'the late completion must not leave a lingering registry entry to coalesce onto');
  releases[2]('third-data');
  assert.equal(await third, 'third-data', 'a request after the late completion should start fresh');
}

// --- Tier 2: integration with session-http.js wiring ---

function createIntegrationContext({ hidden = false, ignoreAbortOnFirstFetch = false } = {}) {
  const fetchCalls = [];
  const pendingFetches = [];
  let timelineSnapshot = null;
  const timelineRuntime = {
    getSnapshot() {
      return timelineSnapshot;
    },
    renderBatch(events, options = {}) {
      const list = Array.isArray(events) ? events : [];
      timelineSnapshot = {
        sessionId: options.sessionId || '',
        items: list.map((event) => ({ id: `${event.type || 'event'}:${event.seq || 0}` })),
        latestSeq: Number.isInteger(options.latestSeq)
          ? options.latestSeq
          : (Number.isInteger(options.pagination?.latestSeq) ? options.pagination.latestSeq : 0),
        earliestSeq: list[0]?.seq || 0,
        nextBeforeSeq: options.pagination?.nextBeforeSeq ?? null,
        hasMoreBefore: options.pagination?.hasMoreBefore === true,
      };
      return timelineSnapshot;
    },
    renderIncremental(events, options = {}) {
      return this.renderBatch(events, options);
    },
  };
  const sessions = [
    buildSession({
      id: 'current-session',
      name: 'Current session',
      state: 'idle',
      status: 'idle',
      updatedAt: '2026-03-12T09:00:00.000Z',
      latestSeq: 1,
    }),
  ];
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
    AbortController,
    AbortSignal,
    DOMException,
    fetchCalls,
    pendingFetches,
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
      RagentTimelineRuntime: timelineRuntime,
      focus() {},
      addEventListener() {},
      crypto: {
        randomUUID() {
          return 'req_test';
        },
      },
    },
    document: {
      visibilityState: hidden ? 'hidden' : 'visible',
      addEventListener() {},
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
    currentSessionId: 'current-session',
    hasAttachedSession: true,
    hasLoadedSessions: true,
    archivedSessionCount: 0,
    archivedSessionsLoaded: false,
    archivedSessionsLoading: false,
    sessions,
    jsonResponseCache: new Map(),
    renderedEventState: {
      sessionId: null,
      latestSeq: 0,
      eventCount: 0,
      eventBaseKeys: [],
      eventKeys: [],
      runState: 'idle',
      runningBlockExpanded: false,
      loadingOlder: false,
      hasMoreBefore: false,
      earliestSeq: 0,
    },
    emptyState: makeElement(),
    inputArea: makeElement(),
    messagesInner: makeElement(),
    messagesEl: {
      scrollHeight: 0,
      scrollTop: 0,
      clientHeight: 0,
      addEventListener() {},
    },
    contextTokens: makeElement(),
    compactBtn: makeElement(),
    dropToolsBtn: makeElement(),
    resumeBtn: makeElement(),
    headerTitle: makeElement(),
    inlineToolSelect: makeElement(),
    toolsList: [],
    selectedTool: '',
    sortSessionsInPlace() {
      context.sessions.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    },
    refreshAppCatalog() {},
    renderSessionList() {},
    restoreDraft() {},
    updateStatus() {},
    renderQueuedMessagePanel() {},
    updateResumeButton() {},
    syncBrowserState() {},
    syncForkButton() {},
    syncShareButton() {},
    syncLiveMessageMetadataForRunState() {},
    syncEditableMessageActions() {},
    loadModelsForCurrentTool() {},
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
    clearMessages() {
      context.messagesInner.children = [];
      context.emptyState.parentNode = null;
    },
    showEmpty() {
      context.emptyState.parentNode = context.messagesInner;
    },
    scrollToBottom() {},
    reconcilePendingMessageState() {},
    applyFinishedTurnCollapseState() {
      return null;
    },
    scrollNodeToTop() {},
    checkPendingMessage() {},
    getPendingMessage() {
      return null;
    },
    clearPendingMessage() {},
    persistActiveSessionId() {},
    switchTab() {},
    applyNavigationState() {},
    resolveRestoreTargetSession() {
      return null;
    },
    attachSession() {},
    getRenderedOlderPageAnchor() {
      return null;
    },
    captureMessageViewportAnchor() {
      return null;
    },
    fetch: (url, options = {}) => {
      const call = { url: String(url), options, aborted: false };
      fetchCalls.push(call);
      const signal = options.signal || null;
      if (signal?.aborted) {
        return Promise.reject(makeAbortError());
      }
      return new Promise((resolve, reject) => {
        const entry = {
          call,
          signal,
          resolve,
          reject,
          ignoreAbort: ignoreAbortOnFirstFetch && fetchCalls.length === 1,
        };
        if (signal && !entry.ignoreAbort) {
          signal.addEventListener('abort', () => {
            call.aborted = true;
            const pendingIndex = pendingFetches.indexOf(entry);
            if (pendingIndex !== -1) pendingFetches.splice(pendingIndex, 1);
            reject(makeAbortError());
          }, { once: true });
        }
        pendingFetches.push(entry);
      });
    },
  };
  context.settleNextFetch = (body, { url = null } = {}) => {
    const entry = pendingFetches.shift();
    assert.ok(entry, 'expected a pending fetch to settle');
    entry.resolve(createFetchResponse(body, { url: url || entry.call.url }));
    return entry;
  };
  context.settleLastFetch = (body) => {
    const entry = pendingFetches.pop();
    assert.ok(entry, 'expected a pending fetch to settle');
    entry.resolve(createFetchResponse(body, { url: entry.call.url }));
    return entry;
  };
  context.settleFetchByUrl = (urlPrefix, body) => {
    const index = pendingFetches.findIndex((entry) => entry.call.url.startsWith(urlPrefix));
    assert.notEqual(index, -1, `expected a pending fetch matching ${urlPrefix}`);
    const [entry] = pendingFetches.splice(index, 1);
    entry.resolve(createFetchResponse(body, { url: entry.call.url }));
    return entry;
  };
  context.assertPendingCount = (expected, message) => {
    assert.equal(pendingFetches.length, expected, message);
  };
  // Settling a fetch only queues the vm-side continuation (the next fetch in
  // the run's chain) on microtasks; flush them before settling the next one.
  context.flushTicks = () => new Promise((resolve) => setTimeout(resolve, 0));
  context.globalThis = context;
  context.self = context;
  return context;
}

function createFetchResponse(body, { status = 200, etag = '"etag-refresh-scheduler"', url = 'http://127.0.0.1/' } = {}) {
  const headers = new Map([
    ['content-type', 'application/json; charset=utf-8'],
    ['etag', etag],
  ]);
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected: false,
    url,
    headers: {
      get(name) {
        return headers.get(String(name).toLowerCase()) || null;
      },
    },
    async json() {
      return body;
    },
  };
}

function makeListResponse(entries, archivedCount = 0) {
  return { sessions: entries, archivedCount };
}

function makeSessionResponse(session) {
  return { session };
}

function makeEventsResponse() {
  return { events: [], pagination: { hasMoreBefore: false } };
}

function runFullSource(context) {
  vm.runInNewContext(fullSource, context, { filename: 'static/chat/session-http.js' });
}

{
  // Slow network: two fetchSessionsList calls → one HTTP request, one result.
  const context = createIntegrationContext();
  runFullSource(context);
  const first = context.fetchSessionsList();
  const second = context.fetchSessionsList();
  context.assertPendingCount(1, 'a slow list refresh should keep exactly one in-flight request');
  assert.equal(context.fetchCalls.length, 1, 'rapid duplicate list refreshes should not duplicate the HTTP call');
  context.settleNextFetch(makeListResponse([buildSession({ id: 'current-session', name: 'Current', updatedAt: '2026-03-12T10:00:00.000Z' })]));
  const firstResult = await first;
  const secondResult = await second;
  // Values originate in the vm realm (session-http transforms them), so compare
  // serialized/primitive shapes instead of host-literal deep equality.
  assert.equal(
    JSON.stringify(firstResult.map((session) => session.id)),
    JSON.stringify(['current-session']),
    'the coalesced list refresh should apply the fetched state',
  );
  assert.equal(secondResult, firstResult, 'both callers should observe the same result');
  assert.equal(schedulerMetrics(context).totals.coalesced, 1, 'metrics should count the coalesce');
}

{
  // Rapid invalidation: force-fresh supersedes an in-flight stale list fetch,
  // aborts it, and refetches with no-store.
  const context = createIntegrationContext();
  runFullSource(context);
  const stale = context.fetchSessionsList();
  context.assertPendingCount(1, 'first list refresh should be in flight');
  const fresh = context.fetchSessionsList({ forceFresh: true });
  context.assertPendingCount(1, 'the superseding refresh should keep one in-flight request');
  assert.equal(context.fetchCalls.length, 2, 'supersede should abort the old fetch and start a new one');
  assert.equal(context.fetchCalls[0].aborted, true, 'the superseded fetch should be aborted');
  assert.equal(context.fetchCalls[1].options.cache, 'no-store', 'the superseding fetch should bypass the cache');
  context.settleNextFetch(makeListResponse([buildSession({ id: 'current-session', name: 'Fresh', updatedAt: '2026-03-12T10:05:00.000Z' })]));
  assert.equal(await stale, null, 'the superseded caller should resolve null (no stale apply)');
  const freshResult = await fresh;
  assert.equal(freshResult[0].name, 'Fresh', 'the superseding caller should resolve the fresh state');
  const totals = schedulerMetrics(context).totals;
  assert.equal(totals.superseded, 1, 'metrics should count the supersede');
}

{
  // Hidden tab: WS-driven (non-essential) refreshes stop; essential boot
  // refreshes still run.
  const context = createIntegrationContext({ hidden: true });
  runFullSource(context);
  assert.equal(await context.fetchSessionsList(), null, 'hidden-tab list refresh should be dropped');
  assert.equal(context.fetchCalls.length, 0, 'no HTTP should leave a hidden tab for non-essential refresh');
  const essential = context.fetchSessionsList({ essential: true });
  context.assertPendingCount(1, 'essential boot refreshes should still run while hidden');
  context.settleNextFetch(makeListResponse([]));
  assert.equal((await essential).length, 0, 'essential refresh should apply its result');
  assert.equal(schedulerMetrics(context).totals.hiddenDropped, 1, 'metrics should count the hidden-tab drop');
}

{
  // An essential attach must not be aborted by a stronger background
  // invalidation while the selected transcript is being loaded.
  const context = createIntegrationContext();
  runFullSource(context);
  let resolveAttach = null;
  let attachAborted = false;
  const attach = context.scheduleRefreshRequest('session:attach:current', {
    intent: { viewportIntent: 'session_entry_bottom' },
    essential: true,
    run: ({ signal }) => new Promise((resolve) => {
      resolveAttach = resolve;
      signal?.addEventListener('abort', () => { attachAborted = true; });
    }),
  });
  const background = context.scheduleRefreshRequest('session:attach:current', {
    intent: { forceFresh: true },
    run: () => 'background-replacement',
  });
  assert.equal(background, attach, 'background invalidation should coalesce onto essential attach');
  assert.equal(attachAborted, false, 'background invalidation must not abort essential attach');
  resolveAttach('attach-complete');
  assert.equal(await attach, 'attach-complete');
  assert.equal(await background, 'attach-complete');
}

{
  // Essential preemption: an essential user interaction preempts and aborts
  // an in-flight non-essential background fetch instead of coalescing onto it.
  const context = createIntegrationContext();
  runFullSource(context);
  let backgroundAborted = false;
  let resolveBackground = null;
  const background = context.scheduleRefreshRequest('session:test:current', {
    intent: { viewportIntent: 'preserve' },
    essential: false,
    run: ({ signal }) => new Promise((resolve, reject) => {
      resolveBackground = resolve;
      signal?.addEventListener('abort', () => {
        backgroundAborted = true;
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  let resolveEssential = null;
  const essential = context.scheduleRefreshRequest('session:test:current', {
    intent: { viewportIntent: 'preserve' },
    essential: true,
    run: ({ signal }) => new Promise((resolve) => {
      resolveEssential = resolve;
    }),
  });
  assert.notEqual(essential, background, 'essential request must not coalesce onto non-essential background request');
  assert.equal(backgroundAborted, true, 'essential request must abort the in-flight non-essential request');
  resolveEssential('essential-result');
  assert.equal(await essential, 'essential-result');
  assert.equal(await background, null, 'aborted background request resolves null');
}

{
  // Session switch: an in-flight current-session refresh is aborted and
  // resolves null; a new session's refresh is unaffected.
  const context = createIntegrationContext();
  runFullSource(context);
  const switchingAway = context.refreshCurrentSession();
  context.assertPendingCount(1, 'the current-session state refresh should be in flight');
  // The outer current refresh and its nested state refresh both belong to the
  // old session's key prefix, so the switch aborts both.
  assert.equal(context.abortSessionRefreshRequests('current-session'), 2, 'the switch should abort every in-flight old-session request');
  context.assertPendingCount(0, 'the aborted fetch should be released immediately');
  assert.equal(await switchingAway, null, 'the switched-away refresh should resolve null');
  context.currentSessionId = 'session-b';
  const next = context.refreshCurrentSession();
  context.assertPendingCount(1, 'the new session refresh should start cleanly');
  context.settleFetchByUrl('/api/sessions/session-b', makeSessionResponse(buildSession({ id: 'session-b', name: 'Session B', updatedAt: '2026-03-12T11:00:00.000Z' })));
  await context.flushTicks();
  context.settleFetchByUrl('/api/sessions/session-b/events', makeEventsResponse());
  assert.equal((await next)?.id, 'session-b', 'the new session refresh should complete normally');
  const totals = schedulerMetrics(context).totals;
  assert.equal(totals.switchAborted, 2, 'metrics should count both old-session entries aborted on switch');
}

{
  // Offline/reconnect: the reconnect fan-out coalesces onto the in-flight
  // list refresh instead of duplicating it.
  const context = createIntegrationContext();
  runFullSource(context);
  const list = context.fetchSessionsList();
  context.assertPendingCount(1, 'the list refresh should be in flight');
  const reconnect = context.refreshRealtimeViews({ viewportIntent: 'preserve' });
  context.assertPendingCount(1, 'reconnect should not stack a second list fetch');
  assert.equal(context.fetchCalls.filter((call) => call.url === '/api/sessions').length, 1, 'exactly one /api/sessions request');
  context.settleFetchByUrl('/api/sessions', makeListResponse([
    buildSession({ id: 'current-session', name: 'Current', updatedAt: '2026-03-12T10:10:00.000Z' }),
  ]));
  await context.flushTicks();
  context.settleFetchByUrl('/api/sessions/current-session', makeSessionResponse(buildSession({ id: 'current-session', name: 'Current', updatedAt: '2026-03-12T10:10:00.000Z' })));
  await context.flushTicks();
  context.settleFetchByUrl('/api/sessions/current-session/events', makeEventsResponse());
  assert.equal(await reconnect, undefined, 'refreshRealtimeViews should complete as a fan-out coordinator');
  assert.equal((await list)[0].name, 'Current', 'the coalesced list result should be shared with the original caller');
  assert.equal(schedulerMetrics(context).totals.coalesced, 1, 'reconnect should count as a coalesced refresh');
}

{
  // Stale response: a P2P-style fetch that ignores the abort signal lands
  // after its successor applied — the stale snapshot must not be applied and
  // the registry must stay clean for the next request.
  const context = createIntegrationContext({ ignoreAbortOnFirstFetch: true });
  runFullSource(context);
  const stale = context.fetchSessionsList();
  const fresh = context.fetchSessionsList({ forceFresh: true });
  assert.equal(context.fetchCalls[0].aborted, false, 'a P2P-leg fetch may ignore the abort signal');
  // The fresh (latest) request is the superseding entry; resolve it first.
  context.settleLastFetch(makeListResponse([
    buildSession({ id: 'current-session', name: 'Fresh data', updatedAt: '2026-03-12T10:20:00.000Z' }),
  ]));
  const freshResult = await fresh;
  assert.equal(freshResult[0].name, 'Fresh data', 'the fresh response should apply');
  // The superseded fetch ignores the abort and lands late with stale data.
  context.settleNextFetch(makeListResponse([
    buildSession({ id: 'current-session', name: 'Stale data', updatedAt: '2026-03-12T09:00:00.000Z' }),
  ]));
  assert.equal(await stale, null, 'a superseded request must not apply its stale snapshot');
  const currentName = context.sessions.find((session) => session.id === 'current-session')?.name;
  assert.equal(currentName, 'Fresh data', 'the stale snapshot must not overwrite fresh state');
  const third = context.fetchSessionsList({ forceFresh: true });
  context.assertPendingCount(1, 'a request after the late stale completion should start fresh');
  context.settleNextFetch(makeListResponse([
    buildSession({ id: 'current-session', name: 'Current', updatedAt: '2026-03-12T10:30:00.000Z' }),
  ]));
  assert.equal((await third)[0].name, 'Current', 'the third request should run its own fetch');
  const totals = schedulerMetrics(context).totals;
  assert.equal(totals.superseded, 1, 'metrics should count the supersede for the stale case');
  // The ignored-abort fetch completed normally (no AbortError), so the registry
  // does not count an abort — the stale guard inside fetchSessionsList rejects
  // the late snapshot instead.
  assert.equal(totals.aborted, 0, 'an ignored-abort fetch is stopped by the stale guard, not the registry');
}

// --- Tier 3: source wiring assertions ---

{
  // Session switch hooks into the real attachSession entry point.
  const sessionListUiSource = readFileSync(join(repoRoot, 'static/chat/session-list-ui.js'), 'utf8');
  const attachMarker = 'function attachSession';
  const attachStart = sessionListUiSource.indexOf(attachMarker);
  assert.notEqual(attachStart, -1, 'session-list-ui should define attachSession');
  const attachEnd = sessionListUiSource.indexOf('\nfunction ', attachStart + attachMarker.length);
  const attachSource = attachEnd === -1
    ? sessionListUiSource.slice(attachStart)
    : sessionListUiSource.slice(attachStart, attachEnd);
  assert.equal(
    attachSource.includes('abortSessionRefreshRequests(previousSessionId)'),
    true,
    'attachSession should abort old-session refresh requests on switch',
  );
}

{
  // The scheduler module is registered in both load paths.
  const chatHtml = readFileSync(join(repoRoot, 'templates/chat.html'), 'utf8');
  assert.equal(
    chatHtml.includes('<script src="chat/session-http-scheduler.js?v={{ASSET_VERSION}}"'),
    true,
    'chat.html should load the scheduler before the refresh modules',
  );
  assert.ok(
    chatHtml.indexOf('chat/session-http-scheduler.js') < chatHtml.indexOf('chat/session-http-helpers.js'),
    'the scheduler should load before session-http-helpers.js',
  );
  const chatLoader = readFileSync(join(repoRoot, 'static/chat.js'), 'utf8');
  assert.equal(
    chatLoader.includes('"chat/session-http-scheduler.js"'),
    true,
    'the compatibility loader should include the scheduler asset',
  );
}

console.log('test-chat-refresh-scheduler: ok');
