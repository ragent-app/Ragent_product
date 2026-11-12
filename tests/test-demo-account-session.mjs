import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { createDemoAccountPolicy, createDemoAccountAuth, loadDemoAccountAuth } from '../accounts/demo-credentials.mjs';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { handleOwnerAuthRoutes } from '../accounts/owner-auth-routes.mjs';
import { buildAccountSessionMessage, buildAccountJoinIntentMessage, buildAccountCredentialRefreshMessage, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';

const username = 'review-fixture', password = 'fixture-password-not-for-deployment';
const instanceId = 'inst_demo_fixture';
const policy = await createDemoAccountPolicy({ username, password, instanceId });
assert.equal(JSON.stringify(policy).includes(password), false);
assert.equal(await loadDemoAccountAuth(''), null);
assert.throws(() => createDemoAccountAuth({ ...policy, accessMode: 'invalid' }));
assert.throws(() => createDemoAccountAuth({ ...policy, accountId: 'acct_google_personal' }));
assert.throws(() => createDemoAccountAuth({ ...policy, allowedInstanceIds: ['inst_demo_fixture', 'inst_personal'] }));
let now = Date.now();
function fixture(enabled = true, accessMode = "restricted") {
  let state = {}, googleCalls = 0;
  const auth = createDemoAccountAuth({ ...policy, accessMode }, { clock: () => now });
  const store = { mutate: async fn => {
    const draft = structuredClone(state); const result = await fn(draft);
    // File/HTTP boundaries serialize broker Date values as ISO strings.
    state = JSON.parse(JSON.stringify(draft));
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  } };
  const createBroker = demoAccountAuth => createOwnerAuthBroker({ store, clock: () => now, demoAccountAuth,
    verifyGoogleCredential: async () => { googleCalls++; return { sub: 'google-owner' }; },
    resolveAccount: async () => ({ accountId: 'acct_google_personal' }), signAssertion: async () => '' });
  assert.equal(createBroker(null).demoSignInStatus, 'unconfigured');
  return { broker: createBroker(enabled ? auth : null), disabledBroker: () => createBroker(null),
    state: () => state, googleCalls: () => googleCalls };
}
async function challenge(f, suffix) {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const requestId = `request_demo_account_${suffix}`, deviceId = `adev_demo_${suffix}`;
  const result = await f.broker.createAccountSessionChallenge({ requestId, device: { deviceId, publicKey, platform: 'android' } });
  return { key, publicKey, deviceId, result, body: { username, password, transactionId: result.transactionId, requestId,
    signature: sign('sha256', Buffer.from(buildAccountSessionMessage({ transactionId: result.transactionId, requestId,
      deviceId, publicKeyFingerprint: createDevicePublicKeyFingerprint(publicKey), nonce: result.nonce })), key.privateKey).toString('base64url') } };
}
{
  const f = fixture(true, 'full'), c = await challenge(f, 'full_access');
  const session = await f.broker.completeDemoAccountSession(c.body);
  assert.equal(session.demoAccessMode, 'full');
  assert.deepEqual(await f.broker.completeDemoAccountSession(c.body), session);
  const refresh = { credentialId: session.credential.credentialId, deviceId: c.deviceId,
    requestId: 'request_demo_full_refresh', issuedAt: new Date(now).toISOString(), nonce: 'nonce_demo_full_refresh' };
  refresh.signature = sign('sha256', Buffer.from(buildAccountCredentialRefreshMessage(refresh)), c.key.privateKey).toString('base64url');
  const renewed = await f.broker.refreshAccountSession(refresh);
  assert.equal(renewed.demoAccessMode, 'full');
  await assert.rejects(f.broker.createAccountRendezvous({ requestId: 'request_demo_full_wrong_target', targetInstanceId: 'inst_personal',
    device: { deviceId: c.deviceId, publicKey: c.publicKey, devicePublicKeyFingerprint: createDevicePublicKeyFingerprint(c.publicKey) } },
    { credential: renewed.credential.token }), { code: 'owner_auth_demo_unavailable' });
}
{
  const f = fixture(false), c = await challenge(f, 'disabled');
  await assert.rejects(f.broker.completeDemoAccountSession(c.body), { code: 'owner_auth_demo_unavailable' });
  assert.equal(f.state().accountCredentials, undefined);
}
{
  const f = fixture(), c = await challenge(f, 'primary');
  await assert.rejects(f.broker.completeDemoAccountSession({ ...c.body, password: 'wrong-password-fixture' }), { code: 'owner_auth_demo_rejected' });
  await assert.rejects(f.broker.completeDemoAccountSession({ ...c.body, username: 'unknown-user' }), { code: 'owner_auth_demo_rejected' });
  await assert.rejects(f.broker.completeDemoAccountSession({ ...c.body, idToken: 'mixed' }), { statusCode: 400 });
  await assert.rejects(f.broker.completeDemoAccountSession({ ...c.body, signature: 'wrong' }), { code: 'owner_auth_account_session_signature_invalid' });
  assert.equal(f.state().accountCredentials, undefined);
  const session = await f.broker.completeDemoAccountSession(c.body);
  assert.equal(session.demoAccessMode, 'restricted');
  assert.equal(session.accountId, policy.accountId); assert.match(session.credential.token, /^rac_/);
  assert.deepEqual(await f.broker.completeDemoAccountSession(c.body), session, 'lost reply recovers the same session');
  assert.equal(f.state().accountCredentials.length, 1); assert.equal(f.googleCalls(), 0);
  for (const secret of [password, session.credential.token]) assert.equal(JSON.stringify(f.state()).includes(secret), false);
  const binding = (id, accountId) => ({ instanceId: id, accountId, revokedAt: '', deviceAlias: id });
  f.state().instanceBindings = [binding(instanceId, policy.accountId), binding('inst_personal', 'acct_google_personal')];
  assert.deepEqual((await f.broker.discoverInstances({}, { credential: session.credential.token })).instances.map(i => i.instanceId), [instanceId]);
  await assert.rejects(f.disabledBroker().discoverInstances({}, { credential: session.credential.token }), { code: 'owner_auth_demo_unavailable' });
  f.state().instanceBindings.push(binding('inst_wrong_target', policy.accountId));
  await assert.rejects(f.broker.discoverInstances({}, { credential: session.credential.token }), { code: 'owner_auth_demo_unavailable' });
  f.state().instanceBindings.pop();
  const pc = generateKeyPairSync('ed25519');
  const pcPublicKey = pc.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  Object.assign(f.state().instanceBindings[0], { instancePublicKey: pcPublicKey,
    instanceKeyFingerprint: createInstancePublicKeyFingerprint(pcPublicKey) });
  const rendezvous = await f.broker.createAccountRendezvous({ requestId: 'request_demo_correct_target', targetInstanceId: instanceId,
    device: { deviceId: c.deviceId, publicKey: c.publicKey, devicePublicKeyFingerprint: createDevicePublicKeyFingerprint(c.publicKey) } },
  { credential: session.credential.token });
  const intent = rendezvous.intent;
  const authorize = { intentId: intent.intentId, requestId: 'request_demo_correct_authorize', deviceId: intent.deviceId,
    devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint, nonce: intent.nonce, issuedAt: intent.issuedAt };
  for (const [field, value] of Object.entries(authorize)) assert.equal(typeof value, 'string', field);
  authorize.deviceSignature = sign('sha256', Buffer.from(buildAccountJoinIntentMessage({ ...authorize, instanceId,
    audience: 'agentoc-account-join' })), c.key.privateKey).toString('base64url');
  const grant = await f.broker.authorizeAccountJoinIntent(authorize, { credential: session.credential.token });
  assert.equal(grant.instanceId, instanceId); assert.match(grant.accountJoinGrant, /^rajg_/);
  await assert.rejects(f.broker.createAccountRendezvous({ requestId: 'request_demo_wrong_target', targetInstanceId: 'inst_personal',
    device: { deviceId: 'rdev_fixture', publicKey: c.publicKey, devicePublicKeyFingerprint: createDevicePublicKeyFingerprint(c.publicKey) } },
  { credential: session.credential.token }), { code: 'owner_auth_demo_unavailable' });
  const refresh = { credentialId: session.credential.credentialId, deviceId: c.deviceId,
    requestId: 'request_demo_refresh_fixture', issuedAt: new Date(now).toISOString(), nonce: 'nonce_demo_refresh_fixture' };
  refresh.signature = sign('sha256', Buffer.from(buildAccountCredentialRefreshMessage(refresh)), c.key.privateKey).toString('base64url');
  await assert.rejects(f.disabledBroker().refreshAccountSession(refresh), { code: 'owner_auth_demo_unavailable' });
  const renewed = await f.broker.refreshAccountSession(refresh);
  assert.notEqual(renewed.credential.token, session.credential.token);
  await assert.rejects(f.broker.discoverInstances({}, { credential: session.credential.token }), { statusCode: 401 });
  await f.broker.logoutAccountSession({ credential: renewed.credential.token });
  assert.ok(f.state().accountJoinGrants.every(item => Date.parse(item.expiresAt) <= now), 'demo logout retires outstanding target join grants');
  await assert.rejects(f.broker.refreshAccountSession({ ...refresh, requestId: 'request_demo_refresh_after_logout' }), { statusCode: 401 });
}
{
  const f = fixture(), c = await challenge(f, 'google_existing');
  const session = await f.broker.completeAccountSession({ ...c.body, idToken: 'google-fixture' });
  assert.equal(session.accountId, 'acct_google_personal');
  assert.equal(session.demoAccessMode, undefined);
  const second = await f.broker.createAccountSessionChallenge({ requestId: 'request_demo_existing_google_phone',
    device: { deviceId: c.deviceId, publicKey: c.publicKey } });
  const body = { username, password, requestId: 'request_demo_existing_google_phone', transactionId: second.transactionId };
  body.signature = sign('sha256', Buffer.from(buildAccountSessionMessage({ ...body, deviceId: c.deviceId,
    publicKeyFingerprint: createDevicePublicKeyFingerprint(c.publicKey), nonce: second.nonce })), c.key.privateKey).toString('base64url');
  await assert.rejects(f.broker.completeDemoAccountSession(body), { code: 'owner_auth_account_device_mismatch' });
  assert.equal(f.state().accountCredentials.length, 1, 'demo login cannot take over an existing Google installation');
  const demoId = 'adev_demo_separate_fixture';
  const third = await f.broker.createAccountSessionChallenge({ requestId: 'request_demo_separate_phone',
    device: { deviceId: demoId, publicKey: c.publicKey } });
  const separate = { username, password, requestId: 'request_demo_separate_phone', transactionId: third.transactionId };
  separate.signature = sign('sha256', Buffer.from(buildAccountSessionMessage({ ...separate, deviceId: demoId,
    publicKeyFingerprint: createDevicePublicKeyFingerprint(c.publicKey), nonce: third.nonce })), c.key.privateKey).toString('base64url');
  const demo = await f.broker.completeDemoAccountSession(separate);
  assert.equal(demo.accountId, policy.accountId);
  assert.equal(new Set(f.state().accountDeviceKeys.map(key => key.keyId)).size, 2,
    'same physical signing key has separate database keys across Google and demo accounts');
  assert.equal((await f.broker.discoverInstances({}, { credential: demo.credential.token })).instances.length, 0);
  await f.broker.logoutAccountSession({ credential: demo.credential.token });
  assert.equal((await f.broker.discoverInstances({}, { credential: session.credential.token })).instances.length, 0,
    'ending the demo does not revoke the separate Google session');
}
{
  const f = fixture(), c = await challenge(f, 'http');
  const server = createServer((req, res) => {
    handleOwnerAuthRoutes({ req, res, pathname: req.url, broker: f.broker, publicBaseUrl: 'http://127.0.0.1',
      allowInsecurePublicBaseUrl: true }).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/owner-auth/native/session/demo`;
    const post = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const bad = await post({ ...c.body, password: 'wrong-password-fixture' });
    assert.equal(bad.status, 401); assert.equal((await bad.text()).includes(password), false);
    const good = await post(c.body); assert.equal(good.status, 200); assert.equal(good.headers.get('cache-control'), 'no-store');
    assert.equal((await good.json()).accountId, policy.accountId);
  } finally { await new Promise(resolve => server.close(resolve)); }
}
{
  const auth = createDemoAccountAuth(policy, { clock: () => now });
  for (let i = 0; i < 20; i++) await assert.rejects(auth.verify({ username, password: 'wrong-password-fixture' }), { statusCode: 401 });
  await assert.rejects(auth.verify({ username, password }), { statusCode: 429 });
  now += 60_000; assert.equal((await auth.verify({ username, password })).accountId, policy.accountId);
}
console.log('PASS demo sessions: real scrypt/device signatures/HTTP, wrong credentials, fail-closed policy, Google isolation, bounded target, recovery, refresh, logout and rate limits');
