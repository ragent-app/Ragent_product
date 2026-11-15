import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { handleOwnerAuthRoutes } from '../accounts/owner-auth-routes.mjs';
import { buildAccountSessionMessage, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';
import { buildOwnerAuthDeviceMessage, createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { createTurnConnectionId } from '../lib/turn-authorization.mjs';

let now = Date.parse('2026-10-25T05:00:00.123Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const accountId = 'acct_revoke_owner';
function computer() {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const keyFingerprint = createInstancePublicKeyFingerprint(publicKey);
  return { privateKey: keys.privateKey, instance: { instanceId: `inst_${keyFingerprint.slice(0, 32)}`, publicKey, keyFingerprint } };
}
const a = computer(), b = computer(), legacy = computer(), attacker = computer();
const binding = (pc) => ({ ...pc.instance, instancePublicKey: pc.instance.publicKey, instanceKeyFingerprint: pc.instance.keyFingerprint,
  accountId, provider: 'google', boundAt: iso(), revokedAt: '' });
let state = { instanceBindings: [binding(a), { ...binding(b), instancePublicKey: b.instance.publicKey.replaceAll('\n', '\r\n') },
  { instanceId: legacy.instance.instanceId, accountId, provider: 'google', boundAt: iso(), revokedAt: '' },
  { ...binding(computer()), instanceId: 'inst_arbitrary_legacy', instancePublicKey: '', instanceKeyFingerprint: '' },
  { ...binding(computer()), instanceId: 'inst_foreign', accountId: 'acct_foreign' }],
  devices: [a, b].map(pc => ({ deviceId: pc.instance.instanceId, instanceId: pc.instance.instanceId, accountId, deviceKind: 'computer', createdAt: iso() })),
  accountEntitlements: [{ accountId, plan: 'plus', source: 'fixture', expiresAt: iso(3600000) }] };
const broker = createOwnerAuthBroker({ clock: () => now, store: { mutate: async (fn) => {
  const draft = structuredClone(state); const result = await fn(draft); state = draft; return result;
} }, verifyGoogleCredential: async () => ({ sub: 'fixture' }), verifyNativeGoogleCredential: async () => ({ sub: 'fixture' }),
resolveAccount: async () => ({ accountId }), signAssertion: async () => 'unused', signTurnBrokerCapability: async () => 'unused' });
const phone = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const phoneKey = phone.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const phoneId = 'adev_revoke_phone';
const sessionRequestId = 'revoke-phone-session-0001';
const challenge = await broker.createAccountSessionChallenge({ requestId: sessionRequestId, device: { deviceId: phoneId, publicKey: phoneKey, platform: 'android' } });
const session = await broker.completeAccountSession({ transactionId: challenge.transactionId, requestId: sessionRequestId,
  signature: sign('sha256', Buffer.from(buildAccountSessionMessage({ transactionId: challenge.transactionId, requestId: sessionRequestId,
    deviceId: phoneId, publicKeyFingerprint: createDevicePublicKeyFingerprint(phoneKey), nonce: challenge.nonce })), phone.privateKey).toString('base64'), idToken: 'fixture' });
const token = session.credential.token;
function proof(pc, purpose, overrides = {}) {
  const transactionId = 'device-operation-revocation-test';
  const instance = { ...pc.instance, ...overrides };
  const fields = { instanceId: instance.instanceId, transactionId, purpose, issuedAt: iso(), audience: 'ragent-owner-auth-device' };
  return { transactionId, issuedAt: fields.issuedAt, audience: fields.audience, instance,
    signature: sign(null, Buffer.from(buildOwnerAuthDeviceMessage(fields)), pc.privateKey).toString('base64') };
}
const server = createServer((req, res) => {
  handleOwnerAuthRoutes({ req, res, pathname: req.url, broker, publicBaseUrl: base,
    googleWebClientId: 'fixture.apps.googleusercontent.com', allowInsecurePublicBaseUrl: true })
    .then(handled => { if (!handled) { res.writeHead(404); res.end('{}'); } })
    .catch(() => { res.writeHead(500); res.end('{}'); });
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/accounts`;
async function request(path, { method = 'POST', body = {}, credential = '' } = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
    ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const usage = () => request('/v1/owner-auth/account/usage', { method: 'GET', credential: token });
const revoke = id => request(`/v1/owner-auth/account/devices/${id}/revoke`, { credential: token });
const native = (pc, purpose = 'unbind', overrides = {}) => request(`/v1/owner-auth/devices/${accountId}/${purpose === 'publish-identity' ? 'identity' : purpose}`,
  { body: proof(pc, purpose, overrides) });
try {
  const lease = (id, pc, phone, status = 'reserved', offset = 60000) => ({ connectionId: id, accountId, instanceId: pc.instance.instanceId,
    deviceId: `rdev_${id}`, quotaDeviceId: phone, deviceKind: 'phone', status, createdAt: iso(), updatedAt: iso(), expiresAt: iso(offset) });
  state.turnConnectionLeases = [lease('a-one', a, phoneId), lease('a-two', a, 'adev_second', 'connected'), lease('b-one', b, phoneId, 'connected'),
    { ...lease('a-computer', a, a.instance.instanceId), deviceId: a.instance.instanceId, deviceKind: 'computer' },
    lease('a-expired', a, phoneId, 'connected', 0), { ...lease('a-released', a, phoneId, 'released'), releaseReason: 'previous' },
    { ...lease('a-foreign', a, phoneId), accountId: 'acct_foreign' }];
  state.turnConnectionLeases[0].updatedAt = iso(5000);
  assert.deepEqual((await usage()).body.turn.used, { phones: 2, computers: 2 });
  const beforeRejected = structuredClone(state);
  assert.equal((await revoke('inst_foreign')).status, 404);
  assert.equal((await request(`/v1/owner-auth/account/devices/${a.instance.instanceId}/revoke`)).status, 401);
  assert.deepEqual(state, beforeRejected, 'Rejected account requests cannot release anything');
  if (process.env.RAGENT_TEST_REVOCATION_SCENARIO !== 'quota') {
    const forged = await native(attacker, 'unbind', { instanceId: b.instance.instanceId });
    assert.equal(forged.status, 403, 'A self-signed key cannot impersonate the retained computer identity');
    assert.deepEqual(state, beforeRejected);
    assert.equal((await native(attacker, 'publish-identity', { instanceId: b.instance.instanceId })).status, 403);
    assert.deepEqual(state, beforeRejected, 'Identity publication cannot replace a retained key');
  }
  const foreign = structuredClone(state.turnConnectionLeases.at(-1));
  const historical = structuredClone(state.turnConnectionLeases.slice(4, 6));
  const unboundA = await revoke(a.instance.instanceId); assert.equal(unboundA.status, 200);
  const afterA = await usage();
  assert.deepEqual(afterA.body.turn.used, { phones: 1, computers: 1 }, 'Computer unbind must release its quota in the same transaction');
  assert.deepEqual(afterA.body.turn.connections, { active: 1, reserved: 0, connected: 1 });
  assert.equal(unboundA.body.releasedConnections, 3);
  assert.equal(state.turnConnectionLeases[0].updatedAt, iso(5000), 'Computer revocation cannot lower the retained pair clock');
  assert(state.turnConnectionLeases.filter(l => l.releaseReason === 'computer-unbound').every(l => l.instanceId === a.instance.instanceId));
  assert.deepEqual(state.turnConnectionLeases.at(-1), foreign);
  assert.deepEqual(state.turnConnectionLeases.slice(4, 6), historical, 'Expired and previously released records stay unchanged');
  const historyLength = state.bindingHistory.length; now += 1000;
  const repeated = await revoke(a.instance.instanceId);
  assert.equal(repeated.status, 404, 'removed account association is no longer present');
  assert.equal(state.bindingHistory.length, historyLength, 'Repeating the same revocation cannot create a new revocation generation');
  assert.equal((await native(a, 'publish-identity')).status, 403, 'Unbound computer cannot republish itself');
  state.devices.push({ deviceId: 'rdev_cannot_reopen', instanceId: a.instance.instanceId, accountId, deviceKind: 'phone', createdAt: iso() });
  const connectionId = createTurnConnectionId({ accountId, instanceId: a.instance.instanceId, deviceId: 'rdev_cannot_reopen' });
  const reserveFields = { ...proof(a, 'turn-reserve'), transactionId: connectionId };
  reserveFields.signature = sign(null, Buffer.from(buildOwnerAuthDeviceMessage({ instanceId: a.instance.instanceId, transactionId: connectionId,
    purpose: 'turn-reserve', issuedAt: reserveFields.issuedAt, audience: reserveFields.audience })), a.privateKey).toString('base64');
  assert.equal((await request('/v1/owner-auth/turn/connections/reserve', { body: { ...reserveFields, requestId: connectionId,
    accountId, connectionId, deviceId: 'rdev_cannot_reopen', deviceKind: 'phone', expiresAt: iso(60000) } })).status, 403);
  const unboundB = await native(b); assert.equal(unboundB.status, 200); assert.equal(unboundB.body.releasedConnections, 1);
  assert.deepEqual((await usage()).body.turn.used, { phones: 0, computers: 0 });
  assert.equal((await native(b)).status, 404);
  assert.equal((await native(legacy, 'publish-identity')).status, 200, 'Canonical legacy ID cryptographically commits to its key');
  assert.equal((await native(legacy, 'publish-identity', { instanceId: 'inst_arbitrary_legacy' })).status, 409,
    'Noncanonical keyless legacy binding needs authenticated enrollment');
  console.log('PASS computer unbind HTTP: atomic quota release, account/target isolation, expiry boundary, association deletion, native proof key binding, unbound reserve denial, safe legacy identity publication');
} finally { await new Promise(done => server.close(done)); }
