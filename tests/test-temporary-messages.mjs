import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash, randomBytes, sign } from 'node:crypto';

test('temporary prepared messages retain original device authority through durable admission', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-message-'));
  process.env.RAGENT_CONFIG_DIR = join(root, 'config'); process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
  delete process.env.RAGENT_INSTANCE_ROOT;
  const { fixture } = await import('./helpers/temporary-turn-fixture.mjs');
  const { temporaryDeviceJwk } = await import('../lib/temporary-device-access.mjs');
  const { TemporarySessionService } = await import('../chat/temporary-session-service.mjs');
  const { TemporaryMessageService } = await import('../chat/temporary-message-service.mjs');
  const { TemporaryResultService } = await import('../chat/temporary-result-service.mjs');
  const { TemporaryPairingHost } = await import('../chat/temporary-pairing-host.mjs');
  const { authorizeTemporaryMessage } = await import('../chat/temporary-message-authorization.mjs');
  const api = await import('../chat/message-commit-store.mjs');
  // Existing authorization/result fixtures exercise callbacks, not a Provider.
  // Opt them into a synthetic boundary explicitly; the product default is
  // tested separately below and cannot be enabled by phone payload options.
  const continueFixture = (id, options) => api.continueScopedMessageRun(id,
    { assertExecutionBoundary: () => {}, ...options });
  const runs = await import('../chat/runs.mjs');
  const meta = await import('../chat/session-meta-store.mjs');
  const history = await import('../chat/history.mjs');
  const assets = await import('../chat/file-assets.mjs');
  const { messageEvent } = await import('../chat/normalizer.mjs');
  const { parseMessageRunBinding, createMessageRunBinding, retainMessageRunBinding, messageRunId } = await import('../chat/message-run-contract.mjs');
  const f = await fixture(t, { initialTime: Date.now() });
  const sessions = new TemporarySessionService({ host: f.host, workRoot: join(root, 'work'),
    availableTools: async () => [{ id: 'codex', name: 'CodeX', available: true }],
    runtimeCatalog: async tools => tools.map(tool => ({ id: tool.id, name: tool.name, ready: true, status: 'ready' })) });
  const scheduled = [];
  const service = new TemporaryMessageService({ host: f.host, schedule: (sid, rid) => { scheduled.push([sid, rid]); } });
  const results = new TemporaryResultService({ host: f.host });
  const authorizeContinuation = (binding, session) => authorizeTemporaryMessage(binding, session, { host: f.host });
  const settleFailure = ({ run }, error) => runs.updateRun(run.id, { state: 'failed', failureReason: error.code, completedAt: new Date().toISOString() });
  let counter = 0;
  async function seed(options = {}) {
    const phone = await f.enroll(undefined, options); const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
    const targetUri = 'https://pc.example.test/temporary/messages';
    const data = `${enc({ typ: 'dpop+jwt', alg: 'ES256', jwk: temporaryDeviceJwk(phone.claim.devicePublicKey).jwk })}.${enc({
      htm: 'POST', htu: targetUri, iat: Math.floor(f.clock() / 1000), jti: randomBytes(24).toString('base64url'),
      ath: createHash('sha256').update(phone.accessCredential.access_token).digest('base64url') })}`;
    const proof = `${data}.${sign('sha256', Buffer.from(data), { key: phone.device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    const principal = await f.host.authenticateRequest({ credential: phone.accessCredential, proof, method: 'POST', targetUri });
    const created = await sessions.create(principal, { tool: 'codex', idempotencyKey: `session-${++counter}` });
    const scope = { version: 1, sessionId: created.session.sessionId,
      expectedScopeRevision: created.session.scopeRevision, expectedProjectId: created.session.projectId };
    const request = { version: 1, requestId: `message-${counter}`, text: '  保留原始文本😀\n生成测试报告。',
      runOptions: { thinking: false }, attachments: [], expiresAt: new Date(Math.min(Date.now() + 60_000, principal.expiry)).toISOString() };
    const prepared = await service.prepare(principal, scope, request);
    const input = { version: 1, preparationId: prepared.preparationId };
    return { phone, principal, scope, request, prepared, input };
  }
  const commit = v => service.commit(v.principal, v.scope, v.request.requestId, v.input);
  try {
    await t.test('default execution refuses temporary work before preparation and retains the original receipt', async () => {
      const v = await seed(); const accepted = await commit(v);
      let executed = 0;
      await api.continueScopedMessageRun(accepted.runId, { authorizeContinuation, settleFailure,
        execute: async () => { executed++; throw new Error('must not prepare Provider'); } });
      assert.equal(executed, 0);
      const failed = await service.receipt(v.principal, v.scope, v.request.requestId);
      assert.equal(failed.runId, accepted.runId);
      assert.equal(failed.accepted, true);
      assert.equal(failed.dispatched, false);
      assert.equal(failed.state, 'failed');
      assert.equal(failed.failureCode, 'RESTRICTED_EXECUTION_UNAVAILABLE');
      assert.equal((await meta.findSessionMeta(v.scope.sessionId)).activeRunId ?? null, null);
      assert.equal((await history.readEventsAfter(v.scope.sessionId, 0)).length, 0);
      const replay = await commit(v);
      assert.equal(replay.runId, accepted.runId);
      assert.equal(replay.duplicate, true);
      assert.equal(replay.failureCode, failed.failureCode);
    });
    await t.test('concurrent prepare/commit publishes one Run with frozen non-owner inputs', async () => {
      const v = await seed();
      assert.equal((await service.prepare(v.principal, v.scope, v.request)).preparationId, v.prepared.preparationId);
      const result = await Promise.all(Array.from({ length: 5 }, () => commit(v)));
      assert.equal(new Set(result.map(r => r.runId)).size, 1); assert.equal(result.filter(r => !r.duplicate).length, 1);
      const persisted = await api.readMessageRun(result[0].runId);
      assert.equal(persisted.binding.version, 2); assert.equal(persisted.binding.principalKind, 'temporary_device');
      assert.equal(persisted.binding.temporaryAuthority.grantId, v.principal.grantId);
      assert.equal(persisted.binding.configuration.riskMode, 'safe'); assert.equal(persisted.binding.configuration.canDelegate, false);
      assert.equal(persisted.binding.configuration.privilegedMode, false); assert.equal(persisted.record.request.text, v.request.text);
      assert.equal(JSON.stringify(result).includes('bindingStamp'), false);
      assert.equal(result[0].dispatched, false); assert.equal(result[0].accepted, true);
      const count = scheduled.length;
      assert.equal((await service.receipt(v.principal, v.scope, v.request.requestId)).runId, result[0].runId);
      assert.equal(scheduled.length, count, 'receipt reads never dispatch');
      await assert.rejects(service.prepare(v.principal, v.scope, { ...v.request, text: 'changed' }), { code: 'MESSAGE_IDEMPOTENCY_CONFLICT' });
    });
    await t.test('phone cannot widen expiry or choose templates, tools, privilege or browser delegation', async () => {
      const v = await seed();
      for (const key of ['permissionMode', 'tool', 'templateId', 'providerProfile', 'browserMcpEnabled', 'planAction']) {
        await assert.rejects(service.prepare(v.principal, v.scope, { ...v.request, requestId: `forbidden-${key}`,
          runOptions: { [key]: key === 'browserMcpEnabled' ? true : key === 'planAction' ? 'execute' : 'arbitrary' } }), { code: 'temporary_message_options_denied' });
      }
      await assert.rejects(service.prepare(v.principal, v.scope, { ...v.request, expiresAt: new Date(v.principal.expiry + 1000).toISOString() }),
        { code: 'temporary_message_options_denied' });
    });
    await t.test('another device cannot query or commit the original preparation', async () => {
      const a = await seed(), b = await seed();
      await assert.rejects(service.preparation(b.principal, a.scope, a.request.requestId), { code: 'temporary_resource_denied' });
      await assert.rejects(service.commit(b.principal, a.scope, a.request.requestId, a.input), { code: 'temporary_resource_denied' });
    });
    await t.test('revoking after acceptance leaves one queued receipt but prevents a new execution', async () => {
      const v = await seed(); const accepted = await commit(v); await f.host.revoke(v.phone.claim.invitationId);
      let executed = 0;
      await continueFixture(accepted.runId, { authorizeContinuation, settleFailure, execute: async () => { executed++; } });
      assert.equal(executed, 0); assert.equal((await runs.getRun(accepted.runId)).state, 'failed');
      assert.equal((await api.readSessionApiMessageCommit(v.scope.sessionId, v.scope, v.request.requestId)).accepted, true);
      await assert.rejects(service.receipt(v.principal, v.scope, v.request.requestId), { code: 'temporary_pairing_inactive' });
    });
    await t.test('cold host object verifies durable authority before history and launch admission', async () => {
      const v = await seed(); const accepted = await commit(v);
      const cold = new TemporaryPairingHost({ registry: f.registry, client: f.client, binding: f.host.binding, clock: f.clock });
      const coldAuthorization = (binding, session) => authorizeTemporaryMessage(binding, session, { host: cold });
      await continueFixture(accepted.runId, { authorizeContinuation: coldAuthorization, settleFailure,
        execute: async ({ run, record }) => {
          const event = messageEvent('user', record.request.text, undefined, { id: `message-run:${run.id}`, requestId: run.requestId, runId: run.id });
          await history.appendRetainedMessageEvent(run.sessionId, event);
          await history.appendRetainedMessageEvent(run.sessionId, event);
          return runs.updateRun(run.id, { state: 'accepted' });
        } });
      const events = await history.readEventsAfter(v.scope.sessionId, 0);
      assert.equal(events.filter(e => e.id === `message-run:${accepted.runId}`).length, 1);
      await assert.rejects(api.admitScopedMessageLaunch(accepted.runId, { authorizeContinuation: coldAuthorization }),
        { code: 'RESTRICTED_EXECUTION_UNAVAILABLE' });
      assert.equal((await runs.getRun(accepted.runId)).messageLaunchAdmittedAt, undefined);
      await api.admitScopedMessageLaunch(accepted.runId, { authorizeContinuation: coldAuthorization, assertExecutionBoundary: () => {} });
      assert.ok((await runs.getRun(accepted.runId)).messageLaunchAdmittedAt);
      assert.equal((await runs.getRun(accepted.runId)).runnerStartedAt ?? null, null, 'no actual provider was started');
    });
    await t.test('revoke between queue admission and a bounded writer denies the later effect', async () => {
      const v = await seed(); const accepted = await commit(v); let wrote = 0;
      await continueFixture(accepted.runId, { authorizeContinuation, settleFailure,
        execute: async () => {
          await f.host.revoke(v.phone.claim.invitationId);
          await meta.withCurrentMessageScope(async () => { wrote++; });
        } });
      assert.equal(wrote, 0); assert.equal((await runs.getRun(accepted.runId)).state, 'failed');
    });
    await t.test('revoke after manifest staging cannot publish an accepted Run status', async () => {
      const v = await seed(); const original = f.host.resourcePolicy.authorize; let injected = false;
      const stagedPath = runs.runManifestPath(messageRunId({ sessionId: v.scope.sessionId, preparationId: v.prepared.preparationId }));
      f.host.resourcePolicy.authorize = async function (...args) {
        if (args[1] === 'message.commit' && !injected) {
          let staged = false;
          try { await readFile(stagedPath); staged = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (staged) { injected = true; await f.host.revoke(v.phone.claim.invitationId); }
        }
        return original.apply(this, args);
      };
      try { await assert.rejects(commit(v), { code: 'temporary_pairing_inactive' }); }
      finally { f.host.resourcePolicy.authorize = original; }
      assert.equal(injected, true);
      const receipt = await api.readSessionApiMessageCommit(v.scope.sessionId, v.scope, v.request.requestId);
      assert.equal(receipt.accepted, false); assert.equal(receipt.runId, null);
    });
    await t.test('expiry and binding changes after preparing deny actual launch admission', async () => {
      for (const change of ['expiry', 'binding']) {
        const v = await seed(); const accepted = await commit(v);
        await continueFixture(accepted.runId, { authorizeContinuation, settleFailure,
          execute: async () => runs.updateRun(accepted.runId, { state: 'accepted' }) });
        if (change === 'expiry') f.advance(v.principal.expiry - f.clock());
        else f.binding.boundAt = new Date(f.clock() + 1).toISOString();
        await assert.rejects(api.admitScopedMessageLaunch(accepted.runId, { authorizeContinuation }));
        assert.equal((await runs.getRun(accepted.runId)).messageLaunchAdmittedAt, undefined);
      }
    });
    await t.test('temporary binding cannot be rewritten as an Owner or widened configuration', async () => {
      const v = await seed(); const accepted = await commit(v); const { binding } = await api.readMessageRun(accepted.runId);
      for (const mutate of [b => { b.version = 1; }, b => { b.principalKind = 'owner'; },
        b => { b.configuration.privilegedMode = true; }, b => { b.temporaryAuthority.expiresAt += 1; }]) {
        const copy = structuredClone(binding); mutate(copy); assert.throws(() => parseMessageRunBinding(copy));
      }
      const file = JSON.parse(await readFile(runs.runManifestPath(accepted.runId), 'utf8'));
      assert.equal(file.appApiMessage.bindingHash, binding.bindingHash);
      const evidence = await api.readMessageRun(accepted.runId);
      const session = await meta.findSessionMeta(v.scope.sessionId);
      const owner = createMessageRunBinding(evidence.record, session, 'owner');
      assert.throws(() => retainMessageRunBinding(file, { ...file, appApiMessage: owner }), { code: 'MESSAGE_IDEMPOTENCY_CONFLICT' });
      await assert.rejects(f.host.authorizeStoredMessage({ ...binding.temporaryAuthority,
        expiresAt: binding.temporaryAuthority.expiresAt + 1000 }, session), { code: 'temporary_pairing_inactive' });
    });
    await t.test('exact completed Run publishes bounded preview and immutable text chunks to its original device', async () => {
      const v = await seed(); const accepted = await commit(v);
      assert.equal((await results.run(v.principal, v.scope, accepted.runId)).run.runId, accepted.runId);
      assert.equal((await results.preview(v.principal, v.scope, accepted.runId)).state, 'queued');
      await assert.rejects(results.manifest(v.principal, v.scope, accepted.runId), { code: 'RESULT_EXPORT_INCOMPLETE' });
      const text = '导出完整结果🙂\n'.repeat(4000) + 'END';
      await history.appendEvent(v.scope.sessionId, { ...messageEvent('assistant', text), runId: accepted.runId,
        responseId: v.request.requestId });
      await runs.updateRun(accepted.runId, { state: 'completed', completedAt: new Date().toISOString() });
      const preview = await results.preview(v.principal, v.scope, accepted.runId);
      assert.equal(preview.state, 'ready');
      const first = await results.manifest(v.principal, v.scope, accepted.runId);
      const retry = await results.manifest(v.principal, v.scope, accepted.runId);
      assert.equal(first.revision, retry.revision); assert.equal(first.runId, accepted.runId);
      assert.ok(Date.parse(first.expiresAt) <= v.principal.expiry);
      let offset = 0; const chunks = [];
      do {
        const chunk = await results.chunk(v.principal, v.scope, accepted.runId, 'text',
          { revision: first.revision, offset: String(offset), length: '65536' });
        const bytes = Buffer.from(chunk.dataBase64, 'base64');
        assert.equal(createHash('sha256').update(bytes).digest('hex'), chunk.chunkSha256);
        offset = chunk.nextOffset; chunks.push(bytes);
      } while (offset < first.resources[0].sizeBytes);
      assert.equal(Buffer.concat(chunks).toString('utf8'), text);
      assert.equal(JSON.stringify([first, retry]).includes('bindingStamp'), false);
      assert.equal(JSON.stringify([first, retry]).includes('downloadUrl'), false);
      const other = await seed();
      await assert.rejects(results.chunk(other.principal, v.scope, accepted.runId, 'text',
        { revision: first.revision, offset: '0', length: '1' }), { code: 'temporary_resource_denied' });
      await f.host.revoke(v.phone.claim.invitationId);
      await assert.rejects(results.chunk(v.principal, v.scope, accepted.runId, 'text',
        { revision: first.revision, offset: '0', length: '1' }), { code: 'temporary_pairing_inactive' });
    });
    await t.test('result routes refuse an Owner Run inside a temporary Session and invalid chunk shape', async () => {
      const v = await seed(); const accepted = await commit(v);
      const owner = await runs.createRun({ status: { sessionId: v.scope.sessionId,
        requestId: 'owner-private', state: 'completed' }, manifest: {} });
      await assert.rejects(results.run(v.principal, v.scope, owner.id));
      await assert.rejects(results.chunk(v.principal, v.scope, accepted.runId, 'text',
        { revision: 'x', offset: '0', length: '1', debug: true }), { code: 'temporary_resource_denied' });
    });
    await t.test('published binary result downloads in verified chunks and revoke during copy cannot publish', async () => {
      const bytes = Buffer.from(Array.from({ length: 180_000 }, (_, i) => i % 251));
      const v = await seed(), accepted = await commit(v);
      const source = join(root, `result-${counter}.bin`); await writeFile(source, bytes);
      const asset = await assets.publishLocalFileAssetFromPath({ sessionId: v.scope.sessionId,
        localPath: source, originalName: 'report.bin', mimeType: 'application/octet-stream' });
      await history.appendEvent(v.scope.sessionId, { ...messageEvent('assistant', '报告已完成'),
        runId: accepted.runId, responseId: v.request.requestId,
        attachments: [{ assetId: asset.id, originalName: 'report.bin', mimeType: 'application/octet-stream', sizeBytes: bytes.length }] });
      await runs.updateRun(accepted.runId, { state: 'completed', completedAt: new Date().toISOString() });
      const manifest = await results.manifest(v.principal, v.scope, accepted.runId);
      const resource = manifest.resources.find(item => item.resourceId === asset.id);
      assert.equal(resource.sizeBytes, bytes.length);
      const pieces = []; let offset = 0;
      while (offset < bytes.length) {
        const chunk = await results.chunk(v.principal, v.scope, accepted.runId, asset.id,
          { revision: manifest.revision, offset: String(offset), length: '65536' });
        pieces.push(Buffer.from(chunk.dataBase64, 'base64')); offset = chunk.nextOffset;
      }
      assert.deepEqual(Buffer.concat(pieces), bytes);
      const other = await seed(), otherRun = await commit(other);
      const otherSource = join(root, `result-${counter}.bin`); await writeFile(otherSource, bytes);
      const otherAsset = await assets.publishLocalFileAssetFromPath({ sessionId: other.scope.sessionId,
        localPath: otherSource, originalName: 'report.bin', mimeType: 'application/octet-stream' });
      await history.appendEvent(other.scope.sessionId, { ...messageEvent('assistant', '报告已完成'),
        runId: otherRun.runId, responseId: other.request.requestId,
        attachments: [{ assetId: otherAsset.id, originalName: 'report.bin', mimeType: 'application/octet-stream', sizeBytes: bytes.length }] });
      await runs.updateRun(otherRun.runId, { state: 'completed', completedAt: new Date().toISOString() });
      const original = f.host.resourcePolicy.authorize; let checks = 0;
      f.host.resourcePolicy.authorize = async function (...args) {
        if (args[1] === 'result.export' && ++checks === 5) await f.host.revoke(other.phone.claim.invitationId);
        return original.apply(this, args);
      };
      try { await assert.rejects(results.manifest(other.principal, other.scope, otherRun.runId),
        { code: 'temporary_pairing_inactive' }); }
      finally { f.host.resourcePolicy.authorize = original; }
      assert.equal(checks, 5);
    });
    await t.test('queued cancellation preserves the exact accepted Run and has a stable terminal receipt', async () => {
      const v = await seed(), accepted = await commit(v);
      const body = { version: 1, expiresAt: new Date(Math.min(Date.now() + 60_000, v.principal.expiry)).toISOString() };
      const cancelled = await results.cancel(v.principal, v.scope, accepted.runId, body);
      assert.equal(cancelled.disposition, 'cancellation_requested');
      assert.equal(cancelled.run.runId, accepted.runId); assert.equal(cancelled.run.state, 'cancelled');
      assert.equal((await results.cancel(v.principal, v.scope, accepted.runId, body)).disposition, 'already_terminal');
      assert.equal((await runs.getRun(accepted.runId)).cancelRequested, true);
      const another = await seed();
      await assert.rejects(results.cancel(another.principal, v.scope, accepted.runId, body),
        { code: 'temporary_resource_denied' });
    });
    await t.test('live cancellation records intent without claiming the provider has stopped', async () => {
      const v = await seed(), accepted = await commit(v);
      await runs.updateRun(accepted.runId, { state: 'running', appApiMessageQueue: false });
      await meta.mutateSessionMeta(v.scope.sessionId, draft => { draft.activeRunId = accepted.runId; return true; });
      const body = { version: 1, expiresAt: new Date(Math.min(Date.now() + 60_000, v.principal.expiry)).toISOString() };
      const result = await results.cancel(v.principal, v.scope, accepted.runId, body);
      assert.equal(result.run.cancelRequested, true); assert.equal(result.run.terminal, false);
      assert.equal((await runs.getRun(accepted.runId)).cancelRequested, true);
    });
    await t.test('deadline widening and revoke inside Run write lock create no cancellation', async () => {
      const v = await seed(), accepted = await commit(v);
      await assert.rejects(results.cancel(v.principal, v.scope, accepted.runId,
        { version: 1, expiresAt: new Date(v.principal.expiry + 60_000).toISOString() }),
        { code: 'temporary_resource_denied' });
      assert.equal((await runs.getRun(accepted.runId)).cancelRequested, false);
      const body = { version: 1, expiresAt: new Date(Math.min(Date.now() + 60_000, v.principal.expiry)).toISOString() };
      const original = f.host.resourcePolicy.authorize; let checks = 0;
      f.host.resourcePolicy.authorize = async function (...args) {
        if (args[1] === 'run.cancel' && ++checks === 3) await f.host.revoke(v.phone.claim.invitationId);
        return original.apply(this, args);
      };
      try { await assert.rejects(results.cancel(v.principal, v.scope, accepted.runId, body),
        { code: 'temporary_pairing_inactive' }); }
      finally { f.host.resourcePolicy.authorize = original; }
      assert.equal(checks, 3); assert.equal((await runs.getRun(accepted.runId)).state, 'queued');
      assert.equal((await runs.getRun(accepted.runId)).cancelRequested, false);
    });
    await t.test('task.read does not confer download or cancellation authority', async () => {
      const v = await seed({ capabilities: ['task.create', 'task.submit', 'task.read'] });
      const accepted = await commit(v);
      assert.equal((await results.run(v.principal, v.scope, accepted.runId)).run.runId, accepted.runId);
      await assert.rejects(results.manifest(v.principal, v.scope, accepted.runId),
        { code: 'temporary_resource_denied' });
      const body = { version: 1, expiresAt: new Date(Math.min(Date.now() + 60_000, v.principal.expiry)).toISOString() };
      await assert.rejects(results.cancel(v.principal, v.scope, accepted.runId, body),
        { code: 'temporary_resource_denied' });
      assert.equal((await runs.getRun(accepted.runId)).cancelRequested, false);
    });
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true });
  }
});
