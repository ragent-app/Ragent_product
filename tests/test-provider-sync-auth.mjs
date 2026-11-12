#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signProviderSyncPeerProof,
} from '../lib/instance-identity.mjs';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';

const root = await mkdtemp(join(tmpdir(), 'agentoc-provider-sync-auth-'));
const source = await loadOrCreateInstanceIdentity({ filePath: join(root, 'source.json') });
const target = await loadOrCreateInstanceIdentity({ filePath: join(root, 'target.json') });
const other = await loadOrCreateInstanceIdentity({ filePath: join(root, 'other.json') });
let now = Date.parse('2026-08-23T00:00:00.000Z');
const state = {
  instanceBindings: [
    ...[[source, 'acct_same'], [target, 'acct_same'], [other, 'acct_other']].map(([instance, accountId]) => ({
      instanceId: instance.instanceId, accountId, revokedAt: '', instancePublicKey: instance.publicKey,
      instanceKeyFingerprint: instance.keyFingerprint,
    })),
  ],
  devices: [],
};
const broker = createOwnerAuthBroker({
  store: { mutate: async (mutator) => mutator(state) },
  clock: () => now,
  verifyGoogleCredential: async () => ({ providerSubject: 'unused' }),
  resolveAccount: async () => ({ accountId: 'acct_same' }),
  signAssertion: async () => 'unused',
});

function proofFor(actor, targetInstanceId, requestId = 'psync_auth_1', issuedAt = new Date(now).toISOString(), syncKeyFingerprint = '') {
  return {
    requestId,
    accountId: 'acct_same',
    targetInstanceId,
    issuedAt,
    audience: 'agentoc-provider-sync',
    ...(syncKeyFingerprint ? { syncKeyFingerprint } : {}),
    instance: publicInstanceIdentity(actor),
    signature: signProviderSyncPeerProof(actor, {
      requestId,
      targetInstanceId,
      issuedAt,
      audience: 'agentoc-provider-sync',
      syncKeyFingerprint,
    }).signature,
  };
}

const authorized = await broker.authorizeProviderSync({
  requestId: 'psync_auth_1',
  targetInstanceId: target.instanceId,
  sourceProof: proofFor(source, target.instanceId),
});
assert.equal(authorized.authorized, true);
assert.equal(authorized.accountId, 'acct_same');
assert.equal(authorized.sourceInstanceId, source.instanceId);
assert.equal(authorized.targetInstanceId, target.instanceId);
assert.equal(authorized.sourcePublicKey, source.publicKey.trim());

const impostor = { ...other, instanceId: source.instanceId };
await assert.rejects(
  () => broker.authorizeProviderSync({ requestId: 'psync_impostor', targetInstanceId: target.instanceId,
    sourceProof: proofFor(impostor, target.instanceId, 'psync_impostor') }),
  (error) => error.code === 'provider_sync_auth_invalid',
);

const keyBound = proofFor(source, target.instanceId, 'psync_key', new Date(now).toISOString(), 'a'.repeat(64));
await broker.authorizeProviderSync({ requestId: 'psync_key', targetInstanceId: target.instanceId, sourceProof: keyBound });
keyBound.syncKeyFingerprint = 'b'.repeat(64);
await assert.rejects(() => broker.authorizeProviderSync({ requestId: 'psync_key', targetInstanceId: target.instanceId,
  sourceProof: keyBound }), (error) => error.code === 'provider_sync_auth_invalid');

await assert.rejects(
  () => broker.authorizeProviderSync({
    requestId: 'psync_auth_2',
    targetInstanceId: other.instanceId,
    sourceProof: proofFor(source, other.instanceId, 'psync_auth_2'),
  }),
  (error) => error.code === 'provider_sync_account_mismatch',
);

await assert.rejects(
  () => broker.authorizeProviderSync({
    requestId: 'psync_auth_3',
    targetInstanceId: target.instanceId,
    sourceProof: proofFor(source, target.instanceId, 'psync_auth_3', new Date(now - 10 * 60 * 1000).toISOString()),
  }),
  (error) => error.code === 'provider_sync_auth_expired',
);

const forged = proofFor(source, target.instanceId, 'psync_auth_4');
forged.targetInstanceId = other.instanceId;
await assert.rejects(
  () => broker.authorizeProviderSync({
    requestId: 'psync_auth_4',
    targetInstanceId: target.instanceId,
    sourceProof: forged,
  }),
  (error) => error.code === 'provider_sync_auth_invalid',
);

const mismatchedRequest = proofFor(source, target.instanceId, 'psync_auth_5');
mismatchedRequest.requestId = 'psync_auth_other';
await assert.rejects(
  () => broker.authorizeProviderSync({
    requestId: 'psync_auth_5',
    targetInstanceId: target.instanceId,
    sourceProof: mismatchedRequest,
  }),
  (error) => error.code === 'provider_sync_auth_invalid',
);

console.log('test-provider-sync-auth: ok');
