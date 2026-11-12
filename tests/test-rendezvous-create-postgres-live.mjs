import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createPostgresStore } from '../accounts/store/postgres.mjs';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { createDemoAccountAuth, createDemoAccountPolicy } from '../accounts/demo-credentials.mjs';
import { normalizeDevicePublicKey, createDevicePublicKeyFingerprint, buildAccountJoinIntentMessage } from '../lib/device-auth-protocol.mjs';
import { createInstancePublicKeyFingerprint, buildAccountJoinIntentProofMessage } from '../lib/instance-proof-protocol.mjs';
import { inboxWaitFixture } from './fixtures/rendezvous-inbox-wait.mjs';
import { issueInstanceAccessGrant, revokeInstanceAccessGrant } from '../accounts/instance-access-grants.mjs';

const url = process.env.AGENTOC_ACCOUNTS_ISOLATED_TEST_DATABASE_URL;
test('scoped creation preserves replay, revocation, rollback and retention in PostgreSQL', { skip: !url }, async t => {
  assert.match(new URL(url).pathname.slice(1), /^qa_rendezvous_[a-f0-9]{24}$/);
  const schema = `qa_create_${randomBytes(12).toString('hex')}`;
  const pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema} -c statement_timeout=15000` });
  let created = false, failInsert = false;
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
  function store(scoped) {
    return createPostgresStore({ schema, enableScopedRendezvousCreation: scoped, pool: { connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), async query(sql, values = []) {
        if (sql.includes('pg_advisory_xact_lock')) values = [`agentoc_accounts_store_v1:${schema}`];
        const result = await client.query(sql, values);
        if (failInsert && sql.startsWith('insert into account_join_intents')) throw new Error('injected insert failure');
        return result;
      } };
    } } });
  }
  const a = store(true), b = store(true), now = Date.now();
  const f = await inboxWaitFixture({ store: a, clock: () => now });
  const { intent } = await f.prepareOffer();
  const request = { requestId: intent.requestId, targetInstanceId: intent.instanceId,
    device: { deviceId: intent.deviceId, publicKey: intent.devicePublicKey,
      devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint, alias: intent.deviceName, platform: intent.platform } };
  const replay = await f.broker.createAccountRendezvous(request, f.credential);
  assert.equal(replay.replayed, true);
  assert.equal(replay.intent.intentId, intent.intentId);
  await assert.rejects(f.broker.createAccountRendezvous({ ...request, computerAlias: 'different' }, f.credential),
    { code: 'owner_auth_rendezvous_replay' });
  await assert.rejects(f.broker.createAccountRendezvous({ ...request, requestId: 'qa_invalid_token_request_0001' },
    { credential: 'rac_' + 'a'.repeat(40) }), { code: 'owner_auth_account_credential_expired' });

  const duplicate = { ...request, requestId: 'qa_concurrent_request_0001' };
  const secondBroker = f.makeBroker();
  // Use a separately queued store to exercise the actual PostgreSQL advisory lock.
  const originalStore = f.store;
  const originalMutation = originalStore.mutateRendezvousCreation;
  let useSecond = false;
  originalStore.mutateRendezvousCreation = (...args) => (useSecond ? b : { mutateRendezvousCreation: originalMutation }).mutateRendezvousCreation(...args);
  const first = f.broker.createAccountRendezvous(duplicate, f.credential);
  useSecond = true;
  const second = secondBroker.createAccountRendezvous(duplicate, f.credential);
  const concurrent = await Promise.all([first, second]);
  assert.equal(concurrent[0].intent.intentId, concurrent[1].intent.intentId);
  assert.deepEqual(concurrent.map(x => x.replayed).sort(), [false, true]);
  originalStore.mutateRendezvousCreation = originalMutation;

  await pool.query('update account_join_intents set rendezvous_result=$1::jsonb, expires_at=$2 where intent_id=$3',
    [JSON.stringify({ retained: true }), new Date(now - 1000).toISOString(), intent.intentId]);
  await pool.query(`insert into account_session_challenges
    (transaction_id,request_id,device_id,public_key,public_key_fingerprint,nonce,created_at,expires_at)
    values ('tx_expired_qa','request_expired_qa','adev_qa','fixture','fixture','fixture',$1,$2),
      ('tx_live_qa','request_live_qa','adev_qa','fixture','fixture','fixture',$1,$3)`,
    [new Date(now - 2000).toISOString(), new Date(now - 1000).toISOString(), new Date(now + 60000).toISOString()]);
  const [auth] = (await pool.query('select credential_id, account_id, device_id from account_credentials limit 1')).rows;
  const [key] = (await pool.query('select fingerprint from account_device_keys where device_id=$1 limit 1', [auth.device_id])).rows;
  await pool.query(`insert into account_credential_refreshes (credential_id,request_id,nonce_hash,issued_at,created_at)
    values ($1,'refresh_old_qa','old_hash',$2,$2), ($1,'refresh_live_qa','live_hash',$3,$3)`,
    [auth.credential_id, new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(), new Date(now).toISOString()]);
  await pool.query(`insert into account_join_grants
    (grant_hash,account_id,instance_id,intent_id,device_id,account_device_id,key_fingerprint,request_id,created_at,expires_at)
    values ('old_grant_qa',$1,$2,$3,$4,$4,$5,'grant_old_qa',$6,$7),
      ('live_grant_qa',$1,$2,$3,$4,$4,$5,'grant_live_qa',$6,$8)`,
    [auth.account_id, f.instance.instanceId, intent.intentId, auth.device_id, key.fingerprint,
      new Date(now - 20 * 60 * 1000).toISOString(), new Date(now - 16 * 60 * 1000).toISOString(), new Date(now + 60000).toISOString()]);
  const before = await b.mutate(draft => ({ device: draft.accountDevices[0], credential: draft.accountCredentials[0] }));
  failInsert = true;
  await assert.rejects(f.broker.createAccountRendezvous({ ...request, requestId: 'qa_failed_insert_request_0001' }, f.credential), /injected insert failure/);
  failInsert = false;
  assert.equal(Number((await pool.query('select count(*) as count from account_join_intents where rendezvous_request_id=$1',
    ['qa_failed_insert_request_0001'])).rows[0].count), 0);
  assert.deepEqual(await b.mutate(draft => ({ device: draft.accountDevices[0], credential: draft.accountCredentials[0] })), before);
  assert.deepEqual((await pool.query('select rendezvous_result from account_join_intents where intent_id=$1',
    [intent.intentId])).rows[0].rendezvous_result, { retained: true }, 'Pruning rolls back with failed creation');
  assert.equal(Number((await pool.query("select count(*) as count from account_session_challenges where transaction_id='tx_expired_qa'")).rows[0].count), 1);
  assert.equal(Number((await pool.query("select count(*) as count from account_join_grants where grant_hash='old_grant_qa'")).rows[0].count), 1);
  assert.equal(Number((await pool.query("select count(*) as count from account_credential_refreshes where request_id='refresh_old_qa'")).rows[0].count), 1);
  assert.equal((await f.broker.createAccountRendezvous(request, f.credential)).replayed, true);
  assert.equal((await pool.query('select rendezvous_result from account_join_intents where intent_id=$1', [intent.intentId])).rows[0].rendezvous_result, null);
  assert.deepEqual((await pool.query("select transaction_id from account_session_challenges where transaction_id like 'tx_%_qa' order by transaction_id")).rows.map(x => x.transaction_id), ['tx_live_qa']);
  assert.deepEqual((await pool.query("select grant_hash from account_join_grants where grant_hash in ('old_grant_qa','live_grant_qa') order by grant_hash")).rows.map(x => x.grant_hash), ['live_grant_qa']);
  assert.deepEqual((await pool.query("select request_id from account_credential_refreshes where request_id in ('refresh_old_qa','refresh_live_qa') order by request_id")).rows.map(x => x.request_id), ['refresh_live_qa']);
  await pool.query('update account_join_intents set expires_at=$1 where intent_id=$2', [intent.expiresAt, intent.intentId]);
  await b.mutate(draft => { draft.accountDeviceKeys[0].revokedAt = new Date(now).toISOString(); });
  await assert.rejects(f.broker.createAccountRendezvous({ ...request, requestId: 'qa_revoked_key_request_0001' }, f.credential),
    { code: 'owner_auth_account_device_revoked' });
  await b.mutate(draft => { draft.accountDeviceKeys[0].revokedAt = ''; });

  const sha256 = value => createHash('sha256').update(value).digest('hex');
  async function seedPhone(accountId, provider, deviceId) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = normalizeDevicePublicKey(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString());
    const fingerprint = createDevicePublicKeyFingerprint(publicKey.publicKey);
    const keyId = accountId.startsWith('acct_demo_') ? `adk_demo_${sha256(`${accountId}:${publicKey.keyId}`)}` : publicKey.keyId;
    const token = `rac_${randomBytes(32).toString('base64url')}`, at = new Date(now).toISOString();
    await b.mutate(draft => {
      draft.accounts.push({ accountId, provider, providerSubject: `subject_${deviceId}`, createdAt: at });
      draft.accountDevices.push({ accountId, deviceId, alias: 'Fixture phone', platform: 'android', createdAt: at, lastSeenAt: at });
      draft.accountDeviceKeys.push({ accountId, deviceId, keyId, publicKey: publicKey.publicKey, fingerprint, createdAt: at });
      draft.accountCredentials.push({ accountId, deviceId, keyId, credentialId: `cred_${deviceId}`,
        tokenHash: sha256(token), scope: 'account-directory', issuedAt: at, expiresAt: new Date(now + 3600000).toISOString(), lastUsedAt: at });
    });
    return { credential: { credential: token }, device: { deviceId, publicKey: publicKey.publicKey,
      devicePublicKeyFingerprint: fingerprint, alias: 'Fixture phone', platform: 'android' },
      signMessage: message => sign('sha256', Buffer.from(message), pair.privateKey).toString('base64') };
  }
  const targetKeys = new Map();
  function target(instanceId) {
    const pair = generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    targetKeys.set(instanceId, pair.privateKey);
    return { instanceId, publicKey, keyFingerprint: createInstancePublicKeyFingerprint(publicKey) };
  }
  const brokerFor = (store, demoAccountAuth = null) => createOwnerAuthBroker({ store, demoAccountAuth, clock: () => now,
    verifyGoogleCredential: async () => ({}), resolveAccount: async () => ({}), signAssertion: async () => '' });
  const baselineBroker = brokerFor(store(false));
  const foreign = await seedPhone('acct_foreign_qa', 'google', 'adev_foreign_qa');
  const workspaceMigrationDown = await readFile(new URL('../accounts/migrations/046_workspace_join_identity.down.sql', import.meta.url), 'utf8');
  const workspaceMigrationUp = await readFile(new URL('../accounts/migrations/046_workspace_join_identity.up.sql', import.meta.url), 'utf8');
  await pool.query(workspaceMigrationDown);
  await assert.rejects(b.mutate(draft => { draft.accountJoinGrants.push({ workspaceGrantId: 'iag_workspace_fixture_001' }); }),
    /Workspace join identity migration is required/);
  await pool.query(workspaceMigrationUp);
  for (const broker of [f.broker, baselineBroker]) {
    await assert.rejects(broker.createAccountRendezvous(request, foreign.credential), { code: 'owner_auth_rendezvous_replay' });
    await assert.rejects(broker.createAccountRendezvous({ ...request, requestId: 'qa_foreign_bound_request_0001',
      device: foreign.device }, foreign.credential), { code: 'owner_auth_binding_mismatch' });
  }
  const access = await b.mutate(draft => issueInstanceAccessGrant(draft, { instanceId: f.instance.instanceId,
    ownerAccountId: 'acct_inbox_qa', accountId: 'acct_foreign_qa', requestId: 'qa_workspace_grant_request_001', now }));
  for (const [index, broker] of [f.broker, baselineBroker].entries()) {
    const result = await broker.createAccountRendezvous({ ...request, requestId: `qa_shared_rendezvous_request_000${index}`,
      device: foreign.device }, foreign.credential);
    assert.equal(result.intent.instanceKeyFingerprint, f.instance.keyFingerprint);
    const selected = JSON.parse(JSON.stringify(result.intent));
    const proof = { intentId: selected.intentId, requestId: `qa_shared_authorize_request_000${index}`,
      deviceId: selected.deviceId, devicePublicKeyFingerprint: selected.devicePublicKeyFingerprint,
      nonce: selected.nonce, issuedAt: selected.issuedAt,
      deviceSignature: foreign.signMessage(buildAccountJoinIntentMessage({ ...selected, audience: 'agentoc-account-join' })) };
    await broker.authorizeAccountJoinIntent(proof, foreign.credential);
    const retained = await pool.query('select workspace_grant_id from account_join_grants where intent_id = $1', [selected.intentId]);
    assert.equal(retained.rows[0].workspace_grant_id, access.grant.grantId);
  }
  await assert.rejects(pool.query(workspaceMigrationDown), /Cannot remove workspace join identities/);
  await b.mutate(draft => revokeInstanceAccessGrant(draft, { grantId: access.grant.grantId,
    ownerAccountId: 'acct_inbox_qa', now }));
  for (const [index, broker] of [f.broker, baselineBroker].entries()) {
    await assert.rejects(broker.createAccountRendezvous({ ...request, requestId: `qa_revoked_workspace_request_000${index}`,
      device: foreign.device }, foreign.credential), { code: 'owner_auth_binding_mismatch' });
  }
  const claim = `rpi_${randomBytes(32).toString('base64url')}`;
  for (const [index, broker] of [f.broker, baselineBroker].entries()) {
    const qrTarget = target(`inst_qr_claim_qa_${index}`);
    const qr = JSON.parse(JSON.stringify(await broker.createAccountRendezvous({ requestId: `qa_qr_claim_request_000${index}`,
      targetInstanceId: qrTarget.instanceId, targetInstance: qrTarget, accountClaimToken: claim, device: foreign.device }, foreign.credential)));
    assert.equal(qr.intent.instanceKeyFingerprint, qrTarget.keyFingerprint);
    assert.equal(qr.intent.accountClaimTokenHash, sha256(claim));
    const joinMessage = buildAccountJoinIntentMessage({ ...qr.intent, audience: 'agentoc-account-join' });
    const deviceSignature = foreign.signMessage(joinMessage);
    const authorization = { intentId: qr.intent.intentId,
      requestId: `qa_qr_authorize_request_000${index}`, deviceId: qr.intent.deviceId,
      devicePublicKeyFingerprint: qr.intent.devicePublicKeyFingerprint, nonce: qr.intent.nonce,
      issuedAt: qr.intent.issuedAt, deviceSignature };
    await assert.rejects(broker.authorizeAccountJoinIntent(authorization, f.credential),
      { code: 'owner_auth_account_join_mismatch' });
    const grant = await broker.authorizeAccountJoinIntent(authorization, foreign.credential);
    const issuedAt = new Date(now).toISOString(), audience = 'agentoc-account-join';
    const proofMessage = buildAccountJoinIntentProofMessage({ instanceId: qrTarget.instanceId, intentId: qr.intent.intentId,
      deviceId: qr.intent.deviceId, devicePublicKeyFingerprint: qr.intent.devicePublicKeyFingerprint,
      nonce: qr.intent.nonce, issuedAt, audience, publicEndpoint: '' });
    const completed = await broker.completeAccountJoinIntent({ intentId: qr.intent.intentId,
      requestId: `qa_qr_complete_request_000${index}`, nonce: qr.intent.nonce, deviceIssuedAt: qr.intent.issuedAt,
      device: { deviceId: qr.intent.deviceId, devicePublicKeyFingerprint: qr.intent.devicePublicKeyFingerprint },
      deviceSignature, accountJoinGrant: grant.accountJoinGrant, publicEndpoint: '', issuedAt, audience,
      instance: qrTarget, signature: sign(null, Buffer.from(proofMessage), targetKeys.get(qrTarget.instanceId)).toString('base64url') });
    assert.equal(completed.accountId, 'acct_foreign_qa');
    assert(!JSON.stringify(completed).includes(foreign.credential.credential));
    const binding = (await pool.query('select account_id,instance_key_fingerprint from instance_bindings where instance_id=$1',
      [qrTarget.instanceId])).rows[0];
    assert.equal(binding.account_id, 'acct_foreign_qa');
    assert.equal(binding.instance_key_fingerprint, qrTarget.keyFingerprint);
  }

  const allowed = target('inst_demo_allowed_qa'), extra = target('inst_demo_extra_qa');
  const policy = await createDemoAccountPolicy({ username: 'isolated-demo', password: 'synthetic-password-2026', instanceId: allowed.instanceId });
  const demo = await seedPhone(policy.accountId, 'demo', 'adev_demo_qa');
  const bind = targetValue => ({ accountId: policy.accountId, instanceId: targetValue.instanceId,
    instancePublicKey: targetValue.publicKey, instanceKeyFingerprint: targetValue.keyFingerprint,
    provider: 'demo', boundAt: new Date(now).toISOString(), revokedAt: '' });
  await b.mutate(draft => { draft.instanceBindings.push(bind(allowed)); });
  const restricted = createDemoAccountAuth(policy), restrictedFast = brokerFor(a, restricted), restrictedFull = brokerFor(store(false), restricted);
  for (const [index, broker] of [restrictedFast, restrictedFull].entries()) {
    const permitted = await broker.createAccountRendezvous({ requestId: `qa_demo_allowed_request_000${index}`,
      targetInstanceId: allowed.instanceId, device: demo.device }, demo.credential);
    assert.equal(permitted.intent.instanceKeyFingerprint, allowed.keyFingerprint);
    const claimable = await broker.createAccountRendezvous({ requestId: `qa_demo_denied_request_000${index}`,
      targetInstanceId: extra.instanceId, targetInstance: extra, accountClaimToken: claim, device: demo.device }, demo.credential);
    assert.equal(claimable.intent.instanceKeyFingerprint, extra.keyFingerprint);
  }
  await b.mutate(draft => { draft.instanceBindings.push(bind(extra)); });
  for (const [index, broker] of [restrictedFast, restrictedFull].entries()) {
    const permitted = await broker.createAccountRendezvous({ requestId: `qa_demo_extra_binding_000${index}`,
      targetInstanceId: allowed.instanceId, device: demo.device }, demo.credential);
    assert.equal(permitted.intent.instanceKeyFingerprint, allowed.keyFingerprint);
  }
  const fullAccess = createDemoAccountAuth({ ...policy, instanceAccess: 'account' });
  for (const [index, broker] of [brokerFor(a, fullAccess), brokerFor(store(false), fullAccess)].entries()) {
    const permitted = await broker.createAccountRendezvous({ requestId: `qa_demo_full_request_000${index}`,
      targetInstanceId: extra.instanceId, device: demo.device }, demo.credential);
    assert.equal(permitted.intent.instanceKeyFingerprint, extra.keyFingerprint);
  }

  // Compare equal API work with a large history. Network latency to this
  // isolated database is included, so do not treat it as production latency.
  const beforeHistory = Number((await pool.query('select count(*) as count from account_join_intents')).rows[0].count);
  await pool.query(`insert into account_join_intents
    (intent_id, instance_id, instance_public_key, instance_key_fingerprint, device_id,
     device_public_key, device_public_key_fingerprint, nonce_hash, issued_at, created_at, expires_at, status)
    select 'rji_history_' || n, instance_id, instance_public_key, instance_key_fingerprint, device_id,
      device_public_key, device_public_key_fingerprint, 'history_' || n, issued_at, created_at, expires_at, 'completed'
    from account_join_intents cross join generate_series(1, 6000) n where intent_id = $1`, [intent.intentId]);
  const fullBroker = f.makeBroker();
  originalStore.mutateRendezvousCreation = undefined;
  const fullAt = performance.now();
  await fullBroker.createAccountRendezvous({ ...request, requestId: 'qa_full_timing_request_0001' }, f.credential);
  const fullMs = Math.round(performance.now() - fullAt);
  originalStore.mutateRendezvousCreation = originalMutation;
  const scopedAt = performance.now();
  await f.broker.createAccountRendezvous({ ...request, requestId: 'qa_scoped_timing_request_0001' }, f.credential);
  const scopedMs = Math.round(performance.now() - scopedAt);
  assert.equal(Number((await pool.query('select count(*) as count from account_join_intents')).rows[0].count), beforeHistory + 6002);
  t.diagnostic(`Remote isolated PostgreSQL creation with 6000 history rows: full=${fullMs}ms scoped=${scopedMs}ms; includes SSH latency`);
});
