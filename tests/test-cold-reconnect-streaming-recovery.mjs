#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ragent-cold-reconnect-recovery-'));
process.env.HOME = home;
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_INSTANCE_ROOT = home;
process.env.RAGENT_CONFIG_DIR = join(home, 'config');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
process.env.RAGENT_RUN_SPOOL_DIR = join(home, 'data', 'chat-runs');
process.env.RAGENT_PROVIDER_HOMES_DIR = join(home, 'provider-homes');

mkdirSync(join(home, 'workspace'), { recursive: true });

const { appendEvent, prepareLiveMessageTimeline, readEventsAfter } = await import('../chat/history.mjs');
const { createRun, runSpoolPath, updateRun } = await import('../chat/runs.mjs');
const { mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
const {
  createSession,
  getSessionTimelineBundle,
  getSessionTimelinePage,
  killAll,
} = await import('../chat/session-manager.mjs');
const { filterSessionDisplayPushEvents } = await import('../chat/session-display-events.mjs');
const { broadcastSessionEvents } = await import('../chat/ws-clients.mjs');
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
const { sessionLiveFeed, sessionRealtimeLiveFeed } = await import('../chat/session-live-feed.mjs');

class ResponseProbe extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.body = '';
    this.destroyed = false;
  }
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    Object.assign(this.headers, headers);
  }
  end(body = '') { this.body = body; }
}

async function invokeRoute(sessionId, kind, query = {}) {
  const res = new ResponseProbe();
  const suffix = kind === 'snapshot' ? '/snapshot' : (kind === 'event-wait' ? '/events/wait' : '/events');
  const handled = await handleSessionMainRoutes({
    req: Object.assign(new EventEmitter(), { method: 'GET', headers: {} }),
    res,
    parsedUrl: { query },
    pathname: `/api/sessions/${sessionId}${suffix}`,
    authSession: { role: 'owner' },
    sessionGetRoute: { kind, sessionId },
    createSessionSummaryRef: () => ({ id: sessionId }),
    immutablePrivateEventCacheControl: 'private, no-store',
    isDirectoryPath: async () => true,
    readSessionMessagePayload: async () => ({}),
    requireSessionAccess: async () => true,
    isSessionVisibleToAuthSession: () => true,
    getAuthPrincipalId: () => 'owner',
    getAuthScopeAgentId: () => '',
    isAgentScopedAuthSession: () => false,
    resolveRequestedSessionAttachments: async () => [],
    writeJson: (r, code, payload) => {
      r.writeHead(code, { 'Content-Type': 'application/json' });
      r.end(JSON.stringify(payload));
    },
    writeJsonCached: (req, r, payload) => {
      r.writeHead(200, { 'Content-Type': 'application/json' });
      r.end(JSON.stringify(payload));
    },
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body);
}

try {
  // ── Scenario 1: Active in-memory streaming run, cold reconnect, then completion ──
  const session = await createSession(join(home, 'workspace'), 'fake-codex', 'Cold Reconnect Stream');
  const run = await createRun({
    status: {
      sessionId: session.id,
      requestId: 'req_cold_1',
      state: 'running',
      tool: 'fake-codex',
      runtimeFamily: 'codex-app-server-json',
    },
    manifest: {
      sessionId: session.id,
      requestId: 'req_cold_1',
      folder: join(home, 'workspace'),
      tool: 'fake-codex',
      prompt: 'Explain chiplet interconnects',
      runtimeFamily: 'codex-app-server-json',
      options: { runtimeFamily: 'codex-app-server-json' },
    },
  });
  await mutateSessionMeta(session.id, (draft) => {
    draft.activeRunId = run.id;
    return true;
  });

  await appendEvent(session.id, {
    type: 'message',
    role: 'user',
    runId: run.id,
    requestId: 'req_cold_1',
    content: 'Explain chiplet interconnects',
  });

  const deltaBatch1 = await prepareLiveMessageTimeline(session.id, [
    {
      type: 'text_delta',
      role: 'assistant',
      runId: run.id,
      requestId: 'req_cold_1',
      providerItemId: 'item_msg_1',
      providerEventId: 'agent-message:item_msg_1:1',
      text: 'Hello ',
    },
    {
      type: 'text_delta',
      role: 'assistant',
      runId: run.id,
      requestId: 'req_cold_1',
      providerItemId: 'item_msg_1',
      providerEventId: 'agent-message:item_msg_1:2',
      text: 'world<ragent-session-labels>{"labels":["hidden"]}</ragent-session-labels>',
    },
  ]);
  assert.equal(deltaBatch1.starts.length, 1);
  const startSeq = deltaBatch1.starts[0].seq;
  broadcastSessionEvents(
    session.id,
    filterSessionDisplayPushEvents([...deltaBatch1.starts, ...deltaBatch1.events]),
  );

  // Durable history still has only user + empty message_start (no fake durable seq).
  const durableAll = await invokeRoute(session.id, 'events', { filter: 'all', limit: '50' });
  assert.equal(durableAll.events.length, 2);

  // Cold /events?filter=visible (Android refreshVisibleTimelineLocked).
  const coldVisible = await invokeRoute(session.id, 'events', {
    filter: 'visible',
    limit: '50',
    direction: 'latest',
  });
  assert.equal(coldVisible.latestSeq, startSeq, 'durable latestSeq must not inflate from inflight overlay');
  const coldVisibleAssistants = coldVisible.events.filter((e) => e.type === 'message' && e.role === 'assistant');
  assert.equal(coldVisibleAssistants.length, 1);
  assert.equal(coldVisibleAssistants[0].content, 'Hello world');
  assert.equal(coldVisibleAssistants[0].messageState, 'streaming');
  assert.equal(coldVisibleAssistants[0].textMode, 'snapshot');
  assert.equal(coldVisibleAssistants[0].canonicalMessageId, deltaBatch1.starts[0].canonicalMessageId);
  assert.equal(coldVisibleAssistants[0].seq, startSeq);

  // Cold /snapshot.
  const coldSnapshot = await invokeRoute(session.id, 'snapshot', { limit: '50' });
  assert.equal(coldSnapshot.latestSeq, startSeq);
  const snapAssistants = coldSnapshot.events.filter((e) => e.type === 'message' && e.role === 'assistant');
  assert.equal(snapAssistants.length, 1);
  assert.equal(snapAssistants[0].content, 'Hello world');
  assert.equal(snapAssistants[0].messageState, 'streaming');

  // Unpaginated bundle also reflects inflight streaming and rebuilds as deltas advance.
  const bundle1 = await getSessionTimelineBundle(session.id);
  assert.equal(bundle1.displayEvents.find((e) => e.role === 'assistant')?.content, 'Hello world');

  const deltaBatch2 = await prepareLiveMessageTimeline(session.id, [
    {
      type: 'text_delta',
      role: 'assistant',
      runId: run.id,
      requestId: 'req_cold_1',
      providerItemId: 'item_msg_1',
      providerEventId: 'agent-message:item_msg_1:3',
      text: '!',
    },
  ]);
  broadcastSessionEvents(session.id, filterSessionDisplayPushEvents(deltaBatch2.events));
  const bundle2 = await getSessionTimelineBundle(session.id);
  assert.equal(bundle2.displayEvents.find((e) => e.role === 'assistant')?.content, 'Hello world!');

  // Cold /events?filter=all&includeLive=1 without prior liveFeedCursors.
  const coldAllWithLive = await invokeRoute(session.id, 'events', {
    filter: 'all',
    includeLive: '1',
    liveAfterCursor: '0',
    limit: '50',
  });
  assert.equal(coldAllWithLive.liveResetRequired, false);
  assert.ok(coldAllWithLive.liveEvents.length > 0);
  assert.equal(coldAllWithLive.liveEvents.map((e) => e.text || '').join(''), 'Hello world!');

  // Cold /events/wait?includeLive=1&liveOnly=1 without prior liveFeedCursors.
  const coldLiveOnly = await invokeRoute(session.id, 'event-wait', {
    includeLive: '1',
    liveOnly: '1',
    timeoutMs: '10',
    liveAfterCursor: '0',
  });
  assert.equal(coldLiveOnly.liveOnly, true);
  assert.equal(coldLiveOnly.liveResetRequired, false);
  assert.equal(coldLiveOnly.liveEvents.map((e) => e.text || '').join(''), 'Hello world!');

  // Finalize message + turn -> zero duplicate messages on /events, /snapshot, and bundle.
  const finalizedPrep = await prepareLiveMessageTimeline(session.id, [
    {
      type: 'message',
      role: 'assistant',
      runId: run.id,
      requestId: 'req_cold_1',
      providerMessageId: 'item_msg_1',
      content: 'Hello world! Final.',
    },
  ]);
  const storedFinal = await appendEvent(session.id, finalizedPrep.events[0]);
  const storedTerminal = await appendEvent(session.id, {
    type: 'run_terminal',
    role: 'system',
    runId: run.id,
    requestId: 'req_cold_1',
    state: 'completed',
  });
  broadcastSessionEvents(
    session.id,
    filterSessionDisplayPushEvents([storedFinal, storedTerminal]),
    { latestSeq: storedTerminal.seq },
  );
  await updateRun(run.id, { state: 'completed', finalizedAt: new Date().toISOString() });
  await mutateSessionMeta(session.id, (draft) => {
    delete draft.activeRunId;
    return true;
  });

  assert.deepEqual(sessionLiveFeed.getInflightMessages(session.id), []);
  assert.deepEqual(sessionRealtimeLiveFeed.getInflightMessages(session.id), []);

  const settledVisible = await invokeRoute(session.id, 'events', {
    filter: 'visible',
    limit: '50',
    direction: 'latest',
  });
  const settledAssistants = settledVisible.events.filter((e) => e.type === 'message' && e.role === 'assistant');
  assert.equal(settledAssistants.length, 1, 'completion must not duplicate the streaming assistant message');
  assert.equal(settledAssistants[0].content, 'Hello world! Final.');
  assert.equal(settledAssistants[0].messageState, 'completed');
  assert.equal(settledAssistants[0].seq, startSeq);

  const settledSnapshot = await invokeRoute(session.id, 'snapshot', { limit: '50' });
  const settledSnapAssistants = settledSnapshot.events.filter((e) => e.type === 'message' && e.role === 'assistant');
  assert.equal(settledSnapAssistants.length, 1);
  assert.equal(settledSnapAssistants[0].content, 'Hello world! Final.');

  // ── Scenario 2: Simulated server restart mid-run (empty memory, recover from spool) ──
  const restartSession = await createSession(join(home, 'workspace'), 'codex', 'Server Restart Recovery');
  const restartRun = await createRun({
    status: {
      sessionId: restartSession.id,
      requestId: 'req_restart_1',
      state: 'running',
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
    },
    manifest: {
      sessionId: restartSession.id,
      requestId: 'req_restart_1',
      folder: join(home, 'workspace'),
      tool: 'codex',
      prompt: 'Stream across restart',
      runtimeFamily: 'codex-app-server-json',
      options: { runtimeFamily: 'codex-app-server-json' },
    },
  });
  await mutateSessionMeta(restartSession.id, (draft) => {
    draft.activeRunId = restartRun.id;
    return true;
  });
  await appendEvent(restartSession.id, {
    type: 'message',
    role: 'user',
    runId: restartRun.id,
    requestId: 'req_restart_1',
    content: 'Stream across restart',
  });
  // Persist message_start as pre-restart delta tick would have done.
  const preRestartStart = await prepareLiveMessageTimeline(restartSession.id, [
    {
      type: 'text_delta',
      role: 'assistant',
      runId: restartRun.id,
      requestId: 'req_restart_1',
      providerItemId: 'item_restart_1',
      text: 'Part 1 ',
    },
  ]);
  assert.equal(preRestartStart.starts.length, 1);
  const restartStartSeq = preRestartStart.starts[0].seq;

  // Write raw app-server spool lines as if processed before restart, with NO in-memory live feed entries!
  const spoolLines = [
    JSON.stringify({
      ts: new Date().toISOString(),
      stream: 'stdout',
      json: {
        method: 'item/agentMessage/delta',
        params: { itemId: 'item_restart_1', delta: 'Part 1 ' },
      },
    }),
    JSON.stringify({
      ts: new Date().toISOString(),
      stream: 'stdout',
      json: {
        method: 'item/agentMessage/delta',
        params: { itemId: 'item_restart_1', delta: 'Part 2' },
      },
    }),
  ].join('\n') + '\n';
  writeFileSync(runSpoolPath(restartRun.id), spoolLines, 'utf8');
  await updateRun(restartRun.id, {
    normalizedByteOffset: Buffer.byteLength(spoolLines, 'utf8'),
    normalizedLineCount: 2,
  });

  // Confirm live feeds have zero entries before cold reconnect.
  assert.equal(sessionRealtimeLiveFeed.hasEntries(restartSession.id), false);
  assert.equal(sessionLiveFeed.hasEntries(restartSession.id), false);

  const restartSnapshot = await invokeRoute(restartSession.id, 'snapshot', { limit: '50' });
  const restartAssistants = restartSnapshot.events.filter((e) => e.type === 'message' && e.role === 'assistant');
  assert.equal(restartAssistants.length, 1, 'cold /snapshot after server restart recovers inflight text from spool');
  assert.equal(restartAssistants[0].content, 'Part 1 Part 2');
  assert.equal(restartAssistants[0].messageState, 'streaming');
  assert.equal(restartAssistants[0].seq, restartStartSeq);

  const restartLiveOnly = await invokeRoute(restartSession.id, 'event-wait', {
    includeLive: '1',
    liveOnly: '1',
    timeoutMs: '10',
    liveAfterCursor: '0',
  });
  assert.equal(restartLiveOnly.liveResetRequired, false);
  assert.equal(restartLiveOnly.liveEvents.map((e) => e.text || '').join(''), 'Part 1 Part 2');

  // Verify durable history remained untouched (still only user + message_start).
  const restartDurable = await readEventsAfter(restartSession.id, 0, { includeBodies: true });
  assert.equal(restartDurable.length, 2);

  // Also check getSessionTimelinePage directly for pagination boundary safety.
  const pageBefore = await getSessionTimelinePage(restartSession.id, {
    limit: 10,
    direction: 'before',
    beforeSeq: restartStartSeq,
  });
  assert.equal(
    pageBefore.events.filter((e) => e.role === 'assistant').length,
    0,
    'direction=before before message_start must not inject the later inflight message',
  );

  console.log('test-cold-reconnect-streaming-recovery: ok');
} finally {
  await killAll();
  rmSync(home, { recursive: true, force: true });
}
