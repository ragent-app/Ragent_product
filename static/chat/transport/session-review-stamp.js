"use strict";

// Pure session review-stamp normalization (Stage 2 extraction of
// session-http.js). The sidebar "reviewed" indicator compares event
// timestamps (lastActivityAt / lastEventAt / updatedAt / created) against the
// review markers
// (lastReviewedAt / localReviewedAt / reviewBaselineAt); every stamp entering
// that comparison must be a canonical ISO string, or "" when unusable. These
// four functions are the whole stamp algebra: normalize each stamp form
// (epoch ms number, numeric string, ISO string, any Date-parseable string),
// read its epoch ms for ordering, pick a session's newest event stamp, and
// pick the effective (newest) review marker.
//
// Fully pure: no environment contract, no platform hooks. Locked against the
// legacy implementation by tests/test-chat-session-review-stamp-core.mjs.

(function attachRagentSessionReviewStampCore(root) {
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

  function getSessionReviewStampTime(value) {
    const time = new Date(value || "").getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function getSessionReviewStamp(session) {
    const hasActivityStamp = Object.prototype.hasOwnProperty.call(session || {}, "lastActivityAt");
    const primaryStamp = hasActivityStamp ? session?.lastActivityAt : session?.lastEventAt;
    return normalizeSessionReviewStamp(primaryStamp)
      || normalizeSessionReviewStamp(session?.updatedAt)
      || normalizeSessionReviewStamp(session?.created)
      || "";
  }

  function getEffectiveSessionReviewedAt(session) {
    const candidates = [
      normalizeSessionReviewStamp(session?.lastReviewedAt),
      normalizeSessionReviewStamp(session?.localReviewedAt),
      normalizeSessionReviewStamp(session?.reviewBaselineAt),
    ].filter(Boolean);
    let best = "";
    let bestTime = 0;
    for (const candidate of candidates) {
      const time = getSessionReviewStampTime(candidate);
      if (time > bestTime) {
        best = candidate;
        bestTime = time;
      }
    }
    return best;
  }

  root.RagentSessionReviewStampCore = {
    normalizeSessionReviewStamp,
    getSessionReviewStampTime,
    getSessionReviewStamp,
    getEffectiveSessionReviewedAt,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
