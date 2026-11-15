import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { handleOwnerAuthRoutes } from '../accounts/owner-auth-routes.mjs';
import { buildAccountSessionMessage, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';
import { buildOwnerAuthDeviceMessage, createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { createTurnConnectionId } from '../lib/turn-authorization.mjs';

test('phone revoke atomically releases only its linked leases and removes device associations', async t => {
  let now = Date.parse('2026-10-25T10:00:00.123Z'), failCommit = false, failedAfterLeaseWrite = false;
  const databaseUrl = process.env.RAGENT_ACCOUNTS_ISOLATED_TEST_DATABASE_URL;
  const iso = (offset = 0) => new Date(now + offset).toISOString();
  const accountId = 'acct_phone_revoke', victim = 'adev_phone_victim', controller = 'adev_phone_controller';
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const keyFingerprint = createInstancePublicKeyFingerprint(publicKey);
  const instance = { instanceId: `inst_${keyFingerprint.slice(0, 32)}`, publicKey, keyFingerprint };
  let state = { accounts: [{ accountId, provider: 'google', providerSubject: 'phone-revoke', createdAt: iso() },
    { accountId: 'acct_foreign', provider: 'google', providerSubject: 'phone-revoke-foreign', createdAt: iso() }],
    instanceBindings: [{ ...instance, instancePublicKey: publicKey, instanceKeyFingerprint: keyFingerprint, accountId,
      provider: 'google', boundAt: iso(), revokedAt: '' }],
    accountEntitlements: [{ accountId, plan: 'pro', source: 'manual', expiresAt: iso(3600000), updatedAt: iso() }] };
  let storage = { mutate: async fn => fn(structuredClone(state)) };
  if (databaseUrl) {
    const { Pool } = await import('pg'), { createPostgresStore } = await import('../accounts/store/postgres.mjs');
    const schema = 'qa_phone_revoke_' + randomBytes(12).toString('hex');
    assert(/^qa_phone_revoke_[a-f0-9]{24}$/.test(schema));
    const pool = new Pool({ connectionString: databaseUrl,
      options: `-c search_path=${schema} -c statement_timeout=15000`, max: 2 });
    t.after(async () => { try { await pool.query(`drop schema "${schema}" cascade`); } finally { await pool.end(); } });
    await pool.query(`create schema "${schema}"`);
    const client = await pool.connect();
    try {
      await client.query('begin');
      assert.equal((await client.query('select current_schema() as schema')).rows[0].schema, schema);
      const directory = new URL('../accounts/migrations/', import.meta.url);
      for (const name of (await readdir(directory)).filter(name => name.endsWith('.up.sql')).sort()) {
        const sql = await readFile(new URL(name, directory), 'utf8');
        assert(!/\bpublic\s*\.|\b(?:create\s+extension|alter\s+system|drop\s+schema|create\s+database)\b/i.test(sql));
        await client.query(sql);
      }
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    storage = createPostgresStore({ schema, pool: { connect: async () => {
      const connection = await pool.connect();
      return { release: () => connection.release(), query: async (sql, values) => {
        const result = await connection.query(sql, values);
        if (failCommit && /^insert into account_connection_leases\b/.test(sql)) {
          failedAfterLeaseWrite = true;
          throw new Error('injected failure after writing lease rows');
        }
        return result;
      } };
    } } });
    await storage.mutate(draft => Object.assign(draft, structuredClone(state)));
  }
  const store = { mutate: async fn => {
    let published;
    const result = await storage.mutate(async draft => {
      const result = await fn(draft);
      if (failCommit && !databaseUrl) throw new Error('injected transaction failure');
      published = structuredClone(draft); return result;
    });
    state = published; return result;
  } };
  const broker = createOwnerAuthBroker({ clock: () => now, store,
    verifyGoogleCredential: async () => ({ sub: 'phone-revoke' }), verifyNativeGoogleCredential: async () => ({ sub: 'phone-revoke' }),
    resolveAccount: async () => ({ accountId }), signAssertion: async () => 'unused', signTurnBrokerCapability: async () => 'unused' });
  async function login(deviceId) {
    const phone = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const phoneKey = phone.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const requestId = `session-${deviceId}-0001`;
    const challenge = await broker.createAccountSessionChallenge({ requestId, device: { deviceId, publicKey: phoneKey, platform: 'android' } });
    const result = await broker.completeAccountSession({ requestId, transactionId: challenge.transactionId, idToken: 'fixture',
      signature: sign('sha256', Buffer.from(buildAccountSessionMessage({ requestId, transactionId: challenge.transactionId, deviceId,
        publicKeyFingerprint: createDevicePublicKeyFingerprint(phoneKey), nonce: challenge.nonce })), phone.privateKey).toString('base64') });
    return result.credential.token;
  }
  const ownerToken = await login(controller), victimToken = await login(victim);
  const lease = (id, phone, { deviceId = `rdev_${id}`, status = 'reserved', offset = 60000, ...rest } = {}) => ({
    connectionId: id, accountId, instanceId: instance.instanceId, deviceId, quotaDeviceId: phone, deviceKind: 'phone',
    status, createdAt: iso(), updatedAt: iso(), expiresAt: iso(offset), ...rest });
  state.turnConnectionLeases = [lease('victim-direct', victim), lease('victim-other-pc', victim, { instanceId: 'inst_other', status: 'connected' }),
    lease('linked-intent', '', { deviceId: 'rdev_linked' }), lease('linked-grant', 'rdev_grant', { deviceId: 'rdev_grant' }),
    lease('controller', controller), lease('expired', victim, { offset: 0 }), lease('released', victim, { status: 'released', releaseReason: 'previous' }),
    lease('foreign', victim, { accountId: 'acct_foreign' }), lease('computer', victim, { deviceKind: 'computer' }),
    lease('pending', '', { deviceId: 'rdev_pending' }), lease('wrong-target', '', { deviceId: 'rdev_linked', instanceId: 'inst_unrelated' }),
    lease('explicit-other', controller, { deviceId: 'rdev_linked' })];
  state.turnConnectionLeases[0].updatedAt = iso(5000); // Previously observed time survives wall-clock rollback.
  state.accountJoinIntents = [
    { intentId: 'rji_linked', accountId, instanceId: instance.instanceId, deviceId: 'rdev_linked', accountDeviceId: victim, status: 'completed' },
    { intentId: 'rji_grant', accountId, instanceId: instance.instanceId, deviceId: 'rdev_grant', accountDeviceId: '', status: 'rendezvous_completed' },
    { intentId: 'rji_pending', accountId, instanceId: instance.instanceId, deviceId: 'rdev_pending', accountDeviceId: victim, status: 'pending' },
  ];
  state.accountJoinGrants = [{ intentId: 'rji_grant', accountId, instanceId: instance.instanceId, deviceId: 'rdev_grant',
    accountDeviceId: victim, grantHash: 'phone-grant-hash', keyFingerprint: 'fixture-key', requestId: 'phone-grant-request',
    redeemedAt: iso(-1000), createdAt: iso(-2000), expiresAt: iso(60000) }];
  for (const intent of state.accountJoinIntents) Object.assign(intent, { instance, devicePublicKey: 'fixture-key',
    devicePublicKeyFingerprint: 'fixture-fingerprint', nonceHash: 'fixture-nonce', issuedAt: iso(), createdAt: iso(), expiresAt: iso(60000) });
  // A legacy row must not bypass a known account-phone revocation.
  state.devices = [{ accountId, instanceId: instance.instanceId, deviceId: 'rdev_linked', deviceKind: 'phone', unboundAt: '', createdAt: iso() }];
  const seeded = structuredClone(state);
  await store.mutate(draft => Object.assign(draft, seeded));
  await store.mutate(() => {}); // Reopen actual persisted rows before comparing history.
  const server = createServer((req, res) => {
    handleOwnerAuthRoutes({ req, res, pathname: req.url, broker, publicBaseUrl: base,
      googleWebClientId: 'fixture.apps.googleusercontent.com', allowInsecurePublicBaseUrl: true })
      .then(handled => { if (!handled) { res.writeHead(404); res.end('{}'); } })
      .catch(() => { res.writeHead(500); res.end('{}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/accounts`;
  async function request(path, token = ownerToken, body) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(databaseUrl ? 120000 : 10000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }
  const revoke = id => request(`/v1/owner-auth/account/devices/${id}/revoke`, ownerToken, {});
  try {
    const before = structuredClone(state);
    const initialUsage = await request('/v1/owner-auth/account/usage');
    assert.equal(initialUsage.body.turn.connections.active, 9);
    failCommit = true;
    assert.equal((await revoke(victim)).status, 500);
    failCommit = false;
    if (databaseUrl) assert(failedAfterLeaseWrite, 'The SQL rollback probe must fail after lease writes actually executed');
    await store.mutate(() => {});
    assert.deepEqual(state, before, 'A failed transaction cannot publish credentials or quota changes');
    const result = await revoke(victim);
    assert.equal(result.status, 200);
    assert.equal(result.body.releasedConnections, 4, 'Phone revoke must release explicit and durably linked legacy leases');
    const releasedIds = new Set(['victim-direct', 'victim-other-pc', 'linked-intent', 'linked-grant']);
    assert(state.turnConnectionLeases.filter(row => releasedIds.has(row.connectionId)).every(row => row.status === 'released' && row.releaseReason === 'phone-revoked'));
    assert.equal(state.turnConnectionLeases.find(row => row.connectionId === 'victim-direct').updatedAt, iso(5000));
    assert.deepEqual(state.turnConnectionLeases.filter(row => !releasedIds.has(row.connectionId)), before.turnConnectionLeases.filter(row => !releasedIds.has(row.connectionId)), 'Other phones/accounts/kinds/targets, pending joins and history remain unchanged');
    assert.equal((await request('/v1/owner-auth/account/usage')).body.turn.connections.active, 5);
    assert.equal(state.accountCredentials.filter(row => row.deviceId === victim).length, 0);
    assert.equal(state.accountDeviceKeys.filter(row => row.deviceId === victim).length, 0);
    assert.equal(state.accountDevices.filter(row => row.deviceId === victim).length, 0);
    assert(state.accountDevices.some(row => row.deviceId === controller));
    assert.equal(state.devices.filter(row => row.deviceId === 'rdev_linked').length, 0);
    assert.equal((await request('/v1/owner-auth/account/usage', victimToken)).status, 401);
    now += 1000;
    const repeated = await revoke(victim);
    assert.equal(repeated.status, 404);
    const deviceId = 'rdev_linked', connectionId = createTurnConnectionId({ accountId, instanceId: instance.instanceId, deviceId });
    const fields = { instanceId: instance.instanceId, transactionId: connectionId, purpose: 'turn-reserve', issuedAt: iso(), audience: 'ragent-owner-auth-device' };
    const reserve = await request('/v1/owner-auth/turn/connections/reserve', '', { ...fields, instance, requestId: connectionId,
      accountId, deviceId, deviceKind: 'phone', connectionId, expiresAt: iso(60000),
      signature: sign(null, Buffer.from(buildOwnerAuthDeviceMessage(fields)), keys.privateKey).toString('base64') });
    assert.equal(reserve.status, 403, 'A legacy device row cannot reopen quota after its linked phone was revoked');
    assert.equal(reserve.body.code, 'turn_connection_device_invalid');
    const foreign = await revoke('adev_foreign_missing'); assert.equal(foreign.status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
