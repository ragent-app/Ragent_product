#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'ragent-factory-fanout-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;
process.env.LOCALAPPDATA = join(tempRoot, 'localappdata');
process.env.APPDATA = join(tempRoot, 'appdata');
process.env.RAGENT_INSTANCE_ROOT = instanceRoot;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_STALL_GOVERNOR_ENABLED = '1';
process.env.RAGENT_FACTORY_CONTROL_ENABLED = 'true';
mkdirSync(configDir, { recursive: true });
mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
mkdirSync(process.env.APPDATA, { recursive: true });

const orgStore = await import('../chat/organization-store.mjs');
const governor = await import('../chat/organization-governor.mjs');
const boardStore = await import('../chat/organization-board-store.mjs');
const projects = await import('../chat/projects.mjs');
const resultPackets = await import('../chat/result-packets.mjs');
const workflow = await import('../chat/factory-workflow.mjs');
const executor = await import('../chat/factory-fanout-executor.mjs');
const { handleFactoryRoutes } = await import('../chat/router-factory-routes.mjs');

let assertionCount = 0;
const a = new Proxy(assert, {
  get(target, prop) {
    const val = target[prop];
    if (typeof val === 'function') {
      return (...args) => {
        assertionCount += 1;
        return val.apply(target, args);
      };
    }
    return val;
  },
});

async function callFactoryRoute({ method, path, body = null, authSession, headers = {} }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  req.headers = {
    'content-type': 'application/json',
    ...headers,
  };
  req.socket = { encrypted: false };
  let statusCode = 0;
  let payload = null;
  const res = {};
  const writeJson = (_res, status, data) => {
    statusCode = status;
    payload = data;
  };
  const promise = handleFactoryRoutes({ req, res, pathname: path, authSession, writeJson });
  process.nextTick(() => {
    if (body !== null) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'));
    req.emit('end');
  });
  const handled = await promise;
  return { handled, statusCode, payload };
}

async function runTests() {
  await orgStore.initializeOrganizationStore();
  await governor.initializeOrganizationGovernor();

  const org = await orgStore.createOrganization({
    rootSessionId: 'root-fanout-1',
    projectId: 'proj-fanout-1',
    currentRevision: 1,
    budget: { agents: 10, runs: 100, tokens: 100000, cost: 50 },
  });
  const otherOrg = await orgStore.createOrganization({
    rootSessionId: 'root-fanout-2',
    projectId: 'proj-fanout-2',
    currentRevision: 1,
  });
  const ownerActor = { kind: 'user', role: 'owner', principalId: 'owner-fanout-1' };

  // 1. Existing formulas still compile intact
  const legacyFormula = workflow.compileFactoryWorkflow({
    templateId: 'ragent-project-report',
    templateVersion: 1,
    organizationId: org.id,
    projectId: org.projectId,
    objective: 'Project readiness report',
    maxAttempts: 1,
    maxCost: 1,
    resource: { projectId: org.projectId, readScope: 'entire_project', networkPolicy: 'deny' },
  });
  a.equal(legacyFormula.workItems.length, 1);

  // 2. Composable phase / parallel / pipeline compilation & writer path / escalation guards
  const auditItemSchema = {
    type: 'object',
    required: ['file', 'issues'],
    additionalProperties: false,
    properties: {
      file: { type: 'string', minLength: 1 },
      issues: { type: 'integer', minimum: 0 },
    },
  };
  const summarySchema = {
    type: 'object',
    required: ['totalFiles', 'totalIssues'],
    additionalProperties: false,
    properties: {
      totalFiles: { type: 'integer', minimum: 1 },
      totalIssues: { type: 'integer', minimum: 0 },
    },
  };

  const compiled = workflow.compileFactoryFanoutWorkflow({
    organizationId: org.id,
    projectId: org.projectId,
    objective: '3-stage audit fan-out',
    accessMode: 'read',
    allowedPaths: ['src'],
    maxCost: 5,
    maxConcurrency: 2,
    phases: [
      workflow.phase('discover', [{ key: 'list_targets', prompt: 'List targets in src', accessMode: 'read' }], {
        outputSchema: {
          type: 'object',
          required: ['count'],
          additionalProperties: false,
          properties: { count: { type: 'integer', minimum: 1 } },
        },
      }),
      workflow.phase(
        'audit',
        workflow.parallel(
          ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js'],
          (file, idx) => ({
            key: `audit_${idx}`,
            prompt: `Audit ${file}`,
            accessMode: 'read',
            allowedPaths: [file],
          }),
          { name: 'audit_files', maxConcurrency: 2, outputSchema: auditItemSchema },
        ),
      ),
      workflow.phase('aggregate', [{ key: 'summarize', prompt: 'Aggregate audit findings', accessMode: 'read' }], {
        outputSchema: summarySchema,
      }),
    ],
  });
  a.equal(compiled.workItems.length, 7);
  a.equal(compiled.phases.length, 3);
  a.deepEqual(compiled.workItems[1].dependencies, [{ predecessorKey: 'list_targets', milestone: 'accepted' }]);
  a.equal(compiled.workItems[6].dependencies.length, 5);
  a.equal(compiled.workItems[6].inputFromKeys.length, 5);

  // Pipeline compiles sequential inputFromKeys cleanly
  const pipeCompiled = workflow.compileFactoryFanoutWorkflow({
    organizationId: org.id,
    projectId: org.projectId,
    objective: '2-stage sequential pipeline',
    allowedPaths: ['src'],
    pipeline: workflow.pipeline([
      { key: 'stage_extract', prompt: 'Extract symbols', accessMode: 'read' },
      { key: 'stage_verify', prompt: 'Verify symbols', accessMode: 'read' },
    ]),
  });
  a.equal(pipeCompiled.workItems.length, 2);
  a.deepEqual(pipeCompiled.workItems[1].dependencies, [{ predecessorKey: 'stage_extract', milestone: 'accepted' }]);
  a.deepEqual(pipeCompiled.workItems[1].inputFromKeys, ['stage_extract']);

  // Parallel writer path overlap rejected
  a.throws(
    () => workflow.parallel(
      ['src', 'src/sub.js'],
      (p, i) => ({ key: `w_${i}`, prompt: `Edit ${p}`, accessMode: 'write', allowedPaths: [p] }),
    ),
    { code: 'FANOUT_WRITER_PATH_OVERLAP' },
  );
  // Disjoint parallel writers allowed under write caller ceiling
  const disjointWrite = workflow.compileFactoryFanoutWorkflow({
    organizationId: org.id,
    projectId: org.projectId,
    objective: 'Disjoint writer fanout',
    accessMode: 'write',
    allowedPaths: ['src'],
    phases: [
      workflow.phase('patch', workflow.parallel(
        ['src/a.js', 'src/b.js'],
        (file, idx) => ({ key: `patch_${idx}`, prompt: `Patch ${file}`, accessMode: 'write', allowedPaths: [file] }),
      )),
    ],
  });
  a.equal(disjointWrite.workItems.length, 2);

  // Strict no-privilege-escalation enforcement
  a.throws(
    () => workflow.compileFactoryFanoutWorkflow({
      organizationId: org.id,
      projectId: org.projectId,
      objective: 'Escalate write under read ceiling',
      accessMode: 'read',
      allowedPaths: ['src'],
      phases: [workflow.phase('p', [{ key: 'w1', prompt: 'Write', accessMode: 'write', allowedPaths: ['src/a.js'] }])],
    }),
    { code: 'FANOUT_PRIVILEGE_ESCALATION', statusCode: 403 },
  );
  a.throws(
    () => workflow.compileFactoryFanoutWorkflow({
      organizationId: org.id,
      projectId: org.projectId,
      objective: 'Escalate outside allowedPaths',
      accessMode: 'read',
      allowedPaths: ['src'],
      phases: [workflow.phase('p', [{ key: 'r1', prompt: 'Read secrets', accessMode: 'read', allowedPaths: ['secrets/env'] }])],
    }),
    { code: 'FANOUT_PRIVILEGE_ESCALATION', statusCode: 403 },
  );
  a.throws(
    () => workflow.compileFactoryFanoutWorkflow({
      organizationId: org.id,
      projectId: org.projectId,
      objective: 'Escalate maxCost above callerPolicy',
      allowedPaths: ['src'],
      callerPolicy: { maxCost: 2, maxRuns: 5, maxConcurrency: 2 },
      maxCost: 10,
      phases: [workflow.phase('p', [{ key: 'r1', prompt: 'Step' }])],
    }),
    { code: 'FANOUT_PRIVILEGE_ESCALATION', statusCode: 403 },
  );
  a.throws(
    () => workflow.compileFactoryFanoutWorkflow({
      organizationId: org.id,
      projectId: org.projectId,
      objective: 'Escalate run count above callerPolicy',
      allowedPaths: ['src'],
      callerPolicy: { maxRuns: 2 },
      phases: [workflow.phase('p', workflow.parallel(['a', 'b', 'c'], (x, i) => ({ key: `s_${i}`, prompt: x })))],
    }),
    { code: 'FANOUT_PRIVILEGE_ESCALATION', statusCode: 403 },
  );

  // Instantiate fanout workflow in SQLite + idempotent replay check
  const inst = await workflow.instantiateFactoryFanoutWorkflow({
    organizationId: org.id,
    projectId: org.projectId,
    objective: 'Instantiate fanout graph',
    allowedPaths: ['src'],
    commandId: 'cmd-fanout-inst-1',
    idempotencyKey: 'idem-fanout-inst-1',
    phases: [
      workflow.phase('s0', [{ key: 'first', prompt: 'First' }]),
      workflow.phase('s1', [{ key: 'second', prompt: 'Second' }]),
    ],
  }, ownerActor);
  a.equal(inst.items.length, 2);
  a.equal(inst.items[0].contract.phaseKey, 's0');
  const instReplay = await workflow.instantiateFactoryFanoutWorkflow({
    organizationId: org.id,
    projectId: org.projectId,
    objective: 'Instantiate fanout graph',
    allowedPaths: ['src'],
    commandId: 'cmd-fanout-inst-2',
    idempotencyKey: 'idem-fanout-inst-1',
    phases: [
      workflow.phase('s0', [{ key: 'first', prompt: 'First' }]),
      workflow.phase('s1', [{ key: 'second', prompt: 'Second' }]),
    ],
  }, ownerActor);
  a.equal(instReplay.replayed, true);

  // 3. validateFanoutStepOutput fail-closed JSON Schema assertions
  const validObj = executor.validateFanoutStepOutput({ file: 'src/a.js', issues: 2 }, auditItemSchema);
  a.deepEqual(validObj, { file: 'src/a.js', issues: 2 });
  a.throws(
    () => executor.validateFanoutStepOutput({ file: 'src/a.js', issues: 1.5 }, auditItemSchema),
    { code: 'FANOUT_SCHEMA_VALIDATION_FAILED', statusCode: 422 },
  );
  a.throws(
    () => executor.validateFanoutStepOutput({ file: 'src/a.js' }, auditItemSchema),
    { code: 'FANOUT_SCHEMA_VALIDATION_FAILED', statusCode: 422 },
  );
  a.throws(
    () => executor.validateFanoutStepOutput({ file: 'src/a.js', issues: 0, extra: true }, auditItemSchema),
    { code: 'FANOUT_SCHEMA_VALIDATION_FAILED', statusCode: 422 },
  );
  const extracted = executor.extractStructuredJsonFromText('Here is result:\n```json\n{"file":"src/a.js","issues":1}\n```');
  a.deepEqual(extracted, { file: 'src/a.js', issues: 1 });
  a.throws(
    () => executor.extractStructuredJsonFromText('Not valid json at all'),
    { code: 'FANOUT_SCHEMA_VALIDATION_FAILED', statusCode: 422 },
  );

  // 4. executeFactoryFanout: bounded concurrency, deterministic ordering, stage pipeline dataflow, ResultPackets, governor, zero board chatter
  let activeParallel = 0;
  let maxObservedParallel = 0;
  const execSpec = {
    organizationId: org.id,
    projectId: org.projectId,
    objective: 'Execute bounded 3-phase fanout audit',
    accessMode: 'read',
    allowedPaths: ['src'],
    maxCost: 5,
    maxConcurrency: 2,
    actor: ownerActor,
    phases: [
      workflow.phase('discover', [{ key: 'discover_step', prompt: 'Count target files' }], {
        outputSchema: {
          type: 'object',
          required: ['count'],
          additionalProperties: false,
          properties: { count: { type: 'integer', minimum: 1 } },
        },
      }),
      workflow.phase(
        'audit',
        workflow.parallel(
          ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js'],
          (file, index) => ({ key: `audit_${index}`, prompt: `Audit ${file}`, allowedPaths: [file] }),
          { name: 'audit_batch', maxConcurrency: 2, outputSchema: auditItemSchema },
        ),
      ),
      workflow.phase('aggregate', [{ key: 'agg_step', prompt: 'Summarize audit findings' }], {
        outputSchema: summarySchema,
      }),
    ],
  };

  const execResult = await executor.executeFactoryFanout({
    runStep: async ({ key, item, index, phaseKey, upstreamOutputs }) => {
      if (phaseKey === 'discover') {
        return {
          rawText: '{"count": 5}',
          usage: { inputTokens: 100, outputTokens: 20, thoughtTokens: 10, totalTokens: 130, cost: 0.01 },
        };
      }
      if (phaseKey === 'audit') {
        activeParallel += 1;
        maxObservedParallel = Math.max(maxObservedParallel, activeParallel);
        try {
          // Make earlier items slower so completion order would invert without deterministic ordering
          await new Promise((r) => setTimeout(r, (5 - index) * 15));
          return {
            output: { file: item, issues: index + 1 },
            usage: { inputTokens: 200, outputTokens: 50, thoughtTokens: 30, totalTokens: 280, cost: 0.02 },
          };
        } finally {
          activeParallel -= 1;
        }
      }
      // aggregate phase receives all 5 deterministic upstream audit outputs
      const totalIssues = Object.values(upstreamOutputs).reduce((sum, v) => sum + v.issues, 0);
      return {
        output: { totalFiles: Object.keys(upstreamOutputs).length, totalIssues },
        usage: { inputTokens: 150, outputTokens: 30, thoughtTokens: 15, totalTokens: 195, cost: 0.015 },
      };
    },
  }, execSpec);

  a.equal(execResult.status, 'completed');
  a.equal(maxObservedParallel, 2, 'parallel batch must honor maxConcurrency=2');
  a.equal(execResult.metrics.totalRuns, 7);
  a.deepEqual(execResult.metrics.usage, {
    inputTokens: 100 + (5 * 200) + 150,
    outputTokens: 20 + (5 * 50) + 30,
    thoughtTokens: 10 + (5 * 30) + 15,
    totalTokens: 130 + (5 * 280) + 195,
  });
  a.deepEqual(
    execResult.phases[1].outputs.map((o) => o.file),
    ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js'],
    'parallel outputs preserved in deterministic item order despite reversed completion latency',
  );
  a.deepEqual(execResult.aggregatedOutput, { totalFiles: 5, totalIssues: 15 });
  a.equal(execResult.packetIds.length, 7);
  a.ok(execResult.aggregatedPacketId);
  const storedCheckpoint = await resultPackets.getResultPacket(execResult.aggregatedPacketId);
  a.equal(storedCheckpoint.kind, 'project_checkpoint');
  a.deepEqual(storedCheckpoint.parentPacketIds.sort(), [...execResult.packetIds].sort());

  // Governor counter settled with zero lingering reservations
  const counter = await governor.getBudgetCounter(org.id, org.currentRevision);
  a.equal(counter.totals.runs, 7);
  a.equal(counter.totals.tokens, execResult.metrics.usage.totalTokens);
  a.equal(counter.reserved.runs, 0);

  // Zero board chatter
  const boardCheck = await boardStore.readBoardMessages({ organizationId: org.id });
  a.equal(boardCheck.messages.length, 0, 'fan-out must emit zero board messages');

  // Pipeline stage dataflow + executeAgyPrompt stats extraction
  const pipeExec = await executor.executeFactoryFanout({
    executeAgyPrompt: async (prompt) => {
      if (prompt.includes('Stage zero extract')) {
        return {
          response: '```json\n{"items":["a","b"]}\n```',
          stats: {
            models: {
              'gemini-3.8-flash': { tokens: { input: 40, candidates: 12, thoughts: 5, total: 57 } },
            },
          },
        };
      }
      a.ok(prompt.includes('"items": [\n      "a",\n      "b"\n    ]') || prompt.includes('"items"'));
      return {
        response: '{"count":2}',
        usage: { inputTokens: 30, outputTokens: 10, thoughtTokens: 4, totalTokens: 44 },
      };
    },
  }, {
    organizationId: org.id,
    projectId: org.projectId,
    objective: 'Pipeline agy-cli dataflow test',
    allowedPaths: ['src'],
    actor: ownerActor,
    pipeline: workflow.pipeline([
      {
        key: 'stage_zero',
        prompt: 'Stage zero extract',
        outputSchema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'string' } } } },
      },
      {
        key: 'stage_one',
        prompt: 'Stage one count',
        outputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } },
      },
    ]),
  });
  a.equal(pipeExec.status, 'completed');
  a.deepEqual(pipeExec.aggregatedOutput, { count: 2 });
  a.deepEqual(pipeExec.metrics.usage, { inputTokens: 70, outputTokens: 22, thoughtTokens: 9, totalTokens: 101 });

  // Fail-closed on schema error in phase 0 -> phase 1 never executes, reservation released
  let downstreamInvoked = false;
  await a.rejects(
    () => executor.executeFactoryFanout({
      runStep: async ({ phaseKey }) => {
        if (phaseKey === 'discover') {
          return { output: { wrong: true }, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
        }
        downstreamInvoked = true;
        return { output: { ok: true } };
      },
    }, {
      organizationId: org.id,
      projectId: org.projectId,
      objective: 'Schema failure barrier test',
      allowedPaths: ['src'],
      actor: ownerActor,
      phases: [
        workflow.phase('discover', [{ key: 'd1', prompt: 'Discover' }], {
          outputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } },
        }),
        workflow.phase('downstream', [{ key: 's1', prompt: 'Should never run' }]),
      ],
    }),
    { code: 'FANOUT_SCHEMA_VALIDATION_FAILED', statusCode: 422 },
  );
  a.equal(downstreamInvoked, false, 'downstream phase must not run after upstream schema failure');
  const counterAfterFail = await governor.getBudgetCounter(org.id, org.currentRevision);
  a.equal(counterAfterFail.reserved.runs, 0);

  // 5. HTTP routes: POST/GET fanout, auth & capability isolation
  const runCapBlocked = await callFactoryRoute({
    method: 'POST',
    path: `/api/organizations/${org.id}/factory/workflows/fanout`,
    authSession: { role: 'owner', principalKind: 'run_capability', sessionId: 'sess-x', organizationMessageScope: { organizationId: org.id } },
    body: { mode: 'preview', projectId: org.projectId, objective: 'Blocked run cap', phases: [{ kind: 'phase', name: 'p', steps: [{ prompt: 'x' }] }] },
  });
  a.equal(runCapBlocked.statusCode, 403);

  const nonOwnerBlocked = await callFactoryRoute({
    method: 'GET',
    path: `/api/organizations/${org.id}/factory/workflows/fanout/${execResult.workflowId}`,
    authSession: { role: 'member', principalId: 'user-2' },
  });
  a.equal(nonOwnerBlocked.statusCode, 403);

  const csrfBlocked = await callFactoryRoute({
    method: 'POST',
    path: `/api/organizations/${org.id}/factory/workflows/fanout`,
    authSession: { role: 'owner', principalId: 'owner-fanout-1' },
    headers: { 'sec-fetch-site': 'cross-site' },
    body: { mode: 'preview', projectId: org.projectId, objective: 'CSRF check', phases: [{ kind: 'phase', name: 'p', steps: [{ prompt: 'x' }] }] },
  });
  a.equal(csrfBlocked.statusCode, 403);

  const previewRes = await callFactoryRoute({
    method: 'POST',
    path: `/api/organizations/${org.id}/factory/workflows/fanout`,
    authSession: { role: 'owner', principalId: 'owner-fanout-1' },
    body: {
      mode: 'preview',
      projectId: org.projectId,
      objective: 'Declarative HTTP preview',
      allowedPaths: ['src'],
      phases: [
        {
          kind: 'phase',
          name: 'scan',
          steps: [
            {
              kind: 'parallel',
              name: 'item',
              items: ['src/x.js', 'src/y.js'],
              maxConcurrency: 2,
              itemTemplate: { prompt: 'Check {{item}} (#{{index}})', allowedPaths: ['{{item}}'] },
            },
          ],
        },
      ],
    },
  });
  a.equal(previewRes.statusCode, 200);
  a.equal(previewRes.payload.proposal.workItems.length, 2);
  a.equal(previewRes.payload.proposal.workItems[0].contract.prompt, 'Check src/x.js (#0)');

  const getRes = await callFactoryRoute({
    method: 'GET',
    path: `/api/organizations/${org.id}/factory/workflows/fanout/${execResult.workflowId}`,
    authSession: { role: 'owner', principalId: 'owner-fanout-1' },
  });
  a.equal(getRes.statusCode, 200);
  a.equal(getRes.payload.workflowId, execResult.workflowId);
  a.deepEqual(getRes.payload.aggregatedOutput, { totalFiles: 5, totalIssues: 15 });

  const listRes = await callFactoryRoute({
    method: 'GET',
    path: `/api/organizations/${org.id}/factory/workflows/fanout`,
    authSession: { role: 'owner', principalId: 'owner-fanout-1' },
  });
  a.equal(listRes.statusCode, 200);
  a.ok(listRes.payload.workflows.some((w) => w.workflowId === execResult.workflowId));

  // Cross-org lookup isolated fail-closed 404
  const crossOrgGet = await callFactoryRoute({
    method: 'GET',
    path: `/api/organizations/${otherOrg.id}/factory/workflows/fanout/${execResult.workflowId}`,
    authSession: { role: 'owner', principalId: 'owner-fanout-1' },
  });
  a.equal(crossOrgGet.statusCode, 404);
  a.equal(crossOrgGet.payload.code, 'FANOUT_WORKFLOW_NOT_FOUND');

  // Enabled POST executes fanout path (refusing missing runtime cleanly with 400 FANOUT_RUNNER_MISSING, ignoring injected deps)
  const enabledExec = await callFactoryRoute({
    method: 'POST',
    path: `/api/organizations/${org.id}/factory/workflows/fanout`,
    authSession: { role: 'owner', principalId: 'owner-fanout-1' },
    body: { projectId: org.projectId, objective: 'Exec route', phases: [{ kind: 'phase', name: 'p', steps: [{ prompt: 'x' }] }] },
  });
  a.equal(enabledExec.statusCode, 400);
  a.equal(enabledExec.payload.code, 'FANOUT_RUNNER_MISSING');

  // Factory control disabled refuses non-preview POST
  const prevCtrl = process.env.RAGENT_FACTORY_CONTROL_ENABLED;
  process.env.RAGENT_FACTORY_CONTROL_ENABLED = '0';
  try {
    const disabledExec = await callFactoryRoute({
      method: 'POST',
      path: `/api/organizations/${org.id}/factory/workflows/fanout`,
      authSession: { role: 'owner', principalId: 'owner-fanout-1' },
      body: { projectId: org.projectId, objective: 'Blocked exec', phases: [{ kind: 'phase', name: 'p', steps: [{ prompt: 'x' }] }] },
    });
    a.equal(disabledExec.statusCode, 503);
    a.equal(disabledExec.payload.code, 'FACTORY_CONTROL_DISABLED');
  } finally {
    process.env.RAGENT_FACTORY_CONTROL_ENABLED = prevCtrl;
  }

  // 6. Audit security & correctness regressions (#131)
  // 6a. Cross-org & duplicate workflowId overwrite rejected fail-closed (409)
  await a.rejects(
    () => executor.executeFactoryFanout(
      { runStep: async () => ({ output: { hacked: true } }) },
      {
        workflowId: execResult.workflowId,
        organizationId: otherOrg.id,
        projectId: otherOrg.projectId,
        objective: 'Cross-org overwrite attempt',
        phases: [workflow.phase('p', [{ prompt: 'attempt' }])],
      },
    ),
    { code: 'FACTORY_CONFLICT', statusCode: 409 },
  );
  const intactOrgA = await executor.getFactoryFanoutWorkflowExecution(org.id, execResult.workflowId);
  a.deepEqual(intactOrgA.aggregatedOutput, { totalFiles: 5, totalIssues: 15 });

  await a.rejects(
    () => executor.executeFactoryFanout(
      { runStep: async () => ({ output: { ok: true } }) },
      {
        workflowId: execResult.workflowId,
        organizationId: org.id,
        projectId: org.projectId,
        objective: 'Same-org completed overwrite attempt',
        phases: [workflow.phase('p', [{ prompt: 'attempt' }])],
      },
    ),
    { code: 'FACTORY_CONFLICT', statusCode: 409 },
  );

  // 6b. HTTP body stripping (spoofed callerPolicy, cwd, org.projectId mismatch)
  const projMismatchHttp = await callFactoryRoute({
    method: 'POST',
    path: `/api/organizations/${org.id}/factory/workflows/fanout`,
    authSession: { role: 'owner', principalId: 'owner-fanout-1' },
    body: {
      mode: 'preview',
      projectId: 'wrong-proj',
      objective: 'Mismatched project',
      phases: [{ kind: 'phase', name: 'p', steps: [{ prompt: 'x' }] }],
    },
  });
  a.equal(projMismatchHttp.statusCode, 409);
  a.equal(projMismatchHttp.payload.code, 'FACTORY_CONFLICT');

  const spoofedCallerPolicyHttp = await callFactoryRoute({
    method: 'POST',
    path: `/api/organizations/${org.id}/factory/workflows/fanout`,
    authSession: { role: 'owner', principalId: 'owner-fanout-1' },
    body: {
      mode: 'preview',
      projectId: org.projectId,
      objective: 'Spoof callerPolicy',
      allowedPaths: ['src'],
      callerPolicy: { accessMode: 'write', allowedPaths: ['secrets'] },
      cwd: 'C:\\Windows',
      runtime: { cwd: 'C:\\Windows', tool: 'agy' },
      phases: [{ kind: 'phase', name: 'p', steps: [{ prompt: 'write', accessMode: 'write', allowedPaths: ['secrets/x'] }] }],
    },
  });
  a.equal(spoofedCallerPolicyHttp.statusCode, 403);
  a.equal(spoofedCallerPolicyHttp.payload.code, 'FANOUT_PRIVILEGE_ESCALATION');

  // 6c. Registered project cwd containment check (resolveRealRoot + scopeContainsPath)
  const projRootDir = join(tempRoot, 'registered-proj');
  const projSubDir = join(projRootDir, 'sub');
  const outsideDir = join(tempRoot, 'outside-dir');
  mkdirSync(projSubDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  const realProj = await projects.createProject({ name: 'fanout-proj', rootPath: projRootDir });
  const projOrg = await orgStore.createOrganization({
    rootSessionId: 'root-fanout-proj',
    projectId: realProj.id,
    currentRevision: 1,
    budget: { agents: 4, runs: 20, tokens: 50000, cost: 20 },
  });
  await a.rejects(
    () => executor.executeFactoryFanout(
      { runStep: async () => ({ output: { ok: true } }) },
      {
        organizationId: projOrg.id,
        projectId: realProj.id,
        objective: 'Outside cwd escape attempt',
        cwd: outsideDir,
        phases: [workflow.phase('p', [{ prompt: 'x' }])],
      },
    ),
    { code: 'PROJECT_SCOPE_ESCAPE', statusCode: 403 },
  );
  const insideCwdRes = await executor.executeFactoryFanout(
    { runStep: async () => ({ output: { ok: true } }) },
    {
      organizationId: projOrg.id,
      projectId: realProj.id,
      objective: 'Inside subdirectory cwd allowed',
      cwd: projSubDir,
      phases: [workflow.phase('p', [{ prompt: 'x' }])],
    },
  );
  a.equal(insideCwdRes.status, 'completed');

  // 6d. callerPolicy.allowedPaths cannot be bypassed by resource.readScope='entire_project'
  a.throws(
    () => workflow.compileFactoryFanoutWorkflow({
      organizationId: org.id,
      projectId: org.projectId,
      objective: 'Bypass callerPolicy.allowedPaths via resource',
      callerPolicy: { allowedPaths: ['src'] },
      resource: { projectId: org.projectId, readScope: 'entire_project', networkPolicy: 'deny' },
      phases: [workflow.phase('p', [{ prompt: 'Read secret', accessMode: 'read', allowedPaths: ['secrets/key'] }])],
    }),
    { code: 'FANOUT_PRIVILEGE_ESCALATION', statusCode: 403 },
  );

  // 6e. validateFanoutStepOutput enforces implied types when schema.type is omitted
  for (const [val, schema] of [
    ['plain string', { required: ['a'] }],
    [['x'], { properties: { a: { type: 'string' } } }],
    [{ a: 1 }, { additionalProperties: false }],
    ['not-array', { items: { type: 'string' } }],
    [42, { minLength: 2 }],
    ['42', { minimum: 1 }],
  ]) {
    a.throws(
      () => executor.validateFanoutStepOutput(val, schema),
      { code: 'FANOUT_SCHEMA_VALIDATION_FAILED', statusCode: 422 },
    );
  }

  // 6f. runViaRagentSession reads run.usage & omits legacy internalOperation
  const capturedSendOptions = [];
  const sessionExec = await executor.executeFactoryFanout({
    createSession: async (folder, tool, name) => ({ id: 'sess_fanout_usage_1', folder, tool, name }),
    sendMessage: async (sessionId, prompt, images, options) => {
      capturedSendOptions.push(options);
      return { run: { id: 'run_fanout_usage_1' } };
    },
    getRun: async (runId) => ({
      id: runId,
      sessionId: 'sess_fanout_usage_1',
      requestId: 'req_u1',
      state: 'completed',
      finalizedAt: new Date().toISOString(),
      usage: { inputTokens: 111, outputTokens: 22, reasoningTokens: 9, costUsd: 0.005 },
    }),
    getRunResult: async () => ({ summary: '{"ok":true}' }),
    getHistory: async () => [],
  }, {
    organizationId: projOrg.id,
    projectId: realProj.id,
    objective: 'Run usage extraction test',
    runtime: { tool: 'agy', runtimeFamily: 'agy-acp', model: 'gemini-3.8-flash', effort: 'low' },
    phases: [
      workflow.phase('p', [{ key: 'u1', prompt: 'Check usage' }], {
        outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
      }),
    ],
  });
  a.equal(sessionExec.status, 'completed');
  a.equal(Object.hasOwn(capturedSendOptions[0], 'internalOperation'), false, 'must stay project-bound instead of legacy internalOperation');
  a.deepEqual(sessionExec.metrics.usage, { inputTokens: 111, outputTokens: 22, thoughtTokens: 9, totalTokens: 142 });

  // 6g. Live Wave 3B regressions (#141): envelope-tag stripping, loadHistory/spool fallback, cachedReadTokens/totalTokens
  const strippedPacket = executor.extractStructuredJsonFromText(
    '{"file":"src/beta.mjs","exports":1,"todos":2}\n' +
    '<ragent-result-packet>{"summary":"done","status":"succeeded"}</ragent-result-packet>\n' +
    '<ragent-session-labels>{"title":"beta"}</ragent-session-labels>',
  );
  a.deepEqual(strippedPacket, { file: 'src/beta.mjs', exports: 1, todos: 2 });

  // Without deps.getHistory (uses real historyMod.loadHistory safely), empty summary/message_start -> falls back to spool chunks + ragent-prompt usage
  const spoolExec = await executor.executeFactoryFanout({
    createSession: async (folder, tool, name) => ({ id: 'sess_fanout_spool_1', folder, tool, name }),
    sendMessage: async () => ({ run: { id: 'run_fanout_spool_1' } }),
    getRun: async (runId) => ({
      id: runId,
      sessionId: 'sess_fanout_spool_1',
      requestId: 'req_sp1',
      state: 'completed',
      finalizedAt: new Date().toISOString(),
      usage: { inputTokens: 22661, outputTokens: 219, cachedInputTokens: 18379, reasoningTokens: 0 },
    }),
    getRunResult: async () => ({ completedAt: new Date().toISOString(), exitCode: 0, signal: null, cancelled: false, providerTerminalSeen: true }),
    readRunSpoolRecords: async () => [
      { json: { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"file":"src/beta.mjs",' } } } } },
      { json: { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '"exports":1,"todos":2}\n<ragent-result-packet>{"ok":true}</ragent-result-packet>' } } } } },
      { json: { id: 'ragent-prompt', result: { stopReason: 'end_turn', usage: { inputTokens: 22661, outputTokens: 219, cachedReadTokens: 18379, thoughtTokens: 0, totalTokens: 41259 } } } },
    ],
  }, {
    organizationId: projOrg.id,
    projectId: realProj.id,
    objective: 'Live spool chunk & envelope tag extraction test',
    runtime: { tool: 'agy', runtimeFamily: 'agy-acp', model: 'gemini-3.8-flash', effort: 'low' },
    phases: [
      workflow.phase('p', [{ key: 'sp1', prompt: 'Audit beta.mjs' }], {
        outputSchema: {
          type: 'object',
          required: ['file', 'exports', 'todos'],
          additionalProperties: false,
          properties: {
            file: { type: 'string' },
            exports: { type: 'integer' },
            todos: { type: 'integer' },
          },
        },
      }),
    ],
  });
  a.equal(spoolExec.status, 'completed');
  a.deepEqual(spoolExec.aggregatedOutput, { file: 'src/beta.mjs', exports: 1, todos: 2 });
  a.deepEqual(spoolExec.metrics.usage, { inputTokens: 22661, outputTokens: 219, thoughtTokens: 0, totalTokens: 41259 });

  // Also verify cachedInputTokens sums into totalTokens when explicit totalTokens is absent from both run.usage and spool
  const cachedFallbackExec = await executor.executeFactoryFanout({
    createSession: async (folder, tool, name) => ({ id: 'sess_fanout_spool_2', folder, tool, name }),
    sendMessage: async () => ({ run: { id: 'run_fanout_spool_2' } }),
    getRun: async (runId) => ({
      id: runId,
      sessionId: 'sess_fanout_spool_2',
      requestId: 'req_sp2',
      state: 'completed',
      finalizedAt: new Date().toISOString(),
      usage: { inputTokens: 1000, outputTokens: 50, cachedInputTokens: 500, reasoningTokens: 10 },
    }),
    getRunResult: async () => ({}),
    getHistory: async () => [{ type: 'message_start', role: 'assistant', text: '', content: '' }],
    readRunSpoolRecords: async () => [
      { json: { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: '{"ok":true}' } } } },
    ],
  }, {
    organizationId: projOrg.id,
    projectId: realProj.id,
    objective: 'Cached input tokens fallback sum test',
    runtime: { tool: 'agy', runtimeFamily: 'agy-acp' },
    phases: [
      workflow.phase('p', [{ key: 'sp2', prompt: 'Check' }], {
        outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
      }),
    ],
  });
  a.deepEqual(cachedFallbackExec.metrics.usage, { inputTokens: 1000, outputTokens: 50, thoughtTokens: 10, totalTokens: 1560 });
}

try {
  await runTests();
  console.log(`test-factory-workflow-fanout: ok (${assertionCount} assertions)`);
} finally {
  await resultPackets.closeResultPacketStore().catch(() => {});
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
