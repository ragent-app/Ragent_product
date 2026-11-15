import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'ragent-auto-account-'));
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.RAGENT_INSTANCE_ROOT;
try {
  const devices = await import('../chat/trusted-devices.mjs');
  const { loadOrCreateInstanceIdentity } = await import('../lib/instance-identity.mjs');
  const { AccountPairingService, startAccountPairingPoller } = await import('../chat/account-pairing-service.mjs');
  const identity = await loadOrCreateInstanceIdentity();
  let now = Date.now(); let activeAccount = 'acct_automatic_owner'; let status = 'CLAIMED'; let calls = [];
  let approved; const done = new Promise((resolve) => { approved = resolve; });
  const options = { identity, clock: () => now, binding: async () => ({ accountId: activeAccount }),
    createInvitation: devices.createTrustedDeviceInvitation, getInvitation: devices.getLocalAccountPairingInvitation,
    consumeInvitation: devices.consumeLocalAccountPairingInvitation, listPendingInvitations: devices.listPendingAccountPairingInvitations,
    client: { request: async (action, id, payload) => {
      calls.push(action);
      if (action === 'approve') { assert.ok(payload.desktopProof.signature); status = 'APPROVED'; approved(); }
      if (action === 'revoke') status = 'REVOKED';
      return { invitationId: id, status: action === 'register' ? 'PENDING' : status,
        claim: { transactionId: 'transaction_fixture_0001', requestId: 'request_fixture_0001', deviceId: 'adev_fixture_0001', publicKeyFingerprint: 'a'.repeat(64), nonce: 'nonce_fixture_0001' } };
    } } };
  await devices.createTrustedDeviceInvitation();
  assert.equal((await devices.listPendingAccountPairingInvitations()).length, 0, 'old invitations carry no automatic account consent');
  const first = await new AccountPairingService(options).create();
  assert.equal(new URL(first.pairingUri).searchParams.get('accountType'), 'google');
  const local = await devices.getLocalAccountPairingInvitation(first.id);
  assert.equal(local.accountHandoffAccountId, activeAccount);
  assert.equal((await readFile(join(root, 'config', 'trusted-devices.json'), 'utf8')).includes(new URL(first.pairingUri).searchParams.get('t')), false);
  // A new service reads the durable consent; the original page/service no longer exists.
  const resumed = new AccountPairingService(options); calls = [];
  const stop = await startAccountPairingPoller({ getService: async () => resumed, intervalMs: 10, onError: (error) => { throw error; } });
  let timeout;
  try { await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('automatic handoff did not run')), 3000); })]); }
  finally { stop(); clearTimeout(timeout); }
  await resumed.serialize(first.id, async () => {}); // drain the completing tick
  assert.equal((await devices.listPendingAccountPairingInvitations()).length, 0);
  assert.equal(calls.filter((action) => action === 'approve').length, 1);
  calls = []; await resumed.pollPending(); assert.deepEqual(calls, [], 'completed invitations stop network polling');
  status = 'CLAIMED'; const cancel = await resumed.create(); await resumed.revoke(cancel.id);
  calls = []; await resumed.pollPending(); assert.deepEqual(calls, [], 'cancellation persists across background ticks');
  status = 'CLAIMED'; const expired = await resumed.create(); now = Date.parse(expired.expiresAt);
  calls = []; await resumed.pollPending(); assert.deepEqual(calls, [], 'exact deadline cannot auto-authorize');
  now = Date.now(); await devices.consumeLocalAccountPairingInvitation(expired.id);
  const fail = new AccountPairingService({ ...options, client: { request: async () => { throw new Error('registration failed'); } } });
  await assert.rejects(fail.create(), /registration failed/);
  assert.equal((await devices.listPendingAccountPairingInvitations()).length, 0, 'failed registration leaves no automatic invitation');
  activeAccount = 'acct_demo_' + 'a'.repeat(48);
  const demo = await resumed.create();
  assert.equal(new URL(demo.pairingUri).searchParams.get('accountType'), 'demo');
  await resumed.revoke(demo.id);
  console.log('PASS automatic QR handoff: persisted consent, background restart recovery, no UI, single approval, cancellation, exact expiry, failed registration');
} finally {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true });
}
