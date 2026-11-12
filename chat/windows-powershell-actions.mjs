import path from 'node:path';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';
import { systemPathRootsForPlatform } from './risk-policy.mjs';
import { analyzeWindowsLocalGit, analyzeWindowsReadOnlyGit } from './windows-readonly-git.mjs';

const win = path.win32;
export const RIPGREP_SENSITIVE_EXCLUSIONS = Object.freeze([
  '!**/.env', '!**/.env.*', '!**/ntuser.dat*',
  ...['.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.agentoc', 'System Volume Information', '$Recycle.Bin']
    .flatMap(name => [`!**/${name}`, `!**/${name}/**`]),
  ...['Credentials', 'Protect'].flatMap(name => [`!**/AppData/Local/Microsoft/${name}/**`, `!**/AppData/Roaming/Microsoft/${name}/**`]),
  '!**/Windows/System32/config/**', '!**/Windows/System32/Microsoft/Protect/**',
]);
export const ripgrepSafePrefix = () => ['--no-config', ...RIPGREP_SENSITIVE_EXCLUSIONS.flatMap(value => ['--iglob', `'${value}'`])].join(' ');
const VERSION_PROGRAMS = new Set(['python', 'python3', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'git', 'go', 'cargo', 'rustc', 'dotnet', 'java', 'javac', 'gh']);
export function analyzeWindowsVersion(programName, args) {
  const program = String(programName || '').toLowerCase().replace(/\.(?:exe|cmd)$/, '');
  if (!VERSION_PROGRAMS.has(program) || !Array.isArray(args) || args.length !== 1) return null;
  const flag = args[0];
  if (flag !== '--version' && !(flag === '-V' && ['python', 'python3', 'pip', 'pip3'].includes(program))
      && !(flag === '-version' && ['java', 'javac'].includes(program))
      && !(flag === 'version' && program === 'go')) return null;
  return { kind: 'read', program: `${program} version`, target: null };
}
const FILE_COMMANDS = new Map([
  ['get-content', 'read'], ['get-item', 'read'], ['get-childitem', 'read'], ['get-filehash', 'read'], ['test-path', 'read'], ['resolve-path', 'read'],
  ['set-content', 'write'], ['add-content', 'write'], ['clear-content', 'write'], ['new-item', 'write'], ['out-file', 'write'], ['remove-item', 'delete'],
  ['mkdir', 'write'],
  ['copy-item', 'copy'], ['move-item', 'move'], ['rename-item', 'rename'],
]);
const BUILTIN_ALIASES = new Map([
  ['cat', 'get-content'], ['gc', 'get-content'], ['type', 'get-content'],
  ['clc', 'clear-content'],
  ['ls', 'get-childitem'], ['dir', 'get-childitem'], ['gci', 'get-childitem'],
  ['cp', 'copy-item'], ['copy', 'copy-item'], ['cpi', 'copy-item'],
  ['mv', 'move-item'], ['move', 'move-item'], ['mi', 'move-item'],
  ['ren', 'rename-item'], ['rni', 'rename-item'],
  ['rm', 'remove-item'], ['del', 'remove-item'], ['ri', 'remove-item'],
  ['echo', 'write-output'], ['write', 'write-output'], ['sort', 'sort-object'], ['ft', 'format-table'], ['fl', 'format-list'],
  ['where', 'where-object'], ['?', 'where-object'],
]);
const FILTERS = new Set(['select-object', 'sort-object', 'format-table', 'format-list', 'measure-object', 'out-null', 'out-string', 'write-output', 'get-date', 'get-location', 'get-service', 'get-process', 'get-command']);
const SAFE_FILTER_PARAMS = new Set(['first', 'last', 'skip', 'unique', 'property', 'descending', 'width', 'line', 'name', 'displayname', 'noenumerate', 'id', 'module', 'commandtype', 'all', 'listimported', 'includeusername', 'autosize']);
const SAFE_FILTER_SWITCHES = new Set(['unique', 'descending', 'noenumerate', 'all', 'listimported', 'includeusername', 'autosize']);
const WORKSPACE_SCRIPT_TASKS = new Set(['build', 'check', 'format:check', 'format-check', 'lint', 'test', 'test:ci', 'test:unit', 'typecheck', 'type-check']);
const WORKSPACE_SCRIPT_RUNNERS = new Set(['npm', 'npm.cmd', 'npm.exe', 'pnpm', 'pnpm.cmd', 'pnpm.exe', 'yarn', 'yarn.cmd', 'yarn.exe', 'bun', 'bun.exe']);
const DEV_TASKS = new Map([
  ['go', new Set(['build', 'test', 'vet', 'run'])], ['cargo', new Set(['build', 'check', 'test', 'run', 'fmt', 'clippy'])],
  ['dotnet', new Set(['build', 'test', 'restore', 'run', 'format'])], ['gradle', new Set(['build', 'test', 'assemble', 'check'])],
  ['mvn', new Set(['test', 'verify', 'package', 'compile'])], ['npx', new Set(['tsc', 'eslint', 'prettier', 'jest', 'vitest', 'vite', 'webpack'])],
]);
const GET_COMMAND_TYPES = new Set(['alias', 'function', 'filter', 'cmdlet', 'externalscript', 'application', 'script', 'configuration', 'all']);
const FILE_PARAMS = new Set(['path', 'literalpath', 'destination', 'value', 'itemtype', 'name', 'recurse', 'force', 'raw', 'encoding', 'filter', 'include', 'exclude', 'confirm']);
const SWITCHES = new Set(['recurse', 'force', 'raw', 'confirm']);
const CONTENT_READ_PARAMS = new Set([...FILE_PARAMS, 'totalcount', 'tail', 'readcount', 'delimiter', 'asbytestream']);
const CONTENT_READ_SWITCHES = new Set([...SWITCHES, 'asbytestream']);
const CONTENT_WRITE_PARAMS = new Set([...FILE_PARAMS, 'nonewline', 'asbytestream']);
const CONTENT_WRITE_SWITCHES = new Set([...SWITCHES, 'nonewline', 'asbytestream']);
const CHILD_ITEM_PARAMS = new Set([...FILE_PARAMS, 'file', 'directory', 'hidden', 'readonly', 'system', 'attributes', 'depth']);
const CHILD_ITEM_SWITCHES = new Set([...SWITCHES, 'name', 'file', 'directory', 'hidden', 'readonly', 'system']);
const OUT_FILE_PARAMS = new Set(['filepath', 'literalpath', 'append', 'force', 'noclobber', 'nonewline', 'width', 'encoding', 'inputobject']);
const OUT_FILE_SWITCHES = new Set(['append', 'force', 'noclobber', 'nonewline']);
const MKDIR_PARAMS = new Set(['path', 'force']);
const MKDIR_SWITCHES = new Set(['force']);
const RENAME_PARAMS = new Set(['path', 'literalpath', 'newname', 'force', 'passthru']);
const RENAME_SWITCHES = new Set(['force', 'passthru']);
const SENSITIVE_COMPONENT = /^(?:\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.agentoc|\.env(?:\..*)?|system volume information|\$recycle\.bin)$/i;
// Credential stores are sensitive for every Windows profile, not just the
// account running AgentoC. Match the Windows profile structure while leaving
// unrelated AppData paths and ordinary files outside a workspace usable.
const WINDOWS_PROFILE_SENSITIVE = /(?:^|\\)(?:ntuser\.dat(?:\.log\d*)?|appdata\\(?:local|roaming)\\microsoft\\(?:credentials|protect))(?:\\|$)/i;
const WINDOWS_SYSTEM_SENSITIVE = /(?:^|\\)windows\\system32\\(?:config|microsoft\\protect)(?:\\|$)/i;
const lacksAttestedAbsolutePath = (raw, context) => context.requireAbsolutePaths && typeof raw === 'string' && !/^[a-z]:[\\/]/i.test(raw);

function inside(candidate, root) {
  if (!candidate || !root) return false;
  const relative = win.relative(win.resolve(root), win.resolve(candidate));
  return !relative || (!relative.startsWith('..' + win.sep) && relative !== '..' && !win.isAbsolute(relative));
}

function parseArguments(elements, allowed, switches = new Set()) {
  const named = new Map(); const positional = [];
  for (let i = 1; i < elements.length; i += 1) {
    const element = elements[i];
    if (element.kind === 'literal') { positional.push(String(element.value)); continue; }
    if (element.kind !== 'parameter') return null;
    const key = String(element.name || '').toLowerCase();
    if (!allowed.has(key) || named.has(key)) return null;
    if (switches.has(key)) {
      if (key === 'confirm' && element.argumentType === 'StaticConfirmFalse' && element.value === 'false') {
        named.set(key, false); continue;
      }
      if (key === 'confirm') return null;
      if (element.argumentType || element.value != null) return null;
      named.set(key, true); continue;
    }
    if (element.argumentType) {
      if (!['StringConstantExpressionAst', 'ConstantExpressionAst'].includes(element.argumentType)) return null;
      named.set(key, String(element.value ?? '')); continue;
    }
    const value = elements[++i];
    if (!value || value.kind !== 'literal') return null;
    named.set(key, String(value.value));
  }
  return { named, positional };
}

export function staticExternalArguments(elements) {
  const args = [];
  for (const element of elements.slice(1)) {
    if (element.kind === 'literal') { args.push(String(element.value)); continue; }
    if (element.kind !== 'parameter') return null;
    args.push(`-${String(element.name || '')}`);
    if (element.argumentType) {
      if (!['StringConstantExpressionAst', 'ConstantExpressionAst'].includes(element.argumentType)) return null;
      args.push(String(element.value ?? ''));
    }
  }
  return args;
}

function isWingetListQuery(program, args) {
  if (!['winget', 'winget.exe'].includes(program) || !Array.isArray(args) ||
      String(args[0]).toLowerCase() !== 'list') return false;
  const switches = new Set(['--exact', '-e', '--disable-interactivity']);
  const options = new Set(['--id', '--name', '--moniker', '--source', '-s', '--count', '-n']);
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i].toLowerCase();
    if (switches.has(arg)) continue;
    if (!options.has(arg) || !args[i + 1] || args[i + 1].startsWith('-')) return false;
    i += 1;
  }
  return true;
}

export function readOnlyRipgrepArgs(rawArgs) {
  const args = [...rawArgs]; let filesOnly = false; let selectsFiles = false; let configDisabled = false; let lastSelector = -1; const patterns = []; const positional = []; const exclusions = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') { positional.push(...args.slice(index + 1)); break; }
    if (arg === '--files') { filesOnly = true; continue; }
    if (arg === '--no-config') { configDisabled = true; continue; }
    if (['--hidden', '--no-ignore', '--no-ignore-vcs', '--no-ignore-dot', '--no-ignore-parent', '--no-ignore-global', '--no-ignore-exclude', '-u', '-uu'].includes(arg)) continue;
    if (['-n', '--line-number', '-i', '--ignore-case', '-S', '--smart-case', '-s', '--case-sensitive', '-F', '--fixed-strings', '-l', '--files-with-matches', '-c', '--count', '-w', '--word-regexp', '-o', '--only-matching', '-H', '--with-filename', '-I', '--no-filename', '--no-heading', '--color=never'].includes(arg)) continue;
    if (['-e', '--regexp'].includes(arg)) {
      const pattern = args[++index];
      if (!pattern) return null;
      patterns.push(pattern);
      continue;
    }
    if (arg.startsWith('--regexp=')) { const pattern = arg.slice('--regexp='.length); if (!pattern) return null; patterns.push(pattern); continue; }
    if (['-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not'].includes(arg)) {
      const value = args[++index];
      if (!value) return null;
      if (arg === '--iglob' && value.startsWith('!')) exclusions.set(value.toLowerCase(), index);
      if (!['-g', '--glob', '--iglob'].includes(arg) || !value.startsWith('!')) { selectsFiles = true; lastSelector = index; }
      continue;
    }
    if (/^--(?:glob|type|type-not)=/.test(arg)) {
      const offset = arg.indexOf('='); const value = arg.slice(offset + 1);
      if (!value) return null;
      if (!arg.startsWith('--glob=') || !value.startsWith('!')) { selectsFiles = true; lastSelector = index; }
      continue;
    }
    if (arg === '--max-count' || arg === '-m') { if (!/^\d+$/.test(args[++index] || '')) return null; continue; }
    if (/^(?:--max-count|-m)=?\d+$/.test(arg)) continue;
    if (/^-(?:[niFsSlcwHoI])+$/.test(arg)) continue;
    if (arg.startsWith('-')) return null;
    positional.push(arg);
  }
  if (filesOnly && patterns.length) return null;
  if (!filesOnly && !patterns.length) {
    if (!positional.length || positional[0].startsWith('-')) return null;
    patterns.push(positional.shift());
  }
  if (positional.some((value) => !value || value === '-')) return null;
  return { filesOnly, selectsFiles, configDisabled, exclusionsEnforced: RIPGREP_SENSITIVE_EXCLUSIONS.every(value => exclusions.has(value.toLowerCase())),
    exclusionsAfterSelectors: RIPGREP_SENSITIVE_EXCLUSIONS.every(value => (exclusions.get(value.toLowerCase()) ?? -1) > lastSelector), paths: positional.length ? positional : ['.'] };
}

export async function analyzeWindowsRipgrep(args, context = {}, {
  fsApi = { lstat, realpath, readdir }, pathResolver = (value) => value,
} = {}) {
  const parsed = Array.isArray(args) && readOnlyRipgrepArgs(args);
  if (!parsed || parsed.paths.length > 64) return { complete: false, actions: [], reason: 'ripgrep options or paths need review' };
  // RIPGREP_CONFIG_PATH may otherwise enable hidden files, symlink following,
  // or a preprocessor even when none of those options appear in this request.
  if (!parsed.configDisabled) return { complete: false, actions: [], reason: 'ripgrep configuration is not disabled' };
  const actions = [];
  for (const rawPath of parsed.paths) {
    const resolvedPath = pathResolver(rawPath);
    if (!resolvedPath) return { complete: false, actions, reason: 'ripgrep path cannot be resolved' };
    const target = await resolveTarget(resolvedPath, context.cwd, fsApi, context);
    if (!target) return { complete: false, actions, reason: 'ripgrep path cannot be resolved' };
    const workspace = inside(target.lexical, context.trustedWorkspaceRoot) && inside(target.actual, context.trustedWorkspaceRoot);
    const protectedDescendant = (context.protectedRoots || []).some((root) => {
      const path = typeof root === 'string' ? root : root?.path;
      return typeof path === 'string' && inside(path, target.actual);
    });
    const action = { kind: 'read', program: 'rg', target, protected: isProtected(target, context,
      { allowProgramDataWorkspaceRead: true, allowOrdinarySystemRead: target.file === true }), workspace, workspaceRoot: Boolean(context.trustedWorkspaceRoot)
        && win.resolve(target.actual).toLowerCase() === win.resolve(context.trustedWorkspaceRoot).toLowerCase(),
      recursive: target.directory === true };
    if (action.recursive && !parsed.exclusionsEnforced) {
      return { complete: false, actions, reason: 'ripgrep sensitive exclusions are not enforced' };
    }
    if (action.recursive && !protectedDescendant && parsed.exclusionsEnforced && (!parsed.selectsFiles || parsed.exclusionsAfterSelectors)) {
      // Default ripgrep traversal skips hidden/ignored paths and does not
      // follow symlinks. Positive glob/type selectors can override that
      // default and include hidden files, so they must inspect the tree.
      action.recursiveVerified = true;
    } else if (action.recursive) {
      action.recursiveVerified = await inspectRecursiveTarget(target, context, fsApi,
        { allowWorkspaceRoot: true, requireWorkspace: false, allowProgramDataWorkspaceRead: true });
    }
    actions.push(action);
  }
  return { complete: true, actions };
}

export async function analyzeWindowsWorkspaceScriptTask(programName, rawArgs, context = {}, {
  fsApi = { lstat, realpath, readdir }, pathResolver = (value) => value,
} = {}) {
  const program = String(programName || '').toLowerCase();
  const args = Array.isArray(rawArgs) && rawArgs.every((arg) => typeof arg === 'string') ? rawArgs : null;
  if (!args || !win.isAbsolute(context.cwd || '')) return null;
  const executable = program.replace(/\.(?:exe|cmd|bat)$/, '');
  if (args.length && DEV_TASKS.get(executable)?.has(args[0].toLowerCase())) {
    if (executable === 'go' && args.slice(1).some(arg => /^-exec(?:=|$)/i.test(arg))) return null;
    return { kind: 'read', program: `${executable} ${args[0]}`, target: null, workspace: inside(context.cwd, context.trustedWorkspaceRoot || ''), caution: true };
  }
  const packageName = value => /^[a-z0-9@][a-z0-9@/_.~^+\-\[\],=<>!]*$/i.test(value);
  const pipArgs = ['pip', 'pip.exe', 'pip3', 'pip3.exe'].includes(program) ? args
    : ['python', 'python.exe', 'python3', 'python3.exe'].includes(program) && args[0] === '-m' && args[1]?.toLowerCase() === 'pip' ? args.slice(2) : null;
  if (pipArgs && pipArgs[0]?.toLowerCase() === 'install' && pipArgs.length > 1 && pipArgs.slice(1).every(packageName)) {
    return { kind: 'read', program: `${program} install packages`, target: null, workspace: inside(context.cwd, context.trustedWorkspaceRoot || ''), caution: true };
  }
  if (WORKSPACE_SCRIPT_RUNNERS.has(program)) {
    let task = '';
    if (args.length === 1 && ['test', 'install', 'i', 'ci'].includes(args[0].toLowerCase())) task = args[0].toLowerCase();
    else if (['install', 'i', 'add'].includes(args[0]?.toLowerCase()) && args.length > 1 && args.slice(1).every(packageName)) task = 'install';
    else if (args.length >= 2 && args[0].toLowerCase() === 'run') task = args[1].toLowerCase();
    else if (program.startsWith('yarn') && args.length === 1) task = args[0].toLowerCase();
    else if (program.startsWith('bun') && args.length === 1 && args[0].toLowerCase() === 'test') task = 'test';
    if (!WORKSPACE_SCRIPT_TASKS.has(task) && !/^[a-z0-9][a-z0-9:_-]{0,127}$/.test(task)) return null;
    return { kind: 'read', program: `${program} ${task}`, target: null, workspace: inside(context.cwd, context.trustedWorkspaceRoot || ''), caution: true };
  }
  if (['python', 'python.exe', 'python3', 'python3.exe'].includes(program)
      && args.length >= 2 && args[0] === '-m' && ['pytest', 'unittest'].includes(args[1].toLowerCase())) {
    return { kind: 'read', program: `${program} -m ${args[1]}`, target: null, workspace: inside(context.cwd, context.trustedWorkspaceRoot || ''), caution: true };
  }
  const scriptExtensions = ['node', 'node.exe'].includes(program) ? /\.(?:c|m)?js$/i
    : ['python', 'python.exe', 'python3', 'python3.exe'].includes(program) ? /\.py$/i : null;
  if (scriptExtensions && args.length >= 1 && !args[0].startsWith('-')) {
    const scriptPath = pathResolver(args[0]);
    if (!scriptPath) return null;
    const script = await resolveTarget(scriptPath, context.cwd, fsApi, context);
    if (!script || !script.file
        || isProtected(script, context) || !scriptExtensions.test(script.actual)) return null;
    return { kind: 'read', program: `${program} script`, target: script, workspace: inside(script.lexical, context.trustedWorkspaceRoot || '') && inside(script.actual, context.trustedWorkspaceRoot || ''), caution: true };
  }
  return null;
}

async function analyzeRipgrepCommand(entry, context, fsApi) {
  if (!['rg', 'rg.exe'].includes(String(entry.name || '').toLowerCase())) return null;
  if (entry.invocation !== 'Unknown' || entry.pipelineInput !== false || entry.redirections) {
    return { complete: false, actions: [], reason: 'ripgrep invocation is not a standalone static read' };
  }
  const args = staticExternalArguments(entry.elements);
  return analyzeWindowsRipgrep(args, context, { fsApi });
}

async function analyzeWorkspaceScriptTask(entry, context, fsApi) {
  if (entry.invocation !== 'Unknown' || entry.pipelineInput !== false || entry.redirections) return null;
  const args = staticExternalArguments(entry.elements);
  return analyzeWindowsWorkspaceScriptTask(entry.name, args, context, { fsApi });
}

async function resolveTarget(raw, cwd, fsApi, context = {}) {
  if (typeof raw !== 'string' || !raw || /[*?\[\]`$]/.test(raw) || /^[~]/.test(raw)
      || typeof cwd !== 'string' || !win.isAbsolute(cwd)
      || /^(?:\\\\[?.]\\|\\\\)/.test(raw) || /^[a-z]:[^\\/]/i.test(raw)) return null;
  if (context.requireAbsolutePaths && !/^[a-z]:[\\/]/i.test(raw)) return null;
  const absolute = win.resolve(cwd, raw);
  if (!win.isAbsolute(absolute) || !/^[a-z]:\\/i.test(absolute)) return null;
  // NTFS alternate data streams and DOS device names do not identify an
  // ordinary file, even when the surrounding path looks like a workspace.
  // Trailing dots/spaces may alias a different Win32 path after normalization.
  const components = absolute.slice(3).split('\\');
  if (absolute.slice(2).includes(':') || components.some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) return null;
  let existing = absolute; const suffix = [];
  for (;;) {
    try {
      const info = await fsApi.lstat(existing);
      const resolved = await fsApi.realpath(existing);
      return { lexical: absolute, actual: win.resolve(resolved, ...suffix.reverse()),
        exists: suffix.length === 0, directory: suffix.length === 0 && info.isDirectory(),
        file: suffix.length === 0 && info.isFile() };
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      const parent = win.dirname(existing);
      if (parent === existing) return null;
      suffix.push(win.basename(existing)); existing = parent;
    }
  }
}

// Copy and move into an existing directory target its child named after the
// source. Inspect that child as well: it can already be a hard link or resolve
// to a protected path even when the destination directory itself is ordinary.
async function resolveCopyDestination(destination, source, context, fsApi) {
  const target = await resolveTarget(destination, context.cwd, fsApi, context);
  if (!target) return null;
  try {
    const info = await fsApi.lstat(target.actual);
    if (info.isDirectory()) {
      const name = win.basename(win.resolve(context.cwd, source));
      if (!name || name === '.' || name === '..') return null;
      return resolveTarget(win.join(target.lexical, name), context.cwd, fsApi, context);
    }
  } catch (error) { if (error?.code !== 'ENOENT') return null; }
  return target;
}

function isProtected(target, context, {
  allowProgramDataWorkspaceRead = false,
  allowShallowDirectoryListing = false,
  allowOrdinarySystemRead = false,
} = {}) {
  const protectedRoots = (context.protectedRoots || [])
    .map((root) => typeof root === 'string' ? root : root?.path)
    .filter((root) => typeof root === 'string' && root);
  const systemRoots = [...systemPathRootsForPlatform('win32'), ...(context.systemPathRoots || [])]
    .map((root) => typeof root === 'string' ? root : root?.path)
    .filter((root) => typeof root === 'string' && root);
  const workspaceRoot = typeof context.trustedWorkspaceRoot === 'string' ? context.trustedWorkspaceRoot : '';
  const programDataRoot = context.platform === 'win32' && typeof context.programDataRoot === 'string'
    ? context.programDataRoot : '';
  const boundProgramDataWorkspaceRead = allowProgramDataWorkspaceRead && programDataRoot && workspaceRoot
    && inside(target.lexical, programDataRoot) && inside(target.actual, programDataRoot)
    && inside(target.lexical, workspaceRoot) && inside(target.actual, workspaceRoot);
  return [target.lexical, target.actual].some((p) => {
    if (!allowShallowDirectoryListing && protectedRoots.some((root) => inside(p, root))) return true;
    if (systemRoots.some((root) => inside(p, root)
      && !(boundProgramDataWorkspaceRead && win.resolve(root).toLowerCase() === win.resolve(programDataRoot).toLowerCase())
      && !allowShallowDirectoryListing && !allowOrdinarySystemRead)) return true;
    return !allowShallowDirectoryListing && (WINDOWS_PROFILE_SENSITIVE.test(win.normalize(p))
      || WINDOWS_SYSTEM_SENSITIVE.test(win.normalize(p))
      || p.split(/[\\/]+/).some((part) => SENSITIVE_COMPONENT.test(part)));
  });
}

export async function analyzeWindowsFileChanges(entries, context = {}, { fsApi = { lstat, realpath, readdir } } = {}) {
  if (!Array.isArray(entries) || !entries.length) return { complete: false, actions: [], reason: 'file targets are unavailable' };
  const actions = [];
  for (const entry of entries) {
    if (!entry || !['read', 'write', 'delete'].includes(entry.kind)) {
      return { complete: false, actions, reason: 'file change operation is unknown' };
    }
    if (lacksAttestedAbsolutePath(entry.path, context)) return { complete: false, actions, reason: 'working directory is not attested' };
    const target = entry.copySource
      ? await resolveCopyDestination(entry.path, entry.copySource, context, fsApi)
      : await resolveTarget(entry.path, context.cwd, fsApi, context);
    if (!target) return { complete: false, actions, reason: 'file target cannot be resolved' };
    const kind = entry.kind;
    let directory = false; let regularFile = false; let linked = false;
    try {
      const info = await fsApi.lstat(target.actual);
      directory = info.isDirectory();
      regularFile = info.isFile() && !info.isSymbolicLink();
      linked = regularFile && info.nlink > 1;
    } catch (error) { if (error?.code !== 'ENOENT') return { complete: false, actions, reason: 'file change target cannot be inspected' }; }
    const action = { kind, target, directory, protected: isProtected(target, context, { allowProgramDataWorkspaceRead: kind === 'read', allowOrdinarySystemRead: kind === 'read' && regularFile }),
      workspace: inside(target.lexical, context.trustedWorkspaceRoot) && inside(target.actual, context.trustedWorkspaceRoot),
      workspaceRoot: Boolean(context.trustedWorkspaceRoot) && win.resolve(target.actual).toLowerCase() === win.resolve(context.trustedWorkspaceRoot).toLowerCase(),
      regularFile, linked,
      recursive: directory && (kind === 'delete' || entry.recursive === true) };
    if (action.recursive) action.recursiveVerified = (kind !== 'delete' || action.workspace)
      && await inspectRecursiveTarget(target, context, fsApi, {
        allowWorkspaceRoot: kind !== 'delete',
        requireWorkspace: kind === 'delete',
        checkHardLinks: kind !== 'delete',
        allowProgramDataWorkspaceRead: kind === 'read',
      });
    actions.push(action);
  }
  return { complete: true, actions };
}

async function inspectRecursiveTarget(target, context, fsApi, {
  allowWorkspaceRoot = false,
  requireWorkspace = true,
  checkHardLinks = true,
  allowProgramDataWorkspaceRead = false,
} = {}) {
  if ((requireWorkspace && !context.trustedWorkspaceRoot) ||
      (!allowWorkspaceRoot && context.trustedWorkspaceRoot && win.resolve(target.actual).toLowerCase() === win.resolve(context.trustedWorkspaceRoot).toLowerCase())) return false;
  const stack = [target.actual]; let count = 0;
  while (stack.length) {
    if (++count > 10000) return false;
    const current = stack.pop();
    let info;
    try { info = await fsApi.lstat(current); } catch (error) { return error?.code === 'ENOENT' && count === 1; }
    if (info.isSymbolicLink() || (checkHardLinks && info.isFile() && info.nlink > 1)
        || isProtected({ lexical: current, actual: current }, context, { allowProgramDataWorkspaceRead })) return false;
    if (info.isDirectory()) {
      let entries;
      try { entries = await fsApi.readdir(current); } catch { return false; }
      for (const name of entries) stack.push(win.join(current, name));
    }
  }
  return true;
}

/** Converts native AST into bounded effects. It never executes the command. */
export async function analyzeWindowsPowerShell(command, context = {}, { parse = parseWindowsPowerShellAst, fsApi = { lstat, realpath, readdir }, executable } = {}) {
  let ast;
  try { ast = await parse(command, { executable }); } catch (error) {
    return { complete: false, actions: [], reason: 'PowerShell parser unavailable', error: error.message };
  }
  // PowerShell 7 added command-chain operators which the inbox Windows
  // PowerShell 5.1 parser tokenizes but reports as syntax errors. Split only
  // top-level literal `&&` operators reported by that native tokenizer, then
  // parse and independently classify every segment with the same AST policy.
  // `||`, nested operators, malformed segments, and any unsafe segment remain
  // review requests. This keeps compatibility without evaluating command text.
  if (ast.errors.length && Array.isArray(ast.chainOperators) && ast.chainOperators.length
      && ast.chainOperators.every((item) => item.operator === 'AndAnd') && ast.chainOperators.length <= 16) {
    const segments = [];
    let offset = 0;
    for (const item of ast.chainOperators) {
      segments.push(command.slice(offset, item.start).trim());
      offset = item.end;
    }
    segments.push(command.slice(offset).trim());
    if (segments.every(Boolean)) {
      const results = [];
      for (const segment of segments) results.push(await analyzeWindowsPowerShell(segment, context, { parse, fsApi, executable }));
      if (results.every((result) => result.complete && result.actions.length)) {
        return { complete: true, actions: results.flatMap((result) => result.actions),
          parserVersion: ast.parserVersion, psVersion: ast.psVersion, chainOperator: 'AndAnd' };
      }
    }
  }
  const expressions = Array.isArray(ast.expressions) ? ast.expressions : [];
  // Analyze every command and expression in every conditional branch. Their
  // normal target and operation checks still apply regardless of which branch
  // runs. Variables, assignments, script blocks, loops, and other dynamic
  // constructs remain unsupported here.
  if (ast.errors.length || ast.dynamicNodes.some(node => node !== 'IfStatementAst') || (!ast.commands.length && !expressions.length)) {
    return { complete: false, actions: [], reason: ast.errors.length ? 'PowerShell syntax error' : 'dynamic or unsupported PowerShell syntax' };
  }
  const actions = [];
  const appendRedirects = async (entry, program) => {
    if (!entry.redirections) return '';
    if (!Array.isArray(entry.redirectFacts) || entry.redirectFacts.length !== entry.redirections || entry.redirectFacts.length > 8) return 'redirection details unavailable';
    for (const redirect of entry.redirectFacts) {
      // PowerShell's merging redirection (for example 2>&1) only combines
      // output streams. It does not open a file; the command and any file
      // redirections are still independently classified below.
      if (redirect.type === 'MergingRedirectionAst') continue;
      if (redirect.type === 'FileRedirectionAst' && redirect.locationType === 'StaticNull') continue;
      if (redirect.type !== 'FileRedirectionAst' || !['StringConstantExpressionAst', 'ConstantExpressionAst'].includes(redirect.locationType)) return 'dynamic or unsupported redirection';
      if (lacksAttestedAbsolutePath(redirect.location, context)) return 'working directory is not attested';
      const target = await resolveTarget(redirect.location, context.cwd, fsApi, context);
      if (!target) return 'redirection target cannot be resolved';
      actions.push({ kind: 'write', program, target, protected: isProtected(target, context),
        workspace: inside(target.lexical, context.trustedWorkspaceRoot) && inside(target.actual, context.trustedWorkspaceRoot), recursive: false });
    }
    return '';
  };
  for (const expression of expressions) {
    if (expression.expressionType === 'ParenExpressionAst') {
      // The native AST walk also reports the commands and expressions inside
      // the parentheses, so each inner operation is checked independently.
      const reason = await appendRedirects(expression, 'parenthesized');
      if (reason) return { complete: false, actions, reason };
      continue;
    }
    if (expression.expressionType === 'InvokeMemberExpressionAst' && expression.staticFileCall) {
      const call = expression.staticFileCall;
      if (!['read', 'write', 'delete'].includes(call.kind) || typeof call.path !== 'string' || !call.path) {
        return { complete: false, actions, reason: 'static file call is invalid' };
      }
      // .NET resolves relative paths against the process directory, which can
      // differ from PowerShell's current location. Do not guess that binding.
      if (!/^[a-z]:[\\/]/i.test(call.path)) {
        return { complete: false, actions, reason: 'static file call requires an absolute path' };
      }
      const analyzed = await analyzeWindowsFileChanges([{ path: call.path, kind: call.kind }], context, { fsApi });
      if (!analyzed.complete) return { ...analyzed, actions: [...actions, ...analyzed.actions] };
      actions.push(...analyzed.actions);
      const reason = await appendRedirects(expression, 'static-file');
      if (reason) return { complete: false, actions, reason };
      continue;
    }
    if (!['StringConstantExpressionAst', 'ConstantExpressionAst'].includes(expression.expressionType)) return { complete: false, actions, reason: 'dynamic or unsupported expression' };
    const reason = await appendRedirects(expression, 'literal');
    if (reason) return { complete: false, actions, reason };
    actions.push({ kind: 'read', program: 'literal', target: null });
  }
  // Expand static lists only for cmdlets whose path argument independently
  // identifies each read or removal target. The normal policy still checks
  // every removal and rejects unpinned recursive or wildcard deletion.
  const commands = [];
  for (const entry of ast.commands) {
    const lists = entry.elements.map((element, index) => element.kind === 'literal_list' ? index : -1).filter(index => index >= 0);
    if (!lists.length) { commands.push(entry); continue; }
    const index = lists[0];
    const program = BUILTIN_ALIASES.get(String(entry.name || '').toLowerCase()) || String(entry.name || '').toLowerCase();
    const previous = entry.elements[index - 1];
    // Literal property names describe formatting/selection only. Keep dynamic
    // calculated properties and arbitrary list-bearing commands out of this path.
    if (lists.length === 1 && ['select-object', 'sort-object', 'format-table', 'format-list'].includes(program) &&
        (index === 1 || (index === 2 && previous?.kind === 'parameter' &&
          String(previous.name || '').toLowerCase() === 'property' && !previous.argumentType)) &&
        Array.isArray(entry.elements[index].values) && entry.elements[index].values.length > 0 &&
        entry.elements[index].values.length <= 128 &&
        entry.elements[index].values.every(value => typeof value === 'string' && /^[\w*?]+$/.test(value))) {
      const elements = entry.elements.slice();
      elements.splice(index, 1, ...entry.elements[index].values.map(value => ({ kind: 'literal', value })));
      commands.push({ ...entry, elements });
      continue;
    }
    const prefixSwitches = entry.elements.slice(1, index).every(element => element.kind === 'parameter' &&
      ['force', 'raw', 'recurse', 'confirm'].includes(String(element.name || '').toLowerCase()));
    const pathPosition = prefixSwitches || (previous?.kind === 'parameter' && !previous.argumentType &&
      ['path', 'literalpath'].includes(String(previous.name || '').toLowerCase()));
    const values = entry.elements[index].values;
    if (lists.length !== 1 || !['get-content', 'get-item', 'get-filehash', 'test-path', 'resolve-path', 'remove-item'].includes(program) ||
        entry.pipelineInput !== false || !pathPosition || !Array.isArray(values) || !values.length || values.length > 128 ||
        values.some(value => typeof value !== 'string' || !value)) {
      return { complete: false, actions, reason: 'unsupported or ambiguous literal list' };
    }
    for (const value of values) {
      const elements = entry.elements.slice();
      elements[index] = { kind: 'literal', value };
      commands.push({ ...entry, elements });
    }
  }
  for (const entry of commands) {
    const rawProgram = String(entry.name || '').toLowerCase();
    const program = BUILTIN_ALIASES.get(rawProgram) || rawProgram;
    if (!program || entry.invocation !== 'Unknown' || entry.elements.some((x) => x.kind === 'dynamic')) {
      return { complete: false, actions, reason: 'dynamic command, invocation, or redirection' };
    }
    const redirectionReason = await appendRedirects(entry, program);
    if (redirectionReason) return { complete: false, actions, reason: redirectionReason };
    const versionArgs = staticExternalArguments(entry.elements);
    const version = entry.pipelineInput === false && versionArgs && analyzeWindowsVersion(entry.name, versionArgs);
    if (version) { actions.push(version); continue; }
    if (entry.pipelineInput === false && isWingetListQuery(program, versionArgs)) {
      actions.push({ kind: 'read', program: 'winget list', target: null }); continue;
    }
    const ripgrep = await analyzeRipgrepCommand(entry, context, fsApi);
    if (ripgrep) {
      if (!ripgrep.complete) return { ...ripgrep, actions: [...actions, ...ripgrep.actions] };
      actions.push(...ripgrep.actions);
      continue;
    }
    const workspaceTask = await analyzeWorkspaceScriptTask(entry, context, fsApi);
    if (workspaceTask) {
      if (context.requireAbsolutePaths) return { complete: false, actions, reason: 'working directory is not attested' };
      actions.push(workspaceTask); continue;
    }
    if (program === 'git' || program === 'git.exe') {
      if (entry.pipelineInput !== false || entry.elements[0]?.kind !== 'literal'
          || entry.elements.slice(1).some(element => element.kind !== 'literal'
            && (element.kind !== 'parameter' || element.argumentType || element.value != null))) {
        return { complete: false, actions, reason: 'Git arguments are dynamic or come from pipeline input' };
      }
      let args = staticExternalArguments(entry.elements); let gitContext = context; let directoryActions = [];
      if (args?.[0] === '-C' && args.length >= 3) {
        const checked = await analyzeWindowsFileChanges([{ path: args[1], kind: 'read' }], context, { fsApi });
        const target = checked.actions?.[0];
        if (!checked.complete || checked.actions.length !== 1 || !target?.directory || target.protected || !target.target?.actual)
          return { complete: false, actions: [...actions, ...(checked.actions || [])], reason: 'Git working directory needs review' };
        gitContext = { ...context, cwd: target.target.actual };
        directoryActions = checked.actions; args = args.slice(2);
      }
      const readonly = args && analyzeWindowsReadOnlyGit([entry.name, ...args]);
      const local = !readonly && args && analyzeWindowsLocalGit([entry.name, ...args]);
      if (local && context.requireAbsolutePaths) return { complete: false, actions, reason: 'working directory is not attested' };
      const git = readonly || local;
      if (!git) return { complete: false, actions, reason: 'Git command is not on the read-only allowlist' };
      if (git.pathspecs) {
        const files = await analyzeWindowsFileChanges(git.pathspecs.map(value => ({ path: value, kind: 'read', recursive: true })), gitContext, { fsApi });
        if (!files.complete) return { ...files, actions: [...actions, ...git.actions, ...files.actions] };
        git.actions.push(...files.actions);
      }
      actions.push(...directoryActions, ...git.actions);
      continue;
    }
    if (program === 'select-string') {
      const args = parseArguments(entry.elements, new Set(['pattern', 'simplematch', 'casesensitive', 'quiet', 'notmatch']),
        new Set(['simplematch', 'casesensitive', 'quiet', 'notmatch']));
      if (entry.pipelineInput !== true || !args || args.positional.length > 1 ||
          (args.named.has('pattern') ? args.positional.length !== 0 : args.positional.length !== 1)) {
        return { complete: false, actions, reason: 'unsupported Select-String arguments' };
      }
      actions.push({ kind: 'read', program, target: null }); continue;
    }
    if (program === 'where-object') {
      // Accept the native parser's narrowly validated script predicate or the
      // comparison form. Other script blocks and dynamic values remain gated.
      const [, property, operator, value] = entry.elements;
      const comparisons = /^(?:i|c)?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin)$/i;
      if (entry.pipelineInput === true && entry.elements.length === 2 && property?.kind === 'safe_where_predicate') {
        actions.push({ kind: 'read', program, target: null }); continue;
      }
      if (entry.pipelineInput !== true || entry.elements.length !== 4 || property?.kind !== 'literal' ||
          !/^[\w]+$/.test(property.value) || operator?.kind !== 'parameter' || operator.argumentType ||
          !comparisons.test(operator.name || '') || value?.kind !== 'literal') {
        return { complete: false, actions, reason: 'unsupported Where-Object predicate' };
      }
      actions.push({ kind: 'read', program, target: null }); continue;
    }
    if (FILTERS.has(program)) {
      const filterArgs = parseArguments(entry.elements, SAFE_FILTER_PARAMS, SAFE_FILTER_SWITCHES);
      if (!filterArgs) return { complete: false, actions, reason: 'unsupported filter arguments' };
      // Get-Command can import a module and run its initialization even with
      // -ListImported when a name is supplied. An unnamed, non-pipeline
      // inventory may safely filter already imported commands by literal type.
      if (program === 'get-command' && (entry.pipelineInput !== false || filterArgs.positional.length ||
          [...filterArgs.named.keys()].some(key => !['listimported', 'commandtype'].includes(key)) ||
          (filterArgs.named.has('commandtype') &&
            !GET_COMMAND_TYPES.has(String(filterArgs.named.get('commandtype')).toLowerCase())))) {
        return { complete: false, actions, reason: 'command lookup may execute module initialization' };
      }
      actions.push({ kind: 'read', program, target: null }); continue;
    }
    const kind = FILE_COMMANDS.get(program);
    if (!kind) return { complete: false, actions, reason: `unrecognized PowerShell command: ${program}` };
    // The built-in mkdir function binds pipeline input and can accept multiple
    // paths. Only a single explicit literal target is statically bound here.
    if (program === 'mkdir' && (ast.commands.length !== 1 || expressions.length || entry.redirections)) return { complete: false, actions, reason: 'mkdir pipeline or redirection needs review' };
    // Rename-Item can bind paths from the pipeline. Restrict this adapter to a
    // single explicit source and destination, so input cannot add targets.
    if (program === 'rename-item' && (ast.commands.length !== 1 || expressions.length || entry.redirections)) return { complete: false, actions, reason: 'rename pipeline or redirection needs review' };
    const args = parseArguments(entry.elements, program === 'mkdir' ? MKDIR_PARAMS : program === 'out-file' ? OUT_FILE_PARAMS : program === 'get-childitem' ? CHILD_ITEM_PARAMS : program === 'rename-item' ? RENAME_PARAMS : program === 'get-content' ? CONTENT_READ_PARAMS : ['set-content', 'add-content'].includes(program) ? CONTENT_WRITE_PARAMS : FILE_PARAMS,
      program === 'mkdir' ? MKDIR_SWITCHES : program === 'out-file' ? OUT_FILE_SWITCHES : program === 'get-childitem' ? CHILD_ITEM_SWITCHES : program === 'rename-item' ? RENAME_SWITCHES : program === 'get-content' ? CONTENT_READ_SWITCHES : ['set-content', 'add-content'].includes(program) ? CONTENT_WRITE_SWITCHES : SWITCHES);
    if (!args) return { complete: false, actions, reason: 'unsupported or ambiguous file arguments' };
    if (['totalcount', 'tail', 'readcount'].some(key => args.named.has(key) && !/^\d{1,10}$/.test(args.named.get(key)))) {
      return { complete: false, actions, reason: 'content read limit is not a literal nonnegative integer' };
    }
    const namedPath = args.named.get('literalpath') || args.named.get('filepath') || args.named.get('path');
    // With no explicit path, Get-ChildItem binds incoming pipeline values as
    // paths rather than necessarily listing the current directory.
    if (program === 'get-childitem' && !namedPath && !args.positional.length && entry.pipelineInput !== false) {
      return { complete: false, actions, reason: 'listing path may come from pipeline input' };
    }
    let source = namedPath || args.positional[0] || (program === 'get-childitem' ? '.' : '');
    const destinationKey = kind === 'rename' ? 'newname' : 'destination';
    const destination = args.named.get(destinationKey) || ((kind === 'copy' || kind === 'move' || kind === 'rename') ? args.positional[namedPath ? 0 : 1] : '');
    const maxPositionals = kind === 'copy' || kind === 'move' || kind === 'rename' ? (namedPath ? (args.named.has(destinationKey) ? 0 : 1) : (args.named.has(destinationKey) ? 1 : 2))
      : ['set-content', 'add-content'].includes(program) ? (namedPath ? 1 : 2) : (namedPath ? 0 : 1);
    if (args.positional.length > maxPositionals || ['path', 'literalpath', 'filepath'].filter((key) => args.named.has(key)).length > 1) return { complete: false, actions, reason: 'ambiguous file targets' };
    // Listing can be evaluated against the full literal root: filters only
    // reduce what Get-ChildItem emits, and recursive listings still inspect the
    // whole tree below. Do not reuse this for writes, copies or deletions.
    if (program !== 'get-childitem' && (args.named.has('filter') || args.named.has('include') || args.named.has('exclude'))) return { complete: false, actions, reason: 'filtered targets require expansion' };
    if (program === 'get-childitem' && args.named.has('depth') && !/^\d{1,3}$/.test(args.named.get('depth'))) return { complete: false, actions, reason: 'invalid listing depth' };
    if (program === 'new-item') {
      const type = String(args.named.get('itemtype') || 'file').toLowerCase();
      if (!['file', 'directory'].includes(type)) return { complete: false, actions, reason: 'unsupported item type' };
      if (args.named.has('name')) {
        const name = args.named.get('name');
        if (!name || win.basename(name) !== name) return { complete: false, actions, reason: 'dynamic item name' };
        source = win.join(source || '.', name);
      }
    }
    if (kind === 'rename' && (!destination || destination === '.' || destination === '..' || /[\\/]/.test(destination) || win.basename(destination) !== destination)) return { complete: false, actions, reason: 'rename destination is not a literal file name' };
    if (lacksAttestedAbsolutePath(source, context) || (destination && kind !== 'rename' && lacksAttestedAbsolutePath(destination, context))) return { complete: false, actions, reason: 'working directory is not attested' };
    // A standalone trailing * means the immediate children of a literal
    // directory. Inspect every child (including hidden ones) and their full
    // subtrees; never approximate arbitrary PowerShell wildcard patterns.
    if (program === 'remove-item' && !args.named.has('literalpath') && /(?:^|[\\/])\*$/.test(source)) {
      if ([...args.named.keys()].some(key => !['path', 'recurse', 'force'].includes(key))) return { complete: false, actions, reason: 'wildcard delete has unsupported options' };
      const parentText = source === '*' ? '.' : source.slice(0, -1).replace(/[\\/]+$/, '') || source.slice(0, -1);
      const parent = await resolveTarget(parentText, context.cwd, fsApi, context);
      if (!parent || !context.trustedWorkspaceRoot || !inside(parent.lexical, context.trustedWorkspaceRoot) ||
          !inside(parent.actual, context.trustedWorkspaceRoot) || isProtected(parent, context) ||
          win.resolve(parent.actual).toLowerCase() === win.resolve(context.trustedWorkspaceRoot).toLowerCase()) {
        return { complete: false, actions, reason: 'wildcard delete parent is not a safe workspace directory' };
      }
      let children;
      try {
        const info = await fsApi.lstat(parent.actual);
        if (!info.isDirectory() || info.isSymbolicLink()) return { complete: false, actions, reason: 'wildcard delete parent is not a directory' };
        children = await fsApi.readdir(parent.actual);
      } catch { return { complete: false, actions, reason: 'wildcard delete directory cannot be inspected' }; }
      if (!children.length || children.length > 1024 || children.some(name => typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/]/.test(name))) {
        return { complete: false, actions, reason: 'wildcard delete targets are empty or exceed the limit' };
      }
      const expanded = await analyzeWindowsFileChanges(children.map(name => ({ path: win.join(parent.lexical, name), kind: 'delete' })), context, { fsApi });
      if (!expanded.complete) return { complete: false, actions, reason: expanded.reason };
      // The shell would expand * again after this analysis. A newly created
      // child could otherwise be deleted without having been inspected.
      // Preserve the expansion for audit, but do not authorize execution until
      // a future executor can bind the inspected targets to deletion.
      actions.push(...expanded.actions.map(action => ({ ...action, program, requiresPinnedExecution: true })));
      continue;
    }
    const sourceTarget = await resolveTarget(source, context.cwd, fsApi, context);
    if (!sourceTarget) return { complete: false, actions, reason: 'file target cannot be resolved' };
    const recursive = args.named.has('recurse') || (program === 'get-childitem' && args.named.has('depth'));
    const allowShallowDirectoryListing = kind === 'read' && !recursive &&
      (program === 'test-path' || (program === 'get-childitem' && sourceTarget.directory === true));
    const add = (action, target) => actions.push({ kind: action, program, target,
      // Test-Path reports existence, and a shallow Get-ChildItem reports
      // directory-entry metadata. Neither reads the file contents.
      protected: isProtected(target, context, { allowProgramDataWorkspaceRead: action === 'read', allowShallowDirectoryListing, allowOrdinarySystemRead: action === 'read' && target.file }),
      directory: sourceTarget.directory === true,
      workspace: inside(target.lexical, context.trustedWorkspaceRoot) && inside(target.actual, context.trustedWorkspaceRoot),
      workspaceRoot: Boolean(context.trustedWorkspaceRoot) && win.resolve(target.actual).toLowerCase() === win.resolve(context.trustedWorkspaceRoot).toLowerCase(),
      recursive });
    if (kind === 'copy' || kind === 'move' || kind === 'rename') {
      const destTarget = kind === 'rename'
        ? await resolveTarget(win.join(win.dirname(sourceTarget.lexical), destination), context.cwd, fsApi, context)
        : await resolveCopyDestination(destination, source, context, fsApi);
      if (!destTarget) return { complete: false, actions, reason: 'destination cannot be resolved' };
      add(kind === 'copy' ? 'read' : 'delete', sourceTarget); add('write', destTarget);
    } else add(kind, sourceTarget);
    if ((args.named.has('recurse') || (program === 'get-childitem' && args.named.has('depth'))) && (kind === 'read' || kind === 'copy')) {
      // Read and copy may traverse protected descendants even when their root
      // itself is ordinary. Copy also needs to inspect an existing destination.
      const recursiveActions = kind === 'copy' ? actions.slice(-2) : actions.slice(-1);
      for (const action of recursiveActions) action.recursiveVerified = await inspectRecursiveTarget(action.target, context, fsApi,
        { allowWorkspaceRoot: true, requireWorkspace: false, allowProgramDataWorkspaceRead: action.kind === 'read' });
    }
    if (kind === 'delete' || kind === 'move' || kind === 'rename') {
      const action = actions[actions.length - (kind === 'move' || kind === 'rename' ? 2 : 1)];
      try {
        const info = await fsApi.lstat(sourceTarget.actual);
        action.regularFile = info.isFile() && !info.isSymbolicLink();
        // Moving a directory moves its whole tree even without -Recurse;
        // deleting a directory can likewise affect descendants.
        if (info.isDirectory()) action.recursive = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') return { complete: false, actions, reason: 'delete target cannot be inspected' };
      }
    }
    if (kind === 'delete' || kind === 'move' || kind === 'rename') {
      const action = actions[actions.length - (kind === 'move' || kind === 'rename' ? 2 : 1)];
      if (action.recursive && !action.regularFile) {
        action.recursiveVerified = action.workspace && await inspectRecursiveTarget(action.target, context, fsApi, { checkHardLinks: false });
      }
    }
  }
  for (const action of actions) {
    if (!action.target) continue;
    try {
      const info = await fsApi.lstat(action.target.actual);
      action.linked = info.isFile() && info.nlink > 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') return { complete: false, actions, reason: 'file target cannot be inspected' };
    }
  }
  return { complete: true, actions, parserVersion: ast.parserVersion, psVersion: ast.psVersion };
}

export function decideWindowsPowerShellActions(result, { safeOnly = false, conservative = false } = {}) {
  // `conservative` remains as a compatibility alias for existing callers.
  const requireWorkspaceOnly = safeOnly || conservative;
  if (!result.complete || !result.actions.length) return { decision: 'review', reason: result.reason || 'PowerShell analysis incomplete', tier: 'danger' };
  let cautionAction = null;
  for (const action of result.actions) {
    if (action.requiresPinnedExecution) return { decision: 'review', reason: 'wildcard delete targets are not bound to execution', action, tier: 'danger' };
    if (action.protected) return { decision: 'review', reason: 'protected or sensitive path', action, tier: 'danger' };
    // Checking a directory tree is only a snapshot. Its descendants may be
    // replaced or added before an independently executed recursive removal.
    if (action.kind === 'delete' && action.recursive) return { decision: 'review', reason: 'recursive deletion is not bound to inspected contents', action, tier: 'danger' };
    if (action.linked && action.kind !== 'delete') return { decision: 'review', reason: 'file has multiple hard links', action, tier: 'danger' };
    if ((action.kind === 'read' || action.kind === 'write') && action.recursive && !action.recursiveVerified) return { decision: 'review', reason: 'recursive file operation needs verification', action, tier: 'danger' };
    if (action.kind === 'delete' && ((!action.workspace && !action.regularFile) || action.workspaceRoot || (action.recursive && !action.regularFile && !action.recursiveVerified) || action.target?.actual === action.target?.lexical && win.parse(action.target.actual).root === action.target.actual)) {
      return { decision: 'review', reason: 'delete target or recursive delete needs verification', action, tier: 'danger' };
    }
    if (requireWorkspaceOnly && action.target && !action.workspace) return { decision: 'review', reason: 'outside safe workspace', action, tier: 'caution' };
    if (action.caution) cautionAction ||= action;
  }
  if (cautionAction && requireWorkspaceOnly) return { decision: 'review', reason: 'safe mode requires owner review for a workspace developer task', action: cautionAction, tier: 'caution' };
  if (cautionAction) return { decision: 'allow', reason: 'verified workspace developer task', action: cautionAction, tier: 'caution' };
  return { decision: 'allow', reason: 'verified ordinary PowerShell operations', tier: 'safe' };
}
