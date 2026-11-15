#!/usr/bin/env node
// Stage 1 coverage for core/session-store.js: direct assertions on the pure
// reducer verbs, plus scenario parity that replays identical dispatch
// sequences through the legacy session-store façade and the core port and
// compares resulting state + subscriber notification traces after every step.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function loadContext(relPath) {
  const context = { console };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(repoRoot, relPath), 'utf8'), context, { filename: relPath });
  return context;
}

const coreContext = loadContext('static/chat/core/session-store.js');
const core = coreContext.RagentChatStoreCore;
assert.ok(core, 'core/session-store.js should attach RagentChatStoreCore');

const legacyContext = loadContext('static/chat/session-store.js');
const legacy = legacyContext.RagentChatStore;
assert.ok(legacy, 'session-store.js should attach RagentChatStore');

// -- direct contract assertions ---------------------------------------------
assert.equal(core.createState({ currentSessionId: '  a1  ' }).currentSessionId, 'a1', 'session id should trim');
assert.equal(core.createState({}).currentSessionId, null, 'empty session id should be null');
assert.equal(core.createState({ currentSessionId: 'x' }).hasAttachedSession, false, 'attachment requires session');
assert.equal(core.createState({}).activeSourceFilter, '__all__', 'filter default');
assert.equal(core.createState({ activeTab: 'agents' }).activeTab, 'agents', 'agents tab kept');
assert.equal(core.createState({ activeTab: 'model-providers' }).activeTab, 'model-providers', 'model providers tab kept');
assert.equal(core.createState({ activeTab: 'harnesses' }).activeTab, 'harnesses', 'Harnesses tab kept');
assert.equal(legacy.createState({ activeTab: 'harnesses' }).activeTab, 'harnesses', 'legacy Harnesses tab kept');
assert.equal(core.createState({ activeTab: 'bogus' }).activeTab, 'sessions', 'unknown tab falls back');
assert.equal(core.createState({ sessionStatus: 'running' }).sessionStatus, 'running', 'status running kept');
assert.equal(core.createState({ sessionStatus: 'bogus' }).sessionStatus, 'idle', 'status falls back to idle');
assert.equal(core.createState({ archivedSessionCount: -3 }).archivedSessionCount, 0, 'negative count falls back');
assert.equal(
  core.createState({ sessions: [{ id: 'x' }, { id: 'x' }, { id: 'y' }] }).sessions.length,
  2,
  'duplicate session ids merged',
);
assert.equal(
  core.mergeUniqueSessions([{ id: 'a' }, { id: 'a' }, { id: 'b' }]).length,
  2,
  'mergeUniqueSessions keeps first occurrence per id',
);
assert.equal(
  core.sortSessions([{ id: 'b' }, { id: 'a' }], (a, b) => a.id.localeCompare(b.id)).map((s) => s.id).join(','),
  'a,b',
  'sortSessions applies comparator',
);
const directState = core.createState({
  sessions: [{ id: 'a1', title: 'one' }, { id: 'a2', title: 'two' }],
  currentSessionId: 'a1',
});
assert.equal(core.findSession(directState, 'a2').title, 'two', 'findSession by id');
assert.equal(core.findSession(directState, 'nope'), null, 'findSession missing returns null');
assert.equal(core.getCurrentSession(directState).title, 'one', 'getCurrentSession resolves current id');

// -- scenario parity ---------------------------------------------------------
const byId = (a, b) => String(a.id).localeCompare(String(b.id));

const scenarioActions = [
  ['replace-state with dedupe + sort + filters', (store) => store.dispatch({
    type: 'replace-state',
    state: {
      sessions: [{ id: 'b', title: 'b' }, { id: 'a', title: 'a' }, { id: 'b', title: 'b-dup' }],
      currentSessionId: 'a',
      archivedSessionCount: 2,
      activeSourceFilter: 'projects',
      activeTab: 'agents',
      sessionStatus: 'running',
    },
    compareSessions: byId,
  })],
  ['replace-active-sessions preserves archived', (store) => store.dispatch({
    type: 'replace-active-sessions',
    sessions: [{ id: 'c', title: 'c' }, { id: 'b', title: 'b2' }],
    archivedCount: 1,
    compareSessions: byId,
  })],
  ['replace-archived-sessions', (store) => store.dispatch({
    type: 'replace-archived-sessions',
    sessions: [{ id: 'z', title: 'z', archived: true }],
    compareSessions: byId,
  })],
  ['upsert new archived increments count', (store) => store.dispatch({
    type: 'upsert-session',
    session: { id: 'd', title: 'd', archived: true },
    compareSessions: byId,
  })],
  ['upsert existing archived->active decrements', (store) => store.dispatch({
    type: 'upsert-session',
    session: { id: 'd', title: 'd2', archived: false },
    compareSessions: byId,
  })],
  ['upsert invalid ignored', (store) => store.dispatch({ type: 'upsert-session', session: null })],
  ['remove missing session no-op', (store) => store.dispatch({ type: 'remove-session', sessionId: 'ghost' })],
  ['remove current session clears attachment', (store) => store.dispatch({
    type: 'remove-session',
    sessionId: 'a',
    compareSessions: byId,
  })],
  ['set-current-session explicit attach', (store) => store.dispatch({
    type: 'set-current-session',
    sessionId: 'c',
    hasAttachedSession: true,
  })],
  ['set-current-session same id keeps attach', (store) => store.dispatch({
    type: 'set-current-session',
    sessionId: 'c',
  })],
  ['set-archived-sessions-loading', (store) => store.dispatch({ type: 'set-archived-sessions-loading', value: true })],
  ['set-active-source-filter normalized', (store) => store.dispatch({
    type: 'set-active-source-filter',
    value: '   chat   ',
    normalizeSourceFilter: (v) => v.trim().toLowerCase(),
  })],
  ['set-active-tab settings', (store) => store.dispatch({ type: 'set-active-tab', value: 'settings' })],
  ['set-active-tab bogus falls back', (store) => store.dispatch({ type: 'set-active-tab', value: 'nope' })],
  ['set-session-status idle', (store) => store.dispatch({ type: 'set-session-status', value: 'idle' })],
  ['unknown action no-op', (store) => store.dispatch({ type: 'nope' })],
  ['replace-state clears missing current', (store) => store.dispatch({
    type: 'replace-state',
    state: { sessions: [{ id: 'q' }], currentSessionId: 'gone' },
  })],
];

function makeHarness(api) {
  const store = api.createStore({ currentSessionId: '  a1  ' });
  const notifications = [];
  const unsub = store.subscribe((state, previous, action) => notifications.push(action.type));
  return {
    store,
    notifications,
    unsub,
    state() {
      return JSON.parse(JSON.stringify(store.getState()));
    },
  };
}

const legacyHarness = makeHarness(legacy);
const coreHarness = makeHarness(core);
for (const [name, act] of scenarioActions) {
  act(legacyHarness.store);
  act(coreHarness.store);
  assert.deepEqual(coreHarness.state(), legacyHarness.state(), `${name}: state`);
  assert.deepEqual(coreHarness.notifications, legacyHarness.notifications, `${name}: notifications`);
}
// 5 of the 17 actions are state no-ops and must not notify: invalid upsert,
// remove-missing, remove-current (already cleared by replace-active-sessions),
// same-id set-current-session, unknown action type.
assert.equal(coreHarness.notifications.length, scenarioActions.length - 5, 'state no-op actions do not notify');

const legacyHarnessTabStore = legacy.createStore();
const coreHarnessTabStore = core.createStore();
legacyHarnessTabStore.dispatch({ type: 'set-active-tab', value: 'harnesses' });
coreHarnessTabStore.dispatch({ type: 'set-active-tab', value: 'harnesses' });
assert.equal(legacyHarnessTabStore.getState().activeTab, 'harnesses', 'legacy Store should retain the Harnesses tab');
assert.equal(coreHarnessTabStore.getState().activeTab, 'harnesses', 'core Store should retain the Harnesses tab');

// Unsubscribe stops delivery on both sides.
const legacyLen = legacyHarness.notifications.length;
const coreLen = coreHarness.notifications.length;
legacyHarness.unsub();
coreHarness.unsub();
legacyHarness.store.dispatch({ type: 'set-session-status', value: 'running' });
coreHarness.store.dispatch({ type: 'set-session-status', value: 'running' });
assert.equal(coreHarness.notifications.length, coreLen, 'core: no notifications after unsubscribe');
assert.equal(legacyHarness.notifications.length, legacyLen, 'legacy: no notifications after unsubscribe');

console.log('test-chat-session-store-core: ok');
