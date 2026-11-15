#!/usr/bin/env node
// Regression: structured runtimes (Claude stream-json) re-emit the same
// assistant/tool_use/reasoning snapshot across multiple spool lines as content
// accumulates. The delta durable-write path must dedup these against already
// persisted history so the durable event log keeps each provider id exactly once.
// Mirrors the real-world duplication observed in Claude Code stream-json sessions.
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, delimiter } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 20000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function randomPort() {
  return 52000 + Math.floor(Math.random() * 1000);
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
          resolve({ status: res.statusCode, json, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function line(obj) {
  return JSON.stringify(obj);
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-claude-durable-dedup-'));
  const configDir = join(home, '.config', 'ragent');
  const memoryDir = join(home, '.ragent', 'memory');
  const workDir = join(home, '.ragent', 'workspace');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
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
  // Fake Claude stream-json provider that emits DUPLICATE assistant snapshots
  // (same provider ids) across separate sync windows, mimicking Claude Code's
  // accumulating stream-json output. Without delta-write dedup the durable log
  // would contain tool_use/reasoning/message duplicates.
  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify([
      {
        id: 'fake-claude-dedup',
        name: 'Fake Claude Dedup',
        command: process.platform === 'win32' ? join(localBin, 'fake-claude-dedup.cmd') : 'fake-claude-dedup',
        runtimeFamily: process.platform === 'win32' ? 'claude-stream-json-bidi' : 'claude-stream-json',
        promptMode: 'bare-user',
        models: [{ id: 'sonnet', label: 'Claude Sonnet' }],
      },
    ], null, 2),
    'utf8',
  );
  writeFileSync(
    join(localBin, 'fake-claude-dedup'),
    `#!/usr/bin/env node
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = 'fake-claude-dedup-session';
const j = (o) => console.log(JSON.stringify(o));
async function run() {
  j({ type: 'system', subtype: 'init', session_id: sid });
  // Snapshot 1: reasoning + first parallel tool_use.
  j({ type: 'assistant', session_id: sid, message: { id: 'msg_snap', model: 'sonnet', content: [
    { type: 'thinking', thinking: 'Run two checks. ' + 'x'.repeat(1500) },
    { type: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'ls' } },
  ] } });
  await sleep(250); // land in a separate observer sync window
  // Snapshot 2: re-emits reasoning + toolu_A (duplicate) and adds toolu_B.
  j({ type: 'assistant', session_id: sid, message: { id: 'msg_snap', model: 'sonnet', content: [
    { type: 'thinking', thinking: 'Run two checks. ' + 'x'.repeat(1500) },
    { type: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_use', id: 'toolu_B', name: 'Bash', input: { command: 'pwd' } },
  ] } });
  await sleep(250);
  // Parallel tool results.
  j({ type: 'user', session_id: sid, message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_A', content: 'file.txt' },
    { type: 'tool_result', tool_use_id: 'toolu_B', content: '/tmp' },
  ] } });
  // Final assistant message emitted twice (identical) to exercise message dedup.
  j({ type: 'assistant', session_id: sid, message: { id: 'msg_final', model: 'sonnet', stop_reason: 'end_turn', content: [
    { type: 'text', text: 'Done.' },
  ] } });
  j({ type: 'assistant', session_id: sid, message: { id: 'msg_final', model: 'sonnet', stop_reason: 'end_turn', content: [
    { type: 'text', text: 'Done.' },
  ] } });
  // Some relays omit message.id entirely but preserve a frame uuid. The uuid
  // must remain a durable identity across repeated raw snapshots.
  j({ type: 'assistant', uuid: 'frame_uuid_only', session_id: sid, message: { model: 'sonnet', content: [
    { type: 'text', text: 'UUID-only snapshot.' },
  ] } });
  j({ type: 'assistant', uuid: 'frame_uuid_only', session_id: sid, message: { model: 'sonnet', content: [
    { type: 'text', text: 'UUID-only snapshot.' },
  ] } });
  // Last-resort relay shape: no message.id and no uuid. This is intentionally
  // an exact final-snapshot replay, scoped by the provider session.
  j({ type: 'assistant', session_id: sid, message: { model: 'sonnet', content: [
    { type: 'text', text: 'Fingerprint-only snapshot.' },
  ] } });
  j({ type: 'assistant', session_id: sid, message: { model: 'sonnet', content: [
    { type: 'text', text: 'Fingerprint-only snapshot.' },
  ] } });
  // Same-id growing text snapshots: revision rows are durable by design
  // (append-only storage keeps both bodies; the display projection merges
  // them into one row with the longest body).
  j({ type: 'assistant', session_id: sid, message: { id: 'msg_grow', model: 'sonnet', content: [
    { type: 'text', text: 'Part one.' },
  ] } });
  j({ type: 'assistant', session_id: sid, message: { id: 'msg_grow', model: 'sonnet', content: [
    { type: 'text', text: 'Part one. Part two.' },
  ] } });
  // Relay re-emission under a fresh message id: both rows persist durably,
  // but the display projection must collapse them into one visible reply.
  j({ type: 'assistant', uuid: 'frame_twin_a', session_id: sid, message: { id: 'msg_twin_a', model: 'sonnet', content: [
    { type: 'text', text: 'Twin snapshot.' },
  ] } });
  j({ type: 'assistant', uuid: 'frame_twin_b', session_id: sid, message: { id: 'msg_twin_b', model: 'sonnet', content: [
    { type: 'text', text: 'Twin snapshot.' },
  ] } });
  j({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'Done.',
    usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
}
if (process.platform === 'win32') {
  const readline = require('readline');
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
      j({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    } else if (message.type === 'user') { void run(); }
  });
} else { void run(); }
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-claude-dedup'), 0o755);
  if (process.platform === 'win32') writeFileSync(join(localBin, 'fake-claude-dedup.cmd'),
    `@echo off\r\n"${process.execPath}" "%~dp0fake-claude-dedup" %*\r\n`);
  return { home, configDir, memoryDir, workDir, localBin };
}

async function startServer({ home, configDir, memoryDir, workDir, localBin, port }) {
  const supervisorPipe = process.platform === 'win32' ? `\\\\.\\pipe\\ragent-test-dedup-${randomBytes(12).toString('hex')}` : '';
  const env = {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: supervisorPipe,
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: "",
      RAGENT_RUNNER_LIFECYCLE_SOCKET: "",
      RAGENT_RUNNER_LIFECYCLE_REQUIRED: "",
      RAGENT_RUNNER_LAUNCH_MODE: "",
      RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
      RAGENT_AUTH_SESSION_SECRET: 'test-auth-session-secret',
      RAGENT_INSTANCE_ROOT: home,
      RAGENT_PROJECT_ROOT: repoRoot,
      RAGENT_PROVIDER_HOMES_DIR: supervisorPipe ? join(home, 'provider-homes') : '',
      RAGENT_RUN_SPOOL_DIR: supervisorPipe ? join(home, 'data', 'chat-runs') : '',
      RAGENT_USER_SHELL_ENV_B64: '',
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'local-appdata'),
      APPDATA: join(home, 'roaming-appdata'),
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_MEMORY_DIR: memoryDir,
      RAGENT_WORK_ROOT_DIR: workDir,
      RAGENT_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      PATH: `${localBin}${delimiter}${process.env.PATH || ''}`,
  };
  let supervisorOutput = '';
  const supervisor = supervisorPipe ? spawn(process.execPath, ['chat/runner-supervisor-daemon.mjs'], {
    cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  }) : null;
  supervisor?.stdout.on('data', data => { supervisorOutput += data.toString(); });
  supervisor?.stderr.on('data', data => { supervisorOutput += data.toString(); });
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  });

  let childError = '';
  child.stderr.on('data', data => { childError = (childError + data).slice(-8000); });
  try {
    if (supervisor) await waitFor(() => supervisorOutput.includes('[runner-supervisor] listening'), 'supervisor startup');
    await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Fixture server exited ${child.exitCode}: ${childError}`);
    try {
      const res = await request(port, 'GET', '/api/auth/me');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup'); } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (supervisor && supervisor.exitCode === null) supervisor.kill('SIGTERM');
    throw new Error(`${error.message}\n${childError}`);
  }

  return { child, supervisor };
}

async function stopServer(server) {
  for (const process of [server?.child, server?.supervisor]) {
    if (!process || process.exitCode !== null || process.signalCode !== null) continue;
    process.kill('SIGTERM');
    await waitFor(() => process.exitCode !== null || process.signalCode !== null, 'fixture shutdown');
  }
}

async function createSession(port) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-claude-dedup',
    name: 'Claude durable dedup',
    riskMode: 'full-auto',
    group: 'Tests',
    description: 'duplicate snapshot dedup at durable write',
  });
  assert.equal(res.status, 201, 'create session should succeed');
  return res.json.session;
}

async function submitMessage(port, sessionId) {
  const res = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId: 'req-claude-durable-dedup',
    text: 'check',
    tool: 'fake-claude-dedup',
    model: 'sonnet',
  });
  assert.ok(res.status === 202 || res.status === 200, `submit message should succeed: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.run;
}

const { home, configDir, memoryDir, workDir, localBin } = setupTempHome();
const port = randomPort();
const server = await startServer({ home, configDir, memoryDir, workDir, localBin, port });

try {
  const session = await createSession(port);
  const run = await submitMessage(port, session.id);
  const terminal = await waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${run.id}`);
    if (res.status !== 200) return false;
    if (!['completed', 'failed', 'cancelled'].includes(res.json.run.state)) return false;
    return res.json.run;
  }, `run ${run.id} terminal`, 20000);

  // Pull the full durable event log (filter=all includes every persisted event).
  const eventsRes = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=all`);
  assert.equal(eventsRes.status, 200, 'events request should succeed');
  const events = eventsRes.json.events || [];
  if (process.env.RAGENT_TEST_EVIDENCE_DIR) writeFileSync(
    join(process.env.RAGENT_TEST_EVIDENCE_DIR, 'claude-http-events.json'), JSON.stringify({ terminal, events }, null, 2));
  assert.equal(terminal.state, 'completed', `fixture provider failed: ${terminal.failureReason || terminal.error || ''}`);

  const duplicates = (events, keyFn) => {
    const counts = new Map();
    for (const e of events) {
      const k = keyFn(e);
      if (!k) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n > 1);
  };

  const dupToolUse = duplicates(
    events.filter((e) => e.type === 'tool_use'),
    (e) => e.providerToolUseId,
  );
  const dupMessage = duplicates(
    events.filter((e) => e.type === 'message' && e.providerMessageId),
    // Identity is id + body: an accumulating snapshot revision may share the
    // provider message id with a shorter earlier row (append-only storage
    // keeps both; the display projection merges them), but an identical
    // re-emission must never persist twice.
    (e) => `${e.role}:${e.providerMessageId}:${e.content}`,
  );
  const dupReasoning = duplicates(
    events.filter((e) => e.type === 'reasoning'),
    (e) => e.providerMessageId,
  );

  assert.deepEqual(dupToolUse, [], `tool_use provider ids should be unique in durable history (got duplicates: ${JSON.stringify(dupToolUse)})`);
  assert.deepEqual(dupMessage, [], `assistant message provider ids should be unique in durable history (got duplicates: ${JSON.stringify(dupMessage)})`);
  assert.deepEqual(dupReasoning, [], `reasoning provider ids should be unique in durable history (got duplicates: ${JSON.stringify(dupReasoning)})`);
  assert.equal(
    events.filter((event) => event.type === 'message' && event.content === 'UUID-only snapshot.').length,
    1,
    'a UUID-only Claude final snapshot should persist once',
  );
  assert.equal(
    events.filter((event) => event.type === 'message' && event.content === 'Fingerprint-only snapshot.').length,
    1,
    'a final snapshot with no upstream message/frame id should persist once via its restricted replay fingerprint',
  );

  // Same-id growing snapshots persist as revision rows (append-only storage);
  // each body must survive so the display projection can keep the longest.
  const growBodies = new Set(
    events
      .filter((event) => event.type === 'message' && event.providerMessageId === 'msg_grow')
      .map((event) => event.content),
  );
  assert.deepEqual(
    [...growBodies].sort(),
    ['Part one.', 'Part one. Part two.'],
    'same-id snapshot revisions persist as separate durable rows',
  );
  // Relay re-emission under a fresh message id: each id persists exactly once.
  assert.equal(
    events.filter((event) => event.type === 'message' && event.providerMessageId === 'msg_twin_a').length,
    1,
    'twin re-emission row A persists once',
  );
  assert.equal(
    events.filter((event) => event.type === 'message' && event.providerMessageId === 'msg_twin_b').length,
    1,
    'twin re-emission row B persists once',
  );

  // Display projection (default events endpoint): revisions and twin
  // re-emissions collapse into one visible row per logical reply.
  const displayRes = await request(port, 'GET', `/api/sessions/${session.id}/events`);
  assert.equal(displayRes.status, 200, 'display events request should succeed');
  assert.equal(displayRes.json.filter, 'visible', 'default events endpoint returns the display projection');
  const displayEvents = displayRes.json.events || [];
  const thoughtIndex = displayEvents.findIndex((event) => event.type === 'thinking_block' && String(event.content).includes('Run two checks.'));
  const answerIndex = displayEvents.findIndex((event) => event.type === 'message' && event.content === 'Done.');
  assert.ok(thoughtIndex >= 0 && answerIndex > thoughtIndex, 'persisted thinking remains before the final reply');
  assert.equal(displayEvents[thoughtIndex].content, 'Run two checks. ' + 'x'.repeat(1500), 'full thinking body is restored from durable storage');
  assert.equal(displayEvents[answerIndex].messagePhase, 'final_answer', 'the final reply retains its explicit phase');
  const displayMessages = (displayRes.json.events || []).filter(
    (event) => event.type === 'message' && event.role === 'assistant',
  );
  assert.equal(
    displayMessages.filter((event) => event.content === 'Part one. Part two.').length,
    1,
    'growing same-id snapshots render as one message with the longest body',
  );
  assert.equal(
    displayMessages.filter((event) => event.content === 'Part one.').length,
    0,
    'the truncated revision body is hidden from the visible timeline',
  );
  assert.equal(
    displayMessages.filter((event) => event.content === 'Twin snapshot.').length,
    2,
    'distinct provider message ids remain distinct even when their bodies match',
  );

  // Sanity: the dedup must not have dropped legitimate distinct events.
  const toolUseIds = new Set(events.filter((e) => e.type === 'tool_use').map((e) => e.providerToolUseId));
  assert.ok(toolUseIds.has('toolu_A') && toolUseIds.has('toolu_B'), 'both parallel tool_use ids should survive dedup');

  console.log('test-claude-durable-dedup: ok');
} finally {
  await stopServer(server);
  rmSync(home, { recursive: true, force: true });
}
