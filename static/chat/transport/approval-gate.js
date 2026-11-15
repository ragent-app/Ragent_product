"use strict";

// Pure pending-approval resolution (Stage 2 extraction of
// session-http-helpers.js). Given a session's event timeline, decides what —
// if anything — is genuinely awaiting a decision right now: approval_request
// events, privileged_batch_request groups whose categories still have
// unresolved responses, managed approved_action_batch_request batches with
// non-terminal actions, and plan events in "awaiting_decision" that were not
// superseded later in the timeline. This drives the Decision Sheet exactly
// like a Claude plan approval; returns null when nothing in the page is
// genuinely pending.
//
// Two sweeps, not one: providers replay old approval records into later runs
// (AskUserQuestion/plan artifacts reappear as awaiting_decision after the
// original was already resolved), so the closing signal — an approval_response
// for the same id, or ANY later state for the same planId — may sit BEFORE the
// replayed record in the timeline. A single back-to-front scan would hit the
// replayed record first (its closing signal not yet collected) and wrongly
// mark it pending. Collect every closing signal over the whole list first,
// then scan back-to-front for the newest genuinely-pending record.
//
// Also carries realtime.js's isApprovalAlreadyEndedError — the error
// classification for "the approval target is gone / its run is over", so the
// UI treats it as resolved instead of failing.
//
// Fully pure: no environment contract, no platform hooks. Locked against the
// legacy implementation by tests/test-chat-approval-gate-core.mjs.

(function attachRagentApprovalGateCore(root) {
  const TERMINAL_APPROVAL_STATUSES = new Set(
    ["approved", "denied", "declined", "cancelled", "canceled"],
  );
  // A plan state that is not "awaiting a decision" makes any earlier
  // awaiting_decision record for the same plan stale (drafting/executing/
  // revising/terminal supersede it later in the timeline). 'cancelled' is the
  // terminal state the server writes when the plan's run is cancelled — the
  // request moment has passed, so it must never re-open the Decision Sheet.
  const PLAN_STALE_STATES = new Set(
    ["drafting", "executing", "revising", "completed", "failed", "superseded", "cancelled"],
  );
  const TERMINAL_APPROVED_ACTION_STATES = new Set(
    ["denied", "cancelled", "expired", "completed", "failed"],
  );
  const normalizeBatchCategory = (value) => {
    const category = String(value || "").trim().toLowerCase();
    if (category === "privileged_other" || category === "other") return "other";
    if (category === "destructive_delete" || category === "delete") return "delete";
    return category;
  };

  // realtime.js's isApprovalAlreadyEndedError: true when the server says the
  // approval target no longer exists or its run is over — the UI must treat
  // the approval as resolved instead of failing.
  function isApprovalAlreadyEndedError(error) {
    const code = String(error?.code || "").toUpperCase();
    if (["APPROVAL_NOT_FOUND", "RUN_TERMINAL", "RUN_NOT_FOUND"].includes(code)) return true;
    const status = Number(error?.status || 0);
    return status === 404 || status === 409 || status === 410;
  }

  function isPlanProgressEventLike(evt) {
    const planIntent = String(evt?.planIntent || "").trim().toLowerCase();
    if (planIntent) return planIntent === "progress";
    return String(evt?.interactionMode || "").trim().toLowerCase() === "agent";
  }

  function resolvePendingApprovalEvent(events = []) {
    const list = Array.isArray(events) ? events : [];
    const resolvedApprovalIds = new Set();
    const resolvedPlanIds = new Set();
    const resolvedBatchCategories = new Map(); // batchId -> Set<category>
    const resolvedApprovedActionStates = new Map(); // actionId -> latest state
    const resolvedApprovedActionBatches = new Set();
    for (const event of list) {
      if (event?.type === "approval_response") {
        const approvalId = String(event?.approvalId || "").trim();
        if (approvalId) resolvedApprovalIds.add(approvalId);
      } else if (event?.type === "privileged_batch_response") {
        // Each category group resolves through its own response event; a batch
        // stays pending until every non-empty category is resolved.
        const batchId = String(event?.batchId || "").trim();
        const category = normalizeBatchCategory(event?.category);
        if (batchId && category) {
          if (!resolvedBatchCategories.has(batchId)) resolvedBatchCategories.set(batchId, new Set());
          resolvedBatchCategories.get(batchId).add(category);
        }
      } else if (event?.type === "approved_action_state") {
        const actionId = String(event?.actionId || "").trim();
        if (actionId) {
          resolvedApprovedActionStates.set(
            actionId,
            String(event?.state || "").trim().toLowerCase(),
          );
        }
      } else if (event?.type === "approved_action_batch_response") {
        const batchId = String(event?.batchId || "").trim();
        if (batchId) resolvedApprovedActionBatches.add(batchId);
      } else if (event?.type === "plan") {
        const planId = String(event?.planId || "").trim();
        if (planId && PLAN_STALE_STATES.has(String(event?.state || "").trim().toLowerCase())) {
          resolvedPlanIds.add(planId);
        }
      }
    }
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const event = list[index];
      if (event?.type === "approval_request") {
        const approvalId = String(event?.approvalId || "").trim();
        if (approvalId && resolvedApprovalIds.has(approvalId)) continue;
        if (TERMINAL_APPROVAL_STATUSES.has(String(event?.status || "").toLowerCase())) continue;
        return event;
      }
      if (event?.type === "privileged_batch_request") {
        const batchId = String(event?.batchId || "").trim();
        if (!batchId) continue;
        const resolved = resolvedBatchCategories.get(batchId) || new Set();
        const categories = [];
        if (Array.isArray(event?.other) && event.other.length > 0) categories.push("other");
        if (Array.isArray(event?.delete) && event.delete.length > 0) categories.push("delete");
        if (categories.length === 0) continue;
        if (categories.every((category) => resolved.has(category))) continue;
        // Replay the batch as the live pending approval (its id doubles as the
        // gate key so the sheet re-opens with the remaining groups on refresh).
        return { ...event, approvalId: batchId };
      }
      if (event?.type === "approved_action_batch_request") {
        const actions = Array.isArray(event?.actions) ? event.actions : [];
        const pendingAction = actions.find((action) => {
          const actionId = String(action?.actionId || "").trim();
          const state = resolvedApprovedActionStates.get(actionId)
            || String(action?.state || "").trim().toLowerCase();
          return !TERMINAL_APPROVED_ACTION_STATES.has(state);
        });
        const batchId = String(event?.batchId || "").trim();
        if (batchId && resolvedApprovedActionBatches.has(batchId)) continue;
        if (!pendingAction || !batchId) continue;
        // The batch id is the live gate key used by realtime-render.js. Returning
        // it as approvalId lets a full-sync/reconnect restore the Decision Sheet.
        return { ...event, approvalId: batchId };
      }
      if (event?.type === "plan") {
        const planId = String(event?.planId || "").trim();
        if (!planId) continue;
        const state = String(event?.state || "").trim().toLowerCase();
        if (resolvedPlanIds.has(planId)) continue;
        if (planId && resolvedApprovalIds.has(`plan:${planId}`)) continue;
        if (isPlanProgressEventLike(event) || state !== "awaiting_decision") continue;
        return {
          type: "approval_request",
          approvalId: `plan:${planId}`,
          kind: "plan",
          status: "pending",
          ...(String(event?.title || "").trim() ? { title: String(event.title).trim() } : {}),
          ...(String(event?.bodyMarkdown || "").trim() ? { reason: String(event.bodyMarkdown).trim() } : {}),
          ...(String(event?.runId || "").trim() ? { runId: String(event.runId).trim() } : {}),
          planEventRef: { planId },
        };
      }
    }
    return null;
  }

  root.RagentApprovalGateCore = {
    resolvePendingApprovalEvent,
    isPlanProgressEventLike,
    isApprovalAlreadyEndedError,
    TERMINAL_APPROVAL_STATUSES,
    PLAN_STALE_STATES,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
