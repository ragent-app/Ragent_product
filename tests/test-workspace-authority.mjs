import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { handleOwnerAuthRoutes } from '../accounts/owner-auth-routes.mjs';
import { issueInstanceAccessGrant } from '../accounts/instance-access-grants.mjs';
import { buildWorkspaceAuthorityProofMessage, createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { verifyWorkspaceAuthorityAssertion } from '../lib/workspace-authority.mjs';
import { listenFetchLoopback } from './helpers/listen-fetch-loopback.mjs';

test('signed workspace status is exact, revocable and bound to its owner proof', async t => {
  let now = Date.parse('2026-11-12T00:00:00Z'), available = true, reads = 0;
  const host = generateKeyPairSync('ed25519'), signer = generateKeyPairSync('ed25519'), kid = 'workspace-test';
  const hostKey = host.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const instance = { instanceId: 'inst_workspace_status', publicKey: hostKey, keyFingerprint: createInstancePublicKeyFingerprint(hostKey) };
  const ownerAccountId = 'acct_workspace_owner', accountId = 'acct_demo_' + 'a'.repeat(48);
  const draft = { accounts: [{ accountId: ownerAccountId }, { accountId, provider: 'demo' }], instanceBindings: [{
    instanceId: instance.instanceId, accountId: ownerAccountId, instancePublicKey: hostKey,
    instanceKeyFingerprint: instance.keyFingerprint, boundAt: new Date(now).toISOString(),
  }] };
  const grant = issueInstanceAccessGrant(draft, { instanceId: instance.instanceId, ownerAccountId, accountId,
    requestId: 'request_workspace_grant_001', now }).grant;
  let revision = '7';
  const jwt = claims => {
    const message = [Buffer.from(JSON.stringify({ alg: 'EdDSA', kid })).toString('base64url'),
      Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
    return `${message}.${sign(null, Buffer.from(message), signer.privateKey).toString('base64url')}`;
  };
  const store = { mutate: async () => { throw Error('Status must be read-only'); },
    readWorkspaceAuthority: async input => { reads++; assert.deepEqual(input, { instanceId: instance.instanceId, accountId, grantId: grant.grantId });
      return { authority: { instanceId: instance.instanceId, binding: structuredClone(draft.instanceBindings[0]), revision }, draft: structuredClone(draft) }; } };
  const issuer = 'https://ragent.agentoncloud.com';
  const broker = createOwnerAuthBroker({ store, issuer, clock: () => now,
    demoAccountAuth: { accountId, assertAccount: () => { if (!available) throw Object.assign(Error('unavailable'), { code: 'owner_auth_demo_unavailable' }); } },
    verifyGoogleCredential: async () => { throw Error('unused'); }, resolveAccount: async () => { throw Error('unused'); }, signAssertion: async claims => jwt(claims) });
  let base;
  const server = createServer((req, res) => handleOwnerAuthRoutes({ req, res, pathname: req.url, broker,
    publicBaseUrl: base, googleWebClientId: '', allowInsecurePublicBaseUrl: true })
    .then(handled => { if (!handled) { res.writeHead(404); res.end('{}'); } }).catch(() => { res.writeHead(500); res.end('{}'); }));
  await listenFetchLoopback(server); base = `http://127.0.0.1:${server.address().port}/accounts`;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const jwks = { keys: [{ ...signer.publicKey.export({ format: 'jwk' }), kid }] };
  function input() {
    const fields = { instanceId: instance.instanceId, keyFingerprint: instance.keyFingerprint, ownerAccountId, accountId,
      grantId: grant.grantId, requestId: 'workspace_status_request_001', nonce: randomBytes(32).toString('base64url'),
      issuedAt: new Date(now).toISOString(), audience: 'ragent-workspace-authority' };
    return { ...fields, instance, signature: sign(null, Buffer.from(buildWorkspaceAuthorityProofMessage(fields)), host.privateKey).toString('base64url') };
  }
  async function post(body) {
    const response = await fetch(`${base}/v1/owner-auth/instances/workspace-authority`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  const original = input(), startedAt = now;
  const verify = value => verifyWorkspaceAuthorityAssertion(value, jwks, { issuer, instanceId: instance.instanceId,
    keyFingerprint: instance.keyFingerprint, ownerAccountId, accountId, grantId: grant.grantId,
    requestId: original.requestId, nonce: original.nonce, startedAt, clock: () => now });
  const active = await post(original);
  assert.equal(active.status, 200); assert.match(active.cache, /no-store/);
  assert.equal(verify(active.body.assertion).state, 'active');
  assert.equal((await post({ ...original, grantId: 'iag_' + 'x'.repeat(24) })).status, 401);
  assert.equal(reads, 1, 'invalid signatures are rejected before database reads');
  available = false;
  assert.equal(verify((await post(original)).body.assertion).state, 'inactive', 'account service disable takes effect on refresh');
  available = true; draft.instanceAccessGrants[0].revokedAt = new Date(now).toISOString(); revision = '8';
  assert.equal(verify((await post(original)).body.assertion).state, 'inactive');
  assert.throws(() => verifyWorkspaceAuthorityAssertion(active.body.assertion, jwks, { issuer, instanceId: instance.instanceId,
    keyFingerprint: instance.keyFingerprint, ownerAccountId, accountId, grantId: 'iag_' + 'b'.repeat(24),
    requestId: original.requestId, nonce: original.nonce, startedAt, clock: () => now }), { code: 'workspace_authority_assertion_invalid' });
  now += 30_001;
  assert.throws(() => verify(active.body.assertion), { code: 'workspace_authority_assertion_invalid' });
});
