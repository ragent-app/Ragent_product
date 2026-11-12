#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'agentoc-account-sync-catalog-'));
const { createOwnerAuthBroker } = await import('../accounts/owner-auth-broker.mjs');
const {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signOwnerAuthDeviceProof,
  signProviderSyncPeerProof,
} = await import('../lib/instance-identity.mjs');

const source = await loadOrCreateInstanceIdentity({ filePath: join(root, 'source.json') });
const replica = await loadOrCreateInstanceIdentity({ filePath: join(root, 'replica.json') });
const accountId = 'acct_catalog_test';
let now = Date.parse('2026-08-23T00:00:00.000Z');
const state = {
  instanceBindings: [
    ...[source, replica].map((instance) => ({ instanceId: instance.instanceId, accountId, revokedAt: '',
      instancePublicKey: instance.publicKey, instanceKeyFingerprint: instance.keyFingerprint })),
  ],
  devices: [
    { deviceId: source.instanceId, instanceId: source.instanceId, accountId, deviceKind: 'computer', alias: 'source', createdAt: new Date(now).toISOString() },
    { deviceId: replica.instanceId, instanceId: replica.instanceId, accountId, deviceKind: 'computer', alias: 'replica', createdAt: new Date(now).toISOString() },
  ],
};
const broker = createOwnerAuthBroker({
  store: { mutate: async (mutator) => mutator(state) },
  clock: () => now,
  verifyGoogleCredential: async () => ({ providerSubject: 'unused' }),
  resolveAccount: async () => ({ accountId }),
  signAssertion: async () => 'unused',
});

function catalogProof(identity, requestId) {
  const issuedAt = new Date(now).toISOString();
  const targetInstanceId = `account:${accountId}`;
  return {
    requestId,
    accountId,
    targetInstanceId,
    issuedAt,
    audience: 'agentoc-account-sync-catalog',
    instance: publicInstanceIdentity(identity),
    signature: signProviderSyncPeerProof(identity, {
      requestId,
      targetInstanceId,
      issuedAt,
      audience: 'agentoc-account-sync-catalog',
    }).signature,
  };
}

const first = await broker.publishAccountSyncCatalog({
  accountId,
  sourceProof: catalogProof(source, 'catalog_1'),
  entries: [{
    scope: 'provider',
    key: 'provider-openai',
    version: { updatedAt: '2026-08-23T00:00:01.000Z', counter: 1, writerId: source.instanceId },
  }],
});
await assert.rejects(() => broker.publishAccountSyncCatalog({ accountId,
  sourceProof: catalogProof({ ...replica, instanceId: source.instanceId }, 'catalog_impostor'), entries: [] }),
  (error) => error.code === 'account_sync_auth_invalid');
assert.deepEqual(first.accepted, ['provider:provider-openai']);
assert.deepEqual(first.ignored, []);

const stale = await broker.publishAccountSyncCatalog({
  accountId,
  sourceProof: catalogProof(replica, 'catalog_2'),
  entries: [{
    scope: 'provider',
    key: 'provider-openai',
    version: { updatedAt: '2026-08-23T00:00:00.500Z', counter: 99, writerId: replica.instanceId },
  }],
});
assert.deepEqual(stale.accepted, [], 'a stale central version must not replace the latest version');
assert.deepEqual(stale.ignored, ['provider:provider-openai']);
assert.equal(state.accountSyncCatalog[0].sourceInstanceId, source.instanceId);

now += 1000;
const newer = await broker.publishAccountSyncCatalog({
  accountId,
  sourceProof: catalogProof(replica, 'catalog_3'),
  entries: [
    {
      scope: 'provider',
      key: 'provider-openai',
      version: { updatedAt: '2026-08-23T00:00:02.000Z', counter: 0, writerId: replica.instanceId },
    },
    {
      scope: 'agent-profile',
      key: 'app_automation',
      version: { updatedAt: '2026-08-23T00:00:02.000Z', counter: 1, writerId: replica.instanceId },
      deletedAt: '2026-08-23T00:00:02.000Z',
    },
  ],
});
assert.deepEqual(newer.accepted, ['provider:provider-openai', 'agent-profile:app_automation']);
assert.equal(state.accountSyncCatalog.find((entry) => entry.key === 'provider-openai').sourceInstanceId, replica.instanceId);
assert.equal(state.accountSyncCatalog.find((entry) => entry.key === 'provider-openai').version.writerId, replica.instanceId);
assert.equal(state.accountSyncCatalog.find((entry) => entry.key === 'app_automation').deletedAt, '2026-08-23T00:00:02.000Z');

const deviceIssuedAt = new Date(now).toISOString();
const deviceProof = signOwnerAuthDeviceProof(source, {
  transactionId: 'catalog_devices',
  purpose: 'devices',
  issuedAt: deviceIssuedAt,
  audience: 'agentoc-owner-auth-device',
});
const devices = await broker.listDevices({
  transactionId: 'catalog_devices',
  purpose: 'devices',
  accountId,
  instance: publicInstanceIdentity(source),
  issuedAt: deviceIssuedAt,
  audience: 'agentoc-owner-auth-device',
  signature: deviceProof.signature,
});
assert.equal(devices.syncCatalog.length, 2);
assert.equal(devices.syncCatalog.find((entry) => entry.scope === 'provider').sourceInstanceId, replica.instanceId);

// 回归防护：account_sync_catalog 的 CHECK 约束必须覆盖 ACCOUNT_SYNC_SCOPES 全集。
// 漂移时实例发布的目录项会被生产库以 23514 拒绝（手机 Connect 随即失败）。
{
  const { ACCOUNT_SYNC_SCOPES } = await import('../lib/account-sync.mjs');
  const migrationsDir = new URL('../accounts/migrations/', import.meta.url);
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.up.sql')).sort();
  let effective = null;
  for (const file of files) {
    const sql = await readFile(new URL(file, migrationsDir), 'utf8');
    for (const match of sql.matchAll(
      /add constraint account_sync_catalog_scope_check\s+check\s*\(scope in \(([^)]*)\)\)/g,
    )) {
      effective = { file, scopes: [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]) };
    }
  }
  assert.ok(effective, 'no account_sync_catalog_scope_check constraint found in migrations');
  assert.deepEqual(
    [...effective.scopes].sort(),
    [...ACCOUNT_SYNC_SCOPES].sort(),
    `migration ${effective.file} scope check drifted from ACCOUNT_SYNC_SCOPES`,
  );
}

console.log('test-account-sync-catalog: ok');
