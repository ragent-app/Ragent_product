"use strict";

// Pure realtime event normalization (Stage 2 extraction of realtime.js).
// Owns the incoming-message pipeline that must stay stable across channel
// restarts and session switches:
//
//   - Event-id dedup: text_delta events carry providerEventId; the same id
//     replayed by a reconnect is dropped. The seen set resets on session
//     switch together with the text streams.
//   - Text-stream state machine: consecutive text_delta events for the same
//     stream (runId/responseId + blockIndex) are accumulated, overlapped
//     against previously streamed text, and emitted as the minimal suffix the
//     view has not seen yet. Finalized streams (closed by an assistant
//     message) stop accepting deltas; batch signatures suppress replays.
//   - Status scrubbing: "Session started (…)" status events and
//     providerLifecycle session_started markers are dropped from the visible
//     projection; everything else passes through.
//
// Channel URL resolution and approval-error classification are pure as well.
// Platform hooks (visitor-mode URL rewriting) are injected via the
// environment contract (root.RagentWsEventsEnvironment), so this module
// stays free of browser globals and runs identically in Node. Locked against
// the legacy implementation by tests/test-chat-ws-events-core.mjs.

(function attachRagentWsEventsCore(root) {
  const REALTIME_EVENT_ID_CACHE_LIMIT = 8192;
  const REALTIME_TEXT_STREAM_CACHE_LIMIT = 128;
  const REALTIME_TEXT_BATCH_CACHE_LIMIT = 64;
  const REALTIME_FINALIZED_TEXT_STREAM_CACHE_LIMIT = 256;
  const REALTIME_TEXT_REPLAY_MIN_CHARS = 12;

  // Live environment: reads always go to the injected object (mutations after
  // attach are visible), falling back to the defaults for absent keys. An
  // Object.assign copy would freeze scalar bindings at attach time, which
  // breaks injected live getters and drifts from the shared legacy scope.
  const DEFAULT_ENVIRONMENT = Object.freeze({
    withVisitorModeUrl: null,
  });
  const environment = new Proxy(
    root.RagentWsEventsEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  const seenRealtimeEventIds = new Set();
  const realtimeTextStreams = new Map();
  const finalizedRealtimeTextStreams = new Set();
  let seenRealtimeEventSessionId = "";

  function resolveWsUrl(path) {
    if (typeof environment.withVisitorModeUrl === "function") {
      return environment.withVisitorModeUrl(path);
    }
    return typeof path === "string" ? path : String(path || "");
  }

  function rememberRealtimeEventId(eventId) {
    if (!eventId) return;
    seenRealtimeEventIds.add(eventId);
    while (seenRealtimeEventIds.size > REALTIME_EVENT_ID_CACHE_LIMIT) {
      const oldestEventId = seenRealtimeEventIds.values().next().value;
      if (!oldestEventId) break;
      seenRealtimeEventIds.delete(oldestEventId);
    }
  }

  function getRealtimeTextStreamIdentityKeys(event) {
    const keys = [];
    const runId = typeof event?.runId === "string" ? event.runId.trim() : "";
    const responseId = typeof event?.responseId === "string" ? event.responseId.trim() : "";
    if (runId) keys.push(`run:${runId}`);
    if (responseId) keys.push(`response:${responseId}`);
    return keys;
  }

  function getRealtimeTextStreamKeys(event) {
    const blockIndex = Number.isInteger(event?.blockIndex) ? event.blockIndex : 0;
    return getRealtimeTextStreamIdentityKeys(event).map((identity) => `${identity}:block:${blockIndex}`);
  }

  function getRealtimeTextStreamWildcardKeys(event) {
    return getRealtimeTextStreamIdentityKeys(event).map((identity) => `${identity}:block:*`);
  }

  function getRealtimeTextStreamKey(event) {
    if (event?.type !== "text_delta") return "";
    const runtimeFamily = typeof event.runtimeFamily === "string" ? event.runtimeFamily.trim() : "";
    if (!runtimeFamily.startsWith("claude-stream-json")) return "";
    return getRealtimeTextStreamKeys(event)[0] || "";
  }

  function rememberFinalizedRealtimeTextStreamKey(streamKey) {
    if (!streamKey) return;
    finalizedRealtimeTextStreams.add(streamKey);
    while (finalizedRealtimeTextStreams.size > REALTIME_FINALIZED_TEXT_STREAM_CACHE_LIMIT) {
      const oldestStreamKey = finalizedRealtimeTextStreams.values().next().value;
      if (!oldestStreamKey) break;
      finalizedRealtimeTextStreams.delete(oldestStreamKey);
    }
  }

  function closeRealtimeTextStreamsForMessage(event) {
    if (event?.type !== "message" || event.role !== "assistant") return;
    const streamKeys = Number.isInteger(event.blockIndex)
      ? getRealtimeTextStreamKeys(event)
      : getRealtimeTextStreamWildcardKeys(event);
    for (const streamKey of streamKeys) {
      rememberFinalizedRealtimeTextStreamKey(streamKey);
      if (streamKey.endsWith(":block:*")) {
        const streamPrefix = streamKey.slice(0, -1);
        for (const cachedStreamKey of Array.from(realtimeTextStreams.keys())) {
          if (cachedStreamKey.startsWith(streamPrefix)) realtimeTextStreams.delete(cachedStreamKey);
        }
      } else {
        realtimeTextStreams.delete(streamKey);
      }
    }
  }

  function isRealtimeTextDeltaFinalized(event) {
    const streamKeys = getRealtimeTextStreamKeys(event);
    const wildcardKeys = getRealtimeTextStreamWildcardKeys(event);
    return streamKeys.some((streamKey) => finalizedRealtimeTextStreams.has(streamKey))
      || wildcardKeys.some((streamKey) => finalizedRealtimeTextStreams.has(streamKey));
  }

  function getRealtimeTextStream(streamKey) {
    if (!streamKey) return null;
    let stream = realtimeTextStreams.get(streamKey);
    if (!stream) {
      stream = { text: "", batchSignatures: new Set() };
      realtimeTextStreams.set(streamKey, stream);
      while (realtimeTextStreams.size > REALTIME_TEXT_STREAM_CACHE_LIMIT) {
        const oldestStreamKey = realtimeTextStreams.keys().next().value;
        if (!oldestStreamKey) break;
        realtimeTextStreams.delete(oldestStreamKey);
      }
    }
    return stream;
  }

  function rememberRealtimeTextBatch(stream, signature) {
    if (!stream || !signature) return;
    stream.batchSignatures.add(signature);
    while (stream.batchSignatures.size > REALTIME_TEXT_BATCH_CACHE_LIMIT) {
      const oldestSignature = stream.batchSignatures.values().next().value;
      if (!oldestSignature) break;
      stream.batchSignatures.delete(oldestSignature);
    }
  }

  function findRealtimeTextOverlap(previousText, nextText) {
    const maxOverlap = Math.min(previousText.length, nextText.length);
    for (let length = maxOverlap; length >= REALTIME_TEXT_REPLAY_MIN_CHARS; length -= 1) {
      if (previousText.endsWith(nextText.slice(0, length))) return length;
    }
    return 0;
  }

  function filterRealtimeTextDeltaGroups(events) {
    const output = [];
    for (let index = 0; index < events.length;) {
      const event = events[index];
      const streamKey = getRealtimeTextStreamKey(event);
      if (!streamKey) {
        output.push(event);
        index += 1;
        continue;
      }

      const group = [];
      while (index < events.length && getRealtimeTextStreamKey(events[index]) === streamKey) {
        group.push(events[index]);
        index += 1;
      }
      const chunk = group.map((item) => (typeof item.text === "string" ? item.text : "")).join("");
      if (!chunk) continue;

      const stream = getRealtimeTextStream(streamKey);
      const signature = `${group.length}:${chunk}`;
      if (
        chunk.length >= REALTIME_TEXT_REPLAY_MIN_CHARS
        && stream.batchSignatures.has(signature)
      ) {
        continue;
      }

      let overlap = 0;
      if (chunk.length >= REALTIME_TEXT_REPLAY_MIN_CHARS && stream.text) {
        if (chunk.startsWith(stream.text)) {
          overlap = stream.text.length;
        } else {
          overlap = findRealtimeTextOverlap(stream.text, chunk);
        }
      }
      const suffix = overlap > 0 ? chunk.slice(overlap) : chunk;
      rememberRealtimeTextBatch(stream, signature);
      if (!suffix) continue;

      stream.text += suffix;
      if (overlap > 0 || group.length > 1) {
        output.push({ ...group[0], text: suffix });
      } else {
        output.push(group[0]);
      }
    }
    return output;
  }

  function filterRealtimeSessionEvents(events, sessionId = "") {
    const normalizedSessionId = typeof sessionId === "string" ? sessionId : "";
    if (normalizedSessionId !== seenRealtimeEventSessionId) {
      seenRealtimeEventSessionId = normalizedSessionId;
      seenRealtimeEventIds.clear();
      realtimeTextStreams.clear();
      finalizedRealtimeTextStreams.clear();
    }
    const filtered = (Array.isArray(events) ? events : []).filter((event) => {
      if (!event || typeof event !== "object") return false;
      if (event.type === "text_delta") {
        if (isRealtimeTextDeltaFinalized(event)) return false;
        const providerEventId = typeof event.providerEventId === "string"
          ? event.providerEventId.trim()
          : "";
        if (providerEventId) {
          const eventId = `text_delta:${providerEventId}`;
          if (seenRealtimeEventIds.has(eventId)) return false;
          rememberRealtimeEventId(eventId);
        }
        return true;
      }
      closeRealtimeTextStreamsForMessage(event);
      if (event.type !== "status") return true;
      if (event.providerLifecycle === "session_started") return false;
      const content = typeof event.content === "string" ? event.content.trim() : "";
      return !/^Session started \([^)]+\)$/i.test(content);
    });
    return filterRealtimeTextDeltaGroups(filtered);
  }

  function filterRealtimePersistentEvents(events) {
    return (Array.isArray(events) ? events : []).filter((event) => event?.type !== "text_delta");
  }

  // True when the server says the approval target no longer exists or its run
  // is over — the UI must treat the approval as resolved instead of failing.
  function isApprovalAlreadyEndedError(error) {
    const code = String(error?.code || "").toUpperCase();
    if (["APPROVAL_NOT_FOUND", "RUN_TERMINAL", "RUN_NOT_FOUND"].includes(code)) return true;
    const status = Number(error?.status || 0);
    return status === 404 || status === 409 || status === 410;
  }

  root.RagentWsEventsCore = {
    resolveWsUrl,
    rememberRealtimeEventId,
    getRealtimeTextStreamIdentityKeys,
    getRealtimeTextStreamKeys,
    getRealtimeTextStreamWildcardKeys,
    getRealtimeTextStreamKey,
    rememberFinalizedRealtimeTextStreamKey,
    closeRealtimeTextStreamsForMessage,
    isRealtimeTextDeltaFinalized,
    getRealtimeTextStream,
    rememberRealtimeTextBatch,
    findRealtimeTextOverlap,
    filterRealtimeTextDeltaGroups,
    filterRealtimeSessionEvents,
    filterRealtimePersistentEvents,
    isApprovalAlreadyEndedError,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
