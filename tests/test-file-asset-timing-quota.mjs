import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

test('quota timing observes failure and retry without changing verified receipt behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-timing-quota-'));
  process.env.AGENTOC_INSTANCE_ROOT = root;
  process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
  process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
  process.env.AGENTOC_ACCOUNTS_URL = 'https://accounts.example';
  process.env.AGENTOC_ATTACHMENT_TIMING = '1';
  for (const key of ['AGENTOC_MEMORY_DIR', 'AGENTOC_RUN_SPOOL_DIR', 'AGENTOC_PROVIDER_HOMES_DIR',
    'AGENTOC_WORK_ROOT_DIR', 'AGENTOC_PLATFORM_SKILLS_DIR', 'AGENTOC_INSTANCE_KEY_FILE',
    'AGENTOC_ASSET_STORAGE_BASE_URL', 'AGENTOC_ASSET_STORAGE_ACCESS_KEY_ID', 'AGENTOC_ASSET_STORAGE_SECRET_ACCESS_KEY']) delete process.env[key];
  const originalFetch = globalThis.fetch, originalError = console.error, timings = [];
  console.error = (...args) => { if (String(args[0]).startsWith('[attachment-timing] ')) timings.push(String(args[0])); };
  try {
    const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
    const { ingestFileAssetUpload } = await import('../chat/file-assets.mjs');
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'owner-account-binding.json'), JSON.stringify({ accountId: 'acct-test' }));
    let completions = 0;
    globalThis.fetch = async url => {
      if (String(url).endsWith('/complete') && ++completions === 1) throw new Error('private upstream failure');
      return new Response(JSON.stringify({ tracked: true, duplicate: false }), { status: 200 });
    };
    async function route(pathname, payload, fileAssetRoute = null) {
      const req = new PassThrough(); req.method = 'POST'; req.headers = {}; req.end(JSON.stringify(payload));
      const res = { setHeader() {} };
      assert.equal(await handleControlRoutes({ req, res, pathname, parsedUrl: { query: {} }, fileAssetRoute,
        authSession: { role: 'owner' }, requireSessionAccess: async () => true,
        writeJson: (_res, status, body) => Object.assign(res, { status, body }) }), true);
      return res;
    }
    const bytes = Buffer.from('confidential test content');
    const intent = await route('/api/assets/combined-upload-intents', { sessionId: 's', requestId: 'timing-request',
      quotaBatchId: 'timing-batch', originalName: 'private-name.bin', mimeType: 'application/octet-stream',
      sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    assert.equal(intent.status, 200);
    const assetId = intent.body.asset.id;
    await ingestFileAssetUpload(assetId, Readable.from(bytes));
    const path = `/api/assets/${assetId}/finalize`, routeInfo = { assetId, action: 'finalize' };
    assert.notEqual((await route(path, { sizeBytes: bytes.length }, routeInfo)).status, 200);
    const retry = await route(path, { sizeBytes: bytes.length }, routeInfo);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.asset.status, 'ready');
    const records = timings.map(line => JSON.parse(line.slice('[attachment-timing] '.length)));
    assert.deepEqual(records.filter(row => row.stage === 'quota_complete').map(row => row.outcome), ['error', 'ok']);
    assert.equal(new Set(records.map(row => row.correlation)).size, 1);
    assert.ok(timings.every(line => !line.includes(assetId) && !line.includes('private') && !line.includes('acct-test')));
  } finally {
    globalThis.fetch = originalFetch; console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});
