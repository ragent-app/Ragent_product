import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createPostgresStore } from '../accounts/store/postgres.mjs';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { buildAccountRendezvousPollMessage, createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';

const url = process.env.RAGENT_ACCOUNTS_ISOLATED_TEST_DATABASE_URL;
test('scoped publication matches transactional authority in an owned PostgreSQL database', { skip: !url }, async t => {
  const database = new URL(url).pathname.slice(1);
  assert.match(database, /^qa_rendezvous_[a-f0-9]{24}$/);
  const schema = `qa_result_${randomBytes(12).toString('hex')}`;
  const pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema} -c statement_timeout=15000` });
  let created = false, injectFailure = false;
  t.after(async () => {
    try { if (created) await pool.query(`drop schema "${schema}" cascade`); }
    finally { await pool.end(); }
  });
  await pool.query(`create schema "${schema}"`); created = true;
  const admin = await pool.connect();
  try {
    await admin.query('begin');
    assert.equal((await admin.query('select current_schema() as schema')).rows[0].schema, schema);
    const directory = new URL('../accounts/migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(x => x.endsWith('.up.sql')).sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      assert(!/\bpublic\s*\.|\b(?:create\s+extension|alter\s+system|drop\s+schema|create\s+database)\b/i.test(sql));
      await admin.query(sql);
    }
    await admin.query('commit');
  } catch (error) { await admin.query('rollback'); throw error; }
  finally { admin.release(); }
  function store() {
    return createPostgresStore({ schema, enableScopedRendezvousResult: true, pool: { connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), async query(sql, values = []) {
        if (sql.includes('pg_advisory_xact_lock')) values = [`ragent_accounts_store_v1:${schema}`];
        const result = await client.query(sql, values);
        if (injectFailure && sql.startsWith('update account_join_intents')) throw new Error('injected update failure');
        return result;
      } };
    } } });
  }
  const a = store(), b = store(), now = Date.now(), issuedAt = new Date(now).toISOString();
  const host = generateKeyPairSync('ed25519'), publicKey = host.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const instance = { instanceId: 'inst_result_qa', publicKey, keyFingerprint: createInstancePublicKeyFingerprint(publicKey) };
  const requestId = 'result_qa_request_0001', audience = 'ragent-account-rendezvous-poll';
  await a.mutate(draft => {
    draft.accountJoinIntents.push({ intentId: 'rji_result_qa', instanceId: instance.instanceId, instance,
      deviceId: 'adev_result_qa', devicePublicKey: 'fixture', devicePublicKeyFingerprint: 'fixture', nonceHash: 'fixture',
      issuedAt, createdAt: issuedAt, expiresAt: new Date(now + 60000).toISOString(),
      status: 'rendezvous_offered', rendezvousRequestId: requestId });
  });
  const broker = createOwnerAuthBroker({ store: a, clock: () => now, verifyGoogleCredential: async () => ({}),
    resolveAccount: async () => ({}), signAssertion: async () => '' });
  const message = buildAccountRendezvousPollMessage({ instanceId: instance.instanceId, requestId, issuedAt, audience });
  const proof = { instance, requestId, issuedAt, audience, result: { value: 'first' },
    signature: sign(null, Buffer.from(message), host.privateKey).toString('base64url') };
  await assert.rejects(broker.completeAccountRendezvous({ ...proof, signature: 'invalid' }), { code: 'owner_auth_rendezvous_proof_invalid' });
  injectFailure = true;
  await assert.rejects(broker.completeAccountRendezvous(proof), /injected update failure/);
  injectFailure = false;
  assert.equal((await b.mutate(d => d.accountJoinIntents[0])).rendezvousResult, null);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const fullWriter = b.mutate(async draft => { entered(); await gate; draft.accountJoinIntents[0].deviceAlias = 'retained'; });
  await started;
  let done = false;
  const result = broker.completeAccountRendezvous(proof).then(value => { done = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(done, false, 'scoped writer must wait for an independent full writer');
  release(); await fullWriter;
  assert.deepEqual((await result).result, { value: 'first' });
  const final = await b.mutate(d => d.accountJoinIntents[0]);
  assert.equal(final.deviceAlias, 'retained');
  assert.equal(final.status, 'rendezvous_completed');
  assert.deepEqual(final.rendezvousResult, { value: 'first' });
  const originalCompletion = final.completedAt;
  const replay = await broker.completeAccountRendezvous({ ...proof, result: { value: 'replay' } });
  assert.deepEqual(replay.result, { value: 'replay' });
  assert.equal((await b.mutate(d => d.accountJoinIntents[0])).completedAt, originalCompletion,
    'A repeated signed result must retain the original completion time');
  await assert.rejects(a.mutateRendezvousResult(requestId, draft => {
    draft.accountJoinIntents[0].deviceId = 'adev_other';
  }), /unrelated authority/);
  assert.equal((await b.mutate(d => d.accountJoinIntents[0])).deviceId, 'adev_result_qa');
  await b.mutate(d => { d.accountJoinIntents[0].expiresAt = new Date(now).toISOString(); });
  await assert.rejects(broker.completeAccountRendezvous(proof), { code: 'owner_auth_rendezvous_expired' });
  assert.deepEqual((await b.mutate(d => d.accountJoinIntents[0])).rendezvousResult, { value: 'replay' });
  await b.mutate(d => { d.accountJoinIntents[0].expiresAt = new Date(now + 60000).toISOString(); });

  // Reproduce a large durable history without making thousands of round trips.
  await pool.query(`insert into account_join_intents
    (intent_id, instance_id, instance_public_key, instance_key_fingerprint, device_id,
     device_public_key, device_public_key_fingerprint, nonce_hash, issued_at, created_at, expires_at, status)
    select 'rji_history_' || n, instance_id, instance_public_key, instance_key_fingerprint, device_id,
      device_public_key, device_public_key_fingerprint, 'history_' || n, issued_at, created_at, expires_at, 'completed'
    from account_join_intents cross join generate_series(1, 6000) n where intent_id = 'rji_result_qa'`);
  const baseline = createOwnerAuthBroker({ store: { mutate: b.mutate }, clock: () => now,
    verifyGoogleCredential: async () => ({}), resolveAccount: async () => ({}), signAssertion: async () => '' });
  const timings = { fullSnapshotMs: [], scopedMs: [] };
  for (let run = 0; run < 2; run++) {
    const startedFull = performance.now();
    await baseline.completeAccountRendezvous({ ...proof, result: { value: `full-${run}` } });
    timings.fullSnapshotMs.push(Math.round(performance.now() - startedFull));
    const startedScoped = performance.now();
    await broker.completeAccountRendezvous({ ...proof, result: { value: `scoped-${run}` } });
    timings.scopedMs.push(Math.round(performance.now() - startedScoped));
  }
  assert.equal(Number((await pool.query('select count(*) as count from account_join_intents')).rows[0].count), 6001);
  assert.deepEqual((await b.mutate(d => d.accountJoinIntents.find(i => i.intentId === 'rji_result_qa'))).rendezvousResult,
    { value: 'scoped-1' });
  t.diagnostic(`Remote isolated PostgreSQL timings with 6000 history rows: ${JSON.stringify(timings)}; includes SSH latency`);
});
