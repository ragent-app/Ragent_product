import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { buildClaudeWindowsInstallBridge, checkWindowsInstallBridgeReadiness } from '../chat/windows-auto-install-bridge.mjs';

const approval = { approvalId: 'approval-1', providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: 'winget install Git.Git' } } };
const state = { riskMode: 'full-auto', riskContextValid: true, windowsManagedActionChannel: true };
const options = { approval, state, runId: 'run-1', nodePath: "D:\\Program Files\\node.exe", scriptPath: "D:\\AgentoC\\O'Brien\\bridge.mjs" };
const bridge = buildClaudeWindowsInstallBridge(options);
const channel = { endpoint: 'http://127.0.0.1:12345/api/internal/approved-actions/propose', token: 'test',
  sessionId: 'session', runId: 'run-1', turnId: 'turn' };
let preflightCalls = 0;
const fetchImpl = async (_endpoint, request) => {
  preflightCalls++;
  const payload = JSON.parse(request.body);
  assert.equal(payload.autoInstallPreflight, true);
  assert.equal(payload.actions[0].command, approval.params.input.command);
  return { ok: true, json: async () => ({ kind: 'automatic_install_preflight', ready: true }) };
};
assert.equal(await checkWindowsInstallBridgeReadiness({ channel, command: approval.params.input.command, requestKey: bridge.requestKey, fetchImpl }), true);
for (const endpoint of ['http://localhost:12345/api/internal/approved-actions/propose',
  'http://127.0.0.1:12345/api/internal/approved-actions/propose?token=x', 'http://user@127.0.0.1:12345/api/internal/approved-actions/propose']) {
  assert.equal(await checkWindowsInstallBridgeReadiness({ channel: { ...channel, endpoint }, command: 'winget install Git.Git', requestKey: bridge.requestKey, fetchImpl }), false);
}
assert.equal(preflightCalls, 1);
assert.equal(await checkWindowsInstallBridgeReadiness({ channel, command: approval.params.input.command, requestKey: bridge.requestKey,
  fetchImpl: async () => { throw new Error('unavailable'); } }), false);
assert.match(bridge.updatedCommand, /^& 'D:\\Program Files\\node\.exe' 'D:\\AgentoC\\O''Brien\\bridge\.mjs' '[A-Za-z0-9_-]+'$/);
assert.equal(buildClaudeWindowsInstallBridge({ ...options, state: { ...state, riskMode: 'conservative-auto' } }), null);
assert.equal(buildClaudeWindowsInstallBridge({ ...options, approval: { ...approval, params: { ...approval.params, input: { command: 'winget install Git.Git; Remove-Item x' } } } }), null);
const userCommand = 'winget install Git.Git --scope user';
assert.equal(buildClaudeWindowsInstallBridge({ ...options, approval: { ...approval, params: { ...approval.params, input: { command: userCommand } } } })?.installCommand, userCommand);
for (const command of ['winget add Git.Git', 'winget.exe add --id=Git.Git --scope=machine', 'winget install -q Git.Git', 'winget add --query=Git.Git']) {
  assert.equal(buildClaudeWindowsInstallBridge({ ...options, approval: { ...approval, params: { ...approval.params, input: { command } } } })?.installCommand, command);
}
assert.equal(buildClaudeWindowsInstallBridge({ ...options, approval: { ...approval, params: { ...approval.params, input: { command: 'winget add Git.Git --ignore-security-hash' } } } }), null);
const machineCommand = 'winget install --id Git.Git --scope machine';
const inlineCommand = 'winget install --id=Git.Git --source=winget --scope=machine';
assert.equal(buildClaudeWindowsInstallBridge({ ...options, approval: { ...approval, params: { ...approval.params, input: { command: inlineCommand } } } })?.installCommand, inlineCommand);
assert.equal(buildClaudeWindowsInstallBridge({ ...options, approval: { ...approval, params: { ...approval.params, input: { command: machineCommand } } } })?.installCommand, machineCommand);
const noninteractiveCommand = 'winget install --id Git.Git -e -h --disable-interactivity';
assert.equal(buildClaudeWindowsInstallBridge({ ...options, approval: { ...approval, params: { ...approval.params, input: { command: noninteractiveCommand } } } })?.installCommand, noninteractiveCommand);
assert.equal(buildClaudeWindowsInstallBridge({ ...options, approval: { ...approval, params: { ...approval.params, input: { command: 'winget install Git.Git --ignore-security-hash' } } } }), null);
const bash = buildClaudeWindowsInstallBridge({ ...options, approval: { ...approval, params: { ...approval.params, tool_name: 'Bash' } } });
assert.match(bash.updatedCommand, /^'D:\/Program Files\/node\.exe'/);
for (const riskMode of ['recommended', 'full-auto']) {
  for (const toolName of ['PowerShell', 'Bash']) {
    const wrappedCommand = 'ragent-privileged --description "Install Git" --category install -- winget install Git.Git';
    const wrapped = buildClaudeWindowsInstallBridge({ ...options, state: { ...state, riskMode },
      approval: { ...approval, params: { ...approval.params, tool_name: toolName, input: { command: wrappedCommand } } } });
    assert.equal(wrapped?.installCommand, 'winget install Git.Git');
    const encodedRequest = /'([A-Za-z0-9_-]+)'$/.exec(wrapped.updatedCommand)?.[1];
    assert.equal(JSON.parse(Buffer.from(encodedRequest, 'base64url')).command, wrapped.installCommand);
  }
}
for (const command of [
  'agentoc-privileged --unknown flag -- winget install Git.Git',
  'agentoc-privileged --category delete -- winget install Git.Git',
  'agentoc-privileged --description "$(whoami)" -- winget install Git.Git',
  'agentoc-privileged --description ok -- winget install Git.Git; Remove-Item x',
  'agentoc-privileged; echo x -- winget install Git.Git',
]) assert.equal(buildClaudeWindowsInstallBridge({ ...options,
  approval: { ...approval, params: { ...approval.params, input: { command } } } }), null);

const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    received.push({ headers: req.headers, payload: JSON.parse(body) });
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ kind: 'automatic_install', status: received.length === 1 ? 'executing' : 'succeeded' }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/api/internal/approved-actions/propose`;
const encoded = Buffer.from(JSON.stringify({ command: approval.params.input.command, requestKey: bridge.requestKey })).toString('base64url');
try {
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/agentoc-windows-install-bridge.mjs', import.meta.url)), encoded], {
    env: { ...process.env, AGENTOC_APPROVED_ACTIONS_ENDPOINT: endpoint, AGENTOC_APPROVED_ACTIONS_TOKEN: 'fixture-token',
      AGENTOC_APPROVED_ACTIONS_SESSION_ID: 'session-1', AGENTOC_APPROVED_ACTIONS_RUN_ID: 'run-1', AGENTOC_APPROVED_ACTIONS_TURN_ID: 'turn-1' },
  });
  assert.match(result.stdout, /completed successfully/);
  assert.equal(received.length, 2);
  assert.deepEqual(received[1].payload, { ...received[0].payload, autoInstallStatusOnly: true });
  assert.equal(received[0].payload.requestKey, bridge.requestKey);
  assert.equal(received[0].headers['x-agentoc-approved-action-token'], 'fixture-token');
  const bashPath = process.env.AGENTOC_TEST_BASH_BINARY;
  if (process.platform === 'win32' && bashPath) {
    const wrapped = buildClaudeWindowsInstallBridge({ ...options, nodePath: process.execPath,
      scriptPath: fileURLToPath(new URL('../scripts/agentoc-windows-install-bridge.mjs', import.meta.url)),
      approval: { ...approval, params: { ...approval.params, tool_name: 'Bash', input: {
        command: 'agentoc-privileged --category install -- winget install Git.Git',
      } } } });
    const env = { ...process.env, AGENTOC_APPROVED_ACTIONS_ENDPOINT: endpoint, AGENTOC_APPROVED_ACTIONS_TOKEN: 'fixture-token',
      AGENTOC_APPROVED_ACTIONS_SESSION_ID: 'session-1', AGENTOC_APPROVED_ACTIONS_RUN_ID: 'run-1', AGENTOC_APPROVED_ACTIONS_TURN_ID: 'turn-1' };
    delete env.BASH_ENV; delete env.ENV; delete env.SHELLOPTS;
    const result = await promisify(execFile)(bashPath, ['--noprofile', '--norc', '-c', wrapped.updatedCommand], { env, windowsHide: true });
    assert.match(result.stdout, /completed successfully/);
    assert.equal(received.at(-1).payload.actions[0].command, 'winget install Git.Git');
  }
} finally { await new Promise((resolve) => server.close(resolve)); }
const recoveryRequests = [];
const recoveryServer = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(body);
    recoveryRequests.push(payload);
    if (recoveryRequests.length === 1) { req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ kind: 'automatic_install', status: 'succeeded' }));
  });
});
await new Promise((resolve) => recoveryServer.listen(0, '127.0.0.1', resolve));
try {
  const endpoint = `http://127.0.0.1:${recoveryServer.address().port}/api/internal/approved-actions/propose`;
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/agentoc-windows-install-bridge.mjs', import.meta.url)), encoded], {
    env: { ...process.env, AGENTOC_APPROVED_ACTIONS_ENDPOINT: endpoint, AGENTOC_APPROVED_ACTIONS_TOKEN: 'fixture-token',
      AGENTOC_APPROVED_ACTIONS_SESSION_ID: 'session-1', AGENTOC_APPROVED_ACTIONS_RUN_ID: 'run-1', AGENTOC_APPROVED_ACTIONS_TURN_ID: 'turn-1' },
  });
  assert.match(result.stdout, /completed successfully/);
  assert.equal(recoveryRequests.length, 2);
  assert.equal(recoveryRequests[0].autoInstallStatusOnly, undefined);
  assert.equal(recoveryRequests[1].autoInstallStatusOnly, true, 'lost response must not repeat the install');
  assert.equal(recoveryRequests[1].requestKey, recoveryRequests[0].requestKey);
} finally { await new Promise((resolve) => recoveryServer.close(resolve)); }
const ambiguousRequests = [];
const ambiguousServer = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    ambiguousRequests.push(JSON.parse(body));
    if (ambiguousRequests.length === 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'AUTO_INSTALL_OUTCOME_UNKNOWN', error: 'Broker response was lost' }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'automatic_install', status: 'succeeded' }));
    }
  });
});
await new Promise((resolve) => ambiguousServer.listen(0, '127.0.0.1', resolve));
try {
  const endpoint = `http://127.0.0.1:${ambiguousServer.address().port}/api/internal/approved-actions/propose`;
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/agentoc-windows-install-bridge.mjs', import.meta.url)), encoded], {
    env: { ...process.env, AGENTOC_APPROVED_ACTIONS_ENDPOINT: endpoint, AGENTOC_APPROVED_ACTIONS_TOKEN: 'fixture-token',
      AGENTOC_APPROVED_ACTIONS_SESSION_ID: 'session-1', AGENTOC_APPROVED_ACTIONS_RUN_ID: 'run-1', AGENTOC_APPROVED_ACTIONS_TURN_ID: 'turn-1' },
  });
  assert.match(result.stdout, /completed successfully/);
  assert.equal(ambiguousRequests.length, 2);
  assert.equal(ambiguousRequests[0].autoInstallStatusOnly, undefined);
  assert.equal(ambiguousRequests[1].autoInstallStatusOnly, true, 'ambiguous broker response must only query the existing request');
  assert.equal(ambiguousRequests[1].requestKey, ambiguousRequests[0].requestKey);
} finally { await new Promise((resolve) => ambiguousServer.close(resolve)); }
const invalidKey = generateKeyPairSync('ed25519');
const invalidPin = { kid: 'fixture-key', publicKey: invalidKey.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
let invalidRequests = 0;
const invalidServer = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    invalidRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ kind: 'automatic_user_install_authorization', capability: { kid: invalidPin.kid, windowsExecutionSid: 'S-1-5-21-1-2-3-4' } }));
  });
});
await new Promise((resolve) => invalidServer.listen(0, '127.0.0.1', resolve));
try {
  const endpoint = `http://127.0.0.1:${invalidServer.address().port}/api/internal/approved-actions/propose`;
  const userEncoded = Buffer.from(JSON.stringify({ command: approval.params.input.command, requestKey: bridge.requestKey, windowsUserInstallIdentity: invalidPin })).toString('base64url');
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/agentoc-windows-install-bridge.mjs', import.meta.url)), userEncoded], {
    env: { ...process.env, AGENTOC_APPROVED_ACTIONS_ENDPOINT: endpoint, AGENTOC_APPROVED_ACTIONS_TOKEN: 'fixture-token',
      AGENTOC_APPROVED_ACTIONS_SESSION_ID: 'session-1', AGENTOC_APPROVED_ACTIONS_RUN_ID: 'run-1', AGENTOC_APPROVED_ACTIONS_TURN_ID: 'turn-1' },
  }), (error) => String(error.stderr).includes(process.platform === 'win32' ? 'USER_INSTALL_CAPABILITY_INVALID' : 'USER_INSTALL_CONFIGURATION_INVALID'));
  assert.equal(invalidRequests, 1, 'invalid authorization must not reach claim or execution');
} finally { await new Promise((resolve) => invalidServer.close(resolve)); }
console.log('windows-auto-install-bridge: replacement and durable polling passed');
