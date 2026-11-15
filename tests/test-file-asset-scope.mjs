import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { createServer, request as httpRequest } from 'node:http';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { test, after } from 'node:test';
import { SESSION_API_SCOPE_HEADER } from '../chat/session-api-scope-contract.mjs';

const root = process.env.RAGENT_SCOPED_UPLOAD_TEST_ROOT || await mkdtemp(join(tmpdir(), 'ragent-scoped-upload-'));
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
const bytes = Buffer.from('手机共享附件\na,b\n1,2\n');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let remoteBytes = bytes; let remoteHold; let remoteReads = 0;
const storage = createServer(async (_req, res) => {
  remoteReads++; res.writeHead(200); res.write(remoteBytes.subarray(0, 3));
  const hold = remoteHold;
  if (hold) { hold.entered.resolve(); await hold.release.promise; }
  res.end(remoteBytes.subarray(3));
});
await new Promise(resolve => storage.listen(0, '127.0.0.1', resolve));
process.env.RAGENT_ASSET_STORAGE_BASE_URL = `http://127.0.0.1:${storage.address().port}/bucket`;
process.env.RAGENT_ASSET_STORAGE_ACCESS_KEY_ID = 'fixture-access';
process.env.RAGENT_ASSET_STORAGE_SECRET_ACCESS_KEY = 'fixture-secret';
process.env.RAGENT_ASSET_STORAGE_PROVIDER = 's3';
process.env.RAGENT_ASSET_STORAGE_REGION = 'fixture';
process.env.RAGENT_ASSET_DIRECT_UPLOAD_ENABLED = '0';
delete process.env.RAGENT_ASSET_STORAGE_PUBLIC_BASE_URL;
const assets = await import('../chat/file-assets.mjs');
const store = await import('../chat/session-meta-store.mjs');
const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
const { CHAT_FILE_ASSETS_DIR } = await import('../lib/config.mjs');
assert.equal(CHAT_FILE_ASSETS_DIR, join(root, 'config', 'file-assets'));
let sequence = 0;
const condition = c => ({ version: 1, sessionId: c.sessionId, expectedScopeRevision: c.scopeRevision, expectedProjectId: c.projectId });
const input = scope => ({ sessionId: scope.sessionId, requestId: `scoped-file-${++sequence}`, originalName: '销售.csv',
  mimeType: 'text/csv', sizeBytes: bytes.length, sha256, scopeCondition: scope });
const file = assetId => join(CHAT_FILE_ASSETS_DIR, assetId + '.json');
async function seed(extra = {}) {
  await store.withSessionsMetaMutation(async (rows, save) => {
    rows.splice(0, rows.length, { id: 's1', name: 'File task', folder: root, projectId: 'p1',
      sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true, tool: 'codex', ...extra });
    await save(rows, { immediate: true });
  });
  return condition(await store.readSessionApiContext(extra.id || 's1'));
}
const move = projectId => store.mutateSessionMeta('s1', draft => { draft.projectId = projectId; return true; });
const options = scopeCondition => ({ scopeCondition });
async function route(method, pathname, { payload, body, scope, headers = {}, auth = { role: 'owner' }, access = true } = {}) {
  const req = new PassThrough(); req.method = method; req.headers = { ...headers };
  if (scope) req.headers[SESSION_API_SCOPE_HEADER] = Buffer.from(JSON.stringify(scope)).toString('base64url');
  const parsed = new URL(pathname, 'http://localhost');
  const match = parsed.pathname.match(/^\/api\/assets\/(fasset_[a-f0-9]{24})\/(upload|finalize)$/);
  const res = { headers: {}, status: 0, body: null, setHeader(key, value) { this.headers[key] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() {} };
  const accesses = [];
  const writeJson = (_res, status, value) => Object.assign(res, { status, body: value });
  const pending = handleControlRoutes({ req, res, pathname: parsed.pathname,
    parsedUrl: { query: Object.fromEntries(parsed.searchParams) }, authSession: auth,
    fileAssetRoute: match ? { assetId: match[1], action: match[2] } : null,
    requireSessionAccess: async (_res, _auth, sessionId, flags) => {
      accesses.push(sessionId);
      if (Object.hasOwn(req.headers, SESSION_API_SCOPE_HEADER)) assert.equal(flags?.metadataOnly, true);
      if (!access) writeJson(res, 403, { code: 'PERMISSION_DENIED' });
      return access;
    }, writeJson, buildHeaders: headers => headers });
  req.end(body ?? (payload ? JSON.stringify(payload) : undefined));
  assert.equal(await pending, true);
  return { ...res, accesses };
}

if (process.argv[2] === 'crash-finalize-server') {
  const server = createServer(async (req, res) => {
    const parsed = new URL(req.url, 'http://localhost');
    const match = parsed.pathname.match(/^\/api\/assets\/(fasset_[a-f0-9]{24})\/finalize$/);
    await handleControlRoutes({ req, res, pathname: parsed.pathname, parsedUrl: { query: {} },
      fileAssetRoute: match ? { assetId: match[1], action: 'finalize' } : null,
      authSession: { role: 'owner' }, requireSessionAccess: async (_res, _auth, _id, flags) => {
        assert.equal(flags?.metadataOnly, true); return true;
      }, writeJson: (_res, status, body) => {
        if (status === 200) process.send({ type: 'committed', asset: body.asset });
        else { res.writeHead(status); res.end(JSON.stringify(body)); }
      } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.send({ type: 'listening', port: server.address().port });
} else if (process.argv[2] === 'cold-receipt') {
  const request = JSON.parse(process.env.RAGENT_SCOPED_UPLOAD_REQUEST);
  const receipt = await assets.findFileAssetUploadReceipt(request);
  const replay = await assets.createFileAssetUploadIntent(request);
  assert.equal(replay.duplicate, true); assert.equal(replay.upload, null);
  process.stdout.write('COLD_RECEIPT=' + JSON.stringify({ receipt, replay }) + '\n');
  storage.closeAllConnections(); await new Promise(resolve => storage.close(resolve));
} else {
after(async () => {
  remoteHold?.release.resolve(); storage.closeAllConnections(); await new Promise(resolve => storage.close(resolve));
  await store.flushSessionsMetaNow(); console.log(`Retained isolated scoped-upload root: ${root}`);
});

test('scoped uploads require stable metadata and retain an immutable private context', async () => {
  const scope = await seed(); const request = input(scope);
  const legacy = { ...request }; delete legacy.requestId;
  await assert.rejects(assets.createFileAssetUploadIntent(legacy), { code: 'INVALID_ARGUMENT' });
  const parallel = await Promise.all(Array.from({ length: 6 }, () => assets.createFileAssetUploadIntent(request)));
  assert.equal(parallel.filter(value => !value.duplicate).length, 1);
  assert.equal(new Set(parallel.map(value => value.asset.id)).size, 1);
  const record = await assets.getFileAsset(parallel[0].asset.id);
  assert.deepEqual(record.uploadRequest.scopeCondition, scope); assert.equal(record.uploadRequest.scopeVersion, 1);
  assert.equal(parallel[0].asset.scopeContractVersion, 1);
  assert.equal(parallel[0].asset.uploadRequest, undefined); assert.equal(parallel[0].asset.scopeCondition, undefined);
  scope.expectedProjectId = 'forged';
  assert.equal((await assets.getFileAsset(record.id)).uploadRequest.scopeCondition.expectedProjectId, 'p1');
});

test('local body publication and finalization keep the exact context and verified bytes', async () => {
  const scope = await seed(); const request = input(scope); const intent = await assets.createFileAssetUploadIntent(request);
  await assets.ingestFileAssetUpload(intent.asset.id, Readable.from([bytes]), options(scope));
  const ready = await assets.finalizeFileAssetUpload(intent.asset.id, { ...options(scope), sizeBytes: bytes.length });
  assert.equal(ready.status, 'ready'); assert.equal(ready.sha256, sha256); assert.equal(ready.scopeContractVersion, 1);
  const record = await assets.getFileAsset(ready.id);
  assert.deepEqual(await readFile(record.localizedPath), bytes);
  const again = await assets.finalizeFileAssetUpload(ready.id, options(scope));
  assert.equal(again.updatedAt, ready.updatedAt);
  const receipt = await assets.findFileAssetUploadReceipt(request);
  assert.equal(receipt.asset.id, ready.id); assert.equal(receipt.upload, undefined); assert.equal(receipt.asset.directUrl, undefined);
  assert.equal((await store.readSessionApiContext('s1')).scopeRevision, scope.expectedScopeRevision);
});

test('a scoped intent cannot be replayed, ingested, finalized or recovered without its condition', async () => {
  const scope = await seed(); const request = input(scope); const intent = await assets.createFileAssetUploadIntent(request);
  const missing = { ...request }; delete missing.scopeCondition;
  await assert.rejects(assets.createFileAssetUploadIntent(missing), { code: 'FILE_ASSET_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(assets.findFileAssetUploadReceipt(missing), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(assets.ingestFileAssetUpload(intent.asset.id, Readable.from([bytes])), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(assets.finalizeFileAssetUpload(intent.asset.id), { code: 'INVALID_ARGUMENT' });
  assert.equal((await assets.getFileAsset(intent.asset.id)).status, 'pending_upload');
});

test('new scope cannot replace the bound condition under the original upload identity', async () => {
  const scope = await seed(); const request = input(scope); const intent = await assets.createFileAssetUploadIntent(request);
  await move('p2'); const fresh = condition(await store.readSessionApiContext('s1'));
  await assert.rejects(assets.createFileAssetUploadIntent({ ...request, scopeCondition: fresh }), { code: 'FILE_ASSET_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(assets.findFileAssetUploadReceipt({ ...request, scopeCondition: fresh }), { code: 'FILE_ASSET_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(assets.ingestFileAssetUpload(intent.asset.id, Readable.from([bytes]), options(fresh)), { code: 'FILE_ASSET_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(assets.finalizeFileAssetUpload(intent.asset.id, options(fresh)), { code: 'FILE_ASSET_IDEMPOTENCY_CONFLICT' });
  assert.deepEqual((await assets.getFileAsset(intent.asset.id)).uploadRequest.scopeCondition, scope);
});

test('an existing legacy upload cannot gain a scope condition by reusing its identity', async () => {
  const scope = await seed(); const request = input(scope); const legacy = { ...request }; delete legacy.scopeCondition;
  const intent = await assets.createFileAssetUploadIntent(legacy);
  await assert.rejects(assets.createFileAssetUploadIntent(request), { code: 'FILE_ASSET_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(assets.ingestFileAssetUpload(intent.asset.id, Readable.from([bytes]), options(scope)), { code: 'FILE_ASSET_IDEMPOTENCY_CONFLICT' });
  await assets.ingestFileAssetUpload(intent.asset.id, Readable.from([bytes]));
  assert.equal((await assets.finalizeFileAssetUpload(intent.asset.id)).status, 'ready');
});

test('project moves while a body is streaming; publication rejects after A to B to A', { timeout: 10000 }, async () => {
  const scope = await seed(); const request = input(scope); const intent = await assets.createFileAssetUploadIntent(request);
  const before = await readFile(file(intent.asset.id)); const entered = deferred(); const release = deferred();
  async function* incoming() { yield bytes.subarray(0, 3); entered.resolve(); await release.promise; yield bytes.subarray(3); }
  const upload = assets.ingestFileAssetUpload(intent.asset.id, Readable.from(incoming()), options(scope));
  const rejected = assert.rejects(upload, { code: 'REVISION_CONFLICT' });
  await entered.promise;
  try { await move('p2'); await move('p1'); } finally { release.resolve(); }
  await rejected;
  assert.deepEqual(await readFile(file(intent.asset.id)), before);
  const record = await assets.getFileAsset(intent.asset.id);
  const target = join(CHAT_FILE_ASSETS_DIR, 'objects', record.storage.localFilename);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  assert.equal((await readdir(join(CHAT_FILE_ASSETS_DIR, 'objects'))).some(name => name.startsWith(record.storage.localFilename + '.tmp-')), false);
});

test('failed replacement after scope movement preserves the previous verified body', { timeout: 10000 }, async () => {
  const scope = await seed(); const request = input(scope); const intent = await assets.createFileAssetUploadIntent(request);
  await assets.ingestFileAssetUpload(intent.asset.id, Readable.from([bytes]), options(scope));
  const record = await assets.getFileAsset(intent.asset.id); const before = await readFile(file(intent.asset.id));
  const entered = deferred(); const release = deferred();
  async function* incoming() { entered.resolve(); await release.promise; yield bytes; }
  const rejected = assert.rejects(assets.ingestFileAssetUpload(intent.asset.id, Readable.from(incoming()), options(scope)), { code: 'REVISION_CONFLICT' });
  await entered.promise; try { await move('p2'); } finally { release.resolve(); }
  await rejected;
  assert.deepEqual(await readFile(record.localizedPath), bytes); assert.deepEqual(await readFile(file(record.id)), before);
});

test('project movement waits only for the bounded body publication', { timeout: 10000 }, async () => {
  const scope = await seed(); const request = input(scope); const intent = await assets.createFileAssetUploadIntent(request);
  const record = await assets.getFileAsset(intent.asset.id);
  const target = join(CHAT_FILE_ASSETS_DIR, 'objects', record.storage.localFilename);
  const entered = deferred(); const release = deferred(); const order = []; const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (to === target) { entered.resolve(); await release.promise; order.push('publish'); }
    return original(from, to);
  };
  syncBuiltinESMExports();
  const upload = assets.ingestFileAssetUpload(record.id, Readable.from([bytes]), options(scope));
  let movement;
  try {
    await entered.promise;
    movement = store.mutateSessionMeta('s1', draft => { order.push('move'); draft.projectId = 'p2'; return true; });
    assert.deepEqual(order, []); release.resolve(); await Promise.all([upload, movement]);
  } finally { release.resolve(); fs.promises.rename = original; syncBuiltinESMExports(); }
  assert.deepEqual(order, ['publish', 'move']);
  assert.deepEqual(await readFile((await assets.getFileAsset(record.id)).localizedPath), bytes);
  await assert.rejects(assets.finalizeFileAssetUpload(record.id, options(scope)), { code: 'REVISION_CONFLICT' });
});

test('remote verification streams outside the Session guard and checks scope again before ready', { timeout: 10000 }, async () => {
  const scope = await seed(); const request = input(scope);
  const intent = await assets.createFileAssetUploadIntent({ ...request, forceRemote: true });
  assert.equal(intent.upload.method, 'PUT'); const before = await readFile(file(intent.asset.id));
  const hold = { entered: deferred(), release: deferred() }; remoteHold = hold;
  const rejected = assert.rejects(assets.finalizeFileAssetUpload(intent.asset.id, options(scope)), { code: 'REVISION_CONFLICT' });
  await hold.entered.promise;
  try { await move('p2'); } finally { hold.release.resolve(); remoteHold = null; }
  await rejected; assert.deepEqual(await readFile(file(intent.asset.id)), before);
  assert.equal((await assets.getFileAsset(intent.asset.id)).status, 'pending_upload');
});

test('failed durable scope publication rejects the staged body and permits exact retry', { timeout: 10000 }, async () => {
  const { CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');
  const scope = await seed(); const request = input(scope); const intent = await assets.createFileAssetUploadIntent(request);
  const before = await readFile(file(intent.asset.id)); let armed = false; let failures = 0;
  const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (armed && to === CHAT_SESSIONS_FILE && failures++ === 0)
      throw Object.assign(new Error('controlled scope publication failure'), { code: 'EIO' });
    return original(from, to);
  };
  syncBuiltinESMExports();
  async function* incoming() { armed = true; yield bytes; }
  try {
    await assert.rejects(assets.ingestFileAssetUpload(intent.asset.id, Readable.from(incoming()), options(scope)),
      { code: 'SESSION_MUTATION_STORE_UNAVAILABLE' });
  } finally { fs.promises.rename = original; syncBuiltinESMExports(); }
  assert.ok(failures > 0); assert.deepEqual(await readFile(file(intent.asset.id)), before);
  const record = await assets.getFileAsset(intent.asset.id);
  await assert.rejects(stat(join(CHAT_FILE_ASSETS_DIR, 'objects', record.storage.localFilename)), { code: 'ENOENT' });
  await assets.ingestFileAssetUpload(record.id, Readable.from([bytes]), options(scope));
  assert.equal((await assets.finalizeFileAssetUpload(record.id, options(scope))).status, 'ready');
});

test('verified body with an unconfirmed metadata write recovers under the original scoped identity', { timeout: 10000 }, async () => {
  const scope = await seed(); const request = input(scope); const intent = await assets.createFileAssetUploadIntent(request);
  const before = await readFile(file(intent.asset.id)); let failures = 0; const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (to === file(intent.asset.id) && failures++ === 0)
      throw Object.assign(new Error('controlled asset publication failure'), { code: 'EIO' });
    return original(from, to);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(assets.ingestFileAssetUpload(intent.asset.id, Readable.from([bytes]), options(scope)), { code: 'FILE_ASSET_UPLOAD_FAILED' }); }
  finally { fs.promises.rename = original; syncBuiltinESMExports(); }
  assert.ok(failures > 0); assert.deepEqual(await readFile(file(intent.asset.id)), before);
  assert.equal((await assets.findFileAssetUploadReceipt(request)).asset.status, 'pending_upload');
  const ready = await assets.finalizeFileAssetUpload(intent.asset.id, options(scope));
  assert.equal(ready.id, intent.asset.id); assert.equal(ready.status, 'ready');
  assert.deepEqual(await readFile((await assets.getFileAsset(ready.id)).localizedPath), bytes);
});

test('upload lock inversion is rejected before waiting for an existing staged stream', { timeout: 10000 }, async () => {
  const scope = await seed(); const request = input(scope); const intent = await assets.createFileAssetUploadIntent(request);
  const entered = deferred(); const release = deferred();
  async function* incoming() { entered.resolve(); await release.promise; yield bytes; }
  const uploading = assets.ingestFileAssetUpload(intent.asset.id, Readable.from(incoming()), options(scope));
  await entered.promise;
  try {
    await store.withSessionApiScope('s1', scope, async () => {
      await assert.rejects(assets.ingestFileAssetUpload(intent.asset.id, Readable.from([bytes]), options(scope)), { code: 'REVISION_CONFLICT' });
      await assert.rejects(assets.createFileAssetUploadIntent(request), { code: 'REVISION_CONFLICT' });
      await assert.rejects(assets.finalizeFileAssetUpload(intent.asset.id, options(scope)), { code: 'REVISION_CONFLICT' });
      await assert.rejects(assets.findFileAssetUploadReceipt(request), { code: 'REVISION_CONFLICT' });
      assert.equal((await store.findSessionMeta('s1')).projectId, 'p1');
    });
  } finally { release.resolve(); }
  await uploading;
  assert.equal((await assets.finalizeFileAssetUpload(intent.asset.id, options(scope))).status, 'ready');
});

test('remote ready replay is exact, and stale scope cannot expose its receipt or credential', async () => {
  const scope = await seed(); const request = input(scope);
  const intent = await assets.createFileAssetUploadIntent({ ...request, forceRemote: true });
  const ready = await assets.finalizeFileAssetUpload(intent.asset.id, options(scope)); const reads = remoteReads;
  assert.equal(ready.status, 'ready');
  const snapshot = await assets.getFileAsset(ready.id);
  assert.equal(snapshot.storage.provider, 'local');
  assert.deepEqual(await readFile(snapshot.localizedPath), bytes);
  assert.equal(ready.directUrl.startsWith('/api/assets/'), true);
  remoteBytes = Buffer.alloc(bytes.length);
  try {
    assert.deepEqual(await readFile((await assets.getFileAsset(ready.id)).localizedPath), bytes);
    assert.equal((await assets.finalizeFileAssetUpload(intent.asset.id, options(scope))).sha256, sha256);
  } finally { remoteBytes = bytes; }
  assert.equal((await assets.finalizeFileAssetUpload(intent.asset.id, options(scope))).updatedAt, ready.updatedAt);
  assert.equal(remoteReads, reads);
  await move('p2'); await move('p1');
  await assert.rejects(assets.createFileAssetUploadIntent(request), { code: 'REVISION_CONFLICT' });
  await assert.rejects(assets.findFileAssetUploadReceipt(request), { code: 'REVISION_CONFLICT' });
  await assert.rejects(assets.finalizeFileAssetUpload(intent.asset.id, options(scope)), { code: 'REVISION_CONFLICT' });
  assert.equal(remoteReads, reads);
});

test('null project and Unicode context are explicit supported scope facts', async () => {
  const scope = await seed({ id: '工作😀', projectId: null }); const request = input(scope);
  const intent = await assets.createFileAssetUploadIntent(request);
  await assets.ingestFileAssetUpload(intent.asset.id, Readable.from([bytes]), options(scope));
  const ready = await assets.finalizeFileAssetUpload(intent.asset.id, options(scope));
  assert.equal(ready.sessionId, '工作😀'); assert.equal((await assets.getFileAsset(ready.id)).uploadRequest.scopeCondition.expectedProjectId, null);
});

test('corrupt, missing or downgraded private scope metadata fails before publication', async () => {
  const scope = await seed(); const request = input(scope); const intent = await assets.createFileAssetUploadIntent(request);
  const original = await readFile(file(intent.asset.id));
  for (const change of [raw => { raw.uploadRequest.scopeCondition = null; }, raw => { delete raw.uploadRequest.scopeCondition; },
    raw => { raw.uploadRequest.scopeVersion = 0; }, raw => { delete raw.uploadRequest.scopeCondition; delete raw.uploadRequest.scopeVersion; },
    raw => { raw.uploadRequest.scopeCondition.expectedScopeRevision = 'forged'; }, raw => { raw.uploadRequest.scopeCondition.expectedProjectId = 'p2'; }]) {
    const raw = JSON.parse(original); change(raw); await writeFile(file(intent.asset.id), JSON.stringify(raw));
    await assert.rejects(assets.findFileAssetUploadReceipt(request), { code: 'FILE_ASSET_RECEIPT_UNAVAILABLE' });
    await assert.rejects(assets.ingestFileAssetUpload(intent.asset.id, Readable.from([bytes]), options(scope)), { code: 'FILE_ASSET_RECEIPT_UNAVAILABLE' });
  }
  await writeFile(file(intent.asset.id), original);
  assert.equal((await assets.findFileAssetUploadReceipt(request)).asset.status, 'pending_upload');
});

test('HTTP adapter uses the condition for create, stream, finalize and read-only recovery', async () => {
  const scope = await seed(); const request = input(scope); const payload = { ...request }; delete payload.scopeCondition;
  const created = await route('POST', '/api/assets/upload-intents', { payload, scope });
  assert.equal(created.status, 200); assert.deepEqual(created.accesses, ['s1']);
  assert.equal(created.headers['Cache-Control'], 'private, no-store');
  const id = created.body.asset.id;
  assert.equal((await route('POST', `/api/assets/${id}/upload`, { body: bytes, scope })).status, 200);
  const finalized = await route('POST', `/api/assets/${id}/finalize`, { payload: { sizeBytes: bytes.length }, scope });
  assert.equal(finalized.status, 200); assert.equal(finalized.body.asset.status, 'ready');
  const receipt = await route('GET', `/api/assets/upload-intents?sessionId=s1&requestId=${request.requestId}`, { scope });
  assert.equal(receipt.status, 200); assert.equal(receipt.body.asset.id, id);
  assert.equal(receipt.body.asset.directUrl, undefined);
  assert.equal((await route('GET', `/api/assets/upload-intents?sessionId=s1&requestId=${request.requestId}`)).status, 400);
});

test('HTTP adapter rejects incompatible callers before Session access and body effects', async () => {
  const scope = await seed(); const request = input(scope); const payload = { ...request }; delete payload.scopeCondition;
  for (const auth of [{ role: 'visitor' }, { role: 'owner', principalKind: 'run_capability' },
    { role: 'owner', principalKind: 'provisional_device' }]) {
    const result = await route('POST', '/api/assets/upload-intents', { payload, scope, auth });
    assert.equal(result.status, 403); assert.equal(result.body.code, 'PERMISSION_DENIED'); assert.deepEqual(result.accesses, []);
  }
  assert.equal((await route('POST', '/api/assets/upload-intents', { payload, scope, access: false })).status, 403);
  const invalid = await route('POST', '/api/assets/upload-intents', { payload, headers: { [SESSION_API_SCOPE_HEADER]: '_' } });
  assert.equal(invalid.status, 400);
});

test('conditional HTTP failures withhold raw storage paths and support discovery acknowledges scope', async () => {
  const scope = await seed(); const request = input(scope); const payload = { ...request }; delete payload.scopeCondition;
  const contract = await route('GET', '/api/asset-upload-contract');
  assert.equal(contract.status, 200); assert.equal(contract.body.scopeConditionVersion, 1);
  assert.equal(contract.body.scopeContractPath, '/api/session-scope-contract');
  const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (to.endsWith('.json') && to.startsWith(CHAT_FILE_ASSETS_DIR))
      throw Object.assign(new Error('Private disk path: ' + to), { code: 'EIO' });
    return original(from, to);
  };
  syncBuiltinESMExports(); let result;
  try { result = await route('POST', '/api/assets/upload-intents', { payload, scope }); }
  finally { fs.promises.rename = original; syncBuiltinESMExports(); }
  assert.equal(result.status, 503); assert.equal(result.body.code, 'FILE_ASSET_UPLOAD_UNAVAILABLE');
  assert.equal(result.body.error.includes(root), false); assert.equal(result.body.error.includes('Private disk path'), false);
});

test('cold process recovery reuses the original ready scoped upload without mutation', { timeout: 10000 }, async () => {
  const scope = await seed(); const request = input(scope); const intent = await assets.createFileAssetUploadIntent(request);
  await assets.ingestFileAssetUpload(intent.asset.id, Readable.from([bytes]), options(scope));
  const ready = await assets.finalizeFileAssetUpload(intent.asset.id, options(scope));
  const before = await readFile(file(intent.asset.id));
  const cold = await promisify(execFile)(process.execPath, [import.meta.filename, 'cold-receipt'], {
    env: { ...process.env, RAGENT_SCOPED_UPLOAD_TEST_ROOT: root, RAGENT_SCOPED_UPLOAD_REQUEST: JSON.stringify(request) }, timeout: 8000,
  });
  const line = cold.stdout.split('\n').find(value => value.startsWith('COLD_RECEIPT='));
  const result = JSON.parse(line.slice('COLD_RECEIPT='.length));
  assert.equal(result.receipt.asset.id, ready.id); assert.equal(result.replay.asset.id, ready.id);
  assert.equal(result.replay.asset.updatedAt, ready.updatedAt); assert.deepEqual(await readFile(file(ready.id)), before);
});

test('process death after ready publication but before HTTP reply preserves the scoped receipt', { timeout: 20000 }, async () => {
  const scope = await seed(); const requestInput = input(scope); const intent = await assets.createFileAssetUploadIntent(requestInput);
  await assets.ingestFileAssetUpload(intent.asset.id, Readable.from([bytes]), options(scope));
  const child = fork(import.meta.filename, ['crash-finalize-server'], {
    env: { ...process.env, RAGENT_SCOPED_UPLOAD_TEST_ROOT: root }, silent: true,
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const messages = []; const listeners = new Map();
  child.on('message', value => { messages.push(value); listeners.get(value.type)?.(value); });
  function message(type) {
    const previous = messages.find(value => value.type === type);
    if (previous) return Promise.resolve(previous);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Owned child ${type} timed out: ${output}`)), 8000);
      listeners.set(type, value => { clearTimeout(timer); resolve(value); });
    });
  }
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let request;
  try {
    const listening = await message('listening'); let replied = false;
    const outcome = new Promise(resolve => {
      request = httpRequest({ hostname: '127.0.0.1', port: listening.port, method: 'POST',
        path: `/api/assets/${intent.asset.id}/finalize`, headers: {
          'Content-Type': 'application/json', [SESSION_API_SCOPE_HEADER]: Buffer.from(JSON.stringify(scope)).toString('base64url'),
        } }, res => { replied = true; res.resume(); res.on('end', () => resolve('reply')); });
      request.on('error', () => resolve('disconnected')); request.end(JSON.stringify({ sizeBytes: bytes.length }));
    });
    const committed = await message('committed');
    assert.equal(committed.asset.id, intent.asset.id); assert.equal(committed.asset.status, 'ready'); assert.equal(replied, false);
    const before = await readFile(file(intent.asset.id));
    assert.equal(child.kill('SIGKILL'), true); const termination = await exited;
    assert.ok(termination.signal || termination.code !== 0); assert.equal(await outcome, 'disconnected');
    const cold = await promisify(execFile)(process.execPath, [import.meta.filename, 'cold-receipt'], {
      env: { ...process.env, RAGENT_SCOPED_UPLOAD_TEST_ROOT: root, RAGENT_SCOPED_UPLOAD_REQUEST: JSON.stringify(requestInput) }, timeout: 8000,
    });
    const line = cold.stdout.split('\n').find(value => value.startsWith('COLD_RECEIPT='));
    const recovered = JSON.parse(line.slice('COLD_RECEIPT='.length));
    assert.equal(recovered.receipt.asset.id, intent.asset.id); assert.equal(recovered.receipt.asset.status, 'ready');
    assert.equal(recovered.replay.duplicate, true); assert.equal(recovered.replay.upload, null);
    assert.deepEqual(await readFile(file(intent.asset.id)), before);
    assert.deepEqual(await readFile((await assets.getFileAsset(intent.asset.id)).localizedPath), bytes);
  } finally {
    request?.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});
}
