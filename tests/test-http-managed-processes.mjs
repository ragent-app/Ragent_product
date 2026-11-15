#!/usr/bin/env node
import assert from 'assert/strict';
import { createHmac } from 'crypto';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cookie = 'session_token=managed-process-test-session';
const authSessionSecret = 'managed-process-test-auth-session-secret';
const authSessionKey = `s${createHmac('sha256', authSessionSecret).update('managed-process-test-session').digest('hex')}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 15000, intervalMs = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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
        ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-http-managed-processes-'));
  const configDir = join(home, '.config', 'ragent');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
    token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  }), 'utf8');
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    [authSessionKey]: { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
  }), 'utf8');
  writeFileSync(join(configDir, 'tools.json'), JSON.stringify([{
    id: 'fake-codex',
    name: 'Fake Codex',
    command: 'fake-codex',
    runtimeFamily: 'codex-json',
    models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
    reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
  }]), 'utf8');
  writeFileSync(join(localBin, 'fake-codex'), `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'managed-process-test-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'managed wake handled' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, 30);
`, 'utf8');
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home, localBin };
}

function randomPort() {
  return 34000 + Math.floor(Math.random() * 10000);
}

async function startServer({ home, localBin, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ''}`,
      CHAT_PORT: String(port),
      CHAT_BIND_HOST: '127.0.0.1',
      SECURE_COOKIES: '0',
      RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
      RAGENT_AUTH_SESSION_SECRET: authSessionSecret,
      RAGENT_TRIGGER_POLL_MS: '250',
      RAGENT_MANAGED_PROCESS_POLL_MS: '250',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitFor(async () => {
    try { return (await request(port, 'GET', '/api/auth/me')).status === 200; } catch { return false; }
  }, `server startup (stdout: ${stdout}; stderr: ${stderr})`);
  return { child };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function createSession(port) {
  const response = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name: 'Managed process test',
    group: 'Tests',
    description: 'Managed process lifecycle test',
  });
  assert.equal(response.status, 201, 'session creation should succeed');
  return response.json.session;
}

async function getProcess(port, processId) {
  const response = await request(port, 'GET', `/api/managed-processes/${processId}`);
  if (response.status !== 200) return null;
  return response.json.process;
}

async function getEvents(port, sessionId) {
  const response = await request(port, 'GET', `/api/sessions/${sessionId}/events?filter=all`);
  assert.equal(response.status, 200, 'session events should be readable');
  return response.json.events || [];
}

async function main() {
  const fixture = setupTempHome();
  const port = randomPort();
  const server = await startServer({ ...fixture, port });
  const createdProcessIds = [];

  try {
    const session = await createSession(port);

    // The command exits immediately after writing both streams. This covers
    // listener ordering and durable output cursor updates.
    const fastResponse = await request(port, 'POST', `/api/sessions/${session.id}/managed-processes`, {
      executable: process.execPath,
      args: ['-e', "process.stdout.write('fast-stdout\\n'); process.stderr.write('fast-stderr\\n');"],
      cwd: repoRoot,
      wake: {
        on: ['terminal'],
        includeOutput: true,
        text: 'managed {{process.id}} state={{process.state}} output={{process.output}}',
      },
    });
    assert.equal(fastResponse.status, 201, 'fast managed process creation should succeed');
    const fastProcessId = fastResponse.json.process.id;
    createdProcessIds.push(fastProcessId);
    const fastProcess = await waitFor(async () => {
      const process = await getProcess(port, fastProcessId);
      return process?.state === 'completed' && process.feedbackDeliveredAt ? process : false;
    }, 'fast process terminal state and wake');
    assert.ok(fastProcess.stdout.includes('fast-stdout'), 'stdout tail should be persisted');
    assert.ok(fastProcess.stderr.includes('fast-stderr'), 'stderr tail should be persisted');
    assert.ok(fastProcess.stdoutBytes > 0 && fastProcess.stderrBytes > 0, 'stream byte counters should be persisted');

    let terminalEvents = [];
    await waitFor(async () => {
      terminalEvents = await getEvents(port, session.id);
      return terminalEvents.some((event) => event.type === 'status'
        && event.content === `managed process ${fastProcessId} finished: completed`);
    }, 'terminal wake status event');

    // Output wake is independent from terminal wake. The process emits output,
    // stays alive briefly, and the supervisor must deliver the output cursor.
    const outputResponse = await request(port, 'POST', `/api/sessions/${session.id}/managed-processes`, {
      executable: process.execPath,
      args: ['-e', "process.stdout.write('output-wake\\n'); setTimeout(() => {}, 700);"],
      cwd: repoRoot,
      wake: { on: ['output'], text: 'output from {{process.id}}: {{process.output}}' },
    });
    assert.equal(outputResponse.status, 201, 'output managed process creation should succeed');
    const outputProcessId = outputResponse.json.process.id;
    createdProcessIds.push(outputProcessId);

    const terminalTriggerResponse = await request(port, 'POST', '/api/triggers', {
      sessionId: session.id,
      eventType: 'process_terminal',
      eventFilter: { processId: outputProcessId },
      text: 'terminal event for {{event.processId}} state={{event.state}}',
      title: 'Process terminal event',
    });
    assert.equal(terminalTriggerResponse.status, 201, 'process terminal event trigger should succeed');

    const outputFeedback = await waitFor(async () => {
      const process = await getProcess(port, outputProcessId);
      return process?.outputFeedbackSeq > 0 ? process : false;
    }, 'output wake delivery');
    assert.ok(outputFeedback.outputSeq > 0, 'output wake should observe a durable output sequence');

    const outputTerminal = await waitFor(async () => {
      const process = await getProcess(port, outputProcessId);
      return process?.state === 'completed' ? process : false;
    }, 'output process terminal state');
    assert.equal(outputTerminal.feedbackDeliveredAt, '', 'output-only wake must not deliver a second terminal wake');

    await waitFor(async () => {
      const events = await getEvents(port, session.id);
      return events.some((event) => event.type === 'status'
        && event.content === 'event trigger fired: Process terminal event');
    }, 'process terminal event trigger delivery');

    const cancelResponse = await request(port, 'POST', `/api/sessions/${session.id}/managed-processes`, {
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000);'],
      cwd: repoRoot,
      wake: { on: ['output'], text: 'cancel test output' },
    });
    assert.equal(cancelResponse.status, 201, 'cancellable process creation should succeed');
    const cancelProcessId = cancelResponse.json.process.id;
    createdProcessIds.push(cancelProcessId);
    await waitFor(async () => {
      const process = await getProcess(port, cancelProcessId);
      return ['starting', 'running'].includes(process?.state) ? process : false;
    }, 'cancellable process start');
    const cancelledResponse = await request(port, 'POST', `/api/managed-processes/${cancelProcessId}/cancel`);
    assert.equal(cancelledResponse.status, 200, 'managed process cancellation should succeed');
    const cancelled = await waitFor(async () => {
      const process = await getProcess(port, cancelProcessId);
      return process?.state === 'cancelled' ? process : false;
    }, 'cancelled process terminal state');
    assert.equal(cancelled.state, 'cancelled');
  } finally {
    if (server.child.exitCode === null) {
      const list = await request(port, 'GET', '/api/managed-processes').catch(() => null);
      for (const process of list?.json?.processes || []) {
        if (createdProcessIds.includes(process.id) && !['completed', 'failed', 'cancelled', 'unknown'].includes(process.state)) {
          await request(port, 'POST', `/api/managed-processes/${process.id}/cancel`).catch(() => {});
        }
      }
    }
    await stopServer(server);
    rmSync(fixture.home, { recursive: true, force: true });
  }

  console.log('test-http-managed-processes: ok');
}

await main();
