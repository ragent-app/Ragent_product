"use strict";

// Pure share-snapshot projections (Stage 2 extraction of
// session-http-helpers.js). A shared session is served as an opaque snapshot
// payload (id, display events, per-range event blocks, view meta, session
// meta); these projections derive the synthetic session record the rest of
// the UI renders from it — the "share_snapshot:<id>" session id, the display
// event list, a resolved event block, the newest event stamp (last display
// event timestamp, falling back to the payload createdAt), a view meta value
// with fallback, and finally the full read-only session record (name falls
// back session.name → session.tool → "Shared session snapshot"; activity is
// the idle shape; entryMode is always "read").
//
// The ambient payload is read live via the environment contract
// (root.RagentShareSnapshotEnvironment) — a function, so the current payload
// is observed at call time, never frozen at attach. Locked against the legacy
// implementation by tests/test-chat-share-snapshot-core.mjs.

(function attachRagentShareSnapshotCore(root) {
  const DEFAULT_ENVIRONMENT = Object.freeze({
    getActiveShareSnapshotPayload: null,
  });
  const environment = new Proxy(
    root.RagentShareSnapshotEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  function getActiveShareSnapshotPayload() {
    if (typeof environment.getActiveShareSnapshotPayload === "function") {
      return environment.getActiveShareSnapshotPayload();
    }
    return null;
  }

  function hasShareSnapshotPayload() {
    const payload = getActiveShareSnapshotPayload();
    return !!(payload && typeof payload === "object");
  }

  function buildShareSnapshotSessionId(snapshot = getActiveShareSnapshotPayload()) {
    const rawId = typeof snapshot?.id === "string" ? snapshot.id.trim() : "";
    return rawId ? `share_snapshot:${rawId}` : "share_snapshot";
  }

  function getShareSnapshotDisplayEvents(snapshot = getActiveShareSnapshotPayload()) {
    return Array.isArray(snapshot?.displayEvents) ? snapshot.displayEvents : [];
  }

  function getShareSnapshotEventBlock(startSeq, endSeq, snapshot = getActiveShareSnapshotPayload()) {
    const key = `${startSeq}-${endSeq}`;
    const events = Array.isArray(snapshot?.eventBlocks?.[key])
      ? snapshot.eventBlocks[key]
      : null;
    if (!events) return null;
    return {
      sessionId: buildShareSnapshotSessionId(snapshot),
      startSeq,
      endSeq,
      events,
    };
  }

  function getShareSnapshotLastEventAt(snapshot = getActiveShareSnapshotPayload()) {
    const displayEvents = getShareSnapshotDisplayEvents(snapshot);
    for (let index = displayEvents.length - 1; index >= 0; index -= 1) {
      const stamp = typeof displayEvents[index]?.timestamp === "string"
        ? displayEvents[index].timestamp.trim()
        : "";
      if (stamp) return stamp;
    }
    return typeof snapshot?.createdAt === "string" && snapshot.createdAt.trim()
      ? snapshot.createdAt.trim()
      : null;
  }

  function getShareSnapshotViewValue(key, fallback = "") {
    const value = getActiveShareSnapshotPayload()?.view?.[key];
    return typeof value === "string" && value.trim()
      ? value.trim()
      : fallback;
  }

  function buildShareSnapshotSessionRecord(snapshot = getActiveShareSnapshotPayload()) {
    if (!(snapshot && typeof snapshot === "object")) return null;
    const displayEvents = getShareSnapshotDisplayEvents(snapshot);
    const name = typeof snapshot?.session?.name === "string" && snapshot.session.name.trim()
      ? snapshot.session.name.trim()
      : (typeof snapshot?.session?.tool === "string" && snapshot.session.tool.trim()
        ? snapshot.session.tool.trim()
        : "Shared session snapshot");
    const lastEventAt = getShareSnapshotLastEventAt(snapshot);
    return {
      id: buildShareSnapshotSessionId(snapshot),
      name,
      tool: typeof snapshot?.session?.tool === "string" ? snapshot.session.tool.trim() : "",
      created: typeof snapshot?.session?.created === "string" && snapshot.session.created.trim()
        ? snapshot.session.created.trim()
        : (typeof snapshot?.createdAt === "string" && snapshot.createdAt.trim()
          ? snapshot.createdAt.trim()
          : null),
      updatedAt: lastEventAt,
      lastEventAt,
      sourceId: "share_snapshot",
      sourceName: getShareSnapshotViewValue("badge", "Shared Snapshot"),
      entryMode: "read",
      messageCount: displayEvents.filter((event) => event?.type === "message").length,
      activity: {
        run: { state: "idle" },
        queue: { state: "idle", count: 0 },
        compact: { state: "idle" },
      },
    };
  }

  root.RagentShareSnapshotCore = {
    hasShareSnapshotPayload,
    buildShareSnapshotSessionId,
    getShareSnapshotDisplayEvents,
    getShareSnapshotEventBlock,
    getShareSnapshotLastEventAt,
    getShareSnapshotViewValue,
    buildShareSnapshotSessionRecord,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
