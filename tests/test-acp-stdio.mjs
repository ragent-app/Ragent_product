#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildAcpStartInput, buildAcpSessionInput, isAcpInitializeAccepted, buildAcpPromptInput, buildAcpModeSwitchInput, acpAvailableModesFromResponse, isAcpModeSwitchAccepted, buildAcpUnattendedPermissionDenial, parseAcpEvent, acpSessionIdFromResponse } from '../chat/adapters/acp-stdio.mjs';

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
console.log('ACP stdio transport tests passed');
