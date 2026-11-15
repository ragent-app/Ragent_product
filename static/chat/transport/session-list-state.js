"use strict";

// Session list state reduction (Stage 2 extraction of
// session-http-list-state.js). The two legacy apply* functions interleave a
// pure reduction with view side effects (store replace / write-back, render
// scheduling, project-view refresh, approval/attention notification). This
// module carries the reduction half: input normalization (sparse records via
// the session-record normalizer), dedup, current-session preservation, and the
// signature comparison that decides whether a render is needed. The side
// effects — including the post-reduction in-place sort, which reads the shell
// comparator — stay in the view layer; the reduced list is returned unsorted
// and the Stage 3 wiring sorts it at the boundary.
//
// The ambient facts are injected via the environment contract
// (root.RagentSessionListStateEnvironment): the current session id is read
// through a getter function so it never freezes at attach time. The record
// normalizer and the comparable-signature helpers are inlined copies of the
// session-record / session-signature ports (self-contained module convention);
// both copies and this module's output are parity-locked against the legacy
// implementation by tests/test-chat-session-list-state-core.mjs.

(function attachRagentSessionListStateCore(root) {
  const DEFAULT_ENVIRONMENT = Object.freeze({
    getCurrentSessionId: null,
    getLocalSessionReviewedAt: null,
    getSessionReviewBaselineAt: null,
  });
  const environment = new Proxy(
    root.RagentSessionListStateEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  // -- inlined copies (self-contained convention) ---------------------------
  // session-record.js's normalizeSessionReviewStamp / normalizeSessionRecord.
  function normalizeSessionReviewStamp(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? new Date(value).toISOString() : "";
    }
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) return "";
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return Number.isFinite(numeric) ? new Date(numeric).toISOString() : "";
    }
    const time = new Date(trimmed).getTime();
    return Number.isFinite(time) ? new Date(time).toISOString() : "";
  }

  function normalizeSessionRecord(session, previous = null) {
    const queueCount = Number.isInteger(session?.activity?.queue?.count)
      ? session.activity.queue.count
      : 0;
    const normalized = { ...session };
    if (!Object.prototype.hasOwnProperty.call(session || {}, "queuedMessages")) {
      if (queueCount > 0 && Array.isArray(previous?.queuedMessages)) {
        normalized.queuedMessages = previous.queuedMessages;
      } else {
        delete normalized.queuedMessages;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(session || {}, "model")) {
      if (typeof previous?.model === "string") {
        normalized.model = previous.model;
      } else {
        delete normalized.model;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(session || {}, "effort")) {
      if (typeof previous?.effort === "string") {
        normalized.effort = previous.effort;
      } else {
        delete normalized.effort;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(session || {}, "thinking")) {
      if (previous?.thinking === true) {
        normalized.thinking = true;
      } else {
        delete normalized.thinking;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(session || {}, "permissionMode")) {
      if (typeof previous?.permissionMode === "string") {
        normalized.permissionMode = previous.permissionMode;
      } else {
        delete normalized.permissionMode;
      }
    }
    const localReviewedAt = normalizeSessionReviewStamp(
      normalized.localReviewedAt
      || previous?.localReviewedAt
      || (typeof environment.getLocalSessionReviewedAt === "function" ? environment.getLocalSessionReviewedAt(normalized.id) : ""),
    );
    if (localReviewedAt) {
      normalized.localReviewedAt = localReviewedAt;
    } else {
      delete normalized.localReviewedAt;
    }
    const reviewBaselineAt = normalizeSessionReviewStamp(
      normalized.reviewBaselineAt
      || previous?.reviewBaselineAt
      || (typeof environment.getSessionReviewBaselineAt === "function" ? environment.getSessionReviewBaselineAt() : ""),
    );
    if (reviewBaselineAt) {
      normalized.reviewBaselineAt = reviewBaselineAt;
    } else {
      delete normalized.reviewBaselineAt;
    }
    return normalized;
  }

  // session-signature.js's buildComparableSessionState /
  // getComparableSessionStateSignature.
  function buildComparableSessionState(value) {
    if (Array.isArray(value)) {
      return value.map((entry) => buildComparableSessionState(entry));
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      const nextValue = buildComparableSessionState(value[key]);
      if (typeof nextValue !== "undefined") {
        normalized[key] = nextValue;
      }
    }
    return normalized;
  }

  function getComparableSessionStateSignature(value) {
    return JSON.stringify(buildComparableSessionState(value));
  }

  // -- session-http-list-state.js pure surface ------------------------------

  // legacy mergeUniqueSessions: the store write-back dedups by id.
  function mergeUniqueSessions(entries = []) {
    const merged = [];
    const seenIds = new Set();
    for (const entry of entries) {
      if (!entry?.id || seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      merged.push(entry);
    }
    return merged;
  }

  // legacy shouldPreserveCurrentSessionAcrossListRefresh: an internal session
  // (e.g. an internal session) that is the current one survives a list
  // refresh that no longer carries it.
  function shouldPreserveCurrentSessionAcrossListRefresh(session) {
    const currentSessionId = typeof environment.getCurrentSessionId === "function"
      ? environment.getCurrentSessionId()
      : "";
    return session?.id
      && session.id === currentSessionId
      && session.isInternalSession === true;
  }

  // The pure reduction shared by applySessionListState (active) and
  // applyArchivedSessionListState (archived). Returns the reduced list plus
  // the before/after signatures and the render decision, mirroring the legacy
  // signature math exactly:
  //   - previousSignature signs { archivedCount, previousSessions };
  //   - sparse records normalize against the previous list (per-session);
  //   - preserveCurrentSession re-appends the previous current internal
  //     session when the incoming list drops it (active mode only);
  //   - the store list is deduped before signing (mergeUniqueSessions);
  //   - the applied archivedCount falls back to the previous count (active)
  //     or the incoming list length (archived, legacy's un-deduped length);
  //   - changed mirrors `!loaded || previousSignature !== nextSignature`.
  // The in-place sort and all side effects stay with the caller.
  function reduceSessionListState(nextSessions, ambient = {}) {
    const {
      previousSessions = [],
      previousArchivedCount,
      nextArchivedCount,
      hasLoadedSessions,
      preserveCurrentSession = false,
      archivedCountFallback = "previous",
    } = ambient;

    const previousCount = Number.isInteger(previousArchivedCount) && previousArchivedCount >= 0
      ? previousArchivedCount
      : 0;
    const previousSignature = getComparableSessionStateSignature({
      archivedCount: previousCount,
      sessions: previousSessions,
    });
    const previousMap = new Map(previousSessions.map((session) => [session.id, session]));
    const normalized = (Array.isArray(nextSessions) ? nextSessions : [])
      .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
      .filter(Boolean);

    if (preserveCurrentSession) {
      const previousCurrentSessionId = typeof environment.getCurrentSessionId === "function"
        ? environment.getCurrentSessionId()
        : "";
      const previousCurrentSession = previousCurrentSessionId ? previousMap.get(previousCurrentSessionId) : null;
      if (
        shouldPreserveCurrentSessionAcrossListRefresh(previousCurrentSession)
        && !normalized.some((session) => session?.id === previousCurrentSession.id)
      ) {
        normalized.push(previousCurrentSession);
      }
    }

    const merged = mergeUniqueSessions(normalized);
    const fallbackCount = archivedCountFallback === "normalized-length" ? normalized.length : previousCount;
    const nextCount = Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0
      ? nextArchivedCount
      : fallbackCount;
    const nextSignature = getComparableSessionStateSignature({
      archivedCount: nextCount,
      sessions: merged,
    });

    return {
      sessions: merged,
      previousSignature,
      nextSignature,
      nextArchivedCount: nextCount,
      changed: hasLoadedSessions !== true || previousSignature !== nextSignature,
    };
  }

  root.RagentSessionListStateCore = {
    reduceSessionListState,
    mergeUniqueSessions,
    shouldPreserveCurrentSessionAcrossListRefresh,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
