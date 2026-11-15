import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { TemporaryControlRegistry } from '../chat/temporary-control-registry.mjs';
import { TemporaryControlHost } from '../chat/temporary-control-host.mjs';
import { TemporaryControlConnectionService } from '../chat/temporary-control-connection-service.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { buildTemporaryControlClaimMessage, temporaryControlInvitationDigest } from '../lib/temporary-control-protocol.mjs';
import { createTurnConnectionId } from '../lib/turn-authorization.mjs';
import { temporaryControlRelayPrincipal } from '../lib/temporary-control-broker-protocol.mjs';

const id = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;

for (const bound of [true, false]) test(`control carrier resumes and revokes (Google bound: ${bound})`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-control-carrier-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const now = 1_800_000_000_000;
  const identity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'identity.json') });
  const registry = new TemporaryControlRegistry({ filePath: join(root, 'registry.json'), identity, clock: () => now });
  const host = new TemporaryControlHost({ registry, clock: () => now });
  const ticket = await registry.create(); const invitation = ticket.envelope.invitation;
  const phone = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const claim = { instanceId: invitation.instanceId, invitationId: invitation.invitationId,
    invitationDigest: temporaryControlInvitationDigest(invitation), requestId: id('rtr'), token: ticket.token,
    devicePublicKey: phone.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  claim.signature = sign('sha256', Buffer.from(buildTemporaryControlClaimMessage(claim)), phone.privateKey).toString('base64url');
  await registry.claim(claim);
  const active = await registry.confirm(invitation.invitationId); const grantId = active.grant.grantId;
  const relayPrincipal = bound ? 'acct_control' : temporaryControlRelayPrincipal(identity.instanceId, identity.keyFingerprint);
  const connectionId = createTurnConnectionId({ accountId: relayPrincipal, instanceId: identity.instanceId, deviceId: active.grant.deviceId });
  const requestId = id('rtr'); let mintCount = 0; let starts = 0; let stops = 0; let published;
  const client = { request: async (action, _invitationId, payload) => {
    if (action === 'turn-reserve') return { status: 'ACTIVE', accessExpiresAt: active.accessExpiresAt,
      lease: { accountId: relayPrincipal, instanceId: identity.instanceId, deviceId: active.grant.deviceId,
        connectionId, deviceKind: 'phone', status: 'reserved', expiresAt: new Date(active.accessExpiresAt).toISOString() },
      authorization: { authorized: true, connectionId }, brokerCredential: { scope: 'turn:mint:temporary', connectionId,
        credentialExpiresAt: new Date(active.accessExpiresAt).toISOString(), token: 'token', idempotencyKey: 'key' } };
    assert.equal(action, 'connection-publish');
    if (!published) { published = structuredClone(payload); throw new Error('response lost'); }
    assert.deepEqual(payload, published);
    return { connectionStatus: 'READY', connectionRequestId: requestId };
  } };
  const options = { registry, host, client, binding: async () => bound ? ({ accountId: 'acct_control' }) : null,
    brokerUrl: 'https://turn.example', signalingEndpoint: 'https://signal.example/', clock: () => now,
    mint: async () => { mintCount++; return { expiresAt: new Date(active.accessExpiresAt).toISOString(),
      iceServers: [{ urls: 'turn:turn.example:3478', username: 'user', password: 'secret' }] }; },
    ingress: async (device) => { assert.equal(device.grantId, grantId); return () => {}; },
    startCarrier: async (carrier) => { starts++; assert.equal(carrier.temporaryControlDevice.deviceId, active.grant.deviceId);
      return { ready: Promise.resolve(), done: new Promise(() => {}), temporaryBusinessReady: true, stop: () => { stops++; } }; } };
  const first = new TemporaryControlConnectionService(options);
  await assert.rejects(first.activate(grantId, requestId), /response lost/);
  first.close();
  const second = new TemporaryControlConnectionService(options);
  const connection = await second.activate(grantId, requestId);
  assert.deepEqual(connection, published.connection);
  assert.equal(mintCount, 1); assert.equal(starts, 2);
  await registry.revoke(invitation.invitationId);
  await assert.rejects(second.activate(grantId, requestId), { code: 'temporary_control_inactive' });
  second.close(); assert.equal(stops, 2);
});
