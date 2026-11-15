// ---- Sidebar ----
const SESSIONS_SIDEBAR_COLLAPSED_STORAGE_KEY = "ragent.sessionsSidebarCollapsed";
let sidebarSearchMode = false;
let sidebarSearchReturnTab = "sessions";
let sidebarAccountPopoverOpen = false;
let sidebarAccountStatusRequestId = 0;
// Android back button entries for drawer and composer add menu.
let sidebarBackEntryId = null;
let sidebarCloseTransitionTimer = null;
let sidebarOpenMotionTimer = null;
let sidebarHierarchyMotionTimer = null;
let composerAddMenuBackEntryId = null;
let workspacePickerBackEntryId = null;
let sidebarAccountPopoverBackEntryId = null;
let projectCreateDialogBackEntryId = null;
let projectCreateFocusScopeDeactivate = null;
let projectCreateDialogTrigger = null;
let sidebarAgentSearchGeneration = 0;
let sidebarSymbolTransitionCleanup = null;
let sidebarSymbolTransitionToken = 0;

function t(key, vars) {
  return window.ragentT ? window.ragentT(key, vars) : key;
}

function readStoredSessionsSidebarCollapsed() {
  try {
    return localStorage.getItem(SESSIONS_SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistSessionsSidebarCollapsed(collapsed) {
  try {
    localStorage.setItem(SESSIONS_SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {}
}

function isSessionsSidebarCollapsed() {
  return document.body?.classList.contains("sessions-sidebar-collapsed") === true;
}

function syncSessionsSidebarControlState() {
  const collapsed = isDesktop ? isSessionsSidebarCollapsed() : !sidebarOverlay.classList.contains("open");
  menuBtn?.setAttribute("aria-expanded", String(!collapsed));
  closeSidebar?.setAttribute("aria-expanded", String(!collapsed));
}

function setSessionsSidebarCollapsed(collapsed, { persist = true } = {}) {
  const shouldCollapse = collapsed === true && isDesktop;
  document.body?.classList.toggle("sessions-sidebar-collapsed", shouldCollapse);
  sidebarOverlay?.setAttribute("aria-hidden", String(shouldCollapse));
  try {
    sidebarOverlay.inert = shouldCollapse;
  } catch {}
  if (persist && isDesktop) {
    persistSessionsSidebarCollapsed(shouldCollapse);
  }
  syncSessionsSidebarControlState();
  if (typeof requestLayoutPass === "function") {
    requestLayoutPass("sessions-sidebar-collapse");
  }
  return shouldCollapse;
}

function syncSessionsSidebarCollapseState() {
  if (!isDesktop) {
    document.body?.classList.remove("sessions-sidebar-collapsed");
    sidebarOverlay?.setAttribute("aria-hidden", "false");
    try {
      sidebarOverlay.inert = false;
    } catch {}
    syncSessionsSidebarControlState();
    return false;
  }
  return setSessionsSidebarCollapsed(readStoredSessionsSidebarCollapsed(), { persist: false });
}

function openSidebar() {
  if (isDesktop) {
    setSessionsSidebarCollapsed(false);
    return;
  }
  if (sidebarCloseTransitionTimer) {
    window.clearTimeout(sidebarCloseTransitionTimer);
    sidebarCloseTransitionTimer = null;
  }
  if (sidebarOpenMotionTimer) {
    window.clearTimeout(sidebarOpenMotionTimer);
    sidebarOpenMotionTimer = null;
  }
  sidebarOverlay.classList.remove("is-closing", "is-opening");
  void sidebarOverlay.offsetWidth;
  sidebarOverlay.classList.add("open");
  if (!prefersReducedSidebarMotion()) {
    sidebarOverlay.classList.add("is-opening");
    sidebarOpenMotionTimer = window.setTimeout(() => {
      sidebarOpenMotionTimer = null;
      sidebarOverlay.classList.remove("is-opening");
    }, 300);
  }
  syncSessionsSidebarControlState();
  // Android back button: search mode is a layer inside the drawer, so it
  // collapses first, then the drawer itself.
  sidebarBackEntryId = window.RagentBackHandler?.push?.({
    id: "sidebar-drawer",
    onBack: () => {
      if (sidebarSearchMode) {
        setSidebarSearchMode(false, { restoreTab: false });
        return true;
      }
      // Agents/settings subpages are layers inside the drawer: step back
      // to the sessions tab before closing the drawer itself.
      const tab = sidebar?.dataset?.sidebarMode;
      if (tab && tab !== "sessions" && typeof switchTab === "function") {
        if (typeof window.ragentReturnFromSidebarSubpage === "function") {
          window.ragentReturnFromSidebarSubpage();
        } else {
          switchTab(tab === "model-providers" ? "settings" : "sessions");
        }
        return true;
      }
      closeSidebarFn();
      return true;
    },
  }) || null;
}
function closeSidebarFn() {
  clearSidebarSymbolTransition();
  if (sidebarBackEntryId) {
    window.RagentBackHandler?.pop?.(sidebarBackEntryId);
    sidebarBackEntryId = null;
  }
  closeSidebarTransientSurfaces();
  if (sidebarSearchMode) setSidebarSearchMode(false, { restoreTab: false });
  if (isDesktop) {
    setSessionsSidebarCollapsed(true);
    return;
  }
  if (sidebarOpenMotionTimer) {
    window.clearTimeout(sidebarOpenMotionTimer);
    sidebarOpenMotionTimer = null;
  }
  sidebarOverlay.classList.remove("open", "is-opening");
  sidebarOverlay.classList.add("is-closing");
  syncSessionsSidebarControlState();
  const closeDelay = prefersReducedSidebarMotion() ? 0 : 240;
  sidebarCloseTransitionTimer = window.setTimeout(() => {
    sidebarCloseTransitionTimer = null;
    if (!sidebarOverlay.classList.contains("open")) {
      sidebarOverlay.classList.remove("is-closing");
    }
  }, closeDelay);
}

function closeSidebarAccountPopover({ restoreFocus = false } = {}) {
  sidebarAccountPopoverOpen = false;
  if (sidebarAccountPopover) sidebarAccountPopover.hidden = true;
  sidebarAccountBtn?.setAttribute("aria-expanded", "false");
  if (sidebarAccountPopoverBackEntryId) {
    window.RagentBackHandler?.pop?.(sidebarAccountPopoverBackEntryId);
    sidebarAccountPopoverBackEntryId = null;
  }
  if (restoreFocus) sidebarAccountBtn?.focus?.();
}

function sidebarAccountText(key, fallback) {
  const translated = t(key);
  return translated === key ? fallback : translated;
}

function setSidebarAccountButtonState(state, label) {
  if (!sidebarAccountBtn) return;
  if (state) sidebarAccountBtn.dataset.accountState = state;
  else delete sidebarAccountBtn.dataset.accountState;
  const accessibleLabel = label || sidebarAccountText(
    "sidebar.account.action",
    "Account and cross-device sign-in",
  );
  sidebarAccountBtn.title = accessibleLabel;
  sidebarAccountBtn.setAttribute("aria-label", accessibleLabel);
}

function renderSidebarAccountPopover({
  state = "",
  status = "",
  detail = "",
  actionLabel = "",
  action = "",
  actionTone = "primary",
  retry = false,
} = {}) {
  const statusEl = document.getElementById("sidebarAccountStatus");
  const detailEl = document.getElementById("sidebarAccountDetail");
  const actionButton = document.getElementById("sidebarAccountAction");
  const retryButton = document.getElementById("sidebarAccountRetry");
  if (statusEl) statusEl.textContent = status;
  if (detailEl) detailEl.textContent = detail;
  if (actionButton) {
    actionButton.hidden = !actionLabel;
    actionButton.textContent = actionLabel;
    actionButton.dataset.action = action;
    actionButton.dataset.tone = actionTone;
  }
  if (retryButton) retryButton.hidden = !retry;
  setSidebarAccountButtonState(state, status);
}

async function requestSidebarAccountStatus({ force = false } = {}) {
  const requestId = ++sidebarAccountStatusRequestId;
  renderSidebarAccountPopover({
    status: sidebarAccountText("sidebar.account.loading", "Checking sign-in status…"),
    detail: "",
  });
  try {
    // Account status is a read-only badge and the popover can be opened many
    // times during a session. Reuse the shared short-lived cache so a toggle
    // does not create a network round trip on every open; explicit retry still
    // bypasses the cache when the user asks for a fresh result.
    const requestOptions = {
      credentials: "same-origin",
      ...(force ? { revalidate: false } : { cacheMaxAgeMs: 10_000 }),
    };
    const result = typeof window.fetchJsonOrRedirect === "function"
      ? await window.fetchJsonOrRedirect("/api/auth/google/status", requestOptions)
      : await fetch("/api/auth/google/status", requestOptions).then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
        return data;
      });
    const status = result && typeof result.json === "function" ? await result.json() : result;
    if (requestId !== sidebarAccountStatusRequestId) return;
    if (!status?.enabled) {
      renderSidebarAccountPopover({
        state: "unavailable",
        status: sidebarAccountText("sidebar.account.notConfigured", "Google sign-in is not configured"),
        detail: sidebarAccountText("sidebar.account.notConfiguredDetail", "This instance continues to use password sign-in."),
        actionLabel: sidebarAccountText("sidebar.account.openDetails", "Open account details"),
        action: "manage",
        actionTone: "secondary",
      });
      return;
    }
    if (!status.bound) {
      renderSidebarAccountPopover({
        state: "pending",
        status: sidebarAccountText("sidebar.account.readyToBind", "Google sign-in is ready to bind"),
        detail: sidebarAccountText("sidebar.account.readyToBindDetail", "Bind a Google account once to sign in as the owner from other devices."),
        actionLabel: sidebarAccountText("sidebar.account.bind", "Bind Google account"),
        action: "manage",
      });
      return;
    }
    renderSidebarAccountPopover({
      state: "ready",
      status: sidebarAccountText("sidebar.account.enabled", "Google cross-device sign-in is enabled"),
      detail: sidebarAccountText("sidebar.account.enabledDetail", "This Google account can sign in as the owner from other devices."),
      actionLabel: sidebarAccountText("sidebar.account.manage", "Manage cross-device login"),
      action: "manage",
      actionTone: "secondary",
    });
  } catch {
    if (requestId !== sidebarAccountStatusRequestId) return;
    renderSidebarAccountPopover({
      state: "error",
      status: sidebarAccountText("sidebar.account.statusFailed", "Couldn't get account status"),
      detail: sidebarAccountText("sidebar.account.statusFailedDetail", "Check your connection and try again."),
      retry: true,
    });
  }
}

function openSidebarAccountWorkspace() {
  closeSidebarAccountPopover();
  // The workspace records the active element to restore focus on close. Make
  // the persistent account button that origin instead of the just-hidden
  // popover action.
  sidebarAccountBtn?.focus?.({ preventScroll: true });
  const opened = window.RagentCrossDevicePanel?.open?.({ view: "account" });
  if (opened === true) return;
  renderSidebarAccountPopover({
    state: "error",
    status: sidebarAccountText("sidebar.account.openFailed", "Account settings are unavailable"),
    detail: sidebarAccountText("sidebar.account.statusFailedDetail", "Check your connection and try again."),
    retry: true,
  });
  if (sidebarAccountPopover) {
    sidebarAccountPopover.hidden = false;
    sidebarAccountPopoverOpen = true;
    sidebarAccountBtn?.setAttribute("aria-expanded", "true");
    sidebarAccountPopoverBackEntryId = window.RagentBackHandler?.push?.({
      id: "sidebar-account-popover",
      onBack: () => {
        closeSidebarAccountPopover();
        return true;
      },
    }) || null;
  }
}

function closeSidebarTransientSurfaces() {
  closeSidebarAccountPopover();
  if (workspacePickerExpanded) setWorkspacePickerExpanded(false);
}

function clearSidebarSymbolTransition() {
  sidebarSymbolTransitionToken += 1;
  if (typeof sidebarSymbolTransitionCleanup === "function") {
    sidebarSymbolTransitionCleanup();
    sidebarSymbolTransitionCleanup = null;
  }
}

function prefersReducedSidebarMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

function restartSidebarHierarchyMotion() {
  if (prefersReducedSidebarMotion() || !sidebarSessionSurface?.classList) return;
  if (sidebarHierarchyMotionTimer) {
    window.clearTimeout(sidebarHierarchyMotionTimer);
    sidebarHierarchyMotionTimer = null;
  }
  sidebarSessionSurface.classList.remove("is-hierarchy-animating");
  void sidebarSessionSurface.offsetWidth;
  sidebarSessionSurface.classList.add("is-hierarchy-animating");
  sidebarHierarchyMotionTimer = window.setTimeout(() => {
    sidebarHierarchyMotionTimer = null;
    sidebarSessionSurface.classList.remove("is-hierarchy-animating");
  }, 240);
}

function getSidebarSymbolSvg(button) {
  return button?.querySelector?.("svg") || null;
}

const SIDEBAR_SYMBOL_FLIGHT_DURATION = 420;
const SIDEBAR_SYMBOL_REVEAL_DELAY = 88;
const SIDEBAR_SYMBOL_RETURN_DURATION = 420;

/**
 * Open a sidebar subpage from the icon that owns it. The source icon stays the
 * only visible symbol while it flies to the matching header mark; the panel
 * then reveals from that landing point. If the browser cannot animate this
 * safely, the already-complete tab switch remains the fallback.
 */
function openSidebarSubpageWithSymbol(tab, sourceButton) {
  const normalizedTab = typeof normalizeSidebarTab === "function"
    ? normalizeSidebarTab(tab)
    : (tab === "settings" ? "settings" : "agents");
  const sourceSvg = getSidebarSymbolSvg(sourceButton);
  const sourceRect = sourceSvg?.getBoundingClientRect?.() || null;
  if (typeof switchTab !== "function") return;

  const panel = normalizedTab === "agents"
    ? document.getElementById("agentsPanel")
    : normalizedTab === "model-providers"
      ? document.getElementById("modelProvidersPanel")
      : normalizedTab === "harnesses"
        ? document.getElementById("harnessesPanel")
      : normalizedTab === "account-policy"
        ? document.getElementById("accountPolicyPanel")
      : document.getElementById("settingsPanel");
  const shouldMorphPanel = !!panel && !!sourceRect && !prefersReducedSidebarMotion();
  // Mount the destination already clipped before switchTab makes it visible.
  // Otherwise the browser can paint one complete panel between the tab switch
  // and the rAF that measures the shared-symbol landing point.
  if (shouldMorphPanel) panel.classList.add("sidebar-subpage-panel-morph-pending");

  clearSidebarSymbolTransition();
  switchTab(normalizedTab, { animate: false });

  if (!shouldMorphPanel) return;

  const header = sidebarSubpageHeader;
  const subpageIconElement = typeof sidebarSubpageIcon !== "undefined"
    ? sidebarSubpageIcon
    : null;
  const targetSvg = subpageIconElement?.querySelector?.("svg") || null;
  if (!sidebar || !header || header.hidden || !panel || !targetSvg) {
    panel?.classList.remove("sidebar-subpage-panel-morph-pending");
    return;
  }

  const run = () => {
    const targetRect = targetSvg.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    if (!targetRect.width || !targetRect.height || !panelRect.width || !panelRect.height) return;

    const token = ++sidebarSymbolTransitionToken;
    const flight = document.createElement("span");
    flight.className = "sidebar-symbol-flight";
    flight.setAttribute("aria-hidden", "true");
    flight.innerHTML = sourceSvg.outerHTML;
    flight.style.left = `${sourceRect.left - sidebarRect.left + (sourceRect.width - targetRect.width) / 2}px`;
    flight.style.top = `${sourceRect.top - sidebarRect.top + (sourceRect.height - targetRect.height) / 2}px`;
    flight.style.width = `${targetRect.width}px`;
    flight.style.height = `${targetRect.height}px`;
    flight.style.color = getComputedStyle(sourceSvg).color;
    sidebar.appendChild(flight);

    panel.style.setProperty(
      "--sidebar-subpage-origin-x",
      `${targetRect.left - panelRect.left + targetRect.width / 2}px`,
    );
    panel.style.setProperty(
      "--sidebar-subpage-origin-y",
      `${targetRect.top - panelRect.top + targetRect.height / 2}px`,
    );
    panel.classList.remove("sidebar-surface-enter", "sidebar-subpage-panel-reveal");
    panel.classList.add("sidebar-subpage-panel-morph-pending");
    header.classList.add("sidebar-subpage-header-symbol-morphing");

    let revealTimer = 0;
    let settleTimer = 0;
    let flightAnimation = null;
    let revealStarted = false;
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(revealTimer);
      window.clearTimeout(settleTimer);
      flightAnimation?.cancel?.();
      flightAnimation = null;
      settled = true;
      flight.remove();
      panel.classList.remove(
        "sidebar-subpage-panel-morph-pending",
        "sidebar-subpage-panel-reveal",
      );
      panel.style.removeProperty("--sidebar-subpage-origin-x");
      panel.style.removeProperty("--sidebar-subpage-origin-y");
      header.classList.remove(
        "sidebar-subpage-header-symbol-morphing",
        "sidebar-subpage-header-symbol-arrived",
      );
    };
    sidebarSymbolTransitionCleanup = cleanup;

    const startReveal = () => {
      if (settled || token !== sidebarSymbolTransitionToken || revealStarted) return;
      revealStarted = true;
      panel.classList.remove("sidebar-subpage-panel-morph-pending");
      panel.classList.add("sidebar-subpage-panel-reveal");
    };

    const finishFlight = () => {
      if (settled || token !== sidebarSymbolTransitionToken) return;
      window.clearTimeout(revealTimer);
      if (!revealStarted) startReveal();
      settled = true;
      flight.remove();
      header.classList.remove("sidebar-subpage-header-symbol-morphing");
      header.classList.add("sidebar-subpage-header-symbol-arrived");
      settleTimer = window.setTimeout(() => {
        panel.classList.remove("sidebar-subpage-panel-reveal");
        panel.style.removeProperty("--sidebar-subpage-origin-x");
        panel.style.removeProperty("--sidebar-subpage-origin-y");
        header.classList.remove("sidebar-subpage-header-symbol-arrived");
        sidebarSymbolTransitionCleanup = null;
      }, 520);
    };

    // Start the page reveal while the symbol is still travelling and finish
    // both legs on the same beat, so the gesture reads as one continuous move.
    revealTimer = window.setTimeout(startReveal, SIDEBAR_SYMBOL_REVEAL_DELAY);

    if (typeof flight.animate === "function") {
      const dx = targetRect.left - sourceRect.left + (targetRect.width - sourceRect.width) / 2;
      const dy = targetRect.top - sourceRect.top + (targetRect.height - sourceRect.height) / 2;
      flightAnimation = flight.animate(
        [
          { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 },
          { transform: `translate3d(${dx}px, ${dy}px, 0) scale(1.04)`, opacity: 1 },
        ],
        {
          duration: SIDEBAR_SYMBOL_FLIGHT_DURATION,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
          fill: "forwards",
        },
      );
      flightAnimation.addEventListener?.("finish", finishFlight, { once: true });
      const finished = flightAnimation.finished;
      if (finished?.then) finished.then(finishFlight).catch(() => finishFlight());
    } else {
      window.setTimeout(finishFlight, SIDEBAR_SYMBOL_FLIGHT_DURATION);
    }
  };

  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(run);
  } else {
    window.setTimeout(run, 0);
  }
}

function returnFromSidebarSubpageWithSymbol() {
  const normalizeTab = typeof normalizeSidebarTab === "function"
    ? normalizeSidebarTab
    : (value) => ["agents", "settings", "model-providers", "harnesses", "account-policy"].includes(value) ? value : "sessions";
  const currentTab = typeof getActiveSidebarTabValue === "function"
    ? normalizeTab(getActiveSidebarTabValue())
    : normalizeTab(sidebar?.dataset?.sidebarMode || "sessions");
  if (!['agents', 'settings', 'model-providers', 'harnesses', 'account-policy'].includes(currentTab) || typeof switchTab !== "function") {
    if (typeof switchTab === "function") switchTab("sessions");
    return false;
  }

  const headerSvg = sidebarSubpageIcon?.querySelector?.("svg") || null;
  const headerRect = headerSvg?.getBoundingClientRect?.() || null;
  const targetTab = ['model-providers', 'harnesses', 'account-policy'].includes(currentTab) ? "settings" : "sessions";
  const sourceButton = currentTab === "agents"
    ? sidebarAgentBtn
    : currentTab === "model-providers"
      ? document.getElementById("modelProvidersOpenBtn") || sidebarFilterBtn
      : currentTab === "harnesses"
        ? document.getElementById("harnessesOpenBtn") || sidebarFilterBtn
      : currentTab === "account-policy"
        ? document.getElementById("accountPolicyOpenBtn") || sidebarFilterBtn
      : sidebarFilterBtn;
  const shouldAnimate = !prefersReducedSidebarMotion()
    && !!headerSvg
    && !!headerRect?.width
    && !!headerRect?.height
    && !!sourceButton;
  const flightMarkup = headerSvg?.outerHTML || "";

  clearSidebarSymbolTransition();
  switchTab(targetTab, { animate: false });
  if (!shouldAnimate) return true;

  // switchTab("sessions") clears any entrance transition. Start the return
  // only after the destination bottom action is visible and measurable.
  const token = sidebarSymbolTransitionToken;
  const start = () => {
    if (token !== sidebarSymbolTransitionToken) return;
    const sourceSvg = getSidebarSymbolSvg(sourceButton);
    const sourceRect = sourceSvg?.getBoundingClientRect?.() || null;
    const sidebarRect = sidebar?.getBoundingClientRect?.() || null;
    if (!sourceSvg || !sourceRect?.width || !sourceRect?.height || !sidebarRect?.width) return;

    const flight = document.createElement("span");
    flight.className = "sidebar-symbol-flight sidebar-symbol-flight-return";
    flight.setAttribute("aria-hidden", "true");
    flight.innerHTML = flightMarkup;
    flight.style.left = `${headerRect.left - sidebarRect.left + (headerRect.width - sourceRect.width) / 2}px`;
    flight.style.top = `${headerRect.top - sidebarRect.top + (headerRect.height - sourceRect.height) / 2}px`;
    flight.style.width = `${headerRect.width}px`;
    flight.style.height = `${headerRect.height}px`;
    flight.style.color = getComputedStyle(headerSvg).color;
    sidebar.appendChild(flight);

    const previousVisibility = sourceSvg.style.visibility;
    sourceSvg.style.visibility = "hidden";
    sourceButton.classList.add("sidebar-symbol-return-target");

    let animation = null;
    let fallbackTimer = 0;
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(fallbackTimer);
      animation?.cancel?.();
      animation = null;
      settled = true;
      flight.remove();
      sourceSvg.style.visibility = previousVisibility;
      sourceButton.classList.remove("sidebar-symbol-return-target");
      if (sidebarSymbolTransitionCleanup === cleanup) sidebarSymbolTransitionCleanup = null;
    };
    sidebarSymbolTransitionCleanup = cleanup;

    const finish = () => {
      if (settled || token !== sidebarSymbolTransitionToken) return;
      cleanup();
    };
    const dx = sourceRect.left - headerRect.left + (sourceRect.width - headerRect.width) / 2;
    const dy = sourceRect.top - headerRect.top + (sourceRect.height - headerRect.height) / 2;
    const scale = Math.max(0.1, Math.min(1, sourceRect.width / headerRect.width));
    if (typeof flight.animate === "function") {
      animation = flight.animate(
        [
          { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 },
          { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`, opacity: 1 },
        ],
        {
          duration: SIDEBAR_SYMBOL_RETURN_DURATION,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
          fill: "forwards",
        },
      );
      animation.addEventListener?.("finish", finish, { once: true });
      animation.finished?.then(finish).catch(finish);
    } else {
      fallbackTimer = window.setTimeout(finish, SIDEBAR_SYMBOL_RETURN_DURATION);
    }
  };

  if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(start);
  else window.setTimeout(start, 0);
  return true;
}

window.ragentOpenSidebarSubpage = openSidebarSubpageWithSymbol;
window.ragentReturnFromSidebarSubpage = returnFromSidebarSubpageWithSymbol;

function syncSidebarShellState(tab = "sessions") {
  const normalizedTab = typeof normalizeSidebarTab === "function"
    ? normalizeSidebarTab(tab)
    : (["agents", "settings", "model-providers", "harnesses", "account-policy"].includes(tab) ? tab : "sessions");
  if (normalizedTab === "sessions") clearSidebarSymbolTransition();
  const showingSubpage = !sidebarSearchMode && normalizedTab !== "sessions";
  if (sidebar?.dataset) {
    sidebar.dataset.sidebarMode = sidebarSearchMode ? "search" : normalizedTab;
  }
  if (sidebarAppBar) sidebarAppBar.hidden = sidebarSearchMode || showingSubpage;
  // The device bar rides under the app bar: hide it whenever the app bar is
  // hidden (search mode / agents / settings subpages) or the sidebar sits on
  // the L2 project-sessions level (device-bar.js owns the L1/L2 leg).
  if (typeof syncSidebarDeviceBar === "function") syncSidebarDeviceBar();
  if (sidebarSearchModeHeader) sidebarSearchModeHeader.hidden = !sidebarSearchMode;
  if (sidebarSubpageHeader) sidebarSubpageHeader.hidden = !showingSubpage;
  if (sidebarSubpageTitle) {
    sidebarSubpageTitle.textContent = normalizedTab === "agents"
      ? t("nav.agents")
      : normalizedTab === "model-providers"
        ? t("nav.modelProviders")
        : normalizedTab === "harnesses"
          ? t("harnesses.title")
          : normalizedTab === "account-policy"
            ? (document.getElementById("accountPolicyPageTitle")?.textContent || "Permission mode")
        : t("nav.settings");
  }
  if (sidebarSubpageCloseBtn) {
    const closeLabelKey = ["model-providers", "harnesses", "account-policy"].includes(normalizedTab)
      ? "sidebar.subpage.backToSettings"
      : "sidebar.subpage.close";
    const closeLabel = t(closeLabelKey);
    sidebarSubpageCloseBtn.setAttribute("data-i18n-title", closeLabelKey);
    sidebarSubpageCloseBtn.setAttribute("data-i18n-aria-label", closeLabelKey);
    sidebarSubpageCloseBtn.title = closeLabel;
    sidebarSubpageCloseBtn.setAttribute("aria-label", closeLabel);
  }
  const subpageIconElement = typeof sidebarSubpageIcon !== "undefined"
    ? sidebarSubpageIcon
    : null;
  if (subpageIconElement) {
    const iconName = normalizedTab === "agents"
      ? "sparkle-solid"
      : normalizedTab === "account-policy"
        ? "gear-solid"
      : ["model-providers", "harnesses", "account-policy"].includes(normalizedTab)
        ? "terminal"
        : "gear-solid";
    subpageIconElement.setAttribute("data-icon", iconName);
    subpageIconElement.innerHTML = window.RagentIcons?.render?.(iconName) || "";
  }
  // The agents/settings subpages sit inside the second level, so the L2
  // project header (back button + project name) above the subpage header
  // would echo the project name. Hide it on subpages while they own the
  // navigation surface.
  const projectHeaderEl = document.getElementById("sidebarProjectHeader");
  if (projectHeaderEl) {
    projectHeaderEl.hidden = showingSubpage;
  }
  // The sessions tab shows the two-level project navigation (project overview
  // first, then the per-project session list), so the workspace picker row is
  // no longer part of the sessions surface.
  if (sidebarPrimaryNav) {
    sidebarPrimaryNav.hidden = sidebarSearchMode || showingSubpage || normalizedTab === "sessions";
  }
  if (sidebarSessionSurface) sidebarSessionSurface.hidden = showingSubpage;
  if (sidebarBottomActions) sidebarBottomActions.hidden = sidebarSearchMode || showingSubpage;
  if (sidebarSearchMode) {
    closeSidebarTransientSurfaces();
  }
  if (normalizedTab === "sessions" && typeof syncProjectLevelUI === "function") {
    syncProjectLevelUI();
  }
}

async function renderSidebarAgentSearchResults(query) {
  if (!sidebarAgentSearchResults) return;
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  const generation = ++sidebarAgentSearchGeneration;
  sidebarAgentSearchResults.innerHTML = "";
  sidebarAgentSearchResults.hidden = !sidebarSearchMode || !normalizedQuery;
  if (!sidebarSearchMode || !normalizedQuery) return;

  const heading = document.createElement("div");
  heading.className = "sidebar-search-results-heading";
  heading.textContent = t("sidebar.search.agents");
  sidebarAgentSearchResults.appendChild(heading);

  try {
    const agents = await window.RagentManagedAgents?.list?.();
    if (generation !== sidebarAgentSearchGeneration || !sidebarSearchMode) return;
    const matches = (Array.isArray(agents) ? agents : []).filter((agent) => {
      const haystack = [agent?.name, agent?.id, agent?.tool]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return haystack.includes(normalizedQuery);
    });
    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sidebar-search-results-empty";
      empty.textContent = t("sidebar.search.noAgents");
      sidebarAgentSearchResults.appendChild(empty);
      return;
    }
    for (const agent of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sidebar-agent-search-result";
      const icon = document.createElement("span");
      icon.className = "sidebar-agent-search-result-icon";
      icon.innerHTML = window.RagentIcons?.render?.("agent") || "";
      const copy = document.createElement("span");
      copy.className = "sidebar-agent-search-result-copy";
      const name = document.createElement("span");
      name.className = "sidebar-agent-search-result-name";
      name.textContent = agent?.name || agent?.id || t("nav.agents");
      const meta = document.createElement("span");
      meta.className = "sidebar-agent-search-result-meta";
      meta.textContent = agent?.tool || agent?.id || "";
      copy.append(name, meta);
      button.append(icon, copy);
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await window.RagentManagedAgents?.open?.(agent?.id);
        } finally {
          button.disabled = false;
        }
      });
      sidebarAgentSearchResults.appendChild(button);
    }
  } catch (error) {
    if (generation !== sidebarAgentSearchGeneration) return;
    const empty = document.createElement("div");
    empty.className = "sidebar-search-results-empty";
    empty.textContent = error?.message || t("settings.apps.loadingFailed");
    sidebarAgentSearchResults.appendChild(empty);
  }
}

function setSidebarSearchMode(enabled, { restoreTab = true } = {}) {
  const nextEnabled = enabled === true;
  if (nextEnabled === sidebarSearchMode) return;
  if (nextEnabled) {
    sidebarSearchReturnTab = typeof getActiveSidebarTabValue === "function"
      ? getActiveSidebarTabValue()
      : (typeof activeTab === "string" ? activeTab : "sessions");
    if (typeof switchTab === "function" && sidebarSearchReturnTab !== "sessions") {
      switchTab("sessions", { syncState: false });
    }
  }
  sidebarSearchMode = nextEnabled;
  if (!sidebarSearchMode) {
    sidebarAgentSearchGeneration += 1;
    if (sessionSearchInput) sessionSearchInput.value = "";
    sessionSearchQuery = "";
    if (sidebarSessionSearchHeading) sidebarSessionSearchHeading.hidden = true;
    if (sidebarAgentSearchResults) {
      sidebarAgentSearchResults.innerHTML = "";
      sidebarAgentSearchResults.hidden = true;
    }
    renderSessionList();
    if (typeof renderProjectsView === "function") {
      renderProjectsView({ force: true });
    }
    if (restoreTab && sidebarSearchReturnTab !== "sessions" && typeof switchTab === "function") {
      switchTab(sidebarSearchReturnTab);
      return;
    }
  }
  const currentTab = typeof getActiveSidebarTabValue === "function"
    ? getActiveSidebarTabValue()
    : (typeof activeTab === "string" ? activeTab : "sessions");
  syncSidebarShellState(currentTab);
  if (sidebarSearchMode) {
    window.setTimeout(() => sessionSearchInput?.focus?.(), 0);
  } else {
    sidebarSearchBtn?.focus?.();
  }
}

function openSessionsSidebar() {
  if (typeof switchTab === "function") {
    switchTab("sessions");
  }
  // Reopening the sidebar restores the view it was collapsed from: if the
  // user was browsing a project at level two (or a subpage opened from it),
  // coming back lands on that project's session list instead of resetting to
  // the project overview. The two-level state survives the collapse.
  openSidebar();
  return true;
}

function createNewSessionShortcut({
  closeSidebar = true,
  forceComposerFocus = false,
  sourceContext = null,
  projectId = null,
} = {}) {
  if (closeSidebar && !isDesktop) closeSidebarFn();
  const current = typeof getCurrentSession === "function" ? getCurrentSession() : null;
  const tool = selectedTool || preferredTool || toolsList[0]?.id;
  if (!tool) return false;
  if (typeof window.ragentHasActiveProject === "function" && !window.ragentHasActiveProject()) {
    if (typeof window.ragentOpenProjectCreateDialog === "function") {
      void window.ragentOpenProjectCreateDialog();
    }
    return false;
  }
  if (typeof switchTab === "function") {
    switchTab("sessions");
  }
  let rememberedProvider = "";
  let rememberedModel = "";
  if (current?.tool === tool) {
    rememberedProvider = typeof current.providerProfile === "string"
      ? current.providerProfile.trim()
      : "";
    rememberedModel = typeof current.model === "string" ? current.model.trim() : "";
  }
  if (!rememberedProvider && !rememberedModel) {
    // New sessions inherit the owner's most recent provider/model selection
    // for this tool from any session (lastRuntimeSelection_ pairs the two so
    // they cannot go stale relative to each other).
    const lastSelection = typeof getLastGlobalRuntimeSelection === "function"
      ? getLastGlobalRuntimeSelection(tool)
      : null;
    if (!rememberedProvider && lastSelection?.providerProfile) {
      rememberedProvider = lastSelection.providerProfile;
    }
    if (!rememberedModel && lastSelection?.model) {
      rememberedModel = lastSelection.model;
    }
  }
  if (typeof getLastGlobalRuntimeSelection !== "function") {
    try {
      if (!rememberedProvider) rememberedProvider = localStorage.getItem(`selectedProvider_${tool}`) || "";
      if (!rememberedModel) rememberedModel = localStorage.getItem(`selectedModel_${tool}`) || "";
    } catch {}
  }
  // A provider-only pair must stay provider-only; the current UI model may
  // belong to a different provider. Keep this legacy fallback only for a
  // provider-less selection where the model is still safely self-contained.
  if (!rememberedProvider && !rememberedModel && typeof selectedModel === "string") {
    rememberedModel = selectedModel.trim();
  }
  const createPayload = {
    action: "create",
    folder: typeof window.ragentGetSelectedSessionFolder === "function"
      ? window.ragentGetSelectedSessionFolder()
      : (typeof window.ragentGetDefaultSessionFolder === "function"
        ? window.ragentGetDefaultSessionFolder()
        : "~"),
    tool,
    sourceId: DEFAULT_APP_ID,
    sourceName: DEFAULT_WEB_SOURCE_NAME,
    templateId: "",
    templateName: "",
    ...(rememberedProvider ? { providerProfile: rememberedProvider } : {}),
    ...(rememberedModel ? { model: rememberedModel } : {}),
    ...(projectId
      ? { projectId }
      : (typeof window.ragentGetSelectedProjectId === "function" && window.ragentGetSelectedProjectId()
        ? { projectId: window.ragentGetSelectedProjectId() }
        : {})),
    ...(forceComposerFocus ? { forceComposerFocus: true } : {}),
    ...(sourceContext && typeof sourceContext === "object" ? { sourceContext } : {}),
  };
  return dispatchAction(createPayload);
}

// Legacy workspace storage keys retained for getLegacyWorkspaceFolderForProjectSelection
// (project selection reads the old custom-workspace folder to migrate prior selections).
const WORKSPACE_CUSTOM_FOLDER_STORAGE_KEY = "ragent.customWorkspaceFolder";
const WORKSPACE_SELECTION_STORAGE_KEY = "ragent.selectedWorkspaceFolder";

function getDefaultWorkspaceFolder() {
  return typeof window.ragentGetDefaultSessionFolder === "function"
    ? window.ragentGetDefaultSessionFolder()
    : "~";
}

let workspacePickerExpanded = false;
let workspacePopoverCloseTimer = 0;

function getWorkspacePickerElement() {
  return typeof workspacePicker !== "undefined"
    ? workspacePicker
    : document.getElementById("workspacePicker");
}

function setWorkspacePickerExpanded(expanded) {
  const nextExpanded = expanded === true;
  workspacePickerExpanded = nextExpanded;
  syncProjectUi();
  if (nextExpanded) {
    workspacePickerBackEntryId = window.RagentBackHandler?.push?.({
      id: "workspace-picker",
      onBack: () => {
        setWorkspacePickerExpanded(false);
        return true;
      },
    }) || null;
  } else if (workspacePickerBackEntryId) {
    window.RagentBackHandler?.pop?.(workspacePickerBackEntryId);
    workspacePickerBackEntryId = null;
  }
}

function isWorkspaceFloatingPanelTarget(target) {
  const panel = target?.closest?.(".custom-select-panel");
  if (!panel) return false;
  const labelledBy = panel.getAttribute("aria-labelledby") || "";
  const trigger = labelledBy ? document.getElementById(labelledBy) : null;
  const picker = getWorkspacePickerElement();
  if (trigger && picker?.contains?.(trigger)) return true;
  return labelledBy === "workspaceSelect-cs-trigger"
    || labelledBy === "workspaceCustomFolderSelect-cs-trigger"
    || labelledBy === "workspaceBrowserSelect-cs-trigger";
}

function handleWorkspaceOutsidePointerDown(event) {
  if (!workspacePickerExpanded) return;
  const picker = getWorkspacePickerElement();
  if (!picker) return;
  if (picker.contains(event.target) || isWorkspaceFloatingPanelTarget(event.target)) return;
  if (typeof window.ragentCloseProjectPicker === "function") {
    window.ragentCloseProjectPicker();
    return;
  }
  setWorkspacePickerExpanded(false);
}

function handleWorkspaceEscape(event) {
  if (event.key !== "Escape" || !workspacePickerExpanded) return;
  if (typeof window.ragentCloseProjectPicker === "function") {
    window.ragentCloseProjectPicker();
    workspaceSummaryButton?.focus?.();
    return;
  }
  setWorkspacePickerExpanded(false);
  workspaceSummaryButton?.focus?.();
}

function renderWorkspaceSessionList() {
  if (typeof refreshAppCatalog === "function") {
    refreshAppCatalog();
  }
  if (typeof renderSessionList === "function") {
    renderSessionList();
  }
}

function queueWorkspaceSessionListReset({ clearCurrent = true } = {}) {
  if (visitorMode) return Promise.resolve([]);
  const nextState = {
    sessions: [],
    hasLoadedSessions: false,
    archivedSessionCount: 0,
    archivedSessionsLoaded: false,
    archivedSessionsLoading: false,
  };
  if (clearCurrent) {
    nextState.currentSessionId = null;
    nextState.hasAttachedSession = false;
  }
  if (typeof replaceChatState === "function") {
    replaceChatState(nextState, {
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  } else {
    sessions = [];
    if (clearCurrent) {
      currentSessionId = null;
      hasAttachedSession = false;
    }
    hasLoadedSessions = false;
    archivedSessionCount = 0;
    archivedSessionsLoaded = false;
    archivedSessionsLoading = false;
  }
  if (clearCurrent) {
    if (typeof resetAttachedSessionRenderState === "function") {
      resetAttachedSessionRenderState();
    }
    if (typeof persistActiveSessionId === "function") {
      persistActiveSessionId(null);
    }
    if (typeof syncBrowserState === "function") {
      syncBrowserState({
        sessionId: null,
        tab: typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : "sessions",
      });
    }
    if (typeof showEmpty === "function") {
      showEmpty();
    }
    if (typeof updateStatus === "function") {
      updateStatus("connected");
    }
  }
  renderWorkspaceSessionList();
  return Promise.resolve([]);
}

function queueWorkspaceSessionListRefresh({ clearCurrent = false } = {}) {
  if (clearCurrent) {
    queueWorkspaceSessionListReset({ clearCurrent: true });
  }
  if (visitorMode) return Promise.resolve([]);
  if (typeof fetchSessionsList !== "function") return Promise.resolve([]);
  return fetchSessionsList({ forceFresh: true }).catch((error) => {
    console.warn("[workspace] Failed to refresh workspace sessions:", error?.message || error);
    renderWorkspaceSessionList();
    return [];
  });
}

// --- Workspace picker DOM bindings ---
const workspaceSummaryButton = document.getElementById('workspaceSummaryButton');
const workspaceSummaryText = document.getElementById('workspaceSummaryText');
const workspacePopover = document.getElementById('workspacePopover');
const emptyOpenSessionBtn = document.getElementById('emptyOpenSessionBtn');
const emptyCreateAgentBtn = document.getElementById('emptyCreateAgentBtn');

if (workspaceSummaryButton) {
  workspaceSummaryButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeSidebarAccountPopover();
    if (typeof window.ragentToggleProjectPicker === "function") {
      window.ragentToggleProjectPicker();
      return;
    }
    setWorkspacePickerExpanded(!workspacePickerExpanded);
  });
}
document.addEventListener("pointerdown", handleWorkspaceOutsidePointerDown, true);
document.addEventListener("keydown", handleWorkspaceEscape, true);

if (emptyOpenSessionBtn) {
  emptyOpenSessionBtn.addEventListener("click", () => {
    createNewSessionShortcut({
      closeSidebar: true,
      forceComposerFocus: true,
    });
  });
}

if (emptyCreateAgentBtn) {
  emptyCreateAgentBtn.addEventListener("click", () => {
    if (typeof createAgentBuilderSession === "function") {
      void createAgentBuilderSession().catch((error) => {
        console.warn("[workspace] Failed to create agent builder session:", error?.message || error);
      });
      return;
    }
    if (typeof switchTab === "function") {
      switchTab("agents");
      openSidebar();
    }
  });
}

const PROJECT_SELECTION_STORAGE_KEY = "ragent.selectedProjectId";
const projectCreateButton = document.getElementById("projectCreateButton");
const projectList = document.getElementById("projectList");
let projectCatalog = [];
let projectCatalogLoaded = false;
let activeProjectId = "";
let projectCatalogPromise = null;
let projectCreateDialog = null;
let projectFolderPicker = null;
let projectCreateSelectedPath = "";

function normalizeProjectIdValue(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^prj_[a-f0-9]{12,64}$/i.test(trimmed) ? trimmed.toLowerCase() : "";
}

function normalizeProjectRootPath(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getStoredProjectId() {
  try {
    return normalizeProjectIdValue(localStorage.getItem(PROJECT_SELECTION_STORAGE_KEY));
  } catch {
    return "";
  }
}

function persistProjectId(projectId) {
  try {
    if (projectId) localStorage.setItem(PROJECT_SELECTION_STORAGE_KEY, projectId);
    else localStorage.removeItem(PROJECT_SELECTION_STORAGE_KEY);
  } catch {}
}

function getLegacyWorkspaceFolderForProjectSelection() {
  try {
    const explicit = normalizeProjectRootPath(localStorage.getItem(WORKSPACE_CUSTOM_FOLDER_STORAGE_KEY));
    if (explicit) return explicit;
    return normalizeProjectRootPath(localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY));
  } catch {
    return "";
  }
}

function getProjectById(projectId) {
  const normalizedProjectId = normalizeProjectIdValue(projectId);
  if (!normalizedProjectId) return null;
  return projectCatalog.find((project) => normalizeProjectIdValue(project?.id) === normalizedProjectId) || null;
}

function getProjectByRootPath(rootPath) {
  const normalizedRootPath = normalizeProjectRootPath(rootPath);
  if (!normalizedRootPath) return null;
  return projectCatalog.find((project) => normalizeProjectRootPath(project?.rootPath) === normalizedRootPath) || null;
}

function getActiveProject() {
  return getProjectById(activeProjectId);
}

function chooseInitialProjectId(projects = []) {
  const candidates = Array.isArray(projects) ? projects : [];
  const stored = getStoredProjectId();
  if (stored && candidates.some((project) => normalizeProjectIdValue(project?.id) === stored)) return stored;
  if (activeProjectId && candidates.some((project) => normalizeProjectIdValue(project?.id) === activeProjectId)) return activeProjectId;
  const legacyFolder = getLegacyWorkspaceFolderForProjectSelection();
  const legacyProject = legacyFolder
    ? candidates.find((project) => normalizeProjectRootPath(project?.rootPath) === legacyFolder)
    : null;
  if (legacyProject?.id) return normalizeProjectIdValue(legacyProject.id);
  return normalizeProjectIdValue(candidates.find((project) => project?.archived !== true)?.id || "");
}

function resolveProjectApiPath(path) {
  if (typeof window.ragentResolveProductPath === "function") {
    return window.ragentResolveProductPath(path);
  }
  return path;
}

async function fetchProjectCatalog({ force = false } = {}) {
  if (projectCatalogPromise && !force) return projectCatalogPromise;
  projectCatalogPromise = (async () => {
    const response = await (window.ragentFetch || fetch)(resolveProjectApiPath("/api/projects"), {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || "Failed to load projects");
    projectCatalog = Array.isArray(payload?.projects) ? payload.projects : [];
    projectCatalogLoaded = true;
    activeProjectId = chooseInitialProjectId(projectCatalog);
    persistProjectId(activeProjectId);
    syncProjectUi();
    return projectCatalog;
  })();
  try {
    return await projectCatalogPromise;
  } finally {
    projectCatalogPromise = null;
  }
}

function dispatchProjectChange() {
  const project = getActiveProject();
  try {
    window.dispatchEvent(new CustomEvent("ragent:projectchange", {
      detail: {
        project,
        projectId: project?.id || "",
        rootPath: project?.rootPath || "",
      },
    }));
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent("ragent:workspacechange", {
      detail: {
        workspace: project?.rootPath || "",
        mode: "project",
        project,
        projectId: project?.id || "",
      },
    }));
  } catch {}
}

function setActiveProject(projectId, { persist = true, refresh = true, closePicker = true } = {}) {
  const normalizedProjectId = normalizeProjectIdValue(projectId);
  activeProjectId = getProjectById(normalizedProjectId) ? normalizedProjectId : "";
  if (persist) persistProjectId(activeProjectId);
  if (closePicker) setProjectPickerExpanded(false);
  syncProjectUi();
  dispatchProjectChange();
  if (refresh) {
    queueWorkspaceSessionListRefresh({ clearCurrent: true });
  }
  return activeProjectId;
}

function renderProjectList() {
  if (!projectList) return;
  projectList.innerHTML = "";
  if (!projectCatalogLoaded) {
    const loading = document.createElement("div");
    loading.className = "sidebar-project-empty";
    loading.textContent = t("sidebar.project.loading");
    projectList.appendChild(loading);
    return;
  }
  if (projectCatalog.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-project-empty";
    empty.textContent = t("sidebar.project.noneBody");
    projectList.appendChild(empty);
    return;
  }
  for (const project of projectCatalog) {
    const projectId = normalizeProjectIdValue(project?.id);
    if (!projectId) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `sidebar-project-option${projectId === activeProjectId ? " active" : ""}`;
    button.innerHTML = `
      <span class="sidebar-project-option-icon">${window.RagentIcons?.render?.("folder-solid") || ""}</span>
      <span class="sidebar-project-option-copy">
        <span class="sidebar-project-option-name"></span>
        <span class="sidebar-project-option-path"></span>
      </span>
      <span class="sidebar-project-option-count">${Number.isInteger(project.activeSessionCount) ? project.activeSessionCount : 0}</span>`;
    button.querySelector(".sidebar-project-option-name").textContent = project.name || t("sidebar.project.untitled");
    button.querySelector(".sidebar-project-option-path").textContent = project.rootPath || "";
    button.addEventListener("click", () => setActiveProject(projectId));
    projectList.appendChild(button);
  }
}

function getProjectSummaryLabel() {
  const project = getActiveProject();
  if (!project) return t("sidebar.project.none");
  return t("sidebar.project.summary", { name: project.name || t("sidebar.project.untitled") });
}

function syncWorkspacePopoverVisibility() {
  if (!workspacePopover) return;
  if (workspacePopoverCloseTimer) {
    clearTimeout(workspacePopoverCloseTimer);
    workspacePopoverCloseTimer = 0;
  }
  const shouldShow = workspacePickerExpanded === true;
  const isMobile = window.matchMedia?.("(max-width: 767px)")?.matches === true;
  if (shouldShow) {
    workspacePopover.hidden = false;
    workspacePopover.classList.remove("is-closing");
    return;
  }
  if (!isMobile || workspacePopover.hidden) {
    workspacePopover.hidden = true;
    workspacePopover.classList.remove("is-closing");
    return;
  }
  if (workspacePopover.classList.contains("is-closing")) return;
  workspacePopover.classList.add("is-closing");
  workspacePopoverCloseTimer = window.setTimeout(() => {
    workspacePopoverCloseTimer = 0;
    if (!workspacePickerExpanded) {
      workspacePopover.hidden = true;
      workspacePopover.classList.remove("is-closing");
    }
  }, 260);
}

function syncProjectUi() {
  const project = getActiveProject();
  const hasProject = !!project;
  const label = getProjectSummaryLabel();
  if (workspacePicker) {
    workspacePicker.classList.toggle("is-expanded", workspacePickerExpanded);
    workspacePicker.classList.toggle("has-no-project", !hasProject);
  }
  syncWorkspacePopoverVisibility();
  if (workspaceSummaryText) workspaceSummaryText.textContent = label;
  if (workspaceSummaryButton) {
    workspaceSummaryButton.setAttribute("aria-expanded", String(workspacePickerExpanded));
    workspaceSummaryButton.setAttribute("aria-label", label);
    workspaceSummaryButton.title = label;
  }
  if (newSessionBtn) {
    // In the projects (L1) view the button creates a project, so it must
    // stay enabled even with no project on hand; inside a project it
    // creates a session, which requires a project to exist.
    const createMode = typeof getSidebarViewLevel === "function"
      ? getSidebarViewLevel() === "projects"
      : true;
    newSessionBtn.disabled = !createMode && !hasProject;
    newSessionBtn.title = createMode || hasProject ? "" : t("sidebar.project.createFirst");
  }
  if (emptyOpenSessionBtn) {
    emptyOpenSessionBtn.textContent = hasProject
      ? t("emptyState.openSession")
      : t("sidebar.project.create");
  }
  if (emptyCreateAgentBtn) {
    emptyCreateAgentBtn.disabled = !hasProject;
    emptyCreateAgentBtn.title = hasProject ? "" : t("sidebar.project.createFirst");
  }
  renderProjectList();
  if (typeof syncEmptyStateUi === "function") syncEmptyStateUi();
  if (typeof renderSessionList === "function") renderSessionList();
}

function setProjectPickerExpanded(expanded) {
  workspacePickerExpanded = expanded === true;
  syncProjectUi();
}

function toggleProjectPicker() {
  closeSidebarAccountPopover();
  setProjectPickerExpanded(!workspacePickerExpanded);
}

function closeProjectPicker() {
  setProjectPickerExpanded(false);
}

function ensureProjectCreateDialog() {
  if (projectCreateDialog) return projectCreateDialog;
  const dialog = document.createElement("div");
  dialog.className = "project-create-dialog";
  dialog.hidden = true;
  dialog.innerHTML = `
    <div class="project-create-dialog__backdrop" data-project-create-close></div>
    <section class="project-create-dialog__sheet" role="dialog" aria-modal="true" aria-labelledby="projectCreateTitle">
      <header class="project-create-dialog__header">
        <div class="project-create-dialog__title-block">
          <h2 id="projectCreateTitle">${t("sidebar.project.create")}</h2>
          <div class="project-create-dialog__path" id="projectCreateSelectedPath"></div>
        </div>
        <button class="project-create-dialog__close" type="button" aria-label="${t("action.close")}" data-project-create-close data-icon="close"></button>
      </header>
      <div class="project-create-dialog__body">
        <label class="project-create-field">
          <span>${t("sidebar.project.name")}</span>
          <input id="projectCreateName" type="text" autocomplete="off">
        </label>
        <div class="project-create-folder" id="projectCreateFolderPicker"></div>
        <div class="project-create-error" id="projectCreateError" hidden></div>
      </div>
      <footer class="project-create-dialog__actions">
        <button class="project-create-cancel" type="button" data-project-create-close>${t("action.cancel")}</button>
        <button class="project-create-confirm" id="projectCreateConfirm" type="button">${t("sidebar.project.create")}</button>
      </footer>
    </section>`;
  document.body.appendChild(dialog);
  window.RagentIcons?.hydrate?.(dialog);
  dialog.querySelectorAll("[data-project-create-close]").forEach((node) => {
    node.addEventListener("click", closeProjectCreateDialog);
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeProjectCreateDialog();
  });
  dialog.querySelector("#projectCreateConfirm")?.addEventListener("click", () => {
    void submitProjectCreateDialog();
  });
  projectCreateDialog = dialog;
  return dialog;
}

function updateProjectCreateSelectedPath(path) {
  projectCreateSelectedPath = normalizeProjectRootPath(path);
  const dialog = ensureProjectCreateDialog();
  const pathEl = dialog.querySelector("#projectCreateSelectedPath");
  const nameInput = dialog.querySelector("#projectCreateName");
  if (pathEl) pathEl.textContent = projectCreateSelectedPath || t("sidebar.project.folderPath");
  if (nameInput && !nameInput.value.trim() && projectCreateSelectedPath) {
    const parts = projectCreateSelectedPath.replace(/\/+$/, "").split("/").filter(Boolean);
    nameInput.value = parts[parts.length - 1] || t("sidebar.project.untitled");
  }
}

async function openProjectCreateDialog() {
  const dialog = ensureProjectCreateDialog();
  const pickerMount = dialog.querySelector("#projectCreateFolderPicker");
  const nameInput = dialog.querySelector("#projectCreateName");
  const errorEl = dialog.querySelector("#projectCreateError");
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  if (nameInput) nameInput.value = "";
  const startPath = getActiveProject()?.rootPath
    || getLegacyWorkspaceFolderForProjectSelection()
    || getDefaultWorkspaceFolder();
  updateProjectCreateSelectedPath(startPath);
  projectCreateDialogTrigger = document.activeElement;
  projectFolderPicker?.destroy?.();
  projectFolderPicker = window.RagentFolderTreePicker?.create?.({
    container: pickerMount,
    startPath,
    onChange: ({ path }) => updateProjectCreateSelectedPath(path),
  });
  dialog.hidden = false;
  document.body.classList.add("project-create-dialog-open");
  projectCreateFocusScopeDeactivate = window.RagentFocusScope?.activate?.(dialog, {
    containmentRoot: document.body,
    initialFocus: nameInput,
    restoreFocus: () => (projectCreateDialogTrigger && projectCreateDialogTrigger.isConnected !== false)
      ? projectCreateDialogTrigger
      : document.querySelector("main, [role=\"main\"]"),
    modal: true,
    onEscape: () => closeProjectCreateDialog(),
  }) || null;
  nameInput?.focus?.();
  projectCreateDialogBackEntryId = window.RagentBackHandler?.push?.({
    id: "project-create-dialog",
    onBack: () => {
      closeProjectCreateDialog();
      return true;
    },
  }) || null;
}

function closeProjectCreateDialog() {
  if (!projectCreateDialog) return;
  if (projectCreateDialogBackEntryId) {
    window.RagentBackHandler?.pop?.(projectCreateDialogBackEntryId);
    projectCreateDialogBackEntryId = null;
  }
  if (projectCreateFocusScopeDeactivate) {
    projectCreateFocusScopeDeactivate();
    projectCreateFocusScopeDeactivate = null;
  }
  projectCreateDialog.hidden = true;
  document.body.classList.remove("project-create-dialog-open");
}

async function submitProjectCreateDialog() {
  const dialog = ensureProjectCreateDialog();
  const nameInput = dialog.querySelector("#projectCreateName");
  const confirm = dialog.querySelector("#projectCreateConfirm");
  const errorEl = dialog.querySelector("#projectCreateError");
  const rootPath = normalizeProjectRootPath(projectFolderPicker?.getSelectedPath?.() || projectCreateSelectedPath);
  const name = (nameInput?.value || "").trim();
  if (!rootPath) {
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = t("sidebar.project.folderRequired");
    }
    return false;
  }
  confirm.disabled = true;
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  try {
    const response = await (window.ragentFetch || fetch)(resolveProjectApiPath("/api/projects"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ name, rootPath }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 409 && payload?.existingProject?.id) {
        await fetchProjectCatalog({ force: true });
        setActiveProject(payload.existingProject.id);
        closeProjectCreateDialog();
        return true;
      }
      throw new Error(payload?.error || t("sidebar.project.createFailed"));
    }
    await fetchProjectCatalog({ force: true });
    if (payload?.project?.id) {
      setActiveProject(payload.project.id);
    }
    closeProjectCreateDialog();
    return true;
  } catch (error) {
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = error?.message || t("sidebar.project.createFailed");
    }
    return false;
  } finally {
    confirm.disabled = false;
  }
}

projectCreateButton?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeProjectPicker();
  void openProjectCreateDialog();
});

window.ragentEnsureProjectsReady = function ragentEnsureProjectsReady(options = {}) {
  return fetchProjectCatalog(options);
};
window.ragentGetProjects = function ragentGetProjects() {
  return projectCatalog.slice();
};
window.ragentGetSelectedProjectId = function ragentGetSelectedProjectId() {
  // Level-two browsing scopes the "selected" project: session-creation paths
  // (agents panel, managed apps, new-session shortcuts) resolve against the
  // project the user is inside, falling back to the persisted selection
  // elsewhere. The backend keys sessions by folder, so this only needs to
  // agree with ragentGetSelectedSessionFolder below.
  if (typeof window.ragentGetBrowsingProject === "function") {
    const browsing = window.ragentGetBrowsingProject();
    if (browsing?.id) return String(browsing.id).trim();
  }
  return activeProjectId;
};
window.ragentGetSelectedProject = function ragentGetSelectedProject() {
  const project = getActiveProject();
  return project ? { ...project } : null;
};
window.ragentHasProjects = function ragentHasProjects() {
  return projectCatalog.length > 0;
};
window.ragentHasActiveProject = function ragentHasActiveProject() {
  return !!getActiveProject();
};
window.ragentGetSelectedSessionFolder = function ragentGetSelectedSessionFolder() {
  // Matches ragentGetSelectedProjectId: while a project is being browsed at
  // level two, new sessions (agents panel, managed apps, …) land in THAT
  // project's root path — the backend assigns project membership by folder.
  if (typeof window.ragentGetBrowsingProject === "function") {
    const browsing = window.ragentGetBrowsingProject();
    if (browsing?.rootPath) return browsing.rootPath;
  }
  return getActiveProject()?.rootPath || "";
};
window.ragentSetSelectedSessionFolder = function ragentSetSelectedSessionFolder(folder) {
  const project = getProjectByRootPath(folder);
  return project ? setActiveProject(project.id, { refresh: true }) : "";
};
window.ragentSetSelectedSessionFolderForNavigation = function ragentSetSelectedSessionFolderForNavigation(folder) {
  const project = getProjectByRootPath(folder);
  return project ? setActiveProject(project.id, { refresh: false }) : "";
};
window.ragentSessionMatchesSelectedWorkspace = function ragentSessionMatchesSelectedWorkspace(session) {
  const activeProject = getActiveProject();
  if (!activeProject) return false;
  if (session?.projectId) return normalizeProjectIdValue(session.projectId) === activeProject.id;
  return normalizeProjectRootPath(session?.folder) === normalizeProjectRootPath(activeProject.rootPath);
};
window.ragentRefreshWorkspaceSessions = function ragentRefreshWorkspaceSessions() {
  return queueWorkspaceSessionListRefresh();
};
window.ragentOpenProjectCreateDialog = openProjectCreateDialog;
window.ragentToggleProjectPicker = toggleProjectPicker;
window.ragentCloseProjectPicker = closeProjectPicker;

window.syncSessionsSidebarCollapseState = syncSessionsSidebarCollapseState;
window.ragentSetSessionsSidebarCollapsed = setSessionsSidebarCollapsed;
syncSessionsSidebarCollapseState();

window.ragentProjectsReady = fetchProjectCatalog().catch((error) => {
  console.warn("[projects] Failed to load projects:", error?.message || error);
  projectCatalogLoaded = true;
  projectCatalog = [];
  activeProjectId = "";
  syncProjectUi();
  return [];
});

function createSortSessionListShortcut() {
  return organizeSessionListWithAgent({ closeSidebar: false });
}

menuBtn.addEventListener("click", openSessionsSidebar);
closeSidebar.addEventListener("click", closeSidebarFn);
sidebarSessionSurface?.addEventListener("click", (event) => {
  const header = event.target?.closest?.(
    ".folder-group-header, .archived-section-header",
  );
  if (!header || !sidebarSessionSurface.contains(header)) return;
  restartSidebarHierarchyMotion();
});
sidebarSearchBtn?.addEventListener("click", () => setSidebarSearchMode(true));
sidebarSearchCloseBtn?.addEventListener("click", () => setSidebarSearchMode(false));
sidebarSubpageCloseBtn?.addEventListener("click", () => {
  if (typeof window.ragentReturnFromSidebarSubpage === "function") {
    window.ragentReturnFromSidebarSubpage();
  } else if (typeof switchTab === "function") {
    switchTab(["model-providers", "harnesses", "account-policy"].includes(sidebar?.dataset?.sidebarMode) ? "settings" : "sessions");
  }
});
// The Agent mark opens the agents panel and carries its symbol into the page
// header so the level change has one visible owner.
sidebarAgentBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeSidebarAccountPopover();
  if (workspacePickerExpanded && typeof window.ragentCloseProjectPicker === "function") window.ragentCloseProjectPicker();
  else if (workspacePickerExpanded) setWorkspacePickerExpanded(false);
  openSidebarSubpageWithSymbol("agents", event.currentTarget || sidebarAgentBtn);
});
// The bottom-right Settings button replaces the retired source filter entry;
// its solid gear follows the same shared-symbol transition.
sidebarFilterBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeSidebarAccountPopover();
  if (workspacePickerExpanded && typeof window.ragentCloseProjectPicker === "function") window.ragentCloseProjectPicker();
  else if (workspacePickerExpanded) setWorkspacePickerExpanded(false);
  openSidebarSubpageWithSymbol("settings", event.currentTarget || sidebarFilterBtn);
});
sidebarAccountBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (workspacePickerExpanded && typeof window.ragentCloseProjectPicker === "function") window.ragentCloseProjectPicker();
  else if (workspacePickerExpanded) setWorkspacePickerExpanded(false);
  sidebarAccountPopoverOpen = !sidebarAccountPopoverOpen;
  if (sidebarAccountPopover) sidebarAccountPopover.hidden = !sidebarAccountPopoverOpen;
  sidebarAccountBtn.setAttribute("aria-expanded", String(sidebarAccountPopoverOpen));
  if (sidebarAccountPopoverOpen) {
    void requestSidebarAccountStatus();
    sidebarAccountPopoverBackEntryId = window.RagentBackHandler?.push?.({
      id: "sidebar-account-popover",
      onBack: () => {
        closeSidebarAccountPopover();
        return true;
      },
    }) || null;
  } else {
    closeSidebarAccountPopover();
  }
});
document.getElementById("sidebarAccountAction")?.addEventListener("click", (event) => {
  event.preventDefault();
  if (event.currentTarget?.dataset?.action === "manage") openSidebarAccountWorkspace();
});
document.getElementById("sidebarAccountRetry")?.addEventListener("click", (event) => {
  event.preventDefault();
  void requestSidebarAccountStatus({ force: true });
});
sidebarOverlay.addEventListener("click", (e) => {
  if (e.target === sidebarOverlay && !isDesktop) closeSidebarFn();
});
document.addEventListener("pointerdown", (event) => {
  if (
    sidebarAccountPopoverOpen
    && !sidebarAccountPopover?.contains?.(event.target)
    && !sidebarAccountBtn?.contains?.(event.target)
  ) {
    closeSidebarAccountPopover();
  }
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (sidebarSearchMode) {
    event.preventDefault();
    setSidebarSearchMode(false);
    return;
  }
  if (sidebarAccountPopoverOpen) {
    closeSidebarAccountPopover({ restoreFocus: true });
  }
}, true);

// ---- Session search ----
if (sessionSearchInput) {
  let searchDebounceTimer = null;
  sessionSearchInput.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      sessionSearchQuery = (sessionSearchInput.value || "").trim();
      if (sidebarSessionSearchHeading) {
        sidebarSessionSearchHeading.hidden = !sidebarSearchMode || !sessionSearchQuery;
      }
      renderSessionList();
      void renderSidebarAgentSearchResults(sessionSearchQuery);
      if (typeof renderProjectsView === "function") {
        renderProjectsView({ force: true });
      }
      if (typeof syncProjectLevelUI === "function") {
        syncProjectLevelUI();
      }
    }, 120);
  });
  sessionSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setSidebarSearchMode(false);
    }
  });
}

// ---- Session list actions ----
if (sortSessionListBtn) {
  sortSessionListBtn.addEventListener("click", () => {
    void createSortSessionListShortcut();
  });
}

newSessionBtn.addEventListener("click", () => {
  // First level: the bottom action creates a project; second level it creates
  // a session inside the browsed project.
  const level = typeof getSidebarViewLevel === "function"
    ? getSidebarViewLevel()
    : "projects";
  if (level === "projects") {
    if (typeof window.ragentOpenProjectCreateDialog === "function") {
      void window.ragentOpenProjectCreateDialog();
    }
    return;
  }
  const projectId = typeof getBrowsingProjectId === "function"
    ? getBrowsingProjectId()
    : "";
  createNewSessionShortcut({ projectId });
});

// ---- Attachment handling ----
function createComposerAttachmentLocalId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `cattach_${crypto.randomUUID()}`;
  }
  if (typeof createRequestId === "function") {
    return `cattach_${createRequestId()}`;
  }
  return `cattach_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildPendingAttachment(file) {
  const shouldTrackUpload = typeof shouldUseDirectComposerAssetUploads === "function"
    && shouldUseDirectComposerAssetUploads();
  return {
    localId: createComposerAttachmentLocalId(),
    file,
    originalName: typeof file?.name === "string" ? file.name : "",
    mimeType: file.type || "application/octet-stream",
    ...(Number.isFinite(file?.size) ? { sizeBytes: file.size } : {}),
    objectUrl: URL.createObjectURL(file),
    ...(shouldTrackUpload ? { uploadState: "queued" } : {}),
  };
}

async function addAttachmentFiles(files) {
  if (typeof hasPendingComposerSend === "function" && hasPendingComposerSend()) {
    return;
  }
  if (!currentSessionId) {
    return;
  }
  const pendingAttachments = Array.from(files || [], (file) => buildPendingAttachment(file));
  if (typeof addComposerAttachmentsState === "function") {
    addComposerAttachmentsState(
      pendingAttachments,
      { sessionId: currentSessionId },
    );
  }
  renderImagePreviews();
  const eagerUploadLocalIds = pendingAttachments
    .filter((attachment) => attachment?.uploadState === "queued")
    .map((attachment) => attachment?.localId)
    .filter((localId) => typeof localId === "string" && localId);
  if (typeof ensureComposerAttachmentUploads === "function" && eagerUploadLocalIds.length > 0) {
    void ensureComposerAttachmentUploads(currentSessionId, {
      localIds: eagerUploadLocalIds,
    }).catch(() => {});
  }
}

function toComposerDragList(value) {
  if (!value) return [];
  try {
    return Array.from(value);
  } catch {
    const length = Number(value.length) || 0;
    const entries = [];
    for (let index = 0; index < length; index += 1) {
      const entry = typeof value.item === "function" ? value.item(index) : value[index];
      if (entry) entries.push(entry);
    }
    return entries;
  }
}

function hasDataTransferAttachmentFiles(dataTransfer) {
  if (!dataTransfer) return false;
  const types = toComposerDragList(dataTransfer.types);
  if (types.includes("Files")) return true;
  return toComposerDragList(dataTransfer.items).some((item) => item?.kind === "file");
}

function getDataTransferAttachmentFiles(dataTransfer) {
  if (!dataTransfer) return [];
  const files = toComposerDragList(dataTransfer.files).filter(Boolean);
  if (files.length > 0) return files;
  return toComposerDragList(dataTransfer.items)
    .filter((item) => item?.kind === "file" && typeof item.getAsFile === "function")
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

function canAcceptComposerFileDrop() {
  if (!currentSessionId) return false;
  if (typeof inputArea !== "undefined" && inputArea?.hidden) return false;
  if (typeof msgInput !== "undefined" && (msgInput?.disabled || msgInput?.readOnly)) return false;
  if (typeof imgBtn !== "undefined" && imgBtn?.disabled) return false;
  if (typeof hasPendingComposerSend === "function" && hasPendingComposerSend()) return false;
  return true;
}

function setComposerFileDragActive(active) {
  if (typeof inputArea === "undefined" || !inputArea?.classList) return;
  inputArea.classList.toggle("is-file-drag-over", active === true);
}

function applyComposerFileDropEffect(event) {
  if (!event?.dataTransfer) return;
  event.dataTransfer.dropEffect = canAcceptComposerFileDrop() ? "copy" : "none";
}

let composerFileDragDepth = 0;

function resetComposerFileDragState() {
  composerFileDragDepth = 0;
  setComposerFileDragActive(false);
}

function handleComposerFileDragEnter(event) {
  if (!hasDataTransferAttachmentFiles(event?.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  composerFileDragDepth += 1;
  setComposerFileDragActive(canAcceptComposerFileDrop());
  applyComposerFileDropEffect(event);
}

function handleComposerFileDragOver(event) {
  if (!hasDataTransferAttachmentFiles(event?.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  setComposerFileDragActive(canAcceptComposerFileDrop());
  applyComposerFileDropEffect(event);
}

function handleComposerFileDragLeave(event) {
  if (!hasDataTransferAttachmentFiles(event?.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  composerFileDragDepth = Math.max(0, composerFileDragDepth - 1);
  if (composerFileDragDepth === 0) {
    setComposerFileDragActive(false);
  }
}

async function handleComposerFileDrop(event) {
  if (!hasDataTransferAttachmentFiles(event?.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  const files = getDataTransferAttachmentFiles(event.dataTransfer);
  resetComposerFileDragState();
  closeComposerAddMenu();
  if (files.length === 0 || !canAcceptComposerFileDrop()) return;
  await addAttachmentFiles(files);
  if (typeof focusComposer === "function") {
    focusComposer({ preventScroll: true });
  } else if (typeof msgInput !== "undefined" && typeof msgInput?.focus === "function") {
    msgInput.focus();
  }
}

function getComposerAttachmentUploadMeta(attachment) {
  switch (attachment?.uploadState) {
    case "queued":
      return {
        badgeClassName: "is-queued",
        label: t("compose.attachment.queued"),
      };
    case "uploading":
      return {
        badgeClassName: "is-uploading",
        label: t("compose.attachment.uploading"),
      };
    case "uploaded":
      return {
        badgeClassName: "is-uploaded",
        label: t("compose.attachment.uploaded"),
      };
    case "failed":
      return {
        badgeClassName: "is-failed",
        label: t("compose.attachment.failed"),
        title: attachment?.uploadError || t("compose.attachment.failed"),
      };
    default:
      return null;
  }
}

function renderImagePreviews() {
  if (typeof syncComposerSendAvailability === "function") {
    syncComposerSendAvailability();
  }
  const pendingImages = currentSessionId && typeof getComposerAttachmentsState === "function"
    ? getComposerAttachmentsState(currentSessionId)
    : [];
  imgPreviewStrip.innerHTML = "";
  if (pendingImages.length === 0) {
    imgPreviewStrip.classList.remove("has-images");
    if (typeof requestLayoutPass === "function") {
      requestLayoutPass("composer-images");
    } else if (typeof syncInputHeightForLayout === "function") {
      syncInputHeightForLayout();
    }
    return;
  }
  imgPreviewStrip.classList.add("has-images");
  const attachmentsLocked = typeof hasPendingComposerSend === "function" && hasPendingComposerSend();
  pendingImages.forEach((img, i) => {
    const item = document.createElement("div");
    item.className = "img-preview-item";
    const previewNode = createComposerAttachmentPreviewNode(img);
    const uploadMeta = getComposerAttachmentUploadMeta(img);
    if (uploadMeta?.badgeClassName) {
      item.classList.add(uploadMeta.badgeClassName);
    }
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-img";
    removeBtn.type = "button";
    removeBtn.title = t("action.removeAttachment");
    removeBtn.setAttribute("aria-label", t("action.removeAttachment"));
    removeBtn.innerHTML = renderUiIcon("close");
    removeBtn.disabled = attachmentsLocked;
    removeBtn.onclick = () => {
      if (attachmentsLocked) return;
      if (typeof cancelComposerAttachmentUpload === "function" && img?.localId) {
        cancelComposerAttachmentUpload(currentSessionId, img.localId);
      }
      if (img?.objectUrl) {
        URL.revokeObjectURL(img.objectUrl);
      }
      if (typeof removeComposerAttachmentState === "function") {
        removeComposerAttachmentState(i, { sessionId: currentSessionId });
      }
      renderImagePreviews();
    };
    if (previewNode) {
      item.appendChild(previewNode);
    }
    if (uploadMeta) {
      const statusBadge = document.createElement("div");
      statusBadge.className = `attachment-upload-badge ${uploadMeta.badgeClassName}`;
      statusBadge.textContent = uploadMeta.label;
      if (uploadMeta.title) {
        statusBadge.title = uploadMeta.title;
      }
      item.appendChild(statusBadge);
    }
    if (!attachmentsLocked && img?.uploadState === "failed" && img?.localId && typeof retryComposerAttachmentUpload === "function") {
      const retryBtn = document.createElement("button");
      retryBtn.className = "retry-img-upload";
      retryBtn.type = "button";
      retryBtn.textContent = "↻";
      retryBtn.title = t("action.retryUpload");
      retryBtn.setAttribute("aria-label", t("action.retryUpload"));
      retryBtn.onclick = () => {
        void retryComposerAttachmentUpload(currentSessionId, img.localId).catch(() => {});
      };
      item.appendChild(retryBtn);
    }
    item.appendChild(removeBtn);
    imgPreviewStrip.appendChild(item);
  });
  if (typeof requestLayoutPass === "function") {
    requestLayoutPass("composer-images");
  } else if (typeof syncInputHeightForLayout === "function") {
    syncInputHeightForLayout();
  }
}

let composerAddMenuOpen = false;

function setComposerAddMenuOpen(open) {
  if (!composerAddMenu || !imgBtn) return;
  const canOpen = open === true
    && !imgBtn.disabled
    && !(typeof hasPendingComposerSend === "function" && hasPendingComposerSend());
  composerAddMenuOpen = canOpen;
  window.RagentComposerMenuPortal?.sync(composerAddMenu, imgBtn, canOpen, {
    align: "left",
  });
  if (window.RagentMotion?.setPresence) {
    window.RagentMotion.setPresence(composerAddMenu, canOpen, {
      duration: 160,
    });
  } else {
    composerAddMenu.hidden = !canOpen;
  }
  imgBtn.setAttribute("aria-expanded", canOpen ? "true" : "false");
  inputArea?.classList.toggle("composer-add-menu-open", canOpen);
  if (canOpen) {
    composerAddMenuBackEntryId = window.RagentBackHandler?.push?.({
      id: "composer-add-menu",
      onBack: () => {
        setComposerAddMenuOpen(false);
        return true;
      },
    }) || null;
  } else if (composerAddMenuBackEntryId) {
    window.RagentBackHandler?.pop?.(composerAddMenuBackEntryId);
    composerAddMenuBackEntryId = null;
  }
}

function closeComposerAddMenu() {
  setComposerAddMenuOpen(false);
}
// Exposed so the fullscreen composer can collapse a leftover add menu when it
// closes (the trigger is re-parented and must not leave a floating menu).
window.RagentComposerAddMenu = Object.freeze({ close: closeComposerAddMenu });

function toggleComposerAddMenu() {
  setComposerAddMenuOpen(!composerAddMenuOpen);
}

imgBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleComposerAddMenu();
});

composerAddMenu?.addEventListener("click", (event) => {
  event.stopPropagation();
});

composerAttachFilesBtn?.addEventListener("click", () => {
  closeComposerAddMenu();
  if (typeof hasPendingComposerSend === "function" && hasPendingComposerSend()) {
    return;
  }
  imgFileInput.click();
});

composerPlanMenuItem?.addEventListener("click", () => {
  const isPlan = typeof isComposerPlanMode === "function"
    ? isComposerPlanMode()
    : inlineAgentSelect?.value === "__plan";
  if (typeof setComposerInteractionMode === "function") {
    setComposerInteractionMode(isPlan ? "chat" : "plan");
  }
  closeComposerAddMenu();
});

composerAgentsMenuItem?.addEventListener("click", () => {
  closeComposerAddMenu();
  if (typeof window.RagentAgentPanel?.open === "function") {
    window.RagentAgentPanel.open();
    return;
  }
  if (typeof switchTab === "function") switchTab("agents");
  if (typeof openSidebar === "function") openSidebar();
});

composerConnectorsMenuItem?.addEventListener("click", () => {
  closeComposerAddMenu();
  if (typeof window.RagentConnectorPanel?.open === "function") {
    window.RagentConnectorPanel.open();
    return;
  }
  if (typeof switchTab === "function") switchTab("settings");
  if (typeof openSidebar === "function") openSidebar();
});

composerPlanChip?.addEventListener("click", () => {
  if (typeof setComposerInteractionMode === "function") {
    setComposerInteractionMode("chat");
  }
});

document.addEventListener("click", (event) => {
  if (!composerAddMenuOpen) return;
  const target = event.target;
  if (
    target instanceof Node
    && inputArea
    && !inputArea.contains(target)
  ) {
    closeComposerAddMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && composerAddMenuOpen) {
    closeComposerAddMenu();
  }
});

imgFileInput.addEventListener("change", () => {
  if (imgFileInput.files.length > 0) addAttachmentFiles(imgFileInput.files);
  imgFileInput.value = "";
});

inputArea?.addEventListener("dragenter", handleComposerFileDragEnter);
inputArea?.addEventListener("dragover", handleComposerFileDragOver);
inputArea?.addEventListener("dragleave", handleComposerFileDragLeave);
inputArea?.addEventListener("drop", (event) => {
  void handleComposerFileDrop(event);
});
window.addEventListener("dragend", resetComposerFileDragState);
window.addEventListener("drop", (event) => {
  if (hasDataTransferAttachmentFiles(event?.dataTransfer)) {
    resetComposerFileDragState();
  }
});

function handleComposerPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const attachmentFiles = [];
  for (const item of items) {
    const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
    if (file) attachmentFiles.push(file);
  }
  if (attachmentFiles.length > 0) {
    // Also keep the event away from the Markdown editor's own paste handler:
    // with no upload backend it would embed the image as an inline base64
    // <img> in the draft instead of leaving it to the attachment flow.
    e.preventDefault();
    e.stopPropagation();
    addAttachmentFiles(attachmentFiles);
  }
}
msgInput.addEventListener("paste", handleComposerPaste);

// Vditor binds its own paste/drop listeners on the editable element and calls
// stopPropagation() before Ragent's bubble-phase listeners can see the
// transfer, so file pastes and drops landed inside the draft as inline base64
// images. Binding the attachment routing in the capture phase on each editor
// shell runs before Vditor's listeners; non-file transfers are ignored here
// and keep flowing into the editor untouched.
for (const composerShellId of ["composerEditor", "composerFullscreenEditor"]) {
  const composerShell = document.getElementById(composerShellId);
  if (!composerShell) continue;
  composerShell.addEventListener("paste", handleComposerPaste, true);
  composerShell.addEventListener("dragenter", handleComposerFileDragEnter, true);
  composerShell.addEventListener("dragover", handleComposerFileDragOver, true);
  composerShell.addEventListener("dragleave", handleComposerFileDragLeave, true);
  composerShell.addEventListener("drop", (event) => {
    void handleComposerFileDrop(event);
  }, true);
}
