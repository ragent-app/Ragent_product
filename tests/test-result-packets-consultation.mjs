#!/usr/bin/env node
// C4 consultation ResultPacket contract (docs/consultation-v1-implementation-plan
// §3 C4 / §8 P1-T3): `taskKind` (default 'execution', allows 'consultation') and
// a system-bound `consultation` block.
//
// Only `recommendation` is model-owned. Task ownership (taskId/attemptId), Run
// provenance (runId/sessionId), usage and scope are bound by the backend from
// the normalized producer / usage / provenance — a model payload that stuffs
// those into input.consultation is dropped on the floor. Missing / empty
// recommendation throws CONSULTATION_PACKET_INVALID (400). The result_packets
// table gains a task_kind column and execution packets stay the old default.
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-result-packets-consultation-'));
process.env.HOME = configDir;
process.env.RAGENT_CONFIG_DIR = configDir;

const {
  normalizeResultPacket,
  computeResultPacketDigest,
  createExecutionPacket,
  createProjectCheckpoint,
  getResultPacket,
  CONSULTATION_PACKET_INVALID,
  closeResultPacketStore,
} = await import('../chat/result-packets.mjs');
const {
  createRun,
  writeRunResult,
  ensureRunDirectory,
} = await import('../chat/runs.mjs');
const { createProject } = await import('../chat/projects.mjs');
const { closeWorkspaceLeaseStore } = await import('../chat/workspace-leases.mjs');

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
function rejects(promiseFactory, predicate, message) {
  countAssertions();
  return assert.rejects(promiseFactory, predicate, message);
}
function throws(fn, predicate, message) {
  countAssertions();
  assert.throws(fn, predicate, message);
}
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

const RUN_INDEX = { current: 0 };
function nextRunId(prefix) {
  RUN_INDEX.current += 1;
  return `${prefix}_${RUN_INDEX.current}`;
}

async function makeProject(name, root) {
  mkdirSync(root, { recursive: true });
  return createProject({ name, rootPath: root });
}

async function makeTerminalRun({ project, sessionId, runId, state = 'completed', result = {}, manifest = {} }) {
  await ensureRunDirectory(runId);
  await createRun({
    status: {
      id: runId,
      sessionId,
      state,
      contextInputTokens: 1200,
      contextWindowTokens: 64000,
      normalizedLineCount: 42,
    },
    manifest: {
      sessionId,
      requestId: `req_${runId}`,
      projectId: project.id,
      executionScope: {
        projectId: project.id,
        sessionId,
        workspaceRevision: 1,
        git: { state: 'available', baseCommit: 'base_abc', headCommit: 'head_abc', dirty: false, partial: false },
      },
      executionScopeDigest: 'sha256:test-scope',
      ...manifest,
    },
  });
  await writeRunResult(runId, { summary: `summary for ${runId}`, ...result });
  return runId;
}

const CONSULT_RECOMMENDATION = { action: 'approve', confidence: 0.8, notes: ['a', 'b'] };

try {
  // ── default execution packet: taskKind defaults, digest stable ───────────
  beginSection('default-execution');
  {
    const base = {
      kind: 'execution',
      state: 'succeeded',
      producer: { projectId: 'prj_1', runId: 'run_1', sessionId: 'sess_1' },
      summary: 'hello',
      tests: [{ name: 't1', status: 'passed', evidenceRef: 'ev:1' }],
      provenance: { executionScopeDigest: 'sha256:scope', sourceSessionIds: ['sess_1'], sourceRunIds: ['run_1'], inputPacketIds: [] },
      usage: { contextInputTokens: 100 },
    };
    const first = normalizeResultPacket({ ...base });
    const second = normalizeResultPacket({
      usage: { contextInputTokens: 100 },
      provenance: { inputPacketIds: [], sourceRunIds: ['run_1'], sourceSessionIds: ['sess_1'], executionScopeDigest: 'sha256:scope' },
      tests: [{ evidenceRef: 'ev:1', status: 'passed', name: 't1' }],
      summary: 'hello',
      producer: { sessionId: 'sess_1', runId: 'run_1', projectId: 'prj_1' },
      state: 'succeeded',
      kind: 'execution',
    });
    eq(first.taskKind, 'execution', 'taskKind defaults to execution when omitted');
    eq(first.kind, 'execution', 'kind stays execution');
    eq(first.digest, second.digest, 'digest is stable across object construction order');
    eq(computeResultPacketDigest(first), first.digest, 'digest recomputes to the embedded value');
    ok(!('consultation' in first), 'plain execution packet carries no consultation block');

    const fallback = normalizeResultPacket({ ...base, taskKind: 'bogus_kind' });
    eq(fallback.taskKind, 'execution', 'invalid taskKind falls back to execution');

    const execWithBlock = normalizeResultPacket({
      ...base,
      consultation: { recommendation: CONSULT_RECOMMENDATION, taskId: 'forged', runId: 'forged_run' },
    });
    ok(!('consultation' in execWithBlock), 'a consultation block is dropped for non-consultation packets');
  }
  finishSection();

  // ── consultation round-trip through the store ─────────────────────────────
  beginSection('consultation-round-trip');
  {
    const root = makeRoot('ragent-rpc-rt-root-');
    const project = await makeProject('RPC Round Trip', root);
    const runId = nextRunId('run_consult');
    await makeTerminalRun({
      project,
      sessionId: 'sess_consult',
      runId,
      result: { summary: 'consultation summary' },
    });
    const packet = await createExecutionPacket({
      runId,
      projectId: project.id,
      taskId: 'task_consult',
      attemptId: 'attempt_consult',
      sessionId: 'sess_consult',
      taskKind: 'consultation',
      consultation: { recommendation: CONSULT_RECOMMENDATION },
    });
    eq(packet.kind, 'execution', 'kind remains execution for a consultation packet');
    eq(packet.taskKind, 'consultation', 'taskKind is consultation');
    ok(packet.consultation && typeof packet.consultation === 'object', 'consultation block present');
    deepEq(packet.consultation.recommendation, CONSULT_RECOMMENDATION, 'recommendation round-trips');
    eq(packet.consultation.taskId, 'task_consult', 'taskId bound from the producer');
    eq(packet.consultation.attemptId, 'attempt_consult', 'attemptId bound from the producer');
    eq(packet.consultation.runId, runId, 'runId bound from the Run');
    eq(packet.consultation.sessionId, 'sess_consult', 'sessionId bound from the producer');
    eq(packet.consultation.usage.contextInputTokens, 1200, 'usage contextInputTokens bound from the backend run record');
    eq(packet.consultation.usage.normalizedLineCount, 42, 'usage normalizedLineCount bound from the backend run record');
    deepEq(packet.consultation.scope, { executionScopeDigest: 'sha256:test-scope' },
      'scope bound from provenance execution scope digest');
    ok(!('digest' in packet.consultation), 'digest is never embedded inside the consultation block');
    eq(computeResultPacketDigest(packet), packet.digest, 'top-level digest covers the consultation block');

    const read = await getResultPacket(packet.packetId);
    eq(read.taskKind, 'consultation', 'stored packet reads back taskKind consultation');
    deepEq(read.consultation.recommendation, CONSULT_RECOMMENDATION, 'stored recommendation survives');
    eq(read.consultation.runId, runId, 'stored runId survives');
  }
  finishSection();

  // ── array-shaped recommendation is valid ──────────────────────────────────
  beginSection('array-recommendation');
  {
    const root = makeRoot('ragent-rpc-arr-root-');
    const project = await makeProject('RPC Array', root);
    const runId = nextRunId('run_consult_arr');
    await makeTerminalRun({ project, sessionId: 'sess_arr', runId });
    const packet = await createExecutionPacket({
      runId,
      projectId: project.id,
      taskKind: 'consultation',
      consultation: { recommendation: [{ risk: 'r1', severity: 'high' }, { risk: 'r2', severity: 'low' }] },
    });
    deepEq(packet.consultation.recommendation, [{ risk: 'r1', severity: 'high' }, { risk: 'r2', severity: 'low' }],
      'array recommendation round-trips');
  }
  finishSection();

  // ── model cannot forge backend-bound fields ───────────────────────────────
  beginSection('forgery-rejection');
  {
    const root = makeRoot('ragent-rpc-forge-root-');
    const project = await makeProject('RPC Forge', root);
    const runId = nextRunId('run_forge');
    await makeTerminalRun({ project, sessionId: 'sess_forge', runId });
    const packet = await createExecutionPacket({
      runId,
      projectId: project.id,
      taskId: 'task_real',
      attemptId: 'attempt_real',
      sessionId: 'sess_real',
      taskKind: 'consultation',
      consultation: {
        recommendation: { action: 'approve' },
        // A model payload tries to claim ownership of every backend field.
        taskId: 'forged_task',
        attemptId: 'forged_attempt',
        runId: 'forged_run',
        sessionId: 'forged_session',
        usage: { contextInputTokens: 999999 },
        scope: { executionScopeDigest: 'forged_scope' },
        digest: 'forged_digest',
      },
    });
    eq(packet.consultation.taskId, 'task_real', 'forged taskId is overridden by the producer');
    eq(packet.consultation.attemptId, 'attempt_real', 'forged attemptId is overridden');
    eq(packet.consultation.runId, runId, 'forged runId is overridden by the Run');
    eq(packet.consultation.sessionId, 'sess_real', 'forged sessionId is overridden');
    eq(packet.consultation.usage.contextInputTokens, 1200, 'forged usage is overridden by the backend run record');
    ok(packet.consultation.scope.executionScopeDigest !== 'forged_scope', 'forged scope is overridden by provenance');
    eq(packet.consultation.scope.executionScopeDigest, 'sha256:test-scope', 'scope comes from provenance');
    ok(!('digest' in packet.consultation), 'forged digest inside the block is dropped');
    eq(computeResultPacketDigest(packet), packet.digest, 'packet digest still verifies after forgery rejection');
  }
  finishSection();

  // ── invalid: missing / empty recommendation ───────────────────────────────
  beginSection('invalid-consultation');
  {
    throws(
      () => normalizeResultPacket({ taskKind: 'consultation' }),
      (error) => error.code === CONSULTATION_PACKET_INVALID && error.statusCode === 400,
      'missing consultation block throws CONSULTATION_PACKET_INVALID (400)',
    );
    throws(
      () => normalizeResultPacket({ taskKind: 'consultation', consultation: {} }),
      (error) => error.code === CONSULTATION_PACKET_INVALID,
      'consultation block without recommendation throws',
    );
    throws(
      () => normalizeResultPacket({ taskKind: 'consultation', consultation: { recommendation: {} } }),
      (error) => error.code === CONSULTATION_PACKET_INVALID,
      'empty object recommendation throws',
    );
    throws(
      () => normalizeResultPacket({ taskKind: 'consultation', consultation: { recommendation: [] } }),
      (error) => error.code === CONSULTATION_PACKET_INVALID,
      'empty array recommendation throws',
    );
    throws(
      () => normalizeResultPacket({ taskKind: 'consultation', consultation: { recommendation: 'free text' } }),
      (error) => error.code === CONSULTATION_PACKET_INVALID,
      'non-structured string recommendation throws',
    );

    const root = makeRoot('ragent-rpc-inv-root-');
    const project = await makeProject('RPC Invalid', root);
    const runId = nextRunId('run_invalid');
    await makeTerminalRun({ project, sessionId: 'sess_invalid', runId });
    await rejects(
      () => createExecutionPacket({ runId, projectId: project.id, taskKind: 'consultation' }),
      (error) => error.code === CONSULTATION_PACKET_INVALID && error.statusCode === 400,
      'createExecutionPacket with a consultation taskKind but no recommendation is rejected',
    );
  }
  finishSection();

  // ── DB: task_kind column + persisted task_kind ────────────────────────────
  beginSection('db-task-kind-column');
  {
    const db = new DatabaseSync(join(configDir, 'project-workflow.db'));
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(result_packets)').all().map((c) => c.name));
      ok(columns.has('task_kind'), 'result_packets table has a task_kind column');
      const row = db.prepare('SELECT task_kind FROM result_packets WHERE packet_id = ?')
        .get('rsp_missing');
      eq(row, undefined, 'no row for a missing packet');
    } finally {
      db.close();
    }

    const root = makeRoot('ragent-rpc-db-root-');
    const project = await makeProject('RPC DB', root);
    const runId = nextRunId('run_db');
    await makeTerminalRun({ project, sessionId: 'sess_db', runId });
    const packet = await createExecutionPacket({
      runId,
      projectId: project.id,
      taskKind: 'consultation',
      consultation: { recommendation: CONSULT_RECOMMENDATION },
    });
    const db2 = new DatabaseSync(join(configDir, 'project-workflow.db'));
    try {
      const row = db2.prepare('SELECT task_kind FROM result_packets WHERE packet_id = ?').get(packet.packetId);
      eq(row.task_kind, 'consultation', 'consultation packet persisted with task_kind=consultation');
    } finally {
      db2.close();
    }
  }
  finishSection();

  // ── idempotency: same runId returns the existing packet ──────────────────
  beginSection('idempotency');
  {
    const root = makeRoot('ragent-rpc-idem-root-');
    const project = await makeProject('RPC Idempotent', root);
    const runId = nextRunId('run_idem');
    await makeTerminalRun({ project, sessionId: 'sess_idem', runId });
    const first = await createExecutionPacket({
      runId,
      projectId: project.id,
      taskId: 'task_idem',
      attemptId: 'attempt_idem',
      sessionId: 'sess_idem',
      taskKind: 'consultation',
      consultation: { recommendation: { action: 'approve' } },
    });
    const again = await createExecutionPacket({
      runId,
      projectId: project.id,
      taskId: 'task_idem',
      attemptId: 'attempt_idem',
      sessionId: 'sess_idem',
      taskKind: 'consultation',
      consultation: { recommendation: { action: 'approve' } },
    });
    eq(again.packetId, first.packetId, 'repeat createExecutionPacket for the same runId is idempotent');
    eq(again.taskKind, 'consultation', 'the replayed packet still carries consultation taskKind');
  }
  finishSection();

  // ── checkpoint aggregation path is unaffected ─────────────────────────────
  beginSection('checkpoint-unaffected');
  {
    const root = makeRoot('ragent-rpc-ckpt-root-');
    const project = await makeProject('RPC Checkpoint', root);
    const runA = nextRunId('run_ckpt_a');
    const runB = nextRunId('run_ckpt_b');
    await makeTerminalRun({ project, sessionId: 'sess_ck_a', runId: runA, result: { summary: 'phase A' } });
    await makeTerminalRun({ project, sessionId: 'sess_ck_b', runId: runB, result: { summary: 'phase B' } });
    await createExecutionPacket({
      runId: runA,
      projectId: project.id,
      taskKind: 'consultation',
      consultation: { recommendation: CONSULT_RECOMMENDATION },
    });
    const checkpoint = await createProjectCheckpoint({
      projectId: project.id,
      runIds: [runA, runB],
      requestId: 'ckpt_consult_req',
    });
    eq(checkpoint.kind, 'project_checkpoint', 'aggregation still uses the project_checkpoint kind');
    eq(checkpoint.taskKind, 'execution', 'checkpoint taskKind stays execution');
    ok(!('consultation' in checkpoint), 'checkpoint aggregation never carries a consultation block');
    eq(checkpoint.provenance.inputPacketIds.length, 2, 'both source packets are referenced');
    eq(checkpoint.usage.contextInputTokens, 2400, 'usage aggregation is unchanged');
  }
  finishSection();
} finally {
  const summary = sections.map((section) => `${section.name}:${section.count}`).join(' ');
  console.log(`RESULT_PACKETS_CONSULTATION_ASSERTIONS ${totalAssertions}`);
  console.log(`RESULT_PACKETS_CONSULTATION_SECTIONS ${summary}`);
  await closeResultPacketStore().catch(() => {});
  await closeWorkspaceLeaseStore().catch(() => {});
  for (const dir of createdDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  rmSync(configDir, { recursive: true, force: true });
}
