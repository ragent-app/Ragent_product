import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { test } from 'node:test';
import { loadOrCreateInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { TEMPORARY_CONTROL_ACCESS_MS,
  buildTemporaryControlClaimMessage, buildTemporaryControlInvitationMessage,
  normalizeTemporaryControlInvitation, temporaryControlInvitationDigest,
  verifyTemporaryControlClaim, verifyTemporaryControlInvitation } from '../lib/temporary-control-protocol.mjs';
import { TEMPORARY_CONTROL_CAPABILITIES, TEMPORARY_CONTROL_SESSION_SCOPE } from '../lib/temporary-control-policy.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const now = 1_800_000_000_000;
const freshId = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'identity.json') });
  const invitation = normalizeTemporaryControlInvitation({ version: 1, invitationId: freshId('rti'),
    instanceId: identity.instanceId, instanceKeyFingerprint: identity.keyFingerprint,
    secretHash: randomBytes(32).toString('hex'), createdAt: now, claimExpiresAt: now + 120_000,
    accessDurationMs: TEMPORARY_CONTROL_ACCESS_MS, capabilities: [...TEMPORARY_CONTROL_CAPABILITIES].reverse(),
    sessionScope: TEMPORARY_CONTROL_SESSION_SCOPE });
  const envelope = { invitation, publicKey: identity.publicKey,
    signature: signWithInstanceIdentity(identity, buildTemporaryControlInvitationMessage(invitation)) };
  return { identity, envelope };
}

test('control invitation is a distinct signed protocol with a fixed ten-minute authority window', async (t) => {
  const f = await fixture(t);
  const invitation = verifyTemporaryControlInvitation(f.envelope, f.identity);
  assert.equal(invitation.accessDurationMs, 600_000);
  assert.equal(invitation.sessionScope, 'all-workbench');
  assert.deepEqual(invitation.capabilities, [...TEMPORARY_CONTROL_CAPABILITIES]);
  assert.notEqual(buildTemporaryControlInvitationMessage(invitation).includes('temporary-invitation-v1'), true);
});

test('control invitation rejects changed scope, duration, privileges and instance identity', async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { sessionScope: 'created-sessions' }, { accessDurationMs: 599_999 },
    { capabilities: TEMPORARY_CONTROL_CAPABILITIES.slice(1) },
    { capabilities: [...TEMPORARY_CONTROL_CAPABILITIES, 'owner'] }, { version: 2 },
    { instanceId: freshId('inst') },
  ]) {
    assert.throws(() => verifyTemporaryControlInvitation({ ...f.envelope,
      invitation: { ...f.envelope.invitation, ...patch } }, f.identity));
  }
});

test('a control claim is domain separated from a temporary-share claim and bound to its device key', async (t) => {
  const f = await fixture(t); const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const claim = { instanceId: f.envelope.invitation.instanceId, invitationId: f.envelope.invitation.invitationId,
    invitationDigest: temporaryControlInvitationDigest(f.envelope.invitation), requestId: freshId('rtr'),
    devicePublicKey: device.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  claim.signature = sign('sha256', Buffer.from(buildTemporaryControlClaimMessage(claim)), device.privateKey).toString('base64url');
  assert.equal(verifyTemporaryControlClaim(claim).fingerprint.length, 64);
  assert.throws(() => verifyTemporaryControlClaim({ ...claim, requestId: freshId('rtr') }));
});
