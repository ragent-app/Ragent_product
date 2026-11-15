// Two-level sessions sidebar: "projects" overview (first level) and the
// per-project session list (second level, reusing the existing session list
// renderer). Pure data projections come from project-overview.js; this module
// owns the view state, rendering, and bottom-bar adaptation.
(function (root) {
  "use strict";

  const PROJECTS_LEVEL = "projects";
  const PROJECT_SESSIONS_LEVEL = "project-sessions";
  const PROJECT_VIEW_STATE_STORAGE_KEY = "ragent.projectViewState";

  let sidebarViewLevel = PROJECTS_LEVEL;
  let browsingProjectId = "";
  let browsingProjectName = "";
  // Full project record of the browsed level-two project (null in inbox or
  // on level one). Exposed so session-creation paths can scope their folder
  // to the project the user is actually inside, not the globally selected one.
  let browsingProject = null;
  let projectsViewEl = null;
  let projectHeaderEl = null;
  let projectHeaderTitleEl = null;
  let lastActiveProjectHead = null;
  // Level navigation is state-first: the target level becomes authoritative
  // immediately, while one short incoming-panel transition provides feedback.
  // A generation guard only removes visual residue; it never owns the view
  // state and never waits for animation events to settle the UI.
  let levelTransitionTimer = null;
  let levelTransitionGeneration = 0;
  // The mobile L2 back gesture is a direct-manipulation interaction rather
  // than a timed navigation animation: the active panel follows the finger,
  // and release decides whether to commit or rebound. Keeping this state here
  // lets the shared gesture recognizer stay responsible for axis locking and
  // the project view stay responsible for its own panel composition.
  const EDGE_BACK_SWIPE_TRIGGER_RATIO = 0.32;
  const EDGE_BACK_SWIPE_MIN_TRIGGER_PX = 72;
  const EDGE_BACK_SWIPE_MAX_TRIGGER_PX = 128;
  let edgeBackSwipe = null;
  let edgeBackSwipeSettleTimer = null;
  let edgeBackSwipeSettleFrame = null;

  function t(key, vars) {
    return window.ragentT ? window.ragentT(key, vars) : key;
  }

  function renderUiIcon(name, className = "") {
    return window.renderUiIcon ? window.renderUiIcon(name, className) : "";
  }

  // Wraps every case-insensitive occurrence of `needle` in the given text in
  // <mark class="sidebar-search-match"> so search hits stay scannable.
  function buildHighlightedText(text, needle) {
    const value = String(text || "");
    if (!needle) return document.createTextNode(value);
    const lower = value.toLowerCase();
    const needleLower = needle.toLowerCase();
    const frag = document.createDocumentFragment();
    let cursor = 0;
    let index = lower.indexOf(needleLower);
    while (index !== -1) {
      if (index > cursor) frag.appendChild(document.createTextNode(value.slice(cursor, index)));
      const mark = document.createElement("mark");
      mark.className = "sidebar-search-match";
      mark.textContent = value.slice(index, index + needle.length);
      frag.appendChild(mark);
      cursor = index + needle.length;
      index = lower.indexOf(needleLower, cursor);
    }
    if (cursor < value.length) frag.appendChild(document.createTextNode(value.slice(cursor)));
    return frag;
  }

  function applyMatchHighlight(el, needle) {
    if (!el || !needle) return;
    const text = el.textContent;
    el.textContent = "";
    el.appendChild(buildHighlightedText(text, needle));
  }

  // Search groups carry a match level (L1 project+session / L2 session /
  // L3 project); a small chip next to the project name makes the level
  // scannable without reading every row.
  function getMatchLevelLabel(matchLevel) {
    const overview = root.RagentProjectOverview;
    if (!overview) return "";
    if (matchLevel === overview.MATCH_LEVEL_PROJECT_AND_SESSION) return t("sidebar.projects.matchProjectAndSession");
    if (matchLevel === overview.MATCH_LEVEL_SESSION) return t("sidebar.projects.matchSession");
    if (matchLevel === overview.MATCH_LEVEL_PROJECT) return t("sidebar.projects.matchProject");
    return "";
  }

  function isSessionRunning(session) {
    return session?.activity?.run?.state === "running";
  }

  function getSidebarViewLevel() {
    return sidebarViewLevel;
  }

  function getBrowsingProjectId() {
    return browsingProjectId;
  }

  // Full browsed-project record (id/name/rootPath) or null. Creation paths
  // outside this module (agents panel, managed apps, …) read this to scope
  // new sessions to the project the user is inside, falling back to the
  // globally selected project when no project is being browsed.
  function getBrowsingProject() {
    return browsingProject
      ? {
          id: browsingProject.id,
          name: browsingProject.name,
          rootPath: browsingProject.rootPath,
        }
      : null;
  }

  function ensureProjectsView() {
    if (!projectsViewEl) projectsViewEl = document.getElementById("projectsView");
    return projectsViewEl;
  }

  function ensureProjectHeader() {
    if (!projectHeaderEl) projectHeaderEl = document.getElementById("sidebarProjectHeader");
    if (!projectHeaderTitleEl && projectHeaderEl) {
      projectHeaderTitleEl = projectHeaderEl.querySelector("#sidebarProjectTitle");
    }
    return projectHeaderEl;
  }

  function getProjectCatalog() {
    return typeof window.ragentGetProjects === "function" ? window.ragentGetProjects() : [];
  }

  function readStoredProjectViewState() {
    try {
      const raw = sessionStorage.getItem(PROJECT_VIEW_STATE_STORAGE_KEY);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (value?.level !== PROJECT_SESSIONS_LEVEL || typeof value.projectId !== "string") {
        return null;
      }
      return { level: PROJECT_SESSIONS_LEVEL, projectId: value.projectId };
    } catch {
      return null;
    }
  }

  function persistProjectViewState() {
    try {
      sessionStorage.setItem(PROJECT_VIEW_STATE_STORAGE_KEY, JSON.stringify({
        level: PROJECT_SESSIONS_LEVEL,
        projectId: browsingProjectId || "inbox",
      }));
    } catch {}
  }

  function clearStoredProjectViewState() {
    try {
      sessionStorage.removeItem(PROJECT_VIEW_STATE_STORAGE_KEY);
    } catch {}
  }

  // Source sessions for both levels: all active sessions filtered by the
  // source filter but NOT by the selected project or search query — the
  // projection layer applies its own grouping and match rules. Cross-project:
  // the project navigation groups every project at level one and scopes by
  // the browsed project at level two, so it reads the full catalog instead of
  // the currently selected project's sessions.
  function getOverviewSourceSessions() {
    if (typeof getFilteredActiveSessions === "function") {
      return getFilteredActiveSessions({ includeAllProjects: true });
    }
    if (typeof getActiveSessions === "function") {
      return getActiveSessions({ includeAllProjects: true });
    }
    return [];
  }

  function getProjectSortTime(session) {
    if (typeof getSessionSortTime === "function") {
      const time = getSessionSortTime(session);
      return Number.isFinite(time) ? time : 0;
    }
    return 0;
  }

  // The L1 preview order must match the L2 session list exactly (pinned
  // sessions, sidebar order, attention bands and workflow priority all
  // tie-break identically). Passing the shared list comparator keeps the two
  // levels consistent, so the same session order is preserved across the
  // navigation boundary.
  function getProjectSortCompare() {
    if (typeof compareSessionListSessions === "function") {
      return compareSessionListSessions;
    }
    return null;
  }

  function renderProjectsEmpty(query) {
    const empty = document.createElement("div");
    empty.className = "sidebar-projects-empty";
    if (query) {
      const text = document.createElement("div");
      text.textContent = t("sidebar.projects.noMatch");
      empty.appendChild(text);
      const hint = document.createElement("div");
      hint.className = "sidebar-projects-empty-hint";
      hint.textContent = t("sidebar.projects.noMatchHint");
      empty.appendChild(hint);
      return empty;
    }
    const title = document.createElement("div");
    title.className = "sidebar-projects-empty-title";
    title.textContent = t("sidebar.projects.empty");
    const hint = document.createElement("div");
    hint.textContent = t("sidebar.projects.emptyHint");
    // Single entry point: the bottom main button (labeled "New project" on
    // the first level) owns the create action — no duplicate centered CTA.
    empty.appendChild(title);
    empty.appendChild(hint);
    // First-run status legend: the dots appear on preview rows once projects
    // exist, so teach them here while the empty state has the room.
    const legend = document.createElement("div");
    legend.className = "sidebar-status-legend";
    const legendItem = (dotClass, label) => {
      const item = document.createElement("span");
      item.className = "sidebar-status-legend-item";
      const dot = document.createElement("span");
      dot.className = `session-item-status ${dotClass}`;
      dot.setAttribute("aria-hidden", "true");
      item.appendChild(dot);
      const text = document.createElement("span");
      text.textContent = label;
      item.appendChild(text);
      return item;
    };
    legend.appendChild(legendItem("session-item-status--running", t("sidebar.projects.statusRunning")));
    legend.appendChild(legendItem("session-item-status--needs-action", t("sidebar.projects.statusNeedsAction")));
    legend.appendChild(legendItem("session-item-status--unread", t("sidebar.projects.statusUnread")));
    const idle = document.createElement("span");
    idle.className = "sidebar-status-legend-item";
    idle.textContent = t("sidebar.projects.statusIdle");
    legend.appendChild(idle);
    empty.appendChild(legend);
    return empty;
  }

  function renderProjectGroup(group, searchQuery = "") {
    const groupEl = document.createElement("div");
    groupEl.className = "sidebar-project-group";

    const headRow = document.createElement("div");
    headRow.className = "sidebar-project-head-row";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "sidebar-project-head";
    head.dataset.projectId = group.projectId;
    head.innerHTML = `
      <span class="sidebar-project-head-icon">${renderUiIcon("folder-solid")}</span>
      <span class="sidebar-project-head-name"></span>
      <span class="sidebar-project-head-pin" aria-hidden="true"></span>
      <span class="sidebar-project-head-count"></span>
      <span class="sidebar-project-head-chevron">${renderUiIcon("chevron-right")}</span>`;
    const nameEl = head.querySelector(".sidebar-project-head-name");
    const displayName = group.inbox
      ? t("sidebar.view.inbox")
      : (group.project?.name || t("sidebar.project.untitled"));
    nameEl.textContent = displayName;
    // Search mode: highlight the matched project-name substring (the inbox
    // has no name to match) and label the match level.
    applyMatchHighlight(nameEl, searchQuery && !group.inbox ? searchQuery : "");
    const levelLabel = getMatchLevelLabel(group.matchLevel);
    if (levelLabel) {
      const tag = document.createElement("span");
      tag.className = "sidebar-project-match-tag";
      tag.textContent = levelLabel;
      nameEl.insertAdjacentElement("afterend", tag);
    }
    head.querySelector(".sidebar-project-head-count").textContent = String(group.sessionCount);
    const pinEl = head.querySelector(".sidebar-project-head-pin");
    if (group.project?.pinned === true) {
      pinEl.innerHTML = renderUiIcon("pinned");
      pinEl.title = t("sidebar.pinned");
    } else {
      pinEl.remove();
    }
    // Running projects get an accent folder icon — the one semantic color
    // allowed on this quiet surface (state, not decoration).
    if (Array.isArray(group.preview) && group.preview.some((session) => isSessionRunning(session))) {
      head.dataset.running = "true";
    }
    // The match-level chip is meaningful for screen readers too.
    head.setAttribute("aria-label", levelLabel ? `${displayName} · ${levelLabel}` : displayName);
    head.addEventListener("click", () => enterProjectSessions(group, head));
    if (!group.inbox && typeof window.ragentBindSidebarLongPress === "function") {
      window.ragentBindSidebarLongPress(head, () => {
        window.ragentOpenProjectActionSheet?.({
          ...(group.project || {}),
          sessionCount: group.sessionCount,
        }, head);
      });
    }
    headRow.appendChild(head);
    groupEl.appendChild(headRow);

    if (group.preview.length > 0) {
      const preview = document.createElement("div");
      preview.className = "sidebar-project-preview";
      for (const session of group.preview) {
        const item = createActiveSessionItem(session);
        if (searchQuery && item?.querySelector) {
          applyMatchHighlight(item.querySelector(".session-item-name"), searchQuery);
        }
        preview.appendChild(item);
      }
      groupEl.appendChild(preview);
    }
    return groupEl;
  }

  function renderProjectsView({ force = false } = {}) {
    const container = ensureProjectsView();
    if (!container) return;
    if (sidebarViewLevel === PROJECT_SESSIONS_LEVEL) return;
    const activeTab = typeof getActiveSidebarTabValue === "function"
      ? getActiveSidebarTabValue()
      : "sessions";
    if (activeTab !== "sessions") return;
    void force;
    const searchQuery = typeof sessionSearchQuery === "string" ? sessionSearchQuery.trim() : "";
    const projects = getProjectCatalog();
    const sessions = getOverviewSourceSessions();
    const overview = root.RagentProjectOverview;
    const limit = getProjectPreviewLimit();
    const groups = searchQuery
      ? (overview?.searchProjectView?.({ projects, sessions, limit, getSortTime: getProjectSortTime, query: searchQuery, compare: getProjectSortCompare(), isRunning: isSessionRunning }) || [])
      : (overview?.buildProjectOverview?.({ projects, sessions, limit, getSortTime: getProjectSortTime, compare: getProjectSortCompare(), isRunning: isSessionRunning }) || []);
    container.innerHTML = "";
    if (groups.length === 0) {
      container.appendChild(renderProjectsEmpty(searchQuery));
      return;
    }
    for (const group of groups) {
      container.appendChild(renderProjectGroup(group, searchQuery));
    }
  }

  function createSessionInProject(projectId) {
    // The plus creates a session in THIS project regardless of which project
    // (if any) is globally active, so no hasActiveProject gate applies here.
    const normalizedProjectId = String(projectId || "").trim();
    if (!normalizedProjectId) return false;
    if (typeof createNewSessionShortcut === "function") {
      return createNewSessionShortcut({ projectId: normalizedProjectId });
    }
    return false;
  }

  function renderProjectSessionList() {
    if (typeof sessionList === "undefined" || !sessionList) return;
    let flipBefore = null;
    try {
      if (typeof captureSessionItemPositions === "function") {
        flipBefore = captureSessionItemPositions(sessionList);
      }
    } catch {
      // Project-level FLIP is best-effort; a stale or hidden list must never
      // prevent the project session view from rendering.
    }
    sessionList.innerHTML = "";
    sessionList.style.paddingTop = "";
    const overview = root.RagentProjectOverview;
    const sessions = overview?.sessionsOfProject
      ? overview.sessionsOfProject({
          sessions: getOverviewSourceSessions(),
          projectId: browsingProjectId,
          projects: getProjectCatalog(),
        })
      : [];
    // Search mode inside the second level matches session names (reusing the
    // shared session search predicate).
    const searchQuery = typeof sessionSearchQuery === "string" ? sessionSearchQuery.trim() : "";
    const filtered = searchQuery && typeof matchesSearchQuery === "function"
      ? sessions.filter((session) => matchesSearchQuery(session))
      : sessions;
    const sorted = [...filtered].sort((a, b) => {
      if (typeof compareSessionListSessions === "function") {
        return compareSessionListSessions(a, b);
      }
      return getProjectSortTime(b) - getProjectSortTime(a);
    });
    if (sorted.length === 0) {
      const empty = document.createElement("div");
      empty.className = "session-filter-empty sidebar-session-empty";
      const text = document.createElement("div");
      text.textContent = t("sidebar.projects.noSessions");
      empty.appendChild(text);
      // Keep the recovery path visible: the browse context is this project,
      // so "create a session here" is the only sensible next step.
      if (!searchQuery && browsingProjectId) {
        const create = document.createElement("button");
        create.type = "button";
        create.className = "new-session-btn secondary sidebar-l2-empty-cta";
        create.textContent = t("sidebar.projects.createSessionHere");
        create.addEventListener("click", () => createSessionInProject(browsingProjectId));
        empty.appendChild(create);
      }
      sessionList.appendChild(empty);
      return;
    }
    // Second level keeps its own light grouping: a "running" section first
    // (mirrors the global list's attention ordering), then everything else.
    const running = sorted.filter((session) => isSessionRunning(session));
    const rest = running.length === sorted.length ? [] : sorted.filter((session) => !isSessionRunning(session));
    const group = document.createElement("div");
    group.className = "folder-group unified-sessions";
    const appendSection = (label, list) => {
      if (list.length === 0) return;
      if (label) {
        const header = document.createElement("div");
        header.className = "folder-group-header sidebar-session-section-header";
        header.textContent = label;
        group.appendChild(header);
      }
      const items = document.createElement("div");
      items.className = "folder-group-items";
      for (const session of list) {
        const item = createActiveSessionItem(session);
        // Match highlight mirrors the L1 preview's search treatment so the
        // hit stays scannable inside the project too.
        if (searchQuery && item?.querySelector) {
          applyMatchHighlight(item.querySelector(".session-item-name"), searchQuery);
        }
        items.appendChild(item);
      }
      group.appendChild(items);
    };
    if (running.length > 0 && rest.length > 0) {
      appendSection(t("sidebar.projects.running"), running);
      appendSection(t("sidebar.projects.recent"), rest);
    } else {
      appendSection("", sorted);
    }
    sessionList.appendChild(group);
    try {
      if (typeof playSessionItemFlip === "function") {
        playSessionItemFlip(sessionList, flipBefore);
      }
    } catch {
      // Degrade to the rebuilt list when geometry is unavailable (for example
      // while the mobile sidebar is changing levels).
    }
  }

  function syncBottomActions(isProjectSessions) {
    const isFirstLevel = !isProjectSessions;
    if (typeof sidebarAgentBtn !== "undefined" && sidebarAgentBtn) {
      sidebarAgentBtn.hidden = isFirstLevel;
    }
    if (typeof newSessionBtn !== "undefined" && newSessionBtn) {
      const labelSpan = newSessionBtn.querySelector("span:not(.sidebar-new-chat-icon)");
      const iconSpan = newSessionBtn.querySelector(".sidebar-new-chat-icon");
      const key = isFirstLevel ? "sidebar.projects.newProject" : "sidebar.projects.newChat";
      if (labelSpan) {
        labelSpan.dataset.i18n = key;
        labelSpan.textContent = t(key);
      }
      if (iconSpan) {
        iconSpan.innerHTML = renderUiIcon(isFirstLevel ? "folder-plus" : "new-chat");
      }
    }
  }

  // Second-level header: back button, project name, and the per-project
  // "new session" action (one action per row on L1 — see critique, batch 2).
  function syncProjectHeaderContent(isProjectSessions, searchMode) {
    const headerEl = ensureProjectHeader();
    if (!headerEl) return;
    const backBtn = headerEl.querySelector("#sidebarProjectBackBtn");
    if (backBtn && !backBtn.dataset.projectLevelBound) {
      backBtn.dataset.projectLevelBound = "1";
      backBtn.addEventListener("click", () => backToProjects());
    }
    headerEl.hidden = !isProjectSessions || searchMode;
    if (!headerEl.hidden && projectHeaderTitleEl) {
      projectHeaderTitleEl.textContent = browsingProjectName;
    }
  }

  // Central view-state sync. Call it whenever the level, search mode, or tab
  // changes so both levels and the bottom bar stay consistent.
  function syncProjectLevelUI() {
    const isProjectSessions = sidebarViewLevel === PROJECT_SESSIONS_LEVEL;
    const searchMode = typeof sidebarSearchMode === "boolean" ? sidebarSearchMode : false;
    syncProjectHeaderContent(isProjectSessions, searchMode);
    const viewEl = ensureProjectsView();
    if (viewEl) viewEl.hidden = isProjectSessions;
    if (typeof sessionList !== "undefined" && sessionList) {
      sessionList.hidden = !isProjectSessions;
    }
    if (typeof sidebarSessionSearchHeading !== "undefined" && sidebarSessionSearchHeading) {
      // The "Sessions" heading labels L1 search results (sidebar-ui owns that
      // state); inside a project the project header already says where you
      // are, so the heading is redundant there.
      sidebarSessionSearchHeading.hidden = isProjectSessions || !searchMode || !sessionSearchQuery;
    }
    // First-level search shows project + session matches only; the agents
    // search results belong to the second level (existing behavior).
    if (typeof sidebarAgentSearchResults !== "undefined" && sidebarAgentSearchResults) {
      sidebarAgentSearchResults.hidden = !isProjectSessions;
    }
    if (typeof sessionSearchInput !== "undefined" && sessionSearchInput) {
      sessionSearchInput.placeholder = isProjectSessions
        ? t("sidebar.projects.searchSessionsPlaceholder")
        : t("sidebar.projects.searchPlaceholder");
    }
    syncBottomActions(isProjectSessions);
    // Device bar is an L1-only surface: hide it while a project's session
    // list is open (device-bar.js also syncs on app-bar/search changes).
    if (typeof syncSidebarDeviceBar === "function") syncSidebarDeviceBar();
  }

  // Level navigation follows Apple's push-style motion model: the target
  // panel is rendered immediately, then enters from the direction that explains
  // the hierarchy. There is no shared-element clone, clip-path reveal, layout
  // measurement, or completion-event chain to leave behind visual residue.
  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  }

  function isMobileSidebarMotion() {
    return window.matchMedia?.("(max-width: 767px)")?.matches === true;
  }

  function getProjectPreviewLimit() {
    return isMobileSidebarMotion() ? 2 : 3;
  }

  function getEdgeBackSwipeSurface() {
    return document.getElementById("sidebarSessionSurface");
  }

  function getSessionListElement() {
    return typeof sessionList !== "undefined" ? sessionList : null;
  }

  function canStartEdgeBackSwipe() {
    return isMobileSidebarMotion()
      && sidebarViewLevel === PROJECT_SESSIONS_LEVEL
      && Boolean(getEdgeBackSwipeSurface())
      && Boolean(ensureProjectsView())
      && Boolean(getSessionListElement());
  }

  function getEdgeBackSwipeTriggerDistance() {
    const surface = getEdgeBackSwipeSurface();
    const width = surface?.getBoundingClientRect?.().width || window.innerWidth || 1;
    return Math.max(
      EDGE_BACK_SWIPE_MIN_TRIGGER_PX,
      Math.min(EDGE_BACK_SWIPE_MAX_TRIGGER_PX, width * EDGE_BACK_SWIPE_TRIGGER_RATIO),
    );
  }

  function readTranslateX(el) {
    if (!el) return 0;
    const transform = typeof getComputedStyle === "function"
      ? getComputedStyle(el).transform
      : el.style?.transform;
    if (!transform || transform === "none") return 0;
    const match = transform.match(/^matrix(3d)?\((.+)\)$/);
    if (!match) return 0;
    const values = match[2].split(",").map(Number);
    const value = match[1] ? values[12] : values[4];
    return Number.isFinite(value) ? value : 0;
  }

  function clearEdgeBackSwipeSettleTimer() {
    if (edgeBackSwipeSettleFrame !== null) {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(edgeBackSwipeSettleFrame);
      } else {
        clearTimeout(edgeBackSwipeSettleFrame);
      }
      edgeBackSwipeSettleFrame = null;
    }
    if (edgeBackSwipeSettleTimer !== null) {
      clearTimeout(edgeBackSwipeSettleTimer);
      edgeBackSwipeSettleTimer = null;
    }
  }

  function clearEdgeBackSwipeVisuals() {
    clearEdgeBackSwipeSettleTimer();
    edgeBackSwipe = null;
    const surface = getEdgeBackSwipeSurface();
    const viewEl = ensureProjectsView();
    const listEl = getSessionListElement();
    const headerEl = ensureProjectHeader();
    surface?.classList.remove(
      "sidebar-edge-back-swipe-active",
      "sidebar-edge-back-swipe-settling",
    );
    for (const el of [viewEl, listEl, headerEl]) {
      el?.classList.remove(
        "sidebar-edge-back-swipe-underlay",
        "sidebar-edge-back-swipe-panel",
        "sidebar-edge-back-swipe-settling",
      );
      el?.style.removeProperty("transform");
      el?.style.removeProperty("will-change");
    }
    if (viewEl) viewEl.hidden = sidebarViewLevel === PROJECT_SESSIONS_LEVEL;
    if (listEl) listEl.hidden = sidebarViewLevel !== PROJECT_SESSIONS_LEVEL;
  }

  function interruptEdgeBackSwipeSettle() {
    clearEdgeBackSwipeSettleTimer();
    const surface = getEdgeBackSwipeSurface();
    const listEl = getSessionListElement();
    const headerEl = ensureProjectHeader();
    // Freeze a rebound/commit at its current compositor position before
    // removing the settling class. A new edge touch can therefore take over
    // without jumping back to the old endpoint.
    const currentX = readTranslateX(listEl);
    surface?.classList.remove("sidebar-edge-back-swipe-settling");
    for (const el of [listEl, headerEl]) {
      if (!el) continue;
      el.classList.remove("sidebar-edge-back-swipe-settling");
      el.style.transform = `translate3d(${Math.max(0, currentX)}px, 0, 0)`;
    }
    return Math.max(0, currentX);
  }

  function beginEdgeBackSwipe() {
    if (!canStartEdgeBackSwipe()) return false;
    const surface = getEdgeBackSwipeSurface();
    const viewEl = ensureProjectsView();
    const listEl = getSessionListElement();
    const headerEl = ensureProjectHeader();
    const interruptedX = interruptEdgeBackSwipeSettle();
    const width = Math.max(1, surface.getBoundingClientRect?.().width || window.innerWidth || 1);
    edgeBackSwipe = {
      surface,
      viewEl,
      listEl,
      headerEl,
      width,
      distance: Math.min(width, interruptedX),
    };
    // Keep the L1 surface mounted underneath the L2 panel. The header moves
    // with the active panel too, so the hierarchy reads as one physical push.
    surface.classList.add("sidebar-edge-back-swipe-active");
    viewEl.hidden = false;
    listEl.hidden = false;
    viewEl.classList.add("sidebar-edge-back-swipe-underlay");
    listEl.classList.add("sidebar-edge-back-swipe-panel");
    headerEl?.classList.add("sidebar-edge-back-swipe-panel");
    updateEdgeBackSwipe(interruptedX);
    return true;
  }

  function updateEdgeBackSwipe(distance) {
    if (!edgeBackSwipe) return false;
    const nextDistance = Math.max(0, Math.min(edgeBackSwipe.width, Number(distance) || 0));
    edgeBackSwipe.distance = nextDistance;
    const transform = `translate3d(${nextDistance}px, 0, 0)`;
    edgeBackSwipe.listEl.style.transform = transform;
    if (edgeBackSwipe.headerEl) edgeBackSwipe.headerEl.style.transform = transform;
    return true;
  }

  function finishEdgeBackSwipe(committed, state, onSettled) {
    clearEdgeBackSwipeVisuals();
    if (committed && sidebarViewLevel === PROJECT_SESSIONS_LEVEL) {
      backToProjects({ skipTransition: true });
    } else {
      syncProjectLevelUI();
    }
    onSettled?.();
  }

  function settleEdgeBackSwipe(committed, onSettled) {
    const state = edgeBackSwipe;
    if (!state) {
      onSettled?.();
      return;
    }
    edgeBackSwipe = null;
    const target = committed ? state.width : 0;
    const reduced = prefersReducedMotion();
    state.surface.classList.add("sidebar-edge-back-swipe-settling");
    state.listEl.classList.add("sidebar-edge-back-swipe-settling");
    state.headerEl?.classList.add("sidebar-edge-back-swipe-settling");
    const moveToTarget = () => {
      const transform = `translate3d(${target}px, 0, 0)`;
      state.listEl.style.transform = transform;
      if (state.headerEl) state.headerEl.style.transform = transform;
    };
    if (reduced) {
      moveToTarget();
      finishEdgeBackSwipe(committed, state, onSettled);
      return;
    }
    const settleFrame = () => {
      edgeBackSwipeSettleFrame = null;
      moveToTarget();
      edgeBackSwipeSettleTimer = window.setTimeout(() => {
        edgeBackSwipeSettleTimer = null;
        finishEdgeBackSwipe(committed, state, onSettled);
      }, 220);
    };
    edgeBackSwipeSettleFrame = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(settleFrame)
      : window.setTimeout(settleFrame, 0);
  }

  function clearLevelTransitionVisuals() {
    levelTransitionGeneration += 1;
    if (levelTransitionTimer) {
      clearTimeout(levelTransitionTimer);
      levelTransitionTimer = null;
    }
    const viewEl = ensureProjectsView();
    const listEl = typeof sessionList !== "undefined" ? sessionList : null;
    for (const el of [viewEl, listEl]) {
      el?.classList.remove(
        "sidebar-level-panel-enter-forward",
        "sidebar-level-panel-enter-back",
      );
      el?.style.removeProperty("will-change");
    }
  }

  function finishLevelTransition() {
    clearLevelTransitionVisuals();
    syncProjectLevelUI();
  }

  function playLevelTransition(direction) {
    const viewEl = ensureProjectsView();
    const listEl = typeof sessionList !== "undefined" ? sessionList : null;
    const incoming = direction === "back" ? viewEl : listEl;
    if (!incoming || prefersReducedMotion()) return;
    clearLevelTransitionVisuals();
    const className = direction === "back"
      ? "sidebar-level-panel-enter-back"
      : "sidebar-level-panel-enter-forward";
    const generation = levelTransitionGeneration;
    incoming.style.willChange = "transform, opacity";
    incoming.classList.add(className);
    // Use a bounded cleanup timer rather than animationend. The timer is only
    // visual housekeeping; the view state has already settled before motion
    // begins, so a missed browser event cannot strand the navigation.
    levelTransitionTimer = window.setTimeout(() => {
      if (generation !== levelTransitionGeneration) return;
      incoming.classList.remove(className);
      incoming.style.removeProperty("will-change");
      levelTransitionTimer = null;
    }, 240);
  }

  window.RagentMotion?.subscribeReducedMotion?.((reduced) => {
    if (!reduced) return;
    clearLevelTransitionVisuals();
    syncProjectLevelUI();
  });

  function enterProjectSessions(group, headEl) {
    clearEdgeBackSwipeVisuals();
    clearLevelTransitionVisuals();
    browsingProjectId = group.inbox ? "" : String(group.projectId || "");
    browsingProjectName = group.inbox
      ? t("sidebar.view.inbox")
      : (group.project?.name || t("sidebar.project.untitled"));
    browsingProject = group.inbox ? null : (group.project || null);
    persistProjectViewState();
    if (headEl) {
      headEl.classList.add("is-open");
      lastActiveProjectHead = headEl;
    }
    sidebarViewLevel = PROJECT_SESSIONS_LEVEL;
    renderProjectSessionList();
    syncProjectLevelUI();
    playLevelTransition("forward");
  }

  function backToProjects({ skipTransition = false } = {}) {
    const wasL2 = sidebarViewLevel === PROJECT_SESSIONS_LEVEL;
    clearEdgeBackSwipeVisuals();
    clearLevelTransitionVisuals();
    if (lastActiveProjectHead && lastActiveProjectHead.isConnected) {
      lastActiveProjectHead.classList.remove("is-open");
    }
    lastActiveProjectHead = null;
    sidebarViewLevel = PROJECTS_LEVEL;
    browsingProjectId = "";
    browsingProjectName = "";
    browsingProject = null;
    clearStoredProjectViewState();
    renderProjectsView({ force: true });
    syncProjectLevelUI();
    if (wasL2 && !skipTransition) playLevelTransition("back");
  }
  function refreshProjectsView() {
    renderProjectsView();
  }

  function restoreStoredProjectSessionsView() {
    const stored = readStoredProjectViewState();
    if (!stored) return false;
    const overview = root.RagentProjectOverview;
    const groups = overview?.buildProjectOverview?.({
      projects: getProjectCatalog(),
      sessions: getOverviewSourceSessions(),
      limit: getProjectPreviewLimit(),
      getSortTime: getProjectSortTime,
      compare: getProjectSortCompare(),
      isRunning: isSessionRunning,
    }) || [];
    const group = groups.find((candidate) => (
      stored.projectId === "inbox"
        ? candidate.inbox === true
        : !candidate.inbox && String(candidate.projectId || "") === stored.projectId
    ));
    if (!group) {
      clearStoredProjectViewState();
      return false;
    }
    browsingProjectId = group.inbox ? "" : String(group.projectId || "");
    browsingProjectName = group.inbox
      ? t("sidebar.view.inbox")
      : (group.project?.name || t("sidebar.project.untitled"));
    browsingProject = group.inbox ? null : (group.project || null);
    sidebarViewLevel = PROJECT_SESSIONS_LEVEL;
    renderProjectSessionList();
    syncProjectHeaderContent(true, false);
    syncProjectLevelUI();
    return true;
  }

  // First render once the project catalog resolves; the sessions refresh
  // chain keeps both levels in sync afterwards.
  function initProjectView() {
    if (typeof window.ragentProjectsReady?.then === "function") {
      window.ragentProjectsReady
        .catch(() => null)
        .then(() => {
          renderProjectsView({ force: true });
          restoreStoredProjectSessionsView();
          syncProjectLevelUI();
        });
    } else {
      renderProjectsView({ force: true });
      restoreStoredProjectSessionsView();
      syncProjectLevelUI();
    }
  }

  root.RagentProjectView = {
    getSidebarViewLevel,
    getBrowsingProjectId,
    getBrowsingProject,
    renderProjectsView,
    refreshProjectsView,
    restoreStoredProjectSessionsView,
    renderProjectSessionList,
    syncProjectLevelUI,
    enterProjectSessions,
    backToProjects,
    canStartEdgeBackSwipe,
    beginEdgeBackSwipe,
    updateEdgeBackSwipe,
    settleEdgeBackSwipe,
    getEdgeBackSwipeTriggerDistance,
    createSessionInProject,
    PROJECTS_LEVEL,
    PROJECT_SESSIONS_LEVEL,
  };

  // Cross-module refresh hooks: session-list-ui.js, session-http-list-state.js
  // and sidebar-ui.js call these as bare globals behind typeof guards (they
  // live in different classic scripts, so IIFE-local functions are invisible
  // to them). Without the exposure every refresh path silently no-ops and L1
  // keeps stale counts until a manual re-render.
  root.getSidebarViewLevel = getSidebarViewLevel;
  root.getBrowsingProjectId = getBrowsingProjectId;
  root.ragentGetBrowsingProject = getBrowsingProject;
  root.renderProjectsView = renderProjectsView;
  root.refreshProjectsView = refreshProjectsView;
  root.renderProjectSessionList = renderProjectSessionList;
  root.syncProjectLevelUI = syncProjectLevelUI;
  root.backToProjects = backToProjects;

  initProjectView();
})(typeof globalThis !== "undefined" ? globalThis : window);
