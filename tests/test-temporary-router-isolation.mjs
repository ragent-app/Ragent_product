import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

// Run with --test-force-exit: importing the production router starts long-lived service timers.

test('production router rejects temporary requests before local-owner and public dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-router-'));
  process.env.RAGENT_CONFIG_DIR = join(root, 'config');
  process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
  delete process.env.RAGENT_INSTANCE_ROOT;
  try {
    const { handleRequest } = await import('../chat/router.mjs');
    for (const url of ['/api/sessions', '/api/assets/upload-intents', '/api/auth/google/token', '/', '/healthz']) {
      for (const identity of ['wire', 'internal', 'mixed']) {
        const req = new PassThrough(); req.method = 'POST'; req.url = url;
        req.headers = identity === 'wire' ? { authorization: 'DPoP opaque', cookie: 'owner=existing' }
          : identity === 'mixed' ? { authorization: 'Bearer old', dpop: 'proof' } : {};
        if (identity === 'internal') req._bearerAuthSession = { role: 'owner', principalKind: 'temporary_device' };
        req.end('{}');
        const res = { writeHead(status, headers) { this.status = status; this.headers = headers; },
          end(body) { this.body = JSON.parse(body); } };
        await handleRequest(req, res);
        assert.equal(res.status, 403); assert.equal(res.body.code, 'temporary_business_not_ready');
        assert.match(res.headers['Cache-Control'], /no-store/);
      }
    }
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});
