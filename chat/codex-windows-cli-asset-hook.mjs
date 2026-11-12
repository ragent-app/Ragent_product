import path from 'node:path';
import { buildWindowsCliAssetBridge, buildWindowsCliReadBridge } from './windows-cli-read-bridge.mjs';
import { decodeCodexShlexArgv, readWindowsPowerShellInvocation } from './windows-approval-gate.mjs';

export async function buildCodexWindowsCliAssetHookDecision({ event, state, runId, helperPath, port } = {}) {
  if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'Bash' ||
      typeof event.tool_use_id !== 'string' || !event.tool_use_id || event.tool_use_id.length > 1024 ||
      typeof event.tool_input?.command !== 'string' || !/^[a-z]:[\\/]/i.test(event.cwd || '')) return {};
  const approval = { providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: event.tool_input.command } } };
  const bridge = await buildWindowsCliAssetBridge({ approval, state: { ...state, cwd: event.cwd, turnActive: true }, runId, helperPath, port });
  return bridge ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: bridge.updatedCommand } } } : {};
}

export async function buildCodexWindowsTriggerHookDecision({ event, state, runId, helperPath, port } = {}) {
  if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'Bash' ||
      typeof event.tool_use_id !== 'string' || !event.tool_use_id || event.tool_use_id.length > 1024 ||
      typeof event.tool_input?.command !== 'string' || !/^[a-z]:[\\/]/i.test(event.cwd || '')) return {};
  const approval = { providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: event.tool_input.command } } };
  const bridge = await buildWindowsCliReadBridge({ approval, state: { ...state, cwd: event.cwd, turnActive: true }, runId, helperPath, port });
  return / trigger-(?:create|list|help) /.test(bridge?.updatedCommand || '')
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: bridge.updatedCommand } } } : {};
}

export async function verifyCodexWindowsTriggerApproval({ approval, state, runId, helperPath, port } = {}) {
  const params = approval?.params || {};
  if (approval?.providerMethod !== 'item/commandExecution/requestApproval' || approval?.kind !== 'command' ||
      state?.startedTurn !== true || state?.riskContextValid !== true || !['recommended', 'full-auto'].includes(state?.riskMode) ||
      state?.interactionMode === 'plan' || state?.permissionMode === 'plan' || !state?.threadId || params.threadId !== state.threadId ||
      !state?.turnId || params.turnId !== state.turnId || !/^[a-z]:[\\/]/i.test(params.cwd || '') ||
      typeof params.itemId !== 'string' || !params.itemId || params.itemId.length > 1024 ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions ||
      !path.win32.isAbsolute(helperPath || '')) return false;
  const invocation = readWindowsPowerShellInvocation({ params: { command: decodeCodexShlexArgv(params.command) } });
  let command = invocation?.command || '';
  const prefix = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';
  if (command.startsWith(prefix)) command = command.slice(prefix.length);
  const encoded = / trigger-create 'http:\/\/127\.0\.0\.1:\d+' '([A-Za-z0-9_-]+)'$/.exec(command)?.[1];
  let original;
  if (encoded) {
    if (encoded.length > 10924) return false;
    let args;
    try { args = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return false; }
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) return false;
    original = `ragent trigger create ${args.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}`;
  } else {
    const read = / trigger-(list|help) 'http:\/\/127\.0\.0\.1:\d+'( --json)?$/.exec(command);
    if (!read || (read[1] === 'help' && read[2])) return false;
    original = read[1] === 'help' ? 'ragent trigger --help' : `ragent trigger list${read[2] || ''}`;
  }
  const source = { providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: original } } };
  const expected = await buildWindowsCliReadBridge({ approval: source, state: { ...state, cwd: params.cwd, turnActive: true }, runId, helperPath, port });
  return Boolean(expected && expected.updatedCommand === command);
}

// A hook is only a proposal. Re-evaluate the fixed helper command against the
// actual Codex turn, command cwd, current capability binding and file target.
export async function verifyCodexWindowsCliAssetApproval({ approval, state, runId, helperPath, port } = {}) {
  const params = approval?.params || {};
  if (approval?.providerMethod !== 'item/commandExecution/requestApproval' || approval?.kind !== 'command' ||
      state?.startedTurn !== true || state?.riskContextValid !== true || !['recommended', 'full-auto'].includes(state?.riskMode) ||
      state?.interactionMode === 'plan' || state?.permissionMode === 'plan' || !state?.threadId || params.threadId !== state.threadId ||
      !state?.turnId || params.turnId !== state.turnId || !/^[a-z]:[\\/]/i.test(params.cwd || '') ||
      typeof params.itemId !== 'string' || !params.itemId || params.itemId.length > 1024 ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions ||
      !path.win32.isAbsolute(helperPath || '')) return false;
  const invocation = readWindowsPowerShellInvocation({ params: { command: decodeCodexShlexArgv(params.command) } });
  let command = invocation?.command || '';
  const prefix = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';
  if (command.startsWith(prefix)) command = command.slice(prefix.length);
  const encoded = / asset-publish 'http:\/\/127\.0\.0\.1:\d+' '([A-Za-z0-9_-]+)'$/.exec(command)?.[1];
  if (!encoded || encoded.length > 10924) return false;
  let body;
  try { body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return false; }
  const original = `ragent api POST "/api/sessions/$env:RAGENT_SESSION_ID/assets" --body '${JSON.stringify(body).replaceAll("'", "''")}'`;
  const source = { providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: original } } };
  const expected = await buildWindowsCliAssetBridge({ approval: source, state: { ...state, cwd: params.cwd, turnActive: true }, runId, helperPath, port });
  return Boolean(expected && expected.updatedCommand === command);
}
