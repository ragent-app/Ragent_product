import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { handleOwnerAuthRoutes } from '../accounts/owner-auth-routes.mjs';
import { buildInstanceAccessGrantMessage, createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { isInstanceAccessGrantActive } from '../accounts/instance-access-grants.mjs';

const now = Date.now();
let currentNow = now, advanceNextMutation = false;
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const instance = { instanceId: 'inst_access_fixture', publicKey, keyFingerprint: createInstancePublicKeyFingerprint(publicKey) };
const ownerAccountId = 'acct_owner_fixture', accountId = 'acct_member_fixture';
let state = { accounts: [{ accountId: ownerAccountId, provider: 'google' }, { accountId, provider: 'demo' },
  { accountId: 'acct_other_fixture', provider: 'google' }],
  instanceBindings: [{ ...instance, instancePublicKey: publicKey, instanceKeyFingerprint: instance.keyFingerprint,
    accountId: ownerAccountId, provider: 'google', boundAt: new Date(now - 1000).toISOString() }], bindingHistory: [] };
const store = { async mutate(fn) { if (advanceNextMutation) { currentNow += 3600000; advanceNextMutation = false; }
  const draft = structuredClone(state); const result = await fn(draft); state = draft; return result; } };
const broker = createOwnerAuthBroker({ store, clock: () => currentNow, verifyGoogleCredential: async () => ({}),
  verifyNativeGoogleCredential: async () => ({}), resolveAccount: async () => ({}), signAssertion: async () => '' });
function proof({ operation = 'issue', grantId = '', requestId = 'request_access_fixture_001', member = accountId,
  issuingKey = keys, issuingInstance = instance } = {}) {
  const fields = { instance: issuingInstance, ownerAccountId, accountId: member, operation, grantId, requestId,
    issuedAt: new Date(now).toISOString(), audience: 'agentoc-instance-access-grant' };
  const message = buildInstanceAccessGrantMessage({ ...fields, instanceId: issuingInstance.instanceId,
    keyFingerprint: issuingInstance.keyFingerprint });
  return { ...fields, signature: sign(null, Buffer.from(message), issuingKey.privateKey).toString('base64url') };
}
const server = createServer(async (req, res) => {
  const handled = await handleOwnerAuthRoutes({ req, res, pathname: new URL(req.url, 'http://127.0.0.1').pathname,
    broker, publicBaseUrl: 'http://127.0.0.1', allowInsecurePublicBaseUrl: true });
  if (!handled) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}/v1/owner-auth/instances/access-grants`;
  const call = async body => { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }; };
  const original = proof();
  assert.equal((await call({ ...original, accountId: 'acct_other_fixture' })).status, 401, 'signature binds recipient');
  assert.equal((await call({ ...original, requestId: 'request_tampered_fixture' })).status, 401, 'signature binds request');
  assert.equal((await call({ ...original, issuedAt: new Date(now - 3600000).toISOString() })).status, 400, 'expired proof is rejected');
  assert.equal((await call({ ...original, issuedAt: `${original.issuedAt}\nnoise` })).status, 400);
  advanceNextMutation = true;
  assert.equal((await call(proof({ requestId: 'request_delayed_fixture_001' }))).status, 401, 'lock wait cannot extend proof validity');
  currentNow = now;
  const otherKey = generateKeyPairSync('ed25519');
  const otherPublic = otherKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const otherInstance = { ...instance, publicKey: otherPublic, keyFingerprint: createInstancePublicKeyFingerprint(otherPublic) };
  assert.equal((await call(proof({ issuingKey: otherKey, issuingInstance: otherInstance }))).status, 403, 'another key cannot authorize the instance');
  const issued = await call(original);
  assert.equal(issued.status, 200); assert.equal(issued.cache, 'no-store'); assert.equal(issued.body.created, true);
  assert.equal(state.instanceBindings[0].accountId, ownerAccountId);
  assert.equal(isInstanceAccessGrantActive(state, state.instanceAccessGrants[0], { instanceId: instance.instanceId, accountId }), true);
  assert.equal((await call(original)).body.created, false, 'a lost response is safe to retry');
  const revoke = proof({ operation: 'revoke', grantId: issued.body.grantId, requestId: 'request_revoke_fixture_001' });
  assert.equal((await call({ ...revoke, grantId: 'iag_tampered_fixture_123' })).status, 401);
  assert.equal((await call(revoke)).status, 200);
  const replay = await call(original);
  assert.equal(replay.status, 200); assert.ok(replay.body.revokedAt); assert.equal(replay.body.created, false);
  assert.equal(isInstanceAccessGrantActive(state, state.instanceAccessGrants[0], { instanceId: instance.instanceId, accountId }), false);
  const renewed = await call(proof({ requestId: 'request_access_fixture_002' }));
  assert.equal(renewed.status, 200); assert.notEqual(renewed.body.grantId, issued.body.grantId);
  assert.equal((await call(revoke)).status, 200, 'old revoke cannot target the new grant');
  assert.equal(isInstanceAccessGrantActive(state, state.instanceAccessGrants[1], { instanceId: instance.instanceId, accountId }), true);
  console.log('PASS signed access-grant HTTP: key and fields bound, replay safe, revoke and original owner preserved');
} finally { await new Promise(resolve => server.close(resolve)); }
