#!/usr/bin/env node
// Accounts PostgreSQL store 集成测试。
// 需要 RAGENT_ACCOUNTS_DATABASE_URL（本地开发用 compose 里的 accounts 库）；
// 未配置时打印 skip 并正常退出，避免在没有数据库的机器上阻塞测试。
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { createPostgresStore, createPostgresStoreFromUrl } from '../accounts/store/postgres.mjs';
import { loadOrCreateInstanceIdentity, publicInstanceIdentity, signInstanceProof } from '../lib/instance-identity.mjs';

const databaseUrl = process.env.RAGENT_ACCOUNTS_DATABASE_URL;
if (!databaseUrl) {
  console.log('test-accounts-postgres: skipped (RAGENT_ACCOUNTS_DATABASE_URL not set)');
  process.exit(0);
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

async function resetTables() {
  await pool.query('truncate accounts restart identity cascade');
}

function transaction(overrides = {}) {
  const now = new Date();
  return {
    id: `tx_test_${Math.random().toString(16).slice(2)}`,
    purpose: 'login',
    returnUrl: 'https://instance.example.test/api/auth/google/complete?tx=x',
    instance: { instanceId: 'inst_test', publicKey: 'pk', keyFingerprint: 'fp' },
    nonce: 'nonce',
    bootstrapHash: 'hash',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300000).toISOString(),
    ...overrides,
  };
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok - ${name}`);
}

await resetTables();

// 1. 持久化：写入后重建 store 仍能读到
{
  const storeA = createPostgresStore({ pool });
  await storeA.mutate(async (draft) => {
    draft.accounts.push({
      accountId: 'acct_persist_1',
      provider: 'google',
      providerSubject: 'subject-1',
      createdAt: new Date().toISOString(),
    });
    draft.ownerAuthTransactions.push(transaction({ id: 'tx_persist_1' }));
  });
  await storeA.close();

  const storeB = createPostgresStoreFromUrl(databaseUrl);
  const state = await storeB.mutate(async (draft) => draft);
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].accountId, 'acct_persist_1');
  assert.equal(state.ownerAuthTransactions.length, 1);
  assert.equal(state.ownerAuthTransactions[0].id, 'tx_persist_1');
  assert.ok(state.ownerAuthTransactions[0].expiresAt);
  await storeB.close();
  ok('Postgres store 重启后事务与账号仍然存在');
}

// 2. broker 全链路跑在 Postgres store 上
{
  await resetTables();
  const store = createPostgresStore({ pool });
  const identity = await loadOrCreateInstanceIdentity();
  const broker = createOwnerAuthBroker({
    store,
    verifyGoogleCredential: async () => ({ providerSubject: 'google-subject-1' }),
    resolveAccount: async () => ({ accountId: 'acct_broker_1' }),
    signAssertion: async () => 'assertion',
    allowInsecureReturnUrl: true,
  });
  const transactionId = 'tx_broker_1';
  const issuedAt = new Date().toISOString();
  const returnUrl = 'http://instance.example.test/api/auth/google/complete?tx=1';
  const started = await broker.start({
    transactionId,
    purpose: 'login',
    returnUrl,
    instance: publicInstanceIdentity(identity),
    issuedAt,
    audience: 'ragent-owner-auth',
    signature: signInstanceProof(identity, {
      transactionId,
      purpose: 'login',
      returnUrl,
      issuedAt,
      audience: 'ragent-owner-auth',
    }).signature,
  });
  assert.ok(started.bootstrap);
  await store.close();

  const check = createPostgresStore({ pool });
  const state = await check.mutate(async (draft) => draft);
  assert.equal(state.ownerAuthTransactions.length, 1);
  assert.equal(state.ownerAuthTransactions[0].id, transactionId);
  await check.close();
  ok('owner-auth broker 可运行在 Postgres store 上');
}

// 3. 并发创建事务不丢失
{
  await resetTables();
  const store = createPostgresStore({ pool });
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.mutate(async (draft) => {
        draft.ownerAuthTransactions.push(transaction({ id: `tx_concurrent_${index}` }));
      }),
    ),
  );
  assert.equal(results.length, 20);
  const state = await store.mutate(async (draft) => draft);
  assert.equal(state.ownerAuthTransactions.length, 20);
  await store.close();
  ok('并发创建 20 个事务全部成功且不覆盖');
}

// 4. 过期事务可清理
{
  await resetTables();
  const store = createPostgresStore({ pool });
  const past = new Date(Date.now() - 60000).toISOString();
  await store.mutate(async (draft) => {
    draft.ownerAuthTransactions.push(transaction({ id: 'tx_expired_1', expiresAt: past }));
    draft.ownerAuthTransactions.push(transaction({ id: 'tx_alive_1' }));
  });
  const removed = await store.sweepExpired(Date.now());
  assert.equal(removed, 1);
  const state = await store.mutate(async (draft) => draft);
  assert.equal(state.ownerAuthTransactions.length, 1);
  assert.equal(state.ownerAuthTransactions[0].id, 'tx_alive_1');
  await store.close();
  ok('sweepExpired 只清理过期事务');
}

// 4b. instance_bindings / devices / binding_history 持久化与解绑标记
{
  await resetTables();
  const storeA = createPostgresStore({ pool });
  await storeA.mutate(async (draft) => {
    draft.instanceBindings = [
      {
        instanceId: 'inst_dev_1',
        accountId: 'acct_dev_1',
        provider: 'google',
        deviceAlias: '客厅电脑',
        publicEndpoint: 'https://instance.example.test',
        instancePublicKey: 'instance-public-key-test-value',
        instanceKeyFingerprint: 'sha256:instance-key-test-fingerprint',
        boundAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        revokedAt: '',
      },
    ];
    draft.devices = [
      {
        deviceId: 'inst_dev_1',
        instanceId: 'inst_dev_1',
        accountId: 'acct_dev_1',
        alias: '客厅电脑',
        lastSeenAt: new Date().toISOString(),
        unboundAt: '',
        createdAt: new Date().toISOString(),
      },
    ];
    draft.bindingHistory = [
      {
        instanceId: 'inst_dev_1',
        accountId: 'acct_dev_1',
        action: 'bind',
        occurredAt: new Date().toISOString(),
      },
    ];
  });
  await storeA.mutate(async (draft) => {
    draft.devices.find((item) => item.deviceId === 'inst_dev_1').unboundAt = new Date().toISOString();
  });
  await storeA.close();

  const storeB = createPostgresStore({ pool });
  const state = await storeB.mutate(async (draft) => draft);
  assert.equal(state.instanceBindings.length, 1);
  assert.equal(state.instanceBindings[0].deviceAlias, '客厅电脑');
  assert.equal(state.instanceBindings[0].publicEndpoint, 'https://instance.example.test');
  assert.equal(state.instanceBindings[0].instancePublicKey, 'instance-public-key-test-value');
  assert.equal(state.instanceBindings[0].instanceKeyFingerprint, 'sha256:instance-key-test-fingerprint');
  assert.ok(state.instanceBindings[0].lastSeenAt, 'instance_bindings.last_seen_at 应持久化');
  assert.equal(state.devices.length, 1);
  assert.ok(state.devices[0].unboundAt, 'devices.unbound_at 应持久化');
  assert.equal(state.bindingHistory.length, 1);
  assert.equal(state.bindingHistory[0].action, 'bind');
  await storeB.close();
  ok('instance_bindings/devices/binding_history 持久化且解绑标记保留');
}

// 4c. account-level Android session state survives store reconstruction and
// remains separate from target-coupled devices.
{
  await resetTables();
  const storeA = createPostgresStore({ pool });
  const stamp = new Date().toISOString();
  await storeA.mutate(async (draft) => {
    draft.accounts.push({
      accountId: 'acct_session_pg_1', provider: 'google', providerSubject: 'session-subject', createdAt: stamp,
    });
    draft.accountDevices = [{
      deviceId: 'adev_session_pg_1', accountId: 'acct_session_pg_1', alias: 'Pixel', platform: 'android',
      createdAt: stamp, lastSeenAt: stamp, unboundAt: new Date(Date.now() - 1000).toISOString(), revokedAt: '',
    }];
    draft.accountDeviceKeys = [{
      keyId: 'dkey_session_pg_1', accountId: 'acct_session_pg_1', deviceId: 'adev_session_pg_1',
      publicKey: '-----BEGIN PUBLIC KEY-----\nexample\n-----END PUBLIC KEY-----\n', fingerprint: 'a'.repeat(64),
      createdAt: stamp, revokedAt: '',
    }];
    draft.accountCredentials = [{
      credentialId: 'racid_session_pg_1', tokenHash: 'b'.repeat(64), accountId: 'acct_session_pg_1',
      deviceId: 'adev_session_pg_1', keyId: 'dkey_session_pg_1', scope: 'account-directory',
      issuedAt: stamp, expiresAt: new Date(Date.now() + 86400000).toISOString(), revokedAt: '', lastUsedAt: stamp,
    }];
    draft.accountSessionChallenges = [{
      transactionId: 'oasc_session_pg_1', requestId: 'session-request-pg-0001', deviceId: 'adev_session_pg_1',
      publicKey: '-----BEGIN PUBLIC KEY-----\nexample\n-----END PUBLIC KEY-----\n', publicKeyFingerprint: 'a'.repeat(64),
      deviceAlias: 'Pixel', platform: 'android', nonce: 'nonce_pg', createdAt: stamp,
      expiresAt: new Date(Date.now() + 300000).toISOString(), consumedAt: '',
    }];
    draft.accountCredentialRefreshes = [{
      credentialId: 'racid_session_pg_1', requestId: 'session-refresh-pg-0001', nonceHash: 'c'.repeat(64), issuedAt: stamp, createdAt: stamp,
    }];
    draft.accountJoinIntents = [{
      intentId: 'rji_session_pg_1', instanceId: 'inst_session_pg_1',
      instance: { instanceId: 'inst_session_pg_1', publicKey: 'instance-pk', keyFingerprint: 'instance-fp' },
      deviceId: 'rdev_session_pg_1', devicePublicKey: 'device-pk', devicePublicKeyFingerprint: 'a'.repeat(64),
      deviceAlias: 'Pixel', platform: 'android', publicEndpoint: 'https://session-pg.example.test', nonceHash: 'd'.repeat(64), issuedAt: stamp, createdAt: stamp,
      expiresAt: new Date(Date.now() + 120000).toISOString(), status: 'pending', accountId: '', completionRequestId: '', completedAt: '',
      accountDeviceId: '',
    }];
    draft.accountJoinGrants = [{
      grantHash: 'e'.repeat(64), accountId: 'acct_session_pg_1', instanceId: 'inst_session_pg_1', intentId: 'rji_session_pg_1',
      deviceId: 'rdev_session_pg_1', accountDeviceId: 'adev_session_pg_1', keyFingerprint: 'a'.repeat(64),
      claimInstance: true, publicEndpoint: 'https://session-pg.example.test', requestId: 'join-grant-pg-0001',
      createdAt: stamp, expiresAt: new Date(Date.now() + 60000).toISOString(), redeemedAt: '',
    }];
  });
  await storeA.close();

  const storeB = createPostgresStore({ pool });
  const state = await storeB.mutate(async (draft) => draft);
  assert.equal(state.devices.length, 0, 'account session must not write legacy target devices');
  assert.equal(state.accountDevices[0].deviceId, 'adev_session_pg_1');
  assert.ok(state.accountDevices[0].unboundAt, 'account_devices.unbound_at 应持久化');
  assert.equal(state.accountDeviceKeys[0].fingerprint, 'a'.repeat(64));
  assert.equal(state.accountCredentials[0].credentialId, 'racid_session_pg_1');
  assert.equal(state.accountSessionChallenges[0].nonce, 'nonce_pg');
  assert.equal(state.accountCredentialRefreshes[0].requestId, 'session-refresh-pg-0001');
  assert.equal(state.accountJoinIntents[0].accountDeviceId, '');
  assert.equal(state.accountJoinGrants[0].intentId, 'rji_session_pg_1');
  assert.equal(state.accountJoinGrants[0].accountDeviceId, 'adev_session_pg_1');
  assert.equal(state.accountJoinGrants[0].deviceId, 'rdev_session_pg_1');
  assert.equal(state.accountJoinGrants[0].claimInstance, true);
  await storeB.close();
  ok('账号级 Android session / grant 状态可在 Postgres 重建后完整恢复');
}

// 5. 数据库不可用时 fail-closed
{
  const store = createPostgresStoreFromUrl('postgres://nobody:nothing@127.0.0.1:1/nope');
  let rejected = false;
  try {
    await store.mutate(async (draft) => draft);
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
  ok('数据库不可用时 mutate 抛错（fail-closed）');
}

await pool.end();
console.log(`test-accounts-postgres: ${passed} assertions passed`);
