#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-collaboration-leader-ingress-'));
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_COLLABORATION_LEADER_ENABLED = '1';

const ingress = await import('../chat/collaboration-leader-ingress.mjs');

const root = {
  id: 'root-leader-ingress',
  sessionClass: 'ROOT_LEADERSHIP',
  sessionPlane: 'user',
  userAddressable: true,
  projectId: 'project-1',
};
const plan = {
  schemaVersion: 1,
  idempotencyKey: 'plan-1',
  title: 'Bounded collaboration',
  plan: {
    workspacePolicy: 'shared-exclusive',
    gates: { independentReview: false },
    tasks: [{
      id: 'task-1',
      objective: 'Inspect the target files',
      agentId: 'worker-1',
      role: 'specialist',
      acceptance: ['report evidence'],
      writablePaths: [],
    }],
  },
};
const marked = `${ingress.COLLABORATION_PLAN_START}\n${JSON.stringify(plan)}\n${ingress.COLLABORATION_PLAN_END}`;

assert.deepEqual(ingress.extractCollaborationPlan(`prefix ${marked} suffix`), plan);
assert.equal(ingress.extractCollaborationPlan('ordinary reply'), null);
assert.throws(
  () => ingress.extractCollaborationPlan(`${ingress.COLLABORATION_PLAN_START}{"idempotencyKey":"x"}`),
  (error) => error.code === ingress.COLLABORATION_PLAN_REJECTED && error.reason === 'missing_end_marker',
);
assert.throws(
  () => ingress.normalizePlanEnvelope({ idempotencyKey: 'bad key', plan: { tasks: [{}] } }),
  (error) => error.reason === 'idempotency_key_required',
);
assert.throws(
  () => ingress.normalizePlanEnvelope({ idempotencyKey: 'x'.repeat(201), plan: { tasks: [{}] } }),
  (error) => error.reason === 'idempotency_key_required',
);

const calls = [];
const orchestrator = {
  validate: async (input) => ({
    valid: true,
    rootSessionId: input.rootSessionId,
    projectId: input.projectId,
    plan: input.plan,
    policy: { revision: 'test', maxConcurrent: 1 },
  }),
  dispatch: async (input) => {
    calls.push(input);
    return {
      id: 'collaboration-1',
      state: 'running',
      tasks: [{ id: 'task-1' }],
      events: [{ type: 'plan_frozen' }],
    };
  },
};
const accepted = await ingress.processCollaborationPlan({ session: root, assistantText: marked, orchestrator });
assert.equal(accepted.state, 'running');
assert.equal(accepted.collaborationId, 'collaboration-1');
assert.equal(accepted.taskCount, 1);
assert.equal(calls.length, 1);
assert.equal(calls[0].rootSessionId, root.id);
assert.equal(calls[0].projectId, root.projectId);
assert.match(calls[0].idempotencyKey, /^leader:root-leader-ingress:plan-1$/);
assert.equal(calls[0].plan.tasks[0].agentId, 'worker-1');

const turnBound = await ingress.processCollaborationPlan({
  session: root,
  assistantText: marked,
  turnId: 'run-turn-1',
  orchestrator,
});
assert.equal(turnBound.idempotencyKey, 'leader:root-leader-ingress:turn:run-turn-1:plan-1');
assert.equal(calls[1].idempotencyKey, turnBound.idempotencyKey);

const rejectedRoot = await ingress.processCollaborationPlan({
  session: { ...root, sessionClass: 'WORKER' },
  assistantText: marked,
  orchestrator,
});
assert.equal(rejectedRoot.attempted, false);
assert.equal(calls.length, 2, 'non-root sessions cannot dispatch a collaboration');

const rejectedPlan = await ingress.processCollaborationPlan({
  session: root,
  assistantText: `${ingress.COLLABORATION_PLAN_START}{"idempotencyKey":"bad key","plan":{"tasks":[{}]}}${ingress.COLLABORATION_PLAN_END}`,
  orchestrator,
});
assert.equal(rejectedPlan.state, 'rejected');
assert.equal(rejectedPlan.reason, 'idempotency_key_required');
assert.equal(calls.length, 2);

const context = await ingress.buildCollaborationLeaderTurnContext({
  session: root,
  apps: [{
    id: 'worker-1',
    name: 'Worker one',
    role: 'specialist',
    tool: '',
    collaborationPolicy: {
      role: 'specialist',
      canDelegate: false,
      runtimePolicy: {
        allowedProvidersByTool: { claude: ['provider-child'] },
        allowedModelsByTool: { claude: ['sonnet@provider-child'] },
        allowedEffortsByTool: { claude: ['high'] },
      },
    },
  }, {
    id: 'legacy-worker-1',
    name: 'Legacy worker one',
    tool: '',
  }],
});
assert.match(context, /Durable Collaboration Plan Ingress/);
assert.match(context, /worker-1/);
assert.match(context, /legacy-worker-1/, 'legacy Agent without a policy remains globally visible');
assert.match(context, /"roleSource": "default"/, 'legacy Agent exposes its default role source');
assert.match(context, /ragent-collaboration-plan/);
assert.match(context, /allowedProvidersByTool/);
assert.match(context, /provider-child/);

console.log('test-collaboration-leader-ingress: ok');
rmSync(configDir, { recursive: true, force: true });
