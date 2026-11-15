// Collaboration Workspace safety (Execution-Scope slice 6, design section 9).
//
// Path checks no longer use string startsWith / simple slash normalization or
// lexical resolve concatenation. Containment is decided by the S1-shipped
// chat/execution-scope.mjs path resolver: the workspace root is realpath()'d
// and every writable path is resolved to its real path (deepest existing
// ancestor + remainder for planned files) before a path.relative() comparison.
//
// validateWorkspacePlan is now async (realpath is async). Its export
// signature is otherwise unchanged; `mode` stays as a legacy projection and
// the new accessMode / executionIsolation fields win when present.
import { execFile as execFileCallback } from 'child_process';
import { mkdir, rm } from 'fs/promises';
import { promisify } from 'util';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'path';
import { tmpdir } from 'os';
import { realpath } from 'fs/promises';

import { resolveRealRoot } from './execution-scope.mjs';
import { projectWorkspacePolicy } from './collaboration-policy.mjs';

const execFile = promisify(execFileCallback);
const WRITABLE_MODES = new Set(['shared-exclusive', 'git-worktree']);
const ACCESS_MODES = new Set(['read', 'write']);
const EXECUTION_ISOLATIONS = new Set(['shared', 'worktree', 'container']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isContained(rootRealPath, candidateRealPath) {
  const rel = relative(rootRealPath, candidateRealPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Realpath the deepest existing ancestor, then re-append the missing tail.
// This keeps planned (not-yet-existing) writable paths checkable while still
// failing closed on symlinks that escape the workspace root.
async function realPathOfCandidate(candidate, platform = process.platform) {
  const paths = platform === 'win32' ? win32 : posix;
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

async function normalizePath(rootRealPath, rootPath, value) {
  const raw = text(value);
  if (!raw) return '';
  const candidate = resolve(text(rootPath) || process.cwd(), raw);
  const realCandidate = await realPathOfCandidate(candidate);
  if (!isContained(rootRealPath, realCandidate)) {
    const error = new Error(`Workspace path escapes project root: ${value}`);
    error.code = 'PROJECT_SCOPE_ESCAPE';
    throw error;
  }
  return realCandidate;
}

// Both sides are already realpath-normalized; overlap is containment via
// path.relative() on real paths (never string startsWith).
function overlaps(left, right) {
  if (!left || !right) return false;
  return left === right || isContained(left, right) || isContained(right, left);
}

export async function validateWorkspacePlan({ rootPath, mode = 'shared-exclusive', accessMode, executionIsolation, tasks = [] } = {}) {
  const normalizedMode = text(mode).toLowerCase() || 'shared-exclusive';
  if (!WRITABLE_MODES.has(normalizedMode) && normalizedMode !== 'read-only-review') {
    const error = new Error(`Unsupported collaboration workspace mode: ${normalizedMode}`);
    error.code = 'COLLABORATION_WORKSPACE_POLICY';
    throw error;
  }
  const projected = projectWorkspacePolicy(normalizedMode);
  const effectiveAccessMode = ACCESS_MODES.has(text(accessMode).toLowerCase())
    ? text(accessMode).toLowerCase()
    : projected.accessMode;
  const effectiveIsolation = EXECUTION_ISOLATIONS.has(text(executionIsolation).toLowerCase())
    ? text(executionIsolation).toLowerCase()
    : projected.executionIsolation;

  const root = resolve(text(rootPath) || process.cwd());
  const realRoot = await resolveRealRoot(root);

  const writers = [];
  for (const task of tasks) {
    const paths = [];
    for (const raw of Array.isArray(task?.writablePaths) ? task.writablePaths : []) {
      paths.push(await normalizePath(realRoot, root, raw));
    }
    const taskAccessMode = ACCESS_MODES.has(text(task?.accessMode).toLowerCase())
      ? text(task.accessMode).toLowerCase()
      : effectiveAccessMode;
    const taskIsolation = EXECUTION_ISOLATIONS.has(text(task?.executionIsolation).toLowerCase())
      ? text(task.executionIsolation).toLowerCase()
      : effectiveIsolation;
    if (task?.role === 'reviewer' && paths.length > 0) {
      const error = new Error(`Reviewer task cannot write: ${task.id}`);
      error.code = 'COLLABORATION_REVIEWER_WRITE';
      throw error;
    }
    if (taskAccessMode === 'read' && paths.length > 0) {
      const error = new Error('read-only task cannot declare writable paths; read-only-review does not permit writer tasks');
      error.code = 'COLLABORATION_WORKSPACE_CONFLICT';
      throw error;
    }
    if (effectiveAccessMode === 'read' && taskAccessMode === 'write') {
      const error = new Error('read-only collaboration policy does not permit writer tasks');
      error.code = 'COLLABORATION_WORKSPACE_CONFLICT';
      throw error;
    }
    if (paths.length > 0 && taskAccessMode === 'write') {
      writers.push({ task, paths, executionIsolation: taskIsolation });
    }
  }
  const sharedWriters = writers.filter((writer) => writer.executionIsolation === 'shared');
  if (sharedWriters.length > 1) {
    const error = new Error('shared-exclusive permits at most one writer task');
    error.code = 'COLLABORATION_WORKSPACE_CONFLICT';
    throw error;
  }
  if (sharedWriters.length > 1) {
    for (let index = 0; index < sharedWriters.length; index += 1) {
      for (let other = index + 1; other < sharedWriters.length; other += 1) {
        if (sharedWriters[index].paths.some((left) => sharedWriters[other].paths.some((right) => overlaps(left, right)))) {
          const error = new Error(`Writable path overlap between ${sharedWriters[index].task.id} and ${sharedWriters[other].task.id}`);
          error.code = 'COLLABORATION_WORKSPACE_CONFLICT';
          throw error;
        }
      }
    }
  }
  return {
    mode: normalizedMode,
    accessMode: effectiveAccessMode,
    executionIsolation: effectiveIsolation,
    rootPath: root,
    realRootPath: realRoot,
    writers: writers.map(({ task, paths, executionIsolation: taskIsolation }) => ({
      taskId: task.id,
      paths,
      executionIsolation: taskIsolation,
    })),
  };
}

export function buildWorktreePath(rootPath, collaborationId, taskId) {
  const rootName = basename(resolve(text(rootPath) || process.cwd()));
  const safe = (value) => text(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'task';
  return join(tmpdir(), 'ragent-collaboration-worktrees', safe(rootName), safe(collaborationId), safe(taskId));
}

export async function createGitWorktree({ rootPath, collaborationId, taskId, ref = 'HEAD', execFileFn = execFile } = {}) {
  const projectRoot = resolve(text(rootPath) || process.cwd());
  const worktreePath = buildWorktreePath(projectRoot, collaborationId, taskId);
  await mkdir(join(worktreePath, '..'), { recursive: true });
  await execFileFn('git', ['-C', projectRoot, 'worktree', 'add', '--detach', worktreePath, text(ref) || 'HEAD'], {
    cwd: projectRoot,
    maxBuffer: 1024 * 1024,
  });
  return worktreePath;
}

export async function removeGitWorktree({ rootPath, worktreePath, execFileFn = execFile } = {}) {
  const projectRoot = resolve(text(rootPath) || process.cwd());
  const target = resolve(text(worktreePath));
  const worktreeRoot = resolve(tmpdir(), 'ragent-collaboration-worktrees');
  const targetRelative = relative(worktreeRoot, target);
  if (!target || targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) return false;
  await execFileFn('git', ['-C', projectRoot, 'worktree', 'remove', '--force', target], {
    cwd: projectRoot,
    maxBuffer: 1024 * 1024,
  });
  await rm(target, { recursive: true, force: true });
  return true;
}
