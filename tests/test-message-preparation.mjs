import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { createServer, request as httpRequest } from 'node:http';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, after } from 'node:test';

const root = process.env.RAGENT_MESSAGE_PREPARATION_TEST_ROOT || await mkdtemp(join(tmpdir(), 'ragent-message-preparation-'));
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
process.env.RAGENT_ASSET_DIRECT_UPLOAD_ENABLED = '0';
const store = await import('../chat/session-meta-store.mjs');
const api = await import('../chat/message-preparation-store.mjs');
const messageExecution = await import('../chat/message-execution-context.mjs');
const contract = await import('../chat/message-preparation-contract.mjs');
const { withMessageRequestIdentity } = await import('../chat/message-request-identity.mjs');
const assets = await import('../chat/file-assets.mjs');
const runs = await import('../chat/runs.mjs');
const { submitHttpMessage, getMessageSubmissionReceipt, ensureSessionRuntimeState } = await import('../chat/session-manager.mjs');
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
const { createSessionDetail, createSessionListItem } = await import('../chat/session-api-shapes.mjs');
const { CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');
const { SESSION_API_SCOPE_HEADER } = await import('../chat/session-api-scope-contract.mjs');
let sequence = 0;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const condition = c => ({ version: 1, sessionId: c.sessionId, expectedScopeRevision: c.scopeRevision, expectedProjectId: c.projectId });
async function seed(extra = {}) {
  const id = extra.id || `prepare_session_${++sequence}`;
  await store.withSessionsMetaMutation(async (rows, save) => {
    rows.splice(0, rows.length, { id, folder: root, name: 'Prepared task', tool: 'codex', sourceId: 'chat', projectId: 'p1',
      sessionClass: 'ROOT_LEADERSHIP', sessionPlane: 'user', userAddressable: true, ...extra });
    await save(rows, { immediate: true });
  });
  return condition(await store.readSessionApiContext(id));
}
const request = (extra = {}) => ({ version: 1, requestId: `message_${++sequence}`, text: '分析这些资料\n并生成报告。',
  expiresAt: new Date(Date.now() + 60000).toISOString(), ...extra });
async function route(method, path, { scope, payload, raw, headers = {}, auth = { role: 'owner' }, access = true } = {}) {
  const req = new PassThrough(); req.method = method;
  req.headers = { 'content-type': 'application/json', ...headers,
    ...(scope ? { [SESSION_API_SCOPE_HEADER]: Buffer.from(JSON.stringify(scope)).toString('base64url') } : {}) };
  const parsedUrl = new URL(path, 'http://localhost');
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
  const accesses = [];
  const writeJson = (_res, status, body) => Object.assign(res, { status, body });
  const pending = handleSessionMainRoutes({ req, res, pathname: parsedUrl.pathname, parsedUrl, authSession: auth,
    requireSessionAccess: async (_res, _auth, id, flags) => {
      accesses.push(id); assert.equal(flags?.metadataOnly, true);
      if (!access) writeJson(res, 403, { code: 'PERMISSION_DENIED' });
      return access;
    }, writeJson });
  req.end(raw ?? (payload ? JSON.stringify(payload) : undefined));
  assert.equal(await pending, true);
  return { ...res, accesses };
}
const preparationPath = scope => `/api/sessions/${encodeURIComponent(scope.sessionId)}/app-api-message-preparations`;

if (process.argv[2] === 'cold-read') {
  const input = JSON.parse(process.env.RAGENT_MESSAGE_PREPARATION_INPUT);
  const receipt = await api.readSessionApiMessagePreparation(input.scope.sessionId, input.request.requestId, input.scope);
  const replay = await api.prepareSessionApiMessage(input.scope.sessionId, input.scope, input.request);
  const acceptance = await getMessageSubmissionReceipt(input.scope.sessionId, input.request.requestId);
  assert.equal(acceptance.state, 'unconfirmed'); assert.equal(acceptance.runId, null);
  process.stdout.write('COLD_PREPARATION=' + JSON.stringify({ receipt, replay, acceptance }) + '\n');
  await store.flushSessionsMetaNow();
} else if (process.argv[2] === 'crash-server') {
  const server = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    await handleSessionMainRoutes({ req, res, pathname: parsedUrl.pathname, parsedUrl, authSession: { role: 'owner' },
      requireSessionAccess: async (_res, _auth, _id, flags) => { assert.equal(flags.metadataOnly, true); return true; },
      writeJson: (_res, status, body) => {
        if (status === 200) process.send({ type: 'committed', preparation: body });
        else { res.writeHead(status); res.end(JSON.stringify(body)); }
      } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.send({ type: 'listening', port: server.address().port });
} else {
after(async () => { await store.flushSessionsMetaNow(); console.log(`Retained isolated preparation root: ${root}`); });

test('prepared attachment file rendering is explicit, fingerprinted and advertised', async () => {
  const attachment = { assetId: 'fasset_' + 'a'.repeat(24), sha256: 'b'.repeat(64), sizeBytes: 1 };
  const ordinary = request({ attachments: [attachment] });
  const rendered = { ...ordinary, attachments: [{ ...attachment, renderAs: 'file' }] };
  const scope = { version: 1, sessionId: 'render_session', expectedScopeRevision: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', expectedProjectId: null };
  assert.deepEqual(contract.parseMessagePreparation(ordinary).attachments, [attachment]);
  assert.equal(Object.hasOwn(contract.parseMessagePreparation(ordinary).attachments[0], 'renderAs'), false);
  assert.equal(contract.parseMessagePreparation(rendered).attachments[0].renderAs, 'file');
  assert.notEqual(contract.messagePreparationFingerprint(scope.sessionId, scope, ordinary),
    contract.messagePreparationFingerprint(scope.sessionId, scope, rendered));
  for (const value of [null, 'image', '', true]) assert.throws(() => contract.parseMessagePreparation({
    ...ordinary, attachments: [{ ...attachment, renderAs: value }] }), { code: 'INVALID_ARGUMENT' });
  const discovery = await route('GET', '/api/message-preparation-contract');
  assert.equal(discovery.status, 200); assert.deepEqual(discovery.body.attachmentOptionKeys, ['renderAs']);
});


test('strict schema preserves raw text and canonicalizes Run option order without accepting authority', () => {
  const input = request({ text: '  原文😀\n ', runOptions: { thinking: false, model: 'sample', tool: 'codex' } });
  const parsed = contract.parseMessagePreparation(input);
  assert.equal(parsed.text, input.text); assert.deepEqual(Object.keys(parsed.runOptions), ['model', 'thinking', 'tool']);
  for (const patch of [{ version: 2 }, { text: '' }, { text: '\uD800' }, { requestId: ' padded ' },
    { text: 'a\0b' }, { text: '中'.repeat(23000) }, { expiresAt: '2026-10-12' }, { attachments: null },
    { runOptions: null }, { caller: 'owner' }, { runOptions: { thinking: 1 } },
    { runOptions: { authenticatedPrincipalKind: 'owner' } }, { runOptions: { internalOperation: 'approved_action_resume' } },
    { runOptions: { preparationRunId: 'run_x' } }, { runOptions: { interactionMode: 'other' } }, { runOptions: { model: ' x ' } }])
    assert.throws(() => contract.parseMessagePreparation({ ...input, ...patch }), { code: 'INVALID_ARGUMENT' });
});

test('attachment schema rejects duplicates, bad sizes, hashes, totals and URI claims', () => {
  const item = { assetId: 'fasset_' + 'a'.repeat(24), sha256: 'a'.repeat(64), sizeBytes: 1 };
  assert.deepEqual(contract.parseMessagePreparation(request({ attachments: [item] })).attachments, [item]);
  for (const attachments of [[item, item], [{ ...item, sizeBytes: '1' }], [{ ...item, sizeBytes: 0 }],
    [{ ...item, sha256: 'A'.repeat(64) }], [{ ...item, uri: 'content://foreign/file' }],
    Array.from({ length: 17 }, (_, i) => ({ ...item, assetId: 'fasset_' + String(i).padStart(24, '0') }))])
    assert.throws(() => contract.parseMessagePreparation(request({ attachments })), { code: 'INVALID_ARGUMENT' });
});

test('concurrent preparation persists one private immutable record and does not accept or execute', async () => {
  const scope = await seed(); const input = request();
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => api.prepareSessionApiMessage(scope.sessionId, scope, input)));
  assert.equal(outcomes.filter(row => !row.duplicate).length, 1);
  assert.equal(new Set(outcomes.map(row => row.preparationId)).size, 1);
  assert.equal(outcomes[0].state, 'prepared'); assert.equal(outcomes[0].accepted, false); assert.equal(outcomes[0].dispatched, false);
  const meta = await store.findSessionMeta(scope.sessionId);
  assert.equal(meta.appApiMessagePreparations.length, 1); assert.equal(meta.activeRunId, undefined);
  assert.equal(meta.followUpQueue, undefined); assert.equal(meta.pendingPlanningQueue, undefined);
  assert.equal(await runs.findRunByRequest(scope.sessionId, input.requestId), null);
  assert.equal((await getMessageSubmissionReceipt(scope.sessionId, input.requestId)).state, 'unconfirmed');
  assert.equal(createSessionDetail(meta).appApiMessagePreparations, undefined);
  assert.equal(createSessionListItem(meta).appApiMessagePreparations, undefined);
  const before = await readFile(CHAT_SESSIONS_FILE);
  input.text = 'changed'; scope.expectedProjectId = 'forged';
  assert.equal((await store.findSessionMeta(meta.id)).appApiMessagePreparations[0].request.text, '分析这些资料\n并生成报告。');
  assert.deepEqual(await readFile(CHAT_SESSIONS_FILE), before);
});

test('same identity with different text, expiry, scope or Run options conflicts', async () => {
  const scope = await seed(); const input = request(); await api.prepareSessionApiMessage(scope.sessionId, scope, input);
  for (const patch of [{ text: 'new' }, { expiresAt: new Date(Date.parse(input.expiresAt) + 1000).toISOString() },
    { runOptions: { model: 'new' } }])
    await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, { ...input, ...patch }), { code: 'MESSAGE_IDEMPOTENCY_CONFLICT' });
  await store.mutateSessionMeta(scope.sessionId, draft => { draft.projectId = 'p2'; return true; });
  const fresh = condition(await store.readSessionApiContext(scope.sessionId));
  await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, fresh, input), { code: 'MESSAGE_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(api.readSessionApiMessagePreparation(scope.sessionId, input.requestId, scope), { code: 'REVISION_CONFLICT' });
  await assert.rejects(api.readSessionApiMessagePreparation(scope.sessionId, input.requestId, fresh), { code: 'MESSAGE_IDEMPOTENCY_CONFLICT' });
});

test('expiry is not extended on replay and future lifetime is bounded', async () => {
  const scope = await seed(); const input = request();
  const ready = await api.prepareSessionApiMessage(scope.sessionId, scope, input);
  const originalNow = Date.now;
  Date.now = () => Date.parse(input.expiresAt) + 1;
  try {
  const expired = await api.prepareSessionApiMessage(scope.sessionId, scope, input);
  assert.equal(expired.state, 'expired'); assert.equal(expired.preparationId, ready.preparationId); assert.equal(expired.duplicate, true);
  assert.equal((await api.readSessionApiMessagePreparation(scope.sessionId, input.requestId, scope)).state, 'expired');
  await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, request({ expiresAt: new Date(Date.now() - 1).toISOString() })), { code: 'REQUEST_EXPIRED' });
  await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, request({ expiresAt: new Date(Date.now() + 90000000).toISOString() })), { code: 'INVALID_ARGUMENT' });
  } finally { Date.now = originalNow; }
});

test('ordinary ingress cannot consume a reserved prepared identity', async () => {
  const scope = await seed(); const input = request(); await api.prepareSessionApiMessage(scope.sessionId, scope, input);
  await assert.rejects(submitHttpMessage(scope.sessionId, 'replace original text', [], { requestId: input.requestId }),
    { code: 'MESSAGE_PREPARATION_REQUIRED' });
  assert.equal(await runs.findRunByRequest(scope.sessionId, input.requestId), null);
  assert.equal((await store.findSessionMeta(scope.sessionId)).followUpQueue, undefined);
});

test('ordinary compact-busy ingress still persists its queue and stable receipt under the request lock', { timeout: 10000 }, async () => {
  const scope = await seed(); const input = request();
  const runtime = ensureSessionRuntimeState(scope.sessionId);
  runtime.pendingCompact = true;
  try {
  const results = await Promise.all(Array.from({ length: 4 }, () => submitHttpMessage(scope.sessionId, input.text, [],
    { requestId: input.requestId, internalOperation: 'fixture_message' })));
  assert.equal(results.filter(result => !result.duplicate).length, 1);
  assert.equal(results.every(result => result.queued), true);
  const meta = await store.findSessionMeta(scope.sessionId);
  assert.equal(meta.followUpQueue.length, 1); assert.equal(meta.followUpQueue[0].requestId, input.requestId);
  assert.equal((await getMessageSubmissionReceipt(scope.sessionId, input.requestId)).state, 'accepted');
  assert.equal(await runs.findRunByRequest(scope.sessionId, input.requestId), null);
  } finally {
    // Remove this synthetic Session before releasing its pending-compaction
    // fixture, so an already scheduled queue timer cannot start a provider.
    await store.removeSessionMeta(scope.sessionId);
    delete runtime.pendingCompact;
  }
});

test('preparation cannot adopt a retained ordinary Run or queue identity', async () => {
  const scope = await seed(); const first = request();
  await runs.createRun({ status: { sessionId: scope.sessionId, requestId: first.requestId, state: 'completed' }, manifest: {} });
  await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, first), { code: 'MESSAGE_IDEMPOTENCY_CONFLICT' });
  for (const field of ['followUpQueue', 'pendingPlanningQueue', 'recentFollowUpRequestIds']) {
    const next = request();
    await store.mutateSessionMeta(scope.sessionId, draft => { draft[field] = field === 'recentFollowUpRequestIds'
      ? [next.requestId] : [{ requestId: next.requestId, text: 'retained ordinary message' }]; return true; });
    await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, next), { code: 'MESSAGE_IDEMPOTENCY_CONFLICT' });
  }
});

test('request identity lock serializes actual Run publication with preparation without holding metadata', { timeout: 10000 }, async () => {
  const scope = await seed(); const input = request(); const entered = deferred(); const release = deferred();
  const ordinary = withMessageRequestIdentity(scope.sessionId, input.requestId, async () => {
    entered.resolve(); await release.promise;
    return runs.createRun({ status: { sessionId: scope.sessionId, requestId: input.requestId, state: 'completed' }, manifest: {} });
  });
  await entered.promise;
  const reject = assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, input), { code: 'MESSAGE_IDEMPOTENCY_CONFLICT' });
  await store.mutateSessionMeta(scope.sessionId, draft => { draft.name = 'metadata stays available'; return true; });
  release.resolve(); await ordinary; await reject;
  assert.equal((await store.findSessionMeta(scope.sessionId)).appApiMessagePreparations, undefined);
});

test('metadata lock inversion and active nested identity locks reject while ended ownership releases', async () => {
  const scope = await seed(); const input = request();
  await store.withSessionApiScope(scope.sessionId, scope, async () => {
    await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, input), { code: 'REVISION_CONFLICT' });
    await assert.rejects(submitHttpMessage(scope.sessionId, 'x', [], { requestId: input.requestId }), { code: 'REVISION_CONFLICT' });
  });
  const release = deferred(); let late;
  await withMessageRequestIdentity(scope.sessionId, input.requestId, async () => {
    assert.throws(() => withMessageRequestIdentity(scope.sessionId, input.requestId, async () => {}), { code: 'MESSAGE_IDENTITY_LOCK_CONFLICT' });
    late = release.promise.then(() => withMessageRequestIdentity(scope.sessionId, input.requestId, async () => 'later'));
  });
  release.resolve(); assert.equal(await late, 'later');
  assert.equal((await api.prepareSessionApiMessage(scope.sessionId, scope, input)).state, 'prepared');
});

test('scoped ready attachment facts are frozen without external credentials', async () => {
  const scope = await seed(); const bytes = Buffer.from('分析资料😀'); const sha256 = createHash('sha256').update(bytes).digest('hex');
  const upload = await assets.createFileAssetUploadIntent({ sessionId: scope.sessionId, requestId: 'prep_asset_' + sequence,
    originalName: 'material.txt', mimeType: 'text/plain', sizeBytes: bytes.length, sha256, scopeCondition: scope, forceLocal: true });
  await assets.ingestFileAssetUpload(upload.asset.id, Readable.from([bytes]), { scopeCondition: scope });
  await assets.finalizeFileAssetUpload(upload.asset.id, { scopeCondition: scope });
  const input = request({ attachments: [{ assetId: upload.asset.id, sizeBytes: bytes.length, sha256 }] });
  const receipt = await api.prepareSessionApiMessage(scope.sessionId, scope, input);
  assert.equal(receipt.state, 'prepared'); assert.equal(receipt.request, undefined); assert.equal(receipt.upload, undefined);
  const retained = (await store.findSessionMeta(scope.sessionId)).appApiMessagePreparations[0];
  assert.deepEqual(retained.request.attachments, input.attachments);
  await messageExecution.withMessageExecution({ runId: 'run_attachment_scope_check', scope,
    configuration: {}, expiresAt: request().expiresAt }, () =>
    api.validatePreparedMessageAttachments(scope.sessionId, scope, input.attachments));
  await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, request({ attachments: [{ ...input.attachments[0], sha256: '0'.repeat(64) }] })),
    { code: 'MESSAGE_ATTACHMENT_CONFLICT' });
});

test('legacy, pending and foreign-Session attachments cannot be silently adopted', async () => {
  const scope = await seed(); const bytes = Buffer.from('x'); const sha256 = createHash('sha256').update(bytes).digest('hex');
  const upload = await assets.createFileAssetUploadIntent({ sessionId: scope.sessionId, requestId: 'legacy_' + sequence,
    originalName: 'x', mimeType: 'text/plain', sizeBytes: 1, sha256, forceLocal: true });
  const attachment = { assetId: upload.asset.id, sizeBytes: 1, sha256 };
  await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, request({ attachments: [attachment] })), { code: 'MESSAGE_ATTACHMENT_CONFLICT' });
  await assets.ingestFileAssetUpload(upload.asset.id, Readable.from([bytes])); await assets.finalizeFileAssetUpload(upload.asset.id);
  await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, request({ attachments: [attachment] })), { code: 'CAPABILITY_UNSUPPORTED' });
  const foreign = await seed();
  await assert.rejects(api.prepareSessionApiMessage(foreign.sessionId, foreign, request({ attachments: [attachment] })), { code: 'MESSAGE_ATTACHMENT_CONFLICT' });
});

test('project A to B to A while reading an attachment rejects preparation without holding metadata', { timeout: 10000 }, async () => {
  const scope = await seed(); const bytes = Buffer.from('stage outside actor');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const upload = await assets.createFileAssetUploadIntent({ sessionId: scope.sessionId, requestId: 'moving_asset_' + sequence,
    originalName: 'stage.txt', mimeType: 'text/plain', sizeBytes: bytes.length, sha256, scopeCondition: scope, forceLocal: true });
  await assets.ingestFileAssetUpload(upload.asset.id, Readable.from([bytes]), { scopeCondition: scope });
  await assets.finalizeFileAssetUpload(upload.asset.id, { scopeCondition: scope });
  const input = request({ attachments: [{ assetId: upload.asset.id, sizeBytes: bytes.length, sha256 }] });
  const entered = deferred(); const release = deferred(); const original = fs.promises.readFile;
  let held = false;
  fs.promises.readFile = async (path, ...args) => {
    const data = await original(path, ...args);
    if (!held && String(path).endsWith(upload.asset.id + '.json')) {
      held = true; entered.resolve(); await release.promise;
    }
    return data;
  }; syncBuiltinESMExports();
  const rejected = assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, input), { code: 'REVISION_CONFLICT' });
  try {
    await entered.promise;
    await store.mutateSessionMeta(scope.sessionId, draft => { draft.projectId = 'p2'; return true; });
    await store.mutateSessionMeta(scope.sessionId, draft => { draft.projectId = 'p1'; return true; });
    release.resolve(); await rejected;
  } finally { release.resolve(); fs.promises.readFile = original; syncBuiltinESMExports(); }
  assert.equal((await store.findSessionMeta(scope.sessionId)).appApiMessagePreparations, undefined);
  assert.equal(await runs.findRunByRequest(scope.sessionId, input.requestId), null);
});

test('durable scoped metadata helper requires matching scope and cannot change it', async () => {
  const scope = await seed();
  await assert.rejects(store.mutateScopedSessionMetaDurably(scope.sessionId, () => true), { code: 'REVISION_CONFLICT' });
  await store.withSessionApiScope(scope.sessionId, scope, async () => {
    await assert.rejects(store.mutateScopedSessionMetaDurably('other_session', () => true), { code: 'REVISION_CONFLICT' });
    await assert.rejects(store.mutateScopedSessionMetaDurably(scope.sessionId, draft => { draft.projectId = 'p2'; return true; }), { code: 'REVISION_CONFLICT' });
    assert.equal((await store.findSessionMeta(scope.sessionId)).projectId, 'p1');
  });
});

test('durable preparation publication failure keeps no accepted record and permits exact retry', async () => {
  const scope = await seed(); const input = request(); const original = fs.promises.rename; let writes = 0;
  fs.promises.rename = async (from, to) => {
    if (to === CHAT_SESSIONS_FILE && ++writes === 3) throw Object.assign(new Error('fixture private failure ' + root), { code: 'EIO' });
    return original(from, to);
  }; syncBuiltinESMExports();
  try { await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, input), { code: 'SESSION_MUTATION_STORE_UNAVAILABLE' }); }
  finally { fs.promises.rename = original; syncBuiltinESMExports(); }
  assert.equal(writes, 3); assert.equal((await store.findSessionMeta(scope.sessionId)).appApiMessagePreparations, undefined);
  assert.equal((await api.prepareSessionApiMessage(scope.sessionId, scope, input)).state, 'prepared');
});

test('retained records cannot be changed or dropped by cooperating metadata writes', async () => {
  for (const change of [draft => { delete draft.appApiMessagePreparations; }, draft => { draft.appApiMessagePreparations = []; },
    draft => { draft.appApiMessagePreparations[0].request.text = 'forged'; }]) {
    const scope = await seed(); const input = request(); await api.prepareSessionApiMessage(scope.sessionId, scope, input);
    const before = await readFile(CHAT_SESSIONS_FILE);
    await assert.rejects(store.withSessionApiScope(scope.sessionId, scope, async () => {
      await store.mutateSessionMeta(scope.sessionId, draft => { change(draft); return true; });
    }), { code: 'MESSAGE_PREPARATION_STORE_INVALID' });
    assert.deepEqual(await readFile(CHAT_SESSIONS_FILE), before);
  }
});

test('damaged on-disk record prevents receipt, replay and ordinary ingress', async () => {
  const scope = await seed(); const input = request(); await api.prepareSessionApiMessage(scope.sessionId, scope, input);
  const before = await readFile(CHAT_SESSIONS_FILE);
  const list = JSON.parse(before); list[0].appApiMessagePreparations[0].request.text = 'changed behind fingerprint';
  await writeFile(CHAT_SESSIONS_FILE, JSON.stringify(list));
  try {
    await assert.rejects(api.readSessionApiMessagePreparation(scope.sessionId, input.requestId, scope), { code: 'MESSAGE_PREPARATION_STORE_INVALID' });
    await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, input), { code: 'MESSAGE_PREPARATION_STORE_INVALID' });
    await assert.rejects(submitHttpMessage(scope.sessionId, 'x', [], { requestId: input.requestId }), { code: 'MESSAGE_PREPARATION_STORE_INVALID' });
  } finally { await writeFile(CHAT_SESSIONS_FILE, before); }
});

test('metadata aliases cannot erase retained identity for ordinary ingress', async () => {
  const scope = await seed(); const input = request(); await api.prepareSessionApiMessage(scope.sessionId, scope, input);
  const before = await readFile(CHAT_SESSIONS_FILE); const meta = await store.findSessionMeta(scope.sessionId);
  delete meta.appApiMessagePreparations;
  await assert.rejects(submitHttpMessage(scope.sessionId, 'x', [], { requestId: input.requestId }), { code: 'MESSAGE_PREPARATION_STORE_INVALID' });
  assert.deepEqual(await readFile(CHAT_SESSIONS_FILE), before);
});

test('retained preparation quota does not evict or recycle previous identities', async () => {
  const scope = await seed(); const input = request(); const first = await api.prepareSessionApiMessage(scope.sessionId, scope, input);
  await store.withSessionApiScope(scope.sessionId, scope, async () => {
    await store.mutateScopedSessionMetaDurably(scope.sessionId, draft => {
      const row = draft.appApiMessagePreparations[0];
      const others = Array.from({ length: contract.MESSAGE_PREPARATION_LIMIT - 1 }, (_, index) => {
        const request = { ...row.request, requestId: 'quota_' + index };
        return { ...structuredClone(row), preparationId: 'mprep_00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
          requestId: request.requestId, request, fingerprint: contract.messagePreparationFingerprint(scope.sessionId, scope, request) };
      });
      draft.appApiMessagePreparations = [row, ...others]; return true;
    });
  });
  await assert.rejects(api.prepareSessionApiMessage(scope.sessionId, scope, request()), { code: 'RESOURCE_LIMIT' });
  assert.equal((await api.prepareSessionApiMessage(scope.sessionId, scope, input)).preparationId, first.preparationId);
  assert.equal((await store.findSessionMeta(scope.sessionId)).appApiMessagePreparations.length, 64);
});

test('HTTP discovery and prepare/read receipt preserve metadata-only access and truthful state', async () => {
  const discovery = await route('GET', '/api/message-preparation-contract');
  assert.equal(discovery.status, 200); assert.equal(discovery.body.commitSupported, true); assert.equal(discovery.body.startsRun, false);
  const scope = await seed(); const input = request();
  const prepared = await route('POST', preparationPath(scope), { scope, payload: input, auth: { role: 'owner', principalKind: 'trusted_device' } });
  assert.equal(prepared.status, 200); assert.equal(prepared.body.state, 'prepared'); assert.equal(prepared.body.accepted, false);
  assert.equal(prepared.headers['Cache-Control'], 'private, no-store'); assert.deepEqual(prepared.accesses, [scope.sessionId]);
  const read = await route('GET', preparationPath(scope) + '/' + input.requestId, { scope });
  assert.equal(read.status, 200); assert.equal(read.body.preparationId, prepared.body.preparationId); assert.equal(read.body.request, undefined);
});

test('HTTP auth, malformed scope/identity, media, query and body limits reject before execution', async () => {
  const scope = await seed(); const input = request();
  for (const auth of [{ role: 'visitor' }, { role: 'owner', principalKind: 'run_capability' }, { role: 'owner', principalKind: 'provisional_device' }]) {
    const denied = await route('POST', preparationPath(scope), { scope, payload: input, auth });
    assert.equal(denied.status, 403); assert.deepEqual(denied.accesses, []);
  }
  assert.equal((await route('POST', preparationPath(scope), { payload: input })).status, 400);
  assert.equal((await route('POST', preparationPath(scope), { headers: { [SESSION_API_SCOPE_HEADER]: '_' }, payload: input })).status, 400);
  assert.equal((await route('GET', preparationPath(scope) + '/%E0%A4', { scope })).status, 400);
  assert.equal((await route('POST', preparationPath(scope), { scope, payload: input, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await route('POST', preparationPath(scope) + '?caller=owner', { scope, payload: input })).status, 400);
  assert.equal((await route('PUT', preparationPath(scope), { scope, payload: input })).status, 405);
  assert.equal((await route('POST', preparationPath(scope), { scope, raw: Buffer.from([0xff]) })).status, 400);
  assert.equal((await route('POST', preparationPath(scope), { scope, raw: 'x'.repeat(contract.MESSAGE_PREPARATION_BODY_BYTES + 1) })).status, 413);
  assert.equal((await route('POST', preparationPath(scope), { scope, payload: input, access: false })).status, 403);
  assert.equal(await runs.findRunByRequest(scope.sessionId, input.requestId), null);
});

test('ordinary message endpoint rejects unsupported scope rather than ignoring the header', async () => {
  const scope = await seed();
  const result = await route('POST', `/api/sessions/${scope.sessionId}/messages`, { scope, payload: { text: 'x', requestId: 'drop_scope' } });
  assert.equal(result.status, 409); assert.equal(result.body.code, 'CAPABILITY_UNSUPPORTED'); assert.deepEqual(result.accesses, []);
});

test('HTTP storage failure withholds raw paths and does not claim preparation accepted', async () => {
  const scope = await seed(); const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => { if (to === CHAT_SESSIONS_FILE) throw Object.assign(new Error('private path ' + root), { code: 'EIO' }); return original(from, to); };
  syncBuiltinESMExports(); let result;
  try { result = await route('POST', preparationPath(scope), { scope, payload: request() }); }
  finally { fs.promises.rename = original; syncBuiltinESMExports(); }
  assert.equal(result.status, 503); assert.equal(JSON.stringify(result.body).includes(root), false); assert.equal(result.body.accepted, undefined);
});

test('cold process reads the same preparation and original acceptance remains unconfirmed', { timeout: 15000 }, async () => {
  const scope = await seed(); const input = request(); const prepared = await api.prepareSessionApiMessage(scope.sessionId, scope, input);
  const before = await readFile(CHAT_SESSIONS_FILE);
  const result = await promisify(execFile)(process.execPath, [import.meta.filename, 'cold-read'], {
    env: { ...process.env, RAGENT_MESSAGE_PREPARATION_TEST_ROOT: root, RAGENT_MESSAGE_PREPARATION_INPUT: JSON.stringify({ scope, request: input }) }, timeout: 12000,
  });
  const line = result.stdout.split('\n').find(value => value.startsWith('COLD_PREPARATION='));
  const cold = JSON.parse(line.slice('COLD_PREPARATION='.length));
  assert.equal(cold.receipt.preparationId, prepared.preparationId); assert.equal(cold.replay.duplicate, true);
  assert.equal(cold.acceptance.state, 'unconfirmed'); assert.deepEqual(await readFile(CHAT_SESSIONS_FILE), before);
});

test('actual HTTP child killed after durable preparation before reply recovers without a Run', { timeout: 20000 }, async () => {
  const scope = await seed(); const input = request();
  const child = fork(import.meta.filename, ['crash-server'], { env: { ...process.env, RAGENT_MESSAGE_PREPARATION_TEST_ROOT: root }, silent: true });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const messages = []; const listeners = new Map();
  child.on('message', value => { messages.push(value); listeners.get(value.type)?.(value); });
  function message(type) {
    const prior = messages.find(value => value.type === type); if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Owned preparation child ${type}: ${output}`)), 12000);
      listeners.set(type, value => { clearTimeout(timer); resolve(value); });
    });
  }
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let call;
  try {
    const listening = await message('listening'); let replied = false;
    const outcome = new Promise(resolve => {
      call = httpRequest({ hostname: '127.0.0.1', port: listening.port, path: preparationPath(scope), method: 'POST', headers: {
        'Content-Type': 'application/json', [SESSION_API_SCOPE_HEADER]: Buffer.from(JSON.stringify(scope)).toString('base64url'),
      } }, res => { replied = true; res.resume(); res.on('end', () => resolve('reply')); });
      call.on('error', () => resolve('disconnected')); call.end(JSON.stringify(input));
    });
    const committed = await message('committed'); assert.equal(committed.preparation.accepted, false); assert.equal(replied, false);
    const before = await readFile(CHAT_SESSIONS_FILE);
    assert.equal(child.kill('SIGKILL'), true); const terminal = await exited; assert.ok(terminal.signal || terminal.code !== 0);
    assert.equal(await outcome, 'disconnected');
    const result = await promisify(execFile)(process.execPath, [import.meta.filename, 'cold-read'], {
      env: { ...process.env, RAGENT_MESSAGE_PREPARATION_TEST_ROOT: root, RAGENT_MESSAGE_PREPARATION_INPUT: JSON.stringify({ scope, request: input }) }, timeout: 12000,
    });
    const line = result.stdout.split('\n').find(value => value.startsWith('COLD_PREPARATION=')); const cold = JSON.parse(line.slice('COLD_PREPARATION='.length));
    assert.equal(cold.receipt.preparationId, committed.preparation.preparationId); assert.equal(cold.acceptance.runId, null);
    assert.deepEqual(await readFile(CHAT_SESSIONS_FILE), before);
  } finally { call?.destroy(); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
});
}
