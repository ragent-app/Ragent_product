#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import config-bound modules only after selecting an isolated Project catalog.
const root = await mkdtemp(join(tmpdir(), 'ragent-bootstrap-integration-'));
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
try {
  const [{ createProjectBootstrap }, { listProjectRecords }] = await Promise.all([
    import('../chat/project-bootstrap.mjs'), import('../chat/projects.mjs'),
  ]);
  const operationId = 'integration-create-1';
  const plan = {
    operationId, decisionId: 'decision-1', inputDigest: 'd'.repeat(64),
    targetInstanceId: 'pc-integration', indexRevision: 'index-1',
    newProject: { name: 'Integration study', purpose: 'Keep a durable research project', projectType: 'research' },
    userRequirement: 'Collect and compare the cited sources.', sourceRefs: ['https://example.com/reference'],
  };
  const options = {
    databasePath: join(root, 'bootstrap.sqlite'), parentRoot: join(root, 'managed'),
    getInstanceIdentity: async () => ({ instanceId: 'pc-integration' }),
    projectIndex: { refresh: async () => ({
      targetInstanceId: 'pc-integration', indexRevision: 'index-1', inventoryComplete: true, truncated: false,
    }) },
  };
  const first = await createProjectBootstrap(options).ensureForIntake(plan);
  assert.equal(first.stage, 'completed');
  assert.ok(first.projectId);
  assert.match(await readFile(join(first.directory, 'INTAKE.md'), 'utf8'), /Collect and compare/);
  const records = await listProjectRecords({ includeArchived: true });
  const stored = records.find((project) => project.creationOperationId === operationId);
  assert.equal(stored?.id, first.projectId);
  assert.equal(stored?.rootPath, first.directory);
  assert.equal(stored?.creationDigest, first.requestDigest);

  const restarted = createProjectBootstrap(options);
  assert.equal((await restarted.resume(operationId))?.projectId, first.projectId);
  // If the coordinator record is lost, the Project association and ownership marker
  // still recover the exact same Project instead of registering another one.
  const lostJournal = createProjectBootstrap({ ...options, databasePath: join(root, 'fresh-bootstrap.sqlite') });
  const recovered = await lostJournal.ensureForIntake(plan);
  assert.equal(recovered.projectId, first.projectId);
  assert.equal((await listProjectRecords({ includeArchived: true }))
    .filter((project) => project.creationOperationId === operationId).length, 1);
  console.log('test-project-bootstrap-integration: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
