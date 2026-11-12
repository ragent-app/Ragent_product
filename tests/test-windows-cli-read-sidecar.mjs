import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') { console.log('windows-cli-read-sidecar: skipped (requires Windows)'); process.exit(0); }
const helper = process.env.AGENTOC_TEST_CLI_READ_BINARY;
if (!path.isAbsolute(helper || '')) throw new Error('absolute CLI read helper path required');
const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-cli-read-sidecar-'));
process.env.AGENTOC_INSTANCE_ROOT = path.join(root, 'instance');
process.env.AGENTOC_CONFIG_DIR = path.join(root, 'instance', 'config');
process.env.AGENTOC_WORK_ROOT_DIR = path.join(root, 'instance', 'workspace');
process.env.AGENTOC_MEMORY_DIR = path.join(root, 'instance', 'memory');
process.env.AGENTOC_RUN_SPOOL_DIR = path.join(root, 'instance', 'data', 'chat-runs');
try {
  const { createRun, getRun, readRunSpoolRecords } = await import('../chat/runs.mjs');
  const { trackClaudeBidiApprovalRequest } = await import('../chat/runner-sidecar.mjs');
  for (const riskMode of ['recommended', 'full-auto']) {
    const run = await createRun({ status: { sessionId: 'fixture', requestId: 'request', state: 'running', tool: 'claude' },
      manifest: { sessionId: 'fixture', requestId: 'request', folder: root, tool: 'claude', runtimeFamily: 'claude-stream-json-bidi', prompt: 'fixture', options: {} } });
    const state = { riskMode, permissionMode: 'default', cwd: root, projectRoot: root, turnActive: true, riskContextValid: true,
      sessionControlReadAvailable: true, sessionControlReadRunId: run.id,
      riskContext: { platform: 'win32', trustedWorkspaceRoot: root },
      pendingApprovals: new Map(), autoApprovedMcpRequestIds: new Set() };
    const cases = [
      ['agentoc trigger list --json 2>&1 | Out-String', 'trigger-list', true],
      ['node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list --json | Out-String', 'trigger-list', true],
      ['node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list --session $env:AGENTOC_SESSION_ID --json | Out-String', 'trigger-list', true],
      ['node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list --source-session $env:AGENTOC_SESSION_ID --json | Out-String', 'trigger-list', true],
      ['node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list --help | Out-String', 'trigger-help', false],
    ];
    for (const [index, [command, action, json]] of cases.entries()) {
      const request = { type: 'control_request', request_id: `fixture-${riskMode}-${index}`, request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command } } };
      let sent = '';
      const child = { stdin: { writable: true, write(value) { sent += value; } } };
      await trackClaudeBidiApprovalRequest(run.id, state, request, child, { cliReadHelperPath: helper });
      const response = JSON.parse(sent);
      assert.equal(response.response.response.behavior, 'allow');
      assert.ok(response.response.response.updatedInput.command.startsWith(`& '${helper.replaceAll("'", "''")}' ${action} `));
      assert.match(response.response.response.updatedInput.command, json ? /'http:\/\/127\.0\.0\.1:\d+' --json$/ : /'http:\/\/127\.0\.0\.1:\d+'$/);
    }
    const spool = await readRunSpoolRecords(run.id);
    assert.ok(spool.some(item => item.json?.autoApproved === true && item.json?.reason === 'controlled read-only CLI operation'));
    assert.ok(!(await getRun(run.id)).appServerPendingApprovals?.some(item => item.state !== 'responded'));
  }
  console.log('windows-cli-read-sidecar: Claude approvals rewritten and audited for both modes');
} finally {
  if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('agentoc-cli-read-sidecar-')) throw new Error('unsafe fixture cleanup');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
