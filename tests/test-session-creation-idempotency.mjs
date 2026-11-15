import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseSessionCreationRequest } from '../chat/session-creation-contract.mjs';

const root = process.env.RAGENT_CREATION_TEST_ROOT || await mkdtemp(join(tmpdir(), 'ragent-creation-api-'));
const configDir = join(root, 'config');
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
delete process.env.RAGENT_INSTANCE_ROOT;
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
const { createSessionWithOutcome } = await import('../chat/session-manager.mjs');
const { readEventsAfter } = await import('../chat/history.mjs');

async function call(payload, auth = { role: 'owner' }, headerKey) {
  const req = new PassThrough();
  req.method = 'POST';
  req.headers = { ...(headerKey ? { 'idempotency-key': headerKey } : {}) };
  req.end(JSON.stringify(payload));
  const res = {
    statusCode: 0, body: '',
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = body; },
  };
  assert.equal(await handleSessionMainRoutes({ req, res, pathname: '/api/sessions', authSession: auth,
    isDirectoryPath: async () => true,
    isAgentScopedAuthSession: (session) => session.role === 'visitor',
    getAuthPrincipalId: (session) => session.principalId || '',
    getAuthScopeAgentId: (session) => session.agentId || '',
    writeJson: (response, status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); },
  }), true);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

if (process.argv[2] === 'replay') {
  const result = await call(JSON.parse(process.env.RAGENT_CREATION_TEST_PAYLOAD));
  assert.equal(result.status, 200);
  assert.equal(result.body.duplicate, true);
  const events = await readEventsAfter(result.body.session.id, 0, { includeBodies: true, strict: true });
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'template_context');
  assert.equal(events[1].content, 'Frozen welcome');
  assert.equal(result.body.session.systemPrompt, 'Frozen behavior');
  console.log(JSON.stringify({ id: result.body.session.id, events: events.length }));
} else {
  const payload = { tool: 'codex', folder: root, name: 'Phone intake', idempotencyKey: 'create-1' };
  const first = await call(payload);
  assert.equal(first.status, 201);
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.session.creationRequest, undefined, 'Internal identity must not leak in Session projections');
  const replay = await call({ idempotencyKey: 'create-1', name: 'Phone intake', folder: root, tool: 'codex' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.session.id, first.body.session.id);
  assert.equal((await call({ ...payload, name: 'Changed task' })).status, 409);
  for (const key of ['', ' '.repeat(2), 123, 'a'.repeat(201)]) {
    assert.equal((await call({ ...payload, idempotencyKey: key })).status, 400);
  }
  assert.equal((await call(payload, undefined, 'different')).status, 400);
  assert.equal((await call({ ...payload, externalTriggerId: 'recurring-thread' })).status, 400);
  const fresh = await call({ ...payload, idempotencyKey: 'create-2' });
  assert.notEqual(fresh.body.session.id, first.body.session.id, 'Same content with a new operation is legitimate');
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => call({ ...payload, idempotencyKey: 'parallel' })));
  assert.equal(new Set(concurrent.map((result) => result.body.session.id)).size, 1);
  assert.equal(concurrent.filter((result) => !result.body.duplicate).length, 1);
  const { createApp } = await import('../chat/apps.mjs');
  const app = await createApp({ name: 'Intake Agent', tool: 'codex', systemPrompt: 'Handle intake',
    welcomeMessage: 'Ready for intake', templateContext: { content: 'Saved Agent context' } });
  const agentPayload = { ...payload, templateId: app.id, idempotencyKey: 'agent-parallel' };
  const agentResults = await Promise.all(Array.from({ length: 4 }, () => call(agentPayload)));
  assert.equal(new Set(agentResults.map((result) => result.body.session.id)).size, 1);
  const initializedEvents = await readEventsAfter(agentResults[0].body.session.id, 0, { includeBodies: true });
  assert.equal(initializedEvents.filter((event) => event.type === 'template_context').length, 1);
  assert.equal(initializedEvents.filter((event) => event.content === 'Ready for intake').length, 1);
  assert.equal(agentResults[0].body.session.systemPrompt, 'Handle intake');
  // Scope isolation is a server-side identity fact, not a callerPackage extra.
  const a = parseSessionCreationRequest(payload, null, 'principal-a');
  const b = parseSessionCreationRequest(payload, null, 'principal-b');
  const ca = await createSessionWithOutcome(root, 'codex', 'A', { creationRequest: a });
  const cb = await createSessionWithOutcome(root, 'codex', 'B', { creationRequest: b });
  assert.notEqual(ca.session.id, cb.session.id);

  const recoveryPayload = { tool: 'codex', folder: root, templateId: 'removed-agent', idempotencyKey: 'recovery' };
  const initialization = {
    template: { id: 'removed-agent', name: 'Frozen Agent', tool: 'codex', systemPrompt: 'Frozen behavior' },
    appliedAt: new Date().toISOString(),
    events: [ { type: 'template_context', content: 'Frozen context', timestamp: Date.now() },
      { type: 'message', role: 'assistant', content: 'Frozen welcome', timestamp: Date.now() } ],
  };
  const interrupted = await createSessionWithOutcome(root, 'codex', '', {
    creationRequest: parseSessionCreationRequest(recoveryPayload, null, 'owner'),
    creationInitialization: initialization,
  });
  assert.equal(interrupted.session.creationRequest.state, 'initializing');
  const childEnv = { ...process.env, RAGENT_CREATION_TEST_ROOT: root,
    RAGENT_CREATION_TEST_PAYLOAD: JSON.stringify(recoveryPayload) };
  const runReplay = () => promisify(execFile)(process.execPath, [import.meta.filename, 'replay'], { env: childEnv });
  await runReplay();
  // Simulate death after event files were written, before history metadata and
  // creation-stage acknowledgement. Cold replay must recover the orphan tail.
  const metasPath = join(configDir, 'chat-sessions.json');
  const metas = JSON.parse(await readFile(metasPath, 'utf8'));
  const recovering = metas.find((meta) => meta.id === interrupted.session.id);
  recovering.creationRequest.state = 'initializing';
  recovering.creationRequest.initialization = initialization;
  await writeFile(metasPath, JSON.stringify(metas));
  const historyMetaPath = join(configDir, 'chat-history', interrupted.session.id, 'meta.json');
  const historyMeta = JSON.parse(await readFile(historyMetaPath, 'utf8'));
  await writeFile(historyMetaPath, JSON.stringify({ ...historyMeta, latestSeq: 0, size: 0, counts: {} }));
  await runReplay();
  const finalMetas = JSON.parse(await readFile(metasPath, 'utf8'));
  assert.equal(finalMetas.find((meta) => meta.id === interrupted.session.id).creationRequest.state, 'complete');
  // Only the root generated by this parent test may be removed; never an
  // externally supplied instance or an interpolated shell deletion target.
  assert.equal(resolve(dirname(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('ragent-creation-api-'));
  await rm(root, { recursive: true, force: true });
  console.log('Session creation route: concurrent retries, conflicts, immutable initialization and cold crash recovery passed.');
}
