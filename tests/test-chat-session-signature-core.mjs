#!/usr/bin/env node
// tests/test-chat-session-signature-core.mjs
//
// Stage 2: session-signature core (static/chat/transport/session-signature.js)
// is a pure port of session-http.js's comparable-session signature — the
// recursive normalization (sorted keys, undefined dropped) + JSON signature
// that decides before every upsert / attached-session render whether fetched
// session state actually changed, plus the attached-session field projection.
// Every scenario runs against BOTH implementations with identical inputs and
// compares primitive-level outputs, so the port cannot drift from the legacy
// semantics.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const PRELUDE = `
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
  let currentSessionId = "";
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
    readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8'),
    context,
    { filename: 'session-http.js' },
  );
  return {
    api: {
      buildComparableSessionState: (v) => context.buildComparableSessionState(v),
      getComparableSessionStateSignature: (v) => context.getComparableSessionStateSignature(v),
      getComparableAttachedSessionStateSignature: (s) => context.getComparableAttachedSessionStateSignature(s),
    },
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
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/session-signature.js'), 'utf8'),
    context,
    { filename: 'transport/session-signature.js' },
  );
  const core = context.RagentSessionSignatureCore;
  return {
    api: {
      buildComparableSessionState: (v) => core.buildComparableSessionState(v),
      getComparableSessionStateSignature: (v) => core.getComparableSessionStateSignature(v),
      getComparableAttachedSessionStateSignature: (s) => core.getComparableAttachedSessionStateSignature(s),
    },
    label: 'transport',
  };
}

async function runScenario(impl) {
  const { buildComparableSessionState: build, getComparableSessionStateSignature: sig, getComparableAttachedSessionStateSignature: attach } = impl.api;
  const out = {};

  // 1. Recursive normalization: sorted keys, undefined dropped, scalars pass.
  out.build = [
    build({ b: 1, a: 2 }),
    build({ a: undefined, b: 1 }),
    build({ a: { z: 1, y: undefined, x: 2 }, b: [3, { q: 1, p: undefined }] }),
    build([1, { b: 2, a: 1 }, null]),
    build(null),
    build(undefined),
    build(42),
    build('str'),
    build({}),
    build([]),
    build({ nested: { deep: { a: null, b: false, c: 0, d: '' } } }),
  ];

  // 2. Signature equality: same facts, different key order / absent-vs-undefined
  //    must collapse to the same signature; real differences must not.
  out.signatures = [
    sig({ b: 1, a: 2 }),
    sig({ a: 2, b: 1 }),
    sig({ a: 2, b: 1 }),
    sig({ a: 2, b: 1, c: undefined }),
    sig({ a: 2, b: null }),
    sig({ a: undefined }),
    sig({}),
    sig({ a: 1, nested: { x: 1, y: [1, 2] } }),
    sig({ a: 1, nested: { y: [1, 2], x: 1 } }),
    sig({ a: 1, nested: { x: 1, y: [1, 2, 3] } }),
    sig([3, 1, 2]),
    sig([1, 2, 3]),
  ];

  // 3. Attached-session projection: missing fields become explicit defaults
  //    (null / "" / false) rather than absent keys.
  out.attach = [
    attach(null),
    attach(undefined),
    attach('not-an-object'),
    attach({}),
    attach({
      id: 's1',
      name: 'N',
      tool: 'codex',
      status: 'running',
      archived: true,
      activity: { run: { state: 'running' } },
      queuedMessages: ['q'],
      model: 'opus',
      effort: 'high',
      thinking: true,
      permissionMode: 'plan',
      interactionMode: 'agent',
    }),
    attach({ id: 's1' }),
    attach({ id: 's1', archived: false, queuedMessages: 'not-array', model: 42 }),
    // Fields outside the projection must not affect the signature.
    attach({ id: 's1', extraField: 'x' }),
    attach({ id: 's1' }),
  ];

  // JSON round-trip: normalized objects come from the vm realm and would
  // fail deepStrictEqual on prototype identity alone.
  return JSON.parse(JSON.stringify(out));
}

async function main() {
  const [legacy, core] = [loadLegacy(), loadCore()];
  const [a, b] = await Promise.all([runScenario(legacy), runScenario(core)]);
  assert.deepEqual(b, a, `session-signature drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-session-signature-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
