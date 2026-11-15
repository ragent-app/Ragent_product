import { createHash } from 'crypto';

// Privilege classifier for the Ragent sudo-approval gate (design:
// notes/current/privileged-approval-design.md). Pure logic, no I/O.
//
// A privileged operation is declared by the agent via the `privileged_op`
// primitive. This module re-derives a category deterministically from the
// command and reconciles it with the agent's declared category, taking the
// MORE RESTRICTIVE on conflict and defaulting to deny (never auto-install)
// when ambiguous.

export const CATEGORY_INSTALL = 'software_install';
export const CATEGORY_OTHER = 'privileged_other';
export const CATEGORY_DELETE = 'destructive_delete';

export const PRIVILEGED_CATEGORIES = Object.freeze([
  CATEGORY_INSTALL,
  CATEGORY_OTHER,
  CATEGORY_DELETE,
]);

// Higher rank = more restrictive. Reconciliation takes the max.
const RESTRICTIVENESS = Object.freeze({
  [CATEGORY_INSTALL]: 0,
  [CATEGORY_OTHER]: 1,
  [CATEGORY_DELETE]: 2,
});

const CATEGORY_TITLES = Object.freeze({
  [CATEGORY_INSTALL]: 'Software install',
  [CATEGORY_OTHER]: 'Privileged operation',
  [CATEGORY_DELETE]: 'Destructive delete',
});

// Package managers + the verb that means "install/upgrade".
const INSTALL_VERBS = Object.freeze({
  apt: ['install', 'reinstall', 'upgrade', 'full-upgrade', 'dist-upgrade', 'install-recommends'],
  'apt-get': ['install', 'reinstall', 'upgrade', 'full-upgrade', 'dist-upgrade', 'install-recommends'],
  dnf: ['install', 'reinstall', 'upgrade'],
  yum: ['install', 'reinstall', 'upgrade'],
  snap: ['install'],
  brew: ['install'],
  apk: ['add'],
  // classifyPrivilegedOperation normalizes the first verb to lowercase before
  // matching. Keep the short forms lowercase here as well so the standard
  // `pacman -S package` install path is not misclassified as privileged_other.
  pacman: ['-s', '--sync', '-sy', '-syy'],
  dpkg: ['-i', '--install'],
  pip: ['install'],
  pip3: ['install'],
  pipx: ['install'],
  npm: ['install', 'i'],
  gem: ['install'],
});

// Programs whose sole purpose is to mutate package sources/repos. Treated as
// the install category but always out of auto-approve scope.
const REPO_MUTATION_PROGRAMS = new Set(['add-apt-repository']);

// Programs that unconditionally destroy data.
const DELETE_PROGRAMS_ALWAYS = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'dropdb', 'droprole', 'truncate',
]);

// Package managers + the verb that means "remove/purge".
const DELETE_VERBS = Object.freeze({
  apt: ['remove', 'purge', 'autoremove'],
  'apt-get': ['remove', 'purge', 'autoremove'],
  dpkg: ['-r', '--remove', '-P', '--purge'],
  snap: ['remove'],
  brew: ['uninstall', 'remove'],
  dnf: ['remove', 'erase'],
  yum: ['remove', 'erase'],
  apk: ['del', 'remove'],
  pacman: ['-R', '--remove', '-Rns', '-Rs'],
  pip: ['uninstall'],
  pip3: ['uninstall'],
  npm: ['uninstall', 'remove', 'rm', 'un'],
});

// Language package managers install into interpreters/global roots; defer them
// to the batched passkey path rather than auto-installing.
const LANGUAGE_PACKAGE_MANAGERS = new Set(['pip', 'pip3', 'pipx', 'npm', 'gem']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizePrivilegedCategory(value) {
  const normalized = trimString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return '';
  if (['install', 'software_install', 'package_install', 'apt'].includes(normalized)) return CATEGORY_INSTALL;
  if (['delete', 'destructive_delete', 'remove', 'rm', 'purge', 'uninstall'].includes(normalized)) return CATEGORY_DELETE;
  if (['other', 'privileged_other', 'system'].includes(normalized)) return CATEGORY_OTHER;
  return '';
}

export function getPrivilegedCategoryTitle(category) {
  return CATEGORY_TITLES[trimString(category)] || 'Privileged operation';
}

// Lightweight tokenizer. NOT a shell parser — it splits on whitespace while
// respecting simple quotes, and flags shell metacharacters that indicate a
// composite/untrusted command (pipes, &&, ;, $(...), redirections, newlines).
// Exported so the risk classifier (chat/risk-classifier.mjs) reuses the exact
// same tokenization instead of duplicating this logic.
export function tokenizeCommand(command) {
  const raw = trimString(command);
  if (!raw) return { tokens: [], composite: false };
  const composite = /[;&|`]|\$\(|\b&&\b|\b\|\|\b|\n|\r|>(?!\w*_|\s*\/dev\/null\b)|<(?![a-z0-9_])/i.test(raw);
  const tokens = raw.match(/(?:[^\s"'`]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')+/g) || [];
  return {
    tokens: tokens.map((token) => token.replace(/^["']|["']$/g, '')),
    composite,
  };
}

// Strip a leading `sudo` (and common sudo flags) so we can read the real program.
// Exported so the risk classifier reads args off the same sudo-stripped shape.
export function stripSudo(tokens) {
  let index = 0;
  let sawSudo = false;
  while (index < tokens.length && tokens[index] === 'sudo') {
    sawSudo = true;
    index += 1;
  }
  while (index < tokens.length && /^-[EuAknSb]+$/.test(tokens[index])) {
    index += 1;
  }
  return {
    program: (tokens[index] || '').toLowerCase(),
    rest: tokens.slice(index + 1),
    sawSudo,
  };
}

function isInstallInvocation(program, verb) {
  if (REPO_MUTATION_PROGRAMS.has(program)) return true;
  const verbs = INSTALL_VERBS[program];
  return Array.isArray(verbs) && verbs.includes(verb);
}

function isDeleteInvocation(program, verb, rest) {
  if (DELETE_PROGRAMS_ALWAYS.has(program)) return true;
  if (program === 'find' && rest.some((arg) => arg === '-delete')) return true;
  const verbs = DELETE_VERBS[program];
  return Array.isArray(verbs) && verbs.includes(verb);
}

function deriveCategory({ program, verb, rest, composite }) {
  if (isInstallInvocation(program, verb)) {
    return { category: CATEGORY_INSTALL, confidence: 'high' };
  }
  if (isDeleteInvocation(program, verb, rest)) {
    return { category: CATEGORY_DELETE, confidence: 'high' };
  }
  if (program) {
    return { category: CATEGORY_OTHER, confidence: composite ? 'low' : 'medium' };
  }
  return { category: CATEGORY_OTHER, confidence: 'low' };
}

function reconcileCategory(declaredCategory, derivedCategory) {
  if (!declaredCategory && !derivedCategory) {
    return { category: CATEGORY_OTHER, override: false, reason: 'no category declared or derived' };
  }
  const candidates = [declaredCategory, derivedCategory].filter(Boolean);
  let chosen = candidates[0];
  for (const candidate of candidates) {
    if (RESTRICTIVENESS[candidate] > RESTRICTIVENESS[chosen]) chosen = candidate;
  }
  const override = Boolean(declaredCategory && derivedCategory && declaredCategory !== derivedCategory);
  return { category: chosen, override };
}

function looksLikePathOrUrl(arg) {
  if (!arg) return false;
  return (
    arg.startsWith('/')
    || arg.startsWith('./')
    || arg.startsWith('../')
    || arg.startsWith('http://')
    || arg.startsWith('https://')
    || arg.startsWith('file://')
    || /\.deb$/i.test(arg)
  );
}

function looksLikeNamedPackage(arg) {
  return /^[a-z0-9][a-z0-9._+-]*$/i.test(arg) && !arg.startsWith('-');
}

// §5.3 auto-approve scope: only a narrow, whitelisted class of installs may be
// auto-run. Everything else returns inScope:false and falls through to the
// batched passkey path.
function checkInstallScope({ program, rest, composite }) {
  const reasons = [];
  if (composite) reasons.push('composite command (pipes / && / subshell)');
  if (REPO_MUTATION_PROGRAMS.has(program)) reasons.push('repository / source mutation');

  if (program === 'dpkg') {
    reasons.push('local .deb install');
  }
  if (rest.some((arg) => arg === '--reinstall')) reasons.push('reinstall');
  if (rest.some((arg) => /\/etc\/|sources\.list|systemd\/|\.service$|cron/i.test(arg))) {
    reasons.push('writes system path');
  }
  if (LANGUAGE_PACKAGE_MANAGERS.has(program)) {
    reasons.push('language package manager (use venv / project scope)');
  }

  // Any non-flag argument that is a path/url/deb disqualifies auto-approve.
  const args = rest.filter((arg) => !arg.startsWith('-'));
  if (args.some((arg) => !looksLikeNamedPackage(arg) || looksLikePathOrUrl(arg))) {
    reasons.push('non-package argument');
  }

  return { inScope: reasons.length === 0, reasons };
}

export function classifyPrivilegedOperation(input = {}) {
  const command = trimString(input.command);
  const declaredCategory = normalizePrivilegedCategory(input.declaredCategory);
  const cwd = trimString(input.cwd);

  const { tokens, composite } = tokenizeCommand(command);
  const { program, rest, sawSudo } = stripSudo(tokens);
  const verb = (rest[0] || '').toLowerCase();
  const derived = deriveCategory({ program, verb, rest, composite });
  const reconciled = reconcileCategory(declaredCategory, derived.category);

  const scope = reconciled.category === CATEGORY_INSTALL
    ? checkInstallScope({ program, rest, composite })
    : null;

  return {
    category: reconciled.category,
    declaredCategory,
    derivedCategory: derived.category,
    override: reconciled.override,
    confidence: derived.confidence,
    composite,
    sawSudo,
    program,
    verb,
    inScope: scope ? scope.inScope : null,
    scopeReasons: scope ? scope.reasons : [],
    reason: reconciled.reason || '',
  };
}

// Convenience hash used by both the op manifest and tests; exposed so the
// privileged-ops module and the future passkey challenge use the same canonical
// form.
export function canonicalPrivilegedJson(value) {
  return JSON.stringify(value);
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}
