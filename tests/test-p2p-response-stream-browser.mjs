import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { RagentP2PClient, P2PResponseStreamAssembler } from '../static/p2p/ragent-p2p-client.js';

function frames(id, text) {
  const payload = Buffer.from(JSON.stringify({ type: 'http_response', id, status: 200, bodyBase64: Buffer.from(text).toString('base64') }));
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const result = [];
  for (let offset = 0, index = 0; offset < payload.length; offset += 24 * 1024, index++) {
    result.push({ type: 'http_response_stream_v1', id, index, totalBytes: payload.length, sha256,
      dataBase64: payload.subarray(offset, offset + 24 * 1024).toString('base64') });
  }
  return result;
}

test('reassembles interleaved responses and releases their reservations', async () => {
  const assembler = new P2PResponseStreamAssembler();
  const a = frames('request-a', 'a'.repeat(80_000));
  const b = frames('request-b', 'b'.repeat(60_000));
  let resultA, resultB;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) resultA = await assembler.add(a[i]) || resultA;
    if (b[i]) resultB = await assembler.add(b[i]) || resultB;
  }
  assert.equal(Buffer.from(resultA.bodyBase64, 'base64').toString(), 'a'.repeat(80_000));
  assert.equal(Buffer.from(resultB.bodyBase64, 'base64').toString(), 'b'.repeat(60_000));
  assert.equal(assembler.reserved, 0);
});

test('rejects out-of-order or altered streams and frees reserved memory', async () => {
  const assembler = new P2PResponseStreamAssembler();
  const stream = frames('request-a', 'a'.repeat(50_000));
  await assembler.add(stream[0]);
  await assert.rejects(assembler.add({ ...stream[1], index: 2 }), /Invalid response stream/);
  assert.equal(assembler.reserved, 0);
  const broken = frames('request-b', 'b'.repeat(30_000)).map((frame) => ({ ...frame, sha256: '0'.repeat(64) }));
  for (const frame of broken.slice(0, -1)) await assembler.add(frame);
  await assert.rejects(assembler.add(broken.at(-1)), /Invalid response stream/);
  assert.equal(assembler.reserved, 0);
});

test('bounds aggregate response allocations and rejects oversized frames', async () => {
  const assembler = new P2PResponseStreamAssembler();
  const initial = { type: 'http_response_stream_v1', index: 0, totalBytes: 9 * 1024 * 1024,
    sha256: '0'.repeat(64), dataBase64: Buffer.alloc(24 * 1024).toString('base64') };
  await assembler.add({ ...initial, id: 'first' });
  await assembler.add({ ...initial, id: 'second' });
  await assert.rejects(assembler.add({ ...initial, id: 'third' }), /Invalid response stream/);
  await assert.rejects(assembler.add({ ...initial, id: 'oversized', totalBytes: 13 * 1024 * 1024 }), /Invalid response stream/);
  assembler.clear();
  assert.equal(assembler.reserved, 0);
});

test('browser preserves business IDs in headers and frees partial streams on timeout', async () => {
  const client = new RagentP2PClient({ signalingUrl: '', roomId: '', secret: '', requestTimeoutMs: 40 });
  let sent;
  client.channel = { readyState: 'open', send(value) { sent = JSON.parse(value); }, close() {} };
  const pending = client.request({ method: 'POST', path: '/fixture', requestId: 'business:id', idempotencyKey: 'business:id' });
  assert.notEqual(sent.id, 'business:id');
  assert.match(sent.id, /^[A-Za-z0-9_-]+$/);
  assert.equal(sent.headers['X-Ragent-Request-Id'], 'business:id');
  assert.equal(sent.headers['Idempotency-Key'], 'business:id');
  assert.equal(sent.acceptResponseStream, true);
  await client.responseStreams.add(frames(sent.id, 'a'.repeat(40_000))[0]);
  assert.ok(client.responseStreams.reserved > 0);
  await assert.rejects(pending, /timed out/);
  assert.equal(client.responseStreams.reserved, 0);
  client.close();
});
