import assert from 'assert/strict';
import { generateKeyPairSync } from 'crypto';
import WebSocket from 'ws';

import { createConnectivityPolicyEngine } from '../lib/connectivity-policy-engine.mjs';
import {
  createReplayStore,
  issueSignalJoinToken,
  verifySignalJoinToken,
} from '../lib/browser-connection-grant.mjs';
import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const issuer = 'https://signal-test-issuer.invalid';
const keyId = 'signal-fixture-1';
const instanceId = 'ins_signal_test';
const clientId = 'browser_signal_test';
const connectionId = 'conn_signal_test';
const roomA = 'a'.repeat(40);
const roomB = 'b'.repeat(40);
const trustedKeys = new Map([[keyId, publicKey]]);
const events = [];

const policy = createConnectivityPolicyEngine();
const browserRequest = (permissions) => ({
  method: 'GET',
  url: '/healthz',
  headers: {
    'x-ragent-browser-principal': 'browser',
    'x-ragent-browser-permissions': permissions,
    'x-ragent-browser-account-id': 'acct_signal_test',
    'x-ragent-browser-instance-id': instanceId,
    'x-ragent-browser-client-id': clientId,
    'x-ragent-browser-connection-id': connectionId,
    'x-ragent-browser-grant-jti': 'bcg_signal_test',
  },
});
assert.equal(policy.decide(browserRequest('remote.read.health')).kind, 'authenticated');
assert.equal(policy.decide(browserRequest('')).kind, 'blocked');
assert.equal(policy.decide({ method: 'POST', url: '/healthz', headers: browserRequest('remote.read.health').headers }).kind, 'blocked');
assert.equal(policy.decide({ method: 'GET', url: '/api/sessions', headers: browserRequest('remote.read.health').headers }).kind, 'blocked');

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const signalReplay = createReplayStore();
const signaling = createP2PSignalingServer({
  host: '127.0.0.1',
  port: 0,
  authorizeJoin: ({ token, roomId, instanceId: requestedInstance, clientId: requestedClient, connectionId: requestedConnection }) => verifySignalJoinToken(token, {
    trustedKeys,
    replayStore: signalReplay,
    expectedIssuer: issuer,
    expectedRoomId: roomId,
    expectedInstanceId: instanceId,
    expectedClientId: clientId,
    expectedConnectionId: connectionId,
  }).valid && requestedInstance === instanceId && requestedClient === clientId && requestedConnection === connectionId,
  onEvent: (event) => events.push(event),
});
const signalAddress = await signaling.listen();
const signalingUrl = `ws://127.0.0.1:${signalAddress.port}/signal`;

function join({ roomId, token }) {
  return new Promise((resolve) => {
    const socket = new WebSocket(signalingUrl);
    const result = { socket, joined: false, closeCode: null };
    socket.once('open', () => socket.send(JSON.stringify({
      type: 'join', roomId, role: 'browser', joinToken: token, instanceId, clientId, connectionId,
    })));
    socket.once('message', (raw) => {
      const message = JSON.parse(raw.toString());
      result.joined = message.type === 'joined';
      if (result.joined) resolve(result);
    });
    socket.once('close', (code) => { result.closeCode = code; resolve(result); });
    socket.once('error', () => resolve(result));
  });
}

const validToken = issueSignalJoinToken({ privateKey, issuer, roomId: roomA, instanceId, clientId, connectionId, kid: keyId }).token;
const valid = await join({ roomId: roomA, token: validToken });
assert.equal(valid.joined, true, 'valid browser token may join its authorized room');
assert.equal(events[0].event, 'signal_join_authorized');
valid.socket.close();
const replay = await join({ roomId: roomA, token: validToken });
assert.equal(replay.joined, false, 'signal join token is single-use');

const withoutToken = await join({ roomId: roomA });
assert.equal(withoutToken.joined, false, 'browser without signal join token is rejected');
const wrongRoomToken = issueSignalJoinToken({ privateKey, issuer, roomId: roomA, instanceId, clientId, connectionId, kid: keyId }).token;
const wrongRoom = await join({ roomId: roomB, token: wrongRoomToken });
assert.equal(wrongRoom.joined, false, 'signal token cannot cross rooms');
assert.ok(events.some((event) => event.event === 'signal_join_rejected'));

await signaling.close();

// The test issuer boundary is account-owned-instance scoped. This is also
// exercised by the browser PoC endpoint; keep the policy assertion local so a
// future gateway cannot accidentally treat an unscoped browser header as trust.
const notBrowser = policy.decide({ method: 'GET', url: '/healthz', headers: { authorization: `Bearer rdt_${'a'.repeat(64)}` } });
assert.equal(notBrowser.kind, 'authenticated', 'legacy trusted-device path remains compatible');

const trustedDeviceHeaders = { authorization: `Bearer rdt_${'b'.repeat(64)}` };
for (const { method, url } of [
  { method: 'GET', url: '/api/native-providers' },
  { method: 'POST', url: '/api/native-providers' },
  { method: 'GET', url: '/api/native-provider-oauth/jobs/job_1' },
  { method: 'POST', url: '/api/native-provider-oauth/jobs/job_1/input' },
]) {
  assert.equal(
    policy.decide({ method, url, headers: trustedDeviceHeaders }).kind,
    'authenticated',
    `trusted devices should reach ${method} ${url}`,
  );
}
assert.equal(
  policy.decide({ method: 'POST', url: '/api/install', headers: trustedDeviceHeaders }).kind,
  'blocked',
  'trusted devices must not reach installation routes',
);
console.log('test-browser-connectivity-security: signaling replay/room auth and instance permission gate ok');
