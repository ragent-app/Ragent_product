#!/usr/bin/env node
// tests/test-chat-approval-gate-core.mjs
//
// Stage 2: approval-gate core (static/chat/transport/approval-gate.js) is a
// pure port of session-http-helpers.js's resolvePendingApprovalEvent — the
// Decision Sheet gate that scans a session's event timeline back-to-front and
// decides what is genuinely awaiting a decision right now (approval_request,
// privileged_batch_request category groups, awaiting_decision plans), with a
// first sweep collecting every closing signal so replayed records never
// re-open a resolved sheet. Every scenario runs against BOTH implementations
// with identical event timelines and compares primitive-level outputs, so the
// port cannot drift from the legacy semantics.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function loadLegacy() {
  const context = {
    console,
    Promise,
    Map,
    Set,
    Date,
    Error,
    URL,
    URLSearchParams,
    encodeURIComponent,
    navigator: {},
    window: { addEventListener() {} },
  };
  vm.runInNewContext('let currentSessionId = "";', context);
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8'),
    context,
    { filename: 'session-http-helpers.js' },
  );
  // isApprovalAlreadyEndedError lives in realtime.js (the approval-gate
  // legacy realm covers both files).
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8'),
    context,
    { filename: 'realtime.js' },
  );
  return {
    api: {
      resolvePendingApprovalEvent: (events) => context.resolvePendingApprovalEvent(events),
      isPlanProgressEventLike: (evt) => context.isPlanProgressEventLike(evt),
      isApprovalAlreadyEndedError: (error) => context.isApprovalAlreadyEndedError(error),
    },
    label: 'legacy',
  };
}

function loadCore() {
  const context = {
    console,
    Promise,
    Map,
    Set,
    Date,
    Error,
  };
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/approval-gate.js'), 'utf8'),
    context,
    { filename: 'transport/approval-gate.js' },
  );
  const core = context.RagentApprovalGateCore;
  return {
    api: {
      resolvePendingApprovalEvent: (events) => core.resolvePendingApprovalEvent(events),
      isPlanProgressEventLike: (evt) => core.isPlanProgressEventLike(evt),
      isApprovalAlreadyEndedError: (error) => core.isApprovalAlreadyEndedError(error),
    },
    label: 'transport',
  };
}

function ev(type, overrides = {}) {
  return { type, ...overrides };
}

async function runScenario(impl) {
  const { resolvePendingApprovalEvent: resolve, isPlanProgressEventLike: isProgress } = impl.api;
  const out = {};

  // 1. Plain approval_request, no closing signal → itself.
  out.plain = resolve([ev('approval_request', { approvalId: 'a1', status: 'pending' })]);

  // 2. Response later in the timeline → resolved.
  out.resolvedAfter = resolve([
    ev('approval_request', { approvalId: 'a1' }),
    ev('approval_response', { approvalId: 'a1', status: 'approved' }),
  ]);

  // 3. Replayed request AFTER its response (provider replay) → still resolved.
  out.replayed = resolve([
    ev('approval_response', { approvalId: 'a1', status: 'denied' }),
    ev('approval_request', { approvalId: 'a1' }),
  ]);

  // 4. Terminal status on the request itself → never pending.
  out.terminalStatus = [
    resolve([ev('approval_request', { approvalId: 'a1', status: 'approved' })]),
    resolve([ev('approval_request', { approvalId: 'a1', status: 'CANCELLED' })]),
    resolve([ev('approval_request', { approvalId: 'a1', status: 'pending' })]),
  ];

  // 5. Batch request with unresolved categories → replayed as an
  //    approval_request keyed by the batch id.
  out.batchUnresolved = resolve([
    ev('privileged_batch_request', { batchId: 'b1', other: ['x'], delete: ['y'] }),
  ]);

  // 6. Batch partially resolved (only one category answered) → the remaining
  //    group keeps it pending.
  out.batchPartial = resolve([
    ev('privileged_batch_request', { batchId: 'b1', other: ['x'], delete: ['y'] }),
    ev('privileged_batch_response', { batchId: 'b1', category: 'other' }),
  ]);

  // 7. Batch fully resolved → nothing pending.
  out.batchFullyResolved = resolve([
    ev('privileged_batch_request', { batchId: 'b1', other: ['x'], delete: ['y'] }),
    ev('privileged_batch_response', { batchId: 'b1', category: 'other' }),
    ev('privileged_batch_response', { batchId: 'b1', category: 'delete' }),
  ]);
  out.batchCanonicalUppercaseCategories = resolve([
    ev('privileged_batch_request', { batchId: 'b-uppercase', other: ['x'], delete: ['y'] }),
    ev('privileged_batch_response', { batchId: 'b-uppercase', category: 'PRIVILEGED_OTHER' }),
    ev('privileged_batch_response', { batchId: 'b-uppercase', category: 'DESTRUCTIVE_DELETE' }),
  ]);

  // 8. Batch with no non-empty categories → not a gate.
  out.batchEmptyCategories = [
    resolve([ev('privileged_batch_request', { batchId: 'b1' })]),
    resolve([ev('privileged_batch_request', { batchId: 'b1', other: [], delete: [] })]),
  ];

  // 9. Managed approved-action batch (used by Codex agent.create) is also a
  // Decision Sheet gate when it is replayed by a full-sync/reconnect.
  out.approvedActionPending = resolve([
    ev('approved_action_batch_request', {
      batchId: 'agent-b1',
      actions: [{ actionId: 'agent-a1', state: 'waiting_user' }],
    }),
  ]);
  out.approvedActionFullyResolved = resolve([
    ev('approved_action_batch_request', {
      batchId: 'agent-b2',
      actions: [{ actionId: 'agent-a2', state: 'waiting_user' }],
    }),
    ev('approved_action_state', {
      batchId: 'agent-b2',
      actionId: 'agent-a2',
      state: 'completed',
    }),
  ]);
  out.approvedActionBatchResponseResolved = resolve([
    ev('approved_action_batch_request', {
      batchId: 'agent-b2-response',
      actions: [{ actionId: 'agent-a2-response', state: 'waiting_user' }],
    }),
    ev('approved_action_batch_response', {
      batchId: 'agent-b2-response',
      decisions: { 'agent-a2-response': 'approve' },
    }),
  ]);
  out.approvedActionMixed = resolve([
    ev('approved_action_batch_request', {
      batchId: 'agent-b3',
      actions: [
        { actionId: 'agent-a3-denied', state: 'waiting_user' },
        { actionId: 'agent-a3-open', state: 'waiting_user' },
      ],
    }),
    ev('approved_action_state', {
      batchId: 'agent-b3',
      actionId: 'agent-a3-denied',
      state: 'denied',
    }),
  ]);

  // 10. awaiting_decision plan → replayed as an approval_request with the
  //    plan-typed id and preserved fields.
  out.planPending = resolve([
    ev('plan', {
      planId: 'p1',
      state: 'awaiting_decision',
      title: 'T',
      bodyMarkdown: 'B',
      runId: 'r1',
    }),
  ]);

  // 11. Any later plan state supersedes the awaiting_decision record.
  out.planSuperseded = [
    resolve([
      ev('plan', { planId: 'p1', state: 'awaiting_decision' }),
      ev('plan', { planId: 'p1', state: 'executing' }),
    ]),
    resolve([
      ev('plan', { planId: 'p1', state: 'awaiting_decision' }),
      ev('plan', { planId: 'p1', state: 'cancelled' }),
    ]),
    resolve([
      ev('plan', { planId: 'p1', state: 'awaiting_decision' }),
      ev('plan', { planId: 'p1', state: 'completed' }),
    ]),
  ];

  // 12. Progress plans / agent interaction mode are execution tracking, not
  //     proposals awaiting a decision.
  out.planProgress = [
    resolve([ev('plan', { planId: 'p1', state: 'awaiting_decision', planIntent: 'progress' })]),
    resolve([ev('plan', { planId: 'p1', state: 'awaiting_decision', interactionMode: 'agent' })]),
    resolve([ev('plan', { planId: 'p1', state: 'awaiting_decision', interactionMode: 'human' })]),
  ];

  // 13. Non-decision plan states are not gates.
  out.planOtherState = [
    resolve([ev('plan', { planId: 'p1', state: 'drafting' })]),
    resolve([ev('plan', { planId: 'p1', state: 'superseded' })]),
  ];

  // 14. An approval_response with the plan-typed id closes the plan gate.
  out.planClosedByApproval = resolve([
    ev('plan', { planId: 'p1', state: 'awaiting_decision' }),
    ev('approval_response', { approvalId: 'plan:p1' }),
  ]);

  // 15. Newest genuinely-pending record wins (back-to-front scan).
  out.newestWins = [
    resolve([
      ev('approval_request', { approvalId: 'a1' }),
      ev('approval_request', { approvalId: 'a2' }),
    ]),
    resolve([
      ev('approval_request', { approvalId: 'a1' }),
      ev('approval_request', { approvalId: 'a2' }),
      ev('approval_response', { approvalId: 'a2' }),
    ]),
    resolve([
      ev('privileged_batch_request', { batchId: 'b1', delete: ['y'] }),
      ev('approval_request', { approvalId: 'a2' }),
      ev('privileged_batch_response', { batchId: 'b1', category: 'delete' }),
    ]),
  ];

  // 16. Mixed timeline: resolved early approvals do not mask a later replay.
  out.mixed = resolve([
    ev('approval_response', { approvalId: 'a1' }),
    ev('plan', { planId: 'p1', state: 'awaiting_decision', title: 'T' }),
    ev('approval_request', { approvalId: 'a1' }),
  ]);

  // 17. Non-array / empty inputs.
  out.empty = [
    resolve([]),
    resolve('not-an-array'),
    resolve(null),
    resolve(undefined),
  ];

  // 18. Progress-like classification helper.
  out.progressLike = [
    isProgress(undefined),
    isProgress({}),
    isProgress({ planIntent: 'PROGRESS' }),
    isProgress({ planIntent: 'progress' }),
    isProgress({ planIntent: 'execute' }),
    isProgress({ interactionMode: 'agent' }),
    isProgress({ interactionMode: 'Agent' }),
    isProgress({ interactionMode: 'human' }),
  ];

  // 19. Approval-already-ended error classification (realtime.js).
  const { isApprovalAlreadyEndedError: ended } = impl.api;
  out.ended = [
    ended(undefined),
    ended({}),
    ended({ code: 'APPROVAL_NOT_FOUND' }),
    ended({ code: 'approval_not_found' }), // case-insensitive
    ended({ code: 'RUN_TERMINAL' }),
    ended({ code: 'RUN_NOT_FOUND' }),
    ended({ code: 'OTHER' }),
    ended({ status: 404 }),
    ended({ status: 409 }),
    ended({ status: 410 }),
    ended({ status: 400 }),
    ended({ status: '404' }),
    ended({ status: 404, code: 'OTHER' }),
    ended({ code: 'APPROVAL_NOT_FOUND', status: 200 }),
    ended(null),
  ];

  return JSON.parse(JSON.stringify(out));
}

async function main() {
  const [legacy, core] = [loadLegacy(), loadCore()];
  const [a, b] = await Promise.all([runScenario(legacy), runScenario(core)]);
  assert.deepEqual(b, a, `approval-gate drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-approval-gate-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
