import assert from 'node:assert/strict';
import {
  applyContextPlanToCanonicalContext,
  assembleContextPlan,
} from '../chat/context-attention-assembler.mjs';
import { createToolResultDescriptor } from '../chat/tool-result-descriptor.mjs';

const toolResult = createToolResultDescriptor({
  type: 'tool_result',
  id: 'evt-tool-1',
  seq: 11,
  toolExecutionId: 'tool-1',
  toolName: 'npm test',
  output: 'PASS test-context-attention-assembler',
  exitCode: 0,
});

const canonicalContext = {
  runtimeFamily: 'codex-app-server-json',
  provider: 'codex',
  userText: 'Continue the deterministic session handoff.',
  contextBudget: { maxInputTokens: 4000 },
  sections: {
    continuationContext: '[Assistant]\nThe previous run completed the reducer.',
    managerTurnContext: 'Keep the canonical facts authoritative.',
    goalInstructions: 'Preserve the current goal.',
  },
};
const checkpoint = {
  revision: 11,
  task: {
    goal: { text: 'Make cross-agent handoff deterministic.', sourceRefs: [{ seq: 1 }] },
    status: 'running',
    decisions: [{ id: 'd1', statement: 'Use one canonical checkpoint.', reason: 'Avoid split state.' }],
    nextAction: { text: 'Run the focused contract tests.', sourceRefs: [{ seq: 10 }] },
    blockers: [],
  },
  execution: {
    workspace: { root: '/work/ragent', snapshotRevision: 'ws-1', stale: false },
    files: [{ path: 'chat/context-attention-assembler.mjs', contentHash: 'sha256:file' }],
    validations: [{ id: 'test-1', name: 'npm test:continuity', state: 'passed', exitCode: 0 }],
    approvals: [],
  },
};

const plan = assembleContextPlan({
  canonicalContext,
  checkpoint,
  toolResults: [toolResult],
  recentEvents: [
    { seq: 10, type: 'file_change', filePath: 'chat/context-attention-assembler.mjs', contentHash: 'sha256:file' },
    { seq: 11, type: 'tool_result', toolName: 'npm test', bodyPreview: 'PASS test-context-attention-assembler' },
  ],
  maxInputTokens: 4000,
  outputReserveTokens: 400,
});

assert.equal(plan.schemaVersion, 1);
assert.equal(plan.target.runtimeFamily, 'codex-app-server-json');
assert.ok(plan.items.some((item) => item.type === 'current_request'));
assert.ok(plan.items.some((item) => item.type === 'task_goal'));
assert.ok(plan.items.some((item) => item.type === 'execution_state' || item.type === 'task_state'));
assert.ok(plan.budget.estimatedTokens <= plan.budget.availableTokens);
assert.ok(plan.receipt.includedSourceRefs.some((ref) => ref.seq === 1));
assert.ok(plan.diagnostics.selectedItemCount > 0);

const attentionContext = applyContextPlanToCanonicalContext(canonicalContext, plan);
assert.match(attentionContext.sections.continuationContext, /task_goal|task_state|execution_state|recent_transcript/);
assert.equal(attentionContext.userText, canonicalContext.userText);

assert.throws(
  () => assembleContextPlan({
    canonicalContext: { ...canonicalContext, userText: 'x'.repeat(20_000) },
    checkpoint,
    maxInputTokens: 100,
    outputReserveTokens: 10,
  }),
  (error) => error.code === 'CONTEXT_MANDATORY_OVER_BUDGET',
);

console.log('test-context-attention-assembler: ok');
