import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { createFileStore } from '../accounts/server.mjs';
import { createTemporaryClaimCipher } from '../accounts/temporary-pairing-cipher.mjs';
import { createTemporaryControlBroker } from '../accounts/temporary-control-broker.mjs';
import { TemporaryControlRegistry } from '../chat/temporary-control-registry.mjs';
import { TemporaryControlHost } from '../chat/temporary-control-host.mjs';
import { loadOrCreateInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { buildTemporaryControlBrokerMessage, verifyTemporaryControlBrokerDeviceProof } from '../lib/temporary-control-broker-protocol.mjs';
import { buildTemporaryControlClaimMessage, temporaryControlInvitationDigest } from '../lib/temporary-control-protocol.mjs';

const id = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;

async function fixture(t, bound = true) {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-control-broker-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  let now = 1_800_000_000_000;
  const identity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'identity.json') });
  const store = createFileStore(join(root, 'accounts.json'));
  await store.mutate((draft) => {
    draft.instanceBindings = bound ? [{ accountId: 'acct_control', instanceId: identity.instanceId,
      instanceKeyFingerprint: identity.keyFingerprint, boundAt: new Date(now).toISOString() }] : [];
  });
  const cipher = createTemporaryClaimCipher({ activeKeyId: 'fixture', keys: { fixture: Buffer.alloc(32, 7).toString('base64') } });
  const broker = createTemporaryControlBroker({ store, cipher, clock: () => now, issuer: 'https://accounts.example',
    signTurnBrokerCapability: async (claims) => `signed.${claims.jti}` });
  const registry = new TemporaryControlRegistry({ filePath: join(root, 'control.json'), identity, clock: () => now });
  const host = new TemporaryControlHost({ registry, clock: () => now });
  const request = (action, invitationId, payload = {}) => {
    const input = { instanceId: identity.instanceId, invitationId, requestId: id('rtr'), issuedAt: now, nonce: id('rtn'), payload };
    input.signature = signWithInstanceIdentity(identity, buildTemporaryControlBrokerMessage(action, input));
    return input;
  };
  return { broker, registry, host, identity, store, request, now: () => now, advance: (ms) => { now += ms; } };
}

for (const bound of [true, false]) test(`the v2 broker delivers confirmed ten-minute control (Google bound: ${bound})`, async (t) => {
  const f = await fixture(t, bound); const ticket = await f.registry.create(); const invitation = ticket.envelope.invitation;
  await f.broker.register(f.request('register', invitation.invitationId, { envelope: ticket.envelope }));
  const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const claim = { instanceId: invitation.instanceId, invitationId: invitation.invitationId,
    invitationDigest: temporaryControlInvitationDigest(invitation), requestId: id('rtr'),
    devicePublicKey: device.publicKey.export({ type: 'spki', format: 'pem' }).toString(), token: ticket.token };
  claim.signature = sign('sha256', Buffer.from(buildTemporaryControlClaimMessage(claim)), device.privateKey).toString('base64url');
  assert.equal((await f.broker.claim(claim)).status, 'CLAIMED');
  const inbox = await f.broker.inbox(f.request('inbox', invitation.invitationId));
  assert.equal(inbox.claim.token, ticket.token);
  assert.match(inbox.claim.deviceKeyFingerprint, /^[a-f0-9]{64}$/);
  await f.registry.claim(inbox.claim);
  await assert.rejects(f.broker['turn-reserve'](f.request('turn-reserve', invitation.invitationId)),
    { code: 'temporary_control_broker_inactive' });
  const active = await f.registry.confirm(invitation.invitationId);
  const credential = await f.host.credentialForGrant(active.grant.grantId);
  const payload = { grant: active.grant, accessCredential: credential };
  await f.broker.complete(f.request('complete', invitation.invitationId, payload));
  assert.equal((await f.broker.complete(f.request('complete', invitation.invitationId, payload))).accessExpiresAt, active.accessExpiresAt);
  assert.equal((await f.broker.inbox(f.request('inbox', invitation.invitationId))).claim, null);
  const result = { instanceId: invitation.instanceId, invitationId: invitation.invitationId, requestId: claim.requestId,
    issuedAt: f.now(), nonce: id('rtn'), payload: {} };
  result.signature = sign('sha256', Buffer.from(buildTemporaryControlBrokerMessage('result', result)), device.privateKey).toString('base64url');
  verifyTemporaryControlBrokerDeviceProof('result', result, claim.devicePublicKey, f.now());
  const delivered = await f.broker.result(result);
  assert.equal(delivered.status, 'ACTIVE'); assert.equal(delivered.completion.grant.grantId, active.grant.grantId);
  assert.equal(delivered.completion.accessCredential.access_token, credential.access_token);
  const reservation = await f.broker['turn-reserve'](f.request('turn-reserve', invitation.invitationId));
  assert.equal(reservation.lease.deviceId, active.grant.deviceId);
  assert.equal(Date.parse(reservation.lease.expiresAt), active.accessExpiresAt);
  assert.equal(reservation.brokerCredential.scope, 'turn:mint:temporary');
  if (!bound) {
    assert.match(reservation.lease.accountId, /^temporary_[a-f0-9]{64}$/);
    assert.equal(await f.store.mutate((draft) => draft.instanceBindings.length), 0, 'temporary relay must not create a Google account binding');
  }
  const connectionRequestId = id('rtr');
  const deviceRequest = (action) => {
    const input = { instanceId: invitation.instanceId, invitationId: invitation.invitationId, requestId: claim.requestId,
      issuedAt: f.now(), nonce: id('rtn'), payload: { connectionRequestId } };
    input.signature = sign('sha256', Buffer.from(buildTemporaryControlBrokerMessage(action, input)), device.privateKey).toString('base64url');
    return input;
  };
  assert.equal((await f.broker.connect(deviceRequest('connect'))).connectionStatus, 'PENDING');
  assert.equal((await f.broker.inbox(f.request('inbox', invitation.invitationId))).connectionRequestId, connectionRequestId);
  assert.equal((await f.broker['connection-result'](deviceRequest('connection-result'))).connection, null);
  const connection = { instanceId: invitation.instanceId, invitationId: invitation.invitationId,
    grantId: active.grant.grantId, deviceId: active.grant.deviceId, connectionRequestId,
    connectionId: reservation.lease.connectionId, expiresAt: credential.expires_at, testData: 'secret carrier material' };
  const publish = f.request('connection-publish', invitation.invitationId, { connectionRequestId, connection });
  assert.equal((await f.broker['connection-publish'](publish)).connectionStatus, 'READY');
  const saved = await f.store.mutate((draft) => draft.temporaryControlExchanges[0]);
  assert.equal(JSON.stringify(saved).includes('secret carrier material'), false);
  const deliveredConnection = await f.broker['connection-result'](deviceRequest('connection-result'));
  assert.deepEqual(deliveredConnection.connection.payload.connection, connection);
  const bad = f.request('connection-publish', invitation.invitationId, { connectionRequestId,
    connection: { ...connection, deviceId: id('rdev') } });
  await assert.rejects(f.broker['connection-publish'](bad), { code: 'temporary_control_broker_connection_invalid' });
  await assert.rejects(f.broker.result(result), { code: 'temporary_control_broker_proof_replayed' });
  await f.registry.revoke(invitation.invitationId);
  // The broker state is independently revocable by the desktop-side service;
  // the carrier also revalidates the local registry on every request.
  await f.broker.revoke(f.request('revoke', invitation.invitationId));
  const lease = await f.store.mutate((draft) => bound
    ? draft.turnConnectionLeases.find((entry) => entry.connectionId === reservation.lease.connectionId)
    : draft.temporaryControlExchanges.find((entry) => entry.invitationId === invitation.invitationId).turn.lease);
  assert.equal(lease.status, 'released');
  result.nonce = id('rtn');
  result.signature = sign('sha256', Buffer.from(buildTemporaryControlBrokerMessage('result', result)), device.privateKey).toString('base64url');
  await assert.rejects(f.broker.result(result), { code: 'temporary_control_broker_inactive' });
});

test('anonymous quota is shared by the instance exchanges and released without account lease rows', async (t) => {
  const f = await fixture(t, false);
  async function activePhone() {
    const ticket = await f.registry.create(); const invitation = ticket.envelope.invitation;
    await f.broker.register(f.request('register', invitation.invitationId, { envelope: ticket.envelope }));
    const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const claim = { instanceId: invitation.instanceId, invitationId: invitation.invitationId,
      invitationDigest: temporaryControlInvitationDigest(invitation), requestId: id('rtr'), token: ticket.token,
      devicePublicKey: device.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    claim.signature = sign('sha256', Buffer.from(buildTemporaryControlClaimMessage(claim)), device.privateKey).toString('base64url');
    await f.broker.claim(claim); await f.registry.claim(claim);
    const active = await f.registry.confirm(invitation.invitationId);
    await f.broker.complete(f.request('complete', invitation.invitationId, { grant: active.grant,
      accessCredential: await f.host.credentialForGrant(active.grant.grantId) }));
    return invitation.invitationId;
  }
  const first = await activePhone(); const second = await activePhone();
  await f.broker['turn-reserve'](f.request('turn-reserve', first));
  await f.store.mutate((draft) => {
    const old = draft.temporaryControlExchanges.find((entry) => entry.invitationId === first);
    draft.turnConnectionLeases = [old.turn.lease]; delete old.turn.lease;
  });
  await assert.rejects(f.broker['turn-reserve'](f.request('turn-reserve', second)), { code: 'temporary_control_broker_turn_quota_exceeded' });
  await f.broker.revoke(f.request('revoke', first));
  assert.equal((await f.broker['turn-reserve'](f.request('turn-reserve', second))).lease.status, 'reserved');
  assert.deepEqual(await f.store.mutate((draft) => draft.turnConnectionLeases || []), []);
  assert.deepEqual(await f.store.mutate((draft) => draft.instanceBindings), []);
  f.advance(600_000);
  await assert.rejects(f.broker['turn-reserve'](f.request('turn-reserve', second)), { code: 'temporary_control_broker_inactive' });
  assert.equal(await f.store.mutate((draft) => draft.temporaryControlExchanges.find((entry) => entry.invitationId === second).turn.lease.status), 'released');
});

test('replacing the desktop account binding revokes its pending control exchange', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const invitation = ticket.envelope.invitation;
  await f.broker.register(f.request('register', invitation.invitationId, { envelope: ticket.envelope }));
  await f.store.mutate((draft) => { draft.instanceBindings[0].accountId = 'acct_new_owner'; });
  await assert.rejects(f.broker.inbox(f.request('inbox', invitation.invitationId)), { code: 'temporary_control_broker_binding_mismatch' });
  const stored = await f.store.mutate((draft) => draft.temporaryControlExchanges[0]);
  assert.equal(stored.status, 'REVOKED');
});

test('the v2 broker expires an unconfirmed claim and never exposes its token to the phone', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const invitation = ticket.envelope.invitation;
  await f.broker.register(f.request('register', invitation.invitationId, { envelope: ticket.envelope }));
  const device = generateKeyPairSync('ed25519');
  const claim = { instanceId: invitation.instanceId, invitationId: invitation.invitationId,
    invitationDigest: temporaryControlInvitationDigest(invitation), requestId: id('rtr'),
    devicePublicKey: device.publicKey.export({ type: 'spki', format: 'pem' }).toString(), token: ticket.token };
  claim.signature = sign(null, Buffer.from(buildTemporaryControlClaimMessage(claim)), device.privateKey).toString('base64url');
  await f.broker.claim(claim); f.advance(120_000);
  await assert.rejects(f.broker.inbox(f.request('inbox', invitation.invitationId)), { code: 'temporary_control_broker_inactive' });
  const phoneResult = { instanceId: invitation.instanceId, invitationId: invitation.invitationId, requestId: claim.requestId,
    issuedAt: f.now(), nonce: id('rtn'), payload: {} };
  phoneResult.signature = sign(null, Buffer.from(buildTemporaryControlBrokerMessage('result', phoneResult)), device.privateKey).toString('base64url');
  await assert.rejects(f.broker.result(phoneResult), { code: 'temporary_control_broker_inactive' });
  const rollbackProof = f.request('inbox', invitation.invitationId);
  f.advance(-120_000);
  await assert.rejects(f.broker.inbox(rollbackProof), { code: 'temporary_control_broker_inactive' });
});

test('anonymous invitation pins its key and cannot survive conversion to an account binding', async (t) => {
  const f = await fixture(t, false);
  const ticket = await f.registry.create();
  const invitationId = ticket.envelope.invitation.invitationId;
  const other = generateKeyPairSync('ed25519');
  const substituted = { ...ticket.envelope, publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  await assert.rejects(f.broker.register(f.request('register', invitationId, { envelope: substituted })),
    { code: 'temporary_control_identity_mismatch' });
  await f.broker.register(f.request('register', invitationId, { envelope: ticket.envelope }));
  await f.store.mutate((draft) => { draft.instanceBindings.push({ accountId: 'acct_new', instanceId: f.identity.instanceId,
    instanceKeyFingerprint: f.identity.keyFingerprint, boundAt: new Date(f.now()).toISOString() }); });
  await assert.rejects(f.broker.inbox(f.request('inbox', invitationId)), { code: 'temporary_control_broker_inactive' });
  assert.equal(await f.store.mutate((draft) => draft.temporaryControlExchanges[0].status), 'REVOKED');
});
