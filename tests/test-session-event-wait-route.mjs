#!/usr/bin/env node
import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-session-event-wait-route-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_INSTANCE_ROOT = home;

const { appendEvent } = await import('../chat/history.mjs');
const { createRun, updateRun } = await import('../chat/runs.mjs');
const { mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
const { createSession, getSession, killAll } = await import('../chat/session-manager.mjs');
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
const { __getSessionEventWaiterCountForTest } = await import('../chat/session-event-waiter.mjs');
const { broadcastSessionEvents } = await import('../chat/ws-clients.mjs');

mkdirSync(join(home, 'workspace'), { recursive: true });

class ResponseProbe extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.body = '';
    this.destroyed = false;
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    Object.assign(this.headers, headers);
  }

  end(body = '') {
    this.body = body;
  }
}

function requestProbe() {
  return Object.assign(new EventEmitter(), {
    method: 'GET',
    headers: {},
  });
}

async function runWaitRoute(sessionId, query, access = async () => true, kind = 'event-wait') {
  const response = new ResponseProbe();
  const handled = await handleSessionMainRoutes({
    req: requestProbe(),
    res: response,
    parsedUrl: { query },
    pathname: `/api/sessions/${sessionId}/events${kind === 'event-wait' ? '/wait' : ''}`,
    authSession: { role: 'owner' },
    sessionGetRoute: { kind, sessionId },
    createSessionSummaryRef: () => null,
    immutablePrivateEventCacheControl: 'private, no-store',
    isDirectoryPath: async () => true,
    readSessionMessagePayload: async () => ({}),
    requireSessionAccess: access,
    isSessionVisibleToAuthSession: () => true,
    getAuthPrincipalId: () => 'owner',
    getAuthScopeAgentId: () => '',
    isAgentScopedAuthSession: () => false,
    resolveRequestedSessionAttachments: async () => [],
    writeJson: (res, statusCode, payload) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    },
    writeJsonCached: (req, res, payload) => { res.writeHead(200, {}); res.end(JSON.stringify(payload)); },
  });
  assert.equal(handled, true);
  return { response, payload: response.body ? JSON.parse(response.body) : null };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const session = await createSession(join(home, 'workspace'), 'missing-tool', 'Event wait route', {});
try {
  const pending = runWaitRoute(session.id, { afterSeq: '0', timeoutMs: '500' });
  await waitUntil(() => __getSessionEventWaiterCountForTest(session.id) === 1);
  await appendEvent(session.id, { type: 'message', role: 'assistant', content: 'hello from wait' });
  const delivered = await pending;
  assert.equal(delivered.response.statusCode, 200);
  assert.equal(delivered.payload.timedOut, false);
  assert.equal(delivered.payload.notified, true);
  assert.equal(delivered.payload.events.length, 1);
  assert.equal(delivered.payload.events[0].content, 'hello from wait');
  assert.equal(__getSessionEventWaiterCountForTest(session.id), 0);

  const livePending = runWaitRoute(session.id, { afterSeq: '1', timeoutMs: '500', includeLive: '1' });
  await waitUntil(() => __getSessionEventWaiterCountForTest(session.id) === 1);
  broadcastSessionEvents(session.id, [{ type: 'text_delta', entityId: 'reply', text: 'Hi', seq: 0, requestId: 'request_live' }]);
  const live = await livePending;
  assert.deepEqual(live.payload.events, [], 'live delivery never invents durable events');
  assert.equal(live.payload.liveEvents[0].text, 'Hi'); assert.equal(live.payload.liveCursor, 1);
  assert.equal(live.payload.latestSeq, 1, 'durable cursor is independent of token delivery');
  assert.match(live.payload.liveStreamId, /^[a-f0-9-]{36}$/);
  const retry = await runWaitRoute(session.id, { afterSeq: '1', includeLive: '1', timeoutMs: '10' });
  assert.equal(retry.payload.liveEvents[0].eventId, live.payload.liveEvents[0].eventId);
  const liveOnly = await runWaitRoute(session.id, { includeLive: '1', liveOnly: '1', timeoutMs: '10' });
  assert.equal(liveOnly.payload.liveOnly, true);
  assert.deepEqual(liveOnly.payload.events, []);
  assert.equal(liveOnly.payload.latestSeq, undefined, 'A live-only response must not claim a durable history watermark');
  assert.equal(liveOnly.payload.liveEvents[0].text, live.payload.liveEvents[0].text);
  assert.notEqual(liveOnly.payload.liveStreamId, live.payload.liveStreamId, 'Opt-in batches have an independent delivery cursor');
  let liveOnlyChecks = 0;
  const deniedLiveOnly = await runWaitRoute(session.id, { includeLive: '1', liveOnly: '1', timeoutMs: '10' },
    async () => ++liveOnlyChecks === 1);
  assert.equal(liveOnlyChecks, 2);
  assert.equal(deniedLiveOnly.payload, null, 'Live-only delivery rechecks access after waiting');
  const other = await createSession(join(home, 'workspace'), 'missing-tool', 'Other session', {});
  const isolated = await runWaitRoute(other.id, { afterSeq: '0', includeLive: '1', timeoutMs: '10' });
  assert.deepEqual(isolated.payload.liveEvents, [], 'tokens never cross session boundaries');

  let accessChecks = 0;
  const revoked = await runWaitRoute(session.id, { afterSeq: '1', includeLive: '1', timeoutMs: '10' },
    async () => ++accessChecks === 1);
  assert.equal(accessChecks, 2, 'authority is checked again before returning live content');
  assert.equal(revoked.payload, null, 'revoked access cannot receive the ready token page');

  const timedOut = await runWaitRoute(session.id, { afterSeq: '1', timeoutMs: '10' });
  assert.equal(timedOut.response.statusCode, 200);
  assert.equal(timedOut.payload.timedOut, true);
  assert.deepEqual(timedOut.payload.events, []);
  assert.equal(__getSessionEventWaiterCountForTest(session.id), 0);

  const run = await createRun({ status: { provider: 'zen', runtimeFamily: 'codex',
    providerCapabilities: { provider: 'zen', runtimeFamily: 'codex', supportsSteer: true } }, manifest: { tool: 'codex' } });
  await appendEvent(session.id, { type: 'run_event', runId: run.id, content: 'fixture text' });
  for (const kind of ['events', 'event-wait']) {
    const query = { filter: 'all', afterSeq: '1', direction: 'forward', limit: '20', timeoutMs: '10' };
    const full = await runWaitRoute(session.id, query, async () => true, kind);
    const compact = await runWaitRoute(session.id, { ...query, compact: '1' }, async () => true, kind);
    const visible = await runWaitRoute(session.id, { filter: 'visible', limit: '50', direction: 'latest' }, async () => true, 'events');
    assert.deepEqual(compact.payload.runActivity, visible.payload.runActivity, `${kind} mobile activity matches the visible projection`);
    assert.ok(full.payload.events[0].providerCapabilities, `${kind} fixture must exercise capability enrichment`);
    const { providerCapabilities, ...expected } = full.payload.events[0];
    assert.deepEqual(compact.payload.events[0], expected, `${kind} must remove only redundant capability metadata`);
    assert.deepEqual(compact.payload.pagination, full.payload.pagination);
  }
  const waiting = await createSession(join(home, 'workspace'), 'missing-tool', 'Pending approval', {});
  const waitingRun = await createRun({
    status: { sessionId: waiting.id, requestId: 'req_waiting', state: 'accepted', tool: 'fake-codex', runtimeFamily: 'codex-json' },
    manifest: { sessionId: waiting.id, requestId: 'req_waiting', folder: '~', tool: 'fake-codex', prompt: 'fixture',
      runtimeFamily: 'codex-json', options: { runtimeFamily: 'codex-json' } },
  });
  await mutateSessionMeta(waiting.id, draft => { draft.activeRunId = waitingRun.id; return true; });
  await updateRun(waitingRun.id, { state: 'running' });
  await appendEvent(waiting.id, { type: 'approval_request', approvalId: 'fixture-approval', runId: waitingRun.id,
    kind: 'command', title: 'fixture request', status: 'pending' });
  for (const kind of ['events', 'event-wait']) {
    // The durable cursor already passed the request: the activity must still
    // identify it so a client can fetch the original event for recovery.
    const page = await runWaitRoute(waiting.id, { filter: 'all', compact: '1', afterSeq: '1', timeoutMs: '10' }, async () => true, kind);
    assert.deepEqual(page.payload.events, []);
    assert.equal(page.payload.runActivity?.kind, 'approval');
    assert.equal(page.payload.runActivity?.actionRequired, true);
    assert.equal(page.payload.runActivity?.sourceSeq, 1);
  }
} finally {
  await killAll();
  rmSync(home, { recursive: true, force: true });
}

console.log('test-session-event-wait-route: ok');
