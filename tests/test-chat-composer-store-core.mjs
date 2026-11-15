#!/usr/bin/env node
// tests/test-chat-composer-store-core.mjs
//
// Stage 1 leftover: core/composer-store.js is a verbatim port of the pure
// state model of composer-store.js (extracted now that the retained-sends
// WIP has landed): normalize*/createState, per-session drafts and
// attachment buckets, pending-send / retained-sends / pending-edit-resend
// records, immutable mutators, deep equality and the store shell
// (createStore/subscribe/dispatch). The legacy global façade (store
// singleton + root-level verbs) stays in the legacy module. Parity: both
// stores run identical createState normalization batteries and dispatch
// sequences; after every dispatch the state snapshots and the subscriber
// notification traces are compared at the primitive level. `startedAt` is
// stripped from comparisons — both sides stamp `new Date().toISOString()`
// when the input omits it, which is never stable across the two realms.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function loadModule(file) {
  const context = { console };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(repoRoot, file), 'utf8'), context, {
    filename: file,
  });
  return context;
}

function loadLegacy() {
  const context = loadModule('static/chat/composer-store.js');
  return { api: context.RagentComposerStore, label: 'legacy' };
}

function loadCore() {
  const context = loadModule('static/chat/core/composer-store.js');
  return { api: context.RagentComposerStoreCore, label: 'core' };
}

// Cross-realm objects compare only at the primitive level; `startedAt` is
// a live timestamp default on both sides and must be dropped.
function normalize(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => (key === 'startedAt' ? '<stamp>' : v)));
}

const ATTACHMENT_A = { originalName: 'shot-a.png', objectUrl: 'blob:a' };
const ATTACHMENT_B = { originalName: 'shot-b.png', objectUrl: 'blob:b' };

function runNormalizeBattery(api) {
  return normalize([
    api.createState({}),
    api.createState({ activeSessionId: '  s1  ' }),
    api.createState({ activeSessionId: '' }),
    api.createState({
      activeSessionId: 's1',
      drafts: { s1: 'draft a', ' s2 ': '   ', s3: 42, s4: 'x', s5: '\n\n' },
      attachmentsBySession: { s1: [ATTACHMENT_A, null, 'x'], s2: [] },
      pendingSend: {
        sessionId: 's1', requestId: 'req_1', text: 'hello',
        images: [ATTACHMENT_B], startedAt: '2026-03-14T12:00:00.000Z',
        baselineEventSeq: -1, baselineActivity: null, stage: 'uploading',
      },
      retainedSends: [
        { sessionId: 's1', requestId: 'req_1', text: 'a', stage: 'sent', awaitingCommit: true, localEcho: false },
        { sessionId: 's1', requestId: 'req_1', text: 'dup', stage: 'processing' },
        { sessionId: 's1', requestId: 'req_2', text: 'b', stage: 'checking' },
        { sessionId: '', requestId: 'req_3', text: 'c' },
        null,
      ],
      pendingEditResend: { sessionId: 's1', requestId: 'req_9', prompt: 'p', attachments: [ATTACHMENT_A] },
    }),
    api.createState({ pendingSend: null, retainedSends: null }),
    api.createState({ activeSessionId: 42 }),
  ]);
}

// A long action sequence exercising every dispatch branch and every
// equality short-circuit; returns per-step snapshots and the notification
// trace (state/previousState/action) of the store's subscriber.
function runDispatchSequence(api, { notify = true } = {}) {
  const store = api.createStore({
    activeSessionId: 's1',
    drafts: { s1: 'draft a' },
    attachmentsBySession: { s1: [ATTACHMENT_A] },
  });
  const trace = [];
  if (notify) {
    store.subscribe((state, previousState, action) => {
      trace.push({ state, previousState, actionType: action && action.type });
    });
  }
  const actions = [
    { type: 'set-draft-text', sessionId: 's1', text: 'draft a' },          // no-op → same state
    { type: 'set-draft-text', sessionId: 's1', text: 'draft b' },
    { type: 'set-draft-text', sessionId: 's2', text: '' },                 // empty → drops bucket
    { type: 'add-attachments', sessionId: 's1', attachments: [ATTACHMENT_B] },
    { type: 'add-attachments', sessionId: 's1', attachments: [null] },     // no-op
    { type: 'remove-attachment', sessionId: 's1', index: 0 },
    { type: 'remove-attachment', sessionId: 's1', index: 99 },             // no-op
    { type: 'remove-attachment', sessionId: 's1', index: -1 },             // no-op
    { type: 'set-active-session', sessionId: 's2' },
    { type: 'set-pending-send', sessionId: 's2', requestId: 'req_1', text: 'hello', images: [ATTACHMENT_B], baselineEventSeq: 7, stage: 'sending' },
    { type: 'patch-pending-send', patch: { stage: 'processing' } },
    { type: 'patch-pending-send', patch: { baselineEventSeq: 8 } },
    { type: 'clear-pending-send', requestId: 'other' },                    // no-op (id mismatch)
    { type: 'clear-pending-send', requestId: 'req_1' },
    { type: 'set-retained-send', retainedSend: { sessionId: 's2', requestId: 'r1', text: 't1', stage: 'uploading' } },
    { type: 'set-retained-send', retainedSend: { sessionId: 's2', requestId: 'r1', text: 't1-replaced', stage: 'sent', awaitingCommit: true } },
    { type: 'patch-retained-send', requestId: 'r1', patch: { stage: 'checking', localEcho: false } },
    { type: 'patch-retained-send', requestId: 'missing', patch: {} },      // no-op
    { type: 'set-retained-send', retainedSend: { sessionId: 's1', requestId: 'r2', text: 't2' } },
    { type: 'clear-retained-send', requestId: 'r1' },
    { type: 'set-pending-edit-resend', pendingEditResend: { sessionId: 's1', requestId: 'e1', prompt: 'p', attachments: [ATTACHMENT_A] } },
    { type: 'set-pending-edit-resend', pendingEditResend: { sessionId: 's1', requestId: 'e1', prompt: 'p2' } },
    { type: 'clear-pending-edit-resend' },
    { type: 'clear-pending-edit-resend' },                                 // no-op
    { type: 'unknown-action' },                                            // no-op
  ];
  const snapshots = [];
  for (const action of actions) {
    const returned = store.dispatch(action);
    snapshots.push({ action: action.type, state: store.getState(), returnedSame: returned === store.getState() });
  }
  return normalize({ snapshots, trace });
}

async function main() {
  const [legacy, core] = [loadLegacy(), loadCore()];

  // 1. State normalization parity (createState over a dirty-input battery).
  assert.deepEqual(
    runNormalizeBattery(core.api),
    runNormalizeBattery(legacy.api),
    `createState normalization drifted: ${legacy.label} vs ${core.label}`,
  );

  // 2. Dispatch-sequence parity with notification traces.
  assert.deepEqual(
    runDispatchSequence(core.api),
    runDispatchSequence(legacy.api),
    `dispatch sequence drifted: ${legacy.label} vs ${core.label}`,
  );

  // 3. Predicate parity over equal-looking states (unsaved / blocking).
  const busyState = core.api.createState({
    activeSessionId: 's1',
    pendingSend: { sessionId: 's1', requestId: 'r1', stage: 'sending' },
  });
  const busyStateLegacy = legacy.api.createState({
    activeSessionId: 's1',
    pendingSend: { sessionId: 's1', requestId: 'r1', stage: 'sending' },
  });
  const predicates = ['hasPendingSendForSession', 'hasUnsavedState', 'hasAnyUnsavedState'];
  for (const name of predicates) {
    assert.equal(core.api[name](busyState), legacy.api[name](busyStateLegacy), `${name} drifted`);
  }

  console.log('test-chat-composer-store-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
