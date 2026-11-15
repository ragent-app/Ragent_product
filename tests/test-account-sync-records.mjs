#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import {
  buildAccountSyncSnapshot,
  createProviderSyncKeyStore,
  decryptAccountSyncEnvelope,
  encryptAccountSyncEnvelope,
  mergeAccountSyncRecords,
} from '../lib/provider-runtime/sync.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-account-sync-records-'));
const sourceIdentity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'source-identity.json') });
const targetIdentity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'target-identity.json') });
const sourceKey = await createProviderSyncKeyStore({ configDir: join(root, 'source-config') }).getKeyPair();
const targetKey = await createProviderSyncKeyStore({ configDir: join(root, 'target-config') }).getKeyPair();
const snapshot = buildAccountSyncSnapshot({
  accountId: 'acct_record_test',
  sourceInstanceId: sourceIdentity.instanceId,
  records: [
    {
      scope: 'provider',
      key: 'provider-openai',
      version: { updatedAt: '2026-08-23T00:00:01.000Z', counter: 1, writerId: sourceIdentity.instanceId },
      provider: { id: 'provider-openai', agentType: 'codex', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', authProfileId: 'auth-openai' },
      auth: { id: 'auth-openai', agentType: 'codex', authType: 'api-key', storageType: 'secret-store', storageRef: 'secret-openai' },
      secret: { authType: 'api-key', apiKey: 'sk-account-sync-test' },
    },
    {
      scope: 'agent-profile',
      key: 'app_automation',
      version: { updatedAt: '2026-08-23T00:00:01.000Z', counter: 2, writerId: sourceIdentity.instanceId },
      agent: { id: 'app_automation', name: 'Daily report', systemPrompt: 'Prepare the report.', tool: 'codex', skills: [] },
    },
  ],
});
const envelope = encryptAccountSyncEnvelope({
  snapshot,
  recipientPublicKeyPem: targetKey.publicKeyPem,
  senderInstanceId: sourceIdentity.instanceId,
  senderSigningPrivateKeyPem: sourceIdentity.privateKey,
  senderSigningPublicKeyPem: sourceIdentity.publicKey,
  recipientInstanceId: targetIdentity.instanceId,
  requestId: 'async_pull_test',
});
assert.equal(envelope.ciphertext.includes('sk-account-sync-test'), false);
const decrypted = decryptAccountSyncEnvelope({
  envelope,
  recipientPrivateKeyPem: targetKey.privateKeyPem,
  expectedRecipientInstanceId: targetIdentity.instanceId,
  expectedSenderInstanceId: sourceIdentity.instanceId,
  senderSigningPublicKeyPem: sourceIdentity.publicKey,
});
assert.deepEqual(decrypted, snapshot);

const merged = mergeAccountSyncRecords([], [
  snapshot.records[0],
  snapshot.records[1],
]);
assert.deepEqual(merged.accepted, ['provider:provider-openai', 'agent-profile:app_automation']);
const stale = mergeAccountSyncRecords(merged.records, [{
  ...snapshot.records[1],
  version: { updatedAt: '2026-08-23T00:00:00.000Z', counter: 999, writerId: targetIdentity.instanceId },
}]);
assert.deepEqual(stale.accepted, []);
assert.deepEqual(stale.ignored, ['agent-profile:app_automation']);

console.log('test-account-sync-records: ok');
