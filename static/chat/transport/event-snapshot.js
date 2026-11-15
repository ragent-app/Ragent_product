"use strict";

// Pure event-page URL building, visible-event snapshot cache and refresh
// decision helpers (Stage 2 extraction of session-http.js, with the seq /
// pagination primitives shared with session-http-helpers.js and
// core/event-sync.js).
//
// The snapshot cache mirrors the legacy rendered-event cache semantics: one
// snapshot per session holding the currently rendered visible events,
// pagination, run state and viewport facts, so a re-entry (or WS delta
// application) can restore the timeline without refetching. TTL pruning keeps
// the cache bounded; every read refreshes recency.
//
// Ambient facts the legacy file reads from its shared scope
// (renderedEventState, currentSessionId, read-only share mode, expanded
// operation ids) are injected via the environment contract
// (root.RagentEventSnapshotEnvironment) so this module stays free of browser
// globals and runs identically in Node. Locked against the legacy
// implementation by tests/test-chat-event-snapshot-core.mjs.

(function attachRagentEventSnapshotCore(root) {
  const EVENT_DELTA_REFRESH_ENABLED = true;
  const SESSION_EVENT_PAGE_SIZE = 50;
  const SESSION_EVENT_SNAPSHOT_CACHE_TTL_MS = 2 * 60 * 1000;
  const SESSION_EVENT_SNAPSHOT_CACHE_LIMIT = 8;

  // Live environment: reads always go to the injected object (mutations after
  // attach are visible), falling back to the defaults for absent keys. An
  // Object.assign copy would freeze scalar bindings at attach time, which
  // breaks injected live getters and drifts from the shared legacy scope.
  const DEFAULT_ENVIRONMENT = Object.freeze({
    currentSessionId: "",
    getCurrentSessionId: null,
    renderedEventState: {},
    hasRenderedEmptyState: false,
    isShareSnapshotReadOnlyMode: () => false,
    getExpandedOperationIds: null,
  });
  const environment = new Proxy(
    root.RagentEventSnapshotEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  // currentSessionId is a scalar in the legacy shared scope; prefer a getter
  // so an injected live binding (function) is read fresh on every call and a
  // plain static value still works.
  function getCurrentSessionId() {
    if (typeof environment.getCurrentSessionId === "function") {
      return environment.getCurrentSessionId();
    }
    return environment.currentSessionId;
  }

  function getEventStartSeq(event) {
    if (Number.isInteger(event?.startSeq) && event.startSeq > 0) {
      return event.startSeq;
    }
    if (Number.isInteger(event?.blockStartSeq) && event.blockStartSeq > 0) {
      return event.blockStartSeq;
    }
    if (Number.isInteger(event?.mergedStartSeq) && event.mergedStartSeq > 0) {
      return event.mergedStartSeq;
    }
    return Number.isInteger(event?.seq) ? event.seq : 0;
  }

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

  function getEarliestEventSeq(events) {
    let earliestSeq = 0;
    for (const event of events || []) {
      const startSeq = getEventStartSeq(event);
      if (startSeq > 0 && (!earliestSeq || startSeq < earliestSeq)) {
        earliestSeq = startSeq;
      }
    }
    return earliestSeq;
  }

  function normalizeRenderedPagination(pagination, events) {
    const eventList = Array.isArray(events) ? events : [];
    const earliestSeq = Number.isInteger(pagination?.oldestSeq)
      ? pagination.oldestSeq
      : getEarliestEventSeq(eventList);
    return {
      earliestSeq,
      nextBeforeSeq: Number.isInteger(pagination?.nextBeforeSeq) && pagination.nextBeforeSeq > 0
        ? pagination.nextBeforeSeq
        : (earliestSeq > 0 ? earliestSeq : null),
      latestSeq: Number.isInteger(pagination?.latestSeq)
        ? pagination.latestSeq
        : getLatestEventSeq(eventList),
      hasMoreBefore: pagination?.hasMoreBefore === true,
    };
  }

  function buildSessionVisibleEventsPageUrl(sessionId, {
    direction = "latest",
    beforeSeq = null,
    afterSeq = null,
    limit = SESSION_EVENT_PAGE_SIZE,
  } = {}) {
    const query = new URLSearchParams();
    query.set("filter", "visible");
    if (Number.isInteger(limit) && limit > 0) {
      query.set("limit", String(limit));
    }
    const normalizedDirection = typeof direction === "string" ? direction.trim() : "";
    if (normalizedDirection) {
      query.set("direction", normalizedDirection);
    }
    if (Number.isInteger(beforeSeq) && beforeSeq > 0) {
      query.set("beforeSeq", String(beforeSeq));
    }
    if (Number.isInteger(afterSeq) && afterSeq > 0) {
      query.set("afterSeq", String(afterSeq));
    }
    return `/api/sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`;
  }

  function mergeOperationUpdatesIntoEvents(events, operationUpdates) {
    const updates = new Map(
      (Array.isArray(operationUpdates) ? operationUpdates : [])
        .filter((event) => event?.type === "operation" && typeof event.operationId === "string")
        .map((event) => [event.operationId, event]),
    );
    if (updates.size === 0) return Array.isArray(events) ? events.slice() : [];
    return (Array.isArray(events) ? events : []).map((event) => {
      if (event?.type !== "operation") return event;
      const update = updates.get(event.operationId);
      return update || event;
    });
  }

  function ensureSessionEventSnapshotCache() {
    if (!(root.__sessionEventSnapshotCache instanceof Map)) {
      root.__sessionEventSnapshotCache = new Map();
    }
    return root.__sessionEventSnapshotCache;
  }

  function pruneSessionEventSnapshotCache(cache = ensureSessionEventSnapshotCache()) {
    const now = Date.now();
    for (const [sessionId, snapshot] of cache.entries()) {
      if (now - Number(snapshot?.updatedAt || 0) > SESSION_EVENT_SNAPSHOT_CACHE_TTL_MS) {
        cache.delete(sessionId);
      }
    }
    while (cache.size > SESSION_EVENT_SNAPSHOT_CACHE_LIMIT) {
      const oldestSessionId = cache.keys().next().value;
      if (!oldestSessionId) break;
      cache.delete(oldestSessionId);
    }
  }

  function getSessionEventSnapshot(sessionId) {
    if (!sessionId) return null;
    const cache = ensureSessionEventSnapshotCache();
    pruneSessionEventSnapshotCache(cache);
    const snapshot = cache.get(sessionId) || null;
    if (!snapshot) return null;
    cache.delete(sessionId);
    cache.set(sessionId, snapshot);
    return snapshot;
  }

  function hasRenderedEventSnapshot(sessionId) {
    const rendered = environment.renderedEventState || {};
    const sameSession = rendered.sessionId === sessionId;
    return sameSession && (
      rendered.eventCount > 0
      || environment.hasRenderedEmptyState === true
    );
  }

  function getSessionRunState(session) {
    return session?.activity?.run?.state === "running" ? "running" : "idle";
  }

  function shouldFetchSessionEventsForRefresh(sessionId, session) {
    const rendered = environment.renderedEventState || {};
    if (!Number.isInteger(rendered.eventCount) || rendered.eventCount === 0) {
      return true;
    }
    const runState = getSessionRunState(session);
    if (runState !== "running") return true;
    if (!hasRenderedEventSnapshot(sessionId)) return true;
    if (rendered.runState !== "running") return true;
    if (rendered.runningBlockExpanded === true) return true;
    const latestSeq = Number.isInteger(session?.latestSeq) ? session.latestSeq : 0;
    return latestSeq > rendered.latestSeq;
  }

  function shouldAttemptEventDeltaFetch(
    sessionId,
    { runState = "idle" } = {},
  ) {
    if (!EVENT_DELTA_REFRESH_ENABLED) return false;
    if (environment.isShareSnapshotReadOnlyMode()) return false;
    if (getCurrentSessionId() !== sessionId) return false;
    const rendered = environment.renderedEventState || {};
    if (rendered.sessionId !== sessionId) return false;
    if (!hasRenderedEventSnapshot(sessionId)) return false;
    return Number.isInteger(rendered.latestSeq) && rendered.latestSeq >= 0;
  }

  function updateSessionEventSnapshotOperations(sessionId, operationUpdates, runActivity = undefined) {
    const snapshot = getSessionEventSnapshot(sessionId);
    if (!snapshot) return null;
    snapshot.events = mergeOperationUpdatesIntoEvents(snapshot.events, operationUpdates);
    if (runActivity !== undefined) snapshot.runActivity = runActivity || null;
    snapshot.updatedAt = Date.now();
    return snapshot;
  }

  function setSessionEventSnapshot(sessionId, events, {
    runState = "idle",
    pagination = null,
    scrollTop = null,
    runActivity = undefined,
    expandedOperationIds = null,
  } = {}) {
    if (!sessionId) return null;
    const cache = ensureSessionEventSnapshotCache();
    const previous = cache.get(sessionId) || null;
    const eventList = Array.isArray(events) ? events.slice() : [];
    const normalizedPagination = normalizeRenderedPagination(pagination, eventList);
    const rendered = environment.renderedEventState || {};
    const snapshot = {
      events: eventList,
      pagination: normalizedPagination,
      runState: runState === "running" ? "running" : "idle",
      runActivity: runActivity === undefined
        ? (rendered.sessionId === sessionId
          ? rendered.runActivity
          : previous?.runActivity || null)
        : (runActivity || null),
      expandedOperationIds: expandedOperationIds instanceof Set
        ? [...expandedOperationIds]
        : (rendered.sessionId === sessionId && typeof environment.getExpandedOperationIds === "function"
          ? [...environment.getExpandedOperationIds()]
          : (Array.isArray(previous?.expandedOperationIds) ? previous.expandedOperationIds.slice() : [])),
      runningBlockExpanded: rendered.sessionId === sessionId
        ? rendered.runningBlockExpanded === true
        : previous?.runningBlockExpanded === true,
      scrollTop: Number.isFinite(scrollTop)
        ? Math.max(0, scrollTop)
        : Math.max(0, Number(previous?.scrollTop) || 0),
      updatedAt: Date.now(),
    };
    cache.delete(sessionId);
    cache.set(sessionId, snapshot);
    pruneSessionEventSnapshotCache(cache);
    return snapshot;
  }

  function appendSessionEventSnapshotDelta(sessionId, events, {
    runState = "idle",
    latestSeq = null,
    operationUpdates = [],
    runActivity = undefined,
  } = {}) {
    const snapshot = getSessionEventSnapshot(sessionId);
    if (!snapshot) return null;
    const deltaEvents = Array.isArray(events) ? events : [];
    const nextEvents = mergeOperationUpdatesIntoEvents(snapshot.events, operationUpdates).concat(deltaEvents);
    return setSessionEventSnapshot(sessionId, nextEvents, {
      runState,
      runActivity,
      pagination: {
        ...snapshot.pagination,
        latestSeq: Number.isInteger(latestSeq)
          ? latestSeq
          : Math.max(snapshot.pagination?.latestSeq || 0, getLatestEventSeq(deltaEvents)),
      },
      scrollTop: snapshot.scrollTop,
    });
  }

  function prependSessionEventSnapshotPage(sessionId, events, {
    runState = "idle",
    pagination = null,
  } = {}) {
    const snapshot = getSessionEventSnapshot(sessionId);
    if (!snapshot) return null;
    const pageEvents = Array.isArray(events) ? events : [];
    return setSessionEventSnapshot(sessionId, pageEvents.concat(snapshot.events), {
      runState,
      runActivity: snapshot.runActivity,
      pagination: {
        ...snapshot.pagination,
        ...pagination,
        latestSeq: Math.max(
          Number(snapshot.pagination?.latestSeq) || 0,
          Number(pagination?.latestSeq) || 0,
        ),
      },
      scrollTop: snapshot.scrollTop,
    });
  }

  // session-http.js's getRenderedOlderPageEventRange: the [minSeq, maxSeq]
  // span of a fetched older page (for the older-page append anchor), built
  // from the same seq primitives above — zero new environment fields.
  function getRenderedOlderPageEventRange(events) {
    let minSeq = 0;
    let maxSeq = 0;
    for (const event of events || []) {
      const startSeq = getEventStartSeq(event);
      const endSeq = getEventBoundarySeq(event);
      if (startSeq > 0 && (!minSeq || startSeq < minSeq)) minSeq = startSeq;
      if (endSeq > maxSeq) maxSeq = endSeq;
    }
    return { minSeq, maxSeq };
  }

  // helpers' filterUnrenderedPersistentEvents: splits a fetched event page
  // into the slice strictly after the rendered range (plus the applied-after
  // seq and an overlap flag for delta safety), so a full reload does not
  // re-append events the view already shows.
  function filterUnrenderedPersistentEvents(sessionId, events, requestedAfterSeq = 0) {
    const normalizedRequestedAfterSeq = Number.isInteger(requestedAfterSeq)
      ? Math.max(0, requestedAfterSeq)
      : 0;
    const renderedLatestSeq = environment.renderedEventState?.sessionId === sessionId
      && Number.isInteger(environment.renderedEventState?.latestSeq)
      ? environment.renderedEventState.latestSeq
      : 0;
    const appliedAfterSeq = Math.max(normalizedRequestedAfterSeq, renderedLatestSeq);
    const unrenderedEvents = (Array.isArray(events) ? events : []).filter(
      (event) => getEventBoundarySeq(event) > appliedAfterSeq,
    );
    return {
      events: unrenderedEvents,
      appliedAfterSeq,
      overlapsRenderedRange: unrenderedEvents.some(
        (event) => getEventStartSeq(event) <= appliedAfterSeq,
      ),
    };
  }

  root.RagentEventSnapshotCore = {
    getEventStartSeq,
    getEventBoundarySeq,
    getLatestEventSeq,
    getEarliestEventSeq,
    normalizeRenderedPagination,
    filterUnrenderedPersistentEvents,
    getRenderedOlderPageEventRange,
    buildSessionVisibleEventsPageUrl,
    mergeOperationUpdatesIntoEvents,
    ensureSessionEventSnapshotCache,
    pruneSessionEventSnapshotCache,
    getSessionEventSnapshot,
    hasRenderedEventSnapshot,
    getSessionRunState,
    shouldFetchSessionEventsForRefresh,
    shouldAttemptEventDeltaFetch,
    updateSessionEventSnapshotOperations,
    setSessionEventSnapshot,
    appendSessionEventSnapshotDelta,
    prependSessionEventSnapshotPage,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
