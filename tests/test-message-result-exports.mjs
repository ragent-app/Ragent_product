import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = process.env.RAGENT_EXPORT_TEST_ROOT || await mkdtemp(join(tmpdir(), 'ragent-result-export-'));
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_ASSET_STORAGE_BASE_URL;
delete process.env.RAGENT_ASSET_STORAGE_PUBLIC_BASE_URL;
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
const { createSessionWithOutcome, getSessionMeta } = await import('../chat/session-manager.mjs');
const { createRun, updateRun } = await import('../chat/runs.mjs');
const { appendEvent } = await import('../chat/history.mjs');
const { messageEvent } = await import('../chat/normalizer.mjs');
const { publishLocalFileAssetFromPath, getFileAsset } = await import('../chat/file-assets.mjs');
const { loadOrCreateInstanceIdentity } = await import('../lib/instance-identity.mjs');
const { CONFIG_DIR, CHAT_RUNS_DIR } = await import('../lib/config.mjs');
assert.equal(resolve(CONFIG_DIR), resolve(join(root, 'config')));
const identity = await loadOrCreateInstanceIdentity();
const hash = value => createHash('sha256').update(value).digest('hex');
let authorizationChecks = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const parsedUrl = { pathname: url.pathname, query: Object.fromEntries(url.searchParams) };
  const visitor = req.headers['x-fixture-role'] === 'visitor';
  let requestChecks = 0;
  try {
    const handled = await handleSessionMainRoutes({ req, res, parsedUrl, pathname: parsedUrl.pathname,
      authSession: { role: visitor ? 'visitor' : 'owner', capabilities: { downloadArtifacts: req.headers['x-fixture-download'] === 'yes' } },
      requireSessionAccess: async (response, auth, id, options) => {
        authorizationChecks++; assert.equal(options?.metadataOnly, true);
        requestChecks++;
        if (req.headers['x-fixture-revoke-download'] === 'yes' && requestChecks > 1) auth.capabilities.downloadArtifacts = false;
        if (req.headers['x-fixture-deny'] === 'yes' ||
            (req.headers['x-fixture-revoke'] === 'yes' && requestChecks > 1) || !await getSessionMeta(id)) {
          response.writeHead(403); response.end(JSON.stringify({ error: 'Fixture Session gate denied' })); return false;
        }
        return true;
      },
      writeJson: (response, status, body) => { response.statusCode = status; response.end(JSON.stringify(body)); },
    });
    if (!handled) { res.writeHead(404); res.end(); }
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ fixtureError: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function request(path, headers = {}) {
  const response = await fetch(origin + path, { headers });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
const base = (session, key) => `/api/sessions/${session}/message-results/${encodeURIComponent(key)}/exports`;
const chunkPath = (path, manifest, id, offset, length = manifest.maxChunkBytes) =>
  `${path}/${id}?revision=${manifest.revision}&offset=${offset}&length=${length}`;
async function download(path, manifest, resource) {
  const blocks = []; let offset = 0;
  do {
    const response = await request(chunkPath(path, manifest, resource.resourceId, offset));
    assert.equal(response.status, 200);
    const part = response.body; const bytes = Buffer.from(part.dataBase64, 'base64');
    assert.equal(part.instanceId, identity.instanceId); assert.equal(part.sessionId, manifest.sessionId);
    assert.equal(part.requestId, manifest.requestId); assert.equal(part.runId, manifest.runId);
    assert.equal(part.finalRunId, manifest.finalRunId); assert.equal(part.revision, manifest.revision);
    assert.equal(part.resourceId, resource.resourceId); assert.equal(part.offset, offset);
    assert.ok(bytes.length <= manifest.maxChunkBytes); assert.equal(part.chunkSha256, hash(bytes));
    assert.equal(part.nextOffset, offset + bytes.length); assert.equal(part.sha256, resource.sha256);
    assert.equal(part.sizeBytes, resource.sizeBytes); assert.equal(part.eof, part.nextOffset === resource.sizeBytes);
    blocks.push(bytes); offset = part.nextOffset;
  } while (offset < resource.sizeBytes);
  const bytes = Buffer.concat(blocks); assert.equal(bytes.length, resource.sizeBytes); assert.equal(hash(bytes), resource.sha256);
  return bytes;
}

try {
  if (process.argv[2] === 'cold') {
    const testCase = JSON.parse(process.env.RAGENT_EXPORT_TEST_CASE);
    const response = await request(chunkPath(testCase.path, testCase.manifest, testCase.resource.resourceId, 0));
    assert.equal(response.status, 200); assert.equal(response.body.chunkSha256, testCase.firstHash);
    assert.equal(response.body.revision, testCase.manifest.revision);
    console.log('Cold HTTP export chunk recovered existing immutable snapshot');
  } else {
    const contract = await request('/api/result-export-contract');
    assert.equal(contract.status, 200); assert.equal(contract.body.version, 1);
    assert.equal(contract.body.maxChunkBytes, 65_536); assert.equal(contract.body.maxResources, 17);
    const session = (await createSessionWithOutcome(root, 'codex', 'Synthetic export')).session;
    const other = (await createSessionWithOutcome(root, 'codex', 'Unrelated export')).session;
    const bytes = Buffer.from(Array.from({ length: 180_000 }, (_, index) => index % 256));
    const source = join(root, 'synthetic-report.bin'); await writeFile(source, bytes);
    const asset = await publishLocalFileAssetFromPath({ sessionId: session.id, localPath: source,
      originalName: '合成报告.bin', mimeType: 'application/octet-stream' });
    const run = await createRun({ status: { sessionId: session.id, requestId: 'export-key', responseId: 'export-key', state: 'completed' }, manifest: {} });
    const text = 'Full export beyond snapshot preview 🙂\n'.repeat(8_000) + 'END';
    await appendEvent(session.id, { ...messageEvent('assistant', text), runId: run.id, responseId: 'export-key',
      attachments: [{ assetId: asset.id, originalName: asset.originalName, mimeType: asset.mimeType, sizeBytes: bytes.length },
        { downloadUrl: 'https://example.com/private-reference', originalName: '   ' }] });
    const statePath = join(CHAT_RUNS_DIR, run.id, 'status.json');
    const stateBefore = await readFile(statePath, 'utf8');
    const sessionsBefore = await readFile(join(CONFIG_DIR, 'chat-sessions.json'), 'utf8');
    const path = base(session.id, 'export-key');
    const response = await request(path); assert.equal(response.status, 200);
    const manifest = response.body;
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(manifest.exportContractVersion, 1); assert.equal(manifest.instanceId, identity.instanceId);
    assert.equal(manifest.sessionId, session.id); assert.equal(manifest.requestId, 'export-key');
    assert.equal(manifest.runId, run.id); assert.equal(manifest.finalRunId, run.id);
    assert.equal(manifest.maxChunkBytes, 65_536); assert.equal(manifest.resources.length, 3);
    assert.ok(!JSON.stringify(manifest).includes(root)); assert.ok(!JSON.stringify(manifest).includes('https://'));
    const textResource = manifest.resources.find(item => item.resourceId === 'text');
    const fileResource = manifest.resources.find(item => item.resourceId === asset.id);
    const unavailable = manifest.resources.find(item => !item.available);
    assert.equal(unavailable.errorCode, 'CAPABILITY_UNSUPPORTED');
    assert.equal(unavailable.originalName, 'Result reference');
    assert.equal((await download(path, manifest, textResource)).toString('utf8'), text);
    assert.deepEqual(await download(path, manifest, fileResource), bytes);
    const retryA = await request(chunkPath(path, manifest, asset.id, 65_536));
    const retryB = await request(chunkPath(path, manifest, asset.id, 65_536));
    assert.equal(retryA.body.dataBase64, retryB.body.dataBase64);
    assert.equal((await request(chunkPath(path, manifest, asset.id, bytes.length))).body.eof, true);
    assert.equal((await request(chunkPath(path, manifest, asset.id, bytes.length + 1))).status, 400);
    assert.equal((await request(chunkPath(path, manifest, asset.id, 0, 65_537))).status, 400);
    assert.equal((await request(chunkPath(path, manifest, asset.id, 0) + '&offset=2')).status, 400);
    assert.equal((await request(path + '?autoStart=true')).status, 400);
    assert.equal((await request(chunkPath(path, manifest, unavailable.resourceId, 0))).status, 404);
    assert.equal((await request(chunkPath(base(other.id, 'export-key'), manifest, asset.id, 0))).status, 409);
    assert.equal((await request(path, { 'x-fixture-role': 'visitor' })).status, 403);
    assert.equal((await request(chunkPath(path, manifest, 'text', 0), { 'x-fixture-role': 'visitor' })).status, 403);
    assert.equal((await request(chunkPath(path, manifest, 'text', 0), { 'x-fixture-deny': 'yes' })).status, 403);
    assert.equal((await request(chunkPath(path, manifest, 'text', 0), { 'x-fixture-revoke': 'yes' })).status, 403);
    assert.equal((await request(path, { 'x-fixture-revoke': 'yes' })).status, 403);
    assert.equal((await request(path, { 'x-fixture-role': 'visitor', 'x-fixture-download': 'yes' })).status, 200);
    const revokedDownload = { 'x-fixture-role': 'visitor', 'x-fixture-download': 'yes', 'x-fixture-revoke-download': 'yes' };
    assert.equal((await request(path, revokedDownload)).status, 403);
    assert.equal((await request(chunkPath(path, manifest, 'text', 0), revokedDownload)).status, 403);
    await promisify(execFile)(process.execPath, [import.meta.filename, 'cold'], { env: { ...process.env,
      RAGENT_EXPORT_TEST_ROOT: root, RAGENT_EXPORT_TEST_CASE: JSON.stringify({ path, manifest, resource: fileResource,
        firstHash: hash(bytes.subarray(0, 65_536)) }) } });
    assert.equal(await readFile(statePath, 'utf8'), stateBefore);
    assert.equal(await readFile(join(CONFIG_DIR, 'chat-sessions.json'), 'utf8'), sessionsBefore);
    const assetRecord = await getFileAsset(asset.id);
    await writeFile(assetRecord.localizedPath, Buffer.alloc(bytes.length, 42));
    assert.equal((await request(path)).status, 409, 'Changed source bytes must not yield a manifest');
    assert.deepEqual(await download(path, manifest, fileResource), bytes, 'Frozen authorized revision remains immutable');
    const final = await createRun({ status: { sessionId: session.id, requestId: 'repair-key', responseId: 'export-key',
      replyPublicationRootRunId: run.id, state: 'completed' }, manifest: {} });
    await appendEvent(session.id, { ...messageEvent('assistant', 'New final publication'), runId: final.id, responseId: 'export-key' });
    await updateRun(run.id, value => ({ ...value, replyPublication: { state: 'ready', rootRunId: run.id,
      finalRunId: final.id, continuationRunIds: [final.id], responseIds: ['export-key'] } }));
    assert.equal((await request(chunkPath(path, manifest, 'text', 0))).status, 409, 'Changed final Run invalidates an old snapshot');
    const cacheDir = join(CONFIG_DIR, 'result-exports', 'v1', manifest.revision);
    assert.ok((await readdir(cacheDir)).includes('manifest.json'));
    const manifestPath = join(cacheDir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ ...manifest, expiresAt: new Date(0).toISOString() }));
    assert.equal((await request(chunkPath(path, manifest, 'text', 0))).status, 410);
    assert.ok(authorizationChecks >= 20);
    console.log('HTTP exports: exact identity, full text/binary, bounded chunks, retry/EOF, authorization/revocation, cold snapshot, expiry and integrity passed');
  }
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (process.argv[2] !== 'cold') {
    assert.equal(resolve(dirname(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('ragent-result-export-'));
    await rm(root, { recursive: true, force: true });
  }
}
