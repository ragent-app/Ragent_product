"use strict";

// RagentDecisions — a tiny pub/sub store for the active session's pending
// runtime approval. Mirrors the run-activity-ui.js pattern (subscribe with an
// immediate first call, notify on change, return-unsubscribe). The store itself
// has no UI dependencies; the Decision Sheet VIEW (decision-sheet.js) subscribes.
//
// Approval events are dispatched imperatively into the message DOM by
// realtime-render.js (renderApprovalRequest/renderApprovalResponse). That file
// calls noteRequest()/noteResponse() right after rendering, so the store always
// reflects the latest pending approval for the currently-viewed session. The WS
// layer (realtime.js) already drops other sessions' events, so no extra session
// gating is needed here; bootstrap.js calls reset() on session switch anyway.
//
// Phase 5: privileged batch approvals (danger-tier ops surfaced as one
// privileged_batch_request event with other/delete sub-groups) ride a parallel
// pendingBatch channel — notePrivilegedBatch/notePrivilegedBatchResponse +
// subscribeBatch. A batch stays pending until BOTH categories resolve
// (privileged_batch_response per category), at which point the sheet dismisses.
(function attachDecisionsStore(root) {
  const subscribers = new Set();
  const batchSubscribers = new Set();
  const actionSubscribers = new Set();
  // Latest pending approval event for the current session, or null when resolved.
  let pending = null;
  // Latest pending privileged batch request event, or null when resolved.
  // resolvedBatchCategories accumulates privileged_batch_response arrivals so
  // the view can collapse per-category popups (other -> delete ordering).
  let pendingBatch = null;
  let resolvedBatchCategories = new Set();
  let pendingAction = null;
  let pendingSignature = "";
  let pendingBatchSignature = "";
  let pendingActionSignature = "";
  let activeSessionId = "";
  let activeGeneration = 0;
  let activeContextInitialized = false;
  let pendingContext = null;
  let pendingBatchContext = null;
  let pendingActionContext = null;
  // A response and a replayed request can cross on separate WS/HTTP turns.
  // Keep bounded resolution tombstones so a late request cannot re-open a
  // sheet that has already started (or finished) its exit animation.
  const MAX_RESOLVED_IDS = 512;
  const resolvedApprovalIds = new Map();
  const resolvedBatchIds = new Map();
  const resolvedActionBatchIds = new Map();

  function rememberResolved(map, id, runId = "", sessionId = activeSessionId) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) return;
    map.delete(normalizedId);
    map.set(normalizedId, {
      runId: String(runId || "").trim(),
      sessionId: String(sessionId || "").trim(),
      at: Date.now(),
    });
    while (map.size > MAX_RESOLVED_IDS) map.delete(map.keys().next().value);
  }

  function resolveContext(evt, options = {}) {
    return {
      sessionId: String(options.sessionId || evt?.sessionId || activeSessionId || root.currentSessionId || "").trim(),
      runId: String(options.runId || evt?.runId || "").trim(),
      generation: Number.isSafeInteger(options.generation)
        ? options.generation
        : activeGeneration,
    };
  }

  function isCurrentContext(context) {
    // Before bootstrap establishes a context, preserve the legacy store
    // contract for early-loader events. Once initialized, the home/null
    // context is a real boundary: events from any session must be rejected.
    if (!activeContextInitialized) return true;
    if (!activeSessionId) return false;
    return Boolean(context?.sessionId) && context.sessionId === activeSessionId
      && (!activeGeneration || !context.generation || context.generation === activeGeneration);
  }

  function wasResolved(map, evt, idKey, context = resolveContext(evt)) {
    const id = String(evt?.[idKey] || "").trim();
    if (!id || !map.has(id)) return false;
    const remembered = map.get(id);
    const resolvedRunId = typeof remembered === "object"
      ? String(remembered.runId || "").trim()
      : String(remembered || "").trim();
    const resolvedSessionId = typeof remembered === "object"
      ? String(remembered.sessionId || "").trim()
      : "";
    const requestRunId = String(context?.runId || evt?.runId || "").trim();
    const requestSessionId = String(context?.sessionId || evt?.sessionId || "").trim();
    if (resolvedSessionId && requestSessionId && resolvedSessionId !== requestSessionId) {
      map.delete(id);
      return false;
    }
    // Provider ids are normally globally unique, but accepting a new run id
    // keeps the guard safe for legacy harnesses that recycle an id.
    if (resolvedRunId && requestRunId && resolvedRunId !== requestRunId) {
      map.delete(id);
      return false;
    }
    return true;
  }

  function beginSessionContext(sessionId = "", generation = 0, { resetState = true } = {}) {
    const nextSessionId = String(sessionId || "").trim();
    const nextGeneration = Number.isSafeInteger(generation) ? generation : 0;
    const changed = nextSessionId !== activeSessionId || nextGeneration !== activeGeneration;
    activeSessionId = nextSessionId;
    activeGeneration = nextGeneration;
    activeContextInitialized = true;
    if (changed && resetState) reset();
  }

  // Runtime revalidation can replay the same approval event more than once.
  // Compare a canonical JSON shape so replayed objects do not fan out through
  // every subscriber and cause the Decision Sheet to rebuild its animated DOM.
  // Events are JSON payloads in production; the cycle guard keeps a malformed
  // test/connector object from taking down the notification path.
  function stableEventSignature(value) {
    const seen = new Set();
    const normalize = (input, key = "") => {
      // A replay may be projected with a fresh transport timestamp/sequence.
      // Those fields do not change the approval decision and must not notify
      // the sheet, otherwise its animated DOM is rebuilt on every replay.
      if (["timestamp", "createdAt", "updatedAt", "seq", "startSeq", "endSeq", "eventId"].includes(key)) {
        return undefined;
      }
      if (input === null || typeof input !== "object") return input;
      if (seen.has(input)) return "[Circular]";
      seen.add(input);
      let normalized;
      if (Array.isArray(input)) {
        normalized = input.map(normalize);
      } else {
        normalized = {};
        for (const key of Object.keys(input).sort()) {
          const child = normalize(input[key], key);
          if (child !== undefined) normalized[key] = child;
        }
      }
      seen.delete(input);
      return normalized;
    };
    try {
      return JSON.stringify(normalize(value));
    } catch {
      return "";
    }
  }

  function batchRequestIdentitySet(event) {
    const ids = new Set();
    const add = (value) => {
      const normalized = String(value || "").trim();
      if (normalized) ids.add(normalized);
    };
    add(event?.approvalId);
    add(event?.batchId);
    add(event?.id);
    add(event?.requestId);
    add(event?.providerRequestId);
    add(event?.providerItemId);
    for (const category of ["other", "delete", "installAuto", "actions"]) {
      for (const operation of Array.isArray(event?.[category]) ? event[category] : []) {
        add(operation?.id);
        add(operation?.approvalId);
        add(operation?.actionId);
        add(operation?.opId);
        add(operation?.requestId);
        add(operation?.providerRequestId);
        add(operation?.providerItemId);
      }
    }
    return ids;
  }

  function regularRequestIsRepresentedByBatch(event, batch) {
    const requestIds = [
      event?.approvalId,
      event?.requestId,
      event?.providerRequestId,
      event?.providerItemId,
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const batchIds = batchRequestIdentitySet(batch);
    if (requestIds.some((id) => batchIds.has(id))) return true;
    const runId = String(event?.runId || "").trim();
    return !requestIds.length && runId && runId === String(batch?.runId || "").trim();
  }

  function snapshot() {
    return pending ? { pending: true, evt: pending } : { pending: false, evt: null };
  }

  function batchSnapshot() {
    return pendingBatch
      ? { pending: true, evt: pendingBatch, resolved: new Set(resolvedBatchCategories) }
      : { pending: false, evt: null, resolved: new Set() };
  }

  function actionSnapshot() {
    return pendingAction ? { pending: true, evt: pendingAction } : { pending: false, evt: null };
  }

  function notify() {
    const snap = snapshot();
    for (const subscriber of subscribers) {
      try {
        subscriber(snap);
      } catch (error) {
        console.warn("[decisions] subscriber failed:", error?.message || error);
      }
    }
  }

  function notifyBatch() {
    const snap = batchSnapshot();
    for (const subscriber of batchSubscribers) {
      try {
        subscriber(snap);
      } catch (error) {
        console.warn("[decisions] batch subscriber failed:", error?.message || error);
      }
    }
  }

  function notifyAction() {
    const snap = actionSnapshot();
    for (const subscriber of actionSubscribers) {
      try { subscriber(snap); } catch (error) {
        console.warn("[decisions] action subscriber failed:", error?.message || error);
      }
    }
  }

  // An approval_request event arrived — it is pending by definition.
  function noteRequest(evt, options = {}) {
    if (!evt || typeof evt !== "object") return;
    const context = resolveContext(evt, options);
    if (!isCurrentContext(context)) return;
    if (wasResolved(resolvedApprovalIds, evt, "approvalId", context)) return;
    // The batch channel is authoritative for a gated request. A delayed or
    // replayed provider record must not repopulate the regular channel after
    // the batch has already taken over the surface.
    if (pendingBatch && regularRequestIsRepresentedByBatch(evt, pendingBatch)) return;
    const signature = stableEventSignature(evt);
    if ((signature && signature === pendingSignature)
      || (!signature && pending === evt)) return;
    pending = evt;
    pendingSignature = signature;
    pendingContext = context;
    notify();
  }

  // An approval_response event arrived — resolve the matching pending request.
  // If the response is for a different approval id (rare overlap), leave state.
  function noteResponse(evt, options = {}) {
    const id = String(evt?.approvalId || "").trim();
    const context = resolveContext(evt, options);
    if (!isCurrentContext(context)) return;
    if (!pending) {
      // Responses may be delivered before a replayed request. Remember the
      // id even without a current snapshot so that request is ignored later.
      if (id) rememberResolved(resolvedApprovalIds, id, evt?.runId, context.sessionId);
      return;
    }
    const currentId = String(pending?.approvalId || "").trim();
    if (id && currentId && id !== currentId) return;
    rememberResolved(
      resolvedApprovalIds,
      currentId || id,
      pending?.runId || evt?.runId,
      pendingContext?.sessionId || context.sessionId,
    );
    pending = null;
    pendingSignature = "";
    pendingContext = null;
    notify();
  }

  // HTTP 200/202 means the owner decision was accepted by Ragent, not that
  // the provider has finished applying it. Clear the interactive surface now
  // and retain a bounded tombstone so a delayed approval_request replay cannot
  // reopen the sheet before the authoritative approval_response arrives.
  function acknowledgeResponse(evt = {}, options = {}) {
    const context = resolveContext(evt, options);
    if (!isCurrentContext(context)) return false;
    const id = String(options.approvalId || evt?.approvalId || "").trim();
    if (!id) return false;
    rememberResolved(resolvedApprovalIds, id, context.runId, context.sessionId);
    if (pending) {
      const currentId = String(pending?.approvalId || "").trim();
      const currentRunId = String(pendingContext?.runId || pending?.runId || "").trim();
      const sameRun = !context.runId || !currentRunId || context.runId === currentRunId;
      if (currentId === id && sameRun) {
        pending = null;
        pendingSignature = "";
        pendingContext = null;
        notify();
      }
    }
    return true;
  }

  // A privileged_batch_request event arrived — it is pending by definition.
  // A second batch for the same batchId (idempotent re-surface) replaces state.
  function notePrivilegedBatch(evt, options = {}) {
    if (!evt || typeof evt !== "object") return;
    const context = resolveContext(evt, options);
    if (!isCurrentContext(context)) return;
    if (wasResolved(resolvedBatchIds, evt, "batchId", context)) return;
    const signature = stableEventSignature(evt);
    if ((signature && signature === pendingBatchSignature)
      || (!signature && pendingBatch === evt)) return;
    // A provider approval can be persisted before the risk gate finishes its
    // quiescence window. Once the privileged batch arrives, atomically hand
    // ownership to the batch channel instead of notifying the regular sheet
    // subscriber about a close followed by a reopen.
    const regularShadowed = Boolean(
      pending
      && regularRequestIsRepresentedByBatch(pending, evt),
    );
    if (regularShadowed) {
      pending = null;
      pendingSignature = "";
    }
    const batchId = String(evt?.batchId || "").trim();
    const isSameBatch = Boolean(batchId) && String(pendingBatch?.batchId || "").trim() === batchId;
    pendingBatch = evt;
    pendingBatchSignature = signature;
    pendingBatchContext = context;
    // Keep already-resolved categories when the same batch re-surfaces (e.g.
    // history re-sync); a brand-new batch starts fresh.
    if (!isSameBatch) resolvedBatchCategories = new Set();
    notifyBatch();
    // Notify regular subscribers only after the batch subscriber has taken
    // ownership. decision-sheet.js ignores this empty snapshot while the batch
    // surface is rendered, so it cannot start a collapse animation.
    if (regularShadowed) notify();
  }

  // A privileged_batch_response event arrived — mark that category resolved.
  // When every category of the pending batch is resolved the batch clears.
  function notePrivilegedBatchResponse(evt, options = {}) {
    if (!evt || typeof evt !== "object") return;
    const context = resolveContext(evt, options);
    if (!isCurrentContext(context)) return;
    const batchId = String(evt?.batchId || "").trim();
    const currentBatchId = String(pendingBatch?.batchId || "").trim();
    // Only the currently-pending batch's responses advance the sheet. Stale
    // (or history-replay) responses are ignored.
    if (!batchId || !currentBatchId || batchId !== currentBatchId) return;
    const category = String(evt?.category || "").trim().toLowerCase();
    // Server-side responses carry the classifier category constants
    // (privileged_other / destructive_delete); the sheet groups are keyed by
    // the short names. Normalize so either form advances the right group.
    const normalizedCategory = category === "privileged_other" ? "other"
      : category === "destructive_delete" ? "delete"
        : category;
    if (normalizedCategory && resolvedBatchCategories.has(normalizedCategory)) return;
    if (normalizedCategory) resolvedBatchCategories.add(normalizedCategory);
    const open = pendingBatch?.other || [];
    const del = pendingBatch?.delete || [];
    const stillOpen = (open.length > 0 && !resolvedBatchCategories.has("other"))
      || (del.length > 0 && !resolvedBatchCategories.has("delete"));
    if (!stillOpen) {
      rememberResolved(resolvedBatchIds, batchId, pendingBatch?.runId || evt?.runId, pendingBatchContext?.sessionId || context.sessionId);
      pendingBatch = null;
      resolvedBatchCategories = new Set();
      pendingBatchSignature = "";
      pendingBatchContext = null;
    }
    notifyBatch();
  }

  // The resolve endpoint can report that the run/batch already ended when a
  // stale sheet is clicked after a reconnect. Treat that response as a
  // terminal acknowledgement for the whole batch, not as a retryable form
  // error that leaves a disabled card on screen.
  function dismissPrivilegedBatch(evt = {}, options = {}) {
    const context = resolveContext(evt, options);
    if (!isCurrentContext(context)) return false;
    const batchId = String(options.batchId || evt?.batchId || "").trim();
    if (!batchId) return false;
    const currentBatchId = String(pendingBatch?.batchId || "").trim();
    rememberResolved(
      resolvedBatchIds,
      batchId,
      evt?.runId || pendingBatch?.runId || context.runId,
      pendingBatchContext?.sessionId || context.sessionId,
    );
    if (currentBatchId !== batchId) return true;
    pendingBatch = null;
    resolvedBatchCategories = new Set();
    pendingBatchSignature = "";
    pendingBatchContext = null;
    notifyBatch();
    return true;
  }

  function noteApprovedAction(evt, options = {}) {
    if (!evt || typeof evt !== "object") return;
    const batchId = String(evt?.batchId || "").trim();
    if (!batchId) return;
    const context = resolveContext(evt, options);
    if (!isCurrentContext(context)) return;
    if (wasResolved(resolvedActionBatchIds, evt, "batchId", context)) return;
    const signature = stableEventSignature(evt);
    if ((signature && signature === pendingActionSignature)
      || (!signature && pendingAction === evt)) return;
    pendingAction = evt;
    pendingActionSignature = signature;
    pendingActionContext = context;
    notifyAction();
  }

  function noteApprovedActionState(evt, options = {}) {
    if (!evt || typeof evt !== "object" || !pendingAction) return;
    const context = resolveContext(evt, options);
    if (!isCurrentContext(context)) return;
    if (String(evt.batchId || "").trim() !== String(pendingAction.batchId || "").trim()) return;
    const actionId = String(evt.actionId || "").trim();
    if (!actionId) return;
    const actions = Array.isArray(pendingAction.actions) ? pendingAction.actions.map((action) => (
      String(action?.actionId || "").trim() === actionId
        ? { ...action, state: evt.state, authorization: evt.authorization || null, resultRef: evt.resultRef || null }
        : action
    )) : [];
    pendingAction = { ...pendingAction, actions };
    if (actions.length > 0 && actions.every((action) => ["denied", "cancelled", "expired", "completed", "failed"].includes(String(action?.state || "")))) {
      rememberResolved(resolvedActionBatchIds, String(pendingAction?.batchId || "").trim(), pendingAction?.runId, pendingActionContext?.sessionId || activeSessionId);
      pendingAction = null;
      pendingActionSignature = "";
      pendingActionContext = null;
    }
    notifyAction();
  }

  // The resolve endpoint returns a durable batch response.  Apply that
  // response immediately instead of waiting for the per-action state events
  // (which may arrive on a later invalidation or be absent after a reconnect).
  // This is deliberately idempotent: a later approved_action_state replay is
  // ignored by the tombstone once every returned action is terminal.
  function noteApprovedActionResolution(evt, options = {}) {
    if (!evt || typeof evt !== "object" || !pendingAction) return;
    const context = resolveContext(evt, options);
    if (!isCurrentContext(context)) return;
    const batchId = String(evt.batchId || "").trim();
    if (!batchId || batchId !== String(pendingAction.batchId || "").trim()) return;
    const returned = Array.isArray(evt.actions) ? evt.actions : [];
    const returnedById = new Map(returned.map((action) => [String(action?.actionId || "").trim(), action]));
    const decisions = evt.decisions && typeof evt.decisions === "object" ? evt.decisions : {};
    const actions = Array.isArray(pendingAction.actions) ? pendingAction.actions.map((action) => {
      const actionId = String(action?.actionId || "").trim();
      const update = returnedById.get(actionId);
      if (update) return { ...action, ...update };
      if (Object.prototype.hasOwnProperty.call(decisions, actionId)) {
        return { ...action, state: decisions[actionId] === "approve" ? "completed" : "denied" };
      }
      return action;
    }) : [];
    const allTerminal = actions.length > 0 && actions.every((action) => [
      "denied", "cancelled", "expired", "completed", "failed",
    ].includes(String(action?.state || "").toLowerCase()));
    if (!allTerminal && returned.length === 0 && Object.keys(decisions).length === 0) return;
    rememberResolved(resolvedActionBatchIds, batchId, pendingAction.runId || evt.runId, pendingActionContext?.sessionId || context.sessionId);
    pendingAction = null;
    pendingActionSignature = "";
    pendingActionContext = null;
    notifyAction();
  }

  // Same terminal acknowledgement for managed approved-action batches. The
  // server may have accepted/finished the batch before a delayed notification
  // card is clicked, so an already-gone response must still close the UI.
  function dismissApprovedAction(evt = {}, options = {}) {
    const context = resolveContext(evt, options);
    if (!isCurrentContext(context)) return false;
    const batchId = String(options.batchId || evt?.batchId || "").trim();
    if (!batchId) return false;
    const currentBatchId = String(pendingAction?.batchId || "").trim();
    rememberResolved(
      resolvedActionBatchIds,
      batchId,
      evt?.runId || pendingAction?.runId || context.runId,
      pendingActionContext?.sessionId || context.sessionId,
    );
    if (currentBatchId !== batchId) return true;
    pendingAction = null;
    pendingActionSignature = "";
    pendingActionContext = null;
    notifyAction();
    return true;
  }

  // Called on session switch (bootstrap.js) so a prior session's approval does
  // not linger over the newly-selected conversation.
  function reset() {
    pending = null;
    pendingBatch = null;
    resolvedBatchCategories = new Set();
    pendingAction = null;
    pendingSignature = "";
    pendingBatchSignature = "";
    pendingActionSignature = "";
    pendingContext = null;
    pendingBatchContext = null;
    pendingActionContext = null;
    notify();
    notifyBatch();
    notifyAction();
  }

  function getPending() {
    return pending ? { ...pending } : null;
  }

  function getPendingBatch() {
    return pendingBatch ? { ...pendingBatch } : null;
  }

  function getBatchState() {
    return pendingBatch
      ? { evt: pendingBatch, resolved: new Set(resolvedBatchCategories) }
      : null;
  }

  function getPendingAction() {
    return pendingAction ? { ...pendingAction } : null;
  }

  // Subscribe to pending-state changes. Returns an unsubscribe function.
  // Calls back immediately with the current snapshot so a late-loading view
  // (or one re-subscribing) catches the current pending approval.
  function subscribe(subscriber) {
    if (typeof subscriber !== "function") return () => {};
    subscribers.add(subscriber);
    subscriber(snapshot());
    return () => subscribers.delete(subscriber);
  }

  // Subscribe to privileged-batch pending-state changes (same contract).
  function subscribeBatch(subscriber) {
    if (typeof subscriber !== "function") return () => {};
    batchSubscribers.add(subscriber);
    subscriber(batchSnapshot());
    return () => batchSubscribers.delete(subscriber);
  }

  function subscribeAction(subscriber) {
    if (typeof subscriber !== "function") return () => {};
    actionSubscribers.add(subscriber);
    subscriber(actionSnapshot());
    return () => actionSubscribers.delete(subscriber);
  }

  root.RagentDecisions = Object.freeze({
    subscribe,
    subscribeBatch,
    noteRequest,
    noteResponse,
    acknowledgeResponse,
    beginSessionContext,
    notePrivilegedBatch,
    notePrivilegedBatchResponse,
    dismissPrivilegedBatch,
    subscribeAction,
    noteApprovedAction,
    noteApprovedActionState,
    noteApprovedActionResolution,
    dismissApprovedAction,
    getPending,
    getPendingBatch,
    getBatchState,
    getPendingAction,
    reset,
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
