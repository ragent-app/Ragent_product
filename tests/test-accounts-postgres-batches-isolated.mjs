// Real PostgreSQL only. All tables live in a freshly owned schema; never truncate public.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const url = process.env.RAGENT_ACCOUNTS_ISOLATED_TEST_DATABASE_URL;
assert(url, 'Set the explicit isolated-schema test database URL');
const modulePath = process.env.RAGENT_TEST_STORE_MODULE || resolve('accounts/store/postgres.mjs');
const { createPostgresStore } = await import(pathToFileURL(resolve(modulePath)));
const secondFactory = process.env.RAGENT_TEST_SECOND_STORE_MODULE
  ? (await import(pathToFileURL(resolve(process.env.RAGENT_TEST_SECOND_STORE_MODULE)))).createPostgresStore : createPostgresStore;
const intentCount = Number(process.env.RAGENT_TEST_INTENT_COUNT || 1);
assert(Number.isInteger(intentCount) && intentCount >= 1 && intentCount <= 10_000);
const schema = `qa_conn_batch_${randomBytes(12).toString('hex')}`;
assert(/^qa_conn_batch_[a-f0-9]{24}$/.test(schema));
const bootstrap = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
const pools = []; let owned = false; let mutations = 0, inserts = 0;
let intentInsertedRows = 0, intentDeletedRows = 0;
function store(factory = createPostgresStore) {
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema} -c statement_timeout=15000 -c application_name=ragent-connectivity-qa` });
  pools.push(pool);
  return factory({ pool: { connect: async () => {
    const client = await pool.connect();
    try { assert.equal((await client.query('select current_schema() as schema')).rows[0].schema, schema); }
    catch (error) { client.release(); throw error; }
    return { release: () => client.release(), query: async (sql, values = []) => {
      assert(!/\bpublic\s*\./i.test(sql), 'Fixture cannot access public tables');
      if (/pg_advisory/.test(sql)) {
        assert.equal(sql, 'select pg_advisory_xact_lock(hashtext($1))');
        assert.deepEqual(values, ['ragent_accounts_store_v1']);
        // Preserve actual advisory serialization between the two test stores,
        // using an isolated lock key so QA cannot queue the running service.
        return client.query(sql, [`ragent_accounts_store_v1:${schema}`]);
      }
      if (/^\s*(insert|delete|update)\b/i.test(sql)) mutations++;
      if (/^\s*insert\b/i.test(sql)) inserts++;
      const result = await client.query(sql, values);
      if (/^\s*insert into account_join_intents\b/i.test(sql)) intentInsertedRows += result.rowCount;
      if (/^\s*delete from account_join_intents\b/i.test(sql)) intentDeletedRows += result.rowCount;
      return result;
    } };
  } } });
}
const now = new Date().toISOString(), expires = new Date(Date.now() + 3600000).toISOString();
const accountId = 'acct_batch_fixture', primary = 'adev_batch_0';
try {
  await bootstrap.query(`create schema "${schema}"`); owned = true;
  const admin = await bootstrap.connect();
  try {
    await admin.query('begin');
    await admin.query(`set local search_path to "${schema}"`);
    assert.equal((await admin.query('select current_schema() as schema')).rows[0].schema, schema);
    const directory = new URL('../accounts/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.up.sql')).sort()) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      assert(!/\bpublic\s*\.|\b(?:create\s+extension|alter\s+system|drop\s+schema|create\s+database)\b/i.test(sql));
      await admin.query(sql);
    }
    await admin.query('commit');
  } catch (error) { await admin.query('rollback'); throw error; }
  finally { admin.release(); }
  const a = store(), b = store(secondFactory);
  const start = performance.now(), beforeInserts = inserts;
  await a.mutate((draft) => {
    draft.accounts.push({ accountId, provider: 'google', providerSubject: 'batch-fixture', createdAt: now });
    for (let n = 0; n < 300; n++) draft.accountDevices.push({ deviceId: `adev_batch_${n}`, accountId,
      alias: `Phone '${n} 中文`, platform: 'android', createdAt: now, lastSeenAt: now });
    draft.accountDeviceKeys.push({ keyId: 'key_batch', accountId, deviceId: primary, publicKey: 'fixture-public-key', fingerprint: 'fixture-fingerprint', createdAt: now });
    draft.accountCredentials.push({ credentialId: 'credential_batch', tokenHash: 'synthetic-token-hash', accountId,
      deviceId: primary, keyId: 'key_batch', scope: 'account-directory', issuedAt: now, expiresAt: expires, lastUsedAt: now });
    draft.accountCredentialRefreshes.push({ credentialId: 'credential_batch', requestId: 'refresh_batch', nonceHash: 'synthetic-nonce-hash', issuedAt: now, createdAt: now });
    draft.accountJoinIntents.push({ intentId: 'rji_batch', instanceId: 'inst_batch', instance: { publicKey: 'fixture-instance-key', keyFingerprint: 'fixture-instance-fingerprint' },
      deviceId: 'rdev_batch', devicePublicKey: 'fixture-phone-key', devicePublicKeyFingerprint: 'fixture-phone-fingerprint',
      nonceHash: 'synthetic-intent-hash', issuedAt: now, createdAt: now, expiresAt: expires, accountId, accountDeviceId: primary, status: 'completed' });
    for (let n = 1; n < intentCount; n++) draft.accountJoinIntents.push({ ...draft.accountJoinIntents[0],
      intentId: `rji_batch_${n}`, nonceHash: `synthetic-intent-hash-${n}` });
    draft.accountJoinGrants.push({ grantHash: 'synthetic-grant-hash', accountId, instanceId: 'inst_batch', intentId: 'rji_batch',
      deviceId: 'rdev_batch', accountDeviceId: primary, keyFingerprint: 'fixture-phone-fingerprint', requestId: 'grant_batch', createdAt: now, expiresAt: expires });
    draft.accountSyncCatalog.push({ accountId, scope: 'provider', key: 'counter', version: { count: 0 }, sourceInstanceId: 'inst_batch', updatedAt: now });
  });
  const seedMs = performance.now() - start, seedInsertQueries = inserts - beforeInserts;
  if (process.env.RAGENT_EXPECT_BATCHED_WRITES !== '0') assert(seedInsertQueries < 20 + Math.ceil(intentCount / 100), 'Rows must use bounded batches');
  else assert(seedInsertQueries >= 300, 'Baseline must actually perform the former per-row writes');
  const snapshot = await a.mutate((draft) => structuredClone(draft));
  assert.equal(snapshot.accountDevices.length, 300);
  assert(snapshot.accountDevices.some((device) => device.alias === "Phone '299 中文"));
  assert.equal(snapshot.accountJoinGrants[0].accountDeviceId, primary);
  assert.equal(snapshot.accountCredentialRefreshes[0].credentialId, 'credential_batch');
  const beforeDelta = { inserts: intentInsertedRows, deletes: intentDeletedRows };
  const deltaStart = performance.now();
  await a.mutate(draft => { draft.accountJoinIntents.find(intent => intent.intentId === 'rji_batch').deviceAlias = 'Changed one intent'; });
  // A small unrelated write must preserve the durable phone authorization
  // link on EVERY unchanged intent, including rows not selected for upsert.
  const linkedAfterDelta = await b.mutate(draft => draft.accountJoinIntents.map(intent => intent.accountDeviceId));
  assert.equal(linkedAfterDelta.length, intentCount);
  assert(linkedAfterDelta.every(deviceId => deviceId === primary), 'An unchanged intent must retain its phone FK');
  const deltaMs = performance.now() - deltaStart;
  const deltaRows = { inserted: intentInsertedRows - beforeDelta.inserts, deleted: intentDeletedRows - beforeDelta.deletes };
  if (process.env.RAGENT_EXPECT_INTENT_DELTAS === '1') assert.deepEqual(deltaRows, { inserted: 1, deleted: 0 });
  else if (process.env.RAGENT_EXPECT_INTENT_DELTAS === '0') assert.deepEqual(deltaRows, { inserted: intentCount, deleted: intentCount });
  assert.equal(await b.mutate(draft => draft.accountJoinIntents.length), intentCount);
  // A later grant FK failure must roll back the earlier intent delta itself.
  await assert.rejects(a.mutate(draft => {
    draft.accountJoinIntents.find(intent => intent.intentId === 'rji_batch').deviceAlias = 'Must roll back intent delta';
    draft.accountJoinGrants.push({ ...draft.accountJoinGrants[0], grantHash: 'synthetic-missing-intent-grant',
      requestId: 'missing-intent-grant', intentId: 'rji_missing' });
  }), error => error.code === '23503');
  assert.equal(await b.mutate(draft => draft.accountJoinIntents.find(intent => intent.intentId === 'rji_batch').deviceAlias), 'Changed one intent');
  if (intentCount > 1) {
    const beforeDelete = { inserts: intentInsertedRows, deletes: intentDeletedRows };
    await a.mutate(draft => { draft.accountJoinIntents = draft.accountJoinIntents.filter(intent => intent.intentId !== `rji_batch_${intentCount - 1}`); });
    if (process.env.RAGENT_EXPECT_INTENT_DELTAS === '1') assert.deepEqual(
      { inserted: intentInsertedRows - beforeDelete.inserts, deleted: intentDeletedRows - beforeDelete.deletes }, { inserted: 0, deleted: 1 });
    assert.equal(await b.mutate(draft => draft.accountJoinIntents.length), intentCount - 1);
  }
  const beforeNoop = mutations; await a.mutate(() => {}); assert.equal(mutations, beforeNoop, 'Unchanged snapshot must not rewrite tables');
  await assert.rejects(a.mutate((draft) => {
    draft.accountDevices[0].alias = 'Must roll back';
    draft.accountCredentials.push({ ...draft.accountCredentials[0], credentialId: 'invalid_foreign_key', tokenHash: 'synthetic-new-hash', keyId: 'missing-key' });
  }), (error) => error.code === '23503');
  const restored = await b.mutate((draft) => structuredClone(draft));
  assert.equal(restored.accountDevices.length, 300);
  assert(!restored.accountDevices.some((device) => device.alias === 'Must roll back'));
  assert.equal(restored.accountCredentials.length, 1, 'Failed later batch must roll back earlier inserts/deletes');
  const concurrencyStart = performance.now();
  await Promise.all([a, b, a, b].map((writer) => writer.mutate((draft) => { draft.accountSyncCatalog[0].version.count++; })));
  const concurrencyMs = performance.now() - concurrencyStart;
  assert.equal(await a.mutate((draft) => draft.accountSyncCatalog[0].version.count), 4, 'Two independent queues must serialize on the same database lock');
  assert((await b.mutate(draft => draft.accountJoinIntents.map(intent => intent.accountDeviceId)))
    .every(deviceId => deviceId === primary), 'Catalog writes must preserve all phone links');
  let computerRevocation = null;
  if (process.env.RAGENT_TEST_REVOKE_HELPER) {
    const {releaseRevokedInstanceTurnConnections} = await import(pathToFileURL(resolve(process.env.RAGENT_TEST_REVOKE_HELPER)));
    const revokedInstance = 'inst_batch_revoke', revokeMs = Date.now();
    await a.mutate(draft => {
      draft.accounts.push({accountId:'acct_batch_foreign',provider:'google',providerSubject:'batch-foreign',createdAt:now});
      draft.instanceBindings.push({instanceId:revokedInstance,accountId,provider:'google',boundAt:now,lastSeenAt:now,revokedAt:''});
      const lease = (connectionId, instanceId = revokedInstance, owner = accountId) => ({connectionId,accountId:owner,instanceId,
        deviceId:'rdev_batch_'+connectionId,quotaDeviceId:primary,deviceKind:'phone',plan:'plus',status:'reserved',createdAt:now,updatedAt:now,expiresAt:expires});
      draft.turnConnectionLeases.push(lease('revoke-one'),{...lease('revoke-two'),status:'connected'},lease('revoke-keep','inst_batch_keep'),
        lease('revoke-foreign',revokedInstance,'acct_batch_foreign'),{...lease('revoke-expired'),expiresAt:new Date(revokeMs).toISOString()});
    });
    const before = await a.mutate(draft => structuredClone({bindings:draft.instanceBindings,leases:draft.turnConnectionLeases}));
    await assert.rejects(a.mutate(draft => {
      draft.instanceBindings.find(binding => binding.instanceId === revokedInstance).revokedAt = new Date(revokeMs).toISOString();
      assert.equal(releaseRevokedInstanceTurnConnections(draft,{accountId,instanceId:revokedInstance,nowMs:revokeMs}),2);
      // This FK is written later than both the binding and the lease table.
      draft.accountJoinGrants.push({...draft.accountJoinGrants[0],grantHash:'revocation-rollback-grant',requestId:'revocation-rollback',intentId:'missing-revocation-parent'});
    }), error => error.code === '23503');
    assert.deepEqual(await b.mutate(draft => ({bindings:draft.instanceBindings,leases:draft.turnConnectionLeases})),before,
      'A later constraint failure must roll back both revocation and quota release');
    const [released] = await Promise.all([
      a.mutate(draft => {
        draft.instanceBindings.find(binding => binding.instanceId === revokedInstance).revokedAt = new Date(revokeMs).toISOString();
        return releaseRevokedInstanceTurnConnections(draft,{accountId,instanceId:revokedInstance,nowMs:revokeMs});
      }),
      b.mutate(draft => { draft.accountSyncCatalog[0].version.count++; }),
    ]);
    assert.equal(released,2);
    const after = await a.mutate(draft => structuredClone({bindings:draft.instanceBindings,leases:draft.turnConnectionLeases}));
    assert(after.bindings.find(binding => binding.instanceId === revokedInstance).revokedAt);
    for (const original of before.leases) {
      const current = after.leases.find(lease => lease.connectionId === original.connectionId);
      if (['revoke-one','revoke-two'].includes(original.connectionId)) {
        assert.equal(current.status,'released');assert.equal(current.releaseReason,'computer-unbound');
      } else assert.deepEqual(current,original,'Unrelated/expired lease changed');
    }
    assert((await a.mutate(draft => draft.accountJoinIntents.map(intent => intent.accountDeviceId))).every(id => id === primary));
    const beforeRepeated = mutations;
    assert.equal(await a.mutate(draft => releaseRevokedInstanceTurnConnections(draft,{accountId,instanceId:revokedInstance,nowMs:revokeMs})),0);
    assert.equal(mutations,beforeRepeated);
    computerRevocation={released:2,foreignKeyRollback:true,serializedMixedWriterPreserved:true,phoneLinksPreserved:true,repeatedWrites:0};
  }
  let resultRetention = null;
  if (process.env.RAGENT_TEST_RETENTION_HELPER) {
    const {pruneExpiredRendezvousResults} = await import(pathToFileURL(resolve(process.env.RAGENT_TEST_RETENTION_HELPER)));
    const expired = new Date(Date.now() - 1_000).toISOString();
    await a.mutate(draft => { for (const intent of draft.accountJoinIntents) {
      intent.expiresAt = expired;
      intent.rendezvousResult = {credential:{token:'synthetic-expired-cache'},bootstrap:{fixture:'payload'.repeat(768)}};
    } });
    let measuredAt = performance.now();
    const retained = await a.mutate(draft => structuredClone(draft.accountJoinIntents));
    const beforeReadMs = Math.round(performance.now() - measuredAt);
    // A later FK error must roll back cache pruning as well as the intent link.
    await assert.rejects(a.mutate(draft => {
      pruneExpiredRendezvousResults(draft.accountJoinIntents, Date.now());
      draft.accountJoinGrants.push({...draft.accountJoinGrants[0],grantHash:'retention-rollback-grant',requestId:'retention-rollback',intentId:'missing-retention-parent'});
    }), error => error.code === '23503');
    assert.deepEqual(await a.mutate(draft => draft.accountJoinIntents), retained);
    const beforePrune = {inserts:intentInsertedRows,deletes:intentDeletedRows};
    measuredAt = performance.now();
    assert.equal(await a.mutate(draft => pruneExpiredRendezvousResults(draft.accountJoinIntents, Date.now())), retained.length);
    const pruneMs = Math.round(performance.now() - measuredAt);
    if (process.env.RAGENT_EXPECT_INTENT_DELTAS === '1') assert.deepEqual(
      {inserted:intentInsertedRows-beforePrune.inserts,deleted:intentDeletedRows-beforePrune.deletes},
      {inserted:retained.length,deleted:0});
    // The old serialized writer must see the new nulls rather than resurrect
    // the historical cache during an unrelated write.
    await b.mutate(draft => {draft.accountSyncCatalog[0].version.count++;});
    measuredAt = performance.now();
    const pruned = await a.mutate(draft => structuredClone(draft.accountJoinIntents));
    const afterReadMs = Math.round(performance.now() - measuredAt);
    assert.deepEqual(pruned, retained.map(intent => ({...intent,rendezvousResult:null})));
    assert(pruned.every(intent => intent.accountDeviceId === primary));
    const beforeNoopPrune = mutations;
    assert.equal(await a.mutate(draft => pruneExpiredRendezvousResults(draft.accountJoinIntents, Date.now())), 0);
    assert.equal(mutations,beforeNoopPrune);
    resultRetention = {rows:retained.length,beforeJsonBytes:Buffer.byteLength(JSON.stringify(retained)),afterJsonBytes:Buffer.byteLength(JSON.stringify(pruned)),
      beforeReadMs,afterReadMs,pruneMs,rollback:true,mixedWriterPreserved:true,phoneLinksPreserved:true};
  }
  console.log(JSON.stringify({ pass: true, isolatedSchema: schema, seededPhones: 300, seedInsertQueries,
    seededIntents: intentCount, deltaRows, deltaMs: Math.round(deltaMs),
    seedMs: Math.round(seedMs), concurrencyMs: Math.round(concurrencyMs), foreignKeyRollback: true, intentDeltaRollback: true,
    independentWritersSerialized: true, noOpWrites: 0, productionNamespaceReadOrWritten: false, resultRetention, computerRevocation }));
} finally {
  await Promise.all(pools.map((pool) => pool.end()));
  if (owned) { assert(/^qa_conn_batch_[a-f0-9]{24}$/.test(schema)); await bootstrap.query(`drop schema "${schema}" cascade`); }
  await bootstrap.end();
}
