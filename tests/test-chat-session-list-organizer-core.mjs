#!/usr/bin/env node
// tests/test-chat-session-list-organizer-core.mjs
//
// Stage 2: session-list-organizer core
// (static/chat/transport/session-list-organizer.js) is a DOM-free port of
// session-http.js's organizer projection: text clipping, per-session
// metadata, the tool-context payload and the task prompt. The legacy side
// reaches getSessionDisplayName/getActiveSessions and the editor-context
// scalars as free variables; the port receives them through the environment
// contract. Every scenario runs against BOTH implementations with identical
// injected stubs/values and compares primitive-level outputs (the task's
// generatedAt timestamp is normalized), so the port cannot drift.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const LEGACY_AMBIENT_SHAPE = `
  let selectedTool = "";
  let preferredTool = "";
  let selectedModel = null;
  let selectedEffort = null;
  let selectedPermissionMode = null;
  let thinkingEnabled = false;
  const renderedEventState = {
    sessionId: null,
    earliestSeq: 0,
    latestSeq: 0,
    eventCount: 0,
    eventBaseKeys: [],
    eventKeys: [],
    runState: "idle",
    runActivity: null,
    operationNodesById: new Map(),
    operationSnapshotsById: new Map(),
    expandedOperationIds: new Set(),
    runningBlockExpanded: false,
    hasMoreBefore: false,
    loadingOlder: false,
  };
  const emptyState = { parentNode: null };
  const messagesInner = {};
  emptyState.parentNode = messagesInner;
  const messagesEl = { addEventListener() {} };
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
    AbortController,
    navigator: {},
    window: {},
    localStorage: { getItem: () => null },
  };
  vm.runInNewContext(LEGACY_AMBIENT_SHAPE, context);
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8'),
    context,
    { filename: 'session-http-helpers.js' },
  );
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8'),
    context,
    { filename: 'session-http.js' },
  );
  // Injected AFTER the legacy files: the scalars are prelude lets, the
  // display-name/active-sessions providers are free-variable lookups that
  // resolve to globalThis properties. Per-field writes: Object.assign
  // ({ ...bindings }, patch) would only mutate a temporary object.
  vm.runInNewContext(
    `__setAmbient = (patch) => {
      if ("selectedTool" in patch) selectedTool = patch.selectedTool;
      if ("preferredTool" in patch) preferredTool = patch.preferredTool;
      if ("selectedModel" in patch) selectedModel = patch.selectedModel;
      if ("selectedEffort" in patch) selectedEffort = patch.selectedEffort;
      if ("selectedPermissionMode" in patch) selectedPermissionMode = patch.selectedPermissionMode;
      if ("thinkingEnabled" in patch) thinkingEnabled = patch.thinkingEnabled;
      if ("getSessionDisplayName" in patch) globalThis.getSessionDisplayName = patch.getSessionDisplayName;
      if ("getActiveSessions" in patch) globalThis.getActiveSessions = patch.getActiveSessions;
    };`,
    context,
  );
  return {
    api: {
      clip: (v, maxChars) => context.clipSessionListOrganizerText(v, maxChars),
      metadata: (session) => context.buildSessionListOrganizerSessionMetadata(session),
      payload: () => context.buildSessionListOrganizerPayload(),
      task: (sessions) => context.buildSessionListOrganizerTask(sessions),
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
    URL,
    URLSearchParams,
    encodeURIComponent,
    AbortController,
  };
  const env = {
    getSessionDisplayName: null,
    getActiveSessions: null,
    selectedTool: '',
    preferredTool: '',
    selectedModel: null,
    selectedEffort: null,
    selectedPermissionMode: null,
    thinkingEnabled: false,
  };
  context.RagentSessionListOrganizerEnvironment = env;
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/session-list-organizer.js'), 'utf8'),
    context,
    { filename: 'transport/session-list-organizer.js' },
  );
  const core = context.RagentSessionListOrganizerCore;
  return {
    api: {
      clip: (v, maxChars) => core.clipSessionListOrganizerText(v, maxChars),
      metadata: (session) => core.buildSessionListOrganizerSessionMetadata(session),
      payload: () => core.buildSessionListOrganizerPayload(),
      task: (sessions) => core.buildSessionListOrganizerTask(sessions),
    },
    setAmbient(patch) {
      for (const key of ['selectedTool', 'preferredTool', 'selectedModel', 'selectedEffort',
        'selectedPermissionMode', 'thinkingEnabled', 'getSessionDisplayName', 'getActiveSessions']) {
        if (key in patch) env[key] = patch[key];
      }
    },
    label: 'transport',
  };
}

const displayName = (session) => `Name:${session?.id || '?'}`;

function defaultAmbient(impl) {
  impl.setAmbient({
    getSessionDisplayName: displayName,
    getActiveSessions: () => [
      { id: 's1', description: '  first  session  ', pinned: true, sidebarOrder: 2 },
      { id: 's2', group: '  dev  ', sidebarOrder: 0 },
    ],
    selectedTool: 'claude',
    selectedModel: 'opus',
    selectedEffort: 'high',
    selectedPermissionMode: 'acceptEdits',
    thinkingEnabled: true,
  });
}

async function runScenario(impl) {
  const out = {};
  defaultAmbient(impl);

  // 1. Text clipping: normalization, length limits, ellipsis, edge caps.
  out.clip = [
    impl.api.clip('  hello   world  '),
    impl.api.clip(''),
    impl.api.clip(null),
    impl.api.clip(undefined),
    impl.api.clip(12345),
    impl.api.clip('x'.repeat(250)),
    impl.api.clip('x'.repeat(240)),
    impl.api.clip('x'.repeat(239)),
    impl.api.clip('  a b '.repeat(200), 80),
    impl.api.clip('hello', 1),
    impl.api.clip('hello', 0),
    impl.api.clip('hello', -1),
  ];

  // 2. Per-session metadata projection across field shapes.
  out.metadata = [
    impl.api.metadata({ id: 's1', description: '  brief  ', pinned: true, sidebarOrder: 3 }),
    impl.api.metadata({ id: 's2', description: '   ', sidebarOrder: 0 }),
    impl.api.metadata({ id: 's3', sidebarOrder: -1 }),
    impl.api.metadata({ id: 's4', sidebarOrder: 2.5 }),
    impl.api.metadata({ id: 's5', pinned: false }),
    impl.api.metadata({}),
    impl.api.metadata(null),
    impl.api.metadata({ id: 's6', group: '   ', tool: 'x'.repeat(60), sourceName: 'src', folder: 'f'.repeat(200),
      workflowState: 'ws', workflowPriority: 'p1', messageCount: 7, created: '2026-01-01', updatedAt: '2026-02-02', lastEventAt: '2026-03-03' }),
  ];

  // 3. Payload: editor-context scalars flow through; missing ones collapse.
  out.payloadDefault = impl.api.payload();
  impl.setAmbient({ selectedTool: '', preferredTool: 'sonnet', selectedModel: null, selectedEffort: null,
    selectedPermissionMode: null, thinkingEnabled: false });
  out.payloadFallback = impl.api.payload();
  impl.setAmbient({ selectedTool: '', preferredTool: '', selectedModel: '', selectedEffort: 0,
    selectedPermissionMode: '', thinkingEnabled: true });
  out.payloadEmptyScalars = impl.api.payload();
  impl.setAmbient({ getActiveSessions: () => [] });
  out.payloadNoSessions = impl.api.payload();
  impl.setAmbient({ getActiveSessions: () => [{ id: 'a' }, { pinned: true }, { id: 'b' }] });
  out.payloadSparse = impl.api.payload();
  defaultAmbient(impl);

  // 4. Task prompt embedding; generatedAt is timestamp-normalized.
  const task = (v) => impl.api.task(v).replace(/"generatedAt": "[^"]*"/, '"generatedAt": "<T>"');
  out.task = [
    task([{ id: 's1', description: 'd' }, { id: 's2' }]),
    task([]),
    task(null),
    task(undefined),
    task('not-an-array'),
  ];

  return out;
}

async function main() {
  const [legacy, core] = [loadLegacy(), loadCore()];
  const [a, b] = await Promise.all([runScenario(legacy), runScenario(core)]);
  const [ra, rb] = [JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))];
  assert.deepEqual(rb, ra, `session-list-organizer drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-session-list-organizer-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
