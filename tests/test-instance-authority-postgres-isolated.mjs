// Exercise real mixed snapshot writers without reading any production table.
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { buildAccountJoinIntentProofMessage, buildBindingAuthorityProofMessage, buildInstanceProofMessage, buildNativeOwnerAuthMessage,
  buildNativeOwnerAuthRollbackMessage, buildOwnerAuthPollMessage, createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { buildAccountJoinIntentMessage, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';
import { handleOwnerAuthRoutes } from '../accounts/owner-auth-routes.mjs';
import { verifyBindingAuthorityAssertion } from '../lib/binding-authority.mjs';

const databaseUrl = process.env.RAGENT_ACCOUNTS_ISOLATED_TEST_DATABASE_URL;
assert(databaseUrl, 'An explicit isolated-schema database URL is required');
const { createPostgresStore } = await import(pathToFileURL(resolve(process.env.RAGENT_TEST_STORE_MODULE || 'accounts/store/postgres.mjs')));
const legacyPath = process.env.RAGENT_TEST_SECOND_STORE_MODULE;
assert(legacyPath, 'Pin the previous writer which does not know authority tables');
const legacyFactory = (await import(pathToFileURL(resolve(legacyPath)))).createPostgresStore;
const schema = `qa_auth_rev_${randomBytes(12).toString('hex')}`;
assert(/^qa_auth_rev_[a-f0-9]{24}$/.test(schema));
const bootstrap = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
const pools = [];
let owned = false;
let httpServer;
const lockKey = `ragent_accounts_store_v1:${schema}`;
function store(factory) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema} -c statement_timeout=15000 -c application_name=ragent-authority-qa` });
  pools.push(pool);
  return factory({ schema, pool: { connect: async () => {
    const client = await pool.connect();
    try { assert.equal((await client.query('select current_schema() as schema')).rows[0].schema, schema); }
    catch (error) { client.release(); throw error; }
    return { release: () => client.release(), query: async (sql, values = []) => {
      assert(!/\bpublic\s*\./i.test(sql), 'No production namespace access');
      if (/pg_advisory/.test(sql)) {
        assert.equal(sql, 'select pg_advisory_xact_lock(hashtext($1))');
        assert.deepEqual(values, ['ragent_accounts_store_v1']);
        return client.query(sql, [lockKey]);
      }
      return client.query(sql, values);
    } };
  } } });
}
const root = new URL('../accounts/migrations/', import.meta.url);
async function migration(client, file) {
  const sql = await readFile(new URL(file, root), 'utf8');
  assert(!/\bpublic\s*\.|\b(?:create\s+extension|alter\s+system|drop\s+schema|create\s+database)\b/i.test(sql));
  await client.query(sql);
}
async function adminQuery(sql, values = []) {
  assert(!/\bpublic\s*\./i.test(sql));
  const client = await bootstrap.connect();
  try {
    await client.query('begin');
    await client.query(`set local search_path to "${schema}"`);
    assert.equal((await client.query('select current_schema() as schema')).rows[0].schema, schema);
    const result = await client.query(sql, values);
    await client.query('commit'); return result;
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
const accountId = 'acct_authority_fixture';
const originalTime = '2026-10-25T00:00:00.000Z';
const binding = id => ({ instanceId: id, accountId, provider: 'google', instancePublicKey: 'synthetic-public-key',
  instanceKeyFingerprint: 'a'.repeat(64), boundAt: originalTime, revokedAt: '', lastSeenAt: originalTime });
const event = (id, action) => ({ instanceId: id, accountId, action, occurredAt: originalTime });
const performanceEvidence = {};
try {
  await bootstrap.query(`create schema "${schema}"`); owned = true;
  if (process.env.RAGENT_TEST_OWNED_SCHEMA_REPORT) {
    assert(/^[a-f0-9]{32}$/.test(process.env.RAGENT_TEST_RUN_NONCE || ''), 'An owned cleanup nonce is required');
    await writeFile(process.env.RAGENT_TEST_OWNED_SCHEMA_REPORT,
      JSON.stringify({ schema, runNonce: process.env.RAGENT_TEST_RUN_NONCE, pid: process.pid }));
  }
  const setup = await bootstrap.connect();
  try {
    await setup.query('begin'); await setup.query(`set local search_path to "${schema}"`);
    for (const file of (await readdir(root)).filter(f => f.endsWith('.up.sql') && f < '030_').sort()) await migration(setup, file);
    await setup.query('commit');
  } catch (e) { await setup.query('rollback'); throw e; }
  finally { setup.release(); }
  const old = store(legacyFactory), current = store(createPostgresStore);
  assert.equal(old.readInstanceAuthority, undefined, 'Use a genuinely unaware old writer');
  await old.mutate(draft => {
    draft.accounts.push({ accountId, provider: 'google', providerSubject: 'authority-fixture', createdAt: originalTime });
    draft.instanceBindings.push(binding('inst_a'), binding('inst_b'));
    for (let i = 0; i < 40; i++) draft.bindingHistory.push(event('inst_a', 'bind'));
    draft.bindingHistory.push(event('inst_b', 'bind'), event('inst_deleted', 'unbind'));
    for (let i = 0; i < 300; i++) draft.accountDevices.push({ deviceId: `adev_authority_${i}`, accountId,
      alias: `Synthetic phone ${i}`, platform: 'android', createdAt: originalTime, lastSeenAt: originalTime });
    for (let i = 0; i < 4000; i++) draft.accountJoinIntents.push({ intentId: `rji_authority_${i}`, instanceId: 'inst_a',
      instance: { publicKey: 'synthetic-instance-key', keyFingerprint: 'synthetic-instance-fingerprint' },
      deviceId: 'rdev_authority', devicePublicKey: 'synthetic-phone-key', devicePublicKeyFingerprint: 'synthetic-phone-fingerprint',
      nonceHash: `synthetic-intent-hash-${i}`, issuedAt: originalTime, createdAt: originalTime,
      expiresAt: '2026-10-25T01:00:00.000Z', accountId, accountDeviceId: 'adev_authority_0', status: 'completed' });
  });
  await assert.rejects(current.readInstanceAuthority('inst_a'), e => e.code === '42P01');
  const before = performance.now();
  for (let n = 0; n < 3; n++) await old.mutate(draft => { draft.instanceBindings[0].deviceAlias = `Before ${n}`; });
  performanceEvidence.legacyThreeMetadataWritesBeforeMs = Math.round(performance.now() - before);
  const migrate = await bootstrap.connect();
  try {
    await migrate.query('begin'); await migrate.query(`set local search_path to "${schema}"`);
    await migration(migrate, '030_instance_authority_revisions.up.sql');
    await migration(migrate, '032_owner_auth_browser_states.up.sql'); await migrate.query('commit');
  } catch (e) { await migrate.query('rollback'); throw e; }
  finally { migrate.release(); }
  const a = () => current.readInstanceAuthority('inst_a');
  const revision = async () => (await a()).revision;
  const emptyPending = async () => assert.equal((await adminQuery('select count(*)::int as n from instance_authority_pending')).rows[0].n, 0);
  assert.equal(await revision(), '1');
  assert.equal((await current.readInstanceAuthority('inst_deleted')).revision, '1');
  assert.equal((await current.readInstanceAuthority('inst_deleted')).binding, null);
  assert.deepEqual(await current.readInstanceAuthority('inst_unknown'), { instanceId: 'inst_unknown', revision: '0', binding: null });
  await emptyPending();
  const after = performance.now();
  for (let n = 0; n < 3; n++) await old.mutate(draft => {
    draft.instanceBindings[0].deviceAlias = `After ${n}`;
    draft.instanceBindings[0].lastSeenAt = new Date(Date.parse(originalTime) + n).toISOString();
  });
  performanceEvidence.legacyThreeMetadataWritesAfterMs = Math.round(performance.now() - after);
  assert.equal(await revision(), '1', 'Unchanged authorization survives legacy DELETE/INSERT churn');
  assert.equal((await current.readInstanceAuthority('inst_b')).revision, '1');
  await old.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === 'inst_a').revokedAt = '2026-10-24T23:59:00.000Z';
    draft.bindingHistory.push(event('inst_a', 'unbind'));
  });
  assert.equal(await revision(), '2', 'Revocation advances even when the wall clock moved backwards');
  await old.mutate(draft => { draft.instanceBindings.find(b => b.instanceId === 'inst_b').deviceAlias = 'Force a full snapshot rewrite'; });
  assert.equal(await revision(), '2', 'An unrelated snapshot cannot undo the tombstone');
  await current.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === 'inst_a').revokedAt = '';
    draft.bindingHistory.push(event('inst_a', 'bind'));
  });
  assert.equal(await revision(), '3', 'Same-key/same-time rebind is a new generation');
  await old.mutate(draft => {
    draft.instanceBindings = draft.instanceBindings.filter(b => b.instanceId !== 'inst_a');
    draft.bindingHistory = draft.bindingHistory.filter(h => h.instanceId !== 'inst_a');
  });
  assert.equal(await revision(), '4'); assert.equal((await a()).binding, null);
  await old.mutate(draft => {
    draft.instanceBindings.push(binding('inst_a'));
    for (let i = 0; i < 40; i++) draft.bindingHistory.push(event('inst_a', 'bind'));
  });
  assert.equal(await revision(), '5', 'Identical re-creation after history deletion cannot reset the generation');
  const beforeFailure = await a();
  await assert.rejects(current.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === 'inst_a').revokedAt = originalTime;
    draft.bindingHistory.push(event('inst_a', 'unbind'));
    draft.accountJoinGrants.push({ grantHash: 'synthetic-invalid-grant', accountId, instanceId: 'inst_a', intentId: 'missing-intent',
      deviceId: 'missing-device', accountDeviceId: 'missing-phone', keyFingerprint: 'synthetic', requestId: 'invalid-grant', createdAt: originalTime,
      expiresAt: '2026-10-25T01:00:00.000Z' });
  }), e => e.code === '23503');
  assert.deepEqual(await a(), beforeFailure, 'A later FK failure rolls back binding and generation together');
  await emptyPending();
  await Promise.all([old.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === 'inst_a').revokedAt = originalTime;
    draft.bindingHistory.push(event('inst_a', 'unbind'));
  }), current.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === 'inst_a').revokedAt = '';
    draft.bindingHistory.push(event('inst_a', 'bind'));
  })]);
  assert.equal(await revision(), '7', 'Independent old/new writers retain both committed generations');
  assert.equal((await current.readInstanceAuthority('inst_b')).revision, '1', 'Other instances retain their generation');
  // An unfinished old writer holds the real mutation lock. The new status read
  // must see the previous coherent committed pair without joining that queue.
  const held = await bootstrap.connect();
  const coherent = await a();
  try {
    await held.query('begin'); await held.query(`set local search_path to "${schema}"`);
    await held.query('select pg_advisory_xact_lock(hashtext($1))', [lockKey]);
    await held.query('delete from instance_bindings where instance_id = $1', ['inst_a']);
    const started = performance.now();
    assert.deepEqual(await a(), coherent);
    performanceEvidence.readWhileWriterHeldMs = Math.round(performance.now() - started);
    assert(performanceEvidence.readWhileWriterHeldMs < 2000, 'Authority read must not wait for the mutation lock');
    await held.query('rollback');
  } finally { await held.query('rollback').catch(() => {}); held.release(); }
  assert.equal(await revision(), '7'); await emptyPending();
  const reopened = store(createPostgresStore);
  assert.deepEqual(await reopened.readInstanceAuthority('inst_a'), await a(), 'A new store/pool retains the committed generation');
  const again = await bootstrap.connect();
  try {
    await again.query('begin'); await again.query(`set local search_path to "${schema}"`);
    await migration(again, '030_instance_authority_revisions.up.sql'); await again.query('commit');
  } catch (e) { await again.query('rollback'); throw e; }
  finally { again.release(); }
  assert.equal(await revision(), '7', 'Idempotent migration cannot reset existing revisions');
  await emptyPending();
  const downgrade = await bootstrap.connect();
  try {
    await downgrade.query('begin'); await downgrade.query(`set local search_path to "${schema}"`);
    await assert.rejects(migration(downgrade, '030_instance_authority_revisions.down.sql'), e => e.code === 'P0001');
    await downgrade.query('rollback');
  } finally { await downgrade.query('rollback').catch(() => {}); downgrade.release(); }
  assert.equal(await revision(), '7', 'An attempted destructive downgrade must preserve tombstones');
  const completionMigration = await bootstrap.connect();
  try {
    await completionMigration.query('begin'); await completionMigration.query(`set local search_path to "${schema}"`);
    await migration(completionMigration, '031_instance_authority_completions.up.sql');
    await migration(completionMigration, '033_authority_completion_sequence.up.sql'); await completionMigration.query('commit');
  } catch (e) { await completionMigration.query('rollback'); throw e; }
  finally { completionMigration.release(); }
  const completion = { kind: 'account_join', operationId: 'rji_finalizer', sourceDigest: '1'.repeat(64),
    instanceId: 'inst_finalizer', accountId, keyFingerprint: 'a'.repeat(64) };
  let escaped;
  const finalized = await current.mutateWithAuthority(draft => {
    draft.instanceBindings.push(binding(completion.instanceId)); draft.bindingHistory.push(event(completion.instanceId, 'bind'));
    return { fixture: 'unsigned-result' };
  }, async (unsigned, authority) => {
    escaped = authority;
    assert.equal(Object.hasOwn(authority, 'query'), false, 'Finalizers cannot access an arbitrary SQL client');
    const authorizedRevision = await authority.recordCompletion(completion);
    assert.equal(authorizedRevision, '1', 'Finalize sees the actual new binding generation before commit');
    return { ...unsigned, authorizedRevision };
  });
  assert.equal(finalized.authorizedRevision, '1');
  await assert.rejects(escaped.readInstanceAuthority(completion.instanceId), e => e.code === 'owner_auth_authority_context_expired');
  const replay = () => current.mutateWithAuthority(() => null, (_, authority) => authority.readCompletion(completion));
  assert.equal(await replay(), '1');
  await old.mutate(draft => { draft.instanceBindings[0].deviceAlias = 'Legacy rewrite preserves completion evidence'; });
  assert.equal(await replay(), '1');
  const signingFailure = { ...completion, operationId: 'rji_signer_failed', sourceDigest: '2'.repeat(64) };
  await assert.rejects(current.mutateWithAuthority(draft => {
    draft.bindingHistory.push(event(completion.instanceId, 'bind'));
  }, async (_, authority) => {
    assert.equal(await authority.recordCompletion(signingFailure), '2');
    throw new Error('synthetic-signer-failure');
  }), /synthetic-signer-failure/);
  assert.equal((await current.readInstanceAuthority(completion.instanceId)).revision, '1');
  assert.equal((await adminQuery('select count(*)::int as n from instance_authority_completions')).rows[0].n, 1,
    'A signer failure rolls back the new binding generation and completion record');
  const browser = { ...completion, kind: 'browser', operationId: 'otx_finalizer', sourceDigest: '3'.repeat(64) };
  const fixtureAssertion = 'fixture.header.signature';
  await current.mutateWithAuthority(draft => {
    draft.ownerAuthTransactions.push({ id: browser.operationId, purpose: 'bind',
      instance: { ...binding(completion.instanceId), publicKey: 'synthetic-public-key', keyFingerprint: browser.keyFingerprint },
      nonce: 'synthetic-browser-nonce', bootstrapHash: 'synthetic-browser-bootstrap', returnUrl: 'https://fixture.invalid/callback', createdAt: originalTime,
      expiresAt: '2026-10-25T01:00:00.000Z', accountId, completedAt: originalTime,
      pollRequestId: 'poll_finalizer', pollExpiresAt: '2026-10-25T01:00:00.000Z', pollRedeemedAt: originalTime });
  }, async (_, authority) => {
    assert.equal(await authority.recordCompletion(browser), '1');
    await authority.cacheOwnerPollAssertion({ transactionId: browser.operationId, requestId: 'poll_finalizer',
      instanceId: completion.instanceId, accountId, assertion: fixtureAssertion });
  });
  assert.equal(await current.mutate(draft => draft.ownerAuthTransactions.find(t => t.id === browser.operationId).pollAssertion), fixtureAssertion);
  await old.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === completion.instanceId).revokedAt = originalTime;
    draft.bindingHistory.push(event(completion.instanceId, 'unbind'));
  });
  await assert.rejects(replay(), e => e.code === 'owner_auth_binding_revoked');
  await current.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === completion.instanceId).revokedAt = '';
    draft.bindingHistory.push(event(completion.instanceId, 'bind'));
  });
  await assert.rejects(replay(), e => e.code === 'owner_auth_native_replay');
  await assert.rejects(current.mutateWithAuthority(() => null, (_, authority) => authority.recordCompletion(completion)),
    e => e.code === 'owner_auth_native_replay');
  const fresh = { ...completion, operationId: 'rji_fresh_finalizer', sourceDigest: '4'.repeat(64) };
  assert.equal(await current.mutateWithAuthority(() => null, (_, authority) => authority.recordCompletion(fresh)), '3');
  const priorAlias = (await current.readInstanceAuthority(completion.instanceId)).binding.deviceAlias;
  await assert.rejects(current.mutateWithAuthority(draft => {
    draft.instanceBindings.find(b => b.instanceId === completion.instanceId).deviceAlias = 'Must roll back even if caller catches authority error';
  }, async (_, authority) => {
    await authority.readCompletion(completion).catch(() => null);
    return 'not-a-success';
  }), e => e.code === 'owner_auth_native_replay');
  assert.equal((await current.readInstanceAuthority(completion.instanceId)).binding.deviceAlias, priorAlias);
  const native = { ...fresh, kind: 'native', operationId: 'native_retry_after_rollback', sourceDigest: '5'.repeat(64) };
  assert.equal(await current.mutateWithAuthority(() => null, (_, authority) => authority.recordCompletion(native)), '3');
  const nativeOriginal = await current.mutateWithAuthority(() => null, (_, authority) => authority.readCompletionIdentity(native));
  await current.mutateWithAuthority(draft => {
    draft.instanceBindings = draft.instanceBindings.filter(b => b.instanceId !== completion.instanceId);
    draft.bindingHistory.push(event(completion.instanceId, 'bind_rollback'));
  }, async (_, authority) => {
    assert.equal(await authority.forgetCompletion({ ...native, expectedRevision: '3', expectedCompletionId: nativeOriginal.completionId }),
      1, 'Explicit compensated rollback removes only its original native completion');
  });
  assert.equal((await current.readInstanceAuthority(completion.instanceId)).revision, '4');
  await current.mutateWithAuthority(draft => {
    draft.instanceBindings.push(binding(completion.instanceId)); draft.bindingHistory.push(event(completion.instanceId, 'bind'));
  }, async (_, authority) => {
    assert.equal(await authority.recordCompletion(native), '5', 'A newly verified attempt can reuse a compensated native request');
  });
  assert.equal(await current.mutateWithAuthority(() => null, (_, authority) => authority.readCompletion(native)), '5');
  let priorReader;
  await current.mutateWithAuthority(async (draft, authority) => {
    priorReader = authority;
    assert.equal(authority.recordCompletion, undefined, 'Pre-mutation validation cannot record new authority');
    assert.equal((await authority.readCompletionIdentity(native)).revision, '5');
  }, () => null);
  await assert.rejects(priorReader.readCompletion(native), e => e.code === 'owner_auth_authority_context_expired');
  const nativeAlias = (await current.readInstanceAuthority(native.instanceId)).binding.deviceAlias;
  await assert.rejects(current.mutateWithAuthority(async (draft, authority) => {
    draft.instanceBindings.find(b => b.instanceId === native.instanceId).deviceAlias = 'Must roll back caught pre-validation error';
    await authority.readCompletion({ ...native, sourceDigest: '9'.repeat(64) }).catch(() => null);
  }, () => null), e => e.code === 'owner_auth_native_replay');
  assert.equal((await current.readInstanceAuthority(native.instanceId)).binding.deviceAlias, nativeAlias);
  await assert.rejects(current.mutateWithAuthority(draft => {
    draft.instanceBindings = draft.instanceBindings.filter(b => b.instanceId !== completion.instanceId);
    draft.bindingHistory.push(event(completion.instanceId, 'bind_rollback'));
  }, (_, authority) => authority.forgetCompletion({ ...native, expectedRevision: '3', expectedCompletionId: nativeOriginal.completionId })),
    e => e.code === 'owner_auth_native_replay');
  assert.equal((await current.readInstanceAuthority(completion.instanceId)).revision, '5', 'Late old compensation cannot remove the replacement binding');
  assert.equal(await current.mutateWithAuthority(() => null, (_, authority) => authority.readCompletion(native)), '5');
  await emptyPending();
  // Real HTTP -> broker -> PostgreSQL -> Ed25519 assertion. Only Google identity
  // verification is substituted; instance/device proofs are actual signatures.
  const { createOwnerAuthBroker, deriveDesktopReplayValues } = await import(pathToFileURL(resolve(process.env.RAGENT_TEST_AUTHORITY_BROKER_MODULE || 'accounts/owner-auth-broker.mjs')));
  const pcKeys = generateKeyPairSync('ed25519'), phoneKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pcKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const keyFingerprint = createInstancePublicKeyFingerprint(publicKey);
  const pc = { instanceId: `inst_${keyFingerprint.slice(0, 32)}`, publicKey, keyFingerprint, algorithm: 'ed25519' };
  const phonePublic = phoneKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const phoneFingerprint = createDevicePublicKeyFingerprint(phonePublic), phoneId = 'rdev_authority_http';
  await current.mutate(draft => {
    draft.instanceBindings.push({ ...binding(pc.instanceId), instancePublicKey: publicKey, instanceKeyFingerprint: keyFingerprint });
    draft.bindingHistory.push(event(pc.instanceId, 'bind'));
  });
  const signing = generateKeyPairSync('ed25519'); let failSigning = false;
  const now = Date.parse('2026-10-25T06:00:00.000Z'), issuedAt = new Date(now).toISOString();
  const broker = createOwnerAuthBroker({ store: current, clock: () => now, issuer: 'https://authority.fixture.invalid',
    verifyGoogleCredential: async () => ({ sub: 'synthetic-verified-google' }), resolveAccount: async () => ({ accountId }),
    signAssertion: async claims => {
      if (failSigning) throw new Error('synthetic-http-signer-failure');
      const body = [Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'authority-fixture' })).toString('base64url'),
        Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
      return body + '.' + sign(null, Buffer.from(body), signing.privateKey).toString('base64url');
    } });
  let base;
  httpServer = createServer((req, res) => {
    handleOwnerAuthRoutes({ req, res, pathname: req.url, broker, publicBaseUrl: base,
      googleWebClientId: 'fixture.apps.googleusercontent.com', allowInsecurePublicBaseUrl: true })
      .then(handled => { if (!handled) { res.writeHead(404); res.end('{}'); } })
      .catch(() => { res.writeHead(500); res.end('{}'); });
  });
  await new Promise(done => httpServer.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${httpServer.address().port}/accounts`;
  async function post(path, body) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(body.requestId ? { 'Idempotency-Key': body.requestId } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.json() };
  }
  async function joinInput(id) {
    const nonce = `synthetic-${id}-nonce`;
    const fields = { instanceId: pc.instanceId, intentId: id, deviceId: phoneId,
      devicePublicKeyFingerprint: phoneFingerprint, nonce, issuedAt, audience: 'ragent-account-join' };
    const signature = sign(null, Buffer.from(buildAccountJoinIntentProofMessage(fields)), pcKeys.privateKey).toString('base64');
    assert.equal((await post('/v1/owner-auth/account-intents', { intentId: id, nonce, issuedAt, audience: fields.audience,
      instance: pc, device: { deviceId: phoneId, publicKey: phonePublic, devicePublicKeyFingerprint: phoneFingerprint,
        alias: 'Synthetic phone', platform: 'android' }, signature })).status, 201);
    return { intentId: id, requestId: `request-${id}-original`, nonce, issuedAt, deviceIssuedAt: issuedAt,
      audience: fields.audience, instance: pc, signature, device: { deviceId: phoneId, devicePublicKeyFingerprint: phoneFingerprint },
      idToken: 'synthetic-verified-google',
      deviceSignature: sign('sha256', Buffer.from(buildAccountJoinIntentMessage(fields)), phoneKeys.privateKey).toString('base64') };
  }
  function claims(token, { purpose = 'account_join', device = true, target = pc, deviceId = phoneId, fingerprint = phoneFingerprint } = {}) {
    const parts = token.split('.');
    assert.equal(parts.length, 3);
    assert(verify(null, Buffer.from(parts[0] + '.' + parts[1]), signing.publicKey, Buffer.from(parts[2], 'base64url')),
      'The actual HTTP result must carry a valid Accounts signature');
    const verified = JSON.parse(Buffer.from(parts[1], 'base64url'));
    assert.equal(verified.aud, target.instanceId); assert.equal(verified.sub, accountId);
    assert.equal(verified.deviceId, device ? deviceId : undefined);
    assert.equal(verified.devicePublicKeyFingerprint, device ? fingerprint : undefined);
    assert.equal(verified.purpose, purpose); assert.equal(verified.exp - verified.iat, 60);
    return verified;
  }
  const original = await joinInput('rji_authority_http_original');
  const firstHttp = await post(`/v1/owner-auth/account-intents/${original.intentId}/complete`, original);
  assert.equal(firstHttp.status, 200, `HTTP completion rejected: ${firstHttp.body.code || 'unknown'}`);
  assert.equal(claims(firstHttp.body.assertion).bindingAuthorityRevision, '1',
    'Fresh Accounts authorization must retain its committed binding generation');
  assert.equal(claims((await post(`/v1/owner-auth/account-intents/${original.intentId}/complete`, original)).body.assertion).bindingAuthorityRevision, '1');
  await old.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === pc.instanceId).revokedAt = originalTime;
    draft.bindingHistory.push(event(pc.instanceId, 'unbind'));
  });
  assert.equal((await post(`/v1/owner-auth/account-intents/${original.intentId}/complete`, original)).status, 403);
  await old.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === pc.instanceId).revokedAt = '';
    draft.bindingHistory.push(event(pc.instanceId, 'bind'));
  });
  assert.equal((await post(`/v1/owner-auth/account-intents/${original.intentId}/complete`, original)).status, 409,
    'A replay cannot take the generation of a later rebind');
  const freshHttp = await joinInput('rji_authority_http_fresh');
  const freshResult = await post(`/v1/owner-auth/account-intents/${freshHttp.intentId}/complete`, freshHttp);
  assert.equal(freshResult.status, 200); assert.equal(claims(freshResult.body.assertion).bindingAuthorityRevision, '3');
  const signerFailureHttp = await joinInput('rji_authority_http_signer_failed');
  failSigning = true;
  assert.equal((await post(`/v1/owner-auth/account-intents/${signerFailureHttp.intentId}/complete`, signerFailureHttp)).status, 500);
  failSigning = false;
  assert.equal(await current.mutate(draft => draft.accountJoinIntents.find(i => i.intentId === signerFailureHttp.intentId).status), 'pending');
  assert.equal((await adminQuery('select count(*)::int as n from instance_authority_completions where operation_id=$1',
    [signerFailureHttp.intentId])).rows[0].n, 0, 'HTTP signing failure must not retain a completed authorization');
  // Freeze browser authority when Google completes, before either callback or
  // polling delivery. An unclaimed result and a cached result obey the same fence.
  async function browserInput(id, poll = false) {
    const fields = { instanceId: pc.instanceId, transactionId: id, purpose: 'login',
      returnUrl: poll ? '' : `https://authority.fixture.invalid/api/auth/google/complete?tx=${id}`,
      issuedAt, audience: poll ? 'ragent-owner-auth-poll' : 'ragent-owner-auth' };
    const proof = { ...fields, instance: pc,
      signature: sign(null, Buffer.from(buildInstanceProofMessage(fields)), pcKeys.privateKey).toString('base64') };
    const started = await broker.start({ ...proof, deliveryMode: poll ? 'instance_poll' : 'browser_callback' });
    if (poll) {
      const replay = deriveDesktopReplayValues({ transactionId: id, bootstrap: started.bootstrap, deliveryMode: 'instance_poll' });
      const desktop = await broker.beginDesktop({ transactionId: id, bootstrap: started.bootstrap, desktopState: replay.desktopState });
      await broker.beginPhone({ transactionId: id, phoneTicket: desktop.phoneTicket, phoneState: `state-${id}` });
      await broker.completePhoneGoogleCredential({ transactionId: id, phoneState: `state-${id}`, idToken: 'synthetic-google' });
      const path = `/v1/owner-auth/transactions/${id}/instance-redeem`;
      const pollFields = { instanceId: pc.instanceId, transactionId: id, requestId: `request-${id}`, purpose: 'login',
        deliveryMode: 'instance_poll', issuedAt, requestPath: path, audience: fields.audience };
      return { path, body: { ...pollFields, instance: pc,
        signature: sign(null, Buffer.from(buildOwnerAuthPollMessage(pollFields)), pcKeys.privateKey).toString('base64') } };
    }
    await broker.beginBrowser({ transactionId: id, bootstrap: started.bootstrap, browserState: `state-${id}` });
    await old.mutate(draft => { draft.instanceBindings.find(b => b.instanceId === pc.instanceId).deviceAlias = 'Mixed writer during browser sign-in'; });
    const reopenedBrowser = await store(createPostgresStore).mutate(draft => draft.ownerAuthTransactions.find(t => t.id === id));
    assert.match(reopenedBrowser.browserStateHash, /^[a-f0-9]{64}$/, 'Browser state survives actual SQL roundtrip, unaware old writer and fresh pool');
    await assert.rejects(broker.completeGoogleCredential({ transactionId: id, browserState: 'incorrect-state', idToken: 'synthetic-google' }),
      e => e.code === 'owner_auth_transaction_invalid');
    const completed = await broker.completeGoogleCredential({ transactionId: id, browserState: `state-${id}`, idToken: 'synthetic-google' });
    return { path: `/v1/owner-auth/transactions/${id}/redeem`, body: { ...proof, grant: completed.grant } };
  }
  const browserClaim = await browserInput('authority_browser_claim');
  const browserResult = await post(browserClaim.path, browserClaim.body);
  assert.equal(browserResult.status, 200);
  assert.equal(claims(browserResult.body.assertion, { purpose: 'login', device: false }).bindingAuthorityRevision, '3',
    'Browser redemption must retain the generation authorized at Google completion');
  const browserUnclaimed = await browserInput('authority_browser_unclaimed');
  const pollCached = await browserInput('authority_poll_cached', true);
  const pollUnclaimed = await browserInput('authority_poll_unclaimed', true);
  const pollResult = await post(pollCached.path, pollCached.body);
  assert.equal(pollResult.status, 200);
  assert.equal(claims(pollResult.body.assertion, { purpose: 'login', device: false }).bindingAuthorityRevision, '3');
  assert.equal((await post(pollCached.path, pollCached.body)).body.assertion, pollResult.body.assertion);
  await old.mutate(draft => { draft.instanceBindings.find(b => b.instanceId === pc.instanceId).deviceAlias = 'Old writer retains completed results'; });
  assert.equal((await post(pollCached.path, pollCached.body)).body.assertion, pollResult.body.assertion);
  await old.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === pc.instanceId).revokedAt = originalTime;
    draft.bindingHistory.push(event(pc.instanceId, 'unbind'));
  });
  for (const request of [browserUnclaimed, pollCached, pollUnclaimed]) {
    assert.equal((await post(request.path, request.body)).status, 403, 'Revoked authority fences pending and cached browser delivery');
  }
  await old.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === pc.instanceId).revokedAt = '';
    draft.bindingHistory.push(event(pc.instanceId, 'bind'));
  });
  for (const request of [browserUnclaimed, pollCached, pollUnclaimed]) {
    assert.equal((await post(request.path, request.body)).status, 409, 'Old browser authorization cannot adopt a later rebind');
  }
  const browserFresh = await browserInput('authority_browser_fresh');
  assert.equal(claims((await post(browserFresh.path, browserFresh.body)).body.assertion,
    { purpose: 'login', device: false }).bindingAuthorityRevision, '5');
  const pollSignFailure = await browserInput('authority_poll_sign_failure', true);
  failSigning = true;
  assert.equal((await post(pollSignFailure.path, pollSignFailure.body)).status, 500);
  failSigning = false;
  const afterSignFailure = await current.mutate(draft => draft.ownerAuthTransactions.find(t => t.id === pollSignFailure.body.transactionId));
  assert.equal(afterSignFailure.pollAssertion, ''); assert.equal(afterSignFailure.pollRedeemedAt, ''); assert.equal(afterSignFailure.pollRequestId, '');
  const retriedPoll = await post(pollSignFailure.path, pollSignFailure.body);
  assert.equal(retriedPoll.status, 200);
  assert.equal(claims(retriedPoll.body.assertion, { purpose: 'login', device: false }).bindingAuthorityRevision, '5');
  assert.equal((await post(pollSignFailure.path, pollSignFailure.body)).body.assertion, retriedPoll.body.assertion);
  function nativeInput(requestId, { target = pc, keys = pcKeys, deviceId = phoneId, fingerprint = phoneFingerprint } = {}) {
    const fields = { instanceId: target.instanceId, requestId, purpose: 'native', deviceId,
      devicePublicKeyFingerprint: fingerprint, deviceAlias: 'Synthetic phone', issuedAt, audience: 'ragent-owner-auth-native' };
    return { requestId, purpose: 'native', instance: target,
      device: { deviceId, devicePublicKeyFingerprint: fingerprint, alias: fields.deviceAlias },
      idToken: 'synthetic-native-google', issuedAt, audience: fields.audience,
      signature: sign(null, Buffer.from(buildNativeOwnerAuthMessage(fields)), keys.privateKey).toString('base64') };
  }
  function rollbackInput(input, verified, keys = pcKeys) {
    const fields = { instanceId: input.instance.instanceId, requestId: input.requestId, accountId,
      deviceId: input.device.deviceId, devicePublicKeyFingerprint: input.device.devicePublicKeyFingerprint,
      expectedRevision: verified.bindingAuthorityRevision, expectedCompletionId: verified.nativeCompletionId,
      issuedAt, audience: 'ragent-owner-auth-native-rollback' };
    return { ...fields, instance: input.instance, device: input.device,
      signature: sign(null, Buffer.from(buildNativeOwnerAuthRollbackMessage(fields)), keys.privateKey).toString('base64') };
  }
  const nativeRequest = nativeInput('authority_native_original');
  const nativeHttp = await post('/v1/owner-auth/native/complete', nativeRequest);
  assert.equal(nativeHttp.status, 200);
  const nativeClaims = claims(nativeHttp.body.assertion, { purpose: 'native' });
  assert.equal(nativeClaims.bindingAuthorityRevision, '5', 'Native authentication must retain its committed binding generation');
  assert.match(nativeClaims.nativeCompletionId, /^[1-9][0-9]*$/);
  const nativeReplay = await post('/v1/owner-auth/native/complete', nativeRequest);
  assert.equal(nativeReplay.status, 200);
  assert.equal(claims(nativeReplay.body.assertion, { purpose: 'native' }).nativeCompletionId, nativeClaims.nativeCompletionId);
  const wrongNativeKey = await post('/v1/owner-auth/native/complete', nativeInput(nativeRequest.requestId, { fingerprint: 'b'.repeat(64) }));
  assert.equal(wrongNativeKey.status, 403); assert.equal(wrongNativeKey.body.code, 'owner_auth_device_revoked');
  assert.equal((await post('/v1/owner-auth/native/rollback', nativeRequest)).status, 400, 'A completion signature is not rollback authority');
  const originalRollback = rollbackInput(nativeRequest, nativeClaims);
  assert.equal((await post('/v1/owner-auth/native/rollback', { ...originalRollback, expectedCompletionId: '999999' })).status, 401);
  const nativeRolledBack = await post('/v1/owner-auth/native/rollback', originalRollback);
  assert.equal(nativeRolledBack.status, 200); assert.equal(nativeRolledBack.body.rolledBack, true);
  assert.equal((await current.readInstanceAuthority(pc.instanceId)).revision, '5');
  const nativeRetried = await post('/v1/owner-auth/native/complete', nativeRequest);
  assert.equal(nativeRetried.status, 200);
  const nativeRetriedClaims = claims(nativeRetried.body.assertion, { purpose: 'native' });
  assert.equal(nativeRetriedClaims.bindingAuthorityRevision, '5');
  assert.notEqual(nativeRetriedClaims.nativeCompletionId, nativeClaims.nativeCompletionId,
    'Compensated retry under the same binding revision still has a distinct completion');
  assert.equal((await post('/v1/owner-auth/native/rollback', originalRollback)).status, 409,
    'Late compensation cannot undo a retry even when the computer revision did not change');
  assert.equal(await current.mutate(draft => draft.nativeAuthRequests.find(r => r.requestId === nativeRequest.requestId).status), 'completed');
  const sibling = await post('/v1/owner-auth/native/complete', nativeInput('authority_native_sibling', { deviceId: 'rdev_native_sibling' }));
  assert.equal(sibling.status, 200);
  const superseded = await post('/v1/owner-auth/native/rollback', rollbackInput(nativeRequest, nativeRetriedClaims));
  assert.equal(superseded.status, 200); assert.equal(superseded.body.rolledBack, false);
  await old.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === pc.instanceId).revokedAt = originalTime;
    draft.bindingHistory.push(event(pc.instanceId, 'unbind'));
  });
  assert.equal((await post('/v1/owner-auth/native/complete', nativeRequest)).status, 403);
  await old.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === pc.instanceId).revokedAt = '';
    draft.bindingHistory.push(event(pc.instanceId, 'bind'));
  });
  assert.equal((await post('/v1/owner-auth/native/complete', nativeRequest)).status, 409);
  const nativeFresh = nativeInput('authority_native_fresh');
  assert.equal(claims((await post('/v1/owner-auth/native/complete', nativeFresh)).body.assertion,
    { purpose: 'native' }).bindingAuthorityRevision, '7');
  const rotatedFingerprint = 'b'.repeat(64);
  await old.mutate(draft => { draft.devices.find(d => d.deviceId === phoneId).devicePublicKeyFingerprint = rotatedFingerprint; });
  assert.equal((await post('/v1/owner-auth/native/complete', nativeFresh)).status, 403, 'Old completion cannot restore an earlier phone key');
  assert.equal(await current.mutate(draft => draft.devices.find(d => d.deviceId === phoneId).devicePublicKeyFingerprint), rotatedFingerprint);
  const nativeRekeyed = nativeInput('authority_native_rekeyed', { fingerprint: rotatedFingerprint });
  const nativeRekeyedResult = await post('/v1/owner-auth/native/complete', nativeRekeyed);
  assert.equal(nativeRekeyedResult.status, 200);
  assert.equal(claims(nativeRekeyedResult.body.assertion, { purpose: 'native', fingerprint: rotatedFingerprint }).bindingAuthorityRevision, '7');
  await old.mutate(draft => { draft.devices.find(d => d.deviceId === phoneId).unboundAt = issuedAt; });
  assert.equal((await post('/v1/owner-auth/native/complete', nativeRekeyed)).status, 403, 'Replay cannot revive an unbound phone');
  assert.equal(await current.mutate(draft => draft.devices.find(d => d.deviceId === phoneId).unboundAt), issuedAt);
  failSigning = true;
  assert.equal((await post('/v1/owner-auth/native/complete', nativeInput('authority_native_sign_failure', { deviceId: 'rdev_native_sign_failure' }))).status, 500);
  failSigning = false;
  assert.equal(await current.mutate(draft => draft.nativeAuthRequests.some(r => r.requestId === 'authority_native_sign_failure')
    || draft.devices.some(d => d.deviceId === 'rdev_native_sign_failure')), false);
  const firstKeys = generateKeyPairSync('ed25519');
  const firstPublic = firstKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const firstFingerprint = createInstancePublicKeyFingerprint(firstPublic);
  const firstPc = { instanceId: `inst_${firstFingerprint.slice(0, 32)}`, publicKey: firstPublic,
    keyFingerprint: firstFingerprint, algorithm: 'ed25519' };
  const firstDevice = 'rdev_native_first_bind';
  const firstNative = nativeInput('authority_native_first_bind', { target: firstPc, keys: firstKeys, deviceId: firstDevice });
  failSigning = true;
  assert.equal((await post('/v1/owner-auth/native/complete', firstNative)).status, 500);
  failSigning = false;
  assert.deepEqual(await current.readInstanceAuthority(firstPc.instanceId), { instanceId: firstPc.instanceId, revision: '0', binding: null });
  const firstBoundResult = await post('/v1/owner-auth/native/complete', firstNative);
  assert.equal(firstBoundResult.status, 200);
  const firstBoundClaims = claims(firstBoundResult.body.assertion, { purpose: 'native', target: firstPc, deviceId: firstDevice });
  assert.equal(firstBoundClaims.bindingAuthorityRevision, '1', 'First native binding is signed after its actual new revision exists');
  const firstRollback = rollbackInput(firstNative, firstBoundClaims, firstKeys);
  const firstCompensated = await post('/v1/owner-auth/native/rollback', firstRollback);
  assert.equal(firstCompensated.status, 200); assert.equal(firstCompensated.body.rolledBack, true);
  assert.equal((await current.readInstanceAuthority(firstPc.instanceId)).revision, '2');
  assert.equal((await current.readInstanceAuthority(firstPc.instanceId)).binding, null);
  const firstRetried = await post('/v1/owner-auth/native/complete', firstNative);
  assert.equal(firstRetried.status, 200);
  const firstRetriedClaims = claims(firstRetried.body.assertion, { purpose: 'native', target: firstPc, deviceId: firstDevice });
  assert.equal(firstRetriedClaims.bindingAuthorityRevision, '3');
  assert.notEqual(firstRetriedClaims.nativeCompletionId, firstBoundClaims.nativeCompletionId);
  assert.equal((await post('/v1/owner-auth/native/rollback', firstRollback)).status, 409);
  assert.equal((await current.readInstanceAuthority(firstPc.instanceId)).revision, '3');
  async function statusRequest({ target = pc, keys = pcKeys, requestedAccount = accountId } = {}) {
    const fields = { instanceId: target.instanceId, keyFingerprint: target.keyFingerprint, accountId: requestedAccount,
      requestId: 'authority_status_' + randomBytes(12).toString('hex'), nonce: randomBytes(32).toString('base64url'),
      issuedAt, audience: 'ragent-binding-authority' };
    const response = await post('/v1/owner-auth/instances/authority', { ...fields, instance: target,
      signature: sign(null, Buffer.from(buildBindingAuthorityProofMessage(fields)), keys.privateKey).toString('base64url') });
    assert.equal(response.status, 200, 'Signed binding status must be available from the actual PostgreSQL authority read');
    return verifyBindingAuthorityAssertion(response.body.assertion,
      { keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'authority-fixture' }] },
      { issuer: 'https://authority.fixture.invalid', instanceId: target.instanceId, keyFingerprint: target.keyFingerprint,
        accountId: requestedAccount, requestId: fields.requestId, nonce: fields.nonce, startedAt: now, clock: () => now });
  }
  const activeStatus = await statusRequest();
  assert.equal(activeStatus.state, 'active'); assert.equal(activeStatus.revision, '7');
  const heldStatusWriter = await bootstrap.connect();
  try {
    await heldStatusWriter.query('begin'); await heldStatusWriter.query(`set local search_path to "${schema}"`);
    await heldStatusWriter.query('select pg_advisory_xact_lock(hashtext($1))', [lockKey]);
    await heldStatusWriter.query('delete from instance_bindings where instance_id=$1', [pc.instanceId]);
    const beforeStatusRead = performance.now();
    const heldStatus = await statusRequest();
    assert.equal(heldStatus.state, 'active'); assert.equal(heldStatus.revision, '7');
    performanceEvidence.signedStatusWhileWriterHeldMs = Math.round(performance.now() - beforeStatusRead);
    assert(performanceEvidence.signedStatusWhileWriterHeldMs < 3000, 'Signed status must not wait for the full snapshot mutation lock');
  } finally { await heldStatusWriter.query('rollback'); heldStatusWriter.release(); }
  const retainedStatusBinding = (await current.readInstanceAuthority(pc.instanceId)).binding;
  await old.mutate(draft => {
    draft.instanceBindings.find(b => b.instanceId === pc.instanceId).revokedAt = originalTime;
    draft.bindingHistory.push(event(pc.instanceId, 'unbind'));
  });
  const revokedStatus = await statusRequest(); assert.equal(revokedStatus.state, 'revoked'); assert.equal(revokedStatus.revision, '8');
  await old.mutate(draft => { draft.instanceBindings = draft.instanceBindings.filter(b => b.instanceId !== pc.instanceId); });
  const missingStatus = await statusRequest(); assert.equal(missingStatus.state, 'missing'); assert.equal(missingStatus.revision, '9');
  await old.mutate(draft => { draft.instanceBindings.push(retainedStatusBinding); draft.bindingHistory.push(event(pc.instanceId, 'bind')); });
  const reboundStatus = await statusRequest(); assert.equal(reboundStatus.state, 'active'); assert.equal(reboundStatus.revision, '10');
  assert.equal((await statusRequest({ requestedAccount: 'acct_wrong_requested_account' })).state, 'mismatch');
  assert.equal((await statusRequest({ target: { ...firstPc, instanceId: pc.instanceId }, keys: firstKeys })).state, 'mismatch');
  const neverEnrolled = await statusRequest({ target: { ...pc, instanceId: 'inst_never_enrolled_authority_status' } });
  assert.equal(neverEnrolled.state, 'missing'); assert.equal(neverEnrolled.revision, '0');
  const linked = await current.mutate(draft => draft.accountJoinIntents.filter(i => /^rji_authority_[0-9]+$/.test(i.intentId)).map(i => i.accountDeviceId));
  assert.equal(linked.length, 4000); assert(linked.every(id => id === 'adev_authority_0'), 'Authority tracking must preserve all existing phone links');
  console.log(JSON.stringify({ pass: true, schema, mixedWriters: true, revisions: ['1', '2', '3', '4', '5', '7'],
    rollbackVerified: true, noTransientEmptyBinding: true, seededPhones: 300, seededIntents: 4000,
    downgradePreservesTombstones: true, atomicFinalizer: true, completionReplayFenced: true, signerFailureRollback: true,
    cachedPollResult: true, contextExpiry: true, compensatedNativeRetry: true, signedHttpGeneration: true,
    browserStateMixedWriterPersistence: true, browserCompletionGeneration: true, pendingBrowserReplayFenced: true,
    cachedBrowserReplayFenced: true, pollSignerFailureRollback: true,
    nativeSignedGeneration: true, nativeRollbackSeparateProof: true, sameRevisionRetryCompensationFenced: true,
    nativePhoneRevocationFenced: true, nativeSignerFailureRollback: true,
    nativeOldPhoneKeyReplayFenced: true,
    nativeFirstBindCommittedRevision: true, nativeFirstBindSignerFailureRollback: true, priorAuthorityContextExpiry: true,
    signedAuthorityHttpPostgres: true, signedAuthorityInactiveStates: true, signedAuthorityReadOutsideMutationLock: true,
    pendingRows: 0, productionNamespaceReadOrWritten: false, ...performanceEvidence }));
} finally {
  if (httpServer) { httpServer.closeAllConnections(); await new Promise(done => httpServer.close(done)); }
  for (const pool of pools) await pool.end();
  if (owned) {
    assert(/^qa_auth_rev_[a-f0-9]{24}$/.test(schema));
    await bootstrap.query(`drop schema "${schema}" cascade`);
  }
  await bootstrap.end();
}
