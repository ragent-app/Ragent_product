#!/usr/bin/env node
import assert from 'assert/strict';
import {
  buildCodexArgs,
  createCodexAdapter,
} from '../chat/adapters/codex.mjs';
import { planEventModeFields } from '../chat/normalizer.mjs';

const adapter = createCodexAdapter();

const startedEvents = adapter.parseLine(JSON.stringify({
  type: 'item.started',
  item: {
    id: 'plan-test',
    type: 'todo_list',
    items: [
      { text: 'Inspect current behavior', completed: false },
      { text: 'Patch plan rendering', completed: false },
    ],
  },
}));

assert.equal(startedEvents.length, 1, 'todo_list start should emit one normalized event');
assert.equal(startedEvents[0].type, 'plan', 'todo_list start should emit a plan event');
assert.equal(startedEvents[0].planId, 'plan-test');
assert.equal(startedEvents[0].state, 'drafting');
assert.deepEqual(
  startedEvents[0].items,
  [
    { text: 'Inspect current behavior', status: 'pending' },
    { text: 'Patch plan rendering', status: 'pending' },
  ],
);

const completedEvents = adapter.parseLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'plan-test',
    type: 'todo_list',
    items: [
      { text: 'Inspect current behavior', completed: true },
      { text: 'Patch plan rendering', completed: true },
    ],
  },
}));

assert.equal(completedEvents.length, 1, 'todo_list completion should emit one normalized event');
assert.equal(completedEvents[0].type, 'plan');
assert.equal(completedEvents[0].state, 'awaiting_decision');
assert.deepEqual(
  completedEvents[0].items.map((item) => item.status),
  ['completed', 'completed'],
);

assert.deepEqual(
  planEventModeFields(completedEvents[0], { interactionMode: 'agent' }),
  { interactionMode: 'agent', planIntent: 'progress' },
  'agent-mode plan events should be read-only progress',
);
assert.deepEqual(
  planEventModeFields(completedEvents[0], { interactionMode: 'plan' }),
  { interactionMode: 'plan', planIntent: 'progress' },
  'plan-mode update_plan events should remain read-only progress',
);
assert.deepEqual(
  planEventModeFields({
    ...completedEvents[0],
    source: 'codex-app-server',
    planIntent: 'proposal',
  }, { interactionMode: 'plan' }),
  { interactionMode: 'plan', planIntent: 'progress' },
  'legacy app-server progress lists misclassified as proposals should normalize on read',
);
assert.equal(
  planEventModeFields({ source: 'ragent-plan-fallback' }).planIntent,
  'proposal',
  'fallback plan artifacts should remain actionable proposals',
);
assert.equal(
  planEventModeFields({ source: 'codex-app-server', bodyMarkdown: '# Plan' }, { interactionMode: 'plan' }).planIntent,
  'proposal',
  'native formal plan artifacts should remain actionable proposals',
);

const planArgs = buildCodexArgs('Draft a plan.', {
  interactionMode: 'plan',
  developerInstructions: '',
});
assert.ok(
  planArgs.includes('mode=plan'),
  'Codex plan interaction mode should be passed as a CLI config override',
);
assert.deepEqual(
  planArgs.slice(0, 7),
  ['-a', 'never', 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check'],
  'Codex plan mode should use never approval and read-only sandbox before exec options',
);
assert.equal(
  planArgs.includes('--dangerously-bypass-approvals-and-sandbox'),
  false,
  'Codex plan mode must not bypass approvals and sandboxing',
);

const executeArgs = buildCodexArgs('Implement it.', {
  interactionMode: 'agent',
  developerInstructions: '',
});
assert.equal(
  executeArgs.includes('--dangerously-bypass-approvals-and-sandbox'),
  true,
  'ordinary Codex execute mode should keep the existing permission behavior',
);

const readOnlyPermissionArgs = buildCodexArgs('Inspect only.', {
  permissionMode: 'read-only',
  developerInstructions: '',
});
assert.equal(
  readOnlyPermissionArgs.includes('--dangerously-bypass-approvals-and-sandbox'),
  false,
  'explicit Codex read-only permission mode should not bypass approvals and sandboxing',
);
assert.ok(
  readOnlyPermissionArgs.includes('--sandbox') && readOnlyPermissionArgs.includes('read-only'),
  'explicit Codex read-only permission mode should use the read-only sandbox',
);

const workspaceWriteArgs = buildCodexArgs('Edit files.', {
  permissionMode: 'on-request-workspace-write',
  developerInstructions: '',
});
assert.deepEqual(
  workspaceWriteArgs.slice(0, 6),
  ['-a', 'on-request', 'exec', '--json', '--sandbox', 'workspace-write'],
  'Codex approval/sandbox modes should pass through to native CLI flags',
);

console.log('test-codex-plan-events: ok');
