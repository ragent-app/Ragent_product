#!/usr/bin/env node
// Execution-Scope slice 1: cross-platform Path Resolver hard rules (design 5.3).
//
// Covers: /repo/app vs /repo/application containment, .. traversal, absolute
// subpath, empty segments, backslash rejection, symlink escaping the root,
// win32 drive-case normalization, and frozen error codes
// (PROJECT_SCOPE_ESCAPE=400, etc.).
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { realpath } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';

const {
  normalizePlatformPath,
  physicalKeyForPath,
  resolveRealRoot,
  resolveContainedScope,
  scopeContainsPath,
  buildExecutionScopeSnapshot,
  computeExecutionScopeDigest,
} = await import('../chat/execution-scope.mjs');

const createdRootDirs = [];

function makeRootDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdRootDirs.push(dir);
  return dir;
}

try {
  // ── normalizePlatformPath: win32 drive lowercase + separator unify ───────
  assert.equal(normalizePlatformPath('C:\\Repo\\App', 'win32'), 'c:\\Repo\\App',
    'win32 should lowercase the drive letter and keep the rest of the path');
  assert.equal(normalizePlatformPath('c:/Repo/App', 'win32'), 'c:\\Repo\\App',
    'win32 should unify forward slashes to backslashes');
  assert.equal(normalizePlatformPath('D:/a/b', 'win32'), 'd:\\a\\b');
  assert.equal(normalizePlatformPath('/home/x/repo', 'posix'), '/home/x/repo',
    'posix should return the path unchanged');
  assert.equal(normalizePlatformPath('/home/x/repo'), normalizePlatformPath('/home/x/repo', process.platform),
    'default platform should match the current host');
  assert.throws(() => normalizePlatformPath(''), (error) => error.code === 'EINVAL',
    'normalizePlatformPath should reject empty paths');
  assert.throws(() => normalizePlatformPath('a\0b'), (error) => error.code === 'EINVAL',
    'normalizePlatformPath should reject NUL bytes');

  // ── physicalKeyForPath: same realpath → same key, cross-host → different ─
  assert.ok(physicalKeyForPath('host_x', '/repo').startsWith('sha256:'),
    'physicalKey should carry the sha256: prefix');
  assert.equal(
    physicalKeyForPath('host_x', 'C:\\Repo', 'win32'),
    physicalKeyForPath('host_x', 'c:/Repo', 'win32'),
    'win32 drive-case aliases should collapse to the same physicalKey',
  );
  assert.notEqual(
    physicalKeyForPath('host_x', 'C:\\Repo', 'win32'),
    physicalKeyForPath('host_y', 'C:\\Repo', 'win32'),
    'different hostIds must produce different physicalKeys',
  );
  assert.equal(
    physicalKeyForPath('host_x', '/repo'),
    physicalKeyForPath('host_x', '/repo', process.platform),
    'default platform key should equal the explicit host platform key',
  );
  assert.notEqual(
    physicalKeyForPath('host_x', '/repo'),
    physicalKeyForPath('host_x', '/repo2'),
    'different realpaths must produce different physicalKeys',
  );
  assert.throws(() => physicalKeyForPath('', '/repo'), (error) => error.code === 'EINVAL',
    'physicalKeyForPath should require a hostId');

  // ── resolveRealRoot: ~ expansion, absolutize, realpath, failures ─────────
  const root = makeRootDir('ragent-es-root-');
  assert.equal(await resolveRealRoot(root), await realpath(root),
    'resolveRealRoot should realpath an existing directory');
  assert.equal(await resolveRealRoot(join(root, '.')), root,
    'resolveRealRoot should canonicalize a trailing-dot alias');
  assert.equal(await resolveRealRoot('~'), await realpath(homedir()),
    'resolveRealRoot should expand a bare ~ to the home directory');
  assert.equal(await resolveRealRoot('~/'), await realpath(homedir()),
    'resolveRealRoot should expand ~/ to the home directory');
  await assert.rejects(() => resolveRealRoot(join(root, 'missing-dir')),
    (error) => error.code === 'ENOENT',
    'resolveRealRoot should surface ENOENT for missing roots');
  await assert.rejects(() => resolveRealRoot(''),
    (error) => error.code === 'EINVAL',
    'resolveRealRoot should reject empty paths');
  await assert.rejects(() => resolveRealRoot('a\0b'),
    (error) => error.code === 'EINVAL',
    'resolveRealRoot should reject NUL bytes');

  // ── resolveContainedScope: shared scope + nested subpaths ────────────────
  const wsRoot = makeRootDir('ragent-es-ws-');
  const app = join(wsRoot, 'app');
  const application = join(wsRoot, 'application');
  const sub = join(app, 'sub');
  mkdirSync(app);
  mkdirSync(application);
  mkdirSync(sub);

  assert.deepEqual(await resolveContainedScope(wsRoot, ''),
    { relativePath: '', realPath: wsRoot },
    'empty scopeRelativePath should mean the whole workspace (shared scope)');
  assert.deepEqual(await resolveContainedScope(wsRoot, 'app'),
    { relativePath: 'app', realPath: app },
    'a direct subdirectory should resolve inside the workspace');
  assert.deepEqual(await resolveContainedScope(wsRoot, 'app/sub'),
    { relativePath: 'app/sub', realPath: sub },
    'nested subpaths should keep their relativePath');

  // ── containment matrix: /repo/app vs /repo/application ───────────────────
  const appScope = await resolveContainedScope(wsRoot, 'app');
  assert.equal(await scopeContainsPath(appScope.realPath, sub), true,
    'a child of app must be contained in app');
  assert.equal(await scopeContainsPath(appScope.realPath, application), false,
    '/repo/app must not contain /repo/application');
  assert.equal(await scopeContainsPath(wsRoot, app), true,
    'app must be contained in the workspace');
  assert.equal(await scopeContainsPath(wsRoot, application), true,
    'application must be contained in the workspace');
  assert.equal(await scopeContainsPath(wsRoot, join(wsRoot, 'missing')), false,
    'unresolvable candidates must not be contained');
  assert.equal(await scopeContainsPath(wsRoot, app, 'win32'), true,
    'platform injection should keep containment true');
  assert.equal(await scopeContainsPath(wsRoot, join(wsRoot, '..'), 'win32'), false,
    'platform injection should reject an escaping candidate');

  // ── escape rejection with frozen error codes ─────────────────────────────
  for (const [subpath, label] of [
    ['../outside', '.. traversal'],
    ['app/../../x', 'nested .. traversal'],
    ['/etc', 'absolute subpath'],
    ['app//sub', 'empty segment'],
    ['app/', 'trailing empty segment'],
    ['./app', 'dot segment'],
    ['app/.', 'trailing dot segment'],
    ['app\\sub', 'backslash segment'],
  ]) {
    await assert.rejects(
      () => resolveContainedScope(wsRoot, subpath),
      (error) => error.code === 'PROJECT_SCOPE_ESCAPE' && error.statusCode === 400,
      `resolveContainedScope should reject ${label} with PROJECT_SCOPE_ESCAPE(400)`,
    );
  }

  // ── symlink handling: outside → reject, inside → allow ───────────────────
  const outside = makeRootDir('ragent-es-outside-');
  const escapeLink = join(wsRoot, 'escape-link');
  symlinkSync(outside, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    () => resolveContainedScope(wsRoot, 'escape-link'),
    (error) => error.code === 'PROJECT_SCOPE_ESCAPE' && error.statusCode === 400,
    'a symlink resolving outside the workspace must be rejected',
  );
  assert.equal(await scopeContainsPath(wsRoot, escapeLink), false,
    'scopeContainsPath must fail closed for a symlink escaping the root');
  assert.equal(await scopeContainsPath(app, escapeLink), false,
    'scopeContainsPath must fail closed for a symlink escaping app');

  const inner = join(wsRoot, 'real-inner');
  mkdirSync(inner);
  const innerLink = join(wsRoot, 'inner-link');
  symlinkSync(inner, innerLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(
    await resolveContainedScope(wsRoot, 'inner-link'),
    { relativePath: 'real-inner', realPath: inner },
    'a symlink staying inside the workspace should resolve to its realpath',
  );

  // ── invalid workspace root inputs ────────────────────────────────────────
  await assert.rejects(() => resolveContainedScope('relative/root', 'app'),
    (error) => error.code === 'EINVAL',
    'workspace root must be absolute');
  await assert.rejects(() => resolveContainedScope(join(wsRoot, 'missing-root'), 'app'),
    (error) => error.code === 'ENOENT',
    'a missing workspace root should surface ENOENT');


  // ── ExecutionScopeSnapshot builder (slice 2) ──────────────────────────────
  const snapWsRoot = makeRootDir('ragent-ess-ws-');
  mkdirSync(join(snapWsRoot, 'sub'));
  const snapProject = {
    id: 'prj_snap',
    rootPath: snapWsRoot,
    workspaceId: 'ws_snap',
    scopeMode: 'shared',
    scopePath: '',
    revision: 7,
  };
  const snapWorkspace = {
    id: 'ws_snap',
    hostId: 'host_local',
    rootPath: snapWsRoot,
    realRootPath: await realpath(snapWsRoot),
    physicalKey: physicalKeyForPath('host_local', snapWsRoot),
    revision: 3,
    resolutionState: 'resolved',
  };
  const snapSession = { id: 'sess_snap', folder: snapWsRoot, templateId: 'app_template' };
  const git = { state: 'available', branch: 'main', headCommit: 'a'.repeat(40), dirty: false, partial: false };

  const shared = await buildExecutionScopeSnapshot({
    project: snapProject,
    workspace: snapWorkspace,
    session: snapSession,
    scopeMode: 'shared',
    accessMode: 'write',
    executionIsolation: 'shared',
    git,
  });
  assert.equal(shared.snapshot.schemaVersion, 1, 'snapshot schemaVersion should be 1');
  assert.ok(shared.snapshot.snapshotId.startsWith('ess_'), 'snapshotId should use the ess_ prefix');
  assert.equal(shared.snapshot.projectRevision, 7, 'project revision must be frozen');
  assert.equal(shared.snapshot.workspaceRevision, 3, 'workspace revision must be frozen');
  assert.equal(shared.snapshot.agentId, 'app_template', 'agent id should come from the session template');
  assert.ok(shared.snapshot.agentPolicyDigest.startsWith('sha256:'), 'agent policy digest should be derived');
  assert.equal(shared.snapshot.cwd.realPath, snapWorkspace.realRootPath, 'shared scope cwd should be the workspace root');
  assert.equal(shared.snapshot.git.headCommit, 'a'.repeat(40), 'git provenance should be frozen into the snapshot');
  assert.equal(computeExecutionScopeDigest(shared.snapshot), shared.digest, 'digest must be reproducible');

  const sharedAgain = await buildExecutionScopeSnapshot({
    project: snapProject,
    workspace: snapWorkspace,
    session: snapSession,
    scopeMode: 'shared',
    accessMode: 'write',
    executionIsolation: 'shared',
    git,
  });
  assert.equal(sharedAgain.digest, shared.digest, 'identical inputs must yield an identical digest');
  assert.notEqual(sharedAgain.snapshot.snapshotId, shared.snapshot.snapshotId, 'every snapshot needs a fresh id');

  // subpath scope: cwd becomes the contained subpath realpath
  const subSnapshot = await buildExecutionScopeSnapshot({
    project: { ...snapProject, scopeMode: 'subpath', scopePath: 'sub' },
    workspace: snapWorkspace,
    session: snapSession,
    scopeMode: 'subpath',
    accessMode: 'read',
    executionIsolation: 'shared',
    git,
  });
  assert.equal(subSnapshot.snapshot.scopeMode, 'subpath');
  assert.equal(subSnapshot.snapshot.accessMode, 'read');
  assert.equal(subSnapshot.snapshot.scopeRoot.relativePath, 'sub', 'subpath scope should resolve the relative path');
  assert.equal(subSnapshot.snapshot.cwd.realPath, await realpath(join(snapWsRoot, 'sub')), 'cwd should be the subpath realpath');
  assert.notEqual(subSnapshot.digest, shared.digest, 'a different scope must change the digest');

  // subpath escaping the workspace fails closed with PROJECT_SCOPE_ESCAPE
  await assert.rejects(
    () => buildExecutionScopeSnapshot({
      project: { ...snapProject, scopeMode: 'subpath', scopePath: '../escape' },
      workspace: snapWorkspace,
      session: snapSession,
      scopeMode: 'subpath',
      accessMode: 'write',
      executionIsolation: 'shared',
      git,
    }),
    (error) => error.code === 'PROJECT_SCOPE_ESCAPE' && error.statusCode === 400,
    'a subpath escaping the workspace must fail with PROJECT_SCOPE_ESCAPE',
  );

  console.log('test-execution-scope: ok');
} finally {
  for (const dir of createdRootDirs) rmSync(dir, { recursive: true, force: true });
}
