import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { TemporaryControlRegistry } from '../chat/temporary-control-registry.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { buildTemporaryControlClaimMessage, temporaryControlInvitationDigest } from '../lib/temporary-control-protocol.mjs';

const initial = 1_800_000_000_000;
const freshId = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-control-registry-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  let now = initial;
  const identity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'identity.json') });
  const open = () => new TemporaryControlRegistry({ filePath: join(root, 'control.json'), identity, clock: () => now });
  return { identity, registry: open(), open, advance: (milliseconds) => { now += milliseconds; } };
}

function claim(ticket, device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })) {
  const invitation = ticket.envelope.invitation;
  const input = { instanceId: invitation.instanceId, invitationId: invitation.invitationId,
    invitationDigest: temporaryControlInvitationDigest(invitation), requestId: freshId('rtr'),
    devicePublicKey: device.publicKey.export({ type: 'spki', format: 'pem' }).toString(), token: ticket.token };
  input.signature = sign('sha256', Buffer.from(buildTemporaryControlClaimMessage(input)), device.privateKey).toString('base64url');
  return { input, device };
}

test('a control grant starts its fixed ten minutes only when the computer confirms the claimed phone', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const phone = claim(ticket);
  const claimed = await f.registry.claim(phone.input);
  assert.equal(claimed.status, 'CLAIMED'); assert.equal(claimed.accessExpiresAt, null);
  f.advance(90_000);
  const active = await f.open().confirm(ticket.envelope.invitation.invitationId);
  assert.equal(active.status, 'ACTIVE'); assert.equal(active.accessExpiresAt, initial + 90_000 + 600_000);
  assert.equal((await f.open().activeGrant(active.grant.grantId, claimed.claimedDevice.deviceKeyFingerprint)).status, 'ACTIVE');
});

test('an unconfirmed control claim expires with the QR and cannot be confirmed or revived', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const phone = claim(ticket);
  await f.registry.claim(phone.input); f.advance(120_000);
  await assert.rejects(f.open().confirm(ticket.envelope.invitation.invitationId), { code: 'temporary_control_not_claimed' });
  assert.equal((await f.open().list())[0].status, 'EXPIRED');
});

test('revocation and the exact active deadline survive a cold reopen', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const phone = claim(ticket);
  const claimed = await f.registry.claim(phone.input); const active = await f.registry.confirm(ticket.envelope.invitation.invitationId);
  f.advance(600_000);
  await assert.rejects(f.open().activeGrant(active.grant.grantId, claimed.claimedDevice.deviceKeyFingerprint), { code: 'temporary_control_inactive' });
  const second = await f.open().create(); await f.open().revoke(second.envelope.invitation.invitationId);
  assert.equal((await f.open().list()).find((record) => record.invitationId === second.envelope.invitation.invitationId).status, 'REVOKED');
});

test('a valid control proof is consumed once and replay stays denied after reopening the registry', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const phone = claim(ticket);
  const claimed = await f.registry.claim(phone.input); const active = await f.registry.confirm(ticket.envelope.invitation.invitationId);
  const proof = { proofHash: 'a'.repeat(43), expiresAt: initial + 20_000 };
  assert.equal((await f.registry.consumeAccessProof({ grantId: active.grant.grantId,
    verifyProof: () => proof })).status, 'ACTIVE');
  await assert.rejects(f.open().consumeAccessProof({ grantId: active.grant.grantId,
    verifyProof: () => proof }), { code: 'temporary_control_proof_replayed' });
  const material = await f.open().accessMaterial(active.grant.grantId);
  assert.equal(material.claim.deviceKeyFingerprint, claimed.claimedDevice.deviceKeyFingerprint);
});
