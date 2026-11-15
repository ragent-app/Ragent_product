#!/usr/bin/env node
// Stage 1 parity guard: the extracted core/session-status.js must stay
// semantically identical to the live façade static/chat/session-state-model.js
// until Stage 3+ rewires consumers to the core. Both IIFEs load in Node; the
// legacy module falls back to its bundled English strings when ragentT is
// absent, which is exactly what core/ carries as labelRaw/titleRaw, so every
// projection is directly comparable.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function loadIife(relPath, globalName) {
  const context = { console };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(repoRoot, relPath), 'utf8'), context, { filename: relPath });
  assert.ok(context[globalName], `${relPath} should attach ${globalName}`);
  return context[globalName];
}

const legacy = loadIife('static/chat/session-state-model.js', 'RagentSessionStateModel');
const core = loadIife('static/chat/core/session-status.js', 'RagentSessionStatusCore');

// Shared raw projection surface: both implementations must agree field for
// field (no label mapping involved).
function assertSameProjection(name, session, fn) {
  // vm-created objects carry the sandbox realm's Object.prototype, which
  // deepStrictEqual treats as a difference; strip to plain main-realm objects.
  assert.deepEqual(
    JSON.parse(JSON.stringify(core[fn](session))),
    JSON.parse(JSON.stringify(legacy[fn](session))),
    `${name}: ${fn}`,
  );
}

// Status-shaped results: legacy returns {key,label,title,className,...},
// core returns {key,labelKey,labelRaw,titleKey,titleRaw,vars}. The fallback
// translate of the legacy module yields the same raw strings as labelRaw /
// titleRaw, so compare key + mapped labels.
function assertSameStatus(name, value, fn, options) {
  const got = core[fn](value, options);
  const want = legacy[fn](value, options);
  assert.equal(got?.key ?? null, want?.key ?? null, `${name}: ${fn}.key`);
  if (want) {
    assert.equal(got.labelRaw, want.label, `${name}: ${fn}.labelRaw`);
    assert.equal(got.titleRaw ?? '', want.title ?? '', `${name}: ${fn}.titleRaw`);
  }
}

const sessions = [
  ['null-session', null],
  ['empty-session', {}],
  ['running', {
    id: 'running',
    lastEventAt: '2026-03-14T10:00:00.000Z',
    activity: { run: { state: 'running', phase: 'executing', startedAt: '2026-03-14T11:00:00.000Z', runId: 'r1', cancelRequested: true } },
  }],
  ['agy-provider-slot-wait', {
    id: 'agy-provider-slot-wait',
    activity: {
      run: {
        state: 'running',
        phase: 'queued',
        runId: 'agy-queued',
        providerSlot: { state: 'waiting', queuedAt: '2026-03-14T11:00:00.000Z' },
      },
    },
  }],
  ['queued', {
    id: 'queued',
    workflowState: 'parked',
    lastEventAt: '2026-03-14T09:00:00.000Z',
    activity: { queue: { state: 'queued', count: 2 } },
  }],
  ['planning-checking', {
    id: 'planning',
    activity: { planning: { state: 'checking', count: 1, requestId: 'p1' } },
  }],
  ['compact-pending', {
    id: 'compact',
    activity: { compact: { state: 'pending' } },
  }],
  ['rename-pending', {
    id: 'renaming',
    activity: { rename: { state: 'pending' } },
  }],
  ['rename-failed', {
    id: 'rename-failed',
    activity: { rename: { state: 'failed', error: 'in use' } },
  }],
  ['waiting-unread', {
    id: 'waiting-unread',
    workflowState: 'waiting_user',
    workflowStateChangedAt: '2026-03-14T12:00:00.000Z',
    lastAssistantMessageAt: '2026-03-14T12:00:00.000Z',
    lastReviewedAt: '2026-03-14T10:00:00.000Z',
    lastEventAt: '2026-03-14T12:00:00.000Z',
    lastActivityAt: '2026-03-14T12:00:00.000Z',
  }],
  ['done-reviewed', {
    id: 'done-reviewed',
    workflowState: 'done',
    lastEventAt: '2026-03-14T13:00:00.000Z',
    lastAssistantMessageAt: '2026-03-14T13:00:00.000Z',
    lastReviewedAt: '2026-03-14T13:00:00.000Z',
  }],
  ['done-unreviewed', {
    id: 'done-unreviewed',
    workflowState: 'done',
    lastEventAt: '2026-03-14T13:00:00.000Z',
    lastAssistantMessageAt: '2026-03-14T13:00:00.000Z',
    lastReviewedAt: '2026-03-14T12:00:00.000Z',
  }],
  ['pre-upgrade-waiting', {
    id: 'pre-upgrade',
    workflowState: 'waiting_user',
    lastEventAt: '2026-03-14T11:00:00.000Z',
    lastReviewedAt: '2026-03-14T11:00:00.000Z',
  }],
  ['no-timestamps-waiting', {
    id: 'no-stamps',
    workflowState: 'waiting_user',
  }],
  ['tool-fallback', { id: 'tool', tool: 'npm test' }],
  ['gunk-activity', {
    id: 'gunk',
    activity: {
      run: { state: 'paused', startedAt: 7 },
      queue: { state: 'queued', count: 0 },
      planning: { state: 'checking', count: 0 },
      compact: { state: 'done' },
      rename: { state: 'done', error: 3 },
    },
  }],
];

for (const [name, session] of sessions) {
  const now = 1763000000000;
  for (const fn of [
    'normalizeSessionActivity',
    'normalizeSessionWorkflowState',
    'normalizeSessionWorkflowPriority',
    'isSessionBusy',
    'getSessionSortTime',
    'hasSessionUnreadUpdate',
    'hasSessionNeedsAction',
    'getSessionAttentionBand',
    'isSessionCompleteAndReviewed',
  ]) {
    assertSameProjection(name, session, fn);
  }
  assertSameStatus(name, session, 'getSessionReviewStatusInfo');
  assertSameStatus(name, session, 'getSessionWorkflowPriorityInfo');
  assertSameStatus(name, session, 'getSessionPrimaryStatus');
  assertSameStatus(name, session, 'getSessionStatusSummary');
  assertSameStatus(name, session, 'getSessionTaskFlowStage', { now, includeIdle: false });
  assertSameStatus(name, session, 'getSessionVisualStatus', { now, includeIdle: false });
}

// Indicator arrays must agree key-for-key, and the queued title must carry the
// same interpolated text (guards the vars path).
for (const [name, session] of sessions) {
  const want = legacy.getSessionStatusSummary(session);
  const got = core.getSessionStatusSummary(session);
  // Each IIFE runs in its own vm realm, so even identical arrays carry
  // distinct Array.prototype identities — compare primitive-level.
  assert.equal(
    got.indicators.map((status) => status.key).join(','),
    want.indicators.map((status) => status.key).join(','),
    `${name}: indicator keys`,
  );
  if (name === 'queued') {
    assert.equal(got.primary.titleRaw, '2 follow-ups queued');
    assert.deepEqual(JSON.parse(JSON.stringify(got.primary.vars)), { count: 2, suffix: 's' });
  }
}

// Pending-send task-flow stages (uploading / sending / checking / processing)
// and slow-checking cutoff are now-based; pin `now` for determinism.
const sendStages = [
  ['uploading', { stage: 'uploading', startedAt: '2026-03-14T11:00:00.000Z' }],
  ['sending', { stage: 'sending', startedAt: '2026-03-14T11:00:00.000Z' }],
  ['checking', { stage: 'checking', startedAt: '2026-03-14T11:00:00.000Z' }],
  ['processing', { stage: 'processing', startedAt: '2026-03-14T11:00:00.000Z' }],
  ['slow-checking', { stage: 'checking', startedAt: '2026-03-14T10:00:00.000Z' }],
  ['wrong-session', { sessionId: 'other', stage: 'uploading' }],
];
for (const [name, pendingSend] of sendStages) {
  const session = { id: 'sender', pendingSend };
  assertSameStatus(name, session, 'getSessionTaskFlowStage', { now: 1763000000000, includeIdle: false });
}

// Approval waiting classification (kind/risk/question) and live-bar danger risk.
const approvals = [
  ['plan', { kind: 'plan' }],
  ['question-kind', { kind: 'question' }],
  ['question-field', { question: 'Proceed?' }],
  ['questions-array', { questions: [{ question: 'a' }] }],
  ['command-danger', { kind: 'command', risk: 'danger' }],
  ['command-elevated', { kind: 'command', severity: 'elevated' }],
  ['command-critical', { kind: 'command', level: 'critical' }],
  ['command-clean', { kind: 'command' }],
  ['permissions-risk', { kind: 'permissions', riskLevel: 'high' }],
  ['null', null],
  ['empty', {}],
  ['unknown-kind', { kind: 'weird' }],
];
for (const [name, approval] of approvals) {
  assertSameStatus(name, approval, 'resolveApprovalWaitingStatus');
  assert.equal(core.resolveLiveBarDangerRisk(approval), legacy.resolveLiveBarDangerRisk(approval), `${name}: danger risk`);
}

// Workflow status info shapes (legacy has no exported value-level priority
// lookup; the session-level path is covered by getSessionWorkflowPriorityInfo).
for (const value of ['waiting_user', 'waiting', 'needs_input', 'done', 'complete', 'parked', 'paused', 'bogus', '', null]) {
  const want = legacy.getWorkflowStatusInfo(value);
  const got = core.getWorkflowStatusInfo(value);
  assert.equal(got?.key ?? null, want?.key ?? null, `status ${value}: key`);
  if (want) {
    assert.equal(got.labelRaw, want.label, `status ${value}: label`);
    assert.equal(got.titleRaw, want.title, `status ${value}: title`);
  }
}

// Ready/empty status shapes.
assert.equal(core.createReadyStatus().key, legacy.createReadyStatus().key);
assert.equal(core.createReadyStatus().labelRaw, legacy.createReadyStatus().label);
assert.equal(core.createEmptyStatus().key, legacy.createEmptyStatus().key);

// List sort must produce the identical order (pins, sidebar order, sort time,
// attention band, priority, id fallback).
const sortSessions = [
  { id: 'a-late-pinned', pinned: true, sidebarOrder: 10, lastEventAt: '2026-03-14T13:00:00.000Z' },
  { id: 'b-early-pinned', pinned: true, sidebarOrder: 5, lastEventAt: '2026-03-14T13:00:00.000Z' },
  { id: 'c-running', lastEventAt: '2026-03-14T08:00:00.000Z', activity: { run: { state: 'running', startedAt: '2026-03-14T11:00:00.000Z' } } },
  { id: 'd-unread-waiting', workflowState: 'waiting_user', workflowStateChangedAt: '2026-03-14T12:00:00.000Z', lastAssistantMessageAt: '2026-03-14T12:00:00.000Z', lastReviewedAt: '2026-03-14T10:00:00.000Z', lastEventAt: '2026-03-14T12:00:00.000Z' },
  { id: 'e-parked', workflowState: 'parked', lastEventAt: '2026-03-14T09:00:00.000Z' },
  { id: 'f-high-priority', workflowPriority: 'P1', lastEventAt: '2026-03-14T08:30:00.000Z' },
  { id: 'g-same-time', lastEventAt: '2026-03-14T08:30:00.000Z' },
];
const legacyOrder = [...sortSessions].sort(legacy.compareSessionListSessions).map((s) => s.id);
const coreOrder = [...sortSessions].sort(core.compareSessionListSessions).map((s) => s.id);
assert.deepEqual(coreOrder, legacyOrder, 'list sort order');
assert.deepEqual(coreOrder, ['b-early-pinned', 'a-late-pinned', 'd-unread-waiting', 'c-running', 'e-parked', 'f-high-priority', 'g-same-time']);

console.log('test-chat-session-state-parity: ok');
