#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGY_ACP_RUNTIME_FAMILY,
  AGY_STREAM_RUNTIME_FAMILY,
  buildAgyAcpArgs,
  buildAgyStreamInput,
  buildAgyArgs,
  createAgyAcpAdapter,
  createAgyAdapter,
  createAgyStreamAdapter,
} from '../chat/adapters/agy.mjs';
import { classifyProviderOperation } from '../chat/provider-operation-classifier.mjs';

const adapter = createAgyAdapter();
const parse = (value) => adapter.parseLine(JSON.stringify(value));

const initEvents = parse({
  event: 'init',
  conversation_id: 'agy-conversation-1',
});
assert.equal(initEvents[0]?.type, 'status');
assert.equal(initEvents[0]?.provider, 'agy');
assert.equal(initEvents[0]?.runtimeFamily, 'agy-json');

const deltaEvents = parse({
  event: 'step_update',
  step_update: {
    step_index: 2,
    step_type: 'agent_response',
    state: 'ACTIVE',
    text_delta: 'OK',
  },
});
assert.equal(deltaEvents[0]?.type, 'text_delta');
assert.equal(deltaEvents[0]?.text, 'OK');
assert.equal(deltaEvents[0]?.providerSessionId, 'agy-conversation-1');

const usageEvents = parse({
  event: 'step_update',
  step_update: {
    step_index: 2,
    step_type: 'agent_response',
    state: 'DONE',
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      thinking_tokens: 1,
      total_tokens: 13,
    },
  },
});
assert.equal(usageEvents[0]?.type, 'usage');
assert.equal(usageEvents[0]?.inputTokens, 10);
assert.equal(usageEvents[0]?.reasoningTokens, 1);

const resultEvents = parse({
  event: 'result',
  result: {
    status: 'SUCCESS',
    response: 'OK\n',
    usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
  },
});
assert.equal(resultEvents.find((event) => event.type === 'message')?.content, 'OK\n');
assert.equal(resultEvents.find((event) => event.type === 'status')?.content, 'completed');

const errorEvents = createAgyAdapter().parseLine(JSON.stringify({
  event: 'result',
  result: { status: 'ERROR', error: 'not authenticated' },
}));
assert.equal(errorEvents.find((event) => event.type === 'status')?.content, 'error: not authenticated');

const streamAdapter = createAgyStreamAdapter();
const streamParse = (value) => streamAdapter.parseLine(JSON.stringify(value));
const toolStarted = streamParse({
  event: 'step_update',
  step_update: {
    conversation_id: 'agy-conversation-1',
    step_index: 3,
    step_type: 'tool',
    state: 'ACTIVE',
    tool_name: 'run_command',
    tool_info: { parameters: { CommandLine: 'echo AGY_TOOL_OK' } },
  },
});
assert.equal(toolStarted[0]?.type, 'tool_use');
assert.equal(toolStarted[0]?.toolName, 'run_command');
assert.match(toolStarted[0]?.toolInput || '', /AGY_TOOL_OK/);
assert.equal(toolStarted[0]?.providerToolUseId, 'step:3');
assert.equal(toolStarted[0]?.operationLifecycle, 'started');
const agyOperation = classifyProviderOperation(toolStarted[0]);
assert.equal(agyOperation.kind, 'command');
assert.equal(agyOperation.action?.semanticKind, 'execute');
assert.equal(agyOperation.action?.subject, 'echo AGY_TOOL_OK');
const agyMcpOperation = classifyProviderOperation({
  toolName: 'call_mcp_tool',
  toolInput: JSON.stringify({ tool_name: 'filesystem.read_file', path: 'notes/today.md' }),
});
assert.equal(agyMcpOperation.kind, 'mcp');
assert.equal(agyMcpOperation.action?.semanticKind, 'mcp');
assert.equal(agyMcpOperation.action?.subject, 'filesystem.read_file');

const toolCompleted = streamParse({
  event: 'step_update',
  step_update: {
    conversation_id: 'agy-conversation-1',
    step_index: 3,
    step_type: 'tool',
    state: 'DONE',
    tool_info: { output: 'AGY_TOOL_OK\r\n' },
  },
});
assert.equal(toolCompleted[0]?.type, 'tool_result');
assert.equal(toolCompleted[0]?.toolName, 'run_command');
assert.equal(toolCompleted[0]?.output, 'AGY_TOOL_OK\r\n');
assert.equal(toolCompleted[0]?.exitCode, 0);
assert.equal(toolCompleted[0]?.operationLifecycle, 'completed');
assert.equal(toolCompleted[0]?.runtimeFamily, AGY_STREAM_RUNTIME_FAMILY);

const toolFailed = streamParse({
  event: 'step_update',
  step_update: {
    step_index: 4,
    step_type: 'tool',
    state: 'DONE',
    tool_name: 'call_mcp_tool',
    tool_info: { error: { message: 'User denied permission' } },
  },
});
assert.equal(toolFailed[0]?.type, 'tool_result');
assert.equal(toolFailed[0]?.exitCode, 1);
assert.match(toolFailed[0]?.output || '', /User denied permission/);
assert.equal(toolFailed[0]?.operationLifecycle, 'failed');

const deltas = [
  ...streamParse({ event: 'step_update', step_update: { step_index: 5, step_type: 'agent_response', text_delta: 'a' } }),
  ...streamParse({ event: 'step_update', step_update: { step_index: 5, step_type: 'agent_response', text_delta: 'b' } }),
].filter((event) => event.type === 'text_delta');
assert.equal(new Set(deltas.map((event) => event.providerEventId)).size, 2);

const legacyToolEvents = adapter.parseLine(JSON.stringify({
  event: 'step_update',
  step_update: {
    step_index: 3,
    step_type: 'tool',
    state: 'ACTIVE',
    tool_name: 'run_command',
  },
}));
assert.equal(legacyToolEvents.length, 0, 'legacy agy-json must not claim tool-event support');

const fixtureAdapter = createAgyStreamAdapter();
const fixtureEvents = readFileSync(join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'agy-stream-json',
  'tool-run.jsonl',
), 'utf8')
  .trim()
  .split(/\r?\n/)
  .flatMap((line) => fixtureAdapter.parseLine(line));
assert.equal(fixtureEvents.filter((event) => event.type === 'tool_use').length, 1);
assert.equal(fixtureEvents.filter((event) => event.type === 'tool_result').length, 1);
assert.equal(fixtureEvents.find((event) => event.type === 'tool_result')?.output, 'AGY_FIXTURE_OK\r\n');

assert.deepEqual(
  buildAgyArgs('Say OK.', { model: 'gemini-3.7-flash-low', effort: 'low' }),
  [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--print=',
    '--print-timeout', '24h',
    '--disable-slash-commands',
    '--dangerously-skip-permissions',
    '--model', 'gemini-3.7-flash-low',
  ],
);
assert.equal(buildAgyArgs('Say OK.').includes('--print'), false);
assert.deepEqual(JSON.parse(buildAgyStreamInput('line 1\n"line 2"').trim()), {
  event: 'user',
  message: { role: 'user', content: 'line 1\n"line 2"' },
});

assert.deepEqual(
  buildAgyArgs('Say OK.', { model: 'gemini-3.7-flash', effort: 'low' }).slice(-4),
  ['--model', 'gemini-3.7-flash', '--effort', 'low'],
);
assert.equal(
  buildAgyArgs('Say OK.', { model: 'claude-sonnet-4-6', effort: 'high' }).includes('--effort'),
  false,
);
assert.equal(
  buildAgyArgs('Say OK.', { model: 'claude-opus-4-6-thinking', effort: 'high' }).includes('--effort'),
  false,
);
assert.equal(
  buildAgyArgs('Say OK.', { model: 'gemini-4-neon-xhigh', effort: 'xhigh' }).includes('--effort'),
  false,
);
assert.deepEqual(
  buildAgyArgs('Say OK.', { model: 'gemini-4-neon', effort: 'xhigh' }).slice(-4),
  ['--model', 'gemini-4-neon', '--effort', 'xhigh'],
);

// Controlled slash-command policy + --agent / --settings / --sandbox / --add-dir.
const authorizedSlashArgs = buildAgyArgs('Say OK.', {
  allowSlashCommands: true,
  agent: 'probe-agent',
  settings: { queuedMessages: 'send-immediately' },
  sandbox: true,
  addDirs: ['/extra-a', '/extra-a', '/extra-b'],
});
assert.equal(authorizedSlashArgs.includes('--disable-slash-commands'), false);
assert.ok(authorizedSlashArgs.includes('--agent'));
assert.equal(authorizedSlashArgs[authorizedSlashArgs.indexOf('--agent') + 1], 'probe-agent');
assert.ok(authorizedSlashArgs.includes('--settings'));
assert.equal(authorizedSlashArgs[authorizedSlashArgs.indexOf('--settings') + 1], '{"queuedMessages":"send-immediately"}');
assert.ok(authorizedSlashArgs.includes('--sandbox'));
assert.deepEqual(
  authorizedSlashArgs.reduce((acc, arg, idx) => (arg === '--add-dir' ? [...acc, authorizedSlashArgs[idx + 1]] : acc), []),
  ['/extra-a', '/extra-b'],
);
assert.equal(
  buildAgyArgs('Say OK.', { allowSlashCommands: true, untrusted: true }).includes('--disable-slash-commands'),
  true,
  'untrusted runs must keep slash commands disabled even if allowSlashCommands is requested',
);
assert.equal(
  buildAgyArgs('Say OK.', { allowSlashCommands: true, managed: true }).includes('--disable-slash-commands'),
  true,
  'managed runs must keep slash commands disabled by default',
);

// AgY ACP args and adapter contract.
assert.equal(createAgyAcpAdapter().capabilities.runtimeFamily, AGY_ACP_RUNTIME_FAMILY);
const acpArgs = buildAgyAcpArgs({
  geminiDir: '/sandbox/.gemini',
  appDataDir: 'sessions/s-1',
  includeDefaultCustomizations: false,
  sandbox: true,
  addDirs: ['/ws-extra', '/ws-extra'],
  agent: 'probe-reader',
});
assert.deepEqual(acpArgs, [
  'acp', '--stdio', '--process-per-session',
  '--gemini-dir', '/sandbox/.gemini',
  '--app-data-dir', 'sessions/s-1',
  '--include-default-customizations=false',
  '--sandbox',
  '--add-dir', '/ws-extra',
  '--agent', 'probe-reader',
]);
assert.equal(acpArgs.includes('--dangerously-skip-permissions'), false);
assert.throws(
  () => buildAgyAcpArgs({ geminiDir: '/sandbox/.gemini', appDataDir: '/outside/abs' }),
  /must stay inside --gemini-dir/,
);
assert.throws(
  () => buildAgyAcpArgs({ geminiDir: '/sandbox/.gemini', appDataDir: '../escape' }),
  /path traversal/,
);

// Multi-turn stream-json tool ids remain collision-free across turns.
const multiTurn = createAgyStreamAdapter();
const turn1Tool = multiTurn.parseLine(JSON.stringify({
  event: 'step_update',
  step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'echo 1' } } },
}));
assert.equal(turn1Tool[0].providerToolUseId, 'step:2');
multiTurn.parseLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'one' } }));
const turn2Tool = multiTurn.parseLine(JSON.stringify({
  event: 'step_update',
  step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'echo 2' } } },
}));
assert.equal(turn2Tool[0].providerToolUseId, 'turn:1:step:2');

console.log('test-agy-adapter: ok');
