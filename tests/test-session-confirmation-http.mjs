#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 33000 + Math.floor(Math.random() * 10000);
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
  const home = mkdtempSync(join(tmpdir(), 'ragent-session-confirmation-http-'));
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
      },
    ], null, 2),
    'utf8',
  );
  writeFileSync(
    join(localBin, 'fake-codex'),
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: "thread.started", thread_id: "unused" }));\n',
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home, configDir, localBin };
}

async function startServer({ home, configDir, localBin, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: "",
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: "",
      HOME: home,
      CHAT_PORT: String(port),
      RAGENT_CHAT_BASE_URL: `http://127.0.0.1:${port}`,
      RAGENT_INSTANCE_ROOT: '',
      RAGENT_CONFIG_DIR: configDir,
      SECURE_COOKIES: '0',
      RAGENT_REPLY_SELF_CHECK: 'off',
      PATH: `${localBin}:${process.env.PATH || ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/auth/me');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return {
    child,
    getOutput: () => `${stdout}\n${stderr}`.trim(),
  };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
  await sleep(150);
}

async function createSession(port) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name: 'Confirmation HTTP',
    group: 'Tests',
  });
  assert.equal(res.status, 201, `create session should succeed: ${res.text}`);
  return res.json.session;
}

const { home, configDir, localBin } = setupTempHome();
const port = randomPort();
let server = null;
try {
  server = await startServer({ home, configDir, localBin, port });
  const session = await createSession(port);

  const create = await request(port, 'POST', `/api/sessions/${encodeURIComponent(session.id)}/confirmations`, {
    approvalId: 'confirm-http',
    title: 'Restart service?',
    reason: 'Exercise HTTP confirmation route.',
    questions: [{
      id: 'restart_window',
      header: 'Restart window',
      question: 'When should the restart happen?',
      options: [
        { label: 'Now', description: 'Restart immediately.' },
        { label: 'Later', description: 'Wait for a quiet window.' },
      ],
    }],
    confirmLabel: 'Restart',
    denyLabel: 'Skip',
  });
  assert.equal(create.status, 201, `confirmation create should succeed: ${create.text}`);
  assert.equal(create.json.duplicate, false);
  assert.equal(create.json.confirmation?.type, 'approval_request');
  assert.equal(create.json.confirmation?.source, 'ragent-confirmation');
  assert.equal(create.json.confirmation?.kind, 'confirmation');
  assert.equal(create.json.confirmation?.confirmLabel, 'Restart');
  assert.equal(create.json.confirmation?.denyLabel, 'Skip');
  assert.deepEqual(create.json.confirmation?.questions, [{
    id: 'restart_window',
    header: 'Restart window',
    question: 'When should the restart happen?',
    options: [
      { label: 'Now', value: 'Now', description: 'Restart immediately.' },
      { label: 'Later', value: 'Later', description: 'Wait for a quiet window.' },
    ],
  }]);

  const duplicateCreate = await request(port, 'POST', `/api/sessions/${encodeURIComponent(session.id)}/confirmations`, {
    approvalId: 'confirm-http',
  });
  assert.equal(duplicateCreate.status, 200, `duplicate confirmation create should be idempotent: ${duplicateCreate.text}`);
  assert.equal(duplicateCreate.json.duplicate, true);

  const decision = await request(port, 'POST', `/api/sessions/${encodeURIComponent(session.id)}/confirmations/confirm-http`, {
    decision: 'deny',
    requestId: 'req-confirm-http-deny',
  });
  assert.equal(decision.status, 202, `confirmation decision should succeed: ${decision.text}`);
  assert.equal(decision.json.duplicate, false);
  assert.equal(decision.json.responseEvent?.type, 'approval_response');
  assert.equal(decision.json.responseEvent?.status, 'denied');
  assert.equal(decision.json.responseEvent?.source, 'ragent-confirmation');

  const duplicateDecision = await request(port, 'POST', `/api/sessions/${encodeURIComponent(session.id)}/confirmations/confirm-http`, {
    decision: 'deny',
    requestId: 'req-confirm-http-deny-2',
  });
  assert.equal(duplicateDecision.status, 200, `duplicate confirmation decision should be idempotent: ${duplicateDecision.text}`);
  assert.equal(duplicateDecision.json.duplicate, true);

  const events = await request(port, 'GET', `/api/sessions/${encodeURIComponent(session.id)}/events?filter=visible`);
  assert.equal(events.status, 200, `visible events should succeed: ${events.text}`);
  const requestEvents = events.json.events.filter((event) =>
    event.type === 'approval_request' && event.source === 'ragent-confirmation');
  const responseEvents = events.json.events.filter((event) =>
    event.type === 'approval_response' && event.source === 'ragent-confirmation');
  assert.equal(requestEvents.length, 1, 'confirmation request should be stored once');
  assert.equal(responseEvents.length, 1, 'confirmation response should be stored once');

  console.log('test-session-confirmation-http: ok');
} catch (error) {
  if (server?.getOutput) {
    console.error(server.getOutput());
  }
  throw error;
} finally {
  await stopServer(server);
  rmSync(home, { recursive: true, force: true });
}
