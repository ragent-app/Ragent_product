"use strict";

// Pure session-entry mode decisions (Stage 2 extraction of
// session-http-helpers.js). When a session is opened, the viewport must land
// either at the top (read-only / share-snapshot entry), at the bottom (a
// "session_entry_bottom" intent, e.g. a fresh send or a request to jump to
// the latest turn) or wherever it was ("preserve"). These four functions
// resolve the entry mode ("read" vs "resume") from the record, the share
// snapshot state and the normalized viewport intent, and answer the two
// landing questions. The viewport-intent normalizer is built in (the legacy
// helpers version without trimming — the same shape refresh-policy.js
// embeds, locked by its own parity battery).
//
// Platform hooks (current-session id, share snapshot state, the session
// record lookup) are injected via the environment contract
// (root.RagentSessionEntryModeEnvironment). Locked against the legacy
// implementation by tests/test-chat-session-entry-mode-core.mjs.

(function attachRagentSessionEntryModeCore(root) {
  const DEFAULT_ENVIRONMENT = Object.freeze({
    currentSessionId: "",
    isShareSnapshotMode: false,
    getClientSessionRecord: null,
  });
  const environment = new Proxy(
    root.RagentSessionEntryModeEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  function resolveSessionEntryMode(value) {
    return value === "read" ? "read" : "resume";
  }

  function getClientSessionRecord(sessionId) {
    if (typeof environment.getClientSessionRecord === "function") {
      return environment.getClientSessionRecord(sessionId);
    }
    return null;
  }

  function getCurrentSessionEntryMode(sessionId = environment.currentSessionId) {
    if (environment.isShareSnapshotMode === true) return "read";
    return resolveSessionEntryMode(getClientSessionRecord(sessionId)?.entryMode);
  }

  function normalizeSessionViewportIntent(value) {
    if (value === "session_entry_bottom") return "session_entry_bottom";
    return value === "session_entry" ? "session_entry" : "preserve";
  }

  function shouldOpenCurrentSessionFromTop({
    sessionId = environment.currentSessionId,
    viewportIntent = "preserve",
  } = {}) {
    if (environment.isShareSnapshotMode === true) {
      return true;
    }
    if (normalizeSessionViewportIntent(viewportIntent) !== "session_entry") {
      return false;
    }
    return getCurrentSessionEntryMode(sessionId) === "read";
  }

  function shouldOpenCurrentSessionAtBottom({ viewportIntent = "preserve" } = {}) {
    if (environment.isShareSnapshotMode === true) return false;
    return normalizeSessionViewportIntent(viewportIntent) === "session_entry_bottom";
  }

  root.RagentSessionEntryModeCore = {
    resolveSessionEntryMode,
    getCurrentSessionEntryMode,
    normalizeSessionViewportIntent,
    shouldOpenCurrentSessionFromTop,
    shouldOpenCurrentSessionAtBottom,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
