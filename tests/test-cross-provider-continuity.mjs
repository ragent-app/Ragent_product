import assert from 'node:assert/strict';

import { buildExecutionStateProjection } from '../chat/execution-state-projection.mjs';
import { buildCrossProviderContinuityBundle, renderCrossProviderContinuityBundle } from '../chat/cross-provider-continuity.mjs';
import { reduceContinuityEvents } from '../chat/continuity-core.mjs';
import { workStateUpdateEvent } from '../chat/normalizer.mjs';

function withSeq(events, event) {
  events.push({ seq: events.length + 1, ...event });
}

const events = [];
withSeq(events, {
  type: 'message',
  role: 'user',
  content: 'Implement semantic continuity without creating a second source of truth.',
  timestamp: '2026-09-01T01:00:00.000Z',
});
withSeq(events, {
  ...workStateUpdateEvent({
    operation: 'upsert',
    source: 'user',
    facts: [{
      kind: 'decision',
      id: 'decision-canonical-state',
      value: {
        statement: 'Keep one Ragent canonical state and use provider runtimes only as carriers.',
        reason: 'A second planner would split ownership and make cross-provider recovery ambiguous.',
        alternativesConsidered: ['Create a provider-owned task database', 'Copy the full transcript into every provider'],
        rejectedAlternatives: ['Create a provider-owned task database'],
        evidence: ['Existing append-only history and continuity checkpoint'],
        decisionOwner: 'owner',
        reversible: true,
        decidedAt: '2026-09-01T01:02:00.000Z',
      },
    }],
  }),
  timestamp: '2026-09-01T01:02:00.000Z',
});
withSeq(events, {
  ...workStateUpdateEvent({
    operation: 'upsert',
    source: 'agent',
    facts: [{
      kind: 'failed_attempt',
      id: 'attempt-provider-summary',
      value: {
        approach: 'Use a provider summary string as the handoff contract.',
        failure: 'The summary omitted the decision rationale and stale workspace state.',
        rootCause: 'No structured fact envelope or provenance was preserved.',
        result: 'Rejected as insufficient for semantic resume.',
        environment: 'Ragent CE-0 audit fixture',
        version: '2026-09-01',
        retryCondition: 'Retry only after the canonical bundle carries provenance and freshness.',
      },
    }],
  }),
  timestamp: '2026-09-01T01:03:00.000Z',
});
withSeq(events, {
  type: 'file_change',
  filePath: 'src/continuity.mjs',
  changeType: 'add',
  contentHash: 'sha256:file-current',
  runId: 'run-codex-a',
  timestamp: '2026-09-01T01:04:00.000Z',
});
withSeq(events, {
  type: 'tool_result',
  toolName: 'npm test -- continuity',
  output: 'PASS test-cross-provider-continuity',
  exitCode: 0,
  runId: 'run-codex-a',
  timestamp: '2026-09-01T01:05:00.000Z',
});
withSeq(events, {
  type: 'work_state_update',
  operation: 'upsert',
  source: 'agent',
  facts: [{
    kind: 'next_action',
    id: 'next-verify-claude',
    value: { text: 'Start a fresh Claude session, refresh the workspace snapshot, and run the focused transfer check.' },
  }],
  timestamp: '2026-09-01T01:06:00.000Z',
});
withSeq(events, {
  type: 'provider_binding',
  bindingId: 'codex',
  provider: 'codex',
  runtimeFamily: 'codex-app-server-json',
  providerProfile: 'codex-local-chatgpt',
  model: 'gpt-5.6-sol',
  nativeSessionId: 'codex-native-a',
  coveredThroughSeq: 6,
  timestamp: '2026-09-01T01:07:00.000Z',
});

const checkpoint = reduceContinuityEvents('ce1-test-session', events, {
  executionProjection: buildExecutionStateProjection({
    run: { id: 'run-codex-a', state: 'completed' },
    events,
    workspace: {
      root: '/tmp/ce1-test-workspace',
      snapshotRevision: 'workspace-after-external-edit',
      observedAt: '2026-09-01T01:08:00.000Z',
      stale: true,
      staleReason: 'Workspace changed after the last provider observation.',
    },
    git: {
      root: '/tmp/ce1-test-workspace',
      branch: 'main',
      head: 'abc123',
      dirty: true,
    },
  }),
});

const bundle = buildCrossProviderContinuityBundle({
  sessionId: 'ce1-test-session',
  projectId: 'project-continuity',
  sessionName: 'CE-1 transfer',
  checkpoint,
  events,
  constraints: ['Do not resume the Codex native session in Claude.', 'Revalidate stale workspace facts before editing.'],
  targetProvider: 'claude',
  targetRuntimeFamily: 'claude-stream-json',
  generatedAt: '2026-09-01T01:09:00.000Z',
});

assert.equal(bundle.schemaVersion, 1);
assert.equal(bundle.task.goal.value.text, 'Implement semantic continuity without creating a second source of truth.');
assert.equal(bundle.decisions[0].value.reason, 'A second planner would split ownership and make cross-provider recovery ambiguous.');
assert.deepEqual(bundle.decisions[0].value.rejectedAlternatives, ['Create a provider-owned task database']);
assert.equal(bundle.failedAttempts[0].value.rootCause, 'No structured fact envelope or provenance was preserved.');
assert.equal(bundle.failedAttempts[0].value.retryCondition, 'Retry only after the canonical bundle carries provenance and freshness.');
assert.equal(bundle.workspaceState.snapshot.lifecycle, 'refresh-needed');
assert.equal(bundle.workspaceState.git.lifecycle, 'refresh-needed');
assert.equal(bundle.workspaceState.snapshot.provenance.lastVerifiedAt, '2026-09-01T01:08:00.000Z');
assert.equal(bundle.runtimeBindings[0].nativeResume.available, true);
assert.equal(bundle.runtimeBindings[0].nativeResume.transferable, false);
assert.equal(bundle.runtimeBindings[0].nativeResume.reason, 'CROSS_PROVIDER_TRANSFER');
assert.equal(bundle.ephemeralExecution.transferability, 'do-not-inherit');
assert.ok(!JSON.stringify(bundle).includes('codex-native-a'), 'native session ids must not cross provider boundary');
assert.equal(bundle.provenance.eventDigest, checkpoint.coverage.eventDigest);
assert.equal(bundle.provenance.generatedAt, '2026-09-01T01:09:00.000Z');
assert.equal(bundle.freshness.generatedAt, '2026-09-01T01:09:00.000Z');
assert.match(bundle.bundleDigest, /^sha256:/);
assert.doesNotThrow(() => renderCrossProviderContinuityBundle(bundle, { maxChars: 30_000 }));

const regenerated = buildCrossProviderContinuityBundle({
  sessionId: 'ce1-test-session',
  projectId: 'project-continuity',
  sessionName: 'CE-1 transfer',
  checkpoint,
  events,
  constraints: ['Do not resume the Codex native session in Claude.', 'Revalidate stale workspace facts before editing.'],
  targetProvider: 'claude',
  targetRuntimeFamily: 'claude-stream-json',
  generatedAt: '2026-09-01T01:10:00.000Z',
});
assert.equal(regenerated.bundleDigest, bundle.bundleDigest, 'generation time must not affect bundle digest');
assert.notEqual(regenerated.provenance.generatedAt, bundle.provenance.generatedAt);

const unverifiedWorkspace = buildCrossProviderContinuityBundle({
  sessionId: 'ce1-test-session',
  checkpoint: {
    ...checkpoint,
    execution: { ...checkpoint.execution, workspace: { root: '/tmp/unverified-workspace' } },
  },
  events,
  targetProvider: 'claude',
  targetRuntimeFamily: 'claude-stream-json',
  generatedAt: '2026-09-01T01:09:00.000Z',
});
assert.equal(unverifiedWorkspace.workspaceState.snapshot.lifecycle, 'refresh-needed');
assert.equal(unverifiedWorkspace.freshness.state, 'refresh-needed');

const repeated = buildCrossProviderContinuityBundle({
  sessionId: 'ce1-test-session',
  projectId: 'project-continuity',
  sessionName: 'CE-1 transfer',
  checkpoint,
  events,
  constraints: ['Do not resume the Codex native session in Claude.', 'Revalidate stale workspace facts before editing.'],
  targetProvider: 'claude',
  targetRuntimeFamily: 'claude-stream-json',
  generatedAt: '2026-09-01T01:09:00.000Z',
});
assert.deepEqual(repeated, bundle, 'same checkpoint and timestamp must produce the same bundle');

console.log('test-cross-provider-continuity: ok');
