#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  acpAvailableModelsFromResponse,
  acpAvailableModesFromResponse,
  acpConfigOptionValue,
  acpConfigOptionsFromResponse,
  acpSessionIdFromResponse,
  buildAcpApprovalId,
  buildAcpCancelNotification,
  buildAcpCloseSessionInput,
  buildAcpModeSwitchInput,
  buildAcpPermissionResponse,
  buildAcpPromptInput,
  buildAcpSessionInput,
  buildAcpSetConfigOptionInput,
  buildAcpStartInput,
  buildAcpUnattendedPermissionDenial,
  createAcpEventParser,
  describeAcpPermissionToolCall,
  isAcpConfigOptionAccepted,
  isAcpInitializeAccepted,
  isAcpModeSwitchAccepted,
  isAcpSessionClosed,
  parseAcpEvent,
  parseAcpPermissionRequest,
} from '../chat/adapters/acp-stdio.mjs';

const start = buildAcpStartInput({ cwd: '/workspace' }).trim().split('\n').map(JSON.parse);
assert.equal(start[0].method, 'initialize');
assert.equal(start.length, 1, 'session/new must wait for initialize response');
assert.equal(isAcpInitializeAccepted({ jsonrpc: '2.0', id: 'ragent-initialize', result: { protocolVersion: 1 } }), true);
assert.equal(isAcpInitializeAccepted({ jsonrpc: '2.0', id: 'ragent-initialize', result: { protocolVersion: 2 } }), false);
assert.equal(isAcpInitializeAccepted({ jsonrpc: '2.0', id: 'ragent-initialize', error: { message: 'auth' } }), false);
const browserServer = {
  name: 'ragent-browser',
  command: process.execPath,
  args: ['/repo/scripts/ragent-browser-mcp-server.mjs'],
  env: {
    RAGENT_BROWSER_MCP_ENABLED: '1',
    RAGENT_BROWSER_RUN_ID: 'run-fixture',
  },
};
const startWithBrowser = buildAcpSessionInput({ cwd: '/workspace', mcpServers: [browserServer] })
  .trim().split('\n').map(JSON.parse);
assert.equal(startWithBrowser[0].method, 'session/new');
assert.deepEqual(startWithBrowser[0].params.mcpServers, [browserServer]);
const resumed = buildAcpSessionInput({ cwd: '/workspace', resumeSessionId: 's-existing' })
  .trim().split('\n').map(JSON.parse);
assert.equal(resumed[0].id, 'ragent-session-load');
assert.equal(resumed[0].method, 'session/load');
assert.equal(resumed[0].params.sessionId, 's-existing');
assert.equal(acpSessionIdFromResponse({ result: { sessionId: 's-1' } }), 's-1');
const event = parseAcpEvent(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
} }), { provider: 'test' });
assert.equal(event[0].type, 'text_delta');
assert.equal(event[0].text, 'hello');
assert.match(buildAcpPromptInput('s-1', 'work'), /session\/prompt/);
const kimiModes = acpAvailableModesFromResponse({ result: {
  modes: { availableModes: [{ id: 'default' }, { id: 'auto' }] },
} });
const kimiModeSwitch = JSON.parse(buildAcpModeSwitchInput('s-1', 'auto', kimiModes));
assert.equal(kimiModeSwitch.method, 'session/set_mode');
assert.deepEqual(kimiModeSwitch.params, { sessionId: 's-1', modeId: 'auto' });
assert.equal(buildAcpModeSwitchInput('s-1', 'yolo', kimiModes), null);
assert.deepEqual(acpAvailableModesFromResponse({ result: { configOptions: [
  { id: 'mode', options: [{ value: 'yolo' }] },
] } }), [{ value: 'yolo' }]);
assert.equal(isAcpModeSwitchAccepted({ jsonrpc: '2.0', id: 'ragent-set-mode', result: {} }), true);
assert.equal(isAcpModeSwitchAccepted({ jsonrpc: '2.0', id: 'ragent-set-mode', error: { message: 'denied' } }), false);
assert.equal(isAcpModeSwitchAccepted({ jsonrpc: '2.0', id: 'other', result: {} }), false);
assert.equal(isAcpModeSwitchAccepted({ jsonrpc: '2.0', id: 'ragent-set-mode', result: null }), false);
const permissionRequest = {
  jsonrpc: '2.0', id: 5, method: 'session/request_permission',
  params: { sessionId: 's-1', options: [
    { optionId: 'allow', kind: 'allow_once' },
    { optionId: 'reject', kind: 'reject_once' },
  ] },
};
const denied = buildAcpUnattendedPermissionDenial(permissionRequest, 's-1');
assert.deepEqual(JSON.parse(denied.line).result.outcome, { outcome: 'selected', optionId: 'reject' });
assert.equal(denied.cancelled, false);
assert.equal(buildAcpUnattendedPermissionDenial(permissionRequest, 'another-session'), null);
const noReject = buildAcpUnattendedPermissionDenial({
  ...permissionRequest, params: { sessionId: 's-1', options: [
    { optionId: 'allow', kind: 'allow_once' },
    { optionId: 'remember-deny', kind: 'reject_always' },
  ] },
}, 's-1');
assert.deepEqual(JSON.parse(noReject.line).result.outcome, { outcome: 'cancelled' });
assert.equal(noReject.cancelled, true);
assert.equal(buildAcpUnattendedPermissionDenial({ ...permissionRequest, id: null }, 's-1'), null);
assert.equal(
  parseAcpEvent(JSON.stringify({ jsonrpc: '2.0', id: 'ragent-session-load', result: {} }), { provider: 'hermes' })[0].content,
  'ACP session resumed',
);
assert.equal(parseAcpEvent('{bad json').length, 0);

// AgY 1.5.12 ACP frames: update.name takes precedence over display title,
// agent_thought_chunk emits reasoning delta, usage_update emits context window,
// and session/prompt camelCase usage emits turn usage before completion status.
const agyAcp = createAcpEventParser({ provider: 'agy', runtimeFamily: 'agy-acp' });
const agyThought = agyAcp.parseLine(JSON.stringify({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 'agy-sess-1',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '19 * 23 = 437' } },
  },
}));
assert.equal(agyThought[0].type, 'reasoning');
assert.equal(agyThought[0].content, '19 * 23 = 437');
assert.equal(agyThought[0].providerSessionId, 'agy-sess-1');

const agyToolStart = agyAcp.parseLine(JSON.stringify({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 'agy-sess-1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      name: 'run_command',
      title: 'echo ACP_CMD_OK',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'echo ACP_CMD_OK' },
    },
  },
}));
assert.equal(agyToolStart[0].type, 'tool_use');
assert.equal(agyToolStart[0].toolName, 'run_command');
assert.equal(agyToolStart[0].providerTitle, 'echo ACP_CMD_OK');
assert.equal(agyToolStart[0].operationTitle, 'echo ACP_CMD_OK');
assert.equal(agyToolStart[0].providerToolKind, 'execute');

const agyToolEnd = agyAcp.parseLine(JSON.stringify({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 'agy-sess-1',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      title: 'echo ACP_CMD_OK',
      status: 'completed',
      rawOutput: { output: 'ACP_CMD_OK\n', exit_code: 0 },
    },
  },
}));
assert.equal(agyToolEnd[0].type, 'tool_result');
assert.equal(agyToolEnd[0].toolName, 'run_command');
assert.equal(agyToolEnd[0].exitCode, 0);
assert.equal(agyToolEnd[0].providerTitle, 'echo ACP_CMD_OK');

const agyWindowUsage = agyAcp.parseLine(JSON.stringify({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 'agy-sess-1',
    update: { sessionUpdate: 'usage_update', used: 9221, size: 1048576 },
  },
}));
assert.equal(agyWindowUsage[0].type, 'usage');
assert.equal(agyWindowUsage[0].contextTokens, 9221);
assert.equal(agyWindowUsage[0].contextWindowTokens, 1048576);
assert.equal(agyWindowUsage[0].contextSource, 'provider_context_window');

const agyPromptDone = agyAcp.parseLine(JSON.stringify({
  jsonrpc: '2.0',
  id: 'ragent-prompt',
  result: {
    stopReason: 'end_turn',
    usage: {
      inputTokens: 11216,
      outputTokens: 174,
      cachedReadTokens: 6916,
      cachedWriteTokens: 0,
      thoughtTokens: 129,
      totalTokens: 18306,
    },
  },
}));
assert.equal(agyPromptDone.length, 2);
assert.equal(agyPromptDone[0].type, 'usage');
assert.equal(agyPromptDone[0].inputTokens, 11216);
assert.equal(agyPromptDone[0].outputTokens, 174);
assert.equal(agyPromptDone[0].cachedInputTokens, 6916);
assert.equal(agyPromptDone[0].reasoningTokens, 129);
assert.equal(agyPromptDone[0].contextTokens, 18306);
assert.equal(agyPromptDone[0].contextSource, 'provider_turn_usage');
assert.equal(agyPromptDone[1].type, 'status');
assert.equal(agyPromptDone[1].content, 'completed');
assert.equal(agyPromptDone[1].stopReason, 'end_turn');

// Reverse-RPC session/request_permission parsing and responses.
const agyPermissionRequest = {
  jsonrpc: '2.0',
  id: 'jetski-acp-front:2',
  method: 'session/request_permission',
  params: {
    sessionId: 'agy-sess-1',
    toolCall: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_perm_1',
      name: 'run_command',
      title: 'echo ACP_CMD_OK',
      kind: 'execute',
      status: 'pending',
      rawInput: { CommandLine: 'echo ACP_CMD_OK' },
    },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  },
};
const parsedPerm = parseAcpPermissionRequest(agyPermissionRequest, 'agy-sess-1');
assert.equal(parsedPerm.id, 'jetski-acp-front:2');
assert.equal(parsedPerm.toolCall.name, 'run_command');
assert.equal(parsedPerm.toolCall.toolCallId, 'call_perm_1');
assert.deepEqual(parsedPerm.toolCall.input, { CommandLine: 'echo ACP_CMD_OK' });
assert.equal(parseAcpPermissionRequest(agyPermissionRequest, 'wrong-sess'), null);
assert.deepEqual(
  JSON.parse(buildAcpPermissionResponse(agyPermissionRequest, 'allow_once', 'agy-sess-1').line).result.outcome,
  { outcome: 'selected', optionId: 'allow' },
);
assert.deepEqual(
  JSON.parse(buildAcpPermissionResponse(agyPermissionRequest, { optionId: 'deny' }, 'agy-sess-1').line).result.outcome,
  { outcome: 'selected', optionId: 'deny' },
);
assert.equal(buildAcpPermissionResponse(agyPermissionRequest, 'allow_always', 'agy-sess-1'), null);
assert.deepEqual(
  JSON.parse(buildAcpPermissionResponse(agyPermissionRequest, { kind: 'allow_always', allowFallbackToOnce: true }, 'agy-sess-1').line).result.outcome,
  { outcome: 'selected', optionId: 'allow' },
);
assert.equal(buildAcpPermissionResponse(agyPermissionRequest, { optionId: 'forged' }, 'agy-sess-1'), null);
assert.deepEqual(
  JSON.parse(buildAcpPermissionResponse(agyPermissionRequest, 'cancelled', 'agy-sess-1').line).result.outcome,
  { outcome: 'cancelled' },
);

// Config options, cancel notification, session/close, and Streamable HTTP mcpServers.
const agySessionInitResponse = {
  jsonrpc: '2.0',
  id: 'ragent-session-new',
  result: {
    sessionId: 'agy-sess-1',
    models: { availableModels: [{ modelId: 'gemini-4-neon-high' }] },
    configOptions: [
      { id: 'model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon' }] },
      { id: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'xhigh' }] },
    ],
  },
};
assert.equal(acpConfigOptionsFromResponse(agySessionInitResponse).length, 2);
assert.equal(acpConfigOptionValue(agySessionInitResponse, 'thought_level'), 'high');
assert.deepEqual(acpAvailableModelsFromResponse(agySessionInitResponse), [{ modelId: 'gemini-4-neon-high' }]);
const setCfg = JSON.parse(buildAcpSetConfigOptionInput('agy-sess-1', 'thought_level', 'xhigh'));
assert.equal(setCfg.method, 'session/set_config_option');
assert.deepEqual(setCfg.params, { sessionId: 'agy-sess-1', configId: 'thought_level', value: 'xhigh' });
assert.equal(isAcpConfigOptionAccepted({ jsonrpc: '2.0', id: 'ragent-set-config-option', result: {} }), true);
const cancelNote = JSON.parse(buildAcpCancelNotification('agy-sess-1'));
assert.equal(Object.hasOwn(cancelNote, 'id'), false);
assert.equal(cancelNote.method, 'session/cancel');
assert.deepEqual(cancelNote.params, { sessionId: 'agy-sess-1' });
const closeReq = JSON.parse(buildAcpCloseSessionInput('agy-sess-1'));
assert.equal(closeReq.method, 'session/close');
assert.equal(isAcpSessionClosed({ jsonrpc: '2.0', id: 'ragent-session-close', result: {} }), true);
const httpMcpSession = JSON.parse(buildAcpSessionInput({
  cwd: '/ws',
  mcpServers: [{ type: 'http', name: 'remote-mcp', url: 'http://127.0.0.1:7690/mcp' }],
  additionalDirectories: ['/extra-dir', '/extra-dir'],
}));
assert.equal(httpMcpSession.params.mcpServers.length, 1);
assert.deepEqual(httpMcpSession.params.additionalDirectories, ['/extra-dir']);

assert.equal(buildAcpApprovalId('agy', 1), 'agy:1');
assert.equal(buildAcpApprovalId('', 'req-2'), 'acp:req-2');
assert.equal(buildAcpApprovalId('agy', ''), '');

const cmdDetails = describeAcpPermissionToolCall({
  kind: 'execute',
  name: 'run_command',
  title: 'Run git status',
  input: { CommandLine: 'git status', cwd: '/ws', toolSummary: 'Inspect git status' },
});
assert.equal(cmdDetails.approvalKind, 'command');
assert.equal(cmdDetails.command, 'git status');
assert.equal(cmdDetails.cwd, '/ws');
assert.equal(cmdDetails.reason, 'Inspect git status');

const editDetails = describeAcpPermissionToolCall({
  kind: 'edit',
  name: 'replace_file_content',
  title: 'Patch README',
  input: { TargetFile: '/ws/README.md' },
});
assert.equal(editDetails.approvalKind, 'file_change');
assert.deepEqual(editDetails.filePaths, ['/ws/README.md']);

const agyParser = createAcpEventParser({ provider: 'agy', runtimeFamily: 'agy-acp' });
const permissionRequestLine = JSON.stringify({
  jsonrpc: '2.0',
  id: 7,
  method: 'session/request_permission',
  params: {
    sessionId: 'agy-sess-1',
    toolCall: {
      toolCallId: 'tc-perm-7',
      name: 'run_command',
      kind: 'execute',
      title: 'Run echo ok',
      rawInput: { CommandLine: 'echo ok', cwd: '/ws' },
    },
    options: [
      { optionId: 'allow-1', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-1', name: 'Reject once', kind: 'reject_once' },
    ],
  },
});
const reqEvents = agyParser.parseLine(permissionRequestLine);
assert.equal(reqEvents.length, 1);
assert.equal(reqEvents[0]?.type, 'approval_request');
assert.equal(reqEvents[0]?.approvalId, 'agy:7');
assert.equal(reqEvents[0]?.providerRequestId, '7');
assert.equal(reqEvents[0]?.providerMethod, 'session/request_permission');
assert.equal(reqEvents[0]?.kind, 'command');
assert.equal(reqEvents[0]?.command, 'echo ok');
assert.equal(reqEvents[0]?.providerSessionId, 'agy-sess-1');
assert.equal(reqEvents[0]?.source, 'agy-acp');
assert.equal(reqEvents[0]?.permissions?.options?.length, 2);
assert.ok(reqEvents[0]?.explanation, 'command permission request should carry risk explanation');

const respEvents = agyParser.parseLine(JSON.stringify({
  type: 'ragent.approval_response',
  approvalId: 'agy:7',
  provider: 'agy',
  providerRequestId: '7',
  providerMethod: 'session/request_permission',
  decision: 'accept',
  status: 'approved',
}));
assert.equal(respEvents.length, 1);
assert.equal(respEvents[0]?.type, 'approval_response');
assert.equal(respEvents[0]?.approvalId, 'agy:7');
assert.equal(respEvents[0]?.decision, 'accept');
assert.equal(respEvents[0]?.status, 'approved');
assert.equal(respEvents[0]?.source, 'agy');

const autoApprovedEvents = agyParser.parseLine(JSON.stringify({
  type: 'ragent.approval_response',
  approvalId: 'agy:8',
  provider: 'agy',
  providerRequestId: '8',
  providerMethod: 'session/request_permission',
  decision: 'accept',
  status: 'approved',
  autoApproved: true,
}));
assert.deepEqual(autoApprovedEvents, [], 'auto-approved response should suppress owner approval card');
assert.deepEqual(agyParser.parseLine(JSON.stringify({
  jsonrpc: '2.0',
  id: 8,
  method: 'session/request_permission',
  params: {
    sessionId: 'agy-sess-1',
    toolCall: { toolCallId: 'tc-perm-8', kind: 'read', title: 'Read file', rawInput: { AbsolutePath: '/ws/a.txt' } },
    options: [{ optionId: 'allow-once', kind: 'allow_once' }],
  },
})), [], 'subsequent request_permission matching autoApprovedId must be suppressed');

const autoDeniedEvents = agyParser.parseLine(JSON.stringify({
  type: 'ragent.approval_response',
  approvalId: 'agy:9',
  provider: 'agy',
  providerRequestId: '9',
  providerMethod: 'session/request_permission',
  decision: 'decline',
  status: 'denied',
  autoDenied: true,
}));
assert.deepEqual(autoDeniedEvents, []);
assert.deepEqual(agyParser.parseLine(JSON.stringify({
  jsonrpc: '2.0',
  id: 9,
  method: 'session/request_permission',
  params: {
    sessionId: 'agy-sess-1',
    toolCall: { toolCallId: 'tc-perm-9', kind: 'execute', title: 'Run cmd', rawInput: { CommandLine: 'whoami' } },
    options: [{ optionId: 'reject-once', kind: 'reject_once' }],
  },
})), [], 'subsequent request_permission matching autoDenied must be suppressed');

agyParser.seedAutoApprovedIds(['agy:seeded-10']);
assert.deepEqual(agyParser.parseLine(JSON.stringify({
  jsonrpc: '2.0',
  id: 'seeded-10',
  method: 'session/request_permission',
  params: {
    sessionId: 'agy-sess-1',
    toolCall: { toolCallId: 'tc-perm-10', kind: 'execute', title: 'Seeded', rawInput: { CommandLine: 'pwd' } },
    options: [{ optionId: 'allow-once', kind: 'allow_once' }],
  },
})), [], 'seedAutoApprovedIds should suppress pre-seeded ACP approval ids');

console.log('ACP stdio transport tests passed');
