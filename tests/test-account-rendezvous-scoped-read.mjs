import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createPostgresStore } from '../accounts/store/postgres.mjs';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { normalizeDevicePublicKey, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';

const now = Date.parse('2026-10-26T00:00:00Z');
const token = `rac_${'s'.repeat(48)}`;
const tokenHash = createHash('sha256').update(token).digest('hex');
const requestId = 'rendezvous_scoped_fixture_0001';
const key = normalizeDevicePublicKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .publicKey.export({ type: 'spki', format: 'pem' }).toString());
const before = new Date(now - 120_000).toISOString();
const future = new Date(now + 60_000).toISOString();

function state() {
  return {
    accountCredentials: [{ credentialId: 'cred_scoped', tokenHash, accountId: 'acct_scoped',
      deviceId: 'adev_scoped', keyId: key.keyId, scope: 'account-directory',
      issuedAt: before, expiresAt: future, revokedAt: '', lastUsedAt: before }],
    accountDevices: [{ deviceId: 'adev_scoped', accountId: 'acct_scoped', revokedAt: '', lastSeenAt: before }],
    accountDeviceKeys: [{ ...key, accountId: 'acct_scoped', deviceId: 'adev_scoped', revokedAt: '',
      fingerprint: createDevicePublicKeyFingerprint(key.publicKey) }],
    accountJoinIntents: [{ intentId: 'rji_scoped', accountId: 'acct_scoped',
      rendezvousRequestId: requestId, status: 'rendezvous_completed',
      expiresAt: future, rendezvousResult: { fixture: 'result' } }],
  };
}

function broker(snapshot, scoped = true) {
  const calls = { reads: [], writes: 0 };
  const store = { mutate: async fn => {
    calls.writes++;
    if (scoped) throw new Error('Scoped result must not enter the writer queue');
    return fn(snapshot);
  } };
  if (scoped) store.readAccountRendezvousSnapshot = async input => {
    calls.reads.push(input);
    assert.deepEqual(Object.keys(input).sort(), ['requestId', 'tokenHash']);
    assert.equal(input.tokenHash, tokenHash);
    assert(!JSON.stringify(input).includes(token));
    return structuredClone(snapshot);
  };
  return { calls, store, api: createOwnerAuthBroker({ store, clock: () => now,
    verifyGoogleCredential: async () => { throw new Error('Google must not run for a result read'); },
    resolveAccount: async () => { throw new Error('No account creation'); },
    signAssertion: async () => { throw new Error('No assertion issuance'); },
  }) };
}

test('scoped and legacy result output agree while the scoped path preserves presence', async () => {
  const snapshot = state();
  const initial = structuredClone(snapshot);
  const direct = broker(snapshot);
  const legacy = broker(structuredClone(snapshot), false);
  assert.deepEqual(await direct.api.getAccountRendezvousResult({ requestId }, { credential: token }),
    await legacy.api.getAccountRendezvousResult({ requestId }, { credential: token }));
  assert.deepEqual(snapshot, initial);
  assert.equal(direct.calls.writes, 0);
  assert.equal(direct.calls.reads.length, 1);
});

test('invalid credential syntax is rejected before any database access', async () => {
  const f = broker(state());
  await assert.rejects(f.api.getAccountRendezvousResult({ requestId }, { credential: 'invalid' }),
    { code: 'owner_auth_account_credential_invalid', statusCode: 401 });
  assert.deepEqual(f.calls, { reads: [], writes: 0 });
});

for (const [label, change, code, statusCode] of [
  ['expired credential', s => { s.accountCredentials[0].expiresAt = before; }, 'owner_auth_account_credential_expired', 401],
  ['revoked credential', s => { s.accountCredentials[0].revokedAt = before; }, 'owner_auth_account_credential_expired', 401],
  ['wrong scope', s => { s.accountCredentials[0].scope = 'other'; }, 'owner_auth_account_credential_scope', 403],
  ['revoked phone', s => { s.accountDevices[0].revokedAt = before; }, 'owner_auth_account_device_revoked', 403],
  ['foreign phone', s => { s.accountDevices[0].accountId = 'acct_foreign'; }, 'owner_auth_account_device_revoked', 403],
  ['revoked key', s => { s.accountDeviceKeys[0].revokedAt = before; }, 'owner_auth_account_device_revoked', 403],
  ['foreign key', s => { s.accountDeviceKeys[0].accountId = 'acct_foreign'; }, 'owner_auth_account_device_revoked', 403],
  ['another phone key', s => { s.accountDeviceKeys[0].deviceId = 'adev_foreign'; }, 'owner_auth_account_device_revoked', 403],
  ['invalid public key', s => { s.accountDeviceKeys[0].publicKey = 'invalid'; }, 'owner_auth_account_device_invalid', 403],
  ['fingerprint mismatch', s => { s.accountDeviceKeys[0].fingerprint = '0'.repeat(64); }, 'owner_auth_account_device_invalid', 403],
  ['another account intent', s => { s.accountJoinIntents[0].accountId = 'acct_foreign'; }, 'owner_auth_rendezvous_expired', 410],
  ['expired intent', s => { s.accountJoinIntents[0].expiresAt = before; }, 'owner_auth_rendezvous_expired', 410],
]) {
  test(`scoped reads retain the legacy ${label} refusal`, async () => {
    const snapshot = state(); change(snapshot);
    for (const scoped of [true, false]) {
      const f = broker(structuredClone(snapshot), scoped);
      await assert.rejects(f.api.getAccountRendezvousResult({ requestId }, { credential: token }), { code, statusCode });
    }
  });
}

test('every read observes a later revocation instead of caching authority', async () => {
  const snapshot = state(), f = broker(snapshot);
  await f.api.getAccountRendezvousResult({ requestId }, { credential: token });
  snapshot.accountDeviceKeys[0].revokedAt = before;
  await assert.rejects(f.api.getAccountRendezvousResult({ requestId }, { credential: token }),
    { code: 'owner_auth_account_device_revoked' });
  assert.equal(f.calls.reads.length, 2);
  assert.equal(f.calls.writes, 0);
});

test('read failure does not silently fall back to the full snapshot writer', async () => {
  const f = broker(state()), error = new Error('database read failed');
  f.store.readAccountRendezvousSnapshot = async () => { throw error; };
  await assert.rejects(f.api.getAccountRendezvousResult({ requestId }, { credential: token }), e => e === error);
  assert.equal(f.calls.writes, 0);
});

function sqlFixture({ fail = false, unknown = false, offered = false } = {}) {
  const queries = [], values = [], released = [];
  const credential = { credential_id: 'cred_scoped', token_hash: tokenHash, account_id: 'acct_scoped',
    device_id: 'adev_scoped', key_id: key.keyId, scope: 'account-directory', issued_at: before,
    expires_at: future, last_used_at: before };
  const rows = {
    accounts: [{ account_id: 'acct_scoped', provider: 'fixture', provider_subject: 'scope' }],
    account_credentials: [credential],
    account_devices: [{ device_id: credential.device_id, account_id: credential.account_id }],
    account_device_keys: [{ key_id: key.keyId, account_id: credential.account_id,
      device_id: credential.device_id, public_key: key.publicKey,
      fingerprint: createDevicePublicKeyFingerprint(key.publicKey) }],
    account_join_intents: [{ intent_id: 'rji_scoped', account_id: credential.account_id,
      rendezvous_request_id: requestId, expires_at: future, status: 'rendezvous_completed',
      rendezvous_result: { fixture: 'result' } }],
    account_join_grants: [{ intent_id: 'rji_scoped', account_id: 'acct_scoped',
      grant_hash: createHash('sha256').update('raj_scoped').digest('hex'), expires_at: before }],
  };
  if (offered) Object.assign(rows.account_join_intents[0], { status: 'rendezvous_offered',
    rendezvous_grant: 'raj_scoped', rendezvous_result: null });
  const store = createPostgresStore({ pool: { connect: async () => ({
    release: () => released.push(true),
    query: async (sql, args = []) => {
      queries.push(sql); values.push(args);
      assert(!/\b(insert|update|delete|truncate|pg_advisory)\b/i.test(sql));
      const table = /select \* from (\w+) where /.exec(sql)?.[1];
      if (!table) return { rows: [] };
      assert(sql.endsWith('limit 1'));
      if (table === 'account_credentials') assert.deepEqual(args, [tokenHash]);
      if (table === 'account_devices') assert.deepEqual(args, ['adev_scoped', 'acct_scoped']);
      if (table === 'account_device_keys') assert.deepEqual(args, [key.keyId, 'adev_scoped', 'acct_scoped']);
      if (table === 'account_join_grants') assert.deepEqual(args, ['rji_scoped', 'acct_scoped', createHash('sha256').update('raj_scoped').digest('hex')]);
      if (table === 'account_join_intents') {
        assert.deepEqual(args, [requestId, 'acct_scoped']);
        if (fail) throw new Error('intent read failed');
      }
      return { rows: unknown ? [] : rows[table] };
    },
  }) } });
  return { store, queries, values, released };
}

test('Postgres view uses a read-only MVCC transaction and five bounded parameterized queries', async () => {
  const f = sqlFixture();
  const view = await f.store.readAccountRendezvousSnapshot({ tokenHash, requestId });
  assert.equal(f.queries[0], 'begin isolation level repeatable read read only');
  assert.equal(f.queries.at(-1), 'commit');
  assert.equal(f.queries.filter(q => q.startsWith('select *')).length, 5);
  assert(f.values.some(v => v[0] === 'statement_timeout' && v[1] === '5000ms'));
  assert(f.values.some(v => v[0] === 'lock_timeout' && v[1] === '1000ms'));
  assert.equal(view.accountJoinIntents[0].rendezvousResult.fixture, 'result');
  assert.deepEqual(f.released, [true]);
});

test('offered rendezvous reads only its matching account grant in the same snapshot', async () => {
  const f = sqlFixture({ offered: true });
  const view = await f.store.readAccountRendezvousSnapshot({ tokenHash, requestId });
  assert.equal(f.queries.filter(q => q.startsWith('select *')).length, 6);
  assert.equal(view.accountJoinGrants.length, 1);
  assert.equal(view.accountJoinGrants[0].intentId, 'rji_scoped');
});

test('unknown credential reads no phone, key or intent', async () => {
  const f = sqlFixture({ unknown: true });
  const view = await f.store.readAccountRendezvousSnapshot({ tokenHash, requestId });
  assert.equal(f.queries.filter(q => q.startsWith('select *')).length, 1);
  assert.deepEqual(view, { accounts: [], accountCredentials: [], accountDevices: [], accountDeviceKeys: [], accountJoinIntents: [] });
});

test('database error rolls back and releases the connection', async () => {
  const f = sqlFixture({ fail: true });
  await assert.rejects(f.store.readAccountRendezvousSnapshot({ tokenHash, requestId }), /intent read failed/);
  assert.equal(f.queries.at(-1), 'rollback');
  assert.deepEqual(f.released, [true]);
});

test('bad repository selectors are rejected before acquiring a connection', async () => {
  const f = sqlFixture();
  await assert.rejects(f.store.readAccountRendezvousSnapshot({ tokenHash: 'raw-credential', requestId }), TypeError);
  await assert.rejects(f.store.readAccountRendezvousSnapshot({ tokenHash, requestId: 'x'.repeat(129) }), TypeError);
  assert.deepEqual(f.queries, []);
});

test('deletion fence remains enforced on a scoped result read', async () => {
  const snapshot = state(); snapshot.accounts = [{ accountId: 'acct_scoped', deletionRequestedAt: before, deletionJobId: 'job' }];
  const f = broker(snapshot);
  await assert.rejects(f.api.getAccountRendezvousResult({ requestId }, { credential: token }), { code: 'account_deletion_pending', statusCode: 410 });
});
