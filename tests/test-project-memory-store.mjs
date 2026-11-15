#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createProjectMemoryStore, readProjectMemoryJobOptions } from '../chat/project-memory-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-project-memory-store-'));
const store = createProjectMemoryStore({
  databasePath: join(root, 'project-memory.sqlite'),
  workspaceRoot: join(root, 'project-memory'),
});

async function stage(runId, sourceDigest, statement, start, end) {
  const job = await store.enqueueExtraction({
    projectId: 'prj_test', workspaceId: 'ws_test', sessionId: `session-${runId}`, runId,
    provider: 'codex', sourceDigest, sourceEventStart: start, sourceEventEnd: end,
    payload: { scope: { projectId: 'prj_test', sessionId: `session-${runId}`, runId, sourceDigest, sourceEventStart: start, sourceEventEnd: end } },
  });
  const claimed = await store.claimNextJob({ kind: 'extract' });
  assert.equal(claimed.id, job.id);
  await store.completeExtraction(claimed.id, claimed.ownershipToken, {
    sessionSummary: `Run ${runId} completed.`, taskStatus: 'completed',
    candidates: [{ kind: 'decision', statement, confidence: 'verified', sourceEventStart: start, sourceEventEnd: end }],
  });
}

try {
  assert.deepEqual(readProjectMemoryJobOptions({
    RAGENT_PROJECT_MEMORY_LEASE_MS: '1000',
    RAGENT_PROJECT_MEMORY_RETRY_MS: '2000',
    RAGENT_PROJECT_MEMORY_RETRIES: '4',
  }), { leaseMs: 1000, retryMs: 2000, retryRemaining: 4 });

  const legacyDatabasePath = join(root, 'legacy-project-memory.sqlite');
  const legacyDatabase = new DatabaseSync(legacyDatabasePath);
  legacyDatabase.exec(`
    CREATE TABLE project_memory (
      project_id TEXT PRIMARY KEY,
      current_version INTEGER NOT NULL DEFAULT 0,
      source_watermark INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      workspace_snapshot_json TEXT NOT NULL DEFAULT '{}',
      content_digest TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    INSERT INTO project_memory
      (project_id, current_version, source_watermark, content, summary, workspace_snapshot_json, content_digest, updated_at)
      VALUES ('legacy-project', 1, 7, '# Project Memory', 'v1\nLegacy summary.', '{}', 'legacy-digest', '2030-01-01T00:00:00.000Z');
  `);
  legacyDatabase.close();
  const legacyStore = createProjectMemoryStore({
    databasePath: legacyDatabasePath,
    workspaceRoot: join(root, 'legacy-project-memory'),
  });
  await legacyStore.initialize();
  const migrated = await legacyStore.getProjectMemory('legacy-project');
  assert.equal(migrated.extractionWatermark, 7, 'legacy source watermark migrates to extraction watermark');
  assert.equal(migrated.consolidationWatermark, 7, 'legacy source watermark migrates to consolidation watermark');
  assert.equal(migrated.projectionState, 'dirty', 'legacy current head requires projection repair');

  await store.initialize();
  await stage('run-a', 'digest-a', 'Workspace A is the execution root.', 1, 4);
  const duplicate = await store.enqueueExtraction({
    projectId: 'prj_test', workspaceId: 'ws_test', sessionId: 'session-run-a', runId: 'run-a',
    sourceDigest: 'digest-a', sourceEventStart: 1, sourceEventEnd: 4, payload: {},
  });
  assert.equal(duplicate.state, 'succeeded', 'unchanged rollout must not be consumed twice');
  assert.deepEqual((await store.listRunnableProjects()).map((entry) => entry.projectId), ['prj_test']);

  let consolidate = await store.claimNextJob({ kind: 'consolidate' });
  let input = await store.getConsolidationInput('prj_test');
  assert.equal(input.stages.length, 1);
  const candidateA = input.candidates[0].id;
  let version = await store.commitConsolidation(consolidate.id, consolidate.ownershipToken, {
    content: '# Project Memory\n\n## Current State\n\n- Workspace A is the execution root.',
    summary: 'v1\nWorkspace A is current.', sourceWatermark: input.nextWatermark,
    workspaceSnapshot: { workspaceId: 'ws_test', rootPath: '/workspace/a' }, candidateIds: [candidateA],
    resolutions: [{ candidateId: candidateA, state: 'active' }],
    facts: [{ section: 'Current State', text: 'Workspace A is the execution root.', state: 'active', candidateIds: [candidateA] }],
  });
  await store.writeProjection(version);
  await store.finishCommittedJob(consolidate.id, consolidate.ownershipToken);

  await stage('run-b', 'digest-b', 'Workspace B replaces workspace A.', 5, 9);
  consolidate = await store.claimNextJob({ kind: 'consolidate' });
  input = await store.getConsolidationInput('prj_test');
  assert.equal(input.stages.length, 1, 'watermark selects only new stage-one evidence');
  assert.equal(input.priorCandidates.length, 1, 'existing current facts remain available for invalidation');
  const candidateB = input.candidates[0].id;
  version = await store.commitConsolidation(consolidate.id, consolidate.ownershipToken, {
    content: '# Project Memory\n\n## Current State\n\n- Workspace B is the execution root.',
    summary: 'v1\nWorkspace B is current.', sourceWatermark: input.nextWatermark,
    workspaceSnapshot: { workspaceId: 'ws_test', rootPath: '/workspace/b' }, candidateIds: [candidateA, candidateB],
    resolutions: [{ candidateId: candidateA, state: 'superseded' }, { candidateId: candidateB, state: 'active' }],
    facts: [{ section: 'Current State', text: 'Workspace B is the execution root.', state: 'active', candidateIds: [candidateB] }],
  });
  await store.writeProjection(version);
  await store.finishCommittedJob(consolidate.id, consolidate.ownershipToken);
  const head = await store.getProjectMemory('prj_test');
  assert.equal(head.currentVersion, 2);
  assert.match(head.summary, /^v2\b/, 'the committed L4 header must carry the actual version');
  assert.match(head.content, /Workspace B/);
  assert.doesNotMatch(head.content, /Workspace A is the execution root/);
  const afterReplacement = await store.getConsolidationInput('prj_test');
  assert.deepEqual(afterReplacement.priorCandidates.map((candidate) => candidate.id), [candidateB], 'superseded facts cannot remain current');

  const paths = await store.writeProjection(version);
  await writeFile(paths.memory, 'dirty local projection');
  await store.writeProjection(version);
  assert.match(await readFile(paths.memory, 'utf8'), /Workspace B/, 'database version repairs a dirty projection');

  const failed = await store.enqueueExtraction({
    projectId: 'prj_test', sessionId: 'session-failure', runId: 'run-failure', sourceDigest: 'digest-failure',
    sourceEventStart: 10, sourceEventEnd: 11, payload: { scope: { projectId: 'prj_test', sessionId: 'session-failure', runId: 'run-failure', sourceDigest: 'digest-failure', sourceEventStart: 10, sourceEventEnd: 11 } },
  });
  const failedClaim = await store.claimNextJob({ kind: 'extract' });
  assert.equal(failedClaim.id, failed.id);
  await store.failJob(failedClaim.id, failedClaim.ownershipToken, 'simulated model failure', { now: new Date('2030-01-01T00:00:00.000Z') });
  const failedAfterRetry = (await store.listJobs({ projectId: 'prj_test', kind: 'extract' }))
    .find((job) => job.id === failed.id);
  const duplicateFailed = await store.enqueueExtraction({
    projectId: 'prj_test', sessionId: 'session-failure', runId: 'run-failure', sourceDigest: 'digest-failure',
    sourceEventStart: 10, sourceEventEnd: 11, payload: { scope: { projectId: 'prj_test' } },
  });
  assert.equal(duplicateFailed.state, 'error', 'duplicate source must preserve failed state');
  assert.equal(duplicateFailed.retryAt, failedAfterRetry.retryAt, 'duplicate source must preserve retry backoff');
  assert.equal(await store.hasRecoverableWork('prj_test'), true, 'restart recovery can discover nonterminal durable jobs');
  assert.deepEqual((await store.listRunnableProjects({ now: new Date('2030-01-01T00:01:00.000Z') })).map((entry) => entry.projectId), []);
  assert.deepEqual((await store.listRunnableProjects({ now: new Date('2030-01-01T00:06:00.000Z') })).map((entry) => entry.projectId), ['prj_test']);
  assert.equal(await store.claimNextJob({ kind: 'extract', now: new Date('2030-01-01T00:01:00.000Z') }), null, 'retry backoff prevents a hot loop');
  const retry = await store.claimNextJob({ kind: 'extract', now: new Date('2030-01-01T00:06:00.000Z') });
  assert.equal(retry.id, failed.id, 'expired retry can be reclaimed with a new ownership token');

  const rawEvents = [{ type: 'message', role: 'user', content: 'private source text' }];
  const rawJob = await store.enqueueExtraction({
    projectId: 'prj_retention', sessionId: 's-retention', runId: 'r-retention',
    sourceDigest: 'retention-a', sourceEventStart: 1, sourceEventEnd: 1,
    payload: { events: rawEvents, scope: { payload: { events: rawEvents } }, runtime: { tool: 'codex' } },
  });
  const rawClaim = await store.claimNextJob({ kind: 'extract', projectId: 'prj_retention' });
  assert.equal(rawClaim.id, rawJob.id);
  await store.completeExtraction(rawClaim.id, rawClaim.ownershipToken, {
    sessionSummary: 'Source was processed.', taskStatus: 'completed', candidates: [],
  });
  const completedRawJob = (await store.listJobs({ projectId: 'prj_retention', kind: 'extract' }))[0];
  assert.deepEqual(completedRawJob.payload.events, []);
  assert.deepEqual(completedRawJob.payload.scope.payload.events, []);
  const retainedConsolidation = (await store.listJobs({ projectId: 'prj_retention', kind: 'consolidate' }))[0];
  assert.equal(retainedConsolidation.payload.runtime.tool, 'codex', 'curation uses the source provider binding');

  console.log('test-project-memory-store: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
