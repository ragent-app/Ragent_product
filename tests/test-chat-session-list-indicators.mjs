#!/usr/bin/env node
// Focused tests for the session-row status indicator resolution
// (getSessionListIndicatorInfo in session-surface-ui.js): running sessions
// keep the spinner, sessions blocked on the user (approval/question) get the
// amber needs-action dot ranked above the unread blue dot, unread-only keeps
// the blue dot, and everything else stays dot-free.
//
// The amber dot clears once the owner has opened the session after the
// waiting state began: hasSessionNeedsAction (session-state-model.js)
// compares workflowStateChangedAt against the effective review stamp.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const surfaceSource = readFileSync(
  join(repoRoot, 'static', 'chat', 'session-surface-ui.js'),
  'utf8',
);
const modelSource = readFileSync(
  join(repoRoot, 'static', 'chat', 'session-state-model.js'),
  'utf8',
);

const context = { console };
context.globalThis = context;
context.window = {
  // t() falls back to the raw key when no translator is installed.
  ragentT: undefined,
};
context.document = {
  // esc() only needs createElement + innerHTML.
  createElement: () => ({ innerHTML: '' }),
  addEventListener: () => {},
  removeEventListener: () => {},
};
context.messageTimeFormatter = new Intl.DateTimeFormat();

// Load the real state model first so hasSessionNeedsAction / unread use the
// production timestamp semantics (lastAssistantMessageAt vs review stamp).
vm.runInNewContext(modelSource, context, { filename: 'session-state-model.js' });
const stateModel = context.RagentSessionStateModel;
assert.ok(stateModel, 'session state model should attach to the global scope');
context.RagentSessionStateModel = stateModel;
context.window.RagentSessionStateModel = stateModel;

// Minimal stand-ins for the surface-ui dependencies the model does not own.
context.getSessionStatusSummary = (session) => ({
  primary: { key: session?.statusKey || 'running', label: session?.statusLabel || 'Running…', title: session?.statusTitle || 'Running' },
});

vm.runInNewContext(surfaceSource, context, { filename: 'session-surface-ui.js' });

const resolve = context.getSessionListIndicatorInfo;

const T10 = '2026-08-05T10:00:00.000Z';
const T11 = '2026-08-05T11:00:00.000Z';

// Running keeps the slow ring indicator.
const running = resolve({ id: 's1', activity: { run: { state: 'running' } }, workflowState: 'running' });
assert.ok(running, 'running session should get an indicator');
assert.equal(running.className, 'session-item-status--running', 'running -> slow ring class');
assert.equal(running.label, 'Running…', 'running label comes from the status summary');

// Fresh wait on the user (state changed after the review stamp) -> amber dot.
const waiting = resolve({
  id: 's2',
  workflowState: 'waiting_user',
  workflowStateChangedAt: T11,
  lastAssistantMessageAt: T11,
});
assert.ok(waiting, 'fresh waiting session should get an indicator');
assert.equal(waiting.className, 'session-item-status--needs-action', 'waiting_user -> needs-action class');
assert.equal(waiting.label, 'status.needsAction', 'needs-action label key (translator absent)');
assert.equal(waiting.title, 'status.needsActionTitle', 'needs-action title key');

// Waiting variants normalize to waiting_user through the model helper.
assert.equal(
  resolve({
    id: 's3',
    workflowState: 'waiting for user',
    workflowStateChangedAt: T11,
    lastAssistantMessageAt: T11,
  }).className,
  'session-item-status--needs-action',
  'workflowState variants normalize to waiting_user',
);

// Waiting without a state-change timestamp (pre-upgrade meta) still shows the
// dot so a real wait is never silently hidden.
const waitingLegacy = resolve({ id: 's4', workflowState: 'waiting_user', lastAssistantMessageAt: T10 });
assert.equal(waitingLegacy.className, 'session-item-status--needs-action', 'waiting without workflowStateChangedAt -> needs-action (conservative)');

// Pre-upgrade waiting session with lastEventAt as the fallback start: shows
// the dot until the owner opens it (review stamp = lastEventAt), then clears.
const waitingLegacyUnseen = resolve({
  id: 's4a',
  workflowState: 'waiting_user',
  lastEventAt: T10,
  lastAssistantMessageAt: T10,
});
assert.equal(waitingLegacyUnseen.className, 'session-item-status--needs-action', 'legacy waiting with lastEventAt and no review -> needs-action');

const waitingLegacySeen = resolve({
  id: 's4b',
  workflowState: 'waiting_user',
  lastEventAt: T10,
  lastAssistantMessageAt: T10,
  lastReviewedAt: T10,
});
assert.equal(waitingLegacySeen, null, 'legacy waiting reviewed at lastEventAt -> no amber dot');

// Waiting beats unread (mirrors attention band 0 < 1).
const waitingUnread = resolve({
  id: 's5',
  workflowState: 'waiting_user',
  workflowStateChangedAt: T11,
  lastAssistantMessageAt: T11,
});
assert.equal(waitingUnread.className, 'session-item-status--needs-action', 'waiting+unread -> needs-action (highest priority)');

// Wait that began before the owner last reviewed the session (opened it after
// the state change) -> no amber dot, and no unread dot either.
const waitingReviewed = resolve({
  id: 's6',
  workflowState: 'waiting_user',
  workflowStateChangedAt: T10,
  lastAssistantMessageAt: T10,
  lastReviewedAt: T11,
});
assert.equal(waitingReviewed, null, 'waiting reviewed after the state change -> no amber dot');

// Unread only -> blue dot.
const unread = resolve({ id: 's7', lastAssistantMessageAt: T11 });
assert.ok(unread, 'unread session should get an indicator');
assert.equal(unread.className, 'session-item-status--unread', 'unread -> unread class');

// No action needed -> no indicator.
assert.equal(resolve({ id: 's8', workflowState: 'done' }), null, 'done -> no indicator');
assert.equal(resolve({ id: 's9', workflowState: 'active' }), null, 'active -> no indicator');
assert.equal(resolve({ id: 's10' }), null, 'no state -> no indicator');

console.log('test-chat-session-list-indicators: ok');
