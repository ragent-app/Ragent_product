import assert from 'node:assert/strict';
import { formatToolCall } from '../chat/tool-call-formatters.mjs';
import { buildRunActivityProjection } from '../chat/run-activity-projection.mjs';
import { createClaudeAdapter } from '../chat/adapters/claude.mjs';
import { buildOperationProjection } from '../chat/operation-projection.mjs';

function claudeTool(name, input) {
  const [event] = createClaudeAdapter().parseLine(JSON.stringify({ type: 'assistant', message: {
    content: [{ type: 'tool_use', id: 'toolu_description', name, input }],
  } }));
  return { ...event, seq: 1, runId: 'r' };
}
const [operation] = buildOperationProjection([claudeTool('Bash', {
  command: 'cat README.md', description: 'Check the project instructions',
})]).operations;
const presentation = operation.presentation;
assert.equal(presentation.activityDescription, 'Check the project instructions');
assert.equal(presentation.activityDescriptionSource, 'tool_input_description');
assert.equal(formatToolCall({ kind: 'read' }, { input: { description: 'unrelated' } }).activityDescription, undefined);
assert.equal(claudeTool('Read', { description: 'unrelated' }).activityDescription, undefined);
assert.equal(claudeTool('Bash', { description: 'Check API_TOKEN=do-not-display' }).activityDescription.includes('do-not-display'), false);
const activity = buildRunActivityProjection([{
  ...operation,
}], { sessionRunning: true, run: { id: 'r' } });
assert.equal(activity.activityDescription, 'Check the project instructions');
console.log('Activity descriptions are projected with redaction');
