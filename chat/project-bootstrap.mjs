/** Durable, idempotent Project creation for a frozen intake decision. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CONFIG_DIR, MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { createSerialTaskQueue, writeJsonAtomic } from './fs-utils.mjs';
import { defaultProjectIndex } from './project-index.mjs';
import { createProject, listProjectRecords } from './projects.mjs';

const MARKER_FILE = '.ragent-intake.json';
const INITIAL_FILE = 'INTAKE.md';

function text(value, max = 0) {
  const source = typeof value === 'string' ? value.trim() : '';
  return max > 0 ? source.slice(0, max) : source;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function failure(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizePlan(input = {}) {
  const project = input.newProject || {};
  const plan = {
    operationId: text(input.operationId, 160),
    decisionId: text(input.decisionId, 128),
    inputDigest: text(input.inputDigest, 128),
    targetInstanceId: text(input.targetInstanceId, 160),
    indexRevision: text(input.indexRevision, 128),
    name: text(project.name, 100),
    purpose: text(project.purpose, 1_000),
    projectType: ['research', 'document', 'software', 'collection', 'other'].includes(project.projectType)
      ? project.projectType : 'other',
    userRequirement: text(input.userRequirement, 8_000),
    sourceRefs: Array.isArray(input.sourceRefs)
      ? input.sourceRefs.slice(0, 16).map((ref) => text(ref, 2_000)).filter(Boolean) : [],
  };
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(plan.operationId) || !plan.decisionId
    || !/^[a-f0-9]{64}$/.test(plan.inputDigest) || !plan.targetInstanceId
    || !plan.indexRevision || !plan.name || !plan.purpose) {
    throw failure('PROJECT_BOOTSTRAP_INVALID', 'Incomplete frozen Project creation plan', 400);
  }
  return plan;
}

function safeDirectoryName(plan) {
  const label = plan.name.normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
  return `${label}-${hash(plan.operationId).slice(0, 12)}`;
}

async function markerAt(directory) {
  try { return JSON.parse(await readFile(join(directory, MARKER_FILE), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw failure('PROJECT_MARKER_INVALID', 'Project ownership marker is invalid');
  }
}

async function assertOwnedDirectory(directory, plan, requestDigest, { allowEmpty = false } = {}) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw failure('PROJECT_PATH_CONFLICT', 'Project path is not an owned directory');
  }
  const marker = await markerAt(directory);
  if (marker) {
    if (marker.operationId !== plan.operationId || marker.requestDigest !== requestDigest) {
      throw failure('PROJECT_PATH_CONFLICT', 'Project path belongs to another operation');
    }
    return;
  }
  const entries = await readdir(directory);
  if (!allowEmpty || entries.length > 0) {
    throw failure('PROJECT_PATH_CONFLICT', 'Project path already contains unowned content');
  }
  await writeJsonAtomic(join(directory, MARKER_FILE), {
    schemaVersion: 1, operationId: plan.operationId, requestDigest,
  });
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function initialText(plan) {
  return [
    `# ${plan.name}`,
    '',
    '## 持续目标',
    plan.purpose,
    '',
    ...(plan.userRequirement ? ['## 用户原始要求', plan.userRequirement, ''] : []),
    ...(plan.sourceRefs.length ? ['## 输入来源', ...plan.sourceRefs.map((ref) => `- ${ref.replaceAll('\n', ' ')}`), ''] : []),
  ].join('\n');
}

export function createProjectBootstrap(options = {}) {
  const databasePath = options.databasePath || join(CONFIG_DIR, 'project-bootstrap.sqlite');
  const parentRoot = options.parentRoot || MANAGED_WORK_ROOT_DIR;
  const getIdentity = options.getInstanceIdentity || loadOrCreateInstanceIdentity;
  const projectIndex = options.projectIndex || defaultProjectIndex;
  const create = options.createProject || createProject;
  const list = options.listProjects || listProjectRecords;
  const serialize = createSerialTaskQueue();

  async function withDatabase(effect) {
    await mkdir(dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS project_bootstrap (
        operation_id TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        directory TEXT NOT NULL,
        stage TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      return effect(db);
    } finally { db.close(); }
  }

  async function receipt(operationId) {
    return withDatabase((db) => {
      const row = db.prepare('SELECT * FROM project_bootstrap WHERE operation_id = ?').get(operationId);
      if (!row) return null;
      const plan = JSON.parse(row.plan_json);
      return {
        operationId: row.operation_id, requestDigest: row.request_digest,
        decisionId: plan.decisionId, inputDigest: plan.inputDigest,
        targetInstanceId: plan.targetInstanceId,
        projectId: row.project_id || null, stage: row.stage,
        directory: row.directory, updatedAt: row.updated_at,
      };
    });
  }

  async function setStage(operationId, stage, projectId = '') {
    await withDatabase((db) => db.prepare(`UPDATE project_bootstrap
      SET stage = ?, project_id = CASE WHEN ? != '' THEN ? ELSE project_id END, updated_at = ?
      WHERE operation_id = ?`).run(stage, projectId, projectId, new Date().toISOString(), operationId));
  }

  async function ensureDirectory(plan, requestDigest, directory, stage) {
    if (stage !== 'planned' && !(await exists(directory))) {
      throw failure('PROJECT_DIRECTORY_MISSING', 'The original Project directory is missing');
    }
    const staging = `${directory}.creating`;
    if (await exists(directory)) {
      await assertOwnedDirectory(directory, plan, requestDigest);
      return;
    }
    if (!(await exists(staging))) {
      await mkdir(staging);
    }
    await assertOwnedDirectory(staging, plan, requestDigest, { allowEmpty: true });
    try { await rename(staging, directory); }
    catch (error) {
      if (!(await exists(directory))) throw error;
      await assertOwnedDirectory(directory, plan, requestDigest);
    }
  }

  async function ensureForIntake(rawPlan = {}) {
    return serialize(async () => {
      const plan = normalizePlan(rawPlan);
      const identity = await getIdentity();
      if (plan.targetInstanceId !== identity?.instanceId) {
        throw failure('TARGET_CHANGED', 'The frozen target computer is no longer this instance');
      }
      const requestDigest = hash(plan);
      const managedRoot = resolve(parentRoot);
      await mkdir(managedRoot, { recursive: true });
      const realParent = await realpath(managedRoot);
      const parentInfo = await stat(realParent);
      if (!parentInfo.isDirectory()) throw failure('PROJECT_PARENT_INVALID', 'Managed Project root is unavailable');
      const directory = join(realParent, safeDirectoryName(plan));
      if (relative(realParent, directory).startsWith('..')) {
        throw failure('PROJECT_PATH_INVALID', 'Project directory is outside its managed root');
      }

      let current = await receipt(plan.operationId);
      if (current && (current.requestDigest !== requestDigest || current.directory !== directory)) {
        throw failure('PROJECT_OPERATION_CONFLICT', 'Creation operation identity has a different request');
      }
      if (!current) {
        const index = await projectIndex.refresh();
        if (index.targetInstanceId !== plan.targetInstanceId || index.indexRevision !== plan.indexRevision
          || !index.inventoryComplete || index.truncated) {
          throw failure('PROJECT_INDEX_CHANGED', 'Project inventory changed; reanalyze this intake');
        }
        const timestamp = new Date().toISOString();
        await withDatabase((db) => db.prepare(`INSERT INTO project_bootstrap
          (operation_id, request_digest, plan_json, directory, stage, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'planned', ?, ?)`)
          .run(plan.operationId, requestDigest, JSON.stringify(plan), directory, timestamp, timestamp));
        current = await receipt(plan.operationId);
      }
      if (current.stage === 'completed' && current.projectId) {
        if (!(await exists(directory))) {
          throw failure('PROJECT_DIRECTORY_MISSING', 'The original Project directory is missing');
        }
        await assertOwnedDirectory(directory, plan, requestDigest);
        const registered = (await list({ includeArchived: true }))
          .find((project) => project.creationOperationId === plan.operationId);
        if (!registered || registered.id !== current.projectId || registered.creationDigest !== requestDigest
          || registered.rootPath !== directory || registered.archived === true) {
          throw failure('PROJECT_RECORD_CHANGED', 'The original Project registration changed');
        }
        return current;
      }

      await ensureDirectory(plan, requestDigest, directory, current.stage);
      try { await writeFile(join(directory, INITIAL_FILE), initialText(plan), { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
      await setStage(plan.operationId, 'directory_ready');

      const existing = (await list({ includeArchived: true }))
        .find((project) => project.creationOperationId === plan.operationId);
      const project = existing || await create({
        name: plan.name, purpose: plan.purpose, projectType: plan.projectType,
        rootPath: directory, creationOperationId: plan.operationId, creationDigest: requestDigest,
      });
      if (project.creationDigest !== requestDigest || project.rootPath !== directory || project.archived === true) {
        throw failure('PROJECT_OPERATION_CONFLICT', 'Existing Project identity has a different creation request');
      }
      await setStage(plan.operationId, 'project_registered', project.id);
      await setStage(plan.operationId, 'completed', project.id);
      return receipt(plan.operationId);
    });
  }

  async function resume(operationId) {
    const plan = await withDatabase((db) => {
      const row = db.prepare('SELECT plan_json FROM project_bootstrap WHERE operation_id = ?').get(operationId);
      return row ? JSON.parse(row.plan_json) : null;
    });
    if (!plan) return null;
    return ensureForIntake({
      ...plan, newProject: {
        name: plan.name, purpose: plan.purpose, projectType: plan.projectType,
      },
    });
  }

  return { ensureForIntake, receipt, resume };
}

export const defaultProjectBootstrap = createProjectBootstrap();
