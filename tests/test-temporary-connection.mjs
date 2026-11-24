import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { fixture, initial, id } from './helpers/temporary-turn-fixture.mjs';
import { TemporaryConnectionService } from '../chat/temporary-connection-service.mjs';
import { TemporaryPairingHost } from '../chat/temporary-pairing-host.mjs';
import { TemporaryPairingRegistry } from '../chat/temporary-pairing-registry.mjs';
import { verifyTemporaryConnectionContract, verifyTemporaryP2PAccess, temporaryContractSigningPayload } from '../lib/temporary-connection-contract.mjs';
import { signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { verifyConnectionBootstrapContract } from '../lib/connection-bootstrap-contract.mjs';
import { requestTurnCredentials } from '../lib/turn-credential-broker-client.mjs';
import { createConnectivityPolicyEngine } from '../lib/connectivity-policy-engine.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';

const signalingEndpoint = 'https://signal.example.test/signal';
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function service(f, host = f.host, extras = {}) {
  const result = new TemporaryConnectionService({ host, brokerUrl: f.turnUrl, signalingEndpoint, clock: f.clock, ...extras });
  host.connectionService = result; return result;
}
async function facts(f, phone) {
  const row = (await f.registry.deliverySnapshot((await f.host.context()).bindingStamp)).records
    .find((r) => r.grant?.grantId === phone.result.grantId);
  return { envelope: row.envelope, grant: row.grant, credential: phone.accessCredential, expectedInstance: f.identity, now: f.clock() };
}

test('PC prepares a signed temporary contract through Accounts and TURN HTTP without account enrollment', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); service(f);
  const result = await f.host.prepareConnection(phone.claim.invitationId);
  const contract = verifyTemporaryConnectionContract(result.bootstrap, await facts(f, phone));
  assert.equal(contract.contractVersion, 3); assert.equal(contract.enrollmentKind, 'temporary-device');
  assert.equal(contract.connectionMode, 'turn-first'); assert.equal(contract.initialCarrier.kind, 'turn');
  assert.notEqual(contract.allowDirectIce, true, 'temporary bootstrap contracts must never allow direct ICE');
  assert.equal(contract.fallback, null); assert.deepEqual(contract.candidates.map((c) => c.kind), ['turn', 'webrtc']);
  assert.equal(contract.temporaryAccess.grantId, phone.result.grantId);
  assert.equal(Date.parse(contract.expiresAt), initial + 595_000);
  assert.equal(Date.parse(contract.temporaryAccess.expiresAt), phone.accessCredential.expires_at);
  assert.deepEqual(verifyTemporaryP2PAccess(contract, result.p2p), result.p2p);
  assert.equal(verifyConnectionBootstrapContract(contract, f.identity.publicKey, { nowMs: f.clock() }).valid, false);
  assert.equal(JSON.stringify(contract).includes(result.p2p.secret), false);
  assert.equal(JSON.stringify(await f.host.list()).includes(result.p2p.secret), false);
  assert.equal(result.carrierReady, false); assert.equal(result.businessAccessReady, false);
});

test('concurrent preparation and cold reopening retain the same room and signed credentials', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const s = service(f);
  const [a, b] = await Promise.all([s.prepare(phone.claim.invitationId), s.prepare(phone.claim.invitationId)]);
  assert.deepEqual(a, b); assert.equal(f.mintCalls.length, 1);
  const registry = new TemporaryPairingRegistry({ filePath: f.registry.filePath, identity: f.identity, clock: f.clock });
  const host = new TemporaryPairingHost({ registry, client: f.client, binding: async () => f.binding, clock: f.clock });
  const fresh = service(f, host); f.advance(20_000);
  assert.deepEqual(await fresh.prepare(phone.claim.invitationId), a); assert.equal(f.mintCalls.length, 1);
  assert.equal((await f.store.mutate((d) => d.turnConnectionLeases)).length, 1);
});

test('contract verification rejects altered routes, permissions, enrollment and correctly re-signed invalid structure', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const result = await service(f).prepare(phone.claim.invitationId);
  const context = await facts(f, phone);
  const mutations = [
    (c) => { c.enrollmentKind = 'account-claim'; },
    (c) => { c.temporaryAccess.grantId = id('rtg'); },
    (c) => { c.temporaryAccess.capabilities.push('owner'); },
    (c) => { c.fallback = { endpoint: 'https://foreign.test' }; },
    (c) => { c.initialCarrier.kind = 'webrtc'; },
    (c) => { c.turn.accessExpiresAt = new Date(initial + 900_000).toISOString(); },
    (c) => { c.candidates[1].endpoint = 'http://signal.test/signal'; },
    (c) => { c.candidates[1].expiresAt = new Date(initial + 900_000).toISOString(); },
    (c) => { c.turnAuthorization.authorized = false; },
    (c) => { c.turn.iceServers[0].urls = 'https://foreign.test'; },
    (c) => { c.extra = 'unsupported'; },
  ];
  for (const mutate of mutations) {
    const c = structuredClone(result.bootstrap); mutate(c);
    assert.throws(() => verifyTemporaryConnectionContract(c, context));
    c.signature.value = signWithInstanceIdentity(f.identity, temporaryContractSigningPayload(c));
    assert.throws(() => verifyTemporaryConnectionContract(c, context));
  }
  const route = structuredClone(result.bootstrap); route.candidates[1].endpoint = 'https://foreign.test/signal';
  assert.throws(() => verifyTemporaryConnectionContract(route, context));
  assert.throws(() => verifyTemporaryP2PAccess(result.bootstrap, { ...result.p2p, secret: '0'.repeat(64) }));
});

test('revocation during TURN IO prevents contract persistence and later recovery', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const entered = deferred(); const finish = deferred();
  const s = service(f, f.host, { mint: async (input) => { const turn = await requestTurnCredentials(input); entered.resolve(); await finish.promise; return turn; } });
  const pending = s.prepare(phone.claim.invitationId); await entered.promise;
  await f.host.revoke(phone.claim.invitationId); finish.resolve();
  await assert.rejects(pending, { code: 'temporary_connection_inactive' });
  const state = JSON.parse(await readFile(f.registry.filePath, 'utf8'));
  assert.equal(state.records[0].connection.bootstrap, undefined);
  await assert.rejects(s.prepare(phone.claim.invitationId), { code: 'temporary_connection_inactive' });
});

test('expiry, binding changes and shutdown during IO withhold connection material', async (t) => {
  for (const reason of ['expiry', 'binding', 'shutdown']) {
    const f = await fixture(t); const phone = await f.enroll(); let s;
    s = service(f, f.host, { mint: async (input) => {
      const turn = await requestTurnCredentials(input);
      if (reason === 'expiry') f.advance(600_000);
      if (reason === 'binding') f.binding.boundAt = new Date(initial + 1).toISOString();
      if (reason === 'shutdown') f.host.close();
      return turn;
    } });
    await assert.rejects(s.prepare(phone.claim.invitationId));
    assert.equal(JSON.parse(await readFile(f.registry.filePath, 'utf8')).records[0].connection.bootstrap, undefined);
  }
});

test('prepared contracts expire and cannot be restored by a rolled-back clock', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const s = service(f);
  const result = await s.prepare(phone.claim.invitationId); const context = await facts(f, phone);
  f.advance(595_000);
  assert.throws(() => verifyTemporaryConnectionContract(result.bootstrap, { ...context, now: f.clock() }));
  await assert.rejects(s.prepare(phone.claim.invitationId), { code: 'turn_broker_temporary_expiring' });
  assert.equal(f.mintCalls.length, 1);
  f.advance(5_000); await assert.rejects(s.prepare(phone.claim.invitationId));
  f.advance(-600_000); await assert.rejects(s.prepare(phone.claim.invitationId));
});

test('unsigned persisted corruption fails closed without minting replacement credentials', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const s = service(f);
  await s.prepare(phone.claim.invitationId);
  const state = JSON.parse(await readFile(f.registry.filePath, 'utf8'));
  state.records[0].connection.bootstrap.turn.iceServers[0].password = 'tampered';
  await writeFile(f.registry.filePath, JSON.stringify(state));
  await assert.rejects(s.prepare(phone.claim.invitationId), { code: 'temporary_pairing_store_invalid' });
  assert.equal(f.mintCalls.length, 1);
});

test('unconfirmed exchange cannot allocate a room or TURN quota', async (t) => {
  const f = await fixture(t); const ticket = await f.host.create(); const s = service(f);
  await assert.rejects(s.prepare(ticket.envelope.invitation.invitationId), { code: 'temporary_connection_inactive' });
  assert.equal(f.mintCalls.length, 0);
  assert.equal(JSON.parse(await readFile(f.registry.filePath, 'utf8')).records[0].connection, undefined);
});

function carrier() {
  const ready = deferred(); const done = deferred(); let stops = 0;
  return { ready, done, get stops() { return stops; },
    handle: { ready: ready.promise, done: done.promise, stop() { stops += 1; done.resolve(); } } };
}

test('activation starts one relay-only host with the closed temporary policy and revoke stops it', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const c = carrier(); c.ready.resolve(); let starts = 0; let options;
  const s = service(f, f.host, { startCarrier: async (o) => { starts += 1; options = o; return c.handle; } });
  const [a, b] = await Promise.all([s.activate(phone.claim.invitationId), s.activate(phone.claim.invitationId)]);
  assert.equal(a.carrierReady, true); assert.equal(a.businessAccessReady, false); assert.deepEqual(a, b);
  assert.equal(starts, 1); assert.equal(options.relayOnly, true); assert.equal(options.temporaryDevice.grantId, phone.result.grantId);
  assert.equal(options.expiresAt, a.bootstrap.expiresAt); assert.deepEqual(options.iceServers, a.bootstrap.turn.iceServers);
  const policy = createConnectivityPolicyEngine({ temporaryDevice: options.temporaryDevice });
  for (const req of [
    { method: 'GET', url: '/api/sessions', headers: { authorization: `Bearer rda_${'a'.repeat(64)}` } },
    { method: 'POST', url: '/api/auth/google/token', headers: {} },
    { method: 'GET', url: '/healthz', headers: { 'x-ragent-browser-principal': 'browser' } },
    { method: 'POST', url: '/api/sessions', headers: { authorization: `DPoP ${phone.accessCredential.access_token}` } },
  ]) assert.equal(policy.decide(req).reason, 'temporary_business_not_ready');
  await f.host.revoke(phone.claim.invitationId);
  assert.ok(c.stops >= 1); assert.equal(s.carriers.size, 0);
  await assert.rejects(s.activate(phone.claim.invitationId)); s.close();
});

test('late host creation or readiness cannot restore a revoked connection', async (t) => {
  for (const stage of ['factory', 'ready']) {
    const f = await fixture(t); const phone = await f.enroll(); const c = carrier(); const entered = deferred(); const release = deferred();
    const s = service(f, f.host, { startCarrier: async () => { entered.resolve(); if (stage === 'factory') await release.promise; return c.handle; } });
    const pending = s.activate(phone.claim.invitationId); const rejected = assert.rejects(pending);
    await entered.promise; await f.host.revoke(phone.claim.invitationId); release.resolve(); c.ready.resolve();
    await rejected; assert.ok(c.stops >= 1); assert.equal(s.carriers.size, 0); s.close();
  }
});

test('running carrier closes when the grant expires or account binding changes', async (t) => {
  for (const reason of ['expiry', 'binding']) {
    const f = await fixture(t); const phone = await f.enroll(); const c = carrier(); c.ready.resolve();
    const s = service(f, f.host, { startCarrier: async () => c.handle });
    await s.activate(phone.claim.invitationId);
    if (reason === 'expiry') f.advance(600_000); else f.binding.boundAt = new Date(initial + 1).toISOString();
    for (let i = 0; i < 40 && !c.stops; i += 1) await sleep(50);
    assert.ok(c.stops >= 1); assert.equal(s.carriers.size, 0); s.close();
  }
});

test('host failure and service shutdown cannot leave active temporary handles', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const c = carrier(); const entered = deferred();
  const s = service(f, f.host, { startCarrier: async () => { entered.resolve(); return c.handle; } });
  const pending = s.activate(phone.claim.invitationId); const rejected = assert.rejects(pending);
  await entered.promise; c.done.resolve(); await rejected;
  assert.equal(s.carriers.size, 0);
  c.ready.resolve(); s.close(); await assert.rejects(s.activate(phone.claim.invitationId));
});

test('actual host loopback proxy denies temporary requests before the upstream server', async () => {
  let forwarded = 0;
  const server = createServer((req, res) => { forwarded += 1; res.end('upstream'); });
  const ws = new WebSocketServer({ server, path: '/signal' });
  ws.on('connection', (socket) => socket.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'join') socket.send(JSON.stringify({ type: 'joined', roomId: m.roomId, role: m.role }));
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let agent;
  try {
    agent = await runP2PHostAgent({ signalingUrl: `http://127.0.0.1:${server.address().port}/signal`,
      localBaseUrl: `http://127.0.0.1:${server.address().port}`, roomId: 'a'.repeat(40), secret: 'fixture-only-secret',
      binaryPath: process.execPath, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      temporaryDevice: { grantId: id('rtg') }, relayOnly: true,
      iceServers: [{ urls: 'turn:fixture.invalid:3478', username: 'fixture', password: 'fixture' }] });
    await agent.ready;
    for (const path of ['/api/sessions', '/api/device-auth/challenges', '/api/auth/google/token']) {
      const response = await fetch(`${agent.gatewayUrl}${path}`, { method: 'POST',
        headers: { authorization: `Bearer rda_${'a'.repeat(64)}`, 'x-ragent-browser-principal': 'browser' } });
      assert.equal(response.status, 403); await response.text();
    }
    assert.equal(forwarded, 0);
  } finally {
    agent?.stop(); await agent?.done;
    for (const client of ws.clients) client.terminate(); ws.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
