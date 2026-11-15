import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReviewProviderAccessReader, refreshReviewProviderThroughBroker } from '../lib/review-provider-access.mjs';

const token = exp => `fixture.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.fixture`;
const now = 1_800_000_000_000;
let auth = { tokens: { account_id: 'owner-fixture', access_token: token(now / 1000 + 3600), refresh_token: 'never-expose-refresh' } };
let refreshes = 0;
const reader = createReviewProviderAccessReader({ expectedAccountId: 'owner-fixture', now: () => now,
  readAuth: async () => auth, refreshOwner: async () => {
    refreshes++; await new Promise(resolve => setTimeout(resolve, 10));
    auth = { tokens: { ...auth.tokens, access_token: token(now / 1000 + 7200) } };
  },
});
const first = await reader(); assert.deepEqual(Object.keys(first).sort(), ['accessToken', 'accountId']); assert.equal(refreshes, 0);
auth.tokens.access_token = token(now / 1000 - 1);
const results = await Promise.all(Array.from({ length: 8 }, () => reader()));
assert.equal(refreshes, 1); assert.ok(results.every(r => r.accessToken === auth.tokens.access_token));
assert.equal(JSON.stringify(results).includes('never-expose-refresh'), false);
auth.tokens.account_id = 'replacement-owner';
await assert.rejects(reader(), { code: 'review_provider_owner_unavailable' });
assert.equal(refreshes, 1, 'Identity mismatch cannot trigger a refresh');
const rejected = createReviewProviderAccessReader({ expectedAccountId: 'owner-fixture', now: () => now,
  readAuth: async () => ({ tokens: { account_id: 'owner-fixture', access_token: token(now / 1000 - 1) } }),
  refreshOwner: async () => { throw new Error('private refresh credential'); },
});
await assert.rejects(rejected(), e => e.code === 'review_provider_owner_unavailable' && !e.message.includes('private'));
const stale = createReviewProviderAccessReader({ expectedAccountId: 'owner-fixture', now: () => now,
  readAuth: async () => ({ tokens: { account_id: 'owner-fixture', access_token: token(now / 1000 - 1) } }), refreshOwner: async () => {},
});
await assert.rejects(stale(), { code: 'review_provider_owner_unavailable' });

const socket = process.platform === 'win32' ? String.raw`\\.\pipe\ragent-review-owner-${randomUUID()}` : join(tmpdir(), `review-owner-${randomUUID()}.sock`);
let calls = 0;
const server = createServer(client => {
  let text = '';
  client.on('data', chunk => {
    text += chunk;
    if (!text.includes('\n')) return;
    const message = JSON.parse(text.trim());
    assert.deepEqual(message, { id: 1, method: 'account/read', params: { refreshToken: true } }); calls++;
    client.end(JSON.stringify({ id: 1, result: { account: { type: 'chatgpt', email: 'not-returned@example.test' } } }) + '\n');
  });
});
server.listen(socket); await once(server, 'listening');
try {
  assert.equal(await refreshReviewProviderThroughBroker(socket), undefined);
  assert.equal(calls, 1);
} finally { await new Promise(resolve => server.close(resolve)); }
await assert.rejects(refreshReviewProviderThroughBroker(socket, { timeoutMs: 100 }), { code: 'review_provider_owner_unavailable' });
console.log('PASS access-only projection, account pin, expiry rejection, deduplicated renewal and fixed account/read IPC; no process or refresh credential created');
