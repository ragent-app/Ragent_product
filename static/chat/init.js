// ---- System toast notifications ----
function showSystemToast(message, level = "info") {
  const container = document.getElementById("system-toast-container")
    || (() => {
      const el = document.createElement("div");
      el.id = "system-toast-container";
      el.className = "system-toast-container";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.setAttribute("aria-atomic", "true");
      document.body.appendChild(el);
      return el;
    })();
  const toast = document.createElement("button");
  const normalizedLevel = ["error", "warn", "info"].includes(level) ? level : "info";
  toast.type = "button";
  toast.className = "system-toast";
  toast.dataset.level = normalizedLevel;
  toast.setAttribute("aria-label", message);
  const messageNode = document.createElement("span");
  messageNode.className = "system-toast__message";
  messageNode.textContent = message;
  const closeNode = document.createElement("span");
  closeNode.className = "system-toast__close";
  closeNode.setAttribute("aria-hidden", "true");
  closeNode.innerHTML = window.RagentIcons?.render?.("close", {
    className: "system-toast__close-icon",
  }) || "×";
  toast.append(messageNode, closeNode);

  let dismissed = false;
  let gesture = null;
  let gestureFrame = null;
  let snapBackTimer = null;
  let autoDismissTimer = null;

  const setToastMotion = (offsetX, opacity) => {
    toast.style.transform = `translate3d(${offsetX}px, 0, 0)`;
    toast.style.opacity = String(opacity);
  };

  const cancelGestureFrame = () => {
    if (gestureFrame === null) return;
    window.cancelAnimationFrame?.(gestureFrame);
    gestureFrame = null;
  };

  const cancelSnapBack = () => {
    if (snapBackTimer === null) return;
    clearTimeout(snapBackTimer);
    snapBackTimer = null;
  };

  const interruptMotion = () => {
    cancelSnapBack();
    cancelGestureFrame();
    const computed = typeof window.getComputedStyle === "function" ? window.getComputedStyle(toast) : null;
    if (computed?.transform && computed.transform !== "none") toast.style.transform = computed.transform;
    if (computed?.opacity && computed.opacity !== "1") toast.style.opacity = computed.opacity;
    toast.classList.remove("is-leaving", "is-leaving-right", "is-snap-back");
  };

  const applyGestureMotion = (current) => {
    if (!current || gesture !== current || current.axis !== "horizontal") return;
    const progress = Math.min(1, current.offsetX / Math.max(88, current.width * 0.35));
    setToastMotion(current.offsetX, 1 - progress * 0.18);
  };

  const scheduleGestureMotion = () => {
    if (!gesture || gestureFrame !== null) return;
    if (typeof window.requestAnimationFrame !== "function") {
      applyGestureMotion(gesture);
      return;
    }
    const current = gesture;
    gestureFrame = window.requestAnimationFrame(() => {
      gestureFrame = null;
      applyGestureMotion(current);
    });
  };

  const snapBack = () => {
    if (dismissed) return;
    cancelSnapBack();
    cancelGestureFrame();
    toast.classList.remove("is-dragging");
    toast.classList.add("is-snap-back");
    setToastMotion(0, 1);
    snapBackTimer = setTimeout(() => {
      snapBackTimer = null;
      toast.classList.remove("is-snap-back");
      toast.style.removeProperty("transform");
      toast.style.removeProperty("opacity");
    }, 260);
  };

  const dismiss = ({ swipe = false, offsetX = 0 } = {}) => {
    if (dismissed) return;
    dismissed = true;
    if (autoDismissTimer !== null) clearTimeout(autoDismissTimer);
    cancelSnapBack();
    cancelGestureFrame();
    if (gesture) {
      try { toast.releasePointerCapture?.(gesture.pointerId); } catch {}
      gesture = null;
    }
    toast.classList.remove("is-dragging", "is-snap-back", "is-leaving");
    if (swipe) {
      setToastMotion(offsetX, toast.style.opacity || 1);
      toast.classList.add("is-leaving-right");
      requestAnimationFrame(() => {
        toast.style.transform = "translate3d(110%, 0, 0)";
        toast.style.opacity = "0";
      });
      setTimeout(() => toast.remove(), 240);
      return;
    }
    toast.style.removeProperty("transform");
    toast.style.removeProperty("opacity");
    toast.classList.add("is-leaving");
    setTimeout(() => toast.remove(), 180);
  };

  const beginGesture = (event) => {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (dismissed || gesture) return;
    interruptMotion();
    toast.classList.add("is-visible");
    const rect = toast.getBoundingClientRect?.();
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastTime: Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now(),
      offsetX: 0,
      moved: false,
      width: Number.isFinite(rect?.width) && rect.width > 0 ? rect.width : 320,
      axis: "",
    };
    toast.classList.add("is-dragging");
    try { toast.setPointerCapture?.(event.pointerId); } catch {}
  };

  const updateGesture = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId
        || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 8) {
      gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.15 && dx > 0 ? "horizontal" : "cancelled";
    }
    if (gesture.axis === "cancelled") {
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 8) {
        gesture.moved = true;
        toast.__systemToastSuppressClick = true;
        event.preventDefault?.();
      }
      return;
    }
    if (gesture.axis !== "horizontal") return;
    gesture.moved = dx > 8;
    gesture.offsetX = Math.max(0, Math.min(gesture.width, dx));
    gesture.lastX = event.clientX;
    gesture.lastTime = Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now();
    scheduleGestureMotion();
    event.preventDefault?.();
  };

  const finishGesture = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const current = gesture;
    cancelGestureFrame();
    applyGestureMotion(current);
    gesture = null;
    try { toast.releasePointerCapture?.(event.pointerId); } catch {}
    if (current.axis === "horizontal" && current.moved) {
      toast.__systemToastSuppressClick = true;
      const now = Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now();
      const velocity = (current.lastX - event.clientX) / Math.max(1, now - current.lastTime);
      const threshold = Math.max(88, Math.min(220, current.width * 0.35));
      if (current.offsetX >= threshold || velocity > 0.45) {
        event.preventDefault?.();
        dismiss({ swipe: true, offsetX: current.offsetX });
        return;
      }
      snapBack();
      event.preventDefault?.();
      return;
    }
    toast.classList.remove("is-dragging");
    toast.style.removeProperty("transform");
    toast.style.removeProperty("opacity");
    if (current.axis === "cancelled" || current.moved) toast.__systemToastSuppressClick = true;
  };

  const cancelGesture = (event) => {
    if (!gesture || (event.pointerId != null && event.pointerId !== gesture.pointerId)) return;
    const current = gesture;
    gesture = null;
    cancelGestureFrame();
    try { toast.releasePointerCapture?.(event.pointerId); } catch {}
    if (current) snapBack();
  };

  toast.addEventListener("pointerdown", beginGesture);
  toast.addEventListener("pointermove", updateGesture);
  toast.addEventListener("pointerup", finishGesture);
  toast.addEventListener("pointercancel", cancelGesture);
  toast.onclick = () => {
    if (toast.__systemToastSuppressClick) {
      toast.__systemToastSuppressClick = false;
      return;
    }
    dismiss();
  };
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.classList.add("is-visible"); });
  autoDismissTimer = setTimeout(dismiss, normalizedLevel === "error" ? 8000 : 5000);
}

// ---- Visitor mode setup ----
function applyVisitorMode(authInfo = null) {
  visitorMode = true;
  scopedRequestMode = false;
  surfaceMode = "visitor";
  principalKind = "visitor";
  principalId = typeof authInfo?.principalId === "string" && authInfo.principalId.trim()
    ? authInfo.principalId.trim()
    : (typeof authInfo?.visitorId === "string" ? authInfo.visitorId.trim() : "");
  authCapabilities = cloneAuthCapabilityDefaults("visitor");
  scopedAgentContext = null;
  if (typeof authInfo?.sessionId === "string" && authInfo.sessionId.trim()) {
    visitorSessionId = authInfo.sessionId.trim();
  }
  selectedTool = null;
  selectedModel = null;
  selectedEffort = null;
  document.body.classList.add("visitor-mode");
  // Hide sidebar toggle, new session button, and management UI
  if (menuBtn) menuBtn.style.display = "none";
  if (sortSessionListBtn) sortSessionListBtn.style.display = "none";
  if (newSessionBtn) newSessionBtn.style.display = "none";
  if (workspacePicker) workspacePicker.style.display = "none";
  // Hide tool/model selectors and context management (visitors use defaults)
  if (inlineAgentSelect) inlineAgentSelect.style.display = "none";
  if (inlineToolSelect) inlineToolSelect.style.display = "none";
  if (inlineModelSelect) inlineModelSelect.style.display = "none";
  if (effortSelect) effortSelect.style.display = "none";
  if (serviceTierSelect) serviceTierSelect.style.display = "none";
  if (thinkingToggle) thinkingToggle.style.display = "none";
  if (compactBtn) compactBtn.style.display = "none";
  if (dropToolsBtn) dropToolsBtn.style.display = "none";
  if (contextTokens) contextTokens.style.display = "none";
  if (typeof requestLayoutPass === "function") {
    requestLayoutPass("visitor-mode");
  } else if (typeof syncInputHeightForLayout === "function") {
    syncInputHeightForLayout();
  }
  syncForkButton();
  syncShareButton();
  if (typeof syncMobileDisclosureState === "function") {
    syncMobileDisclosureState();
  }
}

function applyAgentScopedMode(authInfo = null) {
  visitorMode = false;
  scopedRequestMode = true;
  surfaceMode = "agent_scoped";
  principalKind = typeof authInfo?.principalKind === "string" && authInfo.principalKind.trim()
    ? authInfo.principalKind.trim()
    : "agent_guest";
  principalId = typeof authInfo?.principalId === "string" && authInfo.principalId.trim()
    ? authInfo.principalId.trim()
    : (typeof authInfo?.visitorId === "string" ? authInfo.visitorId.trim() : "");
  authCapabilities = authInfo?.capabilities && typeof authInfo.capabilities === "object"
    ? { ...authInfo.capabilities }
    : cloneAuthCapabilityDefaults("agent_scoped");
  scopedAgentContext = authInfo?.currentAgent && typeof authInfo.currentAgent === "object"
    ? {
      id: typeof authInfo.currentAgent.id === "string" ? authInfo.currentAgent.id.trim() : "",
      name: typeof authInfo.currentAgent.name === "string" ? authInfo.currentAgent.name.trim() : "",
      tool: typeof authInfo.currentAgent.tool === "string" ? authInfo.currentAgent.tool.trim() : "",
    }
    : {
      id: typeof authInfo?.agentId === "string" ? authInfo.agentId.trim() : "",
      name: "",
      tool: "",
    };
  document.body.classList.remove("visitor-mode");
  document.body.classList.add("agent-scoped-mode");

  if (scopedAgentContext?.id && typeof setPreferredAgentTemplate === "function") {
    setPreferredAgentTemplate(scopedAgentContext.id, {
      name: scopedAgentContext.name || "",
      persist: false,
    });
  }

  if (scopedAgentContext?.tool) {
    preferredTool = scopedAgentContext.tool;
    selectedTool = scopedAgentContext.tool;
    selectedModel = "";
    selectedEffort = null;
  }

  if (menuBtn) menuBtn.style.display = "";
  if (newSessionBtn) newSessionBtn.style.display = hasAuthCapability("createSession") ? "" : "none";
  if (sortSessionListBtn) sortSessionListBtn.style.display = canOrganizeSessionList() ? "" : "none";
  if (workspacePicker) workspacePicker.style.display = hasAuthCapability("createSession") ? "" : "none";
  if (tabAgents) tabAgents.style.display = "none";
  if (agentsPanel) agentsPanel.style.display = "none";
  if (typeof modelProvidersPanel !== "undefined" && modelProvidersPanel) {
    modelProvidersPanel.style.display = "none";
    modelProvidersPanel.hidden = true;
  }
  if (inlineAgentSelect) inlineAgentSelect.style.display = canSwitchAgents() ? "" : "none";
  if (inlineToolSelect) inlineToolSelect.style.display = canChangeRuntimeSelection() ? "" : "none";
  if (inlineModelSelect) inlineModelSelect.style.display = canChangeRuntimeSelection() ? inlineModelSelect.style.display : "none";
  if (effortSelect) effortSelect.style.display = canChangeRuntimeSelection() ? effortSelect.style.display : "none";
  if (serviceTierSelect) serviceTierSelect.style.display = canChangeRuntimeSelection() ? serviceTierSelect.style.display : "none";
  if (thinkingToggle) thinkingToggle.style.display = canChangeRuntimeSelection() ? thinkingToggle.style.display : "none";
  if (compactBtn) compactBtn.style.display = "none";
  if (dropToolsBtn) dropToolsBtn.style.display = "none";
  if (contextTokens) contextTokens.style.display = "none";
  if (saveTemplateBtn) saveTemplateBtn.style.display = "none";
  if (sessionTemplateRow) sessionTemplateRow.style.display = "none";
  const activeSidebarTab = typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : null;
  if (["agents", "model-providers"].includes(activeSidebarTab) && typeof switchTab === "function") {
    switchTab("sessions");
  }
  if (typeof requestLayoutPass === "function") {
    requestLayoutPass("agent-scoped-mode");
  } else if (typeof syncInputHeightForLayout === "function") {
    syncInputHeightForLayout();
  }
  syncForkButton();
  syncShareButton();
  if (typeof syncMobileDisclosureState === "function") {
    syncMobileDisclosureState();
  }
}

function applyShareSnapshotMode(snapshot) {
  shareSnapshotMode = true;
  shareSnapshotPayload = snapshot;
  applyVisitorMode();
  document.body.classList.add("share-snapshot-mode");
  if (msgInput) {
    msgInput.dataset.i18nPlaceholder = "input.placeholder.readOnlySnapshot";
    msgInput.placeholder = t("input.placeholder.readOnlySnapshot");
  }
}

// ---- Init ----
initResponsiveLayout();

const MOBILE_INSTALL_SKIP_STORAGE_KEY = "ragent.mobileInstall.skipUntil";
const MOBILE_INSTALL_SKIP_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const QUICK_ENTRY_FOCUS_PROMPT_DELAY_MS = 420;
const QUICK_ENTRY_FOCUS_RETRY_DELAY_MS = 160;
let quickEntryFocusPromptTimer = 0;
let quickEntryFocusRetryTimer = 0;
let quickEntryFocusLayoutUnsubscribe = null;

function replaceUrlPreservingHistoryState(url) {
  const currentState = history.state && typeof history.state === "object"
    ? history.state
    : null;
  history.replaceState(currentState, "", url);
}

function isMobileInstallEligibleDevice() {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod|Android/i.test(ua);
}

function isStandaloneDisplayMode() {
  return !!(
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches)
    || navigator.standalone === true
  );
}

function getInstallFlowState() {
  return {
    standalone: isStandaloneDisplayMode(),
    mobileEligible: isMobileInstallEligibleDevice(),
    path: String(window.location?.pathname || ""),
  };
}

function captureInstallSkipIntent() {
  const url = new URL(window.location.href);
  if (url.searchParams.get("skipInstall") !== "1") return;
  try {
    localStorage.setItem(
      MOBILE_INSTALL_SKIP_STORAGE_KEY,
      String(Date.now() + MOBILE_INSTALL_SKIP_DURATION_MS),
    );
  } catch {}
  url.searchParams.delete("skipInstall");
  replaceUrlPreservingHistoryState(`${url.pathname}${url.search}`);
}

function hasRecentInstallSkip() {
  try {
    const until = Number(localStorage.getItem(MOBILE_INSTALL_SKIP_STORAGE_KEY) || 0);
    if (!Number.isFinite(until) || until <= 0) return false;
    if (until <= Date.now()) {
      localStorage.removeItem(MOBILE_INSTALL_SKIP_STORAGE_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function shouldOpenMobileInstallFlow(authInfo) {
  const pathname = String(window.location?.pathname || "");
  return !!(
    authInfo
    && authInfo.role === "owner"
    && !visitorMode
    && !shareSnapshotMode
    && isMobileInstallEligibleDevice()
    && !isStandaloneDisplayMode()
    && !pathname.endsWith("/m/install")
    && !hasRecentInstallSkip()
  );
}

async function openInstallFlow({ source = "manual", replace = false } = {}) {
  const state = getInstallFlowState();

  if (state.standalone) {
    showSystemToast("Ragent is already running as an installed app.");
    return false;
  }

  if (typeof ensureServiceWorkerRegistration === "function") {
    await ensureServiceWorkerRegistration();
  }

  const installUrl = typeof window.ragentResolveProductPath === "function"
    ? window.ragentResolveProductPath(`/m/install?source=${encodeURIComponent(source)}`)
    : `m/install?source=${encodeURIComponent(source)}`;
  if (replace) {
    window.location.replace(installUrl);
  } else {
    window.location.assign(installUrl);
  }
  return true;
}

window.ragentGetInstallFlowState = getInstallFlowState;
window.ragentOpenInstallFlow = openInstallFlow;

function getQuickEntryFocusPromptEls() {
  return {
    prompt: document.getElementById("quickEntryFocusPrompt"),
    button: document.getElementById("quickEntryFocusBtn"),
  };
}

function clearQuickEntryFocusTimers() {
  if (quickEntryFocusPromptTimer) {
    clearTimeout(quickEntryFocusPromptTimer);
    quickEntryFocusPromptTimer = 0;
  }
  if (quickEntryFocusRetryTimer) {
    clearTimeout(quickEntryFocusRetryTimer);
    quickEntryFocusRetryTimer = 0;
  }
}

function clearQuickEntryFocusRecovery() {
  clearQuickEntryFocusTimers();
  if (typeof quickEntryFocusLayoutUnsubscribe === "function") {
    quickEntryFocusLayoutUnsubscribe();
  }
  quickEntryFocusLayoutUnsubscribe = null;
  const { prompt } = getQuickEntryFocusPromptEls();
  if (prompt) {
    prompt.hidden = true;
  }
}

function getQuickEntryLayoutState() {
  if (window.RagentLayout?.syncNow) {
    return window.RagentLayout.syncNow("quick-entry-focus-check");
  }
  if (window.RagentLayout?.getState) {
    return window.RagentLayout.getState();
  }
  return {
    isDesktop: typeof isDesktop === "boolean" ? isDesktop : false,
    keyboardOpen: document.body?.classList?.contains("keyboard-open") === true,
  };
}

function canAttemptQuickEntryComposerFocus() {
  if (visitorMode || shareSnapshotMode || !msgInput || msgInput.disabled) {
    return false;
  }
  const layoutState = getQuickEntryLayoutState();
  return !layoutState?.isDesktop;
}

function shouldShowQuickEntryFocusPrompt() {
  if (!canAttemptQuickEntryComposerFocus()) {
    return false;
  }
  const layoutState = getQuickEntryLayoutState();
  if (layoutState?.keyboardOpen) {
    return false;
  }
  return !(typeof msgInput.value === "string" && msgInput.value.trim());
}

function attemptQuickEntryComposerFocus() {
  if (!msgInput || msgInput.disabled) {
    return false;
  }
  let focused = false;
  if (typeof focusComposer === "function") {
    focused = focusComposer({ force: true, preventScroll: true }) === true;
  } else if (typeof msgInput.focus === "function") {
    try {
      msgInput.focus({ preventScroll: true });
    } catch {
      msgInput.focus();
    }
    focused = true;
  }
  if (focused && typeof msgInput.setSelectionRange === "function") {
    const cursor = typeof msgInput.value === "string" ? msgInput.value.length : 0;
    try {
      msgInput.setSelectionRange(cursor, cursor);
    } catch {}
  }
  if (focused && navigator.virtualKeyboard?.show) {
    try {
      navigator.virtualKeyboard.show();
    } catch {}
  }
  return focused;
}

function syncQuickEntryFocusPromptVisibility() {
  const { prompt } = getQuickEntryFocusPromptEls();
  if (!prompt) {
    return false;
  }
  const shouldShow = shouldShowQuickEntryFocusPrompt();
  if (window.RagentMotion?.setPresence) {
    window.RagentMotion.setPresence(prompt, shouldShow, {
      duration: 140,
    });
  } else {
    prompt.hidden = !shouldShow;
  }
  return shouldShow;
}

function beginQuickEntryFocusRecovery() {
  clearQuickEntryFocusRecovery();
  if (!canAttemptQuickEntryComposerFocus()) {
    return false;
  }
  attemptQuickEntryComposerFocus();
  if (window.RagentLayout?.subscribe) {
    quickEntryFocusLayoutUnsubscribe = window.RagentLayout.subscribe((state) => {
      if (state?.keyboardOpen) {
        clearQuickEntryFocusRecovery();
      }
    });
  }
  const { prompt } = getQuickEntryFocusPromptEls();
  if (!prompt) {
    return true;
  }
  if (!shouldShowQuickEntryFocusPrompt()) {
    return true;
  }
  quickEntryFocusPromptTimer = setTimeout(() => {
    quickEntryFocusPromptTimer = 0;
    if (!syncQuickEntryFocusPromptVisibility()) {
      clearQuickEntryFocusRecovery();
    }
  }, QUICK_ENTRY_FOCUS_PROMPT_DELAY_MS);
  return true;
}

function wireQuickEntryFocusPrompt() {
  const { button } = getQuickEntryFocusPromptEls();
  if (button && !button.dataset.bound) {
    button.dataset.bound = "1";
    button.addEventListener("click", () => {
      attemptQuickEntryComposerFocus();
      quickEntryFocusRetryTimer = setTimeout(() => {
        quickEntryFocusRetryTimer = 0;
        if (!syncQuickEntryFocusPromptVisibility()) {
          clearQuickEntryFocusRecovery();
        }
      }, QUICK_ENTRY_FOCUS_RETRY_DELAY_MS);
    });
  }
  if (msgInput && !msgInput.dataset.quickEntryFocusBound) {
    msgInput.dataset.quickEntryFocusBound = "1";
    msgInput.addEventListener("input", () => {
      clearQuickEntryFocusRecovery();
    });
  }
}

function consumeLaunchIntent() {
  const url = new URL(window.location.href);
  const intent = (url.searchParams.get("intent") || "").trim().toLowerCase();
  if (intent !== "new-session") {
    return null;
  }
  url.searchParams.delete("intent");
  replaceUrlPreservingHistoryState(`${url.pathname}${url.search}${url.hash}`);
  return {
    type: "new-session",
  };
}

function prepareOwnerLaunchIntentBootstrap(launchIntent) {
  if (!launchIntent || launchIntent.type !== "new-session" || visitorMode) {
    return;
  }
  pendingNavigationState = null;
  if (typeof setChatCurrentSession === "function") {
    setChatCurrentSession(null, { hasAttachedSession: false });
  } else {
    currentSessionId = null;
    hasAttachedSession = false;
  }
}

async function handleOwnerLaunchIntent(launchIntent) {
  if (!launchIntent || launchIntent.type !== "new-session") {
    return false;
  }
  const created = await createNewSessionShortcut({
    closeSidebar: true,
    forceComposerFocus: true,
    sourceContext: {
      channel: "pwa_shortcut",
      entrypoint: "manifest_shortcut",
      shortcutId: "new_session",
      launchIntent: "new_session",
    },
  });
  if (created) {
    beginQuickEntryFocusRecovery();
  }
  return created;
}

async function resolveInitialAuthInfo() {
  const bootstrapAuthInfo =
    typeof getBootstrapAuthInfo === "function"
      ? getBootstrapAuthInfo()
      : null;
  if (bootstrapAuthInfo) {
    return bootstrapAuthInfo;
  }
  try {
    return await fetchJsonOrRedirect("/api/auth/me");
  } catch {
    return null;
  }
}

async function initApp() {
  captureInstallSkipIntent();
  wireQuickEntryFocusPrompt();

  const shareSnapshot =
    typeof getBootstrapShareSnapshot === "function"
      ? getBootstrapShareSnapshot()
      : null;
  if (shareSnapshot) {
    applyShareSnapshotMode(shareSnapshot);
    syncAddToolModal();
    syncForkButton();
    syncShareButton();
    await bootstrapShareSnapshotView();
    return;
  }

  const authInfo = await resolveInitialAuthInfo();

  const url = new URL(window.location.href);
  if (url.searchParams.has("visitor")) {
    url.searchParams.delete("visitor");
    replaceUrlPreservingHistoryState(`${url.pathname}${url.search}`);
  }

  if (authInfo?.surfaceMode === "agent_scoped") {
    applyAgentScopedMode(authInfo);
  } else if (authInfo?.role === "visitor") {
    applyVisitorMode(authInfo);
  }

  syncAddToolModal();
  syncForkButton();
  syncShareButton();
  if (visitorMode) {
    await bootstrapViaHttp();
    connect();
    setupForegroundRefreshHandlers();
    return;
  }

  if (shouldOpenMobileInstallFlow(authInfo)) {
    await openInstallFlow({ source: "auto", replace: true });
    return;
  }

  if (typeof ensureServiceWorkerRegistration === "function") {
    void ensureServiceWorkerRegistration();
  }

  initializePushNotifications({
    prompt: typeof shouldPromptForInstalledNotifications === "function"
      ? shouldPromptForInstalledNotifications()
      : false,
  });

  const launchIntent = authInfo?.role === "owner" && !isAgentScopedMode()
    ? consumeLaunchIntent()
    : null;
  if (launchIntent) {
    prepareOwnerLaunchIntentBootstrap(launchIntent);
  }

  if (isAgentScopedMode()) {
    const sessionsPromise = bootstrapViaHttp({ deferOwnerRestore: true });
    let toolsPromise = Promise.resolve();
    if (canChangeRuntimeSelection()) {
      toolsPromise = loadInlineTools({ skipModelLoad: true });
    }
    await Promise.all([toolsPromise, sessionsPromise]);
    restoreOwnerSessionSelection();
    connect();
    setupForegroundRefreshHandlers();
    if (canChangeRuntimeSelection()) {
      void loadModelsForCurrentTool();
    }
    return;
  }

  if (typeof hydratePreferredRuntimeSelection === 'function') {
    await hydratePreferredRuntimeSelection();
  }
  const toolsPromise = loadInlineTools({ skipModelLoad: true });
  const sessionsPromise = bootstrapViaHttp({ deferOwnerRestore: true });
  await Promise.all([toolsPromise, sessionsPromise]);
  const launchHandled = launchIntent
    ? await handleOwnerLaunchIntent(launchIntent)
    : false;
  if (!launchHandled) {
    restoreOwnerSessionSelection();
  }
  connect();
  setupForegroundRefreshHandlers();
  void loadModelsForCurrentTool();
}

if (typeof CustomSelect !== "undefined") {
  // Compose area (compact inline)
  window._composeCustomSelects = upgradeSelects(
    "#inlineAgentSelect, #inlineToolSelect, #inlineModelSelect, #effortSelect",
    { className: "cs-compact" },
  );
  // Sidebar workspace (full width, secondary bg)
  upgradeSelects(
    "#workspaceSelect, #workspaceCustomFolderSelect",
    { className: "cs-full cs-full-bg" },
  );
  upgradeSelects(
    "#workspaceBrowserSelect",
    { className: "cs-full cs-browser" },
  );
  // Settings panel (compact values aligned to setting rows)
  upgradeSelects(
    ".settings-row-select",
    { className: "cs-settings-row" },
  );
  // Add-tool modal selects
  upgradeSelects(
    "#addToolRuntimeFamilySelect, #addToolReasoningKindSelect",
    { className: "cs-full" },
  );
}

initApp();
