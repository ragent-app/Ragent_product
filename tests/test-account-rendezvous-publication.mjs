import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] || '.');
const { createOwnerAuthBroker } = await import(pathToFileURL(resolve(root, 'accounts/owner-auth-broker.mjs')));
const { buildAccountSessionMessage, buildAccountJoinIntentMessage, createDevicePublicKeyFingerprint } =
  await import(pathToFileURL(resolve(root, 'lib/device-auth-protocol.mjs')));
const { buildAccountJoinIntentProofMessage, buildAccountRendezvousPollMessage, createInstancePublicKeyFingerprint } =
  await import(pathToFileURL(resolve(root, 'lib/instance-proof-protocol.mjs')));

let now = Date.parse('2026-10-24T08:00:00Z');
let state = {};
// Errors roll back the draft, matching the production store boundary.
const store = { mutate: async fn => {
  const draft = structuredClone(state);
  const result = await fn(draft);
  state = JSON.parse(JSON.stringify(draft));
  return JSON.parse(JSON.stringify(result));
} };
const broker = createOwnerAuthBroker({ store, clock: () => now,
  verifyGoogleCredential: async () => { throw new Error('Browser Google is not used by this fixture'); },
  verifyNativeGoogleCredential: async ({ idToken }) => ({ providerSubject: idToken }),
  resolveAccount: async ({ googleIdentity }) => ({ accountId: `acct_${googleIdentity.providerSubject}` }),
  signAssertion: async () => 'fixture-account-assertion',
});
const targetKeys = generateKeyPairSync('ed25519');
const publicKey = targetKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const instance = { instanceId: 'inst_rendezvous_publication', publicKey,
  keyFingerprint: createInstancePublicKeyFingerprint(publicKey) };

async function phone(suffix, account = 'owner') {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const deviceId = `adev_publication_${suffix}`;
  const fingerprint = createDevicePublicKeyFingerprint(publicKey);
  const requestId = `publication_session_${suffix}`;
  const device = { deviceId, publicKey, platform: 'android', alias: 'QA phone' };
  const challenge = await broker.createAccountSessionChallenge({ requestId, device });
  const signature = sign('sha256', Buffer.from(buildAccountSessionMessage({
    transactionId: challenge.transactionId, requestId, deviceId, publicKeyFingerprint: fingerprint,
    nonce: challenge.nonce,
  })), keys.privateKey).toString('base64');
  const session = await broker.completeAccountSession({ transactionId: challenge.transactionId,
    requestId, idToken: account, signature });
  return { keys, device, fingerprint, credential: session.credential.token };
}
const owner = await phone('owner');
const otherPhone = await phone('second');
const foreign = await phone('foreign', 'foreign');
state.instanceBindings = [{ ...instance, instancePublicKey: publicKey,
  instanceKeyFingerprint: instance.keyFingerprint, accountId: 'acct_owner',
  boundAt: new Date(now).toISOString(), revokedAt: '', publicEndpoint: '', deviceAlias: 'QA computer' }];
async function inbox() {
  const issuedAt = new Date(now).toISOString();
  const audience = 'ragent-account-rendezvous-poll';
  const signature = sign(null, Buffer.from(buildAccountRendezvousPollMessage({
    instanceId: instance.instanceId, requestId: 'inbox', issuedAt, audience,
  })), targetKeys.privateKey).toString('base64url');
  return broker.pollAccountRendezvousInbox({ instance, issuedAt, audience, requestId: 'inbox', signature });
}
assert.deepEqual(await inbox(), { intent: null, grant: null });
const activityAt = state.instanceBindings[0].lastSeenAt;
now += 1_000;
await inbox();
assert.equal(state.instanceBindings[0].lastSeenAt, activityAt);
now += 5 * 60_000;
await inbox();
assert.equal(state.instanceBindings[0].lastSeenAt, new Date(now).toISOString());

async function offer(suffix) {
  const requestId = `publication_rendezvous_${suffix}`;
  const { intent } = await broker.createAccountRendezvous({ requestId, targetInstanceId: instance.instanceId,
    device: { ...owner.device, devicePublicKeyFingerprint: owner.fingerprint } }, owner);
  const proof = { intentId: intent.intentId, requestId, deviceId: intent.deviceId,
    devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint, nonce: intent.nonce,
    issuedAt: intent.issuedAt,
    deviceSignature: sign('sha256', Buffer.from(buildAccountJoinIntentMessage({
      ...intent, audience: 'ragent-account-join',
    })), owner.keys.privateKey).toString('base64') };
  for (const [field, min] of Object.entries({ intentId: 8, requestId: 16, deviceId: 8,
    devicePublicKeyFingerprint: 64, nonce: 16, issuedAt: 20, deviceSignature: 1 })) {
    assert.ok(typeof proof[field] === 'string' && proof[field].length >= min, `Missing ${field}`);
  }
  const grant = await broker.authorizeAccountJoinIntent(proof, owner);
  assert.equal(grant.rendezvousGrantSubmitted, true);
  const stored = state.accountJoinIntents.find(x => x.intentId === intent.intentId);
  assert.equal(stored.rendezvousGrant, grant.accountJoinGrant);
  assert.equal(stored.rendezvousDeviceSignature, proof.deviceSignature);
  assert.equal(stored.status, 'rendezvous_offered');
  return { requestId, intent, proof, grant,
    confirmation: { requestId, accountJoinGrant: grant.accountJoinGrant } };
}
const abandoned = (await broker.createAccountRendezvous({ requestId: 'publication_abandoned_before_grant',
  targetInstanceId: instance.instanceId, device: { ...owner.device, devicePublicKeyFingerprint: owner.fingerprint } }, owner)).intent;
assert.deepEqual(await inbox(), {intent:null,grant:null}, 'An abandoned ungranted intent is not actionable');
const first = await offer('first');
assert.equal((await inbox()).intent.intentId, first.intent.intentId,
  'An earlier phone process dying before authorization must not block a ready reconnect');
assert.equal(state.accountJoinIntents.find(intent => intent.intentId === abandoned.intentId).status, 'rendezvous_pending');
const second = await offer('second');
await assert.rejects(broker.submitAccountRendezvousGrant({ ...first.confirmation,
  accountJoinGrant: second.grant.accountJoinGrant }, owner), { code: 'owner_auth_account_join_grant_invalid' });
await assert.rejects(broker.submitAccountRendezvousGrant(first.confirmation, otherPhone),
  { code: 'owner_auth_account_join_grant_invalid' });
await assert.rejects(broker.submitAccountRendezvousGrant(first.confirmation, foreign),
  { code: 'owner_auth_rendezvous_expired' });
assert.deepEqual(await broker.submitAccountRendezvousGrant(first.confirmation, owner),
  { ok: true, requestId: first.requestId });

const issuedAt = new Date(now).toISOString();
const completion = { intentId: first.intent.intentId, requestId: 'publication_pc_complete_first',
  nonce: first.intent.nonce, deviceIssuedAt: first.intent.issuedAt,
  device: { deviceId: first.intent.deviceId, devicePublicKeyFingerprint: owner.fingerprint },
  deviceSignature: first.proof.deviceSignature, accountJoinGrant: first.grant.accountJoinGrant,
  instance, publicEndpoint: '', issuedAt, audience: 'ragent-account-join',
  signature: sign(null, Buffer.from(buildAccountJoinIntentProofMessage({ instanceId: instance.instanceId,
    intentId: first.intent.intentId, deviceId: first.intent.deviceId,
    devicePublicKeyFingerprint: owner.fingerprint, nonce: first.intent.nonce, issuedAt,
    audience: 'ragent-account-join', publicEndpoint: '' })), targetKeys.privateKey).toString('base64url') };
await broker.completeAccountJoinIntent(completion);
const before = structuredClone(state.accountJoinIntents.find(x => x.intentId === first.intent.intentId));
assert.ok(before.completedAt);
assert.equal(before.rendezvousGrant, '');
assert.ok(state.accountJoinGrants.find(x => x.intentId === first.intent.intentId).redeemedAt);
// The exact late legacy confirmation is an ACK, including after grant expiry;
// it cannot republish, reopen, extend deadlines or create another grant.
const count = state.accountJoinGrants.length;
now = Date.parse(first.grant.expiresAt) + 1;
assert.deepEqual(await broker.submitAccountRendezvousGrant(first.confirmation, owner),
  { ok: true, requestId: first.requestId });
assert.deepEqual(state.accountJoinIntents.find(x => x.intentId === first.intent.intentId), before);
assert.equal(state.accountJoinGrants.length, count);
await assert.rejects(broker.submitAccountRendezvousGrant(second.confirmation, owner),
  { code: 'owner_auth_account_join_grant_invalid' });
const third = await offer('after_expired_offer');
assert.equal((await inbox()).intent.intentId, third.intent.intentId,
  'An old offered intent with an expired grant must not block a fresh reconnect');
await assert.rejects(broker.submitAccountRendezvousGrant({ ...first.confirmation,
  accountJoinGrant: 'raj_wrong_material' }, owner), { code: 'owner_auth_account_join_grant_invalid' });
state.accountDevices.find(x => x.deviceId === owner.device.deviceId).revokedAt = new Date(now).toISOString();
await assert.rejects(broker.submitAccountRendezvousGrant(first.confirmation, owner),
  error => error.statusCode === 401 || error.statusCode === 403 || error.status === 401 || error.status === 403);
assert.deepEqual(state.accountJoinIntents.find(x => x.intentId === first.intent.intentId), before);
console.log('test-account-rendezvous-publication: atomic offer, exact legacy ACK, expiry/isolation/revocation, bounded idle activity PASS');
