#!/usr/bin/env node
// Execution-Scope slice 5: minimal workflow API contract (design §12).
//
// Exercises the real route handler with mock req/res (same pattern as
// test-project-migrate.mjs): requestId idempotency for checkpoint create,
// handoff create and accept; stable cursor pagination (no offset); atomic
// accept; writer-active checkpoint conflict; owner gating; §13 error codes +
// HTTP status mapping.
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-workflow-api-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const { handleProjectWorkflowRoutes } = await import('../chat/router-project-workflow-routes.mjs');
const { createProject } = await import('../chat/projects.mjs');
const { ensureWorkspaceForRoot } = await import('../chat/workspaces.mjs');
const { closeWorkspaceLeaseStore } = await import('../chat/workspace-leases.mjs');
const { executeMutation } = await import('../chat/mutation-coordinator.mjs');
const {
  createRun,
  writeRunResult,
  ensureRunDirectory,
} = await import('../chat/runs.mjs');
const {
  createProjectCheckpoint,
  closeResultPacketStore,
} = await import('../chat/result-packets.mjs');
const { closeProjectHandoffStore } = await import('../chat/project-handoffs.mjs');

let totalAssertions = 0;
let currentSection = null;
const sections = [];
function beginSection(name) {
  currentSection = { name, count: 0 };
}
function countAssertions(n = 1) {
  totalAssertions += n;
  if (currentSection) currentSection.count += n;
}
function eq(actual, expected, message) { countAssertions(); assert.equal(actual, expected, message); }
function ok(value, message) { countAssertions(); assert.ok(value, message); }
function deepEq(actual, expected, message) { countAssertions(); assert.deepEqual(actual, expected, message); }
function finishSection() {
  if (currentSection) sections.push(currentSection);
  currentSection = null;
}

const createdDirs = [];
function makeRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...headers };
    },
    end(body = '') {
      this.body = body;
    },
  };
}

function writeJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function makeBodyReq(body) {
  const chunk = Buffer.from(JSON.stringify(body));
  return {
    method: 'POST',
    headers: { host: 'a.ragent.test' },
    on(event, handler) {
      if (event === 'data') queueMicrotask(() => handler(chunk));
      if (event === 'end') queueMicrotask(() => handler());
      return this;
    },
    destroy() {},
  };
}

function makeGetReq() {
  return {
    method: 'GET',
    headers: { host: 'a.ragent.test' },
    on() { return this; },
    destroy() {},
  };
}

function readBody(req, maxBytes = 1048576) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolvePromise(body));
    req.on('error', reject);
  });
}

async function post(handlerArgs, pathname, body) {
  const res = makeRes();
  await handleProjectWorkflowRoutes({
    req: makeBodyReq(body),
    res,
    pathname,
    query: new URLSearchParams(),
    readBody,
    writeJson,
    ...handlerArgs,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function get(handlerArgs, pathname, queryString = '') {
  const res = makeRes();
  await handleProjectWorkflowRoutes({
    req: makeGetReq(),
    res,
    pathname,
    query: new URLSearchParams(queryString),
    readBody,
    writeJson,
    ...handlerArgs,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const owner = { role: 'owner' };
const nonOwner = { role: 'user' };

let runCounter = 0;
async function makeProject(name) {
  const root = makeRoot('ragent-api-root-');
  mkdirSync(root, { recursive: true });
  return createProject({ name, rootPath: root });
}

async function makeTerminalRun({ project, sessionId, state = 'completed', result = {} }) {
  runCounter += 1;
  const runId = `run_api_${runCounter}`;
  await ensureRunDirectory(runId);
  await createRun({
    status: {
      id: runId,
      sessionId,
      state,
      contextInputTokens: 900,
    },
    manifest: {
      sessionId,
      requestId: `req_${runId}`,
      projectId: project.id,
      executionScope: {
        projectId: project.id,
        sessionId,
        workspaceRevision: 1,
        git: { state: 'available', baseCommit: 'base_api', headCommit: 'head_api', dirty: false, partial: false },
      },
      executionScopeDigest: 'sha256:api-scope',
    },
  });
  await writeRunResult(runId, {
    summary: `api summary ${runId}`,
    tests: [{ name: 't1', status: 'passed', evidenceRef: 'ev:1' }],
    ...result,
  });
  return runId;
}

function makeSession(id, folder, projectId) {
  return { id, folder, projectId, templateId: 'app_api' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  // ── owner gating ────────────────────────────────────────────────────────
  beginSection('owner-gating');
  {
    const project = await makeProject('Owner Gate');
    const { status } = await post({ authSession: nonOwner },
      `/api/projects/${project.id}/checkpoints`,
      { requestId: 'x', runIds: [] });
    eq(status, 403, 'non-owner checkpoint create is refused');
  }
  finishSection();

  // ── checkpoint create: requestId idempotency + system fields ignored ────
  beginSection('checkpoint-create-idempotent');
  {
    const project = await makeProject('Checkpoint Create');
    const runId = await makeTerminalRun({ project, sessionId: 'sess_api_1' });
    const path = `/api/projects/${project.id}/checkpoints`;
    const first = await post({ authSession: owner }, path, {
      requestId: 'ckpt_api_1',
      runIds: [runId],
      // Client attempts to submit system fields; they must be ignored.
      state: 'failed',
      usage: { contextInputTokens: 999999 },
      git: { headCommit: 'forged' },
      executionScope: { accessMode: 'write' },
    });
    eq(first.status, 201, 'checkpoint create returns 201');
    eq(first.body.checkpoint.kind, 'project_checkpoint');
    eq(first.body.checkpoint.state, 'succeeded', 'system state wins over the client-submitted state');
    eq(first.body.checkpoint.usage.contextInputTokens, 900, 'usage comes from the Run record, not the payload');
    ok(first.body.checkpoint.packetId.startsWith('rsp_'), 'checkpoint packet uses rsp_');
    eq(first.body.checkpoint.producer.projectId, project.id);

    const replay = await post({ authSession: owner }, path, {
      requestId: 'ckpt_api_1',
      runIds: [runId],
    });
    eq(replay.status, 201, 'requestId replay still returns 201');
    deepEq(replay.body, first.body, 'requestId replay returns the identical checkpoint response');

    const missingKey = await post({ authSession: owner }, path, { runIds: [runId] });
    eq(missingKey.status, 400, 'checkpoint create without requestId is rejected');
    eq(missingKey.body.code, 'REQUEST_ID_REQUIRED');
  }
  finishSection();

  // ── active write mutation => checkpoint conflict (409 WORKSPACE_LEASE_CONFLICT)
  beginSection('checkpoint-writer-conflict');
  {
    const project = await makeProject('Writer Active');
    // Resolve the workspace of the PROJECT's own root so the mutation lease
    // carries the same workspaceId the checkpoint writer-gate filters on.
    const workspace = await ensureWorkspaceForRoot(project.rootPath);
    const runId = await makeTerminalRun({ project, sessionId: 'sess_other' });

    // Hold a short workspace-level WRITE mutation lease while the checkpoint
    // is attempted. The checkpoint writer-gate must see the active mutation
    // lease (matched by workspaceId) and refuse with 409.
    let releaseFirst;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    const mutation = executeMutation({
      workspaceId: workspace.id,
      resourceKeys: [`workspace:${workspace.physicalKey}`],
      mutate: async () => { await gate; return 'held'; },
    });
    await sleep(50); // let the mutation lease be acquired
    try {
      const { status, body } = await post({ authSession: owner },
        `/api/projects/${project.id}/checkpoints`,
        { requestId: 'ckpt_writer_conflict', runIds: [runId] });
      eq(status, 409, 'checkpoint while an active write mutation is pending returns 409');
      eq(body.code, 'WORKSPACE_LEASE_CONFLICT', 'writer-active conflict uses the frozen error code');
    } finally {
      releaseFirst();
      await mutation;
    }
  }
  finishSection();

  // ── non-terminal selected run => conflict ───────────────────────────────
  beginSection('checkpoint-nonterminal-run');
  {
    const project = await makeProject('Nonterminal Run');
    runCounter += 1;
    const runId = `run_api_running_${runCounter}`;
    await ensureRunDirectory(runId);
    await createRun({
      status: { id: runId, sessionId: 'sess_run', state: 'running' },
      manifest: { sessionId: 'sess_run', requestId: `req_${runId}`, projectId: project.id },
    });
    const { status, body } = await post({ authSession: owner },
      `/api/projects/${project.id}/checkpoints`,
      { requestId: 'ckpt_running', runIds: [runId] });
    eq(status, 409, 'a non-terminal selected run refuses the checkpoint');
    eq(body.code, 'WORKSPACE_LEASE_CONFLICT', 'non-terminal run surfaces WORKSPACE_LEASE_CONFLICT');
  }
  finishSection();

  // ── stable cursor pagination (createdAt DESC, packetId DESC, no offset) ─
  beginSection('checkpoint-cursor-pagination');
  {
    const project = await makeProject('Cursor Pages');
    const runA = await makeTerminalRun({ project, sessionId: 'sess_pa' });
    const runB = await makeTerminalRun({ project, sessionId: 'sess_pb' });
    const runC = await makeTerminalRun({ project, sessionId: 'sess_pc' });
    const a = await createProjectCheckpoint({ projectId: project.id, runIds: [runA], requestId: 'page_ck_a' });
    const b = await createProjectCheckpoint({ projectId: project.id, runIds: [runB], requestId: 'page_ck_b' });
    const c = await createProjectCheckpoint({ projectId: project.id, runIds: [runC], requestId: 'page_ck_c' });

    const page1 = await get({ authSession: owner },
      `/api/projects/${project.id}/checkpoints`, 'limit=2');
    eq(page1.status, 200);
    eq(page1.body.checkpoints.length, 2, 'first page honors limit=2');
    eq(page1.body.checkpoints[0].packetId, c.packetId, 'newest checkpoint first (createdAt DESC)');
    eq(page1.body.checkpoints[1].packetId, b.packetId, 'second newest checkpoint second');
    ok(typeof page1.body.nextCursor === 'string' && page1.body.nextCursor.length > 0, 'first page carries a next cursor');

    const page2 = await get({ authSession: owner },
      `/api/projects/${project.id}/checkpoints`, `limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
    eq(page2.status, 200);
    eq(page2.body.checkpoints.length, 1, 'second page returns the remaining checkpoint');
    eq(page2.body.checkpoints[0].packetId, a.packetId, 'cursor resumes at the oldest checkpoint');
    eq(page2.body.nextCursor, null, 'last page has no next cursor');

    const stable = await get({ authSession: owner },
      `/api/projects/${project.id}/checkpoints`, `limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
    deepEq(stable.body.checkpoints.map((entry) => entry.packetId),
      page2.body.checkpoints.map((entry) => entry.packetId),
      'cursor pagination is stable across repeated fetches');

    const defaultPage = await get({ authSession: owner }, `/api/projects/${project.id}/checkpoints`);
    eq(defaultPage.body.checkpoints.length, 3, 'default limit returns all three checkpoints');
  }
  finishSection();

  // ── handoff create (reference-only) + accept (atomic, idempotent) ───────
  beginSection('handoff-create-accept');
  {
    const project = await makeProject('Handoff API');
    const runId = await makeTerminalRun({ project, sessionId: 'sess_handoff', result: { decisions: ['go'] } });
    const checkpointRes = await post({ authSession: owner },
      `/api/projects/${project.id}/checkpoints`,
      { requestId: 'ckpt_handoff_api', runIds: [runId] });
    eq(checkpointRes.status, 201);
    const checkpointPacketId = checkpointRes.body.checkpoint.packetId;

    const createPath = `/api/projects/${project.id}/handoffs`;
    const created = await post({ authSession: owner }, createPath, {
      requestId: 'hof_api_1',
      checkpointPacketId,
      toProjectId: 'prj_implementation',
      // payload must not smuggle checkpoint content
      summary: 'forged content',
      decisions: ['forged'],
    });
    eq(created.status, 201, 'handoff create returns 201');
    eq(created.body.handoff.handoffId.startsWith('hof_'), true);
    eq(created.body.handoff.state, 'prepared');
    eq(created.body.handoff.checkpointPacketId, checkpointPacketId);
    eq(created.body.handoff.fromProjectId, project.id);
    ok(!('summary' in created.body.handoff), 'handoff response never copies packet content');
    ok(!('decisions' in created.body.handoff), 'client-submitted packet content is not stored');

    const replayCreate = await post({ authSession: owner }, createPath, {
      requestId: 'hof_api_1',
      checkpointPacketId,
      toProjectId: 'prj_implementation',
    });
    eq(replayCreate.status, 201);
    deepEq(replayCreate.body, created.body, 'handoff create replay returns the identical response');

    const acceptPath = `/api/project-handoffs/${created.body.handoff.handoffId}/accept`;
    const accepted = await post({ authSession: owner }, acceptPath, {
      requestId: 'acc_api_1',
      toProjectId: 'prj_implementation',
    });
    eq(accepted.status, 200, 'accept returns 200');
    eq(accepted.body.handoff.state, 'accepted');
    eq(accepted.body.handoff.toProjectId, 'prj_implementation', 'accept atomically binds toProjectId');
    ok(typeof accepted.body.handoff.acceptedAt === 'string', 'accept records acceptedAt');

    const replayAccept = await post({ authSession: owner }, acceptPath, {
      requestId: 'acc_api_1',
      toProjectId: 'prj_implementation',
    });
    deepEq(replayAccept.body, accepted.body, 'accept requestId replay returns the identical response');

    const acceptAgain = await post({ authSession: owner }, acceptPath, {
      requestId: 'acc_api_2',
      toProjectId: 'prj_implementation',
    });
    eq(acceptAgain.status, 200, 're-accepting an accepted handoff stays idempotent');
    deepEq(acceptAgain.body.handoff, accepted.body.handoff, 're-accept returns the same accepted handoff');

    const badCheckpoint = await post({ authSession: owner }, createPath, {
      requestId: 'hof_api_missing',
      checkpointPacketId: 'rsp_missing',
    });
    eq(badCheckpoint.status, 404, 'handoff with a missing checkpoint returns 404');
    eq(badCheckpoint.body.code, 'CHECKPOINT_NOT_FOUND');

    const missingHandoff = await post({ authSession: owner },
      '/api/project-handoffs/hof_missing/accept',
      { requestId: 'acc_missing', toProjectId: 'prj_x' });
    eq(missingHandoff.status, 404, 'accept of a missing handoff returns 404');
    eq(missingHandoff.body.code, 'HANDOFF_NOT_FOUND');
  }
  finishSection();

  // ── GET list + unknown project / method ─────────────────────────────────
  beginSection('list-and-errors');
  {
    const project = await makeProject('List API');
    const list = await get({ authSession: owner }, `/api/projects/${project.id}/checkpoints`);
    eq(list.status, 200, 'empty checkpoint list returns 200');
    deepEq(list.body.checkpoints, [], 'no checkpoints yet');

    const unknownProject = await get({ authSession: owner }, '/api/projects/prj_abcdef0123456789abcdef/checkpoints');
    eq(unknownProject.status, 404, 'unknown project returns 404');
    eq(unknownProject.body.code, 'PROJECT_NOT_FOUND');

    const badMethod = await get({ authSession: owner }, `/api/projects/${project.id}/handoffs`);
    eq(badMethod.status, 405, 'GET on handoffs create returns 405');

    const missingReqId = await post({ authSession: owner },
      `/api/projects/${project.id}/handoffs`,
      { checkpointPacketId: 'rsp_any' });
    eq(missingReqId.status, 400, 'handoff create without requestId is rejected');
    eq(missingReqId.body.code, 'REQUEST_ID_REQUIRED');
  }
  finishSection();
} finally {
  const summary = sections.map((section) => `${section.name}:${section.count}`).join(' ');
  console.log(`WORKFLOW_API_ASSERTIONS ${totalAssertions}`);
  console.log(`WORKFLOW_API_SECTIONS ${summary}`);
  await closeResultPacketStore().catch(() => {});
  await closeProjectHandoffStore().catch(() => {});
  await closeWorkspaceLeaseStore().catch(() => {});
  for (const dir of createdDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  rmSync(configDir, { recursive: true, force: true });
}
