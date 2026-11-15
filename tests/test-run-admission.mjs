#!/usr/bin/env node
// Execution-Scope slice 2: unified Run admission (prepareRunExecution).
//
// Covers the frozen admission contract: project-bound runs get an immutable
// ExecutionScopeSnapshot + digest in the manifest; unresolved workspace roots
// fail with WORKSPACE_ROOT_UNRESOLVED; a revision change between resolve and
// verify fails with EXECUTION_SCOPE_STALE; internal operations and sessions
// without a project binding stay legacy; regenerate/editResend are project-
// bound new runs (never legacy, never reuse the parent snapshot).
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-run-admission-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const {
  createProject,
  updateProject,
  getProject,
} = await import('../chat/projects.mjs');
const {
  prepareRunExecution,
  isInternalLegacyRun,
  buildRunRiskContext,
} = await import('../chat/run-admission.mjs');
const { computeExecutionScopeDigest } = await import('../chat/execution-scope.mjs');
const { resolveRunRiskContext } = await import('../chat/runner-sidecar.mjs');
const { decideWindowsApproval } = await import('../chat/windows-approval-gate.mjs');

const createdDirs = [];
function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function makeSession(id, folder, projectId) {
  return { id, folder, projectId, templateId: `app_${id}` };
}

function makeManifest(overrides = {}) {
  return {
    sessionId: 's1',
    requestId: 'req_1',
    folder: '/tmp/unused',
    tool: 'micro-agent',
    prompt: 'hello',
    ...overrides,
  };
}

try {
  // ── success path: snapshot + digest attached ──────────────────────────────
  const rootA = makeDir('ragent-adm-root-a-');
  mkdirSync(join(rootA, '.git'), { recursive: true }); // non-git is fine too
  const project = await createProject({ name: 'Admission A', rootPath: rootA });
  const session = makeSession('s1', rootA, project.id);
  const manifest = makeManifest({ sessionId: 's1', folder: rootA });
  const first = await prepareRunExecution({ sessionId: 's1', session, manifest });
  assert.equal(first.legacy, false, 'a project-bound run must not be legacy');
  assert.ok(first.executionScope, 'admission must return the frozen snapshot');
  assert.ok(first.executionScope.snapshotId.startsWith('ess_'), 'snapshotId should use the ess_ prefix');
  assert.equal(first.executionScope.projectId, project.id, 'snapshot should freeze the project id');
  assert.equal(first.executionScope.sessionId, 's1', 'snapshot should freeze the session id');
  assert.ok(first.executionScope.workspaceId.startsWith('ws_'), 'snapshot should freeze the workspace id');
  assert.equal(first.executionScope.workspaceRoot.realPath, rootA, 'workspaceRoot.realPath should be the realpath');
  assert.equal(first.executionScope.cwd.realPath, rootA, 'cwd should default to the workspace root for shared scope');
  assert.equal(first.executionScope.scopeMode, 'shared');
  assert.equal(first.executionScope.accessMode, 'write');
  assert.equal(first.executionScope.executionIsolation, 'shared');
  assert.equal(first.executionScope.projectRevision, project.revision, 'snapshot should freeze the project revision');
  assert.ok(first.executionScope.workspaceRevision >= 1, 'snapshot should freeze the workspace revision');
  assert.equal(first.executionScope.riskContext.schemaVersion, 1, 'snapshot should carry risk context schema');
  assert.equal(first.executionScope.riskContext.trustedWorkspaceRoot, rootA,
    'risk context should bind the trusted workspace root');
  assert.equal(first.executionScope.riskContext.cwd, rootA,
    'risk context should bind the frozen cwd');
  assert.ok(first.executionScope.riskContext.protectedRoots.includes(configDir),
    'risk context should protect the instance config root');
  const platformSystemRoot = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows') : '/var';
  assert.ok(first.executionScope.riskContext.systemPathRoots.includes(platformSystemRoot),
    'risk context should carry platform system roots');
  assert.equal(first.executionScopeDigest, first.manifest.executionScopeDigest, 'digest should be attached to the manifest');
  assert.equal(first.manifest.executionScope, first.executionScope, 'manifest should carry the same snapshot object');
  assert.equal(first.manifest.legacyExecutionScope, false);
  if (process.platform === 'win32') {
    const binding = resolveRunRiskContext(first.manifest);
    assert.equal(binding.valid, true, `the sidecar must accept the actual admitted snapshot: ${binding.reason}`);
    for (const riskMode of ['recommended', 'full-auto']) {
      const state = { riskMode, cwd: rootA, riskContext: binding.riskContext, riskContextValid: binding.valid };
      const ordinary = await decideWindowsApproval({ providerMethod: 'can_use_tool', params: {
        tool_name: 'Write', input: { file_path: join(rootA, 'report.md') },
      } }, state);
      assert.equal(ordinary.decision, 'auto-allow', `${riskMode} should approve an ordinary write`);
      const protectedWrite = await decideWindowsApproval({ providerMethod: 'can_use_tool', params: {
        tool_name: 'Write', input: { file_path: join(configDir, 'protected.md') },
      } }, state);
      assert.equal(protectedWrite.decision, 'prompt', `${riskMode} should review a protected write`);
    }
  }

  // Run admission no longer takes a workspace lease (mutation-scoped lease
  // redesign): no lease field, no workspaceLeaseId on the manifest. Runs can
  // coexist on the same Workspace without blocking each other.
  assert.equal(first.lease, undefined, 'admission must not return a run-scoped lease');
  assert.equal(first.manifest.workspaceLeaseId, undefined, 'manifest must not carry a workspace lease id');

  // digest is stable for identical inputs (snapshotId/createdAt excluded)
  const second = await prepareRunExecution({ sessionId: 's1', session, manifest });
  assert.equal(second.executionScopeDigest, first.executionScopeDigest,
    'identical state should produce an identical digest');
  assert.notEqual(second.executionScope.snapshotId, first.executionScope.snapshotId,
    'every run must get a fresh snapshotId');
  const recomputed = computeExecutionScopeDigest(first.executionScope);
  assert.equal(recomputed, first.executionScopeDigest, 'digest should be reproducible from the snapshot');
  const tamperedScope = {
    ...first.executionScope,
    riskContext: { ...first.executionScope.riskContext, trustedWorkspaceRoot: '/tmp/attacker-root' },
  };
  assert.notEqual(computeExecutionScopeDigest(tamperedScope), first.executionScopeDigest,
    'changing the risk context must invalidate the execution scope digest');

  const manuallyBuiltRiskContext = buildRunRiskContext({
    platform: process.platform,
    workspaceRoot: { realPath: rootA },
    scopeRoot: { realPath: rootA },
    cwd: { realPath: rootA },
  }, { protectedRoots: [join(rootA, '.ragent-control')] });
  assert.ok(manuallyBuiltRiskContext.protectedRoots.includes(join(rootA, '.ragent-control')),
    'additional protected roots should be normalized into the risk context');

  const windowsRiskContext = buildRunRiskContext({
    platform: 'win32',
    workspaceRoot: { realPath: 'C:\\ragent\\workspace' },
    scopeRoot: { realPath: 'C:\\ragent\\workspace' },
    cwd: { realPath: 'C:\\ragent\\workspace' },
  }, { protectedRoots: ['C:\\ragent\\control'] });
  assert.ok(windowsRiskContext.protectedRoots.includes('C:\\ragent\\control'),
    'Windows risk roots should use win32 path semantics');

  // revision bump changes the digest
  await updateProject(project.id, { name: 'Admission A renamed' });
  const afterRename = await prepareRunExecution({ sessionId: 's1', session, manifest });
  assert.notEqual(afterRename.executionScopeDigest, first.executionScopeDigest,
    'a project revision bump must change the snapshot digest');
  assert.ok(afterRename.executionScope.projectRevision > first.executionScope.projectRevision,
    'snapshot should freeze the bumped revision');

  // ── internal operations stay legacy ───────────────────────────────────────
  const compact = await prepareRunExecution({
    sessionId: 's1',
    session,
    manifest: makeManifest({ sessionId: 's1', folder: rootA, internalOperation: 'context_compaction' }),
  });
  assert.equal(compact.legacy, true, 'context_compaction should stay legacy');
  assert.equal(compact.manifest.executionScope, undefined, 'legacy manifests must not carry a snapshot');

  // regenerate / editResend are project-bound new runs
  assert.equal(isInternalLegacyRun({ session, internalOperation: 'regenerate' }), false,
    'regenerate is a project-bound new run');
  assert.equal(isInternalLegacyRun({ session, internalOperation: 'editResend' }), false,
    'editResend is a project-bound new run');
  const regen = await prepareRunExecution({
    sessionId: 's1',
    session,
    manifest: makeManifest({ sessionId: 's1', folder: rootA }),
    options: { internalOperation: 'regenerate' },
  });
  assert.equal(regen.legacy, false, 'regenerate must build a fresh snapshot');
  assert.ok(regen.executionScope.snapshotId.startsWith('ess_'), 'regenerate must not copy the parent snapshot');

  // ── no project binding -> legacy passthrough ──────────────────────────────
  const orphan = await prepareRunExecution({
    sessionId: 's9',
    session: makeSession('s9', '/tmp/does-not-map-to-any-project', ''),
    manifest: makeManifest({ sessionId: 's9', folder: '/tmp/does-not-map-to-any-project' }),
  });
  assert.equal(orphan.legacy, true, 'sessions without a project binding must stay legacy');
  assert.equal(orphan.reason, 'no-project-binding');

  // A saturated runner fleet rejects before a Run is created or a provider is
  // prepared. This remains a stable retryable API error rather than a generic
  // launcher failure after control-plane pressure has already increased.
  await assert.rejects(
    () => prepareRunExecution({
      sessionId: 's1',
      session,
      manifest,
      deps: {
        checkCapacity: async () => ({
          accepted: false,
          reasons: ['memory', 'tasks'],
          limits: { maxMemoryBytes: 1, maxTasks: 1 },
          snapshot: { memoryCurrentBytes: 2, pidsCurrent: 2 },
        }),
      },
    }),
    (error) => error.code === 'RUNNER_CAPACITY_EXHAUSTED'
      && error.statusCode === 503
      && error.capacityReasons.includes('memory'),
    'runner capacity exhaustion must reject before run creation',
  );

  // ── unresolved workspace root -> WORKSPACE_ROOT_UNRESOLVED ────────────────
  const missingRoot = join(tmpdir(), `ragent-adm-missing-${Date.now()}`);
  const unresolvedProject = await createProject(
    { name: 'Unresolved', rootPath: missingRoot },
    { validateRoot: false },
  );
  await assert.rejects(
    () => prepareRunExecution({
      sessionId: 's2',
      session: makeSession('s2', missingRoot, unresolvedProject.id),
      manifest: makeManifest({ sessionId: 's2', folder: missingRoot }),
    }),
    (error) => error.code === 'WORKSPACE_ROOT_UNRESOLVED' && error.statusCode === 409,
    'an unresolved workspace root must block the run with WORKSPACE_ROOT_UNRESOLVED',
  );

  // ── revision changed during admission -> EXECUTION_SCOPE_STALE ────────────
  let projectLoads = 0;
  const staleProject = {
    ...(await getProject(project.id)),
    revision: 999,
  };
  const flakyLoadProject = async () => {
    projectLoads += 1;
    // first call: candidate; second call (verify): different revision
    return projectLoads === 1 ? staleProject : { ...staleProject, revision: 1000 };
  };
  await assert.rejects(
    () => prepareRunExecution({
      sessionId: 's1',
      session,
      manifest: makeManifest({ sessionId: 's1', folder: rootA }),
      deps: {
        loadProject: flakyLoadProject,
        findProjectByFolder: async () => null,
      },
    }),
    (error) => error.code === 'EXECUTION_SCOPE_STALE' && error.statusCode === 409,
    'a revision change between resolve and verify must fail with EXECUTION_SCOPE_STALE',
  );

  console.log('test-run-admission: ok');
} finally {
  rmSync(configDir, { recursive: true, force: true });
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
}
