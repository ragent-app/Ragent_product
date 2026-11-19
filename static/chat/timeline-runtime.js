"use strict";

// The browser side of the Android timeline contract.
//
// Transports only submit protocol events to the projector. The projector
// returns one immutable item list. This module is the only code allowed to
// turn that list into transcript DOM: one item id owns one root node, and a
// revision updates that root in place.

(function attachRagentTimelineRuntime(root) {
  const Projector = root.RagentTimelineProjector?.TimelineProjector;
  let projector = null;
  let activeSessionId = "";
  const MAX_CACHED_PROJECTORS = 8;
  const projectorCache = new Map();
  let itemNodes = new Map();
  let syntheticItemIds = new Set();
  let rendering = false;
  let historyRestoreToken = 0;
  let pendingIncrementalCommit = null;
  // A newly-created projector has an empty snapshot too. Keep an explicit
  // commit bit so an attached empty session is distinguishable from a session
  // whose first history page has not rendered yet.
  let hasCommittedSnapshot = false;
  // Keep the projector's complete durable model for pagination/reconciliation,
  // but cap the number of transcript roots mounted at once. Long sessions can
  // contain tens of thousands of rows; rendering every historical node makes
  // each refresh increasingly expensive and retains all markdown DOM trees.
  const MAX_RENDERED_TIMELINE_ITEMS = 600;
  const timelineMetrics = {
    commits: 0,
    resetCommits: 0,
    projectorItemsMax: 0,
    visibleItemsMax: 0,
    mountedRootsMax: 0,
    prunedRoots: 0,
    renderErrors: 0,
    totalCommitMs: 0,
    maxCommitMs: 0,
    lastCommitMs: null,
    lastSessionId: null,
    lastError: null,
  };

  function timelineNowMs() {
    return typeof root.performance?.now === "function" ? root.performance.now() : Date.now();
  }

  function recordTimelineRenderError(error, item) {
    timelineMetrics.renderErrors += 1;
    timelineMetrics.lastError = {
      kind: String(item?.kind || "unknown").slice(0, 48),
      type: String(item?.event?.type || "unknown").slice(0, 80),
      message: String(error?.message || error || "render failed").slice(0, 240),
    };
  }

  function timelineMetricsSnapshot() {
    return JSON.parse(JSON.stringify({
      ...timelineMetrics,
      maxRenderedItems: MAX_RENDERED_TIMELINE_ITEMS,
      avgCommitMs: timelineMetrics.commits > 0
        ? timelineMetrics.totalCommitMs / timelineMetrics.commits
        : 0,
    }));
  }

  if (typeof root.ragentGetTimelineRuntimeMetrics !== "function") {
    root.ragentGetTimelineRuntimeMetrics = timelineMetricsSnapshot;
  }

  function currentSession() {
    return typeof root.currentSessionId === "string" ? root.currentSessionId : "";
  }

  function documentObject() {
    return root.document || (typeof document !== "undefined" ? document : null);
  }

  function messagesContainer() {
    return root.messagesInner || documentObject()?.getElementById?.("messagesInner") || null;
  }

  function legacyState() {
    return root.renderedEventState && typeof root.renderedEventState === "object"
      ? root.renderedEventState
      : null;
  }

  function normalizeSessionId(sessionId) {
    return typeof sessionId === "string" ? sessionId : "";
  }

  function removeDetachedTranscriptNodes(container) {
    if (!container) return;
    for (const node of childrenOf(container)) {
      if (
        node === root.emptyState
        || node.id === "homeWorkspace"
        || node.classList?.contains("messages-session-error")
      ) continue;
      node.remove?.();
    }
  }

  function clearItemNodes({ removeDetached = false } = {}) {
    const container = messagesContainer();
    for (const node of itemNodes.values()) {
      if (isMountedItemNode(node, container)) node.remove?.();
    }
    for (const child of childrenOf(container)) {
      if (child.classList?.contains?.("msg-version-rail")) child.remove?.();
    }
    itemNodes.clear();
    syntheticItemIds.clear();
    if (removeDetached) removeDetachedTranscriptNodes(container);
    root.RagentStreamingPresentation?.cancel?.();
  }

  function rememberProjector(sessionId, state) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized || !state) return;
    projectorCache.delete(normalized);
    projectorCache.set(normalized, state);
    while (projectorCache.size > MAX_CACHED_PROJECTORS) {
      projectorCache.delete(projectorCache.keys().next().value);
    }
  }

  function takeCachedProjector(sessionId) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized || !projectorCache.has(normalized)) return null;
    const cached = projectorCache.get(normalized);
    projectorCache.delete(normalized);
    projectorCache.set(normalized, cached);
    return cached;
  }

  function ensureProjector(sessionId = currentSession()) {
    const normalized = normalizeSessionId(sessionId);
    if (!projector || activeSessionId !== normalized) {
      discardPendingIncrementalCommit(activeSessionId);
      if (projector && activeSessionId) rememberProjector(activeSessionId, projector);
      clearItemNodes({ removeDetached: Boolean(projector && activeSessionId !== normalized) });
      root.ragentClearSessionEventBlockCaches?.(activeSessionId);
      if (activeSessionId) root.ragentCancelSessionEventBodyFetches?.(activeSessionId);
      activeSessionId = normalized;
      projector = takeCachedProjector(normalized)
        || (Projector ? new Projector({ sessionId: normalized }) : null);
      hasCommittedSnapshot = Boolean(projectorCache.has(normalized));
    }
    return projector;
  }

  function reset(sessionId = "") {
    discardPendingIncrementalCommit();
    root.ragentClearSessionEventCaches?.(activeSessionId);
    projectorCache.delete(activeSessionId);
    projectorCache.delete(normalizeSessionId(sessionId));
    clearItemNodes();
    activeSessionId = normalizeSessionId(sessionId);
    projector = Projector ? new Projector({ sessionId: activeSessionId }) : null;
    hasCommittedSnapshot = false;
    return projector?.snapshot?.() || null;
  }

  function restoreCachedSession(sessionId = currentSession(), {
    runState = "idle",
    renderOptions = {},
  } = {}) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return null;
    const cached = takeCachedProjector(normalized);
    if (!cached) return null;
    if (activeSessionId !== normalized) {
      if (projector && activeSessionId) rememberProjector(activeSessionId, projector);
      clearItemNodes({ removeDetached: Boolean(projector && activeSessionId !== normalized) });
      root.ragentClearSessionEventBlockCaches?.(activeSessionId);
      if (activeSessionId) root.ragentCancelSessionEventBodyFetches?.(activeSessionId);
      activeSessionId = normalized;
    }
    projector = cached;
    hasCommittedSnapshot = true;
    const snapshot = projector.snapshot();
    applyAcceptedEventEffects(snapshot.changeSet?.acceptedEvents || [], {
      sessionId: normalized,
      renderOptions,
      runState,
    });
    return commit(snapshot, snapshot.items.map((item) => item.id), {
      runState,
      renderOptions,
      pagination: snapshot.pagination,
      reset: true,
      firstPage: true,
    });
  }

  function childrenOf(container) {
    return Array.from(container?.children || []);
  }

  function isMountedItemNode(node, container = messagesContainer()) {
    if (!node || !container || node === container) return null;
    let current = node;
    while (current && current !== container) {
      if (current.parentNode === container) return node;
      current = current.parentNode;
    }
    return null;
  }

  function findTimelineVersionRail(userNode, container, parentRequestId) {
    if (!userNode || !container) return null;
    if (userNode.nextElementSibling?.classList?.contains?.("msg-version-rail")) {
      return userNode.nextElementSibling;
    }
    const targetParent = typeof parentRequestId === "string" ? parentRequestId.trim() : "";
    if (targetParent) {
      for (const child of childrenOf(container)) {
        if (child.classList?.contains?.("msg-version-rail")
          && child.dataset?.parentRequestId === targetParent) {
          return child;
        }
      }
    }
    return null;
  }

  function reconcileTimelineVersionRail(container, userNode, foldedNodes = [], parentRequestId = "") {
    if (!container || !userNode) return null;
    if (typeof root.reconcileVersionRailForUserNode === "function") {
      return root.reconcileVersionRailForUserNode(userNode, foldedNodes, {
        parentRequestId,
        append: false,
      });
    }
    let rail = findTimelineVersionRail(userNode, container, parentRequestId);
    if (!foldedNodes.length) {
      rail?.remove?.();
      return null;
    }
    const doc = documentObject();
    if (!rail && doc?.createElement) {
      rail = doc.createElement("div");
      rail.className = "msg-version-rail";
      const toggle = doc.createElement("button");
      toggle.type = "button";
      toggle.className = "msg-version-rail__toggle";
      toggle.setAttribute?.("aria-expanded", "false");
      const label = doc.createElement("span");
      label.className = "msg-version-rail__label";
      toggle.appendChild?.(label);
      const body = doc.createElement("div");
      body.className = "msg-version-rail__body";
      toggle.addEventListener?.("click", () => {
        const expanded = rail.classList?.toggle?.("is-expanded");
        toggle.setAttribute?.("aria-expanded", expanded ? "true" : "false");
      });
      rail.appendChild?.(toggle);
      rail.appendChild?.(body);
      container.appendChild?.(rail);
    }
    if (!rail) return null;
    if (rail.dataset && parentRequestId) rail.dataset.parentRequestId = parentRequestId;
    const body = rail.querySelector?.(".msg-version-rail__body") || rail.children?.[1] || null;
    if (!body) return rail;
    const wanted = new Set(foldedNodes);
    for (const child of childrenOf(body)) {
      if (!wanted.has(child)) child.remove?.();
    }
    let cursor = body.firstElementChild || null;
    for (const child of foldedNodes) {
      if (child === cursor) {
        cursor = child.nextElementSibling || null;
        continue;
      }
      if (typeof body.insertBefore === "function") {
        body.insertBefore(child, cursor);
        cursor = child.nextElementSibling || null;
      } else {
        body.appendChild?.(child);
      }
    }
    if (rail.dataset) rail.dataset.foldedCount = String(foldedNodes.length);
    const label = rail.querySelector?.(".msg-version-rail__label");
    if (label) {
      const baseText = typeof root.t === "function" ? root.t("message.versionRail.folded") : "Previous versions";
      label.textContent = foldedNodes.length > 1
        ? `${baseText} · ${foldedNodes.length}`
        : baseText;
    }
    return rail;
  }

  function operationId(event) {
    return String(
      event?.operationId
      || event?.toolCallId
      || event?.toolCall?.toolCallId
      || event?.providerToolUseId
      || event?.id
      || "",
    ).trim();
  }

  function preserveTimelineAttributes(target) {
    const names = [
      "data-timeline-id",
      "data-timeline-revision",
      "data-timeline-start-seq",
      "data-timeline-end-seq",
    ];
    return new Map(names.map((name) => [name, target.getAttribute?.(name)]));
  }

  function adoptVisual(target, source) {
    if (!target || !source || target === source) return target;
    const timelineAttributes = preserveTimelineAttributes(target);
    if (typeof target.className === "string") target.className = source.className || "";
    if (typeof target.replaceChildren === "function") {
      target.replaceChildren(...Array.from(source.childNodes || []));
    } else {
      target.innerHTML = source.innerHTML || "";
    }
    if (typeof source.getAttributeNames === "function") {
      for (const name of target.getAttributeNames?.() || []) {
        if (!timelineAttributes.has(name)) target.removeAttribute(name);
      }
      for (const name of source.getAttributeNames()) {
        if (!timelineAttributes.has(name)) {
          target.setAttribute(name, source.getAttribute(name));
        }
      }
    }
    for (const [name, value] of timelineAttributes) {
      if (value == null) target.removeAttribute?.(name);
      else target.setAttribute?.(name, value);
    }
    return target;
  }

  function createElement(tagName = "div") {
    return documentObject()?.createElement?.(tagName) || null;
  }

  function normalizedType(event) {
    const type = typeof event?.type === "string" ? event.type.trim().toLowerCase() : "unknown";
    return type === "collapsed_block" ? "thinking_block" : type;
  }

  function shouldHideTimelineActivityItem(item) {
    // Keep the transcript focused on the user's request and the assistant's
    // answer. Thinking and tool execution remain available through the live
    // activity line and Run Sheet on every Web viewport.
    return item?.kind === "thinking" || item?.kind === "operation";
  }

  function isAssistantMessageItem(item, event) {
    if (item?.kind !== "message") return false;
    const role = typeof item.role === "string"
      ? item.role.trim().toLowerCase()
      : String(event?.role || "").trim().toLowerCase();
    return role === "assistant" || (!role && normalizedType(event) !== "user_message");
  }

  function isUserMessageItem(item, event) {
    if (item?.kind !== "message") return false;
    const role = typeof item.role === "string"
      ? item.role.trim().toLowerCase()
      : String(event?.role || "").trim().toLowerCase();
    return role === "user" || normalizedType(event) === "user_message";
  }

  function renderUserMessageVisual(event, staging) {
    const container = messagesContainer();
    const requestId = typeof event?.requestId === "string" ? event.requestId.trim() : "";
    const committed = requestId && typeof root.findCommittedUserMessageNode === "function"
      ? root.findCommittedUserMessageNode(requestId)
      : null;
    if (committed && isMountedItemNode(committed, container)) {
      const fresh = typeof root.createUserMessageNode === "function"
        ? root.createUserMessageNode(event)
        : null;
      if (fresh) {
        adoptVisual(committed, fresh);
      }
      root.attachMessageLongPressMenu?.(committed, event, "user");
      root.syncEditableMessageActions?.();
      return committed;
    }

    const fresh = root.createUserMessageNode(event);
    if (!fresh) return null;
    const localEcho = requestId && typeof root.findLocalEchoUserMessageNode === "function"
      ? root.findLocalEchoUserMessageNode(requestId)
      : null;
    if (localEcho && isMountedItemNode(localEcho, container)) {
      // Keep the optimistic node's position while replacing its contents. This
      // closes the ACK/WS/refresh race without letting the two bubbles paint
      // together for a frame.
      adoptVisual(localEcho, fresh);
      root.attachMessageLongPressMenu?.(localEcho, event, "user");
      root.clearComposerRetainedSendState?.(requestId);
      root.syncEditableMessageActions?.();
      return localEcho;
    }
    staging.appendChild(fresh);
    return fresh;
  }

  function renderThinking(container, event) {
    if (typeof root.createDeferredThinkingBlock === "function") {
      const thinking = root.createDeferredThinkingBlock(
        event?.label || (event?.state === "running" ? root.t?.("thinking.active") : root.t?.("thinking.done")),
        { collapsed: event?.state !== "running" },
      );
      if (thinking?.block) {
        thinking.block.dataset.eventSeq = String(Number(event?.seq) || 0);
        thinking.block.dataset.blockStartSeq = String(Number(event?.blockStartSeq) || 0);
        thinking.block.dataset.blockEndSeq = String(Number(event?.blockEndSeq) || 0);
        if (event?.state === "running") thinking.block.classList.add("running");
        if (
          (event?.content || event?.bodyAvailable)
          && typeof root.renderReasoningInto === "function"
        ) {
          root.renderReasoningInto(thinking.body, event);
        }
        container.appendChild(thinking.block);
        return thinking.block;
      }
    }
    if (typeof root.renderReasoningInto === "function") {
      return root.renderReasoningInto(container, event);
    }
    return null;
  }

  function renderFreshVisual(item, event, options = {}) {
    const staging = createElement();
    if (!staging) return null;
    const type = normalizedType(event);
    let visual = null;

    if (item.kind === "control" || item.kind === "metadata") {
      // Protocol state is consumed by applyAcceptedEventEffects below. It is
      // deliberately not a transcript visual.
      return null;
    }
    if (shouldHideTimelineActivityItem(item)) return null;
    if (item.kind === "message" || item.kind === "attachment") {
      const isUserMessage = isUserMessageItem(item, event);
      if (isUserMessage && typeof root.createUserMessageNode === "function") {
        visual = renderUserMessageVisual(event, staging);
      } else {
        visual = typeof root.renderMessageInto === "function"
          ? root.renderMessageInto(staging, event, {
            finalizeActiveThinkingBlock: false,
            mergeAssistantRunMessages: false,
            preservePosition: true,
          })
          : null;
      }
    } else if (item.kind === "operation") {
      visual = createElement();
      if (visual && typeof root.renderOperationNodeContent === "function") {
        root.renderOperationNodeContent(visual, event, { expanded: options.expanded === true });
        staging.appendChild(visual);
      }
    } else if (item.kind === "plan") {
      visual = typeof root.renderPlanEventInto === "function"
        ? root.renderPlanEventInto(staging, event)
        : null;
    } else if (item.kind === "thinking") {
      visual = renderThinking(staging, event);
    } else if (type === "approval_response") {
      visual = typeof root.renderApprovalResponseInto === "function"
        ? root.renderApprovalResponseInto(staging, event)
        : null;
    } else if (type === "status") {
      visual = typeof root.renderStatusInto === "function"
        ? root.renderStatusInto(staging, event)
        : null;
    } else if (type === "context_barrier") {
      visual = typeof root.renderContextBarrierInto === "function"
        ? root.renderContextBarrierInto(staging, event)
        : null;
    } else if (type === "context_operation") {
      visual = typeof root.renderContextOperationInto === "function"
        ? root.renderContextOperationInto(staging, event)
        : null;
    } else if (type === "usage") {
      if (typeof root.renderUsageInto === "function") {
        root.renderUsageInto(staging, event, { updateContext: true });
      }
    }

    if (!visual) visual = staging.firstElementChild || null;
    if (!visual) return null;
    if (visual.parentNode === messagesContainer()) return visual;
    if (visual.parentNode !== staging) return null;
    return visual;
  }

  function operationStateMap() {
    if (typeof root.ensureOperationRenderState !== "function") return null;
    return root.ensureOperationRenderState();
  }

  function updateOperationIndexes(event, node) {
    const id = operationId(event);
    const state = operationStateMap();
    if (!id || !state) return;
    state.operationNodesById.set(id, node);
    state.operationSnapshotsById.set(id, event);
  }

  function renderItem(item, event, options = {}) {
    if (shouldHideTimelineActivityItem(item)) return null;
    const existing = isMountedItemNode(itemNodes.get(item.id));
    if (item.kind === "operation" && existing && typeof root.renderOperationNodeContent === "function") {
      const expanded = existing.classList?.contains("is-expanded") === true
        || root.renderedEventState?.expandedOperationIds?.has?.(operationId(event));
      root.renderOperationNodeContent(existing, event, { expanded });
      updateOperationIndexes(event, existing);
      return existing;
    }
    // A revalidation may arrive while the presentation queue is revealing a
    // complete assistant message. Keep that keyed root intact; its completion
    // callback will install the same durable visual in place.
    if (existing && syntheticItemIds.has(item.id)) return existing;

    const fresh = renderFreshVisual(item, event, {
      expanded: existing?.classList?.contains("is-expanded") === true,
    });
    if (!fresh) {
      if (existing) return existing;
      // There is no generic transcript fallback. New protocol/provider event
      // types must receive an explicit renderer before becoming user-visible.
      return null;
    }

    const attachedFresh = isMountedItemNode(fresh, messagesContainer());
    if (attachedFresh) {
      return attachedFresh;
    }

    const target = existing || createElement();
    if (!target) return null;
    adoptVisual(target, fresh);
    if (isUserMessageItem(item, event)) {
      root.attachMessageLongPressMenu?.(target, event, "user");
    } else if (isAssistantMessageItem(item, event)) {
      root.attachMessageLongPressMenu?.(target, event, "assistant");
    }
    if (isAssistantMessageItem(item, event)
      && item.completed !== true
      && typeof root.RagentStreamingPresentation?.decorateStreamingMessageNode === "function") {
      root.RagentStreamingPresentation.decorateStreamingMessageNode(target);
    }
    if (item.kind === "operation") updateOperationIndexes(event, target);
    if (!existing) itemNodes.set(item.id, target);
    return target;
  }

  function tagItemNode(node, item) {
    const rootNode = isMountedItemNode(node);
    if (!rootNode?.dataset) return null;
    rootNode.dataset.timelineId = item.id;
    rootNode.dataset.timelineRevision = String(item.revision || 0);
    rootNode.dataset.timelineStartSeq = String(item.startSeq || item.seq || 0);
    rootNode.dataset.timelineEndSeq = String(item.endSeq || item.seq || 0);
    return rootNode;
  }

  function selectVisibleItems(snapshot, { historyPrepend = false } = {}) {
    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
    if (items.length <= MAX_RENDERED_TIMELINE_ITEMS) return items;
    if (historyPrepend && itemNodes.size > 0) {
      const existingIndexes = items
        .map((item, index) => itemNodes.has(item.id) ? index : -1)
        .filter((index) => index >= 0);
      if (existingIndexes.length > 0) {
        const center = Math.floor((existingIndexes[0] + existingIndexes.at(-1)) / 2);
        const start = Math.max(
          0,
          Math.min(
            items.length - MAX_RENDERED_TIMELINE_ITEMS,
            center - Math.floor(MAX_RENDERED_TIMELINE_ITEMS / 2),
          ),
        );
        return items.slice(start, start + MAX_RENDERED_TIMELINE_ITEMS);
      }
    }
    // A normal refresh is bottom-oriented: retain the newest rows. A prepend
    // keeps the existing window centered above whenever it is available.
    return items.slice(-MAX_RENDERED_TIMELINE_ITEMS);
  }

  function removeMissingNodes(snapshot, visibleItems = null) {
    const retained = new Set((visibleItems || snapshot.items).map((item) => item.id));
    for (const [id, node] of itemNodes) {
      if (!retained.has(id)) {
        node.remove?.();
        itemNodes.delete(id);
        syntheticItemIds.delete(id);
        timelineMetrics.prunedRoots += 1;
      } else if (!isMountedItemNode(node)) {
        itemNodes.delete(id);
        syntheticItemIds.delete(id);
      }
    }
  }

  function shouldAnimateCompleteAssistantMessage(item, event, renderOptions, firstPage) {
    return firstPage !== true
      && renderOptions?.syntheticAssistantMessages === true
      && isAssistantMessageItem(item, event)
      && (String(event?.type || "").trim().toLowerCase() === "message" || event?.oneShotMessage === true)
      && typeof event?.content === "string"
      && event.content.trim().length > 0;
  }

  function scheduleHistoryRestoreCleanup(container, token) {
    const remove = () => {
      if (token !== historyRestoreToken) return;
      container.classList?.remove("restoring-session-snapshot");
    };
    if (typeof root.requestAnimationFrame === "function") {
      root.requestAnimationFrame(() => root.requestAnimationFrame(remove));
    } else if (typeof root.setTimeout === "function") {
      root.setTimeout(remove, 0);
    } else {
      remove();
    }
  }

  function startSyntheticPresentation(item, event, node) {
    if (!node || syntheticItemIds.has(item.id)) return false;
    const presentation = root.RagentStreamingPresentation;
    if (typeof presentation?.startSyntheticAssistantMessageInNode !== "function") return false;
    const started = presentation.startSyntheticAssistantMessageInNode(node, event, {
      onComplete: (completedNode) => {
        if (itemNodes.get(item.id) !== completedNode) return;
        const fresh = renderFreshVisual(item, event);
        if (fresh) adoptVisual(completedNode, fresh);
        root.attachMessageLongPressMenu?.(completedNode, event, "assistant");
        tagItemNode(completedNode, item);
        syntheticItemIds.delete(item.id);
      },
    });
    if (started) syntheticItemIds.add(item.id);
    return started;
  }

  function commit(snapshot, ids, {
    runState = "idle",
    pagination = null,
    renderOptions = {},
    reset = false,
    historyPrepend = false,
    firstPage = false,
  } = {}) {
    const container = messagesContainer();
    if (!container || !snapshot) return snapshot;
    const commitStartedAt = timelineNowMs();
    const changed = new Set(ids || []);
    const isHistoryRestore = !historyPrepend && (reset || firstPage);
    const restoreToken = isHistoryRestore ? ++historyRestoreToken : historyRestoreToken;
    if (isHistoryRestore) {
      // Add the guard before creating any visual roots. Otherwise the default
      // message fade-in can start on the first root and later roots inherit a
      // different animation state within the same commit.
      container.classList?.add("restoring-session-snapshot");
    }
    if (reset) {
      for (const [id, node] of itemNodes) {
        node.remove?.();
        itemNodes.delete(id);
      }
      for (const child of childrenOf(container)) {
        if (child.classList?.contains?.("msg-version-rail")) child.remove?.();
      }
      syntheticItemIds.clear();
      for (const item of selectVisibleItems(snapshot, { historyPrepend })) changed.add(item.id);
    } else {
      for (const item of selectVisibleItems(snapshot, { historyPrepend })) {
        if (!isMountedItemNode(itemNodes.get(item.id), container)) changed.add(item.id);
      }
    }

    rendering = true;
    const visibleItems = selectVisibleItems(snapshot, { historyPrepend });
    try {
      for (const item of visibleItems) {
        if (!changed.has(item.id)) continue;
        const event = item.event;
        root.reconcileComposerPendingSendWithEvent?.(event);
        const existingBeforeRender = isMountedItemNode(itemNodes.get(item.id), container);
        let node = null;
        try {
          node = renderItem(item, event, {
            ...renderOptions,
            historyPrepend,
          });
        } catch (error) {
          // One malformed provider frame must not abort the whole transcript
          // commit. Keep the durable projector state intact and continue with
          // the remaining items; diagnostics expose the bounded error sample.
          recordTimelineRenderError(error, item);
          continue;
        }
        if (!node) {
          const stale = isMountedItemNode(itemNodes.get(item.id), container);
          if (stale) {
            stale.remove?.();
            itemNodes.delete(item.id);
            syntheticItemIds.delete(item.id);
          }
          continue;
        }
        if (isHistoryRestore) node.classList?.add("history-restored-node");
        if (!isMountedItemNode(node, container)) container.appendChild(node);
        const rootNode = tagItemNode(node, item);
        if (rootNode) {
          itemNodes.set(item.id, rootNode);
          if (!existingBeforeRender
            && shouldAnimateCompleteAssistantMessage(item, event, renderOptions, firstPage)) {
            startSyntheticPresentation(item, event, rootNode);
          }
        }
      }
    } finally {
      rendering = false;
    }

    removeMissingNodes(snapshot, visibleItems);

    const foldedByParent = new Map();
    const userNodeByRequestId = new Map();
    for (const item of visibleItems) {
      const node = isMountedItemNode(itemNodes.get(item.id), container);
      if (!node) continue;
      if (isUserMessageItem(item, item.event)) {
        const reqId = typeof item.event?.requestId === "string" ? item.event.requestId.trim() : "";
        if (reqId) userNodeByRequestId.set(reqId, node);
      }
      const foldedParent = typeof item?.foldedParentRequestId === "string"
        ? item.foldedParentRequestId.trim()
        : "";
      if (foldedParent) {
        let list = foldedByParent.get(foldedParent);
        if (!list) {
          list = [];
          foldedByParent.set(foldedParent, list);
        }
        list.push(node);
      }
    }

    const railsByParent = new Map();
    const activeRails = new Set();
    const foldedNodeSet = new Set();
    for (const [parentRequestId, userNode] of userNodeByRequestId) {
      const foldedNodes = foldedByParent.get(parentRequestId) || [];
      const rail = reconcileTimelineVersionRail(container, userNode, foldedNodes, parentRequestId);
      if (rail && foldedNodes.length > 0) {
        railsByParent.set(parentRequestId, rail);
        activeRails.add(rail);
        for (const foldedNode of foldedNodes) foldedNodeSet.add(foldedNode);
      }
    }
    for (const child of childrenOf(container)) {
      if (child.classList?.contains?.("msg-version-rail") && !activeRails.has(child)) {
        child.remove?.();
      }
    }

    const ordered = [];
    const orderedSet = new Set();
    for (const item of visibleItems) {
      const node = isMountedItemNode(itemNodes.get(item.id), container);
      if (!node || foldedNodeSet.has(node) || orderedSet.has(node)) continue;
      ordered.push(node);
      orderedSet.add(node);
      if (isUserMessageItem(item, item.event)) {
        const reqId = typeof item.event?.requestId === "string" ? item.event.requestId.trim() : "";
        const rail = reqId ? railsByParent.get(reqId) : null;
        if (rail && !orderedSet.has(rail)) {
          ordered.push(rail);
          orderedSet.add(rail);
        }
      }
    }
    let cursor = container.firstElementChild;
    for (const node of ordered) {
      if (node === cursor) {
        cursor = node.nextElementSibling;
        continue;
      }
      container.insertBefore(node, cursor || null);
      cursor = node.nextElementSibling;
    }
    if (root.emptyState?.parentNode === container) root.emptyState.remove();
    root.clearSessionLoadError?.(snapshot.sessionId);
    root.syncComposerPendingTurnFeedback?.();
    syncState(snapshot, runState, pagination);
    root.syncEditableMessageActions?.();
    root.syncRegenerateActions?.();
    root.finishSessionContentTransition?.(snapshot.sessionId);
    if (isHistoryRestore) scheduleHistoryRestoreCleanup(container, restoreToken);
    const commitMs = Math.max(0, timelineNowMs() - commitStartedAt);
    timelineMetrics.commits += 1;
    if (reset) timelineMetrics.resetCommits += 1;
    timelineMetrics.projectorItemsMax = Math.max(timelineMetrics.projectorItemsMax, snapshot.items.length);
    timelineMetrics.visibleItemsMax = Math.max(timelineMetrics.visibleItemsMax, visibleItems.length);
    timelineMetrics.mountedRootsMax = Math.max(timelineMetrics.mountedRootsMax, itemNodes.size);
    timelineMetrics.totalCommitMs += commitMs;
    timelineMetrics.maxCommitMs = Math.max(timelineMetrics.maxCommitMs, commitMs);
    timelineMetrics.lastCommitMs = commitMs;
    timelineMetrics.lastSessionId = snapshot.sessionId || null;
    return snapshot;
  }

  function scheduleTimelineFrame(callback) {
    if (typeof root.requestAnimationFrame === "function") return root.requestAnimationFrame(callback);
    if (typeof root.setTimeout === "function") return root.setTimeout(callback, 0);
    return setTimeout(callback, 0);
  }

  function cancelTimelineFrame(handle) {
    if (typeof root.cancelAnimationFrame === "function") {
      root.cancelAnimationFrame(handle);
    } else if (typeof root.clearTimeout === "function") {
      root.clearTimeout(handle);
    } else {
      clearTimeout(handle);
    }
  }

  function discardPendingIncrementalCommit(sessionId = "") {
    const pending = pendingIncrementalCommit;
    if (!pending || (sessionId && pending.sessionId !== sessionId)) return;
    if (pending.handle != null) cancelTimelineFrame(pending.handle);
    pendingIncrementalCommit = null;
  }

  function flushPendingIncrementalCommit(sessionId = "") {
    const pending = pendingIncrementalCommit;
    if (!pending || (sessionId && pending.sessionId !== sessionId)) return null;
    if (pending.handle != null) cancelTimelineFrame(pending.handle);
    pendingIncrementalCommit = null;
    if (!pending.dirty) return pending.snapshot;
    return commit(pending.snapshot, [...pending.changedIds], pending.options);
  }

  function hasUnpaintedVisibleItem(snapshot, ids) {
    const changed = new Set(ids || []);
    if (changed.size === 0) return false;
    for (const item of snapshot?.items || []) {
      if (!changed.has(item.id) || shouldHideTimelineActivityItem(item)) continue;
      if (!isMountedItemNode(itemNodes.get(item.id))) return true;
    }
    return false;
  }

  function commitIncrementalOnFrame(snapshot, ids, options) {
    const sessionId = snapshot?.sessionId || "";
    const existing = pendingIncrementalCommit;
    if (existing && existing.sessionId !== sessionId) discardPendingIncrementalCommit();
    // A new visible transcript root must appear in the same turn as its first
    // provider event.  Only revisions of roots that are already mounted are
    // safe to defer to the next frame; otherwise an unrelated pending stream
    // can make the next assistant turn look as if it never started.
    if (pendingIncrementalCommit && hasUnpaintedVisibleItem(snapshot, ids)) {
      flushPendingIncrementalCommit(sessionId);
    }
    if (pendingIncrementalCommit) {
      pendingIncrementalCommit.snapshot = snapshot;
      for (const id of ids || []) pendingIncrementalCommit.changedIds.add(id);
      pendingIncrementalCommit.options = options;
      pendingIncrementalCommit.dirty = true;
      return snapshot;
    }

    // Paint the first frame immediately, then collapse every following WS
    // batch until the next browser frame. This preserves responsive streaming
    // while preventing high-rate providers from forcing one DOM reflow per
    // transport message.
    const committed = commit(snapshot, ids, options);
    const pending = {
      sessionId,
      snapshot,
      changedIds: new Set(),
      options,
      dirty: false,
      handle: null,
    };
    // Store before scheduling: lightweight test hosts and embedded webviews
    // may invoke a frame callback synchronously.
    pendingIncrementalCommit = pending;
    const handle = scheduleTimelineFrame(() => {
      if (pendingIncrementalCommit !== pending) return;
      pendingIncrementalCommit = null;
      if (!pending.dirty) return;
      commit(pending.snapshot, [...pending.changedIds], pending.options);
    });
    if (pendingIncrementalCommit === pending) pending.handle = handle;
    return committed;
  }

  function syncState(snapshot, runState = "idle", pagination = null) {
    const state = legacyState();
    if (!state || !snapshot) return;
    state.sessionId = snapshot.sessionId;
    state.latestSeq = snapshot.latestSeq;
    state.earliestSeq = snapshot.earliestSeq;
    state.nextBeforeSeq = snapshot.nextBeforeSeq;
    state.hasMoreBefore = snapshot.hasMoreBefore === true;
    state.runState = typeof root.normalizeRenderedRunState === "function"
      ? root.normalizeRenderedRunState(runState)
      : runState;
    // The history request owns this flag. A prepend render happens while that
    // request is still in flight; clearing it here lets a second scroll event
    // request the same cursor and can leave the pager stuck at the top.
    if (state.loadingOlder !== true) state.loadingOlder = false;
    state.timelineItemCount = snapshot.items.length;
    root.syncLiveMessageMetadataForRunState?.(state.runState);
    root.syncEditableMessageActions?.();
  }

  function applyAcceptedEventEffects(
    events,
    { sessionId = currentSession(), historyPrepend = false, renderOptions = {}, runState = "idle" } = {},
  ) {
    if (historyPrepend) return;
    const acceptedEvents = Array.isArray(events) ? events : [];
    // A dangerous tool approval is persisted twice: first as the provider's
    // generic approval_request, then as one privileged_batch_request.  Feed
    // only the batch projection to the decision store.  Otherwise the sheet
    // enters once for the generic request and immediately replaces itself
    // with the batch sheet, which looks like a page flash/jitter even though
    // the payload is correct.
    const batchEvents = acceptedEvents.filter((event) => event?.type === "privileged_batch_request");
    const batchIds = new Set();
    const batchRuns = new Set();
    const addBatchIdentity = (value) => {
      const normalized = String(value || "").trim();
      if (normalized) batchIds.add(normalized);
    };
    for (const batch of batchEvents) {
      addBatchIdentity(batch?.approvalId);
      addBatchIdentity(batch?.batchId);
      addBatchIdentity(batch?.id);
      addBatchIdentity(batch?.requestId);
      addBatchIdentity(batch?.providerRequestId);
      addBatchIdentity(batch?.providerItemId);
      const runId = String(batch?.runId || "").trim();
      if (runId) batchRuns.add(runId);
      for (const category of ["other", "delete", "installAuto", "actions"]) {
        for (const operation of Array.isArray(batch?.[category]) ? batch[category] : []) {
          addBatchIdentity(operation?.id);
          addBatchIdentity(operation?.approvalId);
          addBatchIdentity(operation?.actionId);
          addBatchIdentity(operation?.opId);
          addBatchIdentity(operation?.requestId);
          addBatchIdentity(operation?.providerRequestId);
          addBatchIdentity(operation?.providerItemId);
        }
      }
    }
    const regularApprovalIsShadowed = (event) => {
      const ids = [
        event?.approvalId,
        event?.requestId,
        event?.providerRequestId,
        event?.providerItemId,
      ].map((value) => String(value || "").trim()).filter(Boolean);
      if (ids.some((id) => batchIds.has(id))) return true;
      const runId = String(event?.runId || "").trim();
      return ids.length === 0 && Boolean(runId) && batchRuns.has(runId);
    };
    const normalizedRunState = String(runState || "").trim().toLowerCase();
    const runIsLive = normalizedRunState === "running" || normalizedRunState === "waiting_user";
    // A state refresh and its event page are independent requests. During the
    // short window where the state response still says `idle`, the page can
    // nevertheless contain a live approval (the provider is paused waiting
    // for the owner). Do not let an unrelated historical terminal status clear
    // that approval store: the next event in the same refresh would otherwise
    // re-open the sheet and visibly flash. Only a terminal status belonging to
    // the pending decision's own run may clear it.
    const pendingDecisionSnapshot = () => {
      const pending = root.RagentDecisions?.getPending?.();
      const pendingBatch = root.RagentDecisions?.getPendingBatch?.();
      const pendingAction = root.RagentDecisions?.getPendingAction?.();
      const decisions = [pending, pendingBatch, pendingAction].filter(Boolean);
      const runIds = new Set(decisions
        .map((event) => String(event?.runId || "").trim())
        .filter(Boolean));
      return { hasPending: decisions.length > 0, runIds };
    };
    // Apply terminal cleanup only after the complete accepted batch has fed
    // the decision store. A status record commonly precedes the approval
    // record in a durable page; resetting while iterating would clear the
    // sheet first and then reopen it a few lines later.
    const terminalStatusEvents = [];
    for (const event of acceptedEvents) {
      const type = normalizedType(event);
      if (type === "usage") {
        // Usage is metadata, not a transcript item. Preserve its context
        // update even though the projector intentionally omits its row.
        root.renderUsageInto?.(null, event, { updateContext: true });
        root.RagentRunActivity?.applyEvent?.(event);
        continue;
      }
      if (
        type === "text_delta"
        || (type === "message" && event?.role === "assistant")
        || type === "attachment_delivery"
        || type === "plan"
      ) {
        root.RagentRunActivity?.noteFormalOutput?.(event);
      } else {
        root.RagentRunActivity?.applyEvent?.(event);
      }

      const liveId = renderOptions.approvalRequestLiveId;
      const decisionEventId = String(event?.approvalId || event?.batchId || "").trim();
      const decisionEventMatchesLive = liveId == null
        || (decisionEventId && decisionEventId === String(liveId).trim());
      if (type === "approval_request") {
        if (decisionEventMatchesLive && !regularApprovalIsShadowed(event)) {
          root.RagentDecisions?.noteRequest?.(event, { sessionId });
        }
      } else if (type === "approval_response") {
        if (decisionEventMatchesLive) root.RagentDecisions?.noteResponse?.(event, { sessionId });
      } else if (type === "privileged_batch_request") {
        if (decisionEventMatchesLive) root.RagentDecisions?.notePrivilegedBatch?.(event, { sessionId });
      } else if (type === "privileged_batch_response") {
        if (decisionEventMatchesLive) root.RagentDecisions?.notePrivilegedBatchResponse?.(event, { sessionId });
      } else if (type === "approved_action_batch_request") {
        if (decisionEventMatchesLive) root.RagentDecisions?.noteApprovedAction?.(event, { sessionId });
      } else if (type === "approved_action_state") {
        if (decisionEventMatchesLive) root.RagentDecisions?.noteApprovedActionState?.(event, { sessionId });
      } else if (type === "approved_action_batch_response") {
        if (decisionEventMatchesLive) root.RagentDecisions?.noteApprovedActionResolution?.(event, { sessionId });
      } else if (type === "plan" && !root.isCodexProgressPlanEvent?.(event)) {
        const planApprovalId = typeof root.planApprovalIdForPlanEvent === "function"
          ? root.planApprovalIdForPlanEvent(event)
          : "";
        const liveId = renderOptions.approvalRequestLiveId;
        if (planApprovalId && String(event?.state || "").trim().toLowerCase() === "awaiting_decision"
          && (liveId == null || planApprovalId === String(liveId))) {
          const sheetEvent = root.buildPlanApprovalRequestEvent?.(event);
          if (sheetEvent) root.RagentDecisions?.noteRequest?.(sheetEvent, { sessionId });
        } else if (planApprovalId && root.isPlanSheetDismissState?.(event)) {
          root.RagentDecisions?.noteResponse?.({ approvalId: planApprovalId }, { sessionId });
        }
      } else if (type === "status") {
        const statusText = String(event?.content || "").trim().toLowerCase();
        // A full durable refresh contains terminal statuses from older runs.
        // Resetting the live approval store for those historical records
        // closes the current sheet, and the later approval record reopens it
        // in the same refresh (visible as continuous flicker).  While the
        // attached run is live, the status is historical or superseded; live
        // terminalization is handled by the matching response/final state.
        if (!runIsLive && (statusText === "cancelled" || statusText.startsWith("error:"))) {
          terminalStatusEvents.push(event);
        }
      }
    }
    for (const event of terminalStatusEvents) {
      const statusRunId = String(event?.runId || "").trim();
      const pending = pendingDecisionSnapshot();
      const protectsLiveDecision = pending.hasPending && (
        !statusRunId
        || pending.runIds.size === 0
        || !pending.runIds.has(statusRunId)
      );
      if (!protectsLiveDecision) root.RagentDecisions?.reset?.();
    }
  }

  function renderBatch(events, {
    sessionId = currentSession(),
    runState = "idle",
    historyPrepend = false,
    renderOptions = {},
    pagination = null,
    paginationMode = historyPrepend ? "before" : "latest",
    latestSeq = null,
    reset = false,
  } = {}) {
    if (!Projector) return null;
    flushPendingIncrementalCommit(sessionId);
    const state = ensureProjector(sessionId);
    const before = state.snapshot();
    const firstPage = before.items.length === 0 && itemNodes.size === 0;
    const cursor = Number.isInteger(latestSeq)
      ? latestSeq
      : (Number.isInteger(pagination?.latestSeq) ? pagination.latestSeq : null);
    const snapshot = reset || firstPage
      ? state.replace(events, {
        sessionId,
        latestSeq: cursor,
        pagination,
        paginationMode,
        source: "http",
      })
      : state.replaceDurable(events, {
        sessionId,
        latestSeq: cursor,
        pagination,
        paginationMode,
        runState,
        historyPrepend,
      });
    applyAcceptedEventEffects(snapshot.changeSet?.acceptedEvents, { sessionId, historyPrepend, renderOptions, runState });
    const ids = snapshot.changeSet?.changedIds || snapshot.items.map((item) => item.id);
    const committed = commit(snapshot, ids, {
      runState,
      pagination,
      renderOptions,
      reset: reset || (firstPage && !historyPrepend),
      historyPrepend,
      firstPage,
    });
    hasCommittedSnapshot = true;
    return committed;
  }

  function renderIncremental(events, {
    sessionId = currentSession(),
    runState = "running",
    renderOptions = {},
    latestSeq = null,
    pagination = null,
    paginationMode = "latest",
    source = "ws",
  } = {}) {
    if (!Projector) return null;
    const state = ensureProjector(sessionId);
    const snapshot = state.ingest(events, {
      source,
      latestSeq,
      pagination,
      paginationMode,
      allowCompletedDeltas: ["running", "waiting_user"].includes(
        String(runState || "").trim().toLowerCase(),
      ),
    });
    applyAcceptedEventEffects(snapshot.changeSet?.acceptedEvents, { sessionId, renderOptions, runState });
    const commitOptions = {
      runState,
      pagination,
      renderOptions: {
        ...renderOptions,
        syntheticAssistantMessages: renderOptions.syntheticAssistantMessages === true
          || source === "ws",
      },
    };
    const committed = source === "ws"
      ? commitIncrementalOnFrame(snapshot, snapshot.changeSet?.changedIds, commitOptions)
      : commit(snapshot, snapshot.changeSet?.changedIds, commitOptions);
    hasCommittedSnapshot = true;
    return committed;
  }

  // A durable WebSocket event is already the canonical history projection.
  // Applying it here avoids waiting for the paired invalidation to fetch the
  // same page again.  The delayed HTTP reconciliation remains authoritative
  // for missed frames and run/session metadata.
  function renderDurableDelta(events, {
    sessionId = currentSession(),
    runState = "running",
    renderOptions = {},
    latestSeq = null,
    pagination = null,
  } = {}) {
    if (!Projector) return null;
    flushPendingIncrementalCommit(sessionId);
    const state = ensureProjector(sessionId);
    const snapshot = state.replaceDurable(events, {
      sessionId,
      latestSeq,
      pagination,
      paginationMode: "latest",
      runState,
    });
    applyAcceptedEventEffects(snapshot.changeSet?.acceptedEvents, { sessionId, renderOptions, runState });
    const committed = commit(snapshot, snapshot.changeSet?.changedIds, {
      runState,
      pagination,
      renderOptions,
    });
    hasCommittedSnapshot = true;
    return committed;
  }

  function ingest(events, options = {}) {
    const state = ensureProjector(options.sessionId || currentSession());
    return state?.ingest?.(events, options) || null;
  }

  function reconcileCursor(sessionId = currentSession(), {
    latestSeq = null,
    pagination = null,
    paginationMode = "latest",
    runState = "idle",
  } = {}) {
    const state = ensureProjector(sessionId);
    if (!state) return null;
    const snapshot = state.reconcileCursor(latestSeq, { pagination, paginationMode });
    syncState(snapshot, runState, pagination);
    return snapshot;
  }

  root.RagentTimelineRuntime = Object.freeze({
    reset,
    restoreCachedSession,
    renderBatch,
    renderIncremental,
    renderDurableDelta,
    ingest,
    getSnapshot: () => {
      const snapshot = projector?.snapshot?.();
      return snapshot ? { ...snapshot, initialized: hasCommittedSnapshot } : null;
    },
    reconcileCursor,
    flush: () => projector?.snapshot?.() || null,
    isRendering: () => rendering,
  });
})(typeof globalThis !== "undefined" ? globalThis : {});
