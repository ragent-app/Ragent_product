import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable, PassThrough } from 'node:stream';

const root = process.env.AGENTOC_CHECKPOINT_TEST_ROOT || await mkdtemp(join(tmpdir(), 'agentoc-upload-checkpoints-'));
process.env.AGENTOC_INSTANCE_ROOT = root;
process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
for (const key of ['AGENTOC_MEMORY_DIR', 'AGENTOC_RUN_SPOOL_DIR', 'AGENTOC_PROVIDER_HOMES_DIR',
  'AGENTOC_WORK_ROOT_DIR', 'AGENTOC_PLATFORM_SKILLS_DIR', 'AGENTOC_INSTANCE_KEY_FILE']) delete process.env[key];
const assets = await import('../chat/file-assets.mjs');
const { FileAssetUploadCheckpoints, UPLOAD_CHUNK_BYTES: chunkBytes, UPLOAD_CHECKPOINT_TTL_MS,
  UPLOAD_CHECKPOINT_MAX_LIFETIME_MS, MAX_STABLE_UPLOAD_BYTES, uploadChunkHeaders } = await import('../chat/file-asset-upload-checkpoints.mjs');
const { CHAT_FILE_ASSETS_DIR } = await import('../lib/config.mjs');
assert.equal(resolve(CHAT_FILE_ASSETS_DIR), resolve(join(root, 'config', 'file-assets')));
const directory = join(CHAT_FILE_ASSETS_DIR, 'upload-checkpoints');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.concat([Buffer.alloc(chunkBytes, 41), Buffer.alloc(chunkBytes, 72), Buffer.from('手机附件尾部')]);
const input = { sessionId: 'checkpoint-session', originalName: 'synthetic.bin', mimeType: 'application/octet-stream',
  sizeBytes: bytes.length, sha256: hash(bytes), forceLocal: true };
let sequence = 0;
const seed = async (extra = {}) => (await assets.createFileAssetUploadIntent({ ...input,
  requestId: `checkpoint-${++sequence}`, ...extra })).asset.id;
const paths = id => ({ manifest: join(directory, `${id}.json`), body: join(directory, `${id}.part`) });
const chunk = (id, offset = 0, data = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)), options = {}) =>
  assets.appendFileAssetUploadChunk(id, Readable.from([data]), { offset, length: data.length, sha256: hash(data), ...options });
const childEnv = { ...process.env, AGENTOC_CHECKPOINT_TEST_ROOT: root };

if (process.argv[2] === 'crash-before-manifest') {
  let authorizations = 0;
  await chunk(process.argv[3], chunkBytes, undefined, { authorize: async () => {
    if (++authorizations === 3) process.exit(86); // Bytes have fsync'ed, the manifest has not advanced.
  } });
  process.exit(1);
} else if (process.argv[2] === 'cold-state') {
  console.log(JSON.stringify(await assets.readFileAssetUploadCheckpoint(process.argv[3])));
} else {
  test('resumable uploads preserve durable offsets, full digest and original authority', async t => {
    t.after(async () => {
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
      await rm(root, { recursive: true, force: true });
    });

    await t.test('chunk headers reject ambiguous, unbounded and non-binary input', () => {
      const headers = { 'content-type': 'application/octet-stream', 'x-agentoc-upload-offset': '0',
        'x-agentoc-upload-length': String(chunkBytes), 'x-agentoc-upload-sha256': hash(bytes) };
      assert.deepEqual(uploadChunkHeaders(headers), { offset: 0, length: chunkBytes, sha256: hash(bytes) });
      assert.equal(MAX_STABLE_UPLOAD_BYTES, 1024 * 1024 * 1024);
      assert.equal(uploadChunkHeaders({ ...headers, 'x-agentoc-upload-offset': '1073741824' }).offset, 1073741824);
      for (const bad of ['-1', '00', '1.0', '1e3', ' 1', '9007199254740992', ['0', '1'], undefined])
        assert.throws(() => uploadChunkHeaders({ ...headers, 'x-agentoc-upload-offset': bad }), { code: 'INVALID_ARGUMENT' });
      assert.throws(() => uploadChunkHeaders({ ...headers, 'content-type': 'text/plain' }), { statusCode: 415 });
    });

    await t.test('initial offset query creates no body or checkpoint', async () => {
      const id = await seed();
      const state = await assets.readFileAssetUploadCheckpoint(id);
      assert.equal(state.offset, 0); assert.equal(state.totalBytes, bytes.length);
      await assert.rejects(stat(paths(id).manifest), { code: 'ENOENT' });
      await assert.rejects(stat(paths(id).body), { code: 'ENOENT' });
    });

    await t.test('one GiB intent is accepted without reserving or buffering its payload', async () => {
      const receipt = await assets.createFileAssetUploadIntent({ ...input, requestId: 'checkpoint-one-gib',
        sizeBytes: MAX_STABLE_UPLOAD_BYTES, sha256: 'f'.repeat(64) });
      assert.equal(receipt.asset.sizeBytes, MAX_STABLE_UPLOAD_BYTES);
      const id = receipt.asset.id;
      assert.equal((await assets.readFileAssetUploadCheckpoint(id)).offset, 0);
      await assert.rejects(stat(paths(id).manifest), { code: 'ENOENT' });
      await assert.rejects(stat(paths(id).body), { code: 'ENOENT' });
      await assert.rejects(assets.createFileAssetUploadIntent({ ...input, requestId: 'checkpoint-too-large',
        sizeBytes: MAX_STABLE_UPLOAD_BYTES + 1, sha256: 'f'.repeat(64) }), { code: 'INVALID_ARGUMENT' });
    });

    await t.test('duplicates recover lost replies; wrong order and different replay cannot mutate bytes', async () => {
      const id = await seed();
      assert.equal((await chunk(id)).offset, chunkBytes);
      const manifest = await readFile(paths(id).manifest);
      const duplicate = await chunk(id);
      assert.equal(duplicate.offset, chunkBytes);
      assert.deepEqual(await readFile(paths(id).manifest), manifest, 'Replay does not rewrite its receipt');
      await assert.rejects(chunk(id, 0, Buffer.alloc(chunkBytes, 80)), { code: 'FILE_ASSET_UPLOAD_OFFSET_CONFLICT' });
      await assert.rejects(chunk(id, 2 * chunkBytes), { code: 'FILE_ASSET_UPLOAD_OFFSET_CONFLICT' });
      await assert.rejects(assets.finalizeFileAssetUpload(id), { code: 'FILE_ASSET_UPLOAD_INCOMPLETE' });
      await assert.rejects(assets.ingestFileAssetUpload(id, Readable.from([bytes])), { code: 'FILE_ASSET_UPLOAD_MODE_CONFLICT' });
      assert.equal((await chunk(id, chunkBytes)).offset, 2 * chunkBytes);
      assert.equal((await chunk(id, 2 * chunkBytes)).status, 'uploaded');
      assert.equal((await assets.getFileAsset(id)).status, 'pending_upload', 'Complete bytes are not yet an accepted asset');
      const ready = await assets.finalizeFileAssetUpload(id, { sizeBytes: bytes.length });
      assert.equal(ready.status, 'ready'); assert.equal(ready.sha256, hash(bytes));
      assert.deepEqual(await readFile((await assets.getFileAsset(id)).localizedPath), bytes);
      assert.equal((await assets.readFileAssetUploadCheckpoint(id)).status, 'ready');
      assert.equal((await assets.finalizeFileAssetUpload(id)).updatedAt, ready.updatedAt);
      await assert.rejects(stat(paths(id).manifest), { code: 'ENOENT' });
      await assert.rejects(stat(paths(id).body), { code: 'ENOENT' });
      await assert.rejects(chunk(id), { code: 'FILE_ASSET_NOT_PENDING' });
    });

    await t.test('short, excessive, mismatched and non-grid chunks leave offset unchanged', async () => {
      const id = await seed();
      await assert.rejects(chunk(id, 1), { code: 'INVALID_ARGUMENT' });
      await assert.rejects(chunk(id, 0, Buffer.alloc(1)), { code: 'INVALID_ARGUMENT' });
      for (const data of [Buffer.alloc(chunkBytes - 1), Buffer.alloc(chunkBytes + 1)])
        await assert.rejects(assets.appendFileAssetUploadChunk(id, Readable.from([data]),
          { offset: 0, length: chunkBytes, sha256: hash(data) }), { code: 'FILE_ASSET_SIZE_MISMATCH' });
      await assert.rejects(chunk(id, 0, undefined, { sha256: '0'.repeat(64) }), { code: 'FILE_ASSET_HASH_MISMATCH' });
      assert.equal((await assets.readFileAssetUploadCheckpoint(id)).offset, 0);
      assert.equal((await chunk(id)).offset, chunkBytes);
    });

    await t.test('concurrent identical chunks advance one time under the asset lock', async () => {
      const id = await seed();
      const results = await Promise.all(Array.from({ length: 5 }, () => chunk(id)));
      assert.deepEqual(results.map(r => r.offset), Array(5).fill(chunkBytes));
      assert.equal((await stat(paths(id).body)).size, chunkBytes);
    });

    await t.test('fresh process discards the fsynced tail left by an actual process exit', async () => {
      const id = await seed(); await chunk(id);
      await assert.rejects(promisify(execFile)(process.execPath,
        [import.meta.filename, 'crash-before-manifest', id], { env: childEnv, timeout: 30_000 }), { code: 86 });
      assert.equal((await stat(paths(id).body)).size, 2 * chunkBytes, 'Crash left unconfirmed durable bytes');
      const cold = await promisify(execFile)(process.execPath,
        [import.meta.filename, 'cold-state', id], { env: childEnv, timeout: 30_000 });
      assert.equal(JSON.parse(cold.stdout.trim().split('\n').at(-1)).offset, chunkBytes);
      assert.equal((await stat(paths(id).body)).size, chunkBytes);
      await chunk(id, chunkBytes); await chunk(id, 2 * chunkBytes);
      assert.equal((await assets.finalizeFileAssetUpload(id)).status, 'ready');
    });

    await t.test('valid one-day v1 checkpoints remain resumable during upgrade', async () => {
      const id = await seed(); await chunk(id);
      const record = await assets.getFileAsset(id), manifestPath = paths(id).manifest;
      const legacy = JSON.parse(await readFile(manifestPath, 'utf8'));
      delete legacy.hardExpiresAt;
      legacy.version = 1;
      legacy.expiresAt = Date.parse(record.createdAt) + 24 * 60 * 60 * 1000;
      await writeFile(manifestPath, JSON.stringify(legacy));
      const now = Date.parse(record.createdAt) + 1_000;
      const checkpoints = new FileAssetUploadCheckpoints(directory, () => now);
      const fence = effect => effect();
      assert.equal((await checkpoints.state(record, fence)).offset, chunkBytes);
      await checkpoints.append(record, { offset: chunkBytes, length: chunkBytes,
        sha256: hash(bytes.subarray(chunkBytes, 2 * chunkBytes)) },
      Readable.from([bytes.subarray(chunkBytes, 2 * chunkBytes)]), fence);
      const upgraded = JSON.parse(await readFile(manifestPath, 'utf8'));
      assert.equal(upgraded.version, 2);
      assert.equal(upgraded.offset, 2 * chunkBytes);
      assert.equal(upgraded.hardExpiresAt, Date.parse(record.createdAt) + UPLOAD_CHECKPOINT_MAX_LIFETIME_MS);
    });

    await t.test('cancel is durable, idempotent and cannot be bypassed by full upload or finalize', async () => {
      const id = await seed(); await chunk(id);
      assert.equal((await assets.cancelFileAssetUploadCheckpoint(id)).status, 'cancelled');
      assert.equal((await assets.cancelFileAssetUploadCheckpoint(id)).status, 'cancelled');
      await assert.rejects(stat(paths(id).body), { code: 'ENOENT' });
      await assert.rejects(assets.readFileAssetUploadCheckpoint(id), { code: 'FILE_ASSET_UPLOAD_CANCELLED' });
      await assert.rejects(chunk(id, chunkBytes), { code: 'FILE_ASSET_UPLOAD_CANCELLED' });
      await assert.rejects(assets.ingestFileAssetUpload(id, Readable.from([bytes])), { code: 'FILE_ASSET_UPLOAD_MODE_CONFLICT' });
      await assert.rejects(assets.finalizeFileAssetUpload(id), { code: 'FILE_ASSET_UPLOAD_CANCELLED' });
      const cold = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
        `import { readFileAssetUploadCheckpoint } from './chat/file-assets.mjs';
         try { await readFileAssetUploadCheckpoint('${id}'); process.exit(2); }
         catch (e) { if (e.code !== 'FILE_ASSET_UPLOAD_CANCELLED') throw e; console.log(e.code); }`],
        { cwd: resolve(import.meta.dirname, '..'), env: childEnv, timeout: 30_000 });
      assert.equal(cold.stdout.trim().split('\n').at(-1), 'FILE_ASSET_UPLOAD_CANCELLED');
    });

    await t.test('active chunks extend the idle lease while the hard lifetime still bounds retention', async () => {
      const id = await seed(), other = await seed();
      const record = await assets.getFileAsset(id), created = Date.parse(record.createdAt);
      let now = created + UPLOAD_CHECKPOINT_TTL_MS - 1_000;
      const checkpoints = new FileAssetUploadCheckpoints(directory, () => now);
      const fence = effect => effect();
      const renewed = await checkpoints.append(record, { offset: 0, length: chunkBytes, sha256: hash(bytes.subarray(0, chunkBytes)) },
        Readable.from([bytes.subarray(0, chunkBytes)]), fence);
      assert.equal(renewed.expiresAt, Math.min(now + UPLOAD_CHECKPOINT_TTL_MS,
        created + UPLOAD_CHECKPOINT_MAX_LIFETIME_MS));
      now = renewed.expiresAt - 1;
      assert.equal((await checkpoints.state(record, fence)).offset, chunkBytes);
      now = renewed.expiresAt;
      await assert.rejects(checkpoints.state(record, fence), { code: 'FILE_ASSET_UPLOAD_EXPIRED', statusCode: 410 });
      await assert.rejects(stat(paths(id).body), { code: 'ENOENT' });
      await assert.rejects(stat(paths(id).manifest), { code: 'ENOENT' });
      await chunk(other);
      assert.equal((await stat(paths(other).body)).size, chunkBytes);
    });

    await t.test('revocation at publication leaves previous offset; renewed read truncates tail', async () => {
      const id = await seed(); await chunk(id);
      let checks = 0;
      const denied = Object.assign(new Error('revoked'), { code: 'temporary_pairing_inactive', statusCode: 403 });
      await assert.rejects(chunk(id, chunkBytes, undefined, { authorize: async () => {
        if (++checks >= 3) throw denied;
      } }), error => error === denied);
      assert.equal((await stat(paths(id).body)).size, 2 * chunkBytes);
      assert.equal((await assets.readFileAssetUploadCheckpoint(id)).offset, chunkBytes);
      assert.equal((await stat(paths(id).body)).size, chunkBytes);
      assert.equal((await assets.getFileAsset(id)).status, 'pending_upload');
    });

    await t.test('individual valid chunks cannot bypass the declared whole-file digest', async () => {
      const id = await seed(); await chunk(id, 0, Buffer.alloc(chunkBytes, 17));
      await chunk(id, chunkBytes); await chunk(id, 2 * chunkBytes);
      await assert.rejects(assets.finalizeFileAssetUpload(id), { code: 'FILE_ASSET_HASH_MISMATCH' });
      assert.equal((await assets.getFileAsset(id)).status, 'pending_upload');
      assert.equal((await assets.getFileAsset(id)).localizedPath, '');
    });

    await t.test('corrupt manifests and missing acknowledged bytes fail closed without creating a fresh offset', async () => {
      for (const fault of ['broken', 'future-offset', 'foreign-fingerprint', 'short-body', 'missing-body']) {
        const id = await seed(); await chunk(id);
        const value = JSON.parse(await readFile(paths(id).manifest));
        if (fault === 'broken') await writeFile(paths(id).manifest, '{broken');
        if (fault === 'future-offset') await writeFile(paths(id).manifest, JSON.stringify({ ...value, offset: bytes.length + 1 }));
        if (fault === 'foreign-fingerprint') await writeFile(paths(id).manifest, JSON.stringify({ ...value, fingerprint: '0'.repeat(64) }));
        if (fault === 'short-body') await writeFile(paths(id).body, 'short');
        if (fault === 'missing-body') await rm(paths(id).body);
        await assert.rejects(assets.readFileAssetUploadCheckpoint(id), { code: 'FILE_ASSET_RECEIPT_UNAVAILABLE', statusCode: 503 });
      }
    });

    await t.test('scope change while receiving a chunk blocks publication and old-scope reads', async () => {
      const store = await import('../chat/session-meta-store.mjs');
      await store.withSessionsMetaMutation(async (rows, save) => {
        rows.push({ id: 'scoped-checkpoint', name: 'Synthetic scoped upload', folder: root, projectId: 'p1',
          sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true, tool: 'codex' });
        await save(rows, { immediate: true });
      });
      const context = await store.readSessionApiContext('scoped-checkpoint');
      const scope = { version: 1, sessionId: context.sessionId,
        expectedScopeRevision: context.scopeRevision, expectedProjectId: context.projectId };
      const id = await seed({ sessionId: scope.sessionId, scopeCondition: scope });
      let receiving; const started = new Promise(resolve => { receiving = resolve; });
      const stream = new Readable({ read() { receiving(); } });
      const upload = assets.appendFileAssetUploadChunk(id, stream, { offset: 0, length: chunkBytes,
        sha256: hash(bytes.subarray(0, chunkBytes)), scopeCondition: scope });
      const refused = assert.rejects(upload, { code: 'REVISION_CONFLICT' });
      await started;
      await store.mutateSessionMeta(scope.sessionId, draft => { draft.projectId = 'p2'; return true; });
      stream.push(bytes.subarray(0, chunkBytes)); stream.push(null); await refused;
      await assert.rejects(assets.readFileAssetUploadCheckpoint(id, { scopeCondition: scope }), { code: 'REVISION_CONFLICT' });
      await assert.rejects(stat(paths(id).manifest), { code: 'ENOENT' });
    });

    await t.test('Owner route enforces principal, session access, scope and chunk headers', async () => {
      const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
      const id = await seed();
      async function request(method, action, { auth = { role: 'owner' }, access = true, body, headers = {} } = {}) {
        const req = new PassThrough(); req.method = method; req.headers = headers;
        const response = { setHeader() {} };
        const pending = handleControlRoutes({ req, res: response, pathname: `/api/assets/${id}/${action}`,
          parsedUrl: { query: {} }, fileAssetRoute: { assetId: id, action }, authSession: auth,
          requireSessionAccess: async (res, _auth, _session, flags) => {
            assert.equal(flags.metadataOnly, true);
            if (!access) { res.status = 403; res.body = { code: 'PERMISSION_DENIED' }; }
            return access;
          }, writeJson: (res, status, value) => { res.status = status; res.body = value; } });
        req.end(body); assert.equal(await pending, true); return response;
      }
      for (const auth of [{ role: 'visitor' }, { role: 'owner', principalKind: 'run_capability' }])
        assert.equal((await request('GET', 'upload-checkpoint', { auth })).status, 403);
      assert.equal((await request('GET', 'upload-checkpoint', { access: false })).status, 403);
      assert.equal((await request('GET', 'upload-checkpoint')).body.offset, 0);
      assert.equal((await request('PATCH', 'upload', { body: bytes.subarray(0, chunkBytes) })).status, 415);
      const part = bytes.subarray(0, chunkBytes);
      const response = await request('PATCH', 'upload', { body: part, headers: {
        'content-type': 'application/octet-stream', 'x-agentoc-upload-offset': '0',
        'x-agentoc-upload-length': String(part.length), 'x-agentoc-upload-sha256': hash(part) } });
      assert.equal(response.status, 200); assert.equal(response.body.offset, chunkBytes);
      assert.equal((await request('DELETE', 'upload-checkpoint')).body.status, 'cancelled');
      assert.equal((await request('GET', 'upload-checkpoint')).status, 410);
    });
    assert.ok((await readdir(CHAT_FILE_ASSETS_DIR)).length > 0);
  });
}
