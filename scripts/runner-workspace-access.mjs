#!/usr/bin/env node

// Temporary, per-Run access for workspaces owned by a different Unix user.
//
// The lifecycle broker is root, while ordinary Runs execute as the dedicated
// agentoc-runner user.  A user-selected workspace can therefore be perfectly
// valid for the control plane but unreachable by the runner (for example
// /home/example/agentoc-dev when /home/example is mode 0750).  This helper gives
// one Run a unique supplementary group, grants that group access only to the
// selected workspace, and removes both the ACL entries and group when the
// transient unit stops.
//
// The unique group is intentional: using the workspace owner's group would
// widen the runner's access to the owner's home, and using the control-plane
// user would defeat runner isolation.  The helper is only callable by the
// root lifecycle broker / root ExecStopPost command in the packaged service.

import { execFile as execFileCallback } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { isDeepStrictEqual, promisify } from 'util';

const execFileAsync = promisify(execFileCallback);

const DEFAULT_ACCESS_ROOT = '/var/lib/agentoc-runner-access';
const LEGACY_ACCESS_ROOT = '/run/agentoc-runner-access';
export const RUNNER_ACCESS_ROOT = process.env.AGENTOC_RUNNER_ACCESS_DIR || DEFAULT_ACCESS_ROOT;
export const RUN_ID_RE = /^run_[A-Za-z0-9_-]{8,128}$/;
const GROUP_NAME_PREFIX = 'aor-';
const GROUP_NAME_RE = /^aor-[a-f0-9]{16}$/;
const ACCESS_ROOT_MODE = 0o700;
const STATE_MODE = 0o600;
const LOCK_RETRY_MS = 50;
// Workspace ACL access is an optional assist.  It must never consume the
// lifecycle broker's entire 120s request budget while waiting behind another
// large workspace scan.  If the assist cannot acquire the lock promptly, the
// ordinary Run still launches with its normal inherited groups.
const parsedLockTimeoutMs = Number.parseInt(process.env.AGENTOC_RUNNER_ACCESS_LOCK_TIMEOUT_MS || '15000', 10);
const LOCK_TIMEOUT_MS = Number.isFinite(parsedLockTimeoutMs) && parsedLockTimeoutMs > 0
  ? Math.min(parsedLockTimeoutMs, 30_000) : 15_000;
const parsedCommandTimeoutMs = Number.parseInt(process.env.AGENTOC_RUNNER_ACCESS_COMMAND_TIMEOUT_MS || '15000', 10);
const ACL_COMMAND_TIMEOUT_MS = Number.isFinite(parsedCommandTimeoutMs) && parsedCommandTimeoutMs > 0
  ? Math.min(parsedCommandTimeoutMs, 30_000) : 15_000;
const SETFACL = process.env.AGENTOC_SETFACL || '/usr/bin/setfacl';
const FIND = process.env.AGENTOC_FIND || '/usr/bin/find';
const GROUPADD = process.env.AGENTOC_GROUPADD || '/usr/sbin/groupadd';
const GROUPDEL = process.env.AGENTOC_GROUPDEL || '/usr/sbin/groupdel';
const LOCK_OWNER_FILE = 'owner.json';
const SENSITIVE_DIRECTORY_NAMES = Object.freeze([
  '.codex',
  '.ssh',
  '.gnupg',
  '.aws',
]);
const SENSITIVE_CONFIG_CHILDREN = Object.freeze([
  '.config/agentoc',
  '.config/claude',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeRunId(value) {
  const runId = trimString(value);
  return RUN_ID_RE.test(runId) ? runId : '';
}

export function runnerAccessGroupForRun(runId) {
  const normalized = normalizeRunId(runId);
  if (!normalized) throw new Error('Invalid Run id');
  return `${GROUP_NAME_PREFIX}${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)}`;
}

function runnerAccessGroupForWorkspace(workspaceRoot) {
  return `${GROUP_NAME_PREFIX}${createHash('sha256').update(`workspace:${resolve(workspaceRoot)}`, 'utf8').digest('hex').slice(0, 16)}`;
}

function statePath(runId, accessRoot = RUNNER_ACCESS_ROOT) {
  const normalized = normalizeRunId(runId);
  if (!normalized) throw new Error('Invalid Run id');
  return `${accessRoot}/${normalized}.json`;
}

function lockPath(accessRoot = RUNNER_ACCESS_ROOT) {
  return `${accessRoot}/.lock`;
}

function lockOwnerPath(lock) {
  return join(lock, LOCK_OWNER_FILE);
}

async function isProcessAlive(pid, killImpl = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by this caller.
    return error?.code === 'EPERM';
  }
}

async function isStaleLock(lock, {
  readFileImpl = readFile,
  statImpl = stat,
  killImpl = process.kill,
} = {}) {
  try {
    const owner = JSON.parse(await readFileImpl(lockOwnerPath(lock), 'utf8'));
    const pid = Number.parseInt(owner?.pid, 10);
    if (await isProcessAlive(pid, killImpl)) return false;
    return true;
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) return false;
    // A crash between mkdir(lock) and writing owner.json is recoverable after
    // the lock's bounded lifetime. Fresh locks are still respected, so a
    // concurrent grant is never unconditionally removed.
    try {
      const info = await statImpl(lock);
      return Number.isFinite(info?.mtimeMs) && Date.now() - info.mtimeMs >= LOCK_TIMEOUT_MS;
    } catch {
      return false;
    }
  }
}

async function withLock(task, {
  accessRoot = RUNNER_ACCESS_ROOT,
  mkdirImpl = mkdir,
  rmImpl = rm,
  writeFileImpl = writeFile,
  readFileImpl = readFile,
  statImpl = stat,
  killImpl = process.kill,
  sleepImpl = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
} = {}) {
  await mkdirImpl(accessRoot, { recursive: true, mode: ACCESS_ROOT_MODE });
  const lock = lockPath(accessRoot);
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdirImpl(lock);
      await writeFileImpl(
        lockOwnerPath(lock),
        `${JSON.stringify({ pid: process.pid, startedAt })}\n`,
        { mode: STATE_MODE, flag: 'wx' },
      );
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        await rmImpl(lock, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      if (await isStaleLock(lock, { readFileImpl, statImpl, killImpl })) {
        await rmImpl(lock, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for runner workspace lock: ${lock}`);
      }
      await sleepImpl(LOCK_RETRY_MS);
    }
  }
  try {
    return await task();
  } finally {
    await rmImpl(lock, { recursive: true, force: true }).catch(() => {});
  }
}

function legacyRootFor(accessRoot) {
  return !process.env.AGENTOC_RUNNER_ACCESS_DIR && accessRoot === DEFAULT_ACCESS_ROOT ? LEGACY_ACCESS_ROOT : '';
}

async function ensureTrustedRootStore(path) {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error('Invalid root-owned workspace access store');
  }
  const parents = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    parents.push(current);
    if (current === dirname(current)) break;
  }
  for (const parent of parents) {
    const item = await lstat(parent);
    if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== 0 || (item.mode & 0o022)) {
      throw new Error('Untrusted workspace access store parent');
    }
  }
  await mkdir(path, { mode: ACCESS_ROOT_MODE, recursive: true });
  const item = await lstat(path);
  if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== 0 || item.gid !== 0 ||
      (item.mode & 0o7777) !== ACCESS_ROOT_MODE || await realpath(path) !== path) {
    throw new Error('Untrusted workspace access store');
  }
}

// Old and new processes use the same legacy lock while live records migrate.
// Publish each durable copy before deleting its old copy; mismatches fail
// closed rather than guessing which record is newer.
async function withStoreLock(task, { accessRoot, legacyRoot = legacyRootFor(accessRoot) }) {
  if (!legacyRoot) return withLock(task, { accessRoot });
  if (legacyRoot === accessRoot) throw new Error('Workspace access stores must differ');
  await ensureTrustedRootStore(legacyRoot);
  await ensureTrustedRootStore(accessRoot);
  return withLock(() => withLock(async () => {
    await listStates(accessRoot);
    for (const state of await listStates(legacyRoot)) {
      const existing = await readState(state.runId, { accessRoot });
      if (existing && !isDeepStrictEqual(existing, state)) throw new Error('Conflicting workspace access migration state');
      if (!existing) await writeState(state, { accessRoot });
      await rm(statePath(state.runId, legacyRoot));
    }
    return task();
  }, { accessRoot }), { accessRoot: legacyRoot });
}

async function currentBootId() {
  if (process.platform !== 'linux') return null;
  const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) throw new Error('Cannot establish Linux boot identity');
  return value;
}

function assertSafeAbsolutePath(value, label) {
  const path = trimString(value);
  if (!path || !isAbsolute(path) || path.includes('\0')) {
    throw new Error(`${label} must be an absolute path without NUL bytes`);
  }
  return resolve(path);
}

function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function protectedRoot(path) {
  // The managed workspace under /var/lib/agentoc is intentionally allowed;
  // the control-plane subtrees must remain opaque to a Run.
  return ['/var/lib/agentoc/config', '/var/lib/agentoc/memory',
    '/var/lib/agentoc/retired', '/var/log/agentoc', '/etc/agentoc', '/opt/agentoc']
    .some((root) => isContained(root, path));
}

function isSensitiveWorkspacePath(path) {
  const segments = resolve(path).split('/').filter(Boolean);
  if (segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.includes(segment))) return true;
  return SENSITIVE_CONFIG_CHILDREN.some((sensitive) => {
    const parts = sensitive.split('/');
    return segments.some((segment, index) => segments.slice(index, index + parts.length).join('/') === sensitive);
  });
}

export async function validateWorkspaceScope({ cwd, workspaceRoot, realpathImpl = realpath, statImpl = stat } = {}) {
  const requestedCwd = assertSafeAbsolutePath(cwd, 'workspace cwd');
  const requestedRoot = assertSafeAbsolutePath(workspaceRoot || cwd, 'workspace root');
  const [realCwd, realRoot] = await Promise.all([
    realpathImpl(requestedCwd),
    realpathImpl(requestedRoot),
  ]);
  const cwdStats = await statImpl(realCwd);
  if (!cwdStats.isDirectory()) throw new Error(`Workspace cwd is not a directory: ${realCwd}`);
  if (!isContained(realRoot, realCwd)) {
    throw new Error(`Workspace cwd escapes its recorded workspace root: ${realCwd}`);
  }
  if (realRoot === '/' || protectedRoot(realRoot) || protectedRoot(realCwd)
    || isSensitiveWorkspacePath(realCwd)) {
    throw new Error(`Refusing temporary runner access for protected workspace: ${realCwd}`);
  }
  return { cwd: realCwd, workspaceRoot: realRoot };
}

function ancestorPaths(path) {
  const result = [];
  let current = dirname(path);
  while (current && current !== '/') {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

function sensitiveFindPredicates() {
  return [
    '(',
    '-name', '.codex',
    '-o', '-name', '.ssh',
    '-o', '-name', '.gnupg',
    '-o', '-name', '.aws',
    '-o', '-path', '*/.config/agentoc',
    '-o', '-path', '*/.config/claude',
    ')',
    '-prune',
    '-o',
  ];
}

function findArgs(root, aclSpec, {
  type = 'f',
  remove = false,
  predicates = [],
  excludeSensitive = true,
} = {}) {
  return [
    root,
    '-xdev',
    ...(excludeSensitive ? sensitiveFindPredicates() : []),
    '-type',
    type,
    ...predicates,
    '-exec',
    SETFACL,
    remove ? '-x' : '-m',
    aclSpec,
    '{}',
    '+',
  ];
}

async function setAcl(paths, aclSpec, execImpl = execFileAsync, {
  remove = false,
  timeoutMs = ACL_COMMAND_TIMEOUT_MS,
} = {}) {
  if (!paths.length) return;
  await execImpl(SETHOOK, [remove ? '-x' : '-m', aclSpec, ...paths], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
}

// Kept as a separate constant so tests can assert the command path without
// relying on a shell.  (The name is deliberately not exported as a runtime
// configuration surface.)
const SETHOOK = SETFACL;

async function runFind(root, aclSpec, options, execImpl = execFileAsync) {
  const timeoutMs = Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : ACL_COMMAND_TIMEOUT_MS;
  await execImpl(FIND, findArgs(root, aclSpec, options), {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
}

async function ensureGroup(group, execImpl = execFileAsync) {
  if (!GROUP_NAME_RE.test(group)) throw new Error(`Invalid temporary runner group: ${group}`);
  await execImpl(GROUPADD, ['--system', '--force', group], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
}

async function removeGroup(group, execImpl = execFileAsync) {
  if (!GROUP_NAME_RE.test(group)) return;
  await execImpl(GROUPDEL, [group], { timeout: 10_000, maxBuffer: 64 * 1024 }).catch((error) => {
    // Check NSS explicitly: ENOENT can mean groupdel itself is missing, and
    // localized stderr is not reliable evidence that a group is absent.
    return execImpl('/usr/bin/getent', ['group', group], { timeout: 2_000, maxBuffer: 64 * 1024 })
      .then(() => { throw error; }, (lookupError) => {
        if (lookupError?.code !== 2 || lookupError?.signal || lookupError?.killed) throw error;
      });
  });
}

async function writeState(state, { accessRoot = RUNNER_ACCESS_ROOT } = {}) {
  await mkdir(accessRoot, { recursive: true, mode: ACCESS_ROOT_MODE });
  const target = statePath(state.runId, accessRoot);
  const temporary = `${target}.${randomBytes(16).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', STATE_MODE);
    await file.writeFile(`${JSON.stringify(state)}\n`);
    await file.sync();
    await file.close(); file = null;
    await rename(temporary, target);
    if (process.platform === 'linux') {
      const dir = await open(accessRoot, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } finally {
    await file?.close();
    await rm(temporary, { force: true });
  }
}

async function readState(runId, { accessRoot = RUNNER_ACCESS_ROOT, readFileImpl = readFile } = {}) {
  try {
    return JSON.parse(await readFileImpl(statePath(runId, accessRoot), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function listStates(accessRoot = RUNNER_ACCESS_ROOT) {
  let entries;
  try {
    entries = await readdir(accessRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const states = [];
  for (const entry of entries) {
    if (!entry.name.startsWith('run_') || !entry.name.endsWith('.json')) continue;
    if (!entry.isFile()) throw new Error('Invalid runner workspace access state file');
    const state = JSON.parse(await readFile(`${accessRoot}/${entry.name}`, 'utf8'));
    if (state?.runId !== entry.name.slice(0, -'.json'.length) || !normalizeRunId(state.runId) ||
        !GROUP_NAME_RE.test(state.group || '') || (state.released !== undefined && typeof state.released !== 'boolean') ||
          (state.cleanupComplete !== undefined && typeof state.cleanupComplete !== 'boolean') ||
          (state.bootId !== undefined && state.bootId !== null && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(state.bootId))) {
      throw new Error('Invalid runner workspace access state');
    }
    buildGrantPlan(state); // Reject malformed paths rather than deleting a shared group.
    states.push(state);
  }
  return states;
}

export function buildGrantPlan({ runId, cwd, workspaceRoot, group } = {}) {
  const normalized = normalizeRunId(runId);
  if (!normalized) throw new Error('Invalid Run id');
  if (!GROUP_NAME_RE.test(group || '')) throw new Error('Invalid temporary runner group');
  const normalizedCwd = assertSafeAbsolutePath(cwd, 'workspace cwd');
  const normalizedRoot = assertSafeAbsolutePath(workspaceRoot || cwd, 'workspace root');
  if (!isContained(normalizedRoot, normalizedCwd)) {
    throw new Error('Workspace cwd escapes its recorded workspace root');
  }
  return {
    runId: normalized,
    group,
    cwd: normalizedCwd,
    workspaceRoot: normalizedRoot,
    // Grant only the immutable execution cwd.  workspaceRoot is used solely
    // for containment validation; a subpath-scoped Run must not receive ACLs
    // over its sibling directories.
    grantRoot: normalizedCwd,
    ancestors: ancestorPaths(normalizedCwd),
  };
}

export async function grantRunnerWorkspaceAccess({
  runId,
  cwd,
  workspaceRoot,
  accessRoot = RUNNER_ACCESS_ROOT,
  legacyRoot = legacyRootFor(accessRoot),
  execImpl = execFileAsync,
  validateImpl = validateWorkspaceScope,
  bootIdImpl = currentBootId,
} = {}) {
  const normalized = normalizeRunId(runId);
  if (!normalized) throw new Error('Invalid Run id');
  return withStoreLock(async () => {
    const validated = await validateImpl({ cwd, workspaceRoot });
    const states = await listStates(accessRoot);
    if (states.some((state) => state.runId === normalized && state.released === true)) {
      throw new Error('Runner workspace cleanup is pending');
    }
    const existing = states.find((state) => state.released !== true &&
      resolve(state.workspaceRoot || '') === validated.workspaceRoot
      && resolve(state.cwd || '') === validated.cwd
      && GROUP_NAME_RE.test(state.group || ''));
    const group = existing?.group || runnerAccessGroupForRun(normalized);
    const plan = { ...buildGrantPlan({ runId: normalized, ...validated, group }), bootId: await bootIdImpl() };
    await ensureGroup(group, execImpl);
    await writeState(plan, { accessRoot });
    if (existing) return plan;
    try {
      // The ancestor ACL only grants traversal.  Existing directories get
      // read/write/traverse access and a default ACL for descendants. Existing
      // executable files are deliberately split from ordinary files: the
      // runner must retain the full read/write/execute access granted by the
      // runner identity while ordinary files need no execute bit.
      await setAcl(plan.ancestors, `g:${group}:--x`, execImpl);
      await runFind(plan.grantRoot, `g:${group}:rwx,d:g:${group}:rwx`, { type: 'd' }, execImpl);
      await runFind(plan.grantRoot, `g:${group}:rwx`, {
        type: 'f',
        predicates: ['-perm', '/111'],
      }, execImpl);
      await runFind(plan.grantRoot, `g:${group}:rw-`, {
        type: 'f',
        predicates: ['!', '-perm', '/111'],
      }, execImpl);
      return plan;
    } catch (error) {
      // Persist a retryable cleanup before trying to undo a partial grant.
      await writeState({ ...plan, released: true }, { accessRoot });
      await cleanupReleasedGroup([{ ...plan, released: true }], { accessRoot, execImpl }).catch(() => {});
      throw new Error(`Failed to grant runner workspace access: ${error?.message || String(error)}`);
    }
  }, { accessRoot, legacyRoot });
}

async function removeAclFromWorkspace(state, execImpl, { timeoutMs = ACL_COMMAND_TIMEOUT_MS } = {}) {
  const root = state.grantRoot || state.cwd || state.workspaceRoot;
  // Revoke without the sensitive-directory prune. Older versions could have
  // granted the group through .codex/.ssh/etc.; cleanup must remove those
  // legacy ACLs too, even though new grants never enter them.
  await runFind(root, `g:${state.group}`, { type: 'd', remove: true, timeoutMs, excludeSensitive: false }, execImpl);
  await runFind(root, `d:g:${state.group}`, { type: 'd', remove: true, timeoutMs, excludeSensitive: false }, execImpl);
  await runFind(root, `g:${state.group}`, { type: 'f', remove: true, timeoutMs, excludeSensitive: false }, execImpl);
  await setAcl(state.ancestors || ancestorPaths(state.workspaceRoot), `g:${state.group}`, execImpl, { remove: true, timeoutMs });
}

async function cleanupReleasedGroup(states, {
  accessRoot = RUNNER_ACCESS_ROOT,
  execImpl = execFileAsync,
  timeoutMs = ACL_COMMAND_TIMEOUT_MS,
} = {}) {
  if (!states.length || states.some(state => state.released !== true || state.group !== states[0].group)) {
    throw new Error('Runner workspace group is still in use');
  }
  for (const state of states) {
    if (!state.cleanupComplete) await removeAclFromWorkspace(state, execImpl, { timeoutMs });
  }
  // Record completion for every reference before deleting the group. If the
  // process dies after groupdel, retry must not need the now-missing name to
  // remove ACLs that have already been removed.
  for (const state of states) await writeState({ ...state, cleanupComplete: true }, { accessRoot });
  await removeGroup(states[0].group, execImpl);
  for (const state of states) await rm(statePath(state.runId, accessRoot), { force: true });
}

export async function revokeRunnerWorkspaceAccess({
  runId,
  accessRoot = RUNNER_ACCESS_ROOT,
  legacyRoot = legacyRootFor(accessRoot),
  execImpl = execFileAsync,
  releasedOnly = false,
} = {}) {
  const normalized = normalizeRunId(runId);
  if (!normalized) throw new Error('Invalid Run id');
  return withStoreLock(async () => {
    const state = await readState(normalized, { accessRoot });
    if (!state) return { runId: normalized, revoked: false };
    if (releasedOnly && state.released !== true) return { runId: normalized, revoked: false };
    if (!state.released) await writeState({ ...state, released: true }, { accessRoot });
    const references = (await listStates(accessRoot)).filter((candidate) => candidate.group === state.group);
    if (!references.some((candidate) => !candidate.released)) await cleanupReleasedGroup(references, { accessRoot, execImpl });
    return { runId: normalized, revoked: true, group: state.group };
  }, { accessRoot, legacyRoot });
}

export function createRunnerWorkspaceCleanupSweep({ accessRoot = RUNNER_ACCESS_ROOT, legacyRoot = legacyRootFor(accessRoot),
  execImpl = execFileAsync, bootIdImpl = currentBootId } = {}) {
  let cursor = 0;
  return async ({ limit = 8 } = {}) => {
    const pending = await withStoreLock(async () => {
      const bootId = await bootIdImpl();
      const states = await listStates(accessRoot);
      for (const state of states) {
        // A task cannot survive a reboot. Old records without a boot identity
        // remain untouched because their launch provenance is unknown.
        if (bootId && state.bootId && state.bootId !== bootId && !state.released) {
          state.released = true;
          await writeState(state, { accessRoot });
        }
      }
      return states.filter(state => state.released === true);
    }, { accessRoot, legacyRoot });
    const count = Math.min(pending.length, Math.max(1, Math.min(100, Math.floor(limit) || 8)));
    const batch = Array.from({ length: count }, (_, i) => pending[(cursor + i) % pending.length]);
    if (pending.length) cursor = (cursor + count) % pending.length;
    let failed = 0;
    for (const state of batch) {
      try { await revokeRunnerWorkspaceAccess({ runId: state.runId, accessRoot, legacyRoot, execImpl, releasedOnly: true }); }
      catch { failed++; }
    }
    return { attempted: count, failed };
  };
}

export async function listRunnerWorkspaceAccess({ accessRoot = RUNNER_ACCESS_ROOT, legacyRoot = legacyRootFor(accessRoot) } = {}) {
  return withStoreLock(async () => (await listStates(accessRoot)).map(state => state.runId), { accessRoot, legacyRoot });
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  const runIdIndex = args.indexOf('--run-id');
  const runId = runIdIndex >= 0 ? args[runIdIndex + 1] : '';
  if (operation !== 'revoke' || !normalizeRunId(runId)) {
    throw new Error('Usage: runner-workspace-access.mjs revoke --run-id run_<id>');
  }
  await revokeRunnerWorkspaceAccess({ runId });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    console.error(`[runner-workspace-access] ${error?.stack || error?.message || String(error)}`);
    process.exit(1);
  });
}
