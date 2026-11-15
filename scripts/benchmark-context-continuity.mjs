import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildExecutionStateProjection,
} from '../chat/execution-state-projection.mjs';
import {
  assembleContextPlan,
} from '../chat/context-attention-assembler.mjs';
import {
  compileRuntimeContext,
  resolveRuntimeContextResume,
} from '../chat/runtime-context-compiler.mjs';
import {
  createContinuityStore,
} from '../chat/continuity-store.mjs';
import {
  digestEvents,
  reduceContinuityEvents,
} from '../chat/continuity-core.mjs';
import {
  createToolResultDescriptor,
  buildToolResultDescriptors,
  readToolResultRange,
} from '../chat/tool-result-descriptor.mjs';
import { createContextReceipt } from '../chat/context-receipt.mjs';
import { workStateUpdateEvent } from '../chat/normalizer.mjs';
import {
  buildSessionContinuationContextFromBody,
  prepareSessionContinuationBody,
} from '../chat/session-continuation.mjs';

const SESSION_ID = 'context-benchmark-cross-agent';
const LARGE_OUTPUT = `${'build diagnostic line: retained for raw retrieval\n'.repeat(1800)}final marker: CONTEXT_BENCHMARK_LARGE_OUTPUT`;

function addEvent(events, event) {
  const next = { seq: events.length + 1, ...event };
  events.push(next);
  return next;
}

function addWorkState(events, input) {
  const event = workStateUpdateEvent(input);
  assert.ok(event, `work state fixture should be valid: ${JSON.stringify(input)}`);
  return addEvent(events, {
    ...event,
    id: `fixture-work-state-${String(events.length + 1).padStart(3, '0')}`,
    timestamp: 1787529600000 + events.length + 1,
  });
}

function buildFixture() {
  const events = [];
  const files = [
    'chat/session-manager.mjs',
    'chat/context-renderer.mjs',
    'tests/test-continuity-v2.mjs',
  ];

  for (let turn = 1; turn <= 12; turn += 1) {
    addEvent(events, {
      type: 'message',
      role: 'user',
      content: turn === 1
        ? 'Make the cross-agent session handoff reliable without adding a second source of truth.'
        : `Continue the handoff work, turn ${turn}.`,
      runId: `run-codex-${turn}`,
    });

    if (turn === 1 || turn === 2 || turn === 9) {
      addEvent(events, {
        type: 'tool_use',
        toolName: 'read_file',
        toolInput: files[turn === 9 ? 2 : turn - 1],
        runId: `run-codex-${turn}`,
        provider: 'codex',
        runtimeFamily: 'codex-app-server-json',
        model: 'gpt-5.6-sol',
      });
      addEvent(events, {
        type: 'tool_result',
        id: `tool-read-${turn}`,
        toolExecutionId: `tool-read-${turn}`,
        toolName: 'read_file',
        output: `Read ${files[turn === 9 ? 2 : turn - 1]} and confirmed the current implementation boundary.`,
        exitCode: 0,
        runId: `run-codex-${turn}`,
        provider: 'codex',
        runtimeFamily: 'codex-app-server-json',
        model: 'gpt-5.6-sol',
      });
    }

    if (turn === 3 || turn === 5 || turn === 10 || turn === 12) {
      const filePath = files[(turn / 2) % files.length | 0];
      addEvent(events, {
        type: 'file_change',
        filePath,
        changeType: 'edit',
        baselineHash: `sha256:before-${turn}`,
        contentHash: `sha256:after-${turn}`,
        runId: `run-codex-${turn}`,
      });
    }

    if (turn === 4) {
      addWorkState(events, {
        operation: 'upsert',
        source: 'agent',
        facts: [{
          kind: 'decision',
          id: 'decision-single-canonical-state',
          value: {
            statement: 'Keep the existing Node control plane and one canonical event history.',
            reason: 'The durable transcript, Run records, and checkpoint reducer already provide restart-safe facts; a parallel planner would split truth.',
            status: 'accepted',
          },
        }],
      });
    }

    if (turn === 5) {
      addEvent(events, {
        type: 'tool_use',
        toolName: 'npm test',
        toolInput: 'npm run test:continuity',
        runId: `run-codex-${turn}`,
        provider: 'codex',
        runtimeFamily: 'codex-app-server-json',
        model: 'gpt-5.6-sol',
      });
      addEvent(events, {
        type: 'tool_result',
        id: 'tool-large-output',
        toolExecutionId: 'tool-large-output',
        toolName: 'npm test',
        command: 'npm run test:continuity',
        output: LARGE_OUTPUT,
        bodyRef: 'history-body-tool-large-output',
        bodyBytes: Buffer.byteLength(LARGE_OUTPUT, 'utf8'),
        exitCode: 0,
        runId: `run-codex-${turn}`,
        provider: 'codex',
        runtimeFamily: 'codex-app-server-json',
        model: 'gpt-5.6-sol',
      });
    }

    if (turn === 6) {
      addWorkState(events, {
        operation: 'upsert',
        source: 'agent',
        facts: [{
          kind: 'failed_attempt',
          id: 'failed-reuse-old-provider-thread',
          value: {
            approach: 'Reuse the old provider thread after changing the provider profile.',
            failure: 'The runtime fingerprint no longer matches, so the old native context is not trustworthy.',
            retryCondition: 'Only use native resume after runtime, model, profile, and instruction bindings match.',
          },
        }],
      });
      addEvent(events, {
        type: 'tool_result',
        id: 'tool-failed-test',
        toolExecutionId: 'tool-failed-test',
        toolName: 'npm test',
        output: 'FAIL test-provider-binding: stale provider profile was accepted by the first prototype.',
        exitCode: 1,
        runId: `run-codex-${turn}`,
        provider: 'codex',
        runtimeFamily: 'codex-app-server-json',
        model: 'gpt-5.6-sol',
      });
    }

    if (turn === 8) {
      addWorkState(events, {
        operation: 'upsert',
        source: 'agent',
        facts: [{
          kind: 'blocker',
          id: 'blocker-live-provider-credentials',
          value: { text: 'Live Claude and Codex provider replay still needs an authorized account and quota.' },
        }],
      });
    }

    if (turn === 9) {
      addEvent(events, {
        type: 'approval_request',
        approvalId: 'approval-provider-replay',
        status: 'pending',
        runId: `run-codex-${turn}`,
        provider: 'codex',
        runtimeFamily: 'codex-app-server-json',
      });
      addEvent(events, {
        type: 'provider_binding',
        bindingId: 'claude',
        providerProfile: 'default',
        runtimeFamily: 'claude-stream-json',
        model: 'claude-sonnet-4-6',
        nativeSessionId: 'claude-fixture-thread',
        runtimeFingerprint: 'sha256:claude-fixture-runtime',
        instructionRevision: 'sha256:fixture-instructions',
        runId: `run-claude-${turn}`,
      });
    }

    if (turn === 10) {
      addEvent(events, {
        type: 'approval_response',
        approvalId: 'approval-provider-replay',
        decision: 'approved',
        status: 'approved',
        runId: `run-codex-${turn}`,
      });
      addEvent(events, {
        type: 'message',
        role: 'assistant',
        content: 'Claude continued from the canonical handoff and verified the changed files.',
        runId: `run-claude-${turn}`,
        provider: 'claude',
        runtimeFamily: 'claude-stream-json',
        model: 'claude-sonnet-4-6',
      });
    }

    if (turn === 11) {
      addEvent(events, {
        type: 'tool_result',
        id: 'tool-final-validation',
        toolExecutionId: 'tool-final-validation',
        toolName: 'npm run test:continuity',
        output: 'PASS test-continuity-v2\nPASS test-tool-result-descriptor\nPASS test-context-attention-assembler\nPASS test-runtime-context-compiler',
        exitCode: 0,
        runId: `run-claude-${turn}`,
        provider: 'claude',
        runtimeFamily: 'claude-stream-json',
        model: 'claude-sonnet-4-6',
        validation: true,
      });
    }

    if (turn === 12) {
      addEvent(events, {
        type: 'provider_binding',
        bindingId: 'codex',
        providerProfile: 'codex-local-chatgpt',
        runtimeFamily: 'codex-app-server-json',
        model: 'gpt-5.6-sol',
        nativeSessionId: 'codex-fixture-thread',
        runtimeFingerprint: 'sha256:codex-fixture-runtime',
        instructionRevision: 'sha256:fixture-instructions',
        runId: `run-codex-${turn}`,
      });
    }

    addEvent(events, {
      type: 'message',
      role: 'assistant',
      content: turn === 12
        ? 'The next action is to run the offline replay benchmark and review the shadow diff before enabling any default path.'
        : `Completed the bounded work for turn ${turn}; continue with the next handoff step.`,
      runId: turn >= 10 ? `run-claude-${turn}` : `run-codex-${turn}`,
    });
  }

  addWorkState(events, {
    operation: 'upsert',
    source: 'system',
    facts: [
      {
        kind: 'next_action',
        id: 'next-run-replay-review',
        value: { text: 'Run the offline replay benchmark, compare A/B/C carriers, and keep the default path unchanged until evidence is reviewed.' },
      },
      {
        kind: 'status',
        id: 'status-waiting-evidence',
        value: { status: 'waiting' },
      },
    ],
  });
  return events;
}

function executionInput(events, { stale = true } = {}) {
  return {
    run: { id: 'run-codex-12', state: 'completed', runnerProcessId: 4242 },
    events,
    workspace: {
      root: 'C:\\ragent\\fixture',
      snapshotRevision: stale ? 'workspace-after-external-edit' : 'workspace-stable',
      stale,
      staleReason: stale ? 'External workspace modification was observed after the last provider turn.' : '',
    },
    git: {
      root: 'C:\\ragent\\fixture',
      head: 'fixture-head-2026-08-24',
      branch: 'main',
      trackedDiffHash: 'sha256:fixture-tracked-diff',
      untrackedManifestHash: 'sha256:fixture-untracked',
      dirty: true,
    },
    processes: [{ id: 'runner-fixture', kind: 'runner', state: 'exited', pid: 4242 }],
    artifacts: [{ assetId: 'benchmark-report', name: 'context-benchmark.json', mimeType: 'application/json' }],
  };
}

function buildState(sessionId, events, options = {}) {
  const input = executionInput(events, options);
  return reduceContinuityEvents(sessionId, events, {
    executionProjection: buildExecutionStateProjection(input),
  });
}

function buildCanonicalContext({ runtimeFamily, provider, hasResume, events, state, descriptors }) {
  const body = prepareSessionContinuationBody(events.slice(-200));
  const legacy = buildSessionContinuationContextFromBody(body, {
    fromTool: 'codex',
    toTool: provider === 'claude' ? 'claude' : 'codex',
  });
  return {
    runtimeFamily,
    provider,
    promptMode: 'default',
    flattenPrompt: false,
    hasResume,
    userText: 'Continue from the canonical handoff and take the next safe action.',
    contextBudget: { maxInputTokens: 9000 },
    sections: {
      continuationContext: legacy,
      managerTurnContext: 'The manager requires deterministic evidence-backed handoff and no duplicate source of truth.',
      systemContext: 'Ragent system instructions: preserve owner approval boundaries and trust deterministic execution facts.',
      sourceRuntimePrompt: 'Use the provider runtime only as an execution carrier for the canonical context.',
      templateInstructions: 'Keep the existing Node implementation and avoid an unrelated rewrite.',
      perMessageInstruction: '',
      visitorGuardrail: '',
      planArtifact: '',
      goalInstructions: '',
    },
    attachmentReferences: [],
    charCounts: {},
    sourceSeq: state.revision,
    toolResultCount: descriptors.length,
  };
}

function buildPlan(context, state, events, descriptors) {
  return assembleContextPlan({
    canonicalContext: context,
    checkpoint: state,
    toolResults: descriptors,
    recentEvents: events,
    maxInputTokens: 9000,
    outputReserveTokens: 600,
    sourceRevision: state.revision,
    workspaceRevision: state.execution.workspace?.snapshotRevision || '',
  });
}

function carrierText(result) {
  return [result?.prompt, result?.developerInstructions, result?.systemPrefix]
    .filter((value) => typeof value === 'string' && value)
    .join('\n\n');
}

function blockStats(value) {
  const blocks = String(value || '').split(/\n\n---\n\n|\n---\n/).map((entry) => entry.trim()).filter(Boolean);
  const unique = new Set(blocks);
  return {
    blockCount: blocks.length,
    uniqueBlockCount: unique.size,
    duplicateContextRatio: blocks.length > 0 ? Number(((blocks.length - unique.size) / blocks.length).toFixed(4)) : 0,
  };
}

const EXPECTED_FACTS = [
  { id: 'goal', needles: ['cross-agent session handoff reliable'] },
  { id: 'decision', needles: ['Keep the existing Node control plane', 'one canonical event history'] },
  { id: 'decision_reason', needles: ['parallel planner would split truth'] },
  { id: 'failed_attempt', needles: ['Reuse the old provider thread', 'runtime fingerprint no longer matches'] },
  { id: 'failed_attempt_reason', needles: ['Only use native resume after runtime'] },
  { id: 'changed_files', needles: ['chat/session-manager.mjs', 'chat/context-renderer.mjs'] },
  { id: 'validation', needles: ['test-continuity-v2', 'test-runtime-context-compiler'] },
  { id: 'blocker', needles: ['Live Claude and Codex provider replay'] },
  { id: 'next_action', needles: ['offline replay benchmark', 'default path unchanged'] },
  { id: 'workspace_stale', needles: ['External workspace modification', 'workspace-after-external-edit'] },
];

function scoreFacts(value) {
  const haystack = String(value || '').toLowerCase();
  const facts = EXPECTED_FACTS.map((fact) => ({
    id: fact.id,
    matched: fact.needles.every((needle) => haystack.includes(needle.toLowerCase())),
  }));
  return {
    facts,
    matchedCount: facts.filter((fact) => fact.matched).length,
    totalCount: facts.length,
    coverage: facts.length > 0 ? Number((facts.filter((fact) => fact.matched).length / facts.length).toFixed(4)) : 0,
  };
}

function compileVariant({ variant, context, state, events, descriptors }) {
  const plan = buildPlan(context, state, events, descriptors);
  const options = variant === 'A'
    ? { useAttentionPlan: false, contextCompilerMode: 'compatibility' }
    : variant === 'B'
      ? { useAttentionPlan: true, contextCompilerMode: 'compatibility' }
      : { useAttentionPlan: true };
  const compiled = compileRuntimeContext({
    context,
    contextPlan: plan,
    runtimeFamily: context.runtimeFamily,
    options,
  });
  const textValue = carrierText(compiled);
  const stats = blockStats(textValue);
  const selectedToolChars = plan.selectedItems
    .filter((item) => item.type === 'tool_result')
    .reduce((sum, item) => sum + (item.content?.length || 0), 0);
  return {
    variant,
    runtimeFamily: context.runtimeFamily,
    provider: context.provider,
    resumeMode: context.hasResume ? 'native-resume-carrier' : 'semantic-handoff-carrier',
    compiled,
    plan,
    metrics: {
      ...scoreFacts(textValue),
      contextPlanApplied: variant !== 'A',
      contextInputChars: textValue.length,
      estimatedInputTokens: Math.ceil(textValue.length / 3),
      toolOutputChars: selectedToolChars,
      toolOutputRatio: textValue.length > 0 ? Number((selectedToolChars / textValue.length).toFixed(4)) : 0,
      selectedItems: variant === 'A' ? 0 : plan.diagnostics.selectedItemCount,
      omittedItems: variant === 'A' ? 0 : plan.diagnostics.omittedItemCount,
      shadowSelectedItems: plan.diagnostics.selectedItemCount,
      shadowOmittedItems: plan.diagnostics.omittedItemCount,
      duplicationAvoided: plan.diagnostics.duplicationAvoided,
      recallSelected: plan.selectedItems.filter((item) => item.type === 'recall').length,
      handoffPacketDigest: plan.receipt.contentDigest,
      evidenceRefCount: plan.receipt.includedSourceRefs.length,
      staleFactCount: state.execution.workspace?.stale === true ? 1 : 0,
      staleFactWarningSelected: plan.selectedItems.some((item) => item.type === 'workspace_warning'),
      staleFactWarningCarried: textValue.includes('External workspace modification')
        && textValue.includes('workspace-after-external-edit'),
      staleFactSilentlyTreatedAsCurrent: state.execution.workspace?.stale === true
        && !(textValue.includes('External workspace modification')
          && textValue.includes('workspace-after-external-edit')),
      ...stats,
    },
  };
}

function publicVariantResult(result) {
  return {
    variant: result.variant,
    runtimeFamily: result.runtimeFamily,
    provider: result.provider,
    resumeMode: result.resumeMode,
    metadata: result.compiled.metadata,
    plan: {
      budget: result.plan.budget,
      items: result.plan.items,
      omitted: result.plan.omitted,
      receipt: result.plan.receipt,
      diagnostics: result.plan.diagnostics,
    },
    metrics: result.metrics,
  };
}

function buildComparisons(results) {
  const groups = new Map();
  for (const result of results) {
    const key = `${result.runtimeFamily}|${result.resumeMode}`;
    if (!groups.has(key)) {
      groups.set(key, {
        runtimeFamily: result.runtimeFamily,
        provider: result.provider,
        resumeMode: result.resumeMode,
      });
    }
    groups.get(key)[result.variant] = result.metrics;
  }
  return [...groups.values()].map((group) => {
    const legacy = group.A || {};
    const attentionCompatibility = group.B || {};
    const providerSpecific = group.C || {};
    return {
      runtimeFamily: group.runtimeFamily,
      provider: group.provider,
      resumeMode: group.resumeMode,
      factCoverage: {
        A: legacy.coverage ?? null,
        B: attentionCompatibility.coverage ?? null,
        C: providerSpecific.coverage ?? null,
      },
      estimatedInputTokens: {
        A: legacy.estimatedInputTokens ?? null,
        B: attentionCompatibility.estimatedInputTokens ?? null,
        C: providerSpecific.estimatedInputTokens ?? null,
      },
      attentionCompatibilityTokenDeltaVsA: Number.isFinite(legacy.estimatedInputTokens)
        && Number.isFinite(attentionCompatibility.estimatedInputTokens)
        ? attentionCompatibility.estimatedInputTokens - legacy.estimatedInputTokens
        : null,
      providerSpecificTokenDeltaVsB: Number.isFinite(attentionCompatibility.estimatedInputTokens)
        && Number.isFinite(providerSpecific.estimatedInputTokens)
        ? providerSpecific.estimatedInputTokens - attentionCompatibility.estimatedInputTokens
        : null,
      toolOutputRatio: {
        A: legacy.toolOutputRatio ?? null,
        B: attentionCompatibility.toolOutputRatio ?? null,
        C: providerSpecific.toolOutputRatio ?? null,
      },
    };
  });
}

async function verifyDurability(events, state) {
  const restartState = buildState(SESSION_ID, events);
  assert.equal(digestEvents(events), restartState.coverage.eventDigest);
  assert.deepEqual(restartState.task, state.task, 'restart replay should preserve task facts');
  assert.deepEqual(restartState.execution, state.execution, 'restart replay should preserve execution facts');

  const historyDir = await mkdtemp(join(tmpdir(), 'ragent-context-benchmark-'));
  const store = createContinuityStore({ historyDir });
  await store.write(SESSION_ID, state, { expectedRevision: 0 });
  await assert.rejects(
    () => store.write(SESSION_ID, state, { expectedRevision: 0 }),
    (error) => error.code === 'CONTINUITY_CAS_MISMATCH',
  );

  return {
    restartReplay: 'passed',
    staleCheckpointCas: 'passed',
    eventDigest: state.coverage.eventDigest,
    checkpointRevision: state.revision,
  };
}

function verifyResumeDecisions() {
  const matched = resolveRuntimeContextResume({
    runtimeFamily: 'codex-app-server-json',
    binding: {
      runtimeFamily: 'codex-app-server-json',
      providerProfile: 'codex-local-chatgpt',
      model: 'gpt-5.6-sol',
      runtimeFingerprint: 'sha256:codex-fixture-runtime',
      instructionRevision: 'sha256:fixture-instructions',
      nativeSessionId: 'codex-fixture-thread',
    },
    target: {
      runtimeFamily: 'codex-app-server-json',
      providerProfile: 'codex-local-chatgpt',
      model: 'gpt-5.6-sol',
      runtimeFingerprint: 'sha256:codex-fixture-runtime',
      instructionRevision: 'sha256:fixture-instructions',
    },
  });
  const agy = resolveRuntimeContextResume({
    runtimeFamily: 'agy-stream-json',
    binding: { nativeSessionId: 'agy-fixture-conversation' },
    target: { runtimeFamily: 'agy-stream-json' },
  });
  const providerSwitch = resolveRuntimeContextResume({
    runtimeFamily: 'claude-stream-json',
    binding: {
      runtimeFamily: 'codex-app-server-json',
      nativeSessionId: 'codex-fixture-thread',
    },
    target: { runtimeFamily: 'claude-stream-json' },
  });
  const modelSwitch = resolveRuntimeContextResume({
    runtimeFamily: 'codex-app-server-json',
    binding: { runtimeFamily: 'codex-app-server-json', model: 'gpt-5.6-sol', nativeSessionId: 'codex-fixture-thread' },
    target: { runtimeFamily: 'codex-app-server-json', model: 'gpt-5.5' },
  });
  const fingerprintSwitch = resolveRuntimeContextResume({
    runtimeFamily: 'codex-app-server-json',
    binding: { runtimeFamily: 'codex-app-server-json', runtimeFingerprint: 'sha256:old', nativeSessionId: 'codex-fixture-thread' },
    target: { runtimeFamily: 'codex-app-server-json', runtimeFingerprint: 'sha256:new' },
  });
  assert.equal(matched.mode, 'native');
  assert.equal(agy.mode, 'semantic');
  assert.equal(agy.reason, 'NATIVE_RESUME_UNSUPPORTED');
  assert.equal(providerSwitch.reason, 'RUNTIME_FAMILY_MISMATCH');
  assert.equal(modelSwitch.reason, 'MODEL_MISMATCH');
  assert.equal(fingerprintSwitch.reason, 'RUNTIME_FINGERPRINT_MISMATCH');
  return {
    nativeResumeAvailable: matched,
    nativeResumeUnavailable: agy,
    providerSwitch: providerSwitch.reason,
    modelSwitch: modelSwitch.reason,
    runtimeFingerprintChange: fingerprintSwitch.reason,
  };
}

export async function runContextContinuityBenchmark() {
  const events = buildFixture();
  const state = buildState(SESSION_ID, events);
  const pendingIndex = events.findIndex((event) => event.type === 'approval_request');
  const pendingEvents = events.slice(0, pendingIndex + 1);
  const pendingState = buildState(`${SESSION_ID}-pending`, pendingEvents);
  const descriptors = buildToolResultDescriptors(events, { sessionId: SESSION_ID });
  const largeDescriptor = descriptors.find((descriptor) => descriptor.toolExecutionId === 'tool-large-output');
  assert.ok(largeDescriptor?.rawOutputRef, 'large tool output must have a raw retrieval reference');
  const range = await readToolResultRange({
    descriptor: largeDescriptor,
    readRaw: async () => LARGE_OUTPUT,
    startByte: 0,
    endByte: 96,
  });
  assert.match(range.text, /build diagnostic line/);

  const finalContexts = [
    buildCanonicalContext({
      runtimeFamily: 'claude-stream-json',
      provider: 'claude',
      hasResume: false,
      events,
      state,
      descriptors,
    }),
    buildCanonicalContext({
      runtimeFamily: 'codex-app-server-json',
      provider: 'codex',
      hasResume: false,
      events,
      state,
      descriptors,
    }),
    buildCanonicalContext({
      runtimeFamily: 'codex-app-server-json',
      provider: 'codex',
      hasResume: true,
      events,
      state,
      descriptors,
    }),
  ];
  const variants = finalContexts.flatMap((context) => ['A', 'B', 'C']
    .map((variant) => compileVariant({ variant, context, state, events, descriptors })));
  const pendingContext = buildCanonicalContext({
    runtimeFamily: 'claude-stream-json',
    provider: 'claude',
    hasResume: false,
    events: pendingEvents,
    state: pendingState,
    descriptors: buildToolResultDescriptors(pendingEvents, { sessionId: `${SESSION_ID}-pending` }),
  });
  const pendingPlan = buildPlan(
    pendingContext,
    pendingState,
    pendingEvents,
    buildToolResultDescriptors(pendingEvents, { sessionId: `${SESSION_ID}-pending` }),
  );
  assert.ok(pendingPlan.selectedItems.some((item) => item.type === 'pending_approval'));

  const receipt = createContextReceipt({
    sessionId: SESSION_ID,
    provider: 'claude',
    resumeId: 'claude-fixture-thread',
    checkpointRevision: state.revision,
    previousCoveredThroughSeq: 0,
    includedFromSeq: 1,
    includedThroughSeq: state.revision,
    eventDigest: state.coverage.eventDigest,
    sourceRevision: state.revision,
    workspaceRevision: state.execution.workspace.snapshotRevision,
    includedSourceRefs: state.task.decisions[0]?.sourceRefs || [],
  });

  const report = {
    schemaVersion: 1,
    mode: 'deterministic-offline-replay',
    fixture: {
      sessionId: SESSION_ID,
      turns: 12,
      eventCount: events.length,
      providers: ['codex', 'claude', 'codex'],
      contains: ['multiple file changes', 'architecture decision and reason', 'failed attempt and reason', 'large tool output', 'pending approval snapshot', 'workspace drift', 'restart replay'],
    },
    verification: {
      eventHistoryIsSourceOfTruth: true,
      continuityReplay: await verifyDurability(events, state),
      executionStateSeparateFromWorkState: state.execution !== state.task,
      largeToolResultRawReference: {
        present: true,
        kind: largeDescriptor.rawOutputRef.kind,
        ref: largeDescriptor.rawOutputRef.ref,
        rangeRead: { startByte: range.startByte, endByte: range.endByte, sha256: range.sha256 },
      },
      pendingApprovalProjection: pendingState.execution.approvals.find((entry) => entry.id === 'approval-provider-replay')?.state || 'missing',
      workspaceDriftProjection: state.execution.workspace?.stale === true,
      resume: verifyResumeDecisions(),
      checkpointProviderReceiptOrder: 'code-path review confirms checkpoint persistence precedes provider cursor mutation; CAS replay passed',
    },
    variants: variants.map(publicVariantResult),
    comparisons: buildComparisons(variants),
    handoffBehaviorMetrics: {
      automated: [
        'fact coverage and fact-level omissions',
        'decision and decision-reason presence',
        'failed-attempt and failure-reason presence',
        'execution-file/validation/approval/workspace-state presence',
        'context input size and conservative token estimate',
        'duplicate context ratio and selected/omitted item counts',
        'tool-output footprint and deterministic lexical recall count',
        'native-resume decision and refusal reason',
        'handoff packet digest and evidence-reference count',
      ],
      manualReviewRequired: {
        repeatedExploration: 'not-measured: offline replay has no live Agent after handoff',
        repeatedFileReads: 'not-measured: offline replay has no live Agent after handoff',
        repeatedToolExecutions: 'not-measured: offline replay has no live Agent after handoff',
        repeatedFailedStrategies: 'not-measured: offline replay has no live Agent after handoff',
        firstUsefulActionTurns: 'not-measured: offline replay has no live Agent after handoff',
        whetherAgentFollowedHandoff: 'not-measured: requires live provider replay or human review',
      },
    },
    pendingApprovalPlan: {
      selected: pendingPlan.selectedItems.filter((item) => item.type === 'pending_approval').map(({ content, ...metadata }) => metadata),
      mandatory: pendingPlan.selectedItems.some((item) => item.type === 'pending_approval' && item.priority === 0),
    },
    metricDefinitions: {
      factCoverage: 'Expected fixture fact is matched only when every needle for that fact is present in the provider carrier.',
      estimatedInputTokens: 'ceil(provider carrier UTF-8-agnostic character count / 3); this is a conservative estimate, not provider usage.',
      duplicateContextRatio: 'Repeated exact carrier blocks divided by all carrier blocks.',
      shadowPlan: 'Variant A still assembles the plan for diagnostics, but does not apply selected items to the model carrier.',
      toolOutputRatio: 'Selected tool descriptor representation characters divided by total compiled carrier characters.',
      recall: 'Number of selected deterministic lexical recall items; no embedding/vector retrieval is used.',
      manualReviewRequired: ['repeated file reads', 'repeated tool execution', 'repeated failed strategy', 'first useful action turns', 'whether an agent actually followed the handoff'],
    },
    rollout: {
      currentStage: 'Stage 0 compatibility-shadow',
      recommendation: 'Keep default compatibility path; allow provider-specific compiler only as internal opt-in until live handoff behavior is measured.',
      stage1Entry: 'Offline replay preserves all P0 facts, no mandatory item is omitted, compiler carrier is deterministic, and no provider-specific compile error occurs.',
      fallback: ['ContextPlan assembly error', 'mandatory budget overflow', 'compiler error', 'missing evidence refs for a required fact', 'workspace drift must remain an explicit warning and never be silently treated as current.'],
    },
    onlineProviderValidation: 'not-run: this benchmark has no provider account/quota and makes no live-provider claim',
    embeddings: 'No - keep deterministic recall for now.',
  };
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const report = await runContextContinuityBenchmark();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
