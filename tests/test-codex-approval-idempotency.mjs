#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-codex-approval-idempotency-'));
const instanceRoot = path.join(root, 'instance');
process.env.AGENTOC_INSTANCE_ROOT = instanceRoot;
process.env.AGENTOC_CONFIG_DIR = path.join(instanceRoot, 'config');
process.env.AGENTOC_WORK_ROOT_DIR = path.join(instanceRoot, 'workspace');
process.env.AGENTOC_MEMORY_DIR = path.join(instanceRoot, 'memory');
process.env.AGENTOC_PROVIDER_HOMES_DIR = path.join(instanceRoot, 'provider-homes');
process.env.AGENTOC_RUN_SPOOL_DIR = path.join(instanceRoot, 'data', 'chat-runs');

const { createRun, getRun } = await import('../chat/runs.mjs');
const { trackClaudeBidiApprovalRequest, trackCodexAppServerApprovalRequest } = await import('../chat/runner-sidecar.mjs');

async function createFixtureRun(name) {
  return createRun({
    status: { sessionId: `fixture-${name}`, requestId: `request-${name}`, state: 'accepted', tool: 'codex' },
    manifest: {
      sessionId: `fixture-${name}`,
      requestId: `request-${name}`,
      folder: root,
      tool: 'codex',
      runtimeFamily: 'codex-app-server-json',
      prompt: 'approval replay fixture',
      options: {},
    },
  });
}

function mcpApproval(id, serverName, threadId, turnId) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId,
      turnId,
      serverName,
      mode: 'form',
      _meta: { codex_approval_kind: 'mcp_tool_call' },
      requestedSchema: { type: 'object', properties: {}, required: [] },
    },
  };
}

function makeState({ riskMode = 'recommended', autoApproveServer = true, threadId, turnId }) {
  return {
    riskMode,
    cwd: root,
    riskContextValid: true,
    riskContext: { trustedWorkspaceRoot: root },
    threadId,
    turnId,
    pendingApprovals: new Map(),
    activeItems: new Map(),
    autoApprovedMcpRequestIds: new Set(),
    startedTurn: true,
    mcpRequired: true,
    mcpAutoApproveServerNames: new Set(autoApproveServer ? ['agentoc_actions'] : []),
  };
}

function captureProcess() {
  const responses = [];
  return {
    responses,
    proc: { stdin: { writable: true, write(value) { responses.push(JSON.parse(value)); return true; } } },
  };
}

try {
  const managedRun = await createFixtureRun('managed-replay');
  const managedState = makeState({ threadId: 'thread-managed', turnId: 'turn-managed' });
  const managedRequest = mcpApproval(41, 'agentoc_actions', managedState.threadId, managedState.turnId);
  const managedCapture = captureProcess();
  await trackCodexAppServerApprovalRequest(managedRun.id, managedState, managedRequest, managedCapture.proc);
  await trackCodexAppServerApprovalRequest(managedRun.id, managedState, managedRequest, managedCapture.proc);
  assert.equal(managedCapture.responses.length, 1, 'managed MCP replay must not be answered twice');
  assert.equal(managedState.pendingApprovals.size, 0, 'managed MCP replay must not become a user approval');
  assert.equal((await getRun(managedRun.id)).appServerPendingApprovals?.length || 0, 0);

  const promptRun = await createFixtureRun('prompt-replay');
  const promptState = makeState({ autoApproveServer: false, threadId: 'thread-prompt', turnId: 'turn-prompt' });
  const promptRequest = mcpApproval(42, 'unknown_server', promptState.threadId, promptState.turnId);
  const promptCapture = captureProcess();
  await trackCodexAppServerApprovalRequest(promptRun.id, promptState, promptRequest, promptCapture.proc);
  await trackCodexAppServerApprovalRequest(promptRun.id, promptState, promptRequest, promptCapture.proc);
  const promptRunState = await getRun(promptRun.id);
  assert.equal(promptCapture.responses.length, 0, 'unknown MCP requests must remain user gated');
  assert.equal(promptRunState.appServerPendingApprovals?.length, 1, 'replayed owner request must produce one card');

  const denyRun = await createFixtureRun('deny-replay');
  const denyState = makeState({ riskMode: 'full-auto', autoApproveServer: false, threadId: 'thread-deny', turnId: 'turn-deny' });
  const denyRequest = mcpApproval(43, 'unknown_server', denyState.threadId, denyState.turnId);
  const denyCapture = captureProcess();
  await trackCodexAppServerApprovalRequest(denyRun.id, denyState, denyRequest, denyCapture.proc);
  await trackCodexAppServerApprovalRequest(denyRun.id, denyState, denyRequest, denyCapture.proc);
  assert.equal(denyCapture.responses.length, 1, 'unattended denial replay must not be answered twice');
  assert.equal(denyCapture.responses[0].result.action, 'decline');
  assert.equal((await getRun(denyRun.id)).appServerPendingApprovals?.length || 0, 0);

  const claudeAutoRun = await createFixtureRun('claude-auto-replay');
  const claudeAutoState = {
    riskMode: 'recommended', cwd: root, riskContextValid: true,
    pendingApprovals: new Map(), autoApprovedMcpRequestIds: new Set(),
  };
  const claudeAutoRequest = {
    type: 'control_request', request_id: 'skill-replay',
    request: { subtype: 'can_use_tool', tool_name: 'Skill', input: { skill: 'example' } },
  };
  const claudeAutoCapture = captureProcess();
  await trackClaudeBidiApprovalRequest(claudeAutoRun.id, claudeAutoState, claudeAutoRequest, claudeAutoCapture.proc);
  await trackClaudeBidiApprovalRequest(claudeAutoRun.id, claudeAutoState, claudeAutoRequest, claudeAutoCapture.proc);
  assert.equal(claudeAutoCapture.responses.length, 1, 'Claude automatic response replay must be idempotent');

  const claudePromptRun = await createFixtureRun('claude-prompt-replay');
  const claudePromptState = {
    riskMode: 'recommended', cwd: root, riskContextValid: true,
    pendingApprovals: new Map(), autoApprovedMcpRequestIds: new Set(),
  };
  const claudePromptRequest = {
    type: 'control_request', request_id: 'mcp-replay',
    request: { subtype: 'can_use_tool', tool_name: 'mcp__unknown__tool', input: {} },
  };
  const claudePromptCapture = captureProcess();
  await trackClaudeBidiApprovalRequest(claudePromptRun.id, claudePromptState, claudePromptRequest, claudePromptCapture.proc);
  await trackClaudeBidiApprovalRequest(claudePromptRun.id, claudePromptState, claudePromptRequest, claudePromptCapture.proc);
  assert.equal(claudePromptCapture.responses.length, 0, 'unknown Claude MCP requests must remain user gated');
  assert.equal((await getRun(claudePromptRun.id)).appServerPendingApprovals?.length, 1, 'replayed Claude request must produce one card');

  process.stdout.write('test-codex-approval-idempotency: ok\n');
} finally {
  const target = path.resolve(root);
  const parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(target).toLowerCase(), parent.toLowerCase(), 'fixture cleanup must stay inside the temp parent');
  assert.ok(path.basename(target).startsWith('agentoc-codex-approval-idempotency-'));
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
