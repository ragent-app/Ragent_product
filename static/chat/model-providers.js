(function attachModelProviders(globalScope) {
  "use strict";

  const documentRef = globalScope.document;
  const settingsSection = documentRef?.getElementById("modelProvidersSettingsSection") || null;
  const panel = documentRef?.getElementById("modelProvidersPanel") || null;
  const openButton = documentRef?.getElementById("modelProvidersOpenBtn") || null;
  const addButton = documentRef?.getElementById("modelProvidersAddBtn") || null;
  const listElement = documentRef?.getElementById("modelProvidersList") || null;
  const statusElement = documentRef?.getElementById("modelProvidersStatus") || null;
  let providers = [];
  let modal = null;
  let modalFocusScopeDeactivate = null;
  let modalTrigger = null;
  let fieldIdSequence = 0;
  let activeJobId = "";
  let pollTimer = null;
  let oauthHandoffStarted = false;
  let oauthLoginWindow = null;
  let oauthHandoffMessage = "";
  let agyCredentialInput = null;
  let agyCredentialSubmitButton = null;
  const PROVIDER_LIST_CACHE_MAX_AGE_MS = 10 * 1000;
  const FALLBACK_HARNESS_PROTOCOLS = Object.freeze({
    codex: ["openai-responses", "openai-chat"],
    claude: ["anthropic-messages"],
    agy: ["agy"],
    pi: ["openai-chat", "openai-responses", "anthropic-messages"],
    "qwen-code": ["openai-chat", "openai-responses", "anthropic-messages"],
    opencode: ["openai-chat", "openai-responses", "anthropic-messages"],
    "kimi-code": ["openai-chat", "openai-responses", "anthropic-messages"],
    goose: ["openai-chat", "openai-responses", "anthropic-messages"],
    openhands: ["openai-chat", "openai-responses", "anthropic-messages"],
    copilot: ["github-copilot", "openai-chat", "openai-responses", "anthropic-messages"],
    hermes: ["openai-chat", "openai-responses", "anthropic-messages"],
    cline: ["openai-chat", "openai-responses", "anthropic-messages"],
    kilo: ["openai-chat", "openai-responses", "anthropic-messages"],
  });
  const PROTOCOL_LABEL_KEYS = Object.freeze({
    "openai-responses": "modelProviders.responses",
    "openai-chat": "modelProviders.chat",
    "anthropic-messages": "modelProviders.anthropic",
    "github-copilot": "modelProviders.githubCopilot",
    agy: "modelProviders.agyProtocol",
  });
  const PROTOCOL_ENDPOINTS = Object.freeze({
    "openai-responses": "/v1/responses",
    "openai-chat": "/v1/chat/completions",
    "anthropic-messages": "/v1/messages",
    agy: "native CLI",
    "github-copilot": "GitHub Copilot service",
  });
  const harnessProtocols = new Map(Object.entries(FALLBACK_HARNESS_PROTOCOLS));
  let harnessProtocolsPromise = null;
  let harnessCatalogLoaded = false;
  let globallyInstalledHarnessIds = new Set();

  const HARNESS_AGENT_TYPES = new Set([
    "codex", "claude", "agy", "pi", "deepseek-harness", "qwen-code",
    "opencode", "kimi-code", "goose", "openhands", "copilot", "hermes", "cline", "kilo",
  ]);
  const PROVIDER_AGENT_TYPES = Object.freeze([
    ["codex", "Codex"],
    ["claude", "Claude"],
    ["agy", "agy"],
    ["qwen-code", "Qwen Code"],
    ["opencode", "OpenCode"],
    ["kimi-code", "Kimi Code"],
    ["goose", "Goose"],
    ["pi", "Pi"],
    ["deepseek-harness", "DeepSeek Harness"],
    ["openhands", "OpenHands"],
    ["copilot", "GitHub Copilot"],
    ["hermes", "Hermes Agent"],
    ["cline", "Cline"],
    ["kilo", "Kilo Code"],
  ]);

  function translate(key, vars = {}) {
    return typeof globalScope.ragentT === "function" ? globalScope.ragentT(key, vars) : key;
  }

  function canManage() {
    return globalScope.__RAGENT_BOOTSTRAP__?.auth?.role === "owner";
  }

  function syncSettingsEntryVisibility() {
    if (!settingsSection) return;
    settingsSection.hidden = !canManage();
  }

  function resolveApiPath(path) {
    return typeof globalScope.ragentResolveProductPath === "function"
      ? globalScope.ragentResolveProductPath(path)
      : path;
  }

  async function request(path, options = {}) {
    const responseOrPayload = await (typeof globalScope.fetchJsonOrRedirect === "function"
      ? globalScope.fetchJsonOrRedirect(resolveApiPath(path), options)
      : (globalScope.ragentFetch || globalScope.fetch)(resolveApiPath(path), { credentials: "same-origin", ...options }));
    if (!responseOrPayload || typeof responseOrPayload.json !== "function") return responseOrPayload || {};
    const response = responseOrPayload;
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const error = new Error(payload?.error || translate("modelProviders.loadFailed"));
      error.status = response.status;
      error.code = payload?.code || "";
      throw error;
    }
    return payload;
  }

  function normalizeProtocol(value) {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    return Object.prototype.hasOwnProperty.call(PROTOCOL_LABEL_KEYS, normalized) ? normalized : "";
  }

  function getSupportedProtocols(agentType) {
    const protocols = harnessProtocols.get(String(agentType || "").trim());
    return Array.isArray(protocols) ? protocols : [];
  }

  function formatProtocol(protocol) {
    const normalized = normalizeProtocol(protocol);
    if (!normalized) return "";
    const label = translate(PROTOCOL_LABEL_KEYS[normalized]);
    const endpoint = PROTOCOL_ENDPOINTS[normalized];
    return `${label} (${endpoint})`;
  }

  function isHarnessType(value) {
    return HARNESS_AGENT_TYPES.has(String(value || "").trim());
  }

  // Codex and agy retain their native official login paths. Claude subscription
  // credentials use setup-token only; third-party harness bridges are API-key-only.
  const API_KEY_ONLY_HARNESS_TYPES = new Set([
    "pi", "deepseek-harness", "qwen-code", "opencode", "kimi-code", "goose",
    "openhands", "copilot", "hermes", "cline", "kilo",
  ]);

  function isApiKeyOnlyHarnessType(value) {
    return API_KEY_ONLY_HARNESS_TYPES.has(String(value || "").trim());
  }

  function isNativeOAuthAgentType(value) {
    return ["codex", "agy"].includes(String(value || "").trim());
  }

  function visibleProviderAgentTypes() {
    // Harness-backed Provider types are intentionally unavailable until the
    // installation projection has loaded. The server remains the final
    // authority for the saved/global Provider list.
    return PROVIDER_AGENT_TYPES.filter(([value]) => !isHarnessType(value)
      || (harnessCatalogLoaded && globallyInstalledHarnessIds.has(value)));
  }

  async function loadHarnessProtocols({ refresh = false } = {}) {
    if (refresh) harnessProtocolsPromise = null;
    if (harnessProtocolsPromise) return harnessProtocolsPromise;
    harnessProtocolsPromise = request("/api/harnesses", { cache: "no-store" })
      .then((payload) => {
        const rows = Array.isArray(payload?.harnesses) ? payload.harnesses : [];
        globallyInstalledHarnessIds = new Set(rows
          .filter((harness) => harness?.globallyInstalled === true
            || (!Object.prototype.hasOwnProperty.call(harness || {}, "globallyInstalled")
              && (harness?.installed === true || harness?.available === true)))
          .map((harness) => String(harness?.id || "").trim())
          .filter(Boolean));
        harnessCatalogLoaded = true;
        for (const harness of rows) {
          const id = typeof harness?.id === "string" ? harness.id.trim() : "";
          if (!id || !Array.isArray(harness?.providerProtocols)) continue;
          const protocols = [...new Set(harness.providerProtocols.map(normalizeProtocol).filter(Boolean))];
          harnessProtocols.set(id, protocols);
        }
        return harnessProtocols;
      })
      .catch(() => harnessProtocols);
    return harnessProtocolsPromise;
  }

  function setStatus(message = "", tone = "") {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.hidden = !message;
    if (tone) statusElement.dataset.tone = tone;
    else delete statusElement.dataset.tone;
  }

  function appendText(parent, className, text) {
    const element = documentRef.createElement("span");
    if (className) element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function renderProviderCard(provider) {
    const card = documentRef.createElement("div");
    card.className = "model-provider-card";
    card.dataset.providerId = provider.id;
    const copy = documentRef.createElement("div");
    copy.className = "model-provider-card-copy";
    appendText(copy, "model-provider-card-title", provider.displayName || provider.id);
    const detail = [
      provider.agentType === "codex" ? "Codex" : provider.agentType === "claude" ? "Claude" : provider.agentType === "agy" ? "agy" : provider.agentType,
      provider.authType === "oauth" && provider.agentType === "claude" ? translate("modelProviders.claudeOAuthRemoved")
        : provider.authType === "oauth" ? translate("modelProviders.official")
        : provider.authType === "oauth-token" ? translate("modelProviders.setupToken")
          : translate("modelProviders.apiKey"),
    ];
    if (provider.baseUrl) detail.push(provider.baseUrl);
    if (provider.agentType === "codex" && provider.authType === "api-key") {
      detail.push(provider.protocol === "openai-chat"
        ? translate("modelProviders.upstreamChat")
        : translate("modelProviders.upstreamResponses"));
    }
    if (provider.agentType === "codex" && provider.modelCount > 0) {
      detail.push(translate("modelProviders.modelCount", { count: provider.modelCount }));
    }
    appendText(copy, "model-provider-card-detail", detail.join(" · "));
    const state = documentRef.createElement("span");
    state.className = `model-provider-card-state${provider.credentialOk ? " is-ready" : " is-error"}`;
    state.textContent = provider.migrationRequired === "claude-setup-token"
      ? translate("modelProviders.migrationRequired")
      : provider.credentialOk
        ? (provider.authType === "oauth" && provider.hasRefreshToken
          ? translate("modelProviders.refreshReady")
          : provider.authType === "oauth-token"
            ? translate("modelProviders.setupTokenReady")
            : translate("modelProviders.ready"))
      : translate("modelProviders.credentialMissing");
    copy.appendChild(state);
    const actions = documentRef.createElement("div");
    actions.className = "model-provider-card-actions";
    if (provider.agentType === "agy") {
      const rebindButton = documentRef.createElement("button");
      rebindButton.type = "button";
      rebindButton.className = "settings-row-button";
      rebindButton.textContent = translate("modelProviders.rebind");
      rebindButton.addEventListener("click", () => openModal(provider));
      actions.appendChild(rebindButton);
    } else {
      const editButton = documentRef.createElement("button");
      editButton.type = "button";
      editButton.className = "settings-row-button";
      editButton.textContent = translate("action.edit");
      editButton.addEventListener("click", () => openModal(provider));
      actions.appendChild(editButton);
      if (provider.authType === "oauth" && provider.agentType !== "claude") {
        const reloginButton = documentRef.createElement("button");
        reloginButton.type = "button";
        reloginButton.className = "settings-row-button";
        reloginButton.textContent = translate("modelProviders.relogin");
        reloginButton.addEventListener("click", () => openModal(provider, { relogin: true }));
        actions.appendChild(reloginButton);
      }
    }
    const deleteButton = documentRef.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "settings-row-button";
    deleteButton.textContent = translate("action.delete");
    deleteButton.addEventListener("click", () => void deleteProvider(provider));
    actions.appendChild(deleteButton);
    card.append(copy, actions);
    return card;
  }

  function renderProviders() {
    if (!listElement) return;
    listElement.innerHTML = "";
    const visibleProviders = harnessCatalogLoaded
      ? providers.filter((provider) => !isHarnessType(provider.agentType)
        || globallyInstalledHarnessIds.has(provider.agentType))
      : providers.filter((provider) => !isHarnessType(provider.agentType));
    if (!visibleProviders.length) {
      appendText(listElement, "model-providers-empty", translate("modelProviders.empty"));
      return;
    }
    for (const agentType of ["codex", "claude", "agy", "qwen-code", "opencode", "kimi-code", "goose", "pi", "deepseek-harness", "openhands", "copilot", "hermes", "cline", "kilo"]) {
      const rows = visibleProviders.filter((provider) => provider.agentType === agentType);
      if (!rows.length) continue;
      const group = documentRef.createElement("div");
      group.className = "model-provider-group";
      appendText(group, "model-provider-group-title", agentType === "codex" ? "Codex" : agentType === "claude" ? "Claude" : agentType === "agy" ? "agy" : agentType);
      const groupList = documentRef.createElement("div");
      groupList.className = "model-provider-group-list";
      rows.forEach((provider) => groupList.appendChild(renderProviderCard(provider)));
      group.appendChild(groupList);
      listElement.appendChild(group);
    }
  }

  async function refresh({ refreshHarnesses = false, forceFresh = false } = {}) {
    if (!canManage() || !listElement) return null;
    setStatus(translate("modelProviders.loading"));
    try {
      await loadHarnessProtocols({ refresh: refreshHarnesses });
      const requestOptions = forceFresh || refreshHarnesses
        ? { revalidate: false, cache: "no-store" }
        : { cacheMaxAgeMs: PROVIDER_LIST_CACHE_MAX_AGE_MS };
      const payload = await request("/api/native-providers", requestOptions);
      providers = Array.isArray(payload?.providers) ? payload.providers : [];
      renderProviders();
      setStatus("");
      return providers;
    } catch (error) {
      providers = [];
      renderProviders();
      setStatus(error?.message || translate("modelProviders.loadFailed"), "error");
      return null;
    }
  }

  function closeReservedLoginWindow() {
    try {
      if (oauthLoginWindow && !oauthLoginWindow.closed && oauthLoginWindow.location.href === "about:blank") oauthLoginWindow.close();
    } catch {}
  }

  function closeModal() {
    if (!modal) return;
    if (activeJobId) {
      void request(`/api/native-provider-oauth/jobs/${encodeURIComponent(activeJobId)}`, { method: "DELETE" }).catch(() => {});
      activeJobId = "";
    }
    if (pollTimer) globalScope.clearTimeout(pollTimer);
    pollTimer = null;
    oauthHandoffStarted = false;
    oauthHandoffMessage = "";
    if (oauthLoginWindow && !oauthLoginWindow.closed) {
      try { oauthLoginWindow.close(); } catch {}
    }
    oauthLoginWindow = null;
    agyCredentialInput = null;
    agyCredentialSubmitButton = null;
    const hadFocusScope = Boolean(modalFocusScopeDeactivate);
    modalFocusScopeDeactivate?.();
    modalFocusScopeDeactivate = null;
    modal.remove();
    modal = null;
    if (!hadFocusScope) modalTrigger?.focus?.({ preventScroll: true });
    modalTrigger = null;
  }

  function createField(parent, labelText, type = "text") {
    const field = documentRef.createElement("div");
    field.className = "provider-helper-field";
    const label = documentRef.createElement("label");
    label.textContent = labelText;
    const input = documentRef.createElement(type === "select" ? "select" : "input");
    if (type !== "select") input.type = type;
    input.id = `model-provider-field-${++fieldIdSequence}`;
    label.htmlFor = input.id;
    field.append(label, input);
    parent.appendChild(field);
    return input;
  }

  function ensureAgyCredentialPrompt(resultElement, submitButton) {
    if (agyCredentialInput && agyCredentialSubmitButton) return;
    const field = documentRef.createElement("div");
    field.className = "provider-helper-field model-provider-credential-field";
    const label = documentRef.createElement("label");
    label.textContent = translate("modelProviders.agyCredential");
    const input = documentRef.createElement("textarea");
    input.id = `model-provider-field-${++fieldIdSequence}`;
    label.htmlFor = input.id;
    input.rows = 4;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = translate("modelProviders.agyCredentialPlaceholder");
    const sendButton = documentRef.createElement("button");
    sendButton.type = "button";
    sendButton.className = "modal-btn primary";
    sendButton.textContent = translate("modelProviders.agyCredentialSubmit");
    sendButton.addEventListener("click", async () => {
      const credential = input.value.trim();
      if (!credential || !activeJobId) return;
      sendButton.disabled = true;
      input.disabled = true;
      try {
        await request(`/api/native-provider-oauth/jobs/${encodeURIComponent(activeJobId)}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential }),
        });
        submitButton.disabled = true;
        sendButton.textContent = translate("modelProviders.agyCredentialSent");
      } catch (error) {
        sendButton.disabled = false;
        input.disabled = false;
        sendButton.textContent = translate("modelProviders.agyCredentialSubmit");
        resultElement.dataset.tone = "error";
        resultElement.appendChild(documentRef.createTextNode(error?.message || translate("modelProviders.loginFailed")));
      }
    });
    field.append(label, input, sendButton);
    resultElement.appendChild(field);
    agyCredentialInput = input;
    agyCredentialSubmitButton = sendButton;
  }

  function showOfficialLoginResult(resultElement, job, submitButton) {
    const previousCredential = agyCredentialInput?.value || "";
    resultElement.innerHTML = "";
    agyCredentialInput = null;
    agyCredentialSubmitButton = null;
    if (job.url) {
      const link = documentRef.createElement("a");
      link.href = job.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = job.requiresInput ? "settings-row-button" : "";
      link.textContent = job.requiresInput
        ? translate("modelProviders.openLoginPage")
        : translate("modelProviders.openOfficialLogin");
      resultElement.appendChild(link);
    }
    if (job.code) {
      const deviceCode = documentRef.createElement("div");
      deviceCode.className = "model-provider-device-code";
      appendText(deviceCode, "model-provider-device-code-label", translate("modelProviders.deviceCode"));
      const code = documentRef.createElement("code");
      code.textContent = job.code;
      code.className = "model-provider-login-code";
      const copyButton = documentRef.createElement("button");
      copyButton.type = "button";
      copyButton.className = "settings-row-button";
      copyButton.textContent = translate("modelProviders.copyDeviceCode");
      copyButton.addEventListener("click", async () => {
        let copied = false;
        try { copied = await copyText(job.code); } catch {}
        copyButton.textContent = copied
          ? translate("modelProviders.deviceCodeCopied")
          : translate("modelProviders.copyDeviceCode");
      });
      deviceCode.append(code, copyButton);
      resultElement.appendChild(deviceCode);
    }
    const phaseKey = job.agentType === "codex"
      ? ({
        starting: "modelProviders.loginStarting",
        "generating-device-code": "modelProviders.loginGeneratingDeviceCode",
        "awaiting-device-auth": "modelProviders.loginWaitingForDeviceAuth",
        authenticating: "modelProviders.loginAuthenticating",
        finalizing: "modelProviders.loginFinalizing",
      }[job.phase] || "")
      : job.agentType === "claude"
        ? ({
          starting: "modelProviders.loginStarting",
          "awaiting-browser-auth": "modelProviders.loginWaitingForBrowserAuth",
          authenticating: "modelProviders.loginAuthenticating",
          finalizing: "modelProviders.loginFinalizing",
        }[job.phase] || "")
        : "";
    if (phaseKey && !["completed", "failed", "cancelled"].includes(job.state)) {
      appendText(resultElement, "model-provider-login-phase", translate(phaseKey));
    }
    if (job.requiresInput && !job.inputSubmitted) {
      ensureAgyCredentialPrompt(resultElement, submitButton);
      if (previousCredential && agyCredentialInput) agyCredentialInput.value = previousCredential;
    }
    if (oauthHandoffMessage) appendText(resultElement, "model-provider-login-handoff", oauthHandoffMessage);
  }

  function showOAuthFailure(resultElement, job) {
    const hintKey = ({
      "device-code": "modelProviders.loginFailureDeviceCode",
      "official-auth": "modelProviders.loginFailureOfficialAuth",
      cloudflare: "modelProviders.loginFailureCloudflare",
      spawn: "modelProviders.loginFailureStart",
      finalize: "modelProviders.loginFailureFinalize",
      timeout: "modelProviders.loginFailureTimeout",
      process: "modelProviders.loginFailureProcess",
    })[job.failureCode] || "modelProviders.loginFailed";
    resultElement.innerHTML = "";
    resultElement.dataset.tone = "error";
    appendText(resultElement, "model-provider-login-error", translate(hintKey));
    if (job.error) {
      const detail = documentRef.createElement("div");
      detail.className = "model-provider-login-error-detail";
      detail.textContent = job.error;
      resultElement.appendChild(detail);
    }
  }

  async function copyText(value, copyWindow = globalScope) {
    if (!value) return false;
    try {
      if (typeof globalScope.ragentDesktop?.writeText === "function") {
        if (await globalScope.ragentDesktop.writeText(value)) return true;
      }
    } catch {}
    if (copyWindow.navigator?.clipboard?.writeText) {
      let timer;
      try {
        // A permission prompt can leave writeText pending indefinitely. It must
        // not prevent navigation to the login page or the manual copy fallback.
        const copied = await Promise.race([
          copyWindow.navigator.clipboard.writeText(value).then(() => true),
          new Promise((resolve) => { timer = globalScope.setTimeout(() => resolve(false), 800); }),
        ]);
        if (copied) return true;
      } catch {} finally { globalScope.clearTimeout(timer); }
    }
    const copyDocument = copyWindow.document;
    const previousFocus = copyDocument.activeElement;
    const fallback = copyDocument.createElement("textarea");
    fallback.value = value;
    fallback.setAttribute("readonly", "true");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    copyDocument.body.appendChild(fallback);
    fallback.focus();
    fallback.select();
    let copied = false;
    try { copied = copyDocument.execCommand?.("copy") === true; } catch {}
    fallback.remove();
    previousFocus?.focus?.();
    return copied;
  }

  async function handoffToOfficialLogin(resultElement, job) {
    if (oauthHandoffStarted || !job?.url) return;
    oauthHandoffStarted = true;
    const jobId = activeJobId;
    let copied = false;
    if (job.code) {
      try {
        // The reserved login tab may hold browser focus. Clipboard writes from
        // the unfocused settings document are rejected by Chromium on Windows.
        const copyWindow = oauthLoginWindow && !oauthLoginWindow.closed && oauthLoginWindow.document.hasFocus()
          ? oauthLoginWindow : globalScope;
        copied = await copyText(job.code, copyWindow);
      } catch {}
    }
    if (activeJobId !== jobId) return;
    let opened = false;
    try {
      if (oauthLoginWindow && !oauthLoginWindow.closed) {
        oauthLoginWindow.opener = null;
        oauthLoginWindow.location.href = job.url;
        opened = true;
      } else {
        oauthLoginWindow = globalScope.open?.(job.url, "_blank");
        if (oauthLoginWindow) {
          oauthLoginWindow.opener = null;
          opened = true;
        }
      }
    } catch {}
    resultElement.dataset.tone = opened && (copied || !job.code) ? "success" : "error";
    oauthHandoffMessage = !opened
      ? translate("modelProviders.loginOpenBlocked")
      : job.requiresInput ? translate("modelProviders.agyLoginReady")
        : translate(copied ? "modelProviders.loginRedirecting" : "modelProviders.loginCopyFailed");
    appendText(resultElement, "model-provider-login-handoff", oauthHandoffMessage);
  }

  async function pollOAuthJob(resultElement, submitButton) {
    if (!activeJobId) return;
    const jobId = activeJobId;
    try {
      const payload = await request(`/api/native-provider-oauth/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      if (activeJobId !== jobId || !modal) return;
      const job = payload?.job || {};
      showOfficialLoginResult(resultElement, job, submitButton);
      const readyForHandoff = Boolean(job.url)
        && !["completed", "finalizing", "failed", "cancelled"].includes(job.state)
        && (job.requiresInput || (job.agentType !== "codex" || Boolean(job.code)));
      if (readyForHandoff && !oauthHandoffStarted) {
        void handoffToOfficialLogin(resultElement, job);
      }
      if (job.state === "completed") {
        activeJobId = "";
        oauthHandoffStarted = false;
        submitButton.disabled = false;
        resultElement.dataset.tone = "success";
        resultElement.appendChild(documentRef.createTextNode(translate("modelProviders.loginCompleted")));
        await refresh({ forceFresh: true });
        closeModal();
        setStatus(translate("modelProviders.loginCompleted"), "success");
        return;
      }
      if (job.state === "failed" || job.state === "cancelled") {
        closeReservedLoginWindow();
        activeJobId = "";
        oauthHandoffStarted = false;
        submitButton.disabled = false;
        if (job.state === "failed") showOAuthFailure(resultElement, job);
        else {
          resultElement.dataset.tone = "error";
          resultElement.textContent = translate("modelProviders.loginFailed");
        }
        return;
      }
      submitButton.disabled = true;
      pollTimer = globalScope.setTimeout(() => void pollOAuthJob(resultElement, submitButton), 1200);
    } catch (error) {
      if (activeJobId !== jobId || !modal) return;
      closeReservedLoginWindow();
      activeJobId = "";
      oauthHandoffStarted = false;
      submitButton.disabled = false;
      resultElement.dataset.tone = "error";
      resultElement.textContent = error?.message || translate("modelProviders.loginFailed");
    }
  }

  function openModal(existingProvider = null, { relogin = false } = {}) {
    if (modal) return;
    modalTrigger = documentRef.activeElement;
    const isAgyRelink = existingProvider?.agentType === "agy";
    const isEditing = Boolean(existingProvider?.id) && !isAgyRelink;
    const isLegacyClaudeOAuth = isEditing
      && existingProvider?.agentType === "claude"
      && existingProvider?.authType === "oauth";
    let reloginMode = Boolean(relogin && isEditing && existingProvider?.authType === "oauth"
      && existingProvider?.agentType !== "claude");
    const backdrop = documentRef.createElement("div");
    backdrop.className = "modal-backdrop is-open";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    const dialog = documentRef.createElement("div");
    dialog.className = "modal model-provider-modal";
    const header = documentRef.createElement("div");
    header.className = "modal-header";
    const titleElement = appendText(header, "modal-title", translate(isAgyRelink ? "modelProviders.rebindTitle" : reloginMode ? "modelProviders.reloginTitle" : isLegacyClaudeOAuth ? "modelProviders.claudeMigrationTitle" : isEditing ? "modelProviders.editTitle" : "modelProviders.addTitle"));
    titleElement.id = `model-provider-title-${++fieldIdSequence}`;
    backdrop.setAttribute("aria-labelledby", titleElement.id);
    const closeButton = documentRef.createElement("button");
    closeButton.type = "button";
    closeButton.className = "modal-close";
    closeButton.setAttribute("aria-label", translate("action.close"));
    closeButton.textContent = "×";
    closeButton.addEventListener("click", closeModal);
    header.appendChild(closeButton);
    const body = documentRef.createElement("div");
    body.className = "modal-body";
    const lead = documentRef.createElement("p");
    lead.className = "modal-lead";
    lead.textContent = translate(isAgyRelink ? "modelProviders.rebindLead" : reloginMode ? "modelProviders.reloginLead" : isLegacyClaudeOAuth ? "modelProviders.claudeMigrationLead" : isEditing ? "modelProviders.editLead" : "modelProviders.addLead");
    body.appendChild(lead);
    const grid = documentRef.createElement("div");
    grid.className = "provider-helper-grid";
    const agentSelect = createField(grid, translate("modelProviders.agentType"), "select");
    visibleProviderAgentTypes().forEach(([value, label]) => {
      const option = documentRef.createElement("option");
      option.value = value;
      option.textContent = label;
      agentSelect.appendChild(option);
    });
    agentSelect.value = existingProvider?.agentType || "codex";
    agentSelect.disabled = isEditing || isAgyRelink;
    const nameInput = createField(grid, translate("modelProviders.displayName"));
    nameInput.placeholder = translate("modelProviders.displayNamePlaceholder");
    nameInput.value = existingProvider?.displayName || "";
    const modeSelect = createField(grid, translate("modelProviders.authMode"), "select");
    const officialOAuthOption = documentRef.createElement("option");
    officialOAuthOption.value = "oauth";
    officialOAuthOption.textContent = translate("modelProviders.officialOAuth");
    modeSelect.appendChild(officialOAuthOption);
    const setupTokenOption = documentRef.createElement("option");
    setupTokenOption.value = "oauth-token";
    setupTokenOption.textContent = translate("modelProviders.setupToken");
    modeSelect.appendChild(setupTokenOption);
    const apiKeyOption = documentRef.createElement("option");
    apiKeyOption.value = "api-key";
    apiKeyOption.textContent = translate("modelProviders.apiKey");
    modeSelect.appendChild(apiKeyOption);
    const initialMode = existingProvider?.authType === "oauth-token"
      || isLegacyClaudeOAuth
      ? "oauth-token"
      : existingProvider?.authType === "oauth"
        || isAgyRelink
        || (!isEditing && isNativeOAuthAgentType(agentSelect.value))
        ? "oauth"
        : "api-key";
    modeSelect.value = initialMode;
    modeSelect.disabled = (isEditing && !isLegacyClaudeOAuth) || isAgyRelink;
    const protocolSelect = createField(grid, translate("modelProviders.protocol"), "select");
    [["responses", translate("modelProviders.responses")], ["chat", translate("modelProviders.chat")], ["anthropic", "Anthropic Messages"], ["github-copilot", "GitHub Copilot"]].forEach(([value, label]) => {
      const option = documentRef.createElement("option");
      option.value = value;
      option.textContent = label;
      protocolSelect.appendChild(option);
    });
    protocolSelect.value = existingProvider?.protocol === "github-copilot" ? "github-copilot"
      : existingProvider?.protocol === "openai-chat" ? "chat"
      : existingProvider?.protocol === "anthropic-messages" ? "anthropic" : "responses";
    const protocolNote = documentRef.createElement("p");
    protocolNote.className = "provider-helper-note";
    protocolNote.hidden = true;
    protocolNote.textContent = translate("modelProviders.chatWarning");
    const baseUrlInput = createField(grid, translate("modelProviders.baseUrl"));
    const protocolHint = documentRef.createElement("p");
    protocolHint.className = "provider-helper-note model-provider-protocol-hint";
    protocolHint.id = `model-provider-protocol-hint-${++fieldIdSequence}`;
    protocolHint.setAttribute("aria-live", "polite");
    protocolHint.hidden = true;
    baseUrlInput.parentElement.appendChild(protocolHint);
    baseUrlInput.setAttribute("aria-describedby", protocolHint.id);
    const apiKeyInput = createField(grid, translate("modelProviders.apiKey"), "password");
    const apiKeyLabel = apiKeyInput.parentElement?.querySelector("label");
    if (isEditing && existingProvider?.authType === "api-key") {
      apiKeyInput.placeholder = translate("modelProviders.apiKeyKeepCurrent");
    }
    const modelInput = createField(grid, translate("modelProviders.defaultModel"));
    baseUrlInput.value = existingProvider?.baseUrl || "";
    let baseUrlEditedByUser = false;
    baseUrlInput.addEventListener("input", () => { baseUrlEditedByUser = true; });
    modelInput.value = existingProvider?.modelPolicy?.defaultModel || "";
    body.appendChild(grid);
    body.appendChild(protocolNote);
    const resultElement = documentRef.createElement("div");
    resultElement.className = "provider-helper-status model-provider-login-result";
    body.appendChild(resultElement);
    const footer = documentRef.createElement("div");
    footer.className = "modal-footer";
    const cancelButton = documentRef.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "modal-btn";
    cancelButton.textContent = translate("action.cancel");
    cancelButton.addEventListener("click", closeModal);
    const submitButton = documentRef.createElement("button");
    submitButton.type = "button";
    submitButton.className = "modal-btn primary";
    submitButton.textContent = translate("modelProviders.save");
    footer.append(cancelButton, submitButton);
    const reloginButton = documentRef.createElement("button");
    reloginButton.type = "button";
    reloginButton.className = "modal-btn";
    reloginButton.textContent = translate("modelProviders.relogin");
    reloginButton.hidden = !(isEditing && existingProvider?.authType === "oauth" && existingProvider?.agentType !== "claude");
    reloginButton.addEventListener("click", () => {
      reloginMode = true;
      resultElement.textContent = "";
      syncMode();
    });
    footer.insertBefore(reloginButton, submitButton);
    dialog.append(header, body, footer);
    backdrop.appendChild(dialog);
    documentRef.body.appendChild(backdrop);
    modal = backdrop;
    modalFocusScopeDeactivate = globalScope.RagentFocusScope?.activate?.(backdrop, {
      containmentRoot: documentRef.body,
      initialFocus: closeButton,
      restoreFocus: () => modalTrigger,
      modal: true,
      onEscape: closeModal,
    }) || null;

    const syncMode = () => {
      const isAgy = agentSelect.value === "agy";
      if (!isEditing && agentSelect.value === "copilot") protocolSelect.value = "github-copilot";
      if (agentSelect.value !== "copilot" && protocolSelect.value === "github-copilot") protocolSelect.value = "responses";
      const isCopilotGithub = agentSelect.value === "copilot" && protocolSelect.value === "github-copilot";
      if (isAgy) modeSelect.value = "oauth";
      if (agentSelect.value === "claude" && modeSelect.value === "oauth") modeSelect.value = "oauth-token";
      if (agentSelect.value !== "claude" && modeSelect.value === "oauth-token") {
        modeSelect.value = isNativeOAuthAgentType(agentSelect.value) ? "oauth" : "api-key";
      }
      if (isApiKeyOnlyHarnessType(agentSelect.value)) modeSelect.value = "api-key";
      officialOAuthOption.hidden = agentSelect.value === "claude";
      setupTokenOption.hidden = agentSelect.value !== "claude";
      const isSetupToken = modeSelect.value === "oauth-token";
      const isOAuth = modeSelect.value === "oauth" || isSetupToken || isAgy;
      if (apiKeyLabel) apiKeyLabel.textContent = isSetupToken
        ? translate("modelProviders.setupToken")
        : translate("modelProviders.apiKey");
      apiKeyInput.placeholder = isSetupToken
        ? translate("modelProviders.setupTokenPlaceholder")
        : (isEditing && existingProvider?.authType === "api-key"
          ? translate("modelProviders.apiKeyKeepCurrent")
          : "");
      titleElement.textContent = translate(isAgyRelink ? "modelProviders.rebindTitle" : reloginMode ? "modelProviders.reloginTitle" : isLegacyClaudeOAuth ? "modelProviders.claudeMigrationTitle" : isEditing ? "modelProviders.editTitle" : "modelProviders.addTitle");
      lead.textContent = translate(isAgyRelink ? "modelProviders.rebindLead" : reloginMode ? "modelProviders.reloginLead" : isLegacyClaudeOAuth ? "modelProviders.claudeMigrationLead" : isEditing ? "modelProviders.editLead" : "modelProviders.addLead");
      modeSelect.parentElement.hidden = isAgy;
      modeSelect.disabled = (isEditing && !isLegacyClaudeOAuth) || isAgyRelink || isAgy;
      const showCodexProtocol = (agentSelect.value === "codex" || isHarnessType(agentSelect.value)) && !isOAuth;
      protocolSelect.parentElement.hidden = !showCodexProtocol;
      protocolNote.hidden = !showCodexProtocol || protocolSelect.value !== "chat";
      baseUrlInput.parentElement.hidden = isOAuth || isCopilotGithub;
      apiKeyInput.parentElement.hidden = modeSelect.value !== "api-key" && !isSetupToken;
      modelInput.parentElement.hidden = modeSelect.value === "oauth" || isAgy;
      const supportedProtocols = getSupportedProtocols(agentSelect.value)
        .map(formatProtocol)
        .filter(Boolean);
      protocolHint.hidden = isOAuth || agentSelect.value === "agy";
      protocolHint.textContent = supportedProtocols.length
        ? translate("modelProviders.supportedProtocols", { protocols: supportedProtocols.join(" · ") })
        : translate("modelProviders.protocolsUnavailable");
      // A new, untouched field follows the selected Agent's default. Once the
      // user edits it (including clearing it), form refreshes must keep it.
      // Existing Providers always retain their saved address.
      if (!existingProvider?.id && !baseUrlEditedByUser) {
        baseUrlInput.value = agentSelect.value === "copilot" ? "" : agentSelect.value === "claude" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
      }
      reloginButton.hidden = !(isEditing && existingProvider?.authType === "oauth" && existingProvider?.agentType !== "claude") || reloginMode;
      submitButton.textContent = modeSelect.value === "oauth" && (!isEditing || reloginMode || isAgyRelink)
        ? (isAgyRelink ? translate("modelProviders.rebind") : reloginMode ? translate("modelProviders.relogin") : translate("modelProviders.startLogin"))
        : translate(isEditing ? "modelProviders.update" : "modelProviders.save");
    };
    modeSelect.addEventListener("change", syncMode);
    agentSelect.addEventListener("change", () => {
      if (!isEditing && agentSelect.value === "claude") modeSelect.value = "oauth-token";
      else if (!isEditing && isNativeOAuthAgentType(agentSelect.value)) modeSelect.value = "oauth";
      syncMode();
    });
    protocolSelect.addEventListener("change", syncMode);
    syncMode();
    void loadHarnessProtocols().then(() => {
      if (modal === backdrop) syncMode();
    });
    submitButton.addEventListener("click", async () => {
      if (activeJobId || oauthHandoffStarted) return;
      submitButton.disabled = true;
      resultElement.textContent = translate("modelProviders.saving");
      try {
        if (isEditing && !reloginMode) {
          const isSetupToken = modeSelect.value === "oauth-token";
          await request(`/api/native-providers/${encodeURIComponent(existingProvider.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              displayName: nameInput.value,
              ...(modeSelect.value === "api-key" ? {
                baseUrl: baseUrlInput.value,
                apiKey: apiKeyInput.value,
                ...(agentSelect.value === "codex" || isHarnessType(agentSelect.value) ? { protocol: protocolSelect.value } : {}),
                defaultModel: modelInput.value,
              } : isSetupToken ? {
                oauthToken: apiKeyInput.value,
                defaultModel: modelInput.value,
              } : {}),
            }),
          });
          await refresh({ forceFresh: true });
          closeModal();
          return;
        }
        if (modeSelect.value === "oauth") {
          oauthHandoffMessage = "";
          const isAgy = agentSelect.value === "agy";
          if (isAgy && isAgyRelink) {
            const confirmed = globalScope.confirm?.(translate("modelProviders.rebindConfirm")) === true;
            if (!confirmed) {
              submitButton.disabled = false;
              resultElement.textContent = "";
              return;
            }
          }
          try { oauthLoginWindow = globalScope.open?.("about:blank", "_blank"); } catch { oauthLoginWindow = null; }
          const payload = await request("/api/native-provider-oauth/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentType: agentSelect.value,
              displayName: nameInput.value,
              ...(isAgy ? {
                providerId: isAgyRelink ? existingProvider?.id : undefined,
                replaceExisting: isAgyRelink,
              } : reloginMode ? {
                providerId: existingProvider.id,
                replaceExisting: true,
              } : {}),
            }),
          });
          activeJobId = payload?.job?.id || "";
          if (!activeJobId) throw new Error(translate("modelProviders.loginFailed"));
          resultElement.textContent = translate("modelProviders.loginWaiting");
          void pollOAuthJob(resultElement, submitButton);
          return;
        }
        if (modeSelect.value === "oauth-token") {
          await request("/api/native-providers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentType: "claude",
              authType: "oauth-token",
              displayName: nameInput.value,
              oauthToken: apiKeyInput.value,
              defaultModel: modelInput.value,
            }),
          });
          await refresh({ forceFresh: true });
          closeModal();
          return;
        }
        await request("/api/native-providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentType: agentSelect.value,
            displayName: nameInput.value,
            baseUrl: baseUrlInput.value,
            apiKey: apiKeyInput.value,
            ...(agentSelect.value === "codex" || isHarnessType(agentSelect.value) ? { protocol: protocolSelect.value } : {}),
            defaultModel: modelInput.value,
          }),
        });
        await refresh({ forceFresh: true });
        closeModal();
      } catch (error) {
        closeReservedLoginWindow();
        submitButton.disabled = false;
        resultElement.dataset.tone = "error";
        resultElement.textContent = error?.message || translate("modelProviders.saveFailed");
      }
    });
  }

  async function deleteProvider(provider) {
    if (!globalScope.confirm?.(translate("modelProviders.deleteConfirm", { name: provider.displayName || provider.id }))) return;
    try {
      await request(`/api/native-providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      await refresh({ forceFresh: true });
    } catch (error) {
      setStatus(error?.message || translate("modelProviders.deleteFailed"), "error");
    }
  }

  function openPage(event) {
    event?.preventDefault?.();
    if (typeof globalScope.ragentOpenSidebarSubpage === "function") {
      globalScope.ragentOpenSidebarSubpage("model-providers", openButton);
    } else if (typeof globalScope.switchTab === "function") {
      globalScope.switchTab("model-providers");
    }
    void loadHarnessProtocols();
    void refresh();
  }

  if (!panel || !openButton || !addButton || !listElement) return;
  syncSettingsEntryVisibility();
  if (canManage()) void loadHarnessProtocols();
  openButton.addEventListener("click", openPage);
  addButton.addEventListener("click", openModal);
  globalScope.addEventListener("ragent:localechange", () => {
    renderProviders();
  });
  globalScope.RagentModelProviders = { open: openPage, refresh, closeModal };
})(window);
