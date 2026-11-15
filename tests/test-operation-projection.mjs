#!/usr/bin/env node
import assert from 'assert/strict';

import { buildOperationProjection } from '../chat/operation-projection.mjs';

const base = {
  runId: 'run-1',
  provider: 'codex',
  runtimeFamily: 'codex-app-server-json',
};
const projection = buildOperationProjection([
  { seq: 1, timestamp: 1000, type: 'reasoning', content: 'Inspecting' },
  {
    ...base,
    seq: 2,
    timestamp: 1100,
    type: 'tool_use',
    toolName: 'bash',
    toolInput: 'printf same',
    providerItemId: 'cmd-1',
    operationLifecycle: 'started',
  },
  {
    ...base,
    seq: 3,
    timestamp: 1200,
    type: 'tool_result',
    toolName: 'bash',
    output: 'same\n',
    providerItemId: 'cmd-1',
    operationLifecycle: 'delta',
  },
  {
    ...base,
    seq: 4,
    timestamp: 1300,
    type: 'tool_use',
    toolName: 'bash',
    toolInput: 'exit 1',
    providerItemId: 'cmd-2',
    operationLifecycle: 'started',
  },
  {
    ...base,
    seq: 5,
    timestamp: 1400,
    type: 'tool_result',
    toolName: 'bash',
    output: 'same\n',
    providerItemId: 'cmd-1',
    operationLifecycle: 'delta',
  },
  {
    ...base,
    seq: 6,
    timestamp: 1500,
    type: 'tool_result',
    toolName: 'bash',
    output: 'failed\n',
    exitCode: 1,
    providerItemId: 'cmd-2',
    operationLifecycle: 'failed',
  },
  {
    ...base,
    seq: 7,
    timestamp: 1600,
    type: 'tool_result',
    toolName: 'bash',
    output: 'same\nsame\n',
    exitCode: 0,
    providerItemId: 'cmd-1',
    operationLifecycle: 'completed',
  },
]);

assert.equal(projection.operations.length, 2);
assert.equal(projection.operations[0].startSeq, 2);
assert.equal(projection.operations[0].endSeq, 7);
assert.equal(projection.operations[0].state, 'completed');
assert.equal(projection.operations[0].timestamp, 1100, 'event timestamp keeps epoch-millisecond semantics');
assert.equal(projection.operations[0].updatedAt, '1970-01-01T00:00:01.600Z', 'client updatedAt uses the event DTO ISO string contract');
assert.equal(projection.operations[0].outputPreview.totalLines, 2);
assert.deepEqual(projection.operations[0].outputPreview.head, ['same', 'same']);
assert.equal(projection.operations[0].toolCall.toolCallId, projection.operations[0].operationId);
assert.equal(projection.operations[0].toolCall.kind, 'execute');
assert.equal(projection.operations[0].toolCall.status, 'completed');
assert.equal(projection.operations[0].toolCall._meta.ragent.lifecycle, 'completed');
assert.equal('input' in projection.operations[0].toolCall, false);
assert.equal('output' in projection.operations[0].toolCall, false);
assert.equal(projection.operations[0].presentation.kind, 'execute');
assert.deepEqual(projection.operations[0].presentation.outputPreview.head, ['same', 'same']);
assert.equal(projection.operations[1].startSeq, 4);
assert.equal(projection.operations[1].state, 'failed');
assert.equal(projection.operations[1].exitCode, 1);
assert.deepEqual([...projection.sourceSeqs], [2, 3, 4, 5, 6, 7]);

const startedFileChangeProjection = buildOperationProjection([
  {
    seq: 8,
    type: 'tool_use',
    toolName: 'Edit',
    providerToolUseId: 'tool-edit-started',
    operationLifecycle: 'started',
  },
  {
    seq: 9,
    type: 'file_change',
    filePath: '/tmp/started.js',
    providerToolUseId: 'tool-edit-started',
    operationLifecycle: 'started',
  },
]);
assert.equal(startedFileChangeProjection.operations[0].state, 'running');

const deferredOutputProjection = buildOperationProjection([
  {
    ...base,
    seq: 8,
    timestamp: '2026-07-28T08:00:00.000Z',
    type: 'tool_use',
    toolName: 'bash',
    providerItemId: 'cmd-deferred',
    operationLifecycle: 'started',
  },
  {
    ...base,
    seq: 9,
    timestamp: '2026-07-28T08:00:01.000Z',
    type: 'tool_result',
    providerItemId: 'cmd-deferred',
    operationLifecycle: 'completed',
    bodyAvailable: true,
    bodyPreview: 'preview line',
  },
]);
assert.equal(deferredOutputProjection.operations[0].startedAt, Date.parse('2026-07-28T08:00:00.000Z'));
assert.equal(deferredOutputProjection.operations[0].outputPreview.bodyAvailable, true);
assert.equal(deferredOutputProjection.operations[0].outputPreview.bodySeq, 9);

const claudeProjection = buildOperationProjection([
  {
    seq: 10,
    timestamp: 2000,
    type: 'tool_use',
    toolName: 'Edit',
    toolInput: '{"file_path":"/tmp/a.js"}',
    providerToolUseId: 'tool-edit',
    operationLifecycle: 'started',
  },
  {
    seq: 11,
    timestamp: 2100,
    type: 'file_change',
    filePath: '/tmp/a.js',
    changeType: 'edit',
    added: 2,
    removed: 1,
    providerToolUseId: 'tool-edit',
    operationLifecycle: 'started',
  },
  {
    seq: 12,
    timestamp: 2200,
    type: 'approval_request',
    approvalId: 'approval-1',
    providerItemId: 'tool-edit',
    providerToolUseId: 'tool-edit',
    status: 'pending',
  },
  {
    seq: 13,
    timestamp: 2300,
    type: 'approval_response',
    approvalId: 'approval-1',
    decision: 'approved',
  },
  {
    seq: 14,
    timestamp: 2400,
    type: 'tool_result',
    providerToolUseId: 'tool-edit',
    output: 'ok',
    exitCode: 0,
    operationLifecycle: 'completed',
  },
]);

const completePreview = JSON.stringify({ file_path: 'G:\\qa\\acceptance.txt' });
const commandPreview = JSON.stringify({ command: 'pwd', description: 'Show current working directory' });
const previewProjection = buildOperationProjection([
  { seq: 1, type: 'tool_use', toolName: 'Read', toolInput: '', bodyField: 'toolInput', bodyLoaded: false,
    bodyPreview: completePreview, bodyBytes: Buffer.byteLength(completePreview), providerToolUseId: 'preview-read' },
  { seq: 2, type: 'tool_use', toolName: 'Bash', toolInput: '', bodyField: 'toolInput', bodyLoaded: false,
    bodyPreview: commandPreview, bodyBytes: Buffer.byteLength(commandPreview), providerToolUseId: 'preview-command' },
]);
assert.match(previewProjection.operations[0].detail, /acceptance\.txt/);
assert.equal(previewProjection.operations[1].command, 'pwd');
const truncatedPreview = buildOperationProjection([
  { seq: 1, type: 'tool_use', toolName: 'Bash', toolInput: '', bodyField: 'toolInput', bodyLoaded: false,
    bodyPreview: commandPreview, bodyBytes: Buffer.byteLength(commandPreview) + 1, providerToolUseId: 'truncated' },
]);
assert.notEqual(truncatedPreview.operations[0].command, 'pwd', 'partial preview must not be treated as a complete input');
const sensitivePreview = JSON.stringify({ command: 'API_TOKEN=private-value pwd' });
const safePreview = buildOperationProjection([
  { seq: 1, type: 'tool_use', toolName: 'Bash', toolInput: '', bodyField: 'toolInput', bodyLoaded: false,
    bodyPreview: sensitivePreview, bodyBytes: Buffer.byteLength(sensitivePreview), providerToolUseId: 'secret' },
]);
assert.doesNotMatch(JSON.stringify(safePreview.operations), /private-value/, 'preview-derived display must redact secrets');

assert.equal(claudeProjection.operations.length, 1);
assert.equal(claudeProjection.operations[0].kind, 'file_edit');
assert.equal(claudeProjection.operations[0].state, 'completed');
assert.equal(claudeProjection.operations[0].fileChanges[0].filePath, '/tmp/a.js');
assert.equal(claudeProjection.operations[0].approvalId, 'approval-1');
assert.equal(claudeProjection.sourceSeqs.has(12), false, 'approval cards remain visible timeline boundaries');

const waitingProjection = buildOperationProjection([
  { seq: 16, type: 'tool_use', toolName: 'Bash', toolInput: 'npm test', providerItemId: 'cmd-wait', operationLifecycle: 'started' },
  { seq: 17, type: 'approval_request', approvalId: 'approval-wait', providerItemId: 'cmd-wait', status: 'pending' },
]);
assert.equal(waitingProjection.operations[0].state, 'waiting_approval');
assert.equal(waitingProjection.operations[0].toolCall.status, 'pending');
assert.equal(waitingProjection.operations[0].toolCall._meta.ragent.lifecycle, 'waiting_approval');

const legacyProjection = buildOperationProjection([
  { seq: 20, type: 'tool_use', toolName: 'Bash', toolInput: 'pwd' },
  { seq: 21, type: 'tool_result', toolName: 'Bash', output: '/tmp\n', exitCode: 0 },
]);
assert.equal(legacyProjection.operations.length, 1, 'legacy events without provider ids should use the conservative open-operation fallback');
assert.equal(legacyProjection.operations[0].state, 'completed');

assert.equal('tier' in projection.operations[0], false, 'activity projection must not recompute risk');
assert.equal('providerItemId' in claudeProjection.operations[0], false, 'provider correlation ids stay inside the reducer');
assert.equal('providerToolUseId' in claudeProjection.operations[0], false, 'provider correlation ids stay inside the reducer');

const replayResilienceProjection = buildOperationProjection([
  { seq: 43, type: 'tool_result', toolName: 'Bash', providerItemId: 'cmd-replay', output: 'done', operationLifecycle: 'completed' },
  { seq: 41, type: 'tool_use', toolName: 'Bash', toolInput: 'echo replay', providerItemId: 'cmd-replay', operationLifecycle: 'started' },
  { seq: 43, type: 'tool_result', toolName: 'Bash', providerItemId: 'cmd-replay', output: 'done', operationLifecycle: 'completed' },
]);
assert.equal(replayResilienceProjection.operations.length, 1, 'duplicate provider event should not create a second ToolCall');
assert.equal(replayResilienceProjection.operations[0].state, 'completed', 'out-of-order replay is ordered by durable sequence');
assert.equal(replayResilienceProjection.operations[0].outputPreview.totalLines, 1, 'duplicate output must not be appended twice');

const responseBeforeRequestProjection = buildOperationProjection([
  { seq: 50, type: 'tool_use', toolName: 'Bash', toolInput: 'npm test', providerToolUseId: 'claude-tool-1', operationLifecycle: 'started' },
  { seq: 51, type: 'approval_response', approvalId: 'approval-before', decision: 'approved', providerRequestId: 'request-before' },
  {
    seq: 52,
    type: 'approval_request',
    approvalId: 'approval-before',
    providerRequestId: 'request-before',
    providerItemId: 'claude-tool-1',
    providerToolUseId: 'claude-tool-1',
    status: 'pending',
  },
]);
assert.equal(responseBeforeRequestProjection.operations.length, 1);
assert.equal(responseBeforeRequestProjection.operations[0].state, 'running', 'a prior approval response must resolve a later request during replay');

const terminalRegressionProjection = buildOperationProjection([
  { seq: 60, type: 'tool_use', toolName: 'Bash', toolInput: 'echo done', providerItemId: 'terminal-call', operationLifecycle: 'started' },
  { seq: 61, type: 'tool_result', toolName: 'Bash', output: 'done', providerItemId: 'terminal-call', operationLifecycle: 'completed' },
  { seq: 62, type: 'approval_request', approvalId: 'late-approval', providerItemId: 'terminal-call', status: 'pending' },
  { seq: 63, type: 'approval_response', approvalId: 'late-approval', decision: 'approved' },
]);
assert.equal(terminalRegressionProjection.operations[0].state, 'completed', 'completed must not regress to waiting/running');
assert.ok(terminalRegressionProjection.diagnostics.some((item) => item.code === 'ignored_terminal_transition'));

const sameSeqProjection = buildOperationProjection([
  { seq: 70, type: 'tool_use', toolName: 'Bash', toolInput: 'echo one', providerItemId: 'parallel-one', operationLifecycle: 'started' },
  { seq: 70, type: 'tool_use', toolName: 'Bash', toolInput: 'echo two', providerItemId: 'parallel-two', operationLifecycle: 'started' },
]);
assert.equal(sameSeqProjection.operations.length, 2, 'same type and durable seq must not collapse distinct calls');

const replayedDeltaProjection = buildOperationProjection([
  { seq: 80, type: 'tool_use', toolName: 'Bash', toolInput: 'printf x', providerItemId: 'delta-call', operationLifecycle: 'started' },
  { seq: 81, type: 'tool_result', toolName: 'Bash', output: 'x', providerItemId: 'delta-call', providerEventId: 'codex-delta-1', operationLifecycle: 'delta' },
  { seq: 82, type: 'tool_result', toolName: 'Bash', output: 'x', providerItemId: 'delta-call', providerEventId: 'codex-delta-1', operationLifecycle: 'delta' },
]);
assert.deepEqual(replayedDeltaProjection.operations[0].outputPreview.head, ['x'], 'replayed source event must not append a duplicate delta');
assert.ok(replayedDeltaProjection.diagnostics.some((item) => item.code === 'duplicate_event_ignored'));

const orphanProjection = buildOperationProjection([
  { seq: 90, type: 'tool_result', toolName: 'Bash', output: 'orphaned', providerItemId: 'orphan-call', operationLifecycle: 'completed' },
]);
assert.equal(orphanProjection.operations[0].state, 'completed');
assert.ok(orphanProjection.diagnostics.some((item) => item.code === 'orphan_operation'));

const missingEndProjection = buildOperationProjection([
  { seq: 91, type: 'tool_use', toolName: 'Bash', toolInput: 'long task', providerItemId: 'missing-end', operationLifecycle: 'started' },
]);
assert.equal(missingEndProjection.operations[0].state, 'running', 'missing end must not fabricate a terminal state');
assert.ok(missingEndProjection.diagnostics.some((item) => item.code === 'missing_terminal_event'));

console.log('test-operation-projection: ok');
