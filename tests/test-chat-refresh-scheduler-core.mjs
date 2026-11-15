#!/usr/bin/env node
// tests/test-chat-refresh-scheduler-core.mjs
//
// Stage 2: refresh-scheduler core (static/chat/transport/refresh-scheduler.js)
// is a DOM-free port of session-http-scheduler.js. Every scenario below runs
// against BOTH implementations and compares primitive-level outputs, so the
// port cannot drift from the legacy scheduler semantics (intent merge,
// single-flight coalescing, strict supersede, hidden-tab drop, session-switch
// abort, identity-checked registry cleanup).

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function loadLegacy(documentVisibility, nowMs = null) {
  const context = {
    console,
    Promise,
    AbortController,
    Map,
    Set,
    Date,
    Error,
    URLSearchParams,
  };
  if (typeof nowMs === 'function') {
    // Controlled clock: Date.now() follows the scenario, instances keep
    // toISOString() working for the metrics samples.
    const RealDate = Date;
    context.Date = class extends RealDate {
      static now() { return nowMs(); }
    };
  }
  if (documentVisibility !== undefined) {
    context.document = { visibilityState: documentVisibility };
  }
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/session-http-scheduler.js'), 'utf8'),
    context,
    { filename: 'session-http-scheduler.js' },
  );
  return {
    api: {
      ensureRefreshSchedulerMetricsStore: () => context.ensureRefreshSchedulerMetricsStore(),
      recordRefreshSchedulerMetric: (...args) => context.recordRefreshSchedulerMetric(...args),
      isRefreshTabHidden: () => context.isRefreshTabHidden(),
      createRefreshAbortController: () => context.createRefreshAbortController(),
      normalizeRefreshViewportIntent: (v) => context.normalizeRefreshViewportIntent(v),
      mergeRefreshIntents: (a, b) => context.mergeRefreshIntents(a, b),
      refreshViewportRank: (v) => context.refreshViewportRank(v),
      refreshIntentSupersedes: (a, b) => context.refreshIntentSupersedes(a, b),
      scheduleRefreshRequest: (k, o) => context.scheduleRefreshRequest(k, o),
      abortSessionRefreshRequests: (id) => context.abortSessionRefreshRequests(id),
    },
    label: `legacy${documentVisibility === undefined ? '' : `(hidden=${documentVisibility})`}`,
  };
}

function loadCore(isTabHidden, nowMs = null) {
  const context = {
    console,
    Promise,
    AbortController,
    Map,
    Set,
    Date,
    Error,
    URLSearchParams,
    RagentRefreshSchedulerEnvironment: {
      isTabHidden: () => isTabHidden === true,
      ...(typeof nowMs === 'function' ? { nowMs } : {}),
    },
  };
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/refresh-scheduler.js'), 'utf8'),
    context,
    { filename: 'transport/refresh-scheduler.js' },
  );
  const core = context.RagentRefreshSchedulerCore;
  return {
    api: {
      ensureRefreshSchedulerMetricsStore: () => core.ensureRefreshSchedulerMetricsStore(),
      recordRefreshSchedulerMetric: (...args) => core.recordRefreshSchedulerMetric(...args),
      isRefreshTabHidden: () => core.isRefreshTabHidden(),
      createRefreshAbortController: () => core.createRefreshAbortController(),
      normalizeRefreshViewportIntent: (v) => core.normalizeRefreshViewportIntent(v),
      mergeRefreshIntents: (a, b) => core.mergeRefreshIntents(a, b),
      refreshViewportRank: (v) => core.refreshViewportRank(v),
      refreshIntentSupersedes: (a, b) => core.refreshIntentSupersedes(a, b),
      scheduleRefreshRequest: (k, o) => core.scheduleRefreshRequest(k, o),
      abortSessionRefreshRequests: (id) => core.abortSessionRefreshRequests(id),
    },
    label: `transport(isTabHidden=${isTabHidden})`,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortedOnSignal(signal) {
  return new Promise((resolve, reject) => {
    if (!signal) return resolve(null);
    signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
}

function totalsSnapshot(api) {
  const metrics = api.ensureRefreshSchedulerMetricsStore();
  return {
    started: metrics.totals.started,
    coalesced: metrics.totals.coalesced,
    superseded: metrics.totals.superseded,
    staleSuperseded: metrics.totals.staleSuperseded,
    aborted: metrics.totals.aborted,
    hiddenDropped: metrics.totals.hiddenDropped,
    switchAborted: metrics.totals.switchAborted,
  };
}

async function runVisibleScenario(api) {
  const out = {};

  // 1. Pure intent functions.
  out.intents = [
    api.normalizeRefreshViewportIntent('session_entry_bottom'),
    api.normalizeRefreshViewportIntent('  session_entry  '),
    api.normalizeRefreshViewportIntent(''),
    api.normalizeRefreshViewportIntent(undefined),
    api.normalizeRefreshViewportIntent('garbage'),
    api.mergeRefreshIntents(
      { viewportIntent: 'session_entry', forceFresh: true },
      { viewportIntent: 'preserve', wsPushCaughtUp: true },
    ),
    api.mergeRefreshIntents({}, {}),
    api.mergeRefreshIntents({ viewportIntent: 'session_entry_bottom' }, { viewportIntent: 'session_entry' }),
    api.refreshViewportRank('session_entry_bottom'),
    api.refreshViewportRank('session_entry'),
    api.refreshViewportRank('preserve'),
    api.refreshViewportRank(undefined),
    api.refreshIntentSupersedes({ forceFresh: true }, { forceFresh: false }),
    api.refreshIntentSupersedes({ forceFresh: true }, { forceFresh: true }),
    api.refreshIntentSupersedes({ viewportIntent: 'session_entry_bottom' }, { viewportIntent: 'session_entry' }),
    api.refreshIntentSupersedes({ viewportIntent: 'session_entry' }, { viewportIntent: 'session_entry_bottom' }),
    api.refreshIntentSupersedes({ wsPushCaughtUp: true }, { wsPushCaughtUp: false }),
    api.refreshIntentSupersedes({}, {}),
  ];

  // 2. Single-flight coalesce: second request with the same key returns the
  //    same promise and never runs its own run callback.
  {
    let resolveFirst = null;
    let secondRunCalled = false;
    const firstRun = () => new Promise((resolve) => { resolveFirst = resolve; });
    const p1 = api.scheduleRefreshRequest('k-coalesce', { intent: {}, run: firstRun });
    const p2 = api.scheduleRefreshRequest('k-coalesce', { intent: {}, run: () => { secondRunCalled = true; return null; } });
    out.coalesce = {
      samePromise: p1 === p2,
      secondRunCalled,
      startedBeforeResolve: totalsSnapshot(api).started,
    };
    resolveFirst('ok');
    await p1;
    out.coalesce.after = totalsSnapshot(api);
  }

  // 3. Strict supersede: forceFresh upgrade aborts the in-flight request and
  //    restarts with the merged intent.
  {
    const aborts = [];
    const firstRun = ({ signal }) => abortedOnSignal(signal);
    const p1 = api.scheduleRefreshRequest('k-supersede', { intent: {}, run: firstRun });
    await sleep(0);
    const p2 = api.scheduleRefreshRequest('k-supersede', { intent: { forceFresh: true }, run: () => 'second' });
    const p1Result = await p1;
    const p2Result = await p2;
    out.supersede = { p1Result, p2Result, totals: totalsSnapshot(api) };
  }

  // 4. Weak intent coalesces onto the running request even when the second
  //    arrives with a forceFresh=false intent.
  {
    let resolveWeak = null;
    const p1 = api.scheduleRefreshRequest('k-weak', { intent: {}, run: () => new Promise((resolve) => { resolveWeak = resolve; }) });
    const p2 = api.scheduleRefreshRequest('k-weak', { intent: { viewportIntent: 'session_entry' }, run: () => 'never' });
    out.weak = { samePromise: p1 === p2 };
    resolveWeak('weak-ok');
    await p1;
    await p2;
  }

  // 5. AbortError in the run resolves null and counts as aborted; a non-abort
  //    error propagates as a rejection.
  {
    const pAbort = api.scheduleRefreshRequest('k-abort', {
      intent: {},
      run: ({ signal }) => abortedOnSignal(signal).then(() => 'nope'),
    });
    await sleep(0);
    const pAbort2 = api.scheduleRefreshRequest('k-abort', { intent: { forceFresh: true }, run: () => 'ok' });
    out.abort = { first: await pAbort, second: await pAbort2 };
    let rejectedMessage = '';
    try {
      await api.scheduleRefreshRequest('k-throw', { intent: {}, run: () => { throw new Error('boom'); } });
    } catch (error) {
      rejectedMessage = error.message;
    }
    out.throwPropagates = rejectedMessage;
    out.afterAbort = totalsSnapshot(api);
  }

  // 6. Identity check: a superseded request settling late must not remove the
  //    successor's registry entry.
  {
    let p2Resolve = null;
    const p1 = api.scheduleRefreshRequest('k-identity', {
      intent: {},
      run: ({ signal }) => abortedOnSignal(signal),
    });
    await sleep(0);
    const p2 = api.scheduleRefreshRequest('k-identity', {
      intent: { forceFresh: true },
      run: () => new Promise((resolve) => { p2Resolve = resolve; }),
    });
    const p1Result = await p1; // p1 aborted → null
    // Registry currently holds p2's entry. A fresh request with a weaker
    // intent must COALESCE onto p2 (same promise) — if p1's finally had
    // clobbered p2's entry, this would start a new request instead.
    const p3 = api.scheduleRefreshRequest('k-identity', { intent: {}, run: () => 'never3' });
    out.identity = {
      p1Result,
      coalescesOntoSuccessor: p1Result === null && p3 === p2,
      coalescedCount: totalsSnapshot(api).coalesced,
    };
    p2Resolve('identity-ok');
    await p2;
    await p3;
  }

  // 7. Session switch aborts every in-flight session:{id}:* entry and counts.
  {
    const gateA = [];
    const runA = ({ signal }) => abortedOnSignal(signal);
    const pA = api.scheduleRefreshRequest('session:s1:current', { intent: {}, run: runA });
    await sleep(0);
    const pList = api.scheduleRefreshRequest('session-list', { intent: {}, run: () => 'list-ok' });
    await sleep(0);
    const pB = api.scheduleRefreshRequest('session:s1:sidebar', { intent: {}, run: runA });
    await sleep(0);
    const abortedCount = api.abortSessionRefreshRequests('s1');
    const pAResult = await pA;
    const pBResult = await pB;
    const pListResult = await pList;
    out.switch = { abortedCount, pAResult, pBResult, pListResult, totals: totalsSnapshot(api) };
  }

  // 8. Essential request preempts in-flight non-essential background request.
  {
    const runBg = ({ signal }) => abortedOnSignal(signal);
    const pBg = api.scheduleRefreshRequest('k-preempt', { intent: {}, essential: false, run: runBg });
    await sleep(0);
    const pEssential = api.scheduleRefreshRequest('k-preempt', { intent: {}, essential: true, run: () => 'essential-wins' });
    const pBgResult = await pBg;
    const pEssentialResult = await pEssential;
    out.essentialPreempt = {
      pBgResult,
      pEssentialResult,
      preempts: pEssential !== pBg && pBgResult === null,
      totals: totalsSnapshot(api),
    };
  }

  return out;
}

// A wedged in-flight entry (a run that never settles) must not own its
// registry key forever. Under a controlled clock:
//   a) an essential arrival on a YOUNG essential entry still coalesces;
//   b) past the stale bound, an essential arrival restarts the entry (the old
//      run is aborted → resolves null, the new one runs to completion);
//   c) a BACKGROUND arrival on a stale essential entry still coalesces — the
//      stale bound must not reopen the weaker-abort protection hole.
async function runStaleEssentialScenario(api, clock) {
  const out = {};

  clock.set(1_000);
  let releaseFirst = null;
  const firstRun = ({ signal }) => new Promise((resolve, reject) => {
    releaseFirst = resolve;
    if (signal) signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
  const p1 = api.scheduleRefreshRequest('k-stale', { intent: {}, essential: true, run: firstRun });
  await sleep(0);

  clock.set(2_000);
  let youngRunCalled = false;
  const p2 = api.scheduleRefreshRequest('k-stale', {
    intent: {},
    essential: true,
    run: () => { youngRunCalled = true; return 'young'; },
  });
  out.young = {
    coalesces: p1 === p2,
    youngRunCalled,
    totals: totalsSnapshot(api),
  };

  clock.set(1_000 + 10_000 + 1);
  let restartResolve = null;
  const p3 = api.scheduleRefreshRequest('k-stale', {
    intent: {},
    essential: true,
    run: () => new Promise((resolve) => { restartResolve = resolve; }),
  });
  const p1Result = await p1;
  out.stale = {
    restarted: p3 !== p2,
    firstAbortedToNull: p1Result === null,
    totals: totalsSnapshot(api),
  };

  clock.set(1_000 + 40_000);
  let backgroundRunCalled = false;
  const pBg = api.scheduleRefreshRequest('k-stale', {
    intent: {},
    essential: false,
    run: () => { backgroundRunCalled = true; return 'background'; },
  });
  out.background = {
    coalescesOntoRestart: pBg === p3,
    backgroundRunCalled,
  };

  restartResolve('restart-ok');
  out.restartResult = await p3;
  out.backgroundResult = await pBg;
  out.finalTotals = totalsSnapshot(api);
  return out;
}

async function runHiddenScenario(api) {
  const out = {};
  // Hidden tab: non-essential requests are dropped (null, run never called),
  // essential requests still run.
  let nonEssentialRan = false;
  let essentialRan = false;
  const dropped = api.scheduleRefreshRequest('k-hidden', {
    intent: {},
    run: () => { nonEssentialRan = true; return 'nope'; },
  });
  const essential = api.scheduleRefreshRequest('k-hidden-essential', {
    intent: {},
    essential: true,
    run: () => { essentialRan = true; return 'essential-ok'; },
  });
  out.hidden = {
    dropped: await dropped,
    essential: await essential,
    nonEssentialRan,
    essentialRan,
    totals: totalsSnapshot(api),
  };
  return out;
}

async function main() {
  const pairs = [
    [loadLegacy(undefined), loadCore(false)],
  ];
  for (const [legacy, core] of pairs) {
    const [a, b] = await Promise.all([runVisibleScenario(legacy.api), runVisibleScenario(core.api)]);
    const [ra, rb] = [JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))];
    assert.deepEqual(rb, ra, `visible scenario drift: ${legacy.label} vs ${core.label}`);
  }

  const staleClock = () => {
    const clock = { now: 0, set(value) { this.now = value; } };
    return clock;
  };
  for (const [legacy, core] of pairs) {
    const clockA = staleClock();
    const clockB = staleClock();
    const [a, b] = await Promise.all([
      runStaleEssentialScenario(legacy.api, clockA),
      runStaleEssentialScenario(core.api, clockB),
    ]);
    const [ra, rb] = [JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))];
    assert.deepEqual(rb, ra, `stale-essential scenario drift: ${legacy.label} vs ${core.label}`);
    assert.equal(ra.young.coalesces, true, 'a young essential entry must keep its coalescing protection');
    assert.equal(ra.young.youngRunCalled, false, 'the coalesced request must not run its own fetch');
    assert.equal(ra.stale.restarted, true, 'an essential arrival past the stale bound must restart the entry');
    assert.equal(ra.stale.firstAbortedToNull, true, 'the wedged first run must resolve null via abort');
    assert.ok(ra.stale.totals.staleSuperseded >= 1, 'stale supersede must be counted');
    assert.equal(ra.background.coalescesOntoRestart, true, 'background arrivals must never exercise the stale bound');
    assert.equal(ra.background.backgroundRunCalled, false, 'the background coalesce must not run a fetch');
    assert.equal(ra.restartResult, 'restart-ok');
  }

  const hiddenPairs = [
    [loadLegacy('hidden'), loadCore(true)],
  ];
  for (const [legacy, core] of hiddenPairs) {
    const [a, b] = await Promise.all([runHiddenScenario(legacy.api), runHiddenScenario(core.api)]);
    const [ra, rb] = [JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))];
    assert.deepEqual(rb, ra, `hidden scenario drift: ${legacy.label} vs ${core.label}`);
  }

  console.log('test-chat-refresh-scheduler-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
