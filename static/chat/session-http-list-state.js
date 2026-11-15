function mergeUniqueSessions(entries = []) {
  const merged = [];
  const seenIds = new Set();
  for (const entry of entries) {
    if (!entry?.id || seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

function shouldPreserveCurrentSessionAcrossListRefresh(session) {
  return session?.id
    && session.id === currentSessionId
    && session.isInternalSession === true;
}

function applySessionListState(nextSessions, {
  archivedCount: nextArchivedCount = archivedSessionCount,
} = {}) {
  const previousArchivedCount = Number.isInteger(archivedSessionCount) && archivedSessionCount >= 0
    ? archivedSessionCount
    : 0;
  const previousCurrentSessionId = currentSessionId;
  const hadLoadedSessions = hasLoadedSessions === true;
  const previousSignature = typeof getComparableSessionStateSignature === "function"
    ? getComparableSessionStateSignature({ archivedCount: previousArchivedCount, sessions })
    : "";
  const previousMap = new Map(sessions.map((session) => [session.id, session]));
  const activeSessions = (Array.isArray(nextSessions) ? nextSessions : [])
    .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
    .filter(Boolean);
  const previousCurrentSession = previousCurrentSessionId ? previousMap.get(previousCurrentSessionId) : null;
  if (
    shouldPreserveCurrentSessionAcrossListRefresh(previousCurrentSession)
    && !activeSessions.some((session) => session?.id === previousCurrentSession.id)
  ) {
    activeSessions.push(previousCurrentSession);
  }
  const pendingSessionId = typeof pendingNavigationState === "object" && pendingNavigationState?.sessionId
    ? pendingNavigationState.sessionId
    : null;
  const transitioningSessionId = pendingSessionId
    || (currentSessionId && typeof hasAttachedSession === "boolean" && !hasAttachedSession ? currentSessionId : null);
  if (transitioningSessionId && !activeSessions.some((session) => session?.id === transitioningSessionId)) {
    const transitioningSession = previousMap.get(transitioningSessionId)
      || (typeof getChatStoreSession === "function" ? getChatStoreSession(transitioningSessionId) : null)
      || { id: transitioningSessionId };
    activeSessions.push(transitioningSession);
  }
  if (typeof replaceActiveChatSessionsState === "function") {
    replaceActiveChatSessionsState(activeSessions, {
      archivedCount: Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0
        ? nextArchivedCount
        : archivedSessionCount,
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  } else {
    sessions = mergeUniqueSessions(activeSessions);
    sortSessionsInPlace();
    hasLoadedSessions = true;
    if (Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0) {
      archivedSessionCount = nextArchivedCount;
    }
  }
  const nextSignature = typeof getComparableSessionStateSignature === "function"
    ? getComparableSessionStateSignature({ archivedCount: archivedSessionCount, sessions })
    : "";
  refreshAppCatalog();
  if (!hadLoadedSessions || previousSignature !== nextSignature) {
    if (typeof scheduleSessionListRender === "function") scheduleSessionListRender();
    else renderSessionList();
  }
  // The project overview re-renders from the store on every state application,
  // even when the classic list render above is suppressed (e.g. a boot restore
  // matching the fetched signature). Without this, L1 keeps the zero counts of
  // its pre-load first render until some manual re-render happens.
  if (typeof refreshProjectsView === "function") {
    refreshProjectsView();
  }
  // Notify on a background session that just turned "needs action". Skipped on
  // the cold-start load (hadLoadedSessions) so a page open with several waiting
  // sessions does not fire a burst; dedup + transition check guard every later
  // refresh.
  if (hadLoadedSessions && typeof window.RagentApprovalNotify?.onSessionsApplied === "function") {
    try { window.RagentApprovalNotify.onSessionsApplied(previousMap, activeSessions); } catch {}
  }
  if (hadLoadedSessions && typeof window.RagentAttentionPopup?.onSessionsApplied === "function") {
    try { window.RagentAttentionPopup.onSessionsApplied(previousMap, activeSessions); } catch {}
  }
  if (previousCurrentSessionId && !currentSessionId) {
    if (typeof resetAttachedSessionRenderState === "function") {
      resetAttachedSessionRenderState();
    }
    clearMessages();
    showEmpty();
    restoreDraft();
  }
  return sessions;
}

function applyArchivedSessionListState(nextSessions, {
  archivedCount: nextArchivedCount = null,
} = {}) {
  const previousArchivedCount = Number.isInteger(archivedSessionCount) && archivedSessionCount >= 0
    ? archivedSessionCount
    : 0;
  const hadArchivedSessionsLoaded = archivedSessionsLoaded === true;
  const previousSignature = typeof getComparableSessionStateSignature === "function"
    ? getComparableSessionStateSignature({ archivedCount: previousArchivedCount, sessions })
    : "";
  const previousMap = new Map(sessions.map((session) => [session.id, session]));
  const archivedSessions = (Array.isArray(nextSessions) ? nextSessions : [])
    .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
    .filter(Boolean);
  if (typeof replaceArchivedChatSessionsState === "function") {
    replaceArchivedChatSessionsState(archivedSessions, {
      archivedCount: Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0
        ? nextArchivedCount
        : archivedSessions.length,
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  } else {
    sessions = mergeUniqueSessions(archivedSessions);
    sortSessionsInPlace();
    archivedSessionsLoaded = true;
    archivedSessionsLoading = false;
    archivedSessionCount = Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0
      ? nextArchivedCount
      : archivedSessions.length;
  }
  const nextSignature = typeof getComparableSessionStateSignature === "function"
    ? getComparableSessionStateSignature({ archivedCount: archivedSessionCount, sessions })
    : "";
  refreshAppCatalog();
  if (!hadArchivedSessionsLoaded || previousSignature !== nextSignature) {
    if (typeof scheduleSessionListRender === "function") scheduleSessionListRender();
    else renderSessionList();
  }
  return archivedSessions;

}
