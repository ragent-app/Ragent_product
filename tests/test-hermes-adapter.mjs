#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  buildHermesAcpArgs,
  createHermesAdapter,
  HERMES_RUNTIME_FAMILY,
} from '../chat/adapters/hermes.mjs';

const adapter = createHermesAdapter();
assert.deepEqual(buildHermesAcpArgs(), []);
assert.equal(adapter.capabilities.provider, 'hermes');
assert.equal(adapter.capabilities.runtimeFamily, HERMES_RUNTIME_FAMILY);
assert.equal(adapter.capabilities.supportsResume, true);
assert.equal(adapter.capabilities.supportsApproval, false);

const parse = (payload) => adapter.parseLine(JSON.stringify(payload));

const message = parse({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello from Hermes' },
    },
  },
});
assert.equal(message.length, 1);
assert.equal(message[0].type, 'text_delta');
assert.equal(message[0].text, 'hello from Hermes');
assert.equal(message[0].provider, 'hermes');
assert.equal(message[0].runtimeFamily, HERMES_RUNTIME_FAMILY);

const thought = parse({
  method: 'session/update',
  params: { update: { sessionUpdate: 'agent_thought_chunk', content: 'thinking' } },
});
assert.equal(thought[0].type, 'reasoning');
assert.equal(thought[0].content, 'thinking');

const toolCall = parse({
  method: 'session/update',
  params: {
    update: {
      sessionUpdate: 'tool_call',
      title: 'shell',
      rawInput: { command: 'echo ok' },
    },
  },
});
assert.equal(toolCall[0].type, 'tool_use');
assert.equal(toolCall[0].toolName, 'shell');
assert.deepEqual(toolCall[0].toolInput, { command: 'echo ok' });

const toolResult = parse({
  method: 'session/update',
  params: {
    update: {
      sessionUpdate: 'tool_call_update',
      title: 'shell',
      rawOutput: 'ok',
      status: 'completed',
    },
  },
});
assert.equal(toolResult[0].type, 'tool_result');
assert.equal(toolResult[0].output, 'ok');
assert.equal(toolResult[0].exitCode, 0);

const started = parse({ id: 'ragent-session-new', result: { sessionId: 'hermes-session-1' } });
assert.equal(started[0].type, 'status');
assert.equal(started[0].content, 'ACP session started');
assert.equal(started[0].providerSessionId, 'hermes-session-1');

const resumed = parse({ id: 'ragent-session-load', result: { sessionId: 'hermes-session-1' } });
assert.equal(resumed[0].content, 'ACP session resumed');

const completed = parse({ id: 'ragent-prompt', result: {} });
assert.equal(completed[0].content, 'completed');
assert.equal(completed[0].runState, 'completed');

const failed = parse({ error: { message: 'ACP unavailable' } });
assert.equal(failed[0].content, 'error: ACP unavailable');
assert.equal(failed[0].runState, 'failed');
assert.deepEqual(adapter.flush(), []);
assert.equal(adapter.parseLine('{not-json}').length, 0);

console.log('Hermes adapter tests passed');
