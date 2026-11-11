import path from 'node:path';
import { decideWindowsApproval } from './windows-approval-gate.mjs';

// Claude can accept a replacement tool input. Disable ripgrep's implicit
// configuration only after the complete rewritten command passes the same
// risk gate. A relative target remains unapproved until its actual cwd is
// attested; merely rewriting the text is not evidence of the shell's cwd.
export async function buildClaudeWindowsRipgrepBridge({ approval, state } = {}) {
  const params = approval?.params || {};
  const input = params.input;
  if (approval?.providerMethod !== 'can_use_tool' || approval?.kind !== 'command'
      || !['Bash', 'PowerShell'].includes(params.tool_name) || !input || typeof input !== 'object'
      || state?.turnActive !== true || state?.riskContextValid !== true
      || !['recommended', 'full-auto'].includes(state?.riskMode)
      || state?.interactionMode === 'plan' || state?.permissionMode === 'plan'
      || params.networkApprovalContext || params.network_approval_context
      || params.additionalPermissions || params.additional_permissions
      || input.cwd || input.workdir || input.working_directory) return null;
  const command = input.command;
  if (typeof command !== 'string' || command.length > 128 * 1024
      || !/^\s*rg(?:\.exe)?(?=\s|$)/i.test(command)) return null;
  const updatedCommand = command.replace(/^(\s*rg(?:\.exe)?)(?=\s|$)/i, '$1 --no-config');
  const updatedApproval = { ...approval, params: { ...params, input: { ...input, command: updatedCommand } } };
  let decision;
  try { decision = await decideWindowsApproval(updatedApproval, state); } catch { return null; }
  if (decision?.decision !== 'auto-allow' || !Array.isArray(decision.risk?.actions)
      || !decision.risk.actions.length || decision.risk.actions.some(action => action.kind !== 'read' || action.caution)) return null;
  return { updatedCommand, risk: decision.risk };
}

// Codex's pre-tool hook exposes the session cwd, not necessarily exec_command's
// per-call cwd. The shared gate therefore requires absolute search targets.
// Do not rewrite requests carrying any other tool arguments: an omitted or
// unknown permission field must never be turned into an implicit grant.
export async function buildCodexWindowsRipgrepHookDecision({ event, state, runId } = {}) {
  const input = event?.tool_input;
  const harmlessOptions = new Set(['command', 'timeout_ms', 'yield_time_ms', 'max_output_chars', 'max_output_tokens']);
  if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'Bash'
      || typeof event.tool_use_id !== 'string' || !event.tool_use_id.trim() || event.tool_use_id.length > 1024
      || !runId || !path.win32.isAbsolute(event.cwd || '') || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !harmlessOptions.has(key)
        || (key !== 'command' && (!Number.isSafeInteger(input[key]) || input[key] < 0))) || typeof input.command !== 'string'
      || event.permission_mode === 'plan' || event.permission_mode === 'bypassPermissions'
      || event.additionalPermissions || event.additional_permissions || event.networkApprovalContext || event.network_approval_context) return {};
  const approval = { approvalId: event.tool_use_id, providerMethod: 'can_use_tool', kind: 'command',
    params: { tool_name: 'PowerShell', input: { command: input.command } } };
  const bridge = await buildClaudeWindowsRipgrepBridge({ approval, state: { ...state, cwd: event.cwd, turnActive: true } });
  if (!bridge) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { ...input, command: bridge.updatedCommand } } };
}
