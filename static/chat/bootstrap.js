"use strict";

const buildInfo = window.__RAGENT_BUILD__ || {};
const pageBootstrap =
  window.__RAGENT_BOOTSTRAP__ && typeof window.__RAGENT_BOOTSTRAP__ === "object"
    ? window.__RAGENT_BOOTSTRAP__
    : {};
const buildAssetVersion = buildInfo.assetVersion || "dev";
const bootstrapT = window.ragentT || ((key) => key);

function normalizeBootstrapText(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized || "";
}

const COMPOSER_MENU_PORTAL_Z_INDEX = 200;
const COMPOSER_MENU_SHEET_QUERY = "(max-width: 767px)";

function shouldPortalComposerMenus() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function isMobileComposerSheet() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(COMPOSER_MENU_SHEET_QUERY).matches;
}

function positionComposerPortaledMenu(menu, trigger, { align = "right" } = {}) {
  if (
    !menu
    || !trigger
    || typeof document === "undefined"
    || !document.body
    || !shouldPortalComposerMenus()
  ) {
    return;
  }

  if (menu.parentNode !== document.body) {
    document.body.appendChild(menu);
  }
  menu.classList.add("composer-menu--portaled");
  const sheet = isMobileComposerSheet()
    && !menu.classList.contains("composer-add-menu")
    && !menu.classList.contains("composer-runtime-speed-panel");
  menu.classList.toggle("composer-menu--sheet", sheet);
  menu.style.setProperty("position", "fixed", "important");
  // While the fullscreen composer is open, portaled menus must clear its
  // z-index (300) so the add/runtime menus opened from the re-parented
  // triggers render above the overlay instead of behind it.
  const aboveFullscreen = !!(typeof document !== "undefined"
    && document.body.classList.contains("composer-fullscreen-open"));
  menu.style.setProperty("z-index", String(aboveFullscreen ? 320 : COMPOSER_MENU_PORTAL_Z_INDEX), "important");
  menu.style.setProperty("right", "auto", "important");
  menu.style.setProperty("bottom", "auto", "important");

  const viewport = window.visualViewport;
  const viewportWidth = Math.max(1, Math.floor(
    viewport?.width || document.documentElement.clientWidth || window.innerWidth || 1,
  ));
  const viewportLeft = Math.floor(viewport?.offsetLeft || 0);
  const viewportTop = Math.floor(viewport?.offsetTop || 0);
  const margin = sheet ? 8 : 10;
  const gap = sheet ? 12 : 10;
  const isSpeedPanel = menu.classList.contains("composer-runtime-speed-panel");
  if (isSpeedPanel) {
    // Keep the speed panel's width deterministic after it is moved under
    // body. This avoids shrink-to-fit differences between mobile WebViews.
    menu.style.width = `${Math.max(1, Math.min(252, viewportWidth - margin * 2))}px`;
  }
  const triggerRect = trigger.getBoundingClientRect();
  const availableAbove = Math.max(96, Math.floor(triggerRect.top - viewportTop - gap - margin));

  menu.style.maxHeight = `${Math.min(420, availableAbove)}px`;

  const wasHidden = menu.hidden;
  const previousVisibility = menu.style.visibility;
  if (wasHidden) menu.hidden = false;
  menu.style.visibility = "hidden";
  const menuRect = menu.getBoundingClientRect();
  const menuWidth = Math.max(1, Math.ceil(menuRect.width || Math.min(288, viewportWidth - margin * 2)));
  const menuHeight = Math.max(1, Math.ceil(menuRect.height || Math.min(availableAbove, 360)));
  if (wasHidden) menu.hidden = true;
  menu.style.visibility = previousVisibility;

  const minLeft = viewportLeft + margin;
  const maxLeft = viewportLeft + Math.max(margin, viewportWidth - menuWidth - margin);
  const triggerCenter = triggerRect.left + triggerRect.width / 2;
  const preferredLeft = sheet
    ? viewportLeft + margin
    : align === "left"
      ? triggerRect.left
      : align === "center"
        ? Math.min(
            Math.max(triggerCenter - menuWidth / 2, minLeft),
            maxLeft,
          )
        : triggerRect.right - menuWidth;
  const left = Math.min(Math.max(Math.floor(preferredLeft), minLeft), maxLeft);
  const top = Math.max(
    viewportTop + margin,
    Math.floor(triggerRect.top - gap - Math.min(menuHeight, availableAbove)),
  );

  menu.style.setProperty("left", `${left}px`, "important");
  if (isSpeedPanel) {
    // Preserve the speed panel's existing positioning contract.
    menu.style.setProperty("top", `${top}px`, "important");
  } else {
    // Anchor the lower edge to the trigger. When provider/model content grows,
    // the panel therefore expands upward instead of pushing its lower edge
    // below the viewport.
    const viewportHeight = Math.max(1, Math.floor(
      viewport?.height || document.documentElement.clientHeight || window.innerHeight || 1,
    ));
    const bottom = Math.max(
      margin,
      Math.floor(viewportTop + viewportHeight - (triggerRect.top - gap)),
    );
    menu.style.setProperty("top", "auto", "important");
    // chat-input.css intentionally uses !important to clear the menu's old
    // absolute bottom anchor after portaling. The final anchor must therefore
    // also be important; otherwise both the + panel and the model/provider
    // panel fall back to the body's static position near the top of the page.
    menu.style.setProperty("bottom", `${bottom}px`, "important");
  }
  menu.style.transformOrigin = sheet
    ? "center bottom"
    : align === "center"
      ? "center bottom"
      : align === "left" ? "left bottom" : "right bottom";
}

const composerMenuPortalState = new WeakMap();

function syncComposerMenuPortal(menu, trigger, open, options = {}) {
  if (!menu || !trigger || typeof window === "undefined") return;
  const existing = composerMenuPortalState.get(menu);
  if (!open || !shouldPortalComposerMenus()) {
    if (existing) {
      window.removeEventListener("resize", existing.reposition);
      window.removeEventListener("scroll", existing.reposition, true);
      window.visualViewport?.removeEventListener?.("resize", existing.reposition);
      window.visualViewport?.removeEventListener?.("scroll", existing.reposition);
      existing.resizeObserver?.disconnect?.();
      existing.contentObserver?.disconnect?.();
      composerMenuPortalState.delete(menu);
    }
    return;
  }

  const reposition = existing?.reposition || (() => {
    const state = composerMenuPortalState.get(menu);
    if (!state) return;
    positionComposerPortaledMenu(menu, state.trigger, state.options);
  });
  const resizeObserver = existing?.resizeObserver || (
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => reposition())
      : null
  );
  const contentObserver = existing?.contentObserver || (
    typeof MutationObserver === "function"
      && !menu.classList.contains("composer-runtime-speed-panel")
      ? new MutationObserver(() => {
        // Provider/model options are replaced asynchronously. Reposition on
        // the next two frames so the menu's bottom anchor survives both DOM
        // insertion and the following font/layout pass.
        window.requestAnimationFrame?.(() => {
          reposition();
          window.requestAnimationFrame?.(reposition);
        });
      })
      : null
  );
  composerMenuPortalState.set(menu, {
    trigger,
    options,
    reposition,
    resizeObserver,
    contentObserver,
  });
  if (contentObserver && !existing) {
    contentObserver.observe(menu, { childList: true, subtree: true, characterData: true });
  }
  if (!existing) {
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.visualViewport?.addEventListener?.("resize", reposition);
    window.visualViewport?.addEventListener?.("scroll", reposition);
    resizeObserver?.observe?.(menu);
  }
  positionComposerPortaledMenu(menu, trigger, options);
  window.requestAnimationFrame?.(reposition);
}

window.RagentComposerMenuPortal = Object.freeze({
  position: positionComposerPortaledMenu,
  sync: syncComposerMenuPortal,
});

const OWNER_AUTH_CAPABILITIES = Object.freeze({
  listSessions: true,
  createSession: true,
  renameSession: true,
  deleteSession: true,
  pinSession: true,
  forkSession: true,
  uploadAttachments: true,
  downloadArtifacts: true,
  switchAgents: true,
  manageAgents: true,
  changeRuntime: true,
  organizeSessionList: true,
  publishShareSnapshot: true,
});

const AGENT_SCOPED_AUTH_CAPABILITIES = Object.freeze({
  listSessions: true,
  createSession: true,
  renameSession: true,
  deleteSession: false,
  pinSession: true,
  forkSession: false,
  uploadAttachments: true,
  downloadArtifacts: true,
  switchAgents: false,
  manageAgents: false,
  changeRuntime: false,
  organizeSessionList: false,
  publishShareSnapshot: false,
});

const LEGACY_VISITOR_AUTH_CAPABILITIES = Object.freeze({
  listSessions: false,
  createSession: false,
  renameSession: false,
  deleteSession: false,
  pinSession: false,
  forkSession: false,
  uploadAttachments: true,
  downloadArtifacts: true,
  switchAgents: false,
  manageAgents: false,
  changeRuntime: false,
  organizeSessionList: false,
  publishShareSnapshot: false,
});

function cloneAuthCapabilityDefaults(mode = "owner") {
  if (mode === "agent_scoped") {
    return { ...AGENT_SCOPED_AUTH_CAPABILITIES };
  }
  if (mode === "visitor") {
    return { ...LEGACY_VISITOR_AUTH_CAPABILITIES };
  }
  return { ...OWNER_AUTH_CAPABILITIES };
}

function normalizeBootstrapCapabilities(raw, mode = "owner") {
  const defaults = cloneAuthCapabilityDefaults(mode);
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, raw[key] === true ? true : defaults[key]]),
  );
}

function normalizeBootstrapCurrentAgent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = normalizeBootstrapText(raw.id);
  if (!id) return null;
  return {
    id,
    name: normalizeBootstrapText(raw.name),
    tool: normalizeBootstrapText(raw.tool),
  };
}

function normalizeBootstrapAuthInfo(raw) {
  if (!raw || typeof raw !== "object") return null;
  const role = raw.role === "visitor" ? "visitor" : "owner";
  const preferredLanguage = normalizeBootstrapText(raw.preferredLanguage);
  if (role === "owner") {
    const info = {
      role,
      principalKind: normalizeBootstrapText(raw.principalKind) || "owner",
      surfaceMode: "owner",
      capabilities: normalizeBootstrapCapabilities(raw.capabilities, "owner"),
    };
    if (preferredLanguage) info.preferredLanguage = preferredLanguage;
    return info;
  }

  const surfaceMode = normalizeBootstrapText(raw.surfaceMode) === "agent_scoped"
    ? "agent_scoped"
    : "visitor";
  const sessionId = normalizeBootstrapText(raw.sessionId);
  if (!sessionId && surfaceMode !== "agent_scoped") return null;

  const info = {
    role,
    principalKind: normalizeBootstrapText(raw.principalKind)
      || (surfaceMode === "agent_scoped" ? "agent_guest" : "visitor"),
    surfaceMode,
    capabilities: normalizeBootstrapCapabilities(raw.capabilities, surfaceMode),
  };
  if (sessionId) info.sessionId = sessionId;
  const agentId = normalizeBootstrapText(raw.agentId);
  if (agentId) info.agentId = agentId;
  const visitorId = normalizeBootstrapText(raw.visitorId);
  if (visitorId) info.visitorId = visitorId;
  const principalId = normalizeBootstrapText(raw.principalId || raw.visitorId);
  if (principalId) info.principalId = principalId;
  const currentAgent = normalizeBootstrapCurrentAgent(raw.currentAgent);
  if (currentAgent) info.currentAgent = currentAgent;
  if (preferredLanguage) info.preferredLanguage = preferredLanguage;
  return info;
}

const bootstrapAuthInfo = normalizeBootstrapAuthInfo(pageBootstrap.auth);

function normalizeBootstrapAssetUploads(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      enabled: false,
      directUpload: false,
      provider: "",
    };
  }
  return {
    enabled: raw.enabled === true,
    directUpload: raw.directUpload === true,
    provider: normalizeBootstrapText(raw.provider),
  };
}

const bootstrapAssetUploads = normalizeBootstrapAssetUploads(pageBootstrap.assetUploads);

const bootstrapDefaultSessionFolder = normalizeBootstrapText(pageBootstrap.defaultSessionFolder) || "~";
window.ragentGetDefaultSessionFolder = function ragentGetDefaultSessionFolder() {
  return bootstrapDefaultSessionFolder || "~";
};
window.ragentGetSelectedSessionFolder = function ragentGetSelectedSessionFolder() {
  return bootstrapDefaultSessionFolder || "~";
};
window.ragentSetSelectedSessionFolder = function ragentSetSelectedSessionFolder(folder) {
  return normalizeBootstrapText(folder) || bootstrapDefaultSessionFolder || "~";
};

function normalizeBootstrapShareSnapshot(rawPayload, rawMeta = null) {
  const payload = rawPayload && typeof rawPayload === "object"
    ? rawPayload
    : {};
  const meta = rawMeta && typeof rawMeta === "object"
    ? rawMeta
    : {};
  if (Object.keys(payload).length === 0 && Object.keys(meta).length === 0) {
    return null;
  }

  const id = normalizeBootstrapText(payload.id || meta.id || meta.shareId);
  const sessionRaw = payload.session && typeof payload.session === "object"
    ? payload.session
    : (meta.session && typeof meta.session === "object" ? meta.session : {});
  const payloadView = payload.view && typeof payload.view === "object"
    ? payload.view
    : {};
  const metaView = meta.view && typeof meta.view === "object"
    ? meta.view
    : {};
  const view = {
    ...payloadView,
    ...metaView,
  };
  if (meta.badge && !view.badge) view.badge = meta.badge;
  if (meta.note && !view.note) view.note = meta.note;
  if (meta.titleSuffix && !view.titleSuffix) view.titleSuffix = meta.titleSuffix;
  const eventBlocks = payload.eventBlocks && typeof payload.eventBlocks === "object"
    ? Object.fromEntries(
      Object.entries(payload.eventBlocks)
        .filter(([key, events]) => typeof key === "string" && Array.isArray(events)),
    )
    : {};
  const displayEvents = Array.isArray(payload.displayEvents)
    ? payload.displayEvents.filter((event) => event && typeof event === "object")
    : [];

  return {
    id,
    version: payload.version,
    createdAt: normalizeBootstrapText(payload.createdAt || meta.createdAt) || null,
    session: {
      name: normalizeBootstrapText(sessionRaw.name),
      tool: normalizeBootstrapText(sessionRaw.tool),
      created: normalizeBootstrapText(sessionRaw.created) || null,
    },
    view,
    eventCount: Number.isInteger(payload.eventCount)
      ? payload.eventCount
      : displayEvents.length,
    displayEvents,
    eventBlocks,
  };
}

const bootstrapShareSnapshot = normalizeBootstrapShareSnapshot(
  window.__RAGENT_SHARE__,
  pageBootstrap.shareSnapshot,
);

function getBootstrapAuthInfo() {
  if (!bootstrapAuthInfo) return null;
  return {
    ...bootstrapAuthInfo,
    capabilities: bootstrapAuthInfo.capabilities
      ? { ...bootstrapAuthInfo.capabilities }
      : undefined,
    currentAgent: bootstrapAuthInfo.currentAgent
      ? { ...bootstrapAuthInfo.currentAgent }
      : undefined,
  };
}

function getBootstrapShareSnapshot() {
  return bootstrapShareSnapshot;
}

function getBootstrapAssetUploads() {
  return { ...bootstrapAssetUploads };
}

console.info(
  "Ragent build",
  buildInfo.title || buildInfo.serviceTitle || buildAssetVersion,
);

let buildRefreshScheduled = false;
let newerBuildInfo = null;

async function clearFrontendCaches() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration().catch(
    () => null,
  );
  if (!registration) return;
  const message = { type: "ragent:clear-caches" };
  registration.installing?.postMessage(message);
  registration.waiting?.postMessage(message);
  registration.active?.postMessage(message);
}

function updateFrontendRefreshUi() {
  if (!refreshFrontendBtn) return;
  const hasUpdate = !!newerBuildInfo?.assetVersion;
  refreshFrontendBtn.hidden = !hasUpdate;
  refreshFrontendBtn.classList.toggle("ready", hasUpdate);
  const updateTitle = hasUpdate
    ? bootstrapT("status.frontendUpdateReady")
    : bootstrapT("status.frontendReloadLatest");
  refreshFrontendBtn.title = updateTitle;
  refreshFrontendBtn.setAttribute("aria-label", updateTitle);
  if (!hasUpdate) {
    refreshFrontendBtn.removeAttribute("aria-busy");
  }
  syncMobileDisclosureState?.();
}

function hasUnsavedComposerState() {
  if (typeof hasAnyComposerUnsavedState === "function") {
    return hasAnyComposerUnsavedState();
  }
  if (typeof hasPendingComposerSend === "function" && hasPendingComposerSend()) {
    return true;
  }
  const draftText = typeof msgInput?.value === "string" ? msgInput.value.trim() : "";
  if (draftText) {
    return true;
  }
  const pendingAttachmentCount = Number.isInteger(imgPreviewStrip?.childElementCount)
    ? imgPreviewStrip.childElementCount
    : 0;
  return pendingAttachmentCount > 0;
}

async function reloadForFreshBuild(nextBuildInfo) {
  if (buildRefreshScheduled) return;
  buildRefreshScheduled = true;
  refreshFrontendBtn?.setAttribute("aria-busy", "true");
  console.info(
    "Ragent frontend updated; reloading",
    nextBuildInfo?.title ||
      newerBuildInfo?.title ||
      nextBuildInfo?.assetVersion ||
      newerBuildInfo?.assetVersion ||
      "unknown",
  );
  try {
    await clearFrontendCaches();
  } catch {}
  window.location.reload();
  return true;
}

async function applyBuildInfo(nextBuildInfo) {
  if (buildRefreshScheduled) return false;
  if (!nextBuildInfo?.assetVersion) {
    return false;
  }
  if (nextBuildInfo.assetVersion === buildAssetVersion) {
    if (!buildRefreshScheduled) {
      newerBuildInfo = null;
      updateFrontendRefreshUi();
    }
    return false;
  }
  newerBuildInfo = nextBuildInfo;
  updateFrontendRefreshUi();
  return false;
}

window.RagentBuild = {
  applyBuildInfo,
  reloadForFreshBuild,
};

function normalizeSidebarShellMarkup() {
  const sidebarElement = document.getElementById("sidebar");
  if (!sidebarElement || document.getElementById("sidebarAppBar")) return false;

  const legacyTabs = sidebarElement.querySelector(".sidebar-tabs");
  const sessionsTab = document.getElementById("tabSessions");
  const closeButton = document.getElementById("closeSidebar");
  const workspace = document.getElementById("workspacePicker");
  const workspaceButton = document.getElementById("workspaceSummaryButton");
  const workspaceText = document.getElementById("workspaceSummaryText");
  const workspaceTitle = document.getElementById("workspacePopoverTitle");
  const legacySearch = document.getElementById("sidebarSearch");
  const searchInput = document.getElementById("sessionSearchInput");
  const sessionListElement = document.getElementById("sessionList");
  const agentsPanelElement = document.getElementById("agentsPanel");
  const settingsPanelElement = document.getElementById("settingsPanel");
  const modelProvidersPanelElement = document.getElementById("modelProvidersPanel");
  const harnessesPanelElement = document.getElementById("harnessesPanel");
  const newSessionButton = document.getElementById("newSessionBtn");
  if (
    !sessionsTab
    || !closeButton
    || !workspace
    || !workspaceButton
    || !searchInput
    || !sessionListElement
    || !agentsPanelElement
    || !settingsPanelElement
    || !modelProvidersPanelElement
    || !harnessesPanelElement
    || !newSessionButton
  ) {
    return false;
  }

  const createIconButton = ({ id, icon, title, controls = "" }) => {
    const button = document.createElement("button");
    button.className = "sidebar-icon-btn";
    button.id = id;
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("data-icon", icon);
    if (controls) button.setAttribute("aria-controls", controls);
    return button;
  };

  const appBar = document.createElement("div");
  appBar.className = "sidebar-app-bar";
  appBar.id = "sidebarAppBar";
  const brand = document.createElement("div");
  brand.className = "sidebar-brand";
  brand.textContent = "Ragent";
  const appBarActions = document.createElement("div");
  appBarActions.className = "sidebar-app-bar-actions";
  const searchButton = createIconButton({
    id: "sidebarSearchBtn",
    icon: "search",
    title: "Search sessions and agents",
  });
  searchButton.setAttribute("data-i18n-title", "sidebar.search.action");
  searchButton.setAttribute("data-i18n-aria-label", "sidebar.search.action");
  closeButton.className = "sidebar-icon-btn";
  closeButton.textContent = "";
  closeButton.setAttribute("data-icon", "chevron-left");
  appBarActions.append(searchButton, closeButton);
  appBar.append(brand, appBarActions);

  const searchHeader = document.createElement("div");
  searchHeader.className = "sidebar-search-mode-header";
  searchHeader.id = "sidebarSearchModeHeader";
  searchHeader.hidden = true;
  const searchShell = document.createElement("label");
  searchShell.className = "sidebar-search-shell";
  searchShell.setAttribute("for", "sessionSearchInput");
  const searchIcon = document.createElement("span");
  searchIcon.className = "sidebar-search-shell-icon";
  searchIcon.setAttribute("data-icon", "search");
  searchIcon.setAttribute("aria-hidden", "true");
  searchInput.placeholder = "Search sessions and agents…";
  searchInput.setAttribute("data-i18n-placeholder", "sidebar.search.allPlaceholder");
  searchShell.append(searchIcon, searchInput);
  const searchClose = createIconButton({
    id: "sidebarSearchCloseBtn",
    icon: "close",
    title: "Close search",
  });
  searchClose.setAttribute("data-i18n-title", "sidebar.search.close");
  searchClose.setAttribute("data-i18n-aria-label", "sidebar.search.close");
  searchHeader.append(searchShell, searchClose);

  const subpageHeader = document.createElement("div");
  subpageHeader.className = "sidebar-subpage-header";
  subpageHeader.id = "sidebarSubpageHeader";
  subpageHeader.hidden = true;
  const subpageIcon = document.createElement("span");
  subpageIcon.className = "sidebar-subpage-icon";
  subpageIcon.id = "sidebarSubpageIcon";
  subpageIcon.setAttribute("data-icon", "sparkle-solid");
  subpageIcon.setAttribute("aria-hidden", "true");
  const subpageTitle = document.createElement("div");
  subpageTitle.className = "sidebar-subpage-title";
  subpageTitle.id = "sidebarSubpageTitle";
  const subpageClose = createIconButton({
    id: "sidebarSubpageCloseBtn",
    icon: "chevron-left",
    title: "Back to sessions",
  });
  subpageClose.setAttribute("data-i18n-title", "sidebar.subpage.close");
  subpageClose.setAttribute("data-i18n-aria-label", "sidebar.subpage.close");
  subpageHeader.append(subpageClose, subpageIcon, subpageTitle);

  const primaryNav = document.createElement("nav");
  primaryNav.className = "sidebar-primary-nav";
  primaryNav.id = "sidebarPrimaryNav";
  primaryNav.setAttribute("aria-label", "Sidebar navigation");
  primaryNav.setAttribute("data-i18n-aria-label", "sidebar.navigation");
  workspaceButton.className = "sidebar-workspace-summary sidebar-primary-action";
  workspaceButton.innerHTML = "";
  workspaceText.className = "sidebar-workspace-summary-text";
  const workspaceChevron = document.createElement("span");
  workspaceChevron.className = "sidebar-primary-action-chevron";
  workspaceChevron.setAttribute("data-icon", "chevron-down");
  workspaceChevron.setAttribute("aria-hidden", "true");
  workspaceButton.append(workspaceText, workspaceChevron);
  if (workspaceTitle) {
    workspaceTitle.textContent = "Switch workspace";
    workspaceTitle.setAttribute("data-i18n", "sidebar.workspace.switchTitle");
  }
  sessionsTab.hidden = true;
  primaryNav.append(workspace, sessionsTab);

  const sessionSurface = document.createElement("div");
  sessionSurface.className = "sidebar-session-surface";
  sessionSurface.id = "sidebarSessionSurface";
  const agentButton = document.createElement("button");
  agentButton.className = "sidebar-agent-btn";
  agentButton.id = "sidebarAgentBtn";
  agentButton.type = "button";
  agentButton.title = "Agents";
  agentButton.setAttribute("aria-label", "Agents");
  agentButton.setAttribute("data-i18n-title", "nav.agents");
  agentButton.setAttribute("data-i18n-aria-label", "nav.agents");
  agentButton.innerHTML = '<span class="sidebar-agent-icon" data-icon="sparkle-solid" aria-hidden="true"></span>';
  const filterButton = document.createElement("button");
  filterButton.className = "sidebar-filter-btn";
  filterButton.id = "sidebarFilterBtn";
  filterButton.type = "button";
  filterButton.title = "Settings";
  filterButton.setAttribute("aria-label", "Settings");
  filterButton.setAttribute("data-icon", "gear-solid");
  filterButton.setAttribute("data-i18n-title", "nav.settings");
  filterButton.setAttribute("data-i18n-aria-label", "nav.settings");
  const sessionSearchHeading = document.createElement("div");
  sessionSearchHeading.className = "sidebar-search-results-heading sidebar-session-search-heading";
  sessionSearchHeading.id = "sidebarSessionSearchHeading";
  sessionSearchHeading.hidden = true;
  sessionSearchHeading.textContent = "Sessions";
  sessionSearchHeading.setAttribute("data-i18n", "sidebar.search.sessions");
  const agentSearchResults = document.createElement("div");
  agentSearchResults.className = "sidebar-agent-search-results";
  agentSearchResults.id = "sidebarAgentSearchResults";
  agentSearchResults.hidden = true;
  sessionSurface.append(sessionSearchHeading, sessionListElement, agentSearchResults);

  const bottomFrost = document.createElement("div");
  bottomFrost.className = "sidebar-bottom-frost";
  bottomFrost.setAttribute("aria-hidden", "true");
  const bottomActions = document.createElement("div");
  bottomActions.className = "sidebar-bottom-actions";
  bottomActions.id = "sidebarBottomActions";
  newSessionButton.className = "new-session-btn sidebar-new-chat-btn";
  newSessionButton.removeAttribute("data-i18n");
  newSessionButton.innerHTML = '<span class="sidebar-new-chat-icon" data-icon="new-chat" aria-hidden="true"></span><span data-i18n="sidebar.projects.newProject">New project</span>';
  const accountButton = document.createElement("button");
  accountButton.className = "sidebar-account-btn";
  accountButton.id = "sidebarAccountBtn";
  accountButton.type = "button";
  accountButton.title = "Account status";
  accountButton.setAttribute("aria-label", "Account status");
  accountButton.setAttribute("aria-expanded", "false");
  accountButton.setAttribute("aria-controls", "sidebarAccountPopover");
  accountButton.setAttribute("data-i18n-title", "sidebar.account.action");
  accountButton.setAttribute("data-i18n-aria-label", "sidebar.account.action");
  accountButton.innerHTML = '<span class="sidebar-account-avatar" id="sidebarAccountAvatar">A</span><span class="sidebar-account-indicator" aria-hidden="true"></span>';
  bottomActions.append(newSessionButton, agentButton, filterButton, accountButton);
  const accountPopover = document.createElement("div");
  accountPopover.className = "sidebar-account-popover";
  accountPopover.id = "sidebarAccountPopover";
  accountPopover.hidden = true;
  accountPopover.setAttribute("role", "dialog");
  accountPopover.setAttribute("aria-labelledby", "sidebarAccountTitle");
  accountPopover.innerHTML = '<div class="sidebar-account-title" id="sidebarAccountTitle" data-i18n="sidebar.account.title">Account &amp; cross-device sign-in</div><div class="sidebar-account-status" id="sidebarAccountStatus" role="status" aria-live="polite"></div><div class="sidebar-account-detail" id="sidebarAccountDetail"></div><div class="sidebar-account-actions"><button class="sidebar-account-action" id="sidebarAccountAction" type="button" hidden></button><button class="sidebar-account-action sidebar-account-action--secondary" id="sidebarAccountRetry" type="button" hidden data-i18n="sidebar.account.retry">Retry</button></div>';

  legacyTabs?.remove?.();
  legacySearch?.remove?.();
  sidebarElement.prepend(appBar, searchHeader, subpageHeader, primaryNav, sessionSurface);
  sidebarElement.append(bottomFrost, bottomActions, accountPopover);
  window.RagentIcons?.hydrate?.(sidebarElement);
  return true;
}

normalizeSidebarShellMarkup();

// ---- Elements ----
const menuBtn = document.getElementById("menuBtn");
const homeBtn = document.getElementById("homeBtn");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const sidebar = document.getElementById("sidebar");
const closeSidebar = document.getElementById("closeSidebar");
const sidebarAppBar = document.getElementById("sidebarAppBar");
const sidebarSearchBtn = document.getElementById("sidebarSearchBtn");
const sidebarSearchModeHeader = document.getElementById("sidebarSearchModeHeader");
const sidebarSearchCloseBtn = document.getElementById("sidebarSearchCloseBtn");
const sidebarSubpageHeader = document.getElementById("sidebarSubpageHeader");
const sidebarSubpageIcon = document.getElementById("sidebarSubpageIcon");
const sidebarSubpageTitle = document.getElementById("sidebarSubpageTitle");
const sidebarSubpageCloseBtn = document.getElementById("sidebarSubpageCloseBtn");
const sidebarPrimaryNav = document.getElementById("sidebarPrimaryNav");
const sidebarSessionSurface = document.getElementById("sidebarSessionSurface");
const sidebarAgentBtn = document.getElementById("sidebarAgentBtn");
const sidebarFilterBtn = document.getElementById("sidebarFilterBtn");
const sidebarSessionSearchHeading = document.getElementById("sidebarSessionSearchHeading");
const sidebarAgentSearchResults = document.getElementById("sidebarAgentSearchResults");
const sidebarBottomActions = document.getElementById("sidebarBottomActions");
const sidebarAccountBtn = document.getElementById("sidebarAccountBtn");
const sidebarAccountPopover = document.getElementById("sidebarAccountPopover");
const forkSessionBtn = document.getElementById("forkSessionBtn");
const shareSnapshotBtn = document.getElementById("shareSnapshotBtn");
const runSheetBtn = document.getElementById("runSheetBtn");
const orgRadarBtn = document.getElementById("orgRadarBtn");
const workbenchSidebarBtn = document.getElementById("workbenchSidebarBtn");
const sidebarSearch = document.getElementById("sidebarSearch");
const sessionSearchInput = document.getElementById("sessionSearchInput");
const sidebarViewSwitcher = document.getElementById("sidebarViewSwitcher");
const viewInboxBtn = document.getElementById("viewInbox");
const viewProjectsBtn = document.getElementById("viewProjects");
const workspacePicker = document.getElementById("workspacePicker");
const workspaceSelect = document.getElementById("workspaceSelect");
const sessionList = document.getElementById("sessionList");
const settingsAgentsList = document.getElementById("settingsAgentsList");
const createAgentBtn = document.getElementById("createAgentBtn");
const uiLanguageSelect = document.getElementById("uiLanguageSelect");
const thinkingBlockDisplaySelect = null;
const sortSessionListBtn = document.getElementById("sortSessionListBtn");
const newSessionBtn = document.getElementById("newSessionBtn");
const messagesEl = document.getElementById("messages");
const messagesInner = document.getElementById("messagesInner");
const emptyState = document.getElementById("emptyState");
const queuedPanel = document.getElementById("queuedPanel");
const msgInput = document.getElementById("msgInput");
const sendBtn = document.getElementById("sendBtn");
const headerTitle = document.getElementById("headerTitle");
const refreshFrontendBtn = document.getElementById("refreshFrontendBtn");
const headerMoreBtn = document.getElementById("headerMoreBtn");
const headerOverflowMenu = document.getElementById("headerOverflowMenu");
const headerOverflowShareBtn = document.getElementById("headerOverflowShareBtn");
const headerOverflowRunSheetBtn = document.getElementById("headerOverflowRunSheetBtn");
const headerOverflowRenameBtn = document.getElementById("headerOverflowRenameBtn");
const headerOverflowCopySessionIdBtn = document.getElementById("headerOverflowCopySessionIdBtn");
const headerOverflowCompactBtn = document.getElementById("headerOverflowCompactBtn");
const headerOverflowDropToolsBtn = document.getElementById("headerOverflowDropToolsBtn");
const headerOverflowDeleteBtn = document.getElementById("headerOverflowDeleteBtn");
const headerOverflowSidebarBtn = document.getElementById("headerOverflowSidebarBtn");
const headerOverflowRefreshBtn = document.getElementById("headerOverflowRefreshBtn");
const imgBtn = document.getElementById("imgBtn");
const imgFileInput = document.getElementById("imgFileInput");
const imgPreviewStrip = document.getElementById("imgPreviewStrip");
const inlineAgentSelect = document.getElementById("inlineAgentSelect");
const inlineToolSelect = document.getElementById("inlineToolSelect");
const inlineModelSelect = document.getElementById("inlineModelSelect");
const effortSelect = document.getElementById("effortSelect");
const serviceTierSelect = document.getElementById("serviceTierSelect");
const thinkingToggle = document.getElementById("thinkingToggle");
const cancelBtn = document.getElementById("cancelBtn");
const contextTokens = document.getElementById("contextTokens");
const compactBtn = document.getElementById("compactBtn");
const dropToolsBtn = document.getElementById("dropToolsBtn");
const saveTemplateBtn = document.getElementById("saveTemplateBtn");
const sessionTemplateRow = document.getElementById("sessionTemplateRow");
const sessionTemplateSelect = document.getElementById("sessionTemplateSelect");
const sessionTemplateStatus = document.getElementById("sessionTemplateStatus");
const tabSessions = document.getElementById("tabSessions");
const tabAgents = document.getElementById("tabAgents");
const agentsPanel = document.getElementById("agentsPanel");
const settingsPanel = document.getElementById("settingsPanel");
const modelProvidersPanel = document.getElementById("modelProvidersPanel");
const harnessesPanel = document.getElementById("harnessesPanel");
const inputArea = document.getElementById("inputArea");
const composerPendingState = document.getElementById("composerPendingState");
const inputResizeHandle = document.getElementById("inputResizeHandle");
const composerSummary = document.getElementById("composerSummary");
const composerSummaryText = document.getElementById("composerSummaryText");
const composerSummaryLabel = document.getElementById("composerSummaryLabel");
const composerModeChatBtn = document.getElementById("composerModeChatBtn");
const composerModePlanBtn = document.getElementById("composerModePlanBtn");
const composerAddMenu = document.getElementById("composerAddMenu");
const composerAttachFilesBtn = document.getElementById("composerAttachFilesBtn");
const composerPlanMenuItem = document.getElementById("composerPlanMenuItem");
const composerPlanMenuNote = document.getElementById("composerPlanMenuNote");
const composerAgentsMenuItem = document.getElementById("composerAgentsMenuItem");
const composerConnectorsMenuItem = document.getElementById("composerConnectorsMenuItem");
const composerPlanChip = document.getElementById("composerPlanChip");
const composerRuntimeControls = document.getElementById("composerRuntimeControls");
const composerRuntimeBtn = document.getElementById("composerRuntimeBtn");
const composerRuntimeLabel = document.getElementById("composerRuntimeLabel");
const composerRuntimeMenu = document.getElementById("composerRuntimeMenu");
const composerRuntimeToolView = document.getElementById("composerRuntimeToolView");
const composerRuntimeProviderView = document.getElementById("composerRuntimeProviderView");
const composerRuntimeProviderTitle = document.getElementById("composerRuntimeProviderTitle");
const composerRuntimeModelView = document.getElementById("composerRuntimeModelView");
const composerRuntimePermissionView = document.getElementById("composerRuntimePermissionView");
const composerRuntimeToolOptions = document.getElementById("composerRuntimeToolOptions");
const composerRuntimeProviderBackBtn = document.getElementById("composerRuntimeProviderBackBtn");
const composerRuntimeProviderOptions = document.getElementById("composerRuntimeProviderOptions");
const composerRuntimeProviderStatus = document.getElementById("composerRuntimeProviderStatus");
const composerRuntimeSpeedBtn = document.getElementById("composerRuntimeSpeedBtn");
const composerRuntimeSpeedIcon = document.getElementById("composerRuntimeSpeedIcon");
const composerRuntimeSpeedPanel = document.getElementById("composerRuntimeSpeedPanel");
const composerRuntimeSpeedToggle = document.getElementById("composerRuntimeSpeedToggle");
const composerRuntimeSpeedSelect = document.getElementById("composerRuntimeSpeedSelect");
const composerRuntimeEffortValue = document.getElementById("composerRuntimeEffortValue");
const composerRuntimeEffortRange = document.getElementById("composerRuntimeEffortRange");
const composerRuntimeModelBackBtn = document.getElementById("composerRuntimeModelBackBtn");
const composerRuntimeModelOptions = document.getElementById("composerRuntimeModelOptions");
const composerRuntimePermissionBtn = null;
const composerRuntimePermissionLabel = null;
const composerRuntimePermissionBackBtn = document.getElementById("composerRuntimePermissionBackBtn");
const composerRuntimePermissionOptions = document.getElementById("composerRuntimePermissionOptions");
const composerPermissionBtn = document.getElementById("composerPermissionBtn");
const composerPermissionLabel = document.getElementById("composerPermissionLabel");
const composerPermissionMenu = document.getElementById("composerPermissionMenu");
const composerPermissionOptions = document.getElementById("composerPermissionOptions");
const composerControlsBtn = document.getElementById("composerControlsBtn");
const composerConfigBackdrop = document.getElementById("composerConfigBackdrop");
const addToolModal = document.getElementById("addToolModal");
const closeAddToolModalBtn = document.getElementById("closeAddToolModal");
const closeAddToolModalFooterBtn = document.getElementById(
  "closeAddToolModalFooter",
);
const addToolNameInput = document.getElementById("addToolNameInput");
const addToolCommandInput = document.getElementById("addToolCommandInput");
const addToolRuntimeFamilySelect = document.getElementById(
  "addToolRuntimeFamilySelect",
);
const addToolModelsInput = document.getElementById("addToolModelsInput");
const addToolReasoningKindSelect = document.getElementById(
  "addToolReasoningKindSelect",
);
const addToolReasoningLevelsInput = document.getElementById(
  "addToolReasoningLevelsInput",
);
const addToolStatus = document.getElementById("addToolStatus");
const providerPromptCode = document.getElementById("providerPromptCode");
const saveToolConfigBtn = document.getElementById("saveToolConfigBtn");
const copyProviderPromptBtn = document.getElementById("copyProviderPromptBtn");

refreshFrontendBtn?.addEventListener("click", () => {
  void reloadForFreshBuild(newerBuildInfo);
});

// Mobile disclosure state for header overflow and composer controls
const mobileDisclosureQuery = window.matchMedia("(max-width: 767px)");
let headerOverflowOpen = false;
let composerControlsOpen = false;
// Android back button entries for the mutually exclusive mobile disclosures.
let headerOverflowBackEntryId = null;
let composerControlsBackEntryId = null;

function isDisclosureMobileViewport() {
  return !!mobileDisclosureQuery.matches;
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

function isHeaderActionAvailable(el) {
  if (!el) return false;
  if (el.hidden) return false;
  if (el.style && el.style.display === "none") return false;
  return true;
}

function syncHeaderOverflowMenu() {
  if (!headerMoreBtn || !headerOverflowMenu) return;
  const mobile = isDisclosureMobileViewport();
  const shareAvailable = isHeaderActionAvailable(shareSnapshotBtn);
  const runSheetAvailable = isHeaderActionAvailable(runSheetBtn);
  const orgRadarAvailable = isHeaderActionAvailable(orgRadarBtn);
  const sessionActionsAvailable = runSheetAvailable
    || orgRadarAvailable
    || isHeaderActionAvailable(compactBtn)
    || isHeaderActionAvailable(dropToolsBtn);
  const sidebarAvailable = isHeaderActionAvailable(workbenchSidebarBtn);
  const refreshAvailable = isHeaderActionAvailable(refreshFrontendBtn);
  const hasItems = shareAvailable || sessionActionsAvailable || sidebarAvailable || refreshAvailable;
  headerMoreBtn.hidden = !(mobile && hasItems);
  headerMoreBtn.setAttribute(
    "aria-expanded",
    headerOverflowOpen && !headerMoreBtn.hidden ? "true" : "false",
  );
  const shouldShowMenu = headerOverflowOpen && !headerMoreBtn.hidden;
  if (window.RagentMotion?.setPresence) {
    window.RagentMotion.setPresence(headerOverflowMenu, shouldShowMenu, {
      duration: 160,
    });
  } else {
    headerOverflowMenu.hidden = !shouldShowMenu;
  }
  if (headerOverflowShareBtn) headerOverflowShareBtn.hidden = !shareAvailable;
  if (headerOverflowRunSheetBtn) headerOverflowRunSheetBtn.hidden = !runSheetAvailable;
  if (headerOverflowRenameBtn) headerOverflowRenameBtn.hidden = !sessionActionsAvailable;
  if (headerOverflowCopySessionIdBtn) headerOverflowCopySessionIdBtn.hidden = !sessionActionsAvailable;
  if (headerOverflowCompactBtn) headerOverflowCompactBtn.hidden = !sessionActionsAvailable;
  if (headerOverflowDropToolsBtn) headerOverflowDropToolsBtn.hidden = !sessionActionsAvailable;
  if (headerOverflowDeleteBtn) headerOverflowDeleteBtn.hidden = !sessionActionsAvailable;
  if (headerOverflowSidebarBtn) headerOverflowSidebarBtn.hidden = !sidebarAvailable;
  if (headerOverflowRefreshBtn) headerOverflowRefreshBtn.hidden = !refreshAvailable;
  if (!shouldShowMenu && headerMoreBtn.hidden) headerOverflowOpen = false;
}

function syncComposerControlsDisclosure() {
  if (!composerControlsBtn || !inputArea || !composerConfigBackdrop) return;
  composerControlsBtn.hidden = true;
  composerControlsBtn.setAttribute(
    "aria-expanded",
    "false",
  );
  if (composerSummaryText) {
    composerSummaryText.hidden = true;
    composerSummaryText.setAttribute("aria-expanded", "false");
  }
  composerControlsOpen = false;
  inputArea.classList.remove("composer-config-open");
  composerConfigBackdrop.hidden = true;
}

function closeMobileDisclosures() {
  headerOverflowOpen = false;
  composerControlsOpen = false;
  syncHeaderOverflowMenu();
  syncComposerControlsDisclosure();
}

function syncHeaderOverflowBackEntry(open) {
  if (open) {
    headerOverflowBackEntryId = window.RagentBackHandler?.push?.({
      id: "header-overflow",
      onBack: () => {
        setHeaderOverflowOpen(false);
        return true;
      },
    }) || null;
  } else if (headerOverflowBackEntryId) {
    window.RagentBackHandler?.pop?.(headerOverflowBackEntryId);
    headerOverflowBackEntryId = null;
  }
}

function syncComposerControlsBackEntry(open) {
  if (open) {
    composerControlsBackEntryId = window.RagentBackHandler?.push?.({
      id: "composer-controls",
      onBack: () => {
        setComposerControlsOpen(false);
        return true;
      },
    }) || null;
  } else if (composerControlsBackEntryId) {
    window.RagentBackHandler?.pop?.(composerControlsBackEntryId);
    composerControlsBackEntryId = null;
  }
}

function captureHeaderMenuCloseViewport() {
  if (!messagesEl) return null;
  return {
    scrollTop: Number(messagesEl.scrollTop) || 0,
    pageX: Number(window.scrollX) || 0,
    pageY: Number(window.scrollY) || 0,
  };
}

function restoreHeaderMenuCloseViewport(viewport) {
  if (!viewport) return;
  const restore = () => {
    if (typeof markMessageViewportProgrammaticScroll === "function") {
      markMessageViewportProgrammaticScroll();
    }
    if (messagesEl) messagesEl.scrollTop = viewport.scrollTop;
    window.scrollTo(viewport.pageX, viewport.pageY);
  };
  restore();
  // Closing the menu can also collapse the composer in the same click turn.
  // Replay after that layout transaction so the menu has no scroll side
  // effect, even when the composer height changes at the same time.
  window.requestAnimationFrame?.(restore);
  window.requestAnimationFrame?.(() => window.requestAnimationFrame?.(restore));
}

function setHeaderOverflowOpen(nextOpen, { preserveViewport = false } = {}) {
  const viewport = !nextOpen && preserveViewport
    ? captureHeaderMenuCloseViewport()
    : null;
  headerOverflowOpen = nextOpen === true;
  if (headerOverflowOpen) {
    composerControlsOpen = false;
    syncComposerControlsBackEntry(false);
    // Move menu to body so it cannot participate in the header's flex layout.
    if (headerOverflowMenu && headerOverflowMenu.parentNode !== document.body) {
      document.body.appendChild(headerOverflowMenu);
    }
  }
  syncHeaderOverflowMenu();
  syncComposerControlsDisclosure();
  syncHeaderOverflowBackEntry(headerOverflowOpen);
  restoreHeaderMenuCloseViewport(viewport);
}

function setComposerControlsOpen(nextOpen) {
  composerControlsOpen = nextOpen === true;
  if (composerControlsOpen) {
    headerOverflowOpen = false;
    syncHeaderOverflowBackEntry(false);
  }
  syncHeaderOverflowMenu();
  syncComposerControlsDisclosure();
  syncComposerControlsBackEntry(composerControlsOpen);
}

function syncMobileDisclosureState() {
  if (!isDisclosureMobileViewport()) {
    headerOverflowOpen = false;
    syncHeaderOverflowMenu();
    syncComposerControlsDisclosure();
    return;
  }
  syncHeaderOverflowMenu();
  syncComposerControlsDisclosure();
}

headerMoreBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  setHeaderOverflowOpen(!headerOverflowOpen, { preserveViewport: headerOverflowOpen });
});

headerOverflowMenu?.addEventListener("click", (event) => {
  event.stopPropagation();
});

headerOverflowShareBtn?.addEventListener("click", () => {
  setHeaderOverflowOpen(false);
  shareSnapshotBtn?.click();
});

headerOverflowRunSheetBtn?.addEventListener("click", () => {
  setHeaderOverflowOpen(false);
  runSheetBtn?.click();
});

function getHeaderCurrentSession() {
  const sessionId = typeof currentSessionId === "string" ? currentSessionId : "";
  if (!sessionId) return null;
  if (typeof getChatStoreSession === "function") return getChatStoreSession(sessionId);
  return Array.isArray(sessions) ? sessions.find((session) => session?.id === sessionId) || null : null;
}

headerOverflowRenameBtn?.addEventListener("click", () => {
  setHeaderOverflowOpen(false);
  const session = getHeaderCurrentSession();
  if (session && typeof window.ragentOpenSessionRename === "function") {
    window.ragentOpenSessionRename(session);
  }
});

headerOverflowCopySessionIdBtn?.addEventListener("click", async () => {
  setHeaderOverflowOpen(false);
  const sessionId = typeof currentSessionId === "string" ? currentSessionId.trim() : "";
  if (!sessionId) return;
  try {
    if (typeof copyText === "function") await copyText(sessionId);
    else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(sessionId);
    else throw new Error("clipboard unavailable");
    if (typeof showSystemToast === "function") showSystemToast(t("action.copied"));
  } catch {
    if (typeof showSystemToast === "function") showSystemToast(t("action.copyFailed"), "error");
  }
});

headerOverflowCompactBtn?.addEventListener("click", () => {
  setHeaderOverflowOpen(false);
  compactBtn?.click();
});

headerOverflowDropToolsBtn?.addEventListener("click", () => {
  setHeaderOverflowOpen(false);
  dropToolsBtn?.click();
});

headerOverflowDeleteBtn?.addEventListener("click", () => {
  setHeaderOverflowOpen(false);
  const session = getHeaderCurrentSession();
  if (session && typeof window.ragentOpenSessionDelete === "function") {
    window.ragentOpenSessionDelete(session);
  }
});

runSheetBtn?.addEventListener("click", () => {
  if (typeof window.openRunSheet === "function") window.openRunSheet();
});

headerOverflowSidebarBtn?.addEventListener("click", () => {
  setHeaderOverflowOpen(false);
  workbenchSidebarBtn?.click();
});

headerOverflowRefreshBtn?.addEventListener("click", () => {
  setHeaderOverflowOpen(false);
  refreshFrontendBtn?.click();
});

composerControlsBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  setComposerControlsOpen(!composerControlsOpen);
});

composerSummaryText?.addEventListener("click", (event) => {
  event.stopPropagation();
  setComposerControlsOpen(!composerControlsOpen);
});

composerConfigBackdrop?.addEventListener("click", () => {
  setComposerControlsOpen(false);
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (
    headerOverflowOpen
    && isDisclosureMobileViewport()
    && headerOverflowMenu
    && target instanceof Node
    && !headerOverflowMenu.contains(target)
    && target !== headerMoreBtn
  ) {
    setHeaderOverflowOpen(false, { preserveViewport: true });
  }
  if (
    composerControlsOpen
    && inputArea
    && target instanceof Node
    && !inputArea.contains(target)
    && target !== composerControlsBtn
    && target !== composerSummaryText
  ) {
    setComposerControlsOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (headerOverflowOpen || composerControlsOpen) closeMobileDisclosures();
});

if (typeof mobileDisclosureQuery.addEventListener === "function") {
  mobileDisclosureQuery.addEventListener("change", syncMobileDisclosureState);
} else if (typeof mobileDisclosureQuery.addListener === "function") {
  mobileDisclosureQuery.addListener(syncMobileDisclosureState);
}
window.addEventListener("resize", syncMobileDisclosureState);
window.visualViewport?.addEventListener("resize", syncMobileDisclosureState);

if (typeof MutationObserver === "function") {
  const disclosureObserver = new MutationObserver(() => {
    syncHeaderOverflowMenu();
    syncComposerControlsDisclosure();
  });
  [shareSnapshotBtn, runSheetBtn, orgRadarBtn, workbenchSidebarBtn, refreshFrontendBtn, thinkingToggle, compactBtn, dropToolsBtn]
    .forEach((el) => {
      if (!el) return;
      disclosureObserver.observe(el, {
        attributes: true,
        attributeFilter: ["style", "hidden", "class", "disabled"],
      });
    });
}

let ws = null;
const ACTIVE_SESSION_STORAGE_KEY = "activeSessionId";
const ACTIVE_SIDEBAR_TAB_STORAGE_KEY = "activeSidebarTab";
const LEGACY_SESSION_SEND_FAILURES_STORAGE_KEY = "sessionSendFailures";
const SESSION_REVIEW_MARKERS_STORAGE_KEY = "sessionReviewedAtById";
const SESSION_REVIEW_BASELINE_AT_STORAGE_KEY = "sessionReviewBaselineAt";
const UI_THEME_STORAGE_KEY = "ragent.theme";
// Source filtering was removed from the sidebar UI (the funnel button now opens
// Settings). Sessions always render unfiltered; FILTER_* constants remain for
// the store model and list rendering which still key off the "all" value.
const FILTER_ALL_VALUE = "__all__";
const SOURCE_FILTER_CHAT_VALUE = "chat_ui";
const SOURCE_FILTER_CHILD_VALUE = "child";
const SOURCE_FILTER_BOT_VALUE = "bot";
const SOURCE_FILTER_AUTOMATION_VALUE = "automation";
const DEFAULT_APP_ID = "chat";
const DEFAULT_APP_NAME = "Chat";
const DEFAULT_WEB_SOURCE_NAME = "Ragent";
const PREFERRED_AGENT_TEMPLATE_STORAGE_KEY = "preferredAgentTemplateId";
const PREFERRED_AGENT_TEMPLATE_NAME_STORAGE_KEY = "preferredAgentTemplateName";
const UI_THEMES = {
  system: {
    lightThemeColor: "#ffffff",
    darkThemeColor: "#161618",
  },
  light: {
    lightThemeColor: "#ffffff",
    darkThemeColor: "#ffffff",
  },
  dark: {
    lightThemeColor: "#1e1e1e",
    darkThemeColor: "#1e1e1e",
  },
  blue: {
    lightThemeColor: "#f9f9ff",
    darkThemeColor: "#111318",
  },
  amber: {
    lightThemeColor: "#f6f8ef",
    darkThemeColor: "#f6f8ef",
  },
  purple: {
    lightThemeColor: "#fffbfe",
    darkThemeColor: "#141218",
  },
  green: {
    lightThemeColor: "#f9fbef",
    darkThemeColor: "#12140f",
  },
  rose: {
    lightThemeColor: "#fff8f8",
    darkThemeColor: "#191113",
  },
  teal: {
    lightThemeColor: "#f4fbfa",
    darkThemeColor: "#0e1414",
  },
  monet: {
    lightThemeColor: "#fffbfe",
    darkThemeColor: "#141218",
  },
};
let monetThemeColorOverrides = null;
const monetThemeContract = window.RagentMonetThemeContract;
if (!monetThemeContract) {
  throw new Error("RagentMonetThemeContract must load before bootstrap.js");
}

function applyMonetTheme(rawTheme) {
  const result = monetThemeContract.apply(rawTheme, document.documentElement);
  monetThemeColorOverrides = result.themeColorOverrides;
  updateThemeColorMeta(currentThemePreference);
  return { applied: result.applied, rejected: result.rejected };
}

function requestAndroidMonetTheme() {
  const bridge = window.RagentAndroidMonet;
  if (!bridge || typeof bridge.requestTheme !== "function") {
    window.dispatchEvent(new CustomEvent("ragent:monet-status", {
      detail: { state: "fallback", reason: "android-bridge-unavailable" },
    }));
    return false;
  }
  try {
    Promise.resolve(bridge.requestTheme()).then((payload) => {
      const theme = typeof payload === "string" ? JSON.parse(payload) : payload;
      applyMonetTheme(theme);
      window.dispatchEvent(new CustomEvent("ragent:monet-status", {
        detail: { state: "applied", applied: true },
      }));
    }).catch(() => {
      window.dispatchEvent(new CustomEvent("ragent:monet-status", {
        detail: { state: "fallback", reason: "android-bridge-rejected" },
      }));
    });
  } catch {
    window.dispatchEvent(new CustomEvent("ragent:monet-status", {
      detail: { state: "fallback", reason: "android-bridge-error" },
    }));
  }
  return true;
}
const sessionStateModel = window.RagentSessionStateModel;
if (!sessionStateModel) {
  throw new Error("RagentSessionStateModel must load before bootstrap.js");
}
const chatStoreModel = window.RagentChatStore;
if (!chatStoreModel) {
  throw new Error("RagentChatStore must load before bootstrap.js");
}

function normalizeThemePreference(value) {
  if (["dark", "light", "blue", "amber", "purple", "green", "rose", "teal", "monet"].includes(value)) return value;
  return "system";
}

function getThinkingBlockDisplayExpandedState() {
  return false;
}

function readStoredThemePreference() {
  try {
    return normalizeThemePreference(localStorage.getItem(UI_THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function findThemeColorMeta(scheme) {
  return document.querySelector(`meta[name="theme-color"][media="(prefers-color-scheme: ${scheme})"]`);
}

function updateThemeColorMeta(themePreference) {
  const themeConfig = UI_THEMES[normalizeThemePreference(themePreference)] || UI_THEMES.system;
  const lightMeta = findThemeColorMeta("light");
  const darkMeta = findThemeColorMeta("dark");
  if (lightMeta) lightMeta.setAttribute("content", monetThemeColorOverrides?.light || themeConfig.lightThemeColor);
  if (darkMeta) darkMeta.setAttribute("content", monetThemeColorOverrides?.dark || themeConfig.darkThemeColor);
}

function applyThemePreference(themePreference) {
  const normalized = normalizeThemePreference(themePreference);
  if (normalized !== "monet" && monetThemeColorOverrides) {
    applyMonetTheme(null);
  }
  const root = document.documentElement;
  if (normalized === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", normalized);
  }
  updateThemeColorMeta(normalized);
  if (normalized === "monet") {
    requestAndroidMonetTheme();
  }
  return normalized;
}

function applyThemeTextOverrides(themePreference) {
  const normalized = normalizeThemePreference(themePreference);
  const overrides = (UI_THEMES[normalized] || UI_THEMES.system).textOverrides;
  if (typeof window.ragentApplyTranslations === "function") {
    window.ragentApplyTranslations();
  }
  if (!overrides) return;
  const doc = document;
  if (!doc?.querySelectorAll) return;
  for (const key of Object.keys(overrides)) {
    doc.querySelectorAll(`[data-i18n="${key}"]`).forEach((node) => {
      node.textContent = overrides[key];
    });
  }
}

let currentThemePreference = applyThemePreference(readStoredThemePreference());
applyThemeTextOverrides(currentThemePreference);

window.ragentApplyMonetTheme = applyMonetTheme;
window.ragentRequestMonetTheme = requestAndroidMonetTheme;
window.addEventListener("ragent:monet-theme", (event) => {
  applyMonetTheme(event?.detail?.theme || event?.detail || null);
});

document.addEventListener("DOMContentLoaded", () => {
  applyThemeTextOverrides(currentThemePreference);
}, { once: true });

window.ragentGetThemePreference = function getThemePreference() {
  return currentThemePreference;
};

window.ragentGetThinkingBlockDisplayMode = function getThinkingBlockDisplayMode() {
  return "collapsed";
};

window.ragentShouldExpandThinkingBlocksByDefault = function ragentShouldExpandThinkingBlocksByDefault() {
  return getThinkingBlockDisplayExpandedState();
};

window.ragentGetThinkingBlockDisplayOptions = function getThinkingBlockDisplayOptions() {
  const t = typeof window.ragentT === "function" ? window.ragentT : (key) => key;
  return [{ value: "collapsed", label: t("settings.thinkingBlocks.optionCollapsed") }];
};

window.ragentSetThemePreference = function setThemePreference(value) {
  currentThemePreference = applyThemePreference(value);
  applyThemeTextOverrides(currentThemePreference);
  try {
    localStorage.setItem(UI_THEME_STORAGE_KEY, currentThemePreference);
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent("ragent:themechange", {
      detail: { preference: currentThemePreference },
    }));
  } catch {}
  return currentThemePreference;
};

window.ragentSetThinkingBlockDisplayMode = function setThinkingBlockDisplayMode(value) {
  return "collapsed";
};

window.ragentGetThemeOptions = function getThemeOptions() {
  const t = typeof window.ragentT === "function" ? window.ragentT : (key) => key;
  return [
    { value: "system", label: t("settings.theme.optionSystem") },
    { value: "light", label: t("settings.theme.optionLight") },
    { value: "dark", label: t("settings.theme.optionDark") },
    { value: "blue", label: t("settings.theme.optionBlue") },
    { value: "amber", label: t("settings.theme.optionAmber") },
    { value: "purple", label: t("settings.theme.optionPurple") },
    { value: "green", label: t("settings.theme.optionGreen") },
    { value: "rose", label: t("settings.theme.optionRose") },
    { value: "teal", label: t("settings.theme.optionTeal") },
    { value: "monet", label: t("settings.theme.optionMonet") },
  ];
};

window.addEventListener("storage", (event) => {
  if (event.key && event.key !== UI_THEME_STORAGE_KEY) return;
  currentThemePreference = applyThemePreference(event.newValue);
  applyThemeTextOverrides(currentThemePreference);
});

window.addEventListener("ragent:localechange", () => {
  applyThemeTextOverrides(currentThemePreference);
});

function normalizeSidebarTab(tab) {
  if (tab === "agents") return "agents";
  if (tab === "settings") return "settings";
  if (tab === "model-providers") return "model-providers";
  if (tab === "harnesses") return "harnesses";
  if (tab === "account-policy") return "account-policy";
  return "sessions";
}

function normalizeNavigationState(raw) {
  let sessionId = null;
  let tab = null;

  if (raw && typeof raw === "object") {
    if (typeof raw.sessionId === "string") sessionId = raw.sessionId;
    if (typeof raw.tab === "string") tab = raw.tab;
    if (raw.url) {
      try {
        const url = new URL(raw.url, window.location.origin);
        if (!sessionId) sessionId = url.searchParams.get("session") || null;
        if (!tab) tab = url.searchParams.get("tab") || null;
      } catch {}
    }
  }

  return {
    sessionId:
      typeof sessionId === "string" && sessionId.trim()
        ? sessionId.trim()
        : null,
    tab: tab ? normalizeSidebarTab(tab) : null,
  };
}

function readNavigationStateFromLocation() {
  return normalizeNavigationState({
    sessionId: new URLSearchParams(window.location.search).get("session"),
    tab: new URLSearchParams(window.location.search).get("tab"),
  });
}

let pendingNavigationState = readNavigationStateFromLocation();
// The owner workspace opens on the notification-driven home surface. A stored
// session is still persisted for URL/state continuity after an explicit
// navigation, but it must not silently hijack a fresh owner entry.
const restoreStoredSessionOnInitialLoad = bootstrapAuthInfo?.role !== "owner"
  || bootstrapAuthInfo?.surfaceMode === "agent_scoped";
let currentSessionId =
  pendingNavigationState.sessionId ||
  (restoreStoredSessionOnInitialLoad
    ? localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)
    : null) ||
  null;
let hasAttachedSession = false;
let sessionStatus = "idle";
let reconnectTimer = null;
let sessions = [];
let hasLoadedSessions = false;
let archivedSessionCount = 0;
let archivedSessionsLoaded = false;
let archivedSessionsLoading = false;
let archivedSessionsRefreshPromise = null;
let visitorMode = false;
let surfaceMode = bootstrapAuthInfo?.surfaceMode || "owner";
let principalKind = bootstrapAuthInfo?.principalKind
  || (bootstrapAuthInfo?.role === "visitor" ? "visitor" : "owner");
let principalId = normalizeBootstrapText(bootstrapAuthInfo?.principalId || bootstrapAuthInfo?.visitorId);
// Cache entries are page/principal scoped.  A logout/login or target handoff
// must never reuse a response parsed under an earlier authenticated context,
// even when the visible principal id happens to be the same.
const authEpoch = `auth-${principalId || 'anonymous'}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
window.ragentAuthEpoch = authEpoch;
let authCapabilities = bootstrapAuthInfo?.capabilities
  ? { ...bootstrapAuthInfo.capabilities }
  : cloneAuthCapabilityDefaults(surfaceMode);
let scopedAgentContext = bootstrapAuthInfo?.currentAgent
  ? { ...bootstrapAuthInfo.currentAgent }
  : null;
let scopedRequestMode = false;
let visitorSessionId = null;
let shareSnapshotMode = false;
let shareSnapshotPayload = bootstrapShareSnapshot;
let currentSessionRefreshPromise = null;
let pendingCurrentSessionRefresh = false;
let hasSeenWsOpen = false;
const sidebarSessionRefreshPromises = new Map();
const pendingSidebarSessionRefreshes = new Set();

// Browser-side caches must be bounded independently of the DOM cap.  A user
// can visit hundreds of sessions and expand many immutable event bodies while
// the page stays open; retaining every parsed response eventually creates GC
// pauses even though only the current session is rendered.
function createBoundedClientCache({ maxEntries = 128, maxBytes = 8 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let bytes = 0;
  const estimate = (value) => {
    if (typeof value === "string") return value.length * 2;
    try { return JSON.stringify(value).length * 2; } catch { return 0; }
  };
  return {
    get size() { return entries.size; },
    has(key) { return entries.has(key); },
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      const entryBytes = estimate(value);
      if (entryBytes > maxBytes) return this;
      if (entries.has(key)) {
        bytes -= estimate(entries.get(key));
        entries.delete(key);
      }
      entries.set(key, value);
      bytes += entryBytes;
      while (entries.size > maxEntries || bytes > maxBytes) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        bytes -= estimate(entries.get(oldest));
        entries.delete(oldest);
      }
      return this;
    },
    delete(key) {
      if (!entries.has(key)) return false;
      bytes -= estimate(entries.get(key));
      return entries.delete(key);
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    deleteMatching(predicate) {
      for (const key of entries.keys()) {
        if (predicate(key)) this.delete(key);
      }
    },
  };
}

const jsonResponseCache = createBoundedClientCache({ maxEntries: 256, maxBytes: 16 * 1024 * 1024 });
const eventBodyCache = createBoundedClientCache({ maxEntries: 128, maxBytes: 32 * 1024 * 1024 });
const eventBodyRequests = createBoundedClientCache({ maxEntries: 128, maxBytes: 2 * 1024 * 1024 });
const eventBlockCache = createBoundedClientCache({ maxEntries: 128, maxBytes: 16 * 1024 * 1024 });
const eventBlockRequests = createBoundedClientCache({ maxEntries: 128, maxBytes: 2 * 1024 * 1024 });
const messageTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const renderedEventState = {
  sessionId: null,
  earliestSeq: 0,
  nextBeforeSeq: null,
  latestSeq: 0,
  timelineItemCount: 0,
  runState: "idle",
  runActivity: null,
  operationNodesById: new Map(),
  operationSnapshotsById: new Map(),
  expandedOperationIds: new Set(),
  runningBlockExpanded: false,
  hasMoreBefore: false,
  loadingOlder: false,
};

// timeline-runtime.js is loaded as a classic script and intentionally keeps
// the DOM projection behind a small global bridge. Keep this reference live so
// session-http.js and the runtime observe the same paging state object.
window.renderedEventState = renderedEventState;

const chatStore = chatStoreModel.createStore({
  sessions,
  currentSessionId,
  hasAttachedSession,
  hasLoadedSessions,
  archivedSessionCount,
  archivedSessionsLoaded,
  archivedSessionsLoading,
  activeSourceFilter: FILTER_ALL_VALUE,
  activeTab: normalizeSidebarTab(
    pendingNavigationState.tab
    || localStorage.getItem(ACTIVE_SIDEBAR_TAB_STORAGE_KEY)
    || "sessions",
  ),
  sessionStatus,
});

function syncChatStoreGlobals(nextState = chatStore.getState()) {
  currentSessionId = nextState.currentSessionId;
  hasAttachedSession = nextState.hasAttachedSession;
  sessionStatus = nextState.sessionStatus;
  sessions = nextState.sessions;
  hasLoadedSessions = nextState.hasLoadedSessions;
  archivedSessionCount = nextState.archivedSessionCount;
  archivedSessionsLoaded = nextState.archivedSessionsLoaded;
  archivedSessionsLoading = nextState.archivedSessionsLoading;
}

chatStore.subscribe((nextState) => {
  const prevSessionId = currentSessionId;
  const prevHasAttachedSession = hasAttachedSession;
  syncChatStoreGlobals(nextState);
  if (
    nextState.currentSessionId !== prevSessionId
    || (prevHasAttachedSession === true && nextState.hasAttachedSession !== true)
  ) {
    // Approval state is scoped to the selected session, including the null/home
    // state. Reset on every transition so an approval from the previous session
    // cannot survive an attach, a failed attach, or a return to the home view.
    window.RagentDecisions?.reset?.();
    const generation = typeof window.getSessionNavigationGeneration === "function"
      ? window.getSessionNavigationGeneration()
      : 0;
    window.RagentDecisions?.beginSessionContext?.(nextState.currentSessionId || "", generation, { resetState: false });
  }
});
syncChatStoreGlobals();
window.RagentDecisions?.beginSessionContext?.(currentSessionId || "", 0);

function getChatStore() {
  return chatStore;
}

function getChatStoreStateSnapshot() {
  return chatStore.getState();
}

function dispatchChatStore(action) {
  return chatStore.dispatch(action);
}

function getChatStoreFallbackState() {
  return chatStoreModel.createState({
    sessions,
    currentSessionId,
    hasAttachedSession,
    hasLoadedSessions,
    archivedSessionCount,
    archivedSessionsLoaded,
    archivedSessionsLoading,
    activeSourceFilter: getActiveSourceFilterValue(),
    activeTab: getActiveSidebarTabValue(),
    sessionStatus,
  });
}

function reduceChatStoreFallback(reducer, ...args) {
  const nextState = reducer(getChatStoreFallbackState(), ...args);
  syncChatStoreGlobals(nextState);
  return nextState;
}

function replaceChatState(state = {}, options = {}) {
  if (typeof dispatchChatStore === "function") {
    return dispatchChatStore({
      type: "replace-state",
      state,
      ...options,
    });
  }
  return reduceChatStoreFallback(chatStoreModel.replaceState, state, options);
}

function replaceActiveChatSessionsState(nextSessions = [], options = {}) {
  if (typeof dispatchChatStore === "function") {
    return dispatchChatStore({
      type: "replace-active-sessions",
      sessions: nextSessions,
      ...options,
    });
  }
  return reduceChatStoreFallback(chatStoreModel.replaceActiveSessions, nextSessions, options);
}

function replaceArchivedChatSessionsState(nextSessions = [], options = {}) {
  if (typeof dispatchChatStore === "function") {
    return dispatchChatStore({
      type: "replace-archived-sessions",
      sessions: nextSessions,
      ...options,
    });
  }
  return reduceChatStoreFallback(chatStoreModel.replaceArchivedSessions, nextSessions, options);
}

function upsertChatSessionState(session, options = {}) {
  if (typeof dispatchChatStore === "function") {
    return dispatchChatStore({
      type: "upsert-session",
      session,
      ...options,
    });
  }
  return reduceChatStoreFallback(chatStoreModel.upsertSession, session, options);
}

function removeChatSessionState(sessionId, options = {}) {
  if (typeof dispatchChatStore === "function") {
    return dispatchChatStore({
      type: "remove-session",
      sessionId,
      ...options,
    });
  }
  return reduceChatStoreFallback(chatStoreModel.removeSession, sessionId, options);
}

function setChatCurrentSession(sessionId, options = {}) {
  if (typeof dispatchChatStore === "function") {
    return dispatchChatStore({
      type: "set-current-session",
      sessionId,
      ...options,
    });
  }
  return reduceChatStoreFallback(chatStoreModel.setCurrentSession, sessionId, options);
}

function setChatArchivedSessionsLoading(value) {
  if (typeof dispatchChatStore === "function") {
    return dispatchChatStore({
      type: "set-archived-sessions-loading",
      value,
    });
  }
  return reduceChatStoreFallback(chatStoreModel.setArchivedSessionsLoading, value);
}

function setChatActiveSourceFilter(value, options = {}) {
  if (typeof dispatchChatStore === "function") {
    return dispatchChatStore({
      type: "set-active-source-filter",
      value,
      ...options,
    });
  }
  return reduceChatStoreFallback(chatStoreModel.setActiveSourceFilter, value, options);
}

function setChatActiveTab(value, options = {}) {
  if (typeof dispatchChatStore === "function") {
    return dispatchChatStore({
      type: "set-active-tab",
      value,
      ...options,
    });
  }
  return reduceChatStoreFallback(chatStoreModel.setActiveTab, value, options);
}

function setChatSessionStatus(value) {
  if (typeof dispatchChatStore === "function") {
    return dispatchChatStore({
      type: "set-session-status",
      value,
    });
  }
  return reduceChatStoreFallback(chatStoreModel.setSessionStatus, value);
}

function getActiveSidebarTabValue() {
  const storeValue = getChatStoreStateSnapshot()?.activeTab;
  if (typeof storeValue === "string" && storeValue.trim()) {
    return normalizeSidebarTab(storeValue);
  }
  return normalizeSidebarTab(
    pendingNavigationState.tab
    || localStorage.getItem(ACTIVE_SIDEBAR_TAB_STORAGE_KEY)
    || "sessions",
  );
}

function getActiveSourceFilterValue() {
  // The source filter UI was removed; sessions always render unfiltered.
  const value = getChatStoreStateSnapshot()?.activeSourceFilter;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return FILTER_ALL_VALUE;
}

function getChatStoreSession(sessionId = currentSessionId) {
  return chatStoreModel.findSession(getChatStoreStateSnapshot(), sessionId);
}

function setRunningEventBlockExpanded(sessionId, expanded) {
  if (!sessionId || renderedEventState.sessionId !== sessionId) return;
  renderedEventState.runningBlockExpanded = expanded === true;
}

function shouldUseVisitorRequests() {
  return visitorMode === true || scopedRequestMode === true;
}

function isAgentScopedMode() {
  return surfaceMode === "agent_scoped";
}

function getActiveAuthCapabilities() {
  return authCapabilities
    ? { ...authCapabilities }
    : cloneAuthCapabilityDefaults(surfaceMode);
}

function hasAuthCapability(name, fallback = false) {
  if (!name) return fallback;
  const capabilities = getActiveAuthCapabilities();
  return capabilities[name] === true ? true : fallback;
}

function canSwitchAgents() {
  return !visitorMode && hasAuthCapability("switchAgents");
}

function canManageAgents() {
  return !visitorMode && hasAuthCapability("manageAgents");
}

function canChangeRuntimeSelection() {
  return !visitorMode && hasAuthCapability("changeRuntime");
}

function canPublishShareSnapshots() {
  return !visitorMode && hasAuthCapability("publishShareSnapshot");
}

function canForkSessions() {
  return !visitorMode && hasAuthCapability("forkSession");
}

function canOrganizeSessionList() {
  return !visitorMode && hasAuthCapability("organizeSessionList");
}

function shouldPersistOwnerNavigationState() {
  return !visitorMode && !isAgentScopedMode();
}

function shouldEnableOwnerPushFeatures() {
  return !visitorMode && !isAgentScopedMode();
}

function withVisitorModeUrl(url) {
  const resolvedUrl = typeof window.ragentResolveProductUrl === "function"
    ? window.ragentResolveProductUrl(url)
    : new URL(String(url || ""), window.location.href).toString();
  const parsed = new URL(resolvedUrl, window.location.href);
  if (shouldUseVisitorRequests()) {
    parsed.searchParams.set("visitor", "1");
  }
  if (parsed.origin === window.location.origin) {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return parsed.toString();
}

let currentTokens = 0;

const DEFAULT_TOOL_ID = "codex";
const LEGACY_AUTO_PREFERRED_TOOL_IDS = new Set(["codex", "micro-agent"]);

function normalizeStoredToolId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStoredAgentTemplateId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStoredAgentTemplateName(value) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ")
    : "";
}

function derivePreferredToolId(storedPreferredTool, storedLegacySelectedTool) {
  const preferred = normalizeStoredToolId(storedPreferredTool);
  const legacySelected = normalizeStoredToolId(storedLegacySelectedTool);
  if (preferred && !(LEGACY_AUTO_PREFERRED_TOOL_IDS.has(preferred) && !legacySelected)) {
    return preferred;
  }
  if (legacySelected) {
    return legacySelected;
  }
  return null;
}

const storedPreferredTool = normalizeStoredToolId(localStorage.getItem("preferredTool"));
const storedLegacySelectedTool = normalizeStoredToolId(localStorage.getItem("selectedTool"));

let preferredTool = derivePreferredToolId(storedPreferredTool, storedLegacySelectedTool);
let selectedTool = preferredTool;
let preferredAgentTemplateId = normalizeStoredAgentTemplateId(
  localStorage.getItem(PREFERRED_AGENT_TEMPLATE_STORAGE_KEY),
);
let preferredAgentTemplateName = normalizeStoredAgentTemplateName(
  localStorage.getItem(PREFERRED_AGENT_TEMPLATE_NAME_STORAGE_KEY),
);
// Default thinking to enabled; only disable if explicitly set to 'false'
let thinkingEnabled = localStorage.getItem("thinkingEnabled") !== "false";
// Model/effort are stored per-tool: "selectedModel_claude", "selectedModel_codex"
let selectedModel = null;
let selectedEffort = null;
let selectedServiceTier = "standard";
let selectedPermissionMode = null;
let currentToolModels = []; // model list for current tool
let currentToolBaseReasoning = { kind: "none", label: "Reasoning" };
let currentToolEffortLevels = null; // null = binary toggle, string[] = effort dropdown
let currentToolServiceTiers = ["standard"];
let currentToolReasoningKind = "none";
let currentToolReasoningLabel = "Reasoning";
let currentToolReasoningDefault = null;
let allToolsList = [];
let toolsList = [];
let isDesktop = window.matchMedia("(min-width: 768px)").matches;
const ADD_MORE_TOOL_VALUE = "__add_more__";
const COLLAPSED_GROUPS_STORAGE_KEY = "collapsedSessionGroups";
const SESSION_VIEW_MODE_STORAGE_KEY = "sessionViewMode";
let isSavingToolConfig = false;
let collapsedFolders = JSON.parse(
  localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY) ||
    localStorage.getItem("collapsedFolders") ||
    "{}",
);
let sessionSearchQuery = "";
let sessionViewMode = localStorage.getItem(SESSION_VIEW_MODE_STORAGE_KEY) || "inbox";

function setPreferredAgentTemplate(value, { name = "", persist = true } = {}) {
  preferredAgentTemplateId = normalizeStoredAgentTemplateId(value);
  preferredAgentTemplateName = preferredAgentTemplateId
    ? normalizeStoredAgentTemplateName(name)
    : "";
  if (persist) {
    try {
      if (preferredAgentTemplateId) {
        localStorage.setItem(PREFERRED_AGENT_TEMPLATE_STORAGE_KEY, preferredAgentTemplateId);
      } else {
        localStorage.removeItem(PREFERRED_AGENT_TEMPLATE_STORAGE_KEY);
      }
      if (preferredAgentTemplateName) {
        localStorage.setItem(PREFERRED_AGENT_TEMPLATE_NAME_STORAGE_KEY, preferredAgentTemplateName);
      } else {
        localStorage.removeItem(PREFERRED_AGENT_TEMPLATE_NAME_STORAGE_KEY);
      }
    } catch {}
  }
  window.dispatchEvent(new CustomEvent("ragent:preferred-agent-change", {
    detail: {
      templateId: preferredAgentTemplateId,
      templateName: preferredAgentTemplateName,
    },
  }));
  return {
    templateId: preferredAgentTemplateId,
    templateName: preferredAgentTemplateName,
  };
}

function getPreferredAgentTemplateId() {
  return preferredAgentTemplateId || "";
}

function getPreferredAgentTemplateName() {
  return preferredAgentTemplateName || "";
}

try {
  localStorage.removeItem(LEGACY_SESSION_SEND_FAILURES_STORAGE_KEY);
} catch {}

let sessionReviewMarkers = readStoredJsonValue(SESSION_REVIEW_MARKERS_STORAGE_KEY, {});
let sessionReviewBaselineAt = readStoredTimestampValue(SESSION_REVIEW_BASELINE_AT_STORAGE_KEY);
if (!sessionReviewBaselineAt) {
  sessionReviewBaselineAt = new Date().toISOString();
  writeStoredTimestampValue(SESSION_REVIEW_BASELINE_AT_STORAGE_KEY, sessionReviewBaselineAt);
}

function readStoredJsonValue(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJsonValue(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function normalizeStoredTimestamp(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  const time = new Date(trimmed).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function readStoredTimestampValue(key) {
  try {
    return normalizeStoredTimestamp(localStorage.getItem(key));
  } catch {
    return "";
  }
}

function writeStoredTimestampValue(key, value) {
  try {
    const normalized = normalizeStoredTimestamp(value);
    if (normalized) {
      localStorage.setItem(key, normalized);
    } else {
      localStorage.removeItem(key);
    }
  } catch {}
}

function getSessionReviewedAtTime(value) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function getSessionReviewBaselineAt() {
  return sessionReviewBaselineAt || "";
}

function getLocalSessionReviewedAt(sessionId) {
  if (!sessionId || !sessionReviewMarkers || typeof sessionReviewMarkers !== "object") return "";
  const normalized = normalizeStoredTimestamp(sessionReviewMarkers[sessionId]);
  if (normalized) return normalized;
  if (Object.prototype.hasOwnProperty.call(sessionReviewMarkers, sessionId)) {
    const next = { ...sessionReviewMarkers };
    delete next[sessionId];
    sessionReviewMarkers = next;
    writeStoredJsonValue(SESSION_REVIEW_MARKERS_STORAGE_KEY, sessionReviewMarkers);
  }
  return "";
}

function setLocalSessionReviewedAt(sessionId, stamp) {
  if (!sessionId) return "";
  const normalized = normalizeStoredTimestamp(stamp);
  const current = getLocalSessionReviewedAt(sessionId);
  if (normalized) {
    if (getSessionReviewedAtTime(normalized) <= getSessionReviewedAtTime(current)) {
      return current;
    }
    sessionReviewMarkers = {
      ...sessionReviewMarkers,
      [sessionId]: normalized,
    };
    writeStoredJsonValue(SESSION_REVIEW_MARKERS_STORAGE_KEY, sessionReviewMarkers);
  } else if (Object.prototype.hasOwnProperty.call(sessionReviewMarkers, sessionId)) {
    const next = { ...sessionReviewMarkers };
    delete next[sessionId];
    sessionReviewMarkers = next;
    writeStoredJsonValue(SESSION_REVIEW_MARKERS_STORAGE_KEY, sessionReviewMarkers);
  }

  const existing = sessions.find((session) => session.id === sessionId);
  if (existing) {
    if (normalized) {
      existing.localReviewedAt = normalized;
    } else {
      delete existing.localReviewedAt;
    }
  }

  return normalized || "";
}
