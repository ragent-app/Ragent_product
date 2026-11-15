import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { handleOwnerAuthRoutes } from '../accounts/owner-auth-routes.mjs';
import { buildBindingAuthorityProofMessage, createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { verifyBindingAuthorityAssertion } from '../lib/binding-authority.mjs';
import { listenFetchLoopback } from './helpers/listen-fetch-loopback.mjs';

const keys = generateKeyPairSync('ed25519'), signing = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = createInstancePublicKeyFingerprint(publicKey);
const instance = { instanceId: `inst_${fingerprint.slice(0, 32)}`, publicKey, keyFingerprint: fingerprint };
const accountId = 'acct_authority_wire', issuer = 'https://authority.fixture.invalid';
const jwks = { keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'authority', alg: 'EdDSA' }] };
let now = Date.parse('2026-10-25T07:00:00.000Z'), reads = 0, mutations = 0, readDelay = 0;
let authority = { instanceId: instance.instanceId, revision: '7', binding: {
  instanceId: instance.instanceId, accountId, instanceKeyFingerprint: fingerprint, revokedAt: '',
} };
const signed = claims => {
  const body = [Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'authority' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
  return body + '.' + sign(null, Buffer.from(body), signing.privateKey).toString('base64url');
};
const broker = createOwnerAuthBroker({ issuer, clock: () => now,
  store: { mutate: () => { mutations++; throw Error('Authority status must not join the snapshot queue'); },
    readInstanceAuthority: async id => { assert.equal(id, instance.instanceId); reads++; now += readDelay; return authority; } },
  verifyGoogleCredential: async () => { throw Error('Google is not used for signed status reads'); },
  resolveAccount: async () => { throw Error('Status reads do not resolve accounts'); }, signAssertion: signed });
let base;
const server = createServer((req, res) => handleOwnerAuthRoutes({ req, res, pathname: req.url, broker,
  publicBaseUrl: base, googleWebClientId: '', allowInsecurePublicBaseUrl: true })
  .then(handled => { if (!handled) { res.writeHead(404); res.end('{}'); } }).catch(() => { res.writeHead(500); res.end('{}'); }));
await listenFetchLoopback(server);
base = `http://127.0.0.1:${server.address().port}/accounts`;
function request(overrides = {}) {
  const fields = { instanceId: instance.instanceId, keyFingerprint: fingerprint, accountId, requestId: 'authority_request',
    nonce: randomBytes(32).toString('base64url'), issuedAt: new Date(now).toISOString(), audience: 'ragent-binding-authority', ...overrides };
  return { ...fields, instance,
    signature: sign(null, Buffer.from(buildBindingAuthorityProofMessage(fields)), keys.privateKey).toString('base64url') };
}
async function post(body) {
  const response = await fetch(base + '/v1/owner-auth/instances/authority', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.match(response.headers.get('cache-control'), /no-store/);
  return { status: response.status, body: await response.json() };
}
try {
  const input = request(), startedAt = now;
  const expected = { issuer, instanceId: instance.instanceId, keyFingerprint: fingerprint, accountId,
    requestId: input.requestId, nonce: input.nonce, startedAt, clock: () => now };
  const first = await post(input);
  assert.equal(first.status, 200);
  const active = verifyBindingAuthorityAssertion(first.body.assertion, jwks, expected);
  assert.equal(active.state, 'active'); assert.equal(active.revision, '7'); assert.equal(active.expiresAt, now + 30_000);
  const originalClaims = JSON.parse(Buffer.from(first.body.assertion.split('.')[1], 'base64url'));
  for (const [state, revision, binding] of [
    ['revoked', '8', { ...authority.binding, revokedAt: new Date(now).toISOString() }],
    ['missing', '9', null], ['missing', '0', null],
    ['mismatch', '10', { ...authority.binding, accountId: 'other-account' }],
    ['mismatch', '11', { ...authority.binding, instanceKeyFingerprint: 'a'.repeat(64) }],
  ]) {
    authority = { instanceId: instance.instanceId, revision, binding };
    const result = await post(input); assert.equal(result.status, 200);
    const verified = verifyBindingAuthorityAssertion(result.body.assertion, jwks, expected);
    assert.equal(verified.state, state); assert.equal(verified.revision, revision); assert.equal(verified.accountId, accountId);
    assert.equal(JSON.stringify(result.body).includes('other-account'), false);
  }
  for (const changed of [{ nonce: 'different_nonce_of_required_length' }, { accountId: 'other' }, { audience: 'native' }]) {
    assert.equal((await post({ ...input, ...changed })).status, changed.audience ? 400 : 401);
  }
  assert.equal((await post(request({ issuedAt: new Date(now - 121_000).toISOString() }))).status, 401);
  for (const changed of [{ iss: 'other' }, { aud: 'other' }, { sub: 'other' }, { tx: 'other' }, { nonce: 'other' },
    { instanceKeyFingerprint: 'a'.repeat(64) }, { purpose: 'native' }, { authorityProtocol: 2 },
    { bindingAuthorityRevision: 7 }, { bindingAuthorityRevision: '07' }, { bindingAuthorityRevision: '9223372036854775808' },
    { bindingAuthorityRevision: '0' }, { bindingAuthorityState: 'unknown' },
    { exp: originalClaims.exp + 1 }, { iat: String(originalClaims.iat) }]) {
    assert.throws(() => verifyBindingAuthorityAssertion(signed({ ...originalClaims, ...changed }), jwks, expected),
      { code: 'owner_auth_authority_assertion_invalid' });
  }
  assert.throws(() => verifyBindingAuthorityAssertion(first.body.assertion, { keys: [] }, expected));
  assert.throws(() => verifyBindingAuthorityAssertion(first.body.assertion, jwks, { ...expected, nonce: 'old-request-nonce' }));
  const future = signed({ ...originalClaims, iat: originalClaims.iat + 4, exp: originalClaims.exp + 4 });
  assert.equal(verifyBindingAuthorityAssertion(future, jwks, expected).expiresAt, startedAt + 30_000,
    'Server clock skew cannot extend the local request-start deadline');
  now += 30_000;
  assert.throws(() => verifyBindingAuthorityAssertion(first.body.assertion, jwks, expected));
  const slowRequest = request(); readDelay = 30_000;
  assert.equal((await post(slowRequest)).status, 503, 'A slow DB/signing response cannot renew authority beyond the original deadline');
  assert.equal(mutations, 0); assert.equal(reads, 7);
  const legacy = createOwnerAuthBroker({ clock: () => now, store: { mutate: () => {} }, verifyGoogleCredential: async () => ({}),
    resolveAccount: async () => ({}), signAssertion: signed });
  await assert.rejects(legacy.readBindingAuthority(request()), { code: 'owner_auth_authority_unavailable' });
  console.log('binding authority wire: HTTP, real signatures, inactive states, proof/claim binding, bounded expiry and zero snapshot mutations passed');
} finally {
  server.closeAllConnections(); await new Promise(done => server.close(done));
}
