#!/usr/bin/env node
import assert from 'node:assert/strict';
import { decideClaudeToolApproval } from '../chat/claude-tool-policy.mjs';

function request(toolName, input, extra = {}) {
  return {
    providerMethod: 'can_use_tool',
    requestClass: 'tool_invocation',
    kind: 'permissions',
    params: { tool_name: toolName, input, ...extra },
  };
}

for (const [tool, input] of [
  ['EnterPlanMode', {}],
  ['Skill', { skill: 'reviewing-code', args: 'Check the parser' }],
  ['TaskOutput', { task_id: 'task-123', block: false }],
  ['TaskCreate', { subject: 'Inspect', description: 'Inspect the project', activeForm: 'Inspecting', metadata: { category: 'work' } }],
  ['TaskGet', { taskId: '1' }],
  ['TaskList', {}],
  ['TaskUpdate', { taskId: '1', status: 'in_progress', addBlockedBy: ['2'] }],
  ['TaskUpdate', { taskId: '1', status: 'deleted' }],
  ['TodoWrite', { todos: [{ content: 'Inspect', status: 'in_progress' }] }],
  ['ToolSearch', { query: 'read project files' }],
]) {
  assert.equal(decideClaudeToolApproval(request(tool, input), { riskMode: 'safe' }).decision, 'auto-allow', tool);
}

assert.equal(decideClaudeToolApproval(request('WebSearch', { query: 'Node.js docs' }), { riskMode: 'recommended' }).decision, 'auto-allow');
assert.equal(decideClaudeToolApproval(request('WebSearch', { query: 'Node.js docs' }), { riskMode: 'full-auto' }).decision, 'auto-allow');
assert.equal(decideClaudeToolApproval(request('WebSearch', { query: 'Node.js docs' }), { riskMode: 'conservative-auto' }).decision, 'prompt');
assert.equal(decideClaudeToolApproval(request('WebSearch', { query: 'Node.js docs' }), { riskMode: 'safe' }).decision, 'prompt');
assert.equal(decideClaudeToolApproval(request('WebSearch', { query: 'x', arbitrary: true }), { riskMode: 'recommended' }).decision, 'prompt');
for (const mode of ['recommended', 'full-auto']) {
  for (const [tool, input] of [['TaskCreate', { subject: 'Inspect', description: 'Inspect the project' }],
    ['TaskList', {}], ['TaskGet', { taskId: '1' }], ['TaskUpdate', { taskId: '1', status: 'completed' }]]) {
    assert.equal(decideClaudeToolApproval(request(tool, input), { riskMode: mode }).decision, 'auto-allow', `${tool}: ${mode}`);
  }
  assert.equal(decideClaudeToolApproval(request('WebFetch', { url: 'https://example.org/docs', prompt: 'Read this page' }), { riskMode: mode }).decision, 'auto-allow');
  assert.equal(decideClaudeToolApproval(request('WebFetch', { url: 'file:///secret', prompt: 'Read this file' }), { riskMode: mode }).decision, 'prompt');
}
assert.equal(decideClaudeToolApproval(request('TodoWrite', {}), { riskMode: 'recommended' }).decision, 'prompt');
for (const [tool, input] of [['TaskList', { arbitrary: true }], ['TaskGet', { taskId: '' }], ['TaskCreate', { subject: 'x' }],
  ['TaskUpdate', { taskId: '1', status: 'unknown' }], ['TaskUpdate', { taskId: '1', addBlocks: '2' }],
  ['TaskUpdate', { taskId: '1', arbitrary: true }]]) {
  assert.equal(decideClaudeToolApproval(request(tool, input), { riskMode: 'recommended' }).decision, 'prompt', tool);
}

for (const tool of ['Task', 'Bash', 'PowerShell', 'AskUserQuestion', 'ExitPlanMode', 'mcp__foreign__tool', 'FutureTool']) {
  assert.equal(decideClaudeToolApproval(request(tool, {}), { riskMode: 'recommended' }), null, tool);
}
assert.equal(decideClaudeToolApproval(request('TodoWrite', { todos: [] }, {
  additionalPermissions: { network: true },
}), { riskMode: 'recommended' }), null, 'a capability grant must use the owner path');
assert.equal(decideClaudeToolApproval({ ...request('TodoWrite', { todos: [] }), requestClass: 'capability_grant' }, { riskMode: 'recommended' }), null);

console.log('claude-tool-policy: explicit safe-tool and fail-closed boundary checks passed');
