import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { createFileStore, createAccountsServer } from '../accounts/server.mjs';
import { TemporaryPairingRegistry } from '../chat/temporary-pairing-registry.mjs';
import { TemporaryPairingHost } from '../chat/temporary-pairing-host.mjs';
import { startTemporaryPairingPoller } from '../chat/temporary-pairing-runtime.mjs';
import { handleTemporaryPairingOwnerRoutes } from '../chat/router-temporary-pairing-routes.mjs';
import { createTemporaryPairingClient, temporaryBrokerUrl, TEMPORARY_BROKER_REQUEST_TIMEOUT_MS } from '../lib/temporary-pairing-client.mjs';
import { loadOrCreateInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { buildTemporaryClaimMessage, temporaryInvitationDigest } from '../lib/temporary-pairing-protocol.mjs';
import { buildTemporaryBrokerMessage, verifyTemporaryCompletion } from '../lib/temporary-pairing-broker-protocol.mjs';
import { temporaryDeviceJwk, issueTemporaryAccessCredential } from '../lib/temporary-device-access.mjs';

const initial = 1_800_000_000_000;
const id = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temp-host-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  let time = initial;
  const clock = () => time;
  const identity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'instance.json') });
  let binding = { accountId: 'acct_test', boundAt: new Date(initial).toISOString() };
  const store = createFileStore(join(root, 'accounts.json'));
  await store.mutate((draft) => {
    draft.accounts = [{ accountId: binding.accountId, provider: 'google', providerSubject: 'fixture', createdAt: binding.boundAt }];
    draft.instanceBindings = [{ ...binding, instanceId: identity.instanceId, instancePublicKey: identity.publicKey,
      instanceKeyFingerprint: identity.keyFingerprint, revokedAt: '' }];
  });
  const app = await createAccountsServer({ store, publicBaseUrl: 'http://127.0.0.1/accounts', allowInsecurePublicBaseUrl: true,
    signingKeyFile: join(root, 'signing.json'), turnBrokerSigningKeyFile: join(root, 'turn.json'), clock,
    temporaryPairingKeyRing: { activeKeyId: 'test', keys: { test: randomBytes(32).toString('base64') } },
    verifyGoogleCredential: () => { throw new Error('Phone must not use Google'); },
    verifyNativeGoogleCredential: () => { throw new Error('Phone must not use Google'); } });
  const server = createServer(async (req, res) => { if (!await app.handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}/accounts`;
  const filePath = join(root, 'pc.json');
  const open = (fetchImpl = fetch, base = baseUrl) => {
    const registry = new TemporaryPairingRegistry({ filePath, identity, clock });
    const client = createTemporaryPairingClient({ baseUrl: base, identity, clock, fetchImpl, allowInsecure: true });
    return new TemporaryPairingHost({ registry, client, clock, binding: async () => binding });
  };
  const call = async (action, body) => {
    const response = await fetch(`${baseUrl}/v1/temporary-pairing/${action}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, action === 'register' ? 201 : 200, JSON.stringify(value)); return value;
  };
  const phone = (ticket, device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })) => {
    const digest = device.privateKey.asymmetricKeyType === 'ed25519' ? null : 'sha256';
    const claim = { instanceId: identity.instanceId, invitationId: ticket.envelope.invitation.invitationId,
      invitationDigest: temporaryInvitationDigest(ticket.envelope.invitation), requestId: id('rtr'),
      devicePublicKey: device.publicKey.export({ type: 'spki', format: 'pem' }).toString(), token: ticket.token };
    claim.signature = sign(digest, Buffer.from(buildTemporaryClaimMessage(claim)), device.privateKey).toString('base64url');
    return { claim, device, result: () => {
      const input = { instanceId: identity.instanceId, invitationId: claim.invitationId, requestId: claim.requestId,
        issuedAt: time, nonce: id('rtn'), payload: {} };
      input.signature = sign(digest, Buffer.from(buildTemporaryBrokerMessage('result', input)), device.privateKey).toString('base64url');
      return call('result', input);
    } };
  };
  const proof = (action, ticket, payload = { envelope: ticket.envelope }) => {
    const input = { instanceId: identity.instanceId, invitationId: ticket.envelope.invitation.invitationId,
      requestId: id('rtr'), issuedAt: time, nonce: id('rtn'), payload };
    input.signature = signWithInstanceIdentity(identity, buildTemporaryBrokerMessage(action, input)); return input;
  };
  return { root, filePath, identity, open, host: open(), app, store, phone, call, proof, clock,
    advance: (ms) => { time += ms; }, setBinding: (b) => { binding = b; } };
}

test('production host exchanges claims over actual HTTP; cold recovery preserves the grant and deadline', async (t) => {
  const f = await fixture(t); const ticket = await f.host.create(); const phone = f.phone(ticket);
  assert.equal(ticket.businessAccessReady, false);
  assert.equal((await f.host.tick()).handled, true);
  await f.call('claim', phone.claim);
  assert.equal((await f.open().tick()).handled, true);
  const accepted = (await f.host.list())[0]; assert.equal(accepted.status, 'CLAIMED');
  f.advance(4_000); assert.equal((await f.open().tick()).handled, true);
  const delivered = await phone.result();
  const result = verifyTemporaryCompletion(delivered.completion, { envelope: ticket.envelope,
    claim: phone.claim, expectedInstance: f.identity, now: f.clock() });
  assert.equal(result.grantId, accepted.grant.grantId);
  assert.equal(result.accessExpiresAt, initial + 600_000);
  assert.equal((await f.open().list())[0].delivery.completionConfirmed, true);
  assert.equal((await readFile(f.filePath, 'utf8')).includes(ticket.token), false);
  assert.equal(JSON.stringify(await f.host.list()).includes(ticket.token), false);
});

const accessTarget = 'https://pc.example.test/api/sessions';
function dpop(phone, credential, now, patch = {}, headerPatch = {}) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const alg = phone.device.privateKey.asymmetricKeyType === 'ed25519' ? 'EdDSA' : 'ES256';
  const header = { typ: 'dpop+jwt', alg, jwk: temporaryDeviceJwk(phone.claim.devicePublicKey).jwk, ...headerPatch };
  const claims = { jti: id('proof'), htm: 'POST', htu: accessTarget, iat: Math.floor(now / 1000),
    ath: createHash('sha256').update(credential.access_token).digest('base64url'), ...patch };
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${sign(alg === 'EdDSA' ? null : 'sha256', Buffer.from(input), { key: phone.device.privateKey,
    ...(alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' } : {}) }).toString('base64url')}`;
}

async function connected(t, device) {
  const f = await fixture(t); const ticket = await f.host.create(); const phone = f.phone(ticket, device);
  await f.host.tick(); await f.call('claim', phone.claim); await f.host.tick(); f.advance(4000); await f.host.tick();
  const completion = (await phone.result()).completion;
  const credential = completion.payload.accessCredential;
  verifyTemporaryCompletion(completion, { envelope: ticket.envelope, claim: phone.claim, expectedInstance: f.identity, now: f.clock() });
  return { ...f, makePhone: f.phone, ticket, phone, credential, completion,
    request: (proof = dpop(phone, credential, f.clock()), overrides = {}) => ({ credential, proof, method: 'POST', targetUri: accessTarget, ...overrides }) };
}

for (const algorithm of ['p256', 'ed25519']) {
  test(`${algorithm} completion credential requires original device proof and never produces an Owner`, async (t) => {
    const device = algorithm === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const f = await connected(t, device);
    assert.equal(f.credential.token_type, 'DPoP');
    const principal = await f.host.authenticateRequest(f.request());
    assert.equal(principal.role, 'temporary'); assert.equal(principal.principalKind, 'temporary_device');
    assert.equal(principal.grantId, f.completion.payload.result.grantId);
    assert.equal(principal.expiry, initial + 600_000); assert.equal(principal.sessionScope, 'created-sessions');
    const impostor = f.makePhone(f.ticket);
    await assert.rejects(f.host.authenticateRequest(f.request(dpop(impostor, f.credential, f.clock()))), { code: 'temporary_access_proof_invalid' });
    await assert.rejects(f.host.authenticateRequest(f.request('', { credential: { ...f.credential, token_type: 'Bearer' } })), { code: 'temporary_access_credential_invalid' });
  });
}

test('proof replay is consumed once under concurrency and stays consumed across a cold reopen', async (t) => {
  const f = await connected(t); const request = f.request();
  const attempts = await Promise.allSettled([f.host.authenticateRequest(request), f.open().authenticateRequest(request)]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((r) => r.status === 'rejected').reason.code, 'temporary_access_proof_replayed');
  await assert.rejects(f.open().authenticateRequest(request), { code: 'temporary_access_proof_replayed' });
  assert.equal((await f.open().authenticateRequest(f.request())).grantId, f.completion.payload.result.grantId);
});

test('method, trusted URI, token hash, proof age, algorithm and private-key headers are enforced', async (t) => {
  const f = await connected(t);
  for (const patch of [{ htm: 'GET' }, { htu: 'https://other.example.test/api/sessions' }, { htu: accessTarget + '?changed=1' },
    { ath: 'foreign-token-hash' }, { iat: Math.floor(f.clock() / 1000) - 30 }, { iat: Math.floor(f.clock() / 1000) + 30 },
    { jti: 'short' }, { iat: String(Math.floor(f.clock() / 1000)) }]) {
    await assert.rejects(f.host.authenticateRequest(f.request(dpop(f.phone, f.credential, f.clock(), patch))), { code: 'temporary_access_proof_invalid' });
  }
  for (const patch of [{ alg: 'none' }, { typ: 'JWT' }, { jku: 'https://attacker.test' },
    { jwk: { ...temporaryDeviceJwk(f.phone.claim.devicePublicKey).jwk, d: 'must-not-accept-private-key' } }]) {
    await assert.rejects(f.host.authenticateRequest(f.request(dpop(f.phone, f.credential, f.clock(), {}, patch))), { code: 'temporary_access_proof_invalid' });
  }
  await assert.rejects(f.host.authenticateRequest(f.request(undefined, { targetUri: 'http://pc.example.test/api/sessions' })), { code: 'temporary_access_target_invalid' });
  // RFC 9449 excludes query and fragment from htu; the trusted adapter supplies the original target.
  assert.equal((await f.host.authenticateRequest(f.request(undefined, { targetUri: accessTarget + '?page=1' }))).role, 'temporary');
});

test('revocation during proof IO, account rebinding and fixed expiry deny fresh valid proofs', async (t) => {
  const f = await connected(t); const original = f.host.registry.consumeAccessProof.bind(f.host.registry);
  f.host.registry.consumeAccessProof = async (input) => {
    const result = await original(input); await f.host.revoke(f.ticket.envelope.invitation.invitationId); return result;
  };
  await assert.rejects(f.host.authenticateRequest(f.request()), { code: 'temporary_pairing_inactive' });
  const g = await connected(t); g.setBinding({ accountId: 'acct_test', boundAt: new Date(initial + 1).toISOString() });
  await assert.rejects(g.host.authenticateRequest(g.request()), { code: 'temporary_pairing_inactive' });
  const h = await connected(t); h.advance(596_000);
  await assert.rejects(h.host.authenticateRequest(h.request()), { code: 'temporary_pairing_inactive' });
});

test('broker rejects substituted or widened credential and freezes the original device-bound credential', async (t) => {
  const f = await connected(t); const payload = structuredClone(f.completion.payload);
  payload.accessCredential.token_type = 'Bearer';
  await assert.rejects(f.app.temporaryBroker.complete(f.proof('complete', f.ticket, payload)), { code: 'temporary_access_credential_invalid' });
  const changed = structuredClone(f.completion.payload); changed.accessCredential.expires_at++;
  await assert.rejects(f.app.temporaryBroker.complete(f.proof('complete', f.ticket, changed)), { code: 'temporary_access_binding_invalid' });
  const foreign = await connected(t);
  await assert.rejects(f.app.temporaryBroker.complete(f.proof('complete', f.ticket, {
    ...f.completion.payload, accessCredential: foreign.credential })), { code: 'temporary_access_signature_invalid' });
  await assert.rejects(f.app.temporaryBroker.complete(f.proof('complete', f.ticket, { result: f.completion.payload.result })), { code: 'temporary_broker_result_conflict' });
  const again = (await f.phone.result()).completion;
  assert.deepEqual(again.payload.accessCredential, f.credential);
});

test('proof capacity rejects without evicting still-valid replay records', async (t) => {
  const f = await connected(t);
  await f.host.registry.transact((state, now) => {
    state.records[0].accessProofs = Array.from({ length: 512 }, () => ({ proofHash: randomBytes(32).toString('base64url'), expiresAt: now + 30_000 }));
  });
  await assert.rejects(f.host.authenticateRequest(f.request()), { code: 'temporary_access_proof_capacity' });
  f.advance(30_000); assert.equal((await f.open().authenticateRequest(f.request())).role, 'temporary');
});

test('a proof jti cannot be reused for another grant on the same device key', async (t) => {
  const f = await connected(t); const jti = id('proof');
  await f.host.authenticateRequest(f.request(dpop(f.phone, f.credential, f.clock(), { jti })));
  const second = await f.host.create(); const phone = f.makePhone(second, f.phone.device);
  await f.host.registry.claim(phone.claim);
  const row = (await f.host.registry.deliverySnapshot((await f.host.context()).bindingStamp)).records
    .find((r) => r.envelope.invitation.invitationId === second.envelope.invitation.invitationId);
  const credential = issueTemporaryAccessCredential({ identity: f.identity, envelope: row.envelope, grant: row.grant });
  await assert.rejects(f.host.authenticateRequest(f.request(dpop(phone, credential, f.clock(), { jti }), { credential })),
    { code: 'temporary_access_proof_replayed' });
});

test('even a PC-signed token cannot widen the original invitation or change accepted device metadata', async (t) => {
  const f = await connected(t); const parts = f.credential.access_token.split('.');
  const original = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  for (const change of [{ scope: original.scope + ' owner' }, { sessionScope: 'all-sessions' }, { exp: original.exp + 1 },
    { sub: id('rdev') }, { requestId: id('rtr') }, { cnf: { jkt: 'wrong' } }, { aud: 'ragent-owner' }]) {
    const claims = { ...original, ...change };
    const input = `${parts[0]}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    const token = `${input}.${sign(null, Buffer.from(input), f.identity.privateKey).toString('base64url')}`;
    const credential = { ...f.credential, access_token: token };
    await assert.rejects(f.host.authenticateRequest(f.request(dpop(f.phone, credential, f.clock()), { credential })),
      { code: 'temporary_access_binding_invalid' });
  }
});

for (const action of ['register', 'complete']) {
  test(`${action} response loss survives restart without another invitation or grant`, async (t) => {
    const f = await fixture(t); const ticket = await f.host.create(); const phone = f.phone(ticket);
    if (action === 'complete') { await f.host.tick(); await f.call('claim', phone.claim); await f.host.tick(); f.advance(4_000); }
    let lost = false;
    const lossy = f.open(async (url, options) => {
      const response = await fetch(url, options);
      if (!lost && url.endsWith(`/${action}`)) { lost = true; await response.arrayBuffer(); throw new Error('response lost'); }
      return response;
    });
    assert.equal((await lossy.tick()).code, 'temporary_host_unavailable');
    assert.equal(lost, true);
    const before = (await f.host.list())[0]; f.advance(2_000);
    assert.equal((await f.open().tick()).handled, true);
    const after = (await f.open().list())[0];
    assert.equal(after.invitationId, before.invitationId); assert.deepEqual(after.grant, before.grant);
    assert.equal(after.accessExpiresAt, before.accessExpiresAt);
    if (action === 'complete') assert.equal((await phone.result()).completion.payload.result.grantId, before.grant.grantId);
  });
}

test('local revoke does not wait for network and a late registration ack cannot restore access', async (t) => {
  const f = await fixture(t); const ticket = await f.host.create(); const invitationId = ticket.envelope.invitation.invitationId;
  const started = deferred(); const release = deferred();
  const host = f.open(async (url, options) => { const response = await fetch(url, options); started.resolve(); await release.promise; return response; });
  const pending = host.tick(); await started.promise;
  try { assert.equal((await host.revoke(invitationId)).status, 'REVOKED'); }
  finally { release.resolve(); }
  await pending;
  assert.equal((await f.open().list())[0].status, 'REVOKED');
  assert.equal((await f.open().tick()).handled, true);
  assert.equal((await f.host.list())[0].delivery.revocationConfirmed, true);
  const records = await f.store.mutate((draft) => structuredClone(draft.temporaryPairingExchanges));
  assert.equal(records[0].status, 'REVOKED');
});

test('revoke before registration persists a tombstone which denies a late valid registration', async (t) => {
  const f = await fixture(t); const ticket = await f.host.create();
  await f.host.revoke(ticket.envelope.invitation.invitationId);
  assert.equal((await f.host.tick()).handled, true);
  await assert.rejects(f.app.temporaryBroker.register(f.proof('register', ticket)), { code: 'temporary_broker_inactive' });
  await assert.rejects(f.app.temporaryBroker.claim(f.phone(ticket).claim), { code: 'temporary_broker_inactive' });
});

test('binding loss while inbox is in flight prevents a local grant and still synchronizes revoke', async (t) => {
  const f = await fixture(t); const ticket = await f.host.create(); await f.host.tick(); await f.call('claim', f.phone(ticket).claim);
  const started = deferred(); const release = deferred();
  const host = f.open(async (url, options) => { const response = await fetch(url, options); started.resolve(); await release.promise; return response; });
  const pending = host.tick(); await started.promise; f.setBinding(null); release.resolve();
  assert.equal((await pending).code, 'temporary_host_binding_changed');
  const row = (await f.host.list())[0]; assert.equal(row.status, 'REVOKED'); assert.equal(row.grant, null);
  f.advance(2_000); assert.equal((await f.open().tick()).handled, true);
  assert.equal((await f.host.list())[0].delivery.revocationConfirmed, true);
  await assert.rejects(f.host.create(), { code: 'temporary_host_not_bound' });
});

test('changed configured broker invalidates old grants without contacting an old URL', async (t) => {
  const f = await fixture(t); await f.host.create(); let calls = 0;
  const host = f.open(async () => { calls++; throw new Error('must not call'); }, 'http://127.0.0.1:1/changed');
  assert.equal((await host.tick()).handled, false); assert.equal(calls, 0);
  assert.equal((await host.list())[0].status, 'REVOKED');
});

test('global Retry-After survives cold open and applies to other invitations, including non-JSON errors', async (t) => {
  const f = await fixture(t); await f.host.create(); await f.host.create(); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('rate limited', { status: 429, headers: { 'Retry-After': '20' } }); };
  assert.equal((await f.open(fetchImpl).tick()).code, 'temporary_host_rate_limited');
  f.advance(19_999); assert.equal((await f.open(fetchImpl).tick()).handled, false); assert.equal(calls, 1);
  f.advance(1); await f.open(fetchImpl).tick(); assert.equal(calls, 2);
});

test('extreme Retry-After remains durable without invalid integer timestamps', async (t) => {
  const f = await fixture(t); await f.host.create();
  const host = f.open(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '9007199254740' } }));
  assert.equal((await host.tick()).code, 'temporary_host_rate_limited');
  assert.equal((await f.host.list())[0].delivery.nextAttemptAt, Number.MAX_SAFE_INTEGER);
});

test('expiry during inbox wait denies first acceptance and cannot extend the invitation', async (t) => {
  const f = await fixture(t); const ticket = await f.host.create(); await f.host.tick(); await f.call('claim', f.phone(ticket).claim);
  const host = f.open(async (url, options) => { const response = await fetch(url, options); f.advance(120_000); return response; });
  assert.equal((await host.tick()).code, 'temporary_pairing_inactive');
  const row = (await f.host.list())[0]; assert.equal(row.status, 'EXPIRED'); assert.equal(row.grant, null);
  assert.equal(row.accessExpiresAt, initial + 600_000);
});

test('legacy internal tickets are never registered automatically and concurrent creates respect capacity', async (t) => {
  const f = await fixture(t); await f.host.registry.create(); let calls = 0;
  assert.equal((await f.open(async () => { calls++; }).tick()).handled, false); assert.equal(calls, 0);
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => f.open().create()));
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 4);
  assert.ok(attempts.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'temporary_host_pending_capacity'));
});

test('client requires HTTPS and bounds/substantiates responses without exposing foreign errors', async (t) => {
  const f = await fixture(t); const ticket = await f.host.create();
  assert.throws(() => temporaryBrokerUrl('http://example.test'));
  for (const url of ['https://user:password@example.test', 'https://example.test?token=secret', 'https://example.test#secret']) assert.throws(() => temporaryBrokerUrl(url));
  for (const [response, code] of [[new Response('x'.repeat(17_000)), 'temporary_host_response_too_large'],
    [new Response('{}'), 'temporary_host_response_invalid'], [new Response('oops'), 'temporary_host_response_invalid'],
    [new Response(JSON.stringify({ code: 'leak-secret', message: ticket.token }), { status: 500 }), 'temporary_host_request_failed']]) {
    const client = createTemporaryPairingClient({ baseUrl: 'https://example.test', identity: f.identity, clock: f.clock,
      fetchImpl: async (_, options) => { assert.equal(options.redirect, 'error'); return response; } });
    await assert.rejects(client.request('register', ticket.envelope.invitation.invitationId, { envelope: ticket.envelope }),
      (e) => e.code === code && !String(e).includes(ticket.token));
  }
});

test('client maps fetch timeouts without treating numeric DOMException codes as strings', async (t) => {
  const f = await fixture(t); const ticket = await f.host.create();
  assert.equal(TEMPORARY_BROKER_REQUEST_TIMEOUT_MS, 30_000,
    'temporary broker timeout must cover the observed slow Accounts write path');
  const timeout = new DOMException('The operation timed out', 'TimeoutError');
  assert.equal(typeof timeout.code, 'number');
  const client = createTemporaryPairingClient({ baseUrl: 'https://example.test', identity: f.identity,
    clock: f.clock, fetchImpl: async () => { throw timeout; } });
  await assert.rejects(client.request('register', ticket.envelope.invitation.invitationId,
    { envelope: ticket.envelope }), (error) => error.code === 'temporary_host_timeout' && error.statusCode === 504);
});

test('poller awaits each tick and stop aborts the active request without scheduling another', async () => {
  const started = deferred(); const exited = deferred(); let calls = 0; let activeSignal;
  const stop = await startTemporaryPairingPoller({ intervalMs: 1, getHost: async () => ({ tick: async ({ signal }) => {
    calls++; activeSignal = signal; started.resolve(); await new Promise((done) => signal.addEventListener('abort', done, { once: true })); exited.resolve();
  } }) });
  // A ref'ed timeout keeps this test alive while the production timer remains unref'ed.
  await Promise.race([started.promise, sleep(1000).then(() => { throw new Error('poller did not start'); })]);
  await sleep(10); assert.equal(calls, 1); stop(); await exited.promise;
  await sleep(10); assert.equal(calls, 1); assert.equal(activeSignal.aborted, true);
  const disabled = await startTemporaryPairingPoller({ getHost: async () => { throw Object.assign(new Error(), { code: 'temporary_host_disabled' }); } });
  disabled();
});

test('owner routes deny foreign principals before runtime lookup and reject caller-supplied routing', async () => {
  const path = '/api/device-pairing/temporary/invitations'; let lookups = 0; let created = 0;
  const call = async (authSession, body = '{}', method = 'POST', pathname = path) => {
    const req = Readable.from([Buffer.from(body)]); req.method = method; let response; const headers = {};
    const handled = await handleTemporaryPairingOwnerRoutes({ req, res: { setHeader: (k, v) => { headers[k] = v; } }, pathname,
      authSession, writeJson: (_, status, value) => { response = { status, value }; }, getHost: async () => { lookups++; return {
        create: async (options) => { created++; return { options, businessAccessReady: false }; }, list: async () => [],
      }; } });
    return { ...response, headers, handled };
  };
  for (const principalKind of ['trusted_device', 'provisional_device', 'temporary_device', 'agent']) {
    assert.equal((await call({ role: 'owner', principalKind })).status, 403);
  }
  assert.equal((await call(null)).status, 403); assert.equal(lookups, 0);
  const owner = { role: 'owner', principalKind: 'owner' };
  assert.equal((await call(owner, JSON.stringify({ brokerUrl: 'https://attacker.test' }))).status, 400);
  assert.equal((await call(owner, 'x'.repeat(17000))).status, 413);
  assert.equal((await call(owner, '{bad')).status, 400); assert.equal(created, 0);
  const accepted = await call(owner, '{"capabilities":["task.read"]}');
  assert.equal(accepted.status, 201); assert.equal(accepted.headers['Cache-Control'], 'no-store, max-age=0'); assert.equal(created, 1);
  assert.equal((await call(owner, '', 'GET')).value.businessAccessReady, false);
  assert.equal((await call(owner, '', 'DELETE')).status, 405);
  assert.equal((await call(owner, '', 'POST', path + '/unknown')).status, 404);
});

test('owner control routes create, confirm, list and revoke only the separate full-control registry', async () => {
  const prefix = '/api/device-pairing/temporary-control/invitations';
  const owner = { role: 'owner', principalKind: 'owner' };
  const calls = [];
  let accountBinding = null;
  const registry = {
    create: async () => ({ invitationId: 'rti_abcdefghijklmnopqrstuvwxyz', status: 'PENDING' }),
    list: async () => [{ invitationId: 'rti_abcdefghijklmnopqrstuvwxyz', status: 'CLAIMED' }],
    confirm: async (id) => { calls.push(['confirm', id]); return { invitationId: id, status: 'ACTIVE' }; },
    revoke: async (id) => { calls.push(['revoke', id]); return { invitationId: id, status: 'REVOKED' }; },
  };
  const call = async (pathname, method = 'POST', authSession = owner) => {
    const req = Readable.from([]); req.method = method; let response;
    const handled = await handleTemporaryPairingOwnerRoutes({ req, res: { setHeader() {} }, pathname, authSession,
      writeJson: (_, status, value) => { response = { status, value }; },
      getHost: async () => { throw new Error('v1 host must not be used'); }, getControlService: async () => registry,
      getAccountBinding: async () => accountBinding });
    return { handled, ...response };
  };
  assert.equal((await call(prefix)).status, 201);
  assert.equal((await call(prefix, 'GET')).value.invitations[0].status, 'CLAIMED');
  const id = 'rti_abcdefghijklmnopqrstuvwxyz';
  assert.equal((await call(`${prefix}/${id}/confirm`)).value.invitation.status, 'ACTIVE');
  assert.equal((await call(`${prefix}/${id}/revoke`)).value.invitation.status, 'REVOKED');
  assert.deepEqual(calls, [['confirm', id], ['revoke', id]]);
  assert.equal((await call(prefix, 'POST', { role: 'owner', principalKind: 'temporary_device' })).status, 403);
  accountBinding = { accountId: 'acct_signed_in' };
  const signedIn = await call(prefix);
  assert.equal(signedIn.status, 409);
  assert.equal(signedIn.value.code, 'temporary_control_use_account_pairing');
});
