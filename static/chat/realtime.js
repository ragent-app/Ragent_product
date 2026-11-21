// ---- WebSocket ----
function t(key, vars) {
  return window.ragentT ? window.ragentT(key, vars) : key;
}

function renderRealtimeIcon(name, className = "") {
  return window.RagentIcons?.render(name, { className }) || "";
}

function resolveWsUrl(path) {
  if (typeof withVisitorModeUrl === "function") {
    return withVisitorModeUrl(path);
  }
  return typeof path === "string" ? path : String(path || "");
}

const WS_RECONNECT_BASE_DELAY_MS = 1_000;
const WS_RECONNECT_MAX_DELAY_MS = 30_000;
const WS_RECONNECT_JITTER_RATIO = 0.2;
const TARGET_RUNTIME_REMOTE_POLL_INTERVAL_MS = 3_000;
let reconnectAttempt = 0;
// 入口切换交接标记：置位后 WS 不再重连、P2P 不再激活（见 prepareEntrySwitchHandoff）。
let entrySwitchHandoff = false;
const SEND_FALLBACK_REFRESH_DELAY_MS = 220;
const MESSAGE_SUBMIT_TIMEOUT_MS = 20_000;
const MESSAGE_SUBMIT_CONFIRMATION_RETRY_DELAY_MS = 350;
const MESSAGE_SUBMIT_CONFIRMATION_ATTEMPTS = 3;
const pendingSendRefreshTimers = new Map();
const EVENT_PUSH_RECONCILE_DELAY_MS = 900;
const pendingEventPushReconcileTimers = new Map();
let targetRuntimePollingTimer = null;
let targetRuntimePollingGeneration = 0;

function targetRuntimeGlobal() {
  return typeof window === "object" ? window.RagentTargetRuntime : null;
}

function isRemoteTargetActive() {
  const runtime = targetRuntimeGlobal();
  const active = runtime?.getActiveTarget?.();
  const localTargetId = runtime?.getLocalTargetId?.();
  return Boolean(active?.targetId && localTargetId && active.targetId !== localTargetId);
}

function stopTargetRuntimePolling() {
  targetRuntimePollingGeneration += 1;
  if (targetRuntimePollingTimer) {
    clearInterval(targetRuntimePollingTimer);
    targetRuntimePollingTimer = null;
  }
}

function pollActiveRemoteTarget(generation) {
  if (generation !== targetRuntimePollingGeneration || !isRemoteTargetActive()) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (typeof queueForegroundRefresh === "function") {
    queueForegroundRefresh({ forceFresh: true, viewportIntent: "preserve" }).catch(() => {});
  }
  const runtime = targetRuntimeGlobal();
  const targetId = runtime?.getActiveTarget?.()?.targetId;
  if (targetId) {
    const result = runtime?.readSummaryEvents?.(targetId);
    result?.catch?.(() => {});
  }
}

function startTargetRuntimePolling() {
  stopTargetRuntimePolling();
  if (!isRemoteTargetActive()) return;
  const generation = targetRuntimePollingGeneration;
  pollActiveRemoteTarget(generation);
  targetRuntimePollingTimer = setInterval(() => pollActiveRemoteTarget(generation), TARGET_RUNTIME_REMOTE_POLL_INTERVAL_MS);
}

function closeLocalRealtimeSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const socket = ws;
  if (socket && typeof socket.close === "function" && socket.readyState <= 1) {
    socket.onclose = null;
    socket.close();
  }
  ws = null;
}

function syncTargetRuntimeRealtime() {
  if (isRemoteTargetActive()) {
    closeLocalRealtimeSocket();
    if (typeof window === "object" && typeof window.RagentP2P?.close === "function") {
      try { window.RagentP2P.close(); } catch {}
    }
    startTargetRuntimePolling();
    return;
  }
  stopTargetRuntimePolling();
  if (!entrySwitchHandoff && (!ws || ws.readyState !== WebSocket.OPEN)) connect();
}

function isLocalBrowserHostname(value) {
  const hostname = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const ipv4 = hostname.split(".");
  return ipv4.length === 4
    && ipv4.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
    && Number(ipv4[0]) === 127;
}

function shouldSkipP2PForMessageSubmit() {
  return isLocalBrowserHostname(window.location?.hostname);
}

// The POST response already carries the accepted session projection. A full
// transcript reset in the same task as the response used to make the local
// user bubble disappear before the canonical event arrived, and it made send
// feel blocked behind a redundant render. Let the normal WS event win; keep a
// short, one-shot HTTP refresh only as a missed-event safety net.
function schedulePostSendRefresh(sessionId, requestId = "") {
  if (!sessionId || typeof refreshCurrentSession !== "function") return;
  // Keep one fallback timer per outbound request. Keying this by session used
  // to let a later quick send cancel the earlier request's only recovery pass.
  const timerKey = requestId || `session:${sessionId}`;
  const previous = pendingSendRefreshTimers.get(timerKey);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    pendingSendRefreshTimers.delete(timerKey);
    if (currentSessionId !== sessionId) return;
    if (
      requestId
      && typeof findCommittedUserMessageNode === "function"
      && findCommittedUserMessageNode(requestId)
    ) {
      return;
    }
    refreshCurrentSession({ forceFresh: true }).catch(() => {});
  }, SEND_FALLBACK_REFRESH_DELAY_MS);
  pendingSendRefreshTimers.set(timerKey, timer);
}

function scheduleEventPushReconcile(sessionId) {
  if (!sessionId || typeof refreshCurrentSession !== "function") return;
  const previous = pendingEventPushReconcileTimers.get(sessionId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    pendingEventPushReconcileTimers.delete(sessionId);
    if (currentSessionId !== sessionId) return;
    // The WS delta made the transcript responsive; this is a bounded
    // authoritative repair pass for dropped frames and session/run metadata.
    refreshCurrentSession({ forceFresh: true }).catch(() => {});
  }, EVENT_PUSH_RECONCILE_DELAY_MS);
  pendingEventPushReconcileTimers.set(sessionId, timer);
}

function isAmbiguousMessageSubmitError(error) {
  const message = String(error?.message || "").trim().toLowerCase();
  if (message === "authentication required" || message.includes("webauthn")) return false;
  const status = Number(error?.status);
  // 4xx responses are caller-visible validation/auth/access failures. Network
  // errors, aborts and 5xx responses are different: the server may have
  // committed the message before the response was lost.
  return error?.name === "AbortError"
    || !Number.isFinite(status)
    || status >= 500;
}

function hasMessageSubmitAcceptance(sessionId, requestId, session = null) {
  if (!sessionId || !requestId) return false;
  if (currentSessionId === sessionId) {
    if (
      typeof findCommittedUserMessageNode === "function"
      && findCommittedUserMessageNode(requestId)
    ) {
      return true;
    }
    if (
      typeof hasCanonicalComposerSendAcceptance === "function"
      && hasCanonicalComposerSendAcceptance(
        session || (typeof getCurrentSession === "function" ? getCurrentSession() : null),
      )
    ) {
      return true;
    }
  }
  return Array.isArray(session?.queuedMessages)
    && session.queuedMessages.some((entry) => entry?.requestId === requestId);
}

async function reconcileAmbiguousMessageSubmit(sessionId, requestId) {
  const refresh = currentSessionId === sessionId
    ? (typeof refreshCurrentSession === "function" ? refreshCurrentSession : null)
    : (typeof refreshSidebarSession === "function" ? refreshSidebarSession : null);
  if (typeof refresh !== "function") return false;

  for (let attempt = 0; attempt < MESSAGE_SUBMIT_CONFIRMATION_ATTEMPTS; attempt += 1) {
    if (hasMessageSubmitAcceptance(sessionId, requestId)) return true;
    try {
      const session = await refresh({ forceFresh: true, essential: true });
      if (hasMessageSubmitAcceptance(sessionId, requestId, session)) {
        if (
          currentSessionId === sessionId
          && typeof reconcileComposerPendingSendWithSession === "function"
          && session
        ) {
          reconcileComposerPendingSendWithSession(session);
        }
        return true;
      }
    } catch {
      // The original submit and this confirmation request can fail together;
      // keep the bounded confirmation window alive for the next attempt.
    }
    if (attempt + 1 < MESSAGE_SUBMIT_CONFIRMATION_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, MESSAGE_SUBMIT_CONFIRMATION_RETRY_DELAY_MS));
    }
  }
  return hasMessageSubmitAcceptance(sessionId, requestId);
}

function connect() {
  if (typeof isRemoteTargetActive === "function" && isRemoteTargetActive()) {
    if (typeof startTargetRuntimePolling === "function") startTargetRuntimePolling();
    return;
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}${resolveWsUrl("/ws")}`);
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    if (typeof isRemoteTargetActive === "function" && isRemoteTargetActive()) {
      closeLocalRealtimeSocket();
      startTargetRuntimePolling();
      return;
    }
    reconnectAttempt = 0;
    updateStatus("connected", getCurrentSession());
    const chatGlobal = typeof window === "object" ? window : globalThis;
    if (typeof chatGlobal.requestHomeWorkspaceRefresh === "function") {
      chatGlobal.requestHomeWorkspaceRefresh();
    }
    if (hasSeenWsOpen) {
      refreshRealtimeViews({ viewportIntent: "preserve" }).catch(() => {});
    } else {
      hasSeenWsOpen = true;
    }
  };

  socket.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleWsMessage(msg);
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    updateStatus("disconnected", getCurrentSession());
    scheduleReconnect();
  };

  socket.onerror = () => {
    if (ws === socket) socket.close();
  };
}

// Top-level function declarations in a plain <script> become window
// properties, which would shadow home-workspace's requestHomeWorkspaceRefresh
// hook (the very hook this helper calls) and recurse forever. Keep it a const.
const requestHomeWorkspaceRefresh = () => {
  const chatGlobal = typeof window === "object" ? window : globalThis;
  if (typeof chatGlobal.requestHomeWorkspaceRefresh === "function") {
    chatGlobal.requestHomeWorkspaceRefresh();
  }
};

function scheduleReconnect() {
  // Some focused tests evaluate this function in isolation, without the
  // module-level handoff state. Keep the guard safe in that environment too.
  if (typeof entrySwitchHandoff !== "undefined" && entrySwitchHandoff) return;
  if (typeof isRemoteTargetActive === "function" && isRemoteTargetActive()) return;
  if (reconnectTimer) return;
  if (isNetworkOffline()) return;
  const exponent = Math.min(reconnectAttempt, 5);
  const baseDelay = Math.min(
    WS_RECONNECT_MAX_DELAY_MS,
    WS_RECONNECT_BASE_DELAY_MS * (2 ** exponent),
  );
  const jitter = 1 - WS_RECONNECT_JITTER_RATIO + (Math.random() * WS_RECONNECT_JITTER_RATIO * 2);
  const delayMs = Math.min(WS_RECONNECT_MAX_DELAY_MS, Math.round(baseDelay * jitter));
  reconnectAttempt = Math.min(reconnectAttempt + 1, 6);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
    maybeActivateP2P();
  }, delayMs);
}

function syncRealtimeNetworkConnection() {
  syncConnectionRecoveryIndicatorNetworkState();
  if (isNetworkOffline()) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    return;
  }
  if (typeof isRemoteTargetActive === "function" && isRemoteTargetActive()) {
    startTargetRuntimePolling();
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) scheduleReconnect();
}

// WS 断线重连失败时自动尝试 P2P 第二通道（仅当本会话已配对并持有凭据）。
function maybeActivateP2P() {
  if (typeof entrySwitchHandoff !== "undefined" && entrySwitchHandoff) return;
  if (typeof window.RagentP2P === "undefined" || !window.RagentP2P.hasCredentials) return;
  if (window.RagentP2P.ready || window.RagentP2P.status === "connecting") return;
  window.RagentP2P.connect().catch(() => {});
}

// 入口切换交接（P1-④）：浏览器即将跳到另一实例。显式丢弃本实例的通道凭据——
// 关闭 WS 且不再重连、关闭 P2P 备份通道，避免跳转窗口期把旧实例的
// DataChannel 代理流量带到新实例的 API 上（信令房间 15 分钟 TTL 自然回收）。
function prepareEntrySwitchHandoff() {
  entrySwitchHandoff = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const socket = ws;
  if (socket && typeof socket.close === "function" && socket.readyState <= 1) {
    socket.onclose = null;
    socket.close();
  }
  ws = null;
  if (typeof window.RagentP2P?.close === "function") {
    try {
      window.RagentP2P.close();
    } catch {
      // 交接路径上不再有可恢复动作；关闭失败不阻塞跳转。
    }
  }
}

// 供 cross-device-panel 在跳转前调用；显式挂到 window，避免依赖脚本加载顺序。
if (typeof window === "object") {
  window.RagentEntrySwitchHandoff = { prepare: prepareEntrySwitchHandoff };
}

if (typeof window === "object" && typeof window.addEventListener === "function") {
  window.addEventListener("ragent:p2p-status", (event) => {
    const status = event?.detail?.status;
    if (status === "ready") {
      updateStatus("p2p", getCurrentSession());
      if (typeof showSystemToast === "function") {
        showSystemToast(t("p2p.activated"), "info");
      }
    } else if (status === "closed" && ws?.readyState === WebSocket.OPEN) {
      updateStatus("connected", getCurrentSession());
    }
  });

  window.addEventListener("online", syncRealtimeNetworkConnection);
  window.addEventListener("offline", syncRealtimeNetworkConnection);
  window.addEventListener("ragent:target-selected", syncTargetRuntimeRealtime);
  window.addEventListener("ragent:target-change", syncTargetRuntimeRealtime);
}

function base64UrlToArrayBuffer(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

// True when the server says the approval target no longer exists or its run
// is over — the UI must treat the approval as resolved instead of failing.
function isApprovalAlreadyEndedError(error) {
  const code = String(error?.code || "").toUpperCase();
  if (["APPROVAL_NOT_FOUND", "RUN_TERMINAL", "RUN_NOT_FOUND"].includes(code)) return true;
  const status = Number(error?.status || 0);
  return status === 404 || status === 409 || status === 410;
}

function isPlanAlreadyEndedError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  if (code === "PLAN_NOT_FOUND") return true;
  const status = Number(error?.status || 0);
  return status === 404 || status === 410;
}

function isCurrentAttachAction(msg) {
  if (!msg?.sessionId) return false;
  const isTargetSession = currentSessionId === msg.sessionId
    || (typeof pendingNavigationState === "object" && pendingNavigationState?.sessionId === msg.sessionId);
  if (!isTargetSession) return false;
  if (
    msg.navigationGeneration
    && typeof isSessionNavigationCurrent === "function"
    && !isSessionNavigationCurrent(msg.navigationGeneration, msg.sessionId)
  ) {
    return false;
  }
  return true;
}

// Transport-class failures are worth one more attempt: a phone waking from
// the background often finds its sockets dead, so the first request after
// resume can fail without implying anything about the session itself.
// Definitive rejections (not found, projection bugs) surface immediately.
// Mirrors classifySessionEventRefreshError without depending on session-http
// being loaded in the same scope (this file is slice-loaded by unit tests).
function isTransientSessionRefreshError(error) {
  if (!error || error.name === "AbortError") return false;
  if (error.code === "SESSION_REFRESH_CANCELLED") return false;
  if (Number(error.status) === 404) return false;
  if (Number(error.status) > 0) return true;
  if (error.code === "EVENTS_RESPONSE_INVALID") return true;
  if (error.code === "TIMELINE_PROJECTION_FAILED") return false;
  if (error.code === "TIMELINE_RUNTIME_UNAVAILABLE") return false;
  return true;
}

async function dispatchAction(msg) {
  let messageSubmitIdentity = null;
  let messageSubmitStarted = false;
  try {
    switch (msg.action) {
      case "list":
        await fetchSessionsList();
        return true;
      case "attach": {
        const viewportIntent = typeof normalizeSessionViewportIntent === "function"
          ? normalizeSessionViewportIntent(msg.viewportIntent || "session_entry_bottom")
          : "session_entry_bottom";
        if (
          msg.navigationGeneration
          && typeof isSessionNavigationCurrent === "function"
          && !isSessionNavigationCurrent(msg.navigationGeneration, msg.sessionId)
        ) {
          return "cancelled";
        }
        const previousSessionId = currentSessionId;
        if (typeof setChatCurrentSession === "function") {
          setChatCurrentSession(msg.sessionId, { hasAttachedSession: false });
        } else {
          currentSessionId = msg.sessionId;
          hasAttachedSession = false;
        }
        if (typeof clearMessages === "function") {
          clearMessages({
            // Any session switch keeps the visible transcript until the first
            // durable page for the target session renders — including a
            // switch that follows a failed attach, where hasAttachedSession
            // is already false but the old transcript is still on screen.
            // Wiping it here is what turned one failed load into the
            // "blank page until manual reload" report.
            preserveContent: Boolean(previousSessionId)
              && previousSessionId !== msg.sessionId,
          });
        }
        if (typeof scheduleSessionLoadingSkeleton === "function") {
          scheduleSessionLoadingSkeleton();
        }
        // A cached session record only proves that the session exists. It does
        // not prove that its timeline is loaded, and using it to bypass the
        // scheduler reintroduced the attach-cancellation race. Route every
        // attach through the same state + events refresh pipeline.
        //
        // The scheduler resolves an aborted request with null: a newer
        // same-key refresh (for example the forceFresh refresh after a
        // WebSocket reconnect) took over and now owns rendering the
        // transcript. Cancellation is not a load failure, so re-join the
        // newest owner — an equal-or-weaker intent coalesces onto the
        // in-flight request — instead of surfacing an error card. The bound
        // (20 joins, ~3s with backoff) stops a pathological invalidation
        // storm from spinning forever. Keep the limit as a literal: this
        // function is slice-loaded in isolation by unit tests.
        let refreshedSession = null;
        for (let transientRetry = 0; ; transientRetry += 1) {
          try {
            for (let attachAttempt = 0; attachAttempt < 20; attachAttempt += 1) {
              if (typeof isCurrentAttachAction === "function" && !isCurrentAttachAction(msg)) return "cancelled";
              refreshedSession = await refreshCurrentSession({
                viewportIntent,
                essential: true,
              });
              if (refreshedSession !== null) break;
              if (typeof sleep === "function") await sleep(150);
            }
            break;
          } catch (error) {
            // One flaky request right after resume must not land the reader
            // on an error card; retry transport-class failures a bounded
            // number of times before giving up.
            if (transientRetry >= 2 || !isTransientSessionRefreshError(error)) throw error;
            if (typeof sleep === "function") await sleep(300 * (transientRetry + 1));
          }
        }
        if (
          refreshedSession === null
          && typeof isCurrentAttachAction === "function"
          && !isCurrentAttachAction(msg)
        ) return "cancelled";
        if (
          msg.navigationGeneration
          && typeof isSessionNavigationCurrent === "function"
          && !isSessionNavigationCurrent(msg.navigationGeneration, msg.sessionId)
        ) {
          return "cancelled";
        }
        if (refreshedSession === null) {
          if (typeof setChatCurrentSession === "function") {
            setChatCurrentSession(msg.sessionId, { hasAttachedSession: false });
          } else {
            hasAttachedSession = false;
          }
          if (typeof resetAttachedSessionRenderState === "function") {
            resetAttachedSessionRenderState();
          }
          if (typeof showSessionLoadError === "function") {
            const error = new Error("Session attach failed");
            error.code = "SESSION_ATTACH_FAILED";
            error.eventRefreshReason = "attach_failed";
            showSessionLoadError(msg.sessionId, error, "attach_failed");
          }
          return false;
        }
        if (typeof setChatCurrentSession === "function") {
          setChatCurrentSession(msg.sessionId, { hasAttachedSession: true });
        } else {
          currentSessionId = msg.sessionId;
          hasAttachedSession = true;
        }
        return true;
      }
      case "create": {
        const createPayload = {
          folder: msg.folder
            || (typeof window.ragentGetSelectedSessionFolder === "function"
              ? window.ragentGetSelectedSessionFolder()
              : (typeof window.ragentGetDefaultSessionFolder === "function"
                ? window.ragentGetDefaultSessionFolder()
                : "~")),
          tool: msg.tool,
          name: msg.name || "",
          sourceId: msg.sourceId || "",
          sourceName: msg.sourceName || "",
          templateId: msg.templateId || "",
          templateName: msg.templateName || "",
          sourceContext: msg.sourceContext,
          ...(typeof msg.projectId === "string" && msg.projectId.trim()
            ? { projectId: msg.projectId.trim() }
            : {}),
          ...(typeof msg.providerProfile === "string" && msg.providerProfile.trim()
            ? { providerProfile: msg.providerProfile.trim() }
            : {}),
          ...(typeof msg.model === "string" && msg.model.trim()
            ? { model: msg.model.trim() }
            : {}),
          ...(typeof window.RagentI18n?.getActiveUiLanguage === "function"
            ? { uiLanguage: window.RagentI18n.getActiveUiLanguage() || "" }
            : {}),
        };
        if (Object.prototype.hasOwnProperty.call(msg, "starterPreset")) {
          createPayload.starterPreset = msg.starterPreset || "";
        }
        if (Object.prototype.hasOwnProperty.call(msg, "systemPrompt")) {
          createPayload.systemPrompt = msg.systemPrompt || "";
        }
        if (Object.prototype.hasOwnProperty.call(msg, "welcomeMessage")) {
          createPayload.welcomeMessage = msg.welcomeMessage || "";
        }
        const data = await fetchJsonOrRedirect("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createPayload),
        });
        if (data.session) {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          if (typeof navigateToSession === "function") {
            await navigateToSession(session.id, {
              session,
              tab: "sessions",
              historyMode: "push",
              forceComposerFocus: msg.forceComposerFocus === true,
            });
          } else {
            if (typeof syncBrowserState === "function") {
              syncBrowserState({ sessionId: session.id, tab: "sessions", historyMode: "push" });
            }
            const attachPromise = attachSession(session.id, session, {
              forceComposerFocus: msg.forceComposerFocus === true,
            });
            if (attachPromise && typeof attachPromise.then === "function") await attachPromise;
          }
          if (typeof syncEmptyStateUi === "function") {
            syncEmptyStateUi();
          }
          if (inputArea) {
            inputArea.hidden = false;
          }
        } else {
          await fetchSessionsList();
        }
        return true;
      }
      case "rename": {
        const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(msg.sessionId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: msg.name }),
        });
        if (data.session) {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          if (currentSessionId === msg.sessionId) {
            applyAttachedSessionState(msg.sessionId, session);
          }
        } else if (currentSessionId === msg.sessionId) {
          await refreshCurrentSession();
        } else {
          await refreshSidebarSession(msg.sessionId);
        }
        return true;
      }
      case "session_preferences": {
        const payload = {};
        if (Object.prototype.hasOwnProperty.call(msg, "tool")) payload.tool = msg.tool || "";
        if (Object.prototype.hasOwnProperty.call(msg, "providerProfile")) payload.providerProfile = msg.providerProfile || "";
        if (Object.prototype.hasOwnProperty.call(msg, "model")) payload.model = msg.model || "";
        if (Object.prototype.hasOwnProperty.call(msg, "effort")) payload.effort = msg.effort || "";
        if (Object.prototype.hasOwnProperty.call(msg, "serviceTier")) payload.serviceTier = msg.serviceTier || "";
        if (Object.prototype.hasOwnProperty.call(msg, "permissionMode")) payload.permissionMode = msg.permissionMode || "";
        if (Object.prototype.hasOwnProperty.call(msg, "thinking")) payload.thinking = msg.thinking === true;
        if (Object.prototype.hasOwnProperty.call(msg, "interactionMode")) payload.interactionMode = msg.interactionMode || "agent";
        const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(msg.sessionId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (data.session) {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          if (currentSessionId === msg.sessionId) {
            applyAttachedSessionState(msg.sessionId, session);
          }
        } else if (currentSessionId === msg.sessionId) {
          await refreshCurrentSession();
        } else {
          await refreshSidebarSession(msg.sessionId);
        }
        return true;
      }
      case "delete": {
        const deletingCurrentSession = currentSessionId === msg.sessionId;
        await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(msg.sessionId)}`, {
          method: "DELETE",
        });
        if (typeof removeChatSessionState === "function") {
          removeChatSessionState(msg.sessionId, {
            compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
          });
        } else {
          sessions = sessions.filter((session) => session?.id !== msg.sessionId);
          if (deletingCurrentSession) {
            currentSessionId = null;
            hasAttachedSession = false;
          }
        }
        if (deletingCurrentSession) {
          if (typeof resetAttachedSessionRenderState === "function") resetAttachedSessionRenderState();
          if (typeof clearMessages === "function") clearMessages();
          if (typeof persistActiveSessionId === "function") persistActiveSessionId(null);
          if (typeof syncBrowserState === "function") {
            syncBrowserState({
              sessionId: null,
              tab: typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : "sessions",
            });
          }
          if (typeof showEmpty === "function") showEmpty();
          if (typeof updateStatus === "function") updateStatus("connected");
        }
        renderSessionList();
        if (typeof syncEmptyStateUi === "function") syncEmptyStateUi();
        return true;
      }
      case "pin":
      case "unpin": {
        const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(msg.sessionId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pinned: msg.action === "pin" }),
        });
        if (data.session) {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          if (currentSessionId === msg.sessionId) {
            applyAttachedSessionState(msg.sessionId, session);
          }
        } else if (currentSessionId === msg.sessionId) {
          await refreshCurrentSession();
        } else {
          await fetchSessionsList();
        }
        return true;
      }
      case "send": {
        const targetSessionId = msg.sessionId || currentSessionId;
        if (!targetSessionId) return false;
        const requestId = msg.requestId || createRequestId();
        messageSubmitIdentity = { sessionId: targetSessionId, requestId };
        const attachments = Array.isArray(msg.attachments)
          ? msg.attachments
          : (Array.isArray(msg.images) ? msg.images : []);
        const hasLocalFileAttachments = attachments.some((image) => image?.file);
        const canUseMultipart = hasLocalFileAttachments && typeof FormData === "function";
        const requestUrl = `/api/sessions/${encodeURIComponent(targetSessionId)}/messages`;
        const submitController = typeof AbortController === "function" ? new AbortController() : null;
        const submitTimeout = setTimeout(() => submitController?.abort(), MESSAGE_SUBMIT_TIMEOUT_MS);
        const submitOptions = submitController ? { signal: submitController.signal } : {};
        const messageTransportOptions = {
          skipP2P: typeof shouldSkipP2PForMessageSubmit === "function"
            ? shouldSkipP2PForMessageSubmit()
            : false,
        };
        let data;
        try {
          // WebAuthn and other preflight work happens before this point. Only
          // errors after entering the actual message POST are ambiguous: a
          // cancelled preflight must remain a definite send failure.
          messageSubmitStarted = true;
          data = canUseMultipart
            ? await (async () => {
                const formData = new FormData();
                const existingAttachments = [];
                const externalAttachments = [];
                formData.set("requestId", requestId);
                formData.set("text", msg.text || "");
                if (msg.model) formData.set("model", msg.model);
                if (msg.effort) formData.set("effort", msg.effort);
                if (msg.serviceTier) formData.set("serviceTier", msg.serviceTier);
                if (msg.thinking) formData.set("thinking", "true");
                if (msg.interactionMode) formData.set("interactionMode", msg.interactionMode);
                if (msg.permissionMode) formData.set("permissionMode", msg.permissionMode);
                if (msg.planAction) formData.set("planAction", msg.planAction);
                if (msg.planId) formData.set("planId", msg.planId);
                if (msg.uiLanguage) formData.set("uiLanguage", msg.uiLanguage);
                for (const image of attachments) {
                  if (image?.file) {
                    formData.append("attachments", image.file, image.originalName || image.file.name || "attachment");
                    continue;
                  }
                  if (image?.assetId) {
                    externalAttachments.push({
                      assetId: image.assetId,
                      originalName: image.originalName || "",
                      mimeType: image.mimeType || "",
                      ...(image?.renderAs === "file" ? { renderAs: "file" } : {}),
                    });
                    continue;
                  }
                  if (!image?.filename) continue;
                  existingAttachments.push({
                    filename: image.filename,
                    originalName: image.originalName || "",
                    mimeType: image.mimeType || "",
                  });
                }
                if (existingAttachments.length > 0) {
                  formData.set("existingAttachments", JSON.stringify(existingAttachments));
                }
                if (externalAttachments.length > 0) {
                  formData.set("externalAttachments", JSON.stringify(externalAttachments));
                }
                return fetchJsonOrRedirect(requestUrl, {
                  method: "POST",
                  body: formData,
                  ...submitOptions,
                  ...messageTransportOptions,
                });
              })()
            : await fetchJsonOrRedirect(requestUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  requestId,
                  text: msg.text,
                  ...(attachments.length > 0 ? { attachments } : {}),
                  ...(msg.model ? { model: msg.model } : {}),
                  ...(msg.effort ? { effort: msg.effort } : {}),
                  ...(msg.serviceTier ? { serviceTier: msg.serviceTier } : {}),
                  ...(msg.thinking ? { thinking: true } : {}),
                  ...(msg.interactionMode ? { interactionMode: msg.interactionMode } : {}),
                  ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
                  ...(msg.planAction ? { planAction: msg.planAction } : {}),
                  ...(msg.planId ? { planId: msg.planId } : {}),
                  ...(msg.uiLanguage ? { uiLanguage: msg.uiLanguage } : {}),
                }),
                ...submitOptions,
                ...messageTransportOptions,
              });
        } finally {
          clearTimeout(submitTimeout);
        }
        const acknowledgedRequestId = data.requestId || requestId;
        const nextPendingStage = data?.session?.activity?.planning?.state === "checking"
          && (!data?.session?.activity?.planning?.requestId || data.session.activity.planning.requestId === acknowledgedRequestId)
          ? "checking"
          : "processing";
        if (data.session) {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          if (currentSessionId === session.id) {
            applyAttachedSessionState(session.id, session);
          }
        }
        // Apply the server projection while the pending send is still in its
        // transport stage. The queue renderer can then reconcile the optimistic
        // row to the durable row without a remove/recreate flash. If the
        // response has no session projection, the ACK below still clears the
        // local transport state before the follow-up refresh.
        if (typeof acknowledgeComposerPendingSend === "function") {
          acknowledgeComposerPendingSend(acknowledgedRequestId, {
            nextStage: nextPendingStage,
          });
        } else if (typeof finalizeComposerPendingSend === "function") {
          finalizeComposerPendingSend(acknowledgedRequestId);
        }
        if (currentSessionId === targetSessionId) {
          if (typeof schedulePostSendRefresh === "function") {
            schedulePostSendRefresh(targetSessionId, acknowledgedRequestId);
          } else {
            // Standalone test harnesses and older hot-mounted pages keep the
            // original synchronous fallback until the helper is available.
            try {
              await refreshCurrentSession();
            } catch {
              setTimeout(() => refreshCurrentSession().catch(() => {}), 0);
            }
          }
        } else {
          try {
            await refreshSidebarSession(targetSessionId);
          } catch {
            setTimeout(() => refreshSidebarSession(targetSessionId).catch(() => {}), 0);
          }
        }
        return true;
      }
      case "plan_action": {
        const targetSessionId = msg.sessionId || currentSessionId;
        const planId = String(msg.planId || "").trim();
        const planAction = String(msg.planAction || "").trim().toLowerCase();
        if (!targetSessionId || !planId || !["revise", "execute"].includes(planAction)) return false;
        const data = await fetchJsonOrRedirect(
          `/api/sessions/${encodeURIComponent(targetSessionId)}/plans/${encodeURIComponent(planId)}/actions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: planAction,
              text: msg.text || "",
              requestId: msg.requestId || createRequestId(),
              ...(msg.model ? { model: msg.model } : {}),
              ...(msg.effort ? { effort: msg.effort } : {}),
              ...(msg.serviceTier ? { serviceTier: msg.serviceTier } : {}),
              ...(msg.thinking ? { thinking: true } : {}),
            }),
          },
        );
        if (data.session) {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          if (currentSessionId === session.id) {
            applyAttachedSessionState(session.id, session);
          }
        }
        try {
          if (currentSessionId === targetSessionId) {
            await refreshCurrentSession();
          } else {
            await refreshSidebarSession(targetSessionId);
          }
        } catch {
          setTimeout(() => {
            if (currentSessionId === targetSessionId) {
              refreshCurrentSession().catch(() => {});
            } else {
              refreshSidebarSession(targetSessionId).catch(() => {});
            }
          }, 0);
        }
        return true;
      }
      case "runtime_approval": {
        const originSessionId = String(msg.sessionId || currentSessionId || "").trim();
        const runId = String(msg.runId || "").trim();
        const approvalId = String(msg.approvalId || "").trim();
        const decision = String(msg.decision || "").trim();
        if (!runId || !approvalId || !decision) return false;
        let data;
        try {
          data = await fetchJsonOrRedirect(
            `/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                decision,
                requestId: msg.requestId || createRequestId(),
                ...(Array.isArray(msg.choices) ? { choices: msg.choices } : {}),
                ...(typeof msg.customAnswer === "string" && msg.customAnswer.trim()
                  ? { customAnswer: msg.customAnswer.trim().slice(0, 8000) }
                  : {}),
              }),
            },
          );
        } catch (error) {
          if (isApprovalAlreadyEndedError(error)) {
            // The approval this sheet/card shows is already over (the run
            // ended or the provider resolved it). Treat it as resolved:
            // dismiss the sheet, mark any in-stream plan card, resync — the
            // red error toast would only confuse ("actually it ended").
            window.RagentDecisions?.noteResponse({ approvalId });
            window.RagentDecisions?.acknowledgeResponse?.({ approvalId, runId, sessionId: originSessionId }, {
              approvalId,
              runId,
              sessionId: originSessionId,
            });
            if (typeof updatePlanApprovalCardOnResponse === "function") {
              updatePlanApprovalCardOnResponse({ approvalId, decision: "resolved", status: "resolved" });
            }
            if (typeof showSystemToast === "function") {
              showSystemToast(t("approval.alreadyResolved"), "info");
            }
            refreshCurrentSession().catch(() => {});
            return true;
          }
          if (typeof showSystemToast === "function") {
            showSystemToast(t("approval.submitFailed", { message: error?.message || "" }), "error");
          }
          throw error;
        }
        if (data.session) {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          if (currentSessionId === session.id) {
            applyAttachedSessionState(session.id, session);
          }
        }
        window.RagentDecisions?.acknowledgeResponse?.({ approvalId, runId, sessionId: originSessionId }, {
          approvalId,
          runId,
          sessionId: originSessionId,
          decision,
        });
        return true;
      }
      case "session_confirmation": {
        const sessionId = String(msg.sessionId || currentSessionId || "").trim();
        const approvalId = String(msg.approvalId || "").trim();
        const decision = String(msg.decision || "").trim();
        if (!sessionId || !approvalId || !decision) return false;
        let data;
        try {
          data = await fetchJsonOrRedirect(
            `/api/sessions/${encodeURIComponent(sessionId)}/confirmations/${encodeURIComponent(approvalId)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                decision,
                requestId: msg.requestId || createRequestId(),
              }),
            },
          );
        } catch (error) {
          // Same "already over" treatment as runtime_approval: the confirmation
          // no longer exists — dismiss and resync instead of failing.
          if (isApprovalAlreadyEndedError(error)) {
            window.RagentDecisions?.noteResponse({ approvalId });
            window.RagentDecisions?.acknowledgeResponse?.({ approvalId, sessionId }, {
              approvalId,
              sessionId,
            });
            if (typeof showSystemToast === "function") {
              showSystemToast(t("approval.alreadyResolved"), "info");
            }
            refreshCurrentSession({ forceFresh: true }).catch(() => {});
            return true;
          }
          throw error;
        }
        if (data.session) {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          if (currentSessionId === session.id) {
            applyAttachedSessionState(session.id, session);
          }
        }
        // The confirmation endpoint has accepted the owner decision. Clear the
        // interactive surface before any best-effort session refresh so a slow
        // refresh cannot leave a disabled approval popup on screen.
        window.RagentDecisions?.acknowledgeResponse?.({ approvalId, sessionId }, {
          approvalId,
          sessionId,
          decision,
        });
        if (currentSessionId === sessionId) {
          await refreshCurrentSession({ forceFresh: true }).catch(() => {});
        } else if (!visitorMode) {
          await refreshSidebarSession(sessionId, { forceFresh: true }).catch(() => {});
        }
        return true;
      }
      case "apply_template": {
        const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(msg.sessionId || currentSessionId)}/apply-template`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ templateId: msg.templateId }),
        });
        if (data.session) {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          if (currentSessionId === session.id) {
            applyAttachedSessionState(session.id, session);
          }
        }
        await refreshCurrentSession();
        return true;
      }
      case "save_template": {
        await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(msg.sessionId || currentSessionId)}/save-template`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: msg.name || "" }),
        });
        return true;
      }
      case "cancel":
        await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(currentSessionId)}/cancel`, {
          method: "POST",
        });
        await refreshCurrentSession();
        return true;
      case "compact":
        await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(currentSessionId)}/compact`, {
          method: "POST",
        });
        await refreshCurrentSession();
        return true;
      case "drop_tools":
        await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(currentSessionId)}/drop-tools`, {
          method: "POST",
        });
        await refreshCurrentSession();
        return true;
      default:
        return false;
    }
  } catch (error) {
    if (msg?.action === "plan_action" && isPlanAlreadyEndedError(error)) {
      const planId = String(msg?.planId || "").trim();
      if (planId) {
        const approvalId = `plan:${planId}`;
        const sessionId = String(msg?.sessionId || currentSessionId || "").trim();
        window.RagentDecisions?.acknowledgeResponse?.({ approvalId, sessionId }, {
          approvalId,
          sessionId,
        });
        if (typeof updatePlanApprovalCardOnResponse === "function") {
          updatePlanApprovalCardOnResponse({ approvalId, status: "resolved", decision: "resolved" });
        }
      }
      // A plan that disappeared between render and click is already no longer
      // actionable. Returning success lets both the Decision Sheet and the
      // cross-session attention popup remove their stale card.
      return true;
    }
    const submitIdentity = messageSubmitIdentity || {
      sessionId: msg?.sessionId || currentSessionId,
      requestId: msg?.requestId || "",
    };
    if (
      msg?.action === "send"
      && messageSubmitStarted
      && isAmbiguousMessageSubmitError(error)
      && await reconcileAmbiguousMessageSubmit(submitIdentity.sessionId, submitIdentity.requestId)
    ) {
      return true;
    }
    // Cancellation means a newer same-key refresh took over the transcript
    // render. It must preserve its result even if this navigation is stale by
    // the time the request rejects; false is reserved for a real failure.
    if (msg?.action === "attach" && error?.code === "SESSION_REFRESH_CANCELLED") {
      console.warn("Attach refresh was superseded; the newest refresh owns the render.");
      return "cancelled";
    }
    if (msg?.action === "attach" && isCurrentAttachAction(msg)) {
      // A transient refresh failure with the transcript already on screen is
      // a soft failure: keep the attach alive and the rendered content
      // visible — the next invalidation or user action re-syncs. Resetting
      // the attach state here used to poison the next session switch into
      // wiping the visible transcript (the "blank until reload" report).
      const hasRenderedTimeline = typeof hasRenderedEventSnapshot === "function"
        && hasRenderedEventSnapshot(msg.sessionId);
      if (!hasRenderedTimeline) {
        if (typeof setChatCurrentSession === "function") {
          setChatCurrentSession(msg.sessionId, { hasAttachedSession: false });
        } else {
          hasAttachedSession = false;
        }
        if (typeof resetAttachedSessionRenderState === "function") {
          resetAttachedSessionRenderState();
        }
        if (typeof showSessionLoadError === "function" && error?.sessionLoadErrorShown !== true) {
          showSessionLoadError(
            msg.sessionId,
            error,
            typeof classifySessionLoadError === "function"
              ? classifySessionLoadError(error)
              : "request_failed",
          );
        }
      } else {
        console.warn(
          "Attach refresh failed softly; the rendered transcript stays visible:",
          error?.message || error,
        );
        if (typeof setChatCurrentSession === "function") {
          setChatCurrentSession(msg.sessionId, { hasAttachedSession: true });
        } else {
          currentSessionId = msg.sessionId;
          hasAttachedSession = true;
        }
        // The attach itself stands: content is on screen and the next
        // invalidation re-syncs. Report success so a navigation caller does
        // not replace the working transcript with an error card.
        return true;
      }
    }
    console.error("HTTP action failed:", error.message);
    return false;
  }
}

function buildOptimisticArchivedSession(session, archived) {
  if (!session?.id) return null;
  const next = { ...session };
  if (archived) {
    next.archived = true;
    next.archivedAt = next.archivedAt || new Date().toISOString();
    delete next.pinned;
    return next;
  }
  delete next.archived;
  delete next.archivedAt;
  return next;
}

function applyOptimisticSessionArchiveState(sessionId, archived) {
  const previous = typeof getChatStoreSession === "function"
    ? getChatStoreSession(sessionId)
    : (sessions.find((session) => session.id === sessionId) || null);
  if (!previous) return null;
  const next = buildOptimisticArchivedSession(previous, archived);
  if (!next) return null;
  upsertSession(next);
  if (typeof refreshAppCatalog === "function") {
    refreshAppCatalog();
  }
  if (currentSessionId === sessionId) {
    applyAttachedSessionState(sessionId, next);
  } else {
    renderSessionList();
  }
  return previous;
}

function restoreOptimisticSessionSnapshot(session) {
  if (!session?.id) return;
  upsertSession(session);
  if (typeof refreshAppCatalog === "function") {
    refreshAppCatalog();
  }
  if (currentSessionId === session.id) {
    applyAttachedSessionState(session.id, session);
  } else {
    renderSessionList();
  }
}

function getCurrentSession() {
  return typeof getChatStoreSession === "function"
    ? getChatStoreSession(currentSessionId)
    : (sessions.find((s) => s.id === currentSessionId) || null);
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case "build_info":
      void window.RagentBuild?.applyBuildInfo?.(msg.buildInfo);
      break;

    case "sessions_invalidated":
      fetchSessionsList({ forceFresh: true }).catch(() => {});
      requestHomeWorkspaceRefresh();
      if (archivedSessionsLoaded) {
        fetchArchivedSessions({ forceFresh: true }).catch(() => {});
      }
      break;

    case "projects_invalidated":
      if (typeof window.ragentEnsureProjectsReady === "function") {
        window.ragentEnsureProjectsReady({ force: true }).catch(() => {});
      }
      fetchSessionsList({ forceFresh: true }).catch(() => {});
      break;

    case "organization_invalidated":
      if (typeof window.handleOrganizationInvalidation === "function") {
        window.handleOrganizationInvalidation(msg);
      }
      break;

    case "target_runtime_summary_invalidated": {
      const targetId = String(msg.targetId || "").trim();
      const targetRuntime = window.RagentTargetRuntime;
      if (!targetId || !targetRuntime) break;
      Promise.resolve(
        targetRuntime.readSummaryEvents?.(targetId, {
          afterCursor: Number.isSafeInteger(Number(msg.cursor)) ? Math.max(0, Number(msg.cursor) - 1) : null,
        }) || targetRuntime.refreshTargetSummary?.(targetId),
      ).then(() => {
        if (targetRuntime.getActiveTarget?.()?.targetId !== targetId) return;
        requestHomeWorkspaceRefresh();
        void window.refreshRunSheet?.();
        void window.refreshCurrentSession?.({ forceFresh: true });
        window.scheduleWorkbenchInspectorRefresh?.(window.currentSessionId, { forceFresh: true, delay: 0 });
      }).catch(() => {});
      break;
    }

    case "harnesses_invalidated":
      void window.RagentHarnesses?.refresh?.({ quiet: true });
      void window.RagentModelProviders?.refresh?.({ refreshHarnesses: true });
      void window.ragentRefreshRuntimeCatalog?.({
        clearCurrentSelection: msg.harness?.installed === false,
      });
      break;

    case "session_invalidated":
      requestHomeWorkspaceRefresh();
      if (!msg.sessionId) {
        refreshRealtimeViews({ forceFresh: true }).catch(() => {});
        break;
      }
      if (msg.sessionId === currentSessionId) {
        const latestSeq = Number.isInteger(msg.latestSeq) ? msg.latestSeq : 0;
        const projectedLatestSeq = Number(window.RagentTimelineRuntime?.getSnapshot?.()?.latestSeq) || 0;
        if (msg.eventsPushed === true && latestSeq > 0 && projectedLatestSeq >= latestSeq) {
          scheduleEventPushReconcile(msg.sessionId);
          break;
        }
        refreshCurrentSession({ forceFresh: true }).catch(() => {});
      } else if (!visitorMode) {
        refreshSidebarSession(msg.sessionId, { forceFresh: true }).catch(() => {});
      }
      break;

    case "session_events": {
      window.RagentAttentionPopup?.onRealtimeEvents?.(msg.sessionId, msg.events);
      if (!msg.sessionId || msg.sessionId !== currentSessionId) break;
      if (!Array.isArray(msg.events) || msg.events.length === 0) break;
      const minScrollTop = Number(messagesEl.scrollTop) || 0;
      const shouldStickToBottom =
        messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
      // Live overlay only accepts events with no durable sequence. Persisted
      // events are reconciled by the following session_invalidated page fetch.
      const liveEvents = msg.events.filter((event) => {
        if (Number.isInteger(event?.seq)
          || Number.isInteger(event?.startSeq)
          || Number.isInteger(event?.endSeq)) return false;
        const type = String(event?.type || "").toLowerCase();
        return type === "text_delta"
          || type === "reasoning"
          || (type === "message" && String(event?.role || "").toLowerCase() === "assistant");
      });
      const timelineRuntime = window.RagentTimelineRuntime;
      const durableEvents = msg.events.filter((event) => (
        Number.isInteger(event?.seq)
        || Number.isInteger(event?.startSeq)
        || Number.isInteger(event?.endSeq)
      ));
      const projectedDurable = timelineRuntime?.renderDurableDelta?.(durableEvents, {
        sessionId: msg.sessionId,
        runState: "running",
        latestSeq: Number.isInteger(msg.latestSeq) ? msg.latestSeq : null,
      });
      const projectedWs = timelineRuntime?.renderIncremental?.(liveEvents, {
        sessionId: msg.sessionId,
        runState: "running",
        source: "ws",
      });
      if (typeof window.paintGoalChipLive === "function") {
        window.paintGoalChipLive(msg.events);
      }
      if (typeof applyWorkbenchInspectorEventDelta === "function") {
        applyWorkbenchInspectorEventDelta(msg.sessionId, msg.events);
      }
      if ((projectedWs || projectedDurable) && shouldStickToBottom) {
        scrollToBottom({ minScrollTop });
      }
      break;
    }

    case "system_notification":
      if (typeof showSystemToast === "function") {
        showSystemToast(msg.message || "System notification", msg.level || "info");
      } else {
        console.warn("[system_notification]", msg.message);
      }
      break;

    case "error":
      console.error("WS error:", msg.message);
      break;
  }
}

// ---- Status ----
function syncComposerStopButton(visible) {
  if (!cancelBtn) return;
  // Stop shares the corner slot with Send (user decision 2026-08-06): while a
  // session runs it yields to a staged follow-up (non-empty draft or queued
  // attachments), which swaps Send in — the two never coexist. Pass no
  // argument to compute the state from the input-area classes; compose.js
  // re-syncs this whenever the content state flips mid-run.
  if (typeof visible !== "boolean") {
    visible = !!inputArea?.classList?.contains?.("run-active")
      && !inputArea.classList.contains("has-draft")
      && !inputArea.classList.contains("has-attachments")
      && !inputArea.classList.contains("composer-send-pending");
  }
  if (inputArea?.classList?.contains?.("composer-send-pending")) visible = false;
  cancelBtn.style.display = "";
  cancelBtn.classList.toggle("is-visible", visible === true);
  cancelBtn.setAttribute("aria-hidden", visible === true ? "false" : "true");
  cancelBtn.tabIndex = visible === true ? 0 : -1;
  if (typeof syncComposerPresentation === "function") syncComposerPresentation();
}

// ---- Reconnect indicator (P2-8) ----
// Transient floating pill in the live-status zone signalling WS/P2P transport
// loss. Rendered into the top status header so transient connection copy does
// not change the message viewport or composer geometry.
const CONNECTION_RECOVERY_FADE_MS = 220;
let connectionRecoveryIndicatorSeen = false;
let connectionRecoveryIndicatorEl = null;
let connectionRecoveryIndicatorHideTimer = null;

function isConnectionRecoveryTransportUp() {
  const wsOpen = typeof ws !== "undefined"
    && typeof WebSocket !== "undefined"
    && !!ws
    && ws.readyState === WebSocket.OPEN;
  const p2pReady = typeof window !== "undefined"
    && typeof window.RagentP2P !== "undefined"
    && window.RagentP2P.ready === true;
  return wsOpen || p2pReady;
}

function isNetworkOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function getConnectionRecoveryIndicator() {
  if (connectionRecoveryIndicatorEl && document.body.contains(connectionRecoveryIndicatorEl)) {
    return connectionRecoveryIndicatorEl;
  }
  // `chatStatusHeader` is the current shell mount point. Keep the legacy
  // `liveBarSlot` fallback for embedded/older shells so a transport loss is
  // still visible instead of silently disappearing when only the old slot is
  // present during a rolling frontend update.
  const slot = document.getElementById("chatStatusHeader")
    || document.getElementById("liveBarSlot");
  if (!slot) return null;
  let el = document.getElementById("reconnectIndicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "reconnectIndicator";
    el.className = "reconnect-indicator";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.innerHTML = '<span class="reconnect-indicator__dot" aria-hidden="true"></span>'
      + '<span class="reconnect-indicator__label"></span>';
    slot.appendChild(el);
  }
  connectionRecoveryIndicatorEl = el;
  return el;
}

function renderConnectionRecoveryIndicatorLabel(el) {
  const offline = isNetworkOffline();
  const label = offline ? t("status.offline") : t("status.reconnecting");
  const labelEl = el.querySelector(".reconnect-indicator__label");
  if (labelEl && labelEl.textContent !== label) labelEl.textContent = label;
  el.dataset.variant = offline ? "offline" : "reconnecting";
}

function showConnectionRecoveryIndicator() {
  if (connectionRecoveryIndicatorHideTimer) {
    clearTimeout(connectionRecoveryIndicatorHideTimer);
    connectionRecoveryIndicatorHideTimer = null;
  }
  const el = getConnectionRecoveryIndicator();
  if (!el) return;
  renderConnectionRecoveryIndicatorLabel(el);
  if (!el.classList.contains("is-visible")) {
    void el.offsetWidth;
  }
  el.classList.add("is-visible");
}

function hideConnectionRecoveryIndicator() {
  const el = typeof document !== "undefined" ? document.getElementById("reconnectIndicator") : null;
  if (!el || !el.classList.contains("is-visible")) return;
  // Clear any prior detach timer only after confirming the pill is still in a
  // fade-able state — otherwise a second hide during the fade window would
  // orphan the pill (transparent but still reserving slot height forever).
  if (connectionRecoveryIndicatorHideTimer) {
    clearTimeout(connectionRecoveryIndicatorHideTimer);
    connectionRecoveryIndicatorHideTimer = null;
  }
  el.classList.remove("is-visible");
  // Detach from the slot once the fade-out completes so the composer zone
  // settles without a layout jump (mirrors the live-bar collapse cadence).
  // The show path re-creates the pill on demand, so removal is safe.
  connectionRecoveryIndicatorHideTimer = setTimeout(() => {
    connectionRecoveryIndicatorHideTimer = null;
    const current = typeof document !== "undefined"
      ? document.getElementById("reconnectIndicator")
      : null;
    if (current && !current.classList.contains("is-visible")) {
      current.remove();
    }
  }, CONNECTION_RECOVERY_FADE_MS + 60);
}

function syncConnectionRecoveryIndicator(connState) {
  const transportUp = isConnectionRecoveryTransportUp();
  if ((connState === "connected" || connState === "p2p") && transportUp) {
    connectionRecoveryIndicatorSeen = true;
  }
  if (transportUp) {
    hideConnectionRecoveryIndicator();
    return;
  }
  // Initial load: the transport has never been up, so a "reconnecting" pill
  // would be noise. Only transient post-connection loss gets the pill.
  if (!connectionRecoveryIndicatorSeen || connState !== "disconnected") return;
  showConnectionRecoveryIndicator();
}

// Reflect network transitions into a visible pill without re-showing it
// (offline → "网络已断开", back online → "重连中…").
function syncConnectionRecoveryIndicatorNetworkState() {
  const el = typeof document !== "undefined" ? document.getElementById("reconnectIndicator") : null;
  if (!el || !el.classList.contains("is-visible")) return;
  renderConnectionRecoveryIndicatorLabel(el);
}

function updateStatus(connState, session = getCurrentSession()) {
  syncConnectionRecoveryIndicator(connState);
  if (typeof syncComposerEditResendButton === "function") {
    syncComposerEditResendButton();
  }
  // P2P 第二通道标记：body dataset 供样式/调试；'p2p' 复用 connected 的启用逻辑。
  document.body.dataset.ragentTransport = connState === "p2p" ? "p2p" : "";
  if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) {
    msgInput.disabled = true;
    msgInput.readOnly = true;
    msgInput.placeholder = t("input.placeholder.readOnlySnapshot");
    sendBtn.style.display = "";
    sendBtn.disabled = true;
    sendBtn.title = t("action.readOnly");
    syncComposerStopButton(false);
    imgBtn.disabled = true;
    inlineToolSelect.disabled = true;
    inlineModelSelect.disabled = true;
    thinkingToggle.disabled = true;
    effortSelect.disabled = true;
    if (typeof syncSessionTemplateControls === "function") {
      syncSessionTemplateControls();
    }
    if (typeof syncComposerVoiceCleanupToggle === "function") {
      syncComposerVoiceCleanupToggle();
    }
    syncForkButton();
    syncShareButton();
    if (typeof syncComposerModeUi === "function") {
      syncComposerModeUi();
    }
    return;
  }
  const archived = session?.archived === true;
  const activePendingSend = typeof getComposerPendingSendSnapshot === "function"
    ? getComposerPendingSendSnapshot()
    : null;
  if (connState === "disconnected") {
    msgInput.disabled = !currentSessionId || archived;
    msgInput.placeholder = archived ? t("input.placeholder.archived") : t("input.placeholder.message");
    sendBtn.style.display = "";
    if (typeof syncComposerSendAvailability === "function") {
      syncComposerSendAvailability();
    } else {
      sendBtn.disabled = !currentSessionId || archived;
    }
    if (!sendBtn.classList?.contains?.("is-edit-resend")) {
      sendBtn.title = t("action.send");
    }
    if (typeof syncComposerSendButtonPendingState === "function") {
      syncComposerSendButtonPendingState(activePendingSend);
    }
    syncComposerStopButton(false);
    if (typeof inputArea?.classList?.toggle === "function") {
      const activity = getSessionActivity(session);
      inputArea.classList.toggle("run-active", activity.run.state === "running" && !!currentSessionId);
    }
    if (typeof syncComposerVoiceCleanupToggle === "function") {
      syncComposerVoiceCleanupToggle();
    }
    if (typeof syncComposerModeUi === "function") {
      syncComposerModeUi();
    }
    return;
  }
  if (typeof observeSessionRunIds === "function") observeSessionRunIds(session);
  const activity = getSessionActivity(session);
  const runIsActive = ["running", "unknown"].includes(activity.run.state);
  const inputBusy = isSessionBusy(session);
  if (typeof setChatSessionStatus === "function") {
    setChatSessionStatus(runIsActive ? "running" : "idle");
  } else {
    sessionStatus = runIsActive ? "running" : "idle";
  }
  if (typeof syncLiveMessageMetadataForRunState === "function") {
    syncLiveMessageMetadataForRunState(activity.run.state);
  }
  if (typeof syncEditableMessageActions === "function") {
    syncEditableMessageActions();
  }
  const hasSession = !!currentSessionId;
  msgInput.disabled = !hasSession || archived;
  msgInput.placeholder = archived
    ? t("input.placeholder.archived")
    : inputBusy
      ? t("input.placeholder.queueFollowUp")
      : t("input.placeholder.message");
  sendBtn.style.display = "";
  if (typeof syncComposerSendAvailability === "function") {
    syncComposerSendAvailability();
  } else {
    sendBtn.disabled = !hasSession || archived;
  }
  if (!sendBtn.classList?.contains?.("is-edit-resend")) {
    sendBtn.title = inputBusy ? t("action.queueFollowUp") : t("action.send");
  }
  if (typeof syncComposerSendButtonPendingState === "function") {
    syncComposerSendButtonPendingState(activePendingSend);
  }
  if (typeof inputArea?.classList?.toggle === "function") {
    inputArea.classList.toggle("run-active", runIsActive && hasSession);
  }
  // Running sessions swap Stop and Send in one corner slot: Stop at rest, a
  // staged follow-up (draft/attachments) swaps Send in (CSS:
  // .input-area.run-active .send-btn + syncComposerStopButton, user
  // decision 2026-08-06). Computed after run-active so the class state is
  // fresh.
  syncComposerStopButton();
  imgBtn.disabled = !hasSession || archived;
  inlineToolSelect.disabled = visitorMode || archived;
  inlineModelSelect.disabled = !hasSession || archived;
  thinkingToggle.disabled = !hasSession || archived;
  effortSelect.disabled = !hasSession || archived;
  if (typeof syncSessionTemplateControls === "function") {
    syncSessionTemplateControls();
  }
  if (typeof syncComposerVoiceCleanupToggle === "function") {
    syncComposerVoiceCleanupToggle();
  }
  syncForkButton();
  syncShareButton();
  if (typeof syncComposerModeUi === "function") {
    syncComposerModeUi();
  }
}
