#!/usr/bin/env node
// tests/test-chat-session-record-core.mjs
//
// Stage 2: session-record core (static/chat/transport/session-record.js) is a
// DOM-free port of session-http.js's normalizeSessionRecord — the sparse
// server-record normalization that re-applies the previous record's values
// for fields that arrive absent (queuedMessages/model/effort/thinking/
// permissionMode) and re-anchors the local review markers. The two local-store
// lookups are injected via the environment contract. Every scenario runs
// against BOTH implementations with identical ambient lookups and compares
// primitive-level outputs, so the port cannot drift from the legacy semantics.

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
    window: { addEventListener() {} },
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
  // buildOptimisticArchivedSession lives in realtime.js (the session-record
  // legacy realm covers all three files).
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8'),
    context,
    { filename: 'realtime.js' },
  );
  // The legacy record normalizer looks up review markers through these free
  // functions; inject them after load (they are not top-level declarations).
  vm.runInNewContext(
    `__setAmbient = (patch) => {
      if ("getLocalSessionReviewedAt" in patch) globalThis.getLocalSessionReviewedAt = patch.getLocalSessionReviewedAt;
      if ("getSessionReviewBaselineAt" in patch) globalThis.getSessionReviewBaselineAt = patch.getSessionReviewBaselineAt;
    };`,
    context,
  );
  return {
    api: {
      normalizeSessionRecord: (session, previous) => context.normalizeSessionRecord(session, previous),
      buildOptimisticArchivedSession: (session, archived) => context.buildOptimisticArchivedSession(session, archived),
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
    getLocalSessionReviewedAt: null,
    getSessionReviewBaselineAt: null,
  };
  context.RagentSessionRecordEnvironment = env;
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/session-record.js'), 'utf8'),
    context,
    { filename: 'transport/session-record.js' },
  );
  const core = context.RagentSessionRecordCore;
  return {
    api: {
      normalizeSessionRecord: (session, previous) => core.normalizeSessionRecord(session, previous),
      buildOptimisticArchivedSession: (session, archived) => core.buildOptimisticArchivedSession(session, archived),
    },
    setAmbient(patch) {
      for (const key of Object.keys(patch)) {
        if (key in env) env[key] = patch[key];
      }
    },
    label: 'transport',
  };
}

const EPOCH_MS = 1750000000000;
const EPOCH_PLUS = EPOCH_MS + 60 * 1000;
const REVIEW_STAMP = new Date(EPOCH_MS).toISOString();
const REVIEW_STAMP_RAW = String(EPOCH_MS); // same moment, non-canonical form

async function runScenario(impl) {
  const { normalizeSessionRecord: norm } = impl.api;
  const out = {};
  const full = {
    id: 's1',
    title: 'T',
    queuedMessages: ['q1'],
    model: 'opus',
    effort: 'high',
    thinking: true,
    permissionMode: 'plan',
    activity: { queue: { count: 1 } },
    localReviewedAt: REVIEW_STAMP,
    reviewBaselineAt: REVIEW_STAMP,
  };

  // 1. Complete record passes through untouched (stamps canonicalized).
  out.complete = norm(full);

  // 2. Absent queuedMessages inherits from previous when the queue is non-empty.
  out.queueInherit = norm(
    { id: 's1', activity: { queue: { count: 2 } } },
    { queuedMessages: ['old-q'] },
  );

  // 3. Absent queuedMessages is dropped when the queue is empty or unknown.
  out.queueDrop = [
    norm({ id: 's1', activity: { queue: { count: 0 } } }, { queuedMessages: ['old-q'] }),
    norm({ id: 's1' }, { queuedMessages: ['old-q'] }),
    norm({ id: 's1' }, { queuedMessages: 'not-array' }),
    norm({ id: 's1', activity: { queue: { count: 2 } } }), // no previous to inherit
  ];

  // 4. Present queuedMessages wins over previous.
  out.queuePresent = norm(
    { id: 's1', queuedMessages: ['fresh'], activity: { queue: { count: 0 } } },
    { queuedMessages: ['old-q'] },
  );

  // 5. Field inheritance for model/effort/thinking/permissionMode.
  out.fieldInherit = [
    norm({ id: 's1' }, { model: 'opus', effort: 'high', thinking: true, permissionMode: 'plan' }),
    norm({ id: 's1' }, { model: 'opus', thinking: false }),
    norm({ id: 's1', model: 'sonnet', effort: 'medium' }, { model: 'opus', thinking: true }),
    norm({ id: 's1' }, {}), // nothing to inherit → dropped
    norm({ id: 's1' }, { model: 42, thinking: 'yes' }), // non-string/non-true → dropped
  ];

  // 6. Review markers: session value wins, then previous, then local lookups.
  impl.setAmbient({
    getLocalSessionReviewedAt: () => new Date(EPOCH_PLUS).toISOString(),
    getSessionReviewBaselineAt: () => REVIEW_STAMP,
  });
  out.markers = [
    norm({ id: 's1', localReviewedAt: REVIEW_STAMP, reviewBaselineAt: REVIEW_STAMP }),
    norm({ id: 's1', localReviewedAt: REVIEW_STAMP_RAW }), // numeric-string form → canonicalized
    norm({ id: 's1' }, { localReviewedAt: REVIEW_STAMP_RAW }), // from previous
    norm({ id: 's1' }), // from local lookups
    norm({ id: 's1', localReviewedAt: 'garbage' }), // unusable → dropped, lookup not consulted
  ];

  // 7. Lookups returning nothing → markers dropped.
  impl.setAmbient({
    getLocalSessionReviewedAt: () => '',
    getSessionReviewBaselineAt: () => '',
  });
  out.noMarkers = [
    norm({ id: 's1' }),
    norm({ id: 's1' }, { localReviewedAt: '' }),
  ];

  // 8. No lookups injected at all → same drop behavior.
  impl.setAmbient({
    getLocalSessionReviewedAt: null,
    getSessionReviewBaselineAt: null,
  });
  out.noLookups = norm({ id: 's1' });

  // 9. The input session object is never mutated.
  const input = { id: 's1' };
  const result = norm(input, { model: 'opus', localReviewedAt: REVIEW_STAMP });
  out.immutability = { input: { ...input }, resultKeys: Object.keys(result).sort(), hasModel: 'model' in result };

  // 10. Empty / edge inputs.
  out.edges = [
    norm(null),
    norm(undefined),
    norm({}),
  ];

  // 11. Optimistic archive / un-archive transform (realtime.js). The archive
  //     timestamp is Date.now-driven and legitimately differs by a few ms
  //     between the two runs; strip it before comparing.
  const { buildOptimisticArchivedSession: optimistic } = impl.api;
  const stripArchiveAt = (value) => JSON.parse(JSON.stringify(value, (key, v) => (key === 'archivedAt' ? undefined : v)));
  out.optimistic = [
    stripArchiveAt(optimistic({ id: 's1', title: 'T' }, true)),
    stripArchiveAt(optimistic({ id: 's1', title: 'T', pinned: true }, true)),
    stripArchiveAt(optimistic({ id: 's1', archivedAt: '2026-01-01T00:00:00.000Z' }, true)), // existing stamp kept
    stripArchiveAt(optimistic({ id: 's1', archived: true, archivedAt: '2026-01-01T00:00:00.000Z', pinned: true }, false)),
    stripArchiveAt(optimistic({ id: 's1', pinned: true }, false)), // nothing to remove
    optimistic(null, true),
    optimistic(undefined, false),
    optimistic({}, true), // no id
    stripArchiveAt(optimistic({ id: 's1', archived: false, archivedAt: '' }, false)),
  ];
  out.optimisticInputUntouched = JSON.parse(JSON.stringify({ ...full }));

  return JSON.parse(JSON.stringify(out));
}

async function main() {
  const [legacy, core] = [loadLegacy(), loadCore()];
  const [a, b] = await Promise.all([runScenario(legacy), runScenario(core)]);
  assert.deepEqual(b, a, `session-record drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-session-record-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
