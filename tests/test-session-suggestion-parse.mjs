#!/usr/bin/env node
import assert from 'assert/strict';

import {
  extractStrictFencedJson,
  parseMergedSuggestionResult,
  SUGGESTION_HIDDEN_THINKING_KEYS,
} from '../chat/session-suggestion.mjs';

// Fenced JSON is the canonical shape; a bare object also parses.
const fenced = parseMergedSuggestionResult([
  'Sure, here is the suggestion:',
  '```json',
  JSON.stringify({
    taskCard: {
      mode: 'task',
      summary: '整理销售周报，并沉淀一版可复用流程。',
      objective: '把手工整理交给 Ragent。',
      nextActions: ['先检查 Excel 结构', '产出最小交付版'],
    },
    workflowState: 'waiting_user',
    workflowPriority: 'high',
    shouldSetWorkflowState: true,
    nextAction: '用户提供验证码后继续。',
    confidence: 0.92,
    reason: 'assistant is blocked on required user input',
  }),
  '```',
].join('\n'));

assert.equal(fenced.ok, true, 'fenced JSON should parse');
assert.equal(fenced.suggestion.taskCard.mode, 'task');
// Old task-card aliases (objective / nextActions) must normalize.
assert.equal(fenced.suggestion.taskCard.goal, '把手工整理交给 Ragent。');
assert.deepEqual(fenced.suggestion.taskCard.nextSteps, ['先检查 Excel 结构', '产出最小交付版']);
assert.equal(fenced.suggestion.workflowState, 'waiting_user');
assert.equal(fenced.suggestion.workflowPriority, 'high');
assert.equal(fenced.suggestion.shouldSetWorkflowState, true);
assert.equal(fenced.suggestion.nextAction, '用户提供验证码后继续。');
assert.equal(fenced.suggestion.confidence, 0.92);
assert.equal(fenced.suggestion.reason, 'assistant is blocked on required user input');

// Bare object (no fence) is accepted for one-shot JSON runtimes.
const bare = parseMergedSuggestionResult(JSON.stringify({
  taskCard: null,
  workflowState: 'done',
  workflowPriority: 'low',
  shouldSetWorkflowState: true,
  confidence: 0.8,
}));
assert.equal(bare.ok, true, 'bare object should parse');
assert.equal('taskCard' in bare.suggestion, false, 'taskCard null keeps the current card');
assert.equal(bare.suggestion.workflowState, 'done');

// Old workflow-state result shape stays compatible (单独触发旧格式).
const legacyShape = parseMergedSuggestionResult(JSON.stringify({
  shouldSetWorkflowState: false,
  workflowState: '',
  workflowPriority: '',
  reason: 'leave active by default',
}));
assert.equal(legacyShape.ok, true);
assert.equal(legacyShape.suggestion.shouldSetWorkflowState, false);
assert.equal(legacyShape.suggestion.workflowState, '');
assert.equal(legacyShape.suggestion.reason, 'leave active by default');

// Neutral labels are valid and preserved for the clear path.
const neutral = parseMergedSuggestionResult(JSON.stringify({
  shouldSetWorkflowState: false,
  workflowState: 'active',
}));
assert.equal(neutral.ok, true);
assert.equal(neutral.suggestion.workflowState, '');

// Hidden chain-of-thought fields are rejected explicitly.
for (const hiddenKey of SUGGESTION_HIDDEN_THINKING_KEYS.slice(0, 3)) {
  const hidden = parseMergedSuggestionResult(JSON.stringify({
    [hiddenKey]: 'step 1: ... step 2: ...',
    workflowState: 'done',
  }));
  assert.equal(hidden.ok, false, `${hiddenKey} should be discarded`);
  assert.equal(hidden.reason, 'hidden_thinking');
}

// Unknown fields make the whole result invalid (discard, no partial apply).
const unknown = parseMergedSuggestionResult(JSON.stringify({
  workflowState: 'done',
  surpriseField: 'extra',
}));
assert.equal(unknown.ok, false);
assert.equal(unknown.reason, 'unknown_field');

// No JSON at all → discarded.
assert.equal(parseMergedSuggestionResult('我先继续推进。').ok, false);
assert.equal(parseMergedSuggestionResult('').ok, false);

// Wrong types are discarded, not coerced.
assert.equal(parseMergedSuggestionResult(JSON.stringify({ workflowState: 3 })).reason, 'invalid_workflow_state');
assert.equal(parseMergedSuggestionResult(JSON.stringify({ workflowState: 'banana' })).reason, 'invalid_workflow_state');
assert.equal(parseMergedSuggestionResult(JSON.stringify({ shouldSetWorkflowState: 'yes' })).reason, 'invalid_should_set_workflow_state');
assert.equal(parseMergedSuggestionResult(JSON.stringify({ confidence: 'high' })).reason, 'invalid_confidence');
assert.equal(parseMergedSuggestionResult(JSON.stringify({ confidence: 1.5 })).reason, 'invalid_confidence');
assert.equal(parseMergedSuggestionResult(JSON.stringify({ taskCard: 'card text' })).reason, 'invalid_task_card');
assert.equal(parseMergedSuggestionResult(JSON.stringify({ taskCard: {} })).reason, 'invalid_task_card');
assert.equal(parseMergedSuggestionResult(JSON.stringify({ nextAction: 42 })).reason, 'invalid_next_action');
assert.equal(parseMergedSuggestionResult(JSON.stringify({ reason: true })).reason, 'invalid_reason');

// Empty result is discarded.
assert.equal(parseMergedSuggestionResult('{}').reason, 'empty');

// nextAction / reason are clipped to bounded lengths.
const longText = 'x'.repeat(500);
const clipped = parseMergedSuggestionResult(JSON.stringify({
  workflowState: 'parked',
  nextAction: longText,
  reason: longText,
}));
assert.equal(clipped.ok, true);
assert.ok(clipped.suggestion.nextAction.length <= 200, 'nextAction must be bounded');
assert.ok(clipped.suggestion.reason.length <= 300, 'reason must be bounded');

// extractStrictFencedJson: fenced block preferred, prose-only → null.
assert.ok(extractStrictFencedJson('```json\n{"a":1}\n```')?.a === 1);
assert.equal(extractStrictFencedJson('no json here'), null);
assert.equal(extractStrictFencedJson('```json\nnot json\n```'), null);
assert.equal(extractStrictFencedJson('[1,2,3]'), null, 'arrays are not suggestion objects');

console.log('test-session-suggestion-parse: ok');
