import assert from 'assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';

import {
  BROWSER_CONNECTION_GRANT_DOMAIN,
  BROWSER_CONNECTION_GRANT_VERSION,
  BROWSER_CONNECTION_GRANT_PERMISSION,
  SIGNAL_JOIN_TOKEN_DOMAIN,
  browserAuthChallenge,
  canonicalJson,
  createReplayStore,
  hashJti,
  issueBrowserConnectionGrant,
  issueSignalJoinToken,
  verifyBrowserConnectionGrant,
  verifySignalJoinToken,
} from '../lib/browser-connection-grant.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const { privateKey: browserPrivateKey, publicKey: browserPublicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const browserJwk = browserPublicKey.export({ format: 'jwk' });
const base = {
  issuer: 'https://test-issuer.ragent.invalid',
  instanceId: 'ins_a',
  accountId: 'acct_a',
  clientId: 'browser_a',
  connectionId: 'conn_a',
  ephemeralPublicKey: { ...browserJwk, alg: 'P-256' },
  kid: 'fixture-2026-09',
};
const keys = new Map([[base.kid, publicKey]]);
const nowMs = 1_800_000_000_000;
const replay = createReplayStore({ now: () => nowMs });

const issued = issueBrowserConnectionGrant({ ...base, privateKey, nowMs, ttlMs: 30_000 });
assert.equal(issued.payload.version, BROWSER_CONNECTION_GRANT_VERSION);
assert.equal(issued.payload.aud, 'instance:ins_a');
assert.equal(issued.payload.permissions[0], BROWSER_CONNECTION_GRANT_PERMISSION);
assert.match(hashJti(issued.payload.jti), /^[a-f0-9]{12}$/);
assert.equal(
  verifyBrowserConnectionGrant(issued.token, {
    trustedKeys: keys,
    nowMs,
    expectedIssuer: base.issuer,
    expectedAudience: 'instance:ins_a',
    expectedInstanceId: base.instanceId,
    expectedConnectionId: base.connectionId,
    expectedClientId: base.clientId,
    requiredPermission: BROWSER_CONNECTION_GRANT_PERMISSION,
  }).valid,
  true,
);

// Canonical payload ordering is part of the signature input, not an incidental
// JSON implementation detail.
const payloadSegment = issued.token.split('.')[1];
assert.equal(canonicalJson(JSON.parse(Buffer.from(payloadSegment, 'base64url').toString())), Buffer.from(payloadSegment, 'base64url').toString());
assert.notEqual(canonicalJson({ b: 1, a: 2 }), JSON.stringify({ b: 1, a: 2 }));

const checks = [
  ['wrong audience', { expectedAudience: 'instance:ins_b' }, 'invalid audience'],
  ['wrong instance', { expectedInstanceId: 'ins_b' }, 'wrong instance'],
  ['wrong connection', { expectedConnectionId: 'conn_b' }, 'wrong connection'],
  ['wrong client', { expectedClientId: 'browser_b' }, 'wrong client'],
  ['wrong permission', { requiredPermission: 'remote.write' }, 'permission denied'],
];
for (const [label, options, reason] of checks) {
  const result = verifyBrowserConnectionGrant(issued.token, { trustedKeys: keys, nowMs, ...options });
  assert.equal(result.valid, false, label);
  assert.equal(result.reason, reason, label);
}
assert.equal(verifyBrowserConnectionGrant(issued.token, { trustedKeys: keys, nowMs: nowMs + 30_000 }).reason, 'grant expired');
assert.equal(verifyBrowserConnectionGrant(issued.token, { trustedKeys: keys, nowMs: nowMs - 1 }).valid, false);

const notYet = issueBrowserConnectionGrant({ ...base, privateKey, nowMs: nowMs + 10_000, ttlMs: 30_000 });
assert.equal(verifyBrowserConnectionGrant(notYet.token, { trustedKeys: keys, nowMs }).reason, 'grant not yet valid');

const tamperedPayload = { ...issued.payload, permissions: [] };
const tamperedSegment = Buffer.from(canonicalJson(tamperedPayload)).toString('base64url');
const tampered = `${issued.token.split('.')[0]}.${tamperedSegment}.${issued.token.split('.')[2]}`;
assert.equal(verifyBrowserConnectionGrant(tampered, { trustedKeys: keys, nowMs }).reason, 'signature invalid');
assert.equal(verifyBrowserConnectionGrant(`${issued.token}.extra`, { trustedKeys: keys, nowMs }).valid, false);
assert.equal(verifyBrowserConnectionGrant(issued.token, { trustedKeys: new Map(), nowMs }).valid, false);

const consumingReplay = createReplayStore({ now: () => nowMs });
assert.equal(verifyBrowserConnectionGrant(issued.token, { trustedKeys: keys, nowMs, replayStore: consumingReplay, consume: true }).valid, true);
assert.equal(verifyBrowserConnectionGrant(issued.token, { trustedKeys: keys, nowMs, replayStore: consumingReplay, consume: true }).reason, 'grant replayed');
assert.equal(consumingReplay.size(), 1);

const signal = issueSignalJoinToken({
  privateKey,
  issuer: base.issuer,
  roomId: 'a'.repeat(40),
  instanceId: base.instanceId,
  clientId: base.clientId,
  connectionId: base.connectionId,
  nowMs,
  ttlMs: 30_000,
  kid: base.kid,
});
const signalReplay = createReplayStore({ now: () => nowMs });
const signalOptions = {
  trustedKeys: keys,
  replayStore: signalReplay,
  nowMs,
  expectedIssuer: base.issuer,
  expectedRoomId: 'a'.repeat(40),
  expectedInstanceId: base.instanceId,
  expectedClientId: base.clientId,
  expectedConnectionId: base.connectionId,
};
assert.equal(verifySignalJoinToken(signal.token, signalOptions).valid, true);
assert.equal(verifySignalJoinToken(signal.token, signalOptions).reason, 'signal token replayed');
assert.equal(verifySignalJoinToken(signal.token, { ...signalOptions, replayStore: createReplayStore({ now: () => nowMs }), expectedRoomId: 'b'.repeat(40) }).reason, 'wrong room');
assert.equal(verifySignalJoinToken(signal.token, { ...signalOptions, replayStore: createReplayStore({ now: () => nowMs }), nowMs: nowMs + 30_000 }).reason, 'token expired');

const challenge = browserAuthChallenge({ connectionId: base.connectionId, instanceId: base.instanceId, grantJti: issued.payload.jti, serverNonce: 'nonce-1' });
assert.equal(challenge.split('\n').length, 5);
assert.equal(challenge.startsWith(`${BROWSER_CONNECTION_GRANT_DOMAIN.replace('connection-grant', 'auth')}\n`), true);
const proof = cryptoSign('sha256', Buffer.from(challenge), browserPrivateKey);
assert.equal(proof.length > 0, true);

console.log('test-browser-connection-grant: ok');
