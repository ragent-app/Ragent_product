#!/usr/bin/env node
// Focused tests for the Live Bar waiting-subtype resolution:
// resolveApprovalWaitingStatus / resolveLiveBarDangerRisk / createReadyStatus
// must classify a pending approval/question event into the concrete waiting
// state (plan_pending / danger_pending / approval_pending / awaiting_answer),
// while non-waiting events resolve to null.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(
  join(repoRoot, 'static', 'chat', 'session-state-model.js'),
  'utf8',
);

const context = { console };
context.globalThis = context;
context.window = context;

vm.runInNewContext(source, context, {
  filename: 'session-state-model.js',
});

const model = context.RagentSessionStateModel;

assert.ok(model, 'session state model should attach to the global scope');

function keyOf(approval) {
  const status = model.resolveApprovalWaitingStatus(approval);
  return status ? status.key : null;
}

// Plan approvals -> plan_pending
assert.equal(keyOf({ kind: 'plan', title: 'Deploy plan' }), 'plan_pending', 'kind=plan -> plan_pending');
assert.equal(keyOf({ kind: 'plan', risk: 'medium' }), 'plan_pending', 'plan wins over medium risk');

// Questions -> awaiting_answer (kind=question, or a question payload)
assert.equal(keyOf({ kind: 'question', question: 'Continue?' }), 'awaiting_answer', 'kind=question -> awaiting_answer');
assert.equal(keyOf({ questions: ['a', 'b'] }), 'awaiting_answer', 'questions array -> awaiting_answer');
assert.equal(keyOf({ kind: 'tool', question: 'Proceed?' }), 'awaiting_answer', 'inline question wins over tool kind');

// Danger risk -> danger_pending, on every accepted field alias
for (const field of ['risk', 'riskLevel', 'severity', 'level', 'tier']) {
  assert.equal(
    keyOf({ kind: 'tool', [field]: 'high' }),
    'danger_pending',
    `${field}=high -> danger_pending`,
  );
  assert.equal(
    keyOf({ kind: 'tool', [field]: 'critical' }),
    'danger_pending',
    `${field}=critical -> danger_pending`,
  );
}
assert.equal(keyOf({ kind: 'command', risk: 'DANGEROUS' }), 'danger_pending', 'case-insensitive danger');
assert.equal(keyOf({ kind: 'bash', risk: 'elevated' }), 'danger_pending', 'elevated -> danger_pending');

// Generic pending approval -> approval_pending
assert.equal(keyOf({ kind: 'tool', title: 'Write file' }), 'approval_pending', 'generic tool -> approval_pending');
assert.equal(keyOf({ kind: 'permissions' }), 'approval_pending', 'permissions -> approval_pending');

// Non-waiting / malformed inputs -> null
assert.equal(keyOf(null), null, 'null -> null');
assert.equal(keyOf('string'), null, 'non-object -> null');
assert.equal(keyOf({ kind: 'plan', status: 'resolved' }), 'plan_pending', 'status field does not suppress classification');
assert.equal(keyOf({}), 'approval_pending', 'bare object defaults to generic approval');

// createReadyStatus stays a stable "ready" pill
const ready = model.createReadyStatus();
assert.equal(ready.key, 'ready', 'createReadyStatus -> ready');
assert.equal(typeof ready.label, 'string', 'ready has a label');

// Danger-risk helper directly
assert.equal(model.resolveLiveBarDangerRisk({ risk: 'critical' }), true, 'risk=critical is danger');
assert.equal(model.resolveLiveBarDangerRisk({ severity: 'low' }), false, 'severity=low is not danger');

console.log('test-chat-live-bar-waiting-states: ok');
