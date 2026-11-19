#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  canonicalDelegationSpoolRecord,
  isProviderNativeChildFrame,
  isProviderNativeDelegationEvidence,
  projectProviderNativeDelegation,
  reconcileProviderNativeDelegationRun,
  resolveProvider,
} from '../chat/provider-native-delegation-runtime.mjs';
import { createAgyStreamAdapter } from '../chat/adapters/agy.mjs';
import { createClaudeAdapter } from '../chat/adapters/claude.mjs';
import { barrierEventFromMember } from '../chat/adapters/provider-native-delegation.mjs';
import { createRunProjectionService } from '../chat/run-projection.mjs';
import { createDetachedRunReconciler } from '../chat/run-reconciler.mjs';

async function fixture(name) {
  const text = await readFile(new URL(`./fixtures/provider-events/${name}`, import.meta.url), 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => ({
    stream: 'stdout',
    json: JSON.parse(line),
  }));
}

const claudeRecords = await fixture('claude/native-delegations.jsonl');
const claudeLoadRecords = await fixture('claude/native-delegations-load.jsonl');
const claudeRun = {
  id: 'run_runtime_claude',
  sessionId: 'session_runtime_claude',
  provider: 'claude',
  runtimeFamily: 'claude-stream-json',
};

// The larger Claude fixture exercises the requested progress/message volume
// while keeping provider-native frames in raw spool only.
{
  const progressCount = claudeLoadRecords.filter((record) => (
    record.json?.session_id === 'claude-load-parent'
    && record.json?.message?.content?.[0]?.text?.startsWith('progress-')
  )).length;
  const childMessageCount = claudeLoadRecords.filter((record) => (
    record.json?.session_id?.startsWith('claude-load-')
    && record.json?.message?.content?.[0]?.text?.startsWith('child-message-')
  )).length;
  assert.equal(progressCount, 55);
  assert.equal(childMessageCount, 99);
  const projected = projectProviderNativeDelegation({
    run: { ...claudeRun, id: 'run_runtime_claude_load' },
    spoolRecords: claudeLoadRecords,
    terminalCandidate: { outcome: 'completed' },
    nowMs: 3500,
  });
  assert.equal(projected.runtime.delegationSummary.total, 3);
  assert.equal(projected.runtime.delegationSummary.active, 0);
  assert.equal(projected.decision, 'complete');
  assert.equal(JSON.stringify(projected.runtime).includes('child-message-'), false);
}

// The accepted historical Claude fixture contains three children, including a
// nested child.  All terminal evidence allows aggregation and completion.
{
  const projected = projectProviderNativeDelegation({
    run: claudeRun,
    spoolRecords: claudeRecords,
    terminalCandidate: { outcome: 'completed' },
    nowMs: 3000,
  });
  assert.equal(projected.handled, true);
  assert.equal(projected.runtime.delegationSummary.total, 3);
  assert.equal(projected.runtime.delegationSummary.active, 0);
  assert.equal(projected.decision, 'complete');
  assert.equal(projected.runtime.aggregation.completed, true);
  assert.equal(projected.runtime.delegations.every((record) => record.execution.ownership === 'provider_native'), true);
  assert.equal(projected.runtime.delegations.every((record) => record.execution.recoverability === 'parent_process_bound'), true);
  assert.equal(projected.runtime.delegations.some((record) => Object.hasOwn(record, 'prompt')), false);
}

// A terminal candidate while a provider-native child is still active must
// remain non-terminal while the provider is alive.
{
  const activeRecords = claudeRecords.slice(0, 3);
  const projected = projectProviderNativeDelegation({
    run: claudeRun,
    spoolRecords: activeRecords,
    terminalCandidate: { outcome: 'completed' },
    providerExited: false,
    nowMs: 3000,
  });
  assert.equal(projected.runtime.delegationSummary.active, 3);
  assert.equal(projected.decision, 'await_delegations');
  assert.notEqual(projected.runtime.phase, 'completed');
}

// Once the provider process exits, unresolved provider-native children are
// explicitly lost and the parent fails closed instead of becoming successful.
{
  const projected = projectProviderNativeDelegation({
    run: claudeRun,
    spoolRecords: claudeRecords.slice(0, 3),
    terminalCandidate: { outcome: 'completed' },
    providerExited: true,
    providerExitedAtMs: 4000,
    nowMs: 4000,
  });
  assert.equal(projected.runtime.delegationSummary.active, 0);
  assert.equal(projected.runtime.delegationSummary.lost, 3);
  assert.equal(projected.decision, 'fail');
  assert.equal(projected.reason, 'delegation_lost');
  assert.equal(projected.canonicalEvents.filter((event) => event.kind === 'lost').length, 3);
}

// A persisted active summary without a replayable snapshot must never be
// guessed as success.  While the provider is alive it waits; after provider
// exit it fails closed even though no child identity is available to emit.
{
  const run = {
    ...claudeRun,
    providerNativeDelegation: {
      schemaVersion: 1,
      handled: true,
      delegationSummary: { active: 1 },
      delegations: [],
      terminalCandidate: { outcome: 'completed' },
    },
  };
  const waiting = projectProviderNativeDelegation({
    run,
    spoolRecords: [],
    providerExited: false,
    nowMs: 4500,
  });
  assert.equal(waiting.decision, 'await_delegations');
  const lost = projectProviderNativeDelegation({
    run,
    spoolRecords: [],
    providerExited: true,
    providerExitedAtMs: 4500,
    nowMs: 4500,
  });
  assert.equal(lost.decision, 'fail');
  assert.equal(lost.reason, 'delegation_lost');
}

// Child-agent assistant frames are identified for stream suppression.  The
// parent Task spawn frame itself is not classified as a child message.
{
  const childFrame = {
    type: 'assistant',
    session_id: 'claude-parent-child',
    message: { content: [{ type: 'text', text: 'private child output' }] },
  };
  assert.equal(isProviderNativeChildFrame(childFrame, ['claude-parent-child']), true);
  assert.equal(isProviderNativeChildFrame(claudeRecords[0].json, ['claude-parent-child']), true);
  assert.deepEqual(
    createClaudeAdapter().parseLine(JSON.stringify({ ...childFrame, ragent_intermediate: true })),
    [],
    'child assistant frame must not enter the parent assistant stream',
  );
}

// Exercise the real normalization boundary: the child assistant frame stays
// in raw spool but only the parent assistant message is projected.
{
  const projectionService = createRunProjectionService({
    buildCodexContextMetricsPayload: () => null,
    clipPreview: (value) => String(value).slice(0, 100),
    createToolInvocation: async () => ({
      adapter: createClaudeAdapter(),
      capabilities: {},
      provider: 'claude',
      runtimeFamily: 'claude-stream-json',
    }),
    materializeRunSpoolLine: async (_runId, record) => JSON.stringify(record.json),
    normalizeRunEvents: (_run, events) => events,
    readLatestCodexSessionMetrics: async () => null,
    readRunSpoolDelta: async () => ({ records: [], nextOffset: 0, processedLineCount: 0 }),
    readRunSpoolRecords: async () => [
      claudeRecords[0],
      {
        stream: 'stdout',
        json: {
          type: 'assistant',
          session_id: 'claude-parent-child',
          message: { content: [{ type: 'text', text: 'child must stay private' }] },
        },
      },
      {
        stream: 'stdout',
        json: {
          type: 'assistant',
          session_id: 'parent-session',
          message: { content: [{ type: 'text', text: 'parent is visible' }] },
        },
      },
    ],
  });
  const projection = await projectionService.collectNormalizedRunEvents({
    id: 'run_projection_child_filter',
    sessionId: 'parent-session',
    provider: 'claude',
    runtimeFamily: 'claude-stream-json',
  }, { tool: 'claude', options: {} });
  assert.equal(projection.normalizedEvents.some((event) => event.content === 'child must stay private'), false);
  assert.equal(projection.normalizedEvents.some((event) => event.content === 'parent is visible'), true);
}

// Canonical events are safe to replay from the spool and do not change the
// result.  This is the restart/replay determinism gate for the runtime layer.
{
  const first = projectProviderNativeDelegation({
    run: claudeRun,
    spoolRecords: claudeRecords,
    terminalCandidate: { outcome: 'completed' },
    nowMs: 5000,
  });
  const withCanonical = [
    ...claudeRecords,
    ...first.canonicalEvents.map(canonicalDelegationSpoolRecord),
  ];
  const replay = projectProviderNativeDelegation({
    run: claudeRun,
    spoolRecords: withCanonical,
    terminalCandidate: { outcome: 'completed' },
    nowMs: 5000,
  });
  assert.deepEqual(replay.runtime.delegationSummary, first.runtime.delegationSummary);
  assert.equal(replay.decision, first.decision);
  assert.deepEqual(replay.canonicalEvents, first.canonicalEvents);
}

const codexRecords = await fixture('codex/native-delegations.jsonl');
{
  let run = { id: 'run_peer_delegation', sessionId: 'session_peer_delegation', provider: 'codex',
    runtimeFamily: 'codex-app-server-json', state: 'running' };
  let handedOff = null;
  const options = { runId: run.id, terminalCandidate: { outcome: 'completed' }, nowMs: 8000,
    getRun: async () => structuredClone(run), readRunSpoolRecords: async () => structuredClone(codexRecords),
    appendRunSpoolRecord: async () => {}, updateRun: async (_id, updater) => { run = updater(structuredClone(run)); return run; },
    writeRunResult: async (_id, result) => { handedOff = structuredClone(result); }, protectedResultHandoff: true };
  await assert.rejects(reconcileProviderNativeDelegationRun({ ...options, providerExited: false }), /before the provider exits/);
  assert.equal(handedOff, null);
  await reconcileProviderNativeDelegationRun({ ...options, providerExited: true,
    result: { completedAt: '1970-01-01T00:00:08.000Z', exitCode: 0, signal: null } });
  assert.equal(handedOff.exitCode, 0);
  assert.equal(run.state, 'running', 'only the control side publishes terminal state');
}
{
  const projected = projectProviderNativeDelegation({
    run: {
      id: 'run_runtime_codex',
      sessionId: 'session_runtime_codex',
      provider: 'codex',
      runtimeFamily: 'codex-app-server-json',
    },
    spoolRecords: codexRecords,
    terminalCandidate: { outcome: 'completed' },
    nowMs: 6000,
  });
  assert.equal(projected.runtime.delegationSummary.total, 6);
  assert.equal(projected.runtime.delegationSummary.active, 0);
  assert.equal(projected.decision, 'complete');
}

// The durable adapter used by sidecar/observer applies the same decision to a
// persisted Run and writes canonical events without exposing raw provider data.
{
  let run = {
    id: 'run_runtime_durable',
    sessionId: 'session_runtime_durable',
    provider: 'claude',
    runtimeFamily: 'claude-stream-json',
    state: 'running',
  };
  let spool = claudeRecords.slice(0, 3);
  let resultFile = null;
  const getRun = async () => structuredClone(run);
  const readRunSpoolRecords = async () => structuredClone(spool);
  const appendRunSpoolRecord = async (_runId, record) => { spool.push(structuredClone(record)); };
  const updateRun = async (_runId, updater) => {
    run = updater(structuredClone(run));
    return structuredClone(run);
  };
  const writeRunResult = async (_runId, value) => { resultFile = structuredClone(value); };

  const waiting = await reconcileProviderNativeDelegationRun({
    runId: run.id,
    terminalCandidate: { outcome: 'completed' },
    providerExited: false,
    nowMs: 7000,
    getRun,
    readRunSpoolRecords,
    appendRunSpoolRecord,
    updateRun,
    writeRunResult,
  });
  assert.equal(waiting.decision, 'await_delegations');
  assert.equal(run.state, 'running');
  assert.equal(run.providerNativeDelegation.delegationSummary.active, 3);
  assert.equal(resultFile, null);

  spool = claudeRecords;
  const completed = await reconcileProviderNativeDelegationRun({
    runId: run.id,
    result: { completedAt: '1970-01-01T00:00:08.000Z', exitCode: 0, signal: null },
    terminalCandidate: { outcome: 'completed' },
    providerExited: false,
    nowMs: 8000,
    getRun,
    readRunSpoolRecords,
    appendRunSpoolRecord,
    updateRun,
    writeRunResult,
  });
  assert.equal(completed.decision, 'complete');
  assert.equal(run.state, 'completed');
  assert.equal(resultFile.exitCode, 0);
  const memberRecord = spool.find((record) => record.json?.type === 'ragent.member_event');
  assert.ok(memberRecord);
  assert.equal(barrierEventFromMember(memberRecord.json.event)?.id, memberRecord.json.event.id);
}

// Terminal replay uses the full spool stream without materializing ordinary
// progress frames. The early delegation remains visible even when the live
// tail reader would only return the last few thousand records.
{
  let run = {
    id: 'run_runtime_stream_replay',
    sessionId: 'session_runtime_stream_replay',
    provider: 'codex',
    runtimeFamily: 'codex-app-server-json',
    state: 'running',
  };
  const records = [{
    stream: 'stdout',
    json: {
      method: 'item/started',
      params: { item: {
        type: 'collabAgentToolCall',
        id: 'agent_stream_early',
        tool: 'spawn_agent',
        childThreadId: 'codex-stream-child',
      } },
    },
  }];
  for (let index = 0; index < 6000; index += 1) {
    records.push({
      stream: 'stdout',
      json: { method: 'item/agentMessage/delta', params: { delta: `progress-${index}` } },
    });
  }
  records.push({
    stream: 'stdout',
    json: {
      method: 'item/completed',
      params: { item: {
        type: 'collabAgentToolCall',
        id: 'agent_stream_early',
        tool: 'close_agent',
        status: 'completed',
      } },
    },
  });
  let resultFile = null;
  const appended = [];
  const getRun = async () => structuredClone(run);
  const streamRunSpoolRecords = async function* () {
    for (const record of records) yield record;
  };
  const updateRun = async (_runId, updater) => {
    run = updater(structuredClone(run));
    return structuredClone(run);
  };
  const projected = await reconcileProviderNativeDelegationRun({
    runId: run.id,
    terminalCandidate: { outcome: 'completed' },
    providerExited: false,
    nowMs: 9000,
    getRun,
    readRunSpoolRecords: async () => {
      throw new Error('tail reader should not be used for streamed replay');
    },
    streamRunSpoolRecords,
    appendRunSpoolRecord: async (_runId, record) => { appended.push(record); },
    updateRun,
    writeRunResult: async (_runId, value) => { resultFile = structuredClone(value); },
  });
  assert.equal(projected.decision, 'complete');
  assert.equal(run.providerNativeDelegation.delegationSummary.total, 1);
  assert.equal(run.providerNativeDelegation.canonicalEventCount, 2);
  assert.equal(resultFile.exitCode, 0);
  assert.equal(appended.length, 2, 'raw evidence is materialized as durable member events');
  assert.deepEqual(appended.map((record) => record.json?.type), ['ragent.member_event', 'ragent.member_event']);
  assert.deepEqual(appended.map((record) => barrierEventFromMember(record.json.event)?.id),
    appended.map((record) => record.json.event.id));
}

// Detached-run startup recovery uses the same replay decision and therefore
// turns an exited provider with active children into delegation_lost.
{
  let run = {
    id: 'run_runtime_reconciler',
    sessionId: 'session_runtime_reconciler',
    provider: 'claude',
    runtimeFamily: 'claude-stream-json',
    state: 'running',
    runnerProcessId: 2000000000,
    providerNativeDelegation: {
      schemaVersion: 1,
      handled: true,
      terminalCandidate: { outcome: 'completed' },
      delegationSummary: { active: 3 },
    },
  };
  let resultFile = null;
  const reconciler = createDetachedRunReconciler({
    appendRunSpoolRecord: async (_runId, record) => { spoolForRecovery.push(record); },
    collectRunOutputPreview: async () => 'provider output',
    graceMs: 0,
    isTerminalRunState: (state) => ['completed', 'failed', 'cancelled'].includes(state),
    nowIso: () => '1970-01-01T00:00:09.000Z',
    reconcileProviderNativeDelegationRun,
    readRunSpoolRecords: async () => structuredClone(spoolForRecovery),
    updateRun: async (_runId, updater) => {
      run = updater(structuredClone(run));
      return structuredClone(run);
    },
    writeRunResult: async (_runId, value) => { resultFile = structuredClone(value); },
  });
  const spoolForRecovery = claudeRecords.slice(0, 3);
  const recovered = await reconciler(run.id, run);
  assert.equal(recovered.state, 'failed');
  assert.equal(recovered.failureReason, 'delegation_lost');
  assert.equal(resultFile.delegationLost, true);
}

// Load/replay gate: 100 provider-native children plus 10,000 raw progress
// frames produce 100 canonical delegations and remain deterministic.
{
  const loadRecords = [];
  for (let index = 0; index < 100; index += 1) {
    loadRecords.push({
      stream: 'stdout',
      json: {
        method: 'item/started',
        params: { item: {
          type: 'collabAgentToolCall',
          id: `agent_load_${index}`,
          tool: 'spawn_agent',
          childThreadId: `codex-load-child-${index}`,
        } },
        timestamp: 10000 + index,
      },
    });
  }
  for (let index = 0; index < 10000; index += 1) {
    loadRecords.push({
      stream: 'stdout',
      json: { method: 'item/agentMessage/delta', params: { delta: `progress-${index}` } },
    });
  }
  for (let index = 0; index < 100; index += 1) {
    loadRecords.push({
      stream: 'stdout',
      json: {
        method: 'item/completed',
        params: { item: {
          type: 'collabAgentToolCall',
          id: `agent_load_${index}`,
          tool: 'close_agent',
          status: 'completed',
        } },
        timestamp: 20000 + index,
      },
    });
  }
  const projected = projectProviderNativeDelegation({
    run: { id: 'run_runtime_load', sessionId: 'session_runtime_load', provider: 'codex' },
    spoolRecords: loadRecords,
    terminalCandidate: { outcome: 'completed' },
    nowMs: 30000,
  });
  assert.equal(projected.runtime.delegationSummary.total, 100);
  assert.equal(projected.runtime.delegationSummary.active, 0);
  assert.equal(projected.runtime.canonicalEventCount, 200);
  assert.equal(projected.decision, 'complete');
}

// Regression for the spawn-child failure (2026-08-17): a delegated child run
// whose provider uses ordinary tools (Bash tool_use + tool_result, no native
// Task delegation) was failed at finalization with delegation_replay_invalid
// because the Claude mapper turned every tool_result into an orphan terminal
// delegation event.  Runs without native delegation evidence must stay on the
// legacy terminal path and never enter the join barrier as invalid.
{
  const ordinaryRecords = await fixture('claude/ordinary-tool-roundtrip.jsonl');
  const priorFailedSnapshot = {
    handled: true,
    runId: 'run_ordinary_regression',
    phase: 'failed',
    decision: 'fail',
    decisionReason: 'delegation_replay_invalid',
    delegations: [],
    delegationSummary: { total: 0, active: 0 },
  };
  for (const withPrior of [false, true]) {
    const projected = projectProviderNativeDelegation({
      run: {
        id: 'run_ordinary_regression',
        sessionId: 'session_ordinary_regression',
        provider: 'claude',
        runtimeFamily: 'claude-stream-json-bidi',
        ...(withPrior ? { providerNativeDelegation: priorFailedSnapshot } : {}),
      },
      spoolRecords: ordinaryRecords,
      terminalCandidate: { outcome: 'completed' },
      providerExited: true,
      providerExitedAtMs: 9000,
      nowMs: 9001,
    });
    assert.equal(projected.handled, false, 'ordinary tool traffic must not be treated as provider-native delegation evidence');
    assert.equal(projected.reason, 'no_provider_native_delegation_evidence');
  }
}

// Mixed traffic: ordinary tool roundtrips around a real Task delegation must
// project exactly one delegation, complete it, and finalize the parent Run.
{
  const mixedRecords = await fixture('claude/ordinary-plus-delegation.jsonl');
  const projected = projectProviderNativeDelegation({
    run: { id: 'run_mixed_regression', sessionId: 'session_mixed', provider: 'claude', runtimeFamily: 'claude-stream-json-bidi' },
    spoolRecords: mixedRecords,
    terminalCandidate: { outcome: 'completed' },
    providerExited: true,
    providerExitedAtMs: 9000,
    nowMs: 9001,
  });
  assert.equal(projected.handled, true);
  assert.equal(projected.runtime.delegationSummary.total, 1);
  assert.equal(projected.runtime.delegationSummary.active, 0);
  assert.equal(projected.runtime.aggregation.completed, true);
  assert.equal(projected.decision, 'complete', `expected complete, got ${projected.decision}/${projected.reason}`);
  const baseline = JSON.stringify(projected.runtime.canonicalEventIds);
  for (let index = 0; index < 10; index += 1) {
    const next = projectProviderNativeDelegation({
      run: { id: 'run_mixed_regression', sessionId: 'session_mixed', provider: 'claude', runtimeFamily: 'claude-stream-json-bidi' },
      spoolRecords: mixedRecords,
      terminalCandidate: { outcome: 'completed' },
      providerExited: true,
      providerExitedAtMs: 9000,
      nowMs: 9001,
    });
    assert.equal(JSON.stringify(next.runtime.canonicalEventIds), baseline, 'mixed-traffic replay must be deterministic');
  }
}

// AgY routing, evidence detection, Join Barrier safety (invoke_subagent vs swarm),
// and run-projection ragent_intermediate filtering + approval counter normalization.
{
  assert.equal(resolveProvider({ provider: 'antigravity' }), 'agy');
  assert.equal(resolveProvider({ provider: 'agy', runtimeFamily: 'agy-acp' }), 'agy');
  assert.equal(resolveProvider({ runtimeFamily: 'agy-stream-json-bidi' }), 'agy');
  assert.equal(resolveProvider({ runtimeFamily: 'legacy-unknown' }), '');

  assert.equal(
    isProviderNativeDelegationEvidence({
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', name: 'invoke_subagent' } },
    }, 'agy'),
    true,
  );
  assert.equal(
    isProviderNativeDelegationEvidence({
      event: 'step_update',
      step_update: { step_type: 'tool', tool_name: 'swarm', tool_info: { name: 'swarm' } },
    }, 'antigravity'),
    true,
  );
  assert.equal(
    isProviderNativeDelegationEvidence({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Let us discuss swarm routing' } } },
    }, 'agy'),
    false,
    'ordinary assistant text mentioning swarm must not trigger native delegation evidence',
  );
  assert.equal(
    isProviderNativeDelegationEvidence({
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', name: 'swarm' } },
      ragent_intermediate: true,
    }, 'agy'),
    false,
  );

  // Active invoke_subagent blocks premature exit; completed invoke_subagent completes cleanly;
  // un-killed swarm worker stays non-blocking on clean exit without false delegation_lost.
  const activeSubagentRun = {
    id: 'run_agy_subagent',
    sessionId: 'session_agy_subagent',
    provider: 'antigravity',
    runtimeFamily: 'agy-acp',
  };
  const subSpawnRecord = {
    stream: 'stdout',
    json: {
      method: 'session/update',
      params: {
        sessionId: 'agy-root-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'sub_1', name: 'invoke_subagent', status: 'in_progress' },
      },
    },
  };
  const subWait = projectProviderNativeDelegation({
    run: activeSubagentRun,
    spoolRecords: [subSpawnRecord],
    terminalCandidate: { outcome: 'completed' },
    providerExited: false,
    nowMs: 1000,
  });
  assert.equal(subWait.decision, 'await_delegations');
  assert.equal(subWait.provider, 'agy');

  const subDoneRecord = {
    stream: 'stdout',
    json: {
      method: 'session/update',
      params: {
        sessionId: 'agy-root-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'sub_1',
          name: 'invoke_subagent',
          status: 'completed',
          rawOutput: { conversation_id: 'agy-sub-conv-1' },
        },
      },
    },
  };
  const subDone = projectProviderNativeDelegation({
    run: activeSubagentRun,
    spoolRecords: [subSpawnRecord, subDoneRecord],
    terminalCandidate: { outcome: 'completed' },
    providerExited: true,
    providerExitedAtMs: 2000,
    nowMs: 2001,
  });
  assert.equal(subDone.decision, 'complete');
  assert.equal(subDone.runtime.delegationSummary.total, 1);

  let swarmRun = {
    id: 'run_agy_swarm',
    sessionId: 'session_agy_swarm',
    provider: 'agy',
    runtimeFamily: 'agy-stream-json',
    state: 'running',
  };
  const appendedSwarm = [];
  const swarmAddRecord = {
    stream: 'stdout',
    json: {
      event: 'step_update',
      step_update: {
        conversation_id: 'agy-swarm-root',
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'swarm',
        tool_info: {
          name: 'swarm',
          parameters: { action: 'add', name: 'echoer', model: 'gemini-3.8-flash-low' },
          output: JSON.stringify({ conversation_id: 'agy-echoer-1', status: 'added' }),
        },
      },
    },
  };
  const swarmReconciled = await reconcileProviderNativeDelegationRun({
    runId: swarmRun.id,
    terminalCandidate: { outcome: 'completed' },
    providerExited: true,
    providerExitedAtMs: 5000,
    nowMs: 5001,
    getRun: async () => structuredClone(swarmRun),
    readRunSpoolRecords: async () => [swarmAddRecord],
    appendRunSpoolRecord: async (_id, rec) => { appendedSwarm.push(rec); },
    updateRun: async (_id, updater) => { swarmRun = updater(structuredClone(swarmRun)); return swarmRun; },
    writeRunResult: async () => {},
  });
  assert.equal(swarmReconciled.decision, 'complete');
  assert.equal(swarmRun.state, 'completed', 'AgY swarm add without explicit kill must not falsely fail run with delegation_lost');
  assert.equal(appendedSwarm.some((r) => r.json?.type === 'ragent.member_event' && r.json.event?.displayName === 'echoer'), true);

  // run-projection: AgY ragent_intermediate filtering + approval counter bucket
  const agySpoolRecords = [
    {
      stream: 'stdout',
      json: {
        event: 'step_update',
        step_update: {
          conversation_id: 'agy-root-p',
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'invoke_subagent',
          tool_info: { name: 'invoke_subagent', parameters: { subagent_type: 'worker' }, output: { conversation_id: 'agy-child-secret-id' } },
        },
      },
    },
    {
      stream: 'stdout',
      json: {
        event: 'step_update',
        ragent_intermediate: true,
        step_update: {
          conversation_id: 'agy-child-secret-id',
          step_index: 2,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'intermediate wrapper text should be filtered',
        },
      },
    },
    {
      stream: 'stdout',
      json: {
        event: 'step_update',
        step_update: {
          conversation_id: 'agy-child-secret-id',
          step_index: 3,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'child frame auto tagged intermediate',
        },
      },
    },
    {
      stream: 'stdout',
      json: {
        event: 'step_update',
        step_update: {
          conversation_id: 'agy-root-p',
          step_index: 4,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'parent visible response',
        },
      },
    },
    {
      stream: 'stdout',
      json: { type: 'ragent.approval_response', approvalId: 'agy:perm-1', provider: 'antigravity', autoApproved: true },
    },
  ];
  const agyProjectionService = createRunProjectionService({
    buildCodexContextMetricsPayload: () => null,
    clipPreview: (value) => String(value).slice(0, 100),
    createToolInvocation: async () => ({
      adapter: createAgyStreamAdapter(),
      capabilities: {},
      provider: 'agy',
      runtimeFamily: 'agy-stream-json',
    }),
    materializeRunSpoolLine: async (_runId, record) => JSON.stringify(record.json),
    normalizeRunEvents: (_run, events) => events,
    readLatestCodexSessionMetrics: async () => null,
    readRunSpoolDelta: async () => ({ records: agySpoolRecords, nextOffset: 500, processedLineCount: agySpoolRecords.length }),
    readRunSpoolRecords: async () => agySpoolRecords,
  });
  const agyProjectionRun = {
    id: 'run_agy_proj_filter',
    sessionId: 'sess_agy_proj',
    provider: 'agy',
    runtimeFamily: 'agy-stream-json',
    providerNativeDelegation: {
      delegations: [{ childSessionId: 'agy-child-secret-id' }],
    },
  };
  const agyProjectionManifest = { tool: 'agy', options: { runtimeFamily: 'agy-stream-json' } };
  const eventText = (e) => `${String(e?.text ?? '')}\n${String(e?.content ?? '')}`;
  const agyProjected = await agyProjectionService.collectNormalizedRunEvents(agyProjectionRun, agyProjectionManifest);
  assert.equal(agyProjected.normalizedEvents.some((e) => eventText(e).includes('intermediate wrapper text')), false);
  assert.equal(agyProjected.normalizedEvents.some((e) => eventText(e).includes('child frame auto tagged intermediate')), false);
  assert.equal(agyProjected.normalizedEvents.some((e) => eventText(e).includes('parent visible response')), true);
  const agyDelta = await agyProjectionService.collectNormalizedRunEventDelta(agyProjectionRun, agyProjectionManifest);
  assert.equal(agyDelta.normalizedEvents.some((e) => eventText(e).includes('intermediate wrapper text')), false);
  assert.equal(agyDelta.normalizedEvents.some((e) => eventText(e).includes('child frame auto tagged intermediate')), false);
  assert.equal(agyDelta.normalizedEvents.some((e) => eventText(e).includes('parent visible response')), true);
  assert.equal(agyProjectionService.getApprovalSuppressionCounters('run_agy_proj_filter').byProvider.agy.autoAllowed, 1);
  agyProjectionService.releaseRunRuntimeInvocation('run_agy_proj_filter');

  // Mid-run reconcileProviderNativeDelegationRun with providerExited: false and omitted/null terminalCandidate
  let midRun = {
    id: 'run_agy_mid_reconcile',
    sessionId: 'sess_agy_mid_reconcile',
    provider: 'agy',
    runtimeFamily: 'agy-acp',
    state: 'running',
  };
  const midSpool = [
    {
      stream: 'stdout',
      json: {
        method: 'session/update',
        params: {
          sessionId: 'agy-mid-root',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_mid_sub_1',
            name: 'invoke_subagent',
            kind: 'other',
            title: 'Run invoke_subagent',
          },
        },
      },
    },
    {
      stream: 'stdout',
      json: {
        method: 'session/update',
        params: {
          sessionId: 'agy-mid-root',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call_mid_sub_1',
            name: 'invoke_subagent',
            status: 'completed',
          },
        },
      },
    },
  ];
  const midReconciled = await reconcileProviderNativeDelegationRun({
    runId: midRun.id,
    providerExited: false,
    nowMs: 12345,
    getRun: async () => structuredClone(midRun),
    readRunSpoolRecords: async () => midSpool,
    appendRunSpoolRecord: async (_id, rec) => { midSpool.push(rec); },
    updateRun: async (_id, updater) => {
      midRun = updater(structuredClone(midRun));
      return midRun;
    },
  });
  assert.equal(midReconciled.handled, true);
  assert.equal(midReconciled.decision, 'continue', 'mid-turn reconcile without terminalCandidate must not crash on null');
  assert.equal(midRun.state, 'running');
}

console.log('test-provider-native-delegation-runtime: ok');
