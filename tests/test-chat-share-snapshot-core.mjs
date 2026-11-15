#!/usr/bin/env node
// tests/test-chat-share-snapshot-core.mjs
//
// Stage 2: share-snapshot core (static/chat/transport/share-snapshot.js) is
// a DOM-free port of session-http-helpers.js's share-snapshot projections —
// the synthetic "share_snapshot:<id>" session id, display event list,
// resolved event block, newest event stamp, view meta value, and the full
// read-only session record the share view renders from. The ambient payload
// is read live through the environment contract. Every scenario runs against
// BOTH implementations with identical payloads and compares primitive-level
// outputs, so the port cannot drift from the legacy semantics.

import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

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
  // getActiveShareSnapshotPayload reads the free variable shareSnapshotPayload
  // (helpers top level does not declare it).
  vm.runInNewContext('let shareSnapshotPayload = null;', context);
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8'),
    context,
    { filename: 'session-http-helpers.js' },
  );
  vm.runInNewContext(
    `__setAmbient = (patch) => {
      if ("shareSnapshotPayload" in patch) shareSnapshotPayload = patch.shareSnapshotPayload;
    };`,
    context,
  );
  return {
    api: {
      hasShareSnapshotPayload: () => context.hasShareSnapshotPayload(),
      buildShareSnapshotSessionId: (s) => context.buildShareSnapshotSessionId(s),
      getShareSnapshotDisplayEvents: (s) => context.getShareSnapshotDisplayEvents(s),
      getShareSnapshotEventBlock: (a, b, s) => context.getShareSnapshotEventBlock(a, b, s),
      getShareSnapshotLastEventAt: (s) => context.getShareSnapshotLastEventAt(s),
      getShareSnapshotViewValue: (k, f) => context.getShareSnapshotViewValue(k, f),
      buildShareSnapshotSessionRecord: (s) => context.buildShareSnapshotSessionRecord(s),
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
  const env = { getActiveShareSnapshotPayload: null };
  context.RagentShareSnapshotEnvironment = env;
  vm.runInNewContext(
    readFileSync(join(repoRoot, 'static/chat/transport/share-snapshot.js'), 'utf8'),
    context,
    { filename: 'transport/share-snapshot.js' },
  );
  const core = context.RagentShareSnapshotCore;
  let payload = null;
  env.getActiveShareSnapshotPayload = () => payload;
  return {
    api: {
      hasShareSnapshotPayload: () => core.hasShareSnapshotPayload(),
      buildShareSnapshotSessionId: (s) => core.buildShareSnapshotSessionId(s),
      getShareSnapshotDisplayEvents: (s) => core.getShareSnapshotDisplayEvents(s),
      getShareSnapshotEventBlock: (a, b, s) => core.getShareSnapshotEventBlock(a, b, s),
      getShareSnapshotLastEventAt: (s) => core.getShareSnapshotLastEventAt(s),
      getShareSnapshotViewValue: (k, f) => core.getShareSnapshotViewValue(k, f),
      buildShareSnapshotSessionRecord: (s) => core.buildShareSnapshotSessionRecord(s),
    },
    setAmbient(patch) {
      if ('shareSnapshotPayload' in patch) payload = patch.shareSnapshotPayload;
    },
    label: 'transport',
  };
}

const FULL_SNAPSHOT = {
  id: '  share-1  ',
  createdAt: '2026-08-08T00:00:00.000Z',
  displayEvents: [
    { type: 'message', timestamp: '2026-08-08T00:01:00.000Z' },
    { type: 'operation', timestamp: '  ' },
    { type: 'message', timestamp: '2026-08-08T00:02:00.000Z' },
  ],
  eventBlocks: {
    '1-50': [{ type: 'message', seq: 1 }],
    '51-100': [{ type: 'message', seq: 51 }],
  },
  view: { badge: '  Shared Demo  ', extra: '' },
  session: {
    name: '  Demo Session  ',
    tool: 'codex',
    created: '2026-08-07T00:00:00.000Z',
  },
};

async function runScenario(impl) {
  const {
    hasShareSnapshotPayload: has,
    buildShareSnapshotSessionId: sid,
    getShareSnapshotDisplayEvents: display,
    getShareSnapshotEventBlock: block,
    getShareSnapshotLastEventAt: lastEventAt,
    getShareSnapshotViewValue: viewValue,
    buildShareSnapshotSessionRecord: record,
  } = impl.api;
  const out = {};

  // 1. No payload → empty projections across the board.
  impl.setAmbient({ shareSnapshotPayload: null });
  out.empty = [
    has(),
    sid(),
    display(),
    block(1, 50),
    lastEventAt(),
    viewValue('badge', 'fallback'),
    record(),
  ];
  impl.setAmbient({ shareSnapshotPayload: undefined });
  out.empty.push(record());

  // 2. Full payload → every projection resolves.
  impl.setAmbient({ shareSnapshotPayload: FULL_SNAPSHOT });
  out.full = [
    has(),
    sid(),
    display().length,
    display(),
    block(1, 50),
    block(51, 100),
    block(99, 200), // unregistered range → null
    lastEventAt(), // newest non-empty display timestamp
    viewValue('badge', 'fallback'),
    viewValue('extra', 'fallback'), // blank value → fallback
    viewValue('missing', 'fallback'),
    record(),
  ];

  // 3. Name fallback chain: session.name → session.tool → default.
  impl.setAmbient({ shareSnapshotPayload: { id: 'x', session: { tool: 'codex' } } });
  out.nameTool = record();
  impl.setAmbient({ shareSnapshotPayload: { id: 'x', session: {} } });
  out.nameDefault = record();
  impl.setAmbient({ shareSnapshotPayload: { id: 'x' } });
  out.nameMinimal = record();

  // 4. Timestamp fallbacks: blank display timestamps → payload createdAt.
  impl.setAmbient({
    shareSnapshotPayload: {
      id: 'x',
      createdAt: '2026-08-06T00:00:00.000Z',
      displayEvents: [{ type: 'message', timestamp: '  ' }],
    },
  });
  out.stampFallback = [
    lastEventAt(),
    record(),
  ];

  // 5. No timestamps at all → lastEventAt null.
  impl.setAmbient({ shareSnapshotPayload: { id: 'x', displayEvents: [{ type: 'message' }] } });
  out.stampNone = [
    lastEventAt(),
    record(),
  ];

  // 6. Non-array displayEvents / missing view / eventBlocks shapes.
  impl.setAmbient({ shareSnapshotPayload: { id: 'x', displayEvents: 'nope' } });
  out.shapes = [
    display(),
    record(),
  ];
  impl.setAmbient({ shareSnapshotPayload: { id: 'x', eventBlocks: {} } });
  out.shapes.push(block(1, 50));
  impl.setAmbient({ shareSnapshotPayload: { id: 'x', eventBlocks: { '1-50': [] } } });
  out.shapes.push(block(1, 50));

  // 7. Payload evolution is read live (replaced mid-scenario).
  impl.setAmbient({ shareSnapshotPayload: null });
  out.live = [has()];
  impl.setAmbient({ shareSnapshotPayload: { id: 'live' } });
  out.live.push(has(), sid());

  // JSON round-trip: projected records come from the vm realm and would fail
  // deepStrictEqual on prototype identity alone.
  return JSON.parse(JSON.stringify(out));
}

async function main() {
  const [legacy, core] = [loadLegacy(), loadCore()];
  const [a, b] = await Promise.all([runScenario(legacy), runScenario(core)]);
  assert.deepEqual(b, a, `share-snapshot drift: ${legacy.label} vs ${core.label}`);
  console.log('test-chat-share-snapshot-core: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
