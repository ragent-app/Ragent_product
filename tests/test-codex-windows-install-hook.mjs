import assert from 'node:assert/strict';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { buildCodexWindowsInstallHookDecision, verifyCodexWindowsInstallBridgeApproval } from '../chat/codex-windows-install-hook.mjs';
import { buildClaudeWindowsInstallBridge } from '../chat/windows-auto-install-bridge.mjs';

const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call-1', tool_input: { command: 'winget install Git.Git' } };
const channel = { runId: 'run-1', sessionId: 'session-1', turnId: 'turn-1', token: 'fixture', endpoint: 'http://127.0.0.1:12345/api/internal/approved-actions/propose' };
const nodePath = 'D:\\Program Files\\node.exe', scriptPath = 'E:\\Ragent\\bridge.mjs';
let calls = [];
const preflight = async (request) => { calls.push(request); return true; };
const options = { event, channel, nodePath, scriptPath, preflight };
const result = await buildCodexWindowsInstallHookDecision(options);
const expected = buildClaudeWindowsInstallBridge({ approval: { approvalId: event.tool_use_id, providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: event.tool_input.command } } },
  state: { windowsManagedActionChannel: true, riskMode: 'recommended', riskContextValid: true }, runId: channel.runId, nodePath, scriptPath });
assert.deepEqual(result, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: expected.updatedCommand } } });
assert.deepEqual(calls, [{ channel, command: event.tool_input.command, requestKey: expected.requestKey }]);
for (const invalidEvent of [null, { ...event, hook_event_name: 'PostToolUse' }, { ...event, tool_name: 'Edit' },
  { ...event, tool_use_id: '' }, { ...event, tool_input: { command: 'winget install Git.Git; Remove-Item x' } },
  { ...event, tool_input: { command: 'winget install Git.Git --scope invalid' } }]) {
  assert.deepEqual(await buildCodexWindowsInstallHookDecision({ ...options, event: invalidEvent }), {});
}
assert.equal(calls.length, 1);
assert.deepEqual(await buildCodexWindowsInstallHookDecision({ ...options, preflight: async () => false }), {});
assert.deepEqual(await buildCodexWindowsInstallHookDecision({ ...options, preflight: async () => { throw new Error('offline'); } }), {});
process.env.SystemRoot ||= 'C:\\Windows';
const psExe = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const shQuote = s => "'" + s.replace(/'/g, "'\\''") + "'";
const wrapped = command => [psExe, '-NoProfile', '-Command', command].map(shQuote).join(' ');
const state = { startedTurn: true, windowsManagedActionChannel: true, windowsManagedActionBinding: channel, riskMode: 'recommended',
  riskContextValid: true, threadId: 'thread-1', turnId: 'provider-turn-1' };
const approval = { providerMethod: 'item/commandExecution/requestApproval', kind: 'command', params: { threadId: state.threadId,
  turnId: state.turnId, itemId: event.tool_use_id, command: wrapped(expected.updatedCommand) } };
const verify = { approval, state, runId: channel.runId, nodePath, scriptPath, preflight };
assert.equal(await verifyCodexWindowsInstallBridgeApproval(verify), true);
const wrappedInstallEvent = { ...event, tool_input: { command: 'ragent-privileged --category install -- winget install Git.Git' } };
calls = [];
const wrappedDecision = await buildCodexWindowsInstallHookDecision({ ...options, event: wrappedInstallEvent });
assert.equal(wrappedDecision.hookSpecificOutput?.permissionDecision, 'allow');
assert.equal(calls[0]?.command, 'winget install Git.Git');
const wrappedApproval = { ...approval, params: { ...approval.params, command: wrapped(wrappedDecision.hookSpecificOutput.updatedInput.command) } };
assert.equal(await verifyCodexWindowsInstallBridgeApproval({ ...verify, approval: wrappedApproval }), true);
const pinKeys = generateKeyPairSync('ed25519');
const pin = { kid: 'instance-fixture', publicKey: pinKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const pinnedChannel = { ...channel, windowsUserInstallIdentity: pin };
const pinnedDecision = await buildCodexWindowsInstallHookDecision({ ...options, channel: pinnedChannel });
const pinnedCommand = pinnedDecision.hookSpecificOutput.updatedInput.command;
const pinnedApproval = { ...approval, params: { ...approval.params, command: wrapped(pinnedCommand) } };
const pinnedState = { ...state, windowsManagedActionBinding: pinnedChannel };
assert.equal(await verifyCodexWindowsInstallBridgeApproval({ ...verify, state: pinnedState, approval: pinnedApproval }), true);
assert.equal(await verifyCodexWindowsInstallBridgeApproval({ ...verify, state, approval: pinnedApproval }), false, 'hook cannot choose its own user installation key');
assert.deepEqual(await buildCodexWindowsInstallHookDecision({ ...options, event: { ...event, tool_input: {
  command: 'ragent-privileged --category delete -- winget install Git.Git',
} } }), {});
for (const change of [
  { approval: { ...approval, params: { ...approval.params, itemId: 'other' } } },
  { approval: { ...approval, params: { ...approval.params, threadId: 'other' } } },
  { approval: { ...approval, params: { ...approval.params, additionalPermissions: { network: true } } } },
  { approval: { ...approval, params: { ...approval.params, command: wrapped(expected.updatedCommand + '; Write-Output bad') } } },
  { state: { ...state, riskMode: 'conservative-auto' } },
  { state: { ...state, startedTurn: false } },
  { runId: 'other' },
  { preflight: async () => false },
]) assert.equal(await verifyCodexWindowsInstallBridgeApproval({ ...verify, ...change }), false);
console.log('codex-windows-install-hook: binding, replacement and fallback passed');
