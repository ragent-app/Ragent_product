import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'ragent-authenticated-pull-'));
process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, 'config');
process.env.AGENTOC_ACCOUNTS_URL = 'https://accounts.example.test';
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.AGENTOC_INSTANCE_ROOT;
const { loadOrCreateInstanceIdentity, publicInstanceIdentity, signProviderSyncPeerProof } = await import('../lib/instance-identity.mjs');
const { createOwnerAuthBroker } = await import('../accounts/owner-auth-broker.mjs');
const { encryptAccountSyncEnvelope, providerSyncKeyFingerprint } = await import('../lib/provider-runtime/sync.mjs');
const { pullAccountSyncRecordsFromPeer } = await import('../lib/provider-runtime/peer-sync.mjs');
const local = await loadOrCreateInstanceIdentity();
const peer = await loadOrCreateInstanceIdentity({ filePath: join(home, 'peer-identity.json') });
await writeFile(join(home, 'config', 'owner-account-binding.json'), JSON.stringify({ accountId: 'acct_sync_test' }));
const binding = instance => ({ instanceId: instance.instanceId, accountId: 'acct_sync_test', revokedAt: '',
  instancePublicKey: instance.publicKey, instanceKeyFingerprint: instance.keyFingerprint });
const state = { instanceBindings: [binding(local), binding(peer)] };
const broker = createOwnerAuthBroker({ store: { mutate: async (fn) => fn(state) },
  verifyGoogleCredential: async () => ({}), resolveAccount: async () => ({}), signAssertion: async () => '' });
let tamperProof = false;
const request = { sourceEndpoint: 'https://peer.example.test', sourceInstanceId: peer.instanceId,
  wants: [{ scope: 'provider', key: 'provider-test', version: { updatedAt: '2026-01-01T00:00:00.000Z', counter: 1, writerId: peer.instanceId } }],
  fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).startsWith('https://accounts.example.test/')) {
      const result = await broker.authorizeProviderSync(body);
      return Response.json(result);
    }
    assert.equal(providerSyncKeyFingerprint(body.requesterSyncPublicKey), body.sourceProof.syncKeyFingerprint);
    await broker.authorizeProviderSync({ sourceProof: body.sourceProof, requestId: body.sourceProof.requestId, targetInstanceId: peer.instanceId });
    const issuedAt = new Date().toISOString();
    const fields = { requestId: body.sourceProof.requestId, targetInstanceId: local.instanceId, issuedAt,
      audience: 'agentoc-provider-sync', syncKeyFingerprint: body.sourceProof.syncKeyFingerprint };
    const targetProof = { ...fields, instance: publicInstanceIdentity(peer), signature: signProviderSyncPeerProof(peer, fields).signature };
    const snapshot = { accountId: 'acct_sync_test', sourceInstanceId: peer.instanceId, records: [{ scope: 'provider', key: 'provider-test',
      version: request.wants[0].version, provider: { id: 'provider-test', agentType: 'codex', protocol: 'openai-responses', baseUrl: 'https://provider.example.test', authProfileId: 'auth-test' },
      auth: { id: 'auth-test', agentType: 'codex', authType: 'api-key', storageType: 'secret-store', storageRef: 'secret-test' },
      secret: { authType: 'api-key', apiKey: 'example-secret' } }] };
    const envelope = encryptAccountSyncEnvelope({ snapshot, recipientPublicKeyPem: body.requesterSyncPublicKey,
      senderInstanceId: peer.instanceId, senderSigningPrivateKeyPem: peer.privateKey, senderSigningPublicKeyPem: peer.publicKey,
      recipientInstanceId: local.instanceId, requestId: fields.requestId });
    if (tamperProof) targetProof.syncKeyFingerprint = 'f'.repeat(64);
    return Response.json({ sourceInstanceId: peer.instanceId, sourcePublicKey: peer.publicKey, targetProof, envelope });
  } };
const records = await pullAccountSyncRecordsFromPeer(request);
assert.equal(records[0].secret.apiKey, 'example-secret');
assert.equal(records[0].provider.baseUrl, 'https://provider.example.test');
tamperProof = true;
await assert.rejects(() => pullAccountSyncRecordsFromPeer(request), error => error.code === 'provider_sync_peer_response_invalid');
console.log('authenticated encrypted provider pull: ok');
