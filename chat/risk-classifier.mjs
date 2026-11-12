// Risk classifier for the unified AgentoC permission model. Pure logic, no I/O.
//
// Sits ABOVE chat/privileged-classifier.mjs. The privileged classifier answers
// "which privileged category does this sudo/install/delete op belong to?" for an
// op already known to be privileged. This module answers the broader question
// the gate (chat/privileged-gate.mjs decideRiskGate) needs for EVERY tool call
// in recommended/safe mode: "how risky is this, on a safe / caution / danger
// scale?" — and "must it route through the privileged executor?"
//
// Tiers map to gate behavior (risk-gated permission model):
//   safe     — auto-allow in every mode. Normal dev: reads, in-project edits,
//              ordinary composite-free commands, and in-scope installs (the
//              latter still routes through the executor via install-auto, but
//              needs no human prompt — see needsPrivilegedExecution).
//   caution  — auto-allow in `recommended`, escalate to phone approval in `safe`.
//              External/reversible-but-notable: network egress, writes outside
//              the project but inside $HOME, composite commands we only partly
//              analyzed.
//   danger   — escalate to phone approval in every gated mode. sudo, destructive
//              deletes, force-push, system-path targets, declared sentinels,
//              out-of-scope installs.
//
// needsPrivilegedExecution is decoupled from tier: an op may be low-risk to the
// USER (tier safe, e.g. an in-scope `apt install nginx`) yet still require the
// privileged executor (root + signed token + audit) to run correctly. The gate
// accumulates whenever needsPrivilegedExecution || tier === danger || (tier ===
// caution && mode === safe); within accumulated ops, install-auto vs the passkey
// path decides whether the user is actually prompted.
//
// IMPORTANT — this is a risk SIGNAL, not a security boundary. Static command
// analysis cannot see inside heredocs, script files, or obfuscated one-liners
// (e.g. `python -c "import shutil;shutil.rmtree('x')"`). The classifier does
// best-effort heuristics on those and defaults suspicious-but-unclear to
// `caution`, but it must never be treated as a complete block. The hard backstop
// is the OS layer: the Run user has no sudo group, provider Runs do not use
// NoNewPrivileges, and all elevation must cross the signed privileged executor;
// project-scoped FS APIs constrain blast radius.
//
// Reuses privileged-classifier.mjs for command analysis (program/verb/category/
// sudo/composite/scope) and its exported tokenizer + sudo-stripper, so the two
// modules never disagree on tokenization.

import { posix as POSIX_PATH, win32 as WIN32_PATH } from 'node:path';
import {
  CATEGORY_DELETE,
  CATEGORY_INSTALL,
  classifyPrivilegedOperation,
  stripSudo,
  tokenizeCommand,
} from './privileged-classifier.mjs';
import { parseCommandFacts } from './command-parser.mjs';
import {
  DESTRUCTIVE_ERASE_PROGRAMS,
  DESTRUCTIVE_SCRIPT_KEYWORDS,
  isComplexCommand,
  NETWORK_PROGRAMS,
  normalizeReasonMessages,
  platformFor,
  classifyRiskTargetScope,
  RISK_TARGET_SCOPE,
  RISK_PLATFORM,
  RISK_POLICY_VERSION,
  RISK_SOURCE_DETERMINISTIC,
  SCRIPT_INTERPRETERS,
  SENSITIVE_SYSTEM_PATHS,
  SYSTEM_PATH_ROOTS,
  systemPathRootsForPlatform,
} from './risk-policy.mjs';

export const RISK_TIER = Object.freeze({
  SAFE: 'safe',
  CAUTION: 'caution',
  DANGER: 'danger',
});

export const RISK_TIERS = Object.freeze([RISK_TIER.SAFE, RISK_TIER.CAUTION, RISK_TIER.DANGER]);

// Restrictiveness for tier reconciliation when combining signals (max wins).
export const TIER_RANK = Object.freeze({
  [RISK_TIER.SAFE]: 0,
  [RISK_TIER.CAUTION]: 1,
  [RISK_TIER.DANGER]: 2,
});

// File tools the gate sees via tool_name (Claude bidi shape: {tool_name, input}).
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'List']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Programs whose system-path usage is read-only (no side effects). Exempts plain
// reads (`cat /etc/hosts`, `ls /etc`) from the system-path danger signal while
// keeping writes/edits dangerous. `echo` etc. are still caught by the write-
// redirection check in isSystemPathReadOnly.
const READ_ONLY_SYSTEM_PROGRAMS = new Set([
  'cat', 'ls', 'stat', 'head', 'tail', 'grep', 'awk', 'df', 'du', 'free', 'ps',
  'top', 'id', 'whoami', 'hostname', 'uname', 'uptime', 'date', 'echo', 'env',
  'printenv', 'locale', 'getent', 'journalctl', 'lsof', 'ss', 'mount', 'find',
  'systemctl', 'service', 'git',
  // Pure stream filters / observers: read stdin or arguments, write stdout
  // only. Never add programs that can write files (sed -i, tee, cp, ...).
  'wc', 'sort', 'uniq', 'cut', 'comm', 'diff', 'cmp', 'md5sum', 'sha1sum',
  'sha256sum', 'sha512sum', 'file', 'realpath', 'readlink', 'basename',
  'dirname', 'tree', 'strings', 'xxd', 'od', 'hexdump', 'nl', 'seq', 'tr',
  'column', 'paste', 'join', 'fold', 'fmt', 'pr', 'expand', 'unexpand',
]);

// Same set under sudo: `sudo cat /etc/hosts` is still a plain read.
const SUDO_READ_ONLY_PROGRAMS = READ_ONLY_SYSTEM_PROGRAMS;

// Programs that can mutate a path when they appear in a composite command.
// A composite command that merely navigates to, reads, or probes a system path
// is cautionary in recommended mode; an explicit mutator remains danger.
const SYSTEM_PATH_MUTATING_PROGRAMS = new Set([
  'mkdir', 'cp', 'mv', 'install', 'touch', 'chmod', 'chown', 'chgrp', 'ln',
  'tee', 'dd', 'mkfs', 'mount', 'umount', 'rm', 'rmdir', 'unlink', 'shred',
  'truncate', 'systemctl', 'service', 'apt', 'apt-get', 'dpkg', 'dnf', 'yum',
  'apk', 'pacman', 'snap', 'npm', 'pip', 'pip3', 'pipx', 'gem',
]);

const PATH_MUTATING_PROGRAMS = new Set([
  'mkdir', 'touch', 'rm', 'rmdir', 'unlink', 'shred', 'truncate', 'cp', 'mv',
  'install', 'chmod', 'chown', 'chgrp', 'ln', 'tee', 'dd', 'mkfs', 'mount',
  'umount', 'find', 'git',
]);

// Shell control words as the parsed "program" of `for/while/if` loops and
// conditionals. The body may do anything, so a control word is not a program
// to judge: a loop reading a system path is at most caution (the body's real
// programs are invisible to static analysis), except sensitive-file reads,
// which stay danger.
const SHELL_CONTROL_PROGRAMS = new Set([
  'for', 'while', 'until', 'if', 'case', 'do', 'done', 'then', 'else', 'elif',
  'fi', 'esac', 'function',
]);

// Environment hooks that can load attacker-controlled code or alter the
// executable/runtime before the visible command starts. A leading assignment
// is part of the shell command (`BASH_ENV=/tmp/x.sh command`), so it must not
// be mistaken for the program name or silently downgraded to ordinary.
const DANGEROUS_ENVIRONMENT_ASSIGNMENTS = new Set([
  'BASH_ENV', 'ENV', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS',
  'PERL5OPT', 'PERL5LIB', 'PYTHONPATH', 'PYTHONINSPECT', 'RUBYOPT',
  'PROMPT_COMMAND',
]);

// systemctl / service subcommands that only observe state.
const SYSTEMCTL_READ_SUBCOMMANDS = new Set([
  'status', 'show', 'is-active', 'is-enabled', 'is-failed', 'is-installed',
  'cat', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'help',
]);
const SERVICE_READ_SUBCOMMANDS = new Set(['status']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function newSignals(tool) {
  return {
    tool,
    category: '',            // privileged category (install/other/delete) or 'read'/'file_edit'/'none'
    program: '',
    verb: '',
    sudo: false,
    composite: false,
    targetPaths: [],
    targetScope: RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE,
    projectMember: null,     // true/false/null(unknown)
    fileCountEstimate: 'one',// 'one' | 'few' | 'many'
    reversible: true,
    remote: false,
    credential: false,
    needsPrivilegedExecution: false,
    autoExecute: false,      // accumulated but no human prompt (install-auto)
    reasons: [],
  };
}

// pathInside mirrors chat/router-control-routes.mjs isPathInsideRoot without
// importing the heavy route module. Reimplemented locally on purpose.
function pathApiFor(riskContext) {
  return riskContext?.platform === 'win32' || process.platform === 'win32'
    ? WIN32_PATH
    : POSIX_PATH;
}

function pathInside(target, root, riskContext) {
  if (!target || !root) return false;
  const pathApi = pathApiFor(riskContext);
  const rootResolved = pathApi.resolve(root);
  const targetResolved = pathApi.resolve(target);
  const rel = pathApi.relative(rootResolved, targetResolved);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
}

function isSystemPath(p, riskContext) {
  if (!p) return false;
  const pathApi = pathApiFor(riskContext);
  const roots = Array.isArray(riskContext?.systemPathRoots)
    ? riskContext.systemPathRoots
    : systemPathRootsForPlatform(pathApi === WIN32_PATH ? 'win32' : 'posix');
  return roots.some((root) => pathInside(p, root, riskContext));
}

function resolveAgainst(p, cwd, riskContext) {
  if (!p) return '';
  const pathApi = pathApiFor(riskContext);
  if (pathApi.isAbsolute(p)) return pathApi.resolve(p);
  if (cwd) return pathApi.resolve(cwd, p);
  return p; // unresolvable relative path — returned as-is
}

function locatePath(target, cwd, projectRoot, home, riskContext) {
  if (!target) return 'unknown';
  const resolved = resolveAgainst(target, cwd, riskContext);
  const targetScope = classifyRiskTargetScope(resolved, { riskContext });
  if (targetScope === RISK_TARGET_SCOPE.PROTECTED_CONTROL) return targetScope;
  if (targetScope === RISK_TARGET_SCOPE.TRUSTED_WORKSPACE) return targetScope;
  if (targetScope === RISK_TARGET_SCOPE.SYSTEM) return targetScope;
  // Once admission supplies a trusted context, an outside target must not be
  // reclassified as in-project from caller-controlled projectRoot. Keep the
  // home distinction for explanation only; it never grants a safe tier.
  if (riskContext && typeof riskContext === 'object') {
    if (home && pathInside(resolved, home, riskContext)) return 'inside-home';
    return targetScope;
  }
  if (projectRoot && pathInside(resolved, projectRoot, riskContext)) return 'inside-project';
  if (home && pathInside(resolved, home, riskContext)) return 'inside-home';
  return 'unknown';
}

function extractTargetPath(toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  return trimString(input.file_path)
    || trimString(input.path)
    || trimString(input.notebook_path)
    || '';
}

// `git clean` only actually deletes when -f / --force is present.
function gitCleanForced(rest) {
  return rest.slice(1).some((arg) => arg === '--force' || /^-[a-z]*f/i.test(arg));
}

// `git push --force` / `--force-with-lease` / `--delete` rewrite remote history.
function gitPushForceOrDelete(rest) {
  return rest.slice(1).some((arg) =>
    arg === '--force'
    || arg === '--force-with-lease'
    || arg === '--delete'
    || /^-[a-z]*f/i.test(arg));
}

function firstSystemPathArg(tokens, cwd, riskContext) {
  const pathApi = pathApiFor(riskContext);
  let selected = '';
  let selectedRank = -1;
  const scopeRank = {
    [RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE]: 0,
    [RISK_TARGET_SCOPE.TRUSTED_WORKSPACE]: 1,
    [RISK_TARGET_SCOPE.SYSTEM]: 2,
    [RISK_TARGET_SCOPE.PROTECTED_CONTROL]: 3,
  };
  for (const token of tokens) {
    const candidates = (token.includes('{') || token.includes('}'))
      ? token.split(/[{},]/)
      : [token];
    for (const candidate of candidates) {
      if (!pathApi.isAbsolute(candidate)) continue;
      const resolved = resolveAgainst(candidate, cwd, riskContext);
      const scope = classifyRiskTargetScope(resolved, { riskContext });
      if (scope !== RISK_TARGET_SCOPE.SYSTEM && scope !== RISK_TARGET_SCOPE.PROTECTED_CONTROL) continue;
      const rank = scopeRank[scope] ?? 0;
      if (rank > selectedRank) {
        selected = candidate;
        selectedRank = rank;
      }
    }
  }
  return selected;
}

function normalizedProgramName(program) {
  const value = trimString(program);
  const slash = value.lastIndexOf('/');
  return (slash >= 0 ? value.slice(slash + 1) : value).toLowerCase();
}

function hasExplicitSystemPathMutation(command, program, facts, innerFacts) {
  // `/dev/tcp/...` is a bash network probe, not a filesystem write. A real
  // redirection to /etc, /var/log, etc. remains a danger signal.
  if (/\d*>{1,2}\s*\/(?!dev\/null\b|dev\/tcp\/)/i.test(command)) return true;

  const names = [
    normalizedProgramName(program),
    ...(Array.isArray(facts?.segments) ? facts.segments.map((segment) => normalizedProgramName(segment?.program)) : []),
    normalizedProgramName(innerFacts?.program),
    ...(Array.isArray(innerFacts?.segments) ? innerFacts.segments.map((segment) => normalizedProgramName(segment?.program)) : []),
  ].filter(Boolean);
  if (names.some((name) => SYSTEM_PATH_MUTATING_PROGRAMS.has(name))) return true;

  // Preserve the obvious remote/admin cases even when they are hidden inside
  // an SSH or shell segment whose top-level program is non-mutating.
  return /\b(?:sudo|rm\s+-[^\s]*r|chmod|chown|systemctl\s+(?:start|stop|restart|enable|disable)|service\s+\S+\s+(?:start|stop|restart))\b/i.test(command);
}

function looksRecursiveOrGlob(tokens) {
  if (tokens.some((t) => t === '-R' || t === '--recursive' || /^-[a-z]*r/i.test(t))) return true;
  if (tokens.some((t) => !t.startsWith('-') && /[*?\[\]]/.test(t))) return true;
  return false;
}

// Non-flag arguments of a delete command — the actual targets.
function deleteTargets(rest) {
  const targets = [];
  let afterDoubleDash = false;
  for (const arg of rest) {
    if (arg === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith('-')) continue;
    targets.push(arg);
  }
  return targets;
}

function hasFlag(rest, names, shortPattern) {
  return rest.some((arg) => names.includes(arg) || (shortPattern && shortPattern.test(arg)));
}

// True when a command touching a system path is a plain read: a read-only
// utility and no write redirection. Everything else (tee/install/cp, `> path`,
// rm, chmod, ...) is treated as a modification.
// Programs that erase or restructure data, plus sudo — used to keep loops and
// conditionals (whose parsed program is a shell control word, not the real
// body program) from being downgraded to caution when the body actually
// deletes or escalates.
function containsDestructiveProgram(tokens, command) {
  const destructive = new Set([
    'rm', 'shred', 'truncate', 'dd', 'mkfs', 'fdisk', 'parted', 'dropdb',
    'droprole', 'psql',
  ]);
  if (tokens.some((t) => destructive.has(t))) return true;
  if (/\bsudo\b/.test(command)) return true;
  if (/git\s+clean\s+-[a-z]*f/.test(command)) return true;
  if (/git\s+push\s+.*(--force|--force-with-lease|--delete)/.test(command)) return true;
  return false;
}

function isSystemPathReadOnly(program, command) {
  if (!READ_ONLY_SYSTEM_PROGRAMS.has(normalizedProgramName(program))) return false;
  // Write redirection — except `2>/dev/null` / `> /dev/null`, which only
  // discards output and is a standard stderr-silencing idiom on read-only
  // checks (`cat /etc/x 2>/dev/null` must stay exempt). Real file targets
  // (`> /tmp/x`, `>> /var/log/y`) still fail this and stay danger.
  if (/>>|>\s*\/(?!dev\/null\b)/.test(command)) return false;
  return true;
}

// Resolve a delete target: `~`/`~/...` against home, everything else against cwd.
function resolveDeleteTarget(target, cwd, home, riskContext) {
  const pathApi = pathApiFor(riskContext);
  if (target === '~') return home ? pathApi.resolve(home) : target;
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return home ? pathApi.resolve(home, target.slice(2)) : target;
  }
  return resolveAgainst(target, cwd, riskContext);
}

// Risk analysis for destructive-delete commands. Not every delete is dangerous:
// a single in-project file or a temp-dir cleanup is routine; system paths, the
// filesystem root, git metadata, and pattern/variable targets are danger.
function analyzeDelete({ program, rest, tokens, cwd, projectRoot, home, riskContext, signals, markDanger, markCaution }) {
  signals.reversible = false; // physical removal is never reversible
  if (DESTRUCTIVE_ERASE_PROGRAMS.has(program)) {
    markDanger(`${program} (irreversible data destruction)`);
    signals.fileCountEstimate = 'many';
    return;
  }
  if (program === 'rmdir') {
    // Removes only empty directories — harmless.
    signals.reasons = ['remove empty directory'];
    return;
  }

  const targets = deleteTargets(rest);
  const recursive = hasFlag(rest, ['-r', '-R', '--recursive'], /^-[a-z]*r/i);
  const glob = targets.some((t) => /[*?\[\]]/.test(t));
  const variable = targets.some((t) => /\$[A-Za-z_{]/.test(t));

  // Hard-danger locations first (most severe wins).
  for (const target of targets) {
    const pathApi = pathApiFor(riskContext);
    const resolved = resolveDeleteTarget(target, cwd, home, riskContext);
    if (resolved && pathApi.parse(resolved).root === resolved) {
      markDanger('delete of filesystem root');
      signals.fileCountEstimate = 'many';
      return;
    }
    const targetScope = classifyRiskTargetScope(resolved, { riskContext });
    if (targetScope === RISK_TARGET_SCOPE.PROTECTED_CONTROL) {
      markDanger('targets Ragent control-plane path');
      signals.targetPaths.push(target);
      signals.fileCountEstimate = recursive || glob ? 'many' : 'few';
      return;
    }
    const isSystemTarget = targetScope === RISK_TARGET_SCOPE.SYSTEM
      || (!riskContext && isSystemPath(resolved, riskContext));
    if (isSystemTarget) {
      markDanger(`delete on system path (${target})`);
      signals.targetPaths.push(target);
      signals.fileCountEstimate = recursive || glob ? 'many' : 'few';
      return;
    }
    if (/(^|\/)\.git(\/|$)/.test(resolved)) {
      markDanger('delete of git metadata (.git)');
      return;
    }
    const proj = projectRoot ? pathApi.resolve(projectRoot) : '';
    if (proj && pathApi.resolve(resolved) === proj) {
      markDanger('delete of project root');
      return;
    }
    const hm = home ? pathApi.resolve(home) : '';
    if (hm && pathApi.resolve(resolved) === hm) {
      markDanger('delete of home root');
      return;
    }
  }

  // Pattern / variable targets: recursive removal matches unpredictably.
  if (recursive && (glob || variable)) {
    markDanger(glob ? 'recursive delete of glob pattern' : 'recursive delete with variable target');
    signals.fileCountEstimate = 'many';
    return;
  }
  if (targets.length === 0 && program !== 'find') {
    // e.g. bare `rm -rf` — the shell refuses with "missing operand".
    markCaution('delete with no explicit target');
    return;
  }

  // Batch `find -delete`: system path is danger, otherwise conservative caution.
  if (program === 'find') {
    const sysTarget = firstSystemPathArg(tokens, cwd, riskContext);
    if (sysTarget) {
      markDanger(`delete on system path (${sysTarget})`);
      signals.fileCountEstimate = 'many';
      return;
    }
    markCaution('batch delete via find');
    signals.fileCountEstimate = 'many';
    return;
  }

  // Explicit targets: grade by location + recursion.
  if (targets.length === 1) {
    const target = targets[0];
    const resolved = resolveDeleteTarget(target, cwd, home, riskContext);
    if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) {
      // Explicit home target (`rm ~/notes.md`) — user-scope, not project-scope.
      markCaution('delete outside project (home)');
      signals.fileCountEstimate = recursive ? 'many' : 'few';
      return;
    }
    const location = locatePath(target, cwd, projectRoot, home, riskContext);
    if (location === 'inside-project' || location === RISK_TARGET_SCOPE.TRUSTED_WORKSPACE) {
      if (!recursive) {
        signals.reasons = ['in-project delete'];
        signals.fileCountEstimate = 'one';
        return;
      }
      markCaution('recursive delete in project');
      signals.fileCountEstimate = 'many';
      return;
    }
    if (resolved.startsWith('/tmp')) {
      if (!recursive) {
        signals.reasons = ['temp-dir delete'];
        signals.fileCountEstimate = 'one';
        return;
      }
      markCaution('recursive delete in temp dir');
      signals.fileCountEstimate = 'many';
      return;
    }
    if (location === 'inside-home') {
      markCaution('delete outside project (home)');
      signals.fileCountEstimate = recursive ? 'many' : 'few';
      return;
    }
    markCaution('delete with unresolvable target');
    signals.fileCountEstimate = recursive ? 'many' : 'few';
    return;
  }

  // Multiple targets: batch removal is conservative-caution unless already danger.
  markCaution('multi-target delete');
  signals.fileCountEstimate = recursive ? 'many' : 'few';
}

// 统一风险契约输出。兼容旧字段（tier/signals/privilegedClassification），
// 新增：policyVersion / source / platform / confidence / reasons[{code,message}] / facts。
function finalizeRisk(tier, signals, privilegedClassification, extra = {}) {
  const {
    facts = null,
    platform = RISK_PLATFORM.NONE,
    confidence = 'high',
    arbitrate = false,
  } = extra;
  return {
    tier,
    signals,
    privilegedClassification,
    policyVersion: RISK_POLICY_VERSION,
    source: RISK_SOURCE_DETERMINISTIC,
    platform,
    confidence,
    reasons: normalizeReasonMessages(signals.reasons),
    facts,
    arbitrate,
  };
}

function confidenceFor(facts, privilegedClassification) {
  if (facts?.unknownProgram) return 'low';
  if (facts?.composite || privilegedClassification?.confidence === 'low') return 'medium';
  return 'high';
}

function fileToolFacts(toolName, toolInput, cwd, projectRoot, home, riskContext) {
  const target = extractTargetPath(toolInput);
  return {
    platform: RISK_PLATFORM.FILE_TOOL,
    toolName,
    target,
    targetScope: locatePath(target, cwd, projectRoot, home, riskContext),
    program: '',
    verb: '',
    sudo: false,
    composite: false,
    complex: false,
    network: false,
    irreversible: false,
  };
}

// Classify a file tool (Read/Edit/Write/...) by its target path.
function classifyFileTool(toolName, toolInput, cwd, projectRoot, home, riskContext, signals) {
  signals.category = READ_TOOLS.has(toolName) ? 'read' : 'file_edit';
  const target = extractTargetPath(toolInput);
  const loc = locatePath(target, cwd, projectRoot, home, riskContext);
  signals.targetScope = loc === 'unknown' ? RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE : loc;
  if (READ_TOOLS.has(toolName)) {
    if (loc === RISK_TARGET_SCOPE.PROTECTED_CONTROL) {
      signals.reversible = false;
      signals.needsPrivilegedExecution = true;
      signals.reasons = ['reads Ragent control-plane path'];
      return finalizeRisk(RISK_TIER.DANGER, signals, null, {
        facts: fileToolFacts(toolName, toolInput, cwd, projectRoot, home, riskContext),
        platform: RISK_PLATFORM.FILE_TOOL,
      });
    }
    return finalizeRisk(RISK_TIER.SAFE, signals, null, {
      facts: fileToolFacts(toolName, toolInput, cwd, projectRoot, home, riskContext),
      platform: RISK_PLATFORM.FILE_TOOL,
    });
  }
  signals.targetPaths = target ? [target] : [];
  signals.projectMember = loc === 'inside-project' || loc === RISK_TARGET_SCOPE.TRUSTED_WORKSPACE;
  if (loc === RISK_TARGET_SCOPE.PROTECTED_CONTROL || loc === RISK_TARGET_SCOPE.SYSTEM) {
    signals.reversible = false;
    signals.needsPrivilegedExecution = true;
    signals.reasons = [loc === RISK_TARGET_SCOPE.PROTECTED_CONTROL
      ? 'targets Ragent control-plane path'
      : 'write to system path'];
    return finalizeRisk(RISK_TIER.DANGER, signals, null, {
      facts: fileToolFacts(toolName, toolInput, cwd, projectRoot, home, riskContext),
      platform: RISK_PLATFORM.FILE_TOOL,
    });
  }
  if (loc === 'inside-project' || loc === RISK_TARGET_SCOPE.TRUSTED_WORKSPACE) {
    signals.reasons = ['in-project file edit'];
    return finalizeRisk(RISK_TIER.SAFE, signals, null, {
      facts: fileToolFacts(toolName, toolInput, cwd, projectRoot, home, riskContext),
      platform: RISK_PLATFORM.FILE_TOOL,
    });
  }
  signals.reasons = ['file edit outside project root'];
  return finalizeRisk(RISK_TIER.CAUTION, signals, null, {
    facts: fileToolFacts(toolName, toolInput, cwd, projectRoot, home, riskContext),
    platform: RISK_PLATFORM.FILE_TOOL,
  });
}

/**
 * Classify a single tool call's risk.
 *
 * @param {object} input
 * @param {string} [input.command]      Shell command (Bash). Empty for file tools.
 * @param {string} [input.toolName]     Provider tool name (Read/Edit/Write/Bash...).
 * @param {object} [input.toolInput]    Provider tool input (carries file_path etc.).
 * @param {string} [input.cwd]          Run cwd, used to resolve relative paths.
 * @param {string} [input.projectRoot]  Project root for in-project checks.
 * @param {string} [input.declaredCategory] Privileged category declared via the
 *   `agentoc-privileged` sentinel (the gate parses the sentinel and passes this).
 * @param {string} [input.home]         $HOME override (defaults to process.env.HOME).
 * @param {object} [input.riskContext]  Frozen admission-time path context.
 * @returns {{tier:string, signals:object, privilegedClassification:object|null}}
 */
export function classifyRisk(input = {}) {
  const command = trimString(input.command);
  const toolName = trimString(input.toolName);
  const toolInput = input.toolInput && typeof input.toolInput === 'object' ? input.toolInput : {};
  const cwd = trimString(input.cwd);
  const projectRoot = trimString(input.projectRoot);
  const declaredCategory = trimString(input.declaredCategory);
  const home = trimString(input.home) || trimString(process.env.HOME);
  const riskContext = input.riskContext && typeof input.riskContext === 'object'
    ? input.riskContext
    : null;

  const signals = newSignals(toolName || (command ? 'Bash' : 'none'));

  // === File tools (no shell command) ===
  if (toolName && (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName))) {
    return classifyFileTool(toolName, toolInput, cwd, projectRoot, home, riskContext, signals);
  }

  // === Bash command ===
  if (!command) {
    // Non-command, non-file gate (permissions prompt, etc.) or unknown tool.
    signals.reasons = ['no command'];
    return finalizeRisk(RISK_TIER.SAFE, signals, null, { platform: RISK_PLATFORM.NONE });
  }

  const facts = parseCommandFacts(command, { cwd, projectRoot, home, declaredCategory, riskContext });
  let pc = classifyPrivilegedOperation({ command, declaredCategory, cwd });
  // 前导包装（env/command/nohup/nice/timeout/exec）后的 sudo 此前会被当成包装命令
  // 本身而漏判（`env sudo apt install` 曾判成普通 env）。解析器看穿包装后，分类决策
  // 改用解包命令重新派生，让 install/delete/sudo 分支对同一命令给出同一语义。
  let pcSource = command;
  if (facts && facts.unwrappedCommand && facts.unwrappedCommand !== command) {
    pcSource = facts.unwrappedCommand;
    pc = classifyPrivilegedOperation({ command: pcSource, declaredCategory, cwd });
  }
  signals.category = pc.category;
  signals.program = pc.program;
  signals.verb = pc.verb;
  signals.sudo = pc.sawSudo === true;
  signals.composite = pc.composite;

  const { tokens } = tokenizeCommand(pcSource);
  const { rest } = stripSudo(tokens); // args after the real program
  const innerFacts = facts?.scriptInterpreter && facts?.innerCommand
    ? parseCommandFacts(facts.innerCommand, { cwd, projectRoot, home, riskContext })
    : null;
  const innerSystemPathReadOnly = Boolean(innerFacts?.systemPath)
    && innerFacts.systemPathScope !== RISK_TARGET_SCOPE.PROTECTED_CONTROL
    && isSystemPathReadOnly(innerFacts.program, facts.innerCommand);
  const program = pc.program;
  const verb = pc.verb;

  const dangerReasons = [];
  const cautionReasons = [];
  const markDanger = (reason) => dangerReasons.push(reason);
  const markCaution = (reason) => cautionReasons.push(reason);

  // --- Install handling (needs executor regardless of tier) ---
  if (pc.category === CATEGORY_INSTALL) {
    if (pc.inScope === true) {
      // A sudo prefix does not make an otherwise bounded named-package
      // install dangerous. The provider shell cannot elevate in AgentoC's
      // service sandbox, so route both `apt install foo` and `sudo apt install
      // foo` through the same signed install-auto executor path. The executor
      // re-checks the structural whitelist; this is not blanket sudo approval.
      signals.needsPrivilegedExecution = true;
      // System package install: low user-facing risk — install-auto runs it as
      // root via a signed token with no per-op prompt — but it must accumulate
      // so the executor (not the unprivileged provider shell) runs it.
      signals.autoExecute = true;
      signals.reasons = ['in-scope install (install-auto)'];
      return finalizeRisk(RISK_TIER.SAFE, signals, pc, {
        facts,
        platform: facts?.platform || platformFor(command),
        confidence: 'high',
      });
    } else if (signals.sudo) {
      // Sudo plus an out-of-scope install (local .deb, repo mutation,
      // language package manager, reinstall, or composite command) remains a
      // human-approved operation.  In particular, do not let the safe sudo
      // install path widen its scope through the sudo prefix.
      markDanger('sudo install');
      signals.needsPrivilegedExecution = true;
    } else {
      // Out-of-scope (language PM / composite / repo mutation / local .deb):
      // typically installs to user/project scope without root, so it runs as the
      // session user. If it truly needs root it fails and the agent can re-issue
      // with sudo (which routes to the passkey path).
      markCaution('out-of-scope install');
    }
  }

  // --- Danger signals ---
  // Read-only sudo is safe, but every sudo operation that can change host state
  // requires the owner approval path. This includes routine administration such
  // as `sudo systemctl restart`; routine does not mean non-privileged.
  if (signals.sudo && pc.category !== CATEGORY_INSTALL && dangerReasons.length === 0) {
    if (SCRIPT_INTERPRETERS.has(program)) {
      markDanger('sudo with script interpreter (arbitrary code)');
    } else if (SUDO_READ_ONLY_PROGRAMS.has(program)) {
      if (program === 'systemctl') {
        const sub = rest.find((a) => !a.startsWith('-')) || '';
        if (!SYSTEMCTL_READ_SUBCOMMANDS.has(sub)) markDanger('sudo system administration requires approval');
      } else if (program === 'service') {
        // `service <name> <command>` — the verb is the second argument; leading
        // flags like `--status-all` are read-only.
        const sub = rest[1] || rest[0] || '';
        if (!((rest[0] || '').startsWith('-') || SERVICE_READ_SUBCOMMANDS.has(sub))) {
          markDanger('sudo service control requires approval');
        }
      }
      // Plain read-only sudo — no signal, stays safe.
    } else {
      markDanger('sudo / privilege escalation');
    }
  }
  if (declaredCategory) markDanger('declared privileged op (sentinel)');
  if (pc.category === CATEGORY_DELETE) {
    analyzeDelete({ program, rest, tokens, cwd, projectRoot, home, riskContext, signals, markDanger, markCaution });
    if ((facts?.deleteTargets || []).some(target => /(?:^|[\\/])(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube)(?:[\\/]|$)/i.test(target))) {
      markDanger('delete credential directory');
      signals.reversible = false;
    }
  }
  if (program === 'git' && verb === 'clean') {
    if (gitCleanForced(rest)) {
      markDanger('git clean --force');
      signals.reversible = false;
    } else {
      markCaution('git clean (unforced)');
    }
  }
  if (program === 'git' && verb === 'push' && gitPushForceOrDelete(rest)) {
    markDanger('git push --force/--delete');
    signals.reversible = false;
  }
  // Scan arguments, not the executable token. This avoids classifying
  // `/usr/bin/bash`, `/bin/grep`, and similar absolute executable paths as
  // system-path writes.
  const systemPath = firstSystemPathArg(rest, cwd, riskContext);
  const systemPathScope = systemPath
    ? classifyRiskTargetScope(resolveAgainst(systemPath, cwd, riskContext), { riskContext })
    : RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE;
  signals.targetScope = systemPath
    ? systemPathScope
    : (facts?.targetScope || classifyRiskTargetScope(cwd, { riskContext }));
  const targetPathScopes = Array.isArray(facts?.targetPathScopes) ? facts.targetPathScopes : [];
  const mutatesPath = PATH_MUTATING_PROGRAMS.has(normalizedProgramName(program))
    || pc.category === CATEGORY_DELETE
    || pc.category === CATEGORY_INSTALL;
  const tempOnlyDelete = pc.category === CATEGORY_DELETE
    && Array.isArray(facts?.targetScopes)
    && facts.targetScopes.length > 0
    && facts.targetScopes.every((scope) => scope === 'temp');
  if (dangerReasons.length === 0 && riskContext && mutatesPath) {
    if (targetPathScopes.includes(RISK_TARGET_SCOPE.PROTECTED_CONTROL)
      || (!systemPath && signals.targetScope === RISK_TARGET_SCOPE.PROTECTED_CONTROL)) {
      markDanger('targets Ragent control-plane path');
      signals.reversible = false;
    } else if (targetPathScopes.includes(RISK_TARGET_SCOPE.SYSTEM)
      || (!systemPath && signals.targetScope === RISK_TARGET_SCOPE.SYSTEM)) {
      markDanger('targets system path');
      signals.reversible = false;
    } else if (targetPathScopes.includes(RISK_TARGET_SCOPE.OUTSIDE_WORKSPACE) && !tempOnlyDelete) {
      markCaution('path outside trusted workspace');
    }
  }
  if (systemPath && systemPathScope !== RISK_TARGET_SCOPE.TRUSTED_WORKSPACE && dangerReasons.length === 0) {
    if (systemPathScope === RISK_TARGET_SCOPE.PROTECTED_CONTROL) {
      markDanger('targets Ragent control-plane path');
      signals.reversible = false;
      signals.targetPaths.push(systemPath);
    } else if (SHELL_CONTROL_PROGRAMS.has(program)) {
      // `for/while/if` loop over a system path: the body's real programs are
      // invisible here, so downgrade to caution — except sensitive-file reads
      // and any destructive/sudo program visible anywhere in the command,
      // which stay danger.
      if (SENSITIVE_SYSTEM_PATHS.some((p) => systemPath.startsWith(p))) {
        markDanger('read sensitive system file');
        signals.reversible = false;
        signals.targetPaths.push(systemPath);
      } else if (containsDestructiveProgram(tokens, command)) {
        markDanger('destructive command inside shell control structure');
        signals.reversible = false;
        signals.targetPaths.push(systemPath);
      } else {
        markCaution('shell control structure reading system path');
        signals.targetPaths.push(systemPath);
      }
    } else if (isSystemPathReadOnly(program, command) || innerSystemPathReadOnly) {
      // Plain read of a system path (`cat /etc/hosts`) is safe — unless the
      // target is a secret/root-policy file.
      if (SENSITIVE_SYSTEM_PATHS.some((p) => systemPath.startsWith(p))) {
        markDanger('read sensitive system file');
        signals.reversible = false;
        signals.targetPaths.push(systemPath);
      }
    } else if ((pc.composite || innerFacts) && !hasExplicitSystemPathMutation(command, program, facts, innerFacts)) {
      // The top-level parser intentionally has limited shell semantics. A
      // path in `cd /var/... && rg ...`, `ssh ...`, or a pipeline is not enough
      // evidence of a local system write. Keep the command in caution so
      // recommended mode can auto-allow it, while explicit mutation signals
      // above still fail closed into danger.
      markCaution('composite command (partly analyzed)');
    } else {
      markDanger('targets system path');
      signals.reversible = false;
      signals.targetPaths.push(systemPath);
    }
  }
  if (SCRIPT_INTERPRETERS.has(program) && DESTRUCTIVE_SCRIPT_KEYWORDS.test(command)) {
    markDanger('interpreter with destructive keyword');
    signals.reversible = false;
  }

  // The parser can see sensitive paths inside brace expansion and other
  // compact shell forms (`cat {/etc/passwd,/etc/shadow}`) that the lightweight
  // token scan above cannot represent as a plain path argument.
  if (facts?.sensitiveSystemPath && dangerReasons.length === 0) {
    markDanger('read sensitive system file');
    signals.reversible = false;
    signals.targetPaths.push(facts.sensitiveSystemPath);
  }

  if (facts?.environmentAssignments?.some(({ name, value }) => (
    DANGEROUS_ENVIRONMENT_ASSIGNMENTS.has(String(name || '').toUpperCase())
    && String(value || '').trim() !== ''
    && String(value || '').trim() !== '/dev/null'
  ))) {
    markDanger('environment variable can inject code or alter runtime behavior');
    signals.reversible = false;
  }

  // --- 阶段 2：解析器增强信号（下载执行 / find -exec / 内嵌脚本） ---
  // 下载后执行：远程不可信代码直接在本机运行，升级为 danger。
  if (facts?.downloadAndExecute && dangerReasons.length === 0) {
    markDanger('download and execute remote script');
    signals.remote = true;
    signals.reversible = false;
  }
  // find -exec：批量执行；出现破坏性程序（rm/shred/truncate/...）为 danger，
  // 其余与 find -delete 一致保守 caution。
  if (facts?.findExecDestructive) {
    markDanger('destructive find -exec');
    signals.fileCountEstimate = 'many';
    signals.reversible = false;
  } else if (facts?.findExec && dangerReasons.length === 0) {
    markCaution('batch find -exec');
    signals.fileCountEstimate = 'many';
  }
  // xargs：批量执行；出现破坏性程序（rm/shred/...）为 danger，其余保守 caution。
  if (facts?.xargsDestructive) {
    markDanger('destructive xargs');
    signals.fileCountEstimate = 'many';
    signals.reversible = false;
  } else if (facts?.xargs && dangerReasons.length === 0) {
    markCaution('batch execute via xargs');
    signals.fileCountEstimate = 'many';
  }
  // 内嵌脚本（bash -c / sh -c / python -c / node -e）：递归解析内层命令，
  // 把 sudo、危险删除、系统路径写入、force push、下载执行等信号带上来。
  if (facts?.scriptInterpreter && facts?.innerCommand) {
    if (innerFacts) {
      if (innerFacts.sudo) markDanger('sudo inside script interpreter');
      if (innerFacts.systemPathScope === RISK_TARGET_SCOPE.PROTECTED_CONTROL) {
        markDanger('targets Ragent control-plane path');
      }
      if (innerFacts.dangerDelete) markDanger('destructive command inside script interpreter');
      else if (innerFacts.category === CATEGORY_DELETE) markCaution('delete inside script interpreter');
      if (innerFacts.systemPath
        && innerFacts.systemPathScope !== RISK_TARGET_SCOPE.TRUSTED_WORKSPACE
        && !isSystemPathReadOnly(innerFacts.program, facts.innerCommand)) {
        markDanger('script interpreter writes system path');
      }
      if (innerFacts.forcePush) markDanger('git push --force inside script interpreter');
      if (innerFacts.downloadAndExecute) markDanger('download and execute inside script interpreter');
      if (innerFacts.scriptInterpreter) markCaution('nested script interpreter');
    }
  }

  // Anything that hit a danger reason routes through the executor.
  if (dangerReasons.length > 0) signals.needsPrivilegedExecution = true;

  // file-count estimate for destructive ops (display only).
  if (program === 'git' && verb === 'clean' && gitCleanForced(rest)) {
    signals.fileCountEstimate = 'many';
  }

  // --- Caution signals (ignored once danger is present) ---
  if (NETWORK_PROGRAMS.has(program)) {
    signals.remote = true;
    markCaution('network egress');
  }
  if (program === 'git' && ['push', 'fetch', 'pull', 'clone'].includes(verb)
    && !(verb === 'push' && gitPushForceOrDelete(rest))) {
    signals.remote = true;
    markCaution('git remote operation');
  }
  if (pc.composite && dangerReasons.length === 0
    && !cautionReasons.includes('composite command (partly analyzed)')) {
    markCaution('composite command (partly analyzed)');
  }

  // --- Command complexity signal ---
  // Composite constructs (pipes, command substitution, variable expansion,
  // control flow, heredocs) hide the real command from the token-table
  // heuristic. Preserve that fact for audit and projection diagnostics; the
  // tier above is decided by the table regardless.
  signals.complex = isComplexCommand(command);

  // --- Reconcile tier ---
  let tier;
  if (dangerReasons.length > 0) {
    tier = RISK_TIER.DANGER;
    signals.reasons = dangerReasons;
  } else if (cautionReasons.length > 0) {
    tier = RISK_TIER.CAUTION;
    signals.reasons = cautionReasons;
  } else {
    tier = RISK_TIER.SAFE;
    signals.reasons = signals.reasons.length > 0 ? signals.reasons : ['ordinary command'];
  }

  return finalizeRisk(tier, signals, pc, {
    facts,
    platform: facts?.platform || platformFor(command),
    confidence: confidenceFor(facts, pc),
    arbitrate: tier === RISK_TIER.DANGER || signals.complex === true,
  });
}
