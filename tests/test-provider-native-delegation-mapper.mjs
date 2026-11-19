#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

import {
  createProviderNativeDelegationMapper,
  mapClaudeProviderDelegationEvent,
  mapCodexProviderDelegationEvent,
  replayProviderNativeDelegations,
} from '../chat/provider-native-delegation-mapper.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function fixture(name) {
  return readFileSync(join(root, 'tests', 'fixtures', 'provider-events', name), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
}

function replay(provider, events) {
  return replayProviderNativeDelegations(events, {
    provider,
    runId: `run-${provider}`,
    parentSessionId: `session-${provider}`,
  });
}

const claudeLines = fixture('claude/native-delegations.jsonl');
const claude = replay('claude', claudeLines);
assert.equal(claude.ok, true, claude.errors.join('; '));
assert.equal(claude.events.length, 6);
assert.equal(claude.events.filter((event) => event.kind === 'spawned').length, 3);
assert.equal(claude.events.filter((event) => event.kind === 'completed').length, 2);
assert.equal(claude.events.filter((event) => event.kind === 'failed').length, 1);
assert.equal(claude.projection.ok, true);
assert.deepEqual([...claude.activeChildSessionIds], []);
assert.equal(claude.events.some((event) => event.parentDelegationId), true, 'nested parent identity must survive mapping');
assert.equal(mapClaudeProviderDelegationEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'not a delegation' }] } }, { runId: 'r', parentSessionId: 'p' }).events.length, 0);

const codexLines = fixture('codex/native-delegations.jsonl');
const codex = replay('codex', codexLines);
assert.equal(codex.ok, true, codex.errors.join('; '));
assert.equal(codex.controls.filter((control) => control.control === 'send').length, 1);
assert.equal(codex.events.filter((event) => event.kind === 'recovered').length, 1);
assert.equal(codex.events.filter((event) => event.kind === 'failed').length, 1);
assert.equal(codex.events.filter((event) => event.kind === 'cancelled').length, 1);
assert.equal(codex.events.filter((event) => event.kind === 'interrupted').length, 1);
assert.equal(codex.events.filter((event) => event.kind === 'lost').length, 1);
assert.equal(codex.events.some((event) => event.parentDelegationId), true, 'nested Codex delegation must be represented');
assert.deepEqual([...codex.activeChildSessionIds], []);
assert.equal(mapCodexProviderDelegationEvent({ method: 'item/started', params: { item: { type: 'message', text: 'ordinary' } } }, { runId: 'r', parentSessionId: 'p' }).events.length, 0);

for (const [provider, lines] of [['claude', claudeLines], ['codex', codexLines]]) {
  const first = replay(provider, lines);
  for (let index = 0; index < 10; index += 1) {
    const next = replay(provider, lines);
    assert.deepEqual(next.events, first.events, `${provider} canonical events must be replay-deterministic`);
    assert.deepEqual(next.controls, first.controls, `${provider} controls must be replay-deterministic`);
    assert.deepEqual(next.activeChildSessionIds, first.activeChildSessionIds);
    assert.equal(next.projection.ok, first.projection.ok);
  }
}

const mapper = createProviderNativeDelegationMapper({ provider: 'claude', runId: 'run-message', parentSessionId: 'parent' });
const messageResult = mapper.map({ type: 'user', message: { content: [{ type: 'text', text: 'child message must not leak' }] } });
assert.deepEqual(messageResult.events, []);
assert.deepEqual(messageResult.controls, []);

// Ordinary (non-delegation) tool roundtrips must not produce delegation
// events.  Regression for delegation_replay_invalid: a tool_result for a
// non-Task tool (Bash/Read/...) used to be mapped as an orphan terminal
// delegation event, which the canonical projector rejects because its first
// event can never be 'spawned' — failing the whole Run at finalization even
// though the provider completed successfully.
const ordinaryLines = fixture('claude/ordinary-tool-roundtrip.jsonl');
const ordinary = replay('claude', ordinaryLines);
assert.equal(ordinary.ok, true, ordinary.errors.join('; '));
assert.equal(ordinary.events.length, 0, 'ordinary tool roundtrips must map to zero delegation events');
assert.equal(ordinary.projection.ok, true);

const mixedLines = fixture('claude/ordinary-plus-delegation.jsonl');
const mixed = replay('claude', mixedLines);
assert.equal(mixed.ok, true, mixed.errors.join('; '));
assert.equal(mixed.events.length, 2, 'only the real Task delegation maps to events');
assert.equal(mixed.events.filter((event) => event.kind === 'spawned').length, 1);
assert.equal(mixed.events.filter((event) => event.kind === 'completed').length, 1);
assert.equal(mixed.projection.ok, true);
for (let index = 0; index < 10; index += 1) {
  assert.deepEqual(replay('claude', mixedLines).events, mixed.events, 'ordinary+delegation mapping must be replay-deterministic');
}

// --- AgY ACP & stream-json mapping (invoke_subagent, swarm, post_message, run_workflow) ---
const agyAcpFrames = [
  {
    method: 'session/update',
    params: {
      sessionId: 'agy-parent-acp-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_sub_1',
        name: 'invoke_subagent',
        status: 'in_progress',
        title: 'Run invoke_subagent',
        rawInput: { subagent_type: 'reviewer', role: 'reviewer' },
      },
    },
    timestamp: 1001,
  },
  {
    method: 'session/update',
    params: {
      sessionId: 'agy-parent-acp-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_sub_1',
        name: 'invoke_subagent',
        status: 'completed',
        rawOutput: { conversation_id: 'agy-child-conv-1' },
      },
    },
    timestamp: 1002,
  },
  {
    method: 'session/update',
    params: {
      sessionId: 'agy-parent-acp-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_swarm_title',
        name: 'swarm',
        status: 'completed',
        rawInput: { action: 'title', title: 'Phase 1 Swarm' },
      },
    },
    timestamp: 1003,
  },
  {
    method: 'session/update',
    params: {
      sessionId: 'agy-parent-acp-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_swarm_channel',
        name: 'swarm',
        status: 'completed',
        rawInput: { action: 'channel', channel: 'review', topic: 'Code audit' },
      },
    },
    timestamp: 1004,
  },
  {
    method: 'session/update',
    params: {
      sessionId: 'agy-parent-acp-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_swarm_add',
        name: 'swarm',
        status: 'in_progress',
        rawInput: { action: 'add', name: 'echoer', model: 'gemini-3.8-flash-low' },
      },
    },
    timestamp: 1005,
  },
  {
    method: 'session/update',
    params: {
      sessionId: 'agy-parent-acp-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_swarm_add',
        name: 'swarm',
        status: 'completed',
        rawOutput: { conversation_id: 'agy-echoer-conv-1', status: 'added' },
      },
    },
    timestamp: 1006,
  },
  {
    method: 'session/update',
    params: {
      sessionId: 'agy-parent-acp-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_swarm_model',
        name: 'swarm',
        status: 'completed',
        rawInput: { action: 'model', name: 'echoer', model: 'gemini-4-neon-high' },
      },
    },
    timestamp: 1007,
  },
  {
    method: 'session/update',
    params: {
      sessionId: 'agy-parent-acp-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_post_1',
        name: 'post_message',
        status: 'completed',
        rawInput: { channel: 'review', text: '@echoer please check #1 and token sk-ant-secretvalue123456' },
      },
    },
    timestamp: 1008,
  },
  {
    method: 'session/update',
    params: {
      sessionId: 'agy-parent-acp-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_wf_1',
        name: 'run_workflow',
        status: 'in_progress',
        rawInput: { Description: 'Audit fan-out' },
      },
    },
    timestamp: 1009,
  },
  {
    method: 'session/update',
    params: {
      sessionId: 'agy-parent-acp-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_wf_1',
        name: 'run_workflow',
        status: 'completed',
      },
    },
    timestamp: 1010,
  },
  {
    method: 'session/update',
    params: {
      sessionId: 'agy-parent-acp-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_swarm_kill',
        name: 'swarm',
        status: 'completed',
        rawInput: { action: 'kill', name: 'echoer' },
      },
    },
    timestamp: 1011,
  },
];

const agyAcpReplay = replay('antigravity', agyAcpFrames);
assert.equal(agyAcpReplay.ok, true, agyAcpReplay.errors.join('; '));
assert.equal(agyAcpReplay.events.length, 4, 'invoke_subagent + run_workflow produce 2x (spawned + completed)');
assert.equal(agyAcpReplay.events.every((ev) => ev.provider === 'agy'), true, 'antigravity normalizes to canonical agy');
assert.equal(
  agyAcpReplay.events.filter((ev) => ev.kind === 'spawned').every((ev) => ev.facts?.birthActor === 'root_session'),
  true,
);
assert.equal(agyAcpReplay.memberEvents.some((m) => m.displayName === 'echoer' && m.phase === 'confirmed' && m.model === 'gemini-3.8-flash-low'), true);
assert.equal(agyAcpReplay.memberEvents.some((m) => m.displayName === 'echoer' && m.phase === 'updated' && m.model === 'gemini-4-neon-high'), true);
assert.equal(agyAcpReplay.memberEvents.some((m) => m.displayName === 'echoer' && m.phase === 'terminal' && m.state === 'cancelled'), true);
assert.equal(agyAcpReplay.memberEvents.every((m) => m.sourceTag === 'agy' && m.executionHarnessId === 'agy' && m.controlCapabilities?.readOnly === true), true);
const postBoardEv = agyAcpReplay.boardEvents.find((b) => b.kind === 'message');
assert.ok(postBoardEv);
assert.equal(postBoardEv.message.channel, 'review');
assert.equal(postBoardEv.message.replyToSeq, 1);
assert.deepEqual(postBoardEv.message.mentions, ['@echoer']);
assert.equal(postBoardEv.message.text.includes('secretvalue123456'), false, 'board messages must redact secrets');

// Stream-JSON step_update frames (including ordinary tool filtering, ragent_intermediate, and unverified parent honesty)
const agyStreamFrames = [
  { event: 'init', conversation_id: 'agy-stream-root' },
  {
    event: 'step_update',
    step_update: {
      conversation_id: 'agy-stream-root',
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } },
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: 'agy-stream-root',
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'swarm',
      tool_info: { name: 'swarm', parameters: { action: 'add', name: 'shard', tasks: ['a', 'b'] } },
    },
    ragent_intermediate: true,
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: 'agy-stream-root',
      step_index: 3,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'swarm',
      tool_info: { name: 'swarm', parameters: { action: 'add', name: 'shard', tasks: ['a', 'b'] }, output: '{}' },
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: 'foreign-unknown-conv',
      step_index: 4,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'invoke_subagent',
      tool_info: { name: 'invoke_subagent', parameters: {} },
    },
  },
];
const agyStreamReplay = replay('agy', agyStreamFrames);
assert.equal(agyStreamReplay.ok, true, agyStreamReplay.errors.join('; '));
assert.equal(agyStreamReplay.results[1].recognized, false, 'ordinary run_command is not delegation evidence');
assert.equal(agyStreamReplay.results[2].recognized, false, 'ragent_intermediate frame must be suppressed');
assert.equal(agyStreamReplay.memberEvents.filter((m) => m.displayName?.startsWith('shard-')).length, 2, 'tasks[] expands into shard-1 & shard-2');
const foreignSpawn = agyStreamReplay.events.find((ev) => ev.providerDelegationId === 'step:4' && ev.kind === 'spawned');
assert.ok(foreignSpawn);
assert.equal(foreignSpawn.facts?.birthActor, undefined, 'unverified foreign conversation must not fabricate root_session birthActor');
assert.deepEqual(agyAcpReplay.events, replay('antigravity', agyAcpFrames).events, 'AgY replay must be deterministic');

console.log('test-provider-native-delegation-mapper: ok');
