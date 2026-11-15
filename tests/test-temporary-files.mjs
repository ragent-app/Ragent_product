import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash, randomBytes, sign } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';

test('temporary file uploads retain device, scope, digest and bounded storage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-files-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  process.env.RAGENT_CONFIG_DIR = join(root, 'config'); process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
  delete process.env.RAGENT_INSTANCE_ROOT;
  process.env.RAGENT_ASSET_STORAGE_BASE_URL = 'https://storage.example.invalid/bucket';
  process.env.RAGENT_ASSET_STORAGE_ACCESS_KEY_ID = 'fixture';
  process.env.RAGENT_ASSET_STORAGE_SECRET_ACCESS_KEY = 'fixture';
  process.env.RAGENT_ASSET_STORAGE_PROVIDER = 's3';
  process.env.RAGENT_ASSET_DIRECT_UPLOAD_ENABLED = '1';
  const { fixture } = await import('./helpers/temporary-turn-fixture.mjs');
  const { temporaryDeviceJwk } = await import('../lib/temporary-device-access.mjs');
  const { TemporarySessionService } = await import('../chat/temporary-session-service.mjs');
  const { TemporaryFileService } = await import('../chat/temporary-file-service.mjs');
  const assets = await import('../chat/file-assets.mjs');
  const meta = await import('../chat/session-meta-store.mjs');
  const { CHAT_FILE_ASSETS_DIR } = await import('../lib/config.mjs');
  const f = await fixture(t, { initialTime: Date.now() });
  const sessions = new TemporarySessionService({ host: f.host, workRoot: join(root, 'work'),
    availableTools: async () => [{ id: 'codex', name: 'CodeX', available: true }],
    runtimeCatalog: async tools => tools.map(tool => ({ id: tool.id, name: tool.name, ready: true, status: 'ready' })) });
  const service = new TemporaryFileService({ host: f.host, pollMs: 20 });
  const bytes = Buffer.from('来自荣耀的临时分享\na,b\n1,2\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let sequence = 0;
  async function seed(options) {
    const phone = await f.enroll(undefined, options); const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
    const targetUri = 'https://pc.example.test/temporary/files';
    const data = `${enc({ typ: 'dpop+jwt', alg: 'ES256', jwk: temporaryDeviceJwk(phone.claim.devicePublicKey).jwk })}.${enc({
      htm: 'POST', htu: targetUri, iat: Math.floor(f.clock() / 1000), jti: randomBytes(24).toString('base64url'),
      ath: createHash('sha256').update(phone.accessCredential.access_token).digest('base64url') })}`;
    const proof = `${data}.${sign('sha256', Buffer.from(data), { key: phone.device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    const principal = await f.host.authenticateRequest({ credential: phone.accessCredential, proof, method: 'POST', targetUri });
    const created = await sessions.create(principal, { tool: 'codex', idempotencyKey: `session-${++sequence}` });
    const scope = { version: 1, sessionId: created.session.sessionId,
      expectedScopeRevision: created.session.scopeRevision, expectedProjectId: created.session.projectId };
    const input = { requestId: `file-${sequence}`, originalName: '销售.csv', mimeType: 'text/csv', sizeBytes: bytes.length, sha256 };
    return { phone, principal, scope, input };
  }
  const create = v => service.create(v.principal, v.scope, v.input);
  await t.test('concurrent retries, upload and cold adapter recovery expose no Owner or direct URL', async () => {
    const v = await seed();
    const results = await Promise.all(Array.from({ length: 5 }, () => create(v)));
    assert.equal(new Set(results.map(r => r.asset.id)).size, 1);
    assert.equal(results.filter(r => !r.duplicate).length, 1);
    const id = results[0].asset.id;
    assert.equal((await assets.getFileAsset(id)).storage.provider, 'local');
    assert.equal((await service.upload(v.principal, v.scope, id, Readable.from([bytes]))).finalized, false);
    assert.equal((await assets.getFileAsset(id)).status, 'pending_upload');
    const cold = new TemporaryFileService({ host: f.host });
    const ready = await cold.finalize(v.principal, v.scope, id, { sizeBytes: bytes.length });
    assert.equal(ready.asset.status, 'ready'); assert.equal(ready.asset.sha256, sha256);
    assert.deepEqual(await cold.finalize(v.principal, v.scope, id, { sizeBytes: bytes.length }), ready);
    assert.deepEqual((await cold.receipt(v.principal, v.scope, v.input.requestId)).asset, ready.asset);
    assert.deepEqual(await readFile((await assets.getFileAsset(id)).localizedPath), bytes);
    assert.equal(/Url|\/api\/|storage|localizedPath|principalScope/.test(JSON.stringify([results, ready])), false);
    await assert.rejects(create({ ...v, input: { ...v.input, originalName: 'changed.csv' } }), { code: 'FILE_ASSET_IDEMPOTENCY_CONFLICT' });
  });
  await t.test('foreign grant, injected options and absent idempotency key are refused', async () => {
    const a = await seed(), b = await seed(), { asset } = await create(a);
    await assert.rejects(service.receipt(b.principal, a.scope, a.input.requestId), { code: 'temporary_resource_denied' });
    await assert.rejects(service.upload(b.principal, b.scope, asset.id, Readable.from([bytes])), { code: 'temporary_resource_denied' });
    for (const key of ['forceRemote', 'createdBy', 'principalScope', 'sessionId'])
      await assert.rejects(create({ ...a, input: { ...a.input, [key]: 'owner' } }), { code: 'temporary_upload_invalid' });
    await assert.rejects(create({ ...a, input: { ...a.input, requestId: undefined } }), { code: 'temporary_upload_invalid' });
  });
  await t.test('digest and byte count mismatch never publish a ready attachment', async () => {
    const v = await seed(), { asset } = await create(v);
    for (const [content, code] of [[Buffer.alloc(bytes.length), 'FILE_ASSET_HASH_MISMATCH'],
      [Buffer.alloc(bytes.length + 1), 'FILE_ASSET_SIZE_MISMATCH']]) {
      await assert.rejects(service.upload(v.principal, v.scope, asset.id, Readable.from([content])), { code });
      assert.equal((await assets.getFileAsset(asset.id)).status, 'pending_upload');
      assert.equal((await assets.getFileAsset(asset.id)).localizedPath || '', '');
    }
  });
  await t.test('revocation terminates a stalled stream without requiring another byte', async () => {
    const v = await seed(), { asset } = await create(v);
    let started; const reading = new Promise(resolve => { started = resolve; });
    const stream = new Readable({ read() { started(); } });
    const failed = assert.rejects(service.upload(v.principal, v.scope, asset.id, stream), { code: 'temporary_pairing_inactive' });
    await reading; stream.push(bytes.subarray(0, 3));
    await f.host.revoke(v.phone.claim.invitationId); await failed;
    assert.equal(stream.destroyed, true); assert.equal((await assets.getFileAsset(asset.id)).status, 'pending_upload');
  });
  await t.test('idle deadline aborts the stream and keeps the intent recoverable', async () => {
    const v = await seed(), { asset } = await create(v), stream = new PassThrough();
    const fast = new TemporaryFileService({ host: f.host, idleMs: 50, pollMs: 20 });
    await assert.rejects(fast.upload(v.principal, v.scope, asset.id, stream), { code: 'temporary_upload_idle' });
    assert.equal(stream.destroyed, true);
    assert.equal((await service.receipt(v.principal, v.scope, v.input.requestId)).asset.status, 'pending_upload');
    await service.upload(v.principal, v.scope, asset.id, Readable.from([bytes]));
  });
  await t.test('revoked stalled chunk closes input and preserves only acknowledged bytes', async () => {
    const v = await seed();
    const content = Buffer.alloc(256 * 1024 + 7, 41);
    const input = { ...v.input, sizeBytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex') };
    const { asset } = await service.create(v.principal, v.scope, input);
    const first = content.subarray(0, 256 * 1024);
    assert.equal((await service.uploadChunk(v.principal, v.scope, asset.id,
      { offset: 0, length: first.length, sha256: createHash('sha256').update(first).digest('hex') },
      Readable.from([first]))).offset, first.length);
    let started; const reading = new Promise(resolve => { started = resolve; });
    const stream = new Readable({ read() { started(); } });
    const failed = assert.rejects(service.uploadChunk(v.principal, v.scope, asset.id,
      { offset: first.length, length: 7, sha256: createHash('sha256').update(content.subarray(first.length)).digest('hex') },
      stream), { code: 'temporary_pairing_inactive' });
    await reading; stream.push(content.subarray(first.length, first.length + 2));
    await f.host.revoke(v.phone.claim.invitationId); await failed;
    assert.equal(stream.destroyed, true);
    const manifest = JSON.parse(await readFile(join(CHAT_FILE_ASSETS_DIR, 'upload-checkpoints', `${asset.id}.json`)));
    assert.equal(manifest.offset, first.length);
    assert.equal((await assets.getFileAsset(asset.id)).status, 'pending_upload');
    await assert.rejects(service.checkpointState(v.principal, v.scope, asset.id), { code: 'temporary_pairing_inactive' });
  });
  await t.test('scope change after bytes land blocks finalization', async () => {
    const v = await seed(), { asset } = await create(v);
    await service.upload(v.principal, v.scope, asset.id, Readable.from([bytes]));
    await meta.mutateSessionMeta(v.scope.sessionId, draft => { draft.projectId = 'owner-moved-project'; return true; });
    await assert.rejects(service.finalize(v.principal, v.scope, asset.id, { sizeBytes: bytes.length }), { code: 'REVISION_CONFLICT' });
    assert.equal((await assets.getFileAsset(asset.id)).status, 'pending_upload');
  });
  await t.test('timeout while waiting for the asset lock closes the not-yet-piped stream', async () => {
    const v = await seed(), { asset } = await create(v);
    let started; const reading = new Promise(resolve => { started = resolve; });
    const first = new Readable({ read() { started(); } });
    const upload = service.upload(v.principal, v.scope, asset.id, first);
    await reading;
    const queued = new PassThrough();
    const fast = new TemporaryFileService({ host: f.host, idleMs: 25, pollMs: 1_000 });
    let admitted; const admission = new Promise(resolve => { admitted = resolve; });
    const checkpoint = fast.checkpoint.bind(fast);
    fast.checkpoint = async (...args) => { const result = await checkpoint(...args); admitted(); return result; };
    const refused = assert.rejects(fast.upload(v.principal, v.scope, asset.id, queued), { code: 'temporary_upload_idle' });
    await admission;
    await new Promise(resolve => setTimeout(resolve, 100));
    const closedBeforeRelease = queued.destroyed;
    first.push(bytes); first.push(null); await upload; await refused;
    assert.equal(closedBeforeRelease, true, 'deadline closes input before the earlier upload releases its lock');
    assert.equal(queued.destroyed, true);
    assert.deepEqual(await readFile((await assets.getFileAsset(asset.id)).localizedPath), bytes);
  });
  await t.test('concurrent reservations cap declared storage across original grant Sessions', async () => {
    const v = await seed();
    const second = await sessions.create(v.principal, { tool: 'codex', idempotencyKey: 'second-quota-session' });
    const secondScope = { version: 1, sessionId: second.session.sessionId,
      expectedScopeRevision: second.session.scopeRevision, expectedProjectId: second.session.projectId };
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => create({ ...v,
      scope: i % 2 ? secondScope : v.scope,
      input: { ...v.input, requestId: `large-${i}`, sizeBytes: 25 * 1024 * 1024 } })));
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 4);
    assert.equal(outcomes.find(r => r.status === 'rejected').reason.code, 'RESOURCE_LIMIT');
    const replay = await create({ ...v, input: { ...v.input, requestId: 'large-0', sizeBytes: 25 * 1024 * 1024 } });
    assert.equal(replay.duplicate, true);
    assert.ok((await readdir(CHAT_FILE_ASSETS_DIR)).length > 0);
  });
  await t.test('file count reservations and capability limits cannot be bypassed with tiny files', async () => {
    const v = await seed();
    const outcomes = await Promise.allSettled(Array.from({ length: 65 }, (_, i) => create({ ...v,
      input: { ...v.input, requestId: `tiny-${i}`, sizeBytes: 1 } })));
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 64);
    assert.equal(outcomes.find(r => r.status === 'rejected').reason.code, 'RESOURCE_LIMIT');
    const restricted = await seed({ capabilities: ['task.create', 'task.read'] });
    await assert.rejects(create(restricted), { code: 'temporary_resource_denied' });
  });
  await t.test('revocation inside finalization publication prevents the ready state', async () => {
    const v = await seed(), { asset } = await create(v);
    await service.upload(v.principal, v.scope, asset.id, Readable.from([bytes]));
    const original = f.host.resourcePolicy.authorize; let checks = 0;
    f.host.resourcePolicy.authorize = async function (...args) {
      if (args[1] === 'upload.finalize' && ++checks === 3) await f.host.revoke(v.phone.claim.invitationId);
      return original.apply(this, args);
    };
    try {
      await assert.rejects(service.finalize(v.principal, v.scope, asset.id, { sizeBytes: bytes.length }),
        { code: 'temporary_pairing_inactive' });
    } finally { f.host.resourcePolicy.authorize = original; }
    assert.equal(checks, 3); assert.equal((await assets.getFileAsset(asset.id)).status, 'pending_upload');
  });
  await t.test('original deadline is checked again before returning receipts', async () => {
    const v = await seed(); await create(v); f.advance(v.principal.expiry - f.clock());
    await assert.rejects(service.receipt(v.principal, v.scope, v.input.requestId), { code: 'temporary_pairing_inactive' });
  });
});
