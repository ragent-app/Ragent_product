import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('verified shared completion retains the local owner binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-shared-completion-'));
  Object.assign(process.env, { AGENTOC_CONFIG_DIR: join(root, 'config'), AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
    AGENTOC_ACCOUNTS_URL: 'https://accounts.example.test', AGENTOC_ACCOUNTS_ISSUER: 'https://accounts.example.test' });
  delete process.env.AGENTOC_INSTANCE_ROOT;
  const owner = 'acct_workspace_owner', member = 'acct_workspace_member', grantId = 'iag_' + 'c'.repeat(24);
  const file = join(root, 'config', 'owner-account-binding.json');
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(file, JSON.stringify({ accountId: owner, provider: 'google', plan: 'plus', boundAt: '2026-01-01T00:00:00.000Z' }));
  const keys = generateKeyPairSync('ed25519'), kid = 'shared-completion-fixture';
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid };
  const identity = await (await import('../lib/instance-identity.mjs')).loadOrCreateInstanceIdentity();
  const { completeOwnerAccountJoinIntent, queryWorkspaceAccountAuthority } = await import('../lib/owner-account-auth.mjs');
  const { buildWorkspaceAuthorityProofMessage, verifyInstanceProofSignature } = await import('../lib/instance-proof-protocol.mjs');
  const now = Date.now(), requestId = 'request_shared_completion_001';
  const intent = { intentId: 'intent_shared_completion_001', deviceId: 'device_shared_completion_001',
    devicePublicKeyFingerprint: 'a'.repeat(64), nonce: 'nonce_shared_completion_001',
    issuedAt: new Date(now).toISOString(), publicEndpoint: '' };
  let signedOwner = owner;
  function assertion() {
    const claims = { iss: 'https://accounts.example.test', aud: identity.instanceId, sub: member, purpose: 'account_join',
      tx: requestId, intentId: intent.intentId, deviceId: intent.deviceId, devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint,
      iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60, bindingAuthorityRevision: '2',
      workspaceAccess: { ownerAccountId: signedOwner, grantId } };
    const message = [Buffer.from(JSON.stringify({ alg: 'EdDSA', kid })).toString('base64url'),
      Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
    return `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString('base64url')}`;
  }
  async function fetchImpl(url) {
    if (new URL(url).pathname.endsWith('/.well-known/jwks.json')) return { ok: true, json: async () => ({ keys: [jwk] }) };
    return { ok: true, json: async () => ({ assertion: assertion(), workspaceAccess: { forged: true } }) };
  }
  const input = { intent, requestId, accountJoinGrant: 'fixture-grant', deviceSignature: 'fixture-signature', fetchImpl, clock: () => now };
  try {
    signedOwner = 'acct_another_owner';
    await assert.rejects(completeOwnerAccountJoinIntent(input), { code: 'owner_auth_binding_mismatch' });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).accountId, owner);
    signedOwner = owner;
    const completed = await completeOwnerAccountJoinIntent(input);
    assert.equal(completed.accountId, member);
    assert.deepEqual(completed.workspaceAccess, { ownerAccountId: owner, grantId });
    const binding = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(binding.accountId, owner); assert.equal(binding.plan, 'plus'); assert.equal(binding.bindingAuthorityRevision, '2');
    let requests = 0;
    const authorityFetch = async (url, options = {}) => {
      if (new URL(url).pathname.endsWith('/.well-known/jwks.json')) return { ok: true, json: async () => ({ keys: [jwk] }) };
      requests++;
      const body = JSON.parse(options.body);
      assert.equal(body.ownerAccountId, owner); assert.equal(body.accountId, member); assert.equal(body.grantId, grantId);
      assert.equal(verifyInstanceProofSignature({ publicKey: body.instance.publicKey,
        message: buildWorkspaceAuthorityProofMessage({ ...body, instanceId: body.instance.instanceId,
          keyFingerprint: body.instance.keyFingerprint }), signature: body.signature }), true);
      const claims = { iss: 'https://accounts.example.test', aud: identity.instanceId, sub: member,
        ownerAccountId: owner, workspaceGrantId: grantId, instanceKeyFingerprint: identity.keyFingerprint,
        purpose: 'workspace_authority', tx: body.requestId, nonce: body.nonce, bindingAuthorityRevision: '2',
        workspaceAuthorityState: 'active', authorityProtocol: 1, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 30 };
      const message = [Buffer.from(JSON.stringify({ alg: 'EdDSA', kid })).toString('base64url'),
        Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
      return { ok: true, json: async () => ({ assertion: `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString('base64url')}` }) };
    };
    const authority = await queryWorkspaceAccountAuthority({ ownerAccountId: owner, accountId: member, grantId, fetchImpl: authorityFetch, clock: () => now });
    assert.equal(authority.state, 'active'); assert.equal(authority.revision, '2');
    await assert.rejects(queryWorkspaceAccountAuthority({ ownerAccountId: 'acct_other_owner', accountId: member,
      grantId, fetchImpl: authorityFetch, clock: () => now }), { code: 'owner_auth_not_bound' });
    assert.equal(requests, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
