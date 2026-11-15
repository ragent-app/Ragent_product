#!/usr/bin/env node
// tests/test-chat-refresh-policy-core.mjs
//
// Stage 2: refresh-policy core (static/chat/transport/refresh-policy.js) is a
// DOM-free port of session-http.js's viewport-intent normalization / option
// merging, staleness checks, payload-size estimation and foreground
// should-refresh decisions. Every scenario runs against BOTH implementations
// with identical injected ambient shell state and compares primitive-level
// outputs, so the port cannot drift from the legacy policy.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const AMBIENT_SHAPE = `
  const renderedEventState = {
    sessionId: null,
    earliestSeq: 0,
    latestSeq: 0,
    eventCount: 0,
    eventBaseKeys: [],
    eventKeys: [],
    runState: "idle",
    runActivity: null,
    operationNodesById: new Map(),
    operationSnapshotsById: new Map(),
    expandedOperationIds: new Set(),
    runningBlockExpanded: false,
    hasMoreBefore: false,
    loadingOlder: false,
  };
  let currentSessionId = "";
  let visitorSessionId = "";
  let visitorMode = false;
  let shareSnapshotMode = false;
  let hasLoadedSessions = false;
  let archivedSessionsLoaded = false;
  let hasAttachedSession = false;
  let pendingNavigationState = null;
  let document;
  const emptyState = { parentNode: null };
  const messagesInner = {};
  emptyState.parentNode = messagesInner;
  const messagesEl = { addEventListener() {} };
  __setRendered = (patch) => Object.assign(renderedEventState, patch);
`;

function loadLegacy() {
  const context = {
    console,
    Promise,
    Map,
    Set,
    Date,
    Error,
    URL,
    URLSearchParams,
    encodeURIComponent,
    AbortController,
    TextEncoder,
    navigator: {},
    window: {},
    localStorage: { getItem: (key) => (key === 'archivedCollapsed' ? 'false' : null) },
  };
  vm.runInNewContext(AMBIENT_SHAPE, context);
  vm.runInNewContext(
    `window.RagentTimelineRuntime = {
      getSnapshot: () => ({
        sessionId: renderedEventState.sessionId,
        items: Array.from({ length: Number(renderedEventState.eventCount) || 0 }, () => null),
      }),
    };`,
    context,
  );
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8'),
    context,
    { filename: 'session-http-helpers.js' },
  );
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8'),
    context,
    { filename: 'session-http.js' },
  );
  // Setter injected AFTER the legacy files so it can reach bindings they
  // declare (last*RefreshAt, findClientSessionRecord as a global property).
  // Per-field writes: Object.assign({ ...bindings }, patch) would only mutate
  // a temporary object and silently no-op the whole ambient update.
  vm.runInNewContext(
    `__setAmbient = (patch) => {
      if ("currentSessionId" in patch) currentSessionId = patch.currentSessionId;
      if ("visitorSessionId" in patch) visitorSessionId = patch.visitorSessionId;
      if ("visitorMode" in patch) visitorMode = patch.visitorMode;
      if ("shareSnapshotMode" in patch) shareSnapshotMode = patch.shareSnapshotMode;
      if ("hasLoadedSessions" in patch) hasLoadedSessions = patch.hasLoadedSessions;
      if ("archivedSessionsLoaded" in patch) archivedSessionsLoaded = patch.archivedSessionsLoaded;
      if ("hasAttachedSession" in patch) hasAttachedSession = patch.hasAttachedSession;
      if ("pendingNavigationState" in patch) pendingNavigationState = patch.pendingNavigationState;
      if ("document" in patch) document = patch.document;
      if ("lastSessionsListRefreshAt" in patch) lastSessionsListRefreshAt = patch.lastSessionsListRefreshAt;
      if ("lastArchivedSessionsRefreshAt" in patch) lastArchivedSessionsRefreshAt = patch.lastArchivedSessionsRefreshAt;
      if ("lastCurrentSessionRefreshAt" in patch) lastCurrentSessionRefreshAt = patch.lastCurrentSessionRefreshAt;
      if ("lastCurrentSessionRefreshSessionId" in patch) lastCurrentSessionRefreshSessionId = patch.lastCurrentSessionRefreshSessionId;
      if ("findClientSessionRecord" in patch) globalThis.findClientSessionRecord = patch.findClientSessionRecord;
      // Function-declaration bindings are reached through the global object;
      // the boolean test flags wrap them in thunks.
      if ("isArchiveSectionExpanded" in patch) globalThis.isArchiveSectionExpanded = () => patch.isArchiveSectionExpanded === true;
      // isTabHidden has no legacy binding: the legacy policy reads the page
      // visibility through the document global instead.
      if ("isTabHidden" in patch) document = { visibilityState: patch.isTabHidden === true ? "hidden" : "visible" };
    };`,
    context,
  );
  return {
    api: {
      normalizeSessionViewportIntent: (v) => context.normalizeSessionViewportIntent(v),
      mergeSessionRefreshOptions: (a, b) => context.mergeSessionRefreshOptions(a, b),
      isRefreshStale: (at, ms) => context.isRefreshStale(at, ms),
      estimatePayloadBytes: (p) => context.estimatePayloadBytes(p),
      canQueueForegroundRefresh: () => context.canQueueForegroundRefresh(),
      shouldRefreshForegroundSessionList: (o) => context.shouldRefreshForegroundSessionList(o),
      shouldRefreshForegroundArchivedSessions: (o) => context.shouldRefreshForegroundArchivedSessions(o),
      shouldRefreshForegroundCurrentSession: (o) => context.shouldRefreshForegroundCurrentSession(o),
    },
    setAmbient: (patch) => context.__setAmbient(patch),
    setRendered: (patch) => context.__setRendered(patch),
    label: 'legacy',
  };
}

function loadCore() {
  const context = {
    console,
    Promise,
    Map,
    Set,
    Date,
    Error,
    URL,
    URLSearchParams,
    encodeURIComponent,
    AbortController,
    TextEncoder,
  };
  vm.runInNewContext(AMBIENT_SHAPE, context);
  const env = {
    currentSessionId: '',
    visitorSessionId: '',
    visitorMode: false,
    hasLoadedSessions: false,
    archivedSessionsLoaded: false,
    hasAttachedSession: false,
    pendingNavigationState: null,
    isShareSnapshotMode: false,
    hasPageContext: false,
    isTabHidden: () => false,
    isArchiveSectionExpanded: () => false,
    findClientSessionRecord: null,
    lastSessionsListRefreshAt: 0,
    lastArchivedSessionsRefreshAt: 0,
    lastCurrentSessionRefreshAt: 0,
    lastCurrentSessionRefreshSessionId: '',
    getTimelineRuntimeSnapshot: null,
  };
  context.RagentRefreshPolicyEnvironment = env;
  vm.runInNewContext(
    'RagentRefreshPolicyEnvironment.renderedEventState = renderedEventState;',
    context,
  );
  vm.runInNewContext(
    `RagentRefreshPolicyEnvironment.getTimelineRuntimeSnapshot = (sessionId) => {
      if (renderedEventState.sessionId !== sessionId) return null;
      return {
        sessionId,
        items: Array.from({ length: Number(renderedEventState.eventCount) || 0 }, () => null),
      };
    };`,
    context,
  );
  // The environment is a live object: the module's Proxy reads it on every
  // access, so setAmbient can mutate the fields directly.
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/refresh-policy.js'), 'utf8'),
    context,
    { filename: 'transport/refresh-policy.js' },
  );
  const core = context.RagentRefreshPolicyCore;
  return {
    api: {
      normalizeSessionViewportIntent: (v) => core.normalizeSessionViewportIntent(v),
      mergeSessionRefreshOptions: (a, b) => core.mergeSessionRefreshOptions(a, b),
      isRefreshStale: (at, ms) => core.isRefreshStale(at, ms),
      estimatePayloadBytes: (p) => core.estimatePayloadBytes(p),
      canQueueForegroundRefresh: () => core.canQueueForegroundRefresh(),
      shouldRefreshForegroundSessionList: (o) => core.shouldRefreshForegroundSessionList(o),
      shouldRefreshForegroundArchivedSessions: (o) => core.shouldRefreshForegroundArchivedSessions(o),
      shouldRefreshForegroundCurrentSession: (o) => core.shouldRefreshForegroundCurrentSession(o),
    },
    setAmbient(patch) {
      for (const key of Object.keys(patch)) {
        if (key === 'document') continue; // legacy-only global, no env counterpart
        if (key === 'shareSnapshotMode') { // legacy binding name vs env field name
          env.isShareSnapshotMode = patch.shareSnapshotMode === true;
          continue;
        }
        if (key === 'isTabHidden' || key === 'isArchiveSectionExpanded') {
          env[key] = () => patch[key] === true;
          continue;
        }
        if (key in env) env[key] = patch[key];
      }
    },
    setRendered: (patch) => context.__setRendered(patch),
    label: 'transport',
  };
}

const now = Date.now();

function resetAmbient(impl) {
  impl.setAmbient({
    currentSessionId: 's1',
    visitorSessionId: '',
    visitorMode: false,
    shareSnapshotMode: false,
    hasLoadedSessions: true,
    archivedSessionsLoaded: true,
    hasAttachedSession: true,
    pendingNavigationState: null,
    // Matches the legacy default under the test localStorage
    // ('archivedCollapsed' === 'false' means the archive section is expanded).
    isArchiveSectionExpanded: true,
    lastSessionsListRefreshAt: now,
    lastArchivedSessionsRefreshAt: now,
    lastCurrentSessionRefreshAt: now,
    lastCurrentSessionRefreshSessionId: 's1',
    findClientSessionRecord: (id) => (id === 's1' ? { id, activity: { run: { state: 'idle' } } } : null),
  });
  impl.setRendered({ sessionId: 's1', eventCount: 3, latestSeq: 5, runState: 'idle' });
}

async function runScenario(impl) {
  const out = {};

  // 1. Pure intent normalization / option merge.
  out.intents = [
    impl.api.normalizeSessionViewportIntent('session_entry_bottom'),
    impl.api.normalizeSessionViewportIntent('session_entry'),
    impl.api.normalizeSessionViewportIntent('preserve'),
    impl.api.normalizeSessionViewportIntent(''),
    impl.api.normalizeSessionViewportIntent(undefined),
    impl.api.normalizeSessionViewportIntent('  session_entry  '),
    impl.api.mergeSessionRefreshOptions({ forceFresh: true, viewportIntent: 'preserve' }, { viewportIntent: 'session_entry', wsPushCaughtUp: true }),
    impl.api.mergeSessionRefreshOptions({ viewportIntent: 'session_entry' }, { viewportIntent: 'session_entry_bottom' }),
    impl.api.mergeSessionRefreshOptions({}, {}),
  ];

  // 2. Staleness.
  out.stale = [
    impl.api.isRefreshStale(0, 15000),
    impl.api.isRefreshStale(-5, 15000),
    impl.api.isRefreshStale(NaN, 15000),
    impl.api.isRefreshStale(now - 20000, 15000),
    impl.api.isRefreshStale(now - 5000, 15000),
  ];

  // 3. Payload estimation.
  out.payload = [
    impl.api.estimatePayloadBytes({ a: 1, b: 'x' }),
    impl.api.estimatePayloadBytes('short'),
    impl.api.estimatePayloadBytes(null),
    (() => {
      const circular = {};
      circular.self = circular;
      try {
        return impl.api.estimatePayloadBytes(circular);
      } catch (error) {
        return `threw:${error.message}`;
      }
    })(),
  ];

  // 4. Foreground queue gate across ambient combos.
  resetAmbient(impl);
  impl.setAmbient({ hasPageContext: true, document: { visibilityState: 'visible' } });
  out.queue = [
    impl.api.canQueueForegroundRefresh(),                       // default: true
  ];
  impl.setAmbient({ shareSnapshotMode: true });
  out.queue.push(impl.api.canQueueForegroundRefresh());         // share mode: false
  impl.setAmbient({ shareSnapshotMode: false, isTabHidden: true });
  out.queue.push(impl.api.canQueueForegroundRefresh());         // hidden: false
  impl.setAmbient({ isTabHidden: false, visitorMode: true, currentSessionId: 's1' });
  out.queue.push(impl.api.canQueueForegroundRefresh());         // visitor + session: true
  impl.setAmbient({ visitorMode: true, currentSessionId: '' });
  out.queue.push(impl.api.canQueueForegroundRefresh());         // visitor, no session: false
  impl.setAmbient({ hasPageContext: false });
  out.queue.push(impl.api.canQueueForegroundRefresh());         // no page context: false

  // 5. Session list refresh decision.
  resetAmbient(impl);
  impl.setAmbient({ hasPageContext: true, document: { visibilityState: 'visible' } });
  out.sessionList = [
    impl.api.shouldRefreshForegroundSessionList({ forceFresh: true }),   // fresh
    impl.api.shouldRefreshForegroundSessionList({}),                     // fresh timestamps: false
  ];
  impl.setAmbient({ lastSessionsListRefreshAt: now - 20000 });
  out.sessionList.push(impl.api.shouldRefreshForegroundSessionList({})); // stale: true
  impl.setAmbient({ lastSessionsListRefreshAt: now, pendingNavigationState: { seq: 1 } });
  out.sessionList.push(impl.api.shouldRefreshForegroundSessionList({})); // navigation pending: true
  impl.setAmbient({ pendingNavigationState: null, hasLoadedSessions: false });
  out.sessionList.push(impl.api.shouldRefreshForegroundSessionList({})); // not loaded: true
  impl.setAmbient({ hasLoadedSessions: true, findClientSessionRecord: (id) => null });
  out.sessionList.push(impl.api.shouldRefreshForegroundSessionList({})); // current session missing: true
  impl.setAmbient({ findClientSessionRecord: (id) => (id === 's1' ? {} : null) });
  out.sessionList.push(impl.api.shouldRefreshForegroundSessionList({})); // present + fresh: false

  // 6. Archived list refresh decision.
  resetAmbient(impl);
  out.archived = [
    impl.api.shouldRefreshForegroundArchivedSessions({}),                 // loaded + expanded + fresh: false
    impl.api.shouldRefreshForegroundArchivedSessions({ forceFresh: true }), // force: true
    impl.api.shouldRefreshForegroundArchivedSessions({ refreshedSessionsList: true }), // true
    impl.api.shouldRefreshForegroundArchivedSessions({ forceFresh: false, refreshedSessionsList: false }), // false
  ];
  impl.setAmbient({ lastArchivedSessionsRefreshAt: now - 20000 });
  out.archived.push(impl.api.shouldRefreshForegroundArchivedSessions({})); // stale: true
  impl.setAmbient({ isArchiveSectionExpanded: false });
  out.archived.push(impl.api.shouldRefreshForegroundArchivedSessions({ forceFresh: true })); // collapsed gates even force: false
  impl.setAmbient({ isArchiveSectionExpanded: true, archivedSessionsLoaded: false });
  out.archived.push(impl.api.shouldRefreshForegroundArchivedSessions({ forceFresh: true })); // never loaded: false

  // 7. Current session refresh decision.
  resetAmbient(impl);
  out.current = [
    impl.api.shouldRefreshForegroundCurrentSession({ forceFresh: true }), // force: true
    impl.api.shouldRefreshForegroundCurrentSession({}),                   // idle + fresh + rendered: false
  ];
  impl.setAmbient({ hasAttachedSession: false });
  out.current.push(impl.api.shouldRefreshForegroundCurrentSession({}));   // not attached: true
  resetAmbient(impl);
  impl.setAmbient({ pendingNavigationState: { seq: 2 } });
  out.current.push(impl.api.shouldRefreshForegroundCurrentSession({}));   // navigation pending: true
  resetAmbient(impl);
  impl.setAmbient({ findClientSessionRecord: (id) => null });
  out.current.push(impl.api.shouldRefreshForegroundCurrentSession({}));   // session missing: true
  resetAmbient(impl);
  impl.setAmbient({ findClientSessionRecord: (id) => ({ id, activity: { run: { state: 'running' } } }) });
  out.current.push(impl.api.shouldRefreshForegroundCurrentSession({}));   // running: true
  resetAmbient(impl);
  impl.setRendered({ sessionId: 'other', eventCount: 3 });
  out.current.push(impl.api.shouldRefreshForegroundCurrentSession({}));   // no rendered snapshot for session: true
  resetAmbient(impl);
  impl.setAmbient({ lastCurrentSessionRefreshSessionId: 'other' });
  out.current.push(impl.api.shouldRefreshForegroundCurrentSession({}));   // session switched: true
  resetAmbient(impl);
  impl.setAmbient({ lastCurrentSessionRefreshAt: now - 20000 });
  out.current.push(impl.api.shouldRefreshForegroundCurrentSession({}));   // stale: true
  resetAmbient(impl);
  impl.setAmbient({ currentSessionId: '' });
  out.current.push(impl.api.shouldRefreshForegroundCurrentSession({ forceFresh: true })); // no current session: false

  return out;
}

async function main() {
  const [legacy, core] = [loadLegacy(), loadCore()];
  const [a, b] = await Promise.all([runScenario(legacy), runScenario(core)]);
  const [ra, rb] = [JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))];
  assert.deepEqual(rb, ra, `refresh-policy drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-refresh-policy-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
