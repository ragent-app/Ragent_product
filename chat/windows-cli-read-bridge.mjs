import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';
import { parseLiteralBashWords } from './windows-bash-actions.mjs';
import { analyzeWindowsFileChanges, decideWindowsPowerShellActions } from './windows-powershell-actions.mjs';

// Forward static trigger options as data. The native helper independently
// validates them and forces the active session and local control endpoint.
function staticTriggerCreate(words) {
  if (!Array.isArray(words) || words.length < 7 || words.length > 64 || words[1] !== 'trigger' || words[2] !== 'create') return null;
  const values = new Set(['--text', '--in', '--at', '--every', '--max-occurrences', '--event', '--filter', '--title', '--tool', '--model', '--effort']);
  const switches = new Set(['--repeat', '--thinking', '--json']);
  const seen = new Set(); let scheduleCount = 0; let hasText = false;
  for (let i = 3; i < words.length; i += 1) {
    const flag = words[i];
    if ((!values.has(flag) && !switches.has(flag)) || (seen.has(flag) && flag !== '--filter')) return null;
    seen.add(flag);
    if (['--in', '--at', '--event'].includes(flag)) scheduleCount += 1;
    if (values.has(flag)) {
      const value = words[++i];
      if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value) || value.startsWith('--')) return null;
      if (flag === '--text') hasText = true;
    }
  }
  return hasText && scheduleCount === 1 ? words.slice(3) : null;
}

// Rewrite only a literal current-session asset publication through the fixed
// installed helper. The helper reconstructs the endpoint from the verified
// session capability, rather than inheriting an arbitrary URL or Node hooks.
export async function buildWindowsCliAssetBridge({ approval, state, helperPath, port, runId }, { inspect = lstat } = {}) {
  const params = approval?.params || {}; const input = params.input;
  if (approval?.providerMethod !== 'can_use_tool' || !['Bash', 'PowerShell'].includes(params.tool_name) ||
      !state?.turnActive || state.riskContextValid !== true || state.sessionControlReadAvailable !== true ||
      !runId || state.sessionControlReadRunId !== runId || !['recommended', 'full-auto'].includes(state.riskMode) ||
      state.interactionMode === 'plan' || state.permissionMode === 'plan' ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions ||
      !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['command', 'description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'].includes(key)) ||
      (input.dangerouslyDisableSandbox !== undefined && input.dangerouslyDisableSandbox !== false) || params.cwd ||
      !path.win32.isAbsolute(helperPath || '') || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof input.command !== 'string' || input.command.length > 8192 || /[\r\n\0]/.test(input.command)) return null;
  let rawBody;
  if (params.tool_name === 'PowerShell') {
    const match = /^\s*(?:agentoc(?:\.cmd)?|ragent(?:\.cmd)?|node(?:\.exe)?\s+"\$env:(?:AGENTOC|RAGENT)_PROJECT_ROOT[\\/]cli\.js")\s+api\s+POST\s+"\/api\/sessions\/\$env:(?:AGENTOC|RAGENT)_SESSION_ID\/assets"\s+--body\s+'((?:[^']|'')*)'\s*$/i.exec(input.command);
    if (!match) return null;
    rawBody = match[1].replaceAll("''", "'");
  } else {
    const sessionRoute = /(?:"\/api\/sessions\/(?:\$(?:AGENTOC|RAGENT)_SESSION_ID|\$\{(?:AGENTOC|RAGENT)_SESSION_ID\})\/assets"|\/api\/sessions\/(?:\$(?:AGENTOC|RAGENT)_SESSION_ID|\$\{(?:AGENTOC|RAGENT)_SESSION_ID\})\/assets)(?=\s|$)/;
    if (!sessionRoute.test(input.command)) return null;
    const command = input.command.replace(/^\s*MSYS_NO_PATHCONV=1\s+/, '')
      .replace(/^\s*node(?:\.exe)?\s+"(?:\$(?:AGENTOC|RAGENT)_PROJECT_ROOT|\$\{(?:AGENTOC|RAGENT)_PROJECT_ROOT\})\/cli\.js"\s+/, 'agentoc ')
      .replace(sessionRoute, "'__SESSION_ASSETS__'");
    const words = parseLiteralBashWords(command);
    if (!words || words.length !== 6 || !['agentoc', 'ragent'].includes(words[0]) || words[1] !== 'api' || words[2] !== 'POST' ||
        words[3] !== '__SESSION_ASSETS__' || words[4] !== '--body') return null;
    rawBody = words[5];
  }
  let body;
  try { body = JSON.parse(rawBody); } catch { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['localPath', 'originalName', 'mimeType', 'renderAs', 'text'].includes(key)) ||
      Object.values(body).some(value => typeof value !== 'string') ||
      typeof body.localPath !== 'string' || !/^[a-z]:[\\/]/i.test(body.localPath) ||
      (body.renderAs !== undefined && body.renderAs !== 'file')) return null;
  let binary, analyzed;
  try {
    [binary, analyzed] = await Promise.all([inspect(helperPath), analyzeWindowsFileChanges([{ path: body.localPath, kind: 'read' }],
      { ...state.riskContext, cwd: state.cwd, requireAbsolutePaths: true })]);
  } catch { return null; }
  if (!binary?.isFile() || binary.isSymbolicLink() || !analyzed.complete || analyzed.actions.length !== 1 ||
      !analyzed.actions[0].regularFile || decideWindowsPowerShellActions(analyzed).decision !== 'allow') return null;
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  if (encoded.length > 10924) return null;
  if (params.tool_name === 'PowerShell') return { updatedCommand: `& '${helperPath.replaceAll("'", "''")}' asset-publish 'http://127.0.0.1:${port}' '${encoded}'` };
  const bashPath = helperPath.replaceAll('\\', '/').replace(/^([a-z]):/i, (_match, drive) => `/${drive.toLowerCase()}`);
  const quoted = `'${bashPath.replaceAll("'", "'\\''")}'`;
  return { updatedCommand: `${quoted} asset-publish 'http://127.0.0.1:${port}' '${encoded}'` };
}

// Only replace a complete, literal scoped operation. Never forward original
// shell text or arbitrary CLI options to the native launcher.
export async function buildWindowsCliReadBridge({ approval, state, helperPath, port, runId }, { parse = parseWindowsPowerShellAst, inspect = lstat } = {}) {
  const params = approval?.params || {};
  if (approval?.providerMethod !== 'can_use_tool' || !['PowerShell', 'Bash'].includes(params.tool_name) ||
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
  if (params.tool_name === 'Bash') {
    const words = parseLiteralBashWords(command);
    const recognized = words && ['agentoc', 'ragent'].includes(words[0]);
    const args = recognized ? staticTriggerCreate(words) : null;
    const read = recognized && words[1] === 'trigger' && (words.length === 3 && ['--help', '-h'].includes(words[2]) || words[2] === 'list' && (words.length === 3 || words.length === 4 && ['--json', '--help', '-h'].includes(words[3])));
    let binary; try { binary = (args || read) && await inspect(helperPath); } catch { return null; }
    if ((!args && !read) || !binary?.isFile() || binary.isSymbolicLink()) return null;
    const helper = helperPath.replaceAll('\\', '/').replace(/^([a-z]):/i, (_match, drive) => `/${drive.toLowerCase()}`);
    const prefix = `'${helper.replaceAll("'", "'\\''")}'`;
    if (read) {
      const help = words.includes('--help') || words.includes('-h');
      return { updatedCommand: `${prefix} ${help ? 'trigger-help' : 'trigger-list'} 'http://127.0.0.1:${port}'${words.includes('--json') ? ' --json' : ''}` };
    }
    const encoded = Buffer.from(JSON.stringify(args), 'utf8').toString('base64url');
    if (encoded.length > 10924) return null;
    return { updatedCommand: `${prefix} trigger-create 'http://127.0.0.1:${port}' '${encoded}'` };
  }
  // The documented fallback uses only these two Run-provided environment
  // variables. Replace the whole command with the fixed helper; do not pass
  // shell text or environment-derived paths to the helper.
  const fallback = /^\s*node(?:\.exe)?\s+"\$env:(?:AGENTOC|RAGENT)_PROJECT_ROOT[\\/]cli\.js"\s+trigger\s+list(?:\s+--(?:session|source-session)\s+(?:\$env:(?:AGENTOC|RAGENT)_SESSION_ID|"\$env:(?:AGENTOC|RAGENT)_SESSION_ID"))?(?:\s+(--json|--help))?\s*(?:2\s*>\s*&\s*1\s*)?(?:\|\s*Out-String\s*)?$/i.exec(command);
  let ast, binary;
  try { [ast, binary] = await Promise.all([parse(command), inspect(helperPath)]); } catch { return null; }
  if (!binary?.isFile() || binary.isSymbolicLink() || ast.errors.length || (!fallback && ast.dynamicNodes.length) ||
      ast.expressions?.length || ![1, 2].includes(ast.commands.length)) return null;
  const first = ast.commands[0];
  const originalWords = first.elements.map(element => element.kind === 'literal' ? String(element.value) : element.kind === 'parameter' && String(element.name).toLowerCase() === 'h' && !element.argumentType && element.value == null ? '-h' : null);
  const words = originalWords.map(value => value?.toLowerCase() ?? null);
  const triggerCreate = !fallback && ['agentoc', 'agentoc.cmd', 'ragent', 'ragent.cmd'].includes(words[0])
    && originalWords.every(value => value !== null) ? staticTriggerCreate(originalWords) : null;
  const triggerHelp = !fallback && ['agentoc', 'agentoc.cmd', 'ragent', 'ragent.cmd'].includes(words[0]) && words[1] === 'trigger' &&
    (words.length === 3 && ['--help', '-h'].includes(words[2]) || words.length === 4 && words[2] === 'list' && ['--help', '-h'].includes(words[3]));
  if (!['unknown', 'ampersand'].includes(String(first.invocation).toLowerCase()) || first.pipelineInput ||
      (!fallback && !triggerCreate && !triggerHelp && (!['agentoc', 'agentoc.cmd', 'ragent', 'ragent.cmd'].includes(words[0]) || words[1] !== 'trigger' || words[2] !== 'list' ||
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
  if (triggerCreate) {
    const encoded = Buffer.from(JSON.stringify(triggerCreate), 'utf8').toString('base64url');
    if (encoded.length > 10924) return null;
    return { updatedCommand: `& ${quoted} trigger-create 'http://127.0.0.1:${port}' '${encoded}'` };
  }
  const option = triggerHelp ? '--help' : fallback ? String(fallback[1] || '').toLowerCase() : words.length === 4 ? '--json' : '';
  const action = option === '--help' ? 'trigger-help' : 'trigger-list';
  return { updatedCommand: `& ${quoted} ${action} 'http://127.0.0.1:${port}'${option === '--json' ? ' --json' : ''}` };
}
