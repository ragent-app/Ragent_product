#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(
  join(repoRoot, 'static', 'chat', 'composer-store.js'),
  'utf8',
);

const context = { console };
context.globalThis = context;
context.window = context;

vm.runInNewContext(source, context, {
  filename: 'composer-store.js',
});

const storeModel = context.RagentComposerStore;

assert.ok(storeModel, 'composer store should attach to the global scope');

const attachmentA = { originalName: 'shot-a.png', objectUrl: 'blob:a' };
const attachmentB = { originalName: 'shot-b.png', objectUrl: 'blob:b' };

const initialState = storeModel.createState({
  activeSessionId: 'session-a',
  drafts: {
    'session-a': 'draft a',
    'session-b': 'draft b',
  },
  attachmentsBySession: {
    'session-a': [attachmentA],
  },
});

assert.equal(storeModel.getDraftText(initialState, 'session-a'), 'draft a');
assert.equal(storeModel.getDraftText(initialState, 'session-b'), 'draft b');
assert.deepEqual(Array.from(storeModel.getAttachments(initialState, 'session-a')), [attachmentA]);
assert.equal(storeModel.hasUnsavedState(initialState, 'session-a'), true);
assert.equal(storeModel.hasAnyUnsavedState(initialState), true);

const addedAttachmentState = storeModel.addAttachments(initialState, [attachmentB], {
  sessionId: 'session-a',
});
assert.deepEqual(
  Array.from(storeModel.getAttachments(addedAttachmentState, 'session-a')),
  [attachmentA, attachmentB],
  'composer store should append attachments for the same session bucket',
);

const removedAttachmentState = storeModel.removeAttachment(addedAttachmentState, 0, {
  sessionId: 'session-a',
});
assert.deepEqual(
  Array.from(storeModel.getAttachments(removedAttachmentState, 'session-a')),
  [attachmentB],
  'composer store should remove a single attachment by index',
);

const pendingSendState = storeModel.setPendingSend(removedAttachmentState, {
  sessionId: 'session-a',
  requestId: 'req_1',
  text: 'draft a',
  images: [attachmentB],
  startedAt: '2026-03-14T12:00:00.000Z',
  baselineEventSeq: 7,
  stage: 'sending',
});
assert.equal(storeModel.getPendingSend(pendingSendState)?.requestId, 'req_1');
assert.equal(storeModel.getPendingSend(pendingSendState)?.startedAt, '2026-03-14T12:00:00.000Z');
assert.equal(storeModel.getPendingSend(pendingSendState)?.baselineEventSeq, 7);
assert.equal(storeModel.hasPendingSendForSession(pendingSendState, 'session-a'), true);

const patchedPendingSendState = storeModel.patchPendingSend(pendingSendState, {
  stage: 'uploading',
});
assert.equal(storeModel.getPendingSend(patchedPendingSendState)?.stage, 'uploading');

const retainedFirstState = storeModel.setRetainedSend(patchedPendingSendState, {
  sessionId: 'session-a',
  requestId: 'req_older',
  text: 'older outbound',
  images: [],
  startedAt: '2026-03-14T12:00:01.000Z',
  stage: 'processing',
  localEcho: true,
});
const retainedBothState = storeModel.setRetainedSend(retainedFirstState, {
  sessionId: 'session-a',
  requestId: 'req_newer',
  text: 'newer outbound',
  images: [],
  startedAt: '2026-03-14T12:00:02.000Z',
  stage: 'sending',
  localEcho: true,
});
assert.deepEqual(
  Array.from(storeModel.getRetainedSends(retainedBothState, 'session-a')).map((entry) => entry.requestId),
  ['req_older', 'req_newer'],
  'retained outbound sends must survive replacement of the singular transport pending state',
);
const markedRetainedState = storeModel.patchRetainedSend(retainedBothState, 'req_older', {
  awaitingCommit: true,
  stage: 'sent',
});
assert.equal(storeModel.getRetainedSend(markedRetainedState, 'req_older')?.awaitingCommit, true);
const clearedOlderState = storeModel.clearRetainedSend(markedRetainedState, 'req_older');
assert.equal(storeModel.getRetainedSend(clearedOlderState, 'req_older'), null);
assert.equal(storeModel.getRetainedSend(clearedOlderState, 'req_newer')?.text, 'newer outbound');

const processingPendingSendState = storeModel.patchPendingSend(patchedPendingSendState, {
  stage: 'processing',
});
assert.equal(storeModel.getPendingSend(processingPendingSendState)?.stage, 'processing');
assert.equal(storeModel.hasPendingSendForSession(processingPendingSendState, 'session-a'), false);
const processingOnlyState = storeModel.clearSessionState(processingPendingSendState, 'session-a', {
  clearDraft: true,
  clearAttachments: true,
});
assert.equal(storeModel.hasUnsavedState(processingOnlyState, 'session-a'), false);

const clearedPendingSendState = storeModel.clearPendingSend(processingPendingSendState, {
  requestId: 'req_1',
});
assert.equal(storeModel.getPendingSend(clearedPendingSendState), null);

const clearedSessionState = storeModel.clearSessionState(clearedPendingSendState, 'session-a', {
  clearDraft: true,
  clearAttachments: true,
});
assert.equal(storeModel.getDraftText(clearedSessionState, 'session-a'), '');
assert.deepEqual(Array.from(storeModel.getAttachments(clearedSessionState, 'session-a')), []);
assert.equal(storeModel.hasUnsavedState(clearedSessionState, 'session-a'), false);
assert.equal(storeModel.hasUnsavedState(clearedSessionState, 'session-b'), true, 'clearing one session should preserve other session drafts');

const store = storeModel.createStore({ activeSessionId: 'session-a' });
const transitions = [];
store.subscribe((state, previousState, action) => {
  transitions.push({ state, previousState, action });
});
store.dispatch({ type: 'set-draft-text', sessionId: 'session-a', text: 'hello' });
store.dispatch({ type: 'add-attachments', sessionId: 'session-a', attachments: [attachmentA] });
store.dispatch({ type: 'clear-session-state', sessionId: 'session-a', clearDraft: true, clearAttachments: true });
assert.equal(transitions.length, 3, 'composer store subscribers should observe each meaningful state transition');

// A1 edit-resend: pendingEditResend participates in state equality, so the
// set/clear dispatches are real transitions (and read back correctly) —
// previously areStatesEqual ignored the field and discarded every update.
const pendingEditState = storeModel.setPendingEditResend(
  storeModel.createState({}),
  { sessionId: 'session-a', requestId: 'req_1', prompt: 'Edited question', attachments: [attachmentA] },
);
assert.equal(storeModel.getPendingEditResend(pendingEditState)?.sessionId, 'session-a');
assert.equal(storeModel.getPendingEditResend(pendingEditState)?.requestId, 'req_1');
assert.equal(storeModel.getPendingEditResend(pendingEditState)?.prompt, 'Edited question');
assert.equal(storeModel.getPendingEditResend(pendingEditState)?.attachments.length, 1);
assert.equal(
  storeModel.getPendingEditResend(storeModel.clearPendingEditResend(pendingEditState)),
  null,
  'clearing the pending edit-resend reads back as null',
);
assert.equal(
  storeModel.getPendingEditResend(storeModel.clearSessionState(pendingEditState, 'session-a')),
  null,
  'clearing the edited session drops its pending edit-resend',
);
assert.equal(
  storeModel.getPendingEditResend(storeModel.clearSessionState(pendingEditState, 'session-b'))?.requestId,
  'req_1',
  'clearing another session keeps the pending edit-resend',
);
assert.equal(
  storeModel.getPendingEditResend(storeModel.setPendingEditResend(pendingEditState, { sessionId: 'session-a' }))?.requestId,
  'req_1',
  'invalid pending edit-resend payload is ignored (keeps the previous pending)',
);

const editResendStore = storeModel.createStore({ activeSessionId: 'session-a' });
const editTransitions = [];
editResendStore.subscribe((state, previousState, action) => {
  editTransitions.push({ state, previousState, action });
});
editResendStore.dispatch({
  type: 'set-pending-edit-resend',
  pendingEditResend: { sessionId: 'session-a', requestId: 'req_1', prompt: 'Edited question' },
});
editResendStore.dispatch({ type: 'clear-pending-edit-resend' });
assert.equal(editTransitions.length, 2, 'set/clear pending-edit-resend are observed transitions');
assert.equal(editResendStore.getState().pendingEditResend, null, 'store readback matches the final dispatch');

console.log('test-chat-composer-store: ok');
