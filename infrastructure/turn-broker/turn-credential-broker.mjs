#!/usr/bin/env node
// Independent Cloudflare Realtime TURN credential service.
// This process is deployed separately from chat-server and is the only
// process that receives the Cloudflare TURN key ID and API token.
import { createServer } from 'http';
import {
  cloudflareTurnCredentialsUrl,
  normalizeCloudflareTurnIceServers,
  resolveCloudflareTurnCredentialSource,
} from '../../lib/turn-credentials.mjs';
import {
  TURN_BROKER_CAPABILITY_CLOCK_SKEW_MS,
  TEMPORARY_TURN_BROKER_SCOPE,
  normalizeTurnBrokerAuthMode,
  verifyTurnBrokerCapability,
} from '../../lib/turn-broker-capability.mjs';

const MAX_BODY_BYTES = 32 * 1024;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function json(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function error(code, message, statusCode = 400) {
  const value = new Error(message);
  value.code = code;
  value.statusCode = statusCode;
  return value;
}

async function readJsonBody(req) {
  let total = 0;
  let raw = '';
  for await (const chunk of req) {
    total += Buffer.byteLength(chunk);
    if (total > MAX_BODY_BYTES) throw error('turn_broker_body_too_large', 'Request body is too large.', 413);
    raw += chunk;
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw error('turn_broker_request_invalid', 'Request body must be JSON.', 400);
  }
}

function bearerToken(req) {
  const header = trimString(req.headers?.authorization);
  return header.replace(/^Bearer\s+/i, '').trim();
}

function normalizeUrl(value) {
  const raw = trimString(value).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function normalizeTtl(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(parsed)));
}

function requiredIdentity(body) {
  const fields = ['accountId', 'instanceId', 'deviceId', 'connectionId', 'idempotencyKey'];
  for (const field of fields) {
    if (!trimString(body?.[field])) throw error('turn_broker_request_invalid', `${field} is required`, 400);
  }
}

export async function requestCloudflareTurnCredentials({
  source,
  ttlMs,
  nowMs = Date.now(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const endpoint = cloudflareTurnCredentialsUrl({ turnKeyId: source?.turnKeyId });
  if (!endpoint || !trimString(source?.apiToken) || typeof fetchImpl !== 'function') {
    throw error('turn_provider_not_configured', 'Cloudflare TURN credential provider is not configured.', 503);
  }
  let providerResponse;
  try {
    providerResponse = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${source.apiToken}`,
      },
      body: JSON.stringify({ ttl: Math.max(1, Math.floor(ttlMs / 1000)) }),
    });
  } catch {
    throw error('turn_provider_unavailable', 'Cloudflare TURN credential provider is unavailable.', 503);
  }
  let providerBody = null;
  try { providerBody = await providerResponse.json(); } catch {}
  if (!providerResponse?.ok) {
    const statusCode = providerResponse?.status >= 500 ? 503 : 502;
    throw error('turn_provider_rejected', 'Cloudflare TURN credential request was rejected.', statusCode);
  }
  const iceServers = normalizeCloudflareTurnIceServers(providerBody);
  if (iceServers.length === 0) {
    throw error('turn_provider_response_invalid', 'Cloudflare TURN credential provider returned no usable TURN servers.', 502);
  }
  return {
    iceServers,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  };
}

export function createTurnCredentialBrokerHandler({
  brokerToken,
  turnKeyId,
  apiToken,
  // Legacy aliases allow the currently deployed environment file to migrate
  // without exposing or copying its values.
  secret,
  keyName,
  authMode = process.env.RAGENT_TURN_BROKER_AUTH_MODE,
  accountsJwksUrl = process.env.RAGENT_TURN_BROKER_JWKS_URL || process.env.RAGENT_ACCOUNTS_JWKS_URL,
  accountsIssuer = process.env.RAGENT_ACCOUNTS_ISSUER,
  jwks = null,
  fetchImpl = globalThis.fetch,
  jwksCacheTtlMs = 5 * 60 * 1000,
  capabilityClockSkewMs = TURN_BROKER_CAPABILITY_CLOCK_SKEW_MS,
  clock = Date.now,
  issueTurnCredentials,
} = {}) {
  const mode = normalizeTurnBrokerAuthMode(authMode);
  const expectedToken = trimString(brokerToken);
  const source = resolveCloudflareTurnCredentialSource({ turnKeyId, apiToken, secret, keyName });
  const jwksUrl = normalizeUrl(accountsJwksUrl);
  const issuer = trimString(accountsIssuer);
  const idempotentResponses = new Map();
  const connectionBindings = new Map();
  const usedCapabilities = new Map();
  let jwksCache = jwks && Array.isArray(jwks.keys) ? { value: jwks, expiresAt: Number.POSITIVE_INFINITY } : null;

  function configured() {
    if (!source) return false;
    if (mode === 'static') return Boolean(expectedToken);
    if (mode === 'accounts-capability') return Boolean(jwksUrl && issuer) || Boolean(jwks && Array.isArray(jwks.keys) && issuer);
    return Boolean(expectedToken || ((jwksUrl || (jwks && Array.isArray(jwks.keys))) && issuer));
  }

  function pruneResponses(nowMs) {
    for (const [key, value] of idempotentResponses) {
      if (Date.parse(value.response?.expiresAt || '') <= nowMs) idempotentResponses.delete(key);
    }
    for (const [key, value] of connectionBindings) {
      if (Date.parse(value.expiresAt || '') <= nowMs) connectionBindings.delete(key);
    }
    for (const [key, value] of usedCapabilities) {
      if (Number(value.expiresAtMs) <= nowMs) usedCapabilities.delete(key);
    }
  }

  async function fetchJwks({ force = false } = {}) {
    const nowMs = clock();
    if (!force && jwksCache && jwksCache.expiresAt > nowMs) return jwksCache.value;
    if (!jwksUrl || typeof fetchImpl !== 'function') {
      throw error('turn_broker_jwks_unavailable', 'Accounts TURN JWKS is not configured.', 503);
    }
    let response;
    try {
      response = await fetchImpl(jwksUrl, { headers: { Accept: 'application/json' } });
    } catch {
      throw error('turn_broker_jwks_unavailable', 'Accounts TURN JWKS is unavailable.', 503);
    }
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok || !body || !Array.isArray(body.keys)) {
      throw error('turn_broker_jwks_unavailable', 'Accounts TURN JWKS is unavailable.', 503);
    }
    jwksCache = { value: body, expiresAt: nowMs + Math.max(1000, Number(jwksCacheTtlMs) || 5 * 60 * 1000) };
    return body;
  }

  async function authenticateBearer(token, body) {
    if (mode === 'static' || (mode === 'dual' && expectedToken && token === expectedToken)) {
      if (!expectedToken || token !== expectedToken) {
        throw error('turn_broker_unauthorized', 'Broker authentication required.', 401);
      }
      return { kind: 'static', claims: null };
    }
    if (!token) throw error('turn_broker_unauthorized', 'Broker authentication required.', 401);
    if (!issuer) throw error('turn_broker_capability_not_configured', 'TURN capability verification is not configured.', 503);
    let cached = await fetchJwks();
    try {
      return {
        kind: 'capability',
        claims: verifyTurnBrokerCapability({
          token,
          jwks: cached,
          issuer,
          accountId: body.accountId,
          instanceId: body.instanceId,
          deviceId: body.deviceId,
          connectionId: body.connectionId,
          nowMs: clock(),
          clockSkewMs: capabilityClockSkewMs,
        }),
      };
    } catch (caught) {
      if (caught?.code !== 'turn_broker_capability_key_unknown') throw caught;
      cached = await fetchJwks({ force: true });
      return {
        kind: 'capability',
        claims: verifyTurnBrokerCapability({
          token,
          jwks: cached,
          issuer,
          accountId: body.accountId,
          instanceId: body.instanceId,
          deviceId: body.deviceId,
          connectionId: body.connectionId,
          nowMs: clock(),
          clockSkewMs: capabilityClockSkewMs,
        }),
      };
    }
  }

  return async function handleTurnCredentialBrokerRequest(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/healthz' && req.method === 'GET') {
      json(res, 200, { ok: true, configured: configured(), authMode: mode });
      return;
    }
    if (url.pathname !== '/v1/turn/credentials' || req.method !== 'POST') {
      json(res, 404, { error: 'Not found', code: 'turn_broker_not_found' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      if (body?.protocolVersion !== 1) throw error('turn_broker_protocol_unsupported', 'Unsupported broker protocol.', 400);
      requiredIdentity(body);
      if (!configured()) throw error('turn_broker_not_configured', 'TURN broker is not configured.', 503);
      const authentication = await authenticateBearer(bearerToken(req), body);
      if (authentication.kind === 'static'
        && (body?.authorization?.authorized !== true || body?.authorization?.status !== 'authorized')) {
        throw error('turn_broker_authorization_required', 'A server-authorized account/device request is required.', 403);
      }
      if (authentication.kind === 'static'
        && trimString(body.authorization.connectionId)
        && trimString(body.authorization.connectionId) !== trimString(body.connectionId)) {
        throw error('turn_broker_authorization_mismatch', 'Authorization is bound to a different connection.', 403);
      }
      const headerRequestId = trimString(req.headers?.['idempotency-key']);
      if (headerRequestId && headerRequestId !== trimString(body.idempotencyKey)) {
        throw error('turn_broker_idempotency_conflict', 'Idempotency key mismatch.', 400);
      }
      const nowMs = clock();
      const temporary = authentication.claims?.scope === TEMPORARY_TURN_BROKER_SCOPE ? authentication.claims : null;
      const deadlineMs = temporary ? temporary.credentialExpiresAt * 1000 : null;
      pruneResponses(nowMs);
      const identityKey = [body.accountId, body.instanceId, body.deviceId].map(trimString).join(':');
      const priorIdentity = connectionBindings.get(trimString(body.connectionId));
      if (priorIdentity && priorIdentity.identityKey !== identityKey) {
        throw error('turn_broker_identity_conflict', 'TURN connection is bound to another identity.', 409);
      }
      const cacheKey = [
        body.accountId,
        body.instanceId,
        body.deviceId,
        body.connectionId,
        body.idempotencyKey,
      ].map(trimString).join(':');
      const existing = idempotentResponses.get(cacheKey);
      if (existing) {
        if (existing.allowTurnTls !== (Array.isArray(body.supportedIceSchemes)
          && body.supportedIceSchemes.includes('turns'))) {
          throw error('turn_broker_idempotency_conflict', 'ICE scheme support changed for the same idempotency key.', 409);
        }
        if (authentication.kind === 'capability' && existing.capabilityJti !== authentication.claims.jti) {
          throw error('turn_broker_idempotency_conflict', 'Idempotency key is bound to another capability.', 409);
        }
        if (temporary && (existing.response.credentialScope !== 'temporary-device-access'
          || existing.response.temporaryGrantId !== temporary.temporaryGrantId
          || Date.parse(existing.response.expiresAt) > deadlineMs)) {
          throw error('turn_broker_temporary_binding_invalid', 'Temporary credential cache binding mismatch.', 409);
        }
        json(res, 200, { ...existing.response, idempotent: true });
        return;
      }
      if (authentication.kind === 'capability') {
        const priorUse = usedCapabilities.get(authentication.claims.jti);
        if (priorUse) throw error('turn_broker_capability_replayed', 'TURN capability was already used.', 409);
        usedCapabilities.set(authentication.claims.jti, {
          expiresAtMs: Number(authentication.claims.exp) * 1000,
        });
      }
      // Temporary grants must never be raised to the ordinary 60-second minimum.
      // Leave a provider round-trip margin, then verify the conservative expiry again after IO.
      const requestedTtlMs = Number.isFinite(Number(body.ttlMs)) ? Number(body.ttlMs) : DEFAULT_TTL_MS;
      const ttlMs = temporary
        ? Math.floor(Math.min(requestedTtlMs, deadlineMs - nowMs - 5_000) / 1000) * 1000
        : normalizeTtl(body.ttlMs);
      if (temporary && ttlMs < 1000) throw error('turn_broker_temporary_expiring', 'Temporary connection is too close to expiry.', 410);
      const issuedCredentials = await (typeof issueTurnCredentials === 'function'
        ? issueTurnCredentials({ source, ttlMs, nowMs })
        : requestCloudflareTurnCredentials({ source, ttlMs, nowMs, fetchImpl }));
      const allowTurnTls = Array.isArray(body.supportedIceSchemes)
        && body.supportedIceSchemes.includes('turns');
      const iceServers = normalizeCloudflareTurnIceServers({
        iceServers: issuedCredentials?.iceServers,
      }).filter((server) => allowTurnTls || !/^turns:/i.test(server.urls));
      if (iceServers.length === 0) {
        throw error('turn_provider_response_invalid', 'Cloudflare TURN credential provider returned no usable TURN servers.', 502);
      }
      const issuedExpiresAtMs = Date.parse(issuedCredentials?.expiresAt || '');
      const completedAtMs = Math.max(nowMs, clock());
      const temporaryUpperBound = completedAtMs + ttlMs;
      if (temporary && (completedAtMs >= deadlineMs || temporaryUpperBound > deadlineMs
        || (Number.isFinite(issuedExpiresAtMs) && (issuedExpiresAtMs > deadlineMs || issuedExpiresAtMs <= completedAtMs)))) {
        throw error('turn_broker_temporary_expiring', 'Temporary credentials exceeded their authorization deadline.', 410);
      }
      const expiresAt = temporary ? new Date(Number.isFinite(issuedExpiresAtMs)
        ? Math.min(temporaryUpperBound, issuedExpiresAtMs) : temporaryUpperBound).toISOString()
        : Number.isFinite(issuedExpiresAtMs) && issuedExpiresAtMs > nowMs
        ? new Date(issuedExpiresAtMs).toISOString()
        : new Date(nowMs + ttlMs).toISOString();
      const response = {
        protocolVersion: 1,
        provider: 'cloudflare-realtime',
        endpoint: iceServers[0].urls,
        iceServers,
        expiresAt,
        transport: 'turn',
        appTrafficOnly: true,
        credentialScope: temporary ? 'temporary-device-access' : 'device-access',
        ...(temporary ? { temporaryGrantId: temporary.temporaryGrantId, temporaryInvitationId: temporary.temporaryInvitationId,
          accessExpiresAt: new Date(deadlineMs).toISOString() } : {}),
        source: 'turn-broker',
        connectionId: trimString(body.connectionId),
        idempotencyKey: trimString(body.idempotencyKey),
      };
      idempotentResponses.set(cacheKey, {
        response,
        allowTurnTls,
        capabilityJti: authentication.kind === 'capability' ? authentication.claims.jti : '',
      });
      connectionBindings.set(trimString(body.connectionId), {
        identityKey,
        expiresAt: response.expiresAt,
      });
      json(res, 201, response);
    } catch (caught) {
      json(res, caught?.statusCode || 500, {
        error: caught?.message || 'TURN broker request failed',
        code: caught?.code || 'turn_broker_failed',
      });
    }
  };
}

export function startTurnCredentialBroker(options = {}) {
  const host = trimString(options.host || process.env.RAGENT_TURN_BROKER_HOST) || '127.0.0.1';
  const port = Number(options.port || process.env.RAGENT_TURN_BROKER_PORT || 7710);
  const handler = createTurnCredentialBrokerHandler({
    brokerToken: options.brokerToken || process.env.RAGENT_TURN_BROKER_TOKEN,
    turnKeyId: options.turnKeyId || process.env.RAGENT_CLOUDFLARE_TURN_KEY_ID,
    apiToken: options.apiToken || process.env.RAGENT_CLOUDFLARE_TURN_API_TOKEN,
    secret: options.secret || process.env.RAGENT_TURN_SECRET,
    keyName: options.keyName || process.env.RAGENT_TURN_KEY_NAME,
    authMode: options.authMode || process.env.RAGENT_TURN_BROKER_AUTH_MODE,
    accountsJwksUrl: options.accountsJwksUrl || process.env.RAGENT_TURN_BROKER_JWKS_URL || process.env.RAGENT_ACCOUNTS_JWKS_URL,
    accountsIssuer: options.accountsIssuer || process.env.RAGENT_ACCOUNTS_ISSUER,
    fetchImpl: options.fetchImpl,
    clock: options.clock,
    issueTurnCredentials: options.issueTurnCredentials,
  });
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(port, host);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = startTurnCredentialBroker();
  server.on('listening', () => {
    const address = server.address();
    console.log(`TURN credential broker listening on ${address.address}:${address.port}`);
  });
}
