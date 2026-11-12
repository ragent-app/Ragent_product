import path from 'node:path';
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { decideWindowsApproval } from './windows-approval-gate.mjs';
import { decodeCodexShlexArgv, readWindowsPowerShellInvocation } from './windows-approval-gate.mjs';
import { RIPGREP_SENSITIVE_EXCLUSIONS, ripgrepSafePrefix, staticExternalArguments, parseWindowsSelectStringArgs, resolveWindowsSelectStringGlob } from './windows-powershell-actions.mjs';
import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';
const executeFile = promisify(execFile);

// Freeze wildcard membership into literal paths before granting the tool call.
// The rewritten request is checked again by the ordinary file-read gate.
export async function buildWindowsSelectStringGlobBridge({ approval, state, helperPath } = {}) {
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
  if (helperPath !== undefined) {
    if (!path.win32.isAbsolute(helperPath || '') || (args.named.has('raw') && args.named.has('quiet'))) return null;
    try {
      const binary = await lstat(helperPath);
      if (!binary.isFile() || binary.isSymbolicLink()) return null;
      const digestRequest = Buffer.from(JSON.stringify({ schemaVersion: 1, paths }), 'utf8').toString('base64url');
      if (digestRequest.length > 30000) return null;
      const { stdout } = await executeFile(helperPath, ['--digest', digestRequest], { windowsHide: true, maxBuffer: 256 * 1024 });
      const targets = JSON.parse(stdout);
      if (!Array.isArray(targets) || targets.length !== paths.length || targets.some((item, index) =>
        !item || item.path !== paths[index] || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256))) return null;
      const switches = [...args.named.keys()].filter(key => !['path', 'pattern', 'encoding'].includes(key));
      const request = { schemaVersion: 1, targets, pattern: args.pattern,
        ...(args.named.has('encoding') ? { encoding: args.named.get('encoding') } : {}), switches };
      const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
      const command = `& ${quote(helperPath)} --request '${encoded}'`;
      if (command.length > 30000) return null;
      return { updatedCommand: command, risk: decision.risk };
    } catch { return null; }
  }
  return { updatedCommand, risk: decision.risk };
}

export async function buildCodexWindowsSelectStringGlobHookDecision({ event, state, runId, helperPath } = {}) {
  const input = event?.tool_input;
  const allowed = new Set(['command', 'timeout_ms', 'yield_time_ms', 'max_output_chars', 'max_output_tokens']);
  if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'Bash' || typeof event.tool_use_id !== 'string' ||
      !event.tool_use_id.trim() || event.tool_use_id.length > 1024 || !runId || !path.win32.isAbsolute(event.cwd || '') ||
      !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key) ||
        (key !== 'command' && (!Number.isSafeInteger(input[key]) || input[key] < 0))) || typeof input.command !== 'string' ||
      event.permission_mode === 'plan' || event.permission_mode === 'bypassPermissions' || event.additionalPermissions ||
      event.additional_permissions || event.networkApprovalContext || event.network_approval_context) return {};
  const approval = { approvalId: event.tool_use_id, providerMethod: 'can_use_tool', kind: 'command', params: { tool_name: 'PowerShell', input: { command: input.command } } };
  const bridge = await buildWindowsSelectStringGlobBridge({ approval, state: { ...state, cwd: event.cwd, turnActive: true }, helperPath });
  return bridge ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, command: bridge.updatedCommand } } } : {};
}

// Treat the hook output as untrusted: authorize every literal target again for
// the actual Codex turn. The helper independently pins the supplied digest.
export async function verifyCodexWindowsBoundSearchApproval({ approval, state, helperPath } = {}) {
  const params = approval?.params || {};
  if (approval?.providerMethod !== 'item/commandExecution/requestApproval' || approval?.kind !== 'command' ||
      state?.startedTurn !== true || state?.riskContextValid !== true || !['recommended', 'full-auto'].includes(state?.riskMode) ||
      state?.interactionMode === 'plan' || state?.permissionMode === 'plan' || !state?.threadId || params.threadId !== state.threadId ||
      !state?.turnId || params.turnId !== state.turnId || !path.win32.isAbsolute(params.cwd || '') ||
      typeof params.itemId !== 'string' || !params.itemId || params.itemId.length > 1024 ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions ||
      !path.win32.isAbsolute(helperPath || '')) return false;
  try {
    const binary = await lstat(helperPath);
    if (!binary.isFile() || binary.isSymbolicLink()) return false;
    const invocation = readWindowsPowerShellInvocation({ providerMethod: approval.providerMethod, params: { command: decodeCodexShlexArgv(params.command) } });
    let command = invocation?.command || '';
    const prefix = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';
    if (command.startsWith(prefix)) command = command.slice(prefix.length);
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    const beginning = `& ${quote(helperPath)} --request '`;
    if (!command.startsWith(beginning) || !command.endsWith("'") || command.length > 30000) return false;
    const encoded = command.slice(beginning.length, -1);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return false;
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return false;
    const body = JSON.parse(bytes.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['schemaVersion','targets','pattern','encoding','switches'].includes(key)) ||
        body.schemaVersion !== 1 || !Array.isArray(body.targets) || !body.targets.length || body.targets.length > 128 ||
        typeof body.pattern !== 'string' || body.pattern.length > 32768 || (body.encoding !== undefined && (typeof body.encoding !== 'string' || body.encoding.length > 64)) ||
        !Array.isArray(body.switches) || body.switches.some(value => !['simplematch','casesensitive','quiet','notmatch','allmatches','list','raw','noemphasis'].includes(value)) ||
        new Set(body.switches).size !== body.switches.length || body.targets.some(target => !target || typeof target !== 'object' || Array.isArray(target) ||
          Object.keys(target).sort().join(',') !== 'path,sha256' || typeof target.path !== 'string' || !path.win32.isAbsolute(target.path) ||
          typeof target.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(target.sha256))) return false;
    const flags = body.switches.map(value => `-${value}`);
    if (body.encoding !== undefined) flags.push('-encoding', quote(body.encoding));
    const source = `Select-String -LiteralPath ${body.targets.map(target => quote(target.path)).join(',')} -Pattern ${quote(body.pattern)}${flags.length ? ` ${flags.join(' ')}` : ''}`;
    const original = { providerMethod: 'can_use_tool', kind: 'command', params: { tool_name: 'PowerShell', input: { command: source } } };
    const decision = await decideWindowsApproval(original, { ...state, cwd: params.cwd, turnActive: true });
    return decision?.decision === 'auto-allow' && Array.isArray(decision.risk?.actions) && decision.risk.actions.length > 0 &&
      decision.risk.actions.every(action => action.kind === 'read');
  } catch { return false; }
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
