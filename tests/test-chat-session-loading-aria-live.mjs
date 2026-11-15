#!/usr/bin/env node
// Session-loading skeleton screen-reader announcements (P2 aria-live).
// The skeleton itself is aria-hidden (decorative); the loading/loaded states
// are announced through a visually-hidden polite live region. Announcements
// are gated on the skeleton actually appearing (>=150ms delay), so fast
// restores never interrupt a screen reader with a noisy pair.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sessionHttpSource = readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static/chat/session-http-list-state.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');

function makeElement() {
  return {
    dataset: {},
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
      if (this.parentNode?.children) {
        this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      }
      this.parentNode = null;
    },
    addEventListener() {},
    focus() {},
    scrollIntoView() {},
    querySelector(selector) {
      if (selector === '.messages-loading-skeleton') {
        return this.children.find((child) => child.className === selector.slice(1)) || null;
      }
      return null;
    },
    setAttribute(name, value) {
      this.attributes = this.attributes || {};
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes ? this.attributes[name] : null;
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

function createContext({
  shareSnapshotMode = false,
  entryMode = 'resume',
  emulateBrowserReset = false,
} = {}) {
  const metrics = {
    scrollToBottomCalls: 0,
    scrollNodeToTopCalls: 0,
  };
  const messagesInner = makeElement();
  const emptyState = makeElement();
  const messagesEl = {
    dataset: {},
    scrollHeight: 1200,
    scrollTop: 680,
    clientHeight: 400,
    parentNode: makeElement(),
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
    node.offsetTop = Math.max(0, (event.seq - 1) * 600);
    node.getBoundingClientRect = () => {
      const top = node.offsetTop - messagesEl.scrollTop;
      return { top, bottom: top + 500, height: 500 };
    };
    return node;
  }
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
      : [{
        id: 'session_regular',
        name: 'Regular session',
        entryMode,
      }],
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
        displayEvents: [
          { seq: 1, type: 'message', role: 'user', content: 'first' },
          { seq: 2, type: 'message', role: 'assistant', content: 'second' },
        ],
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
      if (emulateBrowserReset) messagesEl.scrollTop = 0;
    },
    showEmpty() {},
    scrollToBottom() {
      metrics.scrollToBottomCalls += 1;
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
    fetch: async () => ({
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
        return {
          events: [
            { seq: 1, type: 'message', role: 'user', content: 'first' },
            { seq: 2, type: 'message', role: 'assistant', content: 'second' },
          ],
        };
      },
    }),
    getEventBoundarySeq(event) {
      return Number.isInteger(event?.seq) ? event.seq : 0;
    },
    getEventRenderBaseKey(event) {
      return `${event?.seq || 0}:${event?.type || 'unknown'}`;
    },
    getEventRenderKey(event) {
      return `${event?.seq || 0}:${event?.type || 'unknown'}`;
    },
    isRunningThinkingBlockEvent() {
      return false;
    },
    renderEvent(event) {
      messagesInner.children.push(makeTimelineNode(event));
    },
    reconcileComposerPendingSendWithEvent() {},
  };

  context.globalThis = context;
  context.self = context;
  context.__metrics = metrics;
  context.messagesHost = messagesEl.parentNode;
  return context;
}

// ---- aria-live announcements for the session-loading skeleton ----

function findLiveRegion(context) {
  return context.messagesHost.children.find((child) => child.className === 'sr-only') || null;
}

// 1) Skeleton show announces the loading state through the hidden live region.
const c1 = createContext({ shareSnapshotMode: false });
vm.runInNewContext(sessionHttpSource, c1, { filename: 'static/chat/session-http.js' });

c1.showSessionLoadingSkeleton();
const live1 = findLiveRegion(c1);
assert.ok(live1, 'a visually-hidden live region should be created when the skeleton shows');
assert.equal(live1.className, 'sr-only', 'the live region should use the sr-only utility class');
assert.equal(live1.getAttribute('role'), 'status', 'the live region should be a status region');
assert.equal(live1.getAttribute('aria-live'), 'polite', 'the live region should be polite');
assert.equal(live1.textContent, 'Loading session…', 'loading announcement should use the fallback text when ragentT is absent');

// 2) A second show is idempotent: no duplicate announcement.
c1.showSessionLoadingSkeleton();
assert.equal(live1.textContent, 'Loading session…', 'duplicate skeleton shows must not re-announce');

// 3) Hide announces completion, then clears the region after the reset window.
c1.hideSessionLoadingSkeleton();
assert.equal(live1.textContent, 'Session loaded', 'hiding the skeleton should announce the loaded state');
await new Promise((resolve) => setTimeout(resolve, 900));
assert.equal(live1.textContent, '', 'the loaded announcement should be cleared after the reset window');

// 4) A second hide must not re-announce.
c1.hideSessionLoadingSkeleton();
assert.equal(live1.textContent, '', 'duplicate hides must not re-announce');

// 5) Fast path: hide without show never announces (skeleton never appeared).
const c2 = createContext({ shareSnapshotMode: false });
vm.runInNewContext(sessionHttpSource, c2, { filename: 'static/chat/session-http.js' });
c2.hideSessionLoadingSkeleton();
assert.equal(findLiveRegion(c2), null, 'no live region should exist when nothing was announced');

// 6) schedule + immediate cancel: no skeleton, no announcement.
const c3 = createContext({ shareSnapshotMode: false });
vm.runInNewContext(sessionHttpSource, c3, { filename: 'static/chat/session-http.js' });
const token3 = c3.scheduleSessionLoadingSkeleton();
c3.cancelSessionLoadingSkeleton(token3);
await new Promise((resolve) => setTimeout(resolve, 250));
assert.equal(findLiveRegion(c3), null, 'a cancelled skeleton should never announce');
assert.equal(
  c3.messagesInner.children.some((child) => child.className === 'messages-loading-skeleton'),
  false,
  'a cancelled skeleton should never appear in the message canvas',
);

// 7) schedule fires after the delay: skeleton appears and announces.
const c4 = createContext({ shareSnapshotMode: false });
vm.runInNewContext(sessionHttpSource, c4, { filename: 'static/chat/session-http.js' });
c4.scheduleSessionLoadingSkeleton();
await new Promise((resolve) => setTimeout(resolve, 250));
assert.ok(
  c4.messagesInner.children.some((child) => child.className === 'messages-loading-skeleton'),
  'the skeleton should appear after the loading delay',
);
const live4 = findLiveRegion(c4);
assert.ok(live4, 'the loading announcement should fire when the skeleton appears');
assert.equal(live4.textContent, 'Loading session…', 'delayed skeleton should announce the loading state');
c4.hideSessionLoadingSkeleton();
assert.equal(live4.textContent, 'Session loaded', 'delayed skeleton should announce completion when hidden');

// 8) i18n path: window.ragentT provides localized strings.
const c5 = createContext({ shareSnapshotMode: false });
c5.window.ragentT = (key) => ({
  'status.loadingSession': '正在加载会话…',
  'status.sessionLoaded': '会话已加载',
}[key] || key);
vm.runInNewContext(sessionHttpSource, c5, { filename: 'static/chat/session-http.js' });
c5.showSessionLoadingSkeleton();
assert.equal(findLiveRegion(c5).textContent, '正在加载会话…', 'loading announcement should use the ragentT value when present');
c5.hideSessionLoadingSkeleton();
assert.equal(findLiveRegion(c5).textContent, '会话已加载', 'loaded announcement should use the ragentT value when present');

console.log('test-chat-session-loading-aria-live: ok');
