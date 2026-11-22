// Source-version, bounded workspace, and external resource observations.
// Git, filesystem, and external watermarks are external to SQLite transactions
// and must be captured/verified carefully without assuming cross-store atomicity.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyCurrentResponsibilityProject } from './responsibility-project.mjs';
import { read, transaction, activity, digest, now, error } from './responsibility-store.mjs';

const exec = promisify(execFile);
const HARD_MAX_FILES = 5000;
const HARD_MAX_DEPTH = 32;
const HARD_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_EXCLUDED = new Set(['.git', 'node_modules']);

const unavailable = () => Object.assign(new Error('Committed Git observation is unavailable'), { code: 'RESPONSIBILITY_GIT_OBSERVATION_UNAVAILABLE' });
const workspaceUnavailable = (message, reason = 'workspace_observation_unavailable', code = 'RESPONSIBILITY_WORKSPACE_OBSERVATION_UNAVAILABLE') =>
  Object.assign(new Error(message), { code, reason, statusCode: 409 });
const samePath = (left, right) => process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function normalizeForCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinRoot(rootReal, candidateReal, { strict = false } = {}) {
  const normRoot = normalizeForCompare(rootReal);
  const normCand = normalizeForCompare(candidateReal);
  const rel = path.relative(normRoot, normCand);
  if (rel === '') return !strict;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function normalizeRelativeSubpath(raw) {
  if (typeof raw !== 'string') throw workspaceUnavailable('Workspace path must be a string', 'invalid_workspace_path');
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\0') || path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    throw workspaceUnavailable('Workspace path must be strictly relative', 'invalid_workspace_path');
  }
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized === '.') return '.';
  const segments = normalized.split('/');
  if (segments.some(seg => !seg || seg === '.' || seg === '..')) {
    throw workspaceUnavailable('Workspace path cannot traverse outside project root', 'path_traversal');
  }
  return segments.join('/');
}

function boundPositiveInt(value, fallback, hardMax, reason) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > hardMax) {
    throw workspaceUnavailable(`Workspace observation cap out of range: ${reason}`, 'invalid_workspace_cap');
  }
  return value;
}

function normalizeWorkspaceOptions(raw = {}) {
  const opts = raw === true ? {} : (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null);
  if (!opts) throw workspaceUnavailable('Invalid workspace observation configuration', 'invalid_workspace_config');
  const maxFiles = boundPositiveInt(opts.maxFiles, DEFAULT_MAX_FILES, HARD_MAX_FILES, 'maxFiles');
  const maxDepth = opts.maxDepth === undefined ? DEFAULT_MAX_DEPTH
    : (!Number.isSafeInteger(opts.maxDepth) || opts.maxDepth < 0 || opts.maxDepth > HARD_MAX_DEPTH
      ? (() => { throw workspaceUnavailable('Workspace maxDepth out of range', 'invalid_workspace_cap'); })()
      : opts.maxDepth);
  const maxTotalBytes = boundPositiveInt(opts.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, HARD_MAX_TOTAL_BYTES, 'maxTotalBytes');
  const maxFileBytes = boundPositiveInt(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES, 'maxFileBytes');
  let paths = ['.'];
  if (opts.paths !== undefined) {
    if (!Array.isArray(opts.paths) || !opts.paths.length || opts.paths.length > 64) {
      throw workspaceUnavailable('Workspace paths must be a bounded non-empty array', 'invalid_workspace_path');
    }
    paths = [...new Set(opts.paths.map(normalizeRelativeSubpath))].sort(compareText);
  }
  const exclude = new Set(DEFAULT_EXCLUDED);
  if (opts.exclude !== undefined) {
    const rawExclude = opts.exclude instanceof Set ? [...opts.exclude] : opts.exclude;
    if (!Array.isArray(rawExclude) || rawExclude.length > 128) {
      throw workspaceUnavailable('Workspace exclude list must be a bounded array', 'invalid_workspace_config');
    }
    for (const item of rawExclude) {
      if (typeof item !== 'string' || !item.trim() || item.includes('\0')) {
        throw workspaceUnavailable('Invalid workspace exclude entry', 'invalid_workspace_config');
      }
      exclude.add(item.trim());
    }
  }
  const allowInternalSymlinks = opts.allowInternalSymlinks !== false;
  return { maxFiles, maxDepth, maxTotalBytes, maxFileBytes, paths, exclude, allowInternalSymlinks };
}

export function normalizeChangeObservationPolicy(policy = {}) {
  const co = policy?.changeObservation && typeof policy.changeObservation === 'object' && !Array.isArray(policy.changeObservation)
    ? policy.changeObservation
    : null;
  const committedGitHead = policy?.committedGitChangesOnly === true || co?.committedGitHead === true;
  const rawWorkspace = policy?.workspaceFingerprint !== undefined ? policy.workspaceFingerprint
    : (policy?.workspaceChangesOnly === true ? true : co?.workspace);
  const workspaceEnabled = rawWorkspace === true
    || (Boolean(rawWorkspace) && typeof rawWorkspace === 'object' && !Array.isArray(rawWorkspace) && rawWorkspace.enabled !== false);
  const rawExternal = policy?.externalResourceWatermarks !== undefined ? policy.externalResourceWatermarks
    : co?.externalResources;
  const externalEnabled = rawExternal === true
    || (Boolean(rawExternal) && typeof rawExternal === 'object' && !Array.isArray(rawExternal) && rawExternal.enabled !== false);
  return {
    enabled: committedGitHead || workspaceEnabled || externalEnabled,
    committedGitHead,
    workspaceEnabled,
    workspaceOptions: workspaceEnabled ? normalizeWorkspaceOptions(rawWorkspace) : null,
    externalEnabled,
    externalOptions: externalEnabled
      ? (rawExternal === true ? {} : { ...(rawExternal && typeof rawExternal === 'object' ? rawExternal : {}) })
      : null,
  };
}

async function inspect(fact) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  const options = { cwd: fact.rootRealPath, env, timeout: 10000, maxBuffer: 65536, windowsHide: true };
  const root = await realpath((await exec('git', ['rev-parse', '--show-toplevel'], options)).stdout.trim());
  if (!samePath(root, fact.rootRealPath)) throw unavailable();
  const head = (await exec('git', ['rev-parse', '--verify', 'HEAD^{commit}'], options)).stdout.trim().toLowerCase();
  const branch = (await exec('git', ['symbolic-ref', '--quiet', 'HEAD'], options)).stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) || !branch.startsWith('refs/heads/') || /[\r\n\0]/.test(branch)) throw unavailable();
  return { head, branch };
}

// No watermarks or decisions are changed here. Callers must recheck their
// lease, policy, project fact and trigger authority in their own transaction.
export async function observeResponsibilityCommittedGitHead(projectFactId) {
  if (typeof projectFactId !== 'string' || !projectFactId.trim()) throw unavailable();
  try {
    const before = await verifyCurrentResponsibilityProject(projectFactId);
    const first = await inspect(before);
    const after = await verifyCurrentResponsibilityProject(projectFactId);
    const second = await inspect(after);
    if (before.digest !== after.digest || first.head !== second.head || first.branch !== second.branch) throw unavailable();
    const fact = { schemaVersion: 1, kind: 'committed_git_head', projectFactId: after.id, projectFactDigest: after.digest, ...second };
    return { ...fact, digest: digest(fact) };
  } catch { throw unavailable(); }
}

async function hashFileBounded(targetRealPath, expectedSize, maxFileBytes) {
  if (expectedSize > maxFileBytes) {
    throw workspaceUnavailable('File exceeds maxFileBytes cap', 'max_file_bytes_exceeded');
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  const handle = await open(targetRealPath, flags);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw workspaceUnavailable('Unsupported non-file entry', 'unsupported_file_type');
    if (st.size > maxFileBytes) throw workspaceUnavailable('File exceeds maxFileBytes cap', 'max_file_bytes_exceeded');
    if (st.size !== expectedSize) throw workspaceUnavailable('File changed during workspace observation', 'concurrent_workspace_change');
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(Math.min(65536, Math.max(1, st.size)));
    let offset = 0;
    while (offset < st.size) {
      const toRead = Math.min(buf.length, st.size - offset);
      const { bytesRead } = await handle.read(buf, 0, toRead, offset);
      if (!bytesRead) throw workspaceUnavailable('File truncated while reading workspace fingerprint', 'concurrent_workspace_change');
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return { size: st.size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function resolveConfinedEntry(rootReal, entryPath, options, { allowRootEqual = false } = {}) {
  const lst = await lstat(entryPath).catch(err => {
    if (err?.code === 'ENOENT') return null;
    throw err;
  });
  if (!lst) return null;
  const isSymlink = lst.isSymbolicLink();
  if (isSymlink && !options.allowInternalSymlinks) {
    throw workspaceUnavailable('Symbolic links are disallowed inside observed workspace', 'symlink_escape');
  }
  let targetReal;
  try {
    targetReal = await realpath(entryPath);
  } catch {
    throw workspaceUnavailable('Broken or cyclic symbolic link inside observed workspace', 'symlink_escape');
  }
  if (!isWithinRoot(rootReal, targetReal, { strict: !allowRootEqual })) {
    throw workspaceUnavailable('Symbolic link or path escapes project root confinement', 'symlink_escape');
  }
  const relToRoot = path.relative(normalizeForCompare(rootReal), normalizeForCompare(targetReal));
  const relSegments = relToRoot ? relToRoot.split(path.sep) : [];
  if (relSegments.some(seg => options.exclude.has(seg))) {
    if (isSymlink) throw workspaceUnavailable('Symbolic link targets an excluded internal path', 'symlink_escape');
    return { excluded: true };
  }
  const targetStats = isSymlink ? await stat(targetReal) : lst;
  return { lst, isSymlink, targetReal, targetStats, excluded: false };
}

async function scanWorkspaceOnce(rootReal, options) {
  const entriesByPath = new Map();
  const activeDirs = new Set();
  let fileCount = 0;
  let totalBytes = 0;

  async function walkDir(dirPath, posixPrefix, depth) {
    const dirReal = await realpath(dirPath).catch(() => {
      throw workspaceUnavailable('Directory escaped or disappeared during scan', 'symlink_escape');
    });
    if (!isWithinRoot(rootReal, dirReal, { strict: false })) {
      throw workspaceUnavailable('Directory escapes project root confinement', 'symlink_escape');
    }
    const dirKey = normalizeForCompare(dirReal);
    if (activeDirs.has(dirKey)) {
      throw workspaceUnavailable('Cyclic directory or symlink loop detected inside workspace', 'symlink_escape');
    }
    activeDirs.add(dirKey);
    try {
      const names = (await readdir(dirPath)).sort(compareText);
      for (const name of names) {
        if (options.exclude.has(name)) continue;
        const childDepth = depth + 1;
        if (childDepth > options.maxDepth) {
          throw workspaceUnavailable(`Workspace depth exceeded maxDepth (${options.maxDepth})`, 'max_depth_exceeded');
        }
        const childPath = path.join(dirPath, name);
        const posixRel = posixPrefix ? `${posixPrefix}/${name}` : name;
        const resolved = await resolveConfinedEntry(rootReal, childPath, options, { allowRootEqual: false });
        if (!resolved || resolved.excluded) continue;
        if (resolved.targetStats.isDirectory()) {
          await walkDir(childPath, posixRel, childDepth);
        } else if (resolved.targetStats.isFile()) {
          if (entriesByPath.has(posixRel)) continue;
          fileCount += 1;
          if (fileCount > options.maxFiles) {
            throw workspaceUnavailable(`Workspace file count exceeded maxFiles (${options.maxFiles})`, 'max_files_exceeded');
          }
          totalBytes += resolved.targetStats.size;
          if (totalBytes > options.maxTotalBytes) {
            throw workspaceUnavailable(`Workspace byte total exceeded maxTotalBytes (${options.maxTotalBytes})`, 'max_total_bytes_exceeded');
          }
          const hashed = await hashFileBounded(resolved.targetReal, resolved.targetStats.size, options.maxFileBytes);
          const postReal = await realpath(childPath).catch(() => '');
          if (!postReal || !samePath(postReal, resolved.targetReal) || !isWithinRoot(rootReal, postReal, { strict: true })) {
            throw workspaceUnavailable('Workspace file moved or escaped during scan', 'symlink_escape');
          }
          entriesByPath.set(posixRel, { path: posixRel, kind: 'file', size: hashed.size, sha256: hashed.sha256 });
        } else {
          throw workspaceUnavailable(`Unsupported filesystem entry at ${posixRel}`, 'unsupported_file_type');
        }
      }
    } finally {
      activeDirs.delete(dirKey);
    }
  }

  for (const subpath of options.paths) {
    if (subpath === '.') {
      await walkDir(rootReal, '', 0);
      continue;
    }
    const segments = subpath.split('/');
    let curPath = rootReal;
    let missing = false;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (options.exclude.has(seg)) {
        throw workspaceUnavailable(`Configured subpath includes excluded directory ${seg}`, 'invalid_workspace_path');
      }
      curPath = path.join(curPath, seg);
      const resolved = await resolveConfinedEntry(rootReal, curPath, options, { allowRootEqual: false });
      if (!resolved) {
        missing = true;
        break;
      }
      if (resolved.excluded) {
        missing = true;
        break;
      }
      if (i < segments.length - 1 && !resolved.targetStats.isDirectory()) {
        throw workspaceUnavailable(`Subpath parent is not a directory: ${subpath}`, 'invalid_workspace_path');
      }
      if (i === segments.length - 1) {
        const segDepth = segments.length;
        if (segDepth > options.maxDepth) {
          throw workspaceUnavailable(`Configured subpath exceeds maxDepth (${options.maxDepth})`, 'max_depth_exceeded');
        }
        if (resolved.targetStats.isDirectory()) {
          await walkDir(curPath, subpath, segDepth);
        } else if (resolved.targetStats.isFile()) {
          if (!entriesByPath.has(subpath)) {
            fileCount += 1;
            if (fileCount > options.maxFiles) throw workspaceUnavailable(`Workspace file count exceeded maxFiles (${options.maxFiles})`, 'max_files_exceeded');
            totalBytes += resolved.targetStats.size;
            if (totalBytes > options.maxTotalBytes) throw workspaceUnavailable(`Workspace byte total exceeded maxTotalBytes (${options.maxTotalBytes})`, 'max_total_bytes_exceeded');
            const hashed = await hashFileBounded(resolved.targetReal, resolved.targetStats.size, options.maxFileBytes);
            entriesByPath.set(subpath, { path: subpath, kind: 'file', size: hashed.size, sha256: hashed.sha256 });
          }
        } else {
          throw workspaceUnavailable(`Unsupported filesystem entry at ${subpath}`, 'unsupported_file_type');
        }
      }
    }
    if (missing) {
      entriesByPath.set(subpath, { path: subpath, kind: 'missing', size: 0, sha256: '' });
    }
  }

  const entries = [...entriesByPath.values()].sort((a, b) => compareText(a.path, b.path));
  const manifestDigest = digest({ paths: options.paths, entries });
  return { fileCount, totalBytes, entries, manifestDigest };
}

export async function observeResponsibilityWorkspaceFingerprint(projectFactId, rawOptions = {}) {
  if (typeof projectFactId !== 'string' || !projectFactId.trim()) {
    throw workspaceUnavailable('Project fact ID is required', 'invalid_project_fact');
  }
  const options = normalizeWorkspaceOptions(rawOptions);
  const before = await verifyCurrentResponsibilityProject(projectFactId);
  const rootReal = await realpath(before.rootRealPath).catch(() => {
    throw workspaceUnavailable('Project root path is unavailable', 'workspace_root_unavailable');
  });
  if (!samePath(rootReal, before.rootRealPath)) {
    throw workspaceUnavailable('Project root realpath changed', 'workspace_root_changed');
  }
  const first = await scanWorkspaceOnce(rootReal, options);
  const after = await verifyCurrentResponsibilityProject(projectFactId);
  if (before.digest !== after.digest) {
    throw workspaceUnavailable('Project identity changed during workspace scan', 'project_identity_changed');
  }
  const second = await scanWorkspaceOnce(rootReal, options);
  if (first.manifestDigest !== second.manifestDigest) {
    throw workspaceUnavailable('Workspace contents changed mid-observation', 'concurrent_workspace_change');
  }
  const fact = {
    schemaVersion: 1,
    kind: 'workspace_fingerprint',
    projectFactId: after.id,
    projectFactDigest: after.digest,
    paths: options.paths,
    fileCount: second.fileCount,
    totalBytes: second.totalBytes,
    maxFiles: options.maxFiles,
    maxDepth: options.maxDepth,
    maxTotalBytes: options.maxTotalBytes,
    maxFileBytes: options.maxFileBytes,
    manifestDigest: second.manifestDigest,
  };
  return { ...fact, digest: digest(fact) };
}

export async function recordExternalResourceWatermark({ responsibilityId, source, resourceKey, watermarkValue, observedAt, metadata = {} }) {
  const rid = typeof responsibilityId === 'string' ? responsibilityId.trim() : '';
  const src = typeof source === 'string' ? source.trim() : '';
  const rkey = typeof resourceKey === 'string' ? resourceKey.trim() : '';
  const wval = typeof watermarkValue === 'string' ? watermarkValue : JSON.stringify(watermarkValue ?? '');
  if (!rid || !src || src.length > 128 || !rkey || rkey.length > 512 || !wval || wval.length > 4096) {
    throw error('Valid responsibilityId, source, resourceKey, and watermarkValue are required', 400);
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw error('External watermark metadata must be an object', 400);
  }
  const obsAt = observedAt && Number.isFinite(Date.parse(observedAt)) ? new Date(Date.parse(observedAt)).toISOString() : now();
  const watermarkDigest = digest({ source: src, resourceKey: rkey, watermarkValue: wval, metadata });
  return transaction(db => {
    const r = db.prepare('SELECT id FROM responsibilities WHERE id=?').get(rid);
    if (!r) throw error('Responsibility not found', 404, 'RESPONSIBILITY_NOT_FOUND');
    const ts = now();
    db.prepare(`INSERT INTO responsibility_external_watermarks(responsibility_id,source,resource_key,watermark_value,watermark_digest,observed_at,metadata_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(responsibility_id,source,resource_key)
      DO UPDATE SET watermark_value=excluded.watermark_value,watermark_digest=excluded.watermark_digest,observed_at=excluded.observed_at,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
      .run(rid, src, rkey, wval, watermarkDigest, obsAt, JSON.stringify(metadata), ts);
    activity(db, rid, 'external_watermark_recorded', { source: src, resourceKey: rkey, watermarkDigest, observedAt: obsAt });
    return { schemaVersion: 1, responsibilityId: rid, source: src, resourceKey: rkey, watermarkValue: wval, watermarkDigest, observedAt: obsAt, updatedAt: ts };
  });
}

export async function listExternalResourceWatermarks(responsibilityId) {
  return read(db => db.prepare('SELECT * FROM responsibility_external_watermarks WHERE responsibility_id=? ORDER BY source,resource_key').all(responsibilityId).map(row => ({
    responsibilityId: row.responsibility_id,
    source: row.source,
    resourceKey: row.resource_key,
    watermarkValue: row.watermark_value,
    watermarkDigest: row.watermark_digest,
    observedAt: row.observed_at,
    metadata: JSON.parse(row.metadata_json || '{}'),
    updatedAt: row.updated_at,
  })));
}

export function observeExternalResourceWatermarksInTx(db, responsibilityId, options = {}) {
  const rows = db.prepare('SELECT * FROM responsibility_external_watermarks WHERE responsibility_id=? ORDER BY source,resource_key').all(responsibilityId);
  const sourcesFilter = Array.isArray(options.sources) && options.sources.length ? new Set(options.sources) : null;
  const keysFilter = Array.isArray(options.resourceKeys) && options.resourceKeys.length ? new Set(options.resourceKeys) : null;
  const filtered = rows.filter(row => (!sourcesFilter || sourcesFilter.has(row.source)) && (!keysFilter || keysFilter.has(row.resource_key)));
  const presentKeys = new Set(filtered.map(row => row.resource_key));
  if (Array.isArray(options.requiredResourceKeys)) {
    const missing = options.requiredResourceKeys.filter(key => !presentKeys.has(key));
    if (missing.length) {
      return { available: false, reason: 'missing_external_watermark', missingKeys: missing };
    }
  }
  const entries = filtered.map(row => ({
    source: row.source,
    resourceKey: row.resource_key,
    watermarkDigest: row.watermark_digest,
    observedAt: row.observed_at,
  }));
  const fact = { schemaVersion: 1, kind: 'external_resource_watermarks', responsibilityId, count: entries.length, entries };
  return { available: true, ...fact, digest: digest(fact) };
}

export async function observeResponsibilityChangeSnapshot({ projectFactId, policy, observationKind = 'interval' }) {
  const config = normalizeChangeObservationPolicy(policy);
  if (!config.enabled) return { config, gitObservation: null, workspaceObservation: null };
  let gitObservation = null;
  if (config.committedGitHead && observationKind === 'interval') {
    gitObservation = await observeResponsibilityCommittedGitHead(projectFactId);
  }
  let workspaceObservation = null;
  if (config.workspaceEnabled) {
    workspaceObservation = await observeResponsibilityWorkspaceFingerprint(projectFactId, config.workspaceOptions);
  }
  return { config, gitObservation, workspaceObservation };
}

export function computeCompositeObservationDigest({ projectFactId, catalogDigest, gitObservation, workspaceObservation, externalObservation }) {
  const payload = {
    schemaVersion: 1,
    projectFactId,
    catalogDigest,
    gitDigest: gitObservation?.digest || null,
    workspaceDigest: workspaceObservation?.digest || null,
    externalDigest: externalObservation?.digest || null,
  };
  return {
    ...payload,
    fingerprintDigest: digest(payload),
    components: {
      gitHead: gitObservation ? { head: gitObservation.head, branch: gitObservation.branch, digest: gitObservation.digest } : null,
      workspace: workspaceObservation ? { fileCount: workspaceObservation.fileCount, totalBytes: workspaceObservation.totalBytes, digest: workspaceObservation.digest } : null,
      external: externalObservation ? { count: externalObservation.count, digest: externalObservation.digest } : null,
    },
  };
}
