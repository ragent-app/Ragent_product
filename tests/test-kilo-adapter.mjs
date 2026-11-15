#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  buildKiloArgs,
  createKiloAdapter,
  KILO_RUNTIME_FAMILY,
} from '../chat/adapters/kilo.mjs';

assert.deepEqual(buildKiloArgs('Do the work.'), [
  'run', '--format', 'json', '--auto', 'Do the work.',
]);
assert.deepEqual(buildKiloArgs('Review the workspace.', { riskMode: 'conservative-auto' }), [
  'run', '--format', 'json', 'Review the workspace.',
]);
assert.deepEqual(buildKiloArgs('Continue.', {
  model: 'gpt-5@provider-a',
  resume: 'kilo-session-1',
}), [
  'run', '--format', 'json', '--auto', '--session', 'kilo-session-1',
  '--model', 'ragent/gpt-5', 'Continue.',
]);

const adapter = createKiloAdapter();
assert.equal(adapter.capabilities.provider, 'kilo');
assert.equal(adapter.capabilities.runtimeFamily, KILO_RUNTIME_FAMILY);
assert.equal(adapter.capabilities.supportsResume, true);

const parse = (payload) => adapter.parseLine(JSON.stringify(payload));

const message = parse({
  type: 'text',
  sessionID: 'kilo-session-1',
  part: { text: 'hello from Kilo' },
});
assert.equal(message[0].type, 'message');
assert.equal(message[0].content, 'hello from Kilo');
assert.equal(message[0].providerSessionId, 'kilo-session-1');

const reasoning = parse({
  type: 'reasoning',
  sessionID: 'kilo-session-1',
  part: { text: 'thinking' },
});
assert.equal(reasoning[0].type, 'reasoning');
assert.equal(reasoning[0].content, 'thinking');

const toolStarted = parse({
  type: 'tool_use',
  sessionID: 'kilo-session-1',
  part: {
    tool: 'shell',
    callID: 'call-1',
    state: { status: 'running', input: { command: 'echo ok' } },
  },
});
assert.equal(toolStarted[0].type, 'tool_use');
assert.equal(toolStarted[0].toolName, 'shell');
assert.equal(toolStarted[0].providerToolUseId, 'call-1');

const toolFinished = parse({
  type: 'tool_use',
  sessionID: 'kilo-session-1',
  part: {
    tool: 'shell',
    callID: 'call-1',
    state: { status: 'completed', output: 'ok' },
  },
});
assert.equal(toolFinished[0].type, 'tool_use');
assert.equal(toolFinished[1].type, 'tool_result');
assert.equal(toolFinished[1].output, 'ok');
assert.equal(toolFinished[1].exitCode, 0);

const step = parse({ type: 'step_finish', sessionID: 'kilo-session-1', part: {} });
assert.equal(step[0].type, 'status');
assert.equal(step[0].content, 'Step completed');
assert.equal(adapter.parseLine('{not-json}').length, 0);

console.log('Kilo adapter tests passed');
