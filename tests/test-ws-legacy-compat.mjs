#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';
import WebSocket from 'ws';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cookie = 'session_token=test-session';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function randomPort() {
  return 43000 + Math.floor(Math.random() * 10000);
}

function request(port, method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Cookie: cookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-ws-push-only-'));
  const configDir = join(home, '.config', 'ragent');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });

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
  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify([
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
        reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
      },
    ], null, 2),
    'utf8',
  );
  writeFileSync(
    join(localBin, 'fake-codex'),
    `#!/usr/bin/env node
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'push-only ok' }
  }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 }
  }));
}, 50);
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home };
}

async function startServer({ home, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: "",
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: "",
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      RAGENT_AUTH_SESSION_SECRET: 'test-secret-ragent-ws-legacy-compat',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/auth/me');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return { child };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function createSession(port, name) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name,
    group: 'Tests',
    description: 'WS push-only test',
  });
  assert.equal(res.status, 201, 'create session should succeed');
  return res.json.session;
}

async function submitMessage(port, sessionId, requestId) {
  const res = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId,
    text: 'Run the fake tool',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.ok(res.status === 202 || res.status === 200, 'submit message should succeed');
  return res.json.run;
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    return res.status === 200 && ['completed', 'failed', 'cancelled'].includes(res.json.run.state);
  }, 'run terminal');
}

const { home } = setupTempHome();
const port = randomPort();
const server = await startServer({ home, port });

try {
  const rejected = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
    socket.on('open', () => {
      socket.send(JSON.stringify({ action: 'attach', sessionId: 'legacy-session' }));
    });
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    socket.on('error', reject);
  });

  assert.equal(rejected.code, 1008, 'websocket should reject legacy request/response actions');
  assert.match(rejected.reason, /push-only/i, 'close reason should explain the push-only contract');

  const messages = [];
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
  });

  const session = await createSession(port, 'push only websocket');
  const run = await submitMessage(port, session.id, 'req-ws-push-only');
  await waitForRunTerminal(port, run.id);
  await waitFor(
    () => messages.some((msg) => msg.type === 'session_invalidated' && msg.sessionId === session.id),
    'session invalidation',
  );

  const forbidden = new Set(['session', 'sessions', 'history', 'event', 'archived_list', 'unarchived', 'ws_ready']);
  assert.equal(
    messages.some((msg) => forbidden.has(msg.type)),
    false,
    'websocket should only carry invalidation hints',
  );

  ws.close();
  console.log('test-ws-legacy-compat: ok');
} finally {
  await stopServer(server);
  rmSync(home, { recursive: true, force: true });
}
