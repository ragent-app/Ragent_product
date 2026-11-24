#!/usr/bin/env node
import assert from 'assert/strict';

import {
  p2pHostCount,
  restoreP2PHostsForDevices,
  startP2PHostForDevice,
  stopAllP2PHosts,
  stopP2PHost,
} from '../lib/p2p-host-registry.mjs';

const created = [];

function fakeHostAgent(options, { ready = Promise.resolve() } = {}) {
  let resolveDone;
  const agent = {
    ready,
    done: new Promise((resolve) => { resolveDone = resolve; }),
    stopCalls: 0,
    stop() {
      this.stopCalls += 1;
      resolveDone({ code: 0, signal: 'SIGTERM' });
    },
  };
  created.push({ options, agent });
  return agent;
}

await stopAllP2PHosts();

// Multiple real account devices must stay connected when later devices join.
// The former three-host cap silently disconnected the oldest device.
const simultaneous = await Promise.all(Array.from({ length: 6 }, (_, index) =>
  startP2PHostForDevice(`multi-device-${index}`, {
    p2pAccess: { roomId: `multi-${index}-${'a'.repeat(40)}`.slice(0, 40), secret: `secret-${index}` },
    signalingUrl: 'https://signal.example.test',
    runHostAgent: (options) => fakeHostAgent(options),
  }),
));
assert.ok(simultaneous.every((entry) => entry.started));
assert.equal(p2pHostCount(), 6, 'a fourth device must not evict an existing device');
assert.ok(created.every(({ agent }) => agent.stopCalls === 0), 'all prior hosts remain active');
stopP2PHost('multi-device-2');
assert.equal(p2pHostCount(), 5);
assert.equal(created[2].agent.stopCalls, 1, 'explicit removal releases only its own device');
assert.ok(created.filter((_, index) => index !== 2).every(({ agent }) => agent.stopCalls === 0));
await stopAllP2PHosts();
assert.equal(p2pHostCount(), 0);
created.length = 0;

const first = await startP2PHostForDevice('device-1', {
  p2pAccess: { roomId: 'a'.repeat(40), secret: 'device-secret' },
  signalingUrl: 'https://signal.example.test',
  localBaseUrl: 'http://127.0.0.1:7690',
  iceServers: [{ urls: 'turn:turn.example.test', username: 'u', credential: 'p' }],
  runHostAgent: (options) => fakeHostAgent(options),
});
assert.equal(first.started, true);
assert.equal(p2pHostCount(), 1);
assert.deepEqual(created[0].options.iceServers, [{ urls: 'turn:turn.example.test', username: 'u', credential: 'p' }]);
assert.equal(created[0].options.relayOnly, false, 'local callers must retain the default ICE policy');

const reused = await startP2PHostForDevice('device-1', {
  p2pAccess: { roomId: 'b'.repeat(40), secret: 'different-secret' },
  signalingUrl: 'https://signal.example.test',
  runHostAgent: (options) => fakeHostAgent(options),
});
assert.equal(reused.reused, true);
assert.equal(created.length, 1, 'repeated start must not create a second sidecar');

let releaseReady;
const pendingReady = new Promise((resolve) => { releaseReady = resolve; });
const startingA = startP2PHostForDevice('device-2', {
  p2pAccess: { roomId: 'c'.repeat(40), secret: 'device-secret-2' },
  signalingUrl: 'https://signal.example.test',
  runHostAgent: (options) => fakeHostAgent(options, { ready: pendingReady }),
});
const startingB = startP2PHostForDevice('device-2', {
  p2pAccess: { roomId: 'd'.repeat(40), secret: 'different-secret-2' },
  signalingUrl: 'https://signal.example.test',
  runHostAgent: () => { throw new Error('must not run twice'); },
});
releaseReady();
const [concurrentA, concurrentB] = await Promise.all([startingA, startingB]);
assert.equal(concurrentA.started, true);
assert.equal(concurrentB.started, true);
assert.equal(created.filter(({ options }) => options.roomId === 'c'.repeat(40)).length, 1);
assert.equal(p2pHostCount(), 2);

const failed = await startP2PHostForDevice('device-failed', {
  p2pAccess: { roomId: 'e'.repeat(40), secret: 'device-secret-failed' },
  signalingUrl: 'https://signal.example.test',
  runHostAgent: (options) => fakeHostAgent(options, {
    ready: Promise.reject(new Error('signal unavailable')),
  }),
});
assert.equal(failed.started, false);
assert.equal(failed.reason, 'startup-failed');
assert.match(failed.error, /signal unavailable/);
assert.equal(created.at(-1).agent.stopCalls, 1, 'failed startup must stop the sidecar');
assert.equal(p2pHostCount(), 2);

const bootstrapFailure = await restoreP2PHostsForDevices([
  { id: 'bootstrap-failure', status: 'bound', enrollmentKind: 'account-join', accountId: 'account-1' },
], {
  signalingUrl: 'https://signal.example.test',
  getP2PAccess: async () => ({ roomId: 'f'.repeat(40), secret: 'synthetic-secret' }),
  getBootstrap: async () => { throw Object.assign(new Error('TURN bootstrap is unavailable for this device'), { code: 'turn_connection_quota_exceeded' }); },
});
assert.equal(bootstrapFailure.results[0].reason, 'p2p-access-failed');
assert.match(bootstrapFailure.results[0].error, /\(turn_connection_quota_exceeded\)$/);

const restored = await restoreP2PHostsForDevices([
  { id: 'restore-join', status: 'bound', enrollmentKind: 'account-join', accountId: 'account-1', revokedAt: '' },
  { id: 'restore-claim', status: 'bound', enrollmentKind: 'account-claim', accountId: 'account-1', revokedAt: '' },
  { id: 'restore-legacy', status: 'bound', enrollmentKind: 'qr-scan', accountId: 'account-1', revokedAt: '' },
  { id: 'restore-provisional', status: 'provisional', enrollmentKind: 'account-join', accountId: 'account-1', revokedAt: '' },
  { id: 'restore-revoked', status: 'bound', enrollmentKind: 'account-join', accountId: 'account-1', revokedAt: '2026-09-02T00:00:00.000Z' },
], {
  signalingUrl: 'https://signal.example.test',
  getP2PAccess: async (deviceId) => ({ roomId: `${deviceId}-${'f'.repeat(40)}`.slice(0, 40), secret: `secret-${deviceId}` }),
  getBootstrap: async ({ deviceId }) => ({
    turn: {
      iceServers: [{ urls: `turn:${deviceId}.example.test`, username: 'u', password: 'p' }],
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
  }),
  runHostAgent: (options) => fakeHostAgent(options),
});
assert.equal(restored.attempted, 2);
assert.equal(restored.started, 2);
assert.deepEqual(restored.results.map((entry) => entry.deviceId), ['restore-join', 'restore-claim']);
assert.ok(created.slice(-2).every(({ options }) => options.iceServers[0].urls.startsWith('turn:')));
assert.ok(created.slice(-2).every(({ options }) => options.relayOnly === true), 'legacy bootstrap without allowDirectIce must remain relay-only');

created.length = 0;
const directRestored = await restoreP2PHostsForDevices([
  { id: 'restore-owner-direct', status: 'bound', enrollmentKind: 'account-join', accountId: 'account-1', revokedAt: '' },
  {
    id: 'restore-workspace-shared',
    status: 'bound',
    enrollmentKind: 'account-join',
    accountId: 'account-2',
    workspaceAccess: { ownerAccountId: 'account-1', grantId: `iag_${'a'.repeat(24)}` },
    revokedAt: '',
  },
], {
  signalingUrl: 'https://signal.example.test',
  getP2PAccess: async (deviceId) => ({ roomId: `${deviceId}-${'f'.repeat(40)}`.slice(0, 40), secret: `secret-${deviceId}` }),
  getBootstrap: async ({ deviceId }) => ({
    allowDirectIce: deviceId === 'restore-owner-direct',
    turn: {
      iceServers: [{ urls: `turn:${deviceId}.example.test`, username: 'u', password: 'p' }],
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
  }),
  runHostAgent: (options) => fakeHostAgent(options),
});
assert.equal(directRestored.attempted, 2);
assert.equal(directRestored.started, 2);
assert.equal(created[0].options.relayOnly, false, 'owner trusted_device recovery with allowDirectIce must enable direct ICE');
assert.equal(created[1].options.relayOnly, true, 'shared workspace device recovery must stay relay-only');

await stopAllP2PHosts();
created.length = 0;
const onDemandRestored = await restoreP2PHostsForDevices([
  { id: 'ondemand-owner-direct', status: 'bound', enrollmentKind: 'account-join', accountId: 'account-1', revokedAt: '' },
  {
    id: 'ondemand-workspace-shared',
    status: 'bound',
    enrollmentKind: 'account-join',
    accountId: 'account-2',
    workspaceAccess: { ownerAccountId: 'account-1', grantId: `iag_${'b'.repeat(24)}` },
    revokedAt: '',
  },
], {
  onDemand: true,
  signalingUrl: 'https://signal.example.test',
  getP2PAccess: async (deviceId) => ({ roomId: `${deviceId}-${'e'.repeat(40)}`.slice(0, 40), secret: `secret-${deviceId}` }),
  getBootstrap: async ({ deviceId }) => ({
    allowDirectIce: deviceId === 'ondemand-owner-direct',
    turn: {
      connectionId: `conn_${deviceId}`,
      iceServers: [{ urls: `turn:${deviceId}.example.test`, username: 'u', password: 'p' }],
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
  }),
  runHostAgent: (options) => fakeHostAgent(options),
});
assert.equal(onDemandRestored.started, 2);
assert.equal(created[0].options.relayOnly, false, 'on-demand owner trusted_device watcher must allow direct ICE');
assert.equal(created[1].options.relayOnly, true, 'on-demand shared workspace watcher must stay relay-only');
assert.equal((await created[0].options.resolveIceServers()).relayOnly, false);
assert.equal((await created[1].options.resolveIceServers()).relayOnly, true);

const browserHostResult = await startP2PHostForDevice('browser-device', {
  p2pAccess: { roomId: 'b'.repeat(40), secret: 'browser-secret' },
  signalingUrl: 'https://signal.example.test',
  browserAuth: { publicKeyPem: 'pem', keyId: 'k1', issuer: 'iss', instanceId: 'ins' },
  relayOnly: false,
  runHostAgent: (options) => fakeHostAgent(options),
});
assert.equal(browserHostResult.started, true);
assert.equal(created.at(-1).options.relayOnly, true, 'browserAuth hosts must always enforce relayOnly');

let refreshCalls = 0;
await startP2PHostForDevice('refresh-device', {
  p2pAccess: { roomId: 'r'.repeat(40), secret: 'refresh-secret' },
  signalingUrl: 'https://signal.example.test',
  expiresAt: new Date(Date.now() + 2_200).toISOString(),
  iceServers: [{ urls: 'turn:turn.example.test', username: 'u', credential: 'p' }],
  refreshHost: async () => {
    refreshCalls += 1;
    return {
      iceServers: [{ urls: 'turn:turn.example.test', username: 'u2', credential: 'p2' }],
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
  },
  runHostAgent: (options) => fakeHostAgent(options),
});
await new Promise((resolve) => setTimeout(resolve, 1_400));
assert.equal(refreshCalls, 1, 'TURN credentials should refresh before expiry');

await stopAllP2PHosts();
assert.equal(p2pHostCount(), 0);
let readyRelease;
const cancelledReady = startP2PHostForDevice('cancel-ready', {
  p2pAccess: { roomId: 'c'.repeat(40), secret: 'cancel-ready' }, signalingUrl: 'https://signal.example.test',
  runHostAgent: options => fakeHostAgent(options, { ready: new Promise(resolve => { readyRelease = resolve; }) }),
});
await new Promise(setImmediate); const readyAgent = created.at(-1).agent;
stopP2PHost('cancel-ready');
readyRelease();
assert.equal((await cancelledReady).reason, 'device-stopped');
await new Promise(setImmediate);
assert.equal(p2pHostCount(), 0); assert.equal(readyAgent.stopCalls, 1);
let creationRelease;
const cancelledCreation = startP2PHostForDevice('cancel-creation', {
  p2pAccess: { roomId: 'd'.repeat(40), secret: 'cancel-creation' }, signalingUrl: 'https://signal.example.test',
  runHostAgent: () => new Promise(resolve => { creationRelease = resolve; }),
});
await new Promise(setImmediate); await stopAllP2PHosts();
const freshAfterStop = await startP2PHostForDevice('cancel-creation', {
  p2pAccess: { roomId: 'd'.repeat(40), secret: 'cancel-creation' }, signalingUrl: 'https://signal.example.test', runHostAgent: fakeHostAgent,
});
assert.equal(freshAfterStop.started, true);
const lateAgent = fakeHostAgent({}); creationRelease(lateAgent);
assert.equal((await cancelledCreation).reason, 'registry-stopping');
assert.equal(lateAgent.stopCalls, 1); assert.equal(p2pHostCount(), 1);
await stopAllP2PHosts();
const failedSync = await startP2PHostForDevice('sync-failure', {
  p2pAccess: { roomId: 'f'.repeat(40), secret: 'sync-failure' }, signalingUrl: 'https://signal.example.test',
  runHostAgent: () => { throw Error('Synthetic synchronous startup failure'); },
});
assert.equal(failedSync.reason, 'startup-failed');
assert.equal((await startP2PHostForDevice('sync-failure', {
  p2pAccess: { roomId: 'f'.repeat(40), secret: 'sync-failure' }, signalingUrl: 'https://signal.example.test', runHostAgent: fakeHostAgent,
})).started, true);
await stopAllP2PHosts();
console.log('test-p2p-host-registry: lifecycle, relay recovery and startup cancellation passed');
