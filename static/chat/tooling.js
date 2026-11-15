// ---- Thinking toggle / effort select ----
function t(key, vars) {
  return window.ragentT ? window.ragentT(key, vars) : key;
}

let runtimeSelectionSyncPromise = Promise.resolve();
let sessionToolPreferencesPersistPromise = Promise.resolve();
let lastSyncedRuntimeSelectionPayload = '';
let selectedModelIsInherited = false;
let currentToolCatalogState = {
  status: 'unavailable',
  modelCount: 0,
  providerProfileId: '',
  hasError: false,
};
const HIDDEN_INLINE_AGENT_IDS = new Set([
  "email",
]);
let inlineAgentCatalog = [];
let inlineAgentCatalogLoaded = false;

const UNKNOWN_RUNTIME_EFFORT_DEFAULTS = Object.freeze({
  codex: Object.freeze(['low', 'medium', 'high', 'xhigh']),
  claude: Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']),
});

function canChangeRuntimeSelectionFromUi() {
  return typeof canChangeRuntimeSelection === "function"
    ? canChangeRuntimeSelection()
    : !visitorMode;
}

function canSwitchAgentsFromUi() {
  return typeof canSwitchAgents === "function"
    ? canSwitchAgents()
    : !visitorMode;
}

function canPublishShareSnapshotsFromUi() {
  return typeof canPublishShareSnapshots === "function"
    ? canPublishShareSnapshots()
    : !visitorMode;
}

function canForkSessionsFromUi() {
  return typeof canForkSessions === "function"
    ? canForkSessions()
    : !visitorMode;
}

function canManageAgentsFromUi() {
  return typeof canManageAgents === "function"
    ? canManageAgents()
    : !visitorMode;
}

function buildRuntimeSelectionPayload() {
  if (!canChangeRuntimeSelectionFromUi() || !selectedTool) return null;
  return {
    selectedTool,
    selectedModel: selectedModel || '',
    selectedProviderProfile: typeof getComposerRuntimeSelectedProvider === 'function' ? (getComposerRuntimeSelectedProvider() || '') : '',
    selectedEffort: currentToolReasoningKind === 'enum' ? (selectedEffort || '') : '',
    selectedServiceTier: typeof selectedServiceTier === 'string' ? selectedServiceTier : 'standard',
    thinkingEnabled: currentToolReasoningKind === 'toggle' ? thinkingEnabled === true : false,
    reasoningKind: currentToolReasoningKind || 'none',
  };
}

function queueRuntimeSelectionSync() {
  // The durable UI runtime selection is the default for sessions created in
  // the future. An attached session owns its runtime preferences in session
  // metadata, so opening or editing that session must not rewrite the global
  // default used by other sessions and external connectors.
  if (typeof currentSessionId === "string" && currentSessionId) return;
  const payload = buildRuntimeSelectionPayload();
  if (!payload) return;
  const serialized = JSON.stringify(payload);
  if (serialized === lastSyncedRuntimeSelectionPayload) {
    return;
  }
  lastSyncedRuntimeSelectionPayload = serialized;
  runtimeSelectionSyncPromise = runtimeSelectionSyncPromise
    .catch(() => {})
    .then(async () => {
      try {
        await fetchJsonOrRedirect('/api/runtime-selection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: serialized,
        });
      } catch (error) {
        lastSyncedRuntimeSelectionPayload = '';
        console.warn('[runtime-selection] Failed to sync current selection:', error.message);
      }
    });
}

function waitForPendingRuntimeSelectionSync() {
  return runtimeSelectionSyncPromise.catch(() => {});
}

function waitForPendingSessionToolPreferencesPersist() {
  return sessionToolPreferencesPersistPromise;
}

function markCurrentSessionRuntimePreferencesEdited(sessionId = currentSessionId) {
  if (!sessionId) return;
  try {
    localStorage.setItem(`runtimePrefsEditedAt_${sessionId}`, Date.now().toString());
  } catch {}
}

function cloneReasoningState(reasoning, fallbackLabel = t("tooling.thinking")) {
  if (!reasoning || typeof reasoning !== "object") return null;
  const kind = String(reasoning.kind || "").trim().toLowerCase();
  const label = String(reasoning.label || fallbackLabel).trim() || fallbackLabel;
  if (kind === "enum") {
    const levels = [...new Set(
      (Array.isArray(reasoning.levels) ? reasoning.levels : [])
        .map((level) => String(level || "").trim())
        .filter(Boolean),
    )];
    if (levels.length === 0) return null;
    const defaultValue = String(
      reasoning.default || reasoning.defaultReasoning || reasoning.defaultEffort || levels[0],
    ).trim();
    return {
      kind,
      label,
      levels,
      default: levels.includes(defaultValue) ? defaultValue : levels[0],
    };
  }
  if (kind === "toggle" || kind === "none") {
    return { kind, label };
  }
  return null;
}

function findCurrentToolModelRecord(modelId = selectedModel) {
  if (!Array.isArray(currentToolModels) || currentToolModels.length === 0) return null;
  if (modelId) {
    const matched = currentToolModels.find((model) => model.id === modelId);
    if (matched) return matched;
  }
  return currentToolModels[0] || null;
}

function resolveActiveReasoningState(modelId = selectedModel) {
  const fallbackReasoning =
    cloneReasoningState(currentToolBaseReasoning)
    || { kind: "none", label: t("tooling.thinking") };
  const modelData = findCurrentToolModelRecord(modelId);
  const modelEffortSupport = modelData?.capabilities?.effort?.supported;
  const modelReasoning = cloneReasoningState(modelData?.reasoning, fallbackReasoning.label);
  if (modelData && modelEffortSupport === false) {
    return {
      modelData,
      reasoning: { kind: "none", label: fallbackReasoning.label },
    };
  }
  if (modelData && (modelEffortSupport === null || typeof modelEffortSupport === "undefined")) {
    // A live upstream catalog may know that the model exists without declaring
    // its effort contract. Keep an explicit model declaration, otherwise use
    // the built-in defaults for the selected Codex or Claude runtime.
    if (modelReasoning) return { modelData, reasoning: modelReasoning };
    const definition = getSelectedToolDefinition(selectedTool);
    const family = String(definition?.runtimeFamily || "").trim();
    const isClaude = selectedTool === "claude"
      || selectedTool === "claude-bidi"
      || family.startsWith("claude-");
    const isCodex = selectedTool === "codex"
      || selectedTool === "codex-cli"
      || family.startsWith("codex-");
    const levels = UNKNOWN_RUNTIME_EFFORT_DEFAULTS[isClaude ? "claude" : isCodex ? "codex" : ""];
    if (levels) {
      return {
        modelData,
        reasoning: {
          kind: "enum",
          label: fallbackReasoning.label,
          levels: [...levels],
          default: "medium",
        },
      };
    }
  }
  return {
    modelData,
    reasoning: modelReasoning || fallbackReasoning,
  };
}

function resolveActiveServiceTiers(modelId = selectedModel) {
  const tiers = findCurrentToolModelRecord(modelId)?.serviceTiers;
  if (!Array.isArray(tiers)) return ['standard'];
  const normalized = [...new Set(tiers.map((tier) => String(tier || '').trim().toLowerCase()))]
    .filter((tier) => tier === 'standard' || tier === 'fast');
  return normalized.includes('standard') ? normalized : ['standard'];
}

function serviceTierLabel(value) {
  return value === 'fast' ? t('tooling.serviceTierFast') : t('tooling.serviceTierStandard');
}

function syncComposerRuntimeSpeedIcon() {
  const iconHost = typeof composerRuntimeSpeedIcon !== "undefined"
    ? composerRuntimeSpeedIcon
    : document.getElementById("composerRuntimeSpeedIcon");
  const needle = iconHost?.querySelector?.(".gauge-needle");
  const activeArc = iconHost?.querySelector?.(".gauge-active");
  if (!needle) return;

  const levels = Array.isArray(currentToolEffortLevels) ? currentToolEffortLevels : [];
  const effortIndex = levels.indexOf(selectedEffort);
  let ratio = 0.5;
  if (levels.length > 1 && effortIndex >= 0) {
    ratio = effortIndex / (levels.length - 1);
  } else if (levels.length === 0 && Array.isArray(currentToolServiceTiers)) {
    // A service-tier-only runtime still gets a meaningful gauge position.
    ratio = currentToolServiceTiers.includes("fast") && selectedServiceTier === "fast" ? 1 : 0;
  }
  const normalizedRatio = Math.max(0, Math.min(1, ratio));
  // Match Android's 240° sweep: low starts at the lower-left and high ends
  // at the lower-right, with the needle rotating around the shared hub.
  const angle = 240 + (normalizedRatio * 240);
  if (activeArc) {
    const activeSweep = Math.max(3 / 240, normalizedRatio);
    activeArc.setAttribute("stroke-dasharray", `${activeSweep} 1`);
  }
  const previousAngle = Number(needle.dataset.angle);
  // CSS transforms honor the view-box origin consistently for SVG paths;
  // mixing the SVG transform attribute with transform-origin hides the
  // zero-width needle at non-zero angles in Chromium.
  needle.style.transform = `rotate(${angle}deg)`;
  needle.dataset.angle = String(angle);
  if (
    Number.isFinite(previousAngle)
    && previousAngle !== angle
    && typeof needle.animate === "function"
  ) {
    needle.animate(
      [
        { transform: `rotate(${previousAngle}deg)` },
        { transform: `rotate(${angle}deg)` },
      ],
      {
        duration: 180,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    );
  }
  iconHost.dataset.effortRatio = normalizedRatio.toFixed(3);
}

function syncComposerRuntimeEffortUi() {
  syncComposerRuntimeSpeedIcon();
  if (
    typeof composerRuntimeEffortRange === "undefined"
    || !composerRuntimeEffortRange
    || typeof composerRuntimeSpeedPanel === "undefined"
    || !composerRuntimeSpeedPanel
  ) {
    return;
  }
  const levels = Array.isArray(currentToolEffortLevels) ? currentToolEffortLevels : [];
  const effortIndex = Math.max(0, levels.indexOf(selectedEffort));
  composerRuntimeEffortRange.disabled = currentToolReasoningKind !== "enum" || levels.length === 0;
  composerRuntimeEffortRange.max = String(Math.max(0, levels.length - 1));
  composerRuntimeEffortRange.value = String(effortIndex);
  composerRuntimeEffortRange.setAttribute(
    "aria-valuetext",
    levels[effortIndex] || t("tooling.thinking"),
  );
  if (typeof composerRuntimeEffortValue !== "undefined" && composerRuntimeEffortValue) {
    const nextLabel = levels[effortIndex] || t("tooling.thinking");
    if (composerRuntimeEffortValue.textContent !== nextLabel) {
      composerRuntimeEffortValue.textContent = nextLabel;
      composerRuntimeEffortValue.classList?.remove?.("is-switching");
      void composerRuntimeEffortValue.offsetWidth;
      composerRuntimeEffortValue.classList?.add?.("is-switching");
    }
  }
}

function syncComposerRuntimeSpeedUi(canUseRuntimeMenu = null) {
  if (
    typeof composerRuntimeSpeedBtn === "undefined"
    || !composerRuntimeSpeedBtn
    || typeof composerRuntimeSpeedPanel === "undefined"
    || !composerRuntimeSpeedPanel
  ) {
    return;
  }
  const tiers = Array.isArray(currentToolServiceTiers) ? currentToolServiceTiers : ["standard"];
  const levels = Array.isArray(currentToolEffortLevels) ? currentToolEffortLevels : [];
  const hasSpeedChoice = tiers.length > 1;
  const hasEffortChoice = currentToolReasoningKind === "enum" && levels.length > 0;
  const canUse = canUseRuntimeMenu === null
    ? canChangeRuntimeSelectionFromUi()
    : canUseRuntimeMenu;
  const enabled = canUse && !!selectedTool;
  const speedToggle = typeof composerRuntimeSpeedToggle !== "undefined"
    ? composerRuntimeSpeedToggle
    : null;
  if (!enabled && typeof composerRuntimeSpeedPanelOpen !== "undefined") {
    composerRuntimeSpeedPanelOpen = false;
  }
  composerRuntimeSpeedBtn.hidden = !enabled;
  composerRuntimeSpeedBtn.disabled = !enabled;
  const selectedLabel = serviceTierLabel(selectedServiceTier);
  composerRuntimeSpeedBtn.title = `${t("tooling.serviceTierTitle")}: ${selectedLabel}`;
  composerRuntimeSpeedBtn.setAttribute(
    "aria-label",
    `${t("tooling.serviceTierAriaLabel")}: ${selectedLabel}`,
  );
  if (typeof composerRuntimeSpeedSelect !== "undefined" && composerRuntimeSpeedSelect) {
    composerRuntimeSpeedSelect.innerHTML = "";
    for (const tier of tiers) {
      const option = document.createElement("option");
      option.value = tier;
      option.textContent = serviceTierLabel(tier);
      composerRuntimeSpeedSelect.appendChild(option);
    }
    composerRuntimeSpeedSelect.value = selectedServiceTier;
    composerRuntimeSpeedSelect.disabled = !hasSpeedChoice;
    const speedSelectWrap = composerRuntimeSpeedSelect.parentElement;
    if (speedSelectWrap) speedSelectWrap.hidden = !enabled || !hasSpeedChoice;
  }
  if (speedToggle) {
    const isFast = selectedServiceTier === "fast" && hasSpeedChoice;
    const nextTier = isFast ? "standard" : "fast";
    const nextLabel = serviceTierLabel(nextTier);
    speedToggle.hidden = !enabled || !hasSpeedChoice;
    speedToggle.disabled = !enabled || !hasSpeedChoice;
    speedToggle.setAttribute("aria-pressed", isFast ? "true" : "false");
    speedToggle.setAttribute(
      "aria-label",
      `${serviceTierLabel(selectedServiceTier)}. ${t("tooling.serviceTierSwitchTo")} ${nextLabel}`,
    );
    speedToggle.title = `${serviceTierLabel(selectedServiceTier)}. ${t("tooling.serviceTierSwitchTo")} ${nextLabel}`;
    speedToggle.classList.toggle("is-fast", isFast);
  }
  syncComposerRuntimeEffortUi();
  const panelOpen = enabled
    && typeof composerRuntimeSpeedPanelOpen !== "undefined"
    && composerRuntimeSpeedPanelOpen === true;
  composerRuntimeSpeedBtn.setAttribute("aria-expanded", panelOpen ? "true" : "false");
  composerRuntimeSpeedPanel.hidden = !panelOpen;
  composerRuntimeSpeedPanel.classList.toggle("has-speed-choice", hasSpeedChoice);
  composerRuntimeSpeedPanel.classList.toggle("has-effort-range", hasEffortChoice);
  window.RagentComposerMenuPortal?.sync(
    composerRuntimeSpeedPanel,
    composerRuntimeSpeedBtn,
    panelOpen,
    { align: "center" },
  );
}

function setSelectedServiceTier(value, { persist = true } = {}) {
  const tiers = Array.isArray(currentToolServiceTiers) ? currentToolServiceTiers : ["standard"];
  const requested = value === "fast" ? "fast" : "standard";
  const nextTier = tiers.includes(requested)
    ? requested
    : (tiers.includes("standard") ? "standard" : (tiers[0] || "standard"));
  selectedServiceTier = nextTier;
  if (serviceTierSelect && serviceTierSelect.value !== nextTier) {
    serviceTierSelect.value = nextTier;
    syncCustomSelectBridge(serviceTierSelect);
  }
  syncComposerRuntimeSpeedUi();
  if (!persist) return;
  if (selectedTool) localStorage.setItem(`selectedServiceTier_${selectedTool}`, selectedServiceTier);
  markCurrentSessionRuntimePreferencesEdited();
  syncComposerModeUi();
  queueRuntimeSelectionSync();
  persistCurrentSessionToolPreferences();
}

function setSelectedEffort(value, { persist = true, sync = true } = {}) {
  const levels = Array.isArray(currentToolEffortLevels) ? currentToolEffortLevels : [];
  if (!levels.includes(value)) return;
  selectedEffort = value;
  setNativeSelectValue(effortSelect, selectedEffort);
  if (sync) syncComposerRuntimeSpeedUi();
  else syncComposerRuntimeEffortUi();
  if (!persist) return;
  if (selectedTool) localStorage.setItem(`selectedEffort_${selectedTool}`, selectedEffort);
  markCurrentSessionRuntimePreferencesEdited();
  syncComposerModeUi();
  queueRuntimeSelectionSync();
  persistCurrentSessionToolPreferences();
}

function applyCurrentModelReasoningUi({ sessionPreferences = null, preserveCurrentSelection = false } = {}) {
  const { modelData, reasoning } = resolveActiveReasoningState();
  currentToolServiceTiers = resolveActiveServiceTiers();
  const storedServiceTier = selectedTool
    ? (localStorage.getItem(`selectedServiceTier_${selectedTool}`) || '')
    : '';
  const preferredServiceTier = sessionPreferences?.hasServiceTier
    ? sessionPreferences.serviceTier
    : preserveCurrentSelection
      ? (selectedServiceTier || storedServiceTier)
      : storedServiceTier;
  selectedServiceTier = currentToolServiceTiers.includes(preferredServiceTier)
    ? preferredServiceTier
    : 'standard';
  if (serviceTierSelect) {
    serviceTierSelect.innerHTML = '';
    for (const tier of currentToolServiceTiers) {
      const option = document.createElement('option');
      option.value = tier;
      option.textContent = serviceTierLabel(tier);
      serviceTierSelect.appendChild(option);
    }
    serviceTierSelect.value = selectedServiceTier;
    serviceTierSelect.disabled = currentToolServiceTiers.length < 2;
    serviceTierSelect.style.display = currentToolServiceTiers.length > 1 ? '' : 'none';
    syncCustomSelectBridge(serviceTierSelect);
  }
  currentToolReasoningKind = reasoning.kind || "none";
  currentToolReasoningLabel = reasoning.label || t("tooling.thinking");
  currentToolReasoningDefault =
    currentToolReasoningKind === "enum"
      ? (reasoning.default || null)
      : null;
  currentToolEffortLevels =
    currentToolReasoningKind === "enum"
      ? reasoning.levels || []
      : null;
  thinkingToggle.textContent = currentToolReasoningLabel;

  if (currentToolReasoningKind === "enum") {
    thinkingToggle.style.display = "none";
    // Effort is controlled exclusively by the speed panel. Keep the native
    // select as the state bridge for persistence and submission, but never
    // expose it in the model/runtime selection sheet.
    effortSelect.style.display = "none";
    effortSelect.innerHTML = "";
    for (const level of currentToolEffortLevels) {
      const opt = document.createElement("option");
      opt.value = level;
      opt.textContent = level;
      effortSelect.appendChild(opt);
    }

    const storedEffort = selectedTool
      ? (localStorage.getItem(`selectedEffort_${selectedTool}`) || "")
      : "";
    const preferredEffort = sessionPreferences?.hasEffort
      ? sessionPreferences.effort
      : preserveCurrentSelection
        ? (selectedEffort || storedEffort)
        : storedEffort;
    const modelDefaultEffort = modelData?.defaultEffort || modelData?.defaultReasoning || "";

    if (preferredEffort && currentToolEffortLevels.includes(preferredEffort)) {
      effortSelect.value = preferredEffort;
      selectedEffort = preferredEffort;
    } else if (modelDefaultEffort && currentToolEffortLevels.includes(modelDefaultEffort)) {
      effortSelect.value = modelDefaultEffort;
      selectedEffort = modelDefaultEffort;
    } else if (
      currentToolReasoningDefault
      && currentToolEffortLevels.includes(currentToolReasoningDefault)
    ) {
      effortSelect.value = currentToolReasoningDefault;
      selectedEffort = currentToolReasoningDefault;
    } else if (currentToolEffortLevels[0]) {
      effortSelect.value = currentToolEffortLevels[0];
      selectedEffort = currentToolEffortLevels[0];
    } else {
      selectedEffort = "";
    }
    syncCustomSelectBridge(effortSelect);
    syncComposerRuntimeSpeedUi();
    return;
  }

  selectedEffort = null;
  effortSelect.style.display = "none";
  syncCustomSelectBridge(effortSelect);
  if (serviceTierSelect) {
    serviceTierSelect.disabled = true;
    serviceTierSelect.style.display = 'none';
    syncCustomSelectBridge(serviceTierSelect);
  }

  if (currentToolReasoningKind === "toggle") {
    thinkingToggle.style.display = "";
    if (sessionPreferences?.hasThinking) {
      thinkingEnabled = sessionPreferences.thinking;
    }
    updateThinkingUI();
    syncComposerRuntimeSpeedUi();
    return;
  }

  thinkingToggle.style.display = "none";
  syncComposerRuntimeSpeedUi();
}

function updateThinkingUI() {
  thinkingToggle.classList.toggle("active", thinkingEnabled);
}
updateThinkingUI();

function isComposerPlanMode() {
  return typeof inlineAgentSelect !== "undefined"
    && inlineAgentSelect
    && inlineAgentSelect.value === "__plan";
}

function canToggleComposerPlanMode() {
  if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) return false;
  if (typeof visitorMode !== "undefined" && visitorMode) return false;
  return typeof canSwitchAgentsFromUi === "function" ? canSwitchAgentsFromUi() : true;
}

function ensureComposerPlanOption() {
  if (!inlineAgentSelect) return;
  const options = Array.from(inlineAgentSelect.options || []);
  if (options.some((option) => option.value === "__plan")) return;
  const option = document.createElement("option");
  option.value = "__plan";
  option.textContent = t("compose.agent.mode.plan");
  inlineAgentSelect.appendChild(option);
}

function getSelectDisplayLabel(selectEl, fallback = "") {
  if (!selectEl) return fallback;
  const selectedOption = selectEl.options && selectEl.selectedIndex >= 0
    ? selectEl.options[selectEl.selectedIndex]
    : null;
  const label = selectedOption?.textContent || selectedOption?.label || "";
  return String(label || fallback || "").trim();
}

function getVisibleContextSummary() {
  if (typeof contextTokens === "undefined" || !contextTokens) return "";
  if (contextTokens.style?.display === "none") return "";
  return String(contextTokens.textContent || "")
    .replace(/\s+·\s+.*$/, "")
    .trim();
}

let composerRuntimeMenuOpen = false;
let composerRuntimeMenuView = "tools";
let composerRuntimeTransitionDirection = "none";
let composerRuntimeProviderLoadGeneration = 0;
let composerRuntimeSpeedPanelOpen = false;
let composerPermissionMenuOpen = false;
// Android back button entries for the mutually exclusive composer menus.
let composerRuntimeMenuBackEntryId = null;
let composerPermissionMenuBackEntryId = null;
let addToolModalBackEntryId = null;
let addToolModalFocusScopeDeactivate = null;
let addToolModalTrigger = null;

function normalizeComposerRuntimeMenuView(view) {
  return ["tools", "providers", "models", "permissions"].includes(view) ? view : "tools";
}

function setComposerRuntimeView(view, direction = "none") {
  const nextView = normalizeComposerRuntimeMenuView(view);
  composerRuntimeTransitionDirection = nextView === composerRuntimeMenuView ? "none" : direction;
  composerRuntimeMenuView = nextView;
}

function getRuntimeAddMoreValue() {
  return typeof ADD_MORE_TOOL_VALUE !== "undefined" ? ADD_MORE_TOOL_VALUE : "__add_more__";
}

function syncCustomSelectBridge(selectEl) {
  if (!selectEl) return;
  try {
    const cs = window.getCustomSelect ? window.getCustomSelect(selectEl) : null;
    if (cs && typeof cs._syncFromNative === "function") cs._syncFromNative();
  } catch {
    // Native selects remain the source of truth if the styled wrapper is unavailable.
  }
}

function setNativeSelectValue(selectEl, value) {
  if (!selectEl) return false;
  const nextValue = String(value ?? "");
  let matched = false;
  const options = Array.from(selectEl.options || []);
  for (let index = 0; index < options.length; index += 1) {
    if (String(options[index].value ?? "") === nextValue) {
      selectEl.selectedIndex = index;
      matched = true;
      break;
    }
  }
  selectEl.value = nextValue;
  syncCustomSelectBridge(selectEl);
  return matched || options.length === 0;
}

function dispatchNativeChange(selectEl) {
  if (!selectEl || typeof selectEl.dispatchEvent !== "function") return;
  selectEl.dispatchEvent(new Event("change", { bubbles: true }));
}

function getComposerRuntimeModelLabel() {
  const modelLabel = getSelectDisplayLabel(
    typeof inlineModelSelect !== "undefined" ? inlineModelSelect : null,
    "",
  );
  return modelLabel || t("tooling.defaultModel");
}

function getComposerRuntimeReasoningLabel() {
  if (typeof currentToolReasoningKind === "undefined") return "";
  // Enum effort is represented by the speed gauge now, not by the model
  // selection row or its summary text.
  if (currentToolReasoningKind === "enum") return "";
  if (currentToolReasoningKind === "toggle" && thinkingEnabled) {
    return currentToolReasoningLabel || t("tooling.thinking");
  }
  return "";
}

function getComposerRuntimeButtonLabel() {
  const modelLabel = getComposerRuntimeModelLabel();
  if (modelLabel) return modelLabel;
  return getSelectDisplayLabel(
    typeof inlineToolSelect !== "undefined" ? inlineToolSelect : null,
    t("tooling.defaultModel"),
  );
}

function getComposerRuntimeToolOptions() {
  const addMoreValue = getRuntimeAddMoreValue();
  const options = Array.from(inlineToolSelect?.options || [])
    .map((option) => ({
      value: String(option.value || ""),
      label: String(option.textContent || option.label || option.value || "").trim(),
      disabled: option.disabled === true,
    }))
    .filter((option) => option.value && option.value !== addMoreValue && option.label);

  if (options.length > 0) return options;

  return (Array.isArray(toolsList) ? toolsList : [])
    .filter((tool) => tool?.id)
    .map((tool) => ({
      value: tool.id,
      label: tool.name || tool.id,
      disabled: false,
    }));
}

function getComposerRuntimeModelOptions() {
  const options = Array.from(inlineModelSelect?.options || [])
    .map((option) => ({
      value: String(option.value || ""),
      label: String(option.textContent || option.label || option.value || "").trim(),
      disabled: option.disabled === true || inlineModelSelect?.disabled === true,
    }))
    .filter((option) => option.label);
  if (options.length > 0) return options;
  return [{ value: "", label: t("tooling.defaultModel"), disabled: false }];
}

function getComposerRuntimeModelStatusElement() {
  if (typeof composerRuntimeModelStatus !== "undefined" && composerRuntimeModelStatus) {
    return composerRuntimeModelStatus;
  }
  return typeof document !== "undefined" && typeof document.getElementById === "function"
    ? document.getElementById("composerRuntimeModelStatus")
    : null;
}

function normalizeComposerRuntimeModelCatalogState(data, providerProfileId = "") {
  const requestedProvider = String(providerProfileId || "").trim();
  const catalogs = Array.isArray(data?.catalogs) ? data.catalogs : [];
  const directCatalog = data?.catalog && typeof data.catalog === "object" ? data.catalog : null;
  const catalog = requestedProvider
    ? catalogs.find((entry) => String(entry?.providerProfileId || "").trim() === requestedProvider)
      || (String(directCatalog?.providerProfileId || "").trim() === requestedProvider ? directCatalog : null)
    : directCatalog || (catalogs.length === 1 ? catalogs[0] : null);
  const responseModels = Array.isArray(data?.models) ? data.models : [];
  const modelCount = Array.isArray(catalog?.models)
    ? catalog.models.length
    : requestedProvider
      ? responseModels.filter((entry) => {
        const explicitProvider = String(entry?.providerProfileId || "").trim();
        if (explicitProvider) return explicitProvider === requestedProvider;
        const rawId = String(entry?.id || "").trim();
        const at = rawId.lastIndexOf("@");
        return at > 0
          && at < rawId.length - 1
          && /^[A-Za-z0-9._-]+$/.test(rawId.slice(at + 1))
          && rawId.slice(at + 1) === requestedProvider;
      }).length
      : responseModels.length;
  const rawStatus = String(catalog?.status || "").trim().toLowerCase();
  const status = ["fresh", "stale", "unavailable"].includes(rawStatus)
    ? rawStatus
    : modelCount > 0 ? "fresh" : "unavailable";
  return {
    status,
    modelCount,
    providerProfileId: String(catalog?.providerProfileId || requestedProvider || "").trim(),
    source: String(catalog?.source || "").trim(),
    catalogVersion: String(catalog?.catalogVersion || "").trim(),
    hasError: !!catalog?.error,
  };
}

function getComposerRuntimeModelCatalogDisplayState() {
  const state = typeof currentToolCatalogState !== "undefined" && currentToolCatalogState
    ? currentToolCatalogState
    : { status: "unavailable", modelCount: 0, hasError: false };
  if (state.status === "loading") return "loading";
  if (state.status === "unavailable" && state.hasError) return "error";
  if (Number(state.modelCount) <= 0) return state.status === "unavailable" ? "unavailable" : "empty";
  return state.status;
}

function getComposerRuntimeModelCatalogStatusMessage() {
  switch (getComposerRuntimeModelCatalogDisplayState()) {
    case "loading": return t("compose.catalog.loading");
    case "stale": return t("compose.catalog.stale");
    case "empty": return t("compose.catalog.empty");
    case "error": return t("compose.catalog.error");
    case "unavailable": return t("compose.catalog.unavailable");
    default: return "";
  }
}

function renderComposerRuntimeModelStatus() {
  const statusElement = getComposerRuntimeModelStatusElement();
  if (!statusElement) return;
  const displayState = getComposerRuntimeModelCatalogDisplayState();
  const message = getComposerRuntimeModelCatalogStatusMessage();
  statusElement.textContent = message;
  statusElement.hidden = !message;
  statusElement.dataset.state = displayState;
}

function setCurrentToolCatalogState(state = {}) {
  currentToolCatalogState = {
    status: String(state.status || "unavailable"),
    modelCount: Number.isFinite(Number(state.modelCount)) ? Number(state.modelCount) : 0,
    providerProfileId: String(state.providerProfileId || "").trim(),
    source: String(state.source || "").trim(),
    catalogVersion: String(state.catalogVersion || "").trim(),
    hasError: state.hasError === true,
  };
  if (typeof renderComposerRuntimeModelStatus === "function") {
    renderComposerRuntimeModelStatus();
  }
  if (typeof renderComposerRuntimeModelOptions === "function") {
    renderComposerRuntimeModelOptions();
  }
}

function normalizePermissionModeId(value) {
  return String(value || "").trim();
}

function getPermissionModeI18nKey(modeId) {
  switch (normalizePermissionModeId(modeId)) {
    case "read-only":
      return "compose.permission.mode.readOnly";
    case "full-access":
      return "compose.permission.mode.fullAccess";
    case "default":
      return "compose.permission.mode.claudeDefault";
    case "skip-permissions":
      return "compose.permission.mode.skipPermissions";
    default:
      return "";
  }
}

function getPermissionModeDisplayLabel(mode) {
  const modeId = normalizePermissionModeId(mode?.id);
  const key = getPermissionModeI18nKey(modeId);
  if (key) {
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return String(mode?.label || modeId || t("compose.permission.default")).trim();
}

function getSelectedToolProviderCapabilities(toolId = selectedTool) {
  const tool = getSelectedToolDefinition(toolId);
  return tool?.providerCapabilities && typeof tool.providerCapabilities === "object"
    ? tool.providerCapabilities
    : null;
}

function getComposerPermissionModes(toolId = selectedTool) {
  const capabilities = getSelectedToolProviderCapabilities(toolId);
  if (!Array.isArray(capabilities?.permissionModes)) return [];
  return capabilities.permissionModes
    .map((mode) => {
      const id = normalizePermissionModeId(mode?.id);
      if (!id) return null;
      return {
        ...mode,
        id,
        label: getPermissionModeDisplayLabel(mode),
      };
    })
    .filter(Boolean);
}

function getComposerDefaultPermissionMode(toolId = selectedTool) {
  const modes = getComposerPermissionModes(toolId);
  if (modes.length === 0) return "";
  const capabilities = getSelectedToolProviderCapabilities(toolId);
  const defaultMode = normalizePermissionModeId(capabilities?.defaultPermissionMode);
  if (defaultMode && modes.some((mode) => mode.id === defaultMode)) {
    return defaultMode;
  }
  return modes[0]?.id || "";
}

function getComposerEffectivePermissionMode(toolId = selectedTool) {
  const tool = getSelectedToolDefinition(toolId);
  const capabilities = getSelectedToolProviderCapabilities(toolId);
  const modes = getComposerPermissionModes(toolId);
  const runtimeFamily = capabilities?.runtimeFamily || tool?.runtimeFamily || "";
  const isClaudePlanMode = runtimeFamily === "claude-stream-json-bidi"
    && typeof isComposerPlanMode === "function"
    && isComposerPlanMode();
  if (isClaudePlanMode) {
    const planMode = modes.find((mode) => mode.id === "plan");
    if (planMode) return planMode.id;
  }
  return getComposerDefaultPermissionMode(toolId);
}

function canUseComposerPermissionControls() {
  return false;
}

function resolveComposerPermissionMode(toolId = selectedTool, preferredMode = "") {
  const modes = getComposerPermissionModes(toolId);
  if (modes.length === 0) return "";
  const candidates = [
    preferredMode,
    selectedPermissionMode,
    getComposerDefaultPermissionMode(toolId),
  ];
  for (const candidate of candidates) {
    const normalized = normalizePermissionModeId(candidate);
    if (normalized && modes.some((mode) => mode.id === normalized)) {
      return normalized;
    }
  }
  return modes[0]?.id || "";
}

function applyCurrentToolPermissionModeUi({
  sessionPreferences = null,
} = {}) {
  const nextMode = getComposerEffectivePermissionMode(selectedTool);
  selectedPermissionMode = nextMode || null;
  syncComposerPermissionUi();
  return nextMode;
}

function getComposerPermissionButtonLabel() {
  const modes = getComposerPermissionModes();
  if (modes.length === 0) return "";
  const modeId = getComposerEffectivePermissionMode(selectedTool)
    || resolveComposerPermissionMode(selectedTool, selectedPermissionMode);
  const mode = modes.find((entry) => entry.id === modeId) || modes[0];
  return mode ? getPermissionModeDisplayLabel(mode) : "";
}

function scrollActiveComposerRuntimeOptionIntoView(element) {
  if (!element || typeof element.scrollIntoView !== "function") return;
  const raf = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame
    : (typeof requestAnimationFrame === "function" ? requestAnimationFrame : null);
  if (raf) {
    raf(() => {
      try {
        element.scrollIntoView({ block: "nearest" });
      } catch {}
    });
  }
}

function renderComposerPermissionOptionList(container) {
  if (!container) return;
  container.innerHTML = "";
  const modeId = resolveComposerPermissionMode(selectedTool, selectedPermissionMode);
  let activeElement = null;
  for (const mode of getComposerPermissionModes()) {
    const isActive = mode.id === modeId;
    const el = createComposerRuntimeOption({
      label: getPermissionModeDisplayLabel(mode),
      active: isActive,
      disabled: mode.disabled === true,
      onClick: () => {
        setComposerPermissionMode(mode.id);
      },
    });
    if (isActive) {
      activeElement = el;
    }
    container.appendChild(el);
  }
  if (typeof scrollActiveComposerRuntimeOptionIntoView === "function") {
    scrollActiveComposerRuntimeOptionIntoView(activeElement);
  }
}

function renderComposerPermissionOptions() {
  renderComposerPermissionOptionList(
    typeof composerPermissionOptions !== "undefined" ? composerPermissionOptions : null,
  );
}

function renderComposerRuntimePermissionOptions() {
  renderComposerPermissionOptionList(
    typeof composerRuntimePermissionOptions !== "undefined" ? composerRuntimePermissionOptions : null,
  );
}

function syncComposerPermissionUi() {
  const hasPermissionButton =
    typeof composerPermissionBtn !== "undefined"
    && composerPermissionBtn
    && typeof composerPermissionMenu !== "undefined"
    && composerPermissionMenu;
  const hasRuntimePermissionButton =
    typeof composerRuntimePermissionBtn !== "undefined"
    && composerRuntimePermissionBtn;
  if (!hasPermissionButton && !hasRuntimePermissionButton) {
    return;
  }

  const canUsePermissionMenu = canUseComposerPermissionControls();
  if (!canUsePermissionMenu) {
    composerPermissionMenuOpen = false;
    selectedPermissionMode = getComposerEffectivePermissionMode(selectedTool) || null;
  } else {
    selectedPermissionMode = resolveComposerPermissionMode(selectedTool, selectedPermissionMode) || null;
  }

  const permissionLabel = getComposerPermissionButtonLabel() || t("compose.permission.default");
  if (hasPermissionButton) {
    composerPermissionBtn.hidden = !canUsePermissionMenu;
    composerPermissionBtn.disabled = !canUsePermissionMenu;
    composerPermissionBtn.setAttribute("aria-expanded", composerPermissionMenuOpen ? "true" : "false");
  }
  if (composerPermissionLabel) {
    composerPermissionLabel.textContent = permissionLabel;
  }
  if (hasRuntimePermissionButton) {
    const runtimePermissionActive = composerRuntimeMenuOpen
      && normalizeComposerRuntimeMenuView(composerRuntimeMenuView) === "permissions";
    composerRuntimePermissionBtn.hidden = !canUsePermissionMenu;
    composerRuntimePermissionBtn.disabled = !canUsePermissionMenu;
    composerRuntimePermissionBtn.setAttribute("aria-expanded", runtimePermissionActive ? "true" : "false");
  }
  if (typeof composerRuntimePermissionLabel !== "undefined" && composerRuntimePermissionLabel) {
    composerRuntimePermissionLabel.textContent = permissionLabel;
  }
  if (hasPermissionButton) {
    window.RagentComposerMenuPortal?.sync(
      composerPermissionMenu,
      composerPermissionBtn,
      composerPermissionMenuOpen,
      { align: "right" },
    );
    if (window.RagentMotion?.setPresence) {
      window.RagentMotion.setPresence(composerPermissionMenu, composerPermissionMenuOpen, {
        duration: 160,
      });
    } else {
      composerPermissionMenu.hidden = !composerPermissionMenuOpen;
      composerPermissionMenu.classList.toggle("is-open", composerPermissionMenuOpen);
    }
  }
  if (canUsePermissionMenu) {
    renderComposerPermissionOptions();
    renderComposerRuntimePermissionOptions();
  } else {
    if (composerPermissionOptions) composerPermissionOptions.innerHTML = "";
    if (composerRuntimePermissionOptions) composerRuntimePermissionOptions.innerHTML = "";
    if (composerPermissionMenu) composerPermissionMenu.hidden = true;
    if (composerRuntimePermissionOptions) composerRuntimePermissionOptions.hidden = true;
  }
}

function createComposerRuntimeOption({
  label,
  note = "",
  active = false,
  disabled = false,
  trailing = "",
  onClick = null,
} = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "composer-runtime-option";
  button.setAttribute("role", "menuitemradio");
  button.setAttribute("aria-checked", active ? "true" : "false");
  button.classList.toggle("active", !!active);
  button.disabled = !!disabled;

  const labelNode = document.createElement("span");
  labelNode.className = "composer-runtime-option-label";
  labelNode.textContent = label || "";
  button.appendChild(labelNode);

  if (note) {
    const noteNode = document.createElement("span");
    noteNode.className = "composer-runtime-option-note";
    noteNode.textContent = note;
    button.appendChild(noteNode);
  }

  if (trailing === "chevron-right") {
    const chevronNode = document.createElement("span");
    chevronNode.className = "composer-runtime-option-chevron composer-runtime-option-chevron--right";
    chevronNode.setAttribute("aria-hidden", "true");
    button.appendChild(chevronNode);
  }

  if (typeof onClick === "function") {
    button.addEventListener("click", onClick);
  }
  return button;
}

function renderComposerRuntimeToolOptions() {
  if (!composerRuntimeToolOptions) return;
  composerRuntimeToolOptions.innerHTML = "";
  const options = getComposerRuntimeToolOptions();
  let activeElement = null;
  for (const option of options) {
    const isActive = option.value === inlineToolSelect?.value;
    const el = createComposerRuntimeOption({
      label: option.label,
      active: isActive,
      disabled: option.disabled,
      trailing: "chevron-right",
      onClick: () => {
        void selectComposerRuntimeTool(option.value);
      },
    });
    if (isActive) {
      activeElement = el;
    }
    composerRuntimeToolOptions.appendChild(el);
  }
  if (typeof scrollActiveComposerRuntimeOptionIntoView === "function") {
    scrollActiveComposerRuntimeOptionIntoView(activeElement);
  }
}

function renderComposerRuntimeModelOptions() {
  if (!composerRuntimeModelOptions) return;
  composerRuntimeModelOptions.innerHTML = "";
  const options = getComposerRuntimeModelOptions();
  let activeElement = null;
  for (const option of options) {
    const isActive = option.value === inlineModelSelect?.value;
    const el = createComposerRuntimeOption({
      label: option.label,
      active: isActive,
      disabled: option.disabled,
      onClick: () => {
        setComposerRuntimeModel(option.value);
      },
    });
    if (isActive) {
      activeElement = el;
    }
    composerRuntimeModelOptions.appendChild(el);
  }
  if (typeof scrollActiveComposerRuntimeOptionIntoView === "function") {
    scrollActiveComposerRuntimeOptionIntoView(activeElement);
  }
}

function refreshComposerRuntimeModelOptions() {
  // The native select remains the source of truth, but the runtime menu has
  // its own option list and must be refreshed after async model discovery.
  renderComposerRuntimeModelOptions();
}

function getComposerRuntimeProviderApp(toolId = selectedTool) {
  const definition = getSelectedToolDefinition(toolId);
  const family = String(definition?.runtimeFamily || "").trim();
  if (toolId === "claude" || toolId === "claude-bidi" || family.startsWith("claude-")) {
    return "claude";
  }
  if (toolId === "codex" || toolId === "codex-cli" || family.startsWith("codex-")) {
    return "codex";
  }
  // AgY provider profiles are separate auth identities (multi-account); the
  // runtime menu needs the same tool -> account -> model depth as codex/claude.
  if (toolId === "agy" || family.startsWith("agy-")) {
    return "agy";
  }
  return "";
}

function getComposerRuntimeSessionId() {
  if (typeof currentSessionId === "string" && currentSessionId) return currentSessionId;
  if (typeof getCurrentSession === "function") return String(getCurrentSession()?.id || "").trim();
  return "";
}

function getComposerRuntimeSelectedProvider(toolId = selectedTool) {
  const sessionPreferences = getAttachedSessionToolPreferences(toolId);
  if (sessionPreferences?.providerProfile) return sessionPreferences.providerProfile;
  if (typeof getCurrentSession === "function") {
    return String(getCurrentSession()?.providerProfile || "").trim();
  }
  return "";
}

function setComposerRuntimeProviderStatus(message = "", tone = "") {
  if (!composerRuntimeProviderStatus) return;
  composerRuntimeProviderStatus.textContent = message;
  if (tone) composerRuntimeProviderStatus.dataset.tone = tone;
  else delete composerRuntimeProviderStatus.dataset.tone;
}

function renderComposerRuntimeProviderMessage(message) {
  if (!composerRuntimeProviderOptions) return;
  composerRuntimeProviderOptions.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "composer-runtime-empty";
  empty.textContent = message;
  composerRuntimeProviderOptions.appendChild(empty);
}

function renderComposerRuntimeProviderOptions(profiles = []) {
  if (!composerRuntimeProviderOptions) return;
  composerRuntimeProviderOptions.innerHTML = "";
  const selectedProvider = getComposerRuntimeSelectedProvider();
  if (profiles.length === 0) {
    renderComposerRuntimeProviderMessage(t("compose.provider.unavailable"));
    return;
  }
  let activeElement = null;
  for (const profile of profiles) {
    const id = String(profile?.id || profile?.name || "").trim();
    if (!id) continue;
    const selected = id === selectedProvider;
    const el = createComposerRuntimeOption({
      label: profile.displayName || profile.label || id,
      note: selected
        ? t("compose.provider.current")
        : [profile.model, profile.baseUrl].filter(Boolean).join(" · "),
      active: selected,
      trailing: "chevron-right",
      onClick: () => {
        void selectComposerRuntimeProvider(id);
      },
    });
    if (selected) {
      activeElement = el;
    }
    composerRuntimeProviderOptions.appendChild(el);
  }
  if (typeof scrollActiveComposerRuntimeOptionIntoView === "function") {
    scrollActiveComposerRuntimeOptionIntoView(activeElement);
  }
}

async function loadComposerRuntimeProviders() {
  const generation = ++composerRuntimeProviderLoadGeneration;
  const app = getComposerRuntimeProviderApp();
  const sessionId = getComposerRuntimeSessionId();
  if (!app || !sessionId) {
    renderComposerRuntimeProviderMessage(t("compose.provider.unavailable"));
    setComposerRuntimeProviderStatus("");
    return;
  }
    setComposerRuntimeProviderStatus("");
  renderComposerRuntimeProviderMessage(t("compose.provider.loading"));
  try {
    const payload = await fetchJsonOrRedirect(`/api/native-providers?tool=${encodeURIComponent(app)}`, {
      // Provider profiles change through the Settings surface, not while this
      // picker is open. Reuse the shared short-lived catalog cache so opening
      // the runtime menu does not re-fetch the registry on every toggle.
      cacheMaxAgeMs: 10_000,
    });
    if (
      generation !== composerRuntimeProviderLoadGeneration
      || !composerRuntimeMenuOpen
      || normalizeComposerRuntimeMenuView(composerRuntimeMenuView) !== "providers"
      || getComposerRuntimeSessionId() !== sessionId
    ) return;
    const profiles = (Array.isArray(payload?.providers) ? payload.providers : [])
      .filter((profile) => profile?.agentType === app)
      .map((profile) => ({
        ...profile,
        id: String(profile.id || profile.name || "").trim(),
        label: profile.displayName || profile.id || profile.name || "",
        model: profile.modelPolicy?.defaultModel || "",
      }))
      .filter((profile) => profile.id);
    renderComposerRuntimeProviderOptions(profiles);
  } catch (error) {
    if (generation !== composerRuntimeProviderLoadGeneration) return;
    console.warn("[tooling] Failed to load runtime providers:", error?.message || error);
    renderComposerRuntimeProviderMessage(t("compose.provider.loadingFailed"));
  }
}

async function selectComposerRuntimeProvider(providerProfile) {
  const sessionId = getComposerRuntimeSessionId();
  const app = getComposerRuntimeProviderApp();
  if (!providerProfile || !sessionId || !app) return;
  setComposerRuntimeProviderStatus(t("compose.provider.loading"));

  // Provider selection is a control-plane mutation. Do not send it through a
  // paired host's potentially older P2P route: a stale sidecar can reject a
  // valid current provider while the authoritative chat server is healthy.
  // Apply the returned durable projection separately so a UI refresh failure
  // cannot turn a successful Provider change into a false error.
  let persisted = false;
  let lastError = null;
  const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
  for (let attempt = 0; attempt < 2 && !persisted; attempt += 1) {
    try {
      const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        skipP2P: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerProfile, model: "" }),
      });
      persisted = data?.session?.providerProfile === providerProfile;
      if (data?.session) {
        try {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          if (currentSessionId === sessionId) applyAttachedSessionState(sessionId, session);
        } catch (error) {
          console.warn("[tooling] Failed to render the Provider selection:", error?.message || error);
        }
      }
    } catch (error) {
      lastError = error;
      console.warn("[tooling] Failed to select runtime provider:", error?.message || error);
      if (!retryableStatuses.has(Number(error?.status || 0))) break;
    }
  }

  // A successful server PATCH can be followed by a client-side exception in
  // dispatchAction while applying the returned session projection. Confirm
  // the durable state before showing a failure so the UI cannot lie about the
  // result of a completed Provider change.
  if (!persisted) {
    try {
      const latest = await fetchJsonOrRedirect(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        { cache: "no-store", revalidate: false, skipP2P: true },
      );
      persisted = latest?.session?.providerProfile === providerProfile;
    } catch {}
  }
  if (!persisted) {
    const reason = String(lastError?.message || "").trim();
    setComposerRuntimeProviderStatus(reason || t("compose.provider.selectFailed"), "error");
    return;
  }

  rememberGlobalRuntimeSelection(selectedTool, providerProfile, "");
  setComposerRuntimeProviderStatus("");
  setComposerRuntimeView("models", "forward");
  try {
    syncComposerRuntimeUi();
  } catch (error) {
    console.warn("[tooling] Failed to render the Provider selection:", error?.message || error);
  }

  // Model discovery is a follow-up UI refresh. Provider persistence already
  // succeeded, so render the bounded local/configured catalog first. The
  // upstream /models probe can take several seconds (or hit its timeout); it
  // must enrich the open picker in the background instead of blocking the
  // panel or turning a valid Provider selection into a visible failure.
  try {
    await loadModelsForCurrentTool({ refresh: false, preserveCurrentSelection: false });
  } catch (error) {
    console.warn("[tooling] Failed to render the initial Provider model catalog:", error?.message || error);
  }
  void (async () => {
    try {
      if (typeof window.ragentRefreshModelCatalogForTool === "function") {
        await window.ragentRefreshModelCatalogForTool(selectedTool, {
          preserveCurrentSelection: false,
        });
      } else {
        await loadModelsForCurrentTool({ refresh: true, preserveCurrentSelection: false });
      }
    } catch (error) {
      console.warn("[tooling] Failed to refresh models after Provider selection:", error?.message || error);
    }
  })();
  try {
    syncComposerRuntimeUi();
  } catch (error) {
    console.warn("[tooling] Failed to render refreshed Provider models:", error?.message || error);
  }
}

function syncComposerRuntimeUi() {
  if (
    typeof composerRuntimeBtn === "undefined"
    || !composerRuntimeBtn
    || typeof composerRuntimeMenu === "undefined"
    || !composerRuntimeMenu
  ) {
    return;
  }

  const toolOptions = getComposerRuntimeToolOptions();
  const canUseRuntimeMenu = canChangeRuntimeSelectionFromUi()
    && toolOptions.length > 0
    && !(inlineToolSelect && inlineToolSelect.disabled);
  if (!canUseRuntimeMenu) {
    composerRuntimeMenuOpen = false;
    setComposerRuntimeView("tools");
  }

  if (composerRuntimeLabel) {
    composerRuntimeLabel.textContent = getComposerRuntimeButtonLabel();
  }
  if (typeof composerRuntimeProviderTitle !== "undefined" && composerRuntimeProviderTitle) {
    composerRuntimeProviderTitle.textContent = getComposerRuntimeProviderApp() === "agy"
      ? t("compose.provider.accountTitle")
      : t("compose.provider.title");
  }
  if (typeof syncComposerRuntimeSpeedUi === "function") {
    syncComposerRuntimeSpeedUi(canUseRuntimeMenu);
  }

  const canUsePermissionControls = canUseComposerPermissionControls();
  if (composerRuntimeMenuView === "permissions" && !canUsePermissionControls) {
    setComposerRuntimeView("models", "back");
  }

  composerRuntimeBtn.disabled = !canUseRuntimeMenu;
  composerRuntimeBtn.setAttribute("aria-expanded", composerRuntimeMenuOpen ? "true" : "false");
  window.RagentComposerMenuPortal?.sync(
    composerRuntimeMenu,
    composerRuntimeBtn,
    composerRuntimeMenuOpen,
    { align: "right" },
  );
  if (window.RagentMotion?.setPresence) {
    window.RagentMotion.setPresence(composerRuntimeMenu, composerRuntimeMenuOpen, {
      duration: 160,
    });
  } else {
    composerRuntimeMenu.hidden = !composerRuntimeMenuOpen;
    composerRuntimeMenu.classList.toggle("is-open", composerRuntimeMenuOpen);
  }
  composerRuntimeMenu.classList.toggle(
    "is-layer-forward",
    composerRuntimeTransitionDirection === "forward",
  );
  composerRuntimeMenu.classList.toggle(
    "is-layer-back",
    composerRuntimeTransitionDirection === "back",
  );

  const normalizedView = normalizeComposerRuntimeMenuView(composerRuntimeMenuView);
  const providerViewActive = normalizedView === "providers";
  const modelViewActive = normalizedView === "models";
  const permissionViewActive = normalizedView === "permissions";
  const modelOptions = getComposerRuntimeModelOptions();
  composerRuntimeToolView?.classList.toggle("active", normalizedView === "tools");
  composerRuntimeProviderView?.classList.toggle("active", providerViewActive);
  composerRuntimeModelView?.classList.toggle("active", modelViewActive);
  composerRuntimePermissionView?.classList.toggle("active", permissionViewActive);
  for (const viewEl of [
    composerRuntimeToolView,
    composerRuntimeProviderView,
    composerRuntimeModelView,
    composerRuntimePermissionView,
  ]) {
    viewEl?.classList.toggle(
      "is-enter-forward",
      viewEl?.classList.contains("active") && composerRuntimeTransitionDirection === "forward",
    );
    viewEl?.classList.toggle(
      "is-enter-back",
      viewEl?.classList.contains("active") && composerRuntimeTransitionDirection === "back",
    );
  }

  if (composerRuntimeModelOptions) {
    composerRuntimeModelOptions.hidden = !modelViewActive;
  }
  if (typeof renderComposerRuntimeModelStatus === "function") {
    renderComposerRuntimeModelStatus();
  }
  if (typeof composerRuntimePermissionBtn !== "undefined" && composerRuntimePermissionBtn) {
    composerRuntimePermissionBtn.hidden = !canUsePermissionControls;
    composerRuntimePermissionBtn.disabled = !canUseRuntimeMenu || !canUsePermissionControls;
    composerRuntimePermissionBtn.setAttribute(
      "aria-expanded",
      permissionViewActive ? "true" : "false",
    );
  }
  if (typeof composerRuntimePermissionOptions !== "undefined" && composerRuntimePermissionOptions) {
    composerRuntimePermissionOptions.hidden = !permissionViewActive;
  }

  renderComposerRuntimeToolOptions();
  renderComposerRuntimeModelOptions();
  if (canUsePermissionControls) renderComposerRuntimePermissionOptions();
  else if (typeof composerRuntimePermissionOptions !== "undefined" && composerRuntimePermissionOptions) {
    composerRuntimePermissionOptions.innerHTML = "";
  }
  if (typeof syncComposerPermissionUi === "function") {
    syncComposerPermissionUi();
  }
  if (typeof window.syncGoalMenuVisibility === "function") {
    window.syncGoalMenuVisibility();
  }
}

function syncComposerRuntimeMenuBackEntry(open) {
  if (open) {
    composerRuntimeMenuBackEntryId = window.RagentBackHandler?.push?.({
      id: "composer-runtime-menu",
      onBack: () => {
        setComposerRuntimeMenuOpen(false);
        return true;
      },
    }) || null;
  } else if (composerRuntimeMenuBackEntryId) {
    window.RagentBackHandler?.pop?.(composerRuntimeMenuBackEntryId);
    composerRuntimeMenuBackEntryId = null;
  }
}

function syncComposerPermissionMenuBackEntry(open) {
  if (open) {
    composerPermissionMenuBackEntryId = window.RagentBackHandler?.push?.({
      id: "composer-permission-menu",
      onBack: () => {
        setComposerPermissionMenuOpen(false);
        return true;
      },
    }) || null;
  } else if (composerPermissionMenuBackEntryId) {
    window.RagentBackHandler?.pop?.(composerPermissionMenuBackEntryId);
    composerPermissionMenuBackEntryId = null;
  }
}

function setComposerRuntimeMenuOpen(open, { view = null } = {}) {
  if (open) {
    composerRuntimeSpeedPanelOpen = false;
    composerPermissionMenuOpen = false;
    // The menus are mutually exclusive: opening one unwinds the other's
    // back entry so a back press never hits a closed menu.
    syncComposerPermissionMenuBackEntry(false);
  }
  const wasOpen = composerRuntimeMenuOpen;
  composerRuntimeMenuOpen = !!open;
  if (view) setComposerRuntimeView(view, wasOpen ? "forward" : "none");
  if (!composerRuntimeMenuOpen) setComposerRuntimeView("tools");
  syncComposerRuntimeUi();
  syncComposerPermissionUi();
  syncComposerRuntimeMenuBackEntry(composerRuntimeMenuOpen);
}
// Exposed so the fullscreen composer can collapse a leftover runtime menu when
// it closes (the trigger is re-parented and must not leave a floating menu).
window.RagentComposerRuntimeMenu = Object.freeze({
  close: () => setComposerRuntimeMenuOpen(false),
});

function setComposerPermissionMenuOpen(open) {
  if (open) {
    composerRuntimeSpeedPanelOpen = false;
    composerRuntimeMenuOpen = false;
    syncComposerRuntimeMenuBackEntry(false);
  }
  composerPermissionMenuOpen = !!open;
  syncComposerRuntimeUi();
  syncComposerPermissionUi();
  syncComposerPermissionMenuBackEntry(composerPermissionMenuOpen);
}

async function selectComposerRuntimeTool(toolId) {
  if (!inlineToolSelect || !toolId) return;
  const previousTool = inlineToolSelect.value;
  setNativeSelectValue(inlineToolSelect, toolId);
  const providerApp = getComposerRuntimeProviderApp(toolId);
  setComposerRuntimeView(providerApp ? "providers" : "models", "forward");
  syncComposerRuntimeUi();

  if (typeof applyInlineToolSelection === "function") {
    // Provider-backed Harnesses must not wait for the complete model catalog
    // before showing their provider list. Model discovery happens after the
    // user chooses a provider and is scoped to that provider.
    await applyInlineToolSelection(toolId, { deferModelLoad: !!providerApp });
  } else if (previousTool !== toolId) {
    dispatchNativeChange(inlineToolSelect);
  }

  composerRuntimeMenuOpen = true;
  setComposerRuntimeView(providerApp ? "providers" : "models", "forward");
  syncComposerRuntimeUi();
  if (providerApp) {
    void loadComposerRuntimeProviders();
    // Warm the model discovery cache without delaying the provider panel.
    // Provider selection will reuse this work (and the server's scoped cache).
    void loadModelsForCurrentTool();
  }
}

function setComposerRuntimeReasoning(value) {
  if (currentToolReasoningKind === "enum") {
    if (!effortSelect || effortSelect.disabled) return;
    setNativeSelectValue(effortSelect, value);
    dispatchNativeChange(effortSelect);
    syncComposerRuntimeUi();
    return;
  }

  if (currentToolReasoningKind === "toggle") {
    if (thinkingToggle?.disabled) return;
    const nextEnabled = value === "on";
    if (thinkingEnabled !== nextEnabled) {
      thinkingEnabled = nextEnabled;
      try {
        localStorage.setItem("thinkingEnabled", thinkingEnabled);
      } catch {}
      updateThinkingUI();
      syncComposerModeUi();
      queueRuntimeSelectionSync();
      persistCurrentSessionToolPreferences();
    } else {
      syncComposerRuntimeUi();
    }
  }
}

function setComposerRuntimeModel(value) {
  if (!inlineModelSelect || inlineModelSelect.disabled) return;
  setNativeSelectValue(inlineModelSelect, value);
  dispatchNativeChange(inlineModelSelect);
  setComposerRuntimeMenuOpen(false);
}

function setComposerPermissionMode(value) {
  const nextMode = getComposerEffectivePermissionMode(selectedTool);
  if (!nextMode) return;
  const wasRuntimePermissionView = composerRuntimeMenuOpen
    && normalizeComposerRuntimeMenuView(composerRuntimeMenuView) === "permissions";
  selectedPermissionMode = nextMode;
  composerPermissionMenuOpen = false;
  if (wasRuntimePermissionView) {
    setComposerRuntimeView("models", "back");
  }
  syncComposerRuntimeUi();
  syncComposerPermissionUi();
  syncComposerModeUi();
  queueRuntimeSelectionSync();
  persistCurrentSessionToolPreferences();
}

function getComposerRuntimeSummaryParts() {
  const modeLabel = isComposerPlanMode()
    ? t("compose.mode.plan")
    : t("compose.mode.chat");
  const toolLabel = getSelectDisplayLabel(
    typeof inlineToolSelect !== "undefined" ? inlineToolSelect : null,
    t("tooling.defaultModel"),
  );
  const modelLabel = getSelectDisplayLabel(
    typeof inlineModelSelect !== "undefined" ? inlineModelSelect : null,
    "",
  );
  const effortLabel = typeof effortSelect !== "undefined"
    && effortSelect
    && effortSelect.style?.display !== "none"
    ? getSelectDisplayLabel(effortSelect, "")
    : "";
  const permissionLabel = getComposerPermissionButtonLabel();
  const contextLabel = getVisibleContextSummary();
  return [modeLabel, toolLabel, modelLabel, effortLabel, permissionLabel, contextLabel]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .filter((part, index, parts) => parts.indexOf(part) === index)
    .slice(0, 6);
}

function getComposerPlaceholderKey() {
  if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) {
    return "input.placeholder.readOnlySnapshot";
  }
  const session = typeof getCurrentSession === "function" ? getCurrentSession() : null;
  if (session?.archived === true) {
    return "input.placeholder.archived";
  }
  if (
    typeof currentSessionId !== "undefined"
    && currentSessionId
    && typeof isSessionBusy === "function"
    && isSessionBusy(session)
  ) {
    return "input.placeholder.queueFollowUp";
  }
  return isComposerPlanMode()
    ? "compose.placeholder.plan"
    : "input.placeholder.message";
}

function syncComposerModeUi() {
  const planMode = isComposerPlanMode();
  if (typeof inputArea !== "undefined" && inputArea) {
    inputArea.classList.toggle("is-plan-mode", planMode);
  }
  if (typeof composerModeChatBtn !== "undefined" && composerModeChatBtn) {
    composerModeChatBtn.classList.toggle("active", !planMode);
    composerModeChatBtn.setAttribute("aria-pressed", planMode ? "false" : "true");
    composerModeChatBtn.disabled = !!(inlineAgentSelect && inlineAgentSelect.disabled);
  }
  if (typeof composerModePlanBtn !== "undefined" && composerModePlanBtn) {
    composerModePlanBtn.classList.toggle("active", planMode);
    composerModePlanBtn.setAttribute("aria-pressed", planMode ? "true" : "false");
    composerModePlanBtn.disabled = !!(inlineAgentSelect && inlineAgentSelect.disabled);
  }
  if (typeof composerSummaryLabel !== "undefined" && composerSummaryLabel) {
    const summary = getComposerRuntimeSummaryParts().join(" · ");
    composerSummaryLabel.textContent = summary || t("compose.summary.default");
  }
  if (typeof composerSummaryText !== "undefined" && composerSummaryText) {
    const summaryTitle = getComposerRuntimeSummaryParts().join(" · ");
    composerSummaryText.title = summaryTitle
      ? `${t("action.switchMode")}: ${summaryTitle}`
      : t("action.switchMode");
  }
  if (typeof composerPlanChip !== "undefined" && composerPlanChip) {
    composerPlanChip.hidden = !planMode;
  }
  if (typeof composerPlanMenuItem !== "undefined" && composerPlanMenuItem) {
    composerPlanMenuItem.classList.toggle("active", planMode);
    composerPlanMenuItem.setAttribute("aria-checked", planMode ? "true" : "false");
    composerPlanMenuItem.disabled = !canToggleComposerPlanMode();
  }
  if (typeof composerPlanMenuNote !== "undefined" && composerPlanMenuNote) {
    composerPlanMenuNote.textContent = planMode
      ? t("compose.add.planOff")
      : t("compose.add.planOn");
  }
  if (typeof msgInput !== "undefined" && msgInput) {
    const placeholderKey = getComposerPlaceholderKey();
    msgInput.dataset.i18nPlaceholder = placeholderKey;
    msgInput.placeholder = t(placeholderKey);
  }
  if (typeof syncComposerRuntimeUi === "function") {
    syncComposerRuntimeUi();
  }
  if (typeof syncComposerPermissionUi === "function") {
    syncComposerPermissionUi();
  }
}

function setComposerInteractionMode(mode) {
  if (!inlineAgentSelect || !canToggleComposerPlanMode()) return;
  const nextValue = mode === "plan" ? "__plan" : "";
  if (nextValue === "__plan") {
    ensureComposerPlanOption();
  }
  if (inlineAgentSelect.value !== nextValue) {
    inlineAgentSelect.value = nextValue;
    inlineAgentSelect.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    syncComposerModeUi();
  }
}

function restoreComposerInteractionMode(session) {
  if (!inlineAgentSelect) return;
  const nextValue = session?.interactionMode === "plan" ? "__plan" : "";
  if (nextValue === "__plan") {
    ensureComposerPlanOption();
  }
  inlineAgentSelect.value = nextValue;
  syncComposerModeUi();
}

window.ragentSyncComposerModeUi = syncComposerModeUi;

function getAttachedSessionToolPreferences(toolId = selectedTool) {
  const session = getCurrentSession();
  if (!session || !toolId || session.tool !== toolId) return null;
  const preferences = {
    providerProfile: typeof session.providerProfile === "string" ? session.providerProfile.trim() : "",
    hasModel: Object.prototype.hasOwnProperty.call(session, "model"),
    model: typeof session.model === "string" ? session.model : "",
    hasEffort: Object.prototype.hasOwnProperty.call(session, "effort"),
    effort: typeof session.effort === "string" ? session.effort : "",
    hasServiceTier: Object.prototype.hasOwnProperty.call(session, "serviceTier"),
    serviceTier: typeof session.serviceTier === "string" ? session.serviceTier : "standard",
    hasThinking: Object.prototype.hasOwnProperty.call(session, "thinking"),
    thinking: session.thinking === true,
    hasPermissionMode: Object.prototype.hasOwnProperty.call(session, "permissionMode"),
    permissionMode: typeof session.permissionMode === "string" ? session.permissionMode : "",
  };
  // Inheritance contract (会话优先继承): a session that has no usable
  // provider/model pair falls back to the owner's most recent pair for this
  // tool from ANY session (not just this one). Never combine a provider from
  // one pair with a model from another pair.
  // The inherited pair is display/selection scope only — it never rewrites
  // session.tool (identity) and never PATCHes providerProfile implicitly
  // (that would drop codex/claude thread resume ids); a Run routes to the
  // inherited provider through the `model@providerId` suffix.
  const hasOwnProvider = Boolean(preferences.providerProfile);
  const hasOwnModel = preferences.hasModel && Boolean(preferences.model.trim());
  const inherited = (!hasOwnProvider || !hasOwnModel)
    ? getLastGlobalRuntimeSelection(toolId)
    : null;
  if (!hasOwnProvider && hasOwnModel) {
    // A legacy session may have only a scoped model. Its suffix is the
    // authoritative provider; importing the global provider would mismatch
    // the session's own model.
    const modelProvider = parseScopedModelProvider(preferences.model).providerId;
    if (modelProvider) {
      preferences.providerProfile = modelProvider;
      preferences.derivedProviderProfile = true;
    } else if (inherited?.providerProfile) {
      preferences.providerProfile = inherited.providerProfile;
      preferences.inheritedProviderProfile = true;
    }
  } else {
    if (!hasOwnProvider && inherited?.providerProfile) {
      preferences.providerProfile = inherited.providerProfile;
      preferences.inheritedProviderProfile = true;
    }
    const inheritedModelProvider = parseScopedModelProvider(inherited?.model || "").providerId;
    const modelMatchesProvider = !inheritedModelProvider
      || !preferences.providerProfile
      || inheritedModelProvider === preferences.providerProfile;
    if (!hasOwnModel && inherited?.model && modelMatchesProvider) {
      preferences.model = inherited.model;
      preferences.inheritedModel = true;
    }
  }
  return preferences;
}

// Per-tool "last selection anywhere" cache under `lastRuntimeSelection_<tool>`
// (key inlined so each helper stays self-contained for the vm-based frontend
// tests, which extract single functions). One timestamped record keeps
// provider+model as a pair (two separate legacy keys could go stale relative
// to each other and resurrect a model from a different provider). The legacy
// keys stay in sync for older code paths that still read them.

// Mirror of the server's parseScopedCodexModel (chat/models.mjs): split a
// `model@providerId` catalog id into its parts. Provider ids are restricted to
// a known shape so a model id that itself contains '@' is never mis-split.
function parseScopedModelProvider(modelId) {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) return { model: "", providerId: "" };
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return { model: raw, providerId: "" };
  const providerId = raw.slice(at + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(providerId)) return { model: raw, providerId: "" };
  return { model: raw.slice(0, at), providerId };
}

function readLastGlobalRuntimeSelection(toolId) {
  if (!toolId) return null;
  try {
    const raw = localStorage.getItem(`lastRuntimeSelection_${toolId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const providerProfile = typeof parsed.providerProfile === "string" ? parsed.providerProfile.trim() : "";
    const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
    if (!providerProfile && !model) return null;
    return { providerProfile, model };
  } catch {
    return null;
  }
}

function getLastGlobalRuntimeSelection(toolId) {
  const record = readLastGlobalRuntimeSelection(toolId);
  if (record) return record;
  // Migration: fall back to the legacy per-tool keys when the paired record
  // has not been written yet (first load after this change ships).
  let providerProfile = "";
  let model = "";
  try {
    providerProfile = (localStorage.getItem(`selectedProvider_${toolId}`) || "").trim();
    model = (localStorage.getItem(`selectedModel_${toolId}`) || "").trim();
  } catch {}
  return { providerProfile, model };
}

function rememberGlobalRuntimeSelection(toolId, providerProfile, model) {
  if (!toolId) return;
  const nextProvider = typeof providerProfile === "string" ? providerProfile.trim() : "";
  const nextModel = typeof model === "string" ? model.trim() : "";
  if (!nextProvider && !nextModel) return;
  try {
    const record = {
      ...(nextProvider ? { providerProfile: nextProvider } : {}),
      ...(nextModel ? { model: nextModel } : {}),
      at: Date.now(),
    };
    localStorage.setItem(`lastRuntimeSelection_${toolId}`, JSON.stringify(record));
    // Keep the legacy single-value keys aligned for older readers.
    if (nextProvider) localStorage.setItem(`selectedProvider_${toolId}`, nextProvider);
    else localStorage.removeItem(`selectedProvider_${toolId}`);
    if (nextModel) localStorage.setItem(`selectedModel_${toolId}`, nextModel);
    else localStorage.removeItem(`selectedModel_${toolId}`);
  } catch {}
}

function filterModelsForSessionProvider(toolId, models, sessionPreferences) {
  const providerProfile = String(sessionPreferences?.providerProfile || "").trim();
  if (!providerProfile || !Array.isArray(models)) return Array.isArray(models) ? models : [];
  const definition = getSelectedToolDefinition(toolId);
  const runtimeFamily = String(definition?.runtimeFamily || "").trim();
  const isCodex = toolId === "codex" || toolId === "codex-cli" || runtimeFamily.startsWith("codex-");
  const isClaude = toolId === "claude" || toolId === "claude-bidi" || runtimeFamily.startsWith("claude-");
  const isAgy = toolId === "agy" || runtimeFamily.startsWith("agy-");
  // Native catalogs scope codex, claude and agy ids as `model@providerId`.
  if (!isCodex && !isClaude && !isAgy) return models;
  const suffix = `@${providerProfile}`;
  const scoped = models.filter((model) => String(model?.id || "").endsWith(suffix));
  // The sheet is already scoped to one provider; the model list shows bare
  // model names without the `· providerTag` suffix (server labels append it
  // for unscoped contexts).
  if (scoped.length > 0) {
    return scoped.map((model) => ({
      ...model,
      label: String(model?.label || "").replace(/\s*·\s*[^·]+$/, "").trim() || model.label,
    }));
  }
  // Native/modern catalogs use provider-scoped ids.  Never show another
  // provider's models when the selected provider has no discovered models;
  // that makes an unavailable provider visible as empty instead of silently
  // routing a QQ Official (or other provider) model through the wrong config.
  const hasScopedModelIds = models.some((model) => String(model?.id || "").includes("@"));
  return hasScopedModelIds ? [] : models;
}

function persistCurrentSessionToolPreferences() {
  if (!canChangeRuntimeSelectionFromUi() || !currentSessionId || !selectedTool) {
    return Promise.resolve(false);
  }
  const payload = {
    action: "session_preferences",
    sessionId: currentSessionId,
    tool: selectedTool,
    // An inherited model is a display/run default, not a session pin. Keep it
    // out of unrelated preference patches so a later global provider change
    // cannot leave this session with a model from the old provider.
    ...(selectedModelIsInherited ? {} : { model: selectedModel || "" }),
    effort: selectedEffort || "",
    serviceTier: typeof selectedServiceTier === "string" ? selectedServiceTier : "standard",
    permissionMode: selectedPermissionMode || "",
    thinking: currentToolReasoningKind === "toggle" ? thinkingEnabled : false,
    interactionMode: isComposerPlanMode() ? "plan" : "agent",
  };
  sessionToolPreferencesPersistPromise = sessionToolPreferencesPersistPromise
    .catch(() => {})
    .then(async () => {
      const persisted = await dispatchAction(payload);
      if (persisted !== true) {
        throw new Error("Failed to persist session runtime preferences");
      }
      return true;
    });
  void sessionToolPreferencesPersistPromise.catch((error) => {
    console.warn("[session-preferences] Failed to persist runtime preferences:", error?.message || error);
  });
  return sessionToolPreferencesPersistPromise;
}

thinkingToggle.addEventListener("click", () => {
  thinkingEnabled = !thinkingEnabled;
  localStorage.setItem("thinkingEnabled", thinkingEnabled);
  markCurrentSessionRuntimePreferencesEdited();
  updateThinkingUI();
  syncComposerModeUi();
  queueRuntimeSelectionSync();
  persistCurrentSessionToolPreferences();
});

effortSelect.addEventListener("change", () => {
  setSelectedEffort(effortSelect.value);
});

serviceTierSelect?.addEventListener("change", () => {
  setSelectedServiceTier(serviceTierSelect.value);
});

composerRuntimeSpeedBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (composerRuntimeSpeedBtn.disabled) return;
  if (!composerRuntimeSpeedPanelOpen) {
    if (composerRuntimeMenuOpen) setComposerRuntimeMenuOpen(false);
    if (composerPermissionMenuOpen) setComposerPermissionMenuOpen(false);
  }
  composerRuntimeSpeedPanelOpen = !composerRuntimeSpeedPanelOpen;
  syncComposerRuntimeSpeedUi();
  if (composerRuntimeSpeedPanelOpen) {
    const focusTarget = composerRuntimeSpeedSelect?.disabled
      ? composerRuntimeEffortRange
      : composerRuntimeSpeedSelect;
    focusTarget?.focus?.();
  } else {
    composerRuntimeSpeedBtn.focus?.();
  }
});

composerRuntimeSpeedSelect?.addEventListener("change", () => {
  setSelectedServiceTier(composerRuntimeSpeedSelect.value);
});

if (typeof composerRuntimeSpeedToggle !== "undefined" && composerRuntimeSpeedToggle) {
  composerRuntimeSpeedToggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (composerRuntimeSpeedToggle.disabled) return;
    setSelectedServiceTier(selectedServiceTier === "fast" ? "standard" : "fast");
  });
}

function getComposerRuntimeEffortIndex(value) {
  const levels = Array.isArray(currentToolEffortLevels) ? currentToolEffortLevels : [];
  if (levels.length === 0) return -1;
  const maxIndex = levels.length - 1;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 0;
  return Math.min(maxIndex, Math.max(0, Math.round(numericValue)));
}

function updateComposerRuntimeEffortFromRange({ commit = false } = {}) {
  if (!composerRuntimeEffortRange) return;
  const levels = Array.isArray(currentToolEffortLevels) ? currentToolEffortLevels : [];
  const effortIndex = getComposerRuntimeEffortIndex(composerRuntimeEffortRange.value);
  const nextEffort = levels[effortIndex] || "";
  if (!nextEffort) return;

  if (commit) {
    composerRuntimeEffortRange.value = String(effortIndex);
    setSelectedEffort(nextEffort);
    return;
  }

  const rawValue = composerRuntimeEffortRange.value;
  setSelectedEffort(nextEffort, { persist: false, sync: true });
  // Keep the thumb at the exact pointer position while dragging. The selected
  // effort remains discrete, but the visual control stays continuous until
  // the pointer is released.
  composerRuntimeEffortRange.value = rawValue;
  composerRuntimeEffortRange.setAttribute("aria-valuetext", nextEffort);
}

composerRuntimeEffortRange?.addEventListener("input", () => {
  updateComposerRuntimeEffortFromRange();
});

composerRuntimeEffortRange?.addEventListener("change", () => {
  updateComposerRuntimeEffortFromRange({ commit: true });
});

let composerRuntimeEffortPointerState = null;

function getComposerRuntimeEffortPointerValue(clientX, pointerOffset = 0) {
  const rect = composerRuntimeEffortRange.getBoundingClientRect();
  const thumbSize = 24;
  const usableWidth = Math.max(1, rect.width - thumbSize);
  const thumbCenter = clientX - pointerOffset;
  const fraction = (thumbCenter - rect.left - thumbSize / 2) / usableWidth;
  const maxIndex = Math.max(0, (Array.isArray(currentToolEffortLevels) ? currentToolEffortLevels.length : 1) - 1);
  return Math.min(maxIndex, Math.max(0, fraction * maxIndex));
}

composerRuntimeEffortRange?.addEventListener("pointerdown", (event) => {
  if (composerRuntimeEffortRange.disabled || event.button > 0) return;
  const currentValue = Number(composerRuntimeEffortRange.value);
  const maxIndex = Math.max(0, (Array.isArray(currentToolEffortLevels) ? currentToolEffortLevels.length : 1) - 1);
  const rect = composerRuntimeEffortRange.getBoundingClientRect();
  const thumbSize = 24;
  const usableWidth = Math.max(1, rect.width - thumbSize);
  const thumbCenter = rect.left + thumbSize / 2 + (maxIndex > 0 ? (currentValue / maxIndex) * usableWidth : 0);
  composerRuntimeEffortPointerState = {
    pointerId: event.pointerId,
    pointerOffset: event.clientX - thumbCenter,
  };
  event.preventDefault();
  composerRuntimeEffortRange.setPointerCapture?.(event.pointerId);
  composerRuntimeEffortRange.classList.add("is-dragging");
});

composerRuntimeEffortRange?.addEventListener("pointermove", (event) => {
  if (!composerRuntimeEffortPointerState || event.pointerId !== composerRuntimeEffortPointerState.pointerId) return;
  event.preventDefault();
  composerRuntimeEffortRange.value = String(getComposerRuntimeEffortPointerValue(
    event.clientX,
    composerRuntimeEffortPointerState.pointerOffset,
  ));
  updateComposerRuntimeEffortFromRange();
});

function finishComposerRuntimeEffortPointer(event) {
  if (!composerRuntimeEffortPointerState || event.pointerId !== composerRuntimeEffortPointerState.pointerId) return;
  event.preventDefault();
  composerRuntimeEffortRange.releasePointerCapture?.(event.pointerId);
  composerRuntimeEffortRange.classList.remove("is-dragging");
  composerRuntimeEffortPointerState = null;
  updateComposerRuntimeEffortFromRange({ commit: true });
}

composerRuntimeEffortRange?.addEventListener("pointerup", finishComposerRuntimeEffortPointer);
composerRuntimeEffortRange?.addEventListener("pointercancel", finishComposerRuntimeEffortPointer);
// ---- Inline tool select ----
function slugifyToolValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "my-agent";
}

function getSelectedToolDefinition(toolId = selectedTool) {
  return toolsList.find((tool) => tool.id === toolId) || null;
}

// Keep capability-aware frontend surfaces decoupled from this module's
// top-level state. Goal mode is Codex-specific, so its UI can use the same
// runtime definition that drives the Composer picker without matching labels.
window.ragentGetSelectedToolDefinition = getSelectedToolDefinition;

function parseModelLines(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|");
      const id = String(parts.shift() || "").trim();
      const label = String(parts.join("|") || id).trim() || id;
      return id ? { id, label } : null;
    })
    .filter(Boolean);
}

function parseReasoningLevels(raw) {
  return [...new Set(
    String(raw || "")
      .split(",")
      .map((level) => level.trim())
      .filter(Boolean),
  )];
}

function setAddToolStatus(message = "", tone = "") {
  if (!addToolStatus) return;
  addToolStatus.textContent = message;
  addToolStatus.className = `provider-helper-status${tone ? ` ${tone}` : ""}`;
}

function syncQuickAddControls() {
  const family = addToolRuntimeFamilySelect?.value || "claude-stream-json";
  const allowedKinds = family === "codex-json" ? ["enum", "none"] : ["toggle", "none"];

  for (const opt of addToolReasoningKindSelect.options) {
    const allowed = allowedKinds.includes(opt.value);
    opt.disabled = !allowed;
    opt.hidden = !allowed;
  }
  if (!allowedKinds.includes(addToolReasoningKindSelect.value)) {
    addToolReasoningKindSelect.value = allowedKinds[0];
  }

  const showLevels = addToolReasoningKindSelect.value === "enum";
  const levelsField = addToolReasoningLevelsInput.closest(".provider-helper-field");
  addToolReasoningLevelsInput.disabled = !showLevels;
  if (levelsField) levelsField.style.opacity = showLevels ? "1" : "0.55";
  if (family === "codex-json" && !addToolReasoningLevelsInput.value.trim()) {
    addToolReasoningLevelsInput.value = "low, medium, high, xhigh";
  }
}

function getAddToolDraft() {
  const name = (addToolNameInput?.value || "").trim() || "My Agent";
  const command = (addToolCommandInput?.value || "").trim() || "my-agent";
  const runtimeFamily =
    addToolRuntimeFamilySelect?.value || "claude-stream-json";
  const models = parseModelLines(addToolModelsInput?.value || "");
  const reasoningKind = addToolReasoningKindSelect?.value || "toggle";
  const reasoning = { kind: reasoningKind, label: t("tooling.thinking") };
  if (reasoningKind === "enum") {
    reasoning.levels = parseReasoningLevels(addToolReasoningLevelsInput?.value || "")
      .length > 0
      ? parseReasoningLevels(addToolReasoningLevelsInput?.value || "")
      : ["low", "medium", "high", "xhigh"];
    reasoning.default = reasoning.levels[0];
  }

  return {
    name,
    command,
    runtimeFamily,
    commandSlug: slugifyToolValue(command),
    models,
    reasoning,
  };
}

function buildProviderBasePrompt() {
  const draft = getAddToolDraft();
  const modelLines = draft.models.length > 0
    ? draft.models.map((model) => `- ${model.id}${model.label !== model.id ? ` | ${model.label}` : ""}`).join("\n")
    : "- none configured yet";
  const reasoningLine = draft.reasoning.kind === "enum"
    ? `${draft.reasoning.kind} (${draft.reasoning.levels.join(", ")})`
    : draft.reasoning.kind;
  return [
    `I want to add a new tool/provider to Ragent.`,
    ``,
    `Target tool`,
    `- Name: ${draft.name}`,
    `- Command: ${draft.command}`,
    `- Derived ID / slug: ${draft.commandSlug}`,
    `- Runtime family: ${draft.runtimeFamily}`,
    `- Reasoning mode: ${reasoningLine}`,
    `- Models:`,
    modelLines,
    ``,
    `Work in the Ragent repo root (usually \`~/code/ragent\`; adjust if your checkout lives elsewhere).`,
    `Read \`AGENTS.md\` (legacy \`CLAUDE.md\` is only a compatibility shim) and \`notes/directional/provider-architecture.md\` first.`,
    ``,
    `Please:`,
    `1. Decide whether this can stay a simple provider bound to an existing runtime family or needs full provider code.`,
    `2. If simple config is enough, explain the minimal runtimeFamily/models/reasoning config that should be saved.`,
    `3. If the command is not compatible with the runtime family's normal CLI flags, implement the minimal arg-mapping/provider code needed to make it work.`,
    `4. If full provider support is needed (models, thinking, runtime, parser, resume handling), implement the minimal code changes in the repo.`,
    `5. Keep changes surgical, update docs if needed, and validate the flow end-to-end.`,
    ``,
    `Do not stop at planning — apply the changes if they are clear.`,
  ].join("\n");
}

function updateCopyButtonLabel(button, label) {
  if (!button) return;
  const original = button.dataset.originalLabel || getHeaderActionButtonLabel(button);
  button.dataset.originalLabel = original;
  if (button.dataset.originalTitle === undefined) {
    button.dataset.originalTitle = getHeaderActionButtonAttribute(button, "title");
  }
  if (button.dataset.originalAriaLabel === undefined) {
    button.dataset.originalAriaLabel = getHeaderActionButtonAttribute(button, "aria-label");
  }
  setHeaderActionButtonLabel(button, label);
  window.clearTimeout(button._copyResetTimer);
  button._copyResetTimer = window.setTimeout(() => {
    setHeaderActionButtonLabel(button, button.dataset.originalLabel || original);
    restoreHeaderActionButtonAccessibility(button);
  }, 1400);
}

function getHeaderActionButtonLabelNode(button) {
  if (!button || typeof button.querySelector !== "function") return null;
  const labelNode = button.querySelector(".header-action-label");
  if (!labelNode) return null;
  if (labelNode.classList && typeof labelNode.classList.contains === "function") {
    return labelNode.classList.contains("header-action-label") ? labelNode : null;
  }
  if (typeof labelNode.matches === "function") {
    return labelNode.matches(".header-action-label") ? labelNode : null;
  }
  return labelNode;
}

function getHeaderActionButtonLabel(button) {
  const labelNode = getHeaderActionButtonLabelNode(button);
  return labelNode ? labelNode.textContent : button?.textContent || "";
}

function getHeaderActionButtonAttribute(button, name) {
  if (!button) return "";
  if (typeof button.getAttribute === "function") {
    return button.getAttribute(name) || "";
  }
  return typeof button[name] === "string" ? button[name] : "";
}

function setHeaderActionButtonAttribute(button, name, value) {
  if (!button) return;
  if (typeof button.setAttribute === "function") {
    button.setAttribute(name, value);
    return;
  }
  button[name] = value;
}

function removeHeaderActionButtonAttribute(button, name) {
  if (!button) return;
  if (typeof button.removeAttribute === "function") {
    button.removeAttribute(name);
    return;
  }
  delete button[name];
}

function setHeaderActionButtonLabel(button, label) {
  if (!button) return;
  const labelNode = getHeaderActionButtonLabelNode(button);
  if (labelNode) {
    labelNode.textContent = label;
  } else {
    button.textContent = label;
  }
  setHeaderActionButtonAttribute(button, "title", label);
  setHeaderActionButtonAttribute(button, "aria-label", label);
}

function restoreHeaderActionButtonAccessibility(button) {
  if (!button) return;
  if (button.dataset.originalTitle !== undefined) {
    if (button.dataset.originalTitle) {
      setHeaderActionButtonAttribute(button, "title", button.dataset.originalTitle);
    } else {
      removeHeaderActionButtonAttribute(button, "title");
    }
  }
  if (button.dataset.originalAriaLabel !== undefined) {
    if (button.dataset.originalAriaLabel) {
      setHeaderActionButtonAttribute(button, "aria-label", button.dataset.originalAriaLabel);
    } else {
      removeHeaderActionButtonAttribute(button, "aria-label");
    }
  }
}

function getToolingLabel(key, vars) {
  if (typeof t === "function") return t(key, vars);
  return window.ragentT ? window.ragentT(key, vars) : key;
}

function resetHeaderActionButton(button) {
  if (!button) return;
  button.disabled = false;
  window.clearTimeout(button._copyResetTimer);
  if (button.dataset.originalLabel) {
    setHeaderActionButtonLabel(button, button.dataset.originalLabel);
  }
  restoreHeaderActionButtonAccessibility(button);
}

function syncShareButton() {
  if (!shareSnapshotBtn) return;
  const publishShareSnapshotsEnabled = typeof canPublishShareSnapshots === "function"
    ? canPublishShareSnapshots()
    : !visitorMode;
  const visible = publishShareSnapshotsEnabled && !!currentSessionId;
  shareSnapshotBtn.style.display = visible ? "" : "none";
  if (!visible) {
    resetHeaderActionButton(shareSnapshotBtn);
  }
  if (typeof syncMobileDisclosureState === "function") {
    syncMobileDisclosureState();
  }
}

function syncForkButton() {
  if (!forkSessionBtn) return;
  const forkSessionsEnabled = typeof canForkSessions === "function"
    ? canForkSessions()
    : !visitorMode;
  const visible = forkSessionsEnabled && !!currentSessionId;
  forkSessionBtn.style.display = visible ? "" : "none";
  if (!visible) {
    resetHeaderActionButton(forkSessionBtn);
    return;
  }
  const session = getCurrentSession();
  const activity = getSessionActivity(session);
  forkSessionBtn.disabled = !session || activity.run.state === "running" || activity.compact.state === "pending";
}

async function forkCurrentSession() {
  const forkSessionsEnabled = typeof canForkSessions === "function"
    ? canForkSessions()
    : !visitorMode;
  if (!currentSessionId || !forkSessionsEnabled || !forkSessionBtn) return;

  const original = forkSessionBtn.dataset.originalLabel || forkSessionBtn.textContent;
  forkSessionBtn.dataset.originalLabel = original;
  forkSessionBtn.disabled = true;
  forkSessionBtn.textContent = `${getToolingLabel("action.fork")}…`;

  try {
    const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(currentSessionId)}/fork`, {
      method: "POST",
    });
    if (data.session) {
      upsertSession(data.session);
      renderSessionList();
      updateCopyButtonLabel(forkSessionBtn, getToolingLabel("action.fork"));
    } else {
      updateCopyButtonLabel(forkSessionBtn, getToolingLabel("action.copyFailed"));
    }
  } catch (err) {
    console.warn("[fork] Failed to fork session:", err.message);
    updateCopyButtonLabel(forkSessionBtn, getToolingLabel("action.copyFailed"));
  } finally {
    syncForkButton();
  }
}

function syncAddToolModal() {
  if (!providerPromptCode) return;
  syncQuickAddControls();
  providerPromptCode.textContent = buildProviderBasePrompt();
}

function openAddToolModal() {
  if (!canManageAgentsFromUi() || !canChangeRuntimeSelectionFromUi()) return;
  if (!addToolModal) return;
  if (!addToolNameInput.value.trim()) addToolNameInput.value = "My Agent";
  if (!addToolCommandInput.value.trim()) {
    addToolCommandInput.value = "my-agent";
  }
  const selectedToolDef = getSelectedToolDefinition();
  if (selectedToolDef?.runtimeFamily) {
    addToolRuntimeFamilySelect.value = selectedToolDef.runtimeFamily;
  }
  setAddToolStatus("");
  syncAddToolModal();
  addToolModalTrigger = document.activeElement;
  if (window.RagentMotion?.setPresence) {
    window.RagentMotion.setPresence(addToolModal, true, {
      duration: 180,
    });
  } else {
    addToolModal.hidden = false;
  }
  addToolModalFocusScopeDeactivate = window.RagentFocusScope?.activate?.(addToolModal, {
    containmentRoot: document.body,
    initialFocus: addToolNameInput,
    restoreFocus: () => (addToolModalTrigger && addToolModalTrigger.isConnected !== false)
      ? addToolModalTrigger
      : document.querySelector("main, [role=\"main\"]"),
    modal: true,
    onEscape: () => closeAddToolModal(),
  }) || null;
  addToolNameInput.focus();
  addToolNameInput.select();
  addToolModalBackEntryId = window.RagentBackHandler?.push?.({
    id: "add-tool-modal",
    onBack: () => {
      closeAddToolModal();
      return true;
    },
  }) || null;
}

function closeAddToolModal() {
  if (!addToolModal) return;
  if (addToolModalBackEntryId) {
    window.RagentBackHandler?.pop?.(addToolModalBackEntryId);
    addToolModalBackEntryId = null;
  }
  if (addToolModalFocusScopeDeactivate) {
    addToolModalFocusScopeDeactivate();
    addToolModalFocusScopeDeactivate = null;
  }
  if (window.RagentMotion?.setPresence) {
    window.RagentMotion.setPresence(addToolModal, false, {
      duration: 150,
    });
    return;
  }
  addToolModal.hidden = true;
}

async function saveSimpleToolConfig() {
  if (isSavingToolConfig) return;
  const draft = getAddToolDraft();

  if (!draft.command) {
    setAddToolStatus("Command is required.", "error");
    addToolCommandInput.focus();
    return;
  }

  isSavingToolConfig = true;
  saveToolConfigBtn.disabled = true;
  setAddToolStatus("Saving and refreshing picker...");

  try {
    const data = await fetchJsonOrRedirect("/api/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });

    const savedTool = data.tool;
    if (savedTool?.id) {
      selectedTool = savedTool.id;
      preferredTool = savedTool.id;
      localStorage.setItem("preferredTool", preferredTool);
      localStorage.setItem("selectedTool", selectedTool);
    }

    await loadInlineTools({ skipModelLoad: true });
    if (selectedTool) {
      await loadModelsForCurrentTool({ refresh: true });
    }

    if (savedTool?.available) {
      setAddToolStatus("Saved. The new tool is ready in the picker.", "success");
      closeAddToolModal();
    } else {
      setAddToolStatus(
        "Saved, but the command is not currently available on PATH, so it will stay hidden until the binary is available.",
        "error",
      );
    }
  } catch (err) {
    setAddToolStatus(err.message || "Failed to save tool config", "error");
  } finally {
    isSavingToolConfig = false;
    saveToolConfigBtn.disabled = false;
    syncAddToolModal();
  }
}

function renderInlineToolOptions(selectedValue, emptyMessage = t("settings.apps.noToolsAvailable")) {
  inlineToolSelect.disabled = !canChangeRuntimeSelectionFromUi();
  inlineToolSelect.innerHTML = "";

  if (toolsList.length === 0) {
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = emptyMessage;
    // Keep placeholder option enabled so selectedIndex is stable on mobile browsers.
    emptyOpt.disabled = false;
    emptyOpt.selected = true;
    inlineToolSelect.appendChild(emptyOpt);
  } else {
    for (const tool of toolsList) {
      const opt = document.createElement("option");
      opt.value = tool.id;
      opt.textContent = tool.name;
      inlineToolSelect.appendChild(opt);
    }
  }

  const addMoreOpt = document.createElement("option");
  addMoreOpt.value = ADD_MORE_TOOL_VALUE;
  addMoreOpt.textContent = t("settings.apps.addToolMore");
  inlineToolSelect.appendChild(addMoreOpt);

  if (selectedValue && toolsList.some((tool) => tool.id === selectedValue)) {
    inlineToolSelect.value = selectedValue;
  } else if (toolsList[0]) {
    inlineToolSelect.value = toolsList[0].id;
  } else {
    inlineToolSelect.selectedIndex = 0;
  }
  syncCustomSelectBridge(inlineToolSelect);
  syncComposerRuntimeUi();
}

function setSingleOption(selectEl, text, { disabled = false, selected = true } = {}) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = text;
  opt.disabled = disabled;
  opt.selected = selected;
  selectEl.appendChild(opt);
  // Ensure selectedIndex is set to 0 for the single option
  selectEl.selectedIndex = 0;
}

function normalizeInlineAgentOptionName(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\s+/g, " ")
    : "";
}

function shouldShowInlineAgentOption(app) {
  if (!app?.id || HIDDEN_INLINE_AGENT_IDS.has(app.id)) {
    return false;
  }
  if (app.id === DEFAULT_APP_ID) {
    return true;
  }
  return app.templateSelectable !== false;
}

function sortInlineAgentCatalog(apps = []) {
  return [...apps].sort((left, right) => {
    if (left?.id === DEFAULT_APP_ID) return -1;
    if (right?.id === DEFAULT_APP_ID) return 1;
    if (left?.builtin && !right?.builtin) return -1;
    if (!left?.builtin && right?.builtin) return 1;
    return String(left?.name || "").localeCompare(String(right?.name || ""));
  });
}

function findInlineAgentById(agentId) {
  if (!agentId) return null;
  return inlineAgentCatalog.find((agent) => agent?.id === agentId) || null;
}

function getInlineAgentOptions() {
  const visibleAgents = sortInlineAgentCatalog(
    inlineAgentCatalog.filter((app) => shouldShowInlineAgentOption(app) && app.id !== DEFAULT_APP_ID),
  );
  return [
    { id: "", name: t("compose.agent.default") },
    { id: "__plan", name: t("compose.agent.mode.plan") },
    ...visibleAgents.map((app) => ({
      id: app.id,
      name: normalizeInlineAgentOptionName(app.name) || t("settings.apps.untitled"),
    })),
  ];
}

function renderInlineAgentOptions(selectedValue = "") {
  if (!inlineAgentSelect) return;
  inlineAgentSelect.disabled = !canSwitchAgentsFromUi();
  inlineAgentSelect.innerHTML = "";

  for (const optionData of getInlineAgentOptions()) {
    const option = document.createElement("option");
    option.value = optionData.id;
    option.textContent = optionData.name;
    inlineAgentSelect.appendChild(option);
  }

  const renderedOptions = Array.isArray(inlineAgentSelect.options)
    ? inlineAgentSelect.options
    : Array.from(inlineAgentSelect.options || []);
  if (renderedOptions.some((option) => option.value === selectedValue)) {
    inlineAgentSelect.value = selectedValue;
  } else {
    inlineAgentSelect.value = "";
  }
  // If this select has been upgraded to a CustomSelect instance, force a sync
  // so the custom trigger text reflects the new native state immediately.
  try {
    const cs = window.getCustomSelect ? window.getCustomSelect(inlineAgentSelect) : null;
    if (cs && typeof cs._syncFromNative === 'function') cs._syncFromNative();
  } catch (err) {
    // non-fatal
  }
  syncComposerModeUi();
}

async function refreshInlineAgentPicker({ force = false } = {}) {
  if (!inlineAgentSelect) return;
  if (!canSwitchAgentsFromUi()) {
    inlineAgentSelect.disabled = true;
    inlineAgentSelect.innerHTML = "";
    return;
  }

  if (force || !inlineAgentCatalogLoaded) {
    inlineAgentSelect.disabled = true;
    inlineAgentSelect.innerHTML = "";
    const loadingOption = document.createElement("option");
    loadingOption.value = "";
    loadingOption.textContent = t("compose.agent.loading");
    inlineAgentSelect.appendChild(loadingOption);
    try {
      const data = await fetchJsonOrRedirect("/api/agents");
      inlineAgentCatalog = Array.isArray(data?.agents) ? data.agents : [];
      inlineAgentCatalogLoaded = true;
    } catch (error) {
      console.warn("[agents] Failed to load inline agents:", error?.message || error);
      inlineAgentCatalog = [];
      inlineAgentCatalogLoaded = true;
      renderInlineAgentOptions("");
      inlineAgentSelect.title = t("compose.agent.loadingFailed");
      inlineAgentSelect.disabled = false;
      return;
    }
  }

  const preferredAgentId = typeof getPreferredAgentTemplateId === "function"
    ? getPreferredAgentTemplateId()
    : "";
  const preferredAgent = findInlineAgentById(preferredAgentId);
  // Allow special pseudo-option '__plan' to be treated as a valid pref, do not clear it
  if (preferredAgentId && !preferredAgent && preferredAgentId !== '__plan') {
    if (typeof setPreferredAgentTemplate === "function") {
      setPreferredAgentTemplate("");
    }
    renderInlineAgentOptions("");
    return;
  }

  renderInlineAgentOptions(preferredAgentId);
  inlineAgentSelect.title = t("compose.agent.title");
  inlineAgentSelect.disabled = false;
}

function getVisiblePrimaryToolOptions() {
  return prioritizeToolOptions(
    filterPrimaryToolOptions(
      (Array.isArray(allToolsList) ? allToolsList : []).filter((tool) => tool?.available),
    ),
  );
}

function refreshPrimaryToolPicker({ keepToolIds = [], selectedValue = "" } = {}) {
  toolsList = getVisiblePrimaryToolOptions();
  const resolvedTool = resolvePreferredToolId(toolsList, [
    selectedValue,
    ...(Array.isArray(keepToolIds) ? keepToolIds : [keepToolIds]),
    selectedTool,
    preferredTool,
  ]);
  renderInlineToolOptions(resolvedTool);
  return resolvedTool;
}

const modelResponseCache = new Map();
const pendingModelResponseRequests = new Map();
let modelResponseCacheGeneration = 0;

function getModelResponseCacheKey(toolId, providerProfile = "") {
  return `${String(toolId || "").trim()}\u0000${String(providerProfile || "").trim()}`;
}

function getModelCacheToolIds(toolId) {
  const normalizedToolId = typeof toolId === "string" ? toolId.trim() : "";
  if (normalizedToolId === "claude" || normalizedToolId === "claude-bidi") {
    return ["claude", "claude-bidi"];
  }
  return normalizedToolId ? [normalizedToolId] : [];
}

function invalidateModelResponseCache(toolId = "") {
  modelResponseCacheGeneration += 1;
  const toolIds = getModelCacheToolIds(toolId);
  if (toolIds.length === 0) {
    modelResponseCache.clear();
    pendingModelResponseRequests.clear();
    return [];
  }
  for (const id of toolIds) {
    const prefix = `${id}\u0000`;
    for (const key of modelResponseCache.keys()) {
      if (key === id || key.startsWith(prefix)) modelResponseCache.delete(key);
    }
    for (const key of pendingModelResponseRequests.keys()) {
      if (key === id || key.startsWith(prefix)) pendingModelResponseRequests.delete(key);
    }
  }
  return toolIds;
}

function clearCurrentToolModelSelection() {
  if (typeof selectedModel !== "undefined") selectedModel = "";
  selectedModelIsInherited = false;
  if (typeof selectedEffort !== "undefined") selectedEffort = "";
  if (inlineModelSelect) {
    inlineModelSelect.value = "";
    syncCustomSelectBridge(inlineModelSelect);
  }
  const toolId = typeof selectedTool === "string" ? selectedTool : "";
  if (toolId) {
    try {
      localStorage.removeItem(`selectedModel_${toolId}`);
      localStorage.removeItem(`selectedEffort_${toolId}`);
    } catch (_) {}
  }
}

async function refreshModelCatalogForToolConfigChange(
  toolId,
  {
    preserveCurrentSelection = false,
    clearCurrentSelection = false,
  } = {},
) {
  const affectedToolIds = invalidateModelResponseCache(toolId);
  const currentToolId = typeof selectedTool === "string" ? selectedTool : "";
  if (currentToolId && affectedToolIds.includes(currentToolId)) {
    if (clearCurrentSelection) {
      clearCurrentToolModelSelection();
    }
    await loadModelsForCurrentTool({
      refresh: true,
      preserveCurrentSelection,
      ignoreSessionPreferences: clearCurrentSelection,
      ignoreStoredSelection: clearCurrentSelection,
    });
  }
}

window.ragentRefreshModelCatalogForTool = refreshModelCatalogForToolConfigChange;
window.ragentRefreshClaudeModelCatalog = function refreshClaudeModelCatalog(options = {}) {
  return refreshModelCatalogForToolConfigChange("claude-bidi", options);
};

async function fetchModelResponse(toolId, { refresh = false, providerProfile = "" } = {}) {
  if (!toolId) {
    return {
      models: [],
      effortLevels: null,
      defaultModel: null,
      reasoning: { kind: "none", label: t("tooling.thinking") },
    };
  }

  const cacheKey = getModelResponseCacheKey(toolId, providerProfile);
  if (!refresh && modelResponseCache.has(cacheKey)) {
    return modelResponseCache.get(cacheKey);
  }

  if (!refresh && pendingModelResponseRequests.has(cacheKey)) {
    return pendingModelResponseRequests.get(cacheKey);
  }

  const cacheGeneration = modelResponseCacheGeneration;
  const requestOptions = { revalidate: !refresh };
  if (refresh) requestOptions.cache = "no-store";
  let request = null;
  const providerQuery = String(providerProfile || "").trim()
    ? `&provider=${encodeURIComponent(String(providerProfile).trim())}`
    : "";
  const refreshQuery = refresh ? "&refresh=1" : "";
  request = fetchJsonOrRedirect(`/api/models?tool=${encodeURIComponent(toolId)}${providerQuery}${refreshQuery}`, requestOptions)
    .then((data) => {
      if (cacheGeneration === modelResponseCacheGeneration) {
        modelResponseCache.set(cacheKey, data);
      }
      return data;
    })
    .finally(() => {
      if (pendingModelResponseRequests.get(cacheKey) === request) {
        pendingModelResponseRequests.delete(cacheKey);
      }
    });

  pendingModelResponseRequests.set(cacheKey, request);
  return request;
}

async function loadInlineTools({ skipModelLoad = false } = {}) {
  if (!canChangeRuntimeSelectionFromUi()) {
    allToolsList = [];
    toolsList = [];
    selectedModel = null;
    selectedEffort = null;
    selectedServiceTier = "standard";
    selectedPermissionMode = null;
    inlineToolSelect.disabled = true;
    setSingleOption(inlineToolSelect, t("compose.agent.default") || "Agent");
    inlineModelSelect.disabled = true;
    setSingleOption(inlineModelSelect, t("tooling.defaultModel") || "Default model");
    inlineModelSelect.style.display = "none";
    effortSelect.disabled = true;
    setSingleOption(effortSelect, t("tooling.thinking") || "Thinking");
    effortSelect.style.display = "none";
    thinkingToggle.style.display = "none";
    syncComposerModeUi();
    return;
  }
  try {
    const data = await fetchJsonOrRedirect("/api/tools");
    allToolsList = Array.isArray(data.tools) ? data.tools : [];
    const initialTool = refreshPrimaryToolPicker();
    if (initialTool) {
      selectedTool = initialTool;
      if (!preferredTool || !toolsList.some((tool) => tool.id === preferredTool)) {
        preferredTool = initialTool;
        localStorage.setItem("preferredTool", preferredTool);
      }
      localStorage.setItem("selectedTool", selectedTool);
    }
    if (!skipModelLoad) {
      await loadModelsForCurrentTool();
    }
    void refreshInlineAgentPicker();
  } catch (err) {
    allToolsList = [];
    toolsList = [];
    console.warn("[tools] Failed to load tools:", err.message);
    renderInlineToolOptions("", t("settings.apps.loadingFailed"));
  }
}

window.ragentRefreshRuntimeCatalog = async function refreshRuntimeCatalog({ clearCurrentSelection = false } = {}) {
  if (!canChangeRuntimeSelectionFromUi()) return false;
  await loadInlineTools({ skipModelLoad: true });
  await loadModelsForCurrentTool({
    refresh: true,
    preserveCurrentSelection: !clearCurrentSelection,
    ignoreSessionPreferences: clearCurrentSelection,
    ignoreStoredSelection: clearCurrentSelection,
  });
  return true;
};

async function applyInlineToolSelection(nextTool, { deferModelLoad = false } = {}) {
  if (nextTool === ADD_MORE_TOOL_VALUE) {
    renderInlineToolOptions(resolvePreferredToolId(toolsList, [selectedTool, preferredTool]));
    openAddToolModal();
    return;
  }

  selectedTool = nextTool;
  const hasAttachedSession = typeof currentSessionId === "string" && !!currentSessionId;
  if (!hasAttachedSession) {
    preferredTool = selectedTool;
    localStorage.setItem("preferredTool", preferredTool);
    localStorage.setItem("selectedTool", selectedTool);
  }
  if (typeof window.syncGoalMenuVisibility === "function") {
    window.syncGoalMenuVisibility();
  }
  markCurrentSessionRuntimePreferencesEdited();
  if (!deferModelLoad) await loadModelsForCurrentTool();
  // Switching tools inside a session re-resolves provider/model from the
  // session (or the inherited last-anywhere selection). Record the resolved
  // pair as this tool's latest global selection so the next new session
  // starts where the user just landed.
  if (selectedTool) {
    const sessionPreferences = getAttachedSessionToolPreferences(selectedTool);
    rememberGlobalRuntimeSelection(
      selectedTool,
      sessionPreferences?.providerProfile || "",
      sessionPreferences?.model || "",
    );
  }
  syncComposerModeUi();
  queueRuntimeSelectionSync();
  persistCurrentSessionToolPreferences();
}

inlineToolSelect.addEventListener("change", async () => {
  await applyInlineToolSelection(inlineToolSelect.value);
});

if (inlineAgentSelect) {
  inlineAgentSelect.addEventListener("change", () => {
    const nextAgentId = inlineAgentSelect.value || "";
    const nextAgent = findInlineAgentById(nextAgentId);
    if (typeof setPreferredAgentTemplate === "function") {
      setPreferredAgentTemplate(nextAgentId, {
        name: nextAgent?.name || "",
      });
    }
    syncComposerModeUi();
    queueRuntimeSelectionSync();
    persistCurrentSessionToolPreferences();
  });
}

if (typeof composerModeChatBtn !== "undefined" && composerModeChatBtn) {
  composerModeChatBtn.addEventListener("click", () => {
    setComposerInteractionMode("chat");
  });
}

if (typeof composerModePlanBtn !== "undefined" && composerModePlanBtn) {
  composerModePlanBtn.addEventListener("click", () => {
    setComposerInteractionMode("plan");
  });
}

if (typeof composerRuntimeBtn !== "undefined" && composerRuntimeBtn) {
  composerRuntimeBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setComposerRuntimeMenuOpen(!composerRuntimeMenuOpen, {
      view: composerRuntimeMenuOpen ? composerRuntimeMenuView : "tools",
    });
  });
}

if (typeof composerPermissionBtn !== "undefined" && composerPermissionBtn) {
  composerPermissionBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setComposerPermissionMenuOpen(!composerPermissionMenuOpen);
  });
}

if (typeof composerRuntimeProviderBackBtn !== "undefined" && composerRuntimeProviderBackBtn) {
  composerRuntimeProviderBackBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setComposerRuntimeView("tools", "back");
    syncComposerRuntimeUi();
  });
}

if (typeof composerRuntimeModelBackBtn !== "undefined" && composerRuntimeModelBackBtn) {
  composerRuntimeModelBackBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setComposerRuntimeView(
      getComposerRuntimeProviderApp() ? "providers" : "tools",
      "back",
    );
    syncComposerRuntimeUi();
    if (getComposerRuntimeProviderApp()) void loadComposerRuntimeProviders();
  });
}

if (typeof composerRuntimePermissionBtn !== "undefined" && composerRuntimePermissionBtn) {
  composerRuntimePermissionBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setComposerRuntimeView("permissions", "forward");
    syncComposerRuntimeUi();
  });
}

if (typeof composerRuntimePermissionBackBtn !== "undefined" && composerRuntimePermissionBackBtn) {
  composerRuntimePermissionBackBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setComposerRuntimeView("models", "back");
    syncComposerRuntimeUi();
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", (event) => {
    if (!composerRuntimeMenuOpen && !composerPermissionMenuOpen && !composerRuntimeSpeedPanelOpen) return;
    if (
      composerRuntimeControls?.contains?.(event.target)
      || composerRuntimeMenu?.contains?.(event.target)
      || composerPermissionMenu?.contains?.(event.target)
      || composerRuntimeSpeedPanel?.contains?.(event.target)
    ) {
      return;
    }
    if (composerRuntimeSpeedPanelOpen) {
      composerRuntimeSpeedPanelOpen = false;
      syncComposerRuntimeUi();
    }
    setComposerRuntimeMenuOpen(false);
    setComposerPermissionMenuOpen(false);
  }, true);
  document.addEventListener("keydown", (event) => {
    if ((!composerRuntimeMenuOpen && !composerPermissionMenuOpen && !composerRuntimeSpeedPanelOpen) || event.key !== "Escape") return;
    if (composerRuntimeSpeedPanelOpen) {
      composerRuntimeSpeedPanelOpen = false;
      syncComposerRuntimeUi();
      composerRuntimeSpeedBtn?.focus?.();
      return;
    }
    const shouldFocusPermission = composerPermissionMenuOpen;
    setComposerRuntimeMenuOpen(false);
    setComposerPermissionMenuOpen(false);
    if (shouldFocusPermission) {
      composerPermissionBtn?.focus?.();
    } else {
      composerRuntimeBtn?.focus?.();
    }
  }, true);
}

window.addEventListener("ragent:preferred-agent-change", () => {
  void refreshInlineAgentPicker();
});

window.addEventListener("ragent:localechange", () => {
  void refreshInlineAgentPicker();
  syncComposerModeUi();
});

// ---- Model select ----
async function loadModelsForCurrentTool({
  refresh = false,
  preserveCurrentSelection = false,
  ignoreSessionPreferences = false,
  ignoreStoredSelection = false,
} = {}) {
  if (!canChangeRuntimeSelectionFromUi()) {
    currentToolModels = [];
    currentToolBaseReasoning = { kind: "none", label: t("tooling.thinking") };
    currentToolEffortLevels = null;
    currentToolServiceTiers = ['standard'];
    currentToolReasoningKind = "none";
    currentToolReasoningLabel = t("tooling.thinking");
    currentToolReasoningDefault = null;
    selectedEffort = null;
    selectedPermissionMode = null;
    selectedServiceTier = "standard";
    setSingleOption(inlineModelSelect, t("tooling.defaultModel") || "Default model");
    inlineModelSelect.style.display = "none";
    syncCustomSelectBridge(inlineModelSelect);
    effortSelect.disabled = true;
    setSingleOption(effortSelect, t("tooling.thinking") || "Thinking");
    thinkingToggle.style.display = "none";
    effortSelect.style.display = "none";
    syncCustomSelectBridge(effortSelect);
    if (serviceTierSelect) {
      serviceTierSelect.disabled = true;
      serviceTierSelect.style.display = "none";
      syncCustomSelectBridge(serviceTierSelect);
    }
    setCurrentToolCatalogState({ status: "unavailable" });
    syncComposerModeUi();
    return;
  }
  const toolId = selectedTool;
  if (!selectedTool) {
    currentToolModels = [];
    currentToolBaseReasoning = { kind: "none", label: t("tooling.thinking") };
    currentToolEffortLevels = null;
    currentToolServiceTiers = ['standard'];
    currentToolReasoningKind = "none";
    currentToolReasoningLabel = t("tooling.thinking");
    currentToolReasoningDefault = null;
    selectedModel = null;
    selectedEffort = null;
    selectedServiceTier = "standard";
    selectedPermissionMode = null;
    setSingleOption(inlineModelSelect, t("tooling.defaultModel") || "Default model");
    inlineModelSelect.style.display = "none";
    syncCustomSelectBridge(inlineModelSelect);
    effortSelect.disabled = true;
    setSingleOption(effortSelect, t("tooling.thinking") || "Thinking");
    thinkingToggle.style.display = "none";
    effortSelect.style.display = "none";
    syncCustomSelectBridge(effortSelect);
    if (serviceTierSelect) {
      serviceTierSelect.disabled = true;
      serviceTierSelect.style.display = "none";
      syncCustomSelectBridge(serviceTierSelect);
    }
    setCurrentToolCatalogState({ status: "unavailable" });
    syncComposerModeUi();
    return;
  }
  setCurrentToolCatalogState({ status: "loading" });
  try {
    const sessionPreferences = ignoreSessionPreferences ? null : getAttachedSessionToolPreferences(toolId);
    if (sessionPreferences?.providerProfile) {
      try {
        localStorage.setItem(`selectedProvider_${toolId}`, sessionPreferences.providerProfile);
      } catch {}
    }
    const selectedProvider = sessionPreferences?.providerProfile
      || (typeof getLastGlobalRuntimeSelection === "function"
        ? getLastGlobalRuntimeSelection(toolId)?.providerProfile
        : "")
      || (() => {
        try { return (localStorage.getItem(`selectedProvider_${toolId}`) || "").trim(); } catch { return ""; }
      })();
    const data = await fetchModelResponse(toolId, { refresh, providerProfile: selectedProvider });
    if (selectedTool !== toolId) return;
    setCurrentToolCatalogState(normalizeComposerRuntimeModelCatalogState(data, selectedProvider));
    currentToolModels = filterModelsForSessionProvider(toolId, data.models || [], sessionPreferences);
    // An inherited provider (session never pinned one) may resolve to zero
    // usable models — e.g. the provider was deleted, or its credential went
    // away. filterModelsForSessionProvider deliberately empties the list in
    // that case (better an explicit empty sheet than silently routing through
    // the wrong provider config); drop the inheritance so the composer falls
    // back to the unscoped catalog instead of locking the user out.
    if (
      sessionPreferences?.inheritedProviderProfile
      && sessionPreferences.providerProfile
      && currentToolModels.length === 0
      && Array.isArray(data.models)
      && data.models.length > 0
    ) {
      sessionPreferences.providerProfile = "";
      currentToolModels = filterModelsForSessionProvider(toolId, data.models, sessionPreferences);
      setCurrentToolCatalogState(normalizeComposerRuntimeModelCatalogState(data));
    }
    selectedModelIsInherited = false;
    currentToolBaseReasoning =
      cloneReasoningState(data.reasoning)
      || (data.effortLevels
        ? {
          kind: "enum",
          label: t("tooling.thinking"),
          levels: data.effortLevels || [],
          default: data.effortLevels?.[0] || null,
        }
        : { kind: "none", label: t("tooling.thinking") });

    // Populate model dropdown
    inlineModelSelect.innerHTML = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = t("tooling.defaultModel");
    inlineModelSelect.appendChild(defaultOpt);
    for (const m of currentToolModels) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      inlineModelSelect.appendChild(opt);
    }
    // Restore saved model for this tool
    const savedSelection = ignoreStoredSelection
      ? null
      : (typeof getLastGlobalRuntimeSelection === "function"
        ? getLastGlobalRuntimeSelection(toolId)
        : null);
    const savedModel = savedSelection
      ? (typeof savedSelection.model === "string" ? savedSelection.model : "")
      : (ignoreStoredSelection ? "" : (localStorage.getItem(`selectedModel_${toolId}`) || ""));
    const providerDefaultModel = currentToolModels[0]?.id || "";
    const catalogDefaultModel = data?.catalog?.defaultModel || "";
    const defaultModel = currentToolModels.find((model) => (
      model.id === data.defaultModel
      || (catalogDefaultModel && (
        model.model === catalogDefaultModel
        || parseScopedModelProvider(model.id).model === catalogDefaultModel
      ))
    ))?.id || providerDefaultModel;
    const preservedModel = preserveCurrentSelection && typeof selectedModel === "string"
      ? selectedModel
      : "";
    // Selection precedence: session's own model > inherited "last selection
    // anywhere" model (via sessionPreferences.model when inheritedModel) >
    // preserved current > legacy per-tool stored model.
    selectedModel = (sessionPreferences?.hasModel || sessionPreferences?.inheritedModel)
      ? sessionPreferences.model
      : (preservedModel || savedModel);
    if (selectedModel && currentToolModels.some((m) => m.id === selectedModel)) {
      inlineModelSelect.value = selectedModel;
    } else if (defaultModel && currentToolModels.some((m) => m.id === defaultModel)) {
      inlineModelSelect.value = defaultModel;
      selectedModel = defaultModel;
    } else {
      inlineModelSelect.value = "";
      selectedModel = "";
    }
    selectedModelIsInherited = Boolean(
      sessionPreferences?.inheritedModel
      && selectedModel
      && selectedModel === sessionPreferences.model
      && currentToolModels.some((model) => model.id === selectedModel),
    );
    inlineModelSelect.style.display = currentToolModels.length > 0 ? "" : "none";
    inlineModelSelect.disabled = currentToolModels.length === 0;
    syncCustomSelectBridge(inlineModelSelect);
    refreshComposerRuntimeModelOptions();
    applyCurrentModelReasoningUi({ sessionPreferences, preserveCurrentSelection });
    applyCurrentToolPermissionModeUi({ sessionPreferences });
    syncComposerModeUi();
    queueRuntimeSelectionSync();
  } catch {
    currentToolModels = [];
    currentToolBaseReasoning = { kind: "none", label: t("tooling.thinking") };
    currentToolEffortLevels = null;
    currentToolServiceTiers = ['standard'];
    currentToolReasoningKind = "none";
    selectedServiceTier = "standard";
    selectedPermissionMode = null;
    inlineModelSelect.disabled = true;
    setSingleOption(inlineModelSelect, t("tooling.defaultModel") || "Default model");
    inlineModelSelect.style.display = "none";
    syncCustomSelectBridge(inlineModelSelect);
    effortSelect.disabled = true;
    setSingleOption(effortSelect, t("tooling.thinking") || "Thinking");
    thinkingToggle.style.display = "none";
    effortSelect.style.display = "none";
    syncCustomSelectBridge(effortSelect);
    if (serviceTierSelect) {
      serviceTierSelect.disabled = true;
      serviceTierSelect.style.display = "none";
      syncCustomSelectBridge(serviceTierSelect);
    }
    setCurrentToolCatalogState({ status: "unavailable", hasError: true });
    syncComposerModeUi();
  }
}

inlineModelSelect.addEventListener("change", () => {
  selectedModel = inlineModelSelect.value;
  selectedModelIsInherited = false;
  if (selectedTool) {
    localStorage.setItem(`selectedModel_${selectedTool}`, selectedModel);
    // Picking a (possibly provider-scoped) model updates the "last selection
    // anywhere" pair so future sessions inherit it.
    const providerFromModel = parseScopedModelProvider(selectedModel).providerId;
    const sessionPreferences = getAttachedSessionToolPreferences(selectedTool);
    const currentProvider = sessionPreferences?.providerProfile
      || (localStorage.getItem(`selectedProvider_${selectedTool}`) || "").trim();
    rememberGlobalRuntimeSelection(
      selectedTool,
      providerFromModel || currentProvider,
      selectedModel,
    );
  }
  markCurrentSessionRuntimePreferencesEdited();
  applyCurrentModelReasoningUi({ preserveCurrentSelection: true });
  syncComposerModeUi();
  queueRuntimeSelectionSync();
  persistCurrentSessionToolPreferences();
});

addToolNameInput.addEventListener("input", () => {
  syncAddToolModal();
});

addToolCommandInput.addEventListener("input", () => {
  syncAddToolModal();
});

addToolRuntimeFamilySelect.addEventListener("change", () => {
  syncAddToolModal();
});

addToolModelsInput.addEventListener("input", () => {
  syncAddToolModal();
});

addToolReasoningKindSelect.addEventListener("change", () => {
  syncAddToolModal();
});

addToolReasoningLevelsInput.addEventListener("input", () => {
  syncAddToolModal();
});

closeAddToolModalBtn.addEventListener("click", closeAddToolModal);
closeAddToolModalFooterBtn.addEventListener("click", closeAddToolModal);
addToolModal.addEventListener("click", (e) => {
  if (e.target === addToolModal) closeAddToolModal();
});

saveToolConfigBtn.addEventListener("click", saveSimpleToolConfig);

copyProviderPromptBtn.addEventListener("click", async () => {
  try {
    await copyText(buildProviderBasePrompt());
    updateCopyButtonLabel(copyProviderPromptBtn, t("action.copied"));
  } catch (err) {
    console.warn("[copy] Failed to copy provider prompt:", err.message);
  }
});

if (forkSessionBtn) {
  forkSessionBtn.addEventListener("click", forkCurrentSession);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && addToolModal && !addToolModal.hidden) {
    closeAddToolModal();
  }
});
