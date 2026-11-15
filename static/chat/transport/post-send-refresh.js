"use strict";

// Pure post-send fallback refresh scheduling (Stage 2 extraction of
// realtime.js). After an outbound message is sent, one recovery refresh is
// scheduled per request: if the committed message node never appears (the
// send did not stick), the current session is force-refreshed to resync the
// visible history. Keeps one pending timer per outbound request — keying by
// request id (falling back to the session id) so a later quick send replaces
// the earlier request's only recovery pass instead of cancelling it.
//
// All platform hooks (current-session id, the refresh command, the committed
// message-node probe, timers) are injected via the environment contract
// (root.RagentPostSendRefreshEnvironment), so this module stays free of
// browser globals and runs identically in Node. Locked against the legacy
// implementation by tests/test-chat-post-send-refresh-core.mjs.

(function attachRagentPostSendRefreshCore(root) {
  const SEND_FALLBACK_REFRESH_DELAY_MS = 220;

  const DEFAULT_ENVIRONMENT = Object.freeze({
    currentSessionId: "",
    getCurrentSessionId: null,
    refreshCurrentSession: null,
    findCommittedUserMessageNode: null,
    setTimeout: null,
    clearTimeout: null,
  });
  const environment = new Proxy(
    root.RagentPostSendRefreshEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  const pendingSendRefreshTimers = new Map();

  function getCurrentSessionId() {
    if (typeof environment.getCurrentSessionId === "function") {
      return environment.getCurrentSessionId();
    }
    return environment.currentSessionId;
  }

  function schedulePostSendRefresh(sessionId, requestId = "") {
    if (!sessionId || typeof environment.refreshCurrentSession !== "function") return;
    // Keep one fallback timer per outbound request. Keying this by session used
    // to let a later quick send cancel the earlier request's only recovery pass.
    const timerKey = requestId || `session:${sessionId}`;
    const previous = pendingSendRefreshTimers.get(timerKey);
    const scheduleTimer = typeof environment.setTimeout === "function" ? environment.setTimeout : setTimeout;
    const cancelTimer = typeof environment.clearTimeout === "function" ? environment.clearTimeout : clearTimeout;
    if (previous) cancelTimer(previous);
    const timer = scheduleTimer(() => {
      pendingSendRefreshTimers.delete(timerKey);
      if (getCurrentSessionId() !== sessionId) return;
      if (
        requestId
        && typeof environment.findCommittedUserMessageNode === "function"
        && environment.findCommittedUserMessageNode(requestId)
      ) {
        return;
      }
      environment.refreshCurrentSession({ forceFresh: true }).catch(() => {});
    }, SEND_FALLBACK_REFRESH_DELAY_MS);
    pendingSendRefreshTimers.set(timerKey, timer);
  }

  root.RagentPostSendRefreshCore = {
    schedulePostSendRefresh,
    SEND_FALLBACK_REFRESH_DELAY_MS,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
