#!/usr/bin/env node
// S13 Gate/Phase contract (constitution §2.6/§2.7/§2.14, §4 stable codes):
//   - decideGate records a one-shot gate decision as a fresh generation via the
//     advanceGateGeneration CAS (GATE_STALE_GENERATION on conflict).
//   - completePhase is the only path to `phase.completed`: it CAS-advances
//     organization.progress_epoch and writes a phase_completed event, and only
//     when the latest gate is 'passed' AND every acceptance result is passed
//     with evidence (else PHASE_ACCEPTANCE_INCOMPLETE).
//   - NEEDS_CHANGES never mutates the old packet/gate: a new Attempt + new
//     ResultPacket (parentPacketIds -> old packet) + new gate generation.
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-phase-gates-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const store = await import('../chat/organization-store.mjs');
const gates = await import('../chat/phase-gates.mjs');
const rp = await import('../chat/result-packets.mjs');
const { createRun, writeRunResult, ensureRunDirectory } = await import('../chat/runs.mjs');
const { createProject } = await import('../chat/projects.mjs');
const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');
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

async function makeTerminalRun({ project, sessionId, runId, result = {} }) {
  await ensureRunDirectory(runId);
  const requestId = `req_${runId}`;
  await createRun({
    status: { id: runId, sessionId, requestId, state: 'completed', contextInputTokens: 100, contextWindowTokens: 64000, normalizedLineCount: 5 },
    manifest: {
      sessionId,
      requestId,
      projectId: project.id,
      executionScope: { projectId: project.id, sessionId, workspaceRevision: 1, git: { state: 'available', baseCommit: 'base', headCommit: 'head', dirty: false, partial: false } },
      executionScopeDigest: 'sha256:phase-scope',
    },
  });
  await writeRunResult(runId, { summary: `summary for ${runId}`, ...result });
  return runId;
}

const ACCEPT_OK = [{ name: 'criterion', status: 'passed', evidenceRef: 'ev:1' }];

try {
  await store.initializeOrganizationStore();
  const org = await store.createOrganization({ rootSessionId: 'root-phase', projectId: 'prj-phase' });
  const manager = await store.createNode({ organizationId: org.id, stableKey: 'manager-1', nodeRole: 'manager', createdRevision: 1 });
  await store.createRevision(org.id, { revision: 1, proposal: { nodes: [{ stableKey: 'manager-1', role: 'manager', capabilities: ['read'] }] }, state: 'frozen' });

  // ── acceptanceSatisfied matrix ──────────────────────────────────────────
  beginSection('acceptance-satisfied');
  {
    eq(gates.acceptanceSatisfied([]), false, 'empty acceptance is incomplete');
    eq(gates.acceptanceSatisfied([{ name: 'a', status: 'passed' }]), false, 'passed without evidence is incomplete');
    eq(gates.acceptanceSatisfied([{ name: 'a', status: 'failed', evidenceRef: 'ev:1' }]), false, 'failed is incomplete');
    eq(gates.acceptanceSatisfied([{ name: 'a', status: 'unknown', evidenceRef: 'ev:1' }]), false, 'unknown is incomplete');
    eq(gates.acceptanceSatisfied([{ name: 'a', status: 'passed', evidence: 'ev:inline' }]), true, 'any evidence key satisfies');
    eq(gates.acceptanceSatisfied(ACCEPT_OK), true, 'all passed with evidence satisfies');
    eq(gates.acceptanceSatisfied(null), false, 'null acceptance is incomplete');
  }
  finishSection();

  // ── decideGate passed -> generation 1 ────────────────────────────────────
  beginSection('decide-passed');
  {
    const g1 = await gates.decideGate({
      organizationId: org.id,
      phaseId: 'phase-1',
      fromGeneration: 0,
      decision: 'passed',
      decidedByNodeId: manager.id,
      packetId: 'rsp_1',
      acceptance: ACCEPT_OK,
    });
    eq(g1.generation, 1, 'first decision advances to generation 1');
    eq(g1.state, 'passed', 'passed decision is recorded as a passed gate');
    eq(g1.decidedByNodeId, manager.id);
    eq(g1.packetId, 'rsp_1');
    deepEq(g1.decision, { decision: 'passed', acceptance: ACCEPT_OK }, 'decision JSON carries the acceptance evidence');
    const latest = await gates.getPhaseGate(org.id, 'phase-1');
    eq(latest.generation, 1, 'getPhaseGate without generation returns the latest');
    eq(latest.state, 'passed');
  }
  finishSection();

  // ── completePhase: passed gate + satisfied acceptance -> phase.completed ─
  beginSection('phase-completed');
  {
    const done = await gates.completePhase({ organizationId: org.id, phaseId: 'phase-1', fromGeneration: 1 });
    eq(done.progressEpoch, 1, 'progress_epoch CAS-advances to 1');
    eq(done.gateGeneration, 1);
    ok(Number.isInteger(done.eventId), 'phase_completed event is written');
    const updated = await store.getOrganization(org.id);
    eq(updated.progressEpoch, 1, 'organization progress_epoch persisted');
    const events = await gates.listPhaseEvents(org.id, 'phase-1');
    eq(events.length, 1, 'one phase_completed event');
    eq(events[0].type, 'phase_completed', 'event type is phase_completed');
    eq(events[0].payload.progressEpoch, 1, 'event payload carries the new epoch');
  }
  finishSection();

  // ── completePhase: needs_changes gate -> PHASE_ACCEPTANCE_INCOMPLETE ─────
  beginSection('phase-incomplete-gate');
  {
    const g2 = await gates.decideGate({
      organizationId: org.id,
      phaseId: 'phase-1',
      fromGeneration: 1,
      decision: 'needs_changes',
      decidedByNodeId: manager.id,
      packetId: 'rsp_1',
    });
    eq(g2.generation, 2, 'needs_changes advances to generation 2');
    eq(g2.state, 'needs_changes', 'needs_changes is a fresh gate state');
    const g1read = await gates.getPhaseGate(org.id, 'phase-1', 1);
    eq(g1read.generation, 1, 'old gate generation is untouched');
    eq(g1read.state, 'passed', 'old gate decision is untouched');
    await rejects(
      () => gates.completePhase({ organizationId: org.id, phaseId: 'phase-1', fromGeneration: 2 }),
      (error) => error?.code === 'PHASE_ACCEPTANCE_INCOMPLETE' && error.statusCode === 409 && error.reason === 'gate_not_passed',
      'phase.completed on a needs_changes gate must fail closed',
    );
  }
  finishSection();

  // ── completePhase: acceptance incomplete -> PHASE_ACCEPTANCE_INCOMPLETE ──
  beginSection('phase-incomplete-acceptance');
  {
    await gates.decideGate({
      organizationId: org.id,
      phaseId: 'phase-acc',
      fromGeneration: 0,
      decision: 'passed',
      decidedByNodeId: manager.id,
      packetId: 'rsp_acc',
      acceptance: [{ name: 'no-evidence', status: 'passed' }],
    });
    await rejects(
      () => gates.completePhase({ organizationId: org.id, phaseId: 'phase-acc', fromGeneration: 1 }),
      (error) => error?.code === 'PHASE_ACCEPTANCE_INCOMPLETE' && error.reason === 'acceptance_incomplete',
      'passed gate with incomplete acceptance must not complete the phase',
    );
  }
  finishSection();

  // ── completePhase: no gate -> PHASE_ACCEPTANCE_INCOMPLETE ────────────────
  beginSection('phase-no-gate');
  {
    await rejects(
      () => gates.completePhase({ organizationId: org.id, phaseId: 'phase-none' }),
      (error) => error?.code === 'PHASE_ACCEPTANCE_INCOMPLETE' && error.reason === 'no_gate',
      'phase without any gate decision cannot complete',
    );
  }
  finishSection();

  // ── generation CAS conflict -> GATE_STALE_GENERATION ─────────────────────
  beginSection('gate-stale-generation');
  {
    await rejects(
      () => gates.decideGate({ organizationId: org.id, phaseId: 'phase-1', fromGeneration: 0, decision: 'needs_changes' }),
      (error) => error?.code === 'GATE_STALE_GENERATION' && error.statusCode === 409,
      'a stale fromGeneration must fail the CAS',
    );
    await rejects(
      () => gates.completePhase({ organizationId: org.id, phaseId: 'phase-1', fromGeneration: 1 }),
      (error) => error?.code === 'GATE_STALE_GENERATION',
      'phase.completed anchored on a stale generation must fail the CAS',
    );
  }
  finishSection();

  // ── NEEDS_CHANGES packet chain: old packet/gate immutable ────────────────
  beginSection('needs-changes-packet-chain');
  {
    const root = makeRoot('ragent-phase-chain-root-');
    const project = await makeProject('Phase Chain', root);
    const runA = nextRunId('run_chain_a');
    await makeTerminalRun({ project, sessionId: 'sess_chain_a', runId: runA, result: { summary: 'old attempt' } });
    const oldPacket = await rp.createExecutionPacket({ runId: runA, projectId: project.id });

    const gate = await gates.decideGate({
      organizationId: org.id,
      phaseId: 'phase-chain',
      fromGeneration: 0,
      decision: 'needs_changes',
      decidedByNodeId: manager.id,
      packetId: oldPacket.packetId,
      acceptance: [{ name: 'c', status: 'passed', evidenceRef: 'ev:old' }],
    });
    eq(gate.generation, 1, 'needs_changes creates a fresh generation');
    eq(gate.state, 'needs_changes');

    const runB = nextRunId('run_chain_b');
    await makeTerminalRun({ project, sessionId: 'sess_chain_b', runId: runB, result: { summary: 'rework', acceptanceResults: ACCEPT_OK } });
    const newPacket = await rp.createExecutionPacket({
      runId: runB,
      projectId: project.id,
      organizationId: org.id,
      nodeId: manager.id,
      revision: 1,
      phaseId: 'phase-chain',
      parentPacketIds: [oldPacket.packetId],
    });
    deepEq(newPacket.parentPacketIds, [oldPacket.packetId], 'rework packet chains to the old packet via parentPacketIds');
    eq(newPacket.organizationId, org.id, 'rework packet carries the organization');
    eq(newPacket.nodeId, manager.id, 'rework packet carries the node');
    eq(newPacket.revision, 1, 'rework packet carries the revision');
    eq(newPacket.phaseId, 'phase-chain', 'rework packet carries the phase');

    const oldRead = await rp.getResultPacket(oldPacket.packetId);
    eq(oldRead.packetId, oldPacket.packetId, 'old packet identity unchanged');
    ok(!('parentPacketIds' in oldRead), 'old packet has no parent chain (immutable)');
    eq(oldRead.summary, 'old attempt', 'old packet content unchanged');
    eq(oldRead.digest, oldPacket.digest, 'old packet digest unchanged');

    const g1read = await gates.getPhaseGate(org.id, 'phase-chain', 1);
    eq(g1read.generation, 1, 'old gate generation unchanged');
    eq(g1read.state, 'needs_changes', 'old gate decision unchanged');
  }
  finishSection();

  // ── orchestrator dispatchRework: new Attempt -> new Packet -> new Gate ───
  beginSection('orchestrator-rework-chain');
  {
    const rootDir = makeRoot('ragent-phase-orch-root-');
    const root = {
      id: 'root-orch',
      folder: rootDir,
      projectId: 'prj-orch',
      tool: 'codex',
      templateId: 'mgr-orch',
      name: 'Manager',
      delegationDepth: 0,
    };
    const apps = new Map([
      ['mgr-orch', {
        id: 'mgr-orch', name: 'Manager', tool: 'codex',
        collaborationPolicy: { role: 'manager', canDelegate: true, allowedAgentIds: ['spec-orch'], maxChildren: 4, maxConcurrent: 1, maxDepth: 2, workspacePolicy: 'shared-exclusive', revision: 'mgr-r1' },
      }],
      ['spec-orch', {
        id: 'spec-orch', name: 'Specialist', tool: 'codex',
        collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'spec-r1' },
      }],
    ]);
    const sessions = new Map([[root.id, root]]);
    const runs = new Map();
    let childCounter = 0;
    let runCounter = 0;
    const orchestrator = createCollaborationOrchestrator({
      pollMs: 100000,
      dependencies: {
        getSession: async (id) => sessions.get(id) || null,
        getProject: async (id) => ({ id: 'prj-orch', rootPath: rootDir, workspaceId: 'ws-orch' }),
        getApp: async (id) => apps.get(id) || null,
        createSession: async (folder, tool, name, extra) => {
          const session = { id: `child-orch-${++childCounter}`, folder, tool, name, ...extra };
          sessions.set(session.id, session);
          return session;
        },
        sendMessage: async (sessionId, text, _images, options) => {
          const run = { id: `run-orch-${++runCounter}`, sessionId, state: 'running', requestId: options.requestId, result: null };
          runs.set(run.id, run);
          return { session: sessions.get(sessionId), run, prompt: text };
        },
        getRunState: async (id) => runs.get(id) || null,
        getRun: async (id) => runs.get(id) || null,
        getRunResult: async (id) => runs.get(id)?.result || null,
        getRunManifest: async () => ({ folder: rootDir, projectId: 'prj-orch', executionScope: { projectId: 'prj-orch' } }),
        listRunIds: async () => [...runs.keys()],
        requestRunCancel: async () => null,
        loadHistory: async () => [{ type: 'message', role: 'assistant', content: 'rework report' }],
      },
    });
    try {
      // Old packet (from a prior attempt).
      runs.set('run-old-orch', { id: 'run-old-orch', sessionId: 'child-orch-0', state: 'completed', result: { synthesized: true, summary: 'old attempt' } });
      const oldPacket = await rp.createExecutionPacket({
        runId: 'run-old-orch', projectId: 'prj-orch', sessionId: 'child-orch-0', taskId: 'task-old', attemptId: 'attempt-old',
        deps: {
          getRun: async (id) => runs.get(id) || null,
          getRunManifest: async () => ({ folder: rootDir, projectId: 'prj-orch', executionScope: { projectId: 'prj-orch' } }),
          getRunResult: async (id) => runs.get(id)?.result || null,
        },
      });
      const result = await orchestrator.dispatchRework({
        rootSessionId: root.id,
        plan: { title: 'rework', tasks: [{ id: 'rework-task-orch', agentId: 'spec-orch', objective: 'fix the issue', projectId: 'prj-orch' }] },
        projectId: 'prj-orch',
        organizationId: org.id,
        phaseId: 'phase-orch',
        parentPacketId: oldPacket.packetId,
        nodeId: manager.id,
        revision: 1,
        fromGateGeneration: 0,
        decidedByNodeId: manager.id,
        idempotencyKey: 'orch-rework',
      });
      eq(result.gate.generation, 1, 'dispatchRework records needs_changes as generation 1');
      eq(result.gate.state, 'needs_changes');
      eq(result.collaboration.attempts.length, 1, 'dispatchRework opens a new Attempt');
      eq(result.collaboration.attempts[0].taskId, 'rework-task-orch', 'new attempt belongs to the rework task');

      const reworkRun = runs.get(result.collaboration.tasks[0].runId);
      reworkRun.state = 'completed';
      reworkRun.result = {
        synthesized: true,
        completedAt: new Date().toISOString(),
        summary: 'rework done',
        acceptanceResults: ACCEPT_OK,
      };
      eq(await orchestrator.completeRun(reworkRun.id), true, 'rework attempt completes');
      const collab = await orchestrator.get(result.collaboration.id);
      const attempt = collab.attempts[0];
      ok(attempt.resultPacketId, 'rework attempt produced a ResultPacket');
      const newPacket = await rp.getResultPacket(attempt.resultPacketId);
      deepEq(newPacket.parentPacketIds, [oldPacket.packetId], 'rework packet chains via parentPacketIds');
      eq(newPacket.organizationId, org.id, 'rework packet carries the organization');
      eq(newPacket.nodeId, manager.id, 'rework packet carries the node');
      eq(newPacket.revision, 1, 'rework packet carries the revision');
      eq(newPacket.phaseId, 'phase-orch', 'rework packet carries the phase');
      deepEq(newPacket.evidenceRefs, ['ev:1'], 'rework packet projects acceptance evidence');
      const oldRead = await rp.getResultPacket(oldPacket.packetId);
      ok(!('parentPacketIds' in oldRead), 'old packet stays immutable across the rework');
      eq(oldRead.digest, oldPacket.digest, 'old packet digest unchanged');
      const gateRead = await gates.getPhaseGate(org.id, 'phase-orch', 1);
      eq(gateRead.generation, 1, 'gate generation persisted');
      eq(gateRead.state, 'needs_changes');
    } finally {
      orchestrator.stop();
    }
  }
  finishSection();
} finally {
  const summary = sections.map((section) => `${section.name}:${section.count}`).join(' ');
  console.log(`PHASE_GATES_ASSERTIONS ${totalAssertions}`);
  console.log(`PHASE_GATES_SECTIONS ${summary}`);
  await rp.closeResultPacketStore().catch(() => {});
  await closeWorkspaceLeaseStore().catch(() => {});
  for (const dir of createdDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  rmSync(configDir, { recursive: true, force: true });
}
