#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import {
  buildProviderSyncSnapshot,
  buildAccountSyncSnapshot,
  compareSyncVersions,
  createProviderSyncKeyStore,
  decryptProviderSyncEnvelope,
  encryptProviderSyncEnvelope,
  mergeProviderSyncRecords,
  normalizeProviderSyncRecord,
} from '../lib/provider-runtime/sync.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { createProviderSyncLedger } from '../lib/provider-runtime/sync-ledger.mjs';
import { applyProviderSyncRecords, listNativeProviderProfiles } from '../chat/native-provider-management.mjs';
import { buildProviderSyncEndpointUrl } from '../lib/provider-runtime/peer-sync.mjs';

const root = await mkdtemp(join(tmpdir(), 'agentoc-provider-sync-'));
const sourceDir = join(root, 'source');
const targetDir = join(root, 'target');
const sourceKeys = createProviderSyncKeyStore({ configDir: sourceDir });
const targetKeys = createProviderSyncKeyStore({ configDir: targetDir });
const competingKeys = await Promise.all(Array.from({ length: 12 }, () =>
  createProviderSyncKeyStore({ configDir: join(root, 'concurrent-key') }).getKeyPair()));
assert.equal(new Set(competingKeys.map((key) => key.fingerprint)).size, 1,
  'concurrent peer requests must share the same persisted decryption key');
assert.equal(
  String(buildProviderSyncEndpointUrl('https://computer.example.test/agentoc', '/api/provider-sync/apply')),
  'https://computer.example.test/agentoc/api/provider-sync/apply',
  'provider sync must preserve a reverse-proxy path prefix',
);
const [sourceSyncKey, sourceSyncKeyAgain, targetSyncKey] = await Promise.all([
  sourceKeys.getKeyPair(),
  sourceKeys.getKeyPair(),
  targetKeys.getKeyPair(),
]);

assert.equal(sourceSyncKey.publicKeyPem, sourceSyncKeyAgain.publicKeyPem, 'sync key must be stable within concurrent initialization');
assert.notEqual(sourceSyncKey.publicKeyPem, targetSyncKey.publicKeyPem, 'different instances need different sync keys');
const storedKey = JSON.parse(await readFile(join(sourceDir, 'native-provider-runtime', 'provider-sync-key.json'), 'utf8'));
assert.equal(storedKey.privateKeyPem, sourceSyncKey.privateKeyPem, 'private key must be persisted for the instance only');

const signing = generateKeyPairSync('ed25519');
const sourceSigningPublicKeyPem = signing.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
const sourceSigningPrivateKeyPem = signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
const snapshot = buildProviderSyncSnapshot({
  accountId: 'acct_test',
  sourceInstanceId: 'inst_source',
  records: [{
    key: 'provider-openai',
    version: { updatedAt: '2026-08-23T00:00:00.000Z', counter: 1, writerId: 'inst_source' },
    provider: {
      id: 'provider-openai',
      agentType: 'codex',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      authProfileId: 'auth-openai',
    },
    auth: {
      id: 'auth-openai',
      agentType: 'codex',
      authType: 'api-key',
      storageType: 'secret-store',
      storageRef: 'secret-openai',
    },
    secret: { authType: 'api-key', apiKey: 'sk-secret-test-value' },
  }],
});

const localOAuthProvider = {
  id: 'provider-openai-oauth',
  agentType: 'codex',
  protocol: 'openai-responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  authProfileId: 'auth-openai-oauth',
};
const localOAuthAuth = {
  id: 'auth-openai-oauth',
  agentType: 'codex',
  authType: 'oauth',
  storageType: 'secret-store',
  storageRef: 'secret-openai-oauth',
};
const localAgyProvider = {
  id: 'provider-agy-oauth',
  agentType: 'agy',
  protocol: 'agy',
  baseUrl: '',
  authProfileId: 'auth-agy-oauth',
};
const localAgyAuth = {
  id: 'auth-agy-oauth',
  agentType: 'agy',
  authType: 'oauth',
  storageType: 'secret-store',
  storageRef: 'secret-agy-oauth',
};
assert.deepEqual(
  buildProviderSyncSnapshot({
    accountId: 'acct_test',
    sourceInstanceId: 'inst_source',
    records: [
      {
        key: localOAuthProvider.id,
        version: { updatedAt: '2026-08-23T00:00:00.000Z', counter: 1, writerId: 'inst_source' },
        provider: localOAuthProvider,
        auth: localOAuthAuth,
        secret: { authType: 'oauth', tokens: { access_token: 'at', refresh_token: 'rt' } },
      },
      {
        key: localAgyProvider.id,
        version: { updatedAt: '2026-08-23T00:00:00.000Z', counter: 2, writerId: 'inst_source' },
        provider: localAgyProvider,
        auth: localAgyAuth,
        secret: { authType: 'oauth', tokens: { tokenFile: 'agy-token' } },
      },
    ],
  }).records,
  [],
  'official native OAuth credential payloads must stay on the source machine',
);
const legacyOAuthRecord = normalizeProviderSyncRecord({
  key: localOAuthProvider.id,
  version: { updatedAt: '2026-08-23T00:00:00.000Z', counter: 1, writerId: 'inst_source' },
  provider: localOAuthProvider,
  auth: localOAuthAuth,
  secret: { authType: 'oauth', tokens: { access_token: 'at', refresh_token: 'rt' } },
});
assert.equal(legacyOAuthRecord.machineLocalOnly, true);
assert.equal('secret' in legacyOAuthRecord, false);
const legacyAgyRecord = normalizeProviderSyncRecord({
  key: localAgyProvider.id,
  version: { updatedAt: '2026-08-23T00:00:00.000Z', counter: 2, writerId: 'inst_source' },
  provider: localAgyProvider,
  auth: localAgyAuth,
  secret: { authType: 'oauth', tokens: { tokenFile: 'agy-token' } },
});
assert.equal(legacyAgyRecord.machineLocalOnly, true);
assert.equal('secret' in legacyAgyRecord, false);
const legacyAccountSnapshot = buildAccountSyncSnapshot({
  accountId: 'acct_test',
  sourceInstanceId: 'inst_source',
  records: [{
    scope: 'provider',
    key: localOAuthProvider.id,
    version: { updatedAt: '2026-08-23T00:00:00.000Z', counter: 1, writerId: 'inst_source' },
    provider: localOAuthProvider,
    auth: localOAuthAuth,
    secret: { authType: 'oauth', tokens: { access_token: 'at', refresh_token: 'rt' } },
  }],
});
assert.equal(legacyAccountSnapshot.records[0].machineLocalOnly, true);
assert.equal('secret' in legacyAccountSnapshot.records[0], false);

const envelope = encryptProviderSyncEnvelope({
  snapshot,
  recipientPublicKeyPem: targetSyncKey.publicKeyPem,
  senderInstanceId: 'inst_source',
  senderSigningPrivateKeyPem: sourceSigningPrivateKeyPem,
  senderSigningPublicKeyPem: sourceSigningPublicKeyPem,
  recipientInstanceId: 'inst_target',
  requestId: 'psync_test_1',
});
assert.equal(typeof envelope.ciphertext, 'string');
assert.equal(envelope.ciphertext.includes('sk-secret-test-value'), false, 'ciphertext must not expose secrets');
const decrypted = decryptProviderSyncEnvelope({
  envelope,
  recipientPrivateKeyPem: targetSyncKey.privateKeyPem,
  expectedRecipientInstanceId: 'inst_target',
  expectedSenderInstanceId: 'inst_source',
  senderSigningPublicKeyPem: sourceSigningPublicKeyPem,
});
assert.deepEqual(decrypted, snapshot, 'target should recover the exact provider/auth/secret bundle');

const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}A` };
assert.throws(
  () => decryptProviderSyncEnvelope({
    envelope: tampered,
    recipientPrivateKeyPem: targetSyncKey.privateKeyPem,
    expectedRecipientInstanceId: 'inst_target',
    expectedSenderInstanceId: 'inst_source',
    senderSigningPublicKeyPem: sourceSigningPublicKeyPem,
  }),
  (error) => error.code === 'provider_sync_signature_invalid',
  'tampering must fail signature verification before decryption',
);
assert.throws(
  () => decryptProviderSyncEnvelope({
    envelope,
    recipientPrivateKeyPem: sourceSyncKey.privateKeyPem,
    expectedRecipientInstanceId: 'inst_target',
    expectedSenderInstanceId: 'inst_source',
    senderSigningPublicKeyPem: sourceSigningPublicKeyPem,
  }),
  (error) => error.code === 'provider_sync_decrypt_failed',
  'the wrong instance private key must not decrypt the envelope',
);

const oldRecord = normalizeProviderSyncRecord({
  key: 'provider-openai',
  version: { updatedAt: '2026-08-23T00:00:00.000Z', counter: 1, writerId: 'inst_source' },
  provider: { id: 'provider-openai', baseUrl: 'https://old.example', agentType: 'codex', protocol: 'openai-chat' },
  auth: { id: 'auth-openai', authType: 'api-key', storageType: 'secret-store', storageRef: 'secret-openai' },
  secret: { authType: 'api-key', apiKey: 'old' },
});
const newerRecord = normalizeProviderSyncRecord({
  key: 'provider-openai',
  version: { updatedAt: '2026-08-23T00:00:01.000Z', counter: 0, writerId: 'inst_target' },
  provider: { id: 'provider-openai', baseUrl: 'https://new.example', agentType: 'codex', protocol: 'openai-responses' },
  auth: { id: 'auth-openai', authType: 'api-key', storageType: 'secret-store', storageRef: 'secret-openai' },
  secret: { authType: 'api-key', apiKey: 'new' },
});
const tombstone = normalizeProviderSyncRecord({
  key: 'provider-openai',
  version: { updatedAt: '2026-08-23T00:00:02.000Z', counter: 0, writerId: 'inst_target' },
  deletedAt: '2026-08-23T00:00:02.000Z',
});
assert.ok(compareSyncVersions(newerRecord.version, oldRecord.version) > 0);
const merged = mergeProviderSyncRecords([oldRecord], [newerRecord, tombstone]);
assert.equal(merged.records[0].deletedAt, tombstone.deletedAt, 'the newest tombstone must win over an older provider and secret');
assert.deepEqual(merged.accepted, ['provider-openai', 'provider-openai']);

const payloadKeys = Object.keys(decrypted).sort();
assert.deepEqual(payloadKeys, ['accountId', 'protocolVersion', 'records', 'sourceInstanceId'], 'session/history/run state must not enter provider sync payloads');

const targetRegistry = createNativeProviderRegistry({ configDir: targetDir });
const targetSecretStore = createSecretStore({ configDir: targetDir });
const targetLedger = createProviderSyncLedger({ configDir: targetDir });
const applied = await applyProviderSyncRecords({
  registry: targetRegistry,
  secretStore: targetSecretStore,
  ledger: targetLedger,
  localInstanceId: 'inst_target',
  incoming: snapshot.records,
});
assert.deepEqual(applied.accepted, ['provider-openai'], 'new remote provider should be applied');
const managementRows = await listNativeProviderProfiles({ registry: targetRegistry, secretStore: targetSecretStore });
assert.equal(managementRows[0].syncId, 'provider-openai', 'cross-instance UI must receive the original synchronization identity after applying a peer record');
assert.ok(managementRows[0].credentialFingerprint, 'cross-instance comparison needs an opaque credential fingerprint, never the credential');
assert.equal((await targetSecretStore.resolveSecret('secret-openai')).apiKey, 'sk-secret-test-value');
const ledgerText = await readFile(join(targetDir, 'native-provider-runtime', 'provider-sync-ledger.json'), 'utf8');
assert.equal(ledgerText.includes('sk-secret-test-value'), false, 'the local sync ledger must not duplicate credentials');

const deleted = await applyProviderSyncRecords({
  registry: targetRegistry,
  secretStore: targetSecretStore,
  ledger: targetLedger,
  localInstanceId: 'inst_target',
  incoming: [tombstone],
});
assert.deepEqual(deleted.accepted, ['provider-openai'], 'newer tombstone should be accepted');
assert.equal((await targetRegistry.listProviderProfiles()).length, 0, 'tombstone should remove the provider row');
assert.equal((await targetSecretStore.resolveSecret('secret-openai')).ok, false, 'tombstone should remove the credential');

const stale = await applyProviderSyncRecords({
  registry: targetRegistry,
  secretStore: targetSecretStore,
  ledger: targetLedger,
  localInstanceId: 'inst_target',
  incoming: [oldRecord],
});
assert.deepEqual(stale.accepted, [], 'an older provider record must not resurrect a tombstoned provider');
assert.equal((await targetRegistry.listProviderProfiles()).length, 0);

console.log('test-provider-sync: ok');
