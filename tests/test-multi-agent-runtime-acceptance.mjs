#!/usr/bin/env node
// Focused §9 acceptance over a real temporary chat-server process. The fake
// provider is deterministic, so this validates the control-plane boundary,
// parallel child dispatch, Reviewer task presence, aggregation, and recovery
// without depending on a live external provider account.
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
  return 39000 + Math.floor(Math.random() * 3000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 30000, intervalMs = 100) {
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
  const home = mkdtempSync(join(tmpdir(), 'ragent-multi-agent-acceptance-'));
  const configDir = join(home, '.config', 'ragent');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
    token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  }), 'utf8');
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
  }), 'utf8');
  writeFileSync(join(configDir, 'tools.json'), JSON.stringify([
    { id: 'fake-root', name: 'Fake Root', command: 'fake-root', runtimeFamily: 'codex-json', models: [{ id: 'fake', label: 'fake' }] },
    { id: 'fake-worker', name: 'Fake Worker', command: 'fake-worker', runtimeFamily: 'codex-json', models: [{ id: 'fake', label: 'fake' }] },
  ]), 'utf8');

  const plan = {
    schemaVersion: 1,
    idempotencyKey: 'real-service-acceptance',
    title: 'Real service bounded collaboration',
    plan: {
      workspacePolicy: 'shared-exclusive',
      gates: { independentReview: true },
      tasks: [
        {
          id: 'worker-task',
          objective: 'Inspect the assigned workspace and report evidence.',
          agentId: 'worker-agent',
          role: 'specialist',
          acceptance: ['bounded evidence is returned'],
          writablePaths: [],
        },
        {
          id: 'review-task',
          objective: 'Independently review the worker acceptance evidence.',
          agentId: 'reviewer-agent',
          role: 'reviewer',
          acceptance: ['review decision is returned'],
          writablePaths: [],
        },
      ],
    },
  };
  const planText = JSON.stringify(plan);
  writeFileSync(join(configDir, 'apps.json'), JSON.stringify([
    {
      id: 'worker-agent',
      name: 'Worker Agent',
      tool: 'fake-worker',
      collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'worker-r1' },
    },
    {
      id: 'reviewer-agent',
      name: 'Reviewer Agent',
      tool: 'fake-worker',
      collaborationPolicy: { role: 'reviewer', canDelegate: false, canReview: true, revision: 'reviewer-r1' },
    },
  ]), 'utf8');

  writeFileSync(join(localBin, 'fake-root'), `#!/usr/bin/env node
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'root-thread' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(`Plan accepted by the model.\n<ragent-collaboration-plan>${planText}</ragent-collaboration-plan>`)} } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, 60);
`, 'utf8');
  writeFileSync(join(localBin, 'fake-worker'), `#!/usr/bin/env node
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'worker-thread' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<ragent-result-packet>{"state":"completed","summary":"Bounded evidence returned.","changedFiles":[],"tests":["fake acceptance"],"risks":[],"blockers":[],"acceptanceNotes":["criterion satisfied"],"unresolvedItems":[]}</ragent-result-packet>' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, 700);
`, 'utf8');
  chmodSync(join(localBin, 'fake-root'), 0o755);
  chmodSync(join(localBin, 'fake-worker'), 0o755);
  return { home, configDir, repoRoot };
}

async function startServer({ home, configDir, port }) {
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      RAGENT_CHAT_BASE_URL: `http://127.0.0.1:${port}`,
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_INSTANCE_ROOT: '',
      RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
      RAGENT_COLLABORATION_LEADER_ENABLED: '1',
      RAGENT_REVIEWER_ENABLED: '0',
      SECURE_COOKIES: '0',
      RAGENT_AUTH_SESSION_SECRET: 'acceptance-secret',
      PATH: `${join(home, '.local', 'bin')}:${process.env.PATH || ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    await waitFor(() => stdout.includes(`Chat server listening on http://127.0.0.1:${port}`), 'server startup', 30000);
  } catch (error) {
    child.kill('SIGTERM');
    await waitFor(() => child.exitCode !== null, 'server shutdown after startup failure');
    throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 'server shutdown');
}

async function waitForCollaboration(port, predicate, description) {
  let last = null;
  try {
    return await waitFor(async () => {
    const response = await request(port, 'GET', '/api/collaborations');
    last = response;
    if (response.status !== 200) return false;
    const collaboration = response.json?.collaborations?.[0];
    return collaboration && predicate(collaboration) ? collaboration : false;
    }, description);
  } catch (error) {
    throw new Error(`${error.message}; last response: ${JSON.stringify(last)}`);
  }
}

let server = null;
let home = '';
try {
  const setup = setupTempHome();
  home = setup.home;
  const port = randomPort();
  server = await startServer({ ...setup, port });

  const created = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-root',
    name: 'Real multi-agent acceptance root',
  });
  assert.equal(created.status, 201);
  const root = created.json.session;
  const rootRun = await request(port, 'POST', `/api/sessions/${root.id}/messages`, { text: 'Plan this bounded task.' });
  assert.equal(rootRun.status, 202, rootRun.text);
  const rootRunId = rootRun.json.run.id;
  const rootTerminal = await waitFor(async () => {
    const response = await request(port, 'GET', `/api/runs/${rootRunId}`);
    return ['completed', 'failed', 'cancelled'].includes(response.json?.run?.state)
      ? response.json.run
      : false;
  }, 'root run terminal');
  assert.equal(rootTerminal.state, 'completed', `root provider failed: ${rootTerminal.failureReason || 'unknown'}`);

  const running = await waitForCollaboration(port, (collaboration) => (
    ['running', 'aggregating', 'completed'].includes(collaboration.state)
      && collaboration.tasks.length === 2
      && collaboration.tasks.every((task) => task.runId)
  ), 'durable collaboration dispatch');
  assert.equal(running.tasks.length, 2, 'real service dispatches both independent tasks');
  assert.deepEqual(new Set(running.tasks.map((task) => task.role)), new Set(['specialist', 'reviewer']));
  assert.ok(running.tasks.every((task) => task.runId), 'both tasks have Runtime-created Runs');

  // Interrupt the control plane while child work is still in flight when the
  // deterministic provider has left it active; otherwise this remains a
  // clean restart check over already terminal durable facts.
  await stopServer(server);
  server = await startServer({ ...setup, port });

  const completed = await waitForCollaboration(port, (collaboration) => collaboration.state === 'completed', 'collaboration aggregation after restart');
  assert.equal(completed.tasks.every((task) => task.state === 'succeeded'), true, 'worker and reviewer complete after restart');
  assert.ok(completed.aggregationRunId, 'aggregation Run is durable');
  assert.equal(completed.attempts.length, 2, 'each task has exactly one Attempt');
  const serialized = JSON.stringify(completed);
  for (const forbidden of ['prompt', 'grantToken', 'capabilityToken', 'transcript', 'rawHistory']) {
    assert.equal(serialized.includes(forbidden), false, `public collaboration response omits ${forbidden}`);
  }

  const sessions = await request(port, 'GET', '/api/sessions');
  assert.equal(sessions.status, 200);
  assert.ok(sessions.json.sessions.some((session) => session.id === root.id), 'Root remains user-addressable');
  assert.equal(sessions.json.sessions.some((session) => session.id !== root.id && session.userAddressable === false), false, 'managed child sessions are not exposed as user sessions');

  await stopServer(server);
  server = null;
  rmSync(home, { recursive: true, force: true });
  home = '';
  console.log('test-multi-agent-runtime-acceptance: ok');
} catch (error) {
  await stopServer(server);
  if (home) rmSync(home, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
}
