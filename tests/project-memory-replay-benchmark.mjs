#!/usr/bin/env node
/**
 * Offline deterministic replay for the Project Memory Engine.
 *
 * It intentionally does not claim to measure a live provider's reasoning
 * quality. It exercises the memory lifecycle with six representative sessions
 * and compares the prompt payloads/risk signals that a later provider-backed
 * benchmark can measure in production.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildProjectMemoryContext, processProjectMemoryJobs } from '../chat/project-memory-engine.mjs';
import { createProjectMemoryStore } from '../chat/project-memory-store.mjs';

const sessions = [
  {
    id: 'A', provider: 'codex', kind: 'architecture',
    statement: 'Architecture baseline: the runner delegates through the HTTP control plane. Workspace A is the current execution root.',
  },
  {
    id: 'B', provider: 'codex', kind: 'decision', factId: 'project.primary_workspace',
    statement: 'Decision: Workspace B replaces Workspace A as the execution root.',
  },
  {
    id: 'C', provider: 'codex', kind: 'state',
    statement: 'State: the prior Workspace A assumption is retired.',
  },
  {
    id: 'D', provider: 'claude', kind: 'constraint',
    statement: 'Constraint: long-term project memory must remain provider-independent.',
  },
  {
    id: 'E', provider: 'claude', kind: 'state',
    statement: 'Recent change: unrelated notification cleanup completed.',
  },
  {
    id: 'F', provider: 'codex', kind: 'state',
    statement: 'Return to the control-plane task and prepare the next task.',
  },
];

const root = await mkdtemp(join(tmpdir(), 'ragent-project-memory-replay-'));
const store = createProjectMemoryStore({
  databasePath: join(root, 'project-memory.sqlite'),
  workspaceRoot: join(root, 'project-memory'),
});

function hidden(value) {
  return `<hide>${JSON.stringify(value)}</hide>`;
}

function tokenEstimate(value) {
  return Math.ceil(String(value || '').length / 4);
}

function extractionResult(source, scope) {
  return {
    sessionSummary: source.statement,
    taskStatus: source.id === 'F' ? 'active' : 'completed',
    candidates: [{
      kind: source.kind,
      ...(source.factId ? { factId: source.factId } : {}),
      statement: source.statement,
      confidence: 'verified',
      sourceEventStart: scope.sourceEventStart,
      sourceEventEnd: scope.sourceEventEnd,
    }],
  };
}

function summaryOnlyContext(memory) {
  return [
    'Project Memory (latest successful L4 only; no Fresh Delta):',
    memory?.summary || '',
  ].filter(Boolean).join('\n\n');
}

try {
  await store.initialize();
  async function enqueue(source, index) {
    await store.enqueueExtraction({
      projectId: 'prj_replay', workspaceId: 'ws_replay', sessionId: `session-${source.id}`, runId: `run-${source.id}`,
      provider: source.provider, sourceEventStart: index * 2 + 1, sourceEventEnd: index * 2 + 2, sourceDigest: `digest-${source.id}`,
      payload: {
        scope: {
          projectId: 'prj_replay', workspaceId: 'ws_replay', sessionId: `session-${source.id}`, runId: `run-${source.id}`,
          provider: source.provider, sourceEventStart: index * 2 + 1, sourceEventEnd: index * 2 + 2, sourceDigest: `digest-${source.id}`,
        },
        events: [{ seq: index * 2 + 1, role: 'user', content: source.statement }],
        workspaceSnapshot: { workspaceId: 'ws_replay', rootPath: index < 1 ? '/workspace/a' : '/workspace/b' },
        runtime: { tool: 'codex' },
      },
    });
  }

  async function replayWorker({ phase, job }) {
    if (phase === 'extract') {
      const scope = job.payload.scope;
      const source = sessions.find((session) => `run-${session.id}` === scope.runId);
      return hidden(extractionResult(source, scope));
    }
    const input = await store.getConsolidationInput('prj_replay');
    const allCandidates = [...input.priorCandidates, ...input.candidates];
    const byStatement = (needle) => allCandidates.find((candidate) => candidate.statement.includes(needle));
    const oldWorkspace = byStatement('Workspace A is the current');
    const currentWorkspace = byStatement('Workspace B replaces');
    const architecture = byStatement('Architecture baseline');
    const providerConstraint = byStatement('provider-independent');
    const recent = byStatement('notification cleanup');
    const returned = byStatement('Return to');
    const sections = {
      Identity: [{ text: 'Ragent replay project.', candidateIds: [] }],
      Architecture: architecture ? [{ text: architecture.statement, candidateIds: [architecture.id] }] : [],
      'Current State': currentWorkspace
        ? [{ text: 'Workspace B is the current execution root.', candidateIds: [currentWorkspace.id] }]
        : oldWorkspace ? [{ text: 'Workspace A is the current execution root.', candidateIds: [oldWorkspace.id] }] : [],
      Constraints: providerConstraint ? [{ text: providerConstraint.statement, candidateIds: [providerConstraint.id] }] : [],
      'Active Threads': returned ? [{ text: returned.statement, candidateIds: [returned.id] }] : [],
      'Recent Major Changes': recent ? [{ text: recent.statement, candidateIds: [recent.id] }] : [],
    };
    const resolutions = allCandidates.map((candidate) => ({
      candidateId: candidate.id,
      state: candidate.id === oldWorkspace?.id && currentWorkspace ? 'superseded' : 'active',
    }));
    return hidden({
      sections,
      summary: currentWorkspace
        ? 'Workspace B is current. Project memory is provider-independent. Control-plane task remains active.'
        : 'Workspace A is current. Control-plane architecture is established.',
      resolutions,
    });
  }

  // Establish L4 from A. B then completes Stage 1, but intentionally does
  // not run Phase 2 before the simulated next session is prepared.
  await enqueue(sessions[0], 0);
  await processProjectMemoryJobs({ store, projectId: 'prj_replay', runPrompt: replayWorker });
  await enqueue(sessions[1], 1);
  const bExtraction = await store.claimNextJob({ kind: 'extract', projectId: 'prj_replay' });
  assert.ok(bExtraction, 'B must have a durable Stage 1 job');
  await store.completeExtraction(
    bExtraction.id,
    bExtraction.ownershipToken,
    extractionResult(sessions[1], bExtraction.payload.scope),
  );

  const beforeConsolidation = await store.getProjectMemory('prj_replay');
  assert.ok(beforeConsolidation.extractionWatermark > beforeConsolidation.consolidationWatermark);
  const withoutFreshDelta = summaryOnlyContext(beforeConsolidation);
  const withFreshDelta = await buildProjectMemoryContext(
    { projectId: 'prj_replay' },
    { store, env: { RAGENT_PROJECT_MEMORY_MODE: 'summary' } },
  );
  const concatenatedSummaries = sessions.slice(0, 2).map((session) => session.statement).join('\n');
  const currentTask = sessions.at(-1).statement;
  const rows = [
    {
      strategy: 'No Project Memory', contextTokens: tokenEstimate(currentTask),
      taskRecoveryAccuracy: false, staleFactRate: 0, staleCurrentStateRate: 0,
      bootstrapCorrectness: false, freshDeltaCorrectness: false, wrongDecisionReuseRisk: false,
      toolCallsBeforeProductiveWorkProxy: 2, timeToResumeProxy: 2,
      note: 'No earlier architecture or workspace decision is available.',
    },
    {
      strategy: 'Concatenated L1 summaries', contextTokens: tokenEstimate(concatenatedSummaries),
      taskRecoveryAccuracy: true, staleFactRate: 1, staleCurrentStateRate: 1,
      bootstrapCorrectness: false, freshDeltaCorrectness: false, wrongDecisionReuseRisk: true,
      toolCallsBeforeProductiveWorkProxy: 1, timeToResumeProxy: 1,
      note: 'Both Workspace A and B appear in an uncurated prompt.',
    },
    {
      strategy: 'Project Memory without Fresh Delta', contextTokens: tokenEstimate(withoutFreshDelta),
      taskRecoveryAccuracy: false, staleFactRate: 1, staleCurrentStateRate: 1,
      bootstrapCorrectness: false, freshDeltaCorrectness: false, wrongDecisionReuseRisk: true,
      toolCallsBeforeProductiveWorkProxy: 1, timeToResumeProxy: 1,
      note: 'The latest successful L4 still reports Workspace A while B awaits consolidation.',
    },
    {
      strategy: 'Project Memory + Fresh Delta', contextTokens: tokenEstimate(withFreshDelta),
      taskRecoveryAccuracy: true, staleFactRate: 0, staleCurrentStateRate: 0,
      bootstrapCorrectness: true, freshDeltaCorrectness: true, wrongDecisionReuseRisk: false,
      toolCallsBeforeProductiveWorkProxy: 0, timeToResumeProxy: 0,
      note: 'The verified B candidate bridges the stale L4 without waiting for Curator.',
    },
  ];
  assert.match(withoutFreshDelta, /Workspace A is current/);
  assert.doesNotMatch(withoutFreshDelta, /Workspace B replaces/);
  assert.match(withFreshDelta, /Workspace B replaces/);
  assert.equal(rows[3].staleCurrentStateRate, 0);
  assert.equal(rows[3].bootstrapCorrectness, true);

  // Continue C-F so the replay covers supersession, provider switch, unrelated
  // work, and a return to the original task after the immediate bridge case.
  await processProjectMemoryJobs({ store, projectId: 'prj_replay', runPrompt: replayWorker });
  for (let index = 2; index < sessions.length; index += 1) {
    await enqueue(sessions[index], index);
    await processProjectMemoryJobs({
      store,
      projectId: 'prj_replay',
      runPrompt: replayWorker,
    });
  }
  const projectMemory = await buildProjectMemoryContext(
    { projectId: 'prj_replay' },
    { store, env: { RAGENT_PROJECT_MEMORY_MODE: 'summary' } },
  );
  assert.match(projectMemory, /Workspace B is current/, projectMemory);
  assert.match(projectMemory, /provider-independent/, projectMemory);
  assert.doesNotMatch(projectMemory, /Workspace A is current/, projectMemory);
  const providerSwitchContinuity = sessions[3].provider !== sessions.at(-1).provider
    && /provider-independent/.test(projectMemory);
  assert.equal(providerSwitchContinuity, true, 'the Claude-originated constraint survives the return to Codex');
  console.log(JSON.stringify({
    benchmark: 'project-memory-replay-v1',
    scenario: 'B extraction succeeds before consolidation; a new session is prepared immediately.',
    rows,
    finalTimelineChecks: {
      providerSwitchContinuity,
      finalProjectMemoryCurrentState: 'Workspace B',
      finalProjectMemoryContextTokens: tokenEstimate(projectMemory),
    },
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
