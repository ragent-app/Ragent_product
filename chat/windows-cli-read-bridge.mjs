import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';

// Only replace a complete, literal read operation. Never forward the original
// shell text or arbitrary CLI options to the native launcher.
export async function buildWindowsCliReadBridge({ approval, state, helperPath, port, runId }, { parse = parseWindowsPowerShellAst, inspect = lstat } = {}) {
  const params = approval?.params || {};
  if (approval?.providerMethod !== 'can_use_tool' || params.tool_name !== 'PowerShell' ||
      !state?.turnActive || state.riskContextValid !== true || state.sessionControlReadAvailable !== true ||
      !runId || state.sessionControlReadRunId !== runId || !['recommended', 'full-auto'].includes(state.riskMode) ||
      state.interactionMode === 'plan' || state.permissionMode === 'plan' ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions ||
      !params.input || typeof params.input !== 'object' || Array.isArray(params.input) ||
      Object.keys(params.input).some(key => !['command', 'description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'].includes(key)) ||
      (params.input.dangerouslyDisableSandbox !== undefined && params.input.dangerouslyDisableSandbox !== false) ||
      params.input?.cwd || params.input?.workdir || params.input?.working_directory || params.cwd ||
      !path.win32.isAbsolute(helperPath || '') || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const command = params.input?.command;
  if (typeof command !== 'string' || command.length > 8192) return null;
  // The documented fallback uses only these two Run-provided environment
  // variables. Replace the whole command with the fixed helper; do not pass
  // shell text or environment-derived paths to the helper.
  const fallback = /^\s*node(?:\.exe)?\s+"\$env:AGENTOC_PROJECT_ROOT[\\/]cli\.js"\s+trigger\s+list(?:\s+--(?:session|source-session)\s+(?:\$env:AGENTOC_SESSION_ID|"\$env:AGENTOC_SESSION_ID"))?(?:\s+(--json|--help))?\s*(?:2\s*>\s*&\s*1\s*)?(?:\|\s*Out-String\s*)?$/i.exec(command);
  let ast, binary;
  try { [ast, binary] = await Promise.all([parse(command), inspect(helperPath)]); } catch { return null; }
  if (!binary?.isFile() || binary.isSymbolicLink() || ast.errors.length || (!fallback && ast.dynamicNodes.length) ||
      ast.expressions?.length || ![1, 2].includes(ast.commands.length)) return null;
  const first = ast.commands[0];
  const words = first.elements.map(element => element.kind === 'literal' ? String(element.value).toLowerCase() : null);
  if (!['unknown', 'ampersand'].includes(String(first.invocation).toLowerCase()) || first.pipelineInput ||
      (!fallback && (!['agentoc', 'agentoc.cmd'].includes(words[0]) || words[1] !== 'trigger' || words[2] !== 'list' ||
      ![3, 4].includes(words.length) || (words.length === 4 && words[3] !== '--json'))) ||
      (fallback && (!['node', 'node.exe'].includes(words[0]) || ast.dynamicNodes.some(node => !['VariableExpressionAst', 'ExpandableStringExpressionAst'].includes(node)))) ||
      first.redirections > 1 || first.redirectFacts?.length !== first.redirections ||
      first.redirectFacts.some(redirect => redirect.type !== 'MergingRedirectionAst')) return null;
  if (ast.commands.length === 2) {
    const second = ast.commands[1];
    if (String(second.name).toLowerCase() !== 'out-string' || !second.pipelineInput || second.redirections ||
        second.elements.length !== 1 || second.elements[0].kind !== 'literal' ||
        String(second.elements[0].value).toLowerCase() !== 'out-string') return null;
  }
  const quoted = `'${helperPath.replace(/'/g, "''")}'`;
  const option = fallback ? String(fallback[1] || '').toLowerCase() : words.length === 4 ? '--json' : '';
  const action = option === '--help' ? 'trigger-help' : 'trigger-list';
  return { updatedCommand: `& ${quoted} ${action} 'http://127.0.0.1:${port}'${option === '--json' ? ' --json' : ''}` };
}
