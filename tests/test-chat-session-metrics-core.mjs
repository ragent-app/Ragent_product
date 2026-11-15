#!/usr/bin/env node
// tests/test-chat-session-metrics-core.mjs
//
// Stage 2: session-metrics core (static/chat/transport/session-metrics.js) is
// a DOM-free port of session-http.js's event-refresh / streaming-render
// metrics store. The store lives on the attach root (legacy reached
// window/globalThis itself; here the module's root IS the store host). Every
// scenario runs against BOTH implementations and compares the deep snapshot
// from ragentGetEventRefreshMetrics() after stripping timestamps, so the
// port cannot drift from the legacy accumulator shape, totals, sample ring
// and cap behavior.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const RENDERED_SHAPE = `
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
    AbortController,
    navigator: {},
    window: {},
    localStorage: { getItem: () => null },
  };
  vm.runInNewContext(RENDERED_SHAPE, context);
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
      ensure: () => context.ensureEventRefreshMetricsStore(),
      refresh: (sample) => context.recordEventRefreshMetric(sample),
      streaming: (sample) => context.recordStreamingRenderMetric(sample),
      snapshot: () => context.window.ragentGetEventRefreshMetrics(),
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
    URL,
    URLSearchParams,
    encodeURIComponent,
    AbortController,
  };
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/session-metrics.js'), 'utf8'),
    context,
    { filename: 'transport/session-metrics.js' },
  );
  const core = context.RagentSessionMetricsCore;
  return {
    api: {
      ensure: () => core.ensureEventRefreshMetricsStore(),
      refresh: (sample) => core.recordEventRefreshMetric(sample),
      streaming: (sample) => core.recordStreamingRenderMetric(sample),
      snapshot: () => context.ragentGetEventRefreshMetrics(),
    },
    label: 'transport',
  };
}

// ISO timestamps differ by a millisecond between the two sequential runs.
function stripTimestamps(value) {
  const strip = (node) => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, child] of Object.entries(node)) {
        if (key === 'at' || key === 'startedAt') continue;
        out[key] = strip(child);
      }
      return out;
    }
    return node;
  };
  return JSON.parse(JSON.stringify(strip(value)));
}

async function runScenario(impl) {
  const out = {};

  // 1. Fresh store shape (before any sample is recorded): the getter is only
  //    installed by an explicit ensure (legacy semantics).
  impl.api.ensure();
  out.initial = impl.api.snapshot();

  // 2. Event-refresh sample family: mode normalization, outcome/renderMode
  //    normalization, delta vs full tallies, fallback prefix counting.
  impl.api.refresh({ mode: 'delta', outcome: 'applied', renderMode: 'append' });
  impl.api.refresh({ mode: 'delta', outcome: 'fallback:full', renderMode: 'noop' });
  impl.api.refresh({ mode: 'delta', outcome: 'fallback:delta', renderMode: 'noop' });
  impl.api.refresh({ mode: 'delta', outcome: 'error', renderMode: 'reset' });
  impl.api.refresh({ mode: 'full', outcome: 'ok', renderMode: 'reset' });
  impl.api.refresh({ mode: 'weird', outcome: 42, renderMode: 'unexpected' });
  impl.api.refresh({ mode: 'delta', outcome: 'applied', renderMode: 'append', extra: 'kept', nested: { a: 1 } });
  out.afterRefresh = impl.api.snapshot();

  // 3. Streaming-render family: renderMs/textLen clamping, block vs full.
  impl.api.streaming({ renderMs: 12.5, mode: 'block', textLen: 300 });
  impl.api.streaming({ renderMs: 0, mode: 'full', textLen: 0 });
  impl.api.streaming({ renderMs: -1, mode: 'other', textLen: -5 });
  impl.api.streaming({ renderMs: 204.25, mode: 'full', textLen: 42, extra: 'kept' });
  impl.api.streaming({});
  out.afterStreaming = impl.api.snapshot();

  // 4. Sample ring cap: 95 more records push the ring past the 80 limit.
  for (let index = 0; index < 95; index += 1) {
    impl.api.refresh({ mode: 'delta', outcome: 'applied', renderMode: 'append', index });
  }
  out.afterRingOverflow = impl.api.snapshot();

  // 5. Store is idempotent: the getter and store shape are not recreated.
  const first = impl.api.snapshot();
  impl.api.refresh({ mode: 'full', outcome: 'ok', renderMode: 'reset' });
  out.stillWorking = impl.api.snapshot().totals.fullFetches;
  out.sameShape = Object.keys(first.totals).sort().join(',');

  return out;
}

async function main() {
  const [legacy, core] = [loadLegacy(), loadCore()];
  const [a, b] = await Promise.all([runScenario(legacy), runScenario(core)]);
  const [ra, rb] = [stripTimestamps(a), stripTimestamps(b)];
  assert.deepEqual(rb, ra, `session-metrics drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-session-metrics-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
