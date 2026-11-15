#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(
  join(repoRoot, 'static', 'chat', 'session-store.js'),
  'utf8',
);

const context = { console };
context.globalThis = context;
context.window = context;

vm.runInNewContext(source, context, {
  filename: 'session-store.js',
});

const storeModel = context.RagentChatStore;

assert.ok(storeModel, 'chat session store should attach to the global scope');

function compareSessionsById(a, b) {
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

const activeA = { id: 'a' };
const activeB = { id: 'b' };
const archivedZ = { id: 'z', archived: true };

const initialState = storeModel.createState({
  sessions: [archivedZ, activeA],
  currentSessionId: 'a',
  hasAttachedSession: true,
  archivedSessionCount: 1,
  activeSourceFilter: 'bot',
  activeTab: 'settings',
  sessionStatus: 'running',
});

assert.equal(initialState.currentSessionId, 'a');
assert.equal(initialState.hasAttachedSession, true);
assert.equal(initialState.archivedSessionCount, 1);
assert.equal(initialState.activeSourceFilter, 'bot');
assert.equal(initialState.activeTab, 'settings');
assert.equal(
  storeModel.createState({ activeTab: 'model-providers' }).activeTab,
  'model-providers',
  'model providers tab should be preserved',
);
assert.equal(
  storeModel.createState({ activeTab: 'harnesses' }).activeTab,
  'harnesses',
  'Harnesses tab should be preserved',
);
assert.equal(initialState.sessionStatus, 'running');

const replacedActiveState = storeModel.replaceActiveSessions(initialState, [activeB], {
  archivedCount: 1,
  compareSessions: compareSessionsById,
});

assert.equal(replacedActiveState.hasLoadedSessions, true);
assert.deepEqual(
  Array.from(replacedActiveState.sessions, (session) => session.id),
  ['b', 'z'],
  'replacing active sessions should preserve archived entries already in state',
);
assert.equal(
  replacedActiveState.currentSessionId,
  null,
  'replacing the active list should clear the current session when it disappears from the authoritative list',
);
assert.equal(replacedActiveState.hasAttachedSession, false);

const replacedArchivedState = storeModel.replaceArchivedSessions(
  storeModel.createState({ sessions: [activeB] }),
  [archivedZ],
  {
    archivedCount: 1,
    compareSessions: compareSessionsById,
  },
);

assert.equal(replacedArchivedState.archivedSessionsLoaded, true);
assert.equal(replacedArchivedState.archivedSessionsLoading, false);
assert.deepEqual(
  Array.from(replacedArchivedState.sessions, (session) => session.id),
  ['b', 'z'],
  'replacing archived sessions should preserve active entries already in state',
);

const archivedUpsertState = storeModel.upsertSession(
  storeModel.createState({ sessions: [activeB], archivedSessionCount: 0 }),
  { ...activeB, archived: true },
  { compareSessions: compareSessionsById },
);
assert.equal(archivedUpsertState.archivedSessionCount, 1);

const restoredUpsertState = storeModel.upsertSession(
  archivedUpsertState,
  activeB,
  { compareSessions: compareSessionsById },
);
assert.equal(restoredUpsertState.archivedSessionCount, 0);

const removedArchivedState = storeModel.removeSession(
  storeModel.createState({
    sessions: [activeA, archivedZ],
    archivedSessionCount: 1,
  }),
  'z',
  { compareSessions: compareSessionsById },
);
assert.deepEqual(
  Array.from(removedArchivedState.sessions, (session) => session.id),
  ['a'],
  'removing a session should drop it from the canonical shell list',
);
assert.equal(removedArchivedState.archivedSessionCount, 0);

const removedCurrentState = storeModel.removeSession(
  storeModel.createState({
    sessions: [activeA, activeB],
    currentSessionId: 'b',
    hasAttachedSession: true,
  }),
  'b',
  { compareSessions: compareSessionsById },
);
assert.equal(removedCurrentState.currentSessionId, null);
assert.equal(removedCurrentState.hasAttachedSession, false);

const selectedState = storeModel.setCurrentSession(
  storeModel.createState({ currentSessionId: 'b', hasAttachedSession: true }),
  'b',
);
assert.equal(selectedState.currentSessionId, 'b');
assert.equal(selectedState.hasAttachedSession, true);

const clearedState = storeModel.setCurrentSession(selectedState, null);
assert.equal(clearedState.currentSessionId, null);
assert.equal(clearedState.hasAttachedSession, false);

const runtimeStore = storeModel.createStore({
  currentSessionId: 'b',
  hasAttachedSession: true,
});
let listenerCalls = 0;
const unsubscribe = runtimeStore.subscribe(() => {
  listenerCalls += 1;
});

runtimeStore.dispatch({ type: 'set-session-status', value: 'running' });
runtimeStore.dispatch({ type: 'set-session-status', value: 'running' });
assert.equal(listenerCalls, 1, 'no-op dispatches should not fan out duplicate notifications');

runtimeStore.dispatch({
  type: 'set-active-source-filter',
  value: ' bot ',
  normalizeSourceFilter: (value) => String(value || '').trim().toLowerCase() || '__all__',
});
assert.equal(runtimeStore.getState().activeSourceFilter, 'bot');

runtimeStore.dispatch({
  type: 'set-active-tab',
  value: 'weird',
  normalizeTab: (value) => (value === 'settings' ? 'settings' : 'sessions'),
});
assert.equal(runtimeStore.getState().activeTab, 'sessions');

runtimeStore.dispatch({ type: 'set-active-tab', value: 'harnesses' });
assert.equal(runtimeStore.getState().activeTab, 'harnesses', 'Harnesses tab should survive Store navigation');

unsubscribe();

assert.equal(
  storeModel.getCurrentSession(
    storeModel.createState({
      sessions: [activeA, activeB],
      currentSessionId: 'b',
    }),
  )?.id,
  'b',
);

console.log('test-chat-session-store: ok');
