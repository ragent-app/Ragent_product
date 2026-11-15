#!/usr/bin/env node
// History replays must not re-open the Decision Sheet for approvals that are
// no longer live. Regression for: scrolling up through older session events
// re-renders past approval_request records, which used to pop the approval
// sheet (with live approve/deny buttons) for approvals already resolved.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import vm from 'vm';

function createNode() {
  return {
    className: '',
    children: [],
    parentNode: null,
    dataset: {},
    textContent: '',
    innerHTML: '',
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      const siblings = this.parentNode.children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parentNode = null;
    },
  };
}

function createHarness() {
  const source = readFileSync(new URL('../static/chat/realtime-render.js', import.meta.url), 'utf8');
  const decisions = [];
  const approvalResponses = [];
  const planEvents = [];
  const planApprovalCards = [];
  const planApprovalResponses = [];
  const messagesInner = createNode();
  const emptyState = createNode();
  messagesInner.appendChild(emptyState);
  const rafQueue = [];
  // Scroll-to-latest FAB is enhancement-only chrome; a no-op stub keeps the
  // harness from crashing while exercising the realtime-render script.
  const fab = {
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
      toggle() {},
    },
    addEventListener() {},
  };

  const context = {
    console,
    window: {},
    performance: {
      now: () => Date.now(),
    },
    document: {
      createElement: () => createNode(),
      getElementById: (id) => (id === 'scrollToBottomFab' ? fab : null),
    },
    messagesInner,
    emptyState,
    currentSessionId: 'session-test',
    messagesEl: {
      scrollHeight: 300,
      scrollTop: 0,
      clientHeight: 100,
      addEventListener() {},
    },
    requestAnimationFrame(callback) {
      rafQueue.push(callback);
      return rafQueue.length;
    },
    cancelAnimationFrame() {},
    renderMarkdownIntoNode() {},
    inThinkingBlock: false,
    currentThinkingBlock: null,
    syncComposerPendingTurnFeedback() {},
    syncSessionTemplateControls() {},
    syncForkButton() {},
    syncShareButton() {},
    renderQueuedMessagePanel() {},
    resetRenderedEventState() {},
    renderedEventState: {},
    shouldAutoScrollMessages() {
      return false;
    },
    shouldCompactMobileThinking() {
      return false;
    },
    renderMessageInto(container, evt, options = {}) {
      const node = createNode();
      node.event = evt;
      node.options = options;
      container.appendChild(node);
      return node;
    },
    renderPlanEvent(evt) {
      planEvents.push(evt);
    },
    renderPlanApprovalCard(evt, options) {
      planApprovalCards.push({ evt, options });
    },
    updatePlanApprovalCardOnResponse(evt) {
      planApprovalResponses.push(evt);
    },
    annotateRenderedEventViewportNodes() {},
    movePlanProgressCardToEnd() {},
    renderOperation() {},
    renderApprovalResponse(evt) {
      approvalResponses.push(evt);
      const node = createNode();
      node.event = evt;
      messagesInner.appendChild(node);
      return node;
    },
  };
  context.window = context;
  context.window.RagentRunActivity = {
    noteFormalOutput() {},
    applyEvent() {},
  };
  context.window.RagentDecisions = {
    noteRequest(evt) {
      decisions.push({ method: 'noteRequest', evt });
    },
    noteResponse(evt) {
      decisions.push({ method: 'noteResponse', evt });
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__api = { renderEvent };`, context);
  return {
    renderEvent: context.__api.renderEvent,
    decisions,
    approvalResponses,
    planEvents,
    planApprovalCards,
    planApprovalResponses,
  };
}

const {
  renderEvent,
  decisions,
  approvalResponses,
  planEvents,
  planApprovalCards,
  planApprovalResponses,
} = createHarness();

function approvalRequest(approvalId, extra = {}) {
  return { type: 'approval_request', approvalId, kind: 'plan', reason: 'plan body', ...extra };
}

function approvalResponse(approvalId) {
  return { type: 'approval_response', approvalId, decision: 'approved' };
}

// Live path (WS/delta push, no options) still feeds the store.
renderEvent(approvalRequest('a1'), false);
assert.deepEqual(
  decisions.map((entry) => entry.method),
  ['noteRequest'],
  'a live approval_request must still notify the Decision Sheet store',
);

// Scroll-up history pagination renders past records — never a live prompt.
renderEvent(approvalRequest('a1'), false, { historyPrepend: true });
assert.deepEqual(
  decisions.map((entry) => entry.method),
  ['noteRequest'],
  'history-preprended approval_request must NOT re-open the Decision Sheet',
);

// Full-sync page renders gate on approvalRequestLiveId:
//  - "" (finished session / nothing live) suppresses every request;
//  - an id admits only the matching (newest unresolved) request;
//  - a non-matching id is suppressed.
renderEvent(approvalRequest('a2'), false, { approvalRequestLiveId: '' });
renderEvent(approvalRequest('a3'), false, { approvalRequestLiveId: 'a4' });
renderEvent(approvalRequest('a4'), false, { approvalRequestLiveId: 'a4' });
assert.deepEqual(
  decisions.map((entry) => entry.evt?.approvalId).filter(Boolean),
  ['a1', 'a4'],
  'full-sync renders must only notify the newest unresolved approval (or none)',
);

// History approval_response keeps its auditable summary line but must not
// clear the sheet (a historical response is not evidence about the current
// pending approval).
const responseBefore = decisions.length;
renderEvent(approvalResponse('a1'), false, { historyPrepend: true });
assert.equal(
  approvalResponses.length,
  1,
  'a history-preprended approval_response must still render the audit summary line',
);
assert.equal(
  decisions.length,
  responseBefore,
  'a history-preprended approval_response must NOT notify the store',
);

// Live approval_response still dismisses the sheet.
renderEvent(approvalResponse('a1'), false);
assert.deepEqual(
  decisions.slice(-1)[0],
  { method: 'noteResponse', evt: approvalResponse('a1') },
  'a live approval_response must still notify the store so the sheet can dismiss',
);

// ---------------------------------------------------------------------------
// Plan proposal <-> Decision Sheet bridge (2026-08-05)
// ---------------------------------------------------------------------------
// Plan-kind approval_requests also render an in-stream plan card. On live
// paths the actions are armed (livePrompt true); history replays render the
// card inert; other kinds stay sheet-only. (The approvalRequest helper above
// defaults to kind plan, so earlier sections already rendered cards; assert
// against a captured baseline.)
const cardBaseline = planApprovalCards.length;
renderEvent(approvalRequest('b1'), false);
assert.equal(
  planApprovalCards.length,
  cardBaseline + 1,
  'a live plan-kind approval_request must render the in-stream plan card',
);
assert.equal(
  planApprovalCards[cardBaseline].options.livePrompt,
  true,
  'the card actions must be armed for the live pending approval',
);

renderEvent(approvalRequest('b2'), false, { historyPrepend: true });
assert.equal(
  planApprovalCards.length,
  cardBaseline + 2,
  'a history-preprended plan-kind approval_request still renders the card',
);
assert.equal(
  planApprovalCards[cardBaseline + 1].options.livePrompt,
  false,
  'history-replayed card actions must be inert',
);

renderEvent(approvalRequest('b3'), false, { approvalRequestLiveId: '' });
renderEvent(approvalRequest('b4'), false, { approvalRequestLiveId: 'other' });
renderEvent(approvalRequest('b5'), false, { approvalRequestLiveId: 'b5' });
assert.deepEqual(
  planApprovalCards.slice(cardBaseline + 2).map((entry) => entry.options.livePrompt),
  [false, false, true],
  'full-sync card arming must gate on approvalRequestLiveId like the store feed',
);

renderEvent({ type: 'approval_request', approvalId: 'b6', kind: 'command', command: 'ls' }, false);
assert.equal(
  planApprovalCards.length,
  cardBaseline + 5,
  'non-plan approval kinds must stay sheet-only (no in-stream card)',
);

// approval_response flips the in-stream plan card to its final state.
const responseBaseline = planApprovalResponses.length;
renderEvent(approvalResponse('b1'), false);
assert.equal(
  planApprovalResponses.length,
  responseBaseline + 1,
  'approval_response must update the in-stream plan card',
);

// Codex proposals: live awaiting_decision plan events pop the sheet with a
// synthesized approval event (plan:<planId> identity + planEventRef). The
// synthesized event is a vm-realm object, so normalize via JSON before the
// deep comparison.
const plain = (value) => JSON.parse(JSON.stringify(value));
renderEvent({ type: 'plan', planId: 'p1', state: 'awaiting_decision', title: 'T', bodyMarkdown: 'plan body', runId: 'r1' }, false);
assert.deepEqual(
  plain(decisions.slice(-1)[0]),
  {
    method: 'noteRequest',
    evt: {
      type: 'approval_request',
      approvalId: 'plan:p1',
      kind: 'plan',
      status: 'pending',
      title: 'T',
      reason: 'plan body',
      runId: 'r1',
      planEventRef: { planId: 'p1' },
    },
  },
  'a live awaiting_decision plan must pop the Decision Sheet with the synthesized event',
);

// History replays of plan events never touch the store (the sheet belongs to
// the live prompt only).
const planReplayBefore = decisions.length;
renderEvent({ type: 'plan', planId: 'p2', state: 'awaiting_decision', bodyMarkdown: 'old' }, false, { historyPrepend: true });
assert.equal(
  decisions.length,
  planReplayBefore,
  'a history-preprended awaiting_decision plan must NOT notify the store',
);

// Full-sync page renders gate on approvalRequestLiveId (the synthesized id).
renderEvent({ type: 'plan', planId: 'p3', state: 'awaiting_decision' }, false, { approvalRequestLiveId: '' });
renderEvent({ type: 'plan', planId: 'p4', state: 'awaiting_decision' }, false, { approvalRequestLiveId: 'plan:p4' });
renderEvent({ type: 'plan', planId: 'p5', state: 'awaiting_decision' }, false, { approvalRequestLiveId: 'claude:x' });
assert.deepEqual(
  decisions.map((entry) => entry.evt?.approvalId).filter((id) => String(id || '').startsWith('plan:')),
  ['plan:p1', 'plan:p4'],
  'full-sync plan pops must only notify the newest unresolved proposal (or none)',
);

// Codex progress plans (planIntent "progress" / agent interaction mode) are
// execution tracking, never proposals. They render as progress cards but must
// not pop the Decision Sheet.
const progressBefore = decisions.length;
renderEvent({ type: 'plan', planId: 'p-progress', state: 'awaiting_decision', planIntent: 'progress', bodyMarkdown: 'tracking' }, false);
renderEvent({ type: 'plan', planId: 'p-progress-agent', state: 'awaiting_decision', interactionMode: 'agent', bodyMarkdown: 'tracking' }, false);
renderEvent({ type: 'plan', planId: 'p-progress-sync', state: 'awaiting_decision', planIntent: 'progress' }, false, { approvalRequestLiveId: 'plan:p-progress-sync' });
assert.equal(
  decisions.length,
  progressBefore,
  'live progress plans must NOT notify the Decision Sheet store',
);

// Drafting plans are not proposals yet — they never pop the sheet; a pending
// sheet for the same plan dismisses (stale draft), which is a no-op otherwise.
renderEvent({ type: 'plan', planId: 'p6', state: 'drafting', bodyMarkdown: 'wip' }, false);
assert.deepEqual(
  plain(decisions.slice(-1)[0]),
  { method: 'noteResponse', evt: { approvalId: 'plan:p6' } },
  'a drafting plan must not pop the sheet (dismisses a matching one)',
);

// Executing/terminal plan states dismiss a matching sheet.
renderEvent({ type: 'plan', planId: 'p7', state: 'awaiting_decision' }, false);
renderEvent({ type: 'plan', planId: 'p7', state: 'executing' }, false);
assert.deepEqual(
  plain(decisions.slice(-2)),
  [
    {
      method: 'noteRequest',
      evt: { type: 'approval_request', approvalId: 'plan:p7', kind: 'plan', status: 'pending', planEventRef: { planId: 'p7' } },
    },
    { method: 'noteResponse', evt: { approvalId: 'plan:p7' } },
  ],
  'an executing plan must dismiss its own sheet',
);

renderEvent({ type: 'plan', planId: 'p8', state: 'completed', runId: 'r8' }, false);
assert.deepEqual(
  plain(decisions.slice(-1)[0]),
  { method: 'noteResponse', evt: { approvalId: 'plan:p8' } },
  'a completed plan must dismiss a matching sheet (no-op when none pending)',
);

console.log('test-chat-approval-history-replay: ok');
