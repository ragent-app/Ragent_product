#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildCodexAppServerConfig,
  buildCodexAppServerApprovalResponseMessage,
  buildCodexAppServerInitializeMessage,
  buildCodexAppServerModelListMessage,
  buildCodexAppServerMcpServerStatusListMessage,
  buildCodexAppServerThreadMessage,
  buildCodexAppServerThreadForkMessage,
  buildCodexAppServerTurnInterruptMessage,
  buildCodexAppServerTurnStartMessage,
  buildCodexAppServerTurnSteerMessage,
  buildCodexAppServerThreadGoalSetMessage,
  buildCodexAppServerThreadGoalGetMessage,
  buildCodexAppServerThreadGoalClearMessage,
  readCodexAppServerApprovalRequest,
  readCodexAppServerManagedMcpRequest,
  readCodexAppServerThreadId,
  readCodexAppServerEventTurnId,
  readCodexAppServerTurnId,
  readCodexAppServerGoalFields,
  readCodexAppServerGoalPayload,
  evaluateCodexAppServerMcpReadiness,
  isCodexAppServerEventForThread,
  isCodexAppServerTurnTerminalMessage,
  readCodexAppServerEventThreadId,
  readCodexAppServerMcpStartupStatus,
  readCodexAppServerMcpStatusList,
} from '../chat/codex-app-server-protocol.mjs';
import {
  buildCodexAppServerArgs,
  buildCodexAppServerProjectTrustArgs,
  createCodexAppServerAdapter,
} from '../chat/adapters/codex-app-server.mjs';

assert.deepEqual(buildCodexAppServerArgs(), ['app-server', '--stdio']);
assert.deepEqual(buildCodexAppServerArgs({ cwd: 'G:/QA/project', agentocApprovalGate: true }), [
  'app-server', '--stdio', '-c', 'projects={"G:/QA/project"={trust_level="untrusted"}}',
]);
assert.deepEqual(buildCodexAppServerProjectTrustArgs('G:\\QA\\Ragent "fixture"'), [
  '-c', 'projects={"G:\\\\QA\\\\Ragent \\\"fixture\\\""={trust_level="untrusted"}}',
]);
assert.throws(() => buildCodexAppServerProjectTrustArgs('relative/project'), /absolute Run working directory/);
assert.deepEqual(buildCodexAppServerConfig('plan'), { mode: 'plan' });
assert.deepEqual(buildCodexAppServerConfig('agent'), { mode: 'default' });

const initialize = buildCodexAppServerInitializeMessage();
assert.equal(initialize.method, 'initialize');
assert.equal(initialize.params.capabilities.experimentalApi, true);

assert.deepEqual(
  buildCodexAppServerModelListMessage({ id: 6, limit: 20, includeHidden: false }),
  {
    method: 'model/list',
    id: 6,
    params: { limit: 20, includeHidden: false },
  },
);
assert.deepEqual(
  buildCodexAppServerModelListMessage({ id: 7, cursor: 'next-page', includeHidden: true }),
  {
    method: 'model/list',
    id: 7,
    params: { limit: 100, includeHidden: true, cursor: 'next-page' },
  },
);

assert.deepEqual(
  buildCodexAppServerMcpServerStatusListMessage({ id: 77, threadId: 'thread-123' }),
  {
    method: 'mcpServerStatus/list',
    id: 77,
    params: { detail: 'full', threadId: 'thread-123' },
  },
);
const mcpStartup = readCodexAppServerMcpStartupStatus({
  method: 'mcpServer/startupStatus/updated',
  params: { name: 'agentoc_actions_fixture', status: 'ready', threadId: 'thread-123' },
});
assert.deepEqual(mcpStartup, {
  name: 'agentoc_actions_fixture',
  status: 'ready',
  threadId: 'thread-123',
  hasError: false,
});
const mcpInventoryMessage = {
  id: 77,
  result: {
    data: [{
      name: 'agentoc_actions_fixture',
      tools: {
        agentoc_request_actions: {
          name: 'agentoc_request_actions',
          inputSchema: { type: 'object', properties: {} },
        },
      },
      resources: [],
      resourceTemplates: [],
    }],
  },
};
assert.deepEqual(readCodexAppServerMcpStatusList(mcpInventoryMessage), [{
  name: 'agentoc_actions_fixture',
  schemaAvailable: true,
  toolNames: ['agentoc_request_actions'],
}]);
assert.equal(
  evaluateCodexAppServerMcpReadiness({
    inventory: readCodexAppServerMcpStatusList(mcpInventoryMessage),
    startupStatuses: { agentoc_actions_fixture: 'ready' },
    expectedServerName: 'agentoc_actions_fixture',
    requiredToolNames: ['agentoc_request_actions'],
  }).state,
  'ready',
);
assert.equal(
  evaluateCodexAppServerMcpReadiness({
    inventory: [{
      name: 'agentoc_actions_fixture',
      schemaAvailable: true,
      toolNames: ['agentoc_request_actions'],
    }],
    startupStatuses: {
      agentoc_actions_fixture: 'ready',
    },
    requiredServers: [
      { name: 'agentoc_actions_fixture', requiredToolNames: ['agentoc_request_actions'] },
      { name: 'agentoc_browser_fixture', requiredToolNames: ['agentoc_browser_navigate'] },
    ],
  }).reasonCode,
  'MCP_SERVER_DISCOVERY_PENDING',
);
assert.equal(
  evaluateCodexAppServerMcpReadiness({
    inventory: [
      { name: 'agentoc_actions_fixture', schemaAvailable: true, toolNames: ['agentoc_request_actions'] },
      { name: 'agentoc_browser_fixture', schemaAvailable: true, toolNames: ['agentoc_browser_navigate'] },
    ],
    startupStatuses: {
      agentoc_actions_fixture: 'ready',
      agentoc_browser_fixture: 'starting',
    },
    requiredServers: [
      { name: 'agentoc_actions_fixture', requiredToolNames: ['agentoc_request_actions'] },
      { name: 'agentoc_browser_fixture', requiredToolNames: ['agentoc_browser_navigate'] },
    ],
  }).reasonCode,
  'MCP_STARTUP_PENDING',
);
assert.equal(
  evaluateCodexAppServerMcpReadiness({
    inventory: [{ name: 'agentoc_actions_fixture', schemaAvailable: false, toolNames: [] }],
    startupStatuses: { agentoc_actions_fixture: 'ready' },
    expectedServerName: 'agentoc_actions_fixture',
    requiredToolNames: ['agentoc_request_actions'],
  }).reasonCode,
  'MCP_TOOL_SCHEMA_UNAVAILABLE',
);
assert.equal(
  evaluateCodexAppServerMcpReadiness({
    inventory: [
      {
        name: 'agentoc_actions_fixture',
        schemaAvailable: true,
        toolNames: ['agentoc_request_actions'],
      },
      {
        name: 'agentoc_browser_fixture',
        schemaAvailable: true,
        toolNames: ['agentoc_browser_navigate'],
      },
    ],
    startupStatuses: {
      agentoc_actions_fixture: 'ready',
      agentoc_browser_fixture: 'ready',
    },
    requiredServers: [
      { name: 'agentoc_actions_fixture', requiredToolNames: ['agentoc_request_actions'] },
      { name: 'agentoc_browser_fixture', requiredToolNames: ['agentoc_browser_navigate'] },
    ],
  }).state,
  'ready',
);
assert.equal(
  evaluateCodexAppServerMcpReadiness({
    inventory: [
      { name: 'agentoc_actions_fixture', schemaAvailable: true, toolNames: ['agentoc_request_actions'] },
      { name: 'agentoc_browser_fixture', schemaAvailable: true, toolNames: [] },
    ],
    startupStatuses: {
      agentoc_actions_fixture: 'ready',
      agentoc_browser_fixture: 'ready',
    },
    requiredServers: [
      { name: 'agentoc_actions_fixture', requiredToolNames: ['agentoc_request_actions'] },
      { name: 'agentoc_browser_fixture', requiredToolNames: ['agentoc_browser_navigate'] },
    ],
  }).reasonCode,
  'MCP_REQUIRED_TOOL_MISSING',
);
assert.equal(
  evaluateCodexAppServerMcpReadiness({
    inventory: readCodexAppServerMcpStatusList({
      result: {
        data: [{
          name: 'agentoc_actions_fixture',
          tools: { agentoc_request_actions: { inputSchema: { type: 'object' } } },
        }],
      },
    }),
    startupStatuses: { agentoc_actions_fixture: 'ready' },
    expectedServerName: 'agentoc_actions_fixture',
    requiredToolNames: ['agentoc_request_actions'],
  }).reasonCode,
  'MCP_TOOL_SCHEMA_UNAVAILABLE',
);

const planThreadStart = buildCodexAppServerThreadMessage({
  cwd: '/tmp/work',
  interactionMode: 'plan',
  model: 'gpt-test',
  developerInstructions: 'Use AgentoC context renderer output.',
});
assert.equal(planThreadStart.method, 'thread/start');
assert.equal(planThreadStart.params.approvalPolicy, 'never');
assert.equal(planThreadStart.params.sandbox, 'read-only');
assert.equal(planThreadStart.params.config.mode, 'plan');
assert.equal(planThreadStart.params.model, 'gpt-test');
assert.equal(planThreadStart.params.developerInstructions, 'Use AgentoC context renderer output.');

const executeThreadResume = buildCodexAppServerThreadMessage({
  threadId: 'thread-123',
  useResume: true,
  interactionMode: 'agent',
});
const oldRollout = 'G:\\Agentoc\\legacy\\sessions\\rollout.jsonl';
assert.equal(buildCodexAppServerThreadMessage({ threadId: 'thread-123', useResume: true, rolloutPath: oldRollout }).params.path, oldRollout);
assert.equal(buildCodexAppServerThreadForkMessage({ threadId: 'thread-123', rolloutPath: oldRollout }).params.path, oldRollout);
assert.equal(Object.hasOwn(buildCodexAppServerThreadMessage({ threadId: 'thread-123', useResume: false, rolloutPath: oldRollout }).params, 'path'), false);
assert.throws(() => buildCodexAppServerThreadMessage({ threadId: 'thread-123', useResume: true, rolloutPath: '../rollout.jsonl' }), /absolute path/);
assert.throws(() => buildCodexAppServerThreadForkMessage({ threadId: 'thread-123', rolloutPath: '/tmp/rollout\n.jsonl' }), /absolute path/);
const scopedMcp = { mcp_servers: { fixture: { command: 'node', args: ['mcp.js'], env: { TOKEN: 'fixture' } } } };
for (const useResume of [false, true]) {
  const scopedThread = buildCodexAppServerThreadMessage({ threadId: 'thread-123', useResume, interactionMode: 'plan', threadMcpConfig: scopedMcp,
    threadShellEnvironment: { AGENTOC_RUN_ID: 'run-fixture' } });
  assert.deepEqual(scopedThread.params.config.mcp_servers, scopedMcp.mcp_servers);
  assert.deepEqual(scopedThread.params.config.shell_environment_policy.set, { AGENTOC_RUN_ID: 'run-fixture' });
  assert.equal(scopedThread.params.config.mode, 'plan');
}
assert.equal(executeThreadResume.method, 'thread/resume');
assert.equal(executeThreadResume.params.threadId, 'thread-123');
assert.equal(executeThreadResume.params.sandbox, 'danger-full-access');
assert.equal(executeThreadResume.params.config.mode, 'default');

const gatedThreadFork = buildCodexAppServerThreadForkMessage({
  id: 10,
  threadId: 'source-thread',
  cwd: 'G:/QA/project',
  permissionMode: 'untrusted-danger-full-access',
  agentocApprovalGate: true,
});
assert.equal(gatedThreadFork.method, 'thread/fork');
assert.equal(Object.hasOwn(gatedThreadFork.params, 'approvalPolicy'), false);
assert.equal(gatedThreadFork.params.approvalsReviewer, 'user');
assert.equal(gatedThreadFork.params.config.allow_login_shell, false);
assert.deepEqual(gatedThreadFork.params.config.projects, {
  'G:/QA/project': { trust_level: 'untrusted' },
});

const readOnlyThreadStart = buildCodexAppServerThreadMessage({
  permissionMode: 'read-only',
});
assert.equal(readOnlyThreadStart.params.sandbox, 'read-only');
assert.equal(readOnlyThreadStart.params.config.mode, 'default');

const workspaceWriteThreadStart = buildCodexAppServerThreadMessage({
  permissionMode: 'on-request-workspace-write',
});
assert.equal(workspaceWriteThreadStart.params.approvalPolicy, 'on-request');
assert.equal(workspaceWriteThreadStart.params.sandbox, 'workspace-write');

const turnStart = buildCodexAppServerTurnStartMessage({
  threadId: 'thread-123',
  text: 'Draft a plan.',
  clientUserMessageId: 'req-1',
  cwd: '/tmp/work',
  interactionMode: 'plan',
  reasoningEffort: 'high',
});
assert.equal(turnStart.method, 'turn/start');
assert.equal(turnStart.params.threadId, 'thread-123');
assert.equal(turnStart.params.input[0].text, 'Draft a plan.');
assert.deepEqual(turnStart.params.input[0].text_elements, []);
assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
assert.equal(turnStart.params.approvalPolicy, 'never');
assert.equal(turnStart.params.effort, 'high');

const workspaceWriteTurnStart = buildCodexAppServerTurnStartMessage({
  threadId: 'thread-123',
  text: 'Edit files.',
  cwd: '/tmp/project',
  permissionMode: 'on-request-workspace-write',
});
assert.deepEqual(workspaceWriteTurnStart.params.sandboxPolicy, {
  type: 'workspaceWrite',
  networkAccess: false,
  writableRoots: ['/tmp/project'],
});
assert.equal(workspaceWriteTurnStart.params.approvalPolicy, 'on-request');
for (const cwd of ['C:\\Users\\owner\\task', '/Users/owner/task']) {
  const scoped = buildCodexAppServerTurnStartMessage({
    threadId: 'thread-123', cwd, permissionMode: 'never-workspace-write',
  });
  assert.deepEqual(scoped.params.sandboxPolicy.writableRoots, [cwd]);
  assert.equal(scoped.params.sandboxPolicy.networkAccess, false);
  assert.equal(scoped.params.approvalPolicy, 'never');
}
for (const cwd of [undefined, '', 'relative-task']) {
  const unbound = buildCodexAppServerTurnStartMessage({
    threadId: 'thread-123', cwd, permissionMode: 'never-workspace-write',
  });
  assert.deepEqual(unbound.params.sandboxPolicy.writableRoots, []);
}
assert.deepEqual(buildCodexAppServerTurnStartMessage({
  threadId: 'thread-123', cwd: '/tmp/another', permissionMode: 'never-read-only',
}).params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
assert.deepEqual(workspaceWriteTurnStart.params.sandboxPolicy.writableRoots, ['/tmp/project']);

const steer = buildCodexAppServerTurnSteerMessage({
  id: 1000,
  threadId: 'thread-123',
  turnId: 'turn-abc',
  text: 'Revise step two.',
  clientUserMessageId: 'req-2',
});
assert.equal(steer.method, 'turn/steer');
assert.equal(steer.params.expectedTurnId, 'turn-abc');
assert.equal(steer.params.input[0].text, 'Revise step two.');

const interrupt = buildCodexAppServerTurnInterruptMessage({
  id: 1001,
  threadId: 'thread-123',
  turnId: 'turn-abc',
});
assert.equal(interrupt.method, 'turn/interrupt');
assert.equal(interrupt.params.turnId, 'turn-abc');

assert.equal(readCodexAppServerThreadId({ result: { thread: { id: 'thread-result' } } }), 'thread-result');
assert.equal(readCodexAppServerThreadId({ method: 'thread/started', params: { thread: { id: 'thread-note' } } }), 'thread-note');
assert.equal(readCodexAppServerTurnId({ result: { turn: { id: 'turn-result' } } }), 'turn-result');
assert.equal(readCodexAppServerTurnId({ method: 'turn/started', params: { turn: { id: 'turn-note' } } }), 'turn-note');
assert.equal(
  readCodexAppServerEventTurnId({ method: 'turn/completed', params: { turn: { id: 'turn-completed' } } }),
  'turn-completed',
);
assert.equal(
  readCodexAppServerEventTurnId({ method: 'error', params: { turnId: 'turn-error' } }),
  'turn-error',
);
assert.equal(
  isCodexAppServerTurnTerminalMessage(
    { method: 'turn/completed', params: { threadId: 'thread-parent', turn: { id: 'turn-parent', status: 'completed' } } },
    'turn-parent',
  ),
  true,
);
assert.equal(
  isCodexAppServerTurnTerminalMessage(
    { method: 'turn/completed', params: { threadId: 'thread-parent', turn: { id: 'turn-old', status: 'completed' } } },
    'turn-parent',
  ),
  false,
  'a completion from an older turn must not terminate the active turn',
);
assert.equal(
  isCodexAppServerTurnTerminalMessage(
    { method: 'turn/completed', params: { threadId: 'thread-parent', turn: { id: 'turn-parent', status: 'inProgress' } } },
    'turn-parent',
  ),
  false,
  'a non-terminal turn status must not terminate the active turn',
);
assert.equal(
  isCodexAppServerTurnTerminalMessage(
    { method: 'turn/completed', params: { threadId: 'thread-parent', turn: { id: 'turn-parent', status: 'interrupted' } } },
    'turn-parent',
  ),
  true,
);
assert.equal(
  isCodexAppServerTurnTerminalMessage(
    { method: 'error', params: { threadId: 'thread-parent', turnId: 'turn-parent', willRetry: true } },
    'turn-parent',
  ),
  false,
);
assert.equal(
  isCodexAppServerTurnTerminalMessage(
    { method: 'error', params: { threadId: 'thread-parent', turnId: 'turn-parent', willRetry: false } },
    'turn-parent',
  ),
  true,
);
assert.equal(
  isCodexAppServerTurnTerminalMessage(
    { method: 'error', params: { threadId: 'thread-parent', turnId: 'turn-old', willRetry: false } },
    'turn-parent',
  ),
  false,
);
assert.equal(
  isCodexAppServerTurnTerminalMessage({ id: 2, error: { message: 'turn start failed' } }),
  true,
  'a turn/start JSON-RPC error remains an explicit failure signal',
);
assert.equal(
  readCodexAppServerEventThreadId({ method: 'turn/completed', params: { threadId: 'thread-parent' } }),
  'thread-parent',
);
assert.equal(
  isCodexAppServerEventForThread(
    { method: 'turn/completed', params: { threadId: 'thread-child', turn: { id: 'turn-child' } } },
    'thread-parent',
  ),
  false,
);
assert.equal(
  isCodexAppServerEventForThread(
    { method: 'turn/completed', params: { threadId: 'thread-parent', turn: { id: 'turn-parent' } } },
    'thread-parent',
  ),
  true,
);
assert.equal(
  isCodexAppServerEventForThread(
    { id: 2, result: { turn: { id: 'turn-parent' } } },
    'thread-parent',
  ),
  true,
);
assert.equal(
  isCodexAppServerEventForThread(
    { method: 'turn/completed', params: { turn: { id: 'turn-unknown' } } },
    'thread-parent',
  ),
  false,
);

const approvalRequestMessage = {
  method: 'item/commandExecution/requestApproval',
  id: 'approval-1',
  params: {
    threadId: 'thread-123',
    turnId: 'turn-abc',
    itemId: 'cmd-1',
    reason: 'Need shell access',
    command: 'echo approved',
    cwd: '/tmp/work',
  },
};
const approvalRequest = readCodexAppServerApprovalRequest(approvalRequestMessage);
assert.equal(approvalRequest.approvalId, 'item/commandExecution/requestApproval:approval-1');
assert.equal(approvalRequest.kind, 'command');
assert.equal(approvalRequest.requestClass, 'command_invocation');
const fileChangeApproval = readCodexAppServerApprovalRequest({ method: 'item/fileChange/requestApproval', id: 2, params: { itemId: 'patch-1' } });
assert.equal(fileChangeApproval.kind, 'file_change');
assert.equal(fileChangeApproval.requestClass, 'file_change');
const capabilityApproval = readCodexAppServerApprovalRequest({ method: 'item/permissions/requestApproval', id: 3, params: {} });
assert.equal(capabilityApproval.kind, 'permissions');
assert.equal(capabilityApproval.requestClass, 'capability_grant');
const elicitationApproval = readCodexAppServerApprovalRequest({ method: 'mcpServer/elicitation/request', id: 4, params: {} });
assert.equal(elicitationApproval.requestClass, 'mcp_elicitation');
assert.deepEqual(
  buildCodexAppServerApprovalResponseMessage(approvalRequest, 'approve'),
  { id: 'approval-1', result: { decision: 'accept' } },
);

const managedMcpRequestMessage = {
  method: 'mcpServer/elicitation/request',
  id: 'mcp-elicitation-1',
  params: {
    serverName: 'agentoc_actions_0123456789abcdef',
    threadId: 'thread-123',
    turnId: 'turn-abc',
    mode: 'form',
    _meta: { codex_approval_kind: 'mcp_tool_call' },
    requestedSchema: { type: 'object', properties: {} },
    request: { message: 'Continue with the managed action.' },
  },
};
const managedMcpRequest = readCodexAppServerManagedMcpRequest(managedMcpRequestMessage);
assert.equal(managedMcpRequest.mcpServerName, 'agentoc_actions_0123456789abcdef');
assert.equal(readCodexAppServerManagedMcpRequest({ ...managedMcpRequestMessage, params: { ...managedMcpRequestMessage.params, _meta: {} } }), null);
assert.equal(readCodexAppServerManagedMcpRequest({ ...managedMcpRequestMessage, params: { ...managedMcpRequestMessage.params, requestedSchema: { type: 'object', properties: { secret: { type: 'string' } } } } }), null);
assert.deepEqual(
  buildCodexAppServerApprovalResponseMessage(managedMcpRequest, 'approve'),
  { id: 'mcp-elicitation-1', result: { action: 'accept', content: {} } },
);
const managedMcpEvents = createCodexAppServerAdapter().parseLine(JSON.stringify(managedMcpRequestMessage));
assert.equal(managedMcpEvents.length, 1);
assert.equal(managedMcpEvents[0].type, 'approval_request');
assert.equal(managedMcpEvents[0].reason, 'Continue with the managed action.');

const adapter = createCodexAppServerAdapter();

const approvalEvents = adapter.parseLine(JSON.stringify(approvalRequestMessage));
assert.equal(approvalEvents.length, 1);
assert.equal(approvalEvents[0].type, 'approval_request');
assert.equal(approvalEvents[0].approvalId, 'item/commandExecution/requestApproval:approval-1');
assert.equal(approvalEvents[0].command, 'echo approved');

const argvApprovalEvents = adapter.parseLine(JSON.stringify({
  ...approvalRequestMessage,
  id: 'argv-approval',
  params: { ...approvalRequestMessage.params, command: ['/bin/bash', '-c', 'rm /tmp/a b', ''] },
}));
assert.equal(argvApprovalEvents[0].command, 'argv: ["/bin/bash","-c","rm /tmp/a b",""]');

const mcpStatusEvents = adapter.parseLine(JSON.stringify({
  method: 'mcpServer/startupStatus/updated',
  params: { name: 'agentoc_actions_fixture', status: 'ready', threadId: 'thread-123' },
}));
assert.equal(mcpStatusEvents.length, 1);
assert.equal(mcpStatusEvents[0].codexMcpServer, 'agentoc_actions_fixture');
assert.equal(mcpStatusEvents[0].codexMcpStatus, 'ready');

const mcpInventoryEvents = adapter.parseLine(JSON.stringify(mcpInventoryMessage));
assert.equal(mcpInventoryEvents.length, 1);
assert.equal(mcpInventoryEvents[0].codexMcpStatus, 'inventory');
assert.deepEqual(mcpInventoryEvents[0].codexMcpServers, [{
  name: 'agentoc_actions_fixture',
  toolNames: ['agentoc_request_actions'],
  toolSchemaAvailable: true,
}]);
assert.deepEqual(
  adapter.parseLine(JSON.stringify({
    agentoc_intermediate: true,
    method: 'turn/completed',
    params: { threadId: 'thread-child', turn: { id: 'turn-child', status: 'completed' } },
  })),
  [],
  'delegated-thread lifecycle frames must not complete the parent Run',
);

const completedTurnEvents = adapter.parseLine(JSON.stringify({
  method: 'turn/completed',
  params: {
    threadId: 'thread-123',
    turn: { id: 'turn-abc', status: 'completed', items: [] },
  },
}));
assert.equal(completedTurnEvents[0].content, 'completed');
assert.equal(completedTurnEvents[0].providerThreadId, 'thread-123');
assert.equal(completedTurnEvents[0].providerTurnId, 'turn-abc');
assert.equal(completedTurnEvents[0].providerLifecycle, 'completed');

const interruptedTurnEvents = adapter.parseLine(JSON.stringify({
  method: 'turn/completed',
  params: {
    threadId: 'thread-123',
    turn: { id: 'turn-abc', status: 'interrupted', items: [] },
  },
}));
assert.equal(interruptedTurnEvents[0].content, 'interrupted');
assert.equal(interruptedTurnEvents[0].providerLifecycle, 'interrupted');

const failedTurnEvents = adapter.parseLine(JSON.stringify({
  method: 'turn/completed',
  params: {
    threadId: 'thread-123',
    turn: { id: 'turn-abc', status: 'failed', error: { message: 'provider failed' }, items: [] },
  },
}));
assert.match(failedTurnEvents[0].content, /^error:/);
assert.equal(failedTurnEvents[0].providerLifecycle, 'failed');

const inProgressTurnEvents = adapter.parseLine(JSON.stringify({
  method: 'turn/completed',
  params: {
    threadId: 'thread-123',
    turn: { id: 'turn-abc', status: 'inProgress', items: [] },
  },
}));
assert.notEqual(inProgressTurnEvents[0].content, 'completed');
assert.equal(inProgressTurnEvents[0].providerLifecycle, 'inProgress');

// Sidecar auto-approvals must never surface as user-facing approvals. The
// sidecar echoes its synthetic agentoc.approval_response (autoApproved: true)
// into the stream BEFORE the requestApproval it answers; the adapter tracks
// the id so the later request frame is suppressed too (no card, no push).
const autoApprovalAdapter = createCodexAppServerAdapter();
const autoAckEvents = autoApprovalAdapter.parseLine(JSON.stringify({
  type: 'agentoc.approval_response',
  approvalId: 'item/commandExecution/requestApproval:auto-allowed-1',
  decision: 'approved',
  status: 'approved',
  providerRequestId: 'auto-allowed-1',
  providerMethod: 'item/commandExecution/requestApproval',
  autoApproved: true,
  reason: 'risk safe: in-project read',
}));
assert.equal(autoAckEvents.length, 0, 'auto-approved ack must not emit a response event');
const suppressedRequestEvents = autoApprovalAdapter.parseLine(JSON.stringify({
  ...approvalRequestMessage,
  id: 'auto-allowed-1',
  params: { ...approvalRequestMessage.params, itemId: 'cmd-auto-1', command: 'ls -la' },
}));
assert.equal(suppressedRequestEvents.length, 0, 'requestApproval for an auto-approved id must not emit an approval card');

const autoDenialAdapter = createCodexAppServerAdapter();
assert.equal(autoDenialAdapter.parseLine(JSON.stringify({
  type: 'agentoc.approval_response',
  approvalId: 'item/commandExecution/requestApproval:auto-denied-1',
  decision: 'denied', status: 'denied', providerRequestId: 'auto-denied-1',
  providerMethod: 'item/commandExecution/requestApproval', autoDenied: true,
})).length, 0);
assert.equal(autoDenialAdapter.parseLine(JSON.stringify({
  ...approvalRequestMessage, id: 'auto-denied-1',
})).length, 0, 'automatically denied request must not produce an owner card');

// A request WITHOUT a prior auto-approved ack still surfaces normally (a
// genuinely held approval the user must decide).
const heldAdapter = createCodexAppServerAdapter();
const heldEvents = heldAdapter.parseLine(JSON.stringify(approvalRequestMessage));
assert.equal(heldEvents.length, 1, 'held approval must still surface a card');
assert.equal(heldEvents[0].status, 'pending');

// A real provider ack (no autoApproved flag) still emits its response event —
// only sidecar-synthesized auto-approvals are suppressed.
const realAckEvents = heldAdapter.parseLine(JSON.stringify({
  type: 'agentoc.approval_response',
  approvalId: 'item/commandExecution/requestApproval:approval-1',
  decision: 'approved',
  status: 'approved',
  providerRequestId: 'approval-1',
  providerMethod: 'item/commandExecution/requestApproval',
}));
assert.equal(realAckEvents.length, 1, 'real provider ack must emit a response event');
assert.equal(realAckEvents[0].type, 'approval_response');

const planEvents = adapter.parseLine(JSON.stringify({
  method: 'turn/plan/updated',
  params: {
    threadId: 'thread-123',
    turnId: 'turn-abc',
    explanation: 'Codex plan',
    plan: [
      { step: 'Inspect', status: 'completed' },
      { step: 'Patch', status: 'inProgress' },
      { step: 'Verify', status: 'pending' },
    ],
  },
}));
assert.equal(planEvents.length, 1);
assert.equal(planEvents[0].type, 'plan');
assert.equal(planEvents[0].planId, 'turn-abc');
assert.equal(planEvents[0].title, 'Codex plan');
assert.equal(planEvents[0].state, 'awaiting_decision');
assert.deepEqual(
  planEvents[0].items.map((item) => item.status),
  ['completed', 'in_progress', 'pending'],
);

const planDeltaEvents = adapter.parseLine(JSON.stringify({
  method: 'item/plan/delta',
  params: {
    threadId: 'thread-123',
    turnId: 'turn-abc',
    itemId: 'plan-item',
    delta: '# Plan\n\n',
  },
}));
assert.equal(planDeltaEvents[0].type, 'plan');
assert.equal(planDeltaEvents[0].planId, 'turn-abc');
assert.equal(planDeltaEvents[0].bodyMarkdown, '# Plan');
assert.equal(planDeltaEvents[0].state, 'drafting');

const textDeltaEvents = adapter.parseLine(JSON.stringify({
  method: 'item/agentMessage/delta',
  params: { threadId: 'thread-123', turnId: 'turn-abc', itemId: 'message-1', delta: 'hello' },
}));
assert.equal(textDeltaEvents[0].type, 'text_delta');
assert.equal(textDeltaEvents[0].text, 'hello');
assert.equal(textDeltaEvents[0].providerItemId, 'message-1');
assert.equal(textDeltaEvents[0].providerEventId, 'agent-message:message-1:1');

const secondTextDeltaEvents = adapter.parseLine(JSON.stringify({
  method: 'item/agentMessage/delta',
  params: { threadId: 'thread-123', turnId: 'turn-abc', itemId: 'message-1', delta: '!' },
}));
assert.equal(secondTextDeltaEvents[0].providerEventId, 'agent-message:message-1:2');

const threadStatusEvents = adapter.parseLine(JSON.stringify({
  method: 'thread/status/changed',
  params: {
    threadId: 'thread-123',
    status: {
      type: 'active',
      activeFlags: ['waiting_for_input'],
    },
  },
}));
assert.equal(threadStatusEvents.length, 1);
assert.equal(threadStatusEvents[0].type, 'status');
assert.equal(threadStatusEvents[0].content, 'active (waiting_for_input)');
assert.equal(threadStatusEvents[0].providerThreadId, 'thread-123');

const threadStatusWithoutFlagsEvents = adapter.parseLine(JSON.stringify({
  method: 'thread/status/changed',
  params: {
    threadId: 'thread-456',
    status: {
      type: 'active',
      activeFlags: [],
    },
  },
}));
assert.equal(threadStatusWithoutFlagsEvents.length, 1);
assert.equal(threadStatusWithoutFlagsEvents[0].content, 'active');

const planItemEvents = adapter.parseLine(JSON.stringify({
  method: 'item/completed',
  params: {
    threadId: 'thread-123',
    turnId: 'turn-abc',
    item: {
      type: 'plan',
      id: 'plan-item',
      text: '# Plan\n\n1. Inspect\n2. Patch',
    },
  },
}));
assert.equal(planItemEvents[0].type, 'plan');
assert.equal(planItemEvents[0].source, 'codex-app-server');
assert.equal(planItemEvents[0].state, 'awaiting_decision');
assert.match(planItemEvents[0].bodyMarkdown, /Inspect/);

const agentMessageEvents = adapter.parseLine(JSON.stringify({
  method: 'item/completed',
  params: {
    threadId: 'thread-123',
    turnId: 'turn-abc',
    item: {
      type: 'agentMessage',
      id: 'msg-1',
      text: 'Done.',
      status: 'completed',
    },
  },
}));
assert.equal(agentMessageEvents.length, 1);
assert.equal(agentMessageEvents[0].type, 'message');
assert.equal(agentMessageEvents[0].providerMessageId, 'msg-1');

const deltaOnlyAgentMessageAdapter = createCodexAppServerAdapter();
deltaOnlyAgentMessageAdapter.parseLine(JSON.stringify({
  method: 'item/agentMessage/delta',
  params: { threadId: 'thread-empty-final', turnId: 'turn-empty-final', itemId: 'msg-empty-final', delta: 'Visible while streaming.' },
}));
deltaOnlyAgentMessageAdapter.parseLine(JSON.stringify({
  method: 'item/agentMessage/delta',
  params: { threadId: 'thread-empty-final', turnId: 'turn-empty-final', itemId: 'msg-empty-final', delta: ' Still durable after completion.' },
}));
const recoveredEmptyFinalEvents = deltaOnlyAgentMessageAdapter.parseLine(JSON.stringify({
  method: 'item/completed',
  params: {
    threadId: 'thread-empty-final',
    turnId: 'turn-empty-final',
    item: { type: 'agentMessage', id: 'msg-empty-final', text: '' },
  },
}));
assert.equal(recoveredEmptyFinalEvents.length, 1, 'an empty completion must publish the streamed reply');
assert.equal(recoveredEmptyFinalEvents[0].type, 'message');
assert.equal(recoveredEmptyFinalEvents[0].content, 'Visible while streaming. Still durable after completion.');
assert.equal(recoveredEmptyFinalEvents[0].providerMessageId, 'msg-empty-final');

const commandEvents = adapter.parseLine(JSON.stringify({
  method: 'item/completed',
  params: {
    item: {
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'ls',
      status: 'completed',
      aggregatedOutput: 'package.json\n',
      exitCode: 0,
    },
  },
}));
assert.equal(commandEvents[0].type, 'tool_use');
assert.equal(commandEvents[1].type, 'tool_result');
assert.equal(commandEvents[1].output, 'package.json\n');
assert.equal(commandEvents[0].providerItemId, 'cmd-1');
assert.equal(commandEvents[0].providerToolUseId, 'cmd-1');
assert.equal(commandEvents[0].operationLifecycle, 'completed');
assert.equal(commandEvents[1].providerItemId, 'cmd-1');
assert.equal(commandEvents[1].operationKind, 'command');

const commandOutputDeltaEvents = adapter.parseLine(JSON.stringify({
  method: 'item/commandExecution/outputDelta',
  params: {
    threadId: 'thread-123',
    turnId: 'turn-abc',
    itemId: 'cmd-1',
    stream: 'stdout',
    delta: 'package.json\n',
  },
}));
assert.equal(commandOutputDeltaEvents.length, 1);
assert.equal(commandOutputDeltaEvents[0].type, 'tool_result');
assert.equal(commandOutputDeltaEvents[0].providerItemId, 'cmd-1');
assert.equal(commandOutputDeltaEvents[0].providerThreadId, 'thread-123');
assert.equal(commandOutputDeltaEvents[0].providerTurnId, 'turn-abc');
assert.equal(commandOutputDeltaEvents[0].operationLifecycle, 'delta');
assert.equal(commandOutputDeltaEvents[0].operationStream, 'stdout');

const appServerStartedFileChangeEvents = adapter.parseLine(JSON.stringify({
  method: 'item/started',
  params: {
    item: {
      type: 'fileChange',
      id: 'file-change-1',
      status: 'inProgress',
      changes: [{
        path: '/tmp/app-server.js',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1,1 +1,1 @@\n-old\n+new\n',
      }],
    },
  },
}));
assert.equal(appServerStartedFileChangeEvents.length, 1);
assert.equal(appServerStartedFileChangeEvents[0].type, 'tool_use');
assert.equal(appServerStartedFileChangeEvents[0].operationKind, 'file_edit');
assert.equal(appServerStartedFileChangeEvents[0].operationLifecycle, 'started');
assert.equal(
  appServerStartedFileChangeEvents.some((event) => event.type === 'file_change'),
  false,
  'app-server in-progress fileChange items should start a live operation without creating a Review entry',
);

const appServerFileChangeEvents = adapter.parseLine(JSON.stringify({
  method: 'item/completed',
  params: {
    item: {
      type: 'fileChange',
      id: 'file-change-1',
      status: 'completed',
      changes: [{
        path: '/tmp/app-server.js',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n',
      }],
    },
  },
}));
assert.equal(appServerFileChangeEvents.length, 1);
assert.equal(appServerFileChangeEvents[0].type, 'file_change');
assert.equal(appServerFileChangeEvents[0].filePath, '/tmp/app-server.js');
assert.equal(appServerFileChangeEvents[0].changeType, 'update');
assert.equal(appServerFileChangeEvents[0].added, 2);
assert.equal(appServerFileChangeEvents[0].removed, 1);
assert.equal(appServerFileChangeEvents[0].preview[0].oldLine, 2);
assert.equal(appServerFileChangeEvents[0].preview[2].newLine, 3);
assert.equal(appServerFileChangeEvents[0].providerItemId, 'file-change-1');
assert.equal(appServerFileChangeEvents[0].operationLifecycle, 'completed');

// --- codex goal mode: builders + readers ---

const goalSet = buildCodexAppServerThreadGoalSetMessage({
  id: 1000,
  threadId: 'thread-123',
  objective: 'Clean up the imports folder',
  tokenBudget: 25000,
});
assert.equal(goalSet.method, 'threadGoal/set');
assert.equal(goalSet.id, 1000);
assert.equal(goalSet.params.threadId, 'thread-123');
assert.equal(goalSet.params.objective, 'Clean up the imports folder');
assert.equal(goalSet.params.tokenBudget, 25000);

const goalSetNoBudget = buildCodexAppServerThreadGoalSetMessage({
  id: 1001,
  threadId: 'thread-123',
  objective: 'Just an objective',
});
assert.equal(goalSetNoBudget.params.tokenBudget, undefined);

assert.equal(
  buildCodexAppServerThreadGoalSetMessage({ id: 1002, threadId: '', objective: 'x' }),
  null,
  'set without threadId returns null',
);
assert.equal(
  buildCodexAppServerThreadGoalSetMessage({ id: 1003, threadId: 'thread-123', objective: '  ' }),
  null,
  'set without objective returns null',
);
const goalSetNegativeBudget = buildCodexAppServerThreadGoalSetMessage({
  id: 1004,
  threadId: 'thread-123',
  objective: 'x',
  tokenBudget: -5,
});
assert.equal(
  goalSetNegativeBudget.params.tokenBudget,
  undefined,
  'non-positive budget is dropped (no tokenBudget key)',
);

const goalGet = buildCodexAppServerThreadGoalGetMessage({ id: 1005, threadId: 'thread-123' });
assert.equal(goalGet.method, 'threadGoal/get');
assert.equal(goalGet.params.threadId, 'thread-123');
assert.equal(buildCodexAppServerThreadGoalGetMessage({ id: 1006, threadId: '' }), null);

const goalClear = buildCodexAppServerThreadGoalClearMessage({ id: 1007, threadId: 'thread-123' });
assert.equal(goalClear.method, 'threadGoal/clear');
assert.equal(goalClear.params.threadId, 'thread-123');
assert.equal(buildCodexAppServerThreadGoalClearMessage({ id: 1008, threadId: '' }), null);

const goalFields = readCodexAppServerGoalFields({
  objective: 'Ship the report',
  status: 'in_progress',
  tokenBudget: 50000,
  tokensUsed: 12300,
  timeUsedSeconds: 42,
  createdAt: '2026-08-06T00:00:00Z',
  updatedAt: '2026-08-06T00:05:00Z',
});
assert.deepEqual(goalFields, {
  objective: 'Ship the report',
  status: 'in_progress',
  tokenBudget: 50000,
  tokensUsed: 12300,
  timeUsedSeconds: 42,
  createdAt: '2026-08-06T00:00:00Z',
  updatedAt: '2026-08-06T00:05:00Z',
});
assert.deepEqual(
  readCodexAppServerGoalFields({ objective: 'x', token_budget: 10, tokens_used: 3, time_used_seconds: 1 }),
  { objective: 'x', status: '', tokenBudget: 10, tokensUsed: 3, timeUsedSeconds: 1, createdAt: '', updatedAt: '' },
  'snake_case fallbacks are accepted',
);
assert.equal(readCodexAppServerGoalFields({}), null, 'no objective and no status -> null');
assert.equal(readCodexAppServerGoalFields(null), null);

assert.equal(
  readCodexAppServerGoalPayload({ params: { threadId: 't', goal: { objective: 'x' } } }).objective,
  'x',
  'payload reader prefers params.goal',
);
assert.equal(
  readCodexAppServerGoalPayload({ result: { objective: 'from-get' } }).objective,
  'from-get',
  'payload reader uses result for get responses',
);

// --- codex goal mode: adapter notification parsing (enriched) ---

const goalUpdatedEvents = adapter.parseLine(JSON.stringify({
  method: 'thread/goal/updated',
  params: {
    threadId: 'thread-123',
    goal: {
      objective: 'Process the weekly invoices',
      status: 'in_progress',
      tokenBudget: 30000,
      tokensUsed: 9000,
      timeUsedSeconds: 120,
      updatedAt: '2026-08-06T00:05:00Z',
    },
  },
}));
assert.equal(goalUpdatedEvents.length, 1);
assert.equal(goalUpdatedEvents[0].type, 'status');
assert.equal(goalUpdatedEvents[0].codexGoalEvent, 'updated');
assert.equal(goalUpdatedEvents[0].codexGoalObjective, 'Process the weekly invoices');
assert.equal(goalUpdatedEvents[0].codexGoalStatus, 'in_progress');
assert.equal(goalUpdatedEvents[0].codexGoalTokenBudget, 30000);
assert.equal(goalUpdatedEvents[0].codexGoalTokensUsed, 9000);
assert.equal(goalUpdatedEvents[0].codexGoalTimeUsedSeconds, 120);
assert.equal(goalUpdatedEvents[0].codexGoalUpdatedAt, '2026-08-06T00:05:00Z');
assert.match(goalUpdatedEvents[0].content, /Process the weekly invoices/);

const goalUpdatedNoFieldsEvents = adapter.parseLine(JSON.stringify({
  method: 'thread/goal/updated',
  params: { threadId: 'thread-123', goal: {} },
}));
assert.equal(goalUpdatedNoFieldsEvents.length, 0, 'goal update without objective/status yields no event');

const goalClearedEvents = adapter.parseLine(JSON.stringify({
  method: 'thread/goal/cleared',
  params: { threadId: 'thread-123' },
}));
assert.equal(goalClearedEvents.length, 1);
assert.equal(goalClearedEvents[0].type, 'status');
assert.equal(goalClearedEvents[0].codexGoalEvent, 'cleared');
assert.equal(goalClearedEvents[0].providerThreadId, 'thread-123');

console.log('test-codex-app-server-adapter: ok');
