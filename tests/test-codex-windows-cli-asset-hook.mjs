import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCodexWindowsCliAssetHookDecision, verifyCodexWindowsCliAssetApproval, buildCodexWindowsTriggerHookDecision, verifyCodexWindowsTriggerApproval } from '../chat/codex-windows-cli-asset-hook.mjs';
import { resolveWindowsSystemPaths } from '../chat/windows-system-paths.mjs';

const helperPath = process.env.AGENTOC_TEST_CLI_READ_BINARY;
if (process.platform !== 'win32' || !helperPath) { console.log('codex-windows-cli-asset-hook: skipped (opt-in Windows fixture)'); process.exit(0); }
const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-codex-asset-'));
try {
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const file = path.join(root, 'outside.txt'); await writeFile(file, 'fixture');
  const runId = 'fixture-run'; const port = 7690;
  const state = { riskMode: 'recommended', riskContextValid: true, startedTurn: true, threadId: 'thread', turnId: 'turn',
    sessionControlReadAvailable: true, sessionControlReadRunId: runId,
    riskContext: { platform: 'win32', trustedWorkspaceRoot: workspace, protectedRoots: [] } };
  const body = JSON.stringify({ localPath: file, originalName: 'outside.txt' });
  const command = `ragent api POST "/api/sessions/$env:AGENTOC_SESSION_ID/assets" --body '${body}'`;
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'item', cwd: workspace, tool_input: { command } };
  const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
  for (const riskMode of ['recommended', 'full-auto']) {
    const current = { ...state, riskMode };
    const decision = await buildCodexWindowsCliAssetHookDecision({ event, state: current, runId, helperPath, port });
    assert.equal(decision.hookSpecificOutput?.permissionDecision, 'allow');
    const unquotedEvent = { ...event, tool_input: { command: command.replace('"/api/sessions/$env:AGENTOC_SESSION_ID/assets"', '/api/sessions/$env:AGENTOC_SESSION_ID/assets') } };
    const unquoted = await buildCodexWindowsCliAssetHookDecision({ event: unquotedEvent, state: current, runId, helperPath, port });
    assert.deepEqual(unquoted, decision);

    const replacement = decision.hookSpecificOutput.updatedInput.command;
    const wrapper = [resolveWindowsSystemPaths().powershell, '-NoProfile', '-Command', replacement].map(quote).join(' ');
    const approval = { kind: 'command', providerMethod: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', cwd: workspace, command: wrapper } };
    assert.equal(await verifyCodexWindowsCliAssetApproval({ approval, state: current, runId, helperPath, port }), true);
    for (const changed of [
      { approval: { ...approval, params: { ...approval.params, turnId: 'other' } } },
      { approval: { ...approval, params: { ...approval.params, additionalPermissions: { network: true } } } },
      { approval: { ...approval, params: { ...approval.params, command: wrapper + '; evil' } } },
      { state: { ...current, sessionControlReadAvailable: false } }, { runId: 'other' }, { port: 7691 },
    ]) assert.equal(await verifyCodexWindowsCliAssetApproval({ approval, state: current, runId, helperPath, port, ...changed }), false);
    const triggerEvent = { ...event, tool_input: { command: "ragent trigger create --in 1h --text 'fixture follow-up' --json" } };
    const trigger = await buildCodexWindowsTriggerHookDecision({ event: triggerEvent, state: current, runId, helperPath, port });
    assert.equal(trigger.hookSpecificOutput?.permissionDecision, 'allow');
    const triggerWrapper = [resolveWindowsSystemPaths().powershell, '-NoProfile', '-Command', trigger.hookSpecificOutput.updatedInput.command].map(quote).join(' ');
    const triggerApproval = { ...approval, params: { ...approval.params, command: triggerWrapper } };
    assert.equal(await verifyCodexWindowsTriggerApproval({ approval: triggerApproval, state: current, runId, helperPath, port }), true);
    assert.equal(await verifyCodexWindowsTriggerApproval({ approval: { ...triggerApproval, params: { ...triggerApproval.params, turnId: 'other' } }, state: current, runId, helperPath, port }), false);
    assert.equal(await verifyCodexWindowsTriggerApproval({ approval: triggerApproval, state: { ...current, sessionControlReadAvailable: false }, runId, helperPath, port }), false);
    for (const command of ['ragent trigger --help', 'agentoc trigger list --json']) {
      const read = await buildCodexWindowsTriggerHookDecision({ event: { ...event, tool_input: { command } }, state: current, runId, helperPath, port });
      assert.equal(read.hookSpecificOutput?.permissionDecision, 'allow');
      const wrapper = [resolveWindowsSystemPaths().powershell, '-NoProfile', '-Command', read.hookSpecificOutput.updatedInput.command].map(quote).join(' ');
      const readApproval = { ...approval, params: { ...approval.params, command: wrapper } };
      assert.equal(await verifyCodexWindowsTriggerApproval({ approval: readApproval, state: current, runId, helperPath, port }), true);
      assert.equal(await verifyCodexWindowsTriggerApproval({ approval: { ...readApproval, params: { ...readApproval.params, command: wrapper + '; evil' } }, state: current, runId, helperPath, port }), false);
    }

    assert.deepEqual(await buildCodexWindowsTriggerHookDecision({ event: { ...triggerEvent, tool_input: { command: triggerEvent.tool_input.command + ' --session other' } }, state: current, runId, helperPath, port }), {});
  }
  for (const changed of [
    command.replace('$env:AGENTOC_SESSION_ID', 'other'), command + '; Remove-Item file',
    command.replace('--body', '--body-file'), command.replace('POST', 'DELETE'), command.replace(' api ', '\napi '),
  ]) assert.deepEqual(await buildCodexWindowsCliAssetHookDecision({ event: { ...event, tool_input: { command: changed } }, state, runId, helperPath, port }), {});
  console.log('codex-windows-cli-asset-hook: scoped rewrite and independent approval verification passed');
} finally { await rm(root, { recursive: true, force: true }); }
