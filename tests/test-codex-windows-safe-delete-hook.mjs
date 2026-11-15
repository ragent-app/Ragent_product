import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCodexWindowsSafeDeleteHookDecision, verifyCodexWindowsSafeDeleteApproval } from '../chat/codex-windows-safe-delete-hook.mjs';
import { resolveWindowsSystemPaths } from '../chat/windows-system-paths.mjs';

const helperPath = process.env.RAGENT_TEST_SAFE_DELETE_BINARY;
if (process.platform !== 'win32' || !helperPath) { console.log('codex-windows-safe-delete-hook: skipped (opt-in Windows fixture)'); process.exit(0); }
const root = await mkdtemp(path.join(os.tmpdir(), 'ragent-codex-delete-'));
const alternate = path.join(root, 'alternate'), target = path.join(root, 'build');
await mkdir(alternate); await mkdir(target); await writeFile(path.join(target, 'file'), 'fixture');
const runId = 'fixture-run', itemId = 'item-1';
const state = { riskMode: 'recommended', riskContextValid: true, startedTurn: true, threadId: 'thread', turnId: 'turn',
  riskContext: { trustedWorkspaceRoot: root, protectedRoots: [] } };
const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: itemId, cwd: root,
  tool_input: { command: `Remove-Item -LiteralPath '${target}' -Recurse -Force` } };
const decision = await buildCodexWindowsSafeDeleteHookDecision({ event, state, runId, helperPath });
assert.equal(decision.hookSpecificOutput?.permissionDecision, 'allow');
const replacement = decision.hookSpecificOutput.updatedInput.command;
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
const ps = resolveWindowsSystemPaths()?.powershell;
const wrapper = [ps, '-NoProfile', '-Command', replacement].map(quote).join(' ');
const approval = { kind: 'command', providerMethod: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId, cwd: alternate, command: wrapper } };
assert.equal(await verifyCodexWindowsSafeDeleteApproval({ approval, state, runId, helperPath }), true);
for (const changed of [
  { approval: { ...approval, params: { ...approval.params, itemId: 'other' } } },
  { approval: { ...approval, params: { ...approval.params, additionalPermissions: { network: true } } } },
  { approval: { ...approval, params: { ...approval.params, command: wrapper + '; evil' } } },
  { state: { ...state, riskMode: 'conservative-auto' } }, { runId: 'other' },
]) assert.equal(await verifyCodexWindowsSafeDeleteApproval({ approval, state, runId, helperPath, ...changed }), false);
const relative = await buildCodexWindowsSafeDeleteHookDecision({ event: { ...event, tool_input: { command: 'Remove-Item build -Recurse' } }, state, runId, helperPath });
assert.equal(relative.hookSpecificOutput?.permissionDecision, 'deny');
assert.match(relative.hookSpecificOutput.permissionDecisionReason, /absolute path/);
assert.deepEqual(await buildCodexWindowsSafeDeleteHookDecision({ event: { ...event, tool_input: { command: 'Remove-Item build -Recurse' } }, state: { ...state, riskMode: 'conservative-auto' }, runId, helperPath }), {});
console.log('codex-windows-safe-delete-hook: absolute target and request binding passed');
