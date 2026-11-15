#!/usr/bin/env node
// Execution-Scope slice 5: canonical ResultPacket / ProjectCheckpoint /
// ProjectHandoff (design §8, §15 Packet/handoff matrix).
//
// Covers: stable canonical digest + no in-place mutation, system fields that a
// model payload cannot override, honest evidence (no evidence => no passed),
// checkpoint aggregation dedupe with preserved source refs, requestId
// idempotency, and handoff edges that never copy packet content.
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-result-packets-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const {
  createResultPacketId,
  normalizeResultPacket,
  computeResultPacketDigest,
  deriveExecutionPacketFromRun,
  createExecutionPacket,
  createProjectCheckpoint,
  getResultPacket,
  listProjectCheckpoints,
  closeResultPacketStore,
} = await import('../chat/result-packets.mjs');
const {
  createHandoff,
  acceptHandoff,
  getHandoff,
  buildHandoffProjection,
  closeProjectHandoffStore,
} = await import('../chat/project-handoffs.mjs');
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
  const status = {
    id: runId,
    sessionId,
    state,
    contextInputTokens: 1200,
    contextWindowTokens: 64000,
    normalizedLineCount: 42,
  };
  const baseManifest = {
    sessionId,
    requestId: `req_${runId}`,
    projectId: project.id,
    executionScope: {
      projectId: project.id,
      sessionId,
      workspaceRevision: 1,
      git: {
        state: 'available',
        baseCommit: 'base_abc',
        headCommit: 'head_abc',
        dirty: false,
        partial: false,
        trackedDiffHash: 'tdh_base',
      },
    },
    executionScopeDigest: 'sha256:test-scope',
    ...manifest,
  };
  await createRun({ status, manifest: baseManifest });
  await writeRunResult(runId, {
    summary: `summary for ${runId}`,
    ...result,
  });
  return runId;
}

try {
  // ── canonical digest stable + field-order independent ───────────────────
  beginSection('canonical-digest-stable');
  {
    const base = {
      kind: 'execution',
      state: 'succeeded',
      producer: { projectId: 'prj_1', runId: 'run_1', sessionId: 'sess_1' },
      summary: 'hello',
      changedFiles: [{ path: 'a.txt' }, { path: 'b.txt' }],
      tests: [{ name: 't1', status: 'passed', evidenceRef: 'ev:1' }],
      provenance: {
        executionScopeDigest: 'sha256:scope',
        sourceSessionIds: ['sess_1'],
        sourceRunIds: ['run_1'],
        inputPacketIds: [],
      },
      usage: { contextInputTokens: 100 },
    };
    const first = normalizeResultPacket({ ...base });
    const second = normalizeResultPacket({
      usage: { contextInputTokens: 100 },
      provenance: {
        inputPacketIds: [],
        sourceRunIds: ['run_1'],
        sourceSessionIds: ['sess_1'],
        executionScopeDigest: 'sha256:scope',
      },
      tests: [{ evidenceRef: 'ev:1', status: 'passed', name: 't1' }],
      changedFiles: [{ path: 'a.txt' }, { path: 'b.txt' }],
      summary: 'hello',
      producer: { sessionId: 'sess_1', runId: 'run_1', projectId: 'prj_1' },
      state: 'succeeded',
      kind: 'execution',
    });
    eq(first.packetId.startsWith('rsp_'), true, 'packetId uses the rsp_ prefix');
    eq(first.schemaVersion, 1, 'schemaVersion is 1');
    eq(first.digest, second.digest, 'digest is independent of object construction order');
    eq(computeResultPacketDigest(first), first.digest, 'digest recomputes to the embedded value');
    eq(first.state, 'succeeded');
    eq(first.producer.runId, 'run_1');
  }
  finishSection();

  // ── system fields cannot be overridden by a model payload ───────────────
  beginSection('system-field-protection');
  {
    const root = makeRoot('ragent-rp-sys-root-');
    const project = await makeProject('RP System', root);
    const runId = nextRunId('run_sys');
    await makeTerminalRun({
      project,
      sessionId: 'sess_sys',
      runId,
      state: 'failed',
      result: {
        // Model payload tries to claim a success, fake usage and fake git.
        state: 'succeeded',
        usage: { contextInputTokens: 999999 },
        git: { headCommit: 'forged_head' },
        summary: 'system must win',
      },
    });
    const packet = await deriveExecutionPacketFromRun({ runId, projectId: project.id });
    eq(packet.state, 'failed', 'packet state comes from the Run record, not the payload');
    eq(packet.usage.contextInputTokens, 1200, 'usage comes from the Run record, not the payload');
    eq(packet.producer.projectId, project.id);
    eq(packet.producer.runId, runId);
    eq(packet.provenance.resultRevision.headCommit, 'forged_head', 'resultRevision reflects result git provenance (server re-read)');
    eq(packet.provenance.executionScopeDigest, 'sha256:test-scope', 'scope ref comes from the manifest snapshot');
    ok(!packet.summary.includes('override'), 'model summary is kept as a model-owned field');
  }
  finishSection();

  // ── honest evidence: no evidence ref => never passed ────────────────────
  beginSection('evidence-honesty');
  {
    const root = makeRoot('ragent-rp-ev-root-');
    const project = await makeProject('RP Evidence', root);
    const runId = nextRunId('run_ev');
    await makeTerminalRun({
      project,
      sessionId: 'sess_ev',
      runId,
      result: {
        tests: [
          { name: 'no-evidence-passed', status: 'passed' },
          { name: 'no-evidence-failed', status: 'failed' },
          { name: 'with-evidence', status: 'passed', evidenceRef: 'ev:abc' },
          { name: 'not-run', status: 'not_run' },
        ],
        acceptanceResults: [
          { name: 'accept-no-evidence', status: 'passed' },
          { name: 'accept-with-evidence', status: 'passed', evidenceRef: 'ev:acc' },
        ],
      },
    });
    const packet = await deriveExecutionPacketFromRun({ runId, projectId: project.id });
    const byName = Object.fromEntries(packet.tests.map((entry) => [entry.name, entry]));
    eq(byName['no-evidence-passed'].status, 'unknown', 'passed without evidence is downgraded to unknown');
    eq(byName['no-evidence-failed'].status, 'not_run', 'a claim status without evidence is not_run');
    eq(byName['with-evidence'].status, 'passed', 'passed with an evidence ref is preserved');
    eq(byName['not-run'].status, 'not_run');
    eq(packet.acceptanceResults[0].status, 'unknown', 'acceptance passed without evidence is downgraded');
    eq(packet.acceptanceResults[1].status, 'passed', 'acceptance passed with evidence is preserved');
    eq(packet.acceptanceResults[1].evidenceRef, 'ev:acc');
  }
  finishSection();

  // ── immutability: no in-place mutation, corrections need a new packet ───
  beginSection('immutability');
  {
    const root = makeRoot('ragent-rp-imm-root-');
    const project = await makeProject('RP Immutable', root);
    const runId = nextRunId('run_imm');
    await makeTerminalRun({
      project,
      sessionId: 'sess_imm',
      runId,
      result: { tests: [{ name: 't', status: 'not_run' }] },
    });
    const stored = await createExecutionPacket({ runId, projectId: project.id });
    const read = await getResultPacket(stored.packetId);
    ok(read, 'packet is readable by packetId');
    read.tests.push({ name: 'tampered', status: 'passed' });
    read.summary = 'tampered';
    const reread = await getResultPacket(stored.packetId);
    eq(reread.tests.length, 1, 'mutating a read packet does not change the stored packet');
    eq(reread.summary, `summary for ${runId}`, 'stored summary is unchanged');
    eq(reread.digest, stored.digest, 'stored digest is unchanged');
    eq(computeResultPacketDigest(reread), reread.digest, 'stored packet digest still verifies');

    const again = await createExecutionPacket({ runId, projectId: project.id });
    eq(again.packetId, stored.packetId, 'execution packets are idempotent per runId');

    const correction = await deriveExecutionPacketFromRun({
      runId,
      projectId: project.id,
      supersedesPacketId: stored.packetId,
    });
    eq(correction.supersedesPacketId, stored.packetId, 'corrections reference the superseded packet');
  }
  finishSection();

  // ── checkpoint aggregation: dedupe + preserved source refs ──────────────
  beginSection('checkpoint-aggregation');
  {
    const root = makeRoot('ragent-rp-ckpt-root-');
    const project = await makeProject('RP Checkpoint', root);
    const runA = nextRunId('run_ck_a');
    const runB = nextRunId('run_ck_b');
    await makeTerminalRun({
      project,
      sessionId: 'sess_ck_a',
      runId: runA,
      result: {
        summary: 'phase A done',
        changedFiles: [{ path: 'a.txt' }, { path: 'b.txt' }],
        tests: [{ name: 't1', status: 'passed', evidenceRef: 'ev:1' }],
        decisions: ['decision one'],
        artifacts: [{ ref: 'art_1', name: 'a.txt' }],
      },
    });
    await makeTerminalRun({
      project,
      sessionId: 'sess_ck_b',
      runId: runB,
      result: {
        summary: 'phase B done',
        changedFiles: [{ path: 'b.txt' }, { path: 'c.txt' }],
        tests: [{ name: 't1', status: 'passed', evidenceRef: 'ev:1' }, { name: 't2', status: 'not_run' }],
        decisions: ['decision one', 'decision two'],
        artifacts: [{ ref: 'art_1', name: 'a.txt' }, { ref: 'art_2', name: 'c.txt' }],
      },
    });

    const checkpoint = await createProjectCheckpoint({
      projectId: project.id,
      runIds: [runA, runB],
      requestId: 'ckpt_req_1',
    });
    eq(checkpoint.kind, 'project_checkpoint', 'checkpoint is a project_checkpoint packet');
    eq(checkpoint.state, 'succeeded', 'all-succeeded source packets aggregate to succeeded');
    eq(checkpoint.producer.projectId, project.id);
    eq(checkpoint.provenance.inputPacketIds.length, 2, 'both execution packets are referenced');
    deepEq(checkpoint.provenance.sourceRunIds.sort(), [runA, runB].sort(), 'sourceRunIds preserved and deduped');
    deepEq(checkpoint.provenance.sourceSessionIds.sort(), ['sess_ck_a', 'sess_ck_b'].sort(), 'sourceSessionIds preserved and deduped');
    eq(checkpoint.changedFiles.length, 3, 'changedFiles aggregated and deduped');
    eq(checkpoint.tests.length, 2, 'tests aggregated and deduped');
    eq(checkpoint.decisions.length, 2, 'decisions aggregated and deduped');
    eq(checkpoint.artifacts.length, 2, 'artifacts aggregated and deduped');
    ok(checkpoint.summary.includes('phase A done') && checkpoint.summary.includes('phase B done'),
      'summary is a bounded aggregate of source summaries');
    eq(checkpoint.usage.contextInputTokens, 2400, 'usage is aggregated from run records');
    eq(checkpoint.provenance.baseRevision.baseCommit, 'base_abc', 'baseline revision is frozen from the first packet');
    eq(checkpoint.provenance.resultRevision.headCommit, 'head_abc', 'result revision comes from the latest packet');

    const replay = await createProjectCheckpoint({
      projectId: project.id,
      runIds: [runA, runB],
      requestId: 'ckpt_req_1',
    });
    eq(replay.packetId, checkpoint.packetId, 'requestId replay returns the identical checkpoint');

    const second = await createProjectCheckpoint({
      projectId: project.id,
      runIds: [runA, runB],
      requestId: 'ckpt_req_2',
    });
    ok(second.packetId !== checkpoint.packetId, 'a new requestId creates a new checkpoint snapshot');
    eq(second.provenance.inputPacketIds.length, 2, 'execution packets are reused, not duplicated');
    eq(second.provenance.baseRevision.baseCommit, 'base_abc', 'second checkpoint baselines against the first checkpoint resultRevision path');

    const { checkpoints, nextCursor } = await listProjectCheckpoints(project.id, { limit: 1 });
    eq(checkpoints.length, 1, 'checkpoint list is paginated');
    ok(typeof nextCursor === 'string' && nextCursor.length > 0, 'cursor pagination returns a next cursor');
  }
  finishSection();

  // ── handoff: reference-only edge, bounded projection, atomic accept ─────
  beginSection('handoff-edge');
  {
    const root = makeRoot('ragent-rp-hof-root-');
    const fromProject = await makeProject('RP From', root);
    const runId = nextRunId('run_hof');
    await makeTerminalRun({
      project: fromProject,
      sessionId: 'sess_hof',
      runId,
      result: {
        summary: 'handoff summary',
        decisions: ['keep it simple'],
        risks: ['risk x'],
        acceptanceResults: [{ name: 'acc', status: 'passed', evidenceRef: 'ev:acc1' }],
        artifacts: [{ ref: 'art_hof', name: 'plan.txt' }],
        changedFiles: [{ path: 'secret.txt' }],
      },
    });
    const checkpoint = await createProjectCheckpoint({
      projectId: fromProject.id,
      runIds: [runId],
      requestId: 'ckpt_hof',
    });

    const handoff = await createHandoff({
      fromProjectId: fromProject.id,
      toProjectId: 'prj_implementation',
      checkpointPacketId: checkpoint.packetId,
      requestId: 'hof_req_1',
    });
    eq(handoff.handoffId.startsWith('hof_'), true, 'handoffId uses the hof_ prefix');
    eq(handoff.state, 'prepared');
    eq(handoff.checkpointPacketId, checkpoint.packetId);
    eq(handoff.toProjectId, 'prj_implementation');
    ok(handoff.workspaceId.startsWith('ws_'), 'handoff carries the workspace reference');
    ok(!('summary' in handoff) && !('decisions' in handoff) && !('changedFiles' in handoff),
      'the handoff edge never copies packet content');

    const replayHandoff = await createHandoff({
      fromProjectId: fromProject.id,
      toProjectId: 'prj_implementation',
      checkpointPacketId: checkpoint.packetId,
      requestId: 'hof_req_1',
    });
    eq(replayHandoff.handoffId, handoff.handoffId, 'handoff create is requestId idempotent');

    const readEdge = await getHandoff(handoff.handoffId);
    deepEq(readEdge, handoff, 'stored handoff matches the created edge');

    const projection = await buildHandoffProjection(handoff.handoffId);
    eq(projection.packet.packetId, checkpoint.packetId, 'projection references the checkpoint packet');
    ok(projection.packet.summary.includes('handoff summary'), 'projection injects a bounded summary');
    deepEq(projection.packet.decisions, ['keep it simple']);
    deepEq(projection.packet.risks, ['risk x']);
    eq(projection.packet.acceptanceResults.length, 1, 'projection injects bounded acceptance');
    ok(projection.packet.evidenceRefs.includes('ev:acc1'), 'projection includes evidence refs');
    ok(projection.packet.artifacts.includes('art_hof'), 'projection includes artifact refs');
    ok(!('changedFiles' in projection.packet), 'projection never injects the full packet payload');
    ok(!('sourceRunIds' in projection.packet), 'projection never injects provenance internals');
    ok(!('usage' in projection.packet), 'projection never injects usage internals');
    deepEq(projection.workspace, { workspaceId: handoff.workspaceId }, 'projection carries the workspace reference');

    const accepted = await acceptHandoff({
      handoffId: handoff.handoffId,
      toProjectId: 'prj_implementation',
      requestId: 'hof_acc_req_1',
    });
    eq(accepted.state, 'accepted', 'accept binds the handoff atomically');
    eq(accepted.toProjectId, 'prj_implementation');
    ok(typeof accepted.acceptedAt === 'string' && accepted.acceptedAt.length > 0, 'acceptance records acceptedAt');

    const acceptedReplay = await acceptHandoff({
      handoffId: handoff.handoffId,
      toProjectId: 'prj_implementation',
      requestId: 'hof_acc_req_1',
    });
    deepEq(acceptedReplay, accepted, 'accept replay returns the identical result');

    const acceptedAgain = await acceptHandoff({
      handoffId: handoff.handoffId,
      toProjectId: 'prj_implementation',
    });
    deepEq(acceptedAgain, accepted, 'accepting an already-accepted handoff is idempotent');

    await rejects(
      () => createHandoff({
        fromProjectId: fromProject.id,
        checkpointPacketId: 'rsp_does_not_exist',
        requestId: 'hof_req_missing',
      }),
      (error) => error.code === 'CHECKPOINT_NOT_FOUND' && error.statusCode === 404,
      'a missing checkpoint packet refuses the handoff',
    );
    const executionOnly = await createExecutionPacket({ runId, projectId: fromProject.id });
    await rejects(
      () => createHandoff({
        fromProjectId: fromProject.id,
        checkpointPacketId: executionOnly.packetId,
        requestId: 'hof_req_exec',
      }),
      (error) => error.code === 'HANDOFF_INVALID_CHECKPOINT',
      'a handoff must reference a project_checkpoint packet, not an execution packet',
    );
  }
  finishSection();
} finally {
  const summary = sections.map((section) => `${section.name}:${section.count}`).join(' ');
  console.log(`RESULT_PACKETS_ASSERTIONS ${totalAssertions}`);
  console.log(`RESULT_PACKETS_SECTIONS ${summary}`);
  await closeResultPacketStore().catch(() => {});
  await closeProjectHandoffStore().catch(() => {});
  await closeWorkspaceLeaseStore().catch(() => {});
  for (const dir of createdDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  rmSync(configDir, { recursive: true, force: true });
}
