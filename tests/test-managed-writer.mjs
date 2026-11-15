#!/usr/bin/env node
// S11 Managed Writer — staging workspace + diff validation + mutation commit.
//
// Covers:
//   - writablePaths-internal add / modify / delete committed to canonical
//   - escape matrix: sibling directory, upward ('..' symlink), absolute path,
//     symlink out of staging, and bad writablePaths declarations
//   - containment consistency with the S1 execution-scope path resolver
//   - canonical commit goes through executeMutation (sorted resource keys)
//   - staging cleanup on success and on escape (no orphan directories)
//   - orchestrator regression: MANAGED_WRITER_ENABLED off keeps the old path,
//     on routes a writer attempt through staging and commits on completion
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const configDir = mkdtempSync(join(tmpdir(), 'ragent-managed-writer-'));
const workRoot = mkdtempSync(join(tmpdir(), 'ragent-managed-writer-work-'));
// Isolate config + work root before importing anything that reads them.
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_WORK_ROOT_DIR = workRoot;
delete process.env.RAGENT_MANAGED_WRITER_ENABLED;

const {
  createStagingWorkspace,
  resolveStagingDiff,
  commitStagingToCanonical,
  discardStaging,
  MANAGED_WRITE_ESCAPE,
} = await import('../chat/managed-writer.mjs');
const { scopeContainsPath } = await import('../chat/execution-scope.mjs');
const { executeMutation: realExecuteMutation } = await import('../chat/mutation-coordinator.mjs');
const { closeWorkspaceLeaseStore } = await import('../chat/workspace-leases.mjs');

let assertionCount = 0;
const a = new Proxy(assert, {
  get(target, prop) {
    const value = target[prop];
    if (typeof value === 'function') {
      return (...args) => {
        assertionCount += 1;
        return value.apply(target, args);
      };
    }
    return value;
  },
});

const createdRoots = [];
function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

// ── tiny helpers (no git, no services, plain fs only) ───────────────────────
function write(root, rel, content) {
  const target = join(root, ...rel.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

async function read(root, rel) {
  return readFile(join(root, ...rel.split('/')), 'utf8');
}

async function exists(root, rel) {
  try {
    await readFile(join(root, ...rel.split('/')));
    return true;
  } catch {
    return false;
  }
}

async function assertStagingGone(stagingDir) {
  let gone = false;
  try {
    const entries = await readdir(stagingDir);
    if (entries.length === 0) gone = true;
  } catch {
    gone = true;
  }
  a.ok(gone, `staging workspace must be discarded (no orphan): ${stagingDir}`);
}

function escapeCode(error) {
  return error && error.code === 'MANAGED_WRITE_ESCAPE';
}

async function makeWriterFixture() {
  const root = makeRoot('ragent-mw-canonical-');
  write(root, 'src/a.txt', 'alpha');
  write(root, 'src/b.txt', 'bravo');
  write(root, 'src/sub/c.txt', 'charlie');
  write(root, 'docs/readme.md', 'read me');
  return root;
}

try {
  // ── 1. writablePaths-internal add / modify / delete commit ────────────────
  {
    const root = await makeWriterFixture();
    const { stagingDir, mapping } = await createStagingWorkspace(root, ['src']);
    a.equal(typeof stagingDir, 'string', 'stagingDir must be a string');
    a.ok(mapping.canonicalCwd, 'mapping must carry canonicalCwd');
    a.deepEqual(mapping.writablePaths, ['src'], 'mapping must carry normalized writablePaths');

    // worker edits in staging
    write(stagingDir, 'src/a.txt', 'ALPHA2');
    write(stagingDir, 'src/new.txt', 'new file');
    // worker deletes src/b.txt
    rmSync(join(stagingDir, 'src/b.txt'));

    const diff = await resolveStagingDiff(stagingDir, root, ['src']);
    const byType = Object.fromEntries(diff.map((change) => [change.type, change.path]));
    a.equal(diff.length, 3, 'staging diff must detect exactly add/modify/delete');
    a.equal(byType.modify, 'src/a.txt', 'modified file detected');
    a.equal(byType.add, 'src/new.txt', 'added file detected');
    a.equal(byType.delete, 'src/b.txt', 'deleted file detected');

    const committed = await commitStagingToCanonical({
      stagingDir,
      canonicalCwd: root,
      writablePaths: ['src'],
    });
    a.equal(committed.committed, true, 'commit must report committed=true');
    a.equal(committed.changes.length, 3, 'commit must report the applied changes');
    a.equal(await read(root, 'src/a.txt'), 'ALPHA2', 'canonical modify applied');
    a.equal(await read(root, 'src/new.txt'), 'new file', 'canonical add applied');
    a.equal(await exists(root, 'src/b.txt'), false, 'canonical delete applied');
    a.equal(await exists(root, 'docs/readme.md'), true, 'non-writable sibling untouched');
    await assertStagingGone(stagingDir);
  }

  // ── 2. escape matrix on the staging diff ──────────────────────────────────
  {
    // 2a. sibling directory outside writablePaths
    const root = await makeWriterFixture();
    const { stagingDir } = await createStagingWorkspace(root, ['src']);
    write(stagingDir, 'other/x.txt', 'escaped sibling');
    await assert.rejects(
      resolveStagingDiff(stagingDir, root, ['src']),
      (error) => escapeCode(error) && error.statusCode === 409 && (error.path === 'other' || error.path === 'other/x.txt'),
      'a file outside writablePaths must raise MANAGED_WRITE_ESCAPE (409)',
    );
    await discardStaging(stagingDir);

    // 2b. upward escape via a '..' symlink
    const rootB = await makeWriterFixture();
    const { stagingDir: stagingB } = await createStagingWorkspace(rootB, ['src']);
    symlinkSync('..', join(stagingB, 'up'));
    await assert.rejects(
      resolveStagingDiff(stagingB, rootB, ['src']),
      (error) => escapeCode(error) && error.statusCode === 409,
      'a symlink resolving above staging must raise MANAGED_WRITE_ESCAPE',
    );
    await discardStaging(stagingB);

    // 2c. absolute-path symlink out of staging
    const rootC = await makeWriterFixture();
    const { stagingDir: stagingC } = await createStagingWorkspace(rootC, ['src']);
    symlinkSync('/etc/passwd', join(stagingC, 'abs'));
    await assert.rejects(
      resolveStagingDiff(stagingC, rootC, ['src']),
      (error) => escapeCode(error) && error.statusCode === 409,
      'a symlink to an absolute external path must raise MANAGED_WRITE_ESCAPE',
    );
    await discardStaging(stagingC);

    // 2d. symlink inside staging is allowed (no escape)
    const rootD = await makeWriterFixture();
    const { stagingDir: stagingD } = await createStagingWorkspace(rootD, ['src']);
    write(stagingD, 'src/alias.txt', 'aliased');
    symlinkSync('alias.txt', join(stagingD, 'src/link.txt'));
    const diffD = await resolveStagingDiff(stagingD, rootD, ['src']);
    a.ok(diffD.some((change) => change.path === 'src/alias.txt' && change.type === 'add'),
      'in-staging file add detected next to an allowed symlink');
    await discardStaging(stagingD);

    // 2e. a relative symlink that stays inside staging but would escape
    // writablePaths once applied to canonical ('../other') is an escape
    const rootE = await makeWriterFixture();
    const { stagingDir: stagingE } = await createStagingWorkspace(rootE, ['src']);
    symlinkSync('../other', join(stagingE, 'src/up.txt'));
    await assert.rejects(
      resolveStagingDiff(stagingE, rootE, ['src']),
      (error) => escapeCode(error) && error.statusCode === 409,
      'a relative symlink escaping writablePaths in canonical must raise MANAGED_WRITE_ESCAPE',
    );
    await discardStaging(stagingE);
  }

  // ── 3. bad writablePaths declarations are rejected at staging creation ────
  {
    const root = await makeWriterFixture();
    await assert.rejects(
      createStagingWorkspace(root, ['../outside']),
      (error) => escapeCode(error) && error.statusCode === 409,
      'a ".." writable path must be rejected',
    );
    await assert.rejects(
      createStagingWorkspace(root, ['src/../escape']),
      (error) => escapeCode(error) && error.statusCode === 409,
      'a writable path containing ".." segments must be rejected',
    );
    await assert.rejects(
      createStagingWorkspace(root, ['/etc/passwd']),
      (error) => escapeCode(error) && error.statusCode === 409,
      'an absolute writable path outside canonical must be rejected',
    );
    await assert.rejects(
      createStagingWorkspace(root, ['src/../outside']),
      (error) => escapeCode(error) && error.statusCode === 409,
      'upward traversal in a writable path must be rejected',
    );
    await assert.rejects(
      createStagingWorkspace(root, ['/tmp']),
      (error) => escapeCode(error) && error.statusCode === 409,
      'an absolute writable path to a sibling of canonical must be rejected',
    );
  }

  // ── 4. containment consistency with execution-scope ───────────────────────
  {
    const root = await makeWriterFixture();
    const { stagingDir } = await createStagingWorkspace(root, ['src']);
    // a valid in-writable write is also contained per S1
    a.equal(await scopeContainsPath(root, join(root, 'src/a.txt')), true,
      'S1 scopeContainsPath agrees an in-writable path is contained');
    // an escaping write is NOT contained per S1
    a.equal(await scopeContainsPath(root, join(root, 'other/x.txt')), false,
      'S1 scopeContainsPath agrees a sibling write is not contained');
    // managed-writer agrees by throwing for the same escaping path
    write(stagingDir, 'other/x.txt', 'escape');
    await assert.rejects(
      resolveStagingDiff(stagingDir, root, ['src']),
      (error) => escapeCode(error) && (error.path === 'other' || error.path === 'other/x.txt'),
      'managed writer escape matches execution-scope non-containment',
    );
    await discardStaging(stagingDir);
  }

  // ── 5. canonical commit goes through executeMutation (sorted keys) ────────
  {
    const root = await makeWriterFixture();
    const { stagingDir } = await createStagingWorkspace(root, ['src']);
    write(stagingDir, 'src/a.txt', 'MUTATED');
    write(stagingDir, 'src/z.txt', 'z file');

    let capturedKeys = null;
    const spyingExecuteMutation = async (args) => {
      capturedKeys = [...args.resourceKeys].sort();
      return realExecuteMutation(args);
    };
    const committed = await commitStagingToCanonical({
      stagingDir,
      canonicalCwd: root,
      writablePaths: ['src'],
      runId: 'sw-run-1',
      executeMutation: spyingExecuteMutation,
    });
    a.equal(committed.committed, true, 'real executeMutation commit succeeds');
    a.ok(Array.isArray(capturedKeys) && capturedKeys.length === 2,
      `executeMutation received per-file resource keys (got ${JSON.stringify(capturedKeys)})`);
    a.deepEqual(capturedKeys, [...capturedKeys].sort(), 'resource keys are sorted (deadlock-free order)');
    a.ok(capturedKeys.some((key) => key.includes('/src/a.txt')), 'modified file key present');
    a.ok(capturedKeys.some((key) => key.includes('/src/z.txt')), 'added file key present');
    a.equal(await read(root, 'src/a.txt'), 'MUTATED', 'canonical updated through executeMutation');
    a.equal(await read(root, 'src/z.txt'), 'z file', 'added file committed through executeMutation');
    await assertStagingGone(stagingDir);
  }

  // ── 6. staging cleanup: escape path leaves no orphan staging dir ──────────
  {
    const root = await makeWriterFixture();
    const { stagingDir } = await createStagingWorkspace(root, ['src']);
    write(stagingDir, 'evil/x.txt', 'escape');
    await assert.rejects(
      commitStagingToCanonical({ stagingDir, canonicalCwd: root, writablePaths: ['src'] }),
      (error) => escapeCode(error),
      'commit of an escaping diff must raise MANAGED_WRITE_ESCAPE',
    );
    await assertStagingGone(stagingDir);
  }

  // ── 7. object-form signatures (task-card API) ─────────────────────────────
  {
    const root = await makeWriterFixture();
    const created = await createStagingWorkspace({ canonicalCwd: root, writablePaths: ['src'] });
    write(created.stagingDir, 'src/a.txt', 'OBJECT');
    const diff = await resolveStagingDiff({ stagingDir: created.stagingDir, canonicalCwd: root, writablePaths: ['src'] });
    a.equal(diff.some((change) => change.path === 'src/a.txt' && change.type === 'modify'), true,
      'object-form resolveStagingDiff works');
    await discardStaging(created.stagingDir);
  }

  // ── 8. orchestrator: flag OFF keeps the pre-S11 path ──────────────────────
  {
    const orchestratorModule = await import('../chat/collaboration-orchestrator.mjs');
    const { createCollaborationOrchestrator } = orchestratorModule;
    const root = { id: 'org-root-off', folder: configDir, projectId: 'prj_test', tool: 'codex', templateId: 'org-manager', sessionPlane: 'organization', delegationDepth: 0 };
    const apps = new Map([
      ['org-manager', { id: 'org-manager', name: 'Manager', tool: 'codex', collaborationPolicy: { role: 'manager', canDelegate: true, allowedAgentIds: ['org-writer'], maxChildren: 4, maxConcurrent: 1, maxDepth: 2, workspacePolicy: 'shared-exclusive', revision: 'org-mgr-r1' } }],
      ['org-writer', { id: 'org-writer', name: 'Writer', tool: 'codex', collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'org-writer-r1' } }],
    ]);
    const sessions = new Map([[root.id, root]]);
    const runs = new Map();
    let childCounter = 0;
    let runCounter = 0;
    const stagingCalls = [];
    const commitCalls = [];
    const createdSessions = [];

    const offOrchestrator = createCollaborationOrchestrator({
      pollMs: 100000,
      managedWriterEnabled: false,
      dependencies: {
        getSession: async (id) => sessions.get(id) || null,
        getApp: async (id) => apps.get(id) || null,
        createSession: async (folder, tool, name, extra) => {
          const session = { id: `org-child-${++childCounter}`, folder, tool, name, ...extra };
          sessions.set(session.id, session);
          createdSessions.push(session);
          return session;
        },
        sendMessage: async (sessionId, text, _images, options) => {
          const run = { id: `off-run-${++runCounter}`, sessionId, state: 'running', requestId: options.requestId, result: null };
          runs.set(run.id, run);
          return { session: sessions.get(sessionId), run, prompt: text };
        },
        getRunState: async (id) => runs.get(id) || null,
        getRun: async (id) => runs.get(id) || null,
        getRunResult: async (id) => runs.get(id)?.result || null,
        getRunManifest: async () => ({ folder: configDir }),
        listRunIds: async () => [...runs.keys()],
        getProject: async () => ({ id: 'prj_test', rootPath: configDir, scopeMode: 'shared', revision: 1 }),
        requestRunCancel: async (id) => { const run = runs.get(id); if (run) run.state = 'cancelled'; return run || null; },
        loadHistory: async () => [{ type: 'message', role: 'assistant', content: 'off-path report' }],
        createStagingWorkspace: async () => { stagingCalls.push('create'); return { stagingDir: `${configDir}/sw_off`, mapping: { canonicalCwd: configDir, writablePaths: ['src'] } }; },
        commitStagingToCanonical: async () => { commitCalls.push('commit'); return { changes: [], committed: false }; },
        discardStaging: async () => true,
      },
    });
    try {
      const plan = {
        title: 'flag off',
        tasks: [{ id: 'off-writer', agentId: 'org-writer', objective: 'write nothing', acceptance: ['ok'], writablePaths: ['src'], accessMode: 'write' }],
      };
      const collaboration = await offOrchestrator.dispatch({ rootSessionId: root.id, plan, idempotencyKey: 'managed-writer-off-test' });
      a.equal(stagingCalls.length, 0, 'flag OFF must not create a staging workspace');
      const childSession = createdSessions[0];
      a.equal(childSession.folder, configDir, 'flag OFF keeps the canonical session folder');
      a.ok(!childSession.sourceContext || !childSession.sourceContext.managedWriter,
        'flag OFF must not attach a managedWriter sourceContext');
      const runId = collaboration.tasks[0].runId;
      runs.get(runId).state = 'completed';
      runs.get(runId).result = { exitCode: 0, completedAt: new Date().toISOString(), synthesized: true };
      a.equal(await offOrchestrator.completeRun(runId), true, 'flag OFF completes the attempt through the old path');
      a.equal(commitCalls.length, 0, 'flag OFF must not invoke the managed commit');
      a.equal((await offOrchestrator.get(collaboration.id)).tasks[0].state, 'succeeded');
    } finally {
      offOrchestrator.stop();
    }
  }

  // ── 9. orchestrator: flag ON routes a writer attempt through staging ──────
  {
    const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');
    const root = { id: 'org-root-on', folder: configDir, projectId: 'prj_test', tool: 'codex', templateId: 'org-manager', sessionPlane: 'organization', delegationDepth: 0 };
    const apps = new Map([
      ['org-manager', { id: 'org-manager', name: 'Manager', tool: 'codex', collaborationPolicy: { role: 'manager', canDelegate: true, allowedAgentIds: ['org-writer'], maxChildren: 4, maxConcurrent: 1, maxDepth: 2, workspacePolicy: 'shared-exclusive', revision: 'org-mgr-r1' } }],
      ['org-writer', { id: 'org-writer', name: 'Writer', tool: 'codex', collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'org-writer-r1' } }],
    ]);
    const sessions = new Map([[root.id, root]]);
    const runs = new Map();
    let childCounter = 0;
    let runCounter = 0;
    const createdSessions = [];
    const commitArgs = [];

    const onOrchestrator = createCollaborationOrchestrator({
      pollMs: 100000,
      managedWriterEnabled: true,
      dependencies: {
        getSession: async (id) => sessions.get(id) || null,
        getApp: async (id) => apps.get(id) || null,
        createSession: async (folder, tool, name, extra) => {
          const session = { id: `org-child-${++childCounter}`, folder, tool, name, ...extra };
          sessions.set(session.id, session);
          createdSessions.push(session);
          return session;
        },
        sendMessage: async (sessionId, text, _images, options) => {
          const run = { id: `on-run-${++runCounter}`, sessionId, state: 'running', requestId: options.requestId, result: null };
          runs.set(run.id, run);
          return { session: sessions.get(sessionId), run, prompt: text };
        },
        getRunState: async (id) => runs.get(id) || null,
        getRun: async (id) => runs.get(id) || null,
        getRunResult: async (id) => runs.get(id)?.result || null,
        getRunManifest: async () => ({ folder: configDir }),
        listRunIds: async () => [...runs.keys()],
        getProject: async () => ({ id: 'prj_test', rootPath: configDir, scopeMode: 'shared', revision: 1 }),
        requestRunCancel: async (id) => { const run = runs.get(id); if (run) run.state = 'cancelled'; return run || null; },
        loadHistory: async () => [{ type: 'message', role: 'assistant', content: 'on-path report' }],
        createStagingWorkspace: async ({ canonicalCwd, writablePaths }) => ({
          stagingDir: `${configDir}/sw_on`,
          mapping: { canonicalCwd, writablePaths },
        }),
        commitStagingToCanonical: async (args) => {
          commitArgs.push(args);
          return { committed: true, changes: [{ path: 'src/a.txt', type: 'modify' }] };
        },
        discardStaging: async () => true,
      },
    });
    try {
      const plan = {
        title: 'flag on',
        tasks: [{ id: 'on-writer', agentId: 'org-writer', objective: 'write src', acceptance: ['ok'], writablePaths: ['src'], accessMode: 'write' }],
      };
      const collaboration = await onOrchestrator.dispatch({ rootSessionId: root.id, plan, idempotencyKey: 'managed-writer-on-test' });
      const childSession = createdSessions[0];
      a.equal(childSession.folder, `${configDir}/sw_on`, 'flag ON points the worker cwd at the staging workspace');
      a.ok(childSession.sourceContext && childSession.sourceContext.managedWriter,
        'flag ON attaches a managedWriter sourceContext');
      a.equal(childSession.sourceContext.managedWriter.canonicalCwd, configDir, 'sourceContext records canonicalCwd');
      a.deepEqual(childSession.sourceContext.managedWriter.writablePaths, ['src'], 'sourceContext records writablePaths');
      a.ok(!Object.prototype.hasOwnProperty.call(childSession, 'projectId') || childSession.projectId === undefined,
        'managed writer child session must not be rebound to the canonical project root');

      const runId = collaboration.tasks[0].runId;
      runs.get(runId).state = 'completed';
      runs.get(runId).result = { exitCode: 0, completedAt: new Date().toISOString(), synthesized: true };
      a.equal(await onOrchestrator.completeRun(runId), true, 'flag ON completes the attempt');
      a.equal(commitArgs.length, 1, 'managed commit is invoked on completion');
      a.equal(commitArgs[0].canonicalCwd, configDir, 'managed commit targets the canonical workspace');
      a.deepEqual(commitArgs[0].writablePaths, ['src'], 'managed commit validates writablePaths');
      a.equal((await onOrchestrator.get(collaboration.id)).tasks[0].state, 'succeeded', 'attempt succeeds after managed commit');
    } finally {
      onOrchestrator.stop();
    }
  }

  // ── 10. orchestrator: MANAGED_WRITE_ESCAPE fails the attempt ──────────────
  {
    const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');
    const root = { id: 'org-root-esc', folder: configDir, projectId: 'prj_test', tool: 'codex', templateId: 'org-manager', sessionPlane: 'organization', delegationDepth: 0 };
    const apps = new Map([
      ['org-manager', { id: 'org-manager', name: 'Manager', tool: 'codex', collaborationPolicy: { role: 'manager', canDelegate: true, allowedAgentIds: ['org-writer'], maxChildren: 4, maxConcurrent: 1, maxDepth: 2, workspacePolicy: 'shared-exclusive', revision: 'org-mgr-r1' } }],
      ['org-writer', { id: 'org-writer', name: 'Writer', tool: 'codex', collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'org-writer-r1' } }],
    ]);
    const sessions = new Map([[root.id, root]]);
    const runs = new Map();
    let childCounter = 0;
    let runCounter = 0;
    let stagedSessionId = '';

    const escOrchestrator = createCollaborationOrchestrator({
      pollMs: 100000,
      managedWriterEnabled: true,
      dependencies: {
        getSession: async (id) => sessions.get(id) || null,
        getApp: async (id) => apps.get(id) || null,
        createSession: async (folder, tool, name, extra) => {
          const session = { id: `org-child-${++childCounter}`, folder, tool, name, ...extra };
          sessions.set(session.id, session);
          stagedSessionId = session.id;
          return session;
        },
        sendMessage: async (sessionId, text, _images, options) => {
          const run = { id: `esc-run-${++runCounter}`, sessionId, state: 'running', requestId: options.requestId, result: null };
          runs.set(run.id, run);
          return { session: sessions.get(sessionId), run, prompt: text };
        },
        getRunState: async (id) => runs.get(id) || null,
        getRun: async (id) => runs.get(id) || null,
        getRunResult: async (id) => runs.get(id)?.result || null,
        getRunManifest: async () => ({ folder: configDir }),
        listRunIds: async () => [...runs.keys()],
        getProject: async () => ({ id: 'prj_test', rootPath: configDir, scopeMode: 'shared', revision: 1 }),
        requestRunCancel: async (id) => { const run = runs.get(id); if (run) run.state = 'cancelled'; return run || null; },
        loadHistory: async () => [{ type: 'message', role: 'assistant', content: 'escape report' }],
        createStagingWorkspace: async ({ canonicalCwd, writablePaths }) => ({
          stagingDir: `${configDir}/sw_esc`,
          mapping: { canonicalCwd, writablePaths },
        }),
        commitStagingToCanonical: async () => {
          const error = new Error('staging diff escapes writablePaths');
          error.code = 'MANAGED_WRITE_ESCAPE';
          error.statusCode = 409;
          throw error;
        },
        discardStaging: async () => true,
      },
    });
    try {
      const plan = {
        title: 'escape',
        tasks: [{ id: 'esc-writer', agentId: 'org-writer', objective: 'escape', acceptance: ['ok'], writablePaths: ['src'], accessMode: 'write' }],
      };
      const collaboration = await escOrchestrator.dispatch({ rootSessionId: root.id, plan, idempotencyKey: 'managed-writer-escape-test' });
      const runId = collaboration.tasks[0].runId;
      runs.get(runId).state = 'completed';
      runs.get(runId).result = { exitCode: 0, completedAt: new Date().toISOString(), synthesized: true };
      a.equal(await escOrchestrator.completeRun(runId), true, 'escape still completes the run-handling step');
      const after = await escOrchestrator.get(collaboration.id);
      a.equal(after.attempts[0].state, 'failed', 'MANAGED_WRITE_ESCAPE fails the attempt');
      a.ok(after.attempts[0].failureReason && after.attempts[0].failureReason.includes('MANAGED_WRITE_ESCAPE'),
        'failure reason carries MANAGED_WRITE_ESCAPE');
      a.equal(after.tasks[0].state, 'failed', 'escape marks the task failed');
    } finally {
      escOrchestrator.stop();
    }
  }

  await closeWorkspaceLeaseStore();
  console.log(`test-managed-writer: ok (${assertionCount} assertions)`);
} finally {
  await closeWorkspaceLeaseStore().catch(() => {});
  for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
}
