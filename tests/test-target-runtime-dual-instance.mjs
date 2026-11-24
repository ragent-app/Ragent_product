#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { loadOrCreateSigningKeyRing, signAssertionFactory } from '../accounts/keys.mjs';
import {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signTargetRuntimeAuthorizationProof,
} from '../lib/instance-identity.mjs';
import { createTargetRuntimeGrantClaims, verifyTargetRuntimeGrant } from '../lib/target-runtime-grant.mjs';
import { handleTargetRuntimeGatewayRoutes } from '../chat/router-target-runtime-routes.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-target-runtime-dual-'));
const nowMs = Date.now();
const clock = () => nowMs;
const source = await loadOrCreateInstanceIdentity({ filePath: join(root, 'source.json') });
const target = await loadOrCreateInstanceIdentity({ filePath: join(root, 'target.json') });
const keyRing = await loadOrCreateSigningKeyRing(join(root, 'accounts-key.json'), { clock });
const signAssertion = signAssertionFactory(keyRing);
const jwks = {
  keys: Object.values(keyRing.keys).map((key) => ({ ...key.publicJwk, kid: key.kid, alg: 'EdDSA' })),
};

const state = {
  instanceBindings: [
    {
      instanceId: source.instanceId,
      accountId: 'acct_dual',
      instancePublicKey: source.publicKey,
      instanceKeyFingerprint: source.keyFingerprint,
      publicEndpoint: '',
      deviceAlias: 'Source',
      boundAt: new Date(nowMs).toISOString(),
      revokedAt: '',
    },
    {
      instanceId: target.instanceId,
      accountId: 'acct_dual',
      instancePublicKey: target.publicKey,
      instanceKeyFingerprint: target.keyFingerprint,
      publicEndpoint: '',
      deviceAlias: 'Target',
      boundAt: new Date(nowMs).toISOString(),
      revokedAt: '',
    },
  ],
};
const store = {
  async mutate(mutator) {
    return mutator(state);
  },
};
const broker = createOwnerAuthBroker({
  store,
  issuer: 'https://accounts.example',
  verifyGoogleCredential: async () => ({ providerSubject: 'unused' }),
  resolveAccount: async () => ({ accountId: 'unused' }),
  signAssertion,
  clock,
});

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const executions = [];
const replayResponses = new Map();
let targetServer;
let lastAuthorization = null;

function targetRuntimeRequestHandler(req, res) {
  void (async () => {
    const token = String(req.headers['x-ragent-target-grant'] || '').trim();
    if (req.headers.cookie || req.headers.authorization) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'TARGET_RUNTIME_CREDENTIAL_MIXED' }));
      return;
    }
    let claims;
    try {
      claims = verifyTargetRuntimeGrant({
        token,
        jwks,
        issuer: 'https://accounts.example',
        targetInstanceId: target.instanceId,
        method: req.method,
        path: req.url,
        nowMs,
      });
    } catch (error) {
      res.writeHead(error.statusCode || 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: error.code || 'TARGET_GRANT_INVALID', error: error.message }));
      return;
    }
    const body = await readRequestBody(req);
    const replayKey = `${claims.requestId}:${claims.idempotencyKey}`;
    if (replayResponses.has(replayKey)) {
      const cached = replayResponses.get(replayKey);
      res.writeHead(cached.status, cached.headers);
      res.end(cached.body);
      return;
    }
    if (claims.expectedRevision > 1) {
      const responseBody = JSON.stringify({ code: 'TARGET_RUNTIME_REVISION_CONFLICT' });
      const response = { status: 409, headers: { 'Content-Type': 'application/json' }, body: responseBody };
      replayResponses.set(replayKey, response);
      res.writeHead(response.status, response.headers);
      res.end(response.body);
      return;
    }
    executions.push({ method: req.method, path: req.url, body, claims });
    const responseBody = JSON.stringify({ target: 'B', method: req.method, path: req.url, body });
    const response = {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Ragent-Target-Revision': '1' },
      body: responseBody,
    };
    replayResponses.set(replayKey, response);
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  })().catch((error) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'TARGET_TEST_HANDLER_FAILED', error: error.message }));
  });
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server) {
  const instance = server?.server || server;
  if (!instance) return;
  await new Promise((resolve) => instance.close(() => resolve()));
}

async function gatewayRequest(url, payload) {
  const response = await fetch(`${url}/api/target-runtime/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

function makePayload(overrides = {}) {
  return {
    targetId: target.instanceId,
    method: 'POST',
    path: '/api/sessions/session-b/messages',
    operation: 'session.message',
    resourceId: 'session-b',
    expectedRevision: 0,
    expiresAt: new Date(nowMs + 30_000).toISOString(),
    requestId: 'dual-request-1',
    idempotencyKey: 'dual-idempotency-1',
    body: JSON.stringify({ text: 'hello B' }),
    ...overrides,
  };
}

const targetBinding = state.instanceBindings.find((item) => item.instanceId === target.instanceId);
targetServer = await listen(targetRuntimeRequestHandler);
targetBinding.publicEndpoint = targetServer.url.replace('http://', 'https://');

// The production endpoint requires HTTPS, so the test fetch shim maps the
// signed test endpoint back to the local HTTP listener without changing the
// URL that Accounts and the gateway validate.
const fetchImpl = async (url, options) => {
  const parsed = new URL(url);
  if (parsed.origin === targetBinding.publicEndpoint) {
    return fetch(`${targetServer.url}${parsed.pathname}${parsed.search}`, options);
  }
  return fetch(url, options);
};
const catalog = {
  schemaVersion: 1,
  revision: 0,
  activeTargetId: source.instanceId,
  targets: [
    { targetId: source.instanceId, instanceId: source.instanceId, label: 'Source', status: 'online', snapshotVersion: 0 },
    { targetId: target.instanceId, instanceId: target.instanceId, label: 'Target', status: 'online', snapshotVersion: 0 },
  ],
};
const authorizeImpl = async (input) => {
  const issuedAt = new Date(nowMs).toISOString();
  const proof = signTargetRuntimeAuthorizationProof(source, {
    ...input,
    issuedAt,
    audience: 'ragent-target-runtime',
  });
  lastAuthorization = await broker.authorizeTargetRuntime({
    ...input,
    issuedAt,
    audience: 'ragent-target-runtime',
    instance: publicInstanceIdentity(source),
    signature: proof.signature,
  });
  return lastAuthorization;
};

const gateway = await listen((req, res) => {
  const parsed = new URL(req.url, 'https://source.example');
  void handleTargetRuntimeGatewayRoutes({
    req,
    res,
    pathname: parsed.pathname,
    parsedUrl: { query: Object.fromEntries(parsed.searchParams.entries()) },
    authSession: { role: 'owner' },
    writeJson: (response, status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    },
    fetchImpl,
    authorizeImpl,
    identity: source,
    catalog,
  }).catch((error) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'GATEWAY_TEST_HANDLER_FAILED', error: error.message }));
    }
  });
});

try {
  const payload = makePayload();
  const first = await gatewayRequest(gateway.url, payload);
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.body, {
    target: 'B',
    method: 'POST',
    path: '/api/sessions/session-b/messages',
    body: JSON.stringify({ text: 'hello B' }),
  });
  assert.equal(executions.length, 1);
  assert.equal(lastAuthorization.target.targetInstanceId, target.instanceId);

  const retry = await gatewayRequest(gateway.url, payload);
  assert.equal(retry.response.status, 200);
  assert.deepEqual(retry.body, first.body);
  assert.equal(executions.length, 1, 'same command must be replayed without executing twice');

  const conflict = await gatewayRequest(gateway.url, makePayload({
    requestId: 'dual-request-conflict',
    idempotencyKey: 'dual-idempotency-conflict',
    expectedRevision: 2,
  }));
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.code, 'TARGET_RUNTIME_REVISION_CONFLICT');

  const unknownTarget = await gatewayRequest(gateway.url, makePayload({
    targetId: 'not-in-catalog',
    requestId: 'dual-request-unknown',
    idempotencyKey: 'dual-idempotency-unknown',
  }));
  assert.equal(unknownTarget.response.status, 404);
  assert.equal(unknownTarget.body.code, 'TARGET_NOT_FOUND');

  const invalidPath = await gatewayRequest(gateway.url, makePayload({
    requestId: 'dual-request-invalid-path',
    idempotencyKey: 'dual-idempotency-invalid-path',
    path: '/api/auth/me',
    operation: 'session.read',
  }));
  assert.equal(invalidPath.response.status, 400);
  assert.equal(invalidPath.body.code, 'TARGET_RUNTIME_REQUEST_INVALID');

  const invalidMethod = await gatewayRequest(gateway.url, makePayload({
    requestId: 'dual-request-invalid-method',
    idempotencyKey: 'dual-idempotency-invalid-method',
    method: 'OPTIONS',
  }));
  assert.equal(invalidMethod.response.status, 400);
  assert.equal(invalidMethod.body.code, 'TARGET_RUNTIME_REQUEST_INVALID');

  const invalidOperation = await gatewayRequest(gateway.url, makePayload({
    requestId: 'dual-request-invalid-operation',
    idempotencyKey: 'dual-idempotency-invalid-operation',
    operation: 'run.read',
  }));
  assert.equal(invalidOperation.response.status, 400);
  assert.equal(invalidOperation.body.code, 'TARGET_RUNTIME_REQUEST_INVALID');

  catalog.targets.find((entry) => entry.targetId === target.instanceId).status = 'revoked';
  const revoked = await gatewayRequest(gateway.url, makePayload({
    requestId: 'dual-request-revoked',
    idempotencyKey: 'dual-idempotency-revoked',
  }));
  assert.equal(revoked.response.status, 403);
  assert.equal(revoked.body.code, 'TARGET_REVOKED');
  catalog.targets.find((entry) => entry.targetId === target.instanceId).status = 'online';

  const badPath = await fetch(`${targetServer.url}/api/agents`, {
    headers: { 'X-Ragent-Target-Grant': lastAuthorization.grant },
  });
  const badPathBody = await badPath.json();
  assert.equal(badPath.status, 403);
  assert.equal(badPathBody.code, 'TARGET_GRANT_ROUTE_MISMATCH');

  const mixed = await fetch(`${targetServer.url}/api/sessions/session-b/messages`, {
    method: 'POST',
    headers: {
      'X-Ragent-Target-Grant': lastAuthorization.grant,
      Cookie: 'ragent_session=unexpected',
    },
  });
  assert.equal(mixed.status, 400);
  assert.equal((await mixed.json()).code, 'TARGET_RUNTIME_CREDENTIAL_MIXED');

  const expiredClaims = createTargetRuntimeGrantClaims({
    issuer: 'https://accounts.example',
    accountId: 'acct_dual',
    sourceInstanceId: source.instanceId,
    targetInstanceId: target.instanceId,
    requestId: 'dual-expired',
    idempotencyKey: 'dual-expired',
    method: 'GET',
    path: '/api/sessions',
    operation: 'session.read',
    resourceId: 'sessions',
    expectedRevision: 0,
    expiresAt: new Date(nowMs + 60_000).toISOString(),
    nowMs,
    ttlMs: 60_000,
  });
  const expiredToken = await signAssertion({ ...expiredClaims, exp: Math.floor(nowMs / 1000) - 1, expiresAt: new Date(nowMs - 1000).toISOString() });
  const expired = await fetch(`${targetServer.url}/api/sessions`, {
    headers: { 'X-Ragent-Target-Grant': expiredToken },
  });
  assert.equal(expired.status, 401);
  assert.match((await expired.json()).code, /TARGET_GRANT/);

  targetBinding.revokedAt = new Date(nowMs + 1000).toISOString();
  const revokedByAccounts = await gatewayRequest(gateway.url, makePayload({
    requestId: 'dual-request-accounts-revoked',
    idempotencyKey: 'dual-idempotency-accounts-revoked',
  }));
  assert.equal(revokedByAccounts.response.status, 404);
  assert.equal(revokedByAccounts.body.code, 'target_runtime_target_unavailable');
  targetBinding.revokedAt = '';

  await close(targetServer);
  targetServer = null;
  const offline = await gatewayRequest(gateway.url, makePayload({
    requestId: 'dual-request-offline',
    idempotencyKey: 'dual-idempotency-offline',
  }));
  assert.equal(offline.response.status, 503);
  assert.equal(offline.body.code, 'TARGET_RUNTIME_UNAVAILABLE');
  assert.equal(executions.length, 1, 'remote failure must not execute against source');

  // Summary polling is a high-frequency background path. A dead target must
  // fail once and return HTTP 200 degraded offline metadata + cooldown instead
  // of creating a 503 storm, while action requests keep 503 and unknown targets keep 404.
  async function summaryRequest(targetId = target.instanceId) {
    const started = performance.now();
    const response = await fetch(`${gateway.url}/api/target-runtime/summary?targetId=${encodeURIComponent(targetId)}`);
    return { response, body: await response.json(), elapsedMs: performance.now() - started };
  }
  async function summaryEventsRequest(targetId = target.instanceId) {
    const started = performance.now();
    const response = await fetch(`${gateway.url}/api/target-runtime/summary/events?targetId=${encodeURIComponent(targetId)}&afterCursor=0&limit=100`);
    return { response, body: await response.json(), elapsedMs: performance.now() - started };
  }
  const unknownSummary = await summaryRequest('not-in-catalog');
  assert.equal(unknownSummary.response.status, 404);
  assert.equal(unknownSummary.body.code, 'TARGET_NOT_FOUND');

  const summaryFailure = await summaryRequest();
  assert.equal(summaryFailure.response.status, 200);
  assert.equal(summaryFailure.body.reachable, false);
  assert.equal(summaryFailure.body.state, 'offline');
  assert.equal(summaryFailure.body.degraded, true);
  assert.equal(summaryFailure.body.retryAfterMs, 30_000);
  assert.equal(summaryFailure.body.code, 'TARGET_RUNTIME_UNAVAILABLE');
  assert.ok(summaryFailure.elapsedMs < 3_500, `summary failure should be bounded, got ${summaryFailure.elapsedMs}ms`);
  const summaryCooldown = await summaryEventsRequest();
  assert.equal(summaryCooldown.response.status, 200);
  assert.equal(summaryCooldown.body.reachable, false);
  assert.equal(summaryCooldown.body.state, 'offline');
  assert.equal(summaryCooldown.body.degraded, true);
  assert.ok(summaryCooldown.body.retryAfterMs > 0 && summaryCooldown.body.retryAfterMs <= 30_000);
  assert.equal(summaryCooldown.body.code, 'TARGET_RUNTIME_SUMMARY_COOLDOWN');
  assert.ok(summaryCooldown.elapsedMs < 250, `cooldown should return quickly, got ${summaryCooldown.elapsedMs}ms`);
  const summaryCooldownAgain = await summaryRequest();
  assert.equal(summaryCooldownAgain.response.status, 200);
  assert.equal(summaryCooldownAgain.body.reachable, false);
  assert.equal(summaryCooldownAgain.body.state, 'offline');
  assert.equal(summaryCooldownAgain.body.degraded, true);
  assert.ok(summaryCooldownAgain.body.retryAfterMs > 0 && summaryCooldownAgain.body.retryAfterMs <= 30_000);
  assert.equal(summaryCooldownAgain.body.code, 'TARGET_RUNTIME_SUMMARY_COOLDOWN');
  assert.ok(summaryCooldownAgain.elapsedMs < 250, `summary cooldown should return quickly, got ${summaryCooldownAgain.elapsedMs}ms`);

  console.log('test-target-runtime-dual-instance: ok');
} finally {
  await close(targetServer);
  await close(gateway.server);
  await rm(root, { recursive: true, force: true });
}
