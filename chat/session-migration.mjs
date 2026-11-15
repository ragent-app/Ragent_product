import { randomBytes } from 'crypto';
import {
  cp,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from 'fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'path';

import {
  CHAT_FILE_ASSETS_DIR,
  CHAT_HISTORY_DIR,
  CHAT_IMAGES_DIR,
} from '../lib/config.mjs';
import { getFileAsset } from './file-assets.mjs';
import { forEachStoredEvent } from './history.mjs';
import {
  ensureProjectForSessionFolder,
  expandProjectRootPath,
  getProject,
} from './projects.mjs';
import { getRun, isTerminalRunState } from './runs.mjs';
import {
  loadSessionsMeta,
  withSessionsMetaMutation,
} from './session-meta-store.mjs';
import { pathExists, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { SESSION_API_PRIVATE_FIELDS } from './session-api-mutation-contract.mjs';

export const SESSION_MIGRATION_SCHEMA_VERSION = 1;
export const SESSION_MIGRATION_TYPE = 'ragent-selected-session-migration';
const MIGRATION_DIRECTORY = '.ragent-migrations';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/;
const EPHEMERAL_SESSION_FIELDS = [
  'activeRunId',
  'lastAuthRecovery',
  'followUpQueue',
  'pendingPlanningQueue',
  'pendingDispatchQueue',
  'queuedMessages',
  'claudeSessionId',
  'codexThreadId',
  'codexThreadModel',
  'codexThreadEffort',
  'codexThreadServiceTier',
  'providerContext',
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createMigrationError(message, code, statusCode = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function createMigrationId() {
  return `smig_${randomBytes(12).toString('hex')}`;
}

function normalizeSessionId(value) {
  const normalized = trimString(value);
  return SESSION_ID_PATTERN.test(normalized) ? normalized : '';
}

function normalizeSessionIds(value) {
  if (!Array.isArray(value)) {
    throw createMigrationError('sessionIds must be an array', 'SESSION_IDS_INVALID');
  }
  const ids = [];
  const seen = new Set();
  for (const entry of value) {
    const id = normalizeSessionId(entry);
    if (!id) {
      throw createMigrationError('sessionIds contains an invalid session id', 'SESSION_ID_INVALID');
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) {
    throw createMigrationError('Select at least one session', 'SESSION_IDS_REQUIRED');
  }
  return ids;
}

function isHiddenSession(meta) {
  return !meta
    || meta.sourceId === 'maintenance'
    || !!trimString(meta.internalRole)
    || !!trimString(meta.compactsSessionId)
    || !!trimString(meta.visitorId)
    || meta.projectDetached === true;
}

function sessionBelongsToProject(meta, project) {
  if (isHiddenSession(meta)) return false;
  if (trimString(meta.projectId)) return meta.projectId === project.id;
  return trimString(meta.folder) !== ''
    && expandProjectRootPath(meta.folder) === project.rootPath;
}

async function isSessionRunning(meta) {
  const runId = trimString(meta?.activeRunId);
  if (!runId) return false;
  const run = await getRun(runId);
  return !!run && !isTerminalRunState(run.state);
}

function isPathWithin(parentPath, childPath) {
  const relativePath = relative(resolve(parentPath), resolve(childPath));
  return relativePath === ''
    || (!relativePath.startsWith('..')
      && !isAbsolute(relativePath));
}

function assertSafeBundleRelativePath(value) {
  const normalized = trimString(value);
  if (!normalized || isAbsolute(normalized) || normalized.includes('\\')) {
    throw createMigrationError('Migration manifest contains an unsafe path', 'MIGRATION_PATH_INVALID', 400, {
      path: value,
    });
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw createMigrationError('Migration manifest contains an unsafe path', 'MIGRATION_PATH_INVALID', 400, {
      path: value,
    });
  }
  return normalized;
}

function resolveBundleEntry(bundlePath, relativePath) {
  const safePath = assertSafeBundleRelativePath(relativePath);
  const resolvedPath = resolve(bundlePath, safePath);
  if (!isPathWithin(bundlePath, resolvedPath)) {
    throw createMigrationError('Migration manifest path escapes the bundle', 'MIGRATION_PATH_INVALID');
  }
  return resolvedPath;
}

async function copyTree(sourcePath, destinationPath, options = {}) {
  await cp(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    filter: options.filter,
  });
}

async function walkFiles(rootPath, visitor) {
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(entryPath, visitor);
    } else if (entry.isFile()) {
      await visitor(entryPath);
    }
  }
}

function collectAttachmentReferences(value, references, sessionId) {
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentReferences(item, references, sessionId);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const assetId = trimString(value.assetId);
  if (assetId) {
    const current = references.assets.get(assetId) || new Set();
    current.add(sessionId);
    references.assets.set(assetId, current);
  }
  const filename = basename(trimString(value.filename));
  if (!assetId && filename && SAFE_FILENAME_PATTERN.test(filename)) references.images.add(filename);
  for (const child of Object.values(value)) {
    collectAttachmentReferences(child, references, sessionId);
  }
}

async function copyReferencedAssets(bundlePath, references, manifestAssets, warnings) {
  const imageRoot = join(bundlePath, 'images');
  for (const filename of references.images) {
    const sourcePath = join(CHAT_IMAGES_DIR, filename);
    if (!await pathExists(sourcePath)) {
      warnings.push({ type: 'missing_image', filename });
      continue;
    }
    await mkdir(imageRoot, { recursive: true });
    await copyTree(sourcePath, join(imageRoot, filename));
  }

  for (const [assetId, sessionIds] of references.assets) {
    const recordPath = join(CHAT_FILE_ASSETS_DIR, `${assetId}.json`);
    const record = await getFileAsset(assetId);
    if (!record || !await pathExists(recordPath)) {
      warnings.push({ type: 'missing_file_asset', assetId });
      continue;
    }
    const entry = {
      id: assetId,
      sessionIds: [...sessionIds],
      recordPath: `file-assets/${assetId}.json`,
    };
    const recordDestination = join(bundlePath, entry.recordPath);
    await mkdir(dirname(recordDestination), { recursive: true });
    await copyTree(recordPath, recordDestination);

    if (record.storage?.provider === 'local' || trimString(record.localizedPath)) {
      const localFilename = basename(
        trimString(record.storage.localFilename) || trimString(record.localizedPath),
      );
      if (localFilename && SAFE_FILENAME_PATTERN.test(localFilename)) {
        const objectSource = trimString(record.localizedPath)
          || join(CHAT_FILE_ASSETS_DIR, 'objects', localFilename);
        if (await pathExists(objectSource)) {
          const objectPath = `file-assets/objects/${localFilename}`;
          await mkdir(dirname(join(bundlePath, objectPath)), { recursive: true });
          await copyTree(objectSource, join(bundlePath, objectPath));
          entry.localObjectPath = objectPath;
          entry.localFilename = localFilename;
        } else {
          warnings.push({ type: 'missing_file_asset_object', assetId, localFilename });
        }
      }
    }
    manifestAssets.push(entry);
  }
}

function normalizeImportedSessionMeta(meta, project) {
  const normalized = { ...(meta || {}) };
  for (const field of [...EPHEMERAL_SESSION_FIELDS, ...SESSION_API_PRIVATE_FIELDS]) delete normalized[field];
  normalized.id = trimString(meta?.id);
  normalized.projectId = project.id;
  normalized.folder = project.rootPath;
  delete normalized.projectDetached;
  delete normalized.compactsSessionId;
  return normalized;
}

function rewritePathValue(value, { sourceRootPath, targetRootPath, imageFiles, localAssetFiles }) {
  const raw = trimString(value);
  if (!raw) return raw;
  const resolved = isAbsolute(raw) ? resolve(raw) : '';
  if (resolved && isPathWithin(sourceRootPath, resolved)) {
    return join(targetRootPath, relative(sourceRootPath, resolved));
  }
  const filename = basename(raw);
  if (imageFiles.has(filename)) return join(CHAT_IMAGES_DIR, filename);
  if (localAssetFiles.has(filename)) return join(CHAT_FILE_ASSETS_DIR, 'objects', filename);
  return raw;
}

function rewriteImportedValue(value, context) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const result = rewriteImportedValue(entry, context);
      changed = changed || result.changed;
      return result.value;
    });
    return { value: next, changed };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };

  let changed = false;
  const next = { ...value };
  if (trimString(next.assetId) && context.assetIds.has(trimString(next.assetId)) && 'savedPath' in next) {
    delete next.savedPath;
    changed = true;
  } else if (typeof next.savedPath === 'string') {
    const rewritten = rewritePathValue(next.savedPath, context);
    if (rewritten !== next.savedPath) {
      next.savedPath = rewritten;
      changed = true;
    }
  }
  for (const [key, child] of Object.entries(next)) {
    if (key === 'savedPath') continue;
    const result = rewriteImportedValue(child, context);
    if (result.changed) {
      next[key] = result.value;
      changed = true;
    }
  }
  if (typeof next.filePath === 'string') {
    const rewritten = rewritePathValue(next.filePath, context);
    if (rewritten !== next.filePath) {
      next.filePath = rewritten;
      changed = true;
    }
  }
  return { value: next, changed };
}

async function rewriteImportedHistory(historyRoot, context) {
  await walkFiles(historyRoot, async (filepath) => {
    if (!filepath.endsWith('.json')) return;
    const raw = await readJson(filepath, null);
    if (!raw || typeof raw !== 'object') return;
    const rewritten = rewriteImportedValue(raw, context);
    if (rewritten.changed) await writeJsonAtomic(filepath, rewritten.value);
  });
}

function buildImportableAssetRecord(rawRecord, sessionId, localFilename = '') {
  const record = rawRecord && typeof rawRecord === 'object' ? { ...rawRecord } : {};
  record.sessionId = sessionId;
  delete record.localizedPath;
  delete record.localizedAt;
  if (record.storage && typeof record.storage === 'object') {
    record.storage = { ...record.storage };
    if (localFilename) {
      record.storage.provider = 'local';
      record.storage.localFilename = basename(localFilename);
    } else if (record.storage.provider === 'local' && record.storage.localFilename) {
      record.storage.localFilename = basename(record.storage.localFilename);
    }
  }
  return record;
}

function buildManifest({ migrationId, project, targetRootPath, sessions, assets, images, warnings }) {
  return {
    schemaVersion: SESSION_MIGRATION_SCHEMA_VERSION,
    type: SESSION_MIGRATION_TYPE,
    migrationId,
    exportedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      sourceRootPath: project.rootPath,
      targetRootPath,
    },
    sessions,
    assets,
    images,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Export only selected sessions from one project into a portable directory.
 * The source project and source session state are left untouched.
 */
export async function exportSelectedProjectSessions({ projectId, sessionIds, targetPath } = {}) {
  const project = await getProject(projectId);
  if (!project) throw createMigrationError('Project not found', 'PROJECT_NOT_FOUND', 404);
  const selectedIds = normalizeSessionIds(sessionIds);
  const rawTargetPath = trimString(targetPath);
  if (!rawTargetPath) throw createMigrationError('targetPath is required', 'MIGRATION_TARGET_REQUIRED');
  const targetRootPath = expandProjectRootPath(rawTargetPath);
  if (project.rootPath === targetRootPath) {
    throw createMigrationError('Target path must differ from the source project path', 'MIGRATE_SAME_PATH', 409);
  }
  if (isPathWithin(project.rootPath, targetRootPath) || isPathWithin(targetRootPath, project.rootPath)) {
    throw createMigrationError('Source and target project paths must not overlap', 'MIGRATION_PATH_OVERLAP', 409);
  }

  const metas = await loadSessionsMeta();
  const metaById = new Map((Array.isArray(metas) ? metas : []).map((meta) => [trimString(meta?.id), meta]));
  const selected = [];
  const activeSessionIds = [];
  for (const sessionId of selectedIds) {
    const meta = metaById.get(sessionId);
    if (!meta || !sessionBelongsToProject(meta, project)) {
      throw createMigrationError('A selected session does not belong to this project', 'SESSION_NOT_IN_PROJECT', 404, {
        sessionId,
      });
    }
    if (await isSessionRunning(meta)) activeSessionIds.push(sessionId);
    selected.push(meta);
  }
  if (activeSessionIds.length > 0) {
    throw createMigrationError('Stop active sessions before exporting them', 'PROJECT_MIGRATE_ACTIVE', 409, {
      activeSessionIds,
    });
  }

  await stat(project.rootPath).then((info) => {
    if (!info.isDirectory()) {
      throw createMigrationError('Project root is not a directory', 'PROJECT_ROOT_UNAVAILABLE', 400);
    }
  }).catch((error) => {
    if (error?.code === 'PROJECT_ROOT_UNAVAILABLE') throw error;
    throw createMigrationError(error?.message || 'Project root is not readable', error?.code || 'PROJECT_ROOT_UNAVAILABLE', 400);
  });
  await mkdir(targetRootPath, { recursive: true });
  const migrationId = createMigrationId();
  const bundlePath = join(targetRootPath, MIGRATION_DIRECTORY, migrationId);
  const stagingPath = `${bundlePath}.tmp-${process.pid}-${Date.now()}`;
  const warnings = [];
  const references = { assets: new Map(), images: new Set() };
  const manifestSessions = [];
  const manifestAssets = [];

  try {
    await mkdir(stagingPath, { recursive: true });
    const projectSnapshotPath = join(stagingPath, 'project');
    await copyTree(project.rootPath, projectSnapshotPath, {
      filter: (sourcePath) => basename(sourcePath) !== MIGRATION_DIRECTORY,
    });

    for (const meta of selected) {
      const sessionId = trimString(meta.id);
      const sourceHistoryPath = join(CHAT_HISTORY_DIR, sessionId);
      if (!await pathExists(sourceHistoryPath)) {
        throw createMigrationError('Selected session history is missing', 'SESSION_HISTORY_MISSING', 409, { sessionId });
      }
      const sessionBundlePath = join(stagingPath, 'sessions', sessionId);
      await copyTree(sourceHistoryPath, join(sessionBundlePath, 'history'));
      const exportedMeta = { ...meta };
      for (const field of SESSION_API_PRIVATE_FIELDS) delete exportedMeta[field];
      await writeJsonAtomic(join(sessionBundlePath, 'session-meta.json'), exportedMeta);
      // History files have already been copied verbatim above. Scan the
      // authoritative event stream without hydrating bodies or retaining the
      // whole transcript; migration only needs attachment/image references.
      await forEachStoredEvent(sessionId, (event) => {
        collectAttachmentReferences(event, references, sessionId);
      });
      manifestSessions.push({
        id: sessionId,
        metadataPath: `sessions/${sessionId}/session-meta.json`,
        historyPath: `sessions/${sessionId}/history`,
      });
    }

    await copyReferencedAssets(stagingPath, references, manifestAssets, warnings);
    const manifest = buildManifest({
      migrationId,
      project,
      targetRootPath,
      sessions: manifestSessions,
      assets: manifestAssets,
      images: [...references.images],
      warnings,
    });
    await writeJsonAtomic(join(stagingPath, 'manifest.json'), manifest);
    await mkdir(dirname(bundlePath), { recursive: true });
    await rename(stagingPath, bundlePath);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    migrationId,
    bundlePath,
    project: {
      id: project.id,
      name: project.name,
      sourceRootPath: project.rootPath,
      targetRootPath,
    },
    sessionIds: selectedIds,
    assetIds: manifestAssets.map((asset) => asset.id),
    imageFiles: [...references.images],
    warnings,
  };
}

/** Import a previously exported selected-session bundle into this instance. */
export async function importSessionMigrationBundle({ bundlePath, projectRootPath = '' } = {}) {
  const rawBundlePath = trimString(bundlePath);
  if (!rawBundlePath) throw createMigrationError('bundlePath is required', 'MIGRATION_BUNDLE_REQUIRED');
  const resolvedBundlePath = resolve(expandProjectRootPath(rawBundlePath));
  const manifest = await readJson(join(resolvedBundlePath, 'manifest.json'), null);
  if (manifest?.schemaVersion !== SESSION_MIGRATION_SCHEMA_VERSION || manifest?.type !== SESSION_MIGRATION_TYPE) {
    throw createMigrationError('Unsupported or invalid session migration bundle', 'MIGRATION_MANIFEST_INVALID', 400);
  }
  const rawProjectRootPath = trimString(projectRootPath) || trimString(manifest.project?.targetRootPath);
  if (!rawProjectRootPath) throw createMigrationError('projectRootPath is required', 'MIGRATION_TARGET_REQUIRED');
  const targetRootPath = expandProjectRootPath(rawProjectRootPath);
  if (targetRootPath === resolvedBundlePath || isPathWithin(resolvedBundlePath, targetRootPath)) {
    throw createMigrationError('projectRootPath must not be inside the migration bundle', 'MIGRATION_PATH_OVERLAP', 409);
  }

  const sessions = Array.isArray(manifest.sessions) ? manifest.sessions : [];
  if (sessions.length === 0) throw createMigrationError('Migration bundle contains no sessions', 'MIGRATION_SESSIONS_EMPTY');
  const ids = normalizeSessionIds(sessions.map((entry) => entry?.id));
  const sessionEntries = sessions.map((entry, index) => ({
    id: ids[index],
    metadataPath: resolveBundleEntry(resolvedBundlePath, entry.metadataPath),
    historyPath: resolveBundleEntry(resolvedBundlePath, entry.historyPath),
  }));
  const metadata = [];
  for (const entry of sessionEntries) {
    const meta = await readJson(entry.metadataPath, null);
    if (!meta || trimString(meta.id) !== entry.id) {
      throw createMigrationError('Migration session metadata is invalid', 'MIGRATION_SESSION_INVALID', 400, { sessionId: entry.id });
    }
    if (!await pathExists(entry.historyPath)) {
      throw createMigrationError('Migration session history is missing', 'MIGRATION_HISTORY_MISSING', 400, { sessionId: entry.id });
    }
    metadata.push(meta);
  }

  const currentMetas = await loadSessionsMeta();
  const existingIds = new Set((Array.isArray(currentMetas) ? currentMetas : []).map((meta) => trimString(meta?.id)));
  const conflicts = ids.filter((id) => existingIds.has(id));
  if (conflicts.length > 0) {
    throw createMigrationError('One or more sessions already exist on the target device', 'SESSION_MIGRATION_CONFLICT', 409, {
      sessionIds: conflicts,
    });
  }

  await mkdir(targetRootPath, { recursive: true });
  const projectSnapshotPath = resolveBundleEntry(resolvedBundlePath, 'project');
  if (await pathExists(projectSnapshotPath)) {
    await copyTree(projectSnapshotPath, targetRootPath, {
      filter: (sourcePath) => basename(sourcePath) !== MIGRATION_DIRECTORY,
    });
  }
  const project = await ensureProjectForSessionFolder(targetRootPath, {
    name: trimString(manifest.project?.name) || basename(targetRootPath),
    validateRoot: true,
    allowExisting: true,
  });

  const importedMetas = metadata.map((meta) => normalizeImportedSessionMeta(meta, project));
  const assetEntries = Array.isArray(manifest.assets) ? manifest.assets : [];
  const imageFiles = new Set(
    (Array.isArray(manifest.images) ? manifest.images : [])
      .map((filename) => basename(trimString(filename)))
      .filter((filename) => SAFE_FILENAME_PATTERN.test(filename)),
  );
  const localAssetFiles = new Set();
  const assetIds = new Set();
  const createdHistoryPaths = [];
  const stagingHistoryPaths = [];
  const createdAssetPaths = [];
  const createdImagePaths = [];

  try {
    await mkdir(CHAT_HISTORY_DIR, { recursive: true });
    for (const entry of sessionEntries) {
      const stagingHistoryPath = join(CHAT_HISTORY_DIR, `.migration-${createMigrationId()}`);
      stagingHistoryPaths.push(stagingHistoryPath);
      await copyTree(entry.historyPath, stagingHistoryPath);
      await rewriteImportedHistory(stagingHistoryPath, {
        sourceRootPath: expandProjectRootPath(manifest.project?.sourceRootPath || ''),
        targetRootPath,
        imageFiles,
        localAssetFiles,
        assetIds,
      });
      const finalHistoryPath = join(CHAT_HISTORY_DIR, entry.id);
      if (await pathExists(finalHistoryPath)) {
        throw createMigrationError('Session history already exists on the target device', 'SESSION_MIGRATION_CONFLICT', 409, {
          sessionIds: [entry.id],
        });
      }
      await rename(stagingHistoryPath, finalHistoryPath);
      stagingHistoryPaths.splice(stagingHistoryPaths.indexOf(stagingHistoryPath), 1);
      createdHistoryPaths.push(finalHistoryPath);
    }

    await mkdir(CHAT_IMAGES_DIR, { recursive: true });
    for (const filename of imageFiles) {
      const source = resolveBundleEntry(resolvedBundlePath, `images/${filename}`);
      if (!await pathExists(source)) continue;
      const destination = join(CHAT_IMAGES_DIR, filename);
      if (!await pathExists(destination)) {
        await copyTree(source, destination);
        createdImagePaths.push(destination);
      }
    }

    await mkdir(join(CHAT_FILE_ASSETS_DIR, 'objects'), { recursive: true });
    for (const entry of assetEntries) {
      const assetId = trimString(entry?.id);
      if (!assetId || !/^fasset_[a-f0-9]{24}$/.test(assetId)) continue;
      assetIds.add(assetId);
      const recordSource = resolveBundleEntry(resolvedBundlePath, entry.recordPath);
      const rawRecord = await readJson(recordSource, null);
      if (!rawRecord) throw createMigrationError('Migration file asset record is invalid', 'MIGRATION_ASSET_INVALID', 400, { assetId });
      const destinationRecord = join(CHAT_FILE_ASSETS_DIR, `${assetId}.json`);
      if (!await pathExists(destinationRecord)) {
        const ownerSessionId = trimString(entry.sessionIds?.[0]) || ids[0];
        await writeJsonAtomic(
          destinationRecord,
          buildImportableAssetRecord(rawRecord, ownerSessionId, entry.localFilename),
        );
        createdAssetPaths.push(destinationRecord);
      }
      const localFilename = basename(trimString(entry.localFilename));
      if (localFilename && entry.localObjectPath && SAFE_FILENAME_PATTERN.test(localFilename)) {
        localAssetFiles.add(localFilename);
        const objectSource = resolveBundleEntry(resolvedBundlePath, entry.localObjectPath);
        const objectDestination = join(CHAT_FILE_ASSETS_DIR, 'objects', localFilename);
        if (await pathExists(objectSource) && !await pathExists(objectDestination)) {
          await copyTree(objectSource, objectDestination);
        }
      }
    }

    // The history rewrite above may have seen assetIds before this loop. Run it
    // once more after building the asset list so stale absolute paths are gone.
    for (const historyPath of createdHistoryPaths) {
      await rewriteImportedHistory(historyPath, {
        sourceRootPath: expandProjectRootPath(manifest.project?.sourceRootPath || ''),
        targetRootPath,
        imageFiles,
        localAssetFiles,
        assetIds,
      });
    }

    await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
      metas.push(...importedMetas);
      await saveSessionsMeta(metas, { immediate: true });
    });
  } catch (error) {
    await Promise.all(stagingHistoryPaths.map((path) => rm(path, { recursive: true, force: true })));
    await Promise.all(createdHistoryPaths.map((path) => rm(path, { recursive: true, force: true })));
    await Promise.all(createdAssetPaths.map((path) => rm(path, { force: true })));
    await Promise.all(createdImagePaths.map((path) => rm(path, { force: true })));
    throw error;
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      rootPath: project.rootPath,
    },
    importedSessionIds: ids,
    assetIds: [...assetIds],
    imageFiles: [...imageFiles],
  };
}
