#!/usr/bin/env node
// tests/test-chat-post-send-refresh-core.mjs
//
// Stage 2: post-send-refresh core (static/chat/transport/post-send-refresh.js)
// is a DOM-free port of realtime.js's schedulePostSendRefresh — the one
// recovery refresh scheduled per outbound request, replaced when the same
// request schedules again and skipped when the session switched or the
// committed message node already appeared. Every scenario runs against BOTH
// implementations with identical injected mock timers / refresh command /
// committed-node probe and an evolving current-session id, comparing the
// observed timer lifecycles and refresh calls — so the port cannot drift
// from the legacy scheduling decision.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

// Deterministic timer host shared by both implementations (each gets its own
// instance but the scenario sequence is identical).
function makeMockTimers() {
  const timers = new Map();
  let nextId = 1;
  const log = { scheduled: [], cleared: [], fired: [] };
  return {
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, cleared: false });
      log.scheduled.push({ id, ms });
      return id;
    },
    clearTimeout(id) {
      const entry = timers.get(id);
      if (entry && !entry.cleared) {
        entry.cleared = true;
        log.cleared.push(id);
      }
    },
    tick(id) {
      const entry = timers.get(id);
      if (!entry || entry.cleared) return false;
      entry.cleared = true;
      log.fired.push(id);
      entry.fn();
      return true;
    },
    pending() {
      return [...timers.values()].filter((entry) => !entry.cleared).length;
    },
    log,
  };
}

function loadLegacy({ mockTimers }) {
  const context = {
    console,
    Promise,
    Map,
    Set,
    Date,
    Error,
    setTimeout: mockTimers.setTimeout,
    clearTimeout: mockTimers.clearTimeout,
    window: { addEventListener() {} },
    navigator: {},
  };
  vm.runInNewContext('let currentSessionId = "";', context);
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8'),
    context,
    { filename: 'realtime.js' },
  );
  vm.runInNewContext(
    `__setAmbient = (patch) => {
      if ("currentSessionId" in patch) currentSessionId = patch.currentSessionId;
      if ("refreshCurrentSession" in patch) globalThis.refreshCurrentSession = patch.refreshCurrentSession;
      if ("findCommittedUserMessageNode" in patch) globalThis.findCommittedUserMessageNode = patch.findCommittedUserMessageNode;
    };`,
    context,
  );
  return {
    api: {
      schedule: (sessionId, requestId) => context.schedulePostSendRefresh(sessionId, requestId),
    },
    setAmbient: (patch) => context.__setAmbient(patch),
    label: 'legacy',
  };
}

function loadCore({ mockTimers }) {
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
    refreshCurrentSession: null,
    findCommittedUserMessageNode: null,
    setTimeout: mockTimers.setTimeout,
    clearTimeout: mockTimers.clearTimeout,
  };
  context.RagentPostSendRefreshEnvironment = env;
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/post-send-refresh.js'), 'utf8'),
    context,
    { filename: 'transport/post-send-refresh.js' },
  );
  const core = context.RagentPostSendRefreshCore;
  return {
    api: {
      schedule: (sessionId, requestId) => core.schedulePostSendRefresh(sessionId, requestId),
    },
    setAmbient(patch) {
      for (const key of Object.keys(patch)) {
        if (key in env) env[key] = patch[key];
      }
    },
    label: 'transport',
  };
}

async function runScenario(impl, mockTimers) {
  const out = { refreshCalls: [], steps: [] };
  const record = (label) => {
    out.steps.push({
      label,
      pending: mockTimers.pending(),
      cleared: [...mockTimers.log.cleared],
      fired: [...mockTimers.log.fired],
      refreshCalls: [...out.refreshCalls],
    });
  };
  let refreshCount = 0;
  const refreshSpy = (options) => {
    refreshCount += 1;
    out.refreshCalls.push({ n: refreshCount, forceFresh: options?.forceFresh === true });
    return Promise.resolve();
  };

  // 1. No refresh command injected yet → scheduling is a no-op.
  impl.api.schedule('s1');
  record('no-command');

  // 2. Command available → one pending timer per key.
  impl.setAmbient({ refreshCurrentSession: refreshSpy });
  impl.api.schedule('s1');
  record('scheduled-session-key');

  // 3. A request-id key is independent of the session key.
  impl.api.schedule('s1', 'req1');
  record('scheduled-req1');

  // 4. Same request id again replaces its own timer only.
  impl.api.schedule('s1', 'req1');
  record('rescheduled-req1');

  // 5. Firing the request timer refreshes the current session (forceFresh).
  const ids = [...mockTimers.log.scheduled].map((s) => s.id);
  mockTimers.tick(ids[ids.length - 1]);
  record('fired-req1');

  // 6. Session switched before the timer fires → skip.
  impl.setAmbient({ currentSessionId: 's2' });
  impl.api.schedule('s1');
  const sessionTimerId = mockTimers.log.scheduled[mockTimers.log.scheduled.length - 1].id;
  mockTimers.tick(sessionTimerId);
  record('fired-stale-session');

  // 7. Committed node already present → skip.
  impl.setAmbient({ findCommittedUserMessageNode: () => true });
  impl.api.schedule('s1', 'req2');
  const committedTimerId = mockTimers.log.scheduled[mockTimers.log.scheduled.length - 1].id;
  mockTimers.tick(committedTimerId);
  record('fired-committed');

  // 8. Committed probe goes absent again → refresh runs.
  impl.setAmbient({ findCommittedUserMessageNode: () => null });
  impl.api.schedule('s1', 'req3');
  const finalTimerId = mockTimers.log.scheduled[mockTimers.log.scheduled.length - 1].id;
  mockTimers.tick(finalTimerId);
  record('fired-clean');

  // 9. Empty session id → no-op.
  impl.api.schedule('');
  record('empty-session');

  // 10. Empty request id falls back to the session key (same key as step 2).
  impl.api.schedule('s1', '');
  record('empty-request-id');

  return JSON.parse(JSON.stringify(out));
}

async function main() {
  const mockTimersLegacy = makeMockTimers();
  const mockTimersCore = makeMockTimers();
  const [legacy, core] = [
    loadLegacy({ mockTimers: mockTimersLegacy }),
    loadCore({ mockTimers: mockTimersCore }),
  ];
  const [a, b] = await Promise.all([
    runScenario(legacy, mockTimersLegacy),
    runScenario(core, mockTimersCore),
  ]);
  assert.deepEqual(b, a, `post-send-refresh drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-post-send-refresh-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
