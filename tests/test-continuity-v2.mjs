import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrateContinuityState,
  reduceContinuityEvents,
} from '../chat/continuity-core.mjs';
import { workStateUpdateEvent } from '../chat/normalizer.mjs';
import { buildExecutionStateProjection } from '../chat/execution-state-projection.mjs';

const workUpdate = workStateUpdateEvent({
  operation: 'upsert',
  source: 'agent',
  facts: [
    {
      kind: 'decision',
      id: 'decision-runtime',
      value: {
        statement: 'Keep the existing Node control plane.',
        reason: 'The transcript and detached Run stores are already durable.',
        status: 'accepted',
      },
    },
    {
      kind: 'failed_attempt',
      id: 'attempt-legacy-resume',
      value: {
        approach: 'Reuse the provider thread after a profile change.',
        failure: 'The runtime binding no longer matches the thread.',
        retryCondition: 'Only retry after the binding fingerprint matches.',
      },
    },
    {
      kind: 'completed_work',
      id: 'work-checkpoint',
      value: { text: 'Added a deterministic continuity checkpoint.' },
    },
  ],
});
assert.ok(workUpdate);

const events = [
  { seq: 1, type: 'message', role: 'user', content: 'Make session handoff deterministic.' },
  { seq: 2, ...workUpdate },
  {
    seq: 3,
    type: 'plan',
    planId: 'plan-1',
    state: 'running',
    items: [
      { text: 'Reduce durable events.', status: 'completed' },
      { text: 'Validate provider binding.', status: 'pending' },
    ],
  },
  {
    seq: 4,
    type: 'file_change',
    filePath: 'chat/continuity-core.mjs',
    changeType: 'edit',
    contentHash: 'sha256:file-current',
    baselineHash: 'sha256:file-before',
    runId: 'run-1',
  },
  {
    seq: 5,
    type: 'tool_result',
    toolName: 'npm test',
    output: 'test-continuity-v2: ok',
    exitCode: 0,
    runId: 'run-1',
    provider: 'codex',
    runtimeFamily: 'codex-app-server-json',
    model: 'gpt-5.6-sol',
  },
  { seq: 6, type: 'approval_request', approvalId: 'approval-1', status: 'pending', runId: 'run-1' },
  { seq: 7, type: 'approval_response', approvalId: 'approval-1', decision: 'approved', runId: 'run-1' },
  { seq: 8, type: 'run_completed', runId: 'run-1', status: 'completed' },
];

const state = reduceContinuityEvents('session-v2', events, {
  executionProjection: buildExecutionStateProjection({
    run: { id: 'run-1', state: 'completed', runnerProcessId: 42 },
    events,
    workspace: { root: 'C:\\work', snapshotRevision: 'workspace-1', stale: false },
    git: {
      state: 'available',
      repositoryRoot: 'C:\\work',
      headCommit: 'abc123',
      trackedDiffHash: 'sha256:tracked',
      untrackedManifestHash: 'sha256:untracked',
      dirty: true,
    },
  }),
});

assert.equal(state.schemaVersion, 2);
assert.equal(state.task.goal.text, 'Make session handoff deterministic.');
assert.equal(state.task.decisions[0].reason, 'The transcript and detached Run stores are already durable.');
assert.equal(state.task.failedAttempts[0].retryCondition, 'Only retry after the binding fingerprint matches.');
assert.equal(state.task.completedWork[0].text, 'Added a deterministic continuity checkpoint.');
assert.equal(state.task.plan.steps[0].status, 'completed');
assert.equal(state.execution.files[0].contentHash, 'sha256:file-current');
assert.equal(state.execution.validations[0].state, 'passed');
assert.equal(state.execution.approvals[0].state, 'approved');
assert.equal(state.execution.tools[0].runtime, 'codex-app-server-json');
assert.equal(state.execution.activeRunId, null);
assert.equal(state.execution.lastRunId, 'run-1');
assert.equal(state.execution.workspace.root, 'C:\\work');
assert.equal(state.execution.git.root, 'C:\\work');
assert.equal(state.execution.git.head, 'abc123');
assert.equal(state.execution.git.trackedDiffHash, 'sha256:tracked');
assert.equal(state.execution.git.dirty, true);
assert.equal(state.objective.raw, state.task.goal.text, 'legacy objective projection remains available');

const activeRunState = reduceContinuityEvents('active-run', [
  { seq: 1, type: 'run_started', runId: 'run-active' },
]);
assert.equal(activeRunState.execution.activeRunId, 'run-active');
const clearedRunState = reduceContinuityEvents('active-run', [
  { seq: 1, type: 'run_started', runId: 'run-active' },
  { seq: 2, type: 'run_completed', runId: 'run-active', status: 'completed' },
]);
assert.equal(clearedRunState.execution.activeRunId, null);

const observedExecutionState = reduceContinuityEvents('observed-execution', [
  {
    seq: 1,
    type: 'execution_observation',
    execution: {
      workspace: { root: 'C:\\work', snapshotRevision: 'workspace-observed', stale: true },
      git: { root: 'C:\\work', head: 'head-observed' },
    },
  },
]);
assert.equal(observedExecutionState.execution.workspace.snapshotRevision, 'workspace-observed');
assert.equal(observedExecutionState.execution.workspace.stale, true);
assert.equal(observedExecutionState.execution.git.head, 'head-observed');

const resolved = reduceContinuityEvents('resolve-fact', [
  { seq: 1, ...workStateUpdateEvent({
    operation: 'upsert',
    source: 'user',
    facts: [{ kind: 'blocker', id: 'blocker-1', value: { text: 'Waiting for input.' } }],
  }) },
  { seq: 2, ...workStateUpdateEvent({
    operation: 'resolve',
    source: 'user',
    facts: [{ kind: 'blocker', id: 'blocker-1' }],
  }) },
]);
assert.equal(resolved.task.blockers[0].status, 'resolved');

const privileged = reduceContinuityEvents('privileged', [
  {
    seq: 1,
    type: 'privileged_batch_request',
    batchId: 'batch-1',
    other: [{ approvalId: 'approval-priv-1', manifestHash: 'sha256:scope' }],
  },
  {
    seq: 2,
    type: 'privileged_batch_response',
    batchId: 'batch-1',
    category: 'other',
    decisions: { 'approval-priv-1': 'approve' },
  },
]);
assert.equal(privileged.execution.approvals[0].state, 'approved');

const legacy = migrateContinuityState('legacy-v1', {
  schemaVersion: 1,
  revision: 4,
  coverage: { coveredThroughSeq: 4, eventDigest: 'sha256:old', omittedRanges: [] },
  objective: { raw: 'Migrate this checkpoint.', sourceSeq: 1 },
  status: 'running',
  files: [{ id: 'file-1', path: 'old.txt', changeType: 'update' }],
  validations: [{ id: 'test-1', name: 'npm test', exitCode: 0 }],
  blockers: [],
  decisions: [],
  execution: { activeRunId: 'run-old', lastRunId: 'run-old' },
});
assert.equal(legacy.schemaVersion, 2);
assert.equal(legacy.task.goal.text, 'Migrate this checkpoint.');
assert.equal(legacy.execution.files[0].path, 'old.txt');
assert.equal(legacy.execution.activeRunId, 'run-old');

const tempHome = await mkdtemp(join(tmpdir(), 'ragent-binding-'));
process.env.HOME = tempHome;
process.env.RAGENT_PUBLIC_BASE_URL = '';
await mkdir(join(tempHome, '.config', 'ragent'), { recursive: true });
const {
  buildProviderRuntimeFingerprint,
  resolveResumeState,
} = await import('../chat/session-manager.mjs');
const target = {
  provider: 'claude',
  runtimeFamily: 'claude-stream-json',
  providerProfile: 'default',
  providerCapabilities: { supportsResume: true },
  options: { model: 'claude-sonnet', providerProfile: 'default' },
};
const fingerprint = buildProviderRuntimeFingerprint({ manifest: target, folder: 'C:\\work' });
const bindingSession = {
  claudeSessionId: 'claude-thread-1',
  providerContext: {
    claude: {
      resumeId: 'claude-thread-1',
      runtimeFingerprint: fingerprint,
      instructionRevision: 'instruction-1',
      trustState: 'validated',
    },
  },
};
assert.equal(resolveResumeState('claude', bindingSession, {
  runtimeFamily: 'claude-stream-json',
  runtimeFingerprint: fingerprint,
  instructionRevision: 'instruction-1',
}).hasResume, true);
const mismatch = resolveResumeState('claude', bindingSession, {
  runtimeFamily: 'claude-stream-json',
  runtimeFingerprint: 'sha256:changed',
  instructionRevision: 'instruction-1',
});
assert.equal(mismatch.hasResume, false);
assert.equal(mismatch.reason, 'RUNTIME_FINGERPRINT_MISMATCH');
const instructionMismatch = resolveResumeState('claude', bindingSession, {
  runtimeFamily: 'claude-stream-json',
  runtimeFingerprint: fingerprint,
  instructionRevision: 'instruction-2',
});
assert.equal(instructionMismatch.hasResume, false);
assert.equal(instructionMismatch.reason, 'INSTRUCTION_REVISION_MISMATCH');

const agyTarget = {
  provider: 'antigravity',
  runtimeFamily: 'agy-json',
  providerProfile: 'agy-work',
  providerCapabilities: { supportsResume: true },
  options: { model: 'gemini-3.7-flash', providerProfile: 'agy-work' },
};
const agyFingerprint = buildProviderRuntimeFingerprint({ manifest: agyTarget, folder: 'C:\\work' });
const agyBindingSession = {
  agyConversationId: 'agy-conversation-work',
  agyProviderProfileId: 'agy-work',
  providerContext: {
    agy: {
      resumeId: 'agy-conversation-work',
      runtimeFingerprint: agyFingerprint,
      instructionRevision: 'instruction-agy-1',
      trustState: 'validated',
    },
  },
};
const agyResume = resolveResumeState('agy', agyBindingSession, {
  runtimeFamily: 'agy-json',
  providerProfile: 'agy-work',
  runtimeFingerprint: agyFingerprint,
  instructionRevision: 'instruction-agy-1',
});
assert.equal(agyResume.hasResume, true);
assert.equal(agyResume.agyConversationId, 'agy-conversation-work');
const agyAccountSwitch = resolveResumeState('agy', agyBindingSession, {
  runtimeFamily: 'agy-json',
  providerProfile: 'agy-personal',
  runtimeFingerprint: agyFingerprint,
  instructionRevision: 'instruction-agy-1',
});
assert.equal(agyAccountSwitch.hasResume, false);
assert.equal(agyAccountSwitch.reason, 'PROVIDER_ACCOUNT_SWITCHED');

console.log('test-continuity-v2: ok');
