#!/usr/bin/env node
// tests/test-chat-session-list-state-core.mjs
//
// Stage 2: transport/session-list-state.js carries the pure reduction half of
// session-http-list-state.js's applySessionListState / applyArchivedSessionListState
// (input normalization, dedup, current-session preservation, signature-based
// render decision). The side effects — store write-back, in-place sort
// (shell comparator), render scheduling, project-view refresh, approval /
// attention notification — stay in the legacy view layer.
//
// Parity strategy: the legacy apply functions run in a vm realm with no-op
// stubs for every side effect (no replace* hook → the direct write-back path),
// so their observable output IS the reduction: the returned / written-back
// list plus the render decision (stub flag). Every scenario runs both
// implementations with identical ambient state and compares primitive-level
// outputs.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const PRELUDE = `
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
  const emptyState = { parentNode: null };
  const messagesInner = {};
  emptyState.parentNode = messagesInner;
  const messagesEl = { addEventListener() {} };
  // session-http-list-state.js free variables (declared in other page scripts
  // in the browser): the store list, list-load flags, archived counters, and
  // the side-effect stubs the reduction observes through.
  let sessions = [];
  let archivedSessionCount = 0;
  let hasLoadedSessions = false;
  let archivedSessionsLoaded = false;
  let archivedSessionsLoading = false;
  let renderScheduled = false;
  let renderCalled = false;
  function sortSessionsInPlace() {}
  function refreshAppCatalog() {}
  function scheduleSessionListRender() { renderScheduled = true; }
  function renderSessionList() { renderCalled = true; }
  function refreshProjectsView() {}
  function clearMessages() {}
  function showEmpty() {}
  function restoreDraft() {}
  function resetAttachedSessionRenderState() {}
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
    navigator: {},
    window: {},
  };
  vm.runInNewContext(PRELUDE, context);
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
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/session-http-list-state.js'), 'utf8'),
    context,
    { filename: 'session-http-list-state.js' },
  );
  // The legacy record normalizer looks up review markers through free
  // functions; inject after load (they are not top-level declarations). The
  // render flags are let-variables of the realm, so reads/writes go through
  // realm functions, not the host.
  vm.runInNewContext(
    `__setAmbient = (patch) => {
      if ("currentSessionId" in patch) currentSessionId = patch.currentSessionId;
      if ("sessions" in patch) sessions = patch.sessions;
      if ("archivedSessionCount" in patch) archivedSessionCount = patch.archivedSessionCount;
      if ("hasLoadedSessions" in patch) hasLoadedSessions = patch.hasLoadedSessions;
      if ("archivedSessionsLoaded" in patch) archivedSessionsLoaded = patch.archivedSessionsLoaded;
      if ("archivedSessionsLoading" in patch) archivedSessionsLoading = patch.archivedSessionsLoading;
      if ("getLocalSessionReviewedAt" in patch) globalThis.getLocalSessionReviewedAt = patch.getLocalSessionReviewedAt;
      if ("getSessionReviewBaselineAt" in patch) globalThis.getSessionReviewBaselineAt = patch.getSessionReviewBaselineAt;
    };
    __resetRenderFlags = () => { renderScheduled = false; renderCalled = false; };
    __readRenderFlags = () => ({ renderScheduled, renderCalled });`,
    context,
  );
  return {
    api: {
      applyActive: (nextSessions, opts) => {
        context.__resetRenderFlags();
        const result = context.applySessionListState(nextSessions, opts);
        const { renderScheduled, renderCalled } = context.__readRenderFlags();
        return { sessions: result, changed: renderScheduled || renderCalled };
      },
      applyArchived: (nextSessions, opts) => {
        context.__resetRenderFlags();
        const result = context.applyArchivedSessionListState(nextSessions, opts);
        const { renderScheduled, renderCalled } = context.__readRenderFlags();
        return { sessions: result, changed: renderScheduled || renderCalled };
      },
    },
    setAmbient: (patch) => context.__setAmbient(patch),
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
  };
  const env = {
    getCurrentSessionId: null,
    getLocalSessionReviewedAt: null,
    getSessionReviewBaselineAt: null,
  };
  context.RagentSessionListStateEnvironment = env;
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/session-list-state.js'), 'utf8'),
    context,
    { filename: 'transport/session-list-state.js' },
  );
  const core = context.RagentSessionListStateCore;
  let ambient = {};
  let currentSessionId = '';
  env.getCurrentSessionId = () => currentSessionId;
  return {
    api: {
      // The legacy apply functions write the store back (sessions,
      // load flags, archived count) — the pure reduce does not, so the core
      // harness simulates that write-back to keep consecutive scenarios in
      // lockstep with the legacy realm.
      applyActive: (nextSessions, opts) => {
        const out = core.reduceSessionListState(nextSessions, {
          previousSessions: ambient.sessions || [],
          previousArchivedCount: ambient.archivedSessionCount,
          nextArchivedCount: opts?.archivedCount,
          hasLoadedSessions: ambient.hasLoadedSessions === true,
          preserveCurrentSession: true,
          archivedCountFallback: 'previous',
        });
        ambient.sessions = out.sessions;
        ambient.hasLoadedSessions = true;
        if (Number.isInteger(opts?.archivedCount) && opts.archivedCount >= 0) {
          ambient.archivedSessionCount = opts.archivedCount;
        }
        return { sessions: out.sessions, changed: out.changed };
      },
      applyArchived: (nextSessions, opts) => {
        const out = core.reduceSessionListState(nextSessions, {
          previousSessions: ambient.sessions || [],
          previousArchivedCount: ambient.archivedSessionCount,
          nextArchivedCount: opts?.archivedCount,
          hasLoadedSessions: ambient.archivedSessionsLoaded === true,
          preserveCurrentSession: false,
          archivedCountFallback: 'normalized-length',
        });
        ambient.sessions = out.sessions;
        ambient.archivedSessionsLoaded = true;
        ambient.archivedSessionsLoading = false;
        ambient.archivedSessionCount = out.nextArchivedCount;
        return { sessions: out.sessions, changed: out.changed };
      },
    },
    setAmbient(patch) {
      ambient = { ...ambient, ...patch };
      if ('currentSessionId' in patch) currentSessionId = patch.currentSessionId;
      for (const key of ['getLocalSessionReviewedAt', 'getSessionReviewBaselineAt']) {
        if (key in patch) env[key] = patch[key];
      }
    },
    label: 'transport',
  };
}

const S1 = { id: 's1', name: 'one', model: 'opus' };
const S2 = { id: 's2', name: 'two', isInternalSession: true };
const S2_PREV = { id: 's2', name: 'two old', isInternalSession: true, model: 'haiku' };
const S3 = { id: 's3', name: 'three' };

function runScenario(impl) {
  const out = {};

  // 1. Cold start (active): empty / non-array / normal first payloads.
  impl.setAmbient({ sessions: [], archivedSessionCount: 0, hasLoadedSessions: false, currentSessionId: '' });
  out.coldEmpty = impl.api.applyActive([]);
  out.coldNonArray = impl.api.applyActive(null);
  out.coldUndefined = impl.api.applyActive(undefined);
  out.coldNormal = impl.api.applyActive([S1, S2]);

  // 2. Regular refresh with signature change and with identical state
  //    (different key order / absent-vs-undefined must NOT re-render).
  impl.setAmbient({ sessions: [S1], archivedSessionCount: 2, hasLoadedSessions: true, currentSessionId: '' });
  out.refreshGrow = impl.api.applyActive([S1, S3]);
  out.refreshSame = impl.api.applyActive([{ ...S1 }]);
  out.refreshKeyOrder = impl.api.applyActive([{ name: S1.name, id: S1.id, model: S1.model }]);

  // 3. Current-session preservation: the previous current internal session is
  //    re-appended when the incoming list drops it; not preserved when it is
  //    not internal, the id does not match, or it is already present.
  impl.setAmbient({ sessions: [S2_PREV, S1], archivedSessionCount: 0, hasLoadedSessions: true, currentSessionId: 's2' });
  out.preserveInternal = impl.api.applyActive([S1]);
  out.preserveAlreadyPresent = impl.api.applyActive([S1, { ...S2_PREV }]);
  impl.setAmbient({ sessions: [S2_PREV], archivedSessionCount: 0, hasLoadedSessions: true, currentSessionId: 's2' });
  out.preserveInternalEmpty = impl.api.applyActive([]); // previous internal current + empty incoming → kept
  impl.setAmbient({ sessions: [{ id: 's8', name: 'plain' }], archivedSessionCount: 0, hasLoadedSessions: true, currentSessionId: 's8' });
  out.preserveNotInternal = impl.api.applyActive([]); // non-internal current → dropped
  impl.setAmbient({ sessions: [S1], archivedSessionCount: 0, hasLoadedSessions: true, currentSessionId: 's9' });
  out.preserveNoCurrent = impl.api.applyActive([]);

  // 4. Sparse-record inheritance from the previous list (model/effort/etc.).
  impl.setAmbient({ sessions: [{ id: 's5', model: 'opus', effort: 'high', thinking: true, permissionMode: 'bypass' }], archivedSessionCount: 0, hasLoadedSessions: true, currentSessionId: '' });
  out.sparse = impl.api.applyActive([{ id: 's5' }]);
  impl.setAmbient({ sessions: [{ id: 's6', activity: { queue: { count: 2 } }, queuedMessages: ['a', 'b'] }], archivedSessionCount: 0, hasLoadedSessions: true, currentSessionId: '' });
  out.queueInherit = impl.api.applyActive([{ id: 's6', activity: { queue: { count: 2 } } }]);
  impl.setAmbient({ sessions: [], archivedSessionCount: 0, hasLoadedSessions: true, currentSessionId: '' });
  out.queueNoPrevious = impl.api.applyActive([{ id: 's6', activity: { queue: { count: 0 } } }]);

  // 5. Duplicate ids in the incoming list are merged away.
  impl.setAmbient({ sessions: [], archivedSessionCount: 0, hasLoadedSessions: false, currentSessionId: '' });
  out.duplicates = impl.api.applyActive([S1, S1, { ...S1, name: 'dup' }, S2]);

  // 6. archivedCount handling: valid / invalid values fall back to the
  //    previous count on the active side.
  impl.setAmbient({ sessions: [S1], archivedSessionCount: 7, hasLoadedSessions: true, currentSessionId: '' });
  out.countValid = impl.api.applyActive([S1], { archivedCount: 9 });
  out.countInvalid = impl.api.applyActive([S1], { archivedCount: -1 });
  out.countString = impl.api.applyActive([S1], { archivedCount: '9' });
  out.countMissing = impl.api.applyActive([S1]);

  // 7. Archived side: no current-session preservation; cold start falls back
  //    to the normalized incoming length; signatures decide the render.
  impl.setAmbient({ sessions: [], archivedSessionCount: 0, archivedSessionsLoaded: false, currentSessionId: 's2' });
  out.archivedCold = impl.api.applyArchived([S1, S2]);
  impl.setAmbient({ sessions: [S1], archivedSessionCount: 1, archivedSessionsLoaded: true, currentSessionId: 's2' });
  out.archivedSame = impl.api.applyArchived([{ ...S1 }]);
  out.archivedGrow = impl.api.applyArchived([S1, S2]);
  out.archivedDrop = impl.api.applyArchived([]);
  out.archivedCountFallback = impl.api.applyArchived([S1, S2], { archivedCount: null });
  out.archivedNonArray = impl.api.applyArchived(null);

  // JSON round-trip: reduced lists come from the vm realm and would fail
  // deepStrictEqual on prototype identity alone.
  return JSON.parse(JSON.stringify(out));
}

async function main() {
  const [legacy, core] = [loadLegacy(), loadCore()];
  const [a, b] = [runScenario(legacy), runScenario(core)];
  assert.deepEqual(b, a, `session-list-state drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-session-list-state-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
