#!/usr/bin/env node
// Execution-Scope slice 6: collaboration path safety + enum split compat.
//
// validateWorkspacePlan now resolves realpaths (deepest existing ancestor +
// remainder) and decides containment with path.relative(), never string
// startsWith or slash normalization: /repo/app vs /repo/application are not
// confused, symlink/.. escapes are rejected, and a symlink inside the root is
// accepted. The legacy workspacePolicy enum projects into accessMode /
// executionIsolation with the new fields winning. A small orchestrator
// fixture exercises the S4 reader-certification gate (uncertified reader
// refused, certified reader admitted).
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-collab-workspace-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const {
  validateWorkspacePlan,
  buildWorktreePath,
  removeGitWorktree,
} = await import('../chat/collaboration-workspace.mjs');
const {
  normalizeCollaborationPolicy,
  projectWorkspacePolicy,
  compatWorkspacePolicy,
} = await import('../chat/collaboration-policy.mjs');
const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');

let totalAssertions = 0;
function ok(value, message) { totalAssertions += 1; assert.ok(value, message); }
function eq(actual, expected, message) { totalAssertions += 1; assert.equal(actual, expected, message); }
function deepEq(actual, expected, message) { totalAssertions += 1; assert.deepEqual(actual, expected, message); }
async function rejects(promiseFactory, predicate, message) {
  totalAssertions += 1;
  await assert.rejects(promiseFactory, predicate, message);
}

const createdDirs = [configDir];
function makeRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

// ── legacy behavior preserved (now async) ─────────────────────────────────
{
  const root = '/home/example/ragent-dev';
  const single = await validateWorkspacePlan({
    rootPath: root,
    tasks: [{ id: 'one', role: 'specialist', writablePaths: ['chat/a'] }],
  });
  eq(single.writers.length, 1, 'single writer is admitted');
  await rejects(
    () => validateWorkspacePlan({
      rootPath: root,
      tasks: [
        { id: 'one', role: 'specialist', writablePaths: ['chat/a'] },
        { id: 'two', role: 'specialist', writablePaths: ['chat/b'] },
      ],
    }),
    /at most one writer/,
    'two shared writers are refused',
  );
  await rejects(
    () => validateWorkspacePlan({
      rootPath: root,
      tasks: [{ id: 'review', role: 'reviewer', writablePaths: ['chat'] }],
    }),
    /Reviewer task cannot write/,
    'reviewer writablePaths are refused',
  );
  await rejects(
    () => validateWorkspacePlan({
      rootPath: root,
      tasks: [{ id: 'escape', role: 'specialist', writablePaths: ['../outside'] }],
    }),
    /escapes project root/,
    '.. escape is refused',
  );
  assert.match(buildWorktreePath(root, 'collab-1', 'task/a'), /ragent-collaboration-worktrees/);
  let removed = false;
  await removeGitWorktree({
    rootPath: root,
    worktreePath: '/tmp/ragent-collaboration-worktrees/test/collab/task',
    execFileFn: async () => { removed = true; },
  });
  eq(removed, true, 'worktree removal guard passes');
}

// ── path safety matrix: realpath + relative, no prefix confusion ──────────
{
  const root = makeRoot('ragent-collab-path-root-');
  const outside = makeRoot('ragent-collab-outside-');
  mkdirSync(join(root, 'app'), { recursive: true });
  mkdirSync(join(root, 'application'), { recursive: true });
  mkdirSync(join(root, 'app', 'sub'), { recursive: true });
  symlinkSync(outside, join(root, 'link-outside'));
  symlinkSync(join(root, 'app'), join(root, 'link-inside'));

  // /app vs /application are siblings — never a parent/child relationship.
  const worktree = await validateWorkspacePlan({
    rootPath: root,
    mode: 'git-worktree',
    tasks: [
      { id: 'w1', role: 'specialist', writablePaths: ['app'] },
      { id: 'w2', role: 'specialist', writablePaths: ['application'] },
    ],
  });
  eq(worktree.writers.length, 2, 'worktree mode admits parallel writers with disjoint paths');
  eq(worktree.mode, 'git-worktree');

  // A real parent/child overlap (app vs app/sub) is fine under worktree
  // isolation (each writer owns a separate worktree); only the sibling
  // confusion (/app vs /application) is what must never be detected as an
  // overlap under the shared default.
  const nested = await validateWorkspacePlan({
    rootPath: root,
    mode: 'git-worktree',
    tasks: [
      { id: 'w1', role: 'specialist', writablePaths: ['app'] },
      { id: 'w2', role: 'specialist', writablePaths: ['app/sub'] },
    ],
  });
  eq(nested.writers.length, 2, 'worktree isolation admits overlapping writable paths');

  // Symlink escaping the root is rejected; a symlink staying inside is fine.
  await rejects(
    () => validateWorkspacePlan({
      rootPath: root,
      tasks: [{ id: 'link', role: 'specialist', writablePaths: ['link-outside'] }],
    }),
    (error) => error.code === 'PROJECT_SCOPE_ESCAPE' && /escapes project root/.test(error.message),
    'a symlink escaping the workspace root is refused',
  );
  const inside = await validateWorkspacePlan({
    rootPath: root,
    tasks: [{ id: 'inside', role: 'specialist', writablePaths: ['link-inside'] }],
  });
  eq(inside.writers.length, 1, 'a symlink resolving inside the root is admitted');
  eq(inside.realRootPath, root, 'validateWorkspacePlan exposes the real workspace root');

  // New accessMode field wins: read-only refuses any writer.
  await rejects(
    () => validateWorkspacePlan({
      rootPath: root,
      accessMode: 'read',
      executionIsolation: 'shared',
      tasks: [{ id: 'reader', role: 'specialist', writablePaths: ['app'] }],
    }),
    /does not permit writer tasks/,
    'accessMode read refuses writer tasks even under a legacy shared label',
  );
}

// ── enum split: legacy projection + new fields win ────────────────────────
{
  const readOnly = normalizeCollaborationPolicy({ role: 'manager', canDelegate: true, workspacePolicy: 'read-only-review' });
  eq(readOnly.accessMode, 'read', 'read-only-review projects to accessMode read');
  eq(readOnly.executionIsolation, 'shared', 'read-only-review projects to executionIsolation shared');
  eq(readOnly.workspacePolicy, 'read-only-review', 'workspacePolicy stays as the legacy projection');

  const worktree = normalizeCollaborationPolicy({ role: 'manager', canDelegate: true, workspacePolicy: 'git-worktree' });
  eq(worktree.accessMode, 'write', 'git-worktree projects to accessMode write');
  eq(worktree.executionIsolation, 'worktree', 'git-worktree projects to executionIsolation worktree');

  const shared = normalizeCollaborationPolicy({ role: 'manager', canDelegate: true, workspacePolicy: 'shared-exclusive' });
  eq(shared.accessMode, 'write');
  eq(shared.executionIsolation, 'shared');

  const newWins = normalizeCollaborationPolicy({
    role: 'manager',
    canDelegate: true,
    workspacePolicy: 'read-only-review',
    accessMode: 'write',
  });
  eq(newWins.accessMode, 'write', 'the new accessMode field wins over the legacy projection');
  eq(newWins.executionIsolation, 'shared', 'executionIsolation still derives from the legacy projection');
  eq(newWins.workspacePolicy, 'read-only-review', 'workspacePolicy label is preserved for old readers');

  deepEq(projectWorkspacePolicy('read-only-review'), { accessMode: 'read', executionIsolation: 'shared', workspacePolicy: 'read-only-review' });
  eq(compatWorkspacePolicy('write', 'worktree'), 'git-worktree');
  eq(compatWorkspacePolicy('read', 'shared'), 'read-only-review');
  eq(compatWorkspacePolicy('write', 'shared'), 'shared-exclusive');
}

// ── S4 reader certification gate through the orchestrator ─────────────────
{
  const apps = new Map([
    ['manager-agent', {
      id: 'manager-agent',
      name: 'Manager',
      tool: 'codex',
      collaborationPolicy: {
        role: 'manager', canDelegate: true, allowedAgentIds: ['specialist-agent'],
        maxConcurrent: 1, workspacePolicy: 'read-only-review', revision: 'm1',
      },
    }],
    ['specialist-agent', {
      id: 'specialist-agent',
      name: 'Specialist',
      tool: 'codex',
      collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 's1' },
    }],
  ]);
  const rootSession = {
    id: 'reader-root',
    folder: configDir,
    tool: 'codex',
    templateId: 'manager-agent',
    name: 'Reader Manager',
    projectId: 'prj_reader',
    delegationDepth: 0,
  };
  const sessions = new Map([[rootSession.id, rootSession]]);
  const runs = new Map();
  let childCounter = 0;
  let runCounter = 0;

  function makeOrchestrator(overrides = {}) {
    return createCollaborationOrchestrator({
      pollMs: 100000,
      dependencies: {
        getSession: async (id) => sessions.get(id) || null,
        getApp: async (id) => apps.get(id) || null,
        getProject: async () => ({ id: 'prj_reader', rootPath: configDir }),
        createSession: async (_folder, tool, name, extra) => {
          const session = { id: `reader-child-${++childCounter}`, folder: configDir, tool, name, ...extra };
          sessions.set(session.id, session);
          return session;
        },
        sendMessage: async (sessionId, _text, _images, options) => {
          const run = { id: `reader-run-${++runCounter}`, sessionId, state: 'running', requestId: options.requestId, result: null };
          runs.set(run.id, run);
          return { session: sessions.get(sessionId), run, prompt: _text };
        },
        getRunState: async (id) => runs.get(id) || null,
        getRun: async (id) => runs.get(id) || null,
        getRunResult: async () => null,
        getRunManifest: async () => ({ folder: configDir }),
        listRunIds: async () => [...runs.keys()],
        requestRunCancel: async () => null,
        loadHistory: async () => [],
        ...overrides,
      },
    });
  }

  const plan = {
    title: 'reader certification',
    tasks: [{ id: 'read-task', agentId: 'specialist-agent', objective: 'review only' }],
  };

  // Default runtime-adapter is honest: a local runner is never a certified
  // read-only runtime, so the reader task is refused (READ_ONLY_RUNTIME_UNAVAILABLE).
  const uncertified = makeOrchestrator();
  const refused = await uncertified.dispatch({ rootSessionId: rootSession.id, plan, idempotencyKey: 'reader-uncertified' });
  const refusedTask = refused.tasks.find((task) => task.id === 'read-task');
  eq(refusedTask.state, 'failed', 'uncertified reader task is refused');
  eq(refusedTask.projectId, 'prj_reader', 'task is bound to the session project');
  eq(refused.attempts[0].failureKind, 'deterministic_failure', 'reader refusal is deterministic');
  ok(refused.attempts[0].failureReason.includes('READ_ONLY_RUNTIME_UNAVAILABLE'), 'refusal reason carries the frozen error code');
  uncertified.stop();

  // A certified read-only runtime (S4 adapter declaration) admits the reader.
  const certified = makeOrchestrator({
    resolveRuntimeReadOnlyCapability: async () => ({
      runtimeId: 'runtime_certified_reader',
      supportsReadOnlyFilesystem: true,
      enforcement: 'sandbox',
      note: 'test-certified',
    }),
  });
  const admitted = await certified.dispatch({
    rootSessionId: rootSession.id,
    plan: { ...plan, tasks: [{ id: 'read-task-2', agentId: 'specialist-agent', objective: 'review only' }] },
    idempotencyKey: 'reader-certified',
  });
  eq(admitted.tasks.find((task) => task.id === 'read-task-2').state, 'running', 'certified reader task is admitted');
  certified.stop();
}

try {
  console.log('test-collaboration-workspace: ok');
} finally {
  console.log(`COLLABORATION_WORKSPACE_ASSERTIONS ${totalAssertions}`);
  for (const dir of createdDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
