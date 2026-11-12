import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createPostgresStore } from '../accounts/store/postgres.mjs';
import { issueInstanceAccessGrant, revokeInstanceAccessGrant } from '../accounts/instance-access-grants.mjs';
import { createInstancePublicKeyFingerprint, buildAccountJoinIntentProofMessage } from '../lib/instance-proof-protocol.mjs';
import { normalizeDevicePublicKey, createDevicePublicKeyFingerprint, buildAccountJoinIntentMessage } from '../lib/device-auth-protocol.mjs';
import { inboxWaitFixture } from './fixtures/rendezvous-inbox-wait.mjs';

const url = process.env.AGENTOC_ACCOUNTS_ISOLATED_TEST_DATABASE_URL;
test('PostgreSQL shared join keeps owner authority and rejects revoked or replaced grants', { skip: !url }, async t => {
  assert.match(new URL(url).pathname.slice(1), /^qa_rendezvous_[a-f0-9]{24}$/);
  const schema = `qa_shared_${randomBytes(12).toString('hex')}`;
  const pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema} -c statement_timeout=15000` });
  let created = false;
  t.after(async () => { try { if (created) await pool.query(`drop schema "${schema}" cascade`); } finally { await pool.end(); } });
  await pool.query(`create schema "${schema}"`); created = true;
  const dir = new URL('../accounts/migrations/', import.meta.url);
  for (const name of (await readdir(dir)).filter(x => x.endsWith('.up.sql')).sort()) {
    const sql = await readFile(new URL(name, dir), 'utf8');
    assert(!/\bpublic\s*\.|\b(?:create\s+extension|alter\s+system|drop\s+schema|create\s+database)\b/i.test(sql));
    await pool.query(sql);
  }
  const store = createPostgresStore({ schema, enableScopedRendezvousCreation: true, pool });
  const now = Date.now(), fixture = await inboxWaitFixture({ store, clock: () => now });
  const hostKeys = generateKeyPairSync('ed25519'), phoneKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const hostKey = hostKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const instance = { instanceId: 'inst_shared_pg_fixture', publicKey: hostKey, keyFingerprint: createInstancePublicKeyFingerprint(hostKey) };
  const phoneKey = normalizeDevicePublicKey(phoneKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const fingerprint = createDevicePublicKeyFingerprint(phoneKey.publicKey), accountId = 'acct_shared_pg_member', deviceId = 'adev_shared_pg_phone';
  const token = `rac_${randomBytes(32).toString('base64url')}`, at = new Date(now).toISOString();
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const access = await store.mutate(draft => {
    draft.accounts.push({ accountId, provider: 'google', providerSubject: 'shared-pg-member', createdAt: at });
    draft.accountDevices.push({ accountId, deviceId, alias: 'Fixture', platform: 'android', createdAt: at, lastSeenAt: at });
    draft.accountDeviceKeys.push({ accountId, deviceId, keyId: phoneKey.keyId, publicKey: phoneKey.publicKey, fingerprint, createdAt: at });
    draft.accountCredentials.push({ accountId, deviceId, keyId: phoneKey.keyId, credentialId: 'cred_shared_pg_phone',
      tokenHash, scope: 'account-directory', issuedAt: at, expiresAt: new Date(now + 3600000).toISOString(), lastUsedAt: at });
    draft.instanceBindings.push({ instanceId: instance.instanceId, accountId: 'acct_inbox_qa', provider: 'google',
      instancePublicKey: hostKey, instanceKeyFingerprint: instance.keyFingerprint, boundAt: at });
    return issueInstanceAccessGrant(draft, { instanceId: instance.instanceId, ownerAccountId: 'acct_inbox_qa',
      accountId, requestId: 'qa_shared_pg_access_request_001', now });
  });
  const credential = { credential: token }, requestId = 'qa_shared_pg_rendezvous_request_001';
  const { intent } = JSON.parse(JSON.stringify(await fixture.broker.createAccountRendezvous({ requestId, targetInstanceId: instance.instanceId,
    device: { deviceId, publicKey: phoneKey.publicKey, devicePublicKeyFingerprint: fingerprint } }, credential)));
  const message = buildAccountJoinIntentMessage({ ...intent, audience: 'agentoc-account-join' });
  const deviceSignature = sign('sha256', Buffer.from(message), phoneKeys.privateKey).toString('base64');
  const join = await fixture.broker.authorizeAccountJoinIntent({ intentId: intent.intentId,
    requestId: 'qa_shared_pg_authorize_request_001', deviceId, devicePublicKeyFingerprint: fingerprint,
    nonce: intent.nonce, issuedAt: intent.issuedAt, deviceSignature }, credential);
  const issuedAt = new Date(now).toISOString(), audience = 'agentoc-account-join';
  const proof = buildAccountJoinIntentProofMessage({ instanceId: instance.instanceId, intentId: intent.intentId,
    deviceId, devicePublicKeyFingerprint: fingerprint, nonce: intent.nonce, issuedAt, audience, publicEndpoint: '' });
  const completion = { intentId: intent.intentId, requestId: 'qa_shared_pg_completion_request_001', nonce: intent.nonce,
    deviceIssuedAt: intent.issuedAt, device: { deviceId, devicePublicKeyFingerprint: fingerprint }, deviceSignature,
    accountJoinGrant: join.accountJoinGrant, publicEndpoint: '', issuedAt, audience, instance,
    signature: sign(null, Buffer.from(proof), hostKeys.privateKey).toString('base64url') };
  assert.equal((await fixture.broker.completeAccountJoinIntent(completion)).accountId, accountId);
  assert.equal((await fixture.broker.completeAccountJoinIntent(completion)).replayed, true);
  assert.equal((await pool.query('select account_id from instance_bindings where instance_id=$1', [instance.instanceId])).rows[0].account_id, 'acct_inbox_qa');
  await store.mutate(draft => revokeInstanceAccessGrant(draft, { grantId: access.grant.grantId, ownerAccountId: 'acct_inbox_qa', now }));
  await assert.rejects(fixture.broker.completeAccountJoinIntent(completion), { code: 'owner_auth_binding_mismatch' });
  await store.mutate(draft => issueInstanceAccessGrant(draft, { instanceId: instance.instanceId, ownerAccountId: 'acct_inbox_qa',
    accountId, requestId: 'qa_shared_pg_access_request_002', now }));
  await assert.rejects(fixture.broker.completeAccountJoinIntent(completion), { code: 'owner_auth_binding_mismatch' });
});
