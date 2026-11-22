// Explicitly authorized cross-device file and bounded directory bundle transfer.
// Supports backwards-compatible <=4 MiB single-file signed transfer as well as
// manifest-backed chunked large-file and directory bundle transfer with per-chunk
// SHA-256 + root manifest digest verification, symlink/traversal rejection,
// resumable checkpoints, and unknown_outcome reconciliation without blind resend.
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { CHAT_FILE_ASSETS_DIR } from '../lib/config.mjs';
import { factoryRead, factoryTransaction, factoryError, now, digest as canonicalDigest } from './work-graph-store.mjs';
import { getSession } from './session-manager.mjs';
import {
  getFileAsset,
  localizeFileAsset,
  createFileAssetUploadIntent,
  ingestFileAssetUpload,
  finalizeFileAssetUpload,
  findFileAssetUploadReceipt,
} from './file-assets.mjs';
import { loadOrCreateInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { proxyToTarget } from './router-target-runtime-routes.mjs';

export const LEGACY_SINGLE_FILE_LIMIT = 4 * 1024 * 1024;
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;
export const MIN_CHUNK_BYTES = 256;
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 1000;
export const MAX_MANIFEST_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const MAX_MANIFEST_JSON_BYTES = 2 * 1024 * 1024;
export const REMOTE_TRANSFER_MODES = Object.freeze(['single_file', 'chunked_file', 'directory_bundle']);

const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
const RESTRICTED_SEGMENT_RE = /^(?:\.git|\.ssh|\.aws|\.gnupg|\.env(?:\..*)?|credentials?|secrets?|node_modules|\.cache|id_rsa|id_ed25519)$/i;
const RESTRICTED_EXT_RE = /\.(?:pem|key|p12|pfx)$/i;
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const hash = (v) => createHash('sha256').update(v).digest('hex');

function id(v, label = 'Invalid identity') {
  const s = text(v);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(s)) throw factoryError('FILE_TRANSFER_INVALID', label, 400);
  return s;
}

function addColumn(db, table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_file_grants (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      peer_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      peer_grant_id TEXT NOT NULL,
      peer_version INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      version INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_file_transfers (
      grant_id TEXT NOT NULL,
      transfer_id TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      target_asset_id TEXT,
      updated_at TEXT NOT NULL,
      scope_json TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(grant_id, transfer_id)
    );
    CREATE TABLE IF NOT EXISTS remote_file_source_transfers (
      grant_id TEXT NOT NULL,
      transfer_id TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      receipt_json TEXT,
      updated_at TEXT NOT NULL,
      scope_json TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(grant_id, transfer_id)
    );
    CREATE TABLE IF NOT EXISTS remote_file_chunk_receipts (
      grant_id TEXT NOT NULL,
      transfer_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      file_offset INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      staged_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(grant_id, transfer_id, chunk_index)
    );
    CREATE TABLE IF NOT EXISTS remote_file_source_chunks (
      grant_id TEXT NOT NULL,
      transfer_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(grant_id, transfer_id, chunk_index)
    );
  `);

  addColumn(db, 'remote_file_grants', 'transfer_mode', "TEXT NOT NULL DEFAULT 'single_file'");
  addColumn(db, 'remote_file_grants', 'manifest_digest', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'remote_file_grants', 'chunk_bytes', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'remote_file_grants', 'file_count', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'remote_file_grants', 'source_root', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'remote_file_grants', 'target_root', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'remote_file_grants', 'allowed_paths_json', "TEXT NOT NULL DEFAULT '[]'");

  addColumn(db, 'remote_file_transfers', 'transfer_mode', "TEXT NOT NULL DEFAULT 'single_file'");
  addColumn(db, 'remote_file_transfers', 'manifest_digest', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'remote_file_transfers', 'manifest_json', 'TEXT');
  addColumn(db, 'remote_file_transfers', 'total_chunks', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'remote_file_transfers', 'received_bytes', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'remote_file_transfers', 'total_bytes', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'remote_file_transfers', 'file_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'remote_file_transfers', 'target_root', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'remote_file_transfers', 'materialized_json', 'TEXT');

  addColumn(db, 'remote_file_source_transfers', 'transfer_mode', "TEXT NOT NULL DEFAULT 'single_file'");
  addColumn(db, 'remote_file_source_transfers', 'manifest_digest', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'remote_file_source_transfers', 'manifest_json', 'TEXT');
  addColumn(db, 'remote_file_source_transfers', 'total_chunks', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'remote_file_source_transfers', 'pending_chunk_index', 'INTEGER');
  addColumn(db, 'remote_file_source_transfers', 'unknown_reason', 'TEXT');
  addColumn(db, 'remote_file_source_transfers', 'confirmed_chunks_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumn(db, 'remote_file_source_transfers', 'manifest_initialized', 'INTEGER NOT NULL DEFAULT 0');
}

function active(row) {
  return row && row.enabled && Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) > Date.now();
}

function validKey(key, peer) {
  try {
    return createPublicKey(key).asymmetricKeyType === 'ed25519'
      && `inst_${createInstancePublicKeyFingerprint(key).slice(0, 32)}` === peer;
  } catch {
    return false;
  }
}

function parseJsonSafe(raw, fallback = null) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function grant(row) {
  return {
    id: row.id,
    role: row.role,
    ownerId: row.owner_id,
    peerId: row.peer_id,
    peerKey: row.peer_key,
    sessionId: row.session_id,
    assetId: row.asset_id,
    peerGrantId: row.peer_grant_id,
    peerVersion: row.peer_version,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    filename: row.filename,
    mime: row.mime,
    transferMode: row.transfer_mode || 'single_file',
    manifestDigest: row.manifest_digest || '',
    chunkBytes: row.chunk_bytes || 0,
    fileCount: row.file_count || 1,
    sourceRoot: row.source_root || '',
    targetRoot: row.target_root || '',
    allowedPaths: parseJsonSafe(row.allowed_paths_json, []),
    version: row.version,
    enabled: !!row.enabled,
    expiresAt: row.expires_at,
  };
}

export function validateBundleRelativePath(relPath) {
  if (typeof relPath !== 'string') {
    throw factoryError('FILE_TRANSFER_PATH_INVALID', 'Bundle path must be a string', 400);
  }
  if (!relPath || relPath.length > 1024 || relPath.includes('\0') || relPath.includes('\\')) {
    throw factoryError('FILE_TRANSFER_PATH_INVALID', 'Bundle path contains invalid characters', 400);
  }
  if (/^(?:[A-Za-z]:|\/)/.test(relPath) || relPath.startsWith('/') || relPath.endsWith('/')) {
    throw factoryError('FILE_TRANSFER_PATH_INVALID', 'Bundle path must be relative', 400);
  }
  const parts = relPath.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || WINDOWS_RESERVED_RE.test(p)
      || RESTRICTED_SEGMENT_RE.test(p) || RESTRICTED_EXT_RE.test(p) || p.endsWith(' '))) {
    throw factoryError('FILE_TRANSFER_PATH_FORBIDDEN', `Restricted or traversal path rejected: ${relPath}`, 400);
  }
  return parts.join('/');
}

function isContainedPath(rootReal, candidateReal) {
  const rel = relative(rootReal, candidateReal);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function assertNoSymlinkPath(rootPath, relativeSegments = []) {
  let cursor = resolve(rootPath);
  const rootInfo = await lstat(cursor).catch(() => null);
  if (!rootInfo || rootInfo.isSymbolicLink()) {
    throw factoryError('FILE_TRANSFER_SYMLINK_REJECTED', 'Symlink path is not allowed', 400);
  }
  const rootReal = await realpath(cursor);
  for (const segment of relativeSegments) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor).catch((err) => {
      if (err?.code === 'ENOENT') return null;
      throw err;
    });
    if (!info) continue;
    if (info.isSymbolicLink()) {
      throw factoryError('FILE_TRANSFER_SYMLINK_REJECTED', `Symlink rejected at ${segment}`, 400);
    }
    const segReal = await realpath(cursor);
    if (!isContainedPath(rootReal, segReal)) {
      throw factoryError('FILE_TRANSFER_PATH_FORBIDDEN', 'Path escapes authorized root', 403);
    }
  }
  return rootReal;
}

function pathAllowedByScope(relPath, allowedPaths = []) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) return true;
  return allowedPaths.some((root) => relPath === root || relPath.startsWith(`${root}/`));
}

function validateFileCollectionIntegrity(files) {
  const seenLower = new Set();
  const dirPrefixes = new Set();
  for (const file of files) {
    const clean = validateBundleRelativePath(file.path);
    const lower = clean.toLowerCase();
    if (seenLower.has(lower)) {
      throw factoryError('FILE_TRANSFER_PATH_INVALID', `Duplicate or case-colliding path: ${clean}`, 400);
    }
    seenLower.add(lower);
    const parts = clean.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      dirPrefixes.add(parts.slice(0, i).join('/').toLowerCase());
    }
  }
  for (const lower of seenLower) {
    if (dirPrefixes.has(lower)) {
      throw factoryError('FILE_TRANSFER_PATH_INVALID', 'File path collides with directory prefix', 400);
    }
  }
}

async function scanFileIntoManifest(absPath, relPath, chunkBytes, chunksOut) {
  const before = await lstat(absPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw factoryError('FILE_TRANSFER_SYMLINK_REJECTED', `Unsupported non-regular file or symlink: ${relPath}`, 400);
  }
  const handle = await open(absPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const fileHasher = createHash('sha256');
  const chunkStart = chunksOut.length;
  let chunkCount = 0;
  let offset = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.size !== before.size) {
      throw factoryError('FILE_TRANSFER_CONFLICT', `Source file changed before reading: ${relPath}`, 409);
    }
    while (offset < before.size) {
      const len = Math.min(chunkBytes, before.size - offset);
      const buf = Buffer.allocUnsafe(len);
      let readTotal = 0;
      while (readTotal < len) {
        const res = await handle.read(buf, readTotal, len - readTotal, offset + readTotal);
        if (!res.bytesRead) throw factoryError('FILE_TRANSFER_CONFLICT', `Unexpected EOF reading ${relPath}`, 409);
        readTotal += res.bytesRead;
      }
      fileHasher.update(buf);
      chunksOut.push({
        index: chunksOut.length,
        filePath: relPath,
        fileOffset: offset,
        sizeBytes: len,
        sha256: hash(buf),
      });
      offset += len;
      chunkCount += 1;
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(absPath);
  if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw factoryError('FILE_TRANSFER_CONFLICT', `Source file mutated while reading: ${relPath}`, 409);
  }
  return {
    path: relPath,
    sizeBytes: before.size,
    sha256: before.size === 0 ? EMPTY_SHA256 : fileHasher.digest('hex'),
    chunkStart,
    chunkCount,
  };
}

export async function buildRemoteTransferManifest({
  transferMode = 'directory_bundle',
  sourcePath = '',
  assetId = '',
  sessionId = '',
  bundleName = '',
  chunkBytes = DEFAULT_CHUNK_BYTES,
  allowedPaths = [],
} = {}) {
  if (!['chunked_file', 'directory_bundle'].includes(transferMode)) {
    throw factoryError('FILE_TRANSFER_INVALID', 'Manifest transferMode must be chunked_file or directory_bundle', 400);
  }
  const normalizedChunkBytes = Number(chunkBytes ?? DEFAULT_CHUNK_BYTES);
  if (!Number.isSafeInteger(normalizedChunkBytes) || normalizedChunkBytes < MIN_CHUNK_BYTES || normalizedChunkBytes > MAX_CHUNK_BYTES) {
    throw factoryError('FILE_TRANSFER_INVALID', `chunkBytes must be between ${MIN_CHUNK_BYTES} and ${MAX_CHUNK_BYTES}`, 400);
  }
  const normalizedAllowed = Array.isArray(allowedPaths) ? allowedPaths.map(validateBundleRelativePath) : [];

  let resolvedRoot = '';
  const files = [];
  const chunks = [];

  if (assetId) {
    if (transferMode !== 'chunked_file') {
      throw factoryError('FILE_TRANSFER_INVALID', 'assetId manifest only supports chunked_file', 400);
    }
    const asset = await getFileAsset(id(assetId, 'assetId'));
    if (!asset || (sessionId && asset.sessionId !== sessionId) || asset.status !== 'ready') {
      throw factoryError('FILE_TRANSFER_INVALID', 'Source file asset is unavailable', 409);
    }
    const localPath = await localizeFileAsset(asset);
    const info = await lstat(localPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw factoryError('FILE_TRANSFER_SYMLINK_REJECTED', 'Asset file cannot be a symlink', 400);
    }
    const relName = validateBundleRelativePath(text(bundleName) || asset.originalName || 'asset.bin');
    const entry = await scanFileIntoManifest(localPath, relName, normalizedChunkBytes, chunks);
    if (entry.sizeBytes !== asset.sizeBytes || entry.sha256 !== asset.sha256) {
      throw factoryError('FILE_TRANSFER_CONFLICT', 'Asset bytes do not match recorded metadata', 409);
    }
    files.push(entry);
    resolvedRoot = localPath;
  } else {
    const rawPath = text(sourcePath);
    if (!rawPath) throw factoryError('FILE_TRANSFER_INVALID', 'sourcePath or assetId is required', 400);
    const rootStat = await lstat(rawPath).catch(() => null);
    if (!rootStat) throw factoryError('FILE_TRANSFER_NOT_FOUND', 'Source path does not exist', 404);
    if (rootStat.isSymbolicLink()) {
      throw factoryError('FILE_TRANSFER_SYMLINK_REJECTED', 'Source root cannot be a symlink', 400);
    }
    resolvedRoot = await realpath(rawPath);

    if (transferMode === 'chunked_file') {
      if (!rootStat.isFile()) {
        throw factoryError('FILE_TRANSFER_INVALID', 'chunked_file sourcePath must be a regular file', 400);
      }
      const relName = validateBundleRelativePath(text(bundleName) || resolvedRoot.split(/[\\/]/).filter(Boolean).pop() || 'file.bin');
      files.push(await scanFileIntoManifest(resolvedRoot, relName, normalizedChunkBytes, chunks));
    } else {
      if (!rootStat.isDirectory()) {
        throw factoryError('FILE_TRANSFER_INVALID', 'directory_bundle sourcePath must be a directory', 400);
      }
      const discovered = [];
      const walk = async (dirAbs, relPrefix = '') => {
        const entries = await readdir(dirAbs, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const abs = join(dirAbs, entry.name);
          const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
          const info = await lstat(abs);
          if (info.isSymbolicLink()) {
            throw factoryError('FILE_TRANSFER_SYMLINK_REJECTED', `Symlink rejected in bundle: ${rel}`, 400);
          }
          const realEntry = await realpath(abs);
          if (!isContainedPath(resolvedRoot, realEntry)) {
            throw factoryError('FILE_TRANSFER_PATH_FORBIDDEN', `Bundle entry escapes root: ${rel}`, 403);
          }
          if (info.isDirectory()) {
            if (RESTRICTED_SEGMENT_RE.test(entry.name)) {
              throw factoryError('FILE_TRANSFER_PATH_FORBIDDEN', `Restricted directory rejected: ${rel}`, 400);
            }
            await walk(abs, rel);
          } else if (info.isFile()) {
            const validated = validateBundleRelativePath(rel);
            if (!pathAllowedByScope(validated, normalizedAllowed)) continue;
            discovered.push({ abs, rel: validated });
            if (discovered.length > MAX_BUNDLE_FILES) {
              throw factoryError('FILE_TRANSFER_LIMIT_EXCEEDED', `Bundle exceeds ${MAX_BUNDLE_FILES} files`, 400);
            }
          } else {
            throw factoryError('FILE_TRANSFER_INVALID', `Unsupported special file in bundle: ${rel}`, 400);
          }
        }
      };
      await walk(resolvedRoot);
      if (discovered.length === 0) {
        throw factoryError('FILE_TRANSFER_INVALID', 'Directory bundle contains no authorized files', 400);
      }
      discovered.sort((a, b) => a.rel.localeCompare(b.rel));
      for (const item of discovered) {
        files.push(await scanFileIntoManifest(item.abs, item.rel, normalizedChunkBytes, chunks));
      }
    }
  }

  validateFileCollectionIntegrity(files);
  const totalBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);
  if (transferMode === 'chunked_file' && totalBytes < 1) {
    throw factoryError('FILE_TRANSFER_INVALID', 'chunked_file must have at least 1 byte', 400);
  }
  if (totalBytes > MAX_MANIFEST_TOTAL_BYTES) {
    throw factoryError('FILE_TRANSFER_LIMIT_EXCEEDED', 'Transfer exceeds maximum size bound', 400);
  }

  const manifest = {
    schemaVersion: 1,
    transferMode,
    bundleName: text(bundleName) || files[0]?.path || 'bundle',
    chunkBytes: normalizedChunkBytes,
    totalBytes,
    totalChunks: chunks.length,
    fileCount: files.length,
    files,
    chunks,
  };
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_MANIFEST_JSON_BYTES) {
    throw factoryError('FILE_TRANSFER_LIMIT_EXCEEDED', 'Transfer manifest exceeds bounded JSON limit', 400);
  }
  const manifestDigest = canonicalDigest(manifest);
  return { manifest, manifestDigest, resolvedRoot };
}

function validateReceivedManifest(manifest, grantRow) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schemaVersion !== 1) {
    throw factoryError('FILE_TRANSFER_INVALID', 'Invalid transfer manifest schema', 400);
  }
  if (manifest.transferMode !== grantRow.transferMode
      || manifest.chunkBytes !== grantRow.chunkBytes
      || manifest.totalBytes !== grantRow.sizeBytes
      || manifest.fileCount !== grantRow.fileCount
      || !Array.isArray(manifest.files) || manifest.files.length !== grantRow.fileCount
      || !Array.isArray(manifest.chunks) || manifest.totalChunks !== manifest.chunks.length) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Manifest does not match dual-side grant scope', 403);
  }
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_MANIFEST_JSON_BYTES) {
    throw factoryError('FILE_TRANSFER_LIMIT_EXCEEDED', 'Manifest exceeds bounded JSON limit', 400);
  }
  if (canonicalDigest(manifest) !== grantRow.manifestDigest) {
    throw factoryError('FILE_TRANSFER_TAMPERED', 'Manifest digest mismatch', 403);
  }

  validateFileCollectionIntegrity(manifest.files);

  let computedTotalBytes = 0;
  let expectedChunkIndex = 0;
  for (const file of manifest.files) {
    if (!pathAllowedByScope(file.path, grantRow.allowedPaths)) {
      throw factoryError('FILE_TRANSFER_PATH_FORBIDDEN', `File outside grant allowedPaths: ${file.path}`, 403);
    }
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) {
      throw factoryError('FILE_TRANSFER_INVALID', `Invalid file manifest entry: ${file.path}`, 400);
    }
    const expectedChunks = file.sizeBytes === 0 ? 0 : Math.ceil(file.sizeBytes / grantRow.chunkBytes);
    if (file.chunkStart !== expectedChunkIndex || file.chunkCount !== expectedChunks) {
      throw factoryError('FILE_TRANSFER_INVALID', `Invalid chunk range for file: ${file.path}`, 400);
    }
    let fileOffset = 0;
    for (let i = 0; i < expectedChunks; i += 1) {
      const chunk = manifest.chunks[expectedChunkIndex];
      if (!chunk || chunk.index !== expectedChunkIndex || chunk.filePath !== file.path
          || chunk.fileOffset !== fileOffset || !/^[a-f0-9]{64}$/.test(chunk.sha256 || '')) {
        throw factoryError('FILE_TRANSFER_INVALID', 'Invalid chunk descriptor in manifest', 400);
      }
      const expectedLen = Math.min(grantRow.chunkBytes, file.sizeBytes - fileOffset);
      if (chunk.sizeBytes !== expectedLen) {
        throw factoryError('FILE_TRANSFER_INVALID', 'Chunk size mismatch in manifest', 400);
      }
      fileOffset += expectedLen;
      expectedChunkIndex += 1;
    }
    if (fileOffset !== file.sizeBytes) {
      throw factoryError('FILE_TRANSFER_INVALID', 'File byte coverage incomplete in manifest', 400);
    }
    computedTotalBytes += file.sizeBytes;
  }

  if (expectedChunkIndex !== manifest.chunks.length || computedTotalBytes !== grantRow.sizeBytes) {
    throw factoryError('FILE_TRANSFER_INVALID', 'Manifest byte or chunk count mismatch', 400);
  }
}

async function resolveSessionContainedPath(session, candidatePath, { mustExist = true, expectDir = null } = {}) {
  const raw = text(candidatePath);
  if (!raw) throw factoryError('FILE_TRANSFER_PATH_INVALID', 'Path is required', 400);
  if (!session?.folder) {
    throw factoryError('FILE_TRANSFER_PATH_FORBIDDEN', 'Session folder root required for filesystem transfer', 403);
  }
  const sessionRootInfo = await lstat(session.folder).catch(() => null);
  if (!sessionRootInfo || !sessionRootInfo.isDirectory() || sessionRootInfo.isSymbolicLink()) {
    throw factoryError('FILE_TRANSFER_SYMLINK_REJECTED', 'Session folder is unavailable or a symlink', 403);
  }
  const sessionReal = await realpath(session.folder);
  const resolvedCandidate = isAbsolute(raw) ? resolve(raw) : resolve(sessionReal, raw);
  const rel = relative(sessionReal, resolvedCandidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw factoryError('FILE_TRANSFER_PATH_FORBIDDEN', 'Path escapes authorized session folder', 403);
  }
  const segments = rel ? rel.split(sep).filter(Boolean) : [];
  await assertNoSymlinkPath(sessionReal, segments);

  const info = await lstat(resolvedCandidate).catch((err) => {
    if (err?.code === 'ENOENT') return null;
    throw err;
  });
  if (mustExist && !info) throw factoryError('FILE_TRANSFER_NOT_FOUND', 'Configured path does not exist', 404);
  if (info?.isSymbolicLink()) throw factoryError('FILE_TRANSFER_SYMLINK_REJECTED', 'Configured path cannot be a symlink', 400);
  if (info && expectDir === true && !info.isDirectory()) {
    throw factoryError('FILE_TRANSFER_INVALID', 'Expected a directory path', 400);
  }
  return info ? await realpath(resolvedCandidate) : resolvedCandidate;
}

export async function configureRemoteFileGrant(input, actor) {
  if (actor?.kind !== 'user' || actor?.role !== 'owner' || !text(actor.principalId)) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Owner required', 403);
  }
  const grantId = id(input?.id);
  const role = text(input?.role);
  const peer = id(input?.peerId);
  const key = text(input?.peerKey);
  const sessionId = id(input?.sessionId);
  const peerGrantId = id(input?.peerGrantId);
  const transferMode = text(input?.transferMode) || 'single_file';
  if (!REMOTE_TRANSFER_MODES.includes(transferMode)) {
    throw factoryError('FILE_TRANSFER_INVALID', 'Unsupported transferMode', 400);
  }
  if (!['source', 'target'].includes(role) || !validKey(key, peer)
      || !Number.isSafeInteger(input?.expectedVersion) || input.expectedVersion < 0
      || !Number.isSafeInteger(input.peerVersion) || input.peerVersion < 1
      || !text(input.filename) || text(input.filename).length > 255
      || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) {
    throw factoryError('FILE_TRANSFER_INVALID', 'Grant scope invalid', 400);
  }

  const session = await getSession(sessionId);
  if (!session?.id || session.archived) {
    throw factoryError('FILE_TRANSFER_INVALID', 'Session unavailable', 409);
  }

  let assetId = '';
  let sha256 = '';
  let sizeBytes = 0;
  let manifestDigest = '';
  let chunkBytes = 0;
  let fileCount = 1;
  let sourceRoot = '';
  let targetRoot = '';
  let allowedPaths = [];

  if (transferMode === 'single_file') {
    assetId = role === 'source' ? id(input?.assetId) : '';
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > LEGACY_SINGLE_FILE_LIMIT
        || !/^[a-f0-9]{64}$/.test(text(input.sha256))) {
      throw factoryError('FILE_TRANSFER_INVALID', 'Grant scope invalid', 400);
    }
    sizeBytes = input.sizeBytes;
    sha256 = text(input.sha256);
    if (role === 'source') {
      const asset = await getFileAsset(assetId);
      if (!asset || asset.sessionId !== sessionId || asset.status !== 'ready'
          || asset.sizeBytes !== sizeBytes || asset.sha256 !== sha256) {
        throw factoryError('FILE_TRANSFER_INVALID', 'Source asset does not match grant', 409);
      }
    }
  } else {
    manifestDigest = text(input?.manifestDigest).toLowerCase();
    chunkBytes = input?.chunkBytes === undefined ? DEFAULT_CHUNK_BYTES : Number(input.chunkBytes);
    fileCount = input?.fileCount === undefined ? (transferMode === 'chunked_file' ? 1 : 0) : Number(input.fileCount);
    sizeBytes = Number(input?.sizeBytes);
    sha256 = text(input?.sha256).toLowerCase() || manifestDigest;
    allowedPaths = Array.isArray(input?.allowedPaths) ? input.allowedPaths.map(validateBundleRelativePath) : [];

    if (!/^[a-f0-9]{64}$/.test(manifestDigest)
        || !Number.isSafeInteger(chunkBytes) || chunkBytes < MIN_CHUNK_BYTES || chunkBytes > MAX_CHUNK_BYTES
        || !Number.isSafeInteger(fileCount) || fileCount < 1 || fileCount > MAX_BUNDLE_FILES
        || (transferMode === 'chunked_file' && fileCount !== 1)
        || !Number.isSafeInteger(sizeBytes) || sizeBytes < (transferMode === 'chunked_file' ? 1 : 0) || sizeBytes > MAX_MANIFEST_TOTAL_BYTES) {
      throw factoryError('FILE_TRANSFER_INVALID', 'Manifest grant scope invalid', 400);
    }

    if (role === 'source') {
      if (input?.assetId) {
        assetId = id(input.assetId);
        const built = await buildRemoteTransferManifest({
          transferMode,
          assetId,
          sessionId,
          bundleName: text(input.filename),
          chunkBytes,
          allowedPaths,
        });
        if (built.manifestDigest !== manifestDigest || built.manifest.totalBytes !== sizeBytes || built.manifest.fileCount !== fileCount) {
          throw factoryError('FILE_TRANSFER_INVALID', 'Source asset manifest does not match grant', 409);
        }
        sourceRoot = built.resolvedRoot;
      } else if (input?.sourcePath) {
        const verifiedPath = await resolveSessionContainedPath(session, input.sourcePath, {
          mustExist: true,
          expectDir: transferMode === 'directory_bundle' ? true : null,
        });
        const built = await buildRemoteTransferManifest({
          transferMode,
          sourcePath: verifiedPath,
          sessionId,
          bundleName: text(input.filename),
          chunkBytes,
          allowedPaths,
        });
        if (built.manifestDigest !== manifestDigest || built.manifest.totalBytes !== sizeBytes || built.manifest.fileCount !== fileCount) {
          throw factoryError('FILE_TRANSFER_INVALID', 'Source path manifest does not match grant', 409);
        }
        sourceRoot = built.resolvedRoot;
      } else {
        throw factoryError('FILE_TRANSFER_INVALID', 'Source grant requires assetId or sourcePath', 400);
      }
    } else if (input?.targetDir) {
      targetRoot = await resolveSessionContainedPath(session, input.targetDir, { mustExist: false, expectDir: true });
    }
  }

  return factoryTransaction((db) => {
    schema(db);
    const old = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
    if ((old?.version || 0) !== input.expectedVersion || (old && (old.owner_id !== actor.principalId || old.role !== role))) {
      throw factoryError('FILE_TRANSFER_CONFLICT', 'Grant changed', 409);
    }
    db.prepare(`
      INSERT INTO remote_file_grants (
        id, role, owner_id, peer_id, peer_key, session_id, asset_id, peer_grant_id, peer_version,
        sha256, size_bytes, filename, mime, version, enabled, expires_at, updated_at,
        transfer_mode, manifest_digest, chunk_bytes, file_count, source_root, target_root, allowed_paths_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        role=excluded.role,
        peer_id=excluded.peer_id,
        peer_key=excluded.peer_key,
        session_id=excluded.session_id,
        asset_id=excluded.asset_id,
        peer_grant_id=excluded.peer_grant_id,
        peer_version=excluded.peer_version,
        sha256=excluded.sha256,
        size_bytes=excluded.size_bytes,
        filename=excluded.filename,
        mime=excluded.mime,
        version=excluded.version,
        enabled=excluded.enabled,
        expires_at=excluded.expires_at,
        updated_at=excluded.updated_at,
        transfer_mode=excluded.transfer_mode,
        manifest_digest=excluded.manifest_digest,
        chunk_bytes=excluded.chunk_bytes,
        file_count=excluded.file_count,
        source_root=excluded.source_root,
        target_root=excluded.target_root,
        allowed_paths_json=excluded.allowed_paths_json
    `).run(
      grantId, role, actor.principalId, peer, key, sessionId, assetId, peerGrantId, input.peerVersion,
      sha256, sizeBytes, text(input.filename), text(input.mime) || 'application/octet-stream',
      input.expectedVersion + 1, input.enabled === false ? 0 : 1, new Date(input.expiresAt).toISOString(), now(),
      transferMode, manifestDigest, chunkBytes, fileCount, sourceRoot, targetRoot, JSON.stringify(allowedPaths),
    );
    return grant(db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId));
  });
}

export async function revokeRemoteFileGrant(grantId, expectedVersion, actor) {
  grantId = id(grantId);
  if (actor?.kind !== 'user' || actor?.role !== 'owner' || !text(actor.principalId) || !Number.isSafeInteger(expectedVersion)) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Owner and version required', 403);
  }
  return factoryTransaction((db) => {
    schema(db);
    const row = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
    if (!row || row.owner_id !== actor.principalId || row.version !== expectedVersion) {
      throw factoryError('FILE_TRANSFER_CONFLICT', 'Grant changed', 409);
    }
    db.prepare('UPDATE remote_file_grants SET enabled=0,version=version+1,updated_at=? WHERE id=?').run(now(), grantId);
    return grant(db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId));
  });
}

function principalOk(principal, grantId, operation) {
  if (!principal?.targetRuntime || principal.targetRuntimeOperation !== operation || principal.targetRuntimeResourceId !== grantId) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Target grant required', 403);
  }
}

async function currentTarget(grantId, principal, operation) {
  principalOk(principal, grantId, operation);
  return factoryRead((db) => {
    schema(db);
    const row = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
    if (!row || row.role !== 'target' || row.peer_id !== principal.sourceInstanceId) {
      throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Transfer source mismatch', 403);
    }
    return grant(row);
  });
}

function targetStagingPaths(grantId, transferId) {
  const base = resolve(CHAT_FILE_ASSETS_DIR, 'remote-transfers', id(grantId), id(transferId));
  return {
    base,
    chunksDir: join(base, 'chunks'),
    finalDir: join(base, 'final'),
  };
}

function verifyPeerSignature(prefix, canonical, peerKey, signature) {
  let ok = false;
  try {
    ok = verify(
      null,
      Buffer.from(`${prefix}:${hash(JSON.stringify(canonical))}`),
      createPublicKey(peerKey),
      Buffer.from(text(signature), 'base64url'),
    );
  } catch {}
  if (!ok) throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Transfer signature invalid', 403);
}

function computeChunkStatusSummary(manifest, chunkRows) {
  const totalChunks = manifest?.chunks?.length || 0;
  const confirmedSet = new Set(chunkRows.map((r) => r.chunk_index));
  const confirmedChunks = [];
  const missingChunkIndices = [];
  let receivedBytes = 0;
  for (let i = 0; i < totalChunks; i += 1) {
    if (confirmedSet.has(i)) {
      confirmedChunks.push(i);
      receivedBytes += manifest.chunks[i].sizeBytes;
    } else {
      missingChunkIndices.push(i);
    }
  }
  return {
    totalChunks,
    confirmedChunks,
    missingChunkIndices,
    nextChunkIndex: missingChunkIndices.length > 0 ? missingChunkIndices[0] : totalChunks,
    receivedBytes,
  };
}

function formatManifestReceipt(transferRow, manifest, chunkRows) {
  const summary = computeChunkStatusSummary(manifest, chunkRows);
  return {
    grantId: transferRow.grant_id,
    transferId: transferRow.transfer_id,
    transferMode: transferRow.transfer_mode,
    manifestDigest: transferRow.manifest_digest,
    manifestInitialized: true,
    status: transferRow.status,
    totalBytes: transferRow.total_bytes,
    fileCount: transferRow.file_count,
    targetAssetId: transferRow.target_asset_id || null,
    targetRoot: transferRow.target_root || null,
    materializedFiles: parseJsonSafe(transferRow.materialized_json, []),
    sha256: transferRow.manifest_digest,
    sizeBytes: transferRow.total_bytes,
    ...summary,
  };
}

async function ensureSafeStagingDir(dirPath) {
  const root = resolve(CHAT_FILE_ASSETS_DIR);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rel = relative(root, resolve(dirPath));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw factoryError('FILE_TRANSFER_PATH_FORBIDDEN', 'Staging path escapes asset directory', 403);
  }
  await assertNoSymlinkPath(root, rel.split(sep).filter(Boolean));
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
}

async function receiveRemoteManifestInit(input, principal) {
  const grantId = id(input?.grantId);
  const transferId = id(input?.transferId);
  const g = await currentTarget(grantId, principal, 'file.transfer.write');
  if (g.transferMode === 'single_file') {
    throw factoryError('FILE_TRANSFER_INVALID', 'Grant is configured for single_file, not manifest transfer', 400);
  }
  const canonical = {
    action: 'init_manifest',
    grantId,
    transferId,
    sourceGrantId: id(input.sourceGrantId),
    sourceVersion: input.sourceVersion,
    targetVersion: input.targetVersion,
    transferMode: text(input.transferMode),
    manifestDigest: text(input.manifestDigest).toLowerCase(),
    sizeBytes: input.sizeBytes,
    fileCount: input.fileCount,
    chunkBytes: input.chunkBytes,
    manifest: input.manifest,
  };
  if (!g.enabled || Date.parse(g.expiresAt) <= Date.now()
      || canonical.targetVersion !== g.version || canonical.sourceGrantId !== g.peerGrantId
      || canonical.sourceVersion !== g.peerVersion || canonical.transferMode !== g.transferMode
      || canonical.manifestDigest !== g.manifestDigest || canonical.sizeBytes !== g.sizeBytes
      || canonical.fileCount !== g.fileCount || canonical.chunkBytes !== g.chunkBytes) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Transfer scope changed', 403);
  }
  verifyPeerSignature('ragent-file-manifest-v1', canonical, g.peerKey, input.signature);
  validateReceivedManifest(canonical.manifest, g);

  const payloadDigest = hash(JSON.stringify(canonical));
  const staging = targetStagingPaths(grantId, transferId);
  await ensureSafeStagingDir(staging.chunksDir);

  return factoryTransaction((db) => {
    schema(db);
    const row = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
    if (!active(row) || row.version !== g.version) {
      throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Target authorization changed', 403);
    }
    const old = db.prepare('SELECT * FROM remote_file_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId);
    if (old) {
      if (old.payload_digest !== payloadDigest) {
        throw factoryError('FILE_TRANSFER_CONFLICT', 'Transfer identity reused with different manifest', 409);
      }
      const chunks = db.prepare('SELECT * FROM remote_file_chunk_receipts WHERE grant_id=? AND transfer_id=? ORDER BY chunk_index').all(grantId, transferId);
      return formatManifestReceipt(old, canonical.manifest, chunks);
    }
    db.prepare(`
      INSERT INTO remote_file_transfers (
        grant_id, transfer_id, payload_digest, status, target_asset_id, updated_at, scope_json,
        transfer_mode, manifest_digest, manifest_json, total_chunks, received_bytes, total_bytes, file_count, target_root
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      grantId, transferId, payloadDigest, 'uploading', null, now(), JSON.stringify(g),
      g.transferMode, g.manifestDigest, JSON.stringify(canonical.manifest), canonical.manifest.chunks.length,
      0, g.sizeBytes, g.fileCount, g.targetRoot || '',
    );
    const created = db.prepare('SELECT * FROM remote_file_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId);
    return formatManifestReceipt(created, canonical.manifest, []);
  });
}

async function receiveRemoteFileChunk(input, principal) {
  const grantId = id(input?.grantId);
  const transferId = id(input?.transferId);
  const g = await currentTarget(grantId, principal, 'file.transfer.write');
  if (g.transferMode === 'single_file') {
    throw factoryError('FILE_TRANSFER_INVALID', 'Grant does not use chunked transfer', 400);
  }
  const canonical = {
    action: 'upload_chunk',
    grantId,
    transferId,
    sourceGrantId: id(input.sourceGrantId),
    sourceVersion: input.sourceVersion,
    targetVersion: input.targetVersion,
    manifestDigest: text(input.manifestDigest).toLowerCase(),
    chunkIndex: input.chunkIndex,
    chunkSha256: text(input.chunkSha256).toLowerCase(),
    chunkSizeBytes: input.chunkSizeBytes,
    bytesBase64: text(input.bytesBase64),
  };
  if (!g.enabled || Date.parse(g.expiresAt) <= Date.now()
      || canonical.targetVersion !== g.version || canonical.sourceGrantId !== g.peerGrantId
      || canonical.sourceVersion !== g.peerVersion || canonical.manifestDigest !== g.manifestDigest
      || !Number.isSafeInteger(canonical.chunkIndex) || canonical.chunkIndex < 0
      || !/^[a-f0-9]{64}$/.test(canonical.chunkSha256)
      || !Number.isSafeInteger(canonical.chunkSizeBytes) || canonical.chunkSizeBytes < 1
      || canonical.chunkSizeBytes > g.chunkBytes) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Chunk authorization or bounds invalid', 403);
  }
  verifyPeerSignature('ragent-file-chunk-v1', canonical, g.peerKey, input.signature);

  const bytes = Buffer.from(canonical.bytesBase64, 'base64');
  if (bytes.length !== canonical.chunkSizeBytes) {
    throw factoryError('FILE_TRANSFER_SIZE_MISMATCH', 'Decoded chunk size mismatch', 400);
  }
  const actualHash = hash(bytes);
  if (actualHash !== canonical.chunkSha256) {
    throw factoryError('FILE_TRANSFER_TAMPERED', 'Chunk SHA-256 mismatch', 400);
  }

  const preflight = await factoryRead((db) => {
    schema(db);
    const row = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
    if (!active(row) || row.version !== g.version) {
      throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Target authorization changed', 403);
    }
    const transfer = db.prepare('SELECT * FROM remote_file_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId);
    if (!transfer || !transfer.manifest_json || transfer.manifest_digest !== g.manifestDigest) {
      throw factoryError('FILE_TRANSFER_NOT_FOUND', 'Transfer manifest not initialized', 404);
    }
    const manifest = JSON.parse(transfer.manifest_json);
    const expectedChunk = manifest.chunks[canonical.chunkIndex];
    if (!expectedChunk) throw factoryError('FILE_TRANSFER_INVALID', 'Chunk index out of range', 400);
    if (expectedChunk.sizeBytes !== bytes.length || expectedChunk.sha256 !== actualHash) {
      throw factoryError('FILE_TRANSFER_TAMPERED', 'Chunk does not match signed manifest entry', 403);
    }
    const existingChunk = db.prepare('SELECT * FROM remote_file_chunk_receipts WHERE grant_id=? AND transfer_id=? AND chunk_index=?')
      .get(grantId, transferId, canonical.chunkIndex);
    if (existingChunk) {
      if (existingChunk.sha256 !== actualHash) {
        throw factoryError('FILE_TRANSFER_CONFLICT', 'Chunk index reused with different digest', 409);
      }
      const chunks = db.prepare('SELECT * FROM remote_file_chunk_receipts WHERE grant_id=? AND transfer_id=? ORDER BY chunk_index').all(grantId, transferId);
      return { alreadyReceived: formatManifestReceipt(transfer, manifest, chunks), expectedChunk };
    }
    if (transfer.status === 'received') {
      const chunks = db.prepare('SELECT * FROM remote_file_chunk_receipts WHERE grant_id=? AND transfer_id=? ORDER BY chunk_index').all(grantId, transferId);
      return { alreadyReceived: formatManifestReceipt(transfer, manifest, chunks), expectedChunk };
    }
    return { alreadyReceived: null, expectedChunk };
  });

  if (preflight.alreadyReceived) {
    return preflight.alreadyReceived;
  }

  const staging = targetStagingPaths(grantId, transferId);
  await ensureSafeStagingDir(staging.chunksDir);
  const chunkFilename = `chunk_${String(canonical.chunkIndex).padStart(6, '0')}.bin`;
  const stagedPath = join(staging.chunksDir, chunkFilename);
  const tmpPath = `${stagedPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const handle = await open(tmpPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, stagedPath);

  return factoryTransaction((db) => {
    schema(db);
    const row = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
    if (!active(row) || row.version !== g.version) {
      throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Target authorization changed', 403);
    }
    const transfer = db.prepare('SELECT * FROM remote_file_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId);
    if (!transfer) throw factoryError('FILE_TRANSFER_NOT_FOUND', 'Transfer missing', 404);
    const manifest = JSON.parse(transfer.manifest_json);
    const existing = db.prepare('SELECT * FROM remote_file_chunk_receipts WHERE grant_id=? AND transfer_id=? AND chunk_index=?')
      .get(grantId, transferId, canonical.chunkIndex);
    if (existing) {
      if (existing.sha256 !== actualHash) throw factoryError('FILE_TRANSFER_CONFLICT', 'Chunk conflict', 409);
    } else {
      db.prepare(`
        INSERT INTO remote_file_chunk_receipts (
          grant_id, transfer_id, chunk_index, file_path, file_offset, size_bytes, sha256, staged_path, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        grantId, transferId, canonical.chunkIndex, preflight.expectedChunk.filePath,
        preflight.expectedChunk.fileOffset, bytes.length, actualHash, stagedPath, now(),
      );
    }
    const chunks = db.prepare('SELECT * FROM remote_file_chunk_receipts WHERE grant_id=? AND transfer_id=? ORDER BY chunk_index').all(grantId, transferId);
    const summary = computeChunkStatusSummary(manifest, chunks);
    db.prepare('UPDATE remote_file_transfers SET received_bytes=?, updated_at=? WHERE grant_id=? AND transfer_id=?')
      .run(summary.receivedBytes, now(), grantId, transferId);
    const updated = db.prepare('SELECT * FROM remote_file_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId);
    return formatManifestReceipt(updated, manifest, chunks);
  });
}

async function writeVerifiedBundleFile(baseDir, relPath, chunkPaths, expectedSizeBytes, expectedSha256) {
  const segments = validateBundleRelativePath(relPath).split('/');
  const parentSegs = segments.slice(0, -1);
  const baseReal = await realpath(baseDir);
  let dirCursor = baseReal;
  for (const seg of parentSegs) {
    dirCursor = join(dirCursor, seg);
    const existing = await lstat(dirCursor).catch((err) => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
    if (existing?.isSymbolicLink()) {
      throw factoryError('FILE_TRANSFER_SYMLINK_REJECTED', `Symlink directory rejected: ${seg}`, 400);
    }
    if (!existing) await mkdir(dirCursor, { recursive: true, mode: 0o700 });
  }
  const destPath = join(dirCursor, segments[segments.length - 1]);
  const existingDest = await lstat(destPath).catch((err) => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
  if (existingDest?.isSymbolicLink()) {
    throw factoryError('FILE_TRANSFER_SYMLINK_REJECTED', `Target file is a symlink: ${relPath}`, 400);
  }
  const tmpPath = `${destPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const hasher = createHash('sha256');
  let totalWritten = 0;
  const outHandle = await open(tmpPath, 'wx', 0o600);
  try {
    for (const chunkInfo of chunkPaths) {
      const cStat = await lstat(chunkInfo.stagedPath);
      if (!cStat.isFile() || cStat.isSymbolicLink() || cStat.size !== chunkInfo.sizeBytes) {
        throw factoryError('FILE_TRANSFER_CONFLICT', `Staged chunk corrupted for ${relPath}`, 409);
      }
      const bytes = await readFile(chunkInfo.stagedPath);
      if (hash(bytes) !== chunkInfo.sha256) {
        throw factoryError('FILE_TRANSFER_TAMPERED', `Staged chunk digest mismatch for ${relPath}`, 403);
      }
      hasher.update(bytes);
      await outHandle.writeFile(bytes);
      totalWritten += bytes.length;
    }
    await outHandle.sync();
  } catch (error) {
    await outHandle.close().catch(() => {});
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  await outHandle.close();

  const actualSha = totalWritten === 0 ? EMPTY_SHA256 : hasher.digest('hex');
  if (totalWritten !== expectedSizeBytes || actualSha !== expectedSha256) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw factoryError('FILE_TRANSFER_TAMPERED', `Assembled file verification failed: ${relPath}`, 403);
  }
  await rename(tmpPath, destPath);
  return { path: relPath, sizeBytes: totalWritten, sha256: actualSha, destPath };
}

async function finalizeRemoteManifestTransfer(input, principal) {
  const grantId = id(input?.grantId);
  const transferId = id(input?.transferId);
  const g = await currentTarget(grantId, principal, 'file.transfer.write');
  if (g.transferMode === 'single_file') {
    throw factoryError('FILE_TRANSFER_INVALID', 'Grant does not use manifest finalization', 400);
  }
  const canonical = {
    action: 'finalize_manifest',
    grantId,
    transferId,
    sourceGrantId: id(input.sourceGrantId),
    sourceVersion: input.sourceVersion,
    targetVersion: input.targetVersion,
    manifestDigest: text(input.manifestDigest).toLowerCase(),
  };
  if (!g.enabled || Date.parse(g.expiresAt) <= Date.now()
      || canonical.targetVersion !== g.version || canonical.sourceGrantId !== g.peerGrantId
      || canonical.sourceVersion !== g.peerVersion || canonical.manifestDigest !== g.manifestDigest) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Transfer authorization changed', 403);
  }
  verifyPeerSignature('ragent-file-finalize-v1', canonical, g.peerKey, input.signature);

  const loaded = await factoryRead((db) => {
    schema(db);
    const transfer = db.prepare('SELECT * FROM remote_file_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId);
    if (!transfer || !transfer.manifest_json || transfer.manifest_digest !== g.manifestDigest) {
      throw factoryError('FILE_TRANSFER_NOT_FOUND', 'Transfer manifest unavailable', 404);
    }
    const manifest = JSON.parse(transfer.manifest_json);
    const chunks = db.prepare('SELECT * FROM remote_file_chunk_receipts WHERE grant_id=? AND transfer_id=? ORDER BY chunk_index').all(grantId, transferId);
    return { transfer, manifest, chunks };
  });

  if (loaded.transfer.status === 'received') {
    return formatManifestReceipt(loaded.transfer, loaded.manifest, loaded.chunks);
  }

  const summary = computeChunkStatusSummary(loaded.manifest, loaded.chunks);
  if (summary.missingChunkIndices.length > 0) {
    throw factoryError('FILE_TRANSFER_INCOMPLETE', `Missing ${summary.missingChunkIndices.length} chunks`, 409);
  }

  const staging = targetStagingPaths(grantId, transferId);
  await ensureSafeStagingDir(staging.finalDir);
  const chunkByIndex = new Map(loaded.chunks.map((c) => [c.chunk_index, c]));
  const materializedFiles = [];

  for (const fileEntry of loaded.manifest.files) {
    const fileChunks = [];
    for (let idx = fileEntry.chunkStart; idx < fileEntry.chunkStart + fileEntry.chunkCount; idx += 1) {
      const rec = chunkByIndex.get(idx);
      const manifestChunk = loaded.manifest.chunks[idx];
      if (!rec || rec.sha256 !== manifestChunk.sha256 || rec.size_bytes !== manifestChunk.sizeBytes) {
        throw factoryError('FILE_TRANSFER_TAMPERED', `Missing or mismatched chunk ${idx}`, 409);
      }
      fileChunks.push({ stagedPath: rec.staged_path, sizeBytes: rec.size_bytes, sha256: rec.sha256 });
    }
    const assembled = await writeVerifiedBundleFile(staging.finalDir, fileEntry.path, fileChunks, fileEntry.sizeBytes, fileEntry.sha256);
    materializedFiles.push({ path: assembled.path, sizeBytes: assembled.sizeBytes, sha256: assembled.sha256 });
  }

  const authorizeWrite = async () => {
    const current = await currentTarget(grantId, principal, 'file.transfer.write');
    if (!current.enabled || current.version !== g.version || Date.parse(current.expiresAt) <= Date.now()) {
      throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Target authorization changed', 403);
    }
    const session = await getSession(g.sessionId);
    if (!session?.id || session.archived) {
      throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Target session unavailable', 403);
    }
    return session;
  };

  const session = await authorizeWrite();
  let publishedRoot = staging.finalDir;
  if (g.targetRoot) {
    const verifiedTargetDir = await resolveSessionContainedPath(session, g.targetRoot, { mustExist: false, expectDir: true });
    await mkdir(verifiedTargetDir, { recursive: true, mode: 0o700 });
    for (const fileEntry of loaded.manifest.files) {
      const fileChunks = [];
      for (let idx = fileEntry.chunkStart; idx < fileEntry.chunkStart + fileEntry.chunkCount; idx += 1) {
        const rec = chunkByIndex.get(idx);
        fileChunks.push({ stagedPath: rec.staged_path, sizeBytes: rec.size_bytes, sha256: rec.sha256 });
      }
      await writeVerifiedBundleFile(verifiedTargetDir, fileEntry.path, fileChunks, fileEntry.sizeBytes, fileEntry.sha256);
    }
    publishedRoot = verifiedTargetDir;
  }

  let targetAssetId = null;
  if (g.transferMode === 'chunked_file' && loaded.manifest.files.length === 1 && loaded.manifest.totalBytes <= MAX_MANIFEST_TOTAL_BYTES) {
    const fileEntry = loaded.manifest.files[0];
    const finalFile = join(staging.finalDir, ...fileEntry.path.split('/'));
    const intent = await createFileAssetUploadIntent({
      sessionId: g.sessionId,
      originalName: g.filename,
      mimeType: g.mime,
      sizeBytes: fileEntry.sizeBytes,
      sha256: fileEntry.sha256,
      requestId: transferId,
      principalScope: `remote-file:${grantId}`,
      forceLocal: true,
      authorize: authorizeWrite,
    });
    targetAssetId = intent.asset.id;
    if (!intent.duplicate) {
      await ingestFileAssetUpload(targetAssetId, createReadStream(finalFile), { authorize: authorizeWrite });
    }
    await finalizeFileAssetUpload(targetAssetId, { sizeBytes: fileEntry.sizeBytes, authorize: authorizeWrite });
  }

  return factoryTransaction((db) => {
    schema(db);
    const current = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
    if (!active(current) || current.version !== g.version) {
      throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Target authorization revoked during finalization', 403);
    }
    db.prepare(`
      UPDATE remote_file_transfers
      SET status='received', target_asset_id=?, received_bytes=?, target_root=?, materialized_json=?, updated_at=?
      WHERE grant_id=? AND transfer_id=?
    `).run(targetAssetId, loaded.manifest.totalBytes, publishedRoot, JSON.stringify(materializedFiles), now(), grantId, transferId);
    const updated = db.prepare('SELECT * FROM remote_file_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId);
    return formatManifestReceipt(updated, loaded.manifest, loaded.chunks);
  });
}

export async function receiveRemoteFile(input, principal) {
  if (process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED !== '1') {
    throw factoryError('REMOTE_FILE_TRANSFER_DISABLED', 'Remote file transfer is disabled', 503);
  }
  const action = text(input?.action);
  if (action === 'init_manifest') return receiveRemoteManifestInit(input, principal);
  if (action === 'upload_chunk') return receiveRemoteFileChunk(input, principal);
  if (action === 'finalize_manifest') return finalizeRemoteManifestTransfer(input, principal);
  if (action && action !== 'single_file') {
    throw factoryError('FILE_TRANSFER_INVALID', `Unsupported transfer action: ${action}`, 400);
  }

  const grantId = id(input?.grantId);
  const transferId = id(input?.transferId);
  const g = await currentTarget(grantId, principal, 'file.transfer.write');
  if (g.transferMode !== 'single_file') {
    throw factoryError('FILE_TRANSFER_INVALID', 'Grant requires manifest-backed chunked transfer', 400);
  }
  const canonical = {
    grantId,
    transferId,
    sourceGrantId: id(input.sourceGrantId),
    sourceVersion: input.sourceVersion,
    targetVersion: input.targetVersion,
    sha256: text(input.sha256),
    sizeBytes: input.sizeBytes,
    bytes: text(input.bytes),
  };
  const bytes = Buffer.from(canonical.bytes, 'base64');
  if (!g.enabled || Date.parse(g.expiresAt) <= Date.now()
      || canonical.targetVersion !== g.version || canonical.sourceGrantId !== g.peerGrantId
      || canonical.sourceVersion !== g.peerVersion || canonical.sha256 !== g.sha256
      || canonical.sizeBytes !== g.sizeBytes || bytes.length !== g.sizeBytes || hash(bytes) !== g.sha256) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Transfer scope changed', 403);
  }
  verifyPeerSignature('ragent-file-transfer-v1', canonical, g.peerKey, input.signature);

  const payloadDigest = hash(JSON.stringify(canonical));
  const claimed = await factoryTransaction((db) => {
    schema(db);
    const row = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
    const old = db.prepare('SELECT * FROM remote_file_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId);
    if (!active(row) || row.version !== g.version) throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Target authorization changed', 403);
    if (old) {
      if (old.payload_digest !== payloadDigest) throw factoryError('FILE_TRANSFER_CONFLICT', 'Transfer identity reused', 409);
      return false;
    }
    db.prepare('INSERT INTO remote_file_transfers (grant_id,transfer_id,payload_digest,status,target_asset_id,updated_at,scope_json) VALUES(?,?,?,?,?,?,?)')
      .run(grantId, transferId, payloadDigest, 'unknown', null, now(), JSON.stringify(g));
    return true;
  });
  if (!claimed) return queryRemoteFile(grantId, transferId, principal, { operation: 'file.transfer.write' });

  const authorize = async () => {
    const current = await currentTarget(grantId, principal, 'file.transfer.write');
    if (!current.enabled || current.version !== g.version || Date.parse(current.expiresAt) <= Date.now()) {
      throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Target authorization changed', 403);
    }
    const session = await getSession(g.sessionId);
    if (!session?.id || session.archived) throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Target session unavailable', 403);
  };
  try {
    await authorize();
    const intent = await createFileAssetUploadIntent({
      sessionId: g.sessionId,
      originalName: g.filename,
      mimeType: g.mime,
      sizeBytes: g.sizeBytes,
      sha256: g.sha256,
      requestId: transferId,
      principalScope: `remote-file:${grantId}`,
      forceLocal: true,
      authorize,
    });
    const assetId = intent.asset.id;
    if (!intent.duplicate) await ingestFileAssetUpload(assetId, Readable.from(bytes), { authorize });
    const result = await finalizeFileAssetUpload(assetId, { sizeBytes: g.sizeBytes, authorize });
    const confirmed = await factoryTransaction((db) => {
      schema(db);
      const current = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
      if (!active(current) || current.version !== g.version) return false;
      db.prepare('UPDATE remote_file_transfers SET status=?,target_asset_id=?,updated_at=? WHERE grant_id=? AND transfer_id=?')
        .run('received', assetId, now(), grantId, transferId);
      return true;
    });
    if (!confirmed) return { grantId, transferId, status: 'unknown' };
    return { grantId, transferId, status: 'received', targetAssetId: result.id, sha256: g.sha256, sizeBytes: g.sizeBytes };
  } catch {
    return { grantId, transferId, status: 'unknown' };
  }
}

export async function queryRemoteFile(grantId, transferId, principal, { operation = 'file.transfer.read' } = {}) {
  grantId = id(grantId);
  transferId = id(transferId);
  principalOk(principal, grantId, operation);

  const state = await factoryRead((db) => {
    schema(db);
    const gRow = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
    const saved = db.prepare('SELECT * FROM remote_file_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId);
    const chunks = saved
      ? db.prepare('SELECT * FROM remote_file_chunk_receipts WHERE grant_id=? AND transfer_id=? ORDER BY chunk_index').all(grantId, transferId)
      : [];
    return { gRow, saved, chunks };
  });

  if (!state.saved) {
    if (state.gRow && state.gRow.role === 'target' && state.gRow.peer_id === principal.sourceInstanceId
        && ['chunked_file', 'directory_bundle'].includes(state.gRow.transfer_mode)) {
      return {
        grantId,
        transferId,
        transferMode: state.gRow.transfer_mode,
        manifestDigest: state.gRow.manifest_digest,
        manifestInitialized: false,
        status: 'not_initialized',
        totalChunks: 0,
        confirmedChunks: [],
        missingChunkIndices: [],
        nextChunkIndex: 0,
        receivedBytes: 0,
        totalBytes: state.gRow.size_bytes,
        fileCount: state.gRow.file_count,
      };
    }
    throw factoryError('FILE_TRANSFER_NOT_FOUND', 'Transfer unavailable', 404);
  }

  let g;
  try { g = JSON.parse(state.saved.scope_json); } catch { return { grantId, transferId, status: 'unknown' }; }
  if (!g || g.id !== grantId || g.role !== 'target' || g.peerId !== principal.sourceInstanceId || !g.sessionId) {
    return { grantId, transferId, status: 'unknown' };
  }

  if (state.saved.transfer_mode && state.saved.transfer_mode !== 'single_file') {
    const manifest = parseJsonSafe(state.saved.manifest_json, null);
    if (!manifest) return { grantId, transferId, status: 'unknown' };
    // Verify staged chunk files actually exist on disk before reporting confirmed.
    const verifiedChunks = [];
    for (const chunk of state.chunks) {
      const info = await lstat(chunk.staged_path).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink() && info.size === chunk.size_bytes) {
        verifiedChunks.push(chunk);
      }
    }
    return formatManifestReceipt(state.saved, manifest, verifiedChunks);
  }

  if (!/^[a-f0-9]{64}$/.test(g.sha256) || !Number.isSafeInteger(g.sizeBytes)) {
    return { grantId, transferId, status: 'unknown' };
  }
  const found = await findFileAssetUploadReceipt({
    sessionId: g.sessionId,
    requestId: transferId,
    principalScope: `remote-file:${grantId}`,
  }).catch(() => null);
  const asset = found?.asset;
  return asset?.status === 'ready' && asset.sha256 === g.sha256 && asset.sizeBytes === g.sizeBytes
    ? { grantId, transferId, status: 'received', targetAssetId: asset.id, sha256: g.sha256, sizeBytes: g.sizeBytes }
    : { grantId, transferId, status: 'unknown' };
}

export async function signRemoteFileReceipt(receipt) {
  const identity = await loadOrCreateInstanceIdentity();
  const body = { targetInstanceId: identity.instanceId, receipt };
  return { ...body, signature: signWithInstanceIdentity(identity, `ragent-file-receipt-v1:${hash(JSON.stringify(body))}`) };
}

function verifyTargetReceiptEnvelope(envelope, grantObj, transferId) {
  const receipt = envelope?.receipt;
  const valid = envelope?.targetInstanceId === grantObj.peerId && verify(
    null,
    Buffer.from(`ragent-file-receipt-v1:${hash(JSON.stringify({ targetInstanceId: envelope.targetInstanceId, receipt }))}`),
    createPublicKey(grantObj.peerKey),
    Buffer.from(text(envelope.signature), 'base64url'),
  );
  if (!valid || receipt?.grantId !== grantObj.peerGrantId || receipt?.transferId !== transferId) {
    throw factoryError('FILE_TRANSFER_RECEIPT_INVALID', 'Invalid target transfer receipt', 502);
  }
  return receipt;
}

async function readChunkFromSourceManifest(grantObj, manifest, chunkIndex) {
  const chunk = manifest.chunks[chunkIndex];
  if (!chunk) throw factoryError('FILE_TRANSFER_INVALID', 'Chunk index out of bounds', 400);
  let targetFilePath;
  if (grantObj.transferMode === 'chunked_file') {
    targetFilePath = grantObj.sourceRoot;
  } else {
    const clean = validateBundleRelativePath(chunk.filePath);
    targetFilePath = join(grantObj.sourceRoot, ...clean.split('/'));
  }
  const info = await lstat(targetFilePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw factoryError('FILE_TRANSFER_SYMLINK_REJECTED', `Source file cannot be a symlink: ${chunk.filePath}`, 400);
  }
  const handle = await open(targetFilePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const buf = Buffer.allocUnsafe(chunk.sizeBytes);
    let readTotal = 0;
    while (readTotal < chunk.sizeBytes) {
      const res = await handle.read(buf, readTotal, chunk.sizeBytes - readTotal, chunk.fileOffset + readTotal);
      if (!res.bytesRead) throw factoryError('FILE_TRANSFER_CONFLICT', 'Source file truncated before chunk read', 409);
      readTotal += res.bytesRead;
    }
    if (hash(buf) !== chunk.sha256) {
      throw factoryError('FILE_TRANSFER_CONFLICT', `Source file modified since manifest creation: ${chunk.filePath}`, 409);
    }
    return buf;
  } finally {
    await handle.close();
  }
}

async function readTargetSummaryRevision(peerId, proxyImpl = proxyToTarget) {
  const summaryId = `summary_${randomUUID()}`;
  const summary = await proxyImpl({
    targetId: peerId,
    requestId: summaryId,
    idempotencyKey: summaryId,
    method: 'GET',
    path: '/api/runtime/summary',
    operation: 'runtime.summary',
    resourceId: peerId,
    expectedRevision: 0,
  });
  if (!summary.response.ok) throw new Error('Target summary unavailable');
  const revision = Number(JSON.parse(summary.body.toString('utf8'))?.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Target revision invalid');
  return revision;
}

async function runManifestUploadLoop(g, transferId, actor, manifest, { proxyImpl = proxyToTarget, stopAfterChunks = null, failOnAction = null } = {}) {
  const identity = await loadOrCreateInstanceIdentity();
  const targetPath = `/api/remote-files/grants/${g.peerGrantId}/transfers/${transferId}`;

  const getSourceTransfer = () => factoryRead((db) => {
    schema(db);
    return {
      row: db.prepare('SELECT * FROM remote_file_source_transfers WHERE grant_id=? AND transfer_id=?').get(g.id, transferId),
      chunks: db.prepare('SELECT * FROM remote_file_source_chunks WHERE grant_id=? AND transfer_id=? ORDER BY chunk_index').all(g.id, transferId),
    };
  });

  const checkSourceActive = async () => {
    const latest = await factoryRead((db) => { schema(db); return db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(g.id); });
    const session = await getSession(g.sessionId);
    if (!active(latest) || latest.version !== g.version || !session?.id || session.archived) {
      throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Source authorization or session changed', 403);
    }
  };

  let state = await getSourceTransfer();
  if (!state.row.manifest_initialized) {
    await checkSourceActive();
    await factoryTransaction((db) => {
      schema(db);
      db.prepare("UPDATE remote_file_source_transfers SET status='unknown_outcome', unknown_reason='init_unconfirmed', updated_at=? WHERE grant_id=? AND transfer_id=?")
        .run(now(), g.id, transferId);
    });
    const initCanonical = {
      action: 'init_manifest',
      grantId: g.peerGrantId,
      transferId,
      sourceGrantId: g.id,
      sourceVersion: g.version,
      targetVersion: g.peerVersion,
      transferMode: g.transferMode,
      manifestDigest: g.manifestDigest,
      sizeBytes: g.sizeBytes,
      fileCount: g.fileCount,
      chunkBytes: g.chunkBytes,
      manifest,
    };
    const initSig = signWithInstanceIdentity(identity, `ragent-file-manifest-v1:${hash(JSON.stringify(initCanonical))}`);
    try {
      const revision = await readTargetSummaryRevision(g.peerId, proxyImpl);
      if (failOnAction === 'init_manifest') throw new Error('Simulated init drop');
      const { response, body } = await proxyImpl({
        targetId: g.peerId,
        requestId: `file_init_${randomUUID()}`,
        idempotencyKey: `${transferId}_init_${randomUUID().slice(0, 8)}`,
        method: 'POST',
        path: targetPath,
        operation: 'file.transfer.write',
        resourceId: g.peerGrantId,
        expectedRevision: revision,
        body: JSON.stringify({ ...initCanonical, signature: initSig }),
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) throw new Error('Target manifest init rejected');
      const receipt = verifyTargetReceiptEnvelope(JSON.parse(body.toString('utf8')), g, transferId);
      if (receipt.manifestDigest !== g.manifestDigest) throw new Error('Target manifest receipt mismatch');
      await factoryTransaction((db) => {
        schema(db);
        const ts = now();
        for (const idx of receipt.confirmedChunks || []) {
          db.prepare("UPDATE remote_file_source_chunks SET status='confirmed', updated_at=? WHERE grant_id=? AND transfer_id=? AND chunk_index=?")
            .run(ts, g.id, transferId, idx);
        }
        db.prepare(`
          UPDATE remote_file_source_transfers
          SET status=?, manifest_initialized=1, confirmed_chunks_json=?, unknown_reason=NULL, receipt_json=?, updated_at=?
          WHERE grant_id=? AND transfer_id=?
        `).run(receipt.status === 'received' ? 'received' : 'uploading', JSON.stringify(receipt.confirmedChunks || []), JSON.stringify(receipt), ts, g.id, transferId);
      });
      if (receipt.status === 'received') return receipt;
    } catch {
      return {
        grantId: g.id,
        transferId,
        transferMode: g.transferMode,
        manifestDigest: g.manifestDigest,
        status: 'unknown_outcome',
        reason: 'reconcile_required',
        unknownReason: 'init_unconfirmed',
        confirmedChunks: [],
      };
    }
    state = await getSourceTransfer();
  }

  let uploadedInCall = 0;
  for (const chunkRec of state.chunks) {
    if (chunkRec.status === 'confirmed') continue;
    if (Number.isInteger(stopAfterChunks) && uploadedInCall >= stopAfterChunks) {
      const current = await getSourceTransfer();
      const confirmedChunks = current.chunks.filter((c) => c.status === 'confirmed').map((c) => c.chunk_index);
      await factoryTransaction((db) => {
        schema(db);
        db.prepare("UPDATE remote_file_source_transfers SET status='resumable', unknown_reason=NULL, updated_at=? WHERE grant_id=? AND transfer_id=?")
          .run(now(), g.id, transferId);
      });
      return {
        grantId: g.id,
        transferId,
        transferMode: g.transferMode,
        manifestDigest: g.manifestDigest,
        status: 'resumable',
        confirmedChunks,
        totalChunks: manifest.chunks.length,
        nextChunkIndex: chunkRec.chunk_index,
      };
    }

    await checkSourceActive();
    const chunkBytes = await readChunkFromSourceManifest(g, manifest, chunkRec.chunk_index);
    const chunkCanonical = {
      action: 'upload_chunk',
      grantId: g.peerGrantId,
      transferId,
      sourceGrantId: g.id,
      sourceVersion: g.version,
      targetVersion: g.peerVersion,
      manifestDigest: g.manifestDigest,
      chunkIndex: chunkRec.chunk_index,
      chunkSha256: chunkRec.sha256,
      chunkSizeBytes: chunkRec.size_bytes,
      bytesBase64: chunkBytes.toString('base64'),
    };
    const chunkSig = signWithInstanceIdentity(identity, `ragent-file-chunk-v1:${hash(JSON.stringify(chunkCanonical))}`);

    await factoryTransaction((db) => {
      schema(db);
      const ts = now();
      db.prepare("UPDATE remote_file_source_chunks SET status='sending_unconfirmed', updated_at=? WHERE grant_id=? AND transfer_id=? AND chunk_index=?")
        .run(ts, g.id, transferId, chunkRec.chunk_index);
      db.prepare("UPDATE remote_file_source_transfers SET status='unknown_outcome', pending_chunk_index=?, unknown_reason='chunk_delivery_unconfirmed', updated_at=? WHERE grant_id=? AND transfer_id=?")
        .run(chunkRec.chunk_index, ts, g.id, transferId);
    });

    try {
      const revision = await readTargetSummaryRevision(g.peerId, proxyImpl);
      if (failOnAction === `chunk_${chunkRec.chunk_index}`) throw new Error('Simulated chunk drop');
      const { response, body } = await proxyImpl({
        targetId: g.peerId,
        requestId: `file_chunk_${chunkRec.chunk_index}_${randomUUID()}`,
        idempotencyKey: `${transferId}_chunk_${chunkRec.chunk_index}_${randomUUID().slice(0, 8)}`,
        method: 'POST',
        path: targetPath,
        operation: 'file.transfer.write',
        resourceId: g.peerGrantId,
        expectedRevision: revision,
        body: JSON.stringify({ ...chunkCanonical, signature: chunkSig }),
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) throw new Error('Target rejected chunk');
      const receipt = verifyTargetReceiptEnvelope(JSON.parse(body.toString('utf8')), g, transferId);
      await factoryTransaction((db) => {
        schema(db);
        const ts = now();
        db.prepare("UPDATE remote_file_source_chunks SET status='confirmed', updated_at=? WHERE grant_id=? AND transfer_id=? AND chunk_index=?")
          .run(ts, g.id, transferId, chunkRec.chunk_index);
        for (const idx of receipt.confirmedChunks || []) {
          db.prepare("UPDATE remote_file_source_chunks SET status='confirmed', updated_at=? WHERE grant_id=? AND transfer_id=? AND chunk_index=?")
            .run(ts, g.id, transferId, idx);
        }
        db.prepare(`
          UPDATE remote_file_source_transfers
          SET status='uploading', pending_chunk_index=NULL, unknown_reason=NULL,
              confirmed_chunks_json=?, receipt_json=?, updated_at=?
          WHERE grant_id=? AND transfer_id=?
        `).run(JSON.stringify(receipt.confirmedChunks || []), JSON.stringify(receipt), ts, g.id, transferId);
      });
      uploadedInCall += 1;
    } catch {
      const latest = await getSourceTransfer();
      const confirmedChunks = latest.chunks.filter((c) => c.status === 'confirmed').map((c) => c.chunk_index);
      return {
        grantId: g.id,
        transferId,
        transferMode: g.transferMode,
        manifestDigest: g.manifestDigest,
        status: 'unknown_outcome',
        reason: 'reconcile_required',
        unknownReason: 'chunk_delivery_unconfirmed',
        pendingChunkIndex: chunkRec.chunk_index,
        confirmedChunks,
      };
    }
  }

  await checkSourceActive();
  await factoryTransaction((db) => {
    schema(db);
    db.prepare("UPDATE remote_file_source_transfers SET status='unknown_outcome', pending_chunk_index=NULL, unknown_reason='finalize_unconfirmed', updated_at=? WHERE grant_id=? AND transfer_id=?")
      .run(now(), g.id, transferId);
  });
  const finalizeCanonical = {
    action: 'finalize_manifest',
    grantId: g.peerGrantId,
    transferId,
    sourceGrantId: g.id,
    sourceVersion: g.version,
    targetVersion: g.peerVersion,
    manifestDigest: g.manifestDigest,
  };
  const finalizeSig = signWithInstanceIdentity(identity, `ragent-file-finalize-v1:${hash(JSON.stringify(finalizeCanonical))}`);
  try {
    const revision = await readTargetSummaryRevision(g.peerId, proxyImpl);
    if (failOnAction === 'finalize_manifest') throw new Error('Simulated finalize drop');
    const { response, body } = await proxyImpl({
      targetId: g.peerId,
      requestId: `file_fin_${randomUUID()}`,
      idempotencyKey: `${transferId}_fin_${randomUUID().slice(0, 8)}`,
      method: 'POST',
      path: targetPath,
      operation: 'file.transfer.write',
      resourceId: g.peerGrantId,
      expectedRevision: revision,
      body: JSON.stringify({ ...finalizeCanonical, signature: finalizeSig }),
      headers: { 'content-type': 'application/json' },
    });
    if (!response.ok) throw new Error('Target finalization failed');
    const receipt = verifyTargetReceiptEnvelope(JSON.parse(body.toString('utf8')), g, transferId);
    if (receipt.status !== 'received' || receipt.manifestDigest !== g.manifestDigest || receipt.totalBytes !== g.sizeBytes) {
      throw new Error('Target receipt verification failed');
    }
    await factoryTransaction((db) => {
      schema(db);
      db.prepare(`
        UPDATE remote_file_source_transfers
        SET status='received', unknown_reason=NULL, receipt_json=?, updated_at=?
        WHERE grant_id=? AND transfer_id=?
      `).run(JSON.stringify(receipt), now(), g.id, transferId);
    });
    return receipt;
  } catch {
    const latest = await getSourceTransfer();
    const confirmedChunks = latest.chunks.filter((c) => c.status === 'confirmed').map((c) => c.chunk_index);
    return {
      grantId: g.id,
      transferId,
      transferMode: g.transferMode,
      manifestDigest: g.manifestDigest,
      status: 'unknown_outcome',
      reason: 'reconcile_required',
      unknownReason: 'finalize_unconfirmed',
      confirmedChunks,
    };
  }
}

export async function sendRemoteManifestTransfer(grantId, transferId, actor, options = {}) {
  if (process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED !== '1') {
    throw factoryError('REMOTE_FILE_TRANSFER_DISABLED', 'Remote file transfer is disabled', 503);
  }
  grantId = id(grantId);
  transferId = id(transferId);
  const row = await factoryRead((db) => {
    schema(db);
    return db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
  });
  if (!active(row) || row.role !== 'source' || actor?.kind !== 'user' || actor.role !== 'owner' || row.owner_id !== actor.principalId) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Source authorization unavailable', 403);
  }
  const g = grant(row);
  if (g.transferMode === 'single_file') {
    throw factoryError('FILE_TRANSFER_INVALID', 'Grant is single_file; use sendRemoteFile', 400);
  }
  const session = await getSession(g.sessionId);
  if (!session?.id || session.archived) {
    throw factoryError('FILE_TRANSFER_CONFLICT', 'Source session unavailable', 409);
  }

  const built = await buildRemoteTransferManifest({
    transferMode: g.transferMode,
    ...(g.assetId ? { assetId: g.assetId } : { sourcePath: g.sourceRoot }),
    sessionId: g.sessionId,
    bundleName: g.filename,
    chunkBytes: g.chunkBytes,
    allowedPaths: g.allowedPaths,
  });
  if (built.manifestDigest !== g.manifestDigest || built.manifest.totalBytes !== g.sizeBytes || built.manifest.fileCount !== g.fileCount) {
    throw factoryError('FILE_TRANSFER_CONFLICT', 'Source payload changed since grant configuration', 409);
  }

  const existing = await factoryTransaction((db) => {
    schema(db);
    const still = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
    if (!active(still) || still.version !== g.version) throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Source authorization changed', 403);
    const old = db.prepare('SELECT * FROM remote_file_source_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId);
    if (old) {
      if (old.payload_digest !== built.manifestDigest) throw factoryError('FILE_TRANSFER_CONFLICT', 'Transfer identity reused', 409);
      const chunks = db.prepare('SELECT * FROM remote_file_source_chunks WHERE grant_id=? AND transfer_id=? ORDER BY chunk_index').all(grantId, transferId);
      return {
        exists: true,
        status: old.status,
        pendingChunkIndex: old.pending_chunk_index,
        unknownReason: old.unknown_reason,
        receipt: parseJsonSafe(old.receipt_json, null),
        confirmedChunks: chunks.filter((c) => c.status === 'confirmed').map((c) => c.chunk_index),
      };
    }
    const ts = now();
    db.prepare(`
      INSERT INTO remote_file_source_transfers (
        grant_id, transfer_id, payload_digest, status, receipt_json, updated_at, scope_json,
        transfer_mode, manifest_digest, manifest_json, total_chunks, confirmed_chunks_json, manifest_initialized
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      grantId, transferId, built.manifestDigest, 'unknown_outcome', null, ts, JSON.stringify(g),
      g.transferMode, built.manifestDigest, JSON.stringify(built.manifest), built.manifest.chunks.length, '[]', 0,
    );
    for (const chunk of built.manifest.chunks) {
      db.prepare(`
        INSERT INTO remote_file_source_chunks (grant_id, transfer_id, chunk_index, sha256, size_bytes, status, updated_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(grantId, transferId, chunk.index, chunk.sha256, chunk.sizeBytes, 'pending', ts);
    }
    return { exists: false };
  });

  if (existing.exists) {
    if (existing.status === 'received' && existing.receipt) return existing.receipt;
    if (existing.status !== 'resumable') {
      // Never blindly resend an unknown_outcome / unconfirmed transfer!
      return {
        grantId,
        transferId,
        transferMode: g.transferMode,
        manifestDigest: g.manifestDigest,
        status: 'unknown_outcome',
        reason: 'reconcile_required',
        unknownReason: existing.unknownReason || 'reconcile_required',
        pendingChunkIndex: existing.pendingChunkIndex ?? null,
        confirmedChunks: existing.confirmedChunks,
        replayForbidden: true,
      };
    }
  }

  return runManifestUploadLoop(g, transferId, actor, built.manifest, options);
}

export async function resumeRemoteManifestTransfer(grantId, transferId, actor, options = {}) {
  if (process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED !== '1') {
    throw factoryError('REMOTE_FILE_TRANSFER_DISABLED', 'Remote file transfer is disabled', 503);
  }
  grantId = id(grantId);
  transferId = id(transferId);
  if (options.reconcileFirst === true) {
    const rec = await reconcileRemoteFileTransfer(grantId, transferId, actor, options);
    if (rec.status === 'received') return rec;
    if (rec.status !== 'resumable') return rec;
  }
  const data = await factoryRead((db) => {
    schema(db);
    const row = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
    const saved = db.prepare('SELECT * FROM remote_file_source_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId);
    const chunks = saved
      ? db.prepare('SELECT * FROM remote_file_source_chunks WHERE grant_id=? AND transfer_id=? ORDER BY chunk_index').all(grantId, transferId)
      : [];
    return { row, saved, chunks };
  });
  if (!active(data.row) || data.row.role !== 'source' || actor?.kind !== 'user' || actor.role !== 'owner' || data.row.owner_id !== actor.principalId) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Source authorization unavailable', 403);
  }
  if (!data.saved) throw factoryError('FILE_TRANSFER_NOT_FOUND', 'Transfer not found', 404);
  if (data.saved.status === 'received') return parseJsonSafe(data.saved.receipt_json, { grantId, transferId, status: 'received' });
  if (['unknown_outcome', 'unknown'].includes(data.saved.status)) {
    return {
      grantId,
      transferId,
      transferMode: data.saved.transfer_mode,
      manifestDigest: data.saved.manifest_digest,
      status: 'unknown_outcome',
      reason: 'reconcile_required',
      unknownReason: data.saved.unknown_reason || 'reconcile_required',
      pendingChunkIndex: data.saved.pending_chunk_index ?? null,
      confirmedChunks: data.chunks.filter((c) => c.status === 'confirmed').map((c) => c.chunk_index),
      replayForbidden: true,
    };
  }
  const g = grant(data.row);
  const manifest = parseJsonSafe(data.saved.manifest_json, null);
  if (!manifest) throw factoryError('FILE_TRANSFER_CONFLICT', 'Stored source manifest invalid', 409);
  return runManifestUploadLoop(g, transferId, actor, manifest, options);
}

export async function reconcileRemoteFileTransfer(grantId, transferId, actor, { proxyImpl = proxyToTarget } = {}) {
  grantId = id(grantId);
  transferId = id(transferId);
  const data = await factoryRead((db) => {
    schema(db);
    return {
      row: db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId),
      saved: db.prepare('SELECT * FROM remote_file_source_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId),
      chunks: db.prepare('SELECT * FROM remote_file_source_chunks WHERE grant_id=? AND transfer_id=? ORDER BY chunk_index').all(grantId, transferId),
    };
  });
  if (!data.row || !data.saved || data.row.role !== 'source'
      || actor?.kind !== 'user' || actor.role !== 'owner' || data.row.owner_id !== actor.principalId) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Source owner required', 403);
  }

  let g;
  try { g = JSON.parse(data.saved.scope_json); } catch { return { grantId, transferId, status: 'unknown_outcome' }; }
  if (!g || g.id !== grantId || g.role !== 'source' || g.ownerId !== actor.principalId || !validKey(g.peerKey, g.peerId)) {
    return { grantId, transferId, status: 'unknown_outcome' };
  }
  if (g.transferMode === 'single_file') {
    return queryRemoteFileFromSource(grantId, transferId, actor, { proxyImpl });
  }

  const path = `/api/remote-files/grants/${g.peerGrantId}/transfers/${transferId}`;
  const requestId = `file_reconcile_${randomUUID()}`;
  try {
    const { response, body } = await proxyImpl({
      targetId: g.peerId,
      requestId,
      idempotencyKey: requestId,
      method: 'GET',
      path,
      operation: 'file.transfer.read',
      resourceId: g.peerGrantId,
      expectedRevision: 0,
    });
    if (!response.ok) throw new Error('Target status unavailable');
    const envelope = JSON.parse(body.toString('utf8'));
    const receipt = verifyTargetReceiptEnvelope(envelope, g, transferId);
    if (receipt.manifestDigest !== g.manifestDigest) throw new Error('Manifest digest mismatch');

    const manifest = parseJsonSafe(data.saved.manifest_json, { chunks: [] });
    const ts = now();

    if (receipt.status === 'received') {
      if (receipt.totalBytes !== g.sizeBytes || receipt.fileCount !== g.fileCount) throw new Error('Receipt size/file mismatch');
      await factoryTransaction((db) => {
        schema(db);
        db.prepare("UPDATE remote_file_source_chunks SET status='confirmed', updated_at=? WHERE grant_id=? AND transfer_id=?")
          .run(ts, grantId, transferId);
        db.prepare(`
          UPDATE remote_file_source_transfers
          SET status='received', manifest_initialized=1, pending_chunk_index=NULL, unknown_reason=NULL,
              confirmed_chunks_json=?, receipt_json=?, updated_at=?
          WHERE grant_id=? AND transfer_id=?
        `).run(JSON.stringify(receipt.confirmedChunks || []), JSON.stringify(receipt), ts, grantId, transferId);
      });
      return { ...receipt, reconciled: true, blindResendAvoided: true };
    }

    if (receipt.status === 'not_initialized') {
      await factoryTransaction((db) => {
        schema(db);
        db.prepare("UPDATE remote_file_source_chunks SET status='pending', updated_at=? WHERE grant_id=? AND transfer_id=?")
          .run(ts, grantId, transferId);
        db.prepare(`
          UPDATE remote_file_source_transfers
          SET status='resumable', manifest_initialized=0, pending_chunk_index=NULL, unknown_reason=NULL,
              confirmed_chunks_json='[]', receipt_json=?, updated_at=?
          WHERE grant_id=? AND transfer_id=?
        `).run(JSON.stringify(receipt), ts, grantId, transferId);
      });
      return {
        grantId,
        transferId,
        transferMode: g.transferMode,
        manifestDigest: g.manifestDigest,
        status: 'resumable',
        manifestInitialized: false,
        totalChunks: manifest.chunks.length,
        confirmedChunks: [],
        missingChunkIndices: manifest.chunks.map((c) => c.index),
        nextChunkIndex: 0,
        reconciled: true,
        blindResendAvoided: true,
      };
    }

    if (receipt.status === 'uploading') {
      const confirmedSet = new Set(Array.isArray(receipt.confirmedChunks) ? receipt.confirmedChunks : []);
      await factoryTransaction((db) => {
        schema(db);
        const rows = db.prepare('SELECT chunk_index FROM remote_file_source_chunks WHERE grant_id=? AND transfer_id=?').all(grantId, transferId);
        for (const r of rows) {
          const nextChunkStatus = confirmedSet.has(r.chunk_index) ? 'confirmed' : 'pending';
          db.prepare('UPDATE remote_file_source_chunks SET status=?, updated_at=? WHERE grant_id=? AND transfer_id=? AND chunk_index=?')
            .run(nextChunkStatus, ts, grantId, transferId, r.chunk_index);
        }
        db.prepare(`
          UPDATE remote_file_source_transfers
          SET status='resumable', manifest_initialized=1, pending_chunk_index=NULL, unknown_reason=NULL,
              confirmed_chunks_json=?, receipt_json=?, updated_at=?
          WHERE grant_id=? AND transfer_id=?
        `).run(JSON.stringify([...confirmedSet].sort((a, b) => a - b)), JSON.stringify(receipt), ts, grantId, transferId);
      });
      return {
        ...receipt,
        grantId,
        transferId,
        status: 'resumable',
        reconciled: true,
        blindResendAvoided: true,
      };
    }

    return { grantId, transferId, status: 'unknown_outcome', reason: 'target_state_unconfirmed' };
  } catch {
    return {
      grantId,
      transferId,
      transferMode: g.transferMode,
      manifestDigest: g.manifestDigest,
      status: 'unknown_outcome',
      reason: 'target_unreachable',
      confirmedChunks: data.chunks.filter((c) => c.status === 'confirmed').map((c) => c.chunk_index),
    };
  }
}

export async function sendRemoteFile(grantId, transferId, actor, options = {}) {
  if (process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED !== '1') {
    throw factoryError('REMOTE_FILE_TRANSFER_DISABLED', 'Remote file transfer is disabled', 503);
  }
  grantId = id(grantId);
  transferId = id(transferId);
  const proxyImpl = options?.proxyImpl || proxyToTarget;
  const row = await factoryRead((db) => {
    schema(db);
    return db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
  });
  if (!active(row) || row.role !== 'source' || actor?.kind !== 'user' || actor.role !== 'owner' || row.owner_id !== actor.principalId) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Source authorization unavailable', 403);
  }
  const g = grant(row);
  if (g.transferMode !== 'single_file') {
    return sendRemoteManifestTransfer(grantId, transferId, actor, options);
  }
  const session = await getSession(g.sessionId);
  const asset = await getFileAsset(g.assetId);
  if (!session?.id || session.archived || !asset || asset.sessionId !== g.sessionId
      || asset.status !== 'ready' || asset.sha256 !== g.sha256 || asset.sizeBytes !== g.sizeBytes) {
    throw factoryError('FILE_TRANSFER_CONFLICT', 'Source session or asset changed', 409);
  }
  const bytes = await readFile(await localizeFileAsset(asset));
  if (bytes.length !== g.sizeBytes || hash(bytes) !== g.sha256) {
    throw factoryError('FILE_TRANSFER_CONFLICT', 'Source bytes changed', 409);
  }
  const identity = await loadOrCreateInstanceIdentity();
  const canonical = {
    grantId: g.peerGrantId,
    transferId,
    sourceGrantId: g.id,
    sourceVersion: g.version,
    targetVersion: g.peerVersion,
    sha256: g.sha256,
    sizeBytes: g.sizeBytes,
    bytes: bytes.toString('base64'),
  };
  const payloadDigest = hash(JSON.stringify(canonical));
  const claimed = await factoryTransaction((db) => {
    schema(db);
    const still = db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);
    const old = db.prepare('SELECT * FROM remote_file_source_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId);
    if (old) {
      if (old.payload_digest !== payloadDigest) throw factoryError('FILE_TRANSFER_CONFLICT', 'Transfer identity reused', 409);
      return false;
    }
    if (!active(still) || still.version !== g.version) throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Source authorization changed', 403);
    db.prepare('INSERT INTO remote_file_source_transfers (grant_id,transfer_id,payload_digest,status,receipt_json,updated_at,scope_json) VALUES(?,?,?,?,?,?,?)')
      .run(grantId, transferId, payloadDigest, 'unknown', null, now(), JSON.stringify(g));
    return true;
  });
  if (!claimed) return { grantId, transferId, status: 'unknown', reason: 'query_required' };
  const signature = signWithInstanceIdentity(identity, `ragent-file-transfer-v1:${hash(JSON.stringify(canonical))}`);
  const path = `/api/remote-files/grants/${g.peerGrantId}/transfers/${transferId}`;
  const requestId = `file_${randomUUID()}`;
  try {
    const revision = await readTargetSummaryRevision(g.peerId, proxyImpl);
    const latest = await factoryRead((db) => { schema(db); return db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId); });
    const currentSession = await getSession(g.sessionId);
    const currentAsset = await getFileAsset(g.assetId);
    if (!active(latest) || latest.version !== g.version || !currentSession?.id || currentSession.archived
        || !currentAsset || currentAsset.status !== 'ready' || currentAsset.sessionId !== g.sessionId
        || currentAsset.sha256 !== g.sha256 || currentAsset.sizeBytes !== g.sizeBytes) {
      throw new Error('Source authorization, session or asset changed');
    }
    const { response, body } = await proxyImpl({
      targetId: g.peerId,
      requestId,
      idempotencyKey: transferId,
      method: 'POST',
      path,
      operation: 'file.transfer.write',
      resourceId: g.peerGrantId,
      expectedRevision: revision,
      body: JSON.stringify({ ...canonical, signature }),
      headers: { 'content-type': 'application/json' },
    });
    if (!response.ok) throw new Error();
    const envelope = JSON.parse(body.toString('utf8'));
    const receipt = envelope?.receipt;
    const valid = envelope?.targetInstanceId === g.peerId && verify(
      null,
      Buffer.from(`ragent-file-receipt-v1:${hash(JSON.stringify({ targetInstanceId: envelope.targetInstanceId, receipt }))}`),
      createPublicKey(g.peerKey),
      Buffer.from(text(envelope.signature), 'base64url'),
    );
    if (!valid || receipt?.grantId !== g.peerGrantId || receipt?.transferId !== transferId
        || receipt?.sha256 !== g.sha256 || receipt?.sizeBytes !== g.sizeBytes) {
      throw new Error();
    }
    await factoryTransaction((db) => {
      schema(db);
      db.prepare('UPDATE remote_file_source_transfers SET status=?,receipt_json=?,updated_at=? WHERE grant_id=? AND transfer_id=?')
        .run(receipt.status, JSON.stringify(receipt), now(), grantId, transferId);
    });
    return receipt;
  } catch {
    return { grantId, transferId, status: 'unknown' };
  }
}

export async function queryRemoteFileFromSource(grantId, transferId, actor, { proxyImpl = proxyToTarget } = {}) {
  grantId = id(grantId);
  transferId = id(transferId);
  const data = await factoryRead((db) => {
    schema(db);
    return {
      row: db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId),
      saved: db.prepare('SELECT * FROM remote_file_source_transfers WHERE grant_id=? AND transfer_id=?').get(grantId, transferId),
      chunks: db.prepare('SELECT * FROM remote_file_source_chunks WHERE grant_id=? AND transfer_id=? ORDER BY chunk_index').all(grantId, transferId),
    };
  });
  if (!data.row || !data.saved || data.row.role !== 'source'
      || actor?.kind !== 'user' || actor.role !== 'owner' || data.row.owner_id !== actor.principalId) {
    throw factoryError('FILE_TRANSFER_FORBIDDEN', 'Source owner required', 403);
  }
  if (data.saved.transfer_mode && data.saved.transfer_mode !== 'single_file') {
    const manifest = parseJsonSafe(data.saved.manifest_json, { chunks: [] });
    return {
      grantId,
      transferId,
      transferMode: data.saved.transfer_mode,
      manifestDigest: data.saved.manifest_digest,
      status: data.saved.status,
      manifestInitialized: Boolean(data.saved.manifest_initialized),
      pendingChunkIndex: data.saved.pending_chunk_index ?? null,
      unknownReason: data.saved.unknown_reason || null,
      totalChunks: data.saved.total_chunks || manifest.chunks.length,
      confirmedChunks: data.chunks.filter((c) => c.status === 'confirmed').map((c) => c.chunk_index),
      receipt: parseJsonSafe(data.saved.receipt_json, null),
    };
  }

  let g;
  try { g = JSON.parse(data.saved.scope_json); } catch { return { grantId, transferId, status: 'unknown' }; }
  if (!g || g.id !== grantId || g.role !== 'source' || g.ownerId !== actor.principalId || !validKey(g.peerKey, g.peerId)) {
    return { grantId, transferId, status: 'unknown' };
  }
  const path = `/api/remote-files/grants/${g.peerGrantId}/transfers/${transferId}`;
  const requestId = `file_read_${randomUUID()}`;
  try {
    const { response, body } = await proxyImpl({
      targetId: g.peerId,
      requestId,
      idempotencyKey: requestId,
      method: 'GET',
      path,
      operation: 'file.transfer.read',
      resourceId: g.peerGrantId,
      expectedRevision: 0,
    });
    if (!response.ok) throw new Error();
    const envelope = JSON.parse(body.toString('utf8'));
    const receipt = envelope?.receipt;
    const valid = envelope?.targetInstanceId === g.peerId && verify(
      null,
      Buffer.from(`ragent-file-receipt-v1:${hash(JSON.stringify({ targetInstanceId: envelope.targetInstanceId, receipt }))}`),
      createPublicKey(g.peerKey),
      Buffer.from(text(envelope.signature), 'base64url'),
    );
    if (!valid || receipt?.grantId !== g.peerGrantId || receipt?.transferId !== transferId
        || (receipt.status === 'received' && (receipt.sha256 !== g.sha256 || receipt.sizeBytes !== g.sizeBytes))) {
      throw new Error();
    }
    await factoryTransaction((db) => {
      schema(db);
      db.prepare('UPDATE remote_file_source_transfers SET status=?,receipt_json=?,updated_at=? WHERE grant_id=? AND transfer_id=?')
        .run(receipt.status, JSON.stringify(receipt), now(), grantId, transferId);
    });
    return receipt;
  } catch {
    return { grantId, transferId, status: 'unknown' };
  }
}
