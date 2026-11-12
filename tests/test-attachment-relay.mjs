import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentRelay } from '../accounts/attachment-relay.mjs';
import { startAccountsServer } from '../accounts/server.mjs';
import { randomBytes } from 'node:crypto';
import { createAccountsLogger } from '../accounts/log.mjs';
import { openRelayAsset } from '../chat/file-asset-relay-receiver.mjs';
import { encryptRelayRecord, relayWireBytes } from '../chat/file-asset-relay-crypto.mjs';

class Response extends PassThrough {
  writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
}
function request(size) { const req = new PassThrough(); req.headers = { 'content-length': String(size) }; return req; }
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
function v2Ticket(relay, deadline, sizeBytes = 10) {
  return { epoch: relay.capabilities().epoch, id: randomBytes(16).toString('hex'), deadline, sizeBytes,
    writeToken: randomBytes(32).toString('base64url'), readToken: randomBytes(32).toString('base64url') };
}

test('v2 capability fields are redacted from structured account logs', () => {
  let output = '';
  const sink = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const logger = createAccountsLogger({ stream: sink });
  logger.info({ writeToken: 'writer-secret', readToken: 'reader-secret', payload: {
    writeToken: 'nested-writer-secret', readToken: 'nested-reader-secret' } });
  assert.ok(!output.includes('writer-secret') && !output.includes('reader-secret'));
  assert.ok(output.includes('[redacted]'));
});

test('relays opaque bytes with separate single-use capabilities and no staging files', async () => {
  const relay = createAttachmentRelay();
  const data = Buffer.alloc(1024 * 1024, 0x5a), ticket = relay.reserve('account', data.length);
  const denied = new Response(); denied.resume(); relay.attachReader(ticket.id, ticket.writeToken, denied);
  assert.equal(denied.statusCode, 404);
  const reader = new Response(), readerBody = collect(reader), writer = request(data.length);
  const writerResponse = new Response(); writerResponse.resume();
  relay.attachWriter(ticket.id, ticket.writeToken, writer, writerResponse);
  relay.attachReader(ticket.id, ticket.readToken, reader);
  writer.end(data);
  assert.deepEqual(await readerBody, data);
  if (!writerResponse.writableEnded) await once(writerResponse, 'finish');
  assert.equal(writerResponse.statusCode, 204);
  const replay = new Response(); replay.resume(); relay.attachReader(ticket.id, ticket.readToken, replay);
  assert.equal(replay.statusCode, 404);
  relay.close();
});

test('enforces capacity, length and expiry and releases reservations', async () => {
  const relay = createAttachmentRelay({ maxTransferBytes: 10, maxReservedBytes: 10, maxTransfers: 1, ttlMs: 30 });
  assert.throws(() => relay.reserve('a', 11));
  const ticket = relay.reserve('a', 10);
  assert.throws(() => relay.reserve('b', 1));
  const wrong = request(9), response = new Response(); response.resume();
  relay.attachWriter(ticket.id, ticket.writeToken, wrong, response);
  assert.equal(response.statusCode, 400);
  await new Promise(resolve => setTimeout(resolve, 45));
  const expired = new Response(); expired.resume(); relay.attachReader(ticket.id, ticket.readToken, expired);
  assert.equal(expired.statusCode, 404);
  assert.ok(relay.reserve('b', 10));
  relay.close();
});

test('only the writer capability can cancel and release relay capacity', () => {
  const relay = createAttachmentRelay({ maxTransferBytes: 10, maxReservedBytes: 10, maxTransfers: 1 });
  try {
    const ticket = relay.reserve('a', 10);
    assert.equal(relay.cancel(ticket.id, ticket.readToken), false);
    assert.equal(relay.cancel(ticket.id, 'wrong-token'), false);
    assert.throws(() => relay.reserve('b', 10), /capacity/);
    const waiting = new Response(); waiting.resume();
    relay.attachReader(ticket.id, ticket.readToken, waiting);
    assert.equal(relay.cancel(ticket.id, ticket.writeToken), true);
    assert.equal(waiting.statusCode, 410);
    assert.equal(relay.cancel(ticket.id, ticket.writeToken), false);
    assert.ok(relay.reserve('b', 10));
  } finally { relay.close(); }
});

test('cancelling an active relay aborts both ends and releases capacity', async () => {
  const relay = createAttachmentRelay({ maxTransferBytes: 10, maxReservedBytes: 10, maxTransfers: 1 });
  try {
    const ticket = relay.reserve('a', 10);
    const reader = new Response(), writer = request(10), writerResponse = new Response();
    reader.resume(); writerResponse.resume();
    relay.attachReader(ticket.id, ticket.readToken, reader);
    relay.attachWriter(ticket.id, ticket.writeToken, writer, writerResponse);
    writer.write(Buffer.alloc(2));
    assert.equal(relay.cancel(ticket.id, ticket.writeToken), true);
    assert.equal(writerResponse.statusCode, 410);
    assert.ok(writer.destroyed);
    assert.ok(relay.reserve('b', 10));
    await new Promise(resolve => setImmediate(resolve));
  } finally { relay.close(); }
});

test('v2 reserve is idempotent and preemptive cancellation fences late requests', () => {
  let now = 1000;
  const relay = createAttachmentRelay({ ttlMs: 100, maxTransferBytes: 10, maxReservedBytes: 10,
    maxTransfers: 1, clock: () => now });
  try {
    const first = v2Ticket(relay, 1100);
    const cancel = ({ epoch, id, deadline, writeToken }) => ({ epoch, id, deadline, writeToken });
    assert.equal(relay.cancelV2('owner', cancel(first)), true);
    assert.throws(() => relay.reserveV2('owner', first), /fenced/);
    const second = v2Ticket(relay, 1100);
    assert.deepEqual(relay.reserveV2('owner', second), relay.reserveV2('owner', second));
    assert.throws(() => relay.reserveV2('other', second), /conflict/);
    assert.equal(relay.cancelV2('other', cancel(second)), false);
    assert.equal(relay.cancelV2('owner', { ...cancel(second), writeToken: randomBytes(32).toString('base64url') }), false);
    assert.equal(relay.cancelV2('owner', cancel(second)), true);
    assert.equal(relay.cancelV2('owner', cancel(second)), true);
    assert.throws(() => relay.reserveV2('owner', second), /fenced/);
    now = 1101;
    assert.throws(() => relay.reserveV2('owner', second), /Expired/);
  } finally { relay.close(); }
});

test('v2 fence saturation fails closed and a restart rejects the old epoch', () => {
  let now = 1000;
  const relay = createAttachmentRelay({ ttlMs: 100, maxFences: 1, clock: () => now });
  const nextRelay = createAttachmentRelay({ ttlMs: 100, maxFences: 1, clock: () => now });
  try {
    const first = v2Ticket(relay, 1100), second = v2Ticket(relay, 1100), third = v2Ticket(relay, 1100);
    const cancel = ({ epoch, id, deadline, writeToken }) => ({ epoch, id, deadline, writeToken });
    assert.equal(relay.cancelV2('a', cancel(first)), true);
    assert.equal(relay.cancelV2('a', cancel(second)), true);
    assert.throws(() => relay.reserveV2('b', third), /capacity/);
    assert.throws(() => nextRelay.reserveV2('a', first), /Invalid/);
    now = 1101;
    assert.throws(() => relay.reserveV2('a', second), /Expired/);
    assert.ok(relay.reserveV2('b', v2Ticket(relay, 1150)));
  } finally { relay.close(); nextRelay.close(); }
});

test('v2 rejects malformed credentials, long deadlines, and oversized reservations', () => {
  const now = 1000;
  const relay = createAttachmentRelay({ ttlMs: 100, maxTransferBytes: 10, clock: () => now });
  try {
    const valid = v2Ticket(relay, 1100);
    for (const invalid of [
      { ...valid, deadline: 1101 }, { ...valid, deadline: 1000 },
      { ...valid, sizeBytes: 11 }, { ...valid, sizeBytes: 0 },
      { ...valid, id: 'invalid' }, { ...valid, epoch: '0'.repeat(32) },
      { ...valid, writeToken: 'short' }, { ...valid, readToken: valid.writeToken },
    ]) assert.throws(() => relay.reserveV2('account', invalid));
    assert.ok(relay.reserveV2('account', valid));
  } finally { relay.close(); }
});

test('v2 completion fences a delayed reservation retry', async () => {
  const relay = createAttachmentRelay({ maxTransferBytes: 10, maxReservedBytes: 10, maxTransfers: 1 });
  try {
    const ticket = v2Ticket(relay, Date.now() + 60000);
    relay.reserveV2('a', ticket);
    const reader = new Response(), body = collect(reader), writer = request(10), response = new Response();
    response.resume();
    relay.attachReader(ticket.id, ticket.readToken, reader);
    relay.attachWriter(ticket.id, ticket.writeToken, writer, response);
    writer.end(Buffer.alloc(10, 0x23));
    assert.deepEqual(await body, Buffer.alloc(10, 0x23));
    if (!response.writableEnded) await once(response, 'finish');
    assert.equal(response.statusCode, 204);
    assert.throws(() => relay.reserveV2('a', ticket), /fenced/);
    assert.ok(relay.reserveV2('a', v2Ticket(relay, Date.now() + 60000)));
  } finally { relay.close(); }
});

test('v2 deadline fences new attempts without shortening or preventing cancellation of an active transfer', () => {
  let now = 1000;
  const relay = createAttachmentRelay({ ttlMs: 100, maxTransferBytes: 10, clock: () => now });
  try {
    const ticket = v2Ticket(relay, 1010), writer = request(10), reader = new Response(), response = new Response();
    reader.resume(); response.resume();
    relay.reserveV2('a', ticket);
    relay.attachReader(ticket.id, ticket.readToken, reader);
    relay.attachWriter(ticket.id, ticket.writeToken, writer, response);
    now = 1011;
    assert.throws(() => relay.reserveV2('a', ticket), /Expired/);
    assert.equal(relay.cancelV2('a', { epoch: ticket.epoch, id: ticket.id,
      deadline: ticket.deadline, writeToken: ticket.writeToken }), true);
    assert.equal(response.statusCode, 410);
  } finally { relay.close(); }
});

test('v2 HTTP cancellation overtakes an authenticated but delayed reservation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentoc-relay-race-'));
  let app, release;
  const gate = new Promise(resolve => { release = resolve; });
  let arrived;
  const started = new Promise(resolve => { arrived = resolve; });
  try {
    app = await startAccountsServer({ host: '127.0.0.1', port: 0, logger: { level: 'silent' },
      dataFile: join(dir, 'accounts.json'), signingKeyFile: join(dir, 'signing.json'),
      turnBrokerSigningKeyFile: join(dir, 'turn-signing.json'), attachmentRelayEnabled: true });
    app.broker.authenticateAccountAsr = async ({ credential }) => {
      if (credential === 'slow') { arrived(); await gate; }
      else if (credential !== 'fast') throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
      return { accountId: 'same-account' };
    };
    const prefix = '/v1/owner-auth/account/attachment-relay';
    const caps = (await app.fastify.inject({ method: 'GET', url: `${prefix}/capabilities`,
      headers: { authorization: 'Bearer fast' } })).json();
    const ticket = { epoch: caps.epoch, id: randomBytes(16).toString('hex'), deadline: Date.now() + 60000,
      sizeBytes: 100, writeToken: randomBytes(32).toString('base64url'), readToken: randomBytes(32).toString('base64url') };
    const pending = app.fastify.inject({ method: 'POST', url: `${prefix}/reservations-v2`,
      headers: { authorization: 'Bearer slow' }, payload: ticket });
    await started;
    const cancellation = await app.fastify.inject({ method: 'POST', url: `${prefix}/reservations-v2/cancel`,
      headers: { authorization: 'Bearer fast' }, payload: { epoch: ticket.epoch, id: ticket.id,
        deadline: ticket.deadline, writeToken: ticket.writeToken } });
    assert.equal(cancellation.statusCode, 204);
    release();
    assert.equal((await pending).statusCode, 409);
    const next = { ...ticket, id: randomBytes(16).toString('hex'),
      writeToken: randomBytes(32).toString('base64url'), readToken: randomBytes(32).toString('base64url') };
    assert.equal((await app.fastify.inject({ method: 'POST', url: `${prefix}/reservations-v2`,
      headers: { authorization: 'Bearer fast' }, payload: next })).statusCode, 201);
  } finally {
    release();
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('opt-in Accounts routes stream data with separately scoped bearer capabilities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentoc-relay-test-'));
  let app;
  try {
    app = await startAccountsServer({ host: '127.0.0.1', port: 0, logger: { level: 'silent' },
      dataFile: join(dir, 'accounts.json'), signingKeyFile: join(dir, 'signing.json'),
      turnBrokerSigningKeyFile: join(dir, 'turn-signing.json'), attachmentRelayEnabled: true });
    app.broker.authenticateAccountAsr = async ({ credential }) => {
      if (credential !== 'valid-test-account') throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
      return { accountId: 'test-account' };
    };
    const reservation = await app.fastify.inject({ method: 'POST', url: '/v1/owner-auth/account/attachment-relay/reservations',
      headers: { authorization: 'Bearer valid-test-account' }, payload: { sizeBytes: 1024 * 1024 } });
    assert.equal(reservation.statusCode, 201);
    const ticket = reservation.json(), data = Buffer.alloc(ticket.size, 0x57);
    const base = `http://127.0.0.1:${app.server.address().port}/v1/owner-auth/account/attachment-relay/${ticket.id}/content`;
    const read = fetch(base, { headers: { authorization: `Bearer ${ticket.readToken}` } });
    const write = fetch(base, { method: 'PUT', headers: { authorization: `Bearer ${ticket.writeToken}`,
      'content-type': 'application/vnd.agentoc.attachment-relay' }, body: data });
    const [received, sent] = await Promise.all([read, write]);
    assert.equal(received.status, 200); assert.equal(sent.status, 204);
    assert.deepEqual(Buffer.from(await received.arrayBuffer()), data);
    const replay = await fetch(base, { headers: { authorization: `Bearer ${ticket.readToken}` } });
    assert.equal(replay.status, 404);
    const second = (await app.fastify.inject({ method: 'POST', url: '/v1/owner-auth/account/attachment-relay/reservations',
      headers: { authorization: 'Bearer valid-test-account' }, payload: { sizeBytes: 100 } })).json();
    const cancelPath = `/v1/owner-auth/account/attachment-relay/reservations/${second.id}`;
    assert.equal((await app.fastify.inject({ method: 'DELETE', url: cancelPath,
      headers: { authorization: `Bearer ${second.readToken}` } })).statusCode, 404);
    assert.equal((await app.fastify.inject({ method: 'DELETE', url: cancelPath,
      headers: { authorization: `Bearer ${second.writeToken}` } })).statusCode, 204);
    assert.equal((await app.fastify.inject({ method: 'DELETE', url: cancelPath,
      headers: { authorization: `Bearer ${second.writeToken}` } })).statusCode, 404);
    const capabilityPath = '/v1/owner-auth/account/attachment-relay/capabilities';
    assert.equal((await app.fastify.inject({ method: 'GET', url: capabilityPath })).statusCode, 401);
    const caps = (await app.fastify.inject({ method: 'GET', url: capabilityPath,
      headers: { authorization: 'Bearer valid-test-account' } })).json();
    assert.equal(caps.version, 2);
    const candidate = { epoch: caps.epoch, id: randomBytes(16).toString('hex'), deadline: Date.now() + 60000,
      sizeBytes: 100, writeToken: randomBytes(32).toString('base64url'), readToken: randomBytes(32).toString('base64url') };
    const v2Path = '/v1/owner-auth/account/attachment-relay/reservations-v2';
    const cancelV2 = ({ epoch, id, deadline, writeToken }) => ({ epoch, id, deadline, writeToken });
    const v2 = await app.fastify.inject({ method: 'POST', url: v2Path,
      headers: { authorization: 'Bearer valid-test-account' }, payload: candidate });
    assert.equal(v2.statusCode, 201);
    assert.ok(!v2.body.includes(candidate.writeToken) && !v2.body.includes(candidate.readToken));
    assert.equal((await app.fastify.inject({ method: 'POST', url: v2Path,
      headers: { authorization: 'Bearer valid-test-account' }, payload: candidate })).statusCode, 201);
    assert.equal((await app.fastify.inject({ method: 'POST', url: `${v2Path}/cancel`,
      headers: { authorization: 'Bearer valid-test-account' }, payload: cancelV2(candidate) })).statusCode, 204);
    assert.equal((await app.fastify.inject({ method: 'POST', url: v2Path,
      headers: { authorization: 'Bearer valid-test-account' }, payload: candidate })).statusCode, 409);
    const cancelledFirst = { ...candidate, id: randomBytes(16).toString('hex'),
      writeToken: randomBytes(32).toString('base64url'), readToken: randomBytes(32).toString('base64url') };
    assert.equal((await app.fastify.inject({ method: 'POST', url: `${v2Path}/cancel`,
      headers: { authorization: 'Bearer valid-test-account' }, payload: cancelV2(cancelledFirst) })).statusCode, 204);
    assert.equal((await app.fastify.inject({ method: 'POST', url: v2Path,
      headers: { authorization: 'Bearer valid-test-account' }, payload: cancelledFirst })).statusCode, 409);
    const plaintext = Buffer.from('v2 encrypted transfer fixture');
    const key = randomBytes(32), transferId = randomBytes(16).toString('hex');
    const live = { ...candidate, id: randomBytes(16).toString('hex'), sizeBytes: relayWireBytes(plaintext.length),
      writeToken: randomBytes(32).toString('base64url'), readToken: randomBytes(32).toString('base64url') };
    assert.equal((await app.fastify.inject({ method: 'POST', url: v2Path,
      headers: { authorization: 'Bearer valid-test-account' }, payload: live })).statusCode, 201);
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const receiving = openRelayAsset({ accountsBaseUrl: 'https://accounts.example', relayId: live.id,
      readToken: live.readToken, key, transferId, totalBytes: plaintext.length,
      fetchImpl: (url, options) => fetch(`${origin}${new URL(url).pathname}`, options) });
    const encrypted = encryptRelayRecord({ key, transferId, totalBytes: plaintext.length, index: 0, plaintext });
    const sending = fetch(`${origin}/v1/owner-auth/account/attachment-relay/${live.id}/content`, {
      method: 'PUT', headers: { authorization: `Bearer ${live.writeToken}`,
        'content-type': 'application/vnd.agentoc.attachment-relay' }, body: encrypted });
    assert.deepEqual(await collect(await receiving), plaintext);
    assert.equal((await sending).status, 204);
    assert.equal((await app.fastify.inject({ method: 'POST', url: v2Path,
      headers: { authorization: 'Bearer valid-test-account' }, payload: live })).statusCode, 409);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
