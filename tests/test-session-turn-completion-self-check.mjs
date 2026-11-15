#!/usr/bin/env node
import assert from 'assert/strict';
import { isReplySelfCheckWaitingForUser } from '../chat/session-reply-self-check.mjs';
import { createSessionTurnCompletionHelpers } from '../chat/session-turn-completion.mjs';

function buildHelpers({
  userMessage = { content: 'Please finish this task.' },
  assistantTurnText = 'Here is the finished result.',
} = {}) {
  const calls = {
    appendEvent: 0,
    invalidations: 0,
    updateRun: 0,
  };

  const helpers = createSessionTurnCompletionHelpers({
    REPLY_SELF_CHECK_ACCEPT_STATUS: 'Assistant self-check: kept the latest reply as-is.',
    REPLY_SELF_CHECK_DEFAULT_REASON: 'the latest reply left avoidable unfinished work',
    REPLY_SELF_CHECK_REVIEWING_STATUS: 'Assistant self-check: reviewing the latest reply for early stop…',
    REPLY_SELF_REPAIR_INTERNAL_OPERATION: 'reply_self_repair',
    appendEvent: async () => {
      calls.appendEvent += 1;
    },
    broadcastSessionInvalidation: () => {
      calls.invalidations += 1;
    },
    contextOperationEvent: (event) => event,
    getSession: async () => ({
      id: 'session-1',
      tool: 'fake-tool',
    }),
    getSessionQueueCount: () => 0,
    isInternalSession: () => false,
    isReplySelfCheckWaitingForUser,
    loadHistory: async () => [],
    loadReplySelfCheckTurnContext: async () => ({
      userMessage,
      assistantTurnText,
    }),
    nowIso: () => '2026-06-24T00:00:00.000Z',
    statusEvent: (content) => ({ type: 'status', content }),
    updateRun: async (runId, updater) => {
      calls.updateRun += 1;
      return updater({
        id: runId,
        requestId: 'req-1',
        responseId: 'resp-1',
      });
    },
  });

  return { calls, helpers };
}

const previousSetting = process.env.RAGENT_REPLY_SELF_CHECK;
process.env.RAGENT_REPLY_SELF_CHECK = 'all';

try {
  // Reply self-check only runs in goal-chasing sessions; the fixture session
  // carries an actively chasing goal so the positive cases stay meaningful.
  const session = {
    id: 'session-1',
    tool: 'fake-tool',
    archived: false,
    goal: {
      objective: 'Clean imports',
      enabled: true,
      chasing: true,
      status: 'in_progress',
    },
  };
  const finalizedRun = {
    id: 'run-1',
    requestId: 'req-1',
    responseId: 'resp-1',
    state: 'completed',
    tool: 'fake-tool',
  };

  const first = buildHelpers();
  const prepared = await first.helpers.prepareReplySelfCheck('session-1', session, finalizedRun, {});
  assert.ok(prepared, 'ordinary completed runs should still enter reply self-check when enabled');
  assert.equal(first.calls.updateRun, 1, 'ordinary completed runs should update reply publication into reviewing');
  assert.equal(first.calls.appendEvent, 2, 'ordinary completed runs should emit reviewing events');
  assert.equal(first.calls.invalidations, 1, 'ordinary completed runs should invalidate the session once');

  const waiting = buildHelpers({
    assistantTurnText: [
      'I need your deployment preference before I can continue:',
      'A. Deploy to staging',
      'B. Deploy to production',
      'Please choose A or B.',
    ].join('\n'),
  });
  const waitingPrepared = await waiting.helpers.prepareReplySelfCheck('session-1', session, finalizedRun, {});
  assert.equal(waitingPrepared, null, 'a real user preference checkpoint should skip reply self-check');
  assert.equal(waiting.calls.updateRun, 0, 'waiting checkpoints should not rewrite reply publication into reviewing');
  assert.equal(waiting.calls.appendEvent, 0, 'waiting checkpoints should not emit reviewer events');
  assert.equal(waiting.calls.invalidations, 0, 'waiting checkpoints should not invalidate the session for review');

  const alternativeQuestion = buildHelpers({
    assistantTurnText: '北极星建议顺序已经整理好。\n\n要我全做 1-6（一次打包），还是先挑几个？全做的话我就按上面顺序开切片。',
  });
  const alternativePrepared = await alternativeQuestion.helpers.prepareReplySelfCheck('session-1', session, finalizedRun, {});
  assert.equal(alternativePrepared, null, 'a plain X-or-Y user choice question should skip reply self-check');
  assert.equal(alternativeQuestion.calls.updateRun, 0, 'alternative choice checkpoints should not rewrite reply publication into reviewing');
  assert.equal(alternativeQuestion.calls.appendEvent, 0, 'alternative choice checkpoints should not emit reviewer events');
  assert.equal(alternativeQuestion.calls.invalidations, 0, 'alternative choice checkpoints should not invalidate the session for review');

  const delegatedDecision = buildHelpers({
    userMessage: { content: 'You decide / 你决定 which deploy target is best and continue.' },
    assistantTurnText: [
      'I can deploy either target:',
      'A. Deploy to staging',
      'B. Deploy to production',
      'Please choose A or B.',
    ].join('\n'),
  });
  const delegatedPrepared = await delegatedDecision.helpers.prepareReplySelfCheck('session-1', session, finalizedRun, {});
  assert.ok(delegatedPrepared, 'delegated user decisions should still enter reply self-check');
  assert.equal(delegatedDecision.calls.updateRun, 1, 'delegated decisions should update reply publication into reviewing');
  assert.equal(delegatedDecision.calls.appendEvent, 2, 'delegated decisions should emit reviewing events');
  assert.equal(delegatedDecision.calls.invalidations, 1, 'delegated decisions should invalidate the session once');

  const openOffer = buildHelpers({
    assistantTurnText: 'The implementation analysis is complete. If you want, I can make the change now.',
  });
  const openOfferPrepared = await openOffer.helpers.prepareReplySelfCheck('session-1', session, finalizedRun, {});
  assert.ok(openOfferPrepared, 'a single-track open offer should still enter reply self-check');
  assert.equal(openOffer.calls.updateRun, 1, 'open offers should update reply publication into reviewing');
  assert.equal(openOffer.calls.appendEvent, 2, 'open offers should emit reviewing events');
  assert.equal(openOffer.calls.invalidations, 1, 'open offers should invalidate the session once');

  // Non-goal / non-chasing sessions must never enter reply self-check: the
  // assistant's reply ends the turn and the session waits for the user.
  {
    const noGoal = buildHelpers();
    const noGoalPrepared = await noGoal.helpers.prepareReplySelfCheck('session-1', {
      id: 'session-1',
      tool: 'fake-tool',
    }, finalizedRun, {});
    assert.equal(noGoalPrepared, null, 'sessions without a goal should skip reply self-check');
    assert.equal(noGoal.calls.updateRun, 0, 'no-goal sessions should not rewrite reply publication');
    assert.equal(noGoal.calls.appendEvent, 0, 'no-goal sessions should not emit reviewer events');
    assert.equal(noGoal.calls.invalidations, 0, 'no-goal sessions should not invalidate for review');

    const parkedGoal = buildHelpers();
    const parkedPrepared = await parkedGoal.helpers.prepareReplySelfCheck('session-1', {
      id: 'session-1',
      tool: 'fake-tool',
      goal: {
        objective: 'Clean imports',
        enabled: true,
        chasing: false,
      },
    }, finalizedRun, {});
    assert.equal(parkedPrepared, null, 'goal-enabled but non-chasing sessions should skip reply self-check');
    assert.equal(parkedGoal.calls.updateRun, 0, 'non-chasing goal sessions should not rewrite reply publication');
    assert.equal(parkedGoal.calls.appendEvent, 0, 'non-chasing goal sessions should not emit reviewer events');
    assert.equal(parkedGoal.calls.invalidations, 0, 'non-chasing goal sessions should not invalidate for review');
  }

  const second = buildHelpers();
  const skipped = await second.helpers.prepareReplySelfCheck('session-1', session, {
    ...finalizedRun,
    appServerSteerQueue: [
      {
        id: 'steer-1',
        requestId: 'req-steer',
        text: 'Change the final answer.',
        state: 'pending',
      },
    ],
  }, {});
  assert.equal(skipped, null, 'native steer runs should skip automatic reply self-check');
  assert.equal(second.calls.updateRun, 0, 'native steer runs should not rewrite reply publication into reviewing');
  assert.equal(second.calls.appendEvent, 0, 'native steer runs should not emit reviewer events');
  assert.equal(second.calls.invalidations, 0, 'native steer runs should not invalidate the session for skipped review');

  console.log('test-session-turn-completion-self-check: ok');
} finally {
  if (previousSetting === undefined) {
    delete process.env.RAGENT_REPLY_SELF_CHECK;
  } else {
    process.env.RAGENT_REPLY_SELF_CHECK = previousSetting;
  }
}
