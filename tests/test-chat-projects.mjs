#!/usr/bin/env node
// Backend coverage for the Project catalog: stable id derivation, shared-workspace
// project identity, and the legacy-folder → project migration (grouping, projectId writeback,
// ~ expansion, hidden internal sessions, idempotency).
//
// Config isolation: RAGENT_CONFIG_DIR must point at a throwaway dir BEFORE any
// module that imports lib/config.mjs is loaded, because CONFIG_DIR is resolved at
// import time. This process's homedir() is not a temporary ragent home, so the
// instance-scope guard in resolveInstanceScopedOverridePath passes the explicit
// path through unchanged.
import assert from 'assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-projects-test-'));
process.env.RAGENT_CONFIG_DIR = configDir;
const createdRootDirs = [];

const {
  normalizeProjectId,
  expandProjectRootPath,
  projectIdForRootPath,
  ensureProjectsInitialized,
  listProjects,
  createProject,
  ensureProjectForSessionFolder,
  findProjectByRootPath,
  updateProject,
  deleteProject,
} = await import('../chat/projects.mjs');
const {
  loadSessionsMeta,
  withSessionsMetaMutation,
} = await import('../chat/session-meta-store.mjs');
const { appendEvent } = await import('../chat/history.mjs');
const { CHAT_HISTORY_DIR, CHAT_PROJECTS_FILE, CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');

function resetStore() {
  // Removing both durable files forces the mtime-keyed caches back to empty.
  for (const file of [CHAT_PROJECTS_FILE, CHAT_SESSIONS_FILE]) {
    try { unlinkSync(file); } catch { /* not present yet */ }
  }
}

async function seedSessions(metas) {
  await withSessionsMetaMutation(async (list, save) => {
    list.length = 0;
    for (const meta of metas) list.push({ ...meta });
    await save(list, { immediate: true });
  });
}

function makeRootDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdRootDirs.push(dir);
  return dir;
}

try {
  // ── Pure helpers: stable ids and path normalization ───────────────────────
  assert.equal(
    projectIdForRootPath('/srv/ragent'),
    projectIdForRootPath('/srv/ragent'),
    'projectIdForRootPath should be deterministic for the same path',
  );
  assert.notEqual(
    projectIdForRootPath('/srv/ragent'),
    projectIdForRootPath('/srv/other'),
    'projectIdForRootPath should differ across paths',
  );
  assert.equal(
    projectIdForRootPath('~/projects/x'),
    projectIdForRootPath(join(homedir(), 'projects/x')),
    'projectIdForRootPath should treat ~/ as the home directory',
  );
  assert.equal(expandProjectRootPath('~/projects/x'), join(homedir(), 'projects/x'));
  assert.equal(expandProjectRootPath('~/'), homedir());
  assert.ok(
    isAbsolute(expandProjectRootPath('relative/path')),
    'expandProjectRootPath should resolve relative paths to absolute',
  );
  assert.equal(normalizeProjectId('not-an-id'), '', 'normalizeProjectId should reject malformed ids');
  assert.ok(
    normalizeProjectId(projectIdForRootPath('/x')).startsWith('prj_'),
    'normalizeProjectId should accept derived project ids',
  );

  // ── createProject: required rootPath, shared workspace, distinct ids ──────
  resetStore();
  const rootA = makeRootDir('ragent-proj-root-a-');
  const rootB = makeRootDir('ragent-proj-root-b-');
  const alpha = await createProject({ name: 'Alpha', rootPath: rootA });
  assert.ok(alpha.id.startsWith('prj_'), 'created project should get a project id');
  assert.equal(alpha.rootPath, rootA);
  assert.equal(alpha.name, 'Alpha');

  const shared = await createProject({ name: 'Shared follow-up', rootPath: rootA });
  assert.equal(shared.rootPath, rootA, 'shared projects should keep the same workspace path');
  assert.notEqual(shared.id, alpha.id, 'shared projects should have independent ids');
  assert.equal((await listProjects()).filter((project) => project.rootPath === rootA).length, 2,
    'shared projects should both remain visible in the catalog');
  const recovered = await ensureProjectForSessionFolder(rootA);
  assert.equal(recovered.id, alpha.id,
    'legacy session-folder association should continue reusing the existing project');
  await assert.rejects(
    () => createProject({ rootPath: '' }),
    (error) => error.code === 'PROJECT_ROOT_REQUIRED' && error.statusCode === 400,
    'createProject should require a rootPath',
  );
  const beta = await createProject({ name: 'Beta', rootPath: rootB });
  assert.notEqual(alpha.id, beta.id, 'different folders must map to different project ids');

  // ── Shared root: folder resolution must prefer the original project, not the
  //    name-sorted first match. Regression for a session created with only a
  //    folder inside project "example" (root /home/example) landing in a later
  //    project "alpha" whose name sorts before "example". ─────────────────────
  resetStore();
  const sharedRoot = makeRootDir('ragent-proj-shared-root-');
  const example = await createProject({ name: 'example', rootPath: sharedRoot });
  const sharedLater = await createProject({ name: 'alpha', rootPath: sharedRoot });
  assert.notEqual(sharedLater.id, example.id, 'shared-root projects keep independent ids');
  assert.ok('alpha' < 'example', 'later project name should sort before the original for this regression');
  const folderResolved = await ensureProjectForSessionFolder(sharedRoot);
  assert.equal(folderResolved.id, example.id,
    'folder-only session association must resolve to the original project, not a name-sorted sibling');
  const byRootResolved = await findProjectByRootPath(sharedRoot);
  assert.equal(byRootResolved.id, example.id,
    'findProjectByRootPath must prefer the original shared-root project');
  await seedSessions([
    { id: 'shared-s1', folder: sharedRoot },
  ]);
  await ensureProjectsInitialized();
  const sharedMetas = await loadSessionsMeta();
  assert.equal(
    sharedMetas.find((meta) => meta.id === 'shared-s1').projectId,
    example.id,
    'migration writeback must assign the original shared-root project, not the name-sorted sibling',
  );
  resetStore();

  // ── Migration: folder → project grouping, writeback, ~ expansion, hidden ──
  resetStore();
  const folderAlpha = join(tmpdir(), 'ragent-proj-migrate-alpha');
  const folderBeta = join(tmpdir(), 'ragent-proj-migrate-beta');
  await seedSessions([
    { id: 's1', folder: folderAlpha },
    { id: 's2', folder: folderAlpha },
    { id: 's3', folder: folderBeta },
    { id: 's4', folder: '~/ragent-proj-migrate-gamma' },
    { id: 's5', internalRole: 'legacy_internal', folder: join(tmpdir(), 'ragent-proj-hidden-1') },
    { id: 's6', visitorId: 'vis-1', folder: join(tmpdir(), 'ragent-proj-hidden-2') },
  ]);

  await ensureProjectsInitialized();
  let metas = await loadSessionsMeta();
  const byId = new Map(metas.map((meta) => [meta.id, meta]));

  // Three visible projects (alpha, beta, gamma); internal/visitor sessions hidden.
  const projects = await listProjects();
  assert.equal(projects.length, 3, 'migration should create one project per unique visible folder');

  // Sessions sharing a folder resolve to the same project id.
  assert.equal(byId.get('s1').projectId, byId.get('s2').projectId);
  assert.ok(byId.get('s1').projectId.startsWith('prj_'));
  assert.notEqual(byId.get('s1').projectId, byId.get('s3').projectId);

  // ~ expansion is written back onto the session folder.
  assert.equal(
    byId.get('s4').folder,
    join(homedir(), 'ragent-proj-migrate-gamma'),
    'migration should normalize ~ folders onto the session meta',
  );

  // Hidden internal sessions must not be assigned a project id.
  assert.ok(!byId.get('s5').projectId, 'internal sessions should be skipped by the migration');
  assert.ok(!byId.get('s6').projectId, 'visitor sessions should be skipped by the migration');

  // Per-project session counts (alpha=2, beta=1, gamma=1).
  const byRoot = new Map(projects.map((project) => [project.rootPath, project]));
  assert.equal(byRoot.get(folderAlpha).sessionCount, 2);
  assert.equal(byRoot.get(folderBeta).sessionCount, 1);
  assert.equal(byRoot.get(join(homedir(), 'ragent-proj-migrate-gamma')).sessionCount, 1);

  // ── Migration idempotency: rerunning must not duplicate or rewrite ids ────
  const idsBefore = metas.map((meta) => meta.projectId).filter(Boolean).sort();
  const folderBefore = metas.map((meta) => meta.folder).sort();
  await ensureProjectsInitialized();
  metas = await loadSessionsMeta();
  assert.deepEqual(
    metas.map((meta) => meta.projectId).filter(Boolean).sort(),
    idsBefore,
    'rerunning migration should keep project ids stable',
  );
  assert.deepEqual(
    metas.map((meta) => meta.folder).sort(),
    folderBefore,
    'rerunning migration should not churn session folders',
  );
  const projectsAfter = await listProjects();
  assert.equal(projectsAfter.length, 3, 'rerunning migration should not duplicate projects');

  // ── updateProject: rename + archive, and listProjects archive filtering ──
  const gammaProject = byRoot.get(join(homedir(), 'ragent-proj-migrate-gamma'));
  const renamed = await updateProject(gammaProject.id, { name: 'Gamma Renamed' });
  assert.equal(renamed.name, 'Gamma Renamed');
  await updateProject(gammaProject.id, { archived: true });
  const visibleAfterArchive = await listProjects();
  assert.equal(visibleAfterArchive.length, 2, 'archived projects should be hidden by default');
  const includingArchived = await listProjects({ includeArchived: true });
  assert.equal(includingArchived.length, 3, 'archived projects should appear when requested');

  // ── listSessions project scope keeps folder-matched unbound sessions ─────
  // The unbound internal session has no projectId (system-created, skipped by the
  // migration) but its folder lives under the project root; it must stay
  // visible in the project-scoped list, mirroring the frontend
  // ragentSessionMatchesSelectedWorkspace folder fallback contract.
  const prjRoot = makeRootDir('ragent-prj-scope-');
  const scopeProject = await createProject({ rootPath: prjRoot });
  const otherRoot = makeRootDir('ragent-prj-other-');
  const otherProject = await createProject({ rootPath: otherRoot });
  // Keep the project file (do not resetStore): the project catalog must stay
  // authoritative so listSessions resolves the real project root for the scope.
  await seedSessions([
    { id: 'sess-bound', projectId: scopeProject.id, folder: prjRoot },
    { id: 'sess-unbound-internal', projectId: '', folder: prjRoot },
    { id: 'sess-unbound-elsewhere', projectId: '', folder: '/elsewhere' },
    { id: 'sess-other-project', projectId: otherProject.id, folder: prjRoot },
  ]);
  const { listSessions } = await import('../chat/session-manager.mjs');
  const scopedIds = (await listSessions({ projectId: scopeProject.id }))
    .map((session) => session.id).sort();
  assert.deepEqual(
    scopedIds,
    ['sess-bound', 'sess-unbound-internal'].sort(),
    'project-scoped list should include the bound session and unbound sessions whose folder matches the project root',
  );
  const unscopedIds = (await listSessions({})).map((session) => session.id);
  assert.ok(unscopedIds.includes('sess-unbound-internal'),
    'unscoped list should still include the unbound internal session');

  // ── Project actions: pin + delete with explicit session policy ───────────
  const inboxRoot = makeRootDir('ragent-prj-inbox-');
  const inboxProject = await createProject({ name: 'Inbox source', rootPath: inboxRoot });
  await seedSessions([
    { id: 'sess-inbox-a', projectId: inboxProject.id, folder: inboxRoot },
    { id: 'sess-inbox-b', projectId: inboxProject.id, folder: inboxRoot },
  ]);
  const pinnedProject = await updateProject(inboxProject.id, { pinned: true });
  assert.equal(pinnedProject.pinned, true, 'projects should persist the pinned state');
  const detachedResult = await deleteProject(inboxProject.id, { deleteSessions: false });
  assert.equal(detachedResult.detachedSessionCount, 2, 'keeping sessions should detach every project session');
  metas = await loadSessionsMeta();
  for (const id of ['sess-inbox-a', 'sess-inbox-b']) {
    const meta = metas.find((entry) => entry.id === id);
    assert.equal(meta.projectId, '', 'detached sessions should clear their project binding');
    assert.equal(meta.projectDetached, true, 'detached sessions should carry a durable inbox marker');
  }
  await ensureProjectsInitialized();
  metas = await loadSessionsMeta();
  assert.equal(metas.find((entry) => entry.id === 'sess-inbox-a').projectId, '',
    'project initialization must not reattach an inbox session by folder');

  const deleteRoot = makeRootDir('ragent-prj-delete-');
  const deleteProjectRecord = await createProject({ name: 'Delete source', rootPath: deleteRoot });
  await seedSessions([
    { id: 'sess-delete', projectId: deleteProjectRecord.id, folder: deleteRoot },
  ]);
  await appendEvent('sess-delete', { type: 'message', role: 'user', content: 'temporary history' });
  const deletedResult = await deleteProject(deleteProjectRecord.id, { deleteSessions: true });
  assert.equal(deletedResult.deletedSessionCount, 1, 'delete-all should remove every project session');
  assert.ok(!(await loadSessionsMeta()).some((entry) => entry.id === 'sess-delete'),
    'delete-all should remove session metadata');
  await assert.rejects(
    () => import('fs/promises').then(({ stat }) => stat(join(CHAT_HISTORY_DIR, 'sess-delete'))),
    'delete-all should remove session history');


  // ── Execution binding freeze + revision (slice 2) ─────────────────────────
  const freezeRoot = makeRootDir('ragent-prj-freeze-');
  const freezeProject = await createProject({ name: 'Freeze', rootPath: freezeRoot });
  assert.equal(freezeProject.revision, 1, 'a fresh project should start at revision 1');

  // pre-run project: scope patch allowed (migration window)
  const preRun = await updateProject(freezeProject.id, { scopeMode: 'subpath', scopePath: 'sub' });
  assert.equal(preRun.scopeMode, 'subpath', 'pre-run projects may rebind scope');
  assert.equal(preRun.revision, 2, 'a canonical mutation must bump the revision');

  // project with an active run: execution binding becomes immutable
  await seedSessions([{ id: 'sess-freeze', projectId: freezeProject.id, folder: freezeRoot, activeRunId: 'run_active_1' }]);
  await assert.rejects(
    () => updateProject(freezeProject.id, { scopePath: 'other' }),
    (error) => error.code === 'PROJECT_EXECUTION_BINDING_IMMUTABLE' && error.statusCode === 409,
    'a project that has produced a run must reject execution-binding mutations',
  );
  await assert.rejects(
    () => updateProject(freezeProject.id, { workspaceId: 'ws_other' }),
    (error) => error.code === 'PROJECT_EXECUTION_BINDING_IMMUTABLE',
    'workspaceId rebinding must be frozen after the first run',
  );
  // non-binding mutations stay allowed and still bump the revision
  const renamedFreeze = await updateProject(freezeProject.id, { name: 'Freeze renamed' });
  assert.equal(renamedFreeze.name, 'Freeze renamed', 'non-binding mutations must remain allowed');
  assert.equal(renamedFreeze.revision, 3, 'non-binding mutations must still bump the revision');
  assert.equal(renamedFreeze.scopePath, 'sub', 'binding fields must be unchanged by non-binding patches');

  console.log('test-chat-projects: ok');
} finally {
  resetStore();
  rmSync(configDir, { recursive: true, force: true });
  for (const dir of createdRootDirs) rmSync(dir, { recursive: true, force: true });
}
