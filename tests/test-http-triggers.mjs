#!/usr/bin/env node
import assert from 'assert/strict';
import { createHmac } from 'crypto';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';
const authSessionSecret = 'http-test-auth-session-secret';
const authSessionKey = `s${createHmac('sha256', authSessionSecret).update('test-session').digest('hex')}`;

function randomPort() {
  return 34000 + Math.floor(Math.random() * 10000);
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

function request(port, method, path, body = null) {
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
  const home = mkdtempSync(join(tmpdir(), 'ragent-http-triggers-'));
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
      [authSessionKey]: { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
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
const delay = Number(process.env.FAKE_CODEX_DELAY_MS || '300');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-trigger-test' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'trigger run finished' }
  }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 }
  }));
}, delay);
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
      CHAT_BIND_HOST: '127.0.0.1',
      SECURE_COOKIES: '0',
      FAKE_CODEX_DELAY_MS: '300',
      RAGENT_TRIGGER_POLL_MS: '50',
      RAGENT_AUTH_SESSION_SECRET: authSessionSecret,
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
  }, `server startup (stdout: ${stdout}; stderr: ${stderr})`);

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function createSession(port, { name = 'Trigger Test', group = 'Tests', description = 'Trigger delivery session' } = {}) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name,
    group,
    description,
  });
  assert.equal(res.status, 201, 'create session should succeed');
  return res.json.session;
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    if (!['completed', 'failed', 'cancelled'].includes(res.json.run.state)) return false;
    return res.json.run;
  }, `run ${runId} terminal`);
}

async function getEvents(port, sessionId) {
  const res = await request(port, 'GET', `/api/sessions/${sessionId}/events`);
  assert.equal(res.status, 200, 'events request should succeed');
  return res.json.events || [];
}

async function main() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });

  try {
    const session = await createSession(port);

    const createTriggerRes = await request(port, 'POST', '/api/triggers', {
      sessionId: session.id,
      title: 'Morning check-in',
      scheduledAt: new Date(Date.now() + 200).toISOString(),
      text: 'Please give me a short morning check-in and one next step.',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
    });
    assert.equal(createTriggerRes.status, 201, 'create trigger should succeed');
    const trigger = createTriggerRes.json.trigger;
    assert.equal(trigger.status, 'pending');
    assert.equal(trigger.triggerType, 'at_time');
    assert.equal(trigger.actionType, 'session_message');
    assert.equal(trigger.inputMode, 'user_message');

    const listRes = await request(port, 'GET', `/api/triggers?sessionId=${encodeURIComponent(session.id)}`);
    assert.equal(listRes.status, 200, 'list triggers should succeed');
    assert.equal(listRes.json.triggers.length, 1, 'session filter should find the trigger');

    const deliveredTrigger = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/triggers/${trigger.id}`);
      if (res.status !== 200) return false;
      if (res.json.trigger.status !== 'delivered') return false;
      return res.json.trigger;
    }, 'trigger delivery');

    assert.equal(deliveredTrigger.enabled, false, 'delivered trigger should disable itself');
    assert.equal(deliveredTrigger.deliveryMode, 'run', 'idle target session should produce a real run');
    assert.ok(deliveredTrigger.runId, 'delivered trigger should keep the created run id');

    const run = await waitForRunTerminal(port, deliveredTrigger.runId);
    assert.equal(run.state, 'completed', 'triggered run should complete');

    await sleep(300);
    const events = await getEvents(port, session.id);
    assert.ok(
      events.some((event) => event.type === 'status' && event.content === 'scheduled trigger fired: Morning check-in'),
      'session history should record the trigger fire event',
    );
    assert.equal(
      events.filter((event) => event.type === 'message' && event.role === 'user' && event.requestId === trigger.requestId).length,
      1,
      'trigger requestId should only enter the session once',
    );

    const internalTriggerRes = await request(port, 'POST', '/api/triggers', {
      sessionId: session.id,
      title: 'Internal maintenance continuation',
      scheduledAt: new Date(Date.now() + 200).toISOString(),
      text: 'Continue the internal maintenance task using the current durable state.',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
      inputMode: 'internal_continuation',
    });
    assert.equal(internalTriggerRes.status, 201, 'internal continuation trigger should be accepted');
    const internalTrigger = internalTriggerRes.json.trigger;
    assert.equal(internalTrigger.inputMode, 'internal_continuation');
    const deliveredInternal = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/triggers/${internalTrigger.id}`);
      return res.status === 200 && res.json.trigger.status === 'delivered' ? res.json.trigger : false;
    }, 'internal trigger delivery');
    assert.equal(deliveredInternal.deliveryMode, 'run');
    assert.ok(deliveredInternal.runId, 'internal continuation should still create a provider Run');
    await waitForRunTerminal(port, deliveredInternal.runId);
    await sleep(150);
    const afterInternalEvents = await getEvents(port, session.id);
    assert.equal(
      afterInternalEvents.filter((event) => event.type === 'message' && event.role === 'user' && event.requestId === internalTrigger.requestId).length,
      0,
      'internal trigger input must never be persisted as a user message',
    );

    const statusTriggerRes = await request(port, 'POST', '/api/triggers', {
      sessionId: session.id,
      title: 'Status-only lifecycle notice',
      scheduledAt: new Date(Date.now() + 200).toISOString(),
      text: 'A maintenance lifecycle event completed.',
      inputMode: 'status_notification',
    });
    assert.equal(statusTriggerRes.status, 201, 'status notification trigger should be accepted');
    const statusTrigger = statusTriggerRes.json.trigger;
    const deliveredStatus = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/triggers/${statusTrigger.id}`);
      return res.status === 200 && res.json.trigger.status === 'delivered' ? res.json.trigger : false;
    }, 'status-only trigger delivery');
    assert.equal(deliveredStatus.deliveryMode, 'status', 'status notification should not start a provider Run');
    assert.equal(deliveredStatus.runId, '', 'status notification should have no Run id');
    const afterStatusEvents = await getEvents(port, session.id);
    assert.equal(
      afterStatusEvents.filter((event) => event.type === 'message' && event.role === 'user' && event.requestId === statusTrigger.requestId).length,
      0,
      'status notification must never create a user message',
    );

    const futureTriggerRes = await request(port, 'POST', '/api/triggers', {
      sessionId: session.id,
      title: 'Later follow-up',
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      text: 'Do a later follow-up.',
      tool: 'fake-codex',
    });
    assert.equal(futureTriggerRes.status, 201, 'second trigger should be created');
    const futureTrigger = futureTriggerRes.json.trigger;

    const cancelRes = await request(port, 'PATCH', `/api/triggers/${futureTrigger.id}`, {
      enabled: false,
      title: 'Later follow-up paused',
    });
    assert.equal(cancelRes.status, 200, 'patch trigger should succeed');
    assert.equal(cancelRes.json.trigger.status, 'cancelled', 'disabled pending trigger should become cancelled');
    assert.equal(cancelRes.json.trigger.title, 'Later follow-up paused');

    const deleteRes = await request(port, 'DELETE', `/api/triggers/${futureTrigger.id}`);
    assert.equal(deleteRes.status, 200, 'delete trigger should succeed');

    const afterDeleteRes = await request(port, 'GET', `/api/triggers/${futureTrigger.id}`);
    assert.equal(afterDeleteRes.status, 404, 'deleted trigger should not be found');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-http-triggers: ok');
}

await main();
