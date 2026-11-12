import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { isInstanceAccessGrantActive } from '../accounts/instance-access-grants.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-access-client-'));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.LOCALAPPDATA = join(root, 'local');
process.env.APPDATA = join(root, 'roaming');
process.env.AGENTOC_INSTANCE_ROOT = join(root, 'instance');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.AGENTOC_ACCOUNTS_URL = 'https://accounts.fixture.invalid';
const config = await import('../lib/config.mjs');
const { OWNER_ACCOUNT_BINDING_FILE, manageOwnerInstanceAccess } = await import('../lib/owner-account-auth.mjs');

try {
  const ownerAccountId = 'acct_owner_fixture', accountId = 'acct_member_fixture';
  const identity = await loadOrCreateInstanceIdentity();
  await mkdir(config.CONFIG_DIR, { recursive: true });
  await writeFile(OWNER_ACCOUNT_BINDING_FILE, JSON.stringify({ accountId: ownerAccountId, provider: 'google' }));
  const state = { accounts: [{ accountId: ownerAccountId, provider: 'google' }, { accountId, provider: 'demo' }],
    bindingHistory: [], instanceBindings: [{ instanceId: identity.instanceId, instancePublicKey: identity.publicKey,
      instanceKeyFingerprint: identity.keyFingerprint, accountId: ownerAccountId, boundAt: new Date().toISOString() }] };
  const broker = createOwnerAuthBroker({ store: { mutate: async fn => fn(state) },
    verifyGoogleCredential: async () => ({}), resolveAccount: async () => ({}), signAssertion: async () => '' });
  let calls = 0, firstPayload = '';
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://accounts.fixture.invalid/v1/owner-auth/instances/access-grants');
    calls++;
    if (!firstPayload) firstPayload = options.body;
    const result = await broker.manageInstanceAccessGrant(JSON.parse(options.body));
    if (calls === 1) throw Object.assign(new Error('lost response'), { code: 'ECONNRESET' });
    return { ok: true, status: 200, json: async () => result };
  };
  const issued = await manageOwnerInstanceAccess({ accountId, requestId: 'request_access_client_fixture', fetchImpl });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(firstPayload).requestId, issued.requestId);
  assert.equal(issued.created, false, 'retry after lost response reuses existing grant');
  assert.equal(state.instanceBindings[0].accountId, ownerAccountId);
  assert.equal(isInstanceAccessGrantActive(state, state.instanceAccessGrants[0],
    { accountId, instanceId: identity.instanceId }), true);
  const revoked = await manageOwnerInstanceAccess({ accountId, operation: 'revoke', grantId: issued.grantId,
    requestId: 'request_revoke_client_fixture', fetchImpl });
  assert.ok(revoked.revokedAt);
  assert.equal(isInstanceAccessGrantActive(state, state.instanceAccessGrants[0],
    { accountId, instanceId: identity.instanceId }), false);
  await assert.rejects(() => manageOwnerInstanceAccess({ accountId: ownerAccountId, fetchImpl }),
    { code: 'instance_access_request_invalid' });
  await assert.rejects(() => manageOwnerInstanceAccess({ accountId, fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => ({ grantId: 'iag_forged_fixture_123456', instanceId: 'inst_other_fixture', accountId,
      scope: 'workspace', created: true }) }) }), { code: 'instance_access_response_invalid' });
  await rm(config.INSTANCE_IDENTITY_FILE);
  await assert.rejects(() => manageOwnerInstanceAccess({ accountId, fetchImpl }), { code: 'owner_auth_not_bound' });
  await assert.rejects(() => access(config.INSTANCE_IDENTITY_FILE), { code: 'ENOENT' });
  console.log('PASS signed owner-instance access client: retry, binding preserved, revoke and response validation');
} finally {
  await rm(root, { recursive: true, force: true });
}
