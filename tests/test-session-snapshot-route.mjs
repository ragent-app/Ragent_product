#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ragent-session-snapshot-route-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
delete process.env.RAGENT_INSTANCE_ROOT;

const { appendEvent } = await import('../chat/history.mjs');
const { createSession, killAll } = await import('../chat/session-manager.mjs');
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');

mkdirSync(join(home, 'workspace'), { recursive: true });

class ResponseProbe extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.body = '';
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

const session = await createSession(join(home, 'workspace'), 'missing-tool', 'Snapshot route', {});
await appendEvent(session.id, { type: 'message', role: 'user', content: 'hello' });
await appendEvent(session.id, { type: 'message', role: 'assistant', content: 'world' });

try {
  const response = new ResponseProbe();
  const handled = await handleSessionMainRoutes({
    req: { method: 'GET', headers: {} },
    res: response,
    parsedUrl: { query: { limit: '10' } },
    pathname: `/api/sessions/${session.id}/snapshot`,
    authSession: { role: 'owner' },
    sessionGetRoute: { kind: 'snapshot', sessionId: session.id },
    createSessionSummaryRef: () => ({ id: session.id }),
    immutablePrivateEventCacheControl: 'private, no-store',
    isDirectoryPath: async () => true,
    readSessionMessagePayload: async () => ({}),
    requireSessionAccess: async () => true,
    isSessionVisibleToAuthSession: () => true,
    getAuthPrincipalId: () => 'owner',
    getAuthScopeAgentId: () => '',
    isAgentScopedAuthSession: () => false,
    resolveRequestedSessionAttachments: async () => [],
    writeJson: (res, statusCode, payload) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    },
    writeJsonCached: (res, response, payload) => {
      response.writeHead(200, { 'Content-Type': 'application/json', ETag: 'test-etag' });
      response.end(JSON.stringify(payload));
    },
  });
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.sessionId, session.id);
  assert.equal(payload.session.id, session.id);
  assert.deepEqual(payload.events.map((event) => event.content), ['hello', 'world']);
  assert.equal(payload.latestSeq >= 2, true);
  assert.equal(payload.filter, 'visible');
  console.log('test-session-snapshot-route: ok');
} finally {
  await killAll();
  rmSync(home, { recursive: true, force: true });
}
