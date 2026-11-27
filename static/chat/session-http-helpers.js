function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++)
    outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function redirectToLogin() {
  window.ragentInvalidateSessionHttpCache?.();
  const loginPath = typeof window.ragentResolveProductPath === "function"
    ? window.ragentResolveProductPath("/login")
    : "/login";
  const loginUrl = new URL(loginPath, window.location.href);
  if (window.location.pathname !== loginUrl.pathname) {
    window.location.href = `${loginUrl.pathname}${loginUrl.search}${loginUrl.hash}`;
  }
}

const PRODUCT_LOCAL_HREF_RE = /^\/(?:api|share|share-asset|agent|visitor|login|logout|m)(?:[/?#]|$)/i;

function enhanceRenderedContentLinks(root) {
  if (!root) return;

  root.querySelectorAll("a[href]").forEach((link) => {
    let href = (link.getAttribute("href") || "").trim();
    if (!href) return;

    if (PRODUCT_LOCAL_HREF_RE.test(href) && typeof window.ragentResolveProductPath === "function") {
      const resolvedHref = window.ragentResolveProductPath(href);
      if (resolvedHref) {
        href = resolvedHref;
        if (typeof link.setAttribute === "function") {
          link.setAttribute("href", resolvedHref);
        } else {
          link.href = resolvedHref;
        }
      }
    }

    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  });

  root.querySelectorAll("img[src]").forEach((image) => {
    const src = (image.getAttribute("src") || "").trim();
    if (!src) return;
    if (PRODUCT_LOCAL_HREF_RE.test(src) && typeof window.ragentResolveProductPath === "function") {
      const resolvedSrc = window.ragentResolveProductPath(src);
      if (resolvedSrc) {
        image.setAttribute("src", resolvedSrc);
      }
    }
    image.loading = "lazy";
  });
}

function buildJsonCacheKey(url) {
  try {
    const resolvedUrl = typeof window.ragentResolveProductUrl === "function"
      ? window.ragentResolveProductUrl(url)
      : new URL(url, window.location.origin).toString();
    const resolved = new URL(resolvedUrl, window.location.origin);
    const targetId = window.RagentTargetRuntime?.getActiveTarget?.()?.targetId || "local";
    const authEpoch = typeof window.ragentAuthEpoch === "string" && window.ragentAuthEpoch
      ? window.ragentAuthEpoch
      : "anonymous";
    return `${authEpoch}:${targetId}:${resolved.pathname}${resolved.search}`;
  } catch {
    return String(url);
  }
}

// Exposed for auth/bootstrap transitions and tests. A transition must clear
// both parsed JSON responses and immutable event/body promises. Otherwise a
// request started under the previous principal/target can resolve after the
// transition and repopulate an otherwise fresh cache.
if (typeof window !== "undefined") {
  window.ragentInvalidateSessionHttpCache = function ragentInvalidateSessionHttpCache() {
    try {
      jsonResponseCache?.clear?.();
    } catch {}
    try {
      window.ragentClearSessionEventCaches?.();
    } catch {}
    try {
      if (typeof clearSessionListSwrCache === "function") void clearSessionListSwrCache();
    } catch {}
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: "ragent:clear-caches" });
    } catch {}
  };
  window.addEventListener?.("ragent:target-change", () => {
    window.ragentInvalidateSessionHttpCache?.();
  });
}

const SESSION_LIST_URL = "/api/sessions";

function getSessionSidebarUrl(sessionId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}?view=sidebar`;
}

function resolveRequestUrl(url) {
  if (typeof withVisitorModeUrl === "function") {
    return withVisitorModeUrl(url);
  }
  if (typeof window.ragentResolveProductPath === "function") {
    return window.ragentResolveProductPath(url);
  }
  return typeof url === "string" ? url : String(url || "");
}

function getActiveShareSnapshotPayload() {
  return typeof shareSnapshotPayload !== "undefined"
    ? shareSnapshotPayload
    : null;
}

function isShareSnapshotReadOnlyMode() {
  return typeof shareSnapshotMode !== "undefined" && shareSnapshotMode === true;
}

function resolveSessionEntryMode(value) {
  return value === "read" ? "read" : "resume";
}

function findClientSessionRecord(sessionId = currentSessionId) {
  if (typeof getChatStoreSession === "function") {
    return getChatStoreSession(sessionId);
  }
  return typeof sessions !== "undefined" && Array.isArray(sessions)
    ? (sessions.find((session) => session?.id === sessionId) || null)
    : null;
}

function getCurrentSessionEntryMode(sessionId = currentSessionId) {
  if (isShareSnapshotReadOnlyMode()) return "read";
  return resolveSessionEntryMode(findClientSessionRecord(sessionId)?.entryMode);
}

function shouldOpenCurrentSessionFromTop({
  sessionId = currentSessionId,
  viewportIntent = "preserve",
} = {}) {
  if (isShareSnapshotReadOnlyMode()) {
    return true;
  }
  if (normalizeSessionViewportIntent(viewportIntent) !== "session_entry") {
    return false;
  }
  return getCurrentSessionEntryMode(sessionId) === "read";
}

function shouldOpenCurrentSessionAtBottom({ viewportIntent = "preserve" } = {}) {
  if (isShareSnapshotReadOnlyMode()) return false;
  return normalizeSessionViewportIntent(viewportIntent) === "session_entry_bottom";
}

function scrollCurrentSessionViewportToTop() {
  if (!messagesEl) return;
  markMessageViewportProgrammaticScroll();
  messagesEl.scrollTop = 0;
  if (typeof syncMessageViewportStabilitySnapshot === "function") {
    syncMessageViewportStabilitySnapshot();
  }
}

function getSessionEntryViewportState() {
  if (!(globalThis.__sessionEntryViewportState && typeof globalThis.__sessionEntryViewportState === "object")) {
    globalThis.__sessionEntryViewportState = {
      latestTurnFocusSessionId: null,
      latestTurnFocusConsumed: false,
    };
  }
  return globalThis.__sessionEntryViewportState;
}

function shouldFocusLatestTurnStartOnSessionEntry(sessionId, node) {
  if (!shouldFocusLatestTurnStart(node)) return false;
  const state = getSessionEntryViewportState();
  if (state.latestTurnFocusSessionId !== sessionId) {
    state.latestTurnFocusSessionId = sessionId;
    state.latestTurnFocusConsumed = false;
  }
  if (state.latestTurnFocusConsumed) return false;
  state.latestTurnFocusConsumed = true;
  return true;
}

function normalizeSessionViewportIntent(value) {
  if (value === "session_entry_bottom") return "session_entry_bottom";
  return value === "session_entry" ? "session_entry" : "preserve";
}

const MESSAGE_VIEWPORT_STICKY_BOTTOM_THRESHOLD_PX = 120;
let messageViewportUserGeneration = 0;
let messageViewportResizeObserver = null;
let messageViewportRestoreFrame = 0;
let messageViewportRestoreState = null;
let messageViewportStableState = null;
let messageViewportProgrammaticScrollUntil = 0;
let messageViewportEntryBottomPin = null;
let messageViewportEntryBottomPinFrame = 0;

function getMessageViewportBottomDistance() {
  if (!messagesEl) return Number.POSITIVE_INFINITY;
  const scrollHeight = Number(messagesEl.scrollHeight) || 0;
  const scrollTop = Number(messagesEl.scrollTop) || 0;
  const clientHeight = Number(messagesEl.clientHeight) || 0;
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

function isMessageViewportStickyBottom(
  thresholdPx = MESSAGE_VIEWPORT_STICKY_BOTTOM_THRESHOLD_PX,
) {
  return getMessageViewportBottomDistance() < thresholdPx;
}

function getMessageViewportChildren() {
  return Array.from(messagesInner?.children || []).filter((node) => node !== emptyState);
}

function getMessageViewportNodeId(node, index = -1) {
  const value = typeof node?.dataset?.timelineId === "string"
    ? node.dataset.timelineId.trim()
    : "";
  if (value) return value;

  // Timeline roots created by the current runtime always carry a stable
  // item id. Keep a narrow fallback for older DOM/test fixtures so a history
  // prepend can still recover its semantic anchor while the replacement DOM
  // is being introduced. Sequence ranges are preferable to a positional
  // index; the index is only the last resort when no timeline metadata exists.
  const startSeq = Number.parseInt(node?.dataset?.timelineStartSeq || "", 10);
  const endSeq = Number.parseInt(node?.dataset?.timelineEndSeq || "", 10);
  if (Number.isInteger(startSeq) && startSeq > 0) {
    return `seq:${startSeq}:${Number.isInteger(endSeq) && endSeq > 0 ? endSeq : startSeq}`;
  }
  return Number.isInteger(index) && index >= 0 ? `index:${index}` : "";
}

function getMessageViewportNodeRect(node) {
  return typeof node?.getBoundingClientRect === "function"
    ? node.getBoundingClientRect()
    : null;
}

function captureMessageViewportAnchor({ sessionId = currentSessionId } = {}) {
  if (!messagesEl || !messagesInner || !sessionId) return null;
  const containerRect = getMessageViewportNodeRect(messagesEl);
  const children = getMessageViewportChildren();
  if (!containerRect || children.length === 0) return null;

  let anchorNode = null;
  for (const [index, child] of children.entries()) {
    const rect = getMessageViewportNodeRect(child);
    if (rect && rect.bottom > containerRect.top + 1 && getMessageViewportNodeId(child, index)) {
      anchorNode = child;
      break;
    }
  }
  if (!anchorNode) return null;
  const anchorRect = getMessageViewportNodeRect(anchorNode);
  if (!anchorRect) return null;
  return {
    sessionId,
    nodeId: getMessageViewportNodeId(anchorNode, children.indexOf(anchorNode)),
    nodeSeq: Number.parseInt(anchorNode?.dataset?.timelineStartSeq || "", 10) || 0,
    nodeIndex: children.indexOf(anchorNode),
    nodeRef: anchorNode,
    offsetFromViewportTop: anchorRect.top - containerRect.top,
    userGeneration: messageViewportUserGeneration,
  };
}

// Android's LazyColumn keeps the first visible item and its pixel offset while
// older rows are inserted. Keep the equivalent pre-layout facts on Web. The
// semantic anchor handles variable row heights; the scroll-height delta makes
// the correction happen in the same DOM transaction, before the browser can
// paint a one-frame jump.
function captureMessageViewportPrependState({
  sessionId = currentSessionId,
  anchor = null,
} = {}) {
  if (!messagesEl || !sessionId || currentSessionId !== sessionId) return null;
  return {
    sessionId,
    anchor: anchor || captureMessageViewportAnchor({ sessionId }),
    scrollTop: Math.max(0, Number(messagesEl.scrollTop) || 0),
    scrollHeight: Math.max(0, Number(messagesEl.scrollHeight) || 0),
    userGeneration: messageViewportUserGeneration,
  };
}

function setMessageViewportPrependMode(active) {
  if (!messagesEl?.classList?.toggle) return;
  messagesEl.classList.toggle("is-prepending-history", active === true);
}

function restoreMessageViewportAfterPrepend(state, {
  sessionId = currentSessionId,
  scheduleLayoutRestore = true,
} = {}) {
  if (!state || !messagesEl || currentSessionId !== sessionId || state.sessionId !== sessionId) {
    return false;
  }
  // A continued wheel/touch gesture owns the viewport now. Never replay the
  // old prepend anchor over a newer user generation.
  if (state.userGeneration !== messageViewportUserGeneration) return false;

  const nextScrollHeight = Math.max(0, Number(messagesEl.scrollHeight) || 0);
  const heightDelta = nextScrollHeight - state.scrollHeight;
  markMessageViewportProgrammaticScroll();
  messagesEl.scrollTop = Math.max(0, state.scrollTop + heightDelta);

  // The height delta is the fast path. The semantic correction absorbs any
  // non-prepend layout change (for example a dock/padding update) that was
  // included in scrollHeight while the request was in flight.
  if (state.anchor) {
    restoreMessageViewportAnchor(state.anchor, { sessionId, respectUserIntent: true });
  }
  syncMessageViewportStabilitySnapshot();

  // Markdown hydration, image decode, and font/layout settling can change a
  // newly inserted row after the synchronous commit. Match Android's
  // post-recomposition restore with one coalesced frame.
  if (scheduleLayoutRestore && state.anchor) {
    scheduleMessageViewportLayoutRestore({
      sessionId,
      stickyBottom: false,
      anchor: state.anchor,
    });
  }
  return true;
}

function findMessageViewportAnchorNode(anchor) {
  const children = getMessageViewportChildren();
  if (anchor?.nodeRef && children.includes(anchor.nodeRef)) {
    return anchor.nodeRef;
  }
  if (typeof anchor?.nodeId === "string" && anchor.nodeId) {
    const idMatch = children.find((node, index) => getMessageViewportNodeId(node, index) === anchor.nodeId);
    if (idMatch) return idMatch;
  }
  if (Number.isInteger(anchor?.nodeSeq) && anchor.nodeSeq > 0) {
    const seqMatch = children.find((node) => (
      Number.parseInt(node?.dataset?.timelineStartSeq || "", 10) === anchor.nodeSeq
    ));
    if (seqMatch) return seqMatch;
  }
  if (Number.isInteger(anchor?.nodeIndex) && anchor.nodeIndex >= 0 && anchor.nodeIndex < children.length) {
    return children[anchor.nodeIndex];
  }
  return null;
}

function restoreMessageViewportAnchor(anchor, {
  sessionId = currentSessionId,
  respectUserIntent = true,
} = {}) {
  if (!anchor || !messagesEl || currentSessionId !== sessionId || anchor.sessionId !== sessionId) {
    return false;
  }
  if (respectUserIntent && anchor.userGeneration !== messageViewportUserGeneration) {
    return false;
  }
  const containerRect = getMessageViewportNodeRect(messagesEl);
  const anchorNode = findMessageViewportAnchorNode(anchor);
  const anchorRect = getMessageViewportNodeRect(anchorNode);
  if (!containerRect || !anchorRect) return false;
  const nextOffset = anchorRect.top - containerRect.top;
  const correction = nextOffset - anchor.offsetFromViewportTop;
  if (Math.abs(correction) <= 0.5) return true;
  markMessageViewportProgrammaticScroll();
  messagesEl.scrollTop = Math.max(0, (Number(messagesEl.scrollTop) || 0) + correction);
  return true;
}

function syncMessageViewportStabilitySnapshot() {
  if (!messagesEl || !messagesInner || !currentSessionId) {
    messageViewportStableState = null;
    return null;
  }
  messageViewportStableState = {
    sessionId: currentSessionId,
    stickyBottom: isMessageViewportStickyBottom(),
    anchor: captureMessageViewportAnchor(),
  };
  return messageViewportStableState;
}

// Layout changes must be able to read the last stable intent without
// re-measuring the viewport. A mobile keyboard can clamp a nested scroll
// container before the visual-viewport layout pass runs; re-snapshotting at
// that point would overwrite the "following latest" state with the transient
// clamped position we are trying to repair.
function getMessageViewportStabilitySnapshot() {
  return messageViewportStableState;
}

function markMessageViewportUserIntent() {
  cancelMessageViewportEntryBottomPin();
  messageViewportUserGeneration += 1;
  if (messageViewportRestoreFrame) {
    cancelAnimationFrame?.(messageViewportRestoreFrame);
    messageViewportRestoreFrame = 0;
  }
  messageViewportRestoreState = null;
}

function markMessageViewportProgrammaticScroll() {
  // A programmatic scrollTop write (bottom pin, anchor restore) emits a scroll
  // event that must not be mistaken for user intent: without this window the
  // pin's own event would bump the user generation and invalidate the restore.
  messageViewportProgrammaticScrollUntil = Date.now() + 120;
}

function isMessageViewportProgrammaticScroll() {
  return Date.now() <= messageViewportProgrammaticScrollUntil;
}

function cancelMessageViewportEntryBottomPin() {
  if (messageViewportEntryBottomPinFrame && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(messageViewportEntryBottomPinFrame);
  }
  messageViewportEntryBottomPinFrame = 0;
  messageViewportEntryBottomPin = null;
}

// A session entry is a stronger viewport contract than an ordinary refresh:
// the user explicitly opened the conversation and must see its latest item,
// even while the composer/status dock and markdown content finish laying out.
// Keep a short multi-frame pin for that transaction. A real pointer/keyboard
// gesture cancels it through markMessageViewportUserIntent(), after which the
// normal detached/anchor rules resume.
function pinMessageViewportToBottomForSessionEntry(
  sessionId = currentSessionId,
  { frames = 4 } = {},
) {
  if (!messagesEl || !messagesInner || !sessionId || currentSessionId !== sessionId) return false;
  cancelMessageViewportEntryBottomPin();
  const pin = {
    sessionId,
    userGeneration: messageViewportUserGeneration,
    remainingFrames: Math.max(1, Number(frames) || 1),
  };
  messageViewportEntryBottomPin = pin;

  const run = () => {
    messageViewportEntryBottomPinFrame = 0;
    if (
      messageViewportEntryBottomPin !== pin
      || currentSessionId !== pin.sessionId
      || messageViewportUserGeneration !== pin.userGeneration
    ) {
      cancelMessageViewportEntryBottomPin();
      return;
    }
    markMessageViewportProgrammaticScroll();
    messagesEl.scrollTop = messagesEl.scrollHeight;
    syncMessageViewportStabilitySnapshot();
    pin.remainingFrames -= 1;
    if (pin.remainingFrames <= 0) {
      messageViewportEntryBottomPin = null;
      return;
    }
    if (typeof requestAnimationFrame === "function") {
      messageViewportEntryBottomPinFrame = requestAnimationFrame(run);
    } else {
      messageViewportEntryBottomPin = null;
    }
  };
  run();
  return true;
}

function resetMessageViewportStabilityForRender() {
  setMessageViewportPrependMode(false);
  cancelMessageViewportEntryBottomPin();
  messageViewportStableState = null;
  if (messageViewportRestoreFrame) {
    cancelAnimationFrame?.(messageViewportRestoreFrame);
    messageViewportRestoreFrame = 0;
  }
  messageViewportRestoreState = null;
}

function handleMessageViewportScroll() {
  if (isMessageViewportProgrammaticScroll()) return;
  syncMessageViewportStabilitySnapshot();
}

function scheduleMessageViewportLayoutRestore(state = messageViewportStableState) {
  if (!state || !messagesEl || !messagesInner) return 0;
  // ResizeObserver may report several layout changes before the next frame.
  // Keep one restore frame, but always let it consume the newest semantic
  // state so an earlier anchor cannot undo a later user/layout update.
  messageViewportRestoreState = state;
  if (messageViewportRestoreFrame) return messageViewportRestoreFrame;
  messageViewportRestoreFrame = requestAnimationFrame(() => {
    messageViewportRestoreFrame = 0;
    const nextState = messageViewportRestoreState;
    messageViewportRestoreState = null;
    if (!nextState || currentSessionId !== nextState.sessionId) return;
    if (nextState.stickyBottom) {
      markMessageViewportProgrammaticScroll();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      restoreMessageViewportAnchor(nextState.anchor, {
        sessionId: nextState.sessionId,
        respectUserIntent: true,
      });
    }
    syncMessageViewportStabilitySnapshot();
  });
  return messageViewportRestoreFrame;
}

function setupMessageViewportStability() {
  if (!messagesEl || !messagesInner || messagesEl.dataset?.viewportStabilityReady === "true") {
    return;
  }
  if (messagesEl.dataset) messagesEl.dataset.viewportStabilityReady = "true";
  for (const eventName of ["wheel", "touchstart", "pointerdown"]) {
    messagesEl.addEventListener(eventName, markMessageViewportUserIntent, { passive: true });
  }
  messagesEl.addEventListener("keydown", (event) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event?.key)) {
      markMessageViewportUserIntent();
    }
  });
  messagesEl.addEventListener("scroll", handleMessageViewportScroll, { passive: true });
  if (typeof ResizeObserver === "function") {
    messageViewportResizeObserver = new ResizeObserver(() => {
      scheduleMessageViewportLayoutRestore(messageViewportStableState);
      // A font, image, markdown, or dock layout change can make a previously
      // non-scrollable transcript settle below the viewport. Re-check after
      // layout so older history is still fetched without requiring a gesture.
      if (typeof scheduleAutofillSessionHistoryViewport === "function") {
        scheduleAutofillSessionHistoryViewport();
      }
    });
    messageViewportResizeObserver.observe(messagesEl);
    messageViewportResizeObserver.observe(messagesInner);
  }
  syncMessageViewportStabilitySnapshot();
}

function hasShareSnapshotPayload() {
  const payload = getActiveShareSnapshotPayload();
  return !!(payload && typeof payload === "object");
}

function buildShareSnapshotSessionId(snapshot = getActiveShareSnapshotPayload()) {
  const rawId = typeof snapshot?.id === "string" ? snapshot.id.trim() : "";
  return rawId ? `share_snapshot:${rawId}` : "share_snapshot";
}

function getShareSnapshotDisplayEvents(snapshot = getActiveShareSnapshotPayload()) {
  return Array.isArray(snapshot?.displayEvents) ? snapshot.displayEvents : [];
}

function getShareSnapshotEventBlock(startSeq, endSeq, snapshot = getActiveShareSnapshotPayload()) {
  const key = `${startSeq}-${endSeq}`;
  const events = Array.isArray(snapshot?.eventBlocks?.[key])
    ? snapshot.eventBlocks[key]
    : null;
  if (!events) return null;
  return {
    sessionId: buildShareSnapshotSessionId(snapshot),
    startSeq,
    endSeq,
    events,
  };
}

function getShareSnapshotLastEventAt(snapshot = getActiveShareSnapshotPayload()) {
  const displayEvents = getShareSnapshotDisplayEvents(snapshot);
  for (let index = displayEvents.length - 1; index >= 0; index -= 1) {
    const stamp = typeof displayEvents[index]?.timestamp === "string"
      ? displayEvents[index].timestamp.trim()
      : "";
    if (stamp) return stamp;
  }
  return typeof snapshot?.createdAt === "string" && snapshot.createdAt.trim()
    ? snapshot.createdAt.trim()
    : null;
}

function getShareSnapshotViewValue(key, fallback = "") {
  const value = getActiveShareSnapshotPayload()?.view?.[key];
  return typeof value === "string" && value.trim()
    ? value.trim()
    : fallback;
}

function buildShareSnapshotSessionRecord(snapshot = getActiveShareSnapshotPayload()) {
  if (!(snapshot && typeof snapshot === "object")) return null;
  const displayEvents = getShareSnapshotDisplayEvents(snapshot);
  const name = typeof snapshot?.session?.name === "string" && snapshot.session.name.trim()
    ? snapshot.session.name.trim()
    : (typeof snapshot?.session?.tool === "string" && snapshot.session.tool.trim()
      ? snapshot.session.tool.trim()
      : "Shared session snapshot");
  const lastEventAt = getShareSnapshotLastEventAt(snapshot);
  return {
    id: buildShareSnapshotSessionId(snapshot),
    name,
    tool: typeof snapshot?.session?.tool === "string" ? snapshot.session.tool.trim() : "",
    created: typeof snapshot?.session?.created === "string" && snapshot.session.created.trim()
      ? snapshot.session.created.trim()
      : (typeof snapshot?.createdAt === "string" && snapshot.createdAt.trim()
        ? snapshot.createdAt.trim()
        : null),
    updatedAt: lastEventAt,
    lastEventAt,
    sourceId: "share_snapshot",
    sourceName: getShareSnapshotViewValue("badge", "Shared Snapshot"),
    entryMode: "read",
    messageCount: displayEvents.filter((event) => event?.type === "message").length,
    activity: {
      run: { state: "idle" },
      queue: { state: "idle", count: 0 },
      compact: { state: "idle" },
    },
  };
}

async function fetchJsonViaP2P(requestUrl, method, headers, body, cacheKey, cached) {
  const response = await window.RagentP2P.tryRequest(requestUrl, method, headers, body);
  if (!response) return null;
  // A paired host cannot read the browser's HttpOnly session cookie. Its 401
  // is therefore a transport-authentication miss, not proof that the browser
  // itself is signed out. Fall back to fetch(), which attaches that cookie.
  // A direct HTTP 401 below remains the authoritative logout signal.
  // Route/method misses use the same fallback because a paired host may
  // outlive the chat-server build that introduced a route.
  if (response.status === 401 || response.status === 404 || response.status === 405) return null;
  if (response.status === 304) {
    if (!cached) {
      throw new Error("Cache revalidation failed");
    }
    return cached.data;
  }
  // sidecar 转发头可能含非 latin1 值（中文/emoji），逐项安全构造，跳过非法项。
  const responseHeaders = new Headers();
  for (const [headerKey, headerValue] of Object.entries(response.headers || {})) {
    try { responseHeaders.set(headerKey, headerValue); } catch { /* skip invalid header */ }
  }
  const contentType = responseHeaders.get("content-type") || "";
  let data = null;
  if (contentType.includes("application/json")) {
    try { data = JSON.parse(response.text || "{}"); } catch { data = {}; }
  }
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.code = String(data?.code || "").trim() || "";
    error.status = response.status;
    error.stage = String(data?.stage || "transport").trim() || "transport";
    error.retryable = data?.retryable === true || response.status === 408 || response.status === 429 || response.status >= 500;
    error.requestId = String(data?.requestId || responseHeaders.get("x-ragent-request-id") || "").trim() || null;
    const retryAfterMs = Number.isFinite(Number(data?.retryAfterMs))
      ? Math.max(0, Math.min(30_000, Number(data.retryAfterMs)))
      : parseRetryAfterMs(responseHeaders.get("retry-after"));
    if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs;
    throw error;
  }
  if (!data) {
    throw new Error("Expected JSON response");
  }
  if (cacheKey) {
    const etag = responseHeaders.get("etag");
    if (etag) {
      jsonResponseCache.set(cacheKey, { etag, data, cachedAt: Date.now() });
    } else {
      jsonResponseCache.delete(cacheKey);
    }
  }
  return data;
}

const httpRuntimeConfig = typeof globalThis === "object" && globalThis !== null
  ? globalThis
  : {};
const RAGENT_HTTP_REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(httpRuntimeConfig.RAGENT_HTTP_REQUEST_TIMEOUT_MS || "30000", 10) || 30_000,
);
// P2P is an opportunistic transport. Its request cannot be cancelled on the
// DataChannel, so it must give the browser HTTP path a short head start rather
// than inheriting the full user-visible request deadline.
const RAGENT_P2P_REQUEST_TIMEOUT_MS = Math.max(
  250,
  Math.min(
    RAGENT_HTTP_REQUEST_TIMEOUT_MS - 250,
    Number.parseInt(httpRuntimeConfig.RAGENT_P2P_REQUEST_TIMEOUT_MS || "2500", 10) || 2_500,
  ),
);
// A half-open DataChannel can repeatedly consume the full opportunistic
// timeout even though the normal loopback HTTP path is healthy. Trip a short
// browser-local circuit breaker after that timeout so subsequent requests use
// HTTP directly until the paired transport gets another chance.
const RAGENT_P2P_FAILURE_COOLDOWN_MS = Math.max(
  250,
  Number.parseInt(httpRuntimeConfig.RAGENT_P2P_FAILURE_COOLDOWN_MS || "30000", 10) || 30_000,
);
const RAGENT_P2P_HEAD_START_MS = Math.max(
  0,
  Math.min(
    RAGENT_P2P_REQUEST_TIMEOUT_MS,
    Number.parseInt(httpRuntimeConfig.RAGENT_P2P_HEAD_START_MS || "350", 10) || 350,
  ),
);
let p2pUnavailableUntil = 0;

function createRequestDeadline(signal, timeoutMs = RAGENT_HTTP_REQUEST_TIMEOUT_MS) {
  // Older embedded WebViews and the lightweight VM used by connector/UI
  // tests may not expose AbortController. Keep the same tiny signal contract
  // (aborted + add/remove listener + abort notification) so request timeout
  // and caller cancellation remain deterministic without requiring a
  // heavyweight polyfill.
  const controller = typeof AbortController === "function"
    ? new AbortController()
    : (() => {
      let aborted = false;
      const listeners = new Set();
      const fallbackSignal = {
        get aborted() { return aborted; },
        addEventListener(type, listener) {
          if (type === "abort" && typeof listener === "function") listeners.add(listener);
        },
        removeEventListener(type, listener) {
          if (type === "abort") listeners.delete(listener);
        },
      };
      return {
        signal: fallbackSignal,
        abort() {
          if (aborted) return;
          aborted = true;
          for (const listener of listeners) {
            try { listener(); } catch {}
          }
          listeners.clear();
        },
      };
    })();
  let timedOut = false;
  const timer = typeof setTimeout === "function"
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs)
    : null;
  const abortFromCaller = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      if (timer && typeof clearTimeout === "function") {
        clearTimeout(timer);
      }
      signal?.removeEventListener?.("abort", abortFromCaller);
    },
  };
}

function requestTimeoutError() {
  const error = new Error("Request timed out");
  error.name = "TimeoutError";
  error.code = "REQUEST_TIMEOUT";
  return error;
}

function parseRetryAfterMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(30_000, Math.round(seconds * 1000));
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.min(30_000, at - Date.now())) : null;
}

async function parseJsonResponseOrRedirect(res, { cacheKey, cached, cacheMaxAgeMs = 0 } = {}) {
  const loginPath = typeof window.ragentResolveProductPath === "function"
    ? new URL(window.ragentResolveProductPath("/login"), window.location.href).pathname
    : "/login";
  const redirectedToLogin =
    res.redirected && new URL(res.url, window.location.href).pathname === loginPath;

  if (res.status === 401 || redirectedToLogin) {
    window.ragentInvalidateSessionHttpCache?.();
    redirectToLogin();
    const error = new Error("Authentication required");
    error.code = "AUTH_EXPIRED";
    error.status = 401;
    error.retryable = false;
    throw error;
  }

  if (res.status === 304) {
    if (!cached) throw new Error("Cache revalidation failed");
    return cached.data;
  }

  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await res.json().catch(() => ({}))
    : null;

  if (!res.ok) {
    const error = new Error(data?.error || `Request failed (${res.status})`);
    error.code = String(data?.code || "").trim() || "";
    error.status = res.status;
    error.stage = String(data?.stage || "transport").trim() || "transport";
    error.retryable = data?.retryable === true || res.status === 408 || res.status === 429 || res.status >= 500;
    error.requestId = String(data?.requestId || res.headers.get("x-ragent-request-id") || "").trim() || null;
    const retryAfterMs = Number.isFinite(Number(data?.retryAfterMs))
      ? Math.max(0, Math.min(30_000, Number(data.retryAfterMs)))
      : parseRetryAfterMs(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs;
    throw error;
  }

  if (!data) throw new Error("Expected JSON response");

  if (cacheKey) {
    const etag = res.headers.get("etag");
    if (etag || cacheMaxAgeMs > 0) {
      jsonResponseCache.set(cacheKey, { etag, data, cachedAt: Date.now() });
    } else {
      jsonResponseCache.delete(cacheKey);
    }
  }
  return data;
}

async function fetchJsonOrRedirect(url, options = {}) {
  const requestOptions = { ...options };
  const targetRuntime = window.RagentTargetRuntime;
  const useTargetRuntime = !requestOptions.__targetRuntimeBypass && targetRuntime?.isRuntimePath?.(url);
  delete requestOptions.__targetRuntimeBypass;
  const skipP2P = requestOptions.skipP2P === true;
  const revalidate = requestOptions.revalidate !== false;
  const cacheMaxAgeMs = Number.isFinite(requestOptions.cacheMaxAgeMs) && requestOptions.cacheMaxAgeMs > 0
    ? requestOptions.cacheMaxAgeMs
    : 0;
  delete requestOptions.skipP2P;
  delete requestOptions.revalidate;
  delete requestOptions.cacheMaxAgeMs;
  const requestUrl = resolveRequestUrl(url);

  const method = String(requestOptions.method || "GET").toUpperCase();
  const isGet = method === "GET";
  const cacheKey = isGet && revalidate ? buildJsonCacheKey(requestUrl) : null;
  const cached = cacheKey ? jsonResponseCache.get(cacheKey) : null;
  if (cached && cacheMaxAgeMs > 0 && Date.now() - (cached.cachedAt || 0) <= cacheMaxAgeMs) {
    return cached.data;
  }

  if (useTargetRuntime) {
    // Runtime-delegated requests inherit the same user-visible deadline as
    // the direct path. routeRequest forwards to a raw local fetch or a
    // remote runtime adapter, and neither applies its own timeout: on a
    // half-open tunnel socket the request would never settle, leaving the
    // single-flight refresh registry entry in flight forever — every later
    // refresh for that session then coalesces onto the wedged entry and the
    // transcript never renders until a manual reload (the "blank session
    // until refresh" report). The deadline races the delegation rather than
    // only aborting its signal: remote adapters (P2P DataChannel) cannot
    // cancel, so a wedged or late delegation is abandoned at the deadline
    // and any response that lands afterwards is discarded — the same
    // stale-response contract the P2P leg already applies.
    const deadline = createRequestDeadline(requestOptions.signal);
    let deadlineReject = null;
    const deadlineGate = new Promise((_, reject) => {
      deadlineReject = reject;
    });
    deadline.signal.addEventListener("abort", () => {
      if (deadline.timedOut()) deadlineReject(requestTimeoutError());
      else {
        const error = new Error("Aborted");
        error.name = "AbortError";
        deadlineReject(error);
      }
    }, { once: true });
    let response;
    try {
      response = await Promise.race([
        targetRuntime.routeRequest({
          url,
          options: { ...requestOptions, signal: deadline.signal },
          localRequest: (localOptions) => fetchJsonOrRedirect(url, {
            ...localOptions,
            __targetRuntimeBypass: true,
          }),
        }),
        deadlineGate,
      ]);
    } finally {
      deadline.cleanup();
    }
    if (!response || typeof response.ok !== "boolean" || typeof response.status !== "number") return response;
    return parseJsonResponseOrRedirect(response, { cacheKey, cached, cacheMaxAgeMs });
  }

  const headers = new Headers(requestOptions.headers || {});
  if (cached?.etag) {
    headers.set("If-None-Match", cached.etag);
  }

  const directRequest = async () => {
    const deadline = createRequestDeadline(requestOptions.signal);
    let res;
    try {
      res = await fetch(requestUrl, {
        ...requestOptions,
        method,
        headers,
        signal: deadline.signal,
      });
    } catch (error) {
      if (deadline.timedOut()) throw requestTimeoutError();
      throw error;
    } finally {
      deadline.cleanup();
    }
    return parseJsonResponseOrRedirect(res, { cacheKey, cached, cacheMaxAgeMs });
  };

  if (!skipP2P && window.RagentP2P?.ready && Date.now() >= p2pUnavailableUntil) {
    if (requestOptions.signal?.aborted) {
      const abortedError = new Error("Aborted");
      abortedError.name = "AbortError";
      throw abortedError;
    }
    // The P2P leg has no cancellation; a response that lands after the
    // scheduler aborted this request is treated as aborted so callers do not
    // apply stale state from a superseded refresh.
    let p2pTimer;
    const viaP2PResult = new Promise((_, reject) => {
      p2pTimer = setTimeout(() => reject(requestTimeoutError()), RAGENT_P2P_REQUEST_TIMEOUT_MS);
    });
    let abortP2P;
    const viaP2PAbort = requestOptions.signal
      ? new Promise((_, reject) => {
        abortP2P = () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        };
        requestOptions.signal.addEventListener("abort", abortP2P, { once: true });
      })
      : null;
    let viaP2P;
    let directPromise;
    let directStartTimer = null;
    let fatalP2PError = false;
    try {
      // Start the authenticated direct path shortly after P2P instead of
      // waiting for the full opportunistic timeout. This removes the visible
      // 2.5s head-of-line stall when a DataChannel is half-open while keeping
      // healthy paired hosts fast.
      directPromise = new Promise((resolve, reject) => {
        directStartTimer = setTimeout(() => {
          directStartTimer = null;
          directRequest().then(resolve, reject);
        }, RAGENT_P2P_HEAD_START_MS);
        requestOptions.signal?.addEventListener?.("abort", () => {
          if (directStartTimer) clearTimeout(directStartTimer);
          directStartTimer = null;
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
      const p2pPromise = fetchJsonViaP2P(
        requestUrl,
        method,
        headers,
        requestOptions.body,
        cacheKey,
        cached,
      ).catch((error) => {
        if (error?.code === "REQUEST_TIMEOUT" || !Number.isFinite(Number(error?.status))) return null;
        throw error;
      });
      viaP2P = await Promise.race([
        p2pPromise,
        viaP2PResult,
        directPromise,
        ...(viaP2PAbort ? [viaP2PAbort] : []),
      ]);
    } catch (error) {
      // A paired host may be offline while the normal cookie-authenticated
      // HTTP path is healthy.  Timeout is therefore a transport fallback,
      // while caller cancellation remains authoritative.
      if (error?.code !== "REQUEST_TIMEOUT") {
        fatalP2PError = true;
        throw error;
      }
      p2pUnavailableUntil = Math.max(
        p2pUnavailableUntil,
        Date.now() + RAGENT_P2P_FAILURE_COOLDOWN_MS,
      );
      viaP2P = null;
    } finally {
      clearTimeout(p2pTimer);
      // A null P2P result means the authenticated direct request still owns
      // the operation (404/401/405 capability miss or a timeout). Keep its
      // delayed start alive; only cancel it when P2P produced a usable result
      // or a fatal error is being propagated.
      if (fatalP2PError || (viaP2P !== null && viaP2P !== undefined)) {
        if (directStartTimer) clearTimeout(directStartTimer);
        directStartTimer = null;
      }
      requestOptions.signal?.removeEventListener?.("abort", abortP2P);
    }
    if (requestOptions.signal?.aborted) {
      const abortedError = new Error("Aborted");
      abortedError.name = "AbortError";
      throw abortedError;
    }
    if (viaP2P !== null && viaP2P !== undefined) {
      p2pUnavailableUntil = 0;
      return viaP2P;
    }
    if (directPromise) return directPromise;
  }
  return directRequest();
}

function createRequestId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function shouldExpandThinkingBlocksByDefaultForSessionUi() {
  return typeof window.ragentShouldExpandThinkingBlocksByDefault === "function"
    ? window.ragentShouldExpandThinkingBlocksByDefault()
    : false;
}

function resetRenderedEventState(sessionId = null) {
  renderedEventState.sessionId = sessionId;
  renderedEventState.earliestSeq = 0;
  renderedEventState.nextBeforeSeq = null;
  renderedEventState.latestSeq = 0;
  renderedEventState.timelineItemCount = 0;
  renderedEventState.runState = "idle";
  renderedEventState.runActivity = null;
  window.RagentRunActivity?.reset?.();
  renderedEventState.operationNodesById = new Map();
  renderedEventState.operationSnapshotsById = new Map();
  renderedEventState.expandedOperationIds = new Set();
  renderedEventState.runningBlockExpanded = shouldExpandThinkingBlocksByDefaultForSessionUi();
  renderedEventState.hasMoreBefore = false;
  renderedEventState.loadingOlder = false;
}

// A run awaiting an owner decision is still live from the approval surface's
// point of view. Keep this distinct from terminal/idle runs: the provider is
// intentionally paused, but the Decision Sheet must be recoverable after a
// refresh or session switch.
function isApprovalLiveRunState(runState) {
  const normalized = String(runState || "").trim().toLowerCase();
  return normalized === "running" || normalized === "waiting_user";
}

function normalizeRenderedRunState(runState) {
  const normalized = String(runState || "").trim().toLowerCase();
  return isApprovalLiveRunState(normalized) ? normalized : "idle";
}

// ---------------------------------------------------------------------------
// Approval replay gate (shared with session-http.js full-sync renders).
//
// The newest approval_request in a page that is not resolved by any
// approval_response and is not in a terminal status. Managed
// approved_action_batch_request records use the same gate for agent.create
// review, with approved_action_state events deciding whether each action is
// still open. Mirrors the server's findPendingApproval
// (run-activity-projection.mjs) so replay renders agree with the run-activity
// view of what is genuinely pending. Codex proposals (plan events in
// awaiting_decision) participate under the synthesized approval id
// "plan:<planId>" so a running session's live proposal pops the Decision Sheet
// exactly like a Claude plan approval. Returns null when nothing in the page is
// genuinely pending.
//
// Two sweeps, not one: providers replay old approval records into later runs
// (AskUserQuestion/plan artifacts reappear as awaiting_decision after the
// original was already resolved), so the closing signal — an approval_response
// for the same id, or ANY later state for the same planId — may sit BEFORE the
// replayed record in the timeline. A single back-to-front scan would hit the
// replayed record first (its closing signal not yet collected) and wrongly
// mark it pending. Collect every closing signal over the whole list first,
// then scan back-to-front for the newest genuinely-pending record.
function resolvePendingApprovalEvent(events = []) {
  const list = Array.isArray(events) ? events : [];
  const resolvedApprovalIds = new Set();
  const resolvedPlanIds = new Set();
  const resolvedBatchCategories = new Map(); // batchId -> Set<category>
  const resolvedApprovedActionStates = new Map(); // actionId -> latest state
  const resolvedApprovedActionBatches = new Set();
  const TERMINAL_APPROVAL_STATUSES = new Set(
    ["approved", "denied", "declined", "cancelled", "canceled"],
  );
  const TERMINAL_APPROVED_ACTION_STATES = new Set(
    ["denied", "cancelled", "expired", "completed", "failed"],
  );
  // A plan state that is not "awaiting a decision" makes any earlier
  // awaiting_decision record for the same plan stale (drafting/executing/
  // revising/terminal supersede it later in the timeline). 'cancelled' is the
  // terminal state the server writes when the plan's run is cancelled — the
  // request moment has passed, so it must never re-open the Decision Sheet.
  const PLAN_STALE_STATES = new Set(
    ["drafting", "executing", "revising", "completed", "failed", "superseded", "cancelled"],
  );
  const normalizeBatchCategory = (value) => {
    const category = String(value || "").trim().toLowerCase();
    if (category === "privileged_other" || category === "other") return "other";
    if (category === "destructive_delete" || category === "delete") return "delete";
    return category;
  };
  for (const event of list) {
    if (event?.type === "approval_response") {
      const approvalId = String(event?.approvalId || "").trim();
      if (approvalId) resolvedApprovalIds.add(approvalId);
    } else if (event?.type === "privileged_batch_response") {
      // Each category group resolves through its own response event; a batch
      // stays pending until every non-empty category is resolved.
      const batchId = String(event?.batchId || "").trim();
      const category = normalizeBatchCategory(event?.category);
      if (batchId && category) {
        if (!resolvedBatchCategories.has(batchId)) resolvedBatchCategories.set(batchId, new Set());
        resolvedBatchCategories.get(batchId).add(category);
      }
    } else if (event?.type === "approved_action_state") {
      const actionId = String(event?.actionId || "").trim();
      if (actionId) {
        resolvedApprovedActionStates.set(
          actionId,
          String(event?.state || "").trim().toLowerCase(),
        );
      }
    } else if (event?.type === "approved_action_batch_response") {
      const batchId = String(event?.batchId || "").trim();
      if (batchId) resolvedApprovedActionBatches.add(batchId);
    } else if (event?.type === "plan") {
      const planId = String(event?.planId || "").trim();
      if (planId && PLAN_STALE_STATES.has(String(event?.state || "").trim().toLowerCase())) {
        resolvedPlanIds.add(planId);
      }
    }
  }
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index];
    if (event?.type === "approval_request") {
      const approvalId = String(event?.approvalId || "").trim();
      if (approvalId && resolvedApprovalIds.has(approvalId)) continue;
      if (TERMINAL_APPROVAL_STATUSES.has(String(event?.status || "").toLowerCase())) continue;
      return event;
    }
    if (event?.type === "privileged_batch_request") {
      const batchId = String(event?.batchId || "").trim();
      if (!batchId) continue;
      const resolved = resolvedBatchCategories.get(batchId) || new Set();
      const categories = [];
      if (Array.isArray(event?.other) && event.other.length > 0) categories.push("other");
      if (Array.isArray(event?.delete) && event.delete.length > 0) categories.push("delete");
      if (categories.length === 0) continue;
      if (categories.every((category) => resolved.has(category))) continue;
      // Replay the batch as the live pending approval (its id doubles as the
      // gate key so the sheet re-opens with the remaining groups on refresh).
      return { ...event, approvalId: batchId };
    }
    if (event?.type === "approved_action_batch_request") {
      const actions = Array.isArray(event?.actions) ? event.actions : [];
      const pendingAction = actions.find((action) => {
        const actionId = String(action?.actionId || "").trim();
        const state = resolvedApprovedActionStates.get(actionId)
          || String(action?.state || "").trim().toLowerCase();
        return !TERMINAL_APPROVED_ACTION_STATES.has(state);
      });
      const batchId = String(event?.batchId || "").trim();
      if (batchId && resolvedApprovedActionBatches.has(batchId)) continue;
      if (!pendingAction || !batchId) continue;
      // The batch id is the live gate key used by realtime-render.js. Returning
      // it as approvalId lets a full-sync/reconnect restore the Decision Sheet.
      return { ...event, approvalId: batchId };
    }
    if (event?.type === "plan") {
      const planId = String(event?.planId || "").trim();
      if (!planId) continue;
      const state = String(event?.state || "").trim().toLowerCase();
      if (resolvedPlanIds.has(planId)) continue;
      if (planId && resolvedApprovalIds.has(`plan:${planId}`)) continue;
      if (isPlanProgressEventLike(event) || state !== "awaiting_decision") continue;
      return {
        type: "approval_request",
        approvalId: `plan:${planId}`,
        kind: "plan",
        status: "pending",
        ...(String(event?.title || "").trim() ? { title: String(event.title).trim() } : {}),
        ...(String(event?.bodyMarkdown || "").trim() ? { reason: String(event.bodyMarkdown).trim() } : {}),
        ...(String(event?.runId || "").trim() ? { runId: String(event.runId).trim() } : {}),
        planEventRef: { planId },
      };
    }
  }
  return null;
}

// Mirrors ui.js isPlanProgressEvent for the replay gate: progress plans
// (planIntent "progress" / agent interaction mode) are execution tracking,
// not proposals awaiting a decision.
function isPlanProgressEventLike(evt) {
  const planIntent = String(evt?.planIntent || "").trim().toLowerCase();
  if (planIntent) return planIntent === "progress";
  return String(evt?.interactionMode || "").trim().toLowerCase() === "agent";
}
