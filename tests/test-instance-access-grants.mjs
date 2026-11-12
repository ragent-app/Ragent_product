import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createPostgresStoreFromUrl } from '../accounts/store/postgres.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { issueInstanceAccessGrant, isInstanceAccessGrantActive, revokeInstanceAccessGrant } from '../accounts/instance-access-grants.mjs';

const pair = generateKeyPairSync('ed25519');
const key = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const ownerAccountId = 'acct_google_owner', accountId = 'acct_ragent_member', instanceId = 'inst_workspace_fixture';
const draft = { accounts: [{ accountId: ownerAccountId }, { accountId }, { accountId: 'acct_unrelated' }],
  instanceBindings: [{ instanceId, accountId: ownerAccountId, instancePublicKey: key,
    instanceKeyFingerprint: createInstancePublicKeyFingerprint(key), boundAt: '2026-01-01T00:00:00.000Z' }] };
const identity = { instanceId, ownerAccountId, accountId, requestId: 'request_grant_fixture_001', now: Date.parse('2026-11-12T00:00:00Z') };
const originalBinding = structuredClone(draft.instanceBindings[0]);
const { grant, created } = issueInstanceAccessGrant(draft, identity);
assert.equal(created, true);
assert.deepEqual(draft.instanceBindings[0], originalBinding, 'granting access must not replace the owner binding');
assert.equal(isInstanceAccessGrantActive(draft, grant, identity), true);
const restored = JSON.parse(JSON.stringify(draft));
assert.equal(isInstanceAccessGrantActive(restored, restored.instanceAccessGrants[0], identity), true, 'grant survives serialized storage');
const sameTimestampRebind = structuredClone(restored);
sameTimestampRebind.bindingHistory = [{ instanceId, action: 'unbind' }, { instanceId, action: 'bind' }];
assert.equal(isInstanceAccessGrantActive(sameTimestampRebind, sameTimestampRebind.instanceAccessGrants[0], identity), false,
  'binding history fences a rebind even if timestamp and key repeat');
assert.equal(issueInstanceAccessGrant(draft, identity).created, false, 'retries reuse the current grant');
assert.equal(isInstanceAccessGrantActive(draft, { ...grant, grantId: 'iag_forged_fixture' }, identity), false);
assert.equal(isInstanceAccessGrantActive(draft, grant, { ...identity, instanceId: 'inst_other_fixture' }), false);
assert.equal(isInstanceAccessGrantActive(draft, grant, { ...identity, accountId: 'acct_unrelated' }), false);
assert.throws(() => issueInstanceAccessGrant(draft, { ...identity, ownerAccountId: 'acct_unrelated' }), { code: 'instance_access_unavailable' });
assert.throws(() => revokeInstanceAccessGrant(draft, { grantId: grant.grantId, ownerAccountId: 'acct_unrelated' }), { code: 'instance_access_unavailable' });
for (const field of ['disabledAt', 'deletedAt', 'deletionRequestedAt']) {
  draft.accounts[1][field] = '2026-01-02T00:00:00.000Z';
  assert.equal(isInstanceAccessGrantActive(draft, grant, identity), false, field);
  delete draft.accounts[1][field];
}
draft.instanceBindings[0].boundAt = '2026-01-02T00:00:00.000Z';
assert.equal(isInstanceAccessGrantActive(draft, grant, identity), false, 'rebind does not carry access forward');
assert.throws(() => revokeInstanceAccessGrant(draft, { grantId: grant.grantId, ownerAccountId }), { code: 'instance_access_unavailable' });
const replacement = issueInstanceAccessGrant(draft, { ...identity, requestId: 'request_grant_fixture_002' });
assert.equal(replacement.created, true);
assert.notEqual(replacement.grant.grantId, grant.grantId);
assert.ok(grant.revokedAt);
assert.equal(isInstanceAccessGrantActive(draft, replacement.grant, identity), true);
const revoked = revokeInstanceAccessGrant(draft, { grantId: replacement.grant.grantId, ownerAccountId, now: identity.now + 1 });
assert.deepEqual(revokeInstanceAccessGrant(draft, { grantId: replacement.grant.grantId, ownerAccountId, now: identity.now + 2 }), revoked);
assert.equal(isInstanceAccessGrantActive(draft, replacement.grant, identity), false);
const replayAfterRevoke = issueInstanceAccessGrant(draft, { ...identity, requestId: 'request_grant_fixture_002' });
assert.equal(replayAfterRevoke.created, false);
assert.ok(replayAfterRevoke.grant.revokedAt, 'replaying an issue request cannot revive a revoked grant');
assert.throws(() => issueInstanceAccessGrant(draft, { ...identity, accountId: 'acct_unrelated',
  requestId: 'request_grant_fixture_002' }), { code: 'instance_access_unavailable' });
assert.equal(draft.instanceBindings[0].accountId, ownerAccountId);
if (process.env.RAGENT_GRANT_TEST_DATABASE_URL) {
  const databaseUrl = process.env.RAGENT_GRANT_TEST_DATABASE_URL;
  const parsed = new URL(databaseUrl);
  assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.port, '18422');
  assert.equal(parsed.pathname, '/ragent_grant_fixture');
  let pg = createPostgresStoreFromUrl(databaseUrl);
  try {
    const migrations = (await readdir(new URL('../accounts/migrations/', import.meta.url))).filter(name => name.endsWith('.up.sql')).sort();
    for (const name of migrations.filter(name => name < '043_')) {
      await pg.pool.query(await readFile(new URL(`../accounts/migrations/${name}`, import.meta.url), 'utf8'));
    }
    await pg.pool.query(`insert into accounts(account_id,provider,provider_subject,created_at) values
      ($1,'google','owner-fixture','2026-01-01T00:00:00Z'),($2,'demo','member-fixture','2026-01-01T00:00:00Z')`, [ownerAccountId, accountId]);
    await pg.pool.query(`insert into instance_bindings(instance_id,account_id,provider,instance_public_key,instance_key_fingerprint,bound_at)
      values($1,$2,'google',$3,$4,$5)`, [instanceId, ownerAccountId, key, originalBinding.instanceKeyFingerprint, originalBinding.boundAt]);
    const initialRevision = (await pg.pool.query('select revision from instance_authority_revisions where instance_id=$1', [instanceId])).rows[0].revision;
    assert.equal(await pg.mutate(state => state.instanceBindings[0].accountId), ownerAccountId,
      'ordinary operations continue before the grants migration');
    await assert.rejects(pg.mutate(state => issueInstanceAccessGrant(state, identity)), /migration is required/);
    await pg.pool.query(await readFile(new URL('../accounts/migrations/043_instance_access_grants.up.sql', import.meta.url), 'utf8'));
    assert.equal(await pg.mutate(state => state.instanceBindings[0].accountId), ownerAccountId,
      'ordinary operations continue before the replay migration');
    await assert.rejects(pg.mutate(state => issueInstanceAccessGrant(state, identity)), /migration is required/);
    await pg.pool.query(`insert into instance_access_grants(grant_id,instance_id,owner_account_id,account_id,
      binding_key_fingerprint,binding_bound_at,binding_history_fingerprint,scope,created_at,revoked_at)
      values('iag_legacy_fixture_001','inst_legacy_fixture',$1,$2,$3,$4,$5,'workspace',$4,$4)`,
      [ownerAccountId, accountId, originalBinding.instanceKeyFingerprint, originalBinding.boundAt, 'a'.repeat(64)]);
    await pg.mutate(state => { state.accounts[0].name = 'Preserved owner'; });
    assert.equal((await pg.pool.query('select count(*)::int as n from instance_access_grants')).rows[0].n, 1,
      'the pre-replay writer preserves existing grant records');
    await pg.pool.query(await readFile(new URL('../accounts/migrations/044_instance_access_request_ids.up.sql', import.meta.url), 'utf8'));
    assert.equal((await pg.pool.query('select request_id from instance_access_grants')).rows[0].request_id, 'legacy_iag_legacy_fixture_001');
    await pg.pool.query('delete from instance_access_grants where instance_id=$1', ['inst_legacy_fixture']);
    assert.equal((await pg.pool.query('select revision from instance_authority_revisions where instance_id=$1', [instanceId])).rows[0].revision,
      initialRevision, 'migration does not invalidate existing owner authority');
    await pg.mutate(state => {
      state.accounts = [{ accountId: ownerAccountId, provider: 'google', providerSubject: 'owner-fixture', createdAt: '2026-01-01T00:00:00.000Z' },
        { accountId, provider: 'demo', providerSubject: 'member-fixture', createdAt: '2026-01-01T00:00:00.000Z' }];
      state.instanceBindings = [{ ...originalBinding, provider: 'google' }];
    });
    const revision = async () => Number((await pg.pool.query('select revision from instance_authority_revisions where instance_id=$1', [instanceId])).rows[0].revision);
    const before = await revision();
    const createdGrant = await pg.mutate(state => issueInstanceAccessGrant(state, identity));
    assert.equal(createdGrant.created, true);
    const after = await revision(); assert.equal(after, before + 1, 'grant changes authority generation');
    const rollback = await readFile(new URL('../accounts/migrations/043_instance_access_grants.down.sql', import.meta.url), 'utf8');
    await assert.rejects(pg.pool.query(rollback), /Cannot remove persisted instance access grants/);
    await pg.mutate(() => {}); assert.equal(await revision(), after, 'unchanged snapshots do not change generation');
    await pg.close(); pg = createPostgresStoreFromUrl(databaseUrl);
    assert.equal(await pg.mutate(state => isInstanceAccessGrantActive(state, state.instanceAccessGrants[0], identity)), true);
    await pg.mutate(state => revokeInstanceAccessGrant(state, { grantId: createdGrant.grant.grantId, ownerAccountId, now: identity.now + 10 }));
    assert.equal(await revision(), after + 1, 'revocation changes authority generation');
    const replay = await pg.mutate(state => issueInstanceAccessGrant(state, identity));
    assert.equal(replay.created, false); assert.ok(replay.grant.revokedAt);
    assert.equal(await revision(), after + 1, 'replayed issuance cannot undo revocation');
    assert.equal(await pg.mutate(state => isInstanceAccessGrantActive(state, state.instanceAccessGrants[0], identity)), false);
    const owner = await pg.pool.query('select account_id from instance_bindings where instance_id=$1', [instanceId]);
    assert.equal(owner.rows[0].account_id, ownerAccountId);
    await pg.mutate(state => issueInstanceAccessGrant(state, { ...identity, requestId: 'request_grant_fixture_003', now: identity.now + 20 }));
    const beforeAccountRemoval = await revision();
    await pg.mutate(state => { state.accounts = state.accounts.filter(account => account.accountId !== accountId); });
    assert.equal((await pg.pool.query('select count(*)::int as n from instance_access_grants')).rows[0].n, 0, 'account removal clears grants');
    assert.equal(await revision(), beforeAccountRemoval + 1, 'account removal invalidates active grants');
    await pg.pool.query(await readFile(new URL('../accounts/migrations/044_instance_access_request_ids.down.sql', import.meta.url), 'utf8'));
    await pg.pool.query(rollback);
    assert.equal((await pg.pool.query("select to_regclass('instance_access_grants') as name")).rows[0].name, null);
    console.log('PASS PostgreSQL instance grants: migration, persistence, binding generation, revocation, cleanup and unchanged owner');
  } finally { await pg.close(); }
}
console.log('PASS durable instance grant model: owner preservation, identity, rebind, account state and revocation');
