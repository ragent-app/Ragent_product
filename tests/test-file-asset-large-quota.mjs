import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

test('large upload requires an unlimited account quota reservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-large-account-quota-'));
  process.env.AGENTOC_INSTANCE_ROOT = root;
  process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
  process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
  process.env.AGENTOC_ACCOUNTS_URL = 'https://accounts.example';
  for (const key of ['AGENTOC_MEMORY_DIR', 'AGENTOC_RUN_SPOOL_DIR', 'AGENTOC_PROVIDER_HOMES_DIR',
    'AGENTOC_WORK_ROOT_DIR', 'AGENTOC_PLATFORM_SKILLS_DIR', 'AGENTOC_INSTANCE_KEY_FILE',
    'AGENTOC_ASSET_STORAGE_BASE_URL', 'AGENTOC_ASSET_STORAGE_ACCESS_KEY_ID', 'AGENTOC_ASSET_STORAGE_SECRET_ACCESS_KEY']) delete process.env[key];
  const nativeFetch = globalThis.fetch;
  try {
    const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
    async function route(payload, authSession = { role: 'owner' }) {
      const req = new PassThrough(); req.method = 'POST'; req.headers = {};
      req.end(JSON.stringify(payload));
      const res = { setHeader() {} };
      const handled = await handleControlRoutes({ req, res, pathname: '/api/assets/upload-intents',
        parsedUrl: { query: {} }, authSession, requireSessionAccess: async () => true,
        writeJson: (_res, status, body) => Object.assign(res, { status, body }) });
      assert.equal(handled, true);
      return res;
    }
    async function contract(authSession = { role: 'owner' }) {
      const req = new PassThrough(); req.method = 'GET'; req.headers = {}; req.end();
      const res = { setHeader() {} };
      await handleControlRoutes({ req, res, pathname: '/api/asset-upload-contract',
        parsedUrl: { query: {} }, authSession, writeJson: (_res, status, body) => Object.assign(res, { status, body }) });
      return res;
    }
    const payload = { sessionId: 'large-session', requestId: 'large-unbound', quotaBatchId: 'large-batch',
      originalName: 'large.bin', mimeType: 'application/octet-stream', sizeBytes: 2 * 1024 * 1024 * 1024,
      sha256: 'a'.repeat(64), uploadMaximumBytes: Number.MAX_SAFE_INTEGER };
    assert.equal((await route(payload)).status, 400, 'client-provided allowance is ignored without a binding');
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'owner-account-binding.json'), JSON.stringify({ accountId: 'acct-test' }));
    let unlimited = false;
    let reservations = 0;
    globalThis.fetch = async (url) => {
      const policy = String(url).endsWith('/instances/uploads/policy');
      assert.ok(policy || String(url).endsWith('/instances/uploads/reserve'));
      if (!policy) reservations++;
      return new Response(JSON.stringify({ contractVersion: 2, tracked: true, duplicate: false,
        limits: unlimited ? { unlimited: true, maxFileBytes: Number.MAX_SAFE_INTEGER } : { maxFileBytes: 1024 * 1024 * 1024 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    };
    assert.equal((await route({ ...payload, requestId: 'large-limited' })).status, 400,
      'a reservation without unlimited authorization does not raise the transport cap');
    assert.equal((await contract()).body.maximumBytes, 1024 * 1024 * 1024);
    unlimited = true;
    assert.equal((await contract({ role: 'owner', accountId: 'acct-test' })).body.maximumBytes, Number.MAX_SAFE_INTEGER);
    assert.equal((await contract({ role: 'owner', accountId: 'acct-other' })).body.maximumBytes, 1024 * 1024 * 1024);
    assert.equal((await route({ ...payload, requestId: 'large-other' }, { role: 'owner', accountId: 'acct-other' })).status, 403);
    const result = await route({ ...payload, requestId: 'large-unlimited' }, { role: 'owner', accountId: 'acct-test' });
    assert.equal(result.status, 200);
    assert.equal(result.body.asset.sizeBytes, payload.sizeBytes);
    assert.equal(reservations, 2, 'mismatched account cannot reserve quota');
  } finally {
    globalThis.fetch = nativeFetch;
    await rm(root, { recursive: true, force: true });
  }
});
