"use strict";

// Pure session-record normalization (Stage 2 extraction of session-http.js).
// Server-side session records are sparse: fields that have not changed arrive
// absent, so the client re-applies the previous record's values for the
// fields it must not drop (queuedMessages count, model/effort/thinking/
// permissionMode) and re-anchors the local review markers (localReviewedAt
// from the previous record or the local store, reviewBaselineAt from the
// previous record or the ambient baseline). The result is the record the
// session list and sidebar render from.
//
// Also carries realtime.js's buildOptimisticArchivedSession — the pure
// optimistic archive / un-archive transform (the coordinator that upserts
// and re-renders stays in the view layer).
//
// The two local-store lookups are injected via the environment contract
// (root.RagentSessionRecordEnvironment); everything else is pure. Locked
// against the legacy implementation by tests/test-chat-session-record-core.mjs.

(function attachRagentSessionRecordCore(root) {
  const DEFAULT_ENVIRONMENT = Object.freeze({
    getLocalSessionReviewedAt: null,
    getSessionReviewBaselineAt: null,
  });
  const environment = new Proxy(
    root.RagentSessionRecordEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

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

  // realtime.js's buildOptimisticArchivedSession: the optimistic archive /
  // un-archive transform applied to the session record before the coordinator
  // upserts and re-renders (the archive timestamp is stamped once, pinned is
  // dropped while archived; un-archiving removes both archive markers).
  function buildOptimisticArchivedSession(session, archived) {
    if (!session?.id) return null;
    const next = { ...session };
    if (archived) {
      next.archived = true;
      next.archivedAt = next.archivedAt || new Date().toISOString();
      delete next.pinned;
      return next;
    }
    delete next.archived;
    delete next.archivedAt;
    return next;
  }

  root.RagentSessionRecordCore = {
    normalizeSessionRecord,
    buildOptimisticArchivedSession,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
