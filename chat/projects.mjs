import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import { access, copyFile, mkdir, readdir, stat } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { homedir } from 'os';

import { CHAT_PROJECTS_FILE } from '../lib/config.mjs';
import {
  createSerialTaskQueue,
  readJson,
  statOrNull,
  writeJsonAtomic,
} from './fs-utils.mjs';
import { ensureWorkspaceForRoot } from './workspaces.mjs';
import {
  getRun,
  getRunManifest,
  isTerminalRunState,
  listRunIds,
} from './runs.mjs';
import { getHistoryBase, materializeSharedHistory, removeSessionHistory } from './history.mjs';
import {
  loadSessionsMeta,
  withSessionsMetaMutation,
} from './session-meta-store.mjs';

const PROJECT_STORE_SCHEMA_VERSION = 1;
const PROJECT_ID_PREFIX = 'prj_';
const PROJECT_ID_HASH_LENGTH = 24;
const PROJECT_DELETE_CONCURRENCY = 4;
// Hard cap on the durable runs-dir scan inside hasProjectRuns: the freeze check
// stays bounded even for very large run archives.
const HAS_PROJECT_RUNS_SCAN_CAP = 5000;

let projectStoreCache = null;
let projectStoreCacheMtimeMs = null;
const runProjectMutation = createSerialTaskQueue();

async function removeSessionHistoriesBounded(sessionIds = [], {
  removeSessionHistoryImpl = removeSessionHistory,
  projectId = '',
} = {}) {
  const ids = Array.isArray(sessionIds) ? sessionIds : [];
  const removeOne = async (sessionId) => {
    try {
      await removeSessionHistoryImpl(sessionId);
    } catch (error) {
      // Project and session metadata are already committed; residual Windows
      // handle/AV locks on history directories must not fail deleteProject.
      console.warn('[projects] Residual session history cleanup failed after project deletion', {
        projectId,
        sessionId,
        code: error?.code || '',
        error: error?.message || String(error),
      });
    }
  };
  if (ids.length <= 1) {
    await Promise.all(ids.map((sessionId) => removeOne(sessionId)));
    return;
  }
  let cursor = 0;
  const workers = Array.from({
    length: Math.min(PROJECT_DELETE_CONCURRENCY, ids.length),
  }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= ids.length) return;
      await removeOne(ids[index]);
    }
  });
  await Promise.all(workers);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStoredTimestamp(value, fallback = '') {
  const trimmed = trimString(value);
  if (!trimmed) return fallback;
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

// 迁移重命名映射的合法相对路径：非空、非绝对、不含 \ 与 . / .. 段（防穿越出目标根）
function isSafeRelativePath(value) {
  if (!value || value.startsWith('/') || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

// {源相对路径: 目标相对路径}；空对象/空串=清除；非法条目（穿越/绝对路径）直接丢弃
function normalizeRenameMap(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const from = trimString(key);
    const to = trimString(val);
    if (!isSafeRelativePath(from) || !isSafeRelativePath(to)) continue;
    out[from] = to;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// 迁移复制：逐条目查重命名映射（源相对路径 → 目标相对路径），无映射条目跟随父目录目标位置。
// dstRel 是当前条目在目标侧的绝对路径（父目录改名时子条目自动跟随）；映射命中时用映射值（
// join(dstRoot, 映射值)，映射值已校验为安全相对路径）。
async function copyProjectEntry(srcPath, srcRel, dstRel, dstRoot, renameMap) {
  const stats = await stat(srcPath);
  if (stats.isDirectory()) {
    await mkdir(dstRel, { recursive: true });
    const entries = await readdir(srcPath);
    for (const entry of entries) {
      const childSrc = join(srcPath, entry);
      const childSrcRel = srcRel ? `${srcRel}/${entry}` : entry;
      const childDst = renameMap && Object.prototype.hasOwnProperty.call(renameMap, childSrcRel)
        ? join(dstRoot, renameMap[childSrcRel])
        : join(dstRel, entry);
      await copyProjectEntry(childSrc, childSrcRel, childDst, dstRoot, renameMap);
    }
  } else if (stats.isFile()) {
    await mkdir(dirname(dstRel), { recursive: true });
    await copyFile(srcPath, dstRel);
  }
  // 其他类型（socket/fifo 等）跳过
}

export function normalizeProjectId(value) {
  const trimmed = trimString(value);
  return /^prj_[a-f0-9]{12,64}$/i.test(trimmed) ? trimmed.toLowerCase() : '';
}

export function expandProjectRootPath(rootPath) {
  const trimmed = trimString(rootPath);
  if (!trimmed || trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

export function projectIdForRootPath(rootPath) {
  const normalizedRootPath = expandProjectRootPath(rootPath);
  const hash = createHash('sha256').update(normalizedRootPath).digest('hex').slice(0, PROJECT_ID_HASH_LENGTH);
  return `${PROJECT_ID_PREFIX}${hash}`;
}

// Path-derived ids remain the compatibility id for projects reconstructed from
// legacy folder/session data. Newly created projects need their own identity so
// several logical projects can intentionally share the same workspace path.
function createProjectId(existingProjects = []) {
  const existingIds = new Set(existingProjects.map((project) => project?.id).filter(Boolean));
  let id = '';
  do {
    id = `${PROJECT_ID_PREFIX}${randomUUID().replaceAll('-', '')}`;
  } while (existingIds.has(id));
  return id;
}

function nextProjectCreatedAt(existingProjects, now = Date.now()) {
  let nextTime = now;
  for (const project of Array.isArray(existingProjects) ? existingProjects : []) {
    const createdTime = Date.parse(project?.createdAt);
    if (Number.isFinite(createdTime) && createdTime >= nextTime) {
      nextTime = createdTime + 1;
    }
  }
  return new Date(nextTime).toISOString();
}

function normalizeProjectName(name, rootPath) {
  const trimmed = trimString(name).replace(/\s+/g, ' ');
  if (trimmed) return trimmed.slice(0, 100);
  const base = basename(expandProjectRootPath(rootPath)) || 'Project';
  return base.slice(0, 100);
}

function normalizeProjectType(value) {
  return ['research', 'document', 'software', 'collection', 'other'].includes(value) ? value : 'other';
}

function shouldHideSessionFromProjectCatalog(meta) {
  if (!meta || typeof meta !== 'object') return true;
  // Temporary intake stays unassigned unless the Owner explicitly associates a project.
  if (meta.createdByPrincipalKind === 'temporary_device' && !normalizeProjectId(meta.projectId)) return true;
  if (meta.sourceId === 'maintenance') return true;
  if (trimString(meta.internalRole)) return true;
  if (trimString(meta.compactsSessionId)) return true;
  if (trimString(meta.visitorId)) return true;
  return false;
}

function normalizeStoredProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) return null;
  const rootPath = trimString(project.rootPath)
    ? expandProjectRootPath(project.rootPath)
    : '';
  if (!rootPath) return null;
  const id = normalizeProjectId(project.id) || projectIdForRootPath(rootPath);
  const now = new Date().toISOString();
  return {
    id,
    name: normalizeProjectName(project.name, rootPath),
    rootPath,
    workspaceId: trimString(project.workspaceId) || '',
    scopeMode: project.scopeMode === 'subpath' ? 'subpath' : 'shared',
    scopePath: trimString(project.scopePath) || '',
    revision: Number.isInteger(project.revision) && project.revision > 0 ? project.revision : 1,
    createdAt: normalizeStoredTimestamp(project.createdAt, now),
    updatedAt: normalizeStoredTimestamp(project.updatedAt, normalizeStoredTimestamp(project.createdAt, now)),
    ...(trimString(project.purpose) ? { purpose: trimString(project.purpose).slice(0, 1_000) } : {}),
    ...(trimString(project.projectType) ? { projectType: normalizeProjectType(project.projectType) } : {}),
    ...(trimString(project.creationOperationId) ? { creationOperationId: trimString(project.creationOperationId).slice(0, 160) } : {}),
    ...(trimString(project.creationDigest) ? { creationDigest: trimString(project.creationDigest).slice(0, 128) } : {}),
    ...(project.archived === true ? { archived: true } : {}),
    ...(project.pinned === true ? { pinned: true } : {}),
    ...(project.migratedFromFolder === true ? { migratedFromFolder: true } : {}),
    ...(trimString(project.migrateTargetPath)
      ? { migrateTargetPath: expandProjectRootPath(project.migrateTargetPath) }
      : {}),
    ...(normalizeRenameMap(project.migrateRenames)
      ? { migrateRenames: normalizeRenameMap(project.migrateRenames) }
      : {}),
    ...(trimString(project.lastMigratedAt)
      ? { lastMigratedAt: normalizeStoredTimestamp(project.lastMigratedAt) }
      : {}),
  };
}

function normalizeProjectStore(raw) {
  const rawProjects = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.projects) ? raw.projects : []);
  const projects = [];
  const seenIds = new Set();
  let changed = !raw || typeof raw !== 'object' || raw.schemaVersion !== PROJECT_STORE_SCHEMA_VERSION || !Array.isArray(raw.projects);
  for (const entry of rawProjects) {
    const project = normalizeStoredProject(entry);
    if (!project) {
      changed = true;
      continue;
    }
    if (seenIds.has(project.id)) {
      changed = true;
      continue;
    }
    seenIds.add(project.id);
    projects.push(project);
    if (JSON.stringify(entry) !== JSON.stringify(project)) changed = true;
  }
  projects.sort((a, b) => (
    Number(b.pinned === true) - Number(a.pinned === true)
    || a.name.localeCompare(b.name)
    || a.rootPath.localeCompare(b.rootPath)
  ));
  return {
    store: {
      schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
      projects,
    },
    changed,
  };
}

async function loadProjectStoreUnlocked() {
  const stats = await statOrNull(CHAT_PROJECTS_FILE);
  if (!stats) {
    projectStoreCache = { schemaVersion: PROJECT_STORE_SCHEMA_VERSION, projects: [] };
    projectStoreCacheMtimeMs = null;
    return projectStoreCache;
  }
  if (projectStoreCache && projectStoreCacheMtimeMs === stats.mtimeMs) {
    return projectStoreCache;
  }
  const parsed = await readJson(CHAT_PROJECTS_FILE, { schemaVersion: PROJECT_STORE_SCHEMA_VERSION, projects: [] });
  const normalized = normalizeProjectStore(parsed);
  projectStoreCache = normalized.store;
  if (normalized.changed) {
    await saveProjectStoreUnlocked(projectStoreCache);
  } else {
    projectStoreCacheMtimeMs = stats.mtimeMs;
  }
  return projectStoreCache;
}

async function saveProjectStoreUnlocked(store) {
  const normalized = normalizeProjectStore(store).store;
  await writeJsonAtomic(CHAT_PROJECTS_FILE, normalized);
  projectStoreCache = normalized;
  projectStoreCacheMtimeMs = (await statOrNull(CHAT_PROJECTS_FILE))?.mtimeMs ?? null;
  return projectStoreCache;
}

// Several Projects may intentionally share one rootPath (design 3/4), so a bare
// folder can no longer uniquely identify a Project. When multiple Projects match
// the same root, resolve to the canonical one — earliest createdAt, then earliest
// id — so folder-derived association stays stable and never depends on the catalog
// sort order. A later-created Project whose name happens to sort first must not
// capture sessions that were created with only a folder.
function findProjectByRootInList(projects, rootPath) {
  const normalizedRootPath = expandProjectRootPath(rootPath);
  const matches = (Array.isArray(projects) ? projects : []).filter((project) => project.rootPath === normalizedRootPath);
  if (matches.length <= 1) return matches[0] || null;
  return matches.reduce((canonical, project) => {
    const canonicalTime = Date.parse(canonical.createdAt) || Number.MAX_SAFE_INTEGER;
    const projectTime = Date.parse(project.createdAt) || Number.MAX_SAFE_INTEGER;
    if (projectTime !== canonicalTime) return projectTime < canonicalTime ? project : canonical;
    return project.id < canonical.id ? project : canonical;
  });
}

function findProjectByIdInList(projects, projectId) {
  const normalizedProjectId = normalizeProjectId(projectId);
  if (!normalizedProjectId) return null;
  return (Array.isArray(projects) ? projects : []).find((project) => project.id === normalizedProjectId) || null;
}

function createMigratedProject(rootPath, usedNames) {
  const normalizedRootPath = expandProjectRootPath(rootPath);
  let name = normalizeProjectName('', normalizedRootPath);
  if (usedNames.has(name.toLowerCase())) {
    name = `${name} (${normalizedRootPath})`;
  }
  usedNames.add(name.toLowerCase());
  const now = new Date().toISOString();
  return {
    id: projectIdForRootPath(normalizedRootPath),
    name,
    rootPath: normalizedRootPath,
    createdAt: now,
    updatedAt: now,
    migratedFromFolder: true,
  };
}

function sessionBelongsToProject(meta, project) {
  if (shouldHideSessionFromProjectCatalog(meta) || meta?.projectDetached === true) return false;
  const projectId = normalizeProjectId(meta?.projectId);
  if (projectId) return projectId === project.id;
  const folder = trimString(meta?.folder);
  return !!folder && expandProjectRootPath(folder) === project.rootPath;
}

async function isSessionRunningFromMeta(meta) {
  const runId = trimString(meta?.activeRunId);
  if (!runId) return false;
  const run = await getRun(runId);
  return !!run && !isTerminalRunState(run.state);
}

export async function ensureProjectsInitialized() {
  return runProjectMutation(async () => {
    const store = await loadProjectStoreUnlocked();
    const usedNames = new Set(store.projects.map((project) => project.name.toLowerCase()));
    let projectsChanged = false;

    await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
      let sessionsChanged = false;
      for (const meta of Array.isArray(metas) ? metas : []) {
        if (shouldHideSessionFromProjectCatalog(meta)) continue;
        // A project deletion can intentionally send a session to the L1
        // inbox even though its folder still points at the old root. Keep the
        // explicit detach marker authoritative across restarts.
        if (meta.projectDetached === true) continue;
        const existingProject = findProjectByIdInList(store.projects, meta.projectId);
        if (existingProject) continue;
        const folder = trimString(meta.folder);
        if (!folder) continue;
        const rootPath = expandProjectRootPath(folder);
        let project = findProjectByRootInList(store.projects, rootPath);
        if (!project) {
          project = createMigratedProject(rootPath, usedNames);
          store.projects.push(project);
          projectsChanged = true;
        }
        if (meta.projectId !== project.id) {
          meta.projectId = project.id;
          sessionsChanged = true;
        }
        if (meta.folder !== rootPath) {
          meta.folder = rootPath;
          sessionsChanged = true;
        }
      }
      if (projectsChanged) {
        store.projects.sort((a, b) => (
          Number(b.pinned === true) - Number(a.pinned === true)
          || a.name.localeCompare(b.name)
          || a.rootPath.localeCompare(b.rootPath)
        ));
        await saveProjectStoreUnlocked(store);
      }
      if (sessionsChanged) {
        await saveSessionsMeta(metas);
      }
      return { projectsChanged, sessionsChanged };
    });

    // Workspace backfill (design 11.1): one Workspace per (hostId, physicalKey);
    // missing/inaccessible roots become unresolved Workspaces and the Project
    // still lists normally. WORKSPACE_ROOT_DRIFT during backfill keeps the
    // existing binding instead of failing the catalog read.
    let workspacesChanged = false;
    for (const project of store.projects) {
      let workspace;
      try {
        workspace = await ensureWorkspaceForRoot(project.rootPath);
      } catch (error) {
        if (error?.code !== 'WORKSPACE_ROOT_DRIFT') throw error;
        continue;
      }
      if (project.workspaceId !== workspace.id) {
        project.workspaceId = workspace.id;
        workspacesChanged = true;
      }
    }
    if (workspacesChanged) {
      await saveProjectStoreUnlocked(store);
    }

    return store;
  });
}

async function readProjectRootStatus(rootPath) {
  const normalizedRootPath = expandProjectRootPath(rootPath);
  try {
    const stats = await stat(normalizedRootPath);
    if (!stats.isDirectory()) {
      return { status: 'not_directory', ok: false };
    }
    await access(normalizedRootPath, constants.R_OK | constants.X_OK);
    return { status: 'available', ok: true };
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return { status: 'inaccessible', ok: false, code: error.code };
    }
    return { status: 'missing', ok: false, code: error?.code || '' };
  }
}

function countSessionsByProject(metas = []) {
  const counts = new Map();
  for (const meta of Array.isArray(metas) ? metas : []) {
    if (shouldHideSessionFromProjectCatalog(meta)) continue;
    const projectId = normalizeProjectId(meta.projectId);
    if (!projectId) continue;
    const current = counts.get(projectId) || { sessionCount: 0, activeSessionCount: 0, archivedSessionCount: 0 };
    current.sessionCount += 1;
    if (meta.archived === true) current.archivedSessionCount += 1;
    else current.activeSessionCount += 1;
    counts.set(projectId, current);
  }
  return counts;
}

async function projectToClient(project, counts = null) {
  const root = await readProjectRootStatus(project.rootPath);
  const count = counts?.get(project.id) || { sessionCount: 0, activeSessionCount: 0, archivedSessionCount: 0 };
  // Client projection keeps the existing surface: workspace binding fields are
  // internal until the collaboration API opens them explicitly.
  const { workspaceId, scopeMode, scopePath, revision, creationOperationId, creationDigest, ...clientFields } = project;
  return {
    ...clientFields,
    rootStatus: root.status,
    rootOk: root.ok,
    ...(root.code ? { rootStatusCode: root.code } : {}),
    ...count,
  };
}

export async function listProjects({ includeArchived = false, includeSessionCounts = true } = {}) {
  await ensureProjectsInitialized();
  const store = await loadProjectStoreUnlocked();
  const metas = includeSessionCounts ? await loadSessionsMeta() : [];
  const counts = includeSessionCounts ? countSessionsByProject(metas) : null;
  const projects = store.projects.filter((project) => includeArchived || project.archived !== true);
  return Promise.all(projects.map((project) => projectToClient(project, counts)));
}

// Internal authoritative records for routing. The client projection above
// intentionally omits workspace binding and revision fields.
export async function listProjectRecords({ includeArchived = false } = {}) {
  await ensureProjectsInitialized();
  const store = await loadProjectStoreUnlocked();
  return store.projects
    .filter((project) => includeArchived || project.archived !== true)
    .map((project) => ({ ...project }));
}

export async function getProject(projectId, { client = false } = {}) {
  await ensureProjectsInitialized();
  const store = await loadProjectStoreUnlocked();
  const project = findProjectByIdInList(store.projects, projectId);
  if (!project) return null;
  if (!client) return { ...project };
  const metas = await loadSessionsMeta();
  return projectToClient(project, countSessionsByProject(metas));
}

export async function findProjectByRootPath(rootPath, { client = false } = {}) {
  await ensureProjectsInitialized();
  const store = await loadProjectStoreUnlocked();
  const project = findProjectByRootInList(store.projects, rootPath);
  if (!project) return null;
  if (!client) return { ...project };
  const metas = await loadSessionsMeta();
  return projectToClient(project, countSessionsByProject(metas));
}

function createProjectError(message, code, statusCode, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

async function assertProjectRootCreatable(rootPath) {
  const root = await readProjectRootStatus(rootPath);
  if (root.status === 'available') return;
  throw createProjectError(
    root.status === 'not_directory'
      ? 'Project path is not a directory'
      : root.status === 'inaccessible'
        ? 'Project path is not accessible'
        : 'Project path not found',
    'PROJECT_ROOT_INVALID',
    root.status === 'missing' ? 404 : 400,
    { rootStatus: root.status },
  );
}

export async function createProject(payload = {}, options = {}) {
  const rootPath = expandProjectRootPath(payload.rootPath);
  if (!trimString(payload.rootPath)) {
    throw createProjectError('rootPath is required', 'PROJECT_ROOT_REQUIRED', 400);
  }
  if (options.validateRoot !== false) {
    await assertProjectRootCreatable(rootPath);
  }
  return runProjectMutation(async () => {
    const store = await loadProjectStoreUnlocked();
    const creationOperationId = trimString(payload.creationOperationId).slice(0, 160);
    const creationDigest = trimString(payload.creationDigest).slice(0, 128);
    if (creationOperationId && !/^[a-f0-9]{64}$/.test(creationDigest)) {
      throw createProjectError('Project creation digest is required', 'PROJECT_CREATION_DIGEST_REQUIRED', 400);
    }
    if (creationOperationId) {
      const existing = store.projects.find((project) => project.creationOperationId === creationOperationId);
      if (existing) {
        if (existing.creationDigest !== creationDigest || existing.rootPath !== rootPath) {
          throw createProjectError('Creation identity already belongs to another request', 'PROJECT_CREATION_CONFLICT', 409);
        }
        return { ...existing };
      }
    }
    const now = new Date().toISOString();
    const createdAt = nextProjectCreatedAt(store.projects, Date.parse(now));
    const workspace = await ensureWorkspaceForRoot(rootPath);
    const project = {
      id: createProjectId(store.projects),
      name: normalizeProjectName(payload.name, rootPath),
      rootPath,
      workspaceId: workspace.id,
      scopeMode: 'shared',
      scopePath: '',
      revision: 1,
      createdAt,
      updatedAt: now,
      ...(trimString(payload.purpose) ? { purpose: trimString(payload.purpose).slice(0, 1_000) } : {}),
      ...(trimString(payload.projectType) ? { projectType: normalizeProjectType(payload.projectType) } : {}),
      ...(creationOperationId ? { creationOperationId, creationDigest } : {}),
      ...(payload.migratedFromFolder === true ? { migratedFromFolder: true } : {}),
    };
    store.projects.push(project);
    store.projects.sort((a, b) => (
      Number(b.pinned === true) - Number(a.pinned === true)
      || a.name.localeCompare(b.name)
      || a.rootPath.localeCompare(b.rootPath)
    ));
    await saveProjectStoreUnlocked(store);
    return { ...project };
  });
}

export async function ensureProjectForSessionFolder(folder, options = {}) {
  const rootPath = expandProjectRootPath(folder);
  const existing = await findProjectByRootPath(rootPath);
  if (existing) return existing;
  return createProject({
    name: options.name || '',
    rootPath,
    migratedFromFolder: options.migratedFromFolder === true,
  }, {
    validateRoot: options.validateRoot === true,
    allowExisting: true,
  });
}

/**
 * True when the Project root has produced at least one Run (frozen binding
 * predicate, design 11.3). Fast path: a folder-bound session with a non-empty
 * activeRunId. Durable path: a bounded scan of CHAT_RUNS_DIR status.json
 * sessionIds (cap 5000), falling back to the run manifest folder for sessions
 * that no longer exist in the session meta.
 */
export async function hasProjectRuns(rootPath) {
  const normalizedRootPath = expandProjectRootPath(rootPath);
  const metas = await loadSessionsMeta();
  const sessionList = Array.isArray(metas) ? metas : [];
  const folderBySessionId = new Map();
  for (const meta of sessionList) {
    const id = trimString(meta?.id);
    const folder = trimString(meta?.folder);
    if (id && folder) folderBySessionId.set(id, expandProjectRootPath(folder));
  }
  for (const meta of sessionList) {
    const id = trimString(meta?.id);
    if (!id) continue;
    const folder = trimString(meta?.folder);
    if (folder && expandProjectRootPath(folder) === normalizedRootPath && trimString(meta?.activeRunId)) {
      return true;
    }
  }
  let scanned = 0;
  for (const runId of await listRunIds()) {
    if (scanned >= HAS_PROJECT_RUNS_SCAN_CAP) break;
    scanned += 1;
    const run = await getRun(runId);
    if (!run) continue;
    const sessionId = trimString(run?.sessionId);
    if (!sessionId) continue;
    const sessionFolder = folderBySessionId.get(sessionId);
    if (sessionFolder === normalizedRootPath) return true;
    if (!folderBySessionId.has(sessionId)) {
      const manifest = await getRunManifest(runId);
      const manifestFolder = trimString(manifest?.folder);
      if (manifestFolder && expandProjectRootPath(manifestFolder) === normalizedRootPath) return true;
    }
  }
  return false;
}

export async function updateProject(projectId, patch = {}) {
  const normalizedProjectId = normalizeProjectId(projectId);
  if (!normalizedProjectId) return null;
  return runProjectMutation(async () => {
    const store = await loadProjectStoreUnlocked();
    const index = store.projects.findIndex((project) => project.id === normalizedProjectId);
    if (index === -1) return null;
    const current = store.projects[index];
    const nextName = Object.prototype.hasOwnProperty.call(patch, 'name')
      ? normalizeProjectName(patch.name, current.rootPath)
      : current.name;
    const nextArchived = Object.prototype.hasOwnProperty.call(patch, 'archived')
      ? patch.archived === true
      : current.archived === true;
    const nextPinned = Object.prototype.hasOwnProperty.call(patch, 'pinned')
      ? patch.pinned === true
      : current.pinned === true;
    // 迁移目标路径：空字符串 = 清除配置（默认路径不变）
    const nextMigrateTargetPath = Object.prototype.hasOwnProperty.call(patch, 'migrateTargetPath')
      ? (trimString(patch.migrateTargetPath)
        ? expandProjectRootPath(patch.migrateTargetPath)
        : '')
      : (current.migrateTargetPath || '');
    // 迁移重命名映射：显式空/空对象 = 清除；非法类型（非对象）忽略保留原值
    const nextMigrateRenames = Object.prototype.hasOwnProperty.call(patch, 'migrateRenames')
      ? (patch.migrateRenames === '' || patch.migrateRenames === null || patch.migrateRenames === undefined
        ? undefined
        : (typeof patch.migrateRenames === 'object' && !Array.isArray(patch.migrateRenames)
          ? normalizeRenameMap(patch.migrateRenames)
          : current.migrateRenames ? { ...current.migrateRenames } : undefined))
      : (current.migrateRenames ? { ...current.migrateRenames } : undefined);
    // 执行绑定冻结（design 11.3）：workspaceId / scopeMode / scopePath / rootPath
    // 是执行绑定字段；Project 已产生首个 Run 后不可原地修改。从未产生 Run 的
    // Project 允许在迁移窗口内重绑。
    const bindingKeys = ['workspaceId', 'scopeMode', 'scopePath', 'rootPath'];
    const touchesBinding = bindingKeys.some((key) => Object.prototype.hasOwnProperty.call(patch, key));
    if (touchesBinding && await hasProjectRuns(current.rootPath)) {
      throw createProjectError(
        'Project execution binding is immutable after the first run',
        'PROJECT_EXECUTION_BINDING_IMMUTABLE',
        409,
        { projectId: normalizedProjectId },
      );
    }
    let nextRootPath = current.rootPath;
    let nextWorkspaceId = trimString(current.workspaceId || '');
    const nextScopeMode = patch.scopeMode === 'subpath' || patch.scopeMode === 'shared'
      ? patch.scopeMode
      : (current.scopeMode === 'subpath' ? 'subpath' : 'shared');
    const nextScopePath = Object.prototype.hasOwnProperty.call(patch, 'scopePath')
      ? trimString(patch.scopePath)
      : trimString(current.scopePath || '');
    if (Object.prototype.hasOwnProperty.call(patch, 'rootPath')) {
      const nextRoot = expandProjectRootPath(patch.rootPath);
      if (trimString(nextRoot)) nextRootPath = nextRoot;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'workspaceId')) {
      nextWorkspaceId = trimString(patch.workspaceId);
    }
    // rootPath 重绑时重新解析 Workspace；显式 workspaceId 清空时同样重绑。
    if ((Object.prototype.hasOwnProperty.call(patch, 'rootPath') && nextRootPath !== current.rootPath)
      || (Object.prototype.hasOwnProperty.call(patch, 'workspaceId') && !nextWorkspaceId)) {
      const workspace = await ensureWorkspaceForRoot(nextRootPath);
      nextWorkspaceId = workspace.id;
    }
    const next = {
      ...current,
      name: nextName,
      rootPath: nextRootPath,
      workspaceId: nextWorkspaceId,
      scopeMode: nextScopeMode,
      scopePath: nextScopePath,
      updatedAt: new Date().toISOString(),
    };
    if (nextArchived) next.archived = true;
    else delete next.archived;
    if (nextPinned) next.pinned = true;
    else delete next.pinned;
    if (nextMigrateTargetPath) next.migrateTargetPath = nextMigrateTargetPath;
    else delete next.migrateTargetPath;
    if (nextMigrateRenames) next.migrateRenames = nextMigrateRenames;
    else delete next.migrateRenames;
    // 任意 canonical mutation 递增 record revision（design 6.2）。
    next.revision = (Number.isInteger(current.revision) && current.revision > 0 ? current.revision : 1) + 1;
    store.projects[index] = next;
    await saveProjectStoreUnlocked(store);
    return { ...next };
  });
}

/**
 * 项目复制迁移（批量执行）：
 *  - 对配置了 migrateTargetPath 的项目，把 rootPath 内容复制到目标路径（源目录保留）
 *  - 成功后项目记录 rootPath 更新到目标路径（id 保留 → 会话关联不破），清除 migrateTargetPath
 *  - 未配置 migrateTargetPath 的项目跳过（默认路径不变）
 *  - 任一项目失败（权限不足/目标=源/有运行中会话等）不中断其余，全部执行完后汇总 failed
 */
export async function migrateProjectsToTargets() {
  const failed = [];
  const migrated = [];
  // 锁内取快照：只取配置了迁移目标路径的项目
  const pending = await runProjectMutation(async () => {
    const store = await loadProjectStoreUnlocked();
    return store.projects
      .filter((project) => trimString(project.migrateTargetPath || ''))
      .map((project) => ({
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        targetPath: expandProjectRootPath(project.migrateTargetPath),
        // 重命名映射快照：{相对路径: 目标相对路径}；空 = 原样复制
        renameMap: normalizeRenameMap(project.migrateRenames) || null,
      }));
  });

  for (const item of pending) {
    if (item.targetPath === item.rootPath) {
      failed.push({
        id: item.id,
        name: item.name,
        code: 'MIGRATE_SAME_PATH',
        error: 'Target path is the same as the current project path',
      });
      continue;
    }
    // 有运行中会话的项目拒绝迁移（与 deleteProject 同纪律：防复制期间数据撕裂）
    let running = false;
    const metas = await loadSessionsMeta();
    for (const meta of Array.isArray(metas) ? metas : []) {
      if (sessionBelongsToProject(meta, { id: item.id, rootPath: item.rootPath }) && await isSessionRunningFromMeta(meta)) {
        running = true;
        break;
      }
    }
    if (running) {
      failed.push({
        id: item.id,
        name: item.name,
        code: 'PROJECT_MIGRATE_ACTIVE',
        error: 'Stop active sessions before migrating this project',
      });
      continue;
    }
    try {
      // 逐条目复制：重命名映射生效（无映射条目原样）；copyFile 覆盖同名文件（重复执行幂等）；源目录保留
      await copyProjectEntry(item.rootPath, '', item.targetPath, item.targetPath, item.renameMap);
      migrated.push(item);
    } catch (error) {
      failed.push({
        id: item.id,
        name: item.name,
        code: error?.code || 'MIGRATE_FAILED',
        error: error?.message || String(error),
      });
    }
  }

  // 锁内应用：成功项更新 rootPath（id 不变）/记录 lastMigratedAt/清除配置
  await runProjectMutation(async () => {
    if (migrated.length === 0) return;
    const store = await loadProjectStoreUnlocked();
    const now = new Date().toISOString();
    for (const item of migrated) {
      const project = store.projects.find((entry) => entry.id === item.id);
      if (!project) continue;
      project.rootPath = item.targetPath;
      // 迁移重绑执行绑定也属于 canonical mutation：递增 revision（design 6.2）。
      project.revision = (Number.isInteger(project.revision) && project.revision > 0 ? project.revision : 1) + 1;
      const workspace = await ensureWorkspaceForRoot(project.rootPath);
      project.workspaceId = workspace.id;
      project.updatedAt = now;
      project.lastMigratedAt = now;
      delete project.migrateTargetPath;
    }
    await saveProjectStoreUnlocked(store);
  });

  return {
    migrated: migrated.map((item) => ({ id: item.id, name: item.name, rootPath: item.targetPath })),
    failed,
  };
}

/**
 * Remove a project and apply one explicit session policy:
 * - deleteSessions=true removes the visible sessions and their history;
 * - otherwise the sessions keep their folder but become durable L1 inbox
 *   entries via projectDetached=true.
 */
export async function deleteProject(projectId, {
  deleteSessions = false,
  removeSessionHistoryImpl = removeSessionHistory,
} = {}) {
  const normalizedProjectId = normalizeProjectId(projectId);
  if (!normalizedProjectId) return null;
  return runProjectMutation(async () => {
    const store = await loadProjectStoreUnlocked();
    const index = store.projects.findIndex((project) => project.id === normalizedProjectId);
    if (index === -1) return null;
    const project = { ...store.projects[index] };
    let matchedSessionIds = [];

    await withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
      const matched = (Array.isArray(metas) ? metas : [])
        .filter((meta) => sessionBelongsToProject(meta, project));
      const runningIds = [];
      for (const meta of matched) {
        if (await isSessionRunningFromMeta(meta)) runningIds.push(meta.id);
      }
      if (runningIds.length > 0) {
        throw createProjectError(
          'Stop active sessions before deleting this project',
          'PROJECT_DELETE_ACTIVE',
          409,
          { activeSessionIds: runningIds },
        );
      }

      matchedSessionIds = matched
        .map((meta) => trimString(meta?.id))
        .filter(Boolean);
      if (deleteSessions) {
        const matchedIds = new Set(matchedSessionIds);
        const materialized = [];
        for (const meta of (Array.isArray(metas) ? metas : [])) {
          const base = await getHistoryBase(meta?.id).catch((error) => {
            if (error?.code === 'HISTORY_BASE_UNAVAILABLE') return null;
            throw error;
          });
          const dependentId = trimString(meta?.id);
          if (!base || !matchedIds.has(trimString(base.sourceSessionId)) || matchedIds.has(dependentId)) continue;
          try {
            const result = await materializeSharedHistory(dependentId);
            if (result?.materialized) {
              delete meta.historyStorage;
              delete meta.historyRepairState;
              delete meta.historyRepairMessage;
              materialized.push(dependentId);
            }
          } catch (error) {
            // Keep already materialized children consistent if a later
            // dependent cannot be repaired; the project deletion itself is
            // still aborted and the source sessions remain present.
            if (materialized.length > 0) await saveSessionsMeta(metas, { immediate: true });
            throw error;
          }
        }
        const matchedSet = new Set(matched);
        const kept = metas.filter((meta) => !matchedSet.has(meta));
        if (kept.length !== metas.length) await saveSessionsMeta(kept, { immediate: true });
      } else {
        let changed = false;
        for (const meta of matched) {
          if (meta.projectId) {
            meta.projectId = '';
            changed = true;
          }
          if (meta.projectDetached !== true) {
            meta.projectDetached = true;
            changed = true;
          }
        }
        if (changed) await saveSessionsMeta(metas, { immediate: true });
      }
      return null;
    });

    store.projects.splice(index, 1);
    await saveProjectStoreUnlocked(store);

    if (deleteSessions) {
      await removeSessionHistoriesBounded(matchedSessionIds, {
        removeSessionHistoryImpl,
        projectId: project.id,
      });
    }
    return {
      project,
      deleteSessions: deleteSessions === true,
      sessionIds: matchedSessionIds,
      deletedSessionCount: deleteSessions ? matchedSessionIds.length : 0,
      detachedSessionCount: deleteSessions ? 0 : matchedSessionIds.length,
    };
  });
}
