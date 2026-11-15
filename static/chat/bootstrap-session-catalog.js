function createEmptySessionStatus() {
  return sessionStateModel.createEmptyStatus();
}

function getSessionActivity(session) {
  return sessionStateModel.normalizeSessionActivity(session);
}

function isSessionBusy(session) {
  return sessionStateModel.isSessionBusy(session);
}

function getSessionStatusSummary(session, { includeToolFallback = false } = {}) {
  return sessionStateModel.getSessionStatusSummary(session, { includeToolFallback });
}

function getSessionVisualStatus(session, options = {}) {
  if (typeof sessionStateModel.getSessionVisualStatus === "function") {
    return sessionStateModel.getSessionVisualStatus(session, options);
  }
  return getSessionStatusSummary(session, options).primary;
}

function refreshSessionAttentionUi(sessionId = currentSessionId) {
  if (typeof renderSessionList === "function") {
    renderSessionList();
  }
  if (
    sessionId
    && sessionId === currentSessionId
    && typeof updateStatus === "function"
    && typeof getCurrentSession === "function"
  ) {
    const session = getCurrentSession();
    updateStatus("connected", session);
  }
}

// Thinking block state
let currentThinkingBlock = null; // { el, body, tools: Set }
let inThinkingBlock = false;

// The source filter UI was removed (the funnel button now opens Settings), so
// the session list always renders unfiltered.
let activeSourceFilter = FILTER_ALL_VALUE;

function registerHiddenMarkdownExtensions() {
  const hiddenTagStart = /<(private|hide)\b/i;
  const hiddenBlockPattern = /^(?: {0,3})<(private|hide)\b[^>]*>[\s\S]*?<\/\1>(?:\n+|$)/i;
  const hiddenInlinePattern = /^<(private|hide)\b[^>]*>[\s\S]*?<\/\1>/i;
  // Keep rendered conversation text aligned with Typora: a normal Enter is a
  // visible soft line break, while a blank line still starts a new paragraph.
  marked.setOptions?.({ gfm: true, breaks: true });
  marked.use({
    extensions: [
      {
        name: "hiddenUiBlock",
        level: "block",
        start(src) {
          const match = src.match(hiddenTagStart);
          return match ? match.index : undefined;
        },
        tokenizer(src) {
          const match = src.match(hiddenBlockPattern);
          if (!match) return undefined;
          return { type: "hiddenUiBlock", raw: match[0] };
        },
        renderer() {
          return "";
        },
      },
      {
        name: "hiddenUiInline",
        level: "inline",
        start(src) {
          const match = src.match(hiddenTagStart);
          return match ? match.index : undefined;
        },
        tokenizer(src) {
          const match = src.match(hiddenInlinePattern);
          if (!match) return undefined;
          return { type: "hiddenUiInline", raw: match[0] };
        },
        renderer() {
          return "";
        },
      },
    ],
  });
}

const POST_INSTALL_NOTIFICATION_STORAGE_KEY = "ragent.mobileInstall.requestNotifications";

function isStandaloneContext() {
  return !!(
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches)
    || navigator.standalone === true
  );
}

function shouldPromptForInstalledNotifications() {
  if (!isStandaloneContext()) return false;
  try {
    return localStorage.getItem(POST_INSTALL_NOTIFICATION_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function clearInstalledNotificationPromptFlag() {
  try {
    localStorage.removeItem(POST_INSTALL_NOTIFICATION_STORAGE_KEY);
  } catch {}
}

function isOwnerPushFeatureEnabled() {
  return typeof shouldEnableOwnerPushFeatures === "function"
    ? shouldEnableOwnerPushFeatures()
    : !visitorMode;
}

function shouldPersistNavigationState() {
  return typeof shouldPersistOwnerNavigationState === "function"
    ? shouldPersistOwnerNavigationState()
    : !visitorMode;
}

function isAgentScopedUiMode() {
  return typeof isAgentScopedMode === "function"
    ? isAgentScopedMode()
    : false;
}

function initializePushNotifications(options = {}) {
  if (!isOwnerPushFeatureEnabled() || !("Notification" in window)) return;
  const shouldPrompt = options.prompt === true;
  if (Notification.permission === "default") {
    if (!shouldPrompt) return;
    Notification.requestPermission().then((perm) => {
      clearInstalledNotificationPromptFlag();
      if (perm === "granted" && isOwnerPushFeatureEnabled()) setupPushNotifications();
    });
  } else if (Notification.permission === "granted") {
    if (shouldPrompt) clearInstalledNotificationPromptFlag();
    setupPushNotifications();
  } else if (shouldPrompt) {
    clearInstalledNotificationPromptFlag();
  }
}

registerHiddenMarkdownExtensions();

function persistActiveSessionId(sessionId) {
  if (!shouldPersistNavigationState()) return;
  if (sessionId) {
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
  } else {
    localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  }
}

function persistActiveSidebarTab(tab) {
  if (!shouldPersistNavigationState()) return;
  localStorage.setItem(
    ACTIVE_SIDEBAR_TAB_STORAGE_KEY,
    normalizeSidebarTab(tab),
  );
}

function buildNavigationUrl(state = {}) {
  const nextSessionId =
    state.sessionId === undefined ? currentSessionId : state.sessionId;
  const nextTab = normalizeSidebarTab(
    state.tab === undefined
      ? (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : activeTab)
      : state.tab,
  );
  const url = new URL(window.location.href);
  url.searchParams.delete("visitor");
  url.searchParams.delete("source");
  if (nextSessionId) url.searchParams.set("session", nextSessionId);
  else url.searchParams.delete("session");
  if (nextTab === "settings") {
    url.searchParams.set("tab", nextTab);
  } else {
    url.searchParams.delete("tab");
  }
  return `${url.pathname}${url.search}`;
}

const SESSION_NAVIGATION_STATE_KEY = "ragentSessionNavigation";
let sessionNavigationGeneration = 0;
let sessionNavigationTargetId = "";

function beginSessionNavigation(sessionId = "") {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  sessionNavigationGeneration += 1;
  sessionNavigationTargetId = normalizedSessionId;
  if (String(typeof currentSessionId === "string" ? currentSessionId : "").trim() !== normalizedSessionId) {
    window.RagentDecisionSheet?.suspend?.();
  }
  // Advance the generation immediately so late events are rejected, but defer
  // clearing the visible decision state until attachSession marks the target
  // as not-yet-attached. That keeps the old sheet from starting a 180ms close
  // animation before the session transition has even begun.
  window.RagentDecisions?.beginSessionContext?.(normalizedSessionId, sessionNavigationGeneration, { resetState: false });
  return {
    generation: sessionNavigationGeneration,
    sessionId: normalizedSessionId,
  };
}

function invalidateSessionNavigation() {
  return beginSessionNavigation("");
}

function isSessionNavigationCurrent(generation, sessionId = "") {
  const normalizedGeneration = Number(generation) || 0;
  if (normalizedGeneration < 1) return true;
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  return normalizedGeneration === sessionNavigationGeneration
    && (!normalizedSessionId || normalizedSessionId === sessionNavigationTargetId);
}

function getSessionNavigationGeneration() {
  return sessionNavigationGeneration;
}

window.getSessionNavigationGeneration = getSessionNavigationGeneration;

function buildSessionNavigationHistoryState(sessionId, tab, baseState = null) {
  return {
    ...(baseState && typeof baseState === "object" ? baseState : {}),
    [SESSION_NAVIGATION_STATE_KEY]: true,
    sessionId: typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null,
    tab: normalizeSidebarTab(tab),
  };
}

function syncBrowserState(state = {}) {
  const nextSessionId =
    state.sessionId === undefined ? currentSessionId : state.sessionId;
  const historyMode = state.historyMode === "push" ? "push" : "replace";
  const nextTab = normalizeSidebarTab(
    state.tab === undefined
      ? (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : activeTab)
      : state.tab,
  );
  if (shouldPersistNavigationState()) {
    persistActiveSessionId(nextSessionId);
    persistActiveSidebarTab(nextTab);
  }
  const nextUrl = buildNavigationUrl({
    sessionId: nextSessionId,
    tab: nextTab,
  });
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  const currentHistoryState = history.state && typeof history.state === "object"
    ? history.state
    : null;
  // A drawer/popover may temporarily annotate the current history entry with
  // backEntryId. Navigation creates a new application state entry; carrying
  // that overlay marker forward makes closing the drawer call history.back()
  // and undo the session the user just selected.
  const navigationBaseHistoryState = currentHistoryState
    ? { ...currentHistoryState }
    : null;
  if (navigationBaseHistoryState) {
    delete navigationBaseHistoryState.backEntryId;
  }
  const isSameSessionHistoryEntry = currentHistoryState?.[SESSION_NAVIGATION_STATE_KEY] === true
    && (currentHistoryState.sessionId || null) === (nextSessionId || null)
    && normalizeSidebarTab(currentHistoryState.tab) === nextTab;
  const shouldPush = historyMode === "push" && !isSameSessionHistoryEntry;
  if (nextUrl !== currentUrl || shouldPush || currentHistoryState?.[SESSION_NAVIGATION_STATE_KEY] !== true) {
    const nextHistoryState = buildSessionNavigationHistoryState(
      nextSessionId,
      nextTab,
      navigationBaseHistoryState,
    );
    if (shouldPush) {
      history.pushState(nextHistoryState, "", nextUrl);
    } else {
      history.replaceState(nextHistoryState, "", nextUrl);
    }
  }
}

function normalizeSourceId(sourceId, { fallbackDefault = false } = {}) {
  const trimmed = typeof sourceId === "string" ? sourceId.trim() : "";
  if (!trimmed) {
    return fallbackDefault ? DEFAULT_APP_ID : "";
  }
  const normalizedDefault = trimmed.toLowerCase();
  if (normalizedDefault === DEFAULT_APP_ID) return DEFAULT_APP_ID;
  return trimmed;
}

function formatSourceNameFromId(sourceId) {
  const normalized = normalizeSourceId(sourceId);
  if (!normalized) return DEFAULT_APP_NAME;
  if (normalized === DEFAULT_APP_ID) return DEFAULT_APP_NAME;
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getEffectiveSessionSourceId(session) {
  return normalizeSourceId(session?.sourceId, { fallbackDefault: true });
}

function getEffectiveSessionSourceName(session) {
  const explicitSourceName = typeof session?.sourceName === "string"
    ? session.sourceName.trim()
    : "";
  if (explicitSourceName) return explicitSourceName;

  return formatSourceNameFromId(getEffectiveSessionSourceId(session));
}

function isDelegatedSessionForFilter(session) {
  if (!session) return false;
  if (session.isDelegatedSession === true) return true;
  if (typeof session.parentSessionId === "string" && session.parentSessionId.trim()) return true;
  if (typeof session.delegatedFromSessionId === "string" && session.delegatedFromSessionId.trim()) return true;
  return Number.isFinite(session.delegationDepth) && session.delegationDepth > 0;
}

function isRobotSessionForFilter(session, sourceId) {
  if (!session) return false;
  if (session.isInternalSession === true) return true;
  if (typeof session.internalRole === "string" && session.internalRole.trim()) return true;
  return sourceId !== DEFAULT_APP_ID;
}

// The sidebar is a Root surface. Delegated child sessions remain addressable by
// their direct route and by the parent/organization projections, but never
// become a second top-level navigation item.
function isRootSessionForPrimaryList(session) {
  if (!session) return false;
  if (session.isRootSession === false || session.sessionHierarchy?.isRoot === false) return false;
  if (typeof session.parentSessionId === "string" && session.parentSessionId.trim()) return false;
  if (typeof session.delegatedFromSessionId === "string" && session.delegatedFromSessionId.trim()) return false;
  const isFork = typeof session.forkedFromSessionId === "string"
    && session.forkedFromSessionId.trim();
  const rootSessionId = typeof session.rootSessionId === "string" ? session.rootSessionId.trim() : "";
  if (rootSessionId && session.id && rootSessionId !== session.id && !isFork) return false;
  const category = typeof session.sessionCategory === "string" ? session.sessionCategory.trim() : "";
  if (category && category !== "root") return false;
  return true;
}

function getSessionSourceCategory(session) {
  const sourceId = getEffectiveSessionSourceId(session);
  if (isDelegatedSessionForFilter(session)) return SOURCE_FILTER_CHILD_VALUE;
  if (isRobotSessionForFilter(session, sourceId)) return SOURCE_FILTER_BOT_VALUE;
  if (sourceId === DEFAULT_APP_ID) return SOURCE_FILTER_CHAT_VALUE;
  return SOURCE_FILTER_CHAT_VALUE;
}

// Catalog refresh hook kept as a no-op: it previously re-rendered the source
// filter options, and callers still treat it as a session-catalog sync point.
function refreshAppCatalog() {}

function getFilteredActiveSessions({ ignoreSource = false, includeAllProjects = false } = {}) {
  return getActiveSessions({ includeAllProjects }).filter((session) => (
    ignoreSource || matchesSourceFilter(session, activeSourceFilter)
  ));
}

function matchesSourceFilter(session, sourceFilter = activeSourceFilter) {
  if (sourceFilter === FILTER_ALL_VALUE) return true;
  return getSessionSourceCategory(session) === sourceFilter;
}

function matchesSearchQuery(session) {
  if (!sessionSearchQuery) return true;
  const query = sessionSearchQuery.toLowerCase();
  const searchable = [
    session?.name,
    session?.group,
    session?.description,
    session?.tool,
    session?.model,
    session?.sourceId,
    session?.sourceName,
    typeof getEffectiveSessionSourceName === "function" ? getEffectiveSessionSourceName(session) : "",
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  return searchable.includes(query);
}

function matchesCurrentFilters(session) {
  return matchesSourceFilter(session, activeSourceFilter) && matchesSearchQuery(session);
}

function getVisibleActiveSessions() {
  return getActiveSessions().filter((session) => !session.pinned && matchesCurrentFilters(session));
}

function getVisiblePinnedSessions() {
  return getActiveSessions().filter((session) => session.pinned === true && matchesCurrentFilters(session));
}

function getVisibleArchivedSessions() {
  return getArchivedSessions().filter((session) => matchesCurrentFilters(session));
}

refreshAppCatalog();

function getSessionSortTime(session) {
  if (typeof sessionStateModel.getSessionSortTime === "function") {
    return sessionStateModel.getSessionSortTime(session);
  }
  const stamp = Object.prototype.hasOwnProperty.call(session || {}, "lastActivityAt")
    ? (session?.lastActivityAt ?? session?.updatedAt ?? session?.created ?? "")
    : (session?.lastEventAt || session?.updatedAt || session?.created || "");
  const time = new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getSessionPinSortRank(session) {
  return session?.pinned === true ? 1 : 0;
}

function compareSessionListSessions(a, b) {
  const displayA = typeof getSessionSidebarListSnapshot === "function"
    ? (getSessionSidebarListSnapshot(a) || a)
    : a;
  const displayB = typeof getSessionSidebarListSnapshot === "function"
    ? (getSessionSidebarListSnapshot(b) || b)
    : b;
  if (typeof sessionStateModel.compareSessionListSessions === "function") {
    return sessionStateModel.compareSessionListSessions(displayA, displayB);
  }
  return getSessionSortTime(displayB) - getSessionSortTime(displayA);
}

function compareClientSessions(a, b) {
  const displayA = typeof getSessionSidebarListSnapshot === "function"
    ? (getSessionSidebarListSnapshot(a) || a)
    : a;
  const displayB = typeof getSessionSidebarListSnapshot === "function"
    ? (getSessionSidebarListSnapshot(b) || b)
    : b;
  return getSessionPinSortRank(displayB) - getSessionPinSortRank(displayA)
    || compareSessionListSessions(displayA, displayB);
}

function sortSessionsInPlace() {
  const compare = typeof compareClientSessions === "function"
    ? compareClientSessions
    : ((a, b) => getSessionPinSortRank(b) - getSessionPinSortRank(a)
      || compareSessionListSessions(a, b));
  sessions.sort(compare);
}

function getArchivedSessionSortTime(session) {
  const hasActivityStamp = Object.prototype.hasOwnProperty.call(session || {}, "lastActivityAt");
  const stamp = session?.archivedAt
    || (hasActivityStamp
      ? (session?.lastActivityAt ?? session?.updatedAt ?? session?.created ?? "")
      : (session?.lastEventAt || session?.updatedAt || session?.created || ""));
  const time = new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function shouldShowSessionInPrimaryList(session) {
  if (!session) return false;
  return session.isInternalSession !== true || session.id === currentSessionId;
}

function getActiveSessions({ includeAllProjects = false } = {}) {
  return sessions
    .map((session) => (
      typeof getSessionSidebarListSnapshot === "function"
        ? (getSessionSidebarListSnapshot(session) || session)
        : session
    ))
    .filter((session) => session && !session.archived)
    .filter(shouldShowSessionInPrimaryList)
    .filter(isRootSessionForPrimaryList)
    .filter((session) => {
      // The two-level project navigation is cross-project: its first level
      // groups every project and the second level scopes by the browsed
      // project, so it must see the full catalog rather than only the
      // currently selected project's sessions.
      if (includeAllProjects) return true;
      return typeof window.ragentSessionMatchesSelectedWorkspace === "function"
        ? window.ragentSessionMatchesSelectedWorkspace(session)
        : true;
    });
}

function getArchivedSessions() {
  return sessions
    .map((session) => (
      typeof getSessionSidebarListSnapshot === "function"
        ? (getSessionSidebarListSnapshot(session) || session)
        : session
    ))
    .filter((session) => session && session.archived)
    .filter(shouldShowSessionInPrimaryList)
    .filter(isRootSessionForPrimaryList)
    .filter((session) => (
      typeof window.ragentSessionMatchesSelectedWorkspace === "function"
        ? window.ragentSessionMatchesSelectedWorkspace(session)
        : true
    ))
    .slice()
    .sort((a, b) => getArchivedSessionSortTime(b) - getArchivedSessionSortTime(a));
}

function getLatestSession() {
  return sessions[0] || null;
}

function getLatestActiveSession() {
  return sessions.find((session) => !session.archived) || null;
}

function getLatestSessionForCurrentFilters() {
  return sessions.find((session) => matchesCurrentFilters(session)) || null;
}

function getLatestActiveSessionForCurrentFilters() {
  return sessions.find(
    (session) => !session.archived && matchesCurrentFilters(session),
  ) || null;
}

function resolveRestoreTargetSession() {
  if (pendingNavigationState?.sessionId) {
    const requested = sessions.find(
      (session) => session.id === pendingNavigationState.sessionId,
    );
    if (requested) return requested;
  }
  if (currentSessionId) {
    const current = sessions.find((session) => session.id === currentSessionId);
    if (current && matchesCurrentFilters(current)) return current;
  }
  // A clean owner entry stays on Home until the user explicitly chooses work.
  // This prevents a stale local/session list item from bypassing the
  // notification-driven overview on mobile and desktop alike.
  return null;
}

function clearCurrentSessionForNavigation() {
  invalidateSessionNavigation();
  const previousSessionId = currentSessionId;
  if (previousSessionId && typeof abortSessionRefreshRequests === "function") {
    abortSessionRefreshRequests(previousSessionId);
  }
  if (previousSessionId && typeof settleAttachedSessionSidebarState === "function") {
    Promise.resolve(settleAttachedSessionSidebarState({
      sessionId: previousSessionId,
      sync: true,
      render: false,
    })).catch(() => {});
  }
  if (typeof setChatCurrentSession === "function") {
    setChatCurrentSession(null, { hasAttachedSession: false });
  } else {
    currentSessionId = null;
    hasAttachedSession = false;
  }
  if (typeof resetAttachedSessionRenderState === "function") {
    resetAttachedSessionRenderState();
  }
  if (typeof persistActiveSessionId === "function") {
    persistActiveSessionId(null);
  }
  pendingNavigationState = null;
  if (typeof showEmpty === "function") showEmpty();
  if (typeof restoreDraft === "function") restoreDraft();
  if (typeof updateStatus === "function") updateStatus("connected");
}

function navigateHomeFromUi({ historyMode = "push" } = {}) {
  clearCurrentSessionForNavigation();
  syncBrowserState({
    sessionId: null,
    tab: "sessions",
    historyMode,
  });
  return true;
}

function handleSessionNavigationPopState(event) {
  if (window.RagentBackHandler?.wasLastPopstateHandled?.()) return;
  const state = event?.state;
  if (!state?.[SESSION_NAVIGATION_STATE_KEY]) return;
  if (state.sessionId) {
    applyNavigationState({
      sessionId: state.sessionId,
      tab: state.tab || "sessions",
    }, { historyMode: "replace" });
  } else {
    navigateHomeFromUi({ historyMode: "replace" });
  }
}

function initializeSessionNavigationHistory() {
  if (typeof window === "undefined" || typeof history === "undefined") return;
  if (visitorMode || shareSnapshotMode) return;
  const currentHistoryState = history.state && typeof history.state === "object"
    ? history.state
    : null;
  const locationState = readNavigationStateFromLocation();
  const initialSessionId = locationState.sessionId || currentSessionId || null;
  const initialTab = locationState.tab
    || (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : "sessions");
  const currentUrl = `${window.location.pathname}${window.location.search}`;

  if (currentHistoryState?.[SESSION_NAVIGATION_STATE_KEY] === true) {
    window.addEventListener("popstate", handleSessionNavigationPopState);
    return;
  }

  if (initialSessionId) {
    const homeUrl = buildNavigationUrl({ sessionId: null, tab: "sessions" });
    history.replaceState(
      buildSessionNavigationHistoryState(null, "sessions", currentHistoryState),
      "",
      homeUrl,
    );
    history.pushState(
      buildSessionNavigationHistoryState(initialSessionId, initialTab, currentHistoryState),
      "",
      currentUrl,
    );
  } else {
    history.replaceState(
      buildSessionNavigationHistoryState(null, initialTab, currentHistoryState),
      "",
      currentUrl,
    );
  }
  window.addEventListener("popstate", handleSessionNavigationPopState);
}

function applyNavigationState(rawState, { historyMode = "push" } = {}) {
  const next = normalizeNavigationState(rawState);
  if (next.tab) {
    switchTab(next.tab, { syncState: false });
  }
  pendingNavigationState = next.sessionId ? next : null;
  if (next.sessionId) {
    if (typeof navigateToSession === "function") {
      void navigateToSession(next.sessionId, {
        session: sessions.find((session) => session.id === next.sessionId) || null,
        tab: next.tab || (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : activeTab),
        historyMode,
        forceFresh: true,
      }).catch((error) => {
        if (isSessionNavigationCurrent(sessionNavigationGeneration, next.sessionId)) {
          console.warn("[sessions] Failed to restore requested session:", error?.message || error);
        }
      });
      return;
    }
    const target = sessions.find((session) => session.id === next.sessionId);
    if (target) {
      attachSession(target.id, target);
      pendingNavigationState = null;
    } else {
      dispatchAction({ action: "list" });
    }
    syncBrowserState({
      sessionId: next.sessionId,
      tab: next.tab || (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : activeTab),
      historyMode,
    });
    return;
  }
  if (historyMode === "replace") {
    navigateHomeFromUi({ historyMode: "replace" });
    return;
  }
  syncBrowserState({
    sessionId: null,
    tab: next.tab || (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : activeTab),
    historyMode,
  });
}

window.ragentNavigateHome = navigateHomeFromUi;
document.getElementById("homeBtn")?.addEventListener("click", () => {
  navigateHomeFromUi();
});
initializeSessionNavigationHistory();
function t(key, vars) {
  return window.ragentT ? window.ragentT(key, vars) : key;
}
