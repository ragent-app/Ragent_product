import { readFile } from 'fs/promises';
import http from 'http';
import { randomBytes } from 'node:crypto';

import { AUTH_FILE, CHAT_PORT } from './config.mjs';
import { resolveCliIpcEndpoint } from './instance-runtime.mjs';
import { requestWindowsCliOwnerCookie, isWindowsOwnerCliTarget } from './windows-cli-owner-auth.mjs';
import {
  buildAssistantReplyAttachmentFallbackText,
  selectAssistantReplyEvent,
} from './reply-selection.mjs';

export const DEFAULT_RUN_POLL_INTERVAL_MS = 1200;
export const DEFAULT_RUN_POLL_TIMEOUT_MS = 10 * 60 * 1000;

export function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveDefaultChatBaseUrl() {
  const host = trimString(process.env.CHAT_BIND_HOST || '127.0.0.1') || '127.0.0.1';
  const parsedPort = Number.parseInt(String(process.env.CHAT_PORT || ''), 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : CHAT_PORT;
  return `http://${host}:${port}`;
}

export const DEFAULT_CHAT_BASE_URL = resolveDefaultChatBaseUrl();

export function normalizeBaseUrl(value) {
  const normalized = trimString(value || DEFAULT_CHAT_BASE_URL).replace(/\/+$/, '');
  return normalized || DEFAULT_CHAT_BASE_URL;
}

export function buildSessionUrl(sessionId) {
  const params = new URLSearchParams();
  if (sessionId) params.set('session', sessionId);
  params.set('tab', 'sessions');
  return `/?${params.toString()}`;
}

// Static access-token login was retired by the 2026-08-05 security hardening
// (password-only). Keep the legacy token fast path for hosts that still carry
// a token in auth.json, and fall back to password login for current installs:
// the username comes from auth.json and the plaintext password from
// AGENTOC_LOGIN_PASSWORD (never persisted to disk).
async function loginWithToken(baseUrl, token) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 302 || !setCookie) {
    throw new Error(`Failed to authenticate to Ragent at ${baseUrl} (status ${response.status})`);
  }
  return setCookie.split(';')[0];
}

// 本机 CLI 身份通道（2026-08-07）：chat-server 监听 0600 unix socket，经它签发
// 与 /login 同机制的 owner 会话。仅本机属主可连，网络请求不可达；ENOENT/
// ECONNREFUSED 表示通道不可用（服务未起或路径不同），回退 legacy token/密码。
async function loginWithLocalSocket() {
  const cliSocketPath = await resolveCliIpcEndpoint();
  const cookie = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: cliSocketPath,
        path: '/api/cli/auth',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 201) {
            const setCookieHeader = res.headers['set-cookie'];
            const first = Array.isArray(setCookieHeader) ? setCookieHeader[0] : String(setCookieHeader || '');
            const cookiePart = first.split(';')[0].trim();
            if (cookiePart) {
              resolve(cookiePart);
            } else {
              reject(new Error(`Local CLI auth at ${cliSocketPath} returned no session cookie`));
            }
          } else {
            reject(new Error(`Local CLI auth at ${cliSocketPath} failed (status ${res.statusCode})`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
  return cookie;
}

async function loginWithPassword(baseUrl, username, password) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
  });
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 302 || !setCookie) {
    throw new Error(`Failed to log in to Ragent at ${baseUrl} (status ${response.status})`);
  }
  return setCookie.split(';')[0];
}

async function readResponse(response) {
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
  }
  return { response, text, json };
}

export function createAgentoCHttpClient(options = {}) {
  const explicitCapabilityToken = trimString(options.capabilityToken);
  const runtime = {
    baseUrl: normalizeBaseUrl(options.baseUrl || (process.env.RAGENT_CHAT_BASE_URL || process.env.AGENTOC_CHAT_BASE_URL) || DEFAULT_CHAT_BASE_URL),
    authToken: trimString(options.authToken),
    authCookie: trimString(options.authCookie),
    capabilityToken: explicitCapabilityToken,
    // Detached sidecars cannot use the owner cookie or CLI socket. The
    // runner injects this narrow capability into the child environment.
    // Collaboration endpoints use a separate, operation-bound bearer. When
    // a caller supplies it explicitly, never let the ambient session-control
    // headers win the request-auth precedence.
    sessionControlToken: explicitCapabilityToken ? '' : trimString(options.sessionControlToken || process.env.AGENTOC_SESSION_CONTROL_TOKEN),
    sessionControlRenewalToken: explicitCapabilityToken ? '' : trimString(
      options.sessionControlRenewalToken || process.env.AGENTOC_SESSION_CONTROL_RENEWAL_TOKEN,
    ),
    sessionControlRenewalTokenFile: explicitCapabilityToken ? '' : trimString(
      options.sessionControlRenewalTokenFile || process.env.AGENTOC_SESSION_CONTROL_RENEWAL_TOKEN_FILE,
    ),
    sessionControlRunId: explicitCapabilityToken ? '' : trimString(options.sessionControlRunId || process.env.AGENTOC_SESSION_CONTROL_RUN_ID),
    sessionControlSessionId: explicitCapabilityToken ? '' : trimString(options.sessionControlSessionId || process.env.AGENTOC_SESSION_CONTROL_SESSION_ID),
    sessionControlTurnId: explicitCapabilityToken ? '' : trimString(options.sessionControlTurnId || process.env.AGENTOC_SESSION_CONTROL_TURN_ID),
  };
  const useLocalSocket = normalizeBaseUrl(runtime.baseUrl) === normalizeBaseUrl(DEFAULT_CHAT_BASE_URL);
  // A run capability is signed for one chat server. Do not accidentally send
  // the parent Run's environment capability to an explicitly selected test or
  // remote base URL; callers can still pass all capability fields explicitly.
  if (!options.sessionControlToken && !useLocalSocket) {
    runtime.sessionControlToken = '';
    runtime.sessionControlRenewalToken = '';
    runtime.sessionControlRenewalTokenFile = '';
    runtime.sessionControlRunId = '';
    runtime.sessionControlSessionId = '';
    runtime.sessionControlTurnId = '';
  }

  const hasSessionControl = () => Boolean(
    runtime.sessionControlToken
    && runtime.sessionControlRunId
    && runtime.sessionControlSessionId
    && runtime.sessionControlTurnId
  );
  let sessionControlRenewalPromise = null;
  let windowsOwnerAuthPromise = null;
  const nativeWindowsOwner = process.platform === 'win32'
    && (useLocalSocket || isWindowsOwnerCliTarget(runtime.baseUrl));

  async function ensureAuthCookie(forceRefresh = false, attemptedCookie = '') {
    if (nativeWindowsOwner && windowsOwnerAuthPromise) return windowsOwnerAuthPromise;
    if (nativeWindowsOwner && forceRefresh && runtime.authCookie && runtime.authCookie !== attemptedCookie) {
      return runtime.authCookie;
    }
    if (!forceRefresh && runtime.authCookie) {
      return runtime.authCookie;
    }
    if (forceRefresh) {
      runtime.authCookie = '';
      runtime.authToken = '';
    }
    if (nativeWindowsOwner) {
      // No legacy pipe/password/token fallback after installed trust/native
      // failure. One native one-use exchange serves concurrent API reads.
      windowsOwnerAuthPromise = requestWindowsCliOwnerCookie({ baseUrl: runtime.baseUrl }).then(cookie => {
        runtime.authCookie = cookie;
        return cookie;
      });
      try { return await windowsOwnerAuthPromise; }
      finally { windowsOwnerAuthPromise = null; }
    }
    // Unix keeps its existing owner-protected socket and login compatibility.
    if (!runtime.authCookie && useLocalSocket) {
      try {
        runtime.authCookie = await loginWithLocalSocket();
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ECONNREFUSED') {
          throw error;
        }
        // 通道不可用（服务未监听 / CLI 与 server 配置目录不同）→ 回退既有登录路径
      }
    }
    if (!runtime.authCookie && !runtime.authToken && !runtime.authPassword) {
      const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
      runtime.authToken = trimString(auth?.token);
      runtime.authUsername = trimString(auth?.username);
      runtime.authPassword = trimString(process.env.AGENTOC_LOGIN_PASSWORD);
    }
    if (runtime.authCookie) {
      return runtime.authCookie;
    }
    if (runtime.authToken) {
      runtime.authCookie = await loginWithToken(runtime.baseUrl, runtime.authToken);
    } else {
      if (!runtime.authUsername || !runtime.authPassword) {
        throw new Error(
          `No owner credentials in ${AUTH_FILE}: legacy token missing and AGENTOC_LOGIN_PASSWORD is not set`,
        );
      }
      runtime.authCookie = await loginWithPassword(
        runtime.baseUrl,
        runtime.authUsername,
        runtime.authPassword,
      );
    }
    return runtime.authCookie;
  }

  async function renewSessionControlCapability(expectedToken = '') {
    if (!hasSessionControl()) {
      throw new Error('Incomplete Ragent session-control capability environment');
    }
    // A concurrent request may already have installed a newer token. Avoid a
    // second renewal request and let the caller retry with that token.
    if (expectedToken && runtime.sessionControlToken !== expectedToken) return null;
    if (sessionControlRenewalPromise) return sessionControlRenewalPromise;
    if (!runtime.sessionControlRenewalToken && runtime.sessionControlRenewalTokenFile) {
      try {
        runtime.sessionControlRenewalToken = trimString(
          await readFile(runtime.sessionControlRenewalTokenFile, 'utf8'),
        );
      } catch {
        // The file is optional for new Runs because the sidecar normally
        // carries the renewal credential directly in the environment.
      }
    }
    const renewalToken = runtime.sessionControlRenewalToken || runtime.sessionControlToken;
    if (!renewalToken) throw new Error('Ragent session-control renewal capability is unavailable');
    sessionControlRenewalPromise = (async () => {
      const response = await fetch(`${runtime.baseUrl}/api/internal/session-control/renew`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-agentoc-session-control-renewal-token': renewalToken,
          'x-agentoc-session-control-run-id': runtime.sessionControlRunId,
          'x-agentoc-session-control-session-id': runtime.sessionControlSessionId,
          'x-agentoc-session-control-turn-id': runtime.sessionControlTurnId,
        },
        body: '{}',
        redirect: 'manual',
      });
      const result = await readResponse(response);
      const next = result.json?.sessionControl;
      if (!response.ok || !next?.token
          || next.runId !== runtime.sessionControlRunId
          || next.sessionId !== runtime.sessionControlSessionId
          || next.turnId !== runtime.sessionControlTurnId) {
        const error = new Error(result.json?.error || result.text || 'Failed to renew Ragent session-control capability');
        error.code = result.json?.code || 'SESSION_CONTROL_RENEWAL_FAILED';
        throw error;
      }
      runtime.sessionControlToken = trimString(next.token);
      if (next.renewalToken) {
        runtime.sessionControlRenewalToken = trimString(next.renewalToken);
      }
      return next;
    })().finally(() => {
      sessionControlRenewalPromise = null;
    });
    return sessionControlRenewalPromise;
  }

  async function request(path, options = {}) {
    const normalizedPath = String(path || '').trim();
    if (!normalizedPath.startsWith('/')) {
      throw new Error(`Ragent API path must start with "/": ${path}`);
    }

    const method = String(options.method || 'GET').trim().toUpperCase() || 'GET';
    const headers = {
      Accept: 'application/json',
      ...(options.headers && typeof options.headers === 'object' ? options.headers : {}),
    };

    const rawBody = options.body;
    const body = rawBody === undefined
      ? undefined
      : typeof rawBody === 'string'
        ? rawBody
        : JSON.stringify(rawBody);
    if (body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    const execute = async (cookie) => {
      if (cookie) headers.Cookie = cookie;
      else delete headers.Cookie;
      delete headers.Authorization;
      delete headers['X-AgentoC-Capability-Use-Nonce'];
      delete headers['x-agentoc-session-control-token'];
      delete headers['x-agentoc-session-control-run-id'];
      delete headers['x-agentoc-session-control-session-id'];
      delete headers['x-agentoc-session-control-turn-id'];
      if (hasSessionControl()) {
        headers['x-agentoc-session-control-token'] = runtime.sessionControlToken;
        headers['x-agentoc-session-control-run-id'] = runtime.sessionControlRunId;
        headers['x-agentoc-session-control-session-id'] = runtime.sessionControlSessionId;
        headers['x-agentoc-session-control-turn-id'] = runtime.sessionControlTurnId;
      } else if (runtime.capabilityToken) {
        headers.Authorization = `Bearer ${runtime.capabilityToken}`;
        headers['X-AgentoC-Capability-Use-Nonce'] = randomBytes(24).toString('base64url');
      }
      const response = await fetch(`${runtime.baseUrl}${normalizedPath}`, {
        method,
        headers,
        body,
        redirect: 'manual',
      });
      return readResponse(response);
    };

    if (runtime.sessionControlToken && !hasSessionControl()) {
      throw new Error('Incomplete Ragent session-control capability environment');
    }
    const cookie = runtime.sessionControlToken || runtime.capabilityToken
      ? ''
      : await ensureAuthCookie(false);
    const attemptedSessionControlToken = runtime.sessionControlToken;
    let result = await execute(cookie);
    if (runtime.sessionControlToken
        && result.response.status === 401
        && result.json?.code === 'SESSION_CONTROL_CAPABILITY_EXPIRED') {
      try {
        await renewSessionControlCapability(attemptedSessionControlToken);
        result = await execute('');
      } catch {
        // Preserve the explicit server error from the original request. The
        // caller can decide whether a terminal/revoked Run should be surfaced.
      }
    }
    const mayRenewNativeOwner = result.response.status === 401 && ['GET', 'HEAD'].includes(method);
    if (!runtime.sessionControlToken && !runtime.capabilityToken && [401, 403].includes(result.response.status)
      && (!nativeWindowsOwner || mayRenewNativeOwner)) {
      const refreshedCookie = await ensureAuthCookie(true, cookie);
      result = await execute(refreshedCookie);
    }
    return result;
  }

  async function waitForRun(runId, options = {}) {
    const intervalMs = parsePositiveInteger(options.intervalMs, DEFAULT_RUN_POLL_INTERVAL_MS);
    const timeoutMs = parsePositiveInteger(options.timeoutMs, DEFAULT_RUN_POLL_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await request(`/api/runs/${encodeURIComponent(runId)}`);
      if (!result.response.ok || !result.json?.run) {
        throw new Error(result.json?.error || result.text || `Failed to load run ${runId}`);
      }
      if (typeof options.onPoll === 'function') {
        options.onPoll(result.json.run);
      }
      if (['completed', 'failed', 'cancelled'].includes(result.json.run.state)) {
        return result.json.run;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Timed out waiting for run ${runId}`);
  }

  return {
    baseUrl: runtime.baseUrl,
    request,
    waitForRun,
    ensureAuthCookie: () => ensureAuthCookie(false),
  };
}

export async function loadAssistantReply(client, sessionId, runId) {
  const eventsResult = await client.request(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
  if (!eventsResult.response.ok || !Array.isArray(eventsResult.json?.events)) {
    throw new Error(eventsResult.json?.error || eventsResult.text || `Failed to load session events for ${sessionId}`);
  }

  const selected = await selectAssistantReplyEvent(eventsResult.json.events, {
    match: (event) => runId && event.runId === runId,
    hydrate: async (event) => {
      const bodyResult = await client.request(`/api/sessions/${encodeURIComponent(sessionId)}/events/${event.seq}/body`);
      if (!bodyResult.response.ok || bodyResult.json?.body?.value === undefined) {
        return event;
      }
      return {
        ...event,
        content: bodyResult.json.body.value,
        bodyLoaded: true,
      };
    },
  });

  return trimString([
    selected?.content || '',
    buildAssistantReplyAttachmentFallbackText(selected),
  ].filter(Boolean).join('\n\n'));
}
