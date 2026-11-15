"use strict";

// Pure HTTP refresh request registry (Stage 2 extraction of
// session-http-scheduler.js). Per resource key at most one request is in
// flight at a time:
//
//   - "session-list"                  → GET /api/sessions
//   - "archived-sessions"             → GET /api/sessions?archived=1
//   - "session:{id}:state"            → GET /api/sessions/{id}
//   - "session:{id}:current"          → state + visible events refresh (delta or full)
//   - "session:{id}:sidebar"          → GET /api/sessions/{id}?view=sidebar
//   - "session:{id}:events:older"     → direction=before paging page
//
// Semantics (built on top of the existing foreground throttle, push
// suppression and delta/paging):
//
//   - Single-flight: a request arriving while the same key is in flight
//     coalesces onto the running request (same promise) unless its merged
//     intent is strictly stronger.
//   - Supersede: forceFresh false→true, wsPushCaughtUp false→true, or a
//     stronger viewportIntent (preserve < session_entry < session_entry_bottom)
//     aborts the in-flight request (AbortController, threaded into the run's
//     signal) and restarts with the merged intent. Rapid invalidation
//     therefore never queues behind a slow stale request. An essential
//     request additionally restarts an essential entry older than
//     ESSENTIAL_REFRESH_ENTRY_STALE_MS (a fetch that never settles must not
//     wedge its registry key into permanent coalescing).
//   - Hidden tab: non-essential refreshes (invalidation, reconnect, event
//     handlers) are dropped while the tab is hidden; the foreground refresh
//     already scheduled by the caller re-syncs on return to a visible tab.
//     Explicit user flows (boot, open-session, notification entry) pass
//     essential: true and always run.
//   - Session switch: abortSessionRefreshRequests(previousSessionId) aborts
//     every in-flight "session:{id}:*" entry for the old session.
//   - Aborted/superseded requests resolve with null instead of rejecting, so
//     fire-and-forget callers never see unhandled rejections; a superseded
//     request's finally cannot clobber the successor entry (identity check).
//
// The scheduler owns no session state: it only coordinates requests. All
// state application stays in the caller behind its existing guards. Progress
// counters are exposed for instrumentation via
// ragentGetRefreshSchedulerMetrics() on the attach root.
//
// Platform probes are injected: tab visibility and AbortController come from
// the environment contract (root.RagentRefreshSchedulerEnvironment), so this
// module stays free of browser globals and runs identically in Node. Locked
// against the legacy implementation by
// tests/test-chat-refresh-scheduler-core.mjs.

(function attachRagentRefreshSchedulerCore(root) {
  const REFRESH_SCHEDULER_METRICS_SAMPLE_LIMIT = 40;

  const refreshRequestRegistry = new Map();

  // Live environment: reads always go to the injected object (mutations after
  // attach are visible), falling back to the defaults for absent keys. An
  // Object.assign copy would freeze scalar bindings at attach time, which
  // breaks injected live getters and drifts from the shared legacy scope.
  const DEFAULT_ENVIRONMENT = Object.freeze({
    isTabHidden: () => false,
    createAbortController: () => (
      typeof AbortController !== "undefined" ? new AbortController() : null
    ),
    nowMs: () => (typeof Date !== "undefined" && typeof Date.now === "function" ? Date.now() : 0),
  });
  const environment = new Proxy(
    root.RagentRefreshSchedulerEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  function ensureRefreshSchedulerMetricsStore() {
    if (!root.__ragentRefreshSchedulerMetrics || typeof root.__ragentRefreshSchedulerMetrics !== "object") {
      root.__ragentRefreshSchedulerMetrics = {
        startedAt: new Date().toISOString(),
        totals: {
          started: 0,
          coalesced: 0,
          superseded: 0,
          staleSuperseded: 0,
          aborted: 0,
          hiddenDropped: 0,
          switchAborted: 0,
          retryAttempts: 0,
        },
        last: null,
        samples: [],
      };
    }
    if (typeof root.ragentGetRefreshSchedulerMetrics !== "function") {
      root.ragentGetRefreshSchedulerMetrics = () => {
        const snapshot = root.__ragentRefreshSchedulerMetrics || {};
        return JSON.parse(JSON.stringify(snapshot));
      };
    }
    return root.__ragentRefreshSchedulerMetrics;
  }

  function recordRefreshSchedulerMetric(sample = {}) {
    const store = ensureRefreshSchedulerMetricsStore();
    const normalized = {
      ...sample,
      at: new Date().toISOString(),
    };
    store.last = normalized;
    store.samples.push(normalized);
    if (store.samples.length > REFRESH_SCHEDULER_METRICS_SAMPLE_LIMIT) {
      store.samples.splice(0, store.samples.length - REFRESH_SCHEDULER_METRICS_SAMPLE_LIMIT);
    }
  }

  function isRefreshTabHidden() {
    return environment.isTabHidden() === true;
  }

  function createRefreshAbortController() {
    return environment.createAbortController();
  }

  function normalizeRefreshViewportIntent(value) {
    const normalized = String(value || "").trim();
    if (normalized === "session_entry_bottom") return "session_entry_bottom";
    if (normalized === "session_entry") return "session_entry";
    return "preserve";
  }

  // Same precedence as mergeSessionRefreshOptions in session-http.js:
  // forceFresh/wsPushCaughtUp are OR-merged; viewportIntent keeps the strongest
  // entry intent.
  function mergeRefreshIntents(current = {}, next = {}) {
    const currentViewportIntent = normalizeRefreshViewportIntent(current.viewportIntent);
    const nextViewportIntent = normalizeRefreshViewportIntent(next.viewportIntent);
    const hasBottomEntryIntent =
      currentViewportIntent === "session_entry_bottom"
      || nextViewportIntent === "session_entry_bottom";
    const hasSessionEntryIntent =
      currentViewportIntent === "session_entry"
      || nextViewportIntent === "session_entry";
    return {
      forceFresh: current.forceFresh === true || next.forceFresh === true,
      viewportIntent: hasBottomEntryIntent
        ? "session_entry_bottom"
        : (hasSessionEntryIntent ? "session_entry" : "preserve"),
      wsPushCaughtUp: current.wsPushCaughtUp === true || next.wsPushCaughtUp === true,
    };
  }

  function refreshViewportRank(value) {
    if (value === "session_entry_bottom") return 2;
    if (value === "session_entry") return 1;
    return 0;
  }

  // A fetch that never settles (half-open socket on a tunnel, a WebView that
  // lost its network mid-request) leaves its registry entry in flight forever,
  // and every later request for the same key coalesces onto the wedged entry —
  // the transcript then never renders until a manual reload. A new ESSENTIAL
  // request may therefore restart an essential entry older than this bound even
  // at equal strength; background requests never do, so a healthy slow load
  // keeps its protection against weaker aborts.
  const ESSENTIAL_REFRESH_ENTRY_STALE_MS = 10_000;
  const REFRESH_RETRY_MAX_ATTEMPTS = 3;
  const REFRESH_RETRY_BASE_DELAY_MS = 180;

  function isRetryableRefreshError(error) {
    if (!error || error.name === "AbortError") return false;
    const code = String(error.code || "");
    if (/^(SESSION_HISTORY_|SESSION_NOT_FOUND|AUTH_EXPIRED)/.test(code)) return false;
    if (error.retryable === true) return true;
    if (code === "REQUEST_TIMEOUT" || code.startsWith("TRANSPORT_") || code.startsWith("TARGET_")) return true;
    const status = Number(error.status);
    return status === 408 || status === 429 || status >= 500;
  }

  function waitForRefreshRetry(delayMs, signal) {
    if (signal?.aborted) {
      const error = new Error("Aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => signal?.removeEventListener?.("abort", abort);
      const done = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        cleanup();
        resolve();
      };
      const abort = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        cleanup();
        const error = new Error("Aborted");
        error.name = "AbortError";
        reject(error);
      };
      timer = setTimeout(done, delayMs);
      signal?.addEventListener?.("abort", abort, { once: true });
    });
  }

  async function runRefreshWithRetry(run, { signal, intent, essential, key, metrics }) {
    const maxAttempts = essential ? REFRESH_RETRY_MAX_ATTEMPTS : 2;
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        return await run({ signal, intent });
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableRefreshError(error)) throw error;
        const retryAfter = Number(error?.retryAfterMs);
        const exponential = REFRESH_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
        const jitter = Math.floor(Math.random() * 90);
        const delayMs = Math.min(5_000, Math.max(50, Number.isFinite(retryAfter) ? retryAfter : exponential + jitter));
        metrics.totals.retryAttempts += 1;
        recordRefreshSchedulerMetric({ key, outcome: "retry", attempt, delayMs, code: error?.code || "", status: error?.status || null });
        await waitForRefreshRetry(delayMs, signal);
      }
    }
  }

  function refreshEntryAgeMs(entry) {
    if (!entry?.startedAtMs) return 0;
    return Math.max(0, environment.nowMs() - entry.startedAtMs);
  }

  // A merged intent that is strictly stronger than the in-flight one supersedes
  // the running request (abort + restart) instead of coalescing, so a newer
  // invalidation never waits behind a slower stale request. An interactive
  // (essential) request unconditionally preempts a background (non-essential) fetch.
  function refreshIntentSupersedes(next, current, nextEssential = false, currentEssential = false) {
    if (nextEssential && !currentEssential) return true;
    if (next.forceFresh === true && current.forceFresh !== true) return true;
    if (refreshViewportRank(next.viewportIntent) > refreshViewportRank(current.viewportIntent)) return true;
    if (next.wsPushCaughtUp === true && current.wsPushCaughtUp !== true) return true;
    return false;
  }

  // Core registry entry point. run receives { signal, intent } and must thread
  // signal into its request chain; AbortError anywhere in the run resolves the
  // caller's promise with null.
  function scheduleRefreshRequest(key, { intent = {}, essential = false, run } = {}) {
    const metrics = ensureRefreshSchedulerMetricsStore();
    if (typeof run !== "function") return Promise.resolve(null);
    if (!essential && isRefreshTabHidden()) {
      metrics.totals.hiddenDropped += 1;
      recordRefreshSchedulerMetric({ key, outcome: "hidden_dropped" });
      return Promise.resolve(null);
    }

    const normalizedIntent = {
      forceFresh: intent.forceFresh === true,
      viewportIntent: normalizeRefreshViewportIntent(intent.viewportIntent),
      wsPushCaughtUp: intent.wsPushCaughtUp === true,
    };
    const existing = refreshRequestRegistry.get(key);
    let mergedIntent = normalizedIntent;
    if (existing) {
      mergedIntent = mergeRefreshIntents(existing.intent, normalizedIntent);
      // A user-initiated load is an essential request. Background invalidation
      // may merge into it, but must not abort it after attach has cleared the
      // transcript; doing so turns a harmless race into a visible load error.
      // Another essential request is still allowed to supersede it.
      const backgroundSupersedeBlocked = existing.essential && !essential;
      const essentialSupersedes = !existing.essential && essential;
      const essentialStaleSupersedes = essential
        && refreshEntryAgeMs(existing) > ESSENTIAL_REFRESH_ENTRY_STALE_MS;
      if (!backgroundSupersedeBlocked && (essentialSupersedes || essentialStaleSupersedes
        || refreshIntentSupersedes(mergedIntent, existing.intent, essential, existing.essential))) {
        if (essentialStaleSupersedes && !essentialSupersedes) metrics.totals.staleSuperseded += 1;
        metrics.totals.superseded += 1;
        existing.controller?.abort();
        refreshRequestRegistry.delete(key);
        recordRefreshSchedulerMetric({
          key,
          outcome: essentialStaleSupersedes && !essentialSupersedes ? "stale_superseded" : "superseded",
          intent: mergedIntent,
        });
      } else {
        metrics.totals.coalesced += 1;
        recordRefreshSchedulerMetric({ key, outcome: "coalesced" });
        return existing.promise;
      }
    }

    const controller = createRefreshAbortController();
    const entry = {
      key,
      intent: mergedIntent,
      essential: essential || Boolean(existing?.essential),
      startedAtMs: environment.nowMs(),
      controller,
    };
    const promise = (async () => {
      metrics.totals.started += 1;
      try {
        const result = await runRefreshWithRetry(run, {
          signal: controller?.signal || null,
          intent: mergedIntent,
          essential: entry.essential,
          key,
          metrics,
        });
        return result === undefined ? null : result;
      } catch (error) {
        if (error?.name === "AbortError") {
          metrics.totals.aborted += 1;
          recordRefreshSchedulerMetric({ key, outcome: "aborted" });
          return null;
        }
        throw error;
      } finally {
        // Identity check: a superseded request finishing late must not remove
        // its successor's registry entry.
        if (refreshRequestRegistry.get(key) === entry) {
          refreshRequestRegistry.delete(key);
        }
      }
    })();
    entry.promise = promise;
    refreshRequestRegistry.set(key, entry);
    return promise;
  }

  // Abort every in-flight refresh belonging to a session (used on session
  // switch / detach so old-session HTTP work stops instead of draining the
  // network and being discarded by stale guards). Returns the aborted count.
  function abortSessionRefreshRequests(sessionId) {
    const normalizedSessionId = typeof sessionId === "string" ? sessionId : String(sessionId || "");
    if (!normalizedSessionId) return 0;
    const metrics = ensureRefreshSchedulerMetricsStore();
    const prefix = `session:${normalizedSessionId}:`;
    let abortedCount = 0;
    for (const [key, entry] of refreshRequestRegistry) {
      if (!key.startsWith(prefix)) continue;
      entry.controller?.abort();
      refreshRequestRegistry.delete(key);
      metrics.totals.switchAborted += 1;
      recordRefreshSchedulerMetric({ key, outcome: "switch_aborted" });
      abortedCount += 1;
    }
    return abortedCount;
  }

  root.RagentRefreshSchedulerCore = {
    ensureRefreshSchedulerMetricsStore,
    recordRefreshSchedulerMetric,
    isRefreshTabHidden,
    createRefreshAbortController,
    normalizeRefreshViewportIntent,
    mergeRefreshIntents,
    refreshViewportRank,
    refreshIntentSupersedes,
    scheduleRefreshRequest,
    abortSessionRefreshRequests,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
