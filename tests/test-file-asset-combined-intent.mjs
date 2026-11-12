import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

test('combined upload intent is owner-only, idempotent and returns the same contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-combined-intent-'));
  process.env.AGENTOC_INSTANCE_ROOT = root;
  process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
  process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
  process.env.AGENTOC_ACCOUNTS_URL = 'https://accounts.example';
  for (const key of ['AGENTOC_MEMORY_DIR','AGENTOC_RUN_SPOOL_DIR','AGENTOC_PROVIDER_HOMES_DIR',
    'AGENTOC_WORK_ROOT_DIR','AGENTOC_PLATFORM_SKILLS_DIR','AGENTOC_INSTANCE_KEY_FILE',
    'AGENTOC_ASSET_STORAGE_BASE_URL','AGENTOC_ASSET_STORAGE_ACCESS_KEY_ID','AGENTOC_ASSET_STORAGE_SECRET_ACCESS_KEY']) delete process.env[key];
  const nativeFetch = globalThis.fetch;
  try {
    const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
    async function route(pathname, method, payload, authSession = { role: 'owner' }, headers = {}) {
      const req = new PassThrough(); req.method = method; req.headers = headers;
      req.end(payload ? JSON.stringify(payload) : undefined);
      const res = { setHeader() {} };
      const handled = await handleControlRoutes({ req, res, pathname, parsedUrl: { query: {} }, authSession,
        requireSessionAccess: async () => true,
        writeJson: (_res, status, body) => Object.assign(res, { status, body }) });
      assert.equal(handled, true);
      return res;
    }
    const bytes = Buffer.from('fixture');
    const payload = { sessionId: 's', requestId: 'combined-test', quotaBatchId: 'batch',
      originalName: 'fixture.bin', mimeType: 'application/octet-stream', sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), resumableChunkBytes: 1048576 };
    const path = '/api/assets/combined-upload-intents';
    assert.equal((await route(path, 'POST', payload, { role: 'visitor' })).status, 403);
    assert.equal((await route(path, 'POST', payload, { role: 'owner' }, { 'x-agentoc-app-api-scope': 'untrusted' })).status, 403);
    assert.equal((await route(path, 'POST', { ...payload, sha256: undefined })).status, 400);
    const contract = await route('/api/asset-upload-contract', 'GET');
    const first = await route(path, 'POST', payload);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.combinedUploadContract, contract.body);
    assert.equal(first.body.uploadContractVersion, 1);
    const second = await route(path, 'POST', payload);
    assert.equal(second.status, 200);
    assert.equal(second.body.asset.id, first.body.asset.id);
    assert.equal((await route(path, 'POST', { ...payload, sha256: '0'.repeat(64) })).status, 409);
    // Exercise the same route with a bound account and idempotent quota reserve.
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'owner-account-binding.json'), JSON.stringify({ accountId: 'acct-test' }));
    const calls = [];
    let unlimited = false;
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ tracked: true, duplicate: calls.length > 1,
        ...(unlimited ? { limits: { unlimited: true, maxFileBytes: Number.MAX_SAFE_INTEGER } } : {}) }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const bound = { ...payload, requestId: 'bound-combined' };
    const boundFirst = await route(path, 'POST', bound);
    const boundAgain = await route(path, 'POST', bound);
    assert.equal(boundFirst.status, 200);
    assert.equal(boundAgain.body.asset.id, boundFirst.body.asset.id);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.url.endsWith('/instances/uploads/reserve')));
    assert.ok(calls.every(call => call.body.requestId === bound.requestId && call.body.sha256 === bound.sha256));
    // The combined route must preserve the installed account-policy behavior
    // without a second policy round trip after an authoritative reservation.
    unlimited = true;
    const unlimitedIntent = await route(path, 'POST', { ...payload, requestId: 'unlimited-combined' });
    assert.equal(unlimitedIntent.status, 200);
    assert.equal(unlimitedIntent.body.combinedUploadContract.maximumBytes, Number.MAX_SAFE_INTEGER);
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = nativeFetch; await rm(root, { recursive: true, force: true }); }
});
