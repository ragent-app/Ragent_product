#!/usr/bin/env node
// Accounts TURN capability and broker authentication contract tests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activePublicKeys,
  loadOrCreateSigningKeyRing,
  signAssertionFactory,
} from '../accounts/keys.mjs';
import {
  issueTurnBrokerCapability,
  verifyTurnBrokerCapability,
} from '../lib/turn-broker-capability.mjs';
import {
  createTurnCredentialBrokerHandler,
  requestCloudflareTurnCredentials,
} from '../infrastructure/turn-broker/turn-credential-broker.mjs';

const root = mkdtempSync(join(tmpdir(), 'agentoc-turn-capability-'));
const now = Date.parse('2026-08-31T12:00:00.000Z');
const issuer = 'https://ragent.agentoncloud.com';
const ring = await loadOrCreateSigningKeyRing(join(root, 'turn-signing-key.json'), { clock: () => now });
const jwks = { keys: activePublicKeys(ring, { clock: () => now }).map((key) => ({
  ...key.publicJwk,
  kid: key.kid,
  alg: 'EdDSA',
  use: 'sig',
})) };
const signCapability = signAssertionFactory(ring);

const identity = {
  accountId: 'acct_capability_test',
  instanceId: 'inst_capability_test',
  deviceId: 'adev_capability_test',
  connectionId: 'turn_capability_test',
};

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const capability = await issueTurnBrokerCapability({
  signCapability,
  issuer,
  ...identity,
  nowMs: now,
});

check('capability contains a short-lived single-connection contract', () => {
  assert.match(capability.token, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.equal(capability.scope, 'turn:mint');
  assert.equal(capability.connectionId, identity.connectionId);
  assert.match(capability.idempotencyKey, /^tbc_[A-Za-z0-9_-]+$/);
  assert.equal(Date.parse(capability.expiresAt), now + 60 * 1000);
});

check('capability signature and bindings verify against the dedicated JWKS', () => {
  const claims = verifyTurnBrokerCapability({
    token: capability.token,
    jwks,
    issuer,
    ...identity,
    nowMs: now + 1000,
  });
  assert.equal(claims.scope, 'turn:mint');
  assert.equal(claims.sub, identity.instanceId);
});

const legacyCapability = await issueTurnBrokerCapability({
  signCapability, issuer: 'https://agentoc.andyscodexagent.cyou', ...identity, nowMs: now,
});
check('new issuer rejects credentials signed for the legacy origin', () => {
  assert.throws(() => verifyTurnBrokerCapability({
    token: legacyCapability.token, jwks, issuer, ...identity, nowMs: now,
  }));
});

check('capability rejects a changed connection binding', () => {
  assert.throws(
    () => verifyTurnBrokerCapability({ token: capability.token, jwks, issuer, ...identity, connectionId: 'turn_other', nowMs: now }),
    (error) => error.code === 'turn_broker_capability_binding_invalid',
  );
});

let providerRequest = null;
const providerCredentials = await requestCloudflareTurnCredentials({
  source: { turnKeyId: 'key-id', apiToken: '0123456789abcdef0123456789abcdef' },
  ttlMs: 30 * 60 * 1000,
  nowMs: now,
  fetchImpl: async (url, options) => {
    providerRequest = { url, options };
    return {
      ok: true,
      json: async () => ({
        iceServers: [{
          urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'],
          username: 'provider-issued-user',
          credential: 'provider-issued-password',
        }],
      }),
    };
  },
});
check('broker exchanges management credentials for provider-issued TURN-only ICE credentials', () => {
  assert.equal(providerRequest.options.method, 'POST');
  assert.equal(providerRequest.options.body, JSON.stringify({ ttl: 1800 }));
  assert.match(providerRequest.url, /\/v1\/turn\/keys\/key-id\/credentials\/generate-ice-servers$/);
  assert.ok(providerCredentials.iceServers.length >= 1);
  assert.ok(providerCredentials.iceServers.every((server) => /^turns?:/.test(server.urls)));
  assert.ok(providerCredentials.iceServers.some((server) => /^turn:/.test(server.urls)));
  assert.ok(providerCredentials.iceServers.some((server) => /^turns:/.test(server.urls)));
  assert.equal(Date.parse(providerCredentials.expiresAt), now + 30 * 60 * 1000);
});

const freshJwks = JSON.parse(JSON.stringify(jwks));
let jwksFetches = 0;
const brokerHandler = createTurnCredentialBrokerHandler({
  authMode: 'accounts-capability',
  turnKeyId: 'key-id',
  apiToken: '0123456789abcdef0123456789abcdef',
  accountsJwksUrl: 'https://accounts.example.test/.well-known/turn-broker-jwks.json',
  accountsIssuer: issuer,
  jwks: { keys: [] },
  fetchImpl: async () => {
    jwksFetches += 1;
    return { ok: true, json: async () => freshJwks };
  },
  clock: () => now,
  issueTurnCredentials: async ({ ttlMs, nowMs }) => ({
    iceServers: [{
      urls: 'turn:turn.cloudflare.com:3478?transport=udp',
      username: 'provider-issued-user',
      password: 'provider-issued-password',
    }, {
      urls: 'turns:turn.cloudflare.com:5349?transport=tcp',
      username: 'provider-issued-user',
      password: 'provider-issued-password',
    }],
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  }),
});
const server = createServer((req, res) => { void brokerHandler(req, res); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

async function request(body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/turn/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

const requestBody = {
  protocolVersion: 1,
  ...identity,
  idempotencyKey: capability.idempotencyKey,
  authorization: { authorized: true, status: 'authorized' },
};

try {
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  const healthBody = await health.json();
  check('accounts-capability broker is configured without a static token', () => {
    assert.equal(healthBody.configured, true);
    assert.equal(healthBody.authMode, 'accounts-capability');
  });

  const missing = await request(requestBody);
  check('request-body authorized=true cannot authorize without capability', () => {
    assert.equal(missing.status, 401);
  });

  const first = await request(requestBody, {
    Authorization: `Bearer ${capability.token}`,
    'Idempotency-Key': capability.idempotencyKey,
  });
  check('broker refreshes an unknown kid and accepts a valid capability', () => {
    assert.equal(first.status, 201);
    assert.equal(first.json.provider, 'cloudflare-realtime');
    assert.equal(jwksFetches, 1);
    assert.equal(first.json.connectionId, identity.connectionId);
    assert.ok(first.json.iceServers.some((server) => /^turn:/.test(server.urls)));
    assert.ok(first.json.iceServers.every((server) => !/^turns:/.test(server.urls)));
  });

  const retry = await request(requestBody, {
    Authorization: `Bearer ${capability.token}`,
    'Idempotency-Key': capability.idempotencyKey,
  });
  check('same capability and idempotency key return the same cached response', () => {
    assert.equal(retry.status, 200);
    assert.equal(retry.json.idempotent, true);
    assert.deepEqual(retry.json.iceServers, first.json.iceServers);
  });

  const changedScheme = await request({ ...requestBody, supportedIceSchemes: ['turns'] }, {
    Authorization: `Bearer ${capability.token}`,
    'Idempotency-Key': capability.idempotencyKey,
  });
  check('a cached grant cannot change its advertised ICE scheme support', () => {
    assert.equal(changedScheme.status, 409);
    assert.equal(changedScheme.json.code, 'turn_broker_idempotency_conflict');
  });

  const replay = await request({ ...requestBody, idempotencyKey: 'turn_capability_other' }, {
    Authorization: `Bearer ${capability.token}`,
    'Idempotency-Key': 'turn_capability_other',
  });
  check('the same capability cannot mint a second idempotency request', () => {
    assert.equal(replay.status, 409);
    assert.equal(replay.json.code, 'turn_broker_capability_replayed');
  });

  const secondCapability = await issueTurnBrokerCapability({
    signCapability,
    issuer,
    ...identity,
    nowMs: now,
  });
  const refreshed = await request({ ...requestBody, idempotencyKey: secondCapability.idempotencyKey }, {
    Authorization: `Bearer ${secondCapability.token}`,
    'Idempotency-Key': secondCapability.idempotencyKey,
  });
  check('a fresh capability can mint again for the same connection', () => {
    assert.equal(refreshed.status, 201);
    assert.equal(refreshed.json.connectionId, identity.connectionId);
    assert.notEqual(refreshed.json.idempotencyKey, first.json.idempotencyKey);
  });
  const tlsCapability = await issueTurnBrokerCapability({ signCapability, issuer, ...identity, nowMs: now });
  const tls = await request({ ...requestBody, idempotencyKey: tlsCapability.idempotencyKey, supportedIceSchemes: ['turns'] }, {
    Authorization: `Bearer ${tlsCapability.token}`,
    'Idempotency-Key': tlsCapability.idempotencyKey,
  });
  check('TLS-capable clients receive TURN over TLS', () => {
    assert.equal(tls.status, 201);
    assert.ok(tls.json.iceServers.some((server) => /^turns:/.test(server.urls)));
  });
  const conflictIdentity = await issueTurnBrokerCapability({
    signCapability,
    issuer,
    ...identity,
    accountId: 'acct_other',
    nowMs: now,
  });
  const conflict = await request({ ...requestBody, accountId: 'acct_other', idempotencyKey: 'turn_conflict' }, {
    Authorization: `Bearer ${conflictIdentity.token}`,
    'Idempotency-Key': 'turn_conflict',
  });
  check('connection id cannot be rebound to another account identity', () => {
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, 'turn_broker_identity_conflict');
  });

  const staticLike = await request(requestBody, {
    Authorization: 'Bearer legacy-static-token',
    'Idempotency-Key': secondCapability.connectionId,
  });
  check('legacy static token is rejected by the capability default', () => {
    assert.equal(staticLike.status, 401);
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}

console.log(`test-turn-broker-capability: ${passed} assertions passed`);
