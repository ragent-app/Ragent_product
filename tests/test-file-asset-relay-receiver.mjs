import test from 'node:test';
import assert from 'node:assert/strict';
import { openRelayAsset } from '../chat/file-asset-relay-receiver.mjs';
import { encryptRelayRecord } from '../chat/file-asset-relay-crypto.mjs';

const key = Buffer.alloc(32, 7), transferId = '00112233445566778899aabbccddeeff';
const relayId = 'ffeeddccbbaa99887766554433221100', readToken = 'A'.repeat(43);
const args = { accountsBaseUrl: 'https://accounts.example/base', relayId, readToken, key, transferId, totalBytes: 5 };

test('instance fetches only the configured HTTPS Accounts origin and authenticates data', async () => {
  const frame = encryptRelayRecord({ key, transferId, totalBytes: 5, index: 0, plaintext: Buffer.from('hello') });
  let call;
  const fetchImpl = async (url, options) => { call = { url: String(url), options };
    return new Response(frame, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(frame.length) } }); };
  const stream = await openRelayAsset({ ...args, fetchImpl });
  const parts = []; for await (const part of stream) parts.push(part);
  assert.equal(Buffer.concat(parts).toString(), 'hello');
  assert.equal(call.url, `https://accounts.example/base/v1/owner-auth/account/attachment-relay/${relayId}/content`);
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers.Authorization, `Bearer ${readToken}`);
});

test('instance rejects arbitrary or malformed destinations and unverified ciphertext', async () => {
  const never = () => { throw new Error('Unexpected network call'); };
  await assert.rejects(openRelayAsset({ ...args, accountsBaseUrl: 'http://accounts.example', fetchImpl: never }));
  await assert.rejects(openRelayAsset({ ...args, relayId: '../other', fetchImpl: never }));
  await assert.rejects(openRelayAsset({ ...args, readToken: 'short', fetchImpl: never }));
  const frame = encryptRelayRecord({ key, transferId, totalBytes: 5, index: 0, plaintext: Buffer.from('hello') });
  frame[20] ^= 1;
  const stream = await openRelayAsset({ ...args, fetchImpl: async () => new Response(frame,
    { headers: { 'content-type': 'application/octet-stream', 'content-length': String(frame.length) } }) });
  await assert.rejects(async () => { for await (const _ of stream) {} });
});
