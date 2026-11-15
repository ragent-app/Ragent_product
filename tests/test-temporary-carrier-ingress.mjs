import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, sign } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';

test('temporary carrier routes authenticate the original phone and keep Owner upstream closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-ingress-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  process.env.RAGENT_CONFIG_DIR = join(root, 'config'); process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
  delete process.env.RAGENT_INSTANCE_ROOT;
  const { fixture } = await import('./helpers/temporary-turn-fixture.mjs');
  const { TemporarySessionService } = await import('../chat/temporary-session-service.mjs');
  const { TemporaryMessageService } = await import('../chat/temporary-message-service.mjs');
  const { TemporaryFileService } = await import('../chat/temporary-file-service.mjs');
  const { TemporaryResultService } = await import('../chat/temporary-result-service.mjs');
  const { temporaryDeviceJwk } = await import('../lib/temporary-device-access.mjs');
  const { TEMPORARY_CARRIER_ORIGIN, temporaryCarrierRoute } = await import('../lib/temporary-carrier-routes.mjs');
  const { runP2PHostAgent } = await import('../lib/p2p-host-agent.mjs');
  const { handleTemporaryCarrierRequest } = await import('../chat/temporary-carrier-ingress.mjs');
  const f = await fixture(t, { initialTime: Date.now() });
  const phone = await f.enroll(), other = await f.enroll();
  f.host.sessions = new TemporarySessionService({ host: f.host, workRoot: join(root, 'work'),
    availableTools: async () => [{ id: 'codex', name: 'CodeX', available: true }],
    runtimeCatalog: async tools => tools.map(tool => ({ id: tool.id, name: tool.name, ready: true, status: 'ready' })) });
  f.host.messages = new TemporaryMessageService({ host: f.host, schedule: () => {} });
  f.host.files = new TemporaryFileService({ host: f.host });
  f.host.results = new TemporaryResultService({ host: f.host });
  const temporaryDevice = { instanceId: f.identity.instanceId, grantId: phone.result.grantId,
    deviceId: phone.result.deviceId, accessExpiresAt: phone.accessCredential.expires_at };
  const prefix = `/api/temporary/v1/instances/${f.identity.instanceId}`;
  const scopeHeader = scope => Buffer.from(JSON.stringify(scope)).toString('base64url');
  const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  function proof(target, path, method = 'GET', overrideTarget) {
    const htu = overrideTarget || `${TEMPORARY_CARRIER_ORIGIN}${new URL(path, TEMPORARY_CARRIER_ORIGIN).pathname}`;
    const data = `${enc({ typ: 'dpop+jwt', alg: 'ES256', jwk: temporaryDeviceJwk(target.claim.devicePublicKey).jwk })}.${enc({
      htm: method, htu, iat: Math.floor(f.clock() / 1000), jti: randomBytes(24).toString('base64url'),
      ath: createHash('sha256').update(target.accessCredential.access_token).digest('base64url') })}`;
    return `${data}.${sign('sha256', Buffer.from(data), { key: target.device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  }
  let forwarded = 0;
  const upstream = createServer((req, res) => { forwarded++; res.writeHead(200); res.end('Owner upstream'); });
  const ws = new WebSocketServer({ server: upstream, path: '/signal' });
  ws.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'join') socket.send(JSON.stringify({ type: 'joined', roomId: message.roomId, role: message.role }));
  }));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { ws.close(); upstream.closeAllConnections(); upstream.close(resolve); }));
  let agent;
  try {
    agent = await runP2PHostAgent({ signalingUrl: `http://127.0.0.1:${upstream.address().port}/signal`,
      localBaseUrl: `http://127.0.0.1:${upstream.address().port}`, roomId: 'a'.repeat(40),
      secret: 'fixture-only-secret', binaryPath: process.execPath,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), temporaryDevice, relayOnly: true,
      iceServers: [{ urls: 'turn:fixture.invalid:3478', username: 'fixture', password: 'fixture' }],
      temporaryIngress: (req, res) => handleTemporaryCarrierRequest(req, res, { host: f.host, temporaryDevice }) });
    await agent.ready;
    assert.equal(agent.temporaryBusinessReady, true);
    const origin = new URL(agent.gatewayUrl);
    async function request(path, { method = 'GET', target = phone, body, scope, extraHeaders = {}, dpop } = {}) {
      const json = body && !Buffer.isBuffer(body); const content = body == null ? null : json ? Buffer.from(JSON.stringify(body)) : body;
      const headers = { authorization: `DPoP ${target.accessCredential.access_token}`,
        dpop: dpop || proof(target, path, method), ...(scope ? { 'x-ragent-app-api-scope': scopeHeader(scope) } : {}),
        ...(content ? { 'content-type': json ? 'application/json' : 'application/octet-stream', 'content-length': String(content.length) } : {}),
        ...extraHeaders };
      return new Promise((done, reject) => {
        const req = httpRequest({ hostname: origin.hostname, port: origin.port, path, method, headers }, res => {
          const parts = []; res.on('data', part => parts.push(part)); res.on('end', () => {
            const raw = Buffer.concat(parts).toString('utf8');
            done({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : null });
          });
        });
        req.on('error', reject); req.end(content);
      });
    }
    const createPath = `${prefix}/sessions`;
    const runtimePath = `${prefix}/runtimes`;
    assert.equal(temporaryCarrierRoute('GET', runtimePath).action, 'runtime.list');
    const runtimeResponse = await request(runtimePath);
    assert.equal(runtimeResponse.status, 200);
    assert.deepEqual(runtimeResponse.body.runtimes, [{ id: 'codex', name: 'CodeX', ready: true, status: 'ready' }]);
    assert.equal(temporaryCarrierRoute('POST', createPath).action, 'session.create');
    for (const path of ['/api/sessions', '/api/auth/google/token', `${prefix}/owner`, '/healthz']) {
      const response = await request(path, { method: 'POST' }); assert.equal(response.status, 403);
    }
    assert.equal(forwarded, 0);
    const created = await request(createPath, { method: 'POST', body: { idempotencyKey: 'test-session', tool: 'codex' } });
    assert.equal(created.status, 200);
    const sessionId = created.body.session.sessionId;
    const scope = { version: 1, sessionId, expectedScopeRevision: created.body.session.scopeRevision,
      expectedProjectId: created.body.session.projectId };
    const sessionPath = `${prefix}/sessions/${sessionId}`;
    const signed = proof(phone, sessionPath);
    assert.equal((await request(sessionPath, { scope, dpop: signed,
      extraHeaders: { host: 'forged.example', 'x-forwarded-host': 'forged.example' } })).status, 200);
    assert.equal((await request(sessionPath, { scope, dpop: signed })).status, 401, 'proof replay is durable');
    assert.equal((await request(sessionPath, { scope, dpop: proof(phone, sessionPath, 'GET',
      'https://forged.example/api/temporary') })).status, 401);
    assert.equal((await request(sessionPath, { scope, extraHeaders: { cookie: 'owner=fake' } })).status, 401);
    assert.equal((await request(sessionPath, { scope, target: other })).status, 403);
    const prepared = await request(`${sessionPath}/messages/prepare`, { method: 'POST', scope,
      body: { version: 1, requestId: 'phone-message-1', text: '从荣耀发往电脑的测试', runOptions: {}, attachments: [],
        expiresAt: new Date(Math.min(Date.now() + 60_000, phone.accessCredential.expires_at)).toISOString() } });
    assert.equal(prepared.status, 200);
    const committed = await request(`${sessionPath}/messages/phone-message-1/commit`, { method: 'POST', scope,
      body: { version: 1, preparationId: prepared.body.preparationId } });
    assert.equal(committed.status, 200); assert.equal(committed.body.accepted, true);
    const runId = committed.body.runId;
    assert.equal((await request(`${sessionPath}/runs/${runId}`, { scope })).body.run.runId, runId);
    const cancel = await request(`${sessionPath}/runs/${runId}/cancel`, { method: 'POST', scope,
      body: { version: 1, expiresAt: new Date(Math.min(Date.now() + 60_000, phone.accessCredential.expires_at)).toISOString() } });
    assert.equal(cancel.status, 200); assert.equal(cancel.body.run.state, 'cancelled');
    const bytes = Buffer.from('hello from temporary file');
    const intent = await request(`${sessionPath}/assets`, { method: 'POST', scope,
      body: { requestId: 'phone-file-1', originalName: 'test.txt', mimeType: 'text/plain',
        sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
    assert.equal(intent.status, 200);
    const assetId = intent.body.asset.id;
    assert.equal((await request(`${sessionPath}/assets/${assetId}/upload`, { method: 'POST', scope, body: bytes })).status, 200);
    assert.equal((await request(`${sessionPath}/assets/${assetId}/finalize`, { method: 'POST', scope,
      body: { sizeBytes: bytes.length } })).body.asset.status, 'ready');
    assert.equal((await request(`${sessionPath}/assets/receipts/phone-file-1`, { scope })).body.asset.id, assetId);
    // Exercise the new byte checkpoint route through the real local P2P gateway,
    // with fresh device proofs on every request and no Owner HTTP fallback.
    const chunkBytes = 256 * 1024;
    const largeBytes = Buffer.concat([Buffer.alloc(chunkBytes, 34), Buffer.from('synthetic tail')]);
    const sha256 = value => createHash('sha256').update(value).digest('hex');
    const chunkIntent = await request(`${sessionPath}/assets`, { method: 'POST', scope,
      body: { requestId: 'phone-chunks-1', originalName: 'chunks.bin', mimeType: 'application/octet-stream',
        sizeBytes: largeBytes.length, sha256: sha256(largeBytes) } });
    assert.equal(chunkIntent.body.resumableUpload.version, 1);
    const chunkPath = `${sessionPath}/assets/${chunkIntent.body.asset.id}`;
    assert.equal((await request(`${chunkPath}/upload-checkpoint`, { scope })).body.offset, 0);
    assert.equal((await request(`${chunkPath}/upload-checkpoint`, { scope, target: other })).status, 403);
    const firstPart = largeBytes.subarray(0, chunkBytes);
    const chunkHeaders = { 'x-ragent-upload-offset': '0', 'x-ragent-upload-length': String(chunkBytes),
      'x-ragent-upload-sha256': sha256(firstPart) };
    assert.equal((await request(`${chunkPath}/upload`, { method: 'PATCH', scope, body: firstPart,
      extraHeaders: chunkHeaders })).body.offset, chunkBytes);
    assert.equal((await request(`${chunkPath}/upload`, { method: 'PATCH', scope, body: firstPart,
      extraHeaders: chunkHeaders })).body.offset, chunkBytes, 'A lost acknowledgement cannot append duplicate bytes');
    assert.equal((await request(`${chunkPath}/finalize`, { method: 'POST', scope,
      body: { sizeBytes: largeBytes.length } })).body.code, 'FILE_ASSET_UPLOAD_INCOMPLETE');
    const tail = largeBytes.subarray(chunkBytes);
    const uploaded = await request(`${chunkPath}/upload`, { method: 'PATCH', scope, body: tail,
      extraHeaders: { 'x-ragent-upload-offset': String(chunkBytes), 'x-ragent-upload-length': String(tail.length),
        'x-ragent-upload-sha256': sha256(tail) } });
    assert.equal(uploaded.status, 200); assert.equal(uploaded.body.status, 'uploaded');
    const chunkReady = await request(`${chunkPath}/finalize`, { method: 'POST', scope,
      body: { sizeBytes: largeBytes.length } });
    assert.equal(chunkReady.status, 200); assert.equal(chunkReady.body.asset.status, 'ready');
    assert.equal(chunkReady.body.asset.sha256, sha256(largeBytes));
    assert.equal((await request(`${chunkPath}/upload-checkpoint`, { scope })).body.status, 'ready');
    assert.equal(/localizedPath|principalScope|fingerprint|Url/.test(JSON.stringify([chunkIntent.body,
      uploaded.body, chunkReady.body])), false);
    const cancelledIntent = await request(`${sessionPath}/assets`, { method: 'POST', scope,
      body: { requestId: 'phone-chunks-cancel', originalName: 'cancel.bin', mimeType: 'application/octet-stream',
        sizeBytes: largeBytes.length, sha256: sha256(largeBytes) } });
    const cancelPath = `${sessionPath}/assets/${cancelledIntent.body.asset.id}/upload-checkpoint`;
    assert.equal((await request(cancelPath, { method: 'DELETE', scope })).body.status, 'cancelled');
    assert.equal((await request(cancelPath, { scope })).status, 410);
    assert.equal(forwarded, 0);
    await f.host.revoke(phone.claim.invitationId);
    assert.equal((await request(sessionPath, { scope })).status, 410);
    assert.equal((await request(`${chunkPath}/upload-checkpoint`, { scope })).status, 410);
  } finally { agent?.stop(); await agent?.done; }
});
