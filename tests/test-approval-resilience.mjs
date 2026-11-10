#!/usr/bin/env node
// Approval resilience (2026-08-06): terminal runs must cancel stream-level
// pending approvals even when run-state tracking was lost, and approval clicks
// must land even when the sidecar never persisted the pending record.
// Regression for: two live sessions showed the same approval card repeatedly
// (auto-allowed tools surfaced as cards) and clicks never registered.
import assert from 'assert/strict';
import { readFileSync } from 'fs';

const { collectUnansweredApprovalRequests, collectUnansweredApprovalRequestsFromHistory } = await import('../chat/session-manager.mjs');

// --- collectUnansweredApprovalRequests: pure scan over normalized events.

const requestA = { type: 'approval_request', approvalId: 'claude:a-1', status: 'pending' };
const requestB = { type: 'approval_request', approvalId: 'claude:b-1', status: 'pending' };
const requestC = { type: 'approval_request', approvalId: 'claude:c-1', status: 'pending' };
const responseA = { type: 'approval_response', approvalId: 'claude:a-1', decision: 'approved' };
const responseC = { type: 'approval_response', approvalId: 'claude:c-1', decision: 'cancelled' };

const events = [requestA, responseA, requestB, requestC, responseC];

// Unresolved = b-1 only (a-1 responded, c-1 responded). The helper derives
// responded ids from the event list itself.
let unresolved = collectUnansweredApprovalRequests(events);
assert.equal(unresolved.length, 1, 'only the truly unanswered request survives the scan');
assert.equal(unresolved[0], requestB);

// Caller-provided cancelIds (run-state loop results) are respected.
unresolved = collectUnansweredApprovalRequests(events, { cancelIds: ['claude:b-1'] });
assert.equal(unresolved.length, 0, 'run-state cancellations must not be duplicated');

// A request that follows its own response (the old auto-allow echo pattern)
// counts as responded — no spurious cancellation for already-resolved ids.
unresolved = collectUnansweredApprovalRequests([
  { type: 'approval_response', approvalId: 'claude:echo-1', decision: 'approved' },
  { type: 'approval_request', approvalId: 'claude:echo-1', status: 'pending' },
]);
assert.equal(unresolved.length, 0, 'response-then-request pairs must not be cancelled');

// Non-approval / malformed events are ignored.
unresolved = collectUnansweredApprovalRequests([
  { type: 'message', content: 'x' },
  { type: 'approval_request', approvalId: '  ' },
  null,
  { type: 'status', content: 'idle' },
]);
assert.equal(unresolved.length, 0, 'malformed entries must not produce cancellations');

// --- session-manager wiring: finalize uses the scan (belt-and-suspenders),
// and submitRuntimeApproval seeds lost pending records from the stream.

const managerSource = readFileSync(new URL('../chat/session-manager.mjs', import.meta.url), 'utf8');

assert.match(
  managerSource,
  /collectUnansweredApprovalRequests\(fullNormalizedEvents,\s*\{\s*cancelIds \}\)/,
  'finalize must scan the run’s normalized events for unresolved approvals',
);
assert.match(
  managerSource,
  /source: 'run-finalize'[\s\S]*?decision: 'cancelled'/,
  'the event-scan cancellations must use the run-finalize source',
);
assert.match(
  managerSource,
  /seedRunApprovalFromSessionStream\(run,\s*normalizedApprovalId\)/,
  'submitRuntimeApproval must fall back to the session stream when run-state tracking is lost',
);
// A cancelled run must terminalize its plan ('cancelled') instead of
// resurrecting it to awaiting_decision — otherwise the Decision Sheet
// re-pops on every full-sync after the request moment has passed.
assert.match(
  managerSource,
  /run\.state === 'cancelled' \? 'cancelled' : 'awaiting_decision'/,
  'finalize must write the cancelled plan state for cancelled runs',
);
// Mid-run plan proposals left awaiting_decision when their run ends must be
// terminalized too (planAction flow only covers manifest-owned plans).
assert.match(
  managerSource,
  /runPlanStates[\s\S]*?state !== 'awaiting_decision'[\s\S]*?state: 'cancelled'/,
  'finalize must terminalize mid-run plan proposals left awaiting_decision',
);
// Session-wide sweep: a proposal from an EARLIER run whose run has already
// ended never appears in this run's projection, so it stays
// awaiting_decision (and re-pops the Decision Sheet) forever. The finalize
// sweep must cover the whole session history, not just this run, and only
// touch plans whose run is already terminal.
assert.match(
  managerSource,
  /sessionPlanStates[\s\S]*?state !== 'awaiting_decision'[\s\S]*?state: 'cancelled'/,
  'finalize must terminalize stale proposals from earlier terminal runs',
);
assert.match(
  managerSource,
  /(?:loadHistory\(sessionId,\s*\{\s*includeBodies:\s*false\s*\}\)|readPlanEvents\(sessionId\))/,
  'the session-wide sweep must scan all plan events',
);
assert.match(
  managerSource,
  /isTerminalRunState\(planRun\.state\)/,
  'the session-wide sweep must only touch plans whose run is already terminal',
);
assert.match(
  managerSource,
  /appServerPendingApprovals:\s*\[[\s\S]*?pending,\s*\]/,
  'the seeded record must be persisted so the sidecar drain can deliver it',
);
// A run that ends with an unanswered privileged batch must emit a cancelled
// privileged_batch_response per open group (source run-finalize), so the batch
// sheet dismisses exactly like the approval cards above.
assert.match(
  managerSource,
  /privileged_batch_request[\s\S]*?source: 'run-finalize'/,
  'finalize must emit cancelled responses for unanswered privileged batch groups',
);
assert.match(
  managerSource,
  /normalized === 'other'[\s\S]*?return CATEGORY_OTHER[\s\S]*?normalized === 'delete'[\s\S]*?return CATEGORY_DELETE/,
  'normalizePrivilegedApprovalCategory must accept the sheet short names (other/delete)',
);

// --- 2026-08-08 delta-tick suppression leak: history-level sweep.
// The delta projection used to create a fresh adapter per observer tick, so an
// autoApproved echo (tick N) never met its control_request (tick N+1): cards
// popped for every auto-approved tool. The fix caches one adapter instance per
// run AND finalize additionally cancels leak events already persisted to
// session history, keyed by run id, so they cannot re-pop after the run ends.

const historyEvents = [
  // from run-1: one answered, one pending leak (this is the sweep target)
  { type: 'approval_request', approvalId: 'claude:leak-1', runId: 'run-1', status: 'pending' },
  { type: 'approval_response', approvalId: 'claude:leak-1', decision: 'approved', runId: 'run-1' },
  { type: 'approval_request', approvalId: 'claude:leak-2', runId: 'run-1', status: 'pending' },
  // from run-2: pending but NOT this run — the history sweep must skip it
  { type: 'approval_request', approvalId: 'claude:other-run-1', runId: 'run-2', status: 'pending' },
  // no runId (older format) — unowned, excluded from the run-scoped scan;
  // the session-level sweep (sweepStaleApprovalsInSession) covers these via
  // the run's terminal state instead
  { type: 'approval_request', approvalId: 'claude:legacy-1', status: 'pending' },
  // already cancelled via run-state cancelIds — must not double-cancel
  { type: 'approval_request', approvalId: 'claude:cancel-me', runId: 'run-1', status: 'pending' },
  // garbage must not crash the scan
  { type: 'message', content: 'hi' },
  null,
];
const historyLeaks = collectUnansweredApprovalRequestsFromHistory(historyEvents, 'run-1', {
  cancelIds: ['claude:cancel-me'],
});
assert.equal(historyLeaks.length, 1, 'history sweep must return only pending approvals of this run');
assert.deepEqual(
  historyLeaks.map((e) => e.approvalId),
  ['claude:leak-2'],
  'answered/cancelled/other-run/unowned events must be excluded',
);

// finalize must run the history sweep keyed by this run id, and emit
// cancelled responses with the run-finalize source and the run id attached.
assert.match(
  managerSource,
  /collectUnansweredApprovalRequestsFromHistory\(finalizeHistory,\s*run\.id,\s*\{\s*cancelIds\s*\}\)/,
  'finalize must cancel leak approvals already persisted in session history',
);
assert.match(
  managerSource,
  /source: 'run-finalize'[\s\S]*?runId: run\.id/,
  'the history sweep cancellations must carry the finalized run id',
);
// Session-wide sweep (in-process appendEvent, immune to the external-writer
// race): stale approvals from every protocol are reconciled against their run
// at finalize and once at boot for historical leaks.
assert.match(
  managerSource,
  /sweepStaleApprovalsInSession\(sessionId,\s*\{\s*cancelIds,\s*requestId: run\.requestId/,
  'finalize must reconcile approvals across the session, including the current terminal run',
);
assert.match(
  managerSource,
  /export async function sweepStaleApprovalsAcrossSessions/,
  'boot backfill must be exported for the chat server entrypoint',
);
// The delta projection must hold one adapter per run (so the autoApproved Set
// survives across observer ticks) and release it when observation stops.
const projectionSource = readFileSync(new URL('../chat/run-projection.mjs', import.meta.url), 'utf8');
assert.match(
  projectionSource,
  /deltaRuntimeInvocationByRunId[\s\S]*?getOrCreateDeltaRuntimeInvocation\(run,\s*manifest\)/,
  'the delta projection must cache one runtime invocation per run across ticks',
);
assert.match(
  projectionSource,
  /payload\.type !== 'agentoc\.approval_response' \|\| payload\.autoApproved !== true/,
  'restarted services must seed the suppression set from spooled autoApproved echoes',
);
assert.match(
  projectionSource,
  /releaseRunRuntimeInvocation\(runId\)[\s\S]*?deltaRuntimeInvocationByRunId\.delete\(runId\)/,
  'releaseRunRuntimeInvocation must drop the per-run adapter cache entry',
);
const chatServerSource = readFileSync(new URL('../chat-server.mjs', import.meta.url), 'utf8');
assert.match(
  chatServerSource,
  /sessionManager\.sweepStaleApprovalsAcrossSessions\?\.\(\)/,
  'the chat server must trigger the boot backfill sweep at startup',
);

console.log('approval resilience tests passed');
