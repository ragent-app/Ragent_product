import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = process.env.RAGENT_RECEIPT_TEST_ROOT || await mkdtemp(join(tmpdir(), 'ragent-receipt-api-'));
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
delete process.env.RAGENT_INSTANCE_ROOT;
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
const { createSessionWithOutcome, getMessageSubmissionReceipt } = await import('../chat/session-manager.mjs');
const { withSessionsMetaMutation } = await import('../chat/session-meta-store.mjs');
const { createRun } = await import('../chat/runs.mjs');
const { CHAT_RUNS_DIR, CONFIG_DIR } = await import('../lib/config.mjs');
assert.equal(resolve(CONFIG_DIR), resolve(join(root, 'config')));
assert.ok(resolve(CHAT_RUNS_DIR).startsWith(`${resolve(root)}\\`) || resolve(CHAT_RUNS_DIR).startsWith(`${resolve(root)}/`));

let accessChecks = 0;
async function lookup(sessionId, requestId, allowed = true) {
  const res = { status: 0, body: null, headers: {}, setHeader(key, value) { this.headers[key] = value; } };
  assert.equal(await handleSessionMainRoutes({ req: { method: 'GET' }, res,
    pathname: `/api/sessions/${encodeURIComponent(sessionId)}/message-receipts/${encodeURIComponent(requestId)}`,
    authSession: { role: allowed ? 'owner' : 'visitor' },
    requireSessionAccess: async (response, auth, id, options) => {
      assert.equal(options?.metadataOnly, true, 'Receipt authorization must avoid a mutating Session projection');
      accessChecks++;
      if (!allowed) { response.status = 403; response.body = { error: 'Denied' }; }
      return allowed;
    },
    writeJson: (response, status, body) => { response.status = status; response.body = body; },
  }), true);
  return res;
}

if (process.argv[2] === 'cold') {
  const cases = JSON.parse(process.env.RAGENT_RECEIPT_TEST_CASES);
  for (const [sessionId, requestId, state, queued, runId] of cases) {
    const result = await lookup(sessionId, requestId);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { receiptContractVersion: 1, sessionId, requestId, state, queued, runId });
  }
  console.log('Cold receipt lookup passed');
} else {
  try {
    const { session } = await createSessionWithOutcome(root, 'codex', 'Receipt lookup');
    const other = (await createSessionWithOutcome(root, 'codex', 'Other computer work')).session;
    await withSessionsMetaMutation(async (metas, save) => {
      const meta = metas.find((value) => value.id === session.id);
      meta.followUpQueue = [{ requestId: 'queued:id', text: 'Private input' }];
      meta.pendingPlanningQueue = [{ requestId: 'planning-id', text: 'Private planning input' }];
      meta.recentFollowUpRequestIds = ['consumed-id'];
      await save(metas, { immediate: true });
    });
    const run = await createRun({ status: { sessionId: session.id, requestId: 'run-id', state: 'completed', tool: 'codex' }, manifest: {} });
    const cases = [
      [session.id, 'queued:id', 'accepted', true, null],
      [session.id, 'planning-id', 'accepted', false, null],
      [session.id, 'consumed-id', 'accepted', false, null],
      [session.id, 'run-id', 'accepted', false, run.id],
      [session.id, 'never-retained', 'unconfirmed', false, null],
      [other.id, 'run-id', 'unconfirmed', false, null],
    ];
    const metadataBefore = await readFile(join(root, 'config', 'chat-sessions.json'), 'utf8');
    const runStatusPath = join(CHAT_RUNS_DIR, run.id, 'status.json');
    const runBefore = await readFile(runStatusPath, 'utf8');
    for (const [sessionId, requestId, state, queued, runId] of cases) {
      const response = await lookup(sessionId, requestId);
      assert.equal(response.status, 200);
      assert.equal(response.headers['Cache-Control'], 'private, no-store');
      assert.deepEqual(response.body, { receiptContractVersion: 1, sessionId, requestId, state, queued, runId });
      assert.ok(!JSON.stringify(response.body).includes('Private'));
    }
    assert.equal((await lookup(session.id, 'run-id', false)).status, 403);
    assert.equal((await lookup('missing-session', 'run-id')).status, 404);
    const checks = accessChecks;
    assert.equal((await lookup(session.id, 'x'.repeat(201))).status, 400);
    assert.equal(accessChecks, checks, 'Malformed input must not perform a resource lookup');
    await assert.rejects(getMessageSubmissionReceipt(session.id, ''), { statusCode: 400 });
    await promisify(execFile)(process.execPath, [import.meta.filename, 'cold'], {
      env: { ...process.env, RAGENT_RECEIPT_TEST_ROOT: root, RAGENT_RECEIPT_TEST_CASES: JSON.stringify(cases) },
    });
    assert.equal(await readFile(join(root, 'config', 'chat-sessions.json'), 'utf8'), metadataBefore);
    assert.equal(await readFile(runStatusPath, 'utf8'), runBefore);
    assert.equal((await readdir(CHAT_RUNS_DIR)).filter((id) => id === run.id).length, 1);
    console.log('Receipt route: authenticated read-only Run/queued/planning/recent evidence, missing evidence and cold recovery passed.');
  } finally {
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('ragent-receipt-api-'));
    await rm(root, { recursive: true, force: true });
  }
}
