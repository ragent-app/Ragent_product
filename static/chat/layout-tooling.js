// ---- Responsive layout ----
const MOBILE_KEYBOARD_OPEN_THRESHOLD = 120;
const layoutSubscribers = new Set();
let layoutPassHandle = 0;
let pendingLayoutReason = null;
let currentLayoutState = null;
let chatOverlayResizeObserver = null;
let lastChatOverlayMetrics = null;
const chatOverlayElements = new Set();
let chatLayoutMotionCleanup = null;

function scheduleAnimationFrame(callback) {
  if (typeof window?.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  callback();
  return 0;
}

function getLayoutViewportHeightPx() {
  const innerHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  return Math.round(innerHeight);
}

function getVisualViewportHeightPx() {
  const visualHeight = window.visualViewport?.height;
  if (Number.isFinite(visualHeight) && visualHeight > 0) {
    return Math.round(visualHeight);
  }
  return 0;
}

function buildLayoutState() {
  const layoutViewportHeight = getLayoutViewportHeightPx();
  const visualViewportHeight = getVisualViewportHeightPx();
  const viewportHeight = visualViewportHeight > 0
    ? Math.min(layoutViewportHeight || visualViewportHeight, visualViewportHeight)
    : layoutViewportHeight;
  const keyboardInsetHeight = !isDesktop && layoutViewportHeight > 0
    ? Math.max(0, layoutViewportHeight - viewportHeight)
    : 0;
  const viewportOffsetTop = window.visualViewport?.offsetTop || 0;
  return {
    isDesktop,
    layoutViewportHeight,
    viewportHeight,
    viewportOffsetTop,
    keyboardInsetHeight,
    keyboardOpen: !isDesktop && keyboardInsetHeight >= MOBILE_KEYBOARD_OPEN_THRESHOLD,
  };
}

function applyLayoutState(state) {
  if (state.viewportHeight > 0) {
    document.documentElement.style.setProperty("--app-height", `${state.viewportHeight}px`);
  }
  document.documentElement.style.setProperty("--keyboard-inset-height", `${state.keyboardInsetHeight}px`);
  document.documentElement.classList.toggle("keyboard-open", state.keyboardOpen);
  document.body?.classList.toggle("keyboard-open", state.keyboardOpen);
  // iOS Safari scrolls the fixed-position viewport when the keyboard opens,
  // causing the entire interface to push up. Counteract by resetting scroll
  // and translating the app shell back into the visible area.
  if (state.keyboardOpen || state.viewportOffsetTop > 0) {
    window.scrollTo(0, 0);
    // Some mobile engines keep a second root scroll position even while the
    // app shell is fixed. Clear both roots so IME panning cannot expose a
    // blank strip below the composer.
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  }
}

function getRenderedOuterHeight(element) {
  if (!element?.getBoundingClientRect) {
    return 0;
  }
  const style = typeof getComputedStyle === "function"
    ? getComputedStyle(element)
    : null;
  if (element.hidden || style?.display === "none" || style?.visibility === "collapse") {
    return 0;
  }
  const rect = element.getBoundingClientRect();
  const height = Number(rect.height) || 0;
  const marginTop = parseFloat(style?.marginTop || "0") || 0;
  const marginBottom = parseFloat(style?.marginBottom || "0") || 0;
  return Math.max(0, height + marginTop + marginBottom);
}

function getFloatingStatusGapPx() {
  const style = typeof getComputedStyle === "function"
    ? getComputedStyle(document.documentElement)
    : null;
  return parseFloat(style?.getPropertyValue?.("--chat-floating-status-gap") || "8") || 8;
}

function syncChatBottomOverlaySpacing(reason = "layout", {
  viewportStateBeforeLayout = null,
  keyboardWasOpen = false,
} = {}) {
  const inputHeight = getRenderedOuterHeight(typeof inputArea !== "undefined" ? inputArea : null);
  const messageViewport = typeof messagesEl !== "undefined" ? messagesEl : null;
  const previousBottomDistance = messageViewport
    ? Math.max(
        0,
        (Number(messageViewport.scrollHeight) || 0)
          - (Number(messageViewport.scrollTop) || 0)
          - (Number(messageViewport.clientHeight) || 0),
      )
    : Number.POSITIVE_INFINITY;
  const queuePanel = typeof queuedPanel !== "undefined" ? queuedPanel : null;
  const decisionSheet = typeof document?.getElementById === "function"
    ? document.getElementById("decisionSheet")
    : null;
  const decisionSheetOpen = Boolean(decisionSheet && !decisionSheet.hidden);
  // Live status is rendered in the fixed header now. It must never reserve or
  // alter the bottom composer inset; only bottom-owned surfaces participate in
  // this measurement.
  const renderedLiveBarHeight = 0;
  const liveBarHeight = 0;
  const decisionSheetHeight = decisionSheetOpen
    ? getRenderedOuterHeight(decisionSheet)
    : 0;
  const decisionIsland = typeof document?.getElementById === "function"
    ? document.getElementById("decisionIsland")
    : null;
  const decisionIslandOpen = Boolean(decisionIsland && !decisionIsland.hidden);
  const queueHeight = getRenderedOuterHeight(queuePanel);
  const floatingStatusGap = getFloatingStatusGapPx();
  const queueStackHeight = queueHeight > 0
    ? queueHeight + floatingStatusGap
    : 0;
  const decisionIslandHeight = decisionIslandOpen
    ? getRenderedOuterHeight(decisionIsland) + floatingStatusGap
    : 0;
  const floatingStatusHeight = liveBarHeight + decisionSheetHeight + queueStackHeight + decisionIslandHeight;
  const floatingOffset = floatingStatusHeight > 0 ? floatingStatusGap : 0;
  // The FAB is another floating surface in this same composer zone. Keep it
  // above the complete status stack (including the bottom separation gap),
  // while leaving its original 12px composer gap untouched when no status is
  // rendered.
  const floatingStatusFabOffset = floatingStatusHeight > 0
    ? floatingStatusHeight + floatingOffset
    : 0;
  const overlayHeight = Math.ceil(inputHeight + floatingStatusHeight + floatingOffset);
  const metrics = {
    inputHeight: Math.ceil(inputHeight),
    renderedLiveBarHeight: Math.ceil(renderedLiveBarHeight),
    liveBarHeight: Math.ceil(liveBarHeight),
    decisionSheetHeight: Math.ceil(decisionSheetHeight),
    queueHeight: Math.ceil(queueHeight),
    queueStackHeight: Math.ceil(queueStackHeight),
    floatingStatusHeight: Math.ceil(floatingStatusHeight),
    floatingStatusFabOffset: Math.ceil(floatingStatusFabOffset),
    overlayHeight,
    bottomOverlayHeight: overlayHeight,
  };
  const metricsChanged = !lastChatOverlayMetrics
    || Object.keys(metrics).some((key) => metrics[key] !== lastChatOverlayMetrics[key]);
  const viewportChanged = /(?:viewport|breakpoint|window-resize)/.test(String(reason));
  if (!metricsChanged && !viewportChanged) {
    return overlayHeight;
  }
  const viewportState = viewportStateBeforeLayout
    || (typeof syncMessageViewportStabilitySnapshot === "function"
      ? syncMessageViewportStabilitySnapshot()
      : null);
  document.documentElement.style.setProperty("--chat-floating-status-height", `${Math.ceil(floatingStatusHeight)}px`);
  document.documentElement.style.setProperty("--chat-floating-status-fab-offset", `${Math.ceil(floatingStatusFabOffset)}px`);
  document.documentElement.style.setProperty("--chat-queued-panel-stack-height", `${Math.ceil(queueStackHeight)}px`);
  document.documentElement.style.setProperty("--chat-decision-sheet-height", `${Math.ceil(decisionSheetHeight)}px`);
  document.documentElement.style.setProperty("--chat-bottom-overlay-height", `${overlayHeight}px`);
  lastChatOverlayMetrics = metrics;
  if (viewportState && typeof scheduleMessageViewportLayoutRestore === "function") {
    scheduleMessageViewportLayoutRestore(viewportState);
  }
  // If the reader was already at the bottom, the new composer/status height
  // changes the scroll target. Pin that target immediately. The layout motion
  // observer supplies the single gentle spatial transition; running a second
  // scroll animation here makes the transcript and Composer fight each other.
  const keyboardInsetHeight = Number(currentLayoutState?.keyboardInsetHeight) || 0;
  const keyboardOpen = currentLayoutState?.keyboardOpen === true
    || document.body?.classList?.contains?.("keyboard-open") === true;
  const wasBottomPinnedBeforeViewportChange = viewportState?.stickyBottom === true;
  // A visual-viewport resize makes a bottom-pinned transcript appear to be
  // one keyboard-height away from the bottom before we get a chance to pin it
  // again. Treat that expected inset as part of the bottom threshold. Without
  // this compensation, focusing the Composer leaves the latest messages
  // underneath the keyboard instead of moving them up with it.
  const bottomPinThreshold = keyboardOpen
    ? Math.max(120, keyboardInsetHeight + 120)
    : 120;
  const composerOpenedKeyboard = keyboardOpen
    && !keyboardWasOpen
    && document.body?.classList?.contains?.("composer-input-focused") === true;
  if (
    (composerOpenedKeyboard
      || wasBottomPinnedBeforeViewportChange
      || previousBottomDistance <= bottomPinThreshold)
    && typeof scrollToBottom === "function"
  ) {
    scrollToBottom({ immediate: true });
  }
  return overlayHeight;
}

function getLayoutState() {
  if (!currentLayoutState) {
    currentLayoutState = buildLayoutState();
    applyLayoutState(currentLayoutState);
    syncChatBottomOverlaySpacing("initial");
  }
  return currentLayoutState;
}

function runLayoutPass(reason = "layout") {
  layoutPassHandle = 0;
  pendingLayoutReason = null;
  // Capture the reader's intent before applying the new visual viewport
  // height. On mobile, the browser may clamp/reset a nested scroll container
  // while the keyboard transaction is in flight; after that happens the
  // post-resize bottom distance no longer tells us whether the reader had
  // been following the latest message. The pre-layout snapshot is the
  // authoritative answer for this transaction.
  const viewportStateBeforeLayout = typeof getMessageViewportStabilitySnapshot === "function"
    ? getMessageViewportStabilitySnapshot()
    : (typeof syncMessageViewportStabilitySnapshot === "function"
      ? syncMessageViewportStabilitySnapshot()
      : null);
  const keyboardWasOpen = currentLayoutState?.keyboardOpen === true;
  currentLayoutState = buildLayoutState();
  applyLayoutState(currentLayoutState);
  for (const subscriber of layoutSubscribers) {
    try {
      subscriber(currentLayoutState, reason);
    } catch (error) {
      console.warn("[layout] Subscriber failed:", error.message);
    }
  }
  syncChatBottomOverlaySpacing(reason, { viewportStateBeforeLayout, keyboardWasOpen });
  return currentLayoutState;
}

function requestLayoutPass(reason = "layout") {
  pendingLayoutReason = reason;
  if (layoutPassHandle) {
    return layoutPassHandle;
  }
  layoutPassHandle = scheduleAnimationFrame(() => {
    runLayoutPass(pendingLayoutReason || reason);
  });
  return layoutPassHandle;
}

function normalizeToolId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function filterPrimaryToolOptions(toolOptions = []) {
  return (Array.isArray(toolOptions) ? toolOptions : []).filter((tool) => {
    const toolId = normalizeToolId(tool?.id);
    return tool && typeof tool === "object" && toolId;
  });
}

function prioritizeToolOptions(toolOptions = []) {
  const tools = Array.isArray(toolOptions) ? [...toolOptions] : [];
  const defaultIndex = tools.findIndex((tool) => tool?.id === DEFAULT_TOOL_ID);
  if (defaultIndex > 0) {
    const [defaultTool] = tools.splice(defaultIndex, 1);
    tools.unshift(defaultTool);
  }
  return tools;
}

function resolvePreferredToolId(toolOptions = [], candidates = []) {
  const tools = prioritizeToolOptions(toolOptions).filter((tool) => tool?.id);
  const availableIds = new Set(tools.map((tool) => tool.id));
  for (const candidate of candidates) {
    const toolId = typeof candidate === "string" ? candidate.trim() : "";
    if (toolId && availableIds.has(toolId)) {
      return toolId;
    }
  }
  return tools[0]?.id || "";
}

function subscribeLayoutPass(subscriber, { immediate = false } = {}) {
  if (typeof subscriber !== "function") {
    return () => {};
  }
  layoutSubscribers.add(subscriber);
  if (immediate) {
    subscriber(getLayoutState(), "subscribe");
  }
  return () => {
    layoutSubscribers.delete(subscriber);
  };
}

function getViewportHeightPx() {
  return getLayoutState().viewportHeight;
}

function syncViewportHeight() {
  return runLayoutPass("viewport");
}

function focusComposer({ force = false, preventScroll = false } = {}) {
  if (!msgInput?.focus) return false;
  if ((typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) || msgInput.disabled) return false;
  if (typeof isComposerTransportPendingForCurrentSession === "function"
    && isComposerTransportPendingForCurrentSession()) return false;
  if (!force && !getLayoutState().isDesktop) return false;
  try {
    if (preventScroll) {
      msgInput.focus({ preventScroll: true });
    } else {
      msgInput.focus();
    }
  } catch {
    msgInput.focus();
  }
  return true;
}

window.RagentLayout = {
  getState: getLayoutState,
  getViewportHeight: getViewportHeightPx,
  requestPass: requestLayoutPass,
  subscribe: subscribeLayoutPass,
  syncNow: runLayoutPass,
  focusComposer,
  syncChatBottomOverlaySpacing,
  observeOverlay(element) {
    if (!element) return () => {};
    chatOverlayElements.add(element);
    chatOverlayResizeObserver?.observe?.(element);
    requestLayoutPass("overlay-observe");
    return () => {
      chatOverlayElements.delete(element);
      chatOverlayResizeObserver?.unobserve?.(element);
    };
  },
};

function initResponsiveLayout() {
  if (typeof setupMessageViewportStability === "function") {
    setupMessageViewportStability();
  }
  if (!chatLayoutMotionCleanup) {
    const chatArea = document.querySelector(".chat-area");
    if (chatArea && typeof window.RagentMotion?.observeLayout === "function") {
      chatLayoutMotionCleanup = window.RagentMotion.observeLayout(chatArea, {
        // Composer, Live Bar, and queued messages each own their own
        // transitions. Do not FLIP them again from the page-level observer:
        // two motion owners are what makes those surfaces twitch during
        // queue/status updates. The message viewport remains the only stable
        // production layout surface here.
        selector: ":scope > .messages",
        duration: 220,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        axis: "y",
      });
    }
  }
  const mq = window.matchMedia("(min-width: 768px)");
  function onBreakpointChange(e) {
    isDesktop = e.matches;
    sidebarOverlay.classList.remove("collapsed");
    if (isDesktop) {
      document.documentElement.classList.remove("keyboard-open");
      document.body?.classList.remove("keyboard-open");
      sidebarOverlay.classList.remove("open");
    }
    if (typeof window.syncSessionsSidebarCollapseState === "function") {
      window.syncSessionsSidebarCollapseState();
    }
    runLayoutPass("breakpoint");
  }
  window.addEventListener("resize", () => requestLayoutPass("window-resize"));
  window.visualViewport?.addEventListener("resize", () => requestLayoutPass("visual-viewport-resize"));
  window.visualViewport?.addEventListener("scroll", () => requestLayoutPass("visual-viewport-scroll"));
  // On mobile, a swipe that starts on the Composer while the keyboard is
  // visible must not pan the fixed app shell. Otherwise Safari/Chromium can
  // move the layout viewport independently of the visual viewport and leave
  // a blank strip below the Composer. Keep text editing/selection intact;
  // only the Composer chrome is a page-scroll boundary.
  window.addEventListener("touchmove", (event) => {
    if (!document.body?.classList?.contains?.("keyboard-open")) return;
    const target = event.target;
    const inputAreaElement = target?.closest?.(".input-area");
    if (!inputAreaElement) return;
    if (target?.closest?.("textarea, input, select, [contenteditable=\"true\"], .composer-add-panel, .composer-runtime-menu, .composer-permission-menu")) {
      return;
    }
    event.preventDefault();
  }, { passive: false });
  if (typeof ResizeObserver === "function" && !chatOverlayResizeObserver) {
    chatOverlayResizeObserver = new ResizeObserver(() => {
      requestLayoutPass("chat-bottom-overlay-resize");
    });
    if (typeof inputArea !== "undefined" && inputArea) {
      chatOverlayResizeObserver.observe(inputArea);
    }
    if (typeof queuedPanel !== "undefined" && queuedPanel) {
      chatOverlayResizeObserver.observe(queuedPanel);
    }
    for (const overlay of chatOverlayElements) {
      chatOverlayResizeObserver.observe(overlay);
    }
  }
  mq.addEventListener("change", onBreakpointChange);
  onBreakpointChange(mq);
}
