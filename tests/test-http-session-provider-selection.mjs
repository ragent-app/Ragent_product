#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cookie = 'session_token=test-session';

function randomPort() {
  return 37000 + Math.floor(Math.random() * 2000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-session-provider-'));
  const configDir = join(home, '.config', 'ragent');
  const binDir = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
    token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  }), 'utf8');
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
  }), 'utf8');
  writeFileSync(join(configDir, 'tools.json'), JSON.stringify([
    {
      id: 'provider-one',
      name: 'Provider One',
      command: 'provider-one',
      runtimeFamily: 'codex-json',
      models: [],
      reasoning: { kind: 'none' },
    },
    {
      id: 'provider-two',
      name: 'Provider Two',
      command: 'provider-two',
      runtimeFamily: 'codex-json',
      models: [],
      reasoning: { kind: 'none' },
    },
  ]), 'utf8');

  for (const provider of ['provider-one', 'provider-two']) {
    const commandPath = join(binDir, provider);
    writeFileSync(commandPath, `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'thread.started', thread_id: '${provider}-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '${provider}' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`, 'utf8');
    chmodSync(commandPath, 0o755);
  }

  return { home, configDir, binDir };
}

async function startServer({ home, configDir, binDir, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
      RAGENT_AUTH_SESSION_SECRET: 'test-secret-ragent-session-provider-selection',
      RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitFor(async () => {
    try {
      return (await request(port, 'GET', '/api/auth/me')).status === 200;
    } catch {
      return false;
    }
  }, 'server startup');
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'server shutdown');
}

const { home, configDir, binDir } = setupTempHome();
const port = randomPort();
const server = await startServer({ home, configDir, binDir, port });

try {
  const created = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'provider-one',
    name: 'Session Provider selection',
  });
  assert.equal(created.status, 201);
  const sessionId = created.json.session.id;

  const first = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId: 'provider-request-one',
    text: 'Use the session Provider',
    tool: 'provider-two',
  });
  assert.equal(first.status, 202);
  assert.equal(first.json.run?.tool, 'provider-one', 'legacy message tool must not override the session Provider');
  assert.equal(first.json.session?.tool, 'provider-one', 'ordinary send must not mutate session Provider');

  await waitFor(async () => (
    (await request(port, 'GET', `/api/sessions/${sessionId}`)).json?.session?.activity?.run?.state === 'idle'
  ), 'first Provider run completion');

  const patched = await request(port, 'PATCH', `/api/sessions/${sessionId}`, { tool: 'provider-two' });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.session?.tool, 'provider-two', 'PATCH should durably change this session Provider');

  const second = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId: 'provider-request-two',
    text: 'Use the updated session Provider',
  });
  assert.equal(second.status, 202);
  assert.equal(second.json.run?.tool, 'provider-two', 'the next Run should use the Provider stored on the session');
  assert.equal(second.json.session?.tool, 'provider-two');

  console.log('test-http-session-provider-selection: ok');
} finally {
  await stopServer(server);
  rmSync(home, { recursive: true, force: true });
}
