import { generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from 'crypto';

import { computeOpManifestHash } from './privileged-ops.mjs';
import {
  CATEGORY_INSTALL,
  classifyPrivilegedOperation,
  stripSudo,
  tokenizeCommand,
} from './privileged-classifier.mjs';
import { parseCommandFacts } from './command-parser.mjs';

// P3a — one-shot privileged-executor token: signing + pure verification logic
// (design: notes/current/privileged-approval-design.md §5.7; proposal:
// /var/lib/ragent/workspace/p3-executor-proposal-draft.md §3).
//
// This module is PURE LOGIC, no I/O. It knows how to canonicalize, sign, and
// verify a single one-shot op token; it does NOT manage the signing key file
// (that load-or-create is chat-server-side, proposal §3.2/P3d), resolve kid→key
// (P3c/P3d), check SO_PEERCRED (§3.3 step 1, P3c), or track the consumed-Set
// (§3.3 step 4, P3c). Those executor-side concerns are layered on top.
//
// Owner decisions locked 2026-07-31 (proposal §9): D2 = Ed25519 asymmetric
// (executor holds only the public key, so compromising root does not leak the
// minting ability); D6 = token TTL ≤ 60s; D4 = cgroup binding "medium"
// (internal consistency here, plus `systemctl is-active` liveness in P3c);
// D5 = install-auto goes through the executor's hard structural whitelist
// (verifyPrivilegedInstallScope, §3.3 step 7).

export const PRIVILEGED_TOKEN_VERSION = 1;
export const PRIVILEGED_SIGNING_KEY_PREFIX = 'pkx_';
export const PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY = 'passkey';
export const PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK = 'owner-click';
export const PRIVILEGED_TOKEN_AUTH_MODE_INSTALL_AUTO = 'install-auto';

// proposal §3.5 / D6. The executor mints and fires immediately, so 60s is ample;
// the short window also bounds post-restart replay of an unconsumed token (§2.3).
export const PRIVILEGED_TOKEN_TTL_MAX_MS = 60_000;

// Verify outcome codes mirror proposal §2.2 executor error codes. OK is the
// absence of an error; the rest name the first failing check.
export const PRIVILEGED_TOKEN_OK = 'PRIVILEGED_TOKEN_OK';
export const PRIVILEGED_TOKEN_INVALID = 'PRIVILEGED_TOKEN_INVALID';
export const PRIVILEGED_TOKEN_EXPIRED = 'PRIVILEGED_TOKEN_EXPIRED';
export const PRIVILEGED_COMMAND_MISMATCH = 'PRIVILEGED_COMMAND_MISMATCH';
export const PRIVILEGED_CGROUP_MISMATCH = 'PRIVILEGED_CGROUP_MISMATCH';
export const PRIVILEGED_CGROUP_INACTIVE = 'PRIVILEGED_CGROUP_INACTIVE';
export const PRIVILEGED_INSTALL_SCOPE_DENIED = 'PRIVILEGED_INSTALL_SCOPE_DENIED';
export const PRIVILEGED_PASSKEY_SCOPE_DENIED = 'PRIVILEGED_PASSKEY_SCOPE_DENIED';
export const PRIVILEGED_OWNER_CLICK_SCOPE_DENIED = 'PRIVILEGED_OWNER_CLICK_SCOPE_DENIED';
export const PRIVILEGED_AUTH_MODE_INVALID = 'PRIVILEGED_AUTH_MODE_INVALID';

// The only authMode values the privileged channel understands. The mint path
// and the executor must never improvise behavior for anything else: unknown
// or empty authMode values fail closed with PRIVILEGED_AUTH_MODE_INVALID
// (§3.3 pure chain), before any scope or execution logic runs.
export const PRIVILEGED_TOKEN_AUTH_MODES = Object.freeze(new Set([
  PRIVILEGED_TOKEN_AUTH_MODE_PASSKEY,
  PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK,
  PRIVILEGED_TOKEN_AUTH_MODE_INSTALL_AUTO,
]));

export function isKnownPrivilegedAuthMode(value) {
  return PRIVILEGED_TOKEN_AUTH_MODES.has(trimString(value));
}

// Fields covered by the signature, in canonical order. `sig` is intentionally
// excluded — it is computed over the canonical form of everything below.
const SIGNABLE_TOKEN_FIELDS = Object.freeze([
  'v', 'kid', 'opId', 'category', 'command', 'cwd', 'manifestHash',
  'sessionId', 'runId', 'turnId', 'cgroup', 'authMode', 'issuedAt', 'expiresAt',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Re-derive the runner cgroup/unit name from a runId. MUST stay in sync with
// buildDetachedRunnerUnitName (chat/run-launcher.mjs:38-40); it is inlined here
// (rather than imported) so this module's import graph stays pure
// (privileged-ops → privileged-classifier → crypto only) and unit-testable with
// no runner/config dependencies. The executor performs the same re-derivation
// (§3.3 step 6) to confirm the token's cgroup is internally consistent.
export function buildPrivilegedCgroupFromRunId(runId) {
  const sanitized = String(runId || '').trim().replace(/[^A-Za-z0-9:_.@-]+/g, '_');
  return `ragent-runner-${sanitized || 'unknown'}`;
}

// Canonical JSON over the signable subset (everything except `sig`), in a fixed
// field order so signing and verification produce identical bytes regardless of
// how the caller assembled the object.
export function canonicalPrivilegedToken(token) {
  const source = token || {};
  const obj = {};
  for (const field of SIGNABLE_TOKEN_FIELDS) {
    if (source[field] !== undefined) obj[field] = source[field];
  }
  return JSON.stringify(obj);
}

export function generatePrivilegedSigningKeyPair() {
  // Ed25519 (D2). generateKeyPairSync returns { publicKey, privateKey } KeyObjects.
  return generateKeyPairSync('ed25519');
}

export function createPrivilegedKeyId(bytes = 8) {
  return `${PRIVILEGED_SIGNING_KEY_PREFIX}${randomBytes(bytes).toString('hex')}`;
}

// Mint a token: stamp version/kid if absent, then sign the canonical form and
// attach `sig` (Ed25519, base64url). The caller supplies the signing key object
// (P3d does the load-or-create from privileged-signing-keys.json, §3.2).
export function signPrivilegedToken(tokenWithoutSig, privateKey, options = {}) {
  const token = { ...(tokenWithoutSig || {}) };
  if (token.v === undefined) token.v = PRIVILEGED_TOKEN_VERSION;
  const kid = trimString(options.kid) || trimString(token.kid);
  if (kid) token.kid = kid;
  const data = Buffer.from(canonicalPrivilegedToken(token), 'utf8');
  token.sig = edSign(null, data, privateKey).toString('base64url');
  return token;
}

// §3.3 step 2 — Ed25519 signature over canonical(signable fields). crypto.verify
// returns a boolean and compares in constant time internally, so no separate
// timingSafeEqual is needed. Any throw (bad key, bad sig encoding) ⇒ invalid.
export function verifyPrivilegedTokenSignature(token, publicKey) {
  if (!publicKey || typeof token !== 'object' || token === null) return false;
  const sigB64url = trimString(token.sig);
  if (!sigB64url) return false;
  const data = Buffer.from(canonicalPrivilegedToken(token), 'utf8');
  try {
    return edVerify(null, data, publicKey, Buffer.from(sigB64url, 'base64url'));
  } catch {
    return false;
  }
}

// §3.3 step 3 — not expired. `now` is injectable for deterministic tests.
export function isPrivilegedTokenExpired(token, now = Date.now()) {
  const expiresAt = Date.parse(trimString(token?.expiresAt));
  if (!Number.isFinite(expiresAt)) return true;
  return now >= expiresAt;
}

// §3.3 step 5 — command/manifestHash consistency. Recompute the op manifest hash
// from the token's command/category/cwd (the same pure algorithm chat-server
// used: computeOpManifestHash, chat/privileged-ops.mjs:49-56) and require it to
// match the signed manifestHash exactly, with a non-empty command.
export function verifyPrivilegedTokenManifest(token) {
  const command = trimString(token?.command);
  if (!command) return false;
  const recomputed = computeOpManifestHash({
    command,
    category: trimString(token?.category),
    cwd: trimString(token?.cwd),
  });
  return recomputed === trimString(token?.manifestHash);
}

// §3.3 step 6 — cgroup internal consistency. The cgroup bound into the token
// must equal the unit name re-derived from the token's own runId. (Liveness via
// `systemctl is-active` is executor I/O and lives in P3c.) A null/absent cgroup
// fails closed — non-systemd launch modes are rejected by default (D4).
export function verifyPrivilegedTokenCgroup(token) {
  const declared = trimString(token?.cgroup);
  if (!declared) return false;
  return declared === buildPrivilegedCgroupFromRunId(token?.runId);
}

// §3.3 step 7 — install-auto hard structural whitelist. Independent of the
// token signature: the executor re-runs the install-scope classifier on the
// token's command and only consents to root execution when it is a named-package
// install verb. Defense-in-depth for install-auto, which carries no passkey.
export function verifyPrivilegedInstallScope(token) {
  const command = trimString(token?.command);
  if (!command) return false;
  // `parseCommandFacts` intentionally unwraps transparent wrappers for risk
  // classification. That is useful for deciding that a command is dangerous,
  // but it is not sufficient for an install-auto root execution decision:
  // `env APT_CONFIG=/tmp/evil.conf sudo apt-get install nginx` would otherwise
  // look like the harmless inner apt invocation while `/bin/sh -c` still runs
  // the environment-changing outer command. Require the same strict single-
  // invocation shape used by human-authorized execution before classifying.
  const program = strictPrivilegedCommandProgram(command);
  if (!program || !INSTALL_AUTO_EXECUTABLES.has(program)) return false;
  const { tokens } = tokenizeCommand(command);
  const { rest } = stripSudo(tokens);
  const safeFlags = INSTALL_AUTO_SAFE_FLAGS[program] || new Set();
  if (rest.slice(1).some((argument) => argument.startsWith('-') && !safeFlags.has(argument))) {
    return false;
  }
  // Keep executor-side defense in depth aligned with the gate classifier for
  // transparent wrappers such as `env sudo apt-get install nginx`.
  const parsed = parseCommandFacts(command);
  const classified = classifyPrivilegedOperation({
    command: parsed?.unwrappedCommand || command,
  });
  if (classified.category !== CATEGORY_INSTALL) return false;
  return classified.inScope === true;
}

// Passkey-mode executable allowlist (design §5.6 hardening, plan phase 4). A
// A human authorization (passkey proof OR explicit owner click) proves the op
// was approved by a person, not that the op is safe to run as root.
// Defense-in-depth: the executor only consents to root execution for
// concrete, bounded programs. Anything that can launch arbitrary code (a shell,
// an interpreter, su/sudo escalation) is DENIED in every human-authorized
// mode — `sudo bash`, `sudo sh -c ...`, `sudo su` etc. must never reach the
// root executor, passkey or not. Narrow first-day set, expanded as the
// classifier matures.
export const PASSKEY_EXECUTABLE_ALLOWLIST = Object.freeze(new Set([
  // file mutations (delete/other categories)
  'rm', 'mv', 'cp', 'chmod', 'chown', 'chgrp', 'mkdir', 'rmdir', 'touch', 'ln',
  // service / process management
  'systemctl', 'service', 'journalctl', 'kill', 'pkill', 'killall',
  // package managers are allowed only in the explicit passkey path. The
  // approval batch, token manifest, and executor scope still bind the exact
  // command; sudo itself is stripped only for program classification.
  'apt', 'apt-get', 'dnf', 'yum', 'apk', 'pacman', 'snap', 'dpkg',
  // container / firewall / user administration
  'docker', 'podman', 'ufw', 'iptables', 'nft', 'useradd', 'usermod', 'userdel',
  'groupadd', 'groupdel', 'passwd', 'crontab',
  // filesystem utilities
  'mount', 'umount', 'df', 'du', 'unzip', 'gzip', 'gunzip', 'dd', 'sync',
]));

// Keep this set aligned with the package-manager programs understood by the
// privileged classifier. It is intentionally separate from the human-action
// allowlist: install-auto must accept only a direct package-manager command,
// never a transparent wrapper that the risk parser could unwrap.
const INSTALL_AUTO_EXECUTABLES = new Set([
  'apt', 'apt-get', 'dnf', 'yum', 'snap', 'brew', 'apk', 'pacman', 'dpkg',
  'pip', 'pip3', 'pipx', 'npm', 'gem',
]);

// Install-auto is a root execution path, so "flags are not package names" is
// not a sufficient boundary. Package managers expose options that can change
// repositories, trust, configuration, or invoke hooks. Only these explicitly
// enumerated flags are accepted; all other option-looking arguments (including
// `--option=...`, `--config-file=...`, `--setopt=...`, and repository/trust
// switches) fall back to the interactive approved-action path.
const INSTALL_AUTO_SAFE_FLAGS = Object.freeze({
  apt: new Set(['-y', '--yes', '--assume-yes', '-s', '--simulate', '--dry-run', '--no-install-recommends']),
  'apt-get': new Set(['-y', '--yes', '--assume-yes', '-s', '--simulate', '--dry-run', '--no-install-recommends']),
  dnf: new Set(['-y', '--assumeyes']),
  yum: new Set(['-y', '--assumeyes']),
  apk: new Set(['--no-cache', '--no-progress']),
  pacman: new Set(['--noconfirm', '--needed']),
  snap: new Set(),
  brew: new Set(),
  dpkg: new Set(),
  pip: new Set(),
  pip3: new Set(),
  pipx: new Set(),
  npm: new Set(),
  gem: new Set(),
});

// Anything not in the allowlist fails closed — most importantly the arbitrary
// code launchers: shells (bash/sh/zsh/dash/ash/ksh), interpreters
// (python/node/perl/ruby/php), and escalation (su/sudo).
export function verifyPrivilegedExecutableScope(token) {
  const command = trimString(token?.command);
  if (!command) return false;
  const program = strictPrivilegedCommandProgram(command);
  if (!program) return false;
  return PASSKEY_EXECUTABLE_ALLOWLIST.has(program);
}

// Return the actual program only for a deliberately narrow command shape that
// can be safely represented by the current `/bin/sh -c` executor. This is a
// lexical boundary, not a shell parser: any shell feature that could change
// the target or add another effect is rejected rather than guessed at.
//
// In particular, do not relax the character set for `/dev/null` redirections
// or quoted expansions. Even a quoted `$HOME` is still shell syntax, and the
// approved operation must bind a concrete, reviewable command string.
function strictPrivilegedCommandProgram(command) {
  const raw = trimString(command);
  if (!raw) return '';
  const { tokens, composite } = tokenizeCommand(raw);
  if (composite || tokens.length === 0) return '';
  if (/[[\]{}()<>;&|`$*?~#!\\]/.test(raw)) return '';
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '';

  // Reject unmatched quotes. Quoting itself is allowed for spaces in a path,
  // but malformed/escaped shell words must not be sent to `/bin/sh -c`.
  let quote = '';
  for (const character of raw) {
    if (character === '\\') return '';
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === "'" || character === '"') {
      quote = character;
    }
  }
  if (quote) return '';

  // Shell environment assignments are executable effects, not arguments. A
  // leading `sudo` may retain its existing bounded flags, but no assignment
  // may appear before or after it. This closes env/config injection for both
  // install-auto and human-authorized modes.
  if (tokens.some((token) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token))) return '';
  const { program } = stripSudo(tokens);
  if (!program) return '';

  // `sudo` is retained only as the legacy spelling of the root boundary. No
  // sudo flags are meaningful here: `-E` can preserve service environment,
  // `-u` changes the effective account, and askpass/background flags introduce
  // a second execution path. Requiring the next token to be the program also
  // prevents env/command/nohup/nice/timeout/exec from being silently unwrapped.
  if (tokens[0] === 'sudo') {
    if (tokens[1]?.toLowerCase() !== program) return '';
  } else if (tokens[0]?.toLowerCase() !== program) {
    return '';
  }
  return program;
}

// Backward-compatible name. The allowlist gate is mode-independent now: it
// guards passkey and owner-click tokens identically.
export function verifyPrivilegedPasskeyScope(token) {
  return verifyPrivilegedExecutableScope(token);
}

// Run the pure, always-applicable checks (§3.3 steps 2, 3, 5, 6) in order and
// return the first failure code, or OK. Step 1 (SO_PEERCRED), step 4
// (consumed-Set), and the optional `systemctl is-active` liveness are
// executor-side (P3c); step 7 (install-scope) is authMode-gated and exposed
// separately as verifyPrivilegedInstallScope so callers compose it explicitly.
export function verifyPrivilegedToken(token, options = {}) {
  if (!verifyPrivilegedTokenSignature(token, options.publicKey)) {
    return { ok: false, code: PRIVILEGED_TOKEN_INVALID };
  }
  if (!isKnownPrivilegedAuthMode(token?.authMode)) {
    return { ok: false, code: PRIVILEGED_AUTH_MODE_INVALID };
  }
  if (isPrivilegedTokenExpired(token, options.now)) {
    return { ok: false, code: PRIVILEGED_TOKEN_EXPIRED };
  }
  if (!verifyPrivilegedTokenManifest(token)) {
    return { ok: false, code: PRIVILEGED_COMMAND_MISMATCH };
  }
  if (!verifyPrivilegedTokenCgroup(token)) {
    return { ok: false, code: PRIVILEGED_CGROUP_MISMATCH };
  }
  return { ok: true, code: PRIVILEGED_TOKEN_OK };
}
