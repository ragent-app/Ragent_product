import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createFileStore, createAccountsServer } from '../accounts/server.mjs';
import { createTemporaryPairingBroker } from '../accounts/temporary-pairing-broker.mjs';
import { createTemporaryClaimCipher } from '../accounts/temporary-pairing-cipher.mjs';
import { TemporaryPairingRegistry } from '../chat/temporary-pairing-registry.mjs';
import { loadOrCreateInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { buildTemporaryClaimMessage, temporaryInvitationDigest, verifyTemporaryInvitation } from '../lib/temporary-pairing-protocol.mjs';
import { buildTemporaryBrokerMessage, verifyTemporaryBrokerProof, verifyTemporaryCompletion } from '../lib/temporary-pairing-broker-protocol.mjs';

const initial = 1_800_000_000_000;
const id = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temp-broker-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  let time = initial;
  const clock = () => time;
  const identity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'instance.json') });
  const file = join(root, 'accounts.json'); const store = createFileStore(file);
  await store.mutate((draft) => {
    draft.accounts = [{ accountId: 'acct_test', provider: 'google', providerSubject: 'fixture', createdAt: new Date(initial).toISOString() }];
    draft.instanceBindings = [{ instanceId: identity.instanceId, accountId: 'acct_test', boundAt: new Date(initial).toISOString(),
      instancePublicKey: identity.publicKey, instanceKeyFingerprint: identity.keyFingerprint, revokedAt: '' }];
  });
  const keys = { activeKeyId: 'test', keys: { test: randomBytes(32).toString('base64') } };
  const cipher = createTemporaryClaimCipher(keys);
  const open = (ring = keys) => createTemporaryPairingBroker({ store: createFileStore(file), clock, cipher: createTemporaryClaimCipher(ring) });
  const broker = createTemporaryPairingBroker({ store, clock, cipher });
  const pc = new TemporaryPairingRegistry({ filePath: join(root, 'pc.json'), identity, clock });
  const ticket = await pc.create();
  const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const claim = { instanceId: identity.instanceId, invitationId: ticket.envelope.invitation.invitationId,
    invitationDigest: temporaryInvitationDigest(ticket.envelope.invitation), requestId: id('rtr'),
    devicePublicKey: device.publicKey.export({ type: 'spki', format: 'pem' }).toString(), token: ticket.token };
  claim.signature = sign('sha256', Buffer.from(buildTemporaryClaimMessage(claim)), device.privateKey).toString('base64url');
  const proof = (action, payload = {}, patch = {}, key = device) => {
    const input = { instanceId: identity.instanceId, invitationId: claim.invitationId,
      requestId: action === 'result' ? claim.requestId : id('rtr'), issuedAt: time, nonce: id('rtn'), payload, ...patch };
    const message = buildTemporaryBrokerMessage(action, input);
    input.signature = action === 'result'
      ? sign('sha256', Buffer.from(message), key.privateKey).toString('base64url')
      : signWithInstanceIdentity(identity, message);
    return input;
  };
  const register = () => broker.register(proof('register', { envelope: ticket.envelope }));
  const state = () => store.mutate((draft) => structuredClone(draft));
  return { root, file, store, broker, pc, identity, ticket, device, claim, proof, register, state, cipher, keys, open,
    clock, setTime: (value) => { time = value; } };
}

test('full file-backed exchange reaches PC once without a phone Google identity', async (t) => {
  const f = await fixture(t); await f.register();
  assert.equal((await f.broker.claim(f.claim)).status, 'CLAIMED');
  const forwarded = await f.broker.inbox(f.proof('inbox'));
  assert.equal(forwarded.claim.token, f.ticket.token);
  const accepted = await f.pc.claim(forwarded.claim);
  const result = { ...accepted.grant, requestId: f.claim.requestId, accessExpiresAt: accepted.accessExpiresAt };
  const complete = f.proof('complete', { result });
  await f.broker.complete(complete);
  const delivered = await f.broker.result(f.proof('result'));
  assert.deepEqual(delivered.completion.payload.result, result);
  verifyTemporaryBrokerProof('complete', delivered.completion, f.identity.publicKey, initial);
  f.setTime(initial + 60_000);
  const recovered = await f.open().result(f.proof('result'));
  assert.deepEqual(verifyTemporaryCompletion(recovered.completion, { envelope: f.ticket.envelope,
    claim: f.claim, expectedInstance: f.identity, now: f.clock() }), result);
  assert.throws(() => verifyTemporaryCompletion(null, { envelope: f.ticket.envelope, claim: f.claim,
    expectedInstance: f.identity, now: f.clock() }), (error) => error.code === 'temporary_broker_receipt_invalid');
  assert.throws(() => verifyTemporaryCompletion({ ...recovered.completion, payload: { result: { ...result, accessExpiresAt: initial + 700_000 } } },
    { envelope: f.ticket.envelope, claim: f.claim, expectedInstance: f.identity, now: f.clock() }));
  assert.equal((await f.open().result(f.proof('result'))).status, 'COMPLETED');
  assert.equal((await f.pc.claim(forwarded.claim)).grant.grantId, result.grantId);
  assert.equal((await f.state()).temporaryPairingExchanges[0].sealedToken, null);
  assert.equal((await f.state()).accountDevices, undefined);
  assert.equal((await f.state()).accountCredentials, undefined);
});

test('registry never contains plaintext ticket; ciphertext is bound to original exchange', async (t) => {
  const f = await fixture(t); await f.register(); await f.broker.claim(f.claim);
  assert.equal((await readFile(f.file, 'utf8')).includes(f.ticket.token), false);
  const r = (await f.state()).temporaryPairingExchanges[0];
  const context = JSON.stringify([r.instanceId, r.invitationId, r.claim.requestId]);
  assert.equal(f.cipher.open(r.sealedToken, context), f.ticket.token);
  assert.throws(() => f.cipher.open(r.sealedToken, context + 'changed'));
  assert.throws(() => f.cipher.open({ ...r.sealedToken, tag: randomBytes(16).toString('base64url') }, context));
  assert.throws(() => f.cipher.open({ ...r.sealedToken, data: randomBytes(40).toString('base64url') }, context));
});

test('unbound computer, substituted instance key and edited registration are denied', async (t) => {
  const f = await fixture(t);
  const invalid = f.proof('register', { envelope: f.ticket.envelope }); invalid.instanceId = id('inst');
  await rejects(f.broker.register(invalid), 'temporary_broker_instance_unavailable');
  const tampered = f.proof('register', { envelope: f.ticket.envelope }); tampered.payload.envelope = structuredClone(f.ticket.envelope);
  tampered.payload.envelope.invitation.capabilities = ['task.read'];
  await assert.rejects(f.broker.register(tampered));
  await f.store.mutate((d) => { d.instanceBindings[0].instanceKeyFingerprint = '0'.repeat(64); });
  await rejects(f.register(), 'temporary_broker_instance_unavailable');
});

test('HTTP action, body, request identity and nonce are covered by a fresh proof', async (t) => {
  const f = await fixture(t); await f.register();
  const original = f.proof('inbox'); await f.broker.inbox(original);
  await rejects(f.open().inbox(original), 'temporary_broker_proof_replayed');
  await rejects(f.broker.revoke(f.proof('inbox')), 'temporary_broker_proof_invalid');
  const bodyChanged = f.proof('inbox'); bodyChanged.payload = { surprise: 'changed' };
  await rejects(f.broker.inbox(bodyChanged), 'temporary_broker_proof_invalid');
  const idChanged = f.proof('inbox'); idChanged.requestId = id('rtr');
  await rejects(f.broker.inbox(idChanged), 'temporary_broker_proof_invalid');
  await rejects(f.broker.inbox(f.proof('inbox', {}, { issuedAt: initial - 30_000 })), 'temporary_broker_proof_invalid');
});

test('only a new result proof by the original device can fetch completion metadata', async (t) => {
  const f = await fixture(t); await f.register(); await f.broker.claim(f.claim);
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await rejects(f.broker.result(f.proof('result', {}, {}, other)), 'temporary_broker_proof_invalid');
  await rejects(f.broker.result({ ...f.claim, payload: {} }), 'temporary_broker_proof_invalid');
  const poll = f.proof('result'); assert.equal((await f.broker.result(poll)).completion, null);
  await rejects(f.broker.result(poll), 'temporary_broker_proof_replayed');
});

test('competing devices cannot replace the claim and exact retry keeps its deadline', async (t) => {
  const f = await fixture(t); await f.register(); await f.broker.claim(f.claim);
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const claim = { ...f.claim, devicePublicKey: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  claim.signature = sign('sha256', Buffer.from(buildTemporaryClaimMessage(claim)), other.privateKey).toString('base64url');
  await rejects(f.broker.claim(claim), 'temporary_broker_already_claimed');
  f.setTime(initial + 180_000);
  assert.equal((await f.open().claim(f.claim)).accessExpiresAt, initial + 600_000);
  const forwarded = await f.broker.inbox(f.proof('inbox'));
  // Broker recovery does not permit first-time PC redemption after the actual invitation deadline.
  await rejects(f.pc.claim(forwarded.claim), 'temporary_pairing_inactive');
});

test('original PC acceptance can be recovered after claim window without another grant', async (t) => {
  const f = await fixture(t); await f.register(); await f.broker.claim(f.claim);
  const accepted = await f.pc.claim((await f.broker.inbox(f.proof('inbox'))).claim);
  f.setTime(initial + 180_000);
  const again = await f.pc.claim((await f.open().inbox(f.proof('inbox'))).claim);
  assert.equal(again.grant.grantId, accepted.grant.grantId);
  await f.open().complete(f.proof('complete', { result: { ...again.grant, requestId: f.claim.requestId, accessExpiresAt: again.accessExpiresAt } }));
  assert.equal((await f.broker.result(f.proof('result'))).status, 'COMPLETED');
});

test('completion rejects credential fields, device substitution and changed results', async (t) => {
  const f = await fixture(t); await f.register(); await f.broker.claim(f.claim);
  const accepted = await f.pc.claim(f.claim);
  const result = { ...accepted.grant, requestId: f.claim.requestId, accessExpiresAt: accepted.accessExpiresAt };
  for (const patch of [{ token: 'do-not-store' }, { accessExpiresAt: initial + 600_001 },
    { deviceKeyFingerprint: '0'.repeat(64) }, { requestId: id('rtr') }, { grantedAt: initial + 120_000 }]) {
    await rejects(f.broker.complete(f.proof('complete', { result: { ...result, ...patch } })), 'temporary_broker_result_invalid');
  }
  await f.broker.complete(f.proof('complete', { result }));
  await f.open().complete(f.proof('complete', { result }));
  await rejects(f.broker.complete(f.proof('complete', { result: { ...result, grantId: id('rtg') } })), 'temporary_broker_result_conflict');
});

test('expiration is committed before errors and clock rollback cannot resurrect a claim', async (t) => {
  const f = await fixture(t); await f.register(); await f.broker.claim(f.claim);
  f.setTime(initial + 600_000);
  await rejects(f.broker.result(f.proof('result')), 'temporary_broker_inactive');
  f.setTime(initial);
  await rejects(f.open().claim(f.claim), 'temporary_broker_inactive');
  const r = (await f.state()).temporaryPairingExchanges[0];
  assert.equal(r.status, 'EXPIRED'); assert.equal(r.sealedToken, null);
});

test('revocation and account rebinding invalidate the exchange durably', async (t) => {
  const f = await fixture(t); await f.register(); await f.broker.claim(f.claim);
  await f.store.mutate((d) => { d.instanceBindings[0].boundAt = new Date(initial + 1).toISOString(); });
  await rejects(f.broker.claim(f.claim), 'temporary_broker_inactive');
  await f.store.mutate((d) => { d.instanceBindings[0].boundAt = new Date(initial).toISOString(); });
  await rejects(f.open().claim(f.claim), 'temporary_broker_inactive');
  assert.equal((await f.state()).temporaryPairingExchanges[0].sealedToken, null);
  const g = await fixture(t); await g.register(); await g.broker.claim(g.claim);
  assert.equal((await g.broker.revoke(g.proof('revoke'))).status, 'REVOKED');
  await rejects(g.open().inbox(g.proof('inbox')), 'temporary_broker_inactive');
});

test('encryption-key rotation supports old keys and a holder can repair encrypted pending delivery', async (t) => {
  const f = await fixture(t); await f.register(); await f.broker.claim(f.claim);
  const next = { activeKeyId: 'next', keys: { next: randomBytes(32).toString('base64') } };
  const withOld = f.open({ ...next, keys: { ...next.keys, ...f.keys.keys } });
  assert.equal((await withOld.inbox(f.proof('inbox'))).claim.token, f.ticket.token);
  const rotated = f.open(next);
  await rejects(rotated.inbox(f.proof('inbox')), 'temporary_broker_claim_unavailable');
  await rotated.claim(f.claim);
  assert.equal((await rotated.inbox(f.proof('inbox'))).claim.token, f.ticket.token);
});

test('actual Accounts HTTP routes work without Google configuration and return no-store errors', async (t) => {
  const f = await fixture(t);
  const app = await createAccountsServer({ dataFile: f.file, store: f.store, publicBaseUrl: 'http://127.0.0.1/test',
    signingKeyFile: join(f.root, 'signing.json'), turnBrokerSigningKeyFile: join(f.root, 'turn.json'),
    allowInsecurePublicBaseUrl: true, temporaryPairingKeyRing: f.keys, clock: f.clock,
    verifyGoogleCredential: () => { throw new Error('Must not use Google'); },
    verifyNativeGoogleCredential: () => { throw new Error('Must not use Google'); },
  });
  const server = createServer(async (req, res) => {
    if (!await app.handler(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const call = async (action, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/test/v1/temporary-pairing/${action}`, {
      method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await call('register', f.proof('register', { envelope: f.ticket.envelope }))).status, 201);
  assert.equal((await call('claim', f.claim)).status, 200);
  const forwarded = (await call('inbox', f.proof('inbox'))).value;
  const accepted = await f.pc.claim(forwarded.claim);
  assert.equal((await call('complete', f.proof('complete', { result: { ...accepted.grant,
    requestId: f.claim.requestId, accessExpiresAt: accepted.accessExpiresAt } }))).status, 200);
  const result = (await call('result', f.proof('result'))).value;
  assert.equal(result.completion.payload.result.grantId, accepted.grant.grantId);
  assert.equal((await call('revoke', f.proof('revoke'))).status, 200);
  assert.equal((await call('result', f.proof('result'))).status, 410);
  assert.equal((await call('claim', undefined, 'GET')).status, 405);
  assert.equal((await call('claim', '{broken')).status, 400);
  assert.equal((await call('claim', 'x'.repeat(17000))).status, 413);
  assert.equal((await call('unknown', {})).status, 404);
});

test('unconfigured deployments keep temporary routes unavailable and never generate a secret implicitly', async (t) => {
  const f = await fixture(t);
  const app = await createAccountsServer({ dataFile: f.file, store: f.store, publicBaseUrl: 'https://accounts.example.test',
    signingKeyFile: join(f.root, 'disabled-signing.json'), turnBrokerSigningKeyFile: join(f.root, 'disabled-turn.json') });
  assert.equal(app.temporaryBroker, null);
  const req = Readable.from([Buffer.from(JSON.stringify(f.claim))]); req.method = 'POST'; req.url = '/v1/temporary-pairing/claim';
  let status; let result;
  await app.handler(req, { writeHead: (code) => { status = code; }, end: (text) => { result = JSON.parse(text); } });
  assert.equal(status, 503); assert.equal(result.code, 'temporary_broker_unavailable');
  assert.equal((await f.state()).temporaryPairingExchanges, undefined);
  await assert.rejects(createAccountsServer({ dataFile: f.file, store: f.store, publicBaseUrl: 'http://accounts.example.test',
    signingKeyFile: join(f.root, 'disabled-signing.json'), turnBrokerSigningKeyFile: join(f.root, 'disabled-turn.json'),
    temporaryPairingKeyRing: f.keys }), /fixed HTTPS/);
});

test('pending registration expiry, nonce saturation and malformed stored versions fail closed', async (t) => {
  const f = await fixture(t); await f.register();
  await f.store.mutate((d) => { d.temporaryPairingExchanges[0].nonces = Array.from({ length: 128 }, (_, n) => ({ nonceHash: String(n), expiresAt: initial + 30_000 })); });
  await rejects(f.broker.inbox(f.proof('inbox')), 'temporary_broker_proof_capacity');
  f.setTime(initial + 30_000);
  assert.equal((await f.broker.inbox(f.proof('inbox'))).status, 'REGISTERED');
  f.setTime(initial + 120_000);
  await rejects(f.broker.claim(f.claim), 'temporary_broker_inactive');
  f.setTime(initial);
  await rejects(f.open().claim(f.claim), 'temporary_broker_inactive');
  await f.store.mutate((d) => { d.temporaryPairingExchanges[0].version = 2; });
  await rejects(f.open().claim(f.claim), 'temporary_broker_store_invalid');
});
