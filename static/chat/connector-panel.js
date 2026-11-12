// Composer inline Connector panel — opened from the "+" menu's
// "Connectors" item. Stage 2a: status listing reusing the connector
// surfaces data already fetched by settings-ui.js (`fetchConnectorSurfaces`
// / `connectorSurfacesCache`) plus authorization routing into Settings;
// per-connector content referencing lands with the backend listing API.
// Stage 2b: Codex MCP servers group — lists, adds and removes the codex
// mcp_servers through /api/codex/mcp-servers (owner-only backend wrapper
// around `codex mcp`).
// Stage 2c: Claude Code MCP servers group — same shape through
// /api/claude/mcp-servers (owner-only backend wrapper around `claude mcp`).
(function () {
  "use strict";

  let panel = null;
  let listEl = null;
  let manageBtn = null;
  let backEntryId = null;
  let panelOpen = false;
  let initialized = false;
  let trigger = null;
  let backdrop = null;
  let handleZone = null;
  let sheetDrag = null;
  let sheetDragResetTimer = null;
  let backdropHideTimer = null;
  let restoreFocus = false;
  let focusBeforeOpen = null;
  let focusScopeDeactivate = null;
  let loadGeneration = 0;
  let codexMcpServers = [];
  let codexMcpLoadFailed = false;
  let codexMcpErrorCode = "";
  let codexMcpProvider = "";
  let codexCapabilities = [];
  let codexMcpCapabilities = [];
  let codexCapabilityError = false;
  let codexPluginsUnavailable = false;
  let codexPluginPreference = null;
  let codexSyncState = null;
  let codexSyncMode = "";
  let codexSyncGeneration = 0;
  let codexFormOpen = false;
  let codexRemoveCandidate = "";
  let claudeMcpServers = [];
  let claudeMcpLoadFailed = false;
  let claudeFormOpen = false;
  let claudeRemoveCandidate = "";
  let calendarFeed = null;
  let calendarGoogleStatus = null;
  let calendarLoadFailed = false;
  // Google 账号作为跨设备 owner 登录凭据的绑定状态（/api/auth/google/status）
  let googleOwnerStatus = null;
  let gmailStatus = null;
  let gmailLoadFailed = false;
  let driveStatus = null;
  let driveLoadFailed = false;
  let githubStatus = null;
  let githubLoadFailed = false;
  let githubFormOpen = false;
  let mailStatus = null;
  let mailLoadFailed = false;
  let developerConnectionsOpen = false;
  let statusEl = null;

  function trimString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function renderMessage(text) {
    if (!listEl) return;
    listEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "composer-add-panel-empty";
    empty.textContent = text;
    listEl.appendChild(empty);
  }

  function canManage() {
    return typeof canManageConnectorSurfacesFromUi !== "function"
      || canManageConnectorSurfacesFromUi();
  }

  function surfaceTitle(surface) {
    return surface?.title || surface?.connectorId
      || (typeof t === "function" ? t("settings.connectors.untitled") : "Connector");
  }

  function isReady(surface) {
    return surface?.surface?.capabilityState === "ready";
  }

  function surfaceConnectorId(surface) {
    return trimString(surface?.connectorId).toLowerCase();
  }

  function isBuiltInStatusSurface(surface) {
    return ["calendar", "email", "mail", "gmail", "drive", "github"].includes(surfaceConnectorId(surface));
  }

  function setPanelStatus(message) {
    if (statusEl) statusEl.textContent = message || "";
  }

  function openSettings() {
    closePanel();
    if (typeof switchTab === "function") switchTab("settings");
    if (typeof openSidebar === "function") openSidebar();
  }

  // Mirrors settings-ui.js resolveConnectorSurfaceUrl: connector surfaces may
  // be product URLs that need resolution before they can be embedded.
  function resolveSurfaceUrl(entryUrl) {
    const normalized = typeof entryUrl === "string" ? entryUrl.trim() : "";
    if (!normalized) return "";
    if (typeof window.agentocResolveProductUrl === "function") {
      return window.agentocResolveProductUrl(normalized);
    }
    return new URL(normalized, window.location.origin).toString();
  }

  function openAuthorizeView(surface) {
    listEl.innerHTML = "";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "composer-add-panel-back";
    back.textContent = typeof t === "function" ? t("compose.connectorPanel.back") : "Back to connectors";
    back.addEventListener("click", () => {
      void refresh().then(renderList, renderList);
    });
    listEl.appendChild(back);

    const frameWrap = document.createElement("div");
    frameWrap.className = "composer-add-panel-frame-wrap";
    const frame = document.createElement("iframe");
    frame.className = "composer-add-panel-frame";
    frame.loading = "lazy";
    frame.src = resolveSurfaceUrl(surface.entryUrl);
    frame.title = surfaceTitle(surface);
    frameWrap.appendChild(frame);
    listEl.appendChild(frameWrap);

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "composer-add-panel-refresh";
    refreshBtn.textContent = typeof t === "function" ? t("compose.connectorPanel.refresh") : "Refresh status";
    refreshBtn.addEventListener("click", () => {
      void refresh().then(renderList, renderList);
    });
    listEl.appendChild(refreshBtn);
  }

  function i18n(key, fallback) {
    return typeof t === "function" ? t(key) : fallback;
  }

  function i18nWithVars(key, vars, fallback) {
    return typeof t === "function" ? t(key, vars) : fallback;
  }

  function codexTransportSummary(server) {
    const transport = server?.transport;
    if (!transport || typeof transport !== "object") return "";
    if (["http", "streamable_http", "sse"].includes(trimString(transport.type))) {
      return trimString(transport.url) || transport.type;
    }
    return [trimString(transport.command), ...(Array.isArray(transport.args) ? transport.args.map(String) : [])]
      .filter(Boolean)
      .join(" ");
  }

  function codexAuthBadge(server) {
    const capability = codexMcpCapabilities.find((item) => item?.title === server?.name);
    const status = trimString(capability?.state?.authorization) || "unknown";
    const badge = document.createElement("span");
    badge.className = "composer-add-panel-pill";
    if (status === "connected") badge.classList.add("is-ready");
    badge.textContent = status === "connected" ? i18n("compose.connectorPanel.codexAuthReady", "Authorized")
      : status === "authorization_required" ? i18n("compose.connectorPanel.codexAuthRequired", "Authorization required")
        : status === "credential_configured" ? i18n("compose.connectorPanel.codexCredentialConfigured", "Credential configured")
          : status === "unsupported" ? i18n("compose.connectorPanel.codexAuthUnsupported", "OAuth not supported")
          : i18n("compose.connectorPanel.codexAuthUnknown", "Authorization unknown");
    return badge;
  }

  async function fetchCodexMcpServers() {
    codexMcpLoadFailed = false;
    codexMcpErrorCode = "";
    const isCodex = typeof selectedTool === "undefined" || ["codex", "codex-cli", "agentoc-codex-app-server"].includes(selectedTool);
    codexMcpProvider = isCodex && typeof getComposerRuntimeSelectedProvider === "function"
      ? trimString(getComposerRuntimeSelectedProvider("codex")) : "";
    if (!codexMcpProvider) { codexMcpServers = []; return; }
    const requestedProvider = codexMcpProvider;
    const endpoint = `/api/providers/${encodeURIComponent(requestedProvider)}/codex/mcp-servers`;
    try {
      const data = typeof fetchJsonOrRedirect === "function"
        ? await fetchJsonOrRedirect(endpoint, { cacheMaxAgeMs: 0 })
        : await (window.agentocFetch || fetch)(endpoint).then((response) => { if (!response.ok) throw new Error("MCP list failed"); return response.json(); });
      if (codexMcpProvider === requestedProvider) codexMcpServers = Array.isArray(data?.servers) ? data.servers.filter((s) => s && typeof s === "object") : [];
    } catch (error) {
      if (codexMcpProvider === requestedProvider) {
        codexMcpLoadFailed = true; codexMcpErrorCode = trimString(error?.code); codexMcpServers = [];
      }
    }
  }

  async function fetchCodexCapabilities() {
    const session = typeof currentSessionId === "undefined" ? "" : trimString(currentSessionId);
    const provider = codexMcpProvider;
    codexCapabilities = [];
    codexMcpCapabilities = [];
    codexCapabilityError = false;
    codexPluginsUnavailable = false;
    if (!session || !provider) return;
    const query = new URLSearchParams({ tool: "codex", providerProfile: provider });
    const endpoint = `/api/sessions/${encodeURIComponent(session)}/harness-capabilities?${query}`;
    try {
      const data = typeof fetchJsonOrRedirect === "function"
        ? await fetchJsonOrRedirect(endpoint, { cacheMaxAgeMs: 0 })
        : await (window.agentocFetch || fetch)(endpoint).then((response) => { if (!response.ok) throw new Error("Capability list failed"); return response.json(); });
      if (session !== currentSessionId || provider !== codexMcpProvider || trimString(data?.providerProfileId) !== provider
        || (typeof getComposerRuntimeSelectedProvider === "function" && trimString(getComposerRuntimeSelectedProvider("codex")) !== provider)) return;
      codexCapabilities = (Array.isArray(data?.items) ? data.items : []).filter((item) => item?.source === "codex" && ["skill", "app"].includes(item?.kind));
      codexMcpCapabilities = (Array.isArray(data?.items) ? data.items : []).filter((item) => item?.source === "codex" && item?.kind === "mcp");
      codexCapabilityError = Boolean(data?.errors?.codex || data?.errors?.["codex.skills"] || data?.errors?.["codex.apps"] || data?.errors?.["codex.installedApps"]);
      codexPluginsUnavailable = Boolean(data?.errors?.["codex.plugins"]);
    } catch { if (session === currentSessionId && provider === codexMcpProvider) codexCapabilityError = true; }
  }

  async function fetchCodexPluginPreference() {
    const provider = codexMcpProvider;
    codexPluginPreference = null;
    if (!provider) return;
    try {
      const endpoint = `/api/providers/${encodeURIComponent(provider)}/codex/plugin-preference`;
      const data = typeof fetchJsonOrRedirect === "function" ? await fetchJsonOrRedirect(endpoint, { cacheMaxAgeMs: 0 })
        : await (window.agentocFetch || fetch)(endpoint).then((r) => { if (!r.ok) throw new Error("Plugin preference unavailable"); return r.json(); });
      if (provider === codexMcpProvider && (typeof getComposerRuntimeSelectedProvider !== "function"
        || trimString(getComposerRuntimeSelectedProvider("codex")) === provider) && typeof data?.desiredEnabled === "boolean") codexPluginPreference = data.desiredEnabled;
    } catch { /* Older hosts and unsupported accounts do not offer this control. */ }
  }

  async function fetchCodexSyncState(refreshNow = false) {
    const provider = codexMcpProvider;
    const generation = ++codexSyncGeneration;
    if (!provider) { codexSyncState = null; return; }
    try {
      const endpoint = `/api/providers/${encodeURIComponent(provider)}/codex/capability-sync`;
      const options = refreshNow ? { method: "POST" } : { cacheMaxAgeMs: 0 };
      const data = typeof fetchJsonOrRedirect === "function" ? await fetchJsonOrRedirect(endpoint, options)
        : await (window.agentocFetch || fetch)(endpoint, options).then((r) => { if (!r.ok) throw new Error("Sync unavailable"); return r.json(); });
      if (generation === codexSyncGeneration && provider === codexMcpProvider && (typeof getComposerRuntimeSelectedProvider !== "function"
        || trimString(getComposerRuntimeSelectedProvider("codex")) === provider)) {
        codexSyncState = data?.sync || null;
        codexSyncMode = ["approved-auto", "manual", "disabled"].includes(data?.mode) ? data.mode : "";
      }
    } catch { if (generation === codexSyncGeneration && provider === codexMcpProvider) codexSyncState = refreshNow ? { status: "partial" } : null; }
  }

  async function setCodexSyncMode(mode) {
    const provider = codexMcpProvider;
    if (!provider || !["approved-auto", "manual", "disabled"].includes(mode)
      || (typeof getComposerRuntimeSelectedProvider === "function" && trimString(getComposerRuntimeSelectedProvider("codex")) !== provider)) return;
    const generation = ++codexSyncGeneration;
    const endpoint = `/api/providers/${encodeURIComponent(provider)}/codex/capability-sync-policy`;
    const options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) };
    try {
      if (typeof fetchJsonOrRedirect === "function") await fetchJsonOrRedirect(endpoint, options);
      else { const r = await (window.agentocFetch || fetch)(endpoint, options); if (!r.ok) throw new Error("Sync policy failed"); }
      if (generation !== codexSyncGeneration || provider !== codexMcpProvider || (typeof getComposerRuntimeSelectedProvider === "function"
        && trimString(getComposerRuntimeSelectedProvider("codex")) !== provider)) return;
      codexSyncMode = mode;
      if (mode === "disabled") codexSyncState = null;
      setPanelStatus(i18n("compose.connectorPanel.codexSyncPolicySaved", "Synchronization policy saved."));
      renderList();
    } catch { if (generation === codexSyncGeneration) { setPanelStatus(i18n("compose.connectorPanel.codexSyncPolicyFailed", "Could not save synchronization policy.")); renderList(); } }
  }

  async function setCodexPluginPreference(enabled) {
    const provider = codexMcpProvider;
    if (!provider || (typeof getComposerRuntimeSelectedProvider === "function" && trimString(getComposerRuntimeSelectedProvider("codex")) !== provider)) return;
    const endpoint = `/api/providers/${encodeURIComponent(provider)}/codex/plugin-preference`;
    const options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) };
    try {
      const result = typeof fetchJsonOrRedirect === "function" ? await fetchJsonOrRedirect(endpoint, options)
        : await (window.agentocFetch || fetch)(endpoint, options).then((r) => { if (!r.ok) throw new Error("Plugin setting failed"); return r.json(); });
      if (provider !== codexMcpProvider || (typeof getComposerRuntimeSelectedProvider === "function"
        && trimString(getComposerRuntimeSelectedProvider("codex")) !== provider)) return;
      codexPluginPreference = enabled;
      setPanelStatus(result?.restartStatus === "deferred"
        ? i18n("compose.connectorPanel.codexPluginDeferred", "Saved. The runtime could not be restarted safely; retry when it is idle.")
        : i18n("compose.connectorPanel.codexPluginSaved", "Plugin setting saved. It applies after the Codex runtime next restarts."));
      renderList();
    } catch { setPanelStatus(i18n("compose.connectorPanel.codexPluginFailed", "Could not save the Plugin setting.")); }
  }

  async function setCodexSkillEnabled(item, enabled) {
    const session = typeof currentSessionId === "undefined" ? "" : trimString(currentSessionId);
    const provider = codexMcpProvider;
    if (!session || !provider || (typeof getComposerRuntimeSelectedProvider === "function"
      && trimString(getComposerRuntimeSelectedProvider("codex")) !== provider)) return;
    const endpoint = `/api/sessions/${encodeURIComponent(session)}/harness-capabilities/skills`;
    const options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerProfileId: provider, id: item.id, enabled }) };
    try {
      if (typeof fetchJsonOrRedirect === "function") await fetchJsonOrRedirect(endpoint, options);
      else {
        const response = await (window.agentocFetch || fetch)(endpoint, options);
        if (!response.ok) throw new Error("Skill update failed");
      }
      if (session !== currentSessionId || provider !== codexMcpProvider) return;
      item.state = { ...(item.state || {}), desiredConfiguration: enabled ? "enabled" : "disabled" };
      setPanelStatus(i18n("compose.connectorPanel.codexSkillSaved", "Skill setting saved. It applies when the next Codex task prepares its runtime."));
      renderList();
    } catch { setPanelStatus(i18n("compose.connectorPanel.codexSkillFailed", "Skill setting could not be saved. Start a Codex task for this account and refresh.")); }
  }

  function renderCodexCapabilities() {
    if (!codexMcpProvider || (typeof currentSessionId === "undefined" || !currentSessionId)) return;
    const title = document.createElement("div");
    title.className = "composer-add-panel-group-title";
    title.textContent = i18n("compose.connectorPanel.codexCapabilities", "Codex apps and skills");
    listEl.appendChild(title);
    for (const item of codexCapabilities) {
      const row = document.createElement("div");
      row.className = "composer-add-panel-row composer-add-panel-row--capability is-static";
      const label = document.createElement("span");
      label.className = "composer-add-panel-row-label";
      label.textContent = trimString(item.title);
      const detail = document.createElement("span");
      detail.className = "composer-add-panel-row-detail";
      const kind = item.kind === "app" ? i18n("compose.connectorPanel.codexApp", "App") : i18n("compose.connectorPanel.codexSkill", "Skill");
      const status = item.kind === "app"
        ? (item.state?.runtime === "callable" ? i18n("compose.connectorPanel.codexCallable", "Callable") : i18n("compose.connectorPanel.codexNotConfirmed", "Availability not confirmed"))
        : (item.enabled ? i18n("compose.connectorPanel.codexEnabled", "Enabled") : i18n("compose.connectorPanel.codexDisabled", "Disabled"));
      const desired = item.state?.desiredConfiguration;
      const pending = item.kind === "skill" && ["enabled", "disabled"].includes(desired) && (desired === "enabled") !== (item.enabled === true);
      detail.textContent = `${kind} · ${status}${pending ? ` · ${i18n("compose.connectorPanel.codexSkillPending", "Change pending")}` : ""}`;
      row.append(label, detail);
      if (item.kind === "skill" && item.state?.manageable === true) {
        const effectiveChoice = ["enabled", "disabled"].includes(desired) ? desired === "enabled" : item.enabled === true;
        const button = document.createElement("button");
        button.type = "button"; button.className = "composer-add-panel-action";
        button.textContent = effectiveChoice ? i18n("compose.connectorPanel.codexSkillDisable", "Disable") : i18n("compose.connectorPanel.codexSkillEnable", "Enable");
        button.addEventListener("click", () => { button.disabled = true; void setCodexSkillEnabled(item, !effectiveChoice).finally(() => { button.disabled = false; }); });
        row.appendChild(button);
      }
      listEl.appendChild(row);
    }
    if (codexCapabilityError || !codexCapabilities.length) {
      const message = document.createElement("div");
      message.className = "composer-add-panel-empty";
      message.textContent = codexCapabilityError
        ? i18n("compose.connectorPanel.codexCapabilitiesUnavailable", "Some Codex capabilities could not be loaded. Start a task with this account and refresh.")
        : i18n("compose.connectorPanel.codexCapabilitiesEmpty", "No apps or skills discovered for this account.");
      listEl.appendChild(message);
    }
    if (codexPluginsUnavailable) {
      const notice = document.createElement("div");
      notice.className = "composer-add-panel-empty";
      notice.textContent = i18n("compose.connectorPanel.codexPluginsUnavailable", "Native Plugin management is not available in this integration yet.");
      listEl.appendChild(notice);
    }
    if (typeof codexPluginPreference === "boolean") {
      const row = document.createElement("div"); row.className = "composer-add-panel-row composer-add-panel-row--capability is-static";
      const label = document.createElement("span"); label.className = "composer-add-panel-row-label";
      label.textContent = i18n("compose.connectorPanel.codexPluginLoading", "Native Plugin loading");
      const detail = document.createElement("span"); detail.className = "composer-add-panel-row-detail";
      detail.textContent = codexPluginPreference ? i18n("compose.connectorPanel.codexPluginWantedOn", "Requested on · runtime restart required")
        : i18n("compose.connectorPanel.codexPluginWantedOff", "Requested off · runtime restart may be required");
      const button = document.createElement("button"); button.type = "button"; button.className = "composer-add-panel-action";
      button.textContent = codexPluginPreference ? i18n("compose.connectorPanel.codexSkillDisable", "Disable") : i18n("compose.connectorPanel.codexSkillEnable", "Enable");
      button.addEventListener("click", () => { button.disabled = true; void setCodexPluginPreference(!codexPluginPreference).finally(() => { button.disabled = false; }); });
      const retry = document.createElement("button"); retry.type = "button"; retry.className = "composer-add-panel-action";
      retry.textContent = i18n("compose.connectorPanel.codexPluginApply", "Apply when idle");
      retry.addEventListener("click", () => { retry.disabled = true; void setCodexPluginPreference(codexPluginPreference).finally(() => { retry.disabled = false; }); });
      row.append(label, detail, button, retry); listEl.appendChild(row);
    }
    if (typeof codexPluginPreference === "boolean") {
      const row = document.createElement("div"); row.className = "composer-add-panel-row composer-add-panel-row--capability is-static";
      const label = document.createElement("span"); label.className = "composer-add-panel-row-label";
      label.textContent = i18n("compose.connectorPanel.codexSync", "Codex capability discovery");
      const detail = document.createElement("span"); detail.className = "composer-add-panel-row-detail";
      detail.textContent = codexSyncMode === "disabled" ? i18n("compose.connectorPanel.codexSyncDisabled", "Synchronization disabled")
        : codexSyncState?.status === "discovered"
        ? i18n("compose.connectorPanel.codexSyncDiscovered", "Discovered · authorization and tool access checked separately")
        : codexSyncState?.status === "waiting_for_runtime"
          ? i18n("compose.connectorPanel.codexSyncWaiting", "Waiting for a Codex task to start the runtime")
          : codexSyncState?.status === "partial" ? i18n("compose.connectorPanel.codexSyncPartial", "Some capability status is unknown")
            : i18n("compose.connectorPanel.codexSyncUnchecked", "Not checked yet");
      const button = document.createElement("button"); button.type = "button"; button.className = "composer-add-panel-action";
      button.textContent = i18n("compose.connectorPanel.refresh", "Refresh status");
      button.disabled = codexSyncMode === "disabled";
      button.addEventListener("click", () => { button.disabled = true; void fetchCodexSyncState(true).then(renderList).finally(() => { button.disabled = false; }); });
      row.append(label, detail, button);
      if (codexSyncMode) {
        const select = document.createElement("select"); select.className = "composer-add-panel-codex-input";
        select.setAttribute("aria-label", i18n("compose.connectorPanel.codexSyncPolicy", "Synchronization policy"));
        for (const [value, title] of [["approved-auto", i18n("compose.connectorPanel.codexSyncAuto", "Automatic discovery")],
          ["manual", i18n("compose.connectorPanel.codexSyncManual", "Manual")], ["disabled", i18n("compose.connectorPanel.codexSyncOff", "Disabled")]]) {
          const option = document.createElement("option"); option.value = value; option.textContent = title; select.appendChild(option);
        }
        select.value = codexSyncMode;
        select.addEventListener("change", () => { select.disabled = true; void setCodexSyncMode(select.value).finally(() => { select.disabled = false; }); });
        row.appendChild(select);
      }
      listEl.appendChild(row);
    }
  }

  async function removeCodexServer(serverName) {
    if (!serverName || !codexMcpProvider) return;
    if (typeof getComposerRuntimeSelectedProvider === "function"
      && trimString(getComposerRuntimeSelectedProvider("codex")) !== codexMcpProvider) {
      await fetchCodexMcpServers(); renderList(); return;
    }
    codexRemoveCandidate = "";
    const endpoint = `/api/providers/${encodeURIComponent(codexMcpProvider)}/codex/mcp-servers/${encodeURIComponent(serverName)}`;
    try {
      if (typeof fetchJsonOrRedirect === "function") {
        await fetchJsonOrRedirect(endpoint, { method: "DELETE" });
      } else {
        await (window.agentocFetch || fetch)(endpoint, { method: "DELETE" });
      }
    } catch {
      // Keep the list as-is on failure; the row stays removable.
    }
    await fetchCodexMcpServers();
    renderList();
  }

  async function startCodexMcpAuthorization(serverName) {
    const provider = codexMcpProvider;
    if (!provider || !serverName || (typeof getComposerRuntimeSelectedProvider === "function"
      && trimString(getComposerRuntimeSelectedProvider("codex")) !== provider)) return;
    const runtime = window.AgentoCTargetRuntime;
    const activeTarget = runtime?.getActiveTarget?.();
    const localTargetId = runtime?.getLocalTargetId?.();
    const localBrowser = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname)
      && (!activeTarget || !localTargetId || activeTarget.targetId === localTargetId);
    const popup = localBrowser ? window.open("about:blank", "_blank") : null;
    if (popup) { try { popup.opener = null; } catch {} }
    const endpoint = `/api/providers/${encodeURIComponent(provider)}/codex/mcp-servers/${encodeURIComponent(serverName)}/oauth`;
    const fetchData = async (url, options = {}) => {
      if (typeof fetchJsonOrRedirect === "function") return fetchJsonOrRedirect(url, options);
      const response = await (window.agentocFetch || fetch)(url, options);
      if (!response.ok) throw new Error("Authorization failed");
      return response.json();
    };
    try {
      const job = await fetchData(endpoint, { method: "POST" });
      if (!job?.id || !job?.authorizationUrl) throw new Error("Invalid authorization response");
      const destination = new URL(job.authorizationUrl);
      if (!["http:", "https:"].includes(destination.protocol)) throw new Error("Invalid authorization URL");
      if (popup) popup.location.href = destination.toString();
      setPanelStatus(i18n("compose.connectorPanel.codexAuthStarted", "Complete authorization in a browser on the Ragent host. Then return here to check the connection."));
      let cancelled = false;
      if (statusEl) {
        const link = document.createElement("a");
        link.href = destination.toString(); link.target = "_blank"; link.rel = "noopener noreferrer";
        link.textContent = i18n("compose.connectorPanel.codexAuthLink", "Open authorization link");
        statusEl.append(" ", link);
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = i18n("compose.connectorPanel.codexAuthStop", "Stop tracking");
        cancel.addEventListener("click", async () => {
          try {
            const state = await fetchData(`${endpoint}/${encodeURIComponent(job.id)}`, { method: "DELETE" });
            cancelled = state?.state === "abandoned";
            setPanelStatus(cancelled
              ? i18n("compose.connectorPanel.codexAuthCancelled", "Stopped tracking. Do not use the authorization link; Codex may keep the request active until it expires.")
              : i18n("compose.connectorPanel.codexAuthUnverified", "Authorization completed; checking the connection."));
          } catch { setPanelStatus(i18n("compose.connectorPanel.codexAuthFailed", "MCP authorization did not complete. Try again.")); }
        });
        statusEl.append(" ", cancel);
      }
      let attempts = 0;
      const poll = async () => {
        if (cancelled || codexMcpProvider !== provider || attempts++ >= 200) return;
        try {
          const state = await fetchData(`${endpoint}/${encodeURIComponent(job.id)}`, { cacheMaxAgeMs: 0 });
          if (cancelled) return;
          if (state.state === "connected") {
            setPanelStatus(i18n("compose.connectorPanel.codexAuthConnected", "MCP authorization is connected."));
            await fetchCodexMcpServers(); await fetchCodexCapabilities(); renderList(); return;
          }
          if (["failed", "expired", "abandoned"].includes(state.state)) {
            setPanelStatus(i18n("compose.connectorPanel.codexAuthFailed", "MCP authorization did not complete. Try again.")); return;
          }
          if (state.state === "completed_unverified") setPanelStatus(i18n("compose.connectorPanel.codexAuthUnverified", "Authorization completed; checking the connection."));
          window.setTimeout(poll, 3000);
        } catch { setPanelStatus(i18n("compose.connectorPanel.codexAuthFailed", "MCP authorization did not complete. Try again.")); }
      };
      window.setTimeout(poll, 3000);
    } catch {
      try { popup?.close(); } catch {}
      setPanelStatus(i18n("compose.connectorPanel.codexAuthStartFailed", "Could not start authorization. Start a Codex task for this account and try again."));
    }
  }

  async function submitCodexServer(nameInput, commandInput, argsInput, errorEl) {
    const name = trimString(nameInput.value);
    const command = trimString(commandInput.value);
    if (!name || !command || !codexMcpProvider) {
      errorEl.textContent = i18n("compose.connectorPanel.codexFormError", "Name and command/URL are required.");
      return;
    }
    if (typeof getComposerRuntimeSelectedProvider === "function"
      && trimString(getComposerRuntimeSelectedProvider("codex")) !== codexMcpProvider) {
      errorEl.textContent = i18n("compose.connectorPanel.codexAccountChanged", "The Codex account changed. Refresh this panel.");
      return;
    }
    errorEl.textContent = "";
    let args = [];
    try {
      args = argsInput.value.trim() ? JSON.parse(argsInput.value) : [];
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Invalid arguments");
    } catch { errorEl.textContent = i18n("compose.connectorPanel.codexArgsError", "Arguments must be a JSON array of strings."); return; }
    if (/^https?:\/\//i.test(command) && args.length) {
      errorEl.textContent = i18n("compose.connectorPanel.codexUrlArgsError", "Arguments are only supported for commands."); return;
    }
    const payload = /^https?:\/\//i.test(command)
      ? { name, url: command }
      : { name, command, args };
    const endpoint = `/api/providers/${encodeURIComponent(codexMcpProvider)}/codex/mcp-servers`;
    try {
      const response = typeof fetchJsonOrRedirect === "function"
        ? await fetchJsonOrRedirect(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await (window.agentocFetch || fetch)(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!response?.ok && response?.status && response.status >= 400) {
        let message = "";
        try {
          const body = await response.json();
          message = trimString(body?.error) || "";
        } catch { /* ignore */ }
        errorEl.textContent = message || i18n("compose.connectorPanel.codexAddFailed", "Failed to add server.");
        return;
      }
    } catch {
      errorEl.textContent = i18n("compose.connectorPanel.codexAddFailed", "Failed to add server.");
      return;
    }
    codexFormOpen = false;
    await fetchCodexMcpServers();
    renderList();
  }

  function buildCodexForm() {
    const form = document.createElement("form");
    form.className = "composer-add-panel-codex-form";
    form.autocomplete = "off";
    form.noValidate = true;
    const errorId = "composer-add-panel-codex-error";

    const nameField = document.createElement("label");
    nameField.className = "composer-add-panel-field";
    const nameLabel = document.createElement("span");
    nameLabel.className = "composer-add-panel-field-label";
    nameLabel.textContent = i18n("compose.connectorPanel.codexAddName", "Server name");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.name = "name";
    nameInput.required = true;
    nameInput.autocomplete = "off";
    nameInput.spellcheck = false;
    nameInput.className = "composer-add-panel-codex-input";
    nameInput.placeholder = i18n("compose.connectorPanel.codexAddName", "Name (e.g. github)");
    nameInput.setAttribute("aria-label", i18n("compose.connectorPanel.codexAddName", "Name"));
    nameInput.setAttribute("aria-describedby", errorId);
    nameField.append(nameLabel, nameInput);

    const commandField = document.createElement("label");
    commandField.className = "composer-add-panel-field";
    const commandLabel = document.createElement("span");
    commandLabel.className = "composer-add-panel-field-label";
    commandLabel.textContent = i18n("compose.connectorPanel.codexAddCommand", "Command or URL");
    const commandInput = document.createElement("input");
    commandInput.type = "text";
    commandInput.name = "command";
    commandInput.required = true;
    commandInput.autocomplete = "off";
    commandInput.spellcheck = false;
    commandInput.className = "composer-add-panel-codex-input";
    commandInput.placeholder = i18n("compose.connectorPanel.codexAddCommand", "Command or https:// URL");
    commandInput.setAttribute("aria-label", i18n("compose.connectorPanel.codexAddCommand", "Command or URL"));
    commandInput.setAttribute("aria-describedby", errorId);
    commandField.append(commandLabel, commandInput);

    const argsField = document.createElement("label");
    argsField.className = "composer-add-panel-field";
    const argsLabel = document.createElement("span");
    argsLabel.className = "composer-add-panel-field-label";
    argsLabel.textContent = i18n("compose.connectorPanel.codexArgs", "Arguments (JSON array, optional)");
    const argsInput = document.createElement("input");
    argsInput.type = "text";
    argsInput.name = "args";
    argsInput.className = "composer-add-panel-codex-input";
    argsInput.placeholder = '["-y", "package-name"]';
    argsField.append(argsLabel, argsInput);

    const errorEl = document.createElement("div");
    errorEl.className = "composer-add-panel-codex-error";
    errorEl.id = errorId;
    errorEl.setAttribute("role", "alert");

    const actions = document.createElement("div");
    actions.className = "composer-add-panel-form-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "composer-add-panel-refresh composer-add-panel-form-submit";
    submit.textContent = i18n("compose.connectorPanel.codexAddSubmit", "Add");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "composer-add-panel-form-cancel";
    cancel.textContent = i18n("action.cancel", "Cancel");
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      codexFormOpen = false;
      renderList();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitCodexServer(nameInput, commandInput, argsInput, errorEl);
    });
    actions.append(cancel, submit);
    form.append(nameField, commandField, argsField, errorEl, actions);
    return form;
  }

  function renderCodexSection() {
    const title = document.createElement("div");
    title.className = "composer-add-panel-group-title";
    title.textContent = i18n("compose.connectorPanel.codexTitle", "Codex MCP servers");
    listEl.appendChild(title);

    if (!codexMcpProvider) {
      const hint = document.createElement("div");
      hint.className = "composer-add-panel-empty";
      hint.textContent = i18n("compose.connectorPanel.codexSelectAccount", "Select a Codex account for this session to manage its MCP servers.");
      listEl.appendChild(hint);
      return;
    }
    const scope = document.createElement("div");
    scope.className = "composer-add-panel-row-detail";
    scope.textContent = i18nWithVars("compose.connectorPanel.codexScope", { provider: codexMcpProvider }, `Codex account: ${codexMcpProvider} · Changes apply when the runtime refreshes.`);
    listEl.appendChild(scope);

    if (codexMcpLoadFailed) {
      const failed = document.createElement("div");
      failed.className = "composer-add-panel-empty";
      failed.textContent = codexMcpErrorCode === "CODEX_MCP_ACCOUNT_CHANGED"
        ? i18n("compose.connectorPanel.codexAccountIsolation", "This profile was previously used with another account. Its MCP configuration is isolated and cannot be used by this account.")
        : codexMcpErrorCode === "CODEX_MCP_ACCOUNT_UNVERIFIED"
          ? i18n("compose.connectorPanel.codexAccountUnverified", "The current Codex account could not be verified.")
          : i18n("compose.connectorPanel.codexLoadFailed", "Failed to load Codex MCP servers.");
      listEl.appendChild(failed);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "composer-add-panel-refresh";
      retry.textContent = i18n("compose.connectorPanel.refresh", "Refresh status");
      retry.addEventListener("click", () => {
        void refresh().then(renderList, renderList);
      });
      listEl.appendChild(retry);
      return;
    }

    for (const server of codexMcpServers) {
      const row = document.createElement("div");
      row.className = "composer-add-panel-row composer-add-panel-row--codex is-static";
      const label = document.createElement("span");
      label.className = "composer-add-panel-row-label";
      label.textContent = trimString(server?.name) || server?.name || "?";
      row.appendChild(label);
      const summary = codexTransportSummary(server);
      if (summary) {
        const detail = document.createElement("span");
        detail.className = "composer-add-panel-row-detail";
        detail.textContent = summary;
        detail.title = summary;
        row.appendChild(detail);
      }
      const badge = codexAuthBadge(server);
      if (badge) row.appendChild(badge);
      if (["http", "streamable_http", "sse"].includes(trimString(server?.transport?.type))) {
        const connectBtn = document.createElement("button");
        connectBtn.type = "button";
        connectBtn.className = "composer-add-panel-action";
        connectBtn.textContent = i18n("compose.connectorPanel.codexConnect", "Connect");
        connectBtn.addEventListener("click", (event) => { event.stopPropagation(); void startCodexMcpAuthorization(trimString(server?.name)); });
        row.appendChild(connectBtn);
      }
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      const serverName = trimString(server?.name) || server?.name || "";
      const confirming = codexRemoveCandidate === serverName;
      removeBtn.className = "composer-add-panel-row-remove" + (confirming ? " is-confirming" : "");
      removeBtn.textContent = confirming
        ? `${i18n("compose.connectorPanel.codexRemove", "Remove")}?`
        : i18n("compose.connectorPanel.codexRemove", "Remove");
      removeBtn.setAttribute("aria-label", `${removeBtn.textContent} ${serverName}`);
      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (confirming) {
          void removeCodexServer(serverName);
          return;
        }
        codexRemoveCandidate = serverName;
        renderList();
        window.setTimeout(() => {
          if (codexRemoveCandidate === serverName) {
            codexRemoveCandidate = "";
            renderList();
          }
        }, 4000);
      });
      row.appendChild(removeBtn);
      listEl.appendChild(row);
    }

    if (codexMcpServers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "composer-add-panel-empty";
      empty.textContent = i18n("compose.connectorPanel.codexNone", "No Codex MCP servers configured yet.");
      listEl.appendChild(empty);
    }

    if (codexFormOpen) {
      listEl.appendChild(buildCodexForm());
    } else {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "composer-add-panel-add";
      addBtn.textContent = i18n("compose.connectorPanel.codexAdd", "Add server");
      addBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        codexFormOpen = true;
        renderList();
        listEl.querySelector(".composer-add-panel-codex-input")?.focus({ preventScroll: true });
      });
      listEl.appendChild(addBtn);
    }
  }

  function claudeTransportSummary(server) {
    const type = trimString(server?.type);
    if (type === "http" || type === "sse") {
      return `${trimString(server?.url) || type} (${type.toUpperCase()})`;
    }
    return [trimString(server?.command), ...(Array.isArray(server?.args) ? server.args.map(String) : [])]
      .filter(Boolean)
      .join(" ");
  }

  async function fetchClaudeMcpServers() {
    claudeMcpLoadFailed = false;
    try {
      const data = typeof fetchJsonOrRedirect === "function"
        ? await fetchJsonOrRedirect("/api/claude/mcp-servers", { cacheMaxAgeMs: 10_000 })
        : await (window.agentocFetch || fetch)("/api/claude/mcp-servers").then((response) => response.json());
      claudeMcpServers = Array.isArray(data?.servers) ? data.servers.filter((s) => s && typeof s === "object") : [];
    } catch {
      claudeMcpLoadFailed = true;
      claudeMcpServers = [];
    }
  }

  async function fetchCalendarStatus() {
    calendarLoadFailed = false;
    calendarFeed = null;
    calendarGoogleStatus = null;
    const read = (url) => typeof fetchJsonOrRedirect === "function"
      ? fetchJsonOrRedirect(url, { cacheMaxAgeMs: 10_000 })
      : (window.agentocFetch || fetch)(url).then((response) => response.json());
    const [feedResult, googleResult, ownerResult] = await Promise.all([
      read("/api/connectors/calendar/feed")
        .then((data) => ({ ok: true, data }))
        .catch(() => ({ ok: false, data: null })),
      read("/api/connectors/calendar/google/status")
        .then((data) => ({ ok: true, data }))
        .catch(() => ({ ok: false, data: null })),
      read("/api/auth/google/status")
        .then((data) => ({ ok: true, data }))
        .catch(() => ({ ok: false, data: null })),
    ]);
    calendarFeed = feedResult.data && typeof feedResult.data === "object" ? feedResult.data : null;
    calendarGoogleStatus = googleResult.data && typeof googleResult.data === "object" ? googleResult.data : null;
    googleOwnerStatus = ownerResult.data && typeof ownerResult.data === "object" ? ownerResult.data : null;
    calendarLoadFailed = !feedResult.ok || !googleResult.ok;
  }

  async function fetchGmailStatus() {
    gmailLoadFailed = false;
    try {
      const data = typeof fetchJsonOrRedirect === "function"
        ? await fetchJsonOrRedirect("/api/connectors/gmail/status", { cacheMaxAgeMs: 10_000 })
        : await (window.agentocFetch || fetch)("/api/connectors/gmail/status").then((response) => response.json());
      gmailStatus = data && typeof data === "object" ? data : null;
    } catch {
      gmailLoadFailed = true;
      gmailStatus = null;
    }
  }

  async function fetchDriveStatus() {
    driveLoadFailed = false;
    try {
      const data = typeof fetchJsonOrRedirect === "function"
        ? await fetchJsonOrRedirect("/api/connectors/drive/status", { cacheMaxAgeMs: 10_000 })
        : await (window.agentocFetch || fetch)("/api/connectors/drive/status").then((response) => response.json());
      driveStatus = data && typeof data === "object" ? data : null;
    } catch {
      driveLoadFailed = true;
      driveStatus = null;
    }
  }

  async function fetchGitHubStatus() {
    githubLoadFailed = false;
    try {
      const data = typeof fetchJsonOrRedirect === "function"
        ? await fetchJsonOrRedirect("/api/connectors/github/status", { cacheMaxAgeMs: 10_000 })
        : await (window.agentocFetch || fetch)("/api/connectors/github/status").then((response) => response.json());
      githubStatus = data && typeof data === "object" ? data : null;
    } catch {
      githubLoadFailed = true;
      githubStatus = null;
    }
  }

  async function fetchMailStatus() {
    mailLoadFailed = false;
    try {
      const data = typeof fetchJsonOrRedirect === "function"
        ? await fetchJsonOrRedirect("/api/connectors/mail/status", { cacheMaxAgeMs: 10_000 })
        : await (window.agentocFetch || fetch)("/api/connectors/mail/status").then((response) => response.json());
      mailStatus = data && typeof data === "object" ? data : null;
    } catch {
      mailLoadFailed = true;
      mailStatus = null;
    }
  }

  async function startCalendarAuthorization(button) {
    const original = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    let authUrl = "";
    let errorMessage = "";
    try {
      const response = typeof fetchJsonOrRedirect === "function"
        ? await fetchJsonOrRedirect("/api/connectors/calendar/google/authorize", { method: "POST" })
        : await (window.agentocFetch || fetch)("/api/connectors/calendar/google/authorize", { method: "POST" });
      let data = null;
      if (typeof response?.json === "function") {
        data = await response.json().catch(() => null);
      } else {
        // fetchJsonOrRedirect resolves to the parsed JSON body directly and
        // throws (with data.error as the message) on non-2xx responses.
        data = response;
      }
      authUrl = trimString(data?.authUrl);
      if (!authUrl) errorMessage = trimString(data?.error);
    } catch (error) {
      errorMessage = trimString(error?.message) || "";
    }
    if (authUrl) {
      window.open(authUrl, "_blank", "noopener");
      setPanelStatus(i18n("compose.connectorPanel.calendarAuthOpened", "Google Calendar authorization opened."));
    } else if (button) {
      const message = errorMessage || i18n("compose.connectorPanel.calendarAuthorizeFailed", "Authorization could not be started.");
      button.textContent = message;
      setPanelStatus(message);
    }
    if (button) {
      window.setTimeout(() => {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.textContent = original;
      }, 2000);
    }
  }

  // 把当前 Google 账号绑定为跨设备 owner 登录凭据（仅 owner 会话可发起）
  async function startGoogleOwnerBind(button) {
    const original = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    try {
      const bindPath = typeof window.agentocResolveProductPath === "function"
        ? window.agentocResolveProductPath("/api/auth/google/bind/redirect")
        : "/api/auth/google/bind/redirect";
      const bindUrl = new URL(bindPath, window.location.href);
      window.open(bindUrl.toString(), "_blank", "noopener");
      setPanelStatus(i18n(
        "compose.connectorPanel.googleOwnerBindOpened",
        "Google sign-in binding opened. Finish it in the new tab.",
      ));
    } catch (error) {
      const message = trimString(error?.message) || i18n(
        "compose.connectorPanel.googleOwnerBindFailed",
        "Google sign-in binding could not be started.",
      );
      if (button) button.textContent = message;
      setPanelStatus(message);
    }
    if (button) {
      window.setTimeout(() => {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.textContent = original;
      }, 2000);
    }
  }

  function copyCalendarSubscriptionUrl(button, url) {
    if (!url) return;
    const done = () => {
      button.textContent = i18n("compose.connectorPanel.calendarCopyDone", "Copied");
      setPanelStatus(i18n("compose.connectorPanel.calendarCopyStatus", "Calendar subscription link copied."));
      window.setTimeout(() => {
        button.textContent = i18n("compose.connectorPanel.calendarCopyUrl", "Copy subscribe link");
      }, 1600);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(url).then(done, () => {});
      return;
    }
    const input = document.createElement("input");
    input.value = url;
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand("copy");
      done();
    } catch { /* ignore */ }
    input.remove();
  }

  function appendLoadFailedRow(titleKey, titleFallback, messageKey, messageFallback) {
    const title = document.createElement("div");
    title.className = "composer-add-panel-group-title";
    title.textContent = i18n(titleKey, titleFallback);
    listEl.appendChild(title);
    const failed = document.createElement("div");
    failed.className = "composer-add-panel-empty";
    failed.textContent = i18n(messageKey, messageFallback);
    listEl.appendChild(failed);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "composer-add-panel-refresh";
    retry.textContent = i18n("compose.connectorPanel.refresh", "Refresh status");
    retry.addEventListener("click", () => {
      void refresh().then(renderList, renderList);
    });
    listEl.appendChild(retry);
  }

  // Connector rows use one stable Material list-item shape: a readable title
  // and supporting line on the left, with state or the one relevant action on
  // the right. Keeping this topology in one helper prevents each connector
  // from inventing its own hierarchy.
  function appendConnectorListRow({
    title,
    detail = "",
    status = "",
    ready = false,
    action = null,
    className = "",
  }) {
    const row = document.createElement("div");
    row.className = `composer-add-panel-row composer-connector-list-item is-static${className ? ` ${className}` : ""}`;

    const copy = document.createElement("div");
    copy.className = "composer-connector-row-copy";
    const label = document.createElement("span");
    label.className = "composer-add-panel-row-label";
    label.textContent = title;
    copy.appendChild(label);
    if (detail) {
      const supporting = document.createElement("span");
      supporting.className = "composer-add-panel-row-detail";
      supporting.textContent = detail;
      supporting.title = detail;
      copy.appendChild(supporting);
    }
    row.appendChild(copy);

    const trailing = document.createElement("div");
    trailing.className = "composer-connector-row-trailing";
    if (status && (!action || action.keepStatus)) {
      const pill = document.createElement("span");
      pill.className = `composer-add-panel-pill${ready ? " is-ready" : ""}`;
      pill.textContent = status;
      trailing.appendChild(pill);
    }
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `composer-add-panel-action${action.primary ? " composer-add-panel-action--primary" : " composer-add-panel-action--text"}`;
      button.textContent = action.label;
      if (action.ariaLabel) button.setAttribute("aria-label", action.ariaLabel);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        action.onClick(button, event);
      });
      trailing.appendChild(button);
    }
    row.appendChild(trailing);
    listEl.appendChild(row);
    return row;
  }

  async function removeClaudeServer(serverName) {
    if (!serverName) return;
    claudeRemoveCandidate = "";
    try {
      if (typeof fetchJsonOrRedirect === "function") {
        await fetchJsonOrRedirect(`/api/claude/mcp-servers/${encodeURIComponent(serverName)}`, { method: "DELETE" });
      } else {
        await (window.agentocFetch || fetch)(`/api/claude/mcp-servers/${encodeURIComponent(serverName)}`, { method: "DELETE" });
      }
    } catch {
      // Keep the list as-is on failure; the row stays removable.
    }
    await fetchClaudeMcpServers();
    renderList();
  }

  async function submitClaudeServer(nameInput, commandInput, errorEl) {
    const name = trimString(nameInput.value);
    const command = trimString(commandInput.value);
    if (!name || !command) {
      errorEl.textContent = i18n("compose.connectorPanel.claudeFormError", "Name and command/URL are required.");
      return;
    }
    errorEl.textContent = "";
    const payload = /^https?:\/\//i.test(command)
      ? { name, url: command }
      : { name, command };
    try {
      const response = typeof fetchJsonOrRedirect === "function"
        ? await fetchJsonOrRedirect("/api/claude/mcp-servers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await (window.agentocFetch || fetch)("/api/claude/mcp-servers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!response?.ok && response?.status && response.status >= 400) {
        let message = "";
        try {
          const body = await response.json();
          message = trimString(body?.error) || "";
        } catch { /* ignore */ }
        errorEl.textContent = message || i18n("compose.connectorPanel.claudeAddFailed", "Failed to add server.");
        return;
      }
    } catch {
      errorEl.textContent = i18n("compose.connectorPanel.claudeAddFailed", "Failed to add server.");
      return;
    }
    claudeFormOpen = false;
    await fetchClaudeMcpServers();
    renderList();
  }

  function buildClaudeForm() {
    const form = document.createElement("form");
    form.className = "composer-add-panel-claude-form";
    form.autocomplete = "off";
    form.noValidate = true;
    const errorId = "composer-add-panel-claude-error";

    const nameField = document.createElement("label");
    nameField.className = "composer-add-panel-field";
    const nameLabel = document.createElement("span");
    nameLabel.className = "composer-add-panel-field-label";
    nameLabel.textContent = i18n("compose.connectorPanel.claudeAddName", "Server name");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.name = "name";
    nameInput.required = true;
    nameInput.autocomplete = "off";
    nameInput.spellcheck = false;
    nameInput.className = "composer-add-panel-claude-input";
    nameInput.placeholder = i18n("compose.connectorPanel.claudeAddName", "Name (e.g. github)");
    nameInput.setAttribute("aria-label", i18n("compose.connectorPanel.claudeAddName", "Name"));
    nameInput.setAttribute("aria-describedby", errorId);
    nameField.append(nameLabel, nameInput);

    const commandField = document.createElement("label");
    commandField.className = "composer-add-panel-field";
    const commandLabel = document.createElement("span");
    commandLabel.className = "composer-add-panel-field-label";
    commandLabel.textContent = i18n("compose.connectorPanel.claudeAddCommand", "Command or URL");
    const commandInput = document.createElement("input");
    commandInput.type = "text";
    commandInput.name = "command";
    commandInput.required = true;
    commandInput.autocomplete = "off";
    commandInput.spellcheck = false;
    commandInput.className = "composer-add-panel-claude-input";
    commandInput.placeholder = i18n("compose.connectorPanel.claudeAddCommand", "Command or https:// URL");
    commandInput.setAttribute("aria-label", i18n("compose.connectorPanel.claudeAddCommand", "Command or URL"));
    commandInput.setAttribute("aria-describedby", errorId);
    commandField.append(commandLabel, commandInput);

    const errorEl = document.createElement("div");
    errorEl.className = "composer-add-panel-claude-error";
    errorEl.id = errorId;
    errorEl.setAttribute("role", "alert");

    const actions = document.createElement("div");
    actions.className = "composer-add-panel-form-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "composer-add-panel-refresh composer-add-panel-form-submit";
    submit.textContent = i18n("compose.connectorPanel.claudeAddSubmit", "Add");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "composer-add-panel-form-cancel";
    cancel.textContent = i18n("action.cancel", "Cancel");
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      claudeFormOpen = false;
      renderList();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitClaudeServer(nameInput, commandInput, errorEl);
    });
    actions.append(cancel, submit);
    form.append(nameField, commandField, errorEl, actions);
    return form;
  }

  function renderClaudeSection() {
    const title = document.createElement("div");
    title.className = "composer-add-panel-group-title";
    title.textContent = i18n("compose.connectorPanel.claudeTitle", "Claude Code MCP servers");
    listEl.appendChild(title);

    if (claudeMcpLoadFailed) {
      const failed = document.createElement("div");
      failed.className = "composer-add-panel-empty";
      failed.textContent = i18n("compose.connectorPanel.claudeLoadFailed", "Failed to load Claude Code MCP servers.");
      listEl.appendChild(failed);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "composer-add-panel-refresh";
      retry.textContent = i18n("compose.connectorPanel.refresh", "Refresh status");
      retry.addEventListener("click", () => {
        void refresh().then(renderList, renderList);
      });
      listEl.appendChild(retry);
      return;
    }

    for (const server of claudeMcpServers) {
      const row = document.createElement("div");
      row.className = "composer-add-panel-row composer-add-panel-row--claude is-static";
      const label = document.createElement("span");
      label.className = "composer-add-panel-row-label";
      label.textContent = trimString(server?.name) || server?.name || "?";
      row.appendChild(label);
      const summary = claudeTransportSummary(server);
      if (summary) {
        const detail = document.createElement("span");
        detail.className = "composer-add-panel-row-detail";
        detail.textContent = summary;
        detail.title = summary;
        row.appendChild(detail);
      }
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      const serverName = trimString(server?.name) || server?.name || "";
      const confirming = claudeRemoveCandidate === serverName;
      removeBtn.className = "composer-add-panel-row-remove" + (confirming ? " is-confirming" : "");
      removeBtn.textContent = confirming
        ? `${i18n("compose.connectorPanel.claudeRemove", "Remove")}?`
        : i18n("compose.connectorPanel.claudeRemove", "Remove");
      removeBtn.setAttribute("aria-label", `${removeBtn.textContent} ${serverName}`);
      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (confirming) {
          void removeClaudeServer(serverName);
          return;
        }
        claudeRemoveCandidate = serverName;
        renderList();
        window.setTimeout(() => {
          if (claudeRemoveCandidate === serverName) {
            claudeRemoveCandidate = "";
            renderList();
          }
        }, 4000);
      });
      row.appendChild(removeBtn);
      listEl.appendChild(row);
    }

    if (claudeMcpServers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "composer-add-panel-empty";
      empty.textContent = i18n("compose.connectorPanel.claudeNone", "No Claude Code MCP servers configured yet.");
      listEl.appendChild(empty);
    }

    if (claudeFormOpen) {
      listEl.appendChild(buildClaudeForm());
    } else {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "composer-add-panel-add";
      addBtn.textContent = i18n("compose.connectorPanel.claudeAdd", "Add server");
      addBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        claudeFormOpen = true;
        renderList();
        listEl.querySelector(".composer-add-panel-claude-input")?.focus({ preventScroll: true });
      });
      listEl.appendChild(addBtn);
    }
  }

  function renderCalendarSection() {
    if (calendarLoadFailed && !calendarFeed && !calendarGoogleStatus) {
      appendLoadFailedRow(
        "compose.connectorPanel.calendarTitle", "Calendar",
        "compose.connectorPanel.calendarLoadFailed", "Failed to load calendar status.",
      );
      return;
    }

    if (calendarFeed && calendarFeed.subscriptionUrl) {
      const eventCount = Number.isInteger(calendarFeed.eventCount) ? String(calendarFeed.eventCount) : "0";
      appendConnectorListRow({
        title: i18n("compose.connectorPanel.calendarSubscriptionShort", "Subscription"),
        detail: i18nWithVars("compose.connectorPanel.calendarFeedCount", { count: eventCount }, `${eventCount} events`),
        className: "composer-add-panel-row--calendar",
        action: {
          label: i18n("compose.connectorPanel.calendarCopyUrl", "Copy subscribe link"),
          onClick: (copyBtn) => copyCalendarSubscriptionUrl(copyBtn, trimString(calendarFeed.subscriptionUrl)),
        },
      });
    }

    const google = calendarGoogleStatus;
    if (google && typeof google === "object") {
      const googleStatus = google.tokenPresent
        ? i18n("settings.connectors.connected", "Connected")
        : google.credentialsPresent
          ? i18n("settings.connectors.needsAction", "Needs action")
          : i18n("compose.connectorPanel.calendarGoogleNotConfigured", "Not configured");
      const accountHint = trimString(google.binding?.accountHint);
      appendConnectorListRow({
        title: i18n("compose.connectorPanel.googleAccountTitle", "Google account"),
        detail: accountHint || i18n(
          "compose.connectorPanel.googleServicesDetail",
          "Calendar, Gmail and Drive",
        ),
        status: googleStatus,
        ready: google.tokenPresent === true,
        className: "composer-add-panel-row--google-account",
        action: google.tokenPresent !== true
          ? {
              label: i18n("compose.connectorPanel.googleConnect", "Connect Google"),
              primary: true,
              onClick: (authBtn) => void startCalendarAuthorization(authBtn),
            }
          : null,
      });

      appendConnectorListRow({
        title: i18n("compose.connectorPanel.calendarGoogleShort", "Calendar"),
        detail: accountHint || i18n("compose.connectorPanel.googleServicesDetail", "Google Calendar"),
        status: googleStatus,
        ready: google.tokenPresent === true,
        className: "composer-add-panel-row--calendar",
      });

      // 跨设备 owner 登录：把 Google 账号绑定为登录凭据（账号密码仅限本机）
      const owner = googleOwnerStatus;
      if (owner && typeof owner === "object" && owner.enabled) {
        const ownerBound = owner.bound === true;
        appendConnectorListRow({
          title: i18n("compose.connectorPanel.googleOwnerTitle", "Cross-device sign-in"),
          detail: ownerBound
            ? i18n("compose.connectorPanel.googleOwnerBoundDetail", "This Google account signs in as the owner from any device")
            : i18n("compose.connectorPanel.googleOwnerUnboundDetail", "Bind a Google account to sign in from any device"),
          status: ownerBound
            ? i18n("settings.connectors.connected", "Bound")
            : i18n("settings.connectors.needsAction", "Not bound"),
          ready: ownerBound,
          className: "composer-add-panel-row--google-owner",
          action: !ownerBound
            ? {
                label: i18n("compose.connectorPanel.googleOwnerBind", "Bind Google sign-in"),
                primary: true,
                onClick: (bindBtn) => void startGoogleOwnerBind(bindBtn),
              }
            : null,
        });
      }
    }
  }

  // Gmail and Drive share the Google account action with Calendar. They keep
  // their own status rows so the user can see the actual service coverage.
  function renderGoogleServiceSection(status, loadFailed, titleKey, titleFallback, connectLabel) {
    if (loadFailed && !status) {
      appendConnectorListRow({
        title: titleFallback,
        detail: i18n("compose.connectorPanel.googleLoadFailed", "Failed to load Google status."),
        action: {
          label: i18n("compose.connectorPanel.refresh", "Refresh status"),
          onClick: () => void refresh().then(renderList, renderList),
        },
      });
      return;
    }

    if (!status || typeof status !== "object") {
      appendConnectorListRow({
        title: titleFallback,
        detail: i18n("compose.connectorPanel.googleUnavailable", "Google status is unavailable."),
      });
      return;
    }

    const ready = status.tokenPresent === true && status.scopeCompliant !== false;
    const statusLabel = ready
      ? i18n("settings.connectors.connected", "Connected")
      : status.credentialsPresent === true
        ? i18n("settings.connectors.needsAction", "Needs action")
        : i18n("compose.connectorPanel.calendarGoogleNotConfigured", "Not configured");
    const accountHint = trimString(status.accountHint) || trimString(status.binding?.accountHint);
    appendConnectorListRow({
      title: i18n(titleKey, titleFallback),
      detail: accountHint || i18n("compose.connectorPanel.googleAccountDetail", "Uses the shared Google account"),
      status: statusLabel,
      ready,
      className: "composer-add-panel-row--calendar",
    });
  }

  function renderGmailSection() {
    renderGoogleServiceSection(
      gmailStatus,
      gmailLoadFailed,
      "compose.connectorPanel.gmailTitle",
      "Gmail",
      i18n("compose.connectorPanel.gmailConnect", "Connect Gmail"),
    );
  }

  function renderDriveSection() {
    renderGoogleServiceSection(
      driveStatus,
      driveLoadFailed,
      "compose.connectorPanel.driveShort",
      "Google Drive",
      i18n("compose.connectorPanel.driveConnect", "Connect Google Drive"),
    );
  }

  function startGitHubAuthorization(button) {
    const original = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    let authUrl = "";
    let errorMessage = "";
    (async () => {
      try {
        const response = typeof fetchJsonOrRedirect === "function"
          ? await fetchJsonOrRedirect("/api/connectors/github/authorize", { method: "POST" })
          : await (window.agentocFetch || fetch)("/api/connectors/github/authorize", { method: "POST" });
        let data = null;
        if (typeof response?.json === "function") {
          data = await response.json().catch(() => null);
        } else {
          data = response;
        }
        authUrl = trimString(data?.authUrl);
        if (!authUrl) errorMessage = trimString(data?.error);
      } catch (error) {
        errorMessage = trimString(error?.message) || "";
      }
      if (authUrl) {
        window.open(authUrl, "_blank", "noopener");
        setPanelStatus(i18n("compose.connectorPanel.githubAuthOpened", "GitHub authorization opened."));
      } else if (button) {
        const message = errorMessage || i18n("compose.connectorPanel.githubAuthorizeFailed", "Authorization could not be started.");
        button.textContent = message;
        setPanelStatus(message);
      }
      if (button) {
        window.setTimeout(() => {
          button.disabled = false;
          button.removeAttribute("aria-busy");
          button.textContent = original;
        }, 3000);
      }
    })();
  }

  async function submitGitHubConfig(appIdInput, clientIdInput, secretInput, keyInput, errorEl) {
    const appId = trimString(appIdInput.value);
    const clientId = trimString(clientIdInput.value);
    const clientSecret = trimString(secretInput.value);
    const privateKey = trimString(keyInput.value);
    let message = "";
    try {
      const data = typeof fetchJsonOrRedirect === "function"
        ? await fetchJsonOrRedirect("/api/connectors/github/configure", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ appId, clientId, clientSecret, privateKey }),
          })
        : await (window.agentocFetch || fetch)("/api/connectors/github/configure", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ appId, clientId, clientSecret, privateKey }),
          }).then((response) => response.json());
      if (data && typeof data === "object" && data.configured === true) {
        githubFormOpen = false;
        await fetchGitHubStatus();
        renderList();
        setPanelStatus(i18n("compose.connectorPanel.githubSaved", "GitHub App configuration saved."));
        return;
      }
      message = trimString(data?.error);
    } catch (error) {
      message = trimString(error?.message) || trimString(error?.error);
    }
    errorEl.textContent = message || i18n("compose.connectorPanel.githubSaveFailed", "Failed to save GitHub App configuration.");
    errorEl.hidden = false;
  }

  function buildGitHubConfigureForm() {
    const form = document.createElement("form");
    form.className = "composer-add-panel-claude-form";
    form.setAttribute("aria-label", i18n("compose.connectorPanel.githubConfigure", "Configure GitHub App"));
    const errorId = "composer-add-panel-github-error";

    const appIdField = document.createElement("label");
    appIdField.className = "composer-add-panel-field";
    const appIdLabel = document.createElement("span");
    appIdLabel.className = "composer-add-panel-field-label";
    appIdLabel.textContent = i18n("compose.connectorPanel.githubAppId", "GitHub App ID");
    const appIdInput = document.createElement("input");
    appIdInput.type = "text";
    appIdInput.name = "appId";
    appIdInput.autocomplete = "off";
    appIdInput.spellcheck = false;
    appIdInput.className = "composer-add-panel-claude-input";
    appIdInput.placeholder = i18n("compose.connectorPanel.githubAppId", "GitHub App ID");
    appIdInput.value = trimString(githubStatus?.appId) || "";
    appIdInput.setAttribute("aria-label", i18n("compose.connectorPanel.githubAppId", "GitHub App ID"));
    appIdInput.setAttribute("aria-describedby", errorId);
    appIdField.append(appIdLabel, appIdInput);

    const clientIdField = document.createElement("label");
    clientIdField.className = "composer-add-panel-field";
    const clientIdLabel = document.createElement("span");
    clientIdLabel.className = "composer-add-panel-field-label";
    clientIdLabel.textContent = i18n("compose.connectorPanel.githubClientId", "GitHub Client ID");
    const clientIdInput = document.createElement("input");
    clientIdInput.type = "text";
    clientIdInput.name = "clientId";
    clientIdInput.autocomplete = "off";
    clientIdInput.spellcheck = false;
    clientIdInput.className = "composer-add-panel-claude-input";
    clientIdInput.placeholder = i18n("compose.connectorPanel.githubClientId", "GitHub Client ID");
    clientIdInput.value = trimString(githubStatus?.clientId) || "";
    clientIdInput.setAttribute("aria-label", i18n("compose.connectorPanel.githubClientId", "GitHub Client ID"));
    clientIdInput.setAttribute("aria-describedby", errorId);
    clientIdField.append(clientIdLabel, clientIdInput);

    const secretField = document.createElement("label");
    secretField.className = "compose-add-panel-field";
    const secretLabel = document.createElement("span");
    secretLabel.className = "composer-add-panel-field-label";
    secretLabel.textContent = i18n("compose.connectorPanel.githubClientSecret", "Client Secret");
    const secretInput = document.createElement("input");
    secretInput.type = "password";
    secretInput.name = "clientSecret";
    secretInput.autocomplete = "new-password";
    secretInput.spellcheck = false;
    secretInput.className = "composer-add-panel-claude-input";
    secretInput.placeholder = i18n("compose.connectorPanel.githubClientSecret", "Client Secret");
    secretInput.required = true;
    secretInput.setAttribute("aria-label", i18n("compose.connectorPanel.githubClientSecret", "Client Secret"));
    secretInput.setAttribute("aria-describedby", errorId);
    secretField.append(secretLabel, secretInput);

    const keyField = document.createElement("label");
    keyField.className = "composer-add-panel-field";
    const keyLabel = document.createElement("span");
    keyLabel.className = "composer-add-panel-field-label";
    keyLabel.textContent = i18n("compose.connectorPanel.githubPrivateKey", "Private Key (.pem)");
    const keyInput = document.createElement("textarea");
    keyInput.name = "privateKey";
    keyInput.rows = 3;
    keyInput.spellcheck = false;
    keyInput.className = "composer-add-panel-claude-input";
    keyInput.placeholder = i18n("compose.connectorPanel.githubPrivateKey", "Private Key (.pem) — optional, for later phases");
    keyInput.setAttribute("aria-label", i18n("compose.connectorPanel.githubPrivateKey", "Private Key (.pem)"));
    keyInput.setAttribute("aria-describedby", errorId);
    keyField.append(keyLabel, keyInput);

    const errorEl = document.createElement("div");
    errorEl.className = "composer-add-panel-claude-error";
    errorEl.id = errorId;
    errorEl.setAttribute("role", "alert");
    errorEl.hidden = true;

    const actions = document.createElement("div");
    actions.className = "composer-add-panel-form-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "composer-add-panel-refresh composer-add-panel-form-submit";
    submit.textContent = i18n("compose.connectorPanel.githubSave", "Save");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "composer-add-panel-form-cancel";
    cancel.textContent = i18n("action.cancel", "Cancel");
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      githubFormOpen = false;
      renderList();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitGitHubConfig(appIdInput, clientIdInput, secretInput, keyInput, errorEl);
    });
    actions.append(cancel, submit);
    form.append(appIdField, clientIdField, secretField, keyField, errorEl, actions);
    return form;
  }

  function renderGitHubSection() {
    if (githubLoadFailed && !githubStatus) {
      appendLoadFailedRow(
        "compose.connectorPanel.githubTitle", "GitHub",
        "compose.connectorPanel.githubLoadFailed", "Failed to load GitHub status.",
      );
      return;
    }

    const title = document.createElement("div");
    title.className = "composer-add-panel-group-title";
    title.textContent = i18n("compose.connectorPanel.githubTitle", "GitHub");
    listEl.appendChild(title);

    if (!githubStatus || typeof githubStatus !== "object") {
      const empty = document.createElement("div");
      empty.className = "composer-add-panel-empty";
      empty.textContent = i18n("compose.connectorPanel.githubUnavailable", "GitHub status is unavailable.");
      listEl.appendChild(empty);
      return;
    }

    const ready = githubStatus.binding?.capabilityState === "ready";
    if (ready || githubStatus.configured === true) {
      const status = ready
        ? i18n("settings.connectors.connected", "Connected")
        : i18n("settings.connectors.needsAction", "Needs action");
      const accountHint = trimString(githubStatus.binding?.accountHint);
      appendConnectorListRow({
        title: i18n("compose.connectorPanel.accountShort", "Account"),
        detail: accountHint ? `@${accountHint}` : i18n("compose.connectorPanel.githubTitle", "GitHub"),
        status,
        ready,
        className: "composer-add-panel-row--github",
        action: ready
          ? {
              label: i18n("compose.connectorPanel.githubDisconnect", "Disconnect"),
              keepStatus: true,
              onClick: () => void (async () => {
                try {
                  if (typeof fetchJsonOrRedirect === "function") {
                    await fetchJsonOrRedirect("/api/connectors/github/disconnect", { method: "POST" });
                  } else {
                    await (window.agentocFetch || fetch)("/api/connectors/github/disconnect", { method: "POST" });
                  }
                } catch {
                  // Refresh below restores the current server truth.
                }
                githubFormOpen = false;
                await fetchGitHubStatus();
                renderList();
              })(),
            }
          : {
              label: i18n("compose.connectorPanel.githubConnect", "Connect GitHub"),
              primary: true,
              onClick: (authBtn) => void startGitHubAuthorization(authBtn),
            },
      });
      return;
    }

    if (githubFormOpen) {
      listEl.appendChild(buildGitHubConfigureForm());
    } else {
      appendConnectorListRow({
        title: i18n("compose.connectorPanel.githubTitle", "GitHub"),
        detail: i18n("compose.connectorPanel.githubNotConfigured", "Not configured"),
        status: i18n("compose.connectorPanel.githubNotConfigured", "Not configured"),
        className: "composer-add-panel-row--github",
        action: {
          label: i18n("compose.connectorPanel.githubConfigure", "Configure GitHub App"),
          primary: true,
          onClick: () => {
            githubFormOpen = true;
            renderList();
            listEl.querySelector(".composer-add-panel-claude-input")?.focus({ preventScroll: true });
          },
        },
      });
    }
  }

  function renderMailSection() {
    if (mailLoadFailed && !mailStatus) {
      appendLoadFailedRow(
        "compose.connectorPanel.mailTitle", "Mail",
        "compose.connectorPanel.mailLoadFailed", "Failed to load mail status.",
      );
      return;
    }

    const title = document.createElement("div");
    title.className = "composer-add-panel-group-title";
    title.textContent = i18n("compose.connectorPanel.mailTitle", "Mail");
    listEl.appendChild(title);

    if (!mailStatus) {
      const empty = document.createElement("div");
      empty.className = "composer-add-panel-empty";
      empty.textContent = i18n("compose.connectorPanel.mailUnavailable", "Mail status is unavailable.");
      listEl.appendChild(empty);
      return;
    }

    if (!mailStatus.initialized) {
      appendConnectorListRow({
        title: i18n("compose.connectorPanel.mailInboxShort", "Inbox"),
        detail: i18n("compose.connectorPanel.mailNotInitialized", "Not initialized"),
        status: i18n("compose.connectorPanel.mailNotInitialized", "Not initialized"),
        action: {
          label: i18n("compose.connectorPanel.mailSetup", "Open mail settings"),
          primary: true,
          onClick: () => openSettings(),
        },
        className: "composer-add-panel-row--mail",
      });
      return;
    }

    const counts = mailStatus.counts || {};
    const reviewCount = String(counts.review ?? 0);
    const quarantineCount = String(counts.quarantine ?? 0);
    const mailboxDetail = i18nWithVars(
      "compose.connectorPanel.mailQueueCounts",
      { review: reviewCount, quarantine: quarantineCount },
      `${reviewCount} to review, ${quarantineCount} quarantined`,
    );
    appendConnectorListRow({
      title: i18n("compose.connectorPanel.mailInboxShort", "Inbox"),
      detail: mailboxDetail,
      status: reviewCount === "0"
        ? i18n("settings.connectors.connected", "Connected")
        : `${reviewCount} ${i18n("compose.connectorPanel.mailReviewShort", "review")}`,
      ready: reviewCount === "0",
      className: "composer-add-panel-row--mail",
    });

    const outbound = mailStatus.outbound || {};
    const outboundStatus = outbound.configured
      ? i18n("compose.connectorPanel.mailOutboundConfigured", "Configured")
      : i18n("compose.connectorPanel.mailOutboundNotConfigured", "Not configured");
    const outboundFrom = trimString(outbound.from);
    appendConnectorListRow({
      title: i18n("compose.connectorPanel.mailOutboundShort", "Outbound"),
      detail: outboundFrom || i18n("compose.connectorPanel.mailOutboundTitle", "Outbound mail"),
      status: outboundStatus,
      ready: outbound.configured === true,
      className: "composer-add-panel-row--mail",
      action: !outbound.configured
        ? {
            label: i18n("compose.connectorPanel.mailConfigureOutbound", "Configure outbound mail"),
            onClick: () => openSettings(),
          }
        : null,
    });

    const automation = mailStatus.automation || {};
    const automationStatus = automation.enabled
      ? i18n("compose.connectorPanel.mailAutomationOn", "On")
      : i18n("compose.connectorPanel.mailAutomationOff", "Off");
    appendConnectorListRow({
      title: i18n("compose.connectorPanel.mailAutomationShort", "Automation"),
      detail: i18n("compose.connectorPanel.mailAutomationTitle", "Mail automation"),
      status: automationStatus,
      ready: automation.enabled === true,
      className: "composer-add-panel-row--mail",
    });
  }

  function renderConnectorSurfaceRow(surface) {
    const ready = isReady(surface);
    const row = document.createElement(ready ? "div" : "button");
    if (!ready) row.type = "button";
    row.className = "composer-add-panel-row composer-add-panel-row--connector" + (ready ? " is-static" : " is-actionable");
    const label = document.createElement("span");
    label.className = "composer-add-panel-row-label";
    label.textContent = surfaceTitle(surface);
    row.appendChild(label);
    const pill = document.createElement("span");
    pill.className = "composer-add-panel-pill" + (ready ? " is-ready" : "");
    pill.textContent = ready
      ? i18n("settings.connectors.connected", "Connected")
      : i18n("settings.connectors.needsAction", "Needs action");
    row.appendChild(pill);
    if (!ready && window.AgentoCIcons?.render) {
      const arrow = document.createElement("span");
      arrow.className = "composer-add-panel-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.innerHTML = window.AgentoCIcons.render("chevron-right");
      row.appendChild(arrow);
    }
    if (!ready) {
      row.setAttribute("aria-label", `${surfaceTitle(surface)} — ${pill.textContent}`);
      row.addEventListener("click", () => {
        const canEmbed = surface?.allowEmbed === true && !!resolveSurfaceUrl(surface?.entryUrl);
        if (canEmbed) {
          openAuthorizeView(surface);
        } else {
          openSettings();
        }
      });
    }
    listEl.appendChild(row);
  }

  function renderOtherConnectorSection(surfaces) {
    if (!surfaces.length) return;
    const title = document.createElement("div");
    title.className = "composer-add-panel-group-title";
    title.textContent = i18n("compose.connectorPanel.otherTitle", "Other connectors");
    listEl.appendChild(title);
    for (const surface of [...surfaces].sort((left, right) => surfaceTitle(left).localeCompare(surfaceTitle(right)))) {
      renderConnectorSurfaceRow(surface);
    }
  }

  function renderDeveloperSection() {
    const disclosure = document.createElement("button");
    disclosure.type = "button";
    disclosure.className = "composer-add-panel-disclosure";
    disclosure.setAttribute("aria-expanded", String(developerConnectionsOpen));
    disclosure.setAttribute(
      "aria-label",
      i18n(
        developerConnectionsOpen
          ? "compose.connectorPanel.developerClose"
          : "compose.connectorPanel.developerOpen",
        developerConnectionsOpen ? "Hide developer connections" : "Show developer connections",
      ),
    );
    disclosure.textContent = i18n("compose.connectorPanel.developerTitle", "Developer connections");
    disclosure.addEventListener("click", (event) => {
      event.stopPropagation();
      developerConnectionsOpen = !developerConnectionsOpen;
      renderList();
      listEl.querySelector(".composer-add-panel-disclosure")?.focus({ preventScroll: true });
    });
    listEl.appendChild(disclosure);
    if (!developerConnectionsOpen) return;
    renderCodexCapabilities();
    renderCodexSection();
    renderClaudeSection();
  }

  function renderList() {
    if (!canManage()) {
      renderMessage(i18n("settings.connectors.ownerOnly", "Connector login is only available to the owner."));
      return;
    }
    if (codexMcpProvider && typeof getComposerRuntimeSelectedProvider === "function"
      && trimString(getComposerRuntimeSelectedProvider("codex")) !== codexMcpProvider) {
      codexMcpProvider = ""; codexMcpServers = []; codexCapabilities = []; codexMcpCapabilities = [];
      codexCapabilityError = false; codexPluginsUnavailable = false; codexPluginPreference = null; codexSyncState = null; codexSyncMode = ""; codexSyncGeneration += 1;
    }
    const cache = typeof connectorSurfacesCache !== "undefined" ? connectorSurfacesCache : [];
    const visible = Array.isArray(cache) ? cache.filter((surface) => surface && typeof surface === "object") : [];
    listEl.innerHTML = "";
    const otherSurfaces = visible.filter((surface) => !isBuiltInStatusSurface(surface));

    // Put the product-critical status surfaces first. Their detailed rows
    // are the source of truth, so they should not also appear as generic rows.
    const googleTitle = document.createElement("div");
    googleTitle.className = "composer-add-panel-group-title";
    googleTitle.textContent = i18n("compose.connectorPanel.googleServicesTitle", "Google");
    listEl.appendChild(googleTitle);
    renderCalendarSection();
    renderGmailSection();
    renderDriveSection();
    renderGitHubSection();
    renderMailSection();
    renderOtherConnectorSection(otherSurfaces);
    renderDeveloperSection();
  }

  async function refresh() {
    if (typeof fetchConnectorSurfaces === "function") {
      await fetchConnectorSurfaces();
    }
    if (canManage()) {
      await fetchCodexMcpServers();
      await fetchClaudeMcpServers();
      if (!developerConnectionsOpen && (
        codexMcpServers.length > 0
        || claudeMcpServers.length > 0
        || codexMcpLoadFailed
        || claudeMcpLoadFailed
      )) {
        developerConnectionsOpen = true;
      }
      // Status endpoints are independent and already use short-lived
      // read-through caches. Fetch them together so opening the Connector
      // panel does not serialize five network round trips.
      await Promise.all([
        fetchCalendarStatus(),
        fetchGmailStatus(),
        fetchDriveStatus(),
        fetchGitHubStatus(),
        fetchMailStatus(),
        fetchCodexCapabilities().then(() => fetchCodexSyncState()),
        fetchCodexPluginPreference(),
      ]);
    }
  }

  function show() {
    if (!panel) return;
    if (!backdrop) return;
    trigger?.setAttribute("aria-expanded", "true");
    panel.setAttribute("aria-modal", "true");
    if (backdropHideTimer) clearTimeout(backdropHideTimer);
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop?.classList.add("is-visible"));
    panel.hidden = false;
    panel.classList.remove("is-closing");
    if (window.AgentoCMotion?.setPresence) {
      window.AgentoCMotion.setPresence(panel, true, { duration: 220 });
    } else {
      panel.classList.add("is-open");
    }
    focusScopeDeactivate = window.AgentoCFocusScope?.activate?.(panel, {
      containmentRoot: document.body,
      initialFocus: () => listEl?.querySelector("button:not(:disabled)") || manageBtn,
      restoreFocus: () => (focusBeforeOpen && focusBeforeOpen.isConnected !== false)
        ? focusBeforeOpen
        : trigger,
      modal: true,
      onEscape: () => closePanel(),
    }) || null;
    backEntryId = (window.AgentoCBackHandler && typeof window.AgentoCBackHandler.push === "function")
      ? window.AgentoCBackHandler.push({ id: "composer-connector-panel", onBack: () => { closePanel(); return true; } })
      : null;
  }

  function hide() {
    if (!panel) return;
    trigger?.setAttribute("aria-expanded", "false");
    if (backEntryId && window.AgentoCBackHandler && typeof window.AgentoCBackHandler.pop === "function") {
      window.AgentoCBackHandler.pop(backEntryId);
      backEntryId = null;
    }
    const hadFocusScope = Boolean(focusScopeDeactivate);
    if (focusScopeDeactivate) {
      focusScopeDeactivate();
      focusScopeDeactivate = null;
    }
    if (window.AgentoCMotion?.setPresence) {
      window.AgentoCMotion.setPresence(panel, false, { duration: 180 });
    } else {
      panel.classList.remove("is-open");
      panel.classList.add("is-closing");
      setTimeout(() => {
        if (!panel) return;
        panel.hidden = true;
        panel.classList.remove("is-closing");
      }, 140);
    }
    if (!hadFocusScope && restoreFocus && trigger && typeof trigger.focus === "function") {
      trigger.focus({ preventScroll: true });
    }
    restoreFocus = false;
    panel.setAttribute("aria-modal", "false");
    if (backdrop) {
      backdrop.classList.remove("is-visible");
      if (backdropHideTimer) clearTimeout(backdropHideTimer);
      backdropHideTimer = setTimeout(() => {
        backdropHideTimer = null;
        if (!panelOpen) backdrop.hidden = true;
      }, 190);
    }
    panel.classList.remove("composer-add-panel--dragging");
    panel.style.transform = "";
    panel.style.transition = "";
    if (backdrop) backdrop.style.opacity = "";
  }

  function focusFirstItem() {
    if (!restoreFocus || !listEl) return;
    const first = listEl.querySelector("button:not(:disabled)") || manageBtn;
    if (first && typeof first.focus === "function") first.focus({ preventScroll: true });
  }

  function positionPanel() {
    if (!panel || !trigger) return;
    if (window.matchMedia?.("(max-width: 767px)")?.matches) {
      panel.style.width = "";
      panel.style.left = "";
      panel.style.right = "";
      panel.style.bottom = "";
      return;
    }
    const anchor = trigger.closest(".input-wrapper") || trigger;
    const anchorRect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.visualViewport?.height || window.innerHeight || 0;
    const width = Math.min(360, Math.max(0, anchorRect.width - 4), Math.max(0, viewportWidth - 32));
    const left = Math.max(16, Math.min(anchorRect.left, viewportWidth - width - 16));
    panel.style.width = `${width}px`;
    panel.style.left = `${left}px`;
    panel.style.bottom = `${Math.max(12, viewportHeight - anchorRect.top + 10)}px`;
  }

  function isMobileSheet() {
    return window.matchMedia?.("(max-width: 767px)")?.matches === true;
  }

  function resetSheetDrag() {
    if (!panel) return;
    panel.classList.remove("composer-add-panel--dragging");
    panel.style.transition = "transform 180ms var(--motion-ease-emphasized, cubic-bezier(0.16, 1, 0.3, 1))";
    panel.style.transform = "translate3d(0, 0, 0)";
    if (backdrop) backdrop.style.opacity = "";
    if (sheetDragResetTimer) clearTimeout(sheetDragResetTimer);
    sheetDragResetTimer = setTimeout(() => {
      sheetDragResetTimer = null;
      panel.style.transform = "";
      panel.style.transition = "";
    }, 190);
  }

  function finishSheetDrag(event = {}) {
    if (!sheetDrag || (sheetDrag.pointerId !== null && Number.isInteger(event.pointerId) && event.pointerId !== sheetDrag.pointerId)) return;
    const deltaY = sheetDrag.lastDeltaY;
    const moved = sheetDrag.moved;
    const pointerId = sheetDrag.pointerId;
    sheetDrag = null;
    if (pointerId !== null) handleZone?.releasePointerCapture?.(pointerId);
    if (!isMobileSheet() || !moved || deltaY <= 0) {
      resetSheetDrag();
      return;
    }
    if (deltaY >= 120) {
      closePanel();
      return;
    }
    resetSheetDrag();
  }

  function installSheetHandle() {
    if (!panel || handleZone) return;
    handleZone = document.createElement("div");
    handleZone.className = "composer-add-panel-handle-zone";
    handleZone.setAttribute("aria-hidden", "true");
    const bar = document.createElement("span");
    bar.className = "composer-add-panel-handle";
    handleZone.appendChild(bar);
    panel.insertBefore(handleZone, panel.firstChild);
    handleZone.addEventListener("pointerdown", (event) => {
      if (!isMobileSheet() || event.isPrimary === false) return;
      sheetDrag = { pointerId: Number.isInteger(event.pointerId) ? event.pointerId : null, startY: event.clientY, lastDeltaY: 0, moved: false };
      panel.classList.add("composer-add-panel--dragging");
      handleZone.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    handleZone.addEventListener("pointermove", (event) => {
      if (!sheetDrag || (sheetDrag.pointerId !== null && event.pointerId !== sheetDrag.pointerId)) return;
      const deltaY = Math.max(0, event.clientY - sheetDrag.startY);
      sheetDrag.lastDeltaY = deltaY;
      if (deltaY > 4) sheetDrag.moved = true;
      panel.style.transform = `translate3d(0, ${deltaY}px, 0)`;
      if (backdrop) backdrop.style.opacity = String(1 - Math.min(deltaY / 260, 0.72));
      event.preventDefault();
    });
    handleZone.addEventListener("pointerup", finishSheetDrag);
    handleZone.addEventListener("pointercancel", finishSheetDrag);
  }

  function openPanel() {
    if (panelOpen) return;
    if (!panel) ready();
    if (!panel) return;
    if (typeof window.AgentoCAgentPanel?.close === "function") {
      window.AgentoCAgentPanel.close();
    }
    loadGeneration += 1;
    const generation = loadGeneration;
    trigger = document.getElementById("composerConnectorsMenuItem") || trigger;
    focusBeforeOpen = document.activeElement;
    restoreFocus = !!trigger && document.activeElement === trigger;
    panelOpen = true;
    positionPanel();
    setPanelStatus("");
    renderMessage(typeof t === "function" ? t("settings.connectors.loading") : "Loading connectors…");
    show();
    if (restoreFocus) panel.focus({ preventScroll: true });
    void refresh().then(() => {
      if (panelOpen && generation === loadGeneration) {
        renderList();
        focusFirstItem();
      }
    }, () => {
      if (panelOpen && generation === loadGeneration) {
        renderMessage(typeof t === "function" ? t("settings.connectors.loadingFailed") : "Failed to load connectors.");
        focusFirstItem();
      }
    });
  }

  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    hide();
  }

  function ready() {
    if (initialized) return;
    initialized = true;
    panel = document.getElementById("composerConnectorPanel");
    listEl = document.getElementById("composerConnectorList");
    manageBtn = document.getElementById("composerConnectorPanelManage");
    statusEl = document.getElementById("composerConnectorPanelStatus");
    trigger = document.getElementById("composerConnectorsMenuItem");
    if (panel && panel.parentElement !== document.body) {
      document.body.appendChild(panel);
      panel.classList.add("composer-add-panel--portaled");
      panel.style.position = "fixed";
    }
    panel?.classList.add("composer-add-panel--connector");
    backdrop = document.createElement("div");
    backdrop.className = "composer-add-panel-backdrop";
    backdrop.hidden = true;
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.addEventListener("click", () => closePanel());
    document.body.appendChild(backdrop);
    installSheetHandle();
    trigger?.setAttribute("aria-controls", "composerConnectorPanel");
    trigger?.setAttribute("aria-expanded", "false");
    trigger?.setAttribute("aria-haspopup", "dialog");
    if (manageBtn) {
      manageBtn.addEventListener("click", openSettings);
    }
    panel?.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("pointerdown", (event) => {
      if (!panelOpen || !isMobileSheet() || !panel) return;
      if (event.target instanceof Node && !panel.contains(event.target)) closePanel();
    }, { capture: true });
    document.addEventListener("click", (event) => {
      if (!panelOpen || !panel) return;
      if (window.matchMedia?.("(max-width: 767px)")?.matches) return;
      if (event.target instanceof Node && !panel.contains(event.target) && !trigger?.contains(event.target)) closePanel();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && panelOpen) closePanel();
    });
    window.addEventListener("resize", positionPanel, { passive: true });
    window.addEventListener("scroll", positionPanel, { passive: true, capture: true });
    window.visualViewport?.addEventListener("resize", positionPanel, { passive: true });
    window.visualViewport?.addEventListener("scroll", positionPanel, { passive: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready);
  } else {
    ready();
  }

  window.AgentoCConnectorPanel = Object.freeze({
    open: openPanel,
    close: closePanel,
    isOpen: () => panelOpen,
  });
})();
