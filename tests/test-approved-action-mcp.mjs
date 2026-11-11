#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
  prepareApprovedActionMcpOverlay,
  prepareManagedMcpOverlay,
  prepareCodexThreadMcp,
} from '../chat/approved-action-mcp-overlay.mjs';
import { buildClaudeBidiArgs } from '../chat/adapters/claude-bidi.mjs';

const repoRoot = join(import.meta.dirname, '..');
const scriptPath = join(repoRoot, 'scripts', 'agentoc-approved-actions-mcp.mjs');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readResponses(child) {
  const lineReader = createInterface({ input: child.stdout });
  const pending = new Map();
  lineReader.on('line', (line) => {
    try {
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id);
      waiter(response);
    } catch {
      // The MCP contract is JSONL; malformed provider output is ignored here.
    }
  });
  return (id, method, params = {}) => new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
      if (error) {
        pending.delete(id);
        reject(error);
      }
    });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`timed out waiting for MCP response ${id}`));
    }, 3000).unref();
  });
}

const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(body);
    received.push({ headers: req.headers, body: payload });
    if (payload.requestKey === 'mcp-fixture-denied') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unattended policy denied the action', code: 'APPROVED_ACTION_AUTO_DENIED' }));
      return;
    }
    if (payload.requestKey === 'mcp-fixture-install') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'automatic_install', status: 'executing', requestId: 'auto-1', duplicate: false }));
      return;
    }
    if (payload.requestKey === 'mcp-fixture-service') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'windows_service_control', status: 'denied', code: 'DEVICE_DENIED', requestId: 'svc-1' }));
      return;
    }
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'awaiting_approval',
      batchId: 'aab_fixture',
      actions: [{ actionId: 'aa_fixture', category: 'privileged_other', executionClass: 'host', needsPasskey: true }],
    }));
  });
});
const port = await listen(server);
const child = spawn(process.execPath, [scriptPath], {
  env: {
    ...process.env,
    AGENTOC_APPROVED_ACTIONS_ENABLED: '1',
    AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED: '1',
    AGENTOC_APPROVED_ACTIONS_ENDPOINT: `http://127.0.0.1:${port}/api/internal/approved-actions/propose`,
    AGENTOC_APPROVED_ACTIONS_TOKEN: 'run-secret-token',
    AGENTOC_APPROVED_ACTIONS_SESSION_ID: 's_fixture',
    AGENTOC_APPROVED_ACTIONS_RUN_ID: 'r_fixture',
    AGENTOC_APPROVED_ACTIONS_TURN_ID: 't_fixture',
    AGENTOC_APPROVED_ACTIONS_CWD: '/tmp',
    AGENTOC_APPROVED_ACTIONS_PROJECT_ROOT: '/tmp',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const request = readResponses(child);
const initialize = await request(1, 'initialize');
assert.equal(initialize.result.serverInfo.name, 'agentoc-approved-actions');
const tools = await request(2, 'tools/list');
assert.equal(tools.result.tools.length, 2);
assert.equal(tools.result.tools[0].name, 'agentoc_request_actions');
assert.match(tools.result.tools[0].description, /executing status is not completion/);
assert.match(tools.result.tools[0].description, /statusOnly=true and the same requestKey and identical action/);
assert.equal(tools.result.tools[1].name, 'agentoc_create_agent');
assert.doesNotMatch(JSON.stringify(tools), /run-secret-token/);
const call = await request(3, 'tools/call', {
  name: 'agentoc_request_actions',
  arguments: {
    requestKey: 'mcp-fixture-1',
    actions: [{ command: 'systemctl is-active nginx', cwd: '/tmp', description: 'Check nginx' }],
  },
});
assert.equal(call.result.isError, false);
assert.match(call.result.content[0].text, /awaiting_approval/);
assert.equal(received.length, 1);
assert.equal(received[0].headers['x-agentoc-approved-action-token'], 'run-secret-token');
assert.equal(received[0].body.runId, 'r_fixture');
assert.equal(received[0].body.actions[0].command, 'systemctl is-active nginx');
const productCall = await request(4, 'tools/call', {
  name: 'agentoc_create_agent',
  arguments: {
    requestKey: 'mcp-agent-create-1',
    reason: 'Owner requested a reusable report workflow',
    agent: {
      name: 'Report Agent',
      systemPrompt: 'Prepare reports.',
      welcomeMessage: 'Send the source export.',
      tool: 'codex',
      skills: ['spreadsheets'],
    },
  },
});
assert.equal(productCall.result.isError, false);
assert.match(productCall.result.content[0].text, /awaiting_approval/);
assert.equal(received.length, 2);
assert.equal(received[1].body.actions[0].operation, 'agent.create');
assert.equal(received[1].body.actions[0].agent.name, 'Report Agent');
assert.equal(received[1].body.sessionId, 's_fixture');
assert.doesNotMatch(JSON.stringify(received[1].body), /run-secret-token/);
const deniedCall = await request(6, 'tools/call', {
  name: 'agentoc_request_actions',
  arguments: {
    requestKey: 'mcp-fixture-denied',
    actions: [{ command: 'systemctl restart nginx', cwd: '/tmp', description: 'Restart nginx' }],
  },
});
assert.equal(deniedCall.result.isError, true);
assert.match(deniedCall.result.content[0].text, /Unattended policy denied the action/);
assert.match(deniedCall.result.content[0].text, /requestKey: mcp-fixture-denied/);
const automatic = await request(7, 'tools/call', { name: 'agentoc_request_actions', arguments: {
  requestKey: 'mcp-fixture-install', actions: [{ command: 'winget install Git.Git' }],
} });
assert.deepEqual(JSON.parse(automatic.result.content[0].text), { kind: 'automatic_install', status: 'executing', code: '', requestId: 'auto-1', requestKey: 'mcp-fixture-install', duplicate: false });
const automaticStatus = await request(8, 'tools/call', { name: 'agentoc_request_actions', arguments: {
  requestKey: 'mcp-fixture-install', statusOnly: true, actions: [{ command: 'winget install Git.Git' }],
} });
assert.equal(automaticStatus.result.isError, false);
assert.equal(received.at(-1).body.autoInstallStatusOnly, true);
const missingKeyStatus = await request(9, 'tools/call', { name: 'agentoc_request_actions', arguments: {
  statusOnly: true, actions: [{ command: 'winget install Git.Git' }],
} });
assert.equal(missingKeyStatus.result.isError, true);
const service = await request(10, 'tools/call', { name: 'agentoc_request_actions', arguments: {
  requestKey: 'mcp-fixture-service', actions: [{ command: 'Restart-Service Example' }],
} });
assert.deepEqual(JSON.parse(service.result.content[0].text), { kind: 'windows_service_control', status: 'denied', code: 'DEVICE_DENIED',
  requestId: 'svc-1', requestKey: 'mcp-fixture-service', duplicate: false });
child.stdin.end();
await new Promise((resolve, reject) => {
  child.once('exit', resolve);
  child.once('error', reject);
});

const disabledChild = spawn(process.execPath, [scriptPath], {
  env: {
    ...process.env,
    AGENTOC_APPROVED_ACTIONS_ENABLED: '1',
    AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED: '0',
    AGENTOC_APPROVED_ACTIONS_ENDPOINT: `http://127.0.0.1:${port}/api/internal/approved-actions/propose`,
    AGENTOC_APPROVED_ACTIONS_TOKEN: 'run-secret-token',
    AGENTOC_APPROVED_ACTIONS_SESSION_ID: 's_fixture',
    AGENTOC_APPROVED_ACTIONS_RUN_ID: 'r_fixture',
    AGENTOC_APPROVED_ACTIONS_TURN_ID: 't_fixture',
    AGENTOC_APPROVED_ACTIONS_CWD: '/tmp',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const disabledRequest = readResponses(disabledChild);
const disabledTools = await disabledRequest(5, 'tools/list');
assert.deepEqual(disabledTools.result.tools.map((tool) => tool.name), ['agentoc_request_actions']);
disabledChild.stdin.end();
await new Promise((resolve, reject) => {
  disabledChild.once('exit', resolve);
  disabledChild.once('error', reject);
});
await close(server);

const root = await mkdtemp(join(tmpdir(), 'approved-action-overlay-test-'));
const codexSource = join(root, 'codex-source');
const { mkdir, writeFile } = await import('node:fs/promises');
await mkdir(codexSource, { recursive: true });
await writeFile(join(codexSource, 'config.toml'), '[mcp_servers.user_tool]\ncommand = "user-mcp"\n');
await writeFile(join(codexSource, 'auth.json'), '{"access_token":"fixture"}\n');
const threadMcp = await prepareCodexThreadMcp({ runId: 'r_fixture', spawnEnv: {
  CODEX_HOME: codexSource, AGENTOC_APPROVED_ACTIONS_ENABLED: '1', AGENTOC_APPROVED_ACTIONS_TOKEN: 'thread-token', UNRELATED_SECRET: 'not-projected',
}, servers: [{ kind: 'actions', scriptPath }] });
assert.equal(threadMcp.serverNames.length, 1);
const threadServer = threadMcp.config.mcp_servers[threadMcp.serverNames[0]];
assert.equal(threadServer.env.AGENTOC_APPROVED_ACTIONS_TOKEN, 'thread-token');
assert.equal(threadServer.env.UNRELATED_SECRET, undefined);
assert.deepEqual(threadServer.args, [scriptPath]);
await mkdir(join(codexSource, 'rules'));
const ownerRule = 'prefix_rule(pattern=["dangerous-tool"], decision="forbidden")\n';
await writeFile(join(codexSource, 'rules', 'owner.rules'), ownerRule);
const codexOverlay = await prepareApprovedActionMcpOverlay({
  runtimeFamily: 'codex-app-server-json',
  runId: 'r_fixture',
  spawnEnv: {
    CODEX_HOME: codexSource,
    AGENTOC_APPROVED_ACTIONS_ENABLED: '1',
    AGENTOC_APPROVED_ACTIONS_ENDPOINT: 'http://127.0.0.1:7690/api/internal/approved-actions/propose',
    AGENTOC_APPROVED_ACTIONS_TOKEN: 'run-secret-token',
    AGENTOC_APPROVED_ACTIONS_SESSION_ID: 's_fixture',
    AGENTOC_APPROVED_ACTIONS_RUN_ID: 'r_fixture',
    AGENTOC_APPROVED_ACTIONS_TURN_ID: 't_fixture',
    AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED: '1',
  },
  scriptPath,
});
assert.ok(codexOverlay);
assert.notEqual(codexOverlay.env.CODEX_HOME, codexSource);
// Codex refuses to publish its helper executables when CODEX_HOME is moved
// into the OS temporary directory. Keep the scoped overlay in its managed
// provider home so the normal workspace sandbox can initialize its helpers.
assert.equal(dirname(codexOverlay.root), codexSource);
assert.equal(await readFile(join(codexOverlay.root, 'rules', 'owner.rules'), 'utf8'), ownerRule);
await writeFile(join(codexOverlay.root, 'rules', 'owner.rules'), '# isolated change\n');
assert.equal(await readFile(join(codexSource, 'rules', 'owner.rules'), 'utf8'), ownerRule);
const overlayConfig = await readFile(codexOverlay.configPath, 'utf8');
assert.match(overlayConfig, /mcp_servers\.user_tool/);
assert.match(overlayConfig, /mcp_servers\.agentoc_actions_/);
assert.match(overlayConfig, /agentoc-approved-actions-mcp\.mjs/);
// Regression: codex MCP children do not inherit the parent env. The run-scoped
// bindings must be projected into the [mcp_servers.X.env] table or the script
// reports an unbound runtime and tools/list answers [].
  assert.match(overlayConfig, /AGENTOC_APPROVED_ACTIONS_ENABLED = "1"/);
  assert.match(overlayConfig, /AGENTOC_APPROVED_ACTIONS_TOKEN = "run-secret-token"/);
  assert.match(overlayConfig, /AGENTOC_APPROVED_ACTIONS_RUN_ID = "r_fixture"/);
  assert.match(overlayConfig, /AGENTOC_AGENT_CREATE_APPROVED_ACTION_ENABLED = "1"/);
assert.equal(await readFile(join(codexSource, 'config.toml'), 'utf8'), '[mcp_servers.user_tool]\ncommand = "user-mcp"\n');
await codexOverlay.cleanup();
await assert.rejects(stat(codexOverlay.root), { code: 'ENOENT' });

const shellGateOverlay = await prepareManagedMcpOverlay({ runtimeFamily: 'codex-app-server-json', runId: 'shell-gate-fixture',
  spawnEnv: { CODEX_HOME: codexSource, SystemRoot: 'D:\\Custom Windows', ProgramW6432: 'E:\\Apps' },
  servers: [{ kind: 'actions', scriptPath }], codexWindowsApprovalGate: true });
const { readdir } = await import('node:fs/promises');
const ruleNames = await readdir(join(shellGateOverlay.root, 'rules'));
const generatedName = ruleNames.find((name) => /^agentoc-shell-gate-[a-f0-9]{16}\.rules$/.test(name));
assert.ok(generatedName);
const shellRules = await readFile(join(shellGateOverlay.root, 'rules', generatedName), 'utf8');
assert.ok(shellRules.includes(JSON.stringify('D:\\Custom Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')));
assert.ok(shellRules.includes(JSON.stringify('E:\\Apps\\PowerShell\\7\\pwsh.exe')));
assert.match(shellRules, /decision="prompt"/);
assert.equal(await readFile(join(shellGateOverlay.root, 'rules', 'owner.rules'), 'utf8'), ownerRule);
if (process.env.AGENTOC_TEST_CODEX_BINARY) {
  const decision = JSON.parse(execFileSync(process.env.AGENTOC_TEST_CODEX_BINARY,
    ['execpolicy', 'check', '--rules', join(shellGateOverlay.root, 'rules', generatedName), '--',
      'D:\\Custom Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-Command', 'Get-Content a'], { encoding: 'utf8' }));
  assert.equal(decision.decision, 'prompt');
  const lowerCase = JSON.parse(execFileSync(process.env.AGENTOC_TEST_CODEX_BINARY,
    ['execpolicy', 'check', '--rules', join(shellGateOverlay.root, 'rules', generatedName), '--',
      'd:/custom windows/system32/windowspowershell/v1.0/powershell.exe', '-NoProfile', '-Command', 'Get-Content a'], { encoding: 'utf8' }));
  assert.equal(lowerCase.decision, 'prompt');
  const ownerDecision = JSON.parse(execFileSync(process.env.AGENTOC_TEST_CODEX_BINARY,
    ['execpolicy', 'check', '--rules', join(shellGateOverlay.root, 'rules', 'owner.rules'), '--', 'dangerous-tool', 'example'], { encoding: 'utf8' }));
  assert.equal(ownerDecision.decision, 'forbidden');
}
await shellGateOverlay.cleanup();

if (process.platform === 'win32') {
  const ownerHooks = JSON.stringify({ description: 'owner fixture', hooks: { PreToolUse: [{ matcher: '^Edit$', hooks: [{ type: 'command', command: 'owner-command' }] }] } });
  await writeFile(join(codexSource, 'hooks.json'), ownerHooks);
  const hookPath = join(repoRoot, 'scripts', 'agentoc-codex-windows-install-hook.mjs');
  const hookOverlay = await prepareManagedMcpOverlay({ runtimeFamily: 'codex-app-server-json', runId: 'hook-fixture',
    spawnEnv: { CODEX_HOME: codexSource }, servers: [{ kind: 'actions', scriptPath }], codexWindowsInstallHook: hookPath });
  assert.ok(hookOverlay.codexWindowsInstallHook);
  const hooks = JSON.parse(await readFile(join(hookOverlay.root, 'hooks.json'), 'utf8'));
  assert.equal(hooks.description, 'owner fixture');
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, 'owner-command');
  assert.equal(hooks.hooks.PreToolUse[1].hooks[0].command, hookOverlay.codexWindowsInstallHook.command);
  assert.equal(await readFile(join(codexSource, 'hooks.json'), 'utf8'), ownerHooks);
  await hookOverlay.cleanup();
  const hookOnly = await prepareManagedMcpOverlay({ runtimeFamily: 'codex-app-server-json', runId: 'hook-only-fixture',
    spawnEnv: { CODEX_HOME: codexSource }, servers: [], codexWindowsInstallHook: hookPath });
  assert.ok(hookOnly.codexWindowsInstallHook);
  assert.deepEqual(hookOnly.serverNames, []);
  assert.equal(JSON.parse(await readFile(join(hookOnly.root, 'hooks.json'), 'utf8')).hooks.PreToolUse.length, 2);
  await hookOnly.cleanup();
}

await assert.rejects(
  () => prepareApprovedActionMcpOverlay({
    runtimeFamily: 'codex-app-server-json',
    runId: 'r_fixture_missing_home',
    spawnEnv: { CODEX_HOME: join(root, 'missing-codex-home') },
    scriptPath,
  }),
  (error) => {
    assert.equal(error.code, 'MCP_PROVIDER_HOME_UNAVAILABLE');
    assert.equal(error.stage, 'preflight');
    assert.equal(error.attempt, 1);
    assert.equal(error.maxAttempts, 3);
    assert.doesNotMatch(error.message, /access_token|fixture|token/i);
    return true;
  },
  'a missing Codex provider home must report the layered provider-home error',
);

await assert.rejects(
  () => prepareApprovedActionMcpOverlay({
    runtimeFamily: 'codex-app-server-json',
    runId: 'r_fixture_missing_server',
    spawnEnv: { CODEX_HOME: codexSource },
    scriptPath: join(root, 'missing-mcp-server.mjs'),
  }),
  (error) => {
    assert.equal(error.code, 'MCP_SERVER_UNAVAILABLE');
    assert.equal(error.stage, 'preflight');
    assert.equal(error.attempt, 1);
    assert.equal(error.maxAttempts, 3);
    return true;
  },
  'a missing MCP server must report the layered server error',
);

// The browser MCP and approved-action MCP share one managed Codex home
// overlay without replacing the existing provider/user MCP definition.
const multiOverlay = await prepareManagedMcpOverlay({
  runtimeFamily: 'codex-app-server-json',
  runId: 'r_fixture_multi',
  spawnEnv: {
    CODEX_HOME: codexSource,
    AGENTOC_APPROVED_ACTIONS_ENABLED: '1',
    AGENTOC_APPROVED_ACTIONS_TOKEN: 'action-token',
    AGENTOC_BROWSER_MCP_ENABLED: '1',
    AGENTOC_BROWSER_TOKEN: 'browser-token',
    AGENTOC_WINDOWS_BROKER_TOKEN: 'broker-token',
  },
  servers: [
    { kind: 'approved-actions', scriptPath, envKeys: ['AGENTOC_APPROVED_ACTIONS_ENABLED', 'AGENTOC_APPROVED_ACTIONS_TOKEN'] },
    { kind: 'browser', scriptPath: join(repoRoot, 'scripts', 'agentoc-browser-mcp-server.mjs'), envKeys: ['AGENTOC_BROWSER_MCP_ENABLED', 'AGENTOC_BROWSER_TOKEN'] },
    { kind: 'broker', scriptPath: join(repoRoot, 'scripts', 'agentoc-windows-broker-mcp.mjs'), envKeys: ['AGENTOC_WINDOWS_BROKER_TOKEN'] },
  ],
});
assert.equal(multiOverlay.serverNames.length, 3);
const multiConfig = await readFile(multiOverlay.configPath, 'utf8');
assert.match(multiConfig, /mcp_servers\.agentoc_actions_/);
assert.match(multiConfig, /mcp_servers\.agentoc_browser_/);
assert.match(multiConfig, /mcp_servers\.agentoc_broker_/);
assert.match(multiConfig, /AGENTOC_APPROVED_ACTIONS_TOKEN = "action-token"/);
assert.match(multiConfig, /AGENTOC_BROWSER_TOKEN = "browser-token"/);
assert.match(multiConfig, /AGENTOC_WINDOWS_BROKER_TOKEN = "broker-token"/);
await multiOverlay.cleanup();
await assert.rejects(stat(multiOverlay.root), { code: 'ENOENT' });

// Regression: the shared provider home carries the setgid bit (2770) on its
// session directories.  fs.cp(recursive) used to replay that mode onto the
// fresh overlay directory, and setting SGID on /tmp (a nosuid mount) fails
// with EPERM, aborting overlay preparation with MCP_OVERLAY_PREPARE_FAILED.
// The sandboxed test process itself cannot set SGID (NoNewPrivileges drops
// CAP_FSETID), so simulate the failure shape directly: the leaf directory is
// created by the copy with default modes only, and a nested tree with a file
// must survive the copy untouched.
const sgidSource = join(root, 'codex-nested-source');
await mkdir(join(sgidSource, 'sessions', '2026', '08', '23'), { recursive: true });
await writeFile(join(sgidSource, 'config.toml'), '');
await writeFile(join(sgidSource, 'auth.json'), '{"access_token":"fixture"}\n');
await writeFile(join(sgidSource, 'sessions', '2026', '08', '23', 'rollout.jsonl'), '{"thread":"t1"}\n');
const nestedOverlay = await prepareApprovedActionMcpOverlay({
  runtimeFamily: 'codex-app-server-json',
  runId: 'r_fixture_nested',
  spawnEnv: { CODEX_HOME: sgidSource },
  scriptPath,
});
assert.ok(nestedOverlay, 'overlay preparation must copy nested session trees');
assert.equal(
  await readFile(join(nestedOverlay.root, 'sessions', '2026', '08', '23', 'rollout.jsonl'), 'utf8'),
  '{"thread":"t1"}\n',
);
await nestedOverlay.cleanup();
await assert.rejects(stat(nestedOverlay.root), { code: 'ENOENT' });

const claudeOverlay = await prepareApprovedActionMcpOverlay({
  runtimeFamily: 'claude-stream-json-bidi',
  runId: 'r_fixture',
  spawnEnv: {},
  scriptPath,
});
assert.ok(claudeOverlay);
const claudeArgs = buildClaudeBidiArgs({ mcpConfigPath: claudeOverlay.configPath });
assert.deepEqual(claudeArgs.slice(-2), ['--mcp-config', claudeOverlay.configPath]);
assert.match(await readFile(claudeOverlay.configPath, 'utf8'), /agentoc_actions_/);
await claudeOverlay.cleanup();

console.log('test-approved-action-mcp: ok');
