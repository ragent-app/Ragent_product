#!/usr/bin/env node
// Account-join key rotation: an authenticated fresh join may replace an
// installation-scoped Android key, while replays and unverified callers fail
// closed.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ragent-account-key-rotation-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.RAGENT_INSTANCE_ROOT;
mkdirSync(process.env.RAGENT_CONFIG_DIR, { recursive: true });

function publicKey() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

const previousKey = publicKey();
const replacementKey = publicKey();
const unverifiedKey = publicKey();
const deviceId = 'rdev_account_key_rotation_001';
const accountId = 'acct_account_key_rotation_001';
const now = new Date().toISOString();

writeFileSync(join(process.env.RAGENT_CONFIG_DIR, 'trusted-devices.json'), JSON.stringify({
  version: 1,
  instanceId: 'rli_account_key_rotation_001',
  instanceSecret: 'account-key-rotation-test-secret',
  invitations: [],
  challenges: [],
  authTokens: [{
    tokenHash: 'obsolete-device-credential',
    deviceId,
    kind: 'bound',
    scope: 'device-access',
    createdAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }],
  devices: [{
    id: deviceId,
    tokenHash: '',
    status: 'bound',
    enrollmentKind: 'account-join',
    accountId,
    deviceName: 'Android before reinstall',
    platform: 'android',
    devicePublicKey: previousKey,
    authVersion: 3,
    keyAlgorithm: 'ec',
    keyRotatedAt: '',
    keyRotationCount: 0,
    createdAt: now,
    boundAt: now,
    lastSeenAt: now,
    temporaryExpiresAt: '',
    revokedAt: '',
    expiresAt: '',
  }],
  accountJoinIntents: [],
}));

const { createDevicePublicKeyFingerprint } = await import('../lib/device-auth-protocol.mjs');
const {
  completeTrustedDeviceAccountIntent,
  getTrustedDeviceP2PAccess,
  getTrustedDeviceStatus,
  revokeTrustedDevice,
} = await import('../chat/trusted-devices.mjs');

function pendingIntent({ intentId, key, deviceName = 'Android after reinstall' }) {
  return {
    intentId,
    instanceId: 'rli_account_key_rotation_001',
    deviceId,
    devicePublicKey: key,
    devicePublicKeyFingerprint: createDevicePublicKeyFingerprint(key),
    deviceName,
    computerAlias: 'Windows',
    platform: 'android',
    publicEndpoint: '',
    nonceHash: 'test-nonce-hash',
    issuedAt: now,
    createdAt: now,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    status: 'pending',
    accountId: '',
    completionRequestId: '',
    completedAt: '',
  };
}

function state() {
  return JSON.parse(readFileSync(join(process.env.RAGENT_CONFIG_DIR, 'trusted-devices.json'), 'utf8'));
}

try {
  const firstIntent = pendingIntent({ intentId: 'rji_account_key_rotation_001', key: replacementKey });
  const first = await completeTrustedDeviceAccountIntent({
    intentId: firstIntent.intentId,
    intent: firstIntent,
    deviceSignature: 'verified-by-accounts',
    accountId,
    requestId: 'account-key-rotation-request-001',
    verifiedAccountCompletion: true,
  });
  assert.equal(first.keyRotated, true);
  assert.match(first.credential.token, /^rda_[a-f0-9]{64}$/);
  let persisted = state();
  assert.equal(persisted.devices.length, 1);
  assert.equal(persisted.devices[0].devicePublicKey, replacementKey.trim());
  assert.equal(persisted.devices[0].deviceName, 'Android after reinstall');
  assert.equal(persisted.devices[0].revokedAt, '');
  assert.ok(persisted.devices[0].keyRotatedAt);
  assert.equal(persisted.devices[0].keyRotationCount, 1);
  assert.equal(persisted.authTokens.length, 1);
  assert.notEqual(persisted.authTokens[0].tokenHash, 'obsolete-device-credential');
  console.log('ok - verified fresh account join rotates an installation key without revoking the device');

  const replay = await completeTrustedDeviceAccountIntent({
    intentId: firstIntent.intentId,
    deviceSignature: 'verified-by-accounts',
    accountId,
    requestId: 'account-key-rotation-request-001',
    verifiedAccountCompletion: true,
  });
  assert.equal(replay.keyRotated, false);
  persisted = state();
  assert.equal(persisted.devices[0].devicePublicKey, replacementKey.trim());
  assert.equal(persisted.devices[0].keyRotationCount, 1);
  assert.equal(persisted.authTokens.length, 1);
  console.log('ok - replayed completion cannot rotate the device back');

  const unverifiedIntent = pendingIntent({ intentId: 'rji_account_key_rotation_002', key: unverifiedKey });
  await assert.rejects(
    () => completeTrustedDeviceAccountIntent({
      intentId: unverifiedIntent.intentId,
      intent: unverifiedIntent,
      deviceSignature: 'untrusted',
      accountId,
      requestId: 'account-key-rotation-request-002',
    }),
    (error) => error?.code === 'owner_auth_device_mismatch',
  );
  persisted = state();
  assert.equal(persisted.devices[0].devicePublicKey, replacementKey.trim());
  assert.equal(persisted.devices[0].keyRotationCount, 1);
  console.log('ok - an unverified local caller cannot rotate a device key');

  // A manual revoke followed by a same-device account rejoin retains the old
  // record for audit. Every live lookup must prefer the replacement instead
  // of treating the historical revoked entry as the device's current state.
  const retired = {
    ...persisted.devices[0],
    devicePublicKey: previousKey.trim(),
    createdAt: '2026-01-01T00:00:00.000Z',
    boundAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    revokedAt: '2026-01-02T00:00:00.000Z',
  };
  const replacement = {
    ...persisted.devices[0],
    createdAt: '2026-01-03T00:00:00.000Z',
    boundAt: '2026-01-03T00:00:00.000Z',
    lastSeenAt: '2026-01-03T00:00:00.000Z',
    revokedAt: '',
  };
  writeFileSync(join(process.env.RAGENT_CONFIG_DIR, 'trusted-devices.json'), JSON.stringify({
    ...persisted,
    devices: [retired, replacement],
  }));
  const status = await getTrustedDeviceStatus(deviceId);
  assert.equal(status.revokedAt, '');
  assert.equal(status.devicePublicKey, replacementKey.trim());
  assert.ok(await getTrustedDeviceP2PAccess(deviceId));
  await revokeTrustedDevice(deviceId);
  persisted = state();
  assert.ok(persisted.devices.every((entry) => entry.revokedAt));
  console.log('ok - a live re-enrollment supersedes a revoked historical record and revoke covers every live record');
} finally {
  rmSync(home, { recursive: true, force: true });
}
