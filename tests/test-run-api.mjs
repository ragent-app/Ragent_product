import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { parse as parseUrl } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test, after } from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'ragent-run-api-'));
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
await mkdir(process.env.RAGENT_CONFIG_DIR, { recursive: true });
await writeFile(join(process.env.RAGENT_CONFIG_DIR, 'tools.json'), JSON.stringify([
  { id: 'run-fixture', name: 'Run fixture', command: process.execPath, runtimeFamily: 'codex-json', models: [{ id: 'fixture-model' }] },
]));
const meta = await import('../chat/session-meta-store.mjs');
const runs = await import('../chat/runs.mjs');
const history = await import('../chat/history.mjs');
const preparation = await import('../chat/message-preparation-store.mjs');
const commit = await import('../chat/message-commit-store.mjs');
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
const api = await import('../chat/run-api-store.mjs');
const contract = await import('../chat/run-api-contract.mjs');
const { CHAT_RUNS_DIR, CHAT_HISTORY_DIR, CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');
const { messageEvent } = await import('../chat/normalizer.mjs');
const { ensureProjectForSessionFolder } = await import('../chat/projects.mjs');
// A real project prevents the background legacy-session migration from
// retargeting this fixture while the scoped read tests are running.
const fixtureProject = await ensureProjectForSessionFolder(root);
let sequence = 0;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
async function seed() {
  const sessionId = `run_api_${++sequence}`;
  await meta.withSessionsMetaMutation(async (rows, save) => {
    rows.push({ id: sessionId, name: 'Run API', folder: root, projectId: fixtureProject.id, tool: 'run-fixture',
      model: 'fixture-model', sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true });
    await save(rows, { immediate: true, durable: true });
  });
  const current = await meta.readSessionApiContext(sessionId);
  return { sessionId, scope: { version: 1, sessionId, expectedScopeRevision: current.scopeRevision, expectedProjectId: current.projectId } };
}
async function makeRun(value, state = 'running', extra = {}) {
  return runs.createRun({ status: { sessionId: value.sessionId, state, requestId: `private_${++sequence}`, ...extra }, manifest: {} });
}
async function active(value, run) { await meta.mutateSessionMeta(value.sessionId, row => { row.activeRunId = run.id; return true; }); }
async function route(value, suffix = '', options = {}) {
  const path = options.path || `/api/sessions/${value.sessionId}/app-api-runs${suffix}`;
  const url = new URL(path, 'http://localhost');
  const req = new PassThrough(); req.method = options.method || 'GET';
  req.headers = { 'content-type': 'application/json', 'x-ragent-app-api-scope': Buffer.from(JSON.stringify(value.scope)).toString('base64url'), ...options.headers };
  const res = new EventEmitter(); res.headers = {}; res.setHeader = (key, val) => { res.headers[key] = val; };
  let checks = 0;
  const done = handleSessionMainRoutes({ req, res, parsedUrl: options.legacyUrl ? parseUrl(path, true) : url, pathname: url.pathname,
    authSession: options.auth || { role: 'owner', principalKind: 'trusted_device' },
    requireSessionAccess: async (response, _auth, id, flags) => {
      checks++; assert.equal(id, value.sessionId); if (flags) assert.equal(flags.metadataOnly, true);
      const allowed = options.access ? await options.access(checks) : true;
      if (!allowed) Object.assign(response, { status: 403, body: { code: 'PERMISSION_DENIED' } });
      return allowed;
    }, writeJson: (_res, status, body) => Object.assign(res, { status, body }) });
  req.end(options.raw ?? (options.body ? JSON.stringify(options.body) : undefined));
  if (options.started) options.started({ req, res });
  assert.equal(await done, true);
  return { status: res.status, body: res.body, headers: res.headers, checks };
}
after(async () => { await meta.flushSessionsMetaNow(); console.log(`Retained Run API test root: ${root}`); });

test('runtime approval carries independent custom answers and rejects an empty answer payload', async () => {
  const v = await seed();
  const run = await makeRun(v, 'running', { runtimeFamily: 'claude-stream-json-bidi' });
  await active(v, run);
  await runs.updateRun(run.id, { appServerPendingApprovals: [{ approvalId: 'claude:multi', state: 'pending', kind: 'question' }] });
  const path = `/api/runs/${run.id}/approvals/${encodeURIComponent('claude:multi')}`;
  const empty = await route(v, '', { path, method: 'POST', body: { decision: 'approve_with_answers', customAnswers: [] } });
  assert.equal(empty.status, 400);
  const response = await route(v, '', { path, method: 'POST', body: {
    decision: 'approve_with_answers', requestId: 'question-reply', choices: [-1, -1], customAnswers: ['first', 'second'],
  } });
  assert.equal(response.status, 202);
  const stored = await runs.getRun(run.id);
  const entry = stored.appServerApprovalResponseQueue.find(item => item.approvalId === 'claude:multi');
  assert.deepEqual(entry.choices, [-1, -1]);
  assert.deepEqual(entry.customAnswers, ['first', 'second']);
  await runs.updateRun(run.id, { state: 'cancelled' });
});

test('Claude multi-select choices are validated and queued without losing selections', async () => {
  const v = await seed();
  const run = await makeRun(v, 'running', { runtimeFamily: 'claude-stream-json-bidi' });
  await active(v, run);
  const questions = [
    { question: 'Features?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'Name?', multiSelect: false, options: [{ label: 'C' }] },
  ];
  await runs.updateRun(run.id, { appServerPendingApprovals: [{ approvalId: 'claude:select', state: 'pending', kind: 'question', params: { tool_name: 'AskUserQuestion', input: { questions } } }] });
  const path = `/api/runs/${run.id}/approvals/${encodeURIComponent('claude:select')}`;
  const invalid = await route(v, '', { path, method: 'POST', body: {
    decision: 'approve_with_multi_choices', multiChoices: [[0, 9], []], customAnswers: ['', 'Name'],
  } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'INVALID_APPROVAL_CHOICES');
  const response = await route(v, '', { path, method: 'POST', body: {
    decision: 'approve_with_multi_choices', requestId: 'select-reply', multiChoices: [[0, 1], []], customAnswers: ['Extra', 'Name'],
  } });
  assert.equal(response.status, 202);
  const stored = await runs.getRun(run.id);
  const entry = stored.appServerApprovalResponseQueue.find(item => item.approvalId === 'claude:select');
  assert.deepEqual(entry.multiChoices, [[0, 1], []]);
  assert.deepEqual(entry.customAnswers, ['Extra', 'Name']);
  await runs.updateRun(run.id, { state: 'cancelled' });
});

test('discovery describes six actual operations, honest cancellation and readonly support', async () => {
  const v = await seed();
  const response = await route(v, '', { path: '/api/run-api-contract' });
  assert.equal(response.status, 200); assert.equal(response.checks, 0);
  assert.equal(response.headers['Cache-Control'], 'private, no-store');
  assert.equal(response.body.readsDispatch, false); assert.equal(response.body.cancellationRequestedIsTerminal, false);
  assert.equal(response.body.cancellationReceipt, false); assert.equal(response.body.pauseSupported, false);
  assert.deepEqual(response.body.operations.map(x => x.id), ['runs.list', 'runs.get', 'runs.events', 'runs.result', 'runs.wait', 'runs.cancel']);
  assert.equal((await route(v, '', { path: '/api/run-api-contract?x=1' })).status, 400);
  assert.equal((await route(v, '', { path: '/api/run-api-contract', method: 'POST' })).status, 405);
});
test('authorization rejects unsupported principals before resource IO and rechecks delivery', async () => {
  const v = await seed(); const run = await makeRun(v);
  for (const auth of [{ role: 'visitor' }, { role: 'owner', principalKind: 'run_capability' }]) {
    const response = await route(v, `/${run.id}`, { auth });
    assert.equal(response.status, 403); assert.equal(response.checks, 0);
  }
  assert.equal((await route(v, `/${run.id}`, { access: () => false })).status, 403);
  const denied = await route(v, `/${run.id}`, { access: n => n === 1 });
  assert.equal(denied.status, 403); assert.ok(!JSON.stringify(denied.body).includes(run.id));
});
test('exact Run projection omits request, provider, path, process, raw result and private scope', async () => {
  const v = await seed(); const run = await makeRun(v, 'running', { providerResumeId: 'PRIVATE_PROVIDER',
    runnerSupervisorSocket: 'PRIVATE_SOCKET', result: { error: 'PRIVATE_ERROR' } });
  const r = await route(v, `/${run.id}`); assert.equal(r.status, 200);
  assert.equal(r.body.run.runId, run.id); assert.equal(r.body.run.terminal, false);
  assert.match(r.body.run.revision, /^[a-f0-9]{64}$/);
  for (const secret of ['PRIVATE_', run.requestId, 'expectedScopeRevision', 'runPublication', 'requestId', 'runnerProcessId'])
    assert.ok(!JSON.stringify(r.body).includes(secret));
  assert.equal((await route(await seed(), `/${run.id}`)).status, 404);
});
test('all reads leave Run and Session bytes unchanged', async () => {
  const v = await seed(); const run = await makeRun(v, 'completed', { responseId: 'published' });
  await history.appendEvent(v.sessionId, messageEvent('assistant', 'Published reply', null, { runId: run.id, responseId: 'published' }));
  const paths = [CHAT_SESSIONS_FILE, join(CHAT_RUNS_DIR, run.id, 'status.json'), join(CHAT_RUNS_DIR, run.id, 'manifest.json'), join(CHAT_HISTORY_DIR, v.sessionId, 'meta.json')];
  const before = await Promise.all(paths.map(path => readFile(path)));
  for (const suffix of ['', `/${run.id}`, `/${run.id}/events`, `/${run.id}/result`, `/${run.id}/wait?timeoutMs=0`])
    assert.equal((await route(v, suffix)).status, 200, suffix);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
});
test('list cursors bind exact scope and membership, not other Session additions', async () => {
  const v = await seed(); const first = await makeRun(v); const second = await makeRun(v);
  const page = await route(v, '?limit=1'); assert.equal(page.status, 200); assert.equal(page.body.runs[0].runId, second.id);
  await makeRun(await seed());
  const next = await route(v, `?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`);
  assert.equal(next.status, 200); assert.equal(next.body.runs[0].runId, first.id); assert.equal(next.body.nextCursor, null);
  await makeRun(v);
  assert.equal((await route(v, `?cursor=${encodeURIComponent(page.body.nextCursor)}`)).body.code, 'CURSOR_STALE');
});
test('query fields, duplicate parameters, malformed encoding and traversal fail closed', async () => {
  const v = await seed(); const run = await makeRun(v);
  for (const suffix of ['?limit=0', '?limit=33', '?limit=01', '?limit=1&limit=2', '?cursor=x', '?state=running',
    `/${run.id}?x=1`, `/${run.id}/events?afterSeq=-1`, `/${run.id}/events?limit=1.5`,
    `/${run.id}/wait?timeoutMs=30001`, `/${run.id}/wait?afterRevision=x`, '/%FF', '/%2E%2E%2Fprivate'])
    assert.equal((await route(v, suffix)).status, 400, suffix);
  assert.equal((await route(v, `/${run.id}`, { headers: { 'x-ragent-app-api-scope': undefined } })).status, 400);
  assert.equal((await route(v, `/${run.id}/cancel`, { method: 'GET' })).status, 405);
});
test('production legacy URL parsing preserves limits, state cursors and duplicate validation', async () => {
  const v = await seed(); const run = await makeRun(v); await makeRun(v);
  const response = await route(v, '?limit=1', { legacyUrl: true });
  assert.equal(response.status, 200); assert.equal(response.body.runs.length, 1); assert.ok(response.body.nextCursor);
  assert.equal((await route(v, '?limit=1&limit=2', { legacyUrl: true })).status, 400);
  assert.equal((await route(v, '', { path: '/api/run-api-contract?unsupported=true', legacyUrl: true })).status, 400);
  assert.equal((await route(v, `/${run.id}/wait?timeoutMs=0&afterRevision=invalid`, { legacyUrl: true })).status, 400);
});
test('scope moves and A to B to A reject reads and never retarget the resource', async () => {
  const v = await seed(); const run = await makeRun(v);
  await meta.mutateSessionMeta(v.sessionId, row => { row.projectId = 'p2'; return true; });
  assert.equal((await route(v, `/${run.id}`)).body.code, 'REVISION_CONFLICT');
  await meta.mutateSessionMeta(v.sessionId, row => { row.projectId = fixtureProject.id; return true; });
  assert.equal((await route(v, `/${run.id}`)).body.code, 'REVISION_CONFLICT');
});
test('scope reauthorization surrounds long IO without monopolizing the metadata actor', async () => {
  const v = await seed(); const entered = deferred(); const leave = deferred();
  const pending = api.scopedRunRead(v.sessionId, v.scope, async () => { entered.resolve(); await leave.promise; return 'private'; });
  await entered.promise;
  await meta.mutateSessionMeta(v.sessionId, row => { row.projectId = 'moved'; return true; });
  leave.resolve(); await assert.rejects(pending, { code: 'REVISION_CONFLICT' });
});
test('event pages attribute real records, hydrate selected messages and paginate filtered pages', async () => {
  const v = await seed(); const run = await makeRun(v); const other = await makeRun(v);
  for (let i = 0; i < 132; i++) await history.appendEvent(v.sessionId, messageEvent('assistant', 'UNRELATED_SECRET', null, { runId: other.id }));
  await history.appendEvent(v.sessionId, messageEvent('assistant', 'Exact reply🙂', null, { runId: run.id, providerThreadId: 'PRIVATE_PROVIDER' }));
  await history.appendEvent(v.sessionId, messageEvent('assistant', 'Unattributed secret', null, { requestId: run.requestId }));
  const first = await route(v, `/${run.id}/events`);
  assert.equal(first.status, 200); assert.equal(first.body.events.length, 0); assert.equal(first.body.scannedThrough, 128); assert.equal(first.body.hasMore, true);
  const next = await route(v, `/${run.id}/events?afterSeq=128&historyRevision=${first.body.historyRevision}`);
  assert.equal(next.status, 200); assert.equal(next.body.events.length, 1); assert.equal(next.body.events[0].text, 'Exact reply🙂');
  assert.equal(next.body.scannedThrough, 134); assert.equal(next.body.hasMore, false);
  assert.ok(!JSON.stringify(next.body).includes('SECRET')); assert.ok(!JSON.stringify(next.body).includes('PRIVATE_PROVIDER'));
  assert.equal((await route(v, `/${run.id}/events?afterSeq=128`)).status, 400);
  assert.equal((await route(v, `/${run.id}/events?afterSeq=128&historyRevision=999`)).body.code, 'CURSOR_STALE');
  assert.equal((await route(v, `/${run.id}/events?afterSeq=999&historyRevision=0`)).body.code, 'CURSOR_STALE');
});
test('event projection bounds UTF8, treats conflicts conservatively and never exposes nested inputs', () => {
  const result = contract.projectApiRunEvent({ seq: 1, runId: 'r', type: 'message', role: 'assistant',
    content: '🙂'.repeat(10000), timestamp: Date.now(), toolInput: { secret: 'PRIVATE' } }, 'r');
  assert.ok(Buffer.byteLength(result.text) <= 8192); assert.equal(result.textTruncated, true); assert.ok(!result.text.includes('\ufffd'));
  assert.equal(contract.projectApiRunEvent({ seq: 1, runId: 'other', resultRunId: 'r', content: 'PRIVATE' }, 'r'), null);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('event limits advance only through consumed records and history replacement invalidates continuation', async () => {
  const v = await seed(); const run = await makeRun(v);
  for (let i = 0; i < 3; i++) await history.appendEvent(v.sessionId, messageEvent('assistant', `text ${i}`, null, { runId: run.id }));
  const first = await route(v, `/${run.id}/events?limit=1`);
  assert.equal(first.body.scannedThrough, 1); assert.equal(first.body.events.length, 1);
  const second = await route(v, `/${run.id}/events?limit=1&afterSeq=1&historyRevision=${first.body.historyRevision}`);
  assert.equal(second.body.events[0].text, 'text 1'); assert.equal(second.body.scannedThrough, 2);
  const path = join(CHAT_HISTORY_DIR, v.sessionId, 'meta.json');
  const disk = JSON.parse(await readFile(path, 'utf8')); disk.historyRevision++;
  await writeFile(path, JSON.stringify(disk));
  assert.equal((await route(v, `/${run.id}/events?afterSeq=2&historyRevision=${first.body.historyRevision}`)).body.code, 'CURSOR_STALE');
});
test('readonly history observes committed boundary without publishing orphan tails', async () => {
  const v = await seed(); const run = await makeRun(v);
  await history.appendEvent(v.sessionId, messageEvent('assistant', 'Committed', null, { runId: run.id }));
  const directory = join(CHAT_HISTORY_DIR, v.sessionId); const path = join(directory, 'meta.json');
  const before = await readFile(path);
  const orphanPath = join(directory, 'events', '000000002.json');
  const orphan = JSON.stringify({ ...messageEvent('assistant', 'Orphan', null, { runId: run.id }), seq: 2 });
  await writeFile(orphanPath, orphan);
  const r = await route(v, `/${run.id}/events`); assert.equal(r.status, 200); assert.equal(r.body.latestSeq, 1);
  assert.deepEqual(await readFile(path), before);
  assert.equal(await readFile(orphanPath, 'utf8'), orphan);
  assert.deepEqual(r.body.events.map(event => event.text), ['Committed']);
});
test('malformed persisted history fails with sanitized error instead of returning empty success', async () => {
  const v = await seed(); const run = await makeRun(v, 'completed');
  await history.appendEvent(v.sessionId, messageEvent('assistant', 'Reply', null, { runId: run.id }));
  await writeFile(join(CHAT_HISTORY_DIR, v.sessionId, 'meta.json'), '{PRIVATE_PATH');
  for (const suffix of ['events', 'result']) {
    const r = await route(v, `/${run.id}/${suffix}`); assert.equal(r.status, 503); assert.equal(r.body.code, 'RUN_HISTORY_UNAVAILABLE');
    assert.ok(!JSON.stringify(r.body).includes('PRIVATE_PATH'));
  }
});
test('missing or unsafe committed history boundaries are corruption, not empty history', async () => {
  const v = await seed(); const run = await makeRun(v);
  await history.appendEvent(v.sessionId, messageEvent('assistant', 'Reply', null, { runId: run.id }));
  const path = join(CHAT_HISTORY_DIR, v.sessionId, 'meta.json');
  const original = JSON.parse(await readFile(path, 'utf8'));
  for (const boundary of [null, -1, Number.MAX_SAFE_INTEGER + 1]) {
    await writeFile(path, JSON.stringify({ ...original, latestSeq: boundary }));
    const r = await route(v, `/${run.id}/events`); assert.equal(r.status, 503); assert.equal(r.body.code, 'RUN_HISTORY_UNAVAILABLE');
  }
});
test('result projection keeps queued status and exact completed publication, excludes reused response IDs', async () => {
  const v = await seed(); const run = await makeRun(v, 'completed', { responseId: 'same-response' });
  const other = await makeRun(v, 'completed', { responseId: 'same-response' });
  await history.appendEvent(v.sessionId, messageEvent('assistant', 'Exact result', null, { runId: run.id, responseId: 'same-response' }));
  await history.appendEvent(v.sessionId, messageEvent('assistant', 'PRIVATE_OTHER', null, { runId: other.id, responseId: 'same-response' }));
  const r = await route(v, `/${run.id}/result`); assert.equal(r.status, 200); assert.equal(r.body.state, 'ready'); assert.equal(r.body.text, 'Exact result');
  assert.equal(r.body.finalRunId, run.id); assert.ok(!JSON.stringify(r.body).includes('PRIVATE_OTHER')); assert.equal(Object.hasOwn(r.body, 'requestId'), false);
  const queued = await makeRun(v, 'queued'); assert.equal((await route(v, `/${queued.id}/result`)).body.state, 'queued');
  const failed = await makeRun(v, 'failed'); assert.equal((await route(v, `/${failed.id}/result`)).body.state, 'failed');
});
test('result continuation must belong to the same root and Session', async () => {
  const v = await seed(); const rootRun = await makeRun(v, 'completed', { responseId: 'root-response' });
  const child = await makeRun(v, 'completed', { responseId: 'root-response', replyPublicationRootRunId: rootRun.id });
  await history.appendEvent(v.sessionId, messageEvent('assistant', 'Continuation result', null, { runId: child.id, responseId: 'root-response' }));
  await runs.updateRun(rootRun.id, { replyPublication: { state: 'ready', rootRunId: rootRun.id, finalRunId: child.id, continuationRunIds: [child.id] } });
  const r = await route(v, `/${rootRun.id}/result`); assert.equal(r.body.text, 'Continuation result'); assert.equal(r.body.finalRunId, child.id);
  const foreign = await makeRun(await seed(), 'completed');
  await runs.updateRun(rootRun.id, { replyPublication: { state: 'ready', rootRunId: rootRun.id, finalRunId: foreign.id, continuationRunIds: [foreign.id] } });
  const denied = await route(v, `/${rootRun.id}/result`); assert.equal(denied.body.state, 'checking'); assert.equal(denied.body.text, null);
});
test('wait returns changed, timed out and terminal observations without dispatch', async () => {
  const v = await seed(); const run = await makeRun(v);
  const first = await route(v, `/${run.id}/wait?timeoutMs=0`); assert.equal(first.body.changed, true);
  const revision = first.body.run.revision;
  const unchanged = await route(v, `/${run.id}/wait?afterRevision=${revision}&timeoutMs=1`); assert.equal(unchanged.body.timedOut, true);
  const changed = route(v, `/${run.id}/wait?afterRevision=${revision}&timeoutMs=2000`);
  await delay(30); await runs.updateRun(run.id, { state: 'completed' });
  const r = await changed; assert.equal(r.body.changed, true); assert.equal(r.body.run.terminal, true);
  const terminal = await route(v, `/${run.id}/wait?afterRevision=${r.body.run.revision}&timeoutMs=2000`);
  assert.equal(terminal.body.changed, false); assert.equal(terminal.body.timedOut, false);
});
test('wait abort releases capacity and waiting never blocks scope changes', async () => {
  const v = await seed(); const run = await makeRun(v); const revision = contract.projectApiRun(run).revision;
  const controller = new AbortController();
  const pending = api.waitApiRun(v.sessionId, run.id, v.scope, { afterRevision: revision, timeoutMs: 1000, signal: controller.signal });
  await delay(20); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  const waiting = route(v, `/${run.id}/wait?afterRevision=${revision}&timeoutMs=2000`);
  await delay(20); await meta.mutateSessionMeta(v.sessionId, row => { row.projectId = 'p2'; return true; });
  assert.equal((await waiting).body.code, 'REVISION_CONFLICT');
});
test('cancellation persists request without pretending live Run has terminated; retry observes terminal', async () => {
  const v = await seed(); const run = await makeRun(v); await active(v, run);
  const body = { version: 1, expiresAt: new Date(Date.now() + 10000).toISOString() };
  const r = await route(v, `/${run.id}/cancel`, { method: 'POST', body });
  assert.equal(r.status, 200); assert.equal(r.body.disposition, 'cancellation_requested');
  assert.equal(r.body.run.cancelRequested, true); assert.equal(r.body.run.terminal, false); assert.equal((await runs.getRunAcceptanceEvidence(run.id)).cancelRequested, true);
  await runs.updateRun(run.id, { state: 'cancelled', completedAt: new Date().toISOString() });
  const retry = await route(v, `/${run.id}/cancel`, { method: 'POST', body });
  assert.equal(retry.body.disposition, 'already_terminal'); assert.equal(retry.body.run.state, 'cancelled');
});
test('cancellation targets the specified Run without cancelling its successor', async () => {
  const v = await seed(); const original = await makeRun(v); const successor = await makeRun(v); await active(v, successor);
  const r = await route(v, `/${original.id}/cancel`, { method: 'POST', body: { version: 1, expiresAt: new Date(Date.now() + 10000).toISOString() } });
  assert.equal(r.status, 200); assert.equal(r.body.disposition, 'cancellation_requested');
  assert.equal((await runs.getRun(original.id)).cancelRequested, true); assert.equal((await runs.getRun(successor.id)).cancelRequested, false);
});
test('expired, oversize and unsupported cancellation bodies never create effects', async () => {
  const v = await seed(); const run = await makeRun(v); await active(v, run);
  const expired = { version: 1, expiresAt: new Date(Date.now() - 1).toISOString() };
  assert.equal((await route(v, `/${run.id}/cancel`, { method: 'POST', body: expired })).body.code, 'REQUEST_EXPIRED');
  for (const body of [{ ...expired, expiresAt: 'bad' }, { version: 2, expiresAt: new Date(Date.now() + 1000).toISOString() },
    { version: 1, expiresAt: new Date(Date.now() + 1000).toISOString(), caller: 'owner' }, { version: 1, expiresAt: new Date(Date.now() + 86410000).toISOString() }])
    assert.equal((await route(v, `/${run.id}/cancel`, { method: 'POST', body })).status, 400);
  assert.equal((await route(v, `/${run.id}/cancel`, { method: 'POST', raw: 'x'.repeat(5000) })).status, 413);
  assert.equal((await runs.getRun(run.id)).cancelRequested, false);
});
test('expiry after waiting for the metadata actor refuses cancellation', async () => {
  const v = await seed(); const run = await makeRun(v); await active(v, run);
  const entered = deferred(); const leave = deferred();
  const held = meta.withSessionApiScope(v.sessionId, v.scope, async () => { entered.resolve(); await leave.promise; });
  await entered.promise;
  const pending = api.cancelApiRun(v.sessionId, run.id, v.scope, { version: 1, expiresAt: new Date(Date.now() + 150).toISOString() });
  await delay(250); leave.resolve(); await held;
  await assert.rejects(pending, { code: 'REQUEST_EXPIRED' }); assert.equal((await runs.getRun(run.id)).cancelRequested, false);
});
test('scoped prepared queue cancellation terminalizes the exact durable Run without active Session ownership', async () => {
  const v = await seed();
  await meta.mutateSessionMeta(v.sessionId, row => { row.projectId = null; return true; });
  const current = await meta.readSessionApiContext(v.sessionId);
  v.scope = { ...v.scope, expectedProjectId: current.projectId, expectedScopeRevision: current.scopeRevision };
  const request = { version: 1, requestId: 'queue-cancel', text: 'Queued task', expiresAt: new Date(Date.now() + 30000).toISOString(), runOptions: {} };
  const prepared = await preparation.prepareSessionApiMessage(v.sessionId, v.scope, request);
  const receipt = await commit.commitSessionApiMessage(v.sessionId, v.scope, request.requestId, { version: 1, preparationId: prepared.preparationId }, 'owner');
  const r = await route(v, `/${receipt.runId}/cancel`, { method: 'POST', body: { version: 1, expiresAt: request.expiresAt } });
  assert.equal(r.status, 200); assert.equal(r.body.run.state, 'cancelled'); assert.equal(r.body.run.terminal, true);
});
test('fresh Run evidence refuses a forged manifest even after a permissive cache read', async () => {
  const v = await seed(); const run = await makeRun(v); await runs.getRun(run.id);
  const path = join(CHAT_RUNS_DIR, run.id, 'manifest.json');
  const stored = JSON.parse(await readFile(path, 'utf8')); stored.sessionId = 'another_session';
  await writeFile(path, JSON.stringify(stored));
  const r = await route(v, `/${run.id}`); assert.equal(r.status, 503); assert.equal(r.body.code, 'RUN_PUBLICATION_UNAVAILABLE');
});
test('bounded wait capacity rejects excess listeners and abort releases every slot', async () => {
  const v = await seed(); const run = await makeRun(v); const revision = contract.projectApiRun(run).revision;
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const calls = controllers.map(controller => api.waitApiRun(v.sessionId, run.id, v.scope,
    { afterRevision: revision, timeoutMs: 2000, signal: controller.signal }));
  await assert.rejects(api.waitApiRun(v.sessionId, run.id, v.scope, { afterRevision: revision, timeoutMs: 0 }), { code: 'RESOURCE_LIMIT' });
  controllers.forEach(controller => controller.abort());
  const outcomes = await Promise.allSettled(calls);
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason.name === 'AbortError'));
  const after = await api.waitApiRun(v.sessionId, run.id, v.scope, { afterRevision: revision, timeoutMs: 0 });
  assert.equal(after.timedOut, true);
});
test('deadline admission rejection inside a Run mutation leaves durable state unchanged', async () => {
  const v = await seed(); const run = await makeRun(v); const path = join(CHAT_RUNS_DIR, run.id, 'status.json');
  const before = await readFile(path);
  await assert.rejects(runs.requestRunCancel(run.id, { beforeWrite: () => contract.parseRunCancellation({ version: 1, expiresAt: new Date(Date.now() - 1).toISOString() }) }), { code: 'REQUEST_EXPIRED' });
  assert.deepEqual(await readFile(path), before);
  assert.equal((await runs.getRunAcceptanceEvidence(run.id)).cancelRequested, false);
});
test('Codex item/tool/requestUserInput validates multiSelect, isOther, emptySkip, secrets and 64KB body limit', async () => {
  const v = await seed();
  const questions = [
    { id: 'env', question: 'Target env?', multiSelect: true, isOther: false, options: [{ label: 'Staging' }, { label: 'Prod' }] },
    { id: 'notes', question: 'Optional notes' },
    { id: 'api_secret', question: 'Deploy secret', isSecret: true },
  ];
  const run = await makeRun(v, 'running', { runtimeFamily: 'codex-app-server-json' });
  await active(v, run);
  await runs.updateRun(run.id, {
    appServerPendingApprovals: [
      {
        approvalId: 'codex:ui-1',
        providerMethod: 'item/tool/requestUserInput',
        state: 'pending',
        kind: 'question',
        isBlocking: true,
        params: { isBlocking: true, questions },
      },
      {
        approvalId: 'codex:ui-nonblocking',
        providerMethod: 'item/tool/requestUserInput',
        state: 'pending',
        kind: 'question',
        isBlocking: false,
        params: { isBlocking: false, questions: [{ id: 'opt', question: 'Optional?', options: [{ label: 'A' }] }] },
      },
    ],
  });

  const blockingPath = `/api/runs/${run.id}/approvals/${encodeURIComponent('codex:ui-1')}`;
  const isOtherRejected = await route(v, '', {
    path: blockingPath,
    method: 'POST',
    body: { decision: 'approve_with_multi_choices', multiChoices: [[], [], []], customAnswers: ['CustomNotAllowed', 'ok', 'tok'] },
  });
  assert.equal(isOtherRejected.status, 400);
  assert.equal(isOtherRejected.body.code, 'INVALID_APPROVAL_CHOICES');

  const blockingSkipRejected = await route(v, '', {
    path: blockingPath,
    method: 'POST',
    body: { decision: 'approve', emptySkip: true },
  });
  assert.equal(blockingSkipRejected.status, 400);
  assert.equal(blockingSkipRejected.body.code, 'INVALID_APPROVAL_CHOICES');

  const bigNote = 'a'.repeat(24 * 1024);
  const largePayloadAccepted = await route(v, '', {
    path: blockingPath,
    method: 'POST',
    body: {
      decision: 'approve',
      requestId: 'codex-ui-big',
      answers: {
        env: ['Staging', 'Prod'],
        notes: [bigNote],
        api_secret: ['super-secret-token'],
      },
    },
  });
  assert.equal(largePayloadAccepted.status, 202, 'approval body >16KB and <=64KB must be accepted');
  assert.equal(largePayloadAccepted.body.approval?.redacted, true);
  assert.deepEqual(largePayloadAccepted.body.approval?.answers?.api_secret, { answers: ['[redacted]'] });
  assert.deepEqual(largePayloadAccepted.body.approval?.answers?.env, { answers: ['Staging', 'Prod'] });

  const overLimit = await route(v, '', {
    path: blockingPath,
    method: 'POST',
    raw: JSON.stringify({ decision: 'approve', customAnswer: 'z'.repeat(70 * 1024) }),
  });
  assert.equal(overLimit.status, 413, 'approval body >64KB must fail with 413');

  const nonBlockingPath = `/api/runs/${run.id}/approvals/${encodeURIComponent('codex:ui-nonblocking')}`;
  const emptySkipOk = await route(v, '', {
    path: nonBlockingPath,
    method: 'POST',
    body: { decision: 'approve', requestId: 'codex-ui-skip', emptySkip: true },
  });
  assert.equal(emptySkipOk.status, 202);
  const stored = await runs.getRun(run.id);
  const skipEntry = stored.appServerApprovalResponseQueue.find((e) => e.approvalId === 'codex:ui-nonblocking');
  assert.equal(skipEntry?.emptySkip, true);
  assert.deepEqual(skipEntry?.answers, {});

  await runs.updateRun(run.id, { state: 'cancelled' });
});

test('Track 3 mcpServer/elicitation/request validates form schema, protects secrets, and handles cancel & userVerification', async () => {
  const v = await seed();
  const run = await makeRun(v, 'running', { runtimeFamily: 'codex-app-server-json' });
  await active(v, run);
  await runs.updateRun(run.id, {
    appServerPendingApprovals: [
      {
        approvalId: 'codex:elicit-form',
        providerMethod: 'mcpServer/elicitation/request',
        state: 'pending',
        kind: 'permissions',
        params: {
          mode: 'openai/form',
          serverName: 'jira',
          requestedSchema: {
            type: 'object',
            required: ['summary', 'apiToken'],
            properties: {
              summary: { type: 'string' },
              apiToken: { type: 'string', format: 'password' },
              count: { type: 'integer' },
            },
          },
        },
      },
      {
        approvalId: 'codex:elicit-verify',
        providerMethod: 'mcpServer/elicitation/request',
        state: 'pending',
        kind: 'permissions',
        params: {
          mode: 'openai/userVerification',
          serverName: 'bank',
          title: 'Confirm wire',
        },
      },
    ],
  });

  const formPath = `/api/runs/${run.id}/approvals/${encodeURIComponent('codex:elicit-form')}`;
  const invalidType = await route(v, '', {
    path: formPath,
    method: 'POST',
    body: {
      decision: 'approve',
      elicitationResponse: { action: 'accept', content: { summary: 'Ok', apiToken: 'pw', count: 'nan' } },
    },
  });
  assert.equal(invalidType.status, 400);
  assert.equal(invalidType.body.code, 'INVALID_ELICITATION_CONTENT');

  const validForm = await route(v, '', {
    path: formPath,
    method: 'POST',
    body: {
      decision: 'approve',
      requestId: 'elicit-form-ok',
      elicitationResponse: {
        action: 'accept',
        content: { summary: 'Ship fix', apiToken: 'tok-999', count: 3, extraIgnored: 'drop' },
      },
    },
  });
  assert.equal(validForm.status, 202);
  assert.equal(validForm.body.approval?.redacted, true);
  assert.equal(validForm.body.approval?.elicitationContent?.apiToken, '[redacted]');
  assert.equal(validForm.body.approval?.elicitationContent?.summary, 'Ship fix');
  assert.equal(Object.hasOwn(validForm.body.approval?.elicitationContent || {}, 'extraIgnored'), false);

  const verifyPath = `/api/runs/${run.id}/approvals/${encodeURIComponent('codex:elicit-verify')}`;
  const rejectAcceptVerify = await route(v, '', {
    path: verifyPath,
    method: 'POST',
    body: { decision: 'approve', elicitationResponse: { action: 'accept', content: {} } },
  });
  assert.equal(rejectAcceptVerify.status, 400);
  assert.equal(rejectAcceptVerify.body.code, 'UNSUPPORTED_ELICITATION_MODE');

  const cancelVerify = await route(v, '', {
    path: verifyPath,
    method: 'POST',
    body: { decision: 'cancel', requestId: 'elicit-verify-cancel' },
  });
  assert.equal(cancelVerify.status, 202);
  assert.equal(cancelVerify.body.approval?.decision, 'cancel');

  await runs.updateRun(run.id, { state: 'cancelled' });
});

test('Track 2 POST /api/sessions/:id/messages accepts asyncQuestionReplies without text and steers active Codex run', async () => {
  const v = await seed();
  const run = await runs.createRun({
    status: {
      sessionId: v.sessionId,
      state: 'running',
      requestId: `steer_parent_${++sequence}`,
      tool: 'run-fixture',
      runtimeFamily: 'codex-app-server-json',
      providerCapabilities: { supportsSteer: true },
    },
    manifest: {
      sessionId: v.sessionId,
      tool: 'run-fixture',
      runtimeFamily: 'codex-app-server-json',
    },
  });
  await active(v, run);

  const sendMessageRoute = async (bodyObj) => {
    const path = `/api/sessions/${v.sessionId}/messages`;
    const url = new URL(path, 'http://localhost');
    const req = new PassThrough();
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json' };
    const res = new EventEmitter();
    res.headers = {};
    res.setHeader = (k, val) => { res.headers[k] = val; };
    const pending = handleSessionMainRoutes({
      req,
      res,
      parsedUrl: url,
      pathname: url.pathname,
      authSession: { role: 'owner', principalKind: 'trusted_device' },
      isDirectoryPath: async () => true,
      createSessionSummaryRef: () => null,
      isSessionVisibleToAuthSession: () => true,
      getAuthPrincipalId: () => 'owner',
      getAuthScopeAgentId: () => '',
      isAgentScopedAuthSession: () => false,
      resolveRequestedSessionAttachments: async () => [],
      requireSessionAccess: async () => true,
      readSessionMessagePayload: async () => { throw new Error('direct JSON reader expected'); },
      writeJson: (_res, status, body) => Object.assign(res, { status, body }),
    });
    req.end(JSON.stringify(bodyObj));
    assert.equal(await pending, true);
    return { status: res.status, body: res.body };
  };

  const rejectedEmpty = await sendMessageRoute({ requestId: 'async-empty', text: '', asyncQuestionReplies: [] });
  assert.equal(rejectedEmpty.status, 400);

  const qItemId = JSON.stringify(['request_user_input_async', 'msg-async-route', 0]);
  const steeredRes = await sendMessageRoute({
    requestId: 'async-steer-1',
    text: '',
    steerIfRunning: true,
    asyncQuestionReplies: [{ questionItemId: qItemId, question: 'Target runtime?', answer: 'Node 24' }],
  });
  assert.equal(steeredRes.status, 202);
  assert.equal(steeredRes.body.steered, true);
  assert.equal(steeredRes.body.queued, false);

  const storedRun = await runs.getRun(run.id);
  assert.equal(storedRun.appServerSteerQueue?.length, 1);
  assert.match(storedRun.appServerSteerQueue[0].text, /<send_user_message_question_reply>/);
  assert.match(storedRun.appServerSteerQueue[0].text, /Node 24/);

  const events = await history.loadHistory(v.sessionId);
  const userMsg = events.find((e) => e.type === 'message' && e.requestId === 'async-steer-1');
  assert.ok(userMsg, 'steered async reply writes user history event');
  assert.deepEqual(userMsg.answeredQuestionItemIds, [qItemId]);
  assert.equal(userMsg.asyncQuestionReplies?.[0]?.answer, 'Node 24');

  await runs.updateRun(run.id, { state: 'cancelled' });
});

test('large UTF8 result previews remain explicitly incomplete and bounded', async () => {
  const v = await seed(); const run = await makeRun(v, 'completed', { responseId: 'large-response' });
  await history.appendEvent(v.sessionId, messageEvent('assistant', '报告🙂'.repeat(20000), null, { runId: run.id, responseId: 'large-response' }));
  const r = await route(v, `/${run.id}/result`);
  assert.equal(r.status, 200); assert.equal(r.body.state, 'ready'); assert.equal(r.body.textTruncated, true);
  assert.ok(Buffer.byteLength(r.body.text) <= 48 * 1024); assert.ok(!r.body.text.includes('\ufffd'));
});
