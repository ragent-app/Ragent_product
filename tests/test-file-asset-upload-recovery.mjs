import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = process.env.AGENTOC_UPLOAD_TEST_ROOT || await mkdtemp(join(tmpdir(), 'agentoc-upload-recovery-'));
process.env.AGENTOC_INSTANCE_ROOT = root;
process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
for (const key of ['AGENTOC_MEMORY_DIR', 'AGENTOC_RUN_SPOOL_DIR', 'AGENTOC_PROVIDER_HOMES_DIR',
  'AGENTOC_WORK_ROOT_DIR', 'AGENTOC_PLATFORM_SKILLS_DIR', 'AGENTOC_INSTANCE_KEY_FILE']) delete process.env[key];

const bytes = Buffer.from('手机分享附件\nExample CSV\na,b\n1,2\n');
const sha256 = createHash('sha256').update(bytes).digest('hex');
let remoteBytes = bytes;
let remoteStatus = 200;
let remoteReads = 0;
const storage = createServer((req, res) => {
  remoteReads += 1;
  res.writeHead(remoteStatus, remoteStatus === 302 ? { Location: 'http://127.0.0.1:1/untrusted' } : {});
  res.end(remoteBytes);
});
await new Promise((done) => storage.listen(0, '127.0.0.1', done));
process.env.AGENTOC_ASSET_STORAGE_BASE_URL = `http://127.0.0.1:${storage.address().port}/bucket`;
process.env.AGENTOC_ASSET_STORAGE_ACCESS_KEY_ID = 'fixture-access';
process.env.AGENTOC_ASSET_STORAGE_SECRET_ACCESS_KEY = 'fixture-secret';
process.env.AGENTOC_ASSET_STORAGE_PROVIDER = 's3';
process.env.AGENTOC_ASSET_STORAGE_REGION = 'fixture';
process.env.AGENTOC_ASSET_DIRECT_UPLOAD_ENABLED = '0';
delete process.env.AGENTOC_ASSET_STORAGE_PUBLIC_BASE_URL;
const assets = await import('../chat/file-assets.mjs');
const { MAX_STABLE_UPLOAD_BYTES } = await import('../chat/file-asset-upload-checkpoints.mjs');
const { CHAT_FILE_ASSETS_DIR } = await import('../lib/config.mjs');
assert.equal(resolve(CHAT_FILE_ASSETS_DIR), resolve(join(root, 'config', 'file-assets')),
  'Tests must use their isolated instance, including on Windows');
const input = { sessionId: 'session-a', requestId: 'capture-one:file-one', quotaBatchId: 'message-a', originalName: '销售.csv',
  mimeType: 'text/csv', sizeBytes: bytes.length, sha256 };

if (process.argv[2] === 'restart') {
  const receipt = await assets.findFileAssetUploadReceipt(input);
  assert.equal(receipt.asset.status, 'ready');
  const replay = await assets.createFileAssetUploadIntent(input);
  assert.equal(replay.asset.id, receipt.asset.id);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.upload, null);
  console.log(JSON.stringify({ id: receipt.asset.id, updatedAt: receipt.asset.updatedAt }));
  storage.close();
} else {
  try {
    assert.equal(await assets.findFileAssetUploadReceipt(input), null);
    const parallel = await Promise.all(Array.from({ length: 8 }, () => assets.createFileAssetUploadIntent(input)));
    const first = parallel.find((result) => !result.duplicate);
    assert.ok(first);
    assert.equal(parallel.filter((result) => !result.duplicate).length, 1);
    assert.equal(new Set(parallel.map((result) => result.asset.id)).size, 1);
    assert.equal(first.uploadContractVersion, 1);
    assert.equal(first.upload.method, 'POST');
    const pending = await assets.findFileAssetUploadReceipt(input);
    assert.equal(pending.asset.status, 'pending_upload');
  assert.equal(pending.quotaBatchId, input.quotaBatchId, 'The message batch survives durable upload recovery');
    assert.equal(pending.upload, undefined);
    assert.equal(pending.asset.directUrl, undefined);
    assert.equal(pending.asset.uploadRequest, undefined);
    for (const change of [{ originalName: 'another.csv' }, { mimeType: 'application/json' },
      { sizeBytes: bytes.length + 1 }, { sha256: 'f'.repeat(64) }]) {
      await assert.rejects(assets.createFileAssetUploadIntent({ ...input, ...change }),
        { code: 'FILE_ASSET_IDEMPOTENCY_CONFLICT', statusCode: 409 });
    }
    for (const change of [{ requestId: '' }, { requestId: null }, { requestId: 42 }, { requestId: 'a'.repeat(201) },
      { originalName: '' }, { sha256: 'no-digest' }, { sizeBytes: '7' }, { sizeBytes: 0 }, { sizeBytes: MAX_STABLE_UPLOAD_BYTES + 1 }]) {
      await assert.rejects(assets.createFileAssetUploadIntent({ ...input, ...change }), { code: 'INVALID_ARGUMENT' });
    }
    const otherSession = await assets.createFileAssetUploadIntent({ ...input, sessionId: 'session-b' });
    const otherPrincipal = await assets.createFileAssetUploadIntent({ ...input, principalScope: 'other-owner' });
    const otherRequest = await assets.createFileAssetUploadIntent({ ...input, requestId: 'capture-two:file-one' });
    assert.equal(new Set([first, otherSession, otherPrincipal, otherRequest].map((result) => result.asset.id)).size, 4);
    await assert.rejects(assets.ingestFileAssetUpload(first.asset.id, Readable.from([Buffer.alloc(bytes.length + 1)])),
      { code: 'FILE_ASSET_SIZE_MISMATCH' });
    await assert.rejects(assets.ingestFileAssetUpload(first.asset.id, Readable.from([Buffer.alloc(bytes.length)])),
      { code: 'FILE_ASSET_HASH_MISMATCH' });
    await assert.rejects(assets.ingestFileAssetUpload(first.asset.id, Readable.from([bytes.subarray(1)])),
      { code: 'FILE_ASSET_SIZE_MISMATCH' });
    assert.equal((await assets.findFileAssetUploadReceipt(input)).asset.status, 'pending_upload');
    await assets.ingestFileAssetUpload(first.asset.id, Readable.from([bytes]));
    await assert.rejects(assets.ingestFileAssetUpload(first.asset.id, Readable.from([Buffer.alloc(bytes.length)])),
      { code: 'FILE_ASSET_HASH_MISMATCH' });
    const completed = await assets.finalizeFileAssetUpload(first.asset.id, { sizeBytes: bytes.length, etag: 'fixed-etag' });
    assert.equal(completed.status, 'ready');
    assert.equal(completed.sha256, sha256);
    const disk = await assets.getFileAsset(first.asset.id);
    assert.deepEqual(await readFile(disk.localizedPath), bytes, 'Failed replacement must preserve the previous verified body');
    const doneAgain = await assets.finalizeFileAssetUpload(first.asset.id, { sizeBytes: bytes.length, etag: '"fixed-etag"' });
    assert.equal(doneAgain.updatedAt, completed.updatedAt, 'Lost finalize acknowledgement cannot rewrite its receipt');
    const finalDisk = await assets.getFileAsset(first.asset.id);
    assert.equal(finalDisk.uploadCompletedAt, disk.uploadCompletedAt);
    await assert.rejects(assets.finalizeFileAssetUpload(first.asset.id, { sizeBytes: 1 }), { code: 'FILE_ASSET_SIZE_MISMATCH' });
    await assert.rejects(assets.finalizeFileAssetUpload(first.asset.id, { etag: 'different' }),
      { code: 'FILE_ASSET_IDEMPOTENCY_CONFLICT' });
    await assert.rejects(assets.ingestFileAssetUpload(first.asset.id, Readable.from([bytes])), { code: 'FILE_ASSET_NOT_PENDING' });
    const restarted = await promisify(execFile)(process.execPath, [import.meta.filename, 'restart'],
      { env: { ...process.env, AGENTOC_UPLOAD_TEST_ROOT: root }, timeout: 30000 });
    const cold = JSON.parse(restarted.stdout.trim().split('\n').at(-1));
    assert.equal(cold.id, first.asset.id);
    assert.equal(cold.updatedAt, completed.updatedAt);

    const raced = await assets.createFileAssetUploadIntent({ ...input, requestId: 'upload-finalize-race' });
    const incoming = new PassThrough();
    const upload = assets.ingestFileAssetUpload(raced.asset.id, incoming);
    const finalize = assets.finalizeFileAssetUpload(raced.asset.id);
    const lateUpload = assets.ingestFileAssetUpload(raced.asset.id, Readable.from([bytes]));
    // Attach rejection handling before yielding to avoid an unhandled-rejection
    // window while the valid stream/finalization are still completing.
    const lateRejected = assert.rejects(lateUpload, { code: 'FILE_ASSET_NOT_PENDING' });
    incoming.end(bytes);
    await upload;
    assert.equal((await finalize).status, 'ready');
    await lateRejected;

    const remote = await assets.createFileAssetUploadIntent({ ...input, requestId: 'remote', forceRemote: true });
    assert.equal(remote.upload.method, 'PUT');
    remoteBytes = Buffer.alloc(bytes.length);
    await assert.rejects(assets.finalizeFileAssetUpload(remote.asset.id, { sizeBytes: bytes.length }),
      { code: 'FILE_ASSET_HASH_MISMATCH' });
    remoteBytes = Buffer.alloc(bytes.length + 1);
    await assert.rejects(assets.finalizeFileAssetUpload(remote.asset.id), { code: 'FILE_ASSET_SIZE_MISMATCH' });
    remoteStatus = 404;
    await assert.rejects(assets.finalizeFileAssetUpload(remote.asset.id), { code: 'FILE_ASSET_UPLOAD_UNVERIFIED' });
    remoteStatus = 302;
    await assert.rejects(assets.finalizeFileAssetUpload(remote.asset.id),
      { code: 'FILE_ASSET_UPLOAD_UNVERIFIED', statusCode: 502 });
    assert.equal((await assets.getFileAsset(remote.asset.id)).status, 'pending_upload');
    remoteStatus = 200; remoteBytes = bytes;
    assert.equal((await assets.finalizeFileAssetUpload(remote.asset.id)).status, 'ready');
    const reads = remoteReads;
    await assets.finalizeFileAssetUpload(remote.asset.id);
    assert.equal(remoteReads, reads, 'Finalize replay uses the stored verified receipt');

    const corrupt = await assets.createFileAssetUploadIntent({ ...input, requestId: 'corrupt' });
    const corruptPath = join(CHAT_FILE_ASSETS_DIR, `${corrupt.asset.id}.json`);
    await writeFile(corruptPath, '{broken');
    await assert.rejects(assets.createFileAssetUploadIntent({ ...input, requestId: 'corrupt' }),
      { code: 'FILE_ASSET_RECEIPT_UNAVAILABLE', statusCode: 503 });
    await assert.rejects(assets.findFileAssetUploadReceipt({ ...input, requestId: 'corrupt' }),
      { code: 'FILE_ASSET_RECEIPT_UNAVAILABLE' });
    assert.equal(await readFile(corruptPath, 'utf8'), '{broken', 'Corruption must not be overwritten as a new intent');
    const inconsistent = await assets.createFileAssetUploadIntent({ ...input, requestId: 'inconsistent' });
    const inconsistentPath = join(CHAT_FILE_ASSETS_DIR, `${inconsistent.asset.id}.json`);
    const inconsistentRaw = JSON.parse(await readFile(inconsistentPath, 'utf8'));
    inconsistentRaw.sessionId = 'unexpected';
    await writeFile(inconsistentPath, JSON.stringify(inconsistentRaw));
    await assert.rejects(assets.findFileAssetUploadReceipt({ ...input, requestId: 'inconsistent' }),
      { code: 'FILE_ASSET_RECEIPT_UNAVAILABLE' });
    const tampered = await assets.createFileAssetUploadIntent({ ...input, requestId: 'tampered-metadata' });
    const tamperedPath = join(CHAT_FILE_ASSETS_DIR, `${tampered.asset.id}.json`);
    const tamperedRaw = JSON.parse(await readFile(tamperedPath, 'utf8'));
    tamperedRaw.sha256 = 'a'.repeat(64);
    await writeFile(tamperedPath, JSON.stringify(tamperedRaw));
    await assert.rejects(assets.createFileAssetUploadIntent({ ...input, requestId: 'tampered-metadata' }),
      { code: 'FILE_ASSET_RECEIPT_UNAVAILABLE' });
    const invalidTimestamp = await assets.createFileAssetUploadIntent({ ...input, requestId: 'missing-timestamp' });
    const invalidTimestampPath = join(CHAT_FILE_ASSETS_DIR, `${invalidTimestamp.asset.id}.json`);
    const invalidTimestampRaw = JSON.parse(await readFile(invalidTimestampPath, 'utf8'));
    delete invalidTimestampRaw.createdAt;
    await writeFile(invalidTimestampPath, JSON.stringify(invalidTimestampRaw));
    await assert.rejects(assets.findFileAssetUploadReceipt({ ...input, requestId: 'missing-timestamp' }),
      { code: 'FILE_ASSET_RECEIPT_UNAVAILABLE' });

    // Exercise the actual router without launching a second control-plane server
    // or an Agent. The access guard is controlled and inspected independently.
    const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
    let accesses = [];
    async function route(method, payload, query = {}, auth = { role: 'owner' }, allow = true,
      pathname = '/api/assets/upload-intents') {
      const req = new PassThrough(); req.method = method; req.headers = {};
      req.end(payload ? JSON.stringify(payload) : undefined);
      const res = { status: null, body: null };
      const writeJson = (response, status, body) => { response.status = status; response.body = body; };
      assert.equal(await handleControlRoutes({ req, res, pathname,
        parsedUrl: { query }, authSession: auth, writeJson,
        requireSessionAccess: async (response, session, id) => {
          accesses.push(id);
          if (!allow) writeJson(response, 403, { error: 'Denied by session guard' });
          return allow;
        } }), true);
      return res;
    }
    const recovered = await route('GET', null, input);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.asset.id, first.asset.id);
    assert.equal(recovered.body.upload, undefined);
    assert.equal(recovered.body.asset.directUrl, undefined);
    assert.deepEqual(accesses, ['session-a']); accesses = [];
    const contract = await route('GET', null, {}, { role: 'owner' }, true, '/api/asset-upload-contract');
    assert.equal(contract.status, 200);
    assert.equal(contract.body.version, 1);
    assert.equal(contract.body.maximumBytes, MAX_STABLE_UPLOAD_BYTES);
    assert.equal(contract.body.sha256Required, true);
    assert.equal((await route('GET', null, {}, { role: 'visitor' }, true, '/api/asset-upload-contract')).status, 403);
    assert.equal((await route('GET', null, input, { role: 'visitor' })).status, 403);
    assert.equal((await route('GET', null, input, { role: 'owner', principalKind: 'run_capability' })).status, 403);
    assert.equal(accesses.length, 0, 'Unauthorized recovery must not inspect a supplied Session');
    assert.equal((await route('POST', input, {}, { role: 'owner' }, false)).status, 403);
    assert.equal((await route('POST', input, {}, { role: 'visitor' })).status, 403);
    assert.equal((await route('GET', null, { sessionId: 'session-a', requestId: 'absent' })).status, 404);
    assert.equal((await route('GET', null, { sessionId: 'session-a', requestId: [] })).status, 400);
    assert.equal((await route('POST', input)).body.upload, null);
    const conflict = await route('POST', { ...input, sha256: 'e'.repeat(64) });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'FILE_ASSET_IDEMPOTENCY_CONFLICT');
    const filesBefore = await readdir(CHAT_FILE_ASSETS_DIR);
    assert.equal((await route('POST', { ...input, requestId: 'invalid', sha256: '' })).status, 400);
    assert.deepEqual(await readdir(CHAT_FILE_ASSETS_DIR), filesBefore);

    const legacyA = await assets.createFileAssetUploadIntent({ sessionId: 'legacy', forceLocal: true });
    const legacyB = await assets.createFileAssetUploadIntent({ sessionId: 'legacy', forceLocal: true });
    assert.notEqual(legacyA.asset.id, legacyB.asset.id);
    assert.equal(legacyA.duplicate, undefined);
    console.log('Upload recovery: concurrent/cold replay, frozen identity, readonly guarded routes, local/remote byte verification and legacy compatibility passed.');
  } finally {
    await new Promise((done) => storage.close(done));
    storage.closeAllConnections();
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('agentoc-upload-recovery-'));
    await rm(root, { recursive: true, force: true });
  }
}
