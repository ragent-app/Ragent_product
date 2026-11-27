// ---- Session list ----
function t(key, vars) {
  return window.ragentT ? window.ragentT(key, vars) : key;
}

// Inbox view: attention-band labels
const INBOX_BANDS = [
  { band: 0, key: "inbox:unread-waiting", label: "Needs your attention" },
  { band: 1, key: "inbox:unread", label: "New updates" },
  { band: 2, key: "inbox:waiting", label: "Waiting on you" },
  { band: 3, key: "inbox:active", label: "Active" },
  { band: 4, key: "inbox:running", label: "Running" },
  { band: 5, key: "inbox:parked", label: "Parked" },
  { band: 6, key: "inbox:done", label: "Done" },
];

function getInboxBandForSession(session) {
  if (typeof window.RagentSessionStateModel?.getSessionAttentionBand === "function") {
    return window.RagentSessionStateModel.getSessionAttentionBand(session);
  }
  return 3;
}

// ---- Session list FLIP: animate in-place reorders/status moves ----
// Every list render rebuilds the section containers (pinned-items /
// folder-group-items / archived-items), so items are matched across rebuilds
// by (container class, data-session-id). Moves across containers (e.g. pinned
// -> unified) intentionally do not animate in v1. The hook lives entirely
// inside renderSessionList and degrades to a plain rebuild on any failure.
const FLIP_TRANSITION_DURATION_MS = 220;
const FLIP_TRANSITION_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const FLIP_MAX_SNAPSHOT_ITEMS = 48;

let sessionListRenderFrame = 0;
let sessionListRenderQueued = false;
let sessionListScrollGuardAttached = false;

function ensureSessionListScrollGuard() {
  if (sessionListScrollGuardAttached || !sessionList) return;
  sessionListScrollGuardAttached = true;
  let scrollStopTimer = 0;
  sessionList.addEventListener("scroll", () => {
    sessionList.dataset.userScrolling = "true";
    clearTimeout(scrollStopTimer);
    scrollStopTimer = setTimeout(() => {
      delete sessionList.dataset.userScrolling;
    }, 120);
  }, { passive: true });
}

// Streaming runs can produce several list invalidations in one event turn.
// Coalesce background refreshes to one rebuild per paint.
function scheduleSessionListRender() {
  if (sessionListRenderQueued) return sessionListRenderFrame;
  sessionListRenderQueued = true;
  sessionListRenderFrame = requestAnimationFrame(() => {
    sessionListRenderQueued = false;
    renderSessionList();
  });
  return sessionListRenderFrame;
}

let _flipLastRenderSessionId = null; // currentSessionId observed on the previous render
const _flipActiveAnimations = new Set(); // in-flight FLIP entries, cancelled on every render

function getSessionItemContainerClass(listEl) {
  if (listEl.classList.contains("pinned-items")) return "pinned-items";
  if (listEl.classList.contains("folder-group-items")) return "folder-group-items";
  if (listEl.classList.contains("archived-items")) return "archived-items";
  return null;
}

function cancelActiveFlipAnimations() {
  for (const entry of _flipActiveAnimations) entry.cancel();
  _flipActiveAnimations.clear();
}

window.RagentMotion?.subscribeReducedMotion?.((reduced) => {
  if (reduced) cancelActiveFlipAnimations();
});

function captureSessionItemPositions(container) {
  // The rebuild is about to replace every list item; stop any in-flight
  // animation from the previous render so its rAF/timer/listeners cannot
  // linger as ghost cleanup on stale nodes.
  cancelActiveFlipAnimations();
  const byContainer = new Map();
  const orderedIds = [];
  let count = 0;
  for (const listEl of container.querySelectorAll(".pinned-items, .folder-group-items, .archived-items")) {
    const className = getSessionItemContainerClass(listEl);
    if (!className) continue;
    const positions = new Map();
    for (const item of listEl.children) {
      const id = item.getAttribute("data-session-id");
      if (!id) continue;
      orderedIds.push(`${className}:${id}`);
      const rect = item.getBoundingClientRect();
      positions.set(id, { top: rect.top, left: rect.left });
      count += 1;
    }
    byContainer.set(className, positions);
  }
  // Session switches reorder the list by design (active item rises); the jump
  // is a deliberate state change and is not FLIP-animated.
  const sessionId = typeof currentSessionId === "string" ? currentSessionId : null;
  const sessionSwitched = _flipLastRenderSessionId !== null && _flipLastRenderSessionId !== sessionId;
  _flipLastRenderSessionId = sessionId;
  return { sessionSwitched, count, orderedIds, byContainer };
}

function playSessionItemFlip(container, before) {
  if (!before || before.count === 0 || before.sessionSwitched) return;
  if (
    typeof window.RagentMotion?.prefersReducedMotion === "function"
    && window.RagentMotion.prefersReducedMotion()
  ) {
    return;
  }
  if (typeof document !== "undefined" && document.hidden) return;
  if (container.dataset.userScrolling === "true") return;
  if (before.count > FLIP_MAX_SNAPSHOT_ITEMS) return;

  const afterOrderedIds = [];
  for (const listEl of container.querySelectorAll(".pinned-items, .folder-group-items, .archived-items")) {
    const className = getSessionItemContainerClass(listEl);
    if (!className) continue;
    for (const item of listEl.children) {
      const id = item.getAttribute("data-session-id");
      if (id) afterOrderedIds.push(`${className}:${id}`);
    }
  }
  if (
    Array.isArray(before.orderedIds)
    && afterOrderedIds.length === before.orderedIds.length
    && afterOrderedIds.every((entry, idx) => entry === before.orderedIds[idx])
  ) {
    return;
  }

  const containerRect = container.getBoundingClientRect();
  if (!(containerRect.width > 0 && containerRect.height > 0)) return;

  // Delta per item that exists in both snapshots, matched by container class.
  const moved = [];
  let matchedCount = 0;
  for (const listEl of container.querySelectorAll(".pinned-items, .folder-group-items, .archived-items")) {
    const className = getSessionItemContainerClass(listEl);
    const beforePositions = className ? before.byContainer.get(className) : null;
    if (!beforePositions) continue;
    for (const item of listEl.children) {
      const id = item.getAttribute("data-session-id");
      if (!id) continue;
      const from = beforePositions.get(id);
      if (!from) continue;
      matchedCount += 1;
      const rect = item.getBoundingClientRect();
      const dx = from.left - rect.left;
      const dy = from.top - rect.top;
      if (dx === 0 && dy === 0) continue;
      moved.push({ el: item, dx, dy });
    }
  }
  // Nothing from the previous snapshot survived (fresh render / filter change).
  if (matchedCount === 0 || moved.length === 0) return;

  // Hold every matched item at its previous visual position…
  for (const entry of moved) {
    entry.previousTransition = entry.el.style.transition;
    entry.previousTransform = entry.el.style.transform;
    // Suppress the stylesheet's transform transition (e.g. .session-item's)
    // while holding the inverse offset: with a live transition the browser
    // never records the offset as the start state, so the playback phase
    // would start from 0 and the animation would silently no-op.
    entry.el.style.transition = "none";
    entry.el.style.transform = `translate(${entry.dx}px, ${entry.dy}px)`;
  }
  void container.offsetHeight; // force a reflow so the offset is the transition start state

  let finished = false;
  let animationEntry = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const entry of moved) {
      if (entry.endListener) entry.el.removeEventListener("transitionend", entry.endListener);
      if (entry.timer) clearTimeout(entry.timer);
      entry.el.style.transition = entry.previousTransition || "";
      entry.el.style.transform = entry.previousTransform || "";
    }
    if (animationEntry) _flipActiveAnimations.delete(animationEntry);
  };

  // …then transition back to the natural position on the next painted frame.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (finished) return;
      for (const entry of moved) {
        entry.el.style.transition =
          `transform ${FLIP_TRANSITION_DURATION_MS}ms ${FLIP_TRANSITION_EASING}`;
        entry.endListener = (event) => {
          if (event.target === entry.el && event.propertyName === "transform") finish();
        };
        entry.el.addEventListener("transitionend", entry.endListener);
        entry.timer = setTimeout(finish, FLIP_TRANSITION_DURATION_MS + 100);
        entry.el.style.transform = "translate(0px, 0px)";
      }
    });
  });
  animationEntry = { cancel: finish };
  _flipActiveAnimations.add(animationEntry);
}

function renderSessionList() {
  ensureSessionListScrollGuard();
  // Second level of the sessions sidebar renders only the browsed project's
  // sessions; the global refresh chain (WS invalidation, source filter, …)
  // funnels through this function in both levels.
  if (
    typeof getSidebarViewLevel === "function"
    && getSidebarViewLevel() === "project-sessions"
    && typeof renderProjectSessionList === "function"
  ) {
    renderProjectSessionList();
    if (typeof refreshProjectsView === "function") refreshProjectsView();
    return;
  }
  let flipBefore = null;
  try {
    flipBefore = captureSessionItemPositions(sessionList);
  } catch (error) {
    // FLIP is best-effort; a capture failure must never block the rebuild.
  }
  sessionList.innerHTML = "";
  const pinnedSessions = getVisiblePinnedSessions();
  const visibleSessions = getVisibleActiveSessions();

  // Pinned section — shown in both views
  if (pinnedSessions.length > 0) {
    const section = document.createElement("div");
    section.className = "pinned-section";

    const header = document.createElement("div");
    header.className = "pinned-section-header";
    header.innerHTML = `<span class="pinned-label">${esc(t("sidebar.pinned"))}</span><span class="folder-count">${pinnedSessions.length}</span>`;

    const items = document.createElement("div");
    items.className = "pinned-items";
    for (const session of pinnedSessions) {
      items.appendChild(createActiveSessionItem(session));
    }

    section.appendChild(header);
    section.appendChild(items);
    sessionList.appendChild(section);
  }

  renderUnifiedView(visibleSessions);

  if (pinnedSessions.length === 0 && visibleSessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-filter-empty";
    const emptyText = document.createElement("div");
    emptyText.textContent = getFilteredSessionEmptyText();
    empty.appendChild(emptyText);

    const canRestoreStarterSessions = !visitorMode
      && activeSourceFilter === FILTER_ALL_VALUE
      && !(typeof sessionSearchQuery === "string" && sessionSearchQuery.trim())
      && typeof restoreOwnerBootstrapSessions === "function";
    if (canRestoreStarterSessions) {
      const restoreButton = document.createElement("button");
      restoreButton.type = "button";
      restoreButton.className = "new-session-btn secondary";
      restoreButton.textContent = t("sidebar.restoreStarterSessions");
      restoreButton.addEventListener("click", async () => {
        if (restoreButton.disabled) return;
        restoreButton.disabled = true;
        restoreButton.textContent = t("sidebar.restoringStarterSessions");
        try {
          await restoreOwnerBootstrapSessions();
        } catch (error) {
          console.warn("[sessions] Failed to restore starter sessions:", error?.message || error);
          restoreButton.textContent = t("sidebar.restoreStarterSessions");
          restoreButton.disabled = false;
          return;
        }
        restoreButton.textContent = t("sidebar.restoreStarterSessions");
        restoreButton.disabled = false;
      });
      empty.appendChild(restoreButton);
    }
    sessionList.appendChild(empty);
  }

  try {
    playSessionItemFlip(sessionList, flipBefore);
  } catch (error) {
    // Best-effort; silently degrade to an unanimated rebuild.
  }
  if (typeof refreshProjectsView === "function") refreshProjectsView();
}

function renderUnifiedView(visibleSessions) {
  const sorted = [...visibleSessions].sort((a, b) => {
    if (typeof compareSessionListSessions === "function") {
      return compareSessionListSessions(a, b);
    }
    const ta = a.created ? new Date(a.created).getTime() : 0;
    const tb = b.created ? new Date(b.created).getTime() : 0;
    return tb - ta;
  });

  if (sorted.length === 0) return;

  const group = document.createElement("div");
  group.className = "folder-group unified-sessions";

  const items = document.createElement("div");
  items.className = "folder-group-items";

  for (const s of sorted) {
    items.appendChild(createActiveSessionItem(s, { showGroup: true }));
  }

  group.appendChild(items);
  sessionList.appendChild(group);
}

function renderArchivedSection() {
  const archivedSessions = getVisibleArchivedSessions();
  const existing = document.getElementById("archivedSection");
  if (existing) existing.remove();

  const section = document.createElement("div");
  section.id = "archivedSection";
  section.className = "archived-section";

  const header = document.createElement("div");
  header.className = "archived-section-header";
  const isCollapsed = localStorage.getItem("archivedCollapsed") !== "false";
  if (isCollapsed) header.classList.add("collapsed");
  const archivedCount = archivedSessionsLoaded ? archivedSessions.length : archivedSessionCount;
  header.innerHTML = `<span class="folder-chevron">${renderUiIcon("chevron-down")}</span><span class="archived-label">${esc(t("sidebar.archive"))}</span><span class="folder-count">${archivedCount}</span>`;
  header.addEventListener("click", () => {
    header.classList.toggle("collapsed");
    localStorage.setItem("archivedCollapsed", header.classList.contains("collapsed") ? "true" : "false");
    if (!header.classList.contains("collapsed") && !archivedSessionsLoaded && !archivedSessionsLoading && archivedSessionCount > 0) {
      Promise.resolve(fetchArchivedSessions()).catch((error) => {
        console.warn("[sessions] Failed to load archived sessions:", error.message);
      });
    }
  });

  const items = document.createElement("div");
  items.className = "archived-items";

  if (!isCollapsed && !archivedSessionsLoaded && archivedSessionCount > 0) {
    if (!archivedSessionsLoading) {
      Promise.resolve(fetchArchivedSessions()).catch((error) => {
        console.warn("[sessions] Failed to load archived sessions:", error.message);
      });
    }
    const loading = document.createElement("div");
    loading.className = "archived-empty";
    loading.textContent = archivedSessionsLoading
      ? t("sidebar.loadingArchived")
      : t("sidebar.loadArchived");
    items.appendChild(loading);
  } else if (archivedSessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "archived-empty";
    empty.textContent = getFilteredSessionEmptyText({ archived: true });
    items.appendChild(empty);
  } else {
    for (const s of archivedSessions) {
      const div = document.createElement("div");
      div.className =
        "session-item archived-item" + (s.id === currentSessionId ? " active" : "");
      if (typeof s.id === "string" && s.id) {
        div.setAttribute("data-session-id", s.id);
      }
      const mainButton = createActiveSessionItem(s);
      mainButton.className = "session-item-main";

      const actions = document.createElement("div");
      actions.className = "session-item-actions";
      actions.innerHTML = `<button class="session-action-btn restore" type="button" title="${esc(t("action.restore"))}" aria-label="${esc(t("action.restore"))}" data-id="${esc(s.id)}">${renderUiIcon("unarchive")}</button>`;

      div.appendChild(mainButton);
      div.appendChild(actions);
      actions.querySelector(".restore").addEventListener("click", (e) => {
        e.stopPropagation();
        dispatchAction({ action: "unarchive", sessionId: s.id });
      });
      items.appendChild(div);
    }
  }

  section.appendChild(header);
  section.appendChild(items);
  sessionList.appendChild(section);
}

function attachSession(id, session, {
  forceComposerFocus = false,
  navigationGeneration = 0,
  viewportIntent = "session_entry_bottom",
} = {}) {
  if (
    navigationGeneration
    && typeof isSessionNavigationCurrent === "function"
    && !isSessionNavigationCurrent(navigationGeneration, id)
  ) {
    return null;
  }
  const isUnrendered = typeof hasRenderedEventSnapshot === "function"
    ? !hasRenderedEventSnapshot(id)
    : (typeof renderedEventState === "object" && renderedEventState !== null
      ? renderedEventState.sessionId !== id
      : false);
  const hasLoadError = typeof hasSessionLoadError === "function"
    ? hasSessionLoadError(id)
    : Boolean(
      typeof document !== "undefined"
      && document.querySelector?.(".messages-session-error:not([hidden])")
    );
  const shouldReattach = !hasAttachedSession
    || currentSessionId !== id
    || isUnrendered
    || hasLoadError;
  const previousSessionId = currentSessionId;
  if (shouldReattach && previousSessionId && previousSessionId !== id) {
    // Session switch: stop every in-flight refresh for the old session
    // (state/current/sidebar/paging) instead of letting them drain the
    // network and be discarded by stale guards.
    if (typeof abortSessionRefreshRequests === "function") {
      abortSessionRefreshRequests(previousSessionId);
    }
    if (typeof settleAttachedSessionSidebarState === "function") {
      Promise.resolve(settleAttachedSessionSidebarState({
        sessionId: previousSessionId,
        sync: true,
        render: false,
      })).catch(() => {});
    }
  } else if (shouldReattach && (isUnrendered || hasLoadError)) {
    // Reattaching to the same session because it was unrendered or had a load error:
    // abort any stale hanging requests for this session before re-dispatching.
    if (typeof abortSessionRefreshRequests === "function") {
      abortSessionRefreshRequests(id);
    }
  }
  const attachedSession = (typeof getChatStoreSession === "function" ? getChatStoreSession(id) : null)
    || session
    || { id };
  if (typeof holdAttachedSessionSidebarState === "function") {
    holdAttachedSessionSidebarState(attachedSession);
  }
  let attachPromise = null;
  if (shouldReattach && typeof dispatchAction === "function") {
    attachPromise = dispatchAction({
      action: "attach",
      sessionId: id,
      ...(navigationGeneration ? { navigationGeneration } : {}),
      viewportIntent,
    });
  }
  applyAttachedSessionState(id, attachedSession, {
    hasAttachedSession: shouldReattach ? false : hasAttachedSession,
  });
  // Repaint a bounded cached projector immediately on re-entry. The network
  // refresh remains authoritative and will reconcile it shortly, but a rapid
  // A→B→C→B switch no longer leaves the target looking indefinitely blank
  // while the latest page is in flight.
  if (shouldReattach && typeof window !== "undefined") {
    try {
      window.RagentTimelineRuntime?.restoreCachedSession?.(id, {
        runState: attachedSession?.activity?.run?.state || "idle",
      });
    } catch (error) {
      console.warn("[timeline] Failed to restore cached session snapshot:", error?.message || error);
    }
  }
  if (typeof stageSessionReviewedForAttachedSession === "function") {
    Promise.resolve(stageSessionReviewedForAttachedSession(attachedSession)).catch(() => {});
  }
  if (typeof focusComposer === "function") {
    focusComposer({ force: forceComposerFocus === true, preventScroll: true });
  } else {
    msgInput.focus();
  }
  // Re-opening the already attached row is still a session entry. There is
  // no attach action (and therefore no events refresh) in that case, so pin
  // the existing transcript explicitly and let its layout settle at the
  // latest message just like a fresh attach.
  if (!shouldReattach && viewportIntent === "session_entry_bottom") {
    pinMessageViewportToBottomForSessionEntry(id);
  }
  return attachPromise;
}
