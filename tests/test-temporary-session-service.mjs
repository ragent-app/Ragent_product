import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash, randomBytes, sign } from 'node:crypto';

test('temporary Sessions use production durable creation and scope services', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-session-'));
  process.env.RAGENT_CONFIG_DIR = join(root, 'config');
  process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
  delete process.env.RAGENT_INSTANCE_ROOT;
  const { fixture } = await import('./helpers/temporary-turn-fixture.mjs');
  const { temporaryDeviceJwk } = await import('../lib/temporary-device-access.mjs');
  const { TemporarySessionService } = await import('../chat/temporary-session-service.mjs');
  const { findSessionMeta, loadSessionsMeta, mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
  const { CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');
  const f = await fixture(t);
  const tools = async () => [{ id: 'codex', name: 'CodeX', available: true }];
  const runtimeCatalog = async rows => rows.map(tool => ({ id: tool.id, name: tool.name, ready: true, status: 'ready' }));
  const service = new TemporarySessionService({ host: f.host, workRoot: join(root, 'work'), availableTools: tools, runtimeCatalog });
  const scope = result => ({ version: 1, sessionId: result.session.sessionId,
    expectedScopeRevision: result.session.scopeRevision, expectedProjectId: result.session.projectId });
  async function device() {
    const phone = await f.enroll();
    const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
    const targetUri = 'https://pc.example.test/api/temporary/sessions';
    const data = `${enc({ typ: 'dpop+jwt', alg: 'ES256', jwk: temporaryDeviceJwk(phone.claim.devicePublicKey).jwk })}.${enc({
      htm: 'POST', htu: targetUri, iat: Math.floor(f.clock() / 1000), jti: randomBytes(24).toString('base64url'),
      ath: createHash('sha256').update(phone.accessCredential.access_token).digest('base64url') })}`;
    const proof = `${data}.${sign('sha256', Buffer.from(data), { key: phone.device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    return { phone, principal: await f.host.authenticateRequest({ credential: phone.accessCredential, proof, method: 'POST', targetUri }) };
  }
  try {
    await t.test('concurrent retries persist one scoped Session and never start a Run', async () => {
      const { principal } = await device(); const payload = { idempotencyKey: 'first', tool: 'codex', name: '手机测试' };
      const catalog = await service.listRuntimes(principal);
      assert.deepEqual(catalog, { version: 1, runtimes: [{ id: 'codex', name: 'CodeX', ready: true, status: 'ready' }] });
      const results = await Promise.all(Array.from({ length: 5 }, () => service.create(principal, payload)));
      assert.equal(new Set(results.map(r => r.session.sessionId)).size, 1);
      assert.equal(results.filter(r => !r.duplicate).length, 1);
      const first = results[0]; const meta = await findSessionMeta(first.session.sessionId);
      assert.equal(meta.createdByPrincipalId, principal.grantId);
      assert.equal(meta.createdByPrincipalKind, 'temporary_device'); assert.equal(meta.creationRequest.state, 'complete');
      assert.equal(meta.riskMode, 'safe'); assert.equal(meta.activeRunId, undefined);
      assert.equal(meta.projectId || null, null); assert.equal(first.startsRun, false);
      assert.equal(meta.folder, join(root, 'work', 'temporary', principal.grantId));
      const disk = JSON.parse(await readFile(CHAT_SESSIONS_FILE, 'utf8'));
      assert.equal(disk.filter(s => s.id === meta.id).length, 1);
      assert.equal(JSON.stringify(first).includes(meta.folder), false);
      assert.equal(JSON.stringify(first).includes(principal.grantId), false);
      assert.equal((await service.read(principal, scope(first))).session.sessionId, meta.id);
      const cold = new TemporarySessionService({ host: f.host, workRoot: join(root, 'work'), availableTools: async () => [] });
      assert.equal((await cold.create(principal, payload)).duplicate, true, 'replay survives tool availability changes');
      await assert.rejects(service.create(principal, { ...payload, name: 'different' }), { code: 'SESSION_IDEMPOTENCY_CONFLICT' });
    });
    await t.test('phone cannot inject filesystem, templates, privilege or provenance', async () => {
      const { principal } = await device(); const before = (await loadSessionsMeta()).length;
      for (const key of ['folder', 'projectId', 'systemPrompt', 'riskMode', 'createdByPrincipalId', 'creationRequest', 'internalRole', 'templateId'])
        await assert.rejects(service.create(principal, { tool: 'codex', idempotencyKey: key, [key]: 'untrusted' }), { code: 'temporary_session_input_invalid' });
      await assert.rejects(service.create(principal, { tool: 'missing', idempotencyKey: 'missing' }), { code: 'temporary_session_tool_unavailable' });
      const notConfigured = new TemporarySessionService({ host: f.host, workRoot: join(root, 'work'),
        availableTools: tools, runtimeCatalog: async rows => rows.map(tool => ({ id: tool.id,
          name: tool.name, ready: false, status: 'provider-not-configured' })) });
      await assert.rejects(notConfigured.create(principal, { tool: 'codex', idempotencyKey: 'provider-missing' }),
        { code: 'temporary_session_tool_unavailable' });
      assert.equal((await loadSessionsMeta()).length, before);
    });
    await t.test('revocation during tool IO prevents durable Session publication', async () => {
      const { principal, phone } = await device(); const before = (await loadSessionsMeta()).length;
      const racing = new TemporarySessionService({ host: f.host, workRoot: join(root, 'work'), availableTools: async () => {
        await f.host.revoke(phone.claim.invitationId); return tools();
      }, runtimeCatalog });
      await assert.rejects(racing.create(principal, { tool: 'codex', idempotencyKey: 'revoked' }), { code: 'temporary_pairing_inactive' });
      assert.equal((await loadSessionsMeta()).length, before);
    });
    await t.test('foreign grants and changed resource scopes cannot read the Session', async () => {
      const a = await device(), b = await device();
      const result = await service.create(a.principal, { tool: 'codex', idempotencyKey: 'scoped' });
      await assert.rejects(service.read(b.principal, scope(result)), { code: 'temporary_resource_denied' });
      await mutateSessionMeta(result.session.sessionId, draft => { draft.folder = join(root, 'moved'); return true; });
      await assert.rejects(service.read(a.principal, scope(result)), { code: 'REVISION_CONFLICT' });
    });
    await t.test('revocation after acceptance withholds the response but preserves the committed fact', async () => {
      const { principal, phone } = await device();
      const original = f.host.resourcePolicy.authorize;
      let checks = 0;
      f.host.resourcePolicy.authorize = async function (...args) {
        if (++checks === 3) await f.host.revoke(phone.claim.invitationId);
        return original.apply(this, args);
      };
      try {
        await assert.rejects(service.create(principal, { tool: 'codex', idempotencyKey: 'late-revoke' }), { code: 'temporary_pairing_inactive' });
      } finally { f.host.resourcePolicy.authorize = original; }
      const disk = JSON.parse(await readFile(CHAT_SESSIONS_FILE, 'utf8'));
      const accepted = disk.filter(s => s.createdByPrincipalId === principal.grantId);
      assert.equal(accepted.length, 1); assert.equal(accepted[0].creationRequest.state, 'complete');
      assert.equal(accepted[0].activeRunId, undefined);
    });
    await t.test('per-grant Session capacity is enforced inside concurrent creation', async () => {
      const { principal } = await device();
      const results = await Promise.allSettled(Array.from({ length: 18 }, (_, n) => service.create(principal, { tool: 'codex', idempotencyKey: `quota-${n}` })));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 16);
      const failed = results.filter(r => r.status === 'rejected');
      assert.ok(failed.every(r => r.reason.code === 'temporary_session_capacity'));
      const replay = await service.create(principal, { tool: 'codex', idempotencyKey: 'quota-0' });
      assert.equal(replay.duplicate, true);
    });
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});
