// Narrow allowlist for literal, read-only Git queries emitted by Claude Code.
// Mutating subcommands and unrecognized options always fall through to review.
const STATUS_FLAGS = new Set([
  '-s', '--short', '-b', '--branch', '--porcelain', '--porcelain=v1', '--porcelain=v2',
  '--no-ahead-behind', '--renames', '--no-renames', '--ignored', '--show-stash',
  '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all',
]);

const DIFF_SUMMARY_FLAGS = new Set([
  '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--check',
]);
const DIFF_SAFE_COMMON_FLAGS = new Set(['--no-ext-diff', '--no-textconv', '--no-color', '--color=never']);

function readAction(subcommand) {
  return { kind: 'read', program: `git ${subcommand}`, target: null };
}

export function analyzeWindowsReadOnlyGit(argv) {
  if (!Array.isArray(argv) || argv.length < 2 || !['git', 'git.exe'].includes(String(argv[0]).toLowerCase())) return null;
  const subcommand = String(argv[1]).toLowerCase();
  const args = argv.slice(2).map((value) => String(value));
  if (subcommand === 'status' && args.every((arg) => STATUS_FLAGS.has(arg))) {
    return { complete: true, actions: [readAction(subcommand)] };
  }
  if (subcommand === 'diff') {
    const summariesOnly = args.some((arg) => DIFF_SUMMARY_FLAGS.has(arg))
      && args.every((arg) => DIFF_SUMMARY_FLAGS.has(arg) || DIFF_SAFE_COMMON_FLAGS.has(arg));
    const safePatch = args.includes('--no-ext-diff') && args.includes('--no-textconv')
      && args.every((arg) => DIFF_SUMMARY_FLAGS.has(arg) || DIFF_SAFE_COMMON_FLAGS.has(arg)
        || arg === '--cached' || arg === '--staged');
    if (summariesOnly || safePatch) return { complete: true, actions: [readAction(subcommand)] };
  }
  if (subcommand === 'branch' && (args.length === 0 || (args.length === 1 && args[0] === '--show-current'))) {
    return { complete: true, actions: [readAction(subcommand)] };
  }
  if (subcommand === 'rev-parse' && args.length === 1
      && ['--show-toplevel', '--is-inside-work-tree', '--show-prefix'].includes(args[0])) {
    return { complete: true, actions: [readAction(subcommand)] };
  }
  if (subcommand === 'log' && args.length > 0 && args.every((arg) =>
    ['--oneline', '--decorate=short', '--no-decorate', '--no-pager'].includes(arg)
      || /^-(?:n|\d{1,6})$/.test(arg) || /^--max-count=\d{1,6}$/.test(arg))) {
    return { complete: true, actions: [readAction(subcommand)] };
  }
  return null;
}
