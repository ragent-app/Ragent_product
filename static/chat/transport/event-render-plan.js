"use strict";

// Pure event render-plan computation (Stage 2 extraction of session-http.js's
// getEventRenderPlan plus the render-key primitives it shares with
// session-http-helpers.js and core/event-sync.js). Given the fetched visible
// event page, decide how the view should react relative to what is already
// rendered: reset, noop, append, refresh_running_block, or a plain reset when
// the page is unrelated / stale.
//
// Ambient facts the legacy file reads from its shared scope (renderedEventState
// and the empty-state DOM check) are injected via the environment contract
// (root.RagentEventRenderPlanEnvironment), so this module stays free of
// browser globals and runs identically in Node. Locked against the legacy
// implementation by tests/test-chat-event-render-plan-core.mjs.

(function attachRagentEventRenderPlanCore(root) {
  // Live environment: reads always go to the injected object (mutations after
  // attach are visible), falling back to the defaults for absent keys. An
  // Object.assign copy would freeze scalar bindings at attach time, which
  // breaks injected live getters and drifts from the shared legacy scope.
  const DEFAULT_ENVIRONMENT = Object.freeze({
    renderedEventState: {},
    hasRenderedEmptyState: false,
  });
  const environment = new Proxy(
    root.RagentEventRenderPlanEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  function getNormalizedEventRenderType(event) {
    const type = typeof event?.type === "string" ? event.type : "unknown";
    return type === "collapsed_block" ? "thinking_block" : type;
  }

  function isRunningThinkingBlockEvent(event) {
    return getNormalizedEventRenderType(event) === "thinking_block"
      && event?.state === "running";
  }

  function getAttachmentDeliveryRenderKey(event) {
    const explicitKey = typeof event?.deliveryKey === "string" ? event.deliveryKey : "";
    if (explicitKey) return explicitKey;
    const attachments = Array.isArray(event?.attachments)
      ? event.attachments
      : (Array.isArray(event?.images) ? event.images : []);
    return attachments
      .map((attachment, index) => {
        const assetId = typeof attachment?.assetId === "string" ? attachment.assetId.trim() : "";
        if (assetId) return `asset:${assetId}`;
        const filename = typeof attachment?.filename === "string" ? attachment.filename.trim() : "";
        if (filename) return `filename:${filename}`;
        const downloadUrl = typeof attachment?.downloadUrl === "string" ? attachment.downloadUrl.trim() : "";
        if (downloadUrl) return `download:${downloadUrl}`;
        const originalName = typeof attachment?.originalName === "string" ? attachment.originalName.trim() : "";
        const mimeType = typeof attachment?.mimeType === "string" ? attachment.mimeType.trim() : "";
        return `meta:${originalName}:${mimeType}:${index}`;
      })
      .join("|");
  }

  function getEventRenderBaseKey(event) {
    const seq = Number.isInteger(event?.seq) ? event.seq : 0;
    const type = getNormalizedEventRenderType(event);
    if (type === "thinking_block") {
      const state = typeof event?.state === "string" ? event.state : "";
      return `${seq}:${type}:${state}`;
    }
    if (type === "attachment_delivery") {
      const deliveryKey = getAttachmentDeliveryRenderKey(event);
      return deliveryKey ? `${seq}:${type}:${deliveryKey}` : `${seq}:${type}`;
    }
    if (type === "operation") {
      const operationId = typeof event?.operationId === "string" ? event.operationId : "";
      return operationId ? `${seq}:${type}:${operationId}` : `${seq}:${type}`;
    }
    return `${seq}:${type}`;
  }

  function getEventRenderKey(event) {
    const baseKey = getEventRenderBaseKey(event);
    const dynamicBoundary = isRunningThinkingBlockEvent(event) && environment.renderedEventState.runningBlockExpanded === true
      ? `:${Number.isInteger(event?.blockEndSeq) ? event.blockEndSeq : 0}`
      : "";
    return `${baseKey}${dynamicBoundary}`;
  }

  function eventKeyArraysEqual(left, right) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }

  function eventKeyPrefixMatches(prefix, full) {
    if (prefix.length > full.length) return false;
    for (let index = 0; index < prefix.length; index += 1) {
      if (prefix[index] !== full[index]) return false;
    }
    return true;
  }

  function getEventRenderPlan(sessionId, events) {
    const normalizedEvents = Array.isArray(events) ? events : [];
    const latestSeq = getLatestEventSeq(normalizedEvents);
    const nextBaseKeys = normalizedEvents.map((event) => getEventRenderBaseKey(event));
    const nextKeys = normalizedEvents.map((event) => getEventRenderKey(event));
    const rendered = environment.renderedEventState || {};
    const sameSession = rendered.sessionId === sessionId;
    const hasRenderedSnapshot = sameSession && (
      rendered.eventCount > 0
      || environment.hasRenderedEmptyState === true
    );

    if (!sameSession || !hasRenderedSnapshot) {
      return { mode: "reset", events: normalizedEvents };
    }

    const renderedKeys = rendered.eventKeys || [];
    const preservesLoadedOlderPage = normalizedEvents.length > 0
      && normalizedEvents.length < renderedKeys.length
      && eventKeyArraysEqual(
        nextKeys,
        renderedKeys.slice(renderedKeys.length - nextKeys.length),
      );

    if (preservesLoadedOlderPage) {
      return { mode: "noop", events: [], preserveLoadedOlderPage: true };
    }

    if (
      latestSeq < rendered.latestSeq ||
      normalizedEvents.length < rendered.eventCount
    ) {
      return { mode: "reset", events: normalizedEvents };
    }

    if (eventKeyArraysEqual(nextKeys, rendered.eventKeys || [])) {
      return { mode: "noop", events: [] };
    }

    if (
      rendered.runningBlockExpanded === true
      && normalizedEvents.length > 0
      && normalizedEvents.length === rendered.eventCount
      && eventKeyArraysEqual(nextBaseKeys, rendered.eventBaseKeys || [])
    ) {
      const lastEvent = normalizedEvents[normalizedEvents.length - 1];
      if (
        isRunningThinkingBlockEvent(lastEvent)
        && Number.isInteger(lastEvent?.blockEndSeq)
        && lastEvent.blockEndSeq > rendered.latestSeq
      ) {
        return { mode: "refresh_running_block", events: [lastEvent] };
      }
    }

    if (eventKeyPrefixMatches(rendered.eventKeys || [], nextKeys)) {
      const appendedEvents = normalizedEvents.slice((rendered.eventKeys || []).length);
      if (appendedEvents.length > 0) {
        return { mode: "append", events: appendedEvents };
      }
    }

    return { mode: "reset", events: normalizedEvents };
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

  root.RagentEventRenderPlanCore = {
    getNormalizedEventRenderType,
    isRunningThinkingBlockEvent,
    getAttachmentDeliveryRenderKey,
    getEventRenderBaseKey,
    getEventRenderKey,
    eventKeyArraysEqual,
    eventKeyPrefixMatches,
    getEventRenderPlan,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
