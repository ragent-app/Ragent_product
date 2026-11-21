"use strict";

(function attachRagentSessionStatusCore(root) {
  const prioritySpecs = {
    high: {
      key: "high",
      rank: 3,
      labelKey: "workflow.priority.high",
      labelRaw: "High",
      titleKey: "workflow.priority.highTitle",
      titleRaw: "Needs user attention soon.",
    },
    medium: {
      key: "medium",
      rank: 2,
      labelKey: "workflow.priority.medium",
      labelRaw: "Medium",
      titleKey: "workflow.priority.mediumTitle",
      titleRaw: "Worth checking soon, but not urgent.",
    },
    low: {
      key: "low",
      rank: 1,
      labelKey: "workflow.priority.low",
      labelRaw: "Low",
      titleKey: "workflow.priority.lowTitle",
      titleRaw: "Safe to leave for later.",
    },
  };

  const workflowSpecs = {
    waiting_user: {
      key: "waiting_user",
      labelKey: "workflow.status.waiting",
      labelRaw: "needs user",
      titleKey: "workflow.status.waitingTitle",
      titleRaw: "Blocked on user input",
    },
    done: {
      key: "done",
      labelKey: "workflow.status.done",
      labelRaw: "done",
      titleKey: "workflow.status.doneTitle",
      titleRaw: "Current task complete",
    },
    parked: {
      key: "parked",
      labelKey: "workflow.status.parked",
      labelRaw: "parked",
      titleKey: "workflow.status.parkedTitle",
      titleRaw: "Parked for later",
    },
  };

  const dangerValues = new Set([
    "high", "critical", "danger", "dangerous", "severe", "elevated",
  ]);

  function makeStatus(key, labelKey = "", labelRaw = "", titleKey = "", titleRaw = "", vars = {}) {
    return { key, labelKey, labelRaw, titleKey, titleRaw, vars };
  }

  function createEmptyStatus() {
    return makeStatus("idle");
  }

  function createIdleStatus() {
    return makeStatus("idle", "status.idle", "idle");
  }

  function normalizeSessionWorkflowState(value) {
    const normalized = typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
    if (!normalized) return "";
    if (["waiting", "waiting_user", "waiting_for_user", "waiting_on_user", "needs_user", "needs_input"].includes(normalized)) {
      return "waiting_user";
    }
    if (["done", "complete", "completed", "finished"].includes(normalized)) {
      return "done";
    }
    if (["parked", "paused", "pause", "backlog", "todo"].includes(normalized)) {
      return "parked";
    }
    return "";
  }

  function normalizeSessionWorkflowPriority(value) {
    const normalized = typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
    if (!normalized) return "";
    if (["high", "urgent", "asap", "important", "critical", "top", "top_priority", "p1"].includes(normalized)) {
      return "high";
    }
    if (["medium", "normal", "default", "standard", "soon", "next", "p2"].includes(normalized)) {
      return "medium";
    }
    if (["low", "later", "backlog", "deferred", "eventually", "p3"].includes(normalized)) {
      return "low";
    }
    return "";
  }

  function getWorkflowPriorityInfo(value) {
    const key = normalizeSessionWorkflowPriority(value);
    return key && prioritySpecs[key] ? { ...prioritySpecs[key] } : null;
  }

  function getWorkflowStatusInfo(value) {
    const key = normalizeSessionWorkflowState(value);
    return key && workflowSpecs[key] ? { ...workflowSpecs[key] } : null;
  }

  function parseSessionTime(value) {
    const time = new Date(value || "").getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function getSessionLatestChangeTime(session) {
    const hasActivityStamp = Object.prototype.hasOwnProperty.call(session || {}, "lastActivityAt");
    const stamp = hasActivityStamp
      ? (session?.lastActivityAt ?? session?.updatedAt ?? session?.created ?? "")
      : (session?.lastEventAt || session?.updatedAt || session?.created || "");
    return parseSessionTime(stamp);
  }

  function getSessionUnreadUpdateTime(session) {
    return parseSessionTime(session?.lastAssistantMessageAt);
  }

  function getSessionReviewTime(session) {
    return Math.max(
      parseSessionTime(session?.lastReviewedAt),
      parseSessionTime(session?.localReviewedAt),
      parseSessionTime(session?.reviewBaselineAt),
    );
  }

  function getSessionWorkflowStateChangedTime(session) {
    return parseSessionTime(session?.workflowStateChangedAt);
  }

  function normalizeSessionSidebarOrder(value) {
    const parsed = typeof value === "number"
      ? value
      : Number.parseInt(String(value || "").trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  function normalizeSessionActivity(session) {
    const raw = session?.activity || {};
    const activeRuns = Array.isArray(session?.activeRuns) ? session.activeRuns : null;
    const liveRuns = activeRuns?.filter((run) => run && typeof run.id === "string" && run.id
      && !["completed", "failed", "cancelled", "canceled"].includes(String(run.state || "").toLowerCase()));
    const activeRun = liveRuns?.find((run) => run.state !== "unknown") || liveRuns?.[0];
    const unresolvedRun = !activeRun && globalThis.ragentHasUnresolvedRun?.(session?.id);
    const runState = activeRuns ? (activeRun ? (activeRun.state === "unknown" ? "unknown" : "running") : unresolvedRun ? "unknown" : "idle")
      : (["running", "unknown"].includes(raw?.run?.state) ? raw.run.state : "idle");
    const providerSlotState = raw?.run?.providerSlot?.state === "waiting" ? "waiting" : "idle";
    const queueCount = Number.isInteger(raw?.queue?.count) ? raw.queue.count : 0;
    const queueState = raw?.queue?.state === "queued" && queueCount > 0 ? "queued" : "idle";
    const renameState = raw?.rename?.state === "pending" || raw?.rename?.state === "failed"
      ? raw.rename.state
      : "idle";
    const compactState = raw?.compact?.state === "pending" ? "pending" : "idle";
    const planningCount = Number.isInteger(raw?.planning?.count) ? raw.planning.count : 0;
    const planningState = raw?.planning?.state === "checking" && planningCount > 0
      ? "checking"
      : "idle";
    return {
      run: {
        state: runState,
        phase: typeof raw?.run?.phase === "string" ? raw.run.phase : null,
        startedAt: typeof raw?.run?.startedAt === "string" ? raw.run.startedAt : null,
        runId: activeRun?.id || (typeof raw?.run?.runId === "string" ? raw.run.runId : null),
        cancelRequested: raw?.run?.cancelRequested === true,
        authRecovery: normalizeAuthRecovery(raw?.run?.authRecovery),
        providerSlot: {
          state: providerSlotState,
          queuedAt: typeof raw?.run?.providerSlot?.queuedAt === "string"
            ? raw.run.providerSlot.queuedAt
            : null,
        },
      },
      queue: { state: queueState, count: queueCount },
      rename: {
        state: renameState,
        error: typeof raw?.rename?.error === "string" ? raw.rename.error : "",
      },
      compact: { state: compactState },
      planning: {
        state: planningState,
        count: planningCount,
        requestId: typeof raw?.planning?.requestId === "string" ? raw.planning.requestId : null,
      },
    };
  }

  function normalizeAuthRecovery(value) {
    const state = typeof value?.state === "string"
      ? value.state.trim()
      : typeof value?.authRetryState === "string"
        ? value.authRetryState.trim()
        : "";
    if (!["auth_retrying", "auth_recovered", "auth_retry_exhausted", "reauth_required"].includes(state)) {
      return null;
    }
    return {
      state,
      retryCount: Number.isSafeInteger(Number(value?.retryCount ?? value?.authRetryCount))
        ? Math.max(0, Math.floor(Number(value.retryCount ?? value.authRetryCount)))
        : 0,
      retryLimit: Number.isSafeInteger(Number(value?.retryLimit ?? value?.authRetryLimit))
        ? Math.max(0, Math.floor(Number(value.retryLimit ?? value.authRetryLimit)))
        : 0,
    };
  }

  function isSessionBusy(session) {
    const activity = normalizeSessionActivity(session);
    return ["running", "unknown"].includes(activity.run.state)
      || activity.queue.state === "queued"
      || activity.planning.state === "checking"
      || activity.compact.state === "pending";
  }

  function getSessionSortTime(session) {
    const activity = normalizeSessionActivity(session);
    if (activity.run.state === "running" && activity.run.startedAt) {
      const startedAt = parseSessionTime(activity.run.startedAt);
      if (startedAt > 0) return startedAt;
    }
    return getSessionLatestChangeTime(session);
  }

  function getSessionWorkflowPriorityInfo(session) {
    const explicit = getWorkflowPriorityInfo(session?.workflowPriority);
    if (explicit) return explicit;
    const state = normalizeSessionWorkflowState(session?.workflowState || "");
    if (state === "waiting_user") return getWorkflowPriorityInfo("high");
    if (state === "done") return getWorkflowPriorityInfo("low");
    return getWorkflowPriorityInfo("medium");
  }

  function hasSessionUnreadUpdate(session) {
    if (!session || isSessionBusy(session)) return false;
    const unreadTime = getSessionUnreadUpdateTime(session);
    return unreadTime > 0 && unreadTime > getSessionReviewTime(session);
  }

  function hasSessionNeedsAction(session) {
    if (!session || normalizeSessionWorkflowState(session?.workflowState || "") !== "waiting_user") {
      return false;
    }
    const changedTime = getSessionWorkflowStateChangedTime(session);
    const waitingSince = changedTime > 0
      ? changedTime
      : (Object.prototype.hasOwnProperty.call(session || {}, "lastActivityAt")
        ? parseSessionTime(session?.lastActivityAt)
        : parseSessionTime(session?.lastEventAt));
    if (waitingSince <= 0) return true;
    return waitingSince > getSessionReviewTime(session);
  }

  function getSessionReviewStatusInfo(session) {
    if (!hasSessionUnreadUpdate(session)) return null;
    return taskStatus(
      "unread",
      "workflow.status.unread",
      "new",
      "workflow.status.unreadTitle",
      "Updated since you last reviewed this session",
    );
  }

  function isSessionCompleteAndReviewed(session) {
    return normalizeSessionWorkflowState(session?.workflowState || "") === "done"
      && !isSessionBusy(session)
      && !hasSessionUnreadUpdate(session);
  }

  function getSessionAttentionBand(session) {
    const state = normalizeSessionWorkflowState(session?.workflowState || "");
    const busy = isSessionBusy(session);
    const unread = hasSessionUnreadUpdate(session);
    if (unread && state === "waiting_user") return 0;
    if (unread) return 1;
    if (state === "waiting_user") return 2;
    if (!busy && state !== "done" && state !== "parked") return 3;
    if (busy) return 4;
    if (state === "parked") return 5;
    if (state === "done") return 6;
    return 3;
  }

  function compareSessionListSessions(a, b) {
    const pinA = a?.pinned === true ? 1 : 0;
    const pinB = b?.pinned === true ? 1 : 0;
    if (pinB !== pinA) return pinB - pinA;
    const orderA = normalizeSessionSidebarOrder(a?.sidebarOrder);
    const orderB = normalizeSessionSidebarOrder(b?.sidebarOrder);
    if (pinA && pinB && orderA && orderB && orderA !== orderB) return orderA - orderB;
    const timeDiff = getSessionSortTime(b) - getSessionSortTime(a);
    if (timeDiff) return timeDiff;
    const bandDiff = getSessionAttentionBand(a) - getSessionAttentionBand(b);
    if (bandDiff) return bandDiff;
    const priorityDiff = (getSessionWorkflowPriorityInfo(b)?.rank || 0)
      - (getSessionWorkflowPriorityInfo(a)?.rank || 0);
    if (priorityDiff) return priorityDiff;
    if (orderA && orderB && orderA !== orderB) return orderA - orderB;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  }

  function getPendingSendStage(pendingSend, sessionId = "") {
    if (!pendingSend || typeof pendingSend !== "object") return null;
    const pendingSessionId = typeof pendingSend.sessionId === "string" ? pendingSend.sessionId.trim() : "";
    if (sessionId && pendingSessionId && pendingSessionId !== sessionId) return null;
    const stage = ["uploading", "checking", "processing"].includes(pendingSend.stage)
      ? pendingSend.stage
      : "sending";
    return { stage, startedAt: parseSessionTime(pendingSend.startedAt) };
  }

  function taskStatus(key, labelKey, labelRaw, titleKey = "", titleRaw = "", vars = {}) {
    return makeStatus(key, labelKey, labelRaw, titleKey, titleRaw, vars);
  }

  function queuedRaw(count) {
    return `${count} follow-up${count === 1 ? "" : "s"} queued`;
  }

  function getSessionStatusSummary(session, { includeToolFallback = false } = {}) {
    const activity = normalizeSessionActivity(session);
    const indicators = [];
    const authRecovery = activity.run.authRecovery;
    if (authRecovery?.state === "auth_retrying") {
      indicators.push(taskStatus("auth_retrying", "taskFlow.authRetrying", "Reconnecting the account..."));
    } else if (authRecovery?.state === "auth_recovered") {
      indicators.push(taskStatus("auth_recovered", "taskFlow.authRecovered", "Account reconnected"));
    } else if (authRecovery?.state === "auth_retry_exhausted") {
      indicators.push(taskStatus("auth_retry_exhausted", "taskFlow.authRetryExhausted", "Account could not be reconnected"));
    } else if (authRecovery?.state === "reauth_required") {
      indicators.push(taskStatus("reauth_required", "taskFlow.reauthRequired", "Sign-in required"));
    }
    if (activity.run.providerSlot?.state === "waiting") {
      indicators.push(taskStatus(
        "provider_slot_wait",
        "taskFlow.providerSlotWait",
        "Waiting for this AgY account to finish its previous task...",
      ));
    }
    if (activity.run.state === "unknown") {
      indicators.push(taskStatus("unknown", "status.runUnknown", "Status unknown"));
    } else if (activity.run.state === "running") {
      indicators.push(taskStatus("running", "status.running", "running"));
    }
    if (activity.queue.state === "queued") {
      const vars = { count: activity.queue.count, suffix: activity.queue.count === 1 ? "" : "s" };
      indicators.push(taskStatus("queued", "workflow.status.queued", "queued", "workflow.status.queuedTitle", queuedRaw(activity.queue.count), vars));
    }
    if (activity.planning.state === "checking") {
      indicators.push(taskStatus("checking", "workflow.status.checking", "confirming route"));
    }
    if (activity.compact.state === "pending") {
      indicators.push(taskStatus("compacting", "workflow.status.compacting", "compacting"));
    }
    if (activity.rename.state === "pending") {
      indicators.push(taskStatus("renaming", "workflow.status.renaming", "renaming"));
    }
    if (activity.rename.state === "failed") {
      indicators.push(taskStatus(
        "rename-failed",
        "workflow.status.renameFailed",
        "rename failed",
        "workflow.status.renameFailedTitle",
        activity.rename.error || "Session rename failed",
      ));
    }
    const primary = indicators[0] || (session?.tool && includeToolFallback
      ? makeStatus("tool", "", session.tool)
      : createIdleStatus());
    return {
      primary,
      indicators: indicators.length > 0 || !primary.labelRaw ? indicators : [primary],
    };
  }

  function getSessionPrimaryStatus(session, options = {}) {
    if (!session) return createEmptyStatus();
    return getSessionStatusSummary(session, options).primary;
  }

  function getSessionTaskFlowStage(session, options = {}) {
    if (!session) return options.includeIdle === false ? null : createIdleStatus();
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const activity = normalizeSessionActivity(session);
    const pending = getPendingSendStage(options.pendingSend, session.id || "");
    const elapsed = pending?.startedAt > 0 ? Math.max(0, now - pending.startedAt) : 0;
    if (pending?.stage === "uploading") return taskStatus("uploading", "taskFlow.uploading", "Uploading attachment...");
    if (pending?.stage === "sending") return taskStatus("sending", "taskFlow.sending", "Sending...");
    const authRecovery = activity.run.authRecovery;
    if (authRecovery?.state === "auth_retrying") return taskStatus("auth_retrying", "taskFlow.authRetrying", "Reconnecting the account...");
    if (authRecovery?.state === "auth_recovered") return taskStatus("auth_recovered", "taskFlow.authRecovered", "Account reconnected");
    if (authRecovery?.state === "auth_retry_exhausted") return taskStatus("auth_retry_exhausted", "taskFlow.authRetryExhausted", "Account could not be reconnected");
    if (authRecovery?.state === "reauth_required") return taskStatus("reauth_required", "taskFlow.reauthRequired", "Sign-in required");
    if (activity.run.providerSlot?.state === "waiting") {
      return taskStatus(
        "provider_slot_wait",
        "taskFlow.providerSlotWait",
        "Waiting for this AgY account to finish its previous task...",
      );
    }
    if (activity.run.kind === "adaptive_capacity" || activity.run.adaptiveCapacityWait) {
      return taskStatus(
        "adaptive_capacity_wait",
        "taskFlow.adaptiveCapacityWait",
        "Waiting for available system capacity...",
      );
    }
    if (activity.run.state === "unknown") return taskStatus("unknown", "status.runUnknown", "Status unknown");
    if (activity.run.state === "running") return taskStatus("running", "taskFlow.running", "Working...");
    if (activity.compact.state === "pending") return taskStatus("compacting", "taskFlow.compacting", "Compacting context...");
    if (activity.planning.state === "checking" || pending?.stage === "checking") {
      const slow = elapsed >= 10000;
      return taskStatus(
        "checking",
        slow ? "taskFlow.checkingSlow" : "taskFlow.checking",
        slow
          ? "Still confirming the route; Ragent will continue here if routing times out."
          : "Sent, confirming route...",
      );
    }
    if (activity.queue.state === "queued") {
      const vars = { count: activity.queue.count, suffix: activity.queue.count === 1 ? "" : "s" };
      return taskStatus("queued", "taskFlow.queued", queuedRaw(activity.queue.count), "workflow.status.queuedTitle", queuedRaw(activity.queue.count), vars);
    }
    if (pending?.stage === "processing") return taskStatus("processing", "taskFlow.processing", "Received, waiting for activity...");
    const state = normalizeSessionWorkflowState(session?.workflowState || "");
    if (state === "waiting_user") return taskStatus("waiting_user", "taskFlow.waitingUser", "Waiting for your input");
    if (state === "done") return taskStatus("done", "taskFlow.done", "Done");
    if (state === "parked") return taskStatus("parked", "taskFlow.parked", "Parked");
    return options.includeIdle === false ? null : createIdleStatus();
  }

  function getSessionVisualStatus(session, options = {}) {
    return getSessionTaskFlowStage(session, options) || getSessionStatusSummary(session, options).primary;
  }

  function resolveLiveBarDangerRisk(approval) {
    const raw = approval?.risk ?? approval?.riskLevel ?? approval?.severity
      ?? approval?.level ?? approval?.tier;
    return dangerValues.has(String(raw || "").trim().toLowerCase());
  }

  function resolveApprovalWaitingStatus(approval) {
    if (!approval || typeof approval !== "object") return null;
    const kind = String(approval.kind || "").trim().toLowerCase();
    const isQuestion = kind === "question"
      || !!approval.question
      || (Array.isArray(approval.questions) && approval.questions.length > 0);
    if (kind === "plan") return taskStatus("plan_pending", "workflow.waiting.plan", "Plan awaiting approval", "workflow.waiting.planTitle", "The proposed plan is ready for your approval");
    if (isQuestion) return taskStatus("awaiting_answer", "workflow.waiting.answer", "Awaiting your reply", "workflow.waiting.answerTitle", "A question needs your answer");
    if (resolveLiveBarDangerRisk(approval)) return taskStatus("danger_pending", "workflow.waiting.danger", "Dangerous action awaiting approval", "workflow.waiting.dangerTitle", "A potentially dangerous action needs your approval");
    return taskStatus("approval_pending", "workflow.waiting.approval", "Approval needed", "workflow.waiting.approvalTitle", "An action needs your approval");
  }

  function createReadyStatus() {
    return taskStatus("ready", "liveBar.idle", "Ready");
  }

  const api = {
    createEmptyStatus,
    normalizeSessionWorkflowPriority,
    normalizeSessionWorkflowState,
    normalizeSessionActivity,
    normalizeSessionSidebarOrder,
    isSessionBusy,
    getSessionSortTime,
    getWorkflowStatusInfo,
    getWorkflowPriorityInfo,
    getSessionPrimaryStatus,
    getSessionStatusSummary,
    getSessionReviewStatusInfo,
    getSessionVisualStatus,
    getSessionTaskFlowStage,
    hasSessionUnreadUpdate,
    hasSessionNeedsAction,
    isSessionCompleteAndReviewed,
    getSessionWorkflowPriorityInfo,
    getSessionAttentionBand,
    compareSessionListSessions,
    resolveApprovalWaitingStatus,
    resolveLiveBarDangerRisk,
    createReadyStatus,
  };

  root.RagentSessionStatusCore = api;
})(typeof globalThis !== "undefined" ? globalThis : {});
