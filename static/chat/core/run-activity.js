"use strict";

// Pure run-activity projections (Stage 2 extraction of run-activity-ui.js,
// unlocked once the retained-sends WIP (§6.5) landed): event boundary
// resolution, text clipping / base-name helpers, deterministic subject
// formatting, plan-item normalization and
// progress presentation, tool-kind inference and optimistic activity
// projections. i18n (t) is injected via the environment contract
// (root.RagentRunActivityEnvironment) with the same fallbacks as the
// legacy module (key passthrough / String(value ?? "")). Two legacy
// bindings are deliberately not ported: formatRunActivitySummary's
// default `activity = currentActivity` (module-singleton state; callers
// pass the activity explicitly) and the module-state half (setActivity /
// applyEvent / noteProgressPlan / presentation getters / subscribe).
// Locked against the legacy implementation by
// tests/test-chat-run-activity-core.mjs.

(function attachRagentRunActivityCore(root) {
  const DEFAULT_ENVIRONMENT = Object.freeze({
    t: null,
  });
  const environment = new Proxy(
    root.RagentRunActivityEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  function tr(key, vars = {}) {
    return typeof environment.t === "function" ? environment.t(key, vars) : key;
  }

  function trOrFallback(key, fallback) {
    const value = tr(key);
    return value && value !== key ? value : fallback;
  }

  function eventBoundary(event) {
    if (Number.isInteger(event?.endSeq) && event.endSeq > 0) return event.endSeq;
    if (Number.isInteger(event?.blockEndSeq) && event.blockEndSeq > 0) return event.blockEndSeq;
    return Number.isInteger(event?.seq) ? event.seq : 0;
  }

  function baseName(value) {
    const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized) return "";
    return normalized.slice(normalized.lastIndexOf("/") + 1);
  }

  function clip(value, maxLength = 48) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
  }

  function subjectForActivity(activity) {
    const explicit = activity?.subject;
    if (typeof explicit === "string" && explicit.trim()) return clip(explicit);
    const kind = String(activity?.labelKind || activity?.kind || "").trim().toLowerCase();
    const detail = String(activity?.detail || "").trim();
    if (["file_edit", "edit", "read", "delete"].includes(kind)) return baseName(detail);
    if (kind === "search") return clip(detail.split(/\s+·\s+/)[0]);
    if (["web", "fetch", "click", "input", "scroll", "capture", "generate", "mcp", "subagent", "task_create", "task_update", "task_read", "task_list", "task_stop", "message", "wait", "question", "other", "command", "execute", "move", "switch_mode"].includes(kind)) return clip(detail, 80);
    return "";
  }

  function normalizeActivityKind(activity) {
    const supportedKinds = new Set([
      "approval", "command", "execute", "execute_composite", "read", "list", "inspect", "search", "file_edit", "edit",
      "delete", "move", "web", "fetch", "click", "input", "scroll", "capture", "generate", "mcp", "subagent", "task_create", "task_update", "task_read",
      "task_list", "task_stop", "message", "wait", "question", "other", "planning", "responding",
      "think", "switch_mode", "thinking", "waiting", "working",
    ]);
    const candidateKind = String(activity?.labelKind || activity?.kind || "working").trim().toLowerCase() || "working";
    return supportedKinds.has(candidateKind) ? candidateKind : "working";
  }

  function normalizeActivityLifecycle(value) {
    const lifecycle = String(value || "running").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (["waiting_user", "waiting_approval", "approval_requested"].includes(lifecycle)) {
      return "waiting_approval";
    }
    if (["completed", "complete", "done", "success", "succeeded"].includes(lifecycle)) return "completed";
    if (["failed", "error"].includes(lifecycle)) return "failed";
    if (["declined", "denied"].includes(lifecycle)) return "declined";
    if (["interrupted", "cancelled", "canceled"].includes(lifecycle)) return "interrupted";
    return "running";
  }

  function appendActivitySubject(text, subject) {
    const normalizedText = String(text || "").trim();
    const normalizedSubject = String(subject || "").trim();
    if (!normalizedSubject) return normalizedText;
    return `${normalizedText}${normalizedText ? " " : ""}${normalizedSubject}`.trim();
  }

  function translatedActivityText(key, vars = {}) {
    const value = tr(key, vars);
    return value && value !== key ? String(value).trim() : "";
  }

  function formatOperationActivity(activity = {}, { trailing = false } = {}) {
    if (!activity || activity.state === "idle") return "";
    const kind = normalizeActivityKind(activity);
    const lifecycle = normalizeActivityLifecycle(activity.operationState || activity.state);
    const description = String(activity?.activityDescription || activity?.presentation?.activityDescription || "").trim();
    if (lifecycle === "running" && description) return description;
    const group = activity?.group && typeof activity.group === "object" ? activity.group : null;
    if (group?.kind === "exploring" && Number(group.count) > 1) {
      const exploring = translatedActivityText("activity.action.running.exploring", { count: group.count });
      if (exploring) return trailing ? `${exploring}…` : exploring;
    }
    const subject = subjectForActivity(activity);
    const actionKey = `activity.action.${lifecycle}.${kind}`;
    const genericKey = `activity.action.${lifecycle}`;
    const action = translatedActivityText(actionKey, { subject });
    const generic = translatedActivityText(genericKey, { subject });
    let text = action
      ? action
      : (generic
        ? (lifecycle === "waiting_approval" ? generic : appendActivitySubject(generic, subject))
        : "");

    if (!text && lifecycle === "running") {
      text = appendActivitySubject(translatedActivityText(`activity.label.${kind}`), subject);
    }
    if (!text && lifecycle === "waiting_approval") text = translatedActivityText("operation.state.waiting_approval");
    if (!text) text = translatedActivityText(`operation.state.${lifecycle}`);
    text = String(text || "").trim();
    return trailing && text ? `${text}…` : text;
  }

  function formatRunActivitySummary(activity) {
    if (!activity || activity.state === "idle") return "";
    const kind = normalizeActivityKind(activity);
    const text = formatOperationActivity(activity);
    const waitingForOutput = activity?.providerLiveness?.phase === "awaiting_provider_output"
      && !["approval", "responding", "waiting"].includes(kind);
    const livenessLabel = waitingForOutput
      ? trOrFallback("activity.status.awaitingProviderOutput", "waiting for provider output")
      : "";
    const nativeDescription = String(activity?.activityDescription || activity?.presentation?.activityDescription || "").trim();
    return `${text}${livenessLabel ? ` · ${livenessLabel}` : ""}${!nativeDescription && (text || livenessLabel) ? "…" : ""}`;
  }

  function normalizePlanItemStatus(value) {
    const status = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (["completed", "complete", "done", "success", "succeeded"].includes(status)) return "completed";
    if (["in_progress", "active", "current", "running", "started"].includes(status)) return "in_progress";
    return "pending";
  }

  function normalizePlanItems(event) {
    const sourceItems = Array.isArray(event?.items)
      ? event.items
      : (Array.isArray(event?.plan) ? event.plan : []);
    return sourceItems
      .map((item) => (item && typeof item === "object" ? item : { text: item }))
      .map((item) => ({
        text: String(item.text || item.title || item.step || "").replace(/\s+/g, " ").trim(),
        status: normalizePlanItemStatus(item.status || item.state || (item.completed === true ? "completed" : "pending")),
      }))
      .filter((item) => item.text);
  }

  function isProgressPlanEvent(event) {
    if (String(event?.type || "") !== "plan") return false;
    const planIntent = String(event?.planIntent || "").trim().toLowerCase();
    if (planIntent) return planIntent === "progress";
    return String(event?.interactionMode || "").trim().toLowerCase() === "agent";
  }

  function buildProgressPresentation(event) {
    const items = normalizePlanItems(event);
    const total = items.length;
    if (total === 0) return null;
    const completed = items.filter((item) => item.status === "completed").length;
    if (completed >= total) return null;
    const current = items.find((item) => item.status === "in_progress")
      || items.find((item) => item.status === "pending")
      || items[items.length - 1];
    const summary = tr("plan.progress.summary", {
      completed,
      total,
      current: clip(current?.text || tr("plan.progress.empty"), 72),
    });
    return {
      text: summary,
      completed,
      total,
      current: current?.text || "",
      runId: String(event?.runId || "").trim(),
      sourceSeq: eventBoundary(event),
    };
  }

  function getPresentation() {
    const sourceSeq = Number.isInteger(currentActivity?.sourceSeq) ? currentActivity.sourceSeq : 0;
    return {
      activity: currentActivity,
      text: formatRunActivitySummary(currentActivity),
      inlineVisible: !!currentActivity
        && currentActivity.state !== "idle",
      sourceSeq,
    };
  }

  function getLivePresentation() {
    return currentProgress
      ? {
        progress: currentProgress,
        text: currentProgress.text || "",
        sourceSeq: Number.isInteger(currentProgress.sourceSeq) ? currentProgress.sourceSeq : 0,
      }
      : {
        progress: null,
        text: formatRunActivitySummary(currentActivity),
        sourceSeq: Number.isInteger(currentActivity?.sourceSeq) ? currentActivity.sourceSeq : 0,
      };
  }

  function notify() {
    const presentation = getPresentation();
    for (const subscriber of subscribers) {
      try {
        subscriber(presentation);
      } catch (error) {
        console.warn("[run-activity] subscriber failed:", error?.message || error);
      }
    }
  }

  function setActivity(activity) {
    currentActivity = activity && typeof activity === "object" ? { ...activity } : null;
    notify();
  }

  function reset() {
    currentActivity = null;
    currentProgress = null;
    notify();
  }

  function noteProgressPlan(event = {}) {
    if (!isProgressPlanEvent(event)) return false;
    const sourceSeq = eventBoundary(event);
    const currentSeq = Number.isInteger(currentProgress?.sourceSeq) ? currentProgress.sourceSeq : 0;
    if (sourceSeq > 0 && currentSeq > 0 && sourceSeq < currentSeq) return false;
    const nextProgress = buildProgressPresentation(event);
    currentProgress = nextProgress;
    notify();
    return true;
  }

  function noteFormalOutput() {
    notify();
  }

  function inferToolKind(event) {
    const toolName = String(event?.toolName || "").trim().toLowerCase();
    if (["write", "edit", "multiedit", "notebookedit", "apply_patch"].includes(toolName)) return "file_edit";
    if (["read", "view", "cat"].includes(toolName)) return "read";
    if (["grep", "glob", "search", "rg", "find"].includes(toolName)) return "search";
    if (toolName.includes("web") || toolName.includes("browser")) return "web";
    if (toolName.includes("agent")) return "subagent";
    if (["bash", "shell", "shell_command", "command"].includes(toolName)) return "command";
    return "mcp";
  }

  function optimisticActivityForEvent(event) {
    const type = String(event?.type || "");
    if (type === "operation") {
      return {
        kind: String(event.kind || "working").trim().toLowerCase() || "working",
        detail: event.detail || event.command || "",
        operationId: event.operationId || "",
        operationState: event.state || "running",
        activityDescription: event.activityDescription || event.presentation?.activityDescription || "",
        activityDescriptionSource: event.activityDescriptionSource || event.presentation?.activityDescriptionSource || "",
      };
    }
    if (type === "file_change") return { kind: "file_edit", detail: event.filePath || "" };
    if (type === "tool_use") return { kind: inferToolKind(event), detail: event.filePath || "", activityDescription: event.activityDescription || "", activityDescriptionSource: event.activityDescriptionSource || "" };
    if (type === "thinking_block" || type === "reasoning") return { kind: "thinking", detail: "" };
    if (type === "context_operation" || type === "context_barrier") return { kind: "working", detail: "" };
    if (type === "status") return { kind: "working", detail: "" };
    return null;
  }

  root.RagentRunActivityCore = {
    eventBoundary,
    baseName,
    clip,
    subjectForActivity,
    formatOperationActivity,
    formatRunActivitySummary,
    normalizePlanItemStatus,
    normalizePlanItems,
    isProgressPlanEvent,
    buildProgressPresentation,
    inferToolKind,
    optimisticActivityForEvent,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
