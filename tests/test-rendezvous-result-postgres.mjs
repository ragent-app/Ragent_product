import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createPostgresStore, createPostgresStoreFromUrl } from '../accounts/store/postgres.mjs';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { buildAccountRendezvousPollMessage, createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';

function fixture(overrides = {}) {
  let row = {
    intent_id: 'rji_scoped', instance_id: 'inst_scoped', instance_public_key: 'key',
    instance_key_fingerprint: 'fingerprint', device_id: 'adev_scoped', device_public_key: 'phone',
    device_public_key_fingerprint: 'phone-fingerprint', nonce_hash: 'nonce-hash',
    issued_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z', status: 'rendezvous_offered',
    rendezvous_request_id: 'request_scoped', rendezvous_result: null, completed_at: null, ...overrides,
  };
  const calls = [];
  const pool = { async connect() {
    let staged;
    return { release() {}, async query(sql, params = []) {
      calls.push(sql.trim());
      if (sql === 'begin') staged = structuredClone(row);
      else if (sql.startsWith('select * from account_join_intents')) return { rows: params[0] === staged?.rendezvous_request_id ? [structuredClone(staged)] : [] };
      else if (sql.startsWith('update account_join_intents')) {
        staged = { ...staged, rendezvous_result: JSON.parse(params[0]), status: params[1], completed_at: params[2] };
        return { rowCount: 1 };
      } else if (sql === 'commit') row = staged;
      return { rows: [], rowCount: 0 };
    } };
  } };
  return { store: createPostgresStore({ pool, enableScopedRendezvousResult: true }), calls, read: () => structuredClone(row) };
}

test('URL factory forwards both scoped opt-in flags without enabling them by default', async () => {
  const url = 'postgres://fixture:fixture@127.0.0.1/fixture';
  const disabled = createPostgresStoreFromUrl(url);
  const enabled = createPostgresStoreFromUrl(url, {
    enableScopedRendezvousResult: true, enableScopedRendezvousCreation: true,
  });
  try {
    assert.equal(disabled.mutateRendezvousResult, undefined);
    assert.equal(disabled.mutateRendezvousCreation, undefined);
    assert.equal(typeof enabled.mutateRendezvousResult, 'function');
    assert.equal(typeof enabled.mutateRendezvousCreation, 'function');
  } finally {
    await Promise.all([disabled.close(), enabled.close()]);
  }
});

test('scoped result publication is disabled unless explicitly enabled for verification', () => {
  const store = createPostgresStore({ pool: { connect() { throw new Error('unexpected connection'); } } });
  assert.equal(store.mutateRendezvousResult, undefined);
  assert.equal(store.mutateRendezvousCreation, undefined);
});

test('scoped result publication updates only the requested row under the shared writer lock', async () => {
  const f = fixture();
  const result = await f.store.mutateRendezvousResult('request_scoped', draft => {
    const intent = draft.accountJoinIntents[0];
    intent.rendezvousResult = { credential: { type: 'fixture' } };
    intent.status = 'rendezvous_completed';
    intent.completedAt = '2026-01-02T00:00:00.000Z';
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(f.read().status, 'rendezvous_completed');
  assert.deepEqual(f.read().rendezvous_result, { credential: { type: 'fixture' } });
  assert(f.calls.some(sql => sql.includes('pg_advisory_xact_lock')));
  assert.equal(f.calls.filter(sql => sql.startsWith('update account_join_intents')).length, 1);
  assert(!f.calls.some(sql => /delete from/i.test(sql)));
});

test('broker validates the instance signature before publishing through the scoped writer', async () => {
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = createInstancePublicKeyFingerprint(publicKey), now = Date.now();
  const f = fixture({ instance_public_key: publicKey, instance_key_fingerprint: fingerprint });
  const broker = createOwnerAuthBroker({ store: f.store, clock: () => now,
    verifyGoogleCredential: async () => ({}), resolveAccount: async () => ({}), signAssertion: async () => '' });
  const instance = { instanceId: 'inst_scoped', publicKey, keyFingerprint: fingerprint };
  const requestId = 'request_scoped', issuedAt = new Date(now).toISOString(), audience = 'ragent-account-rendezvous-poll';
  const message = buildAccountRendezvousPollMessage({ instanceId: instance.instanceId, requestId, issuedAt, audience });
  const proof = { instance, requestId, issuedAt, audience, result: { value: 'fixture' },
    signature: sign(null, Buffer.from(message), key.privateKey).toString('base64url') };
  await assert.rejects(broker.completeAccountRendezvous({ ...proof, signature: 'invalid' }),
    { code: 'owner_auth_rendezvous_proof_invalid' });
  assert.equal(f.read().rendezvous_result, null);
  const completed = await broker.completeAccountRendezvous(proof);
  assert.equal(completed.status, 'rendezvous_completed');
  assert.deepEqual(completed.result, { value: 'fixture' });
  assert.deepEqual(f.read().rendezvous_result, { value: 'fixture' });
});

test('scoped result publication rolls back failures and rejects unrelated mutations', async () => {
  const f = fixture(), before = f.read();
  await assert.rejects(f.store.mutateRendezvousResult('request_scoped', () => { throw new Error('invalid proof'); }), /invalid proof/);
  await assert.rejects(f.store.mutateRendezvousResult('request_scoped', draft => {
    draft.accountJoinIntents[0].accountId = 'another-account';
  }), /unrelated authority/);
  assert.deepEqual(f.read(), before);
  assert.equal(f.calls.filter(sql => sql === 'rollback').length, 2);
  assert(!f.calls.some(sql => sql.startsWith('update account_join_intents')));
});

test('scoped result publications serialize and a missing request cannot create authority', async () => {
  const f = fixture();
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered; const firstEntered = new Promise(resolve => { entered = resolve; });
  const first = f.store.mutateRendezvousResult('request_scoped', async draft => {
    entered(); await gate; draft.accountJoinIntents[0].status = 'first';
  });
  await firstEntered;
  let secondEntered = false;
  const second = f.store.mutateRendezvousResult('request_scoped', draft => {
    secondEntered = true; assert.equal(draft.accountJoinIntents[0].status, 'first');
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondEntered, false);
  release(); await Promise.all([first, second]);
  await assert.rejects(f.store.mutateRendezvousResult('missing', draft => {
    draft.accountJoinIntents.push({ intentId: 'invented' });
  }), /unrelated authority/);
});
