// Explicit owned loopback cluster only. Real HTTP, signature checks and SQL rollback.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Pool } from 'pg';
import { createAccountsServer } from '../accounts/server.mjs';
import { createPostgresStore } from '../accounts/store/postgres.mjs';
import { accountPairingHash, buildAccountPairingProof } from '../lib/account-pairing-protocol.mjs';
import { buildAccountSessionMessage, buildDesktopAccountSessionAuthorization,
  createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';

const databaseUrl = process.env.RAGENT_ACCOUNTS_ISOLATED_TEST_DATABASE_URL;
const ownedData = process.env.RAGENT_TEST_OWNED_CLUSTER_DATA;
assert(databaseUrl && ownedData, 'An explicitly owned cluster is required');
assert.equal(new URL(databaseUrl).hostname, '127.0.0.1');
const schema = `qa_delegated_qr_${randomBytes(12).toString('hex')}`;
assert.match(schema, /^qa_delegated_qr_[a-f0-9]{24}$/);
const bootstrap = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
const pools = [];
const root = await mkdtemp(join(tmpdir(), 'ragent-delegated-qr-'));
let owned = false, server, app, failApprovedInsert = false, injectedAfterSqlInsert = false;
let now = Date.now();
const cipherKeys = { activeKeyId: 'isolated-qr', keys: { 'isolated-qr': randomBytes(32).toString('base64') } };
function store() {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema} -c statement_timeout=15000` });
  pools.push(pool);
  return createPostgresStore({ pool: { connect: async () => {
    const client = await pool.connect();
    try { assert.equal((await client.query('select current_schema() as schema')).rows[0].schema, schema); }
    catch (error) { client.release(); throw error; }
    return { release: () => client.release(), query: async (sql, values = []) => {
      assert(!/\bpublic\s*\./i.test(sql));
      if (/pg_advisory/.test(sql)) {
        assert.equal(sql, 'select pg_advisory_xact_lock(hashtext($1))');
        assert.deepEqual(values, ['ragent_accounts_store_v1']);
        return client.query(sql, [`ragent_accounts_store_v1:${schema}`]);
      }
      const result = await client.query(sql, values);
      if (failApprovedInsert && /^insert into account_pairing_exchanges\b/.test(sql) && values.includes('APPROVED')) {
        failApprovedInsert = false; injectedAfterSqlInsert = true;
        // The real credential and approved delivery have already reached SQL.
        // A PostgreSQL error must roll back the entire transaction.
        await client.query('select 1 / 0');
      }
      return result;
    } };
  } } });
}
const pc = generateKeyPairSync('ed25519'), phone = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pcKey = pc.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const phoneKey = phone.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const accountId = 'acct_delegated_pg', instanceId = 'inst_delegated_pg_desktop_0001';
const invitationId = 'rpinv_delegated_pg_ticket_0001', deviceId = 'adev_delegated_pg_phone_0001';
const token = randomBytes(32).toString('base64url');
const proof = (action, payload = {}, key = pc) => {
  const input = { instanceId, invitationId, issuedAt: now, nonce: randomBytes(18).toString('hex'), payload };
  input.signature = sign(key === pc ? null : 'sha256', Buffer.from(buildAccountPairingProof(action, input)), key.privateKey).toString('base64url');
  return input;
};
try {
  const metadata = (await bootstrap.query("select current_setting('data_directory') as directory, inet_server_addr()::text as address")).rows[0];
  assert.equal((await realpath(metadata.directory)).toLowerCase(), (await realpath(ownedData)).toLowerCase());
  assert.equal(metadata.address, '127.0.0.1/32');
  await bootstrap.query(`create schema "${schema}"`); owned = true;
  const admin = await bootstrap.connect();
  try {
    await admin.query('begin'); await admin.query(`set local search_path to "${schema}"`);
    const directory = new URL('../accounts/migrations/', import.meta.url);
    const migrations = (await readdir(directory)).filter(p => p.endsWith('.up.sql')).sort();
    assert(migrations.includes('029_account_pairing_exchanges.up.sql'));
    for (const file of migrations) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      assert(!/\bpublic\s*\.|\b(?:create\s+extension|alter\s+system|drop\s+schema|create\s+database)\b/i.test(sql));
      await admin.query(sql);
    }
    await admin.query('commit');
  } catch (error) { await admin.query('rollback'); throw error; }
  finally { admin.release(); }
  const first = store(), independent = store();
  await first.mutate(draft => {
    draft.accounts.push({ accountId, provider: 'google', providerSubject: 'delegated-pg-owner', createdAt: new Date(now).toISOString() });
    draft.instanceBindings.push({ instanceId, accountId, provider: 'google', instancePublicKey: pcKey,
      instanceKeyFingerprint: createInstancePublicKeyFingerprint(pcKey), boundAt: new Date(now).toISOString(), revokedAt: '' });
  });
  server = createServer((req, res) => app.handler(req, res));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = selectedStore => ({ store: selectedStore, publicBaseUrl: base, allowInsecurePublicBaseUrl: true,
    signingKeyFile: join(root, 'signing.json'), turnBrokerSigningKeyFile: join(root, 'turn-signing.json'),
    temporaryPairingKeyRing: cipherKeys, clock: () => now,
    verifyGoogleCredential: async () => { throw Error('Google must not be called'); },
    verifyNativeGoogleCredential: async () => { throw Error('Google must not be called'); } });
  app = await createAccountsServer(options(first));
  const post = async (pathname, input) => {
    const response = await fetch(base + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(10_000) });
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    return { status: response.status, body: await response.json() };
  };
  const pairing = (action, payload = {}, key = pc) => post(`/v1/account-pairing/${action}`, proof(action, payload, key));
  assert.equal((await pairing('register', { tokenHash: accountPairingHash(token), expiresAt: now + 120_000 })).status, 201);
  const challengeReply = await post('/v1/owner-auth/native/session/challenge', {
    requestId: 'delegated_pg_phone_request_0001', device: { deviceId, publicKey: phoneKey, platform: 'android' } });
  assert.equal(challengeReply.status, 201);
  const challenge = challengeReply.body;
  const material = { transactionId: challenge.transactionId, requestId: 'delegated_pg_phone_request_0001', deviceId,
    publicKeyFingerprint: createDevicePublicKeyFingerprint(phoneKey), nonce: challenge.nonce };
  const deviceSignature = sign('sha256', Buffer.from(buildAccountSessionMessage(material)), phone.privateKey).toString('base64');
  assert.equal((await pairing('claim', { token, transactionId: challenge.transactionId, requestId: material.requestId, deviceSignature }, phone)).status, 200);
  assert.equal((await pairing('result', {}, phone)).body.session, null);
  const desktopProof = { instanceId, accountId, issuedAt: new Date(now).toISOString() };
  desktopProof.signature = sign(null, Buffer.from(buildDesktopAccountSessionAuthorization({ ...material, ...desktopProof })), pc.privateKey).toString('base64url');
  const invalidApproval = await pairing('approve', { desktopProof: { ...desktopProof, signature: 'bad' } });
  assert.equal(invalidApproval.status, 403);
  assert.equal(invalidApproval.body.code, 'owner_auth_desktop_authorization_invalid');
  const snapshot = () => independent.mutate(draft => structuredClone({ keys: draft.accountDeviceKeys,
    devices: draft.accountDevices, credentials: draft.accountCredentials, challenges: draft.accountSessionChallenges,
    exchanges: draft.accountPairingExchanges }));
  const before = await snapshot();
  failApprovedInsert = true;
  assert.equal((await pairing('approve', { desktopProof })).status, 503);
  assert(injectedAfterSqlInsert, 'The injection must happen after the approved row SQL insert');
  assert.deepEqual(await snapshot(), before, 'Credential, consumed challenge and encrypted delivery must roll back together');
  assert.equal((await pairing('approve', { desktopProof })).status, 200);
  const delivered = await pairing('result', {}, phone);
  assert.equal(delivered.status, 200); assert.match(delivered.body.session.credential.token, /^rac_/);
  assert.equal(delivered.body.session.accountId, accountId); assert.equal(delivered.body.session.deviceId, deviceId);
  const credential = delivered.body.session.credential.token;
  const committed = await snapshot();
  assert.equal(committed.credentials.length, 1); assert(committed.challenges[0].consumedAt);
  assert.equal(committed.exchanges[0].status, 'APPROVED'); assert(committed.exchanges[0].sealedSession);
  assert(!JSON.stringify(committed).includes(credential)); assert(!JSON.stringify(committed).includes(token));
  const inbox = await pairing('inbox');
  assert.equal(inbox.status, 200); assert.equal(inbox.body.session, undefined); assert(!JSON.stringify(inbox.body).includes(credential));
  // A new Accounts object and independent store queue have no completion cache.
  app = await createAccountsServer(options(independent));
  assert.equal((await pairing('result', {}, phone)).body.session.credential.token, credential);
  const directory = await fetch(base + '/v1/owner-auth/account/devices', {
    headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  assert.equal(directory.status, 200, 'The redelivered RAC must authenticate against the reopened SQL state');
  assert((await directory.json()).devices.some(device => device.deviceId === deviceId));
  assert.equal((await pairing('approve', { desktopProof })).status, 200);
  assert.equal((await snapshot()).credentials.length, 1);
  const replay = proof('result', {}, phone);
  assert.equal((await post('/v1/account-pairing/result', replay)).status, 200);
  assert.equal((await post('/v1/account-pairing/result', replay)).status, 409);
  now += 120_000;
  assert.equal((await pairing('result', {}, phone)).status, 410);
  now -= 120_000;
  assert.equal((await pairing('result', {}, phone)).status, 410);
  assert.equal((await snapshot()).exchanges[0].sealedSession, null);
  console.log(JSON.stringify({ pass: true, actualPostgres: true, actualHttpSignatures: true, sqlInsertThenRollback: true,
    reopenedSameCredential: true, issuedCredentialUsable: true, exactCredentialCount: 1, noCredentialInPcProjection: true,
    encryptedDeliveryAtRest: true, nonceReplayRejected: true, expiredDeliveryCannotRevive: true,
    googleContacted: false, productionChanged: false }));
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await Promise.all(pools.map(pool => pool.end()));
  if (owned) { assert.match(schema, /^qa_delegated_qr_[a-f0-9]{24}$/); await bootstrap.query(`drop schema "${schema}" cascade`); }
  await bootstrap.end();
  const absolute = await realpath(root), parent = await realpath(tmpdir());
  assert(absolute.startsWith(parent + sep) && absolute.includes('ragent-delegated-qr-'));
  await rm(absolute, { recursive: true, force: true });
}
