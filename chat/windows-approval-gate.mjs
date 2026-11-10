import path from 'node:path';
import { analyzeWindowsFileChanges, analyzeWindowsPowerShell, decideWindowsPowerShellActions } from './windows-powershell-actions.mjs';
import { analyzeWindowsBash, parseLiteralBashWords } from './windows-bash-actions.mjs';
import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';
import { isKnownFileGate } from './privileged-gate.mjs';
import { resolveWindowsSystemPaths } from './windows-system-paths.mjs';
import { decideClaudeToolApproval } from './claude-tool-policy.mjs';

const win = path.win32;
const text = (value) => typeof value === 'string' ? value.trim() : '';

// Codex app-server serializes its executable argv using shlex_join. Decode
// that representation as data, not as PowerShell (or as a shell to execute).
// Shell operators outside quotes are not produced by shlex_join and fail
// closed. Backslashes in single-quoted Windows paths remain literal.
export function decodeCodexShlexArgv(input) {
  if (typeof input !== 'string' || !input || input.length > 128 * 1024) return null;
  const argv = []; let word = ''; let started = false; let quote = '';
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (quote === "'") {
      if (c === "'") quote = ''; else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') { quote = ''; continue; }
      if (c === '\\' && i + 1 < input.length && /[\\"$`]/.test(input[i + 1])) { word += input[++i]; continue; }
      word += c; continue;
    }
    if (/\s/.test(c)) { if (started) { argv.push(word); word = ''; started = false; } continue; }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === '\\') { if (++i >= input.length) return null; word += input[i]; started = true; continue; }
    if (/[;&|<>`$(){}]/.test(c)) return null;
    word += c; started = true;
  }
  if (quote) return null;
  if (started) argv.push(word);
  return argv.length ? argv : null;
}

/** Resolve only an explicitly identified PowerShell invocation; never guess Bash is PowerShell. */
export function readWindowsPowerShellInvocation(approval, { systemRoot = resolveWindowsSystemPaths()?.root || '', programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || '' } = {}) {
  const params = approval?.params || {};
  const shellKind = text(params.shellKind || params.shell_kind || params.shell).toLowerCase();
  const command = params.command;
  const legacy = win.isAbsolute(systemRoot) ? win.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';
  const modern = win.isAbsolute(programFiles) ? win.join(programFiles, 'PowerShell', '7', 'pwsh.exe') : '';
  if (Array.isArray(command) && command.length >= 3 && command.every((x) => typeof x === 'string')) {
    const name = win.basename(command[0]).toLowerCase();
    if (!['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(name)) return null;
    const executable = name.startsWith('pwsh') ? modern : legacy;
    if (!executable || !win.isAbsolute(command[0]) || win.resolve(command[0]).toLowerCase() !== win.resolve(executable).toLowerCase()) return null;
    const commandFlag = command.findIndex((x, i) => i > 0 && /^-(?:command|c)$/i.test(x));
    if (commandFlag < 1 || commandFlag !== command.length - 2) return null;
    const flags = command.slice(1, commandFlag);
    if (!flags.some((x) => /^-noprofile$/i.test(x)) || flags.some((x) => !/^-(?:noprofile|nologo|noninteractive)$/i.test(x))) return null;
    return { command: command[commandFlag + 1], executable };
  }
  if (typeof command !== 'string' || !['powershell', 'powershell-5.1', 'pwsh'].includes(shellKind)) return null;
  // A shell name supplied with a raw command does not prove the actual binary
  // or startup options. A future run-bound identity attestation can admit it.
  return null;
}

async function readExplicitPowerShellWrapper(approval, options = {}) {
  // Claude's native PowerShell tool identifies the shell and script, but its
  // request does not attest the shell's current directory.
  if (approval?.providerMethod === 'can_use_tool' && approval?.params?.tool_name === 'PowerShell') {
    const script = approval?.params?.input?.command;
    return typeof script === 'string' && script.trim() ? { command: script } : null;
  }
  const direct = readWindowsPowerShellInvocation(approval, options);
  if (direct) return direct;
  const raw = approval?.params?.command;
  if (typeof raw !== 'string' || raw.length > 128 * 1024) return null;
  if (approval?.providerMethod === 'item/commandExecution/requestApproval') {
    const argv = decodeCodexShlexArgv(raw);
    if (!argv) return null;
    const decoded = readWindowsPowerShellInvocation({ ...approval, params: { ...approval.params, command: argv } }, options);
    if (!decoded) return null;
    const utf8Prefix = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';
    if (decoded.command.startsWith(utf8Prefix)) decoded.command = decoded.command.slice(utf8Prefix.length);
    return decoded;
  }
  let outer;
  try { outer = await parseWindowsPowerShellAst(raw); } catch { return null; }
  if (outer.errors.length || outer.dynamicNodes.length || outer.commands.length !== 1) return null;
  const item = outer.commands[0];
  if (item.redirections || !['Unknown', 'Ampersand'].includes(item.invocation)) return null;
  const argv = [];
  for (const element of item.elements) {
    if (element.kind === 'literal') argv.push(String(element.value));
    else if (element.kind === 'parameter') {
      argv.push(`-${element.name}`);
      if (element.argumentType) {
        if (!['StringConstantExpressionAst', 'ConstantExpressionAst'].includes(element.argumentType)) return null;
        argv.push(String(element.value));
      }
    } else return null;
  }
  return readWindowsPowerShellInvocation({ ...approval, params: { ...approval.params, command: argv } }, options);
}

export async function decideWindowsApproval(approval, state = {}, { analyze = analyzeWindowsPowerShell, analyzeFiles = analyzeWindowsFileChanges, invocationReader = readExplicitPowerShellWrapper } = {}) {
  const params = approval?.params || {};
  const toolName = text(params.tool_name);
  const mode = text(state.riskMode);
  const conservative = mode === 'safe' || mode === 'conservative-auto';
  const riskContext = state.riskContext || {};
  const requestCwd = text(params.cwd);
  if (requestCwd && !win.isAbsolute(requestCwd)) return { decision: 'prompt', reason: 'command working directory is not absolute' };
  const context = {
    ...riskContext,
    cwd: requestCwd || state.cwd,
    trustedWorkspaceRoot: riskContext.trustedWorkspaceRoot || '',
    requireAbsolutePaths: approval?.providerMethod === 'can_use_tool',
  };
  // These requests can grant more than execution of the displayed command.
  // Command classification alone cannot authorize additional permissions.
  if (params.networkApprovalContext || params.network_approval_context
      || params.additionalPermissions || params.additional_permissions) {
    return { decision: 'prompt', reason: 'additional permissions require owner approval' };
  }
  const claudeToolDecision = decideClaudeToolApproval(approval, { riskMode: mode });
  if (claudeToolDecision) return claudeToolDecision;
  if (state.riskContextValid === false) return { decision: 'prompt', reason: 'run path context is unavailable' };
  let result; let command = ''; let platform = 'powershell';
  if (isKnownFileGate(approval, toolName)) {
    if (text(params.grantRoot)) return { decision: 'prompt', reason: 'a continuing file permission grant requires owner approval' };
    const input = params.input || {};
    const activeItem = text(params.itemId) && state.activeItems instanceof Map ? state.activeItems.get(text(params.itemId)) : null;
    if (approval?.providerMethod === 'item/fileChange/requestApproval'
        && (!activeItem || activeItem.type !== 'fileChange')) {
      return { decision: 'prompt', reason: 'matching active file change is unavailable' };
    }
    const providerChanges = Array.isArray(activeItem?.changes) ? activeItem.changes : params.changes;
    const rawChanges = Array.isArray(providerChanges) ? providerChanges
      : providerChanges && typeof providerChanges === 'object'
        ? Object.entries(providerChanges).map(([file, change]) => ({ ...(change || {}), path: file })) : [];
    const filePath = text(input.file_path || input.path || input.notebook_path);
    const entries = rawChanges.length ? rawChanges.flatMap((change) => {
      const kind = text(typeof change.kind === 'object' ? change.kind?.type : change.kind || change.type).toLowerCase();
      const source = text(change.path || change.file_path);
      const movePath = text(change.kind?.move_path || change.kind?.movePath || change.move_path || change.movePath);
      if (movePath) return [{ path: source, kind: 'delete' }, { path: movePath, kind: 'write' }];
      return [{ path: source, kind: ['delete', 'remove'].includes(kind) ? 'delete' : ['add', 'create', 'update', 'modify', 'write'].includes(kind) ? 'write' : 'unknown' }];
    })
      : filePath ? [{ path: filePath, kind: ['Read', 'Glob', 'Grep', 'LS', 'List'].includes(toolName) ? 'read' : 'write' }]
        : [];
    if (entries.length > 10000 || entries.some((entry) => !entry.path || entry.kind === 'unknown')) return { decision: 'prompt', reason: 'file change details are incomplete or too large' };
    if (approval?.providerMethod === 'item/fileChange/requestApproval' && entries.some((entry) => entry.kind === 'delete')) {
      return { decision: 'prompt', reason: 'Codex file deletion requires owner review' };
    }
    result = await analyzeFiles(entries, context);
  } else {
    if (approval?.kind !== 'command') return { decision: 'prompt', reason: 'non-command request requires owner decision' };
    if (approval?.providerMethod === 'can_use_tool' && toolName === 'Bash') {
      command = typeof params.input?.command === 'string' ? params.input.command : '';
      // Claude on Windows exposes a Bash tool. When it explicitly invokes
      // the trusted system PowerShell, parse the quoted inner script using
      // the native PowerShell AST. Bare shell names and MSYS drive mappings
      // do not attest which executable Bash will actually run.
      const argv = parseLiteralBashWords(command);
      const invocation = argv ? readWindowsPowerShellInvocation({ params: { command: argv } }) : null;
      if (invocation) {
        platform = 'powershell';
        result = await analyze(invocation.command, context, { executable: invocation.executable });
      } else {
        platform = 'bash';
        result = await analyzeWindowsBash(command, context);
      }
    } else {
    const invocation = await invocationReader(approval);
    if (!invocation) return { decision: 'prompt', reason: 'Windows shell or command identity cannot be verified' };
    command = invocation.command;
    result = await analyze(command, context, { executable: invocation.executable });
    }
  }
  const decision = decideWindowsPowerShellActions(result, { conservative });
  const tier = decision.decision === 'allow' ? 'safe' : 'caution';
  return {
    decision: decision.decision === 'allow' ? 'auto-allow' : 'prompt',
    reason: decision.reason,
    command,
    risk: { tier, platform, policyVersion: 'windows-approval/v1',
      confidence: result.complete ? 'high' : 'unknown',
      signals: { reasons: [decision.reason], targetScope: decision.action?.workspace ? 'trusted-workspace' : 'outside-workspace' },
      reasons: [{ code: result.complete ? 'windows_operation' : 'windows_analysis_incomplete', message: decision.reason }],
      actions: result.actions },
  };
}
