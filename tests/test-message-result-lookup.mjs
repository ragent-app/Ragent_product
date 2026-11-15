import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const root = process.env.RAGENT_RESULT_TEST_ROOT || await mkdtemp(join(tmpdir(), 'ragent-result-api-'));
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
delete process.env.RAGENT_INSTANCE_ROOT;
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
const { createSessionWithOutcome, getRetainedRunReplyPublication, getRetainedRunExportPublication,
  MAX_RETAINED_EXPORT_TEXT_BYTES } = await import('../chat/session-manager.mjs');
const { withSessionsMetaMutation } = await import('../chat/session-meta-store.mjs');
const { createRun, updateRun, getRun } = await import('../chat/runs.mjs');
const { appendEvent } = await import('../chat/history.mjs');
const { messageEvent } = await import('../chat/normalizer.mjs');
const { projectMessageResult, MESSAGE_RESULT_MAX_TEXT_BYTES } = await import('../chat/message-result-contract.mjs');
const { CHAT_RUNS_DIR, CONFIG_DIR } = await import('../lib/config.mjs');
assert.equal(resolve(CONFIG_DIR), resolve(join(root, 'config')));

let checks = 0;
async function lookup(sessionId, requestId, allowed = true) {
  const res = { status: 0, body: null, headers: {}, setHeader(key, value) { this.headers[key] = value; } };
  assert.equal(await handleSessionMainRoutes({ req: { method: 'GET' }, res,
    pathname: `/api/sessions/${encodeURIComponent(sessionId)}/message-results/${encodeURIComponent(requestId)}`,
    authSession: { role: allowed ? 'owner' : 'visitor' },
    requireSessionAccess: async (response, auth, id, options) => {
      checks++; assert.equal(id, sessionId); assert.equal(options?.metadataOnly, true);
      if (!allowed) { response.status = 403; response.body = { error: 'Denied' }; }
      return allowed;
    }, writeJson: (response, status, body) => { response.status = status; response.body = body; },
  }), true);
  return res;
}
if (process.argv[2] === 'cold') {
  const { sessionId, runId, exportRunId, exportHash } = JSON.parse(process.env.RAGENT_RESULT_TEST_CASE);
  const response = await lookup(sessionId, 'exact-request');
  assert.equal(response.body.runId, runId);
  assert.equal(response.body.text, 'Exact published result');
  const exported = await getRetainedRunExportPublication(await getRun(exportRunId));
  assert.equal(createHash('sha256').update(exported.payload.text).digest('hex'), exportHash);
  assert.equal(exported.payload.textIncomplete, false);
  console.log('Cold result route passed');
} else try {
  const { session } = await createSessionWithOutcome(root, 'codex', 'Synthetic result lookup');
  const other = (await createSessionWithOutcome(root, 'codex', 'Other work')).session;
  const run = await createRun({ status: { sessionId: session.id, requestId: 'exact-request', responseId: 'exact-request', state: 'completed' }, manifest: {} });
  await appendEvent(session.id, { ...messageEvent('user', 'Synthetic request'), runId: run.id, responseId: 'exact-request' });
  await appendEvent(session.id, { ...messageEvent('assistant', 'Exact published result'), runId: run.id, responseId: 'exact-request' });
  const later = await createRun({ status: { sessionId: session.id, requestId: 'later-request', state: 'completed' }, manifest: {} });
  await appendEvent(session.id, { ...messageEvent('assistant', 'Unrelated later reply'), runId: later.id });
  await appendEvent(session.id, { ...messageEvent('assistant', 'Unrelated reused response ID'), runId: later.id, responseId: 'exact-request' });
  const failed = await createRun({ status: { sessionId: session.id, requestId: 'failed-request', state: 'failed' }, manifest: {} });
  await appendEvent(session.id, { ...messageEvent('assistant', 'Partial output must not become final'), runId: failed.id });
  const cancelled = await createRun({ status: { sessionId: session.id, requestId: 'cancelled-request', state: 'cancelled' }, manifest: {} });
  const active = await createRun({ status: { sessionId: session.id, requestId: 'active-request', state: 'running' }, manifest: {} });
  const checking = await createRun({ status: { sessionId: session.id, requestId: 'checking-request', state: 'completed',
    replyPublication: { state: 'checking', rootRunId: 'unused' } }, manifest: {} });
  const repaired = await createRun({ status: { sessionId: session.id, requestId: 'repaired-request', responseId: 'repaired-request', state: 'completed' }, manifest: {} });
  const continuation = await createRun({ status: { sessionId: session.id, requestId: 'repair-child', responseId: 'repaired-request',
    replyPublicationRootRunId: repaired.id, state: 'completed' }, manifest: {} });
  await appendEvent(session.id, { ...messageEvent('assistant', 'Published continuation result'), runId: continuation.id, responseId: 'repaired-request' });
  await updateRun(repaired.id, value => ({ ...value, replyPublication: { state: 'ready', rootRunId: repaired.id,
    responseIds: ['repaired-request'], finalRunId: continuation.id, continuationRunIds: [continuation.id] } }));
  const forgedFinal = await createRun({ status: { sessionId: session.id, requestId: 'forged-final-request', state: 'completed',
    replyPublication: { state: 'ready', rootRunId: 'will-replace', finalRunId: later.id } }, manifest: {} });
  await updateRun(forgedFinal.id, value => ({ ...value, replyPublication: { ...value.replyPublication, rootRunId: forgedFinal.id } }));
  const largeText = '完整导出🙂\n'.repeat(400_000) + 'END';
  const exportRun = await createRun({ status: { sessionId: session.id, requestId: 'export-request',
    responseId: 'export-request', state: 'completed' }, manifest: {} });
  await appendEvent(session.id, { ...messageEvent('assistant', largeText), runId: exportRun.id, responseId: 'export-request' });
  const oversizeRun = await createRun({ status: { sessionId: session.id, requestId: 'oversize-export',
    responseId: 'oversize-export', state: 'completed' }, manifest: {} });
  await appendEvent(session.id, { ...messageEvent('assistant', 'x'.repeat(MAX_RETAINED_EXPORT_TEXT_BYTES + 1)),
    runId: oversizeRun.id, responseId: 'oversize-export' });
  await withSessionsMetaMutation(async (metas, save) => {
    metas.find(value => value.id === session.id).followUpQueue = [{ requestId: 'queued-request', text: 'Private queued input' }];
    await save(metas, { immediate: true });
  });
  const metadataPath = join(root, 'config', 'chat-sessions.json');
  const metadataBefore = await readFile(metadataPath, 'utf8');
  const paths = [run, later, failed, cancelled, active, checking, repaired, continuation, forgedFinal, exportRun, oversizeRun].map(value => join(CHAT_RUNS_DIR, value.id, 'status.json'));
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  const response = await lookup(session.id, 'exact-request');
  assert.equal(response.status, 200); assert.equal(response.headers['Cache-Control'], 'private, no-store');
  assert.equal(response.body.state, 'ready'); assert.equal(response.body.runId, run.id);
  assert.equal(response.body.text, 'Exact published result');
  assert.ok(!JSON.stringify(response.body).includes('Unrelated'));
  const repairedResult = (await lookup(session.id, 'repaired-request')).body;
  assert.equal(repairedResult.state, 'ready'); assert.equal(repairedResult.finalRunId, continuation.id);
  assert.equal(repairedResult.text, 'Published continuation result');
  assert.equal((await lookup(session.id, 'forged-final-request')).body.state, 'checking');
  assert.equal((await lookup(session.id, 'export-request')).body.textTruncated, true);
  assert.equal((await getRetainedRunReplyPublication(exportRun)).payload.textIncomplete, true);
  const completeExport = await getRetainedRunExportPublication(exportRun);
  assert.equal(completeExport.payload.text, largeText);
  assert.equal(completeExport.payload.textIncomplete, false);
  assert.equal((await getRetainedRunExportPublication(await getRun(repaired.id))).payload.text, 'Published continuation result');
  assert.equal((await getRetainedRunExportPublication(run)).payload.text, 'Exact published result');
  await assert.rejects(getRetainedRunExportPublication(failed), { code: 'RESULT_EXPORT_INCOMPLETE' });
  await assert.rejects(getRetainedRunExportPublication(active), { code: 'RESULT_EXPORT_INCOMPLETE' });
  await assert.rejects(getRetainedRunExportPublication(await getRun(forgedFinal.id)), { code: 'RESULT_EXPORT_INCOMPLETE' });
  await assert.rejects(getRetainedRunExportPublication(oversizeRun), { code: 'RESULT_EXPORT_TOO_LARGE', statusCode: 413 });
  for (const [request, state] of [['queued-request', 'queued'], ['absent', 'unconfirmed'], ['active-request', 'running'],
    ['failed-request', 'failed'], ['cancelled-request', 'cancelled'], ['checking-request', 'checking']]) {
    const value = (await lookup(session.id, request)).body;
    assert.equal(value.state, state); assert.equal(value.text, null); assert.equal(value.hasAttachments, false);
  }
  assert.equal((await lookup(other.id, 'exact-request')).body.state, 'unconfirmed');
  assert.equal((await lookup(session.id, 'exact-request', false)).status, 403);
  assert.equal((await lookup('missing', 'exact-request')).status, 404);
  const previous = checks;
  assert.equal((await lookup(session.id, 'x'.repeat(201))).status, 400); assert.equal(checks, previous);
  await promisify(execFile)(process.execPath, [import.meta.filename, 'cold'], {
    env: { ...process.env, RAGENT_RESULT_TEST_ROOT: root, RAGENT_RESULT_TEST_CASE: JSON.stringify({ sessionId: session.id, runId: run.id,
      exportRunId: exportRun.id, exportHash: createHash('sha256').update(largeText).digest('hex') }) },
  });
  assert.equal(await readFile(metadataPath, 'utf8'), metadataBefore);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), before, 'GET must not reconcile or change any Run');
  const receipt = { sessionId: 's', requestId: 'r', runId: 'run', state: 'accepted' };
  const boundRun = { id: 'run', sessionId: 's', requestId: 'r', state: 'completed' };
  const projected = projectMessageResult(receipt, boundRun, { ready: true, rootRunId: 'run', finalRunId: 'run',
    payload: { text: '中'.repeat(20_000), attachments: [{ assetId: 'fasset_' + 'a'.repeat(24), originalName: 'report.txt',
      mimeType: 'text/plain', sizeBytes: 42, downloadUrl: 'secret signed URL', savedPath: 'secret PC path' }] } });
  assert.equal(Buffer.byteLength(projected.text), MESSAGE_RESULT_MAX_TEXT_BYTES);
  assert.equal(projected.textTruncated, true); assert.equal(projected.hasAttachments, true);
  assert.ok(!projected.text.includes('\ufffd')); assert.ok(!JSON.stringify(projected).includes('secret'));
  assert.throws(() => projectMessageResult(receipt, { ...boundRun, requestId: 'other' }, null), { statusCode: 409 });
  assert.equal(projectMessageResult(receipt, boundRun, { ready: true, rootRunId: 'run',
    payload: { text: 'Short body preview', textIncomplete: true } }).textTruncated, true);
  console.log('Exact result route: request isolation, queued/live/failed/cancelled/checking, bounded UTF-8, authorization, cold read-only recovery passed');
  console.log('Export publication: complete UTF-8 body beyond preview budgets, continuation ownership, incomplete rejection, 25 MiB limit and cold digest passed');
} finally {
  assert.equal(resolve(dirname(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('ragent-result-api-'));
  await rm(root, { recursive: true, force: true });
}
