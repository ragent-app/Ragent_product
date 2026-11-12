// Target Runtime boundary for the Web surface. The browser always talks to
// the current Web instance; that instance is the only gateway to a remote
// target. Credentials and signing keys never enter this file.
(function attachAgentoCTargetRuntime(root) {
  "use strict";

  const store = root.AgentoCTargetStore;
  const adapters = new Map();
  const activeControllers = new Set();
  const summaries = new Map();
  const summaryCursors = new Map();
  const seenSummaryEvents = new Map();
  const MAX_SEEN_SUMMARY_EVENTS = 2048;
  const SUMMARY_CURSOR_STORAGE_KEY = "agentoc.target-summary-cursors.v1";
  const neutralExactPaths = new Set([
    "/api/account-policy",
    "/api/account/password",
    "/api/auth",
    "/api/device",
    "/api/targets",
  ]);
  const neutralPrefixes = [
    "/api/auth/",
    "/api/owner/",
    "/api/device-auth/",
    "/api/device-pairing/",
    "/api/entry-switch/",
    "/api/target-runtime/",
    "/api/connectivity/",
    "/api/onboarding/",
    "/api/provider-sync/",
    "/api/push/",
    "/api/fcm/",
    "/api/analytics/",
  ];
  let localTargetId = "local";
  let refreshPromise = null;
  let selectionGeneration = 0;

  function text(value, max = 256) {
    return (typeof value === "string" ? value.trim() : "").slice(0, max);
  }

  function readSummaryCursors() {
    try {
      const value = JSON.parse(root.sessionStorage?.getItem(SUMMARY_CURSOR_STORAGE_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function summaryCursor(targetId) {
    const normalized = text(targetId, 160);
    const value = Number(summaryCursors.get(normalized) ?? readSummaryCursors()[normalized] ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function rememberSummaryCursor(targetId, cursor) {
    const normalized = text(targetId, 160);
    const value = Number(cursor);
    if (!normalized || !Number.isSafeInteger(value) || value < summaryCursor(normalized)) return;
    summaryCursors.set(normalized, value);
    try {
      const cursors = readSummaryCursors();
      cursors[normalized] = value;
      root.sessionStorage?.setItem(SUMMARY_CURSOR_STORAGE_KEY, JSON.stringify(cursors));
    } catch {
      // Storage is optional in private browsing and embedded WebViews.
    }
  }

  function acceptSummaryEvent(event, targetId) {
    const eventId = text(event?.eventId, 160);
    const eventTargetId = text(event?.targetId, 160);
    if (!eventId || eventTargetId !== targetId) {
      throw createError("TARGET_SUMMARY_EVENT_INVALID", "Target runtime summary event binding is invalid", 502);
    }
    const key = `${eventTargetId}:${eventId}`;
    const fingerprint = JSON.stringify(event);
    const previous = seenSummaryEvents.get(key);
    if (previous) {
      if (previous !== fingerprint) {
        throw createError("TARGET_SUMMARY_EVENT_REUSED", "Target runtime summary event ID was reused", 502);
      }
      return false;
    }
    seenSummaryEvents.set(key, fingerprint);
    while (seenSummaryEvents.size > MAX_SEEN_SUMMARY_EVENTS) {
      seenSummaryEvents.delete(seenSummaryEvents.keys().next().value);
    }
    return true;
  }

  Object.entries(readSummaryCursors()).forEach(([targetId, cursor]) => {
    const value = Number(cursor);
    if (Number.isSafeInteger(value) && value >= 0) summaryCursors.set(targetId, value);
  });

  function createError(code, message, status = 503) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
  }

  function localFallbackTarget() {
    return {
      schemaVersion: 1,
      targetId: localTargetId,
      instanceId: localTargetId,
      deviceKind: "computer",
      label: "This device",
      status: "online",
      capabilities: [],
      snapshotVersion: 0,
      lastSeenAt: "",
    };
  }

  function pathnameOf(url) {
    try { return new URL(String(url || ""), root.location?.href || "https://agentoc.invalid/").pathname; } catch { return String(url || ""); }
  }

  function absolutePath(url) {
    const base = /^https?:/i.test(String(root.location?.href || ""))
      ? root.location.href
      : "https://agentoc.invalid/";
    const parsed = new URL(String(url || ""), base);
    return `${parsed.pathname}${parsed.search}`;
  }

  function isNeutralPath(url) {
    const pathname = pathnameOf(url);
    return neutralExactPaths.has(pathname)
      || neutralPrefixes.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
  }

  function isRuntimePath(url) {
    const pathname = pathnameOf(url);
    return pathname.startsWith("/api/") && !isNeutralPath(pathname);
  }

  // Keep this mapping in lockstep with lib/target-runtime-policy.mjs. The
  // server remains authoritative; this client-side copy only shapes grants.
  function runtimeOperation(method, path) {
    const normalizedMethod = String(method || "GET").toUpperCase();
    const pathname = pathnameOf(path);
    if (normalizedMethod === "POST" && /^\/api\/sessions\/[^/]+\/harness-capabilities\/skills$/.test(pathname)) return "tool.write";
    if (pathname.startsWith("/api/sessions/") && pathname.endsWith("/organization/projection") && normalizedMethod === "GET") return "workflow.read";
    if (pathname === "/api/sessions" && normalizedMethod === "POST") return "session.create";
    if (normalizedMethod === "GET" && (pathname === "/api/sessions" || pathname.startsWith("/api/sessions/"))) return "session.read";
    if (normalizedMethod === "PATCH" && pathname.startsWith("/api/sessions/")) return "session.update";
    if (normalizedMethod === "DELETE" && pathname.startsWith("/api/sessions/")) return "session.delete";
    if (pathname.startsWith("/api/sessions/")) {
      const action = pathname.split("/").filter(Boolean).at(-1) || "";
      if (action === "cancel") return "session.cancel";
      if (action === "compact") return "session.compact";
      if (action === "drop-tools") return "session.drop-tools";
      if (action === "fork" || action === "fork-at") return "session.fork";
      if (action === "queue") return "session.queue";
      if (["messages", "resend-edited", "regenerate"].includes(action) || normalizedMethod === "POST") return "session.message";
      if (["goal", "control", "confirm"].includes(action)) return "session.update";
    }
    if (pathname.startsWith("/api/root-sessions/")) return normalizedMethod === "GET" ? "session.read" : "session.message";
    if (pathname === "/api/projects" || pathname.startsWith("/api/projects/")) return normalizedMethod === "GET" ? "project.read" : "project.write";
    if (pathname.startsWith("/api/project-handoffs/")) return normalizedMethod === "GET" ? "project.read" : "project.write";
    if (pathname === "/api/runs" || pathname.startsWith("/api/runs/")) {
      if (normalizedMethod === "GET") return "run.read";
      if (pathname.endsWith("/cancel")) return "run.cancel";
      if (pathname.endsWith("/resolve") || pathname.includes("/approvals/")
        || pathname.includes("/approved-actions/") || pathname.includes("/privileged-batches/")) return "approval.resolve";
    }
    if (pathname === "/api/approvals" || pathname.startsWith("/api/approvals/")) return normalizedMethod === "GET" ? "approval.read" : "approval.resolve";
    if (pathname === "/api/home" && normalizedMethod === "GET") return "home.read";
    if (pathname === "/api/tools" || pathname === "/api/harnesses" || pathname.startsWith("/api/harnesses/")) return normalizedMethod === "GET" ? "tool.read" : "tool.write";
    if (pathname === "/api/models" && normalizedMethod === "GET") return "model.read";
    if (pathname === "/api/agents" || pathname.startsWith("/api/agents/")) return normalizedMethod === "GET" ? "agent.read" : "agent.write";
    if (pathname === "/api/native-providers" || pathname.startsWith("/api/native-providers/")) return normalizedMethod === "GET" ? "provider.read" : "provider.write";
    if (pathname === "/api/native-provider-oauth/jobs" || pathname.startsWith("/api/native-provider-oauth/jobs/")) return normalizedMethod === "GET" ? "provider.read" : "provider.write";
    if (pathname === "/api/connectors" || pathname.startsWith("/api/connectors/") || pathname.startsWith("/api/codex/mcp-servers") || pathname.startsWith("/api/claude/mcp-servers") || /^\/api\/providers\/[^/]+\/codex\/(?:mcp-servers(?:\/|$)|plugin-preference$|capability-sync(?:-policy)?$)/.test(pathname)) return normalizedMethod === "GET" ? "connector.read" : "connector.write";
    if (pathname === "/api/autocomplete" || pathname === "/api/browse" || pathname.startsWith("/api/workspace-files") || pathname.startsWith("/api/assets/") || pathname.startsWith("/api/images/") || pathname.startsWith("/api/media/")) {
      if (normalizedMethod === "GET") return "file.read";
      if (normalizedMethod === "PUT" && pathname.startsWith("/api/assets/") && pathname.endsWith("/upload")) return "file.write";
      if (["POST", "PATCH", "DELETE"].includes(normalizedMethod)) return "file.write";
      return "";
    }
    if (pathname === "/api/browse/mkdir") return "file.write";
    if (pathname === "/api/triggers" || pathname.startsWith("/api/triggers/")) return normalizedMethod === "GET" ? "trigger.read" : "trigger.write";
    if (pathname.startsWith("/api/usage") || pathname === "/api/mailbox/status") return "usage.read";
    if (pathname === "/api/notifications") return normalizedMethod === "GET" ? "notification.read" : normalizedMethod === "POST" ? "notification.write" : "";
    if ((pathname === "/api/runtime/summary" || pathname === "/api/runtime/summary/events") && normalizedMethod === "GET") return "runtime.summary";
    if (pathname === "/api/runtime-selection" && normalizedMethod === "GET") return "settings.read";
    if (pathname === "/api/runtime-selection" && normalizedMethod === "POST") return "settings.write";
    if (pathname === "/api/bootstrap/owner-sessions/restore" && normalizedMethod === "POST") return "session.update";
    if ((pathname === "/api/shortcut" || pathname === "/api/agy/execute") && normalizedMethod === "POST") return "workflow.write";
    if (["/api/agy/models", "/api/agy/agents", "/api/agy/version"].includes(pathname) && normalizedMethod === "GET") return "tool.read";
    if (pathname.startsWith("/api/managed-processes") || pathname.startsWith("/api/orchestrations") || pathname.startsWith("/api/collaborations") || pathname.startsWith("/api/consultations") || pathname.startsWith("/api/organization") || pathname.startsWith("/api/organizations")) return normalizedMethod === "GET" ? "workflow.read" : "workflow.write";
    return "";
  }

  function resourceId(path) {
    const pathname = pathnameOf(path);
    const segments = pathname.split("/").filter(Boolean);
    return (segments.length > 1 ? segments.slice(-2).join(":") : pathname).slice(0, 160);
  }

  function randomId(prefix) {
    return root.crypto?.randomUUID?.() || `${prefix || "target"}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function headerObject(input) {
    const output = {};
    for (const [name, value] of new Headers(input || {})) {
      const normalized = name.toLowerCase();
      if (["authorization", "cookie", "host", "content-length"].includes(normalized)) continue;
      output[name] = value;
    }
    return output;
  }

  async function encodeBody(body, headers) {
    if (body == null || typeof body === "string") return { body: body == null ? null : body, headers };
    let bytes;
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const encoded = new Response(body);
      const contentType = encoded.headers.get("content-type");
      if (contentType) headers["Content-Type"] = contentType;
      bytes = new Uint8Array(await encoded.arrayBuffer());
    } else if (body instanceof ArrayBuffer) {
      bytes = new Uint8Array(body);
    } else if (ArrayBuffer.isView(body)) {
      bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    } else if (typeof Blob !== "undefined" && body instanceof Blob) {
      bytes = new Uint8Array(await body.arrayBuffer());
    } else {
      return { body: String(body), headers };
    }
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { bodyBase64: btoa(binary), headers };
  }

  function updateRevision(target, value) {
    const revision = Number.parseInt(value, 10);
    if (!Number.isInteger(revision) || revision < 0) return;
    store?.updateTarget?.(target.targetId, {
      snapshotVersion: revision,
      status: "online",
      lastSeenAt: new Date().toISOString(),
    }, { revision });
  }

  function markResponseTargetRevision(target, response) {
    updateRevision(target, response?.headers?.get?.("x-agentoc-target-revision"));
  }

  function createGatewayAdapter() {
    return {
      async request(url, options = {}, target) {
        const path = absolutePath(url);
        const method = String(options.method || "GET").toUpperCase();
        const operation = runtimeOperation(method, path);
        if (!operation) throw createError("TARGET_RUNTIME_ROUTE_UNSUPPORTED", `Target route is not supported: ${path}`, 400);
        const headers = headerObject(options.headers);
        const encoded = await encodeBody(options.body, headers);
        const envelope = {
          targetId: target.targetId,
          method,
          path,
          operation,
          resourceId: resourceId(path),
          expectedRevision: Number.isSafeInteger(target.snapshotVersion) ? target.snapshotVersion : 0,
          headers: encoded.headers,
          requestId: randomId("target-request"),
          idempotencyKey: randomId("target-idempotency"),
          ...(encoded.body !== undefined ? { body: encoded.body } : {}),
          ...(encoded.bodyBase64 !== undefined ? { bodyBase64: encoded.bodyBase64 } : {}),
        };
        const requestOptions = {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(envelope),
          ...(options.signal ? { signal: options.signal } : {}),
        };
        let response;
        try {
          response = await root.fetch("/api/target-runtime/request", requestOptions);
        } catch (error) {
          if (options.signal?.aborted) throw error;
          // The same binding is retried. Accounts and the target ledger make
          // this safe when the first request reached the target but its HTTP
          // response was lost.
          response = await root.fetch("/api/target-runtime/request", requestOptions);
        }
        if (response.ok) updateRevision(target, response.headers?.get?.("x-agentoc-target-revision"));
        else store?.updateTarget?.(target.targetId, { status: response.status >= 500 ? "offline" : "degraded" });
        markResponseTargetRevision(target, response);
        return response;
      },
    };
  }

  function registerAdapter(targetId, adapter) {
    const normalizedId = text(targetId, 160);
    if (!normalizedId || !adapter || typeof adapter.request !== "function") {
      throw createError("TARGET_ADAPTER_INVALID", "A target adapter requires a targetId and request function", 400);
    }
    adapters.set(normalizedId, adapter);
    return () => {
      if (adapters.get(normalizedId) === adapter) adapters.delete(normalizedId);
    };
  }

  function registerCatalogAdapters(targets) {
    for (const target of targets || []) {
      if (target.targetId !== localTargetId && !adapters.has(target.targetId)) registerAdapter(target.targetId, createGatewayAdapter());
    }
  }

  function getActiveTarget() {
    return store?.getActiveTarget?.() || null;
  }

  function abortActiveRequests() {
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear();
  }

  function trackedOptions(options) {
    const controller = new AbortController();
    const callerSignal = options?.signal;
    const abortFromCaller = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener?.("abort", abortFromCaller, { once: true });
    activeControllers.add(controller);
    return {
      options: { ...options, signal: controller.signal },
      cleanup() {
        activeControllers.delete(controller);
        callerSignal?.removeEventListener?.("abort", abortFromCaller);
      },
    };
  }

  async function selectTarget(targetId) {
    const target = store?.getTarget?.(targetId);
    if (!target) throw createError("TARGET_NOT_FOUND", "Target runtime was not found", 404);
    if (target.status === "revoked") throw createError("TARGET_REVOKED", "This target runtime has been revoked", 403);
    if (target.targetId === store?.getSnapshot?.()?.activeTargetId) return target;
    const previous = getActiveTarget();
    selectionGeneration += 1;
    abortActiveRequests();
    await adapters.get(previous?.targetId)?.deactivate?.();
    const selected = store.select(target.targetId);
    await adapters.get(selected.targetId)?.activate?.(selected);
    void refreshTargetSummary(selected.targetId);
    if (typeof root.CustomEvent === "function" && typeof root.dispatchEvent === "function") {
      root.dispatchEvent(new root.CustomEvent("agentoc:target-selected", {
        detail: { target: selected, previous, generation: selectionGeneration },
      }));
    }
    return selected;
  }

  async function routeRequest({ url, options = {}, localRequest }) {
    const active = getActiveTarget();
    if (!active || !isRuntimePath(url) || active.targetId === localTargetId) {
      if (typeof localRequest !== "function") return null;
      const tracked = trackedOptions(options);
      try { return await localRequest(tracked.options); } finally { tracked.cleanup(); }
    }
    const adapter = adapters.get(active.targetId);
    if (!adapter) throw createError("TARGET_RUNTIME_UNAVAILABLE", `Target runtime "${active.label || active.targetId}" is not connected`);
    const tracked = trackedOptions(options);
    try { return await adapter.request(url, tracked.options, active); } finally { tracked.cleanup(); }
  }

  async function refreshTargetSummary(targetId, { fetchImpl = root.fetch } = {}) {
    const target = store?.getTarget?.(targetId);
    if (!target || typeof fetchImpl !== "function") return null;
    try {
      const response = await fetchImpl(`/api/target-runtime/summary?targetId=${encodeURIComponent(target.targetId)}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        store?.updateTarget?.(target.targetId, { status: response.status >= 500 ? "offline" : "degraded" });
        throw createError(data?.code || "TARGET_SUMMARY_UNAVAILABLE", data?.error || "Target runtime summary is unavailable", response.status);
      }
      summaries.set(target.targetId, data);
      rememberSummaryCursor(target.targetId, data?.eventCursor ?? data?.cursor ?? 0);
      store?.updateTarget?.(target.targetId, {
        status: "online",
        snapshotVersion: Number.isSafeInteger(Number(data?.revision)) ? Number(data.revision) : target.snapshotVersion,
        lastSeenAt: data?.generatedAt || new Date().toISOString(),
      }, { revision: Number.isSafeInteger(Number(data?.revision)) ? Number(data.revision) : undefined });
      if (typeof root.CustomEvent === "function") root.dispatchEvent?.(new root.CustomEvent("agentoc:target-summary", { detail: { targetId: target.targetId, summary: data } }));
      return data;
    } catch (error) {
      if (typeof root.CustomEvent === "function") root.dispatchEvent?.(new root.CustomEvent("agentoc:target-summary", { detail: { targetId: target.targetId, error } }));
      return null;
    }
  }

  async function refreshSummaries(targets = store?.getSnapshot?.()?.targets || []) {
    await Promise.all(targets.map((target) => refreshTargetSummary(target.targetId)));
    return Object.fromEntries(summaries);
  }

  async function readSummaryEvents(targetId, {
    fetchImpl = root.fetch,
    afterCursor = null,
    limit = 100,
  } = {}) {
    const target = store?.getTarget?.(targetId);
    if (!target || typeof fetchImpl !== "function") return null;
    const cursor = afterCursor === null ? summaryCursor(target.targetId) : Number(afterCursor);
    const pageSize = Number(limit);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw createError("TARGET_SUMMARY_EVENTS_INVALID", "Target runtime summary event cursor is invalid", 400);
    }
    try {
      const query = new URLSearchParams({
        targetId: target.targetId,
        afterCursor: String(cursor),
        limit: String(Math.min(pageSize, 500)),
      });
      const response = await fetchImpl(`/api/target-runtime/summary/events?${query.toString()}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        store?.updateTarget?.(target.targetId, { status: response.status >= 500 ? "offline" : "degraded" });
        throw createError(data?.code || "TARGET_SUMMARY_EVENTS_UNAVAILABLE", data?.error || "Target runtime summary events are unavailable", response.status);
      }
      rememberSummaryCursor(target.targetId, data?.cursor ?? cursor);
      for (const event of Array.isArray(data?.events) ? data.events : []) {
        if (!acceptSummaryEvent(event, target.targetId)) continue;
        const revision = Number(event?.revision);
        const eventTargetId = target.targetId;
        if (event?.summary && typeof event.summary === "object" && !Array.isArray(event.summary)) {
          summaries.set(eventTargetId, {
            schemaVersion: 1,
            targetId: eventTargetId,
            instanceId: text(event?.instanceId, 160) || eventTargetId,
            revision: Number.isSafeInteger(revision) ? revision : target.snapshotVersion,
            eventCursor: String(event?.cursor || summaryCursor(target.targetId)),
            generatedAt: event?.emittedAt || new Date().toISOString(),
            ...event.summary,
          });
        }
        if (Number.isSafeInteger(revision) && revision >= 0) {
          store?.updateTarget?.(eventTargetId, {
            status: "online",
            snapshotVersion: revision,
            lastSeenAt: event?.emittedAt || new Date().toISOString(),
          }, { revision });
        }
        if (typeof root.CustomEvent === "function") {
          root.dispatchEvent?.(new root.CustomEvent("agentoc:target-summary-event", {
            detail: { targetId: eventTargetId, event },
          }));
        }
      }
      return data;
    } catch (error) {
      if (typeof root.CustomEvent === "function") {
        root.dispatchEvent?.(new root.CustomEvent("agentoc:target-summary-event", {
          detail: { targetId: target.targetId, error },
        }));
      }
      return null;
    }
  }

  async function refreshSummaryEvents(targets = store?.getSnapshot?.()?.targets || []) {
    await Promise.all(targets.map((target) => readSummaryEvents(target.targetId)));
    return Object.fromEntries(summaries);
  }

  async function fetchTarget(url, options = {}) {
    if (isRuntimePath(url) && !options.__targetRuntimeBypass) {
      return routeRequest({ url, options, localRequest: (localOptions) => root.fetch(url, localOptions) });
    }
    const next = { ...options };
    delete next.__targetRuntimeBypass;
    return root.fetch(url, next);
  }

  async function refreshTargets({ fetchImpl = root.fetch } = {}) {
    if (refreshPromise) return refreshPromise;
    if (typeof fetchImpl !== "function") return store?.getSnapshot?.() || null;
    refreshPromise = Promise.resolve().then(async () => {
      const response = await fetchImpl("/api/target-runtime/catalog", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response?.ok) throw createError("TARGET_CONTEXT_UNAVAILABLE", "Target runtime catalog is unavailable", response?.status || 503);
      const data = await response.json();
      if (!Array.isArray(data?.targets) || data.targets.length === 0) throw createError("TARGET_CONTEXT_INVALID", "Target runtime catalog is invalid", 502);
      const local = data.targets.find((target) => target.targetId === data.activeTargetId) || data.targets[0];
      localTargetId = text(local?.targetId, 160) || localTargetId;
      const activeTargetId = store?.getSnapshot?.()?.activeTargetId;
      store?.replaceTargets?.(data.targets, {
        activeTargetId: data.targets.some((target) => target.targetId === activeTargetId) ? activeTargetId : data.activeTargetId,
        preserveActive: true,
        revision: data.revision,
      });
      registerCatalogAdapters(data.targets);
      void refreshSummaries(data.targets);
      return store.getSnapshot();
    }).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  store?.replaceTargets?.([localFallbackTarget()], { activeTargetId: localTargetId, preserveActive: false });
  void refreshTargets().catch(() => {});

  root.AgentoCTargetRuntime = Object.freeze({
    getActiveTarget,
    getLocalTargetId: () => localTargetId,
    getSnapshot: () => store?.getSnapshot?.() || null,
    getSummary: (targetId) => summaries.get(text(targetId, 160)) || null,
    isRuntimePath,
    fetch: fetchTarget,
    refreshTargets,
    refreshTargetSummary,
    refreshSummaries,
    readSummaryEvents,
    refreshSummaryEvents,
    registerAdapter,
    routeRequest,
    selectTarget,
  });
  root.agentocFetch = fetchTarget;
  root.addEventListener?.("agentoc:target-selected", () => {
    // The selected target is part of the cache key, but this explicit refresh
    // also clears any older browser cache owned by a pre-target build.
    Promise.resolve(root.queueForegroundRefresh?.({ forceFresh: true })).catch(() => {});
    Promise.resolve(root.refreshHomeWorkspace?.()).catch(() => {});
    Promise.resolve(root.refreshRunSheet?.()).catch(() => {});
    Promise.resolve(root.refreshCurrentSession?.({ forceFresh: true })).catch(() => {});
    Promise.resolve(root.agentocEnsureProjectsReady?.({ force: true })).catch(() => {});
    root.scheduleWorkbenchInspectorRefresh?.(root.currentSessionId, { forceFresh: true, delay: 0 });
  });
  if (root.document && typeof root.setInterval === "function") {
    root.setInterval(() => {
      if (root.document.visibilityState === "hidden") return;
      void refreshSummaryEvents();
    }, 15_000);
    root.document.addEventListener?.("visibilitychange", () => {
      if (root.document.visibilityState === "visible") void refreshSummaryEvents();
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
