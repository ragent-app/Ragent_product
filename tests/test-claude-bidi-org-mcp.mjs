#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'ragent-claude-bidi-org-mcp-'));
const instanceRoot = path.join(root, 'instance');
process.env.RAGENT_INSTANCE_ROOT = instanceRoot;
process.env.RAGENT_CONFIG_DIR = path.join(instanceRoot, 'config');
process.env.RAGENT_WORK_ROOT_DIR = path.join(instanceRoot, 'workspace');
process.env.RAGENT_MEMORY_DIR = path.join(instanceRoot, 'memory');
process.env.RAGENT_PROVIDER_HOMES_DIR = path.join(instanceRoot, 'provider-homes');
process.env.RAGENT_RUN_SPOOL_DIR = path.join(instanceRoot, 'data', 'chat-runs');

const { createRun, getRun, readRunSpoolRecords } = await import('../chat/runs.mjs');
const { trackClaudeBidiApprovalRequest } = await import('../chat/runner-sidecar.mjs');

async function createFixtureRun(name) {
  return createRun({
    status: { sessionId: `fixture-${name}`, requestId: `request-${name}`, state: 'accepted', tool: 'claude-bidi' },
    manifest: {
      sessionId: `fixture-${name}`,
      requestId: `request-${name}`,
      folder: root,
      tool: 'claude-bidi',
      runtimeFamily: 'claude-stream-json-bidi',
      prompt: 'root org mcp fixture',
      options: {},
    },
  });
}

function claudeMcpRequest(requestId, serverName, toolName, extra = {}) {
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: `mcp__${serverName}__${toolName}`,
      input: { action: 'swarm.status' },
      ...extra,
    },
  };
}

function captureProcess() {
  const responses = [];
  return {
    responses,
    proc: {
      stdin: {
        writable: true,
        write(value) {
          responses.push(JSON.parse(value));
          return true;
        },
      },
    },
  };
}

function makeRootState({
  riskMode,
  mcpRequired = false,
  mcpRequiredServers = [],
  optionalOrgServer = 'ragent_org_abc12345',
  autoApproveServers = [optionalOrgServer],
  turnActive = true,
} = {}) {
  return {
    riskMode,
    cwd: root,
    riskContextValid: true,
    riskContext: { trustedWorkspaceRoot: root },
    turnActive,
    approvalTurnSequence: 1,
    requestId: 'req-root-org-mcp',
    approvalProcessId: process.pid,
    pendingApprovals: new Map(),
    autoApprovedMcpRequestIds: new Set(),
    mcpRequired,
    mcpRequiredServers,
    mcpOptionalOrganizationServerName: optionalOrgServer,
    mcpAutoApproveServerNames: new Set(autoApproveServers.filter(Boolean)),
  };
}

try {
  // 1. Root full-auto with mcpRequired === false must auto-approve root optional organization MCP tools.
  {
    const run = await createFixtureRun('full-auto-org');
    const state = makeRootState({ riskMode: 'full-auto', mcpRequired: false, mcpRequiredServers: [] });
    const capture = captureProcess();
    await trackClaudeBidiApprovalRequest(
      run.id, state, claudeMcpRequest('org-read-fa', 'ragent_org_abc12345', 'ragent_organization_read'), capture.proc,
    );
    await trackClaudeBidiApprovalRequest(
      run.id, state, claudeMcpRequest('org-act-fa', 'ragent_org_abc12345', 'ragent_organization_action'), capture.proc,
    );
    assert.equal(capture.responses.length, 2);
    assert.equal(capture.responses[0].response?.response?.behavior, 'allow');
    assert.equal(capture.responses[1].response?.response?.behavior, 'allow');
    assert.equal(state.pendingApprovals.size, 0);
    assert.equal((await getRun(run.id)).appServerPendingApprovals?.length || 0, 0);
    const spool = await readRunSpoolRecords(run.id);
    const gateReasons = spool
      .filter((r) => r.json?.type === 'ragent.approval_decision')
      .map((r) => r.json?.reasonCode);
    assert.deepEqual(gateReasons, ['managed_mcp_optional_organization_tool', 'managed_mcp_optional_organization_tool']);
  }

  // 2. Root recommended with required actions MCP + optional root organization MCP must auto-approve both.
  {
    const run = await createFixtureRun('recommended-org');
    const state = makeRootState({
      riskMode: 'recommended',
      mcpRequired: true,
      mcpRequiredServers: [{ name: 'ragent_act_abc12345', requiredToolNames: ['ragent_request_actions'] }],
      optionalOrgServer: 'ragent_org_abc12345',
      autoApproveServers: ['ragent_act_abc12345', 'ragent_org_abc12345'],
    });
    const capture = captureProcess();
    await trackClaudeBidiApprovalRequest(
      run.id, state, claudeMcpRequest('org-read-rec', 'ragent_org_abc12345', 'ragent_organization_read'), capture.proc,
    );
    await trackClaudeBidiApprovalRequest(
      run.id, state, claudeMcpRequest('org-act-rec', 'ragent_org_abc12345', 'ragent_organization_action'), capture.proc,
    );
    await trackClaudeBidiApprovalRequest(
      run.id, state, claudeMcpRequest('act-rec', 'ragent_act_abc12345', 'ragent_request_actions'), capture.proc,
    );
    assert.equal(capture.responses.length, 3);
    for (const res of capture.responses) {
      assert.equal(res.response?.response?.behavior, 'allow');
    }
    assert.equal(state.pendingApprovals.size, 0);
    const spool = await readRunSpoolRecords(run.id);
    const gateReasons = spool
      .filter((r) => r.json?.type === 'ragent.approval_decision')
      .map((r) => r.json?.reasonCode);
    assert.deepEqual(gateReasons, [
      'managed_mcp_optional_organization_tool',
      'managed_mcp_optional_organization_tool',
      'managed_mcp_binding',
    ]);
  }

  // 3. Negative guards: unknown tool, unapproved server, foreign server, and permission expansion must NOT auto-approve.
  {
    const run = await createFixtureRun('org-negative-guards');
    const state = makeRootState({
      riskMode: 'recommended',
      mcpRequired: false,
      optionalOrgServer: 'ragent_org_abc12345',
      autoApproveServers: ['ragent_org_abc12345'],
    });
    const capture = captureProcess();
    await trackClaudeBidiApprovalRequest(
      run.id, state, claudeMcpRequest('bad-tool', 'ragent_org_abc12345', 'unexpected_tool'), capture.proc,
    );
    await trackClaudeBidiApprovalRequest(
      run.id, state, claudeMcpRequest('foreign-srv', 'ragent_org_other999', 'ragent_organization_read'), capture.proc,
    );
    assert.equal(capture.responses.length, 0, 'guarded org MCP edge cases must stay user-gated in recommended');
    assert.equal(state.pendingApprovals.size, 2);

    const expandCapture = captureProcess();
    await trackClaudeBidiApprovalRequest(
      run.id,
      state,
      claudeMcpRequest('expand-perm', 'ragent_org_abc12345', 'ragent_organization_read', {
        input: { action: 'swarm.status', dangerouslyDisableSandbox: true },
      }),
      expandCapture.proc,
    );
    assert.ok(
      expandCapture.responses.every((res) => res.response?.response?.behavior !== 'allow'),
      'permission-expanding org MCP request must never auto-approve',
    );

    const notAutoRun = await createFixtureRun('org-not-in-allowlist');
    const notAutoState = makeRootState({
      riskMode: 'full-auto',
      mcpRequired: false,
      optionalOrgServer: 'ragent_org_abc12345',
      autoApproveServers: [],
    });
    const notAutoCapture = captureProcess();
    await trackClaudeBidiApprovalRequest(
      notAutoRun.id,
      notAutoState,
      claudeMcpRequest('org-not-allowlisted', 'ragent_org_abc12345', 'ragent_organization_read'),
      notAutoCapture.proc,
    );
    assert.equal(notAutoCapture.responses.length, 1);
    assert.equal(notAutoCapture.responses[0].response?.response?.behavior, 'deny');
  }

  process.stdout.write('test-claude-bidi-org-mcp: ok\n');
} finally {
  const target = path.resolve(root);
  const parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(target).toLowerCase(), parent.toLowerCase());
  assert.ok(path.basename(target).startsWith('ragent-claude-bidi-org-mcp-'));
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
