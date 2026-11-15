function t(key, vars) {
  return window.ragentT ? window.ragentT(key, vars) : key;
}

const HIDDEN_MANAGED_AGENT_IDS = new Set([
  "email",
  "chat",
]);
const CREATE_AGENT_STARTER_PRESET = "create_agent";
let managedAppsCache = [];
let managedAppsLoaded = false;
const settingsConnectorsList = document.getElementById("settingsConnectorsList");
const settingsSessionPresentationList = document.getElementById("settingsSessionPresentationList");
let connectorSurfacesCache = [];
let connectorSurfacesLoaded = false;
let expandedConnectorSurfaceId = "";

function canManageAgentsFromUi() {
  return typeof canManageAgents === "function"
    ? canManageAgents()
    : !visitorMode;
}

function isAgentScopedModeFromUi() {
  return typeof isAgentScopedMode === "function"
    ? isAgentScopedMode()
    : false;
}

function showSettingsAgentsMessage(message) {
  if (!settingsAgentsList) return;
  settingsAgentsList.innerHTML = `<div class="settings-app-empty">${message}</div>`;
}

function resolveSettingsAppKind(app) {
  return app?.builtin
    ? t("settings.apps.kind.builtin")
    : t("settings.apps.kind.custom");
}

function describeSettingsApp(app) {
  if (!app?.id) return "";
  if (app.id === "chat") {
    return t("settings.apps.label.defaultConversation");
  }
  if (app.builtin) {
    return t("settings.apps.label.builtinAgent");
  }
  return "";
}

function shouldShowManagedApp(app) {
  if (!app?.id) return false;
  return !HIDDEN_MANAGED_AGENT_IDS.has(app.id);
}

function sortManagedApps(apps = []) {
  return [...apps].sort((left, right) => {
    if (left?.id === "chat") return -1;
    if (right?.id === "chat") return 1;
    if (left?.builtin && !right?.builtin) return -1;
    if (!left?.builtin && right?.builtin) return 1;
    return String(left?.name || "").localeCompare(String(right?.name || ""));
  });
}

const SETTINGS_CATALOG_CACHE_MAX_AGE_MS = 10_000;

async function fetchManagedApps({ forceFresh = false } = {}) {
  if (visitorMode || !canManageAgentsFromUi()) return [];
  const requestOptions = forceFresh
    ? { revalidate: false, cache: "no-store" }
    : { cacheMaxAgeMs: SETTINGS_CATALOG_CACHE_MAX_AGE_MS };
  const data = typeof fetchJsonOrRedirect === "function"
    ? await fetchJsonOrRedirect("/api/agents", requestOptions)
    : await (window.ragentFetch || fetch)("/api/agents", requestOptions).then((response) => response.json());
  const apps = Array.isArray(data?.agents) ? data.agents : [];
  managedAppsCache = apps;
  managedAppsLoaded = true;
  return apps;
}


function temporarilyUpdateButtonLabel(button, label, {
  resetLabel = "",
  durationMs = 1600,
  keepDisabled = false,
} = {}) {
  if (!button) return;
  const previousLabel = resetLabel || button.textContent || "";
  button.textContent = label;
  button.disabled = keepDisabled;
  window.setTimeout(() => {
    button.textContent = previousLabel;
    button.disabled = false;
  }, durationMs);
}

async function openManagedAppSession(app, { rememberPreference = true } = {}) {
  const tool = typeof app?.tool === "string" && app.tool.trim()
    ? app.tool.trim()
    : (preferredTool || selectedTool || toolsList[0]?.id || "");
  if (!tool || typeof dispatchAction !== "function") {
    throw new Error(t("settings.apps.openFailed"));
  }
  if (typeof switchTab === "function") {
    switchTab("sessions");
  }
  if (typeof closeSidebarFn === "function" && !isDesktop) {
    closeSidebarFn();
  }
  if (rememberPreference && typeof setPreferredAgentTemplate === "function") {
    setPreferredAgentTemplate(app.id || "", { name: app.name || "" });
  }
  await dispatchAction({
    action: "create",
    folder: typeof window.ragentGetSelectedSessionFolder === "function"
      ? window.ragentGetSelectedSessionFolder()
      : (typeof window.ragentGetDefaultSessionFolder === "function"
        ? window.ragentGetDefaultSessionFolder()
        : "~"),
    tool,
    sourceId: DEFAULT_APP_ID,
    sourceName: DEFAULT_WEB_SOURCE_NAME,
    templateId: app.id || "",
    templateName: app.name || "",
    ...(typeof window.ragentGetSelectedProjectId === "function" && window.ragentGetSelectedProjectId()
      ? { projectId: window.ragentGetSelectedProjectId() }
      : {}),
  });
}

async function deleteManagedApp(app) {
  if (!app?.id || app.builtin) return;
  const confirmed = typeof window.confirm !== "function"
    ? true
    : window.confirm(t("settings.apps.deleteConfirm", {
      name: app.name || t("settings.apps.untitled"),
    }));
  if (!confirmed) return;
  if (typeof fetchJsonOrRedirect === "function") {
    await fetchJsonOrRedirect(`/api/agents/${encodeURIComponent(app.id)}`, {
      method: "DELETE",
    });
  } else {
    const response = await (window.ragentFetch || fetch)(`/api/agents/${encodeURIComponent(app.id)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(t("settings.apps.deleteFailed"));
    }
  }
  await renderSettingsAgentsPanel({ force: true });
}

function buildManagedAppCard(app) {
  const card = document.createElement("div");
  card.className = "settings-app-card";

  const header = document.createElement("div");
  header.className = "settings-app-card-header";

  // The solid four-point sparkle is the shared Agent mark across the bottom
  // action, subpage header, and each reusable-agent row.
  const icon = document.createElement("span");
  icon.className = "settings-app-icon";
  icon.setAttribute("data-icon", "sparkle-solid");
  icon.setAttribute("aria-hidden", "true");
  header.appendChild(icon);

  const name = document.createElement("div");
  name.className = "settings-app-name";
  name.textContent = app?.name || t("settings.apps.untitled");
  header.appendChild(name);

  const kind = document.createElement("div");
  kind.className = "settings-app-kind";
  kind.textContent = resolveSettingsAppKind(app);
  header.appendChild(kind);
  card.appendChild(header);

  const descriptionText = describeSettingsApp(app);
  if (descriptionText) {
    const description = document.createElement("div");
    description.className = "settings-app-description";
    description.textContent = descriptionText;
    card.appendChild(description);
  }

  const actions = document.createElement("div");
  actions.className = "settings-app-actions";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  // Open is the primary per-card decision (start a session); delete stays a
  // ghost with a danger affordance on hover so the two never read equally.
  openBtn.className = "settings-app-btn settings-app-btn-primary";
  openBtn.textContent = t("settings.apps.openSession");
  openBtn.addEventListener("click", async () => {
    openBtn.disabled = true;
    try {
      await openManagedAppSession(app);
    } catch (error) {
      openBtn.disabled = false;
      showSettingsAgentsMessage(error?.message || t("settings.apps.openFailed"));
    }
  });
  actions.appendChild(openBtn);

  if (!app?.builtin) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "settings-app-btn settings-app-btn-danger";
    deleteBtn.textContent = t("settings.apps.delete");
    deleteBtn.addEventListener("click", async () => {
      deleteBtn.disabled = true;
      try {
        await deleteManagedApp(app);
      } catch (error) {
        deleteBtn.disabled = false;
        showSettingsAgentsMessage(error?.message || t("settings.apps.deleteFailed"));
      }
    });
    actions.appendChild(deleteBtn);
  }

  card.appendChild(actions);
  if (typeof window.RagentIcons?.hydrate === "function") {
    window.RagentIcons.hydrate(card);
  }
  return card;
}

function hydrateSettingsAppIcons() {
  if (typeof window.RagentIcons?.hydrate === "function") {
    window.RagentIcons.hydrate(settingsAgentsList);
  }
}

function buildSkeletonAgentCard() {
  // Mirrors the real card's rhythm: icon + title row (name bar + kind pill),
  // description bars, then the primary action placeholder.
  return `<div class="settings-app-skeleton-card">
    <span class="settings-app-skeleton-icon" aria-hidden="true"></span>
    <div class="settings-app-skeleton-body">
      <div class="settings-app-skeleton-title">
        <span class="settings-app-skeleton-bar" style="width: 46%"></span>
        <span class="settings-app-skeleton-pill" aria-hidden="true"></span>
      </div>
      <span class="settings-app-skeleton-bar" style="width: 78%"></span>
      <span class="settings-app-skeleton-bar" style="width: 34%"></span>
      <span class="settings-app-skeleton-buttons" aria-hidden="true"></span>
    </div>
  </div>`;
}

async function renderSettingsAgentsPanel({ force = false } = {}) {
  if (!settingsAgentsList) return;
  if (visitorMode || !canManageAgentsFromUi()) {
    settingsAgentsList.innerHTML = `<div class="settings-app-empty">${t("settings.apps.ownerOnly")}</div>`;
    if (createAgentBtn) createAgentBtn.disabled = true;
    return;
  }

  if (createAgentBtn) {
    createAgentBtn.disabled = false;
  }

  if (force || !managedAppsLoaded) {
    // Skeleton cards keep the list's visual rhythm while agents load; the
    // status text stays available to assistive tech via role=status.
    settingsAgentsList.innerHTML = `<div class="settings-app-skeleton" role="status">
      <span class="sr-only">${t("settings.apps.loading")}</span>
      ${buildSkeletonAgentCard()}${buildSkeletonAgentCard()}${buildSkeletonAgentCard()}
    </div>`;
    try {
      await fetchManagedApps({ forceFresh: force });
      if (typeof refreshInlineAgentPicker === "function") {
        void refreshInlineAgentPicker({ force: true });
      }
    } catch (error) {
      settingsAgentsList.innerHTML = `<div class="settings-app-empty">${error?.message || t("settings.apps.loadingFailed")}</div>`;
      return;
    }
  }

  const visibleApps = sortManagedApps(managedAppsCache.filter((app) => shouldShowManagedApp(app)));
  settingsAgentsList.innerHTML = "";
  if (visibleApps.length === 0) {
    // Narrative empty state; the header "create agent" button stays the
    // single primary entry point (mirrors the L1 projects empty state).
    settingsAgentsList.innerHTML = `<div class="settings-app-empty">
      <span class="settings-app-empty-icon" data-icon="sparkle-solid" aria-hidden="true"></span>
      <div class="settings-app-empty-title">${t("settings.apps.none")}</div>
      <div class="settings-app-empty-note">${t("settings.apps.defaultStatus")}</div>
    </div>`;
    hydrateSettingsAppIcons();
    return;
  }
  for (const app of visibleApps) {
    settingsAgentsList.appendChild(buildManagedAppCard(app));
  }
}

window.RagentManagedAgents = Object.freeze({
  async list({ force = false } = {}) {
    if (force || !managedAppsLoaded) {
      await fetchManagedApps({ forceFresh: force });
    }
    return sortManagedApps(managedAppsCache.filter((app) => shouldShowManagedApp(app)));
  },
  async open(agentId) {
    const apps = await this.list();
    const app = apps.find((entry) => entry?.id === agentId);
    if (!app) return false;
    await openManagedAppSession(app);
    return true;
  },
});

async function createAgentBuilderSession() {
  if (createAgentBtn) {
    createAgentBtn.disabled = true;
  }
  try {
    const tool = preferredTool || selectedTool || toolsList[0]?.id || "";
    if (!tool || typeof dispatchAction !== "function") {
      throw new Error(t("settings.apps.openFailed"));
    }
    if (typeof switchTab === "function") {
      switchTab("sessions");
    }
    if (typeof closeSidebarFn === "function" && !isDesktop) {
      closeSidebarFn();
    }
    await dispatchAction({
      action: "create",
      folder: typeof window.ragentGetSelectedSessionFolder === "function"
        ? window.ragentGetSelectedSessionFolder()
        : (typeof window.ragentGetDefaultSessionFolder === "function"
          ? window.ragentGetDefaultSessionFolder()
          : "~"),
      tool,
      name: t("settings.apps.create"),
      sourceId: DEFAULT_APP_ID,
      sourceName: DEFAULT_WEB_SOURCE_NAME,
      starterPreset: CREATE_AGENT_STARTER_PRESET,
      ...(typeof window.ragentGetSelectedProjectId === "function" && window.ragentGetSelectedProjectId()
        ? { projectId: window.ragentGetSelectedProjectId() }
        : {}),
      forceComposerFocus: true,
    });
  } finally {
    if (createAgentBtn) {
      createAgentBtn.disabled = false;
    }
  }
}

function renderUiLanguageOptions(selectEl, selectedValue = "auto") {
  if (!selectEl) return;
  const options = typeof window.ragentGetUiLanguageOptions === "function"
    ? window.ragentGetUiLanguageOptions()
    : [
      { value: "auto", label: t("settings.language.optionAuto") },
      { value: "zh-CN", label: t("settings.language.optionZhCN") },
      { value: "en", label: t("settings.language.optionEn") },
    ];
  selectEl.innerHTML = "";
  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    selectEl.appendChild(option);
  }
  selectEl.value = options.some((option) => option.value === selectedValue) ? selectedValue : "auto";
}

function syncUiLanguageSelect() {
  renderUiLanguageOptions(
    uiLanguageSelect,
    typeof window.ragentGetUiLanguagePreference === "function"
      ? window.ragentGetUiLanguagePreference()
      : "auto",
  );
}

function initUiLanguageSettings() {
  if (!uiLanguageSelect) {
    return;
  }
  syncUiLanguageSelect();
  if (uiLanguageSelect.dataset.bound === "true") {
    return;
  }
  uiLanguageSelect.addEventListener("change", () => {
    const value = uiLanguageSelect.value || "auto";
    if (typeof window.ragentSetUiLanguagePreference === "function") {
      window.ragentSetUiLanguagePreference(value, { reload: true });
    }
  });
  uiLanguageSelect.dataset.bound = "true";
}

function renderThemeOptions(selectEl, selectedValue = "system") {
  if (!selectEl) return;
  const options = typeof window.ragentGetThemeOptions === "function"
    ? window.ragentGetThemeOptions()
    : [
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
  selectEl.innerHTML = "";
  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    selectEl.appendChild(option);
  }
  selectEl.value = options.some((option) => option.value === selectedValue) ? selectedValue : "system";
}

function syncThemeSelect() {
  const uiThemeSelect = document.getElementById("uiThemeSelect");
  if (!uiThemeSelect) return;
  const currentPreference = typeof window.ragentGetThemePreference === "function"
    ? window.ragentGetThemePreference()
    : "system";
  renderThemeOptions(uiThemeSelect, currentPreference);
}

function initThemeSettings() {
  const uiThemeSelect = document.getElementById("uiThemeSelect");
  if (!uiThemeSelect) {
    return;
  }
  syncThemeSelect();
  if (uiThemeSelect.dataset.bound === "true") {
    return;
  }
  uiThemeSelect.addEventListener("change", () => {
    const value = uiThemeSelect.value || "system";
    if (typeof window.ragentSetThemePreference === "function") {
      window.ragentSetThemePreference(value);
    }
    syncThemeSelect();
  });
  uiThemeSelect.dataset.bound = "true";
}

function renderThinkingBlockDisplayOptions(selectEl, selectedValue = "collapsed") {
  if (!selectEl) return;
  const options = typeof window.ragentGetThinkingBlockDisplayOptions === "function"
    ? window.ragentGetThinkingBlockDisplayOptions()
    : [
      { value: "expanded", label: t("settings.thinkingBlocks.optionExpanded") },
      { value: "collapsed", label: t("settings.thinkingBlocks.optionCollapsed") },
    ];
  selectEl.innerHTML = "";
  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    selectEl.appendChild(option);
  }
  selectEl.value = options.some((option) => option.value === selectedValue) ? selectedValue : "collapsed";
}

function syncThinkingBlockDisplaySelect() {
  if (!thinkingBlockDisplaySelect) return;
  const currentMode = typeof window.ragentGetThinkingBlockDisplayMode === "function"
    ? window.ragentGetThinkingBlockDisplayMode()
    : "collapsed";
  renderThinkingBlockDisplayOptions(thinkingBlockDisplaySelect, currentMode);
}

function initThinkingBlockDisplaySettings() {
  if (!thinkingBlockDisplaySelect) {
    return;
  }
  syncThinkingBlockDisplaySelect();
  if (thinkingBlockDisplaySelect.dataset.bound === "true") {
    return;
  }
  thinkingBlockDisplaySelect.addEventListener("change", () => {
    const value = thinkingBlockDisplaySelect.value || "collapsed";
    if (typeof window.ragentSetThinkingBlockDisplayMode === "function") {
      window.ragentSetThinkingBlockDisplayMode(value);
    }
    syncThinkingBlockDisplaySelect();
  });
  thinkingBlockDisplaySelect.dataset.bound = "true";
}

function renderInstallSettingsPanel() {
  const installBtn = document.getElementById("settingsInstallAppBtn");
  const statusEl = document.getElementById("settingsInstallStatus");
  if (!installBtn) return;

  const state = typeof window.ragentGetInstallFlowState === "function"
    ? window.ragentGetInstallFlowState()
    : { standalone: false, mobileEligible: false };

  installBtn.disabled = visitorMode;
  installBtn.textContent = t("settings.install.open");

  if (!statusEl) return;

  if (state.standalone) {
    statusEl.textContent = t("settings.install.statusStandalone");
  } else if (state.mobileEligible) {
    statusEl.textContent = t("settings.install.statusFallback");
  } else {
    statusEl.textContent = t("settings.install.statusDesktop");
  }
  statusEl.hidden = false;
}

function initInstallSettings() {
  const installBtn = document.getElementById("settingsInstallAppBtn");
  if (!installBtn) return;

  renderInstallSettingsPanel();

  if (installBtn.dataset.bound !== "true") {
    installBtn.addEventListener("click", async () => {
      installBtn.disabled = true;
      try {
        if (typeof window.ragentOpenInstallFlow === "function") {
          await window.ragentOpenInstallFlow({ source: "settings_button" });
        }
      } finally {
        installBtn.disabled = false;
        renderInstallSettingsPanel();
      }
    });
    installBtn.dataset.bound = "true";
  }
}

// Web 自助改密（静态 access token 下线后密码为唯一登录方式）
function openChangePasswordDialog() {
  const overlay = document.createElement("div");
  overlay.className = "settings-password-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1200;";
  const box = document.createElement("div");
  box.className = "settings-password-dialog";
  box.style.cssText = "background:var(--surface,#fff);border-radius:12px;padding:20px;width:min(92vw,360px);box-shadow:0 8px 30px rgba(0,0,0,.25);";
  const title = document.createElement("div");
  title.textContent = t("settings.password.title");
  title.style.cssText = "font-weight:600;margin-bottom:14px;font-size:15px;";
  const inputs = {};
  for (const [key, label, autocomplete] of [
    ["currentPassword", t("settings.password.current"), "current-password"],
    ["newPassword", t("settings.password.new"), "new-password"],
    ["confirmPassword", t("settings.password.confirm"), "new-password"],
  ]) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-bottom:10px;";
    const labelEl = document.createElement("div");
    labelEl.textContent = label;
    labelEl.style.cssText = "font-size:12px;color:var(--text-secondary,#666);margin-bottom:4px;";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = autocomplete;
    input.style.cssText = "width:100%;padding:8px 10px;border:1px solid var(--border,#ddd);border-radius:8px;font-size:14px;box-sizing:border-box;";
    wrap.appendChild(labelEl);
    wrap.appendChild(input);
    box.appendChild(wrap);
    inputs[key] = input;
  }
  const err = document.createElement("div");
  err.style.cssText = "color:#d33;font-size:12px;margin:8px 0;min-height:14px;";
  box.appendChild(err);
  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = t("action.cancel");
  cancelBtn.style.cssText = "padding:8px 14px;border:1px solid var(--border,#ddd);background:transparent;border-radius:8px;font-size:14px;cursor:pointer;";
  cancelBtn.addEventListener("click", () => overlay.remove());
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = t("settings.password.change");
  saveBtn.style.cssText = "padding:8px 14px;border:none;background:var(--accent,#2d6cdf);color:#fff;border-radius:8px;font-size:14px;cursor:pointer;";
  saveBtn.addEventListener("click", async () => {
    const currentPassword = inputs.currentPassword.value || "";
    const newPassword = inputs.newPassword.value || "";
    const confirmPassword = inputs.confirmPassword.value || "";
    err.textContent = "";
    if (newPassword !== confirmPassword) {
      err.textContent = t("settings.password.mismatch");
      return;
    }
    if (newPassword.length < 8) {
      err.textContent = t("settings.password.weak");
      return;
    }
    saveBtn.disabled = true;
    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        err.textContent = data?.error === "invalid-current-password"
          ? t("settings.password.error")
          : (data?.error || t("settings.password.error"));
        return;
      }
      overlay.remove();
      window.alert(t("settings.password.success"));
    } catch {
      err.textContent = t("settings.password.error");
    } finally {
      saveBtn.disabled = false;
    }
  });
  buttons.appendChild(cancelBtn);
  buttons.appendChild(saveBtn);
  box.appendChild(buttons);
  overlay.appendChild(box);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  inputs.currentPassword.focus();
}

function initChangePasswordSettings() {
  const changeBtn = document.getElementById("settingsChangePasswordBtn");
  if (!changeBtn) return;
  if (changeBtn.dataset.bound !== "true") {
    changeBtn.addEventListener("click", () => {
      if (typeof visitorMode === "boolean" && visitorMode) {
        window.alert(t("settings.password.error"));
        return;
      }
      openChangePasswordDialog();
    });
    changeBtn.dataset.bound = "true";
  }
}

function canManageConnectorSurfacesFromUi() {
  return !visitorMode && !isAgentScopedModeFromUi();
}

function resolveConnectorSurfaceUrl(entryUrl) {
  const normalized = typeof entryUrl === "string" ? entryUrl.trim() : "";
  if (!normalized) return "";
  if (typeof window.ragentResolveProductUrl === "function") {
    return window.ragentResolveProductUrl(normalized);
  }
  return new URL(normalized, window.location.origin).toString();
}

function getConnectorSurfaceCapabilityTone(surface) {
  return surface?.surface?.capabilityState === "ready" ? "ready" : "pending";
}

function getConnectorSurfaceCapabilityLabel(surface) {
  return surface?.surface?.capabilityState === "ready"
    ? t("settings.connectors.connected")
    : t("settings.connectors.needsAction");
}

function describeConnectorSurface(surface) {
  const statusMessage = typeof surface?.surface?.message === "string"
    ? surface.surface.message.trim()
    : "";
  if (statusMessage) return statusMessage;
  const fallbackDescription = typeof surface?.description === "string"
    ? surface.description.trim()
    : "";
  return fallbackDescription || t("settings.connectors.defaultDescription");
}

async function fetchConnectorSurfaces({ forceFresh = false } = {}) {
  if (!canManageConnectorSurfacesFromUi()) return [];
  const requestOptions = forceFresh
    ? { revalidate: false, cache: "no-store" }
    : { cacheMaxAgeMs: SETTINGS_CATALOG_CACHE_MAX_AGE_MS };
  const data = typeof fetchJsonOrRedirect === "function"
    ? await fetchJsonOrRedirect("/api/connectors/surfaces", requestOptions)
    : await (window.ragentFetch || fetch)("/api/connectors/surfaces", requestOptions).then((response) => response.json());
  const surfaces = Array.isArray(data?.surfaces)
    ? data.surfaces.filter((surface) => surface && typeof surface === "object")
    : [];
  connectorSurfacesCache = surfaces;
  connectorSurfacesLoaded = true;
  return surfaces;
}

function buildConnectorSurfaceCard(surface) {
  const card = document.createElement("div");
  card.className = "settings-app-card";

  const header = document.createElement("div");
  header.className = "settings-app-card-header";

  const name = document.createElement("div");
  name.className = "settings-app-name";
  name.textContent = surface?.title || surface?.connectorId || t("settings.connectors.untitled");
  header.appendChild(name);

  const kind = document.createElement("div");
  kind.className = "settings-app-kind";
  kind.textContent = surface?.surfaceType || surface?.connectorId || "";
  header.appendChild(kind);
  card.appendChild(header);

  const description = document.createElement("div");
  description.className = "settings-app-description";
  description.textContent = describeConnectorSurface(surface);
  card.appendChild(description);

  const status = document.createElement("div");
  status.className = "settings-connector-status";

  const pill = document.createElement("span");
  pill.className = `settings-connector-pill ${getConnectorSurfaceCapabilityTone(surface)}`;
  pill.textContent = getConnectorSurfaceCapabilityLabel(surface);
  status.appendChild(pill);

  const detail = document.createElement("span");
  detail.className = "settings-app-meta";
  detail.textContent = t("settings.connectors.status", {
    status: surface?.surface?.status || surface?.surface?.capabilityState || surface?.surfaceType || t("settings.connectors.unknownStatus"),
  });
  status.appendChild(detail);
  card.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "settings-app-actions";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "settings-app-btn";
  openBtn.textContent = t("settings.connectors.open");
  openBtn.addEventListener("click", () => {
    const targetUrl = resolveConnectorSurfaceUrl(surface?.entryUrl);
    if (!targetUrl) return;
    const opened = window.open(targetUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      window.location.href = targetUrl;
    }
  });
  actions.appendChild(openBtn);

  const canEmbed = surface?.allowEmbed === true && !!resolveConnectorSurfaceUrl(surface?.entryUrl);
  if (canEmbed) {
    const embedBtn = document.createElement("button");
    embedBtn.type = "button";
    embedBtn.className = "settings-app-btn";
    embedBtn.textContent = expandedConnectorSurfaceId === surface.connectorId
      ? t("settings.connectors.hideHere")
      : t("settings.connectors.showHere");
    embedBtn.addEventListener("click", () => {
      expandedConnectorSurfaceId = expandedConnectorSurfaceId === surface.connectorId
        ? ""
        : surface.connectorId;
      renderSettingsConnectorsPanel();
    });
    actions.appendChild(embedBtn);
  }

  card.appendChild(actions);

  if (canEmbed && expandedConnectorSurfaceId === surface.connectorId) {
    const frameWrap = document.createElement("div");
    frameWrap.className = "settings-connector-frame-wrap";

    const iframe = document.createElement("iframe");
    iframe.className = "settings-connector-frame";
    iframe.loading = "lazy";
    iframe.src = resolveConnectorSurfaceUrl(surface.entryUrl);
    iframe.title = surface?.title || surface?.connectorId || t("settings.connectors.untitled");
    frameWrap.appendChild(iframe);
    card.appendChild(frameWrap);
  }

  return card;
}

async function renderSettingsConnectorsPanel({ force = false } = {}) {
  if (!settingsConnectorsList) return;
  if (!canManageConnectorSurfacesFromUi()) {
    settingsConnectorsList.innerHTML = `<div class="settings-app-empty">${t("settings.connectors.ownerOnly")}</div>`;
    return;
  }

  if (force || !connectorSurfacesLoaded) {
    settingsConnectorsList.innerHTML = `<div class="settings-app-empty">${t("settings.connectors.loading")}</div>`;
    try {
      await fetchConnectorSurfaces({ forceFresh: force });
    } catch (error) {
      settingsConnectorsList.innerHTML = `<div class="settings-app-empty">${error?.message || t("settings.connectors.loadingFailed")}</div>`;
      return;
    }
  }

  const visibleSurfaces = [...connectorSurfacesCache].sort((left, right) => {
    const leftTitle = String(left?.title || left?.connectorId || "");
    const rightTitle = String(right?.title || right?.connectorId || "");
    return leftTitle.localeCompare(rightTitle);
  });

  if (!expandedConnectorSurfaceId) {
    const recommendedSurface = visibleSurfaces.find((surface) => surface?.allowEmbed === true && surface?.surface?.capabilityState !== "ready");
    if (recommendedSurface) {
      expandedConnectorSurfaceId = recommendedSurface.connectorId || "";
    }
  } else if (!visibleSurfaces.some((surface) => surface?.connectorId === expandedConnectorSurfaceId)) {
    expandedConnectorSurfaceId = "";
  }

  settingsConnectorsList.innerHTML = "";
  if (visibleSurfaces.length === 0) {
    settingsConnectorsList.innerHTML = `<div class="settings-app-empty">${t("settings.connectors.none")}</div>`;
    return;
  }
  for (const surface of visibleSurfaces) {
    settingsConnectorsList.appendChild(buildConnectorSurfaceCard(surface));
  }
}

function resolveManagedSessionEntryMode(session) {
  return session?.entryMode === "read" ? "read" : "resume";
}

function renderManagedSessionEntryModeOptions(selectEl, selectedValue = "resume") {
  if (!selectEl) return;
  const options = [
    { value: "resume", label: t("settings.sessionPresentation.entryMode.resume") },
    { value: "read", label: t("settings.sessionPresentation.entryMode.read") },
  ];
  selectEl.innerHTML = "";
  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    selectEl.appendChild(option);
  }
  selectEl.value = options.some((option) => option.value === selectedValue) ? selectedValue : "resume";
}

function getManagedSettingsSession() {
  if (visitorMode || isAgentScopedModeFromUi()) return null;
  if (typeof getCurrentSession === "function") {
    return getCurrentSession();
  }
  return Array.isArray(sessions)
    ? sessions.find((session) => session?.id === currentSessionId) || null
    : null;
}

function renderSettingsSessionPresentationPanel() {
  if (!settingsSessionPresentationList) return;
  const previousSelect = settingsSessionPresentationList.querySelector?.(".settings-row-select") || null;
  if (previousSelect && typeof getCustomSelect === "function") {
    getCustomSelect(previousSelect)?.destroy?.();
  }
  if (visitorMode || isAgentScopedModeFromUi()) {
    settingsSessionPresentationList.innerHTML = `<div class="settings-row-empty">${t("settings.sessionPresentation.ownerOnly")}</div>`;
    return;
  }
  const session = getManagedSettingsSession();
  settingsSessionPresentationList.innerHTML = "";
  if (!session?.id) {
    return;
  }

  const row = document.createElement("div");
  row.className = "settings-row";

  const copy = document.createElement("div");
  copy.className = "settings-row-copy";

  const title = document.createElement("div");
  title.className = "settings-row-title";
  title.textContent = t("settings.sessionPresentation.title");
  copy.appendChild(title);
  const note = document.createElement("div");
  note.className = "settings-row-note";
  note.textContent = t("settings.sessionPresentation.note");
  copy.appendChild(note);
  row.appendChild(copy);

  const modeSelect = document.createElement("select");
  modeSelect.className = "settings-row-select";
  modeSelect.setAttribute("aria-label", t("settings.sessionPresentation.entryModeAriaLabel"));

  let currentEntryMode = resolveManagedSessionEntryMode(session);
  renderManagedSessionEntryModeOptions(modeSelect, currentEntryMode);

  const control = document.createElement("div");
  control.className = "settings-row-control";
  control.appendChild(modeSelect);

  const inlineStatus = document.createElement("div");
  inlineStatus.className = "settings-row-status settings-row-status-wide";
  inlineStatus.hidden = true;
  row.appendChild(control);
  row.appendChild(inlineStatus);

  modeSelect.addEventListener("change", async () => {
    const nextEntryMode = modeSelect.value === "read" ? "read" : "resume";
    if (nextEntryMode === currentEntryMode) {
      inlineStatus.hidden = true;
      inlineStatus.textContent = "";
      return;
    }
    modeSelect.disabled = true;
    inlineStatus.hidden = false;
    inlineStatus.textContent = t("settings.sessionPresentation.saving");
    try {
      const updated = typeof updateSessionRecord === "function"
        ? await updateSessionRecord(session.id, { entryMode: nextEntryMode })
        : null;
      currentEntryMode = resolveManagedSessionEntryMode(updated || session);
      modeSelect.value = currentEntryMode;
      inlineStatus.hidden = true;
      inlineStatus.textContent = "";
    } catch (error) {
      modeSelect.value = currentEntryMode;
      inlineStatus.hidden = false;
      inlineStatus.textContent = error?.message || t("settings.sessionPresentation.saveFailed");
    } finally {
      modeSelect.disabled = false;
    }
  });

  settingsSessionPresentationList.appendChild(row);
  if (typeof upgradeSelects === "function") {
    upgradeSelects("#settingsSessionPresentationList .settings-row-select", { className: "cs-settings-row" });
  }
}

initUiLanguageSettings();
initThemeSettings();
initThinkingBlockDisplaySettings();
initInstallSettings();
initChangePasswordSettings();
void renderSettingsConnectorsPanel();
renderSettingsSessionPresentationPanel();
void renderSettingsAgentsPanel();

if (createAgentBtn && createAgentBtn.dataset.bound !== "true") {
  createAgentBtn.addEventListener("click", () => {
    void createAgentBuilderSession().catch((error) => {
      if (settingsAgentsList) {
        settingsAgentsList.innerHTML = `<div class="settings-app-empty">${error?.message || t("settings.apps.openFailed")}</div>`;
      }
    });
  });
  createAgentBtn.dataset.bound = "true";
}

// The Agent pill opens the agents panel (the nav "Agent" tab was removed);
// force-fresh the panel contents whenever it is opened.
const agentPillBtn = document.getElementById("sidebarAgentBtn");
if (agentPillBtn && agentPillBtn.dataset.appsBound !== "true") {
  agentPillBtn.addEventListener("click", () => {
    void renderSettingsAgentsPanel({ force: true });
  });
  agentPillBtn.dataset.appsBound = "true";
}

// The sidebar settings entry is the bottom-right funnel button (the nav
// "Settings" tab was removed). Force-fresh the connectors panel when opened.
const settingsEntryBtn = document.getElementById("sidebarFilterBtn");
if (settingsEntryBtn && settingsEntryBtn.dataset.connectorsBound !== "true") {
  settingsEntryBtn.addEventListener("click", () => {
    void renderSettingsConnectorsPanel({ force: true });
  });
  settingsEntryBtn.dataset.connectorsBound = "true";
}

window.addEventListener("ragent:localechange", () => {
  if (uiLanguageSelect) {
    syncUiLanguageSelect();
  }
  syncThemeSelect();
  syncThinkingBlockDisplaySelect();
  renderInstallSettingsPanel();
  renderP2PSettingsStatus();
  void renderSettingsConnectorsPanel();
  renderSettingsSessionPresentationPanel();
  void renderSettingsAgentsPanel();
});

window.addEventListener("ragent:themechange", () => {
  syncThemeSelect();
});

window.addEventListener("ragent:thinkingblockdisplaychange", () => {
  syncThinkingBlockDisplaySelect();
});
