import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'ragent-two-dot-scope-'));
const workspace = path.join(root, 'workspace');
const outside = path.join(root, 'workspace-sibling');
const folder = path.join(workspace, '..notes');
await mkdir(folder, { recursive: true });
await mkdir(outside);
await writeFile(path.join(folder, 'file.txt'), 'fixture');
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = path.join(root, 'config');
process.env.RAGENT_WORK_ROOT_DIR = workspace;
process.env.RAGENT_MEMORY_DIR = path.join(root, 'memory');
process.env.RAGENT_PROVIDER_HOMES_DIR = path.join(root, 'provider-homes');
process.env.RAGENT_RUN_SPOOL_DIR = path.join(root, 'runs');
const { resolveContainedScope, scopeContainsPath } = await import('../chat/execution-scope.mjs');
const { createStagingWorkspace, discardStaging } = await import('../chat/managed-writer.mjs');

try {
  assert.equal(await scopeContainsPath(workspace, folder), true);
  assert.equal(await scopeContainsPath(workspace, outside), false);
  assert.equal((await resolveContainedScope(workspace, '..notes')).relativePath, '..notes');
  await assert.rejects(resolveContainedScope(workspace, '../workspace-sibling'), { code: 'PROJECT_SCOPE_ESCAPE' });
  const staging = await createStagingWorkspace(workspace, ['..notes'], { stagingRoot: path.join(root, 'staging') });
  try {
    assert.deepEqual(staging.mapping.writablePaths, ['..notes']);
    assert.equal(await readFile(path.join(staging.stagingDir, '..notes', 'file.txt'), 'utf8'), 'fixture');
  } finally { await discardStaging(staging.stagingDir, { stagingRoot: path.join(root, 'staging') }); }
  await assert.rejects(createStagingWorkspace(workspace, ['../workspace-sibling'], { stagingRoot: path.join(root, 'staging') }), { code: 'MANAGED_WRITE_ESCAPE' });
  console.log('two-dot-workspace-containment: valid directory and traversal checks passed');
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
