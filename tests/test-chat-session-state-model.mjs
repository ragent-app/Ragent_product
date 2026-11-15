#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(
  join(repoRoot, 'static', 'chat', 'session-state-model.js'),
  'utf8',
);

const context = { console };
context.globalThis = context;
context.window = context;

vm.runInNewContext(source, context, {
  filename: 'session-state-model.js',
});

const model = context.RagentSessionStateModel;

assert.ok(model, 'session state model should attach to the global scope');

function makeActivity(overrides = {}) {
  return {
    run: {
      state: 'idle',
      phase: null,
      startedAt: null,
      runId: null,
      cancelRequested: false,
      ...overrides.run,
    },
    queue: {
      state: 'idle',
      count: 0,
      ...overrides.queue,
    },
    rename: {
      state: 'idle',
      error: null,
      ...overrides.rename,
    },
    compact: {
      state: 'idle',
      ...overrides.compact,
    },
    planning: {
      state: 'idle',
      count: 0,
      requestId: null,
      ...overrides.planning,
    },
  };
}

function makeSession(overrides = {}) {
  return {
    id: 'session-test',
    activity: makeActivity(),
    ...overrides,
  };
}

const runningSession = makeSession({
  activity: makeActivity({
    run: { state: 'running', phase: 'accepted', runId: 'run-1' },
  }),
});
const runningStatus = model.getSessionStatusSummary(runningSession);
assert.equal(runningStatus.primary.key, 'running');
assert.equal(model.isSessionBusy(runningSession), true);
assert.equal(model.getSessionTaskFlowStage(runningSession).key, 'running');
assert.equal(model.getSessionTaskFlowStage(runningSession).label, 'Working...');

const providerSlotWaitSession = makeSession({
  activity: makeActivity({
    run: {
      state: 'running',
      phase: 'queued',
      runId: 'run-agy-queued',
      providerSlot: { state: 'waiting', queuedAt: '2026-03-14T12:00:00.000Z' },
    },
  }),
});
assert.equal(model.getSessionStatusSummary(providerSlotWaitSession).primary.key, 'provider_slot_wait');
assert.equal(model.getSessionTaskFlowStage(providerSlotWaitSession).key, 'provider_slot_wait');
assert.equal(
  model.getSessionTaskFlowStage(providerSlotWaitSession).label,
  'Waiting for this AgY account to finish its previous task...',
);

const queuedSession = makeSession({
  activity: makeActivity({
    queue: { state: 'queued', count: 2 },
  }),
});
const queuedStatus = model.getSessionStatusSummary(queuedSession);
assert.equal(queuedStatus.primary.key, 'queued');
assert.equal(queuedStatus.primary.title, '2 follow-ups queued');
assert.equal(model.isSessionBusy(queuedSession), true);
assert.equal(model.getSessionTaskFlowStage(queuedSession).key, 'queued');
assert.equal(model.getSessionTaskFlowStage(queuedSession).label, '2 follow-ups queued');

const checkingSession = makeSession({
  activity: makeActivity({
    planning: { state: 'checking', count: 1, requestId: 'req-check' },
  }),
});
assert.equal(model.getSessionTaskFlowStage(checkingSession).key, 'checking');
assert.equal(model.getSessionTaskFlowStage(checkingSession).label, 'Sent, confirming route...');

const slowCheckingSession = makeSession();
const slowCheckingStage = model.getSessionTaskFlowStage(slowCheckingSession, {
  pendingSend: {
    sessionId: 'session-test',
    requestId: 'req-check',
    stage: 'checking',
    startedAt: '2026-03-14T12:00:00.000Z',
  },
  now: Date.parse('2026-03-14T12:00:11.000Z'),
});
assert.equal(slowCheckingStage.key, 'checking');
assert.equal(
  slowCheckingStage.label,
  'Still confirming the route; Ragent will continue here if routing times out.',
);

const compactingSession = makeSession({
  activity: makeActivity({
    compact: { state: 'pending' },
  }),
});
assert.equal(model.getSessionStatusSummary(compactingSession).primary.key, 'compacting');
assert.equal(model.isSessionBusy(compactingSession), true);
assert.equal(model.getSessionTaskFlowStage(compactingSession).key, 'compacting');

const waitingUserStage = model.getSessionTaskFlowStage(makeSession({ workflowState: 'waiting_user' }));
assert.equal(waitingUserStage.key, 'waiting_user');
assert.equal(waitingUserStage.label, 'Waiting for your input');

const renamingSession = makeSession({
  activity: makeActivity({
    rename: { state: 'pending', error: null },
  }),
});
assert.equal(model.getSessionStatusSummary(renamingSession).primary.key, 'renaming');
assert.equal(model.isSessionBusy(renamingSession), false);

const renameFailedSession = makeSession({
  activity: makeActivity({
    rename: { state: 'failed', error: 'rename crashed' },
  }),
});
const renameFailedStatus = model.getSessionStatusSummary(renameFailedSession);
assert.equal(renameFailedStatus.primary.key, 'rename-failed');
assert.equal(renameFailedStatus.primary.title, 'rename crashed');

assert.equal(model.normalizeSessionWorkflowPriority('P1'), 'high');
assert.equal(model.normalizeSessionWorkflowPriority('normal'), 'medium');
assert.equal(model.normalizeSessionWorkflowPriority('later'), 'low');

assert.equal(
  JSON.stringify(model.getWorkflowStatusInfo('waiting-user')),
  JSON.stringify({
    key: 'waiting_user',
    label: 'needs user',
    className: 'status-waiting-user',
    dotClass: '',
    itemClass: '',
    title: 'Blocked on user input',
  }),
  'workflow status info should be normalized from the canonical workflow-state model',
);
assert.equal(
  model.getWorkflowStatusInfo('actively running'),
  null,
  'unknown workflow states should not synthesize fake status badges',
);

const explicitHighPriority = model.getSessionWorkflowPriorityInfo(makeSession({ workflowPriority: 'urgent' }));
assert.equal(explicitHighPriority.key, 'high');
assert.equal(explicitHighPriority.rank, 3);

const workflowPriorityFallback = model.getSessionWorkflowPriorityInfo(
  makeSession({ workflowPriority: 'done-later' }),
);
assert.equal(workflowPriorityFallback.key, 'medium', 'unknown priority strings should fall back to medium attention');

const unreadDoneSession = makeSession({
  workflowState: 'done',
  lastEventAt: '2026-03-14T13:00:00.000Z',
  lastAssistantMessageAt: '2026-03-14T13:00:00.000Z',
  lastReviewedAt: '2026-03-14T12:00:00.000Z',
});
assert.equal(model.hasSessionUnreadUpdate(unreadDoneSession), true, 'idle sessions updated after review should be marked unread');
assert.equal(model.getSessionReviewStatusInfo(unreadDoneSession)?.key, 'unread', 'unread sessions should expose a dedicated review badge');

const userOnlyUpdateSession = makeSession({
  workflowState: 'done',
  lastEventAt: '2026-03-14T13:00:00.000Z',
  lastAssistantMessageAt: '2026-03-14T11:00:00.000Z',
  lastReviewedAt: '2026-03-14T12:00:00.000Z',
});
assert.equal(
  model.hasSessionUnreadUpdate(userOnlyUpdateSession),
  false,
  'new user messages or bookkeeping updates should not mark the session unread without a newer assistant reply',
);

const legacyWaitingWithCleanupTimestamp = makeSession({
  workflowState: 'waiting_user',
  lastActivityAt: '2026-03-14T10:00:00.000Z',
  lastEventAt: '2026-03-14T13:00:00.000Z',
  lastReviewedAt: '2026-03-14T11:00:00.000Z',
});
assert.equal(
  model.hasSessionNeedsAction(legacyWaitingWithCleanupTimestamp),
  false,
  'waiting fallback should use real activity time instead of a later synthetic cleanup event',
);

const completeAndReviewed = makeSession({
  workflowState: 'done',
  lastEventAt: '2026-03-14T13:00:00.000Z',
  lastAssistantMessageAt: '2026-03-14T13:00:00.000Z',
  lastReviewedAt: '2026-03-14T13:00:00.000Z',
});
assert.equal(model.isSessionCompleteAndReviewed(completeAndReviewed), true, 'completed sessions with no unseen updates should be de-emphasized');

const runningUnreadCandidate = makeSession({
  lastEventAt: '2026-03-14T13:00:00.000Z',
  lastAssistantMessageAt: '2026-03-14T13:00:00.000Z',
  lastReviewedAt: '2026-03-14T12:00:00.000Z',
  activity: makeActivity({
    run: {
      state: 'running',
      phase: 'running',
      startedAt: '2026-03-14T11:30:00.000Z',
      runId: 'run-review-1',
    },
  }),
});
assert.equal(model.hasSessionUnreadUpdate(runningUnreadCandidate), false, 'running sessions should not constantly become unread while streaming');

assert.ok(
  model.compareSessionListSessions(
    makeSession({ workflowPriority: 'high', updatedAt: '2026-03-14T12:00:00.000Z' }),
    makeSession({ workflowPriority: 'low', updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) > 0,
  'newer session activity should sort before workflow priority for non-pinned sessions',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({ pinned: true, workflowPriority: 'medium', updatedAt: '2026-03-14T12:00:00.000Z' }),
    makeSession({ workflowPriority: 'medium', updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) < 0,
  'pinned sessions should break ties before recency when priority ties',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({ pinned: true, sidebarOrder: 1, updatedAt: '2026-03-14T12:00:00.000Z' }),
    makeSession({ pinned: true, sidebarOrder: 3, updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) < 0,
  'pinned sessions with explicit sidebar order should keep the intended sidebar order before recency',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({ workflowPriority: 'medium', updatedAt: '2026-03-14T12:00:00.000Z' }),
    makeSession({ workflowPriority: 'medium', updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) > 0,
  'more recent sessions should sort first when priority and pin state tie',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({ sidebarOrder: 1, updatedAt: '2026-03-14T12:00:00.000Z' }),
    makeSession({ sidebarOrder: 3, updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) > 0,
  'newer session activity should sort before explicit sidebar order for non-pinned sessions',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({ sidebarOrder: 1, updatedAt: '2026-03-14T13:00:00.000Z' }),
    makeSession({ sidebarOrder: 3, updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) < 0,
  'lower explicit sidebar order should only break ties when sessions have the same activity time',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({
      updatedAt: '2026-03-14T14:00:00.000Z',
      lastEventAt: '2026-03-14T12:00:00.000Z',
    }),
    makeSession({
      updatedAt: '2026-03-14T13:00:00.000Z',
      lastEventAt: '2026-03-14T13:30:00.000Z',
    }),
  ) > 0,
  'last conversation event time should sort before metadata-only update time',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({
      lastActivityAt: '2026-03-14T10:00:00.000Z',
      lastEventAt: '2026-03-14T13:30:00.000Z',
    }),
    makeSession({
      lastActivityAt: '2026-03-14T12:00:00.000Z',
      lastEventAt: '2026-03-14T12:00:00.000Z',
    }),
  ) > 0,
  'synthetic cleanup events must not outrank the latest real session activity',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({
      workflowState: 'done',
      lastEventAt: '2026-03-14T13:00:00.000Z',
      lastAssistantMessageAt: '2026-03-14T13:00:00.000Z',
      lastReviewedAt: '2026-03-14T12:00:00.000Z',
    }),
    makeSession({
      lastEventAt: '2026-03-14T13:30:00.000Z',
      activity: makeActivity({
        run: {
          state: 'running',
          phase: 'running',
          startedAt: '2026-03-14T11:00:00.000Z',
          runId: 'run-2',
        },
      }),
    }),
  ) < 0,
  'unread completed work should sort ahead of currently running sessions',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({
      lastEventAt: '2026-03-14T13:30:00.000Z',
      activity: makeActivity({
        run: {
          state: 'running',
          phase: 'running',
          startedAt: '2026-03-14T09:00:00.000Z',
          runId: 'run-older',
        },
      }),
    }),
    makeSession({
      lastEventAt: '2026-03-14T11:15:00.000Z',
      activity: makeActivity({
        run: {
          state: 'running',
          phase: 'running',
          startedAt: '2026-03-14T10:00:00.000Z',
          runId: 'run-newer',
        },
      }),
    }),
  ) > 0,
  'running-session ordering should stay anchored to run start time instead of the latest streamed token time',
);

const toolFallbackStatus = model.getSessionStatusSummary(
  makeSession({ tool: 'codex' }),
  { includeToolFallback: true },
);
assert.equal(toolFallbackStatus.primary.key, 'tool');
assert.equal(toolFallbackStatus.primary.label, 'codex');

const idleStatus = model.getSessionStatusSummary(makeSession());
assert.equal(idleStatus.primary.key, 'idle');
assert.equal(idleStatus.primary.label, 'idle');

console.log('test-chat-session-state-model: ok');
