import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, truncate, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectMacosPackagePreview, MACOS_PACKAGE_PREVIEW_MAX_BYTES } from '../chat/macos-package-preview.mjs';
import { prepareSemanticApproval } from '../chat/semantic-approval.mjs';
import { resolveSemanticContext } from '../chat/semantic-resolver.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'agentoc-macos-pkg-preview-'));
try {
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const file = join(projectRoot, 'example.pkg');
  const content = Buffer.from('isolated package fixture');
  await writeFile(file, content);
  const found = await inspectMacosPackagePreview({ file, projectRoot });
  assert.equal(found.ok, true);
  assert.equal(found.artifactDigest, createHash('sha256').update(content).digest('hex'));
  assert.equal(found.artifactSize, content.length);
  assert.equal(found.publisherVerified, false);
  assert.equal(found.executionRevalidationAvailable, false);
  assert.equal((await inspectMacosPackagePreview({ file, projectRoot: join(root, 'elsewhere') })).ok, false);
  assert.equal((await inspectMacosPackagePreview({ file: join(projectRoot, '..', 'outside.pkg'), projectRoot })).ok, false);
  const alias = join(projectRoot, 'alias.pkg');
  await symlink(file, alias);
  assert.equal((await inspectMacosPackagePreview({ file: alias, projectRoot })).ok, false);
  const hard = join(projectRoot, 'hard.pkg');
  await link(file, hard);
  assert.equal((await inspectMacosPackagePreview({ file, projectRoot })).ok, false);
  await rm(hard);
  await writeFile(file, 'changed package fixture');
  const changed = await inspectMacosPackagePreview({ file, projectRoot });
  assert.equal(changed.ok, true);
  assert.notEqual(changed.artifactDigest, found.artifactDigest);
  await truncate(file, MACOS_PACKAGE_PREVIEW_MAX_BYTES + 1);
  assert.equal((await inspectMacosPackagePreview({ file, projectRoot })).ok, false);
  await writeFile(file, content);
  const request = { rawCommand: `/usr/sbin/installer -pkg ${file} -target /`, sessionId: 's', runId: 'r', turnId: 't', requestKey: 'q', executionClass: 'host' };
  const prepared = await prepareSemanticApproval({ request, trustedContext: { platform: 'darwin', cwd: projectRoot, projectRoot, home: root } });
  assert.equal(prepared.projection.decision, 'DENY');
  assert.equal(prepared.capabilityEligible, false);
  assert.equal(prepared.projection.decisions[0].operation, null);
  const resolution = await resolveSemanticContext({ operation: prepared.compiler.operations[0],
    options: { trustedContext: { platform: 'darwin', cwd: projectRoot, projectRoot, home: root } } });
  assert.equal(resolution.scope.computed, false);
  const preview = resolution.resourceSnapshot.macosPackagePreview;
  if (process.platform === 'darwin') {
    assert.equal(preview.ok, true);
    assert.equal(preview.artifactDigest, found.artifactDigest);
    assert.equal(preview.executionRevalidationAvailable, false);
  } else {
    assert.equal(preview, undefined);
  }
  console.log('macOS installer preview: read-only identity and refusal checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
