#!/usr/bin/env node
// S13 ResultPacket v2 additive contract (constitution §7):
// organizationId / nodeId / revision / phaseId / acceptanceResults /
// evidenceRefs / parentPacketIds. The v2 fields round-trip through the
// canonical shape and digest, remain server-derived (a model payload inside the
// Run result can never override them), and every S5 semantic (honest evidence,
// immutability, checkpoint aggregation, system-field protection) is unchanged.
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-result-packets-v2-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const {
  createResultPacketId,
  normalizeResultPacket,
  computeResultPacketDigest,
  deriveExecutionPacketFromRun,
  createExecutionPacket,
  createProjectCheckpoint,
  getResultPacket,
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

async function makeTerminalRun({ project, sessionId, runId, state = 'completed', result = {} }) {
  await ensureRunDirectory(runId);
  await createRun({
    status: {
      id: runId,
      sessionId,
      state,
      contextInputTokens: 900,
      contextWindowTokens: 64000,
      normalizedLineCount: 21,
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
      executionScopeDigest: 'sha256:test-scope-v2',
    },
  });
  await writeRunResult(runId, { summary: `summary for ${runId}`, ...result });
  return runId;
}

try {
  // ── v2 fields round-trip + digest stability ─────────────────────────────
  beginSection('v2-round-trip');
  {
    const base = {
      kind: 'execution',
      state: 'succeeded',
      producer: { projectId: 'prj_1', runId: 'run_1', sessionId: 'sess_1' },
      summary: 'hello',
      organizationId: 'org_1',
      nodeId: 'node_1',
      revision: 3,
      phaseId: 'phase-2',
      tests: [{ name: 't1', status: 'passed', evidenceRef: 'ev:1' }],
      acceptanceResults: [{ name: 'acc', status: 'passed', evidenceRef: 'ev:acc' }],
      evidenceRefs: ['ev:manual'],
      parentPacketIds: ['rsp_old_1', 'rsp_old_2'],
      provenance: { executionScopeDigest: 'sha256:scope', sourceSessionIds: ['sess_1'], sourceRunIds: ['run_1'], inputPacketIds: [] },
      usage: { contextInputTokens: 100 },
    };
    const first = normalizeResultPacket({ ...base });
    const second = normalizeResultPacket({
      usage: { contextInputTokens: 100 },
      provenance: { inputPacketIds: [], sourceRunIds: ['run_1'], sourceSessionIds: ['sess_1'], executionScopeDigest: 'sha256:scope' },
      tests: [{ evidenceRef: 'ev:1', status: 'passed', name: 't1' }],
      acceptanceResults: [{ name: 'acc', status: 'passed', evidenceRef: 'ev:acc' }],
      evidenceRefs: ['ev:manual'],
      parentPacketIds: ['rsp_old_2', 'rsp_old_1'],
      summary: 'hello',
      producer: { sessionId: 'sess_1', runId: 'run_1', projectId: 'prj_1' },
      revision: 3,
      phaseId: 'phase-2',
      nodeId: 'node_1',
      organizationId: 'org_1',
      state: 'succeeded',
      kind: 'execution',
    });
    eq(first.organizationId, 'org_1', 'organizationId round-trips');
    eq(first.nodeId, 'node_1', 'nodeId round-trips');
    eq(first.revision, 3, 'revision round-trips');
    eq(first.phaseId, 'phase-2', 'phaseId round-trips');
    deepEq(first.parentPacketIds, ['rsp_old_1', 'rsp_old_2'], 'parentPacketIds round-trips deduplicated');
    ok(first.evidenceRefs.includes('ev:1'), 'evidenceRefs projects test evidence');
    ok(first.evidenceRefs.includes('ev:acc'), 'evidenceRefs projects acceptance evidence');
    ok(first.evidenceRefs.includes('ev:manual'), 'evidenceRefs merges explicit refs');
    eq(first.digest, second.digest, 'v2 fields are digest-stable across object construction order');
    eq(computeResultPacketDigest(first), first.digest, 'digest recomputes to the embedded value');
    ok(!('revision' in normalizeResultPacket({ kind: 'execution', summary: 'no revision' })), 'absent v2 fields stay absent');
  }
  finishSection();

  // ── server derivation carries explicit v2 options ───────────────────────
  beginSection('v2-derive-options');
  {
    const root = makeRoot('ragent-rp-v2-root-');
    const project = await makeProject('RP V2', root);
    const runId = nextRunId('run_v2');
    await makeTerminalRun({
      project,
      sessionId: 'sess_v2',
      runId,
      result: {
        tests: [{ name: 't', status: 'passed', evidenceRef: 'ev:t' }],
        acceptanceResults: [{ name: 'acc', status: 'passed', evidenceRef: 'ev:acc' }],
      },
    });
    const packet = await deriveExecutionPacketFromRun({
      runId,
      projectId: project.id,
      organizationId: 'org_v2',
      nodeId: 'node_v2',
      revision: 4,
      phaseId: 'phase-3',
      parentPacketIds: ['rsp_parent'],
    });
    eq(packet.organizationId, 'org_v2', 'derive carries organizationId');
    eq(packet.nodeId, 'node_v2', 'derive carries nodeId');
    eq(packet.revision, 4, 'derive carries revision');
    eq(packet.phaseId, 'phase-3', 'derive carries phaseId');
    deepEq(packet.parentPacketIds, ['rsp_parent'], 'derive carries parentPacketIds');
    deepEq(packet.evidenceRefs, ['ev:acc', 'ev:t'], 'derive projects evidence refs from canonical tests/acceptance');
    eq(packet.state, 'succeeded', 'run state still derives from the Run record');
  }
  finishSection();

  // ── system-field protection: a model payload cannot set v2 fields ────────
  beginSection('v2-system-field-protection');
  {
    const root = makeRoot('ragent-rp-v2-sys-root-');
    const project = await makeProject('RP V2 Sys', root);
    const runId = nextRunId('run_v2_sys');
    await makeTerminalRun({
      project,
      sessionId: 'sess_v2_sys',
      runId,
      result: {
        // Model payload tries to claim an org identity, a revision, a parent
        // chain and a fake evidence ref. The server derive path ignores all of
        // them — only explicit caller options count.
        organizationId: 'forged_org',
        nodeId: 'forged_node',
        revision: 99,
        phaseId: 'forged_phase',
        parentPacketIds: ['forged_parent'],
        evidenceRefs: ['forged_ev'],
        tests: [{ name: 't', status: 'passed', evidenceRef: 'ev:real' }],
      },
    });
    const packet = await deriveExecutionPacketFromRun({ runId, projectId: project.id });
    ok(!('organizationId' in packet), 'forged organizationId is rejected');
    ok(!('nodeId' in packet), 'forged nodeId is rejected');
    ok(!('revision' in packet), 'forged revision is rejected');
    ok(!('phaseId' in packet), 'forged phaseId is rejected');
    ok(!('parentPacketIds' in packet), 'forged parentPacketIds is rejected');
    deepEq(packet.evidenceRefs, ['ev:real'], 'evidenceRefs derives only from canonical test evidence, never the forged ref');
    eq(packet.producer.runId, runId, 'producer context still derives from the Run');
  }
  finishSection();

  // ── checkpoint aggregation carries v2 context + parent packet chain ──────
  beginSection('v2-checkpoint-aggregation');
  {
    const root = makeRoot('ragent-rp-v2-ckpt-root-');
    const project = await makeProject('RP V2 Ckpt', root);
    const runA = nextRunId('run_v2_ck_a');
    const runB = nextRunId('run_v2_ck_b');
    await makeTerminalRun({
      project,
      sessionId: 'sess_v2_ck_a',
      runId: runA,
      result: { summary: 'phase A done', tests: [{ name: 't1', status: 'passed', evidenceRef: 'ev:1' }] },
    });
    await makeTerminalRun({
      project,
      sessionId: 'sess_v2_ck_b',
      runId: runB,
      result: { summary: 'phase B done', tests: [{ name: 't2', status: 'passed', evidenceRef: 'ev:2' }] },
    });
    const checkpoint = await createProjectCheckpoint({
      projectId: project.id,
      runIds: [runA, runB],
      requestId: 'ckpt_v2_req',
      organizationId: 'org_ck',
      nodeId: 'node_ck',
      revision: 2,
      phaseId: 'phase-ck',
    });
    eq(checkpoint.kind, 'project_checkpoint', 'aggregation still uses the project_checkpoint kind');
    eq(checkpoint.organizationId, 'org_ck', 'checkpoint carries organizationId');
    eq(checkpoint.nodeId, 'node_ck', 'checkpoint carries nodeId');
    eq(checkpoint.revision, 2, 'checkpoint carries revision');
    eq(checkpoint.phaseId, 'phase-ck', 'checkpoint carries phaseId');
    eq(checkpoint.provenance.inputPacketIds.length, 2, 'source packets are referenced via provenance');
    ok(checkpoint.parentPacketIds.length === 2 && checkpoint.parentPacketIds.includes(checkpoint.provenance.inputPacketIds[0]),
      'checkpoint parentPacketIds chains the source execution packets');
    ok(checkpoint.evidenceRefs.includes('ev:1') && checkpoint.evidenceRefs.includes('ev:2'), 'checkpoint projects aggregate evidence refs');
    eq(checkpoint.usage.contextInputTokens, 1800, 'usage aggregation is unchanged');
  }
  finishSection();

  // ── immutability + honest evidence remain untouched ──────────────────────
  beginSection('v2-s5-semantics-unchanged');
  {
    const root = makeRoot('ragent-rp-v2-imm-root-');
    const project = await makeProject('RP V2 Imm', root);
    const runId = nextRunId('run_v2_imm');
    await makeTerminalRun({
      project,
      sessionId: 'sess_v2_imm',
      runId,
      result: {
        tests: [{ name: 'no-evidence-passed', status: 'passed' }, { name: 'with-evidence', status: 'passed', evidenceRef: 'ev:x' }],
      },
    });
    const stored = await createExecutionPacket({ runId, projectId: project.id });
    const read = await getResultPacket(stored.packetId);
    read.tests.push({ name: 'tampered', status: 'passed' });
    const reread = await getResultPacket(stored.packetId);
    eq(reread.tests.length, 2, 'packets stay immutable after a read mutation');
    eq(computeResultPacketDigest(reread), reread.digest, 'stored digest still verifies');
    const byName = Object.fromEntries(reread.tests.map((entry) => [entry.name, entry]));
    eq(byName['no-evidence-passed'].status, 'unknown', 'passed without evidence is still downgraded');
    eq(byName['with-evidence'].status, 'passed', 'passed with evidence is preserved');
    deepEq(reread.evidenceRefs, ['ev:x'], 'evidenceRefs only includes refs that survived honesty');
  }
  finishSection();
} finally {
  const summary = sections.map((section) => `${section.name}:${section.count}`).join(' ');
  console.log(`RESULT_PACKETS_V2_ASSERTIONS ${totalAssertions}`);
  console.log(`RESULT_PACKETS_V2_SECTIONS ${summary}`);
  await closeResultPacketStore().catch(() => {});
  await closeWorkspaceLeaseStore().catch(() => {});
  for (const dir of createdDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  rmSync(configDir, { recursive: true, force: true });
}
