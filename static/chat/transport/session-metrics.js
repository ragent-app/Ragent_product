"use strict";

// Pure event-refresh / streaming-render metrics store (Stage 2 extraction of
// session-http.js). Owns the __ragentEventRefreshMetrics accumulator on the
// attach root (the legacy code reached the browser global itself; here the
// attach root IS the store host, so the module stays free of browser globals
// and runs identically in Node):
//
//   - ensureEventRefreshMetricsStore() creates the store shape on first use
//     and installs ragentGetEventRefreshMetrics() as a deep-snapshot getter
//     on the same root.
//   - recordEventRefreshMetric() tallies full/delta request outcomes and
//     rendered reset/append/noop totals, keeping the last sample plus a
//     capped sample ring.
//   - recordStreamingRenderMetric() tallies streaming-render frame timing
//     (mode "block"/"full") into the same store and ring; samples carry
//     kind "streaming-render" so both families coexist in one array.
//
// Locked against the legacy implementation by
// tests/test-chat-session-metrics-core.mjs.

(function attachRagentSessionMetricsCore(root) {
  const EVENT_REFRESH_METRICS_SAMPLE_LIMIT = 80;

  function ensureEventRefreshMetricsStore() {
    if (!root.__ragentEventRefreshMetrics || typeof root.__ragentEventRefreshMetrics !== "object") {
      root.__ragentEventRefreshMetrics = {
        startedAt: new Date().toISOString(),
        totals: {
          fullFetches: 0,
          deltaFetches: 0,
          deltaApplied: 0,
          deltaFallbacks: 0,
          renderedResets: 0,
          renderedAppends: 0,
          renderedNoops: 0,
          // Streaming per-frame markdown render timing (kind: "streaming-render").
          streamingRenderFrames: 0,
          streamingRenderTotalMs: 0,
          streamingRenderMaxMs: 0,
          streamingRenderBlockCount: 0,
          streamingRenderFullCount: 0,
        },
        last: null,
        samples: [],
      };
    }
    if (typeof root.ragentGetEventRefreshMetrics !== "function") {
      root.ragentGetEventRefreshMetrics = () => {
        const snapshot = root.__ragentEventRefreshMetrics || {};
        return JSON.parse(JSON.stringify(snapshot));
      };
    }
    return root.__ragentEventRefreshMetrics;
  }

  function recordEventRefreshMetric(sample = {}) {
    const store = ensureEventRefreshMetricsStore();
    const mode = sample.mode === "delta" ? "delta" : "full";
    const outcome = typeof sample.outcome === "string" ? sample.outcome : "unknown";
    const renderMode = typeof sample.renderMode === "string" ? sample.renderMode : "";
    const normalized = {
      ...sample,
      mode,
      outcome,
      renderMode,
      at: new Date().toISOString(),
    };
    if (mode === "delta") {
      store.totals.deltaFetches += 1;
      if (outcome === "applied") {
        store.totals.deltaApplied += 1;
      }
      if (outcome.startsWith("fallback")) {
        store.totals.deltaFallbacks += 1;
      }
    } else {
      store.totals.fullFetches += 1;
    }
    if (renderMode === "reset") store.totals.renderedResets += 1;
    if (renderMode === "append") store.totals.renderedAppends += 1;
    if (renderMode === "noop") store.totals.renderedNoops += 1;
    store.last = normalized;
    store.samples.push(normalized);
    if (store.samples.length > EVENT_REFRESH_METRICS_SAMPLE_LIMIT) {
      store.samples.splice(0, store.samples.length - EVENT_REFRESH_METRICS_SAMPLE_LIMIT);
    }
  }

  function recordStreamingRenderMetric(sample = {}) {
    const store = ensureEventRefreshMetricsStore();
    const renderMs = Number.isFinite(sample.renderMs) && sample.renderMs >= 0
      ? sample.renderMs
      : 0;
    const mode = sample.mode === "block" ? "block" : "full";
    const textLen = Number.isInteger(sample.textLen) && sample.textLen >= 0
      ? sample.textLen
      : 0;
    const normalized = {
      kind: "streaming-render",
      renderMs,
      mode,
      textLen,
      at: new Date().toISOString(),
    };
    store.totals.streamingRenderFrames = (store.totals.streamingRenderFrames || 0) + 1;
    store.totals.streamingRenderTotalMs = (store.totals.streamingRenderTotalMs || 0) + renderMs;
    store.totals.streamingRenderMaxMs = Math.max(
      Number(store.totals.streamingRenderMaxMs) || 0,
      renderMs,
    );
    if (mode === "block") {
      store.totals.streamingRenderBlockCount = (store.totals.streamingRenderBlockCount || 0) + 1;
    } else {
      store.totals.streamingRenderFullCount = (store.totals.streamingRenderFullCount || 0) + 1;
    }
    store.last = normalized;
    store.samples.push(normalized);
    if (store.samples.length > EVENT_REFRESH_METRICS_SAMPLE_LIMIT) {
      store.samples.splice(0, store.samples.length - EVENT_REFRESH_METRICS_SAMPLE_LIMIT);
    }
  }

  root.RagentSessionMetricsCore = {
    ensureEventRefreshMetricsStore,
    recordEventRefreshMetric,
    recordStreamingRenderMetric,
    EVENT_REFRESH_METRICS_SAMPLE_LIMIT,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
