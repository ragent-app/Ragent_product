// Narrow allowlist for literal, read-only Git queries emitted by Claude Code.
// Mutating subcommands and unrecognized options always fall through to review.
const STATUS_FLAGS = new Set([
  '-s', '--short', '-b', '--branch', '--porcelain', '--porcelain=v1', '--porcelain=v2',
  '--no-ahead-behind', '--renames', '--no-renames', '--ignored', '--show-stash',
  '--ignored=matching', '--ignored=traditional', '--ignored=no', '-uno', '-unormal', '-uall',
  '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all',
]);

const DIFF_SUMMARY_FLAGS = new Set([
  '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--check',
]);
const DIFF_SAFE_COMMON_FLAGS = new Set(['--no-ext-diff', '--no-textconv', '--no-color', '--color=never']);
const BRANCH_READ_FLAGS = new Set(['--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--no-color', '--color=never', '--list']);
const REV_PARSE_READ_FLAGS = new Set(['--show-toplevel', '--is-inside-work-tree', '--is-inside-git-dir', '--show-prefix', '--show-cdup', '--git-dir', '--git-common-dir', '--show-object-format']);

function isReadOnlyLogArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (['-n', '--max-count'].includes(arg)) {
      if (!/^\d{1,6}$/.test(args[++index] || '')) return false;
      continue;
    }
    if (['--oneline', '--decorate', '--decorate=short', '--decorate=full', '--no-decorate', '--no-pager', '--no-color', '--color=never', '--all'].includes(arg)
        || /^-(?:n\d{1,6}|\d{1,6})$/.test(arg) || /^--max-count=\d{1,6}$/.test(arg)
        || /^--(?:pretty|format)=(?:oneline|short|medium|full|fuller)$/.test(arg)) continue;
    return false;
  }
  return true;
}

function readAction(subcommand) {
  return { kind: 'read', program: `git ${subcommand}`, target: null };
}

export function analyzeWindowsReadOnlyGit(argv) {
  if (!Array.isArray(argv) || argv.length < 2 || !['git', 'git.exe'].includes(String(argv[0]).toLowerCase())) return null;
  const subcommand = String(argv[1]).toLowerCase();
  const args = argv.slice(2).map((value) => String(value));
  if (subcommand === 'status' && args.every((arg) => STATUS_FLAGS.has(arg) || /^-[sb]+$/.test(arg))) {
    return { complete: true, actions: [readAction(subcommand)] };
  }
  if (subcommand === 'diff') {
    const summariesOnly = args.some((arg) => DIFF_SUMMARY_FLAGS.has(arg))
      && args.every((arg) => DIFF_SUMMARY_FLAGS.has(arg) || DIFF_SAFE_COMMON_FLAGS.has(arg) || arg === '--cached' || arg === '--staged');
    const safePatch = args.includes('--no-ext-diff') && args.includes('--no-textconv')
      && args.every((arg) => DIFF_SUMMARY_FLAGS.has(arg) || DIFF_SAFE_COMMON_FLAGS.has(arg)
        || arg === '--cached' || arg === '--staged');
    if (summariesOnly || safePatch) return { complete: true, actions: [readAction(subcommand)] };
  }
  if (subcommand === 'branch' && args.every((arg) => BRANCH_READ_FLAGS.has(arg))) {
    return { complete: true, actions: [readAction(subcommand)] };
  }
  if (subcommand === 'rev-parse' && args.length > 0 && args.every(arg => REV_PARSE_READ_FLAGS.has(arg))) {
    return { complete: true, actions: [readAction(subcommand)] };
  }
  if (subcommand === 'log' && isReadOnlyLogArgs(args)) {
    return { complete: true, actions: [readAction(subcommand)] };
  }
  return null;
}

// Local staging and commits are ordinary development work. Git hooks may
// execute project code, just as an approved project build or test can.
export function analyzeWindowsLocalGit(argv) {
  if (!Array.isArray(argv) || argv.length < 2 || !['git', 'git.exe'].includes(String(argv[0]).toLowerCase())
      || argv.some(value => typeof value !== 'string' || value.includes('\0'))) return null;
  const subcommand = argv[1].toLowerCase();
  const args = argv.slice(2);
  let allowed = false;
  if (subcommand === 'diff') {
    allowed = args.every(arg => DIFF_SUMMARY_FLAGS.has(arg) || DIFF_SAFE_COMMON_FLAGS.has(arg) || ['--cached', '--staged'].includes(arg));
  } else if (subcommand === 'add') {
    allowed = args.length > 0 && args.every(arg => !arg.startsWith('-') || ['-A', '--all', '-u', '--update', '--'].includes(arg));
  } else if (subcommand === 'commit') {
    let message = false;
    allowed = true;
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-m' || args[i] === '--message') { if (!args[++i]) { allowed = false; break; } message = true; continue; }
      if (['-a', '--all', '--no-verify', '--allow-empty'].includes(args[i])) continue;
      allowed = false; break;
    }
    allowed &&= message;
  }
  return allowed ? { complete: true, actions: [{ kind: subcommand === 'diff' ? 'read' : 'write', program: `git ${subcommand}`, target: null, caution: true }] } : null;
}
