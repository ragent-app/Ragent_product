"use strict";

(function attachRagentEventSyncCore(root) {
  function getEventStartSeq(event) {
    if (Number.isInteger(event?.startSeq) && event.startSeq > 0) return event.startSeq;
    if (Number.isInteger(event?.blockStartSeq) && event.blockStartSeq > 0) return event.blockStartSeq;
    if (Number.isInteger(event?.mergedStartSeq) && event.mergedStartSeq > 0) return event.mergedStartSeq;
    return Number.isInteger(event?.seq) ? event.seq : 0;
  }

  function getEventBoundarySeq(event) {
    if (Number.isInteger(event?.endSeq) && event.endSeq > 0) return event.endSeq;
    if (Number.isInteger(event?.blockEndSeq) && event.blockEndSeq > 0) return event.blockEndSeq;
    if (Number.isInteger(event?.mergedEndSeq) && event.mergedEndSeq > 0) return event.mergedEndSeq;
    return Number.isInteger(event?.seq) ? event.seq : 0;
  }

  function getLatestEventSeq(events) {
    return (Array.isArray(events) ? events : []).reduce(
      (latest, event) => Math.max(latest, getEventBoundarySeq(event)),
      0,
    );
  }

  function displayProjectionSupersedesRenderedEvent(events, afterSeq = 0) {
    if (!Number.isInteger(afterSeq) || afterSeq < 1) return false;
    return (Array.isArray(events) ? events : []).some((event) => (
      event?.mergedAssistantRunMessage === true
      && Number.isInteger(event?.mergedStartSeq)
      && event.mergedStartSeq > 0
      && event.mergedStartSeq <= afterSeq
      && getEventBoundarySeq(event) > afterSeq
    ));
  }

  function getNormalizedEventRenderType(event) {
    const type = typeof event?.type === "string" ? event.type : "unknown";
    return type === "collapsed_block" ? "thinking_block" : type;
  }

  function isRunningThinkingBlockEvent(event) {
    return getNormalizedEventRenderType(event) === "thinking_block"
      && event?.state === "running";
  }

  function getAttachmentDeliveryRenderKey(event) {
    if (typeof event?.deliveryKey === "string" && event.deliveryKey) return event.deliveryKey;
    const attachments = Array.isArray(event?.attachments)
      ? event.attachments
      : (Array.isArray(event?.images) ? event.images : []);
    return attachments.map((attachment, index) => {
      const assetId = typeof attachment?.assetId === "string" ? attachment.assetId.trim() : "";
      if (assetId) return `asset:${assetId}`;
      const filename = typeof attachment?.filename === "string" ? attachment.filename.trim() : "";
      if (filename) return `filename:${filename}`;
      const downloadUrl = typeof attachment?.downloadUrl === "string" ? attachment.downloadUrl.trim() : "";
      if (downloadUrl) return `download:${downloadUrl}`;
      const originalName = typeof attachment?.originalName === "string" ? attachment.originalName.trim() : "";
      const mimeType = typeof attachment?.mimeType === "string" ? attachment.mimeType.trim() : "";
      return `meta:${originalName}:${mimeType}:${index}`;
    }).join("|");
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
      return `${seq}:${type}${deliveryKey ? `:${deliveryKey}` : ""}`;
    }
    if (type === "operation") {
      const operationId = typeof event?.operationId === "string" ? event.operationId : "";
      return `${seq}:${type}${operationId ? `:${operationId}` : ""}`;
    }
    return `${seq}:${type}`;
  }

  function getEventRenderKey(event, { runningBlockExpanded = false } = {}) {
    const baseKey = getEventRenderBaseKey(event);
    const dynamicBoundary = isRunningThinkingBlockEvent(event) && runningBlockExpanded
      ? `:${Number.isInteger(event?.blockEndSeq) ? event.blockEndSeq : 0}`
      : "";
    return `${baseKey}${dynamicBoundary}`;
  }

  function filterUnrenderedPersistentEvents(events, requestedAfterSeq = 0, renderedLatestSeq = 0) {
    const requested = Number.isInteger(requestedAfterSeq) ? Math.max(0, requestedAfterSeq) : 0;
    const rendered = Number.isInteger(renderedLatestSeq) ? Math.max(0, renderedLatestSeq) : 0;
    const appliedAfterSeq = Math.max(requested, rendered);
    const unrendered = (Array.isArray(events) ? events : []).filter(
      (event) => getEventBoundarySeq(event) > appliedAfterSeq,
    );
    return {
      events: unrendered,
      appliedAfterSeq,
      overlapsRenderedRange: unrendered.some(
        (event) => getEventStartSeq(event) <= appliedAfterSeq,
      ),
    };
  }

  function deduplicateRealtimeEvents(events, seenProviderEventIds = new Set()) {
    const seen = seenProviderEventIds instanceof Set ? seenProviderEventIds : new Set();
    const output = [];
    for (const event of Array.isArray(events) ? events : []) {
      if (!event || typeof event !== "object") continue;
      if (event.type === "text_delta") {
        const providerEventId = typeof event.providerEventId === "string"
          ? event.providerEventId.trim()
          : "";
        if (providerEventId) {
          const key = `text_delta:${providerEventId}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
      }
      output.push(event);
    }
    return { events: output, seenProviderEventIds: seen };
  }

  const api = {
    getEventStartSeq,
    getEventBoundarySeq,
    getLatestEventSeq,
    displayProjectionSupersedesRenderedEvent,
    getNormalizedEventRenderType,
    isRunningThinkingBlockEvent,
    getEventRenderBaseKey,
    getEventRenderKey,
    filterUnrenderedPersistentEvents,
    deduplicateRealtimeEvents,
  };

  root.RagentEventSyncCore = api;
})(typeof globalThis !== "undefined" ? globalThis : {});
