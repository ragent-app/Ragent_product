#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createProjectIndex } from '../chat/project-index.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-project-index-'));
try {
  const source = [
    { id: 'prj_a', name: 'Same Product', rootPath: '/a', workspaceId: 'ws_a', revision: 1 },
    { id: 'prj_b', name: 'Same Product', rootPath: '/b', workspaceId: 'ws_b', revision: 1 },
    { id: 'prj_archived', name: 'Old', rootPath: '/old', archived: true, revision: 1 },
  ];
  const workspaces = {
    ws_a: { id: 'ws_a', realRootPath: '/real/a', revision: 2, resolutionState: 'resolved' },
    ws_b: { id: 'ws_b', realRootPath: '/real/b', revision: 3, resolutionState: 'resolved' },
  };
  const sessions = Array.from({ length: 6 }, (_, index) => ({
    id: `session-${index}`, projectId: 'prj_a', name: `Task ${index}`,
    updatedAt: `2026-10-13T00:00:0${index}.000Z`,
  }));
  let memoryVersion = 1;
  let memoryInitCount = 0;
  let rootDrift = false;
  const databasePath = join(root, 'project-index.sqlite');
  const index = createProjectIndex({
    databasePath,
    listProjects: async () => source,
    loadSessions: async () => sessions,
    resolveWorkspace: async (id) => {
      if (rootDrift && id === 'ws_b') throw new Error('WORKSPACE_ROOT_DRIFT');
      return workspaces[id];
    },
    getInstanceIdentity: async () => ({ instanceId: 'pc-test' }),
    memoryStore: {
      initialize: async () => { memoryInitCount += 1; },
      getProjectMemory: async () => ({ currentVersion: memoryVersion, summary: `v${memoryVersion}\nCurrent project evidence` }),
    },
    readFreshDelta: async () => 'Recent verified change',
  });

  const initial = await index.refresh({ now: new Date('2026-10-13T00:01:00Z') });
  assert.equal(initial.inventoryComplete, true);
  assert.deepEqual(initial.projects.map((project) => project.projectId), ['prj_a', 'prj_b']);
  assert.equal(initial.projects[0].name, initial.projects[1].name);
  assert.notEqual(initial.projects[0].rootIdentity, initial.projects[1].rootIdentity);
  assert.equal(initial.projects[0].workspaceRevision, 2);
  assert.equal(initial.projects[0].activeThreads.length, 5);
  assert.equal(initial.projects[0].truncated, true);
  assert.equal(initial.projects[0].memoryVersion, 1);
  assert.equal(memoryInitCount, 1);

  const scoped = await index.refresh({ allowedProjectIds: ['prj_b'], now: new Date('2026-10-13T00:02:00Z') });
  assert.deepEqual(scoped.projects.map((project) => project.projectId), ['prj_b']);
  const matches = await index.search({ query: 'Same Product' });
  assert.deepEqual(matches.candidates.map((candidate) => candidate.project.projectId), ['prj_a', 'prj_b']);

  const previousDigest = initial.projects[1].sourceDigest;
  source[1] = { ...source[1], revision: 2, name: 'New Product' };
  memoryVersion = 2;
  rootDrift = true;
  const refreshed = await index.refresh();
  assert.notEqual(refreshed.projects[1].sourceDigest, previousDigest);
  assert.equal(refreshed.projects[1].rootStatus, 'unresolved', 'root drift cannot be presented as a resolved workspace');
  assert.equal(refreshed.projects[1].completeness, 'partial');
  assert.equal(refreshed.projects[1].memoryVersion, 2);
  const db = new DatabaseSync(databasePath);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project_index').get().count, 2);
  } finally { db.close(); }
  assert.equal(memoryInitCount, 1);
  console.log('test-project-index: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
