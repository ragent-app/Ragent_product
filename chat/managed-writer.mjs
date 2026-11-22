// Managed Writer (S11): staging workspace + diff validation + mutation commit.
//
// Managed writer Attempts never write to the canonical workspace directly.
// The worker's cwd points at a private staging workspace that mirrors only the
// task's writablePaths. On completion the backend resolves the staging diff
// (realpath + relative containment against writablePaths, fail-closed on
// symlink / '..' / absolute escapes), then commits through executeMutation()
// (sorted resource keys + WorkspaceLease) so no shell write can bypass the
// mutation lease (constitution §6.2).
//
// Error contract (§4): any staging diff that escapes writablePaths raises
// MANAGED_WRITE_ESCAPE (409). Invalid caller inputs raise EINVAL (400).
//
// Windows semantics annotation (§6.2): junction / reparse-point resolution is
// handled by fs.realpath on the same code path as symlinks on Linux; every
// containment decision uses path.relative() over the resolved real paths
// (never string startsWith). Case-insensitive filesystems can collapse
// differently-cased names onto the same real path (identity follows realpath);
// ACLs are not preserved by staging copies and canonical commits write files
// with the target directory's default ACL. Full Windows verification is a
// platform-environment matter; this module's behavior is covered by equivalent
// Linux tests.
import { randomBytes } from 'crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'path';

import { MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';
import { executeMutation as defaultExecuteMutation } from './mutation-coordinator.mjs';

export const MANAGED_WRITE_ESCAPE = 'MANAGED_WRITE_ESCAPE';
export const STAGING_SCHEMA_VERSION = 1;
const STAGING_PREFIX = 'sw_';
const DEFAULT_MAX_ROOT_REF_FILES = 64;
const DEFAULT_MAX_ROOT_REF_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_ROOT_REF_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_ROOT_REF_VERIFY_BYTES = 16 * 1024 * 1024;
const SKIPPED_ROOT_REF_NAMES = new Set([
  '.git',
  'node_modules',
  '.ragent',
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
]);

function isSkippedRootReferenceName(name) {
  const lower = String(name || '').toLowerCase();
  if (!lower || SKIPPED_ROOT_REF_NAMES.has(lower)) return true;
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (/\.(?:pem|p12|pfx|key|jks|keystore|dpapi|kdbx)$/i.test(lower)) return true;
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i.test(lower)) return true;
  return false;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathsFor(platform = process.platform) {
  return platform === 'win32' ? win32 : posix;
}

function createWriterError(message, code, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

// MANAGED_WRITE_ESCAPE carries the offending path + resolved target so the
// caller can surface the exact escape in the Attempt failure report.
function writeEscape(message, details = {}) {
  const error = createWriterError(`MANAGED_WRITE_ESCAPE: ${message}`, 'MANAGED_WRITE_ESCAPE', 409, details);
  error.escape = true;
  return error;
}

function isContained(realRoot, realCandidate, paths) {
  const rel = paths.relative(realRoot, realCandidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel));
}

// realpath the deepest existing ancestor, then re-append the missing tail.
// Keeps planned (not-yet-existing) paths checkable while failing closed on
// symlinks that escape the root (mirrors collaboration-workspace.mjs).
async function resolveExistingAncestor(candidate, platform = process.platform) {
  const paths = pathsFor(platform);
  let current = candidate;
  const tail = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : paths.join(real, ...tail.reverse());
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        const parent = dirname(current);
        if (parent === current) throw error;
        tail.push(basename(current));
        current = parent;
        continue;
      }
      throw error;
    }
  }
}

// Normalize a single writable path entry against the canonical workspace.
// Returns { relativePath, canonicalAbs, realPath } or null for blank entries.
// Relative inputs must not contain '..', empty/'.' segments or backslashes;
// absolute inputs are allowed only when they resolve inside canonicalCwd.
async function resolveWritablePath(realCanonical, rawValue, platform = process.platform) {
  const paths = pathsFor(platform);
  const raw = trimString(rawValue);
  if (!raw) return null;
  if (raw.includes('\0')) throw writeEscape('writable path must not contain NUL bytes', { path: raw });

  let candidate;
  if (paths.isAbsolute(raw)) {
    candidate = resolve(raw);
  } else {
    if (raw.includes('\\')) throw writeEscape('writable path must not contain backslashes', { path: raw });
    for (const segment of raw.split('/')) {
      if (segment === '' || segment === '.' || segment === '..') {
        throw writeEscape('writable path must not contain empty, "." or ".." segments', { path: raw });
      }
    }
    candidate = resolve(realCanonical, raw);
  }

  const realCandidate = await resolveExistingAncestor(candidate, platform);
  if (!isContained(realCanonical, realCandidate, paths)) {
    throw writeEscape(`writable path escapes the canonical workspace: ${raw}`, {
      path: raw,
      resolved: realCandidate,
      canonicalCwd: realCanonical,
    });
  }
  const rel = paths.relative(realCanonical, realCandidate);
  return {
    relativePath: rel.split(paths.sep).join('/'),
    canonicalAbs: candidate,
    realPath: realCandidate,
  };
}

async function normalizeWritablePaths(realCanonical, writablePaths, platform) {
  const normalized = [];
  const seen = new Set();
  for (const raw of Array.isArray(writablePaths) ? writablePaths : []) {
    const entry = await resolveWritablePath(realCanonical, raw, platform);
    if (!entry || seen.has(entry.relativePath)) continue;
    seen.add(entry.relativePath);
    normalized.push(entry);
  }
  return normalized;
}

// True when a canonical-relative path (already resolved against the canonical
// root) is contained within at least one writable real path.
function isWithinWritable(writableRealPaths, realCandidate, paths) {
  return writableRealPaths.some((writableReal) => isContained(writableReal, realCandidate, paths));
}

export function defaultStagingRoot() {
  return join(MANAGED_WORK_ROOT_DIR || tmpdir(), 'managed-writer-staging');
}

async function copyRootReferenceFiles(realCanonical, stagingDir, writable = [], options = {}, platform = process.platform) {
  if (options.includeRootReferenceFiles === false) return [];
  if (writable.some((entry) => entry.relativePath === '.')) return [];
  const maxFiles = Number.isInteger(options.maxRootReferenceFiles) && options.maxRootReferenceFiles >= 0
    ? options.maxRootReferenceFiles
    : DEFAULT_MAX_ROOT_REF_FILES;
  const maxFileBytes = Number.isInteger(options.maxRootReferenceFileBytes) && options.maxRootReferenceFileBytes >= 0
    ? options.maxRootReferenceFileBytes
    : DEFAULT_MAX_ROOT_REF_FILE_BYTES;
  const maxTotalBytes = Number.isInteger(options.maxRootReferenceTotalBytes) && options.maxRootReferenceTotalBytes >= 0
    ? options.maxRootReferenceTotalBytes
    : DEFAULT_MAX_ROOT_REF_TOTAL_BYTES;
  if (maxFiles === 0 || maxFileBytes === 0 || maxTotalBytes === 0) return [];

  const writableTopLevel = new Set(
    writable.map((entry) => (platform === 'win32' ? entry.relativePath.toLowerCase() : entry.relativePath)),
  );
  const dirents = await readdir(realCanonical, { withFileTypes: true });
  dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  const copied = [];
  let totalBytes = 0;
  for (const dirent of dirents) {
    if (copied.length >= maxFiles) break;
    const name = dirent.name;
    if (isSkippedRootReferenceName(name)) continue;
    const comparable = platform === 'win32' ? name.toLowerCase() : name;
    if (writableTopLevel.has(comparable)) continue;
    if (dirent.isSymbolicLink() || dirent.isDirectory() || !dirent.isFile()) continue;

    const source = join(realCanonical, name);
    const st = await lstat(source).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isFile()) continue;
    if (st.size > maxFileBytes || totalBytes + st.size > maxTotalBytes) continue;

    await copyFile(source, join(stagingDir, name));
    totalBytes += st.size;
    copied.push(name);
  }
  return copied;
}

async function isUnmodifiedRootReferenceEntry(entry, canonicalTarget) {
  const rel = entry?.rel || '';
  if (!rel || rel.includes('/')) return false;
  if (entry.isDir || entry.isSymlink) return false;
  if (isSkippedRootReferenceName(rel)) return false;

  const [stagingStats, canonicalStats] = await Promise.all([
    lstat(entry.abs).catch(() => null),
    lstat(canonicalTarget).catch(() => null),
  ]);
  if (!stagingStats || stagingStats.isSymbolicLink() || !stagingStats.isFile()) return false;
  if (!canonicalStats || canonicalStats.isSymbolicLink() || !canonicalStats.isFile()) return false;
  if (stagingStats.size !== canonicalStats.size || canonicalStats.size > MAX_ROOT_REF_VERIFY_BYTES) return false;

  const [stagingContent, canonicalContent] = await Promise.all([
    readFile(entry.abs),
    readFile(canonicalTarget),
  ]);
  return stagingContent.equals(canonicalContent);
}

async function copyIntoStaging(source, target) {
  const st = await lstat(source).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!st) return;
  if (st.isSymbolicLink()) {
    const linkTarget = await readlink(source);
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await symlink(linkTarget, target);
    return;
  }
  if (st.isDirectory()) {
    await mkdir(target, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await copyIntoStaging(join(source, entry.name), join(target, entry.name));
    }
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

// Collect every entry under `root` (recursively, no symlink traversal).
// Returns [{ rel, abs, isDir, isSymlink }] with rel normalized to '/'.
async function collectTreeEntries(root) {
  const entries = [];
  const stack = [''];
  while (stack.length > 0) {
    const prefix = stack.pop();
    const abs = prefix ? join(root, ...prefix.split('/')) : root;
    const dirents = await readdir(abs, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix ? posix.join(prefix, dirent.name) : dirent.name;
      const isDir = dirent.isDirectory();
      const isSymlink = dirent.isSymbolicLink();
      entries.push({ rel, abs: join(root, ...rel.split('/')), isDir, isSymlink });
      if (isDir && !isSymlink) stack.push(rel);
    }
  }
  return entries;
}

// ── A. staging lifecycle ────────────────────────────────────────────────────

/**
 * createStagingWorkspace(canonicalCwd, writablePaths[, options])
 *   or createStagingWorkspace({ canonicalCwd, writablePaths, stagingRoot })
 *
 * Copies (or creates empty placeholders for) each writablePath subtree of the
 * canonical workspace into a fresh staging directory. The staging dir is
 * private to the worker: it only contains what the task is allowed to write,
 * so any file that appears there necessarily maps to a canonical path that
 * must be re-validated against writablePaths before commit.
 *
 * Returns { stagingDir, mapping } where mapping = { stagingDir, canonicalCwd,
 * writablePaths, writableRealPaths }. `canonicalCwd` and `writableRealPaths`
 * are the resolved real paths used by the containment checks.
 */
export async function createStagingWorkspace(canonicalCwd, writablePaths = [], options = {}) {
  let canonicalRoot;
  let pathsInput;
  if (canonicalCwd && typeof canonicalCwd === 'object' && !Array.isArray(canonicalCwd)) {
    canonicalRoot = canonicalCwd.canonicalCwd;
    pathsInput = canonicalCwd.writablePaths;
    options = canonicalCwd;
  } else {
    canonicalRoot = canonicalCwd;
    pathsInput = writablePaths;
  }
  if (typeof canonicalRoot !== 'string' || !canonicalRoot.trim()) {
    throw createWriterError('canonicalCwd is required to create a staging workspace', 'EINVAL');
  }
  const platform = options.platform || process.platform;
  const paths = pathsFor(platform);
  let realCanonical;
  try {
    realCanonical = await realpath(canonicalRoot);
  } catch (error) {
    throw writeEscape('canonical workspace is not resolvable', {
      canonicalCwd: canonicalRoot,
      causeCode: error?.code || '',
    });
  }
  const writable = await normalizeWritablePaths(realCanonical, pathsInput, platform);
  const stagingRoot = options.stagingRoot || defaultStagingRoot();
  await mkdir(stagingRoot, { recursive: true });
  const stagingDir = await mkdtemp(join(stagingRoot, `${STAGING_PREFIX}_`));

  const mapping = {
    stagingDir,
    canonicalCwd: realCanonical,
    writablePaths: writable.map((entry) => entry.relativePath),
    writableRealPaths: writable.map((entry) => entry.realPath),
  };

  try {
    for (const entry of writable) {
      const target = join(stagingDir, ...entry.relativePath.split('/'));
      await copyIntoStaging(entry.canonicalAbs, target);
    }
    const referenceFiles = await copyRootReferenceFiles(realCanonical, stagingDir, writable, options, platform);
    if (referenceFiles.length > 0) {
      mapping.referenceFiles = referenceFiles;
    }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { stagingDir, mapping };
}

/**
 * resolveStagingDiff(stagingDir, canonicalCwd, writablePaths[, options])
 *   or resolveStagingDiff({ stagingDir, canonicalCwd, writablePaths })
 *
 * Returns the ordered change list [{ path, type: add|modify|delete, kind,
 * linkTarget? }] (sorted by path). Every staging entry is checked against
 * writablePaths with realpath + relative containment; a symlink whose realpath
 * leaves staging, or any entry whose canonical target leaves writablePaths,
 * throws MANAGED_WRITE_ESCAPE (409).
 */
export async function resolveStagingDiff(stagingDir, canonicalCwd, writablePaths = [], options = {}) {
  let stagingRootDir;
  let canonicalRoot;
  let pathsInput;
  if (stagingDir && typeof stagingDir === 'object' && !Array.isArray(stagingDir)) {
    stagingRootDir = stagingDir.stagingDir;
    canonicalRoot = stagingDir.canonicalCwd;
    pathsInput = stagingDir.writablePaths;
    options = stagingDir;
  } else {
    stagingRootDir = stagingDir;
    canonicalRoot = canonicalCwd;
    pathsInput = writablePaths;
  }
  if (typeof stagingRootDir !== 'string' || !stagingRootDir.trim()) {
    throw createWriterError('stagingDir is required to resolve a staging diff', 'EINVAL');
  }
  if (typeof canonicalRoot !== 'string' || !canonicalRoot.trim()) {
    throw createWriterError('canonicalCwd is required to resolve a staging diff', 'EINVAL');
  }
  const platform = options.platform || process.platform;
  const paths = pathsFor(platform);
  let realCanonical;
  let realStaging;
  try {
    [realCanonical, realStaging] = await Promise.all([realpath(canonicalRoot), realpath(stagingRootDir)]);
  } catch (error) {
    throw writeEscape('staging or canonical workspace is not resolvable', {
      stagingDir: stagingRootDir,
      canonicalCwd: canonicalRoot,
      causeCode: error?.code || '',
    });
  }
  const writable = await normalizeWritablePaths(realCanonical, pathsInput, platform);
  const writableRealPaths = writable.map((entry) => entry.realPath);

  // Deterministic walk order: the first escape reported is the lexicographically
  // smallest offending path, so MANAGED_WRITE_ESCAPE is stable across runs.
  const entries = (await collectTreeEntries(realStaging)).sort((left, right) => (
    left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0
  ));
  const changes = new Map();

  for (const entry of entries) {
    const rel = entry.rel;
    // Walk-derived paths cannot contain these, but keep the validation
    // fail-closed: a path that somehow materializes '..' or an absolute path
    // is an escape, never a silent commit.
    if (rel.includes('\0') || paths.isAbsolute(rel)) {
      throw writeEscape(`staging entry path is not canonical-relative: ${rel}`, { path: rel });
    }
    for (const segment of rel.split('/')) {
      if (segment === '..') {
        throw writeEscape(`staging entry path must not contain ".." segments: ${rel}`, { path: rel });
      }
    }

    // Symlink containment, two layers:
    // 1. staging side — the resolved realpath must stay inside staging, which
    //    rejects symlinks (and reparse points on Windows) pointing out of the
    //    staging workspace regardless of their canonical counterpart;
    // 2. canonical side — once committed, the link target must resolve inside
    //    writablePaths. A relative target like '../other' can stay inside
    //    staging yet escape writablePaths when applied to canonical.
    if (entry.isSymlink) {
      let resolved;
      try {
        resolved = await realpath(entry.abs);
      } catch (error) {
        throw writeEscape(`staging symlink is not resolvable: ${rel}`, { path: rel, causeCode: error?.code || '' });
      }
      if (!isContained(realStaging, resolved, paths)) {
        throw writeEscape(`staging symlink resolves outside the staging workspace: ${rel}`, {
          path: rel,
          resolved,
          stagingDir: realStaging,
        });
      }
      const linkTarget = await readlink(entry.abs);
      const canonicalDest = resolve(dirname(resolve(realCanonical, rel)), linkTarget);
      const realDest = await resolveExistingAncestor(canonicalDest, platform);
      if (!isWithinWritable(writableRealPaths, realDest, paths)) {
        throw writeEscape(`staging symlink target escapes writablePaths: ${rel}`, {
          path: rel,
          linkTarget,
          resolved: realDest,
          writablePaths: writableRealPaths,
        });
      }
    }

    // Canonical-target containment: where this change would land must be
    // inside at least one writablePath (deepest-existing-ancestor + tail).
    // Bounded top-level workspace reference files copied as read-only context
    // are allowed to sit in staging ONLY when byte-for-byte unmodified.
    const canonicalTarget = resolve(realCanonical, rel);
    const realTarget = await resolveExistingAncestor(canonicalTarget, platform);
    if (!isWithinWritable(writableRealPaths, realTarget, paths)) {
      if (await isUnmodifiedRootReferenceEntry(entry, canonicalTarget)) {
        continue;
      }
      throw writeEscape(`staging diff escapes writablePaths: ${rel}`, {
        path: rel,
        resolved: realTarget,
        writablePaths: writableRealPaths,
      });
    }

    const canonicalStats = await lstat(canonicalTarget).catch((error) => (
      error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : Promise.reject(error)
    ));

    if (entry.isDir) {
      if (!canonicalStats) {
        changes.set(rel, { path: rel, type: 'add', kind: 'dir' });
      }
      continue;
    }

    const stagingContent = entry.isSymlink
      ? Buffer.from(await readlink(entry.abs), 'utf8')
      : await readFile(entry.abs);
    const kind = entry.isSymlink ? 'symlink' : 'file';
    const linkTarget = entry.isSymlink ? await readlink(entry.abs) : undefined;

    if (!canonicalStats) {
      changes.set(rel, { path: rel, type: 'add', kind, ...(linkTarget !== undefined ? { linkTarget } : {}) });
      continue;
    }
    const canonicalIsSymlink = canonicalStats.isSymbolicLink();
    let canonicalContent;
    if (canonicalIsSymlink) {
      canonicalContent = Buffer.from(await readlink(canonicalTarget), 'utf8');
    } else if (canonicalStats.isDirectory()) {
      canonicalContent = null;
    } else {
      canonicalContent = await readFile(canonicalTarget);
    }
    if (canonicalContent === null || !stagingContent.equals(canonicalContent)) {
      changes.set(rel, { path: rel, type: 'modify', kind, ...(linkTarget !== undefined ? { linkTarget } : {}) });
    }
  }

  // Deletions: canonical files under writablePaths that no longer exist in
  // staging (the worker removed them). Only the writable subtree is scanned so
  // a delete can never escape writablePaths by construction.
  for (const entry of writable) {
    const source = entry.canonicalAbs;
    const stats = await lstat(source).catch((error) => (
      error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : Promise.reject(error)
    ));
    if (!stats) continue;
    if (stats.isDirectory()) {
      const files = [];
      const stack = [entry.relativePath];
      while (stack.length > 0) {
        const rel = stack.pop();
        const abs = join(realCanonical, ...rel.split('/'));
        const dirents = await readdir(abs, { withFileTypes: true });
        for (const dirent of dirents) {
          const childRel = rel ? posix.join(rel, dirent.name) : dirent.name;
          if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
            stack.push(childRel);
          } else if (dirent.isFile() || dirent.isSymbolicLink()) {
            files.push(childRel);
          }
        }
      }
      for (const rel of files) {
        const stagingCounterpart = join(realStaging, ...rel.split('/'));
        const exists = await lstat(stagingCounterpart).then(() => true, () => false);
        if (!exists) changes.set(rel, { path: rel, type: 'delete', kind: 'file' });
      }
    } else if (stats.isFile() || stats.isSymbolicLink()) {
      const stagingCounterpart = join(realStaging, ...entry.relativePath.split('/'));
      const exists = await lstat(stagingCounterpart).then(() => true, () => false);
      if (!exists) changes.set(rel, { path: entry.relativePath, type: 'delete', kind: 'file' });
    }
  }

  return [...changes.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * discardStaging(stagingDir[, options]) — remove a staging workspace. Refuses
 * to remove a path that does not live under the staging root (defense in depth:
 * a mangled caller path must never delete arbitrary directories).
 */
export async function discardStaging(stagingDir, options = {}) {
  const target = typeof stagingDir === 'string' && stagingDir.trim() ? resolve(stagingDir) : '';
  if (!target) return false;
  const root = resolve(options.stagingRoot || defaultStagingRoot());
  if (!isContained(root, target, pathsFor())) return false;
  await rm(target, { recursive: true, force: true });
  return true;
}

// ── B. canonical commit ─────────────────────────────────────────────────────

async function captureCanonicalSnapshot(target) {
  const st = await lstat(target).catch((error) => (
    error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : Promise.reject(error)
  ));
  if (!st) return { existed: false };
  if (st.isSymbolicLink()) return { existed: true, kind: 'symlink', linkTarget: await readlink(target) };
  if (st.isDirectory()) return { existed: true, kind: 'dir' };
  return { existed: true, kind: 'file', content: await readFile(target) };
}

async function restoreCanonicalSnapshot(target, snapshot) {
  await rm(target, { recursive: true, force: true });
  if (!snapshot.existed) return;
  await mkdir(dirname(target), { recursive: true });
  if (snapshot.kind === 'symlink') await symlink(snapshot.linkTarget, target);
  else if (snapshot.kind === 'dir') await mkdir(target, { recursive: true });
  else await writeFile(target, snapshot.content);
}

async function applyChange(change, stagingDir, canonicalRoot) {
  const target = join(canonicalRoot, change.path);
  switch (change.type) {
    case 'add':
    case 'modify': {
      if (change.kind === 'symlink') {
        await mkdir(dirname(target), { recursive: true });
        await rm(target, { recursive: true, force: true });
        await symlink(change.linkTarget, target);
        return;
      }
      if (change.kind === 'dir') {
        await mkdir(target, { recursive: true });
        return;
      }
      const source = join(stagingDir, ...change.path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      return;
    }
    case 'delete':
      await rm(target, { recursive: true, force: true });
      return;
    default:
      throw writeEscape(`unknown staged change type: ${change.type}`, { path: change.path });
  }
}

// Best-effort atomic apply: every canonical target is snapshotted before the
// write; on any failure the applied changes are rolled back in reverse order
// (mutation-scoped leases are always released by executeMutation regardless).
async function applyChanges(changes, stagingDir, canonicalRoot) {
  const journal = [];
  try {
    for (const change of changes) {
      const target = join(canonicalRoot, change.path);
      const snapshot = await captureCanonicalSnapshot(target);
      journal.push({ target, snapshot });
      await applyChange(change, stagingDir, canonicalRoot);
    }
    return { applied: changes.length };
  } catch (error) {
    for (const entry of [...journal].reverse()) {
      await restoreCanonicalSnapshot(entry.target, entry.snapshot).catch(() => {});
    }
    throw error;
  }
}

/**
 * commitStagingToCanonical({ stagingDir, canonicalCwd, writablePaths,
 *   resourceKeys?, workspaceId?, runId?, executeMutation? })
 *
 * Resolves + validates the full staging diff first, then applies it to the
 * canonical workspace inside executeMutation() (sorted resource keys +
 * WorkspaceLease). The staging workspace is always discarded afterwards.
 *
 * resourceKeys defaults to one 'file:<canonicalPath>' key per changed file;
 * pass an explicit list (e.g. 'workspace:<physicalKey>') for whole-workspace
 * locking. executeMutation is injectable for tests.
 *
 * Returns { changes, committed, leases?, result? }.
 */
export async function commitStagingToCanonical({
  stagingDir,
  canonicalCwd,
  writablePaths = [],
  resourceKeys = null,
  workspaceId = '',
  runId = '',
  executeMutation = defaultExecuteMutation,
  platform = process.platform,
} = {}) {
  if (typeof stagingDir !== 'string' || !stagingDir.trim()) {
    throw createWriterError('stagingDir is required to commit a staging diff', 'EINVAL');
  }
  if (typeof canonicalCwd !== 'string' || !canonicalCwd.trim()) {
    throw createWriterError('canonicalCwd is required to commit a staging diff', 'EINVAL');
  }
  // Validate the full diff first; any escape (or resolution failure) discards
  // the staging workspace so a rejected attempt never leaves an orphan dir.
  let changes;
  try {
    changes = await resolveStagingDiff(stagingDir, canonicalCwd, writablePaths, { platform });
  } catch (error) {
    await discardStaging(stagingDir, { platform }).catch(() => {});
    throw error;
  }
  if (changes.length === 0) {
    await discardStaging(stagingDir, { platform });
    return { changes: [], committed: false };
  }
  const keys = Array.isArray(resourceKeys) && resourceKeys.length > 0
    ? resourceKeys
    : changes.map((change) => `file:${join(canonicalCwd, change.path)}`);
  const realCanonical = await realpath(canonicalCwd);
  let committed = false;
  try {
    const outcome = await executeMutation({
      workspaceId: trimString(workspaceId) || undefined,
      runId: trimString(runId) || undefined,
      resourceKeys: keys,
      mutate: async () => {
        const applied = await applyChanges(changes, stagingDir, realCanonical);
        committed = true;
        return applied;
      },
    });
    return { changes, committed: true, ...outcome };
  } finally {
    await discardStaging(stagingDir, { platform });
  }
}
