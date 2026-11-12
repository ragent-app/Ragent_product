import path from 'node:path';
import { decideWindowsApproval } from './windows-approval-gate.mjs';
import { RIPGREP_SENSITIVE_EXCLUSIONS, ripgrepSafePrefix, staticExternalArguments, parseWindowsSelectStringArgs, resolveWindowsSelectStringGlob } from './windows-powershell-actions.mjs';
import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';

// Freeze wildcard membership into literal paths before granting the tool call.
// The rewritten request is checked again by the ordinary file-read gate.
export async function buildWindowsSelectStringGlobBridge({ approval, state } = {}) {
  const params = approval?.params || {}; const input = params.input;
  if (approval?.providerMethod !== 'can_use_tool' || approval?.kind !== 'command' || params.tool_name !== 'PowerShell' ||
      !input || typeof input !== 'object' || Array.isArray(input) || state?.turnActive !== true || state.riskContextValid !== true ||
      !['recommended', 'full-auto'].includes(state.riskMode) || state.interactionMode === 'plan' || state.permissionMode === 'plan' ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions ||
      Object.keys(input).some(key => !['command', 'description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'].includes(key)) ||
      (input.dangerouslyDisableSandbox !== undefined && input.dangerouslyDisableSandbox !== false) ||
      typeof input.command !== 'string' || input.command.length > 128 * 1024) return null;
  let ast; try { ast = await parseWindowsPowerShellAst(input.command); } catch { return null; }
  if (ast.errors.length || ast.dynamicNodes.length || ast.chainOperators?.length || ast.expressions?.length || ast.commands.length !== 1) return null;
  const entry = ast.commands[0];
  if (String(entry.name || '').toLowerCase() !== 'select-string' || entry.invocation !== 'Unknown' || entry.pipelineInput !== false || entry.redirections) return null;
  const args = parseWindowsSelectStringArgs(entry.elements);
  if (!args || args.named.has('literalpath') || typeof args.filePath !== 'string' || !/[*?\[\]]/.test(args.filePath) ||
      typeof args.pattern !== 'string') return null;
  const context = { ...state.riskContext, cwd: state.cwd, requireAbsolutePaths: true };
  const paths = await resolveWindowsSelectStringGlob(args.filePath, context);
  if (!Array.isArray(paths) || !paths.length || paths.length > 128) return null;
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  const flags = [];
  for (const [key, value] of args.named) {
    if (['path', 'pattern'].includes(key)) continue;
    flags.push(`-${key}`);
    if (key === 'encoding') flags.push(quote(value));
  }
  const updatedCommand = `Select-String -LiteralPath ${paths.map(quote).join(',')} -Pattern ${quote(args.pattern)}${flags.length ? ` ${flags.join(' ')}` : ''}`;
  if (updatedCommand.length > 128 * 1024) return null;
  const updatedApproval = { ...approval, params: { ...params, input: { ...input, command: updatedCommand } } };
  let decision; try { decision = await decideWindowsApproval(updatedApproval, state); } catch { return null; }
  if (decision?.decision !== 'auto-allow' || !decision.risk?.actions?.length || decision.risk.actions.some(action => action.kind !== 'read')) return null;
  return { updatedCommand, risk: decision.risk };
}

export async function buildCodexWindowsSelectStringGlobHookDecision({ event, state, runId } = {}) {
  const input = event?.tool_input;
  const allowed = new Set(['command', 'timeout_ms', 'yield_time_ms', 'max_output_chars', 'max_output_tokens']);
  if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'Bash' || typeof event.tool_use_id !== 'string' ||
      !event.tool_use_id.trim() || event.tool_use_id.length > 1024 || !runId || !path.win32.isAbsolute(event.cwd || '') ||
      !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key) ||
        (key !== 'command' && (!Number.isSafeInteger(input[key]) || input[key] < 0))) || typeof input.command !== 'string' ||
      event.permission_mode === 'plan' || event.permission_mode === 'bypassPermissions' || event.additionalPermissions ||
      event.additional_permissions || event.networkApprovalContext || event.network_approval_context) return {};
  const approval = { approvalId: event.tool_use_id, providerMethod: 'can_use_tool', kind: 'command', params: { tool_name: 'PowerShell', input: { command: input.command } } };
  const bridge = await buildWindowsSelectStringGlobBridge({ approval, state: { ...state, cwd: event.cwd, turnActive: true } });
  return bridge ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, command: bridge.updatedCommand } } } : {};
}

export async function appendPowerShellRipgrepGuards(command) {
  let ast; try { ast = await parseWindowsPowerShellAst(command); } catch { return null; }
  if (ast.errors.length || ast.dynamicNodes.length || ast.chainOperators?.length || ast.commands.length !== 1 || ast.expressions?.length) return null;
  const entry = ast.commands[0];
  if (!['rg', 'rg.exe'].includes(String(entry.name || '').toLowerCase()) || entry.invocation !== 'Unknown'
      || entry.pipelineInput !== false || entry.redirections || entry.elements[0]?.kind !== 'literal'
      || entry.elements.slice(1).some(element => element.kind !== 'literal'
        && (element.kind !== 'parameter' || element.argumentType || element.value != null))) return null;
  const args = staticExternalArguments(entry.elements);
  if (!args) return null;
  const boundary = args.indexOf('--');
  const guards = RIPGREP_SENSITIVE_EXCLUSIONS.flatMap(value => ['--iglob', value]);
  const ordered = boundary < 0 ? [...args, ...guards] : [...args.slice(0, boundary), ...guards, ...args.slice(boundary)];
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  return [entry.name, '--no-config', ...ordered.map(quote)].join(' ');
}

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
      || Object.keys(input).some(key => !['command', 'description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'].includes(key))
      || (input.dangerouslyDisableSandbox !== undefined && input.dangerouslyDisableSandbox !== false)) return null;
  const command = input.command;
  if (typeof command !== 'string' || command.length > 128 * 1024
      || !/^\s*rg(?:\.exe)?(?=\s|$)/i.test(command)) return null;
  const updatedCommand = (params.tool_name === 'PowerShell' && await appendPowerShellRipgrepGuards(command))
    || command.replace(/^(\s*rg(?:\.exe)?)(?=\s|$)/i, `$1 ${ripgrepSafePrefix()}`);
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
