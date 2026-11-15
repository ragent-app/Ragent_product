#!/usr/bin/env node
import assert from 'node:assert/strict';
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
import { verifyTargetRuntimeGrant } from '../lib/target-runtime-grant.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-target-runtime-auth-'));
const now = Date.parse('2026-09-03T00:00:00.000Z');
const clock = () => now;
const source = await loadOrCreateInstanceIdentity({ filePath: join(root, 'source.json') });
const target = await loadOrCreateInstanceIdentity({ filePath: join(root, 'target.json') });
const other = await loadOrCreateInstanceIdentity({ filePath: join(root, 'other.json') });
const keyRing = await loadOrCreateSigningKeyRing(join(root, 'accounts-key.json'), { clock });
const state = {
  instanceBindings: [
    {
      instanceId: source.instanceId,
      accountId: 'acct_1',
      instancePublicKey: source.publicKey,
      instanceKeyFingerprint: source.keyFingerprint,
      publicEndpoint: 'https://source.example',
      deviceAlias: 'Source',
      boundAt: new Date(now).toISOString(),
      revokedAt: '',
    },
    {
      instanceId: target.instanceId,
      accountId: 'acct_1',
      instancePublicKey: target.publicKey,
      instanceKeyFingerprint: target.keyFingerprint,
      publicEndpoint: 'https://target.example',
      deviceAlias: 'Target',
      boundAt: new Date(now).toISOString(),
      revokedAt: '',
    },
    {
      instanceId: other.instanceId,
      accountId: 'acct_2',
      instancePublicKey: other.publicKey,
      instanceKeyFingerprint: other.keyFingerprint,
      publicEndpoint: 'https://other.example',
      boundAt: new Date(now).toISOString(),
      deviceAlias: 'Other',
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
  signAssertion: signAssertionFactory(keyRing),
  clock,
});

function input({
  actor = source,
  requestId = 'request-1',
  idempotencyKey = 'idem-1',
  targetInstanceId = target.instanceId,
  method = 'GET',
  path = '/api/sessions',
  operation = 'session.read',
  resourceId = 'session-1',
  expectedRevision = 7,
  expiresAt = new Date(now + 50_000).toISOString(),
  issuedAt = new Date(now).toISOString(),
} = {}) {
  const proof = signTargetRuntimeAuthorizationProof(actor, {
    requestId,
    targetInstanceId,
    idempotencyKey,
    method,
    path,
    operation,
    resourceId,
    expectedRevision,
    expiresAt,
    issuedAt,
    audience: 'ragent-target-runtime',
  });
  return {
    requestId,
    idempotencyKey,
    targetInstanceId,
    method,
    path,
    operation,
    resourceId,
    expectedRevision,
    expiresAt,
    issuedAt,
    audience: 'ragent-target-runtime',
    instance: publicInstanceIdentity(actor),
    signature: proof.signature,
  };
}

try {
  const first = await broker.authorizeTargetRuntime(input());
  assert.match(first.grant, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.equal(first.target.endpoint, 'https://target.example');
  assert.equal(first.target.targetInstanceId, target.instanceId);
  assert.equal(state.targetRuntimeAuthorizations.length, 1);
  const jwks = { keys: [{ ...keyRing.keys[keyRing.primaryKid].publicJwk, kid: keyRing.primaryKid, alg: 'EdDSA' }] };
  const claims = verifyTargetRuntimeGrant({
    token: first.grant,
    jwks,
    issuer: 'https://accounts.example',
    targetInstanceId: target.instanceId,
    method: 'GET',
    path: '/api/sessions',
    nowMs: now,
  });
  assert.equal(claims.accountId, 'acct_1');
  assert.equal(claims.sourceInstanceId, source.instanceId);
  assert.equal(claims.expectedRevision, 7);
  assert.equal(claims.expiresAt, '2026-09-03T00:00:50.000Z');

  const replay = await broker.authorizeTargetRuntime(input());
  assert.equal(replay.grant, first.grant);
  assert.equal(state.targetRuntimeAuthorizations.length, 1);

  await assert.rejects(
    broker.authorizeTargetRuntime(input({ requestId: 'request-2', idempotencyKey: 'idem-2', path: '/api/auth/me', operation: 'session.read' })),
    (error) => error.code === 'target_runtime_authorization_invalid',
  );
  await assert.rejects(
    broker.authorizeTargetRuntime(input({ requestId: 'request-3', idempotencyKey: 'idem-3', targetInstanceId: other.instanceId })),
    (error) => error.code === 'target_runtime_target_unavailable',
  );
  await assert.rejects(
    broker.authorizeTargetRuntime(input({ requestId: 'request-4', idempotencyKey: 'idem-4', actor: other })),
    (error) => error.code === 'target_runtime_target_unavailable',
  );
  await assert.rejects(
    broker.authorizeTargetRuntime(input({ requestId: 'request-5', idempotencyKey: 'idem-5', expiresAt: new Date(now - 1).toISOString() })),
    (error) => error.code === 'target_runtime_authorization_expired',
  );
  const reused = input({ requestId: 'request-6', idempotencyKey: 'idem-6' });
  await broker.authorizeTargetRuntime(reused);
  await assert.rejects(
    broker.authorizeTargetRuntime(input({
      requestId: reused.requestId,
      idempotencyKey: reused.idempotencyKey,
      path: '/api/runs',
      operation: 'run.read',
    })),
    (error) => error.code === 'target_runtime_request_reused',
  );
  console.log('test-target-runtime-authorization: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
