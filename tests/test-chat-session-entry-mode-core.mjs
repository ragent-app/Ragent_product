#!/usr/bin/env node
// tests/test-chat-session-entry-mode-core.mjs
//
// Stage 2: session-entry-mode core (static/chat/transport/session-entry-mode.js)
// is a DOM-free port of session-http-helpers.js's entry decisions — how a
// session open lands the viewport: at the top (read-only / share-snapshot
// entry), at the bottom ("session_entry_bottom" intent) or where it was
// ("preserve"). The record's entryMode ("read"/"resume"), the share snapshot
// state and the viewport intent drive the decision; the viewport-intent
// normalizer is the legacy helpers version (strict equality, no trimming —
// unlike the scheduler variant). Every scenario runs against BOTH
// implementations with identical ambient state and compares primitive-level
// outputs, so the port cannot drift from the legacy semantics.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

// session-http-helpers.js reads currentSessionId / shareSnapshotMode /
// sessions as free variables (its own top level declares only the message-
// viewport state), so they can be predeclared here.
const PRELUDE = `
  let currentSessionId = "";
  let shareSnapshotMode = false;
  const sessions = [];
`;

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
    window: {},
  };
  vm.runInNewContext(PRELUDE, context);
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8'),
    context,
    { filename: 'session-http-helpers.js' },
  );
  vm.runInNewContext(
    `__setAmbient = (patch) => {
      if ("currentSessionId" in patch) currentSessionId = patch.currentSessionId;
      if ("shareSnapshotMode" in patch) shareSnapshotMode = patch.shareSnapshotMode;
      if ("sessions" in patch) { sessions.length = 0; sessions.push(...patch.sessions); }
      if ("getChatStoreSession" in patch) globalThis.getChatStoreSession = patch.getChatStoreSession;
    };`,
    context,
  );
  return {
    api: {
      resolveSessionEntryMode: (v) => context.resolveSessionEntryMode(v),
      getCurrentSessionEntryMode: (id) => context.getCurrentSessionEntryMode(id),
      shouldOpenCurrentSessionFromTop: (o) => context.shouldOpenCurrentSessionFromTop(o),
      shouldOpenCurrentSessionAtBottom: (o) => context.shouldOpenCurrentSessionAtBottom(o),
    },
    setAmbient: (patch) => context.__setAmbient(patch),
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
  const env = {
    currentSessionId: '',
    isShareSnapshotMode: false,
    getClientSessionRecord: null,
  };
  context.RagentSessionEntryModeEnvironment = env;
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/session-entry-mode.js'), 'utf8'),
    context,
    { filename: 'transport/session-entry-mode.js' },
  );
  const core = context.RagentSessionEntryModeCore;
  let records = [];
  env.getClientSessionRecord = (id) => records.find((record) => record?.id === id) || null;
  return {
    api: {
      resolveSessionEntryMode: (v) => core.resolveSessionEntryMode(v),
      getCurrentSessionEntryMode: (id) => core.getCurrentSessionEntryMode(id),
      shouldOpenCurrentSessionFromTop: (o) => core.shouldOpenCurrentSessionFromTop(o),
      shouldOpenCurrentSessionAtBottom: (o) => core.shouldOpenCurrentSessionAtBottom(o),
    },
    setAmbient(patch) {
      if ('currentSessionId' in patch) env.currentSessionId = patch.currentSessionId;
      if ('shareSnapshotMode' in patch) env.isShareSnapshotMode = patch.shareSnapshotMode;
      if ('sessions' in patch) records = patch.sessions;
    },
    label: 'transport',
  };
}

async function runScenario(impl) {
  const { resolveSessionEntryMode: resolve, getCurrentSessionEntryMode: currentMode, shouldOpenCurrentSessionFromTop: openTop, shouldOpenCurrentSessionAtBottom: openBottom } = impl.api;
  const out = {};
  const readRecord = { id: 's1', entryMode: 'read' };
  const resumeRecord = { id: 's1', entryMode: 'resume' };
  const bareRecord = { id: 's1' };

  // 1. Entry-mode resolution is strict: only "read" is read, everything
  //    else (including untrimmed variants) resumes.
  out.resolve = [
    resolve('read'),
    resolve('resume'),
    resolve(undefined),
    resolve(null),
    resolve(''),
    resolve('READ'),
    resolve(' read '),
    resolve(42),
  ];

  // 2. Current entry mode from the record (default session id).
  impl.setAmbient({ currentSessionId: 's1', shareSnapshotMode: false, sessions: [readRecord] });
  out.mode = [
    currentMode(),
    currentMode('s1'),
    currentMode('missing'), // no record → resume
  ];
  impl.setAmbient({ sessions: [resumeRecord] });
  out.mode.push(currentMode());
  impl.setAmbient({ sessions: [bareRecord] });
  out.mode.push(currentMode());
  impl.setAmbient({ sessions: [] });
  out.mode.push(currentMode());

  // 3. Share snapshot mode forces "read" regardless of the record.
  impl.setAmbient({ shareSnapshotMode: true, sessions: [resumeRecord] });
  out.mode.push(currentMode());

  // 4. Open-from-top decisions.
  impl.setAmbient({ shareSnapshotMode: false, sessions: [readRecord] });
  out.openTop = [
    openTop(),                            // preserve intent → false
    openTop({ viewportIntent: 'preserve' }),
    openTop({ viewportIntent: 'session_entry' }),      // read entry → true
    openTop({ viewportIntent: 'session_entry_bottom' }), // bottom intent is not a top entry
    openTop({ viewportIntent: ' session_entry ' }),    // helpers normalizer does not trim
    openTop({ sessionId: 's1', viewportIntent: 'session_entry' }),
    openTop({ sessionId: 's2', viewportIntent: 'session_entry' }), // wrong record → resume
  ];
  impl.setAmbient({ sessions: [resumeRecord] });
  out.openTop.push(openTop({ viewportIntent: 'session_entry' }));
  impl.setAmbient({ sessions: [readRecord] });
  out.openTop.push(openTop({ viewportIntent: 'session_entry' }));

  // 5. Share snapshot always opens from the top.
  impl.setAmbient({ shareSnapshotMode: true });
  out.openTop.push(openTop());
  out.openTop.push(openTop({ viewportIntent: 'session_entry_bottom' }));

  // 6. Open-at-bottom decisions.
  impl.setAmbient({ shareSnapshotMode: false });
  out.openBottom = [
    openBottom(),
    openBottom({ viewportIntent: 'preserve' }),
    openBottom({ viewportIntent: 'session_entry_bottom' }),
    openBottom({ viewportIntent: 'session_entry' }),
    openBottom({ viewportIntent: 'session_entry_bottom ' }), // no trim
  ];

  // 7. Share snapshot never opens at the bottom.
  impl.setAmbient({ shareSnapshotMode: true });
  out.openBottom.push(openBottom({ viewportIntent: 'session_entry_bottom' }));

  // 8. Evolving default session id is read live (not frozen at attach).
  impl.setAmbient({ shareSnapshotMode: false, sessions: [readRecord] });
  impl.setAmbient({ currentSessionId: 's1' });
  out.liveDefault = [
    currentMode(),
    openTop({ viewportIntent: 'session_entry' }),
  ];
  impl.setAmbient({ currentSessionId: 's2', sessions: [] });
  out.liveDefault.push(currentMode());

  return out;
}

async function main() {
  const [legacy, core] = [loadLegacy(), loadCore()];
  const [a, b] = await Promise.all([runScenario(legacy), runScenario(core)]);
  assert.deepEqual(b, a, `session-entry-mode drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-session-entry-mode-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
