import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentRelay } from '../accounts/attachment-relay.mjs';
import { startAccountsServer } from '../accounts/server.mjs';

class Response extends PassThrough {
  writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
}
function request(size) { const req = new PassThrough(); req.headers = { 'content-length': String(size) }; return req; }
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }

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
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
