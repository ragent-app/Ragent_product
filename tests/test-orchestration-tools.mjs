#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-orchestration-tools-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const tools = await import('../chat/orchestration-tools.mjs');
const calls = [];
const orchestrator = {
  validate: async (input) => ({
    valid: true,
    rootSessionId: input.rootSessionId,
    projectId: input.projectId,
    plan: { title: 'normalized', tasks: [{ id: 'task-1', objective: 'work', agentId: 'agent-1' }] },
    policy: { revision: 'policy-1', maxConcurrent: 1 },
  }),
  dispatch: async (input) => {
    calls.push(input);
    return { id: 'collaboration-tool-1', state: 'running', tasks: input.plan.tasks };
  },
};

try {
  const validation = await tools.validateCollaborationPlanTool({
    rootSessionId: 'root-tool-1',
    title: 'untrusted title',
    projectId: 'project-tool-1',
    plan: { tasks: [{ id: 'untrusted' }] },
  }, { orchestrator });
  assert.equal(validation.valid, true);
  assert.ok(validation.validationId);
  assert.equal(calls.length, 0, 'validation has no execution side effect');

  const dispatched = await tools.dispatchValidatedCollaborationPlan({
    validationId: validation.validationId,
  }, { orchestrator });
  assert.equal(dispatched.collaboration.id, 'collaboration-tool-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plan.title, 'normalized', 'dispatch uses persisted normalized plan, not caller JSON');
  assert.equal(calls[0].idempotencyKey, `validated:${validation.validationId}`);

  await tools.dispatchValidatedCollaborationPlan({ validationId: validation.validationId }, { orchestrator });
  assert.equal(calls[1].idempotencyKey, calls[0].idempotencyKey, 'transport retry retains the same dispatch key');
  await assert.rejects(
    () => tools.dispatchValidatedCollaborationPlan({ validationId: 'validation_missing' }, { orchestrator }),
    (error) => error?.code === 'COLLABORATION_VALIDATION_EXPIRED',
  );
  console.log('test-orchestration-tools: ok');
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
