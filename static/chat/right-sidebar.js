"use strict";

(function attachRightSidebar(root) {
  const SIDEBAR_WIDTH_STORAGE_KEY = "ragent.rightSidebarWidth";
  const DESKTOP_QUERY = "(min-width: 1180px)";
  const MOBILE_QUERY = "(max-width: 767px)";
  const MIN_SIDEBAR_WIDTH = 360;
  const MAX_SIDEBAR_WIDTH = 900;
  const SIDEBAR_CLOSE_ANIMATION_MS = 280;

  // Android back button: registered while the sidebar is open. Deeper
  // deeper views (files / organization) step back to home first, mirroring
  // handleBackButtonClick, then the sidebar closes.
  let backEntryId = null;
  let focusScopeDeactivate = null;
  let focusBeforeOpen = null;
  function syncBackEntry() {
    if (state.open) {
      if (backEntryId) return;
      backEntryId = window.RagentBackHandler?.push?.({
        id: "right-sidebar",
        onBack: () => {
          if (state.view === "files" || state.view === "organization") {
            openHome();
            return true;
          }
          close();
          return true;
        },
      }) || null;
    } else if (backEntryId) {
      window.RagentBackHandler?.pop?.(backEntryId);
      backEntryId = null;
    }
  }

  const state = {
    open: false,
    view: "home",
    width: 0,
    resizing: false,
    closeTimer: 0,
    organizationLoading: false,
    organizationProjection: null,
    organizationEtag: "",
  };

  const dom = {
    button: null,
    panel: null,
    resizeHandle: null,
    backButton: null,
    closeButton: null,
    filesButton: null,
    organizationButton: null,
    organizationView: null,
    organizationRefreshButton: null,
    organizationStatus: null,
    organizationMeta: null,
    organizationSummary: null,
    organizationPhases: null,
    organizationNodes: null,
    organizationBlockers: null,
    title: null,
    home: null,
    filesView: null,
  };

  function t(key, vars) {
    return root.ragentT ? root.ragentT(key, vars) : key;
  }

  function canUseSidebar() {
    if (typeof visitorMode !== "undefined" && visitorMode) return false;
    if (typeof isAgentScopedMode === "function" && isAgentScopedMode()) return false;
    return true;
  }

  function readStoredWidth() {
    try {
      const value = Number.parseInt(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) || "", 10);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  function writeStoredWidth(width) {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
    } catch {
      // Ignore private-mode storage failures; the live CSS variable still applies.
    }
  }

  function getDesktopMaxWidth() {
    if (!root.matchMedia?.(DESKTOP_QUERY)?.matches) {
      return MAX_SIDEBAR_WIDTH;
    }
    const sidebarWidth = document.querySelector(".sidebar-overlay")?.getBoundingClientRect?.().width || 300;
    const minimumChatWidth = 420;
    const available = root.innerWidth - sidebarWidth - minimumChatWidth;
    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, available));
  }

  function clampSidebarWidth(width) {
    const maxWidth = getDesktopMaxWidth();
    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, width || MIN_SIDEBAR_WIDTH));
  }

  function isMobileSidebarLayout() {
    return root.matchMedia?.(MOBILE_QUERY)?.matches === true;
  }

  function isModalSidebarLayout() {
    return root.matchMedia?.(DESKTOP_QUERY)?.matches !== true;
  }

  function syncModalFocusScope() {
    if (!dom.panel) return;
    const shouldModal = state.open && isModalSidebarLayout();
    if (shouldModal && !focusScopeDeactivate) {
      focusBeforeOpen = document.activeElement;
      dom.panel.setAttribute("role", "dialog");
      dom.panel.setAttribute("aria-labelledby", "rightSidebarTitle");
      focusScopeDeactivate = root.RagentFocusScope?.activate?.(dom.panel, {
        containmentRoot: document.body,
        initialFocus: () => {
          if (dom.closeButton && !dom.closeButton.hidden) return dom.closeButton;
          if (dom.backButton && !dom.backButton.hidden) return dom.backButton;
          return dom.filesButton || dom.title;
        },
        restoreFocus: () => (focusBeforeOpen && focusBeforeOpen.isConnected !== false)
          ? focusBeforeOpen
          : dom.button,
        modal: true,
        onEscape: () => close(),
      }) || null;
      return;
    }
    if (!shouldModal && focusScopeDeactivate) {
      focusScopeDeactivate();
      focusScopeDeactivate = null;
      dom.panel.removeAttribute("role");
      dom.panel.removeAttribute("aria-labelledby");
    }
  }

  function applySidebarWidth(width, { persist = false } = {}) {
    const nextWidth = clampSidebarWidth(width);
    state.width = nextWidth;
    document.documentElement.style.setProperty("--right-sidebar-width", `${Math.round(nextWidth)}px`);
    if (persist) writeStoredWidth(nextWidth);
    return nextWidth;
  }

  function closeWorkbenchInspectorForSidebar() {
    if (typeof root.closeRunSheet === "function") root.closeRunSheet();
  }

  function clearCloseTimer() {
    if (!state.closeTimer) return;
    root.clearTimeout?.(state.closeTimer);
    state.closeTimer = 0;
  }

  function setButtonVisible(visible) {
    if (!dom.button) return;
    dom.button.hidden = !visible;
    if (typeof root.syncMobileDisclosureState === "function") {
      root.syncMobileDisclosureState();
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function knownSessions() {
    if (typeof getChatStoreStateSnapshot === "function") {
      const snapshot = getChatStoreStateSnapshot();
      if (Array.isArray(snapshot?.sessions)) return snapshot.sessions;
    }
    if (typeof sessions !== "undefined" && Array.isArray(sessions)) return sessions;
    return [];
  }

  function currentSession() {
    const sessionId = typeof currentSessionId !== "undefined" ? String(currentSessionId || "").trim() : "";
    if (!sessionId) return null;
    return knownSessions().find((session) => String(session?.id || "") === sessionId) || null;
  }

  function currentSessionIdValue() {
    return typeof currentSessionId !== "undefined" ? String(currentSessionId || "").trim() : "";
  }

  function isRootLeadershipSession(session = currentSession()) {
    return session?.sessionClass === "ROOT_LEADERSHIP"
      && session?.sessionPlane !== "organization"
      && session?.userAddressable !== false;
  }

  function currentOrganizationSession() {
    const session = currentSession();
    return isRootLeadershipSession(session) ? session : null;
  }

  function syncOrganizationEntry() {
    if (!dom.organizationButton) return;
    const visible = canUseSidebar() && !!currentOrganizationSession();
    dom.organizationButton.hidden = !visible;
    if (!visible && state.view === "organization") openHome();
  }

  function setOpen(open, { immediate = false } = {}) {
    state.open = open === true;
    if (state.open) {
      clearCloseTimer();
      closeWorkbenchInspectorForSidebar();
      applySidebarWidth(state.width || readStoredWidth() || 520);
      if (dom.panel) {
        dom.panel.hidden = false;
        void dom.panel.offsetWidth;
      }
    }
    document.body.classList.toggle("right-sidebar-open", state.open);
    if (!state.open && dom.panel) {
      clearCloseTimer();
      if (immediate || dom.panel.hidden) {
        dom.panel.hidden = true;
      } else {
        state.closeTimer = root.setTimeout?.(() => {
          state.closeTimer = 0;
          if (!state.open && dom.panel) dom.panel.hidden = true;
        }, SIDEBAR_CLOSE_ANIMATION_MS) || 0;
      }
    }
    if (dom.button) {
      dom.button.setAttribute("aria-expanded", state.open ? "true" : "false");
    }
    if (typeof root.syncMobileDisclosureState === "function") {
      root.syncMobileDisclosureState();
    }
    syncBackEntry();
    syncModalFocusScope();
  }

  function syncView() {
    const showingFiles = state.view === "files";
    const showingOrganization = state.view === "organization";
    if (dom.home) dom.home.hidden = showingFiles || showingOrganization;
    if (dom.filesView) dom.filesView.hidden = !showingFiles;
    if (dom.organizationView) dom.organizationView.hidden = !showingOrganization;
    if (dom.backButton) dom.backButton.hidden = !(showingFiles || showingOrganization || isMobileSidebarLayout());
    if (dom.title) {
      dom.title.textContent = showingFiles
        ? t("nav.files")
        : (showingOrganization ? t("organization.title") : t("action.sidebar"));
    }
    if (!showingFiles && typeof root.syncWorkspaceFileReaderMount === "function") {
      root.syncWorkspaceFileReaderMount({ active: false });
    }
    const activeView = showingFiles
      ? dom.filesView
      : (showingOrganization ? dom.organizationView : dom.home);
    if (state.open && activeView?.classList) {
      activeView.classList.remove("workspace-file-reader-view-enter");
      void activeView.offsetWidth;
      activeView.classList.add("workspace-file-reader-view-enter");
    }
  }

  function openHome() {
    if (!canUseSidebar()) return false;
    state.view = "home";
    setOpen(true);
    syncView();
    return true;
  }

  function openFiles({ force = false } = {}) {
    if (!canUseSidebar()) return false;
    state.view = "files";
    setOpen(true);
    syncView();
    if (typeof root.syncWorkspaceFileReaderMount === "function") {
      root.syncWorkspaceFileReaderMount({ active: true, force });
    }
    return true;
  }

  function setOrganizationStatus(message, tone = "") {
    if (!dom.organizationStatus) return;
    dom.organizationStatus.textContent = message || "";
    dom.organizationStatus.dataset.tone = tone || "";
  }

  function organizationTime(value) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "";
    try {
      return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
    } catch {
      return new Date(timestamp).toISOString();
    }
  }

  function organizationNodeDepth(nodes, node) {
    let depth = 0;
    const byId = new Map((Array.isArray(nodes) ? nodes : []).map((entry) => [entry.id, entry]));
    const seen = new Set();
    let parentId = node?.parentId || null;
    while (parentId && !seen.has(parentId) && depth < 12) {
      seen.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentId || null;
    }
    return depth;
  }

  function renderOrganizationProjection(projection = state.organizationProjection) {
    if (!projection) return;
    state.organizationProjection = projection;
    const revision = projection.revision?.number || 0;
    const digest = String(projection.revision?.digest || projection.digest || "");
    if (dom.organizationMeta) {
      dom.organizationMeta.textContent = `${t("organization.revision")} ${revision} · ${digest ? digest.slice(0, 20) : ""}`;
    }
    const summary = projection.summary || {};
    if (dom.organizationSummary) {
      const items = [
        [t("organization.state"), projection.state || "unknown"],
        [t("organization.activeTasks"), summary.activeTasks ?? 0],
        [t("organization.blockers"), Array.isArray(projection.blockers) ? projection.blockers.length : 0],
        [t("organization.review"), summary.waitingReview ?? 0],
      ];
      dom.organizationSummary.innerHTML = items.map(([label, value]) => `<div class="organization-summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
    }
    const phases = Array.isArray(projection.phases) ? projection.phases : [];
    if (dom.organizationPhases) {
      dom.organizationPhases.innerHTML = `<h4>${escapeHtml(t("organization.phases"))}</h4>${phases.length === 0
        ? `<div class="organization-empty">${escapeHtml(t("organization.noPhases"))}</div>`
        : `<div class="organization-phase-list">${phases.map((phase) => `<div class="organization-phase-row" data-state="${escapeHtml(phase.state || "planned")}"><span>${escapeHtml(phase.objective || phase.phaseId || "phase")}</span><b>${escapeHtml(phase.state || "planned")}</b></div>`).join("")}</div>`}`;
    }
    const nodes = Array.isArray(projection.nodes) ? projection.nodes : [];
    if (dom.organizationNodes) {
      const rows = nodes.map((node) => {
        const sessionId = String(node.sessionId || node.currentSessionId || "").trim();
        const openButton = sessionId && projection.runtimeCapabilities?.sessionAddressability === true
          ? `<button type="button" class="organization-node-open" data-organization-session-id="${escapeHtml(sessionId)}" title="${escapeHtml(t("organization.openSession"))}" aria-label="${escapeHtml(t("organization.openSession"))}" data-icon="chevron-right"></button>`
          : "";
        return `<div class="organization-node-row" data-state="${escapeHtml(node.status || "unknown")}" style="--organization-node-depth:${organizationNodeDepth(nodes, node)}"><span class="organization-node-role">${escapeHtml(node.role || "node")}</span><span class="organization-node-name">${escapeHtml(node.displayName || node.id || "node")}</span><span class="organization-node-status">${escapeHtml(node.status || "unknown")}</span>${openButton}</div>`;
      }).join("");
      dom.organizationNodes.innerHTML = `<h4>${escapeHtml(t("organization.nodes"))}</h4>${rows || `<div class="organization-empty">${escapeHtml(t("organization.noNodes"))}</div>`}`;
      dom.organizationNodes.querySelectorAll("[data-organization-session-id]").forEach((button) => {
        button.addEventListener("click", () => {
          const id = String(button.dataset.organizationSessionId || "").trim();
          if (id && typeof root.ragentOpenSessionReference === "function") root.ragentOpenSessionReference(id);
        });
      });
      root.RagentIcons?.hydrate?.(dom.organizationNodes);
    }
    const blockers = Array.isArray(projection.blockers) ? projection.blockers : [];
    if (dom.organizationBlockers) {
      dom.organizationBlockers.innerHTML = `<h4>${escapeHtml(t("organization.activeBlockers"))}</h4>${blockers.length === 0
        ? `<div class="organization-empty organization-empty--ok">${escapeHtml(t("organization.noBlockers"))}</div>`
        : `<div class="organization-blocker-list">${blockers.map((blocker) => `<div class="organization-blocker-row"><span>${escapeHtml(blocker.reasonCode || blocker.type || "blocked")}</span><time>${escapeHtml(organizationTime(blocker.createdAt || ""))}</time></div>`).join("")}</div>`}`;
    }
  }

  async function loadOrganizationProjection({ force = false } = {}) {
    const session = currentOrganizationSession();
    if (!session) return null;
    if (state.organizationLoading && !force) return null;
    state.organizationLoading = true;
    dom.organizationRefreshButton?.setAttribute("aria-busy", "true");
    setOrganizationStatus(t("organization.loading"), "muted");
    try {
      const headers = { Accept: "application/json" };
      if (state.organizationEtag && !force) headers["If-None-Match"] = state.organizationEtag;
      const response = await (window.ragentFetch || fetch)(`/api/sessions/${encodeURIComponent(session.id)}/organization/projection`, {
        credentials: "same-origin", cache: "no-store", headers,
      });
      if (response.status === 304) {
        setOrganizationStatus(t("organization.upToDate"), "");
        return state.organizationProjection;
      }
      if (!response.ok) throw new Error(response.status === 404 ? t("organization.notFound") : t("organization.failed"));
      state.organizationEtag = response.headers.get("ETag") || state.organizationEtag;
      const payload = await response.json();
      renderOrganizationProjection(payload?.projection || null);
      setOrganizationStatus(`${t("organization.updated")} ${organizationTime(payload?.projection?.generatedAt || "")}`, "");
      return payload?.projection || null;
    } catch (error) {
      setOrganizationStatus(error?.message || t("organization.failed"), "error");
      return null;
    } finally {
      state.organizationLoading = false;
      dom.organizationRefreshButton?.setAttribute("aria-busy", "false");
    }
  }

  function openOrganization({ force = false } = {}) {
    if (!canUseSidebar() || !currentOrganizationSession()) return false;
    state.view = "organization";
    setOpen(true);
    syncView();
    renderOrganizationProjection(state.organizationProjection);
    void loadOrganizationProjection({ force });
    return true;
  }

  function handleOrganizationInvalidation(message = {}) {
    const current = currentOrganizationSession();
    if (!current || !state.organizationProjection) return;
    if (message.organizationId && message.organizationId !== state.organizationProjection.organizationId) return;
    const nextRevision = Number(message.revision || 0);
    const currentRevision = Number(state.organizationProjection.asOf?.revision || state.organizationProjection.revision?.number || 0);
    if (nextRevision && nextRevision < currentRevision) return;
    if (state.open && state.view === "organization") void loadOrganizationProjection({ force: true });
  }

  function close() {
    setOpen(false);
    root.setTimeout?.(() => {
      if (!state.open && typeof root.syncWorkspaceFileReaderMount === "function") {
        root.syncWorkspaceFileReaderMount({ active: false });
      }
    }, SIDEBAR_CLOSE_ANIMATION_MS);
  }

  function toggleHome() {
    if (state.open && state.view === "home") {
      close();
      return;
    }
    openHome();
  }

  function handleBackButtonClick() {
    if (state.view === "files" || state.view === "organization") {
      openHome();
      return;
    }
    close();
  }

  function handleWorkspaceChange() {
    if (state.open && state.view === "files" && typeof root.syncWorkspaceFileReaderMount === "function") {
      root.syncWorkspaceFileReaderMount({ active: true, force: true });
    }
  }

  function handleResizePointerDown(event) {
    if (!dom.panel || !root.matchMedia?.(DESKTOP_QUERY)?.matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = dom.panel.getBoundingClientRect().width || state.width || 520;
    state.resizing = true;
    document.body.classList.add("right-sidebar-resizing");
    dom.resizeHandle?.setPointerCapture?.(event.pointerId);

    function handlePointerMove(moveEvent) {
      if (!state.resizing) return;
      const nextWidth = startWidth + (startX - moveEvent.clientX);
      applySidebarWidth(nextWidth);
    }

    function handlePointerUp(upEvent) {
      if (!state.resizing) return;
      state.resizing = false;
      document.body.classList.remove("right-sidebar-resizing");
      dom.resizeHandle?.releasePointerCapture?.(upEvent.pointerId);
      applySidebarWidth(state.width || startWidth, { persist: true });
      root.removeEventListener("pointermove", handlePointerMove);
      root.removeEventListener("pointerup", handlePointerUp);
      root.removeEventListener("pointercancel", handlePointerUp);
    }

    root.addEventListener("pointermove", handlePointerMove);
    root.addEventListener("pointerup", handlePointerUp);
    root.addEventListener("pointercancel", handlePointerUp);
  }

  function handleResizeKeydown(event) {
    if (!root.matchMedia?.(DESKTOP_QUERY)?.matches) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.shiftKey ? 48 : 24;
    const direction = event.key === "ArrowLeft" ? 1 : -1;
    applySidebarWidth((state.width || dom.panel?.getBoundingClientRect?.().width || 520) + direction * delta, { persist: true });
  }

  function init() {
    dom.button = document.getElementById("workbenchSidebarBtn");
    dom.panel = document.getElementById("rightSidebar");
    dom.resizeHandle = document.getElementById("rightSidebarResizeHandle");
    dom.backButton = document.getElementById("rightSidebarBackBtn");
    dom.closeButton = document.getElementById("rightSidebarCloseBtn");
    dom.filesButton = document.getElementById("rightSidebarFilesBtn");
    dom.organizationButton = document.getElementById("rightSidebarOrganizationBtn");
    dom.organizationView = document.getElementById("rightSidebarOrganizationView");
    dom.organizationRefreshButton = document.getElementById("organizationRefreshBtn");
    dom.organizationStatus = document.getElementById("organizationStatus");
    dom.organizationMeta = document.getElementById("organizationInspectorMeta");
    dom.organizationSummary = document.getElementById("organizationSummary");
    dom.organizationPhases = document.getElementById("organizationPhases");
    dom.organizationNodes = document.getElementById("organizationNodes");
    dom.organizationBlockers = document.getElementById("organizationBlockers");
    dom.title = document.getElementById("rightSidebarTitle");
    dom.home = document.getElementById("rightSidebarHome");
    dom.filesView = document.getElementById("rightSidebarFilesView");
    if (!dom.button || !dom.panel) return;

    setButtonVisible(canUseSidebar());
    applySidebarWidth(readStoredWidth() || 520);
    setOpen(false, { immediate: true });
    syncOrganizationEntry();
    syncView();

    dom.button.addEventListener("click", toggleHome);
    dom.closeButton?.addEventListener("click", close);
    dom.backButton?.addEventListener("click", handleBackButtonClick);
    dom.filesButton?.addEventListener("click", () => openFiles());
    dom.organizationButton?.addEventListener("click", () => openOrganization({ force: true }));
    dom.organizationRefreshButton?.addEventListener("click", () => loadOrganizationProjection({ force: true }));
    dom.resizeHandle?.addEventListener("pointerdown", handleResizePointerDown);
    dom.resizeHandle?.addEventListener("keydown", handleResizeKeydown);
    root.addEventListener?.("resize", () => {
      if (state.open && root.matchMedia?.(DESKTOP_QUERY)?.matches) {
        applySidebarWidth(state.width || readStoredWidth() || 520);
      }
      syncView();
      syncModalFocusScope();
    });
    root.addEventListener?.("ragent:workspacechange", handleWorkspaceChange);
    const store = typeof getChatStore === "function" ? getChatStore() : null;
    store?.subscribe?.(() => {
      syncOrganizationEntry();
    });
    root.RagentIcons?.hydrate?.(dom.panel);
  }

  root.openRightSidebar = openHome;
  root.openRightSidebarFiles = openFiles;
  root.openRightSidebarOrganization = openOrganization;
  root.handleOrganizationInvalidation = handleOrganizationInvalidation;
  root.showRightSidebarHome = openHome;
  root.closeRightSidebar = close;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})(window);
