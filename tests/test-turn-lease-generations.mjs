import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createServer } from 'node:http';
import { listenFetchLoopback } from './helpers/listen-fetch-loopback.mjs';

const home = await mkdtemp(join(tmpdir(), 'ragent-turn-generations-'));
Object.assign(process.env, { HOME: home, RAGENT_CONFIG_DIR: join(home, 'config'), RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
  RAGENT_ACCOUNTS_URL: 'https://turn-generation.fixture.invalid/accounts' });
delete process.env.RAGENT_INSTANCE_ROOT;
const { loadOrCreateInstanceIdentity, publicInstanceIdentity, signOwnerAuthDeviceProof } = await import('../lib/instance-identity.mjs');
const { createTurnConnectionId } = await import('../lib/turn-authorization.mjs');
const { createTurnLeaseId, createTurnOperationRequestId } = await import('../lib/turn-lease-identity.mjs');
const { createOwnerAuthBroker } = await import('../accounts/owner-auth-broker.mjs');
const { handleOwnerAuthRoutes } = await import('../accounts/owner-auth-routes.mjs');
const { verifyTurnBrokerCapability } = await import('../lib/turn-broker-capability.mjs');
const identity = await loadOrCreateInstanceIdentity();
const signing = generateKeyPairSync('ed25519');
const accountId = 'acct_turn_generation', phoneId = 'phone-generation', otherPhone = 'phone-other';
let now = Date.now(), signerFailure = false, signerBarrier = null, enteredSigner;
const iso = () => new Date(now).toISOString();
const initial = { accounts: [{ accountId, provider: 'google', providerSubject: 'turn-generation-fixture', createdAt: iso() }],
  instanceBindings: [{ accountId, instanceId: identity.instanceId, provider: 'google', boundAt: iso(),
    instancePublicKey: identity.publicKey, instanceKeyFingerprint: identity.keyFingerprint, revokedAt: '' }],
  devices: [phoneId, otherPhone].map(deviceId => ({ accountId, instanceId: identity.instanceId, deviceId,
    deviceKind: 'phone', createdAt: iso(), lastSeenAt: iso(), unboundAt: '' })) };
let state = structuredClone(initial), tail = Promise.resolve(), pgPool, schema, bootstrap, server;
let onEnqueue;
let store = { mutate(fn) { const operation = tail.then(async () => {
  const draft = structuredClone(state); const result = await fn(draft); state = draft; return result;
}); tail = operation.catch(() => {}); return operation; } };
try {
  const url = process.env.RAGENT_ACCOUNTS_ISOLATED_TEST_DATABASE_URL;
  if (url) {
    const { Pool } = await import('pg'); const { createPostgresStore } = await import('../accounts/store/postgres.mjs');
    schema = 'qa_turn_generation_' + randomBytes(12).toString('hex');
    assert(/^qa_turn_generation_[a-f0-9]{24}$/.test(schema));
    bootstrap = new Pool({ connectionString: url, max: 1 });
    await bootstrap.query(`create schema "${schema}"`);
    const admin = await bootstrap.connect();
    try {
      await admin.query('begin'); await admin.query(`set local search_path to "${schema}"`);
      assert.equal((await admin.query('select current_schema() as schema')).rows[0].schema, schema);
      const directory = new URL('../accounts/migrations/', import.meta.url);
      for (const file of (await readdir(directory)).filter(name => name.endsWith('.up.sql')).sort()) {
        const sql = await readFile(new URL(file, directory), 'utf8');
        assert(!/\bpublic\s*\.|\b(?:create\s+extension|alter\s+system|drop\s+schema|create\s+database)\b/i.test(sql));
        await admin.query(sql);
      }
      await admin.query('commit');
    } catch (error) { await admin.query('rollback'); throw error; } finally { admin.release(); }
    pgPool = new Pool({ connectionString: url, max: 2, options: `-c search_path=${schema} -c statement_timeout=15000` });
    store = createPostgresStore({ schema, pool: { connect: async () => {
      const client = await pgPool.connect();
      assert.equal((await client.query('select current_schema() as schema')).rows[0].schema, schema);
      return { release: () => client.release(), query: (sql, values) => {
        assert(!/\bpublic\s*\./i.test(sql)); return client.query(sql, values);
      } };
    } } });
    await store.mutate(draft => Object.assign(draft, structuredClone(initial)));
  }
  const mutate = store.mutate.bind(store);
  store.mutate = fn => { onEnqueue?.(); return mutate(fn); };
  const broker = createOwnerAuthBroker({ store, clock: () => now, issuer: 'https://turn-generation.fixture.invalid',
    verifyGoogleCredential: async () => ({}), resolveAccount: async () => ({ accountId }), signAssertion: async () => 'unused',
    signTurnBrokerCapability: async claims => {
      enteredSigner?.(); if (signerBarrier) await signerBarrier;
      if (signerFailure) throw Error('Controlled signer failure');
      const payload = [Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'turn-generation' })).toString('base64url'),
        Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
      return payload + '.' + sign(null, Buffer.from(payload), signing.privateKey).toString('base64url');
    } });
  server = createServer(async (req, res) => {
    if (!await handleOwnerAuthRoutes({ req, res, pathname: req.url, broker, publicBaseUrl: 'https://turn-generation.fixture.invalid/accounts' })) {
      res.writeHead(404); res.end('{}');
    }
  });
  await listenFetchLoopback(server);
  const base = `http://127.0.0.1:${server.address().port}/accounts/v1/owner-auth/turn/connections/`;
  const logical = deviceId => createTurnConnectionId({ accountId, instanceId: identity.instanceId, deviceId });
  function request(connectionId, purpose, { deviceId = phoneId, actor = identity, expiresAt = new Date(now + 300_000).toISOString(), reason = '', protocolVersion = 2 } = {}) {
    const body = { protocolVersion, accountId, deviceId, deviceKind: 'phone', connectionId, expiresAt, reason,
      instance: publicInstanceIdentity(actor), issuedAt: iso(), audience: 'ragent-owner-auth-device' };
    body.requestId = createTurnOperationRequestId({ ...body, instanceId: actor.instanceId, purpose });
    body.signature = signOwnerAuthDeviceProof(actor, { transactionId: body.requestId, purpose,
      issuedAt: body.issuedAt, audience: body.audience }).signature;
    return body;
  }
  async function post(path, body) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() };
  }
  const snapshot = () => store.mutate(draft => structuredClone(draft));
  const a = createTurnLeaseId(logical(phoneId)), b = createTurnLeaseId(logical(phoneId)); assert.notEqual(a, b);
  const firstRequest = request(a, 'turn-reserve');
  const first = await post('reserve', firstRequest); assert.equal(first.status, 201); assert.equal(first.body.authorization.connectionId, a);
  const verified = verifyTurnBrokerCapability({ token: first.body.brokerCredential.token,
    jwks: { keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'turn-generation' }] },
    issuer: 'https://turn-generation.fixture.invalid', accountId, instanceId: identity.instanceId, deviceId: phoneId, connectionId: a, nowMs: now });
  assert.equal(verified.connectionId, a);
  now += 1000;
  const newer = await post('reserve', request(b, 'turn-reserve')); assert.equal(newer.status, 201);
  assert.equal(newer.body.authorization.activePhones, 1); assert.equal(newer.body.authorization.activeComputers, 1);
  const stale = await post('release', request(a, 'turn-release')); assert.equal(stale.status, 200); assert.equal(stale.body.released, false);
  assert.equal((await snapshot()).turnConnectionLeases.find(lease => lease.connectionId === b).status, 'reserved');
  assert.equal((await post('reserve', firstRequest)).body.code, 'turn_connection_generation_retired');
  const deadline = newer.body.lease.expiresAt;
  now += 1000;
  assert.equal((await post('reserve', request(b, 'turn-reserve', { expiresAt: new Date(now + 900_000).toISOString() }))).body.lease.expiresAt, deadline);
  const release = request(b, 'turn-release');
  for (const change of [{ reason: 'tampered' }, { expiresAt: iso() }, { deviceKind: 'computer' }, { protocolVersion: 1 }]) {
    const denied = await post('release', { ...release, ...change }); assert(denied.status >= 400 && denied.status < 500);
  }
  assert.equal((await post('reserve', request(createTurnLeaseId(logical(otherPhone)), 'turn-reserve', { deviceId: otherPhone }))).status, 429);
  const beforeFailure = (await snapshot()).turnConnectionLeases;
  signerFailure = true;
  assert.equal((await post('reserve', request(createTurnLeaseId(logical(phoneId)), 'turn-reserve'))).status, 503);
  signerFailure = false; assert.deepEqual((await snapshot()).turnConnectionLeases, beforeFailure);
  let finishExpiredSigning;
  signerBarrier = new Promise(resolve => { finishExpiredSigning = resolve; });
  const expirySignerEntered = new Promise(resolve => { enteredSigner = resolve; });
  const expiringId = createTurnLeaseId(logical(phoneId));
  const expiresDuringSigning = post('reserve', request(expiringId, 'turn-reserve', { expiresAt: new Date(now + 1000).toISOString() }));
  await expirySignerEntered; now += 2000; finishExpiredSigning(); signerBarrier = null; enteredSigner = null;
  const expiredSigning = await expiresDuringSigning;
  assert.equal(expiredSigning.status, 503); assert.equal(expiredSigning.body.code, 'turn_broker_capability_expired');
  assert.deepEqual((await snapshot()).turnConnectionLeases, beforeFailure, 'Late signing does not supersede the active reservation');
  let releaseSigner; signerBarrier = new Promise(resolve => { releaseSigner = resolve; });
  const entered = new Promise(resolve => { enteredSigner = resolve; });
  const c = createTurnLeaseId(logical(phoneId));
  const pending = post('reserve', request(c, 'turn-reserve')); await entered;
  const releaseQueued = new Promise(resolve => { onEnqueue = () => { onEnqueue = null; resolve(); }; });
  const lateRelease = post('release', request(b, 'turn-release'));
  await releaseQueued;
  releaseSigner(); signerBarrier = null; enteredSigner = null;
  assert.equal((await pending).status, 201); assert.equal((await lateRelease).body.released, false);
  now -= 1000;
  assert.equal((await post('reserve', request(b, 'turn-reserve'))).body.code, 'turn_connection_generation_retired');
  assert.equal((await post('release', request(c, 'turn-release'))).body.released, true);
  assert.equal((await post('reserve', request(c, 'turn-reserve'))).body.code, 'turn_connection_generation_retired');
  // A fresh pool/snapshot writer preserves generation IDs without a new column.
  const retained = await snapshot(); assert(retained.turnConnectionLeases.some(lease => lease.connectionId === a && lease.status === 'released'));
  await writeFile(join(home, 'config', 'owner-account-binding.json'), JSON.stringify({ accountId, provider: 'google', boundAt: iso() }));
  const client = await import('../lib/owner-account-auth.mjs');
  const fetchImpl = async (url, options) => {
    const target = new URL(url); assert.equal(target.origin, 'https://turn-generation.fixture.invalid');
    assert.equal(JSON.parse(options.body).protocolVersion, 2);
    return fetch(`http://127.0.0.1:${server.address().port}${target.pathname}`, options);
  };
  const d = createTurnLeaseId(logical(phoneId));
  const fromClient = await client.reserveOwnerAccountTurnConnection({ deviceId: phoneId, connectionId: d,
    expiresAt: new Date(now + 300_000).toISOString(), fetchImpl, clock: () => now });
  assert.equal(fromClient.authorization.connectionId, d);
  await assert.rejects(() => client.reserveOwnerAccountTurnConnection({ deviceId: phoneId, connectionId: d,
    expiresAt: new Date(now + 300_000).toISOString(), clock: () => now,
    fetchImpl: async () => new Response(JSON.stringify({ code: 'turn_connection_quota_exceeded' }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    }),
  }), { code: 'turn_connection_quota_exceeded', statusCode: 429 });
  assert.equal((await client.releaseOwnerAccountTurnConnection({ deviceId: phoneId, connectionId: d,
    reason: 'client-complete', fetchImpl, clock: () => now })).released, true);
  const { reserveRendezvousTurnConnection } = await import('../lib/rendezvous-turn-reservation.mjs');
  const retryLease = createTurnLeaseId(logical(phoneId));
  const retryReservation = { deviceId: phoneId, connectionId: retryLease, expiresAt: new Date(now + 300_000).toISOString() };
  const retryRequests = [];
  const retried = await reserveRendezvousTurnConnection({ reservation: retryReservation,
    expiresAt: new Date(now + 30_000).toISOString(), clock: () => now, monotonicMillis: () => 0,
    wait: async () => {}, reserve: options => client.reserveOwnerAccountTurnConnection({ ...options, clock: () => now,
      fetchImpl: async (url, requestOptions) => {
        retryRequests.push(JSON.parse(requestOptions.body));
        if (retryRequests.length === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
        return fetchImpl(url, requestOptions);
      },
    }),
  });
  assert.equal(retried.authorization.connectionId, retryLease);
  assert.equal(retryRequests.length, 2);
  assert.equal(retryRequests[0].requestId, retryRequests[1].requestId);
  assert.equal(retryRequests[0].connectionId, retryRequests[1].connectionId);
  assert.equal(retryRequests[0].expiresAt, retryRequests[1].expiresAt);
  assert.equal((await client.releaseOwnerAccountTurnConnection({ deviceId: phoneId, connectionId: retryLease,
    reason: 'retry-test-complete', fetchImpl, clock: () => now })).released, true);
  const oldHandoff = createTurnLeaseId(logical(phoneId), undefined, now);
  const newHandoff = createTurnLeaseId(logical(phoneId), undefined, now);
  assert.equal((await post('reserve', request(oldHandoff, 'turn-reserve'))).status, 201);
  const offer = request(newHandoff, 'turn-reserve', { protocolVersion: 3,
    reason: `handoff:${oldHandoff}:${now + 40_000}` });
  assert.equal((await post('reserve', { ...offer, protocolVersion: 2 })).status, 401, 'Version downgrade changes the signed digest');
  assert.equal((await post('reserve', { ...offer, reason: `handoff:${oldHandoff}:${now + 80_000}` })).status, 401);
  const offered = await post('reserve', offer);
  assert.equal(offered.status, 201);
  assert.equal(offered.body.lease.handoffDeadline, new Date(now + 40_000).toISOString());
  let handoffSnapshot = (await snapshot()).turnConnectionLeases;
  assert.equal(handoffSnapshot.find(x => x.connectionId === oldHandoff).status, 'reserved');
  assert.equal(handoffSnapshot.find(x => x.connectionId === newHandoff).handoffFrom, oldHandoff);
  const commit = request(newHandoff, 'turn-handoff-commit', { protocolVersion: 3 });
  assert.equal((await post('handoff/commit', commit)).body.committed, true);
  assert.equal((await post('handoff/commit', commit)).body.committed, true, 'Lost commit replies can be retried');
  assert.equal((await post('release', request(oldHandoff, 'turn-release'))).body.released, true);
  assert.equal((await post('release', request(newHandoff, 'turn-release', { protocolVersion: 3 }))).body.released, true);
  const expiringOld = createTurnLeaseId(logical(phoneId), undefined, now);
  const expiringNext = createTurnLeaseId(logical(phoneId), undefined, now);
  assert.equal((await post('reserve', request(expiringOld, 'turn-reserve'))).status, 201);
  assert.equal((await post('reserve', request(expiringNext, 'turn-reserve', { protocolVersion: 3,
    reason: `handoff:${expiringOld}:${now + 2_000}` }))).status, 201);
  now += 2_000;
  assert.equal((await post('handoff/commit', request(expiringNext, 'turn-handoff-commit', { protocolVersion: 3 }))).status, 409);
  handoffSnapshot = (await snapshot()).turnConnectionLeases;
  assert.equal(handoffSnapshot.find(x => x.connectionId === expiringOld).status, 'reserved');
  assert.equal((await post('release', request(expiringOld, 'turn-release'))).body.released, true);
  const clientOld = createTurnLeaseId(logical(phoneId), undefined, now);
  const clientNext = createTurnLeaseId(logical(phoneId), undefined, now);
  const v3Fetch = async (url, options) => {
    const target = new URL(url);
    return fetch(`http://127.0.0.1:${server.address().port}${target.pathname}`, options);
  };
  await client.reserveOwnerAccountTurnConnection({ deviceId: phoneId, connectionId: clientOld,
    expiresAt: new Date(now + 300_000).toISOString(), fetchImpl: v3Fetch, clock: () => now });
  const v3Lease = await client.reserveOwnerAccountTurnConnection({ deviceId: phoneId, connectionId: clientNext,
    protocolVersion: 3, reason: `handoff:${clientOld}:${now + 40_000}`,
    expiresAt: new Date(now + 300_000).toISOString(), fetchImpl: v3Fetch, clock: () => now });
  assert.equal(v3Lease.authorization.connectionId, clientNext);
  assert.equal((await client.commitOwnerAccountTurnHandoff({ deviceId: phoneId, connectionId: clientNext,
    fetchImpl: v3Fetch, clock: () => now })).committed, true);
  await client.releaseOwnerAccountTurnConnection({ deviceId: phoneId, connectionId: clientOld, fetchImpl: v3Fetch, clock: () => now });
  await client.releaseOwnerAccountTurnConnection({ deviceId: phoneId, connectionId: clientNext,
    protocolVersion: 3, fetchImpl: v3Fetch, clock: () => now });
  now += 181_000;
  const e = createTurnLeaseId(logical(phoneId), undefined, now);
  assert.equal((await post('reserve', request(e, 'turn-reserve'))).status, 201);
  assert.equal((await post('reserve', request(e, 'turn-reserve'))).status, 201);
  assert.equal((await post('release', request(e, 'turn-release'))).body.released, true);
  assert(!(await snapshot()).turnConnectionLeases.some(lease => lease.connectionId === a), 'Old tombstones are bounded');
  now -= 181_000;
  assert.equal((await post('reserve', request(a, 'turn-reserve'))).body.code, 'turn_connection_generation_retired',
    'Persisted pair clock prevents re-admission after pruning and wall-clock rollback');

  // Cold recovery keeps the physical account phone's quota identity even if
  // the target-local enrollment differs between computers or changes on rejoin.
  const secondPc = await loadOrCreateInstanceIdentity({ filePath: join(home, 'second-pc.json') });
  const phoneA = 'adev_quota_phone_a', phoneB = 'adev_quota_phone_b', thirdPhone = 'adev_quota_phone_c';
  const targetA1 = 'rdev_quota_a1', targetA2 = 'rdev_quota_a2', targetB1 = 'rdev_quota_b1', targetNewA1 = 'rdev_quota_new_a1';
  await store.mutate(draft => {
    draft.instanceBindings.push({ accountId, instanceId: secondPc.instanceId, provider: 'google', boundAt: iso(),
      instancePublicKey: secondPc.publicKey, instanceKeyFingerprint: secondPc.keyFingerprint, revokedAt: '' });
    draft.accountEntitlements = [{ accountId, plan: 'free', source: 'manual', updatedAt: iso(), expiresAt: '' }];
    draft.accountDevices = [phoneA, phoneB, thirdPhone].map(deviceId => ({ accountId, deviceId, createdAt: iso(), lastSeenAt: iso(), revokedAt: '' }));
    draft.accountJoinIntents = [
      [identity, targetA1, phoneA], [secondPc, targetA2, phoneA], [identity, targetB1, phoneB],
      [identity, targetNewA1, phoneA], [secondPc, 'rdev_quota_c2', thirdPhone],
    ].map(([actor, deviceId, accountDeviceId], index) => ({ intentId: `rji_quota_${index}`, accountId, accountDeviceId,
      instanceId: actor.instanceId, instance: publicInstanceIdentity(actor), deviceId, devicePublicKey: 'fixture-key',
      devicePublicKeyFingerprint: 'fixture-fingerprint', nonceHash: 'fixture-nonce', issuedAt: iso(), createdAt: iso(),
      expiresAt: new Date(now + 60_000).toISOString(), status: 'completed' }));
    // Pre-015 leases persisted rdev_ as quota identity. The terminal completion
    // supplies the exact physical-phone link; names/keys cannot substitute.
    draft.turnConnectionLeases.push({ connectionId: createTurnConnectionId({ accountId, instanceId: identity.instanceId, deviceId: targetA1 }),
      accountId, instanceId: identity.instanceId, deviceId: targetA1, quotaDeviceId: targetA1, deviceKind: 'phone',
      plan: 'free', status: 'connected', createdAt: iso(), updatedAt: iso(), expiresAt: new Date(now + 300_000).toISOString() });
  });
  const leaseFor = (actor, deviceId) => createTurnLeaseId(createTurnConnectionId({ accountId, instanceId: actor.instanceId, deviceId }), undefined, now);
  const firstA = leaseFor(identity, targetA1), firstB = leaseFor(identity, targetB1), secondA = leaseFor(secondPc, targetA2);
  const beforeLegacyRecovery = (await snapshot()).turnConnectionLeases;
  signerFailure = true;
  assert.equal((await post('reserve', request(firstA, 'turn-reserve', { deviceId: targetA1 }))).status, 503);
  signerFailure = false;
  assert.deepEqual((await snapshot()).turnConnectionLeases, beforeLegacyRecovery, 'Failed signing cannot publish legacy quota normalization');
  const legacyRecovery = await post('reserve', request(firstA, 'turn-reserve', { deviceId: targetA1 }));
  assert.equal(legacyRecovery.status, 201, 'A completed pre-015 enrollment can renew while the free phone slot is occupied');
  assert.equal(legacyRecovery.body.authorization.activePhones, 1);
  await store.mutate(draft => { draft.accountEntitlements[0].plan = 'plus'; });
  assert.equal((await post('reserve', request(firstB, 'turn-reserve', { deviceId: targetB1 }))).status, 201);
  const dual = await post('reserve', request(secondA, 'turn-reserve', { deviceId: targetA2, actor: secondPc }));
  assert.equal(dual.status, 201, 'An already counted account phone can add its second computer when phone slots are full');
  assert.equal(dual.body.authorization.activePhones, 2); assert.equal(dual.body.authorization.activeComputers, 2);
  const restartedA = leaseFor(identity, targetA1);
  assert.equal((await post('reserve', request(restartedA, 'turn-reserve', { deviceId: targetA1 }))).status, 201,
    'Cold recovery can replace its old reservation without needing an extra phone slot');
  assert.equal((await post('release', request(firstA, 'turn-release', { deviceId: targetA1 }))).body.released, false);
  const beforeRejoin = (await snapshot()).turnConnectionLeases;
  const rejoinedA = leaseFor(identity, targetNewA1);
  signerFailure = true;
  assert.equal((await post('reserve', request(rejoinedA, 'turn-reserve', { deviceId: targetNewA1 }))).status, 503);
  signerFailure = false;
  assert.deepEqual((await snapshot()).turnConnectionLeases, beforeRejoin, 'Failed rejoin capability signing preserves the prior physical phone reservation');
  const rejoin = await post('reserve', request(rejoinedA, 'turn-reserve', { deviceId: targetNewA1 })); assert.equal(rejoin.status, 201);
  const afterRejoin = (await snapshot()).turnConnectionLeases;
  assert.equal(afterRejoin.find(lease => lease.connectionId === restartedA).status, 'released', 'A new enrollment cannot stack active leases for the same physical phone/computer');
  assert.equal(afterRejoin.find(lease => lease.connectionId === secondA).status, 'reserved');
  assert.equal(afterRejoin.find(lease => lease.connectionId === firstB).status, 'reserved');
  assert.equal((await post('release', request(restartedA, 'turn-release', { deviceId: targetA1 }))).body.released, false);
  assert.equal((await post('reserve', { ...request(leaseFor(secondPc, 'rdev_quota_c2'), 'turn-reserve', { deviceId: 'rdev_quota_c2', actor: secondPc }),
    quotaDeviceId: phoneA })).status, 429,
    'A genuinely new physical phone still consumes a new slot');
  verifyTurnBrokerCapability({ token: rejoin.body.brokerCredential.token,
    jwks: { keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'turn-generation' }] },
    issuer: 'https://turn-generation.fixture.invalid', accountId, instanceId: identity.instanceId,
    deviceId: targetNewA1, connectionId: rejoinedA, nowMs: now });
  console.log('PASS physical account-phone quota: full-slot dual computer, cold replacement, changed enrollment, atomic signer failure, exact old release and real new-phone rejection');
  console.log(`PASS TURN generation HTTP/signatures, stale release, immutable expiry, parameter binding, quota, atomic signer failure, concurrent release and clock rollback (${url ? 'real PostgreSQL' : 'transactional memory fixture'})`);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await pgPool?.end();
  if (bootstrap) { if (schema) await bootstrap.query(`drop schema "${schema}" cascade`); await bootstrap.end(); }
  const absolute = await realpath(home), parent = await realpath(tmpdir()); assert(absolute.startsWith(parent + sep) && absolute.includes('ragent-turn-generations-'));
  await rm(absolute, { recursive: true, force: true });
}
