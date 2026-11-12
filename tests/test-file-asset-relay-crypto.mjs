import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptRelayRecord, decryptRelayStream, encryptRelayRecord, relayWireBytes, RELAY_RECORD_BYTES } from '../chat/file-asset-relay-crypto.mjs';

const key = Buffer.alloc(32, 1);
const transferId = '00112233445566778899aabbccddeeff';

test('relay record interoperates with the Android reference vector', () => {
  const parameters = { key, transferId, totalBytes: 5, index: 0 };
  const frame = encryptRelayRecord({ ...parameters, plaintext: Buffer.from('hello'), nonce: Buffer.alloc(12, 2) });
  assert.equal(frame.toString('hex'), '00000000000000050202020202020202020202026fb3a52525a5efdcb24413d8812b0dc2cb4e822b73');
  assert.deepEqual(decryptRelayRecord({ ...parameters, frame }), Buffer.from('hello'));
});

test('relay rejects tampering, wrong identity, key, record order and lengths', () => {
  const p = { key, transferId, totalBytes: RELAY_RECORD_BYTES + 3, index: 1 };
  const frame = encryptRelayRecord({ ...p, plaintext: Buffer.from('end') });
  for (const offset of [0, 4, 8, 20, frame.length - 1]) {
    const bad = Buffer.from(frame); bad[offset] ^= 1;
    assert.throws(() => decryptRelayRecord({ ...p, frame: bad }));
  }
  assert.throws(() => decryptRelayRecord({ ...p, key: Buffer.alloc(32, 2), frame }));
  assert.throws(() => decryptRelayRecord({ ...p, transferId: '10112233445566778899aabbccddeeff', frame }));
  assert.throws(() => decryptRelayRecord({ ...p, index: 0, frame }));
  assert.throws(() => decryptRelayRecord({ ...p, totalBytes: p.totalBytes + 1, frame }));
  assert.throws(() => decryptRelayRecord({ ...p, frame: frame.subarray(0, -1) }));
  assert.throws(() => encryptRelayRecord({ ...p, plaintext: Buffer.alloc(2) }));
});

test('stream accepts arbitrary HTTP chunk boundaries and rejects truncation and trailing data', async () => {
  const totalBytes = RELAY_RECORD_BYTES + 7;
  const data = Buffer.alloc(totalBytes, 42);
  const parameters = { key, transferId, totalBytes };
  const wire = Buffer.concat([encryptRelayRecord({ ...parameters, index: 0, plaintext: data.subarray(0, RELAY_RECORD_BYTES) }),
    encryptRelayRecord({ ...parameters, index: 1, plaintext: data.subarray(RELAY_RECORD_BYTES) })]);
  assert.equal(wire.length, relayWireBytes(totalBytes));
  async function* pieces(buf) { for (let i = 0; i < buf.length; i += 731) yield buf.subarray(i, i + 731); }
  async function decode(buf) { const result = []; for await (const part of decryptRelayStream(pieces(buf), parameters)) result.push(part); return Buffer.concat(result); }
  assert.deepEqual(await decode(wire), data);
  await assert.rejects(decode(wire.subarray(0, -1)), /incomplete/);
  await assert.rejects(decode(Buffer.concat([wire, Buffer.from([1])])), /trailing/);
});
