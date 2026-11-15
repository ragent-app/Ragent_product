#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'ragent-file-asset-staging-'));
const configDir = join(home, '.config', 'ragent');
const sourceDir = join(home, 'source');
await mkdir(configDir, { recursive: true });
await mkdir(sourceDir, { recursive: true });
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_INSTANCE_ROOT = '';
delete process.env.RAGENT_ASSET_STORAGE_BASE_URL;
delete process.env.RAGENT_ASSET_STORAGE_ACCESS_KEY_ID;
delete process.env.RAGENT_ASSET_STORAGE_SECRET_ACCESS_KEY;
delete process.env.RAGENT_ASSET_STORAGE_REGION;

const [{ CHAT_FILE_ASSETS_DIR, CHAT_RUNS_DIR }, fileAssets, staging, sidecar] = await Promise.all([
  import('../lib/config.mjs?file-asset-staging-test-config'),
  import('../chat/file-assets.mjs?file-asset-staging-test-assets'),
  import('../chat/file-asset-input-staging.mjs?file-asset-staging-test-staging'),
  import('../chat/runner-sidecar.mjs?file-asset-staging-test-sidecar'),
]);

const sourcePath = join(sourceDir, 'quarterly-report.txt');
const content = 'quarterly report: 2026-Q3\n';
await writeFile(sourcePath, content, 'utf8');

const asset = await fileAssets.publishLocalFileAssetFromPath({
  sessionId: 'session-a',
  localPath: sourcePath,
  originalName: 'quarterly-report.txt',
  mimeType: 'text/plain',
});
const runId = 'run_file_asset_stage_test';
const turnId = 'turn_file_asset_stage_test';
const staged = await staging.stageAttachmentInputs({
  sessionId: 'session-a',
  runId,
  turnId,
  attachments: [{ assetId: asset.id, originalName: asset.originalName, mimeType: asset.mimeType }],
});

assert.equal(staged.attachments.length, 1, 'one input is staged');
assert.equal(staged.attachments[0].relativePath.startsWith('inputs/'), true, 'manifest uses a Run-relative input path');
assert.equal('inputPath' in staged.attachments[0], false, 'manifest descriptor has no absolute execution path');
assert.equal(staged.staging.scope.computed, true, 'staging scope is server-computed');
assert.equal(staged.staging.scope.inputRoot, undefined, 'staging scope does not expose a host path');
assert.equal(staged.staging.operations[0].scope.root, undefined, 'semantic operation does not expose a host path');
assert.equal(staged.staging.operations[0].requestBinding.sessionId, 'session-a');
assert.equal(staged.staging.operations[0].requestBinding.runId, runId);
assert.equal(staged.staging.operations[0].requestBinding.turnId, turnId);

const manifest = {
  sessionId: 'session-a',
  requestId: turnId,
  attachmentStaging: staged.staging,
  options: { images: staged.attachments },
};
const run = { sessionId: 'session-a' };
sidecar.verifyRunInputBinding(manifest, run, runId);
const verified = await sidecar.verifyRunInputAttachments(manifest, run, runId);
assert.equal(await readFile(verified[0].inputPath, 'utf8'), content, 'runner opens the staged file and gets the uploaded content');
assert.equal(existsSync(join(CHAT_RUNS_DIR, runId, 'inputs')), true, 'staging is inside the Run directory');

await assert.rejects(
  staging.stageAttachmentInputs({
    sessionId: 'session-b',
    runId: 'run_file_asset_cross_session',
    turnId,
    attachments: [{ assetId: asset.id }],
  }),
  (error) => error.code === 'FILE_ASSET_SESSION_MISMATCH',
  'an asset from another session is denied',
);

const pending = await fileAssets.createFileAssetUploadIntent({
  sessionId: 'session-a',
  originalName: 'pending.txt',
  mimeType: 'text/plain',
  sizeBytes: content.length,
  forceLocal: true,
});
await assert.rejects(
  staging.stageAttachmentInputs({
    sessionId: 'session-a',
    runId: 'run_file_asset_pending',
    turnId,
    attachments: [{ assetId: pending.asset.id }],
  }),
  (error) => error.code === 'FILE_ASSET_NOT_READY',
  'a non-finalized asset is denied',
);

const descriptorPath = join(CHAT_FILE_ASSETS_DIR, `${asset.id}.json`);
const descriptor = await fileAssets.getFileAsset(asset.id);
await writeFile(descriptorPath, JSON.stringify({ ...descriptor, sha256: '1'.repeat(64) }), 'utf8');
await assert.rejects(
  staging.stageAttachmentInputs({
    sessionId: 'session-a',
    runId: 'run_file_asset_bad_hash',
    turnId,
    attachments: [{ assetId: asset.id }],
  }),
  (error) => error.code === 'FILE_ASSET_HASH_MISMATCH',
  'content hash mismatch is denied',
);
await writeFile(descriptorPath, JSON.stringify(descriptor), 'utf8');

await assert.rejects(
  sidecar.verifyRunInputAttachment({
    relativePath: '../outside.txt',
    sha256: staged.attachments[0].sha256,
    sizeBytes: staged.attachments[0].sizeBytes,
  }, 0, runId),
  (error) => error.code === 'FILE_ASSET_RUN_INPUT_PATH_ESCAPE',
  'parent traversal is denied',
);
await assert.rejects(
  sidecar.verifyRunInputAttachment({
    relativePath: staged.attachments[0].relativePath,
    savedPath: '/control-plane/source.txt',
    sha256: staged.attachments[0].sha256,
    sizeBytes: staged.attachments[0].sizeBytes,
  }, 0, runId),
  (error) => error.code === 'FILE_ASSET_RUN_INPUT_SOURCE_LEAK',
  'direct source paths are denied',
);

assert.throws(
  () => sidecar.verifyRunInputBinding(manifest, { sessionId: 'session-b' }, runId),
  (error) => error.code === 'FILE_ASSET_RUN_INPUT_SCOPE_MISMATCH',
  'Run binding cannot be replayed from another session',
);
const tamperedManifest = structuredClone(manifest);
tamperedManifest.attachmentStaging.operations[0].target.assetId = 'fasset_000000000000000000000000';
assert.throws(
  () => sidecar.verifyRunInputBinding(tamperedManifest, run, runId),
  (error) => error.code === 'FILE_ASSET_RUN_INPUT_OPERATION_MISMATCH',
  'resource changes after staging are denied',
);

const leakedRootManifest = structuredClone(manifest);
leakedRootManifest.attachmentStaging.operations[0].scope.root = '/control-plane/chat-runs/run_file_asset_stage_test';
assert.throws(
  () => sidecar.verifyRunInputBinding(leakedRootManifest, run, runId),
  (error) => error.code === 'FILE_ASSET_RUN_INPUT_OPERATION_MISMATCH',
  'semantic operation host paths are denied',
);
const leakedStagingRootManifest = structuredClone(manifest);
leakedStagingRootManifest.attachmentStaging.scope.inputRoot = '/control-plane/chat-runs/run_file_asset_stage_test/inputs';
await assert.rejects(
  sidecar.verifyRunInputAttachments(leakedStagingRootManifest, run, runId),
  (error) => error.code === 'FILE_ASSET_RUN_INPUT_ROOT_MISMATCH',
  'staging binding host paths are denied',
);

const sidecarSource = await readFile(new URL('../chat/runner-sidecar.mjs', import.meta.url), 'utf8');
assert.equal(sidecarSource.includes("from './file-assets.mjs'"), false, 'runner does not import file asset storage');
assert.equal(sidecarSource.includes('buildFileAssetDirectUrl'), false, 'runner does not generate storage URLs');
assert.equal(sidecarSource.includes('materializeFileAssetAttachments'), false, 'runner does not localize assets');
assert.deepEqual(
  sidecar.stripRunnerControlEnv({
    PATH: '/usr/bin',
    RAGENT_CONFIG_DIR: '/control/config',
    RAGENT_INSTANCE_ROOT: '/control',
    RAGENT_MEMORY_DIR: '/control/memory',
    RAGENT_NATIVE_OAUTH_LOCK_PATH: '/control/provider/.ragent-native-oauth.lock',
    RAGENT_NATIVE_OAUTH_LOCK_TOKEN: 'test-oauth-lock-token',
    RAGENT_ASSET_STORAGE_SECRET_ACCESS_KEY: 'secret',
    RAGENT_FILE_ASSET_TOKEN: 'token',
  }),
  { PATH: '/usr/bin' },
  'runner environment excludes control paths and asset credentials',
);

const outsidePath = join(sourceDir, 'outside.txt');
await writeFile(outsidePath, 'outside', 'utf8');
const symlinkRunId = 'run_file_asset_symlink_test';
const symlinkRunRoot = join(CHAT_RUNS_DIR, symlinkRunId);
await mkdir(symlinkRunRoot, { recursive: true });
await symlink(sourceDir, join(symlinkRunRoot, 'inputs'), process.platform === 'win32' ? 'junction' : 'dir');
await assert.rejects(
  sidecar.verifyRunInputAttachment({
    relativePath: 'inputs/outside.txt',
    sha256: '0'.repeat(64),
    sizeBytes: 7,
  }, 0, symlinkRunId),
  (error) => error.code === 'FILE_ASSET_RUN_INPUT_ROOT_INVALID',
  'symlinked staging roots are denied',
);

await rm(home, { recursive: true, force: true });
console.log('test-file-asset-run-input-staging: ok');
