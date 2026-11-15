#!/usr/bin/env node
// Workspace identity store coverage (Execution-Scope slice 1, design 5.1/5.2,
// migration 11.1).
//
// Covers: realpath aliasing (textual + symlink) → same physicalKey/Workspace,
// hostId separation, shared-root backfill dedupe, unresolved roots, root
// replacement → WORKSPACE_ROOT_DRIFT, monotonic revision, and hostId stability
// when the store file is reopened by a fresh module instance.
//
// Config isolation: RAGENT_CONFIG_DIR must be set to a throwaway dir BEFORE
// importing lib/config.mjs (see tests/test-chat-projects.mjs).
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-workspaces-test-'));
process.env.RAGENT_CONFIG_DIR = configDir;
const createdRootDirs = [];

const {
  ensureWorkspaceForRoot,
  resolveWorkspaceRoot,
  getWorkspaceById,
  listWorkspaces,
  backfillWorkspacesFromProjects,
} = await import('../chat/workspaces.mjs');
const { physicalKeyForPath } = await import('../chat/execution-scope.mjs');
const { CHAT_PROJECTS_FILE } = await import('../lib/config.mjs');
const { readJson } = await import('../chat/fs-utils.mjs');

const WORKSPACES_FILE = join(dirname(CHAT_PROJECTS_FILE), 'chat-workspaces.json');

function makeRootDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdRootDirs.push(dir);
  return dir;
}

function makeAlias(target) {
  const alias = join(tmpdir(), `ragent-ws-alias-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  symlinkSync(target, alias);
  createdRootDirs.push(alias);
  return alias;
}

try {
  // ── realpath aliasing: textual + symlink aliases → one Workspace ─────────
  const root = makeRootDir('ragent-ws-root-');
  const alias = makeAlias(root);
  const viaRoot = await ensureWorkspaceForRoot(root);
  const viaDot = await ensureWorkspaceForRoot(join(root, '.'));
  const viaAlias = await ensureWorkspaceForRoot(alias);

  assert.ok(viaRoot.id.startsWith('ws_'), 'workspace ids should carry the ws_ prefix');
  assert.equal(viaRoot.resolutionState, 'resolved');
  assert.equal(viaRoot.revision, 1);
  assert.equal(viaDot.id, viaRoot.id, 'a trailing-dot alias must reuse the same Workspace');
  assert.equal(viaAlias.id, viaRoot.id, 'a symlink alias must reuse the same Workspace');
  assert.equal(viaDot.physicalKey, viaRoot.physicalKey);
  assert.equal(viaAlias.physicalKey, viaRoot.physicalKey);
  assert.ok(viaRoot.physicalKey.startsWith('sha256:'));
  assert.equal(viaRoot.realRootPath, await realpath(root));

  // hostId separation: the same path under another hostId yields another key.
  assert.notEqual(
    physicalKeyForPath(viaRoot.hostId, viaRoot.realRootPath),
    physicalKeyForPath('host_other', viaRoot.realRootPath),
    'different hostIds must produce different physicalKeys',
  );

  // getWorkspaceById / listWorkspaces read paths.
  assert.equal((await getWorkspaceById(viaRoot.id)).id, viaRoot.id);
  assert.equal(await getWorkspaceById('ws_missing'), null);
  assert.ok((await listWorkspaces()).some((ws) => ws.id === viaRoot.id));

  // ── shared-root backfill: one Workspace per physical root ────────────────
  const sharedRoot = makeRootDir('ragent-ws-shared-');
  writeFileSync(CHAT_PROJECTS_FILE, JSON.stringify({
    schemaVersion: 1,
    projects: [
      { id: 'prj_backfill_a', name: 'A', rootPath: sharedRoot },
      { id: 'prj_backfill_b', name: 'B', rootPath: join(sharedRoot, '..', 'ragent-ws-shared-' + sharedRoot.slice(sharedRoot.lastIndexOf('-') + 1)) },
    ],
  }));
  const backfill = await backfillWorkspacesFromProjects();
  assert.equal(backfill.length, 2, 'backfill should report every project root');
  assert.equal(backfill[0].workspaceId, backfill[1].workspaceId,
    'two textual aliases of the same root must backfill to the same Workspace');
  assert.equal(backfill[0].resolutionState, 'resolved');
  assert.equal(
    (await listWorkspaces()).filter((ws) => ws.id === backfill[0].workspaceId).length,
    1,
    'backfill must not create duplicate Workspaces for a shared root',
  );
  assert.equal((await getWorkspaceById(backfill[0].workspaceId)).id, backfill[0].workspaceId,
    'backfilled Workspace must be readable by id');

  // ── unresolved root: no throw, later resolution upgrades the record ──────
  const missing = join(tmpdir(), `ragent-ws-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const unresolved = await ensureWorkspaceForRoot(missing);
  assert.equal(unresolved.resolutionState, 'unresolved', 'missing roots must stay listable');
  assert.equal(unresolved.revision, 1);
  const retried = await ensureWorkspaceForRoot(missing);
  assert.equal(retried.id, unresolved.id, 're-ensuring an unresolved root must return the same record');
  assert.equal(retried.revision, 1, 're-ensuring an unresolved root must not churn the revision');

  mkdirSync(missing);
  createdRootDirs.push(missing);
  const resolvedAfter = await ensureWorkspaceForRoot(missing);
  assert.equal(resolvedAfter.id, unresolved.id, 'resolution must upgrade the existing record');
  assert.equal(resolvedAfter.resolutionState, 'resolved');
  assert.ok(resolvedAfter.revision > unresolved.revision, 'resolution must bump the revision');

  // explicit resolve retry API
  const viaResolve = await resolveWorkspaceRoot(resolvedAfter.id);
  assert.equal(viaResolve.id, resolvedAfter.id);
  assert.equal(viaResolve.resolutionState, 'resolved');
  assert.equal(await resolveWorkspaceRoot('ws_missing'), null);

  // ── WORKSPACE_ROOT_DRIFT: root replaced → recorded identity mismatch ─────
  const driftTarget = makeRootDir('ragent-ws-drift-target-');
  const driftReplacement = makeRootDir('ragent-ws-drift-replacement-');
  const driftLink = makeAlias(driftTarget);
  const drifted = await ensureWorkspaceForRoot(driftLink);
  assert.equal(drifted.resolutionState, 'resolved');
  assert.equal(drifted.realRootPath, await realpath(driftTarget));
  rmSync(driftLink, { force: true });
  symlinkSync(driftReplacement, driftLink);
  await assert.rejects(
    () => ensureWorkspaceForRoot(driftLink),
    (error) => error.code === 'WORKSPACE_ROOT_DRIFT' && error.statusCode === 409,
    'a resolved root whose realpath moved must raise WORKSPACE_ROOT_DRIFT(409)',
  );
  await assert.rejects(
    () => resolveWorkspaceRoot(drifted.id),
    (error) => error.code === 'WORKSPACE_ROOT_DRIFT',
    'explicit resolve must also raise WORKSPACE_ROOT_DRIFT for drifted roots',
  );

  // ── monotonic revision across canonical mutations ────────────────────────
  const revRoot = makeRootDir('ragent-ws-rev-');
  const rev1 = await ensureWorkspaceForRoot(revRoot);
  const rev2 = await ensureWorkspaceForRoot(revRoot);
  assert.equal(rev1.revision, 1);
  assert.equal(rev2.revision, 1, 're-ensuring a stable root must not bump revision');
  const revMissing = join(tmpdir(), `ragent-ws-rev-missing-${Date.now()}`);
  const revU = await ensureWorkspaceForRoot(revMissing);
  mkdirSync(revMissing);
  createdRootDirs.push(revMissing);
  const revR = await ensureWorkspaceForRoot(revMissing);
  assert.equal(revR.revision, revU.revision + 1, 'revision must increase monotonically on mutation');
  const store = await readJson(WORKSPACES_FILE, null);
  assert.equal(store.schemaVersion, 1, 'store schemaVersion must be 1');
  assert.ok(store.hostId.startsWith('host_'), 'hostId must carry the host_ prefix');

  // ── hostId stability across module reopen (fresh instance reads the file) ─
  const reopenA = await import(`../chat/workspaces.mjs?reopen-a=${Date.now()}`);
  const reopenRoot = makeRootDir('ragent-ws-hostid-');
  await reopenA.ensureWorkspaceForRoot(reopenRoot);
  const persisted = JSON.parse(readFileSync(WORKSPACES_FILE, 'utf8'));
  assert.ok(persisted.hostId.startsWith('host_'));
  const reopenB = await import(`../chat/workspaces.mjs?reopen-b=${Date.now()}`);
  const again = await reopenB.ensureWorkspaceForRoot(reopenRoot);
  assert.equal(again.hostId, persisted.hostId, 'hostId must be stable when the file is reopened');
  assert.equal(again.id, (await reopenB.getWorkspaceById(again.id)).id, 'reopened instance must read existing records');

  // ── invalid input ────────────────────────────────────────────────────────
  await assert.rejects(
    () => ensureWorkspaceForRoot(''),
    (error) => error.code === 'EINVAL' && error.statusCode === 400,
    'ensureWorkspaceForRoot should reject empty rootPath',
  );

  console.log('test-workspaces: ok');
} finally {
  rmSync(configDir, { recursive: true, force: true });
  for (const dir of createdRootDirs) rmSync(dir, { recursive: true, force: true });
}
