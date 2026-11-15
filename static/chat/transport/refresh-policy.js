"use strict";

// Pure foreground-refresh policy (Stage 2 extraction of session-http.js):
// viewport-intent normalization + option merging, staleness checks,
// payload-size estimation and the should-refresh decision helpers for the
// session list, archived list and current session. The ambient shell facts
// the legacy file reads from its shared scope (load state, navigation state,
// current session id, refresh timestamps, archive-section expansion) are
// injected via the environment contract
// (root.RagentRefreshPolicyEnvironment), so this module stays free of
// browser globals and runs identically in Node. Locked against the legacy
// implementation by tests/test-chat-refresh-policy-core.mjs.

(function attachRagentRefreshPolicyCore(root) {
  const FOREGROUND_SESSION_LIST_STALE_MS = 15000;
  const FOREGROUND_IDLE_SESSION_STALE_MS = 15000;

  // Live environment: reads always go to the injected object (mutations after
  // attach are visible), falling back to the defaults for absent keys. An
  // Object.assign copy would freeze scalar bindings at attach time, which
  // breaks injected live getters and drifts from the shared legacy scope.
  const DEFAULT_ENVIRONMENT = Object.freeze({
    currentSessionId: "",
    visitorSessionId: "",
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
    lastCurrentSessionRefreshSessionId: "",
    getTimelineRuntimeSnapshot: null,
  });
  const environment = new Proxy(
    root.RagentRefreshPolicyEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  function normalizeSessionViewportIntent(value) {
    if (value === "session_entry_bottom") return "session_entry_bottom";
    return value === "session_entry" ? "session_entry" : "preserve";
  }

  // Same precedence as mergeRefreshIntents in transport/refresh-scheduler.js:
  // forceFresh/wsPushCaughtUp are OR-merged; viewportIntent keeps the strongest
  // entry intent.
  function mergeSessionRefreshOptions(current = {}, next = {}) {
    const currentViewportIntent = normalizeSessionViewportIntent(current.viewportIntent);
    const nextViewportIntent = normalizeSessionViewportIntent(next.viewportIntent);
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

  function isRefreshStale(lastRefreshAt, staleMs) {
    return !Number.isFinite(lastRefreshAt)
      || lastRefreshAt <= 0
      || Date.now() - lastRefreshAt >= staleMs;
  }

  function estimatePayloadBytes(payload) {
    try {
      const serialized = JSON.stringify(payload);
      if (typeof serialized !== "string") return 0;
      if (typeof TextEncoder === "function") {
        return new TextEncoder().encode(serialized).length;
      }
      return serialized.length;
    } catch {
      return 0;
    }
  }

  function canQueueForegroundRefresh() {
    if (environment.isShareSnapshotMode || !environment.hasPageContext) {
      return false;
    }
    if (environment.isTabHidden()) {
      return false;
    }
    if (environment.visitorMode) {
      return Boolean(
        environment.currentSessionId
        || environment.visitorSessionId,
      );
    }
    return true;
  }

  function getSessionRunState(session) {
    return session?.activity?.run?.state === "running" ? "running" : "idle";
  }

  function hasRenderedEventSnapshot(sessionId) {
    const snapshot = typeof environment.getTimelineRuntimeSnapshot === "function"
      ? environment.getTimelineRuntimeSnapshot(sessionId)
      : null;
    return Boolean(snapshot && Array.isArray(snapshot.items) && snapshot.items.length > 0);
  }

  function shouldRefreshForegroundSessionList({ forceFresh = false } = {}) {
    if (forceFresh) return true;
    if (!environment.hasLoadedSessions) return true;
    if (environment.pendingNavigationState) return true;
    if (environment.currentSessionId && typeof environment.findClientSessionRecord === "function" && !environment.findClientSessionRecord(environment.currentSessionId)) {
      return true;
    }
    return isRefreshStale(environment.lastSessionsListRefreshAt, FOREGROUND_SESSION_LIST_STALE_MS);
  }

  function shouldRefreshForegroundArchivedSessions({
    forceFresh = false,
    refreshedSessionsList = false,
  } = {}) {
    if (!environment.archivedSessionsLoaded || !environment.isArchiveSectionExpanded()) return false;
    if (forceFresh) return true;
    if (refreshedSessionsList) return true;
    return isRefreshStale(environment.lastArchivedSessionsRefreshAt, FOREGROUND_SESSION_LIST_STALE_MS);
  }

  function shouldRefreshForegroundCurrentSession({ forceFresh = false } = {}) {
    if (!environment.currentSessionId) return false;
    if (forceFresh) return true;
    if (!environment.hasAttachedSession) return true;
    if (environment.pendingNavigationState) return true;
    const session = typeof environment.findClientSessionRecord === "function"
      ? environment.findClientSessionRecord(environment.currentSessionId)
      : null;
    if (!session) return true;
    if (getSessionRunState(session) === "running") return true;
    if (!hasRenderedEventSnapshot(environment.currentSessionId)) return true;
    if (environment.lastCurrentSessionRefreshSessionId !== environment.currentSessionId) return true;
    return isRefreshStale(environment.lastCurrentSessionRefreshAt, FOREGROUND_IDLE_SESSION_STALE_MS);
  }

  root.RagentRefreshPolicyCore = {
    normalizeSessionViewportIntent,
    mergeSessionRefreshOptions,
    isRefreshStale,
    estimatePayloadBytes,
    canQueueForegroundRefresh,
    shouldRefreshForegroundSessionList,
    shouldRefreshForegroundArchivedSessions,
    shouldRefreshForegroundCurrentSession,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
