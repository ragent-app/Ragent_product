#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const home = mkdtempSync(join(tmpdir(), 'ragent-account-join-intent-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.RAGENT_INSTANCE_ROOT;

const { createOwnerAuthBroker } = await import(pathToFileURL(join(repoRoot, 'accounts/owner-auth-broker.mjs')).href);
const {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signAccountJoinIntentProof,
} = await import(pathToFileURL(join(repoRoot, 'lib/instance-identity.mjs')).href);
const {
  buildAccountJoinIntentMessage,
  createDevicePublicKeyFingerprint,
  normalizeDevicePublicKey,
} = await import(pathToFileURL(join(repoRoot, 'lib/device-auth-protocol.mjs')).href);

const identity = await loadOrCreateInstanceIdentity();
const instance = publicInstanceIdentity(identity);
const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const devicePublicKey = device.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const normalizedDevice = normalizeDevicePublicKey(devicePublicKey);
const deviceFingerprint = createDevicePublicKeyFingerprint(devicePublicKey);
const now = Date.parse('2026-08-14T12:00:00.000Z');
let state = {
  instanceBindings: [{
    instanceId: instance.instanceId,
    accountId: 'acct_google_owner',
    provider: 'google',
    boundAt: new Date(now).toISOString(),
    revokedAt: '',
  }],
  devices: [],
};
const store = { async mutate(mutator) { return mutator(state); } };
const broker = createOwnerAuthBroker({
  store,
  clock: () => now,
  verifyGoogleCredential: async ({ idToken }) => ({ providerSubject: idToken === 'owner-token' ? 'owner-sub' : 'other-sub' }),
  verifyNativeGoogleCredential: async ({ idToken }) => ({ providerSubject: idToken === 'owner-token' ? 'owner-sub' : 'other-sub' }),
  resolveAccount: async ({ googleIdentity }) => ({
    accountId: googleIdentity.providerSubject === 'owner-sub' ? 'acct_google_owner' : 'acct_google_other',
  }),
  signAssertion: async (claims) => `assertion:${JSON.stringify(claims)}`,
});

const intentId = 'rji_test_intent_001';
const nonce = 'join-nonce-000001';
const issuedAt = new Date(now).toISOString();
const deviceId = 'rdev_join_001';
const instanceProof = signAccountJoinIntentProof(identity, {
  intentId,
  deviceId,
  devicePublicKeyFingerprint: deviceFingerprint,
  nonce,
  issuedAt,
  audience: 'ragent-account-join',
});
const createInput = {
  intentId,
  nonce,
  issuedAt,
  audience: 'ragent-account-join',
  instance,
  device: {
    deviceId,
    publicKey: normalizedDevice.publicKey,
    devicePublicKeyFingerprint: deviceFingerprint,
    alias: 'Pixel test',
    platform: 'android',
  },
  computerAlias: 'Office\ncomputer',
  signature: instanceProof.signature,
};

const alternateKey = generateKeyPairSync('ed25519');
const alternateIdentity = {
  version: 1,
  algorithm: 'ed25519',
  instanceId: instance.instanceId,
  publicKey: alternateKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  privateKey: alternateKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  createdAt: issuedAt,
};
const alternateInstance = publicInstanceIdentity(alternateIdentity);

function deviceSignature() {
  const message = buildAccountJoinIntentMessage({
    instanceId: instance.instanceId,
    intentId,
    deviceId,
    devicePublicKeyFingerprint: deviceFingerprint,
    nonce,
    issuedAt,
    audience: 'ragent-account-join',
  });
  return cryptoSign('sha256', Buffer.from(message), device.privateKey).toString('base64');
}

function completeInput(requestId, overrides = {}) {
  const currentIssuedAt = new Date(now).toISOString();
  const proof = signAccountJoinIntentProof(identity, {
    intentId,
    deviceId,
    devicePublicKeyFingerprint: deviceFingerprint,
    nonce,
    issuedAt: currentIssuedAt,
    audience: 'ragent-account-join',
  });
  return {
    intentId,
    requestId,
    nonce,
    deviceIssuedAt: issuedAt,
    device: { deviceId, devicePublicKeyFingerprint: deviceFingerprint },
    deviceSignature: deviceSignature(),
    idToken: 'owner-token',
    issuedAt: currentIssuedAt,
    audience: 'ragent-account-join',
    instance,
    signature: proof.signature,
    ...overrides,
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

try {
  const created = await broker.createAccountJoinIntent(createInput);
  check('创建 account intent 固定设备公钥并返回 120 秒窗口', () => {
    assert.equal(created.intentId, intentId);
    assert.equal(created.deviceId, deviceId);
    assert.equal(state.accountJoinIntents[0].devicePublicKeyFingerprint, deviceFingerprint);
    assert.equal(created.computerAlias, 'Office computer');
    assert.equal(state.accountJoinIntents[0].computerAlias, 'Office computer');
    assert.equal(state.accountJoinIntents[0].nonceHash.includes(nonce), false);
  });

  const otherNonce = 'join-nonce-other';
  const otherNonceProof = signAccountJoinIntentProof(identity, {
    intentId,
    deviceId,
    devicePublicKeyFingerprint: deviceFingerprint,
    nonce: otherNonce,
    issuedAt,
    audience: 'ragent-account-join',
  });
  await assert.rejects(
    () => broker.createAccountJoinIntent({ ...createInput, nonce: otherNonce, signature: otherNonceProof.signature }),
    (error) => error.code === 'owner_auth_native_replay' && error.statusCode === 409,
  );
  check('同 intent 不接受更换 nonce 的幂等重试', () => assert.equal(state.accountJoinIntents.length, 1));

  const replayCreate = await broker.createAccountJoinIntent(createInput);
  check('同 intent 同设备创建幂等', () => assert.equal(replayCreate.replayed, true));

  const alternateProof = signAccountJoinIntentProof(alternateIdentity, {
    intentId,
    deviceId,
    devicePublicKeyFingerprint: deviceFingerprint,
    nonce,
    issuedAt,
    audience: 'ragent-account-join',
  });
  await assert.rejects(
    () => broker.completeAccountJoinIntent(completeInput('join-request-alt', {
      instance: alternateInstance,
      signature: alternateProof.signature,
    })),
    (error) => error.code === 'owner_auth_instance_mismatch' && error.statusCode === 403,
  );
  check('完成 proof 必须使用创建 intent 时冻结的实例公钥', () => assert.equal(state.accountJoinIntents[0].status, 'pending'));

  const completed = await broker.completeAccountJoinIntent(completeInput('join-request-0001'));
  check('目标实例已绑定且同账号时完成 join 并签发 assertion', () => {
    assert.equal(completed.deviceState, 'bound');
    assert.equal(completed.accountId, 'acct_google_owner');
    assert.equal(state.accountJoinIntents[0].status, 'completed');
    assert.equal(state.accountJoinIntents[0].accountId, 'acct_google_owner');
    assert.equal(state.accountJoinIntents[0].completionRequestId, 'join-request-0001');
    assert.ok(state.accountJoinIntents[0].completedAt);
    assert.equal(state.devices[0].accountId, 'acct_google_owner');
  });

  const conflictingDevice = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const normalizedConflictingDevice = normalizeDevicePublicKey(
    conflictingDevice.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );
  const conflictingFingerprint = createDevicePublicKeyFingerprint(normalizedConflictingDevice.publicKey);
  const conflictingIntentId = 'rji_conflicting_device_001';
  const conflictingNonce = 'join-conflicting-nonce';
  const conflictingCreateProof = signAccountJoinIntentProof(identity, {
    intentId: conflictingIntentId,
    deviceId,
    devicePublicKeyFingerprint: conflictingFingerprint,
    nonce: conflictingNonce,
    issuedAt,
    audience: 'ragent-account-join',
  });
  await broker.createAccountJoinIntent({
    ...createInput,
    intentId: conflictingIntentId,
    nonce: conflictingNonce,
    device: {
      ...createInput.device,
      publicKey: normalizedConflictingDevice.publicKey,
      devicePublicKeyFingerprint: conflictingFingerprint,
    },
    signature: conflictingCreateProof.signature,
  });
  const conflictingDeviceSignature = cryptoSign('sha256', Buffer.from(buildAccountJoinIntentMessage({
    instanceId: instance.instanceId,
    intentId: conflictingIntentId,
    deviceId,
    devicePublicKeyFingerprint: conflictingFingerprint,
    nonce: conflictingNonce,
    issuedAt,
    audience: 'ragent-account-join',
  })), conflictingDevice.privateKey).toString('base64');
  const conflictingCompletionProof = signAccountJoinIntentProof(identity, {
    intentId: conflictingIntentId,
    deviceId,
    devicePublicKeyFingerprint: conflictingFingerprint,
    nonce: conflictingNonce,
    issuedAt,
    audience: 'ragent-account-join',
  });
  await assert.rejects(
    () => broker.completeAccountJoinIntent({
      intentId: conflictingIntentId,
      requestId: 'join-conflict-request',
      nonce: conflictingNonce,
      deviceIssuedAt: issuedAt,
      device: { deviceId, devicePublicKeyFingerprint: conflictingFingerprint },
      deviceSignature: conflictingDeviceSignature,
      idToken: 'owner-token',
      issuedAt,
      audience: 'ragent-account-join',
      instance,
      signature: conflictingCompletionProof.signature,
    }),
    (error) => error.code === 'owner_auth_device_mismatch' && error.statusCode === 403,
  );
  check('已有设备公钥冲突时拒绝覆盖绑定', () => {
    assert.equal(state.devices.length, 1);
    assert.equal(state.devices[0].devicePublicKeyFingerprint, deviceFingerprint);
  });

  const replayed = await broker.completeAccountJoinIntent(completeInput('join-request-0001'));
  check('同幂等键重试不创建第二设备', () => {
    assert.equal(replayed.replayed, true);
    assert.equal(state.devices.length, 1);
  });

  await assert.rejects(
    () => broker.completeAccountJoinIntent(completeInput('join-request-0002', { deviceSignature: 'tampered' })),
    (error) => error.code === 'owner_auth_device_signature_invalid' && error.statusCode === 401,
  );
  check('设备签名篡改拒绝且不改变绑定', () => assert.equal(state.devices.length, 1));

  await assert.rejects(
    () => broker.completeAccountJoinIntent(completeInput('join-request-0003', { idToken: 'other-token' })),
    { code: 'owner_auth_native_replay' },
  );
  check('已完成 intent 使用不同幂等键拒绝重放', () => assert.equal(state.devices[0].accountId, 'acct_google_owner'));

  console.log(`test-account-join-intent: ${passed} assertions passed`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
