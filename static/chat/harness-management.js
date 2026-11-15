(function attachHarnessManagement(globalScope) {
  "use strict";

  const documentRef = globalScope.document;
  const settingsSection = documentRef?.getElementById("modelProvidersSettingsSection") || null;
  const panel = documentRef?.getElementById("harnessesPanel") || null;
  const settingsOpenButton = documentRef?.getElementById("harnessesOpenBtn") || null;
  const providersOpenButton = documentRef?.getElementById("modelProvidersHarnessesBtn") || null;
  const refreshButton = documentRef?.getElementById("harnessesRefreshBtn") || null;
  const listElement = documentRef?.getElementById("harnessesList") || null;
  const statusElement = documentRef?.getElementById("harnessesStatus") || null;
  let harnesses = [];
  let refreshPromise = null;

  function translate(key, vars = {}) {
    return typeof globalScope.ragentT === "function" ? globalScope.ragentT(key, vars) : key;
  }

  function canManage() {
    return globalScope.__RAGENT_BOOTSTRAP__?.auth?.role === "owner";
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
      const error = new Error(payload?.error || translate("harnesses.actionFailed"));
      error.status = response.status;
      error.code = payload?.code || "";
      throw error;
    }
    return payload;
  }

  function setStatus(message = "", tone = "") {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.hidden = !message;
    if (tone) statusElement.dataset.tone = tone;
    else delete statusElement.dataset.tone;
  }

  function isInstalled(harness) {
    return harness?.installed === true || harness?.available === true;
  }

  function harnessName(harness) {
    return harness?.name || harness?.id || "Harness";
  }

  function createText(parent, className, value) {
    const element = documentRef.createElement("span");
    element.className = className;
    element.textContent = value;
    parent.appendChild(element);
    return element;
  }

  function renderHarness(harness) {
    const installed = isInstalled(harness);
    const card = documentRef.createElement("div");
    card.className = "harness-card";
    card.dataset.harnessId = harness.id || "";

    const copy = documentRef.createElement("div");
    copy.className = "harness-card-copy";
    createText(copy, "harness-card-title", harnessName(harness));
    const detail = [];
    const detectedVersion = String(harness?.detectedVersion || "").trim();
    const targetVersion = String(harness?.targetVersion || harness?.harnessVersion || harness?.version || "").trim();
    const targetIsLatest = targetVersion.toLowerCase() === "latest";
    if (detectedVersion) detail.push(translate("harnesses.detectedVersion", { version: detectedVersion }));
    if (targetVersion) detail.push(targetIsLatest
      ? translate("harnesses.targetChannelLatest")
      : translate("harnesses.targetVersion", { version: targetVersion }));
    if (!harness?.supportedOnPlatform) {
      detail.push(translate("harnesses.unsupported"));
    } else if (installed) {
      detail.push(harness.installationSource === "bundled"
        ? translate("harnesses.bundled") : translate("harnesses.installed"));
      if (harness.upgradeAction === "manual"
        && ["incompatible", "unknown", "unverified"].includes(harness.compatibilityStatus)) {
        detail.push(translate("harnesses.manualUpdateRequired"));
      }
    } else if (harness.commandAvailable) {
      detail.push(translate("harnesses.manualCleanup"));
    } else {
      detail.push(translate("harnesses.notInstalled"));
    }
    createText(copy, "harness-card-detail", detail.join(" · "));

    const actions = documentRef.createElement("div");
    actions.className = "harness-card-actions";
    const addAction = (operation, labelKey, className = "", confirmationKey = "") => {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = `settings-row-button ${className}`.trim();
      button.textContent = translate(labelKey);
      button.disabled = !harness.supportedOnPlatform;
      button.addEventListener("click", () => void mutateHarness(harness, operation, button, confirmationKey));
      actions.appendChild(button);
    };
    if (installed) {
      const packageManaged = harness?.upgradeAction === "package-managed";
      if (harness?.upgradeAction !== "manual" && !packageManaged) {
        addAction(
          "upgrade",
          "harnesses.upgrade",
          "",
          "harnesses.upgradeConfirm",
        );
      }
      if (!packageManaged) addAction("uninstall", "harnesses.uninstall");
    } else {
      addAction("install", "harnesses.install", "settings-row-button-primary");
    }
    let stateKey = installed ? "harnesses.installed" : "harnesses.notInstalled";
    let stateClass = installed ? " is-ready" : "";
    if (harness?.compatibilityStatus === "compatible") stateKey = "harnesses.compatible";
    if (harness?.compatibilityStatus === "incompatible") {
      stateKey = "harnesses.incompatible";
      stateClass = " is-warning";
    }
    if (harness?.compatibilityStatus === "unknown" || harness?.compatibilityStatus === "unverified") {
      stateKey = "harnesses.versionUnknown";
      stateClass = " is-warning";
    }
    copy.appendChild(createText(copy, `harness-card-state${stateClass}`, translate(stateKey, {
      version: detectedVersion || translate("harnesses.unknownVersion"),
      targetVersion,
    })));
    card.append(copy, actions);
    return card;
  }

  function render() {
    if (!listElement) return;
    listElement.innerHTML = "";
    if (!harnesses.length) {
      createText(listElement, "harnesses-empty", translate("harnesses.notInstalled"));
      return;
    }
    for (const harness of harnesses) listElement.appendChild(renderHarness(harness));
  }

  async function refresh({ quiet = false, force = false } = {}) {
    if (!canManage() || !listElement) return [];
    if (refreshPromise) return refreshPromise;
    if (!quiet) setStatus(translate("harnesses.loading"));
    const refreshPath = force ? "/api/harnesses?refresh=1" : "/api/harnesses";
    refreshPromise = request(refreshPath, { cache: "no-store" })
      .then((payload) => {
        harnesses = Array.isArray(payload?.harnesses) ? payload.harnesses : [];
        render();
        setStatus("");
        return harnesses;
      })
      .catch((error) => {
        harnesses = [];
        render();
        setStatus(error?.message || translate("harnesses.loadFailed"), "error");
        return [];
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  }

  async function mutateHarness(harness, operation, button, confirmationKey = "") {
    const name = harnessName(harness);
    const confirmed = typeof globalScope.confirm !== "function"
      || globalScope.confirm(translate(confirmationKey || `harnesses.${operation}Confirm`, { name }));
    if (!confirmed) return;
    button.disabled = true;
    setStatus(translate("harnesses.loading"));
    try {
      const payload = operation === "upgrade" ? { version: harness.harnessVersion || harness.version || "" } : {};
      const response = await request(`/api/harnesses/${encodeURIComponent(harness.id)}/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const nextHarness = response?.harness || harness;
      globalScope.dispatchEvent(new CustomEvent("ragent:harnesschange", {
        detail: { harness: nextHarness, operation },
      }));
      if (typeof globalScope.ragentRefreshRuntimeCatalog === "function") {
        await globalScope.ragentRefreshRuntimeCatalog({
          harnessId: harness.id,
          clearCurrentSelection: operation === "uninstall",
        });
      }
      await globalScope.RagentModelProviders?.refresh?.({ refreshHarnesses: true });
      await refresh({ quiet: true });
      setStatus(translate(nextHarness.cleanupPending ? "harnesses.cleanupPending" : "harnesses.actionCompleted"), "success");
    } catch (error) {
      setStatus(error?.code === "HARNESS_IN_USE" ? translate("harnesses.inUse", { name }) : error?.message || translate("harnesses.actionFailed"), "error");
      button.disabled = false;
    }
  }

  function openPage(event, sourceButton) {
    event?.preventDefault?.();
    if (typeof globalScope.ragentOpenSidebarSubpage === "function") {
      globalScope.ragentOpenSidebarSubpage("harnesses", sourceButton || settingsOpenButton);
    } else if (typeof globalScope.switchTab === "function") {
      globalScope.switchTab("harnesses");
    }
    void refresh();
  }

  if (!panel || !listElement) return;
  if (settingsSection && canManage()) settingsSection.hidden = false;
  settingsOpenButton?.addEventListener("click", (event) => openPage(event, settingsOpenButton));
  providersOpenButton?.addEventListener("click", (event) => openPage(event, providersOpenButton));
  refreshButton?.addEventListener("click", () => void refresh({ force: true }));
  globalScope.addEventListener("ragent:localechange", render);
  if (canManage()) void refresh({ quiet: true });
  globalScope.RagentHarnesses = Object.freeze({ open: openPage, refresh, list: () => [...harnesses] });
})(window);
