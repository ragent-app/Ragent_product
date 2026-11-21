import { readFile } from 'fs/promises';
import http from 'http';
import { randomBytes } from 'node:crypto';

import {
  buildAssistantReplyAttachmentFallbackText,
  selectAssistantReplyEvent,
} from './reply-selection.mjs';

export const DEFAULT_RUN_POLL_INTERVAL_MS = 1200;
export const DEFAULT_RUN_POLL_TIMEOUT_MS = 10 * 60 * 1000;

let cachedConfigPromise = null;
async function loadConfig() {
  if (!cachedConfigPromise) {
    cachedConfigPromise = import('./config.mjs').catch((error) => {
      cachedConfigPromise = null;
      throw error;
    });
  }
  return cachedConfigPromise;
}

let cachedInstanceRuntimePromise = null;
async function loadInstanceRuntime() {
  if (!cachedInstanceRuntimePromise) {
    cachedInstanceRuntimePromise = import('./instance-runtime.mjs').catch((error) => {
      cachedInstanceRuntimePromise = null;
      throw error;
    });
  }
  return cachedInstanceRuntimePromise;
}

let cachedWindowsCliOwnerAuthPromise = null;
async function loadWindowsCliOwnerAuth() {
  if (!cachedWindowsCliOwnerAuthPromise) {
    cachedWindowsCliOwnerAuthPromise = import('./windows-cli-owner-auth.mjs').catch((error) => {
      cachedWindowsCliOwnerAuthPromise = null;
      throw error;
    });
  }
  return cachedWindowsCliOwnerAuthPromise;
}

export function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveDefaultChatBaseUrl(fallbackPort = 7690) {
  const host = trimString(process.env.CHAT_BIND_HOST || '127.0.0.1') || '127.0.0.1';
  const parsedPort = Number.parseInt(String(process.env.CHAT_PORT || ''), 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : fallbackPort;
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
// RAGENT_LOGIN_PASSWORD (never persisted to disk).
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
  const { resolveCliIpcEndpoint } = await loadInstanceRuntime();
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

export function createRagentHttpClient(options = {}) {
  const explicitCapabilityToken = trimString(options.capabilityToken);
  const explicitBaseUrl = trimString(options.baseUrl);
  const envBaseUrl = trimString(process.env.RAGENT_CHAT_BASE_URL);
  const hasExplicitEnvPort = parsePositiveInteger(process.env.CHAT_PORT, 0) > 0;
  const normalizedFallbackBaseUrl = normalizeBaseUrl(DEFAULT_CHAT_BASE_URL);
  const usedDefaultBaseUrlFallback = !hasExplicitEnvPort && (
    (!explicitBaseUrl && !envBaseUrl)
    || (explicitBaseUrl && normalizeBaseUrl(explicitBaseUrl) === normalizedFallbackBaseUrl && !envBaseUrl)
  );
  const runtime = {
    baseUrl: normalizeBaseUrl(explicitBaseUrl || envBaseUrl || DEFAULT_CHAT_BASE_URL),
    authToken: trimString(options.authToken),
    authCookie: trimString(options.authCookie),
    capabilityToken: explicitCapabilityToken,
    // Detached sidecars cannot use the owner cookie or CLI socket. The
    // runner injects this narrow capability into the child environment.
    // Collaboration endpoints use a separate, operation-bound bearer. When
    // a caller supplies it explicitly, never let the ambient session-control
    // headers win the request-auth precedence.
    sessionControlToken: explicitCapabilityToken ? '' : trimString(options.sessionControlToken || process.env.RAGENT_SESSION_CONTROL_TOKEN),
    sessionControlRenewalToken: explicitCapabilityToken ? '' : trimString(
      options.sessionControlRenewalToken || process.env.RAGENT_SESSION_CONTROL_RENEWAL_TOKEN,
    ),
    sessionControlRenewalTokenFile: explicitCapabilityToken ? '' : trimString(
      options.sessionControlRenewalTokenFile || process.env.RAGENT_SESSION_CONTROL_RENEWAL_TOKEN_FILE,
    ),
    sessionControlRunId: explicitCapabilityToken ? '' : trimString(options.sessionControlRunId || process.env.RAGENT_SESSION_CONTROL_RUN_ID),
    sessionControlSessionId: explicitCapabilityToken ? '' : trimString(options.sessionControlSessionId || process.env.RAGENT_SESSION_CONTROL_SESSION_ID),
    sessionControlTurnId: explicitCapabilityToken ? '' : trimString(options.sessionControlTurnId || process.env.RAGENT_SESSION_CONTROL_TURN_ID),
  };
  let configuredDefaultBaseUrl = normalizedFallbackBaseUrl;
  let useLocalSocket = normalizeBaseUrl(runtime.baseUrl) === configuredDefaultBaseUrl;
  const mayNeedConfigForAmbientSessionControl = !hasExplicitEnvPort
    && !explicitCapabilityToken
    && !options.sessionControlToken
    && !useLocalSocket
    && Boolean(runtime.sessionControlToken);
  let targetResolved = !(usedDefaultBaseUrlFallback || mayNeedConfigForAmbientSessionControl);

  const applyLocalTargetPolicy = () => {
    useLocalSocket = normalizeBaseUrl(runtime.baseUrl) === configuredDefaultBaseUrl;
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
  };
  if (targetResolved) applyLocalTargetPolicy();

  const resolveTargetConfig = async () => {
    if (targetResolved) return;
    const { CHAT_PORT } = await loadConfig();
    configuredDefaultBaseUrl = normalizeBaseUrl(resolveDefaultChatBaseUrl(CHAT_PORT));
    if (usedDefaultBaseUrlFallback) {
      runtime.baseUrl = configuredDefaultBaseUrl;
    }
    applyLocalTargetPolicy();
    targetResolved = true;
  };

  const hasSessionControl = () => Boolean(
    runtime.sessionControlToken
    && runtime.sessionControlRunId
    && runtime.sessionControlSessionId
    && runtime.sessionControlTurnId
  );
  // Diagnostic metadata contains presence flags only; never expose capability values.
  const authDiagnostics = () => ({
    sessionControlTokenPresent: Boolean(runtime.sessionControlToken),
    sessionControlRunIdPresent: Boolean(runtime.sessionControlRunId),
    sessionControlSessionIdPresent: Boolean(runtime.sessionControlSessionId),
    sessionControlTurnIdPresent: Boolean(runtime.sessionControlTurnId),
    ambientCapabilitySuppressedForTarget: Boolean(!options.sessionControlToken && !useLocalSocket
      && process.env.RAGENT_SESSION_CONTROL_TOKEN),
    explicitCapabilityPresent: Boolean(runtime.capabilityToken),
    localTarget: useLocalSocket,
  });
  const annotateAuthError = (error, stage) => {
    error.authStage = error.authStage || stage;
    error.authDiagnostics = authDiagnostics();
    const diagnostics = error.authDiagnostics;
    const missing = [
      ['token', diagnostics.sessionControlTokenPresent],
      ['runId', diagnostics.sessionControlRunIdPresent],
      ['sessionId', diagnostics.sessionControlSessionIdPresent],
      ['turnId', diagnostics.sessionControlTurnIdPresent],
    ].filter(([, present]) => !present).map(([name]) => name);
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? `; code=${error.code}` : '';
    const incomplete = missing.length > 0 && missing.length < 4
      ? `; missing=${missing.join(',')}` : '';
    const suppressed = diagnostics.ambientCapabilitySuppressedForTarget
      ? '; ambient capability excluded for target' : '';
    error.message = `${error.message} (stage=${stage}${code}${incomplete}${suppressed})`;
    return error;
  };
  const incompleteSessionControlError = () => {
    const error = new Error('Incomplete Ragent session-control capability environment');
    error.code = 'SESSION_CONTROL_CAPABILITY_INCOMPLETE';
    return annotateAuthError(error, 'session-control-selection');
  };
  let sessionControlRenewalPromise = null;
  let windowsOwnerAuthPromise = null;

  async function isNativeWindowsOwnerTarget() {
    if (process.platform !== 'win32') return false;
    if (useLocalSocket) return true;
    const { isWindowsOwnerCliTarget } = await loadWindowsCliOwnerAuth();
    return isWindowsOwnerCliTarget(runtime.baseUrl);
  }

  async function ensureAuthCookie(forceRefresh = false, attemptedCookie = '') {
    await resolveTargetConfig();
    const nativeWindowsOwner = await isNativeWindowsOwnerTarget();
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
      const { requestWindowsCliOwnerCookie } = await loadWindowsCliOwnerAuth();
      windowsOwnerAuthPromise = requestWindowsCliOwnerCookie({ baseUrl: runtime.baseUrl }).then(cookie => {
        runtime.authCookie = cookie;
        return cookie;
      });
      try { return await windowsOwnerAuthPromise; }
      catch (error) {
        throw annotateAuthError(error, 'windows-owner-bootstrap');
      } finally { windowsOwnerAuthPromise = null; }
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
    let authFilePath = '';
    if (!runtime.authCookie && !runtime.authToken && !runtime.authPassword) {
      const { AUTH_FILE } = await loadConfig();
      authFilePath = AUTH_FILE;
      const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
      runtime.authToken = trimString(auth?.token);
      runtime.authUsername = trimString(auth?.username);
      runtime.authPassword = trimString(process.env.RAGENT_LOGIN_PASSWORD);
    }
    if (runtime.authCookie) {
      return runtime.authCookie;
    }
    if (runtime.authToken) {
      runtime.authCookie = await loginWithToken(runtime.baseUrl, runtime.authToken);
    } else {
      if (!runtime.authUsername || !runtime.authPassword) {
        if (!authFilePath) authFilePath = (await loadConfig()).AUTH_FILE;
        throw new Error(
          `No owner credentials in ${authFilePath}: legacy token missing and RAGENT_LOGIN_PASSWORD is not set`,
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
      throw incompleteSessionControlError();
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
          'x-ragent-session-control-renewal-token': renewalToken,
          'x-ragent-session-control-run-id': runtime.sessionControlRunId,
          'x-ragent-session-control-session-id': runtime.sessionControlSessionId,
          'x-ragent-session-control-turn-id': runtime.sessionControlTurnId,
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
      delete headers['X-Ragent-Capability-Use-Nonce'];
      delete headers['x-ragent-session-control-token'];
      delete headers['x-ragent-session-control-run-id'];
      delete headers['x-ragent-session-control-session-id'];
      delete headers['x-ragent-session-control-turn-id'];
      if (hasSessionControl()) {
        headers['x-ragent-session-control-token'] = runtime.sessionControlToken;
        headers['x-ragent-session-control-run-id'] = runtime.sessionControlRunId;
        headers['x-ragent-session-control-session-id'] = runtime.sessionControlSessionId;
        headers['x-ragent-session-control-turn-id'] = runtime.sessionControlTurnId;
      } else if (runtime.capabilityToken) {
        headers.Authorization = `Bearer ${runtime.capabilityToken}`;
        headers['X-Ragent-Capability-Use-Nonce'] = randomBytes(24).toString('base64url');
      }
      const response = await fetch(`${runtime.baseUrl}${normalizedPath}`, {
        method,
        headers,
        body,
        redirect: 'manual',
      });
      return readResponse(response);
    };

    await resolveTargetConfig();
    if ((runtime.sessionControlToken && !hasSessionControl())
        || (process.env.RAGENT_MANAGED_RUN === '1' && useLocalSocket && !hasSessionControl() && !runtime.capabilityToken)) {
      throw incompleteSessionControlError();
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
      && (!(await isNativeWindowsOwnerTarget()) || mayRenewNativeOwner)) {
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
    get baseUrl() { return runtime.baseUrl; },
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
