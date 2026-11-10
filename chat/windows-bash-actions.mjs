import path from 'node:path';
import { analyzeWindowsFileChanges } from './windows-powershell-actions.mjs';
import { analyzeWindowsReadOnlyGit } from './windows-readonly-git.mjs';

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
function splitLiteralOutput(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 128 * 1024 || /[\r\n\0]/.test(command)) return null;
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

export async function analyzeWindowsBash(command, context = {}, { analyzeFiles = analyzeWindowsFileChanges } = {}) {
  const split = splitLiteralOutput(command);
  const words = split?.words;
  if (!words) return { complete: false, actions: [], reason: 'Bash command requires expansion or parsing' };
  const output = split.output ? gitBashPath(split.output) : '';
  if (split.output && !output) return { complete: false, actions: [], reason: 'Bash redirection path cannot be resolved' };
  const outputEntry = output ? [{ path: output, kind: 'write' }] : [];
  const program = words[0];
  if (['git', 'git.exe'].includes(String(program).toLowerCase())) {
    const analyzed = analyzeWindowsReadOnlyGit(words);
    return analyzed
      ? { ...analyzed, actions: [...analyzed.actions, ...outputEntry] }
      : { complete: false, actions: [], reason: 'Git command is not on the read-only allowlist' };
  }
  if ((program === 'pwd' && words.length === 1) || program === 'echo') {
    return outputEntry.length ? analyzeFiles(outputEntry, context) : { complete: true, actions: [{ kind: 'read', program, target: null }] };
  }
  if (['head', 'tail', 'wc', 'grep'].includes(program)) {
    const operands = readUtilityOperands(program, words.slice(1));
    if (!operands) return { complete: false, actions: [], reason: 'read utility has unsupported or ambiguous arguments' };
    const targets = operands.map(gitBashPath);
    if (targets.some(target => !target)) return { complete: false, actions: [], reason: 'Bash path cannot be resolved' };
    return analyzeFiles([...targets.map(target => ({ path: target, kind: 'read' })), ...outputEntry], context);
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
