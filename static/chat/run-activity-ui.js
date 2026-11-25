"use strict";

(function attachRunActivityUI(root) {
  const subscribers = new Set();
  let currentActivity = null;
  let currentProgress = null;
  let generation = 0;
  let snapshotRequest = 0;
  let liveGeneration = 0;
  let liveEvents = [];
  let currentTurn = null;
  const closedRuns = new Set();

  function tr(key, vars = {}) {
    return root.ragentT ? root.ragentT(key, vars) : key;
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
    if (webActionForActivity(activity)) return "";
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

  function trustedActivityDescription(activity) {
    if (!activity || activity.actionRequired === true || activity.state === "queued"
      || activity.state === "waiting_user" || normalizeActivityKind(activity) === "approval"
      || normalizeActivityLifecycle(activity.operationState || activity.state) !== "running") return "";
    if (!["operationId", "toolCallId", "providerItemId", "providerToolUseId"].some((key) => String(activity[key] || "").trim())) return "";
    for (const candidate of [activity, activity.presentation]) {
      if (!["tool_input_description", "provider_title"].includes(candidate?.activityDescriptionSource)) continue;
      const text = typeof candidate.activityDescription === "string" ? candidate.activityDescription.trim() : "";
      if (text) return text;
    }
    return "";
  }

  function descriptionFields(event) {
    for (const candidate of [event, event?.presentation]) {
      if (!["tool_input_description", "provider_title"].includes(candidate?.activityDescriptionSource)) continue;
      if (typeof candidate.activityDescription !== "string" || !candidate.activityDescription.trim()) continue;
      return { activityDescription: candidate.activityDescription, activityDescriptionSource: candidate.activityDescriptionSource };
    }
    return { activityDescription: "", activityDescriptionSource: "" };
  }

  function webActionForActivity(activity) {
    const value = activity?.webAction || activity?.presentation?.webAction || activity?.toolCall?._meta?.ragent?.webAction;
    return ["search", "open", "find", "mixed", "generic"].includes(value) ? value : "";
  }

  function operationProgressForActivity(activity) {
    if (!activity || activity.actionRequired === true || activity.state === "queued" || activity.state === "waiting_user"
      || normalizeActivityLifecycle(activity.operationState || activity.state) !== "running"
      || !["operationId", "toolCallId", "providerItemId", "providerToolUseId"].some((key) => String(activity[key] || "").trim())) return "";
    const value = activity.operationProgress || activity.presentation?.operationProgress || activity.toolCall?._meta?.ragent?.operationProgress;
    return typeof value === "string" ? clip(value, 120) : "";
  }

  function currentTurnProgress(activity) {
    const progress = activity?.turnProgress;
    if (!progress || typeof progress.text !== "string" || !progress.text.trim()
      || !progress.runId || !progress.turnId || !progress.messageId || !Number.isInteger(progress.sourceSeq) || progress.sourceSeq <= 0
      || !activity.runId || activity.runId !== progress.runId
      || (activity.providerTurnId && activity.providerTurnId !== progress.turnId)) return "";
    return clip(progress.text, 72);
  }

  // Codex presents tool work as a short verb plus its target. Keep that
  // language-neutral shape here so the Live Bar, Run Sheet and desktop row
  // cannot drift into separate descriptions of the same operation.
  function formatOperationActivity(activity = {}, { trailing = false } = {}) {
    if (!activity || activity.state === "idle") return "";
    if (activity.state === "queued") return translatedActivityText("activity.label.waiting");
    const kind = normalizeActivityKind(activity);
    const lifecycle = activity.actionRequired === true || activity.state === "waiting_user"
      ? "waiting_approval" : normalizeActivityLifecycle(activity.operationState || activity.state);
    const description = trustedActivityDescription(activity);
    if (lifecycle === "running" && description) return description;
    const progress = lifecycle === "running" ? operationProgressForActivity(activity) : "";
    if (progress) return progress;
    const webAction = webActionForActivity(activity);
    const webText = webAction ? translatedActivityText(`activity.web.${webAction}`) : "";
    const turnText = lifecycle === "running" && activity.state !== "queued" ? currentTurnProgress(activity) : "";
    if (turnText) {
      const prefix = translatedActivityText("activity.turnProgress");
      return `${prefix} ${turnText}${webText ? ` · ${webText}` : ""}`.trim();
    }
    if (lifecycle === "running" && webText) return webText;
    const group = activity?.group && typeof activity.group === "object" ? activity.group : null;
    if (lifecycle === "running" && group?.kind === "exploring" && Number(group.count) > 1) {
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

  function formatRunActivitySummary(activity = currentActivity) {
    if (!activity || activity.state === "idle") return "";
    const kind = normalizeActivityKind(activity);
    const text = formatOperationActivity(activity);
    const waitingForOutput = activity?.providerLiveness?.phase === "awaiting_provider_output"
      && !["approval", "responding", "waiting"].includes(kind);
    const livenessLabel = waitingForOutput
      ? trOrFallback("activity.status.awaitingProviderOutput", "waiting for provider output")
      : "";
    const nativeDescription = trustedActivityDescription(activity) || operationProgressForActivity(activity) || currentTurnProgress(activity);
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

  function activitySuffix(activity) {
    if (!currentTurnProgress(activity) || trustedActivityDescription(activity) || operationProgressForActivity(activity)
      || activity?.actionRequired === true || activity?.state === "waiting_user"
      || normalizeActivityLifecycle(activity?.operationState || activity?.state) !== "running") return "";
    const action = webActionForActivity(activity);
    return action ? translatedActivityText(`activity.web.${action}`) : "";
  }

  function getPresentation() {
    const sourceSeq = Math.max(Number.isInteger(currentActivity?.sourceSeq) ? currentActivity.sourceSeq : 0,
      currentTurnProgress(currentActivity) ? currentActivity.turnProgress.sourceSeq : 0);
    return {
      activity: currentActivity,
      text: formatRunActivitySummary(currentActivity),
      suffix: activitySuffix(currentActivity),
      inlineVisible: !!currentActivity
        && currentActivity.state !== "idle",
      sourceSeq,
    };
  }

  function getLivePresentation() {
    const kind = normalizeActivityKind(currentActivity);
    const hasSpecificAction = currentActivity && currentActivity.state !== "idle"
      && (currentActivity.state === "waiting_user" || currentActivity.actionRequired === true
        || !!trustedActivityDescription(currentActivity)
        || !!operationProgressForActivity(currentActivity)
        || !!currentTurnProgress(currentActivity)
        || !!webActionForActivity(currentActivity)
        || (!['thinking', 'think', 'working', 'planning', 'responding', 'waiting', 'other', 'mcp'].includes(kind))
        || !!subjectForActivity(currentActivity));
    return currentProgress && !hasSpecificAction
      ? {
        progress: currentProgress,
        text: currentProgress.text || "",
        sourceSeq: Number.isInteger(currentProgress.sourceSeq) ? currentProgress.sourceSeq : 0,
      }
      : {
        progress: null,
        text: formatRunActivitySummary(currentActivity),
        suffix: activitySuffix(currentActivity),
        sourceSeq: Math.max(Number.isInteger(currentActivity?.sourceSeq) ? currentActivity.sourceSeq : 0,
          currentTurnProgress(currentActivity) ? currentActivity.turnProgress.sourceSeq : 0),
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
    const nextRunId = String(activity?.runId || "").trim();
    if (activity?.state === "idle" && currentActivity?.runId) {
      closedRuns.add(currentActivity.runId);
      if (closedRuns.size > 100) closedRuns.delete(closedRuns.values().next().value);
    }
    if (activity?.state === "idle" || (nextRunId && currentProgress?.runId && nextRunId !== currentProgress.runId)) {
      currentProgress = null;
    }
    const next = activity && typeof activity === "object" ? { ...activity } : null;
    const progress = next?.turnProgress;
    const validSnapshotProgress = currentTurnProgress(next);
    const sameRun = next?.runId && currentTurn?.runId === next.runId;
    if (!next || next.state === "idle" || (currentTurn && next.runId && !sameRun)) currentTurn = null;
    if (validSnapshotProgress && (!currentTurn || !sameRun || progress.sourceSeq > currentTurn.sourceSeq)) {
      currentTurn = { runId: progress.runId, turnId: progress.turnId, threadId: next.providerThreadId || "", sourceSeq: progress.sourceSeq, progress };
    } else if (currentTurn && sameRun && next?.providerTurnId && next.providerTurnId !== currentTurn.turnId
      && Number.isInteger(next.sourceSeq) && next.sourceSeq > currentTurn.sourceSeq) {
      currentTurn = { runId: next.runId, turnId: next.providerTurnId, threadId: next.providerThreadId || "", sourceSeq: next.sourceSeq };
      next.turnProgress = null;
    } else if (!currentTurn && next?.providerTurnId && next?.runId) {
      currentTurn = { runId: next.runId, turnId: next.providerTurnId, threadId: next.providerThreadId || "", sourceSeq: 0 };
    }
    if (next && currentTurn && currentTurn.runId === next.runId && currentTurn.progress
      && (!next.providerTurnId || next.providerTurnId === currentTurn.turnId)
      && (!progress || currentTurn.progress.sourceSeq > (progress.sourceSeq || 0))) next.turnProgress = currentTurn.progress;
    currentActivity = next;
    notify();
  }

  function reset() {
    generation += 1;
    if (currentActivity?.runId) {
      closedRuns.add(currentActivity.runId);
      if (closedRuns.size > 100) closedRuns.delete(closedRuns.values().next().value);
    }
    liveEvents = [];
    currentActivity = null;
    currentProgress = null;
    currentTurn = null;
    notify();
  }

  function noteProgressPlan(event = {}) {
    if (!isProgressPlanEvent(event)) return false;
    const sourceSeq = eventBoundary(event);
    if (event.runId && currentActivity?.runId && event.runId !== currentActivity.runId) return false;
    if (event.runId && currentProgress?.runId && event.runId !== currentProgress.runId) currentProgress = null;
    const currentSeq = Number.isInteger(currentProgress?.sourceSeq) ? currentProgress.sourceSeq : 0;
    if (sourceSeq > 0 && currentSeq > 0 && sourceSeq < currentSeq) return false;
    const nextProgress = buildProgressPresentation(event);
    currentProgress = nextProgress;
    notify();
    return true;
  }

  function recordLiveEvent(event) {
    const displayEvent = {};
    for (const key of ["type", "role", "runId", "requestId", "operationId", "toolCallId", "providerItemId", "providerToolUseId", "providerThreadId", "providerTurnId", "providerMessageId", "providerLifecycle", "state", "operationLifecycle", "toolName", "kind", "labelKind", "filePath", "detail", "command", "activityDescription", "activityDescriptionSource", "webAction", "operationProgress", "turnProgressText"]) {
      if (typeof event[key] === "string") displayEvent[key] = event[key].slice(0, 512);
    }
    for (const key of ["seq", "endSeq", "startSeq"]) if (Number.isInteger(event[key])) displayEvent[key] = event[key];
    if (event.presentation && typeof event.presentation === "object") {
      displayEvent.presentation = {};
      for (const key of ["labelKind", "activityDescription", "activityDescriptionSource", "webAction", "operationProgress"]) {
        if (typeof event.presentation[key] === "string") displayEvent.presentation[key] = event.presentation[key].slice(0, 512);
      }
    }
    liveEvents.push({ event: displayEvent, seq: eventBoundary(event), generation: ++liveGeneration });
    if (liveEvents.length > 200) liveEvents.shift();
  }

  function noteFormalOutput(event = {}, record = true) {
    if (event.type !== "message" || event.role !== "assistant" || event.providerLifecycle !== "completed"
      || typeof event.turnProgressText !== "string" || !event.turnProgressText.trim()
      || !event.runId || !event.providerThreadId || !event.providerTurnId || !event.providerMessageId
      || !eventBoundary(event) || closedRuns.has(event.runId)
      || (currentActivity?.runId && event.runId !== currentActivity.runId) || !currentTurn || currentTurn.runId !== event.runId
      || currentTurn.turnId !== event.providerTurnId || (currentTurn.threadId && currentTurn.threadId !== event.providerThreadId)
      || eventBoundary(event) < currentTurn.sourceSeq) return;
    if (record) recordLiveEvent(event);
    const progress = { text: event.turnProgressText, runId: event.runId,
      turnId: event.providerTurnId, messageId: event.providerMessageId, sourceSeq: eventBoundary(event) };
    currentTurn = { ...currentTurn, threadId: event.providerThreadId, sourceSeq: eventBoundary(event), progress };
    if (currentActivity?.runId === event.runId) currentActivity = { ...currentActivity, turnProgress: progress };
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
        labelKind: String(event.labelKind || event.presentation?.labelKind || "").trim(),
        detail: event.detail || event.command || "",
        operationId: event.operationId || "",
        operationState: event.state || "running",
        webAction: webActionForActivity(event),
        operationProgress: event.operationProgress || event.presentation?.operationProgress || "",
        ...descriptionFields(event),
      };
    }
    if (type === "file_change") return { kind: "file_edit", detail: event.filePath || "" };
    if (type === "tool_use") return { kind: inferToolKind(event), detail: event.filePath || "", webAction: webActionForActivity(event), operationProgress: event.operationProgress || "", ...descriptionFields(event) };
    if (type === "thinking_block" || type === "reasoning") return { kind: "thinking", detail: "" };
    if (type === "context_operation" || type === "context_barrier") return { kind: "working", detail: "" };
    if (type === "status") return { kind: "working", detail: "" };
    return null;
  }

  function beginSnapshot() {
    return { generation, request: ++snapshotRequest, liveGeneration };
  }

  function applySnapshot(activity, token, latestSeq = 0) {
    if (!token || token.generation !== generation || token.request !== snapshotRequest) return false;
    const pending = liveEvents.filter((entry) => entry.generation > token.liveGeneration
      && (!entry.seq || !latestSeq || entry.seq > latestSeq));
    if (!(pending.length && (!activity || activity.state === "idle") && currentActivity && currentActivity.state !== "idle")) {
      setActivity(activity);
    }
    for (const entry of pending) {
      if (entry.event.type === "message") noteFormalOutput(entry.event, false);
      else applyEvent(entry.event, false);
    }
    liveEvents = pending;
    return true;
  }

  function applyEvent(event = {}, record = true) {
    const eventType = String(event?.type || "");
    const operationEvent = ["tool_use", "tool_result", "operation", "file_change"].includes(eventType);
    if (eventType === "provider_turn_started") {
      const runId = String(event.runId || "").trim();
      const sourceSeq = eventBoundary(event);
      if (!runId || closedRuns.has(runId) || !event.providerThreadId || !event.providerTurnId || !sourceSeq
        || (currentActivity?.runId && currentActivity.runId !== runId)
        || (currentTurn && currentTurn.runId === runId && sourceSeq < currentTurn.sourceSeq)) return;
      if (record) recordLiveEvent(event);
      const sameTurn = currentTurn?.runId === runId && currentTurn.turnId === event.providerTurnId
        && (!currentTurn.threadId || currentTurn.threadId === event.providerThreadId);
      currentTurn = { runId, threadId: event.providerThreadId, turnId: event.providerTurnId,
        sourceSeq: Math.max(sourceSeq, sameTurn ? currentTurn.sourceSeq : 0), ...(sameTurn && currentTurn.progress ? { progress: currentTurn.progress } : {}) };
      if (currentActivity && !sameTurn) currentActivity = { ...currentActivity, turnProgress: null };
      notify();
      return;
    }
    if (!currentActivity || currentActivity.state === "idle") {
      if (event?.type !== "tool_use" || !event.runId || closedRuns.has(event.runId)) return;
      currentActivity = { state: "working", kind: "thinking", runId: event.runId, sourceSeq: 0,
        ...(currentTurn?.runId === event.runId && currentTurn.progress ? { turnProgress: currentTurn.progress } : {}) };
    }
    const runId = String(event.runId || "").trim();
    if (runId && currentActivity.runId && runId !== currentActivity.runId) return;
    if (record && operationEvent) recordLiveEvent(event);
    let next = optimisticActivityForEvent(event);
    const keys = ["operationId", "toolCallId", "providerItemId", "providerToolUseId"];
    const sameOperation = keys.some((key) => event[key] && currentActivity[key] && event[key] === currentActivity[key]);
    const identified = keys.some((key) => event[key]);
    const currentHasIdentity = keys.some((key) => currentActivity[key]);
    if (event.operationProgress && (!sameOperation || !event.providerThreadId || !event.providerTurnId || !event.providerItemId
      || event.providerThreadId !== currentActivity.providerThreadId || event.providerTurnId !== currentActivity.providerTurnId
      || event.providerItemId !== currentActivity.providerItemId)) return;
    if (!operationEvent && currentHasIdentity) return;
    const lifecycle = String(event.operationLifecycle || "").toLowerCase();
    if (event.type === "tool_result" && sameOperation && ["delta", "waiting_approval"].includes(lifecycle)) {
      next = { kind: currentActivity.kind, detail: currentActivity.detail,
        operationState: lifecycle === "waiting_approval" ? "waiting_approval" : currentActivity.operationState,
        ...descriptionFields(event) };
    }
    if (next && operationEvent && !identified) {
      next.activityDescription = "";
      next.activityDescriptionSource = "";
    }
    if (next && !["tool_input_description", "provider_title"].includes(next.activityDescriptionSource)) {
      next.activityDescription = "";
      next.activityDescriptionSource = "";
    }
    if (next && sameOperation && currentActivity.activityDescriptionSource === "tool_input_description"
      && next.activityDescriptionSource === "provider_title") {
      next.activityDescription = "";
      next.activityDescriptionSource = "";
    }
    if (operationEvent && !identified && currentHasIdentity) return;
    const terminal = (event.type === "tool_result" && !["delta", "waiting_approval"].includes(lifecycle))
      || ["completed", "complete", "failed", "error", "declined", "denied", "cancelled", "canceled", "interrupted"].includes(String(event.state || lifecycle || "").toLowerCase());
    if (currentActivity.state === "waiting_user" && !(terminal && sameOperation)
      && event.state !== "waiting_approval" && lifecycle !== "waiting_approval") return;
    if (terminal && sameOperation) {
      currentActivity = { state: "working", kind: "thinking", runId: currentActivity.runId, requestId: currentActivity.requestId, sourceSeq: eventBoundary(event), inlineEligible: true, turnProgress: currentActivity.turnProgress };
      notify();
      return;
    }
    if (terminal) return;
    if (!next) return;
    const sourceSeq = eventBoundary(event);
    const currentSourceSeq = Number.isInteger(currentActivity.sourceSeq) ? currentActivity.sourceSeq : 0;
    const isStart = event.type === "tool_use" && String(event.operationLifecycle || "started").toLowerCase() === "started";
    const startSeq = Number.isInteger(event.startSeq) ? event.startSeq : (isStart ? sourceSeq : 0);
    if (operationEvent && !sameOperation && currentHasIdentity
      && (!startSeq || startSeq <= (currentActivity.startSeq || 0))) return;
    if (sameOperation && sourceSeq > 0 && sourceSeq < currentSourceSeq) return;
    const opChanged = operationEvent && !sameOperation;
    currentActivity = {
      ...currentActivity,
      ...(opChanged ? { subject: "", labelKind: "", group: null, presentation: null, activityDescription: "", activityDescriptionSource: "", activityDescriptionSeq: 0, webAction: "", operationProgress: "", providerThreadId: "", providerTurnId: "", operationState: "running", operationId: "", toolCallId: "", providerItemId: "", providerToolUseId: "" } : {}),
      ...next,
      ...Object.fromEntries([...keys, "providerThreadId", "providerTurnId"].filter((key) => event[key]).map((key) => [key, event[key]])),
      ...(sameOperation && !next.webAction ? { webAction: currentActivity.webAction } : {}),
      ...(sameOperation && !next.operationProgress ? { operationProgress: currentActivity.operationProgress } : {}),
      ...(startSeq && opChanged ? { startSeq } : {}),
      ...(sameOperation && !next.activityDescription ? { activityDescription: currentActivity.activityDescription, activityDescriptionSource: currentActivity.activityDescriptionSource } : {}),
      state: event?.state === "waiting_approval" || lifecycle === "waiting_approval" ? "waiting_user" : "working",
      sourceSeq: Math.max(sourceSeq, currentSourceSeq),
      inlineEligible: true,
    };
    notify();
  }

  function subscribe(subscriber) {
    if (typeof subscriber !== "function") return () => {};
    subscribers.add(subscriber);
    subscriber(getPresentation());
    return () => subscribers.delete(subscriber);
  }

  root.RagentRunActivity = {
    applyEvent,
    beginSnapshot,
    applySnapshot,
    format: formatRunActivitySummary,
    formatOperationActivity,
    getActivity: () => currentActivity,
    getPresentation,
    getLivePresentation,
    noteProgressPlan,
    noteFormalOutput,
    reset,
    setActivity,
    subscribe,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
