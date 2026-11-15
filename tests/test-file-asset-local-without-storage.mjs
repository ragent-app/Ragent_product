import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-local-asset-'));
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
for (const key of ['RAGENT_ASSET_STORAGE_BASE_URL', 'RAGENT_ASSET_STORAGE_PUBLIC_BASE_URL',
  'RAGENT_ASSET_STORAGE_ACCESS_KEY_ID', 'RAGENT_ASSET_STORAGE_SECRET_ACCESS_KEY']) delete process.env[key];
const assets = await import('../chat/file-assets.mjs');
const bytes = Buffer.from('a,b\n1,2\n');
const input = { sessionId: 'session-a', requestId: 'local-test', originalName: 'first.csv',
  mimeType: 'text/csv', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
try {
  const intent = await assets.createFileAssetUploadIntent(input);
  assert.equal(intent.upload.method, 'POST');
  assert.match(intent.upload.url, /^\/api\/assets\/fasset_[a-f0-9]{24}\/upload$/);
  assert.equal((await assets.createFileAssetUploadIntent(input)).asset.id, intent.asset.id);
  await assert.rejects(assets.createFileAssetUploadIntent({ ...input, requestId: 'remote-test', forceRemote: true }),
    { code: 'FILE_ASSET_STORAGE_DISABLED' });
} finally {
  await rm(root, { recursive: true, force: true });
}
