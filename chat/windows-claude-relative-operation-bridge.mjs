import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { analyzeWindowsBash } from './windows-bash-actions.mjs';
import { analyzeWindowsPowerShell, decideWindowsPowerShellActions, ripgrepSafePrefix } from './windows-powershell-actions.mjs';
import { decideWindowsApproval } from './windows-approval-gate.mjs';

// Supply the session directory explicitly to Claude's file-search tools when
// their optional path was omitted, and classify the same input we return.
export async function buildClaudeWindowsDefaultFileToolBridge({ approval, state } = {}) {
  const params = approval?.params || {}; const input = params.input;
  if (process.platform !== 'win32' || approval?.providerMethod !== 'can_use_tool'
      || !['Glob', 'Grep', 'LS', 'List'].includes(params.tool_name)
      || !input || typeof input !== 'object' || Array.isArray(input)
      || input.path !== undefined || input.file_path !== undefined || input.notebook_path !== undefined
      || input.cwd !== undefined || input.workdir !== undefined || input.working_directory !== undefined
      || state?.turnActive !== true || state?.riskContextValid !== true
      || !['recommended', 'full-auto'].includes(state?.riskMode)
      || state?.interactionMode === 'plan' || state?.permissionMode === 'plan'
      || params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions
      || !path.win32.isAbsolute(state.cwd || '')) return null;
  const updatedInput = { ...input, path: path.win32.resolve(state.cwd) };
  const decision = await decideWindowsApproval({ ...approval, params: { ...params, input: updatedInput } }, state);
  if (decision.decision !== 'auto-allow') return null;
  return { updatedInput, risk: decision.risk };
}

// Claude does not attest the shell's current directory. Bind a static
// operation to the expected directory at execution time. Bash's [[ -ef ]]
// checks process directory identity; PowerShell checks its filesystem location.
export async function buildClaudeWindowsRelativeOperationBridge({ approval, state } = {}) {
  const params = approval?.params || {};
  const input = params.input;
  if (process.platform !== 'win32' || approval?.providerMethod !== 'can_use_tool' || approval?.kind !== 'command'
      || !['Bash', 'PowerShell'].includes(params.tool_name) || !input || typeof input !== 'object' || Array.isArray(input)
      || state?.turnActive !== true || state?.riskContextValid !== true
      || !['recommended', 'full-auto'].includes(state?.riskMode)
      || state?.interactionMode === 'plan' || state?.permissionMode === 'plan'
      || params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions
      || Object.keys(input).some(key => !['command', 'description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'].includes(key))
      || (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 8192))
      || (input.timeout !== undefined && (!Number.isSafeInteger(input.timeout) || input.timeout < 0))
      || (input.run_in_background !== undefined && typeof input.run_in_background !== 'boolean')
      || (input.dangerouslyDisableSandbox !== undefined && input.dangerouslyDisableSandbox !== false)) return null;
  const original = input.command;
  const workspace = state.riskContext?.trustedWorkspaceRoot;
  if (typeof original !== 'string' || !original.trim() || original.length > 128 * 1024
      || !path.win32.isAbsolute(state.cwd || '')
      || (workspace && !path.win32.isAbsolute(workspace))) return null;
  let cwd; let root = '';
  try { cwd = await realpath(state.cwd); if (workspace) root = await realpath(workspace); } catch { return null; }
  if (!/^[a-z]:\\/i.test(cwd)) return null;
  const command = /^\s*rg(?:\.exe)?(?=\s|$)/i.test(original)
    ? original.replace(/^(\s*rg(?:\.exe)?)(?=\s|$)/i, `$1 ${ripgrepSafePrefix()}`)
    : params.tool_name === 'Bash' && /^\s*curl(?:\.exe)?(?=\s|$)/i.test(original)
      ? original.replace(/^(\s*curl(?:\.exe)?)(?=\s|$)/i, '$1 --disable --proto =http,https --proto-redir =http,https')
    : /^\s*git(?:\.exe)?\s+diff(?:\s+(?:--cached|--staged))?\s*$/i.test(original)
      ? original.replace(/^(\s*git(?:\.exe)?\s+diff)(?=\s|$)/i, '$1 --no-ext-diff --no-textconv') : original;
  const context = { ...state.riskContext, cwd, trustedWorkspaceRoot: root, requireAbsolutePaths: false, allowCwdRewrite: true };
  let result;
  try { result = await (params.tool_name === 'Bash' ? analyzeWindowsBash(command, context) : analyzeWindowsPowerShell(command, context)); } catch { return null; }
  const decision = decideWindowsPowerShellActions(result);
  if (decision.decision !== 'allow' || !result.complete || !result.actions.length
      || result.actions.some(action => !['read', 'write', 'delete'].includes(action.kind))) return null;
  const expected = cwd.replaceAll('\\', '/');
  const quoted = `'${expected.replaceAll("'", "'\\''")}'`;
  const psExpected = path.win32.resolve(state.cwd).replaceAll("'", "''");
  const updatedCommand = params.tool_name === 'Bash'
    ? `if [[ /proc/self/cwd -ef ${quoted} ]]; then ${result.rewrittenCommand || command}; else [[ 1 == 0 ]]; fi`
    : `if (($ExecutionContext.SessionState.Path.CurrentLocation.Provider.Name -eq 'FileSystem') -and ([System.IO.Path]::GetFullPath([string]$ExecutionContext.SessionState.Path.CurrentLocation.ProviderPath) -ieq '${psExpected}')) {\n${command}\n} else { throw 'Working directory changed; retry with absolute paths.' }`;
  const outside = result.actions.some(action => action.target && !action.workspace);
  return { updatedInput: { ...input, command: updatedCommand }, risk: { tier: decision.tier || 'safe', platform: params.tool_name === 'Bash' ? 'bash' : 'powershell',
    policyVersion: 'windows-approval/v3', confidence: 'high', reasons: [{ code: 'windows_runtime_cwd_verified', message: 'operation bound to execution working directory' }],
    signals: { targetScope: outside ? 'outside-workspace' : 'trusted-workspace' }, actions: result.actions } };
}
