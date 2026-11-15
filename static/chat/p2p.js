"use strict";

// P2P 第二通道适配层：动态加载 WebRTC DataChannel 客户端（ESM，无全局挂载），
// 管理连接状态机，并把 HTTP-over-DC 请求暴露给 session-http-helpers 的 transport hook。
// 状态机：idle → connecting → ready | failed | closed。凭据来自配对邀请响应
// （{signalingUrl, roomId, secret}），仅保存在内存中，不写入页面 HTML。
(function attachRagentP2P(root) {
  const RETRY_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 2000;
  const state = {
    client: null,
    status: "idle",
    lastError: "",
    credentials: null,
  };

  function buildClientModuleUrl() {
    const version = root.__RAGENT_BUILD__?.assetVersion || "";
    const suffix = version ? `?v=${encodeURIComponent(version)}` : "";
    return `/p2p/ragent-p2p-client.js${suffix}`;
  }

  function setStatus(status, error) {
    state.status = status;
    state.lastError = error || "";
    root.dispatchEvent(new CustomEvent("ragent:p2p-status", {
      detail: { status, error: state.lastError },
    }));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function connect(credentials) {
    if (credentials) state.credentials = credentials;
    if (!state.credentials) throw new Error("P2P credentials missing");
    if (state.status === "connecting") return state.client;
    setStatus("connecting");
    let lastError = "";
    for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt += 1) {
      try {
        const { RagentP2PClient } = await import(buildClientModuleUrl());
        const client = new RagentP2PClient({
          signalingUrl: state.credentials.signalingUrl,
          roomId: state.credentials.roomId,
          secret: state.credentials.secret,
        });
        await client.connect();
        state.client = client;
        setStatus("ready");
        return client;
      } catch (error) {
        lastError = error?.message || String(error);
        if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      }
    }
    state.client?.close?.();
    state.client = null;
    setStatus("failed", lastError);
    throw new Error(lastError);
  }

  function close() {
    state.client?.close?.();
    state.client = null;
    state.credentials = null;
    setStatus("closed");
  }

  // 供 session-http-helpers 的 fetchJsonOrRedirect 调用。
  // 可用且成功时返回 {status, headers, text}；不适用或失败返回 null（回落原生 fetch）。
  async function tryRequest(url, method, headers, body) {
    if (state.status !== "ready" || !state.client) return null;
    if (body !== undefined && typeof body !== "string") return null; // FormData/二进制走原通道
    let requestUrl;
    try {
      requestUrl = new URL(url, root.location.origin);
    } catch {
      return null;
    }
    const path = `${requestUrl.pathname}${requestUrl.search}`;
    const mergedHeaders = {};
    if (typeof headers?.forEach === "function") {
      headers.forEach((value, key) => { mergedHeaders[key] = value; });
    } else if (headers && typeof headers === "object") {
      Object.assign(mergedHeaders, headers);
    }
    if (root.document?.cookie) mergedHeaders["Cookie"] = root.document.cookie;
    try {
      const response = await state.client.request({
        method,
        path,
        headers: mergedHeaders,
        body: body || "",
      });
      return {
        status: response.status,
        ok: response.status < 400,
        headers: response.headers || {},
        text: response.text || "",
      };
    } catch {
      return null;
    }
  }

  root.RagentP2P = {
    get status() { return state.status; },
    get ready() { return state.status === "ready"; },
    get hasCredentials() { return state.status !== "closed" && !!state.credentials; },
    get lastError() { return state.lastError; },
    connect,
    close,
    tryRequest,
  };
})(window);
