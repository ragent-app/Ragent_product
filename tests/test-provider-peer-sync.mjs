#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'agentoc-provider-peer-sync-'));
process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, 'config');
process.env.AGENTOC_ACCOUNTS_URL = 'https://accounts.example.test';
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.AGENTOC_INSTANCE_ROOT;

const {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signProviderSyncPeerProof,
} = await import('../lib/instance-identity.mjs');
const {
  createProviderSyncKeyStore,
  decryptProviderSyncEnvelope,
} = await import('../lib/provider-runtime/sync.mjs');
const { syncProviderSnapshotToPeer } = await import('../lib/provider-runtime/peer-sync.mjs');

const configDir = process.env.AGENTOC_CONFIG_DIR;
await writeFile(join(configDir, 'owner-account-binding.json'), JSON.stringify({ accountId: 'acct_peer_test' }));
const sourceIdentity = await loadOrCreateInstanceIdentity();
const targetIdentity = await loadOrCreateInstanceIdentity({ filePath: join(home, 'target-identity.json') });
const targetKey = await createProviderSyncKeyStore({ configDir: join(home, 'target-config') }).getKeyPair();
const calls = [];

const snapshot = {
  protocolVersion: 1,
  accountId: 'acct_peer_test',
  sourceInstanceId: sourceIdentity.instanceId,
  records: [{
    key: 'provider-peer',
    version: {
      updatedAt: '2026-08-23T00:00:00.000Z',
      counter: 1,
      writerId: sourceIdentity.instanceId,
    },
    provider: {
      id: 'provider-peer',
      syncId: 'provider-peer',
      agentType: 'codex',
      protocol: 'openai-responses',
      baseUrl: 'https://provider.example.test/v1',
      authProfileId: 'auth-peer',
    },
    auth: {
      id: 'auth-peer',
      agentType: 'codex',
      authType: 'api-key',
      storageType: 'secret-store',
      storageRef: 'secret-peer',
    },
    secret: { authType: 'api-key', apiKey: 'sk-peer-test' },
  }],
};

const result = await syncProviderSnapshotToPeer({
  targetEndpoint: 'https://computer.example.test/agentoc',
  targetInstanceId: targetIdentity.instanceId,
  snapshot,
  fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    const request = JSON.parse(options.body);
    if (calls.length === 1) {
      assert.equal(calls[0].url, 'https://computer.example.test/agentoc/api/provider-sync/handshake');
      const issuedAt = new Date().toISOString();
      const fields = { requestId: request.sourceProof.requestId, targetInstanceId: sourceIdentity.instanceId,
        issuedAt, audience: 'agentoc-provider-sync', syncKeyFingerprint: targetKey.fingerprint };
      return new Response(JSON.stringify({
        targetInstanceId: targetIdentity.instanceId,
        targetPublicKey: targetKey.publicKeyPem,
        targetProof: { ...fields, instance: publicInstanceIdentity(targetIdentity),
          signature: signProviderSyncPeerProof(targetIdentity, fields).signature },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (calls.length === 2) {
      assert.equal(calls[1].url, 'https://accounts.example.test/v1/owner-auth/provider-sync/authorize');
      return new Response(JSON.stringify({ authorized: true, accountId: 'acct_peer_test',
        sourceInstanceId: targetIdentity.instanceId, targetInstanceId: sourceIdentity.instanceId,
        sourcePublicKey: targetIdentity.publicKey }), { status: 200 });
    }
    assert.equal(calls[2].url, 'https://computer.example.test/agentoc/api/provider-sync/apply');
    assert.equal(Object.hasOwn(request, 'sourceSyncPublicKey'), false);
    const decrypted = decryptProviderSyncEnvelope({
      envelope: request.envelope,
      recipientPrivateKeyPem: targetKey.privateKeyPem,
      expectedRecipientInstanceId: targetIdentity.instanceId,
      expectedSenderInstanceId: sourceIdentity.instanceId,
      senderSigningPublicKeyPem: sourceIdentity.publicKey,
    });
    assert.deepEqual(decrypted, snapshot);
    return new Response(JSON.stringify({ ok: true, accepted: ['provider-peer'], ignored: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

assert.deepEqual(result.accepted, ['provider-peer']);
assert.equal(calls.length, 3);
console.log('test-provider-peer-sync: ok');
