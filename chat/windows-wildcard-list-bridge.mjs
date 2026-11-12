import { lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { decodeCodexShlexArgv, readWindowsPowerShellInvocation } from './windows-approval-gate.mjs';
import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';

const win = path.win32;
const executeFile = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

// Only the fixed helper path and canonical base64url data are interpolated.
// Names, patterns and properties remain JSON data and are never parsed as PS.
function listingCommand(helperPath, encoded) {
  return `& {
$ErrorActionPreference='Stop'
$oldEncoding=[Console]::OutputEncoding
try {
  [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false
  $raw=& ${quote(helperPath)} --list-json '${encoded}'
  if ($LASTEXITCODE -ne 0) { throw 'bound directory listing failed' }
  $r=$raw | Microsoft.PowerShell.Utility\\ConvertFrom-Json
  $items=@($r.items | Microsoft.PowerShell.Core\\Where-Object {
    ($r.request.kind -eq 'all' -or ($r.request.kind -eq 'directory' -and $_.directory) -or ($r.request.kind -eq 'file' -and -not $_.directory)) -and
      $_.name -like [string]$r.request.pattern } |
    Microsoft.PowerShell.Utility\\Sort-Object @{Expression={$_.directory};Descending=$true}, @{Expression={$_.name};Ascending=$true})
  if ($r.request.output -eq 'name') {
    $items | Microsoft.PowerShell.Core\\ForEach-Object { [string]$_.name }
  } else {
    $props=[string[]]@($r.request.properties)
    if (@($props | Microsoft.PowerShell.Core\\Where-Object { $_ -ine 'Name' }).Count -gt 0 -and
        @($items | Microsoft.PowerShell.Core\\Where-Object { ([uint32]$_.attributes -band 1024) -ne 0 }).Count -gt 0) {
      throw 'reparse metadata unavailable'
    }
    $rows=@($items | Microsoft.PowerShell.Core\\ForEach-Object {
      $a=[uint32]$_.attributes
      $mode=if ($_.directory) {'d'} else {'-'}
      foreach($flag in @(32,1,2,4)) { if (($a -band $flag) -ne 0) { $mode+=@{32='a';1='r';2='h';4='s'}[$flag] } else { $mode+='-' } }
      if ($PSVersionTable.PSVersion.Major -lt 6) { $mode+='-' }
      [pscustomobject]@{Name=[string]$_.name;Mode=$mode;Length=$(if ($_.directory) {$null} else {[long]$_.size});
        LastWriteTime=[DateTime]::FromFileTime([long]$_.filetime);Attributes=[IO.FileAttributes]$a;PSIsContainer=[bool]$_.directory}
    })
    if ($r.request.output -eq 'default' -and $rows.Count -gt 0) { ''; '    Directory: ' + [string]$r.request.directory; '' }
    if ($r.request.formatTable) {
      $rows | Microsoft.PowerShell.Utility\\Select-Object -Property $props | Microsoft.PowerShell.Utility\\Format-Table -AutoSize | Microsoft.PowerShell.Utility\\Out-String
    } else {
      $rows | Microsoft.PowerShell.Utility\\Select-Object -Property $props | Microsoft.PowerShell.Utility\\Out-String
    }
  }
} finally { [Console]::OutputEncoding=$oldEncoding }
}`;
}

function validRequest(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'directory,force,formatTable,kind,output,pattern,properties,schemaVersion' &&
    value.schemaVersion === 1 && typeof value.directory === 'string' && /^[a-z]:[\\/]/i.test(value.directory) &&
    !value.directory.slice(2).includes(':') && !/[*?\[\]`]/.test(value.directory) &&
    typeof value.pattern === 'string' && value.pattern.length > 0 && value.pattern.length <= 255 &&
    /[*?\[]/.test(value.pattern) && !/[\\/:\0]/.test(value.pattern) && typeof value.force === 'boolean' && ['all','file','directory'].includes(value.kind) &&
    ['name', 'select', 'default'].includes(value.output) && typeof value.formatTable === 'boolean' && Array.isArray(value.properties) &&
    ((value.output === 'name' && !value.formatTable && value.properties.length === 0) ||
      (value.output === 'default' && value.formatTable && value.properties.join(',') === 'Mode,LastWriteTime,Length,Name') ||
      (value.output === 'select' && value.properties.length > 0 && value.properties.length <= 6 &&
        value.properties.every(item => typeof item === 'string' && ['name','mode','length','lastwritetime','attributes','psiscontainer'].includes(item.toLowerCase())) &&
        new Set(value.properties.map(item => item.toLowerCase())).size === value.properties.length));
}

async function allowedDirectory(body, state, helperPath) {
  // Shallow directory-name metadata is allowed by the common Windows gate in
  // both modes. Check the path with the native local-volume handle walker;
  // a JavaScript lstat here could itself access a mapped network drive.
  if (!win.isAbsolute(state?.cwd || '') || !state?.riskContext || typeof state.riskContext !== 'object') return null;
  try {
    const result = await executeFile(helperPath, ['--check-directory', body.directory], { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
    if (result.stdout.trim() !== 'ok') return null;
    if ((body.output === 'select' || body.output === 'default') && body.properties.some(item => item.toLowerCase() !== 'name')) {
      const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
      if (encoded.length > 30000) return null;
      const checked = await executeFile(helperPath, ['--check-list', encoded], { windowsHide: true, timeout: 15000, maxBuffer: 4096 });
      if (checked.stdout.trim() !== 'ok') return null;
    }
  } catch { return null; }
  const directory = body.directory;
  const root = state.riskContext.trustedWorkspaceRoot || '';
  const relative = root ? win.relative(win.resolve(root), win.resolve(directory)) : '..';
  const workspace = Boolean(root) && (relative === '' || (relative !== '..' && !relative.startsWith('..\\') && !win.isAbsolute(relative)));
  const action = { kind: 'read', program: 'get-childitem', target: { lexical: directory, actual: directory },
    directory: true, recursive: false, protected: false, workspace };
  return { tier: 'safe', platform: 'powershell', policyVersion: 'windows-approval/v3', confidence: 'high',
    signals: { reasons: ['pinned local directory name listing'], targetScope: workspace ? 'trusted-workspace' : 'outside-workspace' },
    reasons: [], actions: [action] };
}

function parseListingCommands(ast) {
  if (ast.errors.length || ast.dynamicNodes.length || ast.chainOperators?.length || ast.expressions?.length || ast.assignmentCount !== 0 ||
      ast.commands.length < 1 || ast.commands.length > 4) return null;
  const [first, select] = ast.commands;
  if (!['get-childitem', 'gci', 'ls', 'dir'].includes(String(first.name || '').toLowerCase()) || first.invocation !== 'Unknown' ||
      first.pipelineInput !== false || first.redirections || first.elements[0]?.kind !== 'literal') return null;
  let source = '', force = false, name = false, sawPath = false, kind = 'all';
  for (let i = 1; i < first.elements.length; i++) {
    const item = first.elements[i];
    if (item.kind === 'literal' && !source) { source = item.value; continue; }
    if (item.kind !== 'parameter') return null;
    const key = String(item.name || '').toLowerCase();
    if (key === 'force' || key === 'name') {
      if (item.argumentType || (key === 'force' ? force : name)) return null;
      if (key === 'force') force = true; else name = true;
    } else if ((key === 'file' || key === 'directory') && kind === 'all' && !item.argumentType) {
      kind = key;
    } else if (key === 'path' && !sawPath && !source) {
      sawPath = true;
      if (item.argumentType) {
        if (!['StringConstantExpressionAst', 'ConstantExpressionAst'].includes(item.argumentType) || typeof item.value !== 'string') return null;
        source = item.value;
      } else {
        const next = first.elements[++i];
        if (next?.kind !== 'literal') return null;
        source = next.value;
      }
    } else return null;
  }
  if (typeof source !== 'string' || !/^[a-z]:[\\/]/i.test(source) || source.includes('`') ||
      source.split(/[\\/]+/).some((part, index, all) => part === '..' && all.slice(0, index).some(value => /[*?\[\]]/.test(value)))) return null;
  const absolute = win.resolve(source), directory = win.dirname(absolute), pattern = win.basename(absolute);
  const body = { schemaVersion: 1, directory, pattern, force, kind, output: name ? 'name' : 'select', properties: [], formatTable: false };
  const plainOutString = entry => entry && String(entry.name || '').toLowerCase() === 'out-string' && entry.invocation === 'Unknown' &&
    entry.pipelineInput === true && !entry.redirections && entry.elements.length === 1;
  if (name) return (ast.commands.length === 1 || (ast.commands.length === 2 && plainOutString(select))) && validRequest(body) ? body : null;
  if (!select || (ast.commands.length === 2 && plainOutString(select))) {
    body.output = 'default'; body.properties = ['Mode','LastWriteTime','Length','Name']; body.formatTable = true;
    return validRequest(body) ? body : null;
  }
  if (!select || String(select.name || '').toLowerCase() !== 'select-object' || select.invocation !== 'Unknown' ||
      select.pipelineInput !== true || select.redirections) return null;
  const values = select.elements.slice(1);
  if (values.length === 2 && values[0].kind === 'parameter' && String(values[0].name || '').toLowerCase() === 'property' && !values[0].argumentType) values.shift();
  if (values.length !== 1) return null;
  body.properties = values[0].kind === 'literal' ? [values[0].value]
    : values[0].kind === 'literal_list' ? values[0].values : [];
  let index = 2;
  const format = ast.commands[index];
  if (format && ['format-table', 'ft'].includes(String(format.name || '').toLowerCase())) {
    if (format.invocation !== 'Unknown' || format.pipelineInput !== true || format.redirections || format.elements.length !== 2 ||
        format.elements[1].kind !== 'parameter' || String(format.elements[1].name || '').toLowerCase() !== 'autosize' || format.elements[1].argumentType) return null;
    body.formatTable = true; index++;
  }
  const out = ast.commands[index];
  if (out) {
    if (String(out.name || '').toLowerCase() !== 'out-string' || out.invocation !== 'Unknown' ||
        out.pipelineInput !== true || out.redirections || out.elements.length !== 1) return null;
    index++;
  }
  return index === ast.commands.length && validRequest(body) ? body : null;
}

export async function buildWindowsWildcardNameBridge({ approval, state, helperPath } = {}) {
  const params = approval?.params || {}, input = params.input;
  if (approval?.providerMethod !== 'can_use_tool' || approval?.kind !== 'command' || params.tool_name !== 'PowerShell' ||
      !input || typeof input !== 'object' || Array.isArray(input) || state?.turnActive !== true || state.riskContextValid !== true ||
      !['recommended', 'full-auto'].includes(state.riskMode) || state.interactionMode === 'plan' || state.permissionMode === 'plan' ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions ||
      Object.keys(input).some(key => !['command','description','timeout','run_in_background','dangerouslyDisableSandbox'].includes(key)) ||
      (input.dangerouslyDisableSandbox !== undefined && input.dangerouslyDisableSandbox !== false) ||
      typeof input.command !== 'string' || input.command.length > 128 * 1024 ||
      !/[*?\[]/.test(input.command) || !win.isAbsolute(helperPath || '')) return null;
  try {
    const binary = await lstat(helperPath);
    if (!binary.isFile() || binary.isSymbolicLink()) return null;
    const body = parseListingCommands(await parseWindowsPowerShellAst(input.command));
    const risk = body && await allowedDirectory(body, state, helperPath);
    if (!risk) return null;
    const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    const updatedCommand = listingCommand(helperPath, encoded);
    return updatedCommand.length <= 30000 ? { updatedCommand, request: body, risk } : null;
  } catch { return null; }
}

export async function buildCodexWindowsWildcardNameHookDecision({ event, state, runId, helperPath } = {}) {
  const input = event?.tool_input, allowed = new Set(['command','timeout_ms','yield_time_ms','max_output_chars','max_output_tokens']);
  if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'Bash' || typeof event.tool_use_id !== 'string' ||
      !event.tool_use_id.trim() || event.tool_use_id.length > 1024 || !runId || !win.isAbsolute(event.cwd || '') ||
      !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key) ||
        (key !== 'command' && (!Number.isSafeInteger(input[key]) || input[key] < 0))) || typeof input.command !== 'string' ||
      event.permission_mode === 'plan' || event.permission_mode === 'bypassPermissions' || event.additionalPermissions ||
      event.additional_permissions || event.networkApprovalContext || event.network_approval_context) return {};
  const approval = { kind: 'command', providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: input.command } } };
  const bridge = await buildWindowsWildcardNameBridge({ approval, state: { ...state, cwd: event.cwd, turnActive: true }, helperPath });
  return bridge ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, command: bridge.updatedCommand } } } : {};
}

export async function verifyCodexWindowsWildcardNameApproval({ approval, state, helperPath } = {}) {
  const params = approval?.params || {};
  if (approval?.providerMethod !== 'item/commandExecution/requestApproval' || approval?.kind !== 'command' ||
      state?.startedTurn !== true || state?.riskContextValid !== true || !['recommended', 'full-auto'].includes(state?.riskMode) ||
      state?.interactionMode === 'plan' || state?.permissionMode === 'plan' || !state?.threadId || params.threadId !== state.threadId ||
      !state?.turnId || params.turnId !== state.turnId || !win.isAbsolute(params.cwd || '') ||
      typeof params.itemId !== 'string' || !params.itemId || params.itemId.length > 1024 ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions ||
      !win.isAbsolute(helperPath || '')) return false;
  try {
    const binary = await lstat(helperPath);
    if (!binary.isFile() || binary.isSymbolicLink()) return false;
    const invocation = readWindowsPowerShellInvocation({ providerMethod: approval.providerMethod, params: { command: decodeCodexShlexArgv(params.command) } });
    let command = invocation?.command || '';
    const prefix = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';
    if (command.startsWith(prefix)) command = command.slice(prefix.length);
    if (command.length > 30000) return false;
    const encoded = /--list-json '([A-Za-z0-9_-]+)'/.exec(command)?.[1];
    if (!encoded || command !== listingCommand(helperPath, encoded)) return false;
    const data = Buffer.from(encoded, 'base64url');
    if (data.toString('base64url') !== encoded) return false;
    const body = JSON.parse(data.toString('utf8'));
    return Boolean(validRequest(body) && await allowedDirectory(body, { ...state, cwd: params.cwd, turnActive: true }, helperPath));
  } catch { return false; }
}
