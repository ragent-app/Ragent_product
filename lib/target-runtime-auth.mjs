// Target-side authentication for Accounts-signed Web gateway commands.
// This principal is deliberately separate from owner cookies and Run
// capabilities. A bearer grant can only authorize its exact target route.
import { ACCOUNTS_ISSUER, ACCOUNTS_JWKS_URL, ACCOUNTS_URL } from './config.mjs';
import { loadOrCreateInstanceIdentity } from './instance-identity.mjs';
import { verifyTargetRuntimeGrant } from './target-runtime-grant.mjs';
import {
  beginTargetRuntimeCommand,
  finishTargetRuntimeCommand,
} from './target-runtime-state.mjs';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const JWKS_TTL_MS = 5 * 60 * 1000;
const MAX_REPLAY_ENTRIES = 256;
let jwksCache = null;
const responseReplayCache = new Map();

function text(value, max = 2048) {
  return (typeof value === 'string' ? value.trim() : '').slice(0, max);
}

function authError(code, message, statusCode = 401, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function normalizeBaseUrl(value) {
  try {
    const parsed = new URL(text(value));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function resolveJwksUrl() {
  const explicit = normalizeBaseUrl(ACCOUNTS_JWKS_URL);
  if (explicit) return explicit;
  const accounts = normalizeBaseUrl(ACCOUNTS_URL);
  return accounts ? `${accounts}/.well-known/jwks.json` : '';
}

async function fetchJwks(fetchImpl, nowMs) {
  if (jwksCache?.expiresAt > nowMs) return jwksCache.value;
  const endpoint = resolveJwksUrl();
  if (!endpoint || typeof fetchImpl !== 'function') {
    throw authError('TARGET_GRANT_KEYS_UNAVAILABLE', 'Accounts signing keys are unavailable.', 503);
  }
  let response;
  try {
    response = await fetchImpl(endpoint, { headers: { Accept: 'application/json' } });
  } catch {
    throw authError('TARGET_GRANT_KEYS_UNAVAILABLE', 'Accounts signing keys are unavailable.', 503);
  }
  if (!response?.ok) throw authError('TARGET_GRANT_KEYS_UNAVAILABLE', 'Accounts signing keys are unavailable.', 503);
  let value;
  try { value = await response.json(); } catch { throw authError('TARGET_GRANT_KEYS_INVALID', 'Accounts signing keys are invalid.', 503); }
  if (!Array.isArray(value?.keys) || value.keys.length === 0) {
    throw authError('TARGET_GRANT_KEYS_INVALID', 'Accounts signing keys are invalid.', 503);
  }
  jwksCache = { value, expiresAt: nowMs + JWKS_TTL_MS };
  return value;
}

function grantHeader(req) {
  return text(req?.headers?.['x-ragent-target-grant'], 16 * 1024);
}

function replayKey(claims) {
  return [
    text(claims?.sourceInstanceId, 160),
    text(claims?.targetInstanceId, 160),
    text(claims?.requestId, 160),
    text(claims?.idempotencyKey, 160),
    text(claims?.jti, 160),
  ].join(':');
}

function pruneResponseReplays(nowMs = Date.now()) {
  for (const [key, value] of responseReplayCache) {
    if (value.expiresAt <= nowMs) responseReplayCache.delete(key);
  }
  while (responseReplayCache.size > MAX_REPLAY_ENTRIES) {
    responseReplayCache.delete(responseReplayCache.keys().next().value);
  }
}

function getResponseReplay(claims, nowMs) {
  pruneResponseReplays(nowMs);
  const value = responseReplayCache.get(replayKey(claims));
  if (!value) return null;
  responseReplayCache.delete(replayKey(claims));
  responseReplayCache.set(replayKey(claims), value);
  return {
    statusCode: value.statusCode,
    headers: { ...value.headers },
    body: Buffer.from(value.body),
  };
}

function cacheResponseReplay(claims, { statusCode, headers, body }, nowMs = Date.now()) {
  const expiresAt = Date.parse(text(claims?.expiresAt, 64));
  if (!Number.isFinite(expiresAt) || !Buffer.isBuffer(body) || body.length > MAX_RESPONSE_BYTES) return;
  const key = replayKey(claims);
  responseReplayCache.delete(key);
  responseReplayCache.set(key, {
    statusCode: Number(statusCode) || 200,
    headers: { ...(headers || {}) },
    body: Buffer.from(body),
    expiresAt: Math.max(nowMs + 1, expiresAt),
  });
  pruneResponseReplays(nowMs);
}

export function clearTargetRuntimeResponseReplays() {
  responseReplayCache.clear();
  jwksCache = null;
}

export async function authenticateTargetRuntimeRequest(req, {
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  begin = beginTargetRuntimeCommand,
} = {}) {
  const token = grantHeader(req);
  if (!token) return null;
  const nowMs = clock();
  const identity = await loadOrCreateInstanceIdentity();
  const jwks = await fetchJwks(fetchImpl, nowMs);
  let claims;
  try {
    claims = verifyTargetRuntimeGrant({
      token,
      jwks,
      issuer: normalizeBaseUrl(ACCOUNTS_ISSUER) || normalizeBaseUrl(ACCOUNTS_URL),
      targetInstanceId: identity.instanceId,
      method: req.method,
      path: req.url,
      nowMs,
    });
  } catch (error) {
    throw authError(error?.code || 'TARGET_GRANT_INVALID', error?.message || 'Target runtime grant is invalid.', error?.statusCode || 401, error?.details);
  }
  const replay = getResponseReplay(claims, nowMs);
  if (replay) {
    return {
      claims,
      command: { replayed: true },
      replay,
      principal: Object.freeze({
        role: 'owner',
        principalKind: 'target_runtime_gateway',
        surfaceMode: 'owner',
        targetRuntime: true,
        sourceInstanceId: claims.sourceInstanceId,
        targetInstanceId: claims.targetInstanceId,
        targetRuntimeOperation: claims.operation,
        targetRuntimeResourceId: claims.resourceId,
      }),
    };
  }
  const command = await begin(claims, { nowMs });
  return {
    claims,
    command,
    principal: Object.freeze({
      role: 'owner',
      principalKind: 'target_runtime_gateway',
      surfaceMode: 'owner',
      targetRuntime: true,
      sourceInstanceId: claims.sourceInstanceId,
      targetInstanceId: claims.targetInstanceId,
      targetRuntimeOperation: claims.operation,
      targetRuntimeResourceId: claims.resourceId,
    }),
  };
}

export async function completeTargetRuntimeRequest(auth, options = {}) {
  if (!auth?.claims) return { revision: 0, committed: false };
  return finishTargetRuntimeCommand(auth.claims, options);
}

// Buffer ordinary HTTP responses long enough to commit the target revision and
// make the same in-process idempotent retry return the same response. This is
// intentionally bounded; oversized responses are rejected instead of being
// retained as a hidden transcript cache.
export function createTargetRuntimeResponse(res, auth, {
  complete = completeTargetRuntimeRequest,
  maxBytes = MAX_RESPONSE_BYTES,
} = {}) {
  let statusCode = 200;
  let headers = {};
  let chunks = [];
  let bytes = 0;
  let ended = false;
  let proxy;

  const append = (chunk, encoding) => {
    if (chunk === undefined || chunk === null || chunk === '') return;
    const value = Buffer.isBuffer(chunk)
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : chunk instanceof ArrayBuffer
          ? Buffer.from(chunk)
          : Buffer.from(String(chunk), encoding);
    bytes += value.length;
    if (bytes > maxBytes) {
      throw authError('TARGET_RUNTIME_RESPONSE_TOO_LARGE', 'Target runtime response is too large.', 413);
    }
    chunks.push(value);
  };

  proxy = new Proxy(res, {
    set(target, property, value) {
      if (property === 'statusCode') {
        statusCode = Number(value) || 200;
        return true;
      }
      if (property === 'statusMessage') return true;
      target[property] = value;
      return true;
    },
    get(target, property) {
      if (property === 'writeHead') {
        return (status, reasonOrHeaders, maybeHeaders) => {
          statusCode = Number(status) || 200;
          const supplied = typeof reasonOrHeaders === 'object' ? reasonOrHeaders : maybeHeaders;
          if (supplied && typeof supplied === 'object') headers = { ...headers, ...supplied };
          return proxy;
        };
      }
      if (property === 'setHeader') return (name, value) => { headers[name] = value; return proxy; };
      if (property === 'getHeader') return (name) => {
        const key = String(name).toLowerCase();
        const entry = Object.entries(headers).find(([header]) => header.toLowerCase() === key);
        return entry?.[1];
      };
      if (property === 'removeHeader') return (name) => {
        const key = String(name).toLowerCase();
        for (const header of Object.keys(headers)) if (header.toLowerCase() === key) delete headers[header];
      };
      if (property === 'hasHeader') return (name) => Object.keys(headers).some((header) => header.toLowerCase() === String(name).toLowerCase());
      if (property === 'write') return (chunk, encoding, callback) => {
        try { append(chunk, encoding); callback?.(); } catch (error) { callback?.(error); throw error; }
        return true;
      };
      if (property === 'end') {
        return (chunk, encoding, callback) => {
          if (ended) return proxy;
          if (typeof chunk === 'function') { callback = chunk; chunk = undefined; encoding = undefined; }
          else if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
          ended = true;
          try { append(chunk, encoding); } catch (error) {
            if (!target.headersSent) target.writeHead(error.statusCode || 413, { 'Content-Type': 'application/json' });
            target.end(JSON.stringify({ error: error.message, code: error.code || 'TARGET_RUNTIME_RESPONSE_INVALID' }));
            callback?.();
            return proxy;
          }
          const body = Buffer.concat(chunks);
          Promise.resolve(complete(auth, { statusCode, body, headers: { ...headers } }))
            .then((result) => {
              if (result?.revision !== undefined) headers['X-Ragent-Target-Revision'] = String(result.revision);
              cacheResponseReplay(auth?.claims, { statusCode, headers, body });
              for (const [name, value] of Object.entries(headers)) target.setHeader(name, value);
              target.writeHead(statusCode);
              target.end(body, callback);
            })
            .catch((error) => {
              if (!target.headersSent) target.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json' });
              target.end(JSON.stringify({ error: error.message || 'Target runtime response failed', code: error.code || 'TARGET_RUNTIME_RESPONSE_FAILED' }), callback);
            });
          return proxy;
        };
      }
      if (property === 'statusCode') return statusCode;
      if (property === 'headersSent') return target.headersSent;
      if (property === 'writableEnded') return ended || target.writableEnded;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy;
}
