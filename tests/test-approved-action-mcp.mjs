#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
  buildAgyAcpMcpServers,
  prepareAgyAcpMcpOverlay,
  prepareApprovedActionMcpOverlay,
  prepareManagedMcpOverlay,
  prepareCodexThreadMcp,
} from '../chat/approved-action-mcp-overlay.mjs';
import { supportsManagedApprovedActions } from '../chat/approved-action-policy.mjs';
import { supportsBrowserMcpRuntime } from '../chat/browser-capability.mjs';
import { buildClaudeBidiArgs } from '../chat/adapters/claude-bidi.mjs';

const repoRoot = join(import.meta.dirname, '..');
const scriptPath = join(repoRoot, 'scripts', 'ragent-approved-actions-mcp.mjs');

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
    RAGENT_APPROVED_ACTIONS_ENABLED: '1',
    RAGENT_AGENT_CREATE_APPROVED_ACTION_ENABLED: '1',
    RAGENT_APPROVED_ACTIONS_ENDPOINT: `http://127.0.0.1:${port}/api/internal/approved-actions/propose`,
    RAGENT_APPROVED_ACTIONS_TOKEN: 'run-secret-token',
    RAGENT_APPROVED_ACTIONS_SESSION_ID: 's_fixture',
    RAGENT_APPROVED_ACTIONS_RUN_ID: 'r_fixture',
    RAGENT_APPROVED_ACTIONS_TURN_ID: 't_fixture',
    RAGENT_APPROVED_ACTIONS_CWD: '/tmp',
    RAGENT_APPROVED_ACTIONS_PROJECT_ROOT: '/tmp',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const request = readResponses(child);
const discoverApproved = await request(0, 'server/discover');
assert.deepEqual(discoverApproved.result, {});
const initialize = await request(1, 'initialize');
assert.equal(initialize.result.serverInfo.name, 'ragent-approved-actions');
const tools = await request(2, 'tools/list');
assert.equal(tools.result.tools.length, 2);
assert.equal(tools.result.tools[0].name, 'ragent_request_actions');
assert.match(tools.result.tools[0].description, /executing status is not completion/);
assert.match(tools.result.tools[0].description, /statusOnly=true and the same requestKey and identical action/);
assert.equal(tools.result.tools[1].name, 'ragent_create_agent');
assert.doesNotMatch(JSON.stringify(tools), /run-secret-token/);
const call = await request(3, 'tools/call', {
  name: 'ragent_request_actions',
  arguments: {
    requestKey: 'mcp-fixture-1',
    actions: [{ command: 'systemctl is-active nginx', cwd: '/tmp', description: 'Check nginx' }],
  },
});
assert.equal(call.result.isError, false);
assert.match(call.result.content[0].text, /awaiting_approval/);
assert.equal(received.length, 1);
assert.equal(received[0].headers['x-ragent-approved-action-token'], 'run-secret-token');
assert.equal(received[0].body.runId, 'r_fixture');
assert.equal(received[0].body.actions[0].command, 'systemctl is-active nginx');
const productCall = await request(4, 'tools/call', {
  name: 'ragent_create_agent',
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
  name: 'ragent_request_actions',
  arguments: {
    requestKey: 'mcp-fixture-denied',
    actions: [{ command: 'systemctl restart nginx', cwd: '/tmp', description: 'Restart nginx' }],
  },
});
assert.equal(deniedCall.result.isError, true);
assert.match(deniedCall.result.content[0].text, /Unattended policy denied the action/);
assert.match(deniedCall.result.content[0].text, /requestKey: mcp-fixture-denied/);
const automatic = await request(7, 'tools/call', { name: 'ragent_request_actions', arguments: {
  requestKey: 'mcp-fixture-install', actions: [{ command: 'winget install Git.Git' }],
} });
assert.deepEqual(JSON.parse(automatic.result.content[0].text), { kind: 'automatic_install', status: 'executing', code: '', requestId: 'auto-1', requestKey: 'mcp-fixture-install', duplicate: false });
const automaticStatus = await request(8, 'tools/call', { name: 'ragent_request_actions', arguments: {
  requestKey: 'mcp-fixture-install', statusOnly: true, actions: [{ command: 'winget install Git.Git' }],
} });
assert.equal(automaticStatus.result.isError, false);
assert.equal(received.at(-1).body.autoInstallStatusOnly, true);
const missingKeyStatus = await request(9, 'tools/call', { name: 'ragent_request_actions', arguments: {
  statusOnly: true, actions: [{ command: 'winget install Git.Git' }],
} });
assert.equal(missingKeyStatus.result.isError, true);
const service = await request(10, 'tools/call', { name: 'ragent_request_actions', arguments: {
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
    RAGENT_APPROVED_ACTIONS_ENABLED: '1',
    RAGENT_AGENT_CREATE_APPROVED_ACTION_ENABLED: '0',
    RAGENT_APPROVED_ACTIONS_ENDPOINT: `http://127.0.0.1:${port}/api/internal/approved-actions/propose`,
    RAGENT_APPROVED_ACTIONS_TOKEN: 'run-secret-token',
    RAGENT_APPROVED_ACTIONS_SESSION_ID: 's_fixture',
    RAGENT_APPROVED_ACTIONS_RUN_ID: 'r_fixture',
    RAGENT_APPROVED_ACTIONS_TURN_ID: 't_fixture',
    RAGENT_APPROVED_ACTIONS_CWD: '/tmp',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const disabledRequest = readResponses(disabledChild);
const disabledTools = await disabledRequest(5, 'tools/list');
assert.deepEqual(disabledTools.result.tools.map((tool) => tool.name), ['ragent_request_actions']);
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
  CODEX_HOME: codexSource, RAGENT_APPROVED_ACTIONS_ENABLED: '1', RAGENT_APPROVED_ACTIONS_TOKEN: 'thread-token', UNRELATED_SECRET: 'not-projected',
}, servers: [{ kind: 'actions', scriptPath }] });
assert.equal(threadMcp.serverNames.length, 1);
const threadServer = threadMcp.config.mcp_servers[threadMcp.serverNames[0]];
assert.equal(threadServer.env.RAGENT_APPROVED_ACTIONS_TOKEN, 'thread-token');
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
    RAGENT_APPROVED_ACTIONS_ENABLED: '1',
    RAGENT_APPROVED_ACTIONS_ENDPOINT: 'http://127.0.0.1:7690/api/internal/approved-actions/propose',
    RAGENT_APPROVED_ACTIONS_TOKEN: 'run-secret-token',
    RAGENT_APPROVED_ACTIONS_SESSION_ID: 's_fixture',
    RAGENT_APPROVED_ACTIONS_RUN_ID: 'r_fixture',
    RAGENT_APPROVED_ACTIONS_TURN_ID: 't_fixture',
    RAGENT_AGENT_CREATE_APPROVED_ACTION_ENABLED: '1',
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
assert.match(overlayConfig, /mcp_servers\.ragent_act_/);
assert.match(overlayConfig, /ragent-approved-actions-mcp\.mjs/);
// Regression: codex MCP children do not inherit the parent env. The run-scoped
// bindings must be projected into the [mcp_servers.X.env] table or the script
// reports an unbound runtime and tools/list answers [].
  assert.match(overlayConfig, /RAGENT_APPROVED_ACTIONS_ENABLED = "1"/);
  assert.match(overlayConfig, /RAGENT_APPROVED_ACTIONS_TOKEN = "run-secret-token"/);
  assert.match(overlayConfig, /RAGENT_APPROVED_ACTIONS_RUN_ID = "r_fixture"/);
  assert.match(overlayConfig, /RAGENT_AGENT_CREATE_APPROVED_ACTION_ENABLED = "1"/);
assert.equal(await readFile(join(codexSource, 'config.toml'), 'utf8'), '[mcp_servers.user_tool]\ncommand = "user-mcp"\n');
await codexOverlay.cleanup();
await assert.rejects(stat(codexOverlay.root), { code: 'ENOENT' });

const shellGateOverlay = await prepareManagedMcpOverlay({ runtimeFamily: 'codex-app-server-json', runId: 'shell-gate-fixture',
  spawnEnv: { CODEX_HOME: codexSource, SystemRoot: 'D:\\Custom Windows', ProgramW6432: 'E:\\Apps' },
  servers: [{ kind: 'actions', scriptPath }], codexWindowsApprovalGate: true });
const { readdir } = await import('node:fs/promises');
const ruleNames = await readdir(join(shellGateOverlay.root, 'rules'));
const generatedName = ruleNames.find((name) => /^ragent-shell-gate-[a-f0-9]{16}\.rules$/.test(name));
assert.ok(generatedName);
const shellRules = await readFile(join(shellGateOverlay.root, 'rules', generatedName), 'utf8');
assert.ok(shellRules.includes(JSON.stringify('D:\\Custom Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')));
assert.ok(shellRules.includes(JSON.stringify('E:\\Apps\\PowerShell\\7\\pwsh.exe')));
assert.match(shellRules, /decision="prompt"/);
assert.equal(await readFile(join(shellGateOverlay.root, 'rules', 'owner.rules'), 'utf8'), ownerRule);
if (process.env.RAGENT_TEST_CODEX_BINARY) {
  const decision = JSON.parse(execFileSync(process.env.RAGENT_TEST_CODEX_BINARY,
    ['execpolicy', 'check', '--rules', join(shellGateOverlay.root, 'rules', generatedName), '--',
      'D:\\Custom Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-Command', 'Get-Content a'], { encoding: 'utf8' }));
  assert.equal(decision.decision, 'prompt');
  const lowerCase = JSON.parse(execFileSync(process.env.RAGENT_TEST_CODEX_BINARY,
    ['execpolicy', 'check', '--rules', join(shellGateOverlay.root, 'rules', generatedName), '--',
      'd:/custom windows/system32/windowspowershell/v1.0/powershell.exe', '-NoProfile', '-Command', 'Get-Content a'], { encoding: 'utf8' }));
  assert.equal(lowerCase.decision, 'prompt');
  const ownerDecision = JSON.parse(execFileSync(process.env.RAGENT_TEST_CODEX_BINARY,
    ['execpolicy', 'check', '--rules', join(shellGateOverlay.root, 'rules', 'owner.rules'), '--', 'dangerous-tool', 'example'], { encoding: 'utf8' }));
  assert.equal(ownerDecision.decision, 'forbidden');
}
await shellGateOverlay.cleanup();

if (process.platform === 'win32') {
  const ownerHooks = JSON.stringify({ description: 'owner fixture', hooks: { PreToolUse: [{ matcher: '^Edit$', hooks: [{ type: 'command', command: 'owner-command' }] }] } });
  await writeFile(join(codexSource, 'hooks.json'), ownerHooks);
  const hookPath = join(repoRoot, 'scripts', 'ragent-codex-windows-install-hook.mjs');
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
    RAGENT_APPROVED_ACTIONS_ENABLED: '1',
    RAGENT_APPROVED_ACTIONS_TOKEN: 'action-token',
    RAGENT_BROWSER_MCP_ENABLED: '1',
    RAGENT_BROWSER_TOKEN: 'browser-token',
    RAGENT_WINDOWS_BROKER_TOKEN: 'broker-token',
  },
  servers: [
    { kind: 'approved-actions', scriptPath, envKeys: ['RAGENT_APPROVED_ACTIONS_ENABLED', 'RAGENT_APPROVED_ACTIONS_TOKEN'] },
    { kind: 'browser', scriptPath: join(repoRoot, 'scripts', 'ragent-browser-mcp-server.mjs'), envKeys: ['RAGENT_BROWSER_MCP_ENABLED', 'RAGENT_BROWSER_TOKEN'] },
    { kind: 'broker', scriptPath: join(repoRoot, 'scripts', 'ragent-windows-broker-mcp.mjs'), envKeys: ['RAGENT_WINDOWS_BROKER_TOKEN'] },
  ],
});
assert.equal(multiOverlay.serverNames.length, 3);
const multiConfig = await readFile(multiOverlay.configPath, 'utf8');
assert.match(multiConfig, /mcp_servers\.ragent_act_/);
assert.match(multiConfig, /mcp_servers\.ragent_brw_/);
assert.match(multiConfig, /mcp_servers\.ragent_brk_/);
assert.match(multiConfig, /RAGENT_APPROVED_ACTIONS_TOKEN = "action-token"/);
assert.match(multiConfig, /RAGENT_BROWSER_TOKEN = "browser-token"/);
assert.match(multiConfig, /RAGENT_WINDOWS_BROKER_TOKEN = "broker-token"/);
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
assert.match(await readFile(claudeOverlay.configPath, 'utf8'), /ragent_act_/);
await claudeOverlay.cleanup();

// Policy & browser capability runtime family admission for AgY
for (const family of ['agy-acp', 'agy-stream-json']) {
  assert.equal(supportsManagedApprovedActions({ runtimeFamily: family, supportsManagedActionMcp: true }), true);
  assert.equal(supportsBrowserMcpRuntime(family), true);
}

// AgY ACP mcpServers array builder + overlay (with reserved/SSE filtering)
const acpOverlay = await prepareAgyAcpMcpOverlay({
  runId: 'r_agy_acp',
  spawnEnv: {
    RAGENT_APPROVED_ACTIONS_ENABLED: '1',
    RAGENT_APPROVED_ACTIONS_TOKEN: 'agy-acp-token',
    RAGENT_BROWSER_MCP_ENABLED: '1',
    RAGENT_BROWSER_TOKEN: 'agy-browser-token',
    UNRELATED_HOST_SECRET: 'must-not-appear',
  },
  servers: [
    { kind: 'actions', scriptPath },
    { kind: 'browser', scriptPath: join(repoRoot, 'scripts', 'ragent-browser-mcp-server.mjs') },
  ],
  externalServers: [
    { name: 'docs', url: 'https://docs.example.invalid/mcp', headers: { Authorization: 'Bearer ok' } },
    { name: 'ragent_spoof', command: 'node', args: ['evil.js'] },
    { name: 'legacy_sse', type: 'sse', url: 'https://legacy.example.invalid/sse' },
  ],
});
assert.ok(acpOverlay);
assert.equal(acpOverlay.mcpServers.length, 3);
const acpActions = acpOverlay.mcpServers[0];
assert.match(acpActions.name, /^ragent_act_/);
assert.deepEqual(acpActions.args, [scriptPath]);
assert.ok(Array.isArray(acpActions.env));
assert.ok(acpActions.env.some((e) => e.name === 'RAGENT_APPROVED_ACTIONS_TOKEN' && e.value === 'agy-acp-token'));
assert.ok(!acpActions.env.some((e) => e.name === 'UNRELATED_HOST_SECRET'));
const acpDocs = acpOverlay.mcpServers.find((s) => s.name === 'docs');
assert.equal(acpDocs?.type, 'http');
assert.equal(acpDocs?.url, 'https://docs.example.invalid/mcp');
assert.equal(acpOverlay.mcpServers.some((s) => s.name === 'ragent_spoof' || s.name === 'legacy_sse'), false);
await acpOverlay.cleanup();

// AgY stream-json isolated <agyHomeDir>/.gemini/config/mcp_config.json overlay
const agyRunHome = join(root, 'agy-stream-home');
await mkdir(join(agyRunHome, '.gemini', 'config'), { recursive: true });
const externalOnlyDoc = JSON.stringify({
  mcpServers: { userExt: { command: 'node', args: ['ext.mjs'], disabled: false } },
}, null, 2) + '\n';
await writeFile(join(agyRunHome, '.gemini', 'config', 'mcp_config.json'), externalOnlyDoc, 'utf8');

const agyOverlay = await prepareManagedMcpOverlay({
  runtimeFamily: 'agy-stream-json',
  runId: 'r_agy_stream',
  agyHomeDir: agyRunHome,
  spawnEnv: {
    RAGENT_APPROVED_ACTIONS_ENABLED: '1',
    RAGENT_APPROVED_ACTIONS_TOKEN: 'agy-stream-token',
    UNRELATED_HOST_SECRET: 'never-projected',
  },
  servers: [{ kind: 'actions', scriptPath }],
});
assert.ok(agyOverlay);
const agyConfigParsed = JSON.parse(await readFile(agyOverlay.configPath, 'utf8'));
assert.ok(agyConfigParsed.mcpServers.userExt, 'Existing authorized external MCP preserved in Run home');
const managedAgyKey = agyOverlay.serverNames[0];
assert.equal(agyConfigParsed.mcpServers[managedAgyKey].env.RAGENT_APPROVED_ACTIONS_TOKEN, 'agy-stream-token');
assert.equal(agyConfigParsed.mcpServers[managedAgyKey].env.UNRELATED_HOST_SECRET, undefined);
await agyOverlay.cleanup();
assert.equal(await readFile(agyOverlay.configPath, 'utf8'), externalOnlyDoc, 'Cleanup restores Run home mcp_config.json without leaking Run tokens');

await assert.rejects(
  () => prepareManagedMcpOverlay({
    runtimeFamily: 'agy-stream-json',
    runId: 'r_agy_missing_home',
    spawnEnv: {},
    servers: [{ kind: 'actions', scriptPath }],
  }),
  (error) => error.code === 'MCP_PROVIDER_HOME_UNAVAILABLE',
);

// Verify server/discover returns immediate empty JSON-RPC result on org & browser MCP servers too
for (const serverScript of ['scripts/ragent-organization-mcp.mjs', 'scripts/ragent-browser-mcp-server.mjs']) {
  const srv = spawn(process.execPath, [join(repoRoot, serverScript)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = readResponses(srv);
  const res = await rpc(99, 'server/discover');
  assert.deepEqual(res.result, {}, `${serverScript} must reply {} to server/discover`);
  srv.stdin.end();
  await new Promise((resolveExit) => srv.once('exit', resolveExit));
}

const directAcpList = buildAgyAcpMcpServers({
  runId: 'r_direct',
  spawnEnv: { RAGENT_SESSION_CONTROL_TOKEN: 'org-tok' },
  servers: [{ kind: 'organization', scriptPath: join(repoRoot, 'scripts', 'ragent-organization-mcp.mjs') }],
});
assert.ok(directAcpList[0].env.some((e) => e.name === 'RAGENT_SESSION_CONTROL_TOKEN' && e.value === 'org-tok'));

const allManagedSpecs = [
  {
    kind: 'organization',
    scriptPath: join(repoRoot, 'scripts', 'ragent-organization-mcp.mjs'),
    expectedPrefix: /^ragent_org_[a-f0-9]{8}$/,
    tools: ['ragent_organization_read', 'ragent_organization_action'],
  },
  {
    kind: 'actions',
    scriptPath: join(repoRoot, 'scripts', 'ragent-approved-actions-mcp.mjs'),
    expectedPrefix: /^ragent_act_[a-f0-9]{8}$/,
    tools: ['ragent_request_actions', 'ragent_create_agent'],
  },
  {
    kind: 'browser',
    scriptPath: join(repoRoot, 'scripts', 'ragent-browser-mcp-server.mjs'),
    expectedPrefix: /^ragent_brw_[a-f0-9]{8}$/,
    tools: [
      'ragent_browser_navigate',
      'ragent_browser_snapshot',
      'ragent_browser_click',
      'ragent_browser_fill',
      'ragent_browser_press',
      'ragent_browser_select_option',
      'ragent_browser_screenshot',
      'ragent_browser_download',
    ],
  },
  {
    kind: 'broker',
    scriptPath: join(repoRoot, 'scripts', 'ragent-windows-broker-mcp.mjs'),
    expectedPrefix: /^ragent_brk_[a-f0-9]{8}$/,
    tools: [
      'ragent_restart_qa_service',
      'ragent_restart_qa_service_status',
      'ragent_restart_qa_service_with_env',
    ],
  },
  {
    kind: 'windows_broker',
    scriptPath: join(repoRoot, 'scripts', 'ragent-windows-broker-mcp.mjs'),
    expectedPrefix: /^ragent_brk_[a-f0-9]{8}$/,
    tools: [
      'ragent_restart_qa_service',
      'ragent_restart_qa_service_status',
      'ragent_restart_qa_service_with_env',
    ],
  },
];
const allManagedOverlay = await prepareAgyAcpMcpOverlay({
  runId: 'run-with-long-id-for-agy-mcp-name-limit',
  spawnEnv: { RAGENT_SESSION_CONTROL_TOKEN: 'org-tok' },
  servers: allManagedSpecs.map(({ kind, scriptPath }) => ({ kind, scriptPath })),
});
const serverNamesByKind = new Map(
  allManagedSpecs.map((spec, index) => [spec.kind, allManagedOverlay.serverNames[index]]),
);
assert.deepEqual(
  [...serverNamesByKind.keys()],
  ['organization', 'actions', 'browser', 'broker', 'windows_broker'],
);
assert.equal(new Set(allManagedOverlay.serverNames).size, allManagedSpecs.length);
for (const spec of allManagedSpecs) {
  const serverName = serverNamesByKind.get(spec.kind);
  assert.match(serverName, spec.expectedPrefix);
  assert.match(serverName, /^ragent(?:[_-]|$)/i);
  assert.ok(serverName.length <= 22, `serverName too long (${serverName.length}): ${serverName}`);
  for (const toolName of spec.tools) {
    const single = `mcp_${serverName}_${toolName}`;
    const double = `mcp__${serverName}__${toolName}`;
    assert.ok(single.length <= 64, `composed tool name exceeds 64 chars (${single.length}): ${single}`);
    assert.ok(double.length <= 64, `double-underscore tool name exceeds 64 chars (${double.length}): ${double}`);
    assert.match(single, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.match(double, /^[a-zA-Z0-9_-]{1,64}$/);
  }
}
await allManagedOverlay.cleanup();

// Regression (P1 #5b): Codex under Windows RunnerSupervisor spawns MCP children with
// LOCALAPPDATA/APPDATA/USERPROFILE pointing under ProgramData and RAGENT_* stripped except
// ORGANIZATION_MCP_ENV_KEYS. ragent-organization-mcp.mjs must start and serve tools without
// crashing inside config.mjs's ProgramData runtime-path check.
{
  const { createServer } = await import('node:http');
  const seenCalls = [];
  const orgHttp = createServer(async (req, res) => {
    assert.equal(req.headers['x-ragent-session-control-token'], 'sc-tok-win-pd');
    assert.equal(req.headers['x-ragent-session-control-run-id'], 'run-win-pd');
    assert.equal(req.headers['x-ragent-session-control-session-id'], 'sess-win-pd');
    assert.equal(req.headers['x-ragent-session-control-turn-id'], 'turn-win-pd');
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/sessions/sess-win-pd/organization/tools-root');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    seenCalls.push(body);
    if (body.action === 'capabilities.get') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        actions: ['swarm.status', 'board.read'],
        tools: [
          {
            name: 'ragent_organization_read',
            description: 'Read org state',
            inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
          },
          {
            name: 'ragent_organization_action',
            description: 'Perform org action',
            inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
          },
        ],
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, action: body.action, visibility: 'org' }));
  });
  await new Promise((resolveListen) => orgHttp.listen(0, '127.0.0.1', resolveListen));
  const orgPort = orgHttp.address().port;
  const orgBaseUrl = `http://127.0.0.1:${orgPort}`;
  try {
    const codexThreadMcp = await prepareCodexThreadMcp({
      runId: 'run-win-pd',
      spawnEnv: {
        CODEX_HOME: codexSource,
        RAGENT_CHAT_BASE_URL: orgBaseUrl,
        RAGENT_ORGANIZATION_TOOL_SCOPE: 'root',
        RAGENT_SESSION_CONTROL_TOKEN: 'sc-tok-win-pd',
        RAGENT_SESSION_CONTROL_RUN_ID: 'run-win-pd',
        RAGENT_SESSION_CONTROL_SESSION_ID: 'sess-win-pd',
        RAGENT_SESSION_CONTROL_TURN_ID: 'turn-win-pd',
      },
      servers: [{ kind: 'organization', scriptPath: join(repoRoot, 'scripts', 'ragent-organization-mcp.mjs') }],
    });
    const orgServerName = codexThreadMcp.serverNames[0];
    const mcpSpec = codexThreadMcp.config.mcp_servers[orgServerName];
    assert.ok(mcpSpec, 'prepareCodexThreadMcp must build organization mcp_servers entry');
    const orgMcpProc = spawn(mcpSpec.command, mcpSpec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        LOCALAPPDATA: 'C:\\ProgramData\\Ragent\\instances\\owner\\executor\\home\\AppData\\Local',
        APPDATA: 'C:\\ProgramData\\Ragent\\instances\\owner\\executor\\home\\AppData\\Roaming',
        USERPROFILE: 'C:\\ProgramData\\Ragent\\instances\\owner\\executor\\home',
        ...mcpSpec.env,
      },
    });
    let stderrText = '';
    orgMcpProc.stderr.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });
    try {
      const rpc = readResponses(orgMcpProc);
      const initRes = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
      assert.equal(initRes.result?.serverInfo?.name, 'ragent-organization');
      orgMcpProc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      const listRes = await rpc(2, 'tools/list', {});
      assert.deepEqual(
        (listRes.result?.tools || []).map((t) => t.name),
        ['ragent_organization_read', 'ragent_organization_action'],
      );
      const callRes = await rpc(3, 'tools/call', {
        name: 'ragent_organization_read',
        arguments: { action: 'swarm.status' },
      });
      assert.equal(Boolean(callRes.result?.isError), false, `unexpected error response: ${JSON.stringify(callRes)}`);
      assert.equal(JSON.parse(callRes.result.content[0].text).visibility, 'org');
      assert.deepEqual(seenCalls, [{ action: 'capabilities.get' }, { action: 'swarm.status', args: {} }]);
      assert.equal(stderrText, '', `unexpected stderr on organization MCP startup: ${stderrText}`);
    } finally {
      orgMcpProc.stdin.end();
      await new Promise((resolveExit) => orgMcpProc.once('exit', resolveExit));
    }
  } finally {
    await new Promise((resolveClose) => orgHttp.close(resolveClose));
  }
}

console.log('test-approved-action-mcp: ok');
