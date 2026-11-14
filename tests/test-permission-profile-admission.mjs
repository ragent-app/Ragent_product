#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChildEnvironment } from '../scripts/launch-test-instance.mjs';

const root = mkdtempSync(join(tmpdir(), 'agentoc-permission-admission-'));
const configDir = join(root, 'config');
const workspace = join(root, 'workspace');
const spoolDir = join(root, 'spool');
const providerHomesDir = join(root, 'provider-homes');
const memoryDir = join(root, 'memory');
const harnessRoot = join(root, 'harnesses');
const instance = {
  instanceDir: root,
  configDir,
  spoolDir,
  providerHomesDir,
  memoryDir,
  workRootDir: workspace,
  port: 48731,
  id: `permission-admission-${process.pid}`,
  ttlSeconds: 120,
};
Object.assign(process.env, buildChildEnvironment(instance));
const kimiBinDir = join(harnessRoot, 'kimi-code', 'node_modules', '.bin');
const kimiCommand = join(kimiBinDir, 'kimi.cmd');
const kimiHarnessScript = join(root, 'fake-kimi-acp.mjs');
const kimiHandshakeReceipt = join(workspace, '.agentoc-kimi-acp-handshake.json');
const runnerSupervisorPipe = `\\\\.\\pipe\\agentoc-permission-profile-${process.pid}-${Date.now()}`;
process.env.AGENTOC_HARNESS_ROOT = harnessRoot;
process.env.AGENTOC_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET = runnerSupervisorPipe;
process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED = '1';
process.env.AGENTOC_MEMORY_WRITEBACK = 'off';
mkdirSync(configDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(kimiBinDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(spoolDir, { recursive: true });
mkdirSync(providerHomesDir, { recursive: true });
writeFileSync(kimiHarnessScript, `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv.includes('--version')) {
  console.log('0.38.0');
  process.exit(0);
}

const requests = [];
let selectedMode = '';
let sessionCwd = process.cwd();
function save() { writeFileSync(join(sessionCwd, '.agentoc-kimi-acp-handshake.json'), JSON.stringify({ requests, selectedMode })); }
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { process.exitCode = 2; break; }
  if (!request || typeof request.method !== 'string') continue;
  requests.push({ method: request.method, params: request.params || {} });
  if (request.method === 'initialize') {
    respond(request.id, { protocolVersion: 1, agentCapabilities: {} });
  } else if (request.method === 'session/new') {
    sessionCwd = request.params?.cwd || process.cwd();
    respond(request.id, { sessionId: 'test-kimi-session', modes: {
      currentModeId: 'default',
      availableModes: [{ id: 'default', name: 'Always Ask' }, { id: 'auto', name: 'Never Ask' }, { id: 'yolo', name: 'Ask When Needed' }],
    } });
  } else if (request.method === 'session/set_mode') {
    selectedMode = request.params?.modeId || '';
    respond(request.id, {});
  } else if (request.method === 'session/prompt') {
    save();
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } }) + '\\n', () => process.exit(0));
    break;
  } else {
    respond(request.id, {});
  }
  save();
}
`);
writeFileSync(kimiCommand, `@echo off\r\n"${process.execPath}" "${kimiHarnessScript}" %*\r\n`);
writeFileSync(join(configDir, 'tools.json'), JSON.stringify([
  { id: 'permission-codex-cli', name: 'Codex CLI', command: process.execPath, runtimeFamily: 'codex-json' },
  { id: 'permission-cline', name: 'Cline', command: process.execPath, runtimeFamily: 'cline-json' },
  { id: 'permission-kilo', name: 'Kilo', command: process.execPath, runtimeFamily: 'kilo-json' },
  { id: 'permission-opencode', name: 'OpenCode', command: process.execPath, runtimeFamily: 'opencode-json' },
  { id: 'permission-kimi', name: 'Kimi Code', command: 'kimi-code', runtimeFamily: 'kimi-code-acp' },
  { id: 'permission-hermes', name: 'Hermes', command: process.execPath, runtimeFamily: 'hermes-acp' },
], null, 2));

const { createSession, killAll, cancelActiveRun, submitHttpMessage } = await import('../chat/session-manager.mjs');
const { getRun, isTerminalRunState } = await import('../chat/runs.mjs');

async function waitForRunTerminal(runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let current = null;
  while (Date.now() < deadline) {
    current = await getRun(runId);
    if (current && isTerminalRunState(current.state)) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not reach a terminal state: ${current?.state || 'missing'}`);
}

let supervisor = null;
let supervisorOutput = '';
const launchedSessions = [];
try {
  if (process.platform === 'win32') {
    const supervisorEnv = buildChildEnvironment(instance);
    supervisorEnv.AGENTOC_HARNESS_ROOT = harnessRoot;
    supervisorEnv.AGENTOC_RUNNER_SUPERVISOR_SOCKET = runnerSupervisorPipe;
    supervisorEnv.AGENTOC_RUNNER_SUPERVISOR_REQUIRED = '1';
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    supervisor = spawn(process.execPath, [join(repoRoot, 'chat', 'runner-supervisor-daemon.mjs')], {
      cwd: repoRoot,
      env: supervisorEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => finish(new Error(`Isolated Supervisor did not start: ${supervisorOutput}`)), 10_000);
      const finish = (error) => {
        if (ready || error) {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        }
      };
      supervisor.stdout.setEncoding('utf8');
      supervisor.stderr.setEncoding('utf8');
      supervisor.stdout.on('data', (chunk) => {
        supervisorOutput = (supervisorOutput + chunk).slice(-8000);
        if (supervisorOutput.includes(`[runner-supervisor] listening on ${runnerSupervisorPipe}`)) {
          ready = true;
          finish();
        }
      });
      supervisor.stderr.on('data', (chunk) => {
        supervisorOutput = (supervisorOutput + chunk).slice(-8000);
      });
      supervisor.once('error', (error) => finish(error));
      supervisor.once('exit', (code, signal) => {
        if (!ready) finish(new Error(`Isolated Supervisor exited (${code ?? signal}): ${supervisorOutput}`));
      });
    });
  } else {
    process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET = '';
    process.env.AGENTOC_RUNNER_SUPERVISOR_REQUIRED = '';
  }
  for (const tool of ['permission-codex-cli', 'permission-cline', 'permission-kilo', 'permission-opencode']) {
    const session = await createSession(workspace, tool, `Manual ${tool}`, { riskMode: 'recommended' });
    await assert.rejects(
      () => submitHttpMessage(session.id, 'Check approval admission.', [], {
        requestId: `manual-${tool}`,
        skipDispatch: true, skipRunnerLaunch: true,
      }),
      (error) => error?.code === 'PRIVILEGED_GATE_UNSUPPORTED_RUNTIME'
        && error?.statusCode === 409,
      `${tool} must reject manual approval before creating a Run`,
    );
  }
  const unsupportedGuarded = await createSession(workspace, 'permission-opencode', 'Guarded OpenCode', {
    riskMode: 'conservative-auto',
  });
  await assert.rejects(
    () => submitHttpMessage(unsupportedGuarded.id, 'Check guarded admission.', [], {
      requestId: 'guarded-opencode',
      skipDispatch: true, skipRunnerLaunch: true,
    }),
    (error) => error?.code === 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME'
      && error?.statusCode === 409,
    'unsupported guarded runtime must fail closed before creating a Run',
  );
  for (const tool of ['permission-hermes']) {
    const autonomous = await createSession(workspace, tool, `Autonomous ${tool}`, {
      riskMode: 'full-auto',
    });
    await assert.rejects(
      () => submitHttpMessage(autonomous.id, 'Check autonomous admission.', [], {
        requestId: `autonomous-${tool}`,
        skipDispatch: true, skipRunnerLaunch: true,
      }),
      (error) => error?.code === 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME'
        && error?.statusCode === 409,
      `${tool} must reject unsupported autonomous mode before creating a Run`,
    );
  }
  if (process.platform === 'win32') {
    for (const riskMode of ['full-auto', 'conservative-auto']) {
      const kimi = await createSession(workspace, 'permission-kimi', `Kimi ${riskMode}`, {
        riskMode,
        riskModeExplicit: true,
      });
      launchedSessions.push(kimi.id);
      const submitted = await submitHttpMessage(kimi.id, 'Verify ACP permission mode and startup ordering.', [], {
        requestId: `kimi-${riskMode}`,
        skipDispatch: true, skipRunnerLaunch: true,
      });
      assert.ok(submitted.run?.id, 'Kimi should create a concrete Run through the isolated Supervisor');
      const terminal = await waitForRunTerminal(submitted.run.id);
      assert.equal(terminal.state, 'completed', terminal.result?.error || terminal.result?.failureReason || 'Kimi fake ACP Run failed');
      assert.equal(terminal.runnerLaunchMode, 'runner-supervisor', 'Kimi Run must use the isolated Windows Supervisor');
      assert.equal(terminal.windowsJobObjectManaged, true, 'Kimi Runner must be managed by a Windows Job Object');
      const handshake = JSON.parse(readFileSync(kimiHandshakeReceipt, 'utf8'));
      assert.deepEqual(handshake.requests.map((request) => request.method), [
        'initialize', 'session/new', 'session/set_mode', 'session/prompt',
      ]);
      assert.equal(handshake.selectedMode, riskMode === 'full-auto' ? 'auto' : 'yolo');
    }
  }
} finally {
  for (const sessionId of launchedSessions) {
    await cancelActiveRun(sessionId).catch(() => {});
  }
  await killAll();
  if (supervisor && supervisor.exitCode === null) {
    supervisor.kill();
    await Promise.race([
      new Promise((resolve) => supervisor.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
  }
  rmSync(root, { recursive: true, force: true });
}

console.log('Permission profile admission tests passed');
