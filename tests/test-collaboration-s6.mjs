#!/usr/bin/env node
// S6 Collaboration integration acceptance:
// Task/Attempt/worker Session stay on one Project, aggregation consumes a
// bounded canonical ResultPacket projection, and a project-bound Attempt
// cannot be marked succeeded when packet creation fails.
import assert from 'assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = await mkdtemp(join(tmpdir(), 'ragent-collaboration-s6-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');

const apps = new Map([
  ['manager-s6', {
    id: 'manager-s6',
    name: 'Manager S6',
    tool: 'codex',
    collaborationPolicy: {
      role: 'manager',
      canDelegate: true,
      allowedAgentIds: ['worker-s6'],
      maxChildren: 4,
      maxConcurrent: 1,
      maxDepth: 2,
      workspacePolicy: 'shared-exclusive',
      revision: 'manager-s6-r1',
    },
  }],
  ['worker-s6', {
    id: 'worker-s6',
    name: 'Worker S6',
    tool: 'codex',
    collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'worker-s6-r1' },
  }],
]);

const projects = new Map([
  ['prj-s6', { id: 'prj-s6', rootPath: configDir, workspaceId: 'ws-s6' }],
  ['prj-s6-fail', { id: 'prj-s6-fail', rootPath: configDir, workspaceId: 'ws-s6' }],
  ['prj-other', { id: 'prj-other', rootPath: configDir, workspaceId: 'ws-s6' }],
]);
const sessions = new Map();
const runs = new Map();
const packetCalls = [];
const packetReads = [];
let childCounter = 0;
let runCounter = 0;
let aggregationPrompt = '';
let failPacketCreation = false;

function makeRoot(id, projectId) {
  const root = {
    id,
    folder: configDir,
    projectId,
    tool: 'codex',
    templateId: 'manager-s6',
    name: id,
    delegationDepth: 0,
  };
  sessions.set(id, root);
  return root;
}

makeRoot('root-s6', 'prj-s6');
makeRoot('root-s6-fail', 'prj-s6-fail');

const orchestrator = createCollaborationOrchestrator({
  pollMs: 100000,
  dependencies: {
    getSession: async (id) => sessions.get(id) || null,
    getApp: async (id) => apps.get(id) || null,
    getProject: async (id) => projects.get(id) || null,
    createSession: async (folder, tool, name, extra) => {
      const session = { id: `worker-session-${++childCounter}`, folder, tool, name, ...extra };
      sessions.set(session.id, session);
      return session;
    },
    sendMessage: async (sessionId, prompt, _images, options) => {
      if (options.internalOperation === 'collaboration_resume') aggregationPrompt = prompt;
      const run = {
        id: `s6-run-${++runCounter}`,
        sessionId,
        state: 'running',
        requestId: options.requestId,
        result: null,
      };
      runs.set(run.id, run);
      return { session: sessions.get(sessionId), run, prompt };
    },
    getRunState: async (id) => runs.get(id) || null,
    getRun: async (id) => runs.get(id) || null,
    getRunResult: async (id) => runs.get(id)?.result || null,
    getRunManifest: async (id) => ({
      projectId: runs.get(id)?.sessionId === 'root-s6-fail' ? 'prj-s6-fail' : 'prj-s6',
      executionScope: { projectId: runs.get(id)?.sessionId === 'root-s6-fail' ? 'prj-s6-fail' : 'prj-s6' },
      folder: configDir,
    }),
    listRunIds: async () => [...runs.keys()],
    requestRunCancel: async () => null,
    loadHistory: async () => [{ type: 'message', role: 'assistant', content: 'worker report' }],
    createExecutionPacket: async (input) => {
      packetCalls.push(input);
      if (failPacketCreation) throw new Error('packet backend unavailable');
      return { packetId: 'rsp-s6-worker' };
    },
    getResultPacket: async (packetId) => {
      packetReads.push(packetId);
      return {
        packetId,
        digest: 'sha256:s6',
        kind: 'execution',
        state: 'succeeded',
        producer: { projectId: 'prj-s6', runId: 's6-run-1' },
        summary: 'worker packet summary',
        changedFiles: [{ path: 'chat/example.mjs' }],
        tests: [{ name: 's6-test', status: 'passed', evidenceRef: 'ev:s6' }],
        acceptanceResults: [],
        decisions: ['use one Project'],
        blockers: [],
        risks: [],
        artifacts: [],
        provenance: { executionScopeDigest: 'sha256:scope-s6' },
      };
    },
  },
});

try {
  const collaboration = await orchestrator.dispatch({
    rootSessionId: 'root-s6',
    plan: {
      title: 'S6 binding',
      tasks: [{ id: 'worker-task-s6', projectId: 'prj-s6', agentId: 'worker-s6', objective: 'produce packet' }],
    },
    idempotencyKey: 's6-binding',
  });
  const child = sessions.get(collaboration.tasks[0].sessionId);
  assert.equal(collaboration.tasks[0].projectId, 'prj-s6');
  assert.equal(collaboration.attempts[0].projectId, 'prj-s6');
  assert.equal(child.projectId, 'prj-s6', 'worker Session must inherit Task projectId');

  const workerRun = runs.get(collaboration.tasks[0].runId);
  workerRun.state = 'completed';
  workerRun.result = { synthesized: true, completedAt: new Date().toISOString() };
  assert.equal(await orchestrator.completeRun(workerRun.id), true);
  const aggregating = await orchestrator.get(collaboration.id);
  assert.ok(aggregating.aggregationRunId, 'barrier should start Manager aggregation');
  assert.ok(packetCalls.some((call) => call.projectId === 'prj-s6' && call.taskId === 'worker-task-s6'), 'worker completion must create a project packet');
  assert.deepEqual(packetReads, ['rsp-s6-worker'], 'Manager must read the canonical packet reference');
  assert.match(aggregationPrompt, /worker packet summary/, 'aggregation prompt must contain the bounded packet projection');
  assert.match(aggregationPrompt, /sha256:s6/, 'aggregation prompt must contain packet provenance');

  const aggregationRun = runs.get(aggregating.aggregationRunId);
  aggregationRun.state = 'completed';
  aggregationRun.result = { synthesized: true, completedAt: new Date().toISOString() };
  assert.equal(await orchestrator.completeAggregation(aggregationRun.id), true);
  assert.equal((await orchestrator.get(collaboration.id)).state, 'completed');

  await assert.rejects(
    orchestrator.dispatch({
      rootSessionId: 'root-s6',
      projectId: 'prj-other',
      plan: { tasks: [{ id: 'mismatch', projectId: 'prj-other', agentId: 'worker-s6', objective: 'reject mismatch' }] },
      idempotencyKey: 's6-project-mismatch',
    }),
    (error) => error?.code === 'COLLABORATION_PROJECT_MISMATCH',
  );

  failPacketCreation = true;
  const failed = await orchestrator.dispatch({
    rootSessionId: 'root-s6-fail',
    plan: { tasks: [{ id: 'packet-failure', projectId: 'prj-s6-fail', agentId: 'worker-s6', objective: 'must not report success' }] },
    idempotencyKey: 's6-packet-failure',
  });
  const failedRun = runs.get(failed.tasks[0].runId);
  failedRun.state = 'completed';
  failedRun.result = { synthesized: true, completedAt: new Date().toISOString() };
  assert.equal(await orchestrator.completeRun(failedRun.id), true);
  const failedRecord = await orchestrator.get(failed.id);
  assert.equal(failedRecord.tasks[0].state, 'failed');
  assert.equal(failedRecord.attempts[0].failureKind, 'deterministic_failure');
  assert.equal(failedRecord.state, 'failed');
  assert.equal(failedRecord.aggregationRunId, '');

  console.log('test-collaboration-s6: ok');
} finally {
  orchestrator.stop();
  await rm(configDir, { recursive: true, force: true });
}
