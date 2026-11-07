import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalVoiceInstaller } from './local-voice-installation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const archiveBytes = Buffer.from('runtime-archive-fixture');
const modelBytes = Buffer.from('model-fixture');

async function createFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ragent-local-voice-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDirectory = join(root, 'config', 'voice-runtime');
  const operationDirectory = join(root, 'config', 'voice-install-operations');
  const assets = {
    archive: { url: 'https://fixture.invalid/runtime.zip', sha256: hash(archiveBytes), maxBytes: 1024 },
    model: { url: 'https://fixture.invalid/model.bin', sha256: hash(modelBytes), maxBytes: 1024 },
  };
  const installer = createLocalVoiceInstaller({
    runtimeDirectory,
    operationDirectory,
    assets,
    fetchImpl: async url => new Response(url === assets.archive.url ? archiveBytes : modelBytes),
    extractArchiveImpl: async (_archive, destination) => {
      await Promise.all(['whisper-server.exe', 'ggml.dll', 'ggml-base.dll', 'whisper.dll'].map(name =>
        writeFile(join(destination, name), Buffer.from(`fixture-${name}`))));
    },
    activate: options.activate,
    makeId: () => '1d881f5b-39f5-4a5f-a714-6d92e3e35f21',
  });
  return { root, runtimeDirectory, operationDirectory, assets, installer };
}

async function waitForStatus(installer, operationId, expected, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = await installer.getStatus(operationId);
    if (operation?.status === expected) return operation;
    if (operation?.status === 'failed' && expected !== 'failed') throw new Error(operation.error);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

test('installs only verified runtime/model files and persists a successful operation', async t => {
  let activated = null;
  const fixture = await createFixture(t, { activate: async paths => { activated = paths; } });
  const operation = await fixture.installer.start();
  assert.equal(operation.status, 'queued');
  const completed = await waitForStatus(fixture.installer, operation.operationId, 'succeeded');
  assert.equal(completed.status, 'succeeded');
  assert.equal(activated.executable, join(fixture.runtimeDirectory, 'whisper-server.exe'));
  assert.equal(activated.model, join(fixture.runtimeDirectory, 'ggml-base-q5_1.bin'));
  assert.equal((await readFile(join(fixture.runtimeDirectory, 'ggml-base-q5_1.bin'))).toString(), 'model-fixture');
  assert.equal((await readFile(join(fixture.runtimeDirectory, 'OpenAI-Whisper-MIT.txt'), 'utf8')).startsWith('MIT License'), true);
  const manifest = JSON.parse(await readFile(join(fixture.runtimeDirectory, 'runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.files.some(file => file.name === 'ggml-base-q5_1.bin' && file.sha256 === hash(modelBytes)), true);
  assert.equal((await fixture.installer.getStatus(operation.operationId)).status, 'succeeded');
});

test('rejects a corrupt download and does not activate or leave a runtime', async t => {
  let activated = false;
  const fixture = await createFixture(t, { activate: async () => { activated = true; } });
  fixture.installer = createLocalVoiceInstaller({
    runtimeDirectory: fixture.runtimeDirectory,
    operationDirectory: fixture.operationDirectory,
    assets: { ...fixture.assets, archive: { ...fixture.assets.archive, sha256: '0'.repeat(64) } },
    fetchImpl: async () => new Response(archiveBytes),
    extractArchiveImpl: async () => assert.fail('corrupt archive must not be extracted'),
    activate: async () => { activated = true; },
    makeId: () => '704dbbaa-0f4d-4ce5-8b40-43e4e43f4578',
  });
  const operation = await fixture.installer.start();
  const failed = await waitForStatus(fixture.installer, operation.operationId, 'failed');
  assert.match(failed.error, /verification failed/i);
  assert.equal(activated, false);
  await assert.rejects(readFile(join(fixture.runtimeDirectory, 'whisper-server.exe')));
});

test('rolls back the prior runtime if activation cannot start Whisper', async t => {
  const fixture = await createFixture(t);
  await mkdir(fixture.runtimeDirectory, { recursive: true });
  await writeFile(join(fixture.runtimeDirectory, 'previous-install.txt'), 'keep me');
  fixture.installer = createLocalVoiceInstaller({
    runtimeDirectory: fixture.runtimeDirectory,
    operationDirectory: fixture.operationDirectory,
    assets: fixture.assets,
    fetchImpl: async url => new Response(url === fixture.assets.archive.url ? archiveBytes : modelBytes),
    extractArchiveImpl: async (_archive, destination) => {
      await Promise.all(['whisper-server.exe', 'ggml.dll', 'ggml-base.dll', 'whisper.dll'].map(name =>
        writeFile(join(destination, name), Buffer.from(`fixture-${name}`))));
    },
    activate: async () => { throw Object.assign(new Error('not ready'), { code: 'VOICE_INSTALL_START_FAILED' }); },
    makeId: () => '8ac01fc5-08ce-4c4a-864d-31626484ac51',
  });
  const operation = await fixture.installer.start();
  const failed = await waitForStatus(fixture.installer, operation.operationId, 'failed');
  assert.match(failed.error, /could not start/i);
  assert.equal((await readFile(join(fixture.runtimeDirectory, 'previous-install.txt'), 'utf8')), 'keep me');
});

test('coalesces repeated install requests into the current operation', async t => {
  const fixture = await createFixture(t);
  let releaseDownload;
  let downloadEntered;
  const entered = new Promise(resolve => { downloadEntered = resolve; });
  const release = new Promise(resolve => { releaseDownload = resolve; });
  fixture.installer = createLocalVoiceInstaller({
    runtimeDirectory: fixture.runtimeDirectory,
    operationDirectory: fixture.operationDirectory,
    assets: fixture.assets,
    downloadImpl: async (asset, destination) => {
      downloadEntered();
      await release;
      await writeFile(destination, asset.url === fixture.assets.archive.url ? archiveBytes : modelBytes);
    },
    extractArchiveImpl: async (_archive, destination) => {
      await Promise.all(['whisper-server.exe', 'ggml.dll', 'ggml-base.dll', 'whisper.dll'].map(name =>
        writeFile(join(destination, name), Buffer.from(`fixture-${name}`))));
    },
    activate: async () => {},
    makeId: () => 'd1b1a6b9-54ef-4784-8cb5-ef0fe011f9e7',
  });
  const first = await fixture.installer.start();
  await entered;
  const second = await fixture.installer.start();
  assert.equal(second.operationId, first.operationId);
  releaseDownload();
  await waitForStatus(fixture.installer, first.operationId, 'succeeded');
});

test('marks an interrupted persisted operation failed after service restart', async t => {
  const fixture = await createFixture(t);
  const operationId = '9e22fd02-7a83-448c-8c80-39d00644faae';
  await mkdir(fixture.operationDirectory, { recursive: true });
  await writeFile(join(fixture.operationDirectory, `${operationId}.json`), JSON.stringify({
    operationId,
    status: 'downloading_model',
    error: '',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
  const restartedInstaller = createLocalVoiceInstaller({
    runtimeDirectory: fixture.runtimeDirectory,
    operationDirectory: fixture.operationDirectory,
    assets: fixture.assets,
  });
  await restartedInstaller.initialize();
  const status = await restartedInstaller.getStatus(operationId);
  assert.equal(status.status, 'failed');
  assert.match(status.error, /stopped when Ragent restarted/i);
});
