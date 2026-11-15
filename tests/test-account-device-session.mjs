#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const releaseRoot = resolve(process.argv[2] || '.');
const { createOwnerAuthBroker } = await import(pathToFileURL(resolve(releaseRoot, 'accounts/owner-auth-broker.mjs')));
const {
  buildAccountCredentialRefreshMessage,
  buildAccountJoinIntentMessage,
  buildAccountSessionMessage,
  createDevicePublicKeyFingerprint,
} = await import(pathToFileURL(resolve(releaseRoot, 'lib/device-auth-protocol.mjs')));
const {
  buildAccountJoinIntentProofMessage,
  createInstancePublicKeyFingerprint,
} = await import(pathToFileURL(resolve(releaseRoot, 'lib/instance-proof-protocol.mjs')));

const deviceKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const devicePublicKey = deviceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const deviceFingerprint = createDevicePublicKeyFingerprint(devicePublicKey);
const instanceKeys = generateKeyPairSync('ed25519');
const instancePublicKey = instanceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const instanceId = 'inst_account_session_target';
const instanceFingerprint = createInstancePublicKeyFingerprint(instancePublicKey);
const accountId = 'acct_account_session_owner';
// An Android installation has one account-level adev_, while each computer
// creates its own target-local rdev_ for that installation.
const accountDeviceId = 'adev_account_session_pixel';
const targetDeviceId = 'rdev_account_session_office';
let nativeGoogleCalls = 0;
let now = Date.parse('2026-08-25T07:00:00.000Z');
const state = {
  instanceBindings: [{
    instanceId, accountId, provider: 'google', deviceAlias: 'Office PC', publicEndpoint: 'https://office.example.test',
    boundAt: new Date(now).toISOString(), revokedAt: '',
  }],
};
const store = { mutate: async (mutator) => mutator(state) };
const broker = createOwnerAuthBroker({
  store,
  clock: () => now,
  verifyGoogleCredential: async () => ({ providerSubject: 'google-owner' }),
  verifyNativeGoogleCredential: async ({ idToken, nonce }) => {
    nativeGoogleCalls++;
    assert.equal(idToken, 'native-google-token');
    assert.match(nonce, /^nonce_/);
    return { providerSubject: 'google-owner' };
  },
  resolveAccount: async () => ({ accountId }),
  signAssertion: async (claims) => `assertion:${claims.sub}:${claims.aud}:${claims.tx}`,
});

function deviceSign(message) {
  return cryptoSign('sha256', Buffer.from(message, 'utf8'), deviceKeys.privateKey).toString('base64');
}

function instanceSign(message) {
  return cryptoSign(null, Buffer.from(message, 'utf8'), instanceKeys.privateKey).toString('base64url');
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const challengeRequest = {
  requestId: 'session-challenge-request-0001',
  device: { deviceId: accountDeviceId, publicKey: devicePublicKey, alias: 'Pixel', platform: 'android' },
};

const challenge = await broker.createAccountSessionChallenge(challengeRequest);
await check('账号会话 challenge 保存规范化公钥和一次性 nonce', async () => {
  assert.equal(challenge.contractVersion, 2);
  assert.match(challenge.transactionId, /^oasc_/);
  assert.match(challenge.nonce, /^nonce_/);
  assert.equal(state.accountSessionChallenges[0].publicKeyFingerprint, deviceFingerprint);
  assert.equal(state.accountSessionChallenges[0].nonce, challenge.nonce);
});

const sessionSignature = deviceSign(buildAccountSessionMessage({
  transactionId: challenge.transactionId,
  requestId: challengeRequest.requestId,
  deviceId: accountDeviceId,
  publicKeyFingerprint: deviceFingerprint,
  nonce: challenge.nonce,
}));
await check('session challenge 要求登记设备私钥的精确签名', async () => {
  await assert.rejects(
    () => broker.completeAccountSession({
      transactionId: challenge.transactionId,
      requestId: challengeRequest.requestId,
      idToken: 'native-google-token',
      signature: 'tampered',
    }),
    { code: 'owner_auth_account_session_signature_invalid' },
  );
  assert.equal(state.accountCredentials, undefined);
});
const session = await broker.completeAccountSession({
  transactionId: challenge.transactionId,
  requestId: challengeRequest.requestId,
  idToken: 'native-google-token',
  signature: sessionSignature,
});
const firstRac = session.credential.token;

await check('Google 只参与首次交换，Accounts 仅保存 rac 哈希和账号级设备键', async () => {
  assert.match(firstRac, /^rac_/);
  assert.equal(session.credential.scope, 'account-directory');
  assert.equal(state.accountDevices.length, 1);
  assert.equal(state.accountDeviceKeys[0].publicKey, devicePublicKey);
  assert.equal(state.accountCredentials[0].tokenHash.includes(firstRac), false);
  assert.equal(JSON.stringify(state).includes('native-google-token'), false);
  assert.equal(state.devices, undefined, 'v2 phone must not use target-coupled devices table');
});

await check('同一手机可取回丢失的响应，但不会再次签发账号凭据', async () => {
  const recovered = await broker.completeAccountSession({
      transactionId: challenge.transactionId, requestId: challengeRequest.requestId,
      idToken: 'native-google-token', signature: sessionSignature,
    });
  assert.deepEqual(recovered, session);
  assert.equal(state.accountCredentials.length, 1);
  assert.equal(JSON.stringify(state).includes(firstRac), false, 'delivery recovery never persists the raw RAC');
});

const discovered = await broker.discoverInstances({}, { credential: firstRac });
await check('rac_ Bearer 可发现账号电脑，混用 Google credential 被拒绝', async () => {
  assert.equal(discovered.contractVersion, 2);
  assert.equal(discovered.instances[0].instanceId, instanceId);
  assert.deepEqual(discovered.quota, {
    plan: 'free',
    limits: { phones: 1, computers: 1 },
    activeComputers: 0,
  });
  await assert.rejects(
    () => broker.discoverInstances({ idToken: 'native-google-token' }, { credential: firstRac }),
    { code: 'owner_auth_credential_mode_conflict' },
  );
});

const refreshInput = {
  credentialId: session.credential.credentialId,
  deviceId: accountDeviceId,
  requestId: 'session-refresh-request-0001',
  issuedAt: new Date(now).toISOString(),
  nonce: 'refresh-nonce-000000000001',
};
const refreshed = await broker.refreshAccountSession({
  ...refreshInput,
  signature: deviceSign(buildAccountCredentialRefreshMessage(refreshInput)),
});
const secondRac = refreshed.credential.token;

await check('Keystore key 可无 GMS 轮换 rac_，旧 bearer 与 refresh 重放都失败', async () => {
  assert.notEqual(secondRac, firstRac);
  await assert.rejects(() => broker.discoverInstances({}, { credential: firstRac }), {
    code: 'owner_auth_account_credential_expired',
  });
  assert.equal((await broker.discoverInstances({}, { credential: secondRac })).instances.length, 1);
  await assert.rejects(
    () => broker.refreshAccountSession({
      ...refreshInput,
      signature: deviceSign(buildAccountCredentialRefreshMessage(refreshInput)),
    }),
    { code: 'owner_auth_account_refresh_replayed' },
  );
});

const joinIntentId = 'rji_account_session_target_0001';
const joinNonce = 'join-nonce-000000000000001';
const joinIssuedAt = new Date(now).toISOString();
state.accountJoinIntents = [{
  intentId: joinIntentId,
  instanceId,
  instance: { instanceId, publicKey: instancePublicKey, keyFingerprint: instanceFingerprint },
  deviceId: targetDeviceId,
  devicePublicKey,
  devicePublicKeyFingerprint: deviceFingerprint,
  deviceAlias: 'Pixel', platform: 'android', nonceHash: (await import('node:crypto')).createHash('sha256').update(joinNonce).digest('hex'),
  issuedAt: joinIssuedAt, createdAt: joinIssuedAt, expiresAt: new Date(now + 120000).toISOString(),
  status: 'pending', accountId: '', completionRequestId: '', completedAt: '',
}];
const joinDeviceSignature = deviceSign(buildAccountJoinIntentMessage({
  instanceId, intentId: joinIntentId, deviceId: targetDeviceId, devicePublicKeyFingerprint: deviceFingerprint,
  nonce: joinNonce, issuedAt: joinIssuedAt, audience: 'ragent-account-join',
}));
const granted = await broker.authorizeAccountJoinIntent({
  intentId: joinIntentId,
  requestId: 'account-join-authorize-request-0001',
  deviceId: targetDeviceId,
  devicePublicKeyFingerprint: deviceFingerprint,
  nonce: joinNonce,
  issuedAt: joinIssuedAt,
  deviceSignature: joinDeviceSignature,
}, { credential: secondRac });

await check('rac_ 只能在 Accounts 换取绑定目标电脑的一次性 grant', async () => {
  assert.match(granted.accountJoinGrant, /^rajg_/);
  assert.equal(state.accountJoinGrants[0].grantHash.includes(granted.accountJoinGrant), false);
  assert.equal(state.accountJoinGrants[0].instanceId, instanceId);
  assert.equal(state.accountJoinGrants[0].accountDeviceId, accountDeviceId);
  assert.equal(state.accountJoinGrants[0].deviceId, targetDeviceId);
});

const targetProofIssuedAt = new Date(now).toISOString();
const targetProof = instanceSign(buildAccountJoinIntentProofMessage({
  instanceId, intentId: joinIntentId, deviceId: targetDeviceId, devicePublicKeyFingerprint: deviceFingerprint,
  nonce: joinNonce, issuedAt: targetProofIssuedAt, audience: 'ragent-account-join',
}));
const joined = await broker.completeAccountJoinIntent({
  intentId: joinIntentId,
  requestId: 'account-join-complete-request-0001',
  nonce: joinNonce,
  deviceIssuedAt: joinIssuedAt,
  device: { deviceId: targetDeviceId, devicePublicKeyFingerprint: deviceFingerprint },
  deviceSignature: joinDeviceSignature,
  accountJoinGrant: granted.accountJoinGrant,
  issuedAt: targetProofIssuedAt,
  audience: 'ragent-account-join',
  instance: { instanceId, publicKey: instancePublicKey, keyFingerprint: instanceFingerprint },
  signature: targetProof,
});

await check('目标电脑只兑换 grant 并签发目标断言，不获得 rac_', async () => {
  assert.match(joined.assertion, new RegExp(`assertion:${accountId}:${instanceId}:account-join-complete-request-0001`));
  assert.ok(state.accountJoinGrants[0].redeemedAt);
  assert.equal(state.devices.length, 0, 'grant completion must not create target-coupled Accounts device rows');
});

// A separately scanned, initially unbound computer carries a distinct
// instance identity and target-local rdev_.  The same account adev_ key may
// explicitly claim it, but it may not transfer an already bound instance.
const claimInstanceKeys = generateKeyPairSync('ed25519');
const claimInstancePublicKey = claimInstanceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const claimInstanceId = `inst_${createInstancePublicKeyFingerprint(claimInstancePublicKey).slice(0, 32)}`;
const claimInstanceFingerprint = createInstancePublicKeyFingerprint(claimInstancePublicKey);
const claimIntentId = 'rji_account_session_new_computer_0001';
const claimTargetDeviceId = 'rdev_account_session_new_computer';
const claimNonce = 'join-nonce-new-computer-000001';
const claimEndpoint = 'https://new-pc.example.test';
const claimIssuedAt = new Date(now).toISOString();
const claimDeviceSignature = deviceSign(buildAccountJoinIntentMessage({
  instanceId: claimInstanceId,
  intentId: claimIntentId,
  deviceId: claimTargetDeviceId,
  devicePublicKeyFingerprint: deviceFingerprint,
  nonce: claimNonce,
  issuedAt: claimIssuedAt,
  audience: 'ragent-account-join',
}));
state.accountJoinIntents.push({
  intentId: claimIntentId,
  instanceId: claimInstanceId,
  instance: { instanceId: claimInstanceId, publicKey: claimInstancePublicKey, keyFingerprint: claimInstanceFingerprint },
  deviceId: claimTargetDeviceId,
  devicePublicKey,
  devicePublicKeyFingerprint: deviceFingerprint,
  deviceAlias: 'Pixel',
  platform: 'android',
  publicEndpoint: claimEndpoint,
  nonceHash: (await import('node:crypto')).createHash('sha256').update(claimNonce).digest('hex'),
  issuedAt: claimIssuedAt,
  createdAt: claimIssuedAt,
  expiresAt: new Date(now + 120000).toISOString(),
  status: 'pending', accountId: '', completionRequestId: '', completedAt: '',
});
const googleCallsBeforeClaim = nativeGoogleCalls;
const claimGrant = await broker.authorizeAccountJoinIntent({
  intentId: claimIntentId,
  requestId: 'account-join-authorize-new-computer-0001',
  deviceId: claimTargetDeviceId,
  devicePublicKeyFingerprint: deviceFingerprint,
  nonce: claimNonce,
  issuedAt: claimIssuedAt,
  deviceSignature: claimDeviceSignature,
}, { credential: secondRac });
const claimProofIssuedAt = new Date(now).toISOString();
const claimProof = cryptoSign(null, Buffer.from(buildAccountJoinIntentProofMessage({
  instanceId: claimInstanceId,
  intentId: claimIntentId,
  deviceId: claimTargetDeviceId,
  devicePublicKeyFingerprint: deviceFingerprint,
  nonce: claimNonce,
  issuedAt: claimProofIssuedAt,
  audience: 'ragent-account-join',
  publicEndpoint: claimEndpoint,
}), 'utf8'), claimInstanceKeys.privateKey).toString('base64url');
const claimed = await broker.completeAccountJoinIntent({
  intentId: claimIntentId,
  requestId: 'account-join-complete-new-computer-0001',
  nonce: claimNonce,
  deviceIssuedAt: claimIssuedAt,
  device: { deviceId: claimTargetDeviceId, devicePublicKeyFingerprint: deviceFingerprint },
  deviceSignature: claimDeviceSignature,
  accountJoinGrant: claimGrant.accountJoinGrant,
  publicEndpoint: claimEndpoint,
  issuedAt: claimProofIssuedAt,
  audience: 'ragent-account-join',
  instance: { instanceId: claimInstanceId, publicKey: claimInstancePublicKey, keyFingerprint: claimInstanceFingerprint },
  signature: claimProof,
});

await check('已扫码的未绑定电脑只能用 grant 认领，并创建可发现的账号绑定', async () => {
  assert.equal(claimed.accountId, accountId);
  assert.equal(nativeGoogleCalls, googleCallsBeforeClaim, 'signed-in phone authorizes an unbound computer without another Google login');
  assert.equal(JSON.stringify(claimed).includes(secondRac), false, 'phone RAC must not be copied to the computer');
  const binding = state.instanceBindings.find((item) => item.instanceId === claimInstanceId);
  assert.equal(binding.accountId, accountId);
  assert.equal(binding.publicEndpoint, claimEndpoint);
  assert.equal(state.devices.find((item) => item.deviceId === claimInstanceId)?.deviceKind, 'computer');
  const storedGrant = state.accountJoinGrants.find((item) => item.intentId === claimIntentId);
  assert.equal(storedGrant.accountDeviceId, accountDeviceId);
  assert.equal(storedGrant.deviceId, claimTargetDeviceId);
  assert.equal(storedGrant.claimInstance, true);
  const directory = await broker.discoverInstances({}, { credential: secondRac });
  assert.equal(directory.instances.find((item) => item.instanceId === claimInstanceId)?.endpoint, claimEndpoint);
});

// Explicit unlinking ends the old binding generation. Only a fresh QR and
// newly signed authorization may enroll the same account/key again.
const reenrollBinding = state.instanceBindings.find((item) => item.instanceId === claimInstanceId);
now += 1000;
reenrollBinding.revokedAt = new Date(now).toISOString();
const revokedAt = now;
function reenrollment(suffix, overrides = {}) {
  const intentId = `rji_reenrollment_${suffix}`;
  const nonce = `reenrollment_nonce_${suffix}`;
  const issuedAt = new Date(now).toISOString();
  const instance = { instanceId: claimInstanceId, publicKey: claimInstancePublicKey, keyFingerprint: claimInstanceFingerprint };
  const intent = { ...structuredClone(state.accountJoinIntents.find((item) => item.intentId === claimIntentId)),
    intentId,
    issuedAt, createdAt: issuedAt, expiresAt: new Date(now + 120000).toISOString(),
    status: 'pending', accountId: '', completionRequestId: '', completedAt: '',
    accountClaimTokenHash: 'a'.repeat(64), ...overrides };
  // Keep the fresh nonce's hash and proof coupled exactly as production does.
  intent.nonceHash = createHash('sha256').update(nonce).digest('hex');
  state.accountJoinIntents.push(intent);
  const signature = deviceSign(buildAccountJoinIntentMessage({ instanceId: claimInstanceId, intentId,
    deviceId: claimTargetDeviceId, devicePublicKeyFingerprint: deviceFingerprint, nonce, issuedAt,
    audience: 'ragent-account-join' }));
  return { intent, authorize: { intentId, requestId: `authorize_reenrollment_${suffix}`, deviceId: claimTargetDeviceId,
    devicePublicKeyFingerprint: deviceFingerprint, nonce, issuedAt, deviceSignature: signature },
  complete(grant) {
    const proofIssuedAt = new Date(now).toISOString();
    return { intentId, requestId: `complete_reenrollment_${suffix}`, nonce, deviceIssuedAt: issuedAt,
      device: { deviceId: claimTargetDeviceId, devicePublicKeyFingerprint: deviceFingerprint }, deviceSignature: signature,
      accountJoinGrant: grant.accountJoinGrant, publicEndpoint: claimEndpoint, issuedAt: proofIssuedAt,
      audience: 'ragent-account-join', instance,
      signature: cryptoSign(null, Buffer.from(buildAccountJoinIntentProofMessage({ instanceId: claimInstanceId,
        intentId, deviceId: claimTargetDeviceId, devicePublicKeyFingerprint: deviceFingerprint, nonce,
        issuedAt: proofIssuedAt, audience: 'ragent-account-join', publicEndpoint: claimEndpoint })), claimInstanceKeys.privateKey).toString('base64url') };
  } };
}
now += 1;
await check('撤销后的旧意图、缺少新二维码和不同实例密钥均不能重新绑定', async () => {
  for (const [suffix, overrides] of [
    ['old', { createdAt: new Date(revokedAt - 1).toISOString() }],
    ['missing_qr', { accountClaimTokenHash: '' }],
    ['wrong_key', { instance: { instanceId: claimInstanceId, publicKey: instancePublicKey, keyFingerprint: instanceFingerprint } }],
  ]) {
    const attempt = reenrollment(suffix, overrides);
    await assert.rejects(broker.authorizeAccountJoinIntent(attempt.authorize, { credential: secondRac }), { code: 'owner_auth_binding_mismatch' });
  }
});
const interruptedReenrollment = reenrollment('interrupted');
assert.equal(reenrollBinding.instancePublicKey.trim(), interruptedReenrollment.intent.instance.publicKey.trim());
assert.equal(reenrollBinding.instanceKeyFingerprint, interruptedReenrollment.intent.instance.keyFingerprint);
assert.ok(Date.parse(interruptedReenrollment.intent.createdAt) > Date.parse(reenrollBinding.revokedAt));
const interruptedGrant = await broker.authorizeAccountJoinIntent(interruptedReenrollment.authorize, { credential: secondRac });
now += 1;
reenrollBinding.revokedAt = new Date(now).toISOString();
await check('再次撤销会拒绝刚签发但尚未兑换的重新授权', async () => {
  await assert.rejects(broker.completeAccountJoinIntent(interruptedReenrollment.complete(interruptedGrant)), { code: 'owner_auth_binding_revoked' });
});
now += 1;
const freshReenrollment = reenrollment('fresh');
const freshReenrollmentGrant = await broker.authorizeAccountJoinIntent(freshReenrollment.authorize, { credential: secondRac });
await broker.completeAccountJoinIntent(freshReenrollment.complete(freshReenrollmentGrant));
await check('同一账号和实例密钥可用新的二维码授权建立新的绑定代次', async () => {
  assert.equal(reenrollBinding.revokedAt, '');
  assert.equal(new Date(reenrollBinding.boundAt).toISOString(), new Date(now).toISOString());
  assert.equal(nativeGoogleCalls, googleCallsBeforeClaim);
  assert.equal(state.accountJoinGrants.find((item) => item.intentId === freshReenrollment.intent.intentId).claimInstance, true);
});
await check('新绑定不会恢复旧代次未兑换的授权', async () => {
  await assert.rejects(broker.completeAccountJoinIntent(interruptedReenrollment.complete(interruptedGrant)), { code: 'owner_auth_binding_revoked' });
});

const logout = await broker.logoutAccountSession({ credential: secondRac });
await check('logout 删除账号与手机的关联并使原凭据失效', async () => {
  assert.equal(logout.loggedOut, true);
  assert.equal(logout.deviceId, accountDeviceId);
  assert.ok(logout.unboundAt);
  assert.equal(state.accountDevices.some((device) => device.deviceId === accountDeviceId), false);
  assert.equal(state.accountDeviceKeys.some((key) => key.deviceId === accountDeviceId), false);
  assert.equal(state.accountCredentials.some((credential) => credential.deviceId === accountDeviceId), false);
  assert.equal(state.accountJoinGrants.some((grant) => grant.accountDeviceId === accountDeviceId), false);
  await assert.rejects(() => broker.discoverInstances({}, { credential: secondRac }), {
    code: 'owner_auth_account_credential_expired',
  });
});

const reloginRequest = {
  requestId: 'session-relogin-request-0001',
  device: { deviceId: accountDeviceId, publicKey: devicePublicKey, alias: 'Android-AB12CD34', platform: 'android' },
};
const reloginChallenge = await broker.createAccountSessionChallenge(reloginRequest);
const relogin = await broker.completeAccountSession({
  transactionId: reloginChallenge.transactionId,
  requestId: reloginRequest.requestId,
  idToken: 'native-google-token',
  signature: deviceSign(buildAccountSessionMessage({
    transactionId: reloginChallenge.transactionId,
    requestId: reloginRequest.requestId,
    deviceId: accountDeviceId,
    publicKeyFingerprint: deviceFingerprint,
    nonce: reloginChallenge.nonce,
  })),
});
await check('同一安装重新登录重新建立唯一账号设备记录', async () => {
  assert.match(relogin.credential.token, /^rac_/);
  assert.equal(state.accountDevices.length, 1);
  assert.equal(state.accountDevices[0].deviceId, accountDeviceId);
  assert.equal(state.accountDevices[0].alias, 'Android-AB12CD34');
  assert.equal(state.accountDevices[0].unboundAt, '');
  assert.equal(state.accountDevices[0].revokedAt, '');
  assert.equal(state.accountDeviceKeys.length, 1, '同一密钥重新登录不插入重复 account_device_keys 记录');
  assert.equal(state.accountDeviceKeys[0].revokedAt, '');
});

// 验证原 key 已被撤销时的重新登录：解撤销并复用，绝不产生重复键冲突 (PG 23505)
state.accountDeviceKeys[0].revokedAt = new Date(now).toISOString();
const revokedReloginRequest = {
  requestId: 'session-relogin-revoked-0001',
  device: { deviceId: accountDeviceId, publicKey: devicePublicKey, alias: 'Android-AB12CD34', platform: 'android' },
};
const revokedReloginChallenge = await broker.createAccountSessionChallenge(revokedReloginRequest);
const revokedRelogin = await broker.completeAccountSession({
  transactionId: revokedReloginChallenge.transactionId,
  requestId: revokedReloginRequest.requestId,
  idToken: 'native-google-token',
  signature: deviceSign(buildAccountSessionMessage({
    transactionId: revokedReloginChallenge.transactionId,
    requestId: revokedReloginRequest.requestId,
    deviceId: accountDeviceId,
    publicKeyFingerprint: deviceFingerprint,
    nonce: revokedReloginChallenge.nonce,
  })),
});
await check('已撤销 key 重新登录时解撤销复用，不产生重复键冲突 (PG 23505)', async () => {
  assert.match(revokedRelogin.credential.token, /^rac_/);
  assert.equal(state.accountDeviceKeys.length, 1);
  assert.equal(state.accountDeviceKeys[0].fingerprint, deviceFingerprint);
  assert.equal(state.accountDeviceKeys[0].revokedAt, '');
});

async function attemptGuardedRelogin(requestId) {
  const challenge = await broker.createAccountSessionChallenge({
    requestId, device: { deviceId: accountDeviceId, publicKey: devicePublicKey, alias: 'Android-AB12CD34', platform: 'android' },
  });
  return broker.completeAccountSession({ transactionId: challenge.transactionId, requestId,
    idToken: 'native-google-token', signature: deviceSign(buildAccountSessionMessage({
      transactionId: challenge.transactionId, requestId, deviceId: accountDeviceId,
      publicKeyFingerprint: deviceFingerprint, nonce: challenge.nonce,
    })),
  });
}

await check('key reuse must not revive an explicitly revoked device', async () => {
  const revokedAt = new Date(now).toISOString();
  state.accountDevices[0].revokedAt = revokedAt;
  state.accountDeviceKeys[0].revokedAt = revokedAt;
  await assert.rejects(attemptGuardedRelogin('session-revoked-device-guard-0001'),
    (error) => error.code === 'owner_auth_account_device_revoked');
  assert.equal(state.accountDeviceKeys[0].revokedAt, revokedAt);
  state.accountDevices[0].revokedAt = '';
});

await check('key reuse cannot overwrite a device bound to another account', async () => {
  state.accountDevices[0].accountId = 'acct_another_owner';
  const previousRevocation = state.accountDeviceKeys[0].revokedAt;
  await assert.rejects(attemptGuardedRelogin('session-cross-account-guard-0001'),
    (error) => error.code === 'owner_auth_account_device_mismatch');
  assert.equal(state.accountDevices[0].accountId, 'acct_another_owner');
  assert.equal(state.accountDeviceKeys[0].revokedAt, previousRevocation);
  state.accountDevices[0].accountId = accountId;
});

await check('主动解绑移除账号关联及旧凭据，重新登录需要新的 Google 认证', async () => {
  state.accountDeviceKeys[0].revokedAt = '';
  const result = await broker.revokeAccountDirectoryDevice({ deviceId: accountDeviceId, credential: revokedRelogin.credential.token });
  assert.equal(result.revoked, true);
  assert.equal(state.accountDevices.some((device) => device.deviceId === accountDeviceId), false);
  await assert.rejects(() => broker.discoverInstances({}, { credential: revokedRelogin.credential.token }), { code: 'owner_auth_account_credential_expired' });
  const fresh = await attemptGuardedRelogin('session-after-detach-0001');
  assert.match(fresh.credential.token, /^rac_/);
  assert.equal(state.accountDevices.filter((device) => device.deviceId === accountDeviceId).length, 1);
});

console.log(`test-account-device-session: ${passed} assertions passed`);
