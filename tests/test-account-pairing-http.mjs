import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAccountsServer } from '../accounts/server.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-account-pairing-http-'));
try {
  for (const enabled of [false, true]) {
    const app = await createAccountsServer({ dataFile: join(root, `state-${enabled}.json`),
      signingKeyFile: join(root, `key-${enabled}.json`), publicBaseUrl: 'http://localhost/accounts',
      allowInsecurePublicBaseUrl: true, verifyGoogleCredential: async () => ({ sub: 'unused' }),
      temporaryPairingKeyRing: enabled ? { activeKeyId: 'test', keys: { test: randomBytes(32).toString('base64') } } : undefined });
    const server = http.createServer(async (req, res) => {
      if (!await app.handler(req, res)) { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/accounts/v1/account-pairing`;
    try {
      const response = await fetch(`${base}/register`, { method: 'POST', body: '{}' });
      assert.equal(response.status, enabled ? 403 : 503);
      assert.equal((await response.json()).code, enabled ? 'account_pairing_source_unbound' : 'account_pairing_unavailable');
      assert.match(response.headers.get('cache-control'), /no-store/);
      assert.equal((await fetch(`${base}/register`)).status, 405);
      assert.equal((await fetch(`${base}/arbitrary`, { method: 'POST', body: '{}' })).status, 404);
      if (enabled) {
        const malformed = await fetch(`${base}/claim`, { method: 'POST', body: '[]' });
        assert.equal(malformed.status, 400);
        const oversized = await fetch(`${base}/claim`, { method: 'POST', body: 'x'.repeat(16 * 1024 + 1) });
        assert.equal(oversized.status, 413);
      }
    } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  }
  console.log('test-account-pairing-http: passed');
} finally {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  await rm(root, { recursive: true, force: true });
}
