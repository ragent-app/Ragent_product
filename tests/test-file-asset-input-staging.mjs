#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testRoot = mkdtempSync(join(tmpdir(), 'ragent-file-asset-stage-'));
const home = join(testRoot, 'home');
const configDir = join(home, '.config', 'ragent');
mkdirSync(configDir, { recursive: true });
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_ASSET_STORAGE_BASE_URL = '';
process.env.RAGENT_ASSET_STORAGE_ACCESS_KEY_ID = '';
process.env.RAGENT_ASSET_STORAGE_SECRET_ACCESS_KEY = '';

const { CHAT_FILE_ASSETS_DIR, CHAT_RUNS_DIR, CHAT_IMAGES_DIR } = await import('../lib/config.mjs');
const { getFileAsset, publishLocalFileAssetFromPath } = await import('../chat/file-assets.mjs');
const { stageAttachmentInputs } = await import('../chat/file-asset-input-staging.mjs');
const { verifyRunInputAttachment } = await import('../chat/runner-sidecar.mjs');

const SESSION = 'session-stage-test';
const OTHER_SESSION = 'session-other-test';

function assetAttachment(asset) {
  return {
    assetId: asset.id,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
  };
}

async function createAsset(name, contents, sessionId = SESSION) {
  const sourcePath = join(testRoot, name);
  await writeFile(sourcePath, contents);
  return publishLocalFileAssetFromPath({
    sessionId,
    localPath: sourcePath,
    originalName: name,
    mimeType: 'text/plain',
  });
}

async function assetRecordPath(assetId) {
  return join(CHAT_FILE_ASSETS_DIR, `${assetId}.json`);
}

async function rewriteAsset(assetId, updater) {
  const filepath = await assetRecordPath(assetId);
  const current = JSON.parse(await readFile(filepath, 'utf8'));
  await writeFile(filepath, JSON.stringify(updater(current), null, 2));
}

async function rejectStage(attachments, code, runId = `run-reject-${Math.random().toString(16).slice(2)}`) {
  await assert.rejects(
    stageAttachmentInputs({ sessionId: SESSION, runId, turnId: 'turn-test', attachments }),
    (error) => error?.code === code,
  );
}

const asset = await createAsset('normal.txt', 'hello staged input\n');
const staged = await stageAttachmentInputs({
  sessionId: SESSION,
  runId: 'run-stage-normal',
  turnId: 'turn-normal',
  attachments: [assetAttachment(asset)],
});
assert.equal(staged.staging.decision, 'ALLOW');
assert.equal(staged.operations.length, 1);
assert.equal(staged.operations[0].primaryAction, 'file_asset.read');
assert.deepEqual(staged.operations[0].effects, [
  'control_plane.asset_descriptor.read',
  'control_plane.object_storage.read',
  'control_plane.run_input.write',
  'runner.current_run_input.read',
]);
assert.equal(staged.operations[0].requestBinding.sessionId, SESSION);
assert.equal(staged.operations[0].requestBinding.runId, 'run-stage-normal');
assert.equal(staged.operations[0].requestBinding.turnId, 'turn-normal');
assert.match(staged.attachments[0].relativePath, /^inputs[\\/]fasset_[a-f0-9]{24}\.txt$/);
assert.equal(staged.attachments[0].inputPath, undefined);
assert.equal(staged.attachments[0].savedPath, undefined);
assert.equal(staged.staging.scope.inputRoot, undefined, 'staging scope must not expose an absolute input root');
assert.equal(staged.operations[0].scope.root, undefined, 'semantic operation must not expose an absolute input root');
assert.equal(await readFile(join(CHAT_RUNS_DIR, 'run-stage-normal', staged.attachments[0].relativePath), 'utf8'), 'hello staged input\n');

await rejectStage([{ assetId: 'fasset_000000000000000000000000' }], 'FILE_ASSET_NOT_FOUND');
await rejectStage([assetAttachment(await createAsset('other.txt', 'other\n', OTHER_SESSION))], 'FILE_ASSET_SESSION_MISMATCH', 'run-reject-other');

const notReady = await createAsset('pending.txt', 'pending\n');
await rewriteAsset(notReady.id, (record) => ({ ...record, status: 'pending_upload' }));
await rejectStage([assetAttachment(notReady)], 'FILE_ASSET_NOT_READY', 'run-reject-ready');

const outside = join(testRoot, 'outside.txt');
await writeFile(outside, 'outside\n');
const escaped = await createAsset('escaped.txt', 'escaped\n');
await rewriteAsset(escaped.id, (record) => ({ ...record, localizedPath: outside }));
await rejectStage([assetAttachment(escaped)], 'FILE_ASSET_INPUT_PATH_ESCAPE', 'run-reject-escape');

const symlinkAsset = await createAsset('symlink.txt', 'symlink\n');
const symlinkPath = join(CHAT_IMAGES_DIR, 'asset-stage-symlink.txt');
mkdirSync(CHAT_IMAGES_DIR, { recursive: true });
// Windows junctions exercise the same real lstat reparse-point rejection
// without requiring the privilege for creating a file symbolic link.
const symlinkTarget = process.platform === 'win32' ? join(testRoot, 'outside-link-directory') : outside;
if (process.platform === 'win32') mkdirSync(symlinkTarget);
symlinkSync(symlinkTarget, symlinkPath, process.platform === 'win32' ? 'junction' : 'file');
assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true);
assert.equal(realpathSync(symlinkPath), realpathSync(symlinkTarget));
await rewriteAsset(symlinkAsset.id, (record) => ({ ...record, localizedPath: symlinkPath }));
await rejectStage([assetAttachment(symlinkAsset)], 'FILE_ASSET_INPUT_SYMLINK', 'run-reject-symlink');

const symlinkRunId = 'run-reject-symlink-run';
const symlinkRunTarget = join(CHAT_RUNS_DIR, 'run-symlink-target');
mkdirSync(join(symlinkRunTarget, 'inputs'), { recursive: true });
symlinkSync(symlinkRunTarget, join(CHAT_RUNS_DIR, symlinkRunId), process.platform === 'win32' ? 'junction' : 'dir');
assert.equal(lstatSync(join(CHAT_RUNS_DIR, symlinkRunId)).isSymbolicLink(), true);
await rejectStage([assetAttachment(asset)], 'FILE_ASSET_INPUT_RUN_ESCAPE', symlinkRunId);

const sizeMismatch = await createAsset('size-mismatch.txt', 'size\n');
const sizeObjectPath = join(CHAT_FILE_ASSETS_DIR, 'objects', sizeMismatch.storage?.localFilename || `${sizeMismatch.id}.txt`);
await writeFile(sizeObjectPath, 'changed size\n');
await rejectStage([assetAttachment(sizeMismatch)], 'FILE_ASSET_SIZE_MISMATCH', 'run-reject-size');

const hashMismatch = await createAsset('hash-mismatch.txt', 'hash\n');
const hashObjectPath = join(CHAT_FILE_ASSETS_DIR, 'objects', hashMismatch.storage?.localFilename || `${hashMismatch.id}.txt`);
await writeFile(hashObjectPath, 'nope\n');
await rejectStage([assetAttachment(hashMismatch)], 'FILE_ASSET_HASH_MISMATCH', 'run-reject-hash');

const malformedHash = await createAsset('malformed-hash.txt', 'bad hash\n');
await rewriteAsset(malformedHash.id, (record) => ({ ...record, sha256: 'not-a-digest' }));
await rejectStage([assetAttachment(malformedHash)], 'FILE_ASSET_HASH_INVALID', 'run-reject-malformed-hash');

const runnerRunId = 'run-sidecar-inputs';
const runnerInputRoot = join(CHAT_RUNS_DIR, runnerRunId, 'inputs');
await mkdir(runnerInputRoot, { recursive: true });
const runnerInputPath = join(runnerInputRoot, 'input.txt');
const runnerInput = 'runner input\n';
await writeFile(runnerInputPath, runnerInput);
const runnerHash = createHash('sha256').update(runnerInput).digest('hex');
const runnerDescriptor = {
  relativePath: 'inputs/input.txt',
  sizeBytes: Buffer.byteLength(runnerInput),
  sha256: runnerHash,
  originalName: 'input.txt',
  mimeType: 'text/plain',
};
assert.equal((await verifyRunInputAttachment(runnerDescriptor, 0, runnerRunId)).sha256, runnerHash);
await assert.rejects(
  verifyRunInputAttachment({ ...runnerDescriptor, relativePath: '../input.txt' }, 0, runnerRunId),
  (error) => error?.code === 'FILE_ASSET_RUN_INPUT_PATH_ESCAPE',
);
await assert.rejects(
  verifyRunInputAttachment({ ...runnerDescriptor, sha256: '0'.repeat(64) }, 0, runnerRunId),
  (error) => error?.code === 'FILE_ASSET_RUN_INPUT_HASH_MISMATCH',
);
await assert.rejects(
  verifyRunInputAttachment({ ...runnerDescriptor, savedPath: outside }, 0, runnerRunId),
  (error) => error?.code === 'FILE_ASSET_RUN_INPUT_SOURCE_LEAK',
);

const sidecarSource = readFileSync(new URL('../chat/runner-sidecar.mjs', import.meta.url), 'utf8');
assert.equal(sidecarSource.includes("from './file-assets.mjs'"), false);
assert.match(sidecarSource, /delete env\.RAGENT_CONFIG_DIR/);
assert.equal(existsSync(join(CHAT_RUNS_DIR, 'run-stage-normal', 'inputs')), true);

console.log('file-asset-input-staging: normal and adversarial checks passed');
