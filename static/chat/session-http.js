function restoreOwnerSessionSelection() {
  if (visitorMode) return;

  const currentTab = typeof getActiveSidebarTabValue === "function"
    ? getActiveSidebarTabValue()
    : activeTab;
  const requestedTab = pendingNavigationState?.tab || currentTab;
  if (requestedTab !== currentTab) {
    switchTab(requestedTab, { syncState: false });
  }

  const targetSession = resolveRestoreTargetSession();
  if (!targetSession) {
    if (currentSessionId) {
      if (typeof abortSessionRefreshRequests === "function") {
        abortSessionRefreshRequests(currentSessionId);
      }
      if (typeof settleAttachedSessionSidebarState === "function") {
        Promise.resolve(settleAttachedSessionSidebarState({
          sessionId: currentSessionId,
          sync: true,
          render: false,
        })).catch(() => {});
      }
    }
    if (typeof setChatCurrentSession === "function") {
      setChatCurrentSession(null, { hasAttachedSession: false });
    } else {
      currentSessionId = null;
      hasAttachedSession = false;
    }
    resetAttachedSessionRenderState();
    persistActiveSessionId(null);
    syncBrowserState({ sessionId: null, tab: getActiveSidebarTabValue() });
    showEmpty();
    restoreDraft();
    updateStatus("connected");
    pendingNavigationState = null;
    return;
  }

  if (!hasAttachedSession || currentSessionId !== targetSession.id) {
    if (typeof navigateToSession === "function") {
      void navigateToSession(targetSession.id, {
        session: targetSession,
        tab: requestedTab,
        historyMode: "replace",
      }).catch((error) => {
        console.warn("[sessions] Failed to restore session selection:", error?.message || error);
      });
      return;
    } else {
      attachSession(targetSession.id, targetSession);
    }
  } else {
    syncBrowserState();
  }
  pendingNavigationState = null;
}

function canOrganizeSessionListFromUi() {
  return typeof canOrganizeSessionList === "function"
    ? canOrganizeSessionList()
    : !visitorMode;
}

function isOwnerPushFeatureEnabled() {
  return typeof shouldEnableOwnerPushFeatures === "function"
    ? shouldEnableOwnerPushFeatures()
    : !visitorMode;
}

if (
  "serviceWorker" in navigator
  && typeof navigator.serviceWorker?.addEventListener === "function"
) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "ragent:open-session") return;
    applyNavigationState(event.data);
    window.focus();
    return queueForegroundRefresh({
      forceFresh: true,
      viewportIntent: "session_entry_bottom",
    }).then(() => {
      if (event.data?.responsibilityId) return window.RagentOrganizationView?.openResponsibilityLink?.(event.data.sessionId, event.data.responsibilityId);
    }).catch(() => {});
  });
}

function notifyCompletion(session) {
  if (!("Notification" in window) || Notification.permission !== "granted")
    return;
  if (document.visibilityState === "visible") return;
  const folder = (session?.folder || "").split("/").pop() || "Session";
  const name = session?.name || folder;
  const n = new Notification("Ragent", {
    body: `${name} — task completed`,
    tag: "ragent-done",
  });
  n.onclick = () => {
    window.focus();
    applyNavigationState({ sessionId: session?.id, tab: "sessions" });
    queueForegroundRefresh({
      forceFresh: true,
      viewportIntent: "session_entry_bottom",
    }).catch(() => {});
    n.close();
  };
}

const FOREGROUND_REFRESH_THROTTLE_MS = 1500;
const FOREGROUND_SESSION_LIST_STALE_MS = 15000;
const FOREGROUND_IDLE_SESSION_STALE_MS = 15000;
const EVENT_DELTA_REFRESH_ENABLED = true;
const SESSION_EVENT_PAGE_SIZE = 50;
const SESSION_EVENT_OLDER_SCROLL_THRESHOLD_PX = 160;
const SESSION_EVENT_AUTOFILL_MAX_PAGES = 4;
const EVENT_REFRESH_STICKY_BOTTOM_THRESHOLD_PX = 120;
const EVENT_REFRESH_METRICS_SAMPLE_LIMIT = 80;
const SESSION_EVENT_HISTORY_LOADING_MIN_VISIBLE_MS = 260;
const SESSION_LOADING_SKELETON_DELAY_MS = 150;
// Foreground recovery used to be one global single-flight.  A focus event for
// session A could therefore make a later session B selection coalesce onto A's
// stale request; B then had no request of its own until the user reloaded.
// Keep coalescing, but scope it to the session captured when the work starts.
const foregroundRefreshPromises = new Map();
let foregroundRefreshHandlersReady = false;
const lastForegroundRefreshAt = new Map();
let lastSessionsListRefreshAt = 0;
let lastArchivedSessionsRefreshAt = 0;
let lastCurrentSessionRefreshAt = 0;
let lastCurrentSessionRefreshSessionId = null;
let historyLoadingIndicatorEl = null;
let historyLoadingIndicatorToken = 0;
let historyLoadingIndicatorHideTimer = null;
let historyLoadingIndicatorStartedAt = 0;
let sessionHistoryAutofillFrame = 0;

function getTimelineRuntimeSnapshot(sessionId) {
  if (typeof window === "undefined" || !sessionId) return null;
  const snapshot = window.RagentTimelineRuntime?.getSnapshot?.();
  return snapshot?.sessionId === sessionId ? snapshot : null;
}

function nowPerfMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function getMessagesBottomDistance() {
  if (!messagesEl) return Number.POSITIVE_INFINITY;
  const scrollHeight = Number(messagesEl.scrollHeight) || 0;
  const scrollTop = Number(messagesEl.scrollTop) || 0;
  const clientHeight = Number(messagesEl.clientHeight) || 0;
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

function shouldStickToBottomForEventRefresh() {
  const hasRenderedMessages =
    messagesInner.children.length > 0 && emptyState.parentNode !== messagesInner;
  if (!hasRenderedMessages) return true;
  return getMessagesBottomDistance() < EVENT_REFRESH_STICKY_BOTTOM_THRESHOLD_PX;
}

function estimatePayloadBytes(payload) {
  try {
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== "string") return 0;
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(serialized).length;
    }
    return serialized.length;
  } catch {
    return 0;
  }
}

function ensureEventRefreshMetricsStore() {
  const root = typeof window !== "undefined" ? window : globalThis;
  if (!root.__ragentEventRefreshMetrics || typeof root.__ragentEventRefreshMetrics !== "object") {
    root.__ragentEventRefreshMetrics = {
      startedAt: new Date().toISOString(),
      totals: {
        fullFetches: 0,
        deltaFetches: 0,
        deltaApplied: 0,
        deltaFallbacks: 0,
        renderedResets: 0,
        renderedAppends: 0,
        renderedNoops: 0,
        // Streaming per-frame markdown render timing (kind: "streaming-render").
        streamingRenderFrames: 0,
        streamingRenderTotalMs: 0,
        streamingRenderMaxMs: 0,
        streamingRenderBlockCount: 0,
        streamingRenderFullCount: 0,
      },
      last: null,
      samples: [],
    };
  }
  if (typeof root.ragentGetEventRefreshMetrics !== "function") {
    root.ragentGetEventRefreshMetrics = () => {
      const snapshot = root.__ragentEventRefreshMetrics || {};
      return JSON.parse(JSON.stringify(snapshot));
    };
  }
  return root.__ragentEventRefreshMetrics;
}

function recordEventRefreshMetric(sample = {}) {
  const store = ensureEventRefreshMetricsStore();
  const mode = sample.mode === "delta" ? "delta" : "full";
  const outcome = typeof sample.outcome === "string" ? sample.outcome : "unknown";
  const renderMode = typeof sample.renderMode === "string" ? sample.renderMode : "";
  const normalized = {
    ...sample,
    mode,
    outcome,
    renderMode,
    at: new Date().toISOString(),
  };
  if (mode === "delta") {
    store.totals.deltaFetches += 1;
    if (outcome === "applied") {
      store.totals.deltaApplied += 1;
    }
    if (outcome.startsWith("fallback")) {
      store.totals.deltaFallbacks += 1;
    }
  } else {
    store.totals.fullFetches += 1;
  }
  if (renderMode === "reset") store.totals.renderedResets += 1;
  if (renderMode === "append") store.totals.renderedAppends += 1;
  if (renderMode === "noop") store.totals.renderedNoops += 1;
  store.last = normalized;
  store.samples.push(normalized);
  if (store.samples.length > EVENT_REFRESH_METRICS_SAMPLE_LIMIT) {
    store.samples.splice(0, store.samples.length - EVENT_REFRESH_METRICS_SAMPLE_LIMIT);
  }
}

// Streaming render timing: called from realtime-render.js's
// pumpStreamingAnimation once per frame that actually re-renders markdown.
// Shares the __ragentEventRefreshMetrics store and sample cap with the event
// refresh metrics; samples carry kind "streaming-render" so both families
// coexist in one array. Progressive enhancement: callers guard with
// typeof recordStreamingRenderMetric === "function".
function recordStreamingRenderMetric(sample = {}) {
  const store = ensureEventRefreshMetricsStore();
  const renderMs = Number.isFinite(sample.renderMs) && sample.renderMs >= 0
    ? sample.renderMs
    : 0;
  const mode = sample.mode === "block" ? "block" : "full";
  const textLen = Number.isInteger(sample.textLen) && sample.textLen >= 0
    ? sample.textLen
    : 0;
  const normalized = {
    kind: "streaming-render",
    renderMs,
    mode,
    textLen,
    at: new Date().toISOString(),
  };
  store.totals.streamingRenderFrames = (store.totals.streamingRenderFrames || 0) + 1;
  store.totals.streamingRenderTotalMs = (store.totals.streamingRenderTotalMs || 0) + renderMs;
  store.totals.streamingRenderMaxMs = Math.max(
    Number(store.totals.streamingRenderMaxMs) || 0,
    renderMs,
  );
  if (mode === "block") {
    store.totals.streamingRenderBlockCount = (store.totals.streamingRenderBlockCount || 0) + 1;
  } else {
    store.totals.streamingRenderFullCount = (store.totals.streamingRenderFullCount || 0) + 1;
  }
  store.last = normalized;
  store.samples.push(normalized);
  if (store.samples.length > EVENT_REFRESH_METRICS_SAMPLE_LIMIT) {
    store.samples.splice(0, store.samples.length - EVENT_REFRESH_METRICS_SAMPLE_LIMIT);
  }
}

function buildSessionRefreshRequestOptions(forceFresh = false, signal = null) {
  return {
    ...(forceFresh ? { revalidate: false, cache: "no-store" } : {}),
    ...(signal ? { signal } : {}),
  };
}

// Registry adapter: session-http-scheduler.js (loaded first) owns the
// per-resource-key single-flight/abort/supersede logic. When it is absent
// (standalone unit-test harnesses that load session-http.js by itself), run
// the request directly with no cancellation so behavior matches the previous
// code path exactly.
function scheduleSessionRefresh(key, { intent = {}, essential = false, run } = {}) {
  if (typeof scheduleRefreshRequest === "function") {
    return scheduleRefreshRequest(key, { intent, essential, run });
  }
  const result = run({ signal: null, intent });
  return Promise.resolve(result === undefined ? null : result);
}

function mergeSessionRefreshOptions(current = {}, next = {}) {
  const currentViewportIntent = normalizeSessionViewportIntent(current.viewportIntent);
  const nextViewportIntent = normalizeSessionViewportIntent(next.viewportIntent);
  const hasBottomEntryIntent =
    currentViewportIntent === "session_entry_bottom"
    || nextViewportIntent === "session_entry_bottom";
  const hasSessionEntryIntent =
    currentViewportIntent === "session_entry"
    || nextViewportIntent === "session_entry";
  return {
    forceFresh: current.forceFresh === true || next.forceFresh === true,
    viewportIntent: hasBottomEntryIntent
      ? "session_entry_bottom"
      : (hasSessionEntryIntent ? "session_entry" : "preserve"),
    wsPushCaughtUp: current.wsPushCaughtUp === true || next.wsPushCaughtUp === true,
  };
}

function canQueueForegroundRefresh() {
  if (
    (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode)
    || typeof document === "undefined"
  ) {
    return false;
  }
  if (document.visibilityState === "hidden") {
    return false;
  }
  if (visitorMode) {
    return Boolean(
      currentSessionId
      || (typeof visitorSessionId !== "undefined" && visitorSessionId),
    );
  }
  return true;
}

function isRefreshStale(lastRefreshAt, staleMs) {
  return !Number.isFinite(lastRefreshAt)
    || lastRefreshAt <= 0
    || Date.now() - lastRefreshAt >= staleMs;
}

function isArchiveSectionExpanded() {
  return typeof localStorage !== "undefined"
    && typeof localStorage.getItem === "function"
    && localStorage.getItem("archivedCollapsed") === "false";
}

function shouldRefreshForegroundSessionList({ forceFresh = false } = {}) {
  if (forceFresh) return true;
  if (!hasLoadedSessions) return true;
  if (pendingNavigationState) return true;
  if (currentSessionId && typeof findClientSessionRecord === "function" && !findClientSessionRecord(currentSessionId)) {
    return true;
  }
  return isRefreshStale(lastSessionsListRefreshAt, FOREGROUND_SESSION_LIST_STALE_MS);
}

function shouldRefreshForegroundArchivedSessions({
  forceFresh = false,
  refreshedSessionsList = false,
} = {}) {
  if (!archivedSessionsLoaded || !isArchiveSectionExpanded()) return false;
  if (forceFresh) return true;
  if (refreshedSessionsList) return true;
  return isRefreshStale(lastArchivedSessionsRefreshAt, FOREGROUND_SESSION_LIST_STALE_MS);
}

function shouldRefreshForegroundCurrentSession({ forceFresh = false } = {}) {
  if (!currentSessionId) return false;
  if (forceFresh) return true;
  if (!hasAttachedSession) return true;
  if (pendingNavigationState) return true;
  const session = typeof findClientSessionRecord === "function"
    ? findClientSessionRecord(currentSessionId)
    : null;
  if (!session) return true;
  if (getSessionRunState(session) === "running") return true;
  if (!hasRenderedEventSnapshot(currentSessionId)) return true;
  if (lastCurrentSessionRefreshSessionId !== currentSessionId) return true;
  return isRefreshStale(lastCurrentSessionRefreshAt, FOREGROUND_IDLE_SESSION_STALE_MS);
}

async function runForegroundRefresh({ forceFresh = false, viewportIntent = "preserve" } = {}) {
  if (!canQueueForegroundRefresh()) return null;
  // Foreground recovery only runs while the tab is visible
  // (canQueueForegroundRefresh gates it), so it is an essential refresh that
  // may start even if the scheduler otherwise drops non-essential work.
  await refreshRealtimeViews({ forceFresh, viewportIntent, refreshMode: "foreground", essential: true });
  return currentSessionId || null;
}

function queueForegroundRefresh(options = {}) {
  const requestOptions = mergeSessionRefreshOptions(
    { forceFresh: false, viewportIntent: "preserve" },
    options,
  );
  if (!canQueueForegroundRefresh()) {
    return Promise.resolve(null);
  }
  const targetSessionId = typeof currentSessionId === "string" ? currentSessionId : "";
  const key = targetSessionId || "__session-catalog__";
  const pending = foregroundRefreshPromises.get(key);
  if (pending) {
    return pending;
  }
  const now = Date.now();
  if (now - (lastForegroundRefreshAt.get(key) || 0) < FOREGROUND_REFRESH_THROTTLE_MS) {
    return Promise.resolve(null);
  }
  lastForegroundRefreshAt.set(key, now);
  let request;
  request = Promise.resolve().then(async () => {
    try {
      // The current session is a navigation generation boundary.  Do not
      // spend a foreground refresh on a session that was left before this
      // queued microtask obtained the scheduler slot.
      if (targetSessionId && currentSessionId !== targetSessionId) return null;
      return await runForegroundRefresh(requestOptions);
    } finally {
      if (foregroundRefreshPromises.get(key) === request) {
        foregroundRefreshPromises.delete(key);
      }
    }
  });
  foregroundRefreshPromises.set(key, request);
  return request;
}

function setupForegroundRefreshHandlers() {
  if (foregroundRefreshHandlersReady) return;
  foregroundRefreshHandlersReady = true;
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return null;
      return queueForegroundRefresh().catch(() => {});
    });
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", () => queueForegroundRefresh().catch(() => {}));
    window.addEventListener("pageshow", () => queueForegroundRefresh().catch(() => {}));
  }
}

const SESSION_LIST_ORGANIZER_POLL_INTERVAL_MS = 1200;
const SESSION_LIST_ORGANIZER_POLL_TIMEOUT_MS = 90 * 1000;
const SESSION_LIST_ORGANIZER_INTERNAL_ROLE = "session_list_organizer";
const DEFAULT_SORT_SESSION_LIST_BUTTON_LABEL = "Sort List";
let sessionListOrganizerInFlight = null;
let sessionListOrganizerLabelResetTimer = null;

const SESSION_LIST_ORGANIZER_SYSTEM_PROMPT = [
  "You are Ragent's hidden session-list organizer.",
  "Your job is to improve the owner's non-archived session sidebar structure using the provided metadata snapshot.",
  "Do not rename sessions, archive or unarchive them, change pin state, edit prompts, or ask the user follow-up questions.",
  "Only update existing sessions by calling the owner-authenticated Ragent API from this machine.",
  "Use `ragent api GET /api/sessions` if you need to double-check current state.",
  "Use `ragent api PATCH /api/sessions/<sessionId> --body ...` to update `group` and `sidebarOrder`.",
  "Only writable API fields for this task are `group` and `sidebarOrder`.",
  "Never send read-only snapshot keys such as `title`, `brief`, `existingGroup`, `existingSidebarOrder`, `currentGroup`, or `currentSidebarOrder` in PATCH bodies.",
  "Example PATCH body: {\"group\":\"Ragent\",\"sidebarOrder\":3}",
  "If `ragent` is unavailable in PATH, use `node \"$RAGENT_PROJECT_ROOT/cli.js\" api ...` instead.",
  "`sidebarOrder` must be a positive integer; smaller numbers sort first.",
  "Assign unique contiguous `sidebarOrder` values across the current non-archived sessions you organize.",
  "Prefer a small number of clear, stable groups; avoid one giant catch-all group when the list is dense.",
  "Return only a brief plain-text summary of the grouping strategy you applied.",
].join("\n");

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setSortSessionListButtonState(label = DEFAULT_SORT_SESSION_LIST_BUTTON_LABEL, { busy = false } = {}) {
  if (!sortSessionListBtn) return;
  sortSessionListBtn.textContent = label || DEFAULT_SORT_SESSION_LIST_BUTTON_LABEL;
  sortSessionListBtn.disabled = busy;
}

function clipSessionListOrganizerText(value, maxChars = 240) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
    : normalized;
}

function scheduleSortSessionListButtonReset(delayMs = 1600) {
  if (sessionListOrganizerLabelResetTimer) {
    window.clearTimeout(sessionListOrganizerLabelResetTimer);
  }
  sessionListOrganizerLabelResetTimer = window.setTimeout(() => {
    sessionListOrganizerLabelResetTimer = null;
    setSortSessionListButtonState(DEFAULT_SORT_SESSION_LIST_BUTTON_LABEL, { busy: false });
  }, delayMs);
}

function buildSessionListOrganizerSessionMetadata(session) {
  const brief = typeof session?.description === "string"
    ? session.description.trim()
    : "";
  return {
    id: session?.id || "",
    title: clipSessionListOrganizerText(getSessionDisplayName(session), 160),
    brief: clipSessionListOrganizerText(brief, 280),
    existingGroup: typeof session?.group === "string" && session.group.trim()
      ? clipSessionListOrganizerText(session.group, 80)
      : null,
    existingSidebarOrder: Number.isInteger(session?.sidebarOrder) && session.sidebarOrder > 0
      ? session.sidebarOrder
      : null,
    pinned: session?.pinned === true,
    tool: clipSessionListOrganizerText(session?.tool || "", 40),
    sourceName: clipSessionListOrganizerText(session?.sourceName || "", 80),
    folder: clipSessionListOrganizerText(session?.folder || "", 180),
    workflowState: clipSessionListOrganizerText(session?.workflowState || "", 40),
    workflowPriority: clipSessionListOrganizerText(session?.workflowPriority || "", 40),
    messageCount: Number.isInteger(session?.messageCount) ? session.messageCount : 0,
    created: clipSessionListOrganizerText(session?.created || "", 40),
    updatedAt: clipSessionListOrganizerText(session?.updatedAt || "", 40),
    lastEventAt: clipSessionListOrganizerText(session?.lastEventAt || "", 40),
  };
}

function buildSessionListOrganizerPayload() {
  const activeSessions = getActiveSessions();
  return {
    tool: selectedTool || preferredTool || "claude",
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(selectedEffort ? { effort: selectedEffort } : {}),
    ...(selectedPermissionMode ? { permissionMode: selectedPermissionMode } : {}),
    thinking: thinkingEnabled === true,
    sessions: activeSessions.map(buildSessionListOrganizerSessionMetadata).filter((session) => session.id),
  };
}

function buildSessionListOrganizerTask(sessions) {
  const payload = {
    generatedAt: new Date().toISOString(),
    totalSessions: Array.isArray(sessions) ? sessions.length : 0,
    sessions: Array.isArray(sessions) ? sessions : [],
  };
  return [
    "Organize the current non-archived Ragent session list using the provided metadata snapshot.",
    "Choose clearer groups and a better sidebar ordering based on the current session density.",
    "Apply changes by calling the Ragent API from this machine; do not merely suggest them.",
    "Snapshot fields like `title`, `brief`, `existingGroup`, and `existingSidebarOrder` are read-only context.",
    "When patching a session, send only `group` and `sidebarOrder` in the API body.",
    "",
    "<session_list_organizer_input>",
    JSON.stringify(payload, null, 2),
    "</session_list_organizer_input>",
  ].join("\n");
}

async function createSessionListOrganizerRun(payload) {
  const sessionResponse = await fetchJsonOrRedirect("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      folder: typeof window.ragentGetSelectedSessionFolder === "function"
        ? window.ragentGetSelectedSessionFolder()
        : (typeof window.ragentGetDefaultSessionFolder === "function"
          ? window.ragentGetDefaultSessionFolder()
          : "~"),
      tool: payload?.tool || "claude",
      name: "sort session list",
      systemPrompt: SESSION_LIST_ORGANIZER_SYSTEM_PROMPT,
      internalRole: SESSION_LIST_ORGANIZER_INTERNAL_ROLE,
    }),
  });
  const organizerSessionId = typeof sessionResponse?.session?.id === "string"
    ? sessionResponse.session.id.trim()
    : "";
  if (!organizerSessionId) {
    throw new Error("Failed to create the hidden session organizer");
  }

  const messageResponse = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(organizerSessionId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: buildSessionListOrganizerTask(payload?.sessions || []),
      ...(payload?.model ? { model: payload.model } : {}),
      ...(payload?.effort ? { effort: payload.effort } : {}),
      ...(payload?.permissionMode ? { permissionMode: payload.permissionMode } : {}),
      ...(payload?.thinking ? { thinking: true } : {}),
    }),
  });

  return {
    session: sessionResponse?.session || null,
    run: messageResponse?.run || null,
  };
}

async function waitForSessionListOrganizerRun(runId) {
  const deadline = Date.now() + SESSION_LIST_ORGANIZER_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const data = await fetchJsonOrRedirect(`/api/runs/${encodeURIComponent(runId)}`, {
      revalidate: false,
    });
    const state = typeof data?.run?.state === "string" ? data.run.state : "";
    if (["completed", "failed", "cancelled"].includes(state)) {
      return data.run || null;
    }
    await sleep(SESSION_LIST_ORGANIZER_POLL_INTERVAL_MS);
  }
  throw new Error("Timed out while sorting the session list");
}


function getSessionRunState(session) {
  const state = String(session?.activity?.run?.state || "").trim().toLowerCase();
  return isApprovalLiveRunState(state) ? state : "idle";
}

function hasRenderedEventSnapshot(sessionId) {
  const snapshot = getTimelineRuntimeSnapshot(sessionId);
  if (!snapshot) return false;
  // Empty is a valid, successfully rendered session state. Newer runtime
  // snapshots expose `initialized`; retain the item-count fallback for test
  // doubles and older embedded clients that do not expose it yet.
  return snapshot.initialized === true
    || (typeof snapshot.initialized !== "boolean" && snapshot.items.length > 0);
}

function shouldFetchSessionEventsForRefresh(sessionId, session) {
  const snapshot = getTimelineRuntimeSnapshot(sessionId);
  if (!snapshot || snapshot.items.length === 0) {
    return true;
  }
  const runState = getSessionRunState(session);
  if (runState !== "running") return true;
  if (!hasRenderedEventSnapshot(sessionId)) return true;
  if (renderedEventState.runState !== "running") return true;
  if (renderedEventState.runningBlockExpanded === true) return true;
  const latestSeq = Number.isInteger(session?.latestSeq) ? session.latestSeq : 0;
  return latestSeq > snapshot.latestSeq || snapshot.gapExpectedSeq != null;
}

function shouldAttemptEventDeltaFetch(
  sessionId,
  { runState = "idle" } = {},
) {
  if (!EVENT_DELTA_REFRESH_ENABLED) return false;
  if (isShareSnapshotReadOnlyMode()) return false;
  if (currentSessionId !== sessionId) return false;
  if (!hasRenderedEventSnapshot(sessionId)) return false;
  const snapshot = getTimelineRuntimeSnapshot(sessionId);
  return Number.isInteger(snapshot?.latestSeq) && snapshot.latestSeq >= 0;
}

function assertSessionEventsPayload(data, source = "page") {
  if (!data || typeof data !== "object" || !Array.isArray(data.events)) {
    const error = new Error(`Invalid session events ${source} response`);
    error.code = "EVENTS_RESPONSE_INVALID";
    error.eventRefreshReason = "response_invalid";
    throw error;
  }
  if (data.consistency && data.consistency.stable !== true) {
    const error = new Error(`Unstable session events ${source} response`);
    error.code = "SESSION_RESPONSE_UNSTABLE";
    error.eventRefreshReason = "response_unstable";
    error.retryable = true;
    throw error;
  }
  return data;
}

async function fetchSessionEventDelta(sessionId, afterSeq, { forceFresh = false, signal = null } = {}) {
  const query = new URLSearchParams();
  query.set("filter", "visible");
  query.set("afterSeq", String(Math.max(0, Number.isInteger(afterSeq) ? afterSeq : 0)));
  const data = assertSessionEventsPayload(await fetchJsonOrRedirect(
    `/api/sessions/${encodeURIComponent(sessionId)}/events/delta?${query.toString()}`,
    buildSessionRefreshRequestOptions(forceFresh, signal),
  ), "delta");
  return {
    events: Array.isArray(data?.events) ? data.events : [],
    operationUpdates: Array.isArray(data?.operationUpdates) ? data.operationUpdates : [],
    runActivity: data?.runActivity && typeof data.runActivity === "object" ? data.runActivity : null,
    latestSeq: Number.isInteger(data?.latestSeq) ? data.latestSeq : null,
    consistency: data?.consistency && typeof data.consistency === "object"
      ? data.consistency
      : null,
    resetRequired: data?.resetRequired === true,
    reason: typeof data?.reason === "string" ? data.reason : "",
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

async function fetchSessionVisibleEventsPage(sessionId, {
  direction = "latest",
  beforeSeq = null,
  afterSeq = null,
  limit = SESSION_EVENT_PAGE_SIZE,
  forceFresh = false,
  signal = null,
} = {}) {
  return assertSessionEventsPayload(await fetchJsonOrRedirect(
    buildSessionVisibleEventsPageUrl(sessionId, { direction, beforeSeq, afterSeq, limit }),
    buildSessionRefreshRequestOptions(forceFresh, signal),
  ), direction === "before" ? "older-page" : "latest-page");
}

async function fetchSessionSnapshot(sessionId, {
  afterSeq = 0,
  limit = SESSION_EVENT_PAGE_SIZE,
  forceFresh = false,
  signal = null,
} = {}) {
  const query = new URLSearchParams();
  const normalizedAfterSeq = Number.isInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0;
  if (normalizedAfterSeq > 0) query.set("afterSeq", String(normalizedAfterSeq));
  if (Number.isInteger(limit) && limit > 0) query.set("limit", String(limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const data = await fetchJsonOrRedirect(
    `/api/sessions/${encodeURIComponent(sessionId)}/snapshot${suffix}`,
    buildSessionRefreshRequestOptions(forceFresh, signal),
  );
  if (!data || typeof data !== "object" || !data.session || !Array.isArray(data.events)) {
    const error = new Error("Invalid session snapshot response");
    error.code = "SESSION_SNAPSHOT_INVALID";
    error.eventRefreshReason = "response_invalid";
    throw error;
  }
  if (data.consistency && data.consistency.stable !== true) {
    const error = new Error("Unstable session snapshot response");
    error.code = "SESSION_RESPONSE_UNSTABLE";
    error.eventRefreshReason = "response_unstable";
    error.retryable = true;
    throw error;
  }
  return data;
}

function syncFetchedRunActivity(runActivity) {
  renderedEventState.runActivity = runActivity && typeof runActivity === "object"
    ? runActivity
    : null;
  window.RagentRunActivity?.setActivity?.(renderedEventState.runActivity);
}

function reconcilePendingMessageState(event) {
  if (typeof reconcileComposerPendingSendWithEvent === "function") {
    reconcileComposerPendingSendWithEvent(event);
  }
}

const pendingSessionReviewSyncs = new Map();
let heldSidebarSessionState = null;

function cloneSessionForSidebarHold(session) {
  if (!session || typeof session !== "object") return null;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(session);
    } catch {}
  }
  try {
    return JSON.parse(JSON.stringify(session));
  } catch {
    return { ...session };
  }
}

function getHeldSidebarSessionState(sessionId = currentSessionId) {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) return null;
  if (!heldSidebarSessionState || heldSidebarSessionState.sessionId !== normalizedSessionId) {
    return null;
  }
  return heldSidebarSessionState;
}

function getSessionSidebarListSnapshot(session) {
  if (!session?.id || session.id !== currentSessionId) return session;
  const heldState = getHeldSidebarSessionState(session.id);
  return heldState?.snapshot || session;
}

function holdAttachedSessionSidebarState(session) {
  if (!session?.id) return null;
  const existing = getHeldSidebarSessionState(session.id);
  heldSidebarSessionState = {
    sessionId: session.id,
    snapshot: cloneSessionForSidebarHold(session) || { ...session },
    pendingReviewAt: existing?.pendingReviewAt || "",
  };
  return heldSidebarSessionState;
}

function clearHeldSidebarSessionState(sessionId = currentSessionId) {
  const heldState = getHeldSidebarSessionState(sessionId);
  if (!heldState) return null;
  heldSidebarSessionState = null;
  return heldState;
}

function normalizeSessionReviewStamp(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : "";
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? new Date(numeric).toISOString() : "";
  }
  const time = new Date(trimmed).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function getSessionReviewStampTime(value) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function getSessionReviewStamp(session) {
  const hasActivityStamp = Object.prototype.hasOwnProperty.call(session || {}, "lastActivityAt");
  const primaryStamp = hasActivityStamp ? session?.lastActivityAt : session?.lastEventAt;
  return normalizeSessionReviewStamp(primaryStamp)
    || normalizeSessionReviewStamp(session?.updatedAt)
    || normalizeSessionReviewStamp(session?.created)
    || "";
}

function getEffectiveSessionReviewedAt(session) {
  const candidates = [
    normalizeSessionReviewStamp(session?.lastReviewedAt),
    normalizeSessionReviewStamp(session?.localReviewedAt),
    normalizeSessionReviewStamp(session?.reviewBaselineAt),
  ].filter(Boolean);
  let best = "";
  let bestTime = 0;
  for (const candidate of candidates) {
    const time = getSessionReviewStampTime(candidate);
    if (time > bestTime) {
      best = candidate;
      bestTime = time;
    }
  }
  return best;
}

function applySessionReviewedStampLocally(session, stamp, { render = false } = {}) {
  if (!session?.id) return "";
  const normalizedStamp = normalizeSessionReviewStamp(stamp);
  if (!normalizedStamp) return "";
  if (getSessionReviewStampTime(normalizedStamp) <= getSessionReviewStampTime(getEffectiveSessionReviewedAt(session))) {
    return getEffectiveSessionReviewedAt(session);
  }
  const stored = typeof setLocalSessionReviewedAt === "function"
    ? setLocalSessionReviewedAt(session.id, normalizedStamp)
    : normalizedStamp;
  session.localReviewedAt = stored || normalizedStamp;
  if (render) {
    renderSessionList();
  }
  return session.localReviewedAt;
}

function rememberSessionReviewedLocally(session, { render = false } = {}) {
  if (!session?.id) return "";
  const stamp = getSessionReviewStamp(session);
  return applySessionReviewedStampLocally(session, stamp, { render });
}

function stageSessionReviewedForAttachedSession(session) {
  if (!session?.id) return "";
  const stamp = getSessionReviewStamp(session);
  if (!stamp) return "";
  const hadHeldState = Boolean(getHeldSidebarSessionState(session.id));
  const heldState = holdAttachedSessionSidebarState(session);
  if (!heldState) return "";
  if (getSessionReviewStampTime(stamp) > getSessionReviewStampTime(heldState.pendingReviewAt)) {
    heldState.pendingReviewAt = stamp;
  }
  // Opening a session is the user's review action. Keep the sidebar hold for
  // other live-session protections, but apply the review marker to its held
  // snapshot immediately so unread / waiting dots disappear on open rather
  // than only after the user switches away.
  const beforeReviewTime = getSessionReviewStampTime(getEffectiveSessionReviewedAt(heldState.snapshot));
  const appliedReviewStamp = applySessionReviewedStampLocally(
    heldState.snapshot,
    heldState.pendingReviewAt,
    { render: false },
  );
  const liveSession = typeof getChatStoreSession === "function"
    ? getChatStoreSession(session.id)
    : sessions.find((entry) => entry?.id === session.id) || null;
  if (appliedReviewStamp) {
    const reviewTargets = [session, liveSession].filter((entry, index, entries) => (
      entry && entries.indexOf(entry) === index && entry !== heldState.snapshot
    ));
    for (const reviewTarget of reviewTargets) {
      const currentReviewTime = getSessionReviewStampTime(getEffectiveSessionReviewedAt(reviewTarget));
      if (getSessionReviewStampTime(appliedReviewStamp) > currentReviewTime) {
        reviewTarget.localReviewedAt = appliedReviewStamp;
      }
    }
  }
  if (hadHeldState && getSessionReviewStampTime(appliedReviewStamp) > beforeReviewTime) {
    renderSessionList();
  }
  return heldState.pendingReviewAt;
}

async function syncSessionReviewedToServer(session, stampOverride = "") {
  if (!session?.id || visitorMode) return session;
  const stamp = normalizeSessionReviewStamp(stampOverride) || getSessionReviewStamp(session);
  if (!stamp) return session;
  if (getSessionReviewStampTime(stamp) <= getSessionReviewStampTime(normalizeSessionReviewStamp(session?.lastReviewedAt))) {
    return session;
  }
  const currentPending = pendingSessionReviewSyncs.get(session.id);
  if (getSessionReviewStampTime(currentPending) >= getSessionReviewStampTime(stamp)) {
    return session;
  }
  pendingSessionReviewSyncs.set(session.id, stamp);
  try {
    const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastReviewedAt: stamp }),
    });
    return upsertSession(data.session) || data.session || session;
  } finally {
    if (pendingSessionReviewSyncs.get(session.id) === stamp) {
      pendingSessionReviewSyncs.delete(session.id);
    }
  }
}

function settleAttachedSessionSidebarState({
  sessionId = currentSessionId,
  sync = true,
  render = true,
} = {}) {
  const heldState = clearHeldSidebarSessionState(sessionId);
  const liveSession = heldState?.sessionId
    ? (typeof getChatStoreSession === "function"
      ? getChatStoreSession(heldState.sessionId)
      : (sessions.find((session) => session.id === heldState.sessionId) || null))
    : null;
  const session = liveSession || heldState?.snapshot || null;
  if (!heldState) {
    if (render) renderSessionList();
    return Promise.resolve(session);
  }

  const stamp = normalizeSessionReviewStamp(heldState.pendingReviewAt) || getSessionReviewStamp(session);
  if (stamp) {
    applySessionReviewedStampLocally(session, stamp, { render });
  } else if (render) {
    renderSessionList();
  }
  if (!stamp || !sync) {
    return Promise.resolve(session);
  }
  return syncSessionReviewedToServer(session, stamp);
}

function markSessionReviewed(session, { sync = false, render = true } = {}) {
  const stamp = rememberSessionReviewedLocally(session, { render });
  if (!stamp || !sync) {
    return Promise.resolve(session);
  }
  return syncSessionReviewedToServer(session);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const flushHeldSidebarSessionState = () => {
    Promise.resolve(settleAttachedSessionSidebarState({
      sessionId: currentSessionId,
      sync: false,
      render: false,
    })).catch(() => {});
  };
  window.addEventListener("pagehide", flushHeldSidebarSessionState);
  window.addEventListener("beforeunload", flushHeldSidebarSessionState);
}

function normalizeSessionRecord(session, previous = null) {
  const queueCount = Number.isInteger(session?.activity?.queue?.count)
    ? session.activity.queue.count
    : 0;
  const normalized = { ...session };
  if (!Object.prototype.hasOwnProperty.call(session || {}, "queuedMessages")) {
    if (queueCount > 0 && Array.isArray(previous?.queuedMessages)) {
      normalized.queuedMessages = previous.queuedMessages;
    } else {
      delete normalized.queuedMessages;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "model")) {
    if (typeof previous?.model === "string") {
      normalized.model = previous.model;
    } else {
      delete normalized.model;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "effort")) {
    if (typeof previous?.effort === "string") {
      normalized.effort = previous.effort;
    } else {
      delete normalized.effort;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "thinking")) {
    if (previous?.thinking === true) {
      normalized.thinking = true;
    } else {
      delete normalized.thinking;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "permissionMode")) {
    if (typeof previous?.permissionMode === "string") {
      normalized.permissionMode = previous.permissionMode;
    } else {
      delete normalized.permissionMode;
    }
  }
  const localReviewedAt = normalizeSessionReviewStamp(
    normalized.localReviewedAt
    || previous?.localReviewedAt
    || (typeof getLocalSessionReviewedAt === "function" ? getLocalSessionReviewedAt(normalized.id) : ""),
  );
  if (localReviewedAt) {
    normalized.localReviewedAt = localReviewedAt;
  } else {
    delete normalized.localReviewedAt;
  }
  const reviewBaselineAt = normalizeSessionReviewStamp(
    normalized.reviewBaselineAt
    || previous?.reviewBaselineAt
    || (typeof getSessionReviewBaselineAt === "function" ? getSessionReviewBaselineAt() : ""),
  );
  if (reviewBaselineAt) {
    normalized.reviewBaselineAt = reviewBaselineAt;
  } else {
    delete normalized.reviewBaselineAt;
  }
  return normalized;
}

function upsertSession(session) {
  if (!session?.id) return null;
  const previous = typeof getChatStoreSession === "function"
    ? getChatStoreSession(session.id)
    : sessions.find((entry) => entry.id === session.id);
  const normalized = normalizeSessionRecord(session, previous);
  if (typeof upsertChatSessionState === "function") {
    upsertChatSessionState(normalized, {
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  } else {
    const index = sessions.findIndex((entry) => entry.id === session.id);
    if (index === -1) {
      sessions.push(normalized);
    } else {
      sessions[index] = normalized;
    }
    sortSessionsInPlace();
  }
  refreshAppCatalog();
  // Sidebar-only refreshes (for example a background session invalidation) do
  // not pass through applySessionListState. Give the in-app attention layer the
  // same before/after transition signal without fetching that session's event
  // history.
  if (previous && typeof window.RagentAttentionPopup?.onSessionsApplied === "function") {
    try {
      window.RagentAttentionPopup.onSessionsApplied(
        new Map([[normalized.id, previous]]),
        [normalized],
      );
    } catch {}
  }
  return typeof getChatStoreSession === "function"
    ? getChatStoreSession(session.id)
    : normalized;
}


async function fetchSessionSidebar(sessionId, { forceFresh = false, signal = null } = {}) {
  const url = getSessionSidebarUrl(sessionId);
  const data = await fetchJsonOrRedirect(url, {
    ...buildSessionRefreshRequestOptions(forceFresh, signal),
    // Sidebar rows are safe to serve briefly stale; WS invalidations and the
    // next active-session refresh still provide authoritative convergence.
    ...(!forceFresh ? { cacheMaxAgeMs: 5_000 } : {}),
  });
  // Stale-response guard: superseded/cancelled sidebar fetches must not upsert.
  if (signal?.aborted) return null;
  return upsertSession(data.session);
}

function getWorkspaceFilteredSessionListUrl(baseUrl) {
  const projectId = typeof window.ragentGetSelectedProjectId === "function"
    ? window.ragentGetSelectedProjectId()
    : "";
  const normalizedProjectId = typeof projectId === "string" ? projectId.trim() : "";
  if (normalizedProjectId) {
    const separator = String(baseUrl).includes("?") ? "&" : "?";
    return `${baseUrl}${separator}projectId=${encodeURIComponent(normalizedProjectId)}`;
  }
  const folder = typeof window.ragentGetSelectedSessionFolder === "function"
    ? window.ragentGetSelectedSessionFolder()
    : (typeof window.ragentGetDefaultSessionFolder === "function"
      ? window.ragentGetDefaultSessionFolder()
      : "");
  const normalizedFolder = typeof folder === "string" ? folder.trim() : "";
  if (!normalizedFolder) return baseUrl;
  const separator = String(baseUrl).includes("?") ? "&" : "?";
  return `${baseUrl}${separator}folder=${encodeURIComponent(normalizedFolder)}`;
}

async function updateSessionRecord(sessionId, payload = {}) {
  const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (data.session) {
    const session = upsertSession(data.session) || data.session;
    renderSessionList();
    if (currentSessionId === sessionId) {
      applyAttachedSessionState(sessionId, session);
    }
    return session;
  }
  if (currentSessionId === sessionId) {
    return refreshCurrentSession({ essential: true });
  }
  return refreshSidebarSession(sessionId, { essential: true });
}

// Goal-chasing control (pause/resume the cross-turn auto-continuation). Mirrors
// updateSessionRecord's response handling: the endpoint returns the updated
// session, which upsert + applyAttachedSessionState (→ updateGoalChip) use to
// repaint the chip and sheet controls authoritatively.
async function controlGoalChasing(sessionId, action) {
  const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}/goal/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (data.session) {
    const session = upsertSession(data.session) || data.session;
    renderSessionList();
    if (currentSessionId === sessionId) {
      applyAttachedSessionState(sessionId, session);
    }
    return session;
  }
  if (currentSessionId === sessionId) {
    return refreshCurrentSession({ essential: true });
  }
  return refreshSidebarSession(sessionId, { essential: true });
}

async function fetchSessionsList({ forceFresh = false, essential = false } = {}) {
  if (visitorMode) return [];
  return scheduleSessionRefresh("session-list", {
    intent: { forceFresh },
    essential,
    run: async ({ signal }) => {
      if (typeof window.ragentEnsureProjectsReady === "function") {
        await window.ragentEnsureProjectsReady({ force: forceFresh });
      }
      // Cross-project catalog: the session bar is not scoped to one workspace.
      // The first level groups every project and the second level filters by the
      // browsed project client-side, so the fetch must carry no projectId/folder
      // filter (project-scoped fetches replaced the shared catalog and left the
      // browsed project's list empty after a switch).
      const data = await fetchJsonOrRedirect(
        SESSION_LIST_URL,
        {
          ...buildSessionRefreshRequestOptions(forceFresh, signal),
          ...(!forceFresh ? { cacheMaxAgeMs: 5_000 } : {}),
        },
      );
      // Stale-response guard: a response landing after this request was
      // superseded (or the session list detached) must not overwrite fresher
      // state with an older snapshot.
      if (signal?.aborted) return null;
      applySessionListState(data.sessions || []);
      // The archive section is no longer fetched as a separate list, but an
      // active-list refresh still completes any shell loading state left by a
      // pre-refresh navigation or an older client bundle.
      if (typeof setChatArchivedSessionsLoading === "function") {
        setChatArchivedSessionsLoading(false);
      }
      lastSessionsListRefreshAt = Date.now();
      return sessions;
    },
  });
}

async function restoreOwnerBootstrapSessions() {
  if (visitorMode) return null;
  const data = await fetchJsonOrRedirect('/api/bootstrap/owner-sessions/restore', {
    method: 'POST',
  });
  await fetchSessionsList({ forceFresh: true });
  const welcomeSessionId = typeof data?.welcomeSessionId === 'string'
    ? data.welcomeSessionId.trim()
    : '';
  if (welcomeSessionId) {
    const welcomeSession = findClientSessionRecord(welcomeSessionId);
    if (welcomeSession) {
      if (typeof navigateToSession === "function") {
        await navigateToSession(welcomeSessionId, {
          session: welcomeSession,
          tab: getActiveSidebarTabValue(),
          historyMode: "push",
        });
      } else {
        applyNavigationState({ sessionId: welcomeSessionId, tab: getActiveSidebarTabValue() });
        attachSession(welcomeSessionId, welcomeSession);
      }
      return data;
    }
  }
  restoreOwnerSessionSelection();
  return data;
}

async function organizeSessionListWithAgent({ closeSidebar = false } = {}) {
  const allowOrganize = typeof canOrganizeSessionList === "function"
    ? canOrganizeSessionList()
    : !visitorMode;
  if (visitorMode || !allowOrganize) return false;
  if (sessionListOrganizerInFlight) return sessionListOrganizerInFlight;

  const payload = buildSessionListOrganizerPayload();
  if (!Array.isArray(payload.sessions) || payload.sessions.length === 0) {
    setSortSessionListButtonState("Nothing to sort", { busy: false });
    scheduleSortSessionListButtonReset();
    return false;
  }

  if (sessionListOrganizerLabelResetTimer) {
    window.clearTimeout(sessionListOrganizerLabelResetTimer);
    sessionListOrganizerLabelResetTimer = null;
  }
  setSortSessionListButtonState("Sorting…", { busy: true });

  const request = (async () => {
    try {
      const data = await createSessionListOrganizerRun(payload);
      const runId = typeof data?.run?.id === "string" ? data.run.id.trim() : "";
      if (runId) {
        const run = await waitForSessionListOrganizerRun(runId);
        if (run?.state !== "completed") {
          throw new Error(run?.failureReason || `Sort list ${run?.state || "failed"}`);
        }
      } else {
        throw new Error("Sort list did not start a run");
      }
      await fetchSessionsList();
      if (closeSidebar && !isDesktop) {
        closeSidebarFn();
      }
      setSortSessionListButtonState("Sorted", { busy: false });
      return true;
    } catch (error) {
      console.warn("[sessions] Failed to organize the session list:", error.message);
      setSortSessionListButtonState("Sort failed", { busy: false });
      return false;
    } finally {
      sessionListOrganizerInFlight = null;
      scheduleSortSessionListButtonReset();
    }
  })();

  sessionListOrganizerInFlight = request;
  return request;
}

function applyAttachedSessionState(id, session, { hasAttachedSession: explicitHasAttachedSession = null } = {}) {
  if (inputArea) {
    inputArea.hidden = false;
  }
  const attachedSessionRenderState = getAttachedSessionRenderState();
  const wasSameAttachedSession = attachedSessionRenderState.sessionId === id;
  const nextSignature = getComparableAttachedSessionStateSignature(session || null);
  const shouldRefreshUi = !wasSameAttachedSession
    || attachedSessionRenderState.signature !== nextSignature;
  const nextHasAttachedSession = explicitHasAttachedSession !== null
    ? explicitHasAttachedSession === true
    : true;
  if (typeof setChatCurrentSession === "function") {
    setChatCurrentSession(id, { hasAttachedSession: nextHasAttachedSession });
  } else {
    currentSessionId = id;
    hasAttachedSession = nextHasAttachedSession;
  }
  const chatGlobal = typeof window === "object" ? window : globalThis;
  const resumeDecisionSheet = () => {
    if (nextHasAttachedSession) chatGlobal.RagentDecisionSheet?.resume?.();
  };
  if (typeof chatGlobal.RagentOrganizationView?.onSessionChanged === "function") {
    chatGlobal.RagentOrganizationView.onSessionChanged(id);
  }
  // The home workspace and empty state derive their visibility from the
  // attached-session flags. Commit the new session first; syncing before this
  // point leaves the home surface mounted over the selected conversation.
  if (typeof syncEmptyStateUi === "function") {
    syncEmptyStateUi();
  }
  // The durable session state can confirm an active run before the timeline
  // projection has produced a current activity. Keep the live activity row
  // continuous across session attach/history loading; ui.js supplies the
  // generic fallback until the richer projection arrives.
  if (typeof syncMobileLiveActivityLine === "function") {
    syncMobileLiveActivityLine();
  }
  if (typeof restoreComposerInteractionMode === "function") {
    restoreComposerInteractionMode(session);
  }
  // Observe run terminal transitions before the early-return below so haptic
  // feedback stays correct even when the UI signature already matched.
  chatGlobal.RagentHaptics?.observeRunState?.(session);
  if (typeof chatGlobal.updateGoalChip === "function") {
    chatGlobal.updateGoalChip(session);
  }
  // Pending outbound sends are transport state, not part of the attached
  // session signature. Reconcile before the signature short-circuit so a
  // same-shaped session projection cannot skip send acceptance/finalization.
  if (typeof reconcileComposerPendingSendWithSession === "function") {
    reconcileComposerPendingSendWithSession(session);
  }
  if (!shouldRefreshUi) {
    syncBrowserState();
    syncForkButton();
    syncShareButton();
    if (typeof syncWorkbenchInspectorSession === "function") {
      syncWorkbenchInspectorSession(session);
    }
    resumeDecisionSheet();
    return false;
  }
  currentTokens = 0;
  contextTokens.style.display = "none";
  compactBtn.style.display = "none";
  dropToolsBtn.style.display = "none";

  const displayName = getSessionDisplayName(session);
  headerTitle.textContent = displayName;
  if (typeof updateLiveBar === "function") updateLiveBar(session);
  if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) {
    const titleSuffix = getShareSnapshotViewValue("titleSuffix", "Shared Snapshot");
    document.title = `${displayName} · ${titleSuffix}`;
  }
  updateStatus("connected", session);
  if (typeof renderQueuedMessagePanel === "function") {
    renderQueuedMessagePanel(session);
  }

  if (session?.tool) {
    const availableTools = typeof allToolsList !== "undefined" && Array.isArray(allToolsList)
      ? allToolsList
      : (Array.isArray(toolsList) ? toolsList : []);
    const toolAvailable = availableTools.some((tool) => tool.id === session.tool);
    if (toolAvailable || availableTools.length === 0) {
      if (toolAvailable && typeof refreshPrimaryToolPicker === "function") {
        refreshPrimaryToolPicker({ keepToolIds: [session.tool], selectedValue: session.tool });
      }
      inlineToolSelect.value = session.tool;
      selectedTool = session.tool;
    }
    if (toolAvailable) {
      Promise.resolve(loadModelsForCurrentTool({
        preserveCurrentSelection: wasSameAttachedSession,
      })).catch(() => {});
    }
  }

  restoreDraft();
  renderSessionList();
  syncBrowserState();
  syncForkButton();
  syncShareButton();
  if (typeof syncWorkbenchInspectorSession === "function") {
    syncWorkbenchInspectorSession(session);
  }
  attachedSessionRenderState.sessionId = id;
  attachedSessionRenderState.signature = nextSignature;
  resumeDecisionSheet();
  return true;
}

function getAttachedSessionRenderState() {
  if (!(globalThis.__attachedSessionRenderState && typeof globalThis.__attachedSessionRenderState === "object")) {
    globalThis.__attachedSessionRenderState = {
      sessionId: null,
      signature: "",
    };
  }
  return globalThis.__attachedSessionRenderState;
}

function resetAttachedSessionRenderState() {
  const attachedSessionRenderState = getAttachedSessionRenderState();
  attachedSessionRenderState.sessionId = null;
  attachedSessionRenderState.signature = "";
  if (typeof finishSessionContentTransition === "function") {
    finishSessionContentTransition();
  } else if (typeof setSessionContentTransition === "function") {
    setSessionContentTransition(false);
  }
  if (typeof cancelSessionLoadingSkeleton === "function") {
    cancelSessionLoadingSkeleton(null, { announce: false });
  }
}

function buildComparableSessionState(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => buildComparableSessionState(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    const nextValue = buildComparableSessionState(value[key]);
    if (typeof nextValue !== "undefined") {
      normalized[key] = nextValue;
    }
  }
  return normalized;
}

function getComparableSessionStateSignature(value) {
  return JSON.stringify(buildComparableSessionState(value));
}

function getComparableAttachedSessionStateSignature(session) {
  if (!session || typeof session !== "object") {
    return getComparableSessionStateSignature(session);
  }
  return getComparableSessionStateSignature({
    id: session.id || null,
    name: session.name || "",
    tool: session.tool || "",
    providerProfile: typeof session.providerProfile === "string" ? session.providerProfile : null,
    status: session.status || "",
    archived: session.archived === true,
    activity: session.activity || null,
    queuedMessages: Array.isArray(session.queuedMessages) ? session.queuedMessages : null,
    model: typeof session.model === "string" ? session.model : null,
    effort: typeof session.effort === "string" ? session.effort : null,
    thinking: session.thinking === true ? true : null,
    permissionMode: typeof session.permissionMode === "string" ? session.permissionMode : null,
    interactionMode: typeof session.interactionMode === "string" ? session.interactionMode : null,
  });
}

async function fetchSessionState(sessionId, { forceFresh = false, essential = false } = {}) {
  if (isShareSnapshotReadOnlyMode()) {
    const snapshotSession = buildShareSnapshotSessionRecord();
    if (!snapshotSession || snapshotSession.id !== sessionId) {
      throw new Error("Session not found");
    }
    const normalized = upsertSession(snapshotSession);
    if (normalized && currentSessionId === sessionId) {
      applyAttachedSessionState(sessionId, normalized);
    }
    lastCurrentSessionRefreshAt = Date.now();
    lastCurrentSessionRefreshSessionId = sessionId;
    return normalized;
  }
  // Each registry entry owns exactly one controller; the run always uses the
  // entry's own signal so aborts (supersede / session-switch prefix abort)
  // cancel the fetch they govern.
  const data = await scheduleSessionRefresh(`session:${sessionId}:state`, {
    intent: { forceFresh },
    essential,
    run: async ({ signal }) => {
      const response = await fetchJsonOrRedirect(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        buildSessionRefreshRequestOptions(forceFresh, signal),
      );
      // Stale-response guard: superseded/cancelled state must not upsert.
      if (signal?.aborted) return null;
      return response;
    },
  });
  if (data === null) return null;
  const previous = typeof getChatStoreSession === "function"
    ? getChatStoreSession(sessionId)
    : (sessions.find((entry) => entry.id === sessionId) || null);
  const nextSession = normalizeSessionRecord(data.session, previous);
  const sessionChanged = !previous
    || getComparableSessionStateSignature(previous) !== getComparableSessionStateSignature(nextSession);
  const normalized = sessionChanged
    ? (upsertSession(nextSession) || nextSession)
    : previous;
  if (normalized && currentSessionId === sessionId) {
    stageSessionReviewedForAttachedSession(normalized);
    applyAttachedSessionState(sessionId, normalized);
  }
  lastCurrentSessionRefreshAt = Date.now();
  lastCurrentSessionRefreshSessionId = sessionId;
  return normalized;
}

async function navigateToSession(sessionId, {
  session = null,
  tab = "sessions",
  historyMode = "push",
  forceFresh = false,
  forceComposerFocus = false,
  viewportIntent = "session_entry_bottom",
  loadSession = null,
  beforeAttach = null,
  afterAttach = null,
} = {}) {
  const normalizedSessionId = normalizeSessionReferenceId(sessionId);
  if (!normalizedSessionId) return null;
  const normalizedViewportIntent = typeof normalizeSessionViewportIntent === "function"
    ? normalizeSessionViewportIntent(viewportIntent)
    : "session_entry_bottom";

  const navigation = typeof beginSessionNavigation === "function"
    ? beginSessionNavigation(normalizedSessionId)
    : { generation: 0, sessionId: normalizedSessionId };
  const targetTab = typeof tab === "string" && tab.trim() ? tab.trim() : "sessions";
  if (typeof clearSessionLoadError === "function") clearSessionLoadError();
  const needsSessionAttach = (typeof hasAttachedSession === "undefined" || !hasAttachedSession)
    || currentSessionId !== normalizedSessionId;
  if (needsSessionAttach && typeof scheduleSessionLoadingSkeleton === "function") {
    scheduleSessionLoadingSkeleton();
  }
  pendingNavigationState = {
    sessionId: normalizedSessionId,
    tab: targetTab,
    historyMode,
  };
  if (typeof switchTab === "function") {
    switchTab(targetTab, { syncState: false });
  }

  try {
    let targetSession = session?.id === normalizedSessionId ? session : null;
    if (!targetSession) {
      targetSession = typeof loadSession === "function"
        ? await loadSession(navigation)
        : await fetchSessionState(normalizedSessionId, { forceFresh, essential: true });
    }
    if (
      typeof isSessionNavigationCurrent === "function"
      && !isSessionNavigationCurrent(navigation.generation, normalizedSessionId)
    ) {
      return null;
    }
    // A cancelled current navigation has already cleared its request registry.
    // Do not silently leave the freshly selected transcript empty: surface a
    // retryable load state unless a newer navigation owns the UI.
    if (targetSession === null) {
      // A caller-provided loader may use null as an explicit navigation
      // cancellation signal (for example when a referenced session was
      // superseded before it was resolved). Preserve that contract, but clear
      // the loading affordance so it cannot linger forever.
      if (typeof loadSession === "function") {
        if (typeof cancelSessionLoadingSkeleton === "function") {
          cancelSessionLoadingSkeleton(null, { announce: false });
        }
        pendingNavigationState = null;
        return null;
      }
      const error = new Error("Session refresh was cancelled before content loaded");
      error.code = "SESSION_REFRESH_CANCELLED";
      error.eventRefreshReason = "refresh_cancelled";
      throw error;
    }
    if (!targetSession?.id) {
      throw new Error("Session not found");
    }

    if (typeof beforeAttach === "function") {
      await beforeAttach(targetSession, navigation);
      if (
        typeof isSessionNavigationCurrent === "function"
        && !isSessionNavigationCurrent(navigation.generation, normalizedSessionId)
      ) {
        return null;
      }
    }

    const attachedSession = typeof upsertSession === "function"
      ? (upsertSession(targetSession) || targetSession)
      : targetSession;
    let attachPromise = null;
    if (typeof attachSession === "function") {
      attachPromise = attachSession(attachedSession.id, attachedSession, {
        forceComposerFocus,
        navigationGeneration: navigation.generation,
        viewportIntent: normalizedViewportIntent,
      });
    } else if (typeof applyAttachedSessionState === "function") {
      applyAttachedSessionState(attachedSession.id, attachedSession);
    }
    if (attachPromise && typeof attachPromise.then === "function") {
      const attachResult = await attachPromise;
      if (attachResult === "cancelled") {
        // A newer navigation or refresh now owns this transcript. This is an
        // intentional no-op, not the false result reserved for a real attach
        // failure.
        // Do not let a stale navigation tear down the loading state belonging
        // to the newer click. Both the skeleton token and pending target are
        // global, so an unconditional cleanup here made rapid session clicks
        // leave the final session waiting forever until a full page reload.
        const ownsNavigationState = typeof isSessionNavigationCurrent !== "function"
          || isSessionNavigationCurrent(navigation.generation, normalizedSessionId);
        if (ownsNavigationState) {
          if (typeof cancelSessionLoadingSkeleton === "function") {
            cancelSessionLoadingSkeleton(null, { announce: false });
          }
          if (typeof setSessionContentTransition === "function") {
            setSessionContentTransition(false);
          }
          if (
            typeof pendingNavigationState === "undefined"
            || !pendingNavigationState
            || pendingNavigationState.sessionId === normalizedSessionId
          ) {
            pendingNavigationState = null;
          }
        }
        return null;
      }
      if (attachResult === false) {
        const error = new Error("Session attach failed");
        error.code = "SESSION_ATTACH_FAILED";
        error.eventRefreshReason = "attach_failed";
        throw error;
      }
    }
    if (
      typeof isSessionNavigationCurrent === "function"
      && !isSessionNavigationCurrent(navigation.generation, normalizedSessionId)
    ) {
      return null;
    }
    if (typeof afterAttach === "function") {
      await afterAttach(attachedSession, navigation);
      if (
        typeof isSessionNavigationCurrent === "function"
        && !isSessionNavigationCurrent(navigation.generation, normalizedSessionId)
      ) {
        return null;
      }
    }
    pendingNavigationState = null;
    if (typeof syncBrowserState === "function") {
      syncBrowserState({
        sessionId: attachedSession.id,
        tab: targetTab,
        historyMode,
      });
    }
    return attachedSession;
  } catch (error) {
    const isCurrentNavigation = typeof isSessionNavigationCurrent !== "function"
      || isSessionNavigationCurrent(navigation.generation, normalizedSessionId);
    if (
      isCurrentNavigation
      && typeof showSessionLoadError === "function"
      && error?.sessionLoadErrorShown !== true
    ) {
      if (showSessionLoadError(
        normalizedSessionId,
        error,
        typeof classifySessionLoadError === "function"
          ? classifySessionLoadError(error)
          : "request_failed",
      )) {
        // Event loading can already have rendered the specific retryable error
        // before the navigation promise rejects. Keep the final navigation
        // catch from replacing it with a second generic error surface.
        error.sessionLoadErrorShown = true;
      }
    }
    throw error;
  }
}

function normalizeSessionReferenceId(sessionId) {
  return typeof sessionId === "string" ? sessionId.trim() : "";
}

function normalizeSessionReferenceFolder(folder) {
  return typeof folder === "string" ? folder.trim() : "";
}

function switchWorkspaceForSessionReference(session) {
  const projectId = typeof session?.projectId === "string" ? session.projectId.trim() : "";
  if (projectId && typeof window.ragentGetSelectedProjectId === "function") {
    const selectedProjectId = String(window.ragentGetSelectedProjectId() || "").trim();
    if (selectedProjectId === projectId) return projectId;
    if (typeof window.ragentEnsureProjectsReady === "function") {
      void window.ragentEnsureProjectsReady().then(() => {
        const project = typeof window.ragentGetProjects === "function"
          ? window.ragentGetProjects().find((entry) => entry?.id === projectId)
          : null;
        if (project?.rootPath && typeof window.ragentSetSelectedSessionFolderForNavigation === "function") {
          window.ragentSetSelectedSessionFolderForNavigation(project.rootPath);
        }
      });
    }
    return projectId;
  }
  const folder = normalizeSessionReferenceFolder(session?.folder);
  if (!folder) return "";
  const selectedFolder = typeof window.ragentGetSelectedSessionFolder === "function"
    ? normalizeSessionReferenceFolder(window.ragentGetSelectedSessionFolder())
    : "";
  if (selectedFolder === folder) return folder;
  if (typeof window.ragentSetSelectedSessionFolderForNavigation === "function") {
    return window.ragentSetSelectedSessionFolderForNavigation(folder);
  }
  if (typeof window.ragentSetSelectedSessionFolder === "function") {
    return window.ragentSetSelectedSessionFolder(folder);
  }
  return folder;
}

async function openSessionReference(sessionId, {
  tab = "sessions",
  inspectorTab = "",
  forceFresh = true,
} = {}) {
  const normalizedSessionId = normalizeSessionReferenceId(sessionId);
  if (!normalizedSessionId) return null;
  const targetTab = typeof tab === "string" && tab.trim() ? tab.trim() : "sessions";
  return navigateToSession(normalizedSessionId, {
    tab: targetTab,
    historyMode: "push",
    forceFresh,
    loadSession: async () => {
      // User-initiated navigation: never gated by the hidden-tab scheduler rule.
      return fetchSessionState(normalizedSessionId, { forceFresh, essential: true });
    },
    beforeAttach: (session) => switchWorkspaceForSessionReference(session),
    afterAttach: async (session) => {
      if (typeof fetchSessionsList === "function") {
        await fetchSessionsList({ forceFresh: true, essential: true }).catch(() => {});
      }
      if (typeof window.ragentOpenWorkbenchInspectorTab === "function" && inspectorTab) {
        window.ragentOpenWorkbenchInspectorTab(inspectorTab);
      }
      if (typeof window.scheduleWorkbenchInspectorRefresh === "function") {
        window.scheduleWorkbenchInspectorRefresh(session.id, { forceFresh: true, delay: 0 });
      }
    },
  });
}

if (typeof window !== "undefined") {
  window.ragentOpenSessionReference = openSessionReference;
}

// ---- Session loading skeleton + chunked render ----
// Entering a session used to blank the canvas and then synchronously render
// up to 200 events in one JS task (a frozen frame or two on phones). The
// skeleton only appears when the fetch takes longer than the delay, so fast
// restores never flash it; chunked rendering yields to the main thread
// between batches so the first messages paint as soon as they are ready.
let sessionLoadingSkeletonTimer = null;
let sessionLoadingSkeletonToken = 0;

// ---- Loading live region (screen-reader announcements) ----
// The skeleton is aria-hidden (decorative); the load state itself is
// announced through a visually-hidden polite live region so screen readers
// hear that the session is loading and when it is ready. Announcements are
// gated on the skeleton actually appearing (>=150ms delay), so fast restores
// never interrupt a screen reader with a loading/loaded pair.
let sessionLoadingLiveEl = null;
let sessionLoadingAnnounced = false;
let sessionLoadingClearTimer = null;
let sessionLoadErrorEl = null;
let sessionLoadErrorSessionId = "";
let sessionLoadErrorNavigation = null;
let sessionLoadRetryInFlight = false;

function sessionLoadingText(key, fallback) {
  try {
    if (typeof window.ragentT === "function") {
      const value = window.ragentT(key);
      if (typeof value === "string" && value) return value;
    }
  } catch { /* fall through to fallback */ }
  return fallback;
}

function isCurrentSessionLoadTarget(sessionId) {
  if (!sessionId) return false;
  const pending = typeof pendingNavigationState !== "undefined"
    ? pendingNavigationState
    : null;
  if (pending?.sessionId) return pending.sessionId === sessionId;
  return currentSessionId === sessionId;
}

function ensureSessionLoadError() {
  if (sessionLoadErrorEl?.parentNode) return sessionLoadErrorEl;
  const host = messagesEl || messagesInner;
  if (!host || typeof host.appendChild !== "function") return null;
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  try {
    const section = document.createElement("section");
    section.className = "messages-session-error";
    section.hidden = true;
    section.setAttribute?.("role", "alert");
    section.setAttribute?.("aria-live", "assertive");

    const surface = document.createElement("div");
    surface.className = "messages-session-error__surface";
    const title = document.createElement("strong");
    title.className = "messages-session-error__title";
    const body = document.createElement("span");
    body.className = "messages-session-error__body";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "messages-session-error__retry";
    retry.addEventListener?.("click", () => {
      const sessionId = sessionLoadErrorSessionId || currentSessionId;
      const retryNavigation = sessionLoadErrorNavigation?.sessionId === sessionId
        ? { ...sessionLoadErrorNavigation }
        : null;
      const isCurrentTarget = isCurrentSessionLoadTarget(sessionId)
        || sessionLoadErrorSessionId === sessionId;
      if (!sessionId || !isCurrentTarget || sessionLoadRetryInFlight) return;
      sessionLoadRetryInFlight = true;
      retry.disabled = true;

      if (typeof abortSessionRefreshRequests === "function") {
        abortSessionRefreshRequests(sessionId);
      }
      if (typeof syncRealtimeNetworkConnection === "function") {
        syncRealtimeNetworkConnection();
      }
      if (typeof reconnectTimer !== "undefined" && reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (typeof connect === "function" && (typeof ws === "undefined" || !ws || ws.readyState !== WebSocket.OPEN)) {
        try { connect(); } catch {}
      }

      clearSessionLoadError(sessionId);
      const targetTab = retryNavigation?.tab
        || (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : "sessions");
      const shouldNavigate = Boolean(retryNavigation)
        || currentSessionId !== sessionId
        || (typeof hasAttachedSession !== "undefined" && !hasAttachedSession);
      const retryPromise = shouldNavigate && typeof navigateToSession === "function"
        ? navigateToSession(sessionId, {
          session: typeof findClientSessionRecord === "function"
            ? findClientSessionRecord(sessionId)
            : null,
          tab: targetTab,
          historyMode: "replace",
          forceFresh: true,
          viewportIntent: "session_entry_bottom",
        })
        : refreshCurrentSession({
          forceFresh: true,
          viewportIntent: "session_entry_bottom",
          essential: true,
        });
      Promise.resolve(retryPromise).catch(() => {}).finally(() => {
        sessionLoadRetryInFlight = false;
        if (sessionLoadErrorEl?.parentNode && sessionLoadErrorSessionId === sessionId) {
          retry.disabled = false;
        }
      });
    });
    surface.append(title, body, retry);
    section.appendChild(surface);

    if (typeof host.insertBefore === "function" && messagesInner?.parentNode === host) {
      host.insertBefore(section, messagesInner);
    } else {
      host.appendChild(section);
    }
    sessionLoadErrorEl = section;
  } catch {
    sessionLoadErrorEl = null;
  }
  return sessionLoadErrorEl;
}

function hasSessionLoadError(sessionId = currentSessionId) {
  if (!sessionId) return false;
  if (sessionLoadErrorSessionId && sessionLoadErrorSessionId === sessionId) {
    if (sessionLoadErrorEl) return !sessionLoadErrorEl.hidden;
    return true;
  }
  const errorEl = typeof document !== "undefined"
    ? document.querySelector?.(".messages-session-error")
    : null;
  if (errorEl && !errorEl.hidden && (errorEl.dataset?.sessionId === sessionId || !errorEl.dataset?.sessionId)) {
    return true;
  }
  return false;
}

if (typeof window !== "undefined") {
  window.hasSessionLoadError = hasSessionLoadError;
  window.hasRenderedEventSnapshot = hasRenderedEventSnapshot;
}

function clearSessionLoadError(sessionId = null) {
  if (
    sessionLoadErrorSessionId
    && sessionId
    && sessionLoadErrorSessionId !== sessionId
  ) return;
  sessionLoadErrorSessionId = "";
  sessionLoadErrorNavigation = null;
  const section = sessionLoadErrorEl;
  if (!section) return;
  section.hidden = true;
  section.classList?.remove("is-visible");
  section.removeAttribute?.("data-error-code");
  section.removeAttribute?.("data-request-id");
  const retry = section.querySelector?.(".messages-session-error__retry");
  if (retry) retry.disabled = false;
}

function showSessionLoadError(sessionId, error, reason = "request_failed") {
  if (!sessionId || !isCurrentSessionLoadTarget(sessionId)) return false;
  // Superseded/aborted navigation is an ownership change, not a failed load.
  // The newer request owns the transcript and will either render it or report
  // its own concrete error. Showing an error here creates a false failure card
  // during normal rapid navigation and foreground reconciliation.
  if (reason === "refresh_cancelled" || reason === "attach_cancelled") {
    cancelSessionLoadingSkeleton(null, { announce: false });
    return false;
  }
  cancelSessionLoadingSkeleton(null, { announce: false });
  if (
    messagesInner?.classList?.contains("is-session-transitioning")
    && typeof clearMessages === "function"
  ) {
    // The previous session is useful while a replacement is loading, but it
    // must not remain under an error card for the newly selected session.
    clearMessages();
  }
  if (typeof setSessionContentTransition === "function") {
    setSessionContentTransition(false);
  }
  const section = ensureSessionLoadError();
  if (!section) return false;
  sessionLoadErrorSessionId = sessionId;
  const pending = typeof pendingNavigationState !== "undefined"
    ? pendingNavigationState
    : null;
  const pendingTarget = pending?.sessionId === sessionId
    ? pending
    : null;
  sessionLoadErrorNavigation = pendingTarget
    ? {
      sessionId,
      tab: pendingTarget.tab || "sessions",
      historyMode: pendingTarget.historyMode || "replace",
    }
    : null;
  section.dataset.sessionId = sessionId;
  if (error?.code) section.dataset.errorCode = String(error.code);
  if (error?.requestId) section.dataset.requestId = String(error.requestId);
  const title = section.querySelector?.(".messages-session-error__title");
  const body = section.querySelector?.(".messages-session-error__body");
  const retry = section.querySelector?.(".messages-session-error__retry");
  if (title) title.textContent = sessionLoadingText("status.sessionLoadFailed", "Couldn't load this session");
  if (body) body.textContent = sessionLoadingText(
    "status.sessionLoadFailedBody",
    "The conversation is still here. Try loading it again.",
  );
  if (retry) {
    retry.textContent = sessionLoadingText("status.retrySessionLoad", "Try again");
    retry.disabled = false;
  }
  section.dataset.reason = reason;
  section.hidden = false;
  section.classList?.add("is-visible");
  return true;
}

function classifySessionEventRefreshError(error) {
  const explicit = typeof error?.eventRefreshReason === "string"
    ? error.eventRefreshReason.trim()
    : "";
  if (explicit) return explicit;
  if (error?.code === "EVENTS_RESPONSE_INVALID") return "response_invalid";
  if (error?.code === "SESSION_HISTORY_CORRUPT" || error?.code === "SESSION_HISTORY_BODY_CORRUPT") return "history_corrupt";
  if (error?.code === "SESSION_HISTORY_GAP") return "history_gap";
  if (error?.code === "SESSION_SNAPSHOT_UNSTABLE" || error?.code === "SESSION_RESPONSE_UNSTABLE") return "snapshot_unstable";
  if (error?.code === "SESSION_HISTORY_MISSING") return "history_missing";
  if (error?.code === "REQUEST_TIMEOUT") return "transport_timeout";
  if (error?.code === "AUTH_EXPIRED") return "auth_expired";
  if (error?.code === "TIMELINE_RUNTIME_UNAVAILABLE") return "runtime_unavailable";
  if (error?.code === "TIMELINE_PROJECTION_FAILED") return "projection_failed";
  if (Number(error?.status) > 0) return "http_failed";
  return "request_failed";
}

function classifySessionLoadError(error) {
  if (error?.code === "SESSION_REFRESH_CANCELLED") return "refresh_cancelled";
  if (error?.code === "SESSION_ATTACH_FAILED" || error?.code === "SESSION_ATTACH_CANCELLED") return "attach_failed";
  return classifySessionEventRefreshError(error);
}

function ensureHistoryLoadingIndicator() {
  if (historyLoadingIndicatorEl?.parentNode) return historyLoadingIndicatorEl;
  if (!messagesEl || typeof messagesEl.appendChild !== "function") return null;
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  try {
    const indicator = document.createElement("div");
    indicator.className = "messages-history-loader";
    indicator.setAttribute?.("role", "status");
    indicator.setAttribute?.("aria-live", "polite");
    indicator.setAttribute?.("aria-hidden", "true");

    const pill = document.createElement("div");
    pill.className = "messages-history-loader__pill";
    const dot = document.createElement("span");
    dot.className = "messages-history-loader__dot";
    dot.setAttribute?.("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "messages-history-loader__label";
    pill.append(dot, label);
    indicator.appendChild(pill);

    if (typeof messagesEl.insertBefore === "function") {
      messagesEl.insertBefore(indicator, messagesEl.firstChild || null);
    } else {
      messagesEl.appendChild(indicator);
    }
    historyLoadingIndicatorEl = indicator;
  } catch {
    historyLoadingIndicatorEl = null;
  }
  return historyLoadingIndicatorEl;
}

function beginHistoryLoadingIndicator() {
  const token = ++historyLoadingIndicatorToken;
  historyLoadingIndicatorStartedAt = Date.now();
  if (historyLoadingIndicatorHideTimer) {
    clearTimeout(historyLoadingIndicatorHideTimer);
    historyLoadingIndicatorHideTimer = null;
  }
  const indicator = ensureHistoryLoadingIndicator();
  if (!indicator) return token;
  const label = indicator.querySelector?.(".messages-history-loader__label");
  if (label) {
    label.textContent = sessionLoadingText("status.loadingHistory", "Loading earlier messages…");
  }
  indicator.setAttribute?.("aria-hidden", "false");
  indicator.classList?.remove("is-leaving");
  indicator.classList?.remove("is-visible");
  const reveal = () => {
    if (token !== historyLoadingIndicatorToken) return;
    indicator.classList?.add("is-visible");
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(reveal);
  } else {
    reveal();
  }
  return token;
}

function finishHistoryLoadingIndicator(token) {
  if (!token || token !== historyLoadingIndicatorToken) return;
  const indicator = historyLoadingIndicatorEl;
  if (!indicator) return;
  const elapsed = Math.max(0, Date.now() - historyLoadingIndicatorStartedAt);
  const delay = Math.max(0, SESSION_EVENT_HISTORY_LOADING_MIN_VISIBLE_MS - elapsed);
  const hide = () => {
    historyLoadingIndicatorHideTimer = null;
    if (token !== historyLoadingIndicatorToken) return;
    indicator.classList?.remove("is-visible");
    indicator.classList?.add("is-leaving");
    indicator.setAttribute?.("aria-hidden", "true");
  };
  if (delay > 0 && typeof setTimeout === "function") {
    historyLoadingIndicatorHideTimer = setTimeout(hide, delay);
  } else {
    hide();
  }
}

function ensureSessionLoadingLiveRegion() {
  if (sessionLoadingLiveEl?.parentNode) return sessionLoadingLiveEl;
  if (!messagesEl || !messagesEl.parentNode) return null;
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  try {
    const el = document.createElement("div");
    el.className = "sr-only";
    el.setAttribute?.("role", "status");
    el.setAttribute?.("aria-live", "polite");
    messagesEl.parentNode.appendChild(el);
    sessionLoadingLiveEl = el;
  } catch { sessionLoadingLiveEl = null; }
  return sessionLoadingLiveEl;
}

function announceSessionLoadingState(loaded) {
  try {
    if (loaded && !sessionLoadingAnnounced) return;
    if (!loaded && sessionLoadingAnnounced) return;
    const el = ensureSessionLoadingLiveRegion();
    if (!el) return;
    el.textContent = loaded
      ? sessionLoadingText("status.sessionLoaded", "Session loaded")
      : sessionLoadingText("status.loadingSession", "Loading session…");
    sessionLoadingAnnounced = !loaded;
    if (loaded && typeof setTimeout === "function") {
      if (sessionLoadingClearTimer) clearTimeout(sessionLoadingClearTimer);
      sessionLoadingClearTimer = setTimeout(() => {
        sessionLoadingClearTimer = null;
        try {
          if (el.parentNode) el.textContent = "";
        } catch { /* noop */ }
      }, 800);
    }
  } catch { /* announcement is progressive enhancement */ }
}

function showSessionLoadingSkeleton() {
  if (!messagesInner) return;
  if (typeof document === "undefined" || typeof document.createElement !== "function") return;
  try {
    if (emptyState?.parentNode === messagesInner) emptyState.remove();
    if (messagesInner.querySelector?.(".messages-loading-skeleton")) return;
    const skeleton = document.createElement("div");
    skeleton.className = "messages-loading-skeleton";
    skeleton.setAttribute?.("aria-hidden", "true");

    const userRow = document.createElement("div");
    userRow.className = "messages-loading-skeleton__user-row";
    const userBubble = document.createElement("div");
    userBubble.className = "messages-loading-skeleton__bar messages-loading-skeleton__user-bubble";
    userRow.appendChild(userBubble);
    skeleton.appendChild(userRow);

    const assistantRow = document.createElement("div");
    assistantRow.className = "messages-loading-skeleton__assistant-row";
    const avatar = document.createElement("div");
    avatar.className = "messages-loading-skeleton__bar messages-loading-skeleton__avatar";
    const lines = document.createElement("div");
    lines.className = "messages-loading-skeleton__lines";
    for (const width of [86, 62]) {
      const bar = document.createElement("div");
      bar.className = "messages-loading-skeleton__bar";
      bar.style?.setProperty?.("width", `${width}%`);
      lines.appendChild(bar);
    }
    assistantRow.appendChild(avatar);
    assistantRow.appendChild(lines);
    skeleton.appendChild(assistantRow);

    messagesInner.appendChild(skeleton);
    announceSessionLoadingState(false);
  } catch { /* skeleton is progressive enhancement */ }
}

function hideSessionLoadingSkeleton({ announce = true } = {}) {
  try {
    const existing = messagesInner?.querySelector?.(".messages-loading-skeleton");
    if (existing && typeof existing.remove === "function") existing.remove();
    if (announce) announceSessionLoadingState(true);
  } catch { /* noop */ }
}

function scheduleSessionLoadingSkeleton() {
  sessionLoadingSkeletonToken += 1;
  const token = sessionLoadingSkeletonToken;
  if (typeof setTimeout !== "function") return token;
  if (sessionLoadingSkeletonTimer) clearTimeout(sessionLoadingSkeletonTimer);
  sessionLoadingSkeletonTimer = setTimeout(() => {
    sessionLoadingSkeletonTimer = null;
    if (token !== sessionLoadingSkeletonToken) return;
    if (!messagesInner || messagesInner.children.length > 0) return;
    showSessionLoadingSkeleton();
  }, SESSION_LOADING_SKELETON_DELAY_MS);
  return token;
}

function cancelSessionLoadingSkeleton(token, { announce = true } = {}) {
  sessionLoadingSkeletonToken = token
    ? Math.max(token, sessionLoadingSkeletonToken) + 1
    : sessionLoadingSkeletonToken + 1;
  if (sessionLoadingSkeletonTimer) {
    clearTimeout(sessionLoadingSkeletonTimer);
    sessionLoadingSkeletonTimer = null;
  }
  hideSessionLoadingSkeleton({ announce });
}

// Unified timeline fetch path. The transport never decides whether a page is
// an append, reset, or prepend. It only supplies a batch to the projector;
// the projector owns dedupe, ordering, and durable/live convergence.
async function fetchSessionEventsInternal(
  sessionId,
  {
    runState = "idle",
    viewportIntent = "preserve",
    forceFresh = false,
    signal = null,
    prefetchedData = null,
  } = {},
) {
  const requestStartedAt = nowPerfMs();
  const normalizedViewportIntent = normalizeSessionViewportIntent(viewportIntent);
  const timelineRuntime = window.RagentTimelineRuntime;
  if (!timelineRuntime?.renderBatch || !timelineRuntime?.renderIncremental) {
    const error = new Error("Timeline runtime is unavailable");
    error.code = "TIMELINE_RUNTIME_UNAVAILABLE";
    error.eventRefreshReason = "runtime_unavailable";
    throw error;
  }
  const hadRenderedTimeline = hasRenderedEventSnapshot(sessionId);
  const shouldStickToBottom = shouldStickToBottomForEventRefresh();
  const preserveViewport = normalizedViewportIntent === "preserve"
    && !shouldStickToBottom;
  const viewportAnchor = preserveViewport
    ? captureMessageViewportAnchor({ sessionId })
    : null;

  let boundedRefreshData = null;
  if (!prefetchedData && shouldAttemptEventDeltaFetch(sessionId, { runState })) {
    const before = getTimelineRuntimeSnapshot(sessionId);
    const afterSeq = Number.isInteger(before?.latestSeq) ? before.latestSeq : 0;
    const deltaStartedAt = nowPerfMs();
    try {
      const delta = await fetchSessionEventDelta(sessionId, afterSeq, { forceFresh, signal });
      // A transport can ignore AbortController (notably some P2P/browser
      // adapters). Do not let that late response render into the current
      // session or interfere with the newer navigation's loading state.
      if (signal?.aborted) {
        const error = new Error("Session delta request was aborted");
        error.name = "AbortError";
        throw error;
      }
      if (currentSessionId !== sessionId) return delta.events;
      if (!delta.resetRequired) {
        syncFetchedRunActivity(delta.runActivity);
        // HTTP is the durable source of truth, including incremental pages.
        // The incremental renderer is reserved for sequence-free WebSocket
        // overlays, exactly like Android's durable-baseline/live-overlay split.
        const renderStartedAt = nowPerfMs();
        const projected = timelineRuntime.renderBatch(
          delta.events.concat(delta.operationUpdates || []),
          {
            sessionId,
            runState,
            latestSeq: delta.latestSeq,
            source: "http",
            renderOptions: {
              // This is a delta for an already-visible session. A provider can
              // flush a completed assistant message as one durable event; show
              // that first arrival through the same paced presentation gate.
              syntheticAssistantMessages: hadRenderedTimeline,
            },
          },
        );
        const renderMs = Math.max(0, nowPerfMs() - renderStartedAt);
        if (!projected) {
          const error = new Error("Timeline delta projection failed");
          error.code = "TIMELINE_PROJECTION_FAILED";
          error.eventRefreshReason = "projection_failed";
          throw error;
        }
        // A user can start at the bottom and scroll away while the request is
        // in flight. Re-check the live viewport before applying the response;
        // the request-start position is only a hint, not permission to pull
        // the transcript back down after an explicit user gesture.
        const shouldStickToBottomAtResponse = shouldStickToBottomForEventRefresh();
        if (shouldOpenCurrentSessionAtBottom({ viewportIntent: normalizedViewportIntent })) {
          scrollToBottom({ sessionId });
          pinMessageViewportToBottomForSessionEntry(sessionId);
        } else if (shouldOpenCurrentSessionFromTop({ sessionId, viewportIntent: normalizedViewportIntent })) {
          scrollCurrentSessionViewportToTop();
        } else if (viewportAnchor) {
          markMessageViewportProgrammaticScroll();
          restoreMessageViewportAnchor(viewportAnchor, { sessionId, respectUserIntent: true });
        } else if (delta.events.length > 0 && shouldStickToBottomAtResponse) {
          const spacer = typeof document !== "undefined" ? document.getElementById("turnViewportSpacer") : null;
          if (spacer && typeof syncTurnViewportSpacerOnGrowth === "function") {
            syncTurnViewportSpacerOnGrowth();
          } else {
            scrollToBottom({ minScrollTop: messagesEl.scrollTop });
          }
        }
        // A delta can be the first visible projection after a session was
        // restored from memory. If its latest page does not fill the viewport,
        // there may be no user scroll event to drive the older-page pager.
        try {
          await autofillSessionHistoryViewport({ forceFresh });
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          recordHistoryPagingFailure(error);
        }
        applyFinishedTurnCollapseState();
        recordEventRefreshMetric({
          mode: "delta",
          outcome: projected.items.length > 0 ? "applied" : "empty",
          renderMode: projected.items.length > 0 ? "projected" : "empty",
          requestMs: Math.max(0, nowPerfMs() - deltaStartedAt),
          renderMs,
          payloadBytes: estimatePayloadBytes(delta),
          eventCount: delta.events.length,
          latestSeq: projected.latestSeq,
          totalElapsedMs: Math.max(0, nowPerfMs() - requestStartedAt),
        });
        return delta.events;
      }
      // The visible delta endpoint may return an authoritative bounded page
      // when a projection reset is required. Reuse that snapshot directly
      // instead of issuing a second identical latest-page request.
      if (delta.resetRequired && (Array.isArray(delta.events) && delta.events.length > 0 || delta.pagination)) {
        boundedRefreshData = delta;
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      console.warn("[events-delta] falling back to a durable timeline page:", error?.message || error);
    }
  }

  const skeletonToken = scheduleSessionLoadingSkeleton();
  const data = prefetchedData || (isShareSnapshotReadOnlyMode()
    ? { events: getShareSnapshotDisplayEvents() }
    : (boundedRefreshData || await fetchSessionVisibleEventsPage(sessionId, {
      direction: "latest",
      limit: SESSION_EVENT_PAGE_SIZE,
      forceFresh,
      signal,
    })));
  // Check both ownership and cancellation before touching the global loading
  // skeleton. A late old-session response used to cancel the new session's
  // skeleton first and only then fail the stale-session guard below.
  if (signal?.aborted) {
    const error = new Error("Session events request was aborted");
    error.name = "AbortError";
    throw error;
  }
  if (currentSessionId !== sessionId) {
    return data?.events || [];
  }
  cancelSessionLoadingSkeleton(skeletonToken);
  const events = Array.isArray(data?.events) ? data.events : [];
  const pagination = {
    ...(data?.pagination && typeof data.pagination === "object" ? data.pagination : {}),
    ...(Number.isInteger(data?.latestSeq) ? { latestSeq: data.latestSeq } : {}),
  };
  const renderStartedAt = nowPerfMs();
  const projected = timelineRuntime.renderBatch(events, {
    sessionId,
    runState,
    pagination,
    latestSeq: data?.latestSeq,
    paginationMode: "latest",
    renderOptions: {
      // resolvePendingApprovalEvent + isPlanProgressEventLike moved to
      // session-http-helpers.js so full-sync and transport paths share one
      // replay gate for the currently actionable approval.
      approvalRequestLiveId: isApprovalLiveRunState(runState)
        ? String(resolvePendingApprovalEvent(events)?.approvalId || "")
        : "",
    },
  });
  const renderMs = Math.max(0, nowPerfMs() - renderStartedAt);
  if (!projected) {
    const error = new Error("Timeline page projection failed");
    error.code = "TIMELINE_PROJECTION_FAILED";
    error.eventRefreshReason = "projection_failed";
    throw error;
  }
  syncFetchedRunActivity(data.runActivity);
  if (messagesInner.children.length === 0) showEmpty();
  if (typeof restorePreservedComposerEchoesAfterRender === "function") {
    restorePreservedComposerEchoesAfterRender();
  }

  const latestTurnStart = applyFinishedTurnCollapseState();
  // Preserve a new user reading position when it changed while this page was
  // loading; the request-start sticky state is only a hint.
  const shouldStickToBottomAtResponse = shouldStickToBottomForEventRefresh();
  if (shouldOpenCurrentSessionAtBottom({ viewportIntent: normalizedViewportIntent })) {
    scrollToBottom({ sessionId });
    pinMessageViewportToBottomForSessionEntry(sessionId);
  } else if (shouldOpenCurrentSessionFromTop({ sessionId, viewportIntent: normalizedViewportIntent })) {
    scrollCurrentSessionViewportToTop();
  } else if (
    normalizedViewportIntent === "session_entry"
    && shouldFocusLatestTurnStartOnSessionEntry(sessionId, latestTurnStart)
  ) {
    scrollNodeToTop(latestTurnStart);
  } else if (viewportAnchor) {
    markMessageViewportProgrammaticScroll();
    restoreMessageViewportAnchor(viewportAnchor, { sessionId, respectUserIntent: true });
  } else if (events.length > 0 && shouldStickToBottomAtResponse) {
    const spacer = typeof document !== "undefined" ? document.getElementById("turnViewportSpacer") : null;
    if (spacer && typeof syncTurnViewportSpacerOnGrowth === "function") {
      syncTurnViewportSpacerOnGrowth();
    } else {
      scrollToBottom({ minScrollTop: messagesEl.scrollTop });
    }
  }
  let olderPageEvents = [];
  let autofilledPages = 0;
  if (!hadRenderedTimeline && normalizedViewportIntent.startsWith("session_entry")) {
    // A session opens with two durable pages whenever history permits. This
    // gives a new reader immediate context before the scroll-triggered pager
    // needs to take over.
    try {
      olderPageEvents = await loadOlderSessionEvents({ forceFresh });
      autofilledPages = await autofillSessionHistoryViewport({ forceFresh });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      recordHistoryPagingFailure(error);
    }
    // Older-page prepending restores the reader's semantic anchor. A session
    // entry is different: after the initial context pages settle, the reader
    // must land on the newest message, not on the restored prepend anchor.
    if (
      shouldOpenCurrentSessionAtBottom({ viewportIntent: normalizedViewportIntent })
      && (olderPageEvents.length > 0 || autofilledPages > 0)
    ) {
      scrollToBottom({ sessionId, immediate: true });
      pinMessageViewportToBottomForSessionEntry(sessionId);
    }
  } else {
    // Refreshes for an already attached session can legitimately reuse the
    // current durable projection and skip fetchSessionEvents altogether. The
    // viewport still needs the same content-underflow check in that case.
    try {
      autofilledPages = await autofillSessionHistoryViewport({ forceFresh });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      recordHistoryPagingFailure(error);
    }
  }
  recordEventRefreshMetric({
    mode: "full",
    outcome: projected.items.length > 0 ? "applied" : "empty",
    renderMode: projected.items.length > 0
      ? "projected"
      : (events.length > 0 ? "empty_projection" : "empty"),
    requestMs: Math.max(0, nowPerfMs() - requestStartedAt),
    renderMs,
    payloadBytes: estimatePayloadBytes(data),
    eventCount: projected.items.length,
    latestSeq: projected.latestSeq,
    totalElapsedMs: Math.max(0, nowPerfMs() - requestStartedAt),
  });
  return events;
}

async function fetchSessionEvents(sessionId, options = {}) {
  const requestStartedAt = nowPerfMs();
  try {
    const events = await fetchSessionEventsInternal(sessionId, options);
    if (currentSessionId === sessionId) clearSessionLoadError(sessionId);
    return events;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const reason = classifySessionEventRefreshError(error);
    // A refresh that races an already rendered transcript (the periodic
    // refresh after a WebSocket reconnect, a superseded entry load) is a
    // soft failure: the reader is looking at a working session, so keep it
    // and let the next invalidation or user action re-sync instead of
    // declaring the whole session unloadable.
    const isSoftRenderedRefreshFailure = currentSessionId === sessionId
      && hasRenderedEventSnapshot(sessionId);
    if (currentSessionId === sessionId) {
      if (isSoftRenderedRefreshFailure) {
        console.warn("[events] Session refresh failed; keeping the rendered timeline:", {
          sessionId,
          reason,
          error: error?.message || String(error),
          errorCode: error?.code || "",
          requestId: error?.requestId || "",
        });
      } else if (showSessionLoadError(sessionId, error, reason)) {
        // dispatchAction owns the final attach failure path. Mark the error so
        // that it does not replace this specific event-load diagnosis with a
        // second generic session-load error.
        error.sessionLoadErrorShown = true;
      }
    }
    recordEventRefreshMetric({
      mode: "full",
      outcome: "failed",
      renderMode: "error",
      reason,
      errorCode: typeof error?.code === "string" ? error.code : "",
      eventCount: 0,
      totalElapsedMs: Math.max(0, nowPerfMs() - requestStartedAt),
    });
    if (!isSoftRenderedRefreshFailure) {
      console.error("[events] Failed to load session timeline:", {
        sessionId,
        reason,
        error: error?.message || String(error),
        errorCode: error?.code || "",
        requestId: error?.requestId || "",
      });
    }
    throw error;
  }
}

// Older history uses exactly the same projector operation as refresh. The
// only extra fact is the semantic viewport anchor captured before the request.
async function loadOlderSessionEvents({ forceFresh = false } = {}) {
  if (isShareSnapshotReadOnlyMode()) return [];
  const sessionId = currentSessionId;
  const snapshot = getTimelineRuntimeSnapshot(sessionId);
  if (!sessionId || !snapshot || snapshot.hasMoreBefore !== true) return [];
  if (renderedEventState.loadingOlder === true) return [];
  const beforeSeq = Number.isInteger(snapshot.nextBeforeSeq) ? snapshot.nextBeforeSeq : 0;
  if (beforeSeq < 2) return [];

  return scheduleSessionRefresh(`session:${sessionId}:events:older`, {
    intent: { forceFresh },
    run: async ({ signal }) => {
      renderedEventState.loadingOlder = true;
      // The scroll event and the wheel/touch intent event can be delivered in
      // either order by the browser. Prefer the stability snapshot recorded
      // by the same gesture; it carries the matching user-generation and
      // avoids rejecting the restore as a stale anchor.
      const stableAnchor = typeof getMessageViewportStabilitySnapshot === "function"
        ? getMessageViewportStabilitySnapshot()?.anchor
        : null;
      const anchor = stableAnchor?.sessionId === sessionId
        ? stableAnchor
        : captureMessageViewportAnchor({ sessionId });
      const prependViewportState = typeof captureMessageViewportPrependState === "function"
        ? captureMessageViewportPrependState({ sessionId, anchor })
        : null;
      const historyLoadingStartedAt = nowPerfMs();
      const historyLoadingToken = beginHistoryLoadingIndicator();
      try {
        const data = await fetchSessionVisibleEventsPage(sessionId, {
          direction: "before",
          beforeSeq,
          limit: SESSION_EVENT_PAGE_SIZE,
          forceFresh,
          signal,
        });
        if (signal?.aborted) return [];
        if (currentSessionId !== sessionId) return data?.events || [];
        const events = Array.isArray(data?.events) ? data.events : [];
        const responsePagination = data?.pagination && typeof data.pagination === "object"
          ? data.pagination
          : {};
        const responseCursor = Number.isInteger(responsePagination.nextBeforeSeq)
          ? responsePagination.nextBeforeSeq
          : (Number.isInteger(responsePagination.oldestSeq) ? responsePagination.oldestSeq : 0);
        const pagePagination = {
          ...responsePagination,
          nextBeforeSeq: responseCursor > 0 ? responseCursor : null,
          hasMoreBefore: responsePagination.hasMoreBefore === true
            && responseCursor > 0
            && responseCursor < beforeSeq,
        };
        // The reader may continue dragging while the request is in flight.
        // Re-capture immediately before the DOM commit so the explicit
        // compensation follows the latest user-owned position, not merely
        // the position that triggered the request.
        const commitViewportState = typeof captureMessageViewportPrependState === "function"
          ? captureMessageViewportPrependState({ sessionId })
          : null;
        const viewportStateForRestore = commitViewportState || prependViewportState;
        // Browser scroll anchoring and the explicit Android-style anchor
        // restore must not both compensate the same prepend. Disable native
        // anchoring only for this synchronous render/restore transaction.
        setMessageViewportPrependMode?.(true);
        const renderStartedAt = nowPerfMs();
        const projected = window.RagentTimelineRuntime?.renderBatch?.(events, {
          sessionId,
          runState: renderedEventState.runState,
          historyPrepend: true,
          paginationMode: "before",
          pagination: pagePagination,
          latestSeq: snapshot.latestSeq,
        });
        const renderMs = Math.max(0, nowPerfMs() - renderStartedAt);
        if (!projected) throw new Error("Timeline older-page projection failed");
        recordEventRefreshMetric({
          mode: "full",
          outcome: projected.items.length > 0 ? "older_applied" : "older_empty",
          renderMode: projected.items.length > 0 ? "prepend" : "empty",
          requestMs: Math.max(0, nowPerfMs() - historyLoadingStartedAt),
          renderMs,
          payloadBytes: estimatePayloadBytes(data),
          eventCount: events.length,
          latestSeq: projected.latestSeq,
          totalElapsedMs: Math.max(0, nowPerfMs() - historyLoadingStartedAt),
        });
        if (viewportStateForRestore && typeof restoreMessageViewportAfterPrepend === "function") {
          restoreMessageViewportAfterPrepend(viewportStateForRestore, { sessionId });
        } else if (anchor) {
          markMessageViewportProgrammaticScroll();
          restoreMessageViewportAnchor(anchor, { sessionId, respectUserIntent: true });
        }
        if (messagesInner.children.length === 0) showEmpty();
        syncMessageViewportStabilitySnapshot();
        return events;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        console.warn("[events-page] Failed to load older session events:", error?.message || error);
        return [];
      } finally {
        // Keep the explicit compensation authoritative through the current
        // paint. Later intrinsic layout changes are handled by ResizeObserver.
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => setMessageViewportPrependMode?.(false));
        } else {
          setMessageViewportPrependMode?.(false);
        }
        renderedEventState.loadingOlder = false;
        finishHistoryLoadingIndicator(historyLoadingToken);
      }
    },
  });
}

// History prepends are best-effort once the durable latest page is rendered:
// a failed prepend on a slow or flaky tunnel must not reclassify the whole
// session as unloadable. The scroll-triggered pager retries on the next
// underflow check, so degrade the failure to a metric + console note.
function recordHistoryPagingFailure(error) {
  recordEventRefreshMetric({
    mode: "full",
    outcome: "older_failed",
    renderMode: "error",
    reason: classifySessionEventRefreshError(error),
    eventCount: 0,
  });
  console.warn("[events] Session history paging failed; keeping the rendered page:", error?.message || error);
}

let messagesOlderLoadUserIntentUntil = 0;

function markMessagesOlderLoadUserIntent() {
  messagesOlderLoadUserIntentUntil = Date.now() + 2500;
}

function hasRecentMessagesOlderLoadUserIntent() {
  return Date.now() <= messagesOlderLoadUserIntentUntil;
}

function shouldLoadOlderSessionEventsFromScroll() {
  if (!messagesEl || !currentSessionId) return false;
  // A bottom pin or anchor restore can emit a late scroll event. Suppress
  // that synthetic event, but never suppress a real upward gesture that
  // starts during the short programmatic-scroll guard window.
  if (
    typeof isMessageViewportProgrammaticScroll === "function"
    && isMessageViewportProgrammaticScroll()
    && !hasRecentMessagesOlderLoadUserIntent()
  ) return false;
  if (isShareSnapshotReadOnlyMode()) return false;
  if (renderedEventState.sessionId !== currentSessionId) return false;
  if (renderedEventState.loadingOlder === true) return false;
  if (renderedEventState.hasMoreBefore !== true) return false;
  return messagesEl.scrollTop <= SESSION_EVENT_OLDER_SCROLL_THRESHOLD_PX;
}

function shouldAutofillSessionHistoryViewport() {
  if (!messagesEl || !currentSessionId) return false;
  if (isShareSnapshotReadOnlyMode()) return false;
  if (renderedEventState.sessionId !== currentSessionId) return false;
  if (renderedEventState.loadingOlder === true) return false;
  if (renderedEventState.hasMoreBefore !== true) return false;
  const clientHeight = Number(messagesEl.clientHeight) || 0;
  if (clientHeight <= 0) return false;
  const scrollHeight = Number(messagesEl.scrollHeight) || 0;
  return scrollHeight <= clientHeight + SESSION_EVENT_OLDER_SCROLL_THRESHOLD_PX;
}

async function autofillSessionHistoryViewport({ forceFresh = false } = {}) {
  let pagesLoaded = 0;
  while (pagesLoaded < SESSION_EVENT_AUTOFILL_MAX_PAGES && shouldAutofillSessionHistoryViewport()) {
    const previousBeforeSeq = Number(renderedEventState.nextBeforeSeq)
      || Number(renderedEventState.earliestSeq)
      || 0;
    const events = await loadOlderSessionEvents({ forceFresh });
    if (!Array.isArray(events) || events.length === 0) break;
    pagesLoaded += 1;
    const nextBeforeSeq = Number(renderedEventState.nextBeforeSeq)
      || Number(renderedEventState.earliestSeq)
      || 0;
    if (nextBeforeSeq >= previousBeforeSeq) break;
  }
  return pagesLoaded;
}

function scheduleAutofillSessionHistoryViewport({ forceFresh = false } = {}) {
  if (sessionHistoryAutofillFrame) return;
  const run = () => {
    sessionHistoryAutofillFrame = 0;
    autofillSessionHistoryViewport({ forceFresh }).catch(() => {});
  };
  if (typeof requestAnimationFrame === "function") {
    sessionHistoryAutofillFrame = requestAnimationFrame(run);
  } else if (typeof setTimeout === "function") {
    sessionHistoryAutofillFrame = setTimeout(run, 0);
  } else {
    run();
  }
}

let olderSessionLoadFrame = 0;

function scheduleOlderSessionEventsLoad() {
  if (olderSessionLoadFrame) return;
  const run = () => {
    olderSessionLoadFrame = 0;
    if (!shouldLoadOlderSessionEventsFromScroll()) return;
    loadOlderSessionEvents().catch(() => {});
  };
  if (typeof requestAnimationFrame === "function") {
    olderSessionLoadFrame = requestAnimationFrame(run);
  } else {
    olderSessionLoadFrame = setTimeout(run, 0);
  }
}

function setupOlderSessionEventScrollLoading() {
  if (!messagesEl || typeof messagesEl.addEventListener !== "function") return;
  messagesEl.addEventListener("wheel", markMessagesOlderLoadUserIntent, { passive: true });
  messagesEl.addEventListener("touchstart", markMessagesOlderLoadUserIntent, { passive: true });
  messagesEl.addEventListener("touchmove", markMessagesOlderLoadUserIntent, { passive: true });
  messagesEl.addEventListener("pointerdown", markMessagesOlderLoadUserIntent, { passive: true });
  messagesEl.addEventListener("keydown", (event) => {
    if (["ArrowUp", "PageUp", "Home", " "].includes(event?.key)) {
      markMessagesOlderLoadUserIntent();
    }
  });
  messagesEl.addEventListener("scroll", () => {
    scheduleOlderSessionEventsLoad();
  }, { passive: true });
}

setupOlderSessionEventScrollLoading();

async function runCurrentSessionRefresh(
  sessionId,
  {
    viewportIntent = hasAttachedSession ? "preserve" : "session_entry",
    forceFresh = false,
    signal = null,
    essential = false,
  } = {},
) {
  // First-open and idle sessions do not need the running-session delta dance.
  // Fetch their session state and bounded latest timeline as one coherent
  // snapshot so the UI cannot render a newer sidebar row with an older event
  // page, and so a foreground refresh spends one network round-trip instead
  // of two.  Active rendered sessions retain the delta path below because it
  // is cheaper than a latest-page fetch while a provider is streaming.
  const knownSession = typeof getChatStoreSession === "function"
    ? getChatStoreSession(sessionId)
    : (sessions.find((entry) => entry.id === sessionId) || null);
  const knownRunState = getSessionRunState(knownSession);
  const sessionSnapshotEnabled = window.__RAGENT_BOOTSTRAP__?.features?.sessionSnapshot === true;
  const useCombinedSnapshot = sessionSnapshotEnabled && !isShareSnapshotReadOnlyMode()
    && (knownRunState !== "running" || !hasRenderedEventSnapshot(sessionId));
  if (useCombinedSnapshot) {
    const snapshot = await fetchSessionSnapshot(sessionId, {
      forceFresh,
      signal,
      limit: SESSION_EVENT_PAGE_SIZE,
    });
    if (signal?.aborted) {
      const error = new Error("Session snapshot request was aborted");
      error.name = "AbortError";
      throw error;
    }
    const previous = typeof getChatStoreSession === "function"
      ? getChatStoreSession(sessionId)
      : (sessions.find((entry) => entry.id === sessionId) || null);
    const nextSession = normalizeSessionRecord(snapshot.session, previous);
    const sessionChanged = !previous
      || getComparableSessionStateSignature(previous) !== getComparableSessionStateSignature(nextSession);
    const session = sessionChanged
      ? (upsertSession(nextSession) || nextSession)
      : previous;
    if (!session) return null;
    if (currentSessionId !== sessionId) return session;
    stageSessionReviewedForAttachedSession(session);
    applyAttachedSessionState(sessionId, session);
    await fetchSessionEventsInternal(sessionId, {
      runState: getSessionRunState(session),
      viewportIntent,
      forceFresh,
      signal,
      prefetchedData: snapshot,
    });
    lastCurrentSessionRefreshAt = Date.now();
    lastCurrentSessionRefreshSessionId = sessionId;
    return session;
  }

  const session = await fetchSessionState(sessionId, { forceFresh, essential });
  // A cancelled/superseded state fetch (registry resolves it with null) must
  // not trigger a spurious events refresh on the stale path.
  if (!session) return null;
  if (currentSessionId !== sessionId) return session;
  // The registry aborted this request in favour of a newer one; stop here
  // instead of letting the already-aborted signal reject the events fetch.
  if (signal?.aborted) {
    const error = new Error("Session refresh was aborted");
    error.name = "AbortError";
    throw error;
  }
  const runState = getSessionRunState(session);
  if (shouldFetchSessionEventsForRefresh(sessionId, session)) {
    await fetchSessionEvents(sessionId, {
      runState,
      viewportIntent,
      forceFresh,
      ...(signal ? { signal } : {}),
    });
    return session;
  }
  renderedEventState.sessionId = sessionId;
  renderedEventState.runState = runState;
  if (typeof syncLiveMessageMetadataForRunState === "function") {
    syncLiveMessageMetadataForRunState(runState);
  }
  if (typeof syncEditableMessageActions === "function") {
    syncEditableMessageActions();
  }
  await autofillSessionHistoryViewport({ forceFresh }).catch((error) => {
    console.warn("[events-page] Failed to autofill the current session viewport:", error?.message || error);
  });
  return session;
}

async function refreshCurrentSession(
  {
    viewportIntent = hasAttachedSession ? "preserve" : "session_entry",
    forceFresh = false,
    essential = false,
  } = {},
) {
  const sessionId = currentSessionId;
  if (!sessionId) return null;
  const requestOptions = {
    ...mergeSessionRefreshOptions(
      { forceFresh: false, viewportIntent: hasAttachedSession ? "preserve" : "session_entry" },
      { forceFresh, viewportIntent },
    ),
  };
  // Single-flight per session via the request registry: a newer equal-strength
  // invalidation coalesces onto the running request, a stronger intent
  // (forceFresh / viewportIntent) supersedes it with an
  // abort+restart of the merged intent.
  return scheduleSessionRefresh(`session:${sessionId}:current`, {
    intent: requestOptions,
    essential,
    run: ({ signal }) => runCurrentSessionRefresh(sessionId, {
      ...requestOptions,
      signal,
      essential,
    }),
  });
}

async function refreshSidebarSession(sessionId, { forceFresh = false, essential = false } = {}) {
  if (!sessionId || visitorMode) return null;
  if (sessionId === currentSessionId) {
    return refreshCurrentSession({ forceFresh, essential });
  }
  return scheduleSessionRefresh(`session:${sessionId}:sidebar`, {
    intent: { forceFresh },
    essential,
    run: async ({ signal }) => {
      try {
        const session = await fetchSessionSidebar(sessionId, { forceFresh, signal });
        if (session) {
          renderSessionList();
        }
        return session;
      } catch (error) {
        if (error?.message === "Session not found") {
          const nextSessions = sessions.filter((session) => session.id !== sessionId);
          if (nextSessions.length !== sessions.length) {
            if (typeof removeChatSessionState === "function") {
              removeChatSessionState(sessionId, {
                compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
              });
            } else {
              sessions = nextSessions;
            }
            refreshAppCatalog();
            renderSessionList();
          }
          return null;
        }
        throw error;
      }
    },
  });
}

async function refreshRealtimeViews({
  viewportIntent = "preserve",
  forceFresh = false,
  refreshMode = "full",
  essential = false,
} = {}) {
  if (visitorMode) {
    if (currentSessionId) {
      await refreshCurrentSession({ viewportIntent, forceFresh, essential }).catch(() => {});
    }
    return;
  }

  const useForegroundPlan = refreshMode === "foreground";
  const shouldRefreshSessionsList = useForegroundPlan
    ? shouldRefreshForegroundSessionList({ forceFresh })
    : true;
  if (shouldRefreshSessionsList) {
    await fetchSessionsList({ forceFresh, essential }).catch(() => {});
  }
  if (pendingNavigationState) {
    restoreOwnerSessionSelection();
  }
  const shouldRefreshCurrent = useForegroundPlan
    ? shouldRefreshForegroundCurrentSession({ forceFresh })
    : Boolean(currentSessionId);
  if (currentSessionId && shouldRefreshCurrent) {
    await refreshCurrentSession({ viewportIntent, forceFresh, essential }).catch(() => {});
  }
}

function startParallelCurrentSessionBootstrap() {
  if (visitorMode || !currentSessionId) return;
  refreshCurrentSession({ viewportIntent: "session_entry_bottom", essential: true }).catch((error) => {
    if (error?.message === "Session not found") return;
    console.warn(
      "[sessions] Failed to bootstrap the current session in parallel:",
      error?.message || error,
    );
  });
}

async function bootstrapViaHttp({ deferOwnerRestore = false } = {}) {
  if (visitorMode && visitorSessionId) {
    if (typeof setChatCurrentSession === "function") {
      setChatCurrentSession(visitorSessionId, { hasAttachedSession: false });
    } else {
      currentSessionId = visitorSessionId;
    }
    attachSession(visitorSessionId, { id: visitorSessionId, name: "Session", status: "idle" });
    await refreshCurrentSession();
    return;
  }
  if (deferOwnerRestore) {
    startParallelCurrentSessionBootstrap();
  }
  await fetchSessionsList({ essential: true });
  if (!deferOwnerRestore) {
    restoreOwnerSessionSelection();
  }
}

async function bootstrapShareSnapshotView() {
  const session = buildShareSnapshotSessionRecord();
  if (!session) {
    showEmpty();
    return null;
  }
  const normalizedSession = normalizeSessionRecord(
    session,
    typeof getChatStoreSession === "function"
      ? getChatStoreSession(session.id)
      : (sessions.find((entry) => entry.id === session.id) || null),
  );
  if (typeof replaceChatState === "function") {
    replaceChatState({
      sessions: [normalizedSession],
      hasLoadedSessions: true,
      archivedSessionCount: 0,
      archivedSessionsLoaded: false,
      archivedSessionsLoading: false,
      currentSessionId: session.id,
      hasAttachedSession: false,
    }, {
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  } else {
    sessions = [normalizedSession];
    hasLoadedSessions = true;
    archivedSessionCount = 0;
    archivedSessionsLoaded = false;
    currentSessionId = session.id;
  }
  visitorSessionId = session.id;
  attachSession(session.id, normalizedSession);
  return normalizedSession;
}

async function setupPushNotifications() {
  const ownerPushFeaturesEnabled = typeof shouldEnableOwnerPushFeatures === "function"
    ? shouldEnableOwnerPushFeatures()
    : !visitorMode;
  if (!ownerPushFeaturesEnabled) return;
  if (!("PushManager" in window)) return;
  try {
    const persistSubscription = async (subscription) => {
      const payload = subscription?.toJSON ? subscription.toJSON() : subscription;
      if (!payload?.endpoint) return;
      const subscribeUrl = typeof window.ragentResolveProductPath === "function"
        ? window.ragentResolveProductPath("/api/push/subscribe")
        : "/api/push/subscribe";
      await fetch(subscribeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    };
    const reg = await ensureServiceWorkerRegistration();
    if (!reg) return;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await persistSubscription(existing);
      return;
    }
    const vapidPublicKeyUrl = typeof window.ragentResolveProductPath === "function"
      ? window.ragentResolveProductPath("/api/push/vapid-public-key")
      : "/api/push/vapid-public-key";
    const res = await fetch(vapidPublicKeyUrl);
    if (!res.ok) return;
    const { publicKey } = await res.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await persistSubscription(sub);
    console.log("[push] Subscribed to web push");
  } catch (err) {
    console.warn("[push] Setup failed:", err.message);
  }
}

async function ensureServiceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const serviceWorkerUrl = typeof window.ragentResolveProductPath === "function"
      ? window.ragentResolveProductPath(`/sw.js?v=${encodeURIComponent(buildAssetVersion)}`)
      : `/sw.js?v=${encodeURIComponent(buildAssetVersion)}`;
    const reg = await navigator.serviceWorker.register(
      serviceWorkerUrl,
      { updateViaCache: "none" },
    );
    await reg.update().catch(() => {});
    reg.installing?.postMessage({ type: "ragent:clear-caches" });
    reg.waiting?.postMessage({ type: "ragent:clear-caches" });
    reg.active?.postMessage({ type: "ragent:clear-caches" });
    await navigator.serviceWorker.ready.catch(() => {});
    return reg;
  } catch (err) {
    console.warn("[sw] Setup failed:", err.message);
    return null;
  }
}
