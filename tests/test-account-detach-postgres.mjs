import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Pool } from 'pg';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { createPostgresStore } from '../accounts/store/postgres.mjs';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { buildAccountSessionMessage, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';
import { loadOrCreateInstanceIdentity, publicInstanceIdentity, signOwnerAuthDeviceProof } from '../lib/instance-identity.mjs';

const url = process.env.RAGENT_ACCOUNTS_DATABASE_URL;
if (!url) { console.log('test-account-detach-postgres: skipped (no isolated database)'); process.exit(0); }
const parsed = new URL(url);
assert.equal(parsed.hostname, '127.0.0.1');
assert.equal(parsed.port, '25433');
assert.equal(parsed.pathname, '/ragent_qa_detach');
const pool = new Pool({ connectionString: url, max: 3 });
const store = createPostgresStore({ pool });
const identityFile = join(tmpdir(), `ragent-detach-test-${process.pid}.json`);
const accountId = 'acct_detach_isolated';
const broker = createOwnerAuthBroker({ store,
  verifyGoogleCredential: async () => ({ providerSubject: 'detach-user' }),
  verifyNativeGoogleCredential: async () => ({ providerSubject: 'detach-user' }),
  resolveAccount: async ({ draft }) => {
    if (!draft.accounts.some((item) => item.accountId === accountId))
      draft.accounts.push({ accountId, provider: 'google', providerSubject: 'detach-user', createdAt: new Date().toISOString() });
    return { accountId };
  },
  signAssertion: async () => 'fixture-assertion',
});
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = createDevicePublicKeyFingerprint(publicKey);
async function login(deviceId, requestId) {
  const challenge = await broker.createAccountSessionChallenge({ requestId, device: { deviceId, publicKey, alias: 'QA phone', platform: 'android' } });
  const message = buildAccountSessionMessage({ transactionId: challenge.transactionId, requestId, deviceId, publicKeyFingerprint: fingerprint, nonce: challenge.nonce });
  return broker.completeAccountSession({ transactionId: challenge.transactionId, requestId, idToken: 'qa-google', signature: sign('sha256', Buffer.from(message), keys.privateKey).toString('base64') });
}
try {
  await pool.query('truncate accounts restart identity cascade');
  const deviceId = 'adev_isolated_detach_001';
  const first = await login(deviceId, 'isolated-detach-login-0001');
  assert.equal((await pool.query('select device_id from account_devices where device_id=$1', [deviceId])).rowCount, 1);
  await broker.logoutAccountSession({ credential: first.credential.token });
  for (const table of ['account_devices', 'account_device_keys', 'account_credentials']) {
    assert.equal((await pool.query(`select 1 from ${table} where device_id=$1`, [deviceId])).rowCount, 0, table);
  }
  await assert.rejects(broker.discoverInstances({}, { credential: first.credential.token }), { code: 'owner_auth_account_credential_expired' });
  const second = await login(deviceId, 'isolated-detach-login-0002');
  assert.match(second.credential.token, /^rac_/);
  assert.equal((await pool.query('select device_id from account_devices where device_id=$1', [deviceId])).rowCount, 1);
  const instance = await loadOrCreateInstanceIdentity({ filePath: identityFile });
  const publicInstance = publicInstanceIdentity(instance);
  const now = new Date().toISOString();
  await store.mutate((draft) => {
    draft.instanceBindings.push({ instanceId: publicInstance.instanceId, accountId, provider: 'google', deviceAlias: 'QA computer',
      instancePublicKey: publicInstance.publicKey, instanceKeyFingerprint: publicInstance.keyFingerprint, boundAt: now, revokedAt: '' });
    draft.devices.push({ deviceId: publicInstance.instanceId, instanceId: publicInstance.instanceId, accountId,
      alias: 'QA computer', deviceKind: 'computer', createdAt: now, lastSeenAt: now, unboundAt: '' });
  });
  const before = await pool.query('select revision from instance_authority_revisions where instance_id=$1', [publicInstance.instanceId]);
  const fields = { transactionId: 'isolated-unbind-computer-0001', purpose: 'unbind', issuedAt: new Date().toISOString(), audience: 'ragent-owner-auth-device' };
  const proof = signOwnerAuthDeviceProof(instance, fields);
  await broker.unbindInstance({ ...fields, accountId, instance: publicInstance, signature: proof.signature });
  assert.equal((await pool.query('select 1 from instance_bindings where instance_id=$1', [publicInstance.instanceId])).rowCount, 0);
  assert.equal((await pool.query('select 1 from devices where instance_id=$1', [publicInstance.instanceId])).rowCount, 0);
  assert.equal((await pool.query('select 1 from account_devices where device_id=$1', [deviceId])).rowCount, 1, 'unrelated phone remains');
  const after = await pool.query('select revision,authority_state from instance_authority_revisions where instance_id=$1', [publicInstance.instanceId]);
  assert.ok(BigInt(after.rows[0].revision) > BigInt(before.rows[0].revision), 'unbind advances replay-protection revision');
  assert.equal(after.rows[0].authority_state.binding, null, 'authority tombstone has no account binding');
  console.log('PASS PostgreSQL: phone logout and computer unbind remove associations, protect old credentials, and permit fresh sign-in');
} finally { await pool.end(); await unlink(identityFile).catch(() => {}); }
