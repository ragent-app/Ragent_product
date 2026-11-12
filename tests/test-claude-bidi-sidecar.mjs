#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';

import { computeBatchManifestHash } from '../chat/privileged-ops.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';
const fixtureSessions = new Set();
const fixtureRuns = new Set();

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
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        if (method === 'POST' && path === '/api/sessions' && json?.session?.id) fixtureSessions.add(json.session.id);
        if (method === 'POST' && /^\/api\/sessions\/[^/]+\/messages$/.test(path) && json?.run?.id) fixtureRuns.add(json.run.id);
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'agentoc-claude-bidi-sidecar-'));
  const configDir = join(home, '.config', 'agentoc');
  const memoryDir = join(home, '.agentoc', 'memory');
  const workDir = join(home, '.agentoc', 'workspace');
  const localBin = join(home, '.local', 'bin');
  const fakeScript = join(localBin, process.platform === 'win32' ? 'fake-claude-bidi.js' : 'fake-claude-bidi');
  const fakeCommand = process.platform === 'win32' ? join(localBin, 'fake-claude-bidi.cmd') : fakeScript;
  const recordPath = join(home, 'fake-claude-bidi-messages.jsonl');
  for (const path of [configDir, memoryDir, workDir, localBin]) mkdirSync(path, { recursive: true });

  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
    token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  }, null, 2));
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
  }, null, 2));
  writeFileSync(join(configDir, 'tools.json'), JSON.stringify([{
    id: 'fake-claude-bidi',
    name: 'Fake Claude Bidi',
    command: fakeCommand,
    runtimeFamily: 'claude-stream-json-bidi',
    models: [{ id: 'fake-model', label: 'Fake Model' }],
    reasoning: { kind: 'enum', levels: ['low', 'high'], default: 'low' },
  }], null, 2));

  writeFileSync(fakeScript, `#!/usr/bin/env node
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const recordPath = ${JSON.stringify(recordPath)};
const messages = [];
let userTurn = 0;
let pendingApproval = null;
function record(message) {
  messages.push(message);
  fs.writeFileSync(recordPath, messages.map((item) => JSON.stringify(item)).join('\\n') + '\\n');
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
function result(text, extra = {}) {
  send({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: 'fake-claude-session',
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra,
  });
}
function managedMcpServerName() {
  return 'ragent_actions_' + crypto.createHash('sha256')
    .update(process.env.AGENTOC_RUN_ID || 'run', 'utf8')
    .digest('hex')
    .slice(0, 16);
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  record(message);
  if (pendingApproval && message.type === 'control_response' && message.response?.request_id === pendingApproval.requestId) {
    const allowed = message.response?.response?.behavior === 'allow';
    pendingApproval = null;
    result(allowed ? 'permission approved' : 'permission denied', allowed ? {} : { is_error: true, subtype: 'error' });
    setTimeout(() => process.exit(allowed ? 0 : 1), 50);
    return;
  }
  if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    send({ type: 'system', subtype: 'init', session_id: 'fake-claude-session', model: 'fake-model', cwd: process.cwd() });
    return;
  }
  if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
    process.exitCode = 1;
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    setTimeout(() => result('interrupted'), 25);
    return;
  }
  if (message.type === 'user') {
    userTurn += 1;
    if (String(message.message?.content || '').includes('__CLAUDE_SCOPED_TRIGGER_TEST__')) {
      require('child_process').execFile(process.execPath, [${JSON.stringify(join(repoRoot, 'cli.js'))},
        'trigger', 'create', '--in', '2h', '--text', 'Scoped trigger fixture', '--json'],
        { env: process.env, timeout: 15000, windowsHide: true }, (error) => {
          result(error ? 'scoped trigger failed' : 'scoped trigger created', error ? { is_error: true, subtype: 'error' } : {});
          setTimeout(() => process.exit(error ? 1 : 0), 50);
        });
      return;
    }
    if (String(message.message?.content || '').includes('__CLAUDE_MANAGED_MCP_TEST__')) {
      pendingApproval = { requestId: 'claude-managed-mcp-1' };
      send({
        type: 'control_request',
        request_id: pendingApproval.requestId,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'mcp__' + managedMcpServerName() + '__ragent_create_agent',
          input: { agent: { name: 'Managed helper' } },
          tool_use_id: 'tool-managed-mcp-1',
        },
      });
      return;
    }
    if (String(message.message?.content || '').includes('__CLAUDE_FOREIGN_MCP_TEST__')) {
      pendingApproval = { requestId: 'claude-foreign-mcp-1' };
      send({
        type: 'control_request',
        request_id: pendingApproval.requestId,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'mcp__foreign_server__ragent_create_agent',
          input: { agent: { name: 'Foreign helper' } },
          tool_use_id: 'tool-foreign-mcp-1',
        },
      });
      return;
    }
    if (String(message.message?.content || '').includes('__CLAUDE_APPROVAL_TEST__')) {
      pendingApproval = { requestId: 'claude-approval-1' };
      send({
        type: 'control_request',
        request_id: pendingApproval.requestId,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          display_name: 'Bash',
          input: { command: 'rm -rf .git', description: 'Delete git metadata' },
          description: 'Delete git metadata',
          permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf .git' }], behavior: 'allow', destination: 'session' }],
          blocked_path: '.git',
          tool_use_id: 'tool-approval-1',
        },
      });
      return;
    }
    if (String(message.message?.content || '').includes('__CLAUDE_PRIVILEGED_APPROVAL_TEST__')) {
      pendingApproval = { requestId: 'claude-privileged-1' };
      send({
        type: 'control_request',
        request_id: pendingApproval.requestId,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          display_name: 'Bash',
          input: {
            command: 'agentoc-privileged --description "Restart service" --category other -- echo real-command',
            description: 'Restart service',
          },
          description: 'Restart service',
          permission_suggestions: [],
          tool_use_id: 'tool-privileged-1',
        },
      });
      return;
    }
    if (String(message.message?.content || '').includes('__CLAUDE_WINDOWS_REVIEW_TEST__')) {
      pendingApproval = { requestId: 'claude-windows-review-1' };
      send({ type: 'control_request', request_id: pendingApproval.requestId, request: { subtype: 'can_use_tool',
        tool_name: 'PowerShell', input: { command: 'Uninstall-Package -Name Fixture' }, tool_use_id: 'tool-windows-review-1' } });
      return;
    }
    if (userTurn === 1) return;
    const text = 'redirected reply';
    send({
      type: 'assistant',
      message: {
        id: 'msg-redirected',
        role: 'assistant',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      session_id: 'fake-claude-session',
    });
    result(text);
    setTimeout(() => process.exit(0), 50);
  }
});
`, 'utf8');
  chmodSync(fakeScript, 0o755);
  if (process.platform === 'win32') {
    writeFileSync(fakeCommand, `@"${process.execPath}" "%~dp0fake-claude-bidi.js" %*\r\n`);
  }
  return { home, configDir, memoryDir, workDir, recordPath };
}

function readRecorded(recordPath) {
  if (!existsSync(recordPath)) return [];
  return readFileSync(recordPath, 'utf8').trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}

function writePasskeyProof(fixture, token, { sessionId, requestId, manifestHash }) {
  const proofDir = join(fixture.configDir, 'owner-webauthn-proofs');
  mkdirSync(proofDir, { recursive: true });
  writeFileSync(join(proofDir, `${createHash('sha256').update(token, 'utf8').digest('hex')}.json`), JSON.stringify({
    purpose: 'privileged-category-approval',
    sessionId,
    requestId,
    manifestHash,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  }));
}

const fixture = setupTempHome();
const port = 52000 + Math.floor(Math.random() * 1000);
let stdout = '';
let stderr = '';
let supervisorOutput = '';
const supervisorPipe = process.platform === 'win32'
  ? `\\\\.\\pipe\\agentoc-test-claude-${randomBytes(12).toString('hex')}` : '';
const childEnv = {
    ...process.env,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    LOCALAPPDATA: join(fixture.home, 'local-appdata'),
    APPDATA: join(fixture.home, 'roaming-appdata'),
    ...(process.platform === 'win32' ? { AGENTOC_INSTANCE_ROOT: fixture.home } : {}),
    AGENTOC_CONFIG_DIR: fixture.configDir,
    AGENTOC_MEMORY_DIR: fixture.memoryDir,
    AGENTOC_WORK_ROOT_DIR: fixture.workDir,
    ...(supervisorPipe ? { AGENTOC_RUN_SPOOL_DIR: join(fixture.home, 'data', 'chat-runs') } : {}),
    AGENTOC_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
    AGENTOC_RUNNER_SUPERVISOR_SOCKET: supervisorPipe,
    ...(supervisorPipe ? { AGENTOC_PROVIDER_HOMES_DIR: join(fixture.home, 'provider-homes') } : {}),
    AGENTOC_AUTH_SESSION_SECRET: 'test-secret-agentoc-sidecar',
    CHAT_PORT: String(port),
    SECURE_COOKIES: '0',
    AGENTOC_REPLY_SELF_CHECK: 'off',
    AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED: '1',
    FAKE_CLAUDE_BIDI_RECORD: fixture.recordPath,
};
const supervisor = supervisorPipe ? spawn(process.execPath, ['chat/runner-supervisor-daemon.mjs'], {
  cwd: repoRoot,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
}) : null;
if (supervisor) {
  supervisor.stdout.on('data', (chunk) => { supervisorOutput += chunk.toString('utf8'); });
  supervisor.stderr.on('data', (chunk) => { supervisorOutput += chunk.toString('utf8'); });
}
const server = spawn(process.execPath, ['chat-server.mjs'], {
  cwd: repoRoot,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
server.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  if (supervisor) await waitFor(() => supervisorOutput.includes('[runner-supervisor] listening'), 'supervisor startup');
  await waitFor(async () => {
    try {
      return (await request(port, 'GET', '/api/auth/me')).status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  const createRes = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-claude-bidi',
    name: 'Fake Claude bidi session',
  });
  assert.equal(createRes.status, 201, createRes.text);
  const sessionId = createRes.json.session.id;

  const startRes = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId: 'req-claude-bidi-long',
    text: 'Keep this turn open.',
    tool: 'fake-claude-bidi',
    model: 'fake-model',
  });
  assert.ok(startRes.status === 200 || startRes.status === 202, startRes.text);
  const runId = startRes.json.run.id;
  assert.equal(startRes.json.run.runtimeFamily, 'claude-stream-json-bidi');
  assert.equal(startRes.json.run.providerCapabilities?.supportsSteer, true);

  await waitFor(() => readRecorded(fixture.recordPath).some((message) => message.type === 'user'), 'initial stdin user turn');

  const queuedRes = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId: 'req-claude-bidi-steer',
    text: 'Redirect now.',
    tool: 'fake-claude-bidi',
    model: 'fake-model',
  });
  assert.ok(queuedRes.status === 200 || queuedRes.status === 202, queuedRes.text);
  assert.equal(queuedRes.json.queued, true);

  const steerRes = await request(port, 'POST', `/api/sessions/${sessionId}/queue`, {
    action: 'steer',
    requestId: 'req-claude-bidi-steer',
  });
  assert.equal(steerRes.status, 202, steerRes.text);
  assert.equal(steerRes.json.steered, true);
  assert.equal(steerRes.json.interruptedRunId, null);

  const terminalRun = await waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    const run = res.json?.run;
    return run && ['completed', 'failed', 'cancelled'].includes(run.state) ? run : false;
  }, 'steered run terminal');
  assert.equal(terminalRun.state, 'completed');
  assert.equal(
    terminalRun.appServerSteerQueue?.find((entry) => entry.requestId === 'req-claude-bidi-steer')?.state,
    'sent',
  );

  const recorded = readRecorded(fixture.recordPath);
  const initializeIndex = recorded.findIndex((message) => message.type === 'control_request' && message.request?.subtype === 'initialize');
  const firstUserIndex = recorded.findIndex((message) => message.type === 'user');
  const interruptIndex = recorded.findIndex((message) => message.type === 'control_request' && message.request?.subtype === 'interrupt');
  const secondUserIndex = recorded.findIndex((message, index) => index > firstUserIndex && message.type === 'user');
  assert.ok(initializeIndex >= 0 && firstUserIndex > initializeIndex, JSON.stringify(recorded));
  assert.ok(interruptIndex > firstUserIndex, JSON.stringify(recorded));
  assert.ok(secondUserIndex > interruptIndex, JSON.stringify(recorded));
  assert.equal(recorded[secondUserIndex].message.content, 'Redirect now.');

  const eventsRes = await request(port, 'GET', `/api/sessions/${sessionId}/events?filter=all`);
  assert.equal(eventsRes.status, 200);
  assert.ok(eventsRes.json.events.some((event) => event.type === 'message' && event.content === 'redirected reply'));
  const completionStatuses = eventsRes.json.events.filter((event) => event.type === 'status' && event.content === 'completed');
  assert.equal(
    completionStatuses.length,
    1,
    `intermediate interrupted result must not finalize the run: ${JSON.stringify(eventsRes.json.events)}`,
  );

  const scopedSessionRes = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot, tool: 'fake-claude-bidi', name: 'Run-scoped trigger fixture',
  });
  assert.equal(scopedSessionRes.status, 201, scopedSessionRes.text);
  const scopedSessionId = scopedSessionRes.json.session.id;
  const scopedStart = await request(port, 'POST', `/api/sessions/${scopedSessionId}/messages`, {
    requestId: 'req-claude-scoped-trigger', text: '__CLAUDE_SCOPED_TRIGGER_TEST__', tool: 'fake-claude-bidi', model: 'fake-model',
  });
  assert.ok([200, 202].includes(scopedStart.status), scopedStart.text);
  const scopedRun = await waitFor(async () => {
    const response = await request(port, 'GET', `/api/runs/${scopedStart.json.run.id}`);
    return ['completed', 'failed', 'cancelled'].includes(response.json?.run?.state) ? response.json.run : false;
  }, 'run-scoped trigger terminal');
  assert.equal(scopedRun.state, 'completed', JSON.stringify(scopedRun));
  const scopedTriggers = await request(port, 'GET', `/api/triggers?sessionId=${encodeURIComponent(scopedSessionId)}`);
  assert.equal(scopedTriggers.status, 200);
  assert.ok(scopedTriggers.json.triggers.some(trigger => trigger.sessionId === scopedSessionId && trigger.text === 'Scoped trigger fixture'));

  writeFileSync(fixture.recordPath, '', 'utf8');
  const cancelSessionRes = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-claude-bidi',
    name: 'Fake Claude bidi cancel session',
  });
  assert.equal(cancelSessionRes.status, 201, cancelSessionRes.text);
  const cancelSessionId = cancelSessionRes.json.session.id;
  const cancelStartRes = await request(port, 'POST', `/api/sessions/${cancelSessionId}/messages`, {
    requestId: 'req-claude-bidi-cancel',
    text: 'Keep this cancel turn open.',
    tool: 'fake-claude-bidi',
    model: 'fake-model',
  });
  assert.ok(cancelStartRes.status === 200 || cancelStartRes.status === 202, cancelStartRes.text);
  const cancelRunId = cancelStartRes.json.run.id;
  await waitFor(() => readRecorded(fixture.recordPath).some((message) => message.type === 'user'), 'cancel stdin user turn');
  const cancelRes = await request(port, 'POST', `/api/sessions/${cancelSessionId}/cancel`);
  assert.ok(cancelRes.status === 200 || cancelRes.status === 202, cancelRes.text);
  const cancelledRun = await waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${cancelRunId}`);
    return res.json?.run?.state === 'cancelled' ? res.json.run : false;
  }, 'cancelled bidi run terminal');
  assert.equal(cancelledRun.state, 'cancelled');
  assert.equal(cancelledRun.result?.exitCode, 0, 'confirmed provider cancellation should normalize the sidecar exit code');
  assert.ok(
    readRecorded(fixture.recordPath).some((message) => (
      message.type === 'control_request' && message.request?.subtype === 'interrupt'
    )),
    'cancel should use the native Claude interrupt control request',
  );

  writeFileSync(fixture.recordPath, '', 'utf8');
  const approvalSessionRes = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-claude-bidi',
    name: 'Fake Claude bidi approval session',
  });
  assert.equal(approvalSessionRes.status, 201, approvalSessionRes.text);
  const approvalSessionId = approvalSessionRes.json.session.id;
  const approvalRiskPatchRes = await request(port, 'PATCH', `/api/sessions/${approvalSessionId}`, {
    riskMode: 'full-auto',
  });
  assert.equal(approvalRiskPatchRes.status, 200, approvalRiskPatchRes.text);
  const approvalStartRes = await request(port, 'POST', `/api/sessions/${approvalSessionId}/messages`, {
    requestId: 'req-claude-bidi-approval',
    text: '__CLAUDE_APPROVAL_TEST__',
    tool: 'fake-claude-bidi',
    model: 'fake-model',
    permissionMode: 'bypassPermissions',
  });
  assert.ok(approvalStartRes.status === 200 || approvalStartRes.status === 202, approvalStartRes.text);
  const approvalRunId = approvalStartRes.json.run.id;
  // Full-auto permits caution-tier work but must deny danger-tier requests.
  // The fake provider only emits the request; it never executes the command.
  const deniedUnattendedRun = await waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${approvalRunId}`);
    return res.json?.run?.state === 'failed' ? res.json.run : false;
  }, 'unattended Claude bidi denial terminal');
  assert.equal(deniedUnattendedRun.state, 'failed');
  assert.ok(readRecorded(fixture.recordPath).some((message) => (
    message.type === 'control_response'
    && message.response?.request_id === 'claude-approval-1'
    && message.response?.response?.behavior === 'deny'
  )), 'unexpected unattended permission requests must be denied');
  const unattendedEvents = await request(port, 'GET', `/api/sessions/${approvalSessionId}/events?filter=all`);
  assert.equal(unattendedEvents.status, 200);
  assert.equal(unattendedEvents.json.events.some(event => (
    event.type === 'approval_request' && event.runId === approvalRunId
  )), false, 'unattended mode must not leave an approval waiting');

  writeFileSync(fixture.recordPath, '', 'utf8');
  const managedMcpSessionRes = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-claude-bidi',
    name: 'Fake Claude bidi managed MCP session',
  });
  assert.equal(managedMcpSessionRes.status, 201, managedMcpSessionRes.text);
  const managedMcpSessionId = managedMcpSessionRes.json.session.id;
  const managedMcpRiskPatchRes = await request(port, 'PATCH', `/api/sessions/${managedMcpSessionId}`, {
    riskMode: 'recommended',
  });
  assert.equal(managedMcpRiskPatchRes.status, 200, managedMcpRiskPatchRes.text);
  const managedMcpStartRes = await request(port, 'POST', `/api/sessions/${managedMcpSessionId}/messages`, {
    requestId: 'req-claude-bidi-managed-mcp',
    text: '__CLAUDE_MANAGED_MCP_TEST__',
    tool: 'fake-claude-bidi',
    model: 'fake-model',
    permissionMode: 'default',
  });
  assert.ok(managedMcpStartRes.status === 200 || managedMcpStartRes.status === 202, managedMcpStartRes.text);
  const managedMcpRunId = managedMcpStartRes.json.run.id;
  const managedMcpTerminalRun = await waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${managedMcpRunId}`);
    return res.json?.run?.state === 'completed' ? res.json.run : false;
  }, 'managed Claude MCP run terminal');
  assert.equal(managedMcpTerminalRun.state, 'completed');
  const managedMcpRecorded = readRecorded(fixture.recordPath);
  const managedMcpResponse = managedMcpRecorded.find((message) => (
    message.type === 'control_response'
    && message.response?.request_id === 'claude-managed-mcp-1'
  ));
  assert.ok(managedMcpResponse, `managed MCP response missing: ${JSON.stringify(managedMcpRecorded)}`);
  assert.deepEqual(managedMcpResponse.response.response, {
    behavior: 'allow',
    updatedInput: {},
    updatedPermissions: [],
  });
  const managedMcpEventsRes = await request(port, 'GET', `/api/sessions/${managedMcpSessionId}/events?filter=all`);
  assert.equal(managedMcpEventsRes.status, 200);
  assert.equal(
    managedMcpEventsRes.json.events.some((event) => event.type === 'approval_request'),
    false,
    'run-scoped managed MCP should not create a user approval card',
  );

  writeFileSync(fixture.recordPath, '', 'utf8');
  const foreignMcpSessionRes = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-claude-bidi',
    name: 'Fake Claude bidi foreign MCP session',
  });
  assert.equal(foreignMcpSessionRes.status, 201, foreignMcpSessionRes.text);
  const foreignMcpSessionId = foreignMcpSessionRes.json.session.id;
  const foreignMcpRiskPatchRes = await request(port, 'PATCH', `/api/sessions/${foreignMcpSessionId}`, {
    riskMode: 'recommended',
  });
  assert.equal(foreignMcpRiskPatchRes.status, 200, foreignMcpRiskPatchRes.text);
  const foreignMcpStartRes = await request(port, 'POST', `/api/sessions/${foreignMcpSessionId}/messages`, {
    requestId: 'req-claude-bidi-foreign-mcp',
    text: '__CLAUDE_FOREIGN_MCP_TEST__',
    tool: 'fake-claude-bidi',
    model: 'fake-model',
    permissionMode: 'default',
  });
  assert.ok(foreignMcpStartRes.status === 200 || foreignMcpStartRes.status === 202, foreignMcpStartRes.text);
  const foreignMcpRunId = foreignMcpStartRes.json.run.id;
  const foreignMcpApproval = await waitFor(async () => {
    const res = await request(port, 'GET', `/api/sessions/${foreignMcpSessionId}/events?filter=all`);
    return res.json?.events?.find((event) => event.type === 'approval_request' && event.runId === foreignMcpRunId) || false;
  }, 'foreign Claude MCP approval request');
  assert.equal(foreignMcpApproval.provider, 'claude');
  const foreignMcpApprovalRes = await request(
    port,
    'POST',
    `/api/runs/${foreignMcpRunId}/approvals/${encodeURIComponent(foreignMcpApproval.approvalId)}`,
    { requestId: 'req-claude-bidi-foreign-mcp-approve', decision: 'approve' },
  );
  assert.ok(foreignMcpApprovalRes.status === 200 || foreignMcpApprovalRes.status === 202, foreignMcpApprovalRes.text);
  const foreignMcpTerminalRun = await waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${foreignMcpRunId}`);
    return res.json?.run?.state === 'completed' ? res.json.run : false;
  }, 'foreign Claude MCP run terminal');
  assert.equal(foreignMcpTerminalRun.state, 'completed');
  assert.ok(readRecorded(fixture.recordPath).some((message) => (
    message.type === 'control_response'
    && message.response?.request_id === 'claude-foreign-mcp-1'
    && message.response?.response?.behavior === 'allow'
  )));

  if (process.platform !== 'win32') {
  writeFileSync(fixture.recordPath, '', 'utf8');
  const privilegedSessionRes = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-claude-bidi',
    name: 'Fake Claude bidi privileged approval session',
  });
  assert.equal(privilegedSessionRes.status, 201, privilegedSessionRes.text);
  const privilegedSessionId = privilegedSessionRes.json.session.id;
  const privilegedPatchRes = await request(port, 'PATCH', `/api/sessions/${privilegedSessionId}`, {
    privilegedMode: true,
  });
  assert.equal(privilegedPatchRes.status, 200, privilegedPatchRes.text);
  assert.equal(privilegedPatchRes.json.session.privilegedMode, true);

  const privilegedStartRes = await request(port, 'POST', `/api/sessions/${privilegedSessionId}/messages`, {
    requestId: 'req-claude-bidi-privileged',
    text: '__CLAUDE_PRIVILEGED_APPROVAL_TEST__',
    tool: 'fake-claude-bidi',
    model: 'fake-model',
    permissionMode: 'bypassPermissions',
  });
  assert.ok(privilegedStartRes.status === 200 || privilegedStartRes.status === 202, privilegedStartRes.text);
  const privilegedRunId = privilegedStartRes.json.run.id;
  const privilegedBatch = await waitFor(async () => {
    const res = await request(port, 'GET', `/api/sessions/${privilegedSessionId}/events?filter=all`);
    const batch = res.json?.events?.find((event) => event.type === 'privileged_batch_request' && event.runId === privilegedRunId);
    if (batch) return batch;
    const state = await request(port, 'GET', `/api/runs/${privilegedRunId}`);
    if (state.json?.run?.state === 'failed') throw new Error(`Privileged fixture run failed: ${JSON.stringify(state.json.run)}`);
    return false;
  }, 'Claude bidi privileged batch request');
  assert.equal(privilegedBatch.other.length, 1);
  assert.equal(privilegedBatch.other[0].command, 'echo real-command');
  assert.equal(
    privilegedBatch.other[0].wrapperCommand,
    'agentoc-privileged --description "Restart service" --category other -- echo real-command',
  );
  const privilegedOpId = privilegedBatch.other[0].opId;
  const privilegedResolveRequestId = 'req-claude-bidi-privileged-resolve';
  const privilegedProofToken = 'fixture-claude-bidi-privileged-proof';
  const privilegedManifestHash = computeBatchManifestHash(
    privilegedBatch.other,
    'privileged_other',
  );
  writePasskeyProof(fixture, privilegedProofToken, {
    sessionId: privilegedSessionId,
    requestId: privilegedResolveRequestId,
    manifestHash: privilegedManifestHash,
  });
  const privilegedResolveRes = await request(
    port,
    'POST',
    `/api/runs/${privilegedRunId}/privileged-batches/${encodeURIComponent(privilegedBatch.batchId)}/categories/${encodeURIComponent('privileged_other')}`,
    {
      requestId: privilegedResolveRequestId,
      checkedOpIds: [privilegedOpId],
      webauthnProof: {
        token: privilegedProofToken,
        credentialId: 'fixture-credential',
        signedManifestHash: privilegedManifestHash,
      },
    },
  );
  assert.ok(privilegedResolveRes.status === 200 || privilegedResolveRes.status === 202, privilegedResolveRes.text);
  assert.equal(privilegedResolveRes.json.approved[0].opId, privilegedOpId);
  assert.equal(privilegedResolveRes.json.queuedApprovals[0].updatedInput.command, 'echo real-command');
  const privilegedTerminalRun = await waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${privilegedRunId}`);
    return res.json?.run?.state === 'completed' ? res.json.run : false;
  }, 'privileged Claude bidi run terminal');
  assert.equal(privilegedTerminalRun.state, 'completed');
  const privilegedRecorded = readRecorded(fixture.recordPath);
  const privilegedReply = privilegedRecorded.find((message) => (
    message.type === 'control_response'
    && message.response?.request_id === 'claude-privileged-1'
  ));
  assert.ok(privilegedReply, `provider should receive privileged approval response; got ${JSON.stringify(privilegedRecorded)}`);
  assert.equal(privilegedReply.response.response.behavior, 'allow');
  assert.equal(privilegedReply.response.response.updatedInput.command, 'echo real-command');
  assert.notEqual(
    privilegedReply.response.response.updatedInput.command,
    'agentoc-privileged --description "Restart service" --category other -- echo real-command',
  );

  writeFileSync(fixture.recordPath, '', 'utf8');
  const deniedSessionRes = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-claude-bidi',
    name: 'Fake Claude bidi privileged denial session',
  });
  assert.equal(deniedSessionRes.status, 201, deniedSessionRes.text);
  const deniedSessionId = deniedSessionRes.json.session.id;
  const deniedPatchRes = await request(port, 'PATCH', `/api/sessions/${deniedSessionId}`, {
    privilegedMode: true,
  });
  assert.equal(deniedPatchRes.status, 200, deniedPatchRes.text);

  const deniedStartRes = await request(port, 'POST', `/api/sessions/${deniedSessionId}/messages`, {
    requestId: 'req-claude-bidi-privileged-deny',
    text: '__CLAUDE_PRIVILEGED_APPROVAL_TEST__',
    tool: 'fake-claude-bidi',
    model: 'fake-model',
    permissionMode: 'bypassPermissions',
  });
  assert.ok(deniedStartRes.status === 200 || deniedStartRes.status === 202, deniedStartRes.text);
  const deniedRunId = deniedStartRes.json.run.id;
  const deniedBatch = await waitFor(async () => {
    const res = await request(port, 'GET', `/api/sessions/${deniedSessionId}/events?filter=all`);
    return res.json?.events?.find((event) => event.type === 'privileged_batch_request' && event.runId === deniedRunId) || false;
  }, 'Claude bidi privileged denial batch request');
  const deniedResolveRes = await request(
    port,
    'POST',
    `/api/runs/${deniedRunId}/privileged-batches/${encodeURIComponent(deniedBatch.batchId)}/categories/${encodeURIComponent('privileged_other')}`,
    {
      requestId: 'req-claude-bidi-privileged-deny-resolve',
      checkedOpIds: [],
    },
  );
  assert.ok(deniedResolveRes.status === 200 || deniedResolveRes.status === 202, deniedResolveRes.text);
  assert.equal(deniedResolveRes.json.denied[0].opId, deniedBatch.other[0].opId);
  const deniedTerminalRun = await waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${deniedRunId}`);
    return res.json?.run?.state === 'failed' ? res.json.run : false;
  }, 'denied privileged Claude bidi run terminal');
  assert.equal(deniedTerminalRun.state, 'failed');
  const deniedRecorded = readRecorded(fixture.recordPath);
  const deniedReply = deniedRecorded.find((message) => (
    message.type === 'control_response'
    && message.response?.request_id === 'claude-privileged-1'
  ));
  assert.ok(deniedReply, `provider should receive privileged denial response; got ${JSON.stringify(deniedRecorded)}`);
  assert.equal(deniedReply.response.response.behavior, 'deny');
  assert.equal(deniedReply.response.response.updatedInput, undefined);
  } else {
    writeFileSync(fixture.recordPath, '', 'utf8');
    const created = await request(port, 'POST', '/api/sessions', { folder: repoRoot, tool: 'fake-claude-bidi', name: 'Windows review fixture' });
    assert.equal(created.status, 201, created.text);
    const reviewSession = created.json.session.id;
    assert.equal((await request(port, 'PATCH', `/api/sessions/${reviewSession}`, { riskMode: 'recommended' })).status, 200);
    const started = await request(port, 'POST', `/api/sessions/${reviewSession}/messages`, { requestId: 'req-windows-review',
      text: '__CLAUDE_WINDOWS_REVIEW_TEST__', tool: 'fake-claude-bidi', model: 'fake-model' });
    assert.ok(started.status === 200 || started.status === 202, started.text);
    const runId = started.json.run.id;
    const approval = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${reviewSession}/events?filter=all`);
      return res.json?.events?.find((event) => event.type === 'approval_request' && event.runId === runId) || false;
    }, 'Windows Claude dangerous action approval');
    const denied = await request(port, 'POST', `/api/runs/${runId}/approvals/${encodeURIComponent(approval.approvalId)}`,
      { requestId: 'req-windows-review-deny', decision: 'deny' });
    assert.ok(denied.status === 200 || denied.status === 202, denied.text);
    await waitFor(() => readRecorded(fixture.recordPath).some((message) => message.type === 'control_response' &&
      message.response?.request_id === 'claude-windows-review-1' && message.response?.response?.behavior === 'deny'), 'Windows denial delivered to Claude');
  }

  console.log('test-claude-bidi-sidecar: ok');
} catch (error) {
  const replies = readRecorded(fixture.recordPath).filter((message) => message.type === 'control_response');
  throw new Error(`${error.message}\nfixture replies:\n${JSON.stringify(replies)}\nstdout:\n${stdout || '(empty)'}\nstderr:\n${stderr || '(empty)'}\nsupervisor:\n${supervisorOutput || '(empty)'}`);
} finally {
  let runsStopped = fixtureRuns.size === 0;
  if (server.exitCode === null && server.signalCode === null) {
    await Promise.allSettled([...fixtureSessions].map((id) => request(port, 'POST', `/api/sessions/${id}/cancel`)));
    try {
      await waitFor(async () => {
        const results = await Promise.all([...fixtureRuns].map((id) => request(port, 'GET', `/api/runs/${id}`)));
        return results.every((result) => ['completed', 'failed', 'cancelled'].includes(result.json?.run?.state));
      }, 'fixture runs to stop', 15000);
      runsStopped = true;
    } catch { runsStopped = false; }
  }
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await waitFor(() => server.exitCode !== null || server.signalCode !== null, 'server shutdown').catch(() => {});
  }
  if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
    supervisor.kill();
    await waitFor(() => supervisor.exitCode !== null || supervisor.signalCode !== null, 'supervisor shutdown').catch(() => {});
  }
  if (runsStopped) rmSync(fixture.home, { recursive: true, force: true });
  else console.error(`Fixture runs did not stop; retained isolated fixture ${fixture.home}`);
}
