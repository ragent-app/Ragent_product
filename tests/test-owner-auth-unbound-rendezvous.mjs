import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-unbound-rendezvous-'));
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_ACCOUNTS_URL = 'https://accounts.example.test';
delete process.env.RAGENT_INSTANCE_ROOT;
try {
  const { pollOwnerAccountRendezvous } = await import('../lib/owner-account-auth.mjs');
  const { createTrustedDeviceInvitation, hasPendingTrustedDeviceAccountClaimTicket,
    hasTrustedDeviceAccountClaimTicket, invalidatePendingTrustedDeviceInvitations } = await import('../chat/trusted-devices.mjs');
  let inboxCalls = 0;
  const options = { buildBootstrap: async () => ({}), fetchImpl: async () => {
    inboxCalls++;
    return { ok: true, status: 200, json: async () => ({ intent: null, grant: null }) };
  } };
  assert.deepEqual(await pollOwnerAccountRendezvous(options), { handled: false, reason: 'not-bound' });
  assert.equal(inboxCalls, 0, 'an idle unbound computer does not poll');
  const invitation = await createTrustedDeviceInvitation();
  assert.equal(await hasPendingTrustedDeviceAccountClaimTicket(), true);
  assert.deepEqual(await pollOwnerAccountRendezvous(options), { handled: false, reason: 'pending' });
  assert.equal(inboxCalls, 1, 'a live ordinary QR enables unbound inbox polling');

  for (const hash of ['', 'a'.repeat(64)]) {
    const result = await pollOwnerAccountRendezvous({ ...options, fetchImpl: async () => ({
      ok: true, status: 200, json: async () => ({ intent: { accountClaimTokenHash: hash },
        grant: { accountJoinGrant: 'grant', deviceSignature: 'signature' } }),
    }) });
    assert.equal(result.reason, 'claim-ticket-mismatch', 'an unbound target requires its exact local QR secret');
  }
  const tokenHash = createHash('sha256').update(invitation.token).digest('hex');
  let reachedAccountCompletion = false;
  await assert.rejects(pollOwnerAccountRendezvous({ ...options, fetchImpl: async (url) => {
    if (String(url).endsWith('/inbox')) return { ok: true, status: 200, json: async () => ({
      intent: { intentId: 'rji_unbound_test', deviceId: 'rdev_unbound_test', accountClaimTokenHash: tokenHash,
        requestId: 'rendezvous_unbound_test', nonce: 'nonce', issuedAt: new Date().toISOString() },
      grant: { accountJoinGrant: 'grant', deviceSignature: 'signature' },
    }) };
    reachedAccountCompletion = true;
    throw new Error('completion boundary reached');
  } }), { code: 'owner_auth_broker_unavailable' });
  assert.equal(reachedAccountCompletion, true, 'the live QR reaches existing signed Accounts assertion verification');

  const stateFile = join(root, 'config', 'trusted-devices.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.invitations[0].expiresAt = new Date(0).toISOString();
  await writeFile(stateFile, JSON.stringify(state));
  assert.equal(await hasPendingTrustedDeviceAccountClaimTicket(), false);
  assert.equal((await pollOwnerAccountRendezvous(options)).reason, 'not-bound');
  assert.equal(inboxCalls, 1, 'expired QR stops unbound polling');
  const cancelled = await createTrustedDeviceInvitation();
  const cancelledHash = createHash('sha256').update(cancelled.token).digest('hex');
  assert.equal(await hasTrustedDeviceAccountClaimTicket(cancelledHash), true);
  assert.equal(await invalidatePendingTrustedDeviceInvitations(), 1);
  assert.equal(await hasTrustedDeviceAccountClaimTicket(cancelledHash), false);
  assert.equal(await hasPendingTrustedDeviceAccountClaimTicket(), false);
  assert.equal(await invalidatePendingTrustedDeviceInvitations(), 0);
  await createTrustedDeviceInvitation();
  assert.equal(await hasPendingTrustedDeviceAccountClaimTicket(), true, 'fresh owner consent works after cancelling old QR');
  console.log('test-owner-auth-unbound-rendezvous: passed');
} finally {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  await rm(root, { recursive: true, force: true });
}
