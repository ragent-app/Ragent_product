import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PassThrough } from 'node:stream';

test('encrypted HTTP relay reaches the actual verified local asset store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentoc-relay-integration-'));
  process.env.AGENTOC_INSTANCE_ROOT = root;
  process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
  process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
  process.env.AGENTOC_ACCOUNTS_URL = 'https://accounts.example';
  for (const name of ['AGENTOC_MEMORY_DIR', 'AGENTOC_RUN_SPOOL_DIR', 'AGENTOC_PROVIDER_HOMES_DIR',
    'AGENTOC_WORK_ROOT_DIR', 'AGENTOC_PLATFORM_SKILLS_DIR', 'AGENTOC_INSTANCE_KEY_FILE',
    'AGENTOC_ASSET_STORAGE_BASE_URL', 'AGENTOC_ASSET_STORAGE_ACCESS_KEY_ID', 'AGENTOC_ASSET_STORAGE_SECRET_ACCESS_KEY']) delete process.env[name];
  let server;
  const nativeFetch = globalThis.fetch;
  try {
    const { startAccountsServer } = await import('../accounts/server.mjs');
    const { createFileAssetUploadIntent, getFileAsset } = await import('../chat/file-assets.mjs');
    const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
    const { encryptRelayRecord, relayWireBytes, RELAY_RECORD_BYTES } = await import('../chat/file-asset-relay-crypto.mjs');
    server = await startAccountsServer({ host: '127.0.0.1', port: 0, logger: { level: 'silent' },
      dataFile: join(root, 'accounts.json'), signingKeyFile: join(root, 'signing.json'),
      turnBrokerSigningKeyFile: join(root, 'turn-signing.json'), attachmentRelayEnabled: true });
    server.broker.authenticateAccountAsr = async () => ({ accountId: 'fixture-account' });
    const bytes = randomBytes(33 * 1024 * 1024 + 3);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const intent = await createFileAssetUploadIntent({ sessionId: 's', requestId: 'relay-integration',
      originalName: 'fixture.bin', mimeType: 'application/octet-stream', sizeBytes: bytes.length, sha256: hash });
    const asset = await getFileAsset(intent.asset.id);
    const reservation = await server.fastify.inject({ method: 'POST', url: '/v1/owner-auth/account/attachment-relay/reservations',
      headers: { authorization: 'Bearer fixture' }, payload: { sizeBytes: relayWireBytes(bytes.length) } });
    assert.equal(reservation.statusCode, 201);
    const ticket = reservation.json(), key = randomBytes(32), transferId = randomBytes(16).toString('hex');
    const origin = `http://127.0.0.1:${server.server.address().port}`;
    globalThis.fetch = (url, options) => {
      if (!String(url).startsWith('https://accounts.example/')) throw new Error('Unexpected outbound test URL');
      return nativeFetch(`${origin}${new URL(url).pathname}`, { ...options,
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)].filter(Boolean)) });
    };
    async function route(method, payload, query = {}, authSession = { role: 'owner' }, action = 'relay') {
      const req = new PassThrough(); req.method = method; req.headers = {};
      req.end(payload ? JSON.stringify(payload) : undefined);
      const res = { setHeader() {} };
      const handled = await handleControlRoutes({ req, res, pathname: `/api/assets/${asset.id}/${action}`,
        parsedUrl: { query }, fileAssetRoute: { assetId: asset.id, action }, authSession,
        requireSessionAccess: async () => true,
        writeJson: (_res, status, body) => Object.assign(res, { status, body }) });
      assert.equal(handled, true);
      return res;
    }
    const payload = { relayId: ticket.id, readToken: ticket.readToken, transferId, key: key.toString('base64url') };
    assert.equal((await route('POST', payload, {}, { role: 'visitor' })).status, 403);
    const started = await route('POST', payload);
    assert.equal(started.status, 202);
    const job = started.body;
    let finalizeFinished = false;
    const finalizePromise = route('POST', { sizeBytes: bytes.length }, {}, { role: 'owner' }, 'finalize')
      .then(value => { finalizeFinished = true; return value; });
    await delay(25);
    assert.equal(finalizeFinished, false, 'finalize must wait for the relay receiver');
    const frames = [];
    for (let offset = 0, index = 0; offset < bytes.length; offset += RELAY_RECORD_BYTES, index++) {
      frames.push(encryptRelayRecord({ key, transferId, totalBytes: bytes.length, index,
        plaintext: bytes.subarray(offset, offset + RELAY_RECORD_BYTES) }));
    }
    const response = await nativeFetch(`${origin}/v1/owner-auth/account/attachment-relay/${ticket.id}/content`, {
      method: 'PUT', headers: { authorization: `Bearer ${ticket.writeToken}`,
        'content-type': 'application/vnd.agentoc.attachment-relay' }, body: Buffer.concat(frames), signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 204);
    const finalized = await finalizePromise;
    assert.equal(finalized.status, 200);
    assert.equal(finalized.body.asset.status, 'ready');
    assert.deepEqual(await readFile((await getFileAsset(asset.id)).localizedPath), bytes);
    assert.equal((await route('GET', null, { jobId: job.jobId })).status, 404);
  } finally {
    globalThis.fetch = nativeFetch;
    server?.server.closeAllConnections();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
