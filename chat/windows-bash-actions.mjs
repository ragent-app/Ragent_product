import path from 'node:path';
import { analyzeWindowsFileChanges, analyzeWindowsRipgrep, analyzeWindowsVersion, analyzeWindowsWorkspaceScriptTask, analyzeWindowsPureNode, analyzeWindowsPurePython, isWindowsPingProbe } from './windows-powershell-actions.mjs';
import { analyzeWindowsLocalGit, analyzeWindowsReadOnlyGit } from './windows-readonly-git.mjs';

// Parse a literal simple command only. Anything requiring shell expansion,
// substitutions, redirection, operators, or comments is left for review.
export function parseLiteralBashWords(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 128 * 1024 || /[\r\n\0]/.test(command)) return null;
  const words = []; let word = ''; let active = false; let quote = '';
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = ''; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') { quote = ''; continue; }
      if (c === '$' || c === '`') return null;
      if (c === '\\' && i + 1 < command.length && /[\\"$`]/.test(command[i + 1])) { word += command[++i]; continue; }
      word += c; continue;
    }
    if (/\s/.test(c)) { if (active) { words.push(word); word = ''; active = false; } continue; }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (c === '\\') { if (++i >= command.length) return null; word += command[i]; active = true; continue; }
    if (/[;&|<>`$(){}#*?\[\]!]/.test(c)) return null;
    word += c; active = true;
  }
  if (quote) return null;
  if (active) words.push(word);
  return words.length ? words : null;
}

export function gitBashPath(value) {
  if (!value || value.startsWith('~')) return '';
  const drive = value.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
  if (drive) return `${drive[1]}:\\${(drive[2] || '').replaceAll('/', '\\')}`;
  // /tmp and other MSYS roots depend on the installation and environment.
  if (value.startsWith('/')) return '';
  if (/^[a-zA-Z]:[^/\\]/.test(value)) return '';
  return path.win32.normalize(value);
}

function splitOptions(args, supported, longOptions = {}) {
  const operands = []; const flags = new Set(); let options = true;
  for (const arg of args) {
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-') && arg !== '-') {
      if (Object.hasOwn(longOptions, arg)) { flags.add(longOptions[arg]); continue; }
      if (!/^-[A-Za-z1]+$/.test(arg) || [...arg.slice(1)].some((flag) => !supported.includes(flag))) return null;
      for (const flag of arg.slice(1)) flags.add(flag);
    } else operands.push(arg);
  }
  return { operands, flags };
}

// Read-only utilities still need the same path checks as `cat`. Keep the
// grammar literal and reject options that run commands, follow files, or
// select extra files through an option.
function readUtilityOperands(program, args) {
  if (program === 'sed') {
    // GNU sed's general language can read/write files or execute commands.
    // Only the common line-range print form is a static read.
    if (!['-n', '--quiet', '--silent'].includes(args[0]) || !/^\d+(?:,\d+)?p$/.test(args[1] || '')) return null;
    const operands = args.slice(args[2] === '--' ? 3 : 2);
    return operands.length && operands.every(operand => operand && operand !== '-' && !operand.startsWith('-')) ? operands : null;
  }
  const operands = []; let options = true; let explicitPattern = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-')) {
      if (['head', 'tail'].includes(program)) {
        if (/^-(?:n|c)$/.test(arg)) { if (!/^\d{1,9}$/.test(args[++i] || '')) return null; continue; }
        if (/^-(?:n|c)\d{1,9}$/.test(arg) || /^--(?:lines|bytes)=\d{1,9}$/.test(arg)) continue;
      } else if (program === 'wc' && /^-[clmwL]+$/.test(arg)) continue;
      else if (program === 'grep' && /^-[iFEnwvcl]+$/.test(arg)) continue;
      else if (program === 'grep' && arg === '-e') {
        if (explicitPattern || ++i >= args.length) return null;
        explicitPattern = true; continue;
      }
      return null;
    }
    operands.push(arg);
  }
  if (program === 'grep' && !explicitPattern) {
    if (operands.length < 2) return null;
    operands.shift(); // the first operand is the literal search pattern
  }
  return operands.length && operands.every(operand => operand !== '-') ? operands : null;
}

// Recognize only a single trailing stdout redirection to one literal path.
// Leave descriptor manipulation, shell control syntax and expansion to review.
function stripLiteralNullStderr(command) {
  let result = ''; let quote = '';
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote === "'") { result += c; if (c === "'") quote = ''; continue; }
    if (quote === '"') {
      result += c;
      if (c === '"') quote = '';
      else if (c === '\\' && i + 1 < command.length) result += command[++i];
      continue;
    }
    if (c === "'" || c === '"') { quote = c; result += c; continue; }
    if (c === '\\' && i + 1 < command.length) { result += c + command[++i]; continue; }
    if (c === '2' && (i === 0 || /\s/.test(command[i - 1]))) {
      const match = command.slice(i).match(/^2>[ \t]*\/dev\/null(?=[ \t]|$)/);
      if (match) { result += ' '; i += match[0].length - 1; continue; }
    }
    result += c;
  }
  return result;
}

function splitLiteralOutput(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 128 * 1024 || /[\r\n\0]/.test(command)) return null;
  command = stripLiteralNullStderr(command);
  let quote = ''; let offset = -1; let width = 0;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = ''; continue; }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\' && i + 1 < command.length && /[\\"$`]/.test(command[i + 1])) i += 1;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '\\') { i += 1; continue; }
    if (c !== '>') continue;
    if (offset >= 0 || /[0-9]/.test(command[i - 1] || '')) return null;
    offset = i; width = command[i + 1] === '>' ? 2 : 1;
    if (width === 2) i += 1;
  }
  if (quote) return null;
  if (offset < 0) return { words: parseLiteralBashWords(command), output: '' };
  const words = parseLiteralBashWords(command.slice(0, offset));
  const output = parseLiteralBashWords(command.slice(offset + width));
  return words && output?.length === 1 && output[0] ? { words, output: output[0] } : null;
}

// Split only literal shell operators, without executing or expanding the text.
// Each segment is classified separately; a pipe may contain only a verified
// read followed by filters that consume stdin and cannot open additional files.
export function splitLiteralCompound(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 128 * 1024 || /[\r\n\0]/.test(command)) return null;
  const segments = []; const operators = []; let quote = ''; let start = 0;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = ''; continue; }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\' && i + 1 < command.length && /[\\"$`]/.test(command[i + 1])) i += 1;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '\\') { i += 1; continue; }
    if (!['|', '&', ';'].includes(c)) continue;
    let operator = c;
    if ((c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) { operator = c + c; i += 1; }
    else if (c === '&' || (c === '|' && command[i + 1] === '&')) return null;
    const segment = command.slice(start, i + 1 - operator.length).trim();
    if (!segment) return null;
    segments.push(segment); operators.push(operator); start = i + 1;
    if (segments.length > 16) return null;
  }
  if (quote) return null;
  const last = command.slice(start).trim();
  if (!last) return null;
  segments.push(last);
  return { segments, operators };
}

function isReadOnlyStdinFilter(command) {
  const words = parseLiteralBashWords(command);
  if (!words?.length) return false;
  const [program, ...args] = words;
  if (program === 'sed') return ['-n', '--quiet', '--silent'].includes(args[0])
    && /^\d+(?:,\d+)?p$/.test(args[1] || '') && (args.length === 2 || (args.length === 3 && args[2] === '-'));
  if (['head', 'tail'].includes(program)) {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-') continue;
      if (/^-(?:n|c)$/.test(arg)) { if (!/^\d{1,9}$/.test(args[++i] || '')) return false; continue; }
      if (/^-(?:n|c)\d{1,9}$/.test(arg) || /^--(?:lines|bytes)=\d{1,9}$/.test(arg)) continue;
      return false;
    }
    return true;
  }
  if (program === 'wc') return args.every(arg => arg === '-' || /^-[clmwL]+$/.test(arg));
  if (program !== 'grep') return false;
  let pattern = false; let positional = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!positional && arg === '--') { positional = true; continue; }
    if (!positional && arg === '-e') {
      if (pattern || !args[++i]) return false;
      pattern = true; continue;
    }
    if (!positional && /^-[iFEnwvcl]+$/.test(arg)) continue;
    if (!pattern && arg !== '-') { pattern = true; continue; }
    if (arg !== '-') return false;
  }
  return pattern;
}

export async function analyzeWindowsBash(command, context = {}, { analyzeFiles = analyzeWindowsFileChanges } = {}) {
  // A literal, unconditional wrapper is equivalent to its one contained
  // command. Analyze that command normally so its file targets and options
  // receive exactly the same checks as an unwrapped operation. Do not infer
  // conditions, accept extra branches, or skip any additional shell command.
  const unconditional = typeof command === 'string' && command.length <= 128 * 1024 && !/[\r\n\0]/.test(command)
    ? /^\s*if\s+true\s*;\s*then\s+([\s\S]+?)\s*;\s*fi\s*$/.exec(command) : null;
  if (unconditional) {
    const inner = splitLiteralCompound(unconditional[1]);
    if (!inner || inner.operators.length) return { complete: false, actions: [], reason: 'conditional command needs review' };
    return analyzeWindowsBash(unconditional[1], context, { analyzeFiles });
  }
  const compound = splitLiteralCompound(command);
  if (!compound) return { complete: false, actions: [], reason: 'Bash command requires expansion or parsing' };
  if (compound.operators.length) {
    const first = parseLiteralBashWords(compound.segments[0]);
    if (first?.[0] === 'cd') {
      if (!context.allowCwdRewrite || context.requireAbsolutePaths) return { complete: false, actions: [], reason: 'working directory is not attested' };
      if (first.length !== 2 || compound.operators[0] !== '&&') return { complete: false, actions: [], reason: 'directory change needs review' };
      const destination = gitBashPath(first[1]);
      if (!destination) return { complete: false, actions: [], reason: 'directory change target cannot be resolved' };
      const directory = await analyzeFiles([{ path: destination, kind: 'read' }], context);
      const action = directory.actions?.[0];
      if (!directory.complete || directory.actions.length !== 1 || !action?.directory || action.protected || !action.target?.actual) return { complete: false, actions: directory.actions || [], reason: directory.reason || 'directory change target needs review' };
      const tail = compound.segments.slice(1).map((segment, index) => index ? `${compound.operators[index]} ${segment}` : segment).join(' ');
      const next = await analyzeWindowsBash(tail, { ...context, cwd: action.target.actual }, { analyzeFiles });
      if (!next.complete || !next.actions.length) return { ...next, actions: [...directory.actions, ...(next.actions || [])] };
      const absolute = action.target.lexical.replaceAll('\\', '/').replaceAll("'", "'\\''");
      // Keep every classified tail segment behind the successful directory
      // change, including || and ; branches, so a failed cd cannot execute a
      // path checked against the destination from the original directory.
      return { complete: true, actions: [...directory.actions, ...next.actions], rewrittenCommand: `builtin cd -- '${absolute}' && { ${next.rewrittenCommand || tail}; }` };
    }
    const actions = []; let pipeInput = false;
    for (let i = 0; i < compound.segments.length; i += 1) {
      const segment = compound.segments[i];
      const nextPipe = compound.operators[i] === '|';
      if (pipeInput) {
        if (!isReadOnlyStdinFilter(segment)) return { complete: false, actions, reason: 'Bash pipeline filter is not a verified stdin-only read' };
        actions.push({ kind: 'read', program: 'stdin filter', target: null });
      } else {
        const result = await analyzeWindowsBash(segment, context, { analyzeFiles });
        if (!result.complete || !result.actions.length) return { ...result, actions: [...actions, ...(result.actions || [])] };
        if (nextPipe && result.actions.some(action => action.kind !== 'read')) return { complete: false, actions, reason: 'Bash pipeline source is not read-only' };
        actions.push(...result.actions);
      }
      pipeInput = nextPipe;
    }
    return { complete: true, actions };
  }
  const split = splitLiteralOutput(command);
  const words = split?.words;
  if (!words) return { complete: false, actions: [], reason: 'Bash command requires expansion or parsing' };
  const output = split.output ? gitBashPath(split.output) : '';
  if (split.output && !output) return { complete: false, actions: [], reason: 'Bash redirection path cannot be resolved' };
  const outputEntry = output ? [{ path: output, kind: 'write' }] : [];
  const withOutput = async (analyzed) => {
    if (!analyzed.complete || !outputEntry.length) return analyzed;
    const destination = await analyzeFiles(outputEntry, context);
    return destination.complete
      ? { ...analyzed, actions: [...analyzed.actions, ...destination.actions] }
      : { ...destination, actions: [...analyzed.actions, ...(destination.actions || [])] };
  };
  const program = words[0];
  const version = analyzeWindowsVersion(program, words.slice(1));
  if (version) return withOutput({ complete: true, actions: [version] });
  if (['curl', 'curl.exe'].includes(String(program).toLowerCase())) {
    const prefix = ['--disable', '--proto', '=http,https', '--proto-redir', '=http,https'];
    const args = words.slice(1);
    if (!prefix.every((arg, index) => args[index] === arg)) return { complete: false, actions: [], reason: 'curl configuration is not disabled' };
    const rest = args.slice(prefix.length); let urls = 0; let outputFile = '';
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (/^-[fsSLI]+$/.test(arg) || ['--fail', '--silent', '--show-error', '--location', '--head', '--compressed'].includes(arg)) continue;
      if (arg === '-o' || arg === '--output' || arg.startsWith('--output=')) {
        if (outputFile) return { complete: false, actions: [], reason: 'curl output needs review' };
        outputFile = arg.startsWith('--output=') ? arg.slice('--output='.length) : rest[++i];
        if (!outputFile || outputFile === '-' || outputFile.startsWith('-')) return { complete: false, actions: [], reason: 'curl output needs review' };
        continue;
      }
      try { const url = new URL(arg); if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return { complete: false, actions: [], reason: 'curl target needs review' }; urls += 1; }
      catch { return { complete: false, actions: [], reason: 'curl arguments need review' }; }
    }
    if (urls !== 1) return { complete: false, actions: [], reason: 'curl target needs review' };
    if (outputFile) {
      const target = gitBashPath(outputFile);
      if (!target) return { complete: false, actions: [], reason: 'curl output cannot be resolved' };
      const output = await analyzeFiles([{ path: target, kind: 'write' }, ...outputEntry], context);
      return { ...output, actions: [{ kind: 'read', program: 'curl web request', target: null, caution: true }, ...(output.actions || [])] };
    }
    return withOutput({ complete: true, actions: [{ kind: 'read', program: 'curl web request', target: null, caution: true }] });
  }
  if (['rg', 'rg.exe'].includes(String(program).toLowerCase())) {
    const analyzed = await analyzeWindowsRipgrep(words.slice(1), context, { pathResolver: gitBashPath });
    return withOutput(analyzed);
  }
  const pureNode = analyzeWindowsPureNode(program, words.slice(1));
  if (pureNode) return withOutput({ complete: true, actions: [pureNode] });
  const purePython = analyzeWindowsPurePython(program, words.slice(1));
  if (purePython) return withOutput({ complete: true, actions: [purePython] });
  const workspaceTask = await analyzeWindowsWorkspaceScriptTask(program, words.slice(1), context, { pathResolver: gitBashPath });
  if (workspaceTask) {
    if (context.requireAbsolutePaths) return { complete: false, actions: [], reason: 'working directory is not attested' };
    return withOutput({ complete: true, actions: [workspaceTask] });
  }
  if (['git', 'git.exe'].includes(String(program).toLowerCase())) {
    let gitWords = words; let gitContext = context; let directoryActions = [];
    if (words[1] === '-C' && words.length >= 4) {
      const directory = gitBashPath(words[2]);
      if (!directory) return { complete: false, actions: [], reason: 'Git working directory cannot be resolved' };
      const checked = await analyzeFiles([{ path: directory, kind: 'read' }], context);
      const target = checked.actions?.[0];
      if (!checked.complete || checked.actions.length !== 1 || !target?.directory || target.protected || !target.target?.actual)
        return { complete: false, actions: checked.actions || [], reason: 'Git working directory needs review' };
      gitContext = { ...context, cwd: target.target.actual };
      directoryActions = checked.actions; gitWords = [words[0], ...words.slice(3)];
    }
    const readonly = analyzeWindowsReadOnlyGit(gitWords);
    const local = readonly ? null : analyzeWindowsLocalGit(gitWords);
    if (local && context.requireAbsolutePaths) return { complete: false, actions: [], reason: 'working directory is not attested' };
    const analyzed = readonly || local;
    if (analyzed?.pathspecs) {
      const paths = analyzed.pathspecs.map(gitBashPath);
      if (paths.some(value => !value)) return { complete: false, actions: [], reason: 'Git path cannot be resolved' };
      const files = await analyzeFiles(paths.map(value => ({ path: value, kind: 'read', recursive: true })), gitContext);
      if (!files.complete) return files;
      analyzed.actions.push(...files.actions);
    }
    return analyzed
      ? withOutput({ ...analyzed, actions: [...directoryActions, ...analyzed.actions] })
      : { complete: false, actions: [], reason: 'Git command is not on the read-only allowlist' };
  }
  if ((['pwd', 'true', 'false', ':'].includes(program) && words.length === 1) || program === 'echo') {
    return outputEntry.length ? analyzeFiles(outputEntry, context) : { complete: true, actions: [{ kind: 'read', program, target: null }] };
  }
  if (program === 'sleep' && words.length > 1 && words.slice(1).every(value => /^\d+(?:\.\d+)?[smhd]?$/.test(value))) {
    return withOutput({ complete: true, actions: [{ kind: 'read', program, target: null }] });
  }
  if (isWindowsPingProbe(String(program).toLowerCase(), words.slice(1))) {
    return withOutput({ complete: true, actions: [{ kind: 'read', program: 'ping', target: null, caution: true }] });
  }
  if (['which', 'command', 'type'].includes(program)) {
    const args = words.slice(1);
    if (program === 'command' && !['-v', '-V'].includes(args.shift())) return { complete: false, actions: [], reason: 'command execution needs review' };
    if (program === 'which' && ['-a', '--all'].includes(args[0])) args.shift();
    if (program === 'type' && /^-[aptP]+$/.test(args[0] || '')) args.shift();
    if (args[0] === '--') args.shift();
    if (!args.length || args.some(arg => !arg || arg.startsWith('-'))) return { complete: false, actions: [], reason: 'command lookup arguments need review' };
    return withOutput({ complete: true, actions: [{ kind: 'read', program, target: null }] });
  }
  if (['head', 'tail', 'wc', 'grep', 'sed'].includes(program)) {
    const operands = readUtilityOperands(program, words.slice(1));
    if (!operands) return { complete: false, actions: [], reason: 'read utility has unsupported or ambiguous arguments' };
    const targets = operands.map(gitBashPath);
    if (targets.some(target => !target)) return { complete: false, actions: [], reason: 'Bash path cannot be resolved' };
    return analyzeFiles([...targets.map(target => ({ path: target, kind: 'read' })), ...outputEntry], context);
  }
  if (program === 'find') {
    const args = words.slice(1); const source = args[0] && !args[0].startsWith('-') ? args.shift() : '.';
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-print') continue;
      if (['-name', '-iname'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('-')) { i += 1; continue; }
      if (arg === '-type' && /^[fdl]$/.test(args[i + 1] || '')) { i += 1; continue; }
      if (['-maxdepth', '-mindepth'].includes(arg) && /^\d{1,4}$/.test(args[i + 1] || '')) { i += 1; continue; }
      return { complete: false, actions: [], reason: 'find arguments need review' };
    }
    const target = gitBashPath(source);
    return target ? analyzeFiles([{ path: target, kind: 'read' }, ...outputEntry], context)
      : { complete: false, actions: [], reason: 'Bash path cannot be resolved' };
  }
  const spec = {
    cat: ['read', 'AbEensTtuv'], ls: ['read', 'aAlh1tSrdFisR'], mkdir: ['write', 'p'], touch: ['write', ''],
    rm: ['delete', 'rRf'], rmdir: ['delete', ''], cp: ['copy', 'rR'], mv: ['move', ''],
  }[program];
  if (!spec) return { complete: false, actions: [], reason: 'Bash command is not yet supported' };
  const longOptions = program === 'rm' ? { '--recursive': 'r', '--force': 'f' }
    : program === 'cp' ? { '--recursive': 'r' }
      : program === 'ls' ? { '--recursive': 'R', '--reverse': 'r', '--all': 'a', '--almost-all': 'A', '--human-readable': 'h' }
        : program === 'cat' ? { '--number': 'n', '--number-nonblank': 'b', '--show-all': 'A', '--show-ends': 'E', '--show-tabs': 'T', '--show-nonprinting': 'v', '--squeeze-blank': 's' }
          : program === 'mkdir' ? { '--parents': 'p' } : {};
  const parsed = splitOptions(words.slice(1), spec[1], longOptions);
  if (!parsed) return { complete: false, actions: [], reason: 'Bash command has unsupported options' };
  const { operands, flags } = parsed;
  if (program === 'ls' && !operands.length) operands.push('.');
  if ((spec[0] === 'copy' || spec[0] === 'move') ? operands.length !== 2 : operands.length === 0) {
    return { complete: false, actions: [], reason: 'Bash operands are incomplete or ambiguous' };
  }
  const targets = operands.map(gitBashPath);
  if (targets.some((item) => !item)) return { complete: false, actions: [], reason: 'Bash path cannot be resolved' };
  // ls -r reverses sort order; only uppercase -R is recursive. Other
  // supported tools use either -r or -R for recursion.
  const recursive = flags.has('R') || (program !== 'ls' && flags.has('r'));
  const entries = spec[0] === 'copy' || spec[0] === 'move'
    ? [{ path: targets[0], kind: spec[0] === 'move' ? 'delete' : 'read', recursive }, { path: targets[1], kind: 'write', recursive, copySource: targets[0] }]
    : targets.map((target) => ({ path: target, kind: spec[0], recursive }));
  return analyzeFiles([...entries, ...outputEntry], context);
}
