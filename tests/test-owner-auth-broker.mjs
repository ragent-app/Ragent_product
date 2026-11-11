#!/usr/bin/env node
import assert from 'assert/strict';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
// Independent Accounts artifacts deliberately exclude desktop identity state
// helpers. Keep the proof-generating fixture here while testing release code.
const testedRoot = process.env.AGENTOC_ACCOUNTS_TEST_RELEASE_ROOT || repoRoot;
const home = mkdtempSync(join(tmpdir(), 'agentoc-owner-auth-broker-'));
process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, 'config');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.AGENTOC_INSTANCE_ROOT;

const {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signInstanceProof,
  signAccountRendezvousPollProof,
  signOwnerAuthDeviceProof,
  signNativeOwnerAuthProof,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'instance-identity.mjs')).href);
const { createOwnerAuthBroker, deriveDesktopReplayValues, OWNER_AUTH_TRANSACTION_TTL_MS } = await import(pathToFileURL(join(testedRoot, 'accounts', 'owner-auth-broker.mjs')).href);
const { createDevicePublicKeyFingerprint, normalizeDevicePublicKey } = await import(pathToFileURL(join(testedRoot, 'lib', 'device-auth-protocol.mjs')).href);

let now = Date.parse('2026-08-09T12:00:00.000Z');
let state = {
  accountEntitlements: [{
    accountId: 'acct_owner_1',
    plan: 'pro',
    source: 'test',
    expiresAt: '',
  }],
};
const store = {
  async mutate(mutator) {
    return mutator(state);
  },
};
const identity = await loadOrCreateInstanceIdentity();
const secondIdentity = await loadOrCreateInstanceIdentity({ filePath: join(home, 'other-identity.json') });
const nativeIdentity = await loadOrCreateInstanceIdentity({ filePath: join(home, 'native-identity.json') });
const quotaIdentity = await loadOrCreateInstanceIdentity({ filePath: join(home, 'quota-identity.json') });
const endpointlessIdentity = await loadOrCreateInstanceIdentity({ filePath: join(home, 'endpointless-identity.json') });
const discoverableIdentity = await loadOrCreateInstanceIdentity({ filePath: join(home, 'discoverable-identity.json') });
const returnUrl = 'https://instance.example.test/api/auth/google/complete?tx=tx_1';

function proofFor({ actor = identity, transactionId = 'tx_1', purpose = 'bind', callback = returnUrl, issuedAt = new Date(now).toISOString() } = {}) {
  const signature = signInstanceProof(actor, {
    transactionId,
    purpose,
    returnUrl: callback,
    issuedAt,
    audience: 'agentoc-owner-auth',
  });
  return {
    transactionId,
    purpose,
    returnUrl: callback,
    instance: publicInstanceIdentity(actor),
    issuedAt,
    audience: 'agentoc-owner-auth',
    signature: signature.signature,
  };
}

function deviceProofFor({ actor = identity, transactionId = 'op_1', purpose = 'devices', issuedAt = new Date(now).toISOString() } = {}) {
  const signature = signOwnerAuthDeviceProof(actor, {
    transactionId,
    purpose,
    issuedAt,
    audience: 'agentoc-owner-auth-device',
  });
  return {
    transactionId,
    purpose,
    instance: publicInstanceIdentity(actor),
    issuedAt,
    audience: 'agentoc-owner-auth-device',
    signature: signature.signature,
  };
}

let seenNonce = '';
const auditEvents = [];
const signedClaims = [];
const broker = createOwnerAuthBroker({
  store,
  clock: () => now,
  verifyGoogleCredential: async ({ idToken, nonce }) => {
    assert.equal(idToken, 'google-id-token');
    seenNonce = nonce;
    return { providerSubject: 'google-subject-1' };
  },
  resolveAccount: async ({ googleIdentity }) => ({
    accountId: googleIdentity.providerSubject === 'google-subject-1' ? 'acct_owner_1' : '',
  }),
  signAssertion: async (claims) => {
    signedClaims.push(claims);
    return `signed:${claims.sub}:${claims.aud}:${claims.purpose}:${claims.tx}`;
  },
  audit: (event) => auditEvents.push(event),
});

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

try {
  const started = await broker.start({ ...proofFor(), alias: 'Initial office' });
  await check('签名实例可创建 bind 事务', async () => {
    assert.match(started.bootstrap, /^ob_/);
    assert.match(started.expiresAt, /^2026-/);
    assert.equal(state.ownerAuthTransactions.length, 1);
    assert.equal(state.ownerAuthTransactions[0].alias, 'Initial office');
  });

  await check('同一事务不能覆盖', async () => {
    await assert.rejects(() => broker.start(proofFor()), { code: 'owner_auth_transaction_exists' });
  });

  const browser = await broker.beginBrowser({ transactionId: 'tx_1', bootstrap: started.bootstrap, browserState: 'browser_state_1' });
  await check('bootstrap 只可启动一次且产生事务 nonce', async () => {
    assert.match(browser.nonce, /^nonce_/);
    await assert.rejects(
      () => broker.beginBrowser({ transactionId: 'tx_1', bootstrap: started.bootstrap, browserState: 'browser_state_1' }),
      { code: 'owner_auth_browser_replayed' },
    );
  });

  const completed = await broker.completeGoogleCredential({ transactionId: 'tx_1', idToken: 'google-id-token', browserState: 'browser_state_1' });
  await check('Google 身份只在 broker 校验并绑定一次性 grant', async () => {
    assert.equal(seenNonce, browser.nonce);
    assert.equal(completed.returnUrl, returnUrl);
    assert.match(completed.grant, /^grant_/);
    assert.equal(state.ownerAuthTransactions[0].accountId, 'acct_owner_1');
    assert.equal(state.ownerAuthTransactions[0].grantHash.includes(completed.grant), false);
    assert.equal(state.instanceBindings[0].deviceAlias, 'Initial office');
    assert.equal(state.devices[0].alias, 'Initial office');
  });

  const nativeProof = (actor, requestId, deviceId, alias = 'Android') => {
    const issuedAt = new Date(now).toISOString();
    const devicePublicKeyFingerprint = 'a'.repeat(64);
    return {
      requestId,
      purpose: 'native',
      device: { deviceId, alias, devicePublicKeyFingerprint },
      idToken: 'google-id-token',
      issuedAt,
      audience: 'agentoc-owner-auth-native',
      instance: publicInstanceIdentity(actor),
      signature: signNativeOwnerAuthProof(actor, {
        requestId,
        purpose: 'native',
        deviceId,
        devicePublicKeyFingerprint,
        deviceAlias: alias,
        issuedAt,
        audience: 'agentoc-owner-auth-native',
      }).signature,
    };
  };
  const nativeFirst = await broker.completeNativeCredential(nativeProof(nativeIdentity, 'oan_1', 'android-1', 'Pixel'));
  const nativeLastSeenBefore = state.devices.find((item) => item.deviceId === 'android-1').lastSeenAt;
  await check('native assertion 绑定 deviceId（G-10）', async () => {
    const nativeClaims = signedClaims.find((claims) => claims.purpose === 'native' && claims.tx === 'oan_1');
    assert.equal(nativeClaims.deviceId, 'android-1');
    assert.equal(nativeClaims.devicePublicKeyFingerprint, 'a'.repeat(64));
    assert.equal(nativeClaims.sub, 'acct_owner_1');
    assert.equal(nativeClaims.tx, 'oan_1');
    assert.equal(nativeClaims.plan, 'pro');
    assert.deepEqual(nativeClaims.limits, { phones: 5, computers: 10 });
    assert.equal(nativeClaims.deviceKind, 'phone');
  });
  now += 1000;
  const nativeLogin = await broker.completeNativeCredential(nativeProof(nativeIdentity, 'oan_2', 'android-1', 'Pixel'));
  await check('native bind/login 在中央原子收敛并刷新 lastSeen，不新增历史 bind', async () => {
    assert.equal(nativeFirst.deviceState, 'bound');
    assert.equal(nativeLogin.deviceState, 'bound');
    assert.ok(state.devices.find((item) => item.deviceId === 'android-1').lastSeenAt > nativeLastSeenBefore);
    assert.equal(state.bindingHistory.filter((item) => item.action === 'bind').length, 2);
  });
  await check('native requestId 跨设备重放 fail-closed', async () => {
    await assert.rejects(
      () => broker.completeNativeCredential(nativeProof(secondIdentity, 'oan_2', 'android-2', 'Other')),
      { code: 'owner_auth_native_replay' },
    );
  });
  await check('native 成功审计只含稳定操作字段，不含 token/email/name', async () => {
    const event = auditEvents.find((item) => item.event === 'native.owner_auth.completed' && item.requestId === 'oan_2');
    assert.equal(event.result, 'ok');
    assert.equal(event.deviceId, 'android-1');
    assert.equal(event.email, undefined);
    assert.equal(event.name, undefined);
    assert.equal(JSON.stringify(event).includes('google-id-token'), false);
  });

  await check('native 补偿回滚只撤销本次新设备，并允许同 requestId 重试', async () => {
    const rollbackRequest = 'oan_rollback_1';
    await broker.completeNativeCredential(nativeProof(nativeIdentity, rollbackRequest, 'android-rollback', 'Pixel'));
    assert.ok(state.devices.some((item) => item.deviceId === 'android-rollback'));
    const rolledBack = await broker.rollbackNativeCredential(nativeProof(nativeIdentity, rollbackRequest, 'android-rollback', 'Pixel'));
    assert.equal(rolledBack.rolledBack, true);
    assert.equal(state.devices.some((item) => item.deviceId === 'android-rollback'), false);
    await broker.completeNativeCredential(nativeProof(nativeIdentity, rollbackRequest, 'android-rollback', 'Pixel'));
    assert.ok(state.devices.some((item) => item.deviceId === 'android-rollback'));
  });

  await check('不同实例不能兑换同一 grant', async () => {
    await assert.rejects(
      () => broker.redeem({ ...proofFor({ actor: secondIdentity }), grant: completed.grant }),
      { code: 'owner_auth_instance_mismatch' },
    );
  });

  const redeemed = await broker.redeem({ ...proofFor(), grant: completed.grant });
  await check('原实例可兑换短时绑定断言且不可重放', async () => {
    assert.equal(redeemed.assertion, 'signed:acct_owner_1:inst_' + publicInstanceIdentity(identity).instanceId.slice(5) + ':bind:tx_1');
    await assert.rejects(() => broker.redeem({ ...proofFor(), grant: completed.grant }), { code: 'owner_auth_grant_invalid' });
  });

  await check('篡改回跳地址会破坏实例签名', async () => {
    const badProof = proofFor({ transactionId: 'tx_2', callback: 'https://instance.example.test/api/auth/google/complete?tx=tx_2' });
    badProof.returnUrl = 'https://attacker.example.test/callback';
    await assert.rejects(() => broker.start(badProof), { code: 'owner_auth_proof_invalid' });
  });

  const phoneTransactionId = 'tx_phone_1';
  const phoneReturnUrl = `https://instance.example.test/api/auth/google/complete?tx=${phoneTransactionId}`;
  const phoneStarted = await broker.start(proofFor({ transactionId: phoneTransactionId, callback: phoneReturnUrl }));
  const desktopReplay = deriveDesktopReplayValues({
    transactionId: phoneTransactionId,
    bootstrap: phoneStarted.bootstrap,
  });
  const desktop = await broker.beginDesktop({
    transactionId: phoneTransactionId,
    bootstrap: phoneStarted.bootstrap,
    desktopState: desktopReplay.desktopState,
  });
  await check('电脑入口只签发一次手机 ticket 和仅交给该浏览器的 delivery grant', async () => {
    assert.match(desktop.phoneTicket, /^opt_/);
    assert.match(desktop.deliveryGrant, /^grant_/);
    assert.equal(state.ownerAuthTransactions.find((item) => item.id === phoneTransactionId).grantHash.includes(desktop.deliveryGrant), false);
    const replay = await broker.beginDesktop({
      transactionId: phoneTransactionId,
      bootstrap: phoneStarted.bootstrap,
      desktopState: desktopReplay.desktopState,
    });
    assert.equal(replay.phoneTicket, desktop.phoneTicket);
    assert.equal(replay.deliveryGrant, desktop.deliveryGrant);
  });

  const phone = await broker.beginPhone({
    transactionId: phoneTransactionId,
    phoneTicket: desktop.phoneTicket,
    phoneState: 'phone_state_1',
  });
  await check('同一手机状态刷新幂等且其他状态仍不能重放', async () => {
    assert.match(phone.nonce, /^nonce_/);
    const retry = await broker.beginPhone({
      transactionId: phoneTransactionId,
      phoneTicket: desktop.phoneTicket,
      phoneState: 'phone_state_1',
    });
    assert.equal(retry.nonce, phone.nonce);
    await assert.rejects(
      () => broker.beginPhone({ transactionId: phoneTransactionId, phoneTicket: desktop.phoneTicket, phoneState: 'other_phone_state' }),
      { code: 'owner_auth_phone_replayed' },
    );
  });

  now += 10 * 60 * 1000;
  await broker.completePhoneGoogleCredential({
    transactionId: phoneTransactionId,
    phoneState: 'phone_state_1',
    idToken: 'google-id-token',
  });
  await check('手机授权页等待十分钟后仍在 broker 事务有效期内', async () => {
    assert.ok(Date.parse(phoneStarted.expiresAt) > now);
    assert.equal(OWNER_AUTH_TRANSACTION_TTL_MS, 15 * 60 * 1000);
  });
  await check('手机完成 Google 校验后只让持有电脑 state 的浏览器领取结果', async () => {
    await assert.rejects(
      () => broker.getDesktopStatus({ transactionId: phoneTransactionId, desktopState: 'attacker_state' }),
      { code: 'owner_auth_desktop_state_invalid' },
    );
    const status = await broker.getDesktopStatus({ transactionId: phoneTransactionId, desktopState: desktopReplay.desktopState });
    assert.deepEqual(status, {
      status: 'completed', transactionId: phoneTransactionId, returnUrl: phoneReturnUrl, expiresAt: phoneStarted.expiresAt,
    });
    const phoneRedeemed = await broker.redeem({
      ...proofFor({ transactionId: phoneTransactionId, callback: phoneReturnUrl }),
      grant: desktop.deliveryGrant,
    });
    assert.match(phoneRedeemed.assertion, /signed:acct_owner_1:.*:bind:tx_phone_1/);
  });

  // ---------- 设备管理里程碑：bindings / devices / binding-history ----------
  const instanceId = publicInstanceIdentity(identity).instanceId;

  await check('bind 完成记录实例绑定/设备/历史', async () => {
    const binding = state.instanceBindings.find((item) => item.instanceId === instanceId);
    assert.ok(binding, 'bind 后应有实例绑定');
    assert.equal(binding.accountId, 'acct_owner_1');
    assert.equal(binding.provider, 'google');
    assert.ok(binding.boundAt);
    const device = state.devices.find((item) => item.deviceId === instanceId);
    assert.ok(device, 'bind 后应有设备条目');
    assert.ok(device.lastSeenAt);
    assert.equal(state.bindingHistory.filter((item) => item.action === 'bind').length >= 1, true);
  });

  const loginStarted = await broker.start(proofFor({ transactionId: 'tx_login_1', purpose: 'login' }));
  await broker.beginBrowser({ transactionId: 'tx_login_1', bootstrap: loginStarted.bootstrap, browserState: 'login_browser_state' });
  const lastSeenBefore = state.devices.find((item) => item.deviceId === instanceId).lastSeenAt;
  const bindingCountBeforeLogin = state.bindingHistory.filter((item) => item.action === 'bind').length;
  await broker.completeGoogleCredential({ transactionId: 'tx_login_1', idToken: 'google-id-token', browserState: 'login_browser_state' });
  await check('login 完成只刷新设备 lastSeenAt 不新增历史', async () => {
    const device = state.devices.find((item) => item.deviceId === instanceId);
    assert.ok(device.lastSeenAt >= lastSeenBefore);
    assert.equal(state.bindingHistory.filter((item) => item.action === 'bind').length, bindingCountBeforeLogin);
  });

  await check('错误账号解绑被拒', async () => {
    await assert.rejects(
      () => broker.unbindInstance({
        ...deviceProofFor({ transactionId: 'op_unbind_wrong', purpose: 'unbind' }),
        accountId: 'acct_owner_other',
      }),
      { code: 'owner_auth_instance_mismatch' },
    );
  });

  let unboundAt = '';
  await check('unbindInstance 撤销绑定并追加历史', async () => {
    now += 60 * 1000;
    const result = await broker.unbindInstance({
      ...deviceProofFor({ transactionId: 'op_unbind_1', purpose: 'unbind' }),
      accountId: 'acct_owner_1',
    });
    unboundAt = result.unboundAt;
    assert.ok(result.unboundAt);
    assert.equal(state.instanceBindings.some((item) => item.instanceId === instanceId), false);
    assert.equal(state.devices.some((item) => item.instanceId === instanceId), false);
  });

  await check('重复解绑返回 404', async () => {
    await assert.rejects(
      () => broker.unbindInstance({
        ...deviceProofFor({ transactionId: 'op_unbind_2', purpose: 'unbind' }),
        accountId: 'acct_owner_1',
      }),
      { code: 'owner_auth_binding_missing' },
    );
  });

  await check('重绑携带设备别名', async () => {
    now += 60 * 1000;
    const rebind = await broker.start({ ...proofFor({ transactionId: 'tx_rebind_1', callback: returnUrl }), alias: '客厅电脑' });
    await broker.beginBrowser({ transactionId: 'tx_rebind_1', bootstrap: rebind.bootstrap, browserState: 'rebind_state' });
    await broker.completeGoogleCredential({ transactionId: 'tx_rebind_1', idToken: 'google-id-token', browserState: 'rebind_state' });
    const binding = state.instanceBindings.find((item) => item.instanceId === instanceId);
    assert.equal(binding.deviceAlias, '客厅电脑');
    assert.equal(state.devices.find((item) => item.deviceId === instanceId).alias, '客厅电脑');
  });

  const endpoint = 'https://instance.example.test';
  const endpointIssuedAt = new Date(now).toISOString();
  const endpointProof = signOwnerAuthDeviceProof(identity, {
    transactionId: 'op_endpoint_1',
    purpose: 'publish-endpoint',
    publicEndpoint: endpoint,
    issuedAt: endpointIssuedAt,
    audience: 'agentoc-owner-auth-device',
  });
  const endpointPublished = await broker.publishInstanceEndpoint({
    transactionId: 'op_endpoint_1',
    purpose: 'publish-endpoint',
    accountId: 'acct_owner_1',
    publicEndpoint: endpoint,
    instance: publicInstanceIdentity(identity),
    issuedAt: endpointIssuedAt,
    audience: 'agentoc-owner-auth-device',
    signature: endpointProof.signature,
  });
  await check('已绑定实例可用签名 proof 发布自己的公网控制 endpoint', async () => {
    assert.equal(endpointPublished.publicEndpoint, endpoint);
    assert.equal(state.instanceBindings.find((item) => item.instanceId === instanceId).publicEndpoint, endpoint);
    assert.equal(state.devices.find((item) => item.deviceId === instanceId).deviceKind, 'computer');
  });
  await check('已绑定实例可在无公网地址时单独发布 rendezvous 身份', async () => {
    const identityIssuedAt = new Date(now).toISOString();
    const identityProof = signOwnerAuthDeviceProof(identity, {
      transactionId: 'op_identity_1',
      purpose: 'publish-identity',
      issuedAt: identityIssuedAt,
      audience: 'agentoc-owner-auth-device',
    });
    const identityPublished = await broker.publishInstanceIdentity({
      transactionId: 'op_identity_1',
      purpose: 'publish-identity',
      accountId: 'acct_owner_1',
      instance: publicInstanceIdentity(identity),
      issuedAt: identityIssuedAt,
      audience: 'agentoc-owner-auth-device',
      signature: identityProof.signature,
    });
    assert.equal(identityPublished.instancePublicKey, publicInstanceIdentity(identity).publicKey.trim());
    assert.equal(identityPublished.instanceKeyFingerprint, identity.keyFingerprint);
  });
  await check('endpoint 在签名后被篡改会被拒绝，其他实例不能覆盖绑定', async () => {
    await assert.rejects(
      () => broker.publishInstanceEndpoint({
        transactionId: 'op_endpoint_tampered',
        purpose: 'publish-endpoint',
        accountId: 'acct_owner_1',
        publicEndpoint: 'https://attacker.example.test',
        instance: publicInstanceIdentity(identity),
        issuedAt: endpointIssuedAt,
        audience: 'agentoc-owner-auth-device',
        signature: endpointProof.signature,
      }),
      { code: 'owner_auth_proof_invalid' },
    );
    const otherProof = signOwnerAuthDeviceProof(secondIdentity, {
      transactionId: 'op_endpoint_other',
      purpose: 'publish-endpoint',
      publicEndpoint: 'https://other.example.test',
      issuedAt: endpointIssuedAt,
      audience: 'agentoc-owner-auth-device',
    });
    await assert.rejects(
      () => broker.publishInstanceEndpoint({
        transactionId: 'op_endpoint_other',
        purpose: 'publish-endpoint',
        accountId: 'acct_owner_1',
        publicEndpoint: 'https://other.example.test',
        instance: publicInstanceIdentity(secondIdentity),
        issuedAt: endpointIssuedAt,
        audience: 'agentoc-owner-auth-device',
        signature: otherProof.signature,
      }),
      { code: 'owner_auth_instance_mismatch' },
    );
  });

  await check('签名inbox每次验证身份，电脑活动时间按五分钟持久化', async () => {
    const binding = state.instanceBindings.find((item) => item.instanceId === instanceId);
    const device = state.devices.find((item) => item.deviceId === instanceId);
    const previousBindingLastSeenAt = binding.lastSeenAt;
    const previousDeviceLastSeenAt = device.lastSeenAt;
    async function poll() {
      const issuedAt = new Date(now).toISOString();
      const proof = signAccountRendezvousPollProof(identity, { requestId: 'inbox', issuedAt, audience: 'agentoc-account-rendezvous-poll' });
      assert.deepEqual(await broker.pollAccountRendezvousInbox({ requestId: 'inbox', issuedAt,
        audience: 'agentoc-account-rendezvous-poll', instance: publicInstanceIdentity(identity), signature: proof.signature }), { intent: null, grant: null });
    }
    now += 60_000; await poll();
    assert.equal(binding.lastSeenAt, previousBindingLastSeenAt);
    assert.equal(device.lastSeenAt, previousDeviceLastSeenAt);
    now += 4 * 60_000; await poll();
    assert.ok(binding.lastSeenAt > previousBindingLastSeenAt);
    assert.ok(device.lastSeenAt > previousDeviceLastSeenAt);
    const directory = await broker.discoverInstances({ idToken: 'google-id-token' });
    assert.equal(directory.instances.find((item) => item.instanceId === instanceId).lastSeenAt, binding.lastSeenAt);
  });
  await check('同账号发现返回控制面 endpoint，但不返回传输路由', async () => {
    const endpointlessInstance = publicInstanceIdentity(endpointlessIdentity);
    const discoverableInstance = publicInstanceIdentity(discoverableIdentity);
    state.instanceBindings.push({
      instanceId: endpointlessInstance.instanceId,
      accountId: 'acct_owner_1',
      provider: 'google',
      deviceAlias: '内网电脑',
      instancePublicKey: endpointlessInstance.publicKey,
      instanceKeyFingerprint: endpointlessInstance.keyFingerprint,
      boundAt: new Date(now).toISOString(),
      revokedAt: '',
    });
    state.instanceBindings.push({
      instanceId: discoverableInstance.instanceId,
      accountId: 'acct_owner_1',
      provider: 'google',
      deviceAlias: '公网电脑',
      publicEndpoint: 'https://instance.example.test',
      instancePublicKey: discoverableInstance.publicKey,
      instanceKeyFingerprint: discoverableInstance.keyFingerprint,
      boundAt: new Date(now).toISOString(),
      revokedAt: '',
    });
    state.instanceBindings.push({
      instanceId: 'inst_other_account',
      accountId: 'acct_owner_2',
      provider: 'google',
      deviceAlias: '别人的电脑',
      boundAt: new Date(now).toISOString(),
      revokedAt: '',
    });
    state.instanceBindings.push({
      instanceId: 'inst_revoked_same_account',
      accountId: 'acct_owner_1',
      provider: 'google',
      deviceAlias: '已撤销电脑',
      boundAt: new Date(now).toISOString(),
      revokedAt: new Date(now).toISOString(),
    });
    const { instances } = await broker.discoverInstances({ idToken: 'google-id-token' });
    const discovered = instances.find((item) => item.instanceId === instanceId);
    assert.ok(discovered);
    assert.equal(discovered.endpoint, 'https://instance.example.test');
    assert.equal(discovered.canTakeOver, true);
    assert.equal(discovered.instancePublicKey, publicInstanceIdentity(identity).publicKey.trim());
    assert.equal(discovered.instanceKeyFingerprint, identity.keyFingerprint);
    assert.equal('relay' in discovered, false);
    const noEndpoint = instances.find((item) => item.instanceId === endpointlessInstance.instanceId);
    assert.ok(noEndpoint);
    assert.equal(noEndpoint.endpoint, null);
    assert.equal(noEndpoint.canTakeOver, true);
    assert.equal(noEndpoint.instancePublicKey, endpointlessInstance.publicKey);
    assert.equal(noEndpoint.instanceKeyFingerprint, endpointlessInstance.keyFingerprint);
    assert.equal(instances.some((item) => item.instanceId === discoverableInstance.instanceId), true);
    assert.equal(instances.some((item) => item.instanceId === 'inst_other_account'), false);
    assert.equal(instances.some((item) => item.instanceId === 'inst_revoked_same_account'), false);
  });

  await check('listDevices 返回该账号设备清单并过滤其他账号', async () => {
    state.devices.push({
      deviceId: 'other-dev-001',
      instanceId: 'other-inst-001',
      accountId: 'acct_owner_2',
      alias: '别人的设备',
      lastSeenAt: new Date(now).toISOString(),
      unboundAt: '',
      createdAt: new Date(now).toISOString(),
    });
    const { devices } = await broker.listDevices({
      ...deviceProofFor({ transactionId: 'op_devices_1', purpose: 'devices' }),
      accountId: 'acct_owner_1',
    });
    assert.equal(devices.some((device) => device.deviceId === instanceId && device.source === 'local' && device.sub === 'acct_owner_1'), true);
    assert.equal(devices.some((device) => device.deviceId === 'other-dev-001'), false);
  });

  await check('account session directory returns only its authoritative device rows', async () => {
    const accountDeviceId = 'adev_directory_phone_1';
    const normalizedKey = normalizeDevicePublicKey(nativeIdentity.publicKey);
    const credential = `rac_${'a'.repeat(40)}`;
    const issuedAt = new Date(now).toISOString();
    state.accountDevices = [{
      deviceId: accountDeviceId,
      accountId: 'acct_owner_1',
      alias: 'Pixel',
      platform: 'android',
      createdAt: issuedAt,
      lastSeenAt: issuedAt,
      revokedAt: '',
    }, {
      deviceId: 'adev_directory_expired_phone',
      accountId: 'acct_owner_1',
      alias: 'Expired installation',
      platform: 'android',
      createdAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      lastSeenAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: '',
    }, {
      deviceId: 'adev_directory_unrefreshable_phone',
      accountId: 'acct_owner_1',
      alias: 'Unrefreshable installation',
      platform: 'android',
      createdAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      lastSeenAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: '',
    }];
    state.accountDeviceKeys = [{
      keyId: normalizedKey.keyId,
      accountId: 'acct_owner_1',
      deviceId: accountDeviceId,
      publicKey: normalizedKey.publicKey,
      fingerprint: createDevicePublicKeyFingerprint(normalizedKey.publicKey),
      createdAt: issuedAt,
      revokedAt: '',
    }, {
      keyId: 'key_expired_directory_phone',
      accountId: 'acct_owner_1',
      deviceId: 'adev_directory_expired_phone',
      publicKey: normalizedKey.publicKey,
      fingerprint: 'expired-device-fingerprint',
      createdAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: '',
    }, {
      keyId: 'key_unrefreshable_directory_phone',
      accountId: 'acct_owner_1',
      deviceId: 'adev_directory_unrefreshable_phone',
      publicKey: normalizedKey.publicKey,
      fingerprint: 'unrefreshable-device-fingerprint',
      createdAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: '',
    }];
    state.accountCredentials = [{
      credentialId: 'racid_directory_phone_1',
      tokenHash: createHash('sha256').update(credential).digest('hex'),
      accountId: 'acct_owner_1',
      deviceId: accountDeviceId,
      keyId: normalizedKey.keyId,
      scope: 'account-directory',
      issuedAt,
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
      revokedAt: '',
    }, {
      credentialId: 'racid_directory_expired_phone',
      tokenHash: createHash('sha256').update('rac_expired_directory_phone').digest('hex'),
      accountId: 'acct_owner_1',
      deviceId: 'adev_directory_expired_phone',
      keyId: 'key_expired_directory_phone',
      scope: 'account-directory',
      issuedAt: new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(now - 12 * 60 * 60 * 1000).toISOString(),
      revokedAt: '',
    }, {
      credentialId: 'racid_directory_unrefreshable_phone',
      tokenHash: createHash('sha256').update('rac_unrefreshable_directory_phone').digest('hex'),
      accountId: 'acct_owner_1',
      deviceId: 'adev_directory_unrefreshable_phone',
      keyId: 'key_unrefreshable_directory_phone',
      scope: 'account-directory',
      issuedAt: new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
      revokedAt: '',
    }];

    const directory = await broker.listAccountDirectoryDevices({ credential });

    assert.equal(directory.devices.some((device) => device.deviceId === instanceId), true);
    assert.equal(directory.devices.some((device) => device.deviceId === 'other-dev-001'), false);
    assert.equal(directory.devices.some((device) => Object.hasOwn(device, 'source')), false);
    assert.equal(directory.devices.some((device) => device.deviceId === 'adev_directory_expired_phone'), false,
      'An expired phone login is history, not a currently logged-in account device');
    assert.equal(state.accountDevices.some((device) => device.deviceId === 'adev_directory_expired_phone'), true,
      'Keep an expired phone during the signed credential recovery window');
    assert.equal(state.accountDevices.some((device) => device.deviceId === 'adev_directory_unrefreshable_phone'), false,
      'Remove a phone after its signed session can no longer be recovered');
    assert.equal(state.accountDeviceKeys.some((key) => key.keyId === 'key_unrefreshable_directory_phone'), false);
    assert.equal(state.accountCredentials.some((item) => item.credentialId === 'racid_directory_unrefreshable_phone'), false);
    assert.equal(directory.quota.registeredPhones, 1);
  });

  await check('listBindingHistory 返回按时间倒序的历史', async () => {
    const { entries } = await broker.listBindingHistory({
      ...deviceProofFor({ transactionId: 'op_history_1', purpose: 'history' }),
      accountId: 'acct_owner_1',
    });
    assert.equal(entries.length, state.bindingHistory.filter((item) => item.accountId === 'acct_owner_1').length);
    assert.equal(entries[0].action, 'bind');
    assert.equal(entries[1].action, 'unbind');
    assert.ok(Date.parse(entries[0].occurredAt) >= Date.parse(entries[1].occurredAt));
  });

  await check('未绑定实例不能查询设备', async () => {
    await assert.rejects(
      () => broker.listDevices({
        ...deviceProofFor({ actor: secondIdentity, transactionId: 'op_devices_2', purpose: 'devices' }),
        accountId: 'acct_owner_1',
      }),
      { code: 'owner_auth_instance_mismatch' },
    );
  });

  await check('免费档不限制已登录设备，连接配额单独计算', async () => {
    state.accountEntitlements[0].plan = 'free';
    const quotaTransactionId = 'tx_quota_computer_1';
    const quotaReturnUrl = `https://instance.example.test/api/auth/google/complete?tx=${quotaTransactionId}`;
    const quotaStarted = await broker.start(proofFor({
      actor: quotaIdentity,
      transactionId: quotaTransactionId,
      callback: quotaReturnUrl,
    }));
    await broker.beginBrowser({
      transactionId: quotaTransactionId,
      bootstrap: quotaStarted.bootstrap,
      browserState: 'quota-browser-state',
    });
    const completedQuota = await broker.completeGoogleCredential({
      transactionId: quotaTransactionId,
      idToken: 'google-id-token',
      browserState: 'quota-browser-state',
    });
    assert.ok(completedQuota.grant);
    const quota = await broker.listDevices({
      ...deviceProofFor({ transactionId: 'op_devices_quota', purpose: 'devices' }),
      accountId: 'acct_owner_1',
    });
    assert.equal(quota.quota.plan, 'free');
    assert.equal(quota.quota.grandfathered, false);
    assert.ok(quota.quota.registeredComputers >= 2);
    assert.equal(quota.quota.activePhones, 0);
    assert.equal(quota.quota.activeComputers, 0);
    assert.ok(quota.devices.some((device) => device.instanceId === quotaIdentity.instanceId));
  });

  const expiryId = 'tx_exact_lifetime_boundary';
  const expiryCallback = `https://instance.example.test/api/auth/google/complete?tx=${expiryId}`;
  const expiryStarted = await broker.start(proofFor({ transactionId: expiryId, callback: expiryCallback }));
  await broker.beginBrowser({ transactionId: expiryId, bootstrap: expiryStarted.bootstrap, browserState: 'expiry-browser-state' });
  now = Date.parse(expiryStarted.expiresAt);
  await check('新的未使用授权事务在十五分钟边界拒绝 Google 完成', async () => {
    await assert.rejects(broker.completeGoogleCredential({ transactionId: expiryId,
      idToken: 'google-id-token', browserState: 'expiry-browser-state' }), { code: 'owner_auth_transaction_invalid', statusCode: 410 });
  });
  const oldId = 'tx_persisted_five_minute_deadline';
  const oldStarted = await broker.start(proofFor({ transactionId: oldId,
    callback: `https://instance.example.test/api/auth/google/complete?tx=${oldId}` }));
  // Model a transaction created by the previous release. Raising the default
  // must not extend its already published five-minute deadline.
  state.ownerAuthTransactions.find((entry) => entry.id === oldId).expiresAt = new Date(now + 5 * 60 * 1000).toISOString();
  now += 6 * 60 * 1000;
  await check('升级后不会重新激活旧五分钟期限的授权事务', async () => {
    await assert.rejects(broker.beginBrowser({ transactionId: oldId, bootstrap: oldStarted.bootstrap,
      browserState: 'old-window-state' }), { code: 'owner_auth_transaction_invalid', statusCode: 410 });
  });
  await check('过期事务拒绝兑换', async () => {
    await assert.rejects(() => broker.redeem({ ...proofFor(), grant: completed.grant }), { code: 'owner_auth_grant_invalid' });
  });

  console.log(`test-owner-auth-broker: ${passed} assertions passed`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
