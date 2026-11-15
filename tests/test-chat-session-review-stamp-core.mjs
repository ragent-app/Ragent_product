#!/usr/bin/env node
// tests/test-chat-session-review-stamp-core.mjs
//
// Stage 2: session-review-stamp core (static/chat/transport/session-review-stamp.js)
// is a pure port of session-http.js's review-stamp algebra — the four
// functions behind the sidebar "reviewed" indicator: canonicalizing every
// stamp form into an ISO string, reading its epoch ms for ordering, picking a
// session's newest event stamp, and picking the effective (newest) review
// marker. Every scenario runs against BOTH implementations with identical
// inputs and compares primitive-level outputs, so the port cannot drift from
// the legacy semantics.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

// session-http.js references renderedEventState/currentSessionId/emptyState/
// messagesInner/messagesEl as free variables; predeclare them so the whole
// file vm-loads. The review-stamp functions themselves never touch them.
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
  return {
    api: {
      normalizeSessionReviewStamp: (v) => context.normalizeSessionReviewStamp(v),
      getSessionReviewStampTime: (v) => context.getSessionReviewStampTime(v),
      getSessionReviewStamp: (s) => context.getSessionReviewStamp(s),
      getEffectiveSessionReviewedAt: (s) => context.getEffectiveSessionReviewedAt(s),
    },
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
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/session-review-stamp.js'), 'utf8'),
    context,
    { filename: 'transport/session-review-stamp.js' },
  );
  const core = context.RagentSessionReviewStampCore;
  return {
    api: {
      normalizeSessionReviewStamp: (v) => core.normalizeSessionReviewStamp(v),
      getSessionReviewStampTime: (v) => core.getSessionReviewStampTime(v),
      getSessionReviewStamp: (s) => core.getSessionReviewStamp(s),
      getEffectiveSessionReviewedAt: (s) => core.getEffectiveSessionReviewedAt(s),
    },
    label: 'transport',
  };
}

const EPOCH_MS = 1750000000000; // fixed, Date-parseable in both realms
const EPOCH_PLUS = EPOCH_MS + 60 * 1000;
const EPOCH_MINUS = EPOCH_MS - 60 * 1000;

async function runScenario(impl) {
  const { normalizeSessionReviewStamp: norm, getSessionReviewStampTime: time, getSessionReviewStamp: stamp, getEffectiveSessionReviewedAt: effective } = impl.api;
  const out = {};

  // 1. Stamp normalization across every form.
  out.norm = [
    norm(EPOCH_MS),                // epoch ms number
    norm(EPOCH_MS + 0.5),          // fractional ms
    norm(0),                       // epoch 0
    norm(-EPOCH_MS),               // negative epoch
    norm(NaN),                     // non-finite number
    norm(Infinity),
    norm(String(EPOCH_MS)),        // numeric string
    norm(` ${EPOCH_MS} `),         // numeric string with whitespace
    norm(`${EPOCH_MS}.25`),        // fractional numeric string
    norm(String(-EPOCH_MS)),
    norm(new Date(EPOCH_MS).toISOString()),        // canonical ISO
    norm(new Date(EPOCH_MS).toISOString().replace('.000Z', 'Z')), // ISO without ms
    norm('2026-08-08'),            // date-only string
    norm('not-a-date'),            // unparseable
    norm('123abc'),
    norm(''),
    norm('   '),
    norm(null),
    norm(undefined),
    norm({}),                      // non-scalar
  ];

  // 2. Stamp ordering time.
  out.time = [
    time(new Date(EPOCH_MS).toISOString()),
    time(String(EPOCH_MS)),
    time(''),
    time(null),
    time(undefined),
    time('garbage'),
    time(0),                       // new Date("0") parses — legacy quirk kept
  ];

  // 3. Session activity stamp precedence (lastActivityAt > legacy lastEventAt
  // > updatedAt > created).
  out.stamp = [
    stamp({ lastEventAt: EPOCH_MS }),
    stamp({ updatedAt: EPOCH_MS }),
    stamp({ created: EPOCH_MS }),
    stamp({ lastEventAt: EPOCH_PLUS, updatedAt: EPOCH_MINUS }),
    stamp({ lastActivityAt: EPOCH_PLUS, lastEventAt: EPOCH_MINUS }),
    stamp({ lastEventAt: '', updatedAt: EPOCH_MS }),
    stamp({ lastEventAt: 'bad', updatedAt: EPOCH_MS }),
    stamp({ lastEventAt: '', updatedAt: '', created: EPOCH_MS }),
    stamp({}),                     // nothing usable
    stamp(null),
    stamp(undefined),
    stamp({ lastEventAt: 0 }),     // epoch 0 is a valid stamp
  ];

  // 4. Effective review marker = newest of the three candidates.
  out.effective = [
    effective({ lastReviewedAt: EPOCH_PLUS, localReviewedAt: EPOCH_MINUS, reviewBaselineAt: EPOCH_MS }),
    effective({ lastReviewedAt: EPOCH_MINUS, localReviewedAt: EPOCH_PLUS, reviewBaselineAt: EPOCH_MS }),
    effective({ lastReviewedAt: EPOCH_MINUS, localReviewedAt: EPOCH_MS, reviewBaselineAt: EPOCH_PLUS }),
    effective({ lastReviewedAt: EPOCH_MS }),
    effective({ localReviewedAt: EPOCH_MS }),
    effective({ reviewBaselineAt: EPOCH_MS }),
    effective({ lastReviewedAt: 'bad', localReviewedAt: EPOCH_MS }),
    effective({}),                 // no markers
    effective(null),
    effective({ lastReviewedAt: 0 }),
  ];

  return out;
}

async function main() {
  const [legacy, core] = [loadLegacy(), loadCore()];
  const [a, b] = await Promise.all([runScenario(legacy), runScenario(core)]);
  assert.deepEqual(b, a, `session-review-stamp drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-session-review-stamp-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
