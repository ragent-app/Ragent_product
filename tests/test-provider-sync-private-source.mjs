import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'ragent-private-sync-'));
process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, 'local');
process.env.AGENTOC_ACCOUNTS_URL = 'https://accounts.example.test';
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.AGENTOC_INSTANCE_ROOT;
const { loadOrCreateInstanceIdentity, publicInstanceIdentity, signProviderSyncPeerProof } = await import('../lib/instance-identity.mjs');
const { createOwnerAuthBroker } = await import('../accounts/owner-auth-broker.mjs');
const { createCredentialMutationLedger, createNativeProviderRegistry, createProviderSyncLedger, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
const { createProviderSyncKeyStore, decryptProviderSyncEnvelope } = await import('../lib/provider-runtime/sync.mjs');
const { applyProviderSyncRecords } = await import('../chat/native-provider-management.mjs');
const { syncAccountSyncFromAccountPeers } = await import('../lib/provider-runtime/peer-sync.mjs');
const local = await loadOrCreateInstanceIdentity();
const peer = await loadOrCreateInstanceIdentity({ filePath: join(home, 'peer.json') });
await writeFile(join(home, 'local', 'owner-account-binding.json'), JSON.stringify({ accountId: 'acct_private_sync' }));
const peerKeys = await createProviderSyncKeyStore({ configDir: join(home, 'peer') }).getKeyPair();
const configDir = join(home, 'local');
const context = { registry: createNativeProviderRegistry({ configDir }), secretStore: createSecretStore({ configDir }),
  ledger: createProviderSyncLedger({ configDir }), credentialLedger: createCredentialMutationLedger({ configDir }) };
const binding = (instance) => ({ instanceId: instance.instanceId, accountId: 'acct_private_sync', revokedAt: '',
  instancePublicKey: instance.publicKey, instanceKeyFingerprint: instance.keyFingerprint });
const state = { instanceBindings: [binding(local), binding(peer)] };
const broker = createOwnerAuthBroker({ store: { mutate: async fn => fn(state) },
  verifyGoogleCredential: async () => ({}), resolveAccount: async () => ({}), signAssertion: async () => '' });
const record = { key: 'private-provider', version: { updatedAt: '2026-01-01T00:00:00.000Z', counter: 1, writerId: local.instanceId },
  provider: { id: 'private-provider', agentType: 'codex', protocol: 'openai-responses', baseUrl: 'https://provider.example.test', authProfileId: 'private-auth' },
  auth: { id: 'private-auth', agentType: 'codex', authType: 'api-key', storageType: 'secret-store', storageRef: 'private-secret' },
  secret: { authType: 'api-key', apiKey: 'test-private-secret' } };
await applyProviderSyncRecords({ ...context, localInstanceId: local.instanceId, incoming: [record] });
let pushes = 0;
let catalog = [];
const fetchImpl = async (url, options) => {
  const address = new URL(String(url));
  const body = JSON.parse(options.body);
  if (address.pathname.includes('/sync/catalog/')) {
    catalog = body.entries.map(entry => ({ ...entry, sourceInstanceId: local.instanceId }));
    return Response.json({ accepted: [], ignored: [] });
  }
  if (address.pathname.includes('/devices/')) return Response.json({ devices: [
    { deviceKind: 'computer', instanceId: local.instanceId, endpoint: '' },
    { deviceKind: 'computer', instanceId: peer.instanceId, endpoint: 'https://peer.example.test' },
  ], syncCatalog: catalog });
  if (address.pathname.endsWith('/provider-sync/authorize')) return Response.json(await broker.authorizeProviderSync(body));
  if (address.pathname.endsWith('/provider-sync/handshake')) {
    await broker.authorizeProviderSync({ sourceProof: body.sourceProof, requestId: body.sourceProof.requestId, targetInstanceId: peer.instanceId });
    const fields = { requestId: body.sourceProof.requestId, targetInstanceId: local.instanceId, issuedAt: new Date().toISOString(),
      audience: 'agentoc-provider-sync', syncKeyFingerprint: peerKeys.fingerprint };
    return Response.json({ targetInstanceId: peer.instanceId, targetPublicKey: peerKeys.publicKeyPem,
      targetProof: { ...fields, instance: publicInstanceIdentity(peer), signature: signProviderSyncPeerProof(peer, fields).signature } });
  }
  if (address.pathname.endsWith('/provider-sync/apply')) {
    const decoded = decryptProviderSyncEnvelope({ envelope: body.envelope, recipientPrivateKeyPem: peerKeys.privateKeyPem,
      expectedRecipientInstanceId: peer.instanceId, expectedSenderInstanceId: local.instanceId, senderSigningPublicKeyPem: local.publicKey });
    assert.equal(decoded.records[0].provider.baseUrl, record.provider.baseUrl);
    assert.equal(decoded.records[0].secret.apiKey, record.secret.apiKey);
    assert.equal(JSON.stringify(body).includes(record.secret.apiKey), false);
    pushes++;
    return Response.json({ ok: true, accepted: ['private-provider'], ignored: [] });
  }
  throw new Error(`unexpected route: ${address.pathname}`);
};
const first = await syncAccountSyncFromAccountPeers({ ...context, fetchImpl });
assert.equal(first.peers[0].ok, true);
assert.equal(pushes, 1, 'private source pushes its encrypted provider to an accessible peer');
await syncAccountSyncFromAccountPeers({ ...context, fetchImpl });
assert.equal(pushes, 1, 'unchanged configuration is not sent again every cycle');
console.log('private provider source push: ok');
