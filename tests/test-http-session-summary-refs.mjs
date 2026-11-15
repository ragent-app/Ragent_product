#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 36400 + Math.floor(Math.random() * 4000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-http-session-summary-refs-'));
  const configDir = join(home, '.config', 'ragent');
  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
    }, null, 2),
    'utf8',
  );

  return { home };
}

async function startServer({ home, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: "",
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: "",
      RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
      RAGENT_CONFIG_DIR: join(home, '.config', 'ragent'),
      RAGENT_AUTH_SESSION_SECRET: 'test-session-secret',
      RAGENT_LOCAL_WEB_AUTH: '0',
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let startupError = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { startupError = (startupError + chunk.toString()).slice(-4096); });

  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited during startup: ${startupError}`);
      try {
        const res = await request(port, 'GET', '/api/auth/me');
        return res.status === 200;
      } catch {
        return false;
      }
    }, 'server startup');
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'failed server shutdown');
    }
    throw new Error(`${error.message}\n${startupError}`);
  }

  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'server shutdown');
}

try {
  const { home } = setupTempHome();
  const customWorkspace = join(home, 'custom-workspace');
  mkdirSync(customWorkspace, { recursive: true });
  const port = randomPort();
  let server;
  try {
    server = await startServer({ home, port });
    const created = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'codex',
      name: 'Summary refs session',
      group: 'HTTP',
      description: 'Refs and summary cache contract',
    });
    assert.equal(created.status, 201, 'session creation should succeed');
    const sessionId = created.json.session.id;
    const otherCreated = await request(port, 'POST', '/api/sessions', {
      folder: customWorkspace,
      tool: 'codex',
      name: 'Other workspace session',
      group: 'HTTP',
    });
    assert.equal(otherCreated.status, 201, 'second workspace session creation should succeed');
    const otherSessionId = otherCreated.json.session.id;

    const list = await request(port, 'GET', '/api/sessions');
    assert.equal(list.status, 200, 'default session list should succeed');
    const listSession = (list.json.sessions || []).find((entry) => entry.id === sessionId);
    assert.ok(listSession, 'default session list should include the created session payload');

    const compact = await request(port, 'GET', '/api/sessions?view=summary');
    assert.equal(compact.status, 200, 'compact session list should succeed');
    const compactSession = compact.json.sessions.find((entry) => entry.id === sessionId);
    assert.ok(compactSession, 'compact list should contain the same session');
    for (const key of ['id', 'name', 'projectId', 'status', 'updatedAt']) {
      assert.equal(compactSession[key], listSession[key], `compact list must preserve ${key}`);
    }
    assert.equal('description' in compactSession, false, 'compact list should omit detail fields');
    assert.ok(Buffer.byteLength(compact.text) < Buffer.byteLength(list.text), 'compact list should be smaller');
    const compactFiltered = await request(port, 'GET', `/api/sessions?view=summary&folder=${encodeURIComponent(repoRoot)}`);
    assert.equal(compactFiltered.status, 200);
    assert.equal(compactFiltered.json.sessions.some((entry) => entry.id === otherSessionId), false,
      'compact view must retain the existing folder filter');

    const refs = await request(port, 'GET', '/api/sessions?view=refs');
    assert.equal(refs.status, 200, 'refs-only session list should succeed');
    assert.equal(Array.isArray(refs.json.sessions), false, 'refs-only session list should omit full session payloads');
    const ref = (refs.json.sessionRefs || []).find((entry) => entry.id === sessionId);
    assert.ok(ref, 'refs-only session list should include the created session ref');
    assert.equal(typeof ref.summaryEtag, 'string', 'session refs should expose a summary etag');

    const repoFiltered = await request(port, 'GET', `/api/sessions?folder=${encodeURIComponent(repoRoot)}`);
    assert.equal(repoFiltered.status, 200, 'folder-filtered active session list should succeed');
    assert.ok(
      (repoFiltered.json.sessions || []).some((entry) => entry.id === sessionId),
      'folder-filtered list should include sessions from the requested workspace',
    );
    assert.equal(
      (repoFiltered.json.sessions || []).some((entry) => entry.id === otherSessionId),
      false,
      'folder-filtered list should exclude sessions from other workspaces',
    );

    const deletedOther = await request(port, 'DELETE', `/api/sessions/${otherSessionId}`);
    assert.equal(deletedOther.status, 200, 'direct session deletion should succeed');
    assert.equal(deletedOther.json?.deleted, true, 'delete response should confirm durable removal');
    const deletedDetail = await request(port, 'GET', `/api/sessions/${otherSessionId}`);
    assert.equal(deletedDetail.status, 404, 'a deleted session should no longer be accessible');
    const remaining = await request(port, 'GET', `/api/sessions?folder=${encodeURIComponent(customWorkspace)}`);
    assert.equal(
      (remaining.json.sessions || []).some((entry) => entry.id === otherSessionId),
      false,
      'direct deletion should remove the session from folder-filtered lists',
    );

    const summary = await request(port, 'GET', `/api/sessions/${sessionId}?view=summary`);
    assert.equal(summary.status, 200, 'summary session route should succeed');
    assert.equal(summary.headers.etag, ref.summaryEtag, 'summary route ETag should match the list ref tag');
    assert.equal(
      Object.prototype.hasOwnProperty.call(summary.json?.session || {}, 'task'),
      false,
      'summary route should omit legacy task metadata',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(summary.json.session, 'queuedMessages'),
      false,
      'summary route should omit queuedMessages',
    );

    const detail = await request(port, 'GET', `/api/sessions/${sessionId}`);
    assert.equal(detail.status, 200, 'detail session route should still succeed');
    assert.equal(
      Object.prototype.hasOwnProperty.call(detail.json?.session || {}, 'task'),
      false,
      'detail route should omit legacy task metadata',
    );
    assert.equal(Array.isArray(detail.json.session.queuedMessages), true, 'detail route should keep queuedMessages for the attached session view');

    const summary304 = await request(port, 'GET', `/api/sessions/${sessionId}?view=summary`, null, {
      'If-None-Match': ref.summaryEtag,
    });
    assert.equal(summary304.status, 304, 'unchanged summary route should revalidate to 304');

    console.log('test-http-session-summary-refs: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
