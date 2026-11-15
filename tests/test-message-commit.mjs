import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createBroker } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test, after, afterEach } from 'node:test';

const root = process.env.RAGENT_MESSAGE_COMMIT_TEST_ROOT || await mkdtemp(join(tmpdir(), 'ragent-message-commit-'));
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
process.env.RAGENT_ASSET_DIRECT_UPLOAD_ENABLED = '0';
await mkdir(process.env.RAGENT_CONFIG_DIR, { recursive: true });
await writeFile(join(process.env.RAGENT_CONFIG_DIR, 'tools.json'), JSON.stringify([{
  id: 'scoped-fixture', name: 'Scoped fixture runtime', command: process.execPath,
  runtimeFamily: 'codex-json', models: [{ id: 'frozen-model', label: 'Fixture model' }],
}, {
  id: 'scoped-gated-fixture', name: 'Scoped gated fixture runtime', command: process.execPath,
  runtimeFamily: 'codex-app-server-json', models: [{ id: 'frozen-model', label: 'Fixture model' }],
}]));
const meta = await import('../chat/session-meta-store.mjs');
const preparation = await import('../chat/message-preparation-store.mjs');
const api = await import('../chat/message-commit-store.mjs');
const runs = await import('../chat/runs.mjs');
const binding = await import('../chat/message-run-contract.mjs');
const context = await import('../chat/message-execution-context.mjs');
const admission = await import('../chat/session-run-admission.mjs');
const manager = await import('../chat/session-manager.mjs');
const history = await import('../chat/history.mjs');
const { messageEvent } = await import('../chat/normalizer.mjs');
const { verifyRunInputBinding } = await import('../chat/runner-sidecar.mjs');
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
const projects = await import('../chat/projects.mjs');
const apps = await import('../chat/apps.mjs');
const seededProject = process.argv[2] ? null : await projects.createProject({ name: 'Scoped commit fixture', rootPath: root });
const scopeHeader = 'x-ragent-app-api-scope';
const tracked = new Set();
let seq = 0;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
async function seed(extra = {}, requestPatch = {}) {
  const sessionId = `message_commit_${++seq}`;
  await meta.withSessionsMetaMutation(async (rows, save) => {
    rows.push({ id: sessionId, name: 'Conditional message', folder: root, tool: 'codex', model: 'frozen-model',
      sourceId: 'chat', projectId: seededProject.id, sessionClass: 'ROOT_LEADERSHIP', sessionPlane: 'user',
      userAddressable: true, ...extra });
    await save(rows, { immediate: true, durable: true });
  });
  const current = await meta.readSessionApiContext(sessionId);
  const scope = { version: 1, sessionId, expectedScopeRevision: current.scopeRevision, expectedProjectId: current.projectId };
  const request = { version: 1, requestId: `commit_request_${seq}`, text: '  原始要求😀\n生成报告。 ',
    runOptions: { thinking: false }, expiresAt: new Date(Date.now() + 60000).toISOString(), ...requestPatch };
  const prepared = await preparation.prepareSessionApiMessage(sessionId, scope, request);
  return { sessionId, scope, request, payload: { version: 1, preparationId: prepared.preparationId }, prepared };
}
async function commit(value) {
  const result = await api.commitSessionApiMessage(value.sessionId, value.scope, value.request.requestId, value.payload, 'owner');
  tracked.add(result.runId); return result;
}
async function route(value, method = 'POST', extra = {}) {
  const req = new PassThrough(); req.method = method;
  req.headers = { 'content-type': 'application/json', [scopeHeader]: Buffer.from(JSON.stringify(value.scope)).toString('base64url'), ...extra.headers };
  const path = `/api/sessions/${value.sessionId}/app-api-message-preparations/${value.request.requestId}/commit${extra.query || ''}`;
  const parsedUrl = new URL(path, 'http://localhost');
  const res = { headers: {}, setHeader(key, input) { this.headers[key] = input; } };
  const promise = handleSessionMainRoutes({ req, res, pathname: parsedUrl.pathname, parsedUrl,
    authSession: extra.auth || { role: 'owner' }, requireSessionAccess: async (_res, _auth, id, flags) => {
      assert.equal(id, value.sessionId); assert.equal(flags.metadataOnly, true); return extra.access !== false;
    }, writeJson: (_res, status, body) => Object.assign(res, { status, body }) });
  req.end(extra.raw ?? (method === 'POST' ? JSON.stringify(extra.payload || value.payload) : undefined));
  assert.equal(await promise, true); if (res.body?.runId) tracked.add(res.body.runId);
  return res;
}
const failure = async ({ run }, error) => runs.updateRun(run.id, { state: 'failed', failureReason: error.message, completedAt: new Date().toISOString() });
const executeOptions = execute => ({ execute, settleFailure: failure });
const committedPath = value => `/api/sessions/${value.sessionId}/app-api-message-preparations/${value.request.requestId}/commit`;

if (process.argv[2] === 'cold-start') {
  const value = JSON.parse(process.env.RAGENT_MESSAGE_COMMIT_INPUT);
  assert.equal((await meta.findSessionMeta(value.sessionId)).activeRunId, undefined);
  assert.equal((await api.readMessageRun(value.runId)).run.state, 'queued');
  await manager.startDetachedRunObservers();
  const end = Date.now() + 12000;
  while (!runs.isTerminalRunState((await runs.getRun(value.runId)).state) && Date.now() < end)
    await new Promise(resolve => setTimeout(resolve, 20));
  const receipt = await api.readSessionApiMessageCommit(value.sessionId, value.scope, value.request.requestId);
  process.stdout.write('COLD_STARTED=' + JSON.stringify(receipt) + '\n');
  manager.killAll(); await meta.flushSessionsMetaNow();
} else if (process.argv[2] === 'cold-resume') {
  const value = JSON.parse(process.env.RAGENT_MESSAGE_COMMIT_INPUT);
  const evidence = await api.readMessageRun(value.runId);
  assert.equal(evidence.run.state, 'preparing'); assert.equal(evidence.manifest.preparation, undefined);
  process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET = process.platform === 'win32'
    ? `\\\\.\\pipe\\ragent-commit-missing-${process.pid}` : join(root, 'missing-broker.sock');
  process.env.RAGENT_RUNNER_LIFECYCLE_REQUIRED = '1';
  await manager.scheduleScopedMessageRun(value.sessionId, value.runId);
  const receipt = await api.readSessionApiMessageCommit(value.sessionId, value.scope, value.request.requestId);
  const events = await history.readEventsAfter(value.sessionId, 0);
  process.stdout.write('COLD_RESUMED=' + JSON.stringify({ receipt, userEvents: events.filter(row => row.id === `message-run:${value.runId}`).length }) + '\n');
  manager.killAll(); await meta.flushSessionsMetaNow();
} else if (process.argv[2] === 'crash-prepared') {
  const value = JSON.parse(process.env.RAGENT_MESSAGE_COMMIT_INPUT);
  const rename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    const result = await rename(from, to);
    if (String(to) === runs.runManifestPath(value.runId)) {
      const manifest = JSON.parse(await readFile(String(to), 'utf8'));
      if (!manifest.preparation && manifest.appApiMessage) {
        process.send({ type: 'prepared-manifest-before-status', runId: value.runId });
        await new Promise(() => {});
      }
    }
    return result;
  };
  syncBuiltinESMExports();
  await manager.scheduleScopedMessageRun(value.sessionId, value.runId);
  throw new Error('Prepared manifest checkpoint was not reached');
} else if (process.argv[2] === 'cold') {
  const value = JSON.parse(process.env.RAGENT_MESSAGE_COMMIT_INPUT);
  const receipt = await api.readSessionApiMessageCommit(value.sessionId, value.scope, value.request.requestId);
  const duplicate = await api.commitSessionApiMessage(value.sessionId, value.scope, value.request.requestId, value.payload, 'owner');
  process.stdout.write('COLD_COMMIT=' + JSON.stringify({ receipt, duplicate }) + '\n');
  await meta.flushSessionsMetaNow();
} else if (process.argv[2] === 'crash-http') {
  const value = JSON.parse(process.env.RAGENT_MESSAGE_COMMIT_INPUT);
  manager.ensureSessionRuntimeState(value.sessionId).pendingCompact = true;
  const server = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    await handleSessionMainRoutes({ req, res, pathname: parsedUrl.pathname, parsedUrl, authSession: { role: 'owner' },
      requireSessionAccess: async () => true, writeJson: (_res, status, body) => {
        if (status === 200) process.send({ type: 'accepted-before-reply', body });
        else { res.writeHead(status); res.end(JSON.stringify(body)); }
      } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.send({ type: 'listening', port: server.address().port });
} else {
test('paired owner device identity survives scoped commit without accepting wire credentials', async () => {
  const value = await seed();
  const auth = { role: 'owner', principalKind: 'trusted_device', deviceId: 'phone-1', accountId: 'account-1', bindingAuthorityRevision: '3' };
  const response = await route(value, 'POST', { auth });
  assert.equal(response.status, 200);
  const manifest = await runs.getRunManifest(response.body.runId);
  if (process.platform !== 'win32') {
    assert.equal(manifest.appApiMessage.version, 1);
    assert.equal(manifest.appApiMessage.ownerDevice, undefined);
    return;
  }
  assert.equal(manifest.appApiMessage.version, 3);
  assert.deepEqual(manifest.appApiMessage.ownerDevice, { principalKind: 'trusted_device', deviceId: 'phone-1', accountId: 'account-1', bindingAuthorityRevision: '3' });
  const forged = structuredClone(manifest.appApiMessage);
  forged.ownerDevice.deviceId = 'other-phone';
  assert.throws(() => binding.parseMessageRunBinding(forged), { code: 'MESSAGE_RUN_BINDING_INVALID' });
});
afterEach(async () => {
  manager.killAll();
  for (const id of tracked) {
    const run = await runs.getRun(id);
    if (run && !runs.isTerminalRunState(run.state)) await runs.updateRun(id, { state: 'failed' });
  }
  tracked.clear();
});
after(async () => { await meta.flushSessionsMetaNow(); console.log('Retained isolated message commit root: ' + root); });

test('commit schema accepts only the original preparation reference', () => {
  const valid = { version: 1, preparationId: 'mprep_12345678-1234-1234-1234-123456789abc' };
  assert.deepEqual(api.parseMessageCommit(valid), valid);
  for (const value of [null, {}, { ...valid, version: 2 }, { ...valid, text: 'replacement' },
    { ...valid, scope: {} }, { ...valid, authenticatedPrincipalKind: 'owner' }, { ...valid, preparationId: 'mprep_' + '-'.repeat(36) }])
    assert.throws(() => api.parseMessageCommit(value), { code: 'INVALID_ARGUMENT' });
});

test('actual Run is durable acceptance and immutable queue; receipt exposes no execution input or secret', async () => {
  const value = await seed(); const result = await commit(value);
  assert.equal(result.accepted, true); assert.equal(result.queued, true); assert.equal(result.dispatched, false);
  assert.equal(result.state, 'queued'); assert.equal(result.launchAdmittedAt, null);
  const evidence = await api.readMessageRun(result.runId);
  assert.equal(result.runId, binding.messageRunId(evidence.record));
  assert.equal(evidence.manifest.preparation.text, value.request.text);
  assert.equal(evidence.run.appApiMessageQueue, true);
  assert.equal(evidence.binding.configuration.model, 'frozen-model');
  assert.equal((await meta.findSessionMeta(value.sessionId)).activeRunId, undefined);
  assert.equal((await runs.findRunByRequest(value.sessionId, value.request.requestId)).id, result.runId);
  for (const key of ['text', 'scope', 'runOptions', 'token', 'configuration', 'principalKind']) assert.equal(Object.hasOwn(result, key), false);
});

test('concurrent replay preserves one actual Run and publication marker', async () => {
  const value = await seed();
  const results = await Promise.all(Array.from({ length: 8 }, () => commit(value)));
  assert.equal(results.filter(row => !row.duplicate).length, 1);
  assert.equal(new Set(results.map(row => row.runId)).size, 1);
  const before = await readFile(runs.runManifestPath(results[0].runId));
  await commit(value);
  assert.deepEqual(await readFile(runs.runManifestPath(results[0].runId)), before);
  await assert.rejects(api.commitSessionApiMessage(value.sessionId, value.scope, value.request.requestId,
    { ...value.payload, preparationId: 'mprep_12345678-1234-1234-1234-123456789abc' }, 'owner'), { code: 'MESSAGE_IDEMPOTENCY_CONFLICT' });
});

test('new expired commit rejects, but accepted replay retains identity and expiry', async () => {
  const value = await seed(); const originalNow = Date.now;
  Date.now = () => Date.parse(value.request.expiresAt) + 1;
  try { await assert.rejects(commit(value), { code: 'REQUEST_EXPIRED' }); } finally { Date.now = originalNow; }
  const accepted = await commit(value);
  Date.now = () => Date.parse(value.request.expiresAt) + 1;
  try {
    const replay = await commit(value); assert.equal(replay.runId, accepted.runId); assert.equal(replay.accepted, true);
    assert.equal(replay.expiresAt, value.request.expiresAt);
    let calls = 0;
    const outcome = await api.continueScopedMessageRun(accepted.runId, executeOptions(async () => { calls++; }));
    assert.equal(calls, 0); assert.equal(outcome.run.state, 'failed');
    assert.equal((await runs.getRun(accepted.runId)).messageFailureCode, 'REQUEST_EXPIRED');
  } finally { Date.now = originalNow; }
});

test('project A to B to A rejects commit before acceptance', async () => {
  const value = await seed();
  await meta.mutateSessionMeta(value.sessionId, draft => { draft.projectId = 'p2'; return true; });
  await meta.mutateSessionMeta(value.sessionId, draft => { draft.projectId = value.scope.expectedProjectId; return true; });
  await assert.rejects(commit(value), { code: 'REVISION_CONFLICT' });
  assert.equal(await runs.findRunByRequest(value.sessionId, value.request.requestId), null);
});

test('busy Session keeps queued Run and does not overwrite the actual active Run', async () => {
  const value = await seed(); const queued = await commit(value);
  const active = await runs.createRun({ status: { id: `active_${seq}`, sessionId: value.sessionId, requestId: 'old_request', state: 'running' }, manifest: {} });
  tracked.add(active.id);
  await meta.mutateSessionMeta(value.sessionId, draft => { draft.activeRunId = active.id; return true; });
  let calls = 0;
  const outcome = await api.continueScopedMessageRun(queued.runId, executeOptions(async () => { calls++; }));
  assert.equal(outcome.waiting, true); assert.equal(calls, 0);
  assert.equal((await runs.getRun(queued.runId)).state, 'queued');
  assert.equal((await meta.findSessionMeta(value.sessionId)).activeRunId, active.id);
});

test('conditional exact cancellation terminalizes a retained queued message without cancelling the other active Run', async () => {
  const value = await seed(); const queued = await commit(value);
  const active = await runs.createRun({ status: { id: `other_active_${seq}`, sessionId: value.sessionId,
    requestId: `other_request_${seq}`, state: 'running' }, manifest: {} }); tracked.add(active.id);
  await meta.mutateSessionMeta(value.sessionId, draft => { draft.activeRunId = active.id; return true; });
  const req = new PassThrough(); req.method = 'POST'; req.headers = {
    [scopeHeader]: Buffer.from(JSON.stringify(value.scope)).toString('base64url') };
  const parsedUrl = new URL(`/api/runs/${queued.runId}/cancel`, 'http://localhost');
  const res = { setHeader() {} };
  const pending = handleSessionMainRoutes({ req, res, pathname: parsedUrl.pathname, parsedUrl, authSession: { role: 'owner' },
    requireSessionAccess: async (_res, _auth, id, flags) => { assert.equal(id, value.sessionId); assert.equal(flags.metadataOnly, true); return true; },
    writeJson: (_res, status, body) => Object.assign(res, { status, body }) }); req.end();
  assert.equal(await pending, true); assert.equal(res.status, 200); assert.equal(res.body.run.id, queued.runId);
  assert.equal(res.body.run.state, 'cancelled'); assert.equal((await runs.getRun(active.id)).cancelRequested, false);
  assert.equal((await meta.findSessionMeta(value.sessionId)).activeRunId, active.id);
});

test('claim activates the same Run and metadata remains writable during blocked preparation', async () => {
  const value = await seed(); const queued = await commit(value); const entered = deferred(); const release = deferred();
  const pending = api.continueScopedMessageRun(queued.runId, executeOptions(async evidence => {
    assert.equal(context.currentMessageExecution().runId, queued.runId);
    assert.equal((await meta.findSessionMeta(value.sessionId)).activeRunId, queued.runId);
    entered.resolve(); await release.promise;
    await runs.updateRun(evidence.run.id, { state: 'accepted' });
    return await runs.getRun(evidence.run.id);
  }));
  await entered.promise;
  await meta.mutateSessionMeta(value.sessionId, draft => { draft.name = 'Name changed while preparing'; return true; });
  release.resolve(); const outcome = await pending;
  assert.equal(outcome.run.id, queued.runId); assert.equal(outcome.run.state, 'accepted');
  assert.equal(context.currentMessageExecution(), null);
});

test('scope movement while preparation waits prevents publication of the prepared Run', async () => {
  const value = await seed(); const queued = await commit(value); const entered = deferred(); const release = deferred();
  const pending = api.continueScopedMessageRun(queued.runId, executeOptions(async () => {
    entered.resolve(); await release.promise;
    await runs.updateRun(queued.runId, { state: 'accepted' });
  }));
  await entered.promise;
  await meta.mutateSessionMeta(value.sessionId, draft => { draft.projectId = 'p2'; return true; });
  await meta.mutateSessionMeta(value.sessionId, draft => { draft.projectId = value.scope.expectedProjectId; return true; });
  release.resolve(); const outcome = await pending;
  assert.equal(outcome.run.state, 'failed');
  assert.equal((await runs.getRun(queued.runId)).messageFailureCode, 'REVISION_CONFLICT');
  assert.equal((await runs.getRun(queued.runId)).runnerStartedAt, null);
});

test('durable queue order blocks a later submission until the earlier Run leaves the queue', async () => {
  const value = await seed(); const first = await commit(value);
  const secondRequest = { ...value.request, requestId: value.request.requestId + '_second' };
  const secondPreparation = await preparation.prepareSessionApiMessage(value.sessionId, value.scope, secondRequest);
  const second = await api.commitSessionApiMessage(value.sessionId, value.scope, secondRequest.requestId,
    { version: 1, preparationId: secondPreparation.preparationId }, 'owner'); tracked.add(second.runId);
  let calls = 0;
  const later = await api.continueScopedMessageRun(second.runId, executeOptions(async () => { calls++; }));
  assert.equal(later.waiting, true); assert.equal(calls, 0);
  await runs.updateRun(first.runId, { state: 'cancelled' });
  const admitted = await api.continueScopedMessageRun(second.runId, executeOptions(async () => {
    calls++; return runs.updateRun(second.runId, { state: 'accepted' });
  }));
  assert.equal(admitted.waiting, false); assert.equal(calls, 1);
});

test('deadline reached during preparation prevents the next Run publication', async () => {
  const value = await seed(); const accepted = await commit(value); const originalNow = Date.now;
  const outcome = await api.continueScopedMessageRun(accepted.runId, executeOptions(async () => {
    Date.now = () => Date.parse(value.request.expiresAt) + 1;
    try { await runs.updateRun(accepted.runId, { state: 'accepted' }); } finally { Date.now = originalNow; }
  }));
  assert.equal(outcome.run.state, 'failed'); assert.equal((await runs.getRun(accepted.runId)).messageFailureCode, 'REQUEST_EXPIRED');
});

test('runtime configuration remains frozen while Session defaults change without changing scope', async () => {
  const value = await seed({ riskMode: 'full-auto', riskModeExplicit: false }); const queued = await commit(value);
  await meta.mutateSessionMeta(value.sessionId, draft => { draft.model = 'new-default'; draft.riskModeExplicit = true; return true; });
  await api.continueScopedMessageRun(queued.runId, executeOptions(async () => {
    const session = context.applyMessageExecutionConfiguration(await meta.findSessionMeta(value.sessionId));
    assert.equal(session.model, 'frozen-model');
    assert.equal(session.riskModeExplicit, false);
    assert.equal(manager.resolveSessionRiskModeForRun(session), 'recommended');
    assert.equal((await manager.getSession(value.sessionId)).model, 'frozen-model');
    return runs.updateRun(queued.runId, { state: 'accepted' });
  }));
  assert.equal((await meta.findSessionMeta(value.sessionId)).model, 'new-default');
});

test('accepted template instructions and localized prompt survive later template changes', async () => {
  const template = await apps.createApp({ name: 'Frozen Agent', tool: 'scoped-fixture',
    systemPrompt: 'Original instructions', perMessageSystemPrompt: { en: 'Original localized instruction' } });
  const value = await seed({ templateId: template.id, templateName: 'Frozen Agent',
    systemPrompt: 'Session-specific instructions', uiLanguage: 'en' });
  const queued = await commit(value);
  await apps.updateApp(template.id, { name: 'Changed Agent', systemPrompt: 'Changed instructions',
    perMessageSystemPrompt: { en: 'Changed localized instruction' } });
  const evidence = await api.readMessageRun(queued.runId);
  await context.withMessageExecution({ runId: queued.runId, scope: value.scope,
    configuration: evidence.binding.configuration, expiresAt: value.request.expiresAt }, async () => {
    const session = await manager.getSession(value.sessionId);
    assert.equal(session.templateName, 'Frozen Agent'); assert.equal(session.systemPrompt, 'Session-specific instructions');
    assert.equal(await manager.resolveAgentMessagePrompt(session), 'Original localized instruction');
    assert.equal(Object.hasOwn(session, 'templatePerMessageSystemPrompt'), false);
  });
});

test('explicit one-run template overlay is frozen without changing Session selection', async () => {
  const template = await apps.createApp({ name: 'One-run Agent', tool: 'scoped-fixture', systemPrompt: 'Run-only instructions' });
  const value = await seed({}, { runOptions: { templateId: template.id } }); const queued = await commit(value);
  const evidence = await api.readMessageRun(queued.runId);
  assert.equal(evidence.binding.configuration.templateId, template.id);
  assert.equal(evidence.binding.configuration.systemPrompt, 'Run-only instructions');
  assert.equal((await meta.findSessionMeta(value.sessionId)).templateId, undefined);
});

test('cold server startup discovers a durable queued Run without an active Session pointer', async () => {
  const value = await seed({}, { runOptions: { planAction: 'execute', planId: 'missing_plan_for_cold_start' } });
  const queued = await commit(value); await meta.flushSessionsMetaNow();
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), 'cold-start'], { env: {
    ...process.env, RAGENT_MESSAGE_COMMIT_TEST_ROOT: root,
    RAGENT_MESSAGE_COMMIT_INPUT: JSON.stringify({ ...value, runId: queued.runId }) }, timeout: 15000 });
  const receipt = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('COLD_STARTED=')).slice('COLD_STARTED='.length));
  assert.equal(receipt.runId, queued.runId); assert.equal(receipt.state, 'failed');
  assert.equal(receipt.failureCode, 'PREPARATION_FAILED'); assert.equal(receipt.dispatched, false);
});

test('message context cannot write a foreign Run and expires before new metadata effects', async () => {
  const value = await seed(); const queued = await commit(value); const evidence = await api.readMessageRun(queued.runId);
  await context.withMessageExecution({ runId: queued.runId, scope: value.scope,
    configuration: evidence.binding.configuration, expiresAt: value.request.expiresAt }, async () => {
    await assert.rejects(async () => runs.updateRun('foreign_run', { state: 'accepted' }), { code: 'MESSAGE_RUN_BINDING_INVALID' });
  });
  await assert.rejects(context.withMessageExecution({ runId: queued.runId, scope: value.scope,
    configuration: evidence.binding.configuration, expiresAt: new Date(0).toISOString() }, () => meta.loadSessionsMeta()), { code: 'REQUEST_EXPIRED' });
});

test('original binding survives whole manifest replacement and rejects mutation, downgrade and foreign sidecar', async () => {
  const value = await seed(); const queued = await commit(value);
  const before = await runs.getRunManifest(queued.runId);
  const replaced = await runs.updateRunManifest(queued.runId, () => ({ sessionId: value.sessionId, requestId: value.request.requestId, options: { images: [] } }));
  assert.deepEqual(replaced.appApiMessage, before.appApiMessage);
  verifyRunInputBinding(replaced, await runs.getRun(queued.runId), queued.runId);
  await assert.rejects(runs.updateRunManifest(queued.runId, { appApiMessage: null }), { code: 'MESSAGE_RUN_BINDING_INVALID' });
  await assert.rejects(runs.updateRun(queued.runId, { appApiMessageVersion: null }), { code: 'MESSAGE_IDEMPOTENCY_CONFLICT' });
  const originalRun = await runs.getRun(queued.runId);
  assert.throws(() => verifyRunInputBinding(replaced, { ...originalRun, requestId: 'other' }, queued.runId));
  const recovered = await api.readMessageRun(queued.runId);
  assert.equal(recovered.record.request.text, value.request.text);
  assert.equal(recovered.manifest.preparation, undefined);
});

test('fresh receipt rejects disk-corrupt or removed bindings despite cached manifest', async () => {
  const value = await seed(); const queued = await commit(value);
  const path = runs.runManifestPath(queued.runId); const before = await readFile(path);
  const corrupt = JSON.parse(before); delete corrupt.appApiMessage;
  await writeFile(path, JSON.stringify(corrupt));
  await assert.rejects(api.readSessionApiMessageCommit(value.sessionId, value.scope, value.request.requestId), { code: 'MESSAGE_RUN_BINDING_INVALID' });
  await writeFile(path, before);
});

test('launch admission rechecks original scope, deadline, ownership and cancellation without claiming dispatch', async () => {
  const value = await seed(); const queued = await commit(value);
  await assert.rejects(api.admitScopedMessageLaunch(queued.runId), { code: 'REVISION_CONFLICT' });
  await api.continueScopedMessageRun(queued.runId, executeOptions(async () => runs.updateRun(queued.runId, { state: 'accepted' })));
  await api.admitScopedMessageLaunch(queued.runId);
  const receipt = await api.readSessionApiMessageCommit(value.sessionId, value.scope, value.request.requestId);
  assert.ok(receipt.launchAdmittedAt); assert.equal(receipt.dispatched, false);
  await runs.updateRun(queued.runId, { cancelRequested: true });
  await assert.rejects(api.admitScopedMessageLaunch(queued.runId), { code: 'REQUEST_CANCELLED' });
});

test('launch after project A to B to A does not use an old logical admission permit', async () => {
  const value = await seed(); const queued = await commit(value);
  await api.continueScopedMessageRun(queued.runId, executeOptions(async () => runs.updateRun(queued.runId, { state: 'accepted' })));
  await api.admitScopedMessageLaunch(queued.runId);
  await meta.mutateSessionMeta(value.sessionId, draft => { draft.projectId = 'p2'; return true; });
  await meta.mutateSessionMeta(value.sessionId, draft => { draft.projectId = value.scope.expectedProjectId; return true; });
  await assert.rejects(api.admitScopedMessageLaunch(queued.runId), { code: 'REVISION_CONFLICT' });
});

test('shared Session publication serializes different ordinary request IDs before creating a Run', async () => {
  const value = await seed();
  const create = suffix => admission.publishSessionRun(value.sessionId, null, async () => {
    const run = await runs.createRun({ status: { id: `race_${seq}_${suffix}`, sessionId: value.sessionId,
      requestId: `race_request_${suffix}`, state: 'preparing' }, manifest: {} }); tracked.add(run.id); return run;
  });
  const results = await Promise.allSettled([create('a'), create('b')]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'SESSION_BUSY');
  const accepted = results.find(row => row.status === 'fulfilled').value.run;
  assert.equal((await meta.findSessionMeta(value.sessionId)).activeRunId, accepted.id);
});

test('deterministic history event survives retry and preserves the original user input once', async () => {
  const value = await seed(); const queued = await commit(value);
  const event = messageEvent('user', value.request.text, undefined, { id: `message-run:${queued.runId}`, requestId: value.request.requestId, runId: queued.runId });
  const first = await history.appendRetainedMessageEvent(value.sessionId, event);
  const second = await history.appendRetainedMessageEvent(value.sessionId, event);
  assert.equal(first.seq, second.seq);
  const events = await history.readEventsAfter(value.sessionId, 0);
  assert.equal(events.filter(item => item.id === event.id).length, 1);
});

test('production HTTP commit queues under busy runtime and read-only receipt does not resume it', async () => {
  const value = await seed(); manager.ensureSessionRuntimeState(value.sessionId).pendingCompact = true;
  const accepted = await route(value);
  assert.equal(accepted.status, 200); assert.equal(accepted.body.accepted, true); assert.equal(accepted.body.queued, true);
  await manager.scheduleScopedMessageRun(value.sessionId, accepted.body.runId);
  assert.equal((await runs.getRun(accepted.body.runId)).state, 'queued');
  manager.killAll();
  const before = await readFile(runs.runStatusPath(accepted.body.runId));
  const read = await route(value, 'GET');
  assert.equal(read.body.runId, accepted.body.runId); assert.equal(read.body.dispatched, false);
  assert.equal(read.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(await readFile(runs.runStatusPath(accepted.body.runId)), before);
});

test('production continuation rejects moved scope and settles original accepted Run without invoking provider', async () => {
  const value = await seed(); const accepted = await commit(value);
  await meta.mutateSessionMeta(value.sessionId, draft => { draft.projectId = 'p2'; return true; });
  const outcome = await manager.scheduleScopedMessageRun(value.sessionId, accepted.runId);
  assert.equal(outcome.run.id, accepted.runId); assert.equal(outcome.run.state, 'failed');
  assert.equal((await runs.getRun(accepted.runId)).messageFailureCode, 'REVISION_CONFLICT');
  assert.equal(outcome.run.runnerStartedAt, null);
});

test('production continuation reaches ordinary message validation and retains the same failed Run for missing plan', async () => {
  const value = await seed({}, { runOptions: { planAction: 'execute', planId: 'missing_plan_for_scoped_test' } });
  const accepted = await commit(value);
  const outcome = await manager.scheduleScopedMessageRun(value.sessionId, accepted.runId);
  assert.equal(outcome.run.id, accepted.runId); assert.equal(outcome.run.state, 'failed');
  assert.equal((await runs.getRun(accepted.runId)).messageFailureCode, 'PREPARATION_FAILED');
  assert.match(outcome.run.failureReason, /Plan artifact not found/);
  assert.equal(outcome.run.runnerStartedAt, null);
  assert.equal((await history.readEventsAfter(value.sessionId, 0)).filter(row => row.id === `message-run:${accepted.runId}`).length, 1);
});

test('production pipeline publishes immutable prepared inputs and logical launch admission before a real broker rejection', { timeout: 30000 }, async () => {
  const value = await seed({ tool: 'scoped-gated-fixture', riskMode: 'full-auto', riskModeExplicit: true });
  const accepted = await commit(value); const requests = []; const entered = deferred(); const release = deferred();
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\ragent-commit-fixture-${process.pid}` : join(root, 'broker.sock');
  const previous = { socket: process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET, required: process.env.RAGENT_RUNNER_LIFECYCLE_REQUIRED };
  const server = createBroker(socket => {
    socket.setEncoding('utf8'); let text = '';
    socket.on('data', chunk => { text += chunk; if (!text.includes('\n')) return;
      requests.push(JSON.parse(text.split('\n')[0]));
      entered.resolve();
      void release.promise.then(() => socket.end(JSON.stringify({ ok: false, code: 'FIXTURE_BROKER_DENIED', error: 'Fixture broker rejects actual launch' }) + '\n'));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET = socketPath;
  process.env.RAGENT_RUNNER_LIFECYCLE_REQUIRED = '1';
  try {
    const pending = manager.scheduleScopedMessageRun(value.sessionId, accepted.runId);
    await entered.promise;
    await meta.mutateSessionMeta(value.sessionId, draft => { draft.name = 'Changed during actual broker wait'; return true; });
    release.resolve(); const outcome = await pending;
    assert.equal(requests.length, 1); assert.equal(requests[0].runId, accepted.runId);
    const evidence = await api.readMessageRun(accepted.runId);
    assert.equal(evidence.run.id, accepted.runId); assert.equal(evidence.run.state, 'failed');
    assert.ok(evidence.run.messageLaunchAdmittedAt); assert.equal(evidence.run.runnerStartedAt, null);
    assert.equal(evidence.manifest.preparation, undefined);
    assert.equal(evidence.binding.configuration.riskModeExplicit, true);
    assert.match(evidence.manifest.prompt || evidence.manifest.options?.prompt || '', /原始要求/);
    assert.match(outcome.run.failureReason, /Fixture broker/);
  } finally {
    release.resolve();
    await new Promise(resolve => server.close(resolve));
    if (previous.socket === undefined) delete process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET; else process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET = previous.socket;
    if (previous.required === undefined) delete process.env.RAGENT_RUNNER_LIFECYCLE_REQUIRED; else process.env.RAGENT_RUNNER_LIFECYCLE_REQUIRED = previous.required;
  }
});

test('HTTP authorization, strict input and scope errors cannot create acceptance', async () => {
  const value = await seed();
  for (const auth of [{ role: 'visitor' }, { role: 'owner', principalKind: 'run_capability' }])
    assert.equal((await route(value, 'POST', { auth })).status, 403);
  assert.equal((await route(value, 'POST', { headers: { [scopeHeader]: undefined } })).status, 400);
  assert.equal((await route(value, 'POST', { query: '?autoRun=true' })).status, 400);
  assert.equal((await route(value, 'DELETE')).status, 405);
  assert.equal((await route(value, 'POST', { payload: { ...value.payload, text: 'replace' } })).status, 400);
  assert.equal((await route(value, 'POST', { raw: ' '.repeat(4097) })).status, 413);
  assert.equal(await runs.findRunByRequest(value.sessionId, value.request.requestId), null);
});

test('actual HTTP process death after durable acceptance before reply recovers one original queued Run', async () => {
  const value = await seed(); await meta.flushSessionsMetaNow();
  const child = fork(new URL(import.meta.url), ['crash-http'], { env: { ...process.env,
    RAGENT_MESSAGE_COMMIT_TEST_ROOT: root, RAGENT_MESSAGE_COMMIT_INPUT: JSON.stringify(value) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let pending;
  const message = type => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Child checkpoint timeout')), 15000);
    child.on('message', event => { if (event.type === type) { clearTimeout(timeout); resolve(event); } });
    child.once('error', reject);
  });
  try {
    const listening = await message('listening'); const accepted = message('accepted-before-reply');
    const body = JSON.stringify(value.payload);
    pending = httpRequest({ hostname: '127.0.0.1', port: listening.port, path: committedPath(value), method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        [scopeHeader]: Buffer.from(JSON.stringify(value.scope)).toString('base64url') } });
    pending.on('error', () => {}); pending.end(body);
    const checkpoint = await accepted;
    assert.equal(checkpoint.body.accepted, true); assert.equal(checkpoint.body.queued, true);
    tracked.add(checkpoint.body.runId);
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
    const cold = await promisify(execFile)(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'cold'], {
      env: { ...process.env, RAGENT_MESSAGE_COMMIT_TEST_ROOT: root, RAGENT_MESSAGE_COMMIT_INPUT: JSON.stringify(value) }, timeout: 15000 });
    const parsed = JSON.parse(cold.stdout.split('\n').find(line => line.startsWith('COLD_COMMIT=')).slice('COLD_COMMIT='.length));
    assert.equal(parsed.receipt.runId, checkpoint.body.runId); assert.equal(parsed.receipt.accepted, true);
    assert.equal(parsed.duplicate.runId, checkpoint.body.runId); assert.equal(parsed.duplicate.duplicate, true);
  } finally { pending?.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('actual continuation process death after prepared manifest replacement recovers original Run and one user event', async () => {
  const value = await seed({ tool: 'scoped-gated-fixture', riskMode: 'full-auto', riskModeExplicit: true });
  const accepted = await commit(value); const input = { ...value, runId: accepted.runId };
  await meta.flushSessionsMetaNow();
  const child = fork(new URL(import.meta.url), ['crash-prepared'], { env: { ...process.env,
    RAGENT_MESSAGE_COMMIT_TEST_ROOT: root, RAGENT_MESSAGE_COMMIT_INPUT: JSON.stringify(input) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Prepared checkpoint timeout: ' + stderr)), 15000);
      child.on('message', event => { if (event.type === 'prepared-manifest-before-status') { clearTimeout(timeout); resolve(event); } });
      child.once('error', reject); child.once('exit', () => { clearTimeout(timeout); reject(new Error('Child exited before checkpoint: ' + stderr)); });
    });
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
    const cold = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), 'cold-resume'], { env: {
      ...process.env, RAGENT_MESSAGE_COMMIT_TEST_ROOT: root, RAGENT_MESSAGE_COMMIT_INPUT: JSON.stringify(input) }, timeout: 15000 });
    const result = JSON.parse(cold.stdout.split('\n').find(line => line.startsWith('COLD_RESUMED=')).slice('COLD_RESUMED='.length));
    assert.equal(result.receipt.runId, accepted.runId); assert.equal(result.receipt.accepted, true);
    assert.equal(result.receipt.state, 'failed'); assert.equal(result.receipt.dispatched, false);
    assert.equal(result.userEvents, 1);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
}
