"use strict";

(function attachRagentSessionStateModel(root) {
  const fallbackStrings = {
    "status.idle": "idle",
    "status.runUnknown": "Status unknown",
    "status.running": "running",
    "workflow.priority.high": "High",
    "workflow.priority.highTitle": "Needs user attention soon.",
    "workflow.priority.medium": "Medium",
    "workflow.priority.mediumTitle": "Worth checking soon, but not urgent.",
    "workflow.priority.low": "Low",
    "workflow.priority.lowTitle": "Safe to leave for later.",
    "workflow.status.waiting": "needs user",
    "workflow.status.waitingTitle": "Blocked on user input",
    "workflow.status.done": "done",
    "workflow.status.doneTitle": "Current task complete",
    "workflow.status.parked": "parked",
    "workflow.status.parkedTitle": "Parked for later",
    "workflow.status.queued": "queued",
    "workflow.status.queuedTitle": "{count} follow-up{suffix} queued",
    "workflow.status.checking": "confirming route",
    "workflow.status.compacting": "compacting",
    "workflow.status.renaming": "renaming",
    "workflow.status.renameFailed": "rename failed",
    "workflow.status.renameFailedTitle": "Session rename failed",
    "workflow.status.unread": "new",
    "workflow.status.unreadTitle": "Updated since you last reviewed this session",
    "taskFlow.uploading": "Uploading attachment...",
    "taskFlow.sending": "Sending...",
    "taskFlow.checking": "Sent, confirming route...",
    "taskFlow.checkingSlow": "Still confirming the route; Ragent will continue here if routing times out.",
    "taskFlow.processing": "Received, waiting for activity...",
    "taskFlow.running": "Working...",
    "taskFlow.providerSlotWait": "Waiting for this AgY account to finish its previous task...",
    "taskFlow.authRetrying": "Reconnecting the account...",
    "taskFlow.authRecovered": "Account reconnected",
    "taskFlow.authRetryExhausted": "Account could not be reconnected",
    "taskFlow.reauthRequired": "Sign-in required",
    "taskFlow.queued": "{count} follow-up{suffix} queued",
    "taskFlow.compacting": "Compacting context...",
    "taskFlow.waitingUser": "Waiting for your input",
    "taskFlow.done": "Done",
    "taskFlow.parked": "Parked",
    "liveBar.idle": "Ready",
    "workflow.waiting.approval": "Approval needed",
    "workflow.waiting.approvalTitle": "An action needs your approval",
    "workflow.waiting.plan": "Plan awaiting approval",
    "workflow.waiting.planTitle": "The proposed plan is ready for your approval",
    "workflow.waiting.danger": "Dangerous action awaiting approval",
    "workflow.waiting.dangerTitle": "A potentially dangerous action needs your approval",
    "workflow.waiting.answer": "Awaiting your reply",
    "workflow.waiting.answerTitle": "A question needs your answer",
  };

  function fallbackTranslate(key, vars = {}) {
    const template = fallbackStrings[key];
    if (!template) return key;
    return template.replace(/\{(\w+)\}/g, (match, token) => (
      Object.prototype.hasOwnProperty.call(vars, token) ? String(vars[token]) : match
    ));
  }

  const t = root.ragentT
    ? (key, vars) => root.ragentT(key, vars)
    : fallbackTranslate;
  const workflowPrioritySpecs = {
    high: {
      key: "high",
      label: t("workflow.priority.high"),
      rank: 3,
      className: "workflow-priority-high",
      title: t("workflow.priority.highTitle"),
    },
    medium: {
      key: "medium",
      label: t("workflow.priority.medium"),
      rank: 2,
      className: "workflow-priority-medium",
      title: t("workflow.priority.mediumTitle"),
    },
    low: {
      key: "low",
      label: t("workflow.priority.low"),
      rank: 1,
      className: "workflow-priority-low",
      title: t("workflow.priority.lowTitle"),
    },
  };

  const workflowStatusSpecs = {
    waiting_user: {
      key: "waiting_user",
      label: t("workflow.status.waiting"),
      className: "status-waiting-user",
      dotClass: "",
      itemClass: "",
      title: t("workflow.status.waitingTitle"),
    },
    done: {
      key: "done",
      label: t("workflow.status.done"),
      className: "status-done",
      dotClass: "",
      itemClass: "",
      title: t("workflow.status.doneTitle"),
    },
    parked: {
      key: "parked",
      label: t("workflow.status.parked"),
      className: "status-parked",
      dotClass: "",
      itemClass: "",
      title: t("workflow.status.parkedTitle"),
    },
  };

  function createEmptyStatus() {
    return {
      key: "idle",
      label: "",
      className: "",
      dotClass: "",
      itemClass: "",
      title: "",
    };
  }

  function createStatus(key, label, className = "", dotClass = "", itemClass = "", title = "") {
    return {
      key,
      label,
      className,
      dotClass,
      itemClass,
      title,
    };
  }

  function parseTaskFlowPendingSend(pendingSend, sessionId = "") {
    if (!pendingSend || typeof pendingSend !== "object") return null;
    const pendingSessionId = typeof pendingSend.sessionId === "string" ? pendingSend.sessionId.trim() : "";
    if (sessionId && pendingSessionId && pendingSessionId !== sessionId) return null;
    let stage = "sending";
    if (pendingSend.stage === "uploading") {
      stage = "uploading";
    } else if (pendingSend.stage === "checking") {
      stage = "checking";
    } else if (pendingSend.stage === "processing") {
      stage = "processing";
    }
    const startedAt = parseSessionTime(pendingSend.startedAt);
    return {
      stage,
      startedAt,
    };
  }

  function createTaskFlowStatus(key, labelKey, {
    vars = {},
    className = "",
    dotClass = "",
    itemClass = "",
    title = "",
  } = {}) {
    return createStatus(
      key,
      t(labelKey, vars),
      className,
      dotClass,
      itemClass,
      title,
    );
  }


  // -- waiting/profile classification -------------------------------------------------
  // Resolve the SEPARATE waiting states the Live Bar surfaces for a pending
  // user action. The server workflow state only knows "waiting_user"; the live
  // pending approval event (RagentDecisions) carries the kind (plan/question/
  // command/permissions) and risk so the user sees exactly what they are being
  // asked to do: approve a plan, approve a dangerous action, approve a generic
  // action, or answer a question.
  const LIVE_BAR_DANGER_VALUES = new Set([
    "high", "critical", "danger", "dangerous", "severe", "elevated",
  ]);

  function resolveLiveBarDangerRisk(approval) {
    const raw = approval?.risk ?? approval?.riskLevel ?? approval?.severity
      ?? approval?.level ?? approval?.tier;
    const normalized = String(raw || "").trim().toLowerCase();
    return LIVE_BAR_DANGER_VALUES.has(normalized);
  }

  function isApprovalBlocking(approval) {
    if (!approval || typeof approval !== "object") return true;
    return approval.isBlocking !== false;
  }

  // Map a pending approval/question event to a distinct Live Bar waiting state.
  // Returns null when the event is not a user-facing waiting action.
  function resolveApprovalWaitingStatus(approval) {
    if (!approval || typeof approval !== "object") return null;
    const blocking = isApprovalBlocking(approval);
    const withBlocking = (status) => (status && !blocking ? { ...status, isBlocking: false } : status);
    const kind = String(approval?.kind || "").trim().toLowerCase();
    const isQuestion = kind === "question"
      || !!approval?.question
      || (Array.isArray(approval?.questions) && approval.questions.length > 0);
    if (kind === "plan") {
      return withBlocking(createTaskFlowStatus("plan_pending", "workflow.waiting.plan", {
        className: "status-plan-pending",
        dotClass: "plan-pending",
        title: t("workflow.waiting.planTitle"),
      }));
    }
    if (isQuestion) {
      return withBlocking(createTaskFlowStatus("awaiting_answer", "workflow.waiting.answer", {
        className: "status-awaiting-answer",
        dotClass: "awaiting-answer",
        title: t("workflow.waiting.answerTitle"),
      }));
    }
    if (resolveLiveBarDangerRisk(approval)) {
      return withBlocking(createTaskFlowStatus("danger_pending", "workflow.waiting.danger", {
        className: "status-danger-pending",
        dotClass: "danger-pending",
        title: t("workflow.waiting.dangerTitle"),
      }));
    }
    return withBlocking(createTaskFlowStatus("approval_pending", "workflow.waiting.approval", {
      className: "status-approval-pending",
      dotClass: "approval-pending",
      title: t("workflow.waiting.approvalTitle"),
    }));
  }

  function createReadyStatus() {
    return createTaskFlowStatus("ready", "liveBar.idle", {
      className: "status-ready",
      dotClass: "ready",
    });
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
    const normalized = normalizeSessionWorkflowPriority(value);
    if (!normalized || !workflowPrioritySpecs[normalized]) return null;
    return { ...workflowPrioritySpecs[normalized] };
  }

  function getWorkflowStatusInfo(value) {
    const normalized = normalizeSessionWorkflowState(value);
    if (!normalized || !workflowStatusSpecs[normalized]) return null;
    return { ...workflowStatusSpecs[normalized] };
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

  function getSessionSortTime(session) {
    const activity = normalizeSessionActivity(session);
    if (activity.run.state === "running" && activity.run.startedAt) {
      const startedAt = parseSessionTime(activity.run.startedAt);
      if (startedAt > 0) return startedAt;
    }
    return getSessionLatestChangeTime(session);
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
    const rawRunState = activeRuns ? (activeRun ? (activeRun.state === "unknown" ? "unknown" : "running") : unresolvedRun ? "unknown" : "idle") : raw?.run?.state;
    const runState =
      rawRunState === "running" || rawRunState === "unknown"
        ? rawRunState
        : "idle";
    const providerSlotState = raw?.run?.providerSlot?.state === "waiting"
      ? "waiting"
      : "idle";
    const queueCount = Number.isInteger(raw?.queue?.count)
      ? raw.queue.count
      : 0;
    const queueState = raw?.queue?.state === "queued" && queueCount > 0
      ? "queued"
      : "idle";
    const renameState = raw?.rename?.state === "pending" || raw?.rename?.state === "failed"
      ? raw.rename.state
      : "idle";
    const compactState = raw?.compact?.state === "pending"
      ? "pending"
      : "idle";
    const planningCount = Number.isInteger(raw?.planning?.count)
      ? raw.planning.count
      : 0;
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
      queue: {
        state: queueState,
        count: queueCount,
      },
      rename: {
        state: renameState,
        error: typeof raw?.rename?.error === "string" ? raw.rename.error : "",
      },
      compact: {
        state: compactState,
      },
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

  function getSessionPrimaryStatus(session, options = {}) {
    if (!session) {
      return createEmptyStatus();
    }

    const indicators = getSessionStatusSummary(session, options).indicators;
    return indicators[0] || createStatus("idle", t("status.idle"));
  }

  function getSessionStatusSummary(session, { includeToolFallback = false } = {}) {
    const activity = normalizeSessionActivity(session);
    const indicators = [];

    const authRecovery = activity.run.authRecovery;
    if (authRecovery?.state === "auth_retrying") {
      indicators.push(createTaskFlowStatus("auth_retrying", "taskFlow.authRetrying", {
        className: "status-auth-retrying",
        dotClass: "running",
      }));
    } else if (authRecovery?.state === "auth_recovered") {
      indicators.push(createTaskFlowStatus("auth_recovered", "taskFlow.authRecovered", {
        className: "status-auth-recovered",
        dotClass: "ready",
      }));
    } else if (authRecovery?.state === "auth_retry_exhausted") {
      indicators.push(createTaskFlowStatus("auth_retry_exhausted", "taskFlow.authRetryExhausted", {
        className: "status-auth-retry-exhausted",
        dotClass: "awaiting-answer",
      }));
    } else if (authRecovery?.state === "reauth_required") {
      indicators.push(createTaskFlowStatus("reauth_required", "taskFlow.reauthRequired", {
        className: "status-reauth-required",
        dotClass: "awaiting-answer",
      }));
    }

    if (activity.run.providerSlot?.state === "waiting") {
      indicators.push(createTaskFlowStatus("provider_slot_wait", "taskFlow.providerSlotWait", {
        className: "status-queued",
        dotClass: "queued",
      }));
    }

    if (activity.run.state === "unknown") {
      indicators.push(createStatus("unknown", t("status.runUnknown"), "status-running", "running"));
    } else if (activity.run.state === "running") {
      indicators.push(createStatus("running", t("status.running"), "status-running", "running"));
    }

    if (activity.queue.state === "queued") {
      indicators.push(createStatus(
        "queued",
        t("workflow.status.queued"),
        "status-queued",
        "queued",
        "",
        activity.queue.count > 0
          ? t("workflow.status.queuedTitle", {
            count: activity.queue.count,
            suffix: activity.queue.count === 1 ? "" : "s",
          })
          : "",
      ));
    }

    if (activity.planning.state === "checking") {
      indicators.push(createStatus("checking", t("workflow.status.checking"), "status-queued", "queued"));
    }

    if (activity.compact.state === "pending") {
      indicators.push(createStatus("compacting", t("workflow.status.compacting"), "status-compacting", "compacting"));
    }

    if (activity.rename.state === "pending") {
      indicators.push(createStatus("renaming", t("workflow.status.renaming"), "status-renaming", "renaming"));
    }

    if (activity.rename.state === "failed") {
      indicators.push(createStatus(
        "rename-failed",
        t("workflow.status.renameFailed"),
        "status-rename-failed",
        "rename-failed",
        "",
        activity.rename.error || t("workflow.status.renameFailedTitle"),
      ));
    }

    const primary = indicators[0] || (
      session?.tool && includeToolFallback
        ? createStatus("tool", session.tool)
        : createStatus("idle", t("status.idle"))
    );

    return {
      primary,
      indicators: indicators.length > 0 || !primary.label ? indicators : [primary],
    };
  }

  function getSessionVisualStatus(session, options = {}) {
    return getSessionTaskFlowStage(session, options) || getSessionStatusSummary(session, options).primary;
  }

  function getSessionTaskFlowStage(session, options = {}) {
    if (!session) {
      return options.includeIdle === false ? null : createStatus("idle", t("status.idle"));
    }

    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const activity = normalizeSessionActivity(session);
    const pendingSend = parseTaskFlowPendingSend(options.pendingSend, session.id || "");
    const pendingElapsedMs = pendingSend?.startedAt > 0 ? Math.max(0, now - pendingSend.startedAt) : 0;

    if (pendingSend?.stage === "uploading") {
      return createTaskFlowStatus("uploading", "taskFlow.uploading", {
        className: "status-queued",
        dotClass: "queued",
      });
    }

    if (pendingSend?.stage === "sending") {
      return createTaskFlowStatus("sending", "taskFlow.sending", {
        className: "status-queued",
        dotClass: "queued",
      });
    }

    const authRecovery = activity.run.authRecovery;
    if (authRecovery?.state === "auth_retrying") {
      return createTaskFlowStatus("auth_retrying", "taskFlow.authRetrying", {
        className: "status-auth-retrying",
        dotClass: "running",
      });
    }
    if (authRecovery?.state === "auth_recovered") {
      return createTaskFlowStatus("auth_recovered", "taskFlow.authRecovered", {
        className: "status-auth-recovered",
        dotClass: "ready",
      });
    }
    if (authRecovery?.state === "auth_retry_exhausted") {
      return createTaskFlowStatus("auth_retry_exhausted", "taskFlow.authRetryExhausted", {
        className: "status-auth-retry-exhausted",
        dotClass: "awaiting-answer",
      });
    }
    if (authRecovery?.state === "reauth_required") {
      return createTaskFlowStatus("reauth_required", "taskFlow.reauthRequired", {
        className: "status-reauth-required",
        dotClass: "awaiting-answer",
      });
    }

    if (activity.run.providerSlot?.state === "waiting") {
      return createTaskFlowStatus("provider_slot_wait", "taskFlow.providerSlotWait", {
        className: "status-queued",
        dotClass: "queued",
      });
    }

    if (activity.run.state === "unknown") {
      return createTaskFlowStatus("unknown", "status.runUnknown", { className: "status-running", dotClass: "running" });
    }
    if (activity.run.state === "running") {
      return createTaskFlowStatus("running", "taskFlow.running", {
        className: "status-running",
        dotClass: "running",
      });
    }

    if (activity.compact.state === "pending") {
      return createTaskFlowStatus("compacting", "taskFlow.compacting", {
        className: "status-compacting",
        dotClass: "compacting",
      });
    }

    if (activity.planning.state === "checking" || pendingSend?.stage === "checking") {
      const slowChecking = pendingElapsedMs >= 10000;
      return createTaskFlowStatus("checking", slowChecking ? "taskFlow.checkingSlow" : "taskFlow.checking", {
        className: "status-queued",
        dotClass: "queued",
      });
    }

    if (activity.queue.state === "queued") {
      return createTaskFlowStatus("queued", "taskFlow.queued", {
        vars: {
          count: activity.queue.count,
          suffix: activity.queue.count === 1 ? "" : "s",
        },
        className: "status-queued",
        dotClass: "queued",
        title: activity.queue.count > 0
          ? t("workflow.status.queuedTitle", {
            count: activity.queue.count,
            suffix: activity.queue.count === 1 ? "" : "s",
          })
          : "",
      });
    }

    if (pendingSend?.stage === "processing") {
      return createTaskFlowStatus("processing", "taskFlow.processing", {
        className: "status-queued",
        dotClass: "queued",
      });
    }

    const workflowState = normalizeSessionWorkflowState(session?.workflowState || "");
    if (workflowState === "waiting_user") {
      return createTaskFlowStatus("waiting_user", "taskFlow.waitingUser", {
        className: "status-waiting-user",
        dotClass: "waiting-user",
      });
    }
    if (workflowState === "done") {
      return createTaskFlowStatus("done", "taskFlow.done", {
        className: "status-done",
        dotClass: "done",
      });
    }
    if (workflowState === "parked") {
      return createTaskFlowStatus("parked", "taskFlow.parked", {
        className: "status-parked",
        dotClass: "parked",
      });
    }

    return options.includeIdle === false ? null : createStatus("idle", t("status.idle"));
  }

  function getSessionWorkflowPriorityInfo(session) {
    const explicitPriority = getWorkflowPriorityInfo(session?.workflowPriority);
    if (explicitPriority) return explicitPriority;
    const workflowState = normalizeSessionWorkflowState(session?.workflowState || "");
    if (workflowState === "waiting_user") return getWorkflowPriorityInfo("high");
    if (workflowState === "done") return getWorkflowPriorityInfo("low");
    return getWorkflowPriorityInfo("medium");
  }

  function hasSessionUnreadUpdate(session) {
    if (!session) return false;
    if (isSessionBusy(session)) return false;
    const unreadUpdateTime = getSessionUnreadUpdateTime(session);
    if (unreadUpdateTime <= 0) return false;
    return unreadUpdateTime > getSessionReviewTime(session);
  }

  // A session blocked on the user (approval / question) carries the amber
  // "needs action" dot while the waiting state began after the owner last
  // reviewed the session: opening the session moves the review stamp past
  // the state-change timestamp (workflowStateChangedAt) and the dot clears,
  // like the unread dot. Sessions without a state-change timestamp
  // (pre-upgrade data) fall back to lastActivityAt, or legacy lastEventAt when
  // the activity field is absent. The review stamp written on open uses the
  // same source, so a session the owner opened still clears. Only sessions
  // with no timestamp at all keep the dot, so a real wait is never silently
  // hidden.
  function hasSessionNeedsAction(session) {
    if (!session) return false;
    const workflowState = normalizeSessionWorkflowState(session?.workflowState || "");
    if (workflowState !== "waiting_user") return false;
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
    return createStatus(
      "unread",
      t("workflow.status.unread"),
      "status-unread",
      "",
      "",
      t("workflow.status.unreadTitle"),
    );
  }

  function isSessionCompleteAndReviewed(session) {
    const workflowState = normalizeSessionWorkflowState(session?.workflowState || "");
    return workflowState === "done"
      && !isSessionBusy(session)
      && !hasSessionUnreadUpdate(session);
  }

  function getSessionAttentionBand(session) {
    const workflowState = normalizeSessionWorkflowState(session?.workflowState || "");
    const busy = isSessionBusy(session);
    const unread = hasSessionUnreadUpdate(session);

    if (unread && workflowState === "waiting_user") return 0;
    if (unread) return 1;
    if (workflowState === "waiting_user") return 2;
    if (!busy && workflowState !== "done" && workflowState !== "parked") return 3;
    if (busy) return 4;
    if (workflowState === "parked") return 5;
    if (workflowState === "done") return 6;
    return 3;
  }

  function compareSessionListSessions(a, b) {
    const pinRankA = a?.pinned === true ? 1 : 0;
    const pinRankB = b?.pinned === true ? 1 : 0;
    const pinDiff = pinRankB - pinRankA;
    if (pinDiff) return pinDiff;

    const sidebarOrderA = normalizeSessionSidebarOrder(a?.sidebarOrder);
    const sidebarOrderB = normalizeSessionSidebarOrder(b?.sidebarOrder);
    if (pinRankA && pinRankB && sidebarOrderA && sidebarOrderB && sidebarOrderA !== sidebarOrderB) {
      return sidebarOrderA - sidebarOrderB;
    }

    const sortTimeDiff = getSessionSortTime(b) - getSessionSortTime(a);
    if (sortTimeDiff) return sortTimeDiff;

    const attentionBandDiff = getSessionAttentionBand(a) - getSessionAttentionBand(b);
    if (attentionBandDiff) return attentionBandDiff;

    const priorityDiff = (getSessionWorkflowPriorityInfo(b)?.rank || 0) - (getSessionWorkflowPriorityInfo(a)?.rank || 0);
    if (priorityDiff) return priorityDiff;

    if (sidebarOrderA && sidebarOrderB && sidebarOrderA !== sidebarOrderB) {
      return sidebarOrderA - sidebarOrderB;
    }

    return String(a?.id || "").localeCompare(String(b?.id || ""));
  }

  root.RagentSessionStateModel = {
    createEmptyStatus,
    normalizeSessionWorkflowPriority,
    normalizeSessionWorkflowState,
    normalizeSessionActivity,
    isSessionBusy,
    getSessionSortTime,
    getWorkflowStatusInfo,
    getSessionPrimaryStatus,
    getSessionStatusSummary,
    getSessionVisualStatus,
    getSessionTaskFlowStage,
    hasSessionUnreadUpdate,
    hasSessionNeedsAction,
    getSessionReviewStatusInfo,
    isSessionCompleteAndReviewed,
    getSessionWorkflowPriorityInfo,
    getSessionAttentionBand,
    compareSessionListSessions,
    resolveApprovalWaitingStatus,
    isApprovalBlocking,
    resolveLiveBarDangerRisk,
    createReadyStatus,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
