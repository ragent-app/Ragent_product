#!/usr/bin/env node
import assert from 'assert/strict';

import {
  STABLE_TOOL_CALL_KINDS,
  STABLE_TOOL_CALL_STATUSES,
  buildCanonicalToolCall,
  redactSensitiveText,
  stableToolCallStatus,
} from '../chat/tool-call-schema.mjs';
import { formatToolCall } from '../chat/tool-call-formatters.mjs';

assert.deepEqual(STABLE_TOOL_CALL_STATUSES, ['pending', 'in_progress', 'completed', 'failed']);
assert.deepEqual(STABLE_TOOL_CALL_KINDS, [
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
]);
assert.equal(stableToolCallStatus('running'), 'in_progress');
assert.equal(stableToolCallStatus('completed'), 'completed');
assert.equal(stableToolCallStatus('waiting_approval'), 'pending');
assert.equal(stableToolCallStatus('declined'), 'failed');
assert.equal(stableToolCallStatus('interrupted'), 'failed');

assert.throws(
  () => buildCanonicalToolCall({ kind: 'read', state: 'running' }),
  /requires toolCallId/,
  'stable ACP ToolCall identity is required',
);

const source = {
  operationId: 'operation:run:danger',
  kind: 'command',
  state: 'waiting_approval',
  title: 'Running command',
  toolName: 'bash',
  input: { command: 'curl -H "Authorization: Bearer live-token" https://example.test', api_key: 'secret-value' },
  command: 'curl -H "Authorization: Bearer live-token" https://example.test',
  cwd: '/srv/project',
  approvalId: 'approval-1',
  startSeq: 4,
  endSeq: 7,
  outputPreview: { head: ['Authorization: Bearer output-token'], tail: [], totalLines: 1, omittedLines: 0, bodyAvailable: false },
};
const toolCall = buildCanonicalToolCall(source);
assert.deepEqual(Object.keys(toolCall).sort(), [
  '_meta', 'kind', 'status', 'title', 'toolCallId',
]);
assert.equal(toolCall.toolCallId, 'operation:run:danger');
assert.equal(toolCall.kind, 'execute');
assert.equal(toolCall.status, 'pending', 'approval wait must not invent a stable status');
assert.equal(toolCall._meta.ragent.lifecycle, 'waiting_approval');
assert.equal(toolCall._meta.ragent.approval.approvalId, 'approval-1');
for (const forbidden of ['input', 'output', 'extension', 'rawInput', 'rawOutput', 'name']) {
  assert.equal(forbidden in toolCall, false, `${forbidden} must not masquerade as stable ACP v1`);
}

assert.deepEqual(
  formatToolCall(toolCall, source),
  {
    schemaVersion: 1,
    kind: 'execute',
    labelKind: 'execute',
    subject: 'curl -H "Authorization: Bearer [redacted]" https://example.test',
    detail: 'curl -H "Authorization: Bearer [redacted]" https://example.test',
    outputPreview: {
      head: ['Authorization: Bearer [redacted]'],
      tail: [],
      totalLines: 1,
      omittedLines: 0,
      bodyAvailable: false,
    },
  },
);

const editSource = {
  operationId: 'operation:run:edit',
  kind: 'file_edit',
  state: 'running',
  detail: '/repo/static/chat/ui.js',
};
const editToolCall = buildCanonicalToolCall(editSource);
assert.deepEqual(editToolCall.locations, [{ path: '/repo/static/chat/ui.js' }]);
assert.deepEqual(
  formatToolCall(editToolCall, editSource),
  { schemaVersion: 1, kind: 'edit', labelKind: 'edit', subject: 'ui.js', detail: '/repo/static/chat/ui.js' },
);

const compositeSource = {
  operationId: 'operation:run:composite',
  kind: 'command',
  state: 'running',
  command: 'npm test && npm run lint',
};
assert.deepEqual(
  formatToolCall(buildCanonicalToolCall(compositeSource), compositeSource),
  { schemaVersion: 1, kind: 'execute', labelKind: 'execute_composite', subject: '', detail: 'npm test && npm run lint' },
);

const switchSource = {
  operationId: 'operation:run:switch',
  kind: 'switch_mode',
  state: 'completed',
  input: { mode: 'review' },
};
assert.equal(formatToolCall(buildCanonicalToolCall(switchSource), switchSource).labelKind, 'switch_mode');

const secretSamples = [
  ['OPENAI_API_KEY=sk-live', 'sk-live'],
  ['Authorization: "Bearer quoted-live"', 'quoted-live'],
  ['{"api_key":"json-live"}', 'json-live'],
  ['tool --token=flag-live', 'flag-live'],
  ['tool --access-token flag-space-live', 'flag-space-live'],
];
for (const [sample, secret] of secretSamples) {
  const redacted = redactSensitiveText(sample);
  assert.doesNotMatch(redacted, new RegExp(secret), `secret form should be redacted: ${sample}`);
  assert.match(redacted, /\[redacted\]/);
}

console.log('test-tool-call-schema: ok');
