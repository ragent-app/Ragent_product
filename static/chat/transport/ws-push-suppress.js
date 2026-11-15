"use strict";

// Pure WS-push suppression decision (Stage 2 extraction of session-http.js).
// After a websocket push applies persistent events, the next event-page HTTP
// refresh can be skipped when the push already covered the latest seq within
// the suppression interval. Owns the tiny state machine (last push session /
// timestamp / latest seq) and the caught-up predicate the refresh pipeline
// consults before deciding whether a full HTTP reload is still needed.
//
// The rendered-event state is an injected live object reference (the same
// shape transport/event-snapshot.js and transport/event-render-plan.js read),
// so this module stays free of browser globals and runs identically in Node.
// Locked against the legacy implementation by
// tests/test-chat-ws-push-suppress-core.mjs.

(function attachRagentWsPushSuppressCore(root) {
  const WS_EVENT_PUSH_SUPPRESS_MS = 600;

  // Live environment: reads always go to the injected object (mutations after
  // attach are visible), falling back to the defaults for absent keys. An
  // Object.assign copy would freeze scalar bindings at attach time, which
  // breaks injected live getters and drifts from the shared legacy scope.
  const DEFAULT_ENVIRONMENT = Object.freeze({
    renderedEventState: {},
  });
  const environment = new Proxy(
    root.RagentWsPushSuppressEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  let lastWsEventPushAt = 0;
  let lastWsEventPushSessionId = "";
  let lastWsEventPushLatestSeq = 0;

  function getEventBoundarySeq(event) {
    if (Number.isInteger(event?.endSeq) && event.endSeq > 0) {
      return event.endSeq;
    }
    if (Number.isInteger(event?.blockEndSeq) && event.blockEndSeq > 0) {
      return event.blockEndSeq;
    }
    if (Number.isInteger(event?.mergedEndSeq) && event.mergedEndSeq > 0) {
      return event.mergedEndSeq;
    }
    return Number.isInteger(event?.seq) ? event.seq : 0;
  }

  function getLatestEventSeq(events) {
    let latestSeq = 0;
    for (const event of events || []) {
      const boundarySeq = getEventBoundarySeq(event);
      if (boundarySeq > latestSeq) {
        latestSeq = boundarySeq;
      }
    }
    return latestSeq;
  }

  function markWsEventPushApplied(sessionId, events) {
    if (!sessionId || !Array.isArray(events) || events.length === 0) return;
    lastWsEventPushSessionId = sessionId;
    lastWsEventPushAt = Date.now();
    const latestPushSeq = getLatestEventSeq(events);
    if (Number.isInteger(latestPushSeq)) {
      lastWsEventPushLatestSeq = latestPushSeq;
    }
  }

  function isWsEventPushCaughtUp(sessionId) {
    if (!sessionId || sessionId !== lastWsEventPushSessionId) return false;
    if (Date.now() - lastWsEventPushAt > WS_EVENT_PUSH_SUPPRESS_MS) return false;
    return lastWsEventPushLatestSeq >= (Number.isInteger(environment.renderedEventState?.latestSeq) ? environment.renderedEventState.latestSeq : 0);
  }

  root.RagentWsPushSuppressCore = {
    markWsEventPushApplied,
    isWsEventPushCaughtUp,
    WS_EVENT_PUSH_SUPPRESS_MS,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
