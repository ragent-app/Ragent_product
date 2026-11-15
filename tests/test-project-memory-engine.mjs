#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildProjectFreshDelta,
  buildProjectMemoryContext,
  filterProjectMemorySourceEvents,
  processProjectMemoryJobs,
  readProjectMemoryMode,
} from '../chat/project-memory-engine.mjs';
import { createProjectMemoryStore } from '../chat/project-memory-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-project-memory-engine-'));
const store = createProjectMemoryStore({
  databasePath: join(root, 'project-memory.sqlite'),
  workspaceRoot: join(root, 'project-memory'),
});

try {
  assert.equal(readProjectMemoryMode({}), 'off');
  assert.equal(readProjectMemoryMode({ RAGENT_PROJECT_MEMORY_MODE: 'shadow' }), 'shadow');
  assert.equal(readProjectMemoryMode({ RAGENT_PROJECT_MEMORY_MODE: 'unexpected' }), 'off');

  const source = filterProjectMemorySourceEvents([
    { seq: 1, type: 'message', role: 'user', requestId: 'req-a', content: 'Use workspace B.' },
    { seq: 2, type: 'message', role: 'assistant', runId: 'run-a', content: 'Updated configuration.' },
    { seq: 3, type: 'message', role: 'user', requestId: 'req-old', content: 'Older unrelated request.' },
    { seq: 4, type: 'status', runId: 'run-a', content: 'ignored' },
  ], { id: 'run-a', requestId: 'req-a' });
  assert.deepEqual(source.map((event) => event.seq), [1, 2], 'only the terminal run/request message slice is Stage 1 evidence');

  await store.initialize();
  await store.enqueueExtraction({
    projectId: 'prj_engine', workspaceId: 'ws_engine', sessionId: 'session-a', runId: 'run-a', provider: 'codex',
    sourceEventStart: 1, sourceEventEnd: 2, sourceDigest: 'engine-a',
    payload: {
      scope: { projectId: 'prj_engine', workspaceId: 'ws_engine', sessionId: 'session-a', runId: 'run-a', provider: 'codex', sourceEventStart: 1, sourceEventEnd: 2, sourceDigest: 'engine-a' },
      events: source, workspaceSnapshot: { workspaceId: 'ws_engine', rootPath: '/workspace/b' }, runtime: { tool: 'codex' },
    },
  });

  const calls = [];
  const result = await processProjectMemoryJobs({
    store,
    projectId: 'prj_engine',
    runPrompt: async ({ phase }) => {
      calls.push(phase);
      if (phase === 'extract') {
        return '<hide>{"sessionSummary":"Moved to workspace B.","taskStatus":"completed","candidates":[{"kind":"decision","statement":"Workspace B is the current execution root.","confidence":"verified","sourceEventStart":1,"sourceEventEnd":2}]}</hide>';
      }
      const input = await store.getConsolidationInput('prj_engine');
      const candidate = input.candidates[0];
      return `<hide>{"sections":{"Current State":[{"text":"Workspace B is the current execution root.","candidateIds":["${candidate.id}"],"state":"active"}]},"summary":"Workspace B is the current execution root.","resolutions":[{"candidateId":"${candidate.id}","state":"active"}]}</hide>`;
    },
  });
  assert.deepEqual(calls, ['extract', 'consolidate']);
  assert.equal(result.filter((entry) => entry.ok).length, 2);

  const summaryContext = await buildProjectMemoryContext(
    { projectId: 'prj_engine', tool: 'codex' },
    { store, env: { RAGENT_PROJECT_MEMORY_MODE: 'summary' } },
  );
  const claudeContext = await buildProjectMemoryContext(
    { projectId: 'prj_engine', tool: 'claude' },
    { store, env: { RAGENT_PROJECT_MEMORY_MODE: 'summary' } },
  );
  assert.equal(summaryContext, claudeContext, 'Codex-to-Claude uses the same Ragent-owned memory version');
  assert.match(summaryContext, /Workspace B/);
  const fullContext = await buildProjectMemoryContext(
    { projectId: 'prj_engine' },
    {
      store,
      env: { RAGENT_PROJECT_MEMORY_MODE: 'full' },
      workspaceSnapshot: { projectId: 'prj_engine', workspaceId: 'ws_engine', rootPath: '/workspace/b', resolutionState: 'resolved' },
    },
  );
  assert.match(fullContext, /Relevant current Project Memory/);
  assert.match(fullContext, /Deterministic current project\/workspace reality/);
  assert.match(fullContext, /\/workspace\/b/);
  assert.equal(await buildProjectMemoryContext({ projectId: 'prj_engine' }, { store, env: { RAGENT_PROJECT_MEMORY_MODE: 'shadow' } }), '');

  await store.enqueueExtraction({
    projectId: 'prj_fresh', workspaceId: 'ws_fresh', sessionId: 'session-fresh', runId: 'run-fresh',
    sourceEventStart: 20, sourceEventEnd: 22, sourceDigest: 'fresh-a',
    payload: { scope: {
      projectId: 'prj_fresh', workspaceId: 'ws_fresh', sessionId: 'session-fresh', runId: 'run-fresh',
      sourceEventStart: 20, sourceEventEnd: 22, sourceDigest: 'fresh-a', provider: 'claude',
    } },
  });
  const freshJob = await store.claimNextJob({ kind: 'extract', projectId: 'prj_fresh' });
  await store.completeExtraction(freshJob.id, freshJob.ownershipToken, {
    sessionSummary: 'Fresh verified change.', taskStatus: 'completed', candidates: [
      { kind: 'decision', factId: 'decision.fresh_change', statement: 'Fresh change is verified.', confidence: 'verified', sourceEventStart: 20, sourceEventEnd: 22 },
      { kind: 'state', statement: 'Tentative proposal only.', confidence: 'tentative', sourceEventStart: 20, sourceEventEnd: 22 },
    ],
  });
  const freshHead = await store.getProjectMemory('prj_fresh');
  assert.ok(freshHead.extractionWatermark > freshHead.consolidationWatermark);
  const freshDelta = await buildProjectFreshDelta('prj_fresh', 0, { store });
  assert.match(freshDelta, /Fresh change is verified/);
  assert.doesNotMatch(freshDelta, /Tentative proposal/);
  assert.equal(await buildProjectMemoryContext(
    { projectId: 'prj_fresh' }, { store, env: { RAGENT_PROJECT_MEMORY_MODE: 'shadow' } },
  ), '', 'shadow records Fresh Delta without injecting it');
  const freshContext = await buildProjectMemoryContext(
    { projectId: 'prj_fresh' }, { store, env: { RAGENT_PROJECT_MEMORY_MODE: 'summary' } },
  );
  assert.match(freshContext, /Fresh change is verified/);

  await store.enqueueExtraction({
    projectId: 'prj_bad', sessionId: 'session-bad', runId: 'run-bad', sourceEventStart: 10, sourceEventEnd: 12,
    sourceDigest: 'bad-a', payload: {
      scope: { projectId: 'prj_bad', sessionId: 'session-bad', runId: 'run-bad', sourceEventStart: 10, sourceEventEnd: 12, sourceDigest: 'bad-a' },
      events: [], runtime: { tool: 'codex' },
    },
  });
  const failed = await processProjectMemoryJobs({
    store,
    projectId: 'prj_bad',
    runPrompt: async () => '<hide>{"sessionSummary":"bad","taskStatus":"completed","candidates":[{"kind":"state","statement":"out of range","confidence":"reported","sourceEventStart":1,"sourceEventEnd":2}]}</hide>',
  });
  assert.equal(failed[0].ok, false, 'malformed Stage 1 evidence is recoverable and does not write a version');
  assert.equal((await store.getProjectMemory('prj_bad')), null);
  assert.equal((await store.listJobs({ projectId: 'prj_bad' }))[0].state, 'error');

  await store.enqueueExtraction({
    projectId: 'prj_curator_bad', sessionId: 'session-curator-bad', runId: 'run-curator-bad',
    sourceEventStart: 1, sourceEventEnd: 2, sourceDigest: 'curator-bad-a', payload: {
      scope: { projectId: 'prj_curator_bad', sessionId: 'session-curator-bad', runId: 'run-curator-bad', sourceEventStart: 1, sourceEventEnd: 2, sourceDigest: 'curator-bad-a' },
      runtime: { tool: 'codex' },
    },
  });
  const preparedExtraction = await store.claimNextJob({ kind: 'extract', projectId: 'prj_curator_bad' });
  await store.completeExtraction(preparedExtraction.id, preparedExtraction.ownershipToken, {
    sessionSummary: 'Curator failure setup.', taskStatus: 'completed',
    candidates: [{ kind: 'decision', statement: 'Needs a valid curator result.', confidence: 'verified', sourceEventStart: 1, sourceEventEnd: 2 }],
  });
  const curatorFailure = await processProjectMemoryJobs({
    store,
    projectId: 'prj_curator_bad',
    runPrompt: async () => 'not valid structured curator output',
  });
  assert.equal(curatorFailure[0].kind, 'consolidate');
  assert.equal(curatorFailure[0].ok, false, 'invalid Curator output cannot advance the project head');
  const curatorHead = await store.getProjectMemory('prj_curator_bad');
  assert.equal(curatorHead.currentVersion, 0);
  assert.ok(curatorHead.extractionWatermark > curatorHead.consolidationWatermark);
  assert.equal(curatorHead.consolidationWatermark, 0);
  const curatorJobs = await store.listJobs({ projectId: 'prj_curator_bad' });
  assert.equal(curatorJobs.find((job) => job.kind === 'extract').state, 'succeeded');
  assert.equal(curatorJobs.find((job) => job.kind === 'consolidate').state, 'error');

  console.log('test-project-memory-engine: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
