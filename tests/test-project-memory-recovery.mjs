#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { processProjectMemoryJobs } from '../chat/project-memory-engine.mjs';
import { createProjectMemoryStore } from '../chat/project-memory-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-project-memory-recovery-'));
const databasePath = join(root, 'project-memory.sqlite');
const workspaceRoot = join(root, 'project-memory');

function hidden(value) {
  return `<hide>${JSON.stringify(value)}</hide>`;
}

async function enqueueAndExtract(store, projectId, runId, statement, sourceStart, sourceEnd) {
  await store.enqueueExtraction({
    projectId, workspaceId: `ws-${projectId}`, sessionId: `session-${runId}`, runId,
    sourceEventStart: sourceStart, sourceEventEnd: sourceEnd, sourceDigest: `digest-${runId}`,
    payload: { scope: {
      projectId, workspaceId: `ws-${projectId}`, sessionId: `session-${runId}`, runId,
      sourceEventStart: sourceStart, sourceEventEnd: sourceEnd, sourceDigest: `digest-${runId}`,
    } },
  });
  const job = await store.claimNextJob({ kind: 'extract', projectId });
  await store.completeExtraction(job.id, job.ownershipToken, {
    sessionSummary: statement,
    taskStatus: 'completed',
    candidates: [{
      kind: 'decision', factId: 'project.primary_workspace', statement, confidence: 'verified',
      sourceEventStart: sourceStart, sourceEventEnd: sourceEnd,
    }],
  });
}

try {
  let projectionWrites = 0;
  const failingStore = createProjectMemoryStore({
    databasePath,
    workspaceRoot,
    writeTextAtomic: async () => {
      projectionWrites += 1;
      throw new Error('simulated projection failure');
    },
  });
  await failingStore.initialize();
  await failingStore.enqueueExtraction({
    projectId: 'prj_projection', workspaceId: 'ws_projection', sessionId: 'session-projection', runId: 'run-projection',
    sourceEventStart: 1, sourceEventEnd: 2, sourceDigest: 'projection-a',
    payload: { scope: {
      projectId: 'prj_projection', workspaceId: 'ws_projection', sessionId: 'session-projection', runId: 'run-projection',
      sourceEventStart: 1, sourceEventEnd: 2, sourceDigest: 'projection-a',
    } },
  });
  const projectionResult = await processProjectMemoryJobs({
    store: failingStore,
    projectId: 'prj_projection',
    runPrompt: async ({ phase }) => phase === 'extract'
      ? hidden({ sessionSummary: 'Committed despite projection failure.', taskStatus: 'completed', candidates: [
        { kind: 'state', factId: 'project.primary_workspace', statement: 'Workspace projection test is current.', confidence: 'verified', sourceEventStart: 1, sourceEventEnd: 2 },
      ] })
      : hidden({
        sections: { 'Current State': [{ factId: 'project.primary_workspace', text: 'Workspace projection test is current.', candidateIds: [], state: 'active' }] },
        summary: 'Projection test is current.', factResolutions: [{ factId: 'project.primary_workspace', state: 'active' }],
      }),
  });
  assert.equal(projectionWrites, 1);
  assert.equal(projectionResult.find((entry) => entry.kind === 'consolidate').ok, false);
  const dirtyHead = await failingStore.getProjectMemory('prj_projection');
  assert.equal(dirtyHead.currentVersion, 1, 'DB head survives a projection failure');
  assert.ok(dirtyHead.extractionWatermark >= dirtyHead.consolidationWatermark);
  assert.equal(dirtyHead.projectionState, 'dirty');
  assert.match(dirtyHead.projectionError, /simulated projection failure/);

  const restartedStore = createProjectMemoryStore({ databasePath, workspaceRoot });
  await restartedStore.initialize();
  const repairedHead = await restartedStore.getProjectMemory('prj_projection');
  assert.equal(repairedHead.projectionState, 'clean', 'restart repairs the projection from DB truth');
  assert.equal(repairedHead.projectedVersion, repairedHead.currentVersion);
  assert.match(await readFile(join(workspaceRoot, 'prj_projection', 'MEMORY.md'), 'utf8'), /Workspace projection test is current/);

  const factsStore = restartedStore;
  await enqueueAndExtract(factsStore, 'prj_facts', 'run-a', 'Workspace A is current.', 10, 12);
  await processProjectMemoryJobs({
    store: factsStore,
    projectId: 'prj_facts',
    runPrompt: async ({ phase }) => {
      if (phase === 'extract') throw new Error('extract should already be complete');
      const input = await factsStore.getConsolidationInput('prj_facts');
      const candidate = input.candidates[0];
      return hidden({
        sections: { 'Current State': [{ factId: 'project.primary_workspace', factKey: 'project.primary_workspace', factValue: 'Workspace A is current.', text: 'Workspace A is current.', candidateIds: [candidate.id], state: 'active' }] },
        summary: 'Workspace A is current.', resolutions: [{ candidateId: candidate.id, state: 'active' }],
      });
    },
  });
  await enqueueAndExtract(factsStore, 'prj_facts', 'run-b', 'Workspace B replaces Workspace A.', 13, 15);
  await processProjectMemoryJobs({
    store: factsStore,
    projectId: 'prj_facts',
    runPrompt: async ({ phase }) => {
      if (phase === 'extract') throw new Error('extract should already be complete');
      const input = await factsStore.getConsolidationInput('prj_facts');
      const next = input.candidates.find((candidate) => candidate.statement.includes('Workspace B'));
      const old = input.priorCandidates.find((candidate) => candidate.statement.includes('Workspace A'));
      return hidden({
        sections: { 'Current State': [{ factId: 'project.primary_workspace', factKey: 'project.primary_workspace', factValue: 'Workspace B replaces Workspace A.', text: 'Workspace B replaces Workspace A.', candidateIds: [next.id], state: 'active' }] },
        summary: 'Workspace B is current.',
        resolutions: [{ candidateId: old.id, state: 'superseded' }, { candidateId: next.id, state: 'active' }],
      });
    },
  });
  const currentFacts = await factsStore.listCurrentFacts('prj_facts');
  assert.deepEqual(currentFacts.map((fact) => [fact.factId, fact.state, fact.factValue]), [
    ['project.primary_workspace', 'active', 'Workspace B replaces Workspace A.'],
  ]);
  const history = await factsStore.getFactHistory('prj_facts', 'project.primary_workspace');
  assert.equal(history.length, 2);
  assert.equal(history[1].supersedesFactVersion, history[0].factVersion);
  const firstVersion = await factsStore.getMemoryVersion('prj_facts', 1);
  const secondVersion = await factsStore.getMemoryVersion('prj_facts', 2);
  const versionDiff = await factsStore.diffMemoryVersions('prj_facts', 1, 2);
  assert.deepEqual(versionDiff.changedFactIds, ['project.primary_workspace']);
  assert.equal(secondVersion.parentVersion, firstVersion.version);
  const rolledBack = await factsStore.rollbackProjectMemoryHead('prj_facts', 1);
  assert.equal(rolledBack.currentVersion, 1, 'rollback moves only the mutable head');
  assert.equal(rolledBack.projectionState, 'dirty');
  assert.equal((await factsStore.listCurrentFacts('prj_facts'))[0].factValue, 'Workspace A is current.');
  await factsStore.writeProjection(firstVersion);
  assert.equal((await factsStore.getProjectMemory('prj_facts')).projectionState, 'clean');

  await enqueueAndExtract(factsStore, 'prj_a', 'run-a1', 'Project A fact.', 20, 21);
  await enqueueAndExtract(factsStore, 'prj_b', 'run-b1', 'Project B fact.', 22, 23);
  const inputA = await factsStore.getConsolidationInput('prj_a');
  const inputB = await factsStore.getConsolidationInput('prj_b');
  assert.equal(inputA.candidates.length, 1);
  assert.equal(inputB.candidates.length, 1);
  assert.notEqual(inputA.candidates[0].id, inputB.candidates[0].id, 'project candidates remain isolated');

  console.log('test-project-memory-recovery: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
