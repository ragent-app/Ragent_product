#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LEGACY_SESSION_CONTROL_CAPABILITY_VERSION,
  SESSION_CONTROL_ERROR_CODES,
  SESSION_CONTROL_RENEWAL_ENDPOINT,
  SESSION_CONTROL_RENEWAL_TOKEN_HEADER,
  SESSION_CONTROL_RUN_ID_HEADER,
  SESSION_CONTROL_SESSION_ID_HEADER,
  SESSION_CONTROL_TURN_ID_HEADER,
  createRunSessionControlCapability,
  createRunSessionControlRenewalCapability,
  createSessionControlDetailedAuthenticator,
  createSessionControlRenewalAuthenticator,
} from '../chat/session-control-capability.mjs';
import { handleSessionControlInternalRoutes } from '../chat/router-session-control-routes.mjs';
import { createRagentHttpClient } from '../lib/ragent-http-client.mjs';

const secret = 'session-control-renewal-test-secret';
const issuedAt = Date.parse('2026-01-01T00:00:00.000Z');
const run = { id: 'run-renewal', sessionId: 'session-renewal', state: 'running' };
const capability = createRunSessionControlCapability({
  runId: run.id,
  sessionId: run.sessionId,
  turnId: 'turn-renewal',
  now: issuedAt,
  secret,
});
const renewal = createRunSessionControlRenewalCapability({
  runId: run.id,
  sessionId: run.sessionId,
  turnId: 'turn-renewal',
  now: issuedAt,
  runCreatedAt: issuedAt,
  secret,
});
const manifest = {
  id: run.id,
  sessionId: run.sessionId,
  requestId: 'turn-renewal',
  options: {
    sessionControlChannel: {
      version: capability.version,
      runId: run.id,
      sessionId: run.sessionId,
      turnId: 'turn-renewal',
      tokenHash: capability.tokenHash,
      renewalTokenHash: renewal.tokenHash,
    },
  },
};

function request(token, overrides = {}) {
  return {
    url: SESSION_CONTROL_RENEWAL_ENDPOINT,
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      [SESSION_CONTROL_RENEWAL_TOKEN_HEADER]: token,
      [SESSION_CONTROL_RUN_ID_HEADER]: run.id,
      [SESSION_CONTROL_SESSION_ID_HEADER]: run.sessionId,
      [SESSION_CONTROL_TURN_ID_HEADER]: 'turn-renewal',
    },
    ...overrides,
  };
}

const getRunImpl = async (id) => id === run.id ? run : null;
const getRunManifestImpl = async (id) => id === run.id ? manifest : null;

const expiredAuth = createSessionControlDetailedAuthenticator({
  secret,
  now: () => issuedAt + 16 * 60 * 1000,
  getRunImpl,
  getRunManifestImpl,
  getSessionImpl: async () => ({ id: run.sessionId }),
});
const expiredResult = await expiredAuth({
  method: 'POST',
  url: `/api/sessions/${run.sessionId}/assets`,
  headers: {
    'x-ragent-session-control-token': capability.token,
    [SESSION_CONTROL_RUN_ID_HEADER]: run.id,
    [SESSION_CONTROL_SESSION_ID_HEADER]: run.sessionId,
    [SESSION_CONTROL_TURN_ID_HEADER]: 'turn-renewal',
  },
});
assert.equal(expiredResult.errorCode, SESSION_CONTROL_ERROR_CODES.EXPIRED);
assert.equal(expiredResult.principal, null);

const renewalAuth = createSessionControlRenewalAuthenticator({
  secret,
  now: () => issuedAt + 60 * 1000,
  getRunImpl,
  getRunManifestImpl,
});
const renewalPrincipal = await renewalAuth(request(renewal.token));
assert.equal(renewalPrincipal.principal?.capabilityOperation, 'session-control.renew');
assert.equal(renewalPrincipal.errorCode, '');

const expiredRenewalAuth = createSessionControlRenewalAuthenticator({
  secret,
  now: () => issuedAt + 24 * 60 * 60 * 1000,
  getRunImpl,
  getRunManifestImpl,
});
assert.equal(
  (await expiredRenewalAuth(request(renewal.token))).errorCode,
  SESSION_CONTROL_ERROR_CODES.RENEWAL_EXPIRED,
);

function makeLegacyToken(currentToken) {
  const [, encoded] = currentToken.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  payload.version = LEGACY_SESSION_CONTROL_CAPABILITY_VERSION;
  const nextEncoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(nextEncoded, 'utf8').digest('base64url');
  return `sc1.${nextEncoded}.${signature}`;
}

const legacyToken = makeLegacyToken(capability.token);
const legacyManifest = {
  ...manifest,
  options: {
    sessionControlChannel: {
      turnId: 'turn-renewal',
      tokenHash: createHash('sha256').update(legacyToken, 'utf8').digest('hex'),
    },
  },
};
const legacyRenewalAuth = createSessionControlRenewalAuthenticator({
  secret,
  now: () => issuedAt + 16 * 60 * 1000,
  getRunImpl,
  getRunManifestImpl: async () => legacyManifest,
});
const legacyResult = await legacyRenewalAuth(request(legacyToken));
assert.equal(legacyResult.principal?.legacy, true);
assert.equal(legacyResult.errorCode, '');
const legacyExpiredResult = await createSessionControlRenewalAuthenticator({
  secret,
  now: () => issuedAt + 22 * 60 * 1000,
  getRunImpl,
  getRunManifestImpl: async () => legacyManifest,
})(request(legacyToken));
assert.equal(legacyExpiredResult.errorCode, SESSION_CONTROL_ERROR_CODES.RENEWAL_EXPIRED);

const nextCapability = createRunSessionControlCapability({
  runId: run.id,
  sessionId: run.sessionId,
  turnId: 'turn-renewal',
  now: issuedAt + 16 * 60 * 1000,
  secret,
});

let routeResponse = null;
const handled = await handleSessionControlInternalRoutes({
  req: request(renewal.token),
  res: {},
  pathname: SESSION_CONTROL_RENEWAL_ENDPOINT,
  writeJson: (_res, status, payload) => { routeResponse = { status, payload }; },
  authenticate: async () => ({ principal: renewalPrincipal.principal }),
  renew: async () => ({ capability }),
});
assert.equal(handled, true);
assert.equal(routeResponse.status, 200);
assert.equal(routeResponse.payload.sessionControl.token, capability.token);

routeResponse = null;
const upgradedRenewal = createRunSessionControlRenewalCapability({
  runId: run.id,
  sessionId: run.sessionId,
  turnId: 'turn-renewal',
  now: issuedAt + 16 * 60 * 1000,
  runCreatedAt: issuedAt,
  secret,
});
const legacyHandled = await handleSessionControlInternalRoutes({
  req: request(legacyToken),
  res: {},
  pathname: SESSION_CONTROL_RENEWAL_ENDPOINT,
  writeJson: (_res, status, payload) => { routeResponse = { status, payload }; },
  authenticate: async () => ({
    principal: { ...legacyResult.principal, legacy: true },
  }),
  renew: async () => ({ capability: nextCapability, renewal: upgradedRenewal }),
});
assert.equal(legacyHandled, true);
assert.equal(routeResponse.status, 200);
assert.equal(routeResponse.payload.sessionControl.renewalToken, upgradedRenewal.token);

const originalFetch = globalThis.fetch;
const requests = [];
const oldToken = capability.token;
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), init: { ...init, headers: { ...(init.headers || {}) } } });
  if (String(url).endsWith('/renew')) {
    return new Response(JSON.stringify({
      sessionControl: {
        token: nextCapability.token,
        runId: run.id,
        sessionId: run.sessionId,
        turnId: 'turn-renewal',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const token = init.headers['x-ragent-session-control-token'];
  if (token === oldToken) {
    return new Response(JSON.stringify({
      error: 'Session-control capability has expired',
      code: SESSION_CONTROL_ERROR_CODES.EXPIRED,
    }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
};
try {
  const client = createRagentHttpClient({
    baseUrl: 'http://127.0.0.1:7690',
    sessionControlToken: oldToken,
    sessionControlRenewalToken: renewal.token,
    sessionControlRunId: run.id,
    sessionControlSessionId: run.sessionId,
    sessionControlTurnId: 'turn-renewal',
  });
  const results = await Promise.all([
    client.request(`/api/sessions/${run.sessionId}/assets`, { method: 'POST', body: { localPath: '/tmp/a' } }),
    client.request(`/api/sessions/${run.sessionId}/assets`, { method: 'POST', body: { localPath: '/tmp/b' } }),
  ]);
  assert.deepEqual(results.map((result) => result.response.status), [201, 201]);
  assert.equal(requests.filter((entry) => entry.url.endsWith('/renew')).length, 1);
  assert.equal(requests.filter((entry) => entry.url.includes('/assets')).length, 4);
  assert.ok(requests.some((entry) => entry.init.headers['x-ragent-session-control-renewal-token'] === renewal.token));

  const renewalDir = await mkdtemp(join(tmpdir(), 'ragent-session-control-renewal-client-'));
  try {
    const renewalFile = join(renewalDir, 'session-control-renewal.cap');
    await writeFile(renewalFile, `${upgradedRenewal.token}\n`, 'utf8');
    const legacyClient = createRagentHttpClient({
      baseUrl: 'http://127.0.0.1:7690',
      sessionControlToken: oldToken,
      sessionControlRenewalTokenFile: renewalFile,
      sessionControlRunId: run.id,
      sessionControlSessionId: run.sessionId,
      sessionControlTurnId: 'turn-renewal',
    });
    const legacyClientResult = await legacyClient.request(
      `/api/sessions/${run.sessionId}/assets`,
      { method: 'POST', body: { localPath: '/tmp/legacy' } },
    );
    assert.equal(legacyClientResult.response.status, 201);
    const fileRenewalRequest = requests.findLast((entry) => String(entry.url).endsWith('/renew'));
    assert.equal(
      fileRenewalRequest.init.headers['x-ragent-session-control-renewal-token'],
      upgradedRenewal.token,
    );
  } finally {
    await rm(renewalDir, { recursive: true, force: true });
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('test-session-control-renewal: expiry codes, legacy window, route, and single-flight retry OK');
