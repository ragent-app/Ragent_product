import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const ACTIVE_STATUSES = new Set(['queued', 'downloading_runtime', 'downloading_model', 'extracting', 'activating', 'starting']);
const VALID_OPERATION_ID = /^[a-f0-9-]{36}$/;
const REQUIRED_FILES = ['whisper-server.exe', 'ggml.dll', 'ggml-base.dll', 'whisper.dll'];
const RELEASE_FILES = /^Release\/(?:whisper-server\.exe|whisper\.dll|ggml\.dll|ggml-base\.dll|ggml-cpu-[A-Za-z0-9-]+\.dll)$/;

export const WHISPER_RUNTIME_ASSETS = Object.freeze({
  archive: Object.freeze({
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
    maxBytes: 128 * 1024 * 1024,
  }),
  model: Object.freeze({
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/f281eb45af861ab5e5297d23694b7d46e090c02c/ggml-base-q5_1.bin?download=true',
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
    maxBytes: 256 * 1024 * 1024,
  }),
});

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function safeOperation(operation) {
  return {
    operationId: operation.operationId,
    status: operation.status,
    ...(operation.error ? { error: operation.error } : {}),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

function installationErrorMessage(error) {
  switch (error?.code) {
    case 'VOICE_INSTALL_DOWNLOAD_FAILED': return 'Whisper could not be downloaded. Check the computer network and try again.';
    case 'VOICE_INSTALL_HASH_MISMATCH': return 'Whisper download verification failed. No files were installed.';
    case 'VOICE_INSTALL_EXTRACT_FAILED': return 'The verified Whisper package could not be unpacked.';
    case 'VOICE_INSTALL_FILES_MISSING': return 'The Whisper package is incomplete.';
    case 'VOICE_INSTALL_PATH_REFUSED': return 'The managed Whisper installation path is unavailable.';
    case 'VOICE_INSTALL_START_FAILED': return 'Whisper was installed, but its recognition service could not start.';
    case 'VOICE_INSTALL_INTERRUPTED': return 'Whisper installation stopped when Ragent restarted. Try again.';
    default: return 'Whisper installation failed. Try again or check the computer status.';
  }
}

async function downloadVerified(asset, outputPath, { fetchImpl, signal }) {
  let response;
  try {
    response = await fetchImpl(asset.url, {
      redirect: 'follow',
      signal,
      headers: { 'User-Agent': 'Ragent-Local-Voice-Installer' },
    });
  } catch {
    throw failure('VOICE_INSTALL_DOWNLOAD_FAILED');
  }
  if (!response?.ok || !response.body) throw failure('VOICE_INSTALL_DOWNLOAD_FAILED');
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > asset.maxBytes) {
    await response.body.cancel().catch(() => {});
    throw failure('VOICE_INSTALL_DOWNLOAD_FAILED');
  }

  let bytes = 0;
  const hash = createHash('sha256');
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > asset.maxBytes) return callback(failure('VOICE_INSTALL_DOWNLOAD_FAILED'));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(outputPath, { flags: 'wx' }), { signal });
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => {});
    if (error?.code?.startsWith('VOICE_INSTALL_')) throw error;
    throw failure('VOICE_INSTALL_DOWNLOAD_FAILED');
  }
  if (bytes === 0 || hash.digest('hex') !== asset.sha256) {
    await rm(outputPath, { force: true }).catch(() => {});
    throw failure('VOICE_INSTALL_HASH_MISMATCH');
  }
  return { bytes, sha256: asset.sha256 };
}

async function runTar(args, { spawnImpl = spawn, windowsRoot = process.env.SystemRoot || 'C:\\Windows', timeoutMs = 120_000 } = {}) {
  const executable = join(windowsRoot, 'System32', 'tar.exe');
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    let output = '';
    let errorOutput = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch {}
      finish(failure('VOICE_INSTALL_EXTRACT_FAILED'));
    }, timeoutMs);
    timer.unref?.();
    try {
      child = spawnImpl(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(failure('VOICE_INSTALL_EXTRACT_FAILED'));
      return;
    }
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.length > 4 * 1024 * 1024) {
        try { child.kill(); } catch {}
        finish(failure('VOICE_INSTALL_EXTRACT_FAILED'));
      }
    });
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + String(chunk)).slice(-2048); });
    child.once('error', () => finish(failure('VOICE_INSTALL_EXTRACT_FAILED')));
    child.once('close', code => code === 0
      ? finish(null, output)
      : finish(failure('VOICE_INSTALL_EXTRACT_FAILED')));
  });
}

export async function extractWhisperArchive(archivePath, destination, options = {}) {
  const listing = await runTar(['-tf', archivePath], options);
  const members = listing.split(/\r?\n/).filter(name => RELEASE_FILES.test(name));
  const names = new Set(members.map(name => basename(name)));
  if (REQUIRED_FILES.some(name => !names.has(name)) || members.length > 256 || new Set(members).size !== members.length) {
    throw failure('VOICE_INSTALL_FILES_MISSING');
  }
  await runTar(['-xf', archivePath, '-C', destination, ...members], options);
  for (const member of members) {
    const source = resolve(destination, ...member.split('/'));
    const root = resolve(destination);
    if (!source.startsWith(`${root}\\`) && !source.startsWith(`${root}/`)) throw failure('VOICE_INSTALL_EXTRACT_FAILED');
    const target = join(destination, basename(member));
    const sourceStat = await stat(source).catch(() => null);
    if (!sourceStat?.isFile() || sourceStat.size <= 0 || sourceStat.size > MAX_DOWNLOAD_BYTES) throw failure('VOICE_INSTALL_FILES_MISSING');
    await rename(source, target);
  }
  await rm(join(destination, 'Release'), { recursive: true, force: true });
}

async function readOperationFile(directory, operationId) {
  if (!VALID_OPERATION_ID.test(operationId || '')) return null;
  try {
    const value = JSON.parse(await readFile(join(directory, `${operationId}.json`), 'utf8'));
    return value?.operationId === operationId && typeof value.status === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function createLocalVoiceInstaller({
  runtimeDirectory,
  operationDirectory = join(dirname(runtimeDirectory || '.'), 'voice-install-operations'),
  assets = WHISPER_RUNTIME_ASSETS,
  fetchImpl = globalThis.fetch,
  downloadImpl = downloadVerified,
  extractArchiveImpl = extractWhisperArchive,
  activate = async () => {},
  now = () => new Date(),
  makeId = randomUUID,
  copyFileImpl = copyFile,
} = {}) {
  if (!runtimeDirectory || typeof runtimeDirectory !== 'string' || typeof fetchImpl !== 'function'
      || typeof downloadImpl !== 'function' || typeof extractArchiveImpl !== 'function'
      || typeof activate !== 'function' || typeof makeId !== 'function') {
    throw failure('VOICE_INSTALL_CONFIG_INVALID');
  }
  runtimeDirectory = resolve(runtimeDirectory);
  operationDirectory = resolve(operationDirectory);
  const runtimeParent = dirname(runtimeDirectory);
  let initialized;
  let activeOperation = null;

  async function persist(operation) {
    await mkdir(operationDirectory, { recursive: true });
    const target = join(operationDirectory, `${operation.operationId}.json`);
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(operation, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, target);
  }

  async function initialize() {
    if (initialized) return initialized;
    initialized = (async () => {
      await mkdir(operationDirectory, { recursive: true });
      const entries = await readdir(operationDirectory, { withFileTypes: true }).catch(() => []);
      const files = entries.filter(entry => entry.isFile() && VALID_OPERATION_ID.test(entry.name.replace(/\.json$/, '')))
        .map(entry => entry.name).filter(name => name.endsWith('.json'));
      const operations = [];
      for (const name of files) {
        const operation = await readOperationFile(operationDirectory, name.slice(0, -5));
        if (!operation) continue;
        if (ACTIVE_STATUSES.has(operation.status)) {
          operation.status = 'failed';
          operation.error = installationErrorMessage(failure('VOICE_INSTALL_INTERRUPTED'));
          operation.updatedAt = now().toISOString();
          await persist(operation);
        }
        operations.push(operation);
      }
      operations.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      for (const old of operations.slice(20)) await rm(join(operationDirectory, `${old.operationId}.json`), { force: true }).catch(() => {});
    })();
    return initialized;
  }

  async function update(operation, status, error = '') {
    operation.status = status;
    operation.error = error;
    operation.updatedAt = now().toISOString();
    await persist(operation);
  }

  async function execute(operation, activateOperation) {
    const controller = new AbortController();
    let temporaryRoot = '';
    const downloadRoot = () => join(temporaryRoot, 'downloads');
    const stageRoot = () => join(temporaryRoot, 'runtime');
    let backupPath = '';
    let runtimeActivated = false;
    try {
      await mkdir(runtimeParent, { recursive: true });
      temporaryRoot = await mkdtemp(join(runtimeParent, '.whisper-install-'));
      await mkdir(downloadRoot(), { recursive: true });
      await mkdir(stageRoot(), { recursive: true });
      await update(operation, 'downloading_runtime');
      const archivePath = join(downloadRoot(), 'whisper-runtime.zip');
      await downloadImpl(assets.archive, archivePath, { fetchImpl, signal: controller.signal });
      await update(operation, 'downloading_model');
      const modelPath = join(downloadRoot(), 'ggml-base-q5_1.bin');
      await downloadImpl(assets.model, modelPath, { fetchImpl, signal: controller.signal });
      await update(operation, 'extracting');
      await extractArchiveImpl(archivePath, stageRoot());
      await rename(modelPath, join(stageRoot(), 'ggml-base-q5_1.bin'));

      const licenseRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../packaging/windows/licenses');
      for (const license of ['whisper.cpp-MIT.txt', 'OpenAI-Whisper-MIT.txt']) {
        await copyFileImpl(join(licenseRoot, license), join(stageRoot(), license));
      }
      const runtimeFiles = [];
      for (const name of [...REQUIRED_FILES, 'ggml-base-q5_1.bin', 'whisper.cpp-MIT.txt', 'OpenAI-Whisper-MIT.txt']) {
        const filePath = join(stageRoot(), name);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat?.isFile() || fileStat.size <= 0 || fileStat.size > MAX_DOWNLOAD_BYTES) throw failure('VOICE_INSTALL_FILES_MISSING');
        const bytes = await readFile(filePath);
        runtimeFiles.push({ name, size: fileStat.size, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      const manifest = {
        schemaVersion: 1,
        whisperCppRelease: 'b5454 (v1.9.5)',
        modelRepository: 'ggerganov/whisper.cpp',
        modelRevision: 'f281eb45af861ab5e5297d23694b7d46e090c02c',
        files: runtimeFiles,
      };
      await writeFile(join(stageRoot(), 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });

      await update(operation, 'activating');
      const existing = await lstat(runtimeDirectory).catch(() => null);
      if (existing) {
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw failure('VOICE_INSTALL_PATH_REFUSED');
        backupPath = `${runtimeDirectory}.previous-${operation.operationId}`;
        await rename(runtimeDirectory, backupPath);
      }
      await rename(stageRoot(), runtimeDirectory);
      runtimeActivated = true;
      await update(operation, 'starting');
      await activate({
        executable: join(runtimeDirectory, 'whisper-server.exe'),
        model: join(runtimeDirectory, 'ggml-base-q5_1.bin'),
      });
      if (backupPath) await rm(backupPath, { recursive: true, force: true });
      await update(operation, 'succeeded');
    } catch (error) {
      if (runtimeActivated) await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => {});
      if (backupPath) await rename(backupPath, runtimeDirectory).catch(() => {});
      try { await update(operation, 'failed', installationErrorMessage(error)); }
      catch {
        operation.status = 'failed';
        operation.error = installationErrorMessage(error);
        operation.updatedAt = now().toISOString();
      }
    } finally {
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
      activeOperation = null;
    }
  }

  return Object.freeze({
    async initialize() {
      await initialize();
    },
    isInstalling() {
      return Boolean(activeOperation && ACTIVE_STATUSES.has(activeOperation.status));
    },
    async start(activateOperation = activate) {
      await initialize();
      if (activeOperation && ACTIVE_STATUSES.has(activeOperation.status)) return safeOperation(activeOperation);
      if (typeof activateOperation !== 'function') throw failure('VOICE_INSTALL_CONFIG_INVALID');
      const timestamp = now().toISOString();
      const operation = {
        operationId: makeId(),
        status: 'queued',
        error: '',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (!VALID_OPERATION_ID.test(operation.operationId)) throw failure('VOICE_INSTALL_CONFIG_INVALID');
      activeOperation = operation;
      try { await persist(operation); }
      catch (error) { activeOperation = null; throw error; }
      void execute(operation, activateOperation).catch(() => {});
      return safeOperation(operation);
    },
    async getStatus(operationId) {
      await initialize();
      if (!VALID_OPERATION_ID.test(operationId || '')) return null;
      if (activeOperation?.operationId === operationId) return safeOperation(activeOperation);
      const operation = await readOperationFile(operationDirectory, operationId);
      return operation ? safeOperation(operation) : null;
    },
  });
}
