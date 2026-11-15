import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { handleOwnerAuthRoutes } from '../accounts/owner-auth-routes.mjs';
import { normalizeDevicePublicKey, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';
import { createInstancePublicKeyFingerprint, buildOwnerAuthDeviceMessage } from '../lib/instance-proof-protocol.mjs';
import { createTurnConnectionId } from '../lib/turn-authorization.mjs';
import { createTurnLeaseId, createTurnOperationRequestId } from '../lib/turn-lease-identity.mjs';

test('phone inventory and exact-ID release recover quota without a reachable PC or stale-generation release', async t => {
  const now = Date.now(), iso = (offset = 0) => new Date(now + offset).toISOString();
  const accountId = 'acct_recovery', ownPhone = 'adev_recovery_own', otherPhone = 'adev_recovery_other', foreignAccount = 'acct_recovery_foreign';
  const pcKeys = generateKeyPairSync('ed25519'), pcPublicKey = pcKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyFingerprint = createInstancePublicKeyFingerprint(pcPublicKey);
  const instance = { instanceId: `inst_${keyFingerprint.slice(0, 32)}`, publicKey: pcPublicKey, keyFingerprint };
  const phones = [ownPhone, otherPhone, 'adev_recovery_foreign'];
  const tokens = phones.map((_, i) => `rac_${String.fromCharCode(65 + i).repeat(40)}`);
  const phoneKeys = phones.map(() => normalizeDevicePublicKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ type: 'spki', format: 'pem' }).toString()));
  let state = {
    accounts: [accountId, foreignAccount].map((id, i) => ({ accountId: id, provider: 'google', providerSubject: `recovery-${i}`, createdAt: iso() })),
    accountDevices: phones.map((deviceId, i) => ({ deviceId, accountId: i === 2 ? foreignAccount : accountId, createdAt: iso(), lastSeenAt: iso(), revokedAt: '' })),
    accountDeviceKeys: phoneKeys.map((key, i) => ({ ...key, deviceId: phones[i], accountId: i === 2 ? foreignAccount : accountId,
      fingerprint: createDevicePublicKeyFingerprint(key.publicKey), createdAt: iso(), revokedAt: '' })),
    accountCredentials: tokens.map((token, i) => ({ credentialId: `cred_recovery_${i}`, tokenHash: createHash('sha256').update(token).digest('hex'),
      accountId: i === 2 ? foreignAccount : accountId, deviceId: phones[i], keyId: phoneKeys[i].keyId, scope: 'account-directory',
      issuedAt: iso(), expiresAt: iso(3600000), lastUsedAt: iso(), revokedAt: '' })),
    instanceBindings: [{ accountId, instanceId: instance.instanceId, instancePublicKey: pcPublicKey,
      instanceKeyFingerprint: keyFingerprint, provider: 'google', boundAt: iso(), revokedAt: '' }],
    accountEntitlements: [{ accountId, plan: 'pro', source: 'manual', updatedAt: iso(), expiresAt: '' }],
  };
  const logical = deviceId => createTurnConnectionId({ accountId, instanceId: instance.instanceId, deviceId });
  const lease = (deviceId, quotaDeviceId, rest = {}) => ({ connectionId: createTurnLeaseId(logical(deviceId), undefined, now),
    accountId, instanceId: instance.instanceId, deviceId, quotaDeviceId, deviceKind: 'phone', plan: 'pro', status: 'reserved',
    createdAt: iso(), updatedAt: iso(), expiresAt: iso(60000), ...rest });
  const ownA = lease('rdev_recovery_a', ownPhone), ownB = lease('rdev_recovery_b', ownPhone, { instanceId: 'inst_recovery_b', status: 'connected', updatedAt: iso(5000) });
  const linked = lease('rdev_recovery_linked', 'rdev_recovery_linked', { instanceId: ownB.instanceId });
  const linkedByGrant = lease('rdev_recovery_old_link', 'rdev_recovery_old_link', { instanceId: ownB.instanceId });
  const others = [lease('rdev_recovery_other', otherPhone), lease('rdev_recovery_foreign', ownPhone, { accountId: foreignAccount }),
    lease('rdev_recovery_computer', ownPhone, { deviceKind: 'computer' }), lease('rdev_recovery_unlinked', 'rdev_recovery_unlinked'),
    lease('rdev_recovery_ambiguous', 'rdev_recovery_ambiguous'), lease('rdev_recovery_temporary', 'temporary_fixture')];
  const legacy = { ...lease('rdev_recovery_legacy', ownPhone), connectionId: logical('rdev_recovery_legacy') };
  state.turnConnectionLeases = [ownA, ownB, linked, linkedByGrant, ...others, legacy,
    lease('rdev_recovery_expired', ownPhone, { expiresAt: iso() }), lease('rdev_recovery_released', ownPhone, { status: 'released' })];
  state.accountJoinIntents = [['rdev_recovery_a', ownPhone], ['rdev_recovery_linked', ownPhone],
    ['rdev_recovery_ambiguous', ownPhone], ['rdev_recovery_ambiguous', otherPhone]].map(([deviceId, accountDeviceId], index) => ({
    intentId: `rji_recovery_${index}`, accountId, accountDeviceId, deviceId,
    instanceId: deviceId === linked.deviceId ? linked.instanceId : instance.instanceId, instance,
    devicePublicKey: 'fixture-key', devicePublicKeyFingerprint: 'fixture-fingerprint', nonceHash: 'fixture-nonce',
    issuedAt: iso(), createdAt: iso(), expiresAt: iso(60000), status: 'completed' }));
  state.accountJoinIntents.push({ intentId: 'rji_recovery_old', accountId, accountDeviceId: '', deviceId: linkedByGrant.deviceId,
    instanceId: linkedByGrant.instanceId, instance, devicePublicKey: 'fixture-key', devicePublicKeyFingerprint: 'fixture-fingerprint',
    nonceHash: 'fixture-nonce', issuedAt: iso(), createdAt: iso(), expiresAt: iso(-1000), status: 'completed' });
  state.accountJoinIntents.push({ ...state.accountJoinIntents[0], intentId: 'rji_recovery_duplicate' });
  state.accountJoinGrants = [{ grantHash: 'a'.repeat(64), accountId, instanceId: linkedByGrant.instanceId,
    intentId: 'rji_recovery_old', deviceId: linkedByGrant.deviceId, accountDeviceId: ownPhone,
    keyFingerprint: 'fixture-fingerprint', requestId: 'req_recovery_old', createdAt: iso(-2000),
    expiresAt: iso(-1000), redeemedAt: iso(-1500) }];
  let failCommit = false, sqlFailureInjected = false, tail = Promise.resolve(), mutations = 0, inventoryReads = 0;
  let storage = { mutate(fn) { const pending = tail.then(async () => {
    mutations++;
    const draft = structuredClone(state), result = await fn(draft);
    if (failCommit) throw new Error('injected transaction failure');
    state = draft; return result;
  }); tail = pending.catch(() => {}); return pending; },
  async readPhoneTurnInventorySnapshot() { inventoryReads++; return structuredClone(state); } };
  const url = process.env.RAGENT_ACCOUNTS_ISOLATED_TEST_DATABASE_URL;
  let qaPool;
  if (url) {
    const { Pool } = await import('pg'), { createPostgresStore } = await import('../accounts/store/postgres.mjs');
    const schema = 'qa_phone_turn_' + randomBytes(12).toString('hex'); assert(/^qa_phone_turn_[a-f0-9]{24}$/.test(schema));
    const pool = new Pool({ connectionString: url, max: 2, options: `-c search_path=${schema} -c statement_timeout=15000` });
    qaPool = pool;
    t.after(async () => { try { await pool.query(`drop schema "${schema}" cascade`); } finally { await pool.end(); } });
    await pool.query(`create schema "${schema}"`);
    const client = await pool.connect();
    try {
      await client.query('begin'); assert.equal((await client.query('select current_schema() as schema')).rows[0].schema, schema);
      const directory = new URL('../accounts/migrations/', import.meta.url);
      for (const file of (await readdir(directory)).filter(name => name.endsWith('.up.sql')).sort()) {
        const sql = await readFile(new URL(file, directory), 'utf8');
        assert(!/\bpublic\s*\.|\b(?:create\s+extension|alter\s+system|drop\s+schema|create\s+database)\b/i.test(sql));
        await client.query(sql);
      }
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    storage = createPostgresStore({ schema, pool: { connect: async () => {
      const connection = await pool.connect();
      return { release: () => connection.release(), query: async (sql, values) => {
        const result = await connection.query(sql, values);
        if (failCommit && /^insert into account_connection_leases\b/.test(sql)) { sqlFailureInjected = true; throw new Error('injected write failure'); }
        return result;
      } };
    } } });
    await storage.mutate(draft => Object.assign(draft, structuredClone(state)));
  }
  const snapshot = () => storage.mutate(draft => structuredClone(draft));
  const broker = createOwnerAuthBroker({ store: storage, clock: () => now, verifyGoogleCredential: async () => ({}),
    verifyNativeGoogleCredential: async () => ({}), resolveAccount: async () => ({ accountId }),
    signAssertion: async () => 'unused', signTurnBrokerCapability: async () => 'fixture-capability' });
  const server = createServer((req, res) => {
    handleOwnerAuthRoutes({ req, res, pathname: req.url, broker, publicBaseUrl: base, allowInsecurePublicBaseUrl: true })
      .then(handled => { if (!handled) { res.writeHead(404); res.end('{}'); } }).catch(() => { res.writeHead(500); res.end('{}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/accounts`;
  async function request(path, { token = tokens[0], body } = {}) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  const inventory = '/v1/owner-auth/account/turn/connections', release = inventory + '/release';
  const releaseIds = ids => request(release, { body: { connectionIds: ids, reason: 'cold-process-recovery', accountId: foreignAccount, deviceId: otherPhone } });
  try {
    assert.equal((await request(inventory, { token: '' })).status, 401);
    if (url) {
      // Reproduce a long-lived account without retaining test data after this
      // check. All rows live in the independently created QA schema.
      try {
        await qaPool.query(`insert into account_join_intents
          select (jsonb_populate_record(null::account_join_intents,
            to_jsonb(i) || jsonb_build_object('intent_id', 'rji_load_fixture_' || n))).*
          from account_join_intents i cross join generate_series(1, 6000) n
          where i.intent_id = 'rji_recovery_0'`);
        const count = await qaPool.query(`select count(*)::int as n from account_join_intents
          where left(intent_id, 17) = 'rji_load_fixture_'`);
        assert.equal(count.rows[0].n, 6000);
        const scoped = await storage.readPhoneTurnInventorySnapshot({
          tokenHash: createHash('sha256').update(tokens[0]).digest('hex'), now,
        });
        assert.equal(scoped.accountJoinIntents.filter(item => item.deviceId === ownA.deviceId).length, 1,
          'Thousands of terminal links for the same phone are returned once');
        assert.equal(scoped.accountJoinIntents.filter(item => item.deviceId === 'rdev_recovery_ambiguous').length, 2,
          'Different phone links must remain ambiguous');
        assert(scoped.accountJoinIntents.some(item => item.intentId === 'rji_recovery_old'));
        assert(scoped.accountJoinGrants.some(item => item.intentId === 'rji_recovery_old' && item.accountDeviceId === ownPhone),
          'Expired redeemed grants still establish legacy ownership');
        assert(scoped.turnConnectionLeases.every(item => item.accountId === accountId));
      } finally {
        await qaPool.query(`delete from account_join_intents where left(intent_id, 17) = 'rji_load_fixture_'`);
      }
    }
    if (!url) {
      const previous = mutations;
      assert.equal((await request(inventory)).status, 200);
      assert.equal(inventoryReads, 1);
      assert.equal(mutations, previous, 'A fresh inventory must not enter the global writer');
      await storage.mutate(draft => {
        draft.accountCredentials[0].lastUsedAt = iso(-120000);
        draft.accountDevices[0].lastSeenAt = iso(-120000);
      });
      const due = mutations;
      assert.equal((await request(inventory)).status, 200);
      assert.equal(mutations, due + 1, 'Due presence updates must be committed and revalidated');
      assert.equal(state.accountCredentials[0].lastUsedAt, iso());
      assert.equal(state.accountDevices[0].lastSeenAt, iso());
    }
    const beforeRead = await snapshot();
    const first = await request(inventory + '?limit=2&accountId=' + foreignAccount);
    assert.equal(first.status, 200); assert.match(first.cache, /no-store/);
    assert.equal(first.body.accountId, accountId); assert.equal(first.body.deviceId, ownPhone);
    assert.equal(first.body.legacyConnections, 1); assert.equal(first.body.connections.length, 2);
    const second = await request(inventory + '?after=' + first.body.nextCursor);
    const listed = [...first.body.connections, ...second.body.connections].map(row => row.connectionId).sort();
    assert.deepEqual(listed, [ownA, ownB, linked, linkedByGrant].map(row => row.connectionId).sort());
    assert.equal(second.body.nextCursor, null);
    assert.deepEqual((await snapshot()).turnConnectionLeases, beforeRead.turnConnectionLeases, 'Inventory cannot mutate lease status or expiry');
    assert(!JSON.stringify(first.body).includes('rac_') && !JSON.stringify(first.body).includes('publicKey'));
    for (const query of ['?limit=0', '?limit=101', '?after=invalid']) assert.equal((await request(inventory + query)).status, 400);
    const freshId = createTurnLeaseId(logical(ownA.deviceId), undefined, now);
    const reserveBody = { protocolVersion: 2, accountId, instance, deviceId: ownA.deviceId, deviceKind: 'phone',
      connectionId: freshId, expiresAt: iso(60000), issuedAt: iso(), audience: 'ragent-owner-auth-device' };
    reserveBody.requestId = createTurnOperationRequestId({ ...reserveBody, instanceId: instance.instanceId, purpose: 'turn-reserve' });
    reserveBody.signature = sign(null, Buffer.from(buildOwnerAuthDeviceMessage({ instanceId: instance.instanceId,
      transactionId: reserveBody.requestId, issuedAt: iso(), audience: reserveBody.audience, purpose: 'turn-reserve' })), pcKeys.privateKey).toString('base64');
    assert.equal((await request('/v1/owner-auth/turn/connections/reserve', { token: '', body: reserveBody })).status, 201);
    const captured = await snapshot();
    const released = await releaseIds(listed); assert.equal(released.status, 200); assert.equal(released.body.releasedConnections, 3);
    assert.equal(released.body.processedConnections, 4);
    const after = await snapshot();
    assert.equal(after.turnConnectionLeases.find(row => row.connectionId === freshId).status, 'reserved', 'Inventory captured before reconnect cannot release the new generation');
    assert.equal(after.turnConnectionLeases.find(row => row.connectionId === ownB.connectionId).updatedAt, ownB.updatedAt);
    for (const row of after.turnConnectionLeases.filter(row => others.some(other => other.connectionId === row.connectionId))) {
      assert.deepEqual(row, captured.turnConnectionLeases.find(other => other.connectionId === row.connectionId));
    }
    assert.equal((await releaseIds(listed)).body.releasedConnections, 0);
    assert.equal((await releaseIds(others.map(row => row.connectionId))).body.releasedConnections, 0);
    assert.equal((await releaseIds([freshId, legacy.connectionId])).status, 400, 'Stable legacy IDs cannot address a replacement through this API');
    assert.equal((await releaseIds([])).status, 400);
    assert.equal((await releaseIds(Array(101).fill(freshId))).status, 400);
    assert.equal((await request(release, { body: { connectionIds: [freshId], reason: 'arbitrary' } })).status, 400);
    const beforeFailure = await snapshot(); failCommit = true;
    assert.equal((await releaseIds([freshId])).status, 500); failCommit = false;
    if (url) assert(sqlFailureInjected);
    assert.deepEqual(await snapshot(), beforeFailure, 'Read actual persisted state after a failed release transaction');
    const final = await releaseIds([freshId, freshId]); assert.equal(final.body.releasedConnections, 1); assert.equal(final.body.processedConnections, 1);
    assert.equal((await request(inventory)).body.connections.length, 0);
    assert.equal((await request(inventory, { token: tokens[1] })).body.connections.length, 1, 'Another phone keeps its own inventory');
    await storage.mutate(draft => { draft.accountDeviceKeys.find(key => key.deviceId === ownPhone).revokedAt = iso(); });
    assert.equal((await request(inventory)).status, 403); assert.equal((await releaseIds([freshId])).status, 403);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
