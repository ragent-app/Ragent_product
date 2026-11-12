#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createSessionTurnCompletionHelpers } from '../chat/session-turn-completion.mjs';

function buildHarness({ publishDelegatedResult } = {}) {
  const sessionState = {
    id: 'session-1',
    tool: 'fake-tool',
    autoRenamePending: true,
    group: 'AgentoC',
    description: 'Goal completion flow',
    goal: {
      objective: 'Finish the migration',
      enabled: true,
      chasing: true,
      status: 'in_progress',
      tokenBudget: 50000,
      tokensUsed: 1200,
      continuationCount: 0,
      continuationLastAt: '',
      continuationLastTokensUsed: null,
      continuationNoProgress: 0,
    },
  };
  const calls = {
    sendMessage: [],
    completionPushes: 0,
    inlineLabels: 0,
  };

  const helpers = createSessionTurnCompletionHelpers({
    allowsSessionTurnCompletionEffects: () => true,
    appendEvent: async () => {},
    broadcastSessionInvalidation: () => {},
    clearRenameState: () => {},
    getCompactionServices: () => ({}),
    getSession: async () => ({ ...sessionState, goal: { ...sessionState.goal } }),
    getSessionQueueCount: () => 0,
    getTaskCardFollowupServices: () => ({}),
    isInternalSession: () => true,
    isReplySelfRepairOperation: () => false,
    isSessionAutoRenamePending: (session) => session?.autoRenamePending === true,
    isSessionRunning: () => false,
    loadHistory: async () => [],
    loadReplySelfCheckTurnContext: async () => ({
      assistantTurnText: 'The migration is partly complete; remaining checks still need work.',
      usage: { totalTokens: 400 },
    }),
    maybeApplyAssistantTaskCard: async () => null,
    maybeApplyAssistantSessionLabels: async () => {
      calls.inlineLabels += 1;
      sessionState.name = 'Migration completion';
      sessionState.autoRenamePending = false;
      return { ...sessionState, goal: { ...sessionState.goal } };
    },
    maybeApplyContextBudget: async () => false,
    mutateSessionMeta: async (sessionId, mutator) => {
      const draft = { ...sessionState, goal: { ...sessionState.goal } };
      const changed = mutator(draft) === true;
      if (changed) {
        Object.assign(sessionState, draft);
        sessionState.goal = { ...draft.goal };
      }
      return { meta: draft, changed };
    },
    normalizeAttachmentSizeBytes: (value) => value,
    normalizePublishedResultAssetAttachments: () => [],
    publishDelegatedResult,
    nowIso: () => '2026-08-31T00:00:00.000Z',
    renameSession: async () => null,
    scheduleQueuedFollowUpDispatch: () => {},
    scheduleSessionTaskCardSuggestion: () => {},
    sendCompletionPush: async () => { calls.completionPushes += 1; },
    sendMessage: async (sessionId, text, attachments, options) => {
      calls.sendMessage.push({ sessionId, text, attachments, options });
    },
    setRenameState: () => {},
    statusEvent: (content) => ({ type: 'status', content }),
    updateRun: async (runId, updater) => updater({ id: runId, replyPublication: { state: 'running' } }),
  });

  return { calls, helpers, sessionState };
}

const { calls, helpers, sessionState } = buildHarness();
await helpers.runSessionTurnCompletionEffects(
  'session-1',
  { ...sessionState },
  {
    id: 'run-1',
    state: 'completed',
    tool: 'fake-tool',
    runtimeFamily: 'claude-stream-json',
  },
  {},
);

assert.equal(calls.inlineLabels, 1, 'the completed foreground turn applies labels exactly once');
assert.equal(calls.sendMessage.length, 1, 'auto-rename must not swallow Goal continuation');
assert.equal(calls.sendMessage[0].options.internalOperation, 'goal_continue');
assert.equal(sessionState.goal.continuationCount, 1, 'continuation accounting is recorded');

await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls.completionPushes, 1, 'rename completion path sends exactly one completion push');

const blocked = buildHarness({ publishDelegatedResult: async () => {
  throw Object.assign(new Error('temporarily unavailable'), { code: 'LINUX_RUN_RESULT_UNAVAILABLE' });
} });
await assert.rejects(blocked.helpers.runSessionTurnCompletionEffects('session-1', { ...blocked.sessionState },
  { id: 'run-1', state: 'completed', tool: 'fake-tool' }, {}), { code: 'LINUX_RUN_RESULT_UNAVAILABLE' });
assert.equal(blocked.calls.inlineLabels, 0, 'completion effects wait for the delegated result');

console.log('test-session-turn-completion-effects: ok');
